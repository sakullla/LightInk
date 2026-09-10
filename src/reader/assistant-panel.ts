/**
 * `assistant-panel` — AI 助手面板（ADR-6 / R5）。
 *
 * 复用面板框架：桌面钉阅读区右侧（mountReaderOverlay + pinFixedOverlay），
 * 触屏是底部 sheet（is-touch-sheet + revealSheet/concealSheet 过渡）。互斥、
 * Escape 链与关闭清理挂点由 reader-chrome-wiring 接入（面板只管自身显隐）。
 *
 * - 对话：`ai_chat_stream` 经 Tauri IPC `Channel` 增量推送 delta，回答消息
 *   渐进显示；多轮上下文 = 系统提示 + 章节全文 + 此前轮次。
 * - 历史：按书（与标注同源的内容哈希）存 `app_data_dir/assistant/<hash>.json`
 *   （Rust 命令读写），重开续显；身份不可用时退化为仅内存。
 * - 上下文：当前章全文（注册表限额截断，保留前部并在回答前提示）或选中文本
 *   （解释/总结快捷动作）。
 * - 快捷动作：面板内「本章摘要 / 生词卡 / 章节测验」以当前章为上下文，结果
 *   以对话消息呈现；摘要消息可保存为标注（章节级锚点由宿主实现）。
 * - 失败：消息级错误展示 + 原地重试（重发同一请求，历史不重复）；未配置 AI
 *   时显示前往配置引导而非空聊天框。
 * - 编辑器界面无任何 AI 入口：本组件只被阅读器装配（R6）。
 */

import './assistant-panel.css';

import { Channel, invoke } from '@tauri-apps/api/core';
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

// ── 消息模型与常量 ───────────────────────────────────────────────────

/** 快捷动作（选区解释/总结由工具栏触发；其余是面板动作区按钮）。 */
export type AssistantQuickAction =
  | 'explain'
  | 'summarize'
  | 'chapterSummary'
  | 'vocabulary'
  | 'quiz';

const ASSISTANT_ACTIONS: readonly string[] = [
  'explain',
  'summarize',
  'chapterSummary',
  'vocabulary',
  'quiz',
];

/** 面板内动作区按钮（以当前章为上下文）。 */
export const ASSISTANT_PANEL_ACTIONS: readonly AssistantQuickAction[] = [
  'chapterSummary',
  'vocabulary',
  'quiz',
];

/** 单次请求携带的历史轮次上限（ai.rs MAX_MESSAGES=200 的安全余量）。 */
export const ASSISTANT_MAX_TURNS = 30;
/** 请求字符预算（系统提示 + 历史 + 问题；章节上下文另计）。 */
const ASSISTANT_REQUEST_CHAR_BUDGET = 180_000;
/** 历史文件消息条数上限（敌意文件防膨胀；正常对话远低于此）。 */
const ASSISTANT_HISTORY_MAX_MESSAGES = 400;

/** 面板视图消息（也是历史文件的 schema）。 */
export interface AssistantHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: number;
  /** user 轮：发起该消息的快捷动作（解释/总结/本章摘要…）。 */
  readonly action?: AssistantQuickAction;
  /** assistant 轮：本次回答注入的章节上下文发生了截断。 */
  readonly contextTruncated?: boolean;
  /** assistant 轮：流式失败的可展示错误文案（可原地重试）。 */
  readonly error?: string;
}

