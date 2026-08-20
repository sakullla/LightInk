import { describe, expect, it } from 'vitest';

import {
  chapterScrollRatio,
  chapterScrollTop,
  loadReadingProgress,
  parseReadingProgress,
  readingProgressKey,
  saveReadingProgress,
} from '../reading-progress.js';

describe('parseReadingProgress', () => {
  it('accepts a v1 flow or page snapshot', () => {
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 1, kind: 'flow', index: 2, ratio: 0.4, updatedAt: 10 }),
      ),
    ).toEqual({ version: 1, kind: 'flow', index: 2, ratio: 0.4, updatedAt: 10 });
    expect(
      parseReadingProgress(JSON.stringify({ version: 1, kind: 'page', index: 7, ratio: 0 })),
    ).toMatchObject({ kind: 'page', index: 7, ratio: 0 });
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 1, kind: 'flow', index: 3, ratio: 0.2, total: 12, updatedAt: 1 }),
      ),
    ).toMatchObject({ index: 3, total: 12 });
  });

  it('rejects corrupt or unknown records', () => {
    expect(parseReadingProgress('')).toBeNull();
    expect(parseReadingProgress('{')).toBeNull();
    expect(parseReadingProgress(JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0 }))).toBeNull();
    expect(parseReadingProgress(JSON.stringify({ version: 1, kind: 'flow', index: -1, ratio: 0 }))).toBeNull();
  });
});

describe('load/saveReadingProgress', () => {
  it('round-trips by content hash and ignores storage failures', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(storage, '0123456789abcdef', {
      version: 1,
      kind: 'flow',
      index: 3,
      ratio: 0.25,
      updatedAt: 1,
    });
    expect(store[readingProgressKey('0123456789abcdef')]).toContain('"index":3');
    expect(loadReadingProgress(storage, '0123456789abcdef')?.index).toBe(3);

    expect(chapterScrollRatio(250, 100, 400)).toBe(0.375);
    expect(chapterScrollTop(100, 400, 0.375)).toBe(250);
    expect(loadReadingProgress(storage, '')).toBeNull();
    expect(
      loadReadingProgress(
        {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => undefined,
        },
        '0123456789abcdef',
      ),
    ).toBeNull();
  });
});
