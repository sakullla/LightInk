/**
 * `touch/reader-touch` — 阅读器触控翻页：点按左右热区与横向滑动。
 *
 * 只负责手势判定与回调；翻页动作由调用方注入（flow-renderer 帧内接
 * `advanceFlowPage`，宿主侧接滚轮同一入口 `advancePagedWheel`），中间区点按
 * 返回 null 让既有 click 路径（chrome 切换/链接/划选）原样工作。
 *
 * 桌面与部分 Android WebView iframe 没有可用的 touch 事件流，改走
 * `bindClickPaging`：不传比例时沿用对称 TOUCH_TAP_EDGE_RATIO 桌面热区，
 * 触屏绑定点才显式注入非对称比例。滚动版式由原生触控滚动承担，调用方
 * 用 `enabled` 门控只在翻页版式启用。
 */

export interface TouchPointLike {
  clientX: number;
  clientY: number;
}

/** 点按判定上限（ms），超过视为长按/划选，不翻页。 */
export const TOUCH_TAP_MAX_MS = 350;
/** 点按允许的最大位移（px）。 */
export const TOUCH_TAP_MOVE_PX = 12;
/** 横向滑动翻页的最小位移（px）。 */
export const TOUCH_SWIPE_MIN_PX = 48;
/** 桌面 click 热区对称占比（左右各 25%）；ratio 缺省的 click 路径沿用此值。 */
export const TOUCH_TAP_EDGE_RATIO = 0.25;
/** 触屏左侧「上一页」点按热区宽度占比（触屏绑定点显式传入）。 */
export const TOUCH_TAP_PREV_RATIO = 0.2;
/** 触屏右侧「下一页」点按热区宽度占比（阅读推进更频繁，热区更宽）。 */
export const TOUCH_TAP_NEXT_RATIO = 0.3;
/** 屏幕左右外缘排除带宽度（px）：避让系统边缘手势（如 Android 返回）。 */
export const TOUCH_SYSTEM_EDGE_PX = 24;
/** 带内起始后若系统接管、没有合成 click，超时解除吞点击，避免误伤后续鼠标点击。 */
export const TOUCH_BAND_CLICK_SUPPRESS_MS = 400;

/**
 * 点按落点 → 翻页方向：左热区上一页、右热区下一页，中间区返回 null
 * （留给现有 click 行为，如 chrome 显隐切换）。左右热区占比独立，
 * 各自最大 0.5，保证中间留路不被吞掉。缺省保持桌面对称热区
 * （TOUCH_TAP_EDGE_RATIO），触屏绑定点显式注入非对称比例。
 */
export function resolveTapPageDirection(
  clientX: number,
  viewportWidth: number,
  prevRatio: number = TOUCH_TAP_EDGE_RATIO,
  nextRatio: number = TOUCH_TAP_EDGE_RATIO,
): 1 | -1 | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return null;
  }
  const prev = Math.min(0.5, Math.max(0, prevRatio));
  const next = Math.min(0.5, Math.max(0, nextRatio));
  if (prev > 0 && clientX <= viewportWidth * prev) {
    return -1;
  }
  if (next > 0 && clientX >= viewportWidth * (1 - next)) {
    return 1;
  }
  return null;
}

/** 横向滑动 → 翻页方向：左滑下一页、右滑上一页；垂直占优或距离不足返回 null。 */
export function resolveSwipePageDirection(
  dx: number,
  dy: number,
  minDistancePx: number = TOUCH_SWIPE_MIN_PX,
): 1 | -1 | null {
  if (Math.abs(dx) < minDistancePx || Math.abs(dx) <= Math.abs(dy)) {
    return null;
  }
  return dx < 0 ? 1 : -1;
}

interface TouchEventLike extends Event {
  touches?: ArrayLike<TouchPointLike>;
  changedTouches?: ArrayLike<TouchPointLike>;
}

export interface TouchPagingOptions {
  /** 翻页入口（复用现有翻页函数）；返回 true 表示成功翻页。 */
  page(direction: 1 | -1): boolean;
  /** 手势生效门控（如仅翻页版式）；touchend 时判定。 */
  enabled?(): boolean;
  /** 点按热区判定所用的视口宽度。 */
  viewportWidth(): number;
  /** 左侧「上一页」热区占比；缺省对称 TOUCH_TAP_EDGE_RATIO。 */
  tapPrevRatio?: number;
  /** 右侧「下一页」热区占比；缺省对称 TOUCH_TAP_EDGE_RATIO。 */
  tapNextRatio?: number;
  /** 点按判定上限（测试可注入）。 */
  tapMaxMs?: number;
  /** 时钟（测试可注入）。 */
  now?(): number;
}

/**
 * Desktop / WebView click paging: iframe and some Android WebViews never fire
 * touch events, so edge taps must use the same zones as bindTouchPaging.
 * Center clicks return without paging so chrome / link handlers still run.
 */
