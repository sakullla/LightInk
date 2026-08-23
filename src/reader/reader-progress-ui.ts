/**
 * Reader chrome progress helpers: chapter label, page-turn motion.
 * Slide (not curl) is the Apple Books / Kindle default for long-form prose.
 */

import type { OutlineItem } from '../outline/outline-model.js';
import { isUsableEpubChapterTitle } from './chapter-title.js';
import type { ReaderState } from './types.js';

export const READER_PAGE_ANIM_MS = 280;

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
): number[] {
  if (total <= 1 || total > 48 || outline.length === 0) {
    return [];
  }
  const top = outline.filter((item) => item.level === 1);
  const source = top.length >= 2 ? top : outline.filter((item) => item.level <= 2);
  if (source.length > MAX_TICK_SOURCE) {
    return [];
  }
  const raw: number[] = [];
  for (const item of source) {
    if (locationKind === 'page' && item.page !== undefined && item.page > 0) {
      raw.push((item.page - 1) / total);
    } else if (item.chapter !== undefined && item.chapter >= 0) {
      raw.push(item.chapter / total);
    }
  }
  const unique = [...new Set(raw.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000))]
    .filter((value) => value > 0.015 && value < 0.985)
    .sort((left, right) => left - right);
  if (unique.length > MAX_PROGRESS_TICKS) {
    return [];
  }
  return unique;
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
