// @vitest-environment jsdom

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCbzInto } from '../formats/cbz.js';

let observerCallback: IntersectionObserverCallback | null = null;

class ControlledIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallback = callback;
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
  createObjectUrl.mockImplementation(() => `blob:cbz-${++nextUrl}`);
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
  observerCallback = null;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.documentElement.removeAttribute('lang');
  document.body.replaceChildren();
});

const verticalStorage = {
  getItem: () =>
    JSON.stringify({ mode: 'vertical', direction: 'ltr', spread: 'single', fitWidth: true }),
  setItem: () => undefined,
};

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

async function buildNestedCbz(): Promise<Uint8Array> {
  const inner = new ZipWriter(new Uint8ArrayWriter());
  await inner.add(
    'nested-page.png',
    new Uint8ArrayReader(new Uint8Array([7, 8, 9])),
    { level: 0 },
  );
  await inner.add(
    'nested-page-2.png',
    new Uint8ArrayReader(new Uint8Array([10, 11, 12])),
    { level: 0 },
  );
  const innerBytes = await inner.close();
  const outer = new ZipWriter(new Uint8ArrayWriter());
  await outer.add(
    'cover.png',
    new Uint8ArrayReader(new Uint8Array([1, 2, 3])),
    { level: 0 },
  );
  await outer.add('z-chapter.cbz', new Uint8ArrayReader(innerBytes), { level: 0 });
  return outer.close();
}

async function buildMetadataCbz(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    'chapter/page10.png',
    new Uint8ArrayReader(new Uint8Array([10, 11, 12])),
    { level: 0 },
  );
  await writer.add(
    'chapter/page2.png',
    new Uint8ArrayReader(new Uint8Array([2, 3, 4])),
    { level: 0 },
  );
  await writer.add(
    'ComicInfo.xml',
    new Uint8ArrayReader(
      new TextEncoder().encode(`
        <ComicInfo>
          <Series>墨色档案</Series><Number>2</Number><Volume>1</Volume>
          <Manga>YesAndRightToLeft</Manga>
          <Pages><Page Image="1" Type="FrontCover"/><Page Image="0"/></Pages>
        </ComicInfo>`),
    ),
    { level: 0 },
  );
  return writer.close();
}

