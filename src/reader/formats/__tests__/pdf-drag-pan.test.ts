// @vitest-environment jsdom

/**
 * pdf-drag-pan — PDF 放大后的指针拖拽平移与触屏手势纯函数。
 *
 * 覆盖：横向溢出判定（≤4px 亚像素容差，不锁原生双轴滚动）、触屏环境门控、
 * 拖拽回写 scrollLeft/Top、点按（slop 内）不平移且不吞 click、拖完吞一次
 * 合成 click、pointercancel 不布防吞点击、sync 随溢出增减切 touch-action、
 * release 还原宿主状态；纯函数：捏合指距比值 → 适宽×档位钳制 currentScale、
 * 双击窗口（280ms/36px）判定、缩放锚点滚动修正。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindPdfDragPan,
  PDF_DOUBLE_TAP_DISTANCE_PX,
  PDF_DOUBLE_TAP_MS,
  PDF_PAN_OVERFLOW_TOLERANCE_PX,
  PDF_PAN_SLOP_PX,
  pdfIsDoubleTap,
  pdfPanOverflow,
  pdfPinchScale,
  pdfZoomAnchorScroll,
} from '../pdf-drag-pan.js';

/** 与 pdf.ts PDF_SCALE_STEPS 同值的 userZoom 档位（函数参数化，避免反向 import）。 */
const SCALE_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

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
  it('treats overflow up to the 4px tolerance as sub-pixel noise', () => {
    expect(PDF_PAN_OVERFLOW_TOLERANCE_PX).toBe(4);
    expect(pdfPanOverflow({ scrollWidth: 402, clientWidth: 400 })).toBe(false);
    expect(pdfPanOverflow({ scrollWidth: 404, clientWidth: 400 })).toBe(false);
    expect(pdfPanOverflow({ scrollWidth: 400, clientWidth: 400 })).toBe(false);
  });

  it('flags overflow once it exceeds the tolerance', () => {
    expect(pdfPanOverflow({ scrollWidth: 405, clientWidth: 400 })).toBe(true);
    expect(pdfPanOverflow({ scrollWidth: 800, clientWidth: 400 })).toBe(true);
  });
});

describe('pdfPinchScale', () => {
  it('scales currentScale by the pointer-distance ratio', () => {
    expect(pdfPinchScale(1, 100, 150, 1, SCALE_STEPS)).toBeCloseTo(1.5);
    expect(pdfPinchScale(1.5, 150, 100, 1, SCALE_STEPS)).toBeCloseTo(1);
  });

  it('clamps to the top ladder bound relative to fit-width', () => {
    // 适宽 1：上限 1 × 3；5× 放大比钳到 3。
    expect(pdfPinchScale(1, 100, 500, 1, SCALE_STEPS)).toBe(3);
    // 适宽 2：上限 2 × 3 = 6，同一比例钳到 6。
    expect(pdfPinchScale(2, 100, 500, 2, SCALE_STEPS)).toBe(6);
  });

  it('clamps to the bottom ladder bound relative to fit-width', () => {
    expect(pdfPinchScale(1, 100, 10, 1, SCALE_STEPS)).toBe(0.5);
    expect(pdfPinchScale(2, 100, 10, 2, SCALE_STEPS)).toBe(1);
  });

  it('falls back to the clamped current/base scale on degenerate input', () => {
    // 指距拿不到有效值：currentScale 原样（只过钳制）返回。
    expect(pdfPinchScale(2.5, 0, 100, 1, SCALE_STEPS)).toBe(2.5);
    expect(pdfPinchScale(2.5, 100, Number.NaN, 1, SCALE_STEPS)).toBe(2.5);
    // currentScale 非法：退回适宽基准。
    expect(pdfPinchScale(Number.NaN, 100, 200, 2, SCALE_STEPS)).toBe(2);
    // 适宽非法：基准按 1 计。
    expect(pdfPinchScale(Number.NaN, 100, 200, 0, SCALE_STEPS)).toBe(1);
  });
});

describe('pdfIsDoubleTap', () => {
  it('accepts the second tap within 280ms / 36px (boundaries inclusive)', () => {
    expect(PDF_DOUBLE_TAP_MS).toBe(280);
    expect(PDF_DOUBLE_TAP_DISTANCE_PX).toBe(36);
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 0 }, { x: 128, y: 100, at: 280 })).toBe(true);
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 0 }, { x: 136, y: 100, at: 0 })).toBe(true);
    // 位移按欧氏距离：对角 24/24 ≈ 33.9px 仍在窗口内。
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 10 }, { x: 124, y: 124, at: 280 })).toBe(true);
  });

  it('rejects taps outside the window in time, distance or order', () => {
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 0 }, { x: 100, y: 100, at: 281 })).toBe(false);
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 0 }, { x: 137, y: 100, at: 0 })).toBe(false);
    // 30/30 对角 ≈ 42.4px：单轴都 <36 但欧氏距离超窗。
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 0 }, { x: 130, y: 130, at: 100 })).toBe(false);
    // 时钟倒挂（第二次早于第一次）不算双击。
    expect(pdfIsDoubleTap({ x: 100, y: 100, at: 100 }, { x: 100, y: 100, at: 99 })).toBe(false);
  });
});

describe('pdfZoomAnchorScroll', () => {
  it('keeps the content under the anchor stationary while zooming in', () => {
    // 视口 400 宽：scrollLeft 100、锚点在视口偏移 200，缩放 1×→2×。
    const anchor = pdfZoomAnchorScroll(100, 200, 200, 150, 2);
    expect(anchor.left).toBe(400);
    expect(anchor.top).toBe(550);
    // 锚点下的内容坐标（锚点偏移 + scroll，除以当轮 scale）缩放前后一致。
    const contentBeforeX = (200 + 100) / 1;
    const contentAfterX = (200 + anchor.left) / 2;
    expect(contentAfterX).toBe(contentBeforeX);
    const contentBeforeY = (150 + 200) / 1;
    const contentAfterY = (150 + anchor.top) / 2;
    expect(contentAfterY).toBe(contentBeforeY);
  });

  it('shrinks scroll offsets symmetrically while zooming out', () => {
    const anchor = pdfZoomAnchorScroll(300, 80, 100, 40, 0.5);
    expect(anchor.left).toBe(100);
    expect(anchor.top).toBe(20);
    const contentBeforeX = (100 + 300) / 1;
    const contentAfterX = (100 + anchor.left) / 0.5;
    expect(contentAfterX).toBe(contentBeforeX);
  });

  it('is the identity for ratio 1 and degenerate ratios', () => {
    expect(pdfZoomAnchorScroll(300, 80, 100, 40, 1)).toEqual({ left: 300, top: 80 });
    expect(pdfZoomAnchorScroll(300, 80, 100, 40, Number.NaN)).toEqual({ left: 300, top: 80 });
    expect(pdfZoomAnchorScroll(300, 80, 100, 40, 0)).toEqual({ left: 300, top: 80 });
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

  it('keeps native two-axis scrolling for overflow within the 4px tolerance', () => {
    const el = makeScroller({ scrollWidth: 404, clientWidth: 400 });
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.getAttribute('data-pdf-pan')).toBeNull();
    expect(el.style.touchAction).toBe('');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    // 不写 touch-action:none 也不指针平移，原生双轴滚动接管。
    expect(el.scrollLeft).toBe(0);
    handle.release();
  });

  it('locks gestures as soon as overflow passes the tolerance', () => {
    const el = makeScroller({ scrollWidth: 405, clientWidth: 400 });
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.getAttribute('data-pdf-pan')).toBe('true');
    expect(el.style.touchAction).toBe('none');
    handle.release();
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
