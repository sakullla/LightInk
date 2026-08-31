/**
 * `touch/long-press` — 长按手势（约 500ms，移动阈值互斥）。
 *
 * 触发源复用：长按只负责判定与回调，菜单模型与渲染由调用方走既有
 * `createContextMenu` 入口（书架条目/分组长按即路由到同一渲染路径）。
 *
 * 互斥语义：
 *   - 计时器到期前 touchend/touchcancel → 普通点按，不触发长按；
 *   - 移动超过阈值（默认 10px）→ 取消长按，让位滚动/拖动；
 *   - 长按触发后吞掉紧随的合成 click（防止点按动作连带触发，如误打开书）
 *     与原生 contextmenu（Android WebView 长按会派发，防止与长按菜单重复弹出）。
 *
 * 只依赖 EventTarget 与触摸坐标，jsdom 可用伪造触摸事件测试。
 */

export interface LongPressPosition {
  x: number;
  y: number;
}

export interface LongPressOptions {
  /** 长按触发回调，坐标为 touchstart 落点（clientX/clientY）。 */
  onLongPress(position: LongPressPosition): void;
  /**
   * 按住开始（touchstart 落点并已武装计时）——调用方可加按住反馈
   * （如 .is-pressing 门控类）。仅在单指落点后才回调。
   */
  onPressStart?: (position: LongPressPosition) => void;
  /**
   * 按住反馈收尾：500ms 计时内任何取消（提前抬手/移动越界）或长按触发
   * 时回调（每次按住至多一次），调用方据此移除 .is-pressing 等反馈。
   */
  onPressCancel?: () => void;
  /** 长按计时，默认 500ms。 */
  delayMs?: number;
  /** 移动取消阈值（px），默认 10。 */
  moveThresholdPx?: number;
}

interface TouchPointLike {
  clientX: number;
  clientY: number;
}

interface TouchEventLike extends Event {
  touches?: ArrayLike<TouchPointLike>;
}

function firstTouch(event: Event): TouchPointLike | undefined {
  const touches = (event as TouchEventLike).touches;
  if (touches === undefined || touches.length !== 1) {
    return undefined;
  }
  return touches[0];
}

/** 绑定长按手势；返回解绑函数。 */
export function bindLongPress(target: EventTarget, options: LongPressOptions): () => void {
  const delayMs = options.delayMs ?? 500;
  const threshold = options.moveThresholdPx ?? 10;
  let startX = 0;
  let startY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let pressing = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 收掉按住反馈（幂等）：提前抬手/移动越界/长按触发/解绑时调用。 */
  const clearPressing = (): void => {
    if (!pressing) {
      return;
    }
    pressing = false;
    options.onPressCancel?.();
  };

  const clearResetTimer = (): void => {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  };

  // 长按触发后吞掉紧随的 click/contextmenu（原生 contextmenu 与合成 click 可能
  // 相继派发，二者都要吞）。stopImmediatePropagation：书架卡片自身的
  // click/contextmenu 监听挂在同一元素上（at-target 阶段按注册顺序派发，本监听
  // 先于它们注册）。fired 由 touchend 后的兜底计时器复位，不在此处复位。
  const swallow = (event: Event): void => {
    if (!fired) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onTouchStart = (event: Event): void => {
    const touch = firstTouch(event);
    if (touch === undefined) {
      clearTimer();
      return;
    }
    startX = touch.clientX;
    startY = touch.clientY;
    clearTimer();
    if (!pressing) {
      pressing = true;
      options.onPressStart?.({ x: startX, y: startY });
    }
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      clearPressing();
      options.onLongPress({ x: startX, y: startY });
    }, delayMs);
  };

  const onTouchMove = (event: Event): void => {
    if (timer === null) {
      return;
    }
    const touch = firstTouch(event);
    if (touch === undefined) {
      return;
    }
    if (Math.abs(touch.clientX - startX) > threshold || Math.abs(touch.clientY - startY) > threshold) {
      clearTimer();
      clearPressing();
    }
  };

  const onTouchEnd = (event: Event): void => {
    clearTimer();
    clearPressing();
    if (fired) {
      // 抑制合成 click（真实浏览器中 preventDefault touchend 即拦截 click；
      // 捕获阶段的 swallow 监听是双保险，也覆盖测试环境手动派发 click）。
      event.preventDefault();
      // 兜底复位：click/contextmenu 未派发（或被 touchend preventDefault 吞掉）
      // 时不能永久处于 fired 状态，否则下一次正常点按被误吞。
      clearResetTimer();
      resetTimer = setTimeout(() => {
        fired = false;
        resetTimer = null;
      }, 400);
    }
  };

  target.addEventListener('touchstart', onTouchStart, { passive: true });
  target.addEventListener('touchmove', onTouchMove, { passive: true });
  target.addEventListener('touchend', onTouchEnd, { passive: false });
  target.addEventListener('touchcancel', onTouchEnd, { passive: true });
  target.addEventListener('click', swallow, true);
  target.addEventListener('contextmenu', swallow, true);

  return () => {
    clearTimer();
    clearResetTimer();
    clearPressing();
    target.removeEventListener('touchstart', onTouchStart);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('touchend', onTouchEnd);
    target.removeEventListener('touchcancel', onTouchEnd);
    target.removeEventListener('click', swallow, true);
    target.removeEventListener('contextmenu', swallow, true);
  };
}
