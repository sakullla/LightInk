/**
 * `assistant-panel` — 阅读器 AI 助手对话界面（R1–R6）。
 *
 * 复用面板框架：桌面钉阅读区右侧（mountReaderOverlay + pinFixedOverlay），
 * 触屏是底部 sheet（is-touch-sheet + revealSheet/concealSheet 过渡）。互斥、
 * Escape 链与关闭清理挂点由 reader-chrome-wiring 接入（面板只管自身显隐）。
 *
 * - 对话：`ai_chat_stream` 经 Tauri IPC `Channel` 增量推送 delta；请求按
 *   ① 内置工具 ② 系统提示 ③ 当前章 ④ 近期对话 ⑤ 本轮 组装（assistant-request）。
 *   模型要求调用工具时在面板内执行（assistant-tools）并回传，循环至回答完成
 *   或达到 24 轮上限；每次调用显示为工具块。
 * - 历史：按书（与标注同源的内容哈希）多段会话存本机（assistant-history）；
 *   可新建/切换/删除；重开恢复上次活动段；身份不可用时仅内存。
 * - 回复：Markdown 渲染（assistant-markdown，消毒后显示）；定位链接点击后
 *   由宿主跳转；用户消息保持纯文本。
 * - 输入区：多行、随内容增高、引用当前选区、生成中可停止（已生成文字保留）。
 * - 跟随：新内容到达时未上滑则自动滚到底；上滑后停止跟随并提供回到底部。
 * - 失败：消息级错误 + 原地重试；未配置 AI 时显示前往配置引导。
 * - 编辑器界面无任何 AI 入口：本组件只被阅读器装配（R8）。
 */

import './assistant-panel.css';

import type { MessageKey } from '../i18n/messages.js';
import {
  adoptReaderOverlayTheme,
  mountReaderOverlay,
  pinFixedOverlay,
  unpinFixedOverlay,
} from './reader-chrome-panels.js';
import { concealSheet, revealSheet } from '../ui/touch/sheet-transition.js';
import {
  invokeAiTranslateConfig,
  readerAiErrorMessage,
  READER_AI_CONFIGURED_EVENT,
  type AiTranslateConfig,
} from './lookup-panel.js';
import { READER_LIMITS } from './reader-limits.js';
import { readerChromeTouchMode } from './view/reader-dom.js';
import {
  assistantSessionOversized,
  assistantSessionTitle,
  createAssistantSession,
  findAssistantSession,
  capAssistantMessages,
  fitAssistantHistory,
  trimAssistantSessionToFit,
  parseAssistantHistory,
  removeAssistantSession,
  sortAssistantSessions,
  upsertAssistantSession,
  EMPTY_ASSISTANT_HISTORY,
  type AssistantHistoryFile,
  type AssistantMessage,
  type AssistantQuickAction,
  type AssistantSession,
  type AssistantToolCall,
  type AssistantToolResult,
} from './assistant-history.js';
import {
  abortAssistantChat,
  assistantContextBlock,
  buildAssistantRequest,
  clipAssistantContext,
  newAssistantRequestId,
  streamAssistantChat,
  type AiToolDefView,
  type AssistantChapterContext,
  type AssistantStreamDeps,
} from './assistant-request.js';
import {
  ASSISTANT_MAX_TOOL_CALLS_PER_TURN,
  ASSISTANT_MAX_TOOL_ROUNDS,
  ASSISTANT_TOOL_QUERY,
  ASSISTANT_TOOL_SAVE,
  ASSISTANT_TOOLS,
  createAssistantToolBudget,
  describeAssistantToolCall,
  executeAssistantTool,
  type AssistantBookAccess,
  type AssistantLocateTarget,
} from './assistant-tools.js';
import { renderAssistantMarkdown } from './assistant-markdown.js';

export type {
  AssistantChapterContext,
  AssistantStreamDeps,
  AssistantInvoke,
} from './assistant-request.js';
export type { AssistantQuickAction } from './assistant-history.js';

/** 面板内动作区按钮（以当前章为上下文）。 */
export const ASSISTANT_PANEL_ACTIONS: readonly AssistantQuickAction[] = [
  'chapterSummary',
  'vocabulary',
  'quiz',
];

/** 工具块里结果预览的字符上限。 */
const TOOL_RESULT_PREVIEW_CHARS = 2000;
/** 跟随判定：距底部小于该像素视为在底部。 */
const FOLLOW_THRESHOLD_PX = 24;

/** 快捷动作发起的用户消息内容（同时是历史存储与气泡展示）。 */
export function assistantActionContent(
  action: AssistantQuickAction,
  instruction: string,
  quote?: string,
): string {
  if (action === 'explain' || action === 'summarize') {
    const clipped = clipAssistantContext(quote ?? '');
    return `${instruction}\n<selection>\n${clipped.text}\n</selection>`;
  }
  return instruction;
}

/** 引用当前选区时插入输入框的文本块（计入用户消息，不改章节前缀）。 */
export function assistantSelectionQuote(selection: string): string {
  const clipped = clipAssistantContext(selection);
  return `<selection>\n${clipped.text}\n</selection>\n`;
}

// ── 面板组件 ─────────────────────────────────────────────────────────

export interface AssistantPanelDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 阅读根（主题采纳与 portal 宿主）。 */
  host: () => HTMLElement;
  /** 当前章节上下文（③）；无文本层格式返回 null。 */
  chapterContext: () => AssistantChapterContext | null;
  /** 未配置引导「前往配置」（宿主：回书架并打开 Manage 的 AI 分组）。 */
  openSettings: () => void;
  /** 本章摘要保存为标注（章节级锚点由宿主实现）。 */
  /** 流式重绘合并间隔（毫秒）；测试注入 0。 */
  readonly streamRenderIntervalMs?: number;
  /** 摘要保存为标注；回传 false 表示没落盘（面板恢复按钮并提示）。 */
  saveAnnotation: (text: string, source?: AssistantSaveSource) => void | boolean | Promise<boolean>;
  /** 内置工具的宿主供数（查询 / 保存 / 选区）。 */
  access: AssistantBookAccess;
  /** 用户点击回答中的定位链接后跳转。 */
  locate?: (target: AssistantLocateTarget) => void;
  /** 回答中外部链接的打开策略（缺省不打开）。 */
  openLink?: (href: string) => void;
  /** 配置读取（缺省走 `ai_get_config` 投影）。 */
  fetchConfig?: () => Promise<AiTranslateConfig>;
  /** 按书历史读取（缺省不可用 → 仅内存）。 */
  readHistory?: (contentHash: string) => Promise<string>;
  /** 按书历史写入（拒绝写入时 reject，面板提示）。 */
  writeHistory?: (contentHash: string, json: string) => Promise<void>;
  /** 清除本书全部历史（Rust `assistant_clear_history`，幂等）。 */
  clearHistory?: (contentHash: string) => Promise<void>;
  /** 当前书的存储键（与标注身份同源）；null = 不持久化。 */
  historyKey?: () => string | null;
  /** 流式通道注入（测试）。 */
  stream?: AssistantStreamDeps;
  /** 工具清单（缺省内置两项；测试可注入）。 */
  tools?: readonly AiToolDefView[];
}

/** 流式重绘合并间隔（毫秒）。 */
const STREAM_RENDER_INTERVAL_MS = 40;
/**
 * 只有这些结束原因算正常收尾。length / max_tokens / incomplete 是长度截断；`closed`
 * 是流没有终态就断了（网关 / 网络中途关闭）；其它没见过的一律按不完整处理。
 */
