// @vitest-environment jsdom
// T4（ADR-5）：漫画 chrome 顶栏书签开关——注入接线（onToggleBookmark/
// isPageBookmarked）、aria-pressed 两态（初始/点击 toggle/翻页刷新/外部菜单
// toggle 经 refreshBookmarkState 重同步）与 openPageJump 句柄入口（G 键消费）。
// 书签持久化本身走标注系统既有路径，由 reader-view 集成层覆盖。

import { invoke } from '@tauri-apps/api/core';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCbzInto, type CbzRenderHandle, type CbzRenderOptions } from '../formats/cbz.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const invokeMock = vi.mocked(invoke);

class ControlledIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    void callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

const originalIntersectionObserver = globalThis.IntersectionObserver;
const createObjectUrl = vi.fn<(blob: Blob) => string>();
const revokeObjectUrl = vi.fn<(url: string) => void>();

beforeEach(() => {
  let nextUrl = 0;
  createObjectUrl.mockImplementation(() => `blob:comic-bm-${++nextUrl}`);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl,
  });
  globalThis.IntersectionObserver =
    ControlledIntersectionObserver as unknown as typeof IntersectionObserver;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  createObjectUrl.mockReset();
  revokeObjectUrl.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.documentElement.removeAttribute('lang');
  document.body.replaceChildren();
});

async function buildCbz(pageCount: number): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (let index = 1; index <= pageCount; index += 1) {
    await writer.add(
      `page${index}.png`,
      new Uint8ArrayReader(new Uint8Array([index, index + 1, index + 2])),
      { level: 0 },
    );
  }
  return writer.close();
}

function storageFor(preferences: Record<string, unknown>): {
  getItem: () => string;
  setItem: () => void;
} {
  const value = JSON.stringify(preferences);
  return { getItem: () => value, setItem: () => undefined };
}

interface ComicBookmarkHarness {
  container: HTMLElement;
  handle: CbzRenderHandle;
  button: HTMLButtonElement;
  bookmarked: Set<number>;
}

/**
 * 渲染漫画并按 reader-view 集成口径注入书签接线：isPageBookmarked 读活书签
 * 页集合，onToggleBookmark 复刻 reader-bookmarks 的开关语义（当前位置已有
 * 活书签则移除、否则添加——视图侧同步更新集合，与标注写路径同拍）。
 */
async function renderWithBookmark(pageCount: number): Promise<ComicBookmarkHarness> {
  const bookmarked = new Set<number>();
  const options: CbzRenderOptions = {
    preferenceStorage: storageFor({
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    }),
    cacheBudgetBytes: pageCount + 1,
    onToggleBookmark: () => {
      const page = handle.currentPage;
      if (bookmarked.has(page)) bookmarked.delete(page);
      else bookmarked.add(page);
    },
    isPageBookmarked: (page) => bookmarked.has(page),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handle = await renderCbzInto(await buildCbz(pageCount), container, undefined, options);
  const button = container.querySelector<HTMLButtonElement>('.lightink-reader-comic-bookmark')!;
  expect(button).not.toBeNull();
  return { container, handle, button, bookmarked };
}

function jumpOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.lightink-reader-comic-jump');
}

describe('comic chrome bookmark switch', () => {
  it('renders in the topbar next to the page button with localized labels', async () => {
    const { container, handle, button } = await renderWithBookmark(4);
    const topbar = container.querySelector('.lightink-reader-comic-topbar')!;
    expect(topbar.contains(button)).toBe(true);
    // pageButton 之后、toolbarButton 惯例（comic-tool 类 + aria-label/title）。
    expect(button.className).toContain('lightink-reader-comic-tool');
    expect(button.getAttribute('aria-label')).toBe('Bookmark');
    expect(button.title).toBe('Bookmark');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await handle.destroy();

    document.documentElement.lang = 'zh-CN';
    const zh = await renderWithBookmark(4);
    expect(zh.button.getAttribute('aria-label')).toBe('书签');
    await zh.handle.destroy();
  });

  it('toggles the current page bookmark and refreshes aria-pressed after each click', async () => {
    const { handle, button, bookmarked } = await renderWithBookmark(6);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    button.click(); // 添加当前页书签
    expect(bookmarked.has(1)).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    button.click(); // 再点一次 = 移除（开关语义）
    expect(bookmarked.has(1)).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await handle.destroy();
  });

  it('refreshes the pressed state as the current page changes', async () => {
    const { handle, button, bookmarked } = await renderWithBookmark(6);
    bookmarked.add(3);
    handle.refreshBookmarkState?.();
    expect(button.getAttribute('aria-pressed')).toBe('false'); // 第 1 页未书签

    handle.scrollToPage(3);
    expect(handle.currentPage).toBe(3);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    handle.scrollToPage(5);
    expect(handle.currentPage).toBe(5);
    expect(button.getAttribute('aria-pressed')).toBe('false');

    handle.scrollToPage(3);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await handle.destroy();
  });

  it('re-syncs via the handle entry after an external (menu) toggle', async () => {
    const { handle, button, bookmarked } = await renderWithBookmark(6);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // 应用菜单路径（ReaderInstance.addBookmark → reader-bookmarks.toggle）：
    // 集合在外部变化后经 refreshBookmarkState 入口重同步按钮两态。
    bookmarked.add(1);
    handle.refreshBookmarkState?.();
    expect(button.getAttribute('aria-pressed')).toBe('true');

    bookmarked.delete(1);
    handle.refreshBookmarkState?.();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await handle.destroy();
  });

  it('stays unpressed and inert when no bookmark wiring is injected', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: storageFor({ mode: 'paged', direction: 'ltr', spread: 'single', fit: 'screen' }),
      cacheBudgetBytes: 4,
    });
    const button = container.querySelector<HTMLButtonElement>('.lightink-reader-comic-bookmark')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click(); // 未注入：无操作也不抛错
    expect(button.getAttribute('aria-pressed')).toBe('false');
    handle.scrollToPage(2);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await handle.destroy();
  });
});

describe('CbzRenderHandle.openPageJump', () => {
  it('opens the page jump dialog and reveals chrome (G-key equivalent entry)', async () => {
    const { container, handle } = await renderWithBookmark(6);
    expect(typeof handle.openPageJump).toBe('function');
    expect(jumpOverlay()).toBeNull();

    container.dataset.comicChrome = 'hidden';
    handle.openPageJump?.();
    expect(jumpOverlay()).not.toBeNull();
    expect(jumpOverlay()!.getAttribute('role')).toBe('dialog');
    expect(container.dataset.comicChrome).toBe('visible');

    // 与 pageButton 同一对话框：输入合法页码 Enter 直达。
    const input = jumpOverlay()!.querySelector<HTMLInputElement>('.lightink-reader-comic-jump-input')!;
    input.value = '4';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(handle.currentPage).toBe(4);
    expect(jumpOverlay()).toBeNull();
    await handle.destroy();
  });

  it('is a no-op while the dialog is already open and removes it on destroy', async () => {
    const { handle } = await renderWithBookmark(4);
    handle.openPageJump?.();
    const overlay = jumpOverlay();
    expect(overlay).not.toBeNull();
    handle.openPageJump?.(); // 已打开：幂等
    expect(document.body.querySelectorAll('.lightink-reader-comic-jump')).toHaveLength(1);
    await handle.destroy();
    expect(jumpOverlay()).toBeNull();
  });
});
