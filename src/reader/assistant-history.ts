/**
 * `assistant-history` — AI 助手按书多会话历史的 schema 与纯函数（R2 / R9）。
 *
 * - 文件形态 v2：`{version:2, activeSessionId, sessions:[{id, createdAt,
 *   updatedAt, messages:[…]}], updatedAt}`，按书（与标注同源的内容哈希）落
 *   在本机 `app_data_dir/assistant/<hash>.json`（Rust 只做 key 校验、体积上限
 *   与整文件覆写，JSON 对 Rust 不透明）。v1（单会话 `{messages}`）读入时迁移
 *   为一段会话。
 * - 消息角色：`user` / `assistant` / `tool`（应用执行工具后的回传，展示为工具
 *   块；请求构造时映射为携带 tool_results 的 user 轮）。
 * - 防御解析：坏 JSON / 坏形态 / 单段超条数上限 → 该段视为空或被裁，不抛出、
 *   不阻断面板（R2 失败边界）。
 * - 体积：单段序列化超过 `ASSISTANT_HISTORY_MAX_BYTES` 由面板拒绝写入并提示
 *   （与 Rust `MAX_HISTORY_BYTES` 同值），不静默丢已显示消息。
 */

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

export type AssistantRole = 'user' | 'assistant' | 'tool';

/** 模型发起的一次工具调用（Rust `AiToolCall` 的前端投影）。 */
export interface AssistantToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** 应用执行工具后的回传（失败 / 拒绝 / 超限也回传，`isError` 标记）。 */
export interface AssistantToolResult {
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
}

/** 会话内一条消息（也是历史文件的 schema）。 */
export interface AssistantMessage {
  readonly role: AssistantRole;
  readonly content: string;
  readonly createdAt: number;
  /** user 轮：发起该消息的快捷动作。 */
  readonly action?: AssistantQuickAction;
  /** assistant 轮：本次回答注入的章节上下文发生了截断。 */
  readonly contextTruncated?: boolean;
  /** assistant 轮：流式失败的可展示错误文案（可原地重试）。 */
  readonly error?: string;
  /** assistant 轮：用户中途停止，已生成文字保留但不是完整回答。 */
  readonly stopped?: boolean;
  /** assistant 轮：提供商因输出长度上限截断（length / max_tokens / incomplete），不是完整回答。 */
  readonly truncated?: boolean;
  /** assistant 轮：这条摘要已保存为标注（跨会话切换、重开书仍有效，防重复保存）。 */
  readonly savedAnnotation?: boolean;
  /** user 轮：发起本次交换时的章索引 / 页码（摘要保存为标注时锚到它，而不是点击时的位置）。 */
  readonly sourceChapter?: number;
  readonly sourcePage?: number;
  /** assistant 轮：本条末尾发起的工具调用（结果在紧随其后的 tool 轮）。 */
  readonly toolCalls?: readonly AssistantToolCall[];
  /** tool 轮：工具执行结果（与前一条 assistant 轮的 toolCalls 一一对应）。 */
  readonly toolResults?: readonly AssistantToolResult[];
}

export interface AssistantSession {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messages: readonly AssistantMessage[];
}

export interface AssistantHistoryFile {
  readonly activeSessionId: string | null;
  readonly sessions: readonly AssistantSession[];
}

/** 历史文件单段消息条数上限（敌意文件防膨胀；正常对话远低于此）。 */
export const ASSISTANT_HISTORY_MAX_MESSAGES = 400;
/** 单本书会话段数上限（超出丢最旧；正常使用远低于此）。 */
export const ASSISTANT_HISTORY_MAX_SESSIONS = 100;
/** 单段/整文件字节上限（与 Rust assistant.rs `MAX_HISTORY_BYTES` 同值）。 */
export const ASSISTANT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** 历史列表标题最大字符数（取首条用户消息，超长截断）。 */
export const ASSISTANT_SESSION_TITLE_MAX = 40;

export const EMPTY_ASSISTANT_HISTORY: AssistantHistoryFile = Object.freeze({
  activeSessionId: null,
  sessions: [],
});

let sessionCounter = 0;

/** 会话 id：时间戳 + 进程内计数（本机文件内唯一即可）。 */
export function newAssistantSessionId(now: number = Date.now()): string {
  sessionCounter += 1;
  return `s${now.toString(36)}-${sessionCounter.toString(36)}`;
}

