/**
 * `reader-search-surface` — reader-view 拆分（T5-kernel-split）的搜索表面域：
 * sessionSearch 的供数回调装配（PDF 文本层命中渲染/flow 章匹配与描述/命中
 * overlay 包裹/首命中滚动）、命中清理 clearReaderSearchMarks、切书复位
 * resetReaderSearch、统一面板同步 syncSearchHits、openSearch 与滞后清除
 * timer。匹配逻辑留格式侧（pdf 句柄 search / findTextHits），世代失效/命中
 * 上限裁决在 session-search。纯移动自 reader-view.ts，行为不变。
 */

import {
  findTextHits,
  htmlToSearchText,
  sanitizeSearchQuery,
  snippetAround,
} from '../search-panel.js';
import {
  alignSearchSpecsToText,
  clearSearchMarks,
  flowSearchMarkKey,
  limitSearchMarkSpecs,
  renderSearchMarks,
  SEARCH_MARK_CURRENT_CLASS,
  type SearchMarkSpec,
} from '../search-overlay.js';
import type { SessionSearchHost } from '../session/session-search.js';
import { pagedFrameStep, snapPagedScroller } from '../../ui/reading-layout.js';
import { readerPagedScroller } from '../flow-renderer.js';
import { cssEscape, pdfTextLayerSelector } from './reader-dom.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

/** 整页搜索关闭后正文命中 mark 的滞后清除窗口：跳转命中短暂高亮后消失。 */
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
    ctx.sessionSearch.clear();
    ctx.sidebar?.setSearchQuery('');
    ctx.sidebar?.render(ctx.annotations);
  };

  const revealFlowMark = (mark: HTMLElement | undefined): void => {
    if (mark === undefined) {
      return;
    }
    const article = mark.ownerDocument?.defaultView?.frameElement?.closest<HTMLElement>(
      '.lightink-reader-chapter',
    );
    const chapter = Number(article?.dataset.chapterIndex ?? Number.NaN);
    const paginated = ctx.flowIsPaginated();
    if (paginated && Number.isSafeInteger(chapter)) {
      ctx.flow.setActiveChapter(chapter);
      const frame = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const frameDocument = frame?.contentDocument;
      if (frame !== undefined && frame !== null && frameDocument !== undefined && frameDocument !== null) {
        ctx.flow.applyPaginatedDocument(frame, frameDocument, { snap: false });
        const scroller = readerPagedScroller(frameDocument);
        const step = pagedFrameStep(scroller);
        const left =
          mark.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
        scroller.scrollLeft = Math.max(0, Math.floor(left / step) * step);
        snapPagedScroller(scroller, step);
        return;
      }
    }
    mark.scrollIntoView({ block: 'center', inline: 'nearest' });
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
   * 打开搜索：打开统一融合面板并聚焦查询框。桌面为侧栏；触屏「搜索正文」
   * 切到整页（data-search-page），不是半高 sheet。
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
      matches.map((match) => ({
        key: `${match.page}:${match.start}:${match.end}`,
        snippet: match.snippet,
        location: ctx.t('annotation.location.page', { page: String(match.page) }),
        payload: { kind: 'pdf', page: match.page, start: match.start, end: match.end },
      })),
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
    flowChapterText: async (chapter) => {
      const mounted = ctx.dom.chapterFrame(chapter)?.contentDocument?.body.textContent ?? '';
      if (mounted.trim() !== '') {
        return mounted;
      }
      const source = ctx.exportChapters[chapter];
      if (source === undefined) {
        return '';
      }
      // ReaderChapter.load 可选（TXT/FB2 无懒装载）：await undefined 与原
      // runFlowSearch 口径一致，缺载章节直接按既有 html 取拼接文本。
      await source.load?.();
      return htmlToSearchText(source.html);
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
        const text =
          mounted.trim() !== ''
            ? mounted
            : htmlToSearchText(ctx.exportChapters[chapter]?.html ?? '');
        for (const spec of groups.get(chapter) ?? []) {
          described.push({
            key: spec.key,
            snippet: snippetAround(text, spec.start, spec.end),
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
        const raw = doc.defaultView?.frameElement?.getAttribute('data-chapter-index');
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
    },
    revealFlowHit: (key) => {
      for (const doc of ctx.dom.flowDocuments()) {
        const mark = doc.body.querySelector<HTMLElement>(
          `[data-search-key="${cssEscape(key)}"]`,
        );
        if (mark !== null) {
          revealFlowMark(mark);
          return;
        }
      }
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
