import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../library-client.js';
import {
  dynamicAuthorAndSeriesGroups,
  smartGroupMatches,
} from '../library-smart-groups.js';

const item = (overrides: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'book',
  sourceKind: 'managed',
  title: 'Book',
  authors: ['Alice'],
  extension: 'epub',
  series: 'Saga',
  updatedAt: 1,
  ...overrides,
});

describe('smart library groups', () => {
  it('matches progress, kind, source and format rules', () => {
    expect(smartGroupMatches(item(), { type: 'format', value: 'epub' }, null)).toBe(true);
    expect(smartGroupMatches(item(), { type: 'source', value: 'managed' }, null)).toBe(true);
    expect(smartGroupMatches(item({ extension: 'cbz' }), { type: 'kind', value: 'comic' }, null)).toBe(true);
    expect(
      smartGroupMatches(item(), { type: 'progress', value: 'in-progress' }, {
        status: 'in-progress',
        unit: 'chapter',
        index: 1,
        ratio: 0,
      }),
    ).toBe(true);
  });

  it('does not classify a null blob hash as managed at the JSON boundary', () => {
    expect(
      smartGroupMatches(
        item({ sourceKind: 'local', blobHash: null as unknown as string }),
        { type: 'source', value: 'managed' },
        null,
      ),
    ).toBe(false);
  });

  it('only creates author and series groups with at least two books', () => {
    const groups = dynamicAuthorAndSeriesGroups([
      item({ id: 'a' }),
      item({ id: 'b', title: 'Book 2' }),
      item({ id: 'c', authors: ['Only'], series: 'Single' }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['smart:author:Alice', 'smart:series:Saga']);
  });
});
