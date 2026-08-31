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
  parseReadingProgress,
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
import { readerPagedScroller } from '../flow-renderer.js';
import { READER_FLOW_LAYOUT_STORAGE_KEY } from '../reader-layout.js';
import {
  FLOW_RESTORE_MAX_ATTEMPTS,
  PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS,
} from '../session/session-progress.js';

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
      bottom: (index + 1) * chapterHeight - scrollTop,
    } as DOMRect);
  });
}

function frameSource(host: HTMLElement): string {
  return host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')?.srcdoc ?? '';
}

/** T3：读书页浮层四项均带文字，退出文案必须是「返回书架」。 */
const READER_CHROME_LABELS = ['返回书架', '目录', '排版', '搜索'] as const;

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
    搜索: ['search'],
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
      version: 2,
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
    expect(whisper?.hidden).toBe(true);
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
    expect(host.getAttribute('data-page-anim')).toBeNull();
    expect(host.querySelector('[data-page-anim]')).toBeNull();
    expect(view.adjustDisplayScale?.('in')).toBe(true);
    expect(view.adjustDisplayScale?.('reset')).toBe(true);
    await view.destroy();
  });

  it('slides comic paged slots in on touch and keeps strip mode instant', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(3);
    const progressStorage = memoryProgressStore();
    progressStorage.setItem(
      COMIC_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        mode: 'paged',
        direction: 'ltr',
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

    await view.load('/comics/touch-slide.cbz');
    expect(host.querySelectorAll('.lightink-comic-slot-slide-next, .lightink-comic-slot-slide-prev')).toHaveLength(0);
    // T2：触屏（html[data-touch-primary]）翻页时进入 slot 播放滑入；加载后置位，
    // 避免影响装载期偏好判定（spread 等）。
    document.documentElement.setAttribute('data-touch-primary', '');
    try {
      expect(view.advanceReading(1)).toBe(true);
      const sliding = host.querySelectorAll('.lightink-comic-slot-slide-next');
      expect(sliding.length).toBeGreaterThan(0);
      // 宿主 data-page-anim 语义保留：漫画会话不播宿主翻页动画。
      expect(host.querySelector('[data-page-anim]')).toBeNull();
      // 等滑入类清理超时（200ms + 60ms 兜底）落地后再切模式。
      await new Promise((resolve) => setTimeout(resolve, 320));
      expect(host.querySelectorAll('.lightink-comic-slot-slide-next, .lightink-comic-slot-slide-prev')).toHaveLength(0);
      // strip 模式不 slide（原生滚动）。
      clickComicStripMode(host);
      expect(host.querySelectorAll('.lightink-comic-slot-slide-next, .lightink-comic-slot-slide-prev')).toHaveLength(0);
      expect(view.advanceReading(1)).toBe(true);
      expect(host.querySelectorAll('.lightink-comic-slot-slide-next, .lightink-comic-slot-slide-prev')).toHaveLength(0);
      await view.destroy();
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
    }
  });

  it('slides rtl comic pages in from the left on forward turns', async () => {
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

    await view.load('/comics/rtl-slide.cbz');
    document.documentElement.setAttribute('data-touch-primary', '');
    try {
      // rtl 前进：视觉来向反转，进入 slot 应挂 slide-prev（而非 slide-next）。
      expect(view.advanceReading(1)).toBe(true);
      expect(host.querySelectorAll('.lightink-comic-slot-slide-prev').length).toBeGreaterThan(0);
      expect(host.querySelectorAll('.lightink-comic-slot-slide-next')).toHaveLength(0);
      await view.destroy();
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
    }
  });

  it('hard-lands non-consecutive comic jumps without a slide class', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(5);
    const progressStorage = memoryProgressStore();
    progressStorage.setItem(
      COMIC_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        mode: 'paged',
        direction: 'ltr',
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

    await view.load('/comics/jump.cbz');
    document.documentElement.setAttribute('data-touch-primary', '');
    try {
      // 进度滑杆跳页（scrollToIndex 入口）：非连续跳转=硬落位，不播方向性滑入
      // （FB2：与 flow 侧「跳转=硬落位」口径一致）。
      const slider = host.querySelector<HTMLInputElement>('.lightink-reader-comic-slider')!;
      slider.value = '4';
      slider.dispatchEvent(new Event('input'));
      expect(view.state.current).toBe(4);
      expect(
        host.querySelectorAll('.lightink-comic-slot-slide-next, .lightink-comic-slot-slide-prev'),
      ).toHaveLength(0);
      // 相邻翻页（advancePage 路径）仍保留滑入。
      expect(view.advanceReading(1)).toBe(true);
      expect(host.querySelectorAll('.lightink-comic-slot-slide-next').length).toBeGreaterThan(0);
      await view.destroy();
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
    }
  });

  it('reads prefers-reduced-motion through a bound matchMedia on touch paged flow', async () => {
    // FB1（P0）：pagedTouchSlideMotion 曾把 matchMedia 裸引用解绑后调用——真浏览器
    // 抛 TypeError: Illegal invocation，触屏分栏翻页在写入 scrollLeft 前整体失效；
    // jsdom 无 matchMedia 使旧测试无法暴露。这里把 matchMedia stub 成「解绑调用即
    // 抛错」的形态（与 reader-progress-ui.ts 的 bind(globalThis) 修复对锁）。
    let reduceMotion = false;
    vi.stubGlobal(
      'matchMedia',
      function (this: unknown, query: string) {
        if (this !== globalThis) {
          throw new TypeError('Illegal invocation');
        }
        return { matches: reduceMotion && query === '(prefers-reduced-motion: reduce)' };
      },
    );
    const preference: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
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
      preferenceStorage: {
        getItem: (key) => preference[key] ?? null,
        setItem: (key, value) => {
          preference[key] = value;
        },
      },
    });
    await view.load('reduce.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await nextFrame();
    document.documentElement.setAttribute('data-touch-primary', '');
    try {
      const reader = host.querySelector<HTMLElement>('.lightink-reader')!;
      // 非 reduce：绑定调用不抛 Illegal invocation，边界回弹照常落位
      // （pagedTouchSlideMotion slide 生效路径全程经过该 matchMedia）。
      expect(view.advanceReading(-1)).toBe(false);
      expect(reader.getAttribute('data-page-boundary')).toBe('prev');
      reader.removeAttribute('data-page-boundary');
      // reduce：同一绑定调用返回 matches=true → 短路（无 slide、无回弹）。
      reduceMotion = true;
      expect(view.advanceReading(-1)).toBe(false);
      expect(reader.getAttribute('data-page-boundary')).toBeNull();
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
    }
    await view.destroy();
  });

  it('bounces the active chapter at a flow boundary on touch paginated flow', async () => {
    const preference: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
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
      preferenceStorage: {
        getItem: (key) => preference[key] ?? null,
        setItem: (key, value) => {
          preference[key] = value;
        },
      },
    });
    await view.load('boundary.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await nextFrame();
    document.documentElement.setAttribute('data-touch-primary', '');
    try {
      // 首章第一页向前：advanceFlowPage 边界 false → 触屏章界回弹。
      expect(view.advanceReading(-1)).toBe(false);
      expect(
        host.querySelector('.lightink-reader')?.getAttribute('data-page-boundary'),
      ).toBe('prev');
      // flow 会话的宿主翻页动画在 moved=false 时不播（语义保留）。
      expect(host.querySelector('[data-page-anim]')).toBeNull();
    } finally {
      document.documentElement.removeAttribute('data-touch-primary');
    }
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
    expect(host.querySelector('.lightink-reader')?.getAttribute('data-comic-reader')).toBe('true');
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

  it('dismisses novel chrome when opening a comic after a text book', async () => {
    stubComicObjectUrls();
    const archive = await buildTinyCbz();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(
      host,
      localComicSourceDeps(archive, {
        parseContent: async () => ({
          chapters: [{ title: 'One', html: '<p>one</p>' }],
        }),
        t: (key: MessageKey) => translate('zh-CN', key),
      }),
    );

    await view.load('book.txt');
    revealReaderChrome(host);
    expect(isReaderChromeRevealed(host)).toBe(true);

    await view.load('/comics/vol.cbz');
    expect(isReaderChromeRevealed(host)).toBe(false);
    expect(host.querySelector('.lightink-reader')?.getAttribute('data-comic-reader')).toBe('true');
    expect(host.querySelector('.lightink-reader-comic-chrome')).not.toBeNull();
    expect(host.querySelector('.lightink-reader-comic-bottombar')).not.toBeNull();
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

  it('lets the newest paged load win when renderPdfInto resolves out of order', async () => {
    // 失败面同口径（paged adapter）：乱序取代丢弃过期离屏渲染结果，不画、不报错。
    const pendingRenders: Array<Deferred<ReturnType<typeof fakePdfHandle>>> = [];
    pdfMock.renderPdfInto.mockImplementation(async (_source, stagedHost: HTMLElement) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot';
      slot.dataset.pageIndex = '0';
      slot.textContent = `render-${pendingRenders.length}`;
      stagedHost.appendChild(slot);
      const pending = deferred<ReturnType<typeof fakePdfHandle>>();
      pendingRenders.push(pending);
      return pending.promise;
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });

    // A 先进入离屏渲染（过了取源取消检查），B 再开——B 起点即取代 A；
    // 两个门都等到各自渲染真正开始后再手动放行，才能构造乱序完成。
    const loadA = view.load('a.pdf');
    await vi.waitFor(() => {
      expect(pendingRenders).toHaveLength(1);
    });
    const loadB = view.load('b.pdf');
    await vi.waitFor(() => {
      expect(pendingRenders).toHaveLength(2);
    });
    const handleA = fakePdfHandle(1, 5);
    const handleB = fakePdfHandle(2, 9);

    pendingRenders[1]!.resolve(handleB);
    await loadB;
    expect(host.querySelector('.lightink-reader-page-slot')?.textContent).toBe('render-1');
    expect(view.state).toMatchObject({
      phase: 'ready',
      current: 2,
      total: 9,
      locationKind: 'page',
    });

    pendingRenders[0]!.resolve(handleA);
    await loadA;
    expect(handleA.destroy).toHaveBeenCalledTimes(1);
    expect(handleB.destroy).not.toHaveBeenCalled();
    expect(host.querySelector('.lightink-reader-page-slot')?.textContent).toBe('render-1');
    await view.destroy();
  });

  it('aborts pending paged work and prevents commits after destroy', async () => {
    // 失败面同口径（paged adapter）：destroy 中止离屏渲染，迟到的结果经
    // discard 释放、不换入视图。
    const renderStarted = deferred<void>();
    const pendingRender = deferred<ReturnType<typeof fakePdfHandle>>();
    const handle = fakePdfHandle();
    pdfMock.renderPdfInto.mockImplementation(async (_source, stagedHost: HTMLElement) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot';
      stagedHost.appendChild(slot);
      renderStarted.resolve();
      return pendingRender.promise;
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });

    const load = view.load('book.pdf');
    await renderStarted.promise;
    await view.destroy();
    expect(host.children).toHaveLength(0);

    pendingRender.resolve(handle);
    await load;
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(host.children).toHaveLength(0);
  });

  it('exposes caller cancellation of a paged open without treating it as a load failure', async () => {
    // 失败面同口径（paged adapter）：调用方取消不作失败提示；取消发生在
    // 离屏渲染期间时，staged 句柄经 discard 恰一次释放、不换入视图。
    const renderStarted = deferred<void>();
    const pendingRender = deferred<ReturnType<typeof fakePdfHandle>>();
    const handle = fakePdfHandle();
    pdfMock.renderPdfInto.mockImplementation(async (_source, stagedHost: HTMLElement) => {
      const slot = document.createElement('div');
      slot.className = 'lightink-reader-page-slot';
      stagedHost.appendChild(slot);
      renderStarted.resolve();
      return pendingRender.promise;
    });
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });
    const controller = new AbortController();

    const load = view.load('book.pdf', { signal: controller.signal });
    await renderStarted.promise;
    controller.abort();
    pendingRender.resolve(handle);
    await expect(load).resolves.toBeUndefined();

    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    expect(root.dataset.readerState).toBe('cancelled');
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(handle.destroy).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.lightink-reader-page-slot')).toBeNull();
    await view.destroy();
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

  it('opens the unified annotation panel as a touch sheet from openSearch', async () => {
    // 触屏旗标（R8）：openSearch 不再分叉——打开同一融合面板（is-touch-sheet
    // 底栏形态），触屏由此获得完整标注浏览/筛选/跳转/编辑/删除能力。
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

    expect(view.isSidebarVisible()).toBe(true);
    const visibleSheets = (): HTMLElement[] =>
      [...document.querySelectorAll<HTMLElement>('.is-touch-sheet')].filter(
        (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
      );
    const sheet = visibleSheets();
    expect(sheet).toHaveLength(1);
    expect(sheet[0]!.classList.contains('lightink-reader-sidebar')).toBe(true);
    expect(sheet[0]!.classList.contains('lightink-reader-annotation-panel')).toBe(true);
    // 选区/入参 seed 预填进统一面板查询框。
    expect(sheet[0]!.querySelector<HTMLInputElement>('input')?.value).toBe('keyword');

    // Escape（Android 系统返回经 back-navigation 合成同键）一次只关面板，不合书。
    const root = host.querySelector<HTMLElement>('.lightink-reader')!;
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(visibleSheets()).toHaveLength(0);
    expect(view.isSidebarVisible()).toBe(false);
    expect(onReturnToShelf).not.toHaveBeenCalled();
    expect(view.state.phase).toBe('ready');
    expect(host.querySelector('.lightink-reader')).not.toBeNull();
    await view.destroy();
  });

  it('serves toggleSidebar and openSearch from the same unified panel on touch', async () => {
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

    // openSearch 复用同一面板（不再出现第二个搜索层），seed 进同一查询框。
    view.openSearch?.('keyword');
    expect(view.isSidebarVisible()).toBe(true);
    const afterSearch = visibleSheets();
    expect(afterSearch).toHaveLength(1);
    expect(afterSearch[0]!.classList.contains('lightink-reader-sidebar')).toBe(true);
    expect(afterSearch[0]!.querySelector('input')?.value).toBe('keyword');

    view.toggleSidebar();
    expect(view.isSidebarVisible()).toBe(false);
    expect(visibleSheets()).toHaveLength(0);

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

  it('saves the chapter under the viewport in scroll mode, not a stale current index', async () => {
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
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters }),
      progressStorage,
    });
    await view.load('resume-visible.epub');
    useReaderScrollLayout(host);
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 900,
      clientHeight: 400,
      chapterHeight: 800,
    });
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(400);
    const saved = Object.values(store)
      .map((raw) => parseReadingProgress(raw))
      .find((entry) => entry !== null);
    expect(saved?.kind).toBe('flow');
    expect(saved?.index).toBe(1);
    await view.destroy();
    vi.useRealTimers();
  });

  it('does not save a spacer chapter when a real chapter still covers the viewport', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const chapters = Array.from({ length: 12 }, (_, index) => ({
      title: `C${index + 1}`,
      html: `<p>${index}</p>`,
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters }),
      progressStorage,
    });
    await view.load('resume-spacer.epub');
    useReaderScrollLayout(host);
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 900,
      clientHeight: 400,
      chapterHeight: 800,
    });
    const spacer = document.createElement('div');
    spacer.className = 'lightink-reader-chapter-spacer';
    spacer.dataset.chapterSpacer = '0';
    Object.defineProperty(spacer, 'offsetHeight', { configurable: true, value: 50 });
    vi.spyOn(spacer, 'getBoundingClientRect').mockReturnValue({ top: -20, bottom: 30 } as DOMRect);
    scroll.insertBefore(spacer, chapterEls[0] ?? null);
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(400);
    const saved = Object.values(store)
      .map((raw) => parseReadingProgress(raw))
      .find((entry) => entry !== null);
    expect(saved?.index).toBe(1);
    await view.destroy();
    vi.useRealTimers();
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
      version: 2,
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

  it('does not snap scroll back after the user moves while a restore is still pending', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    const progressStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(progressStorage, 'resume-scroll-lock.epub', {
      version: 2,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
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
    });
    useReaderScrollLayout(host);
    await view.load('resume-scroll-lock.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    for (const chapter of chapterEls) {
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 0 });
    }
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1600 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
    view.restoreReadingProgress?.();
    expect(scroll.scrollTop).toBe(0);

    scroll.scrollTop = 120;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);

    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 120,
      clientHeight: 400,
      chapterHeight: 800,
    });
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(16);
    expect(scroll.scrollTop).toBe(120);
    await view.destroy();
    vi.useRealTimers();
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
      version: 2,
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
      version: 2,
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
      version: 2,
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

  it('restores stored paginated layout when opening EPUB after a live PDF', async () => {
    pdfMock.renderPdfInto.mockImplementation(async () => fakePdfHandle());
    const store: Record<string, string> = {
      [READER_FLOW_LAYOUT_STORAGE_KEY]: 'paginated',
    };
    const preferenceStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: [{ title: 'One', html: '<p>one</p>' }],
      }),
      preferenceStorage,
    });

    await view.load('doc.pdf');
    expect(host.querySelector<HTMLElement>('.lightink-reader')?.dataset.readingLayout).toBe(
      'scroll',
    );

    await view.load('after-pdf.epub');
    expect(host.querySelector<HTMLElement>('.lightink-reader')?.dataset.readingLayout).toBe(
      'paginated',
    );
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
    expect(labels.some((text) => text.includes('本书标注'))).toBe(false);
    expect(host.querySelector('[data-reader-chrome-action="annotations"]')).toBeNull();
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
    view.toggleSidebar();
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
      version: 2,
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

