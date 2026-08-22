// @vitest-environment jsdom

/**
 * touch/long-press — 长按手势：~500ms 触发、移动阈值互斥、点按互斥、
 * 触发后吞掉紧随的合成 click 与原生 contextmenu。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindLongPress } from '../touch/long-press.js';

function touchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = point === null ? [] : [point];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
  Object.defineProperty(event, 'changedTouches', { value: points });
  return event;
}

function mount(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('bindLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('fires after ~500ms with the touchstart coordinates', () => {
    const el = mount();
    const onLongPress = vi.fn();
    bindLongPress(el, { onLongPress });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 24, clientY: 40 }));
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith({ x: 24, y: 40 });
  });

  it('cancels when the touch moves beyond the threshold', () => {
    const el = mount();
    const onLongPress = vi.fn();
    bindLongPress(el, { onLongPress });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    el.dispatchEvent(touchEvent('touchmove', { clientX: 21, clientY: 10 }));
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('stays armed within the movement threshold', () => {
    const el = mount();
    const onLongPress = vi.fn();
    bindLongPress(el, { onLongPress });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    el.dispatchEvent(touchEvent('touchmove', { clientX: 18, clientY: 16 }));
    vi.advanceTimersByTime(600);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels on an early touchend (plain tap does not fire)', () => {
    const el = mount();
    const onLongPress = vi.fn();
    bindLongPress(el, { onLongPress });
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(200);
    el.dispatchEvent(touchEvent('touchend', null));
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores multi-touch gestures', () => {
    const el = mount();
    const onLongPress = vi.fn();
    bindLongPress(el, { onLongPress });
    const event = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: [
        { clientX: 1, clientY: 1 },
        { clientX: 2, clientY: 2 },
      ],
    });
    el.dispatchEvent(event);
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('suppresses the trailing click and native contextmenu after firing', () => {
    const el = mount();
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const onContextMenu = vi.fn();
    // 先绑长按（捕获 swallow 先注册），后绑业务监听（与生产绑定顺序一致）。
    bindLongPress(el, { onLongPress });
    el.addEventListener('click', onClick);
    el.addEventListener('contextmenu', onContextMenu);
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(500);
    el.dispatchEvent(touchEvent('touchend', null));
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not swallow a later normal tap after the reset window', () => {
    const el = mount();
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    bindLongPress(el, { onLongPress });
    el.addEventListener('click', onClick);
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(500);
    el.dispatchEvent(touchEvent('touchend', null));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // 超过兜底复位窗口后，下一次普通点按不受影响。
    vi.advanceTimersByTime(500);
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    el.dispatchEvent(touchEvent('touchend', null));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('stops firing after unbind', () => {
    const el = mount();
    const onLongPress = vi.fn();
    const unbind = bindLongPress(el, { onLongPress });
    unbind();
    el.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
