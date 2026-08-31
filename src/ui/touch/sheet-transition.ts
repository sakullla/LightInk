/**
 * `touch/sheet-transition` — 触屏底部 sheet 的开关过渡（T3）。
 *
 * 装配点（书架 groups/filter sheet、阅读器目录/排版面板、标注融合侧栏、
 * 划选工具条）把 `hidden` 瞬跳换成 data-open class 驱动：
 *   - 打开：调用方先摘 hidden、装配好几何（pin/display），再 revealSheet ——
 *     强制一次样式回流让「关闭位」先成为 computed style，随后挂 data-open，
 *     CSS transition（220ms translateY+opacity，见各样式表）从关闭位滑入；
 *   - 关闭：concealSheet 摘 data-open，transitionend（兜底 timeout 240ms）
 *     后才执行 settle（置 hidden / 清 display）。
 *
 * 桌面与测试环境（jsdom 无样式表）下 computed transition-duration 为 0，
 * settle 同步落地 —— 与既有瞬跳行为等价，既有断言不动。reduce-motion 显式
 * matchMedia 短路（直接调用 window.matchMedia，不缓存未绑定的函数引用——
 * T2 的 P0 教训），CSS 侧依赖 theme.css 全局 kill-switch。
 *
 * 与 sheet-drag 的互斥：拖拽期间 sheet-drag 在 sheet 上写内联
 * `transition: none`（压掉本过渡），释放后由 snapBack 用自己的 200ms 回弹。
 */

/** 关闭过渡兜底时长（ms）：transitionend 未到（含 jsdom/被中断）时的保底。 */
export const SHEET_TRANSITION_FALLBACK_MS = 240;

/** 同一容器的操作代数：过渡中途反向（开立即关/关立即开）时丢弃过期 settle。 */
const closeGenerations = new WeakMap<HTMLElement, number>();

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

/** 面板 computed transition-duration（取第一段，ms）；无样式/解析失败为 0。 */
function transitionDurationMs(panel: HTMLElement): number {
  const view = panel.ownerDocument?.defaultView ?? null;
  if (view === null || typeof view.getComputedStyle !== 'function') {
    return 0;
  }
  let raw = '';
  try {
    raw = String(view.getComputedStyle(panel).transitionDuration ?? '');
  } catch {
    return 0;
  }
  const first = raw.split(',')[0]?.trim() ?? '';
  if (first === '') {
    return 0;
  }
  const seconds = /^([\d.]+)s$/.exec(first);
  if (seconds !== null) {
    return Math.round(Number.parseFloat(seconds[1]!) * 1000);
  }
  const millis = /^([\d.]+)ms$/.exec(first);
  if (millis !== null) {
    return Math.round(Number.parseFloat(millis[1]!));
  }
  return 0;
}

function bumpGeneration(container: HTMLElement): number {
  const next = (closeGenerations.get(container) ?? 0) + 1;
  closeGenerations.set(container, next);
  return next;
}

/**
 * 打开：调用方已摘 hidden、几何已就位后调用。panel 是视觉过渡元素
 * （书架 sheet 的 dialog；面板/工具条即本体），先强制回流让 `:not([data-open])`
 * 的关闭位落地，再挂 data-open 触发进场过渡（jsdom 中 offsetHeight 为 0，无害）。
 */
export function revealSheet(container: HTMLElement, panel: HTMLElement = container): void {
  bumpGeneration(container);
  void (panel.offsetHeight ?? 0);
  container.dataset.open = '';
}

/**
 * 关闭：摘 data-open 触发退场过渡；过渡收尾（transitionend 或兜底 timeout）
 * 后执行 settle（置 hidden 等）。桌面/jsdom/reduce-motion 无过渡时同步落地。
 */
export function concealSheet(
  container: HTMLElement,
  settle: () => void,
  panel: HTMLElement = container,
): void {
  const generation = bumpGeneration(container);
  if (container.dataset.open !== undefined) {
    delete container.dataset.open;
  }
  const apply = (): void => {
    // 过渡期间被 reveal/再次 conceal 抢占：过期 settle 丢弃，避免把
    // 重新打开的 sheet 拉回 hidden（僵尸关闭态）。
    if (closeGenerations.get(container) === generation) {
      settle();
    }
  };
  if (prefersReducedMotion() || transitionDurationMs(panel) <= 0 || typeof setTimeout !== 'function') {
    apply();
    return;
  }
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
    panel.removeEventListener('transitionend', onEnd);
    apply();
  };
  const onEnd = (event: TransitionEvent): void => {
    if (event.target !== panel || event.propertyName !== 'transform') {
      return;
    }
    finish();
  };
  panel.addEventListener('transitionend', onEnd);
  timer = setTimeout(finish, SHEET_TRANSITION_FALLBACK_MS);
}
