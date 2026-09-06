// @vitest-environment jsdom

import { invoke } from '@tauri-apps/api/core';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCbzInto, type CbzRenderHandle } from '../formats/cbz.js';
import { comicJumpTargetPage } from '../comic/comic-navigation.js';
import { comicSpreadList } from '../comic-preferences.js';

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
  createObjectUrl.mockImplementation(() => `blob:comic-nav-${++nextUrl}`);
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

async function renderComic(
  pageCount: number,
  preferences: Record<string, unknown>,
): Promise<{ container: HTMLElement; handle: CbzRenderHandle }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handle = await renderCbzInto(await buildCbz(pageCount), container, undefined, {
    preferenceStorage: storageFor(preferences),
    cacheBudgetBytes: pageCount + 1,
  });
  return { container, handle };
}

function sliderOf(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
}

function bubbleOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.lightink-reader-comic-scrub-bubble')!;
}

function jumpOverlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.lightink-reader-comic-jump');
}

function jumpInput(): HTMLInputElement {
  return jumpOverlay()!.querySelector<HTMLInputElement>('.lightink-reader-comic-jump-input')!;
}

function jumpError(): HTMLElement {
  return jumpOverlay()!.querySelector<HTMLElement>('.lightink-reader-comic-jump-error')!;
}

function pressEnter(target: HTMLElement, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
  );
}

function pressEscape(target: HTMLElement, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
  );
}

describe('comic scrub bubble', () => {
  it('shows the dragged target page while scrubbing and hides on release (strip)', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'strip',
      direction: 'ltr',
      spread: 'single',
      fit: 'width',
    });
    const slider = sliderOf(container);
    expect(slider.max).toBe('6');

    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const bubble = bubbleOf(container);
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent).toBe('1');

    slider.value = '4';
    slider.dispatchEvent(new Event('input'));
    expect(bubble.textContent).toBe('4');
    expect(handle.currentPage).toBe(4);

    slider.value = '6';
    slider.dispatchEvent(new Event('input'));
    expect(bubble.textContent).toBe('6');
    expect(handle.currentPage).toBe(6);

    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(bubble.hidden).toBe(true);
    expect(handle.currentPage).toBe(6);
    await handle.destroy();
  });

  it('shows the first page of the target spread in double-page mode', async () => {
    const { container, handle } = await renderComic(5, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'double',
      fit: 'screen',
    });
    const spreads = comicSpreadList(5, { mode: 'paged', spread: 'double' }, new Set());
    const slider = sliderOf(container);
    expect(slider.max).toBe(String(spreads.length));

    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const bubble = bubbleOf(container);
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    const targetFirst = spreads[1]![0]! + 1;
    expect(bubble.textContent).toBe(String(targetFirst));
    expect(handle.currentPage).toBe(targetFirst);

    slider.value = String(spreads.length);
    slider.dispatchEvent(new Event('input'));
    const lastFirst = spreads[spreads.length - 1]![0]! + 1;
    expect(bubble.textContent).toBe(String(lastFirst));
    expect(handle.currentPage).toBe(lastFirst);

    slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(bubble.hidden).toBe(true);
    await handle.destroy();
  });

  it('keeps the bubble hidden for keyboard/programmatic slider input without a drag', async () => {
    const { container, handle } = await renderComic(4, {
      mode: 'strip',
      direction: 'ltr',
      spread: 'single',
      fit: 'width',
    });
    const slider = sliderOf(container);
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    expect(handle.currentPage).toBe(3);
    expect(bubbleOf(container).hidden).toBe(true);
    await handle.destroy();
  });

  it('suspends chrome auto-hide while dragging and reschedules on release', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'strip',
      direction: 'ltr',
      spread: 'single',
      fit: 'width',
    });
    const slider = sliderOf(container);
    vi.useFakeTimers();
    try {
      slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      vi.advanceTimersByTime(6000);
      expect(container.dataset.comicChrome).toBe('visible');

      slider.value = '2';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      vi.advanceTimersByTime(6000);
      expect(container.dataset.comicChrome).toBe('hidden');
    } finally {
      vi.useRealTimers();
    }
    await handle.destroy();
  });
});

