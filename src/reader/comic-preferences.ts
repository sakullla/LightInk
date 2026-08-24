export const COMIC_PREFERENCES_STORAGE_KEY = 'lightink.reader.comic.preferences.v2';

export type ComicReadingMode = 'vertical' | 'paged';
export type ComicReadingDirection = 'ltr' | 'rtl';
export type ComicSpread = 'single' | 'double';

export interface ComicPreferences {
  readonly mode: ComicReadingMode;
  readonly direction: ComicReadingDirection;
  readonly spread: ComicSpread;
  readonly fitWidth: boolean;
}

export interface ComicPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultComicPreferences(
  direction: ComicReadingDirection = 'ltr',
): ComicPreferences {
  return { mode: 'paged', direction, spread: 'double', fitWidth: true };
}

export function parseComicPreferences(
  raw: string | null | undefined,
  fallbackDirection: ComicReadingDirection = 'ltr',
): ComicPreferences {
  const fallback = defaultComicPreferences(fallbackDirection);
  if (raw === null || raw === undefined) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<ComicPreferences>;
    return {
      mode: value.mode === 'paged' ? 'paged' : 'vertical',
      direction: value.direction === 'rtl' ? 'rtl' : value.direction === 'ltr' ? 'ltr' : fallback.direction,
      spread: value.spread === 'double' ? 'double' : 'single',
      fitWidth: value.fitWidth !== false,
    };
  } catch {
    return fallback;
  }
}

export function loadComicPreferences(
  storage: ComicPreferenceStorage | null | undefined,
  fallbackDirection: ComicReadingDirection = 'ltr',
): ComicPreferences {
  if (storage === null || storage === undefined) return defaultComicPreferences(fallbackDirection);
  try {
    return parseComicPreferences(storage.getItem(COMIC_PREFERENCES_STORAGE_KEY), fallbackDirection);
  } catch {
    return defaultComicPreferences(fallbackDirection);
  }
}

export function saveComicPreferences(
  storage: ComicPreferenceStorage | null | undefined,
  preferences: ComicPreferences,
): void {
  if (storage === null || storage === undefined) return;
  try {
    storage.setItem(COMIC_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
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
