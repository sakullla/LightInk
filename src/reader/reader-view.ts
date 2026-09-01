/**
 * `reader-view` — 只读阅读视图的装配根（T5-kernel-split 拆分后收敛于此）：
 * 构造 ReaderViewContext（src/reader/view/reader-context.ts，承载跨域可变状态
 * 的受控访问），按既有副作用顺序创建五个会话实例（sessionAnnotation/
 * sessionSearch/sessionProgress/sessionNavigation/sessionLoad）与 flowRenderer，
 * 装配八个域模块并注册窗口/文档级监听，最后返回 ReaderInstance 门面。
 *
 * 域模块归位（纯移动，行为不变）：
 * - view/reader-dom.ts：DOM 骨架/宿主几何/阅读状态机/共享纯函数；
 * - view/reader-search-surface.ts：搜索表面与 sessionSearch 供数回调；
 * - view/reader-annotation-surface.ts：标注写路径/划选工具栏/笔记弹层/侧栏 portal；
 * - view/reader-bookmarks.ts：书签事实判定/角标双轨/刻度跳转；
 * - view/reader-zoom.ts：缩放域（字号 settle/视口重排/resize settle）；
 * - view/reader-paged-stage.ts：paged 族（PDF 文本层/漫画 staged/commit/adapter）；
 * - view/reader-flow-stage.ts：flow 族（flowRenderer 接线/章节窗口/adapter）；
 * - view/reader-chrome-wiring.ts：chrome 装配/面板开合/Escape 链/排版域。
 *
 * 会话核心（打开管线/世代取代/对称作废）在 src/reader/session/session-load.ts，
 * 进度/搜索/导航/标注会话见 src/reader/session/*，flow/paged 两族 adapter 见
 * src/reader/session/adapters.ts。本壳只消费主题令牌 var(--lightink-*) 与
 * --lightink-font-scale。
 */

import './reader.css';
import type { MessageKey } from '../i18n/messages.js';
import type { ReaderInputSource } from './formats/index.js';
import {
  normalizeReaderTarget,
  type ArchiveProvider,
  type RandomAccessSource,
  type ReaderTarget,
  type RemoteReaderTarget,
} from './sources/types.js';
import { throwIfReaderLoadCancelled } from './load-lifecycle.js';
import { ParseError, type ReaderContent } from './formats/types.js';
import { sanitizeReaderCss } from './sanitize-css.js';
import { escapeHtml } from './html-escape.js';
import type { Annotation } from './annotations.js';
import { createReaderSessionSearch } from './session/session-search.js';
import type {
  ReaderInstance,
  ReaderLoadOptions,
} from './types.js';
import { extOfPath } from '../file/path-ext.js';
import { advanceScrolledScroller } from '../ui/reading-layout.js';
import { playReaderPageTurn } from './reader-progress-ui.js';
import { createFlowRenderer, readerPagedScroller } from './flow-renderer.js';
import { createReaderSessionLoad } from './session/session-load.js';
import { createReaderSessionNavigation } from './session/session-navigation.js';
import { createReaderSessionAnnotation } from './session/session-annotation.js';
import {
  sessionAdapterKindForExtension,
  sessionMemberForExtension,
} from './session/adapters.js';
import { createReaderSessionProgress } from './session/session-progress.js';
import {
  usesNativeArchive,
  type ArchivePasswordProvider,
} from './sources/native-archive.js';
import type { ComicMetadata } from './comic-model.js';
import { loadComicPreferences } from './comic-preferences.js';
import { syncReaderTitlebarReveal } from '../ui/window-titlebar.js';
import { unpinFixedOverlay } from './reader-chrome-panels.js';
import {
  loadReaderLayout,
} from './reader-layout.js';
import {
  loadReaderTypography,
} from './reader-typography.js';
import { loadReaderTheme } from './reader-theme.js';
import {
  PAGE_EXTS,
  ReaderViewContext,
} from './view/reader-context.js';
import { readerChromeTouchMode, setupReaderDom } from './view/reader-dom.js';
import { setupReaderSearchSurface } from './view/reader-search-surface.js';
import { setupReaderAnnotationSurface } from './view/reader-annotation-surface.js';
import { setupReaderBookmarks } from './view/reader-bookmarks.js';
import { setupReaderZoom } from './view/reader-zoom.js';
import { setupReaderPagedStage } from './view/reader-paged-stage.js';
import { setupReaderFlowStage } from './view/reader-flow-stage.js';
import { setupReaderChromeWiring } from './view/reader-chrome-wiring.js';

