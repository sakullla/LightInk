/**
 * `assistant-panel` — AI 助手面板（ADR-6 / R1）。
 *
 * 复用面板框架：桌面钉阅读区右侧（mountReaderOverlay + pinFixedOverlay），
 * 触屏是底部 sheet。对话编排（工具循环、停止、历史入口、Markdown）在本文件；
 * 历史 schema、请求分层、工具执行与消毒渲染分别交给 sibling 模块。
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
import {
  AssistantHistoryTooLargeError,
  activeAssistantConversation,
  createAssistantConversation,
  deleteAssistantConversation,
  emptyAssistantHistoryStore,
  parseAssistantHistoryStore,
  serializeAssistantHistoryStore,
  setAssistantConversationMessages,
  switchAssistantConversation,
  type AssistantConversation,
  type AssistantHistoryAction,
  type AssistantHistoryMessage,
  type AssistantHistoryStore,
} from './assistant-history.js';
import {
  createAssistantMarkdownStream,
  renderAssistantMarkdown,
} from './assistant-markdown.js';
import {
  buildAssistantChatRequest,
  type AssistantChapterSource,
  type AssistantChatMessage,
  type AssistantChatRequest,
  type AssistantContextKind,
  type AssistantRequestTurn,
  type AssistantToolCall,
} from './assistant-request.js';
import {
  QUERY_BOOK_TOOL_NAME,
  SAVE_TO_BOOK_TOOL_NAME,
  type AssistantToolSession,
} from './assistant-tools.js';

// ── 消息模型与常量 ───────────────────────────────────────────────────

/** 快捷动作（选区解释/总结由工具栏触发；其余是面板动作区按钮）。 */
export type AssistantQuickAction = AssistantHistoryAction;

/** 面板内动作区按钮（以当前章为上下文）。 */
export const ASSISTANT_PANEL_ACTIONS: readonly AssistantQuickAction[] = [
  'chapterSummary',
  'vocabulary',
  'quiz',
];

/** 同一条用户发送内的工具往返上限（ADR-2 / R6）。 */
export const ASSISTANT_MAX_TOOL_ROUNDS = 24;

export type { AssistantHistoryMessage };

interface AssistantToolBlock {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly result?: string;
}

interface PanelMessage extends AssistantHistoryMessage {
  readonly toolBlocks?: readonly AssistantToolBlock[];
  readonly toolLimitReached?: boolean;
}

