/**
 * Comic archive rendering shared by CBZ, CBR, CB7, and nested archives.
 *
 * Archive entries stay behind ArchiveProvider. Only pages selected by the
 * decoded-byte budget are materialized in the WebView.
 */

import { ParseError } from './types.js';
import { openSafeArchive, type ArchiveInput } from './safe-archive.js';
import type {
  ArchiveEntryMetadata,
  ArchiveProvider,
  ArchiveReadProgress,
} from '../sources/types.js';
import type { ArchivePasswordProvider } from '../sources/native-archive.js';
import { enforcePageCount } from './page-limits.js';
import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
  yieldReaderLoad,
} from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import {
  createCoalescedScrollHandler,
  createPagedWheelGate,
  nearestVisibleSlot,
  rafFrameScheduler,
} from '../../ui/reading-layout.js';
import {
  comicDisplayWidthPx,
  createComicPageElement,
  compareComicPaths,
  isComicImagePath,
  isIgnoredComicPath,
  orderComicPages,
  parseComicInfo,
  selectComicCacheWindow,
  type ComicMetadata,
} from '../comic-model.js';
import {
  advanceComicPage,
  comicSpreadStart,
  comicVisiblePages,
  loadComicPreferences,
  saveComicPreferences,
  type ComicPreferenceStorage,
  type ComicPreferences,
} from '../comic-preferences.js';

const COMIC_ARCHIVE_EXTS = new Set(['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7']);
const DEFAULT_COMIC_CACHE_BUDGET = 96 * 1024 * 1024;
const MAX_COMIC_INFO_BYTES = 1024 * 1024;
const COMIC_CHROME_IDLE_MS = 2800;
const COMIC_EDGE_ZONE = 0.28;

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
  readonly paged: string;
  readonly leftToRight: string;
  readonly rightToLeft: string;
  readonly singlePage: string;
  readonly doublePage: string;
  readonly fitWidth: string;
  readonly pageSlider: string;
  readonly toggleChrome: string;
  readonly imageDecodeFailed: string;
  readonly nestedArchive: string;
  readonly nestedArchiveFailed: string;
  readonly openingNestedArchive: string;
  readonly retry: string;
}

