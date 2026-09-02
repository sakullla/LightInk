import { describe, expect, it, vi } from 'vitest';

import {
  advancePagedScroller,
  applyPagedProgress,
  applyReadingLayout,
  createCoalescedScrollHandler,
  createPagedWheelGate,
  createResizeSettle,
  DEFAULT_READING_LAYOUT,
  DEFAULT_READING_MEASURE_REM,
  isReadingNavKey,
  loadReadingLayout,
  nearestVisibleSlot,
  nearestVisibleChapterIndex,
  chapterIndexAtViewportTop,
  applyPagedPageStep,
  cancelPagedTouchSlide,
  pagedColumnStep,
  pagedFrameStep,
  PAGED_TOUCH_SLIDE_MS,
  pagedProgressRatio,
  pagedContentLooksColumnized,
  pagedGlyphInView,
  pagedHitPagePlausible,
  pagedScrollLeftForClientX,
  pagedSpreadMetrics,
  parseReadingLayout,
  type PagedScrollMotion,
  READING_LAYOUT_STORAGE_KEY,
  readingColumnLayout,
  readingNavDirection,
  rafFrameScheduler,
  realPagedFragmentBox,
  saveReadingLayout,
  scrollPagedScrollerToEdge,
  scrollToKeepViewportAnchor,
  settlePagedRelease,
  snapPagedScroller,
  scrollerHasRoomInDelta,
  viewportAnchor,
  type FrameScheduler,
} from '../reading-layout.js';

describe('parseReadingLayout', () => {
  it('defaults to scroll and accepts paginated', () => {
    expect(DEFAULT_READING_LAYOUT).toBe('scroll');
    expect(parseReadingLayout(null)).toBe('scroll');
    expect(parseReadingLayout('paginated')).toBe('paginated');
    expect(parseReadingLayout('other')).toBe('scroll');
  });
});

describe('load/saveReadingLayout', () => {
  it('round-trips through the editor key only', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    expect(loadReadingLayout(storage)).toBe('scroll');
    saveReadingLayout(storage, 'paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(loadReadingLayout(storage)).toBe('paginated');
    expect(store['lightink.reader.flow.layout']).toBeUndefined();
    expect(store['lightink.reader.typography']).toBeUndefined();
    expect(Object.keys(store)).toEqual([READING_LAYOUT_STORAGE_KEY]);
  });
});

