/**
 * 漫画页面物化：slot 创建、materialized/pending/failed 状态、
 * loadPage/releasePage/updatePageList/expandNestedArchive 与裁边扫描队列。
 * 行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import { enforcePageCount } from '../reader-limits.js';
import {
  throwIfReaderLoadCancelled,
  yieldReaderLoad,
} from '../load-lifecycle.js';
import {
  comicDisplayWidthPx,
  createComicPageElement,
  detectComicCropInsets,
  isComicCropEmpty,
  type ComicPageElement,
} from '../comic-model.js';
import { isComicLandscapeSize } from '../comic-preferences.js';
import { ParseError } from '../formats/types.js';
import {
  isAbortError,
  type ComicNestedArchiveEntry,
  type ComicPageEntry,
  type ComicSession,
} from './comic-session.js';
import { applyLayout, applySlotFit } from './comic-layout.js';

export function createComicSlot(
  session: ComicSession,
  page: ComicPageEntry,
  index: number,
): HTMLDivElement {
  const slot = document.createElement('div');
  slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
  slot.dataset.pageIndex = String(index);
  slot.dataset.pagePath = page.virtualPath;
  slot.style.background = 'transparent';
  slot.setAttribute('aria-label', `${index + 1} / ${session.images.length}`);
  if (page.kind === 'archive') {
    slot.dataset.nestedArchive = 'true';
    const placeholder = document.createElement('div');
    placeholder.className = 'lightink-reader-nested-archive';
    placeholder.textContent = `${session.labels.nestedArchive}: ${page.entry.filename}`;
    slot.appendChild(placeholder);
  }
  return slot;
}

function pageDisplayWidth(session: ComicSession, index: number): number {
  const slot = session.slots[index];
  if (slot !== undefined && !slot.hidden && slot.clientWidth > 0) {
    return comicDisplayWidthPx(slot);
  }
  return comicDisplayWidthPx(
    session.pagesRoot.clientWidth > 0 ? session.pagesRoot : session.container,
  );
}

const withPrefetchDecode = async (
  session: ComicSession,
  urgent: boolean,
  decodeSignal: AbortSignal,
): Promise<void> => {
  if (urgent) return;
  await session.prefetchDecodes.acquire(decodeSignal);
};

const releasePrefetchDecode = (session: ComicSession, urgent: boolean): void => {
  if (urgent) return;
  session.prefetchDecodes.release();
};

function enqueueCropScan(session: ComicSession, index: number): void {
  if (session.preferences.cropMargins !== true || session.destroyed) return;
  if (session.cropInsets.has(index) || session.cropQueue.includes(index)) return;
  const image = session.materialized.get(index)?.image;
  if (!(image instanceof HTMLImageElement) || image.naturalWidth < 8) return;
  session.cropQueue.push(index);
  void pumpCropScans(session);
}

async function pumpCropScans(session: ComicSession): Promise<void> {
  if (session.cropPumping) return;
  session.cropPumping = true;
  const generation = session.cropGeneration;
  try {
    while (session.cropQueue.length > 0) {
      if (
        session.destroyed ||
        generation !== session.cropGeneration ||
        session.preferences.cropMargins !== true
      ) {
        session.cropQueue.length = 0;
        return;
      }
      const index = session.cropQueue.shift();
      if (index === undefined || session.cropInsets.has(index)) continue;
      const image = session.materialized.get(index)?.image;
      if (!(image instanceof HTMLImageElement) || image.naturalWidth < 8) continue;
      await yieldReaderLoad();
      if (
        session.destroyed ||
        generation !== session.cropGeneration ||
        session.preferences.cropMargins !== true
      ) {
        session.cropQueue.length = 0;
        return;
      }
      if (session.cropInsets.has(index) || session.materialized.get(index)?.image !== image) {
        continue;
      }
      const insets = detectComicCropInsets(image);
      session.cropInsets.set(index, insets);
      if (!isComicCropEmpty(insets) && session.preferences.cropMargins === true && !session.destroyed) {
        applySlotFit(session, index);
      }
    }
  } finally {
    session.cropPumping = false;
    if (session.cropQueue.length > 0 && !session.destroyed) void pumpCropScans(session);
  }
}

export function scheduleVisibleCropScans(session: ComicSession): void {
  if (session.preferences.cropMargins !== true) return;
  for (const index of session.visible) enqueueCropScan(session, index);
}

export function releasePage(session: ComicSession, index: number): void {
  const page = session.materialized.get(index);
  if (page === undefined) return;
  session.materialized.delete(index);
  page.image.remove();
  if (page.url !== '') URL.revokeObjectURL(page.url);
}

/**
 * R2（ADR-3）：未物化页槽的轻量加载指示。类只标记「可见且未物化」的
 * paged 图片页槽（拖动邻居揭示、换屏/跳转落位、decode-hold 超时露占位
 * 都经此同步）；动画本体在 reader.css——纯背景呼吸微光，不占布局、无
 * 新增元素/图标/文案，触屏宿主外与 reduce-motion 下均无动画。
 */
