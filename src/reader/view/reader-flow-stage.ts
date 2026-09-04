/**
 * `reader-flow-stage` — reader-view 拆分（T5-kernel-split）的流式域：flowRenderer
 * 接线（hooks 供数：状态/进度/标注/搜索/翻页/划选）、章节窗口助手
 * （setActiveChapter 惰性分栏/remasure 两族/holdLayoutSwitching 门控）、
 * flow 族进度供数 flowProgressFeed、flow 状态同步与滚动接线（rAF 合并）、
 * renderChapters、commitFlowStaged 与 flowSessionAdapter（txt 分块/EPUB 随机源）。
 * 纯移动自 reader-view.ts，行为不变。
 */

import {
  type FlowRendererHooks,
  readerPagedScroller,
} from '../flow-renderer.js';
import type { ReaderChapter, ReaderContent } from '../formats/types.js';
import { parseReaderContent } from '../formats/index.js';
import type { ReaderInputSource } from '../formats/index.js';
import { createLocalFileSource } from '../sources/file-source.js';
import type { RandomAccessSource } from '../sources/types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import {
  applyReaderDocumentLayout,
  applyReaderLayout,
  loadReaderLayout,
} from '../reader-layout.js';
import { outlineFromEntries } from '../outline.js';
import {
  clampFlowRestoreIndex,
  flowBookProgress,
  stampReadingProgressTitle,
} from '../reader-progress-ui.js';
import { FLOW_RESTORE_MAX_ATTEMPTS } from '../session/session-progress.js';
import {
  chapterScrollRatio,
  chapterScrollTop,
} from '../reading-progress.js';
import {
  applyPagedProgress,
  createCoalescedScrollHandler,
  createPagedWheelGate,
  pagedFrameStep,
  pagedProgressRatio,
  snapPagedScroller,
} from '../../ui/reading-layout.js';
import {
  dispatchReaderFlowLayoutPref,
  notifyReaderWindowChrome,
} from './reader-dom.js';
import { onceSessionInvalidation, PAGE_EXTS, type ReaderViewContext } from './reader-context.js';
import type { SessionProgressFeed } from '../session/session-progress.js';
import type { ReaderSessionAdapter, StagedSession } from '../session/adapters.js';

const COMIC_HOST_DATASET_KEYS = [
  'comicReader',
  'comicChrome',
  'comicCanvas',
  'comicMode',
  'comicDirection',
  'comicSpread',
  'comicSpreadPref',
  'comicFit',
  'comicFitWidth',
  'comicCropMargins',
  'comicVisible',
  'comicZoomed',
  'comicScale',
  'comicPanning',
  'comicDragTurn',
] as const;

/** Drop leftover comic surface attrs so EPUB/PDF do not keep :has() / dock rules. */
function clearComicHostDataset(element: HTMLElement): void {
  for (const key of COMIC_HOST_DATASET_KEYS) {
    delete element.dataset[key];
  }
}

export interface ReaderFlowStageSurface {
  createRendererHooks(): FlowRendererHooks;
  clearFlowBindings(): void;
  setActiveChapter(index: number): void;
  visibleFlowFrame(): HTMLIFrameElement | null;
  applyPaginatedDocument(
    frame: HTMLIFrameElement,
    frameDocument: Document,
    options?: { restoreRatio?: number; snap?: boolean },
  ): void;
  holdLayoutSwitching(work: () => void): void;
  remasureScrollFrames(): void;
  remasurePaginatedFrames(options?: { restoreRatio?: number; snap?: boolean }): void;
  syncVisibleFlowFrames(): void;
  readonly flowProgressFeed: SessionProgressFeed;
  syncFlowState(): void;
  scheduleFlowScroll(): void;
  renderChapters(chapters: ReaderChapter[], stylesheet?: string): void;
  commitFlowStaged(content: ReaderContent): void;
  readonly flowSessionAdapter: ReaderSessionAdapter;
}

