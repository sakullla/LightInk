import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from './library-client.js';
import {
  customGroupTree,
  itemIdsForGroup,
  type LibraryGroupNode,
} from './library-group-tree.js';
import type { LibraryProgress, LibraryProgressQuery } from './library-progress.js';

export const LIBRARY_HOME_RECENT_LIMIT = 8;
export const LIBRARY_HOME_SHORTCUT_LIMIT = 12;
export const LIBRARY_HOME_SHORTCUT_USAGE_KEY = 'lightink.library.homeShortcutUsage.v1';

const SHORTCUT_USAGE_VERSION = 1;
const MAX_STORED_SHORTCUT_USAGE = 100;

export interface LibraryHomeReadingEntry {
  readonly item: LibraryItem;
  readonly progress: Exclude<LibraryProgress, { readonly status: 'not-started' }>;
}

export interface LibraryHomeReadingProjection {
  readonly primary: LibraryHomeReadingEntry | null;
  readonly recent: readonly LibraryHomeReadingEntry[];
}

export type LibraryHomeProgressReader = (item: LibraryProgressQuery) => LibraryProgress | null;

export type LibraryHomeShortcutKey = `group:${string}` | `tag:${string}`;

export interface LibraryHomeShortcut {
  readonly key: LibraryHomeShortcutKey;
  readonly kind: 'group' | 'tag';
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
}

export type LibraryHomeShortcutUsage = Readonly<Record<LibraryHomeShortcutKey, number>>;

export interface LibraryHomeShortcutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function validUpdatedAt(progress: LibraryProgress): number {
  if (progress.status === 'not-started') return 0;
  const updatedAt = progress.updatedAt;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0
    ? updatedAt
    : 0;
}

function compareReadingEntries(
  left: LibraryHomeReadingEntry,
  right: LibraryHomeReadingEntry,
): number {
  const byTime = validUpdatedAt(right.progress) - validUpdatedAt(left.progress);
  if (byTime !== 0) return byTime;
  const byTitle = left.item.title.localeCompare(right.item.title);
  return byTitle !== 0 ? byTitle : left.item.id.localeCompare(right.item.id);
}

/**
 * Projects the unfiltered shelf into its continue-reading and recent-reading models.
 * Import time (`LibraryItem.updatedAt`) is deliberately ignored: only a valid reader
 * progress clock can make an item eligible.
 */
export function projectLibraryHomeReading(
  items: readonly LibraryItem[],
  getProgress: LibraryHomeProgressReader,
  recentLimit = LIBRARY_HOME_RECENT_LIMIT,
): LibraryHomeReadingProjection {
  const entries: LibraryHomeReadingEntry[] = [];
  for (const item of items) {
    const progress = getProgress(item);
    if (progress === null || progress.status === 'not-started' || validUpdatedAt(progress) === 0) {
      continue;
    }
    entries.push({ item, progress });
  }
  entries.sort(compareReadingEntries);

  const primary = entries.find((entry) => entry.progress.status === 'in-progress') ?? null;
  const boundedLimit = Number.isSafeInteger(recentLimit) ? Math.max(0, recentLimit) : 0;
  const recent = entries
    .filter((entry) => entry.item.id !== primary?.item.id)
    .slice(0, boundedLimit);
  return { primary, recent };
}

function flattenCustomGroups(groups: readonly LibraryGroup[]): LibraryGroup[] {
  const flattened: LibraryGroup[] = [];
  const visit = (nodes: readonly LibraryGroupNode[]): void => {
    for (const node of nodes) {
      flattened.push(node.group);
      visit(node.children);
    }
  };
  visit(customGroupTree(groups));
  return flattened;
}

function countTagItems(
  tagId: string,
  memberships: readonly LibraryTagMembership[],
  shelfItemIds: ReadonlySet<string>,
): number {
  return new Set(
    memberships
      .filter((membership) => membership.tagId === tagId && shelfItemIds.has(membership.itemId))
      .map((membership) => membership.itemId),
  ).size;
}

