// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMIC_PREFERENCES_STORAGE_KEY,
  comicBookPreferencesKey,
} from '../comic-preferences.js';
import { translate, type MessageKey } from '../../i18n/messages.js';
import { createReaderView } from '../reader-view.js';
import type { ReaderInputSource } from '../formats/index.js';
import { saveLibraryProgressAlias } from '../../library/library-progress.js';
import {
  chapterScrollTop,
  loadReadingProgress,
  READING_PROGRESS_KEY_PREFIX,
  READING_PROGRESS_MAX_ENTRIES,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from '../reading-progress.js';
import {
  REMOTE_IMAGE_CONSENT_LIMIT,
  SessionRemoteImagePolicy,
} from '../../media/remote-image-policy.js';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

/** R7 同标签格式切换回归：PDF 渲染走 mock（真实栅格化留手工验证）。 */
const pdfMock = vi.hoisted(() => ({ renderPdfInto: vi.fn() }));
vi.mock('../formats/pdf.js', () => ({ renderPdfInto: pdfMock.renderPdfInto }));

const fakePdfHandle = (page = 3, totalPages = 10) => ({
  controller: {
    totalPages,
    page,
    scale: 1,
    canPrev: page > 1,
    canNext: page < totalPages,
    next: () => false,
    prev: () => false,
    setPage: () => true,
    zoomIn: () => false,
    zoomOut: () => false,
    resetScale: () => false,
  },
  rerender: async () => undefined,
  scrollToPage: () => undefined,
  search: async () => [],
  outline: async () => [],
  destroy: vi.fn(async () => undefined),
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 等待一个 rAF 帧：scroll 事件经共享 rAF 合并处理器后在帧回调里同步状态。 */
const nextFrame = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

function useReaderScrollLayout(host: HTMLElement): void {
  const reader = host.querySelector<HTMLElement>('.lightink-reader');
  if (reader !== null) {
    reader.dataset.readingLayout = 'scroll';
  }
}

function mockChapterScrollLayout(
  scroller: HTMLElement,
  chapters: ReadonlyArray<HTMLElement>,
  options: { scrollTop: number; clientHeight: number; chapterHeight: number },
): void {
  const { scrollTop, clientHeight, chapterHeight } = options;
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    value: chapters.length * chapterHeight,
  });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight });
  scroller.scrollTop = scrollTop;
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
  chapters.forEach((chapter, index) => {
    Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: chapterHeight });
    vi.spyOn(chapter, 'getBoundingClientRect').mockReturnValue({
      top: index * chapterHeight - scrollTop,
    } as DOMRect);
  });
}

function frameSource(host: HTMLElement): string {
  return host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')?.srcdoc ?? '';
}

/** T3：读书页浮层四项均带文字，退出文案必须是「返回书架」。 */
const READER_CHROME_LABELS = ['返回书架', '目录', '排版', '本书标注'] as const;

function readerChrome(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.lightink-reader-chrome');
}

function isReaderChromeRevealed(host: HTMLElement): boolean {
  const chrome = readerChrome(host);
  return chrome !== null && !chrome.hidden && chrome.getAttribute('aria-hidden') !== 'true';
}

function chromeControls(host: HTMLElement): HTMLElement[] {
  const chrome = readerChrome(host);
  if (chrome === null) {
    return [];
  }
  return [...chrome.querySelectorAll<HTMLElement>('button, [role="button"]')];
}

function chromeControlByLabel(host: HTMLElement, label: string): HTMLElement | undefined {
  const actions: Record<string, readonly string[]> = {
    返回书架: ['shelf', 'backToShelf'],
    目录: ['toc'],
    排版: ['typography'],
    本书标注: ['annotations'],
  };
  for (const action of actions[label] ?? []) {
    const match = host.querySelector<HTMLElement>(`[data-reader-chrome-action="${action}"]`);
    if (match !== null) {
      return match;
    }
  }
  return chromeControls(host).find((el) => (el.textContent ?? '').includes(label));
}

function revealReaderChrome(host: HTMLElement): void {
  const page =
    host.querySelector<HTMLElement>('.lightink-reader-scroll') ??
    host.querySelector<HTMLElement>('.lightink-reader');
  page?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function readerViewDeps(
  extras: Record<string, unknown> = {},
): Parameters<typeof createReaderView>[1] {
  return {
    readBytes: async () => bytes('unused'),
    parseContent: async () => ({
      chapters: [{ title: 'One', html: '<p>one</p>' }],
    }),
    ...extras,
  } as Parameters<typeof createReaderView>[1];
}

function clearReaderStorage(): void {
  delete document.documentElement.dataset.readingLayout;
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-android');
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) {
      return;
    }
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith('lightink.reader.')) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // jsdom / Node without Storage.
  }
}

async function buildTinyCbz(): Promise<Uint8Array> {
  return buildPagedCbz(1);
}

async function buildPagedCbz(pageCount = 3): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 1; index <= pageCount; index += 1) {
    await zip.add(
      `${String(index).padStart(3, '0')}.png`,
      new Uint8ArrayReader(png),
      { level: 0 },
    );
  }
  return zip.close();
}

