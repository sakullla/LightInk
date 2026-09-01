/**
 * `reader-annotation-surface` — reader-view 拆分（T5-kernel-split）的标注表面域：
 * sessionAnnotation 供数回调装配（侧栏 DOM/portal/焦点机械 + 搜索 marks 让位）、
 * 标注写路径（追加/移除/笔记更新 + tombstone）、划选工具栏与笔记弹层、
 * currentPositionLocator、跳转 jumpToAnnotation、侧栏 portal 接线
 * （ensureSidebar/pinSidebarOverlay/syncSidebarOverlayDom）与 flow 正文高亮
 * renderHighlights（PDF 文本层分派到 reader-paged-stage）。写队列与显隐裁决
 * 唯一实现在 session-annotation。纯移动自 reader-view.ts，行为不变。
 */

import {
  removeAnnotation,
  updateAnnotationNote,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
  type Locator,
} from '../annotations.js';
import {
  annotationMarkFromEventTarget,
  flowLocatorFromSelection,
  resolveTextQuoteRange,
} from '../annotation-locator.js';
import {
  annotationMarkSpec,
  paintAnnotationOverlays,
  renderAnnotationMarks,
  removeAnnotationMarks,
  type AnnotationMarkSpec,
} from '../annotation-render.js';
import { createAnnotationPanel } from '../annotation-panel.js';
import {
  createSelectionToolbar,
  selectionClientRect,
} from '../selection-toolbar.js';
import { showNoteDialog } from '../note-dialog.js';
import { sessionCapabilitiesForExtension } from '../session/adapters.js';
import type { SessionAnnotationHost } from '../session/session-annotation.js';
import type { ReaderTarget } from '../sources/types.js';
import { mapFrameClientRect } from '../flow-renderer.js';
import {
  concealSheet,
  revealSheet,
} from '../../ui/touch/sheet-transition.js';
import {
  mountReaderOverlay,
  pinFixedOverlay,
  unpinFixedOverlay,
} from '../reader-chrome-panels.js';
import { cssEscape, readerChromeTouchMode } from './reader-dom.js';
import { SEARCH_MARK_LINGER_MS } from './reader-search-surface.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

/** 仅用于稳定标注 id（无加密强度需求）。 */
function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID().slice(0, 8);
  }
  return `a-${Date.now().toString(36)}`;
}

export interface ReaderAnnotationSurface {
  createSessionHost(): SessionAnnotationHost;
  saveAnnotations(): Promise<void>;
  removeAnnotationById(id: string): void;
  setSelectionToolbarOpen(open: boolean): void;
  hideSelectionToolbar(): void;
  keepCommittedSelection(): boolean;
  openNote(annotation: Annotation): void;
  annotationFromMark(target: EventTarget | null): Annotation | null;
  ensureSelectionToolbar(): void;
  currentPositionLocator(): Locator;
  appendAnnotation(
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
    color?: AnnotationColor,
  ): void;
  addAnnotation(kind: AnnotationKind): void;
  jumpToAnnotation(annotation: Annotation): void;
  ensureSidebar(): void;
  renderSidebarAnnotations(): void;
  pinSidebarOverlay(): void;
  syncSidebarOverlayDom(): void;
  setSidebarVisible(visible: boolean): void;
  renderHighlights(): void;
  onFlowSelectionMouseUp(
    selection: Selection | null,
    chapter: number,
    body: HTMLElement,
    frame: HTMLIFrameElement,
  ): void;
  loadAnnotationsForSession(
    target: ReaderTarget,
    context: { signal: AbortSignal; isCurrent: () => boolean },
  ): Promise<void>;
  closeOpenNoteDialog(): void;
}

