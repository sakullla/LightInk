/**
 * `assistant-history` — 按书多会话历史 v2（ADR-4 / R2）。
 *
 * 文件仍是 `assistant/<content_hash>.json`，Rust 只做整文件读写。本模块拥有
 * schema：`{version:2, activeId, conversations:[{id, title, messages, updatedAt}]}`。
 * 读到 v1 `{messages}` 时包成一段会话；v2 忽略顶层 `messages`，会话互不串扰。
 * 坏 JSON / 坏形态视为空店，不抛。序列化超 2 MiB（UTF-8）拒绝写入。
 */

export const ASSISTANT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** 单段消息条数上限（敌意文件防膨胀；正常对话远低于此）。 */
export const ASSISTANT_HISTORY_MAX_MESSAGES = 400;
/** 单本会话段数上限（敌意文件防膨胀）。 */
export const ASSISTANT_HISTORY_MAX_CONVERSATIONS = 100;
/** 列表标题取自首条用户消息的截断长度。 */
export const ASSISTANT_CONVERSATION_TITLE_MAX_CHARS = 40;

const ASSISTANT_HISTORY_ACTIONS = [
  'explain',
  'summarize',
  'chapterSummary',
  'vocabulary',
  'quiz',
] as const;

export type AssistantHistoryAction = (typeof ASSISTANT_HISTORY_ACTIONS)[number];

/** 一段会话里的一条消息（与现网 v1 条目字段兼容）。 */
export interface AssistantHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: number;
  readonly action?: AssistantHistoryAction;
  readonly contextTruncated?: boolean;
  readonly error?: string;
}

export interface AssistantConversation {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly AssistantHistoryMessage[];
  readonly updatedAt: number;
}

export interface AssistantHistoryStore {
  readonly version: 2;
  readonly activeId: string;
  readonly conversations: readonly AssistantConversation[];
}

export class AssistantHistoryTooLargeError extends Error {
  readonly byteLength: number;
  readonly limitBytes: number;

  constructor(byteLength: number, limitBytes: number = ASSISTANT_HISTORY_MAX_BYTES) {
    super(`对话历史超过 ${limitBytes} 字节上限`);
    this.name = 'AssistantHistoryTooLargeError';
    this.byteLength = byteLength;
    this.limitBytes = limitBytes;
  }
}

const ACTION_SET: ReadonlySet<string> = new Set(ASSISTANT_HISTORY_ACTIONS);

export function emptyAssistantHistoryStore(): AssistantHistoryStore {
  return { version: 2, activeId: '', conversations: [] };
}

/** 标题=首条非空用户消息，空白折叠后按字符上限截断（代理对边界回退一字）。 */
export function assistantConversationTitle(
  messages: readonly AssistantHistoryMessage[],
): string {
  const firstUser = messages.find(
    (message) => message.role === 'user' && message.content.trim() !== '',
  );
  if (firstUser === undefined) {
    return '';
  }
  const text = firstUser.content.trim().replace(/\s+/g, ' ');
  if (text.length <= ASSISTANT_CONVERSATION_TITLE_MAX_CHARS) {
    return text;
  }
  let cut = text.slice(0, ASSISTANT_CONVERSATION_TITLE_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

export function activeAssistantConversation(
  store: AssistantHistoryStore,
): AssistantConversation | null {
  if (store.activeId === '') {
    return null;
  }
  return store.conversations.find((conversation) => conversation.id === store.activeId) ?? null;
}

export function createAssistantConversation(
  store: AssistantHistoryStore,
  now: number = Date.now(),
): AssistantHistoryStore {
  const id = newConversationId();
  return {
    version: 2,
    activeId: id,
    conversations: [
      ...store.conversations,
      { id, title: '', messages: [], updatedAt: finiteTime(now) },
    ],
  };
}

export function switchAssistantConversation(
  store: AssistantHistoryStore,
  id: string,
): AssistantHistoryStore {
  if (!store.conversations.some((conversation) => conversation.id === id)) {
    return store;
  }
  if (store.activeId === id) {
    return store;
  }
  return { version: 2, activeId: id, conversations: store.conversations };
}

export function deleteAssistantConversation(
  store: AssistantHistoryStore,
  id: string,
): AssistantHistoryStore {
  const conversations = store.conversations.filter((conversation) => conversation.id !== id);
  if (conversations.length === store.conversations.length) {
    return store;
  }
  if (conversations.length === 0) {
    return emptyAssistantHistoryStore();
  }
  const activeId =
    store.activeId === id ? latestConversationId(conversations) : store.activeId;
  return { version: 2, activeId, conversations };
}

export function setAssistantConversationMessages(
  store: AssistantHistoryStore,
  id: string,
  messages: readonly AssistantHistoryMessage[],
  now: number = Date.now(),
): AssistantHistoryStore {
  const index = store.conversations.findIndex((conversation) => conversation.id === id);
  if (index < 0) {
    return store;
  }
  const nextMessages = messages.slice(0, ASSISTANT_HISTORY_MAX_MESSAGES);
  const updated: AssistantConversation = {
    id,
    title: assistantConversationTitle(nextMessages),
    messages: nextMessages,
    updatedAt: finiteTime(now),
  };
  const conversations = store.conversations.slice();
  conversations[index] = updated;
  return { version: 2, activeId: store.activeId, conversations };
}

/** 防御解析历史文件：坏 JSON / 坏形态返回空店，不抛出。 */
export function parseAssistantHistoryStore(raw: string): AssistantHistoryStore {
  const text = raw.trim();
  if (text === '') {
    return emptyAssistantHistoryStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyAssistantHistoryStore();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyAssistantHistoryStore();
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version === 2) {
    return parseV2(obj);
  }
  return parseV1(obj);
}

/** 序列化 v2 信封；UTF-8 超 2 MiB 抛 AssistantHistoryTooLargeError，不截断。 */
export function serializeAssistantHistoryStore(store: AssistantHistoryStore): string {
  const json = JSON.stringify({
    version: 2,
    activeId: store.activeId,
    conversations: store.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.map(serializeMessage),
      updatedAt: conversation.updatedAt,
    })),
  });
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > ASSISTANT_HISTORY_MAX_BYTES) {
    throw new AssistantHistoryTooLargeError(byteLength);
  }
  return json;
}

