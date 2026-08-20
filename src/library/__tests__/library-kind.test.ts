import { describe, expect, it } from 'vitest';

import { classifyLibraryKind } from '../library-kind.js';

describe('classifyLibraryKind', () => {
  it.each(['cbz', 'cbr', 'cb7', 'CBZ', 'Cbr'])(
    'classifies comic archive extension %s as comic',
    (extension) => {
      expect(classifyLibraryKind({ extension })).toBe('comic');
    },
  );

  it.each([
    'application/vnd.comicbook+zip',
    'application/x-cbz',
    'application/vnd.comicbook+rar',
    'application/x-cbr',
    'application/zip',
    'application/vnd.comicbook+zip; charset=binary',
    'APPLICATION/ZIP',
  ])('classifies comic/zip media type %s as comic', (mediaType) => {
    expect(classifyLibraryKind({ mediaType })).toBe('comic');
  });

  it('classifies comic metadata as comic when the file is not a comic archive', () => {
    expect(classifyLibraryKind({ extension: 'pdf', series: '墨色档案' })).toBe('comic');
    expect(classifyLibraryKind({ extension: 'pdf', number: '12' })).toBe('comic');
    expect(classifyLibraryKind({ extension: 'pdf', volume: '3' })).toBe('comic');
    expect(classifyLibraryKind({ extension: 'pdf', pageCount: 128 })).toBe('comic');
    expect(classifyLibraryKind({ extension: 'pdf', readingDirection: 'rtl' })).toBe('comic');
    expect(classifyLibraryKind({ extension: 'pdf', coverPage: 0 })).toBe('comic');
  });

  it.each(['epub', 'txt', 'html', 'htm', 'EPUB'])(
    'classifies text format %s without comic metadata as text',
    (extension) => {
      expect(classifyLibraryKind({ extension })).toBe('text');
    },
  );

  it.each(['application/epub+zip', 'text/plain', 'text/html', 'application/pdf'])(
    'classifies text media type %s without comic metadata as text',
    (mediaType) => {
      expect(classifyLibraryKind({ mediaType })).toBe('text');
    },
  );

  it('classifies a PDF without comic metadata as a text book', () => {
    expect(classifyLibraryKind({ extension: 'pdf' })).toBe('text');
    expect(classifyLibraryKind({ extension: 'pdf', mediaType: 'application/pdf' })).toBe('text');
  });

  it('does not invent a third kind or classify by empty comic metadata', () => {
    expect(classifyLibraryKind({ extension: 'mobi' })).toBe('text');
    expect(classifyLibraryKind({ extension: 'fb2' })).toBe('text');
    expect(classifyLibraryKind({})).toBe('text');
    expect(
      classifyLibraryKind({
        extension: 'epub',
        series: '',
        number: '',
        volume: '',
      }),
    ).toBe('text');
    expect(
      classifyLibraryKind({
        extension: 'epub',
        series: null as unknown as string,
        number: null as unknown as string,
        volume: null as unknown as string,
      }),
    ).toBe('text');
  });

  it('lets comic archive markers win over a text-like extension leftover', () => {
    expect(
      classifyLibraryKind({
        extension: 'epub',
        mediaType: 'application/vnd.comicbook+zip',
      }),
    ).toBe('comic');
    expect(
      classifyLibraryKind({
        extension: 'cbz',
        mediaType: 'application/epub+zip',
      }),
    ).toBe('comic');
  });

  it.each([
    {
      extension: 'epub',
      mediaType: 'application/epub+zip',
      seriesStem: '地狱模式',
      seriesVolume: '01',
    },
    { extension: 'txt', seriesStem: '地狱模式', seriesVolume: '01' },
    { extension: 'html', seriesStem: '地狱模式' },
    {
      extension: 'pdf',
      mediaType: 'application/pdf',
      seriesStem: '地狱模式',
      seriesVolume: '01',
    },
  ])(
    'keeps a text format as text when filename series is not written to LibraryItem.series (%s)',
    (query) => {
      expect(classifyLibraryKind(query)).toBe('text');
    },
  );

  it.each([
    { extension: 'epub', series: '地狱模式' },
    { extension: 'txt', volume: '01' },
    { extension: 'html', number: '2' },
  ])(
    'classifies a text format as comic if the filename stem is copied onto LibraryItem comic fields (%s)',
    (query) => {
      expect(classifyLibraryKind(query)).toBe('comic');
    },
  );
});