/** `ai_chat_stream` 的请求消息（ai.rs AiChatMessage 的前端投影）。 */
export interface AiChatMessageView {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** `ai_chat_stream` 经 Channel 推送的事件（snake_case tag 与 ai.rs 钉死）。 */
export interface AiStreamEventView {
  readonly type: 'delta';
  readonly text: string;
}

/** `ai_chat_stream` 的返回终态。 */
export interface AiStreamDoneView {
  readonly finish: string;
  readonly totalChars: number;
}

// ── 纯函数：上下文截断 / 历史序列化 / 请求构造 ──────────────────────

export interface AssistantContextClip {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * 章节上下文截断（R5）：超限保留前部、截断后部；在代理对边界处回退一字，
 * 不产生半个字符。选择上下文复用同一预算。
 */
export function clipAssistantContext(
  text: string,
  limit: number = READER_LIMITS.maxAssistantContextChars,
): AssistantContextClip {
  const clean = text.trim();
  if (clean.length <= limit) {
    return { text: clean, truncated: false };
  }
  let cut = clean.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

/** 防御解析历史文件：坏 JSON / 坏形态返回空，不抛出。 */
export function parseAssistantHistory(raw: string): AssistantHistoryMessage[] {
  const text = raw.trim();
  if (text === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const list = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(list)) {
    return [];
  }
  const messages: AssistantHistoryMessage[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const role = obj.role;
    const content = obj.content;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    if (typeof content !== 'string') {
      continue;
    }
    const createdAt =
      typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : 0;
    const action =
      typeof obj.action === 'string' && ASSISTANT_ACTIONS.includes(obj.action)
        ? (obj.action as AssistantQuickAction)
        : undefined;
    const error = typeof obj.error === 'string' && obj.error !== '' ? obj.error : undefined;
    messages.push({
      role,
      content,
      createdAt,
      ...(action !== undefined ? { action } : {}),
      ...(obj.contextTruncated === true ? { contextTruncated: true } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    if (messages.length >= ASSISTANT_HISTORY_MAX_MESSAGES) {
      break;
    }
  }
  return messages;
}

/** 序列化历史文件（v1 信封：{version, messages, updatedAt}）。 */
export function serializeAssistantHistory(
  messages: readonly AssistantHistoryMessage[],
): string {
  return JSON.stringify({
    version: 1,
    messages: messages.map((message) => {
      const entry: Record<string, unknown> = {
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      };
      if (message.action !== undefined) {
        entry.action = message.action;
      }
      if (message.contextTruncated === true) {
        entry.contextTruncated = true;
      }
      if (message.error !== undefined) {
        entry.error = message.error;
      }
      return entry;
    }),
    updatedAt: Date.now(),
  });
}

/**
 * 构造一次流式请求：系统提示（含章节上下文）+ 近期轮次。失败占位
 * （error 且无内容）不进请求；从最新向前累计直至轮数/字符预算。
 */
export function buildAssistantChatRequest(
  systemPrompt: string,
  history: readonly AssistantHistoryMessage[],
  maxTurns: number = ASSISTANT_MAX_TURNS,
  charBudget: number = ASSISTANT_REQUEST_CHAR_BUDGET,
): AiChatMessageView[] {
  const turns: AssistantHistoryMessage[] = [];
  let budget = charBudget - systemPrompt.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role === 'assistant' && message.content.trim() === '') {
      continue; // 失败占位/流式中：不进请求
    }
    if (turns.length >= maxTurns || budget - message.content.length <= 0) {
      break;
    }
    budget -= message.content.length;
    turns.unshift(message);
  }
  return [
    { role: 'system', content: systemPrompt },
    ...turns.map((message) => ({ role: message.role, content: message.content })),
  ];
}

/** 系统提示组装：基础助手提示 +（有章节文本时）章节上下文块。 */
export function assistantSystemPrompt(
  base: string,
  chapter: { title: string; text: string } | null,
): string {
  if (chapter === null || chapter.text === '') {
    return base;
  }
  const title = chapter.title.trim();
  const head = title === '' ? '当前章节' : `当前章节：${title}`;
  return `${base}\n\n【${head}】\n<chapter>\n${chapter.text}\n</chapter>`;
}

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

// ── 流式通道（Tauri IPC Channel；注入面供测试） ──────────────────────

export type AssistantInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AssistantChannel<T> {
  onmessage: (message: T) => void;
}

export interface AssistantStreamDeps {
  readonly invoke?: AssistantInvoke;
  readonly createChannel?: <T>() => AssistantChannel<T>;
}

const defaultAssistantInvoke: AssistantInvoke = (command, args) =>
  invoke(command, args as Parameters<typeof invoke>[1]);

function defaultCreateChannel<T>(): AssistantChannel<T> {
  return new Channel<T>() as AssistantChannel<T>;
}

/**
 * 流式多轮对话：invoke 携带 `Channel`，delta 增量回调；终态
 * （完成 finish/totalChars）由命令返回值承载，失败以抛出错误码族呈现。
 */
export async function streamAssistantChat(
  messages: readonly AiChatMessageView[],
  onDelta: (delta: string) => void,
  deps: AssistantStreamDeps = {},
): Promise<AiStreamDoneView> {
  const invokeFn = deps.invoke ?? defaultAssistantInvoke;
  const createChannel = deps.createChannel ?? defaultCreateChannel;
  const channel = createChannel<AiStreamEventView>();
  channel.onmessage = (event) => {
    if (event !== null && typeof event === 'object' && event.type === 'delta') {
      if (typeof event.text === 'string' && event.text !== '') {
        onDelta(event.text);
      }
    }
  };
  const done = await invokeFn('ai_chat_stream', {
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    onEvent: channel,
  });
  if (done !== null && typeof done === 'object') {
    const obj = done as { finish?: unknown; totalChars?: unknown };
    return {
      finish: typeof obj.finish === 'string' ? obj.finish : 'closed',
      totalChars: typeof obj.totalChars === 'number' ? obj.totalChars : 0,
    };
  }
  return { finish: 'closed', totalChars: 0 };
}

// ── 面板组件 ─────────────────────────────────────────────────────────

/** 章节上下文供数（wiring 实现：flow 章全文 / PDF 当前页文本层 / cbz null）。 */
export interface AssistantChapterContext {
  readonly title: string;
  readonly text: string;
}

export interface AssistantPanelDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 阅读根（主题采纳与 portal 宿主）。 */
  host: () => HTMLElement;
  /** 当前章节上下文；无文本层格式返回 null。 */
  chapterContext: () => AssistantChapterContext | null;
  /** 未配置引导「前往配置」（宿主：回书架并打开 Manage 的 AI 分组）。 */
  openSettings: () => void;
  /** 摘要保存为标注（章节级锚点由宿主实现）。 */
  saveAnnotation: (text: string) => void;
  /** 配置读取（缺省走 `ai_get_config` 投影）。 */
  fetchConfig?: () => Promise<AiTranslateConfig>;
  /** 按书历史读取（缺省不可用 → 仅内存）。 */
  readHistory?: (contentHash: string) => Promise<string>;
  /** 按书历史写入。 */
  writeHistory?: (contentHash: string, json: string) => Promise<void>;
  /** 清除本书历史（Rust `assistant_clear_history`，幂等；缺省仅清内存）。 */
  clearHistory?: (contentHash: string) => Promise<void>;
  /** 当前书的存储键（与标注身份同源）；null = 不持久化。 */
  historyKey?: () => string | null;
  /** 流式通道注入（测试）。 */
  stream?: AssistantStreamDeps;
}

export interface AssistantPanel {
  readonly element: HTMLElement;
  /** 显示并确保本书历史就位（挂载/钉位/进场过渡由面板自理）。 */
  open(): void;
  close(): void;
  isVisible(): boolean;
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

/**
 * 创建 AI 助手面板。element 由面板自理挂载（open 时 portal 到 body 并按
 * 桌面右栏 / 触屏底栏钉位）；显隐互斥与 Escape 链在 reader-chrome-wiring。
 */
export function createAssistantPanel(deps: AssistantPanelDeps): AssistantPanel {
  const t = deps.t;
  const streamDeps = deps.stream ?? {};
  const disposed = { value: false };

  const root = document.createElement('aside');
  root.className = 'lightink-reader-assistant-panel';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', t('reader.assistant.title'));
  root.hidden = true;

  const head = document.createElement('div');
  head.className = 'lightink-reader-assistant-head';
  const title = document.createElement('span');
  title.className = 'lightink-reader-assistant-title';
  title.textContent = t('reader.assistant.title');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-assistant-close lightink-reader-sidebar-close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('annotation.closeSidebar'));
  close.setAttribute('title', t('annotation.closeSidebar'));
  // 清除本书对话（assistant_clear_history 幂等;同时清内存会话）。
  const clearHistoryButton = document.createElement('button');
  clearHistoryButton.type = 'button';
  clearHistoryButton.className = 'lightink-reader-assistant-clear';
  clearHistoryButton.textContent = t('reader.assistant.clearHistory');
  clearHistoryButton.setAttribute('title', t('reader.assistant.clearHistory'));
  head.append(title, clearHistoryButton, close);

  // —— 未配置引导（R5：引导而非空聊天框） ——
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
  const messagesHost = document.createElement('div');
  messagesHost.className = 'lightink-reader-assistant-messages';
  messagesHost.setAttribute('aria-live', 'polite');
  messagesHost.setAttribute('aria-label', t('reader.assistant.title'));

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
  input.rows = 1;
  input.setAttribute('placeholder', t('reader.assistant.placeholder'));
  input.setAttribute('aria-label', t('reader.assistant.placeholder'));
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'lightink-reader-assistant-send';
  send.textContent = t('reader.assistant.send');
  composer.append(input, send);
  main.append(messagesHost, actions, composer);
  root.append(head, guide, main);

  root.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation();
    },
    { passive: true },
  );
  root.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  root.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  // —— 状态 ——
  let messages: AssistantHistoryMessage[] = [];
  let streaming = false;
  let loadedKey: string | null = null;
  /** 会话代数：换书重置时递增，作废仍在飞行的流式回调（delta/终态/持久化）。 */
  let sessionGeneration = 0;
  let aiConfigured = false;
  let aiMissing: readonly string[] = [];
  /** 已保存为标注的助手消息（createdAt 键控；防重复保存按钮）。 */
  const savedAnswers = new Set<number>();
  /** 流式期间直接更新的正文节点（渐进显示不经全量重绘）。 */
  let streamingText: HTMLParagraphElement | null = null;