function memoryProgressStore(): ProgressStorage & { readonly values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

function localComicSourceDeps(
  archive: Uint8Array,
  extras: Record<string, unknown> = {},
): Parameters<typeof createReaderView>[1] {
  return {
    readBytes: async () => {
      throw new Error('must not be read');
    },
    readSize: async () => archive.byteLength,
    readChunk: async (_path: string, offset: number, length: number) =>
      archive.slice(offset, offset + length),
    getContentHash: async () => {
      throw new Error('must not hash a comic archive');
    },
    readAnnotations: async () => '',
    ...extras,
  } as Parameters<typeof createReaderView>[1];
}

function clickComicStripMode(host: HTMLElement): void {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.lightink-reader-comic-modes button')].find(
    (el) => /Vertical|竖向|连续|Strip/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`),
  );
  expect(button).toBeDefined();
  button!.click();
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

function stubComicObjectUrls(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:cbz-page'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
}

beforeEach(() => {
  clearReaderStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  pdfMock.renderPdfInto.mockReset();
  document.body.replaceChildren();
  clearReaderStorage();
  if (originalScrollIntoView === undefined) {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  } else {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  }
});

describe('Reader load lifecycle', () => {
  it('opens a local native comic provider without reading the whole archive', async () => {
    const readEntry = vi.fn(async (entryId: string) =>
      entryId === 'comic-info'
        ? bytes('<ComicInfo><Series>本地系列</Series><Volume>3</Volume></ComicInfo>')
        : new Uint8Array([1, 2, 3]),
    );
    const close = vi.fn(async () => undefined);
    const onComicMetadata = vi.fn(async () => undefined);
    const openArchiveProvider = vi.fn(async () => ({
      entries: [
        {
          id: 'comic-info',
          filename: 'ComicInfo.xml',
          directory: false,
          compressedSize: 40,
          uncompressedSize: 70,
        },
        {
          id: 'entry-0',
          filename: 'page1.png',
          directory: false,
          compressedSize: 3,
          uncompressedSize: 3,
        },
      ],
      accessMode: 'random' as const,
      readEntry,
      close,
    }));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:native-comic'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const host = document.createElement('div');
    const view = createReaderView(host, { openArchiveProvider, onComicMetadata });

    await view.load('/books/comic.cbr');

    expect(openArchiveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'local', path: '/books/comic.cbr' }),
      expect.any(AbortSignal),
    );
    expect(readEntry).toHaveBeenCalledWith('entry-0', expect.any(AbortSignal));
    expect(view.state).toMatchObject({
      phase: 'ready',
      current: 1,
      total: 1,
      comicMetadata: { series: '本地系列', volume: '3', pageCount: 1 },
    });
    expect(onComicMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'local', identity: { id: 'local:/books/comic.cbr' } }),
      expect.objectContaining({ series: '本地系列', pageCount: 1 }),
    );
    await view.destroy();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('loads a remote target through its existing range source and keys progress by validator', async () => {
    const close = vi.fn(async () => undefined);
    const source = {
      size: 1024,
      identity: { id: 'item-1', validator: 'etag-1' },
      readRange: vi.fn(async () => new Uint8Array()),
      close,
    };
    const openRemoteSource = vi.fn(async () => source);
    const readBytes = vi.fn(async () => bytes('must not be read'));
    const progressStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes,
      openRemoteSource,
      parseContent: async (_path, input) => {
        expect(input).toBe(source);
        return { chapters: [{ title: 'Remote', html: '<p>remote</p>' }] };
      },
      progressStorage,
    });
    const target = {
      kind: 'remote' as const,
      itemId: 'item-1',
      resourceId: 'remote-7',
      identity: { id: 'item-1', validator: 'etag-1' },
      displayName: 'Remote Book',
      extension: 'epub',
      mimeType: 'application/epub+zip',
    };

    await view.load(target);
    expect(openRemoteSource).toHaveBeenCalledWith(target, expect.any(AbortSignal));
    expect(readBytes).not.toHaveBeenCalled();
    await view.destroy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(progressStorage.setItem).toHaveBeenCalledWith(
      `${READING_PROGRESS_KEY_PREFIX}item-1`,
      expect.any(String),
    );
  });

  it('reopens an OPDS book at the saved chapter when the server validator changes', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, 'item-1@etag-old', {
      version: 1,
      kind: 'flow',
      index: 5,
      ratio: 0,
      total: 40,
      updatedAt: 1,
    });
    saveLibraryProgressAlias(progressStorage, 'item-1', 'item-1@etag-old');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      openRemoteSource: async () => ({
        size: 1024,
        identity: { id: 'item-1', validator: 'etag-new' },
        readRange: async () => new Uint8Array(),
        close: async () => undefined,
      }),
      parseContent: async () => ({
        chapters: Array.from({ length: 40 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>${index + 1}</p>`,
        })),
      }),
      progressStorage,
    });
    await view.load({
      kind: 'remote',
      itemId: 'item-1',
      resourceId: 'remote-9',
      identity: { id: 'item-1', validator: 'etag-new' },
      displayName: 'Remote Book',
      extension: 'epub',
      mimeType: 'application/epub+zip',
    });
    await vi.advanceTimersByTimeAsync(0);
    const active = host.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
    expect(Number(active?.dataset.chapterIndex)).toBe(5);
    expect(view.state.current).toBe(6);
    expect(store[`${READING_PROGRESS_KEY_PREFIX}item-1`]).toContain('"index":5');
    await view.destroy();
  });

  it('loads a local EPUB through bounded random reads instead of copying the whole file', async () => {
    const readBytes = vi.fn(async () => bytes('must not be read'));
    const readSize = vi.fn(async () => 4096);
    const readChunk = vi.fn(async (_path: string, offset: number, length: number) =>
      new Uint8Array(length).fill(offset),
    );
    const parseContent = vi.fn(async (_path: string, input: ReaderInputSource) => {
      expect('readRange' in input).toBe(true);
      if (!('readRange' in input)) throw new Error('expected random source');
      expect(input.size).toBe(4096);
      expect(await input.readRange(12, 4)).toEqual(new Uint8Array([12, 12, 12, 12]));
      return { chapters: [{ title: 'Local', html: '<p>local</p>' }] };
    });
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes,
      readSize,
      readChunk,
      parseContent,
    });

    await view.load('/books/local.epub');

    expect(readSize).toHaveBeenCalledWith('/books/local.epub', expect.any(AbortSignal));
    expect(readChunk).toHaveBeenCalledWith(
      '/books/local.epub',
      12,
      4,
      expect.any(AbortSignal),
    );
    expect(readBytes).not.toHaveBeenCalled();
    await view.destroy();
  });

  it('loads a local CBZ through bounded random reads instead of copying the whole file', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    const readBytes = vi.fn(async () => {
      throw new Error('must not be read');
    });
    const readSize = vi.fn(async () => archive.byteLength);
    const readChunk = vi.fn(async (_path: string, offset: number, length: number) =>
      archive.slice(offset, offset + length),
    );
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes, readSize, readChunk });

    await view.load('/books/local.cbz');

    expect(readSize).toHaveBeenCalledWith('/books/local.cbz', expect.any(AbortSignal));
    expect(readChunk).toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(view.state).toMatchObject({ phase: 'ready', total: 1 });
    await view.destroy();
  });

  it('reveals the window caption while comic chrome is visible', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    const app = document.createElement('div');
    app.id = 'app';
    const host = document.createElement('div');
    app.append(host);
    document.body.append(app);
    const view = createReaderView(host, {
      readBytes: async () => {
        throw new Error('must not be read');
      },
      readSize: async () => archive.byteLength,
      readChunk: async (_path, offset, length) => archive.slice(offset, offset + length),
    });

    await view.load('/books/local.cbz');
    const pages = host.querySelector<HTMLElement>('.lightink-reader-pages');
    expect(pages?.dataset.comicChrome).toBe('visible');
    expect(app.classList.contains('is-reader-chrome-revealed')).toBe(true);
    pages!.dataset.comicChrome = 'hidden';
    await Promise.resolve();
    expect(app.classList.contains('is-reader-chrome-revealed')).toBe(false);
    const whisper = host.querySelector<HTMLElement>('.lightink-reader-chrome-whisper');
    expect(whisper?.hidden).toBe(false);
    pages!.dataset.comicChrome = 'visible';
    await Promise.resolve();
    expect(whisper?.hidden).toBe(true);
    await view.destroy();
  });

  it('saves comic page progress without hashing the archive and restores it', async () => {
    // 假时钟不能包住 load()：加载路径靠 yieldReaderLoad 的 setTimeout(0) 让出
    // 主线程，假时钟下永不触发。只在推进保存防抖时启用。
    stubComicObjectUrls();
    const zip = new ZipWriter(new Uint8ArrayWriter());
    for (const name of ['001.png', '002.png', '003.png']) {
      await zip.add(
        name,
        new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        { level: 0 },
      );
    }
    const archive = await zip.close();
    const store: Record<string, string> = {
      [COMIC_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        mode: 'paged',
        direction: 'ltr',
        spread: 'single',
        fitWidth: true,
      }),
    };
    const progressStorage: ProgressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const getContentHash = vi.fn(async () => {
      throw new Error('must not hash a comic archive');
    });
    const host = document.createElement('div');
    const first = createReaderView(host, {
      readBytes: async () => {
        throw new Error('must not be read');
      },
      readSize: async () => archive.byteLength,
      readChunk: async (_path, offset, length) => archive.slice(offset, offset + length),
      progressStorage,
      preferenceStorage: progressStorage,
      getContentHash,
      readAnnotations: async () => '',
    });

    await first.load('/comics/vol.cbz');
    expect(getContentHash).not.toHaveBeenCalled();
    vi.useFakeTimers();
    expect(first.advanceReading(1)).toBe(true);
    expect(first.advanceReading(1)).toBe(true);
    expect(first.state.current).toBe(3);
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    await first.destroy();

    const host2 = document.createElement('div');
    const second = createReaderView(host2, {
      readBytes: async () => {
        throw new Error('must not be read');
      },
      readSize: async () => archive.byteLength,
      readChunk: async (_path, offset, length) => archive.slice(offset, offset + length),
      progressStorage,
      preferenceStorage: progressStorage,
      getContentHash,
      readAnnotations: async () => '',
    });
    await second.load('/comics/vol.cbz');
    expect(getContentHash).not.toHaveBeenCalled();
    expect(second.state.current).toBe(3);
    await second.destroy();
  });

  it('hands the current progressId to the comic surface and restores page progress by identity', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(3);
    const progressStorage = memoryProgressStore();
    const getContentHash = vi.fn(async () => {
      throw new Error('must not hash a comic archive');
    });
    const hostA = document.createElement('div');
    document.body.appendChild(hostA);
    const first = createReaderView(
      hostA,
      localComicSourceDeps(archive, { progressStorage, preferenceStorage: progressStorage, getContentHash }),
    );

    await first.load('/comics/alpha.cbz');
    expect(getContentHash).not.toHaveBeenCalled();
    vi.useFakeTimers();
    expect(first.advanceReading(1)).toBe(true);
    expect(first.state.current).toBe(2);
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    clickComicStripMode(hostA);
    expect(hostA.querySelector<HTMLElement>('.lightink-reader-pages')?.dataset.comicMode).toBe('strip');
    expect(progressStorage.values[comicBookPreferencesKey('/comics/alpha.cbz')]).toContain(
      '"mode":"strip"',
    );
    expect(progressStorage.values[COMIC_PREFERENCES_STORAGE_KEY]).toBeUndefined();
    await first.destroy();
    expect(progressStorage.values[`${READING_PROGRESS_KEY_PREFIX}/comics/alpha.cbz`]).toContain(
      '"kind":"page"',
    );
    expect(progressStorage.values[`${READING_PROGRESS_KEY_PREFIX}/comics/alpha.cbz`]).toContain(
      '"index":2',
    );

    const hostB = document.createElement('div');
    document.body.appendChild(hostB);
    const other = createReaderView(
      hostB,
      localComicSourceDeps(archive, { progressStorage, preferenceStorage: progressStorage, getContentHash }),
    );
    await other.load('/comics/beta.cbz');
    expect(hostB.querySelector<HTMLElement>('.lightink-reader-pages')?.dataset.comicMode).toBe('paged');
    expect(progressStorage.values[comicBookPreferencesKey('/comics/beta.cbz')]).toBeUndefined();
    await other.destroy();

    const hostAgain = document.createElement('div');
    document.body.appendChild(hostAgain);
    const again = createReaderView(
      hostAgain,
      localComicSourceDeps(archive, { progressStorage, preferenceStorage: progressStorage, getContentHash }),
    );
    await again.load('/comics/alpha.cbz');
    expect(getContentHash).not.toHaveBeenCalled();
    expect(again.state.current).toBe(2);
    expect(hostAgain.querySelector<HTMLElement>('.lightink-reader-pages')?.dataset.comicMode).toBe(
      'strip',
    );
    await again.destroy();
  });

  it('keys remote comic preferences and page progress by itemId', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(3);
    const progressStorage = memoryProgressStore();
    const getContentHash = vi.fn(async () => {
      throw new Error('must not hash a comic archive');
    });
    const close = vi.fn(async () => undefined);
    const readRange = vi.fn(async (offset: number, length: number) =>
      archive.slice(offset, offset + length),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => {
        throw new Error('must not be read');
      },
      openRemoteSource: async () => ({
        size: archive.byteLength,
        identity: { id: 'item-cbz' },
        access: 'remote' as const,
        readRange,
        close,
      }),
      progressStorage,
      preferenceStorage: progressStorage,
      getContentHash,
      readAnnotations: async () => '',
    });

    await view.load({
      kind: 'remote',
      itemId: 'item-cbz',
      resourceId: 'remote-cbz',
      identity: { id: 'item-cbz' },
      displayName: 'Remote Comic.cbz',
      extension: 'cbz',
      mimeType: 'application/vnd.comicbook+zip',
    });
    vi.useFakeTimers();
    expect(view.advanceReading(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    clickComicStripMode(host);
    expect(progressStorage.values[comicBookPreferencesKey('item-cbz')]).toContain('"mode":"strip"');
    expect(progressStorage.values[COMIC_PREFERENCES_STORAGE_KEY]).toBeUndefined();
    await view.destroy();
    expect(getContentHash).not.toHaveBeenCalled();
    expect(progressStorage.values[`${READING_PROGRESS_KEY_PREFIX}item-cbz`]).toContain('"kind":"page"');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('inverts only ArrowLeft/ArrowRight for RTL comics', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(3);
    const progressStorage = memoryProgressStore();
    progressStorage.setItem(
      COMIC_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        mode: 'paged',
        direction: 'rtl',
        spread: 'single',
        fit: 'screen',
      }),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(
      host,
      localComicSourceDeps(archive, {
        progressStorage,
        preferenceStorage: progressStorage,
      }),
    );

    await view.load('/comics/rtl.cbz');
    expect(view.state.current).toBe(1);
    expect(view.advanceReading(-1, 'ArrowLeft')).toBe(true);
    expect(view.state.current).toBe(2);
    expect(view.advanceReading(1, 'ArrowRight')).toBe(true);
    expect(view.state.current).toBe(1);
    expect(view.advanceReading(1)).toBe(true);
    expect(view.state.current).toBe(2);
    expect(view.advanceReading(1, ' ')).toBe(true);
    expect(view.state.current).toBe(3);
    await view.destroy();
  });

  it('does not apply the comic near-black overlay to EPUB, PDF, or the editor pane', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    pdfMock.renderPdfInto.mockImplementation(async (_source, stagedHost: HTMLElement) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot';
      slot.dataset.pageIndex = '0';
      stagedHost.appendChild(slot);
      return fakePdfHandle(1, 3);
    });
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    const host = document.createElement('div');
    pane.appendChild(host);
    document.body.appendChild(pane);
    const view = createReaderView(
      host,
      localComicSourceDeps(archive, {
        parseContent: async () => ({
          chapters: [{ title: 'One', html: '<p>one</p>' }],
        }),
        getContentHash: async (path: string) => {
          if (/\.(cbz|cbr|cb7)$/i.test(path)) {
            throw new Error('must not hash a comic archive');
          }
          return 'hash-flow';
        },
        readBytes: async (path: string) => {
          if (/\.(cbz|cbr|cb7)$/i.test(path)) {
            throw new Error('must not be read');
          }
          return bytes('unused');
        },
        readSize: async (path: string) =>
          /\.(cbz|cbr|cb7)$/i.test(path) ? archive.byteLength : 4,
        readChunk: async (path: string, offset: number, length: number) => {
          if (/\.(cbz|cbr|cb7)$/i.test(path)) {
            return archive.slice(offset, offset + length);
          }
          return bytes('unused');
        },
        t: (key: MessageKey) => translate('zh-CN', key),
      }),
    );

    await view.load('/comics/vol.cbz');
    expect(host.querySelector('[data-comic-reader="true"]')).not.toBeNull();
    expect(host.querySelector('.lightink-reader')?.dataset.comicReader).toBe('true');
    expect(host.querySelector('[data-comic-canvas]')).not.toBeNull();

    await view.load('book.epub');
    expect(host.querySelector('[data-comic-reader="true"]')).toBeNull();
    expect(host.querySelector('.lightink-reader')?.getAttribute('data-comic-reader')).toBeNull();
    expect(host.querySelector('.lightink-reader-pages')?.getAttribute('data-comic-reader')).toBeNull();
    expect(host.querySelector('.lightink-reader-pages')?.getAttribute('data-comic-canvas')).toBeNull();
    expect(host.querySelector('.lightink-reader-comic-chrome')).toBeNull();
    expect(host.querySelector('[data-comic-canvas]')).toBeNull();
    expect(pane.querySelector('[data-comic-reader="true"]')).toBeNull();

    await view.load('book.pdf');
    expect(host.querySelector('[data-comic-reader="true"]')).toBeNull();
    expect(host.querySelector('.lightink-reader-comic-chrome')).toBeNull();
    expect(host.querySelector('[data-comic-canvas]')).toBeNull();
    expect(pane.querySelector('.lightink-reader-comic-overlay')).toBeNull();
    await view.destroy();
  });

  it('injects strip and four-fit labels into the live comic typography sheet', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(
      host,
      localComicSourceDeps(archive, {
        t: (key: MessageKey) => translate('zh-CN', key),
      }),
    );

    await view.load('/comics/vol.cbz');
    revealReaderChrome(host);
    const typography = chromeControlByLabel(host, '排版');
    expect(typography).toBeDefined();
    typography!.click();
    const panel = document.querySelector<HTMLElement>('[data-panel="typography"]');
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(false);
    expect(panel!.textContent).toContain('连续条');
    expect(panel!.textContent).not.toContain('竖向滚动');
    expect(panel!.textContent).toContain('适合屏幕');
    expect(panel!.textContent).toContain('适合宽度');
    expect(panel!.textContent).toContain('适合高度');
    expect(panel!.textContent).toContain('原图');
    expect(panel!.querySelectorAll('[data-type-section="comic-fit"] button')).toHaveLength(4);
    await view.destroy();
  });

  it('loads a remote CBZ through the existing range source without a full download', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    const close = vi.fn(async () => undefined);
    const readRange = vi.fn(async (offset: number, length: number) =>
      archive.slice(offset, offset + length),
    );
    const readBytes = vi.fn(async () => {
      throw new Error('must not be read');
    });
    const openRemoteSource = vi.fn(async () => ({
      size: archive.byteLength,
      identity: { id: 'item-cbz' },
      access: 'remote' as const,
      readRange,
      close,
    }));
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes, openRemoteSource });

    await view.load({
      kind: 'remote',
      itemId: 'item-cbz',
      resourceId: 'remote-cbz',
      identity: { id: 'item-cbz' },
      displayName: 'Remote Comic.cbz',
      extension: 'cbz',
      mimeType: 'application/vnd.comicbook+zip',
    });

    expect(openRemoteSource).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'remote-cbz', extension: 'cbz' }),
      expect.any(AbortSignal),
    );
    expect(readRange).toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(view.state).toMatchObject({ phase: 'ready', total: 1 });
    await view.destroy();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('publishes immutable phase, chapter, progress, and scale snapshots', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
    });
    const states: Array<typeof view.state> = [];
    const unsubscribe = view.subscribeState((state) => states.push(state));

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ phase: 'empty', current: 0, total: 0 });
    expect(Object.isFrozen(states[0])).toBe(true);

    const loading = view.load('book.epub');
    expect(view.state.phase).toBe('loading');
    await loading;
    expect(view.state).toMatchObject({
      phase: 'ready',
      current: 1,
      total: 2,
      scale: 1,
      locationKind: 'chapter',
    });
    expect(host.querySelector<HTMLElement>('.lightink-reader-status')?.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>('.lightink-reader-load-track')?.hidden).toBe(true);
    useReaderScrollLayout(host);

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapters = scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockReturnValue({ top: -400 } as DOMRect);
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 250 });
    scroll.scrollTop = 375;
    scroll.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(view.state).toMatchObject({ current: 2, total: 2, progress: 0.5 });
    expect(states.some((state) => state.phase === 'loading')).toBe(true);
    unsubscribe();
    const countBeforeDestroy = states.length;
    await view.destroy();
    expect(states).toHaveLength(countBeforeDestroy);
  });

  it('coalesces same-frame scroll bursts into a single chapter/progress update', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
      progressStorage: null,
    });
    await view.load('coalesce.epub');
    useReaderScrollLayout(host);

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapters = scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter');
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 250 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockReturnValue({ top: -400 } as DOMRect);
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue({ top: 10 } as DOMRect);

    const states: Array<typeof view.state> = [];
    const unsubscribe = view.subscribeState((state) => states.push(state));
    expect(states).toHaveLength(1);
    scroll.scrollTop = 375;
    scroll.dispatchEvent(new Event('scroll'));
    scroll.dispatchEvent(new Event('scroll'));
    scroll.dispatchEvent(new Event('scroll'));
    await nextFrame();

    // 帧内连发 3 次滚动事件只在帧回调里同步一次：章节指示与进度单次单调更新。
    expect(states).toHaveLength(2);
    expect(states[1]).toMatchObject({ current: 2, total: 2, progress: 0.5 });
    unsubscribe();
    await view.destroy();
  });

  it('lets the newest load win when byte reads resolve out of order', async () => {
    const pendingA = deferred<Uint8Array>();
    const pendingB = deferred<Uint8Array>();
    const signals = new Map<string, AbortSignal | undefined>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: (path, signal) => {
        signals.set(path, signal);
        return path === 'a.txt' ? pendingA.promise : pendingB.promise;
      },
    });

    const loadA = view.load('a.txt');
    const loadB = view.load('b.txt');
    expect(signals.get('a.txt')?.aborted).toBe(true);
    expect(host.querySelector<HTMLElement>('.lightink-reader-status')?.textContent).toBe(
      'reader.loading',
    );
    const loadTrack = host.querySelector<HTMLElement>('.lightink-reader-load-track');
    expect(loadTrack).not.toBeNull();
    expect(loadTrack?.hidden).toBe(false);

    pendingB.resolve(bytes('new document'));
    await loadB;
    expect(frameSource(host)).toContain('new document');
    expect(host.querySelector('.lightink-reader')?.getAttribute('aria-busy')).toBe('false');

    pendingA.resolve(bytes('stale document'));
    await loadA;
    expect(frameSource(host)).toContain('new document');
    expect(frameSource(host)).not.toContain('stale document');
  });

  it('does not commit annotation results from a superseded document', async () => {
    const hashA = deferred<string>();
    const hashB = deferred<string>();
    const hashAStarted = deferred<void>();
    const hashBStarted = deferred<void>();
    const readAnnotations = vi.fn(async () => '{"version":1,"annotations":[]}');
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async (path) => bytes(path),
      getContentHash: (path) => {
        if (path === 'a.txt') {
          hashAStarted.resolve();
          return hashA.promise;
        }
        hashBStarted.resolve();
        return hashB.promise;
      },
      readAnnotations,
    });

    const loadA = view.load('a.txt');
    await hashAStarted.promise;
    const loadB = view.load('b.txt');
    await hashBStarted.promise;
    hashB.resolve('bbbbbbbbbbbbbbbb');
    await loadB;
    hashA.resolve('aaaaaaaaaaaaaaaa');
    await loadA;

    expect(readAnnotations).toHaveBeenCalledTimes(1);
    expect(readAnnotations).toHaveBeenCalledWith('bbbbbbbbbbbbbbbb');
    expect(frameSource(host)).toContain('b.txt');
  });

  it('treats a failed annotation read as empty and does not notify', async () => {
    const notify = vi.fn();
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => bytes('hello'),
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => {
        throw new Error('IPC unavailable');
      },
      notify,
    });
    await view.load('book.txt');
    expect(notify).not.toHaveBeenCalled();
    await view.destroy();
  });

  it('aborts pending work and prevents callbacks after destroy', async () => {
    const pending = deferred<Uint8Array>();
    let loadSignal: AbortSignal | undefined;
    const getContentHash = vi.fn(async () => 'aaaaaaaaaaaaaaaa');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async (_path, signal) => {
        loadSignal = signal;
        return pending.promise;
      },
      getContentHash,
      readAnnotations: async () => '',
    });

    const load = view.load('book.txt');
    await view.destroy();
    expect(loadSignal?.aborted).toBe(true);
    expect(host.children).toHaveLength(0);

    pending.resolve(bytes('late content'));
    await load;
    expect(getContentHash).not.toHaveBeenCalled();
    expect(host.children).toHaveLength(0);
  });

  it('exposes caller cancellation without treating it as a load failure', async () => {
    const pending = deferred<Uint8Array>();
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes: async () => pending.promise });
    const controller = new AbortController();

    const load = view.load('book.txt', { signal: controller.signal });
    controller.abort();
    pending.resolve(bytes('ignored'));
    await expect(load).resolves.toBeUndefined();

    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    expect(root.dataset.readerState).toBe('cancelled');
    expect(root.getAttribute('aria-busy')).toBe('false');
  });

  it('renders flow content in a same-origin, script-disabled sandbox', async () => {
    const host = document.createElement('div');
    const view = createReaderView(host, { readBytes: async () => bytes('safe text') });
    await view.load('book.txt');

    const frame = host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(frame.referrerPolicy).toBe('no-referrer');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain('safe text');
  });

  it('inlines sanitized publisher CSS before reader chrome styles', async () => {
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: '插图', html: '<p class="illust">图</p>' }],
        stylesheet:
          '@import url("https://evil.example/x.css"); p { text-indent: 2em; } body { position: fixed; }',
      }),
    });
    await view.load('book.epub');

    const srcdoc = frameSource(host);
    expect(srcdoc).toContain('p { text-indent: 2em; }');
    expect(srcdoc).toContain('position: static');
    expect(srcdoc).not.toMatch(/@import|evil\.example/i);
    expect(srcdoc.indexOf('text-indent: 2em')).toBeLessThan(
      srcdoc.indexOf('column-fill: auto'),
    );
  });

  it('opens the annotation sidebar search for flow documents and lists snippets', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>alpha keyword</p>' },
          { title: 'Two', html: '<p>keyword again</p>' },
        ],
      }),
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }

    view.openSearch?.('keyword');
    expect(host.querySelector('.lightink-reader-search-panel')).toBeNull();
    const sidebar = host.querySelector<HTMLElement>('.lightink-reader-sidebar')!;
    expect(sidebar.hidden).toBe(false);
    expect(sidebar.querySelector('.lightink-replace-input')).toBeNull();
    expect(
      sidebar.querySelector<HTMLInputElement>('.lightink-reader-sidebar-note-search-input')?.value,
    ).toBe('keyword');
    expect(sidebar.classList.contains('is-searching')).toBe(true);
    expect(sidebar.querySelector('.lightink-reader-sidebar-empty')).toBeNull();
    expect(sidebar.querySelector('.lightink-reader-sidebar-more')).toBeNull();
    await vi.waitFor(() => {
      expect(sidebar.querySelector('[data-search-key]')).not.toBeNull();
    });
    expect(sidebar.querySelector('.lightink-reader-sidebar-search-status')?.textContent).toBeTruthy();

    document.documentElement.dataset.readingLayout = 'paginated';
    document.documentElement.dataset.readingLayout = 'scroll';
    expect(sidebar.hidden).toBe(false);
    expect(
      sidebar.querySelector<HTMLInputElement>('.lightink-reader-sidebar-note-search-input')?.value,
    ).toBe('keyword');

    sidebar.querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')!.click();
    expect(sidebar.hidden).toBe(true);
    expect(
      sidebar.querySelector<HTMLInputElement>('.lightink-reader-sidebar-note-search-input')?.value,
    ).toBe('');
    expect(sidebar.classList.contains('is-searching')).toBe(false);
    await view.destroy();
  });

  it('opens the touch search sheet from openSearch without forcing the annotation sidebar', async () => {
    // 触屏旗标（R5）：openSearch 走独立底栏搜索层，不再强制打开标注侧栏。
    document.documentElement.setAttribute('data-touch-primary', '');
    const onReturnToShelf = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>alpha keyword</p>' },
          { title: 'Two', html: '<p>keyword again</p>' },
        ],
      }),
      onReturnToShelf,
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }

    view.openSearch?.('keyword');

    expect(view.isSidebarVisible()).toBe(false);
    const sidebar = host.querySelector<HTMLElement>('.lightink-reader-sidebar');
    expect(sidebar?.hidden ?? true).toBe(true);
    const visibleSheets = (): HTMLElement[] =>
      [...document.querySelectorAll<HTMLElement>('.is-touch-sheet')].filter(
        (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
      );
    const sheet = visibleSheets()[0];
    expect(sheet).not.toBeUndefined();
    // 选区/入参 seed 预填进搜索层查询框。
    expect(sheet!.querySelector<HTMLInputElement>('input')?.value).toBe('keyword');

    // Escape（Android 系统返回经 back-navigation 合成同键）一次只关搜索层，不合书。
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(visibleSheets()).toHaveLength(0);
    expect(view.isSidebarVisible()).toBe(false);
    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
    await view.destroy();
  });

  it('keeps the touch search sheet and annotation sheet mutually exclusive', async () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: 'One', html: '<p>alpha keyword</p>' }],
      }),
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }

    const visibleSheets = (): HTMLElement[] =>
      [...document.querySelectorAll<HTMLElement>('.is-touch-sheet')].filter(
        (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
      );

    view.toggleSidebar();
    expect(view.isSidebarVisible()).toBe(true);
    expect(
      visibleSheets().some((el) => el.classList.contains('lightink-reader-sidebar')),
    ).toBe(true);

    view.openSearch?.('keyword');
    expect(view.isSidebarVisible()).toBe(false);
    const afterSearch = visibleSheets();
    expect(afterSearch).toHaveLength(1);
    expect(afterSearch[0]!.classList.contains('lightink-reader-search-sheet')).toBe(true);
    expect(afterSearch[0]!.querySelector('input')?.value).toBe('keyword');

    view.toggleSidebar();
    expect(view.isSidebarVisible()).toBe(true);
    const afterNotes = visibleSheets();
    expect(afterNotes).toHaveLength(1);
    expect(afterNotes[0]!.classList.contains('lightink-reader-sidebar')).toBe(true);
    expect(
      afterNotes.some((el) => el.classList.contains('lightink-reader-search-sheet')),
    ).toBe(false);

    await view.destroy();
  });

  it('closes a portaled touch annotation sheet from × and a page tap', async () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: 'One', html: '<p>alpha</p>' }],
      }),
    });
    await view.load('book.epub');
    revealReaderChrome(host);

    view.toggleSidebar();
    const sidebar = document.querySelector<HTMLElement>('.lightink-reader-sidebar')!;
    expect(view.isSidebarVisible()).toBe(true);
    expect(sidebar.hidden).toBe(false);
    expect(sidebar.parentElement).toBe(document.body);

    sidebar.querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')!.click();
    expect(view.isSidebarVisible()).toBe(false);
    expect(sidebar.hidden).toBe(true);

    view.toggleSidebar();
    expect(view.isSidebarVisible()).toBe(true);
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(view.isSidebarVisible()).toBe(false);
    expect(sidebar.hidden).toBe(true);

    await view.destroy();
  });

  it('saves flow progress on scroll and restores it on the next open', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const chapters = [
      { title: 'One', html: '<p>one</p>' },
      { title: 'Two', html: '<p>two</p>' },
    ];
    const layout = { scrollTop: 1200, clientHeight: 400, chapterHeight: 800 };
    const expectedTop = chapterScrollTop(layout.chapterHeight, layout.chapterHeight, 0.5);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const first = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters }),
      progressStorage,
    });
    await first.load('resume.epub');
    useReaderScrollLayout(host);

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, layout);
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(400);
    await first.destroy();

    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const second = createReaderView(host2, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters }),
      progressStorage,
    });
    useReaderScrollLayout(host2);
    await second.load('resume.epub');
    const restored = host2.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const restoredChapters = [...restored.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(restored, restoredChapters, { ...layout, scrollTop: 0 });
    second.restoreReadingProgress?.();
    expect(restored.scrollTop).toBe(expectedTop);
    await second.destroy();
  });

  it('does not consume scroll progress before chapter height is ready', async () => {
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, 'resume-wait.epub', {
      version: 1,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
      updatedAt: 1,
    });
    const chapters = [
      { title: 'One', html: '<p>one</p>' },
      { title: 'Two', html: '<p>two</p>' },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters }),
      progressStorage,
    });
    useReaderScrollLayout(host);
    await view.load('resume-wait.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1600 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    for (const chapter of chapterEls) {
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 0 });
    }
    view.restoreReadingProgress?.();
    expect(scroll.scrollTop).toBe(0);

    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 0,
      clientHeight: 400,
      chapterHeight: 800,
    });
    view.restoreReadingProgress?.();
    expect(scroll.scrollTop).toBe(chapterScrollTop(800, 800, 0.5));
    await view.destroy();
  });

  it('migrates a path-keyed local progress record onto the content hash', async () => {
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, '/books/legacy.epub', {
      version: 1,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
      total: 2,
      updatedAt: 1,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
      progressStorage,
      getContentHash: async () => '0123456789abcdef',
      readAnnotations: async () => '{"version":1,"annotations":[]}',
    });
    useReaderScrollLayout(host);
    await view.load('/books/legacy.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 0,
      clientHeight: 400,
      chapterHeight: 800,
    });
    view.restoreReadingProgress?.();
    expect(scroll.scrollTop).toBe(chapterScrollTop(800, 800, 0.5));
    expect(loadReadingProgress(progressStorage, '0123456789abcdef')).toMatchObject({
      kind: 'flow',
      index: 1,
      ratio: 0.5,
    });
    await view.destroy();
  });

  it('restores local progress through a shelf alias when the hash key is empty', async () => {
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, '/old/name.epub', {
      version: 1,
      kind: 'flow',
      index: 1,
      ratio: 0.25,
      total: 2,
      updatedAt: 1,
    });
    saveLibraryProgressAlias(progressStorage, 'local:/books/renamed.epub', '/old/name.epub');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
      progressStorage,
      getContentHash: async () => 'fedcba9876543210',
      readAnnotations: async () => '{"version":1,"annotations":[]}',
    });
    useReaderScrollLayout(host);
    await view.load('/books/renamed.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 0,
      clientHeight: 400,
      chapterHeight: 800,
    });
    view.restoreReadingProgress?.();
    expect(scroll.scrollTop).toBe(chapterScrollTop(800, 800, 0.25));
    expect(loadReadingProgress(progressStorage, 'fedcba9876543210')).toMatchObject({
      kind: 'flow',
      index: 1,
      ratio: 0.25,
    });
    await view.destroy();
  });

  it('restores scroll progress onto the editor pane, not the inner chapter host', async () => {
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, 'resume-pane.epub', {
      version: 1,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
      updatedAt: 1,
    });
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    document.body.appendChild(pane);
    const host = document.createElement('div');
    pane.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
      progressStorage,
    });
    useReaderScrollLayout(host);
    await view.load('resume-pane.epub');
    const inner = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...host.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(pane, chapterEls, {
      scrollTop: 0,
      clientHeight: 400,
      chapterHeight: 800,
    });
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 1600 });
    Object.defineProperty(inner, 'clientHeight', { configurable: true, value: 400 });
    inner.scrollTop = 0;
    view.restoreReadingProgress?.();
    expect(pane.scrollTop).toBe(chapterScrollTop(800, 800, 0.5));
    expect(inner.scrollTop).toBe(0);
    await view.destroy();
  });

  it('exposes a visible failure state for real load errors', async () => {
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => {
        throw new Error('disk read failed');
      },
    });

    await expect(view.load('book.txt')).rejects.toThrow('disk read failed');
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    expect(root.dataset.readerState).toBe('error');
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelector<HTMLElement>('.lightink-reader-status')?.textContent).toBe(
      'reader.failed',
    );
  });

  it('does not commit an empty PDF page host when renderPdfInto fails', async () => {
    pdfMock.renderPdfInto.mockRejectedValue(new Error('PDF 文件损坏或无法解析'));
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });

    await expect(view.load('broken.pdf')).rejects.toThrow('PDF 文件损坏或无法解析');
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    const pageHost = host.querySelector<HTMLElement>('.lightink-reader-pages');
    expect(root.dataset.readerState).toBe('error');
    expect(pageHost?.hidden).toBe(true);
    expect(pageHost?.dataset.readerActive).toBeUndefined();
    expect(pageHost?.querySelector('canvas')).toBeNull();
  });

  it('disposes parser-owned resources on replacement and destroy', async () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async (path) => ({
        chapters: [{ title: path, html: `<p>${path}</p>` }],
        dispose: path === 'a.epub' ? disposeA : disposeB,
      }),
    });

    await view.load('a.epub');
    expect(disposeA).not.toHaveBeenCalled();
    await view.load('b.epub');
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    await view.destroy();
    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it('closes the annotation drawer from its backdrop, button, and Escape', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const onReturnToShelf = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps({ onReturnToShelf }));
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;

    view.toggleSidebar();
    const sidebar = root.querySelector<HTMLElement>('.lightink-reader-sidebar')!;
    const backdrop = root.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-backdrop',
    )!;
    const close = sidebar.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-close',
    )!;
    expect(view.isSidebarVisible()).toBe(true);
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');
    expect(backdrop.hidden).toBe(false);
    expect(backdrop.tabIndex).toBe(-1);
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(close.getAttribute('aria-label')).toBe('annotation.closeSidebar');
    expect(document.activeElement).toBe(close);

    backdrop.click();
    expect(view.isSidebarVisible()).toBe(false);
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop.hidden).toBe(true);
    expect(document.activeElement).toBe(root);

    view.toggleSidebar();
    close.click();
    expect(view.isSidebarVisible()).toBe(false);

    view.toggleSidebar();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.isSidebarVisible()).toBe(false);
    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
  });
});

