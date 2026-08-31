/**
 * Reader chrome progress helpers: chapter label, page-turn motion.
 * Slide (not curl) is the Apple Books / Kindle default for long-form prose.
 */

import type { OutlineItem } from '../outline/outline-model.js';
import type { Annotation } from './annotations.js';
import { isTouchPrimaryDocument } from './comic-preferences.js';
import { isUsableEpubChapterTitle } from './chapter-title.js';
import {
  sanitizeReadingProgressTitle,
  type ReadingProgress,
} from './reading-progress.js';
import type { ReaderState } from './types.js';

export const READER_PAGE_ANIM_MS = 280;

/** Chapter-edge bounce duration (T2): ~200ms spring, touch only. */
export const READER_PAGE_BOUNDARY_BOUNCE_MS = 200;

export function resolveReaderChapterTitle(
  state: Pick<ReaderState, 'current' | 'locationKind'>,
  outline: readonly OutlineItem[],
  fallback: (kind: 'chapter' | 'page', n: number) => string,
): string {
  if (state.current <= 0) {
    return '';
  }
  if (state.locationKind === 'chapter') {
    const index = state.current - 1;
    const exact = outline.find((item) => item.chapter === index);
    if (exact?.text && isUsableEpubChapterTitle(exact.text)) {
      return exact.text;
    }
    const previous = outline.filter(
      (item) =>
        item.chapter !== undefined &&
        item.chapter <= index &&
        isUsableEpubChapterTitle(item.text),
    );
    return previous[previous.length - 1]?.text ?? fallback('chapter', state.current);
  }
  if (state.locationKind === 'page') {
    const exact = outline.find((item) => item.page === state.current);
    if (exact?.text) {
      return exact.text;
    }
    const previous = outline.filter(
      (item) => item.page !== undefined && item.page <= state.current && item.text !== '',
    );
    return previous[previous.length - 1]?.text ?? fallback('page', state.current);
  }
  return '';
}

/** Stamp a usable outline heading onto a persist snapshot; drop junk or empty titles. */
export function stampReadingProgressTitle(
  progress: ReadingProgress,
  outline: readonly OutlineItem[],
): ReadingProgress {
  const title = sanitizeReadingProgressTitle(
    resolveReaderChapterTitle(
      progress.kind === 'flow'
        ? { current: progress.index + 1, locationKind: 'chapter' }
        : { current: Math.max(1, progress.index), locationKind: 'page' },
      outline,
      () => '',
    ),
  );
  if (title === undefined) {
    if (progress.title === undefined) {
      return progress;
    }
    const { title: _dropped, ...rest } = progress;
    return rest;
  }
  if (progress.title === title) {
    return progress;
  }
  return { ...progress, title };
}

export function formatReaderLocation(current: number, total: number): string {
  if (total <= 0 || current <= 0) {
    return '';
  }
  return `${current} / ${total}`;
}

export function formatReaderPercent(progress: number): string {
  const normalized = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return `${Math.round(normalized * 100)}%`;
}

/** Spine index for restore/seek. Never clamp to the mounted iframe window. */
export function clampFlowRestoreIndex(savedIndex: number, spineLength: number): number {
  if (!Number.isSafeInteger(spineLength) || spineLength <= 0) {
    return 0;
  }
  if (!Number.isSafeInteger(savedIndex) || savedIndex < 0) {
    return 0;
  }
  return Math.min(savedIndex, spineLength - 1);
}

/** Book progress: chapter index + in-chapter page ratio, never "this chapter is 100%". */
export function flowBookProgress(
  current: number,
  total: number,
  inChapterRatio: number,
): number {
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  const index = Math.max(0, Number.isFinite(current) ? current - 1 : 0);
  const ratio = Number.isFinite(inChapterRatio) ? Math.min(1, Math.max(0, inChapterRatio)) : 0;
  return Math.min(1, (index + ratio) / total);
}

const MAX_PROGRESS_TICKS = 8;
const MAX_TICK_SOURCE = 16;

/** 进度轨两类刻度：章节刻度（TOC）与书签刻度（活书签位置，点击可跳）。 */
export interface ReaderProgressTicks {
  readonly chapters: number[];
  readonly bookmarks: number[];
}

function normalizeTickFractions(raw: readonly number[]): number[] {
  return [...new Set(raw.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000))]
    .filter((value) => value > 0.015 && value < 0.985)
    .sort((left, right) => left - right);
}

/** 活书签（非 tombstone 的 kind='bookmark'）在全书进度轨上的 fraction。 */
export function readerBookmarkTickFractions(
  annotations: readonly Annotation[],
  total: number,
): number[] {
  if (!Number.isSafeInteger(total) || total <= 1) {
    return [];
  }
  const raw: number[] = [];
  for (const annotation of annotations) {
    if (annotation.kind !== 'bookmark' || annotation.deletedAt !== undefined) {
      continue;
    }
    const locator = annotation.locator;
    if (
      (locator.format === 'flow' || locator.format === 'text') &&
      locator.chapter !== undefined &&
      locator.chapter >= 0
    ) {
      raw.push(locator.chapter / total);
    } else if (
      (locator.format === 'pdf' || locator.format === 'cbz') &&
      Number.isSafeInteger(locator.page) &&
      locator.page >= 1
    ) {
      raw.push((locator.page - 1) / total);
    }
  }
  return normalizeTickFractions(raw);
}