describe('paged navigation', () => {
  it('reports remaining overflow so a width-fit comic can scroll before paging', () => {
    const scroller = {
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 2400,
      scrollWidth: 800,
      clientHeight: 800,
      clientWidth: 800,
    };
    expect(scrollerHasRoomInDelta(scroller, 0, 80)).toBe(true);
    expect(scrollerHasRoomInDelta(scroller, 0, -80)).toBe(false);
    scroller.scrollTop = 1600;
    expect(scrollerHasRoomInDelta(scroller, 0, 80)).toBe(false);
    expect(scrollerHasRoomInDelta(scroller, 0, -80)).toBe(true);
  });

  it('advances one viewport at a time and stops at the end', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1)).toBe(true);
    expect(scroller.scrollLeft).toBe(400);
    expect(advancePagedScroller(scroller, 1)).toBe(true);
    expect(scroller.scrollLeft).toBe(500);
    expect(advancePagedScroller(scroller, 1)).toBe(false);
  });

  it('leaves a leftover column sliver so the next chapter can open', () => {
    const scroller = { scrollLeft: 800, scrollWidth: 820, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1)).toBe(false);
  });

  it('accepts an explicit page step so multi-column turns include the gap', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1, 428)).toBe(true);
    expect(scroller.scrollLeft).toBe(428);
  });

  it('round-trips in-chapter page progress', () => {
    const scroller = { scrollLeft: 250, scrollWidth: 900, clientWidth: 400 };
    expect(pagedProgressRatio(scroller)).toBe(0.5);
    applyPagedProgress(scroller, 1);
    expect(scroller.scrollLeft).toBe(500);
    applyPagedProgress(scroller, 0);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('drops CSS-column phantom boxes and pages to the real glyph', () => {
    const phantom = { left: 8, width: 0.4, height: 640 };
    const tall = { left: 8, width: 12, height: 80 };
    const real = { left: 816, width: 18, height: 18 };
    expect(realPagedFragmentBox([phantom, tall, real], 20)).toEqual(real);
    expect(realPagedFragmentBox([phantom], 20)).toBeNull();
    expect(pagedScrollLeftForClientX(816, 8, 0, 400)).toBe(800);
    expect(pagedScrollLeftForClientX(8, 8, 0, 400)).toBe(0);
    expect(pagedGlyphInView(816, 8, 400)).toBe(false);
    expect(pagedGlyphInView(16, 8, 400)).toBe(true);
    expect(pagedGlyphInView(408, 8, 400)).toBe(false);
    expect(pagedContentLooksColumnized(2112, 352, 2400)).toBe(true);
    expect(pagedContentLooksColumnized(352, 352, 2400)).toBe(false);
    expect(pagedContentLooksColumnized(352, 352, 120)).toBe(true);
    expect(pagedHitPagePlausible(0, 2112, 352, 1800, 2400)).toBe(false);
    expect(pagedHitPagePlausible(704, 2112, 352, 1800, 2400)).toBe(true);
    expect(pagedHitPagePlausible(0, 352, 352, 12, 80)).toBe(true);
  });

  it('snaps a leftover sliver back to a whole page', () => {
    const scroller = { scrollLeft: 430, scrollWidth: 1600, clientWidth: 800 };
    snapPagedScroller(scroller);
    expect(scroller.scrollLeft).toBe(800);
  });

  it('settles a short drag back to the nearest whole page', () => {
    const scroller = { scrollLeft: 40, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 0, -40, 400)).toBe(true);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('completes one page from the gesture start after a committed swipe', () => {
    const scroller = { scrollLeft: 160, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 0, -160, 400)).toBe(true);
    expect(scroller.scrollLeft).toBe(400);
  });

  it('does not skip a page when the committed swipe starts between columns', () => {
    const scroller = { scrollLeft: 280, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 200, -80, 400)).toBe(true);
    expect(scroller.scrollLeft).toBe(400);
  });

  it('does not add a second step when native scroll already reached the next page', () => {
    const scroller = { scrollLeft: 400, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 0, -200, 400)).toBe(true);
    expect(scroller.scrollLeft).toBe(400);
  });

  it('lets the caller change chapter when a committed swipe starts on the last page', () => {
    const scroller = { scrollLeft: 1200, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 1200, -80, 400)).toBe(false);
    expect(scroller.scrollLeft).toBe(1200);
  });

  it('lets the caller change chapter when a committed swipe starts on the first page', () => {
    const scroller = { scrollLeft: 20, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 0, 80, 400)).toBe(false);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('does not snap a short last page back to the previous whole page', () => {
    const scroller = { scrollLeft: 1120, scrollWidth: 1920, clientWidth: 800 };
    snapPagedScroller(scroller, 800);
    expect(scroller.scrollLeft).toBe(1120);
  });

  it('lands on the last page when crossing backward into a chapter', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 1920, clientWidth: 800 };
    scrollPagedScrollerToEdge(scroller, -1, 800);
    expect(scroller.scrollLeft).toBe(1120);
  });

  it('keeps the short last page after a later layout pass grows scrollWidth', () => {
    const scroller = { scrollLeft: 0, scrollWidth: 800, clientWidth: 800 };
    scrollPagedScrollerToEdge(scroller, -1, 800);
    expect(scroller.scrollLeft).toBe(0);
    scroller.scrollWidth = 1920;
    scrollPagedScrollerToEdge(scroller, -1, 800);
    expect(scroller.scrollLeft).toBe(1120);
    expect(Math.round(scroller.scrollLeft / 800) * 800).toBe(800);
    expect(scroller.scrollLeft).toBe(1120);
  });

  it('lands on the first page when crossing forward into a chapter', () => {
    const scroller = { scrollLeft: 1120, scrollWidth: 1920, clientWidth: 800 };
    scrollPagedScrollerToEdge(scroller, 1, 800);
    expect(scroller.scrollLeft).toBe(0);
  });

  it('does not treat width:100% as a 100px page step', () => {
    const props: Record<string, string> = {};
    const scroller = {
      style: {
        width: '100%',
        getPropertyValue: (name: string) => props[name] ?? '',
        setProperty: (name: string, value: string) => {
          props[name] = value;
        },
      },
      clientWidth: 1100,
    };
    expect(Number.parseFloat(scroller.style.width)).toBe(100);
    expect(pagedFrameStep(scroller)).toBe(1100);
    applyPagedPageStep(scroller, 1100);
    expect(pagedFrameStep(scroller)).toBe(1100);
  });

  it('restores saved progress on the stored page step, not clientWidth', () => {
    const props: Record<string, string> = {
      '--lightink-reader-page-step': '1036px',
    };
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 4104,
      clientWidth: 996,
      style: {
        width: '996px',
        getPropertyValue: (name: string) => props[name] ?? '',
      },
    };
    applyPagedProgress(scroller, 2072 / 3108);
    expect(scroller.scrollLeft).toBe(2072);
    snapPagedScroller(scroller);
    expect(scroller.scrollLeft).toBe(2072);
  });

  it('turns by viewport plus column gap so a third column does not leak in', () => {
    expect(pagedColumnStep(800, 32)).toBe(832);
    const scroller = { scrollLeft: 0, scrollWidth: 2496, clientWidth: 800 };
    expect(advancePagedScroller(scroller, 1, pagedColumnStep(800, 32))).toBe(true);
    expect(scroller.scrollLeft).toBe(832);
    snapPagedScroller(scroller, pagedColumnStep(800, 32));
    expect(scroller.scrollLeft).toBe(832);
  });

  it('aligns a facing spread so two columns plus gap equal the used width', () => {
    const spread = pagedSpreadMetrics(803, 16);
    expect(spread.columns).toBe(2);
    expect(spread.width).toBe(spread.columnWidth * 2 + spread.gap);
    expect(spread.step).toBe(spread.width + spread.gap);
    expect(spread.width).toBeLessThanOrEqual(803);
  });
});

