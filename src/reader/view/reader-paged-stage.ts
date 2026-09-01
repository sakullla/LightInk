/**
 * `reader-paged-stage` — reader-view 拆分（T5-kernel-split）的页式域（PDF/CBZ
 * 共用 paged 面）：paged 族进度供数 pagedProgressFeed、页状态同步 syncPageState、
 * 对称作废 invalidateSharedReadingSurface、PDF 文本层高亮与选区/右键/笔记点击
 * 接线（observeTextLayers/onPageHost*）、漫画 staged 渲染 renderComicStaged、
 * 页宿主换装 commitPagedStaged 与 pagedSessionAdapter（stage 内 PDF/CBZ 分派）。
 * 纯移动自 reader-view.ts，行为不变。
 */

import { renderPdfInto, type PdfRenderHandle } from '../formats/pdf.js';
import {
  renderCbzInto,
  type CbzRenderHandle,
  type ComicArchiveInput,
} from '../formats/cbz.js';
import { ParseError } from '../formats/types.js';
import { stampReadingProgressTitle } from '../reader-progress-ui.js';
import { outlineFromEntries } from '../outline.js';
import {
  comicProgressIdForTarget,
  type SessionProgressFeed,
} from '../session/session-progress.js';
import {
  sessionMemberForExtension,
  type ReaderSessionAdapter,
  type StagedSession,
} from '../session/adapters.js';
import {
  NATIVE_ARCHIVE_EXTENSIONS,
  openNativeArchive,
} from '../sources/native-archive.js';
import { createLocalFileSource } from '../sources/file-source.js';
import type { ReaderTarget } from '../sources/types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { applyReaderLayout } from '../reader-layout.js';
import { pdfTextLocatorFromRange } from '../annotation-locator.js';
import { selectionClientRect } from '../selection-toolbar.js';
import { createCoalescedScrollHandler } from '../../ui/reading-layout.js';
import {
  comicLocaleLabels,
  createReaderPageHost,
  isTextLayerMutation,
  notifyReaderWindowChrome,
  pdfTextLayerSelector,
} from './reader-dom.js';
import { onceSessionInvalidation, type ReaderViewContext } from './reader-context.js';
import {
  annotationMarkSpec,
  renderAnnotationMarks,
  type AnnotationMarkSpec,
} from '../annotation-render.js';

export interface ReaderPagedStageSurface {
  readonly pagedProgressFeed: SessionProgressFeed;
  syncPageState(): void;
  schedulePageScroll(): void;
  invalidateSharedReadingSurface(): void;
  renderPdfHighlights(): void;
  observeTextLayers(host: HTMLElement): void;
  onPageHostSelection(): void;
  onPageHostContextMenu(event: Event): void;
  onPageHostNoteClick(event: MouseEvent): void;
  renderComicStaged(
    archiveSource: ComicArchiveInput,
    stagedHost: HTMLDivElement,
    signal: AbortSignal,
    target: ReaderTarget,
  ): Promise<CbzRenderHandle>;
  commitPagedStaged(staged: {
    host: HTMLDivElement;
    pdf: PdfRenderHandle | null;
    cbz: CbzRenderHandle | null;
  }): void;
  readonly pagedSessionAdapter: ReaderSessionAdapter;
}