export function syncComicPageLoading(session: ComicSession, index: number): void {
  const slot = session.slots[index];
  if (slot === undefined) return;
  const loading =
    session.preferences.mode === 'paged' &&
    session.images[index]?.kind === 'image' &&
    !slot.hidden &&
    !session.materialized.has(index) &&
    !session.failed.has(index);
  slot.classList.toggle('lightink-comic-page-loading', loading);
}

export function showPageError(session: ComicSession, index: number): void {
  session.failed.add(index);
  const nestedArchive = session.images[index]?.kind === 'archive';
  const error = document.createElement('div');
  error.className = 'lightink-reader-comic-error';
  error.dataset.errorCode = nestedArchive
    ? 'COMIC_NESTED_ARCHIVE_FAILED'
    : 'COMIC_IMAGE_DECODE_FAILED';
  error.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = nestedArchive
    ? session.labels.nestedArchiveFailed
    : session.labels.imageDecodeFailed;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = session.labels.retry;
  retry.addEventListener('click', () => {
    session.failed.delete(index);
    session.slots[index]!.replaceChildren();
    syncComicPageLoading(session, index);
    void loadPage(session, index).catch((loadError: unknown) => {
      if (!isAbortError(loadError, session.signal) && !session.destroyed) {
        showPageError(session, index);
      }
    });
  });
  error.append(text, retry);
  session.slots[index]!.replaceChildren(error);
  syncComicPageLoading(session, index);
}

function updatePageList(
  session: ComicSession,
  index: number,
  placeholder: ComicNestedArchiveEntry,
  nestedPages: readonly ComicPageEntry[],
): void {
  const { images, slots } = session;
  enforcePageCount('cbz', images.length - 1 + nestedPages.length);
  const currentAnchor = images[session.currentPage - 1];
  const oldSlot = slots[index]!;
  const reference = oldSlot.nextSibling;
  session.observer?.unobserve(oldSlot);
  oldSlot.remove();
  const nextSlots = nestedPages.map((page, offset) => {
    const slot = createComicSlot(session, page, index + offset);
    session.pagesRoot.insertBefore(slot, reference);
    session.observer?.observe(slot);
    return slot;
  });
  images.splice(index, 1, ...nestedPages);
  slots.splice(index, 1, ...nextSlots);
  session.estimatedBytes.splice(
    index,
    1,
    ...nestedPages.map((page) => Math.max(1, page.entry.uncompressedSize)),
  );
  session.visible.clear();
  slots.forEach((slot, slotIndex) => {
    slot.dataset.pageIndex = String(slotIndex);
    slot.setAttribute('aria-label', `${slotIndex + 1} / ${images.length}`);
  });
  if (currentAnchor === placeholder) {
    session.currentPage = index + 1;
  } else if (currentAnchor !== undefined) {
    const anchorIndex = images.indexOf(currentAnchor);
    if (anchorIndex >= 0) session.currentPage = anchorIndex + 1;
  }
  const nextCoverPage = Math.max(
    0,
    session.collected.coverEntryId === undefined
      ? 0
      : images.findIndex(
          (page) =>
            page.kind === 'image' &&
            page.provider === session.archive &&
            page.entry.id === session.collected.coverEntryId,
        ),
  );
  session.metadata = Object.freeze({
    ...session.metadata,
    pageCount: images.length,
    coverPage: nextCoverPage,
  });
  session.options.onPageListChange?.(images.length, session.metadata);
}

