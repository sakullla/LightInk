/**
 * 统一 tooltip 层：给纯图标控件补上「看得见」的名字。
 *
 * 背景：全应用的图标按钮普遍只带 `aria-label`（屏幕阅读器可读，鼠标用户看不见），
 * 少量面板额外用原生 `title`（系统样式、延迟长、与主题脱节）。本模块用一层
 * 延迟挂载 + 视口内翻转/夹紧的自绘气泡统一承接，文案优先取 `data-tip`，
 * 其次从原生 `title` 收编，最后退回 `aria-label`。
 *
 * 行为约定：
 *   - 只有「没有可读文字」的控件才自动出气泡；带可见文字的按钮不重复提示，
 *     但显式写了 `data-tip` 的始终生效（需要补充快捷键等信息时用）。纯符号
 *     标签（`+`、`×`）不算可读文字，仍然会出气泡。
 *   - 键盘聚焦立即显示（键盘用户等不了悬停延迟），鼠标悬停走
 *     {@link TOOLTIP_SHOW_DELAY_MS} 延迟，避免掠过时闪烁。
 *   - `(hover: none)` 触屏环境关闭悬停提示，只保留聚焦提示；气泡本身
 *     `pointer-events: none`，永不拦截指针。
 *   - 滚动、按下、Esc、焦点/指针离开立即收起；气泡挂在 `doc.body` 上用
 *     `position: fixed` 定位，滚动时直接隐藏而不是跟随重算。
 *   - 收编原生 `title` 时会改写该属性。收编是幂等的，且只在真正要出气泡时
 *     发生，因此单元测试直接断言 `getAttribute('title')` 不受影响。
 */

/** 鼠标悬停到显示的延迟。掠过式移动不该被一串气泡打断。 */
export const TOOLTIP_SHOW_DELAY_MS = 420;
/** 离开到隐藏的延迟，跨过相邻控件的边界时不至于频闪。 */
export const TOOLTIP_HIDE_DELAY_MS = 90;
/** 气泡与视口边缘的最小留白。 */
export const TOOLTIP_EDGE_PADDING_PX = 8;
/** 气泡与锚点之间的间距。 */
export const TOOLTIP_POINTER_OFFSET_PX = 8;
/** 箭头允许偏离气泡两端的余量，避免贴边时被裁掉。 */
const ARROW_INSET_MIN_PX = 10;

/**
 * 可能承载 tooltip 的交互控件。刻意不含裸 div/span：它们身上的
 * `aria-label` 往往是给整块区域读的，冒泡只会制造噪音。
 */
const TOOLTIPABLE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="slider"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="range"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
].join(', ');

export interface TooltipOptions {
  readonly doc?: Document;
  /** 覆盖悬停延迟（测试传 0 立即）。 */
  readonly showDelayMs?: number;
  /** 覆盖聚焦延迟（测试传 0 立即）。 */
  readonly focusDelayMs?: number;
  /** 强制关闭（测试/触屏环境）。 */
  readonly disabled?: boolean;
}

/**
 * 「能当名字」的字符：字母、数字，或中日韩等表意文字。
 *
 * 只有符号（`+`、`×`、`…`、`−`）的按钮不算有可见标签——它对用户不构成
 * 可读的名字，正需要气泡来补。反过来，「目录」「All」这类才算自带名字。
 */
const MEANINGFUL_TEXT = /[\p{L}\p{N}]/u;

/** 一个控件是否已有可读的可见文字——只有这类才需要跳过自动气泡。 */
function hasVisibleText(element: Element): boolean {
  // 只看直接文本节点：图标按钮内部常带 <title>/<desc> 之类的 SVG 文本，
  // 那些不是给用户看的标签，不该把气泡判成「重复」。
  let text = '';
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) text += node.nodeValue ?? '';
  }
  return MEANINGFUL_TEXT.test(text);
}

/** 从当前事件目标向上找最近的可用锚点。 */
function findAnchor(target: EventTarget | null, doc: Document): HTMLElement | null {
  if (target === null || !(target instanceof Element)) return null;
  const closest = target.closest<HTMLElement>(TOOLTIPABLE_SELECTOR);
  if (closest === null || !doc.contains(closest)) return null;
  if ((closest as HTMLElement & { disabled?: boolean }).disabled === true) return null;
  if (closest.getAttribute('aria-hidden') === 'true') return null;
  return closest;
}

/**
 * 解析气泡文案，`null` 表示这个控件不该出气泡。
 *
 * `data-tip` 是显式 opt-in，永远优先（含「带可见文字也要补充」的用法）；
 * 其余来源要求控件没有可见文字，避免和屏幕上的标签重复。
 */
