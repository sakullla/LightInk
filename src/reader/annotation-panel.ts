/**
 * `annotation-panel` — 统一融合标注搜索面板（R2/R8，替代 annotation-sidebar
 * 与 search-sheet）。
 *
 * 单一组件承载两件事：
 * - 标注笔记本：本书全部书签/高亮/笔记按文档位置排序，范围/颜色筛选
 *   （搜索框下常显 chips），点击跳转、编辑备注、删除（删除由宿主走
 *   removeAnnotation 产出 tombstone，本组件列表永远经 filterAnnotations
 *   过滤，tombstone 不出列）；
 * - 同一查询框双语义检索：标注范围下本地筛标注；「全部」范围有查询时正文
 *   命中合并渲染；「正文」范围只检索全书（可选 `search`）。
 *
 * 双端同一实现：桌面经 pinFixedOverlay 侧栏形态钉在阅读区右侧；触屏由宿主
 * portal 到 body，触屏是铺满阅读器的全页窗口。范围 chips 常显，
 * 选「正文」只换检索语义与占位符，不改搜索框骨架。
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

/** 互斥范围 chips：全部 / 高亮 / 笔记 / 书签；「正文」按需插入全部之后。 */
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
  /** 本条命中在 snippet 内的 [markStart, markEnd)；有则只高亮这一处。 */
  markStart?: number;
  markEnd?: number;
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
 * （pinFixedOverlay）；触屏 portal 到 body，始终是独立的 is-touch-sheet
 * 弹窗。范围 chips 常显，不改搜索框骨架。触屏为铺满视口的全页窗口，
 * 不留阅读器底栏。
 */
