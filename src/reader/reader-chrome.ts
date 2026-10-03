/**
 * `reader-chrome` — 读书页沉浸控件（R4 / R5）。
 *
 * Kindle / Apple Books / Readest：阅读时 chrome 消失；单击中部或靠近顶/底
 * 边缘时顶栏与底栏同时出现。桌面顶栏是五项常驻入口（返回书架 · 目录 ·
 * 排版 · 书签 · 搜索），助手仅在 AI 已配置时出现。书签是一等开关：对当前位置添加/取消书签，按钮按
 * 当前位置是否已书签呈现两态（aria-pressed + is-bookmarked 视觉态）；进度
 * 轨在 TOC 刻度之外再画书签刻度（可点击跳转）。搜索打开同一套标注侧栏
 *（列表 + 书内搜索），不再另放「本书标注」。底栏与沉浸条都是单行：章节名 |
 * 进度轨道 | 位置/百分比。轨道用主题色填充，唤出后标 TOC/书签刻度。
 *
 * 约 2.5s 无操作自动收起；`isOverlayOpen()` 为真时不自动收。Escape 一次只
 * 退一步且永不调用 `returnToShelf`：选区工具条 → 标注侧栏 → 其它浮层 →
 * 控件条。「返回书架」是起始侧唯一合书入口。
 *
 * `touchMode` 为真（触屏优先平台）时不做空闲自动收起，也不做边缘悬停
 * 唤出；只由中部点按 / Escape / 收浮层收起。翻页模式 idle 仍显示 whisper
 * 进度线；滚动模式不显示（原生滚动条即进度，底栏会挡住末行）。
 * 目录 / 排版 / 书签 / 搜索挪到 `.lightink-reader-chrome-footer` 拇指区
 *（进度行之前的同一 tools 簇）；返回书架留在顶栏边缘。主控件可点区域
 * 至少 48×48，相邻间距至少 8px。显隐仍走既有 reveal / dismiss，不另造
 * 一套 chrome 状态机。文字书与漫画共用这套点按显隐。
 */

import {
  applyConcealScene,
  CONCEAL_SCENE_CHOICES,
  concealSceneOf,
  type ConcealPrefs,
  type ConcealSceneChoice,
} from '../conceal/conceal-prefs.js';
import {
  concealCustomEffect,
  concealSceneResult,
  type ConcealEffectLabels,
  type ConcealSceneResultLabels,
} from '../conceal/conceal-status.js';
import { formatReaderPercent } from './reader-progress-ui.js';

export type ReaderChromeLocale = 'en' | 'zh-CN';

export type ReaderChromeAction =
  | 'backToShelf'
  | 'toc'
  | 'typography'
  | 'bookmark'
  | 'search'
  | 'assistant';

export interface ReaderChromeLabels {
  readonly backToShelf: string;
  readonly toc: string;
  readonly typography: string;
  readonly bookmark: string;
  readonly search: string;
  /** AI 助手面板入口（R5；仅 AI 已配置时渲染）。 */
  readonly assistant: string;
  /** Markdown immersive chrome: enter in-place edit (not desktop workspace). */
  readonly edit: string;
  /** Markdown immersive chrome: save via saveActiveTab and return to read-only. */
  readonly done: string;
  readonly toolbar: string;
  readonly progress: string;
  readonly footer: string;
  /** 书签刻度按钮的 aria-label（进度轨上的可点击书签刻度）。 */
  readonly bookmarkTick: string;
}

export interface ReaderChromeProgress {
  readonly chapterTitle: string;
  /** Book-level title shown in the top bar; empty keeps the bar title-free. */
  readonly bookTitle?: string;
  readonly location: string;
  readonly progress: number;
  readonly ticks?: readonly number[];
  /** 书签刻度（0..1 全书比例）：区别于章节刻度的样式，点击跳对应书签。 */
  readonly bookmarkTicks?: readonly number[];
}

export const READER_CHROME_ACTIONS: readonly ReaderChromeAction[] = [
  'backToShelf',
  'toc',
  'typography',
  'bookmark',
  'search',
  'assistant',
];

export const READER_CHROME_HIDE_DELAY_MS = 2500;
export const READER_CHROME_EDGE_PX = 32;
/** Touch-primary hit target for backToShelf + footer tools (R5). */
export const READER_CHROME_TOUCH_HIT_PX = 48;
/** Minimum gap between adjacent touch-primary chrome actions (R5). */
export const READER_CHROME_TOUCH_GAP_PX = 8;

export const READER_CHROME_LABELS: Record<ReaderChromeLocale, ReaderChromeLabels> = {
  en: {
    backToShelf: 'Back to Shelf',
    toc: 'Contents',
    typography: 'Typography',
    bookmark: 'Bookmark',
    search: 'Search',
    assistant: 'Assistant',
    edit: 'Edit',
    done: 'Done',
    toolbar: 'Reading controls',
    progress: 'Reading progress',
    footer: 'Reading progress',
    bookmarkTick: 'Jump to bookmark',
  },
  'zh-CN': {
    backToShelf: '返回书架',
    toc: '目录',
    typography: '排版',
    bookmark: '书签',
    search: '搜索',
    assistant: '助手',
    edit: '编辑',
    done: '完成',
    toolbar: '阅读控件',
    progress: '阅读进度',
    footer: '阅读进度',
    bookmarkTick: '跳到书签',
  },
};

export interface ReaderChromeBounds {
  readonly top: number;
  readonly height: number;
}

/**
 * R7 鼠标移出隐藏 × reader-chrome 的接管通道（单写者保留在 syncDom）：
 *   - 'auto'   默认：原 reveal/idle 自动隐藏机制全权；
 *   - 'held'   强制显示该带，且抑制 idle 自动隐藏（R7 开 + 指针在带内）；
 *   - 'hidden' 强制隐藏该带（R7 开 + 指针已离开）。
 * conceal-controller 调用；所有 bar/footer/whisper 的 DOM 写入仍收敛在
 * syncDom 单点，不引入第二套状态机。
 */
export type ReaderChromeConcealZone = 'auto' | 'held' | 'hidden';

