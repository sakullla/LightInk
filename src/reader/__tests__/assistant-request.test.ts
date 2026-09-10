/**
 * Contract for `src/reader/assistant-request.ts` (ADR-1 / R4 / R5):
 *
 * - 请求按 ① tools ② system ③ chapter ④ history ⑤ user 组装。
 * - 同章两问 ①②③ 字节一致；换章只改 ③。
 * - PDF 页码不进 ③，只写 ⑤；CBZ ③ 为空。
 * - 超预算丢最旧 ④，不丢 ①②③ 与本轮用户消息。
 */

import { describe, expect, it } from 'vitest';

import { READER_LIMITS } from '../reader-limits.js';
import {
  ASSISTANT_BUILTIN_TOOLS,
  assistantRequestPrefixBytes,
  buildAssistantChatRequest,
  formatAssistantChapterPrefix,
  formatAssistantUserMessage,
  type AssistantRequestTurn,
} from '../assistant-request.js';

const systemPrompt = '你是阅读器助手。';
const chapter = { kind: 'flow' as const, title: '第一章', text: '春江潮水连海平' };

describe('ASSISTANT_BUILTIN_TOOLS', () => {
  it('exposes exactly query_book then save_to_book', () => {
    expect(ASSISTANT_BUILTIN_TOOLS.map((tool) => tool.name)).toEqual([
      'query_book',
      'save_to_book',
    ]);
    expect(ASSISTANT_BUILTIN_TOOLS).toHaveLength(2);
    const queryEnum = (ASSISTANT_BUILTIN_TOOLS[0]?.parameters as { properties?: { action?: { enum?: unknown } } })
      .properties?.action?.enum;
    expect(queryEnum).toEqual([
      'toc',
      'current_chapter',
      'chapter',
      'selection',
      'book_info',
      'search',
    ]);
    const kindEnum = (ASSISTANT_BUILTIN_TOOLS[1]?.parameters as { properties?: { kind?: { enum?: unknown } } })
      .properties?.kind?.enum;
    expect(kindEnum).toEqual(['highlight', 'bookmark', 'note']);
  });
});

describe('formatAssistantChapterPrefix', () => {
  it('wraps flow chapter title and text, and clips at the registered limit', () => {
    expect(formatAssistantChapterPrefix(chapter)).toEqual({
      text: '【当前章节：第一章】\n<chapter>\n春江潮水连海平\n</chapter>',
      truncated: false,
    });
    expect(formatAssistantChapterPrefix({ kind: 'flow', title: '', text: '正文' }).text).toContain(
      '【当前章节】',
    );
    const long = '字'.repeat(READER_LIMITS.maxAssistantContextChars + 8);
    const clipped = formatAssistantChapterPrefix({ kind: 'flow', title: '长章', text: long });
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toContain('字'.repeat(READER_LIMITS.maxAssistantContextChars));
    expect(clipped.text).not.toContain('字'.repeat(READER_LIMITS.maxAssistantContextChars + 1));
  });

  it('omits page numbers from PDF title and body injection; CBZ is empty', () => {
    const pdf = formatAssistantChapterPrefix({
      kind: 'pdf',
      title: '第 3 / 10 页',
      text: '页上的句子',
    });
    expect(pdf.text).toBe('【当前页】\n<chapter>\n页上的句子\n</chapter>');
    expect(pdf.text).not.toContain('3');
    expect(pdf.text).not.toContain('10');
    expect(pdf.text).not.toContain('页码');
    expect(formatAssistantChapterPrefix({ kind: 'cbz', title: '1', text: 'ignored' })).toEqual({
      text: '',
      truncated: false,
    });
    expect(formatAssistantChapterPrefix(null)).toEqual({ text: '', truncated: false });
    expect(formatAssistantChapterPrefix({ kind: 'pdf', text: '  ' })).toEqual({
      text: '',
      truncated: false,
    });
  });
});

describe('formatAssistantUserMessage', () => {
  it('puts the PDF page number only on the user turn', () => {
    expect(formatAssistantUserMessage('这页讲什么？', 3)).toBe('【当前页码：3】\n这页讲什么？');
    expect(formatAssistantUserMessage('  普通问题  ')).toBe('普通问题');
    expect(formatAssistantUserMessage('x', 0)).toBe('x');
  });
});

