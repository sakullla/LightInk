/**
 * `reader-view` — 只读阅读视图的编排壳（T3 骨架 + T4 流式 + T5 页式 + T6 标注；
 * T5 起章节 iframe 渲染/生命周期拆入 src/reader/flow-renderer.ts，会话核心
 * （打开管线/世代取代/对称作废）拆入 src/reader/session/session-load.ts，
 * 进度会话（身份链/快照派发/恢复重试阈值/保存时机）拆入
 * src/reader/session/session-progress.ts，搜索会话（世代失效/命中上限/
 * busy reveal/首命中滚动/活动命中步进）拆入 src/reader/session/session-search.ts，
 * 导航会话（advanceReading 三支与大纲跳转收敛为按 adapter kind 的策略表）拆入
 * src/reader/session/session-navigation.ts，
 * flow/paged 两族 adapter 见 src/reader/session/adapters.ts）。
 *
 * 流式格式渲染章节化 HTML（滚动宿主）；PDF/CBZ 渲染页（页宿主）。标注按内容哈希
 * （Rust content_hash）关联：加载时读出 → 流式高亮渲染 <mark> + 侧栏列表跳转；
 * 选中正文可加高亮，工具栏可加书签/笔记，侧栏可移除，变更写回 app_data_dir。
 * 本壳保留：视图 DOM/状态机接线、进度表面的 DOM 供数（flow/paged 两族
 * snapshot/落点机械）、标注与搜索接线、翻页导航编排；
 * 打开编排只剩 adapter 选择（PAGE_EXTS → paged，其余 → flow）。
 * 只消费主题令牌 var(--lightink-*) 与 --lightink-font-scale。
 */

