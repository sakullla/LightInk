// @vitest-environment jsdom

import { invoke } from '@tauri-apps/api/core';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderCbzInto,
  SET_SYSTEM_BARS_VISIBLE_COMMAND,
  syncComicSystemBarsVisible,
  type ComicSystemBarsHost,
} from '../formats/cbz.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const invokeMock = vi.mocked(invoke);

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
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
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
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  observerCallback = null;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('data-android');
  document.documentElement.removeAttribute('data-touch-primary');
  document.body.replaceChildren();
  if (originalDecode !== undefined) {
    Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode);
  } else {
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
  }
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

function swipeCanvas(
  container: HTMLElement,
  fromX: number,
  toX: number,
  pointerType: 'mouse' | 'touch' = 'touch',
): void {
  pointerOn(container, 'pointerdown', {
    pointerId: 1,
    pointerType,
    buttons: 1,
    clientX: fromX,
    clientY: 400,
  });
  pointerOn(container, 'pointermove', {
    pointerId: 1,
    pointerType,
    buttons: 1,
    clientX: toX,
    clientY: 400,
  });
  pointerOn(container, 'pointerup', {
    pointerId: 1,
    pointerType,
    clientX: toX,
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
    clientX: 380,
    clientY: 330,
  });
  pointerOn(surface, 'pointerup', {
    pointerId: 1,
    pointerType,
    clientX: 380,
    clientY: 330,
  });
}

