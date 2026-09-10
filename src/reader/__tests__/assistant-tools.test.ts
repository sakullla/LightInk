/**
 * Contract for `src/reader/assistant-tools.ts` (R6 / R7 / R10):
 * 只有两个工具；查询按 action 分派（目录不含正文、搜索只给摘录、指定章才给
 * 正文且截断标记）；保存需确认、拒绝不写入；12 章上限；未知工具回传错误。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_MAX_CHAPTER_READS,
  ASSISTANT_TOOLS,
  assistantLocateHref,
  createAssistantToolBudget,
  describeAssistantToolCall,
  executeAssistantTool,
  matchOutlineTitle,
  parseAssistantLocate,
  type AssistantBookAccess,
  type AssistantSaveOutcome,
} from '../assistant-tools.js';
import type { AssistantToolCall } from '../assistant-history.js';

function fakeAccess(overrides: Partial<AssistantBookAccess> = {}): AssistantBookAccess & {
  readonly calls: { save: unknown[] };
} {
  const calls = { save: [] as unknown[] };
  return {
    calls,
    bookInfo: () => ({ title: '书名', format: 'epub', chapterCount: 30, pageCount: null, hasText: true }),
    outline: () =>
      Array.from({ length: 30 }, (_, index) => ({
        title: index === 3 || index === 4 ? '重复标题' : `第${index + 1}章`,
        chapter: index,
      })),
    currentChapter: () => ({ title: '第一章', text: '当前章正文', chapter: 0 }),
    chapterAt: async (index) =>
      index >= 0 && index < 30
        ? { title: `第${index + 1}章`, text: `第${index + 1}章正文 `.repeat(3), chapter: index }
        : null,
    selection: () => '',
    search: async (query, limit) => ({
      hits: Array.from({ length: Math.min(limit, 3) }, (_, index) => ({
        chapter: index,
        title: `第${index + 1}章`,
        snippet: `…${query}…`,
      })),
      hasMore: false,
      partial: false,
    }),
    save: async (request) => {
      calls.save.push(request);
      return { ok: true, kind: request.kind } satisfies AssistantSaveOutcome;
    },
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>, id = 'c1'): AssistantToolCall {
  return { id, name, arguments: args };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe('built-in tool catalogue (R6/R7)', () => {
  it('exposes exactly query_book and save_to_book in a stable order', () => {
    expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toEqual(['query_book', 'save_to_book']);
    const save = ASSISTANT_TOOLS[1]!.inputSchema as { properties: { kind: { enum: string[] } } };
    expect(save.properties.kind.enum).toEqual(['highlight', 'bookmark', 'note']);
    const query = ASSISTANT_TOOLS[0]!.inputSchema as { properties: { action: { enum: string[] } } };
    expect(query.properties.action.enum).toEqual([
      'outline',
      'current_chapter',
      'chapter',
      'selection',
      'book_info',
      'search',
    ]);
    expect(ASSISTANT_TOOLS.some((tool) => /save_(annotation|note|bookmark)/.test(tool.name))).toBe(false);
  });

  it('formats and parses locate links', () => {
    expect(assistantLocateHref({ kind: 'chapter', index: 2 })).toBe('lightink://chapter/2');
    expect(assistantLocateHref({ kind: 'page', page: 12 })).toBe('lightink://page/12');
    expect(parseAssistantLocate('lightink://chapter/2')).toEqual({ kind: 'chapter', index: 2 });
    expect(parseAssistantLocate('LIGHTINK://page/12/')).toEqual({ kind: 'page', page: 12 });
    expect(parseAssistantLocate('lightink://page/0')).toBeNull();
    expect(parseAssistantLocate('https://example.com')).toBeNull();
    expect(parseAssistantLocate('lightink://chapter/x')).toBeNull();
  });
});

describe('query_book', () => {
  it('returns the outline without body text and marks truncation', async () => {
    const access = fakeAccess({
      outline: () => Array.from({ length: 400 }, (_, index) => ({ title: `T${index}`, chapter: index })),
    });
    const result = await executeAssistantTool(call('query_book', { action: 'outline' }), access, createAssistantToolBudget());
    expect(result.isError).toBe(false);
    const payload = parse(result.content) as { items: Array<{ title: string; locate: string }>; total: number; truncated: boolean };
    expect(payload.total).toBe(400);
    expect(payload.items).toHaveLength(300);
    expect(payload.truncated).toBe(true);
    expect(payload.items[0]).toEqual({ title: 'T0', chapterIndex: 0, locate: 'lightink://chapter/0' });
    expect(result.content).not.toContain('正文');
  });

  it('reads a chapter by index or title and reports ambiguity / not found', async () => {
    const access = fakeAccess();
    const budget = createAssistantToolBudget();
    const byIndex = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: 2 }), access, budget)).content,
    );
    expect(byIndex.chapterIndex).toBe(2);
    expect(byIndex.text).toContain('第3章正文');
    expect(byIndex.truncated).toBe(false);
    expect(byIndex.locate).toBe('lightink://chapter/2');

    const byTitle = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_title: '第10章' }), access, budget)).content,
    );
    expect(byTitle.chapterIndex).toBe(9);

    const ambiguous = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_title: '重复标题' }), access, budget)).content,
    );
    expect(ambiguous.ambiguous).toBe(true);
    expect((ambiguous.candidates as unknown[]).length).toBe(2);

    const missing = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_title: '不存在' }), access, budget)).content,
    );
    expect(missing.notFound).toBe(true);

    const outOfRange = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: 99 }), access, budget)).content,
    );
    expect(outOfRange.notFound).toBe(true);
    // 只有真正取到正文的章计入预算。
    expect(budget.chaptersRead.size).toBe(2);

    const noTarget = await executeAssistantTool(call('query_book', { action: 'chapter' }), access, budget);
    expect(noTarget.isError).toBe(true);
  });

  it('truncates long chapter text at the existing limit and says so', async () => {
    const access = fakeAccess({
      chapterAt: async () => ({ title: '长章', text: '字'.repeat(50), chapter: 1 }),
    });
    const payload = parse(
      (await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: 1 }), access, createAssistantToolBudget(), 10)).content,
    );
    expect(payload.text).toBe('字'.repeat(10));
    expect(payload.truncated).toBe(true);
    expect(String(payload.note)).toContain('10');
  });

  it('stops after 12 distinct chapters within one question', async () => {
    const access = fakeAccess();
    const budget = createAssistantToolBudget();
    for (let index = 0; index < ASSISTANT_MAX_CHAPTER_READS; index += 1) {
      const result = await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: index }), access, budget);
      expect(result.isError).toBe(false);
    }
    const again = await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: 0 }), access, budget);
    expect(again.isError).toBe(false); // 重复读同一章不占新额度
    const thirteenth = await executeAssistantTool(call('query_book', { action: 'chapter', chapter_index: 20 }), access, budget);
    expect(thirteenth.isError).toBe(true);
    expect(parse(thirteenth.content).error).toContain(String(ASSISTANT_MAX_CHAPTER_READS));
    expect(budget.chaptersRead.size).toBe(ASSISTANT_MAX_CHAPTER_READS);
  });

  it('searches with snippets only, respects max_results, and reports more/partial', async () => {
    const search = vi.fn(async (query: string, limit: number) => ({
      hits: Array.from({ length: limit + 5 }, (_, index) => ({ chapter: index, snippet: `…${query}…` })),
      hasMore: true,
      partial: true,
    }));
    const access = fakeAccess({ search });
    const result = await executeAssistantTool(
      call('query_book', { action: 'search', query: '龙', max_results: 5 }),
      access,
      createAssistantToolBudget(),
    );
    expect(search).toHaveBeenCalledWith('龙', 5);
    const payload = parse(result.content) as { hits: Array<{ snippet: string; locate: string }>; hasMore: boolean; partial: boolean; count: number };
    expect(payload.count).toBe(5);
    expect(payload.hits[0]).toEqual({ chapterIndex: 0, snippet: '…龙…', locate: 'lightink://chapter/0' });
    expect(payload.hasMore).toBe(true);
    expect(payload.partial).toBe(true);
    expect(result.content).not.toContain('正文');
    const empty = await executeAssistantTool(call('query_book', { action: 'search', query: '   ' }), access, createAssistantToolBudget());
    expect(empty.isError).toBe(true);
    const defaults = await executeAssistantTool(call('query_book', { action: 'search', query: 'x', max_results: 999 }), access, createAssistantToolBudget());
    expect(search).toHaveBeenLastCalledWith('x', 50);
    expect(parse(defaults.content).count).toBe(50);
  });

  it('tells the per-chapter cap apart from max_results and forwards save notes', async () => {
    const search = vi.fn(async () => ({
      hits: [{ chapter: 0, snippet: '…龙…' }],
      hasMore: false,
      partial: false,
      chapterCapped: true,
    }));
    const capped = await executeAssistantTool(
      call('query_book', { action: 'search', query: '龙' }),
      fakeAccess({ search }),
      createAssistantToolBudget(),
    );
    const payload = parse(capped.content) as { hasMore: boolean; note?: string };
    expect(payload.hasMore).toBe(false);
    expect(payload.note).toContain('每章');
    expect(payload.note).not.toContain('max_results');
    const save = vi.fn(async () => ({ ok: true as const, kind: 'bookmark' as const, message: '该位置已有书签，未重复添加。' }));
    const saved = await executeAssistantTool(
      call('save_to_book', { kind: 'bookmark' }),
      fakeAccess({ save }),
      createAssistantToolBudget(),
    );
    expect(parse(saved.content)).toMatchObject({ saved: true, note: '该位置已有书签，未重复添加。' });
  });

  it('echoes the query that was actually searched and flags truncation', async () => {
    const search = vi.fn(async () => ({ hits: [], hasMore: false, partial: false }));
    const long = '龙'.repeat(260);
    const result = await executeAssistantTool(
      call('query_book', { action: 'search', query: long }),
      fakeAccess({ search }),
      createAssistantToolBudget(),
    );
    expect(search).toHaveBeenCalledWith('龙'.repeat(200), expect.any(Number));
    const payload = parse(result.content) as { query: string; queryTruncated?: boolean; note?: string };
    expect(payload.query).toBe('龙'.repeat(200));
    expect(payload.queryTruncated).toBe(true);
    expect(payload.note).toContain('200');
    expect(payload.note).toContain('没有找到');
  });

  it('caps chapter payloads by bytes so CJK chapters cannot blow the request limit', async () => {
    const chapterAt = vi.fn(async (index: number) => ({ title: '长章', text: '字'.repeat(20_000), chapter: index }));
    const result = await executeAssistantTool(
      call('query_book', { action: 'chapter', chapter_index: 0 }),
      fakeAccess({ chapterAt }),
      createAssistantToolBudget(),
    );
    const payload = parse(result.content) as { text: string; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(new TextEncoder().encode(payload.text).length).toBeLessThanOrEqual(36 * 1024);
  });

  it('answers current chapter, selection and book info; rejects unknown actions', async () => {
    const access = fakeAccess({ selection: () => '  选中的话  ' });
    const budget = createAssistantToolBudget();
    const current = parse((await executeAssistantTool(call('query_book', { action: 'current_chapter' }), access, budget)).content);
    expect(current.text).toBe('当前章正文');
    const selection = parse((await executeAssistantTool(call('query_book', { action: 'selection' }), access, budget)).content);
    expect(selection.text).toBe('选中的话');
    const info = parse((await executeAssistantTool(call('query_book', { action: 'book_info' }), access, budget)).content);
    expect(info.title).toBe('书名');
    expect(info.chapterCount).toBe(30);
    const none = parse(
      (await executeAssistantTool(call('query_book', { action: 'current_chapter' }), fakeAccess({ currentChapter: () => null }), budget)).content,
    );
    expect(none.empty).toBe(true);
    const bad = await executeAssistantTool(call('query_book', { action: 'delete_book' }), access, budget);
    expect(bad.isError).toBe(true);
    expect(budget.chaptersRead.size).toBe(0);
  });
});

describe('save_to_book', () => {
  it('saves each kind through the host after confirmation', async () => {
    const access = fakeAccess();
    for (const kind of ['highlight', 'bookmark', 'note'] as const) {
      const result = await executeAssistantTool(
        call('save_to_book', { kind, text: '引文', note: '备注' }),
        access,
        createAssistantToolBudget(),
      );
      expect(result.isError).toBe(false);
      expect(parse(result.content)).toMatchObject({ kind, saved: true });
    }
    expect(access.calls.save).toEqual([
      { kind: 'highlight', text: '引文', note: '备注' },
      { kind: 'bookmark', text: '引文', note: '备注' },
      { kind: 'note', text: '引文', note: '备注' },
    ]);
  });

  it('reports rejection without error flag and failures with it', async () => {
    const rejected = fakeAccess({ save: async () => ({ ok: false, reason: 'rejected' }) });
    const result = await executeAssistantTool(call('save_to_book', { kind: 'bookmark' }), rejected, createAssistantToolBudget());
    expect(result.isError).toBe(false);
    expect(parse(result.content)).toMatchObject({ saved: false, reason: 'rejected' });

    const noSelection = fakeAccess({ save: async () => ({ ok: false, reason: 'no-selection' }) });
    const highlight = await executeAssistantTool(call('save_to_book', { kind: 'highlight' }), noSelection, createAssistantToolBudget());
    expect(highlight.isError).toBe(true);
    expect(parse(highlight.content).reason).toBe('no-selection');

    const throwing = fakeAccess({
      save: async () => {
        throw new Error('boom');
      },
    });
    const failed = await executeAssistantTool(call('save_to_book', { kind: 'bookmark' }), throwing, createAssistantToolBudget());
    expect(failed.isError).toBe(true);
    expect(parse(failed.content).reason).toBe('failed');
  });

  it('validates kind and note requirements before touching the host', async () => {
    const access = fakeAccess();
    const badKind = await executeAssistantTool(call('save_to_book', { kind: 'tag' }), access, createAssistantToolBudget());
    expect(badKind.isError).toBe(true);
    const noteless = await executeAssistantTool(call('save_to_book', { kind: 'note' }), access, createAssistantToolBudget());
    expect(noteless.isError).toBe(true);
    expect(access.calls.save).toHaveLength(0);
  });
});

describe('executeAssistantTool guard rails', () => {
  it('answers unknown tools with an error result instead of throwing', async () => {
    const result = await executeAssistantTool(call('open_other_book', {}), fakeAccess(), createAssistantToolBudget());
    expect(result.isError).toBe(true);
    expect(result.callId).toBe('c1');
    expect(parse(result.content).error).toContain('query_book');
  });

  it('describes calls briefly for the tool block', () => {
    expect(describeAssistantToolCall(call('query_book', { action: 'search', query: '龙' }))).toBe('search · 龙');
    expect(describeAssistantToolCall(call('query_book', { action: 'chapter', chapter_index: 3 }))).toBe('chapter · #3');
    expect(describeAssistantToolCall(call('query_book', { action: 'outline' }))).toBe('outline');
    expect(describeAssistantToolCall(call('save_to_book', { kind: 'note' }))).toBe('note');
    expect(describeAssistantToolCall(call('other', {}))).toBe('other');
  });

  it('matches outline titles exactly before falling back to contains', () => {
    const outline = [
      { title: '第一章 开端', chapter: 0 },
      { title: '开端', chapter: 1 },
      { title: '第二章', chapter: 2 },
    ];
    expect(matchOutlineTitle(outline, ' 开端 ').map((entry) => entry.chapter)).toEqual([1]);
    expect(matchOutlineTitle(outline, '第').map((entry) => entry.chapter)).toEqual([0, 2]);
    expect(matchOutlineTitle(outline, '')).toEqual([]);
  });
});