describe('Reader immersive chrome lifecycle', () => {
  it('opens a book without editor menus or tabs, then reveals four labeled overlay controls on a page click', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps());
    await view.load('book.epub');

    expect(host.querySelector('.lightink-menu-bar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    expect(host.querySelector('#lightink-tabs-host')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('.lightink-tab')).toBeNull();

    const chrome = readerChrome(host);
    expect(chrome).not.toBeNull();
    expect(isReaderChromeRevealed(host)).toBe(false);

    revealReaderChrome(host);
    expect(isReaderChromeRevealed(host)).toBe(true);
    const labels = chromeControls(host).map((el) => (el.textContent ?? '').trim());
    for (const label of READER_CHROME_LABELS) {
      expect(labels.some((text) => text.includes(label))).toBe(true);
    }
    expect(chromeControlByLabel(host, '返回书架')?.textContent).toContain('返回书架');
    await view.destroy();
  });

  it('keeps the reading pane height stable because chrome overlays the page instead of sitting in the scroll host', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps());
    await view.load('book.epub');

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const pages = host.querySelector<HTMLElement>('.lightink-reader-pages');
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 640 });
    const heightBefore = scroll.clientHeight;
    const scrollKids = scroll.childElementCount;

    revealReaderChrome(host);
    const chrome = readerChrome(host);
    expect(chrome).not.toBeNull();
    expect(isReaderChromeRevealed(host)).toBe(true);
    expect(scroll.contains(chrome)).toBe(false);
    expect(pages?.contains(chrome) ?? false).toBe(false);
    expect(scroll.childElementCount).toBe(scrollKids);
    expect(scroll.clientHeight).toBe(heightBefore);

    chrome!.hidden = true;
    expect(scroll.childElementCount).toBe(scrollKids);
    expect(scroll.clientHeight).toBe(heightBefore);
    await view.destroy();
  });

  it('returns to the shelf from 返回书架 without closing the window or destroying the reader', async () => {
    const onReturnToShelf = vi.fn();
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps({ onReturnToShelf }));
    await view.load('book.epub');

    revealReaderChrome(host);
    chromeControlByLabel(host, '返回书架')!.click();

    expect(onReturnToShelf).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
    closeWindow.mockRestore();
    await view.destroy();
  });

  it('lets Escape close the annotation overlay first, then return to the shelf only when no overlay remains', async () => {
    const onReturnToShelf = vi.fn();
    const closeWindow = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps({ onReturnToShelf }));
    await view.load('book.epub');
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;

    revealReaderChrome(host);
    chromeControlByLabel(host, '本书标注')!.click();
    expect(view.isSidebarVisible()).toBe(true);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.isSidebarVisible()).toBe(false);
    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();

    if (isReaderChromeRevealed(host)) {
      root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(isReaderChromeRevealed(host)).toBe(false);
      expect(onReturnToShelf).not.toHaveBeenCalled();
    }

    // 无浮层 Esc 不合书：阅读器只退一步；窗口级 leftover Esc 才 returnToShelf。
    const leftover = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    root.dispatchEvent(leftover);
    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(leftover.defaultPrevented).toBe(false);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
    closeWindow.mockRestore();
    await view.destroy();
  });

  it('reveals chrome from a single PDF page click instead of reveal-then-dismiss', async () => {
    pdfMock.renderPdfInto.mockImplementation(async (_source, stagedHost: HTMLElement) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot';
      slot.dataset.pageIndex = '0';
      slot.textContent = 'page body';
      stagedHost.appendChild(slot);
      return fakePdfHandle(1, 3);
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });
    await view.load('book.pdf');

    expect(isReaderChromeRevealed(host)).toBe(false);
    const page = host.querySelector<HTMLElement>('.lightink-reader-page-slot')!;
    page.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(isReaderChromeRevealed(host)).toBe(true);
    expect(chromeControlByLabel(host, '返回书架')?.textContent).toContain('返回书架');
    await view.destroy();
  });

  it('forwards leftover flow-frame Escape to the parent document for window-level 合书', async () => {
    const onReturnToShelf = vi.fn();
    const parentEscapes: KeyboardEvent[] = [];
    const onParentKey = (event: Event): void => {
      if ((event as KeyboardEvent).key === 'Escape') {
        parentEscapes.push(event as KeyboardEvent);
      }
    };
    document.addEventListener('keydown', onParentKey);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, readerViewDeps({ onReturnToShelf }));
    await view.load('book.epub');

    const frame = host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame');
    expect(frame).not.toBeNull();
    if (frame!.dataset.frameReady !== 'true') {
      await new Promise<void>((resolve) => {
        frame!.addEventListener('load', () => resolve(), { once: true });
      });
    }
    const frameDocument = frame!.contentDocument;
    expect(frameDocument).not.toBeNull();

    const leftover = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    frameDocument!.dispatchEvent(leftover);

    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(parentEscapes.length).toBeGreaterThan(0);
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
    document.removeEventListener('keydown', onParentKey);
    await view.destroy();
  });
});

