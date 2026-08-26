/**
 * `reader-chrome` — 读书页沉浸控件（R4 / R5）。
 *
 * Kindle / Apple Books / Readest：阅读时 chrome 消失；单击中部或靠近顶/底
 * 边缘时顶栏与底栏同时出现。桌面顶栏是五项带文字入口（返回书架 · 目录 ·
 * 排版 · 搜索 · 本书标注）；底栏与沉浸条都是单行：
 * 章节名 | 进度轨道 | 位置/百分比。轨道用主题色填充，唤出后标 TOC 刻度。
 *
 * 约 2.5s 无操作自动收起；`isOverlayOpen()` 为真时不自动收。Escape 一次只
 * 退一步且永不调用 `returnToShelf`：选区工具条 → 标注侧栏 → 其它浮层 →
 * 控件条。「返回书架」是起始侧唯一合书入口。
 *
 * `touchMode` 为真（触屏优先平台）时不做空闲自动收起，也不做边缘悬停
 * 唤出；只由中部点按 / Escape / 收浮层收起，whisper 进度线照常显示。
 * 目录 / 排版 / 搜索 / 本书标注挪到 `.lightink-reader-chrome-footer` 拇指区
 *（进度行之前的同一 tools 簇）；返回书架留在顶栏边缘。主控件可点区域
 * 至少 48×48，相邻间距至少 8px。显隐仍走既有 reveal / dismiss，不另造
 * 一套 chrome 状态机。文字书与漫画共用这套点按显隐。
 */

import { formatReaderPercent } from './reader-progress-ui.js';

export type ReaderChromeLocale = 'en' | 'zh-CN';

export type ReaderChromeAction = 'backToShelf' | 'toc' | 'typography' | 'search' | 'annotations';

export interface ReaderChromeLabels {
  readonly backToShelf: string;
  readonly toc: string;
  readonly typography: string;
  readonly search: string;
  readonly annotations: string;
  readonly toolbar: string;
  readonly progress: string;
  readonly footer: string;
}

export interface ReaderChromeProgress {
  readonly chapterTitle: string;
  readonly location: string;
  readonly progress: number;
  readonly ticks?: readonly number[];
}

export const READER_CHROME_ACTIONS: readonly ReaderChromeAction[] = [
  'backToShelf',
  'toc',
  'typography',
  'search',
  'annotations',
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
    search: 'Search',
    annotations: 'Book notes',
    toolbar: 'Reading controls',
    progress: 'Reading progress',
    footer: 'Reading progress',
  },
  'zh-CN': {
    backToShelf: '返回书架',
    toc: '目录',
    typography: '排版',
    search: '搜索',
    annotations: '本书标注',
    toolbar: '阅读控件',
    progress: '阅读进度',
    footer: '阅读进度',
  },
};

export interface ReaderChromeBounds {
  readonly top: number;
  readonly height: number;
}

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
}

export interface ReaderChrome {
  readonly element: HTMLElement;
  readonly bar: HTMLElement;
  readonly footer: HTMLElement;
  readonly whisper: HTMLElement;
  isRevealed(): boolean;
  reveal(): void;
  dismiss(): void;
  toggle(): void;
  setProgress(snapshot: ReaderChromeProgress): void;
  pinDocks(pane: { getBoundingClientRect(): DOMRect } | null, paginated: boolean): void;
  /** Re-apply stay-revealed (scroll at top) vs idle auto-hide. */
  syncStayRevealed(): void;
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

  const makeButton = (action: ReaderChromeAction, label: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `lightink-reader-chrome-action lightink-reader-chrome-action--${action}`;
    button.dataset.readerChromeAction = action;
    button.textContent = label;
    button.setAttribute('aria-label', label);
    if (action === 'toc' || action === 'typography') {
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
    }
    applyButtonLayout(button, touchMode);
    return button;
  };

  const backButton = makeButton('backToShelf', labels.backToShelf);
  const tocButton = makeButton('toc', labels.toc);
  const typographyButton = makeButton('typography', labels.typography);
  const searchButton = makeButton('search', labels.search);
  const annotationsButton = makeButton('annotations', labels.annotations);
  const drag = document.createElement('div');
  drag.className = 'lightink-reader-chrome-drag';
  drag.setAttribute('data-tauri-drag-region', '');
  drag.setAttribute('aria-hidden', 'true');
  const tools = document.createElement('div');
  tools.className = 'lightink-reader-chrome-tools';
  tools.append(tocButton, typographyButton, searchButton, annotationsButton);
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
    bar.append(backButton, tools, drag);
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
  footerTicks.setAttribute('aria-hidden', 'true');
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

  const syncDom = (): void => {
    if (element.hidden === revealed) {
      element.hidden = !revealed;
    }
    writeAttr(element, 'aria-hidden', revealed ? 'false' : 'true');
    writeAttr(element, 'data-revealed', revealed ? 'true' : 'false');
    element.classList.toggle('is-revealed', revealed);
    bar.hidden = !revealed;
    writeAttr(bar, 'aria-hidden', revealed ? 'false' : 'true');
    bar.style.display = revealed ? 'flex' : 'none';
    const hideProgress = suppressProgressDock();
    const hideFooter = !revealed || (hideProgress && !touchMode);
    footer.hidden = hideFooter;
    writeAttr(footer, 'aria-hidden', hideFooter ? 'true' : 'false');
    whisper.hidden = hideProgress || revealed;
    writeAttr(whisper, 'aria-hidden', hideProgress || revealed ? 'true' : 'false');
    for (const button of [backButton, tocButton, typographyButton, searchButton, annotationsButton]) {
      button.hidden = !revealed;
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
      isWindowTitlebarHot()
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

  const reveal = (): void => {
    if (destroyed) {
      return;
    }
    revealed = true;
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
    if (revealed) {
      if (overlayOpen()) {
        deps.dismissOverlay?.();
        return;
      }
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
  };

  backButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.returnToShelf();
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
  annotationsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.toggleSidebar?.();
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

  const paintTicks = (host: HTMLElement, ticks: readonly number[]): void => {
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
      tick.style.left = `${(fraction * 100).toFixed(2)}%`;
      host.appendChild(tick);
    }
  };

  const setProgress = (snapshot: ReaderChromeProgress): void => {
    const title = snapshot.chapterTitle.trim();
    const location = snapshot.location.trim();
    const percent = formatReaderPercent(snapshot.progress);
    const ratio = Number.isFinite(snapshot.progress) ? Math.min(1, Math.max(0, snapshot.progress)) : 0;
    footerChapter.textContent = title;
    footerLocation.textContent = location;
    whisperChapter.textContent = title;
    whisper.setAttribute('aria-label', [title, location, percent].filter((part) => part !== '').join(' · '));
    paintRatio(ratio, percent);
    const ticks = snapshot.ticks ?? [];
    paintTicks(footerTicks, ticks);
    paintTicks(whisperTicks, []);
    if (typeof document === 'undefined' || document.activeElement !== slider) {
      slider.value = String(Math.round(ratio * 1000));
    }
    syncDom();
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
    pinDocks,
    reveal,
    syncStayRevealed: () => {
      if (stayRevealed()) {
        reveal();
        return;
      }
      scheduleHide();
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
      detach();
      element.remove();
      footer.remove();
      whisper.remove();
      revealed = false;
      syncDom();
    },
  };
}
