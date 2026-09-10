/**
 * Contract for `src/reader/assistant-request.ts` (R4 / R5):
 * 分层请求（①②③ 固定、④ 按交换裁剪、⑤ 本轮总是全带）、章节截断、工具轮次
 * 映射（悬空调用剥离）、流式通道终态含工具调用、中止命令。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  abortAssistantChat,
  assistantContextBlock,
  buildAssistantRequest,
  clipAssistantContext,
  clipToBytes,
  requestByteLength,
  stripControlChars,
  ASSISTANT_ELIDED_RESULT,
  exchangeToTurns,
  serializeAssistantRequest,
  streamAssistantChat,
  type AiToolDefView,
} from '../assistant-request.js';
import type { AssistantMessage } from '../assistant-history.js';
import { READER_LIMITS } from '../reader-limits.js';

const tools: AiToolDefView[] = [
  { name: 'query_book', description: 'q', inputSchema: { type: 'object' } },
  { name: 'save_to_book', description: 's', inputSchema: { type: 'object' } },
];

describe('clipAssistantContext / assistantContextBlock', () => {
  it('keeps short chapters whole and marks long ones truncated at the head', () => {
    expect(clipAssistantContext('  短章  ')).toEqual({ text: '短章', truncated: false });
    const long = 'a'.repeat(READER_LIMITS.maxAssistantContextChars + 5);
    const clipped = clipAssistantContext(long);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe('a'.repeat(READER_LIMITS.maxAssistantContextChars));
  });

  it('never splits a surrogate pair at the cut boundary', () => {
    const emoji = '😀'.repeat(READER_LIMITS.maxAssistantContextChars + 1);
    const clipped = clipAssistantContext(emoji);
    expect(clipped.text.length % 2).toBe(0);
    expect(clipped.text).not.toContain('\u{FFFD}');
  });

  it('builds the chapter block only when text exists', () => {
    expect(assistantContextBlock(null)).toBeNull();
    expect(assistantContextBlock({ title: 'x', text: '' })).toBeNull();
    expect(assistantContextBlock({ title: '第一章', text: '正文' })).toBe(
      '【当前章节：第一章】\n<chapter>\n正文\n</chapter>',
    );
    expect(assistantContextBlock({ title: '', text: '正文' })).toContain('【当前章节】');
  });
});

describe('exchangeToTurns', () => {
  it('maps tool turns and strips unanswered tool calls', () => {
    const answered: AssistantMessage[] = [
      { role: 'user', content: '问', createdAt: 1 },
      {
        role: 'assistant',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: { action: 'outline' } }],
      },
      {
        role: 'tool',
        content: '',
        createdAt: 3,
        toolResults: [{ callId: 'c1', name: 'query_book', content: '{}', isError: false }],
      },
      { role: 'assistant', content: '答', createdAt: 4 },
    ];
    expect(exchangeToTurns(answered)).toEqual([
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: { action: 'outline' } }],
      },
      {
        role: 'user',
        content: '',
        toolResults: [{ callId: 'c1', name: 'query_book', content: '{}', isError: false }],
      },
      { role: 'assistant', content: '答' },
    ]);

    // 磁盘恢复的历史可能带不成对的结果：只保留有对应调用的项。
    const extra: AssistantMessage[] = [
      { role: 'user', content: '问', createdAt: 1 },
      {
        role: 'assistant',
        content: '',
        createdAt: 2,
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: {} }],
      },
      {
        role: 'tool',
        content: '',
        createdAt: 3,
        toolResults: [
          { callId: 'ghost', name: 'query_book', content: '{}', isError: false },
          { callId: 'c1', name: 'query_book', content: '{"ok":1}', isError: false },
        ],
      },
    ];
    const extraTurns = exchangeToTurns(extra);
    expect(extraTurns[2]?.toolResults?.map((result) => result.callId)).toEqual(['c1']);
    // 同一 callId 重复出现：只保留第一条，避免 API 报重复 tool_result。
    const duplicated: AssistantMessage[] = [
      extra[0]!,
      extra[1]!,
      {
        ...extra[2]!,
        toolResults: [
          { callId: 'c1', name: 'query_book', content: '{"first":1}', isError: false },
          { callId: 'c1', name: 'query_book', content: '{"second":2}', isError: true },
        ],
      },
    ];
    expect(exchangeToTurns(duplicated)[2]?.toolResults).toEqual([
      { callId: 'c1', name: 'query_book', content: '{"first":1}', isError: false },
    ]);
    const onlyGhost: AssistantMessage[] = [
      extra[0]!,
      extra[1]!,
      { ...extra[2]!, toolResults: [{ callId: 'ghost', name: 'query_book', content: '{}', isError: false }] },
    ];
    // 全是幽灵结果：调用被剥掉，结果轮也不进请求。
    expect(exchangeToTurns(onlyGhost)).toEqual([{ role: 'user', content: '问' }]);

    const dangling: AssistantMessage[] = [
      { role: 'user', content: '问', createdAt: 1 },
      {
        role: 'assistant',
        content: '先看看',
        createdAt: 2,
        stopped: true,
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: {} }],
      },
      { role: 'assistant', content: '', createdAt: 3, error: '超时' },
      { role: 'assistant', content: '   ', createdAt: 4 },
    ];
    expect(exchangeToTurns(dangling)).toEqual([
      { role: 'user', content: '问' },
      { role: 'assistant', content: '先看看' },
    ]);
  });
});

describe('buildAssistantRequest layering (R4)', () => {
  const base = {
    tools,
    systemPrompt: 'SYS',
    context: '【当前章节：第一章】\n<chapter>\n正文\n</chapter>',
  };

  it('keeps ①②③ identical across follow-ups in the same chapter and only grows turns', () => {
    const first = buildAssistantRequest({
      ...base,
      requestId: 'r1',
      messages: [{ role: 'user', content: '第一问', createdAt: 1 }],
      currentStart: 0,
    });
    const second = buildAssistantRequest({
      ...base,
      requestId: 'r2',
      messages: [
        { role: 'user', content: '第一问', createdAt: 1 },
        { role: 'assistant', content: '答一', createdAt: 2 },
        { role: 'user', content: '追问', createdAt: 3 },
      ],
      currentStart: 2,
    });
    const a = serializeAssistantRequest(first);
    const b = serializeAssistantRequest(second);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.system).toBe(b.system);
    expect(a.context).toBe(b.context);
    expect(second.turns.map((turn) => turn.content)).toEqual(['第一问', '答一', '追问']);
    expect(first.turns.map((turn) => turn.content)).toEqual(['第一问']);
  });

  it('drops the oldest exchanges by budget but always keeps the current turn intact', () => {
    const messages: AssistantMessage[] = [
      { role: 'user', content: 'q1', createdAt: 1 },
      { role: 'assistant', content: 'a1'.repeat(30), createdAt: 2 },
      { role: 'user', content: 'q2', createdAt: 3 },
      { role: 'assistant', content: 'a2', createdAt: 4 },
      { role: 'user', content: 'q3', createdAt: 5 },
      {
        role: 'assistant',
        content: '',
        createdAt: 6,
        toolCalls: [{ id: 'c', name: 'query_book', arguments: { action: 'chapter', chapter_index: 2 } }],
      },
      {
        role: 'tool',
        content: '',
        createdAt: 7,
        toolResults: [{ callId: 'c', name: 'query_book', content: 'x'.repeat(5000), isError: false }],
      },
    ];
    const request = buildAssistantRequest({
      ...base,
      requestId: 'r',
      messages,
      currentStart: 4,
      charBudget: 3,
    });
    // 历史全部超预算被丢，但本轮（提问 + 工具往返）完整保留。
    expect(request.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(request.turns[0]!.content).toBe('q3');
    expect(request.turns[2]!.toolResults?.[0]?.content.length).toBe(5000);

    const roomy = buildAssistantRequest({
      ...base,
      requestId: 'r',
      messages,
      currentStart: 4,
      charBudget: 10,
    });
    // 预算够一个交换（q2+a2 = 4 字符）：只带最近的 q2/a2，不带更早的 q1/a1（62 字符）。
    expect(roomy.turns.map((turn) => turn.content).slice(0, 2)).toEqual(['q2', 'a2']);
    expect(roomy.turns.some((turn) => turn.content === 'q1')).toBe(false);

    const capped = buildAssistantRequest({
      ...base,
      requestId: 'r',
      messages,
      currentStart: 4,
      maxTurns: 2,
    });
    expect(capped.turns.map((turn) => turn.content).slice(0, 2)).toEqual(['q2', 'a2']);
  });

  it('carries no context when the format has no chapter text', () => {
    const request = buildAssistantRequest({
      tools,
      systemPrompt: 'SYS',
      context: null,
      requestId: 'r',
      messages: [{ role: 'user', content: 'q', createdAt: 1 }],
      currentStart: 0,
    });
    expect(serializeAssistantRequest(request).context).toBeNull();
  });
});

describe('buildAssistantRequest byte safety', () => {
  it('strips the control characters Rust rejects from every text field', () => {
    const dirty = 'A\u0092B\u0000C\tD\nE';
    expect(stripControlChars(dirty)).toBe('ABC\tD\nE');
    const request = buildAssistantRequest({
      requestId: 'r',
      tools: [],
      systemPrompt: 'sys\u0085',
      context: 'ctx\u001b[0m',
      messages: [
        { role: 'user', content: '问\u0007', createdAt: 1 },
        { role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'c1', name: 'query_book', arguments: {} }] },
        { role: 'tool', content: '', createdAt: 3, toolResults: [{ callId: 'c1', name: 'query_book', content: '{"x":"\u009f"}', isError: false }] },
        { role: 'assistant', content: '', createdAt: 4 },
      ],
      currentStart: 0,
    });
    expect(request.system).toBe('sys');
    expect(request.context).toBe('ctx[0m');
    expect(request.turns[0]?.content).toBe('问');
    expect(request.turns[2]?.toolResults?.[0]?.content).toBe('{"x":""}');
  });

  it('budgets history by UTF-8 bytes, not characters', () => {
    const cjk = '字'.repeat(1000); // 3000 字节
    const messages: AssistantMessage[] = [
      { role: 'user', content: cjk, createdAt: 1 },
      { role: 'assistant', content: cjk, createdAt: 2 },
      { role: 'user', content: '短', createdAt: 3 },
      { role: 'assistant', content: '短答', createdAt: 4 },
      { role: 'user', content: '现在', createdAt: 5 },
      { role: 'assistant', content: '', createdAt: 6 },
    ];
    // 5000 字节的历史预算装得下第二次交换（十几字节）但装不下第一次（6000 字节）。
    const request = buildAssistantRequest({
      requestId: 'r',
      tools: [],
      systemPrompt: 's',
      context: null,
      messages,
      currentStart: 4,
      charBudget: 5000,
    });
    expect(request.turns.map((turn) => turn.content)).toEqual(['短', '短答', '现在']);
    expect(requestByteLength(cjk)).toBe(3000);
  });

  it('elides the oldest tool results of the current exchange instead of exceeding the request limit', () => {
    const big = '正'.repeat(2000); // 6000 字节
    const messages: AssistantMessage[] = [
      { role: 'user', content: '读三章', createdAt: 1 },
      { role: 'assistant', content: '', createdAt: 2, toolCalls: [{ id: 'c1', name: 'query_book', arguments: {} }] },
      { role: 'tool', content: '', createdAt: 3, toolResults: [{ callId: 'c1', name: 'query_book', content: big, isError: false }] },
      { role: 'assistant', content: '', createdAt: 4, toolCalls: [{ id: 'c2', name: 'query_book', arguments: {} }] },
      { role: 'tool', content: '', createdAt: 5, toolResults: [{ callId: 'c2', name: 'query_book', content: big, isError: false }] },
      { role: 'assistant', content: '', createdAt: 6 },
    ];
    const request = buildAssistantRequest({
      requestId: 'r',
      tools: [],
      systemPrompt: 's',
      context: null,
      messages,
      currentStart: 0,
      maxBytes: 7000,
    });
    const results = request.turns.filter((turn) => turn.toolResults !== undefined).map((turn) => turn.toolResults![0]!.content);
    // 第一份结果被换成占位符，第二份保留；调用/结果配对完整。
    expect(results[0]).toBe(ASSISTANT_ELIDED_RESULT);
    expect(results[1]).toBe(big);
    expect(request.turns.filter((turn) => turn.toolCalls !== undefined)).toHaveLength(2);
    const total = request.turns.reduce((sum, turn) => sum + requestByteLength(turn.content) + (turn.toolResults ?? []).reduce((inner, r) => inner + requestByteLength(r.content), 0), 0);
    expect(total).toBeLessThanOrEqual(7000);
  });

  it('clips to a byte limit without splitting surrogate pairs', () => {
    expect(clipToBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(clipToBytes('字字字', 7)).toEqual({ text: '字字', truncated: true });
    const emoji = '\u{1F600}\u{1F600}';
    expect(clipToBytes(emoji, 5).text).toBe('\u{1F600}');
  });
});

describe('streamAssistantChat / abortAssistantChat', () => {
  it('forwards channel deltas and parses the terminal state with tool calls', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onEvent as { onmessage: (event: unknown) => void };
      channel.onmessage({ type: 'delta', text: '你' });
      channel.onmessage({ type: 'delta', text: '好' });
      channel.onmessage({ type: 'ignore' });
      return {
        finish: 'tool_calls',
        totalChars: 2,
        toolCalls: [
          { id: 'c1', name: 'query_book', arguments: { action: 'outline' } },
          { id: '', name: 'save_to_book', arguments: 'bad' },
          { id: 'x', name: '', arguments: {} },
        ],
      };
    });
    const deltas: string[] = [];
    const done = await streamAssistantChat(
      {
        requestId: 'r',
        system: 'S',
        context: null,
        tools,
        turns: [{ role: 'user', content: 'hi' }],
      },
      (delta) => deltas.push(delta),
      { invoke, createChannel: () => ({ onmessage: () => undefined }) },
    );
    expect(deltas).toEqual(['你', '好']);
    expect(done.finish).toBe('tool_calls');
    expect(done.toolCalls).toEqual([
      { id: 'c1', name: 'query_book', arguments: { action: 'outline' } },
      { id: 'call_1', name: 'save_to_book', arguments: {} },
    ]);
    const payload = invoke.mock.calls[0]?.[1] as { request: Record<string, unknown> };
    expect(payload.request.requestId).toBe('r');
    expect(payload.request.turns).toEqual([{ role: 'user', content: 'hi' }]);
    expect(payload.request.tools).toHaveLength(2);
  });

  it('normalizes a missing terminal payload and swallows abort failures', async () => {
    const done = await streamAssistantChat(
      { requestId: 'r', system: 'S', context: null, tools: [], turns: [] },
      () => undefined,
      { invoke: vi.fn(async () => undefined), createChannel: () => ({ onmessage: () => undefined }) },
    );
    expect(done).toEqual({ finish: 'closed', totalChars: 0, toolCalls: [] });
    const invoke = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(abortAssistantChat('r', { invoke })).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('ai_chat_abort', { requestId: 'r' });
  });
});
