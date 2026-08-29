/**
 * 大纲侧栏视图（T7, R7）：实时大纲列表 + 点击跳转 + 三态显示。
 *
 * 职责：
 *   - Markdown：按活动标签内容重建大纲（`buildOutline`）；
 *   - 阅读器：消费 ReaderInstance.getOutline（PDF 书签 / EPUB 章节 / CBZ 页）；
 *   - `scheduleRefresh()` 防抖重算（默认 250ms），由 TabManager 的
 *     `onActiveContentChanged` 回调驱动（切换标签/活动标签内容变化）；
 *   - 点击条目 → Markdown 按序号锚点滚到 h1-h6；阅读器走 jumpToOutlineItem；
 *   - 显示三态循环（菜单 / Ctrl+Shift+L / 侧栏按钮）：
 *       expanded → rail（窄条 »）→ hidden（完全隐藏）→ expanded
 *   - T4/R2 折叠联动：条目左侧三角显示编辑器对应标题的折叠态、点击切换；
 *     大纲始终渲染完整标题列表——编辑器侧折叠只隐藏编辑器正文，不在大纲中
 *     级联隐藏子条目（两个视图保持独立，大纲作为完整导航目录不被折叠影响）。
 *   - Expanded 态右侧拖动手柄可调宽度，写入 localStorage `lightink.outlineWidth`。
 *   - 搜索过滤与当前项高亮/滚入视口与阅读器 TOC 浮层共用 outline-model。
 *
 * 可测试性：DOM 创建经 `doc` 注入、宿主/内容经 `getActiveHost` /
 * `getActiveMarkdown` 注入，node 环境下以 fake 元素驱动全部行为。
 * 样式类见 src/ui/theme.css，配色全部取主题令牌。
 */

import {
  buildOutline,
  filterOutlineItems,
  lastCurrentOutlineIndex,
  leafHeadingAnchors,
  outlineItemIsCurrent,
  outlineSearchKeyAction,
  outlineSearchKeyIsComposing,
  scrollChildIntoScroller,
  type OutlineItem,
  type OutlineLocation,
} from './outline-model.js';
import type { MessageKey } from '../i18n/messages.js';

/** 渲染侧标题选择器：与 buildOutline 收集的 heading 一一对应（文档顺序）。 */
const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

const DEFAULT_DEBOUNCE_MS = 250;

/** localStorage key for user-resized outline width (px). */
export const OUTLINE_WIDTH_STORAGE_KEY = 'lightink.outlineWidth';

/** Default / clamp bounds for the drag-resizable outline. */
export const OUTLINE_WIDTH_DEFAULT = 220;
export const OUTLINE_WIDTH_MIN = 160;
export const OUTLINE_WIDTH_MAX = 480;

/** expanded: full panel; rail: narrow reopen strip; hidden: no sidebar chrome. */
export type OutlineVisibility = 'expanded' | 'rail' | 'hidden';

const VISIBILITY_CYCLE: readonly OutlineVisibility[] = ['expanded', 'rail', 'hidden'];

export interface OutlineViewDeps {
  /** 当前活动标签的宿主元素（无活动标签时返回 null）。 */
  getActiveHost(): HTMLElement | null;
  /** 当前活动标签的 markdown（无活动标签或读取失败时返回 null）。 */
  getActiveMarkdown(): string | null;
  /** 阅读器大纲；缺省或返回 null 时回退 markdown。 */
  getActiveReaderOutline?: () => readonly OutlineItem[] | null;
  /** 阅读器大纲跳转；有 page/chapter 的条目优先走这里。 */
  jumpToReaderOutlineItem?: (item: OutlineItem) => void;
  /** 当前阅读/编辑位置；用于高亮并在打开目录时滚到该项。 */
  getActiveLocation?: () => OutlineLocation;
  /**
   * T4/R2：当前活动 markdown 标签已折叠标题的序号列表（与 anchor 同口径）。无活动
   * markdown 标签或缺省时视为「无折叠」。供大纲渲染折叠标记态。
   */
  getFoldedOrdinals?: () => number[];
  /**
   * T4/R2：切换第 ordinal 个标题的折叠态（点击大纲折叠标记 → 联动编辑器）。
   * 缺省时大纲折叠标记不渲染为可点击。
   */
  toggleFoldAtOrdinal?: (ordinal: number) => void;
  /** DOM 创建入口（生产为全局 document，测试注入 fake）。 */
  doc?: Document;
  /** 重算防抖间隔（毫秒），默认 250。 */
  debounceMs?: number;
  /** Translate UI strings (en / zh-CN). */
  t?: (key: MessageKey) => string;
  /**
   * Persist outline width. Production: window.localStorage.
   * Tests may inject a Map-backed fake.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** 大纲三态可见性变化回调（生产用于触发分栏重算）。 */
  onVisibilityChange?: () => void;
}

