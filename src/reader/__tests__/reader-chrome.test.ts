// @vitest-environment jsdom

/**
 * Contract for `src/reader/reader-chrome.ts` (R1 / R4 / R5 + 搜索一等入口):
 *
 * `createReaderChrome(host, deps)` mounts an overlay on the reading host.
 * Text and PDF novels open with the top bar and progress footer already
 * expanded. Idle (~3500ms), a page click, and Escape do not collapse them.
 * The top bar carries:
 *   返回书架 · 目录 · 排版 · 书签 · 搜索 · 助手
 * 「返回书架」 is the first control and the only path that calls
 * `returnToShelf`. 目录 / 排版 / 搜索 / 助手 call `openOutline` /
 * `openTypography` / `openSearch` / `openAssistant`. 书签 calls
 * `toggleBookmark` and reflects `isBookmarked`. 搜索 lives in the tools
 * cluster. 助手 carries aria-haspopup/aria-expanded like the other dialogs.
 *
 * The bar is out of document flow (`position: absolute|fixed|sticky`) so
 * it does not change the reading area's top or height. The 24px edge band
 * still calls reveal, but seeing the bar does not depend on it.
 *
 * `handleEscape()` closes one layer and never calls `returnToShelf`
 * (window-level leftover Escape owns 合书). Order:
 *   selection toolbar → annotation sidebar → dismissOverlay().
 * Return true when a layer closed; false when nothing else is open.
 * Escape does not hide the bars.
 *
 * Touch mode keeps the same actions on the top bar. They may wrap. Hit
 * height stays 48px and the gap stays at least 8px. The footer is only
 * chapter + progress. Comics keep comic chrome; novel progress docks stay
 * suppressed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyConcealScene, defaultConcealPrefs, type ConcealPrefs } from '../../conceal/conceal-prefs.js';
import { translate } from '../../i18n/messages.js';
import {
  createReaderChrome,
  isReaderChromeEdge,
  parseReaderConcealOpacity,
  READER_CHROME_ACTIONS,
  READER_CHROME_EDGE_PX,
  READER_CHROME_TOUCH_GAP_PX,
  READER_CHROME_TOUCH_HIT_PX,
  READER_CONCEAL_REFUSAL_KEYS,
  shouldAttachReaderConcealBar,
  type ReaderChrome,
  type ReaderConcealBarLabels,
  type ReaderConcealRefusalKey,
} from '../reader-chrome.js';

const LABELS = ['返回书架', '目录', '排版', '书签', '搜索', '助手'] as const;
const THUMB_ACTIONS = ['toc', 'typography', 'bookmark', 'search', 'assistant'] as const;
const PRIMARY_TOUCH_ACTIONS = ['backToShelf', ...THUMB_ACTIONS] as const;
const AUTO_HIDE_MS = 3500;
const MIN_HIT_PX = READER_CHROME_TOUCH_HIT_PX;
const MIN_GAP_PX = READER_CHROME_TOUCH_GAP_PX;

function stubRect(
  el: HTMLElement,
  box: { width: number; height: number; top?: number; left?: number },
): void {
  const top = box.top ?? 0;
  const left = box.left ?? 0;
  el.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      top,
      left,
      width: box.width,
      height: box.height,
      right: left + box.width,
      bottom: top + box.height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

function labeledButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter((button) =>
    LABELS.some((label) => button.textContent?.includes(label)),
  );
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement {
  const match = labeledButtons(root).find((button) => button.textContent?.includes(label));
  expect(match, `missing labeled control "${label}"`).toBeTruthy();
  return match!;
}

function mount(overrides: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  host.className = 'lightink-reader';
  const page = document.createElement('div');
  page.className = 'lightink-reader-page';
  page.style.height = '400px';
  host.append(page);
  document.body.append(host);
  stubRect(host, { width: 720, height: 400 });
  stubRect(page, { width: 720, height: 400 });

  const deps = {
    returnToShelf: vi.fn(),
    openOutline: vi.fn(),
    openSearch: vi.fn(),
    openTypography: vi.fn(),
    openAssistant: vi.fn(),
    toggleBookmark: vi.fn(),
    isBookmarked: vi.fn(() => false),
    onBookmarkTick: vi.fn(),
    toggleSidebar: vi.fn(),
    isOverlayOpen: vi.fn(() => false),
    dismissOverlay: vi.fn(() => false),
    hideSelectionToolbar: vi.fn(),
    isSelectionToolbarVisible: vi.fn(() => false),
    isSidebarVisible: vi.fn(() => false),
    ...overrides,
  };
  const chrome = createReaderChrome(host, deps);
  return { host, page, chrome, deps };
}

function clickPage(target: HTMLElement, clientY: number): void {
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY }),
  );
}

function actionButton(root: ParentNode, action: string): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('[data-reader-chrome-action]')].find(
    (button) => button.dataset.readerChromeAction === action,
  );
  expect(match, `missing chrome action "${action}"`).toBeTruthy();
  return match!;
}

function declaredHitPx(el: HTMLElement): number {
  const computed = getComputedStyle(el);
  for (const raw of [el.style.minHeight, el.style.height, computed.minHeight, computed.height]) {
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function applyTouchReaderCss(): void {
  document.documentElement.setAttribute('data-touch-primary', '');
  if (document.head.querySelector('[data-reader-chrome-test-css]')) {
    return;
  }
  const style = document.createElement('style');
  style.dataset.readerChromeTestCss = 'true';
  style.textContent = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
  document.head.append(style);
}

function cssRuleBodies(css: string, selector: RegExp): string[] {
  const bodies: string[] = [];
  const matcher = new RegExp(
    `${selector.source}\\s*\\{([^}]*)\\}`,
    selector.flags.includes('g') ? selector.flags : `${selector.flags}g`,
  );
  for (const match of css.matchAll(matcher)) {
    bodies.push(match[1] ?? '');
  }
  return bodies;
}

function cssDeclaration(block: string, property: string): string | undefined {
  const match = block.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim();
}

function cssLengthPx(value: string | undefined): number[] {
  if (!value) {
    return [];
  }
  return [...value.matchAll(/(\d+(?:\.\d+)?)(px|rem)/g)].map((match) => {
    const amount = Number(match[1]);
    return match[2] === 'rem' ? amount * 16 : amount;
  });
}

function declaredGapPx(el: HTMLElement): number {
  const computed = getComputedStyle(el);
  for (const raw of [el.style.gap, el.style.columnGap, computed.gap, computed.columnGap]) {
    const values = cssLengthPx(raw);
    if (values.length > 0) {
      return Math.max(...values);
    }
  }
  return 0;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-android');
  document.head.querySelectorAll('[data-reader-chrome-test-css]').forEach((node) => node.remove());
});

describe('createReaderChrome first paint', () => {
  it('opens expanded with no editor menus or markdown tab bar', () => {
    const { host, chrome } = mount();

    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.bar.hidden).toBe(false);
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    expect(host.querySelector('#lightink-toolbar')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    expect(host.textContent).not.toContain('文件');
    expect(host.textContent).not.toContain('插入');
    expect(labeledButtons(host).every((button) => button.hidden === false)).toBe(true);
  });
});

describe('createReaderChrome reveal', () => {
  it('opens six text-labeled controls with 返回书架 first and a page click leaves them up', () => {
    const { host, page, chrome } = mount();

    expect(chrome.isRevealed()).toBe(true);
    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(true);

    const buttons = labeledButtons(host);
    expect(buttons).toHaveLength(6);
    expect(buttons[0]!.textContent?.trim()).toBe('返回书架');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([...LABELS]);
    expect(host.textContent).not.toContain('本书标注');
    expect(host.querySelector('[data-reader-chrome-action="annotations"]')).toBeNull();
    const bar = host.querySelector('.lightink-reader-chrome-bar');
    expect(bar?.querySelector('.lightink-reader-chrome-tools')?.contains(buttons[1]!)).toBe(true);
    expect(bar?.getAttribute('data-tauri-drag-region')).toBe('');
    expect(host.querySelector('.lightink-reader-chrome-drag')?.getAttribute('data-tauri-drag-region')).toBe(
      '',
    );
    for (const button of buttons) {
      expect(button.hasAttribute('data-tauri-drag-region')).toBe(false);
    }
    chrome.dismiss();
    expect(chrome.isRevealed()).toBe(true);
    expect(bar?.getAttribute('data-tauri-drag-region')).toBe('');
    expect(host.querySelector('.lightink-reader-chrome-drag')?.getAttribute('data-tauri-drag-region')).toBe(
      '',
    );
    chrome.reveal();
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')?.trim()).toBe(button.textContent?.trim());
      expect(button.hidden).toBe(false);
      expect((button.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(button.textContent?.trim()).not.toBe('×');
      expect(button.textContent?.trim()).not.toBe('编辑');
    }
  });

  it('notifies onRevealChange only on effective visibility transitions', () => {
    const onRevealChange = vi.fn();
    const { page, chrome } = mount({ onRevealChange });
    expect(onRevealChange).toHaveBeenLastCalledWith(true);
    const mountCalls = onRevealChange.mock.calls.length;

    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(true);
    chrome.reveal();
    chrome.dismiss();
    expect(onRevealChange).toHaveBeenLastCalledWith(true);
    expect(onRevealChange.mock.calls.length).toBe(mountCalls);
  });

  it('uses English chrome labels when locale is en', () => {
    const { host, page } = mount({ locale: 'en' });
    clickPage(page, 120);
    const actions = ['backToShelf', 'toc', 'typography', 'bookmark', 'search', 'assistant'] as const;
    expect(
      actions.map((action) =>
        host.querySelector(`[data-reader-chrome-action="${action}"]`)?.textContent?.trim(),
      ),
    ).toEqual(['Back to Shelf', 'Contents', 'Typography', 'Bookmark', 'Search', 'Assistant']);
  });

  it('hides the flow whisper while comic chrome would cover it', () => {
    const { chrome } = mount({ suppressProgressDock: () => true });
    expect(chrome.whisper.hidden).toBe(true);
    expect(chrome.footer.hidden).toBe(true);
    chrome.reveal();
    expect(chrome.whisper.hidden).toBe(true);
    expect(chrome.footer.hidden).toBe(true);
    chrome.dismiss();
    expect(chrome.whisper.hidden).toBe(true);
  });

  it('keeps the chapter footer once progress docks are allowed again', () => {
    let covering = true;
    const { chrome } = mount({ suppressProgressDock: () => covering });
    expect(chrome.footer.hidden).toBe(true);
    expect(chrome.whisper.hidden).toBe(true);
    covering = false;
    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
  });

  it('keeps the chapter footer in scroll mode instead of dropping to the whisper', () => {
    const { host, chrome } = mount();
    host.dataset.readingLayout = 'scroll';
    chrome.dismiss();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    expect(chrome.footer.querySelector('.lightink-reader-chrome-chapter')).not.toBeNull();
    expect(chrome.footer.querySelector('.lightink-reader-chrome-progress')).not.toBeNull();
  });

  it('keeps touch actions on the top bar when comic progress docks are suppressed', () => {
    const { host, chrome } = mount({
      touchMode: true,
      suppressProgressDock: () => true,
    });
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.footer.hidden).toBe(true);
    expect(chrome.whisper.hidden).toBe(true);
    expect(chrome.bar.contains(actionButton(host, 'backToShelf'))).toBe(true);
    expect(actionButton(host, 'backToShelf').hidden).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.bar.contains(actionButton(host, action))).toBe(true);
      expect(chrome.footer.contains(actionButton(host, action))).toBe(false);
      expect(actionButton(host, action).hidden).toBe(false);
    }
  });

  it('does not steal comic page clicks or hover for the flow chrome', () => {
    const { host, chrome } = mount();
    const page = document.createElement('div');
    page.dataset.comicReader = 'true';
    page.className = 'lightink-reader-pages';
    host.append(page);
    stubRect(page, { width: 720, height: 400 });

    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(true);

    page.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(true);
  });

  it('keeps the bars up when the pointer rests near the top or bottom edge', () => {
    const { host, chrome } = mount();

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(true);

    chrome.dismiss();
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 394 }),
    );
    expect(chrome.isRevealed()).toBe(true);
  });

  it('covers the full 24px hover band including the capture dance end at y=22', () => {
    // 24px 顶部悬停带必须完整覆盖 y≤24（含 22）。看见顶栏不再依赖这次唤出。
    const { host, chrome } = mount();
    expect(READER_CHROME_EDGE_PX).toBe(24);
    const bounds = { top: 0, height: 400 };
    expect(isReaderChromeEdge(22, bounds)).toBe(true);
    expect(isReaderChromeEdge(24, bounds)).toBe(true);
    expect(isReaderChromeEdge(25, bounds)).toBe(false);
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 640, clientY: 22 }),
    );
    expect(chrome.isRevealed()).toBe(true);

    chrome.dismiss();
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 640, clientY: 25 }),
    );
    expect(chrome.isRevealed()).toBe(true);
  });

  it('reveals at the visible window top after the host has scrolled away', () => {
    const { host, chrome } = mount();
    stubRect(host, { width: 720, height: 4000, top: -2000 });
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 8 }),
    );
    expect(chrome.isRevealed()).toBe(true);
  });
});

describe('createReaderChrome overlay layout', () => {
  it('pins the overlay as the first child so sticky top stays on the visible pane', () => {
    const { host, chrome } = mount();
    expect(host.firstElementChild).toBe(chrome.element);
  });

  it('stacks over the page and does not shift reading-area top or height', () => {
    const { page, chrome } = mount();
    const before = page.getBoundingClientRect();

    chrome.reveal();
    const shown = page.getBoundingClientRect();
    expect(shown.top).toBe(before.top);
    expect(shown.height).toBe(before.height);

    chrome.dismiss();
    const hidden = page.getBoundingClientRect();
    expect(hidden.top).toBe(before.top);
    expect(hidden.height).toBe(before.height);

    const overlay = chrome.element;
    const position = overlay.style.position || getComputedStyle(overlay).position;
    expect(['absolute', 'fixed', 'sticky']).toContain(position);
  });
});

describe('createReaderChrome actions', () => {
  it('返回书架 is the only control that returns to the shelf', () => {
    const { host, chrome, deps } = mount();
    chrome.reveal();

    buttonByLabel(host, '目录').click();
    buttonByLabel(host, '搜索').click();
    buttonByLabel(host, '排版').click();
    expect(deps.openOutline).toHaveBeenCalledTimes(1);
    expect(deps.openSearch).toHaveBeenCalledTimes(1);
    expect(deps.openTypography).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
    expect(deps.returnToShelf).not.toHaveBeenCalled();

    buttonByLabel(host, '返回书架').click();
    expect(deps.returnToShelf).toHaveBeenCalledTimes(1);
    expect(deps.openOutline).toHaveBeenCalledTimes(1);
    expect(deps.openSearch).toHaveBeenCalledTimes(1);
    expect(deps.openTypography).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
  });

  it('closes an open sheet when the page is clicked again', () => {
    const { page, chrome, deps } = mount({
      isOverlayOpen: vi.fn(() => true),
    });
    chrome.reveal();
    clickPage(page, 160);
    expect(deps.dismissOverlay).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });
});

describe('createReaderChrome search entry', () => {
  it('declares search as a first-class chrome action', () => {
    expect(READER_CHROME_ACTIONS).toContain('search');
  });

  it('puts 搜索 in the tools cluster and only forwards to openSearch', () => {
    const { host, chrome, deps } = mount();
    chrome.reveal();

    const searchButton = buttonByLabel(host, '搜索');
    expect(searchButton.dataset.readerChromeAction).toBe('search');
    expect(
      host.querySelector('.lightink-reader-chrome-tools')?.contains(searchButton),
    ).toBe(true);

    searchButton.click();
    expect(deps.openSearch).toHaveBeenCalledTimes(1);
    // The chrome never opens the sidebar or any panel itself; reader-view
    // routes openSearch to sidebar (desktop) or the search sheet (touch).
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
    expect(deps.openOutline).not.toHaveBeenCalled();
    expect(deps.openTypography).not.toHaveBeenCalled();
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('works the same under touchMode', () => {
    const { host, chrome, deps } = mount({ touchMode: true });
    chrome.reveal();
    buttonByLabel(host, '搜索').click();
    expect(deps.openSearch).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
  });
});

describe('createReaderChrome assistant entry (R5)', () => {
  it('declares assistant as a first-class chrome action', () => {
    expect(READER_CHROME_ACTIONS).toContain('assistant');
  });

  it('puts 助手 in the tools cluster and only forwards to openAssistant', () => {
    const { host, chrome, deps } = mount();
    chrome.reveal();

    const assistant = buttonByLabel(host, '助手');
    expect(assistant.dataset.readerChromeAction).toBe('assistant');
    expect(assistant.getAttribute('aria-haspopup')).toBe('dialog');
    expect(assistant.getAttribute('aria-expanded')).toBe('false');
    expect(
      host.querySelector('.lightink-reader-chrome-tools')?.contains(assistant),
    ).toBe(true);

    assistant.click();
    expect(deps.openAssistant).toHaveBeenCalledTimes(1);
    // chrome 自身不开面板、不触碰书架/侧栏——面板互斥在 reader-chrome-wiring。
    expect(deps.openSearch).not.toHaveBeenCalled();
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('keeps 助手 on the touch top bar', () => {
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();
    const assistant = actionButton(host, 'assistant');
    expect(chrome.bar.contains(assistant)).toBe(true);
    expect(chrome.footer.contains(assistant)).toBe(false);
    expect(assistant.hidden).toBe(false);
  });

  it('hides 助手 when assistantAvailable is false', () => {
    const { host, chrome } = mount({ assistantAvailable: () => false });
    chrome.reveal();
    expect(host.querySelector('[data-reader-chrome-action="assistant"]')).toBeNull();
  });
});

describe('createReaderChrome bookmark toggle (R1)', () => {
  it('declares bookmark as a first-class chrome action', () => {
    expect(READER_CHROME_ACTIONS).toContain('bookmark');
  });

  it('presents a two-state toggle driven by isBookmarked and forwards toggleBookmark', () => {
    let bookmarked = false;
    const { host, chrome, deps } = mount({
      isBookmarked: () => bookmarked,
      toggleBookmark: vi.fn(() => {
        bookmarked = !bookmarked;
      }),
    });
    chrome.reveal();

    const button = actionButton(host, 'bookmark');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('is-bookmarked')).toBe(false);

    button.click();
    expect(deps.toggleBookmark).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.classList.contains('is-bookmarked')).toBe(true);

    button.click();
    expect(deps.toggleBookmark).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('is-bookmarked')).toBe(false);
  });

  it('lets the host rewrite the toggle state via setBookmarked and re-reads on reveal', () => {
    let bookmarked = true;
    const { host, chrome } = mount({ isBookmarked: () => bookmarked });
    const button = actionButton(host, 'bookmark');

    chrome.reveal();
    expect(button.getAttribute('aria-pressed')).toBe('true');

    chrome.setBookmarked(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.classList.contains('is-bookmarked')).toBe(false);

    // 宿主事实源优先：reveal 重新读取 isBookmarked。
    chrome.setBookmarked(true);
    bookmarked = false;
    chrome.dismiss();
    chrome.reveal();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the bookmark toggle on the touch top bar with a 48px hit', () => {
    const { host, chrome, deps } = mount({ touchMode: true });
    chrome.reveal();
    const button = actionButton(host, 'bookmark');
    expect(chrome.bar.contains(button)).toBe(true);
    expect(chrome.footer.contains(button)).toBe(false);
    expect(Number(button.dataset.readerChromeHit ?? 0)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    button.click();
    expect(deps.toggleBookmark).toHaveBeenCalledTimes(1);
  });
});

describe('createReaderChrome bookmark ticks (R3)', () => {
  it('paints bookmark ticks as clickable buttons distinct from chapter ticks', () => {
    const onBookmarkTick = vi.fn();
    const { chrome } = mount({ onBookmarkTick });
    chrome.setProgress({
      chapterTitle: '第一章',
      location: '2 / 10',
      progress: 0.25,
      ticks: [0.2],
      bookmarkTicks: [0.55],
    });

    const all = chrome.footer.querySelectorAll('.lightink-reader-chrome-tick');
    expect(all).toHaveLength(2);
    const chapterTick = chrome.footer.querySelector(
      '.lightink-reader-chrome-tick:not(.lightink-reader-chrome-tick--bookmark)',
    );
    expect(chapterTick?.tagName).toBe('I');

    const bookmarkTick = chrome.footer.querySelector<HTMLButtonElement>(
      '.lightink-reader-chrome-tick--bookmark',
    );
    expect(bookmarkTick).not.toBeNull();
    expect(bookmarkTick!.tagName).toBe('BUTTON');
    expect(bookmarkTick!.style.left).toBe('55%');
    expect(bookmarkTick!.getAttribute('aria-label')?.trim()).not.toBe('');

    bookmarkTick!.click();
    expect(onBookmarkTick).toHaveBeenCalledTimes(1);
    expect(onBookmarkTick).toHaveBeenCalledWith(0.55);

    // 书签增删后 setProgress 刷新刻度。
    chrome.setProgress({
      chapterTitle: '第一章',
      location: '2 / 10',
      progress: 0.25,
      ticks: [0.2],
      bookmarkTicks: [],
    });
    expect(chrome.footer.querySelector('.lightink-reader-chrome-tick--bookmark')).toBeNull();
    expect(chrome.footer.querySelectorAll('.lightink-reader-chrome-tick')).toHaveLength(1);
  });
});

describe('createReaderChrome escape is one step', () => {

  it('closes the selection toolbar before anything else', () => {
    const { chrome, deps } = mount({
      isSelectionToolbarVisible: vi.fn(() => true),
    });
    chrome.reveal();

    expect(chrome.handleEscape()).toBe(true);
    expect(deps.hideSelectionToolbar).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
    expect(deps.toggleSidebar).not.toHaveBeenCalled();
    expect(chrome.isRevealed()).toBe(true);
  });

  it('closes open annotations and keeps the book open', () => {
    const { chrome, deps } = mount({
      isSidebarVisible: vi.fn(() => true),
    });
    chrome.reveal();

    expect(chrome.handleEscape()).toBe(true);
    expect(deps.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
    expect(chrome.isRevealed()).toBe(true);
  });

  it('dismisses a nested overlay via dismissOverlay without leaving the book', () => {
    let overlay = true;
    const { chrome, deps } = mount({
      isOverlayOpen: () => overlay,
      dismissOverlay: vi.fn(() => {
        if (!overlay) {
          return false;
        }
        overlay = false;
        return true;
      }),
    });
    chrome.reveal();

    expect(chrome.handleEscape()).toBe(true);
    expect(deps.dismissOverlay).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
    expect(chrome.isRevealed()).toBe(true);
  });

  it('leaves the chrome bar up on Escape and still does not return to the shelf', () => {
    const { chrome, deps } = mount();
    chrome.reveal();

    expect(chrome.handleEscape()).toBe(false);
    expect(chrome.isRevealed()).toBe(true);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });
});

describe('createReaderChrome stays expanded', () => {
  it('stays up after 3.5s idle, including while an overlay is open', () => {
    vi.useFakeTimers();
    const overlay = { open: false };
    const { chrome } = mount({
      isOverlayOpen: () => overlay.open,
    });

    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
    expect(chrome.isRevealed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chrome.isRevealed()).toBe(true);

    overlay.open = true;
    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
    expect(chrome.isRevealed()).toBe(true);
  });

  it('stays up while the pointer rests on the bar or footer and after it leaves', () => {
    vi.useFakeTimers();
    const { chrome } = mount();

    chrome.reveal();
    chrome.bar.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(AUTO_HIDE_MS * 3);
    expect(chrome.isRevealed()).toBe(true);

    chrome.footer.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    vi.advanceTimersByTime(AUTO_HIDE_MS * 3);
    expect(chrome.isRevealed()).toBe(true);

    chrome.footer.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    vi.advanceTimersByTime(AUTO_HIDE_MS);
    expect(chrome.isRevealed()).toBe(true);
  });

  it('stays revealed while the window titlebar is hovered', () => {
    vi.useFakeTimers();
    const titlebar = document.createElement('div');
    titlebar.id = 'lightink-window-titlebar';
    titlebar.matches = ((selector: string) =>
      selector.includes(':hover')) as typeof titlebar.matches;
    document.body.append(titlebar);
    const { chrome } = mount();

    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
    expect(chrome.isRevealed()).toBe(true);
  });

  it('stays revealed after stayRevealed turns false', () => {
    vi.useFakeTimers();
    let atTop = true;
    const { chrome } = mount({
      stayRevealed: () => atTop,
    });
    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
    expect(chrome.isRevealed()).toBe(true);
    atTop = false;
    chrome.syncStayRevealed();
    vi.advanceTimersByTime(AUTO_HIDE_MS);
    expect(chrome.isRevealed()).toBe(true);
  });

  it('is already revealed when syncStayRevealed runs at the top of scroll mode', () => {
    const { chrome } = mount({
      stayRevealed: () => true,
    });
    expect(chrome.isRevealed()).toBe(true);
    chrome.syncStayRevealed();
    expect(chrome.isRevealed()).toBe(true);
  });
});

describe('createReaderChrome touch mode', () => {
  it('opens with the touch top bar expanded and does not depend on edge hover', () => {
    const { host, chrome } = mount({ touchMode: true });

    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.bar.hidden).toBe(false);
    expect(host.querySelector('#lightink-toolbar')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    expect(host.textContent).not.toContain('文件');
    expect(host.textContent).not.toContain('插入');
    for (const action of PRIMARY_TOUCH_ACTIONS) {
      expect(chrome.bar.contains(actionButton(host, action))).toBe(true);
      expect(actionButton(host, action).hidden).toBe(false);
    }
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(true);
  });

  it('never auto-hides after idle or pointer leave when touchMode is true', () => {
    vi.useFakeTimers();
    const { host, chrome } = mount({ touchMode: true });

    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 4);
    expect(chrome.isRevealed()).toBe(true);

    host.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
    chrome.handlePointerLeave();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 4);
    expect(chrome.isRevealed()).toBe(true);
  });

  it('does not use edge hover to show or hide the touch bar', () => {
    const { host, chrome } = mount({ touchMode: true });

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(true);

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 394 }),
    );
    expect(chrome.isRevealed()).toBe(true);

    chrome.handlePointerMove({ clientY: 4 });
    chrome.handlePointerMove({ clientY: 396 });
    expect(chrome.isRevealed()).toBe(true);
  });

  it('keeps touch actions on the top bar across center taps', () => {
    vi.useFakeTimers();
    const { host, page, chrome } = mount({ touchMode: true });
    const before = page.getBoundingClientRect();

    clickPage(page, 200);
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.bar.contains(actionButton(host, 'backToShelf'))).toBe(true);
    expect(actionButton(host, 'backToShelf').hidden).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.bar.contains(actionButton(host, action))).toBe(true);
      expect(chrome.footer.contains(actionButton(host, action))).toBe(false);
      expect(actionButton(host, action).hidden).toBe(false);
    }
    const shown = page.getBoundingClientRect();
    expect(shown.top).toBe(before.top);
    expect(shown.height).toBe(before.height);
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
    expect(chrome.isRevealed()).toBe(true);

    clickPage(page, 200);
    expect(chrome.isRevealed()).toBe(true);
    for (const action of PRIMARY_TOUCH_ACTIONS) {
      expect(chrome.bar.contains(actionButton(host, action))).toBe(true);
      expect(actionButton(host, action).hidden).toBe(false);
    }
    const hidden = page.getBoundingClientRect();
    expect(hidden.top).toBe(before.top);
    expect(hidden.height).toBe(before.height);
  });

  it('leaves the touch bars up on Escape and does not return to the shelf', () => {
    const { chrome, deps } = mount({ touchMode: true });
    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);

    expect(chrome.handleEscape()).toBe(false);
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.whisper.hidden).toBe(true);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('closes an open sheet on tap without leaving the book', () => {
    const { page, chrome, deps } = mount({
      touchMode: true,
      isOverlayOpen: vi.fn(() => true),
    });
    chrome.reveal();
    clickPage(page, 200);
    expect(deps.dismissOverlay).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
    expect(chrome.isRevealed()).toBe(true);
  });

  it('closes an open sheet on tap and keeps the bars expanded', () => {
    const { page, chrome, deps } = mount({
      touchMode: true,
      isOverlayOpen: vi.fn(() => true),
    });
    expect(chrome.isRevealed()).toBe(true);
    clickPage(page, 200);
    expect(deps.dismissOverlay).toHaveBeenCalledTimes(1);
    expect(chrome.isRevealed()).toBe(true);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('does not rewrite unchanged reveal attributes (mutation-observer loop guard)', () => {
    // reader-view 用 MutationObserver 监听 element 的 data-revealed/class 并在
    // 回调里调回 setProgress。等值 setAttribute 也会产生 mutation record，
    // 一旦稳态下仍重写属性，就会形成永不排空的微任务死循环把主线程卡死。
    const { chrome } = mount();
    const snapshot = { chapterTitle: '第一章', location: '2 / 10', progress: 0.25 };
    chrome.setProgress(snapshot);
    const setAttribute = vi.spyOn(chrome.element, 'setAttribute');
    chrome.setProgress(snapshot);
    const rewritten = setAttribute.mock.calls.filter(([name]) =>
      ['data-revealed', 'aria-hidden', 'class'].includes(name),
    );
    expect(rewritten).toHaveLength(0);
    setAttribute.mockRestore();
  });

  it('keeps chapter progress on the footer while the bars stay up', () => {
    const { chrome } = mount({ touchMode: true });
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    chrome.setProgress({ chapterTitle: '第一章', location: '2 / 10', progress: 0.25 });
    expect(chrome.footer.querySelector('.lightink-reader-chrome-chapter')?.textContent).toBe('第一章');
    expect(chrome.footer.querySelector('.lightink-reader-chrome-percent')?.textContent).toBe('25%');
  });

  it('places toc / typography / bookmark / search on the touch top bar', () => {
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();

    const zone = chrome.bar.querySelector<HTMLElement>('.lightink-reader-chrome-tools');
    expect(zone).not.toBeNull();
    expect(chrome.bar.contains(zone!)).toBe(true);
    for (const action of THUMB_ACTIONS) {
      const button = actionButton(host, action);
      expect(zone!.contains(button), `${action} should live on the top bar`).toBe(true);
      expect(chrome.footer.contains(button)).toBe(false);
      expect(button.hidden).toBe(false);
      expect(Number(button.dataset.readerChromeHit ?? 0)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }
    expect(chrome.bar.style.flexWrap).toBe('wrap');
    expect(chrome.bar.style.overflowX).toBe('clip');
  });

  it('keeps the touch actions on the top bar and clickable', () => {
    const { chrome, deps } = mount({ touchMode: true });
    chrome.reveal();

    const clicks: Array<[string, () => void]> = [
      ['toc', () => expect(deps.openOutline).toHaveBeenCalledTimes(1)],
      ['typography', () => expect(deps.openTypography).toHaveBeenCalledTimes(1)],
      ['bookmark', () => expect(deps.toggleBookmark).toHaveBeenCalledTimes(1)],
      ['search', () => expect(deps.openSearch).toHaveBeenCalledTimes(1)],
    ];
    for (const [action, assertCall] of clicks) {
      const button = actionButton(chrome.bar, action);
      expect(chrome.bar.contains(button)).toBe(true);
      expect(chrome.footer.contains(button)).toBe(false);
      expect(button.hidden).toBe(false);
      button.click();
      assertCall();
    }
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('gives backToShelf and footer thumb actions a 48×48 hit target with 8px gaps', () => {
    expect(READER_CHROME_TOUCH_HIT_PX).toBe(48);
    expect(READER_CHROME_TOUCH_GAP_PX).toBe(8);
    applyTouchReaderCss();
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();

    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    for (const action of PRIMARY_TOUCH_ACTIONS) {
      const button = actionButton(host, action);
      expect(chrome.bar.contains(button), `${action} stays on the top bar`).toBe(true);
      expect(chrome.footer.contains(button)).toBe(false);
      const size = declaredHitPx(button);
      if (size > 0) {
        expect(size, `${action} hit target`).toBeGreaterThanOrEqual(MIN_HIT_PX);
      }
      expect(Number(button.dataset.readerChromeHit ?? size)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }

    const zone = chrome.bar.querySelector<HTMLElement>('.lightink-reader-chrome-tools')!;
    const zoneGap = declaredGapPx(zone);
    if (zoneGap > 0) {
      expect(zoneGap, 'footer thumb gap').toBeGreaterThanOrEqual(MIN_GAP_PX);
    }

    const actionBlocks = cssRuleBodies(
      css,
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action(?![\w-])/,
    );
    expect(actionBlocks.length).toBeGreaterThan(0);
    for (const block of actionBlocks) {
      expect(cssLengthPx(cssDeclaration(block, 'min-width'))[0]).toBeGreaterThanOrEqual(MIN_HIT_PX);
      expect(cssLengthPx(cssDeclaration(block, 'min-height'))[0]).toBeGreaterThanOrEqual(MIN_HIT_PX);
      expect(block).not.toMatch(/(?:min-width|min-height|width|height):\s*44px/);
    }

    const footerActionBlocks = cssRuleBodies(
      css,
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-action--search/,
    );
    expect(footerActionBlocks.length).toBeGreaterThan(0);
    for (const block of footerActionBlocks) {
      expect(cssLengthPx(cssDeclaration(block, 'min-width'))[0]).toBeGreaterThanOrEqual(MIN_HIT_PX);
      expect(cssLengthPx(cssDeclaration(block, 'min-height'))[0]).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }

    const footerToolsBlocks = cssRuleBodies(
      css,
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-tools/,
    );
    const footerTools = footerToolsBlocks[footerToolsBlocks.length - 1] ?? '';
    expect(cssLengthPx(cssDeclaration(footerTools, 'gap'))[0]).toBeGreaterThanOrEqual(MIN_GAP_PX);

    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-bar\s*\{[^}]*--lightink-safe-top/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer\s*\{[^}]*--lightink-safe-bottom/,
    );
    expect(css).toContain('--lightink-keyboard-inset');
  });
});

describe('createReaderChrome desktop keeps five actions on the top bar', () => {
  it('keeps shelf / contents / typography / bookmark / search on the top bar and out of the footer', () => {
    const { host, chrome } = mount();
    chrome.reveal();

    for (const action of READER_CHROME_ACTIONS) {
      const button = actionButton(host, action);
      expect(chrome.bar.contains(button), `${action} should stay on the desktop top bar`).toBe(
        true,
      );
      expect(chrome.footer.contains(button)).toBe(false);
    }
    expect(host.querySelector('[data-reader-chrome-action="annotations"]')).toBeNull();
    expect(chrome.footer.querySelector('[data-reader-chrome-action]')).toBeNull();
  });

  it('keeps desktop tool labels from stacking and does not ship a 本书标注 control', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).not.toMatch(/chrome-action--annotations/);
    expect(css).toMatch(
      /\.lightink-reader-chrome-tools\s*\{[^}]*flex-wrap:\s*wrap[^}]*max-width:\s*100%/,
    );
    expect(css).toMatch(
      /\.lightink-reader-chrome-bar\s*\{[^}]*flex-wrap:\s*wrap[^}]*overflow-x:\s*clip/,
    );
    expect(css).toMatch(
      /\.lightink-reader-chrome-action-label\s*\{[^}]*white-space:\s*nowrap/,
    );
    expect(css).toMatch(
      /\.lightink-reader-chrome-title\s*\{[^}]*flex:\s*100 1 0%[^}]*max-width:\s*max-content[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/,
    );
    expect(css).toMatch(
      /\.lightink-reader-chrome-action\s*\{[^}]*flex-shrink:\s*0[^}]*isolation:\s*isolate/,
    );
  });
});

describe('createReaderChrome destroy', () => {
  it('removes the overlay and ignores later page clicks', () => {
    const { host, page, chrome, deps } = mount();
    chrome.reveal();
    chrome.destroy();

    expect(host.contains(chrome.element)).toBe(false);
    expect(host.contains(chrome.footer)).toBe(false);
    expect(host.contains(chrome.whisper)).toBe(false);
    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(false);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });
});

describe('createReaderChrome footer and whisper', () => {
  it('shows the chapter footer while the bars stay expanded', () => {
    const { chrome } = mount();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);

    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);

    chrome.dismiss();
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
  });

  it('writes chapter and location into both docks and seeks from the scrubber', () => {
    const onSeekProgress = vi.fn();
    const { chrome } = mount({ onSeekProgress });
    chrome.setProgress({
      chapterTitle: '第一章',
      location: '2 / 10',
      progress: 0.25,
      ticks: [0.2, 0.55],
    });
    expect(chrome.footer.querySelector('.lightink-reader-chrome-chapter')?.textContent).toBe(
      '第一章',
    );
    expect(chrome.whisper.querySelector('.lightink-reader-chrome-whisper-chapter')?.textContent).toBe(
      '第一章',
    );
    expect([...chrome.footer.children].map((node) => node.className)).toEqual([
      'lightink-reader-chrome-chapter',
      'lightink-reader-chrome-scrubber',
      'lightink-reader-chrome-footer-stats',
    ]);
    expect([...chrome.whisper.children].map((node) => node.className)).toEqual([
      'lightink-reader-chrome-whisper-chapter',
      'lightink-reader-chrome-scrubber lightink-reader-chrome-scrubber--whisper',
      'lightink-reader-chrome-whisper-progress',
    ]);
    expect(chrome.whisper.getAttribute('aria-label')).toContain('第一章');
    expect(chrome.whisper.getAttribute('aria-label')).toContain('25%');
    expect(chrome.footer.querySelector('.lightink-reader-chrome-location')?.textContent).toBe(
      '2 / 10',
    );
    expect(chrome.footer.querySelector('.lightink-reader-chrome-percent')?.textContent).toBe('25%');
    expect(chrome.whisper.querySelector('.lightink-reader-chrome-whisper-progress')?.textContent).toBe(
      '25%',
    );
    expect(chrome.whisper.querySelectorAll('.lightink-reader-chrome-tick')).toHaveLength(0);
    expect(chrome.footer.style.getPropertyValue('--lightink-reader-progress')).toBe('0.25');
    expect(chrome.footer.querySelectorAll('.lightink-reader-chrome-tick')).toHaveLength(2);
    const slider = chrome.footer.querySelector<HTMLInputElement>('.lightink-reader-chrome-progress');
    expect(slider?.value).toBe('250');
    slider!.value = '500';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onSeekProgress).toHaveBeenCalledWith(0.5);
    expect(chrome.footer.style.getPropertyValue('--lightink-reader-progress')).toBe('0.5');
    expect(chrome.footer.querySelector('.lightink-reader-chrome-percent')?.textContent).toBe('50%');
  });

  it('reveals chrome when the whisper is clicked', () => {
    const { chrome } = mount();
    chrome.whisper.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chrome.isRevealed()).toBe(true);
  });
});

describe('createReaderChrome has no speak control', () => {
  it('keeps READER_CHROME_ACTIONS as the six reader entries without speak', () => {
    expect([...READER_CHROME_ACTIONS]).toEqual([
      'backToShelf',
      'toc',
      'typography',
      'bookmark',
      'search',
      'assistant',
    ]);
    expect(READER_CHROME_ACTIONS).not.toContain('speak');
  });

  it('does not render a speak button on desktop or touch chrome', () => {
    const desktop = mount();
    desktop.chrome.reveal();
    expect(desktop.host.querySelector('[data-reader-tts-speak]')).toBeNull();
    expect(desktop.host.querySelector('.lightink-reader-tts-dock')).toBeNull();
    expect(labeledButtons(desktop.host)).toHaveLength(6);
    expect(
      [...desktop.host.querySelectorAll('[data-reader-chrome-action]')].map(
        (button) => (button as HTMLElement).dataset.readerChromeAction,
      ),
    ).toEqual([...READER_CHROME_ACTIONS]);

    const touch = mount({ touchMode: true, suppressProgressDock: () => true });
    touch.chrome.reveal();
    expect(touch.host.querySelector('[data-reader-tts-speak]')).toBeNull();
    expect(touch.chrome.bar.querySelector('[data-reader-tts-speak]')).toBeNull();
    expect(touch.chrome.footer.querySelector('[data-reader-tts-speak]')).toBeNull();
  });
});

describe('createReaderChrome T5 chrome icons + badges', () => {
  it('embeds a 24×24 SVG inside each top-bar action button with a label span', () => {
    const { host, chrome } = mount();
    chrome.reveal();
    const buttons = labeledButtons(host);
    const actions = ['backToShelf', 'toc', 'typography', 'bookmark', 'search', 'assistant'] as const;
    for (const action of actions) {
      const button = actionButton(host, action);
      const icon = button.querySelector('svg.lightink-reader-chrome-action-icon');
      expect(icon, `${action} should ship an inline SVG icon`).not.toBeNull();
      expect(icon!.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(icon!.getAttribute('aria-hidden')).toBe('true');
      expect(icon!.getAttribute('focusable')).toBe('false');
      // 至少一个 path 或 circle 子节点承载几何图元。
      expect(icon!.children.length).toBeGreaterThan(0);
      const labelSpan = button.querySelector<HTMLSpanElement>('.lightink-reader-chrome-action-label');
      expect(labelSpan, `${action} should expose a label span`).not.toBeNull();
      expect(labelSpan!.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      // aria-label 与 label span 文本一致，屏幕阅读器宣读完整词。
      expect(button.getAttribute('aria-label')?.trim()).toBe(labelSpan!.textContent?.trim());
    }
    expect(buttons).toHaveLength(6);
  });

  it('hides the label span in touch mode so the SVG fills the 48×48 thumb', () => {
    applyTouchReaderCss();
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();
    const button = actionButton(host, 'search');
    const labelSpan = button.querySelector<HTMLSpanElement>('.lightink-reader-chrome-action-label');
    expect(labelSpan).not.toBeNull();
    // 触屏分支 CSS 把 label 设为 display:none。
    expect(getComputedStyle(labelSpan!).display).toBe('none');
    // SVG 仍在 DOM 并保留可访问语义。
    const icon = button.querySelector<SVGElement>('svg.lightink-reader-chrome-action-icon');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-label')?.trim()).toBe('搜索');
  });

  it('toggles a small bookmark badge dot via setBookmarked', () => {
    const { host, chrome } = mount();
    chrome.reveal();
    const bookmark = actionButton(host, 'bookmark');
    expect(bookmark.querySelector('.lightink-reader-chrome-badge--dot')).toBeNull();
    chrome.setBookmarked(true);
    const dot = bookmark.querySelector<HTMLElement>('.lightink-reader-chrome-badge--dot');
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains('lightink-reader-chrome-badge')).toBe(true);
    expect(dot!.getAttribute('aria-hidden')).toBe('true');
    chrome.setBookmarked(false);
    expect(bookmark.querySelector('.lightink-reader-chrome-badge--dot')).toBeNull();
  });

  it('renders 0 → no badge, 12 → "12", 100 → "99+", 150 → "99+" on the search button', () => {
    const { host, chrome } = mount();
    chrome.reveal();
    const search = actionButton(host, 'search');
    const baseLabel = '搜索';

    chrome.setAnnotationBadge(0);
    expect(search.querySelector('.lightink-reader-chrome-badge--count')).toBeNull();
    expect(search.getAttribute('aria-label')).toBe(baseLabel);

    chrome.setAnnotationBadge(12);
    let badge = search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('lightink-reader-chrome-badge')).toBe(true);
    expect(badge!.getAttribute('aria-hidden')).toBe('true');
    expect(badge!.textContent).toBe('12');
    expect(search.getAttribute('aria-label')).toBe('搜索 · 12 条标注');

    chrome.setAnnotationBadge(100);
    expect(search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count')!.textContent).toBe('99+');
    expect(search.getAttribute('aria-label')).toBe('搜索 · 100 条标注');

    chrome.setAnnotationBadge(150);
    expect(search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count')!.textContent).toBe('99+');
    expect(search.getAttribute('aria-label')).toBe('搜索 · 150 条标注');

    chrome.setAnnotationBadge(0);
    expect(search.querySelector('.lightink-reader-chrome-badge--count')).toBeNull();
    expect(search.getAttribute('aria-label')).toBe(baseLabel);
  });

  it('uses the English "Search · N annotations" wording when locale is en', () => {
    const { host, chrome } = mount({ locale: 'en' });
    chrome.reveal();
    const search = actionButton(host, 'search');
    expect(search.getAttribute('aria-label')).toBe('Search');

    chrome.setAnnotationBadge(7);
    expect(search.getAttribute('aria-label')).toBe('Search · 7 annotations');
    expect(search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count')!.textContent).toBe('7');
  });

  it('never re-creates the badge on repeated updates', () => {
    const { host, chrome } = mount();
    chrome.reveal();
    const search = actionButton(host, 'search');
    chrome.setAnnotationBadge(5);
    const badge = search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count');
    expect(badge).not.toBeNull();
    chrome.setAnnotationBadge(8);
    const after = search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count');
    expect(after).toBe(badge);
    expect(after!.textContent).toBe('8');
  });

  it('keeps the annotation badge visible in touch mode while the label stays hidden', () => {
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();
    chrome.setAnnotationBadge(4);
    const search = actionButton(host, 'search');
    const badge = search.querySelector<HTMLElement>('.lightink-reader-chrome-badge--count');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('4');
    expect(search.querySelector<HTMLSpanElement>('.lightink-reader-chrome-action-label')!.style.display).not.toBe(
      'inline-flex',
    );
  });
});

describe('createReaderChrome Markdown 编辑/完成', () => {
  function mountMarkdownChrome(overrides: { markdownEditing?: boolean } = {}): ReturnType<
    typeof mount
  > & {
    deps: ReturnType<typeof mount>['deps'] & {
      onMarkdownEdit: ReturnType<typeof vi.fn>;
      onMarkdownFinish: ReturnType<typeof vi.fn>;
    };
  } {
    let editing = overrides.markdownEditing === true;
    const onMarkdownEdit = vi.fn(() => {
      editing = true;
    });
    const onMarkdownFinish = vi.fn(() => {
      editing = false;
    });
    const mounted = mount({
      touchMode: true,
      suppressProgressDock: () => true,
      markdownEditing: () => editing,
      onMarkdownEdit,
      onMarkdownFinish,
    });
    return { ...mounted, deps: { ...mounted.deps, onMarkdownEdit, onMarkdownFinish } };
  }

  it('does not render 编辑 unless Markdown edit deps are provided', () => {
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();
    expect(host.querySelector('[data-reader-chrome-action="markdownEdit"]')).toBeNull();
    expect(labeledButtons(host)).toHaveLength(6);
  });

  it('places 编辑 on the top bar and switches it to 完成 after edit', () => {
    const { host, chrome, deps } = mountMarkdownChrome();
    chrome.reveal();
    const button = actionButton(host, 'markdownEdit');
    expect(chrome.bar.contains(button)).toBe(true);
    expect(button.textContent?.trim()).toBe('编辑');
    expect(button.getAttribute('aria-label')).toBe('编辑');
    expect(button.hidden).toBe(false);
    expect(Number.parseInt(button.dataset.readerChromeHit ?? '0', 10)).toBe(MIN_HIT_PX);

    button.click();
    expect(deps.onMarkdownEdit).toHaveBeenCalledTimes(1);
    expect(deps.onMarkdownFinish).not.toHaveBeenCalled();
    chrome.syncMarkdownEdit();
    expect(button.textContent?.trim()).toBe('完成');
    expect(button.getAttribute('data-markdown-editing')).toBe('true');

    button.click();
    expect(deps.onMarkdownFinish).toHaveBeenCalledTimes(1);
    chrome.syncMarkdownEdit();
    expect(button.textContent?.trim()).toBe('编辑');
  });

  it('编辑态 返回书架 仍调用 returnToShelf（宿主拦截保存退出）', () => {
    const { host, chrome, deps } = mountMarkdownChrome({ markdownEditing: true });
    chrome.reveal();
    buttonByLabel(host, '返回书架').click();
    expect(deps.returnToShelf).toHaveBeenCalledTimes(1);
    expect(deps.onMarkdownFinish).not.toHaveBeenCalled();
  });

  it('handleEscape leaves the bars up in edit mode and never finishes or 合书', () => {
    const { chrome, deps } = mountMarkdownChrome({ markdownEditing: true });
    chrome.reveal();
    expect(chrome.handleEscape()).toBe(false);
    expect(chrome.isRevealed()).toBe(true);
    expect(deps.onMarkdownFinish).not.toHaveBeenCalled();
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });

  it('does not hide the bars on a contenteditable body click', () => {
    const { host, chrome } = mount({ touchMode: true });
    const readable = document.createElement('div');
    readable.className = 'ProseMirror lightink-prose';
    readable.setAttribute('contenteditable', 'false');
    readable.textContent = 'body';
    const writable = document.createElement('div');
    writable.className = 'ProseMirror lightink-prose';
    writable.setAttribute('contenteditable', 'true');
    writable.textContent = 'edit';
    host.append(readable, writable);

    clickPage(writable, 120);
    expect(chrome.isRevealed()).toBe(true);

    clickPage(readable, 120);
    expect(chrome.isRevealed()).toBe(true);
  });
});


describe('createReaderChrome setConcealZones (R7 摸鱼接管)', () => {
  it("'auto' keeps the bars expanded through the old idle window", () => {
    vi.useFakeTimers();
    try {
      const { chrome } = mount();
      expect(chrome.bar.hidden).toBe(false);
      chrome.reveal();
      expect(chrome.bar.hidden).toBe(false);
      vi.advanceTimersByTime(AUTO_HIDE_MS);
      expect(chrome.bar.hidden).toBe(false);
      expect(chrome.footer.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'hidden' force-hides bar/footer/whisper even while revealed", () => {
    const { chrome } = mount();
    chrome.reveal();
    expect(chrome.bar.hidden).toBe(false);
    expect(chrome.footer.hidden).toBe(false);

    chrome.setConcealZones('hidden', 'hidden');
    expect(chrome.bar.hidden).toBe(true);
    expect(chrome.footer.hidden).toBe(true);
    expect(chrome.whisper.hidden).toBe(true);
    // isRevealed 仍反映原机制（切回 'auto' 时按已显示态续接）。
    expect(chrome.isRevealed()).toBe(true);
  });

  it("'held' force-shows the bar and suppresses idle auto-hide", () => {
    vi.useFakeTimers();
    try {
      const { chrome } = mount();
      chrome.setConcealZones('held', 'auto');
      expect(chrome.bar.hidden).toBe(false);
      expect(chrome.footer.hidden).toBe(false);
      vi.advanceTimersByTime(AUTO_HIDE_MS * 4);
      expect(chrome.bar.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'held' bottom keeps the footer visible when the top zone is hidden", () => {
    const { chrome } = mount();
    chrome.setConcealZones('hidden', 'held');
    expect(chrome.bar.hidden).toBe(true);
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
  });

  it('all hidden writes still go through the single syncDom writer (attrs stay consistent)', () => {
    const { chrome } = mount();
    chrome.setConcealZones('hidden', 'hidden');
    expect(chrome.element.getAttribute('aria-hidden')).toBe('true');
    expect(chrome.bar.getAttribute('aria-hidden')).toBe('true');
    expect(chrome.footer.getAttribute('aria-hidden')).toBe('true');
    expect(chrome.whisper.getAttribute('aria-hidden')).toBe('true');
    chrome.setConcealZones('held', 'held');
    expect(chrome.element.getAttribute('aria-hidden')).toBe('false');
    expect(chrome.bar.getAttribute('aria-hidden')).toBe('false');
    expect(chrome.footer.getAttribute('aria-hidden')).toBe('false');
  });

  it("returning to 'auto' keeps the bars expanded", () => {
    vi.useFakeTimers();
    try {
      const { chrome } = mount();
      chrome.setConcealZones('held', 'held');
      expect(chrome.bar.hidden).toBe(false);
      chrome.setConcealZones('auto', 'auto');
      expect(chrome.bar.hidden).toBe(false);
      vi.advanceTimersByTime(AUTO_HIDE_MS);
      expect(chrome.bar.hidden).toBe(false);
      expect(chrome.footer.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores setConcealZones after destroy', () => {
    const { chrome } = mount();
    chrome.destroy();
    chrome.setConcealZones('held', 'held');
    expect(chrome.isRevealed()).toBe(false);
  });
});

const READER_CONCEAL_LABELS: ReaderConcealBarLabels = {
  toggle: '摸鱼',
  toggleLabel: '摸鱼调节',
  sceneNormal: '普通阅读',
  sceneHideOnLeave: '离开即隐',
  sceneFloating: '悬浮看文',
  sceneCustom: '自定义',
  contentOpacity: '不透明度（0–100%）',
  opacityScale: '100 为完全不透明，0 为完全淡出。',
  transparentMode: '透明模式',
  hideTop: '鼠标移出时隐藏顶栏',
  hideBody: '鼠标移出时隐藏主体',
  hideBottom: '鼠标移出时隐藏底栏',
  alwaysOnTop: '窗口置顶',
  miniWindow: '迷你窗口',
  clickThrough: '点击穿透',
  needsTransparent: '需要先打开透明模式。',
  clickThroughHint: '需开启透明模式；可见顶栏、底栏按钮的点击仍由轻墨接收。',
  sceneNormalResult:
    '页面回到主题背景；窗口不透明；正文完全不透明；鼠标离开时不隐藏顶栏、正文或底栏；不置顶；不是迷你窗口；点击不穿透。',
  sceneHideOnLeaveResult:
    '保留已选页面背景；窗口透明；正文完全不透明；鼠标离开时隐藏顶栏、正文和底栏；置顶；不是迷你窗口；点击穿透，看得见的轻墨控件仍可操作。',
  sceneFloatingResult:
    '保留已选页面背景；窗口透明；正文不透明度为 60；鼠标离开时不隐藏顶栏、正文或底栏；置顶；迷你窗口；点击不穿透。',
  effectWindowTransparent: '窗口透明',
  effectWindowOpaque: '窗口不透明',
  effectOpacity: '正文不透明度为 {value}',
  effectHideNone: '鼠标离开时不隐藏顶栏、正文或底栏',
  effectHidePrefix: '鼠标离开时隐藏',
  regionSeparator: '、',
  regionTop: '顶栏',
  regionBody: '正文',
  regionBottom: '底栏',
  effectPinned: '置顶',
  effectNotPinned: '不置顶',
  effectMini: '迷你窗口',
  effectNotMini: '不是迷你窗口',
  effectClickThrough: '点击穿透，看得见的轻墨控件仍可操作',
  effectNoClickThrough: '点击不穿透',
  effectSeparator: '；',
  bossKeyActive: '当前生效：{combo}',
};

function attachConceal(
  chrome: ReaderChrome,
  initial: Partial<ConcealPrefs> = {},
) {
  let prefs: ConcealPrefs = { ...defaultConcealPrefs(false), ...initial };
  const previewOpacity = vi.fn();
  const commitOpacity = vi.fn((value: number) => {
    prefs = { ...prefs, contentOpacity: value };
  });
  const applyPrefs = vi.fn((next: ConcealPrefs) => {
    prefs = next;
  });
  const clearRefusal = vi.fn();
  const onLayout = vi.fn();
  let listener: ((key: ReaderConcealRefusalKey, reason: string) => void) | null = null;
  chrome.attachConcealBar({
    labels: () => ({ ...READER_CONCEAL_LABELS }),
    getPrefs: () => prefs,
    applyPrefs,
    previewOpacity,
    commitOpacity,
    clearRefusal,
    onLayout,
    subscribeRefusals: (next) => {
      listener = next;
      return () => {
        if (listener === next) {
          listener = null;
        }
      };
    },
  });
  const toggle = chrome.bar.querySelector<HTMLButtonElement>('[data-conceal-reader-toggle]');
  const panel = chrome.bar.querySelector<HTMLElement>('[data-conceal-reader-bar]');
  const slider = panel?.querySelector<HTMLInputElement>('[data-conceal-reader-opacity]');
  expect(toggle).toBeTruthy();
  expect(panel).toBeTruthy();
  expect(slider).toBeTruthy();
  return {
    prefs: () => prefs,
    previewOpacity,
    commitOpacity,
    applyPrefs,
    clearRefusal,
    onLayout,
    notifyRefusal: (key: ReaderConcealRefusalKey, reason: string) => listener?.(key, reason),
    toggle: toggle!,
    panel: panel!,
    slider: slider!,
  };
}

describe('reader conceal bar', () => {
  it('stays off the editor, Android, shelf, and an unattached reader chrome', () => {
    expect(
      shouldAttachReaderConcealBar({ concealEnabled: true, android: false, surface: 'reader' }),
    ).toBe(true);
    expect(
      shouldAttachReaderConcealBar({ concealEnabled: true, android: false, surface: 'shelf' }),
    ).toBe(false);
    expect(
      shouldAttachReaderConcealBar({ concealEnabled: true, android: false, surface: 'editor' }),
    ).toBe(false);
    expect(
      shouldAttachReaderConcealBar({ concealEnabled: true, android: true, surface: 'reader' }),
    ).toBe(false);
    expect(
      shouldAttachReaderConcealBar({ concealEnabled: false, android: false, surface: 'reader' }),
    ).toBe(false);

    const desktop = mount();
    desktop.chrome.reveal();
    expect(desktop.host.querySelector('[data-conceal-reader-bar]')).toBeNull();
    expect(desktop.host.querySelector('[data-conceal-reader-toggle]')).toBeNull();

    const touch = mount({ touchMode: true });
    touch.chrome.reveal();
    expect(touch.host.querySelector('[data-conceal-reader-bar]')).toBeNull();
  });

  it('keeps the shelf conceal copy and adds the reader-bar labels in both locales', () => {
    expect(translate('zh-CN', 'conceal.group')).toBe('摸鱼');
    expect(translate('en', 'conceal.group')).toBe('Stealth reading');
    expect(translate('zh-CN', 'conceal.groupDodge')).toBe('躲开');
    expect(translate('en', 'conceal.groupDodge')).toBe('Duck away');
    expect(translate('zh-CN', 'conceal.groupDisguise')).toBe('看起来不像在看书');
    expect(translate('zh-CN', 'conceal.groupFloat')).toBe('浮在工作上');
    expect(translate('en', 'conceal.groupFloat')).toBe('Float over work');
    expect(translate('zh-CN', 'conceal.sceneNormal')).toBe('普通阅读');
    expect(translate('zh-CN', 'conceal.sceneHideOnLeave')).toBe('离开即隐');
    expect(translate('zh-CN', 'conceal.sceneFloating')).toBe('悬浮看文');
    expect(translate('zh-CN', 'conceal.sceneCustom')).toBe('自定义');
    expect(translate('en', 'conceal.sceneNormal')).toBe('Normal reading');
    expect(translate('en', 'conceal.sceneHideOnLeave')).toBe('Hide on leave');
    expect(translate('en', 'conceal.sceneFloating')).toBe('Floating read');
    expect(translate('zh-CN', 'conceal.exitHint')).toBe('按下会退出轻墨。');
    expect(translate('en', 'conceal.exitHint')).toBe('Pressing this quits LightInk.');
    expect(translate('zh-CN', 'conceal.opacityScale')).toBe('100 为完全不透明，0 为完全淡出。');
    expect(translate('zh-CN', 'conceal.contentOpacity')).toBe('不透明度（0–100%）');
    expect(translate('en', 'conceal.contentOpacity')).toBe('Content opacity (0–100%)');
    expect(translate('zh-CN', 'conceal.sceneNormalResult')).toBe(
      '页面回到主题背景；窗口不透明；正文完全不透明；鼠标离开时不隐藏顶栏、正文或底栏；不置顶；不是迷你窗口；点击不穿透。',
    );
    expect(translate('en', 'conceal.sceneFloatingResult')).toBe(
      'Keeps the chosen page background; the window is transparent; text opacity is 60; leaving does not hide the top bar, text, or bottom bar; pinned; mini window; clicks do not pass through.',
    );
    expect(translate('zh-CN', 'conceal.readerBar')).toBe('摸鱼');
    expect(translate('en', 'conceal.readerBar')).toBe('Stealth');
    expect(translate('zh-CN', 'conceal.readerBarLabel')).toBe('摸鱼调节');
    expect(translate('en', 'conceal.readerBarLabel')).toBe('Stealth adjustments');
  });

  it('collapses inside the top bar without font, spacing, or page-turn controls', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf8');
    const panelRule = cssRuleBodies(css, /\.lightink-reader-conceal-panel/).join('\n');
    expect(panelRule).toMatch(/flex:\s*1\s+0\s+100%/);
    expect(panelRule).not.toMatch(/position\s*:\s*(fixed|absolute)/);
    expect(cssRuleBodies(css, /\.lightink-reader-conceal-panel\[hidden\]/).join('\n')).toMatch(
      /display\s*:\s*none/,
    );

    const { host, chrome } = mount();
    chrome.reveal();
    const bar = attachConceal(chrome, { contentOpacity: 40, bossPrimary: 'Alt+Z' });
    expect(chrome.bar.contains(bar.panel)).toBe(true);
    expect(chrome.bar.contains(bar.toggle)).toBe(true);
    expect(chrome.bar.style.flexWrap).toBe('wrap');
    expect(bar.panel.hidden).toBe(true);
    expect(bar.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bar.onLayout).toHaveBeenCalledTimes(1);

    expect(labeledButtons(host)).toHaveLength(6);
    expect(
      [...host.querySelectorAll('[data-reader-chrome-action]')].map(
        (button) => (button as HTMLElement).dataset.readerChromeAction,
      ),
    ).toEqual([...READER_CHROME_ACTIONS]);

    bar.toggle.click();
    expect(bar.panel.hidden).toBe(false);
    expect(bar.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(bar.onLayout).toHaveBeenCalledTimes(2);
    expect(bar.panel.querySelector('[data-reader-chrome-action]')).toBeNull();
    expect(bar.panel.textContent ?? '').not.toMatch(/字号|行距|翻页/);
    expect([...bar.panel.querySelectorAll('input')].map((input) => input.type)).toEqual([
      'checkbox',
      'range',
      'checkbox',
      'checkbox',
      'checkbox',
      'checkbox',
      'checkbox',
      'checkbox',
    ]);
    expect(bar.panel.querySelector('[data-conceal-scene="normal"]')?.textContent).toBe('普通阅读');
    expect(bar.panel.querySelector('[data-conceal-scene="hideOnLeave"]')?.textContent).toBe('离开即隐');
    expect(bar.panel.querySelector('[data-conceal-scene="floating"]')?.textContent).toBe('悬浮看文');
    expect(bar.panel.querySelector('[data-conceal-scene-result="hideOnLeave"]')?.textContent).toBe(
      READER_CONCEAL_LABELS.sceneHideOnLeaveResult,
    );
    expect(
      bar.panel.querySelector('[data-conceal-scene="hideOnLeave"]')?.contains(
        bar.panel.querySelector('[data-conceal-scene-result="hideOnLeave"]'),
      ),
    ).toBe(false);
    expect(bar.panel.querySelector('.lightink-reader-conceal-opacity span')?.textContent).toBe(
      '不透明度（0–100%）',
    );
    expect(bar.panel.querySelector('[data-conceal-scene="custom"]')?.tagName).toBe('SPAN');
    expect(bar.panel.querySelector('[data-conceal-scene="custom"]')?.textContent).toBe('自定义');
    const customEffect = bar.panel.querySelector<HTMLElement>('[data-conceal-custom-effect]');
    expect(customEffect?.hidden).toBe(false);
    expect(customEffect?.textContent).toBe(
      '窗口不透明；正文不透明度为 40；鼠标离开时不隐藏顶栏、正文或底栏；不置顶；不是迷你窗口；点击不穿透',
    );
    expect(bar.panel.querySelector('[data-conceal-reader-opacity-scale]')?.textContent).toBe(
      '100 为完全不透明，0 为完全淡出。',
    );
    expect(bar.panel.querySelector('[data-conceal-reader-boss]')?.textContent).toBe('当前生效：Alt+Z');

    bar.toggle.click();
    expect(bar.panel.hidden).toBe(true);
    expect(bar.onLayout).toHaveBeenCalledTimes(3);
    expect(bar.panel.hidden).toBe(true);
  });

  it('applies the same scene prefs as the shelf and shows a refusal beside the switch', () => {
    const { chrome } = mount();
    chrome.reveal();
    const before: ConcealPrefs = {
      ...defaultConcealPrefs(false),
      background: { kind: 'preset', preset: 'mint' },
      contentOpacity: 40,
      transparentMode: true,
      clickThrough: true,
      bossPrimary: 'Alt+P',
      bossSecondary: 'Alt+Q',
    };
    const bar = attachConceal(chrome, before);
    bar.toggle.click();
    const floatingButton = bar.panel.querySelector<HTMLButtonElement>('[data-conceal-scene="floating"]');
    expect(floatingButton?.disabled).toBe(false);
    expect(chrome.bar.contains(floatingButton!)).toBe(true);
    floatingButton?.click();

    const floating = applyConcealScene(before, 'floating');
    expect(bar.applyPrefs).toHaveBeenCalledWith(floating);
    expect(bar.prefs()).toEqual(floating);
    expect(bar.prefs().bossPrimary).toBe('Alt+P');
    expect(bar.prefs().background).toEqual({ kind: 'preset', preset: 'mint' });
    for (const key of READER_CONCEAL_REFUSAL_KEYS) {
      expect(bar.clearRefusal).toHaveBeenCalledWith(key);
    }
    expect(bar.clearRefusal.mock.invocationCallOrder[0]).toBeLessThan(
      bar.applyPrefs.mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      bar.panel.querySelector('[data-conceal-scene="floating"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(bar.slider.value).toBe('60');

    const sceneButton = bar.panel.querySelector<HTMLButtonElement>('[data-conceal-scene="normal"]');
    expect(sceneButton?.disabled).toBe(false);
    expect(chrome.bar.contains(sceneButton!)).toBe(true);
    sceneButton?.click();
    expect(bar.prefs().background).toEqual({ kind: 'theme' });
    expect(bar.prefs().contentOpacity).toBe(100);
    expect(bar.prefs().clickThrough).toBe(false);

    (bar.prefs() as { alwaysOnTop: boolean }).alwaysOnTop = true;
    chrome.syncConcealBar();
    expect(bar.panel.querySelector('[data-conceal-scene="custom"]')?.getAttribute('aria-current')).toBe(
      'true',
    );
    expect(bar.panel.querySelector('[data-conceal-scene="custom"]')?.textContent).toBe('自定义');
    expect(bar.panel.querySelector('[data-conceal-custom-effect]')?.textContent).toContain('置顶');

    (bar.prefs() as { transparentMode: boolean }).transparentMode = true;
    chrome.syncConcealBar();
    bar.notifyRefusal('miniWindow', '迷你窗口失败');
    bar.notifyRefusal('clickThrough', '穿透被拒绝');
    const miniReason = bar.panel.querySelector<HTMLElement>(
      '[data-conceal-reader-switch-reason="miniWindow"]',
    );
    const clickReason = bar.panel.querySelector<HTMLElement>(
      '[data-conceal-reader-switch-reason="clickThrough"]',
    );
    expect(miniReason?.hidden).toBe(false);
    expect(miniReason?.textContent).toBe('迷你窗口失败');
    expect(clickReason?.hidden).toBe(false);
    expect(clickReason?.textContent).toBe('穿透被拒绝');
    expect(bar.panel.querySelector('.lightink-reader-conceal-scenes-row')?.contains(miniReason!)).toBe(
      false,
    );
    expect(miniReason?.closest('[data-conceal-reader-switch="miniWindow"]')).not.toBeNull();
    expect(clickReason?.closest('[data-conceal-reader-switch="clickThrough"]')).not.toBeNull();
    bar.notifyRefusal('miniWindow', '');
    bar.notifyRefusal('clickThrough', '');
    expect(miniReason?.hidden).toBe(true);
    expect(clickReason?.textContent).toBe(READER_CONCEAL_LABELS.clickThroughHint);
  });

  it('toggles the existing conceal switches with the full prefs', () => {
    const { chrome } = mount();
    chrome.reveal();
    const bar = attachConceal(chrome, {
      contentOpacity: 40,
      bossPrimary: 'Alt+Z',
      hideTop: true,
    });
    bar.toggle.click();
    const input = (key: string): HTMLInputElement =>
      bar.panel.querySelector<HTMLInputElement>(`[data-conceal-reader-toggle="${key}"]`)!;
    const reason = (key: string): HTMLElement =>
      bar.panel.querySelector<HTMLElement>(`[data-conceal-reader-switch-reason="${key}"]`)!;

    expect(input('transparentMode').checked).toBe(false);
    expect(input('hideTop').disabled).toBe(true);
    expect(input('hideTop').checked).toBe(true);
    expect(input('hideBody').disabled).toBe(true);
    expect(input('clickThrough').disabled).toBe(true);
    expect(input('hideBottom').disabled).toBe(false);
    expect(reason('hideTop').textContent).toBe('需要先打开透明模式。');
    expect(reason('hideBody').textContent).toBe('需要先打开透明模式。');
    expect(reason('clickThrough').textContent).toBe('需要先打开透明模式。');
    expect(reason('hideBottom').hidden).toBe(true);

    input('hideTop').checked = false;
    input('hideTop').dispatchEvent(new Event('change', { bubbles: true }));
    expect(bar.applyPrefs).not.toHaveBeenCalled();
    expect(input('hideTop').checked).toBe(true);

    input('hideBottom').checked = true;
    input('hideBottom').dispatchEvent(new Event('change', { bubbles: true }));
    expect(bar.applyPrefs).toHaveBeenCalledWith({
      ...defaultConcealPrefs(false),
      contentOpacity: 40,
      bossPrimary: 'Alt+Z',
      hideTop: true,
      hideBottom: true,
    });

    input('transparentMode').checked = true;
    input('transparentMode').dispatchEvent(new Event('change', { bubbles: true }));
    expect(input('hideTop').disabled).toBe(false);
    expect(reason('hideTop').hidden).toBe(true);
    expect(input('clickThrough').disabled).toBe(false);
    expect(reason('clickThrough').textContent).toBe(READER_CONCEAL_LABELS.clickThroughHint);
    expect(reason('clickThrough').classList.contains('is-error')).toBe(false);
  });

  it('previews opacity while dragging and keeps the committed integer after collapse', () => {
    const { chrome } = mount();
    chrome.reveal();
    const bar = attachConceal(chrome, { contentOpacity: 40 });
    bar.toggle.click();
    expect(bar.slider.value).toBe('40');

    bar.slider.value = '25';
    bar.slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(bar.previewOpacity).toHaveBeenCalledWith(25);
    expect(bar.commitOpacity).not.toHaveBeenCalled();
    expect(bar.prefs().contentOpacity).toBe(40);

    bar.slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bar.commitOpacity).toHaveBeenCalledTimes(1);
    expect(bar.commitOpacity).toHaveBeenCalledWith(25);
    expect(bar.prefs().contentOpacity).toBe(25);

    bar.slider.value = '10';
    bar.slider.dispatchEvent(new Event('input', { bubbles: true }));
    bar.toggle.click();
    expect(bar.panel.hidden).toBe(true);
    expect(bar.commitOpacity).toHaveBeenCalledWith(10);
    expect(bar.prefs().contentOpacity).toBe(10);

    bar.toggle.click();
    expect(bar.panel.hidden).toBe(false);
    expect(bar.slider.value).toBe('10');

    bar.slider.value = '101';
    bar.slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bar.commitOpacity).not.toHaveBeenCalledWith(101);
    expect(bar.slider.value).toBe('10');
    bar.slider.value = '50.5';
    bar.slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bar.slider.value).toBe('10');
  });

  it('can be operated again when the hidden top bar is held', () => {
    const { chrome } = mount();
    const bar = attachConceal(chrome);
    chrome.setConcealZones('hidden', 'auto');
    expect(chrome.bar.hidden).toBe(true);
    chrome.setConcealZones('held', 'auto');
    expect(chrome.bar.hidden).toBe(false);
    expect(bar.toggle.hidden).toBe(false);
    bar.toggle.click();
    expect(bar.panel.hidden).toBe(false);
    bar.panel.querySelector<HTMLButtonElement>('[data-conceal-scene="hideOnLeave"]')?.click();
    expect(bar.applyPrefs).toHaveBeenCalledTimes(1);
    expect(bar.prefs().hideTop).toBe(true);
    expect(bar.prefs().clickThrough).toBe(true);
  });

  it('keeps the conceal panel available while hide-on-leave hides the top zone', () => {
    vi.useFakeTimers();
    try {
      const { chrome } = mount();
      const bar = attachConceal(chrome);
      chrome.setConcealZones('held', 'auto');
      bar.toggle.click();
      bar.panel.querySelector<HTMLButtonElement>('[data-conceal-scene="hideOnLeave"]')?.click();

      chrome.setConcealZones('hidden', 'auto');
      expect(chrome.bar.hidden).toBe(false);
      expect(bar.panel.hidden).toBe(false);
      vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
      expect(bar.panel.hidden).toBe(false);

      bar.toggle.click();
      expect(bar.panel.hidden).toBe(true);
      expect(chrome.bar.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes only effects that still apply after transparent mode is turned off', () => {
    const { chrome } = mount();
    chrome.reveal();
    const bar = attachConceal(chrome, {
      transparentMode: false,
      hideTop: true,
      hideBody: true,
      hideBottom: true,
      alwaysOnTop: true,
      clickThrough: true,
    });
    bar.toggle.click();
    expect(bar.panel.querySelector('[data-conceal-custom-effect]')?.textContent).toBe(
      '窗口不透明；正文不透明度为 100；鼠标离开时隐藏底栏；置顶；不是迷你窗口；点击不穿透',
    );
  });

  it('rejects opacity values outside integers 0–100', () => {
    expect(parseReaderConcealOpacity('0')).toBe(0);
    expect(parseReaderConcealOpacity('100')).toBe(100);
    expect(parseReaderConcealOpacity(' 60 ')).toBe(60);
    expect(parseReaderConcealOpacity('101')).toBeNull();
    expect(parseReaderConcealOpacity('-1')).toBeNull();
    expect(parseReaderConcealOpacity('50.5')).toBeNull();
    expect(parseReaderConcealOpacity('')).toBeNull();
    expect(parseReaderConcealOpacity('nope')).toBeNull();
  });
});

describe('reader conceal bar R15 detach', () => {
  it('removes toggle+panel and restores bar children; reattach works', () => {
    const { chrome } = mount();
    chrome.reveal();
    const bar = attachConceal(chrome, { alwaysOnTop: true });
    bar.toggle.click();
    expect(chrome.bar.querySelector('[data-conceal-reader-bar]')).toBeTruthy();
    // attach 把原内容合入一行 + 追加面板，bar 只剩 row+panel 两个直接子级。
    expect(chrome.bar.children.length).toBe(2);

    chrome.detachConcealBar();

    expect(chrome.bar.querySelector('[data-conceal-reader-bar]')).toBeNull();
    expect(chrome.bar.querySelector('[data-conceal-reader-toggle]')).toBeNull();
    // 合入的包裹行已移除，原按钮回到 bar 直接子级。
    expect(chrome.bar.querySelector('.lightink-reader-chrome-bar-row')).toBeNull();
    expect(chrome.bar.children.length).toBeGreaterThan(2);

    // 幂等：未挂载时无操作。
    chrome.detachConcealBar();

    // 重新挂载恢复完整调节条。
    const reattached = attachConceal(chrome, { alwaysOnTop: true });
    expect(reattached.panel.querySelector('[data-conceal-scene]')).toBeTruthy();
  });
});
