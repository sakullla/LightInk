// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  displayChapterTitle,
  isUsableEpubChapterTitle,
  markDuplicateChapterHeading,
} from '../chapter-title.js';
import { DEFAULT_READER_PREFS, applyReaderPrefs } from '../reader-prefs.js';
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
  it('stamps the effective style into the token and clears it after the motion window', () => {
    const root = document.createElement('div');
    let delayed: (() => void) | undefined;
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'auto',
      schedule: (fn) => {
        delayed = fn;
        return 1;
      },
    });
    // auto 未显式选择且无 reduce → slide；token 携带生效样式。
    expect(root.getAttribute('data-page-anim')).toBe('slide-next');
    delayed!();
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });

  it('dispatches every explicit style and direction into its own token', () => {
    const root = document.createElement('div');
    const cases: ReadonlyArray<[Parameters<typeof playReaderPageTurn>[2], string]> = [
      [{ pageTurnStyle: 'slide' }, 'slide-prev'],
      [{ pageTurnStyle: 'fade' }, 'fade-next'],
      [{ pageTurnStyle: 'fade' }, 'fade-prev'],
      [{ pageTurnStyle: 'curl' }, 'curl-next'],
      [{ pageTurnStyle: 'curl' }, 'curl-prev'],
    ];
    for (const [options, expected] of cases) {
      root.removeAttribute('data-page-anim');
      playReaderPageTurn(root, expected.endsWith('next') ? 1 : -1, {
        matchMedia: () => ({ matches: false }),
        schedule: () => 0,
        ...options,
      });
      expect(root.getAttribute('data-page-anim')).toBe(expected);
    }
  });

  it('resolves auto to none under reduced motion and skips stamping entirely', () => {
    const root = document.createElement('div');
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: true }),
      pageTurnStyle: 'auto',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBeNull();
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: true }),
      pageTurnStyle: 'none',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });

  it('honors an explicit choice over system reduced motion', () => {
    const root = document.createElement('div');
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: true }),
      pageTurnStyle: 'slide',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBe('slide-next');
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: true }),
      pageTurnStyle: 'curl',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBe('curl-next');
  });

  it('stamps on touch-primary documents and in scroll layout (R1 entry coverage)', () => {
    // 触屏/滚动布局不再整体跳过：slide 在触屏分栏由 CSS 抑制块与 scroller
    // 缓动配合，滚动布局整屏跳转按 token 播放。
    document.documentElement.setAttribute('data-touch-primary', '');
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    document.body.appendChild(root);
    try {
      playReaderPageTurn(root, 1, {
        matchMedia: () => ({ matches: false }),
        pageTurnStyle: 'slide',
        schedule: () => 0,
      });
      expect(root.getAttribute('data-page-anim')).toBe('slide-next');
      playReaderPageTurn(root, -1, {
        matchMedia: () => ({ matches: false }),
        pageTurnStyle: 'fade',
        schedule: () => 0,
      });
      expect(root.getAttribute('data-page-anim')).toBe('fade-prev');
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
      root.remove();
    }
  });

  it('reads the applied preference cache when no override is passed', () => {
    const root = document.createElement('div');
    const rootStub = { dataset: {} as DOMStringMap };
    try {
      applyReaderPrefs(rootStub, { showProgressBar: true, pageTurnStyle: 'curl' });
      playReaderPageTurn(root, 1, {
        matchMedia: () => ({ matches: false }),
        schedule: () => 0,
      });
      expect(root.getAttribute('data-page-anim')).toBe('curl-next');
    } finally {
      applyReaderPrefs(rootStub, DEFAULT_READER_PREFS);
    }
  });

  it('skips motion while a chapter frame is still restoring its page', () => {
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const chapter = document.createElement('div');
    chapter.className = 'lightink-reader-chapter is-active';
    const frame = document.createElement('iframe');
    frame.className = 'lightink-reader-chapter-frame';
    frame.dataset.pagedRestore = 'start';
    chapter.appendChild(frame);
    root.appendChild(chapter);
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'slide',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });

  it('keeps the token when a stale same-direction timer fires during a newer turn', () => {
    // 连击同方向：旧 timer 提前触发时新动画尚在播，不得摘除 token（seq 守卫）。
    const root = document.createElement('div');
    const timers: Array<() => void> = [];
    const schedule = (fn: () => void): number => {
      timers.push(fn);
      return timers.length;
    };
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'slide',
      schedule,
    });
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'slide',
      schedule,
    });
    expect(root.getAttribute('data-page-anim')).toBe('slide-next');
    timers[0]!(); // 第一次翻页的旧 timer 先到期：新动画仍在播，不得清理。
    expect(root.getAttribute('data-page-anim')).toBe('slide-next');
    timers[1]!(); // 最新一次的 timer 才允许移除。
    expect(root.getAttribute('data-page-anim')).toBeNull();
  });

  it('replaces a stale opposite-direction token so direction changes restart cleanly', () => {
    const root = document.createElement('div');
    playReaderPageTurn(root, 1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'fade',
      schedule: () => 0,
    });
    playReaderPageTurn(root, -1, {
      matchMedia: () => ({ matches: false }),
      pageTurnStyle: 'fade',
      schedule: () => 0,
    });
    expect(root.getAttribute('data-page-anim')).toBe('fade-prev');
  });

  it('clears each reader instance token on its own motion window', () => {
    // 多标签：TabManager 只在 closeTab 时 destroy reader，切标签仅切 host 的
    // display，所以桌面上多个 reader root 会同时存活。清理代次按 root 记，
    // 否则另一个实例翻页会让本实例的 timer 提前返回，token 永久滞留。
    const a = document.createElement('div');
    const b = document.createElement('div');
    const timers: Array<() => void> = [];
    const schedule = (fn: () => void): number => {
      timers.push(fn);
      return timers.length;
    };
    const turn = (root: HTMLElement): void => {
      playReaderPageTurn(root, 1, {
        matchMedia: () => ({ matches: false }),
        pageTurnStyle: 'slide',
        schedule,
      });
    };

    turn(a);
    turn(b);
    expect(a.getAttribute('data-page-anim')).toBe('slide-next');
    expect(b.getAttribute('data-page-anim')).toBe('slide-next');

    timers[0]!(); // a 自己的 timer：a 上没有更新的翻页，必须清掉 a 的 token。
    expect(a.getAttribute('data-page-anim')).toBeNull();
    expect(b.getAttribute('data-page-anim')).toBe('slide-next');

    timers[1]!();
    expect(b.getAttribute('data-page-anim')).toBeNull();
  });

  it('does not strand one instance token while another instance keeps turning', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const timers: Array<() => void> = [];
    const schedule = (fn: () => void): number => {
      timers.push(fn);
      return timers.length;
    };
    const turn = (root: HTMLElement): void => {
      playReaderPageTurn(root, 1, {
        matchMedia: () => ({ matches: false }),
        pageTurnStyle: 'slide',
        schedule,
      });
    };

    turn(a);
    turn(b);
    turn(b); // b 连击，只应推进 b 自己的代次。

    timers[0]!(); // a 的 timer 仍应清掉 a 的 token。
    expect(a.getAttribute('data-page-anim')).toBeNull();
  });

  it('keeps the per-instance guard from breaking same-direction bursts on one root', () => {
    // 回归护栏：按 root 计数不得削弱既有的同向连击保护。
    const root = document.createElement('div');
    const timers: Array<() => void> = [];
    const schedule = (fn: () => void): number => {
      timers.push(fn);
      return timers.length;
    };
    const turn = (): void => {
      playReaderPageTurn(root, 1, {
        matchMedia: () => ({ matches: false }),
        pageTurnStyle: 'slide',
        schedule,
      });
    };

    turn();
    turn();
    timers[0]!(); // 旧 timer 提前到期：新动画仍在播，不得摘除。
    expect(root.getAttribute('data-page-anim')).toBe('slide-next');
    timers[1]!();
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
