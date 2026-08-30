/**
 * Comic archive rendering shared by CBZ, CBR, CB7, and nested archives.
 *
 * Archive entries stay behind ArchiveProvider. Only pages selected by the
 * decoded-byte budget are materialized in the WebView.
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../file/browser-file-store.js';
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
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
  yieldReaderLoad,
} from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import {
  createCoalescedScrollHandler,
  createPagedWheelGate,
  nearestVisibleSlot,
  rafFrameScheduler,
  scrollerHasRoomInDelta,
} from '../../ui/reading-layout.js';
import {
  applyComicCropDisplay,
  comicDisplayWidthPx,
  COMIC_CROP_NONE,
  comicCroppedSize,
  createComicPageElement,
  compareComicPaths,
  detectComicCropInsets,
  isComicCropEmpty,
  isComicImagePath,
  isIgnoredComicPath,
  orderComicCacheLoads,
  orderComicPages,
  parseComicInfo,
  selectComicCacheWindow,
  type ComicCropInsets,
  type ComicMetadata,
  type ComicPageElement,
} from '../comic-model.js';
import {
  advanceComicPage,
  clampComicViewOffset,
  comicPageFromProgress,
  comicSpreadIndex,
  comicSpreadList,
  comicSpreadStart,
  comicTurnPrefetchCenters,
  comicVisiblePages,
  isComicLandscapeSize,
  isTouchPrimaryDocument,
  loadComicPreferences,
  resolveComicSpread,
  saveComicPreferences,
  type ComicFit,
  type ComicPreferenceStorage,
  type ComicPreferences,
  type ComicReadingMode,
  type ComicSpreadPreferences,
} from '../comic-preferences.js';

const COMIC_ARCHIVE_EXTS = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7']);
const DEFAULT_COMIC_CACHE_BUDGET = 96 * 1024 * 1024;
const COMIC_CHROME_IDLE_MS = 2800;
const COMIC_EDGE_ZONE = 0.28;
const COMIC_SYSTEM_EDGE_PX = 24;
/** T2：触屏 paged 翻页进入 slot 的滑入时长（与文字书 slide 同曲线族）。 */
const COMIC_SLOT_SLIDE_MS = 200;
const COMIC_ZOOM_MIN = 1;
const COMIC_ZOOM_MAX = 5;
const COMIC_ZOOM_TOGGLE = 2;
const COMIC_DOUBLE_TAP_MS = 280;
const COMIC_PAN_SLOP = 8;
const COMIC_SWIPE_SLOP = 40;
const COMIC_INTERACTIVE_SELECTOR =
  '.lightink-reader-comic-error, input, button, a';

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

/**
 * 系统栏桥契约（owner：MainActivity + 一条 invoke；本文件是漫画 consumer）。
 * `visible=false` 隐藏 status/navigation，并让画面贴边；`true` 再显示。
 * 桌面不调用；桥缺失或 reject 时只藏应用 chrome。
 */
export const SET_SYSTEM_BARS_VISIBLE_COMMAND = 'set_system_bars_visible';

export interface ComicSystemBarsBridge {
  setVisible(visible: boolean): void;
}

export interface ComicSystemBarsHost {
  LightInkSystemBars?: ComicSystemBarsBridge;
}

function androidReaderRoot(
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): HTMLElement | null {
  if (root === null || !root.hasAttribute('data-android')) return null;
  return root;
}

/** 成对显隐系统栏；非 Android、桥缺失或 invoke 失败均为 no-op。 */
export function syncComicSystemBarsVisible(
  visible: boolean,
  host: (Window & ComicSystemBarsHost) | null = typeof window === 'undefined'
    ? null
    : (window as Window & ComicSystemBarsHost),
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (androidReaderRoot(root) === null) return;
  try {
    const bridge = host?.LightInkSystemBars;
    if (bridge !== undefined && typeof bridge.setVisible === 'function') {
      bridge.setVisible(visible);
      return;
    }
    if (host !== null && isTauriRuntime(host)) {
      void invoke(SET_SYSTEM_BARS_VISIBLE_COMMAND, { visible }).catch(() => undefined);
    }
  } catch {
    // invoke 失败仍只藏应用 chrome，阅读不中断。
  }
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

function clampComicZoom(value: number): number {
  return Math.min(COMIC_ZOOM_MAX, Math.max(COMIC_ZOOM_MIN, value));
}

function comicPointerDistance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

/** Qualified horizontal swipe: distance and axis, before reading-direction mapping. */
function isComicSwipeTurn(dx: number, dy: number): boolean {
  return Math.abs(dx) >= COMIC_SWIPE_SLOP && Math.abs(dx) > Math.abs(dy);
}

function comicSwipePageDirection(
  dx: number,
  dy: number,
  direction: ComicPreferences['direction'],
): 1 | -1 | null {
  if (!isComicSwipeTurn(dx, dy)) return null;
  const forward = direction === 'rtl' ? dx > 0 : dx < 0;
  return forward ? 1 : -1;
}

function comicSurfaceTouchAction(
  mode: ComicReadingMode,
  fit: ComicFit,
  zoomed: boolean,
): string {
  if (zoomed) return 'none';
  if (mode === 'strip') return 'pan-y';
  if (fit === 'width') return 'pan-y';
  if (fit === 'height') return 'pan-x';
  if (fit === 'original') return 'pan-x pan-y';
  return 'none';
}

function isComicInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMIC_INTERACTIVE_SELECTOR) !== null;
}

function stripCacheCenters(center: number, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  return [Math.min(Math.max(0, Math.floor(center)), totalPages - 1)];
}

function isArchiveProvider(source: ComicArchiveInput): source is ArchiveProvider {
  return typeof (source as ArchiveProvider).readEntry === 'function';
}

type ComicArchiveEntry = ArchiveEntryMetadata & {
  readonly id: string;
  readonly filename: string;
};

interface ComicPageEntryBase {
  readonly provider: ArchiveProvider;
  readonly entry: ComicArchiveEntry;
  readonly virtualPath: string;
}

interface ComicImagePageEntry extends ComicPageEntryBase {
  readonly kind: 'image';
}

interface ComicNestedArchiveEntry extends ComicPageEntryBase {
  readonly kind: 'archive';
}

type ComicPageEntry = ComicImagePageEntry | ComicNestedArchiveEntry;

interface CollectedComicPages {
  readonly pages: ComicPageEntry[];
  readonly metadata: ComicMetadata | null;
  readonly coverEntryId?: string;
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
  const pages: ComicPageEntry[] = [];
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

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true || isReaderLoadCancelled(error, signal)) return true;
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error.name === 'AbortError' || error.name === 'ReaderLoadCancelledError')
  );
}