/** 手动帧队列（pdf-drag-pan.test.ts fakeFrames 模式）：flush() 前不产生任何写。 */
function fakeFrames(): { flush(): void; restore(): void } {
  const queue: FrameRequestCallback[] = [];
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback): number => {
      queue.push(callback);
      return queue.length;
    },
  );
  const cancel = vi
    .spyOn(window, 'cancelAnimationFrame')
    .mockImplementation(() => undefined);
  return {
    flush(): void {
      queue.splice(0).forEach((callback) => {
        callback(0);
      });
    },
    restore(): void {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

/** 可拨动的 performance.now：速度采样与缓动时长在测试里确定性推进。 */
function controllableClock(): { set(ms: number): void; restore(): void } {
  let current = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => current);
  return {
    set(ms: number): void {
      current = ms;
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}

/** 拖动跟手写入的 pagesRoot 水平位移；无写入时为 null。 */
function readComicDragTranslateX(container: HTMLElement): number | null {
  const transform = comicSurface(container).style.transform;
  const matched = transform.match(/translate3d\(\s*([-\d.]+)px/);
  return matched === null ? null : Number.parseFloat(matched[1]!);
}

/** 单指触屏拖动到 toX（不抬指），便于断言拖动态中间过程。 */
function touchDragTo(
  container: HTMLElement,
  fromX: number,
  toX: number,
  pointerId = 1,
): void {
  pointerOn(container, 'pointerdown', {
    pointerId,
    pointerType: 'touch',
    buttons: 1,
    clientX: fromX,
    clientY: 400,
  });
  pointerOn(container, 'pointermove', {
    pointerId,
    pointerType: 'touch',
    buttons: 1,
    clientX: toX,
    clientY: 400,
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

  it('does not measure every strip slot to decide the current page', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderCbzInto(await buildCbz(8), container, undefined, {
      cacheBudgetBytes: 3,
      preferenceStorage: legacyVerticalStorage,
    });
    const slots = Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot'));
    let measures = 0;
    for (const slot of slots) {
      Object.defineProperty(slot, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          measures += 1;
          const index = Number(slot.dataset.pageIndex);
          return {
            top: index * 100,
            bottom: index * 100 + 90,
            left: 0,
            right: 400,
            width: 400,
            height: 90,
          };
        },
      });
    }
    observerCallback?.(
      [
        {
          target: slots[1]!,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
        {
          target: slots[2]!,
          isIntersecting: true,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    expect(measures).toBeGreaterThan(0);
    expect(measures).toBeLessThan(slots.length);
    await handle.destroy();
  });

  it('turns a paged comic without rematerializing a prefetched neighbor', async () => {
    const container = document.createElement('div');
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ spread: 'single' }),
      cacheBudgetBytes: 96,
    });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(createObjectUrl.mock.calls.length).toBeGreaterThanOrEqual(2));
    const afterPrefetch = createObjectUrl.mock.calls.length;
    expect(handle.nextPage()).toBe(true);
    expect(handle.currentPage).toBe(2);
    expect(visiblePageIndices(container)).toEqual(['1']);
    expect(createObjectUrl.mock.calls.length).toBe(afterPrefetch);
    expect(container.querySelectorAll('.lightink-reader-cbz-slot')).toHaveLength(4);
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
    // decode-gated swap：新页未就绪时旧页保持在屏，换屏等 loadPage 完成。
    await vi.waitFor(() => expect(visiblePageIndices(container)).toEqual(['1', '2']));
    const slider = container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
    expect(slider.max).toBe('3');
    expect(slider.value).toBe('2');
    slider.value = '3';
    slider.dispatchEvent(new Event('input'));
    expect(handle.currentPage).toBe(4);
    handle.scrollToProgress(0);
    expect(handle.currentPage).toBe(1);
    handle.scrollToProgress(1);
    expect(handle.currentPage).toBe(4);
    handle.scrollToPage(2);
    container.querySelector<HTMLButtonElement>('[aria-label="Right to left"]')!.click();
    handle.scrollToPage(3);
    expect(handle.currentPage).toBe(2);
    expect(visiblePageIndices(container)).toEqual(['1', '2']);
    expect(handle.nextPage()).toBe(true);
    expect(handle.currentPage).toBe(4);
    await vi.waitFor(() => expect(visiblePageIndices(container)).toEqual(['3', '4']));
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

  it('reloads auto double-spread pages after a slider jump aborts in-flight loads', async () => {
    const queued: Array<() => void> = [];
    let hangDecode = false;
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value() {
        if (!hangDecode) return Promise.resolve();
        return new Promise<void>((resolve) => queued.push(resolve));
      },
    });
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container, 1200, 700);
    const handle = await renderCbzInto(await buildCbz(8), container, undefined, {
      preferenceStorage: pagedStorage({ spread: 'auto', fit: 'screen' }),
    });
    expect(container.dataset.comicSpread).toBe('double');
    await new Promise((resolve) => setTimeout(resolve, 0));

    hangDecode = true;
    const slider = container.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input'));
    handle.scrollToPage(1);
    slider.value = slider.max;
    slider.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    hangDecode = false;
    queued.splice(0).forEach((resolve) => resolve());

    const filledVisibleSlots = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot')).filter(
        (slot) => !slot.hidden,
      );
    await vi.waitFor(() => {
      const shown = filledVisibleSlots();
      expect(shown.length).toBeGreaterThan(0);
      for (const slot of shown) {
        expect(slot.querySelector('img')).not.toBeNull();
      }
    });

    expect(handle.previousPage()).toBe(true);
    await vi.waitFor(() => {
      const shown = filledVisibleSlots();
      expect(shown.length).toBeGreaterThan(0);
      for (const slot of shown) {
        expect(slot.querySelector('img')).not.toBeNull();
      }
    });
    await handle.destroy();
  });

  it('holds the previous page on screen until the next page decodes (anti-flash swap)', async () => {
    // 首页 decode 直通让 renderCbzInto 完成；后续页悬挂，模拟慢解码。
    let decodeCalls = 0;
    const queued: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value() {
        decodeCalls += 1;
        if (decodeCalls === 1) return Promise.resolve();
        return new Promise<void>((resolve) => queued.push(resolve));
      },
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage({ spread: 'single' }),
    });
    expect(visiblePageIndices(container)).toEqual(['0']);

    expect(handle.nextPage()).toBe(true);
    // 页码/进度立即前进，但换屏被 decode 门控：旧页保持在屏，不闪底色。
    expect(handle.currentPage).toBe(2);
    expect(visiblePageIndices(container)).toEqual(['0']);
    const oldSlot = container.querySelector<HTMLElement>('[data-page-index="0"]')!;
    expect(oldSlot.querySelector('img')).not.toBeNull();

    // 解码完成后一次性交换到新页。
    await vi.waitFor(() => expect(queued.length).toBeGreaterThan(0));
    expect(visiblePageIndices(container)).toEqual(['0']);
    queued.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(visiblePageIndices(container)).toEqual(['1']));
    await handle.destroy();
  });

  it('drives page turns through a View Transition push when supported', async () => {
    const updates: Array<() => void> = [];
    const finishedResolvers: Array<() => void> = [];
    const doc = document as Document & { startViewTransition?: unknown };
    doc.startViewTransition = ((update: () => void) => {
      updates.push(update);
      update();
      return {
        finished: new Promise<void>((resolve) => finishedResolvers.push(resolve)),
        skipTransition: () => undefined,
      };
    }) as unknown as Document['startViewTransition'];
    try {
      const container = document.createElement('div');
      sizeCanvas(container);
      const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
        preferenceStorage: pagedStorage({ spread: 'single' }),
      });
      // 等页 1 预取解码就绪：换屏走同步 commit，直接进 VT。
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      expect(handle.nextPage()).toBe(true);
      expect(updates).toHaveLength(1);
      expect(document.documentElement.dataset.comicTurn).toBe('next');
      expect(visiblePageIndices(container)).toEqual(['1']); // 换屏在 update 回调内提交
      finishedResolvers.splice(0).forEach((resolve) => resolve());
      await vi.waitFor(() => expect(document.documentElement.dataset.comicTurn).toBeUndefined());

      expect(handle.previousPage()).toBe(true);
      expect(updates).toHaveLength(2);
      expect(document.documentElement.dataset.comicTurn).toBe('prev');
      expect(visiblePageIndices(container)).toEqual(['0']);
      await handle.destroy();
      expect(document.documentElement.dataset.comicTurn).toBeUndefined();
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
      delete document.documentElement.dataset.comicTurn;
    }
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
    expect(topbar?.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(handle.hideChrome()).toBe(false);
    container.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 400, bubbles: true }));
    expect(container.dataset.comicChrome).toBe('visible');
    expect(handle.hideChrome()).toBe(true);
    expect(container.dataset.comicChrome).toBe('hidden');
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

  it('scrolls a tall paged width-fit page before turning', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage({ fit: 'width' }),
    });
    const slot = container.querySelector<HTMLElement>('.lightink-reader-cbz-slot:not([hidden])');
    expect(slot?.style.height).toBe('auto');
    expect(slot?.style.maxHeight).toBe('none');
    expect(slot?.style.minHeight).toBe('auto');
    const image = slot?.querySelector<HTMLElement>('.lightink-reader-page');
    expect(image?.style.height).toBe('auto');
    expect(image?.style.maxHeight).toBe('none');

    const surface = comicSurface(container);
    Object.defineProperty(surface, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(surface, 'scrollHeight', { configurable: true, value: 2400 });
    Object.defineProperty(surface, 'scrollTop', { configurable: true, writable: true, value: 0 });
    const before = handle.currentPage;
    const wheel = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    expect(container.dispatchEvent(wheel)).toBe(true);
    expect(handle.currentPage).toBe(before);

    Object.defineProperty(surface, 'scrollTop', { configurable: true, writable: true, value: 1600 });
    const edge = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    expect(container.dispatchEvent(edge)).toBe(false);
    expect(handle.currentPage).toBe(before + 1);
    // decode-gated swap：滚动复位在换屏提交时执行，等新页就绪后断言。
    await vi.waitFor(() => expect(surface.scrollTop).toBe(0));
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

  it('gives the outer 24px on touch to chrome instead of a page turn', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });

    pointerOn(container, 'pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      buttons: 1,
      clientX: 10,
      clientY: 400,
    });
    pointerOn(container, 'pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 400,
    });
    clickCanvas(container, 10);
    expect(handle.currentPage).toBe(1);
    expect(container.dataset.comicChrome).toBe('hidden');

    pointerOn(container, 'pointerdown', {
      pointerId: 2,
      pointerType: 'mouse',
      buttons: 1,
      clientX: 10,
      clientY: 400,
    });
    pointerOn(container, 'pointerup', {
      pointerId: 2,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 400,
    });
    clickCanvas(container, 10);
    expect(handle.currentPage).toBe(1);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    await handle.destroy();
  });

  it('turns paged scale-1 swipes with the reading direction and ignores the release click', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });

    // T1 drag-to-turn：翻页在松手缓动（rAF ~200ms）后提交，用 waitFor 等落位。
    swipeCanvas(container, 800, 200, 'touch');
    await vi.waitFor(() => expect(handle.currentPage).toBe(2));
    clickCanvas(container, 200);
    expect(handle.currentPage).toBe(2);
    swipeCanvas(container, 200, 800, 'mouse');
    expect(handle.currentPage).toBe(2);
    swipeCanvas(container, 200, 800, 'touch');
    await vi.waitFor(() => expect(handle.currentPage).toBe(1));
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    pinchByPointers(container, true);
    expect(readComicScale(container)).toBeGreaterThan(1);
    expect(handle.currentPage).toBe(2);
    pinchByPointers(container, false);
    expect(readComicScale(container)).toBeCloseTo(1, 3);
    clickCanvas(container, 50);
    expect(handle.currentPage).toBe(1);
    await handle.destroy();

    const rtl = document.createElement('div');
    sizeCanvas(rtl);
    const rtlHandle = await renderCbzInto(await buildCbz(4), rtl, undefined, {
      preferenceStorage: pagedStorage({ direction: 'rtl', spread: 'single' }),
    });
    swipeCanvas(rtl, 200, 800, 'touch');
    await vi.waitFor(() => expect(rtlHandle.currentPage).toBe(2));
    clickCanvas(rtl, 800);
    expect(rtlHandle.currentPage).toBe(2);
    swipeCanvas(rtl, 800, 200, 'touch');
    await vi.waitFor(() => expect(rtlHandle.currentPage).toBe(1));
    await rtlHandle.destroy();
  });

  it('turns the page from a hidden-chrome edge tap and exposes RTL / auto spread chips', async () => {
    document.documentElement.lang = 'en';
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'auto' }),
    });

    expect(container.dataset.comicSpreadPref).toBe('auto');
    expect(container.querySelector('[aria-label="Auto"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Right to left"]')).not.toBeNull();
    handle.hideChrome();
    expect(container.dataset.comicChrome).toBe('hidden');
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    container.querySelector<HTMLButtonElement>('[aria-label="Right to left"]')!.click();
    expect(handle.preferences.direction).toBe('rtl');
    container.querySelector<HTMLButtonElement>('[aria-label="Single page"]')!.click();
    expect(handle.preferences.spread).toBe('single');
    await handle.destroy();
  });

  it('does not treat a scale-1 strip swipe as a page turn', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ mode: 'strip' }),
    });
    expect(handle.preferences.mode).toBe('strip');
    swipeCanvas(container, 800, 200, 'touch');
    expect(handle.currentPage).toBe(1);
    swipeCanvas(container, 200, 800, 'touch');
    expect(handle.currentPage).toBe(1);
    pinchByPointers(container, true);
    expect(readComicScale(container)).toBeGreaterThan(1);
    expect(handle.currentPage).toBe(1);
    zoomByDoubleClick(container);
    expect(readComicScale(container)).toBeCloseTo(1, 3);
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

  it('sizes original pages to natural pixels inside a fixed canvas', async () => {
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get: () => 2400,
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
      configurable: true,
      get: () => 3600,
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(2), container, undefined, {
      preferenceStorage: pagedStorage({ fit: 'original' }),
    });

    expect(container.style.height).toBe('100%');
    expect(container.style.overflow).toBe('hidden');
    expect(container.style.padding).toBe('');
    const pages = comicSurface(container);
    expect(pages.style.overflow).toBe('auto');
    const slot = container.querySelector<HTMLElement>('.lightink-reader-cbz-slot');
    expect(slot).not.toBeNull();
    expect(slot!.style.getPropertyValue('--lightink-comic-natural-width')).toBe('2400px');
    expect(slot!.style.getPropertyValue('--lightink-comic-natural-height')).toBe('3600px');
    const image = slot!.querySelector<HTMLElement>('.lightink-reader-page');
    expect(image?.style.objectFit).toBe('none');
    expect(image?.style.width).toBe('var(--lightink-comic-natural-width, auto)');
    expect(image?.style.height).toBe('var(--lightink-comic-natural-height, auto)');
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
    expect(fit.hasAttribute('aria-pressed')).toBe(false);
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

    expect(handle.preferences.cropMargins).toBe(false);
    expect(container.dataset.comicCropMargins).toBe('false');
    expect(container.querySelector('[data-comic-cropped="true"]')).toBeNull();
    const crop = container.querySelector<HTMLButtonElement>('[aria-label="Crop margins"]')!;
    crop.click();
    expect(handle.preferences.cropMargins).toBe(true);
    expect(container.dataset.comicCropMargins).toBe('true');
    expect(crop.getAttribute('aria-pressed')).toBe('true');
    crop.click();
    expect(handle.preferences.cropMargins).toBe(false);
    expect(container.dataset.comicCropMargins).toBe('false');

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
    expect(pan.x).toBeLessThan(0);
    expect(pan.y).toBeLessThan(0);
    const surface = comicSurface(container);
    pointerOn(surface, 'pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 1,
      clientX: 500,
      clientY: 400,
    });
    pointerOn(surface, 'pointermove', {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 1,
      clientX: 4000,
      clientY: 3000,
    });
    pointerOn(surface, 'pointerup', {
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 4000,
      clientY: 3000,
    });
    const over = readComicPan(container);
    expect(over.x).toBe(0);
    expect(over.y).toBe(0);
    handle.adjustZoom('in');
    expect(readComicScale(container)).toBeGreaterThan(1);
    handle.adjustZoom('reset');
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
    await vi.waitFor(() => {
      expect(container.dataset.comicVisible).toBe('2');
      expect(visiblePageIndices(container)).toEqual(['1', '2']);
    });
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
    expect(slider.max).toBe('3');
    slider.value = '3';
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

