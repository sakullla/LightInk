/**
 * `touch/reader-touch` — 阅读器触控翻页：点按左右热区与横向滑动。
 *
 * 只负责手势判定与回调；翻页动作由调用方注入（flow-renderer 帧内接
 * `advanceFlowPage`，宿主侧接滚轮同一入口 `advancePagedWheel`），中间区点按
 * 返回 null 让既有 click 路径（chrome 切换/链接/划选）原样工作。
 *
 * 桌面与部分 Android WebView iframe 没有可用的 touch 事件流，改走
 * `bindClickPaging` 同一热区；滚动版式由原生触控滚动承担，调用方用
 * `enabled` 门控只在翻页版式启用。
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
/** 左右点按热区宽度占比。 */
export const TOUCH_TAP_EDGE_RATIO = 0.25;

/**
 * 点按落点 → 翻页方向：左热区上一页、右热区下一页，中间区返回 null
 * （留给现有 click 行为，如 chrome 显隐切换）。
 */
export function resolveTapPageDirection(
  clientX: number,
  viewportWidth: number,
  edgeRatio: number = TOUCH_TAP_EDGE_RATIO,
): 1 | -1 | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return null;
  }
  const ratio = Math.min(0.5, Math.max(0, edgeRatio));
  if (ratio === 0) {
    return null;
  }
  if (clientX <= viewportWidth * ratio) {
    return -1;
  }
  if (clientX >= viewportWidth * (1 - ratio)) {
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
    const direction = resolveTapPageDirection(mouse.clientX, options.viewportWidth());
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

  const onTouchStart = (event: Event): void => {
    const touches = (event as TouchEventLike).touches;
    // 多指手势（缩放等）不参与翻页判定。
    const touch = touches !== undefined && touches.length === 1 ? touches[0] : undefined;
    start = touch === undefined ? null : { x: touch.clientX, y: touch.clientY, at: now() };
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
      direction = resolveTapPageDirection(touch.clientX, options.viewportWidth());
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

  return () => {
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchend', onTouchEnd);
    target.removeEventListener('touchcancel', onTouchCancel);
  };
}
