import { describe, expect, it } from 'vitest';

import {
  bindLibraryProgress,
  coverProgressFillPercent,
  formatLibraryReadingDuration,
  libraryProgressAliasKey,
  libraryProgressReadingMs,
  libraryProgressUpdatedAt,
  loadLibraryProgressAlias,
  migrateLibraryProgressAliases,
  projectLibraryProgress,
  saveLibraryProgressAlias,
  setLibraryProgressStatus,
} from '../library-progress.js';
import {
  loadReadingProgress,
  readingProgressKey,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from '../../reader/reading-progress.js';

function memoryStorage(initial: Record<string, string> = {}): ProgressStorage & {
  readonly store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

function flowProgress(overrides: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    version: 2,
    kind: 'flow',
    index: 2,
    ratio: 0.4,
    updatedAt: 10,
    ...overrides,
  };
}

function pageProgress(overrides: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    version: 2,
    kind: 'page',
    index: 7,
    ratio: 0,
    updatedAt: 10,
    ...overrides,
  };
}

describe('projectLibraryProgress', () => {
  it('marks an imported item without a record as not-started and omits 0%', () => {
    const storage = memoryStorage();
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toEqual({ status: 'not-started' });
  });

  it('derives an overall percent for flow progress when the chapter total is known', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress({ index: 3, ratio: 0.5, total: 10 }));
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 3,
      ratio: 0.5,
      percent: 35,
      updatedAt: 10,
    });
    expect(
      coverProgressFillPercent({
        status: 'in-progress',
        unit: 'chapter',
        index: 3,
        ratio: 0.5,
        percent: 35,
      }),
    ).toBe(35);
    expect(coverProgressFillPercent({ status: 'not-started' })).toBeNull();
  });

  it('joins a previously read local book by localPath when no alias exists', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress());
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 2,
      ratio: 0.4,
      updatedAt: 10,
    });
  });

  it('does not let a managed shelf row inherit another book\'s path-keyed progress', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/shared.epub', flowProgress({ index: 473, ratio: 1, total: 474 }));
    expect(
      projectLibraryProgress(storage, {
        id: 'managed:book-a',
        localPath: '/books/shared.epub',
      }),
    ).toEqual({ status: 'not-started' });
    expect(
      projectLibraryProgress(storage, {
        id: 'managed:book-b',
        localPath: '/books/shared.epub',
      }),
    ).toEqual({ status: 'not-started' });

    saveLibraryProgressAlias(storage, 'managed:book-a', '/books/shared.epub');
    expect(
      projectLibraryProgress(storage, {
        id: 'managed:book-a',
        localPath: '/books/shared.epub',
      }),
      ).toMatchObject({ status: 'in-progress', index: 473, updatedAt: 10 });
    expect(
      projectLibraryProgress(storage, {
        id: 'managed:book-b',
        localPath: '/books/shared.epub',
      }),
    ).toEqual({ status: 'not-started' });
  });

  it('joins through the item.id alias after open, not another book\'s path', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, 'content-hash-a', flowProgress({ index: 3, ratio: 0.2 }));
    saveReadingProgress(storage, '/books/b.epub', flowProgress({ index: 8, ratio: 0.9 }));
    saveLibraryProgressAlias(storage, 'item-a', 'content-hash-a');

    expect(
      projectLibraryProgress(storage, { id: 'item-a', localPath: '/books/a.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 3,
      ratio: 0.2,
      updatedAt: 10,
    });
    expect(
      projectLibraryProgress(storage, { id: 'item-b', localPath: '/books/b.epub' }),
    ).toEqual({ status: 'not-started' });
    saveLibraryProgressAlias(storage, 'item-b', '/books/b.epub');
    expect(
      projectLibraryProgress(storage, { id: 'item-b', localPath: '/books/b.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 8,
      ratio: 0.9,
      updatedAt: 10,
    });
  });

  it('does not treat item.id as a progress key', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, 'opds:source-1:entry-1', flowProgress());
    expect(
      projectLibraryProgress(storage, { id: 'opds:source-1:entry-1' }),
    ).toEqual({ status: 'not-started' });
  });

  it('returns null for an unopened OPDS catalog row instead of forging progress', () => {
    const storage = memoryStorage();
    expect(
      projectLibraryProgress(
        storage,
        { id: 'opds:source-1:entry-1' },
        { catalogEntry: true },
      ),
    ).toBeNull();
  });

  it('shows real progress for a catalog row only after an alias exists', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, 'remote-identity', pageProgress({ index: 12 }));
    saveLibraryProgressAlias(storage, 'item-1', 'remote-identity');
    expect(
      projectLibraryProgress(storage, { id: 'item-1', pageCount: 40 }, { catalogEntry: true }),
    ).toEqual({
      status: 'in-progress',
      unit: 'page',
      index: 12,
      ratio: 0,
      percent: 30,
      updatedAt: 10,
    });
  });

  it('falls back to not-started when alias or JSON is missing or corrupt', () => {
    const storage = memoryStorage();
    saveLibraryProgressAlias(storage, 'item-a', 'missing-hash');
    expect(projectLibraryProgress(storage, { id: 'item-a' })).toEqual({ status: 'not-started' });

    storage.setItem(readingProgressKey('broken-hash'), '{');
    saveLibraryProgressAlias(storage, 'item-b', 'broken-hash');
    const broken = projectLibraryProgress(storage, { id: 'item-b' });
    expect(broken).toEqual({ status: 'not-started' });
    expect(broken).not.toHaveProperty('percent');
  });

  it('uses page units for comics and omits a 0% badge at the first page', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/comics/a.cbz', pageProgress({ index: 0 }));
    expect(
      projectLibraryProgress(storage, {
        id: 'local:/comics/a.cbz',
        localPath: '/comics/a.cbz',
        pageCount: 20,
      }),
    ).toEqual({
      status: 'in-progress',
      unit: 'page',
      index: 0,
      ratio: 0,
      updatedAt: 10,
    });
  });

  it('forwards a usable heading onto the shelf projection', () => {
    const storage = memoryStorage();
    saveReadingProgress(
      storage,
      '/books/a.epub',
      flowProgress({ title: '第1997章 浓浓的火药味', total: 2530, index: 1996, ratio: 0.5 }),
    );
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toMatchObject({
      status: 'in-progress',
      title: '第1997章 浓浓的火药味',
    });

    saveReadingProgress(storage, '/books/a.epub', flowProgress({ title: 'ccdqxkhp' }));
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).not.toHaveProperty('title');
  });

  it('forwards ReadingProgress.updatedAt onto in-progress projections', () => {
    const storage = memoryStorage();
    saveReadingProgress(
      storage,
      '/books/a.epub',
      flowProgress({ updatedAt: 1_700_000_000_000 }),
    );
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 2,
      ratio: 0.4,
      updatedAt: 1_700_000_000_000,
    });
  });

  it('keeps each in-progress item on its own reading clock', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/older.epub', flowProgress({ updatedAt: 100 }));
    saveReadingProgress(storage, '/books/newer.epub', flowProgress({ index: 5, updatedAt: 200 }));
    expect(
      projectLibraryProgress(storage, {
        id: 'local:/books/older.epub',
        localPath: '/books/older.epub',
      }),
    ).toMatchObject({ status: 'in-progress', updatedAt: 100 });
    expect(
      projectLibraryProgress(storage, {
        id: 'local:/books/newer.epub',
        localPath: '/books/newer.epub',
      }),
    ).toMatchObject({ status: 'in-progress', index: 5, updatedAt: 200 });
  });

  it('treats missing or non-finite progress clocks as 0 without throwing', () => {
    const storage = memoryStorage();
    const query = { id: 'local:/books/a.epub', localPath: '/books/a.epub' };
    const expected = {
      status: 'in-progress' as const,
      unit: 'chapter' as const,
      index: 2,
      ratio: 0.4,
      updatedAt: 0,
    };

    expect(() => {
      storage.setItem(
        readingProgressKey('/books/a.epub'),
        JSON.stringify({ version: 2, kind: 'flow', index: 2, ratio: 0.4 }),
      );
      expect(projectLibraryProgress(storage, query)).toEqual(expected);
    }).not.toThrow();

    storage.setItem(
      readingProgressKey('/books/a.epub'),
      '{"version":2,"kind":"flow","index":2,"ratio":0.4,"updatedAt":1e1000}',
    );
    expect(() => projectLibraryProgress(storage, query)).not.toThrow();
    expect(projectLibraryProgress(storage, query)).toEqual(expected);

    storage.setItem(
      readingProgressKey('/books/a.epub'),
      '{"version":2,"kind":"flow","index":2,"ratio":0.4,"updatedAt":-1e1000}',
    );
    expect(projectLibraryProgress(storage, query)).toEqual(expected);

    storage.setItem(
      readingProgressKey('/books/a.epub'),
      '{"version":2,"kind":"flow","index":2,"ratio":0.4,"updatedAt":null}',
    );
    expect(projectLibraryProgress(storage, query)).toEqual(expected);
  });

  it('returns not-started when storage is missing or throws', () => {
    expect(projectLibraryProgress(null, { id: 'local:/books/a.epub' })).toEqual({
      status: 'not-started',
    });
    expect(
      projectLibraryProgress(
        {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => undefined,
        },
        { id: 'item-a', localPath: '/books/a.epub' },
      ),
    ).toEqual({ status: 'not-started' });
  });
});

