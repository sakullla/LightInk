// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  comicDisplayWidthPx,
  comicImageBlob,
  comicImageObjectUrl,
  compareComicPaths,
  isComicImagePath,
  orderComicPages,
  parseComicInfo,
  selectComicCacheWindow,
  sniffComicImageMime,
  type ComicPageCandidate,
} from '../comic-model.js';
import {
  advanceComicPage,
  comicVisiblePages,
  loadComicPreferences,
  saveComicPreferences,
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

  it('caps display decode width by the slot CSS size and device pixels', () => {
    const slot = document.createElement('div');
    Object.defineProperty(slot, 'clientWidth', { configurable: true, value: 640 });
    expect(comicDisplayWidthPx(slot, 800)).toBe(Math.min(4096, Math.round(640 * (window.devicePixelRatio || 1))));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x1, 0x2]);
    expect(comicImageBlob(jpeg, 'page.jpg').type).toBe('image/jpeg');
  });

  it('rejects unsafe ComicInfo and bounds the decoded page window by bytes', () => {
    expect(parseComicInfo('<!DOCTYPE ComicInfo><ComicInfo/>')).toBeNull();
    expect([...selectComicCacheWindow([5, 5, 20, 5], [1], 15)]).toEqual([1, 0, 3]);
    expect(selectComicCacheWindow([1], [], 10).size).toBe(0);
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

  it('persists layout, direction, spread, and fit-width without throwing', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const preferences = {
      mode: 'paged' as const,
      direction: 'rtl' as const,
      spread: 'double' as const,
      fitWidth: false,
    };
    saveComicPreferences(storage, preferences);
    expect(loadComicPreferences(storage)).toEqual(preferences);
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
