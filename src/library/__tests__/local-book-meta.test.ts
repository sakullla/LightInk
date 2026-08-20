// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

import { extractLocalBookMeta, isShelfCoverUrl } from '../local-book-meta.js';

const JP_DC_TITLE = 'ヘルモード～特殊な実績が好きなプレイヤーは廃設定の異世界で無双する～';
const HELL_STEM = '地狱模式～喜欢挑战特殊成就的玩家在废设定的异世界成为无双～';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function buildCoverEpub(dcTitle = '河山记'): Promise<Uint8Array> {
  const zip = new ZipWriter(new Uint8ArrayWriter());
  await zip.add(
    'META-INF/container.xml',
    new Uint8ArrayReader(
      encode(
        '<?xml version="1.0"?><container><rootfiles>' +
          '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
          '</rootfiles></container>',
      ),
    ),
  );
  await zip.add(
    'OEBPS/content.opf',
    new Uint8ArrayReader(
      encode(
        '<?xml version="1.0"?><package>' +
          `<metadata><dc:title>${dcTitle}</dc:title><dc:creator>作者甲</dc:creator></metadata>` +
          '<manifest>' +
          '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' +
          '</manifest>' +
          '<spine><itemref idref="ch1"/></spine>' +
          '</package>',
      ),
    ),
  );
  await zip.add('OEBPS/ch1.xhtml', new Uint8ArrayReader(encode('<html><body><p>一</p></body></html>')));
  await zip.add(
    'OEBPS/images/cover.png',
    new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])),
    { level: 0 },
  );
  return zip.close();
}

describe('extractLocalBookMeta', () => {
  it('uses dc:title only when the filename is uninformative', async () => {
    const meta = await extractLocalBookMeta('2.epub', await buildCoverEpub());
    expect(meta.title).toBe('河山记');
    expect(meta.authors).toEqual(['作者甲']);
    expect(meta.coverUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(meta.seriesStem).toBeUndefined();
    expect(meta.seriesVolume).toBeUndefined();
  });

  it.each(['01.epub', 'v02.epub'])(
    'keeps dc:title and produces no series stem for uninformative %s',
    async (filename) => {
      const meta = await extractLocalBookMeta(filename, await buildCoverEpub(JP_DC_TITLE));
      expect(meta.title).toBe(JP_DC_TITLE);
      expect(meta.seriesStem).toBeUndefined();
      expect(meta.seriesVolume).toBeUndefined();
    },
  );

  it('prefers an informative Chinese filename over a Japanese dc:title', async () => {
    const meta = await extractLocalBookMeta(
      `e:\\ebook\\文库版\\${HELL_STEM} - 01.epub`,
      await buildCoverEpub(JP_DC_TITLE),
    );
    expect(meta.title).toBe(`${HELL_STEM} - 01`);
    expect(meta.title).not.toContain('文库版');
    expect(meta.seriesStem).toBe(HELL_STEM);
    expect(meta.seriesVolume).toBe('01');
    expect(meta).not.toHaveProperty('series');
  });

  it('extracts the same series stem for listed volume markers', async () => {
    const bytes = await buildCoverEpub(JP_DC_TITLE);
    const parsed = await Promise.all(
      ['地狱模式 - v02.epub', '地狱模式 第02卷.epub', '地狱模式 Vol. 2.epub'].map((filename) =>
        extractLocalBookMeta(filename, bytes),
      ),
    );
    expect(parsed.map((meta) => meta.seriesStem)).toEqual(['地狱模式', '地狱模式', '地狱模式']);
    expect(parsed.map((meta) => meta.title)).toEqual([
      '地狱模式 - v02',
      '地狱模式 第02卷',
      '地狱模式 Vol. 2',
    ]);
    expect(parsed.map((meta) => meta.seriesVolume)).toEqual(['02', '02', '2']);
  });

  it('keeps [author] prefixes and trailing decorations out of the series stem', async () => {
    const bytes = await buildCoverEpub(JP_DC_TITLE);
    const withAuthor = await extractLocalBookMeta(
      'e:\\ebook\\文库版\\[某作者] 地狱模式 - v01.epub',
      bytes,
    );
    const withDecoration = await extractLocalBookMeta('地狱模式 - 01 (文库版).epub', bytes);

    expect(withAuthor.title).toBe('[某作者] 地狱模式 - v01');
    expect(withAuthor.seriesStem).toBe('地狱模式');
    expect(withAuthor.seriesVolume).toBe('01');
    expect(withAuthor.title).not.toContain('文库版');

    expect(withDecoration.title).toBe('地狱模式 - 01');
    expect(withDecoration.seriesStem).toBe('地狱模式');
    expect(withDecoration.seriesVolume).toBe('01');
  });
});

describe('isShelfCoverUrl', () => {
  it('accepts data image URLs and https covers', () => {
    expect(isShelfCoverUrl('data:image/png;base64,aaaa')).toBe(true);
    expect(isShelfCoverUrl('https://covers.example/a.jpg')).toBe(true);
    expect(isShelfCoverUrl('javascript:alert(1)')).toBe(false);
    expect(isShelfCoverUrl(undefined)).toBe(false);
    expect(isShelfCoverUrl(null)).toBe(false);
  });
});