describe('Reader R7 memory regressions', () => {
  it('same-tab PDF→flow switch leaves no stale page-scroll listener zeroing reading state', async () => {
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    document.body.appendChild(pane);
    const host = document.createElement('div');
    pane.appendChild(host);
    const handles: Array<ReturnType<typeof fakePdfHandle>> = [];
    pdfMock.renderPdfInto.mockImplementation(async () => {
      const handle = fakePdfHandle();
      handles.push(handle);
      return handle;
    });
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [
          { title: 'One', html: '<p>one</p>' },
          { title: 'Two', html: '<p>two</p>' },
        ],
      }),
      progressStorage: null,
    });

    await view.load('doc.pdf');
    expect(view.state).toMatchObject({ phase: 'ready', current: 3, total: 10, locationKind: 'page' });

    await view.load('switch-to-flow.epub');
    expect(view.state).toMatchObject({ phase: 'ready', total: 2, locationKind: 'chapter' });
    expect(handles[0]!.destroy).toHaveBeenCalledTimes(1);

    // 共享 pane 滚动：残留的 schedulePageScroll 会走 onPageScroll→syncPageState
    // 发布清零快照（current:0, total:0, locationKind:null），章节/进度指示闪烁
    // 甚至被定格（rAF 回调序不确定）。修复后订阅者不应看到任何清零快照。
    const seen: Array<typeof view.state> = [];
    const unsubscribe = view.subscribeState((state) => seen.push(state));
    pane.dispatchEvent(new Event('scroll'));
    await nextFrame();
    unsubscribe();
    expect(seen.length).toBeGreaterThan(0);
    for (const state of seen) {
      expect(state).toMatchObject({ total: 2, locationKind: 'chapter' });
      expect(state.current).toBeGreaterThanOrEqual(1);
    }
    expect(view.state).toMatchObject({ current: 1, total: 2, locationKind: 'chapter' });
    await view.destroy();
  });

  it('repeated same-tab format switches dispose prior handles and keep state consistent', async () => {
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    document.body.appendChild(pane);
    const host = document.createElement('div');
    pane.appendChild(host);
    const handles: Array<ReturnType<typeof fakePdfHandle>> = [];
    pdfMock.renderPdfInto.mockImplementation(async () => {
      const handle = fakePdfHandle();
      handles.push(handle);
      return handle;
    });
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: 'One', html: '<p>one</p>' }],
      }),
    });

    // 反复 PDF→流式切换：每个被替换的 PDF 句柄都必须销毁（无累积），
    // 且最终滚动后订阅者看不到任何清零快照（残留监听器会累积并抢发页状态）。
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await view.load(`doc-${cycle}.pdf`);
      await view.load(`book-${cycle}.epub`);
    }
    expect(handles).toHaveLength(5);
    for (const handle of handles) {
      expect(handle.destroy).toHaveBeenCalledTimes(1);
    }
    const seen: Array<typeof view.state> = [];
    const unsubscribe = view.subscribeState((state) => seen.push(state));
    pane.dispatchEvent(new Event('scroll'));
    await nextFrame();
    unsubscribe();
    for (const state of seen) {
      expect(state).toMatchObject({ total: 1, locationKind: 'chapter' });
      expect(state.current).toBeGreaterThanOrEqual(1);
    }
    expect(view.state).toMatchObject({ current: 1, total: 1, locationKind: 'chapter' });
    await view.destroy();
  });

  it('window-level scroll paging uses the editor pane, not the inner chapter host', async () => {
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    document.body.appendChild(pane);
    const host = document.createElement('div');
    pane.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: 'One', html: '<p>one</p>' }],
      }),
    });
    await view.load('book.epub');
    document.documentElement.dataset.readingLayout = 'scroll';
    useReaderScrollLayout(host);

    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 400 });
    pane.scrollTop = 0;
    const inner = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    Object.defineProperty(inner, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(inner, 'clientHeight', { configurable: true, value: 400 });
    inner.scrollTop = 0;

    expect(view.advanceReading(1)).toBe(true);
    expect(pane.scrollTop).toBe(400);
    expect(inner.scrollTop).toBe(0);
    await view.destroy();
    delete document.documentElement.dataset.readingLayout;
  });

  it('evicts least-recently-used reading progress beyond the entry cap', () => {
    const map = new Map<string, string>();
    const storage: ProgressStorage = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
      key: (index) => Array.from(map.keys())[index] ?? null,
      get length() {
        return map.size;
      },
    };
    const progress = (updatedAt: number): ReadingProgress => ({
      version: 1,
      kind: 'flow',
      index: 0,
      ratio: 0,
      updatedAt,
    });
    for (let i = 0; i < READING_PROGRESS_MAX_ENTRIES + 5; i += 1) {
      saveReadingProgress(storage, `book-${i}`, progress(i + 1));
    }
    const remaining = Array.from(map.keys()).filter((key) =>
      key.startsWith(READING_PROGRESS_KEY_PREFIX),
    );
    expect(remaining).toHaveLength(READING_PROGRESS_MAX_ENTRIES);
    // 最旧 5 条被淘汰，其余按最近使用保留。
    expect(loadReadingProgress(storage, 'book-0')).toBeNull();
    expect(loadReadingProgress(storage, 'book-4')).toBeNull();
    expect(loadReadingProgress(storage, 'book-5')).not.toBeNull();
    expect(loadReadingProgress(storage, `book-${READING_PROGRESS_MAX_ENTRIES + 4}`)).not.toBeNull();
  });

  it('caps session remote image consent and evicts the oldest grant', () => {
    const policy = new SessionRemoteImagePolicy();
    const url = (n: number): string => `https://img.example/p${n}.png`;
    for (let n = 0; n < REMOTE_IMAGE_CONSENT_LIMIT + 10; n += 1) {
      expect(policy.allowOnce(url(n))).not.toBeNull();
    }
    // 最早 10 条授权被淘汰，其余保留。
    expect(policy.isAllowed(url(0))).toBe(false);
    expect(policy.isAllowed(url(9))).toBe(false);
    expect(policy.isAllowed(url(10))).toBe(true);
    expect(policy.isAllowed(url(REMOTE_IMAGE_CONSENT_LIMIT + 9))).toBe(true);
  });
});
