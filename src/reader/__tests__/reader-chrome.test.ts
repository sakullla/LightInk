// @vitest-environment jsdom

/**
 * Contract for `src/reader/reader-chrome.ts` (T3 / R4 / R5):
 *
 * `createReaderChrome(host, deps)` mounts an overlay on the reading host.
 * First paint is hidden except a low-contrast chapter whisper. A page click
 * or a pointer near the top/bottom edge reveals four text-labeled actions
 * together with a progress footer:
 *   返回书架 · 目录 · 排版 · 本书标注
 * 「返回书架」 is the first control (start of the top bar). It is the only
 * path that calls injected `returnToShelf`. 目录 / 排版 / 本书标注 call
 * `openOutline` / `openTypography` / `toggleSidebar`.
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
 * Deps: `returnToShelf`, `openOutline`, `openTypography`, `toggleSidebar`,
 * optional `isOverlayOpen`, `dismissOverlay`, `isSidebarVisible`,
 * `isSelectionToolbarVisible`, `hideSelectionToolbar`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderChrome } from '../reader-chrome.js';

const LABELS = ['返回书架', '目录', '排版', '本书标注'] as const;
const AUTO_HIDE_MS = 2500;

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
    openTypography: vi.fn(),
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

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
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
  it('reveals four text-labeled controls with 返回书架 first after a page click', () => {
    const { host, page, chrome } = mount();

    clickPage(page, 120);
    expect(chrome.isRevealed()).toBe(true);

    const buttons = labeledButtons(host);
    expect(buttons).toHaveLength(4);
    expect(buttons[0]!.textContent?.trim()).toBe('返回书架');
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([...LABELS]);
    const bar = host.querySelector('.lightink-reader-chrome-bar');
    expect(bar?.getAttribute('data-tauri-drag-region')).toBe('');
    expect(host.querySelector('.lightink-reader-chrome-drag')?.getAttribute('data-tauri-drag-region')).toBe(
      '',
    );
    for (const button of buttons) {
      expect(button.hasAttribute('data-tauri-drag-region')).toBe(false);
    }
    for (const button of buttons) {
      expect(button.hidden).toBe(false);
      expect((button.textContent ?? '').trim().length).toBeGreaterThan(0);
      expect(button.textContent?.trim()).not.toBe('×');
      expect(button.textContent?.trim()).not.toBe('编辑');
    }
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
    buttonByLabel(host, '排版').click();
    buttonByLabel(host, '本书标注').click();
    expect(deps.openOutline).toHaveBeenCalledTimes(1);
    expect(deps.openTypography).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).toHaveBeenCalledTimes(1);
    expect(deps.returnToShelf).not.toHaveBeenCalled();

    buttonByLabel(host, '返回书架').click();
    expect(deps.returnToShelf).toHaveBeenCalledTimes(1);
    expect(deps.openOutline).toHaveBeenCalledTimes(1);
    expect(deps.openTypography).toHaveBeenCalledTimes(1);
    expect(deps.toggleSidebar).toHaveBeenCalledTimes(1);
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
    });
    expect(chrome.footer.querySelector('.lightink-reader-chrome-chapter')?.textContent).toBe(
      '第一章',
    );
    expect(chrome.whisper.querySelector('.lightink-reader-chrome-whisper-chapter')?.textContent).toBe(
      '第一章',
    );
    expect(chrome.whisper.querySelector('.lightink-reader-chrome-whisper-progress')?.textContent).toBe(
      '2 / 10 · 25%',
    );
    const slider = chrome.footer.querySelector<HTMLInputElement>('.lightink-reader-chrome-progress');
    expect(slider?.value).toBe('250');
    slider!.value = '500';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onSeekProgress).toHaveBeenCalledWith(0.5);
  });

  it('reveals chrome when the whisper is clicked', () => {
    const { chrome } = mount();
    chrome.whisper.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chrome.isRevealed()).toBe(true);
  });
});