describe('library progress alias', () => {
  it('round-trips an alias and ignores empty ids', () => {
    const storage = memoryStorage();
    saveLibraryProgressAlias(storage, 'item-a', 'hash-a');
    expect(loadLibraryProgressAlias(storage, 'item-a')).toBe('hash-a');
    expect(storage.store[libraryProgressAliasKey('item-a')]).toBe('hash-a');

    saveLibraryProgressAlias(storage, '', 'hash-a');
    saveLibraryProgressAlias(storage, 'item-b', '');
    expect(loadLibraryProgressAlias(storage, 'item-b')).toBeNull();
    expect(loadLibraryProgressAlias(null, 'item-a')).toBeNull();
  });

  it('moves legacy reader identities to managed item ids', () => {
    const storage = memoryStorage();
    saveLibraryProgressAlias(storage, 'local:/books/a.epub', 'content-hash-a');
    migrateLibraryProgressAliases(
      storage,
      [
        {
          aliasId: 'local:/books/a.epub',
          itemId: 'managed:hash-a',
        },
        {
          aliasId: 'local:/books/b.epub',
          itemId: 'managed:hash-b',
        },
      ],
      new Map([['local:/books/b.epub', '/books/b.epub']]),
    );

    expect(loadLibraryProgressAlias(storage, 'managed:hash-a')).toBe('content-hash-a');
    expect(loadLibraryProgressAlias(storage, 'managed:hash-b')).toBe('/books/b.epub');
  });
});

