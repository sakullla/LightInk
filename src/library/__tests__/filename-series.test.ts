import { describe, expect, it } from 'vitest';

import {
  parseFilenameSeries,
  resolveImportedEpubTitle,
  resolveLocalEpubTitle,
} from '../filename-series.js';

const HELL_STEM = '地狱模式～喜欢挑战特殊成就的玩家在废设定的异世界成为无双～';
const HELL_FILE = `${HELL_STEM} - 01.epub`;
const HELL_WIN_PATH = `e:\\ebook\\文库版\\${HELL_FILE}`;
const HELL_POSIX_PATH = `/ebook/文库版/${HELL_FILE}`;

describe('parseFilenameSeries', () => {
  it('treats the hell-mode Chinese filename as informative and keeps it as the shelf title', () => {
    const parsed = parseFilenameSeries(HELL_WIN_PATH);
    expect(parsed.informative).toBe(true);
    expect(parsed.title).toBe(`${HELL_STEM} - 01`);
    expect(parsed.title).not.toContain('文库版');
    expect(parsed.seriesStem).toBe(HELL_STEM);
    expect(parsed.volume).toBe('01');
  });

  it('ignores the parent directory on POSIX paths as well', () => {
    const parsed = parseFilenameSeries(HELL_POSIX_PATH);
    expect(parsed.informative).toBe(true);
    expect(parsed.title).toBe(`${HELL_STEM} - 01`);
    expect(parsed.seriesStem).toBe(HELL_STEM);
    expect(parsed.title).not.toContain('文库版');
    expect(parsed.seriesStem).not.toContain('文库版');
  });

  it.each(['2.epub', '01.epub', 'v02.epub', 'Vol. 2.epub', '第01卷.epub'])(
    'treats volume-only filename %s as uninformative and yields no series stem',
    (fileName) => {
      const parsed = parseFilenameSeries(`e:\\ebook\\文库版\\${fileName}`);
      expect(parsed.informative).toBe(false);
      expect(parsed.seriesStem).toBeUndefined();
      expect(parsed.volume).toBeUndefined();
      expect(parsed.title).not.toContain('文库版');
    },
  );

  it.each([
    [`${HELL_STEM} - 01.epub`, '01'],
    [`${HELL_STEM} v02.epub`, '02'],
    [`${HELL_STEM}第02卷.epub`, '02'],
    [`${HELL_STEM} Vol. 2.epub`, '2'],
  ])('extracts the same hell-mode stem from %s', (fileName, volume) => {
    const parsed = parseFilenameSeries(fileName);
    expect(parsed.informative).toBe(true);
    expect(parsed.seriesStem).toBe(HELL_STEM);
    expect(parsed.volume).toBe(volume);
  });

  it.each([
    ['书名 - 01.epub', '书名', '01', '书名 - 01'],
    ['书名_01.epub', '书名', '01', '书名_01'],
    ['书名 01.epub', '书名', '01', '书名 01'],
    ['书名 v01.epub', '书名', '01', '书名 v01'],
    ['书名 Vol. 1.epub', '书名', '1', '书名 Vol. 1'],
    ['书名 Volume 01.epub', '书名', '01', '书名 Volume 01'],
    ['书名第01卷.epub', '书名', '01', '书名第01卷'],
    ['书名第一卷.epub', '书名', '1', '书名第一卷'],
    ['书名1巻.epub', '书名', '1', '书名1巻'],
    ['书名卷2.epub', '书名', '2', '书名卷2'],
    ['书名册2.epub', '书名', '2', '书名册2'],
    ['书名 上.epub', '书名', '上', '书名 上'],
    ['书名 上册.epub', '书名', '上', '书名 上册'],
    ['书名 中卷.epub', '书名', '中', '书名 中卷'],
    ['书名 下.epub', '书名', '下', '书名 下'],
    ['《书名》01.epub', '书名', '01', '《书名》01'],
    ['「书名」第2卷.epub', '书名', '2', '「书名」第2卷'],
  ])('extracts stem and first volume from %s', (fileName, seriesStem, volume, title) => {
    expect(parseFilenameSeries(fileName)).toEqual({
      informative: true,
      title,
      seriesStem,
      volume,
    });
  });

  it('strips a leading [author] prefix from the series stem, not the shelf title', () => {
    expect(parseFilenameSeries('[某作者] 地狱模式 - v01.epub')).toEqual({
      informative: true,
      title: '[某作者] 地狱模式 - v01',
      seriesStem: '地狱模式',
      volume: '01',
    });
  });

  it('keeps trailing decorations out of the series stem', () => {
    expect(parseFilenameSeries('地狱模式 - 01 (文库版).epub')).toEqual({
      informative: true,
      title: '地狱模式 - 01',
      seriesStem: '地狱模式',
      volume: '01',
    });
    expect(parseFilenameSeries('地狱模式 - 01[修订].epub')).toEqual({
      informative: true,
      title: '地狱模式 - 01',
      seriesStem: '地狱模式',
      volume: '01',
    });
  });

  it('does not treat a hyphen suffix as a volume unless it is a volume label', () => {
    expect(parseFilenameSeries('书名 - 番外.epub')).toEqual({
      informative: true,
      title: '书名 - 番外',
      seriesStem: undefined,
      volume: undefined,
    });
  });

  it('uses the first volume label when several appear', () => {
    expect(parseFilenameSeries('书名 v01 第02卷.epub')).toEqual({
      informative: true,
      title: '书名 v01 第02卷',
      seriesStem: '书名',
      volume: '01',
    });
  });

  it('treats a title-only filename as informative without opening a series', () => {
    expect(parseFilenameSeries('河山记.epub')).toEqual({
      informative: true,
      title: '河山记',
      seriesStem: undefined,
      volume: undefined,
    });
  });

  it('does not treat 上 in a real title as a volume word', () => {
    expect(parseFilenameSeries('上海夜话.epub')).toEqual({
      informative: true,
      title: '上海夜话',
      seriesStem: undefined,
      volume: undefined,
    });
  });

  it('rejects a one-character leftover as a series stem', () => {
    expect(parseFilenameSeries('藻 - 01.epub')).toEqual({
      informative: false,
      title: '藻 - 01',
    });
  });

  it('accepts a basename without a directory and a .EPUB suffix', () => {
    const parsed = parseFilenameSeries(`${HELL_STEM} - 01.EPUB`);
    expect(parsed.informative).toBe(true);
    expect(parsed.seriesStem).toBe(HELL_STEM);
    expect(parsed.volume).toBe('01');
  });

  it('does not treat a managed content-hash blob name as an informative title', () => {
    const hash = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';
    const parsed = parseFilenameSeries(`C:/app/library/managed/blobs/${hash.slice(0, 2)}/${hash}.epub`);
    expect(parsed.informative).toBe(false);
    expect(resolveLocalEpubTitle(`${hash}.epub`, '河山记')).toBe('河山记');
  });
});

describe('resolveImportedEpubTitle', () => {
  it('keeps the original filename when enrich reads a hashed managed blob path', () => {
    const hash = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';
    expect(
      resolveImportedEpubTitle(
        '三体.epub',
        `C:/app/library/managed/blobs/${hash.slice(0, 2)}/${hash}.epub`,
        'ããä½',
      ),
    ).toBe('三体');
  });

  it('falls back to dc:title when the source name is also uninformative', () => {
    const hash = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';
    expect(resolveImportedEpubTitle('01.epub', `${hash}.epub`, '河山记')).toBe('河山记');
  });
});
