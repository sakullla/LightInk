/**
 * PDF 放大后的拖拽平移与触屏手势纯函数（触屏优先环境）。
 *
 * 适合页宽（userZoom ≤ 1）时页宿主只竖向滚动，原生滚动即可；横向溢出
 * ≤4px 属亚像素/舍入噪声，同样视为无溢出，保持原生双轴滚动。放大出实际
 * 横向溢出后原生手势不可靠（模拟触屏/鼠标环境下横向完全拖不动），把宿主
 * touch-action 收成 none，改由指针拖拽直接写 scrollLeft/Top——与漫画缩放
 * 平移同一交互。桌面鼠标环境不启用，拖动划选文字维持原状。
 *
 * 另导出无 DOM 依赖的纯函数：捏合指距比值 → 钳制 currentScale、双击窗口
 * 判定（280ms/36px，与 cbz COMIC 常量同口径）、缩放锚点 scrollLeft/Top
 * 修正（与漫画 zoomAt 同一数学族），供手势接线层 headless 复用与断言。
 */

import { isTouchPrimaryDocument } from '../comic-preferences.js';

/** 拖拽平移的启动位移（px）：小于该值视为点按，交还 click（chrome 切换等）。 */
export const PDF_PAN_SLOP_PX = 6;

/** 横向溢出容差（px）：适宽/档位切换后的亚像素舍入溢出 ≤4px 不算溢出。 */
export const PDF_PAN_OVERFLOW_TOLERANCE_PX = 4;

/** 放大后才有横向溢出；≤4px 的舍入噪声不算，保持原生双轴滚动。 */
export function pdfPanOverflow(scroller: { scrollWidth: number; clientWidth: number }): boolean {
  return scroller.scrollWidth - scroller.clientWidth > PDF_PAN_OVERFLOW_TOLERANCE_PX;
}

/** 双击窗口时长（ms），与 cbz COMIC_DOUBLE_TAP_MS 同口径。 */
export const PDF_DOUBLE_TAP_MS = 280;
/** 双击窗口位移（px，欧氏距离），与 cbz 双击判定同口径。 */
export const PDF_DOUBLE_TAP_DISTANCE_PX = 36;

/** 一次抬指的时空点；at 为同一时钟系的毫秒时间戳。 */
export interface PdfTapPoint {
  x: number;
  y: number;
  at: number;
}

/** 双击窗口判定：第二次在第一次后 ≤280ms 且位移 ≤36px（边界均含）。 */
export function pdfIsDoubleTap(first: PdfTapPoint, second: PdfTapPoint): boolean {
  const dt = second.at - first.at;
  if (!(dt >= 0) || dt > PDF_DOUBLE_TAP_MS) {
    return false;
  }
  return Math.hypot(second.x - first.x, second.y - first.y) <= PDF_DOUBLE_TAP_DISTANCE_PX;
}

/**
 * 捏合缩放的下一步 currentScale：currentScale × 指距比值（currentDistance /
 * startDistance），钳制在 fitWidthScale × steps 首尾档构成的闭区间。
 *
 * steps 是 userZoom 档位（升序），由调用方传入 pdf.ts 的 PDF_SCALE_STEPS——
 * pdf.ts 已 import 本模块，反向 import 会成环，故档位不走模块常量。
 */
export function pdfPinchScale(
  currentScale: number,
  startDistance: number,
  currentDistance: number,
  fitWidthScale: number,
  steps: readonly number[],
): number {
  const base = Number.isFinite(fitWidthScale) && fitWidthScale > 0 ? fitWidthScale : 1;
  let minStep = Number.POSITIVE_INFINITY;
  let maxStep = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (Number.isFinite(step) && step > 0) {
      minStep = Math.min(minStep, step);
      maxStep = Math.max(maxStep, step);
    }
  }
  if (!Number.isFinite(minStep) || !Number.isFinite(maxStep)) {
    minStep = 1;
    maxStep = 1;
  }
  const minScale = base * minStep;
  const maxScale = base * maxStep;
  const clamp = (value: number): number => Math.min(Math.max(value, minScale), maxScale);
  if (!(Number.isFinite(currentScale) && currentScale > 0)) {
    return clamp(base);
  }
  if (
    !(Number.isFinite(startDistance) && startDistance > 0) ||
    !(Number.isFinite(currentDistance) && currentDistance > 0)
  ) {
    return clamp(currentScale);
  }
  return clamp(currentScale * (currentDistance / startDistance));
}

/** 缩放锚定后的滚动位置（不含滚动范围 clamp，赋值时由宿主完成）。 */
export interface PdfZoomAnchorScroll {
  left: number;
  top: number;
}