export function setupReaderFlowStage(ctx: ReaderViewContext): ReaderFlowStageSurface {
  // T5：章节 iframe 渲染/生命周期拆入 flow-renderer；本编排壳经 hooks 回调
  // 状态机/进度/标注/搜索（hooks 在调用时求值，晚于其定义点亦可）。
  const createRendererHooks = (): FlowRendererHooks => ({
    t: ctx.t,
    remoteImagePolicy: ctx.remoteImagePolicy,
    syncState: () => syncFlowState(),
    applyPendingRestore: () => {
      // 帧 load 后的恢复再驱动：进度会话（session-progress）内计数与续帧。
      ctx.sessionProgress.applyPendingWithRetry();
    },
    onUserScrollIntent: () => {
      if (ctx.sessionProgress.hasPendingRestore()) {
        ctx.sessionProgress.discardPending();
      }
    },
    renderHighlights: () => {
      bindFlowFrameLeftoverEscape();
      ctx.annotation.renderHighlights();
      ctx.bookmarks.syncBookmarkIndicators(); // 惰性挂载的章节窗口也要补书签角标
    },
    handleNoteMarkClick: (event) => {
      const annotation = ctx.annotation.annotationFromMark(event.target);
      if (annotation !== null && annotation.kind === 'note') {
        event.preventDefault();
        ctx.annotation.openNote(annotation);
        return true;
      }
      return false;
    },
    onFrameSurfaceClick: (event) => {
      ctx.sessionProgress.noteActivity(); // iframe 内点击不到 root 监听，经 hook 计入活动
      ctx.readerChrome?.handleSurfaceClick(event);
      ctx.chrome.syncChromeRevealAttr();
    },
    onSelectionMouseUp: (selection, chapter, body, frame) => {
      ctx.sessionProgress.noteActivity(); // iframe 内划选同为阅读活动信号
      ctx.annotation.onFlowSelectionMouseUp(selection, chapter, body, frame);
    },
    openSearch: (seed) => ctx.search.openSearch(seed),
    advanceReading: (direction) => ctx.advanceReading(direction),
    advancePagedWheel: (direction) => {
      if (gatePagedWheel(direction, ctx.advanceReading)) {
        ctx.annotation.hideSelectionToolbar();
        return true;
      }
      return false;
    },
    dismissSelectionToolbar: () => ctx.chrome.dismissReaderOverlayStep(),
    isSelectionToolbarVisible: () => ctx.selectionToolbar?.isVisible() === true,
    isLayoutSwitching: () => ctx.layoutSwitching,
    scrollContainer: () => ctx.dom.flowScrollContainer(),
    onFramePointerMove: ({ clientY }) => {
      ctx.readerChrome?.handlePointerMove({ clientY });
      ctx.chrome.syncChromeRevealAttr();
    },
  });

  const clearFlowBindings = (): void => {
    ctx.flowRenderer.clear();
  };

  const setActiveChapter = (index: number): void => {
    ctx.lastScrollChapter = index;
    ctx.flowRenderer.setActiveChapter(index);
    // T6：离屏章惰性分栏——缩放后仍未按新档分栏的章在激活时补一次
    // applyPaginatedDocument（snap:false 不抢滚动位置，由调用方决定落点）。
    if (
      ctx.stalePaginatedChapters !== null &&
      ctx.flowIsPaginated() &&
      ctx.stalePaginatedChapters.delete(index)
    ) {
      const frame = ctx.scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter[data-chapter-index="${index}"] .lightink-reader-chapter-frame`,
      );
      const frameDocument = frame?.contentDocument ?? null;
      if (frame !== null && frame !== undefined && frameDocument !== null) {
        applyPaginatedDocument(frame, frameDocument, { snap: false });
      }
    }
  };
  const visibleFlowFrame = (): HTMLIFrameElement | null => ctx.flowRenderer.visibleFrame();
  const applyPaginatedDocument = (
    frame: HTMLIFrameElement,
    frameDocument: Document,
    options?: { restoreRatio?: number; snap?: boolean },
  ): void => {
    ctx.flowRenderer.applyPaginatedDocument(frame, frameDocument, options);
  };
  /**
   * 版式切换门控：度量期间挡住帧 ResizeObserver。可重入——外层已持有时
   * 内层不得提前释放，成功或抛错都只由持有方清掉。
   */
  const holdLayoutSwitching = (work: () => void): void => {
    const held = ctx.layoutSwitching;
    ctx.layoutSwitching = true;
    try {
      work();
    } finally {
      if (!held) {
        ctx.layoutSwitching = false;
      }
    }
  };
  const remasureScrollFrames = (): void => {
    holdLayoutSwitching(() => {
      ctx.flowRenderer.remasureScrollFrames();
    });
  };
  /** 切回翻页：按当前可视宽度重算单栏步进后再让 paging enabled() 生效。 */
  const remasurePaginatedFrames = (options?: { restoreRatio?: number; snap?: boolean }): void => {
    holdLayoutSwitching(() => {
      ctx.stalePaginatedChapters = null;
      const frame = visibleFlowFrame();
      const doc = frame?.contentDocument;
      if (frame !== null && doc !== undefined && doc !== null) {
        applyPaginatedDocument(frame, doc, options);
      }
    });
  };
  const syncVisibleFlowFrames = (): void => {
    ctx.flowRenderer.syncVisibleFrames();
  };

  /** flow 族供数：章节窗快照与翻页/滚动两种落位（未就绪只报原因，不裁决）。 */
  const flowProgressFeed: SessionProgressFeed = {
    snapshot: () => {
      const total = ctx.flowChapterCount;
      if (total === 0) {
        return null;
      }
      const chapterIndex = Math.max(0, ctx.readerState.current - 1);
      if (ctx.flowIsPaginated()) {
        const doc = visibleFlowFrame()?.contentDocument;
        const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
        return stampReadingProgressTitle(
          {
            version: 2,
            kind: 'flow',
            index: chapterIndex,
            ratio: scroller === null ? 0 : pagedProgressRatio(scroller),
            total,
            updatedAt: Date.now(),
          },
          ctx.readerOutline,
        );
      }
      const scroller = ctx.dom.flowScrollContainer();
      const article = ctx.scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${chapterIndex}"]`,
      );
      const chapterHeight = article?.offsetHeight ?? 0;
      if (article === null || chapterHeight <= 0) {
        return null;
      }
      return stampReadingProgressTitle(
        {
          version: 2,
          kind: 'flow',
          index: chapterIndex,
          ratio: chapterScrollRatio(
            scroller.scrollTop,
            ctx.dom.articleOffsetInScroller(article, scroller),
            chapterHeight,
          ),
          total,
          updatedAt: Date.now(),
        },
        ctx.readerOutline,
      );
    },
    apply: (saved, { attempts }) => {
      if (ctx.flowChapterCount === 0) {
        return { applied: false, pending: 'flow-content' };
      }
      const restoreIndex = clampFlowRestoreIndex(saved.index, ctx.flowChapterCount);
      if (ctx.flowIsPaginated()) {
        setActiveChapter(restoreIndex);
        const frame = ctx.scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${restoreIndex}"] .lightink-reader-chapter-frame`,
        );
        const frameReady = frame?.dataset.frameReady === 'true';
        const doc = frame?.contentDocument;
        const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
        if (!frameReady) {
          // OPDS chapters often load after the first paint. Clearing pendingRestore
          // here would leave the book at chapter 0 even though the iframe later
          // calls applyPendingRestore.
          return { applied: false, pending: 'flow-frame' };
        }
        if (scroller === null || scroller.clientWidth <= 1) {
          return { applied: false, pending: 'flow-frame-scroller' };
        }
        const step = pagedFrameStep(scroller);
        applyPagedProgress(scroller, saved.ratio, step);
        snapPagedScroller(scroller, step);
        return { applied: true };
      }
      setActiveChapter(restoreIndex);
      const scroller = ctx.dom.flowScrollContainer();
      const article = ctx.scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${restoreIndex}"]`,
      );
      const measurable = article !== null && article.offsetHeight > 1;
      const scrollerReady = scroller.clientHeight > 1;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if ((!scrollerReady || !measurable) && attempts < FLOW_RESTORE_MAX_ATTEMPTS) {
        // 滚动恢复：等章节高度量出来再落点；过早按整本比例会停在开头。
        return { applied: false, pending: 'flow-measure' };
      }
      if (measurable && article !== null) {
        const targetTop = chapterScrollTop(
          ctx.dom.articleOffsetInScroller(article, scroller),
          article.offsetHeight,
          saved.ratio,
        );
        if (targetTop > 0 && maxScroll <= 0 && attempts < FLOW_RESTORE_MAX_ATTEMPTS) {
          return { applied: false, pending: 'flow-scroll-range' };
        }
        scroller.scrollTop = Math.min(maxScroll, targetTop);
      } else if (maxScroll > 0) {
        scroller.scrollTop = Math.min(maxScroll, Math.round(saved.ratio * maxScroll));
      }
      // 滚动恢复成功后记录即最新已知位置（重排窗口按它恢复）。
      return { applied: true, rememberAsSnapshot: true };
    },
  };

  const syncFlowState = (): void => {
    if (ctx.destroyed || ctx.pdfHandle !== null || ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt)) {
      return;
    }
    const total = ctx.flowChapterCount;
    if (total === 0) {
      ctx.dom.updateReaderState({ current: 0, total: 0, progress: 0, scale: 1, locationKind: null });
      return;
    }
    const current = Math.min(total, ctx.dom.firstVisibleChapter() + 1);
    let progress = 0;
    if (ctx.flowIsPaginated()) {
      const doc = visibleFlowFrame()?.contentDocument;
      const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
      progress = flowBookProgress(
        current,
        total,
        scroller === null ? 0 : pagedProgressRatio(scroller),
      );
    } else {
      const scroller = ctx.dom.flowScrollContainer();
      const article = ctx.scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${current - 1}"]`,
      );
      const chapterHeight = article?.offsetHeight ?? 0;
      const localRatio =
        article === null || chapterHeight <= 0
          ? 0
          : chapterScrollRatio(
              scroller.scrollTop,
              ctx.dom.articleOffsetInScroller(article, scroller),
              chapterHeight,
            );
      progress = flowBookProgress(current, total, localRatio);
    }
    ctx.dom.updateReaderState({ current, total, progress, scale: 1, locationKind: 'chapter' });
  };

  const onFlowScroll = (): void => {
    if (ctx.sessionProgress.hasPendingRestore()) {
      ctx.sessionProgress.discardPending();
    }
    if (!ctx.flowIsPaginated()) {
      const index = ctx.dom.chapterFromScroll();
      if (index !== ctx.lastScrollChapter) {
        ctx.lastScrollChapter = index;
        setActiveChapter(index);
      }
    }
    syncFlowState();
    ctx.sessionProgress.rememberSnapshot();
    ctx.sessionProgress.schedulePersist();
    ctx.readerChrome?.syncStayRevealed();
    ctx.chrome.syncChromeRevealAttr();
    ctx.annotation.pinSidebarOverlay();
    ctx.chrome.pinChromeDocks();
    // 工具栏按视口坐标固定定位，滚动后指向失效——直接隐藏。
    if (ctx.selectionToolbar?.isVisible() === true) {
      ctx.annotation.hideSelectionToolbar();
    }
  };
  // 三格式 scroll 统一经 rAF 合并：同帧连发的滚动事件只在帧回调里同步一次
  // 章节/页指示与进度（缺 rAF 环境退化为直调，行为不变）。
  const flowScrollCoordinator =
    ctx.scrollFrames === null
      ? null
      : createCoalescedScrollHandler(onFlowScroll, ctx.scrollFrames);
  ctx.flowScrollCoordinator = flowScrollCoordinator;
  const scheduleFlowScroll = (): void => {
    if (flowScrollCoordinator === null) {
      onFlowScroll();
      return;
    }
    flowScrollCoordinator.schedule();
  };

  /**
   * Flow chapter Escape stays in-frame. Overlay dismiss is already handled by
   * flow-renderer; leftover Escape is forwarded to the parent document so the
   * window-level 合书 listener can returnToShelf.
   */
  const flowFrameEscapeDocs = new WeakSet<Document>();
  const bindFlowFrameLeftoverEscape = (): void => {
    for (const frame of ctx.scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame',
    )) {
      const frameDocument = frame.contentDocument;
      if (frameDocument === null || flowFrameEscapeDocs.has(frameDocument)) {
        continue;
      }
      flowFrameEscapeDocs.add(frameDocument);
      frameDocument.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || ctx.destroyed) {
          return;
        }
        const parentWindow = frameDocument.defaultView?.parent;
        const parentDoc = parentWindow?.document;
        if (parentDoc === undefined || parentDoc === frameDocument) {
          return;
        }
        event.preventDefault();
        parentDoc.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
  };

  /**
   * 流式渲染入口（T5 拆分）：页宿主接线拆除后委托 flow-renderer 创建章节
   * iframe 与帧内生命周期；编排壳只保留宿主切换、活动章与状态同步。页宿主
   * 监听/pending 帧/缩放 settle 的作废由会话管线的对称作废合同先行完成。
   */
  const renderChapters = (chapters: ReaderChapter[], stylesheet = ''): void => {
    ctx.scrollHost.hidden = false;
    ctx.pageHost.hidden = true;
    const leavingComic =
      ctx.pageHost.dataset.comicReader === 'true' || ctx.root.dataset.comicReader === 'true';
    delete ctx.pageHost.dataset.readerActive;
    if (leavingComic) {
      clearComicHostDataset(ctx.pageHost);
      delete ctx.root.dataset.comicReader;
      ctx.pageHost.replaceChildren();
      ctx.chrome.syncChromeRevealAttr();
      notifyReaderWindowChrome();
    }
    ctx.flowChapterCount = chapters.length; // 新文档：帧 load 时各自应用分栏，无待补章
    ctx.flowRenderer.render(chapters, stylesheet);
    setActiveChapter(0);
    syncFlowState();
  };

  const gatePagedWheel = createPagedWheelGate();

  /** staged 附加面：族内 commit/afterCommit 所需载荷（管线只见 StagedSession）。 */
  interface FlowStagedLocal extends StagedSession {
    readonly kind: 'flow';
    readonly ext: string;
    readonly content: ReaderContent;
  }

  /** flow commit 主体：对称作废先行 → 章节渲染 + 导出面/大纲采纳；失败回滚。 */
  const commitFlowStaged = (content: ReaderContent): void => {
    const previousFlowChapterCount = ctx.flowChapterCount;
    const leavingPaged =
      ctx.pdfHandle !== null || ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt);
    ctx.pdfHandle = null;
    ctx.cbzHandle = null;
    // PDF 会话会把宿主钉成 scroll。回到 EPUB 时才恢复存储版式。
    // 每次 flow commit 都写存储值会盖掉测试/会话里已经设好的滚动。
    if (leavingPaged) {
      const stored = loadReaderLayout(ctx.preferenceStorage);
      applyReaderLayout(ctx.root, stored);
      if (typeof document !== 'undefined') {
        applyReaderDocumentLayout(document.documentElement, 'reader', stored);
      }
      dispatchReaderFlowLayoutPref(stored);
    }
    try {
      renderChapters(content.chapters, content.stylesheet);
      ctx.exportChapters = content.chapters;
      ctx.exportStylesheet = content.stylesheet ?? '';
      ctx.exportEmbedImages = content.embedExportImages ?? null;
      ctx.readerOutline = outlineFromEntries(
        content.chapters.map((chapter, index) => ({
          title: chapter.title.trim() || ctx.t('reader.chapter', { n: String(index + 1) }),
        })),
        'chapter',
      );
    } catch (error) {
      content.dispose?.();
      ctx.flowChapterCount = previousFlowChapterCount;
      throw error;
    }
  };

  const flowSessionAdapter: ReaderSessionAdapter = {
    kind: 'flow',
    async stage(request, context) {
      const { target, ext, formatPath } = request;
      const signal = context.signal;
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      // TXT 分块顺序读；EPUB 通过带 read-ahead 的 ZIP 随机源读取，避免先把
      // 整本书跨 IPC 复制进 WebView。依赖缺失时保留整读回退供测试/浏览器使用。
      const readChunk =
        target.kind === 'local' && (ext === 'txt' || ext === 'epub')
          ? ctx.deps.readChunk
          : undefined;
      const localEpubSource: RandomAccessSource | null =
        target.kind === 'local' &&
        ext === 'epub' &&
        readChunk !== undefined &&
        ctx.deps.readSize !== undefined
          ? createLocalFileSource({
              size: await ctx.deps.readSize(filePath, signal),
              identity: target.identity,
              readRange: (offset, length, readSignal) =>
                readChunk(filePath, offset, length, readSignal ?? signal),
            })
          : null;
      const remoteSource = context.remote.source;
      const source: ReaderInputSource =
        remoteSource !== null
          ? remoteSource
          : localEpubSource !== null
            ? localEpubSource
            : readChunk === undefined
              ? await ctx.deps.readBytes!(filePath, signal)
              : {
                  read: (offset, length, readSignal) =>
                    readChunk(filePath, offset, length, readSignal ?? signal),
                };
      // yield 点取消检查：取源期间被取代/取消的加载不得进入解析。
      throwIfReaderLoadCancelled(signal);
      const content = await (ctx.deps.parseContent ?? parseReaderContent)(
        formatPath,
        source,
        signal,
      );
      const ownedRemote = context.remote.source;
      if (ownedRemote !== null) {
        // 远程源所有权折进 content.dispose：换装/销毁时随会话单次关闭。
        const disposeContent = content.dispose;
        content.dispose = () => {
          disposeContent?.();
          void ownedRemote.close().catch(() => undefined);
        };
        context.remote.release();
      }
      const staged: FlowStagedLocal = {
        kind: 'flow',
        ext,
        content,
        commit: () => {
          ctx.paged.invalidateSharedReadingSurface();
          commitFlowStaged(content);
          return onceSessionInvalidation(() => {
            content.dispose?.();
          });
        },
        discard: () => {
          content.dispose?.();
        },
      };
      return staged;
    },
    afterCommit(staged) {
      if (staged.kind !== 'flow') {
        return;
      }
      // 解析 warning（如 epub 样式被丢弃）在就绪前一次性提示。
      for (const warning of (staged as FlowStagedLocal).content.warnings ?? []) {
        ctx.deps.notify?.(ctx.t(`reader.warning.${warning}`));
      }
    },
  };

  return {
    createRendererHooks,
    clearFlowBindings,
    setActiveChapter,
    visibleFlowFrame,
    applyPaginatedDocument,
    holdLayoutSwitching,
    remasureScrollFrames,
    remasurePaginatedFrames,
    syncVisibleFlowFrames,
    flowProgressFeed,
    syncFlowState,
    scheduleFlowScroll,
    renderChapters,
    commitFlowStaged,
    flowSessionAdapter,
  };
}