import './reader.css';
import type { MessageKey } from '../i18n/messages.js';
import { parseReaderContent, type ReaderInputSource } from './formats/index.js';
import {
  normalizeReaderTarget,
  type ArchiveProvider,
  type RandomAccessSource,
  type ReaderTarget,
  type RemoteReaderTarget,
} from './sources/types.js';
import { createLocalFileSource } from './sources/file-source.js';
import { throwIfReaderLoadCancelled } from './load-lifecycle.js';
import { ParseError, type ReaderChapter, type ReaderContent } from './formats/types.js';
import { sanitizeReaderCss } from './sanitize-css.js';
import { escapeHtml } from './html-escape.js';
import {
  renderCbzInto,
  type CbzRenderHandle,
  type ComicArchiveInput,
} from './formats/cbz.js';
import { renderPdfInto, type PdfRenderHandle } from './formats/pdf.js';
import {
  removeAnnotation,
  updateAnnotationNote,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
  type Locator,
} from './annotations.js';
import {
  annotationMarkFromEventTarget,
  flowLocatorFromSelection,
  pdfTextLocatorFromRange,
  resolveTextQuoteRange,
} from './annotation-locator.js';
import {
  annotationMarkSpec,
  paintAnnotationOverlays,
  renderAnnotationMarks,
  removeAnnotationMarks,
  type AnnotationMarkSpec,
} from './annotation-render.js';
import {
  createAnnotationPanel,
  type AnnotationPanel,
} from './annotation-panel.js';
import {
  createSelectionToolbar,
  selectionClientRect,
  type SelectionToolbar,
} from './selection-toolbar.js';
import { showNoteDialog } from './note-dialog.js';
import { outlineFromEntries } from './outline.js';
import {
  outlineLocationFromReader,
  type OutlineItem,
} from '../outline/outline-model.js';
import {
  findTextHits,
  htmlToSearchText,
  sanitizeSearchQuery,
  snippetAround,
} from './search-panel.js';
import {
  clearSearchMarks,
  flowSearchMarkKey,
  limitSearchMarkSpecs,
  renderSearchMarks,
  SEARCH_MARK_CURRENT_CLASS,
  type SearchMarkSpec,
} from './search-overlay.js';
import { createReaderSessionSearch } from './session/session-search.js';
import type {
  ReaderInstance,
  ReaderLoadOptions,
  ReaderPhase,
  ReaderState,
  ReaderStateListener,
} from './types.js';
import {
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../media/remote-image-policy.js';
import { extOfPath } from '../file/path-ext.js';
import {
  chapterScrollRatio,
  chapterScrollTop,
  resolveProgressStorage,
  type ProgressStorage,
} from './reading-progress.js';
import {
  advanceScrolledScroller,
  applyPagedProgress,
  createCoalescedScrollHandler,
  createPagedWheelGate,
  createResizeSettle,
  nearestVisibleChapterIndex,
  chapterIndexAtViewportTop,
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
import { createFlowRenderer, mapFrameClientRect, readerPagedScroller } from './flow-renderer.js';
import { createReaderSessionLoad } from './session/session-load.js';
import { createReaderSessionNavigation } from './session/session-navigation.js';
import { createReaderSessionAnnotation } from './session/session-annotation.js';
import {
  PAGED_SESSION_EXTENSIONS,
  sessionAdapterKindForExtension,
  sessionCapabilitiesForExtension,
  sessionMemberForExtension,
  type ReaderSessionAdapter,
  type SessionInvalidation,
  type SessionOpenRequest,
  type SessionRunContext,
  type StagedSession,
} from './session/adapters.js';
import {
  comicProgressIdForTarget,
  createReaderSessionProgress,
  FLOW_RESTORE_MAX_ATTEMPTS,
  type SessionProgressFeed,
} from './session/session-progress.js';
import {
  NATIVE_ARCHIVE_EXTENSIONS,
  openNativeArchive,
  usesNativeArchive,
  type ArchivePasswordProvider,
} from './sources/native-archive.js';
import type { ComicMetadata } from './comic-model.js';
import { loadComicPreferences } from './comic-preferences.js';
import { createReaderChrome, type ReaderChrome } from './reader-chrome.js';
import {
  clampFlowRestoreIndex,
  flowBookProgress,
  formatReaderLocation,
  readerProgressTickFractions,
  playReaderPageTurn,
  resolveReaderChapterTitle,
  stampReadingProgressTitle,
} from './reader-progress-ui.js';
import { syncReaderTitlebarReveal } from '../ui/window-titlebar.js';
import {
  activateReaderTocPanel,
  adoptReaderOverlayTheme,
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  mountReaderOverlay,
  pinFixedOverlay,
  positionReaderChromePanel,
  unpinFixedOverlay,
  type ReaderChromePanelCopy,
  type ReaderTypographyComicControls,
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

/** 页式扩展族与 session adapter 选择同源（加载编排见 session/session-load）。 */
const PAGE_EXTS = PAGED_SESSION_EXTENSIONS;

const COMIC_HOST_DATASET_KEYS = [
  'comicReader',
  'comicChrome',
  'comicCanvas',
  'comicMode',
  'comicDirection',
  'comicSpread',
  'comicSpreadPref',
  'comicFit',
  'comicFitWidth',
  'comicCropMargins',
  'comicVisible',
  'comicZoomed',
  'comicScale',
  'comicPanning',
] as const;

/** Drop leftover comic surface attrs so EPUB/PDF do not keep :has() / dock rules. */
function clearComicHostDataset(element: HTMLElement): void {
  for (const key of COMIC_HOST_DATASET_KEYS) {
    delete element.dataset[key];
  }
}

/** Strip/fit copy the i18n table does not own; sniff locale from an existing key. */
function comicLocaleLabels(t: (key: MessageKey) => string): {
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

function canMountReaderChrome(): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return false;
  }
  const probe = document.createElement('div');
  return typeof probe.classList?.toggle === 'function';
}

/**
 * Touch chrome mode comes from the mobile platform flags stamped on the
 * document root (`mobile-platform.ts`). Desktop has neither flag → false,
 * keeping the 2.5s idle auto-hide and edge-hover reveal byte-identical.
 */
function readerChromeTouchMode(): boolean {
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
  if (rootEl == null || typeof rootEl.hasAttribute !== 'function') {
    return false;
  }
  return rootEl.hasAttribute('data-android') || rootEl.hasAttribute('data-touch-primary');
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
  /** 读取本地阅读文件大小，不扫描或传输正文；用于 EPUB/CBZ/PDF 随机读取源。 */
  readSize?: (filePath: string, signal?: AbortSignal) => Promise<number>;
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
  const flowIsPaginated = (): boolean =>
    parseReaderLayout(root.dataset.readingLayout) === 'paginated';

  let readerChrome: ReaderChrome | null = null;
  let chromePanel: 'toc' | 'typography' | null = null;
  let chromeRevealObserver: MutationObserver | null = null;
  let pageChromeObserver: MutationObserver | null = null;

  const watchPageChrome = (): void => {
    pageChromeObserver?.disconnect();
    if (typeof MutationObserver !== 'function') {
      return;
    }
    pageChromeObserver = new MutationObserver(syncChromeRevealAttr);
    try {
      pageChromeObserver.observe(pageHost, {
        attributes: true,
        attributeFilter: ['data-comic-chrome', 'data-comic-reader'],
      });
    } catch {
      pageChromeObserver = null;
    }
  };
  const tocPanel = document.createElement('div');
  tocPanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-toc';
  tocPanel.hidden = true;
  tocPanel.setAttribute('data-panel', 'toc');
  const typePanel = document.createElement('div');
  typePanel.className = 'lightink-reader-chrome-panel lightink-reader-chrome-typography';
  typePanel.hidden = true;
  typePanel.setAttribute('data-panel', 'typography');

  // —— 标注宿主会话（session-annotation）：启用判定（标注存储 × adapter
  // 能力声明 × 身份可用）、写队列与侧栏显隐策略唯一实现在核心；本壳只按
  // host 供数（侧栏 DOM/portal/焦点机械）并消费其裁决。 ——
  const sessionAnnotation = createReaderSessionAnnotation({
    storage: {
      readAnnotations: deps.readAnnotations,
      writeAnnotations: deps.writeAnnotations,
      getContentHash: deps.getContentHash,
    },
    notifySaveFailed: () => deps.notify?.(t('annotation.saveFailed')),
    isDestroyed: () => destroyed,
    ensureSidebarDom: () => ensureSidebar(),
    syncSidebarDom: () => syncSidebarOverlayDom(),
    isNarrowViewport: () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 700px)').matches,
    focusSidebarClose: () => {
      sidebar?.element
        .querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')
        ?.focus();
    },
    sidebarHoldsFocus: () =>
      sidebar !== null && sidebar.element.contains(document.activeElement),
    focusReaderRoot: () => root.focus(),
    closeChromePanel: () => closeChromePanel(),
    resetSearch: () => resetReaderSearch(),
    afterSidebarSync: () => syncVisibleFlowFrames(),
    sidebarSearchQuery: () => sidebar?.getSearchQuery() ?? '',
    renderSidebarList: () => sidebar?.render(annotations),
  });

  let pdfHandle: PdfRenderHandle | null = null;
  let cbzHandle: CbzRenderHandle | null = null;
  let annotations: Annotation[] = [];
  let sidebar: AnnotationPanel | null = null;
  let sidebarBackdrop: HTMLButtonElement | null = null;
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
  let destroyed = false;
  /** Spine item count is metadata, independent from the bounded mounted iframe window. */
  let flowChapterCount = 0;
  /**
   * 搜索会话（世代失效/防抖重查合并/命中上限/busy reveal/首命中滚动/活动命中
   * 步进）唯一实现在 session-search；本壳按族供数与接线：匹配器留格式侧
   * （pdf 句柄 search / findTextHits 章匹配），命中 overlay 经共享幂等引擎渲染。
   */
  const sessionSearch = createReaderSessionSearch({
    activeKind: () => (pdfHandle !== null ? 'pdf' : 'flow'),
    isDestroyed: () => destroyed,
    syncHits: () => syncSearchHits(),
    clearMarks: () => clearReaderSearchMarks(),
    searchPdf: (query, sink) => {
      const handle = pdfHandle;
      if (handle === null) {
        return;
      }
      void (async () => {
        const matches = await handle.search(query, {
          onProgress: (partial, done) => {
            if (handle === pdfHandle) {
              sink.onResult(partial, done); // 句柄被取代后不再回投
            }
          },
        });
        if (handle === pdfHandle) {
          sink.onResult(matches, true);
        }
      })();
    },
    describePdfHits: (matches) =>
      matches.map((match) => ({
        key: `${match.page}:${match.start}:${match.end}`,
        snippet: match.snippet,
        location: t('annotation.location.page', { page: String(match.page) }),
        payload: { kind: 'pdf', page: match.page, start: match.start, end: match.end },
      })),
    pdfCurrentPage: () => pdfHandle?.controller.page ?? 1,
    renderPdfHits: (hits, activeKey) => {
      const pdfTextLayerFor = (page: number): HTMLElement | null =>
        pageHost.querySelector<HTMLElement>(
          `.lightink-reader-page-slot[data-page-index="${page - 1}"] .lightink-reader-text-layer`,
        );
      const byPage = new Map<number, SearchMarkSpec[]>();
      for (const hit of hits) {
        if (hit.payload.kind !== 'pdf') {
          continue;
        }
        const spec: SearchMarkSpec = {
          key: hit.key,
          start: hit.payload.start,
          end: hit.payload.end,
        };
        const list = byPage.get(hit.payload.page);
        if (list === undefined) {
          byPage.set(hit.payload.page, [spec]);
        } else {
          list.push(spec);
        }
      }
      for (const [page, specs] of byPage) {
        const layer = pdfTextLayerFor(page);
        if (layer === null) {
          continue; // 未懒渲染的页跳过；层出现时经 observer 重渲染
        }
        renderSearchMarks(layer, limitSearchMarkSpecs(specs, activeKey), activeKey);
      }
      // 激活滚动：该命中即 pending 目标且当前命中 overlay 已就绪时，滚动一次即消费。
      const active = hits.find((hit) => hit.key === activeKey);
      if (active !== undefined && active.payload.kind === 'pdf') {
        const activeMark =
          pdfTextLayerFor(active.payload.page)?.querySelector<HTMLElement>(
            `.${SEARCH_MARK_CURRENT_CLASS}`,
          ) ?? null;
        if (activeMark !== null && sessionSearch.consumePendingScroll(activeKey, true)) {
          activeMark.scrollIntoView({ block: 'nearest' });
        }
      }
    },
    activatePdfHit: (hit) => {
      if (hit.payload.kind !== 'pdf') {
        return;
      }
      pdfHandle?.scrollToPage(hit.payload.page);
      syncPageState();
    },
    flowSearchable: () => !PAGE_EXTS.has(loadedExt),
    flowChapterCount: () => Math.max(exportChapters.length, flowChapterCount),
    flowChapterText: async (chapter) => {
      const mounted = chapterFrame(chapter)?.contentDocument?.body.textContent ?? '';
      if (mounted.trim() !== '') {
        return mounted;
      }
      const source = exportChapters[chapter];
      if (source === undefined) {
        return '';
      }
      // ReaderChapter.load 可选（TXT/FB2 无懒装载）：await undefined 与原
      // runFlowSearch 口径一致，缺载章节直接按既有 html 取拼接文本。
      await source.load?.();
      return htmlToSearchText(source.html);
    },
    flowMatchChapter: (chapter, text, query) =>
      findTextHits(text, query).map((hit, ordinal) => ({
        key: flowSearchMarkKey(chapter, ordinal, hit.start, hit.end),
        start: hit.start,
        end: hit.end,
      })),
    describeFlowHits: (groups) => {
      const described = [];
      const chapters = [...groups.keys()].sort((left, right) => left - right);
      for (const chapter of chapters) {
        const mounted = chapterFrame(chapter)?.contentDocument?.body.textContent ?? '';
        const text =
          mounted.trim() !== ''
            ? mounted
            : htmlToSearchText(exportChapters[chapter]?.html ?? '');
        for (const spec of groups.get(chapter) ?? []) {
          described.push({
            key: spec.key,
            snippet: snippetAround(text, spec.start, spec.end),
            location: t('reader.chapter', { n: String(chapter + 1) }),
            payload: { kind: 'flow' as const, chapter, start: spec.start, end: spec.end },
          });
        }
      }
      return described;
    },
    renderFlowHits: (groups, currentKey) => {
      // 宿主遍历口径与原实现一致：按已挂载帧顺序以序号取该章 spec。
      flowDocuments().forEach((doc, index) => {
        renderSearchMarks(
          doc.body,
          limitSearchMarkSpecs(groups.get(index) ?? [], currentKey),
          currentKey,
        );
      });
    },
    collectFlowMarks: (groups) => {
      const keys: string[] = [];
      const currentChapter = Math.max(0, readerState.current - 1);
      let firstAtOrAfter = -1;
      for (const [chapter, specs] of groups) {
        const doc = chapterFrame(chapter)?.contentDocument;
        if (doc === null || doc === undefined) {
          continue;
        }
        for (const spec of specs) {
          if (doc.body.querySelector(`[data-search-key="${cssEscape(spec.key)}"]`) === null) {
            continue;
          }
          if (firstAtOrAfter < 0 && chapter >= currentChapter) {
            firstAtOrAfter = keys.length;
          }
          keys.push(spec.key);
        }
      }
      return { keys, firstAtOrAfter };
    },
    ensureFlowChapter: (chapter) => {
      flowRenderer.ensureChapter(chapter);
      setActiveChapter(chapter);
    },
    revealFlowHit: (key) => {
      for (const doc of flowDocuments()) {
        const mark = doc.body.querySelector<HTMLElement>(
          `[data-search-key="${cssEscape(key)}"]`,
        );
        if (mark !== null) {
          revealFlowMark(mark);
          return;
        }
      }
    },
  });
  const remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
  const progressStorage = resolveProgressStorage(deps.progressStorage);
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
      // 帧 load 后的恢复再驱动：进度会话（session-progress）内计数与续帧。
      sessionProgress.applyPendingWithRetry();
    },
    onUserScrollIntent: () => {
      if (sessionProgress.hasPendingRestore()) {
        sessionProgress.discardPending();
      }
    },
    renderHighlights: () => {
      bindFlowFrameLeftoverEscape();
      renderHighlights();
      syncBookmarkIndicators(); // 惰性挂载的章节窗口也要补书签角标
    },
    handleNoteMarkClick: (event) => {
      const annotation = annotationFromMark(event.target);
      if (annotation !== null && annotation.kind === 'note') {
        event.preventDefault();
        openNote(annotation);
        return true;
      }
      return false;
    },
    onFrameSurfaceClick: (event) => {
      sessionProgress.noteActivity(); // iframe 内点击不到 root 监听，经 hook 计入活动
      readerChrome?.handleSurfaceClick(event);
      syncChromeRevealAttr();
    },
    onSelectionMouseUp: (selection, chapter, body, frame) => {
      sessionProgress.noteActivity(); // iframe 内划选同为阅读活动信号
      onFlowSelectionMouseUp(selection, chapter, body, frame);
    },
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
    isSelectionToolbarVisible: () => selectionToolbar?.isVisible() === true,
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
  let lastScrollChapter = -1;
  const setActiveChapter = (index: number): void => {
    lastScrollChapter = index;
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
  /**
   * 版式切换门控：度量期间挡住帧 ResizeObserver。可重入——外层已持有时
   * 内层不得提前释放，成功或抛错都只由持有方清掉。
   */
  const holdLayoutSwitching = (work: () => void): void => {
    const held = layoutSwitching;
    layoutSwitching = true;
    try {
      work();
    } finally {
      if (!held) {
        layoutSwitching = false;
      }
    }
  };
  const remasureScrollFrames = (): void => {
    holdLayoutSwitching(() => {
      flowRenderer.remasureScrollFrames();
    });
  };
  /** 切回翻页：按当前可视宽度重算单栏步进后再让 paging enabled() 生效。 */
  const remasurePaginatedFrames = (options?: { restoreRatio?: number; snap?: boolean }): void => {
    holdLayoutSwitching(() => {
      stalePaginatedChapters = null;
      const frame = visibleFlowFrame();
      const doc = frame?.contentDocument;
      if (frame !== null && doc !== undefined && doc !== null) {
        applyPaginatedDocument(frame, doc, options);
      }
    });
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

  // —— 进度会话（session-progress）：身份链/保存时机/恢复重试裁决单点在核心，
  // 视图只按族供数（快照与落位的 DOM 机械 + 未就绪原因，无第二份会话规则）。 ——

  /** paged 族供数：页句柄快照与按页恢复（PDF/漫画）。 */
  const pagedProgressFeed: SessionProgressFeed = {
    snapshot: () => {
      const page = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
      if (page < 1) {
        return null;
      }
      const total = pdfHandle?.controller.totalPages ?? cbzHandle?.totalPages ?? 0;
      return stampReadingProgressTitle(
        {
          version: 2,
          kind: 'page',
          index: page,
          ratio: 0,
          ...(total > 0 ? { total } : {}),
          updatedAt: Date.now(),
        },
        readerOutline,
      );
    },
    apply: (saved) => {
      if (pdfHandle !== null) {
        pdfHandle.scrollToPage(saved.index);
        return { applied: true };
      }
      if (cbzHandle !== null) {
        cbzHandle.scrollToPage(saved.index);
        return { applied: true };
      }
      return { applied: false, pending: 'page-host' };
    },
  };

  /** flow 族供数：章节窗快照与翻页/滚动两种落位（未就绪只报原因，不裁决）。 */
  const flowProgressFeed: SessionProgressFeed = {
    snapshot: () => {
      const total = flowChapterCount;
      if (total === 0) {
        return null;
      }
      const chapterIndex = Math.max(0, readerState.current - 1);
      if (flowIsPaginated()) {
        const doc = visibleFlowFrame()?.contentDocument;
        const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
        return stampReadingProgressTitle(
          {
            version: 2,
            kind: 'flow',
            index: chapterIndex,
            ratio: scroller === null ? 0 : pagedProgressRatio(scroller),
            total,
            updatedAt: Date.now(),
          },
          readerOutline,
        );
      }
      const scroller = flowScrollContainer();
      const article = scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${chapterIndex}"]`,
      );
      const chapterHeight = article?.offsetHeight ?? 0;
      if (article === null || chapterHeight <= 0) {
        return null;
      }
      return stampReadingProgressTitle(
        {
          version: 2,
          kind: 'flow',
          index: chapterIndex,
          ratio: chapterScrollRatio(
            scroller.scrollTop,
            articleOffsetInScroller(article, scroller),
            chapterHeight,
          ),
          total,
          updatedAt: Date.now(),
        },
        readerOutline,
      );
    },
    apply: (saved, { attempts }) => {
      if (flowChapterCount === 0) {
        return { applied: false, pending: 'flow-content' };
      }
      const restoreIndex = clampFlowRestoreIndex(saved.index, flowChapterCount);
      if (flowIsPaginated()) {
        setActiveChapter(restoreIndex);
        const frame = scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${restoreIndex}"] .lightink-reader-chapter-frame`,
        );
        const frameReady = frame?.dataset.frameReady === 'true';
        const doc = frame?.contentDocument;
        const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
        if (!frameReady) {
          // OPDS chapters often load after the first paint. Clearing pendingRestore
          // here would leave the book at chapter 0 even though the iframe later
          // calls applyPendingRestore.
          return { applied: false, pending: 'flow-frame' };
        }
        if (scroller === null || scroller.clientWidth <= 1) {
          return { applied: false, pending: 'flow-frame-scroller' };
        }
        const step = pagedFrameStep(scroller);
        applyPagedProgress(scroller, saved.ratio, step);
        snapPagedScroller(scroller, step);
        return { applied: true };
      }
      setActiveChapter(restoreIndex);
      const scroller = flowScrollContainer();
      const article = scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${restoreIndex}"]`,
      );
      const measurable = article !== null && article.offsetHeight > 1;
      const scrollerReady = scroller.clientHeight > 1;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if ((!scrollerReady || !measurable) && attempts < FLOW_RESTORE_MAX_ATTEMPTS) {
        // 滚动恢复：等章节高度量出来再落点；过早按整本比例会停在开头。
        return { applied: false, pending: 'flow-measure' };
      }
      if (measurable && article !== null) {
        const targetTop = chapterScrollTop(
          articleOffsetInScroller(article, scroller),
          article.offsetHeight,
          saved.ratio,
        );
        if (targetTop > 0 && maxScroll <= 0 && attempts < FLOW_RESTORE_MAX_ATTEMPTS) {
          return { applied: false, pending: 'flow-scroll-range' };
        }
        scroller.scrollTop = Math.min(maxScroll, targetTop);
      } else if (maxScroll > 0) {
        scroller.scrollTop = Math.min(maxScroll, Math.round(saved.ratio * maxScroll));
      }
      // 滚动恢复成功后记录即最新已知位置（重排窗口按它恢复）。
      return { applied: true, rememberAsSnapshot: true };
    },
  };

  const sessionProgress = createReaderSessionProgress({
    storage: progressStorage,
    flow: flowProgressFeed,
    paged: pagedProgressFeed,
    activeKind: () =>
      pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt) ? 'paged' : 'flow',
    canPersistNow: () => readerState.phase === 'ready' || readerState.phase === 'loading',
    canRestoreNow: () => readerState.phase === 'ready',
    isDestroyed: () => destroyed,
    onProgressBound: deps.onProgressBound,
  });

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
    syncChromeProgress();
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

  /** 写队列策略唯一实现在 session-annotation（按当前身份串行写入，失败提示带会话守卫）。 */
  const saveAnnotations = async (): Promise<void> => {
    await sessionAnnotation.save(annotations);
  };

  /** 移除标注（侧栏/划选工具栏共用）：v3 删除产 tombstone（同步合并按记录级
   * LWW 收敛，防复活），更新集合、经共享引擎清正文 mark、刷新书签表面、保存。 */
  const removeAnnotationById = (id: string): void => {
    annotations = removeAnnotation(annotations, id);
    for (const doc of flowDocuments()) {
      removeAnnotationMarks(doc.body, id);
      paintAnnotationOverlays(doc);
    }
    for (const layer of pageHost.querySelectorAll('.lightink-reader-text-layer')) {
      removeAnnotationMarks(layer, id);
    }
    renderSidebarAnnotations();
    syncBookmarkIndicators();
    syncChromeBookmarkState();
    void saveAnnotations();
  };

  const setSelectionToolbarOpen = (open: boolean): void => {
    if (open) {
      root.dataset.selectionToolbar = 'open';
      return;
    }
    delete root.dataset.selectionToolbar;
  };

  const hideSelectionToolbar = (): void => {
    const pending = pendingSelection;
    pendingSelection = null;
    selectionToolbar?.hide();
    setSelectionToolbarOpen(false);
    if (pending?.frame !== null && pending?.frame !== undefined) {
      pending.frame.contentWindow?.getSelection()?.removeAllRanges();
    } else if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }
  };

  const keepCommittedSelection = (): boolean =>
    selectionToolbar?.isVisible() === true && pendingSelection !== null;

  const openNote = (annotation: Annotation): void => {
    if (annotation.kind !== 'note') {
      return;
    }
    void (async () => {
      const generation = sessionLoad.generation();
      const input = await showNoteDialog(
        document,
        annotation.note ?? '',
        { t, editing: true },
        annotation.quote,
      );
      if (input === null || destroyed || generation !== sessionLoad.generation()) {
        return;
      }
      annotations = updateAnnotationNote(annotations, annotation.id, input);
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
      onDismiss: () => hideSelectionToolbar(),
      onAction: (action, detail) => {
        const pending = pendingSelection;
        hideSelectionToolbar();
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
        if (action === 'note') {
          void (async () => {
            const generation = sessionLoad.generation();
            const input = await showNoteDialog(document, '', { t }, pending.quote);
            if (input === null) {
              return; // 取消：保留选区、不产生标注
            }
            if (destroyed || generation !== sessionLoad.generation()) {
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
    mountReaderOverlay(selectionToolbar.element, root);
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
      return { format: 'text', chapter, ...anchor };
    }
    return { format: 'flow', chapter, ...anchor };
  };

  // —— 书签一等开关（R1）：chrome 按钮/菜单/角标/进度轨刻度共用同一组事实判定。 ——

  /**
   * 状态位的活书签（chrome 按钮两态与菜单勾选的事实源）：按 readerState 判定
   *（页式按页码、流式按章），不读正文 DOM，滚动帧上调用也足够便宜。
   */
  const bookmarkAtStatePosition = (state: ReaderState): Annotation | null => {
    if (state.locationKind === 'page' && state.current > 0) {
      return (
        annotations.find(
          (annotation) =>
            annotation.kind === 'bookmark' &&
            annotation.deletedAt === undefined &&
            (annotation.locator.format === 'pdf' || annotation.locator.format === 'cbz') &&
            annotation.locator.page === state.current,
        ) ?? null
      );
    }
    if (state.locationKind === 'chapter' && state.current > 0) {
      const chapter = state.current - 1;
      return (
        annotations.find(
          (annotation) =>
            annotation.kind === 'bookmark' &&
            annotation.deletedAt === undefined &&
            (annotation.locator.format === 'flow' || annotation.locator.format === 'text') &&
            (annotation.locator.chapter ?? 0) === chapter,
        ) ?? null
      );
    }
    return null;
  };

  /** chrome 书签按钮两态 + 进度轨书签刻度随位置/集合刷新（setProgress 幂等）。 */
  const syncChromeBookmarkState = (): void => {
    readerChrome?.setBookmarked(bookmarkAtStatePosition(readerState) !== null);
    syncChromeProgress();
  };

  /** 书签开关：当前位置已有活书签则 tombstone 移除，否则在当前位置添加。 */
  const toggleBookmarkAtCurrentPosition = (): void => {
    if (!sessionAnnotation.enabled()) {
      return;
    }
    const existing = bookmarkAtStatePosition(readerState);
    if (existing !== null) {
      removeAnnotationById(existing.id);
      return;
    }
    appendAnnotation('bookmark', currentPositionLocator(), undefined, undefined);
  };

  /** 页内持久书签指示（R1）：有活书签的章/页在页角渲染丝带角标（装饰，不侵交互）。 */
  const BOOKMARK_BADGE_CLASS = 'lightink-reader-bookmark-ribbon';
  const syncBookmarkIndicators = (): void => {
    const chapters = new Set<number>();
    const pages = new Set<number>();
    for (const annotation of annotations) {
      if (annotation.kind !== 'bookmark' || annotation.deletedAt !== undefined) {
        continue;
      }
      const locator = annotation.locator;
      if (
        (locator.format === 'flow' || locator.format === 'text') &&
        locator.chapter !== undefined
      ) {
        chapters.add(locator.chapter);
      } else if (locator.format === 'pdf' || locator.format === 'cbz') {
        pages.add(locator.page);
      }
    }
    const syncBadge = (host: HTMLElement, on: boolean): void => {
      const existing = host.querySelector(`:scope > .${BOOKMARK_BADGE_CLASS}`);
      if (!on) {
        existing?.remove();
        return;
      }
      if (existing !== null) {
        return;
      }
      const badge = document.createElement('span');
      badge.className = BOOKMARK_BADGE_CLASS;
      badge.setAttribute('aria-hidden', 'true');
      badge.title = t('annotation.bookmarkBadge');
      host.appendChild(badge);
    };
    for (const article of scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      syncBadge(article, chapters.has(Number(article.dataset.chapterIndex)));
    }
    for (const slot of pageHost.querySelectorAll<HTMLElement>('.lightink-reader-page-slot')) {
      syncBadge(slot, pages.has(Number(slot.dataset.pageIndex) + 1));
    }
  };

  /** 书签刻度点击（chrome 回调）：按刻度 fraction 找回对应活书签并跳转。 */
  const jumpToBookmarkTick = (fraction: number): void => {
    const total = readerState.total;
    if (!Number.isSafeInteger(total) || total <= 1) {
      return;
    }
    const match = annotations.find((annotation) => {
      if (annotation.kind !== 'bookmark' || annotation.deletedAt !== undefined) {
        return false;
      }
      const locator = annotation.locator;
      const raw =
        locator.format === 'flow' || locator.format === 'text'
          ? (locator.chapter ?? -1) / total
          : locator.format === 'pdf' || locator.format === 'cbz'
            ? (locator.page - 1) / total
            : -1;
      if (raw < 0) {
        return false;
      }
      return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000 === fraction;
    });
    if (match !== undefined) {
      jumpToAnnotation(match);
    }
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
    const total = flowChapterCount;
    if (total === 0) {
      updateReaderState({ current: 0, total: 0, progress: 0, scale: 1, locationKind: null });
      return;
    }
    const current = Math.min(total, firstVisibleChapter() + 1);
    let progress = 0;
    if (flowIsPaginated()) {
      const doc = visibleFlowFrame()?.contentDocument;
      const scroller = doc === undefined || doc === null ? null : readerPagedScroller(doc);
      progress = flowBookProgress(
        current,
        total,
        scroller === null ? 0 : pagedProgressRatio(scroller),
      );
    } else {
      const scroller = flowScrollContainer();
      const article = scrollHost.querySelector<HTMLElement>(
        `.lightink-reader-chapter[data-chapter-index="${current - 1}"]`,
      );
      const chapterHeight = article?.offsetHeight ?? 0;
      const localRatio =
        article === null || chapterHeight <= 0
          ? 0
          : chapterScrollRatio(
              scroller.scrollTop,
              articleOffsetInScroller(article, scroller),
              chapterHeight,
            );
      progress = flowBookProgress(current, total, localRatio);
    }
    updateReaderState({ current, total, progress, scale: 1, locationKind: 'chapter' });
  };

  const notifyReaderWindowChrome = (): void => {
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('lightink:reader-theme'));
    }
  };

  const syncPageState = (): void => {
    const current = pdfHandle?.controller.page ?? cbzHandle?.currentPage ?? 0;
    const total = pdfHandle?.controller.totalPages ?? cbzHandle?.totalPages ?? 0;
    const scale = pdfHandle?.controller.scale ?? 1;
    const comicOpen = cbzHandle !== null;
    const wasComic = root.dataset.comicReader === 'true';
    if (comicOpen) {
      root.dataset.comicReader = 'true';
    } else {
      delete root.dataset.comicReader;
    }
    if (wasComic !== comicOpen) {
      notifyReaderWindowChrome();
    }
    updateReaderState({
      current,
      total,
      progress: total === 0 ? 0 : Math.min(1, Math.max(0, current / total)),
      scale,
      locationKind: total === 0 ? null : 'page',
      comicMetadata: cbzHandle?.metadata,
    });
    // 页 slot 懒栅格化/缩放重建后角标需要补画（幂等）。
    syncBookmarkIndicators();
  };

  const onFlowScroll = (): void => {
    if (sessionProgress.hasPendingRestore()) {
      sessionProgress.discardPending();
    }
    if (!flowIsPaginated()) {
      const index = chapterFromScroll();
      if (index !== lastScrollChapter) {
        lastScrollChapter = index;
        setActiveChapter(index);
      }
    }
    syncFlowState();
    sessionProgress.rememberSnapshot();
    sessionProgress.schedulePersist();
    readerChrome?.syncStayRevealed();
    syncChromeRevealAttr();
    pinSidebarOverlay();
    pinChromeDocks();
    // 工具栏按视口坐标固定定位，滚动后指向失效——直接隐藏。
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
    }
  };
  const onPageScroll = (): void => {
    syncPageState();
    sessionProgress.schedulePersist();
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
  // 阅读输入活动信号（进度 v2 空闲计时）：点击/指针/按键刷新 readingMs 计时窗口；
  // 滚动/翻页经 schedulePersist 已计入。监听器随 root 摘除，destroy 无需显式移除。
  const noteReadingActivity = (): void => {
    sessionProgress.noteActivity();
  };
  root.addEventListener('click', noteReadingActivity);
  root.addEventListener('pointerdown', noteReadingActivity);
  root.addEventListener('keydown', noteReadingActivity);
  // 分页滚轮提到窗口级（main.ts，与 Markdown R1 同源）：大纲/chrome/空白区
  // 悬停也翻正文。章节 iframe 内事件到不了宿主，仍由 flow-renderer 转发。

  /**
   * 对称作废合同（R7/T6 review 遗留的结构性保证）：每次内容换装（flow/paged
   * 两族 commit）与 destroy 经同一组摘除助手，作废页滚动监听、待执行的页滚动
   * 合并帧、待 settle 的缩放刷新/锚点恢复与流式惰性分栏标记。各换装点不再
   * 依赖调用处自觉摘除（session-load 管线经 adapter commit/destroy 调用）。
   */
  const invalidateSharedReadingSurface = (): void => {
    // R7：页格式 commit 在共享 pane 上挂的 schedulePageScroll 必须一并摘除——
    // 否则滚动 pane 仍触发 onPageScroll→syncPageState 把流式状态清零，且监听累积。
    pageHost.removeEventListener('scroll', schedulePageScroll);
    closestPane()?.removeEventListener('scroll', schedulePageScroll);
    pageHost.removeEventListener('mouseup', onPageHostSelection);
    pageHost.removeEventListener('contextmenu', onPageHostContextMenu);
    pageHost.removeEventListener('click', onPageHostNoteClick);
    textLayerObserver?.disconnect();
    textLayerObserver = null;
    pageScrollCoordinator?.cancel();
    cancelFontScaleRefresh?.();
    cancelFontScaleRefresh = null;
    stalePaginatedChapters = null;
  };


  /** 追加标注并同步正文高亮/侧栏/书签表面/持久化。 */
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
    syncBookmarkIndicators();
    syncChromeBookmarkState();
    void saveAnnotations();
  };

  /** 添加书签或笔记（笔记经多行弹层输入，取消不创建）。 */
  const addAnnotation = (kind: AnnotationKind): void => {
    if (kind === 'note') {
      void (async () => {
        const generation = sessionLoad.generation();
        const input = await showNoteDialog(document, '', { t });
        if (input === null) {
          return;
        }
        if (destroyed || generation !== sessionLoad.generation()) {
          return; // 弹层期间已切换文档/销毁：丢弃迟到保存
        }
        const pending = pendingSelection;
        if (pending !== null && pending.quote.trim() !== '') {
          pendingSelection = null;
          if (pending.frame !== null) {
            pending.frame.contentWindow?.getSelection()?.removeAllRanges();
          } else {
            window.getSelection()?.removeAllRanges();
          }
          appendAnnotation('note', pending.locator, pending.quote, input);
          return;
        }
        appendAnnotation('note', currentPositionLocator(), undefined, input);
      })();
      return;
    }
    appendAnnotation(kind, currentPositionLocator(), undefined, undefined);
  };

  /** 跳到标注位置（面板行跳转与进度轨书签刻度共用）：pdf/cbz 按页，flow/text 优先定位 mark。 */
  const jumpToAnnotation = (annotation: Annotation): void => {
    const loc = annotation.locator;
    if (loc.format === 'pdf' && pdfHandle !== null) {
      pdfHandle.scrollToPage(loc.page);
      syncPageState();
      pageHost
        .querySelector<HTMLElement>(`[data-annotation-id="${cssEscape(annotation.id)}"]`)
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
      loc.format === 'flow'
        ? loc.chapter
        : loc.format === 'text'
          ? loc.chapter
          : firstVisibleChapter();
    if (chapter !== undefined && flowIsPaginated()) {
      setActiveChapter(chapter);
    }
    const mark = Array.from(
      scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    )
      .map(
        (frame) =>
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
      const frames =
        chapter === undefined
          ? Array.from(
              scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
            )
          : [
              scrollHost.querySelector<HTMLIFrameElement>(
                `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
              ),
            ].filter((frame): frame is HTMLIFrameElement => frame !== null);
      for (const frame of frames) {
        const range =
          frame.contentDocument === null || frame.contentDocument === undefined
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
    }
    if (chapter !== undefined) {
      scrollHost
        .querySelector<HTMLElement>(`[data-chapter-index="${chapter}"]`)
        ?.scrollIntoView({ block: 'center' });
    }
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
    sidebarBackdrop.hidden = !sessionAnnotation.sidebarVisibility().shown;
    sidebarBackdrop.addEventListener('click', () => setSidebarVisible(false));
    sidebar = createAnnotationPanel({
      t,
      onClose: () => setSidebarVisible(false),
      // 漫画等位图格式无文本层：正文搜索固定为「不支持」空态（能力矩阵声明）。
      isDocumentSearchUnsupported: () => {
        if (loadedExt === '') {
          return false;
        }
        return sessionCapabilitiesForExtension(loadedExt)?.textSearch == null;
      },
      search: {
        onQuery: (nextQuery) => {
          if (nextQuery.trim() === '') {
            sessionSearch.clear();
            sidebar?.render(annotations);
            return;
          }
          sessionSearch.run(nextQuery);
        },
        onJump: (key) => sessionSearch.activateKey(key),
        onNext: () => sessionSearch.step(1),
        onPrev: () => sessionSearch.step(-1),
        onClear: () => {
          sessionSearch.clear();
          sidebar?.render(annotations);
        },
        onLoadMore: () => sessionSearch.loadMore(),
      },
      onJump: (annotation) => {
        jumpToAnnotation(annotation);
      },
      onRemove: (annotation) => {
        removeAnnotationById(annotation.id);
      },
      onEditNote: (annotation) => {
        openNote(annotation);
      },
    });
    const { visible, shown } = sessionAnnotation.sidebarVisibility();
    sidebar.element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    sidebar.element.hidden = !shown;
    root.append(sidebarBackdrop, sidebar.element);
    renderSidebarAnnotations();
  }

  function renderSidebarAnnotations(): void {
    // 搜索查询让位判定在 session-annotation 核心；DOM 渲染留视图。
    sessionAnnotation.syncSidebarList();
  }

  const pinSidebarOverlay = (): void => {
    if (sidebar === null || sidebar.element.hidden) {
      return;
    }
    if (readerChromeTouchMode()) {
      mountReaderOverlay(sidebar.element, root);
      pinFixedOverlay(sidebar.element, closestPane() ?? root);
      return;
    }
    if (flowIsPaginated()) {
      unpinFixedOverlay(sidebar.element);
      return;
    }
    pinFixedOverlay(sidebar.element, closestPane() ?? root);
  };

  function pinChromeDocks(): void {
    readerChrome?.pinDocks(closestPane() ?? root, flowIsPaginated());
  }

  function locationFallback(kind: 'chapter' | 'page', n: number): string {
    return kind === 'page'
      ? t('annotation.location.page', { page: String(n) })
      : t('reader.chapter', { n: String(n) });
  }

  function syncChromeProgress(): void {
    const kind = readerState.locationKind;
    const current = readerState.current;
    const total = readerState.total;
    const location =
      kind === 'page' && total > 0 && current > 0
        ? t('reader.progress.pageOf', { current: String(current), total: String(total) })
        : kind === 'chapter' && total > 0 && current > 0
          ? t('reader.progress.chapterOf', { current: String(current), total: String(total) })
          : formatReaderLocation(current, total);
    const ticks = readerProgressTickFractions(readerOutline, total, kind, annotations);
    readerChrome?.setProgress({
      chapterTitle: resolveReaderChapterTitle(readerState, readerOutline, locationFallback),
      location,
      progress: readerState.progress,
      ticks: ticks.chapters,
      bookmarkTicks: ticks.bookmarks,
    });
  }

  function goToProgress(progress: number): void {
    const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    if (pdfHandle !== null) {
      const total = pdfHandle.controller.totalPages;
      if (total > 0) {
        pdfHandle.scrollToPage(Math.max(1, Math.min(total, Math.round(clamped * total) || 1)));
        syncPageState();
        sessionProgress.schedulePersist();
      }
      return;
    }
    if (cbzHandle !== null) {
      if (cbzHandle.totalPages > 0) {
        cbzHandle.scrollToProgress(clamped);
        syncPageState();
        sessionProgress.schedulePersist();
      }
      return;
    }
    if (flowChapterCount === 0) {
      return;
    }
    const total = flowChapterCount;
    const pos = clamped * total;
    const chapterIndex = Math.min(total - 1, Math.max(0, Math.floor(pos)));
    sessionProgress.stage(
      stampReadingProgressTitle(
        {
          version: 2,
          kind: 'flow',
          index: chapterIndex,
          ratio: Math.min(1, Math.max(0, pos - chapterIndex)),
          total,
          updatedAt: Date.now(),
        },
        readerOutline,
      ),
    );
    sessionProgress.applyPendingWithRetry();
    syncFlowState();
    sessionProgress.schedulePersist();
  }

  /** 侧栏覆盖层（含 portal 到共享 chrome 的部分）与当前显隐状态同步。 */
  function syncSidebarOverlayDom(): void {
    const { visible, shown } = sessionAnnotation.sidebarVisibility();
    root.classList.toggle('lightink-reader--sidebar', visible);
    // chromeHost（#lightink-main）是所有标签共享的，只在侧栏真正显示时占类。
    chromeHost().classList.toggle('lightink-reader--sidebar', shown);
    closestPane()?.classList.toggle('lightink-reader--sidebar', visible);
    sidebar?.element.setAttribute('aria-hidden', shown ? 'false' : 'true');
    if (sidebar !== null) {
      sidebar.element.hidden = !shown;
      if (!shown) {
        unpinFixedOverlay(sidebar.element);
      }
    }
    if (sidebarBackdrop !== null) {
      sidebarBackdrop.hidden = !shown;
    }
    pinSidebarOverlay();
    pinChromeDocks();
  }

  /** 切换侧栏显隐（显隐策略唯一实现在 session-annotation 核心）。 */
  function setSidebarVisible(visible: boolean): void {
    sessionAnnotation.setSidebarVisible(visible);
  }

  const comicChromeVisible = (): boolean =>
    pageHost.dataset.comicReader === 'true' && pageHost.dataset.comicChrome !== 'hidden';

  // 本函数是 chromeRevealObserver/pageChromeObserver 的回调；这里的每次 DOM
  // 属性写都必须是"变化才写"，否则等值 setAttribute 触发新 mutation record，
  // 微任务队列永不排空，渲染主线程死循环卡死（打开漫画时曾整机冻结）。
  const syncChromeRevealAttr = (): void => {
    const chromeShown = readerChrome?.isRevealed() === true;
    if (readerChrome !== null) {
      const chromeEl = readerChrome.element;
      if (chromeEl.hidden === chromeShown) {
        chromeEl.hidden = !chromeShown;
      }
      const ariaHidden = chromeShown ? 'false' : 'true';
      if (chromeEl.getAttribute('aria-hidden') !== ariaHidden) {
        chromeEl.setAttribute('aria-hidden', ariaHidden);
      }
    }
    syncReaderTitlebarReveal(root, chromeShown || comicChromeVisible());
    syncChromeProgress();
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
      if (closed) return true;
    }
    if (cbzHandle?.hideChrome() === true) {
      return true;
    }
    if (selectionToolbar?.isVisible() === true) {
      hideSelectionToolbar();
      return true;
    }
    if (sessionAnnotation.sidebarVisibility().visible) {
      setSidebarVisible(false);
      return true;
    }
    return closeChromePanel();
  };

  /**
   * 标签可见性变化（切换标签时由宿主调用）。侧栏挂在阅读根上，仍要显式同步
   * hidden，避免切标签后操作非活动文档。标签可见状态与侧栏合成策略在
   * session-annotation 核心（只改 shown，不改偏好）；本壳只做覆盖层/搜索/面板收尾。
   */
  function setTabActive(active: boolean): void {
    if (!sessionAnnotation.setTabActive(active)) {
      return;
    }
    if (!active) {
      hideSelectionToolbar();
      closeChromePanel();
      readerChrome?.dismiss();
      syncChromeRevealAttr();
      return;
    }
    // 切回标签时未完成的恢复重新计数重试（无待恢复时为空操作）。
    sessionProgress.retryPending();
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
      if (hl.deletedAt !== undefined) {
        continue; // tombstone 不渲染（v3：删除是带时钟的记录，不是缺席）
      }
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
        sessionSearch.rerender(); // 层重建后搜索命中 overlay 一并恢复
      });
    });
    textLayerObserver.observe(host, { childList: true, subtree: true });
  };

  /** PDF 文本层选区（主文档 DOM，无 iframe 偏移）：捕获文字级定位并唤起工具栏。 */
  const onPageHostSelection = (): void => {
    if (pdfHandle === null) {
      return;
    }
    sessionProgress.noteActivity(); // 划选同为阅读活动信号（进度 v2 空闲计时）
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      if (!keepCommittedSelection()) {
        hideSelectionToolbar();
      }
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
    selectionToolbar?.showAt(selectionClientRect(range), {
      canRemoveHighlight: existingMark !== null,
    });
    setSelectionToolbarOpen(true);
  };

  const onPageHostContextMenu = (event: Event): void => {
    if (pdfHandle === null) {
      return;
    }
    const text = typeof window !== 'undefined' ? (window.getSelection()?.toString().trim() ?? '') : '';
    if (text.length > 0) {
      event.preventDefault();
    }
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

  /** 切换文档：清搜索会话与命中 overlay，并复位侧栏搜索框（查询不跨书残留）。 */
  const resetReaderSearch = (): void => {
    sessionSearch.clear();
    sidebar?.setSearchQuery('');
    sidebar?.render(annotations);
  };

  const chapterFrame = (index: number): HTMLIFrameElement | null =>
    scrollHost.querySelector<HTMLIFrameElement>(
      `.lightink-reader-chapter[data-chapter-index="${String(index)}"] .lightink-reader-chapter-frame`,
    );

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

  /** 命中表面同步：统一面板（桌面侧栏/触屏 sheet 同一实例）消费会话的 hitViews/hitsState。 */
  const syncSearchHits = (): void => {
    if (sidebar === null) {
      return;
    }
    const query = sidebar.getSearchQuery().trim();
    if (query === '') {
      sidebar.render(annotations);
      return;
    }
    sidebar.renderHits(sessionSearch.hitViews(), sessionSearch.hitsState());
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

  /**
   * 打开搜索（双端收敛为同一面板）：打开统一融合面板并聚焦查询框——桌面为
   * 侧栏形态、触屏经 pinSidebarOverlay 呈 is-touch-sheet 底栏形态；查询词
   * 非空即检索（PDF / 流式；漫画无文本层则面板显示不支持空态）。
   */
  const openSearch = (query?: string): void => {
    const scroller = flowScrollContainer();
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    setSidebarVisible(true);
    const seed = sanitizeSearchQuery(query) || currentSearchSelection();
    if (seed !== '') {
      sidebar?.setSearchQuery(seed);
      sessionSearch.run(seed);
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
    const unchaptered: AnnotationMarkSpec[] = [];
    for (const hl of annotations) {
      if (hl.deletedAt !== undefined) {
        continue; // tombstone 不渲染（v3：删除是带时钟的记录，不是缺席）
      }
      if ((hl.kind !== 'highlight' && hl.kind !== 'note') || hl.quote === undefined) {
        continue;
      }
      const locator = hl.locator;
      if (locator.format !== 'flow' && locator.format !== 'text') {
        continue;
      }
      const spec: AnnotationMarkSpec = annotationMarkSpec(hl, locator);
      const chapter = locator.format === 'flow' ? locator.chapter : locator.chapter;
      if (chapter === undefined) {
        unchaptered.push(spec);
        continue;
      }
      const list = byChapter.get(chapter);
      if (list === undefined) {
        byChapter.set(chapter, [spec]);
      } else {
        list.push(spec);
      }
    }
    const paintFrame = (doc: Document, specs: readonly AnnotationMarkSpec[]): void => {
      renderAnnotationMarks(doc.body, specs);
      paintAnnotationOverlays(doc);
    };
    for (const [chapter, specs] of byChapter) {
      const frame = scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
      );
      const doc = frame?.contentDocument;
      if (doc === null || doc === undefined) {
        continue;
      }
      paintFrame(doc, specs);
    }
    if (unchaptered.length > 0) {
      for (const frame of scrollHost.querySelectorAll<HTMLIFrameElement>(
        '.lightink-reader-chapter-frame',
      )) {
        const doc = frame.contentDocument;
        if (doc === null || doc.body === null) {
          continue;
        }
        paintFrame(doc, unchaptered);
      }
    }
  };

  /**
   * 划选确认（flow/txt，iframe 内）：桌面 mouseup 与触屏 selectionchange/touchend
   * 稳定后共用同一入口。捕获待确认划选并唤起既有工具栏，不新造 UI。
   */
  const onFlowSelectionMouseUp = (
    selection: Selection | null,
    chapter: number,
    body: HTMLElement,
    frame: HTMLIFrameElement,
  ): void => {
    const text = selection?.toString().trim() ?? '';
    if (selection === null || selection.rangeCount === 0 || text.length === 0) {
      // Keep the committed quote while the host toolbar is up. Clicking a
      // parent overlay blurs the iframe and collapses the live selection
      // (Kindle / Apple Books / epub.js snapshot the range on toolbar show).
      if (!keepCommittedSelection()) {
        hideSelectionToolbar();
      }
      return;
    }
    const locator = flowLocatorFromSelection(
      body,
      selection,
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
    // 分栏里 bounding rect 会横跨左右页，改用最后一行盒子锚定工具栏。
    selectionToolbar.showAt(
      mapFrameClientRect(frame, selectionClientRect(selection.getRangeAt(0))),
      { canRemoveHighlight: existingMark !== null },
    );
    setSelectionToolbarOpen(true);
  };

  /**
   * 流式渲染入口（T5 拆分）：页宿主接线拆除后委托 flow-renderer 创建章节
   * iframe 与帧内生命周期；编排壳只保留宿主切换、活动章与状态同步。页宿主
   * 监听/pending 帧/缩放 settle 的作废由会话管线的对称作废合同先行完成。
   */
  const renderChapters = (chapters: ReaderChapter[], stylesheet = ''): void => {
    scrollHost.hidden = false;
    pageHost.hidden = true;
    const leavingComic =
      pageHost.dataset.comicReader === 'true' || root.dataset.comicReader === 'true';
    delete pageHost.dataset.readerActive;
    if (leavingComic) {
      clearComicHostDataset(pageHost);
      delete root.dataset.comicReader;
      pageHost.replaceChildren();
      syncChromeRevealAttr();
      notifyReaderWindowChrome();
    }
    flowChapterCount = chapters.length; // 新文档：帧 load 时各自应用分栏，无待补章
    flowRenderer.render(chapters, stylesheet);
    setActiveChapter(0);
    syncFlowState();
  };

  /** paged 族宿主：漫画归档渲染进离屏宿主（i18n 标签与视图回调闭包）。 */
  const renderComicStaged = (
    archiveSource: ComicArchiveInput,
    stagedHost: HTMLDivElement,
    signal: AbortSignal,
    target: ReaderTarget,
  ): Promise<CbzRenderHandle> => {
    const extraComicLabels = comicLocaleLabels(t);
    return renderCbzInto(archiveSource, stagedHost, signal, {
      preferenceStorage,
      progressId: comicProgressIdForTarget(target),
      requestPassword: deps.requestArchivePassword,
      labels: {
        backToShelf: t('reader.comic.backToShelf'),
        previous: t('reader.comic.previous'),
        next: t('reader.comic.next'),
        vertical: t('reader.comic.vertical'),
        strip: extraComicLabels.strip,
        paged: t('reader.comic.paged'),
        leftToRight: t('reader.comic.ltr'),
        rightToLeft: t('reader.comic.rtl'),
        singlePage: t('reader.comic.single'),
        doublePage: t('reader.comic.double'),
        autoPage: extraComicLabels.autoPage,
        fitWidth: t('reader.comic.fitWidth'),
        fitScreen: extraComicLabels.fitScreen,
        fitHeight: extraComicLabels.fitHeight,
        fitOriginal: extraComicLabels.fitOriginal,
        cropMargins: t('reader.comic.cropMargins'),
        keepMargins: t('reader.comic.keepMargins'),
        margins: t('reader.comic.margins'),
        pageSlider: t('reader.comic.pageSlider'),
        toggleChrome: t('reader.comic.toggleChrome'),
        imageDecodeFailed: t('reader.comic.imageDecodeFailed'),
        retry: t('reader.comic.retry'),
      },
      onReturnToShelf: returnToShelf,
      onPageChange: () => {
        if (cbzHandle !== null) {
          syncPageState();
          sessionProgress.schedulePersist();
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
          loadTrack.hidden = false;
          statusLabel.textContent = t('reader.archive.sequentialProgress', {
            current: String(progress.currentEntry + 1),
            target: String(progress.targetEntry + 1),
          });
        } else if (readerState.phase === 'ready') {
          status.hidden = true;
          loadTrack.hidden = true;
        }
      },
    }).then((cbz) => {
      queueMicrotask(() => {
        void Promise.resolve(deps.onComicMetadata?.(target, cbz.metadata)).catch(() => undefined);
      });
      return cbz;
    });
  };

  /**
   * paged 族 commit 主体：staged 页宿主换入 live 视图。旧表面的摘除已由管线
   * 作废上一会话（同一组对称作废助手）先行完成；旧句柄释放同样在上一会话的
   * invalidate 里，此处只做换装与监听重挂。
   */
  const commitPagedStaged = (staged: {
    host: HTMLDivElement;
    pdf: PdfRenderHandle | null;
    cbz: CbzRenderHandle | null;
  }): void => {
    invalidateSharedReadingSurface();
    clearFlowBindings();
    flowChapterCount = 0;
    pdfHandle = staged.pdf;
    cbzHandle = staged.cbz;
    pageHost.replaceWith(staged.host);
    pageHost = staged.host;
    watchPageChrome();
    if (staged.cbz !== null) {
      closeChromePanel();
      readerChrome?.dismiss();
    }
    syncChromeRevealAttr();
    pageHost.addEventListener('scroll', schedulePageScroll, { passive: true });
    closestPane()?.addEventListener('scroll', schedulePageScroll, { passive: true });
    pageHost.addEventListener('mouseup', onPageHostSelection);
    pageHost.addEventListener('contextmenu', onPageHostContextMenu);
    pageHost.addEventListener('click', onPageHostNoteClick);
    observeTextLayers(pageHost); // 文本层懒出现时重渲染该页高亮
    scrollHost.hidden = true;
    syncPageState();
  };

  /** 会话管线标注装载钩子：启用判定/身份解析/读取/解析唯一实现在 session-annotation。 */
  const loadAnnotationsForSession = async (
    target: ReaderTarget,
    context: { signal: AbortSignal; isCurrent: () => boolean },
  ): Promise<void> => {
    const nextAnnotations = await sessionAnnotation.load(loadedExt, target, context);
    if (nextAnnotations === null) {
      return; // 未启用/过期（销毁/取消/世代失配）：不改状态（beforeCommit 已复位视图集合）
    }
    annotations = nextAnnotations;
    renderHighlights(); // flow/txt 正文与 PDF 文本层（含旧 anchor 数据重渲染）
    syncBookmarkIndicators(); // 页内书签角标随装载落位
    syncChromeBookmarkState();
    ensureSidebar();
  };

  const gatePagedWheel = createPagedWheelGate();

  /**
   * 导航会话（session-navigation）：advanceReading 三支与大纲跳转收敛为按
   * adapter kind 的单一策略表（paged/flow 两行，paged 行内 pdf/漫画成员由
   * 供数区分），返回值合同、rtl 翻转、动效/保存时机与载荷 no-op 唯一实现
   * 在 session 模块；本壳只供族内机械（句柄步进/滚页、flow 分栏/视口步进、
   * 章节对齐与状态同步）。
   */
  const sessionNavigation = createReaderSessionNavigation({
    // 原三支分支序冻结：页句柄存活 → paged（成员按句柄），否则 flow 兜底
    // （加载窗口无句柄时与原口径一致：flow 空内容步进 false、跳转同机械）。
    activeKind: () => (pdfHandle !== null || cbzHandle !== null ? 'paged' : 'flow'),
    pagedMember: () => (pdfHandle !== null ? 'pdf' : cbzHandle !== null ? 'comic' : null),
    pagedComicReadsRightToLeft: () => cbzHandle?.preferences.direction === 'rtl',
    pagedCurrentPage: () => pdfHandle?.controller.page ?? 1,
    pagedScrollToPage: (page) => {
      const pdf = pdfHandle;
      if (pdf !== null) {
        pdf.scrollToPage(page);
        return;
      }
      cbzHandle?.scrollToPage(page);
    },
    pagedComicStep: (delta) => {
      const handle = cbzHandle;
      if (handle === null) {
        return;
      }
      if (delta > 0) handle.nextPage();
      else handle.previousPage();
    },
    syncPagedState: () => syncPageState(),
    flowIsPaginated: () => flowIsPaginated(),
    flowAdvancePaged: (direction) => flowRenderer.advancePage(direction),
    flowAdvanceScrolled: (direction) => {
      if (sessionProgress.hasPendingRestore()) {
        sessionProgress.discardPending();
      }
      return advanceScrolledScroller(flowScrollContainer(), direction);
    },
    flowJumpToChapter: (chapter) => {
      setActiveChapter(chapter);
      if (flowIsPaginated()) {
        const frame = scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${chapter}"] .lightink-reader-chapter-frame`,
        );
        const doc = frame?.contentDocument;
        if (doc !== undefined && doc !== null) {
          readerPagedScroller(doc).scrollLeft = 0;
        }
      } else {
        scrollHost
          .querySelector<HTMLElement>(
            `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
          )
          ?.scrollIntoView({ block: 'start' });
      }
    },
    syncFlowState: () => syncFlowState(),
    discardPendingRestore: () => sessionProgress.discardPending(),
    persistProgress: () => sessionProgress.schedulePersist(),
    playPageTurn: (direction) => playReaderPageTurn(root, direction),
    hideSelectionToolbar: () => hideSelectionToolbar(),
  });
  const advanceReading = (direction: 1 | -1, navKey?: string): boolean =>
    sessionNavigation.advance(direction, navKey);
  const jumpToOutlineItem = (item: OutlineItem): void =>
    sessionNavigation.jumpToOutlineItem(item);

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
        sessionProgress.schedulePersist();
      });
    }
    syncFlowState();
    sessionProgress.schedulePersist();
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
    syncOpenOverlayThemes();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:theme-change', onThemeChange);
  }

  const refreshOpenSearch = (): void => {
    if (!sessionAnnotation.tabActive()) {
      return;
    }
    if (!sessionAnnotation.sidebarVisibility().visible || sidebar === null) {
      return;
    }
    const query = (sidebar.getSearchQuery() || sessionSearch.query() || '').trim();
    if (query === '') {
      return;
    }
    sessionSearch.run(query, { preserveActive: sessionSearch.activeIndex() });
  };

  const syncPaginatedChapter = (): void => {
    if (destroyed || pdfHandle !== null || cbzHandle !== null || PAGE_EXTS.has(loadedExt)) {
      return;
    }
    stalePaginatedChapters = null; // 布局切换重测/重分栏全部帧，作废缩放惰性标记
    const saved = sessionProgress.captureForRelayout();
    sessionProgress.persistSnapshot(saved);
    if (!flowIsPaginated()) {
      remasureScrollFrames();
      if (saved !== null) {
        sessionProgress.stage(saved);
        sessionProgress.applyPending();
      }
      requestAnimationFrame(refreshOpenSearch);
      return;
    }
    if (saved !== null) {
      sessionProgress.stage(saved);
    }
    setActiveChapter(saved?.index ?? chapterFromScroll());
    remasurePaginatedFrames(saved === null ? undefined : { restoreRatio: saved.ratio });
    if (sessionProgress.hasPendingRestore()) {
      sessionProgress.applyPending();
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
    // 未加载文档时没有可重排的内容（也避免骨架/空宿主上的无效重排）。
    if (readerState.phase !== 'ready') {
      return;
    }
    // 排版/版式变化会触发重排（分栏或重测高），先快照当前位置，重排后恢复，
    // 与 syncPaginatedChapter 的缩放路径同一机制，避免跳回书的开头。
    const saved = sessionProgress.captureForRelayout();
    if (flowIsPaginated()) {
      remasurePaginatedFrames();
    } else {
      remasureScrollFrames();
    }
    refreshOpenSearch();
    syncFlowState();
    if (saved !== null) {
      sessionProgress.stage(saved);
      sessionProgress.applyPendingWithRetry();
    }
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
    sessionProgress.persistNow();
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
    try {
      holdLayoutSwitching(() => {
        // 先写 data-reading-layout：scroll 时 bindTouchPaging/bindClickPaging
        // 的 enabled()（仅 paginated）立刻为假，点翻失效且不吞纵向滑动。
        applyReaderLayout(root, next);
        if (typeof document !== 'undefined') {
          applyReaderDocumentLayout(document.documentElement, 'reader', next);
        }
        dispatchReaderFlowLayoutPref(next);
        if (next === 'scroll') {
          flowRenderer.remasureScrollFrames();
        } else {
          remasurePaginatedFrames();
        }
      });
    } finally {
      refreshViewport();
      renderTypographyPanel();
      readerChrome?.syncStayRevealed();
      syncChromeRevealAttr();
    }
  };

  const syncOpenOverlayThemes = (): void => {
    adoptReaderOverlayTheme(typePanel, root);
    adoptReaderOverlayTheme(tocPanel, root);
    if (sidebar !== null) {
      adoptReaderOverlayTheme(sidebar.element, root);
    }
    if (selectionToolbar !== null) {
      adoptReaderOverlayTheme(selectionToolbar.element, root);
    }
  };

  const applyPaperTheme = (theme: ReaderThemeId): void => {
    const next = saveReaderTheme(preferenceStorage, theme);
    applyReaderTheme(root, next);
    const pane = closestPane();
    if (pane !== null) {
      applyReaderTheme(pane, next);
    }
    flowRenderer.syncTheme();
    syncOpenOverlayThemes();
    notifyReaderWindowChrome();
    renderTypographyPanel();
  };

  const readerPanelCopy = (): ReaderChromePanelCopy => {
    const extraComicLabels = comicLocaleLabels(t);
    return {
    tocTitle: t('reader.toc.title'),
    tocEmpty: t('outline.empty'),
    tocSearch: t('outline.search'),
    tocEmptySearch: t('outline.emptySearch'),
    tocSearchCount: t('outline.searchCount'),
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
    comic: {
      direction: t('reader.comic.direction'),
      spread: t('reader.comic.spread'),
      vertical: t('reader.comic.vertical'),
      strip: extraComicLabels.strip,
      paged: t('reader.comic.paged'),
      leftToRight: t('reader.comic.ltr'),
      rightToLeft: t('reader.comic.rtl'),
      singlePage: t('reader.comic.single'),
      doublePage: t('reader.comic.double'),
      fit: extraComicLabels.fit,
      fitWidth: t('reader.comic.fitWidth'),
      fitScreen: extraComicLabels.fitScreen,
      fitHeight: extraComicLabels.fitHeight,
      fitOriginal: extraComicLabels.fitOriginal,
      cropMargins: t('reader.comic.cropMargins'),
      keepMargins: t('reader.comic.keepMargins'),
      margins: t('reader.comic.margins'),
    },
  };
  };

  const renderTocPanel = (): void => {
    const current = outlineLocationFromReader(readerState);
    fillReaderTocPanel(
      tocPanel,
      readerOutline,
      readerPanelCopy(),
      current,
      (item) => {
        jumpToOutlineItem(item);
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
    if (pdfHandle !== null || loadedExt === 'pdf') {
      return 'pdf';
    }
    if (cbzHandle !== null || (PAGE_EXTS.has(loadedExt) && loadedExt !== 'pdf')) {
      return 'comic';
    }
    return 'flow';
  };

  /** Map the comic sheet onto the live cbz handle; no new preference keys. */
  const comicTypographyControls = (): ReaderTypographyComicControls | null => {
    const handle = cbzHandle;
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
      readerFormatKind(),
      comicTypographyControls(),
    );
  };

  const openChromePanel = (next: 'toc' | 'typography'): void => {
    if (chromePanel === next) {
      closeChromePanel();
      return;
    }
    if (sessionAnnotation.sidebarVisibility().visible) {
      setSidebarVisible(false);
    }
    chromePanel = next;
    tocPanel.hidden = next !== 'toc';
    typePanel.hidden = next !== 'typography';
    const panel = next === 'toc' ? tocPanel : typePanel;
    const action = next === 'toc' ? 'toc' : 'typography';
    mountReaderOverlay(panel, root);
    positionReaderChromePanel(
      panel,
      root,
      root.querySelector(`[data-reader-chrome-action="${action}"]`),
    );
    if (next === 'toc') {
      renderTocPanel();
      activateReaderTocPanel(tocPanel);
    } else {
      renderTypographyPanel();
    }
    syncChromeActionState();
  };

  if (canMountReaderChrome()) {
    readerChrome = createReaderChrome(root, {
      touchMode: readerChromeTouchMode(),
      labels: {
        bookmark: t('reader.chrome.bookmark'),
        bookmarkTick: t('reader.chrome.bookmarkTick'),
      },
      returnToShelf,
      openOutline: () => openChromePanel('toc'),
      openTypography: () => openChromePanel('typography'),
      openSearch: () => openSearch(),
      toggleBookmark: () => toggleBookmarkAtCurrentPosition(),
      isBookmarked: () => bookmarkAtStatePosition(readerState) !== null,
      onBookmarkTick: (fraction) => jumpToBookmarkTick(fraction),
      toggleSidebar: () => setSidebarVisible(!sessionAnnotation.sidebarVisibility().visible),
      isOverlayOpen: () =>
        sessionAnnotation.sidebarVisibility().visible ||
        chromePanel !== null,
      // 一次退一层：TOC/排版 → 标注面板。点空白走同一条链。
      dismissOverlay: () => {
        if (closeChromePanel()) {
          return true;
        }
        if (sessionAnnotation.sidebarVisibility().visible) {
          setSidebarVisible(false);
          return true;
        }
        return false;
      },
      isSidebarVisible: () => sessionAnnotation.sidebarVisibility().visible,
      isSelectionToolbarVisible: () => selectionToolbar?.isVisible() === true,
      hideSelectionToolbar,
      stayRevealed: () =>
        cbzHandle === null && !flowIsPaginated() && flowScrollContainer().scrollTop <= 16,
      suppressProgressDock: () =>
        pageHost.dataset.comicReader === 'true' || root.dataset.comicReader === 'true',
      onSeekProgress: goToProgress,
    });
    syncChromeProgress();
    pinChromeDocks();
    root.append(tocPanel, typePanel);
    root.addEventListener('click', syncChromeRevealAttr);
    root.addEventListener('pointermove', syncChromeRevealAttr);
    readerChrome.syncStayRevealed();
    watchPageChrome();
    syncChromeRevealAttr();
    syncChromeActionState();
    if (typeof MutationObserver === 'function') {
      chromeRevealObserver = new MutationObserver(syncChromeRevealAttr);
      try {
        chromeRevealObserver.observe(readerChrome.element, {
          attributes: true,
          attributeFilter: ['data-reader-chrome-revealed', 'data-revealed', 'class'],
        });
      } catch {
        chromeRevealObserver = null;
      }
    }
  }

  // —— 会话核心接线（R1/R2）：两族 adapter 只做本族 stage/commit/收尾，
  // 世代取代、取消合成、对称作废与远程源单次接管全在 session-load 管线。 ——

  /** staged 附加面：族内 commit/afterCommit 所需载荷（管线只见 StagedSession）。 */
  interface FlowStagedLocal extends StagedSession {
    readonly kind: 'flow';
    readonly ext: string;
    readonly content: ReaderContent;
  }

  /** staged 附加面：离屏页宿主与渲染句柄（afterCommit 拉大纲/早绑定用）。 */
  interface PagedStagedLocal extends StagedSession {
    readonly kind: 'paged';
    readonly ext: string;
    readonly host: HTMLDivElement;
    readonly pdf: PdfRenderHandle | null;
    readonly cbz: CbzRenderHandle | null;
  }

  /** 恰一次作废句柄（幂等守卫）：释放本会话独占资源。 */
  const onceSessionInvalidation = (
    release: () => void | Promise<void>,
  ): SessionInvalidation => {
    let done = false;
    return {
      invalidate: () => {
        if (done) {
          return;
        }
        done = true;
        return release();
      },
    };
  };

  /** flow commit 主体：对称作废先行 → 章节渲染 + 导出面/大纲采纳；失败回滚。 */
  const commitFlowStaged = (content: ReaderContent): void => {
    const previousFlowChapterCount = flowChapterCount;
    pdfHandle = null;
    cbzHandle = null;
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
      content.dispose?.();
      flowChapterCount = previousFlowChapterCount;
      throw error;
    }
  };

  const flowSessionAdapter: ReaderSessionAdapter = {
    kind: 'flow',
    async stage(request, context) {
      const { target, ext, formatPath } = request;
      const signal = context.signal;
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      // TXT 分块顺序读；EPUB 通过带 read-ahead 的 ZIP 随机源读取，避免先把
      // 整本书跨 IPC 复制进 WebView。依赖缺失时保留整读回退供测试/浏览器使用。
      const readChunk =
        target.kind === 'local' && (ext === 'txt' || ext === 'epub')
          ? deps.readChunk
          : undefined;
      const localEpubSource: RandomAccessSource | null =
        target.kind === 'local' &&
        ext === 'epub' &&
        readChunk !== undefined &&
        deps.readSize !== undefined
          ? createLocalFileSource({
              size: await deps.readSize(filePath, signal),
              identity: target.identity,
              readRange: (offset, length, readSignal) =>
                readChunk(filePath, offset, length, readSignal ?? signal),
            })
          : null;
      const remoteSource = context.remote.source;
      const source: ReaderInputSource =
        remoteSource !== null
          ? remoteSource
          : localEpubSource !== null
            ? localEpubSource
            : readChunk === undefined
              ? await deps.readBytes!(filePath, signal)
              : {
                  read: (offset, length, readSignal) =>
                    readChunk(filePath, offset, length, readSignal ?? signal),
                };
      // yield 点取消检查：取源期间被取代/取消的加载不得进入解析。
      throwIfReaderLoadCancelled(signal);
      const content = await (deps.parseContent ?? parseReaderContent)(
        formatPath,
        source,
        signal,
      );
      const ownedRemote = context.remote.source;
      if (ownedRemote !== null) {
        // 远程源所有权折进 content.dispose：换装/销毁时随会话单次关闭。
        const disposeContent = content.dispose;
        content.dispose = () => {
          disposeContent?.();
          void ownedRemote.close().catch(() => undefined);
        };
        context.remote.release();
      }
      const staged: FlowStagedLocal = {
        kind: 'flow',
        ext,
        content,
        commit: () => {
          invalidateSharedReadingSurface();
          commitFlowStaged(content);
          return onceSessionInvalidation(() => {
            content.dispose?.();
          });
        },
        discard: () => {
          content.dispose?.();
        },
      };
      return staged;
    },
    afterCommit(staged) {
      if (staged.kind !== 'flow') {
        return;
      }
      // 解析 warning（如 epub 样式被丢弃）在就绪前一次性提示。
      for (const warning of (staged as FlowStagedLocal).content.warnings ?? []) {
        deps.notify?.(t(`reader.warning.${warning}`));
      }
    },
  };

  const pagedSessionAdapter: ReaderSessionAdapter = {
    kind: 'paged',
    async stage(request, context) {
      const { target, ext, nativeArchive } = request;
      const signal = context.signal;
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      if (ext !== 'pdf' && ext !== 'cbz' && !NATIVE_ARCHIVE_EXTENSIONS.has(ext)) {
        throw new ParseError(`暂不支持的页格式：.${ext || '?'}`);
      }
      const stagedHost = createPageHost();
      stagedHost.hidden = false;
      stagedHost.dataset.readerActive = 'true';
      // 本地 pdf/cbz 走有界随机读（不整本跨 IPC 拷贝）；native 归档 stage 内
      // 开 provider；远程源由管线代开并经 lease 移交渲染器。
      const localPageSource =
        target.kind === 'local' &&
        !nativeArchive &&
        deps.readChunk !== undefined &&
        deps.readSize !== undefined
          ? createLocalFileSource({
              size: await deps.readSize(filePath, signal),
              identity: target.identity,
              readRange: (offset, length, readSignal) =>
                deps.readChunk!(filePath, offset, length, readSignal ?? signal),
            })
          : null;
      const pageSource = nativeArchive
        ? null
        : target.kind === 'remote'
          ? context.remote.source
          : localPageSource ?? (await deps.readBytes!(filePath, signal));
      throwIfReaderLoadCancelled(signal);
      if (ext === 'pdf') {
        if (pageSource === null) throw new ParseError('PDF 字节源不可用');
        stagedHost.dataset.readerFormat = 'pdf';
        const pdf = await renderPdfInto(pageSource, stagedHost, signal);
        // 页渲染器接管字节源（随句柄 destroy 关闭）。
        if (context.remote.source !== null) {
          context.remote.release();
        }
        const staged: PagedStagedLocal = {
          kind: 'paged',
          ext,
          host: stagedHost,
          pdf,
          cbz: null,
          commit: () => {
            commitPagedStaged({ host: stagedHost, pdf, cbz: null });
            return onceSessionInvalidation(async () => {
              await pdf.destroy().catch(() => undefined);
            });
          },
          discard: async () => {
            await pdf.destroy().catch(() => undefined);
          },
        };
        return staged;
      }
      stagedHost.dataset.readerFormat = ext;
      const archiveSource = nativeArchive
        ? await (deps.openArchiveProvider?.(target, signal) ??
          openNativeArchive(target, {
            signal,
            requestPassword: deps.requestArchivePassword,
          }))
        : pageSource;
      if (archiveSource === null) throw new ParseError('漫画归档字节源不可用');
      const cbz = await renderComicStaged(archiveSource, stagedHost, signal, target);
      if (context.remote.source !== null) {
        context.remote.release();
      }
      const staged: PagedStagedLocal = {
        kind: 'paged',
        ext,
        host: stagedHost,
        pdf: null,
        cbz,
        commit: () => {
          commitPagedStaged({ host: stagedHost, pdf: null, cbz });
          return onceSessionInvalidation(async () => {
            await cbz.destroy().catch(() => undefined);
          });
        },
        discard: async () => {
          await cbz.destroy().catch(() => undefined);
        },
      };
      return staged;
    },
    async afterCommit(staged, request, context) {
      if (staged.kind !== 'paged') {
        return;
      }
      const { pdf, cbz, ext } = staged as PagedStagedLocal;
      const outline =
        pdf !== null
          ? await pdf.outline()
          : outlineFromEntries(
              Array.from({ length: cbz?.totalPages ?? 0 }, (_, index) => ({
                title: t('annotation.location.page', { page: String(index + 1) }),
              })),
              'page',
            );
      if (!context.isCurrent()) {
        return;
      }
      readerOutline = outline;
      if (sessionMemberForExtension(ext) === 'comic') {
        // 漫画进度提前绑定：页格式在标注装载前按页恢复（不哈希归档）。
        sessionProgress.bindComicIdentity(request.target);
        sessionProgress.applyPendingWithRetry();
      }
    },
  };

  /** 管线 settle 尾巴：标注装载 → 进度身份链/恢复 → ready 发布与状态同步。 */
  const settleSession = async (
    request: SessionOpenRequest,
    context: SessionRunContext,
  ): Promise<void> => {
    const target = request.target;
    await loadAnnotationsForSession(target, {
      signal: context.signal,
      isCurrent: context.isCurrent,
    });
    // 标注装载窗口内调用方取消：按取消口径发布 cancelled（原管线语义），
    // 不停留在 loading。
    throwIfReaderLoadCancelled(context.signal);
    if (!context.isCurrent()) {
      return;
    }
    // 身份链绑定（含旧键迁移回填）→ ready 发布 → 恢复落点 → 状态同步 →
    // 书库绑定通知；全部经 session-progress 单点裁决。
    sessionProgress.bindDocumentIdentity(target, sessionAnnotation.contentHash());
    setReaderPhase('ready');
    sessionProgress.applyPendingWithRetry();
    if (PAGE_EXTS.has(loadedExt)) {
      syncPageState();
    } else {
      syncFlowState();
    }
    sessionProgress.notifyProgressBound(target);
  };

  const sessionLoad = createReaderSessionLoad({
    flow: flowSessionAdapter,
    paged: pagedSessionAdapter,
    host: {
      beginOpen: () => {
        sessionAnnotation.invalidateWrites();
        hideSelectionToolbar();
        sessionProgress.beginSession();
        readerOutline = [];
        exportChapters = [];
        exportStylesheet = '';
        exportEmbedImages = null;
        closeOpenNoteDialog(); // 打开中的笔记弹层经 Escape 正规 release（续体守卫丢弃迟到保存）
        resetReaderSearch(); // 切换文档清掉搜索状态与命中 overlay
      },
      setPhase: (phase) => {
        if (phase === 'loading') {
          setReaderPhase('loading', true);
        } else {
          setReaderPhase(phase);
        }
      },
      beforeCommit: (request) => {
        loadedExt = request.ext;
        annotations = [];
        sessionAnnotation.beginSession(request.ext, request.target);
        sidebar?.render(annotations);
        syncBookmarkIndicators(); // 旧书角标不得带入新书
      },
      settle: settleSession,
      openRemoteSource: deps.openRemoteSource,
    },
  });

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
      if (destroyed) {
        throw new Error('reader-view has been destroyed');
      }
      const target = normalizeReaderTarget(targetOrPath);
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      const nextExt = (target.extension || extOfPath(filePath)).toLowerCase();
      if (target.kind === 'local' && deps.readBytes === undefined && !usesNativeArchive(nextExt)) {
        throw new Error('reader-view load requires the readBytes dependency');
      }
      // 格式分发只剩 adapter 选择（未知扩展按原口径报不支持）：世代取代、
      // 取消合成、parse→stage→commit 与对称作废全部由 session-load 管线裁决。
      const kind = sessionAdapterKindForExtension(nextExt);
      if (kind === null) {
        throw new ParseError(`暂不支持的阅读格式：.${nextExt || '?'}`);
      }
      const nativeArchive = usesNativeArchive(nextExt);
      const formatPath = extOfPath(filePath) === nextExt ? filePath : `${filePath}.${nextExt}`;
      return sessionLoad.open({ kind, target, formatPath, ext: nextExt, nativeArchive }, options);
    },
    async destroy(): Promise<void> {
      if (destroyed) {
        return;
      }
      sessionProgress.dispose();
      destroyed = true;
      // 会话销毁（管线）：世代 +1、abort 在飞加载、恰一次作废活动会话
      // （PDF/漫画句柄与流式内容 dispose + 对称作废合同）；收尾在 DOM 清理
      // 尾部统一 await。
      const sessionDispose = sessionLoad.destroy();
      pdfHandle = null;
      cbzHandle = null;
      flowChapterCount = 0;
      sessionAnnotation.dispose();
      clearFlowBindings();
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
      // 搜索会话销毁作废（原 destroy 口径：不扫命中 overlay，DOM 随 root 移除；
      // 在飞扫描经 destroyed 守卫与 pdf 句柄取代检查丢弃）：只取消待执行重查。
      sessionSearch.cancelScheduled();
      scrollHost.removeEventListener('scroll', scheduleFlowScroll);
      paneScroller?.removeEventListener('scroll', scheduleFlowScroll);
      // 对称作废合同：与每次 commit 同一组摘除助手（页监听/pending 帧/settle）。
      invalidateSharedReadingSurface();
      flowScrollCoordinator?.cancel();
      chromeRevealObserver?.disconnect();
      chromeRevealObserver = null;
      pageChromeObserver?.disconnect();
      pageChromeObserver = null;
      closeChromePanel();
      if (readerChrome !== null) {
        root.removeEventListener('click', syncChromeRevealAttr);
        root.removeEventListener('pointermove', syncChromeRevealAttr);
      }
      readerChrome?.destroy();
      readerChrome = null;
      syncReaderTitlebarReveal(root, false);
      tocPanel.remove();
      typePanel.remove();
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
      await sessionDispose;
    },
    addBookmark: () => {
      // 开关语义（chrome 书签按钮与标注菜单共用）：当前位置已书签则取消。
      toggleBookmarkAtCurrentPosition();
    },
    isBookmarked: () =>
      sessionAnnotation.enabled() && bookmarkAtStatePosition(readerState) !== null,
    addNote: () => {
      if (sessionAnnotation.enabled()) addAnnotation('note');
    },
    toggleSidebar: () => setSidebarVisible(!sessionAnnotation.sidebarVisibility().visible),
    setTabActive: (active: boolean): void => setTabActive(active),
    isSidebarVisible: () => sessionAnnotation.sidebarVisibility().visible,
    openSearch,
    refreshViewport,
    restoreReadingProgress: () => sessionProgress.restore(),
    refreshPreferences: () => {
      applyTypographyPatch(loadReaderTypography(preferenceStorage));
      applyFlowLayout(loadReaderLayout(preferenceStorage));
      applyPaperTheme(loadReaderTheme(preferenceStorage));
      if (cbzHandle !== null) {
        cbzHandle.setPreferences(
          loadComicPreferences(
            preferenceStorage,
            cbzHandle.metadata.readingDirection ?? 'ltr',
            sessionProgress.progressId(),
          ),
        );
      }
    },
    advanceReading,
    adjustDisplayScale: (action: 'in' | 'out' | 'reset'): boolean => {
      if (cbzHandle === null) return false;
      cbzHandle.adjustZoom(action);
      return true;
    },
    getOutline: () => readerOutline,
    jumpToOutlineItem,
    isAnnotationEnabled: () => sessionAnnotation.enabled(),
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
        await chapter.load?.();
        // 阅读器 chrome 标题不能做成正文 h1（会和书里标题叠成两行）。
        // 封面/插图等无 heading 的章仍需一个隐藏 h1，否则 PDF 书签/目录会丢这些条目。
        const title = chapter.title.trim() || t('reader.chapter', { n: String(index + 1) });
        const bookmark = /<h[1-6]\b/i.test(chapter.html)
          ? ''
          : `<h1 class="lightink-export-bookmark">${escapeHtml(title)}</h1>`;
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
