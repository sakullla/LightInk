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
const originalNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
const originalNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight');
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
  if (originalNaturalWidth !== undefined) {
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', originalNaturalWidth);
  }
  if (originalNaturalHeight !== undefined) {
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', originalNaturalHeight);
  }
});

const legacyVerticalStorage = {
  getItem: () =>
    JSON.stringify({ mode: 'vertical', direction: 'ltr', spread: 'single', fitWidth: true }),
  setItem: () => undefined,
};

function visiblePageIndices(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot'))
    .filter((slot) => !slot.hidden)
    .map((slot) => slot.dataset.pageIndex ?? '');
}

function pagedStorage(
  overrides: Record<string, unknown> = {},
): { getItem: () => string; setItem: () => undefined } {
  return {
    getItem: () =>
      JSON.stringify({
        mode: 'paged',
        direction: 'ltr',
        spread: 'single',
        fit: 'screen',
        ...overrides,
      }),
    setItem: () => undefined,
  };
}

function sizeCanvas(container: HTMLElement, width = 1000, height = 800): void {
  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
  });
}

function comicSurface(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.lightink-reader-comic-pages') ?? container;
}

function clickCanvas(container: HTMLElement, clientX: number, clientY = 400): void {
  container.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
}

function pointerOn(
  target: EventTarget,
  type: string,
  init: PointerEventInit,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function readComicScale(container: HTMLElement): number {
  for (const node of [container, comicSurface(container)]) {
    const data = Number.parseFloat(node.dataset.comicScale ?? '');
    if (Number.isFinite(data)) return data;
    const css = Number.parseFloat(node.style.getPropertyValue('--lightink-comic-scale'));
    if (Number.isFinite(css)) return css;
    const styleScale = Number.parseFloat(node.style.scale);
    if (Number.isFinite(styleScale)) return styleScale;
    const matched = node.style.transform.match(/scale\(\s*([-\d.]+)/);
    if (matched) {
      const value = Number.parseFloat(matched[1]!);
      if (Number.isFinite(value)) return value;
    }
  }
  return 1;
}

function readComicPan(container: HTMLElement): { x: number; y: number } {
  const node = comicSurface(container);
  const transform = node.style.transform || container.style.transform;
  const matched = transform.match(/translate(?:3d)?\(\s*([-\d.]+)(?:px)?\s*,\s*([-\d.]+)(?:px)?/);
  if (matched) {
    return { x: Number(matched[1]), y: Number(matched[2]) };
  }
  const x = Number.parseFloat(node.style.getPropertyValue('--lightink-comic-translate-x'));
  const y = Number.parseFloat(node.style.getPropertyValue('--lightink-comic-translate-y'));
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  return { x: node.scrollLeft, y: node.scrollTop };
}

function zoomByDoubleClick(container: HTMLElement): void {
  const surface = comicSurface(container);
  surface.dispatchEvent(new MouseEvent('dblclick', { clientX: 500, clientY: 400, bubbles: true }));
}

function pinchByPointers(container: HTMLElement, expand: boolean): void {
  const surface = comicSurface(container);
  const left = 400;
  const start = expand ? 560 : 700;
  const end = expand ? 720 : 500;
  pointerOn(surface, 'pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: left,
    clientY: 400,
  });
  pointerOn(surface, 'pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: start,
    clientY: 400,
  });
  pointerOn(surface, 'pointermove', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: end,
    clientY: 400,
  });
  pointerOn(surface, 'pointerup', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: end,
    clientY: 400,
  });
  pointerOn(surface, 'pointerup', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: left,
    clientY: 400,
  });
}

