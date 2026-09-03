// @vitest-environment jsdom

/**
 * pdf-drag-pan — PDF 放大后的指针拖拽平移与触屏手势纯函数。
 *
 * 覆盖：横向溢出判定（≤4px 亚像素容差，不锁原生双轴滚动）、触屏环境门控、
 * 拖拽回写 scrollLeft/Top、点按（slop 内）不平移且不吞 click、拖完吞一次
 * 合成 click、pointercancel 不布防吞点击、sync 随溢出增减切 touch-action、
 * release 还原宿主状态；纯函数：捏合指距比值 → 适宽×档位钳制 currentScale、
 * 双击窗口（280ms/36px）判定、缩放锚点滚动修正；多指手势层（注入 scale
 * 绑定）：第二指取消进行中平移、捏合 rAF 合并直写 currentScale + 两指中点
 * 锚定、捏合回 1 指不恢复旧基线、双击适宽↔2× 档切换锚定双击点、窗口内单击
 * 暂扣 ≤280ms 后原样放行、非触屏（含绑定注入）仍为 no-op；修复回归：吞
 * click 布防在下一次 pointerdown 清除（真机捏合无尾随 click，不得吃掉下一次
 * 真点按）、新点击顶替暂扣槽位前先按序放行旧击（各恰好一次）、捏合基指抬起
 * 且仍有两指在屏时重定基线（比值口径不换对）、捏合期 sync() 恒 touch-action
 * none（缩小到无溢出也不中途收敛）。
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

/** scale 绑定测试替身：记录写入、current 状态可读（真源在官方 viewer 侧）。 */
function makeScaleBinding(initial: { current: number; fit: number }): {
  readonly binding: PdfScaleBinding;
  readonly setCurrentScale: ReturnType<typeof vi.fn>;
  current(): number;
} {
  let current = initial.current;
  const setCurrentScale = vi.fn((value: number): void => {
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

describe('bindPdfDragPan multi-pointer gestures', () => {
  it('cancels an in-progress pan when the second pointer lands', () => {
    const el = makeScroller();
    el.scrollLeft = 50;
    el.scrollTop = 200;
    const handle = bindPdfDragPan(el, { touchPrimary: true });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 130 }));
    expect(el.getAttribute('data-pdf-panning')).toBe('true');
    expect(el.scrollLeft).toBe(90);
    // 第二指落下：平移立即取消（标记/userSelect 还原），不保留旧基线。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 200 }));
    expect(el.getAttribute('data-pdf-panning')).toBeNull();
    expect(el.style.userSelect).toBe('');
    // 第 1 指继续移动：既不恢复平移也不产生新基线。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY: 130 }));
    expect(el.scrollLeft).toBe(90);
    expect(el.scrollTop).toBe(170);
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 20, clientY: 130 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 200, clientY: 200 }));
    handle.release();
  });

  it('keeps the single-pointer JS pan while a scale binding is present', () => {
    const el = makeScroller();
    const { binding, setCurrentScale } = makeScaleBinding({ current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 100 }));
    expect(el.getAttribute('data-pdf-panning')).toBe('true');
    expect(el.scrollLeft).toBe(60);
    // 单指平移只写滚动，不经绑定写比例。
    expect(setCurrentScale).not.toHaveBeenCalled();
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 100 }));
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    handle.release();
  });

  it('pinches through the binding coalesced to one write per frame, anchored at the midpoint', () => {
    const frames = fakeFrames();
    // 适宽（无横向溢出）：捏合路径不依赖溢出，但仍必须接管。
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, setCurrentScale, current } = makeScaleBinding({ current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    // 捏合期 touch-action 恒 none（适宽单指本来是原生滚动）。
    expect(el.style.touchAction).toBe('none');
    // 指距 100 → 150 → 155：帧前零写入。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 75, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 225, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 70, clientY: 300 }));
    expect(setCurrentScale).not.toHaveBeenCalled();
    frames.flush();
    // 同帧多次 move 只写一次，且写最新值：2.5 × 155/100 = 3.875（区间 [1.25,7.5]）。
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    expect(current()).toBeCloseTo(3.875);
    // 锚点修正：中点 (147.5,300)、ratio = 3.875/2.5 = 1.55 → left = 147.5×0.55。
    expect(el.scrollLeft).toBeCloseTo(81.125);
    expect(el.scrollTop).toBeCloseTo(165);
    // 新帧才有第二次写（合并窗口随帧重开）。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 300 }));
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    frames.flush();
    expect(setCurrentScale).toHaveBeenCalledTimes(2);
    expect(current()).toBeCloseTo(2.5 * 1.65);
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 60, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 225, clientY: 300 }));
    // 捏合结束回适宽（无溢出）→ touch-action 收敛为空；尾随 click 不进点按链。
    expect(el.style.touchAction).toBe('');
    const click = new Event('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    handle.release();
  });

  it('does not resume the pan baseline when the pinch ends with one finger down', () => {
    const frames = fakeFrames();
    const el = makeScroller(); // 横向溢出：平移路径可用
    const { binding, setCurrentScale } = makeScaleBinding({ current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    const scrollAfterPinch = el.scrollLeft;
    // 抬起第 2 指：捏合结束（仍有横向溢出 → touch-action 保持 none）。
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(el.style.touchAction).toBe('none');
    // 剩余 1 指移动：不恢复旧平移基线（不平移、不写比例）。
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
    const { binding, current } = makeScaleBinding({ current: 2.5, fit: 2.5 });
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

  it('delays a single click by at most the double-tap window and then releases it unchanged', () => {
    vi.useFakeTimers();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding } = makeScaleBinding({ current: 2.5, fit: 2.5 });
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
    const { binding, setCurrentScale } = makeScaleBinding({ current: 2.5, fit: 2.5 });
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
    const { binding } = makeScaleBinding({ current: 2.5, fit: 2.5 });
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
    const { binding } = makeScaleBinding({ current: 2.5, fit: 2.5 });
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
    const { binding, current } = makeScaleBinding({ current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });

    // 基指 1/2 进入捏合（指距 200），张开到 250：2.5 × 1.25 = 3.125。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY: 300 }));
    frames.flush();
    expect(current()).toBeCloseTo(3.125);

    // 第 3 指落下/移动不参与：基指仍是 1/2，比例不因第 3 指变化。
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3, clientX: 70, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 100, clientY: 300 }));
    frames.flush();
    expect(current()).toBeCloseTo(3.125);

    // 基指 1 抬起、2/3 仍在屏：以剩余首两指（2@300 / 3@100，指距 200）重定
    // 基线，捏合继续（不结束、不写比例）。
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 50, clientY: 300 }));
    expect(current()).toBeCloseTo(3.125);
    expect(el.style.touchAction).toBe('none');

    // 剩余两指收拢到指距 150：按新基线 3.125 × 150/200 = 2.34375（旧实现沿用
    // 旧基线口径 2.5 × 0.75 = 1.875，换对导致比例跳变）。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 150, clientY: 300 }));
    frames.flush();
    expect(current()).toBeCloseTo(2.34375);

    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 300, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 3, clientX: 150, clientY: 300 }));
    expect(el.style.touchAction).toBe(''); // 全部离屏：捏合结束，按溢出收敛
    handle.release();
  });

  it('keeps touch-action none during an active pinch even without overflow', () => {
    const frames = fakeFrames();
    const el = makeScroller({ scrollWidth: 400, clientWidth: 400 });
    const { binding, setCurrentScale } = makeScaleBinding({ current: 2.5, fit: 2.5 });
    const handle = bindPdfDragPan(el, { touchPrimary: true, scale: binding });
    expect(el.style.touchAction).toBe('');

    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(el.style.touchAction).toBe('none'); // 捏合进入即接管

    // pdf.ts 的 scalechanging→sync() 在每次写比例后同步重估：捏合中缩小到无
    // 横向溢出也不得中途收敛（原生手势一旦接管会 pointercancel 抢走剩余指）。
    el.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 120, clientY: 300 }));
    frames.flush();
    expect(setCurrentScale).toHaveBeenCalledTimes(1);
    handle.sync();
    expect(el.style.touchAction).toBe('none');
    handle.sync(); // 重复重估同样保持
    expect(el.style.touchAction).toBe('none');

    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 120, clientY: 300 }));
    el.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 200, clientY: 300 }));
    expect(el.style.touchAction).toBe(''); // 捏合结束才按溢出收敛
    handle.release();
  });
});