  const chapterContextOrNull = (): AssistantChapterContext | null => {
    try {
      return deps.chapterContext();
    } catch {
      return null;
    }
  };

  const scrollMessagesBottom = (): void => {
    messagesHost.scrollTop = messagesHost.scrollHeight;
  };

  /** 该助手消息是否提供「保存为标注」（前一轮是本章摘要）。 */
  const savableAt = (index: number): boolean =>
    messages[index] !== undefined &&
    messages[index]!.role === 'assistant' &&
    messages[index]!.content.trim() !== '' &&
    messages[index]!.error === undefined &&
    messages[index - 1]?.action === 'chapterSummary';

  const renderMessage = (message: AssistantHistoryMessage, index: number): HTMLElement => {
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
      return bubble;
    }
    if (message.contextTruncated === true) {
      const notice = document.createElement('p');
      notice.className = 'lightink-reader-assistant-notice';
      notice.textContent = t('reader.assistant.truncated', {
        n: String(READER_LIMITS.maxAssistantContextChars),
      });
      bubble.appendChild(notice);
    }
    const text = document.createElement('p');
    text.className = 'lightink-reader-assistant-message-text';
    if (message.content === '' && message.error === undefined) {
      text.classList.add('is-streaming');
      text.textContent = streaming ? t('reader.assistant.streaming') : '';
    } else {
      text.textContent = message.content;
    }
    bubble.appendChild(text);
    if (message.error !== undefined && message.error !== '') {
      const error = document.createElement('p');
      error.className = 'lightink-reader-assistant-error';
      error.textContent = message.error;
      bubble.appendChild(error);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'lightink-reader-assistant-retry';
      retry.textContent = t('reader.lookup.retry');
      retry.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        retryAt(index);
      });
      bubble.appendChild(retry);
    } else if (savableAt(index)) {
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'lightink-reader-assistant-save';
      const saved = savedAnswers.has(message.createdAt);
      saveButton.disabled = saved;
      saveButton.textContent = saved ? t('reader.assistant.saved') : t('reader.assistant.saveAnnotation');
      saveButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (savedAnswers.has(message.createdAt)) {
          return;
        }
        savedAnswers.add(message.createdAt);
        saveButton.disabled = true;
        saveButton.textContent = t('reader.assistant.saved');
        deps.saveAnnotation(message.content.trim());
      });
      bubble.appendChild(saveButton);
    }
    return bubble;
  };

  const renderMessages = (): void => {
    streamingText = null;
    if (messages.length === 0) {
      messagesHost.replaceChildren();
      scrollMessagesBottom();
      return;
    }
    const nodes = messages.map((message, index) => renderMessage(message, index));
    messagesHost.replaceChildren(...nodes);
    const last = messages[messages.length - 1]!;
    if (streaming && last.role === 'assistant' && last.error === undefined) {
      streamingText =
        messagesHost.children[messagesHost.children.length - 1]?.querySelector(
          '.lightink-reader-assistant-message-text',
        ) ?? null;
    }
    scrollMessagesBottom();
  };

  const syncActionButtons = (): void => {
    const chapterAvailable = chapterContextOrNull() !== null;
    for (const [action, button] of actionButtons) {
      const noContext = action !== 'explain' && action !== 'summarize' && !chapterAvailable;
      button.disabled = streaming || noContext;
      button.title = noContext ? t('reader.assistant.noChapterContext') : '';
    }
  };

  const applyConfiguredView = (): void => {
    guide.hidden = aiConfigured;
    main.hidden = !aiConfigured;
    syncActionButtons();
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

  // —— 历史装载与持久化（按书哈希；重开续显） ——
  /** 交互代数：首个交换开始后，迟到的磁盘历史不再覆写内存对话。 */
  let historyEpoch = 0;
  let historyLoad: Promise<void> | null = null;

  const ensureHistory = (): Promise<void> => {
    const key = deps.historyKey?.() ?? null;
    const readHistory = deps.readHistory;
    if (key === null || readHistory === undefined) {
      return Promise.resolve();
    }
    if (loadedKey === key) {
      return historyLoad ?? Promise.resolve();
    }
    if (loadedKey !== null) {
      // 换书（触屏 replace-existing-reader 复用同一面板实例）：整会话复位，
      // 旧书对话不得残留展示、也不得经 persistHistory 写进新书的哈希文件。
      sessionGeneration += 1;
      streaming = false;
      streamingText = null;
      send.disabled = false;
      messages = [];
      savedAnswers.clear();
      historyEpoch = 0;
      renderMessages();
    }
    loadedKey = key;
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
      if (historyEpoch !== 0) {
        return; // 装载窗口内已有交互：内存对话优先于磁盘快照
      }
      messages = parseAssistantHistory(raw);
      savedAnswers.clear();
      renderMessages();
    })();
    return historyLoad;
  };

  const persistHistory = (): void => {
    const key = deps.historyKey?.() ?? null;
    if (key === null || deps.writeHistory === undefined) {
      return;
    }
    const json = serializeAssistantHistory(messages);
    void deps.writeHistory(key, json).catch(() => undefined);
  };

  // —— 流式请求 ——
  const runStream = async (targetIndex: number): Promise<void> => {
    const generation = sessionGeneration;
    const chapter = chapterContextOrNull();
    const clip = chapter === null ? null : clipAssistantContext(chapter.text);
    const context =
      chapter !== null && clip !== null && clip.text !== ''
        ? { title: chapter.title, text: clip.text }
        : null;
    const contextTruncated = clip?.truncated === true;
    const basePrompt = t('reader.assistant.systemPrompt');
    const systemPrompt = assistantSystemPrompt(basePrompt, context);
    const history = messages.slice(0, targetIndex);
    const onDelta = (delta: string): void => {
      if (disposed.value || generation !== sessionGeneration) {
        return;
      }
      const entry = messages[targetIndex];
      if (entry === undefined) {
        return;
      }
      const nextContent = entry.content + delta;
      messages[targetIndex] = { ...entry, content: nextContent };
      if (streamingText !== null) {
        streamingText.textContent = nextContent;
        streamingText.classList.remove('is-streaming');
        scrollMessagesBottom();
      }
    };
    streaming = true;
    syncActionButtons();
    send.disabled = true;
    renderMessages();
    try {
      await streamAssistantChat(buildAssistantChatRequest(systemPrompt, history), onDelta, streamDeps);
      const entry = messages[targetIndex];
      if (entry !== undefined && !disposed.value && generation === sessionGeneration) {
        messages[targetIndex] = { ...entry, error: undefined, contextTruncated };
      }
    } catch (error) {
      const entry = messages[targetIndex];
      if (entry !== undefined && !disposed.value && generation === sessionGeneration) {
        messages[targetIndex] = {
          ...entry,
          error: readerAiErrorMessage(t, error, aiMissing),
        };
      }
    } finally {
      if (generation === sessionGeneration) {
        streaming = false;
        streamingText = null;
        send.disabled = false;
        if (!disposed.value) {
          renderMessages();
          syncActionButtons();
          persistHistory();
        }
      }
    }
  };

  const appendExchange = (user: AssistantHistoryMessage): void => {
    if (streaming) {
      return;
    }
    historyEpoch += 1;
    const assistant: AssistantHistoryMessage = {
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    messages.push(user, assistant);
    void runStream(messages.length - 1);
  };

  /** 发起一轮提问；返回是否真的发出（流式中/空文本/未配置不发）。 */
  const ask = (content: string, action?: AssistantQuickAction): boolean => {
    const question = content.trim();
    if (question === '' || !aiConfigured || streaming) {
      return false;
    }
    appendExchange({ role: 'user', content: question, createdAt: Date.now(), action });
    return true;
  };

  /** 快捷动作：指令 +（选区动作）引文为用户消息；面板动作以当前章为上下文。 */
  const runQuickAction = (action: AssistantQuickAction, quote?: string): void => {
    if (!aiConfigured || streaming) {
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

  const retryAt = (index: number): void => {
    const entry = messages[index];
    if (entry === undefined || entry.role !== 'assistant' || streaming) {
      return;
    }
    historyEpoch += 1;
    messages[index] = { role: 'assistant', content: '', createdAt: entry.createdAt };
    void runStream(index);
  };

  // —— 输入 ——
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ask(input.value)) {
      input.value = ''; // 只在真正发出后清空（流式中保留草稿）
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (ask(input.value)) {
      input.value = '';
    }
  });

  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });
  clearHistoryButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // 清内存会话并作废在飞流式;磁盘清除幂等（失败不阻断,可再点）。
    sessionGeneration += 1;
    streaming = false;
    streamingText = null;
    send.disabled = false;
    messages = [];
    savedAnswers.clear();
    historyEpoch = 0;
    renderMessages();
    syncActionButtons();
    const key = deps.historyKey?.() ?? null;
    if (key !== null) {
      void deps.clearHistory?.(key).catch(() => undefined);
    }
  });
  settingsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openSettings();
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
    root.hidden = false;
    positionPanel();
    void ensureHistory();
    void refreshConfig();
    applyConfiguredView();
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

  void refreshConfig();

  return {
    element: root,
    open: openPanel,
    close: closePanel,
    isVisible: () => !root.hidden,
    askWithSelection(action, quote) {
      openPanel();
      // 先等本书历史落位再发起，避免装载竞态覆写刚开始的交换。
      void ensureHistory().then(() => {
        if (!disposed.value) {
          runQuickAction(action, quote);
        }
      });
    },
    destroy() {
      disposed.value = true;
      streaming = false;
      streamingText = null;
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