/** `ai_chat_stream` 经 Channel 推送的事件（snake_case tag 与 ai.rs 钉死）。 */
export interface AiStreamEventView {
  readonly type: 'delta' | 'tool_call';
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

/** `ai_chat_stream` 的返回终态。 */
export interface AiStreamDoneView {
  readonly finish: string;
  readonly totalChars: number;
  readonly toolCalls: readonly AssistantToolCall[];
}

// ── 纯函数：上下文截断 / 快捷动作文案 ────────────────────────────────

export interface AssistantContextClip {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * 章节/选区截断：超限保留前部；在代理对边界处回退一字，不产生半个字符。
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

function persistableMessages(list: readonly PanelMessage[]): AssistantHistoryMessage[] {
  return list.map((message) => {
    const entry: AssistantHistoryMessage = {
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    };
    return {
      ...entry,
      ...(message.action !== undefined ? { action: message.action } : {}),
      ...(message.contextTruncated === true ? { contextTruncated: true } : {}),
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
  });
}

/**
 * 加载完成时内存店可能已有本轮会话：用磁盘店补齐兄弟段，活动段以内存为准，
 * 避免 persistHistory 把尚未合并的空店写回、冲掉其它会话。
 */
function mergeLoadedHistoryWithMemory(
  loaded: AssistantHistoryStore,
  memory: AssistantHistoryStore,
): AssistantHistoryStore {
  if (memory.conversations.length === 0) {
    return loaded;
  }
  if (loaded.conversations.length === 0) {
    return memory;
  }
  const memoryById = new Map(memory.conversations.map((conversation) => [conversation.id, conversation]));
  const seen = new Set<string>();
  const conversations: AssistantConversation[] = [];
  for (const conversation of loaded.conversations) {
    conversations.push(memoryById.get(conversation.id) ?? conversation);
    seen.add(conversation.id);
  }
  for (const conversation of memory.conversations) {
    if (!seen.has(conversation.id)) {
      conversations.push(conversation);
      seen.add(conversation.id);
    }
  }
  const activeId =
    memory.activeId !== '' && seen.has(memory.activeId)
      ? memory.activeId
      : loaded.activeId !== '' && seen.has(loaded.activeId)
        ? loaded.activeId
        : (conversations[conversations.length - 1]?.id ?? '');
  return { version: 2, activeId, conversations };
}

function historyTurns(list: readonly PanelMessage[], end: number): AssistantRequestTurn[] {
  const turns: AssistantRequestTurn[] = [];
  for (let index = 0; index < end; index += 1) {
    const message = list[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === 'user') {
      turns.push({ role: 'user', content: message.content });
      continue;
    }
    const blocks = message.toolBlocks ?? [];
    if (blocks.length > 0) {
      turns.push({
        role: 'assistant',
        content: '',
        toolCalls: blocks.map((block) => ({
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        })),
      });
      for (const block of blocks) {
        turns.push({
          role: 'tool',
          content: block.result ?? '',
          toolCallId: block.id,
          name: block.name,
        });
      }
    }
    if (message.content.trim() === '') {
      continue;
    }
    turns.push({ role: 'assistant', content: message.content });
  }
  return turns;
}

function serializeChatMessage(message: AssistantChatMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.name !== undefined ? { name: message.name } : {}),
    ...(message.toolCalls !== undefined && message.toolCalls.length > 0
      ? { toolCalls: message.toolCalls }
      : {}),
  };
}

function locatorTarget(
  chapterRaw: string | undefined,
  pageRaw: string | undefined,
): { chapter?: number; page?: number } {
  const target: { chapter?: number; page?: number } = {};
  if (chapterRaw !== undefined && chapterRaw !== '') {
    const chapter = Number(chapterRaw);
    if (Number.isFinite(chapter)) {
      target.chapter = Math.trunc(chapter);
    }
  }
  if (pageRaw !== undefined && pageRaw !== '') {
    const page = Number(pageRaw);
    if (Number.isFinite(page)) {
      target.page = Math.trunc(page);
    }
  }
  return target;
}

function dropAssistantChannel<T>(channel: AssistantChannel<T>): void {
  channel.onmessage = () => undefined;
  const record = channel as unknown as { cleanupCallback?: () => void };
  try {
    record.cleanupCallback?.();
  } catch {
    // Channel 已关闭时忽略。
  }
}

function isAbortError(error: unknown): boolean {
  const code =
    error !== null && typeof error === 'object'
      ? String((error as { code?: unknown }).code ?? (error as { message?: unknown }).message ?? '')
      : String(error);
  return code.includes('AI_STREAM_ABORTED');
}

// ── 流式通道（Tauri IPC Channel；注入面供测试） ──────────────────────

export type AssistantInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AssistantChannel<T> {
  onmessage: (message: T) => void;
}

export interface AssistantStreamDeps {
  readonly invoke?: AssistantInvoke;
  readonly createChannel?: <T>() => AssistantChannel<T>;
  readonly onStart?: (abort: () => void) => void;
}

const defaultAssistantInvoke: AssistantInvoke = (command, args) =>
  invoke(command, args as Parameters<typeof invoke>[1]);

function defaultCreateChannel<T>(): AssistantChannel<T> {
  return new Channel<T>() as AssistantChannel<T>;
}

/**
 * 流式一轮模型 IO：invoke 携带 `Channel`，delta / tool_call 增量回调；
 * 终态由命令返回值承载。停止时丢掉 Channel，Rust 侧得到 AI_STREAM_ABORTED。
 */
export async function streamAssistantChat(
  request: Pick<AssistantChatRequest, 'messages' | 'tools'>,
  onDelta: (delta: string) => void,
  deps: AssistantStreamDeps = {},
): Promise<AiStreamDoneView> {
  const invokeFn = deps.invoke ?? defaultAssistantInvoke;
  const createChannel = deps.createChannel ?? defaultCreateChannel;
  const channel = createChannel<AiStreamEventView>();
  const collected = new Map<string, AssistantToolCall>();
  let dropped = false;
  const abort = (): void => {
    if (dropped) {
      return;
    }
    dropped = true;
    dropAssistantChannel(channel);
  };
  deps.onStart?.(abort);
  channel.onmessage = (event) => {
    if (dropped || event === null || typeof event !== 'object') {
      return;
    }
    if (event.type === 'delta') {
      if (typeof event.text === 'string' && event.text !== '') {
        onDelta(event.text);
      }
      return;
    }
    if (event.type === 'tool_call' && typeof event.id === 'string' && typeof event.name === 'string') {
      collected.set(event.id, {
        id: event.id,
        name: event.name,
        arguments: typeof event.arguments === 'string' ? event.arguments : '',
      });
    }
  };
  try {
    const done = await invokeFn('ai_chat_stream', {
      messages: request.messages.map(serializeChatMessage),
      tools: request.tools,
      onEvent: channel,
    });
    const toolCalls: AssistantToolCall[] = [];
    let finish = 'closed';
    let totalChars = 0;
    if (done !== null && typeof done === 'object') {
      const obj = done as {
        finish?: unknown;
        totalChars?: unknown;
        toolCalls?: unknown;
      };
      finish = typeof obj.finish === 'string' ? obj.finish : 'closed';
      totalChars = typeof obj.totalChars === 'number' ? obj.totalChars : 0;
      if (Array.isArray(obj.toolCalls)) {
        for (const item of obj.toolCalls) {
          if (item === null || typeof item !== 'object') {
            continue;
          }
          const call = item as { id?: unknown; name?: unknown; arguments?: unknown };
          if (typeof call.id !== 'string' || typeof call.name !== 'string') {
            continue;
          }
          collected.set(call.id, {
            id: call.id,
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : '',
          });
        }
      }
    }
    for (const call of collected.values()) {
      toolCalls.push(call);
    }
    return { finish, totalChars, toolCalls };
  } finally {
    dropped = true;
  }
}

async function executeToolCalls(
  session: AssistantToolSession,
  calls: readonly AssistantToolCall[],
): Promise<readonly AssistantToolBlock[]> {
  const results = new Map<string, string>();
  const queries = calls.filter((call) => call.name === QUERY_BOOK_TOOL_NAME);
  const rest = calls.filter((call) => call.name !== QUERY_BOOK_TOOL_NAME);
  await Promise.all(
    queries.map(async (call) => {
      const result = await session.execute(call.name, call.arguments);
      results.set(call.id, JSON.stringify(result));
    }),
  );
  for (const call of rest) {
    const result = await session.execute(call.name, call.arguments);
    results.set(call.id, JSON.stringify(result));
  }
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    result: results.get(call.id) ?? JSON.stringify({ ok: false, error: 'missing_result' }),
  }));
}

