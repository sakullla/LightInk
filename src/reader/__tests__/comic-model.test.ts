// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyComicCropDisplay,
  comicCropInsetsFromRgba,
  comicCroppedSize,
  comicDisplayCeilingCssPx,
  comicDisplayWidthPx,
  COMIC_CROP_NONE,
  isComicCropEmpty,
  comicImageBlob,
  comicImageObjectUrl,
  compareComicPaths,
  createComicPageElement,
  isComicImagePath,
  orderComicCacheLoads,
  orderComicPages,
  parseComicInfo,
  selectComicCacheWindow,
  sniffComicImageMime,
  type ComicPageCandidate,
} from '../comic-model.js';
import {
  COMIC_PREFERENCES_STORAGE_KEY,
  advanceComicPage,
  clampComicViewOffset,
  comicPageFromProgress,
  comicSpreadIndex,
  comicTurnPrefetchCenters,
  comicVisiblePages,
  defaultComicPreferences,
  loadComicPreferences,
  parseComicPreferences,
  resolveComicSpread,
  saveComicPreferences,
  type ComicPreferences,
} from '../comic-preferences.js';

function page(id: string, filename: string): ComicPageCandidate {
  return {
    id,
    filename,
    directory: false,
    compressedSize: 1,
    uncompressedSize: 2,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function comicPrefs(value: {
  mode: 'paged' | 'strip';
  direction: 'ltr' | 'rtl';
  spread: 'single' | 'double' | 'auto';
  fit: 'screen' | 'width' | 'height' | 'original';
  cropMargins?: boolean;
}): ComicPreferences {
  return { cropMargins: false, ...value };
}

describe('comic page model', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-android');
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('sorts each path segment naturally and deterministically', () => {
    const paths = [
      'chapter10/page1.jpg',
      'chapter2/page10.jpg',
      'chapter2/page2.jpg',
      'chapter02/page1.jpg',
      'chapter2/第10页.jpg',
      'chapter2/第2页.jpg',
    ];
    expect(paths.sort(compareComicPaths)).toEqual([
      'chapter02/page1.jpg',
      'chapter2/page2.jpg',
      'chapter2/page10.jpg',
      'chapter2/第2页.jpg',
      'chapter2/第10页.jpg',
      'chapter10/page1.jpg',
    ]);
  });

  it('filters hidden, thumbnail, and operating-system files', () => {
    expect(
      [
        'page.webp',
        'folder/page.bmp',
        '.hidden/page.jpg',
        '__MACOSX/page.jpg',
        'Thumbs.db',
        'thumbnail-1.png',
        'notes.txt',
      ].filter(isComicImagePath),
    ).toEqual(['page.webp', 'folder/page.bmp']);
  });

  it('uses ComicInfo page order, cover, series, and RTL metadata', () => {
    const metadata = parseComicInfo(`<?xml version="1.0"?>
      <ComicInfo>
        <Title>第十卷</Title><Series>示例系列</Series><Number>10</Number><Volume>2</Volume>
        <PageCount>3</PageCount><Manga>YesAndRightToLeft</Manga>
        <Pages><Page Image="2" Type="FrontCover"/><Page Image="0"/></Pages>
      </ComicInfo>`);
    expect(metadata).toMatchObject({
      title: '第十卷',
      series: '示例系列',
      number: '10',
      volume: '2',
      pageCount: 3,
      coverPage: 2,
      readingDirection: 'rtl',
    });
    expect(orderComicPages([page('1', 'page1.jpg'), page('2', 'page2.jpg'), page('3', 'page3.jpg')], metadata)
      .map((entry) => entry.filename)).toEqual(['page3.jpg', 'page1.jpg', 'page2.jpg']);
  });

  it('crops uniform scan margins in CSS and leaves tight pages alone', () => {
    const fill = (width: number, height: number, paint: (x: number, y: number) => [number, number, number]) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const [r, g, b] = paint(x, y);
          const offset = (y * width + x) * 4;
          data[offset] = r;
          data[offset + 1] = g;
          data[offset + 2] = b;
          data[offset + 3] = 255;
        }
      }
      return data;
    };
    const scanned = comicCropInsetsFromRgba(
      fill(100, 140, (x, y) => (x >= 14 && x < 88 && y >= 18 && y < 124 ? [20, 20, 20] : [250, 250, 250])),
      100,
      140,
    );
    expect(scanned.left).toBeGreaterThan(0.08);
    expect(scanned.right).toBeGreaterThan(0.08);
    expect(scanned.top).toBeGreaterThan(0.08);
    expect(scanned.bottom).toBeGreaterThan(0.08);
    expect(isComicCropEmpty(scanned)).toBe(false);
    expect(comicCroppedSize(2000, 2800, scanned).width).toBeLessThan(2000);

    const bleed = comicCropInsetsFromRgba(
      fill(80, 80, () => [12, 12, 12]),
      80,
      80,
    );
    expect(bleed).toEqual(COMIC_CROP_NONE);

    const mixed = comicCropInsetsFromRgba(
      fill(80, 80, (x) => (x < 40 ? [250, 250, 250] : [12, 12, 12])),
      80,
      80,
    );
    expect(mixed).toEqual(COMIC_CROP_NONE);

    const sideMargins = comicCropInsetsFromRgba(
      fill(100, 80, (x) => (x >= 16 && x < 86 ? [18, 18, 18] : [248, 248, 248])),
      100,
      80,
    );
    expect(sideMargins.left).toBeGreaterThan(0.08);
    expect(sideMargins.right).toBeGreaterThan(0.08);
    expect(sideMargins.top).toBeLessThan(0.03);
    expect(sideMargins.bottom).toBeLessThan(0.03);

    const slot = document.createElement('div');
    const image = document.createElement('img');
    applyComicCropDisplay(slot, image, 2000, 2800, {
      top: 0.1,
      right: 0.1,
      bottom: 0.1,
      left: 0.1,
    });
    expect(slot.dataset.comicCropped).toBe('true');
    expect(slot.style.aspectRatio).toBe('1600 / 2240');
    expect(image.style.width).toBe('125%');
    expect(image.style.marginLeft).toBe('-12.5%');
    applyComicCropDisplay(slot, image, 2000, 2800, COMIC_CROP_NONE);
    expect(slot.dataset.comicCropped).toBeUndefined();
    expect(slot.style.aspectRatio).toBe('');
    expect(image.style.marginLeft).toBe('');
    applyComicCropDisplay(slot, image, 2000, 2800, COMIC_CROP_NONE, { fallbackAspect: 'natural' });
    expect(slot.style.aspectRatio).toBe('2000 / 2800');
  });

  it('scales the display budget by devicePixelRatio and keeps CSS layout on the slot', () => {
    const slot = document.createElement('div');
    Object.defineProperty(slot, 'clientWidth', { configurable: true, value: 640 });
    expect(comicDisplayWidthPx(slot, 800, { devicePixelRatio: 1 })).toBe(640);
    expect(comicDisplayWidthPx(slot, 800, { devicePixelRatio: 2 })).toBe(1280);
    const hidden = document.createElement('div');
    hidden.hidden = true;
    Object.defineProperty(hidden, 'clientWidth', { configurable: true, value: 0 });
    const parent = document.createElement('div');
    parent.append(hidden);
    Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 720 });
    expect(comicDisplayWidthPx(hidden, 800, { devicePixelRatio: 1 })).toBe(720);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x1, 0x2]);
    expect(comicImageBlob(jpeg, 'page.jpg').type).toBe('image/jpeg');
  });

  it('exposes the zoom raster ceiling as the 8192 device-pixel budget at the clamped dpr', () => {
    expect(comicDisplayCeilingCssPx({ devicePixelRatio: 1 })).toBe(8192);
    expect(comicDisplayCeilingCssPx({ devicePixelRatio: 2 })).toBe(4096);
    expect(comicDisplayCeilingCssPx({ devicePixelRatio: 8 })).toBe(2048);
    expect(comicDisplayCeilingCssPx({ devicePixelRatio: 0.5 })).toBe(8192);
    expect(comicDisplayCeilingCssPx(null)).toBe(8192);
  });

  it('rejects unsafe ComicInfo and bounds the decoded page window by bytes', () => {
    expect(parseComicInfo('<!DOCTYPE ComicInfo><ComicInfo/>')).toBeNull();
    expect([...selectComicCacheWindow([5, 5, 20, 5], [1], 15)]).toEqual([1, 0, 3]);
    expect(selectComicCacheWindow([1], [], 10).size).toBe(0);
    expect([...selectComicCacheWindow([40, 5, 5], [0], 10)]).toEqual([0]);
    expect([...selectComicCacheWindow([5, 5, 5, 5], [0], 15)]).toEqual([0, 1, 2]);
    expect([...selectComicCacheWindow([10, 10, 10, 10], [1, 2], 20)]).toEqual([1, 2]);
    expect(orderComicCacheLoads([3, 0, 1, 4], [1])).toEqual([1, 0, 3, 4]);
  });
});

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]);

