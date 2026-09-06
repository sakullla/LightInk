/**
 * Comic archive rendering shared by CBZ, CBR, CB7, and nested archives.
 *
 * Archive entries stay behind ArchiveProvider. Only pages selected by the
 * decoded-byte budget are materialized in the WebView.
 *
 * 本文件是装配入口（T1 拆分，ADR-1）：归档收集（readComicInfo/
 * collectComicPages/listImageEntries）、对外契约（CbzRenderHandle/
 * CbzRenderOptions）与 renderCbzInto 组合 src/reader/comic/ 各职责模块：
 * pages（物化/裁边扫描）、cache（缓存窗口/预取）、layout（fit/重排版）、
 * zoom（缩放/平移/重栅格钉住）、turn（decode-gated 换屏/View Transition）、
 * drag-turn（跟手翻页）、gestures（指针/滚轮/滚动同步）、chrome（DOM/显隐）。
 */

import { ParseError } from './types.js';
import { openSafeArchive, type ArchiveInput } from './safe-archive.js';
import { decodeReaderText } from './text-encoding.js';
import type {
  ArchiveEntryMetadata,
  ArchiveProvider,
  ArchiveReadProgress,
} from '../sources/types.js';
import type { ArchivePasswordProvider } from '../sources/native-archive.js';
import { enforcePageCount, READER_LIMITS } from '../reader-limits.js';
import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import { rafFrameScheduler } from '../../ui/reading-layout.js';
import {
  compareComicPaths,
  isComicImagePath,
  isIgnoredComicPath,
  orderComicPages,
  parseComicInfo,
  type ComicMetadata,
} from '../comic-model.js';
import {
  advanceComicPage,
  comicPageFromProgress,
  comicSpreadList,
  comicSpreadStart,
  comicVisiblePages,
  loadComicPreferences,
  saveComicPreferences,
  type ComicFit,
  type ComicPreferenceStorage,
  type ComicPreferences,
  type ComicReadingMode,
} from '../comic-preferences.js';
import {
  cancelPendingTap,
  comicLayoutSpreadPrefs,
  createAbortableLimiter,
  type CollectedComicPages,
  type ComicArchiveEntry,
  type ComicSession,
} from '../comic/comic-session.js';
import {
  DEFAULT_COMIC_CACHE_BUDGET,
  refreshCacheWindow,
  stripCacheCenters,
} from '../comic/comic-cache.js';
import {
  buildComicChrome,
  notifyComicSystemBars,
  revealChrome,
  scheduleChromeHide,
  setChromeVisible,
  updateToolbar,
} from '../comic/comic-chrome.js';
import { createComicSlot, loadPage, releasePage } from '../comic/comic-pages.js';
import { applyLayout } from '../comic/comic-layout.js';
import {
  cancelZoomRasterCommit,
  resetViewTransform,
  scheduleZoomRasterCommit,
  unpinZoomRaster,
  zoomAt,
} from '../comic/comic-zoom.js';
import { showPagedSpread } from '../comic/comic-turn.js';
import { resetDragTurn } from '../comic/comic-drag-turn.js';
import {
  createComicGestureHandlers,
  observeComicStripSlots,
} from '../comic/comic-gestures.js';

const COMIC_ARCHIVE_EXTS = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7']);

export const naturalCompare = compareComicPaths;

/** Filter non-page entries and return a stable path-segment natural order. */
export function listImageEntries(names: readonly string[]): string[] {
  return names.filter(isComicImagePath).sort(compareComicPaths);
}

export interface ComicToolbarLabels {
  readonly backToShelf: string;
  readonly previous: string;
  readonly next: string;
  readonly vertical: string;
  readonly strip?: string;
  readonly paged: string;
  readonly leftToRight: string;
  readonly rightToLeft: string;
  readonly singlePage: string;
  readonly doublePage: string;
  readonly autoPage?: string;
  readonly fitWidth: string;
  readonly fitScreen?: string;
  readonly fitHeight?: string;
  readonly fitOriginal?: string;
  readonly cropMargins: string;
  readonly keepMargins?: string;
  readonly margins?: string;
  readonly pageSlider: string;
  readonly toggleChrome: string;
  readonly imageDecodeFailed: string;
  readonly nestedArchive: string;
  readonly nestedArchiveFailed: string;
  readonly openingNestedArchive: string;
  readonly retry: string;
}

