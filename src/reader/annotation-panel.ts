/**
 * `annotation-panel` — 统一融合标注搜索面板（R2/R8，替代 annotation-sidebar
 * 与 search-sheet）。
 *
 * 单一组件承载两件事：
 * - 标注笔记本：本书全部书签/高亮/笔记按文档位置排序，范围/颜色筛选
 *   （胶囊右侧高级面板），点击跳转、编辑备注、删除（删除由宿主走
 *   removeAnnotation 产出 tombstone，本组件列表永远经 filterAnnotations
 *   过滤，tombstone 不出列）；
 * - 同一查询框双语义检索：标注范围下本地筛标注；「全部」范围有查询时正文
 *   命中合并渲染；「正文」范围只检索全书（可选 `search`）。
 *
 * 双端同一实现：桌面经 pinFixedOverlay 侧栏形态钉在阅读区右侧；触屏由宿主
 * portal 到 body。标注笔记本仍是 is-touch-sheet 底栏；「搜索正文」切到
 * data-search-page=document 整页（返回 + 搜索框占顶栏，结果占满其余空间），
 * 不再用半高 sheet 把命中挤在键盘上方。
 *
 * Escape 分层：查询非空先清查询（不关面板），为空退一层经 onClose 关面板；
 * 事件在面板内消费，不再冒泡到 chrome 返回分层（一次只关一层）。
 *
 * 正文搜索不可用的宿主（Markdown 编辑器宿主；漫画等位图格式）省略 search
 * 并可选 isDocumentSearchUnsupported：面板保留「正文」范围，进入后显示
 * 不支持空态（reader.search.unsupported），不回退「无结果」。
 *
 * 纯 DOM 装配；查询语义走 annotations.ts 的 filterAnnotations 与
 * search-panel.ts 的 bindImeSafeQuery/observeLoadMore。render 全量重绘，
 * 筛选与标注搜索状态在闭包内跨 render 保留。
 */

import {
  ANNOTATION_COLORS,
  filterAnnotations,
  resolveAnnotationColor,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
} from './annotations.js';
import type { MessageKey } from '../i18n/messages.js';
import { bindImeSafeQuery, observeLoadMore } from './search-panel.js';

type AnnotationFilter = 'all' | AnnotationKind | 'document';
type ColorFilter = 'all' | AnnotationColor;

/** 高级面板互斥范围：全部 / 高亮 / 笔记 / 书签；「正文」按需插入全部之后。 */
const KIND_SCOPES: readonly AnnotationFilter[] = ['all', 'highlight', 'note', 'bookmark'];

function filterLabelKey(filter: AnnotationFilter): MessageKey {
  if (filter === 'all') return 'annotation.filter.all';
  if (filter === 'document') return 'reader.search.scope.document';
  return `annotation.kind.${filter}`;
}

function colorFiltersVisible(filter: AnnotationFilter): boolean {
  return filter === 'all' || filter === 'highlight';
}

export interface SearchHitView {
  key: string;
  snippet: string;
  location: string | null;
  current: boolean;
}

export interface SearchHitsState {
  /** Revealed busy chrome; only after the search has taken about a second. */
  searching?: boolean;
  /** In-flight but quieter than one second — no empty copy, no extra scrollbar. */
  pending?: boolean;
  hasMore?: boolean;
}

export interface AnnotationPanelSearch {
  onQuery: (query: string) => void;
  onJump: (key: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClear: () => void;
  onLoadMore?: () => void;
}

export interface AnnotationPanelDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 点击某条标注时跳转到其位置（由宿主实现滚动/翻页）。 */
  onJump: (annotation: Annotation) => void;
  /** 可选：移除标注（由宿主走 removeAnnotation 产出 tombstone 并保存）。 */
  onRemove?: (annotation: Annotation) => void;
  /** 可选：编辑备注（由宿主唤起笔记弹层并保存）。 */
  onEditNote?: (annotation: Annotation) => void;
  /** Close the panel from its close button / Escape layering. */
  onClose?: () => void;
  /**
   * 触屏「搜索正文」整页与标注 sheet 切换时通知宿主重 pin（几何不同）。
   */
  onLayoutChange?: () => void;
  /**
   * 可选：导出当前书全部标注为 Markdown（R5，宿主装配 save 对话框 + 原子写）。
   * 缺省时头部导出按钮隐藏（与 search deps 缺省同模式；Markdown 编辑器宿主不传）。
   */
  onExport?: () => void;
  /** Reader-only document search. Markdown hosts and bitmap formats omit this. */
  search?: AnnotationPanelSearch;
  /**
   * 正文检索不可用（漫画等位图格式无文本层）：保留「搜索正文」分类并显示
   * 不支持空态；提供时即使 search 缺省也不显示「无结果」。
   */
  isDocumentSearchUnsupported?: () => boolean;
}