export interface OutlineView {
  /** 侧栏根元素（由调用方挂入外壳的侧栏槽位）。 */
  readonly root: HTMLElement;
  /** Current visibility mode. */
  readonly visibility: OutlineVisibility;
  /**
   * Backward-compatible: true when not fully expanded (rail or hidden).
   * Prefer `visibility` for new code.
   */
  readonly collapsed: boolean;
  /** Current expanded-panel width in px (user-resized or default). */
  readonly widthPx: number;
  /** Cycle expanded → rail → hidden → expanded. */
  toggleCollapse(): void;
  /** Set exact visibility (immersive / fullscreen / tests). */
  setVisibility(next: OutlineVisibility): void;
  /**
   * Backward-compatible boolean API:
   *   true  → rail (narrow strip, one click to expand)
   *   false → expanded
   * For full hide use setVisibility('hidden').
   */
  setCollapsed(next: boolean): void;
  /** Set expanded width (clamped + persisted). No-op when not a finite number. */
  setWidth(px: number): void;
  /** 防抖调度一次大纲重算（内容变化/切换标签时调用）。 */
  scheduleRefresh(): void;
  /** 立即重算并渲染（绕过防抖）。 */
  refreshNow(): void;
  /** Re-apply localized chrome strings after language switch. */
  retranslate(): void;
  /** 清理待执行的防抖计时器 / 拖动监听。 */
  destroy(): void;
}

/** Clamp outline width into the supported range. */
export function clampOutlineWidth(px: number): number {
  if (!Number.isFinite(px)) return OUTLINE_WIDTH_DEFAULT;
  return Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, Math.round(px)));
}

/** Read a stored width; invalid / missing → null. */
export function readStoredOutlineWidth(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): number | null {
  if (storage === null || storage === undefined) return null;
  try {
    const raw = storage.getItem(OUTLINE_WIDTH_STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return clampOutlineWidth(n);
  } catch {
    return null;
  }
}

/** Persist width; ignores storage failures (private mode). */
export function writeStoredOutlineWidth(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  px: number,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(OUTLINE_WIDTH_STORAGE_KEY, String(clampOutlineWidth(px)));
  } catch {
    /* ignore quota / private mode */
  }
}

function nextVisibility(current: OutlineVisibility): OutlineVisibility {
  const idx = VISIBILITY_CYCLE.indexOf(current);
  return VISIBILITY_CYCLE[(idx + 1) % VISIBILITY_CYCLE.length] ?? 'expanded';
}

/** Chinese fallbacks when host does not inject `t` (tests / headless). */
const OUTLINE_DEFAULTS: Readonly<Record<string, string>> = {
  'outline.title': '大纲',
  'outline.collapse': '折叠大纲',
  'outline.expand': '展开大纲',
  'outline.show': '显示大纲',
  'outline.noTab': '无活动标签',
  'outline.empty': '暂无标题',
  'outline.search': '搜索',
  'outline.emptySearch': '没有匹配的条目',
  'outline.searchCount': '{n} 条匹配',
  'outline.resize': '拖动调整大纲宽度',
};