function androidTauriHost(
  extras: ComicSystemBarsHost = {},
): Window & ComicSystemBarsHost {
  return { __TAURI_INTERNALS__: {}, ...extras } as unknown as Window & ComicSystemBarsHost;
}

describe('CBZ drag-to-turn gesture (T1)', () => {
  it('tracks the drag with a rAF-coalesced transform and reveals the adjacent spread', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);

      touchDragTo(container, 800, 700);
      // rAF 合并：帧提交前不产生任何 transform 写。
      expect(readComicDragTranslateX(container)).toBeNull();
      // 进入拖动态即取消相邻 spread 的 [hidden] 并布局为右侧横向邻居。
      expect(neighbor.hidden).toBe(false);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(true);
      expect(neighbor.style.left).toBe('100%');
      expect(neighbor.style.width).toBe('100%');

      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-100);

      pointerOn(container, 'pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        buttons: 1,
        clientX: 500,
        clientY: 400,
      });
      expect(readComicDragTranslateX(container)).toBe(-100); // 帧内旧值
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-300);
      expect(handle.currentPage).toBe(1); // 未松手不翻页

      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 500,
        clientY: 400,
      });
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('never enters the drag state for mouse pointers', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      swipeCanvas(container, 800, 200, 'mouse');
      frames.flush();
      expect(readComicDragTranslateX(container)).toBeNull();
      expect(comicSurface(container).style.position).toBe('');
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
      expect(handle.currentPage).toBe(1);
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('never enters the drag state in strip mode', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ mode: 'strip' }),
    });
    const frames = fakeFrames();
    try {
      touchDragTo(container, 800, 200);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBeNull();
      const slots = container.querySelectorAll<HTMLElement>('.lightink-reader-cbz-slot');
      for (const slot of slots) {
        expect(slot.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
      }
      expect(handle.currentPage).toBe(1);
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 200,
        clientY: 400,
      });
      expect(handle.currentPage).toBe(1);
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('commits a past-threshold release with an eased continuation from the drag offset', async () => {
    const updates: Array<() => void> = [];
    const finishedResolvers: Array<() => void> = [];
    const doc = document as Document & { startViewTransition?: unknown };
    doc.startViewTransition = ((update: () => void) => {
      updates.push(update);
      update();
      return {
        finished: new Promise<void>((resolve) => finishedResolvers.push(resolve)),
        skipTransition: () => undefined,
      };
    }) as unknown as Document['startViewTransition'];
    try {
      const container = document.createElement('div');
      sizeCanvas(container);
      const onPageChange = vi.fn();
      const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
        preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
        onPageChange,
      });
      // 预取就绪后提交路径无 decode hold，落位断言确定。
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      const frames = fakeFrames();
      const clock = controllableClock();
      try {
        touchDragTo(container, 800, 500); // dx=-300，远过提交阈 48
        frames.flush();
        expect(readComicDragTranslateX(container)).toBe(-300);

        pointerOn(container, 'pointerup', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 500,
          clientY: 400,
        });
        expect(handle.currentPage).toBe(1); // 提交发生在缓动完成后

        clock.set(10); // 首帧即须越过拖动偏移：从 0 重启的回退实现此处仅 ~-186
        frames.flush();
        const early = readComicDragTranslateX(container);
        expect(early).not.toBeNull();
        expect(early!).toBeLessThan(-300);
        expect(handle.currentPage).toBe(1); // 缓动中尚未提交

        clock.set(100); // 半程：从当前拖动偏移继续向 -1000（视口宽）
        frames.flush();
        const mid = readComicDragTranslateX(container);
        expect(mid).not.toBeNull();
        expect(mid!).toBeLessThan(-300);
        expect(mid!).toBeGreaterThan(-1000);
        expect(handle.currentPage).toBe(1); // 缓动中尚未提交

        clock.set(250);
        frames.flush();
        expect(handle.currentPage).toBe(2);
        // A3（P1）：拖动提交与 scrollToIndex 同契约触发换页回调，
        // 否则进度持久化与外层阅读器状态停留在旧页。
        expect(onPageChange).toHaveBeenCalledTimes(1);
        // 拖动提交不走 View Transition：跟手已有实时帧。
        expect(updates).toHaveLength(0);
        // 落位后无残留：transform 清零、旧 spread 隐藏、邻居槽回常规流。
        expect(readComicDragTranslateX(container)).toBeNull();
        const landed = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
        expect(landed.hidden).toBe(false);
        expect(landed.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
        expect(landed.style.left).toBe('');
        expect(container.querySelector<HTMLElement>('[data-page-index="0"]')!.hidden).toBe(
          true,
        );
        await handle.destroy();
      } finally {
        frames.restore();
        clock.restore();
      }
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });

  it('bounces back below the release threshold and restores the neighbor hidden state', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const onPageChange = vi.fn();
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
      onPageChange,
    });
    const frames = fakeFrames();
    const clock = controllableClock();
    try {
      touchDragTo(container, 800, 755); // dx=-45：过 slop(40)，未过提交阈(48)
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-45);

      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 755,
        clientY: 400,
      });
      clock.set(250);
      frames.flush();
      expect(handle.currentPage).toBe(1);
      expect(onPageChange).not.toHaveBeenCalled(); // 回弹不换页：无回调
      expect(readComicDragTranslateX(container)).toBeNull(); // transform 归零
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
      expect(container.querySelector<HTMLElement>('[data-page-index="0"]')!.hidden).toBe(
        false,
      );
      await handle.destroy();
    } finally {
      frames.restore();
      clock.restore();
    }
  });

  it('turns on a fast small-displacement flick via the velocity threshold', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
    );
    const frames = fakeFrames();
    const clock = controllableClock();
    try {
      clock.set(0);
      pointerOn(container, 'pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        buttons: 1,
        clientX: 800,
        clientY: 400,
      });
      clock.set(4);
      pointerOn(container, 'pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        buttons: 1,
        clientX: 760, // dx=-40：刚过 slop 进入拖动态
        clientY: 400,
      });
      clock.set(8);
      pointerOn(container, 'pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        buttons: 1,
        clientX: 757, // dx=-43 < 48，速度 (-43+40)/4ms = -0.75px/ms
        clientY: 400,
      });
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-43);
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 757,
        clientY: 400,
      });
      clock.set(250);
      frames.flush();
      expect(handle.currentPage).toBe(2); // 位移未过阈但速度过阈
      expect(readComicDragTranslateX(container)).toBeNull();
      await handle.destroy();
    } finally {
      frames.restore();
      clock.restore();
    }
  });

  it('abandons the drag when a second pointer lands, handing over to pinch', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      touchDragTo(container, 800, 700);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-100);

      pointerOn(container, 'pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        buttons: 1,
        clientX: 400,
        clientY: 400,
      });
      // 第二指落下瞬间：拖动残留全部清理，无可见偏移。
      expect(readComicDragTranslateX(container)).toBeNull();
      expect(comicSurface(container).style.position).toBe('');
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(false);

      // 双指张开进入 pinch：只缩放，不翻页。
      pointerOn(container, 'pointermove', {
        pointerId: 2,
        pointerType: 'touch',
        buttons: 1,
        clientX: 300,
        clientY: 400,
      });
      expect(readComicScale(container)).toBeGreaterThan(1);
      expect(handle.currentPage).toBe(1);
      pointerOn(container, 'pointerup', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 300,
        clientY: 400,
      });
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 700,
        clientY: 400,
      });
      expect(handle.currentPage).toBe(1);
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('cleans the drag state on destroy and on relayout', async () => {
    const first = document.createElement('div');
    sizeCanvas(first);
    const firstHandle = await renderCbzInto(await buildCbz(4), first, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      touchDragTo(first, 800, 700);
      frames.flush();
      expect(readComicDragTranslateX(first)).toBe(-100);
      await firstHandle.destroy();
      expect(readComicDragTranslateX(first)).toBeNull();
      expect(first.querySelector<HTMLElement>('[data-page-index="1"]')!.hidden).toBe(true);
      expect(comicSurface(first).style.position).toBe('');

      const second = document.createElement('div');
      sizeCanvas(second);
      const secondHandle = await renderCbzInto(await buildCbz(4), second, undefined, {
        preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
      });
      touchDragTo(second, 800, 650);
      frames.flush();
      expect(readComicDragTranslateX(second)).toBe(-150);
      secondHandle.setPreferences({ fit: 'width' }); // 重排版：spreadSwapGeneration 作废
      expect(readComicDragTranslateX(second)).toBeNull();
      const neighbor = second.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
      pointerOn(second, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 650,
        clientY: 400,
      });
      expect(secondHandle.currentPage).toBe(1); // 作废手势的残余松手不翻页
      await secondHandle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('cancels the in-flight release easing when a new drag starts', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
    );
    const frames = fakeFrames();
    const clock = controllableClock();
    try {
      touchDragTo(container, 800, 500); // dx=-300，松手将提交
      frames.flush();
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 500,
        clientY: 400,
      });
      clock.set(100);
      frames.flush(); // 提交缓动在飞（中途）
      expect(handle.currentPage).toBe(1);

      // 缓动未完成时立即开始新拖动：在飞缓动作废，最新手势接管 transform。
      clock.set(120);
      touchDragTo(container, 900, 850);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-50);
      expect(handle.currentPage).toBe(1); // 旧提交未发生

      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 850,
        clientY: 400,
      });
      clock.set(400);
      frames.flush();
      expect(handle.currentPage).toBe(2); // 最新手势的松手提交生效
      expect(readComicDragTranslateX(container)).toBeNull();
      await handle.destroy();
    } finally {
      frames.restore();
      clock.restore();
    }
  });

  it('collapses the view to the current spread when a new drag supersedes a decode-hold', async () => {
    // 首页 decode 直通；后续页悬挂，使拖动提交落进 decode-hold（目标页未物化）。
    let decodeCalls = 0;
    const queued: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value() {
        decodeCalls += 1;
        if (decodeCalls === 1) return Promise.resolve();
        return new Promise<void>((resolve) => queued.push(resolve));
      },
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    // 预取把页 1 的解码挂在悬挂态：提交时页 1 未物化 → 换屏被 decode-hold 挂起。
    await vi.waitFor(() => expect(queued.length).toBeGreaterThan(0));
    const frames = fakeFrames();
    const clock = controllableClock();
    try {
      touchDragTo(container, 800, 500); // dx=-300，远过提交阈
      frames.flush();
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 500,
        clientY: 400,
      });
      clock.set(250);
      frames.flush(); // 缓动到位：showPagedSpread 进入 hold，页码已前进
      expect(handle.currentPage).toBe(2);

      // hold 未决（decode 悬挂）时立即重拖：挂起提交被世代号作废，
      // 视图必须收敛到当前 spread（页 1），旧页 0 不得残留未隐藏。
      clock.set(260);
      touchDragTo(container, 800, 755); // dx=-45：过 slop，未过提交阈
      expect(visiblePageIndices(container)).toEqual(['1', '2']); // 当前 spread + 新邻居
      const current = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(current.classList.contains('lightink-comic-drag-neighbor')).toBe(false);
      expect(current.style.position).toBe(''); // 当前 spread 回常规流
      expect(container.querySelector<HTMLElement>('[data-page-index="0"]')!.hidden).toBe(true);
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="2"]')!;
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(true);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-45);

      // 新拖动不过阈回弹：视图恰为当前 spread，无残留偏移。
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 755,
        clientY: 400,
      });
      clock.set(500);
      frames.flush();
      expect(handle.currentPage).toBe(2);
      expect(readComicDragTranslateX(container)).toBeNull();
      expect(visiblePageIndices(container)).toEqual(['1']);
      expect(neighbor.classList.contains('lightink-comic-drag-neighbor')).toBe(false);

      // 被作废的 hold 提交不得随后落位：解码完成后无额外换屏。
      queued.splice(0).forEach((resolve) => resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      expect(handle.currentPage).toBe(2);
      expect(visiblePageIndices(container)).toEqual(['1']);
      await handle.destroy();
    } finally {
      frames.restore();
      clock.restore();
    }
  });

  it('lets a committed drag turn finish easing despite an unrelated pointercancel', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    await vi.waitFor(() =>
      expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
    );
    const frames = fakeFrames();
    const clock = controllableClock();
    try {
      touchDragTo(container, 800, 500); // dx=-300，松手即提交
      frames.flush();
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 500,
        clientY: 400,
      });
      clock.set(100);
      frames.flush(); // 提交缓动在飞
      expect(handle.currentPage).toBe(1);

      // 无关新指（如手掌误触）落下即被系统取消：未过 slop、非拖动指。
      pointerOn(container, 'pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        buttons: 1,
        clientX: 600,
        clientY: 400,
      });
      pointerOn(container, 'pointercancel', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 600,
        clientY: 400,
      });

      // 已提交的翻页必须完成：缓动走完、页码前进、落位无残留。
      clock.set(250);
      frames.flush();
      expect(handle.currentPage).toBe(2);
      expect(readComicDragTranslateX(container)).toBeNull();
      expect(visiblePageIndices(container)).toEqual(['1']);
      await handle.destroy();
    } finally {
      frames.restore();
      clock.restore();
    }
  });

  it('keeps View Transition for edge taps but never for drag turns', async () => {
    const updates: Array<() => void> = [];
    const finishedResolvers: Array<() => void> = [];
    const doc = document as Document & { startViewTransition?: unknown };
    doc.startViewTransition = ((update: () => void) => {
      updates.push(update);
      update();
      return {
        finished: new Promise<void>((resolve) => finishedResolvers.push(resolve)),
        skipTransition: () => undefined,
      };
    }) as unknown as Document['startViewTransition'];
    try {
      const container = document.createElement('div');
      sizeCanvas(container);
      const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
        preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
      });
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      const frames = fakeFrames();
      const clock = controllableClock();
      try {
        touchDragTo(container, 800, 500);
        frames.flush();
        pointerOn(container, 'pointerup', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 500,
          clientY: 400,
        });
        clock.set(250);
        frames.flush();
        expect(handle.currentPage).toBe(2);
        expect(updates).toHaveLength(0); // 拖动路径不触发 VT

        clickCanvas(container, 50); // 边区点按（返回上一页）仍走 VT
        expect(updates).toHaveLength(1);
        expect(document.documentElement.dataset.comicTurn).toBe('prev');
        expect(handle.currentPage).toBe(1);
        finishedResolvers.splice(0).forEach((resolve) => resolve());
        await vi.waitFor(() =>
          expect(document.documentElement.dataset.comicTurn).toBeUndefined(),
        );
        await handle.destroy();
      } finally {
        frames.restore();
        clock.restore();
      }
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
      delete document.documentElement.dataset.comicTurn;
    }
  });

  it('skips an in-flight turn View Transition when a drag starts inside its window', async () => {
    const updates: Array<() => void> = [];
    const finishedResolvers: Array<() => void> = [];
    let skipCalls = 0;
    const doc = document as Document & { startViewTransition?: unknown };
    doc.startViewTransition = ((update: () => void) => {
      updates.push(update);
      update();
      return {
        finished: new Promise<void>((resolve) => finishedResolvers.push(resolve)),
        skipTransition: () => {
          skipCalls += 1;
        },
      };
    }) as unknown as Document['startViewTransition'];
    try {
      const container = document.createElement('div');
      sizeCanvas(container);
      const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
        preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
      });
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      const frames = fakeFrames();
      try {
        // 边区点按翻页进入 View Transition（finished 未决：仍处转场窗口）。
        clickCanvas(container, 950);
        expect(updates).toHaveLength(1);
        expect(skipCalls).toBe(0); // 首个转场提交时无在飞转场可跳
        expect(handle.currentPage).toBe(2);

        // 转场窗口内开始拖动：新手势接管必须跳过在飞 VT，跟手 transform
        // 不再被旧快照遮挡；首个跟手帧即写入位移。
        touchDragTo(container, 800, 700);
        expect(skipCalls).toBe(1);
        frames.flush();
        expect(readComicDragTranslateX(container)).toBe(-100);

        pointerOn(container, 'pointerup', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 700,
          clientY: 400,
        });
        finishedResolvers.splice(0).forEach((resolve) => resolve());
        await vi.waitFor(() =>
          expect(document.documentElement.dataset.comicTurn).toBeUndefined(),
        );
        await handle.destroy();
      } finally {
        frames.restore();
      }
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
      delete document.documentElement.dataset.comicTurn;
    }
  });
});

