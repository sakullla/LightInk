/**
 * Contract for `src/reader/assistant-tools.ts` (ADR-3 / R6):
 *
 * - 模型可见工具只有 query_book 与 save_to_book。
 * - toc / search / chapter 返回摘录或正文并标明截断；search 只走 run/hitViews，
 *   不调用 activateKey。
 * - 同一会话指定章最多 12 次，再请求则工具结果报上限。
 * - 无选区高亮失败；书签不需选区；拒绝确认不写入。
 */

import { describe, expect, it, vi } from 'vitest';

import type { OutlineItem } from '../../outline/outline-model.js';
import type { Locator } from '../annotations.js';
import {
  ASSISTANT_MAX_SPECIFIED_CHAPTERS,
  ASSISTANT_TOOL_DEFINITIONS,
  QUERY_BOOK_TOOL_NAME,
  SAVE_TO_BOOK_TOOL_NAME,
  collectAssistantSearchHits,
  createAssistantToolSession,
  type AssistantBookInfo,
  type AssistantChapterBody,
  type AssistantChapterTarget,
  type AssistantSearchHitInput,
  type AssistantToolDeps,
  type AssistantToolSearch,
  type AssistantToolSelection,
} from '../assistant-tools.js';
import { READER_LIMITS } from '../reader-limits.js';
import { SEARCH_HIT_CAP } from '../search-panel.js';

const FLOW_LOCATOR: Locator = {
  format: 'flow',
  chapter: 0,
  start: 0,
  end: 0,
  quote: '',
  prefix: '',
  suffix: '',
};

const OUTLINE: OutlineItem[] = [
  { level: 1, text: '序章', anchor: 0, chapter: 0 },
  { level: 1, text: '出发', anchor: 1, chapter: 1 },
  { level: 2, text: '引言', anchor: 2, chapter: 2 },
  { level: 2, text: '引言', anchor: 3, chapter: 3 },
];

function searchMock(
  hits: readonly AssistantSearchHitInput[] = [],
  hasMore = false,
): AssistantToolSearch & { activateKey: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(),
    hitViews: vi.fn(() => hits),
    hitsState: vi.fn(() => ({ hasMore })),
    activateKey: vi.fn(),
  };
}

function deps(overrides: Partial<AssistantToolDeps> = {}): AssistantToolDeps {
  const search = overrides.search ?? searchMock();
  return {
    outline: () => OUTLINE,
    currentChapter: () => ({ title: '序章', text: '当前章正文', chapter: 0 }),
    chapterText: (target: AssistantChapterTarget): AssistantChapterBody => ({
      title: target.title ?? `章${target.chapter ?? target.page ?? '?'}`,
      text: `正文-${target.chapter ?? target.page ?? ''}`,
      chapter: target.chapter,
      page: target.page,
    }),
    search,
    selection: () => null,
    bookInfo: (): AssistantBookInfo => ({ title: '示例书', author: '作者' }),
    currentLocator: () => FLOW_LOCATOR,
    appendAnnotation: vi.fn(),
    confirm: vi.fn(async () => true),
    ...overrides,
  };
}

describe('ASSISTANT_TOOL_DEFINITIONS', () => {
  it('exposes only query_book and save_to_book in that order', () => {
    expect(ASSISTANT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      QUERY_BOOK_TOOL_NAME,
      SAVE_TO_BOOK_TOOL_NAME,
    ]);
    expect(ASSISTANT_TOOL_DEFINITIONS).toHaveLength(2);
    expect(ASSISTANT_TOOL_DEFINITIONS[0]?.parameters.required).toEqual(['action']);
    expect(ASSISTANT_TOOL_DEFINITIONS[1]?.parameters.required).toEqual(['kind']);
  });

  it('keeps the same two tools on a session', () => {
    const session = createAssistantToolSession(deps());
    expect(session.tools).toBe(ASSISTANT_TOOL_DEFINITIONS);
    expect(session.tools.map((tool) => tool.name)).toEqual(['query_book', 'save_to_book']);
  });
});