export function setupReaderPagedStage(ctx: ReaderViewContext): ReaderPagedStageSurface {
  /** paged 族供数：页句柄快照与按页恢复（PDF/漫画）。 */
  const pagedProgressFeed: SessionProgressFeed = {
    snapshot: () => {
      const page = ctx.pdfHandle?.controller.page ?? ctx.cbzHandle?.currentPage ?? 0;
      if (page < 1) {
        return null;
      }
      const total = ctx.pdfHandle?.controller.totalPages ?? ctx.cbzHandle?.totalPages ?? 0;
      return stampReadingProgressTitle(
        {
          version: 2,
          kind: 'page',
          index: page,
          ratio: 0,
          ...(total > 0 ? { total } : {}),
          updatedAt: Date.now(),
        },
        ctx.readerOutline,
      );
    },
    apply: (saved) => {
      if (ctx.pdfHandle !== null) {
        ctx.pdfHandle.scrollToPage(saved.index);
        return { applied: true };
      }
      if (ctx.cbzHandle !== null) {
        ctx.cbzHandle.scrollToPage(saved.index);
        return { applied: true };
      }
      return { applied: false, pending: 'page-host' };
    },
  };

  const syncPageState = (): void => {
    const current = ctx.pdfHandle?.controller.page ?? ctx.cbzHandle?.currentPage ?? 0;
    const total = ctx.pdfHandle?.controller.totalPages ?? ctx.cbzHandle?.totalPages ?? 0;
    const scale = ctx.pdfHandle?.controller.scale ?? 1;
    const comicOpen = ctx.cbzHandle !== null;
    const wasComic = ctx.root.dataset.comicReader === 'true';
    if (comicOpen) {
      ctx.root.dataset.comicReader = 'true';
    } else {
      delete ctx.root.dataset.comicReader;
    }
    if (wasComic !== comicOpen) {
      notifyReaderWindowChrome();
    }
    ctx.dom.updateReaderState({
      current,
      total,
      progress: total === 0 ? 0 : Math.min(1, Math.max(0, current / total)),
      scale,
      locationKind: total === 0 ? null : 'page',
      comicMetadata: ctx.cbzHandle?.metadata,
    });
    // 页 slot 懒栅格化/缩放重建后角标需要补画（幂等）。
    ctx.bookmarks.syncBookmarkIndicators();
  };

  const onPageScroll = (): void => {
    syncPageState();
    ctx.sessionProgress.schedulePersist();
    if (ctx.selectionToolbar?.isVisible() === true) {
      ctx.annotation.hideSelectionToolbar();
    }
  };
  const pageScrollCoordinator =
    ctx.scrollFrames === null
      ? null
      : createCoalescedScrollHandler(onPageScroll, ctx.scrollFrames);
  const schedulePageScroll = (): void => {
    if (pageScrollCoordinator === null) {
      onPageScroll();
      return;
    }
    pageScrollCoordinator.schedule();
  };

  /**
   * 对称作废合同（R7/T6 review 遗留的结构性保证）：每次内容换装（flow/paged
   * 两族 commit）与 destroy 经同一组摘除助手，作废页滚动监听、待执行的页滚动
   * 合并帧、待 settle 的缩放刷新/锚点恢复与流式惰性分栏标记。各换装点不再
   * 依赖调用处自觉摘除（session-load 管线经 adapter commit/destroy 调用）。
   */
  const invalidateSharedReadingSurface = (): void => {
    // R7：页格式 commit 在共享 pane 上挂的 schedulePageScroll 必须一并摘除——
    // 否则滚动 pane 仍触发 onPageScroll→syncPageState 把流式状态清零，且监听累积。
    ctx.pageHost.removeEventListener('scroll', schedulePageScroll);
    ctx.dom.closestPane()?.removeEventListener('scroll', schedulePageScroll);
    ctx.pageHost.removeEventListener('mouseup', onPageHostSelection);
    ctx.pageHost.removeEventListener('contextmenu', onPageHostContextMenu);
    ctx.pageHost.removeEventListener('click', onPageHostNoteClick);
    ctx.textLayerObserver?.disconnect();
    ctx.textLayerObserver = null;
    pageScrollCoordinator?.cancel();
    ctx.cancelFontScaleRefresh?.();
    ctx.cancelFontScaleRefresh = null;
    ctx.stalePaginatedChapters = null;
  };

  /** PDF 文本层标注：按页分组后经共享幂等引擎渲染（层未就绪则该页跳过，观察器重试）。 */
  const renderPdfHighlights = (): void => {
    const byPage = new Map<number, AnnotationMarkSpec[]>();
    for (const hl of ctx.annotations) {
      if (hl.deletedAt !== undefined) {
        continue; // tombstone 不渲染（v3：删除是带时钟的记录，不是缺席）
      }
      if (hl.kind !== 'highlight' && hl.kind !== 'note') {
        continue;
      }
      const locator = hl.locator;
      if (locator.format !== 'pdf' || locator.anchor === undefined) {
        continue;
      }
      const spec: AnnotationMarkSpec = annotationMarkSpec(hl, locator.anchor);
      const list = byPage.get(locator.page);
      if (list === undefined) {
        byPage.set(locator.page, [spec]);
      } else {
        list.push(spec);
      }
    }
    for (const [page, specs] of byPage) {
      const layer = ctx.pageHost.querySelector<HTMLElement>(pdfTextLayerSelector(page));
      if (layer === null) {
        continue; // 该页文本层尚未懒渲染（官方缓冲已回收/未栅格化），观察器会在层出现时重试
      }
      renderAnnotationMarks(layer, specs);
    }
  };

  /** 文本层懒出现/异步 span 填充/缩放重建后重渲染 PDF 高亮（MutationObserver 驱动）。 */
  const observeTextLayers = (host: HTMLElement): void => {
    ctx.textLayerObserver?.disconnect();
    ctx.textLayerObserver = null;
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    let renderQueued = false;
    ctx.textLayerObserver = new MutationObserver((records) => {
      if (!isTextLayerMutation(records) || renderQueued) {
        return;
      }
      // pdfjs 逐 span 追加会连发多批记录；合并到微任务末尾渲染一次（幂等防重复）。
      renderQueued = true;
      queueMicrotask(() => {
        renderQueued = false;
        renderPdfHighlights();
        ctx.sessionSearch.rerender(); // 层重建后搜索命中 overlay 一并恢复
        ctx.bookmarks.syncBookmarkIndicators(); // 官方 reset 的非 keep-list 清除会摘掉丝带，重建后补回
      });
    });
    ctx.textLayerObserver.observe(host, { childList: true, subtree: true });
  };

  /** PDF 文本层选区（主文档 DOM，无 iframe 偏移）：捕获文字级定位并唤起工具栏。 */
  const onPageHostSelection = (): void => {
    if (ctx.pdfHandle === null) {
      return;
    }
    ctx.sessionProgress.noteActivity(); // 划选同为阅读活动信号（进度 v2 空闲计时）
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      if (!ctx.annotation.keepCommittedSelection()) {
        ctx.annotation.hideSelectionToolbar();
      }
      return;
    }
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const layer = container?.closest('.textLayer') ?? null;
    if (layer === null) {
      // 非文本层选区（canvas/跨页拖选）不处理，但清掉可能滞留的工具栏与过期选区。
      ctx.annotation.hideSelectionToolbar();
      return;
    }
    const pageNumber = Number(layer.closest<HTMLElement>('.page')?.dataset.pageNumber ?? -1);
    if (!(pageNumber >= 1)) {
      return;
    }
    const locator = pdfTextLocatorFromRange(layer, range, pageNumber);
    if (locator === null) {
      ctx.annotation.hideSelectionToolbar();
      return;
    }
    const anchorElement =
      selection.anchorNode === null
        ? null
        : selection.anchorNode.nodeType === 1
          ? (selection.anchorNode as Element)
          : selection.anchorNode.parentElement;
    const existingMark = anchorElement?.closest('[data-annotation-id]') ?? null;
    ctx.pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame: null,
    };
    ctx.annotation.ensureSelectionToolbar();
    ctx.selectionToolbar?.showAt(selectionClientRect(range), {
      canRemoveHighlight: existingMark !== null,
    });
    ctx.annotation.setSelectionToolbarOpen(true);
  };

  const onPageHostContextMenu = (event: Event): void => {
    if (ctx.pdfHandle === null) {
      return;
    }
    const text = typeof window !== 'undefined' ? (window.getSelection()?.toString().trim() ?? '') : '';
    if (text.length > 0) {
      event.preventDefault();
    }
  };

  const onPageHostNoteClick = (event: MouseEvent): void => {
    const annotation = ctx.annotation.annotationFromMark(event.target);
    if (annotation !== null && annotation.kind === 'note') {
      event.preventDefault();
      event.stopPropagation();
      ctx.annotation.openNote(annotation);
    }
    // Page-host clicks bubble once to root; createReaderChrome owns reveal/dismiss.
    // Iframe clicks never bubble, so handleNoteMarkClick still forwards those.
  };

  /** paged 族宿主：漫画归档渲染进离屏宿主（i18n 标签与视图回调闭包）。 */
  const renderComicStaged = (
    archiveSource: ComicArchiveInput,
    stagedHost: HTMLDivElement,
    signal: AbortSignal,
    target: ReaderTarget,
  ): Promise<CbzRenderHandle> => {
    const extraComicLabels = comicLocaleLabels(ctx.t);
    return renderCbzInto(archiveSource, stagedHost, signal, {
      preferenceStorage: ctx.preferenceStorage,
      progressId: comicProgressIdForTarget(target),
      requestPassword: ctx.deps.requestArchivePassword,
      labels: {
        backToShelf: ctx.t('reader.comic.backToShelf'),
        previous: ctx.t('reader.comic.previous'),
        next: ctx.t('reader.comic.next'),
        vertical: ctx.t('reader.comic.vertical'),
        strip: extraComicLabels.strip,
        paged: ctx.t('reader.comic.paged'),
        leftToRight: ctx.t('reader.comic.ltr'),
        rightToLeft: ctx.t('reader.comic.rtl'),
        singlePage: ctx.t('reader.comic.single'),
        doublePage: ctx.t('reader.comic.double'),
        autoPage: extraComicLabels.autoPage,
        fitWidth: ctx.t('reader.comic.fitWidth'),
        fitScreen: extraComicLabels.fitScreen,
        fitHeight: extraComicLabels.fitHeight,
        fitOriginal: extraComicLabels.fitOriginal,
        cropMargins: ctx.t('reader.comic.cropMargins'),
        keepMargins: ctx.t('reader.comic.keepMargins'),
        margins: ctx.t('reader.comic.margins'),
        pageSlider: ctx.t('reader.comic.pageSlider'),
        toggleChrome: ctx.t('reader.comic.toggleChrome'),
        imageDecodeFailed: ctx.t('reader.comic.imageDecodeFailed'),
        retry: ctx.t('reader.comic.retry'),
      },
      onReturnToShelf: ctx.chrome.returnToShelf,
      onPageChange: () => {
        if (ctx.cbzHandle !== null) {
          syncPageState();
          ctx.sessionProgress.schedulePersist();
        }
      },
      onPageListChange: (totalPages, metadata) => {
        ctx.readerOutline = outlineFromEntries(
          Array.from({ length: totalPages }, (_, index) => ({
            title: ctx.t('annotation.location.page', { page: String(index + 1) }),
          })),
          'page',
        );
        if (ctx.cbzHandle !== null) syncPageState();
        void Promise.resolve(ctx.deps.onComicMetadata?.(target, metadata)).catch(() => undefined);
      },
      onArchiveProgress: (progress) => {
        if (progress.phase === 'sequential' && progress.currentEntry < progress.targetEntry) {
          ctx.status.hidden = false;
          ctx.loadTrack.hidden = false;
          ctx.statusLabel.textContent = ctx.t('reader.archive.sequentialProgress', {
            current: String(progress.currentEntry + 1),
            target: String(progress.targetEntry + 1),
          });
        } else if (ctx.readerState.phase === 'ready') {
          ctx.status.hidden = true;
          ctx.loadTrack.hidden = true;
        }
      },
    }).then((cbz) => {
      queueMicrotask(() => {
        void Promise.resolve(ctx.deps.onComicMetadata?.(target, cbz.metadata)).catch(() => undefined);
      });
      return cbz;
    });
  };

  /**
   * paged 族 commit 主体：staged 页宿主换入 live 视图。旧表面的摘除已由管线
   * 作废上一会话（同一组对称作废助手）先行完成；旧句柄释放同样在上一会话的
   * invalidate 里，此处只做换装与监听重挂。
   */
  const commitPagedStaged = (staged: {
    host: HTMLDivElement;
    pdf: PdfRenderHandle | null;
    cbz: CbzRenderHandle | null;
  }): void => {
    invalidateSharedReadingSurface();
    ctx.flow.clearFlowBindings();
    ctx.flowChapterCount = 0;
    ctx.pdfHandle = staged.pdf;
    ctx.cbzHandle = staged.cbz;
    ctx.pageHost.replaceWith(staged.host);
    ctx.pageHost = staged.host;
    ctx.chrome.watchPageChrome();
    if (staged.cbz !== null) {
      ctx.chrome.closeChromePanel();
      ctx.readerChrome?.dismiss();
    }
    ctx.chrome.syncChromeRevealAttr();
    ctx.pageHost.addEventListener('scroll', schedulePageScroll, { passive: true });
    ctx.dom.closestPane()?.addEventListener('scroll', schedulePageScroll, { passive: true });
    ctx.pageHost.addEventListener('mouseup', onPageHostSelection);
    ctx.pageHost.addEventListener('contextmenu', onPageHostContextMenu);
    ctx.pageHost.addEventListener('click', onPageHostNoteClick);
    observeTextLayers(ctx.pageHost); // 文本层懒出现时重渲染该页高亮
    ctx.scrollHost.hidden = true;
    if (staged.pdf !== null) {
      applyReaderLayout(ctx.root, 'scroll');
    }
    syncPageState();
  };

  /** staged 附加面：离屏页宿主与渲染句柄（afterCommit 拉大纲/早绑定用）。 */
  interface PagedStagedLocal extends StagedSession {
    readonly kind: 'paged';
    readonly ext: string;
    readonly host: HTMLDivElement;
    readonly pdf: PdfRenderHandle | null;
    readonly cbz: CbzRenderHandle | null;
  }

  const pagedSessionAdapter: ReaderSessionAdapter = {
    kind: 'paged',
    async stage(request, context) {
      const { target, ext, nativeArchive } = request;
      const signal = context.signal;
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      if (ext !== 'pdf' && ext !== 'cbz' && !NATIVE_ARCHIVE_EXTENSIONS.has(ext)) {
        throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
      }
      const stagedHost = createReaderPageHost();
      stagedHost.hidden = false;
      stagedHost.dataset.readerActive = 'true';
      // 本地 pdf/cbz 走有界随机读（不整本跨 IPC 拷贝）；native 归档 stage 内
      // 开 provider；远程源由管线代开并经 lease 移交渲染器。
      const localPageSource =
        target.kind === 'local' &&
        !nativeArchive &&
        ctx.deps.readChunk !== undefined &&
        ctx.deps.readSize !== undefined
          ? createLocalFileSource({
              size: await ctx.deps.readSize(filePath, signal),
              identity: target.identity,
              readRange: (offset, length, readSignal) =>
                ctx.deps.readChunk!(filePath, offset, length, readSignal ?? signal),
            })
          : null;
      const pageSource = nativeArchive
        ? null
        : target.kind === 'remote'
          ? context.remote.source
          : localPageSource ?? (await ctx.deps.readBytes!(filePath, signal));
      throwIfReaderLoadCancelled(signal);
      if (ext === 'pdf') {
        if (pageSource === null) throw new ParseError('PDF 字节源不可用');
        stagedHost.dataset.readerFormat = 'pdf';
        const pdf = await renderPdfInto(pageSource, stagedHost, signal);
        // 页渲染器接管字节源（随句柄 destroy 关闭）。
        if (context.remote.source !== null) {
          context.remote.release();
        }
        const staged: PagedStagedLocal = {
          kind: 'paged',
          ext,
          host: stagedHost,
          pdf,
          cbz: null,
          commit: () => {
            commitPagedStaged({ host: stagedHost, pdf, cbz: null });
            return onceSessionInvalidation(async () => {
              await pdf.destroy().catch(() => undefined);
            });
          },
          discard: async () => {
            await pdf.destroy().catch(() => undefined);
          },
        };
        return staged;
      }
      stagedHost.dataset.readerFormat = ext;
      const archiveSource = nativeArchive
        ? await (ctx.deps.openArchiveProvider?.(target, signal) ??
          openNativeArchive(target, {
            signal,
            requestPassword: ctx.deps.requestArchivePassword,
          }))
        : pageSource;
      if (archiveSource === null) throw new ParseError('漫画归档字节源不可用');
      const cbz = await renderComicStaged(archiveSource, stagedHost, signal, target);
      if (context.remote.source !== null) {
        context.remote.release();
      }
      const staged: PagedStagedLocal = {
        kind: 'paged',
        ext,
        host: stagedHost,
        pdf: null,
        cbz,
        commit: () => {
          commitPagedStaged({ host: stagedHost, pdf: null, cbz });
          return onceSessionInvalidation(async () => {
            await cbz.destroy().catch(() => undefined);
          });
        },
        discard: async () => {
          await cbz.destroy().catch(() => undefined);
        },
      };
      return staged;
    },
    async afterCommit(staged, request, context) {
      if (staged.kind !== 'paged') {
        return;
      }
      const { pdf, cbz, ext } = staged as PagedStagedLocal;
      const outline =
        pdf !== null
          ? await pdf.outline()
          : outlineFromEntries(
              Array.from({ length: cbz?.totalPages ?? 0 }, (_, index) => ({
                title: ctx.t('annotation.location.page', { page: String(index + 1) }),
              })),
              'page',
            );
      if (!context.isCurrent()) {
        return;
      }
      ctx.readerOutline = outline;
      if (sessionMemberForExtension(ext) === 'comic') {
        // 漫画进度提前绑定：页格式在标注装载前按页恢复（不哈希归档）。
        ctx.sessionProgress.bindComicIdentity(request.target);
        ctx.sessionProgress.applyPendingWithRetry();
      }
    },
  };

  return {
    pagedProgressFeed,
    syncPageState,
    schedulePageScroll,
    invalidateSharedReadingSurface,
    renderPdfHighlights,
    observeTextLayers,
    onPageHostSelection,
    onPageHostContextMenu,
    onPageHostNoteClick,
    renderComicStaged,
    commitPagedStaged,
    pagedSessionAdapter,
  };
}