export function setupReaderAnnotationSurface(ctx: ReaderViewContext): ReaderAnnotationSurface {
  // —— 标注宿主会话（session-annotation）：启用判定（标注存储 × adapter
  // 能力声明 × 身份可用）、写队列与侧栏显隐策略唯一实现在核心；本壳只按
  // host 供数（侧栏 DOM/portal/焦点机械）并消费其裁决。 ——
  const createSessionHost = (): SessionAnnotationHost => ({
    storage: {
      readAnnotations: ctx.deps.readAnnotations,
      writeAnnotations: ctx.deps.writeAnnotations,
      getContentHash: ctx.deps.getContentHash,
    },
    notifySaveFailed: () => ctx.deps.notify?.(ctx.t('annotation.saveFailed')),
    isDestroyed: () => ctx.destroyed,
    ensureSidebarDom: () => ensureSidebar(),
    syncSidebarDom: () => syncSidebarOverlayDom(),
    isNarrowViewport: () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 700px)').matches,
    focusSidebarClose: () => {
      ctx.sidebar?.element
        .querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')
        ?.focus();
    },
    sidebarHoldsFocus: () =>
      ctx.sidebar !== null && ctx.sidebar.element.contains(document.activeElement),
    focusReaderRoot: () => ctx.root.focus(),
    closeChromePanel: () => ctx.chrome.closeChromePanel(),
    resetSearch: () => ctx.search.resetReaderSearch(),
    preserveSearchOnHide: () =>
      readerChromeTouchMode() && ctx.sidebar?.element.dataset.searchPage === 'document',
    releaseSearchMarks: () => {
      ctx.search.cancelSearchMarkLinger();
      ctx.searchMarkLingerTimer = setTimeout(() => {
        ctx.searchMarkLingerTimer = null;
        if (!ctx.destroyed) {
          ctx.sessionSearch.dropMarks();
        }
      }, SEARCH_MARK_LINGER_MS);
    },
    afterSidebarSync: () => ctx.flow.syncVisibleFlowFrames(),
    sidebarSearchQuery: () => ctx.sidebar?.getSearchQuery() ?? '',
    renderSidebarList: () => ctx.sidebar?.render(ctx.annotations),
  });

  /** 写队列策略唯一实现在 session-annotation（按当前身份串行写入，失败提示带会话守卫）。 */
  const saveAnnotations = async (): Promise<void> => {
    await ctx.sessionAnnotation.save(ctx.annotations);
  };

  /** 移除标注（侧栏/划选工具栏共用）：v3 删除产 tombstone（同步合并按记录级
   * LWW 收敛，防复活），更新集合、经共享引擎清正文 mark、刷新书签表面、保存。 */
  const removeAnnotationById = (id: string): void => {
    ctx.annotations = removeAnnotation(ctx.annotations, id);
    for (const doc of ctx.dom.flowDocuments()) {
      removeAnnotationMarks(doc.body, id);
      paintAnnotationOverlays(doc);
    }
    for (const layer of ctx.pageHost.querySelectorAll('.pdfViewer .textLayer')) {
      removeAnnotationMarks(layer, id);
    }
    renderSidebarAnnotations();
    ctx.bookmarks.syncBookmarkIndicators();
    ctx.bookmarks.syncChromeBookmarkState();
    void saveAnnotations();
  };

  const setSelectionToolbarOpen = (open: boolean): void => {
    if (open) {
      ctx.root.dataset.selectionToolbar = 'open';
      return;
    }
    delete ctx.root.dataset.selectionToolbar;
  };

  const hideSelectionToolbar = (): void => {
    const pending = ctx.pendingSelection;
    ctx.pendingSelection = null;
    ctx.selectionToolbar?.hide();
    setSelectionToolbarOpen(false);
    if (pending?.frame !== null && pending?.frame !== undefined) {
      pending.frame.contentWindow?.getSelection()?.removeAllRanges();
    } else if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }
  };

  const keepCommittedSelection = (): boolean =>
    ctx.selectionToolbar?.isVisible() === true && ctx.pendingSelection !== null;

  const openNote = (annotation: Annotation): void => {
    if (annotation.kind !== 'note') {
      return;
    }
    void (async () => {
      const generation = ctx.sessionLoad.generation();
      const input = await showNoteDialog(
        document,
        annotation.note ?? '',
        { t: ctx.t, editing: true },
        annotation.quote,
      );
      if (input === null || ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
        return;
      }
      ctx.annotations = updateAnnotationNote(ctx.annotations, annotation.id, input);
      renderSidebarAnnotations();
      void saveAnnotations();
    })();
  };

  const annotationFromMark = (target: EventTarget | null): Annotation | null => {
    const id = annotationMarkFromEventTarget(target)?.getAttribute('data-annotation-id') ?? '';
    if (id === '') {
      return null;
    }
    return ctx.annotations.find((item) => item.id === id) ?? null;
  };

  /** 工具栏动作派发（R3）：确认后才创建/移除标注；复制始终可用。 */
  const ensureSelectionToolbar = (): void => {
    if (ctx.selectionToolbar !== null) {
      return;
    }
    ctx.selectionToolbar = createSelectionToolbar({
      t: ctx.t,
      onDismiss: () => hideSelectionToolbar(),
      onAction: (action, detail) => {
        const pending = ctx.pendingSelection;
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
            const generation = ctx.sessionLoad.generation();
            const input = await showNoteDialog(document, '', { t: ctx.t }, pending.quote);
            if (input === null) {
              return; // 取消：保留选区、不产生标注
            }
            if (ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
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
    mountReaderOverlay(ctx.selectionToolbar.element, ctx.root);
  };

  /** 当前阅读位置的定位器（书签/笔记用）。 */
  const currentPositionLocator = (): Locator => {
    if (ctx.pdfHandle !== null) {
      return { format: 'pdf', page: ctx.pdfHandle.controller.page, quote: '' };
    }
    if (ctx.cbzHandle !== null) {
      return { format: 'cbz', page: ctx.cbzHandle.currentPage };
    }
    const chapter = ctx.dom.firstVisibleChapter();
    const article = ctx.scrollHost.querySelector<HTMLElement>(
      `.lightink-reader-chapter[data-chapter-index="${chapter}"]`,
    );
    const body = article?.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')
      ?.contentDocument?.body;
    const text = body?.textContent ?? '';
    const visibleOffset = Math.max(0, ctx.scrollHost.scrollTop - (article?.offsetTop ?? 0));
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
    if (ctx.loadedExt === 'txt') {
      return { format: 'text', chapter, ...anchor };
    }
    return { format: 'flow', chapter, ...anchor };
  };

  /** 追加标注并同步正文高亮/侧栏/书签表面/持久化。 */
  const appendAnnotation = (
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
    color?: AnnotationColor,
  ): void => {
    ctx.annotations = [
      ...ctx.annotations,
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
    ctx.bookmarks.syncBookmarkIndicators();
    ctx.bookmarks.syncChromeBookmarkState();
    void saveAnnotations();
  };

  /** 添加书签或笔记（笔记经多行弹层输入，取消不创建）。 */
  const addAnnotation = (kind: AnnotationKind): void => {
    if (kind === 'note') {
      void (async () => {
        const generation = ctx.sessionLoad.generation();
        const input = await showNoteDialog(document, '', { t: ctx.t });
        if (input === null) {
          return;
        }
        if (ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
          return; // 弹层期间已切换文档/销毁：丢弃迟到保存
        }
        const pending = ctx.pendingSelection;
        if (pending !== null && pending.quote.trim() !== '') {
          ctx.pendingSelection = null;
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
    if (loc.format === 'pdf' && ctx.pdfHandle !== null) {
      ctx.pdfHandle.scrollToPage(loc.page);
      ctx.paged.syncPageState();
      ctx.pageHost
        .querySelector<HTMLElement>(`[data-annotation-id="${cssEscape(annotation.id)}"]`)
        ?.scrollIntoView({ block: 'center' });
      return;
    }
    if (loc.format === 'cbz') {
      ctx.cbzHandle?.scrollToPage(loc.page);
      ctx.paged.syncPageState();
      return;
    }
    // flow / text：优先定位到该条高亮的 <mark>，否则到章节。
    const chapter =
      loc.format === 'flow'
        ? loc.chapter
        : loc.format === 'text'
          ? loc.chapter
          : ctx.dom.firstVisibleChapter();
    if (chapter !== undefined && ctx.flowIsPaginated()) {
      ctx.flow.setActiveChapter(chapter);
    }
    const mark = Array.from(
      ctx.scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
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
              ctx.scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
            )
          : [
              ctx.scrollHost.querySelector<HTMLIFrameElement>(
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
      ctx.scrollHost
        .querySelector<HTMLElement>(`[data-chapter-index="${chapter}"]`)
        ?.scrollIntoView({ block: 'center' });
    }
  };

  const ensureSidebar = (): void => {
    if (ctx.sidebar !== null) {
      return;
    }
    ctx.sidebarBackdrop = document.createElement('button');
    ctx.sidebarBackdrop.type = 'button';
    ctx.sidebarBackdrop.className = 'lightink-reader-sidebar-backdrop';
    ctx.sidebarBackdrop.tabIndex = -1;
    ctx.sidebarBackdrop.setAttribute('aria-hidden', 'true');
    ctx.sidebarBackdrop.hidden = !ctx.sessionAnnotation.sidebarVisibility().shown;
    ctx.sidebarBackdrop.addEventListener('click', () => setSidebarVisible(false));
    ctx.sidebar = createAnnotationPanel({
      t: ctx.t,
      onClose: () => setSidebarVisible(false),
      onLayoutChange: () => pinSidebarOverlay(),
      // 漫画等位图格式无文本层：正文搜索固定为「不支持」空态（能力矩阵声明）。
      isDocumentSearchUnsupported: () => {
        if (ctx.loadedExt === '') {
          return false;
        }
        return sessionCapabilitiesForExtension(ctx.loadedExt)?.textSearch == null;
      },
      search: {
        onQuery: (nextQuery) => {
          if (nextQuery.trim() === '') {
            ctx.sessionSearch.clear();
            ctx.sidebar?.render(ctx.annotations);
            return;
          }
          ctx.sessionSearch.run(nextQuery);
        },
        onJump: (key) => {
          ctx.sessionSearch.activateKey(key);
          // 触屏：点结果即回正文看命中（Books/Kindle 同行为）；桌面留面板步进。
          if (readerChromeTouchMode()) {
            setSidebarVisible(false);
          }
        },
        onNext: () => ctx.sessionSearch.step(1),
        onPrev: () => ctx.sessionSearch.step(-1),
        onClear: () => {
          ctx.sessionSearch.clear();
          ctx.sidebar?.render(ctx.annotations);
        },
        onLoadMore: () => ctx.sessionSearch.loadMore(),
      },
      onJump: (annotation) => {
        jumpToAnnotation(annotation);
        if (readerChromeTouchMode()) {
          setSidebarVisible(false);
        }
      },
      onRemove: (annotation) => {
        removeAnnotationById(annotation.id);
      },
      onEditNote: (annotation) => {
        openNote(annotation);
      },
      // 标注导出（R5）：宿主未装配 exportAnnotations 时按钮隐藏（markdown 编辑器
      // 宿主不传，与 search deps 缺省同模式）。
      onExport:
        ctx.deps.exportAnnotations === undefined
          ? undefined
          : () => {
              void ctx.deps.exportAnnotations?.({ title: ctx.loadedTitle, annotations: ctx.annotations });
            },
    });
    const { visible, shown } = ctx.sessionAnnotation.sidebarVisibility();
    ctx.sidebarShown = shown;
    ctx.sidebar.element.setAttribute('aria-hidden', visible ? 'false' : 'true');
    ctx.sidebar.element.hidden = !shown;
    ctx.root.append(ctx.sidebarBackdrop, ctx.sidebar.element);
    renderSidebarAnnotations();
  };

  const renderSidebarAnnotations = (): void => {
    // 搜索查询让位判定在 session-annotation 核心；DOM 渲染留视图。
    ctx.sessionAnnotation.syncSidebarList();
  };

  const pinSidebarOverlay = (): void => {
    if (ctx.sidebar === null || ctx.sidebar.element.hidden) {
      return;
    }
    if (readerChromeTouchMode()) {
      mountReaderOverlay(ctx.sidebar.element, ctx.root);
      pinFixedOverlay(ctx.sidebar.element, ctx.dom.closestPane() ?? ctx.root);
      if (ctx.sidebarShown && ctx.sidebar.element.dataset.open === undefined) {
        // 进场过渡：pin（is-touch-sheet 几何）落地后再挂 data-open，关闭位
        // 先经强制回流成为当前 computed style（退场窗口内不回补，防僵尸重开）。
        revealSheet(ctx.sidebar.element);
      }
      return;
    }
    if (ctx.flowIsPaginated()) {
      unpinFixedOverlay(ctx.sidebar.element);
      return;
    }
    pinFixedOverlay(ctx.sidebar.element, ctx.dom.closestPane() ?? ctx.root);
  };

  /** 侧栏覆盖层（含 portal 到共享 chrome 的部分）与当前显隐状态同步。 */
  const syncSidebarOverlayDom = (): void => {
    const { visible, shown } = ctx.sessionAnnotation.sidebarVisibility();
    ctx.sidebarShown = shown;
    ctx.root.classList.toggle('lightink-reader--sidebar', visible);
    // chromeHost（#lightink-main）是所有标签共享的，只在侧栏真正显示时占类。
    ctx.dom.chromeHost().classList.toggle('lightink-reader--sidebar', shown);
    ctx.dom.closestPane()?.classList.toggle('lightink-reader--sidebar', visible);
    ctx.sidebar?.element.setAttribute('aria-hidden', shown ? 'false' : 'true');
    if (ctx.sidebar !== null) {
      if (shown) {
        ctx.sidebar.element.hidden = false;
      } else if (!ctx.sidebar.element.hidden) {
        // 触屏退场：摘 data-open 滑出（220ms），收尾后置 hidden 并对称 unpin；
        // 桌面/jsdom 无过渡样式时同步落地，与既有行为一致。
        if (readerChromeTouchMode()) {
          const panel = ctx.sidebar.element;
          concealSheet(panel, () => {
            panel.hidden = true;
            if (readerChromeTouchMode()) {
              unpinFixedOverlay(panel);
            }
          });
        } else {
          ctx.sidebar.element.hidden = true;
          unpinFixedOverlay(ctx.sidebar.element);
        }
      } else {
        ctx.sidebar.element.hidden = true;
      }
    }
    if (ctx.sidebarBackdrop !== null) {
      ctx.sidebarBackdrop.hidden = !shown;
    }
    pinSidebarOverlay();
    ctx.chrome.pinChromeDocks();
  };

  /** 切换侧栏显隐（显隐策略唯一实现在 session-annotation 核心）。 */
  const setSidebarVisible = (visible: boolean): void => {
    ctx.sessionAnnotation.setSidebarVisible(visible);
  };

  /** 在 sandbox 正文文本节点中包裹高亮 quote（flow/txt，共享幂等引擎）；PDF 走文本层渲染。 */
  const renderHighlights = (): void => {
    if (ctx.loadedExt === 'pdf') {
      ctx.paged.renderPdfHighlights();
      return;
    }
    if (PAGE_EXTS.has(ctx.loadedExt)) {
      return;
    }
    const byChapter = new Map<number, AnnotationMarkSpec[]>();
    const unchaptered: AnnotationMarkSpec[] = [];
    for (const hl of ctx.annotations) {
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
      const frame = ctx.scrollHost.querySelector<HTMLIFrameElement>(
        `.lightink-reader-chapter-frame[data-chapter-index="${chapter}"]`,
      );
      const doc = frame?.contentDocument;
      if (doc === null || doc === undefined) {
        continue;
      }
      paintFrame(doc, specs);
    }
    if (unchaptered.length > 0) {
      for (const frame of ctx.scrollHost.querySelectorAll<HTMLIFrameElement>(
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
      ctx.loadedExt === 'txt' ? 'text' : 'flow',
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
    ctx.pendingSelection = {
      locator,
      quote: text,
      existingHighlightId: existingMark?.getAttribute('data-annotation-id') ?? null,
      frame,
    };
    ensureSelectionToolbar();
    if (ctx.selectionToolbar === null) {
      return;
    }
    // iframe 内 rect 是 frame 视口坐标，叠加 frame 偏移换算为外层 client 坐标。
    // 分栏里 bounding rect 会横跨左右页，改用最后一行盒子锚定工具栏。
    ctx.selectionToolbar.showAt(
      mapFrameClientRect(frame, selectionClientRect(selection.getRangeAt(0))),
      { canRemoveHighlight: existingMark !== null },
    );
    setSelectionToolbarOpen(true);
  };

  /** 会话管线标注装载钩子：启用判定/身份解析/读取/解析唯一实现在 session-annotation。 */
  const loadAnnotationsForSession = async (
    target: ReaderTarget,
    context: { signal: AbortSignal; isCurrent: () => boolean },
  ): Promise<void> => {
    const nextAnnotations = await ctx.sessionAnnotation.load(ctx.loadedExt, target, context);
    if (nextAnnotations === null) {
      return; // 未启用/过期（销毁/取消/世代失配）：不改状态（beforeCommit 已复位视图集合）
    }
    ctx.annotations = nextAnnotations;
    renderHighlights(); // flow/txt 正文与 PDF 文本层（含旧 anchor 数据重渲染）
    ctx.bookmarks.syncBookmarkIndicators(); // 页内书签角标随装载落位
    ctx.bookmarks.syncChromeBookmarkState();
    ensureSidebar();
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

  return {
    createSessionHost,
    saveAnnotations,
    removeAnnotationById,
    setSelectionToolbarOpen,
    hideSelectionToolbar,
    keepCommittedSelection,
    openNote,
    annotationFromMark,
    ensureSelectionToolbar,
    currentPositionLocator,
    appendAnnotation,
    addAnnotation,
    jumpToAnnotation,
    ensureSidebar,
    renderSidebarAnnotations,
    pinSidebarOverlay,
    syncSidebarOverlayDom,
    setSidebarVisible,
    renderHighlights,
    onFlowSelectionMouseUp,
    loadAnnotationsForSession,
    closeOpenNoteDialog,
  };
}
