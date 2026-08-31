// @vitest-environment jsdom

/**
 * pdf-drag-pan — PDF 放大后的指针拖拽平移。
 *
 * 覆盖：横向溢出判定、触屏环境门控、拖拽回写 scrollLeft/Top、点按（slop 内）
 * 不平移且不吞 click、拖完吞一次合成 click、pointercancel 不布防吞点击、
 * sync 随溢出增减切 touch-action、release 还原宿主状态。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bindPdfDragPan, PDF_PAN_SLOP_PX, pdfPanOverflow } from '../pdf-drag-pan.js';

function makeScroller(options?: { scrollWidth?: number; clientWidth?: number }): HTMLElement {
  const el = document.createElement('div');
  let scrollWidth = options?.scrollWidth ?? 800;
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    get: () => scrollWidth,
    set: (value: number) => {
      scrollWidth = value;
    },
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: options?.clientWidth ?? 400,
  });
  document.body.appendChild(el);
  return el;
}

function pointerEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number; button?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
  });
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('pdfPanOverflow', () => {
  it('detects horizontal overflow with a 1px rounding allowance', () => {
    expect(pdfPanOverflow({ scrollWidth: 800, clientWidth: 400 })).toBe(true);
    expect(pdfPanOverflow({ scrollWidth: 401, clientWidth: 400 })).toBe(false);
    expect(pdfPanOverflow({ scrollWidth: 400, clientWidth: 400 })).toBe(false);
  });
});

describe('bindPdfDragPan', () => {
  it('is a no-op outside touch-primary environments', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: false });
    expect(el.getAttribute('data-pdf-pan')).toBeNull();
    expect(el.style.touchAction).toBe('');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 100 }));
    expect(el.scrollLeft).toBe(0);
    handle.release();
  });

  it('marks the host and disables native gestures while overflowing', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.getAttribute('data-pdf-pan')).toBe('true');
    expect(el.style.touchAction).toBe('none');
    handle.release();
    expect(el.getAttribute('data-pdf-pan')).toBeNull();
    expect(el.style.touchAction).toBe('');
  });

  it('pans both axes by writing scrollLeft/scrollTop during a drag', () => {
    const el = makeScroller();
    el.scrollLeft = 50;
    el.scrollTop = 200;
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 130 }));
    // 手指左移 40 → 内容右移（scrollLeft +40）；下移 30 → scrollTop -30。
    expect(el.scrollLeft).toBe(90);
    expect(el.scrollTop).toBe(170);
    expect(el.getAttribute('data-pdf-panning')).toBe('true');
    el.dispatchEvent(pointerEvent('pointerup', { clientX: 60, clientY: 130 }));
    expect(el.getAttribute('data-pdf-panning')).toBeNull();
    handle.release();
  });

  it('leaves taps within the slop to the click path', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(
      pointerEvent('pointermove', { clientX: 100 + PDF_PAN_SLOP_PX - 1, clientY: 100 }),
    );
    expect(el.scrollLeft).toBe(0);
    el.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    handle.release();
  });

  it('swallows the synthetic click after a pan, once', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointerup', { clientX: 30, clientY: 100 }));
    const first = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    handle.release();
  });

  it('does not arm the click swallow on pointercancel', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointercancel', { clientX: 30, clientY: 100 }));
    expect(el.getAttribute('data-pdf-panning')).toBeNull();
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    handle.release();
  });

  it('ignores drags while the page fits the viewport and re-enables after sync', () => {
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.style.touchAction).toBe('');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.scrollLeft).toBe(0);
    // 放大后出现横向溢出 → sync 重新启用。
    (el as unknown as { scrollWidth: number }).scrollWidth = 800;
    handle.sync();
    expect(el.style.touchAction).toBe('none');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.scrollLeft).toBe(70);
    handle.release();
  });

  it('ignores non-primary buttons', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 2 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.scrollLeft).toBe(0);
    handle.release();
  });

  it('disables text selection only while a pan is active', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.style.userSelect).toBe('none');
    el.dispatchEvent(pointerEvent('pointerup', { clientX: 30, clientY: 100 }));
    expect(el.style.userSelect).toBe('');
    handle.release();
  });
});