function resolveTooltipText(anchor: HTMLElement, adoptNativeTitle: boolean): string | null {
  const explicit = anchor.getAttribute('data-tip');
  if (explicit !== null) {
    const trimmed = explicit.trim();
    // `data-tip=""` 是明确的「不要气泡」开关（原生 `title` 收编后必然走到这里）。
    return trimmed === '' ? null : trimmed;
  }
  if (hasVisibleText(anchor)) return null;
  if (adoptNativeTitle) {
    const native = anchor.getAttribute('title');
    if (native !== null && native.trim() !== '') {
      // 收编：写进 data-tip 再摘掉原生属性，避免系统气泡与自绘气泡同时出现。
      // 幂等——第二次进来 data-tip 已在，走上面的显式分支。
      anchor.setAttribute('data-tip', native);
      anchor.removeAttribute('title');
      return native.trim();
    }
  }
  const label = anchor.getAttribute('aria-label');
  if (label === null) return null;
  const trimmed = label.trim();
  return trimmed === '' ? null : trimmed;
}

function matchesHoverCapable(doc: Document): boolean {
  const view = doc.defaultView;
  // jsdom / 老 WebView 没有 matchMedia：按可悬停处理，保证行为可测。
  if (view === null || typeof view.matchMedia !== 'function') return true;
  try {
    return view.matchMedia('(hover: hover)').matches;
  } catch {
    return true;
  }
}

/** `(hover: hover)` 查询对象；环境不支持时返回 null（按可悬停处理）。 */
function safeHoverMedia(view: Window | null): MediaQueryList | null {
  if (view === null || typeof view.matchMedia !== 'function') return null;
  try {
    return view.matchMedia('(hover: hover)');
  } catch {
    return null;
  }
}

