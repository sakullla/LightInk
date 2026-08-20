import { describe, expect, it } from 'vitest';
import type { LibraryGroup } from '../library-client.js';
import {
  canPlaceGroup,
  customGroupTree,
  itemIdsForGroup,
  keyboardGroupPlacement,
} from '../library-group-tree.js';

const groups: LibraryGroup[] = [
  { id: 'root', name: 'Root', kind: 'custom', sortOrder: 0 },
  { id: 'other', name: 'Other', kind: 'custom', sortOrder: 1 },
  { id: 'child', parentId: 'root', name: 'Child', kind: 'custom', sortOrder: 0 },
  { id: 'leaf', parentId: 'child', name: 'Leaf', kind: 'custom', sortOrder: 0 },
];

describe('library group tree', () => {
  it('builds nested groups and aggregates descendant memberships without duplicates', () => {
    const tree = customGroupTree(groups);
    expect(tree.map((node) => node.group.id)).toEqual(['root', 'other']);
    expect(tree[0]?.children[0]?.children[0]?.group.id).toBe('leaf');
    expect(
      [...itemIdsForGroup(groups, [
        { groupId: 'root', itemId: 'book-a' },
        { groupId: 'child', itemId: 'book-a' },
        { groupId: 'leaf', itemId: 'book-b' },
      ], 'root')].sort(),
    ).toEqual(['book-a', 'book-b']);
  });

  it('maps keyboard reorder, indent and outdent to backend placements', () => {
    expect(keyboardGroupPlacement(groups, 'other', 'up')).toEqual({
      parentId: undefined,
      sortOrder: 0,
    });
    expect(keyboardGroupPlacement(groups, 'other', 'indent')).toEqual({
      parentId: 'root',
      sortOrder: 1,
    });
    expect(keyboardGroupPlacement(groups, 'child', 'outdent')).toEqual({
      parentId: undefined,
      sortOrder: 1,
    });
  });

  it('rejects frontend cycles and placements deeper than eight levels', () => {
    expect(canPlaceGroup(groups, 'root', 'leaf')).toBe(false);
    const chain: LibraryGroup[] = Array.from({ length: 8 }, (_, index) => ({
      id: `level-${index + 1}`,
      ...(index === 0 ? {} : { parentId: `level-${index}` }),
      name: `Level ${index + 1}`,
      kind: 'custom',
      sortOrder: 0,
    }));
    expect(canPlaceGroup(chain, undefined, 'level-8')).toBe(false);
  });

  it('recovers malformed cyclic input without recursing forever', () => {
    const cyclic: LibraryGroup[] = [
      { id: 'a', parentId: 'b', name: 'A', kind: 'custom', sortOrder: 0 },
      { id: 'b', parentId: 'a', name: 'B', kind: 'custom', sortOrder: 0 },
    ];
    expect(customGroupTree(cyclic).flatMap((node) => node.group.id)).toHaveLength(1);
  });
});