describe('libraryProgressUpdatedAt', () => {
  it('returns the finite reading clock and treats missing or non-finite as 0', () => {
    expect(
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'chapter',
        index: 2,
        ratio: 0.4,
        updatedAt: 42,
      }),
    ).toBe(42);
    expect(libraryProgressUpdatedAt({ status: 'not-started' })).toBe(0);
    expect(
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'chapter',
        index: 2,
        ratio: 0.4,
      }),
    ).toBe(0);
    expect(() =>
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'page',
        index: 1,
        ratio: 0,
        updatedAt: Number.NaN,
      }),
    ).not.toThrow();
    expect(
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'page',
        index: 1,
        ratio: 0,
        updatedAt: Number.NaN,
      }),
    ).toBe(0);
    expect(
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'page',
        index: 1,
        ratio: 0,
        updatedAt: Number.POSITIVE_INFINITY,
      }),
    ).toBe(0);
    expect(
      libraryProgressUpdatedAt({
        status: 'in-progress',
        unit: 'page',
        index: 1,
        ratio: 0,
        updatedAt: Number.NEGATIVE_INFINITY,
      }),
    ).toBe(0);
  });
});

describe('finished projection and reading time (R4)', () => {
  it('projects ReadingProgress.status finished with a pinned 100 percent and a full cover bar', () => {
    const storage = memoryStorage();
    saveReadingProgress(
      storage,
      '/books/a.epub',
      flowProgress({ index: 9, ratio: 1, total: 10, status: 'finished' }),
    );
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' }),
    ).toEqual({
      status: 'finished',
      unit: 'chapter',
      index: 9,
      ratio: 1,
      percent: 100,
      updatedAt: 10,
    });
    expect(
      coverProgressFillPercent({
        status: 'finished',
        unit: 'chapter',
        index: 9,
        ratio: 1,
        percent: 100,
      }),
    ).toBe(100);
  });

  it('forwards accumulated readingMs and omits zero or missing values', () => {
    const storage = memoryStorage();
    const query = { id: 'local:/books/a.epub', localPath: '/books/a.epub' };
    saveReadingProgress(storage, '/books/a.epub', flowProgress({ readingMs: 3_720_000 }));
    expect(projectLibraryProgress(storage, query)).toMatchObject({
      status: 'in-progress',
      readingMs: 3_720_000,
    });

    saveReadingProgress(storage, '/books/a.epub', flowProgress({ readingMs: 0 }));
    expect(projectLibraryProgress(storage, query)).not.toHaveProperty('readingMs');

    saveReadingProgress(storage, '/books/a.epub', flowProgress());
    expect(projectLibraryProgress(storage, query)).not.toHaveProperty('readingMs');
  });

  it('joins finished progress through the item alias as well', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, 'content-hash-a', pageProgress({ status: 'finished' }));
    saveLibraryProgressAlias(storage, 'managed:book-a', 'content-hash-a');
    expect(
      projectLibraryProgress(storage, { id: 'managed:book-a', localPath: '/books/shared.cbz' }),
    ).toMatchObject({ status: 'finished', unit: 'page', percent: 100 });
  });
});

