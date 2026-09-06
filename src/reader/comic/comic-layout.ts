/**
 * 漫画布局：applyPageFit/applySlotFit/applySurfaceMetrics/applyLayout 与
 * 裁边显示输入（peekInsets/cropFallbackAspect）。行为逐字保留自拆分前
 * cbz.ts 的对应闭包。
 */

import {
  applyComicCropDisplay,
  COMIC_CROP_NONE,
  comicCroppedSize,
} from '../comic-model.js';
import {
  comicSpreadStart,
  comicVisiblePages,
  type ComicFit,
} from '../comic-preferences.js';
import { comicLayoutSpreadPrefs, type ComicSession } from './comic-session.js';
import { scheduleVisibleCropScans, syncComicPageLoading } from './comic-pages.js';
import { refreshCacheWindow } from './comic-cache.js';
import { updateToolbar } from './comic-chrome.js';
import {
  applyViewTransform,
  commitZoomRaster,
  repinZoomRasterSlot,
  unpinZoomRaster,
} from './comic-zoom.js';
import { resetDragTurn } from './comic-drag-turn.js';

function peekInsets(session: ComicSession, index: number) {
  if (session.preferences.cropMargins !== true) return COMIC_CROP_NONE;
  return session.cropInsets.get(index) ?? COMIC_CROP_NONE;
}

function cropFallbackAspect(session: ComicSession): 'natural' | 'none' {
  return session.preferences.mode === 'strip' || session.preferences.fit !== 'screen'
    ? 'natural'
    : 'none';
}

function displayWidth(session: ComicSession, index: number): number | undefined {
  const width = session.naturalWidths.get(index);
  const height = session.naturalHeights.get(index);
  if (width === undefined) return undefined;
  if (height === undefined) return width;
  return comicCroppedSize(width, height, peekInsets(session, index)).width;
}

function applySlotWidth(session: ComicSession, index: number): void {
  const width = session.naturalWidths.get(index);
  const height = session.naturalHeights.get(index);
  if (session.preferences.fit === 'original' && width !== undefined && height !== undefined) {
    const cropped = comicCroppedSize(width, height, peekInsets(session, index));
    session.slots[index]!.style.setProperty(
      '--lightink-comic-natural-width',
      `${cropped.width}px`,
    );
    session.slots[index]!.style.setProperty(
      '--lightink-comic-natural-height',
      `${cropped.height}px`,
    );
  } else {
    session.slots[index]!.style.removeProperty('--lightink-comic-natural-width');
    session.slots[index]!.style.removeProperty('--lightink-comic-natural-height');
  }
}

function applyPageFit(element: HTMLElement | null, fit: ComicFit): void {
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
}

export function applySlotFit(session: ComicSession, index: number): void {
  const slot = session.slots[index];
  if (slot === undefined) return;
  const { preferences } = session;
  applySlotWidth(session, index);
  const page = slot.querySelector<HTMLElement>('.lightink-reader-page');
  if (preferences.mode === 'strip') {
    slot.style.flex = '0 0 auto';
    slot.style.minHeight = '0';
    slot.style.background = 'transparent';
    if (preferences.fit === 'original') {
      const width = displayWidth(session, index);
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
      session.naturalWidths.get(index) ?? 0,
      session.naturalHeights.get(index) ?? 0,
      peekInsets(session, index),
      { fallbackAspect: cropFallbackAspect(session) },
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
    session.naturalWidths.get(index) ?? 0,
    session.naturalHeights.get(index) ?? 0,
    peekInsets(session, index),
    { fallbackAspect: cropFallbackAspect(session) },
  );
  if (preferences.fit === 'width' || preferences.fit === 'original') {
    slot.style.maxHeight = 'none';
  }
  repinZoomRasterSlot(session, index); // 钉住槽的 fit 内联样式被重写后按新几何重钉
}

export function applySurfaceMetrics(session: ComicSession): void {
  const { container, pagesRoot, preferences } = session;
  if (preferences.mode === 'strip') {
    container.style.minHeight = '0';
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    pagesRoot.style.overflow = session.viewScale > 1 ? 'hidden' : 'auto';
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
    session.viewScale > 1 || preferences.fit === 'screen' ? 'hidden' : 'auto';
  pagesRoot.style.removeProperty('flex');
  pagesRoot.style.alignItems = preferences.fit === 'width' ? 'flex-start' : 'center';
}

export function applyLayout(session: ComicSession, notify = true): void {
  const { container, pagesRoot, preferences, slots } = session;
  session.spreadSwapGeneration += 1; // 重排版同步重写 hidden：作废挂起的换屏
  resetDragTurn(session); // 同时作废拖动态/在飞缓动，避免残留邻居槽与偏移
  unpinZoomRaster(session); // 重排版在既有 transform 缩放语义下落位，钉住在结尾重提
  const previousPage = session.currentPage;
  const spreadPrefs = comicLayoutSpreadPrefs(session);
  const currentIndex = comicSpreadStart(
    session.currentPage - 1,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  session.currentPage = currentIndex + 1;
  container.dataset.comicMode = preferences.mode;
  container.dataset.comicDirection = preferences.direction;
  container.dataset.comicSpread = spreadPrefs.spread;
  container.dataset.comicSpreadPref = preferences.spread;
  container.dataset.comicFit = preferences.fit;
  container.dataset.comicFitWidth = String(preferences.fit === 'width');
  container.dataset.comicCropMargins = String(preferences.cropMargins);
  container.dataset.comicVisible = String(
    preferences.mode === 'paged'
      ? comicVisiblePages(currentIndex, session.images.length, spreadPrefs, session.landscapePages)
          .length
      : 0,
  );
  pagesRoot.dir = preferences.direction;
  applySurfaceMetrics(session);
  if (preferences.mode === 'paged') {
    const shown = new Set(
      comicVisiblePages(currentIndex, session.images.length, spreadPrefs, session.landscapePages),
    );
    slots.forEach((slot, index) => {
      slot.hidden = !shown.has(index);
      syncComicPageLoading(session, index);
    });
    session.visible.clear();
    shown.forEach((index) => session.visible.add(index));
    shown.forEach((index) => applySlotFit(session, index));
  } else {
    slots.forEach((slot) => {
      slot.hidden = false;
    });
    session.visible.clear();
    slots.forEach((_slot, index) => {
      applySlotFit(session, index);
      syncComicPageLoading(session, index); // strip：mode 门控内只会摘除指示类
    });
  }
  applyViewTransform(session);
  commitZoomRaster(session); // 仍处放大时按重排版后的新几何重钉（resize 后保持清晰栅格）
  updateToolbar(session);
  refreshCacheWindow(session, currentIndex);
  scheduleVisibleCropScans(session);
  if (notify && previousPage !== session.currentPage) session.options.onPageChange?.();
}