function parseV2(obj: Record<string, unknown>): AssistantHistoryStore {
  const list = obj.conversations;
  if (!Array.isArray(list)) {
    return emptyAssistantHistoryStore();
  }
  const conversations: AssistantConversation[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const conversation = parseConversation(item);
    if (conversation === null || seen.has(conversation.id)) {
      continue;
    }
    seen.add(conversation.id);
    conversations.push(conversation);
    if (conversations.length >= ASSISTANT_HISTORY_MAX_CONVERSATIONS) {
      break;
    }
  }
  if (conversations.length === 0) {
    return emptyAssistantHistoryStore();
  }
  const requested = typeof obj.activeId === 'string' ? obj.activeId : '';
  const activeId = seen.has(requested) ? requested : latestConversationId(conversations);
  return { version: 2, activeId, conversations };
}

function parseV1(obj: Record<string, unknown>): AssistantHistoryStore {
  const list = obj.messages;
  if (!Array.isArray(list)) {
    return emptyAssistantHistoryStore();
  }
  const messages = parseMessages(list);
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
      ? obj.updatedAt
      : lastCreatedAt(messages);
  const id = newConversationId();
  return {
    version: 2,
    activeId: id,
    conversations: [
      {
        id,
        title: assistantConversationTitle(messages),
        messages,
        updatedAt,
      },
    ],
  };
}

function parseConversation(item: unknown): AssistantConversation | null {
  if (item === null || typeof item !== 'object') {
    return null;
  }
  const obj = item as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id === '') {
    return null;
  }
  const messages = Array.isArray(obj.messages) ? parseMessages(obj.messages) : [];
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0;
  return {
    id: obj.id,
    title: assistantConversationTitle(messages),
    messages,
    updatedAt,
  };
}

function parseMessages(list: readonly unknown[]): AssistantHistoryMessage[] {
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
      typeof obj.action === 'string' && ACTION_SET.has(obj.action)
        ? (obj.action as AssistantHistoryAction)
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

function serializeMessage(message: AssistantHistoryMessage): Record<string, unknown> {
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
}

function latestConversationId(conversations: readonly AssistantConversation[]): string {
  let latest = conversations[0]!;
  for (let index = 1; index < conversations.length; index += 1) {
    const candidate = conversations[index]!;
    if (candidate.updatedAt > latest.updatedAt) {
      latest = candidate;
    }
  }
  return latest.id;
}

function lastCreatedAt(messages: readonly AssistantHistoryMessage[]): number {
  if (messages.length === 0) {
    return 0;
  }
  return messages[messages.length - 1]!.createdAt;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function newConversationId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef !== undefined && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