export interface CbzRenderHandle {
  readonly totalPages: number;
  readonly currentPage: number;
  readonly metadata: ComicMetadata;
  readonly preferences: ComicPreferences;
  scrollToPage(page: number): void;
  nextPage(): boolean;
  previousPage(): boolean;
  setPreferences(patch: Partial<ComicPreferences>): void;
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
  readonly labels?: Partial<ComicToolbarLabels>;
  readonly onReturnToShelf?: () => void;
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

async function readComicInfo(
  provider: ArchiveProvider,
  entries: readonly ComicArchiveEntry[],
  signal?: AbortSignal,
): Promise<ComicMetadata | null> {
  const candidate = entries
    .filter(
      (entry) =>
        isComicInfoPath(entry.filename) && entry.uncompressedSize <= MAX_COMIC_INFO_BYTES,
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
    if (bytes.byteLength > MAX_COMIC_INFO_BYTES) return null;
    return parseComicInfo(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
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
        vertical: '竖向滚动',
        paged: '横向翻页',
        leftToRight: '从左到右',
        rightToLeft: '从右到左',
        singlePage: '单页',
        doublePage: '双页',
        fitWidth: '适合宽度',
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
        vertical: 'Vertical scroll',
        paged: 'Horizontal pages',
        leftToRight: 'Left to right',
        rightToLeft: 'Right to left',
        singlePage: 'Single page',
        doublePage: 'Double page',
        fitWidth: 'Fit width',
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
    let preferences = loadComicPreferences(storage, metadata.readingDirection ?? 'ltr');
    const cacheBudget = Math.max(1, options.cacheBudgetBytes ?? DEFAULT_COMIC_CACHE_BUDGET);

    container.replaceChildren();
    container.dataset.comicReader = 'true';
    container.dataset.comicChrome = 'visible';
    const chrome = document.createElement('div');
    chrome.className = 'lightink-reader-comic-chrome';
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
    const verticalButton = chip(chineseChrome ? '滚动' : 'Scroll', labels.vertical);
    const pagedButton = chip(chineseChrome ? '翻页' : 'Pages', labels.paged);
    const ltrButton = chip(chineseChrome ? '左到右' : 'LTR', labels.leftToRight);
    const rtlButton = chip(chineseChrome ? '右到左' : 'RTL', labels.rightToLeft);
    const singleButton = chip(chineseChrome ? '单页' : '1', labels.singlePage);
    const doubleButton = chip(chineseChrome ? '双页' : '2', labels.doublePage);
    const fitButton = chip(chineseChrome ? '适宽' : 'Fit', labels.fitWidth);
    const group = (...buttons: HTMLButtonElement[]): HTMLDivElement => {
      const element = document.createElement('div');
      element.className = 'lightink-reader-comic-tool-group';
      element.setAttribute('role', 'group');
      element.append(...buttons);
      return element;
    };
    scrub.append(previousButton, pageSlider, nextButton);
    modes.append(
      group(pagedButton, verticalButton),
      group(ltrButton, rtlButton),
      group(singleButton, doubleButton),
      group(fitButton),
    );

    const createSlot = (page: ComicPageEntry, index: number): HTMLDivElement => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
      slot.dataset.pageIndex = String(index);
      slot.dataset.pagePath = page.virtualPath;
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
    let randomReads = 0;
    const randomWaiters: Array<() => void> = [];
    const withRandomRead = async (readSignal: AbortSignal): Promise<void> => {
      throwIfReaderLoadCancelled(readSignal);
      if (randomReads >= 2) {
        await new Promise<void>((resolve) => {
          const resume = (): void => {
            readSignal.removeEventListener('abort', resume);
            resolve();
          };
          randomWaiters.push(resume);
          readSignal.addEventListener('abort', resume, { once: true });
        });
        throwIfReaderLoadCancelled(readSignal);
      }
      randomReads += 1;
    };
    const releaseRandomRead = (): void => {
      randomReads = Math.max(0, randomReads - 1);
      randomWaiters.shift()?.();
    };
    const visible = new Set<number>();
    const estimatedBytes = images.map((page) => Math.max(1, page.entry.uncompressedSize));
    const naturalWidths = new Map<number, number>();
    let wantedPages = new Set<number>();
    let currentPage = 1;
    let destroyed = false;
    let destruction: Promise<void> | null = null;
    let observer: IntersectionObserver | null = null;

    const updateToolbar = (): void => {
      const progress = `${currentPage} / ${images.length}`;
      verticalButton.setAttribute('aria-pressed', String(preferences.mode === 'vertical'));
      pagedButton.setAttribute('aria-pressed', String(preferences.mode === 'paged'));
      ltrButton.setAttribute('aria-pressed', String(preferences.direction === 'ltr'));
      rtlButton.setAttribute('aria-pressed', String(preferences.direction === 'rtl'));
      singleButton.setAttribute('aria-pressed', String(preferences.spread === 'single'));
      doubleButton.setAttribute('aria-pressed', String(preferences.spread === 'double'));
      fitButton.setAttribute('aria-pressed', String(preferences.fitWidth));
      previousButton.disabled = currentPage <= 1;
      nextButton.disabled =
        advanceComicPage(currentPage - 1, images.length, 1, preferences) === currentPage - 1;
      pageSlider.max = String(Math.max(1, images.length));
      pageSlider.value = String(currentPage);
      pageButton.textContent = progress;
      pageButton.setAttribute('aria-label', `${labels.pageSlider}: ${progress}`);
    };

    const applySlotWidth = (index: number): void => {
      const width = naturalWidths.get(index);
      if (!preferences.fitWidth && width !== undefined) {
        slots[index]!.style.setProperty('--lightink-comic-natural-width', `${width}px`);
      } else {
        slots[index]!.style.removeProperty('--lightink-comic-natural-width');
      }
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
      if (existing !== undefined) return existing.promise;
      const controller = new AbortController();
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
            pending.delete(index);
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
            await withRandomRead(controller.signal);
            try {
              data = await read();
            } finally {
              releaseRandomRead();
            }
            await yieldReaderLoad(controller.signal);
          }
          throwIfReaderLoadCancelled(controller.signal);
          if (destroyed || !wantedPages.has(index)) return;
          const mounted = await createComicPageElement(data, page.entry.filename, {
            resizeWidth: comicDisplayWidthPx(slots[index]),
            signal: controller.signal,
          });
          if (destroyed || controller.signal.aborted || !wantedPages.has(index)) {
            if (mounted.url !== '') URL.revokeObjectURL(mounted.url);
            mounted.element.remove();
            return;
          }
          if (mounted.width > 0 && mounted.height > 0) {
            slots[index]!.style.aspectRatio = `${mounted.width} / ${mounted.height}`;
            naturalWidths.set(index, mounted.width);
          }
          applySlotWidth(index);
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
      })().finally(() => {
        pending.delete(index);
      });
      pending.set(index, { promise: operation, controller });
      return operation;
    };

