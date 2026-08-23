// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  clampFlowRestoreIndex,
  flowBookProgress,
  formatReaderLocation,
  formatReaderPercent,
  playReaderPageTurn,
  readerProgressTickFractions,
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
    expect(
      resolveReaderChapterTitle(
        { current: 1, locationKind: 'chapter' },
        [{ level: 1, text: 'ccdqxkhp', anchor: 0, chapter: 0 }],
        fallback,
      ),
    ).toBe('chapter:1');
  });
});

describe('formatReaderLocation', () => {
  it('formats a current/total pair and stays empty without a position', () => {
    expect(formatReaderLocation(3, 12)).toBe('3 / 12');
    expect(formatReaderLocation(0, 12)).toBe('');
    expect(formatReaderLocation(3, 0)).toBe('');
  });
});

describe('flowBookProgress', () => {
  it('keeps chapter 5 of 727 near 1% even at the end of that chapter', () => {
    expect(flowBookProgress(5, 727, 1)).toBeCloseTo(5 / 727, 5);
    expect(formatReaderPercent(flowBookProgress(5, 727, 1))).toBe('1%');
    expect(clampFlowRestoreIndex(4, 727)).toBe(4);
    expect(clampFlowRestoreIndex(4, 3)).toBe(2);
  });
});

describe('readerProgressTickFractions', () => {
  it('maps level-1 chapter starts onto the book track and omits the ends', () => {
    expect(formatReaderPercent(0.256)).toBe('26%');
    expect(
      readerProgressTickFractions(
        [
          { level: 1, text: '序', anchor: 0, chapter: 0 },
          { level: 1, text: '一', anchor: 1, chapter: 2 },
          { level: 1, text: '二', anchor: 2, chapter: 5 },
          { level: 2, text: '二之一', anchor: 3, chapter: 6 },
        ],
        10,
        'chapter',
      ),
    ).toEqual([0.2, 0.5]);
    expect(
      readerProgressTickFractions(
        Array.from({ length: 176 }, (_, index) => ({
          level: 1,
          text: `c${index}`,
          anchor: index,
          chapter: index,
        })),
        176,
        'chapter',
      ),
    ).toEqual([]);
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
