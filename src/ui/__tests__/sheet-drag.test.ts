// @vitest-environment jsdom

/**
 * touch/sheet-drag — 把手下拖跟随、过阈值/快甩关闭、未过阈值弹回、解绑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindSheetDrag,
  SHEET_DRAG_FLICK_PX_PER_MS,
  SHEET_DRAG_THRESHOLD_PX,
} from '../touch/sheet-drag.js';

function pointerEvent(
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

function touchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = point === null ? [] : [point];
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : points,
  });
  Object.defineProperty(event, 'changedTouches', { value: points });
  return event;
}

function mount(): { handle: HTMLElement; sheet: HTMLElement } {
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
    document.body.replaceChildren();
  });

  it('translates the sheet downward while the handle is dragged', () => {
    const { handle, sheet } = mount();
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 48 }));
    expect(sheet.style.transform).toBe('translateY(38px)');
  });

  it('does not translate upward; only downward drag follows', () => {
    const { handle, sheet } = mount();
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 40 }));
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 8 }));
    expect(sheet.style.transform).toBe('');
  });

  it('closes past the default threshold on pointer release', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(
      pointerEvent('pointermove', { clientX: 20, clientY: 10 + SHEET_DRAG_THRESHOLD_PX }),
    );
    handle.dispatchEvent(
      pointerEvent('pointerup', { clientX: 20, clientY: 10 + SHEET_DRAG_THRESHOLD_PX }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back below the threshold and does not close', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 50 }));
    expect(sheet.style.transform).toBe('translateY(40px)');
    vi.setSystemTime(1_400);
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 50 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('closes on a downward flick below the distance threshold', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    const flickDy = 24;
    const flickMs = Math.floor(flickDy / SHEET_DRAG_FLICK_PX_PER_MS) - 8;
    vi.setSystemTime(1_000 + flickMs);
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 10 + flickDy }));
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 10 + flickDy }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('honors a custom thresholdPx', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 30 });
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    vi.setSystemTime(1_400);
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 40 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from touch events the same way as pointer events', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 40 });
    handle.dispatchEvent(touchEvent('touchstart', { clientX: 16, clientY: 8 }));
    handle.dispatchEvent(touchEvent('touchmove', { clientX: 16, clientY: 60 }));
    expect(sheet.style.transform).toBe('translateY(52px)');
    handle.dispatchEvent(touchEvent('touchend', { clientX: 16, clientY: 60 }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back on a short touch drag', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    bindSheetDrag(handle, { sheet, onClose, thresholdPx: 80 });
    handle.dispatchEvent(touchEvent('touchstart', { clientX: 16, clientY: 8 }));
    handle.dispatchEvent(touchEvent('touchmove', { clientX: 16, clientY: 20 }));
    vi.setSystemTime(1_400);
    handle.dispatchEvent(touchEvent('touchend', { clientX: 16, clientY: 20 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('does not create a handle or decorative bar', () => {
    const { handle, sheet } = mount();
    const before = sheet.childElementCount;
    bindSheetDrag(handle, { sheet, onClose: vi.fn() });
    expect(sheet.childElementCount).toBe(before);
    expect(sheet.querySelector('[data-sheet-drag-handle]')).toBeNull();
    expect(handle.childElementCount).toBe(0);
  });

  it('stops closing after unbind', () => {
    const { handle, sheet } = mount();
    const onClose = vi.fn();
    const unbind = bindSheetDrag(handle, { sheet, onClose, thresholdPx: 20 });
    unbind();
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: 10 }));
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 80 }));
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 80 }));
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });
});