describe('comic page jump dialog', () => {
  it('opens from the page button, jumps on Enter, and closes', async () => {
    const { container, handle } = await renderComic(8, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    expect(jumpOverlay()).toBeNull();
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();

    const overlay = jumpOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('role')).toBe('dialog');
    expect(overlay!.getAttribute('aria-label')).toBe('Go to page');
    const input = jumpInput();
    expect(input.value).toBe('1');

    input.value = '5';
    pressEnter(input);
    expect(handle.currentPage).toBe(5);
    expect(jumpOverlay()).toBeNull();
    await handle.destroy();
  });

  it('jumps via the confirm button', async () => {
    const { container, handle } = await renderComic(8, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    jumpInput().value = '3';
    jumpOverlay()!.querySelector<HTMLButtonElement>('.lightink-reader-comic-jump-confirm')!.click();
    expect(handle.currentPage).toBe(3);
    expect(jumpOverlay()).toBeNull();
    await handle.destroy();
  });

  it('rejects out-of-range and non-numeric input with feedback and no jump', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    handle.scrollToPage(2);
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    const input = jumpInput();
    expect(input.value).toBe('2');

    input.value = '99';
    pressEnter(input);
    expect(handle.currentPage).toBe(2);
    expect(jumpOverlay()).not.toBeNull();
    expect(jumpError().textContent).toBe('Enter a page number between 1 and 6');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    input.value = 'abc';
    input.dispatchEvent(new Event('input'));
    expect(jumpError().textContent).toBe('');
    pressEnter(input);
    expect(handle.currentPage).toBe(2);
    expect(jumpError().textContent).toBe('Enter a page number between 1 and 6');
    await handle.destroy();
  });

  it('Escape clears the input first, then closes the dialog', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    const input = jumpInput();
    expect(input.value).toBe('1');

    pressEscape(input);
    expect(input.value).toBe('');
    expect(jumpOverlay()).not.toBeNull();

    pressEscape(input);
    expect(jumpOverlay()).toBeNull();
    await handle.destroy();
  });

  it('does not swallow IME composition keys', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    const input = jumpInput();
    input.value = '4';

    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEnter, 'isComposing', { value: true });
    input.dispatchEvent(composingEnter);
    expect(handle.currentPage).toBe(1);
    expect(jumpOverlay()).not.toBeNull();
    expect(input.value).toBe('4');

    const composingEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composingEscape);
    expect(jumpOverlay()).not.toBeNull();
    expect(input.value).toBe('4');
    await handle.destroy();
  });

  it('closes on backdrop pointerdown and removes the overlay on destroy', async () => {
    const { container, handle } = await renderComic(6, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    const overlay = jumpOverlay()!;
    overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(jumpOverlay()).toBeNull();

    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    expect(jumpOverlay()).not.toBeNull();
    await handle.destroy();
    expect(jumpOverlay()).toBeNull();
  });

  it('uses localized labels for the dialog', async () => {
    document.documentElement.lang = 'zh-CN';
    const { container, handle } = await renderComic(6, {
      mode: 'paged',
      direction: 'ltr',
      spread: 'single',
      fit: 'screen',
    });
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-page')!.click();
    expect(jumpOverlay()!.getAttribute('aria-label')).toBe('跳转到页');
    jumpInput().value = '0';
    pressEnter(jumpInput());
    expect(jumpError().textContent).toBe('请输入 1 到 6 之间的页码');
    await handle.destroy();
  });
});

describe('comicJumpTargetPage', () => {
  it('accepts in-range integers and rejects everything else', () => {
    expect(comicJumpTargetPage('1', 10)).toBe(1);
    expect(comicJumpTargetPage(' 10 ', 10)).toBe(10);
    expect(comicJumpTargetPage('0', 10)).toBeNull();
    expect(comicJumpTargetPage('11', 10)).toBeNull();
    expect(comicJumpTargetPage('3.5', 10)).toBeNull();
    expect(comicJumpTargetPage('1e2', 10)).toBeNull();
    expect(comicJumpTargetPage('', 10)).toBeNull();
    expect(comicJumpTargetPage('abc', 10)).toBeNull();
    expect(comicJumpTargetPage('-2', 10)).toBeNull();
  });
});
