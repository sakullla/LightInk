/**
 * Contract for `src/reader/assistant-history.ts` (ADR-4 / R2):
 *
 * - v1 `{messages}` 读成一段会话；v2 多段互不串扰（忽略顶层 leftover messages）。
 * - 可新建、切换、删除单段；序列化后 activeId 仍指向上次会话。
 * - 超限拒绝写入；坏 JSON 视为空店且不抛。
 */

import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_CONVERSATION_TITLE_MAX_CHARS,
  ASSISTANT_HISTORY_MAX_BYTES,
  ASSISTANT_HISTORY_MAX_CONVERSATIONS,
  ASSISTANT_HISTORY_MAX_MESSAGES,
  AssistantHistoryTooLargeError,
  activeAssistantConversation,
  assistantConversationTitle,
  formatAssistantConversationTime,
  createAssistantConversation,
  deleteAssistantConversation,
  emptyAssistantHistoryStore,
  parseAssistantHistoryStore,
  serializeAssistantHistoryStore,
  setAssistantConversationMessages,
  switchAssistantConversation,
  type AssistantHistoryMessage,
  type AssistantHistoryStore,
} from '../assistant-history.js';

const user = (
  content: string,
  createdAt: number,
  extra: Partial<AssistantHistoryMessage> = {},
): AssistantHistoryMessage => ({
  role: 'user',
  content,
  createdAt,
  ...extra,
});

const assistant = (
  content: string,
  createdAt: number,
  extra: Partial<AssistantHistoryMessage> = {},
): AssistantHistoryMessage => ({
  role: 'assistant',
  content,
  createdAt,
  ...extra,
});

const sampleMessages: AssistantHistoryMessage[] = [
  user('这章讲什么?', 1, { action: 'chapterSummary' }),
  assistant('要点……', 2, { contextTruncated: true }),
  assistant('失败了一半', 3, { error: '请求超时。' }),
];

const twoSessions = (): AssistantHistoryStore => ({
  version: 2,
  activeId: 'b',
  conversations: [
    { id: 'a', title: '问A', messages: [user('问A', 1)], updatedAt: 10 },
    { id: 'b', title: '问B', messages: [user('问B', 2), assistant('答B', 3)], updatedAt: 20 },
  ],
});

describe('parseAssistantHistoryStore v1 → one conversation', () => {
  it('wraps a v1 messages file as a single conversation and keeps entries', () => {
    const json = JSON.stringify({
      version: 1,
      messages: sampleMessages,
      updatedAt: 99,
    });
    const store = parseAssistantHistoryStore(json);
    expect(store.version).toBe(2);
    expect(store.conversations).toHaveLength(1);
    expect(store.activeId).toBe(store.conversations[0]!.id);
    expect(store.conversations[0]!.messages).toEqual(sampleMessages);
    expect(store.conversations[0]!.title).toBe('');
    expect(store.conversations[0]!.updatedAt).toBe(99);
  });

  it('wraps a versionless {messages} envelope the same way', () => {
    const store = parseAssistantHistoryStore(
      JSON.stringify({ messages: [user('hello', 4)] }),
    );
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]!.messages).toEqual([user('hello', 4)]);
    expect(store.activeId).toBe(store.conversations[0]!.id);
  });

  it('round-trips a migrated v1 file as v2 without mixing a leftover messages array', () => {
    const migrated = parseAssistantHistoryStore(
      JSON.stringify({ version: 1, messages: [user('旧会话', 1)], updatedAt: 1 }),
    );
    const json = serializeAssistantHistoryStore(migrated);
    const envelope = JSON.parse(json) as {
      version: number;
      activeId: string;
      conversations: unknown[];
      messages?: unknown;
    };
    expect(envelope.version).toBe(2);
    expect(envelope.messages).toBeUndefined();
    expect(parseAssistantHistoryStore(json)).toEqual(migrated);
  });
});

