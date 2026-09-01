/**
 * `reader-zoom` — reader-view 拆分（T5-kernel-split）的缩放/重排域：PDF/漫画
 * 缩放 applyDisplayScale、字号档位合并去抖 onFontScaleChange（惰性分栏 +
 * 滚动锚点恢复）、onPdfUserZoom、版式变更 syncPaginatedChapter、视口重排
 * refreshViewport 与窗口 resize settle。PDF 路径 rerender 交给句柄；flow
 * 重测委托 flow-renderer。纯移动自 reader-view.ts，行为不变。
 */

import {
  createResizeSettle,
  scrollToKeepViewportAnchor,
  viewportAnchor,
} from '../../ui/reading-layout.js';
import { positionReaderChromePanel } from '../reader-chrome-panels.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

export interface ReaderZoomSurface {
  applyDisplayScale(action: 'in' | 'out' | 'reset'): boolean;
  onFontScaleChange(): void;
  onPdfUserZoom(event: Event): void;
  syncPaginatedChapter(): void;
  refreshViewport(): void;
  onWindowResize(): void;
  cancelViewportRefresh(): void;
}

export function setupReaderZoom(ctx: ReaderViewContext): ReaderZoomSurface {
  /** T6：视口相交的章节索引（翻页模式下即活动章；判定与 flow-renderer 同口径）。 */
  const visibleChapterIndexes = (): Set<number> => {
    const hostRect = ctx.scrollHost.getBoundingClientRect();
    const visible = new Set<number>();
    for (const chapter of ctx.scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      const rect = chapter.getBoundingClientRect();
      if (rect.bottom > hostRect.top && rect.top < hostRect.bottom) {
        visible.add(Number(chapter.dataset.chapterIndex));
      }
    }
    return visible;
  };

  /**
   * T6 缩放性能：字号档位本身便宜（CSS 变量），贵在下游整章 column 重排。
   * 连续缩放（键盘连按 / Ctrl+滚轮在 wheel 层 80ms 节流之上）在消费侧合并
   * 去抖，收敛到 ~200ms settle 后一次性刷新（复用 createResizeSettle 模式）：
   * - 翻页模式：仅视口相交章立即重分栏，离屏章标记惰性（激活时补分栏）；
   * - 滚动模式：复用基座缩放锚点数学（viewportAnchor），缩放后视口锚点
   *   内容不漂移（锚点比率按设计不钳制，见 reading-layout）。
   * PDF 路径不动：渲染缓冲与缩放锚点已由官方 viewer 组件层承担
   * （src/reader/formats/pdf.ts 装配 PDFViewer，缩放走 currentScale）。
   */
  const FONT_SCALE_SETTLE_MS = 200;
  const settleFontScaleRefresh = createResizeSettle(FONT_SCALE_SETTLE_MS);
  /**
   * 双 rAF 后执行 task：滚动模式下 syncVisibleFrames 只改帧内字号，帧高由
   * flow-renderer 的 ResizeObserver→syncHeight 异步重写——settle 同步时刻读
   * 章节几何仍是旧高度，此时恢复锚点等于恒等式（视口漂移不被纠正）。第一帧
   * 后高度重同步落地，第二帧读到新几何再恢复。返回 cancel 与 destroy/
   * 重渲染/下一次缩放对称作废。
   */
  const afterVisibleHeightResync = (task: () => void): (() => void) => {
    let cancelled = false;
    let handle: number | null = null;
    const schedule = (next: () => void): void => {
      handle = requestAnimationFrame(() => {
        handle = null;
        if (!cancelled) {
          next();
        }
      });
    };
    schedule(() => schedule(task));
    return () => {
      cancelled = true;
      if (handle !== null) {
        cancelAnimationFrame(handle);
      }
    };
  };
  const applyFontScaleRefresh = (): void => {
    ctx.cancelFontScaleRefresh = null;
    if (ctx.destroyed || ctx.pdfHandle !== null || ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt)) {
      return;
    }
    const paginated = ctx.flowIsPaginated();
    const scroller = ctx.dom.flowScrollContainer();
    const chapters = Array.from(
      ctx.scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter'),
    );
    const anchor =
      paginated || chapters.length === 0
        ? null
        : viewportAnchor(
            scroller.getBoundingClientRect(),
            chapters.map((chapter) => chapter.getBoundingClientRect()),
            ctx.dom.chapterFromScroll(),
          );
    if (paginated) {
      const stale = new Set<number>();
      for (const chapter of chapters) {
        stale.add(Number(chapter.dataset.chapterIndex));
      }
      for (const index of visibleChapterIndexes()) {
        stale.delete(index);
      }
      ctx.stalePaginatedChapters = stale;
    } else {
      ctx.stalePaginatedChapters = null;
    }
    ctx.flow.syncVisibleFlowFrames();
    if (anchor !== null && chapters[anchor.index] !== undefined) {
      const anchored = chapters[anchor.index]!;
      ctx.cancelFontScaleRefresh = afterVisibleHeightResync(() => {
        ctx.cancelFontScaleRefresh = null;
        if (ctx.destroyed) {
          return;
        }
        // getBoundingClientRect 是视口绝对坐标，scrollToKeepViewportAnchor 期望
        // 相对 scroller 的坐标；不归一化会把应用 chrome（标签栏/侧栏）的偏移
        // 累加进新滚动位置，锚点随每次缩放漂移（与 pdf.ts rerender 同一数学）。
        const scrollerRect = scroller.getBoundingClientRect();
        const next = anchored.getBoundingClientRect();
        scroller.scrollTop = scrollToKeepViewportAnchor(
          scroller,
          {
            left: next.left - scrollerRect.left,
            top: next.top - scrollerRect.top,
            width: next.width,
            height: next.height,
          },
          anchor,
        ).scrollTop;
        ctx.flow.syncFlowState();
        ctx.sessionProgress.schedulePersist();
      });
    }
    ctx.flow.syncFlowState();
    ctx.sessionProgress.schedulePersist();
  };
  const applyDisplayScale = (action: 'in' | 'out' | 'reset'): boolean => {
    const pdf = ctx.pdfHandle;
    if (pdf !== null) {
      const changed =
        action === 'in'
          ? pdf.controller.zoomIn()
          : action === 'out'
            ? pdf.controller.zoomOut()
            : pdf.controller.resetScale();
      if (changed) {
        ctx.paged.syncPageState();
        void pdf.rerender();
      }
      return true;
    }
    if (ctx.cbzHandle === null) return false;
    ctx.cbzHandle.adjustZoom(action);
    return true;
  };

  const onFontScaleChange = (): void => {
    if (ctx.destroyed) {
      return;
    }
    if (ctx.pdfHandle !== null) {
      // PDF 比例是 fit-width × userZoom，不吃阅读字号。
      return;
    }
    // 作废上一轮遗留（settle 定时器或推迟中的锚点恢复 rAF），防止迟到回调用
    // 旧锚点/旧档位中途抢跑。
    ctx.cancelFontScaleRefresh?.();
    ctx.cancelFontScaleRefresh = settleFontScaleRefresh(applyFontScaleRefresh);
  };
  const onPdfUserZoom = (event: Event): void => {
    if (ctx.destroyed || !ctx.sessionAnnotation.tabActive()) {
      return;
    }
    const direction = (event as CustomEvent<{ direction?: number }>).detail?.direction;
    if (direction === 1) {
      applyDisplayScale('in');
      return;
    }
    if (direction === -1) {
      applyDisplayScale('out');
    }
  };

  const refreshOpenSearch = (): void => {
    ctx.search.refreshOpenSearch();
  };

  const syncPaginatedChapter = (): void => {
    if (ctx.destroyed || ctx.pdfHandle !== null || ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt)) {
      return;
    }
    ctx.stalePaginatedChapters = null; // 布局切换重测/重分栏全部帧，作废缩放惰性标记
    const saved = ctx.sessionProgress.captureForRelayout();
    ctx.sessionProgress.persistSnapshot(saved);
    if (!ctx.flowIsPaginated()) {
      ctx.flow.remasureScrollFrames();
      if (saved !== null) {
        ctx.sessionProgress.stage(saved);
        ctx.sessionProgress.applyPending();
      }
      requestAnimationFrame(refreshOpenSearch);
      return;
    }
    if (saved !== null) {
      ctx.sessionProgress.stage(saved);
    }
    ctx.flow.setActiveChapter(saved?.index ?? ctx.dom.chapterFromScroll());
    ctx.flow.remasurePaginatedFrames(saved === null ? undefined : { restoreRatio: saved.ratio });
    if (ctx.sessionProgress.hasPendingRestore()) {
      ctx.sessionProgress.applyPending();
    }
    requestAnimationFrame(refreshOpenSearch);
  };

  const refreshViewport = (): void => {
    if (ctx.destroyed) {
      return;
    }
    if (ctx.pdfHandle !== null) {
      void ctx.pdfHandle.rerender();
      return;
    }
    if (ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt)) {
      return;
    }
    // 未加载文档时没有可重排的内容（也避免骨架/空宿主上的无效重排）。
    if (ctx.readerState.phase !== 'ready') {
      return;
    }
    // 排版/版式变化会触发重排（分栏或重测高），先快照当前位置，重排后恢复，
    // 与 syncPaginatedChapter 的缩放路径同一机制，避免跳回书的开头。
    const saved = ctx.sessionProgress.captureForRelayout();
    if (ctx.flowIsPaginated()) {
      ctx.flow.remasurePaginatedFrames();
    } else {
      ctx.flow.remasureScrollFrames();
    }
    refreshOpenSearch();
    ctx.flow.syncFlowState();
    if (saved !== null) {
      ctx.sessionProgress.stage(saved);
      ctx.sessionProgress.applyPendingWithRetry();
    }
    ctx.annotation.pinSidebarOverlay();
    if (ctx.chromePanel !== null) {
      const panel = ctx.chromePanel === 'toc' ? ctx.tocPanel : ctx.typePanel;
      const action = ctx.chromePanel === 'toc' ? 'toc' : 'typography';
      positionReaderChromePanel(
        panel,
        ctx.root,
        ctx.root.querySelector(`[data-reader-chrome-action="${action}"]`),
      );
    }
  };
  const settleViewportRefresh = createResizeSettle();
  let cancelSettledRefresh: (() => void) | null = null;
  const onWindowResize = (): void => {
    cancelSettledRefresh = settleViewportRefresh(refreshViewport);
  };
  const cancelViewportRefresh = (): void => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
    cancelSettledRefresh?.();
    cancelSettledRefresh = null;
  };

  return {
    applyDisplayScale,
    onFontScaleChange,
    onPdfUserZoom,
    syncPaginatedChapter,
    refreshViewport,
    onWindowResize,
    cancelViewportRefresh,
  };
}