export interface ReaderChromeDeps {
  host?: HTMLElement;
  locale?: ReaderChromeLocale;
  labels?: Partial<ReaderChromeLabels>;
  hideDelayMs?: number;
  edgePx?: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (id: number) => void;
  returnToShelf: () => void;
  openOutline?: () => void;
  openTypography?: () => void;
  /** 顶栏搜索一等入口：桌面走标注侧栏搜索，触屏走独立底栏搜索层。 */
  openSearch?: () => void;
  /** AI 助手面板入口（R5）：打开阅读器助手面板。 */
  openAssistant?: () => void;
  /** 书签一等开关：对当前阅读位置添加/取消书签（宿主裁决两态）。 */
  toggleBookmark?: () => void;
  /** 当前位置是否已书签（按钮 aria-pressed 与视觉态同步源）。 */
  isBookmarked?: () => boolean;
  /** 点击进度轨书签刻度（fraction 与 setProgress 的 bookmarkTicks 同源）。 */
  onBookmarkTick?: (fraction: number) => void;
  toggleSidebar?: () => void;
  isOverlayOpen?: () => boolean;
  dismissOverlay?: () => boolean;
  isSidebarVisible?: () => boolean;
  isSelectionToolbarVisible?: () => boolean;
  hideSelectionToolbar?: () => void;
  /** When true, an already-revealed bar does not auto-hide (e.g. scroll at top). */
  stayRevealed?: () => boolean;
  /**
   * Hide the flow footer/whisper for comics. Page/slider live on the
   * comic overlay; a persistent "第 N 页 · ── · N%" dock is too sparse
   * for a bitmap canvas and duplicates the overlay chrome.
   */
  suppressProgressDock?: () => boolean;
  /**
   * Touch-primary platform (data-android / data-touch-primary). Disables the
   * idle auto-hide timer and edge-hover reveal; dismissal happens only via
   * center tap, Escape, or closing an overlay. Primary actions use a 48×48
   * hit target with 8px gaps. Desktop passes false/omits.
   */
  touchMode?: boolean;
  /** Drag the footer scrubber to a 0..1 book position. */
  onSeekProgress?: (progress: number) => void;
  /**
   * AI 助手入口：密钥未配置时为假，按钮自摘除。
   * 省略时保持显示，便于 chrome 单测。
   */
  assistantAvailable?: () => boolean;
  /**
   * Markdown immersive chrome only. When set, a top-bar 编辑/完成 control
   * is added; EPUB/PDF/comic chrome omit these deps and stay unchanged.
   */
  onMarkdownEdit?: () => void;
  onMarkdownFinish?: () => void | Promise<void>;
  markdownEditing?: () => boolean;
  /**
   * 有效显隐变化通知（合成 conceal 接管后的 barShown，变化才回调）。
   * Android 阅读态用它成对显隐系统栏；桌面宿主可忽略。
   */
  onRevealChange?: (shown: boolean) => void;
  onDestroy?: () => void;
}

/** 置顶、迷你窗口、透明、穿透被拒绝时贴在对应开关旁。与书架同一组键。 */
export const READER_CONCEAL_REFUSAL_KEYS = [
  'transparentMode',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const;

export type ReaderConcealRefusalKey = (typeof READER_CONCEAL_REFUSAL_KEYS)[number];

function isReaderConcealRefusalKey(key: ReaderConcealToggleKey): key is ReaderConcealRefusalKey {
  return (READER_CONCEAL_REFUSAL_KEYS as readonly string[]).includes(key);
}

export const READER_CONCEAL_TOGGLE_KEYS = [
  'transparentMode',
  'hideTop',
  'hideBody',
  'hideBottom',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const;

export type ReaderConcealToggleKey = (typeof READER_CONCEAL_TOGGLE_KEYS)[number];

export interface ReaderConcealBarLabels extends ConcealSceneResultLabels, ConcealEffectLabels {
  readonly toggle: string;
  readonly toggleLabel: string;
  readonly sceneNormal: string;
  readonly sceneHideOnLeave: string;
  readonly sceneFloating: string;
  readonly sceneCustom: string;
  readonly contentOpacity: string;
  readonly opacityScale: string;
  readonly transparentMode: string;
  readonly hideTop: string;
  readonly hideBody: string;
  readonly hideBottom: string;
  readonly alwaysOnTop: string;
  readonly miniWindow: string;
  readonly clickThrough: string;
  readonly needsTransparent: string;
  readonly clickThroughHint: string;
  /** 含 `{combo}`。 */
  readonly bossKeyActive: string;
}

export interface ReaderConcealBarDeps {
  labels: () => ReaderConcealBarLabels;
  getPrefs: () => ConcealPrefs;
  /** 已按场景表改写的整份偏好，与书架 `update(applyConcealScene(...))` 相同。 */
  applyPrefs: (next: ConcealPrefs) => void;
  previewOpacity: (value: number) => void;
  commitOpacity: (value: number) => void;
  /**
   * 订阅会话内的窗口开关拒绝。空原因表示该键已清除。
   * 订阅时可以重放尚未清除的原因。
   */
  subscribeRefusals?: (
    listener: (key: ReaderConcealRefusalKey, reason: string) => void,
  ) => () => void;
  clearRefusal?: (key: ReaderConcealRefusalKey) => void;
  /** 展开或收起改变了顶栏高度，宿主应重测穿透顶带。 */
  onLayout?: () => void;
}

/**
 * 调节条只挂桌面阅读器。编辑器、Android、书架封面墙不挂。
 * `concealEnabled` 在 Android 和浏览器预览上为假。
 */
export function shouldAttachReaderConcealBar(facts: {
  readonly concealEnabled: boolean;
  readonly android: boolean;
  readonly surface: 'shelf' | 'reader' | 'editor';
}): boolean {
  return facts.concealEnabled && !facts.android && facts.surface === 'reader';
}

/** 调节条滑杆只接受 0–100 的整数。越界、空白、非整数返回 null。 */
export function parseReaderConcealOpacity(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    return null;
  }
  return value;
}

let readerConcealSeq = 0;

export interface ReaderChrome {
  readonly element: HTMLElement;
  readonly bar: HTMLElement;
  readonly footer: HTMLElement;
  readonly whisper: HTMLElement;
  isRevealed(): boolean;
  reveal(): void;
  dismiss(): void;
  toggle(): void;
  /** 同步书签按钮两态（aria-pressed + is-bookmarked 视觉态）。 */
  setBookmarked(bookmarked: boolean): void;
  setProgress(snapshot: ReaderChromeProgress): void;
  pinDocks(pane: { getBoundingClientRect(): DOMRect } | null, paginated: boolean): void;
  /** Re-apply stay-revealed (scroll at top) vs idle auto-hide. */
  syncStayRevealed(): void;
  /** 重新根据 assistant 可用性挂摘按钮（配置变更后由宿主调用）。 */
  refreshAvailability(): void;
  /** Re-read `markdownEditing()` and swap 编辑/完成 label. */
  syncMarkdownEdit(): void;
  /**
   * R7：顶带/底带显隐接管（'auto' 还原原机制）。见 ReaderChromeConcealZone。
   */
  setConcealZones(top: ReaderChromeConcealZone, bottom: ReaderChromeConcealZone): void;
  /** 桌面阅读器顶栏的摸鱼调节条。不调用则不渲染。 */
  attachConcealBar(deps: ReaderConcealBarDeps): void;
  /**
   * R15 总开关关闭：卸载调节条（移除按钮与面板、还原顶/底带接管、
   * 退订拒绝回调）；bar 内原有子节点放回 attach 前的直接位置。
   * 未挂载时无操作。
   */
  detachConcealBar(): void;
  /** 重读调节条文案和当前偏好。未挂载时无操作。 */
  syncConcealBar(): void;
  /**
   * One-step back. Never calls `returnToShelf`. True when a layer closed;
   * false when nothing is open (window leftover Escape may 合书).
   */
  handleEscape(): boolean;
  handleSurfaceClick(event: MouseEvent | PointerEvent): void;
  handlePointerMove(event: { clientY: number }, bounds?: ReaderChromeBounds): void;
  handlePointerLeave(): void;
  attach(host: HTMLElement): void;
  detach(): void;
  destroy(): void;
}

export function readerChromeLabels(
  locale: ReaderChromeLocale = 'zh-CN',
  overrides?: Partial<ReaderChromeLabels>,
): ReaderChromeLabels {
  return { ...READER_CHROME_LABELS[locale], ...overrides };
}

/** Pointer is in the top or bottom edge band used to reveal controls. */
export function isReaderChromeEdge(
  clientY: number,
  bounds: ReaderChromeBounds,
  edgePx: number = READER_CHROME_EDGE_PX,
): boolean {
  if (!Number.isFinite(clientY) || !Number.isFinite(bounds.height) || bounds.height <= 0) {
    return false;
  }
  const y = clientY - bounds.top;
  const band = Math.max(0, edgePx);
  return y <= band || y >= bounds.height - band;
}

/**
 * Visible slice of the reading host. Scroll mode grows the host taller than
 * the window; edge-reveal must use the on-screen top/bottom, not the
 * document top that has already scrolled away.
 */
export function visibleReaderChromeBounds(host: HTMLElement | null): ReaderChromeBounds {
  if (host === null || typeof host.getBoundingClientRect !== 'function') {
    return { top: 0, height: 0 };
  }
  const rect = host.getBoundingClientRect();
  const viewportBottom =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : rect.bottom;
  const top = Math.max(0, rect.top);
  const bottom = Math.min(viewportBottom, rect.bottom);
  return { top, height: Math.max(0, bottom - top) };
}

function isElementHost(value: HTMLElement | ReaderChromeDeps): value is HTMLElement {
  return typeof (value as HTMLElement).appendChild === 'function';
}

function defaultSchedule(fn: () => void, ms: number): number {
  if (typeof setTimeout === 'undefined') {
    fn();
    return 0;
  }
  return setTimeout(fn, ms) as unknown as number;
}

function defaultCancel(id: number): void {
  if (typeof clearTimeout !== 'undefined') {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

function isWindowTitlebarHot(): boolean {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') {
    return false;
  }
  const bar = document.getElementById('lightink-window-titlebar');
  if (bar === null || typeof bar.matches !== 'function') {
    return false;
  }
  try {
    return bar.matches(':hover, :focus-within');
  } catch {
    return false;
  }
}

function applyOverlayLayout(element: HTMLElement): void {
  // Sticky to the visible scrollport so the bar stays on screen in scroll
  // mode. Height 0 keeps it out of flow (reveal cannot shift the page).
  element.style.position = 'sticky';
  element.style.left = '0';
  element.style.right = '0';
  element.style.top = '0';
  element.style.bottom = 'auto';
  element.style.width = '100%';
  element.style.height = '0';
  element.style.margin = '0';
  element.style.padding = '0';
  element.style.border = '0';
  element.style.pointerEvents = 'none';
  element.style.zIndex = '12';
  element.style.boxSizing = 'border-box';
}

function applyBarLayout(bar: HTMLElement): void {
  bar.style.position = 'absolute';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.right = '0';
  bar.style.pointerEvents = 'auto';
  bar.style.boxSizing = 'border-box';
}

function applyButtonLayout(button: HTMLButtonElement, touchHit = false): void {
  button.style.pointerEvents = 'auto';
  button.style.whiteSpace = 'nowrap';
  button.style.flex = '0 0 auto';
  if (!touchHit) {
    return;
  }
  const size = `${READER_CHROME_TOUCH_HIT_PX}px`;
  button.style.boxSizing = 'border-box';
  button.style.minWidth = size;
  button.style.minHeight = size;
  button.dataset.readerChromeHit = String(READER_CHROME_TOUCH_HIT_PX);
}

function isComicReaderSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || typeof target.closest !== 'function') {
    return false;
  }
  return target.closest('[data-comic-reader="true"]') !== null;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Node).nodeType !== 'number') {
    return false;
  }
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element === null || typeof element.closest !== 'function') {
    return false;
  }
  return element.closest('a, button, input, textarea, select, [contenteditable="true"]') !== null;
}

function hasNonCollapsedSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  return selection !== null && selection.toString().trim() !== '';
}

function resolveBounds(host: HTMLElement | null, fallback?: ReaderChromeBounds): ReaderChromeBounds {
  if (fallback !== undefined) {
    return fallback;
  }
  return visibleReaderChromeBounds(host);
}

export function createReaderChrome(
  hostOrDeps: HTMLElement | ReaderChromeDeps,
  maybeDeps?: ReaderChromeDeps,
): ReaderChrome {
  const initialHost = isElementHost(hostOrDeps) ? hostOrDeps : hostOrDeps.host;
  const deps: ReaderChromeDeps = isElementHost(hostOrDeps)
    ? (maybeDeps ?? { returnToShelf: () => undefined })
    : hostOrDeps;

  const labels = readerChromeLabels(deps.locale ?? 'zh-CN', deps.labels);
  const hideDelayMs = deps.hideDelayMs ?? READER_CHROME_HIDE_DELAY_MS;
  const edgePx = deps.edgePx ?? READER_CHROME_EDGE_PX;
  const touchMode = deps.touchMode === true;
  const schedule = deps.schedule ?? defaultSchedule;
  const cancel = deps.cancel ?? defaultCancel;

  const element = document.createElement('div');
  element.className = 'lightink-reader-chrome';
  element.setAttribute('data-reader-chrome', 'overlay');
  applyOverlayLayout(element);

  const bar = document.createElement('div');
  bar.className = 'lightink-reader-chrome-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', labels.toolbar);
  bar.setAttribute('data-tauri-drag-region', '');
  applyBarLayout(bar);

  const markdownEditEnabled = typeof deps.onMarkdownEdit === 'function';

  const makeButton = (action: string, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `lightink-reader-chrome-action lightink-reader-chrome-action--${action}`;
    button.dataset.readerChromeAction = action;
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (action === 'toc' || action === 'typography' || action === 'assistant') {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
    }
    if (action === 'bookmark') {
      // 开关按钮：aria-pressed 承载两态（is-bookmarked 类只是视觉态）。
      button.setAttribute('aria-pressed', 'false');
    }
    applyButtonLayout(button, touchMode);
    return button;
  };

  const backButton = makeButton('backToShelf', labels.backToShelf);
  const editButton = markdownEditEnabled ? makeButton('markdownEdit', labels.edit) : null;
  const tocButton = makeButton('toc', labels.toc);
  const typographyButton = makeButton('typography', labels.typography);
  const bookmarkButton = makeButton('bookmark', labels.bookmark);
  const searchButton = makeButton('search', labels.search);
  const assistantButton = makeButton('assistant', labels.assistant);
  const drag = document.createElement('div');
  drag.className = 'lightink-reader-chrome-drag';
  drag.setAttribute('data-tauri-drag-region', '');
  drag.setAttribute('aria-hidden', 'true');
  // 书名胶囊：夹在返回与工具之间，桌面可见当前在读哪本书。
  // 空字符串时不占布局；setProgress 时随 bookTitle 填充。
  const barTitle = document.createElement('span');
  barTitle.className = 'lightink-reader-chrome-title';
  barTitle.setAttribute('aria-hidden', 'true');
  const tools = document.createElement('div');
  tools.className = 'lightink-reader-chrome-tools';
  tools.append(tocButton, typographyButton, bookmarkButton, searchButton, assistantButton);
  if (touchMode) {
    const hit = `${READER_CHROME_TOUCH_HIT_PX}px`;
    const gap = `${READER_CHROME_TOUCH_GAP_PX}px`;
    element.dataset.touchMode = 'true';
    bar.dataset.touchMode = 'true';
    bar.style.minHeight = hit;
    tools.classList.add('lightink-reader-chrome-thumb');
    tools.style.gap = gap;
    tools.style.minHeight = hit;
    element.style.setProperty('--lightink-reader-chrome-hit', hit);
    element.style.setProperty('--lightink-reader-chrome-gap', gap);
    bar.append(backButton, drag);
  } else {
    bar.append(backButton, barTitle, tools, drag);
  }
  if (editButton !== null) {
    backButton.after(editButton);
  }
  element.appendChild(bar);

  const footer = document.createElement('div');
  footer.className = 'lightink-reader-chrome-footer';
  footer.setAttribute('role', 'group');
  footer.setAttribute('aria-label', labels.footer);
  const footerChapter = document.createElement('span');
  footerChapter.className = 'lightink-reader-chrome-chapter';
  const footerStats = document.createElement('span');
  footerStats.className = 'lightink-reader-chrome-footer-stats';
  const footerLocation = document.createElement('span');
  footerLocation.className = 'lightink-reader-chrome-location';
  const footerPercent = document.createElement('span');
  footerPercent.className = 'lightink-reader-chrome-percent';
  footerStats.append(footerLocation, footerPercent);
  const scrubber = document.createElement('div');
  scrubber.className = 'lightink-reader-chrome-scrubber';
  const footerTrack = document.createElement('div');
  footerTrack.className = 'lightink-reader-chrome-track';
  footerTrack.setAttribute('aria-hidden', 'true');
  const footerFill = document.createElement('div');
  footerFill.className = 'lightink-reader-chrome-fill';
  const footerTicks = document.createElement('div');
  footerTicks.className = 'lightink-reader-chrome-ticks';
  footerTrack.append(footerFill);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'lightink-reader-chrome-progress';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', labels.progress);
  scrubber.append(footerTrack, footerTicks, slider);
  if (touchMode) {
    footer.dataset.touchMode = 'true';
    footer.style.setProperty('--lightink-reader-chrome-hit', `${READER_CHROME_TOUCH_HIT_PX}px`);
    footer.style.setProperty('--lightink-reader-chrome-gap', `${READER_CHROME_TOUCH_GAP_PX}px`);
    footer.append(tools, footerChapter, scrubber, footerStats);
  } else {
    footer.append(footerChapter, scrubber, footerStats);
  }

  const whisper = document.createElement('div');
  whisper.className = 'lightink-reader-chrome-whisper';
  whisper.setAttribute('aria-live', 'polite');
  const whisperChapter = document.createElement('span');
  whisperChapter.className = 'lightink-reader-chrome-whisper-chapter';
  const whisperScrubber = document.createElement('div');
  whisperScrubber.className = 'lightink-reader-chrome-scrubber lightink-reader-chrome-scrubber--whisper';
  whisperScrubber.setAttribute('aria-hidden', 'true');
  const whisperTrack = document.createElement('div');
  whisperTrack.className = 'lightink-reader-chrome-track lightink-reader-chrome-track--whisper';
  const whisperFill = document.createElement('div');
  whisperFill.className = 'lightink-reader-chrome-fill';
  const whisperTicks = document.createElement('div');
  whisperTicks.className = 'lightink-reader-chrome-ticks';
  whisperTrack.append(whisperFill);
  whisperScrubber.append(whisperTrack, whisperTicks);
  const whisperProgress = document.createElement('span');
  whisperProgress.className = 'lightink-reader-chrome-whisper-progress';
  whisper.append(whisperChapter, whisperScrubber, whisperProgress);

  let revealed = false;
  let pointerInsideBar = false;
  let hideTimer: number | null = null;
  let attachedHost: HTMLElement | null = null;
  let destroyed = false;
  // R7 接管态（默认 'auto' = 原机制全权）；摸鱼面板展开时临时强制为 'held'。
  let concealTop: ReaderChromeConcealZone = 'auto';
  // 展开的摸鱼面板需要保持可操作；保存控制器请求的顶栏状态，收起后恢复。
  let requestedConcealTop: ReaderChromeConcealZone = 'auto';
  let concealBottom: ReaderChromeConcealZone = 'auto';

  const overlayOpen = (): boolean => deps.isOverlayOpen?.() === true;
  const stayRevealed = (): boolean => deps.stayRevealed?.() === true;
  const suppressProgressDock = (): boolean => deps.suppressProgressDock?.() === true;

  const clearHideTimer = (): void => {
    if (hideTimer !== null) {
      cancel(hideTimer);
      hideTimer = null;
    }
  };

  // 只在值变化时写属性：reader-view 用 MutationObserver 监听 element 的
  // data-revealed/class 并回调进 setProgress→syncDom；等值 setAttribute 仍会
  // 产生 mutation record，会形成永不排空的微任务死循环（主线程 100% 卡死）。
  const writeAttr = (target: HTMLElement, name: string, value: string): void => {
    if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value);
    }
  };

  let concealMounted = false;
  let concealDeps: ReaderConcealBarDeps | null = null;
  let concealUnsubscribe: (() => void) | null = null;
  let concealToggle: HTMLButtonElement | null = null;
  let concealPanel: HTMLElement | null = null;
  let concealOpacity: HTMLInputElement | null = null;
  let concealOpacityText: HTMLElement | null = null;
  let concealOpacityScale: HTMLElement | null = null;
  let concealCustom: HTMLElement | null = null;
  let concealLayoutKey = '';
  let concealBoss: HTMLParagraphElement | null = null;
  let concealOpacityDirty = false;
  let concealOpacityDragging = false;
  const concealRefusals = new Map<ReaderConcealRefusalKey, string>();
  const concealSceneButtons = new Map<ConcealSceneChoice, HTMLButtonElement>();
  const concealSceneResults = new Map<ConcealSceneChoice, HTMLElement>();
  let concealCustomEffectNode: HTMLElement | null = null;
  const concealToggles = new Map<
    ReaderConcealToggleKey,
    { readonly input: HTMLInputElement; readonly reason: HTMLParagraphElement }
  >();

  let lastChromeShown: boolean | null = null;

  const syncDom = (): void => {
    // R7 接管态与原机制合成（单写者仍在本函数）：
    //   barShown  = held 强制显示 ‖ (revealed 且未被 hidden 强制隐藏)
    //   footerShown/whisperShown 同理按 bottom 合成。
    const barShown = concealTop === 'held' || (revealed && concealTop !== 'hidden');
    if (barShown !== lastChromeShown) {
      lastChromeShown = barShown;
      deps.onRevealChange?.(barShown);
    }
    if (element.hidden === barShown) {
      element.hidden = !barShown;
    }
    writeAttr(element, 'aria-hidden', barShown ? 'false' : 'true');
    writeAttr(element, 'data-revealed', barShown ? 'true' : 'false');
    element.classList.toggle('is-revealed', barShown);
    bar.hidden = !barShown;
    writeAttr(bar, 'aria-hidden', barShown ? 'false' : 'true');
    bar.style.display = barShown ? 'flex' : 'none';
    if (barShown) {
      bar.setAttribute('data-tauri-drag-region', '');
      drag.setAttribute('data-tauri-drag-region', '');
      bar.style.setProperty('-webkit-app-region', 'drag');
    } else {
      bar.removeAttribute('data-tauri-drag-region');
      drag.removeAttribute('data-tauri-drag-region');
      bar.style.setProperty('-webkit-app-region', 'no-drag');
    }
    const hideProgress = suppressProgressDock();
    const footerShown =
      concealBottom === 'held' ||
      (revealed && !(hideProgress && !touchMode) && concealBottom !== 'hidden');
    const hideFooter = !footerShown;
    footer.hidden = hideFooter;
    writeAttr(footer, 'aria-hidden', hideFooter ? 'true' : 'false');
    // whisper：bottom 被接管隐藏时一并隐藏；'held' 时 footer 已可见，
    // whisper 按「与 footer 互斥」的原口径保持隐藏；'auto' 时与原规则逐字节一致。
    const hideWhisper =
      hideProgress ||
      revealed ||
      footerShown ||
      attachedHost?.dataset.readingLayout === 'scroll' ||
      concealBottom === 'hidden';
    whisper.hidden = hideWhisper;
    writeAttr(whisper, 'aria-hidden', hideWhisper ? 'true' : 'false');
    for (const button of [
      backButton,
      tocButton,
      typographyButton,
      bookmarkButton,
      searchButton,
      assistantButton,
    ]) {
      button.hidden = !barShown;
    }
    barTitle.hidden = !barShown || barTitle.dataset.hasTitle === 'false';
    if (editButton !== null) {
      const editing = deps.markdownEditing?.() === true;
      const label = editing ? labels.done : labels.edit;
      if (editButton.textContent !== label) {
        editButton.textContent = label;
      }
      writeAttr(editButton, 'aria-label', label);
      writeAttr(editButton, 'data-markdown-editing', editing ? 'true' : 'false');
      editButton.hidden = !barShown;
    }
    if (concealToggle !== null) {
      concealToggle.hidden = !barShown;
    }
    // 助手未配置时自摘除，配置后挂回 tools。
    const assistantOn = deps.assistantAvailable?.() !== false;
    assistantButton.hidden = !barShown || !assistantOn;
    if (!assistantOn) {
      assistantButton.remove();
    } else if (!tools.contains(assistantButton)) {
      tools.appendChild(assistantButton);
    }
  };

  const isChromeChrome = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) {
      return false;
    }
    return element.contains(target) || footer.contains(target) || whisper.contains(target);
  };

  const scheduleHide = (): void => {
    if (
      touchMode ||
      destroyed ||
      overlayOpen() ||
      pointerInsideBar ||
      !revealed ||
      stayRevealed() ||
      isWindowTitlebarHot() ||
      // R7：顶带被 'held' 接管时抑制 idle 自动隐藏（强制显示语义）。
      concealTop === 'held'
    ) {
      return;
    }
    clearHideTimer();
    hideTimer = schedule(() => {
      hideTimer = null;
      if (
        destroyed ||
        overlayOpen() ||
        pointerInsideBar ||
        stayRevealed() ||
        isWindowTitlebarHot()
      ) {
        return;
      }
      revealed = false;
      syncDom();
    }, hideDelayMs);
  };

  const setBookmarked = (bookmarked: boolean): void => {
    bookmarkButton.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
    bookmarkButton.classList.toggle('is-bookmarked', bookmarked);
  };

  /** 按钮态向宿主事实对齐（揭示/进度刷新时重读，点击后由宿主回写）。 */
  const syncBookmarkState = (): void => {
    const bookmarked = deps.isBookmarked?.();
    if (bookmarked !== undefined) {
      setBookmarked(bookmarked);
    }
  };

  const reveal = (): void => {
    if (destroyed) {
      return;
    }
    revealed = true;
    syncBookmarkState();
    syncDom();
    if (overlayOpen() || pointerInsideBar) {
      clearHideTimer();
      return;
    }
    scheduleHide();
  };

  const dismiss = (): void => {
    if (overlayOpen()) {
      return;
    }
    clearHideTimer();
    revealed = false;
    syncDom();
  };

  const handleEscape = (): boolean => {
    if (destroyed) {
      return false;
    }
    if (deps.isSelectionToolbarVisible?.() === true) {
      deps.hideSelectionToolbar?.();
      return true;
    }
    if (deps.isSidebarVisible?.() === true) {
      deps.toggleSidebar?.();
      return true;
    }
    if (overlayOpen()) {
      deps.dismissOverlay?.();
      return true;
    }
    if (revealed) {
      clearHideTimer();
      revealed = false;
      syncDom();
      return true;
    }
    return false;
  };

  const handleSurfaceClick = (event: MouseEvent | PointerEvent): void => {
    if (destroyed || event.defaultPrevented) {
      return;
    }
    const target = event.target;
    if (isChromeChrome(target)) {
      if (target instanceof Node && whisper.contains(target) && !revealed) {
        reveal();
      }
      return;
    }
    if (
      target instanceof Element &&
      typeof target.closest === 'function' &&
      target.closest('.lightink-reader-chrome-panel')
    ) {
      return;
    }
    if (isComicReaderSurface(target)) {
      return;
    }
    if (isInteractiveTarget(target) || hasNonCollapsedSelection()) {
      return;
    }
    if (overlayOpen()) {
      deps.dismissOverlay?.();
      return;
    }
    if (revealed) {
      dismiss();
      return;
    }
    reveal();
  };

  const handlePointerMove = (event: { clientY: number }, bounds?: ReaderChromeBounds): void => {
    if (destroyed || touchMode) {
      return;
    }
    const box = resolveBounds(attachedHost, bounds);
    if (isReaderChromeEdge(event.clientY, box, edgePx)) {
      reveal();
    }
  };

  const handlePointerLeave = (): void => {
    pointerInsideBar = false;
    scheduleHide();
  };

  const onHostClick = (event: Event): void => {
    handleSurfaceClick(event as MouseEvent);
  };

  const onHostPointerMove = (event: Event): void => {
    if (isComicReaderSurface(event.target)) {
      return;
    }
    handlePointerMove(event as PointerEvent);
  };

  const onHostPointerLeave = (): void => {
    handlePointerLeave();
  };

  const onHostKeyDown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key !== 'Escape') {
      return;
    }
    if (handleEscape()) {
      keyEvent.preventDefault();
      if (typeof keyEvent.stopPropagation === 'function') {
        keyEvent.stopPropagation();
      }
    }
  };

  const detach = (): void => {
    if (attachedHost === null) {
      return;
    }
    attachedHost.removeEventListener('click', onHostClick);
    attachedHost.removeEventListener('pointermove', onHostPointerMove);
    attachedHost.removeEventListener('pointerleave', onHostPointerLeave);
    attachedHost.removeEventListener('keydown', onHostKeyDown, true);
    attachedHost = null;
  };

  const attach = (host: HTMLElement): void => {
    detach();
    attachedHost = host;
    if (typeof host.insertBefore === 'function') {
      if (host.firstChild !== element) {
        host.insertBefore(element, host.firstChild);
      }
    } else if (element.parentNode !== host) {
      host.appendChild(element);
    }
    if (footer.parentNode !== host) {
      host.appendChild(footer);
    }
    if (whisper.parentNode !== host) {
      host.appendChild(whisper);
    }
    host.addEventListener('click', onHostClick);
    host.addEventListener('pointermove', onHostPointerMove);
    host.addEventListener('pointerleave', onHostPointerLeave);
    host.addEventListener('keydown', onHostKeyDown, true);
    syncDom();
  };

  backButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.returnToShelf();
  });
  editButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (deps.markdownEditing?.() === true) {
      void deps.onMarkdownFinish?.();
      return;
    }
    deps.onMarkdownEdit?.();
  });
  tocButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openOutline?.();
  });
  typographyButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openTypography?.();
  });
  searchButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openSearch?.();
  });
  assistantButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.openAssistant?.();
  });
  bookmarkButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.toggleBookmark?.();
    syncBookmarkState();
  });

  const onDockEnter = (): void => {
    pointerInsideBar = true;
    clearHideTimer();
    reveal();
  };
  const onDockLeave = (): void => {
    pointerInsideBar = false;
    scheduleHide();
  };
  bar.addEventListener('pointerenter', onDockEnter);
  bar.addEventListener('pointerleave', onDockLeave);
  footer.addEventListener('pointerenter', onDockEnter);
  footer.addEventListener('pointerleave', onDockLeave);
  slider.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    pointerInsideBar = true;
    clearHideTimer();
  });
  const paintRatio = (ratio: number, percent: string): void => {
    const writeProgress = (dock: HTMLElement): void => {
      const style = dock.style;
      if (style !== undefined && typeof style.setProperty === 'function') {
        style.setProperty('--lightink-reader-progress', String(ratio));
      }
    };
    writeProgress(footer);
    writeProgress(whisper);
    footerPercent.textContent = percent;
    whisperProgress.textContent = percent;
  };

  slider.addEventListener('input', () => {
    const value = Number.parseInt(slider.value, 10);
    const progress = Number.isFinite(value) ? Math.min(1, Math.max(0, value / 1000)) : 0;
    paintRatio(progress, formatReaderPercent(progress));
    deps.onSeekProgress?.(progress);
  });

  const paintTicks = (
    host: HTMLElement,
    ticks: readonly number[],
    bookmarkTicks: readonly number[] = [],
  ): void => {
    if (typeof host.replaceChildren !== 'function') {
      return;
    }
    host.replaceChildren();
    for (const fraction of ticks) {
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
        continue;
      }
      const tick = document.createElement('i');
      tick.className = 'lightink-reader-chrome-tick';
      tick.setAttribute('aria-hidden', 'true');
      tick.style.left = `${(fraction * 100).toFixed(2)}%`;
      host.appendChild(tick);
    }
    for (const fraction of bookmarkTicks) {
      if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
        continue;
      }
      // 书签刻度可点击（跳对应书签）；章节刻度仍是纯装饰。
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'lightink-reader-chrome-tick lightink-reader-chrome-tick--bookmark';
      tick.style.left = `${(fraction * 100).toFixed(2)}%`;
      tick.setAttribute('aria-label', labels.bookmarkTick);
      tick.title = labels.bookmarkTick;
      tick.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        deps.onBookmarkTick?.(fraction);
      });
      host.appendChild(tick);
    }
  };

  const setProgress = (snapshot: ReaderChromeProgress): void => {
    const title = snapshot.chapterTitle.trim();
    const location = snapshot.location.trim();
    const bookTitle = (snapshot.bookTitle ?? '').trim();
    barTitle.textContent = bookTitle;
    barTitle.dataset.hasTitle = bookTitle === '' ? 'false' : 'true';
    if (bookTitle === '') barTitle.removeAttribute('title');
    else barTitle.title = bookTitle;
    const percent = formatReaderPercent(snapshot.progress);
    const ratio = Number.isFinite(snapshot.progress) ? Math.min(1, Math.max(0, snapshot.progress)) : 0;
    footerChapter.textContent = title;
    footerLocation.textContent = location;
    whisperChapter.textContent = title;
    whisper.setAttribute('aria-label', [title, location, percent].filter((part) => part !== '').join(' · '));
    paintRatio(ratio, percent);
    const ticks = snapshot.ticks ?? [];
    paintTicks(footerTicks, ticks, snapshot.bookmarkTicks ?? []);
    paintTicks(whisperTicks, []);
    if (typeof document === 'undefined' || document.activeElement !== slider) {
      slider.value = String(Math.round(ratio * 1000));
    }
    syncBookmarkState();
    syncDom();
  };

  let lastPinKey = '';
  /**
   * R7 接管通道：'held' 时把内部 revealed 对齐为 true（切回 'auto' 后原
   * 机制从已显示态自然续接），随后统一经 syncDom 单点写 DOM；回到 'auto'
   * 时重挂 idle 自动隐藏计时（R7「开关关闭→立即显示」由原机制呈现）。
   */
  const setConcealZones = (top: ReaderChromeConcealZone, bottom: ReaderChromeConcealZone): void => {
    if (destroyed) {
      return;
    }
    requestedConcealTop = top;
    concealTop = concealPanel?.hidden === false ? 'held' : top;
    concealBottom = bottom;
    if (concealTop === 'held') {
      // 仅顶带 'held' 对齐 revealed=true（切回 'auto' 后原机制从已显示态
      // 续接）；底栏 'held' 独立强制显示 footer，不影响顶栏。
      clearHideTimer();
      revealed = true;
    } else if (bottom === 'held') {
      clearHideTimer();
    }
    syncDom();
    if (top !== 'held' && bottom !== 'held' && revealed && !touchMode) {
      scheduleHide();
    }
  };
  const pinDocks = (
    pane: { getBoundingClientRect(): DOMRect } | null,
    paginated: boolean,
  ): void => {
    const clearPin = (dock: HTMLElement): void => {
      const style = dock.style;
      if (style === undefined || typeof style.removeProperty !== 'function') {
        return;
      }
      style.removeProperty('position');
      style.removeProperty('left');
      style.removeProperty('right');
      style.removeProperty('bottom');
      style.removeProperty('width');
    };
    if (paginated || pane === null || typeof pane.getBoundingClientRect !== 'function') {
      lastPinKey = '';
      clearPin(footer);
      clearPin(whisper);
      return;
    }
    const box = pane.getBoundingClientRect();
    const viewportWidth =
      typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
    const viewportHeight =
      typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
        ? window.innerHeight
        : 0;
    const pinKey = `${box.left},${box.top},${box.width},${box.height},${viewportWidth},${viewportHeight}`;
    if (pinKey === lastPinKey) {
      return;
    }
    lastPinKey = pinKey;
    for (const dock of [footer, whisper]) {
      const style = dock.style;
      if (style === undefined) {
        continue;
      }
      style.position = 'fixed';
      style.left = `${Math.max(0, box.left)}px`;
      style.width = `${Math.max(0, box.width)}px`;
      style.right = `${Math.max(0, viewportWidth - box.right)}px`;
      style.bottom = `${Math.max(0, viewportHeight - box.bottom)}px`;
    }
  };

  const renderConcealBar = (): void => {
    if (destroyed || concealDeps === null || concealToggle === null || concealPanel === null) {
      return;
    }
    const texts = concealDeps.labels();
    const prefs = concealDeps.getPrefs();
    const scene = concealSceneOf(prefs);
    if (concealToggle.textContent !== texts.toggle) {
      concealToggle.textContent = texts.toggle;
    }
    writeAttr(concealToggle, 'aria-label', texts.toggleLabel);
    concealPanel.setAttribute('aria-label', texts.toggleLabel);
    const scenes = concealPanel.querySelector<HTMLElement>('.lightink-reader-conceal-scenes');
    if (scenes !== null) {
      scenes.setAttribute('aria-label', texts.toggleLabel);
    }
    for (const [choice, button] of concealSceneButtons) {
      const label = texts[
        choice === 'normal' ? 'sceneNormal' : choice === 'hideOnLeave' ? 'sceneHideOnLeave' : 'sceneFloating'
      ];
      if (button.textContent !== label) {
        button.textContent = label;
      }
      writeAttr(button, 'aria-label', label);
      const selected = scene === choice;
      writeAttr(button, 'aria-checked', selected ? 'true' : 'false');
      button.classList.toggle('is-active', selected);
    }
    if (concealCustom !== null) {
      if (concealCustom.textContent !== texts.sceneCustom) {
        concealCustom.textContent = texts.sceneCustom;
      }
      concealCustom.classList.toggle('is-active', scene === 'custom');
      writeAttr(concealCustom, 'aria-current', scene === 'custom' ? 'true' : 'false');
    }
    for (const [choice, result] of concealSceneResults) {
      const sentence = concealSceneResult(choice, texts);
      if (result.textContent !== sentence) {
        result.textContent = sentence;
      }
    }
    if (concealCustomEffectNode !== null) {
      const showEffect = scene === 'custom';
      const effect = showEffect ? concealCustomEffect(prefs, texts) : '';
      concealCustomEffectNode.hidden = !showEffect;
      if (concealCustomEffectNode.textContent !== effect) {
        concealCustomEffectNode.textContent = effect;
      }
    }
    for (const [prefKey, toggle] of concealToggles) {
      const locked =
        !prefs.transparentMode &&
        (prefKey === 'hideTop' || prefKey === 'hideBody' || prefKey === 'clickThrough');
      toggle.input.disabled = locked;
      toggle.input.checked = prefs[prefKey] === true;
      const label =
        prefKey === 'transparentMode'
          ? texts.transparentMode
          : prefKey === 'hideTop'
            ? texts.hideTop
            : prefKey === 'hideBody'
              ? texts.hideBody
              : prefKey === 'hideBottom'
                ? texts.hideBottom
                : prefKey === 'alwaysOnTop'
                  ? texts.alwaysOnTop
                  : prefKey === 'miniWindow'
                    ? texts.miniWindow
                    : texts.clickThrough;
      const text = toggle.input.parentElement?.querySelector('span');
      if (text !== null && text !== undefined && text.textContent !== label) {
        text.textContent = label;
      }
      const refused = isReaderConcealRefusalKey(prefKey) ? concealRefusals.get(prefKey) : undefined;
      let reason = '';
      let error = false;
      if (locked) {
        reason = texts.needsTransparent;
        error = true;
      } else if (refused !== undefined && prefs[prefKey] !== true) {
        reason = refused;
        error = true;
      } else if (prefKey === 'clickThrough' && prefs.transparentMode) {
        reason = texts.clickThroughHint;
      }
      toggle.reason.hidden = reason === '';
      if (toggle.reason.textContent !== reason) {
        toggle.reason.textContent = reason;
      }
      toggle.reason.classList.toggle('is-error', error);
    }
    if (concealOpacityText !== null && concealOpacityText.textContent !== texts.contentOpacity) {
      concealOpacityText.textContent = texts.contentOpacity;
    }
    if (concealOpacityScale !== null && concealOpacityScale.textContent !== texts.opacityScale) {
      concealOpacityScale.textContent = texts.opacityScale;
    }
    if (concealOpacity !== null) {
      writeAttr(concealOpacity, 'aria-label', texts.contentOpacity);
      const parsed = parseReaderConcealOpacity(concealOpacity.value);
      // 拖动中的合法整数留在滑杆上；松开、收起或非法值回到已提交的偏好。
      if (!(concealOpacityDragging && parsed !== null) && concealOpacity.value !== String(prefs.contentOpacity)) {
        concealOpacity.value = String(prefs.contentOpacity);
      }
    }
    if (concealBoss !== null) {
      const boss = texts.bossKeyActive.replace('{combo}', prefs.bossPrimary);
      if (concealBoss.textContent !== boss) {
        concealBoss.textContent = boss;
      }
    }
    // 拒绝原因或自定义说明改变顶栏高度时，顶带要按新的 bar 矩形重测。
    const layoutKey = [
      concealCustomEffectNode?.hidden === false ? 'custom' : '',
      ...READER_CONCEAL_TOGGLE_KEYS.map((key) => {
        const reason = concealToggles.get(key)?.reason;
        return reason === undefined || reason.hidden ? '' : reason.textContent ?? '';
      }),
    ].join('\n');
    if (layoutKey !== concealLayoutKey) {
      const previous = concealLayoutKey;
      concealLayoutKey = layoutKey;
      if (previous !== '' && concealPanel.hidden === false) {
        concealDeps.onLayout?.();
      }
    }
  };

  const commitConcealOpacity = (): void => {
    if (concealDeps === null || concealOpacity === null) {
      return;
    }
    const value = parseReaderConcealOpacity(concealOpacity.value);
    concealOpacityDirty = false;
    concealOpacityDragging = false;
    if (value === null) {
      renderConcealBar();
      return;
    }
    concealDeps.commitOpacity(value);
    renderConcealBar();
  };

  const setConcealExpanded = (expanded: boolean): void => {
    if (concealPanel === null || concealToggle === null) {
      return;
    }
    if (!expanded && concealOpacityDirty) {
      commitConcealOpacity();
    }
    concealPanel.hidden = !expanded;
    concealTop = expanded ? 'held' : requestedConcealTop;
    if (concealTop === 'held') {
      clearHideTimer();
      revealed = true;
    }
    writeAttr(concealToggle, 'aria-expanded', expanded ? 'true' : 'false');
    if (expanded) {
      renderConcealBar();
    }
    syncDom();
    if (!expanded && concealTop !== 'held' && concealBottom !== 'held' && revealed && !touchMode) {
      scheduleHide();
    }
    concealDeps?.onLayout?.();
  };

  const attachConcealBar = (next: ReaderConcealBarDeps): void => {
    if (destroyed) {
      return;
    }
    concealDeps = next;
    concealUnsubscribe?.();
    concealRefusals.clear();
    concealUnsubscribe =
      next.subscribeRefusals?.((key, reason) => {
        if (reason === '') {
          concealRefusals.delete(key);
        } else {
          concealRefusals.set(key, reason);
        }
        renderConcealBar();
      }) ?? null;
    if (!concealMounted) {
      readerConcealSeq += 1;
      const panelId = `lightink-reader-conceal-${readerConcealSeq}`;
      const row = document.createElement('div');
      row.className = 'lightink-reader-chrome-bar-row';
      while (bar.firstChild !== null) {
        row.appendChild(bar.firstChild);
      }
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lightink-reader-conceal-toggle';
      toggle.dataset.concealReaderToggle = 'true';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', panelId);
      const panel = document.createElement('div');
      panel.id = panelId;
      panel.className = 'lightink-reader-conceal-panel';
      panel.dataset.concealReaderBar = 'true';
      panel.hidden = true;
      panel.setAttribute('role', 'region');
      const scenesRow = document.createElement('div');
      scenesRow.className = 'lightink-reader-conceal-scenes-row';
      const scenes = document.createElement('div');
      scenes.className = 'lightink-reader-conceal-scenes';
      scenes.setAttribute('role', 'radiogroup');
      for (const choice of CONCEAL_SCENE_CHOICES) {
        const sceneButton = document.createElement('button');
        sceneButton.type = 'button';
        sceneButton.className = 'lightink-reader-conceal-scene';
        sceneButton.dataset.concealScene = choice;
        sceneButton.setAttribute('role', 'radio');
        sceneButton.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const current = concealDeps;
          if (current === null) {
            return;
          }
          concealOpacityDirty = false;
          concealOpacityDragging = false;
          for (const key of READER_CONCEAL_REFUSAL_KEYS) {
            concealRefusals.delete(key);
            current.clearRefusal?.(key);
          }
          current.applyPrefs(applyConcealScene(current.getPrefs(), choice));
          renderConcealBar();
        });
        const sceneResult = document.createElement('p');
        sceneResult.className = 'lightink-reader-conceal-scene-result';
        sceneResult.dataset.concealSceneResult = choice;
        const sceneItem = document.createElement('div');
        sceneItem.className = 'lightink-reader-conceal-scene-item';
        sceneItem.append(sceneButton, sceneResult);
        concealSceneButtons.set(choice, sceneButton);
        concealSceneResults.set(choice, sceneResult);
        scenes.append(sceneItem);
      }
      const custom = document.createElement('span');
      custom.className = 'lightink-reader-conceal-scene is-readonly';
      custom.dataset.concealScene = 'custom';
      concealCustom = custom;
      const customEffect = document.createElement('p');
      customEffect.className = 'lightink-reader-conceal-custom-effect';
      customEffect.dataset.concealCustomEffect = 'true';
      customEffect.hidden = true;
      concealCustomEffectNode = customEffect;
      const customItem = document.createElement('div');
      customItem.className = 'lightink-reader-conceal-scene-item';
      customItem.append(custom, customEffect);
      scenes.append(customItem);
      scenesRow.append(scenes);
      const opacityField = document.createElement('label');
      opacityField.className = 'lightink-reader-conceal-opacity';
      const opacityText = document.createElement('span');
      const opacityScale = document.createElement('span');
      opacityScale.className = 'lightink-reader-conceal-opacity-scale';
      opacityScale.dataset.concealReaderOpacityScale = 'true';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.dataset.concealReaderOpacity = 'true';
      slider.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
      });
      const finishOpacity = (): void => {
        if (concealOpacityDirty) {
          commitConcealOpacity();
          return;
        }
        // 没有预览过的松开（含被滑杆夹成别的数）回到已提交的整数。
        renderConcealBar();
      };
      slider.addEventListener('input', () => {
        const value = parseReaderConcealOpacity(slider.value);
        if (value === null || concealDeps === null) {
          return;
        }
        concealOpacityDirty = true;
        concealOpacityDragging = true;
        concealDeps.previewOpacity(value);
      });
      slider.addEventListener('change', finishOpacity);
      slider.addEventListener('pointerup', finishOpacity);
      slider.addEventListener('blur', finishOpacity);
      opacityField.append(opacityText, slider, opacityScale);
      const toggleNodes: HTMLElement[] = [];
      for (const prefKey of READER_CONCEAL_TOGGLE_KEYS) {
        const wrap = document.createElement('div');
        wrap.className = 'lightink-reader-conceal-switch';
        wrap.dataset.concealReaderSwitch = prefKey;
        const switchLabel = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.concealReaderToggle = prefKey;
        const text = document.createElement('span');
        const reason = document.createElement('p');
        reason.className = 'lightink-reader-conceal-switch-reason';
        reason.dataset.concealReaderSwitchReason = prefKey;
        reason.hidden = true;
        switchLabel.append(input, text);
        wrap.append(switchLabel, reason);
        input.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
        });
        input.addEventListener('change', () => {
          const current = concealDeps;
          if (current === null || input.disabled) {
            renderConcealBar();
            return;
          }
          const requested = input.checked;
          if (isReaderConcealRefusalKey(prefKey)) {
            concealRefusals.delete(prefKey);
            current.clearRefusal?.(prefKey);
          }
          current.applyPrefs({ ...current.getPrefs(), [prefKey]: requested });
          renderConcealBar();
        });
        concealToggles.set(prefKey, { input, reason });
        toggleNodes.push(wrap);
      }
      const transparentNode = toggleNodes[0];
      const restNodes = toggleNodes.slice(1);
      const boss = document.createElement('p');
      boss.className = 'lightink-reader-conceal-boss';
      boss.dataset.concealReaderBoss = 'true';
      panel.append(scenesRow, transparentNode, opacityField, ...restNodes, boss);
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setConcealExpanded(concealPanel?.hidden !== false);
      });
      row.append(toggle);
      bar.append(row, panel);
      bar.dataset.concealReaderBarHost = 'true';
      bar.style.flexWrap = 'wrap';
      concealToggle = toggle;
      concealPanel = panel;
      concealOpacity = slider;
      concealOpacityText = opacityText;
      concealOpacityScale = opacityScale;
      concealBoss = boss;
      concealMounted = true;
    }
    syncDom();
    renderConcealBar();
    next.onLayout?.();
  };

  /**
   * R15：调节条整体卸载。挂起时合入的包裹行（row）与面板一并移除，
   * 按钮原位置回 bar 直接子级；若面板处于展开/held，接管还原因
   * concealTop/concealBottom 归零而回到 'auto' 语义。
   */
  const detachConcealBar = (): void => {
    concealUnsubscribe?.();
    concealUnsubscribe = null;
    concealDeps = null;
    concealRefusals.clear();
    if (!concealMounted) {
      return;
    }
    const row = concealToggle?.parentElement ?? null;
    if (row !== null && row.classList.contains('lightink-reader-chrome-bar-row')) {
      while (row.firstChild !== null) {
        if (row.firstChild === concealToggle) {
          row.removeChild(row.firstChild);
          continue;
        }
        bar.insertBefore(row.firstChild, row);
      }
      row.remove();
    } else {
      concealToggle?.remove();
    }
    concealPanel?.remove();
    concealMounted = false;
    concealToggle = null;
    concealPanel = null;
    concealOpacity = null;
    concealOpacityText = null;
    concealOpacityScale = null;
    concealCustom = null;
    concealCustomEffectNode = null;
    concealBoss = null;
    concealSceneButtons.clear();
    concealSceneResults.clear();
    concealToggles.clear();
    concealLayoutKey = '';
    concealOpacityDirty = false;
    concealOpacityDragging = false;
    concealTop = 'auto';
    concealBottom = 'auto';
    requestedConcealTop = 'auto';
    delete bar.dataset.concealReaderBarHost;
    bar.style.flexWrap = '';
    syncDom();
  };

  syncDom();

  if (initialHost !== undefined) {
    attach(initialHost);
  }

  return {
    element,
    bar,
    footer,
    whisper,
    isRevealed: () => revealed,
    setProgress,
    setBookmarked,
    pinDocks,
    reveal,
    syncStayRevealed: () => {
      if (stayRevealed()) {
        reveal();
        return;
      }
      syncDom();
      scheduleHide();
    },
    refreshAvailability: () => {
      syncDom();
    },
    syncMarkdownEdit: () => {
      syncDom();
    },
    setConcealZones,
    attachConcealBar,
    detachConcealBar,
    syncConcealBar: () => {
      renderConcealBar();
    },
    dismiss,
    toggle() {
      if (revealed) {
        dismiss();
        return;
      }
      reveal();
    },
    handleEscape,
    handleSurfaceClick,
    handlePointerMove,
    handlePointerLeave,
    attach,
    detach,
    destroy() {
      destroyed = true;
      clearHideTimer();
      concealUnsubscribe?.();
      concealUnsubscribe = null;
      deps.onDestroy?.();
      detach();
      element.remove();
      footer.remove();
      whisper.remove();
      revealed = false;
      syncDom();
    },
  };
}