export function createAssistantSession(now: number = Date.now()): AssistantSession {
  return { id: newAssistantSessionId(now), createdAt: now, updatedAt: now, messages: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseToolCalls(raw: unknown): AssistantToolCall[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const calls: AssistantToolCall[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
      continue;
    }
    calls.push({
      id: item.id,
      name: item.name,
      arguments: isRecord(item.arguments) ? item.arguments : {},
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function parseToolResults(raw: unknown): AssistantToolResult[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const results: AssistantToolResult[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.callId !== 'string' || typeof item.content !== 'string') {
      continue;
    }
    results.push({
      callId: item.callId,
      name: typeof item.name === 'string' ? item.name : '',
      content: item.content,
      isError: item.isError === true,
    });
  }
  return results.length > 0 ? results : undefined;
}

/** 防御解析一段消息列表：坏条目丢弃、超上限截断，不抛出。 */
export function parseAssistantMessages(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const messages: AssistantMessage[] = [];
  // 只看尾部两倍上限的条目：敌意文件不会让解析分配无界的消息对象。
  for (const item of raw.slice(-(ASSISTANT_HISTORY_MAX_MESSAGES * 2))) {
    if (!isRecord(item)) {
      continue;
    }
    const role = item.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      continue;
    }
    const content = typeof item.content === 'string' ? item.content : role === 'tool' ? '' : null;
    if (content === null) {
      continue;
    }
    const toolResults = role === 'tool' ? parseToolResults(item.toolResults) : undefined;
    if (role === 'tool' && toolResults === undefined) {
      continue; // 无结果的 tool 轮没有意义
    }
    const action =
      typeof item.action === 'string' && ASSISTANT_ACTIONS.includes(item.action)
        ? (item.action as AssistantQuickAction)
        : undefined;
    const error = typeof item.error === 'string' && item.error !== '' ? item.error : undefined;
    const toolCalls = role === 'assistant' ? parseToolCalls(item.toolCalls) : undefined;
    messages.push({
      role,
      content,
      createdAt: finiteNumber(item.createdAt),
      ...(action !== undefined ? { action } : {}),
      ...(item.contextTruncated === true ? { contextTruncated: true } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(item.stopped === true ? { stopped: true } : {}),
      ...(item.truncated === true ? { truncated: true } : {}),
      ...(item.savedAnnotation === true ? { savedAnnotation: true } : {}),
      ...(typeof item.sourceChapter === 'number' && Number.isSafeInteger(item.sourceChapter)
        ? { sourceChapter: item.sourceChapter }
        : {}),
      ...(typeof item.sourcePage === 'number' && Number.isSafeInteger(item.sourcePage)
        ? { sourcePage: item.sourcePage }
        : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toolResults !== undefined ? { toolResults } : {}),
    });
  }
  return capAssistantMessages(messages);
}

/**
 * 条数上限：超出时保留最新的、且从一次完整交换（用户提问）开始的尾部；对话
 * 历史尾部更重要，不能像截首部那样把最近的问答丢掉。
 */
export function capAssistantMessages(
  messages: readonly AssistantMessage[],
  limit: number = ASSISTANT_HISTORY_MAX_MESSAGES,
): AssistantMessage[] {
  if (messages.length <= limit) {
    return [...messages];
  }
  const tail = messages.length - limit;
  let start = tail;
  while (start < messages.length && messages[start]!.role !== 'user') {
    start += 1;
  }
  // 尾部里没有用户提问（坏文件/外来文件）：退回纯尾部切片，绝不返回空而丢整段。
  return messages.slice(start < messages.length ? start : tail);
}

function parseSession(raw: unknown): AssistantSession | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : null;
  if (id === null) {
    return null;
  }
  const messages = parseAssistantMessages(raw.messages);
  const createdAt = finiteNumber(raw.createdAt, messages[0]?.createdAt ?? 0);
  const updatedAt = finiteNumber(
    raw.updatedAt,
    messages[messages.length - 1]?.createdAt ?? createdAt,
  );
  return { id, createdAt, updatedAt, messages };
}

/**
 * 防御解析历史文件：v2 多会话；v1（`{messages}`）迁移为一段会话；坏 JSON /
 * 坏形态返回空历史，不抛出。段 id 重复时保留首个。
 */
export function parseAssistantHistory(raw: string): AssistantHistoryFile {
  const text = raw.trim();
  if (text === '') {
    return EMPTY_ASSISTANT_HISTORY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_ASSISTANT_HISTORY;
  }
  if (!isRecord(parsed)) {
    return EMPTY_ASSISTANT_HISTORY;
  }
  if (Array.isArray(parsed.sessions)) {
    const seen = new Set<string>();
    const sessions: AssistantSession[] = [];
    for (const item of parsed.sessions) {
      const session = parseSession(item);
      if (session === null || seen.has(session.id)) {
        continue;
      }
      seen.add(session.id);
      sessions.push(session);
      if (sessions.length >= ASSISTANT_HISTORY_MAX_SESSIONS) {
        break;
      }
    }
    const active =
      typeof parsed.activeSessionId === 'string' && seen.has(parsed.activeSessionId)
        ? parsed.activeSessionId
        : (sessions[0]?.id ?? null);
    return { activeSessionId: active, sessions };
  }
  // v1：单会话 {version:1, messages, updatedAt}
  const messages = parseAssistantMessages(parsed.messages);
  if (messages.length === 0) {
    return EMPTY_ASSISTANT_HISTORY;
  }
  const updatedAt = finiteNumber(parsed.updatedAt, messages[messages.length - 1]!.createdAt);
  const session: AssistantSession = {
    id: newAssistantSessionId(updatedAt || Date.now()),
    createdAt: messages[0]!.createdAt,
    updatedAt,
    messages,
  };
  return { activeSessionId: session.id, sessions: [session] };
}

function serializeMessage(message: AssistantMessage): Record<string, unknown> {
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
  if (message.stopped === true) {
    entry.stopped = true;
  }
  if (message.truncated === true) {
    entry.truncated = true;
  }
  if (message.savedAnnotation === true) {
    entry.savedAnnotation = true;
  }
  if (message.sourceChapter !== undefined) {
    entry.sourceChapter = message.sourceChapter;
  }
  if (message.sourcePage !== undefined) {
    entry.sourcePage = message.sourcePage;
  }
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    entry.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
  }
  if (message.toolResults !== undefined && message.toolResults.length > 0) {
    entry.toolResults = message.toolResults.map((result) => ({
      callId: result.callId,
      name: result.name,
      content: result.content,
      isError: result.isError,
    }));
  }
  return entry;
}

export function serializeAssistantSession(session: AssistantSession): string {
  return JSON.stringify({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages.map(serializeMessage),
  });
}

/** 序列化历史文件（v2 信封）。 */
export function serializeAssistantHistory(
  file: AssistantHistoryFile,
  now: number = Date.now(),
): string {
  return JSON.stringify({
    version: 2,
    activeSessionId: file.activeSessionId,
    sessions: file.sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map(serializeMessage),
    })),
    updatedAt: now,
  });
}

