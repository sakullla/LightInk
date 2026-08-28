/**
 * Per-document reading position. Keyed by content hash (preferred) or file path.
 * Stored in localStorage so reopening a book resumes instead of starting over.
 */

import { isUsableEpubChapterTitle } from './chapter-title.js';

export const READING_PROGRESS_KEY_PREFIX = 'lightink.reader.progress.';

/** R7：进度条数上限——超出时按最近使用（updatedAt 最旧）淘汰，防 localStorage 无限增长。 */
export const READING_PROGRESS_MAX_ENTRIES = 50;

const CONTENT_HASH_PATTERN = /^[0-9a-f]{16}$/;

/** Content-hash progress ids match Rust `validate_content_hash` (16 lowercase hex). */
export function isContentHashProgressId(id: string): boolean {
  return CONTENT_HASH_PATTERN.test(id);
}

export interface ReadingProgress {
  readonly version: 1;
  readonly kind: 'flow' | 'page';
  /** 0-based chapter for flow; 1-based page for pdf/cbz. */
  readonly index: number;
  /** Document scroll ratio 0..1 for flow; unused for page. */
  readonly ratio: number;
  /** Chapter count for flow, page count for pdf/cbz. Used by the shelf bar. */
  readonly total?: number;
  /** Current heading when known; shelf cards prefer this over “Chapter N”. */
  readonly title?: string;
  readonly updatedAt: number;
}

export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** 以下枚举/删除能力仅淘汰需要；注入的最小存储缺省时跳过淘汰。 */
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
}

export function readingProgressKey(id: string): string {
  return `${READING_PROGRESS_KEY_PREFIX}${id}`;
}

/** Keep a heading only when it is short and not converter junk. */
export function sanitizeReadingProgressTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return isUsableEpubChapterTitle(trimmed) ? trimmed : undefined;
}

export function parseReadingProgress(raw: string | null | undefined): ReadingProgress | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReadingProgress>;
    if (parsed.version !== 1 || (parsed.kind !== 'flow' && parsed.kind !== 'page')) {
      return null;
    }
    const index = parsed.index;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      return null;
    }
    if (typeof parsed.ratio !== 'number' || !Number.isFinite(parsed.ratio)) {
      return null;
    }
    const total =
      parsed.total !== undefined && Number.isSafeInteger(parsed.total) && parsed.total >= 1
        ? parsed.total
        : undefined;
    const title = sanitizeReadingProgressTitle(parsed.title);
    return {
      version: 1,
      kind: parsed.kind,
      index,
      ratio: Math.min(1, Math.max(0, parsed.ratio)),
      ...(total === undefined ? {} : { total }),
      ...(title === undefined ? {} : { title }),
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    };
  } catch {
    return null;
  }
}

export function serializeReadingProgress(progress: ReadingProgress): string {
  return JSON.stringify(progress);
}

export function loadReadingProgress(
  storage: ProgressStorage | null | undefined,
  id: string,
): ReadingProgress | null {
  if (storage == null || id === '') {
    return null;
  }
  try {
    return parseReadingProgress(storage.getItem(readingProgressKey(id)));
  } catch {
    return null;
  }
}

/** First matching record. Used to migrate OPDS keys off etag/session identities. */
export function loadReadingProgressFromIds(
  storage: ProgressStorage | null | undefined,
  ids: readonly string[],
): ReadingProgress | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const found = loadReadingProgress(storage, id);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

interface StoredProgressEntry {
  readonly key: string;
  readonly id: string;
  readonly progress: ReadingProgress | null;
}

function listStoredProgressEntries(storage: ProgressStorage): StoredProgressEntry[] {
  if (typeof storage.key !== 'function' || typeof storage.length !== 'number') {
    return [];
  }
  const entries: StoredProgressEntry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (storageKey === null || !storageKey.startsWith(READING_PROGRESS_KEY_PREFIX)) {
      continue;
    }
    entries.push({
      key: storageKey,
      id: storageKey.slice(READING_PROGRESS_KEY_PREFIX.length),
      progress: parseReadingProgress(storage.getItem(storageKey)),
    });
  }
  return entries;
}

/**
 * R7：按最近使用淘汰进度条目（updatedAt 最旧的先删，无法解析的按 0 处理
 * 最先淘汰）。仅当存储具备枚举/删除能力（生产 localStorage）时执行。
 */
function evictReadingProgress(storage: ProgressStorage): void {
  if (typeof storage.removeItem !== 'function') {
    return;
  }
  try {
    const entries = listStoredProgressEntries(storage).map((entry) => ({
      key: entry.key,
      updatedAt: entry.progress?.updatedAt ?? 0,
    }));
    const overflow = entries.length - READING_PROGRESS_MAX_ENTRIES;
    if (overflow <= 0) {
      return;
    }
    entries.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of entries.slice(0, overflow)) {
      storage.removeItem(entry.key);
    }
  } catch {
    // 淘汰失败（隐私模式/枚举异常）不阻断阅读。
  }
}