describe('CBZ drag-turn urgent prefetch and loading feedback (T2)', () => {
  it('urgent-prefetches the drag target during the drag, before release', async () => {
    // decode 桩顺带捕获 fetchPriority：urgent=high（绕过并发 1 的预取解码
    // 限流），非 urgent 预取为 low——这是拖动 urgent 语义的直接判别器。
    const priorities: string[] = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value(this: HTMLImageElement) {
        priorities.push(String(this.fetchPriority));
        return Promise.resolve();
      },
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      // 同步进入拖动（预取定时器尚未触发）：目标页 1 的加载只能来自拖动。
      touchDragTo(container, 800, 700); // 不抬指
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-100);
      expect(handle.currentPage).toBe(1); // 未松手不翻页
      // 拖动期目标页的读取+解码已开始（不等松手），且走 urgent 优先级。
      await vi.waitFor(() => expect(priorities.length).toBeGreaterThanOrEqual(2));
      expect(priorities[1]).toBe('high');
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      expect(handle.currentPage).toBe(1); // 全程未松手，页已就绪
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 700,
        clientY: 400,
      });
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('marks the unmaterialized drag neighbor with the loading class until it materializes', async () => {
    // 首页 decode 直通让 renderCbzInto 完成；后续页悬挂，锁定未物化中间态。
    let decodeCalls = 0;
    const queued: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value() {
        decodeCalls += 1;
        if (decodeCalls === 1) return Promise.resolve();
        return new Promise<void>((resolve) => queued.push(resolve));
      },
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      const neighbor = container.querySelector<HTMLElement>('[data-page-index="1"]')!;
      expect(neighbor.hidden).toBe(true);
      expect(neighbor.classList.contains('lightink-comic-page-loading')).toBe(false); // 隐藏槽无指示

      touchDragTo(container, 800, 700);
      expect(neighbor.hidden).toBe(false);
      // 纯 CSS 指示：未物化邻居只加类，不引入任何叠加元素/图标/文案。
      expect(neighbor.classList.contains('lightink-comic-page-loading')).toBe(true);
      expect(neighbor.children).toHaveLength(0);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-100);
      // 拖动 urgent 加载已推进到目标页解码（页 0 初始 + 页 1 拖动触发）。
      await vi.waitFor(() => expect(decodeCalls).toBeGreaterThanOrEqual(2));

      // 物化完成：类随 img 挂载摘除，槽内只有页面元素。
      queued.splice(0).forEach((resolve) => resolve());
      await vi.waitFor(() => expect(neighbor.querySelector('img')).not.toBeNull());
      expect(neighbor.classList.contains('lightink-comic-page-loading')).toBe(false);
      expect(neighbor.children).toHaveLength(1);
      pointerOn(container, 'pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 700,
        clientY: 400,
      });
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });

  it('keeps the drag-triggered urgent load alive through mid-drag cache refreshes', async () => {
    let decodeCalls = 0;
    const queued: Array<() => void> = [];
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value() {
        decodeCalls += 1;
        if (decodeCalls === 1) return Promise.resolve();
        return new Promise<void>((resolve) => queued.push(resolve));
      },
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage({ direction: 'ltr', spread: 'single' }),
    });
    const frames = fakeFrames();
    try {
      // 同步进入拖动：目标页 1 的在飞 urgent 加载由拖动发起，解码悬挂。
      touchDragTo(container, 800, 700);
      frames.flush();
      expect(readComicDragTranslateX(container)).toBe(-100);
      // 预取定时器在拖动期内触发 refreshCacheWindow：不得 abort 拖动目标
      // 的在飞加载（abort 会在解码拒绝时 revoke 其 blob URL 并丢弃挂载）。
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readComicDragTranslateX(container)).toBe(-100); // 手势仍在
      await vi.waitFor(() => expect(decodeCalls).toBeGreaterThanOrEqual(2));
      expect(revokeObjectUrl).not.toHaveBeenCalled();

      // 重排版（setPreferences → applyLayout）按 T1 语义作废手势本身，
      // 但其缓存刷新同样不得丢弃在飞加载：解码完成后页面照常物化。
      handle.setPreferences({ fit: 'width' });
      expect(readComicDragTranslateX(container)).toBeNull();
      queued.splice(0).forEach((resolve) => resolve());
      await vi.waitFor(() =>
        expect(container.querySelector('[data-page-index="1"] img')).not.toBeNull(),
      );
      expect(revokeObjectUrl).not.toHaveBeenCalled();
      await handle.destroy();
    } finally {
      frames.restore();
    }
  });
});