describe('paged touch slide (T2)', () => {
  const makeClock = (): { now(): number; advance(ms: number): void } => {
    let t = 0;
    return {
      now: () => t,
      advance: (ms) => {
        t += ms;
      },
    };
  };

  const makeScheduler = (): {
    scheduler: FrameScheduler;
    cancelled: number[];
    run(): void;
  } => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    let handle = 0;
    return {
      scheduler: {
        request: (callback) => {
          handle += 1;
          frames.push(callback);
          return handle;
        },
        cancel: (h) => {
          cancelled.push(h);
        },
      },
      cancelled,
      run: () => {
        const frame = frames.shift();
        if (frame !== undefined) frame();
      },
    };
  };

  const touchMotion = (
    scheduler: FrameScheduler,
    now: () => number,
  ): PagedScrollMotion => ({ touchPrimary: true, reducedMotion: false, scheduler, now });

  it('slides a page turn over ~200ms on touch instead of jumping', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    expect(advancePagedScroller(scroller, 1, 400, touchMotion(harness.scheduler, clock.now))).toBe(
      true,
    );
    expect(scroller.scrollLeft).toBe(0); // 未瞬跳：等 rAF
    const samples: number[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      clock.advance(25);
      harness.run();
      samples.push(scroller.scrollLeft);
    }
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples[0]).toBeLessThan(400);
    expect(samples).toEqual([...samples].sort((left, right) => left - right)); // 单调推进
    expect(scroller.scrollLeft).toBe(400); // 落在整页
  });

  it('keeps the instant jump without touch motion or under reduced motion', () => {
    const harness = makeScheduler();
    const desktop = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    expect(
      advancePagedScroller(desktop, 1, 400, {
        touchPrimary: false,
        reducedMotion: false,
        scheduler: harness.scheduler,
      }),
    ).toBe(true);
    expect(desktop.scrollLeft).toBe(400);
    const reduced = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    expect(
      advancePagedScroller(reduced, 1, 400, {
        touchPrimary: true,
        reducedMotion: true,
        scheduler: harness.scheduler,
      }),
    ).toBe(true);
    expect(reduced.scrollLeft).toBe(400);
    expect(harness.cancelled).toEqual([]); // 无 rAF 调度（均为直接赋值）
  });

  it('retargets from the current offset when a second turn interrupts the slide', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 2400, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    clock.advance(50);
    harness.run();
    const mid = scroller.scrollLeft;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(400);
    // 快速连翻：从「在飞目标」再进一页，而非从中间位置四舍五入。
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    expect(harness.cancelled.length).toBeGreaterThan(0); // 在飞帧被取消
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(800);
  });

  it('snap during a flight keeps the pending page instead of reverting mid-slide', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    advancePagedScroller(scroller, 1, 400, motion);
    clock.advance(25);
    harness.run();
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    // advanceFlowPage 翻页后紧跟 snap：不得把在飞翻页拉回起始页。
    snapPagedScroller(scroller, 400, motion);
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(400);
  });

  it('animates the settle landing on touch and keeps the chapter-edge verdict', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const motion = touchMotion(harness.scheduler, clock.now);
    const scroller = { scrollLeft: 160, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(scroller, 0, -160, 400, motion)).toBe(true);
    expect(scroller.scrollLeft).toBe(160); // 未瞬跳
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(400);
    // 章缘交回调切章的返回值语义不变。
    const edge = { scrollLeft: 1200, scrollWidth: 1600, clientWidth: 400 };
    expect(settlePagedRelease(edge, 1200, -80, 400, motion)).toBe(false);
    expect(edge.scrollLeft).toBe(1200);
  });

  it('aborts the flight when an external write takes over the scroller', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    advancePagedScroller(scroller, 1, 400, motion);
    clock.advance(25);
    harness.run();
    scroller.scrollLeft = 999; // 原生拖动/直接赋值接管
    clock.advance(100);
    harness.run();
    expect(scroller.scrollLeft).toBe(999); // rAF 不再覆盖
  });

  it('aborts before the first frame when an external write lands immediately', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 2400, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    // 首帧前的外部写入也要被弃飞检测捕获（初始 lastWritten = from）。
    scroller.scrollLeft = 999;
    clock.advance(16);
    harness.run();
    expect(scroller.scrollLeft).toBe(999);
    // 弃飞清除在飞条目：再翻页从实际位置 999 起算，而非旧在飞目标 400。
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    for (let frame = 0; frame < 12; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(1399);
  });

  it('cancels the in-flight touch slide when a non-touch write retargets', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 2400, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    clock.advance(50);
    harness.run();
    expect(scroller.scrollLeft).toBeGreaterThan(0);
    expect(scroller.scrollLeft).toBeLessThan(400);
    // 触屏飞行中被非触屏 motion 写入（桌面/reduce 路径）：取消在飞并瞬跳新目标。
    expect(
      advancePagedScroller(scroller, 1, 400, {
        touchPrimary: false,
        reducedMotion: false,
      }),
    ).toBe(true);
    expect(harness.cancelled.length).toBeGreaterThan(0);
    expect(scroller.scrollLeft).toBe(800);
    // 已弃飞的旧帧不再推进。
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(800);
  });

  it('cancelPagedTouchSlide is idempotent and clears the pending target', () => {
    const clock = makeClock();
    const harness = makeScheduler();
    const scroller = { scrollLeft: 0, scrollWidth: 1600, clientWidth: 400 };
    const motion = touchMotion(harness.scheduler, clock.now);
    advancePagedScroller(scroller, 1, 400, motion);
    cancelPagedTouchSlide(scroller);
    cancelPagedTouchSlide(scroller);
    expect(harness.cancelled.length).toBe(1);
    // 取消后新写入从当前实际位置重新起算。
    expect(advancePagedScroller(scroller, 1, 400, motion)).toBe(true);
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(25);
      harness.run();
    }
    expect(scroller.scrollLeft).toBe(400);
  });

  it('uses a 200ms touch slide window', () => {
    expect(PAGED_TOUCH_SLIDE_MS).toBe(200);
  });
});