function displayConstraintPx(image: HTMLImageElement): number | undefined {
  const candidates = [
    image.style.maxWidth,
    image.style.width,
    image.style.getPropertyValue('--lightink-comic-display-width'),
    image.getAttribute('width'),
    image.dataset.displayWidth,
    image.dataset.resizeWidth,
  ];
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue;
    const match = String(value).match(/(\d+(?:\.\d+)?)/);
    if (match !== null) return Number(match[1]);
  }
  if (image.width > 0 && image.width !== image.naturalWidth) return image.width;
  return undefined;
}

describe('comic page paint', () => {
  const originalDecode = HTMLImageElement.prototype.decode;
  const originalNaturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
  const originalNaturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight');
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  let decodeGate: Promise<void> = Promise.resolve();
  let decodeShouldFail = false;
  const decodedImages = new WeakSet<HTMLImageElement>();
  const revokedUrls: string[] = [];
  const createImageBitmap = vi.fn(async () => {
    throw new Error('createImageBitmap must not paint comic pages');
  });

  function installImageDecode(options: {
    width: number;
    height: number;
    gate?: Promise<void>;
    fail?: boolean;
  }): void {
    decodeGate = options.gate ?? Promise.resolve();
    decodeShouldFail = options.fail === true;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return decodeGate.then(() => {
        if (decodeShouldFail) {
          throw new DOMException('The source image cannot be decoded', 'EncodingError');
        }
        decodedImages.add(this);
      });
    };
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', {
      configurable: true,
      get() {
        return decodedImages.has(this as HTMLImageElement) ? options.width : 0;
      },
    });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', {
      configurable: true,
      get() {
        return decodedImages.has(this as HTMLImageElement) ? options.height : 0;
      },
    });
  }

  beforeEach(() => {
    revokedUrls.length = 0;
    createImageBitmap.mockClear();
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    let nextUrl = 0;
    URL.createObjectURL = ((blob: Blob) => {
      expect(blob.type).toBe('image/jpeg');
      return `blob:comic-paint-${++nextUrl}`;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      revokedUrls.push(url);
    }) as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    HTMLImageElement.prototype.decode = originalDecode;
    if (originalNaturalWidth !== undefined) {
      Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', originalNaturalWidth);
    }
    if (originalNaturalHeight !== undefined) {
      Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', originalNaturalHeight);
    }
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    if (originalCreateImageBitmap === undefined) {
      Reflect.deleteProperty(globalThis, 'createImageBitmap');
    } else {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  });

  it('waits for decode before reporting width and height', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installImageDecode({ width: 1600, height: 2400, gate });

    const pending = createComicPageElement(jpegBytes, 'page.jpg');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    const mounted = await pending;
    expect(mounted.width).toBe(1600);
    expect(mounted.height).toBe(2400);
    expect(mounted.element).toBeInstanceOf(HTMLImageElement);
    expect(mounted.element.tagName).toBe('IMG');
    expect(mounted.url).toBe('blob:comic-paint-1');
  });

  it('applies resizeWidth as a display constraint and keeps full decoded pixels', async () => {
    installImageDecode({ width: 2000, height: 2800 });
    const slot = document.createElement('div');
    Object.defineProperty(slot, 'clientWidth', { configurable: true, value: 640 });
    const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      const resizeWidth = comicDisplayWidthPx(slot);
      expect(resizeWidth).toBe(1280);
      const mounted = await createComicPageElement(jpegBytes, 'page.jpg', {
        resizeWidth,
        priority: 'high',
      });
      const image = mounted.element as HTMLImageElement;
      expect(image).toBeInstanceOf(HTMLImageElement);
      expect(mounted.width).toBe(2000);
      expect(mounted.height).toBe(2800);
      expect(mounted.width).toBeGreaterThanOrEqual(resizeWidth);
      expect(image.sizes).toBe('640px');
      expect(image.style.maxWidth).toBe('640px');
      expect(image.fetchPriority).toBe('high');
      expect(displayConstraintPx(image)).toBe(640);
      expect(createImageBitmap).not.toHaveBeenCalled();
    } finally {
      if (originalDpr === undefined) {
        Reflect.deleteProperty(window, 'devicePixelRatio');
      } else {
        Object.defineProperty(window, 'devicePixelRatio', originalDpr);
      }
    }
  });

  it('rejects a failed decode so a later call can retry without leaking the url', async () => {
    installImageDecode({ width: 800, height: 1200, fail: true });
    await expect(createComicPageElement(jpegBytes, 'page.jpg')).rejects.toThrow();
    expect(revokedUrls).toEqual(['blob:comic-paint-1']);

    installImageDecode({ width: 800, height: 1200 });
    const mounted = await createComicPageElement(jpegBytes, 'page.jpg');
    expect(mounted.width).toBe(800);
    expect(mounted.height).toBe(1200);
    expect(mounted.url).toBe('blob:comic-paint-2');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('comic preferences', () => {
  it('keeps the cover single and advances double-page spreads at their boundaries', () => {
    const doublePaged = { mode: 'paged' as const, spread: 'double' as const };
    expect(comicVisiblePages(0, 5, doublePaged)).toEqual([0]);
    expect(comicVisiblePages(1, 5, doublePaged)).toEqual([1, 2]);
    expect(advanceComicPage(0, 5, 1, doublePaged)).toBe(1);
    expect(advanceComicPage(1, 5, 1, doublePaged)).toBe(3);
    expect(advanceComicPage(3, 5, 1, doublePaged)).toBe(3);
    expect(advanceComicPage(3, 5, -1, doublePaged)).toBe(1);
    expect(advanceComicPage(1, 5, -1, doublePaged)).toBe(0);
    expect(comicSpreadIndex(0, 5, doublePaged)).toBe(0);
    expect(comicSpreadIndex(1, 5, doublePaged)).toBe(1);
    expect(comicSpreadIndex(3, 5, doublePaged)).toBe(2);
    expect(comicPageFromProgress(0, 5, doublePaged)).toBe(1);
    expect(comicPageFromProgress(0.5, 5, doublePaged)).toBe(2);
    expect(comicPageFromProgress(1, 5, doublePaged)).toBe(4);
    expect(clampComicViewOffset({ x: -4000, y: 80 }, 2, { width: 1000, height: 800 }, { width: 600, height: 800 })).toEqual(
      { x: -200, y: 0 },
    );
    expect(clampComicViewOffset({ x: 80, y: 80 }, 1, { width: 1000, height: 800 }, { width: 600, height: 800 })).toEqual(
      { x: 0, y: 0 },
    );
  });

  it('pairs from page one when cover isolation is off', () => {
    const flush = { mode: 'paged' as const, spread: 'double' as const, coverAlone: false };
    expect(comicVisiblePages(0, 5, flush)).toEqual([0, 1]);
    expect(comicVisiblePages(2, 5, flush)).toEqual([2, 3]);
    expect(comicVisiblePages(4, 5, flush)).toEqual([4]);
    expect(advanceComicPage(0, 5, 1, flush)).toBe(2);
    expect(advanceComicPage(2, 5, -1, flush)).toBe(0);
  });

  it('keeps a landscape bitmap alone so it does not split an artist spread', () => {
    const doublePaged = { mode: 'paged' as const, spread: 'double' as const };
    const landscape = new Set([2]);
    expect(comicVisiblePages(0, 5, doublePaged, landscape)).toEqual([0]);
    expect(comicVisiblePages(1, 5, doublePaged, landscape)).toEqual([1]);
    expect(comicVisiblePages(2, 5, doublePaged, landscape)).toEqual([2]);
    expect(comicVisiblePages(3, 5, doublePaged, landscape)).toEqual([3, 4]);
    expect(advanceComicPage(1, 5, 1, doublePaged, landscape)).toBe(2);
    expect(advanceComicPage(2, 5, 1, doublePaged, landscape)).toBe(3);
  });

  it('treats strip mode as a continuous run and ignores spread pairing', () => {
    const stripDouble = comicPrefs({
      mode: 'strip',
      direction: 'ltr',
      spread: 'double',
      fit: 'width',
    });
    expect(comicVisiblePages(0, 5, stripDouble)).toEqual([0, 1, 2, 3, 4]);
    expect(advanceComicPage(0, 5, 1, stripDouble)).toBe(1);
    expect(advanceComicPage(2, 5, -1, stripDouble)).toBe(1);
    expect(comicTurnPrefetchCenters(2, 5, stripDouble)).toEqual([2]);
  });

  it('keeps the next and previous paged spreads in the prefetch center set', () => {
    const doublePaged = { mode: 'paged' as const, spread: 'double' as const };
    expect(comicTurnPrefetchCenters(0, 5, doublePaged)).toEqual([0, 1, 2]);
    expect(comicTurnPrefetchCenters(1, 5, doublePaged)).toEqual([0, 1, 2, 3, 4]);
    expect(comicTurnPrefetchCenters(3, 5, doublePaged)).toEqual([1, 2, 3, 4]);
  });

  it('persists paged or strip mode, direction, spread, and each fit without throwing', () => {
    const storage = memoryStorage();
    const preferences = comicPrefs({
      mode: 'paged',
      direction: 'rtl',
      spread: 'double',
      fit: 'height',
    });
    saveComicPreferences(storage, preferences);
    expect(loadComicPreferences(storage)).toEqual(preferences);
    saveComicPreferences(storage, { ...preferences, cropMargins: true });
    expect(loadComicPreferences(storage).cropMargins).toBe(true);
    expect(parseComicPreferences('{}').cropMargins).toBe(false);
    for (const fit of ['screen', 'width', 'height', 'original'] as const) {
      const next = comicPrefs({ mode: 'strip', direction: 'ltr', spread: 'single', fit });
      saveComicPreferences(storage, next);
      expect(loadComicPreferences(storage)).toEqual(next);
    }
  });

  it('migrates v2 vertical and fitWidth JSON to strip and the matching fit', () => {
    expect(
      parseComicPreferences(
        JSON.stringify({
          mode: 'vertical',
          direction: 'rtl',
          spread: 'double',
          fitWidth: true,
        }),
      ),
    ).toEqual(comicPrefs({ mode: 'strip', direction: 'rtl', spread: 'double', fit: 'width' }));
    const migratedOffWidth = parseComicPreferences(
      JSON.stringify({
        mode: 'vertical',
        direction: 'ltr',
        spread: 'single',
        fitWidth: false,
      }),
    );
    expect(migratedOffWidth).toMatchObject({
      mode: 'strip',
      direction: 'ltr',
      spread: 'single',
    });
    expect(['screen', 'original']).toContain(migratedOffWidth.fit);
    const storage = memoryStorage({
      [COMIC_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        mode: 'vertical',
        direction: 'rtl',
        spread: 'double',
        fitWidth: true,
      }),
    });
    expect(loadComicPreferences(storage, 'ltr')).toEqual(
      comicPrefs({ mode: 'strip', direction: 'rtl', spread: 'double', fit: 'width' }),
    );
  });

  it('remembers mode, direction, spread, and fit per progressId without crossing books', () => {
    const storage = memoryStorage();
    const globalPrefs = comicPrefs({
      mode: 'paged',
      direction: 'ltr',
      spread: 'double',
      fit: 'screen',
    });
    const bookA = '0123456789abcdef';
    const bookB = 'C:/comics/other.cbz';
    const prefsA = comicPrefs({
      mode: 'strip',
      direction: 'rtl',
      spread: 'single',
      fit: 'width',
    });
    const prefsB = comicPrefs({
      mode: 'paged',
      direction: 'ltr',
      spread: 'double',
      fit: 'original',
    });
    saveComicPreferences(storage, globalPrefs);
    const globalRaw = storage.values.get(COMIC_PREFERENCES_STORAGE_KEY);
    saveComicPreferences(storage, prefsA, bookA);
    saveComicPreferences(storage, prefsB, bookB);
    expect(storage.values.get(COMIC_PREFERENCES_STORAGE_KEY)).toBe(globalRaw);
    expect(loadComicPreferences(storage, 'ltr', bookA)).toEqual(prefsA);
    expect(loadComicPreferences(storage, 'ltr', bookB)).toEqual(prefsB);
    expect(loadComicPreferences(storage)).toEqual(globalPrefs);
  });

  it('updates only the global default when progressId is missing', () => {
    const storage = memoryStorage();
    const bookA = '0123456789abcdef';
    const globalPrefs = comicPrefs({
      mode: 'paged',
      direction: 'rtl',
      spread: 'single',
      fit: 'height',
    });
    const laterGlobal = comicPrefs({
      mode: 'strip',
      direction: 'ltr',
      spread: 'double',
      fit: 'width',
    });
    const bookPrefs = comicPrefs({
      mode: 'paged',
      direction: 'rtl',
      spread: 'double',
      fit: 'original',
    });
    saveComicPreferences(storage, globalPrefs);
    expect(loadComicPreferences(storage, 'ltr', bookA)).toEqual(globalPrefs);
    saveComicPreferences(storage, bookPrefs, bookA);
    saveComicPreferences(storage, laterGlobal);
    saveComicPreferences(storage, laterGlobal, '');
    expect(loadComicPreferences(storage)).toEqual(laterGlobal);
    expect(loadComicPreferences(storage, 'rtl')).toEqual(laterGlobal);
    expect(loadComicPreferences(storage, 'ltr', bookA)).toEqual(bookPrefs);
  });

  it('falls back to defaults for damaged JSON or unknown enums without throwing', () => {
    expect(resolveComicSpread('auto', { width: 390, height: 844 })).toBe('single');
    expect(resolveComicSpread('auto', { width: 844, height: 390 })).toBe('double');
    expect(resolveComicSpread('single', { width: 844, height: 390 })).toBe('single');
    expect(resolveComicSpread('double', { width: 390, height: 844 })).toBe('double');
    expect(defaultComicPreferences('rtl')).toEqual(
      comicPrefs({ mode: 'paged', direction: 'rtl', spread: 'double', fit: 'screen' }),
    );
    document.documentElement.setAttribute('data-android', '');
    expect(defaultComicPreferences('ltr').spread).toBe('auto');
    document.documentElement.removeAttribute('data-android');
    expect(() => parseComicPreferences('{not-json', 'rtl')).not.toThrow();
    expect(parseComicPreferences('{not-json', 'rtl')).toEqual(defaultComicPreferences('rtl'));
    expect(
      parseComicPreferences(
        JSON.stringify({ mode: 'magazine', direction: 'up', spread: 'triple', fit: 'zoom' }),
        'rtl',
      ),
    ).toEqual(defaultComicPreferences('rtl'));
    const storage = memoryStorage({
      [COMIC_PREFERENCES_STORAGE_KEY]: '{not-json',
    });
    expect(() => loadComicPreferences(storage, 'rtl')).not.toThrow();
    expect(loadComicPreferences(storage, 'rtl')).toEqual(defaultComicPreferences('rtl'));
  });

  it('sniffs JPEG/PNG even when the ZIP name is garbled', () => {
    expect(sniffComicImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffComicImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
    const view = new Uint8Array(jpeg.buffer, 0, 3);
    const originalCreate = URL.createObjectURL;
    const created: Blob[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      created.push(blob);
      return 'blob:comic';
    }) as typeof URL.createObjectURL;
    try {
      expect(comicImageObjectUrl(view, '???')).toBe('blob:comic');
      expect(created[0]?.type).toBe('image/jpeg');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });
});
