/**
 * `reader-dom` — reader-view 拆分（T5-kernel-split）的 DOM 骨架与几何域：
 * 视图骨架构建（root/scroll/page 宿主/状态条/chrome 面板容器）、宿主几何
 * （closestPane/chromeHost/flowScrollContainer/articleOffsetInScroller/
 * chapterFromScroll）、阅读状态机（applyStateToDom/setReaderState 族）与
 * 跨域共享的模块级纯函数（文本层选择器、chrome 触屏判定、CSS 转义等）。
 * 纯移动自 reader-view.ts，行为不变。
 */

import type { MessageKey } from '../../i18n/messages.js';
import type { ReaderPhase, ReaderState } from '../types.js';
import {
  applyReaderLayout,
  loadReaderLayout,
  type ReaderFlowLayout,
} from '../reader-layout.js';
import { applyReaderTheme, loadReaderTheme } from '../reader-theme.js';
import {
  chapterIndexAtViewportTop,
  nearestVisibleChapterIndex,
} from '../../ui/reading-layout.js';
import type { ReaderViewContext } from './reader-context.js';

/** Strip/fit copy the i18n table does not own; sniff locale from an existing key. */
export function comicLocaleLabels(t: (key: MessageKey) => string): {
  strip: string;
  fit: string;
  fitScreen: string;
  fitHeight: string;
  fitOriginal: string;
  autoPage: string;
} {
  const chineseChrome = t('reader.comic.paged') === '横向翻页';
  if (chineseChrome) {
    return {
      strip: '连续条',
      fit: '适配',
      fitScreen: '适合屏幕',
      fitHeight: '适合高度',
      fitOriginal: '原图',
      autoPage: '自动',
    };
  }
  return {
    strip: 'Continuous strip',
    fit: 'Fit',
    fitScreen: 'Fit screen',
    fitHeight: 'Fit height',
    fitOriginal: 'Original',
    autoPage: 'Auto',
  };
}

/**
 * Touch chrome mode comes from the mobile platform flags stamped on the
 * document root (`mobile-platform.ts`). Desktop has neither flag → false,
 * keeping the 2.5s idle auto-hide and edge-hover reveal byte-identical.
 */
export function readerChromeTouchMode(): boolean {
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl == null || typeof rootEl.hasAttribute !== 'function') {
    return false;
  }
  return rootEl.hasAttribute('data-android') || rootEl.hasAttribute('data-touch-primary');
}

function dispatchReaderFlowLayoutPref(layout: ReaderFlowLayout): void {
  if (
    typeof document === 'undefined' ||
    typeof document.dispatchEvent !== 'function' ||
    typeof CustomEvent !== 'function'
  ) {
    return;
  }
  document.dispatchEvent(new CustomEvent('lightink:reader-flow-layout', { detail: layout }));
}

/** CSS 标识符转义（标注 id 用于属性选择器时）。 */
export function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

const notifyReaderWindowChrome = (): void => {
  if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('lightink:reader-theme'));
  }
};

/** 文本层相关变更：层容器插入，或层内部 childList 变更（pdfjs TextLayer.render 异步追加 span）。 */
function isEndOfContent(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains('endOfContent');
}

/**
 * 官方文本层选择器（T4）：`.pdfViewer > .page[data-page-number] > .textLayer`。
 * 页码为官方 `data-page-number`（1 基）；搜索命中与高亮渲染共用同一口径。
 */
export function pdfTextLayerSelector(page: number): string {
  return `.pdfViewer .page[data-page-number="${page}"] .textLayer`;
}

export function isTextLayerMutation(records: readonly MutationRecord[]): boolean {
  return records.some((record) => {
    const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    if (nodes.length > 0 && nodes.every(isEndOfContent)) {
      return false;
    }
    for (const node of Array.from(record.addedNodes)) {
      if (
        node.nodeType === 1 &&
        (node as Element).classList.contains('textLayer')
      ) {
        return true;
      }
    }
    const target = record.target;
    return (
      target.nodeType === 1 &&
      typeof (target as Element).closest === 'function' &&
      (target as Element).closest('.textLayer') !== null &&
      !(target as Element).classList.contains('endOfContent')
    );
  });
}

/** paged 族页宿主元素（staged/live 同构；commit 换装见 reader-paged-stage）。 */
export function createReaderPageHost(): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'lightink-reader-pages';
  element.dataset.readerHost = 'pages';
  element.hidden = true;
  return element;
}