const utf8Encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** UTF-8 字节长度（与 Rust 侧 `len()` 同口径）。 */
export function utf8ByteLength(text: string): number {
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

/** 单段是否超过体积上限（超出时面板拒绝写入并提示，不静默丢消息）。 */
export function assistantSessionOversized(session: AssistantSession): boolean {
  return utf8ByteLength(serializeAssistantSession(session)) > ASSISTANT_HISTORY_MAX_BYTES;
}

/**
 * 活动段自身超限时从最早的完整交换开始裁掉，直到装下（至少保留最后一次交换）。
 * 返回裁掉的交换数；仍装不下时 fits=false，由调用方拒写并提示。裁剪是可见的
 * （调用方重绘并提示），不是静默丢弃。
 */
export function trimAssistantSessionToFit(
  session: AssistantSession,
  maxBytes: number = ASSISTANT_HISTORY_MAX_BYTES,
): { session: AssistantSession; dropped: number; fits: boolean } {
  let messages = session.messages;
  let dropped = 0;
  const oversized = (): boolean =>
    utf8ByteLength(serializeAssistantSession({ ...session, messages })) > maxBytes;
  while (oversized()) {
    // 找第二个用户提问：它之前的就是最早的一次完整交换。
    let next = -1;
    let seenUser = false;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]!.role === 'user') {
        if (seenUser) {
          next = index;
          break;
        }
        seenUser = true;
      }
    }
    if (next < 0) {
      break; // 只剩一次交换：不再裁
    }
    messages = messages.slice(next);
    dropped += 1;
  }
  const trimmed = dropped === 0 ? session : { ...session, messages };
  return { session: trimmed, dropped, fits: !oversized() };
}

