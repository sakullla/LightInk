/**
 * Shelf progress projection (R2).
 *
 * Reads existing `ReadingProgress` plus an item.id → progressId alias.
 * Does not change LibraryItem / OpdsEntry schema. Catalog browse rows
 * without a saved position return null so cards never render a forged 0%.
 * Alias writes belong to the open-book path (`main.ts` / `reader-view`).
 */

import type { LibraryItem, LibraryItemAlias } from './library-client.js';
import {
  loadReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from '../reader/reading-progress.js';

export const LIBRARY_PROGRESS_ALIAS_PREFIX = 'lightink.library.progressAlias.';

export type LibraryProgressStatus = 'not-started' | 'in-progress';
export type LibraryProgressUnit = 'chapter' | 'page';

export interface LibraryProgressNotStarted {
  readonly status: 'not-started';
}

export interface LibraryProgressInProgress {
  readonly status: 'in-progress';
  /** Chapter is 0-based (flow); page is 1-based (pdf/cbz). */
  readonly unit: LibraryProgressUnit;
  readonly index: number;
  readonly ratio: number;
  /** Present only when a real positive percent can be derived. Never 0. */
  readonly percent?: number;
}

export type LibraryProgress = LibraryProgressNotStarted | LibraryProgressInProgress;

export type LibraryProgressQuery = Pick<LibraryItem, 'id' | 'localPath' | 'pageCount'>;

export interface ProjectLibraryProgressOptions {
  /**
   * OPDS catalog browse row (not an imported shelf item). Unopened remote
   * entries must not receive a not-started/0% badge.
   */
  readonly catalogEntry?: boolean;
}

export function libraryProgressAliasKey(itemId: string): string {
  return `${LIBRARY_PROGRESS_ALIAS_PREFIX}${itemId}`;
}

export function loadLibraryProgressAlias(
  storage: ProgressStorage | null | undefined,
  itemId: string,
): string | null {
  if (storage == null || itemId === '') {
    return null;
  }
  try {
    const raw = storage.getItem(libraryProgressAliasKey(itemId));
    if (raw === null || raw === undefined || raw === '') {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveLibraryProgressAlias(
  storage: ProgressStorage | null | undefined,
  itemId: string,
  progressId: string,
): void {
  if (storage == null || itemId === '' || progressId === '') {
    return;
  }
  try {
    storage.setItem(libraryProgressAliasKey(itemId), progressId);
  } catch {
    // Quota / privacy mode must not interrupt opening a book.
  }
}

/** Preserve a book's reader identity when a legacy shelf row becomes managed. */
export function migrateLibraryProgressAliases(
  storage: ProgressStorage | null | undefined,
  aliases: readonly LibraryItemAlias[],
  fallbackProgressIds: ReadonlyMap<string, string> = new Map(),
): void {
  for (const alias of aliases) {
    const progressId =
      loadLibraryProgressAlias(storage, alias.aliasId) ?? fallbackProgressIds.get(alias.aliasId);
    if (progressId !== undefined && progressId !== null && progressId !== '') {
      saveLibraryProgressAlias(storage, alias.itemId, progressId);
    }
  }
}

function resolveProgressId(
  storage: ProgressStorage | null | undefined,
  query: LibraryProgressQuery,
): string | null {
  const alias = loadLibraryProgressAlias(storage, query.id);
  if (alias !== null) {
    return alias;
  }
  if (query.localPath != null && query.localPath !== '') {
    return query.localPath;
  }
  return null;
}

function progressPercent(
  progress: ReadingProgress,
  pageCount: number | undefined,
): number | undefined {
  if (
    progress.kind !== 'page' ||
    pageCount === undefined ||
    !Number.isFinite(pageCount) ||
    pageCount <= 0
  ) {
    return undefined;
  }
  const raw = Math.round((progress.index / pageCount) * 100);
  if (raw <= 0) {
    return undefined;
  }
  return Math.min(100, raw);
}

function projectRecord(
  progress: ReadingProgress,
  pageCount: number | undefined,
): LibraryProgressInProgress {
  const percent = progressPercent(progress, pageCount);
  return {
    status: 'in-progress',
    unit: progress.kind === 'page' ? 'page' : 'chapter',
    index: progress.index,
    ratio: progress.ratio,
    ...(percent === undefined ? {} : { percent }),
  };
}

/**
 * Join a shelf item to saved reading progress.
 *
 * Imported items with no hit → `{ status: 'not-started' }` (no percent).
 * Catalog rows with no hit → `null` (do not render progress).
 * Item.id is never used as a progress key, so unopened OPDS ids cannot
 * pick up another book's record.
 */
export function projectLibraryProgress(
  storage: ProgressStorage | null | undefined,
  query: LibraryProgressQuery,
  options?: ProjectLibraryProgressOptions,
): LibraryProgress | null {
  const progressId = resolveProgressId(storage, query);
  const progress =
    progressId === null ? null : loadReadingProgress(storage, progressId);
  if (progress === null) {
    return options?.catalogEntry === true ? null : { status: 'not-started' };
  }
  return projectRecord(progress, query.pageCount);
}

export function bindLibraryProgress(
  storage?: ProgressStorage | null,
): (query: LibraryProgressQuery, options?: ProjectLibraryProgressOptions) => LibraryProgress | null {
  return (query, options) => projectLibraryProgress(storage, query, options);
}
