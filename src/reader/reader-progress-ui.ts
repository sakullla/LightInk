/**
 * Reader chrome progress helpers: chapter label, page-turn motion.
 * Slide (not curl) is the Apple Books / Kindle default for long-form prose.
 */

import type { OutlineItem } from '../outline/outline-model.js';
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
    if (exact?.text) {
      return exact.text;
    }
    const previous = outline.filter(
      (item) => item.chapter !== undefined && item.chapter <= index && item.text !== '',
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