describe('buildAssistantChatRequest', () => {
  it('assembles ① tools ② system ③ chapter ④ history ⑤ user', () => {
    const request = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      history: [
        { role: 'user', content: '上一问' },
        { role: 'assistant', content: '上一答' },
      ],
      userMessage: '这章讲什么？',
    });
    expect(request.tools).toBe(ASSISTANT_BUILTIN_TOOLS);
    expect(request.messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(request.messages[0]).toEqual({ role: 'system', content: systemPrompt });
    expect(request.messages[1]?.content).toContain('<chapter>\n春江潮水连海平\n</chapter>');
    expect(request.messages[2]?.content).toBe('上一问');
    expect(request.messages[4]).toEqual({ role: 'user', content: '这章讲什么？' });
    expect(request.truncated).toBe(false);
  });

  it('keeps ①②③ bytes identical across two asks in the same chapter', () => {
    const first = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      history: [],
      userMessage: '这章讲什么？',
    });
    const second = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      history: [
        { role: 'user', content: '这章讲什么？' },
        { role: 'assistant', content: '潮水与海' },
      ],
      userMessage: '再详细点',
    });
    expect(assistantRequestPrefixBytes(first)).toBe(assistantRequestPrefixBytes(second));
    expect(second.messages.map((message) => message.content)).toEqual([
      systemPrompt,
      first.messages[1]?.content,
      '这章讲什么？',
      '潮水与海',
      '再详细点',
    ]);
    expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools));
  });

  it('changes only ③ after a chapter switch and keeps ①②', () => {
    const first = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      userMessage: '问一',
    });
    const next = buildAssistantChatRequest({
      systemPrompt,
      chapter: { kind: 'flow', title: '第二章', text: '海上明月共潮生' },
      userMessage: '问二',
    });
    expect(first.tools).toEqual(next.tools);
    expect(first.messages[0]).toEqual(next.messages[0]);
    expect(first.messages[1]?.content).not.toBe(next.messages[1]?.content);
    expect(next.messages[1]?.content).toContain('第二章');
    expect(assistantRequestPrefixBytes(first)).not.toBe(assistantRequestPrefixBytes(next));
  });

  it('keeps PDF ③ free of page numbers when only the page label would change', () => {
    const pageThree = buildAssistantChatRequest({
      systemPrompt,
      chapter: { kind: 'pdf', title: '第 3 / 10 页', text: '同一页正文' },
      userMessage: '解释这句',
      page: 3,
    });
    const pageThreeAgain = buildAssistantChatRequest({
      systemPrompt,
      chapter: { kind: 'pdf', title: '第 3 / 10 页', text: '同一页正文' },
      history: [
        { role: 'user', content: '解释这句' },
        { role: 'assistant', content: '……' },
      ],
      userMessage: '还有呢',
      page: 3,
    });
    expect(assistantRequestPrefixBytes(pageThree)).toBe(assistantRequestPrefixBytes(pageThreeAgain));
    expect(pageThree.messages[1]?.content).toBe('【当前页】\n<chapter>\n同一页正文\n</chapter>');
    expect(pageThree.messages[1]?.content).not.toMatch(/3|10|页码/);
    expect(pageThree.messages[pageThree.messages.length - 1]?.content).toContain('【当前页码：3】');
  });

  it('omits ③ for CBZ so the prefix is tools + system only', () => {
    const request = buildAssistantChatRequest({
      systemPrompt,
      chapter: { kind: 'cbz', text: '' },
      userMessage: '这是谁？',
    });
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(JSON.parse(assistantRequestPrefixBytes(request)).messages).toHaveLength(1);
  });

  it('drops oldest history under budget and never drops ①②③ or the current user turn', () => {
    const history: AssistantRequestTurn[] = Array.from({ length: 8 }, (_, index) => ({
      role: 'user' as const,
      content: `old-${index}-${'x'.repeat(40)}`,
    }));
    const request = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      history,
      userMessage: '本轮问题',
      maxTurns: 2,
      charBudget: 80,
    });
    const roles = request.messages.map((message) => message.role);
    expect(roles[0]).toBe('system');
    expect(roles[1]).toBe('system');
    expect(roles[roles.length - 1]).toBe('user');
    expect(request.messages[request.messages.length - 1]?.content).toBe('本轮问题');
    expect(request.messages[0]?.content).toBe(systemPrompt);
    expect(request.messages[1]?.content).toContain('春江潮水连海平');
    expect(request.tools).toBe(ASSISTANT_BUILTIN_TOOLS);
    const historyContents = request.messages
      .slice(2, -1)
      .map((message) => message.content);
    expect(historyContents.every((content) => content.startsWith('old-'))).toBe(true);
    expect(historyContents.join()).not.toContain('old-0-');
  });

  it('skips empty assistant placeholders and keeps tool turns', () => {
    const request = buildAssistantChatRequest({
      systemPrompt,
      chapter,
      history: [
        { role: 'user', content: '查目录' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'query_book', arguments: '{}' }] },
        { role: 'tool', content: '{"toc":[]}', toolCallId: 'c1', name: 'query_book' },
        { role: 'assistant', content: '', toolCallId: undefined },
        { role: 'assistant', content: '   ' },
      ],
      userMessage: '继续',
    });
    expect(request.messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(request.messages[3]?.toolCalls?.[0]?.name).toBe('query_book');
    expect(request.messages[4]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
  });
});
