// @vitest-environment jsdom

/**
 * touch/reader-touch — 阅读器触控翻页：点按左右热区/横向滑动的纯判定，
 * 以及 bindTouchPaging 的事件流（门控、click 抑制、解绑）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindTouchPaging,
  resolveSwipePageDirection,
  resolveTapPageDirection,
} from '../touch/reader-touch.js';

describe('resolveTapPageDirection', () => {
  it('maps left/right edge zones to prev/next and the center to null', () => {
    expect(resolveTapPageDirection(10, 400)).toBe(-1);
    expect(resolveTapPageDirection(100, 400)).toBe(-1);
    expect(resolveTapPageDirection(300, 400)).toBe(1);
    expect(resolveTapPageDirection(390, 400)).toBe(1);
    expect(resolveTapPageDirection(200, 400)).toBeNull();
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

  function mount(overrides: { enabled?: () => boolean; now?: () => number } = {}) {
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

  it('pages on a quick right-edge tap and suppresses the trailing click', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 390, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).toHaveBeenCalledWith(1);
    expect(end.defaultPrevented).toBe(true);
  });

  it('pages back on a quick left-edge tap', () => {
    const { el, page } = mount();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 12, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 12, clientY: 200 }));
    expect(page).toHaveBeenCalledWith(-1);
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
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    now += 800;
    const end = touchEvent('touchend', { clientX: 390, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).not.toHaveBeenCalled();
    expect(end.defaultPrevented).toBe(false);
  });

  it('respects the enabled gate', () => {
    const { el, page } = mount({ enabled: () => false });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });

  it('ignores multi-touch gestures', () => {
    const { el, page } = mount();
    const start = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'touches', {
      value: [
        { clientX: 390, clientY: 200 },
        { clientX: 100, clientY: 100 },
      ],
    });
    el.dispatchEvent(start);
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });

  it('does not suppress the click when the page cannot turn', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const page = vi.fn(() => false);
    bindTouchPaging(el, { page, viewportWidth: () => 400 });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    const end = touchEvent('touchend', { clientX: 390, clientY: 200 });
    el.dispatchEvent(end);
    expect(page).toHaveBeenCalledWith(1);
    expect(end.defaultPrevented).toBe(false);
  });

  it('stops paging after unbind', () => {
    const { el, page, unbind } = mount();
    unbind();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 200 }));
    el.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 200 }));
    expect(page).not.toHaveBeenCalled();
  });
});
