// @vitest-environment jsdom

/**
 * Contract for `src/reader/reader-chrome.ts` (T3 / R4 / R5 + 搜索一等入口):
 *
 * `createReaderChrome(host, deps)` mounts an overlay on the reading host.
 * First paint is hidden except a 1px progress hairline. A page click
 * or a pointer near the top/bottom edge reveals five text-labeled actions
 * together with a progress footer:
 *   返回书架 · 目录 · 排版 · 书签 · 搜索
 * 「返回书架」 is the first control (start of the top bar). It is the only
 * path that calls injected `returnToShelf`. 目录 / 排版 / 搜索
 * call `openOutline` / `openTypography` / `openSearch`. 书签 calls
 * `toggleBookmark` and reflects `isBookmarked` as a two-state toggle.
 * 搜索 lives in the tools cluster and opens the annotation sidebar (notes +
 * in-book search); chrome does not add a second 本书标注 control.
 *
 * The bar is out of document flow (`position: absolute|fixed|sticky`) so
 * reveal/dismiss does not change the reading area's top or height.
 * Idle auto-hide is 2500ms unless `isOverlayOpen()` is true.
 *
 * `handleEscape()` closes one layer and never calls `returnToShelf`
 * (window-level leftover Escape owns 合书). Order:
 *   selection toolbar → annotation sidebar → dismissOverlay() → chrome bar.
 * Return true when a layer closed; false when nothing is open.
 *
 * Deps: `returnToShelf`, `openOutline`, `openSearch`, `openTypography`,
 * `toggleSidebar`, optional `isOverlayOpen`, `dismissOverlay`,
 * `isSidebarVisible`, `isSelectionToolbarVisible`, `hideSelectionToolbar`.
 *
 * Touch mode (`touchMode: true`): no idle auto-hide and no edge-hover
 * reveal — the chrome only leaves via center tap, Escape, or closing an
 * overlay. Desktop behavior above is unchanged when the flag is absent.
 * toc / typography / bookmark / search live in the footer thumb zone
 * (hit target ≥48×48, adjacent gap ≥8px) so they stay reachable after the
 * top bar is dismissed. backToShelf stays on the top bar with the same
 * 48×48 hit. Text books and comics share this reveal/dismiss chrome.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReaderChrome,
  READER_CHROME_ACTIONS,
  READER_CHROME_TOUCH_GAP_PX,
  READER_CHROME_TOUCH_HIT_PX,
} from '../reader-chrome.js';

const LABELS = ['返回书架', '目录', '排版', '书签', '搜索'] as const;
const THUMB_ACTIONS = ['toc', 'typography', 'bookmark', 'search'] as const;
const PRIMARY_TOUCH_ACTIONS = ['backToShelf', ...THUMB_ACTIONS] as const;
const AUTO_HIDE_MS = 2500;
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

function footerThumbZone(footer: HTMLElement): HTMLElement {
  return (
    footer.querySelector<HTMLElement>('.lightink-reader-chrome-thumb') ??
    footer.querySelector<HTMLElement>('.lightink-reader-chrome-tools') ??
    footer
  );
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
  it('starts hidden with no editor menus or markdown tab bar', () => {
    const { host, chrome } = mount();

    expect(chrome.isRevealed()).toBe(false);
    expect(host.querySelector('#lightink-toolbar')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    expect(host.textContent).not.toContain('文件');
    expect(host.textContent).not.toContain('插入');
    expect(labeledButtons(host).some((button) => !button.hidden && button.offsetParent !== null)).toBe(
      false,
    );
  });
});

describe('createReaderChrome reveal', () => {
  it('reveals five text-labeled controls with 返回书架 first after a page click', () => {
    const { host, page, chrome } = mount();

    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(true);

    const buttons = labeledButtons(host);
    expect(buttons).toHaveLength(5);
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
    expect(bar?.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(
      host.querySelector('.lightink-reader-chrome-drag')?.hasAttribute('data-tauri-drag-region'),
    ).toBe(false);
    chrome.reveal();
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')?.trim()).toBe(button.textContent?.trim());
      expect(button.hidden).toBe(false);
      expect((button.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(button.textContent?.trim()).not.toBe('×');
      expect(button.textContent?.trim()).not.toBe('编辑');
    }
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

  it('shows the idle whisper only when progress docks are not suppressed', () => {
    let covering = true;
    const { chrome } = mount({ suppressProgressDock: () => covering });
    expect(chrome.whisper.hidden).toBe(true);
    covering = false;
    chrome.dismiss();
    expect(chrome.whisper.hidden).toBe(false);
  });

  it('hides the idle whisper in scroll mode so it does not cover the last line', () => {
    const { host, chrome } = mount();
    host.dataset.readingLayout = 'scroll';
    chrome.dismiss();
    expect(chrome.whisper.hidden).toBe(true);
    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    chrome.dismiss();
    expect(chrome.whisper.hidden).toBe(true);
  });

  it('keeps the touch footer tools when comic progress docks are suppressed', () => {
    const { host, chrome } = mount({
      touchMode: true,
      suppressProgressDock: () => true,
    });
    expect(chrome.isRevealed()).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);
    expect(chrome.bar.contains(actionButton(host, 'backToShelf'))).toBe(true);
    expect(actionButton(host, 'backToShelf').hidden).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.footer.contains(actionButton(host, action))).toBe(true);
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
    expect(chrome.isRevealed()).toBe(false);

    page.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(false);
  });

  it('reveals when the pointer rests near the top or bottom edge', () => {
    const { host, chrome } = mount();

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(true);

    chrome.dismiss();
    expect(chrome.isRevealed()).toBe(false);

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 394 }),
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

  it('keeps the bookmark toggle in the touch footer thumb zone with a 48px hit', () => {
    const { host, chrome, deps } = mount({ touchMode: true });
    chrome.reveal();
    const button = actionButton(host, 'bookmark');
    const zone = footerThumbZone(chrome.footer);
    expect(zone.contains(button)).toBe(true);
    expect(chrome.bar.contains(button)).toBe(false);
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

  it('hides the chrome bar on the next Escape and still does not return to the shelf', () => {
    const { chrome, deps } = mount();
    chrome.reveal();

    expect(chrome.handleEscape()).toBe(true);
    expect(chrome.isRevealed()).toBe(false);
    expect(deps.returnToShelf).not.toHaveBeenCalled();

    expect(chrome.handleEscape()).toBe(false);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
  });
});

describe('createReaderChrome auto-hide', () => {
  it('dismisses after 2.5s idle and stays up while an overlay is open', () => {
    vi.useFakeTimers();
    const overlay = { open: false };
    const { chrome } = mount({
      isOverlayOpen: () => overlay.open,
    });

    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
    expect(chrome.isRevealed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chrome.isRevealed()).toBe(false);

    overlay.open = true;
    chrome.reveal();
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
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

  it('stays revealed while stayRevealed is true', () => {
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
    expect(chrome.isRevealed()).toBe(false);
  });

  it('reveals when syncStayRevealed runs at the top of scroll mode', () => {
    const { chrome } = mount({
      stayRevealed: () => true,
    });
    expect(chrome.isRevealed()).toBe(false);
    chrome.syncStayRevealed();
    expect(chrome.isRevealed()).toBe(true);
  });
});

describe('createReaderChrome touch mode', () => {
  it('starts immersive: chrome hidden, no desktop menus, and no hover-only path', () => {
    const { host, chrome } = mount({ touchMode: true });

    expect(chrome.isRevealed()).toBe(false);
    expect(chrome.bar.hidden).toBe(true);
    expect(host.querySelector('#lightink-toolbar')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    expect(host.textContent).not.toContain('文件');
    expect(host.textContent).not.toContain('插入');
    for (const action of PRIMARY_TOUCH_ACTIONS) {
      expect(actionButton(host, action).hidden).toBe(true);
    }
    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(false);
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

  it('does not reveal from edge hover: pointermove is a no-op', () => {
    const { host, chrome } = mount({ touchMode: true });

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 6 }),
    );
    expect(chrome.isRevealed()).toBe(false);

    host.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, clientX: 80, clientY: 394 }),
    );
    expect(chrome.isRevealed()).toBe(false);

    chrome.handlePointerMove({ clientY: 4 });
    chrome.handlePointerMove({ clientY: 396 });
    expect(chrome.isRevealed()).toBe(false);
  });

  it('toggles with center taps and stays up between them', () => {
    vi.useFakeTimers();
    const { host, page, chrome } = mount({ touchMode: true });
    const before = page.getBoundingClientRect();

    clickPage(page, 200);
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.bar.contains(actionButton(host, 'backToShelf'))).toBe(true);
    expect(actionButton(host, 'backToShelf').hidden).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.footer.contains(actionButton(host, action))).toBe(true);
      expect(actionButton(host, action).hidden).toBe(false);
    }
    const shown = page.getBoundingClientRect();
    expect(shown.top).toBe(before.top);
    expect(shown.height).toBe(before.height);
    vi.advanceTimersByTime(AUTO_HIDE_MS * 2);
    expect(chrome.isRevealed()).toBe(true);

    clickPage(page, 200);
    expect(chrome.isRevealed()).toBe(false);
    for (const action of PRIMARY_TOUCH_ACTIONS) {
      expect(actionButton(host, action).hidden).toBe(true);
    }
    const hidden = page.getBoundingClientRect();
    expect(hidden.top).toBe(before.top);
    expect(hidden.height).toBe(before.height);
  });

  it('hides via Escape and brings the whisper progress line back', () => {
    const { chrome, deps } = mount({ touchMode: true });
    chrome.reveal();
    expect(chrome.whisper.hidden).toBe(true);

    expect(chrome.handleEscape()).toBe(true);
    expect(chrome.isRevealed()).toBe(false);
    expect(chrome.whisper.hidden).toBe(false);
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

  it('keeps the whisper visible while the chrome is hidden', () => {
    const { chrome } = mount({ touchMode: true });
    expect(chrome.whisper.hidden).toBe(false);
    chrome.setProgress({ chapterTitle: '第一章', location: '2 / 10', progress: 0.25 });
    expect(chrome.whisper.querySelector('.lightink-reader-chrome-whisper-progress')?.textContent).toBe(
      '25%',
    );
  });

  it('places toc / typography / bookmark / search in the footer thumb zone', () => {
    const { host, chrome } = mount({ touchMode: true });
    chrome.reveal();

    const zone = footerThumbZone(chrome.footer);
    expect(chrome.footer.contains(zone)).toBe(true);
    for (const action of THUMB_ACTIONS) {
      const button = actionButton(host, action);
      expect(zone.contains(button), `${action} should live in the footer thumb zone`).toBe(true);
      expect(chrome.bar.contains(button), `${action} should leave the top bar in touchMode`).toBe(
        false,
      );
      expect(button.hidden).toBe(false);
    }
  });

  it('keeps the four thumb actions reachable after the top bar is dismissed', () => {
    const { chrome, deps } = mount({ touchMode: true });
    chrome.reveal();

    chrome.bar.hidden = true;
    chrome.bar.style.display = 'none';

    const clicks: Array<[string, () => void]> = [
      ['toc', () => expect(deps.openOutline).toHaveBeenCalledTimes(1)],
      ['typography', () => expect(deps.openTypography).toHaveBeenCalledTimes(1)],
      ['bookmark', () => expect(deps.toggleBookmark).toHaveBeenCalledTimes(1)],
      ['search', () => expect(deps.openSearch).toHaveBeenCalledTimes(1)],
    ];
    for (const [action, assertCall] of clicks) {
      const button = actionButton(chrome.footer, action);
      expect(chrome.footer.contains(button)).toBe(true);
      expect(button.hidden).toBe(false);
      expect(button.offsetParent !== null || chrome.footer.hidden === false).toBe(true);
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
      if (action === 'backToShelf') {
        expect(chrome.bar.contains(button), 'backToShelf stays on the top bar').toBe(true);
      } else {
        expect(chrome.footer.contains(button), `${action} must be in the footer to measure`).toBe(
          true,
        );
      }
      const size = declaredHitPx(button);
      if (size > 0) {
        expect(size, `${action} hit target`).toBeGreaterThanOrEqual(MIN_HIT_PX);
      }
      expect(Number(button.dataset.readerChromeHit ?? size)).toBeGreaterThanOrEqual(MIN_HIT_PX);
    }

    const zone = footerThumbZone(chrome.footer);
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
      /\.lightink-reader-chrome-tools\s*\{[^}]*flex-wrap:\s*nowrap[^}]*gap:\s*0\.4rem/,
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
  it('shows the whisper while chrome is hidden and the footer when revealed', () => {
    const { chrome } = mount();
    expect(chrome.footer.hidden).toBe(true);
    expect(chrome.whisper.hidden).toBe(false);

    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    expect(chrome.whisper.hidden).toBe(true);

    chrome.dismiss();
    expect(chrome.footer.hidden).toBe(true);
    expect(chrome.whisper.hidden).toBe(false);
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
