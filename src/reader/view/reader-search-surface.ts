/**
 * `reader-search-surface` — reader-view 拆分（T5-kernel-split）的搜索表面域：
 * sessionSearch 的供数回调装配（PDF 文本层命中渲染/flow 章匹配与描述/命中
 * overlay 包裹/首命中滚动）、命中清理 clearReaderSearchMarks、切书复位
 * resetReaderSearch、统一面板同步 syncSearchHits、openSearch 与滞后清除
 * timer。匹配逻辑留格式侧（pdf 句柄 search / findTextHits），世代失效/命中
 * 上限裁决在 session-search。
 */

import {
  findTextHits,
  htmlToSearchText,
  offsetRangeFrom,
  sanitizeSearchQuery,
  snippetWithMark,
  trimSnippetLead,
} from '../search-panel.js';
import {
  alignSearchSpecsToText,
  clearSearchMarks,
  flowSearchMarkKey,
  limitSearchMarkSpecs,
  parseFlowSearchMarkKey,
  renderSearchMarks,
  SEARCH_MARK_CURRENT_CLASS,
  type SearchMarkSpec,
} from '../search-overlay.js';
import { FLOW_FRAME_READY_MS, type SessionSearchHost } from '../session/session-search.js';
import {
  cancelPagedTouchSlide,
  pagedFrameStep,
  pagedGlyphInView,
  pagedHitPagePlausible,
  pagedScrollLeftForClientX,
  realPagedFragmentBox,
  snapPagedScroller,
} from '../../ui/reading-layout.js';
import { readerPagedScroller } from '../flow-renderer.js';
import { cssEscape, pdfTextLayerSelector } from './reader-dom.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

/** 点搜索结果关 sheet 后正文命中 mark 的滞后清除窗口：跳转命中短暂高亮后消失。 */
export const SEARCH_MARK_LINGER_MS = 1800;

export interface ReaderSearchSurface {
  createSessionHost(): SessionSearchHost;
  cancelSearchMarkLinger(): void;
  clearReaderSearchMarks(): void;
  resetReaderSearch(): void;
  syncSearchHits(): void;
  openSearch(query?: string): void;
  refreshOpenSearch(): void;
}