export interface AnnotationPanel {
  readonly element: HTMLElement;
  render(annotations: readonly Annotation[]): void;
  renderHits(hits: readonly SearchHitView[], state?: SearchHitsState): void;
  setSearchQuery(query: string): void;
  getSearchQuery(): string;
  focusSearch(): void;
  destroy(): void;
}

/** 每条标注的定位描述（面板显示与标注导出共用；cbz 无章节概念只给页码）。 */
export function annotationLocationText(
  annotation: Annotation,
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string,
): string | null {
  const locator = annotation.locator;
  switch (locator.format) {
    case 'pdf':
      return t('annotation.location.page', { page: String(locator.page) });
    case 'cbz':
      return t('annotation.location.page', { page: String(locator.page) });
    case 'flow':
      return t('reader.chapter', { n: String(locator.chapter + 1) });
    default:
      return null;
  }
}

/** 文档位置排序键：先章节/页，再文内偏移（同位置按创建时间稳定排序）。 */
function positionRank(annotation: Annotation): [number, number] {
  const locator = annotation.locator;
  switch (locator.format) {
    case 'flow':
      return [locator.chapter, locator.start];
    case 'text':
      return [locator.chapter ?? 0, locator.start];
    case 'pdf':
      return [locator.page - 1, locator.anchor?.start ?? 0];
    default:
      return [(locator as { page: number }).page - 1, 0];
  }
}

export function byDocumentPosition(left: Annotation, right: Annotation): number {
  const [leftChapter, leftStart] = positionRank(left);
  const [rightChapter, rightStart] = positionRank(right);
  if (leftChapter !== rightChapter) {
    return leftChapter - rightChapter;
  }
  if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  return left.createdAt - right.createdAt;
}

function styleSwatch(element: HTMLElement, color: string): void {
  element.style.backgroundColor = color;
}

/** 行操作按钮：jump/edit/remove 的同构装配。 */
function createActionButton(
  className: string,
  label: string,
  onClick: () => void,
  ariaLabel?: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  if (ariaLabel !== undefined) {
    button.setAttribute('aria-label', ariaLabel);
  }
  button.addEventListener('click', onClick);
  return button;
}

interface FilterButtonOptions {
  className: string;
  dataset: { kindFilter?: string; color?: string };
  text?: string;
  ariaLabel?: string;
  title?: string;
  swatchColor?: string;
}

/** 筛选按钮：类型筛选与颜色筛选的同构装配。 */
function createFilterButton(
  options: FilterButtonOptions,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = options.className;
  if (options.dataset.kindFilter !== undefined) {
    button.dataset.kindFilter = options.dataset.kindFilter;
  }
  if (options.dataset.color !== undefined) {
    button.dataset.color = options.dataset.color;
  }
  if (options.text !== undefined) {
    button.textContent = options.text;
  }
  if (options.ariaLabel !== undefined) {
    button.setAttribute('aria-label', options.ariaLabel);
  }
  if (options.title !== undefined) {
    button.setAttribute('title', options.title);
  }
  if (options.swatchColor !== undefined) {
    styleSwatch(button, options.swatchColor);
  }
  button.addEventListener('click', onClick);
  return button;
}

/**
 * 创建统一融合标注搜索面板。element 由宿主挂载：桌面钉在阅读区右侧
 * （pinFixedOverlay）；触屏 portal 到 body——标注笔记本是 is-touch-sheet
 * 底栏，「搜索正文」是 data-search-page 整页。
 */
