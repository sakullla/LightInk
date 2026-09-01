/**
 * `reader-bookmarks` — reader-view 拆分（T5-kernel-split）的书签域：活书签事实
 * 判定（chrome 按钮两态与菜单勾选）、书签开关（tombstone 移除/当前位置添加）、
 * 页内持久角标 syncBookmarkIndicators（PDF 官方 .page 与漫画 slot 双轨）与
 * 进度轨书签刻度跳转 jumpToBookmarkTick。纯移动自 reader-view.ts，行为不变。
 */

import type { Annotation } from '../annotations.js';
import type { ReaderState } from '../types.js';
import type { ReaderViewContext } from './reader-context.js';

export interface ReaderBookmarksSurface {
  bookmarkAtStatePosition(state: ReaderState): Annotation | null;
  syncChromeBookmarkState(): void;
  toggleBookmarkAtCurrentPosition(): void;
  syncBookmarkIndicators(): void;
  jumpToBookmarkTick(fraction: number): void;
}

export function setupReaderBookmarks(ctx: ReaderViewContext): ReaderBookmarksSurface {
  // —— 书签一等开关（R1）：chrome 按钮/菜单/角标/进度轨刻度共用同一组事实判定。 ——

  /**
   * 状态位的活书签（chrome 按钮两态与菜单勾选的事实源）：按 readerState 判定
   *（页式按页码、流式按章），不读正文 DOM，滚动帧上调用也足够便宜。
   */
  const bookmarkAtStatePosition = (state: ReaderState): Annotation | null => {
    if (state.locationKind === 'page' && state.current > 0) {
      return (
        ctx.annotations.find(
          (annotation) =>
            annotation.kind === 'bookmark' &&
            annotation.deletedAt === undefined &&
            (annotation.locator.format === 'pdf' || annotation.locator.format === 'cbz') &&
            annotation.locator.page === state.current,
        ) ?? null
      );
    }
    if (state.locationKind === 'chapter' && state.current > 0) {
      const chapter = state.current - 1;
      return (
        ctx.annotations.find(
          (annotation) =>
            annotation.kind === 'bookmark' &&
            annotation.deletedAt === undefined &&
            (annotation.locator.format === 'flow' || annotation.locator.format === 'text') &&
            (annotation.locator.chapter ?? 0) === chapter,
        ) ?? null
      );
    }
    return null;
  };

  /** chrome 书签按钮两态 + 进度轨书签刻度随位置/集合刷新（setProgress 幂等）。 */
  const syncChromeBookmarkState = (): void => {
    ctx.readerChrome?.setBookmarked(bookmarkAtStatePosition(ctx.readerState) !== null);
    ctx.chrome.syncChromeProgress();
  };

  /** 书签开关：当前位置已有活书签则 tombstone 移除，否则在当前位置添加。 */
  const toggleBookmarkAtCurrentPosition = (): void => {
    if (!ctx.sessionAnnotation.enabled()) {
      return;
    }
    const existing = bookmarkAtStatePosition(ctx.readerState);
    if (existing !== null) {
      ctx.annotation.removeAnnotationById(existing.id);
      return;
    }
    ctx.annotation.appendAnnotation('bookmark', ctx.annotation.currentPositionLocator(), undefined, undefined);
  };

  /** 页内持久书签指示（R1）：有活书签的章/页在页角渲染丝带角标（装饰，不侵交互）。 */
  const BOOKMARK_BADGE_CLASS = 'lightink-reader-bookmark-ribbon';
  const syncBookmarkIndicators = (): void => {
    const chapters = new Set<number>();
    const pages = new Set<number>();
    for (const annotation of ctx.annotations) {
      if (annotation.kind !== 'bookmark' || annotation.deletedAt !== undefined) {
        continue;
      }
      const locator = annotation.locator;
      if (
        (locator.format === 'flow' || locator.format === 'text') &&
        locator.chapter !== undefined
      ) {
        chapters.add(locator.chapter);
      } else if (locator.format === 'pdf' || locator.format === 'cbz') {
        pages.add(locator.page);
      }
    }
    const syncBadge = (host: HTMLElement, on: boolean): void => {
      const existing = host.querySelector(`:scope > .${BOOKMARK_BADGE_CLASS}`);
      if (!on) {
        existing?.remove();
        return;
      }
      if (existing !== null) {
        return;
      }
      const badge = document.createElement('span');
      badge.className = BOOKMARK_BADGE_CLASS;
      badge.setAttribute('aria-hidden', 'true');
      badge.title = ctx.t('annotation.bookmarkBadge');
      host.appendChild(badge);
    };
    for (const article of ctx.scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      syncBadge(article, chapters.has(Number(article.dataset.chapterIndex)));
    }
    // PDF：官方 .page[data-page-number]（1 基）为角标锚；CBZ：漫画 slot（0 基）双轨。
    for (const page of ctx.pageHost.querySelectorAll<HTMLElement>('.pdfViewer .page[data-page-number]')) {
      syncBadge(page, pages.has(Number(page.dataset.pageNumber)));
    }
    for (const slot of ctx.pageHost.querySelectorAll<HTMLElement>('.lightink-reader-page-slot')) {
      syncBadge(slot, pages.has(Number(slot.dataset.pageIndex) + 1));
    }
  };

  /** 书签刻度点击（chrome 回调）：按刻度 fraction 找回对应活书签并跳转。 */
  const jumpToBookmarkTick = (fraction: number): void => {
    const total = ctx.readerState.total;
    if (!Number.isSafeInteger(total) || total <= 1) {
      return;
    }
    const match = ctx.annotations.find((annotation) => {
      if (annotation.kind !== 'bookmark' || annotation.deletedAt !== undefined) {
        return false;
      }
      const locator = annotation.locator;
      const raw =
        locator.format === 'flow' || locator.format === 'text'
          ? (locator.chapter ?? -1) / total
          : locator.format === 'pdf' || locator.format === 'cbz'
            ? (locator.page - 1) / total
            : -1;
      if (raw < 0) {
        return false;
      }
      return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000 === fraction;
    });
    if (match !== undefined) {
      ctx.annotation.jumpToAnnotation(match);
    }
  };

  return {
    bookmarkAtStatePosition,
    syncChromeBookmarkState,
    toggleBookmarkAtCurrentPosition,
    syncBookmarkIndicators,
    jumpToBookmarkTick,
  };
}
