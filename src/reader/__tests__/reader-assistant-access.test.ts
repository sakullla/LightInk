// @vitest-environment jsdom

/**
 * Contract for `src/reader/view/reader-assistant-access.ts`:
 * 章节 HTML → 纯文本；保存到当前书的定位与持久化边界（引文找不到不改锚、
 * 无持久化存储不报成功、确认后等待落盘）；定位跳转越界不跳。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createReaderAssistantAccess,
  htmlToChapterText,
} from '../view/reader-assistant-access.js';
import type { ReaderViewContext } from '../view/reader-context.js';
import { translate, type MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

describe('htmlToChapterText', () => {
  it('keeps paragraph breaks and collapses inline whitespace', () => {
    const text = htmlToChapterText(
      '<h1>第一章</h1><p>第一段   有  空格</p><p>第二段<br>换行</p><ul><li>甲</li><li>乙</li></ul>',
    );
    expect(text).toBe('第一章\n第一段 有 空格\n第二段\n换行\n甲\n乙');
  });

  it('drops blank lines and trims edges', () => {
    expect(htmlToChapterText('<p>a</p>\n\n\n<p></p><p></p><p>b</p>')).toBe('a\nb');
    expect(htmlToChapterText('   ')).toBe('');
    expect(htmlToChapterText('<div>只有一行</div>')).toBe('只有一行');
  });
});

interface StubOptions {
  readonly chapterText?: string;
  readonly canPersist?: boolean;
  readonly contentHash?: string | null;
  readonly chapterCount?: number;
  /** appendAnnotation 排队那次写入的落盘结果（缺省 true）。 */
  readonly persisted?: boolean;
  /** 注入 PDF 句柄（search/controller）。 */
  readonly pdfHandle?: unknown;
}

/** 最小阅读器上下文桩：只覆盖 access 用到的成员（flow 族 epub，单章已挂载）。 */
function stubContext(options: StubOptions = {}): {
  ctx: ReaderViewContext;
  appended: unknown[][];
  jumps: unknown[];
  saveAnnotations: ReturnType<typeof vi.fn>;
  removed: string[];
} {
  const appended: unknown[][] = [];
  const removed: string[] = [];
  const annotations: { id: string }[] = [{ id: 'existing' }];
  const jumps: unknown[] = [];
  const saveAnnotations = vi.fn(async () => options.persisted ?? true);
  const frameDoc = document.implementation.createHTMLDocument('chapter');
  frameDoc.body.textContent = options.chapterText ?? '清晨的雾还没散，阿龙背起行囊走出了村口。';
  const frame = { contentDocument: frameDoc } as unknown as HTMLIFrameElement;
  const chapterCount = options.chapterCount ?? 3;
  const ctx = {
    t,
    pdfHandle: options.pdfHandle ?? null,
    cbzHandle: null,
    loadedExt: 'epub',
    loadedTitle: '样书',
    destroyed: false,
    flowChapterCount: chapterCount,
    exportChapters: Array.from({ length: chapterCount }, (_, index) => ({
      title: `第${index + 1}章`,
      html: `<p>第${index + 1}章正文</p>`,
    })),
    readerOutline: [],
    readerState: { phase: 'ready', current: 1, total: chapterCount, progress: 0, scale: 1, locationKind: 'chapter' },
    pageHost: document.createElement('div'),
    pendingSelection: null,
    annotations,
    dom: {
      firstVisibleChapter: () => 0,
      chapterFrame: (index: number) => (index === 0 ? frame : null),
      flowDocuments: () => [frameDoc],
    },
    annotation: {
      currentPositionLocator: () => ({
        format: 'flow',
        chapter: 0,
        start: 0,
        end: 0,
        quote: '',
        prefix: '',
        suffix: '',
      }),
      // 与真实实现同口径：追加后自己排队一次写入并回传结果。
      appendAnnotation: (...args: unknown[]) => {
        appended.push(args);
        annotations.push({ id: `added-${appended.length}` });
        return saveAnnotations();
      },
      saveAnnotations,
      // 与真实实现同口径：追加、等落盘、没落盘就丢弃刚追加的那条。
      appendAnnotationPersisted: async (...args: unknown[]) => {
        appended.push(args);
        const id = `added-${appended.length}`;
        annotations.push({ id });
        const ok = await saveAnnotations();
        if (!ok) {
          removed.push(id);
          const at = annotations.findIndex((item) => item.id === id);
          if (at >= 0) {
            annotations.splice(at, 1);
          }
        }
        return ok;
      },
      // 助手回滚走 discard（不产 tombstone、不排队写）；removeAnnotationById 是用户侧删除。
      discardAnnotationById: (id: string) => {
        removed.push(id);
        const at = annotations.findIndex((item) => item.id === id);
        if (at >= 0) {
          annotations.splice(at, 1);
        }
      },
      removeAnnotationById: (id: string) => {
        removed.push(id);
        const at = annotations.findIndex((item) => item.id === id);
        if (at >= 0) {
          annotations.splice(at, 1);
        }
      },
    },
    sessionAnnotation: {
      canPersist: () => options.canPersist ?? true,
      contentHash: () => (options.contentHash === undefined ? '0123456789abcdef' : options.contentHash),
    },
    sessionLoad: { generation: () => 1 },
    jumpToOutlineItem: (item: unknown) => {
      jumps.push(item);
    },
  } as unknown as ReaderViewContext;
  return { ctx, appended, jumps, saveAnnotations, removed };
}