/** Bound in-flight work without leaving aborted waiters at the head of the queue. */
function createAbortableLimiter(limit: number): {
  acquire: (signal: AbortSignal) => Promise<void>;
  release: () => void;
} {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(signal: AbortSignal): Promise<void> {
      throwIfReaderLoadCancelled(signal);
      while (active >= limit) {
        await new Promise<void>((resolve, reject) => {
          const resume = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = (): void => {
            const at = waiters.indexOf(resume);
            if (at >= 0) waiters.splice(at, 1);
            reject(new ReaderLoadCancelledError());
          };
          waiters.push(resume);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        throwIfReaderLoadCancelled(signal);
      }
      active += 1;
    },
    release(): void {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

function toolbarButton(
  symbol: string,
  label: string,
  className = '',
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lightink-reader-comic-tool ${className}`.trim();
  button.textContent = symbol;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function comicTitle(metadata: ComicMetadata, fallback: string): string {
  const title = metadata.title?.trim();
  if (title !== undefined && title !== '') return title;
  const series = metadata.series?.trim();
  if (series === undefined || series === '') return fallback;
  const volume = metadata.volume?.trim();
  return volume === undefined || volume === '' ? series : `${series} ${volume}`;
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
    let metadata: ComicMetadata = Object.freeze({
      ...(collected.metadata ?? { pages: [] }),
      pageCount: images.length,
      coverPage,
      pages: collected.metadata?.pages ?? [],
    });
    const labels = { ...defaultLabels(), ...options.labels };
    const storage = preferenceStorage(options.preferenceStorage);
    let preferences = loadComicPreferences(
      storage,
      metadata.readingDirection ?? 'ltr',
      options.progressId,
    );
    const cacheBudget = Math.max(1, options.cacheBudgetBytes ?? DEFAULT_COMIC_CACHE_BUDGET);

    container.replaceChildren();
    container.tabIndex = -1;
    container.dataset.comicReader = 'true';
    container.dataset.comicChrome = 'visible';
    container.dataset.comicCanvas = 'near-black';
    container.style.backgroundColor = 'var(--lightink-comic-canvas, #121212)';
    const chrome = document.createElement('div');
    chrome.className = 'lightink-reader-comic-chrome lightink-reader-comic-overlay';
    const topbar = document.createElement('div');
    topbar.className = 'lightink-reader-comic-topbar';
    topbar.setAttribute('data-tauri-drag-region', '');
    const title = document.createElement('div');
    title.className = 'lightink-reader-comic-title';
    title.textContent = comicTitle(metadata, labels.paged);
    const pageButton = document.createElement('button');
    pageButton.type = 'button';
    pageButton.className = 'lightink-reader-comic-page';
    pageButton.title = labels.pageSlider;
    const bottombar = document.createElement('div');
    bottombar.className = 'lightink-reader-comic-bottombar';
    bottombar.setAttribute('role', 'toolbar');
    bottombar.setAttribute('aria-label', comicTitle(metadata, labels.paged));
    const scrub = document.createElement('div');
    scrub.className = 'lightink-reader-comic-scrub';
    const modes = document.createElement('div');
    modes.className = 'lightink-reader-comic-modes';
    const pagesRoot = document.createElement('div');
    pagesRoot.className = 'lightink-reader-comic-pages';
    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'lightink-reader-comic-back';
    backButton.textContent = labels.backToShelf;
    backButton.setAttribute('aria-label', labels.backToShelf);
    backButton.addEventListener('click', () => options.onReturnToShelf?.());
    topbar.append(backButton, title, pageButton);
    bottombar.append(scrub, modes);
    chrome.append(topbar, bottombar);
    container.append(chrome, pagesRoot);

    const previousButton = toolbarButton('\u2039', labels.previous, 'lightink-reader-comic-nav');
    const nextButton = toolbarButton('\u203a', labels.next, 'lightink-reader-comic-nav');
    const pageSlider = document.createElement('input');
    pageSlider.type = 'range';
    pageSlider.className = 'lightink-reader-comic-slider';
    pageSlider.min = '1';
    pageSlider.step = '1';
    pageSlider.setAttribute('aria-label', labels.pageSlider);
    const chip = (visible: string, label: string): HTMLButtonElement =>
      toolbarButton(visible, label, 'lightink-reader-comic-chip');
    const chineseChrome = labels.paged === '横向翻页';
    const stripLabel = labels.strip ?? labels.vertical;
    const verticalButton = chip(chineseChrome ? '连续' : 'Strip', stripLabel);
    const pagedButton = chip(chineseChrome ? '翻页' : 'Pages', labels.paged);
    const ltrButton = chip(chineseChrome ? '左到右' : 'LTR', labels.leftToRight);
    const rtlButton = chip(chineseChrome ? '右到左' : 'RTL', labels.rightToLeft);
    const singleButton = chip(chineseChrome ? '单页' : '1', labels.singlePage);
    const doubleButton = chip(chineseChrome ? '双页' : '2', labels.doublePage);
    const autoButton = chip(chineseChrome ? '自动' : 'Auto', labels.autoPage ?? labels.doublePage);
    const fitLabelFor = (fit: ComicFit): string => {
      if (fit === 'width') return labels.fitWidth;
      if (fit === 'height') return labels.fitHeight ?? labels.fitWidth;
      if (fit === 'original') return labels.fitOriginal ?? labels.fitWidth;
      return labels.fitScreen ?? labels.fitWidth;
    };
    const fitChipFor = (fit: ComicFit): string => {
      if (chineseChrome) {
        return fit === 'width'
          ? '适宽'
          : fit === 'height'
            ? '适高'
            : fit === 'original'
              ? '原图'
              : '适屏';
      }
      return fit === 'width'
        ? 'Width'
        : fit === 'height'
          ? 'Height'
          : fit === 'original'
            ? '1:1'
            : 'Fit';
    };
    const fitButton = chip(fitChipFor(preferences.fit), fitLabelFor(preferences.fit));
    const cropButton = chip(chineseChrome ? '裁边' : 'Crop', labels.cropMargins);
    const group = (...buttons: HTMLButtonElement[]): HTMLDivElement => {
      const element = document.createElement('div');
      element.className = 'lightink-reader-comic-tool-group';
      element.setAttribute('role', 'group');
      element.append(...buttons);
      return element;
    };
    const spreadGroup = group(singleButton, doubleButton, autoButton);
    scrub.append(previousButton, pageSlider, nextButton);
    modes.append(
      group(pagedButton, verticalButton),
      group(ltrButton, rtlButton),
      spreadGroup,
      group(fitButton),
      group(cropButton),
    );

    const createSlot = (page: ComicPageEntry, index: number): HTMLDivElement => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
      slot.dataset.pageIndex = String(index);
      slot.dataset.pagePath = page.virtualPath;
      slot.style.background = 'transparent';
      slot.setAttribute('aria-label', `${index + 1} / ${images.length}`);
      if (page.kind === 'archive') {
        slot.dataset.nestedArchive = 'true';
        const placeholder = document.createElement('div');
        placeholder.className = 'lightink-reader-nested-archive';
        placeholder.textContent = `${labels.nestedArchive}: ${page.entry.filename}`;
        slot.appendChild(placeholder);
      }
      return slot;
    };
    const slots = images.map((page, index) => {
      const slot = createSlot(page, index);
      pagesRoot.appendChild(slot);
      return slot;
    });

    const materialized = new Map<
      number,
      { image: HTMLElement; url: string; decodedBytes: number }
    >();
    const pending = new Map<number, { promise: Promise<void>; controller: AbortController }>();
    const failed = new Set<number>();
    const sequentialQueues = new Map<ArchiveProvider, Promise<void>>();
    const randomReads = createAbortableLimiter(2);
    const prefetchDecodes = createAbortableLimiter(1);
    const withPrefetchDecode = async (
      urgent: boolean,
      decodeSignal: AbortSignal,
    ): Promise<void> => {
      if (urgent) return;
      await prefetchDecodes.acquire(decodeSignal);
    };
    const releasePrefetchDecode = (urgent: boolean): void => {
      if (urgent) return;
      prefetchDecodes.release();
    };
    const pageDisplayWidth = (index: number): number => {
      const slot = slots[index];
      if (slot !== undefined && !slot.hidden && slot.clientWidth > 0) {
        return comicDisplayWidthPx(slot);
      }
      return comicDisplayWidthPx(pagesRoot.clientWidth > 0 ? pagesRoot : container);
    };
    const visible = new Set<number>();
    const estimatedBytes = images.map((page) => Math.max(1, page.entry.uncompressedSize));
    const naturalWidths = new Map<number, number>();
    const naturalHeights = new Map<number, number>();
    const landscapePages = new Set<number>();
    const viewportSize = (): { width: number; height: number } => {
      const rect = container.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const layoutSpreadPrefs = (): ComicSpreadPreferences => ({
      mode: preferences.mode,
      spread: resolveComicSpread(preferences.spread, viewportSize()),
    });
    const cropInsets = new Map<number, ComicCropInsets>();
    let wantedPages = new Set<number>();
    let currentPage = 1;
    let viewScale = 1;
    let viewX = 0;
    let viewY = 0;
    let destroyed = false;
    let destruction: Promise<void> | null = null;
    let observer: IntersectionObserver | null = null;

    const updateToolbar = (): void => {
      const progress = `${currentPage} / ${images.length}`;
      verticalButton.setAttribute('aria-pressed', String(preferences.mode === 'strip'));
      pagedButton.setAttribute('aria-pressed', String(preferences.mode === 'paged'));
      ltrButton.setAttribute('aria-pressed', String(preferences.direction === 'ltr'));
      rtlButton.setAttribute('aria-pressed', String(preferences.direction === 'rtl'));
      singleButton.setAttribute('aria-pressed', String(preferences.spread === 'single'));
      doubleButton.setAttribute('aria-pressed', String(preferences.spread === 'double'));
      autoButton.setAttribute('aria-pressed', String(preferences.spread === 'auto'));
      fitButton.removeAttribute('aria-pressed');
      fitButton.textContent = fitChipFor(preferences.fit);
      fitButton.title = fitLabelFor(preferences.fit);
      fitButton.setAttribute('aria-label', fitLabelFor(preferences.fit));
      cropButton.setAttribute('aria-pressed', String(preferences.cropMargins));
      spreadGroup.hidden = preferences.mode === 'strip';
      const spreadPrefs = layoutSpreadPrefs();
      previousButton.disabled = currentPage <= 1;
      nextButton.disabled =
        advanceComicPage(currentPage - 1, images.length, 1, spreadPrefs, landscapePages) ===
        currentPage - 1;
      const sliderMax =
        preferences.mode === 'paged' && spreadPrefs.spread === 'double'
          ? Math.max(1, comicSpreadList(images.length, spreadPrefs, landscapePages).length)
          : Math.max(1, images.length);
      const sliderValue =
        preferences.mode === 'paged' && spreadPrefs.spread === 'double'
          ? comicSpreadIndex(currentPage - 1, images.length, spreadPrefs, landscapePages) + 1
          : currentPage;
      pageSlider.max = String(sliderMax);
      pageSlider.value = String(sliderValue);
      pageButton.textContent = progress;
      pageButton.setAttribute('aria-label', `${labels.pageSlider}: ${progress}`);
    };

    const peekInsets = (index: number): ComicCropInsets => {
      if (preferences.cropMargins !== true) return COMIC_CROP_NONE;
      return cropInsets.get(index) ?? COMIC_CROP_NONE;
    };

    const cropFallbackAspect = (): 'natural' | 'none' =>
      preferences.mode === 'strip' || preferences.fit !== 'screen' ? 'natural' : 'none';

    const cropQueue: number[] = [];
    let cropPumping = false;
    let cropGeneration = 0;

    const enqueueCropScan = (index: number): void => {
      if (preferences.cropMargins !== true || destroyed) return;
      if (cropInsets.has(index) || cropQueue.includes(index)) return;
      const image = materialized.get(index)?.image;
      if (!(image instanceof HTMLImageElement) || image.naturalWidth < 8) return;
      cropQueue.push(index);
      void pumpCropScans();
    };

    const pumpCropScans = async (): Promise<void> => {
      if (cropPumping) return;
      cropPumping = true;
      const generation = cropGeneration;
      try {
        while (cropQueue.length > 0) {
          if (destroyed || generation !== cropGeneration || preferences.cropMargins !== true) {
            cropQueue.length = 0;
            return;
          }
          const index = cropQueue.shift();
          if (index === undefined || cropInsets.has(index)) continue;
          const image = materialized.get(index)?.image;
          if (!(image instanceof HTMLImageElement) || image.naturalWidth < 8) continue;
          await yieldReaderLoad();
          if (destroyed || generation !== cropGeneration || preferences.cropMargins !== true) {
            cropQueue.length = 0;
            return;
          }
          if (cropInsets.has(index) || materialized.get(index)?.image !== image) continue;
          const insets = detectComicCropInsets(image);
          cropInsets.set(index, insets);
          if (!isComicCropEmpty(insets) && preferences.cropMargins === true && !destroyed) {
            applySlotFit(index);
          }
        }
      } finally {
        cropPumping = false;
        if (cropQueue.length > 0 && !destroyed) void pumpCropScans();
      }
    };

    const scheduleVisibleCropScans = (): void => {
      if (preferences.cropMargins !== true) return;
      for (const index of visible) enqueueCropScan(index);
    };

    const displayWidth = (index: number): number | undefined => {
      const width = naturalWidths.get(index);
      const height = naturalHeights.get(index);
      if (width === undefined) return undefined;
      if (height === undefined) return width;
      return comicCroppedSize(width, height, peekInsets(index)).width;
    };

    const applySlotWidth = (index: number): void => {
      const width = naturalWidths.get(index);
      const height = naturalHeights.get(index);
      if (preferences.fit === 'original' && width !== undefined && height !== undefined) {
        const cropped = comicCroppedSize(width, height, peekInsets(index));
        slots[index]!.style.setProperty('--lightink-comic-natural-width', `${cropped.width}px`);
        slots[index]!.style.setProperty('--lightink-comic-natural-height', `${cropped.height}px`);
      } else {
        slots[index]!.style.removeProperty('--lightink-comic-natural-width');
        slots[index]!.style.removeProperty('--lightink-comic-natural-height');
      }
    };

    const applyPageFit = (element: HTMLElement | null, fit: ComicFit): void => {
      if (element === null) return;
      element.style.objectFit = 'contain';
      if (fit === 'width') {
        element.style.width = '100%';
        element.style.height = 'auto';
        element.style.maxWidth = '100%';
        element.style.maxHeight = 'none';
        element.style.minWidth = '0';
        element.style.minHeight = '0';
        return;
      }
      if (fit === 'height') {
        element.style.width = 'auto';
        element.style.height = '100%';
        element.style.maxWidth = 'none';
        element.style.maxHeight = '100%';
        element.style.minWidth = '0';
        element.style.minHeight = '0';
        return;
      }
      if (fit === 'original') {
        element.style.objectFit = 'none';
        element.style.width = 'var(--lightink-comic-natural-width, auto)';
        element.style.height = 'var(--lightink-comic-natural-height, auto)';
        element.style.maxWidth = 'none';
        element.style.maxHeight = 'none';
        element.style.removeProperty('min-width');
        element.style.removeProperty('min-height');
        return;
      }
      element.style.width = '100%';
      element.style.height = '100%';
      element.style.maxWidth = '100%';
      element.style.maxHeight = '100%';
      element.style.minWidth = '0';
      element.style.minHeight = '0';
      element.style.objectPosition = 'center';
    };

    const applySlotFit = (index: number): void => {
      const slot = slots[index];
      if (slot === undefined) return;
      applySlotWidth(index);
      const page = slot.querySelector<HTMLElement>('.lightink-reader-page');
      if (preferences.mode === 'strip') {
        slot.style.flex = '0 0 auto';
        slot.style.minHeight = '0';
        slot.style.background = 'transparent';
        if (preferences.fit === 'original') {
          const width = displayWidth(index);
          slot.style.width = width === undefined ? 'auto' : `${width}px`;
          slot.style.maxWidth = 'none';
          slot.style.height = 'auto';
        } else if (preferences.fit === 'height') {
          slot.style.width = 'auto';
          slot.style.maxWidth = '100%';
          slot.style.height = 'auto';
          slot.style.maxHeight = '100%';
        } else if (preferences.fit === 'screen') {
          slot.style.width = 'auto';
          slot.style.maxWidth = '100%';
          slot.style.height = 'auto';
          slot.style.maxHeight = '100%';
        } else {
          slot.style.width = '100%';
          slot.style.maxWidth = '100%';
          slot.style.height = 'auto';
          slot.style.removeProperty('max-height');
        }
        applyPageFit(page, preferences.fit === 'screen' ? 'width' : preferences.fit);
        applyComicCropDisplay(
          slot,
          page,
          naturalWidths.get(index) ?? 0,
          naturalHeights.get(index) ?? 0,
          peekInsets(index),
          { fallbackAspect: cropFallbackAspect() },
        );
        return;
      }
      slot.style.removeProperty('flex');
      slot.style.minWidth = '0';
      slot.style.removeProperty('width');
      slot.style.removeProperty('max-width');
      slot.style.removeProperty('height');
      slot.style.removeProperty('max-height');
      slot.style.background = 'transparent';
      if (preferences.fit === 'original') {
        slot.style.flex = '0 0 auto';
        slot.style.aspectRatio = 'auto';
        slot.style.minHeight = 'auto';
      } else if (preferences.fit === 'width') {
        slot.style.flex = '0 0 auto';
        slot.style.minHeight = 'auto';
        slot.style.height = 'auto';
        slot.style.maxHeight = 'none';
        slot.style.removeProperty('aspect-ratio');
      } else {
        slot.style.minHeight = '0';
        slot.style.removeProperty('aspect-ratio');
      }
      applyPageFit(page, preferences.fit);
      applyComicCropDisplay(
        slot,
        page,
        naturalWidths.get(index) ?? 0,
        naturalHeights.get(index) ?? 0,
        peekInsets(index),
        { fallbackAspect: cropFallbackAspect() },
      );
      if (preferences.fit === 'width' || preferences.fit === 'original') {
        slot.style.maxHeight = 'none';
      }
    };

    const applySurfaceMetrics = (): void => {
      if (preferences.mode === 'strip') {
        container.style.minHeight = '0';
        container.style.height = '100%';
        container.style.overflow = 'hidden';
        pagesRoot.style.overflow = viewScale > 1 ? 'hidden' : 'auto';
        pagesRoot.style.height = '100%';
        pagesRoot.style.flex = '1';
        pagesRoot.style.width = '100%';
        pagesRoot.style.alignItems = preferences.fit === 'width' ? 'stretch' : 'center';
        return;
      }
      container.style.minHeight = '0';
      container.style.height = '100%';
      container.style.overflow = 'hidden';
      pagesRoot.style.height = '100%';
      pagesRoot.style.minHeight = '0';
      pagesRoot.style.width = '100%';
      pagesRoot.style.overflow =
        viewScale > 1 || preferences.fit === 'screen' ? 'hidden' : 'auto';
      pagesRoot.style.removeProperty('flex');
      pagesRoot.style.alignItems = preferences.fit === 'width' ? 'flex-start' : 'center';
    };

    const clampViewOffset = (): void => {
      if (viewScale <= 1) {
        viewX = 0;
        viewY = 0;
        return;
      }
      const viewport = container.getBoundingClientRect();
      const clamped = clampComicViewOffset(
        { x: viewX, y: viewY },
        viewScale,
        { width: viewport.width, height: viewport.height },
        {
          width: pagesRoot.scrollWidth || pagesRoot.clientWidth || viewport.width,
          height: pagesRoot.scrollHeight || pagesRoot.clientHeight || viewport.height,
        },
      );
      viewX = clamped.x;
      viewY = clamped.y;
    };

    const applyViewTransform = (): void => {
      clampViewOffset();
      const zoomed = viewScale > 1;
      const scaleText = String(viewScale);
      container.dataset.comicZoomed = String(zoomed);
      container.dataset.comicScale = scaleText;
      pagesRoot.dataset.comicScale = scaleText;
      container.style.setProperty('--lightink-comic-scale', scaleText);
      container.style.setProperty('--lightink-comic-translate-x', `${viewX}px`);
      container.style.setProperty('--lightink-comic-translate-y', `${viewY}px`);
      pagesRoot.style.setProperty('--lightink-comic-scale', scaleText);
      pagesRoot.style.setProperty('--lightink-comic-translate-x', `${viewX}px`);
      pagesRoot.style.setProperty('--lightink-comic-translate-y', `${viewY}px`);
      if (zoomed) {
        pagesRoot.style.transformOrigin = '0 0';
        pagesRoot.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
      } else {
        pagesRoot.style.removeProperty('transform');
        pagesRoot.style.removeProperty('transform-origin');
      }
      const touchAction = comicSurfaceTouchAction(preferences.mode, preferences.fit, zoomed);
      container.style.touchAction = touchAction;
      pagesRoot.style.touchAction = touchAction;
      if (preferences.mode === 'strip') {
        pagesRoot.style.overflow = zoomed ? 'hidden' : 'auto';
      } else {
        pagesRoot.style.overflow = zoomed || preferences.fit === 'screen' ? 'hidden' : 'auto';
      }
    };

    const resetViewTransform = (): void => {
      viewScale = 1;
      viewX = 0;
      viewY = 0;
      applyViewTransform();
    };

    const zoomAt = (clientX: number, clientY: number, nextScale: number): void => {
      const rect = container.getBoundingClientRect();
      const pointX = clientX - rect.left;
      const pointY = clientY - rect.top;
      const contentX = (pointX - viewX) / viewScale;
      const contentY = (pointY - viewY) / viewScale;
      viewScale = clampComicZoom(nextScale);
      if (viewScale <= 1) {
        viewX = 0;
        viewY = 0;
      } else {
        viewX = pointX - contentX * viewScale;
        viewY = pointY - contentY * viewScale;
      }
      applyViewTransform();
    };

    const toggleZoomAt = (clientX: number, clientY: number): void => {
      zoomAt(clientX, clientY, viewScale > 1 ? 1 : COMIC_ZOOM_TOGGLE);
    };

    const releasePage = (index: number): void => {
      const page = materialized.get(index);
      if (page === undefined) return;
      materialized.delete(index);
      page.image.remove();
      if (page.url !== '') URL.revokeObjectURL(page.url);
    };

    const showPageError = (index: number): void => {
      failed.add(index);
      const nestedArchive = images[index]?.kind === 'archive';
      const error = document.createElement('div');
      error.className = 'lightink-reader-comic-error';
      error.dataset.errorCode = nestedArchive
        ? 'COMIC_NESTED_ARCHIVE_FAILED'
        : 'COMIC_IMAGE_DECODE_FAILED';
      error.setAttribute('role', 'alert');
      const text = document.createElement('span');
      text.textContent = nestedArchive ? labels.nestedArchiveFailed : labels.imageDecodeFailed;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = labels.retry;
      retry.addEventListener('click', () => {
        failed.delete(index);
        slots[index]!.replaceChildren();
        void loadPage(index).catch((loadError: unknown) => {
          if (!isAbortError(loadError, signal) && !destroyed) showPageError(index);
        });
      });
      error.append(text, retry);
      slots[index]!.replaceChildren(error);
    };

    const updatePageList = (
      index: number,
      placeholder: ComicNestedArchiveEntry,
      nestedPages: readonly ComicPageEntry[],
    ): void => {
      enforcePageCount('cbz', images.length - 1 + nestedPages.length);
      const currentAnchor = images[currentPage - 1];
      const oldSlot = slots[index]!;
      const reference = oldSlot.nextSibling;
      observer?.unobserve(oldSlot);
      oldSlot.remove();
      const nextSlots = nestedPages.map((page, offset) => {
        const slot = createSlot(page, index + offset);
        pagesRoot.insertBefore(slot, reference);
        observer?.observe(slot);
        return slot;
      });
      images.splice(index, 1, ...nestedPages);
      slots.splice(index, 1, ...nextSlots);
      estimatedBytes.splice(
        index,
        1,
        ...nestedPages.map((page) => Math.max(1, page.entry.uncompressedSize)),
      );
      visible.clear();
      slots.forEach((slot, slotIndex) => {
        slot.dataset.pageIndex = String(slotIndex);
        slot.setAttribute('aria-label', `${slotIndex + 1} / ${images.length}`);
      });
      if (currentAnchor === placeholder) {
        currentPage = index + 1;
      } else if (currentAnchor !== undefined) {
        const anchorIndex = images.indexOf(currentAnchor);
        if (anchorIndex >= 0) currentPage = anchorIndex + 1;
      }
      const nextCoverPage = Math.max(
        0,
        collected.coverEntryId === undefined
          ? 0
          : images.findIndex(
              (page) =>
                page.kind === 'image' &&
                page.provider === archive &&
                page.entry.id === collected.coverEntryId,
            ),
      );
      metadata = Object.freeze({
        ...metadata,
        pageCount: images.length,
        coverPage: nextCoverPage,
      });
      options.onPageListChange?.(images.length, metadata);
    };

    const expandNestedArchive = async (
      index: number,
      page: ComicNestedArchiveEntry,
      controller: AbortController,
    ): Promise<void> => {
      const child = await page.provider.openNested!(page.entry.id, controller.signal);
      try {
        throwIfReaderLoadCancelled(controller.signal);
        const nested = await collectComicPages(child, controller.signal, page.virtualPath);
        if (nested.pages.length === 0) throw new ParseError('CBZ 未找到图片页');
        throwIfReaderLoadCancelled(controller.signal);
        updatePageList(index, page, nested.pages);
        openedProviders.add(child);
        if (options.onArchiveProgress !== undefined) {
          const unsubscribe = child.subscribeProgress?.(options.onArchiveProgress);
          if (unsubscribe !== undefined) unsubscribeProgress.push(unsubscribe);
        }
      } catch (error) {
        openedProviders.delete(child);
        await child.close().catch(() => undefined);
        throw error;
      }
    };

    const loadPage = (index: number): Promise<void> => {
      if (
        index < 0 ||
        index >= images.length ||
        destroyed ||
        materialized.has(index) ||
        failed.has(index)
      ) {
        return Promise.resolve();
      }
      const existing = pending.get(index);
      if (existing !== undefined && existing.controller.signal.aborted !== true) {
        return existing.promise;
      }
      const controller = new AbortController();
      const forgetPending = (): void => {
        if (pending.get(index)?.controller === controller) pending.delete(index);
      };
      const requestedPage = images[index]!;
      if (requestedPage.kind === 'archive') {
        const placeholder = slots[index]?.querySelector<HTMLElement>(
          '.lightink-reader-nested-archive',
        );
        if (placeholder !== null && placeholder !== undefined) {
          placeholder.textContent = `${labels.openingNestedArchive}: ${requestedPage.entry.filename}`;
        }
        const abortFromParent = (): void => controller.abort();
        if (signal?.aborted === true) controller.abort();
        else signal?.addEventListener('abort', abortFromParent, { once: true });
        const operation = expandNestedArchive(index, requestedPage, controller)
          .finally(() => {
            signal?.removeEventListener('abort', abortFromParent);
            forgetPending();
          })
          .then(() => {
            if (!destroyed) applyLayout(false);
          });
        pending.set(index, { promise: operation, controller });
        return operation;
      }
      const operation = (async () => {
        const abortFromParent = (): void => controller.abort();
        if (signal?.aborted === true) controller.abort();
        else signal?.addEventListener('abort', abortFromParent, { once: true });
        try {
          throwIfReaderLoadCancelled(controller.signal);
          const page = images[index]!;
          if (page.kind !== 'image') return;
          const read = (): Promise<Uint8Array> =>
            page.provider.readEntry(page.entry.id, controller.signal);
          let data: Uint8Array;
          if (page.provider.accessMode === 'sequential') {
            const previous = sequentialQueues.get(page.provider) ?? Promise.resolve();
            let resolveQueue = (): void => undefined;
            const queueTail = new Promise<void>((resolve) => {
              resolveQueue = resolve;
            });
            sequentialQueues.set(page.provider, queueTail);
            try {
              await previous.catch(() => undefined);
              throwIfReaderLoadCancelled(controller.signal);
              data = await read();
            } finally {
              resolveQueue();
              if (sequentialQueues.get(page.provider) === queueTail) {
                sequentialQueues.delete(page.provider);
              }
            }
          } else {
            await randomReads.acquire(controller.signal);
            try {
              data = await read();
            } finally {
              randomReads.release();
            }
            await yieldReaderLoad(controller.signal);
          }
          throwIfReaderLoadCancelled(controller.signal);
          if (destroyed || !wantedPages.has(index)) return;
          const urgent = visible.has(index);
          await withPrefetchDecode(urgent, controller.signal);
          let mounted: ComicPageElement;
          try {
            mounted = await createComicPageElement(data, page.entry.filename, {
              resizeWidth: pageDisplayWidth(index),
              signal: controller.signal,
              priority: urgent ? 'high' : 'low',
            });
          } finally {
            releasePrefetchDecode(urgent);
          }
          if (destroyed || controller.signal.aborted || !wantedPages.has(index)) {
            if (mounted.url !== '') URL.revokeObjectURL(mounted.url);
            mounted.element.remove();
            return;
          }
          if (mounted.width > 0 && mounted.height > 0) {
            slots[index]!.style.aspectRatio = `${mounted.width} / ${mounted.height}`;
            naturalWidths.set(index, mounted.width);
            naturalHeights.set(index, mounted.height);
            enqueueCropScan(index);
            const wasLandscape = landscapePages.has(index);
            const nowLandscape = isComicLandscapeSize(mounted.width, mounted.height);
            if (nowLandscape) landscapePages.add(index);
            else landscapePages.delete(index);
            if (wasLandscape !== nowLandscape && preferences.mode === 'paged') {
              applyLayout(false);
            }
          }
          mounted.element.addEventListener(
            'error',
            () => {
              const loaded = materialized.get(index);
              if (loaded?.image !== mounted.element) return;
              materialized.delete(index);
              if (mounted.url !== '') URL.revokeObjectURL(mounted.url);
              showPageError(index);
            },
            { once: true },
          );
          materialized.set(index, {
            image: mounted.element,
            url: mounted.url,
            decodedBytes: estimatedBytes[index] ?? data.byteLength,
          });
          slots[index]!.replaceChildren(mounted.element);
          applySlotFit(index);
        } catch (error) {
          if (
            destroyed ||
            controller.signal.aborted ||
            isAbortError(error, signal) ||
            isAbortError(error, controller.signal)
          ) {
            return;
          }
          throw error;
        } finally {
          signal?.removeEventListener('abort', abortFromParent);
        }
      })().finally(forgetPending);
      pending.set(index, { promise: operation, controller });
      return operation;
    };

    let prefetchNeighbors = false;
    const scroller = pagesRoot;

    const viewportPageIndex = (fallback: number): number => {
      const candidates =
        visible.size > 0
          ? [...visible].filter((index) => index >= 0 && index < slots.length)
          : [fallback, fallback - 1, fallback + 1].filter(
              (index) => index >= 0 && index < slots.length,
            );
      if (candidates.length === 0) return fallback;
      if (candidates.length === 1) return candidates[0]!;
      const top = scroller.getBoundingClientRect().top;
      const slotTops = candidates.map((index) => slots[index]!.getBoundingClientRect().top);
      if (new Set(slotTops).size > 1) {
        const nearest = nearestVisibleSlot(slotTops, top);
        return nearest >= 0 ? candidates[nearest]! : fallback;
      }
      return Math.min(...candidates);
    };

    function cacheCenters(center: number): number[] {
      const prefs = layoutSpreadPrefs();
      if (preferences.mode === 'paged') {
        return prefetchNeighbors
          ? comicTurnPrefetchCenters(center, images.length, prefs, landscapePages)
          : comicVisiblePages(center, images.length, prefs, landscapePages);
      }
      return stripCacheCenters(center, images.length);
    }

    function refreshCacheWindow(center: number): void {
      const centers = cacheCenters(center);
      const wanted = prefetchNeighbors
        ? selectComicCacheWindow(estimatedBytes, centers, cacheBudget)
        : new Set(centers);
      for (const index of materialized.keys()) {
        if (!wanted.has(index)) releasePage(index);
      }
      for (const [index, operation] of pending) {
        if (!wanted.has(index)) operation.controller.abort();
      }
      wantedPages = wanted;
      const firstUnresolved = images.findIndex((page) => page.kind === 'archive');
      const furthestCenter = centers.length === 0 ? -1 : Math.max(...centers);
      if (firstUnresolved >= 0 && firstUnresolved <= furthestCenter) {
        wantedPages.add(firstUnresolved);
        void loadPage(firstUnresolved).catch((error: unknown) => {
          if (!isAbortError(error, signal) && !destroyed) showPageError(firstUnresolved);
        });
      }
      for (const index of orderComicCacheLoads(wanted, centers)) {
        if (firstUnresolved >= 0 && index > firstUnresolved) continue;
        if (images[index]?.kind === 'archive') continue;
        void loadPage(index).catch((error: unknown) => {
          if (!isAbortError(error, signal) && !destroyed) showPageError(index);
        });
      }
    }

    const applyLayout = (notify = true): void => {
      const previousPage = currentPage;
      const spreadPrefs = layoutSpreadPrefs();
      const currentIndex = comicSpreadStart(
        currentPage - 1,
        images.length,
        spreadPrefs,
        landscapePages,
      );
      currentPage = currentIndex + 1;
      container.dataset.comicMode = preferences.mode;
      container.dataset.comicDirection = preferences.direction;
      container.dataset.comicSpread = spreadPrefs.spread;
      container.dataset.comicSpreadPref = preferences.spread;
      container.dataset.comicFit = preferences.fit;
      container.dataset.comicFitWidth = String(preferences.fit === 'width');
      container.dataset.comicCropMargins = String(preferences.cropMargins);
      container.dataset.comicVisible = String(
        preferences.mode === 'paged'
          ? comicVisiblePages(currentIndex, images.length, spreadPrefs, landscapePages).length
          : 0,
      );
      pagesRoot.dir = preferences.direction;
      applySurfaceMetrics();
      if (preferences.mode === 'paged') {
        const shown = new Set(
          comicVisiblePages(currentIndex, images.length, spreadPrefs, landscapePages),
        );
        slots.forEach((slot, index) => {
          slot.hidden = !shown.has(index);
        });
        visible.clear();
        shown.forEach((index) => visible.add(index));
        shown.forEach((index) => applySlotFit(index));
      } else {
        slots.forEach((slot) => {
          slot.hidden = false;
        });
        visible.clear();
        slots.forEach((_slot, index) => applySlotFit(index));
      }
      applyViewTransform();
      updateToolbar();
      refreshCacheWindow(currentIndex);
      scheduleVisibleCropScans();
      if (notify && previousPage !== currentPage) options.onPageChange?.();
    };

    /** T2：触屏 paged 翻页时进入 slot 的滑入 token（rtl 反转视觉来向）。 */
    const comicSlotSlideToken = (forward: boolean): 'next' | 'prev' => {
      const fromRight = preferences.direction === 'rtl' ? !forward : forward;
      return fromRight ? 'next' : 'prev';
    };

    /** T2-A2（FB3）：per-slot 滑入清理 timer；同 slot 快速二次进入先清旧 timer。 */
    const comicSlotSlideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

    const slideEnteringComicSlots = (entering: readonly number[], direction: 1 | -1): void => {
      const token = comicSlotSlideToken(direction > 0);
      const className = `lightink-comic-slot-slide-${token}`;
      for (const index of entering) {
        const slot = slots[index];
        if (slot === undefined) continue;
        // 旧 timer 只捕获类名字符串、不跟踪 per-slot：同 slot 260ms 内二次进入
        // 会被旧 timer 中途移除新动画的类。先清旧 timer 再重启。
        const staleTimer = comicSlotSlideTimers.get(slot);
        if (staleTimer !== undefined) clearTimeout(staleTimer);
        slot.classList.remove('lightink-comic-slot-slide-next', 'lightink-comic-slot-slide-prev');
        void slot.offsetWidth; // 同向连翻时重启动画
        slot.classList.add(className);
        comicSlotSlideTimers.set(
          slot,
          setTimeout(() => {
            comicSlotSlideTimers.delete(slot);
            slot.classList.remove(className);
          }, COMIC_SLOT_SLIDE_MS + 60),
        );
      }
    };

    const showPagedSpread = (requestedIndex: number, direction: 1 | -1 | 0 = 0): void => {
      const spreadPrefs = layoutSpreadPrefs();
      const index = comicSpreadStart(requestedIndex, images.length, spreadPrefs, landscapePages);
      currentPage = index + 1;
      const shown = comicVisiblePages(index, images.length, spreadPrefs, landscapePages);
      const shownSet = new Set(shown);
      container.dataset.comicVisible = String(shown.length);
      for (const previous of [...visible]) {
        if (shownSet.has(previous)) continue;
        const slot = slots[previous];
        if (slot !== undefined) slot.hidden = true;
        visible.delete(previous);
      }
      const entering: number[] = [];
      for (const next of shown) {
        const slot = slots[next];
        if (slot === undefined) continue;
        if (slot.hidden) entering.push(next);
        slot.hidden = false;
        visible.add(next);
        applySlotFit(next);
      }
      pagesRoot.scrollTop = 0;
      pagesRoot.scrollLeft = 0;
      updateToolbar();
      refreshCacheWindow(index);
      // T2：触屏且非 reduce-motion 时，进入 slot 播放 200ms 滑入；strip 模式与
      // 重排版/非连续跳转（direction 0，见 scrollToIndex）不 slide。
      if (entering.length > 0 && direction !== 0 && isTouchPrimaryDocument(container.ownerDocument)) {
        const media =
          typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined;
        if (media?.('(prefers-reduced-motion: reduce)').matches !== true) {
          slideEnteringComicSlots(entering, direction);
        }
      }
    };

    const setPreferences = (patch: ComicPreferencesPatch): void => {
      const cropChanged =
        patch.cropMargins !== undefined && patch.cropMargins !== preferences.cropMargins;
      const cropOnly = cropChanged && Object.keys(patch).every((key) => key === 'cropMargins');
      preferences = mergeComicPreferences(preferences, patch);
      saveComicPreferences(storage, preferences, options.progressId);
      if (cropChanged) {
        cropGeneration += 1;
        cropInsets.clear();
        cropQueue.length = 0;
      }
      if (!cropOnly) resetViewTransform();
      applyLayout();
    };

    const scrollToIndex = (requestedIndex: number, direction: 1 | -1 | 0 = 0): boolean => {
      const index = comicSpreadStart(requestedIndex, images.length, layoutSpreadPrefs(), landscapePages);
      const changed = currentPage !== index + 1;
      // T2-A2（FB2）：跳转=硬落位。非连续跳转（进度恢复/目录/页码/批注/滑杆
      // 都经 scrollToPage/scrollToProgress/slider 入口进来）不再按页差符号
      // 播方向性滑入；仅 advancePage 的相邻 spread 翻页由调用方传入 ±1 保留
      // 滑入（与 flow 侧「跳转=硬落位」口径一致）。同页重落位同样不 slide。
      currentPage = index + 1;
      if (preferences.mode === 'paged') {
        showPagedSpread(index, direction);
      } else {
        visible.clear();
        visible.add(index);
        refreshCacheWindow(index);
        slots[index]?.scrollIntoView({ block: 'start' });
      }
      updateToolbar();
      if (changed) options.onPageChange?.();
      return changed;
    };

    const advancePage = (direction: 1 | -1): boolean => {
      const next = advanceComicPage(
        currentPage - 1,
        images.length,
        direction,
        layoutSpreadPrefs(),
        landscapePages,
      );
      if (next === currentPage - 1) return false;
      return scrollToIndex(next, direction);
    };

    previousButton.addEventListener('click', () => advancePage(-1));
    nextButton.addEventListener('click', () => advancePage(1));
    verticalButton.addEventListener('click', () => setPreferences({ mode: 'strip' }));
    pagedButton.addEventListener('click', () => setPreferences({ mode: 'paged' }));
    ltrButton.addEventListener('click', () => setPreferences({ direction: 'ltr' }));
    rtlButton.addEventListener('click', () => setPreferences({ direction: 'rtl' }));
    singleButton.addEventListener('click', () => setPreferences({ spread: 'single' }));
    doubleButton.addEventListener('click', () => setPreferences({ spread: 'double' }));
    autoButton.addEventListener('click', () => setPreferences({ spread: 'auto' }));
    fitButton.addEventListener('click', () => setPreferences({ fit: nextComicFit(preferences.fit) }));
    cropButton.addEventListener('click', () =>
      setPreferences({ cropMargins: !preferences.cropMargins }),
    );
    pageSlider.addEventListener('input', () => {
      const next = Number.parseInt(pageSlider.value, 10);
      if (!Number.isSafeInteger(next)) return;
      const spreadPrefs = layoutSpreadPrefs();
      if (preferences.mode === 'paged' && spreadPrefs.spread === 'double') {
        const spreads = comicSpreadList(images.length, spreadPrefs, landscapePages);
        const page = spreads[Math.min(spreads.length, Math.max(1, next)) - 1]?.[0];
        if (page !== undefined) scrollToIndex(page);
        return;
      }
      scrollToIndex(next - 1);
    });
    pageButton.addEventListener('click', () => {
      setChromeVisible(true);
      pageSlider.focus();
    });

    let chromeVisible = true;
    let chromeTimer: ReturnType<typeof setTimeout> | null = null;
    const syncSystemBars = (visible: boolean): void => {
      try {
        if (options.setSystemBarsVisible !== undefined) {
          void Promise.resolve(options.setSystemBarsVisible(visible)).catch(() => undefined);
          return;
        }
        syncComicSystemBarsVisible(visible);
      } catch {
        // invoke 失败仍只藏应用 chrome，阅读不中断。
      }
    };
    const setChromeVisible = (visible: boolean): void => {
      const changed = chromeVisible !== visible;
      chromeVisible = visible;
      // data-comic-chrome 被 reader-view 的 MutationObserver 监听；等值重写
      // 也会触发回调，只在变化时写。
      const state = visible ? 'visible' : 'hidden';
      if (container.dataset.comicChrome !== state) {
        container.dataset.comicChrome = state;
      }
      chrome.setAttribute('aria-hidden', String(!visible));
      if (visible) {
        topbar.setAttribute('data-tauri-drag-region', '');
      } else {
        topbar.removeAttribute('data-tauri-drag-region');
      }
      if (changed) syncSystemBars(visible);
    };
    const scheduleChromeHide = (): void => {
      if (chromeTimer !== null) clearTimeout(chromeTimer);
      chromeTimer = setTimeout(() => {
        if (!destroyed && !chrome.contains(document.activeElement)) setChromeVisible(false);
      }, COMIC_CHROME_IDLE_MS);
    };
    const revealChrome = (): void => {
      setChromeVisible(true);
      scheduleChromeHide();
    };
    const activePointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let pinchScale = 1;
    let panOrigin: { x: number; y: number; viewX: number; viewY: number } | null = null;
    let swipeOrigin: { x: number; y: number } | null = null;
    let gestureMoved = false;
    let lastGestureUp: { x: number; y: number } | null = null;
    let lastPointerType: string = 'mouse';
    let pendingTap: ReturnType<typeof setTimeout> | null = null;
    let lastTap: { x: number; y: number; at: number } | null = null;

    const setPanning = (panning: boolean): void => {
      if (panning) container.dataset.comicPanning = 'true';
      else delete container.dataset.comicPanning;
    };

    const cancelPendingTap = (): void => {
      if (pendingTap === null) return;
      clearTimeout(pendingTap);
      pendingTap = null;
    };

    const handleSurfaceTap = (clientX: number): void => {
      container.focus({ preventScroll: true });
      const rect = container.getBoundingClientRect();
      if (rect.width < 8) {
        setChromeVisible(!chromeVisible);
        return;
      }
      if (viewScale > 1) {
        setChromeVisible(!chromeVisible);
        if (chromeVisible) scheduleChromeHide();
        return;
      }
      const x = clientX - rect.left;
      if (
        lastPointerType === 'touch' &&
        (x < COMIC_SYSTEM_EDGE_PX || rect.width - x < COMIC_SYSTEM_EDGE_PX)
      ) {
        setChromeVisible(!chromeVisible);
        if (chromeVisible) scheduleChromeHide();
        return;
      }
      const ratio = x / rect.width;
      const backward = preferences.direction === 'rtl' ? ratio > 1 - COMIC_EDGE_ZONE : ratio < COMIC_EDGE_ZONE;
      const forward = preferences.direction === 'rtl' ? ratio < COMIC_EDGE_ZONE : ratio > 1 - COMIC_EDGE_ZONE;
      if (backward) advancePage(-1);
      else if (forward) advancePage(1);
      else setChromeVisible(!chromeVisible);
      if (chromeVisible) scheduleChromeHide();
    };

    const onSurfaceClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (isComicInteractiveTarget(event.target)) return;
      if (lastGestureUp !== null) {
        const nearGesture = comicPointerDistance(lastGestureUp, {
          x: event.clientX,
          y: event.clientY,
        }) <= 40;
        lastGestureUp = null;
        if (nearGesture) return;
      }
      if (event.detail >= 2) return;
      if (event.isTrusted && lastPointerType === 'touch') {
        cancelPendingTap();
        const { clientX } = event;
        pendingTap = setTimeout(() => {
          pendingTap = null;
          if (!destroyed) handleSurfaceTap(clientX);
        }, COMIC_DOUBLE_TAP_MS);
        return;
      }
      handleSurfaceTap(event.clientX);
    };

    const onDoubleClick = (event: MouseEvent): void => {
      if (isComicInteractiveTarget(event.target)) return;
      event.preventDefault();
      cancelPendingTap();
      lastGestureUp = null;
      toggleZoomAt(event.clientX, event.clientY);
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (isComicInteractiveTarget(event.target)) return;
      lastPointerType = event.pointerType || lastPointerType;
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      gestureMoved = false;
      if (activePointers.size === 2) {
        cancelPendingTap();
        lastGestureUp = { x: event.clientX, y: event.clientY };
        const points = [...activePointers.values()];
        pinchDistance = comicPointerDistance(points[0]!, points[1]!);
        pinchScale = viewScale;
        panOrigin = null;
        swipeOrigin = null;
        return;
      }
      if (viewScale > 1) {
        panOrigin = { x: event.clientX, y: event.clientY, viewX, viewY };
        container.setPointerCapture?.(event.pointerId);
      } else if (preferences.mode === 'paged' && event.pointerType !== 'mouse') {
        // Mouse/trackpad clicks stay on the click-zone path. Capturing a Mac
        // trackpad as a swipe swallows the click that would page or show chrome.
        swipeOrigin = { x: event.clientX, y: event.clientY };
        container.setPointerCapture?.(event.pointerId);
      }
    };

    const onGesturePointerMove = (event: PointerEvent): void => {
      const tracked = activePointers.get(event.pointerId);
      if (tracked === undefined) return;
      tracked.x = event.clientX;
      tracked.y = event.clientY;
      if (activePointers.size >= 2) {
        const points = [...activePointers.values()];
        const distance = comicPointerDistance(points[0]!, points[1]!);
        if (pinchDistance > 0 && distance > 0) {
          const midX = (points[0]!.x + points[1]!.x) / 2;
          const midY = (points[0]!.y + points[1]!.y) / 2;
          zoomAt(midX, midY, pinchScale * (distance / pinchDistance));
          gestureMoved = true;
          lastGestureUp = { x: event.clientX, y: event.clientY };
          event.preventDefault();
        }
        return;
      }
      if (panOrigin !== null && viewScale > 1) {
        const dx = event.clientX - panOrigin.x;
        const dy = event.clientY - panOrigin.y;
        if (Math.hypot(dx, dy) >= COMIC_PAN_SLOP) {
          gestureMoved = true;
          setPanning(true);
        }
        viewX = panOrigin.viewX + dx;
        viewY = panOrigin.viewY + dy;
        applyViewTransform();
        event.preventDefault();
        return;
      }
      if (swipeOrigin !== null && viewScale <= 1 && preferences.mode === 'paged') {
        const dx = event.clientX - swipeOrigin.x;
        const dy = event.clientY - swipeOrigin.y;
        if (isComicSwipeTurn(dx, dy)) {
          gestureMoved = true;
          lastGestureUp = { x: event.clientX, y: event.clientY };
          event.preventDefault();
        }
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!activePointers.has(event.pointerId)) return;
      activePointers.delete(event.pointerId);
      if (activePointers.size < 2) {
        pinchDistance = 0;
        pinchScale = viewScale;
      }
      if (activePointers.size === 0) {
        const swipeStart = swipeOrigin;
        panOrigin = null;
        swipeOrigin = null;
        setPanning(false);
        if (
          gestureMoved &&
          swipeStart !== null &&
          viewScale <= 1 &&
          preferences.mode === 'paged'
        ) {
          const dx = event.clientX - swipeStart.x;
          const dy = event.clientY - swipeStart.y;
          lastGestureUp = { x: event.clientX, y: event.clientY };
          lastTap = null;
          const swipeDirection = comicSwipePageDirection(dx, dy, preferences.direction);
          if (swipeDirection !== null) {
            advancePage(swipeDirection);
          }
        } else if (gestureMoved) {
          lastGestureUp = { x: event.clientX, y: event.clientY };
          lastTap = null;
        } else if (event.pointerType === 'touch') {
          const now = performance.now();
          const previous = lastTap;
          lastTap = { x: event.clientX, y: event.clientY, at: now };
          if (
            previous !== null &&
            now - previous.at <= COMIC_DOUBLE_TAP_MS &&
            comicPointerDistance(previous, lastTap) <= 36
          ) {
            cancelPendingTap();
            lastGestureUp = { x: event.clientX, y: event.clientY };
            lastTap = null;
            toggleZoomAt(event.clientX, event.clientY);
          }
        }
      }
      if (container.hasPointerCapture?.(event.pointerId) === true) {
        container.releasePointerCapture(event.pointerId);
      }
    };

    const onHoverPointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const target = event.target;
      if (target instanceof Element && chrome.contains(target)) {
        revealChrome();
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.height < 8) return;
      const y = event.clientY - rect.top;
      if (y <= 72 || y >= rect.height - 96) revealChrome();
    };
    const stopChromeBubble = (event: Event): void => event.stopPropagation();
    chrome.addEventListener('click', stopChromeBubble);
    chrome.addEventListener('pointermove', stopChromeBubble);
    const blockNativeSelect = (event: Event): void => {
      event.preventDefault();
    };
    container.addEventListener('selectstart', blockNativeSelect);
    container.addEventListener('dragstart', blockNativeSelect);
    container.addEventListener('click', onSurfaceClick);
    container.addEventListener('dblclick', onDoubleClick);
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onGesturePointerMove, { passive: false });
    container.addEventListener('pointermove', onHoverPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    chrome.addEventListener('pointerenter', revealChrome);
    const gatePagedWheel = createPagedWheelGate();
    const onWheel = (event: WheelEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select') !== null
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoomAt(event.clientX, event.clientY, viewScale * factor);
        return;
      }
      if (viewScale > 1) {
        event.preventDefault();
        event.stopPropagation();
        viewX -= event.deltaX;
        viewY -= event.deltaY;
        applyViewTransform();
        return;
      }
      if (preferences.mode !== 'paged') {
        return;
      }
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
        return;
      }
      if (
        preferences.fit !== 'screen' &&
        scrollerHasRoomInDelta(pagesRoot, event.deltaX, event.deltaY)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (gatePagedWheel(delta > 0 ? 1 : -1, (direction) => advancePage(direction))) {
        scheduleChromeHide();
      }
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    scheduleChromeHide();

    const syncCurrentPage = (): void => {
      if (preferences.mode === 'paged') return;
      const closest = viewportPageIndex(currentPage - 1);
      const changed = currentPage !== closest + 1;
      currentPage = closest + 1;
      updateToolbar();
      refreshCacheWindow(closest);
      if (changed) options.onPageChange?.();
    };
    const scrollFrames = rafFrameScheduler();
    const scrollCoordinator =
      scrollFrames === null ? null : createCoalescedScrollHandler(syncCurrentPage, scrollFrames);
    const onScrollEvent = (): void => {
      if (scrollCoordinator === null) syncCurrentPage();
      else scrollCoordinator.schedule();
    };
    scroller.addEventListener('scroll', onScrollEvent, { passive: true });

    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (preferences.mode === 'paged') return;
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.pageIndex);
            if (entry.isIntersecting) visible.add(index);
            else visible.delete(index);
          }
          syncCurrentPage();
        },
        { root: scroller, rootMargin: '0px 0px 40% 0px' },
      );
      slots.forEach((slot) => observer?.observe(slot));
    }

    const onViewportChange = (): void => {
      if (destroyed) return;
      applyLayout(false);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('orientationchange', onViewportChange);
    }

    applyLayout(false);
    const firstPages =
      preferences.mode === 'paged'
        ? comicVisiblePages(currentPage - 1, images.length, layoutSpreadPrefs(), landscapePages)
        : stripCacheCenters(currentPage - 1, images.length);
    await Promise.all(firstPages.map((index) => loadPage(index)));
    const prefetchTimer = setTimeout(() => {
      if (destroyed) return;
      prefetchNeighbors = true;
      refreshCacheWindow(currentPage - 1);
    }, 0);

    const destroy = (): Promise<void> => {
      if (destruction !== null) return destruction;
      destroyed = true;
      cropGeneration += 1;
      cropQueue.length = 0;
      clearTimeout(prefetchTimer);
      if (chromeTimer !== null) clearTimeout(chromeTimer);
      cancelPendingTap();
      if (!chromeVisible) syncSystemBars(true);
      container.removeEventListener('click', onSurfaceClick);
      container.removeEventListener('dblclick', onDoubleClick);
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onGesturePointerMove);
      container.removeEventListener('pointermove', onHoverPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('selectstart', blockNativeSelect);
      container.removeEventListener('dragstart', blockNativeSelect);
      container.removeEventListener('wheel', onWheel);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('orientationchange', onViewportChange);
      }
      chrome.removeEventListener('pointerenter', revealChrome);
      chrome.removeEventListener('click', stopChromeBubble);
      chrome.removeEventListener('pointermove', stopChromeBubble);
      for (const operation of pending.values()) operation.controller.abort();
      observer?.disconnect();
      scroller.removeEventListener('scroll', onScrollEvent);
      scrollCoordinator?.cancel();
      for (const index of [...materialized.keys()]) releasePage(index);
      destruction = (async () => {
        await Promise.allSettled([...pending.values()].map((operation) => operation.promise));
        unsubscribeProgress.splice(0).forEach((unsubscribe) => unsubscribe());
        await Promise.allSettled([...openedProviders].reverse().map((provider) => provider.close()));
      })();
      return destruction;
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
        return images.length;
      },
      get metadata() {
        return metadata;
      },
      get currentPage() {
        return currentPage;
      },
      get preferences() {
        return preferences;
      },
      scrollToPage(page) {
        scrollToIndex(Math.min(images.length - 1, Math.max(0, Math.floor(page) - 1)));
      },
      scrollToProgress(progress) {
        scrollToIndex(
          comicPageFromProgress(progress, images.length, preferences, landscapePages) - 1,
        );
      },
      nextPage: () => advancePage(1),
      previousPage: () => advancePage(-1),
      setPreferences,
      hideChrome() {
        if (!chromeVisible) return false;
        setChromeVisible(false);
        return true;
      },
      adjustZoom(action) {
        if (action === 'reset') {
          resetViewTransform();
          return;
        }
        const rect = container.getBoundingClientRect();
        const factor = action === 'in' ? 1.25 : 1 / 1.25;
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewScale * factor);
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