async function expandNestedArchive(
  session: ComicSession,
  index: number,
  page: ComicNestedArchiveEntry,
  controller: AbortController,
): Promise<void> {
  const child = await page.provider.openNested!(page.entry.id, controller.signal);
  try {
    throwIfReaderLoadCancelled(controller.signal);
    const nested = await session.collectPages(child, controller.signal, page.virtualPath);
    if (nested.pages.length === 0) throw new ParseError('CBZ 未找到图片页');
    throwIfReaderLoadCancelled(controller.signal);
    updatePageList(session, index, page, nested.pages);
    session.openedProviders.add(child);
    if (session.options.onArchiveProgress !== undefined) {
      const unsubscribe = child.subscribeProgress?.(session.options.onArchiveProgress);
      if (unsubscribe !== undefined) session.unsubscribeProgress.push(unsubscribe);
    }
  } catch (error) {
    session.openedProviders.delete(child);
    await child.close().catch(() => undefined);
    throw error;
  }
}

export function loadPage(session: ComicSession, index: number): Promise<void> {
  const {
    images,
    slots,
    materialized,
    pending,
    failed,
    signal,
  } = session;
  if (
    index < 0 ||
    index >= images.length ||
    session.destroyed ||
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
      placeholder.textContent = `${session.labels.openingNestedArchive}: ${requestedPage.entry.filename}`;
    }
    const abortFromParent = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    const operation = expandNestedArchive(session, index, requestedPage, controller)
      .finally(() => {
        signal?.removeEventListener('abort', abortFromParent);
        forgetPending();
      })
      .then(() => {
        if (!session.destroyed) applyLayout(session, false);
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
        const previous = session.sequentialQueues.get(page.provider) ?? Promise.resolve();
        let resolveQueue = (): void => undefined;
        const queueTail = new Promise<void>((resolve) => {
          resolveQueue = resolve;
        });
        session.sequentialQueues.set(page.provider, queueTail);
        try {
          await previous.catch(() => undefined);
          throwIfReaderLoadCancelled(controller.signal);
          data = await read();
        } finally {
          resolveQueue();
          if (session.sequentialQueues.get(page.provider) === queueTail) {
            session.sequentialQueues.delete(page.provider);
          }
        }
      } else {
        await session.randomReads.acquire(controller.signal);
        try {
          data = await read();
        } finally {
          session.randomReads.release();
        }
        await yieldReaderLoad(controller.signal);
      }
      throwIfReaderLoadCancelled(controller.signal);
      if (session.destroyed || !session.wantedPages.has(index)) return;
      const urgent = session.visible.has(index);
      await withPrefetchDecode(session, urgent, controller.signal);
      let mounted: ComicPageElement;
      try {
        mounted = await createComicPageElement(data, page.entry.filename, {
          resizeWidth: pageDisplayWidth(session, index),
          signal: controller.signal,
          priority: urgent ? 'high' : 'low',
        });
      } finally {
        releasePrefetchDecode(session, urgent);
      }
      if (session.destroyed || controller.signal.aborted || !session.wantedPages.has(index)) {
        if (mounted.url !== '') URL.revokeObjectURL(mounted.url);
        mounted.element.remove();
        return;
      }
      if (mounted.width > 0 && mounted.height > 0) {
        slots[index]!.style.aspectRatio = `${mounted.width} / ${mounted.height}`;
        session.naturalWidths.set(index, mounted.width);
        session.naturalHeights.set(index, mounted.height);
        enqueueCropScan(session, index);
        const wasLandscape = session.landscapePages.has(index);
        const nowLandscape = isComicLandscapeSize(mounted.width, mounted.height);
        if (nowLandscape) session.landscapePages.add(index);
        else session.landscapePages.delete(index);
        if (wasLandscape !== nowLandscape && session.preferences.mode === 'paged') {
          applyLayout(session, false);
        }
      }
      mounted.element.addEventListener(
        'error',
        () => {
          const loaded = materialized.get(index);
          if (loaded?.image !== mounted.element) return;
          materialized.delete(index);
          if (mounted.url !== '') URL.revokeObjectURL(mounted.url);
          showPageError(session, index);
        },
        { once: true },
      );
      materialized.set(index, {
        image: mounted.element,
        url: mounted.url,
        decodedBytes: session.estimatedBytes[index] ?? data.byteLength,
      });
      slots[index]!.replaceChildren(mounted.element);
      applySlotFit(session, index);
      syncComicPageLoading(session, index);
    } catch (error) {
      if (
        session.destroyed ||
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
}