describe('parseAssistantHistoryStore v2 isolation and activeId', () => {
  it('keeps two conversations separate and restores activeId', () => {
    const json = serializeAssistantHistoryStore(twoSessions());
    const parsed = parseAssistantHistoryStore(json);
    expect(parsed.activeId).toBe('b');
    expect(parsed.conversations.map((conversation) => conversation.id)).toEqual(['a', 'b']);
    expect(parsed.conversations[0]!.messages.map((message) => message.content)).toEqual(['问A']);
    expect(parsed.conversations[1]!.messages.map((message) => message.content)).toEqual([
      '问B',
      '答B',
    ]);
    expect(activeAssistantConversation(parsed)?.id).toBe('b');
  });

  it('does not mix a leftover v1 messages array into v2 conversations', () => {
    const parsed = parseAssistantHistoryStore(
      JSON.stringify({
        version: 2,
        activeId: 'a',
        messages: [user('不该出现', 0)],
        conversations: [
          { id: 'a', title: '问A', messages: [user('问A', 1)], updatedAt: 1 },
          { id: 'c', title: '问C', messages: [user('问C', 2)], updatedAt: 2 },
        ],
      }),
    );
    const contents = parsed.conversations.flatMap((conversation) =>
      conversation.messages.map((message) => message.content),
    );
    expect(contents).toEqual(['问A', '问C']);
    expect(contents).not.toContain('不该出现');
    expect(parsed.activeId).toBe('a');
  });

  it('falls back to the latest conversation when activeId is missing', () => {
    const parsed = parseAssistantHistoryStore(
      JSON.stringify({
        version: 2,
        activeId: 'gone',
        conversations: [
          { id: 'old', messages: [user('旧', 1)], updatedAt: 1 },
          { id: 'new', messages: [user('新', 2)], updatedAt: 9 },
        ],
      }),
    );
    expect(parsed.activeId).toBe('new');
  });
});

describe('parseAssistantHistoryStore defensive empty', () => {
  it('treats corrupt or malformed files as an empty store, never throws', () => {
    for (const raw of [
      '',
      '   ',
      '{not-json',
      'null',
      '[]',
      '42',
      '{"messages":"no"}',
      '{"version":2,"conversations":"no"}',
      '{"version":3,"conversations":[]}',
    ]) {
      expect(() => parseAssistantHistoryStore(raw)).not.toThrow();
      expect(parseAssistantHistoryStore(raw)).toEqual(emptyAssistantHistoryStore());
    }
  });

  it('drops invalid entries, duplicate ids, and caps hostile files', () => {
    const entries: Array<{ role: string; content: unknown; createdAt: number }> = Array.from(
      { length: 500 },
      (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `m${index}`,
        createdAt: index,
      }),
    );
    entries[4] = { role: 'tool', content: 'bad role', createdAt: 0 };
    const conversations = Array.from({ length: 120 }, (_, index) => ({
      id: index === 0 ? 'dup' : index === 1 ? 'dup' : `c${index}`,
      messages: index === 0 ? [...entries, { role: 'user', content: 42, createdAt: 0 }] : [],
      updatedAt: index,
    }));
    const parsed = parseAssistantHistoryStore(
      JSON.stringify({ version: 2, activeId: 'c2', conversations }),
    );
    expect(parsed.conversations).toHaveLength(ASSISTANT_HISTORY_MAX_CONVERSATIONS);
    expect(parsed.conversations[0]!.id).toBe('dup');
    expect(parsed.conversations.filter((conversation) => conversation.id === 'dup')).toHaveLength(
      1,
    );
    expect(parsed.conversations[0]!.messages).toHaveLength(ASSISTANT_HISTORY_MAX_MESSAGES);
    expect(
      parsed.conversations[0]!.messages.every((message) => typeof message.content === 'string'),
    ).toBe(true);
    expect(parsed.activeId).toBe('c2');
  });
});