// ── 面板组件 ─────────────────────────────────────────────────────────

/** 章节上下文供数（wiring 实现：flow 章全文 / PDF 当前页文本层 / cbz null）。 */
export interface AssistantChapterContext {
  readonly kind?: AssistantContextKind;
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
  /** 阅读器当前选区（引用选区 / 工具 selection）。 */
  currentSelection?: () => string;
  /** PDF 当前页码，只写入本轮用户消息。 */
  currentPage?: () => number | undefined;
  /** 前端工具循环的执行会话；缺省则 tool_call 回失败结果。 */
  createToolSession?: () => AssistantToolSession;
  /** 回答中的章节/页码定位点击（用户操作，不由工具翻页）。 */
  jumpToLocator?: (target: { chapter?: number; page?: number }) => void;
  /** 助手 Markdown 外链（沿用应用外部打开策略）。 */
  openExternalLink?: (href: string) => void;
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

function toolLabelKey(name: string): MessageKey {
  if (name === QUERY_BOOK_TOOL_NAME) {
    return 'reader.assistant.toolQuery';
  }
  if (name === SAVE_TO_BOOK_TOOL_NAME) {
    return 'reader.assistant.toolSave';
  }
  return 'reader.assistant.toolUnknown';
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
  const historyToggle = document.createElement('button');
  historyToggle.type = 'button';
  historyToggle.className = 'lightink-reader-assistant-history-toggle';
  historyToggle.textContent = t('reader.assistant.history');
  historyToggle.setAttribute('title', t('reader.assistant.history'));
  historyToggle.setAttribute('aria-expanded', 'false');
  head.append(title, historyToggle, close);

  const historyPane = document.createElement('div');
  historyPane.className = 'lightink-reader-assistant-history';
  historyPane.hidden = true;
  const historyNew = document.createElement('button');
  historyNew.type = 'button';
  historyNew.className = 'lightink-reader-assistant-history-new';
  historyNew.dataset.assistantHistoryNew = 'true';
  historyNew.textContent = t('reader.assistant.historyNew');
  const historyEmpty = document.createElement('p');
  historyEmpty.className = 'lightink-reader-assistant-history-empty';
  historyEmpty.textContent = t('reader.assistant.historyEmpty');
  const historyList = document.createElement('ul');
  historyList.className = 'lightink-reader-assistant-history-list';
  historyPane.append(historyNew, historyEmpty, historyList);

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

  const main = document.createElement('div');
  main.className = 'lightink-reader-assistant-main';
  const contextHint = document.createElement('p');
  contextHint.className = 'lightink-reader-assistant-context';
  const messagesWrap = document.createElement('div');
  messagesWrap.className = 'lightink-reader-assistant-messages-wrap';
  const messagesHost = document.createElement('div');
  messagesHost.className = 'lightink-reader-assistant-messages';
  messagesHost.setAttribute('aria-live', 'polite');
  messagesHost.setAttribute('aria-label', t('reader.assistant.title'));
  const jumpBottom = document.createElement('button');
  jumpBottom.type = 'button';
  jumpBottom.className = 'lightink-reader-assistant-jump-bottom';
  jumpBottom.dataset.assistantJumpBottom = 'true';
  jumpBottom.textContent = t('reader.assistant.jumpBottom');
  jumpBottom.hidden = true;
  messagesWrap.append(messagesHost, jumpBottom);

  const persistNotice = document.createElement('p');
  persistNotice.className = 'lightink-reader-assistant-notice';
  persistNotice.hidden = true;

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
  const composerTools = document.createElement('div');
  composerTools.className = 'lightink-reader-assistant-composer-tools';
  const quoteButton = document.createElement('button');
  quoteButton.type = 'button';
  quoteButton.className = 'lightink-reader-assistant-quote';
  quoteButton.dataset.assistantQuote = 'true';
  quoteButton.textContent = t('reader.assistant.quote');
  const composerHint = document.createElement('p');
  composerHint.className = 'lightink-reader-assistant-composer-hint';
  composerHint.textContent = t('reader.assistant.composerHint');
  composerTools.append(quoteButton, composerHint);
  const composerRow = document.createElement('div');
  composerRow.className = 'lightink-reader-assistant-composer-row';
  const input = document.createElement('textarea');
  input.className = 'lightink-reader-assistant-input';
  input.rows = 4;
  input.setAttribute('placeholder', t('reader.assistant.placeholder'));
  input.setAttribute('aria-label', t('reader.assistant.placeholder'));
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'lightink-reader-assistant-send';
  send.textContent = t('reader.assistant.send');
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'lightink-reader-assistant-stop';
  stop.dataset.assistantStop = 'true';
  stop.textContent = t('reader.assistant.stop');
  stop.disabled = true;
  composerRow.append(input, send, stop);
  composer.append(composerTools, composerRow);
  main.append(contextHint, messagesWrap, persistNotice, actions, composer);
  root.append(head, historyPane, guide, main);

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

  let messages: PanelMessage[] = [];
  let store: AssistantHistoryStore = emptyAssistantHistoryStore();
  let streaming = false;
  let stopRequested = false;
  let abortActive: (() => void) | null = null;
  let loadedKey: string | null = null;
  let sessionGeneration = 0;
  let aiConfigured = false;
  let aiMissing: readonly string[] = [];
  const savedAnswers = new Set<number>();
  let streamingText: HTMLElement | null = null;
  let markdownStream = createAssistantMarkdownStream();
  let stickToBottom = true;
  let persistError: string | null = null;

  const chapterContextOrNull = (): AssistantChapterContext | null => {
    try {
      return deps.chapterContext();
    } catch {
      return null;
    }
  };

  const chapterSource = (): AssistantChapterSource | null => {
    const chapter = chapterContextOrNull();
    if (chapter === null) {
      return null;
    }
    return {
      kind: chapter.kind ?? 'flow',
      title: chapter.title,
      text: chapter.text,
    };
  };

  const currentSelectionText = (): string => {
    try {
      return (deps.currentSelection?.() ?? '').trim();
    } catch {
      return '';
    }
  };

  const currentPageNumber = (): number | undefined => {
    const source = chapterSource();
    if (source?.kind !== 'pdf') {
      return undefined;
    }
    try {
      const page = deps.currentPage?.();
      return typeof page === 'number' && Number.isFinite(page) && page > 0 ? Math.trunc(page) : undefined;
    } catch {
      return undefined;
    }
  };

  const resizeInput = (): void => {
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  };

  const updateStickFromScroll = (): void => {
    const slack = 48;
    stickToBottom =
      messagesHost.scrollHeight - messagesHost.scrollTop - messagesHost.clientHeight <= slack;
    jumpBottom.hidden = stickToBottom;
  };

  const scrollMessagesBottom = (force = false): void => {
    if (!force && !stickToBottom) {
      jumpBottom.hidden = false;
      return;
    }
    messagesHost.scrollTop = messagesHost.scrollHeight;
    stickToBottom = true;
    jumpBottom.hidden = true;
  };

  const savableAt = (index: number): boolean =>
    messages[index] !== undefined &&
    messages[index]!.role === 'assistant' &&
    messages[index]!.content.trim() !== '' &&
    messages[index]!.error === undefined &&
    messages[index - 1]?.action === 'chapterSummary';

  const renderToolBlock = (block: AssistantToolBlock): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'lightink-reader-assistant-tool';
    el.dataset.tool = block.name;
    const name = document.createElement('div');
    name.className = 'lightink-reader-assistant-tool-name';
    name.textContent = t(toolLabelKey(block.name));
    const body = document.createElement('pre');
    body.className = 'lightink-reader-assistant-tool-body';
    const parts = [block.arguments];
    if (block.result !== undefined && block.result !== '') {
      parts.push(block.result);
    }
    body.textContent = parts.filter((part) => part !== '').join('\n');
    el.append(name, body);
    return el;
  };