describe('CBZ page materialization', () => {
  it('loads the vertical double spread that entered the viewport', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(8), container, undefined, {
      cacheBudgetBytes: 6,
      preferenceStorage: {
        getItem: () =>
          JSON.stringify({
            mode: 'vertical',
            direction: 'ltr',
            spread: 'double',
            fitWidth: true,
          }),
        setItem: () => undefined,
      },
    });
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-page-index="2"] img')).toBeNull();

    observerCallback?.(
      [
        {
          target: container.querySelector('[data-page-index="2"]')!,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
        {
          target: container.querySelector('[data-page-index="3"]')!,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );

    await vi.waitFor(() => {
      expect(container.querySelector('[data-page-index="2"] img')).not.toBeNull();
      expect(container.querySelector('[data-page-index="3"] img')).not.toBeNull();
    });
    expect(handle.currentPage).toBe(3);
    await handle.destroy();
  });

  it('paints the current spread before filling the neighbor cache', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(6), container, undefined, {
      cacheBudgetBytes: 96,
      preferenceStorage: verticalStorage,
    });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    await handle.destroy();
  });

  it('keeps only the viewport cache window and revokes every object URL', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(6), container, undefined, {
      cacheBudgetBytes: 9,
      preferenceStorage: verticalStorage,
    });

    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(3));
    expect(container.querySelectorAll('.lightink-reader-page-slot')).toHaveLength(6);
    expect(container.querySelectorAll('img')).toHaveLength(3);

    const lastSlot = container.querySelector<HTMLElement>('[data-page-index="5"]')!;
    observerCallback?.(
      [{ target: lastSlot, isIntersecting: true } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    expect(revokeObjectUrl).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(handle.currentPage).toBe(6);

    await handle.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(6);
    await handle.destroy();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(6);
  });

  it('loads around explicit navigation without materializing the whole book', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(10), container, undefined, {
      cacheBudgetBytes: 9,
      preferenceStorage: verticalStorage,
    });
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(3));

    handle.scrollToPage(10);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    expect(handle.currentPage).toBe(10);
    expect(container.querySelectorAll('img')).toHaveLength(3);

    handle.setPreferences({ mode: 'vertical' });
    expect(container.dataset.comicMode).toBe('vertical');
    expect(
      [...container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot')].every(
        (slot) => !slot.hidden,
      ),
    ).toBe(true);

    await handle.destroy();
  });

  it('opens a nested ZIP only when its virtual page is reached', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildNestedCbz(), container, undefined, {
      preferenceStorage: verticalStorage,
    });

    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    expect(container.querySelectorAll('.lightink-reader-page-slot')).toHaveLength(2);
    expect(handle.totalPages).toBe(2);

    handle.scrollToPage(2);
    await vi.waitFor(() => expect(createObjectUrl.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(container.querySelectorAll('.lightink-reader-page-slot')).toHaveLength(3);
    expect(handle.totalPages).toBe(3);
    expect(handle.metadata.pageCount).toBe(3);

    await handle.destroy();
    expect(revokeObjectUrl.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('applies ComicInfo order and exposes normalized comic metadata', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildMetadataCbz(), container, undefined, {
      preferenceStorage: null,
    });

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot')).map(
        (slot) => slot.dataset.pagePath,
      ),
    ).toEqual(['chapter/page2.png', 'chapter/page10.png']);
    expect(handle.metadata).toMatchObject({
      series: '墨色档案',
      number: '2',
      volume: '1',
      pageCount: 2,
      coverPage: 0,
      readingDirection: 'rtl',
    });
    expect(handle.preferences.direction).toBe('rtl');
    await handle.destroy();
  });

  it('supports paged double spreads, RTL, and preference persistence', async () => {
    document.documentElement.lang = 'en';
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(5), container, undefined, {
      preferenceStorage: storage,
      cacheBudgetBytes: 9,
    });

    container.querySelector<HTMLButtonElement>('[aria-label="Horizontal pages"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Double page"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Right to left"]')!.click();
    handle.scrollToPage(3);
    expect(handle.currentPage).toBe(2);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot'))
        .filter((slot) => !slot.hidden)
        .map((slot) => slot.dataset.pageIndex),
    ).toEqual(['1', '2']);
    expect(handle.nextPage()).toBe(true);
    expect(handle.currentPage).toBe(4);
    expect(handle.nextPage()).toBe(false);
    expect(container.dataset.comicDirection).toBe('rtl');
    expect(JSON.parse([...values.values()][0] ?? '{}')).toMatchObject({
      mode: 'paged',
      direction: 'rtl',
      spread: 'double',
    });
    await handle.destroy();
  });

  it('shows a retryable structured state when the browser rejects an image', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(1), container, undefined, {
      preferenceStorage: null,
    });
    const image = container.querySelector<HTMLImageElement>('img')!;
    image.dispatchEvent(new Event('error'));

    expect(
      container.querySelector<HTMLElement>('[data-error-code="COMIC_IMAGE_DECODE_FAILED"]'),
    ).not.toBeNull();
    container.querySelector<HTMLButtonElement>('.lightink-reader-comic-error button')!.click();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
    expect(container.querySelector('img')).not.toBeNull();
    await handle.destroy();
  });

  it('uses overlay chrome with a page slider and edge-tap navigation', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    const onReturnToShelf = vi.fn();
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: {
        getItem: () =>
          JSON.stringify({ mode: 'paged', direction: 'ltr', spread: 'single', fitWidth: true }),
        setItem: () => undefined,
      },
      onReturnToShelf,
    });

    expect(container.querySelector('.lightink-reader-comic-title')).not.toBeNull();
    const topbar = container.querySelector('.lightink-reader-comic-topbar');
    expect(topbar?.getAttribute('data-tauri-drag-region')).toBe('');
    const back = container.querySelector<HTMLButtonElement>('.lightink-reader-comic-back')!;
    expect(back.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(back.textContent).toBe('Back to Shelf');
    back.click();
    expect(onReturnToShelf).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.lightink-reader-comic-page')?.textContent).toBe('1 / 4');
    const slider = container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    expect(handle.currentPage).toBe(3);

    container.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 400, bubbles: true }));
    expect(handle.currentPage).toBe(2);
    container.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true }));
    expect(container.dataset.comicChrome).toBe('hidden');
    expect(container.querySelector('.lightink-reader-comic-hud')).toBeNull();
    const selectStart = new Event('selectstart', { cancelable: true });
    expect(container.dispatchEvent(selectStart)).toBe(false);
    const wheel = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    expect(container.dispatchEvent(wheel)).toBe(false);
    expect(handle.currentPage).toBe(3);
    await handle.destroy();
  });
});
