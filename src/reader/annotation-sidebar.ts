/**
 * `annotation-sidebar` — 本书标注笔记本（R5）。
 *
 * 列出当前文档的高亮/书签/笔记：搜摘录与备注、按类型和颜色筛、显示定位、
 * 点击跳转、改备注、删除。分类行追加「搜索正文」分类后，同一输入框检索全书
 * （可选 `search`，Markdown 宿主不提供）。纯 DOM 装配；查询语义走 annotations.ts
 * 的 filterAnnotations。render 全量重绘，筛选与标注搜索状态在闭包内跨 render 保留。
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

const FILTERS: readonly AnnotationFilter[] = ['all', 'highlight', 'bookmark', 'note'];

function filterLabelKey(filter: AnnotationFilter): MessageKey {
  if (filter === 'all') return 'annotation.filter.all';
  if (filter === 'document') return 'reader.search.document';
  return `annotation.kind.${filter}`;
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

export interface AnnotationSidebarSearch {
  onQuery: (query: string) => void;
  onJump: (key: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClear: () => void;
  onLoadMore?: () => void;
}

export interface AnnotationSidebarDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 点击某条标注时跳转到其位置（由 reader-view 实现滚动/翻页）。 */
  onJump: (annotation: Annotation) => void;
  /** 可选：移除标注（由 reader-view 实现删除+保存）。 */
  onRemove?: (annotation: Annotation) => void;
  /** 可选：编辑备注（由 reader-view 唤起笔记弹层并保存）。 */
  onEditNote?: (annotation: Annotation) => void;
  /** Close the sidebar from its narrow-window drawer control. */
  onClose?: () => void;
  /** Reader-only document search. Markdown hosts omit this. */
  search?: AnnotationSidebarSearch;
}

export interface AnnotationSidebar {
  readonly element: HTMLElement;
  render(annotations: readonly Annotation[]): void;
  renderHits(hits: readonly SearchHitView[], state?: SearchHitsState): void;
  setSearchQuery(query: string): void;
  getSearchQuery(): string;
  focusSearch(): void;
  destroy(): void;
}