describe('libraryProgressReadingMs / formatLibraryReadingDuration', () => {
  it('reads the accumulated clock safely and formats compact durations', () => {
    expect(libraryProgressReadingMs({ status: 'not-started' })).toBe(0);
    expect(
      libraryProgressReadingMs({ status: 'in-progress', unit: 'chapter', index: 1, ratio: 0 }),
    ).toBe(0);
    expect(
      libraryProgressReadingMs({
        status: 'finished',
        unit: 'page',
        index: 12,
        ratio: 0,
        readingMs: 11_520_000,
      }),
    ).toBe(11_520_000);

    expect(formatLibraryReadingDuration(0)).toBe('');
    expect(formatLibraryReadingDuration(59_999)).toBe('');
    expect(formatLibraryReadingDuration(Number.NaN)).toBe('');
    expect(formatLibraryReadingDuration(60_000)).toBe('1m');
    expect(formatLibraryReadingDuration(45 * 60_000)).toBe('45m');
    expect(formatLibraryReadingDuration(3_600_000)).toBe('1h');
    expect(formatLibraryReadingDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3h12m');
  });
});

describe('setLibraryProgressStatus', () => {
  it('marks an in-progress record finished, keeping the v2 shape and refreshing updatedAt', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress({ total: 10, readingMs: 3_600_000 }));
    const changed = setLibraryProgressStatus(
      storage,
      { id: 'local:/books/a.epub', localPath: '/books/a.epub' },
      'finished',
      1234,
    );
    expect(changed).toBe(true);
    expect(loadReadingProgress(storage, '/books/a.epub')).toEqual({
      version: 2,
      kind: 'flow',
      index: 2,
      ratio: 0.4,
      total: 10,
      updatedAt: 1234,
      readingMs: 3_600_000,
      status: 'finished',
    });
    expect(
      projectLibraryProgress(storage, { id: 'local:/books/a.epub', localPath: '/books/a.epub' })
        ?.status,
    ).toBe('finished');
  });

  it('returns a finished record to in-progress by dropping the status field', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress({ status: 'finished' }));
    const changed = setLibraryProgressStatus(
      storage,
      { id: 'local:/books/a.epub', localPath: '/books/a.epub' },
      'in-progress',
      5678,
    );
    expect(changed).toBe(true);
    const record = loadReadingProgress(storage, '/books/a.epub');
    expect(record).toEqual({ version: 2, kind: 'flow', index: 2, ratio: 0.4, updatedAt: 5678 });
    expect(record).not.toHaveProperty('status');
  });

  it('writes through the item alias and refuses books without a record', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, 'content-hash-a', flowProgress());
    saveLibraryProgressAlias(storage, 'managed:book-a', 'content-hash-a');
    expect(
      setLibraryProgressStatus(
        storage,
        { id: 'managed:book-a', localPath: '/books/shared.epub' },
        'finished',
        42,
      ),
    ).toBe(true);
    expect(loadReadingProgress(storage, 'content-hash-a')?.status).toBe('finished');
    // book-b shares the path but has no alias/record: never forge a write.
    expect(
      setLibraryProgressStatus(
        storage,
        { id: 'managed:book-b', localPath: '/books/shared.epub' },
        'finished',
      ),
    ).toBe(false);
    expect(setLibraryProgressStatus(null, { id: 'local:/books/a.epub' }, 'finished')).toBe(false);
  });
});

describe('bindLibraryProgress', () => {  it('binds storage for injected getProgress(item) consumers', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress());
    const getProgress = bindLibraryProgress(storage);
    expect(getProgress({ id: 'local:/books/a.epub', localPath: '/books/a.epub' })?.status).toBe(
      'in-progress',
    );
    expect(getProgress({ id: 'opds:source-1:entry-1' }, { catalogEntry: true })).toBeNull();
  });
});
