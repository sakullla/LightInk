/**
 * `reader-chrome-wiring` — reader-view 拆分（T5-kernel-split）的 chrome 装配域：
 * createReaderChrome 装配与 reveal 属性同步（syncChromeRevealAttr，变化才写）、
 * 目录/排版面板开合（openChromePanel/closeChromePanel + 触屏 sheet 过渡）、
 * Escape 链（dismissReaderOverlayStep/onDocumentEscapeCapture/setTabActive）、
 * 进度同步与刻度跳转、主题/排版域（applyTypographyPatch/applyFlowLayout/
 * applyPaperTheme/onThemeChange）与 returnToShelf。纯移动自 reader-view.ts，
 * 行为不变。
 */

import type { MessageKey } from '../../i18n/messages.js';
import {
  createReaderChrome,
  type ReaderChromeLabels,
} from '../reader-chrome.js';
import { syncReaderTitlebarReveal } from '../../ui/window-titlebar.js';
import {
  activateReaderTocPanel,
  adoptReaderOverlayTheme,
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  mountReaderOverlay,
  positionReaderChromePanel,
  unpinFixedOverlay,
  type ReaderChromePanelCopy,
  type ReaderTypographyComicControls,
} from '../reader-chrome-panels.js';
import { concealSheet, revealSheet } from '../../ui/touch/sheet-transition.js';
import {
  formatReaderLocation,
  readerProgressTickFractions,
  resolveReaderChapterTitle,
  stampReadingProgressTitle,
} from '../reader-progress-ui.js';
import {
  loadReaderTypography,
  nextReaderFontScaleStep,
  saveReaderTypography,
  type ReaderTypography,
} from '../reader-typography.js';
import {
  applyReaderTheme,
  loadReaderTheme,
  saveReaderTheme,
  type ReaderThemeId,
} from '../reader-theme.js';
import {
  applyReaderDocumentLayout,
  applyReaderLayout,
  loadReaderLayout,
  parseReaderLayout,
  saveReaderLayout,
  type ReaderFlowLayout,
} from '../reader-layout.js';
import { outlineLocationFromReader } from '../../outline/outline-model.js';
import {
  comicLocaleLabels,
  dispatchReaderFlowLayoutPref,
  notifyReaderWindowChrome,
  readerChromeTouchMode,
} from './reader-dom.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

function readerChromeCopy(
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string,
): Partial<ReaderChromeLabels> {
  const take = (key: MessageKey, field: keyof ReaderChromeLabels): Partial<ReaderChromeLabels> => {
    const value = t(key);
    return value === key ? {} : { [field]: value };
  };
  return {
    ...take('reader.chrome.backToShelf', 'backToShelf'),
    ...take('reader.chrome.toc', 'toc'),
    ...take('reader.chrome.typography', 'typography'),
    ...take('reader.chrome.bookmark', 'bookmark'),
    ...take('reader.chrome.search', 'search'),
    ...take('reader.chrome.toolbar', 'toolbar'),
    ...take('reader.chrome.progress', 'progress'),
    ...take('reader.chrome.footer', 'footer'),
    ...take('reader.chrome.bookmarkTick', 'bookmarkTick'),
  };
}

function canMountReaderChrome(): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return false;
  }
  const probe = document.createElement('div');
  return typeof probe.classList?.toggle === 'function';
}

function dispatchReaderTypographyPref(typography: ReaderTypography): void {
  if (
    typeof document === 'undefined' ||
    typeof document.dispatchEvent !== 'function' ||
    typeof CustomEvent !== 'function'
  ) {
    return;
  }
  document.dispatchEvent(new CustomEvent('lightink:reader-typography', { detail: typography }));
}

export interface ReaderChromeWiringSurface {
  watchPageChrome(): void;
  pinChromeDocks(): void;
  syncChromeProgress(): void;
  syncChromeRevealAttr(): void;
  closeChromePanel(): boolean;
  dismissReaderOverlayStep(): boolean;
  onDocumentEscapeCapture(event: KeyboardEvent): void;
  setTabActive(active: boolean): void;
  returnToShelf(): void;
  applyTypographyPatch(patch: Partial<ReaderTypography>): void;
  applyFlowLayout(layout: ReaderFlowLayout): void;
  syncOpenOverlayThemes(): void;
  applyPaperTheme(theme: ReaderThemeId): void;
  onThemeChange(): void;
  mountReaderChrome(): void;
}