describe('CBZ chrome overlay and system bars (R4)', () => {
  it('keeps a single comic overlay and no EPUB footer actions', async () => {
    document.documentElement.lang = 'en';
    document.documentElement.setAttribute('data-touch-primary', '');
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    expect(container.querySelectorAll('.lightink-reader-comic-chrome')).toHaveLength(1);
    expect(container.querySelector('.lightink-reader-comic-hud')).toBeNull();
    expect(container.querySelector('.lightink-reader-chrome-footer')).toBeNull();
    expect(container.querySelector('[data-reader-chrome-action="toc"]')).toBeNull();
    expect(container.querySelector('[data-reader-chrome-action="typography"]')).toBeNull();
    expect(container.querySelector('[data-reader-chrome-action="search"]')).toBeNull();
    expect(container.querySelector('[data-reader-chrome-action="annotations"]')).toBeNull();
    expect(container.querySelector('.lightink-reader-comic-back')).not.toBeNull();
    await handle.destroy();
  });

  it('keeps canvas padding stable when chrome toggles so the page does not rescale', async () => {
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    expect(container.dataset.comicChrome).toBe('visible');
    const shownPadding = container.style.padding;
    expect(container.style.height).toBe('100%');
    expect(handle.hideChrome()).toBe(true);
    expect(container.dataset.comicChrome).toBe('hidden');
    expect(container.style.padding).toBe(shownPadding);
    expect(container.style.height).toBe('100%');
    clickCanvas(container, 500);
    expect(container.dataset.comicChrome).toBe('visible');
    expect(container.style.padding).toBe(shownPadding);
    expect(container.style.height).toBe('100%');
    await handle.destroy();
  });

  it('pairs chrome hide/show with system bars and does not invoke twice for a no-op hide', async () => {
    const setSystemBarsVisible = vi.fn();
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage(),
      setSystemBarsVisible,
    });

    expect(setSystemBarsVisible).not.toHaveBeenCalled();
    expect(handle.hideChrome()).toBe(true);
    expect(setSystemBarsVisible).toHaveBeenCalledTimes(1);
    expect(setSystemBarsVisible).toHaveBeenCalledWith(false);
    expect(handle.hideChrome()).toBe(false);
    expect(setSystemBarsVisible).toHaveBeenCalledTimes(1);
    clickCanvas(container, 500);
    expect(container.dataset.comicChrome).toBe('visible');
    expect(setSystemBarsVisible).toHaveBeenCalledTimes(2);
    expect(setSystemBarsVisible).toHaveBeenLastCalledWith(true);
    await handle.destroy();
  });

  it('hides app chrome and still turns pages when the system-bar hook rejects', async () => {
    const setSystemBarsVisible = vi.fn(() => {
      throw new Error('bridge down');
    });
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(4), container, undefined, {
      preferenceStorage: pagedStorage(),
      setSystemBarsVisible,
    });

    expect(handle.hideChrome()).toBe(true);
    expect(container.dataset.comicChrome).toBe('hidden');
    expect(handle.currentPage).toBe(1);
    clickCanvas(container, 950);
    expect(handle.currentPage).toBe(2);
    await handle.destroy();
  });

  it('does not call the Android bridge on desktop', async () => {
    const setVisible = vi.fn();
    const container = document.createElement('div');
    sizeCanvas(container);
    const handle = await renderCbzInto(await buildCbz(3), container, undefined, {
      preferenceStorage: pagedStorage(),
    });

    expect(handle.hideChrome()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
    syncComicSystemBarsVisible(
      false,
      { LightInkSystemBars: { setVisible } } as unknown as Window & ComicSystemBarsHost,
      document.documentElement,
    );
    expect(setVisible).not.toHaveBeenCalled();
    await handle.destroy();
  });
});