const locationFallback = (kind: 'chapter' | 'page', n: number): string => `${kind} ${n}`;

describe('createReaderAssistantAccess save', () => {
  it('rejects a note whose explicit quote cannot be located instead of re-anchoring it', async () => {
    const { ctx, appended } = stubContext();
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    const missing = await access.save({ kind: 'note', text: '另一章的句子', note: '备注' });
    expect(missing).toEqual({ ok: false, reason: 'quote-not-found' });
    expect(appended).toHaveLength(0);
    // 引文在当前章内：定位到引文；无引文：落在当前阅读位置。
    const located = await access.save({ kind: 'note', text: '阿龙背起行囊', note: '备注' });
    expect(located).toEqual({ ok: true, kind: 'note' });
    expect(appended[0]?.[1]).toMatchObject({ format: 'flow', chapter: 0, quote: '阿龙背起行囊' });
    const positional = await access.save({ kind: 'note', note: '只记位置' });
    expect(positional).toEqual({ ok: true, kind: 'note' });
    expect(appended[1]?.[2]).toBeUndefined();
  });

  it('does not report success when annotations cannot be persisted, and waits for the write otherwise', async () => {
    const noStore = stubContext({ canPersist: false });
    const accessNoStore = createReaderAssistantAccess(noStore.ctx, { t, locationFallback, confirm: async () => true });
    const outcome = await accessNoStore.save({ kind: 'bookmark' });
    expect(outcome).toMatchObject({ ok: false, reason: 'failed' });
    expect(noStore.appended).toHaveLength(0);

    const noHash = stubContext({ contentHash: null });
    const accessNoHash = createReaderAssistantAccess(noHash.ctx, { t, locationFallback, confirm: async () => true });
    expect(await accessNoHash.save({ kind: 'bookmark' })).toMatchObject({ ok: false, reason: 'failed' });

    const ok = stubContext();
    const confirm = vi.fn(async () => true);
    const access = createReaderAssistantAccess(ok.ctx, { t, locationFallback, confirm });
    expect(await access.save({ kind: 'bookmark', note: '这里' })).toEqual({ ok: true, kind: 'bookmark' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ok.appended).toHaveLength(1);
    expect(ok.saveAnnotations).toHaveBeenCalledTimes(1);

    const rejected = stubContext();
    const accessRejected = createReaderAssistantAccess(rejected.ctx, { t, locationFallback, confirm: async () => false });
    expect(await accessRejected.save({ kind: 'bookmark' })).toEqual({ ok: false, reason: 'rejected' });
    expect(rejected.appended).toHaveLength(0);
  });
});

describe('createReaderAssistantAccess quote anchoring', () => {
  it('locates a quote whose whitespace was collapsed in the text shown to the model', async () => {
    const raw = '  第一段\n    阿龙  背起\n行囊走出了村口。\n  第二段';
    const { ctx, appended } = stubContext({ chapterText: raw });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    // 模型看到的是折叠后的「阿龙 背起 行囊走出了村口。」。
    const outcome = await access.save({ kind: 'highlight', text: '阿龙 背起 行囊走出了村口。' });
    expect(outcome).toEqual({ ok: true, kind: 'highlight' });
    const locator = appended[0]?.[1] as { start: number; end: number; quote: string };
    expect(raw.slice(locator.start, locator.end)).toBe('阿龙  背起\n行囊走出了村口。');
    expect(locator.quote).toBe('阿龙  背起\n行囊走出了村口。');
    // 真正不存在的引文仍然找不到。
    expect(await access.save({ kind: 'highlight', text: '不在章里的话' })).toEqual({
      ok: false,
      reason: 'quote-not-found',
    });
  });

  it('finds a quote that the model joined across a paragraph break', async () => {
    const raw = '甲\n乙';
    const { ctx, appended } = stubContext({ chapterText: raw });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    expect(await access.save({ kind: 'highlight', text: '甲乙' })).toEqual({ ok: true, kind: 'highlight' });
    const locator = appended[0]?.[1] as { start: number; end: number; quote: string };
    expect(raw.slice(locator.start, locator.end)).toBe('甲\n乙');
    expect(locator.quote).toBe('甲\n乙');
  });

  it('previews bookmark notes and note quotes in the confirmation, and rejects notes on highlights', async () => {
    const { ctx, appended } = stubContext();
    const confirm = vi.fn(async (_spec: { title: string; message: string }) => true);
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm });
    await access.save({ kind: 'bookmark', note: '这里要重读' });
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      message: t('reader.assistant.save.bookmarkNote', { text: '这里要重读' }),
    });
    expect(appended[0]?.[3]).toBe('这里要重读');
    // 带引文的笔记：确认框必须让用户看到引文锚点，而不只是笔记正文。
    await access.save({ kind: 'note', text: '阿龙背起行囊', note: '出发' });
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({
      message: t('reader.assistant.save.noteQuote', { quote: '阿龙背起行囊', text: '出发' }),
    });
    expect(appended[1]?.[3]).toBe('出发');
    // 高亮不支持备注：与其静默丢弃却回 saved:true，不如拒绝并告诉模型改用 note。
    expect(await access.save({ kind: 'highlight', text: '阿龙背起行囊', note: '偷偷带的备注' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(appended).toHaveLength(2);
    // 超长引文/备注：不弹确认，不进正则。
    expect(await access.save({ kind: 'highlight', text: 'x'.repeat(20_000) })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('rolls the annotation back when the write does not land', async () => {
    const { ctx, appended, saveAnnotations, removed } = stubContext({ persisted: false });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    expect(await access.save({ kind: 'bookmark' })).toMatchObject({ ok: false, reason: 'failed' });
    expect(appended).toHaveLength(1);
    expect(saveAnnotations).toHaveBeenCalledTimes(1);
    // 写失败的那一条不能继续挂在侧栏上。
    expect(removed).toEqual(['added-1']);
    const ok = stubContext();
    const accessOk = createReaderAssistantAccess(ok.ctx, { t, locationFallback, confirm: async () => true });
    expect(await accessOk.save({ kind: 'bookmark' })).toEqual({ ok: true, kind: 'bookmark' });
    expect(ok.removed).toEqual([]);
  });
});

describe('createReaderAssistantAccess pdf search budget', () => {
  it('stops the page scan once enough hits are collected and marks time-outs as partial', async () => {
    const makeHandle = (pages: number, onScan?: (page: number) => void) => ({
      controller: { page: 1, totalPages: pages },
      search: async (
        _query: string,
        options?: { onProgress?: (matches: Array<{ page: number; start: number; end: number; snippet: string }>, done: boolean) => boolean | void },
      ) => {
        const matches: Array<{ page: number; start: number; end: number; snippet: string }> = [];
        for (let page = 1; page <= pages; page += 1) {
          onScan?.(page);
          matches.push({ page, start: 0, end: 2, snippet: `命中 ${page}` });
          if (options?.onProgress?.(matches, page === pages) === false) {
            return [...matches];
          }
        }
        return matches;
      },
      pageText: async () => '',
      scrollToPage: () => undefined,
      outline: async () => [],
      rerender: async () => undefined,
      destroy: async () => undefined,
    });
    let scanned = 0;
    const { ctx } = stubContext({ pdfHandle: makeHandle(500, () => { scanned += 1; }) });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback });
    const result = await access.search('命中', 5);
    expect(result.hits).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.partial).toBe(false);
    expect(scanned).toBeLessThan(500);

    const slow = stubContext({ pdfHandle: makeHandle(3) });
    const nowSpy = vi.spyOn(Date, 'now');
    let tick = 0;
    nowSpy.mockImplementation(() => (tick += 10_000)); // 每次看表都超预算
    try {
      const slowAccess = createReaderAssistantAccess(slow.ctx, { t, locationFallback });
      const timedOut = await slowAccess.search('命中', 20);
      expect(timedOut.partial).toBe(true);
      expect(timedOut.hits.length).toBeGreaterThan(0);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('createReaderAssistantAccess pdf current context', () => {
  it('falls back to lazily extracted page text instead of reporting no context', async () => {
    const cache = new Map<number, string>();
    const pageText = vi.fn(async (page: number) => {
      cache.set(page, `第${page}页的文字`);
      return `第${page}页的文字`;
    });
    const handle = {
      controller: { page: 2, totalPages: 3 },
      pageText,
      pageTextCached: (page: number) => cache.get(page),
      search: async () => [],
      outline: async () => [],
    };
    const onContextReady = vi.fn();
    const { ctx } = stubContext({ pdfHandle: handle });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true, onContextReady });
    // 文字层未挂载、缓存为空：暂时没有上下文，但会后台抽取而不是就此认定空页。
    expect(access.currentChapterContext()).toBeNull();
    expect(pageText).toHaveBeenCalledWith(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(onContextReady).toHaveBeenCalledTimes(1);
    expect(access.currentChapterContext()).toMatchObject({ text: '第2页的文字' });
    // 缓存命中后不再重复抽取。
    expect(pageText).toHaveBeenCalledTimes(1);
  });

  it('anchors quotes against the cached page text when the text layer is empty', async () => {
    const cache = new Map<number, string>([[2, '第二页开头 阿龙背起行囊 第二页结尾']]);
    const handle = {
      controller: { page: 2, totalPages: 3 },
      pageText: vi.fn(async (page: number) => cache.get(page) ?? ''),
      pageTextCached: (page: number) => cache.get(page),
      search: async () => [],
      outline: async () => [],
    };
    const { ctx, appended } = stubContext({ pdfHandle: handle });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    // 模型引用的是刚从缓存回传的那段文本：定位必须用同一份，而不是空的文字层。
    expect(await access.save({ kind: 'highlight', text: '阿龙背起行囊' })).toEqual({ ok: true, kind: 'highlight' });
    const locator = appended[0]?.[1] as { format: string; page: number; anchor: { start: number; end: number } };
    expect(locator.format).toBe('pdf');
    expect(locator.page).toBe(2);
    expect('第二页开头 阿龙背起行囊 第二页结尾'.slice(locator.anchor.start, locator.anchor.end)).toBe('阿龙背起行囊');
    // 缓存也没有时懒取一次再定位。
    cache.delete(2);
    const lazy = { ...handle, pageText: vi.fn(async () => '懒取的 阿龙背起行囊'), pageTextCached: () => undefined };
    const lazyCtx = stubContext({ pdfHandle: lazy });
    const lazyAccess = createReaderAssistantAccess(lazyCtx.ctx, { t, locationFallback, confirm: async () => true });
    expect(await lazyAccess.save({ kind: 'highlight', text: '阿龙背起行囊' })).toEqual({ ok: true, kind: 'highlight' });
    expect(lazy.pageText).toHaveBeenCalled();
  });
});

describe('createReaderAssistantAccess round-7 guards', () => {
  it('ignores a main-document selection made outside the reading area', () => {
    const { ctx } = stubContext();
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    const outside = document.createElement('div');
    outside.textContent = '面板里的回答文字';
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(access.selection()).toBe('');
    // 阅读区里的选区才算。
    const inside = document.createElement('div');
    inside.textContent = '正文里的字';
    ctx.pageHost.appendChild(inside);
    document.body.appendChild(ctx.pageHost);
    const range2 = document.createRange();
    range2.selectNodeContents(inside);
    selection.removeAllRanges();
    selection.addRange(range2);
    expect(access.selection()).toBe('正文里的字');
    selection.removeAllRanges();
  });

  it('does not add a second bookmark at an already bookmarked position', async () => {
    const { ctx, appended } = stubContext();
    (ctx as unknown as { bookmarks: unknown }).bookmarks = {
      bookmarkAtStatePosition: () => ({ id: 'b1', kind: 'bookmark' }),
    };
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    const outcome = await access.save({ kind: 'bookmark' });
    expect(outcome).toMatchObject({ ok: true, kind: 'bookmark' });
    expect((outcome as { message?: string }).message).toContain('已有书签');
    expect(appended).toHaveLength(0);
  });

  it('reports a rejected PDF search as partial and stops a flow search after a book switch', async () => {
    const failing = stubContext({
      pdfHandle: {
        controller: { page: 1, totalPages: 3 },
        search: async () => {
          throw new Error('document closed');
        },
        pageText: async () => '',
        pageTextCached: () => undefined,
        outline: async () => [],
      },
    });
    const pdfAccess = createReaderAssistantAccess(failing.ctx, { t, locationFallback, confirm: async () => true });
    expect(await pdfAccess.search('x', 5)).toEqual({ hits: [], hasMore: false, partial: true });
    let reads = 0;
    const { ctx } = stubContext({ chapterCount: 40 });
    // 搜索一开始记下的代数是 1，之后每次核对都看到 2：等于扫描途中换了书。
    (ctx as unknown as { sessionLoad: { generation: () => number } }).sessionLoad = {
      generation: () => (reads++ === 0 ? 1 : 2),
    };
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    const result = await access.search('第', 50);
    expect(result.partial).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  it('keeps PDF anchor offsets relative to the untrimmed page text and skips invisible characters', async () => {
    const raw = '  \u00ad阿龙\u200b背起行囊 尾';
    const handle = {
      controller: { page: 1, totalPages: 1 },
      pageText: async () => raw,
      pageTextCached: () => raw,
      search: async () => [],
      outline: async () => [],
    };
    const { ctx, appended } = stubContext({ pdfHandle: handle });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    expect(await access.save({ kind: 'highlight', text: '阿龙背起行囊' })).toEqual({ ok: true, kind: 'highlight' });
    const locator = appended[0]?.[1] as { anchor: { start: number; end: number } };
    expect(raw.slice(locator.anchor.start, locator.anchor.end)).toBe('\u00ad阿龙\u200b背起行囊'.slice(1));
    expect(locator.anchor.start).toBe(3);
  });

  it('anchors a flow quote against the exported chapter text when the frame is not mounted', async () => {
    const { ctx, appended } = stubContext({ chapterText: '' });
    (ctx.dom as unknown as { chapterFrame: () => null }).chapterFrame = () => null;
    (ctx as unknown as { exportChapters: unknown[] }).exportChapters = [{ title: '一', html: '<p>清晨 阿龙背起行囊</p>' }];
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    expect(await access.save({ kind: 'highlight', text: '阿龙背起行囊' })).toEqual({ ok: true, kind: 'highlight' });
    const locator = appended[0]?.[1] as { start: number; end: number };
    expect('清晨 阿龙背起行囊'.slice(locator.start, locator.end)).toBe('阿龙背起行囊');
  });

  it('reports PDF text availability from observed extraction, not from the format', () => {
    const make = (cached: (page: number) => string | undefined) =>
      stubContext({
        pdfHandle: { controller: { page: 1, totalPages: 3 }, pageTextCached: cached, pageText: async () => '', search: async () => [], outline: async () => [] },
      }).ctx;
    const unknown = createReaderAssistantAccess(make(() => undefined), { t, locationFallback });
    expect(unknown.bookInfo().hasText).toBeNull();
    const scanned = createReaderAssistantAccess(make(() => ''), { t, locationFallback });
    expect(scanned.bookInfo().hasText).toBe(false);
    const textual = createReaderAssistantAccess(make((page) => (page === 2 ? '有字' : '')), { t, locationFallback });
    expect(textual.bookInfo().hasText).toBe(true);
  });

  it('marks the search partial when a lazy chapter fails to materialize', async () => {
    const { ctx } = stubContext({ chapterText: '', chapterCount: 2 });
    (ctx as unknown as { exportChapters: unknown[] }).exportChapters = [
      { title: '坏章', html: '', load: async () => { throw new Error('io'); } },
      { title: '好章', html: '<p>阿龙背起行囊</p>' },
    ];
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true });
    const result = await access.search('阿龙', 10);
    expect(result.hits).toHaveLength(1);
    expect(result.partial).toBe(true); // 有一章没读到：不能声称书里没有
    expect(await access.chapterAt(0)).toBeNull();
  });

  it('kicks a lazy chapter load instead of reporting no context, then notifies once', async () => {
    const load = vi.fn(async () => undefined);
    const onContextReady = vi.fn();
    const { ctx } = stubContext({ chapterText: '' });
    (ctx as unknown as { exportChapters: unknown[] }).exportChapters = [{ title: '懒章', html: '', load }];
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm: async () => true, onContextReady });
    expect(access.currentChapterContext()).toBeNull();
    expect(access.currentChapterContext()).toBeNull(); // 第二次不再重复踢
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(load).toHaveBeenCalledTimes(1);
    expect(onContextReady).toHaveBeenCalledTimes(1);
  });
});

describe('createReaderAssistantAccess confirmation lifecycle', () => {
  it('cancels a pending confirmation when the panel closes and refuses a late acceptance', async () => {
    // 注入的确认永不回答：面板关闭时被取消。
    const { ctx, appended } = stubContext();
    const access = createReaderAssistantAccess(ctx, {
      t,
      locationFallback,
      confirm: () => new Promise<boolean>(() => undefined),
    });
    const pending = access.save({ kind: 'bookmark' });
    access.cancelPendingSaves();
    expect(await pending).toEqual({ ok: false, reason: 'rejected' });
    expect(appended).toHaveLength(0);
    // 用户点了保存，但那一刻面板已经关了：作废。
    let open = true;
    const late = createReaderAssistantAccess(ctx, {
      t,
      locationFallback,
      confirm: async () => {
        open = false;
        return true;
      },
      isPanelOpen: () => open,
    });
    expect(await late.save({ kind: 'bookmark' })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(appended).toHaveLength(0);
  });

  it('does not even open the confirmation when the panel closed during locator work', async () => {
    const raw = '第二页 阿龙背起行囊';
    let open = true;
    const handle = {
      controller: { page: 2, totalPages: 3 },
      // 页文本要异步抽：抽取期间面板被关。
      pageText: async () => {
        open = false;
        return raw;
      },
      pageTextCached: () => undefined,
      search: async () => [],
      outline: async () => [],
    };
    const { ctx, appended } = stubContext({ pdfHandle: handle });
    const confirm = vi.fn(async () => true);
    const access = createReaderAssistantAccess(ctx, { t, locationFallback, confirm, isPanelOpen: () => open });
    expect(await access.save({ kind: 'highlight', text: '阿龙背起行囊' })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(confirm).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });

  it('closes the real confirm dialog on cancel', async () => {
    const { ctx, appended } = stubContext();
    const access = createReaderAssistantAccess(ctx, { t, locationFallback });
    const pending = access.save({ kind: 'bookmark' });
    await Promise.resolve();
    expect(document.querySelector('.lightink-confirm-dialog')).not.toBeNull();
    access.cancelPendingSaves();
    expect(await pending).toEqual({ ok: false, reason: 'rejected' });
    expect(document.querySelector('.lightink-confirm-dialog')).toBeNull();
    expect(appended).toHaveLength(0);
  });
});

describe('createReaderAssistantAccess locate', () => {
  it('ignores out-of-range chapter or page targets', () => {
    const { ctx, jumps } = stubContext({ chapterCount: 3 });
    const access = createReaderAssistantAccess(ctx, { t, locationFallback });
    access.locate({ kind: 'chapter', index: 2 });
    expect(jumps).toEqual([{ level: 1, text: '', anchor: 0, chapter: 2 }]);
    access.locate({ kind: 'chapter', index: 3 });
    access.locate({ kind: 'chapter', index: -1 });
    access.locate({ kind: 'page', page: 1 }); // flow 族没有页落点
    expect(jumps).toHaveLength(1);
  });
});