/** Accepts the current contract plus v2 `vertical` / `fitWidth` patches. */
export type ComicPreferencesPatch = Partial<ComicPreferences> & {
  readonly mode?: ComicReadingMode | 'vertical';
  readonly fitWidth?: boolean;
};

export interface CbzRenderHandle {
  readonly totalPages: number;
  readonly currentPage: number;
  readonly metadata: ComicMetadata;
  readonly preferences: ComicPreferences;
  scrollToPage(page: number): void;
  scrollToProgress(progress: number): void;
  nextPage(): boolean;
  previousPage(): boolean;
  setPreferences(patch: ComicPreferencesPatch): void;
  hideChrome(): boolean;
  adjustZoom(action: 'in' | 'out' | 'reset'): void;
  destroy(): Promise<void>;
}

export type ComicArchiveInput = ArchiveInput | ArchiveProvider;

export interface CbzRenderOptions {
  readonly requestPassword?: ArchivePasswordProvider;
  readonly onArchiveProgress?: (progress: ArchiveReadProgress) => void;
  readonly onPageChange?: () => void;
  readonly onPageListChange?: (totalPages: number, metadata: ComicMetadata) => void;
  readonly cacheBudgetBytes?: number;
  readonly preferenceStorage?: ComicPreferenceStorage | null;
  readonly progressId?: string | null;
  readonly labels?: Partial<ComicToolbarLabels>;
  readonly onReturnToShelf?: () => void;
  /**
   * Android 系统栏成对显隐。未注入时走 MainActivity 桥 / Tauri invoke；
   * 失败忽略。桌面默认不调用。
   */
  readonly setSystemBarsVisible?: (visible: boolean) => void | Promise<void>;
}

const COMIC_FIT_CYCLE: readonly ComicFit[] = ['screen', 'width', 'height', 'original'];

function resolveComicMode(
  value: unknown,
  fallback: ComicReadingMode,
): ComicReadingMode {
  if (value === 'strip' || value === 'vertical') return 'strip';
  if (value === 'paged') return 'paged';
  return fallback;
}

function resolveComicFit(patch: ComicPreferencesPatch, fallback: ComicFit): ComicFit {
  if (
    patch.fit === 'screen' ||
    patch.fit === 'width' ||
    patch.fit === 'height' ||
    patch.fit === 'original'
  ) {
    return patch.fit;
  }
  if (patch.fitWidth === true) return 'width';
  if (patch.fitWidth === false) return fallback === 'width' ? 'screen' : fallback;
  return fallback;
}

function mergeComicPreferences(
  current: ComicPreferences,
  patch: ComicPreferencesPatch,
): ComicPreferences {
  const mode = resolveComicMode(patch.mode, current.mode);
  const enteringStrip = mode === 'strip' && current.mode !== 'strip';
  const fit =
    enteringStrip && patch.fit === undefined && patch.fitWidth === undefined
      ? 'width'
      : resolveComicFit(patch, current.fit);
  return {
    mode,
    direction:
      patch.direction === 'rtl' || patch.direction === 'ltr'
        ? patch.direction
        : current.direction,
    spread:
      patch.spread === 'double' || patch.spread === 'single' || patch.spread === 'auto'
        ? patch.spread
        : current.spread,
    fit,
    cropMargins:
      patch.cropMargins === true || patch.cropMargins === false
        ? patch.cropMargins
        : current.cropMargins,
  };
}

function nextComicFit(current: ComicFit): ComicFit {
  const index = COMIC_FIT_CYCLE.indexOf(current);
  return COMIC_FIT_CYCLE[(index + 1) % COMIC_FIT_CYCLE.length]!;
}

function isArchiveProvider(source: ComicArchiveInput): source is ArchiveProvider {
  return typeof (source as ArchiveProvider).readEntry === 'function';
}

