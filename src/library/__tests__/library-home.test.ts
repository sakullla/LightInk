import { describe, expect, it } from 'vitest';

import type { LibraryItem } from '../library-client.js';
import type { LibraryProgress } from '../library-progress.js';
import { projectLibraryHomeReading } from '../library-home.js';

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

    expect(projected?.item.id).toBe('newer');
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
    expect(projected).toBeNull();
  });

  it('breaks equal clocks by title and then id', () => {
    const books = [item('b', 'Beta'), item('a', 'Alpha'), item('c', 'Alpha')];
    const projected = projectLibraryHomeReading(
      books,
      progressReader({
        b: progress('in-progress', 50),
        a: progress('in-progress', 50),
        c: progress('in-progress', 50),
      }),
    );

    expect(projected?.item.id).toBe('a');
  });

  it('returns nothing when no book is in progress', () => {
    const books = [item('done', 'Done'), item('unread', 'Unread')];
    expect(
      projectLibraryHomeReading(
        books,
        progressReader({
          done: progress('finished', 30),
          unread: { status: 'not-started' },
        }),
      ),
    ).toBeNull();
  });
});