  const renderMessage = (message: PanelMessage, index: number): HTMLElement => {
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
    for (const block of message.toolBlocks ?? []) {
      bubble.appendChild(renderToolBlock(block));
    }
    if (message.contextTruncated === true) {
      const notice = document.createElement('p');
      notice.className = 'lightink-reader-assistant-notice';
      notice.textContent = t('reader.assistant.truncated', {
        n: String(READER_LIMITS.maxAssistantContextChars),
      });
      bubble.appendChild(notice);
    }
    if (message.toolLimitReached === true) {
      const notice = document.createElement('p');
      notice.className = 'lightink-reader-assistant-notice';
      notice.dataset.assistantToolLimit = 'true';
      notice.textContent = t('reader.assistant.maxToolRounds', {
        n: String(ASSISTANT_MAX_TOOL_ROUNDS),
      });
      bubble.appendChild(notice);
    }
    const text = document.createElement('div');
    text.className = 'lightink-reader-assistant-message-text';
    if (message.content === '' && message.error === undefined) {
      text.classList.add('is-streaming');
      text.textContent = streaming ? t('reader.assistant.streaming') : '';
    } else if (message.content !== '') {
      text.innerHTML = renderAssistantMarkdown(message.content);
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
      scrollMessagesBottom(true);
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

  const renderHistoryList = (): void => {
    const conversations = store.conversations;
    historyEmpty.hidden = conversations.length > 0;
    historyList.replaceChildren();
    for (const conversation of conversations) {
      const item = document.createElement('li');
      item.className = 'lightink-reader-assistant-history-item';
      item.dataset.assistantHistoryId = conversation.id;
      if (conversation.id === store.activeId) {
        item.classList.add('is-active');
      }
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'lightink-reader-assistant-history-open';
      openButton.textContent =
        conversation.title.trim() === '' ? t('reader.assistant.untitled') : conversation.title;
      openButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        switchConversation(conversation.id);
      });
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'lightink-reader-assistant-history-delete';
      deleteButton.dataset.assistantHistoryDelete = conversation.id;
      deleteButton.textContent = '×';
      deleteButton.setAttribute('aria-label', t('reader.assistant.historyDelete'));
      deleteButton.setAttribute('title', t('reader.assistant.historyDelete'));
      deleteButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeConversation(conversation.id);
      });
      item.append(openButton, deleteButton);
      historyList.appendChild(item);
    }
  };

  const syncQuoteButton = (): void => {
    // 选区来自阅读器 pendingSelection，开面板时的快照会过期；按钮保持可点，
    // 是否插入在 click 时用 live currentSelectionText() 决定。
    const quote = currentSelectionText();
    quoteButton.disabled = false;
    quoteButton.title = quote === '' ? t('reader.assistant.quoteUnavailable') : t('reader.assistant.quote');
  };

  const onSelectionChange = (): void => {
    if (disposed.value || root.hidden) {
      return;
    }
    syncQuoteButton();
    syncContextHint();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('selectionchange', onSelectionChange);
  }
  quoteButton.addEventListener('pointerenter', () => {
    syncQuoteButton();
  });

  const syncContextHint = (): void => {
    const chapter = chapterContextOrNull();
    const parts: string[] = [];
    if (chapter !== null && (chapter.title.trim() !== '' || chapter.text.trim() !== '')) {
      const label = chapter.title.trim();
      if (label !== '') {
        parts.push(label);
      }
      const clipped = clipAssistantContext(chapter.text);
      if (clipped.truncated) {
        parts.push(
          t('reader.assistant.truncated', { n: String(READER_LIMITS.maxAssistantContextChars) }),
        );
      }
    }
    if (currentSelectionText() !== '') {
      parts.push(t('reader.assistant.contextSelection'));
    }
    contextHint.hidden = parts.length === 0;
    contextHint.textContent = parts.join(' · ');
  };

  const syncComposer = (): void => {
    send.disabled = streaming;
    stop.disabled = !streaming;
    syncQuoteButton();
    syncActionButtons();
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
    historyToggle.hidden = !aiConfigured;
    if (!aiConfigured) {
      historyPane.hidden = true;
      historyToggle.setAttribute('aria-expanded', 'false');
    }
    syncComposer();
    syncContextHint();
  };

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

  let historyEpoch = 0;
  let historyLoad: Promise<void> | null = null;

  const loadActiveMessages = (): void => {
    const active = activeAssistantConversation(store);
    messages = active === null ? [] : active.messages.map((message) => ({ ...message }));
    savedAnswers.clear();
    persistError = null;
    persistNotice.hidden = true;
    renderMessages();
    renderHistoryList();
  };

  const persistHistory = (): void => {
    persistNotice.hidden = persistError === null;
    if (persistError !== null) {
      persistNotice.textContent = persistError;
    }
    const key = deps.historyKey?.() ?? null;
    if (key === null || deps.writeHistory === undefined) {
      return;
    }
    if (store.activeId === '' && messages.length === 0) {
      return;
    }
    if (store.activeId === '') {
      store = createAssistantConversation(store);
    }
    store = setAssistantConversationMessages(store, store.activeId, persistableMessages(messages));
    renderHistoryList();
    try {
      const json = serializeAssistantHistoryStore(store);
      persistError = null;
      persistNotice.hidden = true;
      void deps.writeHistory(key, json).catch(() => undefined);
    } catch (error) {
      if (error instanceof AssistantHistoryTooLargeError) {
        persistError = t('reader.assistant.historyTooLarge');
        persistNotice.hidden = false;
        persistNotice.textContent = persistError;
      }
    }
  };

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
      sessionGeneration += 1;
      streaming = false;
      stopRequested = true;
      abortActive?.();
      abortActive = null;
      streamingText = null;
      store = emptyAssistantHistoryStore();
      messages = [];
      savedAnswers.clear();
      historyEpoch = 0;
      renderMessages();
      renderHistoryList();
      syncComposer();
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
      const loaded = parseAssistantHistoryStore(raw);
      if (historyEpoch !== 0 || store.conversations.length > 0 || messages.length > 0) {
        store = mergeLoadedHistoryWithMemory(loaded, store);
        renderHistoryList();
        persistHistory();
        return;
      }
      store = loaded;
      loadActiveMessages();
    })();
    return historyLoad;
  };

  const ensureActiveConversation = (): void => {
    if (activeAssistantConversation(store) !== null) {
      return;
    }
    store = createAssistantConversation(store);
    renderHistoryList();
  };

  const abortStream = (): void => {
    stopRequested = true;
    abortActive?.();
  };

  const runStream = async (targetIndex: number): Promise<void> => {
    const generation = sessionGeneration;
    const user = messages[targetIndex - 1];
    const userMessage = user?.role === 'user' ? user.content : '';
    const prior = historyTurns(messages, Math.max(0, targetIndex - 1));
    const loopTurns: AssistantRequestTurn[] = [];
    const toolBlocks: AssistantToolBlock[] = [];
    markdownStream = createAssistantMarkdownStream();
    let visible = '';
    let contextTruncated = false;
    let toolLimitReached = false;
    const session = deps.createToolSession?.() ?? null;
    let toolRoundTrips = 0;

    const onDelta = (delta: string): void => {
      if (disposed.value || generation !== sessionGeneration) {
        return;
      }
      const entry = messages[targetIndex];
      if (entry === undefined) {
        return;
      }
      visible += delta;
      const html = markdownStream.append(delta);
      messages[targetIndex] = {
        ...entry,
        content: visible,
        toolBlocks: toolBlocks.slice(),
      };
      if (streamingText !== null) {
        streamingText.innerHTML = html;
        streamingText.classList.remove('is-streaming');
        scrollMessagesBottom();
      }
    };

    streaming = true;
    stopRequested = false;
    syncComposer();
    renderMessages();
    try {
      while (!disposed.value && generation === sessionGeneration && !stopRequested) {
        if (toolRoundTrips >= ASSISTANT_MAX_TOOL_ROUNDS) {
          toolLimitReached = true;
          break;
        }
        const request = buildAssistantChatRequest({
          systemPrompt: t('reader.assistant.systemPrompt'),
          chapter: chapterSource(),
          history: [...prior, ...loopTurns],
          userMessage,
          page: currentPageNumber(),
        });
        contextTruncated = request.truncated;
        const done = await streamAssistantChat(
          request,
          onDelta,
          {
            ...streamDeps,
            onStart: (abort) => {
              abortActive = abort;
              streamDeps.onStart?.(abort);
            },
          },
        );
        abortActive = null;
        if (disposed.value || generation !== sessionGeneration || stopRequested) {
          break;
        }
        const calls = done.toolCalls;
        if (calls.length === 0) {
          break;
        }
        if (toolRoundTrips >= ASSISTANT_MAX_TOOL_ROUNDS) {
          toolLimitReached = true;
          break;
        }
        loopTurns.push({
          role: 'assistant',
          content: '',
          toolCalls: calls,
        });
        const executed =
          session === null
            ? calls.map((call) => ({
                id: call.id,
                name: call.name,
                arguments: call.arguments,
                result: JSON.stringify({
                  ok: false,
                  error: 'tools_unavailable',
                  message: '工具执行不可用。',
                }),
              }))
            : await executeToolCalls(session, calls);
        if (disposed.value || generation !== sessionGeneration || stopRequested) {
          break;
        }
        for (const block of executed) {
          toolBlocks.push(block);
          loopTurns.push({
            role: 'tool',
            content: block.result ?? '',
            toolCallId: block.id,
            name: block.name,
          });
        }
        const entry = messages[targetIndex];
        if (entry !== undefined) {
          messages[targetIndex] = { ...entry, toolBlocks: toolBlocks.slice(), content: visible };
          renderMessages();
        }
        toolRoundTrips += 1;
      }
      const entry = messages[targetIndex];
      if (entry !== undefined && !disposed.value && generation === sessionGeneration) {
        const stopped = stopRequested;
        messages[targetIndex] = {
          ...entry,
          content: visible,
          toolBlocks: toolBlocks.slice(),
          contextTruncated,
          toolLimitReached,
          ...(stopped ? { error: t('reader.assistant.stopped') } : { error: undefined }),
        };
      }
    } catch (error) {
      const entry = messages[targetIndex];
      if (entry !== undefined && !disposed.value && generation === sessionGeneration) {
        messages[targetIndex] = {
          ...entry,
          content: visible,
          toolBlocks: toolBlocks.slice(),
          contextTruncated,
          toolLimitReached,
          error: stopRequested || isAbortError(error)
            ? t('reader.assistant.stopped')
            : readerAiErrorMessage(t, error, aiMissing),
        };
      }
    } finally {
      if (generation === sessionGeneration) {
        streaming = false;
        abortActive = null;
        streamingText = null;
        if (!disposed.value) {
          renderMessages();
          syncComposer();
          persistHistory();
        }
      }
    }
  };

  const appendExchange = (user: PanelMessage): void => {
    if (streaming) {
      return;
    }
    historyEpoch += 1;
    ensureActiveConversation();
    const assistant: PanelMessage = {
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    messages.push(user, assistant);
    void runStream(messages.length - 1);
  };

  let sendGate = false;

  const ask = (content: string, action?: AssistantQuickAction): boolean => {
    const question = content.trim();
    if (question === '' || !aiConfigured || streaming || sendGate) {
      return false;
    }
    sendGate = true;
    void (async () => {
      try {
        await ensureHistory();
        if (disposed.value || !aiConfigured || streaming) {
          return;
        }
        appendExchange({ role: 'user', content: question, createdAt: Date.now(), action });
      } finally {
        sendGate = false;
      }
    })();
    return true;
  };

  const runQuickAction = (action: AssistantQuickAction, quote?: string): void => {
    if (!aiConfigured || streaming || sendGate) {
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
    if (entry === undefined || entry.role !== 'assistant' || streaming || sendGate) {
      return;
    }
    sendGate = true;
    void (async () => {
      try {
        await ensureHistory();
        if (disposed.value || streaming) {
          return;
        }
        const current = messages[index];
        if (current === undefined || current.role !== 'assistant') {
          return;
        }
        historyEpoch += 1;
        messages[index] = { role: 'assistant', content: '', createdAt: current.createdAt };
        void runStream(index);
      } finally {
        sendGate = false;
      }
    })();
  };

  const switchConversation = (id: string): void => {
    if (id === store.activeId) {
      historyPane.hidden = true;
      historyToggle.setAttribute('aria-expanded', 'false');
      return;
    }
    if (streaming) {
      abortStream();
    }
    store = setAssistantConversationMessages(store, store.activeId, persistableMessages(messages));
    store = switchAssistantConversation(store, id);
    loadActiveMessages();
    persistHistory();
    historyPane.hidden = true;
    historyToggle.setAttribute('aria-expanded', 'false');
  };

  const removeConversation = (id: string): void => {
    if (streaming && id === store.activeId) {
      abortStream();
    }
    if (id === store.activeId) {
      store = setAssistantConversationMessages(store, id, persistableMessages(messages));
    }
    store = deleteAssistantConversation(store, id);
    loadActiveMessages();
    persistHistory();
  };

  const startNewConversation = (): void => {
    if (streaming) {
      abortStream();
    }
    void ensureHistory().then(() => {
      if (disposed.value) {
        return;
      }
      if (streaming) {
        abortStream();
      }
      if (store.activeId !== '') {
        store = setAssistantConversationMessages(store, store.activeId, persistableMessages(messages));
      }
      store = createAssistantConversation(store);
      loadActiveMessages();
      persistHistory();
    });
  };

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (ask(input.value)) {
      input.value = '';
      resizeInput();
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
      resizeInput();
    }
  });
  input.addEventListener('input', () => {
    resizeInput();
  });
  quoteButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const quote = currentSelectionText();
    syncQuoteButton();
    if (quote === '') {
      return;
    }
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const pad = before === '' || before.endsWith('\n') ? '' : '\n';
    input.value = `${before}${pad}${quote}${after}`;
    resizeInput();
    input.focus();
  });
  stop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!streaming) {
      return;
    }
    abortStream();
  });
  jumpBottom.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    stickToBottom = true;
    scrollMessagesBottom(true);
  });
  messagesHost.addEventListener('scroll', () => {
    updateStickFromScroll();
  });
  messagesHost.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const locator = target.closest('a[data-chapter], a[data-page]');
    if (locator instanceof HTMLAnchorElement) {
      event.preventDefault();
      event.stopPropagation();
      deps.jumpToLocator?.(locatorTarget(locator.dataset.chapter, locator.dataset.page));
      return;
    }
    const link = target.closest('a[href]');
    if (link instanceof HTMLAnchorElement && /^(https?:)/i.test(link.getAttribute('href') ?? '')) {
      event.preventDefault();
      event.stopPropagation();
      deps.openExternalLink?.(link.href);
    }
  });

  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  });
  historyToggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = historyPane.hidden;
    historyPane.hidden = !next;
    historyToggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      renderHistoryList();
    }
  });
  historyNew.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    startNewConversation();
  });
  settingsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openSettings();
  });

  const positionPanel = (): void => {
    const host = deps.host();
    mountReaderOverlay(root, host);
    adoptReaderOverlayTheme(root, host);
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
    renderHistoryList();
    resizeInput();
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
    historyPane.hidden = true;
    historyToggle.setAttribute('aria-expanded', 'false');
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
      void ensureHistory().then(() => {
        if (!disposed.value) {
          runQuickAction(action, quote);
        }
      });
    },
    destroy() {
      disposed.value = true;
      streaming = false;
      stopRequested = true;
      abortActive?.();
      abortActive = null;
      streamingText = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener(READER_AI_CONFIGURED_EVENT, onAiConfiguredEvent);
        document.removeEventListener('selectionchange', onSelectionChange);
      }
      delete root.dataset.open;
      root.hidden = true;
      unpinFixedOverlay(root);
      root.remove();
    },
  };
}