export function createOutlineView(deps: OutlineViewDeps): OutlineView {
  const doc = deps.doc ?? document;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const storage =
    deps.storage ??
    (typeof window !== 'undefined' ? window.localStorage : undefined);
  const t = (key: MessageKey): string => {
    if (deps.t !== undefined) {
      const translated = deps.t(key);
      // Host may return the key itself for missing entries — fall back.
      if (translated !== key) return translated;
    }
    return OUTLINE_DEFAULTS[key] ?? key;
  };

  const root = doc.createElement('div');
  root.classList.add('lightink-outline');
  root.dataset.visibility = 'expanded';

  const header = doc.createElement('div');
  header.classList.add('lightink-outline-header');
  const title = doc.createElement('span');
  title.classList.add('lightink-outline-title');
  title.textContent = t('outline.title');
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.classList.add('lightink-outline-toggle');
  toggle.setAttribute('title', t('outline.collapse'));
  toggle.setAttribute('aria-label', t('outline.collapse'));
  toggle.setAttribute('aria-expanded', 'true');
  toggle.textContent = '«';
  header.appendChild(title);
  header.appendChild(toggle);

  const listId = 'lightink-outline-list';
  const search = doc.createElement('input');
  search.type = 'search';
  search.classList.add('lightink-outline-search');
  search.setAttribute('type', 'search');
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-expanded', 'false');
  search.setAttribute('aria-controls', listId);
  search.setAttribute('aria-label', t('outline.search'));
  search.setAttribute('placeholder', t('outline.search'));
  search.setAttribute('autocomplete', 'off');
  search.setAttribute('hidden', '');

  const live = doc.createElement('div');
  live.classList.add('lightink-outline-live');
  live.setAttribute('aria-live', 'polite');

  const body = doc.createElement('div');
  body.id = listId;
  body.classList.add('lightink-outline-body');
  body.setAttribute('role', 'listbox');
  body.setAttribute('aria-label', t('outline.title'));

  // Right-edge drag handle (expanded only). After body so tests can find
  // `.lightink-outline-body` / `.lightink-outline-resize` by class.
  const resizeHandle = doc.createElement('div');
  resizeHandle.classList.add('lightink-outline-resize');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  resizeHandle.setAttribute('aria-label', t('outline.resize'));
  resizeHandle.setAttribute('title', t('outline.resize'));

  root.appendChild(header);
  root.appendChild(search);
  root.appendChild(live);
  root.appendChild(body);
  root.appendChild(resizeHandle);

  let visibility: OutlineVisibility = 'expanded';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let widthPx = readStoredOutlineWidth(storage) ?? OUTLINE_WIDTH_DEFAULT;
  let dragCleanup: (() => void) | null = null;
  let searchQuery = '';
  let lastOutlineIdentity = '';
  let visibleItems: OutlineItem[] = [];
  let activeIndex = 0;

  function applyWidth(px: number, persist: boolean): void {
    widthPx = clampOutlineWidth(px);
    // Inline width only in expanded mode; rail/hidden use CSS classes.
    if (visibility === 'expanded') {
      root.style.width = `${widthPx}px`;
      try {
        // Optional CSS var for consumers; fake DOMs may lack setProperty.
        const style = root.style as CSSStyleDeclaration & {
          setProperty?: (name: string, value: string) => void;
        };
        if (typeof style.setProperty === 'function') {
          style.setProperty('--lightink-outline-width', `${widthPx}px`);
        }
      } catch {
        /* ignore */
      }
    }
    if (persist) {
      writeStoredOutlineWidth(storage, widthPx);
    }
  }

  // Restore persisted width on first paint (expanded default).
  applyWidth(widthPx, false);

  /** 点击跳转：按序号锚点取活动宿主中第 n 个 h1-h6 并滚动到视口顶部。 */
  function scrollToItem(item: OutlineItem): void {
    try {
      if (item.page !== undefined || item.chapter !== undefined) {
        deps.jumpToReaderOutlineItem?.(item);
        return;
      }
      const host = deps.getActiveHost();
      if (host === null || typeof host.querySelectorAll !== 'function') {
        return;
      }
      const headings = host.querySelectorAll(HEADING_SELECTOR);
      const el = headings[item.anchor] as HTMLElement | undefined;
      // Source-mode overlay may hide WYSIWYG headings; never throw on missing target.
      if (el !== undefined && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start' });
      }
    } catch {
      // Defensive: outline jump must not break immersive shell (R4).
    }
  }

  function setSearchChrome(visible: boolean): void {
    search.setAttribute('aria-expanded', visible ? 'true' : 'false');
    if (visible) {
      search.removeAttribute('hidden');
      if ('value' in search) {
        (search as HTMLInputElement).value = searchQuery;
      }
    } else {
      search.setAttribute('hidden', '');
      live.textContent = '';
      search.removeAttribute('aria-activedescendant');
    }
  }

  function renderEmpty(text: string, searchVisible = false): void {
    setSearchChrome(searchVisible);
    const empty = doc.createElement('div');
    empty.classList.add('lightink-outline-empty');
    empty.textContent = text;
    body.replaceChildren(empty);
  }

  function outlineIdentity(items: readonly OutlineItem[], source: string): string {
    if (items.length === 0) {
      return source;
    }
    return `${source}:${items.length}:${items[0]?.text ?? ''}:${items[items.length - 1]?.text ?? ''}`;
  }

  function outlineButtons(): HTMLElement[] {
    return Array.from(body.children).filter((child) =>
      child.classList.contains('lightink-outline-item'),
    ) as HTMLElement[];
  }

  function setActive(index: number, scroll: boolean): void {
    const buttons = outlineButtons();
    if (buttons.length === 0) {
      activeIndex = -1;
      search.removeAttribute('aria-activedescendant');
      return;
    }
    activeIndex = Math.max(0, Math.min(index, buttons.length - 1));
    buttons.forEach((button, optionIndex) => {
      const selected = optionIndex === activeIndex;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const active = buttons[activeIndex]!;
    if (active.id !== '') {
      search.setAttribute('aria-activedescendant', active.id);
    }
    if (scroll) {
      scrollChildIntoScroller(body, active);
    }
  }

  function scrollCurrentOutlineItem(): void {
    const buttons = outlineButtons();
    const active = buttons[activeIndex] ?? buttons.find((button) => button.classList.contains('is-current'));
    if (active !== undefined) {
      scrollChildIntoScroller(body, active);
    }
  }

  function render(options: { scrollCurrent?: boolean } = {}): void {
    const readerItems = deps.getActiveReaderOutline?.() ?? null;
    const markdown = deps.getActiveMarkdown();
    if (readerItems === null && markdown === null) {
      lastOutlineIdentity = 'empty';
      renderEmpty(t('outline.noTab'));
      return;
    }
    const items = readerItems ?? buildOutline(markdown ?? '');
    if (items.length === 0) {
      lastOutlineIdentity = readerItems !== null ? 'reader' : 'markdown';
      renderEmpty(t('outline.empty'));
      return;
    }
    const identity = outlineIdentity(items, readerItems !== null ? 'reader' : 'markdown');
    const documentChanged = identity !== lastOutlineIdentity;
    lastOutlineIdentity = identity;
    const visible = filterOutlineItems(items, searchQuery);
    visibleItems = visible;
    if (visible.length === 0) {
      live.textContent = t('outline.emptySearch');
      renderEmpty(t('outline.emptySearch'), true);
      return;
    }
    setSearchChrome(true);
    live.textContent = t('outline.searchCount').replace(/\{n\}/g, String(visible.length));
    const current = deps.getActiveLocation?.() ?? {};
    const foldingEnabled = readerItems === null;
    const foldedOrdinals = new Set(foldingEnabled ? (deps.getFoldedOrdinals?.() ?? []) : []);
    // 叶子标题（无子标题）不渲染折叠三角。
    const leafAnchors = leafHeadingAnchors(items);
    // 大纲与编辑器折叠保持独立：编辑器侧折叠只隐藏编辑器正文，大纲始终渲染
    // 完整标题列表（不在大纲中级联隐藏子条目），折叠态仅以左侧标记呈现。
    body.replaceChildren(
      ...visible.map((item, index) => {
        const el = doc.createElement('button');
        el.type = 'button';
        el.id = `${listId}-opt-${index}`;
        el.classList.add('lightink-outline-item');
        el.classList.add(`level-${Math.min(Math.max(item.level, 1), 6)}`);
        el.setAttribute('role', 'option');
        el.textContent = item.text;
        el.setAttribute('title', item.text);
        if (outlineItemIsCurrent(item, current)) {
          el.classList.add('is-current');
          el.setAttribute('aria-current', 'location');
        }
        el.addEventListener('click', () => scrollToItem(item));
        // T4/R2：折叠标记作为 item 的首个子 span（仅在注入了 toggleFoldAtOrdinal 时
        // 渲染——测试不注入，故 body.children 仍是纯 item 按钮，既有断言不变）。
        // 叶子标题（无子标题）无折叠三角；标记点击 stopPropagation 不触发条目
        // 跳转，单独联动编辑器折叠。
        if (
          foldingEnabled &&
          deps.toggleFoldAtOrdinal !== undefined &&
          !leafAnchors.has(item.anchor)
        ) {
          const isFolded = foldedOrdinals.has(item.anchor);
          const marker = doc.createElement('span');
          marker.classList.add('lightink-outline-fold');
          if (isFolded) {
            marker.classList.add('is-folded');
          }
          // 三角方向按树形控件惯例：折叠 ▸（可展开）/ 展开 ▾（可折叠）。
          marker.textContent = isFolded ? '▸' : '▾';
          marker.style.cssText =
            'cursor:pointer;display:inline-block;width:1.2em;margin-right:2px;' +
            'opacity:.6;font-size:.9em;';
          marker.setAttribute('role', 'button');
          marker.setAttribute('aria-label', isFolded ? '展开' : '折叠');
          marker.addEventListener('mousedown', (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          marker.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            deps.toggleFoldAtOrdinal!(item.anchor);
            render(); // 立即反映新折叠态（编辑器 onFoldChanged 亦会触发 refreshNow）
          });
          el.insertBefore(marker, el.firstChild);
        }
        return el;
      }),
    );
    const currentIndex = lastCurrentOutlineIndex(visible, current);
    setActive(currentIndex >= 0 ? currentIndex : 0, false);
    if (
      visibility === 'expanded' &&
      searchQuery.trim() === '' &&
      (options.scrollCurrent === true || documentChanged)
    ) {
      scrollCurrentOutlineItem();
    }
  }

  search.addEventListener('keydown', (event) => {
    const keyEvent = event as KeyboardEvent;
    const action = outlineSearchKeyAction(
      keyEvent.key,
      searchQuery,
      outlineSearchKeyIsComposing(keyEvent),
    );
    if (action === null) {
      return;
    }
    if (typeof keyEvent.preventDefault === 'function') {
      keyEvent.preventDefault();
    }
    if (typeof keyEvent.stopPropagation === 'function') {
      keyEvent.stopPropagation();
    }
    if (action.kind === 'dismiss') {
      applyVisibility('rail');
      return;
    }
    if (action.kind === 'clear') {
      searchQuery = '';
      if ('value' in search) {
        (search as HTMLInputElement).value = '';
      }
      render({ scrollCurrent: true });
      return;
    }
    if (action.kind === 'move') {
      setActive(activeIndex + action.delta, true);
      return;
    }
    if (action.kind === 'select') {
      const item = visibleItems[activeIndex];
      if (item !== undefined) {
        scrollToItem(item);
      }
    }
  });
  search.addEventListener('input', () => {
    searchQuery = 'value' in search && typeof search.value === 'string' ? search.value : '';
    render({ scrollCurrent: searchQuery.trim() === '' });
  });

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function syncHostClass(): void {
    try {
      const host = (root as { parentElement?: HTMLElement | null }).parentElement ?? null;
      if (host?.classList === undefined) {
        return;
      }
      host.classList.toggle('is-outline-rail', visibility === 'rail');
      host.classList.toggle('is-outline-hidden', visibility === 'hidden');
      host.classList.toggle('is-outline-collapsed', visibility !== 'expanded');
    } catch {
      /* ignore missing parent / fake DOM */
    }
  }

  function applyVisibility(next: OutlineVisibility): void {
    const reveal = visibility !== 'expanded' && next === 'expanded';
    visibility = next;
    root.dataset.visibility = next;
    root.classList.toggle('is-rail', next === 'rail');
    root.classList.toggle('is-hidden', next === 'hidden');
    // Legacy class kept for older CSS/tests: any non-expanded mode.
    root.classList.toggle('collapsed', next !== 'expanded');

    if (next === 'hidden') {
      root.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', t('outline.show'));
      toggle.setAttribute('aria-label', t('outline.show'));
      toggle.textContent = '»';
      root.style.width = '';
    } else if (next === 'rail') {
      root.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('title', t('outline.expand'));
      toggle.setAttribute('aria-label', t('outline.expand'));
      toggle.textContent = '»';
      root.style.width = '';
    } else {
      root.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('title', t('outline.collapse'));
      toggle.setAttribute('aria-label', t('outline.collapse'));
      toggle.textContent = '«';
      root.style.width = `${widthPx}px`;
    }
    // Resize handle only meaningful when the panel is expanded.
    resizeHandle.style.display = next === 'expanded' ? '' : 'none';
    resizeHandle.setAttribute('aria-hidden', next === 'expanded' ? 'false' : 'true');
    syncHostClass();
    if (reveal) {
      render({ scrollCurrent: true });
    }
    deps.onVisibilityChange?.();
  }

  function endDrag(): void {
    if (dragCleanup !== null) {
      dragCleanup();
      dragCleanup = null;
    }
    root.classList.remove('is-resizing');
    try {
      doc.body?.classList?.remove('lightink-outline-resizing');
    } catch {
      /* fake DOM */
    }
  }

  function startDrag(clientX: number): void {
    if (visibility !== 'expanded') return;
    endDrag();
    const startX = clientX;
    const startW = widthPx;
    root.classList.add('is-resizing');
    try {
      doc.body?.classList?.add('lightink-outline-resizing');
    } catch {
      /* fake DOM */
    }

    const onMove = (event: Event): void => {
      const pe = event as PointerEvent | MouseEvent;
      const x = typeof pe.clientX === 'number' ? pe.clientX : startX;
      // Outline is on the left; dragging the right edge rightward widens.
      applyWidth(startW + (x - startX), false);
      if (typeof pe.preventDefault === 'function') pe.preventDefault();
    };
    const onUp = (): void => {
      applyWidth(widthPx, true);
      endDrag();
    };

    // Prefer pointer events; fall back to mouse for older / fake DOMs.
    const target = doc as Document;
    if (typeof target.addEventListener === 'function') {
      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
      target.addEventListener('mousemove', onMove);
      target.addEventListener('mouseup', onUp);
      dragCleanup = () => {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        target.removeEventListener('mousemove', onMove);
        target.removeEventListener('mouseup', onUp);
      };
    }
  }

  resizeHandle.addEventListener('pointerdown', (event: Event) => {
    const pe = event as PointerEvent;
    if (typeof pe.button === 'number' && pe.button !== 0) return;
    if (typeof pe.preventDefault === 'function') pe.preventDefault();
    if (typeof pe.stopPropagation === 'function') pe.stopPropagation();
    startDrag(typeof pe.clientX === 'number' ? pe.clientX : 0);
  });
  // Mouse fallback when pointer events are unavailable on the handle.
  resizeHandle.addEventListener('mousedown', (event: Event) => {
    const me = event as MouseEvent;
    if (typeof me.button === 'number' && me.button !== 0) return;
    if (typeof me.preventDefault === 'function') me.preventDefault();
    if (typeof me.stopPropagation === 'function') me.stopPropagation();
    startDrag(typeof me.clientX === 'number' ? me.clientX : 0);
  });

  toggle.addEventListener('click', () => {
    // Rail strip is a reopen control: click expands. Menu / Ctrl+Shift+L still
    // cycle expanded → rail → hidden → expanded for full three-state control.
    if (visibility === 'rail') {
      applyVisibility('expanded');
      return;
    }
    view.toggleCollapse();
  });

  const view: OutlineView = {
    root,
    get visibility() {
      return visibility;
    },
    get collapsed() {
      return visibility !== 'expanded';
    },
    get widthPx() {
      return widthPx;
    },
    toggleCollapse(): void {
      applyVisibility(nextVisibility(visibility));
    },
    setVisibility(next: OutlineVisibility): void {
      if (visibility === next) {
        return;
      }
      applyVisibility(next);
    },
    setCollapsed(next: boolean): void {
      // true → rail (recoverable strip); false → expanded. Full hide is setVisibility.
      applyVisibility(next ? 'rail' : 'expanded');
    },
    setWidth(px: number): void {
      applyWidth(px, true);
    },
    scheduleRefresh(): void {
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        render();
      }, debounceMs);
    },
    refreshNow(): void {
      cancelTimer();
      render();
    },
    retranslate(): void {
      title.textContent = t('outline.title');
      search.setAttribute('aria-label', t('outline.search'));
      search.setAttribute('placeholder', t('outline.search'));
      body.setAttribute('aria-label', t('outline.title'));
      resizeHandle.setAttribute('aria-label', t('outline.resize'));
      resizeHandle.setAttribute('title', t('outline.resize'));
      applyVisibility(visibility);
      render();
    },
    destroy(): void {
      cancelTimer();
      endDrag();
    },
  };

  // 初始渲染一次（通常在首个标签创建前，为空态）。
  render();
  return view;
}