export function bindClickPaging(target: EventTarget, options: TouchPagingOptions): () => void {
  const onClick = (event: Event): void => {
    if (event.defaultPrevented) {
      return;
    }
    if (options.enabled !== undefined && !options.enabled()) {
      return;
    }
    const mouse = event as MouseEvent;
    if (typeof mouse.button === 'number' && mouse.button !== 0) {
      return;
    }
    if (typeof mouse.clientX !== 'number') {
      return;
    }
    const direction = resolveTapPageDirection(
      mouse.clientX,
      options.viewportWidth(),
      options.tapPrevRatio,
      options.tapNextRatio,
    );
    if (direction === null) {
      return;
    }
    if (options.page(direction)) {
      event.preventDefault();
      if (typeof mouse.stopPropagation === 'function') {
        mouse.stopPropagation();
      }
    }
  };
  target.addEventListener('click', onClick);
  return () => {
    target.removeEventListener('click', onClick);
  };
}

/** 绑定触控翻页手势；返回解绑函数。 */
export function bindTouchPaging(target: EventTarget, options: TouchPagingOptions): () => void {
  const tapMaxMs = options.tapMaxMs ?? TOUCH_TAP_MAX_MS;
  const now = options.now ?? (() => Date.now());
  let start: { x: number; y: number; at: number } | null = null;
  let suppressNextClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  const clearBandClickSwallowTimer = (): void => {
    if (suppressTimer === null) {
      return;
    }
    clearTimeout(suppressTimer);
    suppressTimer = null;
  };

  const disarmBandClickSwallow = (): void => {
    suppressNextClick = false;
    clearBandClickSwallowTimer();
  };

  const armBandClickSwallow = (): void => {
    suppressNextClick = true;
    clearBandClickSwallowTimer();
    suppressTimer = setTimeout(() => {
      suppressNextClick = false;
      suppressTimer = null;
    }, TOUCH_BAND_CLICK_SUPPRESS_MS);
  };

  const onTouchStart = (event: Event): void => {
    const touches = (event as TouchEventLike).touches;
    // 多指手势（缩放等）不参与翻页判定。
    const touch = touches !== undefined && touches.length === 1 ? touches[0] : undefined;
    if (touch === undefined) {
      start = null;
      return;
    }
    // 起始点落在左右外缘排除带内：本次手势整体不翻页，把边缘留给系统手势。
    // 系统没接管时浏览器仍会派发合成 click，落点在无排除带的 click 热区
    // （bindClickPaging / 帧内 click）会翻页，所以一次性吞掉这个 click。
    const width = options.viewportWidth();
    if (
      Number.isFinite(width) &&
      width > TOUCH_SYSTEM_EDGE_PX * 2 &&
      (touch.clientX <= TOUCH_SYSTEM_EDGE_PX || touch.clientX >= width - TOUCH_SYSTEM_EDGE_PX)
    ) {
      armBandClickSwallow();
      start = null;
      return;
    }
    disarmBandClickSwallow();
    start = { x: touch.clientX, y: touch.clientY, at: now() };
  };

  // 捕获阶段先于 click 翻页/切换 chrome 的监听器；一次性，消费后即失效。
  const onBandClick = (event: Event): void => {
    if (!suppressNextClick) {
      return;
    }
    disarmBandClickSwallow();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onTouchCancel = (): void => {
    start = null;
  };

  const onTouchEnd = (event: Event): void => {
    if (start === null) {
      return;
    }
    const from = start;
    start = null;
    if (options.enabled !== undefined && !options.enabled()) {
      return;
    }
    const changed = (event as TouchEventLike).changedTouches;
    const touch = changed !== undefined && changed.length > 0 ? changed[0] : undefined;
    if (touch === undefined) {
      return;
    }
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    let direction = resolveSwipePageDirection(dx, dy);
    if (
      direction === null &&
      now() - from.at <= tapMaxMs &&
      Math.abs(dx) <= TOUCH_TAP_MOVE_PX &&
      Math.abs(dy) <= TOUCH_TAP_MOVE_PX
    ) {
      direction = resolveTapPageDirection(
        touch.clientX,
        options.viewportWidth(),
        options.tapPrevRatio,
        options.tapNextRatio,
      );
    }
    if (direction === null) {
      return;
    }
    if (options.page(direction)) {
      // 翻页成功：抑制紧随的合成 click，避免连带触发 chrome 切换或链接。
      event.preventDefault();
    }
  };

  target.addEventListener('touchstart', onTouchStart, { passive: true });
  target.addEventListener('touchend', onTouchEnd, { passive: false });
  target.addEventListener('touchcancel', onTouchCancel, { passive: true });
  target.addEventListener('click', onBandClick, { capture: true });

  return () => {
    disarmBandClickSwallow();
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchend', onTouchEnd);
    target.removeEventListener('touchcancel', onTouchCancel);
    target.removeEventListener('click', onBandClick, { capture: true });
  };
}