describe('reading nav keys', () => {
  it('maps arrows, page keys and space to a direction', () => {
    expect(isReadingNavKey('ArrowUp')).toBe(true);
    expect(isReadingNavKey('ArrowDown')).toBe(true);
    expect(readingNavDirection('ArrowRight')).toBe(1);
    expect(readingNavDirection('ArrowDown')).toBe(1);
    expect(readingNavDirection('ArrowLeft')).toBe(-1);
    expect(readingNavDirection('ArrowUp')).toBe(-1);
    expect(readingNavDirection(' ', true)).toBe(-1);
  });

  it('coalesces paged wheel turns', () => {
    const gate = createPagedWheelGate(1_000);
    const advance = (direction: 1 | -1): boolean => direction === 1;
    expect(gate(1, advance)).toBe(true);
    expect(gate(1, advance)).toBe(false);
  });

  it('keeps a trackpad burst as one page until the wheel stream goes idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = createPagedWheelGate(200);
    const advance = vi.fn(() => true);
    expect(gate(1, advance)).toBe(true);
    vi.setSystemTime(50);
    expect(gate(1, advance)).toBe(false);
    vi.setSystemTime(180);
    expect(gate(1, advance)).toBe(false);
    vi.setSystemTime(400);
    expect(gate(1, advance)).toBe(true);
    expect(advance).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('runs once after a resize burst settles', () => {
    vi.useFakeTimers();
    const settle = createResizeSettle(180);
    let count = 0;
    settle(() => {
      count += 1;
    });
    settle(() => {
      count += 1;
    });
    expect(count).toBe(0);
    vi.advanceTimersByTime(179);
    expect(count).toBe(0);
    vi.advanceTimersByTime(1);
    expect(count).toBe(1);
    vi.useRealTimers();
  });
});

describe('readingColumnLayout', () => {
  it('opens a second column on a typical desktop pane', () => {
    expect(readingColumnLayout(600, 16).columns).toBe(1);
    expect(readingColumnLayout(760, 16).columns).toBe(2);
    expect(readingColumnLayout(1400, 40).columns).toBe(1);
    expect(readingColumnLayout(2200, 16).columns).toBe(2);
  });

  it('opens two columns in a 1200–1400 CSS-pixel pane at the default measure', () => {
    expect(DEFAULT_READING_MEASURE_REM).toBe(22);
    expect(readingColumnLayout(1200, 16).columns).toBe(2);
    expect(readingColumnLayout(1400, 16).columns).toBe(2);
    expect(readingColumnLayout(700, 16).columns).toBe(1);
  });

  it('recomputes columns when the reading measure rem changes', () => {
    expect(readingColumnLayout(1300, 16, { minRem: DEFAULT_READING_MEASURE_REM }).columns).toBe(2);
    expect(readingColumnLayout(1300, 16, { minRem: 40 }).columns).toBe(1);
    expect(pagedSpreadMetrics(1300, 16, { minRem: 40 }).columns).toBe(1);
    expect(pagedSpreadMetrics(1300, 16, { minRem: DEFAULT_READING_MEASURE_REM }).columns).toBe(2);
  });

  it('caps column width at optRem so a wide pane keeps book-like gutters', () => {
    const layout = readingColumnLayout(1400, 16, { minRem: 22, optRem: 22 });
    expect(layout.columns).toBe(2);
    expect(layout.columnWidth).toBe(22 * 16);
    const spread = pagedSpreadMetrics(1400, 16, { minRem: 22, optRem: 22 });
    expect(spread.width).toBe(22 * 16 * 2 + spread.gap);
    expect(spread.width).toBeLessThan(1400);
  });
});

describe('applyReadingLayout', () => {
  it('stamps dataset and class on the root', () => {
    const classNames = new Set<string>();
    const root = {
      dataset: {} as DOMStringMap,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
    applyReadingLayout(root, 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(classNames.has('is-paginated')).toBe(true);
  });

  it('still stamps a non-document root that happens to sit in reader workspace', () => {
    const classNames = new Set<string>();
    const root = {
      dataset: { workspaceMode: 'reader' } as DOMStringMap,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
    applyReadingLayout(root, 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(classNames.has('is-paginated')).toBe(true);
  });
});

describe('nearestVisibleSlot', () => {
  it('picks the slot top nearest the viewport top', () => {
    expect(nearestVisibleSlot([640, 0, 220], 100)).toBe(1);
    expect(nearestVisibleSlot([0, 220, 640], 500)).toBe(2);
    expect(nearestVisibleSlot([0, 220, 640], 0)).toBe(0);
  });

  it('keeps the earlier slot on ties and returns -1 when empty', () => {
    expect(nearestVisibleSlot([100, 300], 200)).toBe(0);
    expect(nearestVisibleSlot([], 0)).toBe(-1);
  });

  it('maps a sparse mounted window back to the spine index', () => {
    expect(
      nearestVisibleChapterIndex(
        [
          { index: 4, top: 0 },
          { index: 5, top: 800 },
          { index: 6, top: 1600 },
        ],
        820,
      ),
    ).toBe(5);
  });

  it('keeps the covering chapter even when a spacer top is closer to the viewport', () => {
    expect(
      chapterIndexAtViewportTop(
        [
          { index: 96, top: -2400, bottom: -400 },
          { index: 97, top: -400, bottom: 400 },
        ],
        0,
      ),
    ).toBe(97);
    expect(
      chapterIndexAtViewportTop(
        [
          { index: 94, top: -800, bottom: -20 },
          { index: 95, top: 40, bottom: 840 },
        ],
        0,
      ),
    ).toBe(95);
  });
});

describe('viewportAnchor', () => {
  const slots = [
    { left: 200, top: 0, width: 400, height: 200 },
    { left: 200, top: 220, width: 400, height: 400 },
    { left: 200, top: 640, width: 400, height: 400 },
  ];

  it('anchors on the slot under the viewport center', () => {
    expect(viewportAnchor({ left: 0, top: 100, width: 800, height: 600 }, slots)).toEqual({
      index: 1,
      xRatio: 0.5,
      yRatio: 0.45,
    });
  });

  it('falls back to the nearest slot midpoint outside any slot', () => {
    const anchor = viewportAnchor({ left: 0, top: 0, width: 200, height: 100 }, slots);
    expect(anchor.index).toBe(0);
    // Center left of/above the slot yields ratios outside [0,1] by design
    // (same math as the PDF reader), so the offset math can compensate.
    expect(anchor.xRatio).toBe(-0.25);
    expect(anchor.yRatio).toBe(0.25);
  });

  it('returns a centered anchor for empty or degenerate slots', () => {
    expect(viewportAnchor({ left: 0, top: 0, width: 800, height: 600 }, [], 3)).toEqual({
      index: 0,
      xRatio: 0.5,
      yRatio: 0.5,
    });
    const flat = [{ left: 0, top: 0, width: 0, height: 0 }];
    expect(viewportAnchor({ left: 0, top: 0, width: 800, height: 600 }, flat)).toEqual({
      index: 0,
      xRatio: 0.5,
      yRatio: 0.5,
    });
  });
});

describe('scrollToKeepViewportAnchor', () => {
  it('keeps the captured point under the viewport center after a zoom', () => {
    const next = scrollToKeepViewportAnchor(
      { scrollLeft: 0, scrollTop: 400, clientWidth: 800, clientHeight: 600 },
      { left: 100, top: 50, width: 600, height: 800 },
      { index: 0, xRatio: 0.5, yRatio: 0.25 },
    );
    expect(next.scrollLeft).toBe(0);
    expect(next.scrollTop).toBe(350);
  });

  it('never scrolls before the origin', () => {
    const next = scrollToKeepViewportAnchor(
      { scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600 },
      { left: 0, top: 0, width: 100, height: 100 },
      { index: 0, xRatio: 0, yRatio: 0 },
    );
    expect(next.scrollLeft).toBe(0);
    expect(next.scrollTop).toBe(0);
  });
});

describe('createCoalescedScrollHandler', () => {
  it('runs one frame callback per scheduled frame regardless of burst size', () => {
    const frames: Array<() => void> = [];
    let count = 0;
    let handle = 0;
    const cancelled: number[] = [];
    const handler = createCoalescedScrollHandler(
      () => {
        count += 1;
      },
      {
        request: (callback) => {
          handle += 1;
          frames.push(callback);
          return handle;
        },
        cancel: (h) => {
          cancelled.push(h);
        },
      },
    );
    handler.schedule();
    handler.schedule();
    handler.schedule();
    expect(count).toBe(0);
    expect(frames.length).toBe(1); // merged into a single frame request
    frames[0]!();
    expect(count).toBe(1);
    // After the frame ran, a new event schedules a new frame.
    handler.schedule();
    expect(frames.length).toBe(2);
    frames[1]!();
    expect(count).toBe(2);
    expect(cancelled).toEqual([]);
  });

  it('cancel drops the pending frame and stops the callback', () => {
    const frames: Array<() => void> = [];
    const cancelled: number[] = [];
    let count = 0;
    const handler = createCoalescedScrollHandler(
      () => {
        count += 1;
      },
      {
        request: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancel: (h) => {
          cancelled.push(h);
        },
      },
    );
    handler.schedule();
    handler.cancel();
    expect(cancelled).toEqual([1]);
    frames[0]!(); // stale frame must not fire the merged callback again
    expect(count).toBe(0);
    handler.cancel();
    expect(cancelled).toEqual([1]); // nothing pending the second time
  });

  it('rafFrameScheduler wraps the ambient rAF when available', () => {
    const scheduler = rafFrameScheduler();
    if (scheduler === null) {
      return; // environment without rAF (defensive; jsdom/happy-dom provide it)
    }
    let ran = false;
    const h = scheduler.request(() => {
      ran = true;
    });
    expect(typeof h).toBe('number');
    scheduler.cancel(h); // must not throw
    expect(ran).toBe(false);
  });
});