function isFileEntry(entry: ArchiveEntryMetadata): entry is ComicArchiveEntry {
  return !entry.directory && entry.id !== undefined && entry.filename !== undefined;
}

function isComicInfoPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase() === 'comicinfo.xml';
}

/** Read and decode the archive's ComicInfo.xml via the shared encoding sniff. */
export async function readComicInfo(
  provider: ArchiveProvider,
  entries: readonly ComicArchiveEntry[],
  signal?: AbortSignal,
): Promise<ComicMetadata | null> {
  const candidate = entries
    .filter(
      (entry) =>
        isComicInfoPath(entry.filename) &&
        entry.uncompressedSize <= READER_LIMITS.maxComicInfoBytes,
    )
    .sort((left, right) => compareComicPaths(left.filename, right.filename))[0];
  if (candidate === undefined) return null;
  const firstImageIndex = entries.findIndex((entry) => isComicImagePath(entry.filename));
  const metadataIndex = entries.indexOf(candidate);
  if (
    provider.accessMode === 'sequential' &&
    firstImageIndex >= 0 &&
    metadataIndex > firstImageIndex
  ) {
    // Reading metadata at the tail of a solid archive would decode the whole
    // stream before page one. Preserve progressive display and use natural order.
    return null;
  }
  try {
    const bytes = await provider.readEntry(candidate.id, signal);
    throwIfReaderLoadCancelled(signal);
    if (bytes.byteLength > READER_LIMITS.maxComicInfoBytes) return null;
    // 无声明编码：共享嗅探解码（UTF-8 优先、GBK 回退）。
    return parseComicInfo(decodeReaderText(bytes));
  } catch (error) {
    if (isReaderLoadCancelled(error, signal)) throw error;
    return null;
  }
}

async function collectComicPages(
  provider: ArchiveProvider,
  signal?: AbortSignal,
  prefix = '',
): Promise<CollectedComicPages> {
  throwIfReaderLoadCancelled(signal);
  const entries = provider.entries.filter(isFileEntry);
  const metadata = await readComicInfo(provider, entries, signal);
  const archiveImageOrder = entries.filter((entry) => isComicImagePath(entry.filename));
  const orderedImages = orderComicPages(archiveImageOrder, metadata);
  const coverEntryId =
    metadata?.coverPage === undefined
      ? undefined
      : archiveImageOrder[metadata.coverPage]?.id;
  let orderedImageIndex = 0;
  const nodes = entries
    .filter((entry) => {
      if (isComicImagePath(entry.filename)) return true;
      return (
        !isIgnoredComicPath(entry.filename) &&
        COMIC_ARCHIVE_EXTS.has(extOfPath(entry.filename)) &&
        provider.openNested !== undefined
      );
    })
    .sort((left, right) => compareComicPaths(left.filename, right.filename));
  const pages: CollectedComicPages['pages'] = [];
  for (const node of nodes) {
    throwIfReaderLoadCancelled(signal);
    if (isComicImagePath(node.filename)) {
      const entry = orderedImages[orderedImageIndex++] ?? node;
      const virtualPath = prefix === '' ? entry.filename : `${prefix}!/${entry.filename}`;
      pages.push({ kind: 'image', provider, entry, virtualPath });
      continue;
    }
    const virtualPath = prefix === '' ? node.filename : `${prefix}!/${node.filename}`;
    pages.push({ kind: 'archive', provider, entry: node, virtualPath });
  }
  return { pages, metadata, coverEntryId };
}