function dragCanvas(container: HTMLElement, pointerType: 'mouse' | 'touch'): void {
  const surface = comicSurface(container);
  pointerOn(surface, 'pointerdown', {
    pointerId: 1,
    pointerType,
    buttons: 1,
    clientX: 500,
    clientY: 400,
  });
  pointerOn(surface, 'pointermove', {
    pointerId: 1,
    pointerType,
    buttons: 1,
    clientX: 620,
    clientY: 470,
  });
  pointerOn(surface, 'pointerup', {
    pointerId: 1,
    pointerType,
    clientX: 620,
    clientY: 470,
  });
}

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
  it('loads the strip page that entered the viewport without pairing a double spread', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(8), container, undefined, {
      cacheBudgetBytes: 3,
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
    expect(handle.preferences).toMatchObject({ mode: 'strip', spread: 'double', fit: 'width' });
    expect(container.dataset.comicMode).toBe('strip');
    expect(container.dataset.comicReader).toBe('true');
    expect(visiblePageIndices(container)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-page-index="2"] img')).toBeNull();
    expect(container.querySelector('[data-page-index="3"] img')).toBeNull();

    observerCallback?.(
      [
        {
          target: container.querySelector('[data-page-index="2"]')!,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );

    await vi.waitFor(() => {
      expect(container.querySelector('[data-page-index="2"] img')).not.toBeNull();
    });
    expect(container.querySelector('[data-page-index="3"] img')).toBeNull();
    expect(handle.currentPage).toBe(3);
    await handle.destroy();
  });

  it('paints the current strip page before filling the neighbor cache', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(6), container, undefined, {
      cacheBudgetBytes: 96,
      preferenceStorage: legacyVerticalStorage,
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
      preferenceStorage: legacyVerticalStorage,
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
      preferenceStorage: legacyVerticalStorage,
    });
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(3));

    handle.scrollToPage(10);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(6));
    expect(handle.currentPage).toBe(10);
    expect(container.querySelectorAll('img')).toHaveLength(3);

    handle.setPreferences({ mode: 'strip' });
    expect(container.dataset.comicMode).toBe('strip');
    expect(handle.preferences.mode).toBe('strip');
    expect(visiblePageIndices(container)).toHaveLength(10);

    await handle.destroy();
  });

  it('opens a nested ZIP only when its virtual page is reached', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildNestedCbz(), container, undefined, {
      preferenceStorage: legacyVerticalStorage,
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

  it('keeps the paged cover alone, then pairs the remaining pages', async () => {
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
    expect(handle.currentPage).toBe(1);
    expect(visiblePageIndices(container)).toEqual(['0']);
    expect(handle.nextPage()).toBe(true);
    expect(handle.currentPage).toBe(2);
    expect(visiblePageIndices(container)).toEqual(['1', '2']);
    container.querySelector<HTMLButtonElement>('[aria-label="Right to left"]')!.click();
    handle.scrollToPage(3);
    expect(handle.currentPage).toBe(2);
    expect(visiblePageIndices(container)).toEqual(['1', '2']);
    expect(handle.nextPage()).toBe(true);
    expect(handle.currentPage).toBe(4);
    expect(visiblePageIndices(container)).toEqual(['3', '4']);
    expect(handle.nextPage()).toBe(false);
    expect(container.dataset.comicDirection).toBe('rtl');
    expect(JSON.parse([...values.values()][0] ?? '{}')).toMatchObject({
      mode: 'paged',
      direction: 'rtl',
      spread: 'double',
      fit: 'screen',
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

  it('uses a hideable overlay on the comic canvas instead of a persistent chip wall', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    const onReturnToShelf = vi.fn();
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ fit: 'width' }),
      onReturnToShelf,
    });

    expect(container.dataset.comicReader).toBe('true');
    const chrome = container.querySelector('.lightink-reader-comic-chrome');
    expect(chrome).not.toBeNull();
    expect(container.querySelector('.lightink-reader-comic-hud')).toBeNull();
    expect(container.querySelector('.lightink-reader-comic-modes')?.closest('.lightink-reader-comic-chrome')).not.toBeNull();
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
    expect(chrome?.getAttribute('aria-hidden')).toBe('true');
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

  it('turns paged edges with the reading direction and only toggles chrome in the center', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'rtl', spread: 'single' }),
    });

    expect(handle.currentPage).toBe(1);
    container.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 400, bubbles: true }));
    expect(handle.currentPage).toBe(2);
    container.dispatchEvent(new MouseEvent('click', { clientX: 950, clientY: 400, bubbles: true }));
    expect(handle.currentPage).toBe(1);
    container.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true }));
    expect(container.dataset.comicChrome).toBe('hidden');
    expect(handle.currentPage).toBe(1);
    await handle.destroy();
  });

  it('stacks strip pages at content height and lets the wheel scroll', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get: () => 200,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
      configurable: true,
      get: () => 500,
    });
    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800 }),
    });
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      cacheBudgetBytes: 96,
      preferenceStorage: legacyVerticalStorage,
    });

    expect(container.dataset.comicMode).toBe('strip');
    expect(handle.preferences.fit).toBe('width');
    const slots = Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot'));
    expect(slots).toHaveLength(3);
    expect(slots.every((slot) => !slot.hidden)).toBe(true);
    expect(slots.every((slot) => slot.style.height !== '100%' && !slot.style.flex.includes('100%'))).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(slots[0]?.style.aspectRatio).toBe('200 / 500');
    });
    const before = handle.currentPage;
    const wheel = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    expect(container.dispatchEvent(wheel)).toBe(true);
    expect(handle.currentPage).toBe(before);
    await handle.destroy();
  });

  it('cycles paged screen, width, height, and original, and keeps strip on width', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage({ fit: 'screen' }),
    });

    expect(handle.preferences.fit).toBe('screen');
    expect(container.dataset.comicFit).toBe('screen');
    const fit = container.querySelector<HTMLButtonElement>('[aria-label="Fit screen"]')!;
    const cycle = [
      ['width', 'Fit width'],
      ['height', 'Fit height'],
      ['original', 'Original size'],
      ['screen', 'Fit screen'],
    ] as const;
    for (const [value, label] of cycle) {
      fit.click();
      expect(handle.preferences.fit).toBe(value);
      expect(container.dataset.comicFit).toBe(value);
      expect(fit.getAttribute('aria-label')).toBe(label);
    }

    handle.setPreferences({ fit: 'original' });
    container.querySelector<HTMLButtonElement>('button[aria-label="Continuous strip"]')!.click();
    expect(handle.preferences.mode).toBe('strip');
    expect(handle.preferences.fit).toBe('width');
    expect(container.dataset.comicFit).toBe('width');
    await handle.destroy();
  });

  it('double-click zooms so edge taps do not turn the page until fit is restored', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    expect(handle.currentPage).toBe(1);
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    zoomByDoubleClick(container);
    expect(readComicScale(container)).toBeGreaterThan(1);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(1);
    dragCanvas(container, 'mouse');
    expect(handle.currentPage).toBe(1);
    const pan = readComicPan(container);
    expect(Math.abs(pan.x) + Math.abs(pan.y)).toBeGreaterThan(0);

    zoomByDoubleClick(container);
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    await handle.destroy();
  });

  it('pinch-zooms on touch pointers and pans without turning the page', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    pinchByPointers(container, true);
    expect(readComicScale(container)).toBeGreaterThan(1);
    const page = handle.currentPage;
    dragCanvas(container, 'touch');
    expect(handle.currentPage).toBe(page);
    const pan = readComicPan(container);
    expect(Math.abs(pan.x) + Math.abs(pan.y)).toBeGreaterThan(0);
    clickCanvas(container, 50);
    expect(handle.currentPage).toBe(page);

    pinchByPointers(container, false);
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(page + 1);
    await handle.destroy();
  });

  it('zooms with a modifier wheel in paged mode without advancing', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    const wheel = new WheelEvent('wheel', {
      deltaY: -120,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(wheel);
    expect(handle.currentPage).toBe(1);
    expect(readComicScale(container)).toBeGreaterThan(1);
    await handle.destroy();
  });

  it('resets zoom when the reading mode changes', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    zoomByDoubleClick(container);
    expect(readComicScale(container)).toBeGreaterThan(1);
    container.querySelector<HTMLButtonElement>('button[aria-label="Continuous strip"]')!.click();
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    container.querySelector<HTMLButtonElement>('button[aria-label="Horizontal pages"]')!.click();
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    await handle.destroy();
  });

  it('leaves paged double-spread slot width to CSS pairing for screen and width fit', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(5), container, undefined, {
      preferenceStorage: pagedStorage({ spread: 'double', fit: 'screen' }),
    });

    expect(handle.nextPage()).toBe(true);
    expect(container.dataset.comicVisible).toBe('2');
    expect(visiblePageIndices(container)).toEqual(['1', '2']);
    const paired = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot')).filter(
        (slot) => !slot.hidden,
      );
    for (const slot of paired()) {
      expect(slot.style.width).toBe('');
      expect(slot.style.maxWidth).toBe('');
    }

    container.querySelector<HTMLButtonElement>('[aria-label="Fit screen"]')!.click();
    expect(handle.preferences.fit).toBe('width');
    expect(container.dataset.comicFit).toBe('width');
    expect(container.dataset.comicVisible).toBe('2');
    for (const slot of paired()) {
      expect(slot.style.width).toBe('');
      expect(slot.style.maxWidth).toBe('');
    }
    await handle.destroy();
  });

  it('completes paging, fit, jump, and zoom with only mouse input', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ fit: 'screen' }),
    });

    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    container.querySelector<HTMLButtonElement>('button[aria-label="Fit screen"]')!.click();
    expect(handle.preferences.fit).toBe('width');
    container.querySelector<HTMLButtonElement>('button[aria-label="Double page"]')!.click();
    expect(handle.preferences.spread).toBe('double');
    const slider = container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
    slider.value = '4';
    slider.dispatchEvent(new Event('input'));
    expect(handle.currentPage).toBe(4);
    zoomByDoubleClick(container);
    expect(readComicScale(container)).toBeGreaterThan(1);
    dragCanvas(container, 'mouse');
    expect(handle.currentPage).toBe(4);
    await handle.destroy();
  });

  it('completes paging, mode, jump, and zoom with only touch and no hover', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    clickCanvas(container, 500);
    expect(container.dataset.comicChrome).toBe('hidden');
    pointerOn(container, 'pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 500,
      clientY: 20,
    });
    expect(container.dataset.comicChrome).toBe('hidden');
    clickCanvas(container, 500);
    expect(container.dataset.comicChrome).toBe('visible');

    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    container.querySelector<HTMLButtonElement>('button[aria-label="Continuous strip"]')!.click();
    expect(handle.preferences.mode).toBe('strip');
    container.querySelector<HTMLButtonElement>('button[aria-label="Horizontal pages"]')!.click();
    expect(handle.preferences.mode).toBe('paged');
    const slider = container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    expect(handle.currentPage).toBe(3);

    pinchByPointers(container, true);
    expect(readComicScale(container)).toBeGreaterThan(1);
    const page = handle.currentPage;
    dragCanvas(container, 'touch');
    expect(handle.currentPage).toBe(page);
    await handle.destroy();
  });
});
