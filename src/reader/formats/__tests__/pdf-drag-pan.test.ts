// @vitest-environment jsdom

/**
 * pdf-drag-pan — PDF 触屏滚动与捏合。
 *
 * 覆盖：横向溢出判定（≤4px 亚像素容差）、触屏环境门控、单指交给原生
 * pan-x pan-y、捏合 CSS 预览且松手才写 currentScale、双击适宽↔2×、
 * 窗口内单击暂扣、非触屏 no-op、捏合期 sync() 恒 none、重定基线不换对、
 * 松手早于 rAF 预览仍按末次两指中点锚定。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindPdfDragPan,
  type PdfScaleBinding,
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
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it('marks overflow but keeps native two-axis scrolling', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.getAttribute('data-pdf-pan')).toBe('true');
    expect(el.style.touchAction).toBe('pan-x pan-y');
    handle.release();
    expect(el.getAttribute('data-pdf-pan')).toBeNull();
    expect(el.style.touchAction).toBe('');
  });

  it('keeps native two-axis scrolling for overflow within the 4px tolerance', () => {
    const el = makeScroller({ scrollWidth: 404, clientWidth: 400 });
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.getAttribute('data-pdf-pan')).toBeNull();
    expect(el.style.touchAction).toBe('pan-x pan-y');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.scrollLeft).toBe(0);
    handle.release();
  });

  it('does not steal single-finger drags even after overflow appears', () => {
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    expect(el.style.touchAction).toBe('pan-x pan-y');
    (el as unknown as { scrollWidth: number }).scrollWidth = 800;
    handle.sync();
    expect(el.style.touchAction).toBe('pan-x pan-y');
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    expect(el.scrollLeft).toBe(0);
    handle.release();
  });

  it('leaves a single-finger tap on the click path', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(
      pointerEvent('pointermove', { clientX: 100 + PDF_PAN_SLOP_PX - 1, clientY: 100 }),
    );
    el.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 100 }));
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    handle.release();
  });

  it('does not arm the click swallow on pointercancel', () => {
    const el = makeScroller();
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { clientX: 30, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointercancel', { clientX: 30, clientY: 100 }));
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
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
});

/**
 * scale 绑定测试替身：记录写入、current 状态可读（真源在官方 viewer 侧）。
 * 复刻官方 currentScale setter 的同步重锚：#setScale(noScroll:false) →
 * _setScaleUpdatePages 以跟踪的 _location 调 scrollPageIntoView，把滚动口
 * 赋值回 pre × ratio——写入返回后 scrollLeft/Top 已是重锚值（pdfjs-dist
 * web/pdf_viewer.mjs 的 set currentScale 路径）。旧替身漏了这一步，锚定
 * 修正的过度应用（scroll 项乘两次 ratio）在 jsdom 里测不出来。
 */
function makeScaleBinding(
  scroller: HTMLElement,
  initial: { current: number; fit: number },
): {
  readonly binding: PdfScaleBinding;
  readonly setCurrentScale: ReturnType<typeof vi.fn>;
  current(): number;
} {
  let current = initial.current;
  const setCurrentScale = vi.fn((value: number): void => {
    // 内置重锚：滚动偏移同步按新/旧比例缩放（pre × ratio）。
    const ratio = value / current;
    scroller.scrollLeft = scroller.scrollLeft * ratio;
    scroller.scrollTop = scroller.scrollTop * ratio;
    current = value;
  });
  const binding: PdfScaleBinding = {
    getCurrentScale: (): number => current,
    setCurrentScale,
    getFitWidthScale: (): number => initial.fit,
    steps: SCALE_STEPS,
  };
  return { binding, setCurrentScale, current: (): number => current };
}

/** 手动帧队列：拦截 rAF，flush() 前手势层不产生任何写（rAF 合并可断言）。 */
function fakeFrames(): { flush(): void } {
  const queue: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback): number => {
      queue.push(callback);
      return queue.length;
    },
  );
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((): void => undefined);
  return {
    flush(): void {
      queue.splice(0).forEach((callback) => {
        callback(0);
      });
    },
  };
}

