export const COMIC_PREFERENCES_STORAGE_KEY = 'lightink.reader.comic.preferences.v2';
export const COMIC_BOOK_PREFERENCES_KEY_PREFIX = 'lightink.reader.comic.book.';

export type ComicReadingMode = 'paged' | 'strip';
export type ComicReadingDirection = 'ltr' | 'rtl';
export type ComicSpread = 'single' | 'double';
export type ComicFit = 'screen' | 'width' | 'height' | 'original';

export interface ComicPreferences {
  readonly mode: ComicReadingMode;
  readonly direction: ComicReadingDirection;
  readonly spread: ComicSpread;
  readonly fit: ComicFit;
}

export interface ComicPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function comicBookPreferencesKey(progressId: string): string {
  return `${COMIC_BOOK_PREFERENCES_KEY_PREFIX}${progressId}`;
}

export function defaultComicPreferences(
  direction: ComicReadingDirection = 'ltr',
): ComicPreferences {
  return { mode: 'paged', direction, spread: 'double', fit: 'screen' };
}

export function parseComicPreferences(
  raw: string | null | undefined,
  fallbackDirection: ComicReadingDirection = 'ltr',
): ComicPreferences {
  const fallback = defaultComicPreferences(fallbackDirection);
  const value = readStoredObject(raw);
  if (value === null) return fallback;
  return {
    mode: parseMode(value.mode),
    direction: parseDirection(value.direction) ?? fallback.direction,
    spread: parseSpread(value.spread),
    fit: parseFit(value),
  };
}

export function loadComicPreferences(
  storage: ComicPreferenceStorage | null | undefined,
  fallbackDirection: ComicReadingDirection = 'ltr',
  progressId?: string | null,
): ComicPreferences {
  if (storage === null || storage === undefined) return defaultComicPreferences(fallbackDirection);
  try {
    const bookId = resolveProgressId(progressId);
    const globalRaw = storage.getItem(COMIC_PREFERENCES_STORAGE_KEY);
    const bookRaw = bookId === undefined ? null : storage.getItem(comicBookPreferencesKey(bookId));
    const direction =
      parseDirection(readStoredObject(bookRaw)?.direction) ??
      parseDirection(readStoredObject(globalRaw)?.direction) ??
      fallbackDirection;
    if (bookRaw !== null && bookRaw !== undefined && bookRaw !== '') {
      return parseComicPreferences(bookRaw, direction);
    }
    return parseComicPreferences(globalRaw, direction);
  } catch {
    return defaultComicPreferences(fallbackDirection);
  }
}

export function saveComicPreferences(
  storage: ComicPreferenceStorage | null | undefined,
  preferences: ComicPreferences,
  progressId?: string | null,
): void {
  if (storage === null || storage === undefined) return;
  try {
    const bookId = resolveProgressId(progressId);
    const key =
      bookId === undefined ? COMIC_PREFERENCES_STORAGE_KEY : comicBookPreferencesKey(bookId);
    storage.setItem(key, JSON.stringify(normalizeComicPreferences(preferences)));
  } catch {
    // Private mode and quota failures keep the current session usable.
  }
}

export function comicSpreadStart(
  pageIndex: number,
  totalPages: number,
  preferences: Pick<ComicPreferences, 'mode' | 'spread'>,
): number {
  const index = Math.min(Math.max(0, Math.floor(pageIndex)), Math.max(0, totalPages - 1));
  if (preferences.mode !== 'paged' || preferences.spread !== 'double' || index === 0) {
    return index;
  }
  return 1 + Math.floor((index - 1) / 2) * 2;
}

export function comicVisiblePages(
  pageIndex: number,
  totalPages: number,
  preferences: Pick<ComicPreferences, 'mode' | 'spread'>,
): number[] {
  if (totalPages <= 0) return [];
  if (preferences.mode !== 'paged') {
    return Array.from({ length: totalPages }, (_value, index) => index);
  }
  const start = comicSpreadStart(pageIndex, totalPages, preferences);
  if (preferences.spread !== 'double' || start === 0 || start + 1 >= totalPages) {
    return [start];
  }
  return [start, start + 1];
}

export function advanceComicPage(
  pageIndex: number,
  totalPages: number,
  direction: 1 | -1,
  preferences: Pick<ComicPreferences, 'mode' | 'spread'>,
): number {
  if (totalPages <= 0) return 0;
  const current = comicSpreadStart(pageIndex, totalPages, preferences);
  if (preferences.mode !== 'paged' || preferences.spread !== 'double') {
    return Math.min(totalPages - 1, Math.max(0, current + direction));
  }
  const next =
    direction > 0
      ? current === 0
        ? 1
        : current + 2
      : current <= 1
        ? 0
        : current - 2;
  return comicSpreadStart(Math.min(totalPages - 1, Math.max(0, next)), totalPages, preferences);
}

function resolveProgressId(progressId: string | null | undefined): string | undefined {
  return progressId === null || progressId === undefined || progressId === ''
    ? undefined
    : progressId;
}

function normalizeComicPreferences(preferences: ComicPreferences): ComicPreferences {
  return {
    mode: preferences.mode === 'strip' ? 'strip' : 'paged',
    direction: preferences.direction === 'rtl' ? 'rtl' : 'ltr',
    spread: preferences.spread === 'single' ? 'single' : 'double',
    fit: parseFit({ fit: preferences.fit }),
  };
}

function readStoredObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseMode(value: unknown): ComicReadingMode {
  if (value === 'strip' || value === 'vertical') return 'strip';
  return 'paged';
}

function parseDirection(value: unknown): ComicReadingDirection | undefined {
  return value === 'rtl' || value === 'ltr' ? value : undefined;
}

function parseSpread(value: unknown): ComicSpread {
  if (value === 'single') return 'single';
  return 'double';
}

function parseFit(value: Record<string, unknown>): ComicFit {
  if (
    value.fit === 'screen' ||
    value.fit === 'width' ||
    value.fit === 'height' ||
    value.fit === 'original'
  ) {
    return value.fit;
  }
  if (value.fitWidth === true) return 'width';
  return 'screen';
}