    let prefetchNeighbors = false;
    const scroller = pagesRoot;

    const verticalSpreadPages = (center: number): number[] => {
      const index = Math.min(Math.max(0, center), Math.max(0, images.length - 1));
      if (preferences.spread !== 'double') return [index];
      const start = index - (index % 2);
      return start + 1 < images.length ? [start, start + 1] : [start];
    };

    const viewportPageIndex = (fallback: number): number => {
      const top = scroller.getBoundingClientRect().top;
      const slotTops = slots.map((slot) => slot.getBoundingClientRect().top);
      if (new Set(slotTops).size > 1) {
        const nearest = nearestVisibleSlot(slotTops, top);
        return nearest >= 0 ? nearest : fallback;
      }
      return visible.size > 0 ? Math.min(...visible) : fallback;
    };

    function refreshCacheWindow(center: number): void {
      const centers =
        preferences.mode === 'paged'
          ? comicVisiblePages(center, images.length, preferences)
          : verticalSpreadPages(center);
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
      for (const index of wanted) {
        if (firstUnresolved >= 0 && index > firstUnresolved) continue;
        if (images[index]?.kind === 'archive') continue;
        void loadPage(index).catch((error: unknown) => {
          if (!isAbortError(error, signal) && !destroyed) showPageError(index);
        });
      }
    }

    const applyLayout = (notify = true): void => {
      const previousPage = currentPage;
      const currentIndex = comicSpreadStart(currentPage - 1, images.length, preferences);
      currentPage = currentIndex + 1;
      container.dataset.comicMode = preferences.mode;
      container.dataset.comicDirection = preferences.direction;
      container.dataset.comicSpread = preferences.spread;
      container.dataset.comicFitWidth = String(preferences.fitWidth);
      container.dataset.comicVisible = String(
        preferences.mode === 'paged'
          ? comicVisiblePages(currentIndex, images.length, preferences).length
          : 0,
      );
      pagesRoot.dir = preferences.direction;
      if (preferences.mode === 'paged') {
        const shown = new Set(comicVisiblePages(currentIndex, images.length, preferences));
        slots.forEach((slot, index) => {
          slot.hidden = !shown.has(index);
        });
        visible.clear();
        shown.forEach((index) => visible.add(index));
      } else {
        slots.forEach((slot) => {
          slot.hidden = false;
        });
        visible.clear();
      }
      slots.forEach((_slot, index) => applySlotWidth(index));
      updateToolbar();
      refreshCacheWindow(currentIndex);
      if (notify && previousPage !== currentPage) options.onPageChange?.();
    };

    const setPreferences = (patch: Partial<ComicPreferences>): void => {
      preferences = {
        mode: patch.mode === 'paged' || patch.mode === 'vertical' ? patch.mode : preferences.mode,
        direction:
          patch.direction === 'rtl' || patch.direction === 'ltr'
            ? patch.direction
            : preferences.direction,
        spread:
          patch.spread === 'double' || patch.spread === 'single'
            ? patch.spread
            : preferences.spread,
        fitWidth: typeof patch.fitWidth === 'boolean' ? patch.fitWidth : preferences.fitWidth,
      };
      saveComicPreferences(storage, preferences);
      applyLayout();
    };

