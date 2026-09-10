/**
 * Contract for `src/reader/assistant-history.ts` (R2 / R9):
 * v2 多会话文件往返、v1 迁移、坏文件视为空、标题取首条用户消息、体积上限、
 * 段的插入/删除/活动段回落。
 */

import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_HISTORY_MAX_MESSAGES,
  ASSISTANT_HISTORY_MAX_SESSIONS,
  assistantSessionOversized,
  assistantSessionTitle,
  capAssistantMessages,
  createAssistantSession,
  findAssistantSession,
  fitAssistantHistory,
  parseAssistantHistory,
  removeAssistantSession,
  serializeAssistantHistory,
  sortAssistantSessions,
  trimAssistantSessionToFit,
  upsertAssistantSession,
  utf8ByteLength,
  type AssistantHistoryFile,
  type AssistantMessage,
  type AssistantSession,
} from '../assistant-history.js';

const messagesA: AssistantMessage[] = [
  { role: 'user', content: '这章讲什么?', createdAt: 1, action: 'chapterSummary' },
  {
    role: 'assistant',
    content: '',
    createdAt: 2,
    contextTruncated: true,
    toolCalls: [{ id: 'c1', name: 'query_book', arguments: { action: 'outline' } }],
  },
  {
    role: 'tool',
    content: '',
    createdAt: 3,
    toolResults: [{ callId: 'c1', name: 'query_book', content: '{"items":[]}', isError: false }],
  },
  { role: 'assistant', content: '要点……', createdAt: 4 },
  { role: 'assistant', content: '半截', createdAt: 5, stopped: true },
  { role: 'assistant', content: '', createdAt: 6, error: '请求超时。' },
  { role: 'user', content: '总结本章', createdAt: 7, action: 'chapterSummary', sourceChapter: 2 },
  { role: 'assistant', content: '被截断的摘要', createdAt: 8, truncated: true },
  { role: 'user', content: '这页讲什么', createdAt: 9, action: 'chapterSummary', sourcePage: 12 },
  { role: 'assistant', content: '已存的摘要', createdAt: 10, savedAnnotation: true },
];

describe('assistant history v2 envelope', () => {
  it('round-trips sessions, active id and every message field', () => {
    const a: AssistantSession = { id: 'a', createdAt: 1, updatedAt: 6, messages: messagesA };
    const b: AssistantSession = {
      id: 'b',
      createdAt: 10,
      updatedAt: 11,
      messages: [{ role: 'user', content: '另一段', createdAt: 10 }],
    };
    const json = serializeAssistantHistory({ activeSessionId: 'b', sessions: [a, b] }, 99);
    const parsed = JSON.parse(json) as { version: number; updatedAt: number };
    expect(parsed.version).toBe(2);
    expect(parsed.updatedAt).toBe(99);
    const back = parseAssistantHistory(json);
    expect(back.activeSessionId).toBe('b');
    expect(back.sessions).toEqual([a, b]);
  });

  it('migrates a v1 single-conversation file into one session', () => {
    const v1 = JSON.stringify({
      version: 1,
      messages: [
        { role: 'user', content: '上次的问题', createdAt: 10 },
        { role: 'assistant', content: '上次的回答', createdAt: 11 },
      ],
      updatedAt: 12,
    });
    const file = parseAssistantHistory(v1);
    expect(file.sessions).toHaveLength(1);
    expect(file.activeSessionId).toBe(file.sessions[0]!.id);
    expect(file.sessions[0]!.updatedAt).toBe(12);
    expect(file.sessions[0]!.messages.map((message) => message.content)).toEqual([
      '上次的问题',
      '上次的回答',
    ]);
  });

  it('treats corrupt or malformed files as empty history, never throws', () => {
    for (const raw of ['', '   ', '{not-json', 'null', '[]', '{"sessions":"no"}', '{"messages":"no"}']) {
      expect(parseAssistantHistory(raw)).toEqual({ activeSessionId: null, sessions: [] });
    }
  });

  it('drops invalid entries, tool turns without results, and caps hostile files', () => {
    const entries: Array<Record<string, unknown>> = Array.from({ length: 500 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `m${index}`,
      createdAt: index,
    }));
    entries[4] = { role: 'system', content: 'bad role', createdAt: 0 };
    entries[6] = { role: 'tool', content: '', createdAt: 0 };
    const file = parseAssistantHistory(
      JSON.stringify({
        version: 2,
        activeSessionId: 'zzz',
        sessions: [
          { id: 's1', messages: [...entries, { role: 'user', content: 42 }] },
          { id: 's1', messages: [] },
          { id: '', messages: [] },
          ...Array.from({ length: ASSISTANT_HISTORY_MAX_SESSIONS + 5 }, (_, index) => ({
            id: `extra-${index}`,
            messages: [],
          })),
        ],
      }),
    );
    expect(file.sessions.length).toBe(ASSISTANT_HISTORY_MAX_SESSIONS);
    expect(file.sessions[0]!.id).toBe('s1');
    const kept = file.sessions[0]!.messages;
    expect(kept).toHaveLength(ASSISTANT_HISTORY_MAX_MESSAGES);
    expect(kept.every((message) => typeof message.content === 'string')).toBe(true);
    // 条数上限保留的是最新的尾部，且从一次用户提问开始。
    expect(kept[0]!.role).toBe('user');
    expect(kept[kept.length - 1]!.content).toBe('m499');
    // 未知活动 id 回落到首段。
    expect(file.activeSessionId).toBe('s1');
  });
});

