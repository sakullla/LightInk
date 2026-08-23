// @vitest-environment jsdom

/**
 * touch/reader-touch — 阅读器触控翻页：点按左右热区（触屏注入非对称：左 20%
 * 上一页、右 30% 下一页、中部留给控件切换；缺省保持桌面对称 25%/25%）/横向
 * 滑动的纯判定，以及 bindTouchPaging 的事件流（系统外缘 24px 排除带与带内
 * 合成 click 吞掉、门控、click 抑制、解绑）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindClickPaging,
  bindTouchPaging,
  resolveSwipePageDirection,
  resolveTapPageDirection,
  TOUCH_BAND_CLICK_SUPPRESS_MS,
  TOUCH_SYSTEM_EDGE_PX,
  TOUCH_TAP_EDGE_RATIO,
  TOUCH_TAP_NEXT_RATIO,
  TOUCH_TAP_PREV_RATIO,
} from '../touch/reader-touch.js';

describe('touch paging constants', () => {
  it('exposes the desktop/touch tap ratios and the system edge band width', () => {
    expect(TOUCH_TAP_EDGE_RATIO).toBe(0.25);
    expect(TOUCH_TAP_PREV_RATIO).toBe(0.2);
    expect(TOUCH_TAP_NEXT_RATIO).toBe(0.3);
    expect(TOUCH_SYSTEM_EDGE_PX).toBe(24);
    expect(TOUCH_BAND_CLICK_SUPPRESS_MS).toBe(400);
  });
});

describe('resolveTapPageDirection', () => {
  it('defaults to the symmetric desktop zones (25%/25%) when no ratios are passed', () => {
    expect(resolveTapPageDirection(10, 400)).toBe(-1);
    expect(resolveTapPageDirection(390, 400)).toBe(1);
    expect(resolveTapPageDirection(200, 400)).toBeNull();
    // 桌面 click 热区边界锁定：400 * 0.25 = 100 / 400 * 0.75 = 300。
    expect(resolveTapPageDirection(100, 400)).toBe(-1);
    expect(resolveTapPageDirection(101, 400)).toBeNull();
    expect(resolveTapPageDirection(299, 400)).toBeNull();
    expect(resolveTapPageDirection(300, 400)).toBe(1);
  });

  it('supports independent prev/next ratios (left 20% / right 30%)', () => {
    const prev = TOUCH_TAP_PREV_RATIO;
    const next = TOUCH_TAP_NEXT_RATIO;
    // 400px 视口：左热区 [0, 80]，右热区 [280, 400]，中部 (80, 280) 留给控件。
    expect(resolveTapPageDirection(80, 400, prev, next)).toBe(-1);
    expect(resolveTapPageDirection(81, 400, prev, next)).toBeNull();
    expect(resolveTapPageDirection(279, 400, prev, next)).toBeNull();
    expect(resolveTapPageDirection(280, 400, prev, next)).toBe(1);
    expect(resolveTapPageDirection(100, 400, prev, next)).toBeNull();
    expect(resolveTapPageDirection(300, 400, prev, next)).toBe(1);
  });

  it('falls back to the symmetric desktop ratio for whichever side is omitted', () => {
    // 只传 prevRatio：右侧回落对称 TOUCH_TAP_EDGE_RATIO=0.25（阈值 300）。
    expect(resolveTapPageDirection(80, 400, 0.2)).toBe(-1);
    expect(resolveTapPageDirection(299, 400, 0.2)).toBeNull();
    expect(resolveTapPageDirection(300, 400, 0.2)).toBe(1);
    expect(resolveTapPageDirection(200, 400, 0.2)).toBeNull();
  });

  it('rejects invalid geometry', () => {
    expect(resolveTapPageDirection(10, 0)).toBeNull();
    expect(resolveTapPageDirection(10, -400)).toBeNull();
    expect(resolveTapPageDirection(Number.NaN, 400)).toBeNull();
  });
});

describe('resolveSwipePageDirection', () => {
  it('left swipe pages forward, right swipe pages back', () => {
    expect(resolveSwipePageDirection(-120, 10)).toBe(1);
    expect(resolveSwipePageDirection(120, -10)).toBe(-1);
  });

  it('ignores vertical-dominant or short movement', () => {
    expect(resolveSwipePageDirection(-30, 0)).toBeNull();
    expect(resolveSwipePageDirection(-60, 80)).toBeNull();
    expect(resolveSwipePageDirection(0, -120)).toBeNull();
  });
});

function touchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = point === null ? [] : [point];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
  Object.defineProperty(event, 'changedTouches', { value: points });
  return event;
}

describe('bindTouchPaging', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount(
    overrides: {
      enabled?: () => boolean;
      now?: () => number;
      tapPrevRatio?: number;
      tapNextRatio?: number;
    } = {},
  ) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const page = vi.fn<(direction: 1 | -1) => boolean>(() => true);
    const unbind = bindTouchPaging(el, {
      page,
      viewportWidth: () => 400,
      ...overrides,
    });
    return { el, page, unbind };
  }

  it('pages on a quick right-zone tap and suppresses the trailing click', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 340, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 340, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).toHaveBeenCalledWith(1);
    expect(end.defaultPrevented).toBe(true);
  });

  it('pages back on a quick left-zone tap', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 40, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 40, clientY: 200 }));
    expect(page).toHaveBeenCalledWith(-1);
  });

  it('does not page a tap starting inside the left system edge band', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 12, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 12, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(false);
  });

  it('does not page a tap starting inside the right system edge band', () => {
    // viewportWidth=400，右侧排除带为 [376, 400]。
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 390, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(false);
  });

  it('does not page a swipe starting inside the system edge band', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 380, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 150, clientY: 210 }));
    expect(page).not.toHaveBeenCalled();
  });

  it('swallows the synthetic click that follows a band-start tap, once', () => {
    // 带内点按不 preventDefault（把手势留给系统），浏览器随后仍会派发合成
    // click；无排除带的 click 路径（bindClickPaging）不能因此翻页。
    const { el, page } = mount();
    const clickPage = vi.fn<(direction: 1 | -1) => boolean>(() => true);
    bindClickPaging(el, { page: clickPage, viewportWidth: () => 400 });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    const synthetic = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 200 });
    el.dispatchEvent(synthetic);
    expect(page).not.toHaveBeenCalled();
    expect(clickPage).not.toHaveBeenCalled();
    expect(synthetic.defaultPrevented).toBe(true);
    // 一次性：吞掉后随后的独立 click（如桌面鼠标）照常翻页。
    const later = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 200 });
    el.dispatchEvent(later);
    expect(clickPage).toHaveBeenCalledWith(1);
  });

  it('disarms the band click swallow after a short timeout when no click follows', () => {
    vi.useFakeTimers();
    try {
      const { el } = mount();
      const clickPage = vi.fn<(direction: 1 | -1) => boolean>(() => true);
      bindClickPaging(el, { page: clickPage, viewportWidth: () => 400 });
      el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
      el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
      vi.advanceTimersByTime(TOUCH_BAND_CLICK_SUPPRESS_MS);
      const later = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 390,
        clientY: 200,
      });
      el.dispatchEvent(later);
      expect(clickPage).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the band click swallow when the next gesture starts outside the band', () => {
    const { el, page } = mount();
    const clickPage = vi.fn<(direction: 1 | -1) => boolean>(() => true);
    bindClickPaging(el, { page: clickPage, viewportWidth: () => 400 });
    // 带内起始武装了吞 click，但没有 click 跟来（系统接管手势）……
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    // ……下一个带外中部点按解除武装：它自己的合成 click 正常走 chrome 留路。
    el.dispatchEvent(touchEvent('touchstart', { clientX: 200, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 200, clientY: 200 }));
    const centerClick = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
    el.dispatchEvent(centerClick);
    expect(page).not.toHaveBeenCalled();
    expect(clickPage).not.toHaveBeenCalled();
    expect(centerClick.defaultPrevented).toBe(false);
  });

  it('still pages a swipe that starts outside the band and ends inside it', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 300, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 10, clientY: 205 }));
    expect(page).toHaveBeenCalledWith(1);
  });

  it('honors injected asymmetric tap ratios at the binding level', () => {
    // prev 0.1（阈值 40）/ next 0.45（阈值 220）：60 不再翻上一页，230 翻下一页。
    const { el, page } = mount({ tapPrevRatio: 0.1, tapNextRatio: 0.45 });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 60, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 60, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 230, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 230, clientY: 200 }));
    expect(page).toHaveBeenCalledWith(1);
  });

  it('does not page on a center tap (existing click path preserved)', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 200, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 200, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(false);
  });

  it('pages on a horizontal swipe', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 300, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 120, clientY: 210 }));
    expect(page).toHaveBeenCalledWith(1);
  });

  it('ignores a slow press (long-press / selection gesture)', () => {
    let now = 1000;
    const { el, page } = mount({ now: () => now });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 340, clientY: 200 }));
    now += 800;
    const end = touchEvent('touchend', { clientX: 340, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(false);
  });

  it('respects the enabled gate (scroll layout stays untouched)', () => {
    const { el, page } = mount({ enabled: () => false });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 340, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 340, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });

  it('ignores multi-touch gestures', () => {
    const { el, page } = mount();
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', {
      value: [
        { clientX: 340, clientY: 200 },
        { clientX: 100, clientY: 100 },
      ],
    });
    el.dispatchEvent(start);
    el.dispatchEvent(touchEvent('touchend', { clientX: 340, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });

  it('does not suppress the click when the page cannot turn', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const page = vi.fn(() => false);
    bindTouchPaging(el, { page, viewportWidth: () => 400 });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 340, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 340, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).toHaveBeenCalledWith(1);
    expect(end.defaultPrevented).toBe(false);
  });

  it('stops paging and releases the band click swallow after unbind', () => {
    const { el, page, unbind } = mount();
    // 先武装带内吞 click，再解绑：捕获监听器必须一并移除。
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    unbind();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 340, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 340, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 200 });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});

describe('bindClickPaging', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount(overrides: { enabled?: () => boolean } = {}) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const page = vi.fn<(direction: 1 | -1) => boolean>(() => true);
    const unbind = bindClickPaging(el, {
      page,
      viewportWidth: () => 400,
      ...overrides,
    });
    return { el, page, unbind };
  }

  it('pages on a right-edge mouse click (touch edge band does not apply) and stops the event from toggling chrome', () => {
    const { el, page } = mount();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 200 });
    el.dispatchEvent(event);
    expect(page).toHaveBeenCalledWith(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('pages back on a left-edge mouse click', () => {
    const { el, page } = mount();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 12, clientY: 200 }));
    expect(page).toHaveBeenCalledWith(-1);
  });

  it('does not page on a center click so chrome can still toggle', () => {
    const { el, page } = mount();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
    el.dispatchEvent(event);
    expect(page).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('respects the enabled gate', () => {
    const { el, page } = mount({ enabled: () => false });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });
});