export function setupReaderSearchSurface(ctx: ReaderViewContext): ReaderSearchSurface {
  /**
   * 未挂载章的搜索文本缓存（htmlToSearchText 走 DOMParser，2500 章的书每次
   * 换词全部重解析要好几秒）。随 resetReaderSearch / 切书一起复位。
   */
  const flowSearchTextCache = new Map<number, string>();

  const flowSourceText = (chapter: number): string => {
    const cached = flowSearchTextCache.get(chapter);
    if (cached !== undefined) {
      return cached;
    }
    const html = ctx.exportChapters[chapter]?.html ?? '';
    const text = htmlToSearchText(html);
    if (html !== '') {
      flowSearchTextCache.set(chapter, text); // 未物化章（html 空）不缓存，load 后再算
    }
    return text;
  };

  const cancelSearchMarkLinger = (): void => {
    if (ctx.searchMarkLingerTimer !== null) {
      clearTimeout(ctx.searchMarkLingerTimer);
      ctx.searchMarkLingerTimer = null;
    }
  };

  /** 清掉全部搜索命中 overlay（PDF 文本层与流式正文，span 解包保留文本）。 */
  const clearReaderSearchMarks = (): void => {
    for (const layer of ctx.pageHost.querySelectorAll('.pdfViewer .textLayer')) {
      clearSearchMarks(layer);
    }
    for (const doc of ctx.dom.flowDocuments()) {
      clearSearchMarks(doc.body);
    }
  };

  /** 切换文档：清搜索会话与命中 overlay，并复位侧栏搜索框（查询不跨书残留）。 */
  const resetReaderSearch = (): void => {
    cancelSearchMarkLinger(); // 上一本书残留的滞后清除不落到新会话头上
    flowSearchTextCache.clear();
    ctx.sessionSearch.clear();
    ctx.sidebar?.setSearchQuery('');
    ctx.sidebar?.render(ctx.annotations);
  };

  const scrollElementIntoView = (node: HTMLElement, options: ScrollIntoViewOptions): void => {
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView(options);
    }
  };

  const pageBoxFromRects = (
    doc: Document,
    rects: ArrayLike<{ left: number; width: number; height: number }>,
    lineSource: Element,
  ): { left: number; width: number; height: number } | null => {
    const boxes: Array<{ left: number; width: number; height: number }> = [];
    for (const rect of Array.from(rects)) {
      boxes.push({ left: rect.left, width: rect.width, height: rect.height });
    }
    const lineHeight = Number.parseFloat(
      doc.defaultView?.getComputedStyle(lineSource).lineHeight ?? '',
    );
    return realPagedFragmentBox(boxes, lineHeight);
  };

  const searchMarkPageBox = (mark: HTMLElement): { left: number; width: number; height: number } | null => {
    const doc = mark.ownerDocument;
    const boxes: Array<{ left: number; width: number; height: number }> = [];
    const pushRects = (rects: DOMRectList): void => {
      for (const rect of Array.from(rects)) {
        boxes.push({ left: rect.left, width: rect.width, height: rect.height });
      }
    };
    try {
      const range = doc.createRange();
      range.selectNodeContents(mark);
      pushRects(range.getClientRects());
    } catch {
      // jsdom / detached
    }
    if (boxes.length === 0) {
      try {
        pushRects(mark.getClientRects());
      } catch {
        // jsdom
      }
    }
    return pageBoxFromRects(doc, boxes, mark);
  };

  const alignedHitRange = (doc: Document, key: string): Range | null => {
    const query = ctx.sessionSearch.query()?.trim() ?? '';
    const parsed = parseFlowSearchMarkKey(key);
    const text = doc.body.textContent ?? '';
    const specs = alignSearchSpecsToText(
      text,
      parsed === null ? [] : [{ key, start: parsed.start, end: parsed.end }],
      query,
    );
    const spec = specs[0];
    if (spec !== undefined) {
      return offsetRangeFrom(doc.body, spec.start, spec.end);
    }
    if (query === '') {
      return null;
    }
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) {
      return null;
    }
    return offsetRangeFrom(doc.body, idx, idx + query.length);
  };

  const chapterIndexFromSearchKey = (key: string): number | null => {
    const chapter = Number(key.split(':')[0]);
    return Number.isSafeInteger(chapter) && chapter >= 0 ? chapter : null;
  };

  const searchMarkInChapter = (key: string, chapter: number): HTMLElement | null => {
    const doc = ctx.dom.chapterFrame(chapter)?.contentDocument;
    if (doc === null || doc === undefined) {
      return null;
    }
    return doc.body.querySelector(`[data-search-key="${cssEscape(key)}"]`);
  };

  const paintFlowHitMark = (chapter: number, key: string): HTMLElement | null => {
    const existing = searchMarkInChapter(key, chapter);
    if (existing !== null) {
      return existing;
    }
    const doc = ctx.dom.chapterFrame(chapter)?.contentDocument;
    if (doc === null || doc === undefined) {
      return null;
    }
    const query = ctx.sessionSearch.query()?.trim() ?? '';
    const parsed = parseFlowSearchMarkKey(key);
    const specs = alignSearchSpecsToText(
      doc.body.textContent ?? '',
      parsed === null ? [] : [{ key, start: parsed.start, end: parsed.end }],
      query,
    );
    if (specs.length === 0) {
      return null;
    }
    renderSearchMarks(doc.body, specs, key);
    return searchMarkInChapter(key, chapter);
  };

  const releasePagedSearchHold = (key: string): void => {
    const chapter = chapterIndexFromSearchKey(key);
    if (chapter === null) {
      return;
    }
    const frame = ctx.dom.chapterFrame(chapter);
    if (frame === null) {
      return;
    }
    delete frame.dataset.pagedSearchHold;
    delete frame.dataset.pagedSearchLaidOut;
  };

  const revealPagedHitBox = (
    frame: HTMLIFrameElement,
    frameDocument: Document,
    article: HTMLElement,
    box: { left: number; width: number; height: number },
    key: string,
    measureAfter: () => { left: number; width: number; height: number } | null,
  ): boolean => {
    const frameReady = frame.clientWidth > 32 || article.offsetWidth > 32;
    if (!frameReady) {
      return false;
    }
    let hitBox = box;
    if (frame.dataset.pagedSearchLaidOut !== 'true') {
      // 这一跳只分栏一次；读 offsetWidth 强制同步排版，不用再等一帧回来量。
      delete frame.dataset.pagedRestore;
      ctx.flow.applyPaginatedDocument(frame, frameDocument, { snap: false });
      const laidOut = readerPagedScroller(frameDocument);
      void laidOut.offsetWidth;
      if (!(pagedFrameStep(laidOut) > 1)) {
        return false;
      }
      frame.dataset.pagedSearchLaidOut = 'true';
      const fresh = measureAfter();
      if (fresh === null) {
        return false;
      }
      hitBox = fresh;
    }
    const scroller = readerPagedScroller(frameDocument);
    void article.offsetHeight;
    void scroller.offsetWidth;
    const step = pagedFrameStep(scroller);
    if (!(step > 0)) {
      return false;
    }
    const scrollerBox = scroller.getBoundingClientRect();
    const target = pagedScrollLeftForClientX(
      hitBox.left,
      scrollerBox.left,
      scroller.scrollLeft,
      step,
    );
    cancelPagedTouchSlide(scroller);
    scroller.scrollLeft = target;
    snapPagedScroller(scroller, step);
    const after = measureAfter();
    if (after === null) {
      return false;
    }
    const inView = pagedGlyphInView(
      after.left,
      scroller.getBoundingClientRect().left,
      scroller.clientWidth,
    );
    if (!inView) {
      return false;
    }
    const parsed = parseFlowSearchMarkKey(key);
    return pagedHitPagePlausible(
      scroller.scrollLeft,
      scroller.scrollWidth,
      step,
      parsed?.start ?? 0,
      (frameDocument.body.textContent ?? '').length,
    );
  };

  const revealFlowMarkNow = (mark: HTMLElement, key: string): boolean => {
    const article = mark.ownerDocument?.defaultView?.frameElement?.closest<HTMLElement>(
      '.lightink-reader-chapter',
    );
    const chapter = Number(article?.dataset.chapterIndex ?? Number.NaN);
    const paginated = ctx.flowIsPaginated();
    if (paginated && Number.isSafeInteger(chapter) && article !== null && article !== undefined) {
      ctx.flow.setActiveChapter(chapter);
      const frame = article.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const frameDocument = frame?.contentDocument;
      if (frame !== null && frameDocument !== undefined && frameDocument !== null) {
        const markBox = searchMarkPageBox(mark);
        if (markBox !== null) {
          return revealPagedHitBox(frame, frameDocument, article, markBox, key, () =>
            searchMarkPageBox(mark),
          );
        }
      }
      return false;
    }
    scrollElementIntoView(mark, { block: 'center', inline: 'nearest' });
    return true;
  };

  const revealFlowMark = (key: string): boolean => {
    const chapter = chapterIndexFromSearchKey(key);
    if (chapter === null) {
      return false;
    }
    const mark = paintFlowHitMark(chapter, key) ?? searchMarkInChapter(key, chapter);
    if (mark !== null) {
      return revealFlowMarkNow(mark, key);
    }
    const frame = ctx.dom.chapterFrame(chapter);
    const frameDocument = frame?.contentDocument;
    const article = frame?.closest<HTMLElement>('.lightink-reader-chapter');
    if (
      frame === null ||
      frameDocument === undefined ||
      frameDocument === null ||
      article === null ||
      article === undefined
    ) {
      return false;
    }
    if (!ctx.flowIsPaginated()) {
      return false;
    }
    ctx.flow.setActiveChapter(chapter);
    const range = alignedHitRange(frameDocument, key);
    if (range === null) {
      return false;
    }
    let rects: Array<{ left: number; width: number; height: number }> = [];
    try {
      rects = Array.from(range.getClientRects()).map((rect) => ({
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }));
    } catch {
      return false;
    }
    const box = pageBoxFromRects(frameDocument, rects, frameDocument.body);
    if (box === null) {
      return false;
    }
    return revealPagedHitBox(frame, frameDocument, article, box, key, () => {
      const next = alignedHitRange(frameDocument, key);
      if (next === null) {
        return null;
      }
      try {
        return pageBoxFromRects(
          frameDocument,
          Array.from(next.getClientRects()).map((rect) => ({
            left: rect.left,
            width: rect.width,
            height: rect.height,
          })),
          frameDocument.body,
        );
      } catch {
        return null;
      }
    });
  };

  /** 命中表面同步：统一面板（桌面侧栏/触屏 sheet 同一实例）消费会话的 hitViews/hitsState。 */
  const syncSearchHits = (): void => {
    if (ctx.sidebar === null) {
      return;
    }
    const query = ctx.sidebar.getSearchQuery().trim();
    if (query === '') {
      ctx.sidebar.render(ctx.annotations);
      return;
    }
    ctx.sidebar.renderHits(ctx.sessionSearch.hitViews(), ctx.sessionSearch.hitsState());
  };

  const currentSearchSelection = (): string => {
    if (ctx.pendingSelection !== null) {
      const seeded = sanitizeSearchQuery(ctx.pendingSelection.quote);
      if (seeded !== '') {
        return seeded;
      }
    }
    for (const frame of ctx.scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame',
    )) {
      const seeded = sanitizeSearchQuery(frame.contentWindow?.getSelection()?.toString() ?? '');
      if (seeded !== '') {
        return seeded;
      }
    }
    return sanitizeSearchQuery(typeof window !== 'undefined' ? window.getSelection()?.toString() : '');
  };

  /**
   * 打开搜索：打开统一融合面板并聚焦查询框。桌面为侧栏；触屏为铺满
   * 阅读器的全页窗口（盖住底栏），搜索框骨架不随范围切换改形。
   */
  const openSearch = (query?: string): void => {
    const scroller = ctx.dom.flowScrollContainer();
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    ctx.annotation.setSidebarVisible(true);
    const seed = sanitizeSearchQuery(query) || currentSearchSelection();
    if (seed !== '') {
      ctx.sidebar?.setSearchQuery(seed);
      ctx.sessionSearch.run(seed);
    } else if ((ctx.sidebar?.getSearchQuery() ?? '').trim() === '') {
      ctx.sidebar?.render(ctx.annotations);
    } else {
      syncSearchHits();
    }
    ctx.sidebar?.focusSearch();
    ctx.annotation.pinSidebarOverlay();
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  };

  const refreshOpenSearch = (): void => {
    if (!ctx.sessionAnnotation.tabActive()) {
      return;
    }
    if (!ctx.sessionAnnotation.sidebarVisibility().visible || ctx.sidebar === null) {
      return;
    }
    const query = (ctx.sidebar.getSearchQuery() || ctx.sessionSearch.query() || '').trim();
    if (query === '') {
      return;
    }
    ctx.sessionSearch.run(query, { preserveActive: ctx.sessionSearch.activeIndex() });
  };

  /**
   * 搜索会话（世代失效/防抖重查合并/命中上限/busy reveal/首命中滚动/活动命中
   * 步进）唯一实现在 session-search；本壳按族供数与接线：匹配器留格式侧
   * （pdf 句柄 search / findTextHits 章匹配），命中 overlay 经共享幂等引擎渲染。
   */
  const createSessionHost = (): SessionSearchHost => ({
    activeKind: () => (ctx.pdfHandle !== null ? 'pdf' : 'flow'),
    isDestroyed: () => ctx.destroyed,
    syncHits: () => syncSearchHits(),
    clearMarks: () => clearReaderSearchMarks(),
    searchPdf: (query, sink) => {
      const handle = ctx.pdfHandle;
      if (handle === null) {
        return;
      }
      void (async () => {
        const matches = await handle.search(query, {
          onProgress: (partial, done) => {
            if (handle === ctx.pdfHandle) {
              sink.onResult(partial, done); // 句柄被取代后不再回投
            }
          },
        });
        if (handle === ctx.pdfHandle) {
          sink.onResult(matches, true);
        }
      })().catch(() => {
        // 关书/切换恰逢全文搜索：在飞的 getPage/getTextContent 随 destroy
        // reject，会话已作废，静默收尾避免 unhandled rejection 噪音。
      });
    },
    describePdfHits: (matches) =>
      matches.map((match) => {
        const snippet =
          match.markStart !== undefined && match.markEnd !== undefined
            ? trimSnippetLead({
                text: match.snippet,
                markStart: match.markStart,
                markEnd: match.markEnd,
              })
            : { text: match.snippet, markStart: match.markStart, markEnd: match.markEnd };
        return {
          key: `${match.page}:${match.start}:${match.end}`,
          snippet: snippet.text,
          markStart: snippet.markStart,
          markEnd: snippet.markEnd,
          location: ctx.t('annotation.location.page', { page: String(match.page) }),
          payload: { kind: 'pdf' as const, page: match.page, start: match.start, end: match.end },
        };
      }),
    pdfCurrentPage: () => ctx.pdfHandle?.controller.page ?? 1,
    renderPdfHits: (hits, activeKey) => {
      const pdfTextLayerFor = (page: number): HTMLElement | null =>
        ctx.pageHost.querySelector<HTMLElement>(pdfTextLayerSelector(page));
      const byPage = new Map<number, SearchMarkSpec[]>();
      for (const hit of hits) {
        if (hit.payload.kind !== 'pdf') {
          continue;
        }
        const spec: SearchMarkSpec = {
          key: hit.key,
          start: hit.payload.start,
          end: hit.payload.end,
        };
        const list = byPage.get(hit.payload.page);
        if (list === undefined) {
          byPage.set(hit.payload.page, [spec]);
        } else {
          list.push(spec);
        }
      }
      for (const [page, specs] of byPage) {
        const layer = pdfTextLayerFor(page);
        if (layer === null) {
          continue; // 未懒渲染的页跳过；层出现时经 observer 重渲染
        }
        renderSearchMarks(layer, limitSearchMarkSpecs(specs, activeKey), activeKey);
      }
      // 激活滚动：该命中即 pending 目标且当前命中 overlay 已就绪时，滚动一次即消费。
      const active = hits.find((hit) => hit.key === activeKey);
      if (active !== undefined && active.payload.kind === 'pdf') {
        const activeMark =
          pdfTextLayerFor(active.payload.page)?.querySelector<HTMLElement>(
            `.${SEARCH_MARK_CURRENT_CLASS}`,
          ) ?? null;
        if (activeMark !== null && ctx.sessionSearch.consumePendingScroll(activeKey, true)) {
          activeMark.scrollIntoView({ block: 'nearest' });
        }
      }
    },
    activatePdfHit: (hit) => {
      if (hit.payload.kind !== 'pdf') {
        return;
      }
      ctx.pdfHandle?.scrollToPage(hit.payload.page);
      ctx.paged.syncPageState();
    },
    flowSearchable: () => !PAGE_EXTS.has(ctx.loadedExt),
    flowChapterCount: () => Math.max(ctx.exportChapters.length, ctx.flowChapterCount),
    flowChapterText: (chapter) => {
      const mounted = ctx.dom.chapterFrame(chapter)?.contentDocument?.body.textContent ?? '';
      if (mounted.trim() !== '') {
        return mounted;
      }
      const cached = flowSearchTextCache.get(chapter);
      if (cached !== undefined) {
        return cached;
      }
      const source = ctx.exportChapters[chapter];
      if (source === undefined) {
        return '';
      }
      // ReaderChapter.load 可选（TXT/FB2 无懒装载）：已物化的章同步返回，
      // 扫描循环不必为每章排一次微任务。
      if (source.load === undefined) {
        return flowSourceText(chapter);
      }
      return source.load().then(
        () => flowSourceText(chapter),
        () => '',
      );
    },
    flowMatchChapter: (chapter, text, query) =>
      findTextHits(text, query).map((hit, ordinal) => ({
        key: flowSearchMarkKey(chapter, ordinal, hit.start, hit.end),
        start: hit.start,
        end: hit.end,
      })),
    describeFlowHits: (groups) => {
      const described = [];
      const chapters = [...groups.keys()].sort((left, right) => left - right);
      for (const chapter of chapters) {
        const mounted = ctx.dom.chapterFrame(chapter)?.contentDocument?.body.textContent ?? '';
        const text = mounted.trim() !== '' ? mounted : flowSourceText(chapter);
        for (const spec of groups.get(chapter) ?? []) {
          const snippet = trimSnippetLead(snippetWithMark(text, spec.start, spec.end));
          described.push({
            key: spec.key,
            snippet: snippet.text,
            markStart: snippet.markStart,
            markEnd: snippet.markEnd,
            location: ctx.t('reader.chapter', { n: String(chapter + 1) }),
            payload: { kind: 'flow' as const, chapter, start: spec.start, end: spec.end },
          });
        }
      }
      return described;
    },
    renderFlowHits: (groups, currentKey) => {
      // 命中按帧宿主的真实章节索引投放：挂载窗口随阅读位置滑动（±3 淘汰），
      // 帧在数组里的序号 ≠ 章节号——按序号取 spec 会把 A 章偏移画进 B 章正文
      // （错字高亮），且正确章的 mark 不存在导致 collectFlowMarks 收不到、
      // 点击命中无法跳转。
      // 偏移对齐：未挂载章扫描用的 fallback 文本空白折叠过，与挂载正文的
      // textContent 形态不同，直接照偏移包裹会逐段漂移高亮错字。
      const query = ctx.sessionSearch.query() ?? '';
      for (const doc of ctx.dom.flowDocuments()) {
        const frame = doc.defaultView?.frameElement;
        const raw =
          (frame instanceof HTMLElement ? frame.getAttribute('data-chapter-index') : null) ??
          (frame instanceof HTMLElement
            ? frame.closest('[data-chapter-index]')?.getAttribute('data-chapter-index')
            : null);
        if (raw == null) {
          continue;
        }
        const chapter = Number(raw);
        if (!Number.isInteger(chapter)) {
          continue;
        }
        const specs = alignSearchSpecsToText(
          doc.body.textContent ?? '',
          groups.get(chapter) ?? [],
          query,
        );
        renderSearchMarks(doc.body, limitSearchMarkSpecs(specs, currentKey), currentKey);
      }
    },
    collectFlowMarks: (groups) => {
      const keys: string[] = [];
      const currentChapter = Math.max(0, ctx.readerState.current - 1);
      let firstAtOrAfter = -1;
      for (const [chapter, specs] of groups) {
        const doc = ctx.dom.chapterFrame(chapter)?.contentDocument;
        if (doc === null || doc === undefined) {
          continue;
        }
        for (const spec of specs) {
          if (doc.body.querySelector(`[data-search-key="${cssEscape(spec.key)}"]`) === null) {
            continue;
          }
          if (firstAtOrAfter < 0 && chapter >= currentChapter) {
            firstAtOrAfter = keys.length;
          }
          keys.push(spec.key);
        }
      }
      return { keys, firstAtOrAfter };
    },
    ensureFlowChapter: (chapter) => {
      ctx.flowRenderer.ensureChapter(chapter);
      ctx.flow.setActiveChapter(chapter);
      const frame = ctx.dom.chapterFrame(chapter);
      if (frame !== null) {
        frame.dataset.pagedSearchHold = 'true';
        delete frame.dataset.pagedRestore;
        delete frame.dataset.pagedSearchLaidOut;
      }
    },
    whenFlowFrameReady: async (chapter) => {
      const started = Date.now();
      while (Date.now() - started < FLOW_FRAME_READY_MS) {
        const frame = ctx.dom.chapterFrame(chapter);
        const text = frame?.contentDocument?.body?.textContent ?? '';
        // 正文一到就返回：落点自己会 applyPaginatedDocument 并强制同步排版，
        // 不必再等 CSS 分栏慢慢出现。
        if (text.length > 0) {
          return;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 16);
        });
      }
    },
    flowHitReady: (key, chapter) => {
      const parsed = parseFlowSearchMarkKey(key);
      if (parsed !== null && parsed.chapter !== chapter) {
        return false;
      }
      const frame = ctx.dom.chapterFrame(chapter);
      if (frame === null || frame.dataset.chapterIndex !== String(chapter)) {
        return false;
      }
      if (frame.dataset.frameReady !== 'true' && (frame.contentDocument?.body.textContent ?? '') === '') {
        return false;
      }
      const article = frame.closest('.lightink-reader-chapter');
      if (!(article instanceof HTMLElement) || !article.classList.contains('is-active')) {
        return false;
      }
      if (frame.clientWidth <= 32 && article.offsetWidth <= 32) {
        return false;
      }
      const doc = frame.contentDocument;
      if (doc === null) {
        return false;
      }
      const query = ctx.sessionSearch.query()?.trim() ?? '';
      const text = doc.body.textContent ?? '';
      if (text.length === 0) {
        return false;
      }
      if (query !== '' && !text.toLowerCase().includes(query.toLowerCase())) {
        return false;
      }
      // 分栏与否不在这里卡：revealPagedHitBox 会自己分栏并校验落点页。
      return true;
    },
    revealFlowHit: (key) => revealFlowMark(key),
    endFlowHitReveal: (key) => {
      if (!ctx.sessionAnnotation.sidebarVisibility().shown) {
        cancelSearchMarkLinger();
        ctx.searchMarkLingerTimer = setTimeout(() => {
          ctx.searchMarkLingerTimer = null;
          if (!ctx.destroyed) {
            ctx.sessionSearch.dropMarks();
          }
        }, SEARCH_MARK_LINGER_MS);
      }
      const releaseHold = (): void => {
        releasePagedSearchHold(key);
      };
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(releaseHold, 80);
        return;
      }
      releaseHold();
    },
    releaseFlowHitHold: (key) => {
      releasePagedSearchHold(key);
    },
  });

  return {
    createSessionHost,
    cancelSearchMarkLinger,
    clearReaderSearchMarks,
    resetReaderSearch,
    syncSearchHits,
    openSearch,
    refreshOpenSearch,
  };
}
