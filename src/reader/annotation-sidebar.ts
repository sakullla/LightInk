/**
 * `annotation-sidebar` — 本书标注笔记本（R5）。
 *
 * 列出当前文档的高亮/书签/笔记：搜摘录与备注、按类型和颜色筛、显示定位、
 * 点击跳转、改备注、删除。可选 `search` 仍是书内正文搜索，与标注搜索并存。
 * 纯 DOM 装配；查询语义走 annotations.ts 的 filterAnnotations。render 全量重绘，
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

type AnnotationFilter = 'all' | AnnotationKind;
type ColorFilter = 'all' | AnnotationColor;

const FILTERS: readonly AnnotationFilter[] = ['all', 'highlight', 'bookmark', 'note'];

function filterLabelKey(filter: AnnotationFilter): MessageKey {
  return filter === 'all' ? 'annotation.filter.all' : `annotation.kind.${filter}`;
}

export interface SearchHitView {
  key: string;
  snippet: string;
  location: string | null;
  current: boolean;
}

export interface AnnotationSidebarSearch {
  onQuery: (query: string) => void;
  onJump: (key: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClear: () => void;
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
  renderHits(hits: readonly SearchHitView[]): void;
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
  noteField.appendChild(noteSearchInput);

  // 类型筛选：all + 三种 kind，aria-pressed 表达当前筛选。
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
      () => {
        currentFilter = filter;
        applyFilter();
        renderList(lastAnnotations);
      },
    );
    filterButtons.set(filter, button);
    filters.appendChild(button);
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
      renderList(lastAnnotations);
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
        renderList(lastAnnotations);
      },
    );
    colorButtons.set(color, button);
    colors.appendChild(button);
  }

  const search = deps.search;
  let searchInput: HTMLInputElement | null = null;
  let searchStatus: HTMLElement | null = null;
  let annotationQuery = '';

  noteSearchInput.addEventListener('input', () => {
    annotationQuery = noteSearchInput.value;
    renderList(lastAnnotations);
  });
  noteSearchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || noteSearchInput.value === '') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    noteSearchInput.value = '';
    annotationQuery = '';
    renderList(lastAnnotations);
  });

  if (search !== undefined) {
    const field = document.createElement('div');
    field.className = 'lightink-reader-sidebar-search';
    field.setAttribute('role', 'search');
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'lightink-reader-sidebar-search-input';
    searchInput.setAttribute('aria-label', deps.t('reader.search.document'));
    searchInput.placeholder = deps.t('reader.search.document');
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    searchInput.addEventListener('input', () => search.onQuery(searchInput!.value));
    searchStatus = document.createElement('span');
    searchStatus.className = 'lightink-reader-sidebar-search-status';
    searchStatus.setAttribute('aria-live', 'polite');
    field.append(searchInput, searchStatus);
    const noteLabel = document.createElement('label');
    noteLabel.className = 'lightink-reader-sidebar-search-label';
    noteLabel.textContent = deps.t('annotation.search.placeholder');
    const noteWrap = document.createElement('div');
    noteWrap.className = 'lightink-reader-sidebar-search-mode lightink-reader-sidebar-search-mode--notes';
    noteWrap.append(noteLabel, noteField);
    const docLabel = document.createElement('label');
    docLabel.className = 'lightink-reader-sidebar-search-label';
    docLabel.textContent = deps.t('reader.search.document');
    const docWrap = document.createElement('div');
    docWrap.className = 'lightink-reader-sidebar-search-mode lightink-reader-sidebar-search-mode--document';
    docWrap.append(docLabel, field);
    const stack = document.createElement('div');
    stack.className = 'lightink-reader-sidebar-search-stack';
    stack.append(noteWrap, docWrap);
    root.append(header, stack, filters, colors, list);
    root.addEventListener('keydown', (event) => {
      if (event.target === noteSearchInput) {
        return;
      }
      if (event.key === 'Enter') {
        if (event.target instanceof HTMLButtonElement) {
          return;
        }
        event.preventDefault();
        if (event.shiftKey) {
          search.onPrev();
        } else {
          search.onNext();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (searchInput !== null && searchInput.value !== '') {
          searchInput.value = '';
          search.onClear();
          return;
        }
        if (noteSearchInput.value !== '') {
          noteSearchInput.value = '';
          annotationQuery = '';
          renderList(lastAnnotations);
          return;
        }
        deps.onClose?.();
      }
    });
  } else {
    const noteLabel = document.createElement('label');
    noteLabel.className = 'lightink-reader-sidebar-search-label';
    noteLabel.textContent = deps.t('annotation.search.placeholder');
    const stack = document.createElement('div');
    stack.className = 'lightink-reader-sidebar-search-stack';
    stack.append(noteLabel, noteField);
    root.append(header, stack, filters, colors, list);
  }

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
  applyFilter();

  const renderList = (annotations: readonly Annotation[]): void => {
    lastAnnotations = annotations;
    root.classList.remove('is-searching');
    if (searchStatus !== null) {
      searchStatus.textContent = '';
      searchStatus.dataset.searchEmpty = 'false';
    }
    list.replaceChildren();
    const visible = filterAnnotations(annotations, {
      query: annotationQuery,
      kind: currentFilter === 'all' ? undefined : currentFilter,
      color: currentColor === 'all' ? undefined : currentColor,
    });
    if (visible.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'lightink-reader-sidebar-empty';
      // 区分无标注、标注搜索无命中、类型/颜色筛无匹配。
      empty.textContent =
        annotations.length === 0
          ? deps.t('annotation.empty')
          : annotationQuery.trim() !== ''
            ? deps.t('reader.search.empty')
            : deps.t('annotation.filter.empty');
      list.appendChild(empty);
      return;
    }
    for (const annotation of visible) {
      list.appendChild(renderItem(annotation));
    }
  };

  const renderHits = (hits: readonly SearchHitView[]): void => {
    root.classList.add('is-searching');
    list.replaceChildren();
    const empty = hits.length === 0;
    if (searchStatus !== null) {
      const current = hits.findIndex((hit) => hit.current);
      searchStatus.dataset.searchEmpty = empty ? 'true' : 'false';
      searchStatus.textContent = empty
        ? deps.t('reader.search.empty')
        : current >= 0
          ? `${current + 1}/${hits.length}`
          : String(hits.length);
    }
    if (empty) {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'lightink-reader-sidebar-empty';
      emptyItem.textContent = deps.t('reader.search.empty');
      list.appendChild(emptyItem);
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

  return {
    element: root,
    render: renderList,
    renderHits,
    setSearchQuery(query) {
      if (searchInput !== null) {
        searchInput.value = query;
      }
    },
    getSearchQuery() {
      return searchInput?.value ?? '';
    },
    focusSearch() {
      searchInput?.focus({ preventScroll: true });
      searchInput?.select();
    },
    destroy() {
      root.remove();
    },
  };
}
