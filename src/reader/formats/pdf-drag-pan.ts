/**
 * PDF 页宿主的触屏手势层与手势纯函数（触屏优先环境）。
 *
 * 单指：适合页宽（横向溢出 ≤4px 属亚像素噪声）时始终原生双轴滚动，不接管；
 * 放大出实际横向溢出后把宿主 touch-action 收成 none，改由指针拖拽直接写
 * scrollLeft/Top——与漫画缩放平移同一交互，slop 6px、拖后吞一次合成 click、
 * pointercancel 不布防、release 对称还原。桌面鼠标环境不启用。
 *
 * 多指（注入 scale 绑定，仅触屏优先环境）：activePointers 跟踪活跃指针；
 * 恰好 2 指进入捏合——第二指落下取消进行中的单指平移，捏合中回到 1 指不
 * 恢复旧平移基线（等新手势）；指距比值经 pdfPinchScale 钳制后 rAF 合并直写
 * currentScale（每帧至多一次），并按两指中点用 pdfZoomAnchorScroll 修正滚动
 * 锚点。捏合基指固定为进入时的首两指（第 3 指不参与）；基指抬起但仍有
 * ≥2 指在屏时以剩余首两指重定 {startDistance, startScale} 基线，比值口径
 * 不悄悄换对。捏合期 touch-action 恒 none——包括 sync() 重估（pdf.ts 的
 * scalechanging 在每次写比例后同步回调，中途收敛会让原生手势抢走剩余指），
 * 结束才按溢出重新收敛。双击（280ms/36px 窗口，pdfIsDoubleTap）在适宽与
 * 2× 档间切换并锚定双击点；窗口内单击被暂扣 ≤280ms，无第二击则原样放行
 * ——chrome 切换/笔记/划选工具栏等现有点按链不被双触发；新点击顶替暂扣
 * 槽位前先把旧击原样放行（每击恰好派发一次、顺序不变）。拖后/多指结束的
 * 吞 click 布防在下一次 pointerdown 清除：尾随合成 click（存在时）总在新
 * pointerdown 之前到达，而真机捏合（位移超点击阈值）没有尾随 click，布防
 * 残留会吃掉下一次真点按。手势结束不额外跳档，落档由 pdf.ts 的
 * scalechanging→syncScale 吸档回环负责。
 *
 * 另导出无 DOM 依赖的纯函数，供手势接线层 headless 复用与断言。
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

/**
 * 捏合/双击的 currentScale 读写绑定（由 pdf.ts 注入，官方 viewer 是真源）。
 * 写入后官方组件自管重排并派发 scalechanging，吸档由 pdf.ts 回环负责。
 */
