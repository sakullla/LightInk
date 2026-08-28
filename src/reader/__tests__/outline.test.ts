import { describe, expect, it } from 'vitest';

import { outlineFromEntries, outlineFromPdf, type PdfOutlineResolver } from '../outline.js';

describe('outlineFromEntries', () => {
  it('maps flow chapters to level-1 items with chapter index', () => {
    expect(
      outlineFromEntries([{ title: '开篇' }, { title: '  ' }, { title: '终章' }], 'chapter'),
    ).toEqual([
      { level: 1, text: '开篇', anchor: 0, chapter: 0 },
      { level: 1, text: '终章', anchor: 1, chapter: 2 },
    ]);
  });

  it('maps page entries to 1-based page numbers', () => {
    expect(outlineFromEntries([{ title: '第 1 页' }, { title: '第 2 页' }], 'page')).toEqual([
      { level: 1, text: '第 1 页', anchor: 0, page: 1 },
      { level: 1, text: '第 2 页', anchor: 1, page: 2 },
    ]);
  });

  it('keeps every titled chapter past the old 2000-item catalog cap', () => {
    const entries = Array.from({ length: 2530 }, (_, index) => ({ title: `第${index + 1}章` }));
    const items = outlineFromEntries(entries, 'chapter');
    expect(items).toHaveLength(2530);
    expect(items[0]).toMatchObject({ text: '第1章', chapter: 0 });
    expect(items[1999]).toMatchObject({ text: '第2000章', chapter: 1999 });
    expect(items[2529]).toMatchObject({ text: '第2530章', chapter: 2529 });
  });
});

describe('outlineFromPdf', () => {
  it('flattens bookmarks and resolves named / explicit destinations', async () => {
    const resolver: PdfOutlineResolver = {
      getOutline: async () => [
        {
          title: 'Cover',
          dest: 'cover',
          items: [{ title: 'Intro', dest: [{ num: 7, gen: 0 }, { name: 'XYZ' }], items: [] }],
        },
        { title: '  ', dest: null, items: [] },
      ],
      getDestination: async (id) => (id === 'cover' ? [{ num: 1, gen: 0 }, { name: 'Fit' }] : null),
      getPageIndex: async (ref) => {
        const num = (ref as { num?: number }).num;
        if (num === 1) return 0;
        if (num === 7) return 6;
        throw new Error('unknown dest');
      },
    };

    await expect(outlineFromPdf(resolver)).resolves.toEqual([
      { level: 1, text: 'Cover', anchor: 0, page: 1 },
      { level: 2, text: 'Intro', anchor: 1, page: 7 },
    ]);
  });

  it('returns empty when the document has no outline', async () => {
    await expect(
      outlineFromPdf({
        getOutline: async () => [],
        getDestination: async () => null,
        getPageIndex: async () => 0,
      }),
    ).resolves.toEqual([]);
  });
});