describe('syncComicSystemBarsVisible', () => {
  it('forwards visible=false/true to the JS bridge on Android', () => {
    document.documentElement.setAttribute('data-android', '');
    const setVisible = vi.fn();
    const host = androidTauriHost({ LightInkSystemBars: { setVisible } });
    syncComicSystemBarsVisible(false, host, document.documentElement);
    syncComicSystemBarsVisible(true, host, document.documentElement);
    expect(setVisible.mock.calls).toEqual([[false], [true]]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('invokes set_system_bars_visible when Android has Tauri but no JS bridge', () => {
    document.documentElement.setAttribute('data-android', '');
    const host = androidTauriHost();
    syncComicSystemBarsVisible(false, host, document.documentElement);
    syncComicSystemBarsVisible(true, host, document.documentElement);
    expect(invokeMock).toHaveBeenNthCalledWith(1, SET_SYSTEM_BARS_VISIBLE_COMMAND, {
      visible: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, SET_SYSTEM_BARS_VISIBLE_COMMAND, {
      visible: true,
    });
  });

  it('swallows a missing or rejecting bridge so reading chrome can still hide', () => {
    document.documentElement.setAttribute('data-android', '');
    const host = androidTauriHost({
      LightInkSystemBars: {
        setVisible: () => {
          throw new Error('no plugin');
        },
      },
    });
    expect(() => syncComicSystemBarsVisible(false, host, document.documentElement)).not.toThrow();
    invokeMock.mockRejectedValue(new Error('invoke failed'));
    expect(() =>
      syncComicSystemBarsVisible(true, androidTauriHost(), document.documentElement),
    ).not.toThrow();
  });
});