export interface ReaderDomSurface {
  applyStateToDom(state: ReaderState): void;
  setReaderState(next: ReaderState): void;
  updateReaderState(patch: Partial<ReaderState>): void;
  setReaderPhase(phase: ReaderPhase, resetMetrics?: boolean): void;
  closestPane(): HTMLElement | null;
  chromeHost(): HTMLElement;
  flowScrollContainer(): HTMLElement;
  articleOffsetInScroller(article: HTMLElement, scroller: HTMLElement): number;
  chapterFromScroll(): number;
  firstVisibleChapter(): number;
  flowDocuments(): Document[];
  chapterFrame(index: number): HTMLIFrameElement | null;
}

/**
 * 构建 DOM 骨架并定义几何/状态机械。副作用顺序与原 reader-view 保持一致：
 * 骨架元素 → 布局/主题应用 → 挂载到 host → chrome 面板容器。
 */
export function setupReaderDom(ctx: ReaderViewContext): ReaderDomSurface {
  const host = ctx.host;
  const t = ctx.t;
  const preferenceStorage = ctx.preferenceStorage;
  const root = document.createElement('div');
  root.className = 'lightink-reader';
  root.setAttribute('role', 'document');
  root.tabIndex = 0;
  root.dataset.readerState = 'empty';

  const scrollHost = document.createElement('div');
  scrollHost.className = 'lightink-reader-scroll';
  scrollHost.dataset.readerHost = 'scroll';

  const pageHost = createReaderPageHost();

  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  const status = document.createElement('div');
  status.className = 'lightink-reader-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  const statusLabel = document.createElement('span');
  statusLabel.className = 'lightink-reader-status-label';
  const loadTrack = document.createElement('div');
  loadTrack.className = 'lightink-reader-load-track';
  loadTrack.hidden = true;
  loadTrack.setAttribute('role', 'progressbar');
  loadTrack.setAttribute('aria-valuemin', '0');
  loadTrack.setAttribute('aria-valuemax', '100');
  const loadFill = document.createElement('div');
  loadFill.className = 'lightink-reader-load-fill';
  loadTrack.appendChild(loadFill);
  status.append(statusLabel, loadTrack);

  root.append(scrollHost, pageHost, status);
  applyReaderLayout(root, loadReaderLayout(preferenceStorage));
  const initialTheme = loadReaderTheme(preferenceStorage);
  applyReaderTheme(root, initialTheme);
  const editorPane = host.closest?.('#lightink-editor-area');
  if (editorPane instanceof HTMLElement) {
    applyReaderTheme(editorPane, initialTheme);
  }
  host.appendChild(root);

  const tocPanel = document.createElement('div');
  tocPanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-toc';
  tocPanel.hidden = true;
  tocPanel.setAttribute('data-panel', 'toc');
  const typePanel = document.createElement('div');
  typePanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-typography';
  typePanel.hidden = true;
  typePanel.setAttribute('data-panel', 'typography');

  ctx.root = root;
  ctx.scrollHost = scrollHost;
  ctx.pageHost = pageHost;
  ctx.status = status;
  ctx.statusLabel = statusLabel;
  ctx.loadTrack = loadTrack;
  ctx.tocPanel = tocPanel;
  ctx.typePanel = typePanel;

  const applyStateToDom = (state: ReaderState): void => {
    root.dataset.readerState = state.phase;
    root.setAttribute('aria-busy', state.phase === 'loading' ? 'true' : 'false');
    const messageKey =
      state.phase === 'loading'
        ? 'reader.loading'
        : state.phase === 'cancelled'
          ? 'reader.cancelled'
          : state.phase === 'error'
            ? 'reader.failed'
            : null;
    status.hidden = messageKey === null;
    statusLabel.textContent = messageKey === null ? '' : t(messageKey);
    loadTrack.hidden = state.phase !== 'loading';
  };

  const setReaderState = (next: ReaderState): void => {
    const changed =
      ctx.readerState.phase !== next.phase ||
      ctx.readerState.current !== next.current ||
      ctx.readerState.total !== next.total ||
      ctx.readerState.progress !== next.progress ||
      ctx.readerState.scale !== next.scale ||
      ctx.readerState.locationKind !== next.locationKind ||
      ctx.readerState.comicMetadata !== next.comicMetadata;
    if (changed) {
      ctx.readerState = Object.freeze({ ...next });
    }
    applyStateToDom(ctx.readerState);
    ctx.chrome.syncChromeProgress();
    if (!changed) return;
    for (const listener of ctx.stateListeners) {
      try {
        listener(ctx.readerState);
      } catch {
        // Application chrome must not be able to interrupt reader rendering.
      }
    }
  };

  const updateReaderState = (patch: Partial<ReaderState>): void => {
    setReaderState({ ...ctx.readerState, ...patch });
  };

  const setReaderPhase = (phase: ReaderPhase, resetMetrics = false): void => {
    setReaderState(
      resetMetrics
        ? { phase, current: 0, total: 0, progress: 0, scale: 1, locationKind: null }
        : { ...ctx.readerState, phase },
    );
  };

  const closestPane = (): HTMLElement | null => {
    if (typeof host.closest !== 'function') {
      return null;
    }
    return host.closest('#lightink-editor-area');
  };

  const chromeHost = (): HTMLElement => {
    if (typeof document !== 'undefined') {
      return document.getElementById('lightink-main') ?? closestPane() ?? root;
    }
    return closestPane() ?? root;
  };

  const flowScrollContainer = (): HTMLElement => closestPane() ?? scrollHost;

  const articleOffsetInScroller = (article: HTMLElement, scroller: HTMLElement): number => {
    const articleRect = article.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return articleRect.top - scrollerRect.top + scroller.scrollTop;
  };

  /** 流式：视口顶部盖住的章节（稀疏窗口不能用 NodeList 下标；占位条只在缺口里认）。 */
  const chapterFromScroll = (): number => {
    const scroller = flowScrollContainer();
    const hostTop = scroller.getBoundingClientRect().top;
    const boxesOf = (
      selector: string,
      indexAttr: 'chapterIndex' | 'chapterSpacer',
    ): Array<{ index: number; top: number; bottom: number }> =>
      Array.from(scrollHost.querySelectorAll<HTMLElement>(selector))
        .map((node) => {
          const index = Number(node.dataset[indexAttr]);
          const rect = node.getBoundingClientRect();
          const height = node.offsetHeight;
          const bottom =
            Number.isFinite(rect.bottom) && rect.bottom > rect.top
              ? rect.bottom
              : rect.top + Math.max(0, height);
          return { index, top: rect.top, bottom };
        })
        .filter((box) => Number.isSafeInteger(box.index) && box.index >= 0);
    const real = boxesOf('.lightink-reader-chapter', 'chapterIndex');
    const coveringReal = real.filter((box) => box.top <= hostTop + 1 && box.bottom > hostTop + 1);
    if (coveringReal.length > 0) {
      return chapterIndexAtViewportTop(coveringReal, hostTop);
    }
    const spacers = boxesOf('.lightink-reader-chapter-spacer', 'chapterSpacer');
    const coveringSpacer = spacers.filter(
      (box) => box.top <= hostTop + 1 && box.bottom > hostTop + 1,
    );
    if (coveringSpacer.length > 0) {
      return chapterIndexAtViewportTop(coveringSpacer, hostTop);
    }
    if (real.length > 0) {
      return nearestVisibleChapterIndex(real, hostTop);
    }
    if (spacers.length > 0) {
      return nearestVisibleChapterIndex(spacers, hostTop);
    }
    return 0;
  };

  const firstVisibleChapter = (): number => {
    if (ctx.flowIsPaginated()) {
      const active = scrollHost.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
      const index = Number(active?.dataset.chapterIndex ?? 0);
      return Number.isSafeInteger(index) ? index : 0;
    }
    return chapterFromScroll();
  };

  const flowDocuments = (): Document[] =>
    Array.from(
      scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    )
      .map((frame) => frame.contentDocument)
      .filter((doc): doc is Document => doc !== null && doc.body !== null);

  const chapterFrame = (index: number): HTMLIFrameElement | null =>
    scrollHost.querySelector<HTMLIFrameElement>(
      `.lightink-reader-chapter[data-chapter-index="${String(index)}"] .lightink-reader-chapter-frame`,
    );

  return {
    applyStateToDom,
    setReaderState,
    updateReaderState,
    setReaderPhase,
    closestPane,
    chromeHost,
    flowScrollContainer,
    articleOffsetInScroller,
    chapterFromScroll,
    firstVisibleChapter,
    flowDocuments,
    chapterFrame,
  };
}

export { dispatchReaderFlowLayoutPref, notifyReaderWindowChrome };