/**
 * TOC marks on the book-progress track (Readest / KOReader).
 * Level-1 headings first; fall back to level ≤2. Ends are omitted so ticks
 * never sit on the rounded caps. Large spines stay empty — a tick per
 * chapter on a 100+ book freezes the footer.
 */
export function readerProgressTickFractions(
  outline: readonly OutlineItem[],
  total: number,
  locationKind: 'chapter' | 'page' | null,
  bookmarks: readonly Annotation[] = [],
): ReaderProgressTicks {
  const ticks: { chapters: number[]; bookmarks: number[] } = {
    chapters: [],
    bookmarks: readerBookmarkTickFractions(bookmarks, total),
  };
  if (total <= 1 || total > 48 || outline.length === 0) {
    return ticks;
  }
  const top = outline.filter((item) => item.level === 1);
  const source = top.length >= 2 ? top : outline.filter((item) => item.level <= 2);
  if (source.length > MAX_TICK_SOURCE) {
    return ticks;
  }
  const raw: number[] = [];
  for (const item of source) {
    if (locationKind === 'page' && item.page !== undefined && item.page > 0) {
      raw.push((item.page - 1) / total);
    } else if (item.chapter !== undefined && item.chapter >= 0) {
      raw.push(item.chapter / total);
    }
  }
  const unique = normalizeTickFractions(raw);
  if (unique.length > MAX_PROGRESS_TICKS) {
    return ticks;
  }
  return { chapters: unique, bookmarks: ticks.bookmarks };
}

export function playReaderPageTurn(
  root: HTMLElement,
  direction: 1 | -1,
  options?: {
    matchMedia?: (query: string) => { matches: boolean };
    schedule?: (fn: () => void, ms: number) => number;
  },
): void {
  const media =
    options?.matchMedia ??
    (typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined);
  if (media?.('(prefers-reduced-motion: reduce)').matches === true) {
    return;
  }
  // 触屏：CSS 已关掉 data-page-anim，再读 offsetWidth 只是整页强制重排。
  if (isTouchPrimaryDocument(root.ownerDocument)) {
    return;
  }
  // 连续滚动：视口步进已经是瞬跳。再给整章做 translate/opacity 会强制
  // 重排并抢走合成层，换章后第一下手指滚动会明显卡一下。
  if (root.dataset.readingLayout === 'scroll') {
    return;
  }
  // 刚换章的帧还在重分栏（data-paged-restore），slide 会叠在未完成的
  // layout 上；章界本身也没有可插值的 scrollLeft。
  if (
    root.querySelector(
      '.lightink-reader-chapter.is-active .lightink-reader-chapter-frame[data-paged-restore]',
    ) !== null
  ) {
    return;
  }
  const token = direction > 0 ? 'next' : 'prev';
  root.removeAttribute('data-page-anim');
  void root.offsetWidth;
  root.setAttribute('data-page-anim', token);
  const schedule =
    options?.schedule ??
    ((fn, ms) => (typeof setTimeout === 'function' ? (setTimeout(fn, ms) as unknown as number) : 0));
  schedule(() => {
    if (root.getAttribute('data-page-anim') === token) {
      root.removeAttribute('data-page-anim');
    }
  }, READER_PAGE_ANIM_MS + 40);
}

/** 连击同方向时旧 timer 的清理回调序号：只有最新一次调用才允许移除属性。 */
let readerBoundaryBounceSeq = 0;

/**
 * Chapter-edge bounce for touch paging (T2): `advanceFlowPage` hit the
 * first/last chapter boundary and returned false, so the active chapter
 * springs ±10px and settles back instead of giving no feedback. Desktop
 * keeps today's silent no-op; reduced motion skips the spring (same
 * matchMedia short-circuit as playReaderPageTurn). Comics never reach this
 * path (their session advance is clamped inside the page host and always
 * returns true).
 */
export function playReaderPageBoundaryBounce(
  root: HTMLElement,
  direction: 1 | -1,
  options?: {
    touchPrimary?: boolean;
    matchMedia?: (query: string) => { matches: boolean };
    schedule?: (fn: () => void, ms: number) => number;
  },
): void {
  const touchPrimary = options?.touchPrimary ?? isTouchPrimaryDocument(root.ownerDocument);
  if (!touchPrimary) {
    return;
  }
  const media =
    options?.matchMedia ??
    (typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined);
  if (media?.('(prefers-reduced-motion: reduce)').matches === true) {
    return;
  }
  const token = direction > 0 ? 'next' : 'prev';
  root.removeAttribute('data-page-boundary');
  void root.offsetWidth;
  root.setAttribute('data-page-boundary', token);
  const schedule =
    options?.schedule ??
    ((fn, ms) => (typeof setTimeout === 'function' ? (setTimeout(fn, ms) as unknown as number) : 0));
  const seq = (readerBoundaryBounceSeq += 1);
  schedule(() => {
    // 连击同方向：旧 timer 提前触发时新回弹尚在播，不得移除属性。
    if (seq !== readerBoundaryBounceSeq) {
      return;
    }
    if (root.getAttribute('data-page-boundary') === token) {
      root.removeAttribute('data-page-boundary');
    }
  }, READER_PAGE_BOUNDARY_BOUNCE_MS + 40);
}
