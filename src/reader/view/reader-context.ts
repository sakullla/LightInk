/**
 * `reader-context` — createReaderView 巨闭包拆分（T5-kernel-split）后的类型化
 * 共享上下文：承载 01-exploration §3.5 的跨域可变状态（句柄/loadedExt/
 * annotations/readerState/pageHost/sidebar/selection/chrome/layout 切换标志/
 * 搜索滞后 timer/文本层观察器等，全部经 getter/设值函数受控访问），并持有
 * 五个会话实例（sessionAnnotation/Search/Progress/Navigation/Load）与
 * flowRenderer 的装配槽位。域模块（view/reader-*.ts）只经本 Context 读写
 * 共享状态与互相握手，不再依赖闭包捕获；装配顺序与作废合同见 reader-view.ts。
 */

import type { MessageKey } from '../../i18n/messages.js';
import { PAGED_SESSION_EXTENSIONS, type SessionInvalidation } from '../session/adapters.js';
import type { ReaderSessionAnnotation } from '../session/session-annotation.js';
import type { ReaderSessionSearch } from '../session/session-search.js';
import type { ReaderSessionProgress } from '../session/session-progress.js';
import type { ReaderSessionNavigation } from '../session/session-navigation.js';
import type { ReaderSessionLoad } from '../session/session-load.js';
import type { ReaderState, ReaderStateListener } from '../types.js';
import type { Annotation, Locator } from '../annotations.js';
import type { AnnotationPanel } from '../annotation-panel.js';
import type { SelectionToolbar } from '../selection-toolbar.js';
import type { OutlineItem } from '../../outline/outline-model.js';
import type { ReaderChapter } from '../formats/types.js';
import type { PdfRenderHandle } from '../formats/pdf.js';
import type { CbzRenderHandle } from '../formats/cbz.js';
import type { ReaderChrome } from '../reader-chrome.js';
import type { FlowRenderer } from '../flow-renderer.js';
import { resolveProgressStorage, type ProgressStorage } from '../reading-progress.js';
import {
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../../media/remote-image-policy.js';
import { parseReaderLayout } from '../reader-layout.js';
import { rafFrameScheduler } from '../../ui/reading-layout.js';
import type { ReaderViewDeps } from '../reader-view.js';
import type { ReaderDomSurface } from './reader-dom.js';
import type { ReaderSearchSurface } from './reader-search-surface.js';
import type { ReaderAnnotationSurface } from './reader-annotation-surface.js';
import type { ReaderBookmarksSurface } from './reader-bookmarks.js';
import type { ReaderZoomSurface } from './reader-zoom.js';
import type { ReaderPagedStageSurface } from './reader-paged-stage.js';
import type { ReaderFlowStageSurface } from './reader-flow-stage.js';
import type { ReaderChromeWiringSurface } from './reader-chrome-wiring.js';

/** 页式扩展族与 session adapter 选择同源（加载编排见 session/session-load）。 */
export const PAGE_EXTS = PAGED_SESSION_EXTENSIONS;

/** Portable preference storage (falls back to browser localStorage). */
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

/** 恰一次作废句柄（幂等守卫）：释放本会话独占资源（flow/paged 两 adapter 共用）。 */
export const onceSessionInvalidation = (
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

/** mouseup 时捕获的待确认划选（locator + quote + 命中的已有高亮 id + 来源 frame）。 */
export interface ReaderPendingSelection {
  locator: Locator;
  quote: string;
  existingHighlightId: string | null;
  frame: HTMLIFrameElement | null;
}

/** 导出图片物化回调（flow commit 采纳 content.embedExportImages）。 */
export type ReaderExportEmbedImages = (
  html: string,
  mode?: 'inline' | 'blob',
) => Promise<{ html: string; missing: readonly string[] }>;

/**
 * 视图共享上下文：不可变接线（host/deps/DOM 骨架槽位）+ 受控可变状态 +
 * 会话/域模块装配槽位。域模块只经本对象读写，装配根（reader-view.ts）按
 * 既有副作用顺序填充。
 */
export class ReaderViewContext {
  // —— 不可变接线 ——
  readonly host: HTMLElement;
  readonly deps: ReaderViewDeps;
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  readonly preferenceStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  } | null;
  readonly progressStorage: ProgressStorage | null;
  readonly remoteImagePolicy: RemoteImagePolicy;
  /** 三格式 scroll 统一 rAF 合并用的帧调度器（flow/paged 两 coordinator 共享）。 */
  readonly scrollFrames: ReturnType<typeof rafFrameScheduler>;

  constructor(host: HTMLElement, deps: ReaderViewDeps) {
    this.host = host;
    this.deps = deps;
    this.t = deps.t ?? ((key: MessageKey) => key);
    this.preferenceStorage = deps.preferenceStorage ?? typographyStorage();
    this.progressStorage = resolveProgressStorage(deps.progressStorage);
    this.remoteImagePolicy = deps.remoteImagePolicy ?? sessionRemoteImagePolicy;
    this.scrollFrames = rafFrameScheduler();
  }

  // —— 视图 DOM 骨架（setupReaderDom 构建后一次性填充） ——
  root!: HTMLElement;
  scrollHost!: HTMLElement;
  status!: HTMLDivElement;
  statusLabel!: HTMLSpanElement;
  loadTrack!: HTMLDivElement;
  tocPanel!: HTMLDivElement;
  typePanel!: HTMLDivElement;

  /** 版式判定（root.data-reading-layout → paginated）。 */
  flowIsPaginated(): boolean {
    return parseReaderLayout(this.root.dataset.readingLayout) === 'paginated';
  }

  // —— 跨域可变状态（受控访问器） ——
  #pageHost!: HTMLDivElement;
  get pageHost(): HTMLDivElement {
    return this.#pageHost;
  }
  set pageHost(next: HTMLDivElement) {
    this.#pageHost = next;
  }

  #pdfHandle: PdfRenderHandle | null = null;
  get pdfHandle(): PdfRenderHandle | null {
    return this.#pdfHandle;
  }
  set pdfHandle(next: PdfRenderHandle | null) {
    this.#pdfHandle = next;
  }

  #cbzHandle: CbzRenderHandle | null = null;
  get cbzHandle(): CbzRenderHandle | null {
    return this.#cbzHandle;
  }
  set cbzHandle(next: CbzRenderHandle | null) {
    this.#cbzHandle = next;
  }

  #annotations: Annotation[] = [];
  get annotations(): Annotation[] {
    return this.#annotations;
  }
  set annotations(next: Annotation[]) {
    this.#annotations = next;
  }

  #loadedExt = '';
  get loadedExt(): string {
    return this.#loadedExt;
  }
  set loadedExt(next: string) {
    this.#loadedExt = next;
  }

  #loadedTitle = '';
  get loadedTitle(): string {
    return this.#loadedTitle;
  }
  set loadedTitle(next: string) {
    this.#loadedTitle = next;
  }

  #readerOutline: OutlineItem[] = [];
  get readerOutline(): OutlineItem[] {
    return this.#readerOutline;
  }
  set readerOutline(next: OutlineItem[]) {
    this.#readerOutline = next;
  }

  #exportChapters: ReaderChapter[] = [];
  get exportChapters(): ReaderChapter[] {
    return this.#exportChapters;
  }
  set exportChapters(next: ReaderChapter[]) {
    this.#exportChapters = next;
  }

  #exportStylesheet = '';
  get exportStylesheet(): string {
    return this.#exportStylesheet;
  }
  set exportStylesheet(next: string) {
    this.#exportStylesheet = next;
  }

  #exportEmbedImages: ReaderExportEmbedImages | null = null;
  get exportEmbedImages(): ReaderExportEmbedImages | null {
    return this.#exportEmbedImages;
  }
  set exportEmbedImages(next: ReaderExportEmbedImages | null) {
    this.#exportEmbedImages = next;
  }

  #destroyed = false;
  get destroyed(): boolean {
    return this.#destroyed;
  }
  set destroyed(next: boolean) {
    this.#destroyed = next;
  }

  /** Spine item count is metadata, independent from the bounded mounted iframe window. */
  #flowChapterCount = 0;
  get flowChapterCount(): number {
    return this.#flowChapterCount;
  }
  set flowChapterCount(next: number) {
    this.#flowChapterCount = next;
  }

  #readerState: ReaderState = Object.freeze({
    phase: 'empty',
    current: 0,
    total: 0,
    progress: 0,
    scale: 1,
    locationKind: null,
  });
  get readerState(): ReaderState {
    return this.#readerState;
  }
  set readerState(next: ReaderState) {
    this.#readerState = next;
  }

  readonly stateListeners = new Set<ReaderStateListener>();

  #sidebar: AnnotationPanel | null = null;
  get sidebar(): AnnotationPanel | null {
    return this.#sidebar;
  }
  set sidebar(next: AnnotationPanel | null) {
    this.#sidebar = next;
  }

  #sidebarBackdrop: HTMLButtonElement | null = null;
  get sidebarBackdrop(): HTMLButtonElement | null {
    return this.#sidebarBackdrop;
  }
  set sidebarBackdrop(next: HTMLButtonElement | null) {
    this.#sidebarBackdrop = next;
  }

  /** 侧栏逻辑显隐（session-annotation 裁决）：驱动触屏 sheet 的进场 reveal 时机。 */
  #sidebarShown = false;
  get sidebarShown(): boolean {
    return this.#sidebarShown;
  }
  set sidebarShown(next: boolean) {
    this.#sidebarShown = next;
  }

  /** 划选工具栏（R3）：划选后确认再产生标注；懒创建（标注启用时）。 */
  #selectionToolbar: SelectionToolbar | null = null;
  get selectionToolbar(): SelectionToolbar | null {
    return this.#selectionToolbar;
  }
  set selectionToolbar(next: SelectionToolbar | null) {
    this.#selectionToolbar = next;
  }

  #pendingSelection: ReaderPendingSelection | null = null;
  get pendingSelection(): ReaderPendingSelection | null {
    return this.#pendingSelection;
  }
  set pendingSelection(next: ReaderPendingSelection | null) {
    this.#pendingSelection = next;
  }

  #chromePanel: 'toc' | 'typography' | null = null;
  get chromePanel(): 'toc' | 'typography' | null {
    return this.#chromePanel;
  }
  set chromePanel(next: 'toc' | 'typography' | null) {
    this.#chromePanel = next;
  }

  #readerChrome: ReaderChrome | null = null;
  get readerChrome(): ReaderChrome | null {
    return this.#readerChrome;
  }
  set readerChrome(next: ReaderChrome | null) {
    this.#readerChrome = next;
  }

  #chromeRevealObserver: MutationObserver | null = null;
  get chromeRevealObserver(): MutationObserver | null {
    return this.#chromeRevealObserver;
  }
  set chromeRevealObserver(next: MutationObserver | null) {
    this.#chromeRevealObserver = next;
  }

  #pageChromeObserver: MutationObserver | null = null;
  get pageChromeObserver(): MutationObserver | null {
    return this.#pageChromeObserver;
  }
  set pageChromeObserver(next: MutationObserver | null) {
    this.#pageChromeObserver = next;
  }

  /** 版式切换门控：度量期间挡住帧 ResizeObserver（可重入，持有方负责清掉）。 */
  #layoutSwitching = false;
  get layoutSwitching(): boolean {
    return this.#layoutSwitching;
  }
  set layoutSwitching(next: boolean) {
    this.#layoutSwitching = next;
  }

  /** 字号档位变更 settle 后仍待补分栏的离屏章索引（null = 无待补章）。 */
  #stalePaginatedChapters: Set<number> | null = null;
  get stalePaginatedChapters(): Set<number> | null {
    return this.#stalePaginatedChapters;
  }
  set stalePaginatedChapters(next: Set<number> | null) {
    this.#stalePaginatedChapters = next;
  }

  /** 字号缩放档位合并去抖的 settle 定时器 cancel（destroy/切换时作废）。 */
  #cancelFontScaleRefresh: (() => void) | null = null;
  get cancelFontScaleRefresh(): (() => void) | null {
    return this.#cancelFontScaleRefresh;
  }
  set cancelFontScaleRefresh(next: (() => void) | null) {
    this.#cancelFontScaleRefresh = next;
  }

  #lastScrollChapter = -1;
  get lastScrollChapter(): number {
    return this.#lastScrollChapter;
  }
  set lastScrollChapter(next: number) {
    this.#lastScrollChapter = next;
  }

  /** 整页搜索关闭后正文命中 mark 的滞后清除 timer。 */
  #searchMarkLingerTimer: ReturnType<typeof setTimeout> | null = null;
  get searchMarkLingerTimer(): ReturnType<typeof setTimeout> | null {
    return this.#searchMarkLingerTimer;
  }
  set searchMarkLingerTimer(next: ReturnType<typeof setTimeout> | null) {
    this.#searchMarkLingerTimer = next;
  }

  /** PDF 文本层懒出现/异步填充/缩放重建的重渲染观察器。 */
  #textLayerObserver: MutationObserver | null = null;
  get textLayerObserver(): MutationObserver | null {
    return this.#textLayerObserver;
  }
  set textLayerObserver(next: MutationObserver | null) {
    this.#textLayerObserver = next;
  }

  /** flow 滚动合并帧句柄（destroy 时 cancel）。 */
  #flowScrollCoordinator: { schedule(): void; cancel(): void } | null = null;
  get flowScrollCoordinator(): { schedule(): void; cancel(): void } | null {
    return this.#flowScrollCoordinator;
  }
  set flowScrollCoordinator(next: { schedule(): void; cancel(): void } | null) {
    this.#flowScrollCoordinator = next;
  }

  // —— 会话实例（装配根创建；环状回引经本 Context 显式握手） ——
  sessionAnnotation!: ReaderSessionAnnotation;
  sessionSearch!: ReaderSessionSearch;
  sessionProgress!: ReaderSessionProgress;
  sessionNavigation!: ReaderSessionNavigation;
  sessionLoad!: ReaderSessionLoad;
  flowRenderer!: FlowRenderer;
  advanceReading!: (direction: 1 | -1, navKey?: string) => boolean;
  jumpToOutlineItem!: (item: OutlineItem) => void;

  // —— 域模块表面（装配根 setup 填充） ——
  dom!: ReaderDomSurface;
  search!: ReaderSearchSurface;
  annotation!: ReaderAnnotationSurface;
  bookmarks!: ReaderBookmarksSurface;
  zoom!: ReaderZoomSurface;
  paged!: ReaderPagedStageSurface;
  flow!: ReaderFlowStageSurface;
  chrome!: ReaderChromeWiringSurface;
}
