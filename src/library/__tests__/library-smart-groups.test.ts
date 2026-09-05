import { describe, expect, it } from 'vitest';
import type { LibraryGroup, LibraryItem } from '../library-client.js';
import {
  dynamicAuthorAndSeriesGroups,
  dynamicSourceAndFormatGroups,
  isPerSourceSmartGroup,
  smartGroupFromRecord,
  smartGroupMatches,
  smartGroupTypeId,
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
    expect(groups.map(smartGroupTypeId)).toEqual(['author', 'series']);
  });

  it('does not create per-source smart groups from OPDS or WebDAV sourceId', () => {
    const groups = dynamicSourceAndFormatGroups([
      item({
        id: 'opds-book',
        sourceId: 'opds-1',
        sourceKind: 'opds',
        extension: 'epub',
        availability: 'remote',
      }),
      item({
        id: 'dav-book',
        sourceId: 'dav-1',
        sourceKind: 'webdav',
        extension: 'cbz',
        availability: 'remote',
      }),
    ]);
    expect(groups.map((group) => group.id)).toEqual(['smart:format:epub', 'smart:format:cbz']);
    expect(groups.some((group) => group.id.startsWith('smart:source:'))).toBe(false);
    expect(groups.some((group) => group.rule.type === 'source')).toBe(false);
    expect(groups.every((group) => smartGroupTypeId(group) === 'format')).toBe(true);
  });

  it('ignores persisted per-source smart group records', () => {
    const byId: LibraryGroup = {
      id: 'smart:source:opds-1',
      name: 'Catalog',
      kind: 'smart',
      rule: { type: 'source', value: 'id:opds-1' },
      sortOrder: 20,
    };
    const byRule: LibraryGroup = {
      id: 'legacy-source',
      name: 'Legacy',
      kind: 'smart',
      rule: { type: 'source', value: 'id:dav-1' },
      sortOrder: 21,
    };
    const remote: LibraryGroup = {
      id: 'smart:remote',
      name: 'Remote',
      kind: 'smart',
      rule: { type: 'source', value: 'remote' },
      sortOrder: 5,
    };
    expect(smartGroupFromRecord(byId)).toBeNull();
    expect(smartGroupFromRecord(byRule)).toBeNull();
    expect(isPerSourceSmartGroup({ id: byId.id, rule: { type: 'source', value: 'id:opds-1' } })).toBe(
      true,
    );
    const kept = smartGroupFromRecord(remote);
    expect(kept?.id).toBe('smart:remote');
    expect(kept && isPerSourceSmartGroup(kept)).toBe(false);
    expect(kept && smartGroupTypeId(kept)).toBe('fixed');
  });
});
