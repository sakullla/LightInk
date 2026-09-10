/**
 * `assistant-request` — 分层上下文请求构造与流式通道（R4 / R5）。
 *
 * 每次模型请求按固定顺序组装：① 内置工具定义 → ② 系统提示 → ③ 当前章上下文
 * → ④ 本会话近期对话 → ⑤ 本轮消息（含本轮的工具往返）。页码/时间等易变
 * 信息只可能出现在 ⑤；同一章内追问 ①②③ 字节级相同；换章只更新 ③。轮次或
 * 字符预算超出时按「交换」为单位丢弃最旧轮次（一次用户提问 + 其后的助手/
 * 工具消息），永不丢 ①②③ 与本轮。
 *
 * Rust `ai_chat_stream` 接收 `{requestId, system, context, tools, turns}`，
 * 三端点格式各自构造请求体：Claude 在 ①②③ 与最后一条消息上设显式缓存断点，
 * OpenAI 两式保持前缀字节稳定（自动前缀缓存）。缓存降低同章多轮的重复计费
 * 与延迟，不是本机命中：相同问题仍会发出网络请求（R10）。
 */

import { Channel, invoke } from '@tauri-apps/api/core';
import { READER_LIMITS } from './reader-limits.js';
import type {
  AssistantMessage,
  AssistantToolCall,
  AssistantToolResult,
} from './assistant-history.js';

/** 单次请求携带的历史消息条数上限（ai.rs MAX_MESSAGES=200 的安全余量）。 */
export const ASSISTANT_MAX_TURNS = 30;
/**
 * 历史预算（④）按 UTF-8 字节计：Rust 的 512 KiB 请求上限是按字节算的，中文一个字
 * 三字节，按字符计会在历史攒满时永久撞墙（重试也一样）。
 */