describe('query_book', () => {
  it('returns toc headings without bodies and does not fetch chapter text', async () => {
    const chapterText = vi.fn();
    const session = createAssistantToolSession(deps({ chapterText }));
    const result = await session.execute('query_book', { action: 'toc' });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('toc');
    expect(result.items).toEqual([
      { level: 1, text: '序章', chapter: 0 },
      { level: 1, text: '出发', chapter: 1 },
      { level: 2, text: '引言', chapter: 2 },
      { level: 2, text: '引言', chapter: 3 },
    ]);
    expect(result.items?.every((item) => !('body' in item))).toBe(true);
    expect(chapterText).not.toHaveBeenCalled();
  });

  it('returns current chapter text with a truncation flag', async () => {
    const long = '章'.repeat(READER_LIMITS.maxAssistantContextChars + 8);
    const session = createAssistantToolSession(
      deps({
        currentChapter: () => ({ title: '序章', text: long, chapter: 0 }),
      }),
    );
    const result = await session.execute('query_book', { action: 'current_chapter' });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('章'.repeat(READER_LIMITS.maxAssistantContextChars));
    expect(result.title).toBe('序章');
  });

  it('returns specified chapter body and marks truncation', async () => {
    const long = '正'.repeat(READER_LIMITS.maxAssistantContextChars + 3);
    const session = createAssistantToolSession(
      deps({
        chapterText: () => ({ title: '出发', text: long, chapter: 1 }),
      }),
    );
    const result = await session.execute('query_book', { action: 'chapter', chapter: 1 });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('chapter');
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(READER_LIMITS.maxAssistantContextChars);
    expect(session.specifiedChapterCount()).toBe(1);
  });

  it('resolves a specified chapter from query integer or title', async () => {
    const chapterText = vi.fn(
      (target: AssistantChapterTarget): AssistantChapterBody => ({
        title: target.title,
        text: `正文-${target.chapter}`,
        chapter: target.chapter,
      }),
    );
    const session = createAssistantToolSession(deps({ chapterText }));

    const byIndex = await session.execute('query_book', { action: 'chapter', query: '1' });
    expect(byIndex.ok).toBe(true);
    expect(chapterText).toHaveBeenCalledWith({ chapter: 1, title: '出发' });
    expect(byIndex.text).toBe('正文-1');
    expect(byIndex.title).toBe('出发');

    const byTitle = await session.execute('query_book', { action: 'chapter', query: '出发' });
    expect(byTitle.ok).toBe(true);
    expect(chapterText).toHaveBeenNthCalledWith(2, { chapter: 1, title: '出发' });
    expect(byTitle.text).toBe('正文-1');
    expect(byTitle.title).toBe('出发');
  });

  it('resolves a unique title and reports ambiguous titles as candidates', async () => {
    const chapterText = vi.fn(
      (target: AssistantChapterTarget): AssistantChapterBody => ({
        title: target.title,
        text: '唯一正文',
        chapter: target.chapter,
      }),
    );
    const session = createAssistantToolSession(deps({ chapterText }));
    const unique = await session.execute('query_book', { action: 'chapter', chapter: '出发' });
    expect(unique.ok).toBe(true);
    expect(chapterText).toHaveBeenCalledWith({ chapter: 1, title: '出发' });
    expect(unique.text).toBe('唯一正文');

    const ambiguous = await session.execute('query_book', { action: 'chapter', title: '引言' });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toBe('ambiguous_title');
    expect(ambiguous.candidates).toEqual([
      { level: 2, text: '引言', chapter: 2 },
      { level: 2, text: '引言', chapter: 3 },
    ]);
    expect(chapterText).toHaveBeenCalledTimes(1);
  });

  it('returns a limit error after 12 specified-chapter bodies in one session', async () => {
    const chapterText = vi.fn(
      (target: AssistantChapterTarget): AssistantChapterBody => ({
        title: `章${target.chapter}`,
        text: `正文${target.chapter}`,
        chapter: target.chapter,
      }),
    );
    const session = createAssistantToolSession(deps({ chapterText }));
    for (let index = 0; index < ASSISTANT_MAX_SPECIFIED_CHAPTERS; index += 1) {
      const result = await session.execute('query_book', { action: 'chapter', chapter: index });
      expect(result.ok).toBe(true);
      expect(result.text).toBe(`正文${index}`);
    }
    const limited = await session.execute('query_book', { action: 'chapter', chapter: 99 });
    expect(limited.ok).toBe(false);
    expect(limited.error).toBe('chapter_limit');
    expect(limited.limit).toBe(12);
    expect(limited.message).toMatch(/12/);
    expect(chapterText).toHaveBeenCalledTimes(12);
    expect(session.specifiedChapterCount()).toBe(12);

    const current = await session.execute('query_book', { action: 'current_chapter' });
    expect(current.ok).toBe(true);
    expect(current.text).toBe('当前章正文');
  });

  it('does not count empty specified-chapter results toward the limit', async () => {
    const session = createAssistantToolSession(
      deps({
        chapterText: () => ({ text: '', reason: 'page_not_ready', page: 4 }),
      }),
    );
    const empty = await session.execute('query_book', { action: 'chapter', page: 4 });
    expect(empty.ok).toBe(true);
    expect(empty.text).toBe('');
    expect(empty.reason).toBe('page_not_ready');
    expect(session.specifiedChapterCount()).toBe(0);
  });

  it('returns selection quote or an empty reason', async () => {
    const empty = await createAssistantToolSession(deps()).execute('query_book', {
      action: 'selection',
    });
    expect(empty).toMatchObject({ ok: true, quote: '', reason: 'no_selection' });

    const selected = await createAssistantToolSession(
      deps({
        selection: (): AssistantToolSelection => ({ quote: '  选中句  ', locator: FLOW_LOCATOR }),
      }),
    ).execute('query_book', { action: 'selection' });
    expect(selected).toMatchObject({ ok: true, quote: '选中句' });
    expect(selected.reason).toBeUndefined();
  });

  it('returns book info from deps', async () => {
    const result = await createAssistantToolSession(deps()).execute('query_book', {
      action: 'book_info',
    });
    expect(result).toMatchObject({ ok: true, title: '示例书', author: '作者' });
  });

  it('search returns snippets with has_more and never calls activateKey', async () => {
    const hits: AssistantSearchHitInput[] = [
      {
        key: 'f-0',
        snippet: '……关键词附近的摘录……',
        location: '第 1 章',
        payload: { kind: 'flow', chapter: 0, start: 4, end: 7 },
      },
    ];
    const search = searchMock(hits, false);
    const session = createAssistantToolSession(deps({ search }));
    const result = await session.execute('query_book', { action: 'search', query: '关键词' });
    expect(search.run).toHaveBeenCalledWith('关键词');
    expect(search.hitViews).toHaveBeenCalled();
    expect(search.activateKey).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.has_more).toBe(false);
    expect(result.hits).toEqual([
      {
        key: 'f-0',
        snippet: '……关键词附近的摘录……',
        location: '第 1 章',
        chapter: 0,
      },
    ]);
    expect(result.hits?.[0]?.snippet).not.toContain('正文-');
  });

  it('caps search hits at SEARCH_HIT_CAP and sets has_more', async () => {
    const hits: AssistantSearchHitInput[] = Array.from({ length: SEARCH_HIT_CAP + 5 }, (_, index) => ({
      key: `k${index}`,
      snippet: `摘录${index}`,
      location: `p${index}`,
      payload: { kind: 'pdf', page: index + 1, start: 0, end: 1 },
    }));
    const search = searchMock(hits, true);
    const result = await createAssistantToolSession(deps({ search })).execute('query_book', {
      action: 'search',
      query: 'foo',
    });
    expect(result.hits).toHaveLength(SEARCH_HIT_CAP);
    expect(result.has_more).toBe(true);
    expect(search.activateKey).not.toHaveBeenCalled();
  });

  it('does not run a whole-book scan for an empty search query', async () => {
    const search = searchMock();
    const result = await createAssistantToolSession(deps({ search })).execute('query_book', {
      action: 'search',
      query: '   ',
    });
    expect(search.run).not.toHaveBeenCalled();
    expect(search.activateKey).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, hits: [], has_more: false, reason: 'empty_query' });
  });

  it('does not confirm or write while querying', async () => {
    const appendAnnotation = vi.fn();
    const confirm = vi.fn();
    const session = createAssistantToolSession(deps({ appendAnnotation, confirm }));
    await session.execute('query_book', { action: 'toc' });
    await session.execute('query_book', { action: 'chapter', chapter: 0 });
    expect(confirm).not.toHaveBeenCalled();
    expect(appendAnnotation).not.toHaveBeenCalled();
  });
});

