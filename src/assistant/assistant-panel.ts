/**
 * `assistant-panel` — surface 无关的 AI 助手面板核心（ADR-3 / R3）。
 *
 * 面板生命周期、流式、工具循环、历史装载与待确认列表都在本文件；surface
 * 适配（portal 宿主、钉位、触屏 sheet 策略）全部经 `AssistantPanelDeps.surface`
 * 注入，core 不持有阅读器实例。历史 schema、请求分层、工具执行与消毒渲染
 * 分别交给 sibling 模块；错误/配置单点在 `assistant-error`。
 */

import './assistant-panel.css';

import { Channel, invoke } from '@tauri-apps/api/core';
import type { MessageKey } from '../i18n/messages.js';
import { concealSheet, revealSheet } from '../ui/touch/sheet-transition.js';
import { READER_LIMITS } from '../reader/reader-limits.js';
import {
  ASSISTANT_AI_CONFIGURED_EVENT,
  assistantAiErrorMessage,
  invokeAiTranslateConfig,
  type AiTranslateConfig,
} from './assistant-error.js';
import {
  AssistantHistoryTooLargeError,
  activeAssistantConversation,
  assistantConversationTitle,
  createAssistantConversation,
  deleteAssistantConversation,
  emptyAssistantHistoryStore,
  formatAssistantConversationTime,
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
  type AssistantPendingConfirmation,
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

const SELECTION_WRAP = /<selection>\s*([\s\S]*?)\s*<\/selection>/;

export function splitQuotedUserContent(content: string): { quote: string; body: string } {
  const match = SELECTION_WRAP.exec(content);
  if (match === null || match[1] === undefined) {
    return { quote: '', body: content };
  }
  const quote = match[1].trim();
  const body = `${content.slice(0, match.index)}${content.slice(match.index + match[0].length)}`.trim();
  return { quote, body };
}

export function composeQuotedUserContent(quote: string, question: string): string {
  const sel = quote.trim();
  const body = question.trim();
  if (sel === '') {
    return body;
  }
  const wrapped = `<selection>\n${sel}\n</selection>`;
  return body === '' ? wrapped : `${wrapped}\n${body}`;
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
  titleRaw?: string,
): { chapter?: number; page?: number; title?: string } {
  const target: { chapter?: number; page?: number; title?: string } = {};
  if (chapterRaw !== undefined && chapterRaw !== '') {
    const chapter = Number(chapterRaw);
    if (Number.isFinite(chapter)) {
      target.chapter = Math.trunc(chapter);
    } else {
      target.title = chapterRaw.trim();
    }
  }
  if (pageRaw !== undefined && pageRaw !== '') {
    const page = Number(pageRaw);
    if (Number.isFinite(page)) {
      target.page = Math.trunc(page);
    }
  }
  const title = titleRaw?.trim();
  if (title !== undefined && title !== '') {
    target.title = target.title ?? title;
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

// ── Surface 缺省与待确认结果解析 ─────────────────────────────────────

/** 缺省触屏判定：与 CSS 触屏门控同一组 `<html>` 属性。 */
function defaultAssistantTouchMode(): boolean {
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl === null || typeof rootEl.hasAttribute !== 'function') {
    return false;
  }
  return rootEl.hasAttribute('data-android') || rootEl.hasAttribute('data-touch-primary');
}

/** 缺省 portal 挂载：body 直挂（宿主钩子通常覆盖为带主题采纳的挂载）。 */
function defaultAssistantMount(panel: HTMLElement, host: HTMLElement): void {
  const layer =
    host.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null);
  if (layer !== null && panel.parentNode !== layer) {
    layer.appendChild(panel);
  }
}

/** 从工具结果 JSON 提取待确认写操作；坏形态忽略，不抛出。 */
export function parseAssistantPendingConfirmations(
  result: string | undefined,
): readonly AssistantPendingConfirmation[] {
  if (result === undefined || result === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') {
    return [];
  }
  const raw = (parsed as { pending_confirmation?: unknown }).pending_confirmation;
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: AssistantPendingConfirmation[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const obj = entry as { id?: unknown; summary?: unknown; tool?: unknown; arguments?: unknown };
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (typeof obj.summary !== 'string' || obj.summary.trim() === '') continue;
    if (typeof obj.tool !== 'string' || obj.tool === '') continue;
    items.push({
      id: obj.id,
      summary: obj.summary.trim(),
      tool: obj.tool,
      arguments: obj.arguments,
    });
  }
  return items;
}

/** 待确认条目：确认后沿用产生建议的同一 `session.execute` 落盘。 */
interface PendingConfirmationEntry {
  readonly key: string;
  readonly item: AssistantPendingConfirmation;
  readonly session: AssistantToolSession;
  status: 'pending' | 'confirmed' | 'rejected';
  error?: string;
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

/**
 * Surface 适配注入面：portal 宿主层、桌面钉位与触屏 sheet 策略都由宿主提供，
 * core 只按钩子调用。缺省挂到 host 所在 document.body、不钉位、触屏判定读
 * `<html>` 的 `data-android` / `data-touch-primary`（与 CSS 触屏门控同源）。
 */
export interface AssistantSurfaceDeps {
  /** portal 挂载（可同时采纳宿主主题令牌）。 */
  mount?: (panel: HTMLElement, host: HTMLElement) => void;
  /** 钉位（桌面右栏 / 触屏底栏）；缺省不钉。 */
  pin?: (panel: HTMLElement, host: HTMLElement) => void;
  /** 解除钉位与内联几何；缺省无操作。 */
  unpin?: (panel: HTMLElement) => void;
  /** 触屏触摸优先：sheet 过渡与打开时的聚焦策略。 */
  touchMode?: () => boolean;
}

export interface AssistantPanelDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 宿主根（主题采纳与 portal 宿主；不要求是阅读器实例）。 */
  host: () => HTMLElement;
  /** 当前上下文；无可用上下文格式返回 null。 */
  chapterContext: () => AssistantChapterContext | null;
  /** Surface 挂载/钉位/触屏注入；缺省 body portal + 不钉位。 */
  surface?: AssistantSurfaceDeps;
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
  /** 当前 surface 选区（引用选区 / 工具 selection）。 */
  currentSelection?: () => string;
  /** PDF 当前页码，只写入本轮用户消息。 */
  currentPage?: () => number | undefined;
  /** 前端工具循环的执行会话；缺省则 tool_call 回失败结果。 */
  createToolSession?: () => AssistantToolSession;
  /** 回答中的章节/页码定位点击（用户操作，不由工具翻页）。 */
  jumpToLocator?: (target: { chapter?: number; page?: number; title?: string }) => void;
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
  const surface = deps.surface ?? {};
  const disposed = { value: false };

  /** 触屏策略：宿主注入优先，缺省与 CSS 门控同源读 html 属性。 */
  const surfaceTouchMode = (): boolean => {
    try {
      return surface.touchMode?.() ?? defaultAssistantTouchMode();
    } catch {
      return defaultAssistantTouchMode();
    }
  };

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
  head.prepend(historyToggle);
  head.append(title, close);

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

  const pendingSection = document.createElement('section');
  pendingSection.className = 'lightink-reader-assistant-pending';
  pendingSection.hidden = true;
  const pendingTitle = document.createElement('p');
  pendingTitle.className = 'lightink-reader-assistant-pending-title';
  pendingTitle.textContent = t('reader.assistant.pendingTitle');
  const pendingList = document.createElement('ul');
  pendingList.className = 'lightink-reader-assistant-pending-list';
  pendingSection.append(pendingTitle, pendingList);

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
  const composerBox = document.createElement('div');
  composerBox.className = 'lightink-reader-assistant-composer-box';
  const input = document.createElement('textarea');
  input.className = 'lightink-reader-assistant-input';
  input.rows = 2;
  input.setAttribute('placeholder', t('reader.assistant.placeholder'));
  input.setAttribute('aria-label', t('reader.assistant.placeholder'));
  const composerBar = document.createElement('div');
  composerBar.className = 'lightink-reader-assistant-composer-bar';
  const quoteButton = document.createElement('button');
  quoteButton.type = 'button';
  quoteButton.className = 'lightink-reader-assistant-quote';
  quoteButton.dataset.assistantQuote = 'true';
  quoteButton.textContent = t('reader.assistant.quote');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'lightink-reader-assistant-send';
  send.textContent = t('reader.assistant.send');
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'lightink-reader-assistant-stop';
  stop.dataset.assistantStop = 'true';
  stop.textContent = t('reader.assistant.stop');
  stop.hidden = true;
  stop.disabled = true;
  const quoteChip = document.createElement('div');
  quoteChip.className = 'lightink-reader-assistant-quote-chip';
  quoteChip.hidden = true;
  const quoteChipLabel = document.createElement('span');
  quoteChipLabel.className = 'lightink-reader-assistant-quote-chip-label';
  quoteChipLabel.textContent = t('reader.assistant.quote');
  const quoteChipText = document.createElement('span');
  quoteChipText.className = 'lightink-reader-assistant-quote-chip-text';
  const quoteChipClear = document.createElement('button');
  quoteChipClear.type = 'button';
  quoteChipClear.className = 'lightink-reader-assistant-quote-chip-clear';
  quoteChipClear.textContent = '×';
  quoteChipClear.setAttribute('aria-label', t('reader.assistant.quoteRemove'));
  quoteChipClear.setAttribute('title', t('reader.assistant.quoteRemove'));
  quoteChip.append(quoteChipLabel, quoteChipText, quoteChipClear);
  composerBar.append(quoteButton, send, stop);
  composerBox.append(quoteChip, input, composerBar);
  const composerHint = document.createElement('p');
  composerHint.className = 'lightink-reader-assistant-composer-hint';
  composerHint.textContent = t('reader.assistant.composerHint');
  composer.append(composerBox, composerHint);
  main.append(contextHint, messagesWrap, persistNotice, pendingSection, actions, composer);
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
  let attachedQuote = '';
  /** 待确认写操作队列：未确认前不落盘；确认后回调产生建议的同一执行器。 */
  const pendingQueue: PendingConfirmationEntry[] = [];

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
      const split = splitQuotedUserContent(message.content);
      if (split.quote !== '') {
        const card = document.createElement('blockquote');
        card.className = 'lightink-reader-assistant-quote-card';
        const label = document.createElement('span');
        label.className = 'lightink-reader-assistant-quote-card-label';
        label.textContent = t('reader.assistant.quote');
        const excerpt = document.createElement('span');
        excerpt.className = 'lightink-reader-assistant-quote-excerpt';
        excerpt.textContent = split.quote;
        card.append(label, excerpt);
        bubble.appendChild(card);
      }
      const hideInstruction =
        split.quote !== '' &&
        (message.action === 'explain' || message.action === 'summarize');
      if (!hideInstruction && (split.body !== '' || split.quote === '')) {
        const text = document.createElement('p');
        text.className = 'lightink-reader-assistant-message-text';
        text.textContent = split.body === '' ? message.content : split.body;
        bubble.appendChild(text);
      }
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

  // ── 待确认列表：面板渲染 + 确认后回调同一执行器 ─────────────────────

  const renderPendingItem = (entry: PendingConfirmationEntry): HTMLElement => {
    const item = document.createElement('li');
    item.className = 'lightink-reader-assistant-pending-item';
    item.dataset.assistantPendingId = entry.item.id;
    item.dataset.status = entry.status;
    const summary = document.createElement('p');
    summary.className = 'lightink-reader-assistant-pending-summary';
    summary.textContent = entry.item.summary;
    item.appendChild(summary);
    if (entry.error !== undefined && entry.error !== '') {
      const error = document.createElement('p');
      error.className = 'lightink-reader-assistant-pending-error';
      error.textContent = entry.error;
      item.appendChild(error);
    }
    if (entry.status === 'pending') {
      const actions = document.createElement('div');
      actions.className = 'lightink-reader-assistant-pending-actions';
      const confirmButton = document.createElement('button');
      confirmButton.type = 'button';
      confirmButton.className = 'lightink-reader-assistant-pending-confirm';
      confirmButton.dataset.assistantPendingConfirm = entry.item.id;
      confirmButton.textContent = t('reader.assistant.pendingConfirm');
      confirmButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void resolvePending(entry, true);
      });
      const rejectButton = document.createElement('button');
      rejectButton.type = 'button';
      rejectButton.className = 'lightink-reader-assistant-pending-reject';
      rejectButton.dataset.assistantPendingReject = entry.item.id;
      rejectButton.textContent = t('reader.assistant.pendingReject');
      rejectButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void resolvePending(entry, false);
      });
      actions.append(confirmButton, rejectButton);
      item.appendChild(actions);
      return item;
    }
    const status = document.createElement('p');
    status.className = 'lightink-reader-assistant-pending-status';
    status.dataset.assistantPendingStatus = entry.status;
    status.textContent =
      entry.status === 'confirmed'
        ? t('reader.assistant.pendingConfirmed')
        : t('reader.assistant.pendingRejected');
    item.appendChild(status);
    return item;
  };

  const renderPendingConfirmations = (): void => {
    pendingSection.hidden = pendingQueue.length === 0;
    pendingList.replaceChildren(...pendingQueue.map((entry) => renderPendingItem(entry)));
  };

  /**
   * 确认 → 用产生建议的同一 `session.execute` 落盘；失败回到待确认并显示原因。
   * 拒绝 → 只标记该条，不调用执行器、不落盘。
   */
  const resolvePending = async (
    entry: PendingConfirmationEntry,
    confirmed: boolean,
  ): Promise<void> => {
    if (entry.status !== 'pending') {
      return;
    }
    if (!confirmed) {
      entry.status = 'rejected';
      entry.error = undefined;
      renderPendingConfirmations();
      return;
    }
    // 执行期间标记为已确认，重复点击不会触发第二次落盘。
    entry.status = 'confirmed';
    entry.error = undefined;
    renderPendingConfirmations();
    try {
      const result = await entry.session.execute(entry.item.tool, entry.item.arguments);
      if (result.ok !== true) {
        entry.status = 'pending';
        entry.error = result.message ?? result.error ?? t('reader.assistant.pendingFailed');
      }
    } catch (error) {
      entry.status = 'pending';
      entry.error = assistantAiErrorMessage(t, error, aiMissing);
    }
    renderPendingConfirmations();
  };

  /** 工具执行结果里的待确认建议入队；按 tool+id 去重，不落盘。 */
  const enqueuePendingConfirmations = (
    session: AssistantToolSession | null,
    blocks: readonly AssistantToolBlock[],
  ): void => {
    if (session === null) {
      return;
    }
    let added = false;
    for (const block of blocks) {
      for (const item of parseAssistantPendingConfirmations(block.result)) {
        const key = `${item.tool}:${item.id}`;
        if (pendingQueue.some((entry) => entry.key === key)) {
          continue;
        }
        pendingQueue.push({ key, item, session, status: 'pending' });
        added = true;
      }
    }
    if (added) {
      renderPendingConfirmations();
    }
  };

  const historyLocale = (): string =>
    typeof document !== 'undefined' && document.documentElement.lang.trim() !== ''
      ? document.documentElement.lang
      : 'zh-CN';

  const conversationListTitle = (conversation: AssistantConversation): string => {
    const derived = assistantConversationTitle(conversation.messages);
    if (derived !== '') {
      return derived;
    }
    const firstUser = conversation.messages.find(
      (message) => message.role === 'user' && message.content.trim() !== '',
    );
    if (firstUser?.action !== undefined) {
      return t(assistantActionLabelKey(firstUser.action));
    }
    const stored = conversation.title.trim();
    return stored === '' ? t('reader.assistant.untitled') : stored;
  };

  const listedConversations = (): AssistantConversation[] =>
    store.conversations
      .filter((conversation) =>
        conversation.messages.some(
          (message) => message.role === 'user' && message.content.trim() !== '',
        ),
      )
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt);

  const setHistoryOpen = (open: boolean): void => {
    historyPane.hidden = !open;
    root.classList.toggle('is-history', open);
    historyToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    historyToggle.textContent = open
      ? t('reader.assistant.historyBack')
      : t('reader.assistant.history');
    historyToggle.setAttribute(
      'title',
      open ? t('reader.assistant.historyBack') : t('reader.assistant.history'),
    );
    title.textContent = open ? t('reader.assistant.history') : t('reader.assistant.title');
    if (open) {
      renderHistoryList();
    }
  };

  const renderHistoryList = (): void => {
    const conversations = listedConversations();
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
      const name = document.createElement('span');
      name.className = 'lightink-reader-assistant-history-title';
      name.textContent = conversationListTitle(conversation);
      const meta = document.createElement('time');
      meta.className = 'lightink-reader-assistant-history-time';
      meta.dateTime = new Date(conversation.updatedAt).toISOString();
      meta.textContent = formatAssistantConversationTime(
        conversation.updatedAt,
        Date.now(),
        historyLocale(),
      );
      openButton.append(name, meta);
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

  const renderQuoteChip = (): void => {
    const attached = attachedQuote.trim();
    quoteChip.hidden = attached === '';
    quoteChipText.textContent = attached;
  };

  const syncQuoteButton = (): void => {
    const live = currentSelectionText();
    quoteButton.disabled = live === '' && attachedQuote.trim() === '';
    quoteButton.classList.toggle('is-ready', live !== '' && live !== attachedQuote);
    quoteButton.title =
      live === ''
        ? t('reader.assistant.quoteUnavailable')
        : live === attachedQuote
          ? t('reader.assistant.quote')
          : t('reader.assistant.quoteReady');
    renderQuoteChip();
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
    send.hidden = streaming;
    send.disabled = streaming;
    stop.hidden = !streaming;
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
      setHistoryOpen(false);
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
    document.addEventListener(ASSISTANT_AI_CONFIGURED_EVENT, onAiConfiguredEvent);
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
    if (store.activeId === '' && messages.length === 0) {
      return;
    }
    if (store.activeId === '') {
      store = createAssistantConversation(store);
    }
    store = setAssistantConversationMessages(store, store.activeId, persistableMessages(messages));
    renderHistoryList();
    const key = deps.historyKey?.() ?? null;
    if (key === null || deps.writeHistory === undefined) {
      return;
    }
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
      // 待确认建议属于上一上下文：切换身份即清空，避免跨书确认落错目标。
      pendingQueue.length = 0;
      renderMessages();
      renderHistoryList();
      renderPendingConfirmations();
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
        enqueuePendingConfirmations(session, executed);
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
            : assistantAiErrorMessage(t, error, aiMissing),
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
    const quote = attachedQuote.trim();
    if ((question === '' && quote === '') || !aiConfigured || streaming || sendGate) {
      return false;
    }
    sendGate = true;
    void (async () => {
      try {
        await ensureHistory();
        if (disposed.value || !aiConfigured || streaming) {
          return;
        }
        const payload = composeQuotedUserContent(quote, question);
        attachedQuote = '';
        renderQuoteChip();
        syncQuoteButton();
        appendExchange({ role: 'user', content: payload, createdAt: Date.now(), action });
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
      setHistoryOpen(false);
      return;
    }
    if (streaming) {
      abortStream();
    }
    store = setAssistantConversationMessages(store, store.activeId, persistableMessages(messages));
    store = switchAssistantConversation(store, id);
    loadActiveMessages();
    persistHistory();
    setHistoryOpen(false);
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
    if (!historyPane.hidden) {
      renderHistoryList();
    }
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
      const hasUserTurn = messages.some(
        (message) => message.role === 'user' && message.content.trim() !== '',
      );
      if (hasUserTurn) {
        if (store.activeId !== '') {
          store = setAssistantConversationMessages(
            store,
            store.activeId,
            persistableMessages(messages),
          );
        }
        store = createAssistantConversation(store);
        loadActiveMessages();
        persistHistory();
      }
      setHistoryOpen(false);
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
    if (quote === '') {
      syncQuoteButton();
      return;
    }
    attachedQuote = quote;
    renderQuoteChip();
    syncQuoteButton();
    input.focus();
  });
  quoteChipClear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    attachedQuote = '';
    renderQuoteChip();
    syncQuoteButton();
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
      deps.jumpToLocator?.(
        locatorTarget(
          locator.dataset.chapter,
          locator.dataset.page,
          locator.textContent ?? '',
        ),
      );
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
    setHistoryOpen(historyPane.hidden);
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

  const mountPanel = (): void => {
    const host = deps.host();
    (surface.mount ?? defaultAssistantMount)(root, host);
  };

  const pinPanel = (): void => {
    const host = deps.host();
    surface.pin?.(root, host);
  };

  const unpinPanel = (): void => {
    surface.unpin?.(root);
  };

  const positionPanel = (): void => {
    mountPanel();
    pinPanel();
  };

  const openPanel = (): void => {
    root.hidden = false;
    positionPanel();
    void ensureHistory();
    void refreshConfig();
    applyConfiguredView();
    renderMessages();
    renderHistoryList();
    renderPendingConfirmations();
    resizeInput();
    revealSheet(root);
    if (!surfaceTouchMode()) {
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
    if (surfaceTouchMode()) {
      concealSheet(root, () => {
        root.hidden = true;
        unpinPanel();
      });
      return;
    }
    delete root.dataset.open;
    root.hidden = true;
    unpinPanel();
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
        document.removeEventListener(ASSISTANT_AI_CONFIGURED_EVENT, onAiConfiguredEvent);
        document.removeEventListener('selectionchange', onSelectionChange);
      }
      delete root.dataset.open;
      root.hidden = true;
      unpinPanel();
      root.remove();
    },
  };
}