/** Builds the stable, non-empty custom-group and tag candidate sequence. */
export function libraryHomeShortcutCandidates(
  items: readonly LibraryItem[],
  groups: readonly LibraryGroup[],
  groupMemberships: readonly LibraryGroupMembership[],
  tags: readonly LibraryTag[],
  tagMemberships: readonly LibraryTagMembership[],
): LibraryHomeShortcut[] {
  const shelfItemIds = new Set(items.map((item) => item.id));
  const groupCandidates = flattenCustomGroups(groups).flatMap((group) => {
    const itemCount = [...itemIdsForGroup(groups, groupMemberships, group.id)].filter((itemId) =>
      shelfItemIds.has(itemId),
    ).length;
    return itemCount === 0
      ? []
      : [{
          key: `group:${group.id}` as const,
          kind: 'group' as const,
          id: group.id,
          name: group.name,
          itemCount,
        }];
  });
  const tagCandidates = tags
    .map((tag) => ({ tag, itemCount: countTagItems(tag.id, tagMemberships, shelfItemIds) }))
    .filter((candidate) => candidate.itemCount > 0)
    .sort(
      (left, right) =>
        right.itemCount - left.itemCount ||
        left.tag.name.localeCompare(right.tag.name, undefined, { sensitivity: 'base' }),
    )
    .map(({ tag, itemCount }) => ({
      key: `tag:${tag.id}` as const,
      kind: 'tag' as const,
      id: tag.id,
      name: tag.name,
      itemCount,
    }));
  return [...groupCandidates, ...tagCandidates];
}

/** Recent local usage wins; candidate order remains the deterministic fallback. */
export function selectLibraryHomeShortcuts(
  candidates: readonly LibraryHomeShortcut[],
  usage: LibraryHomeShortcutUsage = {},
  limit = LIBRARY_HOME_SHORTCUT_LIMIT,
): LibraryHomeShortcut[] {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, limit) : 0;
  return candidates
    .map((candidate, index) => ({ candidate, index, usedAt: usage[candidate.key] ?? 0 }))
    .sort((left, right) => right.usedAt - left.usedAt || left.index - right.index)
    .slice(0, boundedLimit)
    .map(({ candidate }) => candidate);
}

function isShortcutKey(value: string): value is LibraryHomeShortcutKey {
  return /^(group|tag):.+$/.test(value);
}

/** Corrupt, oversized, or wrong-version values safely degrade to no usage history. */
export function parseLibraryHomeShortcutUsage(raw: string | null | undefined): LibraryHomeShortcutUsage {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    if (record.version !== SHORTCUT_USAGE_VERSION) return {};
    const usedAt = record.usedAt;
    if (typeof usedAt !== 'object' || usedAt === null || Array.isArray(usedAt)) return {};
    const entries = Object.entries(usedAt as Record<string, unknown>);
    if (entries.length > MAX_STORED_SHORTCUT_USAGE) return {};
    if (
      entries.some(
        ([key, value]) =>
          !isShortcutKey(key) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0,
      )
    ) {
      return {};
    }
    return Object.fromEntries(entries) as LibraryHomeShortcutUsage;
  } catch {
    return {};
  }
}

export function loadLibraryHomeShortcutUsage(
  storage: LibraryHomeShortcutStorage | null | undefined,
): LibraryHomeShortcutUsage {
  if (storage == null) return {};
  try {
    return parseLibraryHomeShortcutUsage(storage.getItem(LIBRARY_HOME_SHORTCUT_USAGE_KEY));
  } catch {
    return {};
  }
}

function trimShortcutUsage(
  usage: LibraryHomeShortcutUsage,
  validKeys?: ReadonlySet<LibraryHomeShortcutKey>,
): LibraryHomeShortcutUsage {
  return Object.fromEntries(
    Object.entries(usage)
      .filter(([key]) => validKeys === undefined || validKeys.has(key as LibraryHomeShortcutKey))
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_STORED_SHORTCUT_USAGE),
  ) as LibraryHomeShortcutUsage;
}

export function saveLibraryHomeShortcutUsage(
  storage: LibraryHomeShortcutStorage | null | undefined,
  usage: LibraryHomeShortcutUsage,
  validKeys?: ReadonlySet<LibraryHomeShortcutKey>,
): LibraryHomeShortcutUsage {
  const trimmed = trimShortcutUsage(usage, validKeys);
  if (storage == null) return trimmed;
  try {
    storage.setItem(
      LIBRARY_HOME_SHORTCUT_USAGE_KEY,
      JSON.stringify({ version: SHORTCUT_USAGE_VERSION, usedAt: trimmed }),
    );
  } catch {
    // Local storage failures must never block group or tag navigation.
  }
  return trimmed;
}

/** Records a successful shortcut selection and prunes entries no longer in the candidate set. */
export function recordLibraryHomeShortcutUsage(
  storage: LibraryHomeShortcutStorage | null | undefined,
  key: LibraryHomeShortcutKey,
  validKeys?: ReadonlySet<LibraryHomeShortcutKey>,
  now = Date.now(),
): LibraryHomeShortcutUsage {
  const current = loadLibraryHomeShortcutUsage(storage);
  if (!Number.isFinite(now) || now <= 0) return saveLibraryHomeShortcutUsage(storage, current, validKeys);
  return saveLibraryHomeShortcutUsage(storage, { ...current, [key]: now }, validKeys);
}
