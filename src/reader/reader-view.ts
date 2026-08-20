/**
 * `reader-view` — 只读阅读视图的编排壳（T3 骨架 + T4 流式 + T5 页式 + T6 标注；
 * T5 起章节 iframe 渲染/生命周期拆入 src/reader/flow-renderer.ts）。
 *
 * 流式格式渲染章节化 HTML（滚动宿主）；PDF/CBZ 渲染页（页宿主）。标注按内容哈希
 * （Rust content_hash）关联：加载时读出 → 流式高亮渲染 <mark> + 侧栏列表跳转；
 * 选中正文可加高亮，工具栏可加书签/笔记，侧栏可移除，变更写回 app_data_dir。
 * 本壳保留：加载生命周期/状态机、阅读进度、标注与搜索接线、翻页导航编排。
 * 只消费主题令牌 var(--lightink-*) 与 --lightink-font-scale。
 */

import './reader.css';
import type { MessageKey } from '../i18n/messages.js';
import { parseReaderContent, type ReaderInputSource } from './formats/index.js';
import {
  normalizeReaderTarget,
  readerIdentityKey,
  type ArchiveProvider,
  type RandomAccessSource,
  type ReaderTarget,
  type RemoteReaderTarget,
} from './sources/types.js';
import type { ReaderChapter, ReaderContent } from './formats/types.js';
import { ParseError } from './formats/types.js';
import { sanitizeReaderCss } from './sanitize-css.js';
import { renderCbzInto, type CbzRenderHandle } from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import {
  AnnotationWriteQueue,
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
  type Locator,
} from './annotations.js';
import {
  annotationMarkFromEventTarget,
  flowLocatorFromRange,
  pdfTextLocatorFromRange,
  resolveTextQuoteRange,
} from './annotation-locator.js';
import {
  annotationMarkSpec,
  renderAnnotationMarks,
  removeAnnotationMarks,
  type AnnotationMarkSpec,
} from './annotation-render.js';
import {
  createAnnotationSidebar,
  type AnnotationSidebar,
  type SearchHitView,
} from './annotation-sidebar.js';
import {
  createSelectionToolbar,
  type SelectionToolbar,
} from './selection-toolbar.js';
import { showNoteDialog } from './note-dialog.js';
import { outlineFromEntries } from './outline.js';
import type { OutlineItem } from '../outline/outline-model.js';
import {
  findTextHits,
  nearestMatchIndex,
  nextMatchIndex,
  preserveMatchIndex,
  sanitizeSearchQuery,
  snippetAround,
  type PdfSearchMatch,
} from './search-panel.js';
import {
  clearSearchMarks,
  flowSearchMarkKey,
  renderSearchMarks,
  SEARCH_MARK_CURRENT_CLASS,
  type SearchMarkSpec,
} from './search-overlay.js';
import type {
  ReaderInstance,
  ReaderLoadOptions,
  ReaderPhase,
  ReaderState,
  ReaderStateListener,
} from './types.js';
import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
} from './load-lifecycle.js';
import {
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../media/remote-image-policy.js';
import { extOfPath } from '../file/path-ext.js';
import {
  chapterScrollRatio,
  chapterScrollTop,
  loadReadingProgress,
  resolveProgressStorage,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from './reading-progress.js';
import {
  advancePagedScroller,
  advanceScrolledScroller,
  applyPagedProgress,
  createCoalescedScrollHandler,
  createPagedWheelGate,
  createResizeSettle,
  nearestVisibleSlot,
  pagedFrameStep,
  pagedProgressRatio,
  rafFrameScheduler,
  scrollToKeepViewportAnchor,
  snapPagedScroller,
  viewportAnchor,
} from '../ui/reading-layout.js';
import {
  applyReaderDocumentLayout,
  applyReaderLayout,
  loadReaderLayout,
  parseReaderLayout,
  saveReaderLayout,
  type ReaderFlowLayout,
} from './reader-layout.js';
import { createFlowRenderer, readerPagedScroller } from './flow-renderer.js';
import { attachRemoteSource } from './sources/remote-source.js';
import {
  NATIVE_ARCHIVE_EXTENSIONS,
  openNativeArchive,
  type ArchivePasswordProvider,
} from './sources/native-archive.js';
import { fnv1a64Hex } from './document-hash.js';
import type { ComicMetadata } from './comic-model.js';
import { loadComicPreferences } from './comic-preferences.js';
import { createReaderChrome, type ReaderChrome } from './reader-chrome.js';
import {
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  pinFixedOverlay,
  positionReaderChromePanel,
  unpinFixedOverlay,
  type ReaderChromePanelCopy,
} from './reader-chrome-panels.js';
import {
  applyReaderTheme,
  loadReaderTheme,
  saveReaderTheme,
  type ReaderThemeId,
} from './reader-theme.js';
import {
  loadReaderTypography,
  nextReaderFontScaleStep,
  saveReaderTypography,
  type ReaderTypography,
} from './reader-typography.js';

const PAGE_EXTS = new Set(['pdf', 'cbz', ...NATIVE_ARCHIVE_EXTENSIONS]);

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

function typographyStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 仅用于稳定标注 id（无加密强度需求）。 */
function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID().slice(0, 8);
  }
  return `a-${Date.now().toString(36)}`;
}

/** CSS 标识符转义（标注 id 用于属性选择器时）。 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** 文本层相关变更：层容器插入，或层内部 childList 变更（pdfjs TextLayer.render 异步追加 span）。 */
function isEndOfContent(node: Node): boolean {
  return node.nodeType === 1 && (node as Element).classList.contains('endOfContent');
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
        (node as Element).classList.contains('lightink-reader-text-layer')
      ) {
        return true;
      }
    }
    const target = record.target;
    return (
      target.nodeType === 1 &&
      typeof (target as Element).closest === 'function' &&
      (target as Element).closest('.lightink-reader-text-layer') !== null &&
      !(target as Element).classList.contains('endOfContent')
    );
  });
}