export { isTextLayerMutation, pdfTextLayerSelector } from './view/reader-dom.js';

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
  remoteImagePolicy?: import('../media/remote-image-policy.js').RemoteImagePolicy;
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
  progressStorage?: import('./reading-progress.js').ProgressStorage | null;
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
  /**
   * 导出当前书全部标注为 Markdown（R5；生产为 main.ts 装配 annotation-export：
   * save 对话框 + writeFile 原子写 + 空态/成败提示）。缺省时标注面板隐藏导出
   * 按钮（与 search deps 缺省同模式）。
   */
  exportAnnotations?: (payload: {
    title: string;
    annotations: readonly Annotation[];
  }) => void | Promise<void>;
}

/**
 * 在宿主元素内创建阅读视图并返回 ReaderInstance。
 */
export function createReaderView(host: HTMLElement, deps: ReaderViewDeps = {}): ReaderInstance {
  // —— ① 共享上下文 + DOM 骨架（几何/状态机械随 dom 域装配） ——
  const ctx = new ReaderViewContext(host, deps);
  ctx.dom = setupReaderDom(ctx);

  // —— ② 域模块装配（纯定义：函数/协调器/settle 工厂，无外部副作用） ——
  ctx.annotation = setupReaderAnnotationSurface(ctx);
  ctx.search = setupReaderSearchSurface(ctx);
  ctx.bookmarks = setupReaderBookmarks(ctx);
  ctx.zoom = setupReaderZoom(ctx);
  ctx.paged = setupReaderPagedStage(ctx);
  ctx.flow = setupReaderFlowStage(ctx);

  // —— ③ 五会话实例 + flowRenderer（创建顺序与原壳一致；环状回引经 ctx） ——
  ctx.sessionAnnotation = createReaderSessionAnnotation(ctx.annotation.createSessionHost());
  ctx.sessionSearch = createReaderSessionSearch(ctx.search.createSessionHost());
  ctx.flowRenderer = createFlowRenderer(ctx.scrollHost, ctx.root, ctx.flow.createRendererHooks());

  // —— 进度会话（session-progress）：身份链/保存时机/恢复重试裁决单点在核心，
  // 视图只按族供数（快照与落位的 DOM 机械 + 未就绪原因，无第二份会话规则）。 ——
  ctx.sessionProgress = createReaderSessionProgress({
    storage: ctx.progressStorage,
    flow: ctx.flow.flowProgressFeed,
    paged: ctx.paged.pagedProgressFeed,
    activeKind: () =>
      ctx.pdfHandle !== null || ctx.cbzHandle !== null || PAGE_EXTS.has(ctx.loadedExt) ? 'paged' : 'flow',
    canPersistNow: () => ctx.readerState.phase === 'ready' || ctx.readerState.phase === 'loading',
    canRestoreNow: () => ctx.readerState.phase === 'ready',
    isDestroyed: () => ctx.destroyed,
    onProgressBound: ctx.deps.onProgressBound,
  });

  ctx.dom.applyStateToDom(ctx.readerState);
  ctx.chrome = setupReaderChromeWiring(ctx);

  /**
   * 导航会话（session-navigation）：advanceReading 三支与大纲跳转收敛为按
   * adapter kind 的单一策略表（paged/flow 两行，paged 行内 pdf/漫画成员由
   * 供数区分），返回值合同、rtl 翻转、动效/保存时机与载荷 no-op 唯一实现
   * 在 session 模块；本壳只供族内机械（句柄步进/滚页、flow 分栏/视口步进、
   * 章节对齐与状态同步）。
   */
  ctx.sessionNavigation = createReaderSessionNavigation({
    // 原三支分支序冻结：页句柄存活 → paged（成员按句柄），否则 flow 兜底
    // （加载窗口无句柄时与原口径一致：flow 空内容步进 false、跳转同机械）。
    activeKind: () => (ctx.pdfHandle !== null || ctx.cbzHandle !== null ? 'paged' : 'flow'),
    pagedMember: () => (ctx.pdfHandle !== null ? 'pdf' : ctx.cbzHandle !== null ? 'comic' : null),
    pagedComicReadsRightToLeft: () => ctx.cbzHandle?.preferences.direction === 'rtl',
    pagedCurrentPage: () => ctx.pdfHandle?.controller.page ?? 1,
    pagedScrollToPage: (page) => {
      const pdf = ctx.pdfHandle;
      if (pdf !== null) {
        pdf.scrollToPage(page);
        return;
      }
      ctx.cbzHandle?.scrollToPage(page);
    },
    pagedComicStep: (delta) => {
      const handle = ctx.cbzHandle;
      if (handle === null) {
        return;
      }
      if (delta > 0) handle.nextPage();
      else handle.previousPage();
    },
    syncPagedState: () => ctx.paged.syncPageState(),
    flowIsPaginated: () => ctx.flowIsPaginated(),
    flowAdvancePaged: (direction) => ctx.flowRenderer.advancePage(direction),
    flowAdvanceScrolled: (direction) => {
      if (ctx.sessionProgress.hasPendingRestore()) {
        ctx.sessionProgress.discardPending();
      }
      return advanceScrolledScroller(ctx.dom.flowScrollContainer(), direction);
    },
    flowJumpToChapter: (chapter) => {
      ctx.flow.setActiveChapter(chapter);
      if (ctx.flowIsPaginated()) {
        const frame = ctx.scrollHost.querySelector<HTMLIFrameElement>(
          `.lightink-reader-chapter[data-chapter-index="${chapter}"] .lightink-reader-chapter-frame`,
        );
        const doc = frame?.contentDocument;
        if (doc !== undefined && doc !== null) {
          readerPagedScroller(doc).scrollLeft = 0;
        }
      } else {
        const article = ctx.scrollHost.querySelector<HTMLElement>(
          `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
        );
        const scroller = ctx.dom.flowScrollContainer();
        if (article !== null) {
          scroller.scrollTop = Math.max(0, ctx.dom.articleOffsetInScroller(article, scroller));
        }
      }
    },
    syncFlowState: () => ctx.flow.syncFlowState(),
    discardPendingRestore: () => ctx.sessionProgress.discardPending(),
    persistProgress: () => ctx.sessionProgress.schedulePersist(),
    playPageTurn: (direction) => playReaderPageTurn(ctx.root, direction),
    hideSelectionToolbar: () => ctx.annotation.hideSelectionToolbar(),
  });
  ctx.advanceReading = (direction: 1 | -1, navKey?: string): boolean =>
    ctx.sessionNavigation.advance(direction, navKey);
  ctx.jumpToOutlineItem = (item): void => ctx.sessionNavigation.jumpToOutlineItem(item);

  // —— ④ 监听注册（顺序与原壳一致） ——
  ctx.scrollHost.addEventListener('scroll', ctx.flow.scheduleFlowScroll, { passive: true });
  const paneScroller = ctx.dom.closestPane();
  paneScroller?.addEventListener('scroll', ctx.flow.scheduleFlowScroll, { passive: true });
  // 阅读输入活动信号（进度 v2 空闲计时）：点击/指针/按键刷新 readingMs 计时窗口；
  // 滚动/翻页经 schedulePersist 已计入。监听器随 root 摘除，destroy 无需显式移除。
  const noteReadingActivity = (): void => {
    ctx.sessionProgress.noteActivity();
  };
  ctx.root.addEventListener('click', noteReadingActivity);
  ctx.root.addEventListener('pointerdown', noteReadingActivity);
  ctx.root.addEventListener('keydown', noteReadingActivity);
  // 分页滚轮提到窗口级（main.ts，与 Markdown R1 同源）：大纲/chrome/空白区
  // 悬停也翻正文。章节 iframe 内事件到不了宿主，仍由 flow-renderer 转发。
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', ctx.chrome.onDocumentEscapeCapture, true);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:font-scale', ctx.zoom.onFontScaleChange);
    document.addEventListener('lightink:pdf-user-zoom', ctx.zoom.onPdfUserZoom);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('lightink:theme-change', ctx.chrome.onThemeChange);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', ctx.zoom.onWindowResize);
  }

  const layoutRoot =
    typeof document !== 'undefined' && document.documentElement != null
      ? document.documentElement
      : null;
  const layoutRootObserver =
    layoutRoot === null || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(ctx.zoom.syncPaginatedChapter);
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
  ctx.root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ctx.chrome.dismissReaderOverlayStep()) {
      event.preventDefault();
      return;
    }
    // 方向键/空格/PageUp/Down 由窗口级 main.ts 统一翻页（R1：大纲/chrome/空白区
    // 同样生效）。这里只保留 PDF 缩放键；流式章节 iframe 内翻页仍由 flow-renderer 转发。
    const handle = ctx.pdfHandle;
    if (handle === null) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      if (handle.controller.zoomIn()) {
        event.preventDefault();
        ctx.paged.syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '-' || event.key === '_') {
      if (handle.controller.zoomOut()) {
        event.preventDefault();
        ctx.paged.syncPageState();
        void handle.rerender();
      }
    } else if (event.key === '0') {
      if (handle.controller.resetScale()) {
        event.preventDefault();
        ctx.paged.syncPageState();
        void handle.rerender();
      }
    }
  });

  // 书签 / 笔记改由菜单触发（见 ReaderInstance.addBookmark/addNote），不再挂浮动工具栏。

  ctx.chrome.mountReaderChrome();

  // —— ⑤ 会话核心接线（R1/R2）：两族 adapter 只做本族 stage/commit/收尾，
  // 世代取代、取消合成、对称作废与远程源单次接管全在 session-load 管线。 ——

  /** 管线 settle 尾巴：标注装载 → 进度身份链/恢复 → ready 发布与状态同步。 */
  const settleSession = async (
    request: import('./session/adapters.js').SessionOpenRequest,
    context: import('./session/adapters.js').SessionRunContext,
  ): Promise<void> => {
    const target = request.target;
    await ctx.annotation.loadAnnotationsForSession(target, {
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
    // 书库绑定通知；全部经 session-progress 单点裁决。漫画页进度身份已在
    // afterCommit 提前绑定（路径键，不哈希归档）：标注身份现为 16-hex 存储键，
    // 不得再作为进度身份回灌，故传 null 保持路径键口径。
    ctx.sessionProgress.bindDocumentIdentity(
      target,
      sessionMemberForExtension(ctx.loadedExt) === 'comic' ? null : ctx.sessionAnnotation.contentHash(),
    );
    ctx.dom.setReaderPhase('ready');
    ctx.sessionProgress.applyPendingWithRetry();
    if (PAGE_EXTS.has(ctx.loadedExt)) {
      ctx.paged.syncPageState();
    } else {
      ctx.flow.syncFlowState();
    }
    ctx.sessionProgress.notifyProgressBound(target);
  };

  ctx.sessionLoad = createReaderSessionLoad({
    flow: ctx.flow.flowSessionAdapter,
    paged: ctx.paged.pagedSessionAdapter,
    host: {
      beginOpen: () => {
        ctx.sessionAnnotation.invalidateWrites();
        ctx.annotation.hideSelectionToolbar();
        ctx.sessionProgress.beginSession();
        ctx.readerOutline = [];
        ctx.exportChapters = [];
        ctx.exportStylesheet = '';
        ctx.exportEmbedImages = null;
        ctx.annotation.closeOpenNoteDialog(); // 打开中的笔记弹层经 Escape 正规 release（续体守卫丢弃迟到保存）
        ctx.search.resetReaderSearch(); // 切换文档清掉搜索状态与命中 overlay
      },
      setPhase: (phase) => {
        if (phase === 'loading') {
          ctx.dom.setReaderPhase('loading', true);
        } else {
          ctx.dom.setReaderPhase(phase);
        }
      },
      beforeCommit: (request) => {
        ctx.loadedExt = request.ext;
        ctx.loadedTitle = request.target.displayName;
        ctx.annotations = [];
        ctx.sessionAnnotation.beginSession(request.ext, request.target);
        ctx.sidebar?.render(ctx.annotations);
        ctx.bookmarks.syncBookmarkIndicators(); // 旧书角标不得带入新书
      },
      settle: settleSession,
      openRemoteSource: ctx.deps.openRemoteSource,
    },
  });

  return {
    get state() {
      return ctx.readerState;
    },
    subscribeState(listener) {
      ctx.stateListeners.add(listener);
      try {
        listener(ctx.readerState);
      } catch {
        // Keep subscription setup isolated from application chrome failures.
      }
      return () => {
        ctx.stateListeners.delete(listener);
      };
    },
    async load(targetOrPath: string | ReaderTarget, options: ReaderLoadOptions = {}): Promise<void> {
      if (ctx.destroyed) {
        throw new Error('reader-view has been destroyed');
      }
      const target = normalizeReaderTarget(targetOrPath);
      const filePath = target.kind === 'local' ? target.path : target.displayName;
      const nextExt = (target.extension || extOfPath(filePath)).toLowerCase();
      if (target.kind === 'local' && ctx.deps.readBytes === undefined && !usesNativeArchive(nextExt)) {
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
      return ctx.sessionLoad.open({ kind, target, formatPath, ext: nextExt, nativeArchive }, options);
    },
    async destroy(): Promise<void> {
      if (ctx.destroyed) {
        return;
      }
      ctx.sessionProgress.dispose();
      ctx.destroyed = true;
      // 会话销毁（管线）：世代 +1、abort 在飞加载、恰一次作废活动会话
      // （PDF/漫画句柄与流式内容 dispose + 对称作废合同）；收尾在 DOM 清理
      // 尾部统一 await。
      const sessionDispose = ctx.sessionLoad.destroy();
      ctx.pdfHandle = null;
      ctx.cbzHandle = null;
      ctx.flowChapterCount = 0;
      ctx.sessionAnnotation.dispose();
      ctx.flow.clearFlowBindings();
      // 触屏钉住的标注侧栏同样持有 touchSheetPins 引用；销毁前对称释放，
      // 否则键盘观察者在会话结束后仍回写已移除的 DOM。
      if (ctx.sidebar !== null && readerChromeTouchMode()) {
        unpinFixedOverlay(ctx.sidebar.element);
      }
      ctx.sidebar?.destroy();
      ctx.sidebar = null;
      ctx.sidebarBackdrop?.remove();
      ctx.sidebarBackdrop = null;
      ctx.selectionToolbar?.destroy();
      ctx.selectionToolbar = null;
      ctx.pendingSelection = null;
      ctx.readerOutline = [];
      ctx.exportChapters = [];
      ctx.exportStylesheet = '';
      ctx.exportEmbedImages = null;
      // 搜索会话销毁作废（原 destroy 口径：不扫命中 overlay，DOM 随 root 移除；
      // 在飞扫描经 destroyed 守卫与 pdf 句柄取代检查丢弃）：只取消待执行重查。
      ctx.sessionSearch.cancelScheduled();
      ctx.search.cancelSearchMarkLinger();
      ctx.scrollHost.removeEventListener('scroll', ctx.flow.scheduleFlowScroll);
      paneScroller?.removeEventListener('scroll', ctx.flow.scheduleFlowScroll);
      // 对称作废合同：与每次 commit 同一组摘除助手（页监听/pending 帧/settle）。
      ctx.paged.invalidateSharedReadingSurface();
      ctx.flowScrollCoordinator?.cancel();
      ctx.chromeRevealObserver?.disconnect();
      ctx.chromeRevealObserver = null;
      ctx.pageChromeObserver?.disconnect();
      ctx.pageChromeObserver = null;
      ctx.chrome.closeChromePanel();
      if (ctx.readerChrome !== null) {
        ctx.root.removeEventListener('click', ctx.chrome.syncChromeRevealAttr);
        ctx.root.removeEventListener('pointermove', ctx.chrome.syncChromeRevealAttr);
      }
      ctx.readerChrome?.destroy();
      ctx.readerChrome = null;
      syncReaderTitlebarReveal(ctx.root, false);
      // closeChromePanel 只在面板打开时 unpin；这里兜底 chromePanel 已为 null
      // 的销毁路径，确保 touchSheetPins 清空、键盘观察者 disconnect。
      if (readerChromeTouchMode()) {
        unpinFixedOverlay(ctx.tocPanel);
        unpinFixedOverlay(ctx.typePanel);
      }
      ctx.tocPanel.remove();
      ctx.typePanel.remove();
      layoutRootObserver?.disconnect();
      ctx.zoom.cancelViewportRefresh();
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', ctx.chrome.onDocumentEscapeCapture, true);
        document.removeEventListener('lightink:font-scale', ctx.zoom.onFontScaleChange);
        document.removeEventListener('lightink:pdf-user-zoom', ctx.zoom.onPdfUserZoom);
        document.removeEventListener('lightink:theme-change', ctx.chrome.onThemeChange);
      }
      ctx.annotation.closeOpenNoteDialog();
      ctx.dom.setReaderPhase('destroyed', true);
      ctx.stateListeners.clear();
      ctx.root.remove();
      await sessionDispose;
    },
    addBookmark: () => {
      // 开关语义（chrome 书签按钮与标注菜单共用）：当前位置已书签则取消。
      ctx.bookmarks.toggleBookmarkAtCurrentPosition();
    },
    isBookmarked: () =>
      ctx.sessionAnnotation.enabled() && ctx.bookmarks.bookmarkAtStatePosition(ctx.readerState) !== null,
    addNote: () => {
      if (ctx.sessionAnnotation.enabled()) ctx.annotation.addAnnotation('note');
    },
    toggleSidebar: () => ctx.annotation.setSidebarVisible(!ctx.sessionAnnotation.sidebarVisibility().visible),
    setTabActive: (active: boolean): void => ctx.chrome.setTabActive(active),
    isSidebarVisible: () => ctx.sessionAnnotation.sidebarVisibility().visible,
    openSearch: (query?: string) => ctx.search.openSearch(query),
    refreshViewport: () => ctx.zoom.refreshViewport(),
    restoreReadingProgress: () => ctx.sessionProgress.restore(),
    refreshPreferences: () => {
      ctx.chrome.applyTypographyPatch(loadReaderTypography(ctx.preferenceStorage));
      ctx.chrome.applyFlowLayout(loadReaderLayout(ctx.preferenceStorage));
      ctx.chrome.applyPaperTheme(loadReaderTheme(ctx.preferenceStorage));
      if (ctx.cbzHandle !== null) {
        ctx.cbzHandle.setPreferences(
          loadComicPreferences(
            ctx.preferenceStorage,
            ctx.cbzHandle.metadata.readingDirection ?? 'ltr',
            ctx.sessionProgress.progressId(),
          ),
        );
      }
    },
    advanceReading: (direction: 1 | -1, navKey?: string) => ctx.advanceReading(direction, navKey),
    adjustDisplayScale: (action: 'in' | 'out' | 'reset') => ctx.zoom.applyDisplayScale(action),
    getOutline: () => ctx.readerOutline,
    jumpToOutlineItem: (item) => ctx.jumpToOutlineItem(item),
    isAnnotationEnabled: () => ctx.sessionAnnotation.enabled(),
    getExportHtml: async (mode = 'blob') => {
      if (ctx.exportChapters.length === 0) {
        return null;
      }
      const publisher = sanitizeReaderCss(ctx.exportStylesheet);
      const style =
        (publisher === '' ? '' : `<style>${publisher}</style>`) +
        '<style>.lightink-export-chapter{break-before:page;page-break-before:always}' +
        '.lightink-export-chapter:first-of-type{break-before:auto;page-break-before:auto}' +
        '.lightink-export-bookmark{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;font-size:1px;line-height:1;color:transparent}</style>';
      const missing: string[] = [];
      const sections: string[] = [];
      for (const [index, chapter] of ctx.exportChapters.entries()) {
        await chapter.load?.();
        // 阅读器 chrome 标题不能做成正文 h1（会和书里标题叠成两行）。
        // 封面/插图等无 heading 的章仍需一个隐藏 h1，否则 PDF 书签/目录会丢这些条目。
        const title = chapter.title.trim() || ctx.t('reader.chapter', { n: String(index + 1) });
        const bookmark = /<h[1-6]\b/i.test(chapter.html)
          ? ''
          : `<h1 class="lightink-export-bookmark">${escapeHtml(title)}</h1>`;
        let markup = `<section class="lightink-export-chapter">${bookmark}${chapter.html}</section>`;
        if (ctx.exportEmbedImages !== null) {
          const embedded = await ctx.exportEmbedImages(markup, mode);
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