function defaultLabels(): ComicToolbarLabels {
  const chinese =
    typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh');
  return chinese
    ? {
        backToShelf: '返回书架',
        previous: '上一页',
        next: '下一页',
        vertical: '连续条',
        strip: '连续条',
        paged: '横向翻页',
        leftToRight: '从左到右',
        rightToLeft: '从右到左',
        singlePage: '单页',
        doublePage: '双页',
        autoPage: '自动',
        fitWidth: '适合宽度',
        fitScreen: '适合屏幕',
        fitHeight: '适合高度',
        fitOriginal: '原图',
        cropMargins: '裁白边',
        keepMargins: '保留边距',
        margins: '边距',
        pageSlider: '页码',
        toggleChrome: '显示或隐藏阅读控件',
        imageDecodeFailed: '无法解码此图片',
        nestedArchive: '内层归档',
        nestedArchiveFailed: '无法打开内层归档',
        openingNestedArchive: '正在打开内层归档',
        retry: '重试',
      }
    : {
        backToShelf: 'Back to Shelf',
        previous: 'Previous page',
        next: 'Next page',
        vertical: 'Continuous strip',
        strip: 'Continuous strip',
        paged: 'Horizontal pages',
        leftToRight: 'Left to right',
        rightToLeft: 'Right to left',
        singlePage: 'Single page',
        doublePage: 'Double page',
        autoPage: 'Auto',
        fitWidth: 'Fit width',
        fitScreen: 'Fit screen',
        fitHeight: 'Fit height',
        fitOriginal: 'Original size',
        cropMargins: 'Crop margins',
        keepMargins: 'Keep margins',
        margins: 'Margins',
        pageSlider: 'Page',
        toggleChrome: 'Show or hide reader controls',
        imageDecodeFailed: 'This image could not be decoded',
        nestedArchive: 'Nested archive',
        nestedArchiveFailed: 'The nested archive could not be opened',
        openingNestedArchive: 'Opening nested archive',
        retry: 'Retry',
      };
}

