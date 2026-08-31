// @vitest-environment jsdom

/**
 * touch/long-press — 长按手势：~500ms 触发、移动阈值互斥、点按互斥、
 * 触发后吞掉紧随的合成 click 与原生 contextmenu。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindLongPress } from '../touch/long-press.js';
import {
  bindSheetDrag,
  SHEET_DRAG_FLICK_PX_PER_MS,
  SHEET_DRAG_SNAP_BACK_MS,
  SHEET_DRAG_THRESHOLD_PX,
} from '../touch/sheet-drag.js';
import { concealSheet, revealSheet, SHEET_TRANSITION_FALLBACK_MS } from '../touch/sheet-transition.js';

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
    const onPressStart = vi.fn();
    const onPressCancel = vi.fn();
    bindLongPress(el, { onLongPress, onPressStart, onPressCancel });
    const start = touchEvent('touchstart', { clientX: 10, clientY: 10 });
    el.dispatchEvent(start);
    expect(onPressStart).toHaveBeenCalledTimes(1);
    // 多指合拢：计时取消的同时按住反馈也收掉（T3-A2 FB9），不悬挂 .is-pressing。
    const multi = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(multi, 'touches', {
      value: [
        { clientX: 1, clientY: 1 },
        { clientX: 2, clientY: 2 },
      ],
    });
    el.dispatchEvent(multi);
    expect(onPressCancel).toHaveBeenCalledTimes(1);
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

function sheetPointerEvent(
  type: string,
  point: { clientX: number; clientY: number },
  extra: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerId: 1,
    pointerType: 'touch',
    clientX: point.clientX,
    clientY: point.clientY,
    ...extra,
  });
}

function sheetTouchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = point === null ? [] : [point];
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : points,
  });
  Object.defineProperty(event, 'changedTouches', { value: points });
  return event;
}

function mountSheet(): { handle: HTMLElement; sheet: HTMLElement } {
  const sheet = document.createElement('div');
  const handle = document.createElement('button');
  sheet.appendChild(handle);
  document.body.appendChild(sheet);
  if (typeof handle.setPointerCapture !== 'function') {
    Object.defineProperty(handle, 'setPointerCapture', { value: () => undefined, configurable: true });
  }
  if (typeof handle.releasePointerCapture !== 'function') {
    Object.defineProperty(handle, 'releasePointerCapture', {
      value: () => undefined,
      configurable: true,
    });
  }
  return { handle, sheet };
}

describe('bindSheetDrag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('translates the sheet downward while the handle is dragged', () => {
    const { handle, sheet } = mountSheet();
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 48 }));
    expect(sheet.style.transform).toBe('translateY(38px)');
  });

  it('does not translate upward; only downward drag follows', () => {
    const { handle, sheet } = mountSheet();
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 40 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 8 }));
    expect(sheet.style.transform).toBe('');
  });

  it('closes past the default threshold on pointer release', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(
      sheetPointerEvent('pointermove', { clientX: 20, clientY: 10 + SHEET_DRAG_THRESHOLD_PX }),
    );
    handle.dispatchEvent(
      sheetPointerEvent('pointerup', { clientX: 20, clientY: 10 + SHEET_DRAG_THRESHOLD_PX }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back below the threshold and does not close', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 50 }));
    expect(sheet.style.transform).toBe('translateY(40px)');
    vi.setSystemTime(1_400);
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 50 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('snapBack 生命周期：释放后内联回弹存在，伪 timer 推进后清理收尾（FB6）', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 50 }));
    // 释放后：回弹靠自己的内联 transition（200ms transform），transform 已回基线。
    vi.setSystemTime(1_400);
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 50 }));
    expect(sheet.style.transition).toBe(`transform ${SHEET_DRAG_SNAP_BACK_MS}ms ease`);
    expect(sheet.style.transform).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    // 推进到兜底收尾（200ms + 40ms）：内联 transition 清理、监听/取消句柄移除。
    vi.advanceTimersByTime(SHEET_DRAG_SNAP_BACK_MS + 40);
    expect(sheet.style.transition).toBe('');
    expect(sheet.style.transform).toBe('');
  });

  it('回弹进行中重拖：取消在途回弹，旧收尾不清掉新拖拽状态（FB6）', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 40 }));
    vi.setSystemTime(1_400);
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 40 }));
    expect(sheet.style.transition).toBe(`transform ${SHEET_DRAG_SNAP_BACK_MS}ms ease`);
    // 回弹未收尾时再按下：beginDrag 取消回弹并压回 transition:none。
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 12 }));
    expect(sheet.style.transition).toBe('none');
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 44 }));
    expect(sheet.style.transform).toBe('translateY(32px)');
    // 推进旧回弹的兜底窗口：不得把新拖拽的位移/transition 清掉。
    vi.advanceTimersByTime(SHEET_DRAG_SNAP_BACK_MS * 3);
    expect(sheet.style.transition).toBe('none');
    expect(sheet.style.transform).toBe('translateY(32px)');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('拖拽开始作废在途 sheet 过渡：退场窗口内抓住把手不被兜底 timer 置 hidden（FB5）', () => {
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () => ({ transitionDuration: '0.22s' }) as CSSStyleDeclaration,
    );
    const { handle, sheet } = mountSheet();
    const unbind = bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    sheet.hidden = false;
    revealSheet(sheet);
    const settle = vi.fn(() => {
      sheet.hidden = true;
    });
    concealSheet(sheet, settle, sheet);
    expect(sheet.dataset.open).toBeUndefined();
    // 退场窗口内抓住把手：拖拽接管，在途 settle（含兜底 timer）作废。
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS * 2);
    expect(settle).not.toHaveBeenCalled();
    expect(sheet.hidden).toBe(false);
    unbind();
  });

  it('closes on a downward flick below the distance threshold', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    const flickDy = 24;
    const flickMs = Math.floor(flickDy / SHEET_DRAG_FLICK_PX_PER_MS) - 8;
    vi.setSystemTime(1_000 + flickMs);
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 10 + flickDy }));
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 10 + flickDy }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honors a custom thresholdPx', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 30 });
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    vi.setSystemTime(1_400);
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 40 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from touch events the same way as pointer events', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 40 });
    handle.dispatchEvent(sheetTouchEvent('touchstart', { clientX: 16, clientY: 8 }));
    handle.dispatchEvent(sheetTouchEvent('touchmove', { clientX: 16, clientY: 60 }));
    expect(sheet.style.transform).toBe('translateY(52px)');
    handle.dispatchEvent(sheetTouchEvent('touchend', { clientX: 16, clientY: 60 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back on a short touch drag', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(sheetTouchEvent('touchstart', { clientX: 16, clientY: 8 }));
    handle.dispatchEvent(sheetTouchEvent('touchmove', { clientX: 16, clientY: 20 }));
    vi.setSystemTime(1_400);
    handle.dispatchEvent(sheetTouchEvent('touchend', { clientX: 16, clientY: 20 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('does not create a handle or decorative bar', () => {
    const { handle, sheet } = mountSheet();
    const before = sheet.childElementCount;
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    expect(sheet.childElementCount).toBe(before);
    expect(sheet.querySelector('[data-sheet-drag-handle]')).toBeNull();
    expect(handle.childElementCount).toBe(0);
  });

  it('stops closing after unbind', () => {
    const { handle, sheet } = mountSheet();
    const onClose = vi.fn();
    const unbind = bindSheetDrag(handle, { sheet, onClose, thresholdPx: 20 });
    unbind();
    handle.dispatchEvent(sheetPointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(sheetPointerEvent('pointermove', { clientX: 20, clientY: 80 }));
    handle.dispatchEvent(sheetPointerEvent('pointerup', { clientX: 20, clientY: 80 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });
});