/** 把气泡夹进视口并决定上下翻转，同时给箭头算出水平偏移。 */
function placeTooltip(node: HTMLElement, anchor: HTMLElement, doc: Document): void {
  const anchorRect = anchor.getBoundingClientRect();
  const tooltipRect = node.getBoundingClientRect();
  const view = doc.defaultView;
  const viewportWidth = view?.innerWidth ?? anchorRect.right + 240;
  const viewportHeight = view?.innerHeight ?? anchorRect.bottom + 160;

  const fitsAbove = anchorRect.top - TOOLTIP_POINTER_OFFSET_PX - tooltipRect.height >= TOOLTIP_EDGE_PADDING_PX;
  const placement = fitsAbove ? 'top' : 'bottom';
  const rawY = fitsAbove
    ? anchorRect.top - TOOLTIP_POINTER_OFFSET_PX - tooltipRect.height
    : anchorRect.bottom + TOOLTIP_POINTER_OFFSET_PX;
  // 锚点贴边、上下都放不下（极矮窗口）时，至少别让气泡整体掉出视口。
  const maxY = Math.max(
    TOOLTIP_EDGE_PADDING_PX,
    viewportHeight - tooltipRect.height - TOOLTIP_EDGE_PADDING_PX,
  );
  const y = Math.min(Math.max(rawY, TOOLTIP_EDGE_PADDING_PX), maxY);

  const minX = TOOLTIP_EDGE_PADDING_PX;
  const maxX = Math.max(minX, viewportWidth - tooltipRect.width - TOOLTIP_EDGE_PADDING_PX);
  const centered = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
  const x = Math.min(Math.max(centered, minX), maxX);

  // 箭头跟着锚点中心走；夹紧后不能越出气泡两端。
  const arrowCenter = anchorRect.left + anchorRect.width / 2 - x;
  const arrowLimit = Math.max(
    ARROW_INSET_MIN_PX,
    tooltipRect.width - ARROW_INSET_MIN_PX,
  );

  node.dataset.placement = placement;
  node.style.setProperty(
    '--lightink-tooltip-arrow-x',
    `${Math.round(Math.min(Math.max(arrowCenter, ARROW_INSET_MIN_PX), arrowLimit))}px`,
  );
  node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

export interface TooltipController {
  /** 立即收起当前气泡（切工作区、开关浮层时调用）。 */
  hide(): void;
  dispose(): void;
}

interface ActiveTooltip {
  readonly anchor: HTMLElement;
  readonly text: string;
}

const controllers = new WeakMap<Document, TooltipController>();

function createTooltipController(options: TooltipOptions): TooltipController {
  const resolved = options.doc ?? (typeof document === 'undefined' ? null : document);
  if (resolved === null || resolved.body === null) {
    return { hide: () => {}, dispose: () => {} };
  }
  // 显式标注类型：后面所有闭包都捕获这个常量，不必重复判空。
  const doc: Document = resolved;
  const hoverDelay = options.showDelayMs ?? TOOLTIP_SHOW_DELAY_MS;
  const focusDelay = options.focusDelayMs ?? 0;
  const disabled = options.disabled === true;

  let node: HTMLElement | null = null;
  let active: ActiveTooltip | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverCapable = matchesHoverCapable(doc);

  function ensureNode(): HTMLElement {
    if (node !== null && node.isConnected) return node;
    const created = doc.createElement('div');
    created.className = 'lightink-tooltip';
    // 装饰层：文案已由锚点的 aria-label / data-tip 提供给辅助技术，
    // 这里再播报一次就是纯重复。
    created.setAttribute('aria-hidden', 'true');
    created.dataset.placement = 'top';
    created.hidden = true;
    doc.body.appendChild(created);
    node = created;
    return created;
  }

  function clearTimers(): void {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hide(): void {
    clearTimers();
    active = null;
    if (node === null || node.hidden) return;
    node.hidden = true;
    node.classList.remove('lightink-tooltip-in');
  }

  function scheduleHide(): void {
    clearTimers();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hide();
    }, TOOLTIP_HIDE_DELAY_MS);
  }

  function show(anchor: HTMLElement, text: string): void {
    clearTimers();
    const target = ensureNode();
    if (target.textContent !== text) target.textContent = text;
    // 先量再显示：hidden 时 getBoundingClientRect 全是 0，定位会算歪。
    target.hidden = false;
    placeTooltip(target, anchor, doc);
    target.classList.add('lightink-tooltip-in');
    active = { anchor, text };
  }

  function present(anchor: HTMLElement): void {
    if (disabled) return;
    const text = resolveTooltipText(anchor, true);
    if (text === null) return;
    if (active !== null && active.anchor === anchor && active.text === text) return;
    show(anchor, text);
  }

  function scheduleShow(anchor: HTMLElement, delay: number): void {
    clearTimers();
    if (disabled) return;
    showTimer = setTimeout(() => {
      showTimer = null;
      present(anchor);
    }, delay);
  }

  function onMouseOver(event: Event): void {
    if (!hoverCapable) return;
    const anchor = findAnchor(event.target, doc);
    if (anchor === null) return;
    scheduleShow(anchor, hoverDelay);
  }

  function onMouseOut(event: Event): void {
    if (active === null && showTimer === null) return;
    const anchor = active?.anchor;
    const related = (event as MouseEvent).relatedTarget;
    // 移到同一控件的子节点上不算离开，否则图标+文字按钮内部会闪。
    if (anchor !== undefined && anchor !== null && related instanceof Node && anchor.contains(related)) {
      return;
    }
    scheduleHide();
  }

  function onFocusIn(event: Event): void {
    const anchor = findAnchor(event.target, doc);
    if (anchor === null) return;
    scheduleShow(anchor, focusDelay);
  }

  function onFocusOut(event: Event): void {
    const anchor = active?.anchor;
    const related = (event as FocusEvent).relatedTarget;
    if (anchor !== undefined && anchor !== null && related instanceof Node && anchor.contains(related)) {
      return;
    }
    scheduleHide();
  }

  function onKeyDown(event: Event): void {
    if ((event as KeyboardEvent).key === 'Escape') hide();
  }

  // 按下与滚动都立即收起：气泡是 fixed 定位，锚点一动位置就废了，
  // 与其逐帧重算不如直接让位。按下用捕获相位，先于控件自己的处理收起。
  const onDismiss = (): void => {
    hide();
  };

  const view = doc.defaultView;
  doc.addEventListener('mouseover', onMouseOver);
  doc.addEventListener('mouseout', onMouseOut);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('mousedown', onDismiss, true);
  doc.addEventListener('scroll', onDismiss, true);
  view?.addEventListener('blur', onDismiss);

  // 触屏热插拔（接上/拔掉鼠标）时重新判定是否允许悬停提示。
  const hoverQuery = safeHoverMedia(view);
  const onHoverChange = (): void => {
    hoverCapable = matchesHoverCapable(doc);
    if (!hoverCapable) hide();
  };
  hoverQuery?.addEventListener?.('change', onHoverChange);

  return {
    hide: () => hide(),
    dispose() {
      clearTimers();
      hide();
      doc.removeEventListener('mouseover', onMouseOver);
      doc.removeEventListener('mouseout', onMouseOut);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('mousedown', onDismiss, true);
      doc.removeEventListener('scroll', onDismiss, true);
      view?.removeEventListener('blur', onDismiss);
      hoverQuery?.removeEventListener?.('change', onHoverChange);
      node?.remove();
      node = null;
      controllers.delete(doc);
    },
  };
}

/**
 * 安装 tooltip 层。同一个 document 重复调用返回既有控制器，
 * 避免重复监听与重复气泡。
 */
export function installTooltips(options: TooltipOptions = {}): TooltipController {
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document);
  if (doc === null) return { hide: () => {}, dispose: () => {} };
  const existing = controllers.get(doc);
  if (existing !== undefined) return existing;
  const controller = createTooltipController(options);
  controllers.set(doc, controller);
  return controller;
}
