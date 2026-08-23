/**
 * `search-sheet` — 触屏独立底栏搜索层（R5/R6）。
 *
 * 顶栏搜索入口在触屏旗标下打开的底栏层：查询框（选区 seed 预填）+ 命中列表。
 * 搜索算法与 overlay 高亮仍由宿主（reader-view）驱动——本层只回调 onQuery，
 * 收 `SearchHitView[]`（与标注侧栏同一形状）渲染，点命中回调 onJump 且层保持
 * 打开（连续查阅）。根元素同时携带 `lightink-reader-chrome-panel` 与
 * `is-touch-sheet`：既有 chrome 点击护栏忽略层内点按、底栏 sheet 样式
 * （含 --lightink-safe-bottom）直接适用。宿主把 isOpen/close 注册进
 * `isOverlayOpen`/`dismissOverlay` 即自动参与返回分层——点空白经
 * chrome 护栏关层；Escape（含 Android 返回合成的 Escape）由本层自行消费，
 * 一次只关本层、不合书。
 */

import type { MessageKey } from '../i18n/messages.js';
import type { SearchHitView, SearchHitsState } from './annotation-sidebar.js';
import { bindImeSafeQuery, observeLoadMore } from './search-panel.js';

/** 文案闭集（`reader.search.*`）；通过 copy 直传或 t 查询二选一注入。 */
export interface SearchSheetCopy {
  title: string;
  placeholder: string;
  empty: string;
  close: string;
}

export interface SearchSheetDeps {
  /** i18n 查询（copy 缺省时用 `reader.search.*` 键取文案）。 */
  t?: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 直传文案（优先于 t；reader-view 装配路径使用）。 */
  copy?: Partial<SearchSheetCopy>;
  /** 查询框内容变化时回调（宿主执行 PDF/流式搜索并回填 renderHits）。 */
  onQuery: (query: string) => void;
  /** 点命中跳转（层保持打开；宿主定位并以新的 current 重放 renderHits）。 */
  onJump?: (key: string) => void;
  /** 滚动到底或点「加载更多」时回调（宿主继续扫描 / 放出下一页命中）。 */
  onLoadMore?: () => void;
  /** 层每次从打开变为关闭时回调一次（同步控件条状态、按需清理会话）。 */
  onClose?: () => void;
}

export interface SearchSheet {
  /** 底栏层根元素（即 is-touch-sheet 面板本体），由宿主挂到阅读根上。 */
  readonly element: HTMLElement;
  /** 打开层：非空 seed 预填查询框，空/缺省保留上次查询；聚焦查询框。 */
  open(seed?: string): void;
  /** 关层；层原本打开返回 true（供 dismissOverlay 分层判定），幂等。 */
  close(): boolean;
  isOpen(): boolean;
  setQuery(query: string): void;
  getQuery(): string;
  focusInput(): void;
  /** 渲染命中列表；有查询但空命中时显示空态文案，不回退标注侧栏。 */
  renderHits(hits: readonly SearchHitView[], state?: SearchHitsState): void;
  destroy(): void;
}