export function setupReaderChromeWiring(ctx: ReaderViewContext): ReaderChromeWiringSurface {
  const watchPageChrome = (): void => {
    ctx.pageChromeObserver?.disconnect();
    if (typeof MutationObserver !== 'function') {
      return;
    }
    ctx.pageChromeObserver = new MutationObserver(syncChromeRevealAttr);
    try {
      ctx.pageChromeObserver.observe(ctx.pageHost, {
        attributes: true,
        attributeFilter: ['data-comic-chrome', 'data-comic-reader'],
      });
    } catch {
      ctx.pageChromeObserver = null;
    }
  };

  const pinChromeDocks = (): void => {
    ctx.readerChrome?.pinDocks(ctx.dom.closestPane() ?? ctx.root, ctx.flowIsPaginated());
  };

  const locationFallback = (kind: 'chapter' | 'page', n: number): string => {
    return kind === 'page'
      ? ctx.t('annotation.location.page', { page: String(n) })
      : ctx.t('reader.chapter', { n: String(n) });
  };

  const syncChromeProgress = (): void => {
    const kind = ctx.readerState.locationKind;
    const current = ctx.readerState.current;
    const total = ctx.readerState.total;
    const location =
      kind === 'page' && total > 0 && current > 0
        ? ctx.t('reader.progress.pageOf', { current: String(current), total: String(total) })
        : kind === 'chapter' && total > 0 && current > 0
          ? ctx.t('reader.progress.chapterOf', { current: String(current), total: String(total) })
          : formatReaderLocation(current, total);
    const ticks = readerProgressTickFractions(ctx.readerOutline, total, kind, ctx.annotations);
    ctx.readerChrome?.setProgress({
      chapterTitle: resolveReaderChapterTitle(ctx.readerState, ctx.readerOutline, locationFallback),
      location,
      progress: ctx.readerState.progress,
      ticks: ticks.chapters,
      bookmarkTicks: ticks.bookmarks,
    });
  };

  const goToProgress = (progress: number): void => {
    const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    if (ctx.pdfHandle !== null) {
      const total = ctx.pdfHandle.controller.totalPages;
      if (total > 0) {
        ctx.pdfHandle.scrollToPage(Math.max(1, Math.min(total, Math.round(clamped * total) || 1)));
        ctx.paged.syncPageState();
        ctx.sessionProgress.schedulePersist();
      }
      return;
    }
    if (ctx.cbzHandle !== null) {
      if (ctx.cbzHandle.totalPages > 0) {
        ctx.cbzHandle.scrollToProgress(clamped);
        ctx.paged.syncPageState();
        ctx.sessionProgress.schedulePersist();
      }
      return;
    }
    if (ctx.flowChapterCount === 0) {
      return;
    }
    const total = ctx.flowChapterCount;
    const pos = clamped * total;
    const chapterIndex = Math.min(total - 1, Math.max(0, Math.floor(pos)));
    ctx.sessionProgress.stage(
      stampReadingProgressTitle(
        {
          version: 2,
          kind: 'flow',
          index: chapterIndex,
          ratio: Math.min(1, Math.max(0, pos - chapterIndex)),
          total,
          updatedAt: Date.now(),
        },
        ctx.readerOutline,
      ),
    );
    ctx.sessionProgress.applyPendingWithRetry();
    ctx.flow.syncFlowState();
    ctx.sessionProgress.schedulePersist();
  };

  const comicChromeVisible = (): boolean =>
    ctx.pageHost.dataset.comicReader === 'true' && ctx.pageHost.dataset.comicChrome !== 'hidden';

  // 本函数是 chromeRevealObserver/pageChromeObserver 的回调；这里的每次 DOM
  // 属性写都必须是"变化才写"，否则等值 setAttribute 触发新 mutation record，
  // 微任务队列永不排空，渲染主线程死循环卡死（打开漫画时曾整机冻结）。
  const syncChromeRevealAttr = (): void => {
    const chromeShown = ctx.readerChrome?.isRevealed() === true;
    if (ctx.readerChrome !== null) {
      const chromeEl = ctx.readerChrome.element;
      if (chromeEl.hidden === chromeShown) {
        chromeEl.hidden = !chromeShown;
      }
      const ariaHidden = chromeShown ? 'false' : 'true';
      if (chromeEl.getAttribute('aria-hidden') !== ariaHidden) {
        chromeEl.setAttribute('aria-hidden', ariaHidden);
      }
    }
    syncReaderTitlebarReveal(ctx.root, chromeShown || comicChromeVisible());
    syncChromeProgress();
  };

  const syncChromeActionState = (): void => {
    if (typeof ctx.root.querySelector !== 'function') {
      return;
    }
    for (const action of ['toc', 'typography'] as const) {
      const button = ctx.root.querySelector<HTMLButtonElement>(
        `[data-reader-chrome-action="${action}"]`,
      );
      if (button === null) {
        continue;
      }
      const open = ctx.chromePanel === action;
      button.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };

  const closeChromePanel = (): boolean => {
    if (ctx.chromePanel === null) {
      return false;
    }
    const closing = ctx.chromePanel === 'toc' ? ctx.tocPanel : ctx.typePanel;
    const other = ctx.chromePanel === 'toc' ? ctx.typePanel : ctx.tocPanel;
    ctx.chromePanel = null;
    // 触屏 sheet 经 pinFixedOverlay 进入模块级 touchSheetPins（强引用 Map +
    // 键盘 MutationObserver）；关闭必须对称 unpin，否则观察者跨会话存活并
    // 回写已隐藏/已 detach 的面板。桌面端不 pin，保持原口径不动。
    if (readerChromeTouchMode()) {
      // 触屏退场：摘 data-open 走 220ms 出场过渡，收尾后置 hidden 并对称
      // unpin；桌面/jsdom 无过渡样式时同步落地（既有行为合同不变）。
      concealSheet(closing, () => {
        closing.hidden = true;
        if (readerChromeTouchMode()) {
          unpinFixedOverlay(closing);
        }
      });
      other.hidden = true;
      unpinFixedOverlay(other);
    } else {
      ctx.tocPanel.hidden = true;
      ctx.typePanel.hidden = true;
    }
    syncChromeActionState();
    return true;
  };

  const dismissReaderOverlayStep = (): boolean => {
    if (ctx.readerChrome !== null) {
      const closed = ctx.readerChrome.handleEscape();
      syncChromeRevealAttr();
      if (closed) return true;
    }
    if (ctx.cbzHandle?.hideChrome() === true) {
      return true;
    }
    if (ctx.selectionToolbar?.isVisible() === true) {
      ctx.annotation.hideSelectionToolbar();
      return true;
    }
    if (ctx.sessionAnnotation.sidebarVisibility().visible) {
      ctx.annotation.setSidebarVisible(false);
      return true;
    }
    return closeChromePanel();
  };

  const onDocumentEscapeCapture = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || ctx.destroyed) {
      return;
    }
    if (!ctx.sessionAnnotation.tabActive()) {
      return;
    }
    const target = event.target;
    // 根内按键仍走 root keydown；body 上的排版/目录 sheet 才在捕获期消费，
    // 避免 Android 侧滑返回落到 leftover 直接合书。
    if (target instanceof Node && ctx.root.contains(target)) {
      return;
    }
    if (dismissReaderOverlayStep()) {
      event.preventDefault();
    }
  };

  /**
   * 标签可见性变化（切换标签时由宿主调用）。侧栏挂在阅读根上，仍要显式同步
   * hidden，避免切标签后操作非活动文档。标签可见状态与侧栏合成策略在
   * session-annotation 核心（只改 shown，不改偏好）；本壳只做覆盖层/搜索/面板收尾。
   */
  const setTabActive = (active: boolean): void => {
    if (!ctx.sessionAnnotation.setTabActive(active)) {
      return;
    }
    if (!active) {
      ctx.annotation.hideSelectionToolbar();
      closeChromePanel();
      ctx.readerChrome?.dismiss();
      syncChromeRevealAttr();
      return;
    }
    // 切回标签时未完成的恢复重新计数重试（无待恢复时为空操作）。
    ctx.sessionProgress.retryPending();
  };

  // R4：主题切换（浅↔深）时重应用 flow 帧文字色，消除深底深字/浅底浅字不可读。
  // PDF/CBZ 为栅格/位图，宿主背景走 CSS 变量随主题更新，无需重渲染。
  const onThemeChange = (): void => {
    if (ctx.destroyed) {
      return;
    }
    ctx.flowRenderer.syncTheme();
    syncOpenOverlayThemes();
  };

  const returnToShelf = (): void => {
    ctx.sessionProgress.persistNow();
    closeChromePanel();
    ctx.readerChrome?.dismiss();
    syncChromeRevealAttr();
    ctx.deps.onReturnToShelf?.();
  };

  const applyTypographyPatch = (patch: Partial<ReaderTypography>): void => {
    const next = saveReaderTypography(ctx.preferenceStorage, patch);
    dispatchReaderTypographyPref(next);
    ctx.zoom.refreshViewport();
    renderTypographyPanel();
  };

  const applyFlowLayout = (layout: ReaderFlowLayout): void => {
    const next = parseReaderLayout(layout);
    saveReaderLayout(ctx.preferenceStorage, next);
    const pdfLive = ctx.pdfHandle !== null || ctx.loadedExt === 'pdf';
    try {
      ctx.flow.holdLayoutSwitching(() => {
        // 直播 PDF：只改 EPUB 存储键，不写 host / html / 广播呈现。
        if (pdfLive) {
          return;
        }
        applyReaderLayout(ctx.root, next);
        if (typeof document !== 'undefined') {
          applyReaderDocumentLayout(document.documentElement, 'reader', next);
        }
        dispatchReaderFlowLayoutPref(next);
        // 先写 data-reading-layout：scroll 时 bindTouchPaging/bindClickPaging
        // 的 enabled()（仅 paginated）立刻为假，点翻失效且不吞纵向滑动。
        if (next === 'scroll') {
          ctx.flowRenderer.remasureScrollFrames();
        } else {
          ctx.flow.remasurePaginatedFrames();
        }
      });
    } finally {
      ctx.zoom.refreshViewport();
      renderTypographyPanel();
      ctx.readerChrome?.syncStayRevealed();
      syncChromeRevealAttr();
    }
  };

  const syncOpenOverlayThemes = (): void => {
    adoptReaderOverlayTheme(ctx.typePanel, ctx.root);
    adoptReaderOverlayTheme(ctx.tocPanel, ctx.root);
    if (ctx.sidebar !== null) {
      adoptReaderOverlayTheme(ctx.sidebar.element, ctx.root);
    }
    if (ctx.selectionToolbar !== null) {
      adoptReaderOverlayTheme(ctx.selectionToolbar.element, ctx.root);
    }
  };

  const applyPaperTheme = (theme: ReaderThemeId): void => {
    const next = saveReaderTheme(ctx.preferenceStorage, theme);
    applyReaderTheme(ctx.root, next);
    const pane = ctx.dom.closestPane();
    if (pane !== null) {
      applyReaderTheme(pane, next);
    }
    ctx.flowRenderer.syncTheme();
    syncOpenOverlayThemes();
    notifyReaderWindowChrome();
    renderTypographyPanel();
  };

  const readerPanelCopy = (): ReaderChromePanelCopy => {
    const extraComicLabels = comicLocaleLabels(ctx.t);
    return {
    tocTitle: ctx.t('reader.toc.title'),
    tocEmpty: ctx.t('outline.empty'),
    tocSearch: ctx.t('outline.search'),
    tocEmptySearch: ctx.t('outline.emptySearch'),
    tocSearchCount: ctx.t('outline.searchCount'),
    tocCount: ctx.t('reader.toc.count'),
    typeTitle: ctx.t('reader.type.title'),
    theme: ctx.t('reader.type.theme'),
    size: ctx.t('reader.type.size'),
    font: ctx.t('reader.type.font'),
    lineHeight: ctx.t('reader.type.lineHeight'),
    measure: ctx.t('reader.type.measure'),
    layout: ctx.t('reader.type.layout'),
    paginated: ctx.t('reader.type.paginated'),
    scroll: ctx.t('reader.type.scroll'),
    smaller: ctx.t('view.zoomOut'),
    larger: ctx.t('view.zoomIn'),
    fonts: {
      body: ctx.t('reader.font.body'),
      sans: ctx.t('reader.font.sans'),
      serif: ctx.t('reader.font.serif'),
      mono: ctx.t('reader.font.mono'),
    },
    lineHeights: [
      ctx.t('reader.type.spacing.tight'),
      ctx.t('reader.type.spacing.normal'),
      ctx.t('reader.type.spacing.relaxed'),
      ctx.t('reader.type.spacing.loose'),
    ],
    measures: [
      ctx.t('reader.type.width.narrower'),
      ctx.t('reader.type.width.narrow'),
      ctx.t('reader.type.width.normal'),
      ctx.t('reader.type.width.wide'),
      ctx.t('reader.type.width.wider'),
    ],
    themes: {
      white: ctx.t('reader.theme.white'),
      sepia: ctx.t('reader.theme.sepia'),
      gray: ctx.t('reader.theme.gray'),
      night: ctx.t('reader.theme.night'),
    },
    comic: {
      direction: ctx.t('reader.comic.direction'),
      spread: ctx.t('reader.comic.spread'),
      vertical: ctx.t('reader.comic.vertical'),
      strip: extraComicLabels.strip,
      paged: ctx.t('reader.comic.paged'),
      leftToRight: ctx.t('reader.comic.ltr'),
      rightToLeft: ctx.t('reader.comic.rtl'),
      singlePage: ctx.t('reader.comic.single'),
      doublePage: ctx.t('reader.comic.double'),
      fit: extraComicLabels.fit,
      fitWidth: ctx.t('reader.comic.fitWidth'),
      fitScreen: extraComicLabels.fitScreen,
      fitHeight: extraComicLabels.fitHeight,
      fitOriginal: extraComicLabels.fitOriginal,
      cropMargins: ctx.t('reader.comic.cropMargins'),
      keepMargins: ctx.t('reader.comic.keepMargins'),
      margins: ctx.t('reader.comic.margins'),
    },
  };
  };

  const renderTocPanel = (): void => {
    const current = outlineLocationFromReader(ctx.readerState);
    fillReaderTocPanel(
      ctx.tocPanel,
      ctx.readerOutline,
      readerPanelCopy(),
      current,
      (item) => {
        ctx.jumpToOutlineItem(item);
        closeChromePanel();
      },
      () => {
        closeChromePanel();
      },
    );
  };

  /**
   * Typography panel format gate (R8): live format adapters are the
   * authority, the loaded extension covers the load window before a handle
   * exists, and anything undeterminable conservatively counts as flow.
   */
  const readerFormatKind = (): 'flow' | 'pdf' | 'comic' => {
    if (ctx.pdfHandle !== null || ctx.loadedExt === 'pdf') {
      return 'pdf';
    }
    if (ctx.cbzHandle !== null || (PAGE_EXTS.has(ctx.loadedExt) && ctx.loadedExt !== 'pdf')) {
      return 'comic';
    }
    return 'flow';
  };

  /** Map the comic sheet onto the live cbz handle; no new preference keys. */
  const comicTypographyControls = (): ReaderTypographyComicControls | null => {
    const handle = ctx.cbzHandle;
    if (handle === null) {
      return null;
    }
    return {
      preferences: handle.preferences,
      onPreferences: (patch) => {
        handle.setPreferences(patch);
        renderTypographyPanel();
      },
    };
  };

  const renderTypographyPanel = (): void => {
    const current = loadReaderTypography(ctx.preferenceStorage);
    fillReaderTypographyPanel(
      ctx.typePanel,
      current,
      loadReaderTheme(ctx.preferenceStorage),
      readerPanelCopy(),
      applyTypographyPatch,
      applyPaperTheme,
      (direction) =>
        applyTypographyPatch({
          fontScaleStep: nextReaderFontScaleStep(current.fontScaleStep, direction),
        }),
      loadReaderLayout(ctx.preferenceStorage),
      applyFlowLayout,
      readerFormatKind(),
      comicTypographyControls(),
    );
  };

  const openChromePanel = (next: 'toc' | 'typography'): void => {
    if (ctx.chromePanel === next) {
      closeChromePanel();
      return;
    }
    if (ctx.sessionAnnotation.sidebarVisibility().visible) {
      ctx.annotation.setSidebarVisible(false);
    }
    ctx.chromePanel = next;
    // 面板切换：被换下的面板直接隐藏（无退场过渡），同步摘 data-open，
    // 否则残留的 data-open 让下次 reveal 停在打开位（不播进场过渡）。
    // 激活面板先摘 hidden（reveal 契约：调用方负责显隐，助手只管 data-open）。
    if (next !== 'toc') {
      ctx.tocPanel.hidden = true;
      delete ctx.tocPanel.dataset.open;
    } else {
      ctx.tocPanel.hidden = false;
    }
    if (next !== 'typography') {
      ctx.typePanel.hidden = true;
      delete ctx.typePanel.dataset.open;
    } else {
      ctx.typePanel.hidden = false;
    }
    const panel = next === 'toc' ? ctx.tocPanel : ctx.typePanel;
    const action = next === 'toc' ? 'toc' : 'typography';
    mountReaderOverlay(panel, ctx.root);
    positionReaderChromePanel(
      panel,
      ctx.root,
      ctx.root.querySelector(`[data-reader-chrome-action="${action}"]`),
    );
    if (next === 'toc') {
      renderTocPanel();
      activateReaderTocPanel(ctx.tocPanel);
    } else {
      renderTypographyPanel();
    }
    if (readerChromeTouchMode()) {
      // 进场过渡：pin（is-touch-sheet 几何）与内容渲染落地后再挂 data-open。
      revealSheet(panel);
    }
    syncChromeActionState();
  };

  const mountReaderChrome = (): void => {
    if (!canMountReaderChrome()) {
      return;
    }
    ctx.readerChrome = createReaderChrome(ctx.root, {
      touchMode: readerChromeTouchMode(),
      locale: ctx.t('reader.chrome.bookmark') === 'Bookmark' ? 'en' : 'zh-CN',
      labels: readerChromeCopy(ctx.t),
      returnToShelf,
      openOutline: () => openChromePanel('toc'),
      openTypography: () => openChromePanel('typography'),
      openSearch: () => ctx.search.openSearch(),
      toggleBookmark: () => ctx.bookmarks.toggleBookmarkAtCurrentPosition(),
      isBookmarked: () => ctx.bookmarks.bookmarkAtStatePosition(ctx.readerState) !== null,
      onBookmarkTick: (fraction) => ctx.bookmarks.jumpToBookmarkTick(fraction),
      toggleSidebar: () =>
        ctx.annotation.setSidebarVisible(!ctx.sessionAnnotation.sidebarVisibility().visible),
      isOverlayOpen: () =>
        ctx.sessionAnnotation.sidebarVisibility().visible ||
        ctx.chromePanel !== null,
      // 一次退一层：TOC/排版 → 标注面板。点空白走同一条链。
      dismissOverlay: () => {
        if (closeChromePanel()) {
          return true;
        }
        if (ctx.sessionAnnotation.sidebarVisibility().visible) {
          ctx.annotation.setSidebarVisible(false);
          return true;
        }
        return false;
      },
      isSidebarVisible: () => ctx.sessionAnnotation.sidebarVisibility().visible,
      isSelectionToolbarVisible: () => ctx.selectionToolbar?.isVisible() === true,
      hideSelectionToolbar: () => ctx.annotation.hideSelectionToolbar(),
      stayRevealed: () =>
        ctx.cbzHandle === null &&
        ctx.pdfHandle === null &&
        !ctx.flowIsPaginated() &&
        ctx.dom.flowScrollContainer().scrollTop <= 16,
      suppressProgressDock: () =>
        ctx.pageHost.dataset.comicReader === 'true' || ctx.root.dataset.comicReader === 'true',
      onSeekProgress: goToProgress,
    });
    syncChromeProgress();
    pinChromeDocks();
    ctx.root.append(ctx.tocPanel, ctx.typePanel);
    ctx.root.addEventListener('click', syncChromeRevealAttr);
    ctx.root.addEventListener('pointermove', syncChromeRevealAttr);
    ctx.readerChrome.syncStayRevealed();
    watchPageChrome();
    syncChromeRevealAttr();
    syncChromeActionState();
    if (typeof MutationObserver === 'function') {
      ctx.chromeRevealObserver = new MutationObserver(syncChromeRevealAttr);
      try {
        ctx.chromeRevealObserver.observe(ctx.readerChrome.element, {
          attributes: true,
          attributeFilter: ['data-reader-chrome-revealed', 'data-revealed', 'class'],
        });
      } catch {
        ctx.chromeRevealObserver = null;
      }
    }
  };

  return {
    watchPageChrome,
    pinChromeDocks,
    syncChromeProgress,
    syncChromeRevealAttr,
    closeChromePanel,
    dismissReaderOverlayStep,
    onDocumentEscapeCapture,
    setTabActive,
    returnToShelf,
    applyTypographyPatch,
    applyFlowLayout,
    syncOpenOverlayThemes,
    applyPaperTheme,
    onThemeChange,
    mountReaderChrome,
  };
}
