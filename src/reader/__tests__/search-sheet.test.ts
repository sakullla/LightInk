// @vitest-environment jsdom

/**
 * Contract for `src/reader/search-sheet.ts` (R5 / R6 — 触屏独立底栏搜索层):
 *
 * `createSearchSheet(deps)` builds the touch-only bottom-sheet search layer
 * that reader-view opens from `openSearch` when the touch flag is set
 * (desktop keeps the annotation-sidebar path). Deps:
 *   - `t(key, vars?)`: i18n lookup (`reader.search.*` keys; the empty state
 *     uses `reader.search.empty`).
 *   - `onQuery(query)`: query box changed — host runs the PDF/flow search
 *     and replays `renderHits`; an emptied box hands over '' so the host
 *     tears down the search session.
 *   - `onJump(key)`: jump to a hit by its search key; the sheet stays open.
 *   - `onClose?()`: notified once per open→closed transition.
 *
 * Returned `SearchSheet`:
 *   - `element`: the sheet root itself carries `lightink-reader-search-sheet`,
 *     `lightink-reader-chrome-panel` and `is-touch-sheet`, so the existing
 *     chrome click-guard ignores taps inside it and the touch-sheet CSS
 *     (safe-area bottom padding) applies. Hidden while closed.
 *   - `isOpen()` / `open(seed?)` / `close()`: `open` reveals the layer,
 *     prefills the query box with a non-empty seed (selection prefill) and
 *     focuses it; an empty/omitted seed keeps the previous query. `close`
 *     hides the layer, returns whether it was open (dismissOverlay wiring)
 *     and fires `onClose` once per close (idempotent).
 *   - `renderHits(hits)`: hits use the sidebar's `SearchHitView` shape
 *     (`key`/`snippet`/`location`/`current`). Each hit renders with
 *     `data-search-key`, the current one with `is-current`. Tapping a hit
 *     calls `onJump(key)` without closing the layer. A query with no hits
 *     shows the `reader.search.empty` copy — never a sidebar fallback.
 *   - `setQuery` / `getQuery` / `focusInput` / `destroy`.
 *
 * Dismissal (触屏返回分层): one Escape — including the synthesized Escape
 * from the Android system back — is consumed by the layer and closes only
 * this layer, never the book; a tap on blank page space closes it through
 * the chrome overlay wiring; taps inside the sheet do not dismiss it. The
 * integration block below exercises the reader-view wiring
 * (`isOverlayOpen` / `dismissOverlay`) against `createReaderChrome`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderChrome } from '../reader-chrome.js';
import { SEARCH_QUERY_DEBOUNCE_MS } from '../search-panel.js';
import { createSearchSheet } from '../search-sheet.js';

const HITS = [
  { key: '0:0:6:13', snippet: 'alpha keyword', location: '第 1 章', current: true },
  { key: '1:0:0:7', snippet: 'keyword again', location: '第 2 章', current: false },
] as const;

function sheetDeps(overrides: Record<string, unknown> = {}) {
  return {
    t: (key: string) => key,
    onQuery: vi.fn(),
    onJump: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function mountSheet(overrides: Record<string, unknown> = {}) {
  const deps = sheetDeps(overrides);
  const sheet = createSearchSheet(deps);
  document.body.append(sheet.element);
  return { sheet, deps };
}

function queryInput(sheet: { element: HTMLElement }): HTMLInputElement {
  const input = sheet.element.querySelector('input');
  expect(input, 'search sheet must contain a query box').toBeTruthy();
  return input!;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('createSearchSheet layer', () => {
  it('starts closed as a touch bottom-sheet panel', () => {
    const { sheet } = mountSheet();

    expect(sheet.isOpen()).toBe(false);
    expect(sheet.element.hidden).toBe(true);
    expect(sheet.element.classList.contains('lightink-reader-search-sheet')).toBe(true);
    expect(sheet.element.classList.contains('lightink-reader-chrome-panel')).toBe(true);
    expect(sheet.element.classList.contains('is-touch-sheet')).toBe(true);
    expect(sheet.element.querySelector('input')).toBeTruthy();
  });

  it('open() reveals the layer, prefills the selection seed and focuses the query box', () => {
    const { sheet } = mountSheet();

    sheet.open('keyword');
    expect(sheet.isOpen()).toBe(true);
    expect(sheet.element.hidden).toBe(false);
    const input = queryInput(sheet);
    expect(input.value).toBe('keyword');
    expect(sheet.getQuery()).toBe('keyword');
    expect(document.activeElement).toBe(input);
  });

  it('open() with an empty seed keeps the previous query', () => {
    const { sheet } = mountSheet();

    sheet.open('keyword');
    sheet.open('');
    expect(queryInput(sheet).value).toBe('keyword');
    sheet.open();
    expect(queryInput(sheet).value).toBe('keyword');

    sheet.open('other');
    expect(queryInput(sheet).value).toBe('other');
  });

  it('typing drives onQuery after a pause and an emptied box hands over immediately', () => {
    vi.useFakeTimers();
    const { sheet, deps } = mountSheet();
    sheet.open();

    const input = queryInput(sheet);
    input.value = 'al';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = 'alpha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(deps.onQuery).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_QUERY_DEBOUNCE_MS);
    expect(deps.onQuery).toHaveBeenCalledTimes(1);
    expect(deps.onQuery).toHaveBeenLastCalledWith('alpha');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(deps.onQuery).toHaveBeenLastCalledWith('');
    vi.useRealTimers();
  });

  it('does not search while an IME composition is open', () => {
    const { sheet, deps } = mountSheet();
    sheet.open();
    const input = queryInput(sheet);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'jian';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(deps.onQuery).not.toHaveBeenCalled();
    input.value = '鉴';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(deps.onQuery).toHaveBeenCalledTimes(1);
    expect(deps.onQuery).toHaveBeenLastCalledWith('鉴');
  });

  it('renders hits with data-search-key, marks the current one and jumps without closing', () => {
    const { sheet, deps } = mountSheet();
    sheet.open('keyword');
    sheet.renderHits([...HITS]);

    const items = sheet.element.querySelectorAll<HTMLElement>('[data-search-key]');
    expect(items).toHaveLength(2);
    const first = sheet.element.querySelector<HTMLElement>('[data-search-key="0:0:6:13"]');
    const second = sheet.element.querySelector<HTMLElement>('[data-search-key="1:0:0:7"]');
    expect(first?.classList.contains('is-current')).toBe(true);
    expect(second?.classList.contains('is-current')).toBe(false);
    expect(first?.textContent).toContain('alpha keyword');
    expect(first?.textContent).toContain('第 1 章');

    second!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(deps.onJump).toHaveBeenCalledWith('1:0:0:7');
    expect(sheet.isOpen()).toBe(true);
    expect(deps.onClose).not.toHaveBeenCalled();
  });

  it('shows the empty-state copy on no hits instead of falling back anywhere', () => {
    const { sheet } = mountSheet();
    sheet.open('zzz');

    sheet.renderHits([]);
    expect(sheet.element.querySelectorAll('[data-search-key]')).toHaveLength(0);
    expect(sheet.element.textContent).toContain('reader.search.empty');
    expect(sheet.isOpen()).toBe(true);

    sheet.renderHits([...HITS]);
    expect(sheet.element.textContent).not.toContain('reader.search.empty');
    expect(sheet.element.querySelectorAll('[data-search-key]')).toHaveLength(2);
  });

  it('does not flash empty copy or a load-more row during a quiet pending search', () => {
    const { sheet } = mountSheet();
    sheet.open('keyword');
    sheet.renderHits([], { pending: true });
    expect(sheet.element.querySelector('.lightink-reader-search-sheet-empty')).toBeNull();
    expect(sheet.element.querySelector('.lightink-reader-search-sheet-more')).toBeNull();
    expect(sheet.element.textContent).not.toContain('reader.search.empty');
  });

  it('keeps the list usable while more hits are still arriving', () => {
    const onLoadMore = vi.fn();
    const { sheet } = mountSheet({ onLoadMore });
    sheet.open('keyword');
    sheet.renderHits([...HITS], { searching: true, hasMore: true });

    expect(sheet.element.textContent).toContain('2+');
    expect(sheet.element.querySelector('.lightink-reader-search-sheet-more button')?.textContent).toBe(
      'reader.search.searching',
    );
    sheet.renderHits([...HITS], { searching: false, hasMore: true });
    const more = sheet.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-search-sheet-more button',
    );
    expect(more?.disabled).toBe(false);
    more!.click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('closes from its own Escape (Android back synthesizes the same key) and consumes it', () => {
    const { sheet, deps } = mountSheet();
    sheet.open('keyword');

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    queryInput(sheet).dispatchEvent(escape);
    expect(sheet.isOpen()).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(deps.onClose).toHaveBeenCalledTimes(1);
  });

  it('close() reports whether the layer was open and notifies once per close', () => {
    const { sheet, deps } = mountSheet();
    sheet.open('keyword');

    expect(sheet.close()).toBe(true);
    expect(sheet.isOpen()).toBe(false);
    expect(sheet.element.hidden).toBe(true);
    expect(deps.onClose).toHaveBeenCalledTimes(1);

    expect(sheet.close()).toBe(false);
    expect(deps.onClose).toHaveBeenCalledTimes(1);
  });

  it('destroy() removes the layer from the document', () => {
    const { sheet } = mountSheet();
    sheet.open('keyword');
    sheet.destroy();
    expect(document.body.contains(sheet.element)).toBe(false);
  });
});

describe('search sheet wired as a reader-chrome overlay (touch)', () => {
  function mountIntegration() {
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    host.append(page);
    document.body.append(host);

    const deps = sheetDeps();
    const sheet = createSearchSheet(deps);
    const chromeDeps = {
      touchMode: true,
      returnToShelf: vi.fn(),
      toggleSidebar: vi.fn(),
      isSidebarVisible: vi.fn(() => false),
      isSelectionToolbarVisible: vi.fn(() => false),
      hideSelectionToolbar: vi.fn(),
      isOverlayOpen: () => sheet.isOpen(),
      dismissOverlay: () => sheet.close(),
    };
    const chrome = createReaderChrome(host, chromeDeps);
    host.append(sheet.element);
    return { host, page, sheet, sheetDeps: deps, chrome, chromeDeps };
  }

  it('one Escape closes only the search layer, never the book or the sidebar', () => {
    const { sheet, sheetDeps: deps, chrome, chromeDeps } = mountIntegration();
    chrome.reveal();
    sheet.open('keyword');

    queryInput(sheet).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(sheet.isOpen()).toBe(false);
    expect(deps.onClose).toHaveBeenCalledTimes(1);
    expect(chrome.isRevealed()).toBe(true);
    expect(chromeDeps.returnToShelf).not.toHaveBeenCalled();
    expect(chromeDeps.toggleSidebar).not.toHaveBeenCalled();

    // Next Escape only hides the chrome bar; the book still stays open.
    expect(chrome.handleEscape()).toBe(true);
    expect(chrome.isRevealed()).toBe(false);
    expect(chromeDeps.returnToShelf).not.toHaveBeenCalled();
  });

  it('a tap on blank page space closes the sheet and keeps the book open', () => {
    const { page, sheet, chrome, chromeDeps } = mountIntegration();
    chrome.reveal();
    sheet.open('keyword');

    page.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
    );
    expect(sheet.isOpen()).toBe(false);
    expect(chromeDeps.returnToShelf).not.toHaveBeenCalled();
  });

  it('taps inside the sheet jump to hits without dismissing the layer', () => {
    const { sheet, sheetDeps: deps, chrome } = mountIntegration();
    chrome.reveal();
    sheet.open('keyword');
    sheet.renderHits([...HITS]);

    sheet.element
      .querySelector<HTMLElement>('[data-search-key="1:0:0:7"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(deps.onJump).toHaveBeenCalledWith('1:0:0:7');
    expect(sheet.isOpen()).toBe(true);
    expect(deps.onClose).not.toHaveBeenCalled();
  });
});
