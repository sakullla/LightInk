import { describe, expect, it } from 'vitest';

import {
  bindLibraryProgress,
  libraryProgressAliasKey,
  loadLibraryProgressAlias,
  migrateLibraryProgressAliases,
  projectLibraryProgress,
  saveLibraryProgressAlias,
} from '../library-progress.js';
import {
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
    version: 1,
    kind: 'flow',
    index: 2,
    ratio: 0.4,
    updatedAt: 10,
    ...overrides,
  };
}

function pageProgress(overrides: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    version: 1,
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
    });
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
    });
    expect(
      projectLibraryProgress(storage, { id: 'item-b', localPath: '/books/b.epub' }),
    ).toEqual({
      status: 'in-progress',
      unit: 'chapter',
      index: 8,
      ratio: 0.9,
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
    });
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

describe('bindLibraryProgress', () => {
  it('binds storage for injected getProgress(item) consumers', () => {
    const storage = memoryStorage();
    saveReadingProgress(storage, '/books/a.epub', flowProgress());
    const getProgress = bindLibraryProgress(storage);
    expect(getProgress({ id: 'local:/books/a.epub', localPath: '/books/a.epub' })?.status).toBe(
      'in-progress',
    );
    expect(getProgress({ id: 'opds:source-1:entry-1' }, { catalogEntry: true })).toBeNull();
  });
});
