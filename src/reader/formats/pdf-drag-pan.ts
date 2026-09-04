/**
 * PDF 页宿主的触屏手势层与手势纯函数（触屏优先环境）。
 *
 * 单指滚动：始终 `touch-action: pan-x pan-y`，交给合成器原生双轴滚动。
 * 放大后若改成 none + JS 写 scrollLeft/Top，手机上会和 PDF 画布重绘抢主线程，
 * 表现为特别卡甚至滑不动。适宽亚像素溢出（≤4px）只影响 `data-pdf-pan` 光标。
 *
 * 多指捏合（注入 scale 绑定）：Mozilla PDF.js 与漫画同一策略——进行中只做
 * CSS `scale()` 预览（不写 currentScale，避免每帧重栅格），松手才落一次
 * currentScale 并按两指中点做 pdfZoomAnchorScroll。基指固定为进入时的首两指；
 * 基指抬起但仍有 ≥2 指时重定基线。捏合期 touch-action 恒 none（含 sync()
 * 重估），结束恢复 pan-x pan-y。双击（280ms/36px）在适宽与 2× 间切换。
 * 窗口内单击暂扣；多指结束的吞 click 布防在下一次 pointerdown 清除。
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
  /** 写新的 currentScale（捏合只在松手落一次；双击立即写）。 */
  setCurrentScale(scale: number): void;
  /** 适合页宽基准（钳制区间 = fitWidthScale × steps 首尾档）。 */
  getFitWidthScale(): number;
  /** userZoom 档位（升序），即 pdf.ts 的 PDF_SCALE_STEPS。 */
  readonly steps: readonly number[];
}

export interface PdfDragPanHandle {
  /** 缩放/量页重排后重估横向溢出标记；捏合中保持 touch-action:none。 */
  sync(): void;
  release(): void;
}