export interface ReaderViewDeps {
  /** 读取文件原始字节（生产为 invoke read_file_bytes raw IPC → Uint8Array）。 */
  readBytes?: (filePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /**
   * 分块读取文件字节（T8 txt 分块解析；生产为 invoke read_file_bytes 带
   * offset/length，raw IPC 返回窗口字节，EOF 处返回短块）。缺省时 txt 回退整读。
   */
  readChunk?: (
    filePath: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
  /** 翻译 i18n key（生产为 i18n.t）。 */
  t?: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 文件内容哈希（Rust content_hash）；缺省则不启用标注。 */
  getContentHash?: (filePath: string) => Promise<string>;
  /** 读标注 JSON（Rust read_annotations）。 */
  readAnnotations?: (contentHash: string) => Promise<string>;
  /** 写标注 JSON（Rust write_annotations）。 */
  writeAnnotations?: (contentHash: string, json: string) => Promise<void>;
  /** 非阻断提示（标注读失败/写失败时）。 */
  notify?: (message: string) => void;
  /** Session-only consent for remote images; injectable for focused tests. */
  remoteImagePolicy?: RemoteImagePolicy;
  /** Injectable flow parser for lifecycle tests. */
  parseContent?: (
    filePath: string,
    source: ReaderInputSource,
    signal?: AbortSignal,
  ) => Promise<ReaderContent>;
  /** Bind an opaque backend handle to a random-access source. */
  openRemoteSource?: (
    target: RemoteReaderTarget,
    signal?: AbortSignal,
  ) => Promise<RandomAccessSource>;
  /** Open a native RAR/7z provider; injectable for focused tests. */
  openArchiveProvider?: (
    target: ReaderTarget,
    signal?: AbortSignal,
  ) => Promise<ArchiveProvider>;
  /** Session-only password prompt used by encrypted native archives. */
  requestArchivePassword?: ArchivePasswordProvider;
  /** Injectable progress storage; production uses localStorage. */
  progressStorage?: ProgressStorage | null;
  /** Portable preference storage (falls back to browser localStorage). */
  preferenceStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  } | null;
  /** Persist normalized ComicInfo metadata for an existing library item. */
  onComicMetadata?: (target: ReaderTarget, metadata: ComicMetadata) => void | Promise<void>;
  /**
   * After a successful load, report the storage id used for this work so the
   * open-book path can write the shelf `item.id → progressId` alias. Failed or
   * cancelled loads must not fire this (unopened OPDS rows stay alias-free).
   */
  onProgressBound?: (progressId: string, target: ReaderTarget) => void;
  /** Close the open book and return to the shelf (window stays open). */
  onReturnToShelf?: () => void;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  const t = deps.t ?? ((key: MessageKey) => key);
  const preferenceStorage = deps.preferenceStorage ?? typographyStorage();
  const root = document.createElement('div');
  root.className = 'lightink-reader';
  root.setAttribute('role', 'document');
  root.tabIndex = 0;
  root.dataset.readerState = 'empty';

  const scrollHost = document.createElement('div');
  scrollHost.className = 'lightink-reader-scroll';
  scrollHost.dataset.readerHost = 'scroll';

  const createPageHost = (): HTMLDivElement => {
    const element = document.createElement('div');
    element.className = 'lightink-reader-pages';
    element.dataset.readerHost = 'pages';
    element.hidden = true;
    return element;
  };
  let pageHost = createPageHost();

  const empty = document.createElement('div');
  empty.className = 'lightink-reader-empty';
  empty.textContent = t('reader.empty');
  scrollHost.appendChild(empty);

  const status = document.createElement('div');
  status.className = 'lightink-reader-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  root.append(scrollHost, pageHost, status);
  applyReaderLayout(root, loadReaderLayout(preferenceStorage));
  const initialTheme = loadReaderTheme(preferenceStorage);
  applyReaderTheme(root, initialTheme);
  const editorPane = host.closest?.('#lightink-editor-area');
  if (editorPane instanceof HTMLElement) {
    applyReaderTheme(editorPane, initialTheme);
  }
  host.appendChild(root);
  const flowIsPaginated = (): boolean =>
    parseReaderLayout(root.dataset.readingLayout) === 'paginated';

  let readerChrome: ReaderChrome | null = null;
  let chromePanel: 'toc' | 'typography' | null = null;
  let chromeRevealObserver: MutationObserver | null = null;
  const tocPanel = document.createElement('div');
  tocPanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-toc';
  tocPanel.hidden = true;
  tocPanel.setAttribute('data-panel', 'toc');
  const typePanel = document.createElement('div');
  typePanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-typography';
  typePanel.hidden = true;
  typePanel.setAttribute('data-panel', 'typography');

  const annotationsEnabled = deps.readAnnotations !== undefined;

  let pdfHandle: PdfRenderHandle | null = null;
  let cbzHandle: CbzRenderHandle | null = null;
  let annotations: Annotation[] = [];
  let contentHash: string | null = null;
  let sidebar: AnnotationSidebar | null = null;
  let sidebarBackdrop: HTMLButtonElement | null = null;
  /** 标注侧栏默认隐藏；桌面占据固定列，窄窗切换为覆盖式 drawer。 */
  let sidebarVisible = false;
  /** 本阅读标签当前是否可见（切走时需隐藏 portal 到共享 chrome 的覆盖层）。 */
  let tabActive = true;
  /** 划选工具栏（R3）：划选后确认再产生标注；懒创建（标注启用时）。 */
  let selectionToolbar: SelectionToolbar | null = null;
  /** mouseup 时捕获的待确认划选（locator + quote + 命中的已有高亮 id + 来源 frame）。 */
  let pendingSelection: {
    locator: Locator;
    quote: string;
    existingHighlightId: string | null;
    frame: HTMLIFrameElement | null;
  } | null = null;
  let loadedExt = '';
  let readerOutline: OutlineItem[] = [];
  let exportChapters: ReaderChapter[] = [];
  let exportStylesheet = '';
  let exportEmbedImages:
    | ((
        html: string,
        mode?: 'inline' | 'blob',
      ) => Promise<{ html: string; missing: readonly string[] }>)
    | null = null;
  let loadGeneration = 0;
  let activeLoadController: AbortController | null = null;
  let destroyed = false;
  let flowContentDispose: (() => void) | null = null;
  /** PDF 搜索状态（查询/命中/活动命中索引）；UI 在标注侧栏。 */
  let pdfSearch: { query: string; matches: PdfSearchMatch[]; active: number } | null = null;
  let flowSearch: {
    query: string;
    /** 章索引 → 该章命中 spec（共享幂等引擎按 host 渲染与类名校正）。 */
    byChapter: Map<number, SearchMarkSpec[]>;
    marks: HTMLElement[];
    active: number;
  } | null = null;
  let searchGeneration = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** 激活跳转待滚动的命中 key（页:起:止）：命中首次就绪时滚动一次后清除。 */
  let pendingSearchScrollKey: string | null = null;
  const annotationWriteQueue = new AnnotationWriteQueue();
  const remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
  const progressStorage = resolveProgressStorage(deps.progressStorage);
  let progressId = '';
  let pendingRestore: ReadingProgress | null = null;
  let lastFlowProgress: ReadingProgress | null = null;
  let restoreAttempts = 0;
  let progressSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let layoutSwitching = false;
  /**
   * T6 缩放性能：字号档位变更 settle 后仍待补分栏的离屏章索引（翻页模式
   * 惰性重分栏标记；null = 无待补章）。仅视口相交章在 settle 时立即重分栏，
   * 离屏章延迟到 setActiveChapter 激活时补，避免全部章节整批重分栏。
   */
  let stalePaginatedChapters: Set<number> | null = null;
  /** T6：字号缩放档位合并去抖的 settle 定时器 cancel（destroy/切换时作废）。 */
  let cancelFontScaleRefresh: (() => void) | null = null;

  // T5：章节 iframe 渲染/生命周期拆入 flow-renderer；本编排壳经 hooks 回调
  // 状态机/进度/标注/搜索（hooks 在调用时求值，晚于其定义点亦可）。
  const flowRenderer = createFlowRenderer(scrollHost, root, {
    t,
    remoteImagePolicy,
    syncState: () => syncFlowState(),
    applyPendingRestore: () => {
      if (pendingRestore !== null) {
        applySavedProgress();
      }
    },
    renderHighlights: () => {
      bindFlowFrameLeftoverEscape();
      renderHighlights();
    },
    handleNoteMarkClick: (event) => {
      const annotation = annotationFromMark(event.target);
      if (annotation !== null && annotation.kind === 'note') {
        event.preventDefault();
        openNote(annotation);
        return true;
      }
      const target = event.target;
      const link =
        target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
      if (link === null) {
        readerChrome?.handleSurfaceClick(event);
        syncChromeRevealAttr();
      }
      return false;
    },
    onSelectionMouseUp: (selection, chapter, body, frame) =>
      onFlowSelectionMouseUp(selection, chapter, body, frame),
    openSearch: (seed) => openSearch(seed),
    advanceReading: (direction) => advanceReading(direction),
    advancePagedWheel: (direction) => {
      if (gatePagedWheel(direction, advanceReading)) {
        hideSelectionToolbar();
        return true;
      }
      return false;
    },
    dismissSelectionToolbar: () => dismissReaderOverlayStep(),
    isLayoutSwitching: () => layoutSwitching,
    scrollContainer: () => flowScrollContainer(),
    onFramePointerMove: ({ clientY }) => {
      readerChrome?.handlePointerMove({ clientY });
      syncChromeRevealAttr();
    },
  });
  const clearFlowBindings = (): void => {
    flowRenderer.clear();
  };
  /** T6：视口相交的章节索引（翻页模式下即活动章；判定与 flow-renderer 同口径）。 */
  const visibleChapterIndexes = (): Set<number> => {
    const hostRect = scrollHost.getBoundingClientRect();
    const visible = new Set<number>();
    for (const chapter of scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      const rect = chapter.getBoundingClientRect();
      if (rect.bottom > hostRect.top && rect.top < hostRect.bottom) {
        visible.add(Number(chapter.dataset.chapterIndex));
      }
    }
    return visible;
  };
  const setActiveChapter = (index: number): void => {
    flowRenderer.setActiveChapter(index);
    // T6：离屏章惰性分栏——缩放后仍未按新档分栏的章在激活时补一次
    // applyPaginatedDocument（snap:false 不抢滚动位置，由调用方决定落点）。
    if (
      stalePaginatedChapters !== null &&
      flowIsPaginated() &&
      stalePaginatedChapters.delete(index)
    ) {
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter[data-chapter-index="${index}"] .lightink-reader-chapter-frame`,
      );
      const frameDocument = frame?.contentDocument ?? null;
      if (frame !== null && frame !== undefined && frameDocument !== null) {
        applyPaginatedDocument(frame, frameDocument, { snap: false });
      }
    }
  };
  const visibleFlowFrame = (): HTMLIFrameElement | null => flowRenderer.visibleFrame();
  const applyPaginatedDocument = (
    frame: HTMLIFrameElement,
    frameDocument: Document,
    options?: { restoreRatio?: number; snap?: boolean },
  ): void => {
    flowRenderer.applyPaginatedDocument(frame, frameDocument, options);
  };
  const remasureScrollFrames = (): void => {
    layoutSwitching = true;
    try {
      flowRenderer.remasureScrollFrames();
    } finally {
      layoutSwitching = false;
    }
  };
  const syncVisibleFlowFrames = (): void => {
    flowRenderer.syncVisibleFrames();
  };

  const stateListeners = new Set<ReaderStateListener>();
  let readerState: ReaderState = Object.freeze({
    phase: 'empty',
    current: 0,
    total: 0,
    progress: 0,
    scale: 1,
    locationKind: null,
  });

  const currentProgressSnapshot = (): ReadingProgress | null => {
    if (pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      const page = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
      if (page < 1) {
        return null;
      }
      return {
        version: 1,
        kind: 'page',
        index: page,
        ratio: 0,
        updatedAt: Date.now(),
      };
    }
    const total = scrollHost.querySelectorAll('.lightink-reader-chapter').length;
    if (total === 0) {
      return null;
    }
    const chapterIndex = Math.max(0, readerState.current - 1);
    if (flowIsPaginated()) {
      const doc = visibleFlowFrame()?.contentDocument;
      const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
      return {
        version: 1,
        kind: 'flow',
        index: chapterIndex,
        ratio: scroller === null ? 0 : pagedProgressRatio(scroller),
        updatedAt: Date.now(),
      };
    }
    const scroller = flowScrollContainer();
    const article = scrollHost.querySelector<HTMLElement>(
      `.lightink-reader-chapter[data-chapter-index="${chapterIndex}"]`,
    );
    const chapterHeight = article?.offsetHeight ?? 0;
    if (article !== null && chapterHeight > 0) {
      return {
        version: 1,
        kind: 'flow',
        index: chapterIndex,
        ratio: chapterScrollRatio(
          scroller.scrollTop,
          articleOffsetInScroller(article, scroller),
          chapterHeight,
        ),
        updatedAt: Date.now(),
      };
    }
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return {
      version: 1,
      kind: 'flow',
      index: chapterIndex,
      ratio: maxScroll === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)),
      updatedAt: Date.now(),
    };
  };

  const rememberFlowProgress = (): void => {
    const snapshot = currentProgressSnapshot();
    if (snapshot !== null) {
      lastFlowProgress = snapshot;
    }
  };

  const persistReadingProgress = (): void => {
    if (progressId === '' || readerState.phase !== 'ready' || pendingRestore !== null) {
      return;
    }
    rememberFlowProgress();
    if (lastFlowProgress !== null) {
      saveReadingProgress(progressStorage, progressId, lastFlowProgress);
    }
  };

  const schedulePersistReadingProgress = (): void => {
    if (progressSaveTimer !== null) {
      clearTimeout(progressSaveTimer);
    }
    progressSaveTimer = setTimeout(() => {
      progressSaveTimer = null;
      persistReadingProgress();
    }, 400);
  };

  const applySavedProgress = (): boolean => {
    const saved = pendingRestore;
    if (saved === null) {
      return true;
    }
    if (saved.kind === 'page') {
      if (pdfHandle !== null) {
        pdfHandle.scrollToPage(saved.index);
        pendingRestore = null;
        return true;
      }
      if (cbzHandle !== null) {
        cbzHandle.scrollToPage(saved.index);
        pendingRestore = null;
        return true;
      }
      return false;
    }
    const chapters = scrollHost.querySelectorAll('.lightink-reader-chapter');
    if (chapters.length === 0) {
      return false;
    }
    if (flowIsPaginated()) {
      setActiveChapter(Math.min(saved.index, chapters.length - 1));
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter[data-chapter-index="${Math.min(saved.index, chapters.length - 1)}"] .lightink-reader-chapter-frame`,
      );
      const doc = frame?.contentDocument;
      const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
      if (scroller === null || scroller.clientWidth <= 1) {
        restoreAttempts += 1;
        if (restoreAttempts >= 8) {
          pendingRestore = null;
          return true;
        }
        return false;
      }
      const step = pagedFrameStep(scroller);
      applyPagedProgress(scroller, saved.ratio, step);
      snapPagedScroller(scroller, step);
      pendingRestore = null;
      return true;
    }
    const scroller = flowScrollContainer();
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll <= 0 && restoreAttempts < 8) {
      restoreAttempts += 1;
      return false;
    }
    const article = chapters[Math.min(saved.index, chapters.length - 1)] as HTMLElement | undefined;
    if (article !== undefined && article.offsetHeight > 0) {
      scroller.scrollTop = Math.min(
        maxScroll,
        chapterScrollTop(
          articleOffsetInScroller(article, scroller),
          article.offsetHeight,
          saved.ratio,
        ),
      );
    } else {
      scroller.scrollTop = Math.min(maxScroll, Math.round(saved.ratio * maxScroll));
    }
    pendingRestore = null;
    return true;
  };

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
    status.textContent = messageKey === null ? '' : t(messageKey);
  };

  const setReaderState = (next: ReaderState): void => {
    const changed =
      readerState.phase !== next.phase ||
      readerState.current !== next.current ||
      readerState.total !== next.total ||
      readerState.progress !== next.progress ||
      readerState.scale !== next.scale ||
      readerState.locationKind !== next.locationKind ||
      readerState.comicMetadata !== next.comicMetadata;
    if (changed) {
      readerState = Object.freeze({ ...next });
    }
    applyStateToDom(readerState);
    if (!changed) return;
    for (const listener of stateListeners) {
      try {
        listener(readerState);
      } catch {
        // Application chrome must not be able to interrupt reader rendering.
      }
    }
  };

  const updateReaderState = (patch: Partial<ReaderState>): void => {
    setReaderState({ ...readerState, ...patch });
  };

  const setReaderPhase = (phase: ReaderPhase, resetMetrics = false): void => {
    setReaderState(
      resetMetrics
        ? { phase, current: 0, total: 0, progress: 0, scale: 1, locationKind: null }
        : { ...readerState, phase },
    );
  };

  applyStateToDom(readerState);

  const saveAnnotations = async (): Promise<void> => {
    if (contentHash === null || deps.writeAnnotations === undefined) {
      return;
    }
    const saveHash = contentHash;
    const json = serializeAnnotations(annotations);
    await annotationWriteQueue.enqueue(
      saveHash,
      json,
      deps.writeAnnotations,
      () => {
        if (!destroyed && contentHash === saveHash) {
          deps.notify?.(t('annotation.saveFailed'));
        }
      },
    );
  };

  /** 移除标注（侧栏/划选工具栏共用）：更新集合、经共享引擎清正文 mark（flow 正文与 PDF 文本层）、保存。 */
  const removeAnnotationById = (id: string): void => {
    annotations = annotations.filter((a) => a.id !== id);
    for (const doc of flowDocuments()) {
      removeAnnotationMarks(doc.body, id);
    }
    for (const layer of pageHost.querySelectorAll('.lightink-reader-text-layer')) {
      removeAnnotationMarks(layer, id);
    }
    renderSidebarAnnotations();
    void saveAnnotations();
  };

  const hideSelectionToolbar = (): void => {
    pendingSelection = null;
    selectionToolbar?.hide();
  };

  const openNote = (annotation: Annotation): void => {
    if (annotation.kind !== 'note') {
      return;
    }
    void (async () => {
      const generation = loadGeneration;
      const input = await showNoteDialog(
        document,
        annotation.note ?? '',
        { t, editing: true },
        annotation.quote,
      );
      if (input === null || destroyed || generation !== loadGeneration) {
        return;
      }
      annotations = annotations.map((item) =>
        item.id === annotation.id ? { ...item, note: input } : item,
      );
      renderSidebarAnnotations();
      void saveAnnotations();
    })();
  };

  const annotationFromMark = (target: EventTarget | null): Annotation | null => {
    const id = annotationMarkFromEventTarget(target)?.getAttribute('data-annotation-id') ?? '';
    if (id === '') {
      return null;
    }
    return annotations.find((item) => item.id === id) ?? null;
  };

  /** 工具栏动作派发（R3）：确认后才创建/移除标注；复制始终可用。 */
  const ensureSelectionToolbar = (): void => {
    if (selectionToolbar !== null) {
      return;
    }
    selectionToolbar = createSelectionToolbar({
      t,
      onAction: (action, detail) => {
        const pending = pendingSelection;
        pendingSelection = null;
        if (pending === null) {
          return;
        }
        // 确认后清空来源选区（flow 为 iframe 选区，PDF 为主文档选区）。
        const clearSourceSelection = (): void => {
          if (pending.frame !== null) {
            pending.frame.contentWindow?.getSelection()?.removeAllRanges();
          } else {
            window.getSelection()?.removeAllRanges();
          }
        };
        if (action === 'removeHighlight') {
          clearSourceSelection();
          if (pending.existingHighlightId !== null) {
            removeAnnotationById(pending.existingHighlightId);
          }
          return;
        }
        if (action === 'copy') {
          void navigator.clipboard?.writeText(pending.quote).catch(() => undefined);
          return;
        }
        if (deps.writeAnnotations === undefined) {
          return;
        }
        if (action === 'note') {
          void (async () => {
            const generation = loadGeneration;
            const input = await showNoteDialog(document, '', { t }, pending.quote);
            if (input === null) {
              return; // 取消：保留选区、不产生标注
            }
            if (destroyed || generation !== loadGeneration) {
              return; // 弹层期间已切换文档/销毁：丢弃迟到保存
            }
            clearSourceSelection();
            appendAnnotation('note', pending.locator, pending.quote, input);
          })();
          return;
        }
        clearSourceSelection();
        appendAnnotation('highlight', pending.locator, pending.quote, undefined, detail?.color);
      },
    });
    root.appendChild(selectionToolbar.element);
  };

  /** 当前阅读位置的定位器（书签/笔记用）。 */
  const currentPositionLocator = (): Locator => {
    if (pdfHandle !== null) {
      return { format: 'pdf', page: pdfHandle.controller.page, quote: '' };
    }
    if (cbzHandle !== null) {
      return { format: 'cbz', page: cbzHandle.currentPage };
    }
    const chapter = firstVisibleChapter();
    const article = scrollHost.querySelector<HTMLElement>(
      `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
    );
    const body = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')
      ?.contentDocument?.body;
    const text = body?.textContent ?? '';
    const visibleOffset = Math.max(0, scrollHost.scrollTop - (article?.offsetTop ?? 0));
    const progress =
      article === null || article === undefined || article.offsetHeight <= 0
        ? 0
        : Math.min(1, visibleOffset / article.offsetHeight);
    const start = Math.floor(text.length * progress);
    const anchor = {
      start,
      end: start,
      quote: '',
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(start, start + 32),
    };
    if (loadedExt === 'txt') {
      return { format: 'text', ...anchor };
    }
    return { format: 'flow', chapter, ...anchor };
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

  /** 流式：视口顶部最近章节索引（共享 nearestVisibleSlot，与 PDF/CBZ 同一槽位判定）。 */
  const chapterFromScroll = (): number => {
    const chapters = scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    if (chapters.length === 0) {
      return 0;
    }
    const scroller = flowScrollContainer();
    const hostTop = scroller.getBoundingClientRect().top;
    const slotTops = Array.from(chapters, (chapter) => chapter.getBoundingClientRect().top);
    return Math.max(0, nearestVisibleSlot(slotTops, hostTop));
  };

  const firstVisibleChapter = (): number => {
    if (flowIsPaginated()) {
      const active = scrollHost.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
      const index = Number(active?.dataset.chapterIndex ?? 0);
      return Number.isSafeInteger(index) ? index : 0;
    }
    return chapterFromScroll();
  };

  const syncFlowState = (): void => {
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const total = scrollHost.querySelectorAll('.lightink-reader-chapter').length;
    if (total === 0) {
      updateReaderState({ current: 0, total: 0, progress: 0, scale: 1, locationKind: null });
      return;
    }
    const current = Math.min(total, firstVisibleChapter() + 1);
    let progress = 1;
    if (flowIsPaginated()) {
      const doc = visibleFlowFrame()?.contentDocument;
      const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
      if (scroller !== null) {
        const chapterRatio = total === 0 ? 0 : (current - 1) / total;
        const pageRatio = pagedProgressRatio(scroller) / Math.max(1, total);
        progress = Math.min(1, chapterRatio + pageRatio);
      } else {
        progress = total === 0 ? 0 : current / total;
      }
    } else {
      const scroller = flowScrollContainer();
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      progress = maxScroll === 0 ? 1 : Math.min(1, Math.max(0, scroller.scrollTop / maxScroll));
    }
    updateReaderState({ current, total, progress, scale: 1, locationKind: 'chapter' });
  };

  const syncPageState = (): void => {
    const current = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
    const total = pdfHandle?.controller.totalPages ?? cbzHandle?.totalPages ?? 0;
    const scale = pdfHandle?.controller.scale ?? 1;
    updateReaderState({
      current,
      total,
      progress: total === 0 ? 0 : Math.min(1, Math.max(0, current / total)),
      scale,
      locationKind: total === 0 ? null : 'page',
      comicMetadata: cbzHandle?.metadata,
    });
  };

  const onFlowScroll = (): void => {
    syncFlowState();
    rememberFlowProgress();
    schedulePersistReadingProgress();
    readerChrome?.syncStayRevealed();
    syncChromeRevealAttr();
    pinSidebarOverlay();
    // 工具栏按视口坐标固定定位，滚动后指向失效——直接隐藏。
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  const onPageScroll = (): void => {
    syncPageState();
    schedulePersistReadingProgress();
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  // 三格式 scroll 统一经 rAF 合并：同帧连发的滚动事件只在帧回调里同步一次
  // 章节/页指示与进度（缺 rAF 环境退化为直调，行为不变）。
  const scrollFrames = rafFrameScheduler();
  const flowScrollCoordinator =
    scrollFrames === null ? null : createCoalescedScrollHandler(onFlowScroll, scrollFrames);
  const pageScrollCoordinator =
    scrollFrames === null ? null : createCoalescedScrollHandler(onPageScroll, scrollFrames);
  const scheduleFlowScroll = (): void => {
    if (flowScrollCoordinator === null) {
      onFlowScroll();
      return;
    }
    flowScrollCoordinator.schedule();
  };
  const schedulePageScroll = (): void => {
    if (pageScrollCoordinator === null) {
      onPageScroll();
      return;
    }
    pageScrollCoordinator.schedule();
  };
  scrollHost.addEventListener('scroll', scheduleFlowScroll, { passive: true });
  const paneScroller = closestPane();
  paneScroller?.addEventListener('scroll', scheduleFlowScroll, { passive: true });
  // 分页滚轮提到窗口级（main.ts，与 Markdown R1 同源）：大纲/chrome/空白区
  // 悬停也翻正文。章节 iframe 内事件到不了宿主，仍由 flow-renderer 转发。

  /** 追加标注并同步正文高亮/侧栏/持久化。 */
  const appendAnnotation = (
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
    color?: AnnotationColor,
  ): void => {
    annotations = [
      ...annotations,
      {
        id: newAnnotationId(),
        kind,
        locator,
        quote,
        note,
        createdAt: Date.now(),
        color,
      },
    ];
    renderHighlights();
    renderSidebarAnnotations();
    void saveAnnotations();
  };

  /** 添加书签或笔记（笔记经多行弹层输入，取消不创建）。 */
  const addAnnotation = (kind: AnnotationKind): void => {
    if (kind === 'note') {
      void (async () => {
        const generation = loadGeneration;
        const input = await showNoteDialog(document, '', { t });
        if (input === null) {
          return;
        }
        if (destroyed || generation !== loadGeneration) {
          return; // 弹层期间已切换文档/销毁：丢弃迟到保存
        }
        appendAnnotation('note', currentPositionLocator(), undefined, input);
      })();
      return;
    }
    appendAnnotation(kind, currentPositionLocator(), undefined, undefined);
  };

  function ensureSidebar(): void {
    if (sidebar !== null) {
      return;
    }
    sidebarBackdrop = document.createElement('button');
    sidebarBackdrop.type = 'button';
    sidebarBackdrop.className = 'lightink-reader-sidebar-backdrop';
    sidebarBackdrop.tabIndex = -1;
    sidebarBackdrop.setAttribute('aria-hidden', 'true');
    sidebarBackdrop.hidden = !sidebarVisible;
    sidebarBackdrop.addEventListener('click', () => setSidebarVisible(false));
    sidebar = createAnnotationSidebar({
      t,
      onClose: () => setSidebarVisible(false),
      search: {
        onQuery: (nextQuery) => {
          if (nextQuery.trim() === '') {
            clearSearchSession();
            sidebar?.render(annotations);
            return;
          }
          runReaderSearch(nextQuery);
        },
        onJump: (key) => jumpToSearchKey(key),
        onNext: () => jumpReaderMatch(1),
        onPrev: () => jumpReaderMatch(-1),
        onClear: () => {
          clearSearchSession();
          sidebar?.render(annotations);
        },
      },
      onJump: (annotation) => {
        const loc = annotation.locator;
        if (loc.format === 'pdf' && pdfHandle !== null) {
          pdfHandle.scrollToPage(loc.page);
          syncPageState();
          pageHost
            .querySelector<HTMLElement>(
              `[data-annotation-id="${cssEscape(annotation.id)}"]`,
            )
            ?.scrollIntoView({ block: 'center' });
          return;
        }
        if (loc.format === 'cbz') {
          cbzHandle?.scrollToPage(loc.page);
          syncPageState();
          return;
        }
        // flow / text：优先定位到该条高亮的 <mark>，否则到章节。
        const chapter =
          loc.format === 'flow' ? loc.chapter : loc.format === 'text' ? 0 : firstVisibleChapter();
        if (flowIsPaginated()) {
          setActiveChapter(chapter);
        }
        const mark = Array.from(
          scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
        )
          .map((frame) =>
            frame.contentDocument?.querySelector<HTMLElement>(
              `[data-annotation-id="${cssEscape(annotation.id)}"]`,
            ) ?? null,
          )
          .find((candidate): candidate is HTMLElement => candidate !== null);
        if (mark !== undefined) {
          mark.scrollIntoView({ block: 'center' });
          return;
        }
        if (loc.format === 'flow' || loc.format === 'text') {
          const frame = scrollHost.querySelector<HTMLIFrameElement>(
            `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
          );
          const range =
            frame?.contentDocument === null || frame?.contentDocument === undefined
              ? null
              : resolveTextQuoteRange(frame.contentDocument.body, loc);
          const boundary = range?.startContainer;
          const target =
            boundary?.nodeType === Node.ELEMENT_NODE
              ? (boundary as Element)
              : boundary?.parentElement;
          if (target !== undefined && target !== null) {
            target.scrollIntoView({ block: 'center' });
            return;
          }
        }
        scrollHost
          .querySelector<HTMLElement>(`[data-chapter-index="${chapter}"]`)
          ?.scrollIntoView({ block: 'center' });
      },
      onRemove: (annotation) => {
        removeAnnotationById(annotation.id);
      },
      onEditNote: (annotation) => {
        openNote(annotation);
      },
    });
    sidebar.element.setAttribute('aria-hidden', sidebarVisible ? 'false' : 'true');
    sidebar.element.hidden = !tabActive || !sidebarVisible;
    root.append(sidebarBackdrop, sidebar.element);
    renderSidebarAnnotations();
  }

  function renderSidebarAnnotations(): void {
    if ((sidebar?.getSearchQuery() ?? '').trim() !== '') {
      return;
    }
    sidebar?.render(annotations);
  }

  const pinSidebarOverlay = (): void => {
    if (sidebar === null || sidebar.element.hidden) {
      return;
    }
    if (flowIsPaginated()) {
      unpinFixedOverlay(sidebar.element);
      return;
    }
    pinFixedOverlay(sidebar.element, closestPane() ?? root);
  };

  /** 侧栏覆盖层（含 portal 到共享 chrome 的部分）与当前显隐状态同步。 */
  function syncSidebarOverlayDom(): void {
    const shown = sidebarVisible && tabActive;
    root.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    // chromeHost（#lightink-main）是所有标签共享的，只在侧栏真正显示时占类。
    chromeHost().classList.toggle('lightink-reader--sidebar', shown);
    closestPane()?.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    sidebar?.element.setAttribute('aria-hidden', shown ? 'false' : 'true');
    if (sidebar !== null) {
      sidebar.element.hidden = !shown;
    }
    if (sidebarBackdrop !== null) {
      sidebarBackdrop.hidden = !shown;
    }
    pinSidebarOverlay();
  }

  /** 切换侧栏显隐，并让窄窗 drawer 获得或释放键盘焦点。 */
  function setSidebarVisible(visible: boolean): void {
    if (!visible && sidebarVisible) {
      closePdfSearch();
    }
    sidebarVisible = visible;
    if (visible) {
      ensureSidebar();
    }
    syncSidebarOverlayDom();
    if (
      sidebarVisible &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 700px)').matches
    ) {
      sidebar?.element
        .querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')
        ?.focus();
    }
    if (
      !sidebarVisible &&
      sidebar !== null &&
      sidebar.element.contains(document.activeElement)
    ) {
      root.focus();
    }
    syncVisibleFlowFrames();
  }

  const syncChromeRevealAttr = (): void => {
    if (readerChrome === null) {
      return;
    }
    const shown = readerChrome.isRevealed();
    readerChrome.element.hidden = !shown;
    readerChrome.element.setAttribute('aria-hidden', shown ? 'false' : 'true');
  };

  const syncChromeActionState = (): void => {
    if (typeof root.querySelector !== 'function') {
      return;
    }
    for (const action of ['toc', 'typography'] as const) {
      const button = root.querySelector<HTMLButtonElement>(
        `[data-reader-chrome-action="${action}"]`,
      );
      if (button === null) {
        continue;
      }
      const open = chromePanel === action;
      button.classList.toggle('is-open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  };

  const closeChromePanel = (): boolean => {
    if (chromePanel === null) {
      return false;
    }
    chromePanel = null;
    tocPanel.hidden = true;
    typePanel.hidden = true;
    syncChromeActionState();
    return true;
  };

  const dismissReaderOverlayStep = (): boolean => {
    if (readerChrome !== null) {
      const closed = readerChrome.handleEscape();
      syncChromeRevealAttr();
      return closed;
    }
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
      return true;
    }
    if (sidebarVisible) {
      setSidebarVisible(false);
      return true;
    }
    return closeChromePanel();
  };

  /**
   * 标签可见性变化（切换标签时由宿主调用）。侧栏挂在阅读根上，仍要显式同步
   * hidden，避免切标签后操作非活动文档。sidebarVisible 只记用户偏好，切回时恢复。
   */
  function setTabActive(active: boolean): void {
    if (tabActive === active) {
      return;
    }
    tabActive = active;
    syncSidebarOverlayDom();
    if (!active) {
      hideSelectionToolbar();
      closeChromePanel();
      readerChrome?.dismiss();
      syncChromeRevealAttr();
    }
  }

  const flowDocuments = (): Document[] =>
    Array.from(
      scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    )
      .map((frame) => frame.contentDocument)
      .filter((doc): doc is Document => doc !== null && doc.body !== null);

  /** PDF 文本层标注：按页分组后经共享幂等引擎渲染（层未就绪则该页跳过，观察器重试）。 */
  const renderPdfHighlights = (): void => {
    const byPage = new Map<number, AnnotationMarkSpec[]>();
    for (const hl of annotations) {
      if (hl.kind !== 'highlight' && hl.kind !== 'note') {
        continue;
      }
      const locator = hl.locator;
      if (locator.format !== 'pdf' || locator.anchor === undefined) {
        continue;
      }
      const spec: AnnotationMarkSpec = annotationMarkSpec(hl, locator.anchor);
      const list = byPage.get(locator.page);
      if (list === undefined) {
        byPage.set(locator.page, [spec]);
      } else {
        list.push(spec);
      }
    }
    for (const [page, specs] of byPage) {
      const slot = pageHost.querySelector<HTMLElement>(
        `.lightink-reader-page-slot[data-page-index="${page - 1}"]`,
      );
      const layer = slot?.querySelector<HTMLElement>('.lightink-reader-text-layer') ?? null;
      if (layer === null) {
        continue; // 该页文本层尚未懒渲染，观察器会在层出现时重试
      }
      renderAnnotationMarks(layer, specs);
    }
  };

  /** 文本层懒出现/异步 span 填充/缩放重建后重渲染 PDF 高亮（MutationObserver 驱动）。 */
  let textLayerObserver: MutationObserver | null = null;
  const observeTextLayers = (host: HTMLElement): void => {
    textLayerObserver?.disconnect();
    textLayerObserver = null;
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    let renderQueued = false;
    textLayerObserver = new MutationObserver((records) => {
      if (!isTextLayerMutation(records) || renderQueued) {
        return;
      }
      // pdfjs 逐 span 追加会连发多批记录；合并到微任务末尾渲染一次（幂等防重复）。
      renderQueued = true;
      queueMicrotask(() => {
        renderQueued = false;
        renderPdfHighlights();
        renderPdfSearchMarks(); // 层重建后搜索命中 overlay 一并恢复
      });
    });
    textLayerObserver.observe(host, { childList: true, subtree: true });
  };

  /** PDF 文本层选区（主文档 DOM，无 iframe 偏移）：捕获文字级定位并唤起工具栏。 */
  const onPageHostSelection = (): void => {
    if (pdfHandle === null) {
      return;
    }
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      hideSelectionToolbar();
      return;
    }
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    const layer = container?.closest('.lightink-reader-text-layer') ?? null;
    if (layer === null) {
      // 非文本层选区（canvas/跨页拖选）不处理，但清掉可能滞留的工具栏与过期选区。
      hideSelectionToolbar();
      return;
    }
    const slot = layer.closest<HTMLElement>('.lightink-reader-page-slot');
    const pageIndex = Number(slot?.dataset.pageIndex ?? -1);
    if (!(pageIndex >= 0)) {
      return;
    }
    const locator = pdfTextLocatorFromRange(layer, range, pageIndex + 1);
    if (locator === null) {
      hideSelectionToolbar();
      return;
    }
    const anchorElement =
      selection.anchorNode === null
        ? null
        : selection.anchorNode.nodeType === 1
          ? (selection.anchorNode as Element)
          : selection.anchorNode.parentElement;
    const existingMark = anchorElement?.closest('[data-annotation-id]') ?? null;
    pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame: null,
    };
    ensureSelectionToolbar();
    selectionToolbar?.showAt(range.getBoundingClientRect(), {
      canRemoveHighlight: existingMark !== null,
    });
  };

  const onPageHostNoteClick = (event: MouseEvent): void => {
    const annotation = annotationFromMark(event.target);
    if (annotation !== null && annotation.kind === 'note') {
      event.preventDefault();
      event.stopPropagation();
      openNote(annotation);
    }
    // Page-host clicks bubble once to root; createReaderChrome owns reveal/dismiss.
    // Iframe clicks never bubble, so handleNoteMarkClick still forwards those.
  };

  /**
   * Flow chapter Escape stays in-frame. Overlay dismiss is already handled by
   * flow-renderer; leftover Escape is forwarded to the parent document so the
   * window-level 合书 listener can returnToShelf.
   */
  const flowFrameEscapeDocs = new WeakSet<Document>();
  const bindFlowFrameLeftoverEscape = (): void => {
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame',
    )) {
      const frameDocument = frame.contentDocument;
      if (frameDocument === null || flowFrameEscapeDocs.has(frameDocument)) {
        continue;
      }
      flowFrameEscapeDocs.add(frameDocument);
      frameDocument.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || destroyed) {
          return;
        }
        const parentWindow = frameDocument.defaultView?.parent;
        const parentDoc = parentWindow?.document;
        if (parentDoc === undefined || parentDoc === frameDocument) {
          return;
        }
        event.preventDefault();
        parentDoc.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
  };

  /** 关闭可能打开中的笔记弹层（切换/销毁时经 Escape 走正规 release，恢复背景 inert）。 */
  const closeOpenNoteDialog = (): void => {
    if (
      typeof document !== 'undefined' &&
      typeof document.querySelector === 'function' &&
      document.querySelector('.lightink-note-dialog') !== null &&
      typeof KeyboardEvent !== 'undefined'
    ) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    }
  };

  /** 清掉全部搜索命中 overlay（PDF 文本层与流式正文，span 解包保留文本）。 */
  const clearReaderSearchMarks = (): void => {
    for (const layer of pageHost.querySelectorAll('.lightink-reader-text-layer')) {
      clearSearchMarks(layer);
    }
    for (const doc of flowDocuments()) {
      clearSearchMarks(doc.body);
    }
  };

  /**
   * 在当前已渲染文本层上叠加搜索命中 overlay：按页分组交给共享幂等引擎
   * （已有 key 戳记只校正类名不重包裹，防 observer 自激循环；层文本未填充到
   * 命中末尾时跳过，等后续批次重试）。
   * 激活滚动经 pendingScrollKey：命中首次就绪（含远页文本层异步出现）时滚动一次，
   * observer 驱动的重渲染不回吸视口。
   */
  const renderPdfSearchMarks = (): void => {
    const state = pdfSearch;
    if (state === null) {
      return;
    }
    const layerFor = (page: number): HTMLElement | null =>
      pageHost.querySelector<HTMLElement>(
        `.lightink-reader-page-slot[data-page-index="${page - 1}"] .lightink-reader-text-layer`,
      );
    const current = state.matches[state.active];
    const currentKey =
      current === undefined ? null : `${current.page}:${current.start}:${current.end}`;
    const byPage = new Map<number, SearchMarkSpec[]>();
    for (const match of state.matches) {
      const spec: SearchMarkSpec = {
        key: `${match.page}:${match.start}:${match.end}`,
        start: match.start,
        end: match.end,
      };
      const list = byPage.get(match.page);
      if (list === undefined) {
        byPage.set(match.page, [spec]);
      } else {
        list.push(spec);
      }
    }
    for (const [page, specs] of byPage) {
      const layer = layerFor(page);
      if (layer === null) {
        continue; // 未懒渲染的页跳过；层出现时经 observer 重渲染
      }
      renderSearchMarks(layer, specs, currentKey);
    }
    // 激活滚动：该命中即 pending 目标且当前命中 overlay 已就绪时，滚动一次即清除。
    if (current !== undefined && pendingSearchScrollKey === currentKey) {
      const activeMark =
        layerFor(current.page)?.querySelector<HTMLElement>(`.${SEARCH_MARK_CURRENT_CLASS}`) ??
        null;
      if (activeMark !== null) {
        pendingSearchScrollKey = null;
        activeMark.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  /** 执行搜索（去抖 200ms：快速输入时不叠加全文档扫描）：命中后跳到首个并渲染 overlay。 */
  const runPdfSearch = (query: string): void => {
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    // 入口即换代：等待去抖窗口内的旧 in-flight 结果与未 fire 的旧定时器同代失效。
    const generation = ++searchGeneration;
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
    }
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void (async () => {
        const matches = await handle.search(query);
        if (destroyed || generation !== searchGeneration || handle !== pdfHandle) {
          return; // 迟到结果（新查询/切换文档）丢弃
        }
        clearReaderSearchMarks();
        const currentPage = handle.controller.page;
        const firstAtOrAfter = matches.findIndex((match) => match.page >= currentPage);
        const active = nearestMatchIndex(matches.length, firstAtOrAfter);
        pdfSearch = { query, matches, active };
        renderPdfSearchMarks();
        syncSearchHits();
        // Opening Find or typing a query should not yank the reader back to page 1.
      })();
    }, 200);
  };

  /** 跳到指定命中（环形步进在面板回调中计算）。 */
  const jumpToPdfMatch = (target: number): void => {
    const state = pdfSearch;
    if (state === null || pdfHandle === null) {
      return;
    }
    const index = nextMatchIndex(state.matches.length, state.active, target >= 0 ? 1 : -1);
    if (index < 0) {
      return;
    }
    state.active = index;
    const match = state.matches[index]!;
    pendingSearchScrollKey = `${match.page}:${match.start}:${match.end}`;
    pdfHandle.scrollToPage(match.page);
    syncPageState();
    renderPdfSearchMarks();
    syncSearchHits();
  };

  const activatePdfMatchAt = (index: number): void => {
    const state = pdfSearch;
    if (state === null || pdfHandle === null || index < 0 || index >= state.matches.length) {
      return;
    }
    state.active = index;
    const match = state.matches[index]!;
    pendingSearchScrollKey = `${match.page}:${match.start}:${match.end}`;
    pdfHandle.scrollToPage(match.page);
    syncPageState();
    renderPdfSearchMarks();
    syncSearchHits();
  };

  const clearSearchSession = (): void => {
    searchGeneration += 1;
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    pendingSearchScrollKey = null;
    pdfSearch = null;
    clearReaderSearchMarks();
    flowSearch = null;
  };

  const closePdfSearch = (): void => {
    clearSearchSession();
    sidebar?.setSearchQuery('');
    sidebar?.render(annotations);
  };

  /**
   * 流式命中 overlay 渲染：各章 body 交给共享幂等引擎（含无命中章的陈旧 key
   * 清理），currentKey 决定当前命中类名（幂等重放只校正类名，不重包裹）。
   */
  const renderFlowSearchMarks = (
    byChapter: ReadonlyMap<number, SearchMarkSpec[]>,
    currentKey: string | null,
  ): void => {
    flowDocuments().forEach((doc, chapter) => {
      renderSearchMarks(doc.body, byChapter.get(chapter) ?? [], currentKey);
    });
  };

  const runFlowSearch = (query: string, options?: { preserveActive?: number }): void => {
    const trimmed = query.trim();
    if (trimmed === '' || PAGE_EXTS.has(loadedExt)) {
      flowSearch = null;
      for (const doc of flowDocuments()) {
        clearSearchMarks(doc.body);
      }
      syncSearchHits();
      return;
    }
    const byChapter = new Map<number, SearchMarkSpec[]>();
    flowDocuments().forEach((doc, chapter) => {
      const hits = findTextHits(doc.body.textContent ?? '', trimmed);
      if (hits.length === 0) {
        return;
      }
      byChapter.set(
        chapter,
        hits.map((hit, ordinal) => ({
          key: flowSearchMarkKey(chapter, ordinal, hit.start, hit.end),
          start: hit.start,
          end: hit.end,
        })),
      );
    });
    renderFlowSearchMarks(byChapter, null);
    const marks: HTMLElement[] = [];
    flowDocuments().forEach((doc, chapter) => {
      for (const spec of byChapter.get(chapter) ?? []) {
        const mark = doc.body.querySelector<HTMLElement>(
          `[data-search-key="${cssEscape(spec.key)}"]`,
        );
        if (mark !== null) {
          marks.push(mark);
        }
      }
    });
    const scroller = flowScrollContainer();
    const scrollerTop = scroller.getBoundingClientRect().top;
    const firstAtOrAfter = marks.findIndex((mark) => mark.getBoundingClientRect().top >= scrollerTop - 8);
    const fallback = nearestMatchIndex(marks.length, firstAtOrAfter);
    const active = preserveMatchIndex(marks.length, options?.preserveActive ?? -1, fallback);
    const currentKey = active >= 0 ? marks[active]?.dataset.searchKey ?? null : null;
    if (currentKey !== null) {
      renderFlowSearchMarks(byChapter, currentKey); // 幂等：仅校正当前类名
    }
    flowSearch = { query: trimmed, byChapter, marks, active };
    syncSearchHits();
  };

  const revealFlowMark = (mark: HTMLElement | undefined): void => {
    if (mark === undefined) {
      return;
    }
    const article = mark.ownerDocument?.defaultView?.frameElement?.closest<HTMLElement>(
      '.lightink-reader-chapter',
    );
    const chapter = Number(article?.dataset.chapterIndex ?? Number.NaN);
    const paginated = flowIsPaginated();
    if (paginated && Number.isSafeInteger(chapter)) {
      setActiveChapter(chapter);
      const frame = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const frameDocument = frame?.contentDocument;
      if (frame !== undefined && frame !== null && frameDocument !== undefined && frameDocument !== null) {
        applyPaginatedDocument(frame, frameDocument, { snap: false });
        const scroller = readerPagedScroller(frameDocument);
        const step = pagedFrameStep(scroller);
        const left =
          mark.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
        scroller.scrollLeft = Math.max(0, Math.floor(left / step) * step);
        snapPagedScroller(scroller, step);
        return;
      }
    }
    mark.scrollIntoView({ block: 'center', inline: 'nearest' });
  };

  const jumpToFlowMatch = (direction: 1 | -1): void => {
    const state = flowSearch;
    if (state === null || state.marks.length === 0) {
      return;
    }
    const index = nextMatchIndex(state.marks.length, state.active, direction);
    if (index < 0) {
      return;
    }
    state.active = index;
    const currentKey = state.marks[index]?.dataset.searchKey ?? null;
    if (currentKey !== null) {
      // 共享引擎幂等重放：仅校正当前命中类名，不重包裹。
      renderFlowSearchMarks(state.byChapter, currentKey);
    }
    revealFlowMark(state.marks[index]);
    syncSearchHits();
  };

  const activateFlowMatchAt = (index: number): void => {
    const state = flowSearch;
    if (state === null || index < 0 || index >= state.marks.length) {
      return;
    }
    state.active = index;
    const currentKey = state.marks[index]?.dataset.searchKey ?? null;
    if (currentKey !== null) {
      renderFlowSearchMarks(state.byChapter, currentKey);
    }
    revealFlowMark(state.marks[index]);
    syncSearchHits();
  };

  const pdfMatchKey = (match: PdfSearchMatch): string =>
    `${match.page}:${match.start}:${match.end}`;

  const syncSearchHits = (): void => {
    if (sidebar === null) {
      return;
    }
    const query = sidebar.getSearchQuery().trim();
    if (query === '') {
      sidebar.render(annotations);
      return;
    }
    const hits: SearchHitView[] = [];
    if (pdfSearch !== null) {
      for (const [index, match] of pdfSearch.matches.entries()) {
        hits.push({
          key: pdfMatchKey(match),
          snippet: match.snippet,
          location: t('annotation.location.page', { page: String(match.page) }),
          current: index === pdfSearch.active,
        });
      }
    } else if (flowSearch !== null) {
      flowDocuments().forEach((doc, chapter) => {
        const text = doc.body.textContent ?? '';
        for (const spec of flowSearch?.byChapter.get(chapter) ?? []) {
          const markIndex = flowSearch!.marks.findIndex(
            (mark) => mark.dataset.searchKey === spec.key,
          );
          hits.push({
            key: spec.key,
            snippet: snippetAround(text, spec.start, spec.end),
            location: t('reader.chapter', { n: String(chapter + 1) }),
            current: markIndex === flowSearch!.active,
          });
        }
      });
    }
    sidebar.renderHits(hits);
  };

  const jumpToSearchKey = (key: string): void => {
    if (pdfSearch !== null) {
      activatePdfMatchAt(pdfSearch.matches.findIndex((match) => pdfMatchKey(match) === key));
      return;
    }
    if (flowSearch !== null) {
      activateFlowMatchAt(
        flowSearch.marks.findIndex((mark) => mark.dataset.searchKey === key),
      );
    }
  };

  const runReaderSearch = (query: string): void => {
    if (pdfHandle !== null) {
      runPdfSearch(query);
      return;
    }
    runFlowSearch(query);
  };

  const jumpReaderMatch = (direction: 1 | -1): void => {
    if (pdfHandle !== null) {
      jumpToPdfMatch(direction);
      return;
    }
    jumpToFlowMatch(direction);
  };

  const currentSearchSelection = (): string => {
    if (pendingSelection !== null) {
      const seeded = sanitizeSearchQuery(pendingSelection.quote);
      if (seeded !== '') {
        return seeded;
      }
    }
    for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
      '.lightink-reader-chapter-frame',
    )) {
      const seeded = sanitizeSearchQuery(frame.contentWindow?.getSelection()?.toString() ?? '');
      if (seeded !== '') {
        return seeded;
      }
    }
    return sanitizeSearchQuery(typeof window !== 'undefined' ? window.getSelection()?.toString() : '');
  };

  /** 打开标注弹出框并聚焦搜索（PDF / 流式；CBZ 无文本则空结果）。 */
  const openSearch = (query?: string): void => {
    const scroller = flowScrollContainer();
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    setSidebarVisible(true);
    const seed = sanitizeSearchQuery(query) || currentSearchSelection();
    if (seed !== '') {
      sidebar?.setSearchQuery(seed);
      runReaderSearch(seed);
    } else if ((sidebar?.getSearchQuery() ?? '').trim() === '') {
      sidebar?.render(annotations);
    } else {
      syncSearchHits();
    }
    sidebar?.focusSearch();
    scroller.scrollLeft = left;
    scroller.scrollTop = top;
  };

  /** 在 sandbox 正文文本节点中包裹高亮 quote（flow/txt，共享幂等引擎）；PDF 走文本层渲染。 */
  const renderHighlights = (): void => {
    if (loadedExt === 'pdf') {
      renderPdfHighlights();
      return;
    }
    if (PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const byChapter = new Map<number, AnnotationMarkSpec[]>();
    for (const hl of annotations) {
      if ((hl.kind !== 'highlight' && hl.kind !== 'note') || hl.quote === undefined) {
        continue;
      }
      const locator = hl.locator;
      if (locator.format !== 'flow' && locator.format !== 'text') {
        continue;
      }
      const chapter = locator.format === 'flow' ? locator.chapter : 0;
      const spec: AnnotationMarkSpec = annotationMarkSpec(hl, locator);
      const list = byChapter.get(chapter);
      if (list === undefined) {
        byChapter.set(chapter, [spec]);
      } else {
        list.push(spec);
      }
    }
    for (const [chapter, specs] of byChapter) {
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
      );
      const doc = frame?.contentDocument;
      if (doc === null || doc === undefined) {
        continue;
      }
      renderAnnotationMarks(doc.body, specs);
    }
  };

  /**
   * 划选 mouseup（flow/txt，iframe 内）：捕获待确认划选并唤起工具栏（R3）。
   * 不再直接建标注——高亮/笔记经工具栏确认，取消高亮在选中已有 mark 时可用。
   */
  const onFlowSelectionMouseUp = (
    selection: Selection | null,
    chapter: number,
    body: HTMLElement,
    frame: HTMLIFrameElement,
  ): void => {
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      hideSelectionToolbar();
      return;
    }
    const locator = flowLocatorFromRange(
      body,
      selection.getRangeAt(0),
      chapter,
      loadedExt === 'txt' ? 'text' : 'flow',
    );
    if (locator === null) {
      hideSelectionToolbar();
      return;
    }
    // 选区锚点落在已有高亮 <mark data-annotation-id> 内时提供"取消高亮"。
    const anchorNode = selection.anchorNode;
    const anchorElement =
      anchorNode === null
        ? null
        : anchorNode.nodeType === 1
          ? (anchorNode as Element)
          : anchorNode.parentElement;
    const existingMark = anchorElement?.closest('[data-annotation-id]') ?? null;
    pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame,
    };
    ensureSelectionToolbar();
    if (selectionToolbar === null) {
      return;
    }
    // iframe 内 rect 是 frame 视口坐标，叠加 frame 偏移换算为外层 client 坐标。
    const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    selectionToolbar.showAt(
      {
        left: rangeRect.left + frameRect.left,
        top: rangeRect.top + frameRect.top,
        width: rangeRect.width,
        height: rangeRect.height,
      },
      { canRemoveHighlight: existingMark !== null },
    );
  };

  const jumpToOutlineItem = (item: OutlineItem): void => {
    if (item.page !== undefined) {
      if (pdfHandle !== null) {
        pdfHandle.scrollToPage(item.page);
        syncPageState();
        schedulePersistReadingProgress();
        return;
      }
      if (cbzHandle !== null) {
        cbzHandle.scrollToPage(item.page);
        syncPageState();
        schedulePersistReadingProgress();
      }
      return;
    }
    if (item.chapter !== undefined) {
      if (flowIsPaginated()) {
        setActiveChapter(item.chapter);
        const frame = scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${item.chapter}"] .lightink-reader-chapter-frame`,
        );
        const doc = frame?.contentDocument;
        if (doc !== undefined && doc !== null) {
          readerPagedScroller(doc).scrollLeft = 0;
        }
      } else {
        scrollHost
          .querySelector<HTMLElement>(`.lightink-reader-chapter[data-chapter-index="${item.chapter}"]`)
          ?.scrollIntoView({ block: 'start' });
      }
      syncFlowState();
      schedulePersistReadingProgress();
    }
  };

  /**
   * 流式渲染入口（T5 拆分）：页宿主接线拆除后委托 flow-renderer 创建章节
   * iframe 与帧内生命周期；编排壳只保留宿主切换、活动章与状态同步。
   */
  const renderChapters = (chapters: ReaderChapter[], stylesheet = ''): void => {
    pageHost.removeEventListener('scroll', schedulePageScroll);
    // R7：页格式时 commitStagedPages 在共享 pane 上挂了 schedulePageScroll，
    // 同标签 PDF→流式切换必须一并摘除——否则滚动 pane 仍触发 onPageScroll→
    // syncPageState，把流式阅读状态（章节/进度）清零，且监听器随切换累积。
    closestPane()?.removeEventListener('scroll', schedulePageScroll);
    pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('click', onPageHostNoteClick);
    textLayerObserver?.disconnect();
    textLayerObserver = null;
    scrollHost.hidden = false;
    pageHost.hidden = true;
    delete pageHost.dataset.readerActive;
    // 页宿主滚动合并帧作废（T3 review 遗留：交换点与 destroy 对称 cancel）。
    pageScrollCoordinator?.cancel();
    // T6 review P3：新文档渲染前作废待 settle 的缩放刷新与推迟中的锚点恢复
    // （与 destroy 对称，防迟到刷新按新文档几何套旧档位）。
    cancelFontScaleRefresh?.();
    cancelFontScaleRefresh = null;
    stalePaginatedChapters = null; // 新文档：帧 load 时各自应用分栏，无待补章
    flowRenderer.render(chapters, stylesheet);
    setActiveChapter(0);
    syncFlowState();
  };

  const stagePages = async (
    filePath: string,
    source: Uint8Array | RandomAccessSource | null,
    signal: AbortSignal,
    target: ReaderTarget,
  ): Promise<{
    host: HTMLDivElement;
    pdf: PdfRenderHandle | null;
    cbz: CbzRenderHandle | null;
  }> => {
    const ext = extOfPath(filePath);
    if (ext !== 'pdf' && ext !== 'cbz' && !NATIVE_ARCHIVE_EXTENSIONS.has(ext)) {
      throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
    }
    const stagedHost = createPageHost();
    stagedHost.hidden = false;
    stagedHost.dataset.readerActive = 'true';
    if (ext === 'pdf') {
      if (source === null) throw new ParseError('PDF 字节源不可用');
      stagedHost.dataset.readerFormat = 'pdf';
      const pdf = await renderPdfInto(source, stagedHost, signal);
      return { host: stagedHost, pdf, cbz: null };
    }
    stagedHost.dataset.readerFormat = ext;
    const archiveSource = NATIVE_ARCHIVE_EXTENSIONS.has(ext)
      ? await (deps.openArchiveProvider?.(target, signal) ??
        openNativeArchive(target, {
          signal,
          requestPassword: deps.requestArchivePassword,
        }))
      : source;
    if (archiveSource === null) throw new ParseError('漫画归档字节源不可用');
    const cbz = await renderCbzInto(archiveSource, stagedHost, signal, {
      preferenceStorage,
      requestPassword: deps.requestArchivePassword,
      labels: {
        previous: t('reader.comic.previous'),
        next: t('reader.comic.next'),
        vertical: t('reader.comic.vertical'),
        paged: t('reader.comic.paged'),
        leftToRight: t('reader.comic.ltr'),
        rightToLeft: t('reader.comic.rtl'),
        singlePage: t('reader.comic.single'),
        doublePage: t('reader.comic.double'),
        fitWidth: t('reader.comic.fitWidth'),
        imageDecodeFailed: t('reader.comic.imageDecodeFailed'),
        retry: t('reader.comic.retry'),
      },
      onPageChange: () => {
        if (cbzHandle !== null) {
          syncPageState();
          schedulePersistReadingProgress();
        }
      },
      onPageListChange: (totalPages, metadata) => {
        readerOutline = outlineFromEntries(
          Array.from({ length: totalPages }, (_, index) => ({
            title: t('annotation.location.page', { page: String(index + 1) }),
          })),
          'page',
        );
        if (cbzHandle !== null) syncPageState();
        void Promise.resolve(deps.onComicMetadata?.(target, metadata)).catch(() => undefined);
      },
      onArchiveProgress: (progress) => {
        if (progress.phase === 'sequential' && progress.currentEntry < progress.targetEntry) {
          status.hidden = false;
          status.textContent = t('reader.archive.sequentialProgress', {
            current: String(progress.currentEntry + 1),
            target: String(progress.targetEntry + 1),
          });
        } else if (readerState.phase === 'ready') {
          status.hidden = true;
        }
      },
    });
    void Promise.resolve(deps.onComicMetadata?.(target, cbz.metadata)).catch(() => undefined);
    return { host: stagedHost, pdf: null, cbz };
  };

  const commitStagedPages = (
    staged: {
      host: HTMLDivElement;
      pdf: PdfRenderHandle | null;
      cbz: CbzRenderHandle | null;
    },
  ): void => {
    clearFlowBindings();
    stalePaginatedChapters = null; // 切到页格式：流式惰性分栏标记随流式宿主一并作废
    const previousFlowDispose = flowContentDispose;
    flowContentDispose = null;
    const previousPdf = pdfHandle;
    const previousCbz = cbzHandle;
    pdfHandle = staged.pdf;
    cbzHandle = staged.cbz;
    pageHost.removeEventListener('scroll', schedulePageScroll);
    closestPane()?.removeEventListener('scroll', schedulePageScroll);
    pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('click', onPageHostNoteClick);
    // 交换 pageHost 时作废待执行的页滚动合并帧（与 destroy 对称，防迟到帧写旧状态）。
    pageScrollCoordinator?.cancel();
    // T6 review P3：切到页格式同样作废流式缩放的 pending settle（与 destroy 对称）。
    cancelFontScaleRefresh?.();
    cancelFontScaleRefresh = null;
    pageHost.replaceWith(staged.host);
    pageHost = staged.host;
    pageHost.addEventListener('scroll', schedulePageScroll, { passive: true });
    closestPane()?.addEventListener('scroll', schedulePageScroll, { passive: true });
    pageHost.addEventListener('mouseup', onPageHostSelection);
    pageHost.addEventListener('click', onPageHostNoteClick);
    observeTextLayers(pageHost); // 文本层懒出现时重渲染该页高亮
    scrollHost.hidden = true;
    syncPageState();
    void previousPdf?.destroy().catch(() => undefined);
    void previousCbz?.destroy().catch(() => undefined);
    previousFlowDispose?.();
  };

  const loadAnnotations = async (
    target: ReaderTarget,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      !annotationsEnabled ||
      (target.kind === 'local' && deps.getContentHash === undefined)
    ) {
      return;
    }
    try {
      const nextContentHash =
        target.kind === 'local'
          ? await deps.getContentHash!(target.path)
          : fnv1a64Hex(`remote:${readerIdentityKey(target.identity)}`);
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      const nextAnnotations = parseAnnotations(
        await deps.readAnnotations!(nextContentHash),
      );
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      contentHash = nextContentHash;
      annotations = nextAnnotations;
    } catch {
      if (destroyed || signal.aborted || generation !== loadGeneration) {
        return;
      }
      contentHash = null;
      annotations = [];
      deps.notify?.(t('annotation.loadFailed'));
      return;
    }
    renderHighlights(); // flow/txt 正文与 PDF 文本层（含旧 anchor 数据重渲染）
    ensureSidebar();
  };

  const gatePagedWheel = createPagedWheelGate();

  const advanceReading = (direction: 1 | -1): boolean => {
    if (pdfHandle !== null) {
      pdfHandle.scrollToPage(pdfHandle.controller.page + direction);
      syncPageState();
      schedulePersistReadingProgress();
      return true;
    }
    if (cbzHandle !== null) {
      if (direction > 0) cbzHandle.nextPage();
      else cbzHandle.previousPage();
      syncPageState();
      schedulePersistReadingProgress();
      return true;
    }
    const moved = advanceReadingContent(direction);
    if (moved) {
      hideSelectionToolbar();
    }
    return moved;
  };

  const advanceReadingContent = (direction: 1 | -1): boolean => {
    const paginated = flowIsPaginated();
    if (paginated) {
      const frame = visibleFlowFrame();
      const scroller =
        frame?.contentDocument === undefined || frame.contentDocument === null
          ? null
          : readerPagedScroller(frame.contentDocument);
      const step = scroller === null ? 0 : pagedFrameStep(scroller);
      if (
        scroller !== undefined &&
        scroller !== null &&
        advancePagedScroller(scroller, direction, step)
      ) {
        snapPagedScroller(scroller, step);
        scroller.scrollLeft = Math.round(scroller.scrollLeft / step) * step;
        schedulePersistReadingProgress();
        return true;
      }
      const chapter = firstVisibleChapter() + direction;
      const next = scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
      );
      if (next === null) {
        return false;
      }
      setActiveChapter(chapter);
      const nextFrame = next.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
      const applyChapterPage = (): void => {
        const nextDoc = nextFrame?.contentDocument;
        if (nextFrame === null || nextDoc === undefined || nextDoc === null) {
          return;
        }
        applyPaginatedDocument(nextFrame, nextDoc, { snap: false });
        const nextScroller = readerPagedScroller(nextDoc);
        nextScroller.scrollLeft =
          direction < 0 ? Math.max(0, nextScroller.scrollWidth - nextScroller.clientWidth) : 0;
      };
      applyChapterPage();
      requestAnimationFrame(applyChapterPage);
      syncFlowState();
      schedulePersistReadingProgress();
      return true;
    }
    if (advanceScrolledScroller(flowScrollContainer(), direction)) {
      schedulePersistReadingProgress();
      return true;
    }
    return false;
  };

  /**
   * T6 缩放性能：字号档位本身便宜（CSS 变量），贵在下游整章 column 重排。
   * 连续缩放（键盘连按 / Ctrl+滚轮在 wheel 层 80ms 节流之上）在消费侧合并
   * 去抖，收敛到 ~200ms settle 后一次性刷新（复用 createResizeSettle 模式）：
   * - 翻页模式：仅视口相交章立即重分栏，离屏章标记惰性（激活时补分栏）；
   * - 滚动模式：复用基座缩放锚点数学（viewportAnchor），缩放后视口锚点
   *   内容不漂移（锚点比率按设计不钳制，见 reading-layout）。
   * PDF 路径不动：pdf.ts 已是仅可见页栅格化 + 视口锚点的样板实现。
   */
  const FONT_SCALE_SETTLE_MS = 200;
  const settleFontScaleRefresh = createResizeSettle(FONT_SCALE_SETTLE_MS);
  /**
   * 双 rAF 后执行 task：滚动模式下 syncVisibleFrames 只改帧内字号，帧高由
   * flow-renderer 的 ResizeObserver→syncHeight 异步重写——settle 同步时刻读
   * 章节几何仍是旧高度，此时恢复锚点等于恒等式（视口漂移不被纠正）。第一帧
   * 后高度重同步落地，第二帧读到新几何再恢复。返回 cancel 与 destroy/
   * 重渲染/下一次缩放对称作废。
   */
  const afterVisibleHeightResync = (task: () => void): (() => void) => {
    let cancelled = false;
    let handle: number | null = null;
    const schedule = (next: () => void): void => {
      handle = requestAnimationFrame(() => {
        handle = null;
        if (!cancelled) {
          next();
        }
      });
    };
    schedule(() => schedule(task));
    return () => {
      cancelled = true;
      if (handle !== null) {
        cancelAnimationFrame(handle);
      }
    };
  };
  const applyFontScaleRefresh = (): void => {
    cancelFontScaleRefresh = null;
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    const paginated = flowIsPaginated();
    const scroller = flowScrollContainer();
    const chapters = Array.from(
      scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter'),
    );
    const anchor =
      paginated || chapters.length === 0
        ? null
        : viewportAnchor(
            scroller.getBoundingClientRect(),
            chapters.map((chapter) => chapter.getBoundingClientRect()),
            chapterFromScroll(),
          );
    if (paginated) {
      const stale = new Set<number>();
      for (const chapter of chapters) {
        stale.add(Number(chapter.dataset.chapterIndex));
      }
      for (const index of visibleChapterIndexes()) {
        stale.delete(index);
      }
      stalePaginatedChapters = stale;
    } else {
      stalePaginatedChapters = null;
    }
    syncVisibleFlowFrames();
    if (anchor !== null && chapters[anchor.index] !== undefined) {
      const anchored = chapters[anchor.index]!;
      cancelFontScaleRefresh = afterVisibleHeightResync(() => {
        cancelFontScaleRefresh = null;
        if (destroyed) {
          return;
        }
        // getBoundingClientRect 是视口绝对坐标，scrollToKeepViewportAnchor 期望
        // 相对 scroller 的坐标；不归一化会把应用 chrome（标签栏/侧栏）的偏移
        // 累加进新滚动位置，锚点随每次缩放漂移（与 pdf.ts rerender 同一数学）。
        const scrollerRect = scroller.getBoundingClientRect();
        const next = anchored.getBoundingClientRect();
        scroller.scrollTop = scrollToKeepViewportAnchor(
          scroller,
          {
            left: next.left - scrollerRect.left,
            top: next.top - scrollerRect.top,
            width: next.width,
            height: next.height,
          },
          anchor,
        ).scrollTop;
        syncFlowState();
        schedulePersistReadingProgress();
      });
    }
    syncFlowState();
    schedulePersistReadingProgress();
  };
  const onFontScaleChange = (): void => {
    if (destroyed) {
      return;
    }
    if (pdfHandle !== null) {
      void pdfHandle.rerender();
      return;
    }
    // 作废上一轮遗留（settle 定时器或推迟中的锚点恢复 rAF），防止迟到回调用
    // 旧锚点/旧档位中途抢跑。
    cancelFontScaleRefresh?.();
    cancelFontScaleRefresh = settleFontScaleRefresh(applyFontScaleRefresh);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:font-scale', onFontScaleChange);
  }

  // R4：主题切换（浅↔深）时重应用 flow 帧文字色，消除深底深字/浅底浅字不可读。
  // PDF/CBZ 为栅格/位图，宿主背景走 CSS 变量随主题更新，无需重渲染。
  const onThemeChange = (): void => {
    if (destroyed) {
      return;
    }
    flowRenderer.syncTheme();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:theme-change', onThemeChange);
  }

  const refreshOpenSearch = (): void => {
    if (!sidebarVisible || !tabActive || sidebar === null) {
      return;
    }
    const query = (sidebar.getSearchQuery() || flowSearch?.query || pdfSearch?.query || '').trim();
    if (query === '') {
      return;
    }
    if (pdfHandle !== null) {
      runPdfSearch(query);
      return;
    }
    runFlowSearch(query, { preserveActive: flowSearch?.active });
  };

  const syncPaginatedChapter = (): void => {
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    stalePaginatedChapters = null; // 布局切换重测/重分栏全部帧，作废缩放惰性标记
    const saved = lastFlowProgress ?? currentProgressSnapshot();
    if (saved !== null && progressId !== '') {
      saveReadingProgress(progressStorage, progressId, saved);
    }
    if (!flowIsPaginated()) {
      remasureScrollFrames();
      if (saved !== null) {
        pendingRestore = saved;
        restoreAttempts = 0;
        applySavedProgress();
      }
      requestAnimationFrame(refreshOpenSearch);
      return;
    }
    if (saved !== null) {
      pendingRestore = saved;
      restoreAttempts = 0;
    }
    setActiveChapter(saved?.index ?? chapterFromScroll());
    const frame = visibleFlowFrame();
    const doc = frame?.contentDocument;
    if (frame !== null && doc !== undefined && doc !== null) {
      applyPaginatedDocument(frame, doc, saved === null ? undefined : { restoreRatio: saved.ratio });
    }
    if (pendingRestore !== null) {
      applySavedProgress();
    }
    requestAnimationFrame(refreshOpenSearch);
  };

  const refreshViewport = (): void => {
    if (destroyed) {
      return;
    }
    if (pdfHandle !== null) {
      void pdfHandle.rerender();
      return;
    }
    if (cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    layoutSwitching = true;
    try {
      if (flowIsPaginated()) {
        const frame = visibleFlowFrame();
        const doc = frame?.contentDocument;
        if (frame !== null && doc !== undefined && doc !== null) {
          applyPaginatedDocument(frame, doc);
        }
      } else {
        remasureScrollFrames();
      }
    } finally {
      layoutSwitching = false;
    }
    refreshOpenSearch();
    syncFlowState();
    pinSidebarOverlay();
    if (chromePanel !== null) {
      const panel = chromePanel === 'toc' ? tocPanel : typePanel;
      const action = chromePanel === 'toc' ? 'toc' : 'typography';
      positionReaderChromePanel(
        panel,
        root,
        root.querySelector(`[data-reader-chrome-action="${action}"]`),
      );
    }
  };
  const settleViewportRefresh = createResizeSettle();
  let cancelSettledRefresh: (() => void) | null = null;
  const onWindowResize = (): void => {
    cancelSettledRefresh = settleViewportRefresh(refreshViewport);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize);
  }
  const cancelViewportRefresh = (): void => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
    cancelSettledRefresh?.();
    cancelSettledRefresh = null;
  };

  const layoutRoot =
    typeof document !== 'undefined' && document.documentElement != null
      ? document.documentElement
      : null;
  const layoutRootObserver =
    layoutRoot === null || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(syncPaginatedChapter);
  if (layoutRoot !== null) {
    try {
      layoutRootObserver?.observe(layoutRoot, {
        attributes: true,
        attributeFilter: ['data-reading-layout'],
      });
    } catch {
      // Fake documents in unit tests are not MutationObserver targets.
    }
  }

  // PDF 连续滚动：←/→ 滚到上/下一页，+/- 缩放，0 还原。
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dismissReaderOverlayStep()) {
      event.preventDefault();
      return;
    }
    // 方向键/空格/PageUp/Down 由窗口级 main.ts 统一翻页（R1：大纲/chrome/空白区
    // 同样生效）。这里只保留 PDF 缩放键；流式章节 iframe 内翻页仍由 flow-renderer 转发。
    const handle = pdfHandle;
    if (handle === null) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      if (handle.controller.zoomIn()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '-' || event.key === '_') {
      if (handle.controller.zoomOut()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '0') {
      if (handle.controller.resetScale()) {
        event.preventDefault();
        syncPageState();
        void handle.rerender();
      }
    }
  });

  // 书签 / 笔记改由菜单触发（见 ReaderInstance.addBookmark/addNote），不再挂浮动工具栏。

  const returnToShelf = (): void => {
    persistReadingProgress();
    closeChromePanel();
    readerChrome?.dismiss();
    syncChromeRevealAttr();
    deps.onReturnToShelf?.();
  };

  const applyTypographyPatch = (patch: Partial<ReaderTypography>): void => {
    const next = saveReaderTypography(preferenceStorage, patch);
    dispatchReaderTypographyPref(next);
    refreshViewport();
    renderTypographyPanel();
  };

  const applyFlowLayout = (layout: ReaderFlowLayout): void => {
    const next = parseReaderLayout(layout);
    saveReaderLayout(preferenceStorage, next);
    applyReaderLayout(root, next);
    if (typeof document !== 'undefined') {
      applyReaderDocumentLayout(document.documentElement, 'reader', next);
    }
    dispatchReaderFlowLayoutPref(next);
    refreshViewport();
    renderTypographyPanel();
    readerChrome?.syncStayRevealed();
    syncChromeRevealAttr();
  };

  const applyPaperTheme = (theme: ReaderThemeId): void => {
    const next = saveReaderTheme(preferenceStorage, theme);
    applyReaderTheme(root, next);
    const pane = closestPane();
    if (pane !== null) {
      applyReaderTheme(pane, next);
    }
    flowRenderer.syncTheme();
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('lightink:reader-theme', { detail: next }));
    }
    renderTypographyPanel();
  };

  const readerPanelCopy = (): ReaderChromePanelCopy => ({
    tocTitle: t('reader.toc.title'),
    tocEmpty: t('outline.empty'),
    typeTitle: t('reader.type.title'),
    theme: t('reader.type.theme'),
    size: t('reader.type.size'),
    font: t('reader.type.font'),
    lineHeight: t('reader.type.lineHeight'),
    measure: t('reader.type.measure'),
    layout: t('reader.type.layout'),
    paginated: t('reader.type.paginated'),
    scroll: t('reader.type.scroll'),
    smaller: t('view.zoomOut'),
    larger: t('view.zoomIn'),
    fonts: {
      body: t('reader.font.body'),
      sans: t('reader.font.sans'),
      serif: t('reader.font.serif'),
      mono: t('reader.font.mono'),
    },
    lineHeights: [
      t('reader.type.spacing.tight'),
      t('reader.type.spacing.normal'),
      t('reader.type.spacing.relaxed'),
      t('reader.type.spacing.loose'),
    ],
    measures: [
      t('reader.type.width.narrower'),
      t('reader.type.width.narrow'),
      t('reader.type.width.normal'),
      t('reader.type.width.wide'),
      t('reader.type.width.wider'),
    ],
    themes: {
      white: t('reader.theme.white'),
      sepia: t('reader.theme.sepia'),
      gray: t('reader.theme.gray'),
      night: t('reader.theme.night'),
    },
  });

  const renderTocPanel = (): void => {
    const current =
      readerState.locationKind === 'chapter'
        ? { chapter: Math.max(0, readerState.current - 1) }
        : readerState.locationKind === 'page'
          ? { page: readerState.current }
          : {};
    fillReaderTocPanel(tocPanel, readerOutline, readerPanelCopy(), current, (item) => {
      jumpToOutlineItem(item);
      closeChromePanel();
    });
  };

  const renderTypographyPanel = (): void => {
    const current = loadReaderTypography(preferenceStorage);
    fillReaderTypographyPanel(
      typePanel,
      current,
      loadReaderTheme(preferenceStorage),
      readerPanelCopy(),
      applyTypographyPatch,
      applyPaperTheme,
      (direction) =>
        applyTypographyPatch({
          fontScaleStep: nextReaderFontScaleStep(current.fontScaleStep, direction),
        }),
      loadReaderLayout(preferenceStorage),
      applyFlowLayout,
    );
  };

  const openChromePanel = (next: 'toc' | 'typography'): void => {
    if (chromePanel === next) {
      closeChromePanel();
      return;
    }
    chromePanel = next;
    if (next === 'toc') {
      renderTocPanel();
    } else {
      renderTypographyPanel();
    }
    tocPanel.hidden = next !== 'toc';
    typePanel.hidden = next !== 'typography';
    const panel = next === 'toc' ? tocPanel : typePanel;
    const action = next === 'toc' ? 'toc' : 'typography';
    positionReaderChromePanel(
      panel,
      root,
      root.querySelector(`[data-reader-chrome-action="${action}"]`),
    );
    syncChromeActionState();
  };

  if (canMountReaderChrome()) {
    readerChrome = createReaderChrome(root, {
      returnToShelf,
      openOutline: () => openChromePanel('toc'),
      openTypography: () => openChromePanel('typography'),
      toggleSidebar: () => setSidebarVisible(!sidebarVisible),
      isOverlayOpen: () => sidebarVisible || chromePanel !== null,
      dismissOverlay: () => closeChromePanel(),
      isSidebarVisible: () => sidebarVisible,
      isSelectionToolbarVisible: () => selectionToolbar?.isVisible() === true,
      hideSelectionToolbar,
      stayRevealed: () =>
        !flowIsPaginated() && flowScrollContainer().scrollTop <= 16,
    });
    root.append(tocPanel, typePanel);
    root.addEventListener('click', syncChromeRevealAttr);
    root.addEventListener('pointermove', syncChromeRevealAttr);
    readerChrome.syncStayRevealed();
    syncChromeRevealAttr();
    syncChromeActionState();
    if (typeof MutationObserver === 'function') {
      chromeRevealObserver = new MutationObserver(syncChromeRevealAttr);
      try {
        chromeRevealObserver.observe(readerChrome.element, {
          attributes: true,
          attributeFilter: ['data-reader-chrome-revealed', 'class'],
        });
      } catch {
        chromeRevealObserver = null;
      }
    }
  }

  return {
    get state() {
      return readerState;
    },
    subscribeState(listener) {
      stateListeners.add(listener);
      try {
        listener(readerState);
      } catch {
        // Keep subscription setup isolated from application chrome failures.
      }
      return () => {
        stateListeners.delete(listener);
      };
    },
    async load(targetOrPath: string | ReaderTarget, options: ReaderLoadOptions = {}): Promise<void> {
      const target = normalizeReaderTarget(targetOrPath);
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      const nextExt = (target.extension || extOfPath(filePath)).toLowerCase();
      const nativeArchive = NATIVE_ARCHIVE_EXTENSIONS.has(nextExt);
      const readBytes = deps.readBytes;
      if (target.kind === 'local' && readBytes === undefined && !nativeArchive) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      if (destroyed) {
        throw new Error('reader-view has been destroyed');
      }

      activeLoadController?.abort();
      annotationWriteQueue.invalidate();
      hideSelectionToolbar();
      persistReadingProgress();
      progressId = '';
      pendingRestore = null;
      restoreAttempts = 0;
      readerOutline = [];
      exportChapters = [];
      exportStylesheet = '';
      exportEmbedImages = null;
      closeOpenNoteDialog(); // 打开中的笔记弹层经 Escape 正规 release（续体守卫丢弃迟到保存）
      closePdfSearch(); // 切换文档清掉搜索状态与命中 overlay
      const controller = new AbortController();
      activeLoadController = controller;
      const generation = ++loadGeneration;
      const formatPath = extOfPath(filePath) === nextExt ? filePath : `${filePath}.${nextExt}`;
      const cancelFromCaller = (): void => controller.abort();
      if (options.signal?.aborted === true) {
        controller.abort();
      } else {
        options.signal?.addEventListener('abort', cancelFromCaller, { once: true });
      }
      const isCurrent = (): boolean =>
        !destroyed && !controller.signal.aborted && generation === loadGeneration;
      let completed = false;
      let pendingRemoteSource: RandomAccessSource | null = null;

      setReaderPhase('loading', true);
      try {
        if (target.kind === 'remote' && !nativeArchive) {
          pendingRemoteSource =
            deps.openRemoteSource !== undefined
              ? await deps.openRemoteSource(target, controller.signal)
              : (await attachRemoteSource(target, { signal: controller.signal })).source;
          throwIfReaderLoadCancelled(controller.signal);
        }
        if (PAGE_EXTS.has(nextExt)) {
          const pageSource =
            nativeArchive
              ? null
              : target.kind === 'remote'
              ? pendingRemoteSource!
              : await readBytes!(filePath, controller.signal);
          throwIfReaderLoadCancelled(controller.signal);
          if (!isCurrent()) {
            return;
          }
          const staged = await stagePages(formatPath, pageSource, controller.signal, target);
          if (target.kind === 'remote' && !nativeArchive) {
            // The page renderer now owns the source and closes it with its handle.
            pendingRemoteSource = null;
          }
          if (controller.signal.aborted) {
            await staged.pdf?.destroy().catch(() => undefined);
            await staged.cbz?.destroy().catch(() => undefined);
            throwIfReaderLoadCancelled(controller.signal);
          }
          if (!isCurrent()) {
            await staged.pdf?.destroy().catch(() => undefined);
            await staged.cbz?.destroy().catch(() => undefined);
            return;
          }
          loadedExt = nextExt;
          annotations = [];
          contentHash = null;
          sidebar?.render(annotations);
          commitStagedPages(staged);
          readerOutline =
            staged.pdf !== null
              ? await staged.pdf.outline()
              : outlineFromEntries(
                  Array.from({ length: staged.cbz?.totalPages ?? 0 }, (_, index) => ({
                    title: t('annotation.location.page', { page: String(index + 1) }),
                  })),
                  'page',
                );
          if (!isCurrent()) {
            return;
          }
        } else {
          // T8：txt 经分块字节源懒读（不整文件驻留）；无 readChunk 依赖时回退整读。
          const readChunk = target.kind === 'local' && nextExt === 'txt' ? deps.readChunk : undefined;
          const source: ReaderInputSource =
            target.kind === 'remote'
              ? pendingRemoteSource!
              : readChunk === undefined
                ? await readBytes!(filePath, controller.signal)
                : {
                    read: (offset, length, readSignal) =>
                      readChunk(filePath, offset, length, readSignal ?? controller.signal),
                  };
          throwIfReaderLoadCancelled(controller.signal);
          if (!isCurrent()) {
            return;
          }
          const content = await (deps.parseContent ?? parseReaderContent)(
            formatPath,
            source,
            controller.signal,
          );
          if (pendingRemoteSource !== null) {
            const ownedSource = pendingRemoteSource;
            const disposeContent = content.dispose;
            content.dispose = () => {
              disposeContent?.();
              void ownedSource.close().catch(() => undefined);
            };
            pendingRemoteSource = null;
          }
          if (controller.signal.aborted) {
            content.dispose?.();
            throwIfReaderLoadCancelled(controller.signal);
          }
          if (!isCurrent()) {
            content.dispose?.();
            return;
          }
          loadedExt = nextExt;
          annotations = [];
          contentHash = null;
          sidebar?.render(annotations);
          const previousPdf = pdfHandle;
          const previousCbz = cbzHandle;
          const previousFlowDispose = flowContentDispose;
          pdfHandle = null;
          cbzHandle = null;
          flowContentDispose = content.dispose ?? null;
          try {
            renderChapters(content.chapters, content.stylesheet);
            exportChapters = content.chapters;
            exportStylesheet = content.stylesheet ?? '';
            exportEmbedImages = content.embedExportImages ?? null;
            readerOutline = outlineFromEntries(
              content.chapters.map((chapter, index) => ({
                title: chapter.title.trim() || t('reader.chapter', { n: String(index + 1) }),
              })),
              'chapter',
            );
          } catch (error) {
            flowContentDispose?.();
            flowContentDispose = previousFlowDispose;
            throw error;
          }
          void previousPdf?.destroy().catch(() => undefined);
          void previousCbz?.destroy().catch(() => undefined);
          previousFlowDispose?.();
          for (const warning of content.warnings ?? []) {
            deps.notify?.(t(`reader.warning.${warning}`));
          }
        }

        await loadAnnotations(target, generation, controller.signal);
        throwIfReaderLoadCancelled(controller.signal);
        if (isCurrent()) {
          progressId =
            contentHash ??
            (target.kind === 'remote' ? readerIdentityKey(target.identity) : filePath);
          pendingRestore = loadReadingProgress(progressStorage, progressId);
          restoreAttempts = 0;
          setReaderPhase('ready');
          applySavedProgress();
          if (PAGE_EXTS.has(loadedExt)) {
            syncPageState();
          } else {
            syncFlowState();
          }
          if (progressId !== '') {
            try {
              deps.onProgressBound?.(progressId, target);
            } catch {
              // Shelf alias must not interrupt reading.
            }
          }
          completed = true;
        }
      } catch (error) {
        if (isReaderLoadCancelled(error, controller.signal)) {
          if (!destroyed && generation === loadGeneration) {
            setReaderPhase('cancelled');
          }
          return;
        }
        if (!isCurrent()) {
          return;
        }
        setReaderPhase('error');
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', cancelFromCaller);
        await pendingRemoteSource?.close().catch(() => undefined);
        if (activeLoadController === controller && !completed) {
          activeLoadController = null;
        }
      }
    },
    async destroy(): Promise<void> {
      if (destroyed) {
        return;
      }
      persistReadingProgress();
      if (progressSaveTimer !== null) {
        clearTimeout(progressSaveTimer);
        progressSaveTimer = null;
      }
      destroyed = true;
      loadGeneration += 1;
      activeLoadController?.abort();
      activeLoadController = null;
      annotationWriteQueue.invalidate();
      clearFlowBindings();
      const handle = pdfHandle;
      const cbz = cbzHandle;
      const disposeFlowContent = flowContentDispose;
      pdfHandle = null;
      cbzHandle = null;
      flowContentDispose = null;
      sidebar?.destroy();
      sidebar = null;
      sidebarBackdrop?.remove();
      sidebarBackdrop = null;
      selectionToolbar?.destroy();
      selectionToolbar = null;
      pendingSelection = null;
      readerOutline = [];
      exportChapters = [];
      exportStylesheet = '';
      exportEmbedImages = null;
      searchGeneration += 1;
      if (searchDebounce !== null) {
        clearTimeout(searchDebounce);
        searchDebounce = null;
      }
      pendingSearchScrollKey = null;
      pdfSearch = null;
      flowSearch = null;
      scrollHost.removeEventListener('scroll', scheduleFlowScroll);
      paneScroller?.removeEventListener('scroll', scheduleFlowScroll);
      pageHost.removeEventListener('scroll', schedulePageScroll);
      closestPane()?.removeEventListener('scroll', schedulePageScroll);
      flowScrollCoordinator?.cancel();
      pageScrollCoordinator?.cancel();
      cancelFontScaleRefresh?.();
      cancelFontScaleRefresh = null;
      stalePaginatedChapters = null;
      pageHost.removeEventListener('mouseup', onPageHostSelection);
      pageHost.removeEventListener('click', onPageHostNoteClick);
      chromeRevealObserver?.disconnect();
      chromeRevealObserver = null;
      closeChromePanel();
      if (readerChrome !== null) {
        root.removeEventListener('click', syncChromeRevealAttr);
        root.removeEventListener('pointermove', syncChromeRevealAttr);
      }
      readerChrome?.destroy();
      readerChrome = null;
      tocPanel.remove();
      typePanel.remove();
      textLayerObserver?.disconnect();
      textLayerObserver = null;
      layoutRootObserver?.disconnect();
      cancelViewportRefresh();
      if (typeof document !== 'undefined') {
        document.removeEventListener('lightink:font-scale', onFontScaleChange);
        document.removeEventListener('lightink:theme-change', onThemeChange);
      }
      closeOpenNoteDialog();
      setReaderPhase('destroyed', true);
      stateListeners.clear();
      root.remove();
      disposeFlowContent?.();
      await handle?.destroy().catch(() => undefined);
      await cbz?.destroy().catch(() => undefined);
    },
    addBookmark: () => {
      if (annotationsEnabled) addAnnotation('bookmark');
    },
    addNote: () => {
      if (annotationsEnabled) addAnnotation('note');
    },
    toggleSidebar: () => setSidebarVisible(!sidebarVisible),
    setTabActive: (active: boolean): void => setTabActive(active),
    isSidebarVisible: () => sidebarVisible,
    openSearch,
    refreshViewport,
    refreshPreferences: () => {
      applyTypographyPatch(loadReaderTypography(preferenceStorage));
      applyFlowLayout(loadReaderLayout(preferenceStorage));
      applyPaperTheme(loadReaderTheme(preferenceStorage));
      if (cbzHandle !== null) {
        cbzHandle.setPreferences(
          loadComicPreferences(
            preferenceStorage,
            cbzHandle.metadata.readingDirection ?? 'ltr',
          ),
        );
      }
    },
    advanceReading,
    getOutline: () => readerOutline,
    jumpToOutlineItem,
    isAnnotationEnabled: () => annotationsEnabled,
    getExportHtml: async (mode = 'blob') => {
      if (exportChapters.length === 0) {
        return null;
      }
      const publisher = sanitizeReaderCss(exportStylesheet);
      const style =
        (publisher === '' ? '' : `<style>${publisher}</style>`) +
        '<style>.lightink-export-chapter{break-before:page;page-break-before:always}' +
        '.lightink-export-chapter:first-of-type{break-before:auto;page-break-before:auto}' +
        '.lightink-export-bookmark{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;font-size:1px;line-height:1;color:transparent}</style>';
      const missing: string[] = [];
      const sections: string[] = [];
      for (const [index, chapter] of exportChapters.entries()) {
        // 阅读器 chrome 标题不能做成正文 h1（会和书里标题叠成两行）。
        // 封面/插图等无 heading 的章仍需一个隐藏 h1，否则 PDF 书签/目录会丢这些条目。
        const title = chapter.title.trim() || t('reader.chapter', { n: String(index + 1) });
        const bookmark = /<h[1-6]\b/i.test(chapter.html)
          ? ''
          : `<h1 class="lightink-export-bookmark">${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>`;
        let markup = `<section class="lightink-export-chapter">${bookmark}${chapter.html}</section>`;
        if (exportEmbedImages !== null) {
          const embedded = await exportEmbedImages(markup, mode);
          markup = embedded.html;
          missing.push(...embedded.missing);
        }
        sections.push(markup);
      }
      if (missing.length > 0) {
        throw new Error(
          `有 ${new Set(missing).size} 张图片无法内嵌: ${[...new Set(missing)].join(', ')}`,
        );
      }
      return style + sections.join('');
    },
  };
}