describe('collectAssistantSearchHits', () => {
  it('uses run and hitViews only', async () => {
    const search = searchMock(
      [
        {
          key: 'p-2',
          snippet: 'hit',
          location: '第 2 页',
          payload: { kind: 'pdf', page: 2, start: 1, end: 4 },
        },
      ],
      false,
    );
    const collected = await collectAssistantSearchHits(search, 'hit');
    expect(search.run).toHaveBeenCalledWith('hit');
    expect(search.activateKey).not.toHaveBeenCalled();
    expect(collected.hits[0]).toMatchObject({ snippet: 'hit', page: 2 });
  });
});

describe('save_to_book', () => {
  it('fails highlight without a selection or quote and does not confirm', async () => {
    const appendAnnotation = vi.fn();
    const confirm = vi.fn();
    const result = await createAssistantToolSession(
      deps({ appendAnnotation, confirm, selection: () => null }),
    ).execute('save_to_book', { kind: 'highlight' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('highlight_requires_selection');
    expect(confirm).not.toHaveBeenCalled();
    expect(appendAnnotation).not.toHaveBeenCalled();
  });

  it('saves a highlight from live selection after confirm', async () => {
    const appendAnnotation = vi.fn();
    const locator: Locator = { ...FLOW_LOCATOR, start: 4, end: 8, quote: '选区' };
    const result = await createAssistantToolSession(
      deps({
        appendAnnotation,
        selection: () => ({ quote: '选区', locator }),
      }),
    ).execute('save_to_book', { kind: 'highlight' });
    expect(result).toMatchObject({ ok: true, saved: true, kind: 'highlight', quote: '选区' });
    expect(appendAnnotation).toHaveBeenCalledWith('highlight', locator, '选区', undefined);
  });

  it('saves a bookmark without a selection', async () => {
    const appendAnnotation = vi.fn();
    const result = await createAssistantToolSession(
      deps({ appendAnnotation, selection: () => null }),
    ).execute('save_to_book', { kind: 'bookmark' });
    expect(result).toMatchObject({ ok: true, saved: true, kind: 'bookmark' });
    expect(appendAnnotation).toHaveBeenCalledWith('bookmark', FLOW_LOCATOR, undefined, undefined);
  });

  it('does not write when confirm is rejected', async () => {
    const appendAnnotation = vi.fn();
    const confirm = vi.fn(async () => false);
    const result = await createAssistantToolSession(deps({ appendAnnotation, confirm })).execute(
      'save_to_book',
      { kind: 'note', note: '旁注' },
    );
    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.error).toBe('rejected');
    expect(confirm).toHaveBeenCalledWith({ kind: 'note', note: '旁注' });
    expect(appendAnnotation).not.toHaveBeenCalled();
  });

  it('writes a note after confirm using the current locator', async () => {
    const appendAnnotation = vi.fn();
    const result = await createAssistantToolSession(deps({ appendAnnotation })).execute(
      'save_to_book',
      JSON.stringify({ kind: 'note', note: '摘要' }),
    );
    expect(result).toMatchObject({ ok: true, saved: true, kind: 'note', note: '摘要' });
    expect(appendAnnotation).toHaveBeenCalledWith('note', FLOW_LOCATOR, undefined, '摘要');
  });
});

describe('unknown tool', () => {
  it('rejects a third tool name without touching reader writes', async () => {
    const appendAnnotation = vi.fn();
    const search = searchMock();
    const result = await createAssistantToolSession(deps({ appendAnnotation, search })).execute(
      'save_annotation',
      { kind: 'note' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown_tool');
    expect(appendAnnotation).not.toHaveBeenCalled();
    expect(search.run).not.toHaveBeenCalled();
  });
});
