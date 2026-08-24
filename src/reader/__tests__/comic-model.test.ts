// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  comicDisplayWidthPx,
  comicImageBlob,
  comicImageObjectUrl,
  compareComicPaths,
  createComicPageElement,
  isComicImagePath,
  orderComicPages,
  parseComicInfo,
  selectComicCacheWindow,
  sniffComicImageMime,
  type ComicPageCandidate,
} from '../comic-model.js';
import {
  COMIC_PREFERENCES_STORAGE_KEY,
  advanceComicPage,
  comicVisiblePages,
  defaultComicPreferences,
  loadComicPreferences,
  parseComicPreferences,
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
  spread: 'single' | 'double';
  fit: 'screen' | 'width' | 'height' | 'original';
}): ComicPreferences {
  return value;
}

describe('comic page model', () => {
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

  it('caps display width by the slot CSS size, not device pixels', () => {
    const slot = document.createElement('div');
    Object.defineProperty(slot, 'clientWidth', { configurable: true, value: 640 });
    expect(comicDisplayWidthPx(slot, 800)).toBe(640);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x1, 0x2]);
    expect(comicImageBlob(jpeg, 'page.jpg').type).toBe('image/jpeg');
  });

  it('rejects unsafe ComicInfo and bounds the decoded page window by bytes', () => {
    expect(parseComicInfo('<!DOCTYPE ComicInfo><ComicInfo/>')).toBeNull();
    expect([...selectComicCacheWindow([5, 5, 20, 5], [1], 15)]).toEqual([1, 0, 3]);
    expect(selectComicCacheWindow([1], [], 10).size).toBe(0);
    expect([...selectComicCacheWindow([40, 5, 5], [0], 10)]).toEqual([0]);
    expect([...selectComicCacheWindow([5, 5, 5, 5], [0], 15)]).toEqual([0, 1, 2]);
    expect([...selectComicCacheWindow([10, 10, 10, 10], [1, 2], 20)]).toEqual([1, 2]);
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
      expect(resizeWidth).toBe(640);
      const mounted = await createComicPageElement(jpegBytes, 'page.jpg', { resizeWidth });
      const image = mounted.element as HTMLImageElement;
      expect(image).toBeInstanceOf(HTMLImageElement);
      expect(mounted.width).toBe(2000);
      expect(mounted.height).toBe(2800);
      expect(mounted.width).toBeGreaterThanOrEqual(resizeWidth);
      expect(image.sizes).toBe('');
      expect(image.getAttribute('sizes')).toBeNull();
      expect(image.style.maxWidth).toBe('640px');
      expect(displayConstraintPx(image)).toBe(resizeWidth);
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
    expect(defaultComicPreferences('rtl')).toEqual(
      comicPrefs({ mode: 'paged', direction: 'rtl', spread: 'double', fit: 'screen' }),
    );
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
