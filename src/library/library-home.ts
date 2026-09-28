import type { LibraryItem } from './library-client.js';
import type { LibraryProgress, LibraryProgressQuery } from './library-progress.js';

export interface LibraryHomeReadingEntry {
  readonly item: LibraryItem;
  readonly progress: Exclude<LibraryProgress, { readonly status: 'not-started' }>;
}

export type LibraryHomeProgressReader = (item: LibraryProgressQuery) => LibraryProgress | null;

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
 * Projects the unfiltered shelf to the single newest in-progress book.
 * Import time (`LibraryItem.updatedAt`) is ignored: only a valid reader
 * progress clock can make an item eligible. Finished books are not returned.
 */
export function projectLibraryHomeReading(
  items: readonly LibraryItem[],
  getProgress: LibraryHomeProgressReader,
): LibraryHomeReadingEntry | null {
  const entries: LibraryHomeReadingEntry[] = [];
  for (const item of items) {
    const progress = getProgress(item);
    if (progress === null || progress.status !== 'in-progress' || validUpdatedAt(progress) === 0) {
      continue;
    }
    entries.push({ item, progress });
  }
  entries.sort(compareReadingEntries);
  return entries[0] ?? null;
}
