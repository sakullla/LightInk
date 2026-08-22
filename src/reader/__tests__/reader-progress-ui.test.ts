// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  formatReaderLocation,
  playReaderPageTurn,
  resolveReaderChapterTitle,
} from '../reader-progress-ui.js';

describe('resolveReaderChapterTitle', () => {
  const fallback = (kind: 'chapter' | 'page', n: number) => `${kind}:${n}`;

  it('uses the matching outline title, then the nearest previous heading', () => {
    expect(
      resolveReaderChapterTitle(
        { current: 2, locationKind: 'chapter' },
        [
          { level: 1, text: '序章', anchor: 0, chapter: 0 },
          { level: 1, text: '正文', anchor: 1, chapter: 1 },
        ],
        fallback,
      ),
    ).toBe('正文');
    expect(
      resolveReaderChapterTitle(
        { current: 4, locationKind: 'chapter' },
        [{ level: 1, text: '正文', anchor: 1, chapter: 1 }],
        fallback,
      ),
    ).toBe('正文');
    expect(
      resolveReaderChapterTitle({ current: 3, locationKind: 'page' }, [], fallback),
    ).toBe('page:3');
  });
});

describe('formatReaderLocation', () => {
  it('formats a current/total pair and stays empty without a position', () => {
    expect(formatReaderLocation(3, 12)).toBe('3 / 12');
    expect(formatReaderLocation(0, 12)).toBe('');
    expect(formatReaderLocation(3, 0)).toBe('');
  });
});

describe('playReaderPageTurn', () => {
  it('stamps a slide token and clears it after the motion window', () => {
    const root = document.createElement('div');
    let delayed: (() => void) | undefined;
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      schedule: (fn) => {
        delayed = fn;
        return 1;
      },
    });
    expect(root.getAttribute('data-page-anim')).toBe('next');
    delayed!();
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });

  it('skips motion when the user prefers reduced motion', () => {
    const root = document.createElement('div');
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: true }),
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });
});