const NORMAL_FINISHES: ReadonlySet<string> = new Set([
  'stop',
  'end_turn',
  'stop_sequence',
  'tool_calls',
  'tool_use',
  'function_call',
  'done',
]);

/** 摘要保存为标注时的锚点来源（发起摘要时的章 / 页）。 */
export interface AssistantSaveSource {
  readonly chapter?: number;
  readonly page?: number;
}

export interface AssistantPanel {
  readonly element: HTMLElement;
  /** 显示并确保本书历史就位（挂载/钉位/进场过渡由面板自理）。 */
  open(): void;
  close(): void;
  isVisible(): boolean;
  /** 宿主侧上下文变化（如 PDF 页文本迟到）：重新评估章节动作是否可用。 */
  refreshContext(): void;
  /** 书籍身份（历史键）就绪：把身份到来前开始的内存会话并入磁盘历史并落盘。 */
  syncIdentity(): void;
  /** 选区快捷动作入口（工具栏「解释/总结」）：打开面板并发起。 */
  askWithSelection(action: 'explain' | 'summarize', quote: string): void;
  destroy(): void;
}

function assistantActionLabelKey(action: AssistantQuickAction): MessageKey {
  switch (action) {
    case 'explain':
      return 'reader.assistant.action.explain';
    case 'summarize':
      return 'reader.assistant.action.summarize';
    case 'chapterSummary':
      return 'reader.assistant.action.chapterSummary';
    case 'vocabulary':
      return 'reader.assistant.action.vocabulary';
    case 'quiz':
      return 'reader.assistant.action.quiz';
  }
}

function assistantPromptKey(action: AssistantQuickAction): MessageKey {
  switch (action) {
    case 'explain':
      return 'reader.assistant.prompt.explain';
    case 'summarize':
      return 'reader.assistant.prompt.summarize';
    case 'chapterSummary':
      return 'reader.assistant.prompt.chapterSummary';
    case 'vocabulary':
      return 'reader.assistant.prompt.vocabulary';
    case 'quiz':
      return 'reader.assistant.prompt.quiz';
  }
}

function formatSessionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function makeButton(className: string, label: string, title?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.setAttribute('title', title ?? label);
  button.setAttribute('aria-label', title ?? label);
  return button;
}

/**
 * 创建 AI 助手面板。element 由面板自理挂载（open 时 portal 到 body 并按
 * 桌面右栏 / 触屏底栏钉位）；显隐互斥与 Escape 链在 reader-chrome-wiring。
 */