export interface PdfScaleBinding {
  /** 当前 currentScale（钳制区间与锚点 ratio 的旧值基准）。 */
  getCurrentScale(): number;
  /** 写新的 currentScale（手势层保证每帧至多一次）。 */
  setCurrentScale(scale: number): void;
  /** 适合页宽基准（钳制区间 = fitWidthScale × steps 首尾档）。 */
  getFitWidthScale(): number;
  /** userZoom 档位（升序），即 pdf.ts 的 PDF_SCALE_STEPS。 */
  readonly steps: readonly number[];
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

/** 绑定拖拽平移与触屏手势；非触屏环境返回空实现（桌面语义不变）。 */
export function bindPdfDragPan(
  scroller: HTMLElement,
  options?: { touchPrimary?: boolean; scale?: PdfScaleBinding },
): PdfDragPanHandle {
  const touchPrimary = options?.touchPrimary ?? isTouchPrimaryDocument(scroller.ownerDocument);
  if (!touchPrimary) {
    return { sync: () => undefined, release: () => undefined };
  }
  const scaleBinding = options?.scale;
  const view = scroller.ownerDocument.defaultView;

  let start: PanStart | null = null;
  let swallowClick = false;
  /** 活跃触点（多指状态机）：恰好 2 指捏合，第 3 指不改变手势。 */
  const activePointers = new Map<number, { x: number; y: number }>();
  /** 本轮手势出现过 2 指：抬指不按点按处理（尾随 click 吞掉）。 */
  let sawMultiTouch = false;
  /**
   * 进行中的捏合：基指固定为进入捏合时的首两指（第 3 指不参与）；基指
   * 抬起但仍有 ≥2 指在屏时整体重定基线（见 rebasePinch），比值口径不换对。
   */
  let pinch: { baseIds: [number, number]; startDistance: number; startScale: number } | null =
    null;
  let pinchFramePending = false;
  let pinchFrameId: number | null = null;
  /** 最近一次 move 算出的目标 currentScale（rAF 合并，帧内只留最新）。 */
  let pendingPinchScale: number | null = null;
  let lastTap: PdfTapPoint | null = null;
  /** 双击窗口内的单击暂扣：等第二击（吞掉）或超时原样放行。 */
  let holdArmed = false;
  let holdDisarmTimer: ReturnType<typeof setTimeout> | null = null;
  let heldClick: {
    target: EventTarget;
    clientX: number;
    clientY: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** 正在重派暂扣 click：让其原样通过本捕获层，不再截住。 */
  let releasingHeld = false;

  const sync = (): void => {
    // 捏合期恒 none：pdf.ts 的 scalechanging→sync() 在每次写比例后同步回调，
    // 捏合中缩小到无横向溢出时也不得中途收敛（原生手势一旦接管会派
    // pointercancel 抢走剩余指针）；捏合结束 endPinch 才按溢出重新收敛。
    const enabled = pdfPanOverflow(scroller) || pinch !== null;
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

  const fitBase = (): number => {
    const fit = scaleBinding?.getFitWidthScale();
    return fit !== undefined && Number.isFinite(fit) && fit > 0 ? fit : 1;
  };

  /** 写比例并按锚点修正滚动（ratio = 新/旧 currentScale，锚点为滚动口偏移）。 */
  const writeScaleAnchored = (nextScale: number, anchorX: number, anchorY: number): void => {
    if (scaleBinding === undefined) {
      return;
    }
    const current = scaleBinding.getCurrentScale();
    if (!Number.isFinite(current) || current <= 0) {
      return;
    }
    scaleBinding.setCurrentScale(nextScale);
    const corrected = pdfZoomAnchorScroll(
      scroller.scrollLeft,
      scroller.scrollTop,
      anchorX,
      anchorY,
      nextScale / current,
    );
    scroller.scrollLeft = corrected.left;
    scroller.scrollTop = corrected.top;
  };

  /** 捏合候选指：活跃指针按 Map 插入序取前两（进入捏合/重定基线时用）。 */
  const pinchPoints = (): Array<{ x: number; y: number }> =>
    [...activePointers.values()].slice(0, 2);

  /** 捏合候选指 id：与 pinchPoints 同序（进入捏合/重定基线时取基指对）。 */
  const pinchIds = (): [number, number] => {
    const ids = [...activePointers.keys()].slice(0, 2);
    return [ids[0]!, ids[1]!];
  };

  /** 捏合基指坐标对；基指已不在屏（或未在捏合）→ null。 */
  const pinchPair = (): Array<{ x: number; y: number }> | null => {
    if (pinch === null) {
      return null;
    }
    const first = activePointers.get(pinch.baseIds[0]);
    const second = activePointers.get(pinch.baseIds[1]);
    if (first === undefined || second === undefined) {
      return null;
    }
    return [first, second];
  };

  const applyPendingPinchWrite = (): void => {
    const nextScale = pendingPinchScale;
    pendingPinchScale = null;
    if (nextScale === null || pinch === null) {
      return;
    }
    const points = pinchPair();
    if (points === null) {
      return; // 基指已散：比例不再有意义，本轮丢弃
    }
    const rect = scroller.getBoundingClientRect();
    writeScaleAnchored(
      nextScale,
      (points[0]!.x + points[1]!.x) / 2 - rect.left,
      (points[0]!.y + points[1]!.y) / 2 - rect.top,
    );
  };

  const flushPinchFrame = (): void => {
    pinchFramePending = false;
    pinchFrameId = null;
    applyPendingPinchWrite();
  };

  const cancelPinchFrame = (): void => {
    pinchFramePending = false;
    if (pinchFrameId !== null && typeof view?.cancelAnimationFrame === 'function') {
      view.cancelAnimationFrame(pinchFrameId);
    }
    pinchFrameId = null;
  };

  /** 捏合结束：终笔比例落盘（同步），touch-action 按溢出重新收敛。 */
  const endPinch = (): void => {
    cancelPinchFrame();
    applyPendingPinchWrite();
    pinch = null;
    sync();
  };

  /**
   * 捏合基指抬起但仍有 ≥2 指在屏：以剩余首两指重定 {startDistance,
   * startScale} 基线，避免比值口径悄悄换成另一对指（startDistance 还是旧对
   * 的，currentScale 会跳变）。旧基指已离屏，未落盘的终笔比值失去锚点，
   * 丢弃（损失至多一帧）；两点重合无法定距则安全结束捏合。
   */
  const rebasePinch = (): void => {
    if (scaleBinding === undefined) {
      endPinch();
      return;
    }
    cancelPinchFrame();
    pendingPinchScale = null;
    const ids = pinchIds();
    const first = activePointers.get(ids[0]);
    const second = activePointers.get(ids[1]);
    const distance =
      first !== undefined && second !== undefined
        ? Math.hypot(first.x - second.x, first.y - second.y)
        : 0;
    if (distance <= 0) {
      endPinch();
      return;
    }
    pinch = {
      baseIds: ids,
      startDistance: distance,
      startScale: scaleBinding.getCurrentScale(),
    };
  };

  /** 指针离屏（up/cancel 共用）后的捏合维护：基指离开才处理，其余不参与。 */
  const onPointerRemoved = (pointerId: number): void => {
    if (pinch === null) {
      return;
    }
    const wasBase = pinch.baseIds[0] === pointerId || pinch.baseIds[1] === pointerId;
    if (activePointers.size < 2) {
      endPinch();
    } else if (wasBase) {
      rebasePinch();
    }
  };

  const clearHoldDisarm = (): void => {
    if (holdDisarmTimer !== null) {
      clearTimeout(holdDisarmTimer);
      holdDisarmTimer = null;
    }
    holdArmed = false;
  };

  /** 丢弃暂扣的单击（双击消费/多指/释放路径）：不再放行。 */
  const dropHeldClick = (): void => {
    clearHoldDisarm();
    if (heldClick !== null) {
      clearTimeout(heldClick.timer);
      heldClick = null;
    }
  };

  /** 把暂扣的单击原样重派到原目标（新事件，坐标/目标不变）。 */
  const dispatchHeldClick = (held: {
    target: EventTarget;
    clientX: number;
    clientY: number;
  }): void => {
    const click = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: held.clientX,
      clientY: held.clientY,
    });
    releasingHeld = true;
    try {
      held.target.dispatchEvent(click);
    } finally {
      releasingHeld = false;
    }
  };

  /** 超时无第二击：放行暂扣的单击，点按链 ≤280ms 迟滞放行。 */
  const releaseHeldClick = (): void => {
    const held = heldClick;
    heldClick = null;
    if (held !== null) {
      dispatchHeldClick(held);
    }
  };

  /** 双击落档：靠近 2× 档回适宽，否则放大到 2×；锚定双击点。 */
  const toggleDoubleTapZoom = (x: number, y: number): void => {
    if (scaleBinding === undefined) {
      return;
    }
    const fit = fitBase();
    const current = scaleBinding.getCurrentScale();
    if (!Number.isFinite(current) || current <= 0) {
      return;
    }
    const target = Math.abs(current - fit * 2) <= Math.abs(current - fit) ? fit : fit * 2;
    const rect = scroller.getBoundingClientRect();
    writeScaleAnchored(target, x - rect.left, y - rect.top);
    // 缩放后横向溢出可能增减，立即收敛 touch-action（不等的 scalechanging
    // 是官方异步事件，这里保证手势内状态一致）。
    sync();
  };

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (typeof pointer.button === 'number' && pointer.button !== 0) {
      return;
    }
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') {
      return;
    }
    const pointerId = pointer.pointerId ?? 0;
    // 吞 click 布防到此为止：尾随合成 click（存在时）总在新 pointerdown 之前
    // 到达，而真机捏合/拖拽（位移超点击阈值）没有尾随 click——布防若跨过
    // 这里残留，会吃掉下一次真点按（chrome 切换/笔记点击）。
    swallowClick = false;
    activePointers.set(pointerId, { x: pointer.clientX, y: pointer.clientY });
    if (activePointers.size >= 2) {
      sawMultiTouch = true;
      // 双指落下：上一击暂扣的 click 静默吞掉，不切 chrome。
      dropHeldClick();
      if (start !== null) {
        // 第二指让位规则：取消进行中的单指平移，不保留基线。
        if (start.panned) {
          // 已移动的平移，其尾随合成 click 仍要吞。
          swallowClick = true;
        }
        stopPanned(start.id);
        start = null;
      }
      if (scaleBinding !== undefined && pinch === null) {
        const points = pinchPoints();
        const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
        if (distance > 0) {
          pinch = {
            baseIds: pinchIds(),
            startDistance: distance,
            startScale: scaleBinding.getCurrentScale(),
          };
          // 捏合期恒 none：原生双指缩放/滚动都不参与。
          scroller.style.touchAction = 'none';
        }
      }
      return;
    }
    if (!pdfPanOverflow(scroller)) {
      return; // 适宽：单指始终原生滚动，不接管
    }
    start = {
      id: pointerId,
      x: pointer.clientX,
      y: pointer.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      panned: false,
    };
  };

  const onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;
    const pointerId = pointer.pointerId ?? 0;
    const tracked = activePointers.get(pointerId);
    if (
      tracked !== undefined &&
      typeof pointer.clientX === 'number' &&
      typeof pointer.clientY === 'number'
    ) {
      tracked.x = pointer.clientX;
      tracked.y = pointer.clientY;
    }
    if (pinch !== null && tracked !== undefined) {
      if (scaleBinding === undefined) {
        return;
      }
      const points = pinchPair();
      if (points === null) {
        return;
      }
      const distance = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
      if (distance > 0) {
        pendingPinchScale = pdfPinchScale(
          pinch.startScale,
          pinch.startDistance,
          distance,
          fitBase(),
          scaleBinding.steps,
        );
        // rAF 合并：帧内多次 move 只写最新值（每帧至多一次写）。
        if (!pinchFramePending) {
          pinchFramePending = true;
          if (typeof view?.requestAnimationFrame === 'function') {
            pinchFrameId = view.requestAnimationFrame(flushPinchFrame);
          } else {
            flushPinchFrame(); // 无 rAF 环境退化为逐次写
          }
        }
      }
      return;
    }
    if (start === null || pointerId !== start.id) {
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
    const pointerId = pointer.pointerId ?? 0;
    const wasTracked = activePointers.delete(pointerId);
    onPointerRemoved(pointerId);
    let panned = false;
    if (start !== null && pointerId === start.id) {
      panned = start.panned;
      if (panned) {
        // 拖完吞掉紧随的合成 click，避免连带触发 chrome 显隐/笔记点击。
        swallowClick = true;
        stopPanned(start.id);
      }
      start = null;
    }
    if (activePointers.size > 0) {
      return;
    }
    const multiTouch = sawMultiTouch;
    sawMultiTouch = false;
    if (multiTouch) {
      // 多指手势（捏合/双指点按）的尾随 click 不进点按链。
      swallowClick = true;
      lastTap = null;
      return;
    }
    if (panned) {
      lastTap = null; // 拖拽打断双击连续性
      return;
    }
    if (scaleBinding === undefined || !wasTracked) {
      return;
    }
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') {
      return;
    }
    const tap: PdfTapPoint = {
      x: pointer.clientX,
      y: pointer.clientY,
      at: Date.now(),
    };
    const previous = lastTap;
    lastTap = tap;
    if (previous !== null && pdfIsDoubleTap(previous, tap)) {
      lastTap = null;
      dropHeldClick(); // 第一击暂扣的 click 静默吞掉
      swallowClick = true; // 第二击的合成 click 也吞
      toggleDoubleTapZoom(tap.x, tap.y);
      return;
    }
    // 单击：暂扣 ≤280ms 等第二击；click 到来时在捕获层截住。
    holdArmed = true;
    if (holdDisarmTimer !== null) {
      clearTimeout(holdDisarmTimer);
    }
    holdDisarmTimer = setTimeout(() => {
      holdArmed = false;
      holdDisarmTimer = null;
    }, PDF_DOUBLE_TAP_MS);
  };

  const onPointerCancel = (event: Event): void => {
    const pointer = event as PointerEvent;
    const pointerId = pointer.pointerId ?? 0;
    activePointers.delete(pointerId);
    onPointerRemoved(pointerId);
    if (start !== null && pointerId === start.id) {
      // cancel 后没有合成 click，不布防吞点击，否则会误伤下一次真点按。
      if (start.panned) {
        stopPanned(start.id);
      }
      start = null;
    }
    if (activePointers.size === 0) {
      sawMultiTouch = false;
      lastTap = null;
    }
  };

  const onClick = (event: Event): void => {
    if (releasingHeld) {
      return; // 放行的暂扣 click 原样通过
    }
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!holdArmed) {
      return;
    }
    // 双击窗口内的单击：截住暂扣，超时无第二击则原样放行。
    holdArmed = false;
    if (holdDisarmTimer !== null) {
      clearTimeout(holdDisarmTimer);
      holdDisarmTimer = null;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const mouse = event as MouseEvent;
    const clientX = typeof mouse.clientX === 'number' ? mouse.clientX : 0;
    const clientY = typeof mouse.clientY === 'number' ? mouse.clientY : 0;
    if (heldClick !== null) {
      // 280ms 内两处 >36px 的快速点按（非双击）：新击顶替槽位前先清掉旧击的
      // 定时器并按序原样放行旧击——否则旧定时器读到新槽位，旧击被顶掉丢失。
      const stale = heldClick;
      heldClick = null;
      clearTimeout(stale.timer);
      dispatchHeldClick(stale);
    }
    heldClick = {
      target: event.target ?? scroller,
      clientX,
      clientY,
      timer: setTimeout(releaseHeldClick, PDF_DOUBLE_TAP_MS),
    };
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
      cancelPinchFrame();
      pinch = null;
      pendingPinchScale = null;
      activePointers.clear();
      sawMultiTouch = false;
      dropHeldClick(); // 定时器/rAF 全清，暂扣 click 不再放行
      lastTap = null;
      scroller.removeAttribute('data-pdf-pan');
      scroller.removeAttribute('data-pdf-panning');
      scroller.style.touchAction = '';
      scroller.style.userSelect = '';
      start = null;
      swallowClick = false;
    },
  };
}