    const scrollToIndex = (requestedIndex: number): boolean => {
      const index = comicSpreadStart(requestedIndex, images.length, preferences);
      const changed = currentPage !== index + 1;
      currentPage = index + 1;
      if (preferences.mode === 'paged') {
        applyLayout(false);
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
      const next = advanceComicPage(currentPage - 1, images.length, direction, preferences);
      if (next === currentPage - 1) return false;
      return scrollToIndex(next);
    };

    previousButton.addEventListener('click', () => advancePage(-1));
    nextButton.addEventListener('click', () => advancePage(1));
    verticalButton.addEventListener('click', () => setPreferences({ mode: 'vertical' }));
    pagedButton.addEventListener('click', () => setPreferences({ mode: 'paged' }));
    ltrButton.addEventListener('click', () => setPreferences({ direction: 'ltr' }));
    rtlButton.addEventListener('click', () => setPreferences({ direction: 'rtl' }));
    singleButton.addEventListener('click', () => setPreferences({ spread: 'single' }));
    doubleButton.addEventListener('click', () => setPreferences({ spread: 'double' }));
    fitButton.addEventListener('click', () => setPreferences({ fitWidth: !preferences.fitWidth }));
    pageSlider.addEventListener('input', () => {
      const next = Number.parseInt(pageSlider.value, 10);
      if (Number.isSafeInteger(next)) scrollToIndex(next - 1);
    });
    pageButton.addEventListener('click', () => {
      setChromeVisible(true);
      pageSlider.focus();
    });

    let chromeVisible = true;
    let chromeTimer: ReturnType<typeof setTimeout> | null = null;
    const setChromeVisible = (visible: boolean): void => {
      chromeVisible = visible;
      // data-comic-chrome 被 reader-view 的 MutationObserver 监听；等值重写
      // 也会触发回调，只在变化时写。
      const state = visible ? 'visible' : 'hidden';
      if (container.dataset.comicChrome !== state) {
        container.dataset.comicChrome = state;
      }
      chrome.setAttribute('aria-hidden', String(!visible));
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
    const onSurfaceClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          '.lightink-reader-comic-chrome, .lightink-reader-comic-error, input, button, a',
        ) !== null
      ) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width < 8) {
        setChromeVisible(!chromeVisible);
        return;
      }
      const ratio = (event.clientX - rect.left) / rect.width;
      const backward = preferences.direction === 'rtl' ? ratio > 1 - COMIC_EDGE_ZONE : ratio < COMIC_EDGE_ZONE;
      const forward = preferences.direction === 'rtl' ? ratio < COMIC_EDGE_ZONE : ratio > 1 - COMIC_EDGE_ZONE;
      if (backward) advancePage(-1);
      else if (forward) advancePage(1);
      else setChromeVisible(!chromeVisible);
      if (chromeVisible) scheduleChromeHide();
    };
    const onPointerMove = (event: PointerEvent): void => {
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
    container.addEventListener('pointermove', onPointerMove);
    chrome.addEventListener('pointerenter', revealChrome);
    const gatePagedWheel = createPagedWheelGate();
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey || preferences.mode !== 'paged') {
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select') !== null
      ) {
        return;
      }
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) {
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

    applyLayout(false);
    const firstPages =
      preferences.mode === 'paged'
        ? comicVisiblePages(currentPage - 1, images.length, preferences)
        : verticalSpreadPages(currentPage - 1);
    await Promise.all(firstPages.map((index) => loadPage(index)));
    const prefetchTimer = setTimeout(() => {
      if (destroyed) return;
      prefetchNeighbors = true;
      refreshCacheWindow(currentPage - 1);
    }, 0);

    const destroy = (): Promise<void> => {
      if (destruction !== null) return destruction;
      destroyed = true;
      clearTimeout(prefetchTimer);
      if (chromeTimer !== null) clearTimeout(chromeTimer);
      container.removeEventListener('click', onSurfaceClick);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('selectstart', blockNativeSelect);
      container.removeEventListener('dragstart', blockNativeSelect);
      container.removeEventListener('wheel', onWheel);
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
      nextPage: () => advancePage(1),
      previousPage: () => advancePage(-1),
      setPreferences,
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