describe('Reader session progress restore budgets', () => {
  it('gives up scroll restore after the retry budget and stays readable without looping', async () => {
    // 失败面：滚动模式恢复重试超过 flow 阈值（12 次）后放弃——停在当前可读
    // 位置、不报错、不再循环（预算耗尽后度量就绪也不再有帧落点）。
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const progressStorage = memoryProgressStore();
    saveReadingProgress(progressStorage, 'resume-budget.epub', {
      version: 2,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
      total: 2,
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
    await view.load('resume-budget.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    // 高度永不出：滚动宿主就绪但章高为 0，且整卷不可滚（maxScroll 0）。
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 400 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
    for (const chapter of chapterEls) {
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 0 });
    }
    view.restoreReadingProgress?.();
    // 12 次重试 + 第 13 次尽力落点：maxScroll 0 → 停在原地，循环终止。
    await vi.advanceTimersByTimeAsync((FLOW_RESTORE_MAX_ATTEMPTS + 3) * 16);
    expect(scroll.scrollTop).toBe(0);
    expect(view.state.phase).toBe('ready');
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 0,
      clientHeight: 400,
      chapterHeight: 800,
    });
    await vi.advanceTimersByTimeAsync(5 * 16);
    expect(scroll.scrollTop).toBe(0);
    await view.destroy();
  });

  it('drops a paginated restore whose frame never measures and stops retrying', async () => {
    // 失败面（OPDS 慢章）：帧声明就绪但分栏不可度量 → 8 次后放弃，停在当前
    // 可读章，不报错、不再循环（分栏随后可度量也不再有帧落点）。
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const progressStorage = memoryProgressStore();
    saveReadingProgress(progressStorage, 'resume-columns.epub', {
      version: 2,
      kind: 'flow',
      index: 1,
      ratio: 0.5,
      total: 3,
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
          { title: 'Three', html: '<p>three</p>' },
        ],
      }),
      progressStorage,
    });
    await view.load('resume-columns.epub'); // 默认翻页布局
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load')); // frameReady=true；jsdom 分栏宽度 0 → 不可度量
    }
    await vi.advanceTimersByTimeAsync((PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS + 3) * 16);
    const active = host.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
    expect(Number(active?.dataset.chapterIndex)).toBe(1); // 停在恢复章（可读位置）
    expect(view.state.phase).toBe('ready'); // 放弃不构成错误
    const frame = host.querySelector<HTMLIFrameElement>(
      '.lightink-reader-chapter[data-chapter-index="1"] .lightink-reader-chapter-frame',
    );
    const scroller = readerPagedScroller(frame!.contentDocument!);
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1200 });
    await vi.advanceTimersByTimeAsync(4 * 16);
    expect(scroller.scrollLeft).toBe(0);
    await view.destroy();
  });

  it('reports the storage progressId to the shelf after successful loads only', async () => {
    // 成功面：onProgressBound 书库绑定行为不变——成功加载按身份链报告一次；
    // 失败加载不报告（未打开的书架行保持无 alias）。
    const onProgressBound = vi.fn();
    const host = document.createElement('div');
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters: [{ title: 'One', html: '<p>one</p>' }] }),
      progressStorage: memoryProgressStore(),
      onProgressBound,
    });
    await view.load('bind.epub');
    expect(onProgressBound).toHaveBeenCalledTimes(1);
    expect(onProgressBound).toHaveBeenCalledWith(
      'bind.epub',
      expect.objectContaining({ kind: 'local', path: 'bind.epub' }),
    );
    await view.destroy();

    const onBoundFailed = vi.fn();
    const hostB = document.createElement('div');
    const viewB = createReaderView(hostB, {
      readBytes: async () => {
        throw new Error('disk read failed');
      },
      progressStorage: memoryProgressStore(),
      onProgressBound: onBoundFailed,
    });
    await expect(viewB.load('broken.epub')).rejects.toThrow('disk read failed');
    expect(onBoundFailed).not.toHaveBeenCalled();
    await viewB.destroy();
  });

  it('binds comic progress identity early and reports it once to the shelf', async () => {
    stubComicObjectUrls();
    const archive = await buildPagedCbz(3);
    const progressStorage = memoryProgressStore();
    const onProgressBound = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(
      host,
      localComicSourceDeps(archive, {
        progressStorage,
        preferenceStorage: progressStorage,
        onProgressBound,
      }),
    );

    await view.load('/comics/bound.cbz');
    // 漫画提前绑定（afterCommit）不触发书库绑定；settle 统一按身份报告一次。
    expect(onProgressBound).toHaveBeenCalledTimes(1);
    expect(onProgressBound).toHaveBeenCalledWith(
      '/comics/bound.cbz',
      expect.objectContaining({ kind: 'local', path: '/comics/bound.cbz' }),
    );
    await view.destroy();
  });
});

