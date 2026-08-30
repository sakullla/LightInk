// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  displayChapterTitle,
  isUsableEpubChapterTitle,
  markDuplicateChapterHeading,
} from '../chapter-title.js';
import {
  clampFlowRestoreIndex,
  flowBookProgress,
  formatReaderLocation,
  formatReaderPercent,
  playReaderPageBoundaryBounce,
  playReaderPageTurn,
  readerBookmarkTickFractions,
  readerProgressTickFractions,
  resolveReaderChapterTitle,
  stampReadingProgressTitle,
} from '../reader-progress-ui.js';
import type { Annotation, Locator } from '../annotations.js';

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

describe('stampReadingProgressTitle', () => {
  it('persists the outline heading and omits converter junk', () => {
    const flow = {
      version: 2 as const,
      kind: 'flow' as const,
      index: 1,
      ratio: 0.2,
      total: 10,
      updatedAt: 1,
    };
    expect(
      stampReadingProgressTitle(flow, [
        { level: 1, text: '序章', anchor: 0, chapter: 0 },
        { level: 1, text: '第2章 白月光', anchor: 1, chapter: 1 },
      ]),
    ).toMatchObject({ title: '第2章 白月光' });
    expect(
      stampReadingProgressTitle(flow, [{ level: 1, text: 'ccdqxkhp', anchor: 0, chapter: 1 }]),
    ).not.toHaveProperty('title');
    expect(
      stampReadingProgressTitle(
        { ...flow, kind: 'page', index: 12 },
        [{ level: 1, text: 'Chapter 12', anchor: 12, page: 12 }],
      ),
    ).not.toHaveProperty('title');
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
    ).toEqual({ chapters: [0.2, 0.5], bookmarks: [] });
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
    ).toEqual({ chapters: [], bookmarks: [] });
  });

  it('adds bookmark ticks for live bookmarks only, across locator formats', () => {
    let seq = 0;
    const annotation = (kind: Annotation['kind'], locator: Locator, deletedAt?: number): Annotation => ({
      id: `a${(seq += 1)}`,
      kind,
      locator,
      createdAt: 1,
      ...(deletedAt === undefined ? {} : { deletedAt }),
    });
    const bookmarks: Annotation[] = [
      annotation('bookmark', { format: 'flow', chapter: 2, start: 0, end: 0, quote: '', prefix: '', suffix: '' }),
      annotation('bookmark', { format: 'pdf', page: 6, quote: '' }),
      annotation('bookmark', { format: 'cbz', page: 9 }),
      // tombstone 与高亮/笔记不上刻度。
      annotation('bookmark', { format: 'flow', chapter: 4, start: 0, end: 0, quote: '', prefix: '', suffix: '' }, 2),
      annotation('highlight', { format: 'flow', chapter: 7, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' }),
      annotation('note', { format: 'cbz', page: 3 }),
    ];
    expect(readerBookmarkTickFractions(bookmarks, 10)).toEqual([0.2, 0.5, 0.8]);
    const ticks = readerProgressTickFractions([], 10, 'chapter', bookmarks);
    expect(ticks.chapters).toEqual([]);
    expect(ticks.bookmarks).toEqual([0.2, 0.5, 0.8]);
    // 单页/无总数不出刻度。
    expect(readerBookmarkTickFractions(bookmarks, 1)).toEqual([]);
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

describe('playReaderPageBoundaryBounce', () => {
  it('stamps a boundary bounce token on touch and clears it after the spring', () => {
    const root = document.createElement('div');
    let delayed: (() => void) | undefined;
    playReaderPageBoundaryBounce(root, 1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule: (fn) => {
        delayed = fn;
        return 1;
      },
    });
    expect(root.getAttribute('data-page-boundary')).toBe('next');
    delayed!();
    expect(root.getAttribute('data-page-boundary')).toBeNull();
  });

  it('maps the backward boundary to the prev token', () => {
    const root = document.createElement('div');
    playReaderPageBoundaryBounce(root, -1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-boundary')).toBe('prev');
  });

  it('stays silent on desktop and under reduced motion', () => {
    const root = document.createElement('div');
    playReaderPageBoundaryBounce(root, 1, {
      touchPrimary: false,
      matchMedia: () => ({ matches: false }),
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-boundary')).toBeNull();
    playReaderPageBoundaryBounce(root, -1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: true }),
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-boundary')).toBeNull();
  });

  it('replaces a stale token so rapid boundary hits restart the spring', () => {
    const root = document.createElement('div');
    playReaderPageBoundaryBounce(root, 1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule: () => 0,
    });
    playReaderPageBoundaryBounce(root, -1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-boundary')).toBe('prev');
  });

  it('keeps the attribute when a stale same-direction timer fires during a newer bounce', () => {
    // FB9：连击同方向时旧 timer 提前触发不得移除新回弹的属性。
    const root = document.createElement('div');
    const timers: Array<() => void> = [];
    const schedule = (fn: () => void): number => {
      timers.push(fn);
      return timers.length;
    };
    playReaderPageBoundaryBounce(root, 1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule,
    });
    playReaderPageBoundaryBounce(root, 1, {
      touchPrimary: true,
      matchMedia: () => ({ matches: false }),
      schedule,
    });
    expect(root.getAttribute('data-page-boundary')).toBe('next');
    timers[0]!(); // 第一次回弹的旧 timer 先到期：新回弹仍在播，不得清理。
    expect(root.getAttribute('data-page-boundary')).toBe('next');
    timers[1]!(); // 最新一次的 timer 才允许移除。
    expect(root.getAttribute('data-page-boundary')).toBeNull();
  });
});

describe('displayChapterTitle', () => {
  it('keeps real headings and drops converter junk', () => {
    expect(isUsableEpubChapterTitle('第4章 白月光（求收藏）')).toBe(true);
    expect(isUsableEpubChapterTitle('ccdqxkhp')).toBe(false);
    expect(isUsableEpubChapterTitle('Chapter 12')).toBe(false);
    expect(displayChapterTitle('ccdqxkhp', '第 1 章')).toBe('第 1 章');
    expect(displayChapterTitle('第4章 白月光（求收藏）', '第 1 章')).toBe(
      '第4章 白月光（求收藏）',
    );
  });
});

describe('markDuplicateChapterHeading', () => {
  it('marks the first body heading that repeats the chapter title', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>第一卷</p><p>卷首。</p><p>第10章 标题</p><p>正文甲。</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).toBe('第10章 标题');
    expect(root.querySelectorAll('[data-reader-split-heading]')).toHaveLength(1);
  });

  it('does not mark later body text that merely mentions the title', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>正文甲。</p><p>第10章 标题 只是一句闲话</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')).toBeNull();
  });

  it('peels a fused heading off the first paragraph so the body is not hidden', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>第10章 标题<br>正文甲。</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).toBe('第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).not.toContain('正文甲');
    expect(root.textContent).toContain('正文甲');
  });
});
