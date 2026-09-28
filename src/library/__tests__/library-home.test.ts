import { describe, expect, it } from 'vitest';

import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from '../library-client.js';
import type { LibraryProgress } from '../library-progress.js';
import {
  LIBRARY_HOME_RECENT_LIMIT,
  LIBRARY_HOME_SHORTCUT_LIMIT,
  LIBRARY_HOME_SHORTCUT_USAGE_KEY,
  libraryHomeShortcutCandidates,
  loadLibraryHomeShortcutUsage,
  parseLibraryHomeShortcutUsage,
  projectLibraryHomeReading,
  recordLibraryHomeShortcutUsage,
  selectLibraryHomeShortcuts,
  type LibraryHomeShortcutKey,
} from '../library-home.js';
import { isSyncableStorageKey, syncableStorageKeys } from '../../storage/syncable-storage.js';

const item = (id: string, title = id): LibraryItem => ({
  id,
  sourceKind: 'managed',
  title,
  authors: [],
  updatedAt: 999_999,
});

const progress = (
  status: 'in-progress' | 'finished',
  updatedAt: number | undefined,
): LibraryProgress => ({
  status,
  unit: 'chapter',
  index: 1,
  ratio: 0.2,
  ...(updatedAt === undefined ? {} : { updatedAt }),
});

function progressReader(records: Readonly<Record<string, LibraryProgress | null>>) {
  return (query: { readonly id: string }): LibraryProgress | null => records[query.id] ?? null;
}