describe('capAssistantMessages', () => {
  it('keeps the newest messages starting at an exchange boundary', () => {
    const messages: AssistantMessage[] = [
      { role: 'user', content: 'q1', createdAt: 1 },
      { role: 'assistant', content: 'a1', createdAt: 2 },
      { role: 'user', content: 'q2', createdAt: 3 },
      { role: 'assistant', content: '', createdAt: 4, toolCalls: [{ id: 'c', name: 'query_book', arguments: {} }] },
      { role: 'tool', content: '', createdAt: 5, toolResults: [{ callId: 'c', name: 'query_book', content: '{}', isError: false }] },
      { role: 'assistant', content: 'a2', createdAt: 6 },
    ];
    expect(capAssistantMessages(messages, 10)).toEqual(messages);
    // 限 3 条：从尾部数 3 条落在 tool 轮中间，前进到下一次用户提问……没有了，返回空尾部之前的最近完整交换起点。
    expect(capAssistantMessages(messages, 5).map((message) => message.content)).toEqual(['q2', '', '', 'a2']);
    expect(capAssistantMessages(messages, 4).map((message) => message.content)).toEqual(['q2', '', '', 'a2']);
    // 窗口里没有用户提问边界：退化为纯尾部切片，而不是清空对话。
    expect(capAssistantMessages(messages, 2).map((message) => message.content)).toEqual(['', 'a2']);
    expect(capAssistantMessages(messages, 1).map((message) => message.content)).toEqual(['a2']);
  });
});

describe('trimAssistantSessionToFit', () => {
  it('drops the oldest complete exchanges until the session fits, never the last one', () => {
    const exchange = (n: number, size: number): AssistantMessage[] => [
      { role: 'user', content: `q${n}`, createdAt: n },
      { role: 'assistant', content: 'x'.repeat(size), createdAt: n },
    ];
    const session: AssistantSession = {
      id: 's',
      createdAt: 1,
      updatedAt: 9,
      messages: [...exchange(1, 400), ...exchange(2, 400), ...exchange(3, 400)],
    };
    const fit = trimAssistantSessionToFit(session, 1200);
    expect(fit.fits).toBe(true);
    expect(fit.dropped).toBe(1);
    expect(fit.session.messages.map((m) => m.content).filter((c) => c.startsWith('q'))).toEqual(['q2', 'q3']);
    // 只剩最后一次交换仍超限：不再裁，报不合适。
    const stuck = trimAssistantSessionToFit(session, 300);
    expect(stuck.fits).toBe(false);
    expect(stuck.session.messages.map((m) => m.content).filter((c) => c.startsWith('q'))).toEqual(['q3']);
    // 本来就装得下：原样。
    expect(trimAssistantSessionToFit(session, 100_000)).toMatchObject({ dropped: 0, fits: true, session });
  });
});