describe('create / switch / delete / restore activeId', () => {
  it('creates a new empty session and makes it active without touching others', () => {
    const created = createAssistantConversation(twoSessions(), 50);
    expect(created.conversations).toHaveLength(3);
    expect(created.conversations[0]!.messages).toEqual(twoSessions().conversations[0]!.messages);
    expect(created.conversations[1]!.messages).toEqual(twoSessions().conversations[1]!.messages);
    expect(created.activeId).toBe(created.conversations[2]!.id);
    expect(created.activeId).not.toBe('a');
    expect(created.activeId).not.toBe('b');
    expect(activeAssistantConversation(created)?.messages).toEqual([]);
    expect(created.conversations[2]!.updatedAt).toBe(50);
  });

  it('switches activeId and round-trips it so reopen restores the last session', () => {
    const switched = switchAssistantConversation(twoSessions(), 'a');
    expect(switched.activeId).toBe('a');
    expect(switched.conversations).toEqual(twoSessions().conversations);
    const restored = parseAssistantHistoryStore(serializeAssistantHistoryStore(switched));
    expect(restored.activeId).toBe('a');
    expect(activeAssistantConversation(restored)?.messages.map((message) => message.content)).toEqual(
      ['问A'],
    );
    expect(switchAssistantConversation(switched, 'missing')).toEqual(switched);
  });

  it('deletes one session and leaves the other; activeId moves off the deleted one', () => {
    const deleted = deleteAssistantConversation(twoSessions(), 'b');
    expect(deleted.conversations).toHaveLength(1);
    expect(deleted.conversations[0]!.id).toBe('a');
    expect(deleted.conversations[0]!.messages).toEqual([user('问A', 1)]);
    expect(deleted.activeId).toBe('a');
    const otherBook = twoSessions();
    expect(otherBook.conversations).toHaveLength(2);
    expect(deleteAssistantConversation(deleted, 'missing')).toEqual(deleted);
    expect(deleteAssistantConversation(deleted, 'a')).toEqual(emptyAssistantHistoryStore());
  });

  it('rewrites title from the first user message when messages change', () => {
    const updated = setAssistantConversationMessages(
      twoSessions(),
      'a',
      [user('新的标题来自首条', 8), assistant('ok', 9)],
      80,
    );
    expect(updated.conversations[0]!.title).toBe('新的标题来自首条');
    expect(updated.conversations[0]!.updatedAt).toBe(80);
    expect(updated.conversations[1]!.messages).toEqual(twoSessions().conversations[1]!.messages);
    expect(updated.activeId).toBe('b');
  });
});

describe('assistantConversationTitle', () => {
  it('uses the first non-empty user message and truncates long titles', () => {
    expect(assistantConversationTitle([])).toBe('');
    expect(assistantConversationTitle([assistant('忽略', 1), user('  短问\n换行  ', 2)])).toBe(
      '短问 换行',
    );
    const long = '字'.repeat(ASSISTANT_CONVERSATION_TITLE_MAX_CHARS + 8);
    expect(assistantConversationTitle([user(long, 1)])).toBe(
      '字'.repeat(ASSISTANT_CONVERSATION_TITLE_MAX_CHARS),
    );
  });

  it('uses the selection body for explain-style messages, not the prompt', () => {
    expect(
      assistantConversationTitle([
        user('请解释下面选中文本的含义\n<selection>\n难句原文\n</selection>', 1, {
          action: 'explain',
        }),
      ]),
    ).toBe('难句原文');
  });

  it('leaves action-only prompts untitled so the UI can show the action name', () => {
    expect(
      assistantConversationTitle([user('请用要点总结当前章节的主要内容。', 1, { action: 'chapterSummary' })]),
    ).toBe('');
  });
});

describe('formatAssistantConversationTime', () => {
  it('uses relative minutes then a short date', () => {
    const now = Date.parse('2026-09-11T12:00:00Z');
    expect(formatAssistantConversationTime(now - 30_000, now, 'en')).toMatch(/minute|now|this/i);
    expect(formatAssistantConversationTime(now - 3 * 60_000, now, 'en')).toMatch(/3/);
    expect(formatAssistantConversationTime(now - 10 * 86_400_000, now, 'en')).toMatch(/Sep|9/);
  });
});

describe('serializeAssistantHistoryStore size limit', () => {
  it('rejects an oversized write instead of truncating messages', () => {
    const seeded = createAssistantConversation(emptyAssistantHistoryStore(), 1);
    const huge = setAssistantConversationMessages(
      seeded,
      seeded.activeId,
      [user('a'.repeat(ASSISTANT_HISTORY_MAX_BYTES), 1)],
      1,
    );
    expect(huge.conversations[0]!.messages[0]!.content).toHaveLength(ASSISTANT_HISTORY_MAX_BYTES);
    expect(() => serializeAssistantHistoryStore(huge)).toThrow(AssistantHistoryTooLargeError);
    try {
      serializeAssistantHistoryStore(huge);
      expect.unreachable('serialize should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantHistoryTooLargeError);
      const tooLarge = error as AssistantHistoryTooLargeError;
      expect(tooLarge.byteLength).toBeGreaterThan(ASSISTANT_HISTORY_MAX_BYTES);
      expect(tooLarge.limitBytes).toBe(ASSISTANT_HISTORY_MAX_BYTES);
    }
  });

  it('serializes a compact v2 envelope under the limit', () => {
    const json = serializeAssistantHistoryStore(twoSessions());
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(ASSISTANT_HISTORY_MAX_BYTES);
    expect(JSON.parse(json)).toMatchObject({
      version: 2,
      activeId: 'b',
    });
  });
});
