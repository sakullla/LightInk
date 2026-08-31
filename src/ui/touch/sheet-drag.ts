/**
 * `touch/sheet-drag` — 底栏 sheet 把手下拖关闭。
 *
 * 只负责把手按下后跟随位移与关闭判定；关闭走调用方注入的 onClose
 * （与关闭按钮 / 遮罩同一条路径）。本模块不创建把手、不画假条子；
 * 无把手的层由调用方决定不绑定。
 *
 * 判定：
 *   - 仅跟随向下位移（translateY）；
 *   - 松手时位移 ≥ 阈值或向下快甩 → onClose；
 *   - 未过阈值 → 200ms transform 回弹（reduce-motion 瞬回），不关闭。
 *
 * 与 sheet 过渡（sheet-transition.ts / 各样式表的 data-open 规则）互斥：
 * 拖拽开始写内联 `transition: none` 让跟随即时（transitionend 随之不派发，
 * 在途退场只剩兜底 timer），并调用 cancelSheetTransition 作废在途关闭——
 * 退场窗口内抓住把手是接管而非继续关闭；释放/关闭时清掉内联，让 class
 * 驱动的开关过渡或 snapBack 自己的回弹接管。
 *
 * 只依赖 EventTarget 与指针/触摸坐标，jsdom 可用伪造 pointer/touch 事件测试。
 */

import { cancelSheetTransition } from './sheet-transition.js';

export interface SheetDragOptions {
  sheet: HTMLElement;
  onClose: () => void;
  /** 下拖关闭阈值（px），默认 80。 */
  thresholdPx?: number;
  /**
   * sheet 开关过渡的容器（data-open 宿主）：书架 sheet 为外层容器，面板/
   * 工具条即本体；缺省用 sheet。拖拽开始时取消其在途关闭收尾。
   */
  container?: HTMLElement;
}

/** 默认下拖关闭阈值（px）。 */
export const SHEET_DRAG_THRESHOLD_PX = 80;
/** 向下快甩速度阈值（px/ms）。 */
export const SHEET_DRAG_FLICK_PX_PER_MS = 0.5;
/** 快甩至少要有一段向下位移，避免原地抖动误关。 */
export const SHEET_DRAG_FLICK_MIN_DY_PX = 16;
/** 松手未过阈值时的回弹时长（ms）。 */
export const SHEET_DRAG_SNAP_BACK_MS = 200;

interface TouchPointLike {
  clientX: number;
  clientY: number;
}

interface TouchEventLike extends Event {
  touches?: ArrayLike<TouchPointLike>;
  changedTouches?: ArrayLike<TouchPointLike>;
}

interface PointerLike {
  pointerId?: number;
  button?: number;
  clientX: number;
  clientY: number;
}

interface DragState {
  pointerId: number | null;
  startY: number;
  startAt: number;
  lastY: number;
}

function firstTouch(event: Event, ended: boolean): TouchPointLike | undefined {
  const touchEvent = event as TouchEventLike;
  const points = ended ? touchEvent.changedTouches : touchEvent.touches;
  if (points === undefined || points.length !== 1) {
    return undefined;
  }
  return points[0];
}

function applySheetOffset(sheet: HTMLElement, dy: number): void {
  const offset = Math.max(0, dy);
  if (offset === 0) {
    sheet.style.transform = '';
    return;
  }
  sheet.style.transform = `translateY(${offset}px)`;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 在途回弹的清理句柄：新拖拽开始时取消，避免旧 timer 中途清掉新状态。 */
const snapBackCancellers = new WeakMap<HTMLElement, () => void>();

function cancelPendingSnapBack(sheet: HTMLElement): void {
  const cancel = snapBackCancellers.get(sheet);
  if (cancel !== undefined) {
    cancel();
    snapBackCancellers.delete(sheet);
  }
}

/** 拖拽开始：压掉 class 过渡与在途回弹，作废在途关闭，手指跟随必须即时。 */
function beginDrag(sheet: HTMLElement, transitionContainer: HTMLElement): void {
  cancelPendingSnapBack(sheet);
  cancelSheetTransition(transitionContainer);
  sheet.style.transition = 'none';
}

/** 拖拽结束：恢复 class 过渡（关闭方向由调用方摘 data-open 驱动）。 */
function releaseDragTransition(sheet: HTMLElement): void {
  sheet.style.removeProperty('transition');
}

/** 松手未过阈值：200ms transform 回弹到 class 基线（reduce-motion 瞬回）。 */
function snapBack(sheet: HTMLElement): void {
  cancelPendingSnapBack(sheet);
  if (prefersReducedMotion() || typeof setTimeout !== 'function') {
    sheet.style.removeProperty('transition');
    sheet.style.transform = '';
    return;
  }
  sheet.style.transition = `transform ${SHEET_DRAG_SNAP_BACK_MS}ms ease`;
  sheet.style.transform = '';
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (done) {
      return;
    }
    done = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    sheet.removeEventListener('transitionend', onEnd);
    sheet.style.removeProperty('transition');
    snapBackCancellers.delete(sheet);
  };
  const onEnd = (event: TransitionEvent): void => {
    if (event.target !== sheet || event.propertyName !== 'transform') {
      return;
    }
    finish();
  };
  timer = setTimeout(finish, SHEET_DRAG_SNAP_BACK_MS + 40);
  sheet.addEventListener('transitionend', onEnd);
  snapBackCancellers.set(sheet, finish);
}

