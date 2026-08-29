/**
 * Per-document reading position. Keyed by content hash (preferred) or file path.
 * Stored in localStorage so reopening a book resumes instead of starting over.
 */

import { isUsableEpubChapterTitle } from './chapter-title.js';

export const READING_PROGRESS_KEY_PREFIX = 'lightink.reader.progress.';

/** R7：进度条数上限——超出时按最近使用（updatedAt 最旧）淘汰，防 localStorage 无限增长。 */
export const READING_PROGRESS_MAX_ENTRIES = 50;

export interface ReadingProgress {
  readonly version: 2;
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
  /** 到达末页/末章末尾时置 'finished'；缺省即在读（R4 三态的"读完"来源）。 */
  readonly status?: 'finished';
  /** 累计阅读时长（ms），由会话在活跃时累计；缺省按 0 处理。 */
  readonly readingMs?: number;
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
    // R6：只接受 v2；v1/未知版本/损坏输入安静置空，无迁移代码。
    if (parsed.version !== 2 || (parsed.kind !== 'flow' && parsed.kind !== 'page')) {
      return null;
    }
    const index = parsed.index;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      return null;
    }
    if (typeof parsed.ratio !== 'number' || !Number.isFinite(parsed.ratio)) {
      return null;
    }
    if (parsed.status !== undefined && parsed.status !== 'finished') {
      return null;
    }
    const readingMs = parsed.readingMs;
    if (
      readingMs !== undefined &&
      (typeof readingMs !== 'number' || !Number.isFinite(readingMs) || readingMs < 0)
    ) {
      return null;
    }
    const total =
      parsed.total !== undefined && Number.isSafeInteger(parsed.total) && parsed.total >= 1
        ? parsed.total
        : undefined;
    const title = sanitizeReadingProgressTitle(parsed.title);
    return {
      version: 2,
      kind: parsed.kind,
      index,
      ratio: Math.min(1, Math.max(0, parsed.ratio)),
      ...(total === undefined ? {} : { total }),
      ...(title === undefined ? {} : { title }),
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(readingMs === undefined ? {} : { readingMs }),
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
