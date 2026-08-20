import type { LibraryGroup, LibraryGroupMembership } from './library-client.js';

export interface LibraryGroupNode {
  readonly group: LibraryGroup;
  readonly depth: number;
  readonly children: readonly LibraryGroupNode[];
}

export type GroupKeyboardMove = 'up' | 'down' | 'outdent' | 'indent';

export interface GroupPlacement {
  readonly parentId?: string;
  readonly sortOrder: number;
}

function ordered(groups: readonly LibraryGroup[]): LibraryGroup[] {
  return [...groups].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
}

export function customGroupTree(groups: readonly LibraryGroup[]): LibraryGroupNode[] {
  const custom = groups.filter((group) => group.kind === 'custom');
  const byParent = new Map<string | undefined, LibraryGroup[]>();
  const ids = new Set(custom.map((group) => group.id));
  for (const group of custom) {
    const parentId = group.parentId !== undefined && ids.has(group.parentId) ? group.parentId : undefined;
    const children = byParent.get(parentId) ?? [];
    children.push(group);
    byParent.set(parentId, children);
  }
  for (const [parentId, children] of byParent) {
    byParent.set(parentId, ordered(children));
  }

  const visited = new Set<string>();
  const build = (group: LibraryGroup, depth: number, path: Set<string>): LibraryGroupNode | null => {
    if (path.has(group.id) || visited.has(group.id)) return null;
    visited.add(group.id);
    const nextPath = new Set(path).add(group.id);
    const children = (byParent.get(group.id) ?? [])
      .map((child) => build(child, depth + 1, nextPath))
      .filter((child): child is LibraryGroupNode => child !== null);
    return { group, depth, children };
  };

  const roots = (byParent.get(undefined) ?? [])
    .map((group) => build(group, 0, new Set()))
    .filter((node): node is LibraryGroupNode => node !== null);
  for (const group of ordered(custom)) {
    if (!visited.has(group.id)) {
      const recovered = build(group, 0, new Set());
      if (recovered !== null) roots.push(recovered);
    }
  }
  return roots;
}

export function descendantGroupIds(
  groups: readonly LibraryGroup[],
  groupId: string,
): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parentId === undefined) continue;
    const current = children.get(group.parentId) ?? [];
    current.push(group.id);
    children.set(group.parentId, current);
  }
  const found = new Set<string>();
  const pending = [groupId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (found.has(current)) continue;
    found.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return found;
}

export function itemIdsForGroup(
  groups: readonly LibraryGroup[],
  memberships: readonly LibraryGroupMembership[],
  groupId: string,
): ReadonlySet<string> {
  const includedGroups = descendantGroupIds(groups, groupId);
  return new Set(
    memberships
      .filter((membership) => includedGroups.has(membership.groupId))
      .map((membership) => membership.itemId),
  );
}

export function canPlaceGroup(
  groups: readonly LibraryGroup[],
  groupId: string | undefined,
  parentId: string | undefined,
  maxDepth = 8,
): boolean {
  if (groupId !== undefined && parentId !== undefined) {
    if (descendantGroupIds(groups, groupId).has(parentId)) return false;
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  let parentDepth = 0;
  let current = parentId;
  const seenParents = new Set<string>();
  while (current !== undefined) {
    if (seenParents.has(current)) return false;
    seenParents.add(current);
    const parent = byId.get(current);
    if (parent === undefined || parent.kind !== 'custom') return false;
    parentDepth += 1;
    current = parent.parentId;
  }
  let subtreeHeight = 1;
  if (groupId !== undefined) {
    const pending: Array<{ readonly id: string; readonly depth: number }> = [
      { id: groupId, depth: 1 },
    ];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      subtreeHeight = Math.max(subtreeHeight, node.depth);
      for (const child of groups.filter((candidate) => candidate.parentId === node.id)) {
        pending.push({ id: child.id, depth: node.depth + 1 });
      }
    }
  }
  return parentDepth + subtreeHeight <= maxDepth;
}

function siblingsOf(groups: readonly LibraryGroup[], parentId: string | undefined): LibraryGroup[] {
  return ordered(
    groups.filter((candidate) => candidate.kind === 'custom' && candidate.parentId === parentId),
  );
}

export function keyboardGroupPlacement(
  groups: readonly LibraryGroup[],
  groupId: string,
  move: GroupKeyboardMove,
): GroupPlacement | null {
  const group = groups.find((candidate) => candidate.id === groupId && candidate.kind === 'custom');
  if (group === undefined) return null;
  const siblings = siblingsOf(groups, group.parentId);
  const index = siblings.findIndex((candidate) => candidate.id === groupId);
  if (index < 0) return null;
  if (move === 'up') {
    return index === 0 ? null : { parentId: group.parentId, sortOrder: index - 1 };
  }
  if (move === 'down') {
    return index >= siblings.length - 1
      ? null
      : { parentId: group.parentId, sortOrder: index + 1 };
  }
  if (move === 'indent') {
    const previous = siblings[index - 1];
    if (previous === undefined) return null;
    return {
      parentId: previous.id,
      sortOrder: siblingsOf(groups, previous.id).length,
    };
  }
  if (group.parentId === undefined) return null;
  const parent = groups.find((candidate) => candidate.id === group.parentId);
  if (parent === undefined) return { sortOrder: siblingsOf(groups, undefined).length };
  const parentSiblings = siblingsOf(groups, parent.parentId);
  const parentIndex = parentSiblings.findIndex((candidate) => candidate.id === parent.id);
  return {
    parentId: parent.parentId,
    sortOrder: parentIndex < 0 ? parentSiblings.length : parentIndex + 1,
  };
}