function shouldClose(dy: number, durationMs: number, thresholdPx: number): boolean {
  if (dy >= thresholdPx) {
    return true;
  }
  if (dy >= SHEET_DRAG_FLICK_MIN_DY_PX && durationMs > 0) {
    return dy / durationMs >= SHEET_DRAG_FLICK_PX_PER_MS;
  }
  return false;
}

function trySetPointerCapture(handle: HTMLElement, pointerId: number): void {
  if (typeof handle.setPointerCapture !== 'function') {
    return;
  }
  try {
    handle.setPointerCapture(pointerId);
  } catch {
    // jsdom / already-released pointers
  }
}

function tryReleasePointerCapture(handle: HTMLElement, pointerId: number): void {
  if (typeof handle.releasePointerCapture !== 'function') {
    return;
  }
  try {
    if (handle.hasPointerCapture?.(pointerId) === true) {
      handle.releasePointerCapture(pointerId);
    }
  } catch {
    // jsdom / already-released pointers
  }
}

/** 绑定把手下拖关闭；返回解绑函数。 */
export function bindSheetDrag(handle: HTMLElement, options: SheetDragOptions): () => void {
  const thresholdPx = options.thresholdPx ?? SHEET_DRAG_THRESHOLD_PX;
  const sheet = options.sheet;
  const transitionContainer = options.container ?? sheet;
  let drag: DragState | null = null;

  const finish = (clientY: number, at: number): void => {
    if (drag === null) {
      return;
    }
    const dy = clientY - drag.startY;
    const durationMs = at - drag.startAt;
    const pointerId = drag.pointerId;
    drag = null;
    if (pointerId !== null) {
      tryReleasePointerCapture(handle, pointerId);
    }
    releaseDragTransition(sheet);
    if (shouldClose(dy, durationMs, thresholdPx)) {
      options.onClose();
      return;
    }
    snapBack(sheet);
  };

  const onPointerDown = (event: Event): void => {
    if (drag !== null) {
      return;
    }
    const pointer = event as PointerEvent & PointerLike;
    if (typeof pointer.button === 'number' && pointer.button !== 0) {
      return;
    }
    if (typeof pointer.clientY !== 'number') {
      return;
    }
    const pointerId = typeof pointer.pointerId === 'number' ? pointer.pointerId : 1;
    drag = {
      pointerId,
      startY: pointer.clientY,
      startAt: Date.now(),
      lastY: pointer.clientY,
    };
    if (typeof pointer.pointerId === 'number') {
      trySetPointerCapture(handle, pointer.pointerId);
    }
    beginDrag(sheet, transitionContainer);
    applySheetOffset(sheet, 0);
  };

  const onPointerMove = (event: Event): void => {
    if (drag === null || drag.pointerId === null) {
      return;
    }
    const pointer = event as PointerEvent & PointerLike;
    if (typeof pointer.pointerId === 'number' && pointer.pointerId !== drag.pointerId) {
      return;
    }
    if (typeof pointer.clientY !== 'number') {
      return;
    }
    drag.lastY = pointer.clientY;
    applySheetOffset(sheet, pointer.clientY - drag.startY);
  };

  const onPointerUp = (event: Event): void => {
    if (drag === null || drag.pointerId === null) {
      return;
    }
    const pointer = event as PointerEvent & PointerLike;
    if (typeof pointer.pointerId === 'number' && pointer.pointerId !== drag.pointerId) {
      return;
    }
    const y = typeof pointer.clientY === 'number' ? pointer.clientY : drag.lastY;
    finish(y, Date.now());
  };

  const onTouchStart = (event: Event): void => {
    if (drag !== null) {
      return;
    }
    const touch = firstTouch(event, false);
    if (touch === undefined) {
      return;
    }
    drag = {
      pointerId: null,
      startY: touch.clientY,
      startAt: Date.now(),
      lastY: touch.clientY,
    };
    beginDrag(sheet, transitionContainer);
    applySheetOffset(sheet, 0);
  };

  const onTouchMove = (event: Event): void => {
    if (drag === null || drag.pointerId !== null) {
      return;
    }
    const touch = firstTouch(event, false);
    if (touch === undefined) {
      return;
    }
    drag.lastY = touch.clientY;
    applySheetOffset(sheet, touch.clientY - drag.startY);
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  };

  const onTouchEnd = (event: Event): void => {
    if (drag === null || drag.pointerId !== null) {
      return;
    }
    const touch = firstTouch(event, true);
    const y = touch !== undefined ? touch.clientY : drag.lastY;
    finish(y, Date.now());
  };

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  handle.addEventListener('touchstart', onTouchStart, { passive: true });
  handle.addEventListener('touchmove', onTouchMove, { passive: false });
  handle.addEventListener('touchend', onTouchEnd, { passive: true });
  handle.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    if (drag !== null && drag.pointerId !== null) {
      tryReleasePointerCapture(handle, drag.pointerId);
    }
    drag = null;
    snapBack(sheet);
    handle.removeEventListener('pointerdown', onPointerDown);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    handle.removeEventListener('touchstart', onTouchStart);
    handle.removeEventListener('touchmove', onTouchMove);
    handle.removeEventListener('touchend', onTouchEnd);
    handle.removeEventListener('touchcancel', onTouchEnd);
  };
}