export const ASSISTANT_REQUEST_HISTORY_BYTES = 160 * 1024;
/** 整个请求体（系统提示 + 当前章 + 历史 + 本轮）的字节上限，留出 JSON 信封余量。 */
export const ASSISTANT_REQUEST_MAX_BYTES = 440 * 1024;
/** 本轮工具结果被省略时的占位内容（保留 call/result 配对，只丢正文）。 */
export const ASSISTANT_ELIDED_RESULT = '{"elided":true,"note":"该结果内容已省略以控制请求体积；如需请重新查询。"}';

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 字节长度（与 Rust 侧 `len()` 同口径）。 */
export function requestByteLength(text: string): number {
  if (utf8Encoder !== null) {
    return utf8Encoder.encode(text).length;
  }
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** 按字节上限截断（代理对边界回退一字），文本已在上限内则原样返回。 */
export function clipToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (requestByteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  // 先按最坏 3 字节/字符估一个下界，再逐步放宽到刚好不超。
  let low = Math.min(text.length, Math.floor(maxBytes / 3));
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (requestByteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let cut = text.slice(0, low);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

/**
 * 剥掉 Rust 侧会拒绝的控制字符（C0 除 \\t\\n\\r、DEL、C1）：书里一个误解码的 U+0092
 * 不能让整本书的提问全部失败。
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

/** 内置工具定义（Rust `AiToolDef` 的前端投影；集合固定、顺序稳定）。 */
export interface AiToolDefView {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 请求中的一轮（Rust `AiChatTurn`）。 */
export interface AiChatTurnView {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly toolCalls?: readonly AssistantToolCall[];
  readonly toolResults?: readonly AssistantToolResult[];
}

/** `ai_chat_stream` 的请求（Rust `AiChatRequest`）。 */
export interface AiChatRequestView {
  readonly requestId: string;
  readonly system: string;
  readonly context: string | null;
  readonly tools: readonly AiToolDefView[];
  readonly turns: readonly AiChatTurnView[];
}

/** `ai_chat_stream` 经 Channel 推送的事件（snake_case tag 与 ai.rs 钉死）。 */
export interface AiStreamEventView {
  readonly type: 'delta';
  readonly text: string;
}

/** `ai_chat_stream` 的返回终态（`toolCalls` 非空 = 模型要求执行工具后继续）。 */
export interface AiStreamDoneView {
  readonly finish: string;
  readonly totalChars: number;
  readonly toolCalls: readonly AssistantToolCall[];
}

// ── 章节上下文（③） ──────────────────────────────────────────────────

export interface AssistantChapterContext {
  readonly title: string;
  readonly text: string;
}

export interface AssistantContextClip {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * 章节上下文截断：超限保留前部、截断后部；在代理对边界处回退一字，不产生
 * 半个字符。选区引文复用同一预算。
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

/** ③ 当前章上下文块：标题 + 已截断的正文；无章节文本时为 null。 */
/** 章节被截断时附在上下文末尾、给模型看的说明（UI 只存元数据，模型必须自己知道）。 */
export const ASSISTANT_CONTEXT_TRUNCATED_NOTE =
  '【注意】本章正文超过长度上限，以上只是前部，后文未提供；不要把它当作全章，需要后文时请说明无法读取。';

export function assistantContextBlock(
  chapter: { readonly title: string; readonly text: string; readonly truncated?: boolean } | null,
): string | null {
  if (chapter === null || chapter.text === '') {
    return null;
  }
  const title = chapter.title.trim();
  const head = title === '' ? '当前章节' : `当前章节：${title}`;
  const block = `【${head}】\n<chapter>\n${chapter.text}\n</chapter>`;
  return chapter.truncated === true ? `${block}\n${ASSISTANT_CONTEXT_TRUNCATED_NOTE}` : block;
}

// ── 对话轮次（④⑤） ──────────────────────────────────────────────────

/** 一次交换：用户提问 + 其后的助手/工具消息（预算裁剪的最小单位）。 */
function splitExchanges(messages: readonly AssistantMessage[]): AssistantMessage[][] {
  const exchanges: AssistantMessage[][] = [];
  let current: AssistantMessage[] | null = null;
  for (const message of messages) {
    if (message.role === 'user' || current === null) {
      current = [];
      exchanges.push(current);
    }
    current.push(message);
  }
  return exchanges;
}

function messageBytes(message: AssistantMessage): number {
  let total = requestByteLength(message.content);
  for (const result of message.toolResults ?? []) {
    total += requestByteLength(result.content);
  }
  for (const call of message.toolCalls ?? []) {
    total += requestByteLength(JSON.stringify(call.arguments));
  }
  return total;
}

function turnBytes(turn: AiChatTurnView): number {
  let total = requestByteLength(turn.content);
  for (const result of turn.toolResults ?? []) {
    total += requestByteLength(result.content);
  }
  for (const call of turn.toolCalls ?? []) {
    total += requestByteLength(JSON.stringify(call.arguments));
  }
  return total;
}

function sanitizeTurn(turn: AiChatTurnView): AiChatTurnView {
  const content = stripControlChars(turn.content);
  const toolResults = turn.toolResults?.map((result) => ({
    ...result,
    content: stripControlChars(result.content),
  }));
  return {
    ...turn,
    content,
    ...(toolResults !== undefined ? { toolResults } : {}),
  };
}

/**
 * 本轮（⑤）超出字节预算时，从最早的工具结果开始把正文换成占位符：调用/结果配对
 * 保持完整（提供商要求），只丢内容；仍超限就继续往后换，直到装下或无可换。
 */
function elideCurrentTurns(current: AiChatTurnView[], budget: number): AiChatTurnView[] {
  let used = current.reduce((sum, turn) => sum + turnBytes(turn), 0);
  if (used <= budget) {
    return current;
  }
  const next = [...current];
  for (let index = 0; index < next.length && used > budget; index += 1) {
    const turn = next[index]!;
    if (turn.toolResults === undefined) {
      continue;
    }
    const results = turn.toolResults.map((result) => {
      if (used <= budget || result.content === ASSISTANT_ELIDED_RESULT) {
        return result;
      }
      used -= requestByteLength(result.content) - requestByteLength(ASSISTANT_ELIDED_RESULT);
      return { ...result, content: ASSISTANT_ELIDED_RESULT };
    });
    next[index] = { ...turn, toolResults: results };
  }
  return next;
}

/**
 * 把一次交换映射为请求轮次：失败占位/空助手轮不进请求；助手轮的工具调用
 * 只有紧随其后的 tool 轮给全结果时才携带（否则剥掉，避免悬空调用）；tool
 * 轮映射为携带 tool_results 的 user 轮。
 */
export function exchangeToTurns(messages: readonly AssistantMessage[]): AiChatTurnView[] {
  const turns: AiChatTurnView[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      if (message.content.trim() !== '') {
        turns.push({ role: 'user', content: message.content });
      }
      continue;
    }
    if (message.role === 'tool') {
      const previous = turns[turns.length - 1];
      // 每个调用恰好带一条结果：磁盘恢复的历史可能出现不成对或重复的项，多余
      // 或重复的 tool_result 都会让 OpenAI / Claude 直接 400。
      const known = new Set(previous?.toolCalls?.map((call) => call.id) ?? []);
      const results: AssistantToolResult[] = [];
      for (const result of message.toolResults ?? []) {
        if (known.delete(result.callId)) {
          results.push(result);
        }
      }
      if (results.length === 0) {
        continue; // 没有对应调用的结果不进请求
      }
      turns.push({ role: 'user', content: '', toolResults: results });
      continue;
    }
    const content = message.content.trim() === '' ? '' : message.content;
    const calls = message.toolCalls ?? [];
    const next = messages[index + 1];
    const answered =
      calls.length > 0 &&
      next !== undefined &&
      next.role === 'tool' &&
      calls.every((call) => (next.toolResults ?? []).some((result) => result.callId === call.id));
    if (answered) {
      turns.push({ role: 'assistant', content, toolCalls: calls });
      continue;
    }
    if (content === '') {
      continue;
    }
    turns.push({ role: 'assistant', content });
  }
  return turns;
}

export interface AssistantRequestInput {
  readonly requestId: string;
  readonly tools: readonly AiToolDefView[];
  readonly systemPrompt: string;
  /** ③ 已截断的当前章上下文（null = 无章节文本）。 */
  readonly context: string | null;
  /** 会话消息（不含流式占位）。 */
  readonly messages: readonly AssistantMessage[];
  /** 本轮起点：本次用户提问在 `messages` 中的下标（其后全部属于 ⑤）。 */
  readonly currentStart: number;
  readonly maxTurns?: number;
  /** 历史字节预算（④）；缺省 ASSISTANT_REQUEST_HISTORY_BYTES。 */
  readonly charBudget?: number;
  /** 整个请求体字节上限；缺省 ASSISTANT_REQUEST_MAX_BYTES。 */
  readonly maxBytes?: number;
}

/**
 * 构造一次流式请求：① 工具 ② 系统提示 ③ 当前章 固定；④ 从最新交换向前累计
 * 直至轮数/字符预算；⑤ 本轮（提问 + 本轮工具往返）总是全部携带。
 */
export function buildAssistantRequest(input: AssistantRequestInput): AiChatRequestView {
  const maxTurns = input.maxTurns ?? ASSISTANT_MAX_TURNS;
  const charBudget = input.charBudget ?? ASSISTANT_REQUEST_HISTORY_BYTES;
  const maxBytes = input.maxBytes ?? ASSISTANT_REQUEST_MAX_BYTES;
  const start = Math.max(0, Math.min(input.currentStart, input.messages.length));
  const system = stripControlChars(input.systemPrompt);
  const context = input.context === null ? null : stripControlChars(input.context);
  const fixedBytes = requestByteLength(system) + requestByteLength(context ?? '');
  const current = elideCurrentTurns(
    exchangeToTurns(input.messages.slice(start)).map(sanitizeTurn),
    Math.max(0, maxBytes - fixedBytes),
  );
  const currentBytes = current.reduce((sum, turn) => sum + turnBytes(turn), 0);
  // 历史预算取「历史上限」与「整体余量」的较小者：本轮很大时历史自动让路。
  const history = splitExchanges(input.messages.slice(0, start));
  const kept: AiChatTurnView[][] = [];
  let turnCount = 0;
  let budget = Math.min(charBudget, Math.max(0, maxBytes - fixedBytes - currentBytes));
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const exchange = history[index]!;
    const turns = exchangeToTurns(exchange).map(sanitizeTurn);
    if (turns.length === 0) {
      continue;
    }
    const chars = exchange.reduce((sum, message) => sum + messageBytes(message), 0);
    if (turnCount + turns.length > maxTurns || budget - chars < 0) {
      break;
    }
    turnCount += turns.length;
    budget -= chars;
    kept.unshift(turns);
  }
  return {
    requestId: input.requestId,
    system,
    context,
    tools: input.tools,
    turns: [...kept.flat(), ...current],
  };
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

function parseToolCalls(raw: unknown): AssistantToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: AssistantToolCall[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const obj = item as { id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof obj.name !== 'string' || obj.name === '') {
      continue;
    }
    calls.push({
      id: typeof obj.id === 'string' && obj.id !== '' ? obj.id : `call_${calls.length}`,
      name: obj.name,
      arguments:
        obj.arguments !== null && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
          ? (obj.arguments as Record<string, unknown>)
          : {},
    });
  }
  return calls;
}

function serializeTurn(turn: AiChatTurnView): Record<string, unknown> {
  const entry: Record<string, unknown> = { role: turn.role, content: turn.content };
  if (turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
    entry.toolCalls = turn.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
  }
  if (turn.toolResults !== undefined && turn.toolResults.length > 0) {
    entry.toolResults = turn.toolResults.map((result) => ({
      callId: result.callId,
      name: result.name,
      content: result.content,
      isError: result.isError,
    }));
  }
  return entry;
}

/** 请求的线格式（invoke 负载；测试据此断言 ①②③ 字节稳定）。 */
export function serializeAssistantRequest(request: AiChatRequestView): Record<string, unknown> {
  return {
    requestId: request.requestId,
    system: request.system,
    context: request.context,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    turns: request.turns.map(serializeTurn),
  };
}

/**
 * 流式多轮对话：invoke 携带 `Channel`，delta 增量回调；终态（finish /
 * totalChars / toolCalls）由命令返回值承载，失败以抛出错误码族呈现。
 */
export async function streamAssistantChat(
  request: AiChatRequestView,
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
    request: serializeAssistantRequest(request),
    onEvent: channel,
  });
  if (done !== null && typeof done === 'object') {
    const obj = done as { finish?: unknown; totalChars?: unknown; toolCalls?: unknown };
    return {
      finish: typeof obj.finish === 'string' ? obj.finish : 'closed',
      totalChars: typeof obj.totalChars === 'number' ? obj.totalChars : 0,
      toolCalls: parseToolCalls(obj.toolCalls),
    };
  }
  return { finish: 'closed', totalChars: 0, toolCalls: [] };
}

/** 停止生成：登记中止，Rust 立即打断正在等待的发送/读取并结束该次流式（失败静默）。 */
export async function abortAssistantChat(
  requestId: string,
  deps: AssistantStreamDeps = {},
): Promise<void> {
  const invokeFn = deps.invoke ?? defaultAssistantInvoke;
  try {
    await invokeFn('ai_chat_abort', { requestId });
  } catch {
    // 中止是尽力而为：前端已按代数忽略后续增量。
  }
}

let requestCounter = 0;

export function newAssistantRequestId(now: number = Date.now()): string {
  requestCounter += 1;
  return `assistant-${now.toString(36)}-${requestCounter.toString(36)}`;
}