/** 每条标注的定位描述（侧栏显示用；cbz 无章节概念只给页码）。 */
function locationText(
  annotation: Annotation,
  t: AnnotationSidebarDeps['t'],
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
 * 创建标注侧栏。element 挂到 reader 视图；render 用当前标注集合重绘列表。
 */
export function createAnnotationSidebar(deps: AnnotationSidebarDeps): AnnotationSidebar {
  const root = document.createElement('aside');
  root.className = 'lightink-reader-sidebar';
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
  header.append(title, close);

  const noteField = document.createElement('div');
  noteField.className = 'lightink-reader-sidebar-search lightink-reader-sidebar-note-search';
  noteField.setAttribute('role', 'search');
  const noteSearchInput = document.createElement('input');
  noteSearchInput.type = 'text';
  noteSearchInput.className = 'lightink-reader-sidebar-note-search-input';
  noteSearchInput.setAttribute('aria-label', deps.t('annotation.search.placeholder'));
  noteSearchInput.placeholder = deps.t('annotation.search.placeholder');
  noteSearchInput.autocomplete = 'off';
  noteSearchInput.spellcheck = false;
  noteSearchInput.enterKeyHint = 'search';
  const noteStatus = document.createElement('span');
  noteStatus.className = 'lightink-reader-sidebar-search-status';
  noteStatus.setAttribute('aria-live', 'polite');
  noteField.append(noteSearchInput, noteStatus);

  // 分类筛选：all + 三种 kind；宿主提供正文搜索时追加「搜索正文」分类。
  // 同一个输入框：标注分类下筛选标注，正文分类下搜索正文。
  const filters = document.createElement('div');
  filters.className = 'lightink-reader-sidebar-filters';
  filters.setAttribute('role', 'group');
  const filterButtons = new Map<AnnotationFilter, HTMLButtonElement>();
  let currentFilter: AnnotationFilter = 'all';

  const colors = document.createElement('div');
  colors.className = 'lightink-reader-sidebar-filters lightink-reader-sidebar-colors';
  colors.setAttribute('role', 'group');
  const colorButtons = new Map<ColorFilter, HTMLButtonElement>();
  let currentColor: ColorFilter = 'all';

  const list = document.createElement('ul');
  list.className = 'lightink-reader-sidebar-list';

  const applyFilter = (): void => {
    for (const [filter, button] of filterButtons) {
      button.setAttribute('aria-pressed', filter === currentFilter ? 'true' : 'false');
      button.classList.toggle(
        'lightink-reader-sidebar-filter--active',
        filter === currentFilter,
      );
    }
    for (const [color, button] of colorButtons) {
      button.setAttribute('aria-pressed', color === currentColor ? 'true' : 'false');
      button.classList.toggle(
        'lightink-reader-sidebar-filter--active',
        color === currentColor,
      );
    }
  };

  for (const filter of FILTERS) {
    const button = createFilterButton(
      {
        className: 'lightink-reader-sidebar-filter',
        dataset: { kindFilter: filter },
        text: deps.t(filterLabelKey(filter)),
      },
      () => setFilter(filter),
    );
    filterButtons.set(filter, button);
    filters.appendChild(button);
  }

  const search = deps.search;
  if (search !== undefined) {
    const documentButton = createFilterButton(
      {
        className: 'lightink-reader-sidebar-filter',
        dataset: { kindFilter: 'document' },
        text: deps.t('reader.search.document'),
      },
      () => setFilter('document'),
    );
    filterButtons.set('document', documentButton);
    filters.appendChild(documentButton);
  }

  const allColor = createFilterButton(
    {
      className: 'lightink-reader-sidebar-filter lightink-reader-sidebar-color-filter',
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
        className: 'lightink-reader-sidebar-filter lightink-reader-sidebar-color-filter',
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

  const stack = document.createElement('div');
  stack.className = 'lightink-reader-sidebar-search-stack';
  stack.append(noteField);
  root.append(header, stack, filters, colors, list);

  /** 输入框描述随分类切换：标注分类下筛选标注，「搜索正文」分类下只检索全书。 */
  const syncSearchMode = (): void => {
    const documentMode = currentFilter === 'document' && search !== undefined;
    const label = deps.t(
      documentMode ? 'reader.search.document' : 'annotation.search.placeholder',
    );
    noteSearchInput.placeholder = label;
    noteSearchInput.setAttribute('aria-label', label);
    colors.hidden = documentMode;
  };

  const clearDocumentSearch = (): void => {
    if (lastHits !== null || currentFilter === 'document') search?.onClear();
    lastHits = null;
  };

  const setFilter = (filter: AnnotationFilter): void => {
    if (filter !== 'document') clearDocumentSearch();
    currentFilter = filter;
    applyFilter();
    syncSearchMode();
    if (search !== undefined && noteSearchInput.value.trim() !== '') {
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
    if (search !== undefined && currentFilter !== 'document') {
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
    search !== undefined &&
    (currentFilter === 'document' || (currentFilter === 'all' && currentColor === 'all'));

  const applyLocalQuery = (): void => {
    annotationQuery = noteSearchInput.value;
    if (search !== undefined && lastHits !== null && !documentSearchScope()) {
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
    if (search !== undefined && lastHits !== null) {
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
    if (event.key !== 'Escape' || noteSearchInput.value === '') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    noteSearchInput.value = '';
    annotationQuery = '';
    clearDocumentSearch();
    renderCombined();
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
        noteSearchInput.value = '';
        annotationQuery = '';
        clearDocumentSearch();
        renderCombined();
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
    const location = locationText(annotation, deps.t);
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
      snippet.textContent = hit.snippet;
      li.appendChild(snippet);
      li.addEventListener('click', () => search?.onJump(hit.key));
      list.appendChild(li);
    }
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
    root.classList.toggle('is-searching', lastHits !== null);
    list.replaceChildren();
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
      if (lastHits === null) {
        const prompt = document.createElement('li');
        prompt.className = 'lightink-reader-sidebar-empty';
        prompt.textContent = deps.t('reader.search.document');
        list.appendChild(prompt);
        return;
      }
      appendHits(lastHits, lastHitsState.searching !== true && lastHitsState.pending !== true);
      appendMore();
      return;
    }
    const kindFilter: AnnotationKind | undefined =
      currentFilter === 'all' ? undefined : currentFilter;
    const visible = filterAnnotations(lastAnnotations, {
      query: annotationQuery,
      kind: kindFilter,
      color: currentColor === 'all' ? undefined : currentColor,
    });
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
      empty.textContent =
        lastAnnotations.length === 0
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
    lastHits = hits;
    lastHitsState = state;
    renderCombined();
  };

  const activateDocumentFilter = (): void => {
    if (search !== undefined && currentFilter !== 'document') {
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
      activateDocumentFilter();
      noteSearchInput.value = query;
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
      unbindQuery();
      root.remove();
    },
  };
}