export function saveReadingProgress(
  storage: ProgressStorage | null | undefined,
  id: string,
  progress: ReadingProgress,
): void {
  if (storage == null || id === '') {
    return;
  }
  try {
    storage.setItem(readingProgressKey(id), serializeReadingProgress(progress));
  } catch {
    // Quota / privacy mode must not interrupt reading.
  }
  evictReadingProgress(storage);
}

/** Same-book last-write-wins: newer updatedAt wins; equal clocks keep local. */
export function mergeReadingProgress(
  local: ReadingProgress | null | undefined,
  remote: ReadingProgress | null | undefined,
): ReadingProgress | null {
  if (local == null) {
    return remote ?? null;
  }
  if (remote == null) {
    return local;
  }
  return remote.updatedAt > local.updatedAt ? remote : local;
}

export type ReadingProgressByHash = Readonly<Record<string, ReadingProgress>>;

export interface ItemContentHash {
  readonly itemId: string;
  readonly contentHash: string;
}

/** Keep valid itemId + 16-hex content hash pairs; later entries overwrite. */
export function listItemContentHashes(
  candidates: readonly { readonly itemId: string; readonly contentHash?: string | null }[],
): ItemContentHash[] {
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const itemId = candidate.itemId.trim();
    const hash = candidate.contentHash?.trim() ?? '';
    if (itemId === '' || !isContentHashProgressId(hash)) {
      continue;
    }
    unique.set(itemId, hash);
  }
  return [...unique.entries()].map(([itemId, contentHash]) => ({ itemId, contentHash }));
}

/** Scan alias keys (`prefix + itemId` → content hash) for sync membership mapping. */
export function listAliasItemContentHashes(
  storage: ProgressStorage | null | undefined,
  aliasPrefix: string,
): ItemContentHash[] {
  if (storage == null || aliasPrefix === '') {
    return [];
  }
  if (typeof storage.key !== 'function' || typeof storage.length !== 'number') {
    return [];
  }
  const candidates: Array<{ itemId: string; contentHash: string | null }> = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(aliasPrefix)) {
        continue;
      }
      candidates.push({
        itemId: key.slice(aliasPrefix.length),
        contentHash: storage.getItem(key),
      });
    }
  } catch {
    return [];
  }
  return listItemContentHashes(candidates);
}

/**
 * Merge progress maps keyed by content hash. Path keys and other non-hash ids
 * are skipped so they stay local-only.
 */
export function mergeReadingProgressByHash(
  local: ReadingProgressByHash,
  remote: ReadingProgressByHash,
): Record<string, ReadingProgress> {
  const merged: Record<string, ReadingProgress> = {};
  const hashes = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const hash of hashes) {
    if (!isContentHashProgressId(hash)) {
      continue;
    }
    const next = mergeReadingProgress(local[hash], remote[hash]);
    if (next !== null) {
      merged[hash] = next;
    }
  }
  return merged;
}

/** Collect hash-keyed progress for a sync document. Path keys are omitted. */
export function listReadingProgressByHash(
  storage: ProgressStorage | null | undefined,
): Record<string, ReadingProgress> {
  const records: Record<string, ReadingProgress> = {};
  if (storage == null) {
    return records;
  }
  try {
    for (const entry of listStoredProgressEntries(storage)) {
      if (entry.progress === null || !isContentHashProgressId(entry.id)) {
        continue;
      }
      records[entry.id] = entry.progress;
    }
  } catch {
    return {};
  }
  return records;
}

/**
 * Rehydrate hash-keyed progress from a sync document. Each key uses
 * last-write-wins against the local copy; eviction still applies.
 */
export function applyReadingProgressByHash(
  storage: ProgressStorage | null | undefined,
  records: ReadingProgressByHash,
): void {
  if (storage == null) {
    return;
  }
  for (const [id, incoming] of Object.entries(records)) {
    if (!isContentHashProgressId(id)) {
      continue;
    }
    const merged = mergeReadingProgress(loadReadingProgress(storage, id), incoming);
    if (merged !== null) {
      saveReadingProgress(storage, id, merged);
    }
  }
}

/** In-chapter progress 0..1 from a scroller's offset into a chapter box. */
export function chapterScrollRatio(
  scrollTop: number,
  chapterTop: number,
  chapterHeight: number,
): number {
  if (!(chapterHeight > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (scrollTop - chapterTop) / chapterHeight));
}

/** Scroll offset that puts the given in-chapter ratio at the top of the pane. */
export function chapterScrollTop(
  chapterTop: number,
  chapterHeight: number,
  ratio: number,
): number {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return Math.max(0, chapterTop + safe * Math.max(0, chapterHeight));
}

export function resolveProgressStorage(
  storage?: ProgressStorage | null,
): ProgressStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    // Privacy mode.
  }
  return null;
}