/** 创建触屏搜索底栏层。仅触屏路径装配；桌面 openSearch 走标注侧栏不经此层。 */
export function createSearchSheet(deps: SearchSheetDeps): SearchSheet {
  const label = (key: keyof SearchSheetCopy): string => {
    const messageKey: MessageKey = `reader.search.${key}`;
    return deps.copy?.[key] ?? deps.t?.(messageKey) ?? messageKey;
  };
  const onJump = (key: string): void => {
    deps.onJump?.(key);
  };

  const root = document.createElement('section');
  root.className =
    'lightink-reader-chrome-panel lightink-reader-search-sheet is-touch-sheet';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', label('title'));

  const bar = document.createElement('div');
  bar.className = 'lightink-reader-search-sheet-bar';
  bar.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'lightink-reader-search-sheet-input';
  input.placeholder = label('placeholder');
  input.setAttribute('aria-label', label('title'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.enterKeyHint = 'search';

  const status = document.createElement('span');
  status.className = 'lightink-reader-search-sheet-status';
  status.setAttribute('aria-live', 'polite');

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-search-sheet-close';
  close.textContent = '×';
  close.setAttribute('aria-label', label('close'));
  close.setAttribute('title', label('close'));

  bar.append(input, status, close);

  const list = document.createElement('ul');
  list.className = 'lightink-reader-search-sheet-list';

  root.append(bar, list);

  let lastHits: readonly SearchHitView[] = [];
  let lastState: SearchHitsState = {};
  let moreRelease: (() => void) | null = null;

  const renderList = (): void => {
    moreRelease?.();
    moreRelease = null;
    list.replaceChildren();
    if (input.value.trim() === '') {
      status.textContent = '';
      return;
    }
    const searching = lastState.searching === true;
    const pending = lastState.pending === true;
    if (lastHits.length === 0 && !searching && !pending) {
      status.textContent = label('empty');
      const empty = document.createElement('li');
      empty.className = 'lightink-reader-search-sheet-empty';
      empty.textContent = label('empty');
      list.appendChild(empty);
      return;
    }
    if (lastHits.length === 0 && pending) {
      status.textContent = '';
      return;
    }
    const current = lastHits.findIndex((hit) => hit.current);
    const count = String(lastHits.length);
    status.textContent = searching
      ? `${count}+`
      : current >= 0
        ? `${current + 1}/${count}`
        : count;
    for (const hit of lastHits) {
      const li = document.createElement('li');
      li.className = 'lightink-reader-search-sheet-hit';
      li.classList.toggle('is-current', hit.current);
      li.dataset.searchKey = hit.key;
      if (hit.location !== null) {
        const where = document.createElement('span');
        where.className = 'lightink-reader-search-sheet-location';
        where.textContent = hit.location;
        li.appendChild(where);
      }
      const snippet = document.createElement('span');
      snippet.className = 'lightink-reader-search-sheet-text';
      snippet.textContent = hit.snippet;
      li.appendChild(snippet);
      // 点命中只跳转，不关层：宿主定位后重放 renderHits 校正 current。
      li.addEventListener('click', () => onJump(hit.key));
      list.appendChild(li);
    }
    if (searching || lastState.hasMore === true) {
      const more = document.createElement('li');
      more.className = 'lightink-reader-search-sheet-more';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = searching
        ? (deps.t?.('reader.search.searching') ?? 'reader.search.searching')
        : (deps.t?.('reader.search.more') ?? 'reader.search.more');
      button.disabled = searching;
      button.addEventListener('click', () => deps.onLoadMore?.());
      more.appendChild(button);
      list.appendChild(more);
      moreRelease = observeLoadMore(list, more, () => deps.onLoadMore?.());
    }
  };

  const doClose = (): boolean => {
    if (root.hidden) {
      return false;
    }
    root.hidden = true;
    deps.onClose?.();
    return true;
  };

  close.addEventListener('click', () => {
    doClose();
  });

  const unbindQuery = bindImeSafeQuery(input, (query) => {
    if (query.trim() === '') {
      lastHits = [];
      renderList();
    }
    deps.onQuery(query);
  });

  // Escape（键盘或 Android 返回合成）一次只关本层：本层消费掉事件，
  // 不再冒泡到 reader-chrome 的返回分层，避免同一次按键连关两层。
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    doClose();
  });

  const focusInput = (): void => {
    input.focus({ preventScroll: true });
    input.select();
  };

  return {
    element: root,
    open(seed?: string): void {
      root.hidden = false;
      if (seed !== undefined && seed.trim() !== '') {
        input.value = seed;
      }
      focusInput();
    },
    close: doClose,
    isOpen(): boolean {
      return !root.hidden;
    },
    setQuery(query: string): void {
      input.value = query;
    },
    getQuery(): string {
      return input.value;
    },
    focusInput,
    renderHits(hits: readonly SearchHitView[], state: SearchHitsState = {}): void {
      lastHits = hits;
      lastState = state;
      renderList();
    },
    destroy(): void {
      moreRelease?.();
      moreRelease = null;
      unbindQuery();
      root.remove();
    },
  };
}