function memoryStorage(initial?: string): {
  readonly values: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const values: Record<string, string> = {};
  if (initial !== undefined) values[LIBRARY_HOME_SHORTCUT_USAGE_KEY] = initial;
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

const groups: LibraryGroup[] = [
  { id: 'later', name: 'Later', kind: 'custom', sortOrder: 2 },
  { id: 'smart', name: 'Smart', kind: 'smart', sortOrder: 0 },
  { id: 'root', name: 'Root', kind: 'custom', sortOrder: 0 },
  { id: 'child', parentId: 'root', name: 'Child', kind: 'custom', sortOrder: 0 },
  { id: 'empty', name: 'Empty', kind: 'custom', sortOrder: 1 },
];

const groupMemberships: LibraryGroupMembership[] = [
  { groupId: 'child', itemId: 'a' },
  { groupId: 'later', itemId: 'b' },
  { groupId: 'empty', itemId: 'missing' },
];

const tags: LibraryTag[] = [
  { id: 'quiet', name: 'Quiet', createdAt: 1, updatedAt: 1 },
  { id: 'popular-z', name: 'Zulu', createdAt: 1, updatedAt: 1 },
  { id: 'popular-a', name: 'Alpha', createdAt: 1, updatedAt: 1 },
  { id: 'empty-tag', name: 'Empty', createdAt: 1, updatedAt: 1 },
];

const tagMemberships: LibraryTagMembership[] = [
  { tagId: 'quiet', itemId: 'a' },
  { tagId: 'popular-z', itemId: 'a' },
  { tagId: 'popular-z', itemId: 'b' },
  { tagId: 'popular-a', itemId: 'a' },
  { tagId: 'popular-a', itemId: 'b' },
  { tagId: 'empty-tag', itemId: 'missing' },
];

describe('library home reading projection', () => {
  it('selects the newest valid in-progress clock and ignores item update time', () => {
    const books = [item('older', 'Zulu'), item('newer', 'Alpha'), item('done'), item('unread')];
    const projected = projectLibraryHomeReading(
      books,
      progressReader({
        older: progress('in-progress', 10),
        newer: progress('in-progress', 20),
        done: progress('finished', 30),
        unread: { status: 'not-started' },
      }),
    );

    expect(projected.primary?.item.id).toBe('newer');
    expect(projected.recent.map((entry) => entry.item.id)).toEqual(['done', 'older']);
  });

  it('rejects missing, zero, negative and non-finite clocks', () => {
    const books = ['missing', 'zero', 'negative', 'infinite'].map((id) => item(id));
    const projected = projectLibraryHomeReading(
      books,
      progressReader({
        missing: progress('in-progress', undefined),
        zero: progress('in-progress', 0),
        negative: progress('finished', -1),
        infinite: progress('in-progress', Number.POSITIVE_INFINITY),
      }),
    );
    expect(projected).toEqual({ primary: null, recent: [] });
  });

  it('keeps deterministic ties, excludes the primary, and bounds recent reading', () => {
    const books = Array.from({ length: LIBRARY_HOME_RECENT_LIMIT + 3 }, (_, index) =>
      item(`book-${index}`, index === 0 ? 'Primary' : `Book ${String(index).padStart(2, '0')}`),
    );
    const records = Object.fromEntries(
      books.map((book, index) => [
        book.id,
        progress(index === 0 ? 'in-progress' : 'finished', index === 0 ? 100 : 50),
      ]),
    );
    const projected = projectLibraryHomeReading(books, progressReader(records));

    expect(projected.primary?.item.id).toBe('book-0');
    expect(projected.recent).toHaveLength(LIBRARY_HOME_RECENT_LIMIT);
    expect(projected.recent.map((entry) => entry.item.title)).toEqual(
      books.slice(1, LIBRARY_HOME_RECENT_LIMIT + 1).map((book) => book.title),
    );
    expect(projected.recent.some((entry) => entry.item.id === projected.primary?.item.id)).toBe(false);
  });
});

describe('library home shortcut projection', () => {
  it('includes only non-empty custom groups and tags in their stable fallback order', () => {
    const candidates = libraryHomeShortcutCandidates(
      [item('a'), item('b')],
      groups,
      groupMemberships,
      tags,
      tagMemberships,
    );

    expect(candidates.map((candidate) => candidate.key)).toEqual([
      'group:root',
      'group:child',
      'group:later',
      'tag:popular-a',
      'tag:popular-z',
      'tag:quiet',
    ]);
    expect(candidates.map((candidate) => candidate.itemCount)).toEqual([1, 1, 1, 2, 2, 1]);
  });

  it('preserves case- and diacritic-insensitive tag fallback ties', () => {
    const equivalentTags: LibraryTag[] = [
      { id: 'plain-first', name: 'eclair', createdAt: 1, updatedAt: 1 },
      { id: 'uppercase-second', name: 'ECLAIR', createdAt: 1, updatedAt: 1 },
      { id: 'accent-third', name: 'Éclair', createdAt: 1, updatedAt: 1 },
      { id: 'alpha', name: 'ALPHA', createdAt: 1, updatedAt: 1 },
    ];
    const equivalentMemberships: LibraryTagMembership[] = equivalentTags.map((tag) => ({
      tagId: tag.id,
      itemId: 'a',
    }));

    const candidates = libraryHomeShortcutCandidates(
      [item('a')],
      [],
      [],
      equivalentTags,
      equivalentMemberships,
    );

    expect(candidates.map((candidate) => candidate.key)).toEqual([
      'tag:alpha',
      'tag:plain-first',
      'tag:uppercase-second',
      'tag:accent-third',
    ]);
  });

  it('puts recent usage first without mutating the candidate fallback order', () => {
    const candidates = libraryHomeShortcutCandidates(
      [item('a'), item('b')],
      groups,
      groupMemberships,
      tags,
      tagMemberships,
    );
    const original = candidates.map((candidate) => candidate.key);
    const selected = selectLibraryHomeShortcuts(candidates, {
      'tag:quiet': 200,
      'group:later': 100,
    });

    expect(selected.map((candidate) => candidate.key)).toEqual([
      'tag:quiet',
      'group:later',
      'group:root',
      'group:child',
      'tag:popular-a',
      'tag:popular-z',
    ]);
    expect(candidates.map((candidate) => candidate.key)).toEqual(original);
  });

  it('bounds the selected shortcut count', () => {
    const candidates = Array.from({ length: LIBRARY_HOME_SHORTCUT_LIMIT + 5 }, (_, index) => ({
      key: `tag:${index}` as LibraryHomeShortcutKey,
      kind: 'tag' as const,
      id: String(index),
      name: String(index),
      itemCount: 1,
    }));
    expect(selectLibraryHomeShortcuts(candidates)).toHaveLength(LIBRARY_HOME_SHORTCUT_LIMIT);
  });
});

describe('local shortcut usage', () => {
  it('degrades malformed, wrong-version and invalid-field records to empty usage', () => {
    expect(parseLibraryHomeShortcutUsage('{bad')).toEqual({});
    expect(parseLibraryHomeShortcutUsage('{"version":2,"usedAt":{"tag:a":1}}')).toEqual({});
    expect(parseLibraryHomeShortcutUsage('{"version":1,"usedAt":{"tag:a":"yesterday"}}')).toEqual({});
    expect(parseLibraryHomeShortcutUsage('{"version":1,"usedAt":{"unknown:a":1}}')).toEqual({});
  });

  it('records usage, prunes deleted candidates, and tolerates storage failures', () => {
    const storage = memoryStorage(
      JSON.stringify({ version: 1, usedAt: { 'group:deleted': 5, 'tag:kept': 4 } }),
    );
    const valid = new Set<LibraryHomeShortcutKey>(['tag:kept', 'group:used']);
    expect(recordLibraryHomeShortcutUsage(storage, 'group:used', valid, 10)).toEqual({
      'group:used': 10,
      'tag:kept': 4,
    });
    expect(loadLibraryHomeShortcutUsage(storage)).toEqual({
      'group:used': 10,
      'tag:kept': 4,
    });

    const throwing = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => recordLibraryHomeShortcutUsage(throwing, 'tag:kept', valid, 20)).not.toThrow();
  });

  it('keeps the local-only key outside the sync allow-list', () => {
    expect(isSyncableStorageKey(LIBRARY_HOME_SHORTCUT_USAGE_KEY)).toBe(false);
    expect(syncableStorageKeys()).not.toContain(LIBRARY_HOME_SHORTCUT_USAGE_KEY);
  });
});