/**
 * 缩放锚点滚动修正：scaleRatio = 新 content scale / 旧 content scale（即
 * 新旧行宽比），(anchorX, anchorY) 是锚点（如两指中点）在滚动口的偏移。
 * 修正量 = (scroll + anchor) × (ratio − 1)，使锚点下的内容点缩放前后不动
 * （与漫画 zoomAt 同一数学族）。结果可能越界，交给 scrollLeft/Top 赋值 clamp。
 */
export function pdfZoomAnchorScroll(
  scrollLeft: number,
  scrollTop: number,
  anchorX: number,
  anchorY: number,
  scaleRatio: number,
): PdfZoomAnchorScroll {
  const ratio = Number.isFinite(scaleRatio) && scaleRatio > 0 ? scaleRatio : 1;
  return {
    left: scrollLeft * ratio + anchorX * (ratio - 1),
    top: scrollTop * ratio + anchorY * (ratio - 1),
  };
}

export interface PdfDragPanHandle {
  /** 缩放/量页重排后重估横向溢出，同步 touch-action 与光标标记。 */
  sync(): void;
  release(): void;
}

interface PanStart {
  id: number;
  x: number;
  y: number;
  left: number;
  top: number;
  panned: boolean;
}

/** 绑定拖拽平移；非触屏环境返回空实现（桌面语义不变）。 */
export function bindPdfDragPan(
  scroller: HTMLElement,
  options?: { touchPrimary?: boolean },
): PdfDragPanHandle {
  const touchPrimary = options?.touchPrimary ?? isTouchPrimaryDocument(scroller.ownerDocument);
  if (!touchPrimary) {
    return { sync: () => undefined, release: () => undefined };
  }

  let start: PanStart | null = null;
  let swallowClick = false;

  const sync = (): void => {
    const enabled = pdfPanOverflow(scroller);
    // touch-action none：真触屏下浏览器不再抢手势（原生滚动一旦接管会派
    // pointercancel 打断拖拽），两轴平移都走下面的指针回写。
    scroller.style.touchAction = enabled ? 'none' : '';
    if (enabled) {
      scroller.setAttribute('data-pdf-pan', 'true');
    } else {
      scroller.removeAttribute('data-pdf-pan');
    }
  };

  const stopPanned = (pointerId: number): void => {
    scroller.removeAttribute('data-pdf-panning');
    scroller.style.userSelect = '';
    try {
      scroller.releasePointerCapture?.(pointerId);
    } catch {
      // jsdom / 已释放的指针没有 capture 可放。
    }
  };

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (typeof pointer.button === 'number' && pointer.button !== 0) {
      return;
    }
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') {
      return;
    }
    if (!pdfPanOverflow(scroller)) {
      return;
    }
    start = {
      id: pointer.pointerId ?? 0,
      x: pointer.clientX,
      y: pointer.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      panned: false,
    };
  };

  const onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    const dx = pointer.clientX - start.x;
    const dy = pointer.clientY - start.y;
    if (!start.panned) {
      if (Math.hypot(dx, dy) < PDF_PAN_SLOP_PX) {
        return;
      }
      start.panned = true;
      scroller.setAttribute('data-pdf-panning', 'true');
      // 拖拽期间禁掉划选：鼠标指针会把拖动当文字选择，和平移打架。
      scroller.style.userSelect = 'none';
      try {
        scroller.setPointerCapture?.(pointer.pointerId);
      } catch {
        // jsdom 无 pointer capture；真机拿不到 capture 也不影响回写。
      }
    }
    scroller.scrollLeft = start.left - dx;
    scroller.scrollTop = start.top - dy;
  };

  const onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    if (start.panned) {
      // 拖完吞掉紧随的合成 click，避免连带触发 chrome 显隐/笔记点击。
      swallowClick = true;
      stopPanned(start.id);
    }
    start = null;
  };

  const onPointerCancel = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    // cancel 后没有合成 click，不布防吞点击，否则会误伤下一次真点按。
    if (start.panned) {
      stopPanned(start.id);
    }
    start = null;
  };

  const onClick = (event: Event): void => {
    if (!swallowClick) {
      return;
    }
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  scroller.addEventListener('pointerdown', onPointerDown);
  scroller.addEventListener('pointermove', onPointerMove);
  scroller.addEventListener('pointerup', onPointerUp);
  scroller.addEventListener('pointercancel', onPointerCancel);
  scroller.addEventListener('click', onClick, { capture: true });
  sync();

  return {
    sync,
    release: () => {
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('pointermove', onPointerMove);
      scroller.removeEventListener('pointerup', onPointerUp);
      scroller.removeEventListener('pointercancel', onPointerCancel);
      scroller.removeEventListener('click', onClick, { capture: true });
      scroller.removeAttribute('data-pdf-pan');
      scroller.removeAttribute('data-pdf-panning');
      scroller.style.touchAction = '';
      scroller.style.userSelect = '';
      start = null;
      swallowClick = false;
    },
  };
}