export function createAnnotationPanel(deps: AnnotationPanelDeps): AnnotationPanel {
  const root = document.createElement('aside');
  root.className = 'lightink-reader-sidebar lightink-reader-annotation-panel';
  root.setAttribute('aria-label', deps.t('annotation.sidebar'));
  root.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'lightink-reader-sidebar-header';
  const title = document.createElement('span');
  title.className = 'lightink-reader-sidebar-title';
  title.textContent = deps.t('annotation.sidebar');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-sidebar-close';
  close.textContent = '×';
  close.setAttribute('aria-label', deps.t('annotation.closeSidebar'));
  close.setAttribute('title', deps.t('annotation.closeSidebar'));
  close.addEventListener('click', () => deps.onClose?.());
  header.append(title, close);

  const noteField = document.createElement('div');
  noteField.className = 'lightink-reader-sidebar-search lightink-reader-sidebar-note-search';
  noteField.setAttribute('role', 'search');
  // 填充胶囊：放大镜 + 输入 + 命中计数 + 清空，聚焦环挂在胶囊上。
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
  const noteStatus = document.createElement('span');
  noteStatus.className = 'lightink-reader-sidebar-search-status';
  noteStatus.setAttribute('aria-live', 'polite');
  searchPill.append(searchIcon, noteSearchInput, noteStatus, clearButton);
  noteField.append(searchPill);

  const scopePanel = document.createElement('div');
  scopePanel.className = 'lightink-reader-sidebar-search-scope';
  scopePanel.setAttribute('role', 'group');
  scopePanel.setAttribute('aria-label', deps.t('reader.search.scope'));
  const scopeList = document.createElement('div');
  scopeList.className = 'lightink-reader-sidebar-search-scope-list';
  scopeList.setAttribute('role', 'tablist');
  const filterButtons = new Map<AnnotationFilter, HTMLButtonElement>();
  let currentFilter: AnnotationFilter = 'all';

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
  const hitKeyFromEvent = (event: Event): string | null => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('button') !== null) {
      return null;
    }
    const hit = target.closest<HTMLElement>('[data-search-key]');
    if (hit === null || !list.contains(hit)) {
      return null;
    }
    return hit.dataset.searchKey ?? null;
  };
  list.addEventListener('click', (event) => {
    const key = hitKeyFromEvent(event);
    if (key !== null && key !== '') {
      deps.search?.onJump(key);
    }
  });

  const applyFilter = (): void => {
    for (const [filter, button] of filterButtons) {
      const active = filter === currentFilter;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('lightink-reader-sidebar-search-scope-option--active', active);
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
    button.setAttribute('role', 'tab');
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

  /**
   * 输入框描述随范围切换：标注范围下筛选标注，「正文」范围下检索全书。
   * 不改弹窗骨架——范围 chips 与搜索胶囊始终留在同一 sheet 里。
   */
  const syncSearchMode = (): void => {
    const documentMode = currentFilter === 'document' && documentCategoryVisible();
    const label = deps.t(
      documentMode ? 'reader.search.document' : 'annotation.search.placeholder',
    );
    noteSearchInput.placeholder = label;
    noteSearchInput.setAttribute('aria-label', label);
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

  /** 命中片段只高亮本条 [start, end)，避免片段里另一处同词被点进去却跳到本行 key。 */
  const paintSnippet = (host: HTMLElement, hit: SearchHitView): void => {
    const snippet = hit.snippet;
    const markStart = hit.markStart;
    const markEnd = hit.markEnd;
    if (
      markStart !== undefined &&
      markEnd !== undefined &&
      markStart >= 0 &&
      markEnd > markStart &&
      markEnd <= snippet.length
    ) {
      if (markStart > 0) {
        host.append(snippet.slice(0, markStart));
      }
      const mark = document.createElement('mark');
      mark.className = 'lightink-reader-sidebar-hit-mark';
      mark.textContent = snippet.slice(markStart, markEnd);
      host.append(mark);
      if (markEnd < snippet.length) {
        host.append(snippet.slice(markEnd));
      }
      return;
    }
    const query = noteSearchInput.value.trim();
    if (query === '') {
      host.textContent = snippet;
      return;
    }
    const hay = snippet.toLowerCase();
    const needle = query.toLowerCase();
    if (needle.length === 0 || hay.length !== snippet.length) {
      host.textContent = snippet;
      return;
    }
    const at = hay.indexOf(needle);
    if (at < 0) {
      host.textContent = snippet;
      return;
    }
    if (at > 0) {
      host.append(snippet.slice(0, at));
    }
    const mark = document.createElement('mark');
    mark.className = 'lightink-reader-sidebar-hit-mark';
    mark.textContent = snippet.slice(at, at + query.length);
    host.append(mark);
    if (at + query.length < snippet.length) {
      host.append(snippet.slice(at + query.length));
    }
  };

  const appendHits = (
    hits: readonly SearchHitView[],
    showEmpty: boolean,
    previousLocation: string | null = null,
  ): void => {
    if (hits.length === 0) {
      if (showEmpty) {
        const emptyItem = document.createElement('li');
        emptyItem.className = 'lightink-reader-sidebar-empty';
        emptyItem.textContent = deps.t('reader.search.empty');
        list.appendChild(emptyItem);
      }
      return;
    }
    let lastLocation = previousLocation;
    for (const hit of hits) {
      const li = document.createElement('li');
      li.className = 'lightink-reader-sidebar-item lightink-reader-sidebar-hit';
      li.classList.toggle('is-current', hit.current);
      li.dataset.searchKey = hit.key;
      if (hit.location !== null && hit.location !== lastLocation) {
        const where = document.createElement('span');
        where.className = 'lightink-reader-sidebar-location';
        where.textContent = hit.location;
        li.appendChild(where);
      }
      lastLocation = hit.location;
      const snippet = document.createElement('span');
      snippet.className = 'lightink-reader-sidebar-text';
      paintSnippet(snippet, hit);
      li.appendChild(snippet);
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
    const rows = Array.from(list.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement &&
        (node.classList.contains('lightink-reader-sidebar-hit') ||
          node.classList.contains('lightink-reader-sidebar-empty') ||
          node.classList.contains('lightink-reader-sidebar-more')),
    );
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
    const previousLocation = prefix > 0 ? (hits[prefix - 1]?.location ?? null) : null;
    appendHits(hits.slice(prefix), showEmpty && hits.length === 0, previousLocation);
  };

  /** 统一渲染：标注分类下为标注列表，「全部」分类有查询时下方合并正文命中。 */
  const appendMore = (): void => {
    if (search?.onLoadMore === undefined) return;
    if (lastHitsState.searching !== true && lastHitsState.hasMore !== true) return;
    const more = document.createElement('li');
    more.className = 'lightink-reader-sidebar-more';
    more.classList.toggle('is-busy', lastHitsState.searching === true);
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
    const kindFilter: AnnotationKind | undefined =
      currentFilter === 'all' ? undefined : currentFilter;
    // 列表必经 filterAnnotations：tombstone（已删除记录）永不出列。
    const visible = filterAnnotations(lastAnnotations, {
      query: annotationQuery,
      kind: kindFilter,
      color:
        colorFiltersVisible(currentFilter) && currentColor !== 'all'
          ? currentColor
          : undefined,
    });
    visible.sort(byDocumentPosition);
    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains('lightink-reader-sidebar-hit')) continue;
      child.remove();
    }
    const firstHit = list.querySelector(':scope > .lightink-reader-sidebar-hit');
    for (const annotation of visible) {
      list.insertBefore(renderItem(annotation), firstHit);
    }
    reconcileHitList(lastHits ?? [], false);
    if (lastHits !== null) {
      appendMore();
    }
    if (visible.length === 0 && (lastHits === null || lastHits.length === 0)) {
      const quiet =
        lastHits !== null &&
        (lastHitsState.searching === true || lastHitsState.pending === true);
      if (quiet) {
        // 正文检索进行中：不要用「无标注」空态盖住等待态。
        return;
      }
      const empty = document.createElement('li');
      empty.className = 'lightink-reader-sidebar-empty';
      // 区分无标注、搜索无命中（标注与正文都没有）、类型/颜色筛无匹配。
      // 空态以「过滤后可见」为判定基线：全部记录都是 tombstone 时与
      // 无标注同文案，不再失真为筛选空态。
      const liveCount = filterAnnotations(lastAnnotations).length;
      empty.textContent =
        lastHits !== null
          ? deps.t('reader.search.empty')
          : liveCount === 0
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

  return {
    element: root,
    render: renderList,
    renderHits,
    setSearchQuery(query) {
      noteSearchInput.value = query;
      annotationQuery = query;
      clearButton.hidden = query === '';
    },
    getSearchQuery() {
      return noteSearchInput.value;
    },
    focusSearch() {
      noteSearchInput.focus({ preventScroll: true });
      noteSearchInput.select();
    },
    destroy() {
      moreRelease?.();
      moreRelease = null;
      unbindQuery();
      root.remove();
    },
  };
}