export function createAnnotationPanel(deps: AnnotationPanelDeps): AnnotationPanel {
  const root = document.createElement('aside');
  root.className = 'lightink-reader-sidebar lightink-reader-annotation-panel';
  root.setAttribute('aria-label', deps.t('annotation.sidebar'));
  root.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'lightink-reader-sidebar-header';
  const title = document.createElement('span');
  title.textContent = deps.t('annotation.sidebar');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-sidebar-close';
  close.textContent = '×';
  close.setAttribute('aria-label', deps.t('annotation.closeSidebar'));
  close.setAttribute('title', deps.t('annotation.closeSidebar'));
  close.addEventListener('click', () => deps.onClose?.());
  header.append(title);
  let exportButton: HTMLButtonElement | null = null;
  if (deps.onExport !== undefined) {
    exportButton = createActionButton(
      'lightink-reader-sidebar-export',
      deps.t('annotation.export.button'),
      () => deps.onExport?.(),
      deps.t('annotation.export.button'),
    );
    exportButton.setAttribute('title', deps.t('annotation.export.button'));
    header.appendChild(exportButton);
  }
  header.appendChild(close);

  const noteField = document.createElement('div');
  noteField.className = 'lightink-reader-sidebar-search lightink-reader-sidebar-note-search';
  noteField.setAttribute('role', 'search');
  // 填充胶囊：放大镜 + 输入 + 命中计数 + 清空 + 高级，聚焦环挂在胶囊上
  // （样式见 annotation-panel.css search-pill 段）。
  const searchPill = document.createElement('div');
  searchPill.className = 'lightink-reader-sidebar-search-pill';
  const searchIcon = document.createElement('span');
  searchIcon.className = 'lightink-reader-sidebar-search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  const noteSearchInput = document.createElement('input');
  noteSearchInput.type = 'text';
  noteSearchInput.className = 'lightink-reader-sidebar-note-search-input';
  noteSearchInput.setAttribute('aria-label', deps.t('annotation.search.placeholder'));
  noteSearchInput.placeholder = deps.t('annotation.search.placeholder');
  noteSearchInput.autocomplete = 'off';
  noteSearchInput.spellcheck = false;
  noteSearchInput.enterKeyHint = 'search';
  noteSearchInput.inputMode = 'search';
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'lightink-reader-sidebar-search-clear';
  clearButton.textContent = '×';
  clearButton.setAttribute('aria-label', deps.t('reader.search.clear'));
  clearButton.hidden = true;
  const advancedButton = document.createElement('button');
  advancedButton.type = 'button';
  advancedButton.className = 'lightink-reader-sidebar-search-advanced';
  advancedButton.textContent = deps.t('reader.search.advanced');
  advancedButton.setAttribute('aria-label', deps.t('reader.search.advanced'));
  advancedButton.setAttribute('aria-expanded', 'false');
  advancedButton.setAttribute('aria-haspopup', 'dialog');
  const noteStatus = document.createElement('span');
  noteStatus.className = 'lightink-reader-sidebar-search-status';
  noteStatus.setAttribute('aria-live', 'polite');
  // 清空在高级左侧：查询非空时两者并存，清空只清词。
  searchPill.append(searchIcon, noteSearchInput, noteStatus, clearButton, advancedButton);
  noteField.append(searchPill);

  const scopePanel = document.createElement('div');
  scopePanel.className = 'lightink-reader-sidebar-search-scope';
  scopePanel.hidden = true;
  scopePanel.setAttribute('role', 'dialog');
  scopePanel.setAttribute('aria-label', deps.t('reader.search.scope'));
  const scopeList = document.createElement('div');
  scopeList.className = 'lightink-reader-sidebar-search-scope-list';
  scopeList.setAttribute('role', 'listbox');
  const filterButtons = new Map<AnnotationFilter, HTMLButtonElement>();
  let currentFilter: AnnotationFilter = 'all';
  let scopeOpen = false;

  const colors = document.createElement('div');
  colors.className = 'lightink-reader-sidebar-search-scope-colors';
  colors.setAttribute('role', 'group');
  colors.setAttribute('aria-label', deps.t('annotation.filter.all'));
  const colorButtons = new Map<ColorFilter, HTMLButtonElement>();
  let currentColor: ColorFilter = 'all';

  const list = document.createElement('ul');
  list.className = 'lightink-reader-sidebar-list';
  // 手机端：滚动结果时收起软键盘，让位给列表（微信读书/Books 同行为）。
  list.addEventListener(
    'touchmove',
    () => {
      if (document.activeElement === noteSearchInput) {
        noteSearchInput.blur();
      }
    },
    { passive: true },
  );

  const applyFilter = (): void => {
    for (const [filter, button] of filterButtons) {
      const active = filter === currentFilter;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle(
        'lightink-reader-sidebar-search-scope-option--active',
        active,
      );
    }
    for (const [color, button] of colorButtons) {
      const active = color === currentColor;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.classList.toggle('lightink-reader-sidebar-search-scope-color--active', active);
      button.classList.toggle('lightink-reader-sidebar-filter--active', active);
    }
    colors.hidden = !colorFiltersVisible(currentFilter);
  };

  const search = deps.search;
  const unsupported = (): boolean => deps.isDocumentSearchUnsupported?.() === true;
  /** 正文检索可执行（宿主提供 search 且当前格式未声明不支持）。 */
  const documentSearchAvailable = (): boolean => search !== undefined && !unsupported();
  /** 「正文」范围可见：可执行或不支持（不支持也要有空态出口）。 */
  const documentCategoryVisible = (): boolean => search !== undefined || unsupported();

  const scopes: AnnotationFilter[] = [...KIND_SCOPES];
  if (documentCategoryVisible()) {
    scopes.splice(1, 0, 'document');
  }
  for (const filter of scopes) {
    const button = createFilterButton(
      {
        className: 'lightink-reader-sidebar-search-scope-option',
        dataset: { kindFilter: filter },
        text: deps.t(filterLabelKey(filter)),
      },
      () => setFilter(filter),
    );
    button.setAttribute('role', 'option');
    filterButtons.set(filter, button);
    scopeList.appendChild(button);
  }

  const allColor = createFilterButton(
    {
      className: 'lightink-reader-sidebar-search-scope-color lightink-reader-sidebar-color-filter',
      dataset: { color: 'all' },
      text: deps.t('annotation.filter.all'),
      ariaLabel: deps.t('annotation.filter.all'),
    },
    () => {
      currentColor = 'all';
      applyFilter();
      syncColorSearchScope();
    },
  );
  colorButtons.set('all', allColor);
  colors.appendChild(allColor);

  for (const color of ANNOTATION_COLORS) {
    const button = createFilterButton(
      {
        className: 'lightink-reader-sidebar-search-scope-color lightink-reader-sidebar-color-filter',
        dataset: { color },
        ariaLabel: color,
        title: color,
        swatchColor: color,
      },
      () => {
        currentColor = color;
        applyFilter();
        syncColorSearchScope();
      },
    );
    colorButtons.set(color, button);
    colors.appendChild(button);
  }

  let annotationQuery = '';
  /** 正文检索命中：null 表示当前没有进行中的正文搜索。 */
  let lastHits: readonly SearchHitView[] | null = null;

  scopePanel.append(scopeList, colors);
  const stack = document.createElement('div');
  stack.className = 'lightink-reader-sidebar-search-stack';
  stack.append(noteField, scopePanel);
  root.append(header, stack, list);

  const setScopeOpen = (open: boolean): void => {
    scopeOpen = open;
    scopePanel.hidden = !open;
    advancedButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    advancedButton.classList.toggle('is-open', open);
  };

  advancedButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setScopeOpen(!scopeOpen);
  });

  const onPointerDownOutside = (event: PointerEvent): void => {
    if (!scopeOpen) return;
    const target = event.target;
    if (
      target instanceof Node &&
      (scopePanel.contains(target) || advancedButton.contains(target))
    ) {
      return;
    }
    setScopeOpen(false);
  };
  document.addEventListener('pointerdown', onPointerDownOutside);

  /**
   * 输入框描述随范围切换：标注范围下筛选标注，「正文」范围下只检索全书。
   * 正文模式：藏导出与标题；触屏把搜索框抬进顶栏并标 data-search-page，
   * 让宿主改成整页而不是半高 sheet。高级按钮与范围面板仍可用。
   */
  const syncSearchMode = (): void => {
    const documentMode = currentFilter === 'document' && documentCategoryVisible();
    const wasSearchPage = root.dataset.searchPage === 'document';
    const label = deps.t(
      documentMode ? 'reader.search.document' : 'annotation.search.placeholder',
    );
    noteSearchInput.placeholder = label;
    noteSearchInput.setAttribute('aria-label', label);
    title.hidden = documentMode;
    title.textContent = deps.t(documentMode ? 'reader.search.document' : 'annotation.sidebar');
    if (exportButton !== null) {
      exportButton.hidden = documentMode;
    }
    if (documentMode) {
      root.dataset.searchPage = 'document';
      root.setAttribute('aria-label', deps.t('reader.search.document'));
      close.textContent = '‹';
      close.setAttribute('aria-label', deps.t('reader.search.back'));
      close.setAttribute('title', deps.t('reader.search.back'));
      header.insertBefore(close, header.firstChild);
      if (stack.parentElement !== header) {
        header.appendChild(stack);
      }
    } else {
      delete root.dataset.searchPage;
      root.setAttribute('aria-label', deps.t('annotation.sidebar'));
      close.textContent = '×';
      close.setAttribute('aria-label', deps.t('annotation.closeSidebar'));
      close.setAttribute('title', deps.t('annotation.closeSidebar'));
      if (stack.parentElement === header) {
        root.insertBefore(stack, list);
      }
      if (exportButton !== null) {
        header.appendChild(exportButton);
      }
      header.appendChild(close);
    }
    if (wasSearchPage !== documentMode) {
      deps.onLayoutChange?.();
    }
  };

  const clearDocumentSearch = (): void => {
    if (
      lastHits !== null ||
      currentFilter === 'document' ||
      noteSearchInput.value.trim() !== ''
    ) {
      search?.onClear();
    }
    lastHits = null;
  };

  /** 清空查询框并退掉正文搜索会话（Escape/切分类共用；输入框仍有值时通知宿主）。 */
  const clearQuery = (): void => {
    clearDocumentSearch();
    noteSearchInput.value = '';
    annotationQuery = '';
    renderCombined();
  };

  clearButton.addEventListener('click', () => {
    clearQuery();
    noteSearchInput.focus({ preventScroll: true });
  });

  const setFilter = (filter: AnnotationFilter): void => {
    if (filter !== 'document') clearDocumentSearch();
    currentFilter = filter;
    applyFilter();
    syncSearchMode();
    if (search !== undefined && !unsupported() && noteSearchInput.value.trim() !== '') {
      // 「全部」分类下输入即同时筛选标注与检索正文；「搜索正文」只检索全书。
      if (filter === 'document' || (filter === 'all' && currentColor === 'all')) {
        search.onQuery(noteSearchInput.value);
        return;
      }
    }
    renderCombined();
  };

  /** 颜色筛选离开「全部」时退出正文检索；回到「全部」且有查询时恢复合并搜索。 */
  const syncColorSearchScope = (): void => {
    if (search !== undefined && !unsupported() && currentFilter !== 'document') {
      if (currentColor === 'all' && currentFilter === 'all' && annotationQuery.trim() !== '') {
        renderCombined();
        search.onQuery(annotationQuery);
        return;
      }
      if (currentColor !== 'all') clearDocumentSearch();
    }
    renderCombined();
  };

  const documentSearchScope = (): boolean =>
    documentSearchAvailable() &&
    (currentFilter === 'document' || (currentFilter === 'all' && currentColor === 'all'));

  const applyLocalQuery = (): void => {
    annotationQuery = noteSearchInput.value;
    if (search !== undefined && !unsupported() && lastHits !== null && !documentSearchScope()) {
      clearDocumentSearch();
    }
    renderCombined();
  };

  const unbindQuery = bindImeSafeQuery(noteSearchInput, (query) => {
    annotationQuery = query;
    if (search !== undefined && documentSearchScope() && query.trim() !== '') {
      search.onQuery(query);
      return;
    }
    if (documentSearchAvailable() && lastHits !== null) {
      clearDocumentSearch();
    }
    renderCombined();
  });

  noteSearchInput.addEventListener('input', applyLocalQuery);
  noteSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && currentFilter === 'document' && search !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        search.onPrev();
      } else {
        search.onNext();
      }
      return;
    }
    if (event.key !== 'Escape') {
      return;
    }
    // Escape 分层：有查询先清查询；无查询退一层关面板（触屏同语义）。
    event.preventDefault();
    event.stopPropagation();
    if (noteSearchInput.value === '') {
      deps.onClose?.();
      return;
    }
    clearQuery();
  });

  root.addEventListener('keydown', (event) => {
    if (event.target === noteSearchInput) {
      return;
    }
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLButtonElement) return;
      if (currentFilter !== 'document' || search === undefined) return;
      event.preventDefault();
      if (event.shiftKey) {
        search.onPrev();
      } else {
        search.onNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (noteSearchInput.value !== '') {
        clearQuery();
        return;
      }
      deps.onClose?.();
    }
  });

  const renderItem = (annotation: Annotation): HTMLLIElement => {
    const li = document.createElement('li');
    li.className = 'lightink-reader-sidebar-item';
    li.dataset.annotationId = annotation.id;
    const color = resolveAnnotationColor(annotation.color);
    li.dataset.annotationColor = color;

    const kind = document.createElement('span');
    kind.className = `lightink-reader-sidebar-kind lightink-reader-sidebar-kind--${annotation.kind}`;
    kind.textContent = deps.t(`annotation.kind.${annotation.kind}`);

    const meta = document.createElement('div');
    meta.className = 'lightink-reader-sidebar-item-meta';
    if (annotation.kind === 'highlight' || annotation.kind === 'note') {
      const swatch = document.createElement('span');
      swatch.className = 'lightink-reader-sidebar-color';
      swatch.dataset.color = color;
      styleSwatch(swatch, color);
      meta.appendChild(swatch);
    }
    meta.appendChild(kind);
    const location = annotationLocationText(annotation, deps.t);
    if (location !== null) {
      const where = document.createElement('span');
      where.className = 'lightink-reader-sidebar-location';
      where.textContent = location;
      meta.appendChild(where);
    }
    li.appendChild(meta);

    const text = document.createElement('span');
    text.className = 'lightink-reader-sidebar-text';
    // 笔记优先显示备注（fallback quote），避免 quote 遮蔽备注（R4 编辑结果可见）。
    const body =
      annotation.kind === 'note'
        ? annotation.note ?? annotation.quote
        : annotation.quote ?? annotation.note;
    text.textContent = body ?? deps.t(`annotation.kind.${annotation.kind}`);
    li.appendChild(text);

    if (
      annotation.kind === 'note' &&
      annotation.quote !== undefined &&
      annotation.quote !== '' &&
      annotation.note !== undefined &&
      annotation.note !== '' &&
      annotation.note !== annotation.quote
    ) {
      const quote = document.createElement('span');
      quote.className = 'lightink-reader-sidebar-quote';
      quote.textContent = annotation.quote;
      li.appendChild(quote);
    }

    const actions = document.createElement('div');
    actions.className = 'lightink-reader-sidebar-actions';

    const jump = createActionButton(
      'lightink-reader-sidebar-jump',
      deps.t('annotation.jump'),
      () => deps.onJump(annotation),
    );
    actions.appendChild(jump);

    if (annotation.kind === 'note' && deps.onEditNote !== undefined) {
      const edit = createActionButton(
        'lightink-reader-sidebar-edit',
        deps.t('annotation.edit'),
        () => deps.onEditNote?.(annotation),
      );
      actions.appendChild(edit);
    }

    if (deps.onRemove !== undefined) {
      const remove = createActionButton(
        'lightink-reader-sidebar-remove',
        deps.t('annotation.remove'),
        () => deps.onRemove?.(annotation),
        deps.t('annotation.remove'),
      );
      actions.appendChild(remove);
    }
    li.appendChild(actions);
    li.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('button') !== null) {
        return;
      }
      deps.onJump(annotation);
      if (annotation.kind === 'note') {
        deps.onEditNote?.(annotation);
      }
    });
    return li;
  };

  let lastAnnotations: readonly Annotation[] = [];
  let lastHitsState: SearchHitsState = {};
  let moreRelease: (() => void) | null = null;
  applyFilter();
  syncSearchMode();

  /** 命中片段内高亮当前查询词（大小写不敏感首次命中；查不到退回纯文本）。 */
  const paintSnippet = (host: HTMLElement, snippet: string): void => {
    const query = noteSearchInput.value.trim();
    if (query !== '') {
      const at = snippet.toLowerCase().indexOf(query.toLowerCase());
      if (at >= 0) {
        host.append(snippet.slice(0, at));
        const mark = document.createElement('mark');
        mark.className = 'lightink-reader-sidebar-hit-mark';
        mark.textContent = snippet.slice(at, at + query.length);
        host.append(mark, snippet.slice(at + query.length));
        return;
      }
    }
    host.textContent = snippet;
  };

  const appendHits = (hits: readonly SearchHitView[], showEmpty: boolean): void => {
    if (hits.length === 0) {
      if (showEmpty) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'lightink-reader-sidebar-empty';
        emptyItem.textContent = deps.t('reader.search.empty');
        list.appendChild(emptyItem);
      }
      return;
    }
    for (const hit of hits) {
      const li = document.createElement('li');
      li.className = 'lightink-reader-sidebar-item lightink-reader-sidebar-hit';
      li.classList.toggle('is-current', hit.current);
      li.dataset.searchKey = hit.key;
      if (hit.location !== null) {
        const where = document.createElement('span');
        where.className = 'lightink-reader-sidebar-location';
        where.textContent = hit.location;
        li.appendChild(where);
      }
      const snippet = document.createElement('span');
      snippet.className = 'lightink-reader-sidebar-text';
      paintSnippet(snippet, hit.snippet);
      li.appendChild(snippet);
      li.addEventListener('click', () => search?.onJump(hit.key));
      list.appendChild(li);
    }
  };

  /**
   * 「搜索正文」分类的命中列表增量渲染。全书扫描每批发布都会重进渲染：
   * 整表 replaceChildren 会在手指按下与抬起之间换掉节点，click 只落到列表
   * 容器上（点结果没反应），还让整个列表高频闪烁。扫描是追加型：已对齐的
   * 前缀行只校正 is-current，从第一处失配起重建尾部（查询变化 key 全换，
   * 自然退化为整表重建）。
   */
  const reconcileHitList = (hits: readonly SearchHitView[], showEmpty: boolean): void => {
    const rows = Array.from(list.children) as HTMLElement[];
    let prefix = 0;
    while (prefix < rows.length && prefix < hits.length) {
      const row = rows[prefix]!;
      const hit = hits[prefix]!;
      if (row.dataset.searchKey !== hit.key) {
        break;
      }
      row.classList.toggle('is-current', hit.current);
      prefix += 1;
    }
    for (const row of rows.slice(prefix)) {
      row.remove(); // 含空态/「加载更多」哨兵行：有状态尾部每批重建
    }
    appendHits(hits.slice(prefix), showEmpty && hits.length === 0);
  };

  /** 统一渲染：标注分类下为标注列表，「全部」分类有查询时下方合并正文命中。 */
  const appendMore = (): void => {
    if (search?.onLoadMore === undefined) return;
    if (lastHitsState.searching !== true && lastHitsState.hasMore !== true) return;
    const more = document.createElement('li');
    more.className = 'lightink-reader-sidebar-more';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent =
      lastHitsState.searching === true
        ? deps.t('reader.search.searching')
        : deps.t('reader.search.more');
    button.disabled = lastHitsState.searching === true;
    button.addEventListener('click', () => search.onLoadMore?.());
    more.appendChild(button);
    list.appendChild(more);
    moreRelease = observeLoadMore(list, more, () => search.onLoadMore?.());
  };

  const renderCombined = (): void => {
    moreRelease?.();
    moreRelease = null;
    clearButton.hidden = noteSearchInput.value === '';
    root.classList.toggle('is-searching', lastHits !== null);
    if (lastHits !== null) {
      const current = lastHits.findIndex((hit) => hit.current);
      const searching = lastHitsState.searching === true;
      const pending = lastHitsState.pending === true;
      const quiet = searching || pending;
      noteStatus.dataset.searchEmpty = lastHits.length === 0 && !quiet ? 'true' : 'false';
      noteStatus.textContent =
        lastHits.length === 0 && pending
          ? ''
          : lastHits.length === 0 && !searching
            ? deps.t('reader.search.empty')
            : searching
              ? `${lastHits.length}+`
              : current >= 0
                ? `${current + 1}/${lastHits.length}`
                : String(lastHits.length);
    } else {
      noteStatus.textContent = '';
      noteStatus.dataset.searchEmpty = 'false';
    }
    if (currentFilter === 'document') {
      // 位图格式（漫画）无文本层：正文搜索固定为不支持空态，不回退「无结果」。
      if (unsupported()) {
        list.replaceChildren();
        const unsupportedItem = document.createElement('li');
        unsupportedItem.className = 'lightink-reader-sidebar-empty';
        unsupportedItem.textContent = deps.t('reader.search.unsupported');
        list.appendChild(unsupportedItem);
        return;
      }
      if (lastHits === null) {
        // 空查询：列表留白，搜索框本身就是提示（手机端搜索页常见做法）。
        list.replaceChildren();
        return;
      }
      reconcileHitList(
        lastHits,
        lastHitsState.searching !== true && lastHitsState.pending !== true,
      );
      appendMore();
      return;
    }
    list.replaceChildren();
    const kindFilter: AnnotationKind | undefined =
      currentFilter === 'all' ? undefined : currentFilter;
    // 列表必经 filterAnnotations：tombstone（已删除记录）永不出列。
    const visible = filterAnnotations(lastAnnotations, {
      query: annotationQuery,
      kind: kindFilter,
      color: currentColor === 'all' ? undefined : currentColor,
    });
    visible.sort(byDocumentPosition);
    for (const annotation of visible) {
      list.appendChild(renderItem(annotation));
    }
    if (lastHits !== null) {
      appendHits(lastHits, false);
      appendMore();
    }
    if (visible.length === 0 && (lastHits === null || lastHits.length === 0)) {
      const empty = document.createElement('li');
      empty.className = 'lightink-reader-sidebar-empty';
      // 区分无标注、搜索无命中（标注与正文都没有）、类型/颜色筛无匹配。
      // 空态以「过滤后可见」为判定基线：全部记录都是 tombstone 时与
      // 无标注同文案，不再失真为筛选空态。
      const liveCount = filterAnnotations(lastAnnotations).length;
      empty.textContent =
        liveCount === 0
          ? deps.t('annotation.empty')
          : annotationQuery.trim() !== ''
            ? deps.t('reader.search.empty')
            : deps.t('annotation.filter.empty');
      list.appendChild(empty);
    }
  };

  const renderList = (annotations: readonly Annotation[]): void => {
    lastAnnotations = annotations;
    lastHits = null;
    lastHitsState = {};
    renderCombined();
  };

  const renderHits = (hits: readonly SearchHitView[], state: SearchHitsState = {}): void => {
    if (unsupported()) {
      // 不支持的格式永远没有正文命中：保持「未搜索」状态由不支持空态承接。
      lastHits = null;
      lastHitsState = {};
    } else {
      lastHits = hits;
      lastHitsState = state;
    }
    renderCombined();
  };

  const activateDocumentFilter = (): void => {
    if (documentCategoryVisible() && currentFilter !== 'document') {
      currentFilter = 'document';
      applyFilter();
      syncSearchMode();
    }
  };

  return {
    element: root,
    render: renderList,
    renderHits,
    setSearchQuery(query) {
      if (query.trim() !== '') {
        activateDocumentFilter();
      }
      noteSearchInput.value = query;
      annotationQuery = query;
      clearButton.hidden = query === '';
    },
    getSearchQuery() {
      return noteSearchInput.value;
    },
    focusSearch() {
      activateDocumentFilter();
      noteSearchInput.focus({ preventScroll: true });
      noteSearchInput.select();
    },
    destroy() {
      moreRelease?.();
      moreRelease = null;
      document.removeEventListener('pointerdown', onPointerDownOutside);
      unbindQuery();
      root.remove();
    },
  };
}