/** 非捏合态：原生双轴滚动，禁止浏览器整页捏合抢走指针。 */
const PDF_IDLE_TOUCH_ACTION = 'pan-x pan-y';

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
  /** 已预览但尚未落盘的比例与锚点（松手提交 / 重定基线用）。 */
  let lastPinchScale: number | null = null;
  let lastPinchAnchor = { x: 0, y: 0 };
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
    // 捏合期恒 none：中途不得收敛成 pan，否则原生手势会 pointercancel 抢走剩余指。
    scroller.style.touchAction = pinch !== null ? 'none' : PDF_IDLE_TOUCH_ACTION;
    if (pdfPanOverflow(scroller)) {
      scroller.setAttribute('data-pdf-pan', 'true');
    } else {
      scroller.removeAttribute('data-pdf-pan');
    }
  };

  const pinchPreviewTarget = (): HTMLElement => {
    const viewer = scroller.querySelector<HTMLElement>('.pdfViewer');
    return viewer ?? scroller;
  };

  const writePinchPreview = (nextScale: number, anchorX: number, anchorY: number): void => {
    if (scaleBinding === undefined) {
      return;
    }
    const committed = scaleBinding.getCurrentScale();
    if (!Number.isFinite(committed) || committed <= 0) {
      return;
    }
    const ratio = nextScale / committed;
    const target = pinchPreviewTarget();
    target.style.transformOrigin = `${scroller.scrollLeft + anchorX}px ${scroller.scrollTop + anchorY}px`;
    target.style.transform = `scale(${ratio})`;
    target.style.willChange = 'transform';
    scroller.dataset.pdfPinchPreview = 'true';
  };

  const clearPinchPreview = (): void => {
    const target = pinchPreviewTarget();
    target.style.removeProperty('transform');
    target.style.removeProperty('transform-origin');
    target.style.removeProperty('will-change');
    delete scroller.dataset.pdfPinchPreview;
  };

  const fitBase = (): number => {
    const fit = scaleBinding?.getFitWidthScale();
    return fit !== undefined && Number.isFinite(fit) && fit > 0 ? fit : 1;
  };

  /**
   * 写比例并按锚点修正滚动（ratio = 新/旧 currentScale，锚点为滚动口偏移）。
   * 锚定修正以写比例前的滚动为基准：官方 currentScale setter 内部会同步重锚
   * 滚动口（#setScaleUpdatePages → scrollPageIntoView 按跟踪的 _location 赋
   * scrollLeft/Top ≈ pre×ratio），写入返回后再读已是重锚值——在其上叠加修正
   * 会把 scroll 项乘两次 ratio，非零阅读偏移下每个捏合帧/每次双击都过度修正
   * 跳读位。故先取写前偏移，写后用修正结果整体覆盖（内置重锚只留下一次正确
   * 的最终应用），不试图抑制官方内部行为。
   */
  const writeScaleAnchored = (nextScale: number, anchorX: number, anchorY: number): void => {
    if (scaleBinding === undefined) {
      return;
    }
    const current = scaleBinding.getCurrentScale();
    if (!Number.isFinite(current) || current <= 0) {
      return;
    }
    const preLeft = scroller.scrollLeft;
    const preTop = scroller.scrollTop;
    scaleBinding.setCurrentScale(nextScale);
    const corrected = pdfZoomAnchorScroll(preLeft, preTop, anchorX, anchorY, nextScale / current);
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

  const pinchAnchorFromPair = (
    points: Array<{ x: number; y: number }>,
  ): { x: number; y: number } => {
    const rect = scroller.getBoundingClientRect();
    return {
      x: (points[0]!.x + points[1]!.x) / 2 - rect.left,
      y: (points[0]!.y + points[1]!.y) / 2 - rect.top,
    };
  };

  /** 捏合进行中：只刷新 CSS 预览，不写 currentScale。 */
  const applyPendingPinchPreview = (): void => {
    const nextScale = pendingPinchScale;
    if (nextScale === null || pinch === null) {
      return;
    }
    pendingPinchScale = null;
    const points = pinchPair();
    if (points === null) {
      return;
    }
    const anchor = pinchAnchorFromPair(points);
    lastPinchScale = nextScale;
    lastPinchAnchor = anchor;
    writePinchPreview(nextScale, anchor.x, anchor.y);
  };

  /** 松手：撤预览，落一次 currentScale。 */
  const commitPinchScale = (): void => {
    const nextScale = pendingPinchScale ?? lastPinchScale;
    const points = pinch === null ? null : pinchPair();
    const anchor = points !== null ? pinchAnchorFromPair(points) : lastPinchAnchor;
    pendingPinchScale = null;
    lastPinchScale = null;
    clearPinchPreview();
    if (nextScale === null) {
      return;
    }
    writeScaleAnchored(nextScale, anchor.x, anchor.y);
  };

  const flushPinchFrame = (): void => {
    pinchFramePending = false;
    pinchFrameId = null;
    applyPendingPinchPreview();
  };

  const cancelPinchFrame = (): void => {
    pinchFramePending = false;
    if (pinchFrameId !== null && typeof view?.cancelAnimationFrame === 'function') {
      view.cancelAnimationFrame(pinchFrameId);
    }
    pinchFrameId = null;
  };

  /** 捏合结束：终笔比例落盘（同步），touch-action 恢复原生滚动。 */
  const endPinch = (): void => {
    cancelPinchFrame();
    commitPinchScale();
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
    const visual = pendingPinchScale ?? lastPinchScale ?? scaleBinding.getCurrentScale();
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
      startScale: visual,
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
          if (event.cancelable) {
            event.preventDefault();
          }
        }
      }
      return;
    }
    // 单指交给原生 pan-x pan-y，不再 JS 写 scroll（手机上会卡死画布）。
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
        if (event.cancelable) {
          event.preventDefault();
        }
        pendingPinchScale = pdfPinchScale(
          pinch.startScale,
          pinch.startDistance,
          distance,
          fitBase(),
          scaleBinding.steps,
        );
        // 锚点与终笔比例必须同步记下：松手可能发生在 rAF 预览之前，
        // 那时基指已离屏，commit 不能再 pinchPair，也不能退回 (0, 0)。
        lastPinchScale = pendingPinchScale;
        lastPinchAnchor = pinchAnchorFromPair(points);
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
  };

  const onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    const pointerId = pointer.pointerId ?? 0;
    const wasTracked = activePointers.delete(pointerId);
    onPointerRemoved(pointerId);
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
      lastPinchScale = null;
      clearPinchPreview();
      activePointers.clear();
      sawMultiTouch = false;
      dropHeldClick(); // 定时器/rAF 全清，暂扣 click 不再放行
      lastTap = null;
      scroller.removeAttribute('data-pdf-pan');
      scroller.removeAttribute('data-pdf-panning');
      scroller.style.touchAction = '';
      scroller.style.userSelect = '';
      swallowClick = false;
    },
  };
}