describe('assistant session helpers', () => {
  it('titles a session by its first user message, stripped and clipped', () => {
    const session = createAssistantSession(1);
    expect(assistantSessionTitle(session, '新对话')).toBe('新对话');
    const quoted: AssistantSession = {
      ...session,
      messages: [
        {
          role: 'user',
          content: '请解释：\n<selection>\n一段引文\n</selection>',
          createdAt: 1,
          action: 'explain',
        },
      ],
    };
    expect(assistantSessionTitle(quoted, 'x')).toBe('请解释：');
    const long: AssistantSession = {
      ...session,
      messages: [{ role: 'user', content: '字'.repeat(60), createdAt: 1 }],
    };
    expect(assistantSessionTitle(long, 'x')).toBe(`${'字'.repeat(40)}…`);
    const assistantFirst: AssistantSession = {
      ...session,
      messages: [{ role: 'assistant', content: '我先说', createdAt: 1 }],
    };
    expect(assistantSessionTitle(assistantFirst, 'fallback')).toBe('fallback');
  });

  it('flags a session that exceeds the 2 MiB byte limit', () => {
    const small: AssistantSession = {
      ...createAssistantSession(1),
      messages: [{ role: 'user', content: 'a'.repeat(1024), createdAt: 1 }],
    };
    expect(assistantSessionOversized(small)).toBe(false);
    const huge: AssistantSession = {
      ...createAssistantSession(1),
      messages: [{ role: 'assistant', content: '汉'.repeat(1024 * 1024), createdAt: 1 }],
    };
    expect(assistantSessionOversized(huge)).toBe(true);
  });

  it('fits the whole file under the byte limit by dropping the oldest inactive sessions', () => {
    const big = (id: string, updatedAt: number): AssistantSession => ({
      id,
      createdAt: updatedAt,
      updatedAt,
      messages: [{ role: 'assistant', content: 'x'.repeat(900 * 1024), createdAt: updatedAt }],
    });
    const file: AssistantHistoryFile = {
      activeSessionId: 'c',
      sessions: [big('a', 1), big('b', 2), big('c', 3)],
    };
    const fitted = fitAssistantHistory(file, 'c');
    expect(fitted.fits).toBe(true);
    expect(fitted.dropped).toBe(1);
    expect(fitted.file.sessions.map((item) => item.id)).toEqual(['b', 'c']);
    expect(fitted.file.activeSessionId).toBe('c');
    // 合适时直接给出序列化结果，调用方不必再序列化一次。
    expect(parseAssistantHistory(fitted.json!)).toEqual({ activeSessionId: 'c', sessions: fitted.file.sessions });
    // 活动段自己就超限：不丢活动段，报不合适。
    const only: AssistantHistoryFile = {
      activeSessionId: 'z',
      sessions: [
        { ...big('z', 9), messages: [{ role: 'assistant', content: 'x'.repeat(2 * 1024 * 1024 + 8), createdAt: 9 }] },
        big('a', 1),
      ],
    };
    const stuck = fitAssistantHistory(only, 'z');
    expect(stuck.fits).toBe(false);
    expect(stuck.dropped).toBe(1);
    expect(stuck.file.sessions.map((item) => item.id)).toEqual(['z']);
    expect(stuck.json).toBeNull();
    // 本来就装得下：原样返回。
    const small = fitAssistantHistory({ activeSessionId: 'a', sessions: [createAssistantSession(1)] }, 'a');
    expect(small).toMatchObject({ dropped: 0, fits: true });
    // 贴着上限：估算与写出用同一个时间戳，fits 为真时 json 一定不超限。
    const two: AssistantHistoryFile = {
      activeSessionId: 'a',
      sessions: [
        { id: 'a', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: '甲', createdAt: 1 }] },
        { id: 'b', createdAt: 3, updatedAt: 4, messages: [{ role: 'user', content: '乙', createdAt: 3 }] },
      ],
    };
    const exact = utf8ByteLength(serializeAssistantHistory(two));
    const tight = fitAssistantHistory(two, 'a', exact);
    expect(tight.fits).toBe(true);
    expect(tight.dropped).toBe(0);
    expect(utf8ByteLength(tight.json!)).toBeLessThanOrEqual(exact);
    const over = fitAssistantHistory(two, 'a', exact - 1);
    expect(over.dropped).toBe(1);
    expect(over.file.sessions.map((item) => item.id)).toEqual(['a']);
    expect(utf8ByteLength(over.json!)).toBeLessThanOrEqual(exact - 1);
  });

  it('upserts, sorts, removes and re-targets the active session', () => {
    const a: AssistantSession = { id: 'a', createdAt: 1, updatedAt: 5, messages: [] };
    const b: AssistantSession = { id: 'b', createdAt: 2, updatedAt: 9, messages: [] };
    let file = upsertAssistantSession({ activeSessionId: null, sessions: [] }, a);
    file = upsertAssistantSession(file, b);
    expect(file.activeSessionId).toBe('b');
    expect(sortAssistantSessions(file.sessions).map((item) => item.id)).toEqual(['b', 'a']);
    const updated = upsertAssistantSession(file, { ...a, updatedAt: 20 });
    expect(updated.sessions.find((item) => item.id === 'a')?.updatedAt).toBe(20);
    expect(updated.sessions).toHaveLength(2);
    const removed = removeAssistantSession(updated, 'a');
    expect(removed.sessions.map((item) => item.id)).toEqual(['b']);
    expect(removed.activeSessionId).toBe('b');
    expect(findAssistantSession(removed, 'a')).toBeNull();
    expect(removeAssistantSession(removed, 'b').activeSessionId).toBeNull();
    // 超段数上限时丢最旧的段。
    let many: AssistantHistoryFile = { activeSessionId: null, sessions: [] };
    for (let index = 0; index < ASSISTANT_HISTORY_MAX_SESSIONS + 3; index += 1) {
      many = upsertAssistantSession(many, {
        id: `s${index}`,
        createdAt: index,
        updatedAt: index,
        messages: [],
      });
    }
    expect(many.sessions).toHaveLength(ASSISTANT_HISTORY_MAX_SESSIONS);
    expect(many.sessions.some((item) => item.id === 's0')).toBe(false);
  });
});