function preferenceStorage(
  configured: ComicPreferenceStorage | null | undefined,
): ComicPreferenceStorage | null {
  if (configured !== undefined) return configured;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Build stable slots and materialize a bounded set of nearby image pages. */
export async function renderCbzInto(
  source: ComicArchiveInput,
  container: HTMLElement,
  signal?: AbortSignal,
  options: CbzRenderOptions = {},
): Promise<CbzRenderHandle> {
  const archive = isArchiveProvider(source)
    ? source
    : await openSafeArchive(source, 'CBZ', signal, {
        requestPassword: options.requestPassword,
      });
  const openedProviders = new Set<ArchiveProvider>([archive]);
  const unsubscribeProgress: Array<() => void> = [];
  let initialized = false;
  try {
    const collected = await collectComicPages(archive, signal);
    const images = [...collected.pages];
    if (images.length === 0) throw new ParseError('CBZ 未找到图片页');
    if (options.onArchiveProgress !== undefined) {
      for (const provider of openedProviders) {
        const unsubscribe = provider.subscribeProgress?.(options.onArchiveProgress);
        if (unsubscribe !== undefined) unsubscribeProgress.push(unsubscribe);
      }
    }
    enforcePageCount('cbz', images.length);
    const coverPage = Math.max(
      0,
      collected.coverEntryId === undefined
        ? 0
        : images.findIndex(
            (page) => page.provider === archive && page.entry.id === collected.coverEntryId,
          ),
    );
    const metadata: ComicMetadata = Object.freeze({
      ...(collected.metadata ?? { pages: [] }),
      pageCount: images.length,
      coverPage,
      pages: collected.metadata?.pages ?? [],
    });
    const labels = { ...defaultLabels(), ...options.labels };
    const storage = preferenceStorage(options.preferenceStorage);
    const preferences = loadComicPreferences(
      storage,
      metadata.readingDirection ?? 'ltr',
      options.progressId,
    );
    const cacheBudget = Math.max(1, options.cacheBudgetBytes ?? DEFAULT_COMIC_CACHE_BUDGET);

    const dom = buildComicChrome(container, metadata, preferences, labels, options);

    const session: ComicSession = {
      signal,
      options,
      labels,
      storage,
      cacheBudget,
      archive,
      openedProviders,
      unsubscribeProgress,
      collected,
      collectPages: collectComicPages,
      advancePage,
      container,
      chrome: dom.chrome,
      topbar: dom.topbar,
      pageButton: dom.pageButton,
      pagesRoot: dom.pagesRoot,
      scroller: dom.pagesRoot,
      previousButton: dom.previousButton,
      nextButton: dom.nextButton,
      pageSlider: dom.pageSlider,
      verticalButton: dom.verticalButton,
      pagedButton: dom.pagedButton,
      ltrButton: dom.ltrButton,
      rtlButton: dom.rtlButton,
      singleButton: dom.singleButton,
      doubleButton: dom.doubleButton,
      autoButton: dom.autoButton,
      fitButton: dom.fitButton,
      cropButton: dom.cropButton,
      spreadGroup: dom.spreadGroup,
      images,
      metadata,
      preferences,
      slots: [],
      currentPage: 1,
      materialized: new Map(),
      pending: new Map(),
      failed: new Set(),
      sequentialQueues: new Map(),
      randomReads: createAbortableLimiter(2),
      prefetchDecodes: createAbortableLimiter(1),
      visible: new Set(),
      estimatedBytes: images.map((page) => Math.max(1, page.entry.uncompressedSize)),
      naturalWidths: new Map(),
      naturalHeights: new Map(),
      landscapePages: new Set(),
      cropInsets: new Map(),
      wantedPages: new Set(),
      prefetchNeighbors: false,
      spreadSwapGeneration: 0,
      activeTurnTransition: null,
      viewScale: 1,
      viewX: 0,
      viewY: 0,
      zoomRasterPins: [],
      zoomRasterContentRange: null,
      zoomRasterTimer: null,
      destroyed: false,
      destruction: null,
      observer: null,
      cropQueue: [],
      cropPumping: false,
      cropGeneration: 0,
      dragTurn: null,
      dragTurnFrames: rafFrameScheduler(),
      dragTurnFramePending: false,
      dragTurnFrameHandle: null,
      dragTurnPendingDx: 0,
      dragTurnEase: null,
      chromeVisible: true,
      chromeTimer: null,
      activePointers: new Map(),
      pinchDistance: 0,
      pinchScale: 1,
      panOrigin: null,
      swipeOrigin: null,
      gestureMoved: false,
      lastGestureUp: null,
      lastPointerType: 'mouse',
      pendingTap: null,
      lastTap: null,
    };

    const slots = session.slots;
    for (const [index, page] of images.entries()) {
      const slot = createComicSlot(session, page, index);
      session.pagesRoot.appendChild(slot);
      slots.push(slot);
    }

    const setPreferences = (patch: ComicPreferencesPatch): void => {
      const cropChanged =
        patch.cropMargins !== undefined &&
        patch.cropMargins !== session.preferences.cropMargins;
      const cropOnly =
        cropChanged && Object.keys(patch).every((key) => key === 'cropMargins');
      session.preferences = mergeComicPreferences(session.preferences, patch);
      saveComicPreferences(session.storage, session.preferences, options.progressId);
      if (cropChanged) {
        session.cropGeneration += 1;
        session.cropInsets.clear();
        session.cropQueue.length = 0;
      }
      if (!cropOnly) resetViewTransform(session);
      applyLayout(session);
    };

    function scrollToIndex(requestedIndex: number, direction: 1 | -1 | 0 = 0): boolean {
      const index = comicSpreadStart(
        requestedIndex,
        session.images.length,
        comicLayoutSpreadPrefs(session),
        session.landscapePages,
      );
      const changed = session.currentPage !== index + 1;
      // T2-A2（FB2）：跳转=硬落位。非连续跳转（进度恢复/目录/页码/批注/滑杆
      // 都经 scrollToPage/scrollToProgress/slider 入口进来）不再按页差符号
      // 播方向性滑入；仅 advancePage 的相邻 spread 翻页由调用方传入 ±1 保留
      // 滑入（与 flow 侧「跳转=硬落位」口径一致）。同页重落位同样不 slide。
      session.currentPage = index + 1;
      if (session.preferences.mode === 'paged') {
        showPagedSpread(session, index, direction);
      } else {
        session.visible.clear();
        session.visible.add(index);
        refreshCacheWindow(session, index);
        session.slots[index]?.scrollIntoView({ block: 'start' });
      }
      updateToolbar(session);
      if (changed) session.options.onPageChange?.();
      return changed;
    }

    function advancePage(direction: 1 | -1): boolean {
      const next = advanceComicPage(
        session.currentPage - 1,
        session.images.length,
        direction,
        comicLayoutSpreadPrefs(session),
        session.landscapePages,
      );
      if (next === session.currentPage - 1) return false;
      return scrollToIndex(next, direction);
    }

    session.previousButton.addEventListener('click', () => advancePage(-1));
    session.nextButton.addEventListener('click', () => advancePage(1));
    session.verticalButton.addEventListener('click', () => setPreferences({ mode: 'strip' }));
    session.pagedButton.addEventListener('click', () => setPreferences({ mode: 'paged' }));
    session.ltrButton.addEventListener('click', () => setPreferences({ direction: 'ltr' }));
    session.rtlButton.addEventListener('click', () => setPreferences({ direction: 'rtl' }));
    session.singleButton.addEventListener('click', () => setPreferences({ spread: 'single' }));
    session.doubleButton.addEventListener('click', () => setPreferences({ spread: 'double' }));
    session.autoButton.addEventListener('click', () => setPreferences({ spread: 'auto' }));
    session.fitButton.addEventListener('click', () =>
      setPreferences({ fit: nextComicFit(session.preferences.fit) }),
    );
    session.cropButton.addEventListener('click', () =>
      setPreferences({ cropMargins: !session.preferences.cropMargins }),
    );
    session.pageSlider.addEventListener('input', () => {
      const next = Number.parseInt(session.pageSlider.value, 10);
      if (!Number.isSafeInteger(next)) return;
      const spreadPrefs = comicLayoutSpreadPrefs(session);
      if (session.preferences.mode === 'paged' && spreadPrefs.spread === 'double') {
        const spreads = comicSpreadList(
          session.images.length,
          spreadPrefs,
          session.landscapePages,
        );
        const page = spreads[Math.min(spreads.length, Math.max(1, next)) - 1]?.[0];
        if (page !== undefined) scrollToIndex(page);
        return;
      }
      scrollToIndex(next - 1);
    });
    session.pageButton.addEventListener('click', () => {
      setChromeVisible(session, true);
      session.pageSlider.focus();
    });

    const handlers = createComicGestureHandlers(session);
    const onChromePointerEnter = (): void => revealChrome(session);
    session.chrome.addEventListener('click', handlers.stopChromeBubble);
    session.chrome.addEventListener('pointermove', handlers.stopChromeBubble);
    container.addEventListener('selectstart', handlers.blockNativeSelect);
    container.addEventListener('dragstart', handlers.blockNativeSelect);
    container.addEventListener('click', handlers.onSurfaceClick);
    container.addEventListener('dblclick', handlers.onDoubleClick);
    container.addEventListener('pointerdown', handlers.onPointerDown);
    container.addEventListener('pointermove', handlers.onGesturePointerMove, { passive: false });
    container.addEventListener('pointermove', handlers.onHoverPointerMove);
    container.addEventListener('pointerup', handlers.onPointerUp);
    container.addEventListener('pointercancel', handlers.onPointerUp);
    session.chrome.addEventListener('pointerenter', onChromePointerEnter);
    container.addEventListener('wheel', handlers.onWheel, { passive: false });
    scheduleChromeHide(session);

    session.scroller.addEventListener('scroll', handlers.onScrollEvent, { passive: true });
    observeComicStripSlots(session);
    const onViewportChange = handlers.onViewportChange;
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('orientationchange', onViewportChange);
    }

    applyLayout(session, false);
    const firstPages =
      session.preferences.mode === 'paged'
        ? comicVisiblePages(
            session.currentPage - 1,
            session.images.length,
            comicLayoutSpreadPrefs(session),
            session.landscapePages,
          )
        : stripCacheCenters(session.currentPage - 1, session.images.length);
    await Promise.all(firstPages.map((index) => loadPage(session, index)));
    const prefetchTimer = setTimeout(() => {
      if (session.destroyed) return;
      session.prefetchNeighbors = true;
      refreshCacheWindow(session, session.currentPage - 1);
    }, 0);

    const destroy = (): Promise<void> => {
      if (session.destruction !== null) return session.destruction;
      session.destroyed = true;
      session.cropGeneration += 1;
      session.cropQueue.length = 0;
      clearTimeout(prefetchTimer);
      cancelZoomRasterCommit(session); // 停顿提交定时器随销毁取消
      unpinZoomRaster(session); // 钉住的内联几何对称摘除
      if (session.chromeTimer !== null) clearTimeout(session.chromeTimer);
      cancelPendingTap(session);
      resetDragTurn(session); // 在飞缓动帧、邻居槽、transform 对称清理
      try {
        session.activeTurnTransition?.skipTransition();
      } catch {
        // 转场已结束时 skip 可能抛错，忽略。
      }
      session.activeTurnTransition = null;
      delete container.ownerDocument.documentElement.dataset.comicTurn;
      if (!session.chromeVisible) notifyComicSystemBars(session, true);
      container.removeEventListener('click', handlers.onSurfaceClick);
      container.removeEventListener('dblclick', handlers.onDoubleClick);
      container.removeEventListener('pointerdown', handlers.onPointerDown);
      container.removeEventListener('pointermove', handlers.onGesturePointerMove);
      container.removeEventListener('pointermove', handlers.onHoverPointerMove);
      container.removeEventListener('pointerup', handlers.onPointerUp);
      container.removeEventListener('pointercancel', handlers.onPointerUp);
      container.removeEventListener('selectstart', handlers.blockNativeSelect);
      container.removeEventListener('dragstart', handlers.blockNativeSelect);
      container.removeEventListener('wheel', handlers.onWheel);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('orientationchange', onViewportChange);
      }
      session.chrome.removeEventListener('pointerenter', onChromePointerEnter);
      session.chrome.removeEventListener('click', handlers.stopChromeBubble);
      session.chrome.removeEventListener('pointermove', handlers.stopChromeBubble);
      for (const operation of session.pending.values()) operation.controller.abort();
      session.observer?.disconnect();
      session.scroller.removeEventListener('scroll', handlers.onScrollEvent);
      handlers.scrollCoordinator?.cancel();
      for (const index of [...session.materialized.keys()]) releasePage(session, index);
      session.destruction = (async () => {
        await Promise.allSettled(
          [...session.pending.values()].map((operation) => operation.promise),
        );
        session.unsubscribeProgress.splice(0).forEach((unsubscribe) => unsubscribe());
        await Promise.allSettled(
          [...session.openedProviders].reverse().map((provider) => provider.close()),
        );
      })();
      return session.destruction;
    };
    const onAbort = (): void => {
      void destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfReaderLoadCancelled(signal);
    } catch (error) {
      signal?.removeEventListener('abort', onAbort);
      throw error;
    }

    initialized = true;
    return {
      get totalPages() {
        return session.images.length;
      },
      get metadata() {
        return session.metadata;
      },
      get currentPage() {
        return session.currentPage;
      },
      get preferences() {
        return session.preferences;
      },
      scrollToPage(page) {
        scrollToIndex(Math.min(session.images.length - 1, Math.max(0, Math.floor(page) - 1)));
      },
      scrollToProgress(progress) {
        scrollToIndex(
          comicPageFromProgress(
            progress,
            session.images.length,
            session.preferences,
            session.landscapePages,
          ) - 1,
        );
      },
      nextPage: () => advancePage(1),
      previousPage: () => advancePage(-1),
      setPreferences,
      hideChrome() {
        if (!session.chromeVisible) return false;
        setChromeVisible(session, false);
        return true;
      },
      adjustZoom(action) {
        if (action === 'reset') {
          resetViewTransform(session);
          return;
        }
        const rect = container.getBoundingClientRect();
        const factor = action === 'in' ? 1.25 : 1 / 1.25;
        zoomAt(
          session,
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
          session.viewScale * factor,
        );
        scheduleZoomRasterCommit(session); // 键盘连发放大同样在停顿后提交重栅格
      },
      destroy: async () => {
        signal?.removeEventListener('abort', onAbort);
        await destroy();
      },
    };
  } finally {
    if (!initialized) {
      unsubscribeProgress.splice(0).forEach((unsubscribe) => unsubscribe());
      await Promise.allSettled([...openedProviders].reverse().map((provider) => provider.close()));
    }
  }
}