// —— 进度会话（session-progress）回归：失败面（恢复重试超过阈值放弃、停在
// 可读位置不报错、不再循环）与保存时机（打开下一本时 flush 上一本位置）。 ——

describe('Reader progress session', () => {
  const twoChapters = [
    { title: 'One', html: '<p>one</p>' },
    { title: 'Two', html: '<p>two</p>' },
  ];

  function memoryStore(): { values: Record<string, string>; storage: ProgressStorage } {
    const values: Record<string, string> = {};
    return {
      values,
      storage: {
        getItem: (key: string) => values[key] ?? null,
        setItem: (key: string, value: string) => {
          values[key] = value;
        },
      },
    };
  }

  it('gives up flow restore after the retry threshold and stays readable without looping', async () => {
    // 失败面：章节几何从未就绪（jsdom 无布局，clientHeight/offsetHeight 均为 0）。
    // 恢复逐帧重试，超过 flow 12 次阈值后按 best-effort 收尾（无可滚空间 → 原位），
    // 不报错、不再排帧（rAF 请求计数收敛）。
    vi.useFakeTimers();
    const { storage } = memoryStore();
    saveReadingProgress(storage, 'giveup.epub', {
      version: 2,
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
      parseContent: async () => ({ chapters: twoChapters }),
      progressStorage: storage,
    });
    useReaderScrollLayout(host);
    await view.load('giveup.epub');

    const raf = vi.spyOn(window, 'requestAnimationFrame');
    await vi.advanceTimersByTimeAsync(16 * 40);
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    expect(view.state.phase).toBe('ready');
    expect(scroll.scrollTop).toBe(0);

    // 放弃后不再循环：追加时间窗口不产生新的恢复帧，位置保持可读原位。
    const framesAfterGiveUp = raf.mock.calls.length;
    await vi.advanceTimersByTimeAsync(16 * 40);
    expect(raf.mock.calls.length).toBe(framesAfterGiveUp);
    expect(scroll.scrollTop).toBe(0);
    raf.mockRestore();
    await view.destroy();
  });

  it('abandons paginated restore when the ready frame stays unmeasurable', async () => {
    // 失败面（OPDS 口径）：帧已标记就绪但分栏 scroller 不可测（clientWidth 0）。
    // 重试 8 次后放弃：停在目标章可读位置（活动章已切换、章内比例丢弃），
    // 不报错、不再循环。
    vi.useFakeTimers();
    const { storage } = memoryStore();
    saveReadingProgress(storage, 'opds-stall.epub', {
      version: 2,
      kind: 'flow',
      index: 3,
      ratio: 0.4,
      total: 5,
      updatedAt: 1,
    });
    const preference: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({
        chapters: Array.from({ length: 5 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>${index + 1}</p>`,
        })),
      }),
      progressStorage: storage,
      preferenceStorage: {
        getItem: (key) => preference[key] ?? null,
        setItem: (key, value) => {
          preference[key] = value;
        },
      },
    });
    await view.load('opds-stall.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }

    const raf = vi.spyOn(window, 'requestAnimationFrame');
    await vi.advanceTimersByTimeAsync(16 * 40);
    const active = host.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
    expect(Number(active?.dataset.chapterIndex)).toBe(3);
    expect(view.state.phase).toBe('ready');
    expect(view.state).toMatchObject({ current: 4, total: 5, locationKind: 'chapter' });

    // 放弃后不再循环。
    const framesAfterGiveUp = raf.mock.calls.length;
    await vi.advanceTimersByTimeAsync(16 * 40);
    expect(raf.mock.calls.length).toBe(framesAfterGiveUp);
    raf.mockRestore();
    await view.destroy();
  });

  it('flushes the previous book position when the same view opens the next book', async () => {
    // 保存时机：防抖未到期（100ms < 400ms）时切换书籍，open 起点立即把上一本
    // 位置落盘到上一本的键，不丢也不串写到新书的键。
    vi.useFakeTimers();
    const { values, storage } = memoryStore();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => bytes('unused'),
      parseContent: async () => ({ chapters: twoChapters }),
      progressStorage: storage,
    });
    await view.load('first.epub');
    useReaderScrollLayout(host);

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapterEls = [...scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')];
    mockChapterScrollLayout(scroll, chapterEls, {
      scrollTop: 1200,
      clientHeight: 400,
      chapterHeight: 800,
    });
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(100);
    expect(values[`${READING_PROGRESS_KEY_PREFIX}first.epub`]).toBeUndefined();

    await view.load('second.epub');
    expect(values[`${READING_PROGRESS_KEY_PREFIX}first.epub`]).toContain('"index":1');
    expect(values[`${READING_PROGRESS_KEY_PREFIX}first.epub`]).toContain('"ratio":0.5');
    expect(values[`${READING_PROGRESS_KEY_PREFIX}second.epub`]).toBeUndefined();
    expect(view.state).toMatchObject({ phase: 'ready', current: 1, total: 2 });
    await view.destroy();
  });
});
