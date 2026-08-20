/**
 * Single browser-storage boundary for state that may be synchronized.
 * Secrets, absolute paths, caches, live tabs and crash snapshots deliberately
 * stay outside this allow-list.
 */

export interface SyncStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface SyncableStorageOptions {
  readonly onChange?: (key: string, value: string | null) => void;
}

export type SyncStorageSnapshot = Readonly<Record<string, string>>;

const EXACT_SYNC_KEYS = new Set([
  'lightink.locale',
  'lightink.theme',
  'lightink.theme.customCss',
  'lightink.fontScale',
  'lightink.reading.layout',
  'lightink.reader.flow.layout',
  'lightink.reader.typography',
  'lightink.reader.theme',
  'lightink.reader.comic.preferences',
  'lightink.autosave.enabled',
  'lightink.chrome.pinned',
  'lightink.statusBar.visible',
  'lightink.outlineWidth',
  'lightink.opds.sources',
  'lightink.recent.managed',
]);

const READING_PROGRESS_PREFIX = 'lightink.reader.progress.';
const PROGRESS_ALIAS_PREFIX = 'lightink.library.progressAlias.';
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const HASH64_PATTERN = /^[0-9a-f]{16}$/i;
const OPDS_ITEM_PATTERN = /^opds-item-[0-9a-f]{32}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function portableProgressId(value: string): boolean {
  return SHA256_PATTERN.test(value) || HASH64_PATTERN.test(value) || OPDS_ITEM_PATTERN.test(value);
}

function portableLibraryItemId(value: string): boolean {
  return OPDS_ITEM_PATTERN.test(value) || (
    value.startsWith('managed:') && SHA256_PATTERN.test(value.slice('managed:'.length))
  );
}

function validReadingProgress(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return record.version === 1 &&
      (record.kind === 'flow' || record.kind === 'page') &&
      typeof record.index === 'number' && Number.isSafeInteger(record.index) && record.index >= 0 &&
      typeof record.ratio === 'number' && Number.isFinite(record.ratio) &&
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt);
  } catch {
    return false;
  }
}

function validManagedRecents(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length <= 20 && parsed.every(
      (item) => typeof item === 'string' && UUID_PATTERN.test(item),
    );
  } catch {
    return false;
  }
}

export function isSyncableStorageKey(key: string): boolean {
  if (EXACT_SYNC_KEYS.has(key)) return true;
  if (key.startsWith(READING_PROGRESS_PREFIX)) {
    return portableProgressId(key.slice(READING_PROGRESS_PREFIX.length));
  }
  if (key.startsWith(PROGRESS_ALIAS_PREFIX)) {
    return portableLibraryItemId(key.slice(PROGRESS_ALIAS_PREFIX.length));
  }
  return false;
}

export function isSyncableStorageEntry(key: string, value: string): boolean {
  if (!isSyncableStorageKey(key)) return false;
  if (key.startsWith(READING_PROGRESS_PREFIX)) return validReadingProgress(value);
  if (key.startsWith(PROGRESS_ALIAS_PREFIX)) return portableProgressId(value);
  if (key === 'lightink.recent.managed') return validManagedRecents(value);
  return true;
}

export function syncableStorageKeys(): readonly string[] {
  return [...EXACT_SYNC_KEYS].sort();
}

export class SyncableStorage implements SyncStorageLike {
  private readonly base: SyncStorageLike;
  private readonly onChange?: (key: string, value: string | null) => void;

  constructor(base: SyncStorageLike, options: SyncableStorageOptions = {}) {
    this.base = base;
    this.onChange = options.onChange;
  }

  get length(): number {
    return this.base.length;
  }

  key(index: number): string | null {
    return this.base.key(index);
  }

  getItem(key: string): string | null {
    try {
      return this.base.getItem(key);
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    const previousValue = isSyncableStorageKey(key) ? this.getItem(key) : null;
    const previous = previousValue !== null && isSyncableStorageEntry(key, previousValue)
      ? previousValue
      : null;
    this.base.setItem(key, value);
    if (!isSyncableStorageKey(key)) return;
    const next = isSyncableStorageEntry(key, value) ? value : null;
    if (previous !== next) this.onChange?.(key, next);
  }

  removeItem(key: string): void {
    const previous = isSyncableStorageKey(key) ? this.getItem(key) : null;
    const existed = previous !== null && isSyncableStorageEntry(key, previous);
    this.base.removeItem(key);
    if (existed) this.onChange?.(key, null);
  }

  snapshot(): SyncStorageSnapshot {
    const snapshot: Record<string, string> = {};
    for (const key of this.keys().filter(isSyncableStorageKey)) {
      const value = this.base.getItem(key);
      if (value !== null && isSyncableStorageEntry(key, value)) snapshot[key] = value;
    }
    return snapshot;
  }

  applySnapshot(snapshot: SyncStorageSnapshot): void {
    for (const [key, value] of Object.entries(snapshot)) {
      if (isSyncableStorageEntry(key, value)) this.setItem(key, value);
    }
  }

  private keys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < this.base.length; index += 1) {
      const key = this.base.key(index);
      if (key !== null && isSyncableStorageKey(key)) keys.push(key);
    }
    return keys;
  }
}

export function createSyncableStorage(
  base: SyncStorageLike,
  options?: SyncableStorageOptions,
): SyncableStorage {
  return new SyncableStorage(base, options);
}