/**
 * 整文件体积收敛：序列化后超过上限时按 updatedAt 从最旧的非活动段开始丢弃，
 * 直到装得下；活动段永不丢。`fits=false` 表示只剩活动段仍超限（调用方拒写并提示）。
 */
export function fitAssistantHistory(
  file: AssistantHistoryFile,
  activeSessionId: string | null,
  maxBytes: number = ASSISTANT_HISTORY_MAX_BYTES,
): {
  readonly file: AssistantHistoryFile;
  readonly dropped: number;
  readonly fits: boolean;
  /** 装得下时的最终 JSON（调用方直接写入，不再序列化一次）。 */
  readonly json: string | null;
} {
  // 每段只序列化一次；整文件 = 信封 + 各段 + 分隔逗号（与 serializeAssistantHistory 同构）。
  // 信封与最终 JSON 用同一个时间戳：否则估算按 0 算、写出按 13 位算，贴着上限时会写超。
  const now = Date.now();
  const envelope = utf8ByteLength(
    serializeAssistantHistory({ activeSessionId: file.activeSessionId, sessions: [] }, now),
  );
  const sizes = new Map(
    file.sessions.map((session) => [session.id, utf8ByteLength(serializeAssistantSession(session))]),
  );
  let sessions = [...file.sessions];
  let dropped = 0;
  const totalBytes = (): number =>
    envelope +
    sessions.reduce((sum, session) => sum + (sizes.get(session.id) ?? 0), 0) +
    Math.max(0, sessions.length - 1);
  while (totalBytes() > maxBytes) {
    const candidates = sortAssistantSessions(sessions).filter((item) => item.id !== activeSessionId);
    const oldest = candidates[candidates.length - 1];
    if (oldest === undefined) {
      return {
        file: { activeSessionId: file.activeSessionId, sessions },
        dropped,
        fits: false,
        json: null,
      };
    }
    sessions = sessions.filter((item) => item.id !== oldest.id);
    dropped += 1;
  }
  const fitted = { activeSessionId: file.activeSessionId, sessions };
  return { file: fitted, dropped, fits: true, json: serializeAssistantHistory(fitted, now) };
}

/** 历史列表标题：该段首条用户消息（首行、折叠空白、剥离引文标记），超长截断。 */
export function assistantSessionTitle(session: AssistantSession, fallback: string): string {
  const first = session.messages.find((message) => message.role === 'user');
  if (first === undefined) {
    return fallback;
  }
  const stripped = first.content
    .replace(/<selection>[\s\S]*?<\/selection>/g, ' ')
    .replace(/<\/?selection>/g, ' ');
  const line = stripped
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '') ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return fallback;
  }
  const chars = Array.from(collapsed);
  if (chars.length <= ASSISTANT_SESSION_TITLE_MAX) {
    return collapsed;
  }
  return `${chars.slice(0, ASSISTANT_SESSION_TITLE_MAX).join('')}…`;
}

/** 按最近活动排序的会话列表（新在前）。 */
export function sortAssistantSessions(
  sessions: readonly AssistantSession[],
): AssistantSession[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

/** 替换/插入一段并把它设为活动段；超段数上限时丢最旧的非活动段。 */
export function upsertAssistantSession(
  file: AssistantHistoryFile,
  session: AssistantSession,
): AssistantHistoryFile {
  const others = file.sessions.filter((item) => item.id !== session.id);
  let sessions = [session, ...others];
  if (sessions.length > ASSISTANT_HISTORY_MAX_SESSIONS) {
    sessions = sortAssistantSessions(sessions).slice(0, ASSISTANT_HISTORY_MAX_SESSIONS);
  }
  return { activeSessionId: session.id, sessions };
}

/** 删除一段；若删的是活动段，活动段回落到最近的一段（或 null）。 */
export function removeAssistantSession(
  file: AssistantHistoryFile,
  sessionId: string,
): AssistantHistoryFile {
  const sessions = file.sessions.filter((item) => item.id !== sessionId);
  const active =
    file.activeSessionId === sessionId
      ? (sortAssistantSessions(sessions)[0]?.id ?? null)
      : file.activeSessionId;
  return { activeSessionId: active, sessions };
}

export function findAssistantSession(
  file: AssistantHistoryFile,
  sessionId: string | null,
): AssistantSession | null {
  if (sessionId === null) {
    return null;
  }
  return file.sessions.find((item) => item.id === sessionId) ?? null;
}