export function createAssistantPanel(deps: AssistantPanelDeps): AssistantPanel {
  const t = deps.t;
  const streamDeps = deps.stream ?? {};
  const tools = deps.tools ?? ASSISTANT_TOOLS;
  const disposed = { value: false };

  const root = document.createElement('aside');
  root.className = 'lightink-reader-assistant-panel';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', t('reader.assistant.title'));
  root.hidden = true;

  // —— 头部：标题 / 历史 / 新对话 / 关闭 ——
  const head = document.createElement('div');
  head.className = 'lightink-reader-assistant-head';
  const title = document.createElement('span');
  title.className = 'lightink-reader-assistant-title';
  title.textContent = t('reader.assistant.title');
  const historyButton = makeButton(
    'lightink-reader-assistant-head-button lightink-reader-assistant-history',
    t('reader.assistant.history'),
  );
  historyButton.setAttribute('aria-expanded', 'false');
  const newSessionButton = makeButton(
    'lightink-reader-assistant-head-button lightink-reader-assistant-new',
    t('reader.assistant.newSession'),
  );
  const close = makeButton(
    'lightink-reader-assistant-close lightink-reader-sidebar-close',
    '×',
    t('annotation.closeSidebar'),
  );
  head.append(title, historyButton, newSessionButton, close);

  // —— 未配置引导（引导而非空聊天框） ——
  const guide = document.createElement('div');
  guide.className = 'lightink-reader-assistant-guide';
  const guideHint = document.createElement('p');
  guideHint.className = 'lightink-reader-assistant-guide-hint';
  guideHint.textContent = t('reader.assistant.unconfiguredHint');
  const settingsButton = document.createElement('button');
  settingsButton.type = 'button';
  settingsButton.className = 'lightink-reader-assistant-settings';
  settingsButton.textContent = t('reader.assistant.openSettings');
  guide.append(guideHint, settingsButton);

  // —— 对话主体 ——
  const main = document.createElement('div');
  main.className = 'lightink-reader-assistant-main';

  const sessionsHost = document.createElement('div');
  sessionsHost.className = 'lightink-reader-assistant-sessions';
  sessionsHost.hidden = true;
  sessionsHost.setAttribute('role', 'list');
  sessionsHost.setAttribute('aria-label', t('reader.assistant.sessions.title'));

  const contextStrip = document.createElement('div');
  contextStrip.className = 'lightink-reader-assistant-context';
  const contextTitle = document.createElement('span');
  contextTitle.className = 'lightink-reader-assistant-context-title';
  const contextTruncatedBadge = document.createElement('span');
  contextTruncatedBadge.className = 'lightink-reader-assistant-context-badge is-truncated';
  contextTruncatedBadge.textContent = t('reader.assistant.context.truncated');
  contextTruncatedBadge.hidden = true;
  const contextSelectionBadge = document.createElement('span');
  contextSelectionBadge.className = 'lightink-reader-assistant-context-badge is-selection';
  contextSelectionBadge.textContent = t('reader.assistant.context.selection');
  contextSelectionBadge.hidden = true;
  contextStrip.append(contextTitle, contextTruncatedBadge, contextSelectionBadge);

  const messagesHost = document.createElement('div');
  messagesHost.className = 'lightink-reader-assistant-messages';
  messagesHost.setAttribute('aria-label', t('reader.assistant.title'));

  const backToBottom = makeButton(
    'lightink-reader-assistant-bottom',
    t('reader.assistant.backToBottom'),
  );
  backToBottom.hidden = true;

  const noticeBar = document.createElement('p');
  noticeBar.className = 'lightink-reader-assistant-bar';
  noticeBar.setAttribute('role', 'status');
  noticeBar.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'lightink-reader-assistant-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', t('reader.assistant.actions'));
  const actionButtons = new Map<AssistantQuickAction, HTMLButtonElement>();
  for (const action of ASSISTANT_PANEL_ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-assistant-action';
    button.dataset.assistantAction = action;
    button.textContent = t(assistantActionLabelKey(action));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      runQuickAction(action);
    });
    actions.appendChild(button);
    actionButtons.set(action, button);
  }

  const composer = document.createElement('form');
  composer.className = 'lightink-reader-assistant-composer';
  const input = document.createElement('textarea');
  input.className = 'lightink-reader-assistant-input';
  input.rows = 3;
  input.setAttribute('placeholder', t('reader.assistant.placeholder'));
  input.setAttribute('aria-label', t('reader.assistant.placeholder'));
  const composerRow = document.createElement('div');
  composerRow.className = 'lightink-reader-assistant-composer-row';
  const quoteButton = makeButton(
    'lightink-reader-assistant-quote',
    t('reader.assistant.quoteSelection'),
  );
  const hint = document.createElement('span');
  hint.className = 'lightink-reader-assistant-hint';
  hint.textContent = t('reader.assistant.inputHint');
  const stop = makeButton('lightink-reader-assistant-stop', t('reader.assistant.stop'));
  stop.hidden = true;
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'lightink-reader-assistant-send';
  send.textContent = t('reader.assistant.send');
  composerRow.append(quoteButton, hint, stop, send);
  composer.append(input, composerRow);
  main.append(sessionsHost, contextStrip, messagesHost, backToBottom, noticeBar, actions, composer);
  root.append(head, guide, main);

  root.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation();
    },
    { passive: true, capture: true },
  );
  root.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  root.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  // —— 状态 ——
  let file: AssistantHistoryFile = EMPTY_ASSISTANT_HISTORY;
  let session: AssistantSession | null = null;
  let messages: AssistantMessage[] = [];
  let streaming = false;
  let loadedKey: string | null = null;
  /** 代数：换书 / 清除 / 停止时递增，作废仍在飞行的流式回调（delta/终态/持久化）。 */
  let generation = 0;
  let currentRequestId: string | null = null;
  let aiConfigured = false;
  /** 配置态首次拿到前，选区快捷动作要等它（否则 runQuickAction 会静默丢弃）。 */
  let configLoad: Promise<void> = Promise.resolve();
  /** 面板可见态（关闭动画期间 root.hidden 仍为 false，不能拿它当可见判据）。 */
  let panelVisible = false;
  /** 打开面板时的焦点元素，关闭后交还。 */
  let focusReturn: HTMLElement | null = null;
  let aiMissing: readonly string[] = [];
  /** 已保存为标注的助手消息（createdAt 键控；防重复保存按钮）。 */
  /** 流式期间直接更新的正文容器（渐进显示不经全量重绘）。 */
  let streamingBody: HTMLElement | null = null;
  let streamingIndex = -1;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** 跟随输出：用户上滑后关闭，回到底部后恢复。 */
  let followOutput = true;
  /** 输入区当前含引用选区块（上下文提示）。 */
  let quotedSelection = false;
  let sessionsOpen = false;

  const chapterContextOrNull = (): AssistantChapterContext | null => {
    try {
      return deps.chapterContext();
    } catch {
      return null;
    }
  };

  const selectionOrEmpty = (): string => {
    try {
      return deps.access.selection().trim();
    } catch {
      return '';
    }
  };

  // —— 滚动跟随 ——
  const isAtBottom = (): boolean =>
    messagesHost.scrollHeight - messagesHost.scrollTop - messagesHost.clientHeight <=
    FOLLOW_THRESHOLD_PX;

  const scrollMessagesBottom = (force = false): void => {
    if (!force && !followOutput) {
      backToBottom.hidden = false;
      return;
    }
    messagesHost.scrollTop = messagesHost.scrollHeight;
    followOutput = true;
    backToBottom.hidden = true;
  };

  messagesHost.addEventListener('scroll', () => {
    const atBottom = isAtBottom();
    followOutput = atBottom;
    backToBottom.hidden = atBottom;
  });
  backToBottom.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    scrollMessagesBottom(true);
  });

  // —— 提示条 ——
  /** 当前提示的类别：历史写入成功只收回自己那条「写入失败」，不抹掉别的提示。 */
  let noticeKey: string | null = null;
  const showNotice = (text: string, key = 'generic'): void => {
    noticeBar.textContent = text;
    noticeBar.hidden = false;
    noticeKey = key;
  };
  const hideNotice = (): void => {
    noticeBar.hidden = true;
    noticeBar.textContent = '';
    noticeKey = null;
  };

  // —— 上下文提示 ——
  const renderContextStrip = (): void => {
    const chapter = chapterContextOrNull();
    if (chapter === null || chapter.text.trim() === '') {
      contextTitle.textContent = t('reader.assistant.context.none');
      contextTitle.title = '';
      contextTruncatedBadge.hidden = true;
    } else {
      const label = chapter.title.trim();
      contextTitle.textContent = label === '' ? t('reader.assistant.title') : label;
      contextTitle.title = contextTitle.textContent;
      contextTruncatedBadge.hidden = !clipAssistantContext(chapter.text).truncated;
    }
    contextSelectionBadge.hidden = !quotedSelection;
  };

  // —— 会话列表 ——
  const renderSessions = (): void => {
    sessionsHost.replaceChildren();
    const heading = document.createElement('p');
    heading.className = 'lightink-reader-assistant-sessions-title';
    heading.textContent = t('reader.assistant.sessions.title');
    sessionsHost.appendChild(heading);
    const listed = file.sessions.filter(
      (item) => item.messages.length > 0 || item.id === session?.id,
    );
    if (session !== null && !listed.some((item) => item.id === session!.id)) {
      listed.push(session);
    }
    const sorted = sortAssistantSessions(listed);
    if (sorted.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'lightink-reader-assistant-sessions-empty';
      empty.textContent = t('reader.assistant.sessions.empty');
      sessionsHost.appendChild(empty);
    }
    for (const item of sorted) {
      const row = document.createElement('div');
      row.className = 'lightink-reader-assistant-session';
      row.dataset.sessionId = item.id;
      row.setAttribute('role', 'listitem');
      const active = item.id === session?.id;
      row.classList.toggle('is-active', active);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lightink-reader-assistant-session-open';
      const label = assistantSessionTitle(item, t('reader.assistant.session.untitled'));
      open.textContent = label;
      open.title = label;
      open.disabled = streaming;
      open.setAttribute('aria-current', active ? 'true' : 'false');
      open.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        switchSession(item.id);
      });
      const time = document.createElement('span');
      time.className = 'lightink-reader-assistant-session-time';
      time.textContent = active ? t('reader.assistant.session.current') : formatSessionTime(item.updatedAt);
      const remove = makeButton(
        'lightink-reader-assistant-session-delete',
        t('reader.assistant.session.delete'),
      );
      remove.disabled = streaming;
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteSession(item.id);
      });
      row.append(open, time, remove);
      sessionsHost.appendChild(row);
    }
    const clearAll = makeButton(
      'lightink-reader-assistant-clear',
      t('reader.assistant.clearHistory'),
    );
    clearAll.disabled = streaming;
    clearAll.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearAllHistory();
    });
    sessionsHost.appendChild(clearAll);
  };

  const setSessionsOpen = (open: boolean): void => {
    sessionsOpen = open;
    sessionsHost.hidden = !open;
    historyButton.classList.toggle('is-open', open);
    historyButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderSessions();
    }
  };

  // —— 消息渲染 ——
  /** 助手消息已终结（停止或出错）：不再流式、不再等工具结果、不可保存。 */
  const isSettled = (message: AssistantMessage): boolean =>
    message.stopped === true || message.truncated === true || message.error !== undefined;

  /** 该助手消息所属交换的发起消息（用户轮）。 */
  const exchangeUserAt = (index: number): AssistantMessage | null => {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = messages[cursor]!;
      if (previous.role === 'user') {
        return previous;
      }
    }
    return null;
  };

  /** 摘要保存为标注的锚点：发起摘要时记下的章 / 页；没记（旧历史）则由宿主用当前位置。 */
  const sourceOfExchange = (index: number): AssistantSaveSource | undefined => {
    const user = exchangeUserAt(index);
    if (user === null || (user.sourceChapter === undefined && user.sourcePage === undefined)) {
      return undefined;
    }
    return {
      ...(user.sourceChapter !== undefined ? { chapter: user.sourceChapter } : {}),
      ...(user.sourcePage !== undefined ? { page: user.sourcePage } : {}),
    };
  };

  /** 该助手消息是否提供「保存为标注」（所属交换由本章摘要发起且是最终回答）。 */
  const savableAt = (index: number): boolean => {
    const message = messages[index];
    if (
      message === undefined ||
      message.role !== 'assistant' ||
      message.content.trim() === '' ||
      isSettled(message) ||
      (message.toolCalls !== undefined && message.toolCalls.length > 0)
    ) {
      return false;
    }
    return exchangeUserAt(index)?.action === 'chapterSummary';
  };

  const scheduleStreamRender = (): void => {
    if (renderTimer !== null) {
      return;
    }
    // 每次重绘都要把整段回答重新解析 + 消毒；按 token 到达逐次重绘是 O(n²)，合并到
    // 几十毫秒一帧肉眼无差。
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderStreamingBody();
    }, deps.streamRenderIntervalMs ?? STREAM_RENDER_INTERVAL_MS);
  };

  const renderMarkdownInto = (
    container: HTMLElement,
    content: string,
    streamingNow: boolean,
  ): void => {
    const rendered = renderAssistantMarkdown(content, {
      streaming: streamingNow,
      imageFallback: t('reader.assistant.image'),
      onLanguageLoaded: () => {
        if (!disposed.value) {
          if (streaming) {
            scheduleStreamRender();
          } else {
            renderMessages();
          }
        }
      },
    });
    // 只搬子节点：把包装类挂到目标容器上，assistant-panel.css 里按该类写的 Markdown 规则才生效。
    container.classList.add('lightink-reader-assistant-markdown');
    // 图片不渲染，占位文案走 i18n。
    container.replaceChildren(...Array.from(rendered.childNodes));
  };

  const renderStreamingBody = (): void => {
    if (disposed.value || streamingBody === null) {
      return;
    }
    const entry = messages[streamingIndex];
    if (entry === undefined) {
      return;
    }
    if (entry.content === '') {
      streamingBody.classList.add('is-streaming');
      streamingBody.textContent = t('reader.assistant.streaming');
    } else {
      streamingBody.classList.remove('is-streaming');
      renderMarkdownInto(streamingBody, entry.content, true);
    }
    scrollMessagesBottom();
  };

  const toolLabel = (name: string): string => {
    if (name === ASSISTANT_TOOL_QUERY) {
      return t('reader.assistant.tool.query');
    }
    if (name === ASSISTANT_TOOL_SAVE) {
      return t('reader.assistant.tool.save');
    }
    return name;
  };

  const toolStatusOf = (result: AssistantToolResult | undefined): 'running' | 'ok' | 'error' | 'rejected' => {
    if (result === undefined) {
      return 'running';
    }
    if (result.isError) {
      return 'error';
    }
    try {
      const parsed = JSON.parse(result.content) as { reason?: unknown; saved?: unknown };
      if (parsed !== null && typeof parsed === 'object' && parsed.reason === 'rejected') {
        return 'rejected';
      }
    } catch {
      // 非 JSON 结果按成功展示
    }
    return 'ok';
  };

  const renderToolBlock = (
    call: AssistantToolCall,
    result: AssistantToolResult | undefined,
  ): HTMLElement => {
    const block = document.createElement('div');
    block.className = 'lightink-reader-assistant-tool';
    block.dataset.toolName = call.name;
    const status = toolStatusOf(result);
    block.dataset.toolStatus = status;
    const headRow = document.createElement('div');
    headRow.className = 'lightink-reader-assistant-tool-head';
    const name = document.createElement('span');
    name.className = 'lightink-reader-assistant-tool-name';
    name.textContent = toolLabel(call.name);
    const args = document.createElement('span');
    args.className = 'lightink-reader-assistant-tool-args';
    args.textContent = describeAssistantToolCall(call);
    args.title = args.textContent;
    const statusEl = document.createElement('span');
    statusEl.className = 'lightink-reader-assistant-tool-status';
    statusEl.textContent =
      status === 'running'
        ? t('reader.assistant.tool.running')
        : status === 'error'
          ? t('reader.assistant.tool.failed')
          : status === 'rejected'
            ? t('reader.assistant.tool.rejected')
            : t('reader.assistant.tool.done');
    headRow.append(name, args, statusEl);
    block.appendChild(headRow);
    if (result !== undefined) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t('reader.assistant.tool.result');
      const pre = document.createElement('pre');
      const content = result.content;
      pre.textContent =
        content.length > TOOL_RESULT_PREVIEW_CHARS
          ? `${content.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
          : content;
      details.append(summary, pre);
      block.appendChild(details);
    }
    return block;
  };

  const renderMessage = (message: AssistantMessage, index: number): HTMLElement[] => {
    if (message.role === 'tool') {
      const previous = messages[index - 1];
      const calls = previous?.role === 'assistant' ? (previous.toolCalls ?? []) : [];
      const results = message.toolResults ?? [];
      const blocks: HTMLElement[] = [];
      for (const result of results) {
        const call = calls.find((item) => item.id === result.callId) ?? {
          id: result.callId,
          name: result.name,
          arguments: {},
        };
        blocks.push(renderToolBlock(call, result));
      }
      return blocks;
    }
    const bubble = document.createElement('div');
    bubble.className = `lightink-reader-assistant-message is-${message.role}`;
    bubble.dataset.role = message.role;
    if (message.action !== undefined) {
      bubble.dataset.action = message.action;
    }
    if (message.role === 'user') {
      const text = document.createElement('p');
      text.className = 'lightink-reader-assistant-message-text';
      text.textContent = message.content;
      bubble.appendChild(text);
      return [bubble];
    }
    if (message.contextTruncated === true) {
      const notice = document.createElement('p');
      notice.className = 'lightink-reader-assistant-notice';
      notice.textContent = t('reader.assistant.truncated', {
        n: String(READER_LIMITS.maxAssistantContextChars),
      });
      bubble.appendChild(notice);
    }
    const body = document.createElement('div');
    body.className = 'lightink-reader-assistant-message-text';
    const isStreamingTarget = streaming && index === streamingIndex;
    if (isStreamingTarget) {
      // 只让正在流式的这一条播报；整个列表挂 aria-live 会在每次重绘时把整段对话重读一遍。
      body.setAttribute('aria-live', 'polite');
    }
    if (message.content === '') {
      if (isStreamingTarget || !isSettled(message)) {
        body.classList.add('is-streaming');
        body.textContent = streaming && isStreamingTarget ? t('reader.assistant.streaming') : '';
      }
    } else {
      renderMarkdownInto(body, message.content, isStreamingTarget);
    }
    bubble.appendChild(body);
    if (isStreamingTarget) {
      streamingBody = body;
    }
    if (message.stopped === true) {
      const stopped = document.createElement('p');
      stopped.className = 'lightink-reader-assistant-stopped';
      stopped.textContent = t('reader.assistant.stopped');
      bubble.appendChild(stopped);
    }
    if (message.truncated === true) {
      const truncated = document.createElement('p');
      truncated.className = 'lightink-reader-assistant-stopped';
      truncated.textContent = t('reader.assistant.replyTruncated');
      bubble.appendChild(truncated);
    }
    if (message.error !== undefined && message.error !== '') {
      const error = document.createElement('p');
      error.className = 'lightink-reader-assistant-error';
      error.textContent = message.error;
      bubble.appendChild(error);
      // 重试会丢掉其后的所有交换：只在它是最后一次交换时提供。
      const hasLaterExchange = messages.slice(index + 1).some((later) => later.role === 'user');
      if (!hasLaterExchange) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'lightink-reader-assistant-retry';
        retry.textContent = t('reader.lookup.retry');
        retry.disabled = streaming;
        retry.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          retryAt(index);
        });
        bubble.appendChild(retry);
      }
    } else if (savableAt(index)) {
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'lightink-reader-assistant-save';
      // 已保存态记在消息上并随历史落盘：切换会话、重开书都不会再给一次重复保存的机会。
      const saved = message.savedAnnotation === true;
      saveButton.disabled = saved;
      saveButton.textContent = saved ? t('reader.assistant.saved') : t('reader.assistant.saveAnnotation');
      saveButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = messages[index];
        if (current === undefined || current.savedAnnotation === true) {
          return;
        }
        const originSessionId = session?.id ?? null;
        const setSaved = (value: boolean): void => {
          if (session?.id === originSessionId) {
            const latest = messages[index];
            if (latest !== undefined && latest.createdAt === message.createdAt) {
              messages[index] = { ...latest, savedAnnotation: value ? true : undefined };
            }
            return;
          }
          // 落盘结果回来时用户已切到别的会话：改文件里发起保存的那一段，而不是当前段。
          file = {
            activeSessionId: file.activeSessionId,
            sessions: file.sessions.map((item) =>
              item.id !== originSessionId
                ? item
                : {
                    ...item,
                    messages: item.messages.map((entry) =>
                      entry.role === 'assistant' && entry.createdAt === message.createdAt
                        ? { ...entry, savedAnnotation: value ? true : undefined }
                        : entry,
                    ),
                  },
            ),
          };
        };
        setSaved(true);
        saveButton.disabled = true;
        saveButton.textContent = t('reader.assistant.saved');
        persistHistory();
        // 宿主回传落盘结果：没落盘就恢复按钮并提示，不让「已保存」骗人。
        let outcome: void | boolean | Promise<boolean>;
        try {
          outcome = deps.saveAnnotation(message.content.trim(), sourceOfExchange(index));
        } catch {
          outcome = false;
        }
        void Promise.resolve(outcome)
          .catch(() => false)
          .then((ok) => {
            if (disposed.value || ok !== false) {
              return;
            }
            setSaved(false);
            if (session?.id === originSessionId) {
              saveButton.disabled = false;
              saveButton.textContent = t('reader.assistant.saveAnnotation');
            }
            showNotice(t('reader.assistant.saveFailed'));
            persistHistory();
          });
      });
      bubble.appendChild(saveButton);
    }
    const nodes: HTMLElement[] = [bubble];
    // 在飞的工具调用：只有正在流式的本轮最后一条消息才可能真的在等结果；恢复
    // 出来的历史（无论是否带 stopped/error 标记）永远不显示「正在调用」。
    const calls = message.toolCalls ?? [];
    const pending = streaming && index === messages.length - 1 && !isSettled(message);
    if (pending && calls.length > 0) {
      for (const call of calls) {
        nodes.push(renderToolBlock(call, undefined));
      }
    }
    return nodes;
  };

  const renderMessages = (): void => {
    streamingBody = null;
    if (messages.length === 0) {
      messagesHost.replaceChildren();
      scrollMessagesBottom();
      return;
    }
    const nodes = messages.flatMap((message, index) => renderMessage(message, index));
    // 全量替换子节点会把滚动容器钳到顶部；用户上滑中（不跟随）时把原偏移放回去，
    // 否则回答结束或工具切换那一刻会把人拉回对话开头。
    const previousTop = messagesHost.scrollTop;
    messagesHost.replaceChildren(...nodes);
    if (!followOutput) {
      messagesHost.scrollTop = previousTop;
    }
    scrollMessagesBottom();
  };

  const syncControls = (): void => {
    const chapterAvailable = chapterContextOrNull() !== null;
    // 历史装载未落地前不接受任何会改动会话的操作：否则先写出去的文件会覆盖磁盘
    // 上尚未读到的其它段（askWithSelection 走 ensureHistory().then 等待）。
    const busy = streaming || historyPending;
    for (const [action, button] of actionButtons) {
      const noContext = action !== 'explain' && action !== 'summarize' && !chapterAvailable;
      button.disabled = busy || noContext;
      button.title = noContext ? t('reader.assistant.noChapterContext') : '';
    }
    send.hidden = streaming;
    send.disabled = busy || !aiConfigured;
    stop.hidden = !streaming;
    newSessionButton.disabled = busy;
    hint.hidden = readerChromeTouchMode();
    const hasSelection = selectionOrEmpty() !== '';
    quoteButton.disabled = !hasSelection || !aiConfigured;
    quoteButton.title = hasSelection
      ? t('reader.assistant.quoteSelection')
      : t('reader.assistant.noSelection');
    if (sessionsOpen) {
      renderSessions();
    }
  };

  const applyConfiguredView = (): void => {
    guide.hidden = aiConfigured;
    main.hidden = !aiConfigured;
    if (!aiConfigured && streaming) {
      stopStreaming(); // 配置被清空时停止按钮随 main 一起藏了：替用户停掉，不让请求继续跑
    }
    syncControls();
  };

  // —— 配置态（初始查询 + Manage 广播事件同源） ——
  const refreshConfig = async (): Promise<void> => {
    const fetchConfig = deps.fetchConfig ?? invokeAiTranslateConfig;
    let next: AiTranslateConfig;
    try {
      next = await fetchConfig();
    } catch {
      next = { configured: false, missing: [] };
    }
    if (disposed.value) {
      return;
    }
    aiConfigured = next.configured;
    aiMissing = next.missing;
    applyConfiguredView();
  };

  const onAiConfiguredEvent = (event: Event): void => {
    const configured = (event as CustomEvent<{ configured?: boolean }>).detail?.configured;
    if (typeof configured === 'boolean') {
      aiConfigured = configured;
      applyConfiguredView();
    }
    void refreshConfig();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener(READER_AI_CONFIGURED_EVENT, onAiConfiguredEvent);
  }

  // —— 会话装载与持久化（按书哈希；重开续显） ——
  /** 磁盘历史读取在飞：期间禁止提问与会话操作（见 syncControls）。 */
  let historyPending = false;
  /** 装载期间到来的写入请求（在飞回答收尾）：装载落地后补写一次。 */
  let persistDeferred = false;
  let historyLoad: Promise<void> | null = null;

  const adoptSession = (next: AssistantSession | null): void => {
    session = next ?? createAssistantSession();
    messages = [...session.messages];
    streamingBody = null;
    streamingIndex = -1;
    followOutput = true;
    renderMessages();
    if (sessionsOpen) {
      renderSessions();
    }
  };

  const resetConversation = (): void => {
    generation += 1;
    streaming = false;
    currentRequestId = null;
    streamingBody = null;
    streamingIndex = -1;
    file = EMPTY_ASSISTANT_HISTORY;
    session = null;
    messages = [];
    hideNotice();
    setSessionsOpen(false);
    renderMessages();
    syncControls();
  };

  const ensureHistory = (): Promise<void> => {
    const key = deps.historyKey?.() ?? null;
    const readHistory = deps.readHistory;
    if (key === null || readHistory === undefined) {
      if (session === null) {
        adoptSession(null);
      }
      return Promise.resolve();
    }
    if (loadedKey === key) {
      return historyLoad ?? Promise.resolve();
    }
    // 首次拿到书籍身份（内容哈希在面板首次打开之后才算出来）：把已经开始的内存会话
    // 带过去，与磁盘上的旧段合并，而不是让它覆盖整本书的历史。
    const carry = loadedKey === null && session !== null && messages.length > 0 ? session : null;
    if (loadedKey !== null) {
      // 换书（触屏 replace-existing-reader 复用同一面板实例）：整会话复位，
      // 旧书对话不得残留展示、也不得经 persistHistory 写进新书的哈希文件。
      resetConversation();
    }
    loadedKey = key;
    if (session === null) {
      adoptSession(null);
    }
    historyPending = true;
    syncControls();
    historyLoad = (async () => {
      let raw = '';
      try {
        raw = await readHistory(key);
      } catch {
        raw = '';
      }
      if (disposed.value || loadedKey !== key) {
        return;
      }
      // 装载期间没有任何交互（syncControls 已禁用），磁盘快照可以直接采纳。
      const parsed = parseAssistantHistory(raw);
      const sessions = parsed.sessions.filter((item) => item.messages.length > 0);
      if (carry !== null && session?.id === carry.id) {
        file = upsertAssistantSession(
          { activeSessionId: carry.id, sessions },
          { ...carry, messages: [...messages] },
        );
        if (sessionsOpen) {
          renderSessions();
        }
        return;
      }
      file = { activeSessionId: parsed.activeSessionId, sessions };
      const active =
        findAssistantSession(file, file.activeSessionId) ?? sortAssistantSessions(sessions)[0] ?? null;
      adoptSession(active);
    })().finally(() => {
      if (loadedKey === key) {
        historyPending = false;
        if (!disposed.value) {
          syncControls();
          if (persistDeferred) {
            persistDeferred = false;
            persistHistory();
          }
        }
      }
    });
    return historyLoad;
  };

  const persistHistory = (touch = true): void => {
    if (session === null) {
      return;
    }
    const targetKey = deps.historyKey?.() ?? null;
    if (targetKey !== null && (targetKey !== loadedKey || historyPending)) {
      // 这本书的磁盘历史还没读进来（身份刚算出来 / 读取在飞）：先装载再写，否则会用
      // 内存里的这一段覆盖整本书的历史。
      persistDeferred = true;
      void ensureHistory();
      return;
    }
    // 条数上限在写入侧执行（保留最新的完整交换），内存与磁盘保持一致。
    const capped = capAssistantMessages(messages);
    if (capped.length !== messages.length) {
      messages = capped;
      renderMessages();
    }
    session = { ...session, updatedAt: touch ? Date.now() : session.updatedAt, messages: [...messages] };
    if (messages.length > 0) {
      file = upsertAssistantSession(file, session);
    } else {
      file = { activeSessionId: session.id, sessions: file.sessions };
    }
    const key = deps.historyKey?.() ?? null;
    if (key === null || deps.writeHistory === undefined) {
      if (key === null && messages.length > 0) {
        persistDeferred = true; // 身份到来（syncIdentity）后并入磁盘历史再写
      }
      return;
    }
    if (assistantSessionOversized(session)) {
      // 活动段自己超限：可见地裁掉最早的交换（重绘 + 提示），不能拒写后在下次切换时被当作
      // 最旧段静默丢掉；只剩一次交换仍超限才拒写。
      const trimmed = trimAssistantSessionToFit(session);
      if (!trimmed.fits) {
        showNotice(t('reader.assistant.historyWriteFailed'), 'history');
        return;
      }
      session = trimmed.session;
      messages = [...session.messages];
      file = upsertAssistantSession(file, session);
      renderMessages();
      showNotice(t('reader.assistant.historyTrimmed', { n: String(trimmed.dropped) }));
    }
    // Rust 的 2 MiB 上限是整文件：多段合计超限时丢最旧的非活动段，活动段单独
    // 仍超限才拒绝写入并提示（上面已判）。
    const fitted = fitAssistantHistory(file, session.id);
    if (!fitted.fits || fitted.json === null) {
      showNotice(t('reader.assistant.historyWriteFailed'), 'history');
      return;
    }
    file = fitted.file;
    void deps
      .writeHistory(key, fitted.json)
      .then(() => {
        if (!disposed.value && noticeKey === 'history') {
          hideNotice();
        }
      })
      .catch(() => {
        if (!disposed.value) {
          showNotice(t('reader.assistant.historyWriteFailed'), 'history');
        }
      });
  };

  const switchSession = (sessionId: string): void => {
    if (streaming || historyPending || sessionId === session?.id) {
      return;
    }
    const target = findAssistantSession(file, sessionId);
    if (target === null) {
      return;
    }
    adoptSession(target);
    setSessionsOpen(false);
    persistHistory(false); // 只是切换查看：不改它的 updatedAt，列表顺序与「最旧段」判定不受影响
  };

  const startNewSession = (): void => {
    if (streaming || historyPending) {
      return;
    }
    if (session !== null && messages.length === 0) {
      setSessionsOpen(false);
      return; // 当前已是空会话
    }
    adoptSession(createAssistantSession());
    setSessionsOpen(false);
    persistHistory();
  };

  const deleteSession = (sessionId: string): void => {
    if (streaming || historyPending) {
      return;
    }
    file = removeAssistantSession(file, sessionId);
    if (session?.id === sessionId) {
      const next = findAssistantSession(file, file.activeSessionId);
      adoptSession(next);
      if (next === null) {
        file = { activeSessionId: session!.id, sessions: file.sessions };
      }
    }
    renderSessions();
    const key = deps.historyKey?.() ?? null;
    if (key !== null && deps.writeHistory !== undefined) {
      // 与 persistHistory 同一条收敛路径：否则文件里残留的超限段会让删除本身写不进去。
      const fitted = fitAssistantHistory(file, session?.id ?? null);
      if (!fitted.fits || fitted.json === null) {
        showNotice(t('reader.assistant.historyWriteFailed'), 'history');
        return;
      }
      file = fitted.file;
      void deps
        .writeHistory(key, fitted.json)
        .catch(() => showNotice(t('reader.assistant.historyWriteFailed'), 'history'));
    }
  };

  const clearAllHistory = (): void => {
    if (streaming || historyPending) {
      return;
    }
    generation += 1;
    file = EMPTY_ASSISTANT_HISTORY;
    adoptSession(null);
    setSessionsOpen(false);
    syncControls();
    const key = deps.historyKey?.() ?? null;
    if (key !== null) {
      void deps.clearHistory?.(key).catch(() => {
        if (disposed.value) {
          return;
        }
        // 磁盘上的还在：提示并读回来，不让界面假装已清空（重开书时它们会全部回来）。
        showNotice(t('reader.assistant.historyClearFailed'), 'history');
        loadedKey = null;
        void ensureHistory();
      });
    }
  };

  // —— 流式交换（含工具循环） ——
  const runExchange = async (start: number): Promise<void> => {
    const exchangeGeneration = generation;
    const budget = createAssistantToolBudget();
    const chapter = chapterContextOrNull();
    const clip = chapter === null ? null : clipAssistantContext(chapter.text);
    const context =
      chapter !== null && clip !== null && clip.text !== ''
        ? assistantContextBlock({ title: chapter.title, text: clip.text, truncated: clip.truncated })
        : null;
    const contextTruncated = clip?.truncated === true;
    const systemPrompt = t('reader.assistant.systemPrompt');
    let targetIndex = start + 1;
    const first = messages[targetIndex];
    if (first !== undefined) {
      messages[targetIndex] = { ...first, contextTruncated };
    }
    streaming = true;
    streamingIndex = targetIndex;
    hideNotice();
    renderContextStrip();
    syncControls();
    renderMessages();

    const onDelta = (index: number) => (delta: string): void => {
      // 通道消息可能晚于命令结果到达：目标已收尾 / 已进入下一轮时不再追加。
      if (disposed.value || exchangeGeneration !== generation || !streaming || index !== streamingIndex) {
        return;
      }
      const entry = messages[index];
      if (entry === undefined) {
        return;
      }
      messages[index] = { ...entry, content: entry.content + delta };
      scheduleStreamRender();
    };

    try {
      for (let round = 0; ; round += 1) {
        const requestId = newAssistantRequestId();
        currentRequestId = requestId;
        const request = buildAssistantRequest({
          requestId,
          tools,
          systemPrompt,
          context,
          messages: messages.slice(0, targetIndex),
          currentStart: start,
        });
        const done = await streamAssistantChat(request, onDelta(targetIndex), streamDeps);
        if (disposed.value || exchangeGeneration !== generation) {
          return;
        }
        currentRequestId = null;
        const entry = messages[targetIndex]!;
        if (done.toolCalls.length === 0) {
          // length / max_tokens / incomplete：内容被截断，不能当完整回答（也不给「保存为标注」）。
          // content_filter：内容被过滤（可能是空的或半截的），按错误呈现并允许重试。
          const filtered = done.finish === 'content_filter';
          const truncated = !filtered && !NORMAL_FINISHES.has(done.finish);
          messages[targetIndex] = {
            ...entry,
            error: filtered ? t('reader.ai.error.filtered') : undefined,
            ...(truncated ? { truncated: true } : {}),
          };
          break;
        }
        messages[targetIndex] = { ...entry, toolCalls: done.toolCalls };
        if (round + 1 >= ASSISTANT_MAX_TOOL_ROUNDS) {
          const limitText = t('reader.assistant.tool.roundLimit', {
            n: String(ASSISTANT_MAX_TOOL_ROUNDS),
          });
          messages.push({
            role: 'tool',
            content: '',
            createdAt: Date.now(),
            toolResults: done.toolCalls.map((call) => ({
              callId: call.id,
              name: call.name,
              content: JSON.stringify({ error: limitText }),
              isError: true,
            })),
          });
          messages.push({ role: 'assistant', content: '', createdAt: Date.now(), error: limitText });
          streamingIndex = -1;
          break;
        }
        streamingBody = null;
        renderMessages();
        // 顺序执行：章节读取上限按预算计数，并发会让多次调用同时看到旧计数而越过上限。
        // 单次回复内的调用数也封顶：往返上限管不住一次回复里塞几十个 search / save，
        // 超出的直接回错误结果，不执行（不弹确认、不吃搜索预算）。
        const results: AssistantToolResult[] = [];
        const accepted = done.toolCalls.slice(0, ASSISTANT_MAX_TOOL_CALLS_PER_TURN);
        for (const call of accepted) {
          // 面板已关（换页签、回书架、开其它浮层）时不再弹保存确认：交互型工具直接回
          // 错误结果，让模型知道；只读工具照常在后台完成。
          if (call.name === ASSISTANT_TOOL_SAVE && !panelVisible) {
            results.push({
              callId: call.id,
              name: call.name,
              content: JSON.stringify({ error: t('reader.assistant.tool.panelClosed') }),
              isError: true,
            });
            continue;
          }
          results.push(await executeAssistantTool(call, deps.access, budget));
          if (disposed.value || exchangeGeneration !== generation) {
            return;
          }
        }
        if (done.toolCalls.length > accepted.length) {
          const limitText = t('reader.assistant.tool.callLimit', {
            n: String(ASSISTANT_MAX_TOOL_CALLS_PER_TURN),
          });
          for (const call of done.toolCalls.slice(accepted.length)) {
            results.push({
              callId: call.id,
              name: call.name,
              content: JSON.stringify({ error: limitText }),
              isError: true,
            });
          }
        }
        messages.push({ role: 'tool', content: '', createdAt: Date.now(), toolResults: results });
        messages.push({ role: 'assistant', content: '', createdAt: Date.now() });
        targetIndex = messages.length - 1;
        streamingIndex = targetIndex;
        renderMessages();
      }
    } catch (error) {
      const entry = messages[targetIndex];
      if (entry !== undefined && !disposed.value && exchangeGeneration === generation) {
        messages[targetIndex] = {
          ...entry,
          error: readerAiErrorMessage(t, error, aiMissing),
        };
      }
    } finally {
      if (exchangeGeneration === generation) {
        streaming = false;
        currentRequestId = null;
        streamingBody = null;
        streamingIndex = -1;
        if (!disposed.value) {
          renderMessages();
          syncControls();
          persistHistory();
        }
      }
    }
  };

  const appendExchange = (user: AssistantMessage): void => {
    if (streaming || historyPending) {
      return;
    }
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    const start = messages.length;
    messages.push(user, assistant);
    followOutput = true;
    void runExchange(start);
  };

  /** 发起一轮提问；返回是否真的发出（流式中/空文本/未配置不发）。 */
  const ask = (content: string, action?: AssistantQuickAction): boolean => {
    const question = content.trim();
    if (question === '' || !aiConfigured || streaming || historyPending) {
      return false;
    }
    // 面板动作以当前章为上下文：记下发起时的章 / 页，摘要保存为标注时锚到它。
    let source: AssistantSaveSource = {};
    if (action === 'chapterSummary' || action === 'vocabulary' || action === 'quiz') {
      try {
        const current = deps.access.currentChapter();
        source = {
          ...(current?.chapter !== undefined ? { chapter: current.chapter } : {}),
          ...(current?.page !== undefined ? { page: current.page } : {}),
        };
      } catch {
        source = {};
      }
    }
    appendExchange({
      role: 'user',
      content: question,
      createdAt: Date.now(),
      action,
      ...(source.chapter !== undefined ? { sourceChapter: source.chapter } : {}),
      ...(source.page !== undefined ? { sourcePage: source.page } : {}),
    });
    return true;
  };

  /** 快捷动作：指令 +（选区动作）引文为用户消息；面板动作以当前章为上下文。 */
  const runQuickAction = (action: AssistantQuickAction, quote?: string): void => {
    if (!aiConfigured || streaming || historyPending) {
      return;
    }
    if (action === 'explain' || action === 'summarize') {
      const instruction = t(assistantPromptKey(action));
      ask(assistantActionContent(action, instruction, quote ?? ''), action);
      return;
    }
    const chapter = chapterContextOrNull();
    if (chapter === null || chapter.text.trim() === '') {
      return;
    }
    ask(t(assistantPromptKey(action)), action);
  };

  /** 原地重试：回到该交换的用户提问，丢弃其后的助手/工具消息后重发。 */
  const retryAt = (index: number): void => {
    if (streaming || historyPending) {
      return;
    }
    let start = index;
    while (start >= 0 && messages[start]!.role !== 'user') {
      start -= 1;
    }
    if (start < 0) {
      return;
    }
    const keep = messages.slice(0, start + 1);
    messages = [...keep, { role: 'assistant', content: '', createdAt: Date.now() }];
    followOutput = true;
    void runExchange(start);
  };

  /** 停止生成：已生成文字保留为「已停止」，作废在飞回调，登记后端中止。 */
  const stopStreaming = (): void => {
    if (!streaming) {
      return;
    }
    generation += 1;
    streaming = false;
    const requestId = currentRequestId;
    currentRequestId = null;
    const index = streamingIndex;
    streamingIndex = -1;
    streamingBody = null;
    const entry = messages[index];
    if (entry !== undefined && entry.role === 'assistant') {
      messages[index] = { ...entry, stopped: true, error: undefined };
    }
    renderMessages();
    syncControls();
    persistHistory();
    deps.access.cancelPendingSaves?.(); // 正在等用户回答的保存确认随停止一起收掉
    if (requestId !== null) {
      void abortAssistantChat(requestId, streamDeps);
    }
  };

  // —— 输入 ——
  const autosizeInput = (): void => {
    input.style.height = 'auto';
    const max = 12 * 16;
    const next = Math.min(max, input.scrollHeight);
    if (next > 0) {
      input.style.height = `${next}px`;
    }
  };

  const clearInput = (): void => {
    input.value = '';
    quotedSelection = false;
    input.style.height = '';
    renderContextStrip();
  };

  const submit = (): void => {
    if (ask(input.value)) {
      clearInput(); // 只在真正发出后清空（流式中保留草稿）
    }
  };

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    if (readerChromeTouchMode()) {
      return; // 触屏以发送按钮为主，Enter 换行
    }
    event.preventDefault();
    event.stopPropagation();
    submit();
  });
  input.addEventListener('input', () => {
    autosizeInput();
    if (quotedSelection && !input.value.includes('<selection>')) {
      quotedSelection = false;
      renderContextStrip();
    }
  });
  input.addEventListener('focus', () => {
    syncControls();
  });

  quoteButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const selection = selectionOrEmpty();
    if (selection === '' || !aiConfigured) {
      syncControls();
      return;
    }
    const quote = assistantSelectionQuote(selection);
    const current = input.value;
    input.value = current === '' ? quote : `${current.replace(/\s*$/, '')}\n${quote}`;
    quotedSelection = true;
    autosizeInput();
    renderContextStrip();
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
    input.setSelectionRange(input.value.length, input.value.length);
  });

  stop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    stopStreaming();
  });

  messagesHost.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const locateButton = target.closest<HTMLElement>('[data-locate]');
    if (locateButton !== null && messagesHost.contains(locateButton)) {
      event.preventDefault();
      event.stopPropagation();
      const raw = locateButton.dataset.locate ?? '';
      const match = /^(chapter|page):(\d+)$/.exec(raw);
      if (match === null) {
        return;
      }
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) {
        return;
      }
      deps.locate?.(
        match[1] === 'chapter' ? { kind: 'chapter', index: value } : { kind: 'page', page: value },
      );
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (link !== null && messagesHost.contains(link)) {
      event.preventDefault();
      event.stopPropagation();
      const href = link.getAttribute('href') ?? '';
      // 宿主打开器只接受 http(s)（Rust open_in_browser 校验）；渲染层已不产出其它协议链接。
      if (/^https?:/i.test(href)) {
        deps.openLink?.(href);
      }
    }
  });

  // 中键 / 辅助键点击不走 click：不拦会让 WebView 自己去导航或开新窗，绕过 open_in_browser 的校验。
  messagesHost.addEventListener('auxclick', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('a[href]') !== null) {
      event.preventDefault();
    }
  });

  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });
  historyButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSessionsOpen(!sessionsOpen);
  });
  newSessionButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startNewSession();
  });
  settingsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openSettings();
  });
  root.addEventListener('pointerenter', () => {
    syncControls();
  });

  // —— 显隐（挂载/钉位/过渡面板自理） ——
  const positionPanel = (): void => {
    const host = deps.host();
    mountReaderOverlay(root, host);
    adoptReaderOverlayTheme(root, host);
    // 钉位沿用 chrome 面板口径：触屏是底部 sheet（键盘让位内联处理），
    // 桌面贴阅读区右缘全高（pinFixedOverlay 两个分支各自的几何）。
    const pane =
      typeof host.closest === 'function'
        ? (host.closest<HTMLElement>('#lightink-editor-area') ?? host)
        : host;
    pinFixedOverlay(root, pane);
  };

  const openPanel = (): void => {
    if (!panelVisible) {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      focusReturn = active instanceof HTMLElement && !root.contains(active) ? active : null;
    }
    panelVisible = true;
    root.hidden = false;
    positionPanel();
    void ensureHistory();
    configLoad = refreshConfig();
    applyConfiguredView();
    renderContextStrip();
    renderMessages();
    revealSheet(root);
    if (!readerChromeTouchMode()) {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
    }
  };

  const closePanel = (): void => {
    panelVisible = false;
    deps.access.cancelPendingSaves?.(); // 还开着的保存确认随面板一起收掉
    const restore = focusReturn;
    focusReturn = null;
    if (
      restore !== null &&
      restore.isConnected &&
      typeof document !== 'undefined' &&
      root.contains(document.activeElement)
    ) {
      try {
        restore.focus({ preventScroll: true });
      } catch {
        // 元素不可聚焦：焦点落回 body 即可
      }
    }
    if (readerChromeTouchMode()) {
      concealSheet(root, () => {
        root.hidden = true;
        unpinFixedOverlay(root);
      });
      return;
    }
    delete root.dataset.open;
    root.hidden = true;
    unpinFixedOverlay(root);
  };

  configLoad = refreshConfig();

  return {
    element: root,
    open: openPanel,
    close: closePanel,
    isVisible: () => panelVisible,
    refreshContext() {
      if (!disposed.value) {
        syncControls();
        renderContextStrip();
      }
    },
    syncIdentity() {
      if (!disposed.value) {
        void ensureHistory();
      }
    },
    askWithSelection(action, quote) {
      openPanel();
      // 先等本书历史落位再发起，避免装载竞态覆写刚开始的交换。
      // 先等本书历史与配置态都落位再发起：历史未落位会覆写磁盘，配置态未拿到会被静默丢弃。
      void Promise.all([ensureHistory(), configLoad]).then(() => {
        if (!disposed.value) {
          runQuickAction(action, quote);
        }
      });
    },
    destroy() {
      // 换书 / 关书时正在流式的交换也要落盘（与「停止」同口径：保留已生成文字并标记 stopped）。
      if (streaming) {
        const entry = messages[streamingIndex];
        if (entry !== undefined && entry.role === 'assistant') {
          messages[streamingIndex] = { ...entry, stopped: true, error: undefined };
        }
        persistHistory();
      }
      panelVisible = false;
      deps.access.cancelPendingSaves?.();
      disposed.value = true;
      generation += 1;
      streaming = false;
      streamingBody = null;
      // 换书/关书时在飞的流式请求也要中止，否则后端会把提供商请求跑完（可能计费）。
      const activeRequest = currentRequestId;
      currentRequestId = null;
      if (activeRequest !== null) {
        void abortAssistantChat(activeRequest, streamDeps);
      }
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener(READER_AI_CONFIGURED_EVENT, onAiConfiguredEvent);
      }
      delete root.dataset.open;
      root.hidden = true;
      unpinFixedOverlay(root);
      root.remove();
    },
  };
}