function readPreviewScale(el: HTMLElement): number | null {
  const matched = el.style.transform.match(/scale\(\s*([-\d.]+)\s*\)/);
  return matched === null ? null : Number.parseFloat(matched[1]!);
}

describe('bindPdfDragPan multi-pointer gestures', () => {
  it('does not write scroll or scale on a single finger when a binding is present', () => {
    const el = makeScroller();
    el.scrollLeft = 50;
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 100 }));
    expect(el.scrollLeft).toBe(50);
    expect(setCurrentScale).not.toHaveBeenCalled();
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 100 }));
    handle.release();
  });

  it('previews a pinch with CSS scale and commits currentScale only on release', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, setCurrentScale, current } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(el.style.touchAction).toBe('none');
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 75, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 225, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 70, clientY: 300 }));
    expect(setCurrentScale).not.toHaveBeenCalled();
    frames.flush();
    // 进行中：2.5 × 155/100 = 3.875 → CSS scale 3.875/2.5 = 1.55，不重栅格。
    expect(setCurrentScale).not.toHaveBeenCalled();
    expect(current()).toBe(2.5);
    expect(readPreviewScale(el)).toBeCloseTo(1.55);
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    expect(readPreviewScale(el)).toBeCloseTo(1.65);
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 60, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 225, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    expect(current()).toBeCloseTo(2.5 * 1.65);
    expect(el.style.transform).toBe('');
    expect(el.style.touchAction).toBe('pan-x pan-y');
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    handle.release();
  });

  it('previews the pinch on .pdfViewer when that child is present', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const viewer = document.createElement('div');
    viewer.className = 'pdfViewer';
    el.appendChild(viewer);
    const { binding, setCurrentScale, current } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 75, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 225, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    expect(readPreviewScale(el)).toBeNull();
    expect(readPreviewScale(viewer)).toBeCloseTo(1.5);
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 75, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 225, clientY: 300 }));
    expect(current()).toBeCloseTo(3.75);
    expect(viewer.style.transform).toBe('');
    handle.release();
  });

  it('applies the pinch anchor correction exactly once on release', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    el.scrollLeft = 5000;
    el.scrollTop = 1200;
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 95, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 215, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(5000);
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 95, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 215, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    const expected = pdfZoomAnchorScroll(5000, 1200, 155, 300, 3 / 2.5);
    expect(el.scrollLeft).toBeCloseTo(expected.left);
    expect(el.scrollTop).toBeCloseTo(expected.top);
    expect((155 + el.scrollLeft) / 3).toBeCloseTo((155 + 5000) / 2.5);
    expect((300 + el.scrollTop) / 3).toBeCloseTo((300 + 1200) / 2.5);
    handle.release();
  });

  it('anchors the commit at the last pinch midpoint when release beats the preview frame', () => {
    fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    el.scrollLeft = 5000;
    el.scrollTop = 1200;
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 95, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 215, clientY: 300 }));
    // 拦截 rAF 且不 flush：快速松手时预览从未跑，lastPinchAnchor 不得停在 (0, 0)。
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 95, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 215, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    const expected = pdfZoomAnchorScroll(5000, 1200, 155, 300, 3 / 2.5);
    expect(el.scrollLeft).toBeCloseTo(expected.left);
    expect(el.scrollTop).toBeCloseTo(expected.top);
    expect((155 + el.scrollLeft) / 3).toBeCloseTo((155 + 5000) / 2.5);
    expect((300 + el.scrollTop) / 3).toBeCloseTo((300 + 1200) / 2.5);
    handle.release();
  });

  it('does not start a JS pan when the pinch ends with one finger down', () => {
    const frames = fakeFrames();
    const el = makeScroller();
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    expect(el.style.touchAction).toBe('pan-x pan-y');
    const scrollAfterPinch = el.scrollLeft;
    setCurrentScale.mockClear();
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 300 }));
    expect(el.scrollLeft).toBe(scrollAfterPinch);
    expect(el.getAttribute('data-pdf-panning')).toBeNull();
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 30, clientY: 300 }));
    handle.release();
  });

  it('toggles between fit-width and 2x on double-tap, anchored at the tap point', () => {
    vi.useFakeTimers();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, current } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    const clicks: Array<{ x: number; y: number }> = [];
    el.addEventListener('click', (event) => {
      clicks.push({ x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY });
    });

    // 第一击：click 暂扣（窗口内不放行）。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 120, clientY: 260 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 120, clientY: 260 }));
    const first = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 120, clientY: 260 });
    el.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(clicks).toEqual([]);

    // 150ms 后第二击（位移 ≈4.5px < 36px）：双击 → 2× 档（2.5 → 5）。
    vi.advanceTimersByTime(150);
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 124, clientY: 262 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 124, clientY: 262 }));
    expect(current()).toBeCloseTo(5);
    // 锚定第二击位置：ratio = 5/2.5 = 2 → left = 124、top = 262。
    expect(el.scrollLeft).toBeCloseTo(124);
    expect(el.scrollTop).toBeCloseTo(262);
    // 第二击的 click 被吞；暂扣的第一击也不再放行。
    const second = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 124, clientY: 262 });
    el.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(400);
    expect(clicks).toEqual([]);

    // 再双击：从 2× 回适宽（2.5）。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 130, clientY: 270 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 130, clientY: 270 }));
    vi.advanceTimersByTime(150);
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 132, clientY: 272 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 132, clientY: 272 }));
    expect(current()).toBeCloseTo(2.5);
    handle.release();
  });

  it('applies the double-tap anchor correction exactly once from a non-zero reading offset', () => {
    vi.useFakeTimers();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    // 正常阅读态：缩放前滚动不为零（如已竖滚 5000px）。
    el.scrollLeft = 5000;
    el.scrollTop = 1200;
    const { binding, current } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });

    // 第一击：click 暂扣。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 300, clientY: 400 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 300, clientY: 400 }));
    const first = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 400,
    });
    el.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);

    // 150ms/≈2.8px 内第二击：双击 → 2× 档（2.5 → 5，ratio 2），锚定 (302, 402)。
    vi.advanceTimersByTime(150);
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 302, clientY: 402 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 302, clientY: 402 }));
    expect(current()).toBeCloseTo(5);
    // 官方 setter 的同步重锚（pre × 2）之上只能修正一次：最终值 =
    // pdfZoomAnchorScroll(写前偏移, 锚点, 2)。读写后值（10000/2400）再修正
    // 会得到 20302/5202——scroll 项乘两次 ratio，双击跳读位。
    const expected = pdfZoomAnchorScroll(5000, 1200, 302, 402, 2);
    expect(el.scrollLeft).toBeCloseTo(expected.left);
    expect(el.scrollTop).toBeCloseTo(expected.top);
    // 双击点下的内容坐标缩放前后不动。
    expect((302 + el.scrollLeft) / 5).toBeCloseTo((302 + 5000) / 2.5);
    expect((402 + el.scrollTop) / 5).toBeCloseTo((402 + 1200) / 2.5);
    handle.release();
  });

  it('delays a single click by at most the double-tap window and then releases it unchanged', () => {
    vi.useFakeTimers();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    const clicks: Array<{ x: number; y: number; prevented: boolean }> = [];
    el.addEventListener('click', (event) => {
      clicks.push({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
        prevented: event.defaultPrevented,
      });
    });

    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 80, clientY: 90 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 80, clientY: 90 }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 80, clientY: 90 });
    el.dispatchEvent(click);
    // 窗口内截住：默认行为取消、点按链（冒泡监听）不触发。
    expect(click.defaultPrevented).toBe(true);
    expect(clicks).toEqual([]);
    // 超时无第二击 → 原样放行（目标、坐标不变、未 preventDefault）。
    vi.advanceTimersByTime(280);
    expect(clicks).toEqual([{ x: 80, y: 90, prevented: false }]);
    // 放行只发生一次。
    vi.advanceTimersByTime(400);
    expect(clicks).toHaveLength(1);
    handle.release();
  });

  it('stays a no-op outside touch-primary environments even with a scale binding', () => {
    const frames = fakeFrames();
    const el = makeScroller();
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: false, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    expect(el.style.touchAction).toBe('');
    expect(el.scrollLeft).toBe(0);
    handle.sync();
    handle.release();
  });

  it('clears the click-swallow arm on the next pointerdown so the tap after a real pinch fires', () => {
    vi.useFakeTimers();
    const frames = fakeFrames();
    const el = makeScroller();
    const { binding } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    const clicks: Array<{ x: number; y: number }> = [];
    el.addEventListener('click', (event) => {
      clicks.push({ x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY });
    });

    // 真机捏合：两指张开（位移远超点击阈值）→ 没有尾随合成 click。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 260, clientY: 300 }));
    frames.flush();
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 260, clientY: 300 }));
    expect(clicks).toEqual([]);

    // 捏合后的第一次真点按：pointerdown 清掉残留吞布防，click 只被双击窗口暂扣。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 150, clientY: 150 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 150, clientY: 150 }));
    const tap = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 150,
      clientY: 150,
    });
    el.dispatchEvent(tap);
    expect(clicks).toEqual([]);
    // 超时无第二击 → 原样放行：布防不再吃掉捏合后的第一次点按。
    vi.advanceTimersByTime(PDF_DOUBLE_TAP_MS);
    expect(clicks).toEqual([{ x: 150, y: 150 }]);
    handle.release();
  });

  it('releases the previous held click when a second rapid click replaces the slot', () => {
    vi.useFakeTimers();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    const clicks: Array<{ x: number; y: number }> = [];
    el.addEventListener('click', (event) => {
      clicks.push({ x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY });
    });

    // 第一击：暂扣。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 60, clientY: 60 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 60, clientY: 60 }));
    const first = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 60,
      clientY: 60,
    });
    el.dispatchEvent(first);
    expect(clicks).toEqual([]);

    // 120ms 后第二击，位移 140px > 36px：不是双击 → 同样暂扣；顶替槽位前先
    // 按序原样放行第一击（旧实现直接顶掉，第一击丢失且旧定时器重派第二击）。
    vi.advanceTimersByTime(120);
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 200, clientY: 60 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 200, clientY: 60 }));
    const second = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 60,
    });
    el.dispatchEvent(second);
    expect(clicks).toEqual([{ x: 60, y: 60 }]);

    // 第二击超时放行：两击各恰好派发一次、顺序不变。
    vi.advanceTimersByTime(PDF_DOUBLE_TAP_MS);
    expect(clicks).toEqual([
      { x: 60, y: 60 },
      { x: 200, y: 60 },
    ]);
    vi.advanceTimersByTime(PDF_DOUBLE_TAP_MS);
    expect(clicks).toHaveLength(2);
    handle.release();
  });

  it('re-baselines the pinch when a base pointer lifts with two pointers still down', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, current } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });

    // 基指 1/2 进入捏合（指距 200），张开到 250：视觉 3.125，尚未落盘。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY: 300 }));
    frames.flush();
    expect(current()).toBe(2.5);
    expect(readPreviewScale(el)).toBeCloseTo(3.125 / 2.5);

    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3, clientX: 70, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 100, clientY: 300 }));
    frames.flush();
    expect(readPreviewScale(el)).toBeCloseTo(3.125 / 2.5);

    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 50, clientY: 300 }));
    expect(current()).toBe(2.5);
    expect(el.style.touchAction).toBe('none');

    // 新基线 3.125 × 150/200 = 2.34375。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 150, clientY: 300 }));
    frames.flush();
    expect(current()).toBe(2.5);
    expect(readPreviewScale(el)).toBeCloseTo(2.34375 / 2.5);

    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 300, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 3, clientX: 150, clientY: 300 }));
    expect(current()).toBeCloseTo(2.34375);
    expect(el.style.touchAction).toBe('pan-x pan-y');
    handle.release();
  });

  it('keeps touch-action none during an active pinch even without overflow', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, setCurrentScale } = makeScaleBinding(el, { current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    expect(el.style.touchAction).toBe('pan-x pan-y');

    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(el.style.touchAction).toBe('none');

    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 120, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).not.toHaveBeenCalled();
    handle.sync();
    expect(el.style.touchAction).toBe('none');
    handle.sync();
    expect(el.style.touchAction).toBe('none');

    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 120, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    expect(el.style.touchAction).toBe('pan-x pan-y');
    handle.release();
  });
});
