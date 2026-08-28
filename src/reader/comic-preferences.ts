export const COMIC_PREFERENCES_STORAGE_KEY = 'lightink.reader.comic.preferences.v2';
export const COMIC_BOOK_PREFERENCES_KEY_PREFIX = 'lightink.reader.comic.book.';

export type ComicReadingMode = 'paged' | 'strip';
export type ComicReadingDirection = 'ltr' | 'rtl';
export type ComicSpread = 'single' | 'double' | 'auto';
export type ComicResolvedSpread = 'single' | 'double';
export type ComicFit = 'screen' | 'width' | 'height' | 'original';

export interface ComicPreferences {
  readonly mode: ComicReadingMode;
  readonly direction: ComicReadingDirection;
  readonly spread: ComicSpread;
  readonly fit: ComicFit;
  readonly cropMargins: boolean;
}

export type ComicSpreadPreferences = Pick<ComicPreferences, 'mode' | 'spread'> & {
  readonly coverAlone?: boolean;
};

/** Wider than this is treated as an already-complete double-page bitmap. */
export const COMIC_LANDSCAPE_RATIO = 1.15;

export interface ComicPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function comicBookPreferencesKey(progressId: string): string {
  return `${COMIC_BOOK_PREFERENCES_KEY_PREFIX}${progressId}`;
}

export function isTouchPrimaryDocument(root?: Pick<Document, 'documentElement'> | null): boolean {
  const element =
    root?.documentElement ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (element === null) return false;
  return element.hasAttribute('data-android') || element.hasAttribute('data-touch-primary');
}

export function defaultComicPreferences(
  direction: ComicReadingDirection = 'ltr',
): ComicPreferences {
  return {
    mode: 'paged',
    direction,
    spread: isTouchPrimaryDocument() ? 'auto' : 'double',
    fit: 'screen',
    cropMargins: false,
  };
}

/** Portrait stays single; landscape pairs pages. Explicit single/double win. */
export function resolveComicSpread(
  spread: ComicSpread,
  viewport?: { readonly width: number; readonly height: number },
): ComicResolvedSpread {
  if (spread === 'single' || spread === 'double') return spread;
  const width = viewport?.width ?? 0;
  const height = viewport?.height ?? 0;
  return width > 0 && height > 0 && width > height ? 'double' : 'single';
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
    cropMargins: value.cropMargins === true,
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

export function isComicLandscapeSize(width: number, height: number): boolean {
  return height > 0 && width / height >= COMIC_LANDSCAPE_RATIO;
}

export function comicSpreadList(
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number[][] {
  if (totalPages <= 0) return [];
  if (preferences.mode !== 'paged' || preferences.spread !== 'double') {
    return Array.from({ length: totalPages }, (_value, index) => [index]);
  }
  const spreads: number[][] = [];
  let index = 0;
  if (preferences.coverAlone !== false) {
    spreads.push([0]);
    index = 1;
  }
  while (index < totalPages) {
    if (landscapePages?.has(index) === true) {
      spreads.push([index]);
      index += 1;
      continue;
    }
    const pair = index + 1;
    if (pair < totalPages && landscapePages?.has(pair) !== true) {
      spreads.push([index, pair]);
      index += 2;
      continue;
    }
    spreads.push([index]);
    index += 1;
  }
  return spreads;
}

function spreadContaining(
  pageIndex: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number[] {
  const index = clampComicPageIndex(pageIndex, totalPages);
  return (
    comicSpreadList(totalPages, preferences, landscapePages).find((spread) =>
      spread.includes(index),
    ) ?? [index]
  );
}

export function comicSpreadStart(
  pageIndex: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number {
  return spreadContaining(pageIndex, totalPages, preferences, landscapePages)[0] ?? 0;
}

export function comicVisiblePages(
  pageIndex: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number[] {
  if (totalPages <= 0) return [];
  if (preferences.mode !== 'paged') {
    return Array.from({ length: totalPages }, (_value, index) => index);
  }
  return spreadContaining(pageIndex, totalPages, preferences, landscapePages);
}

/** Current spread plus one turn each way. Strip keeps a single center so tiny budgets stay honest. */
export function comicTurnPrefetchCenters(
  pageIndex: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number[] {
  if (totalPages <= 0) return [];
  if (preferences.mode !== 'paged') {
    return [clampComicPageIndex(pageIndex, totalPages)];
  }
  const current = comicVisiblePages(pageIndex, totalPages, preferences, landscapePages);
  const next = advanceComicPage(pageIndex, totalPages, 1, preferences, landscapePages);
  const previous = advanceComicPage(pageIndex, totalPages, -1, preferences, landscapePages);
  return [
    ...new Set([
      ...current,
      ...comicVisiblePages(next, totalPages, preferences, landscapePages),
      ...comicVisiblePages(previous, totalPages, preferences, landscapePages),
    ]),
  ].sort((left, right) => left - right);
}

export function comicSpreadIndex(
  pageIndex: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number {
  const start = comicSpreadStart(pageIndex, totalPages, preferences, landscapePages);
  const spreads = comicSpreadList(totalPages, preferences, landscapePages);
  const at = spreads.findIndex((spread) => spread[0] === start);
  return Math.max(0, at);
}

/** Map 0–1 progress onto the first page of the matching spread. */
export function comicPageFromProgress(
  progress: number,
  totalPages: number,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number {
  const spreads = comicSpreadList(totalPages, preferences, landscapePages);
  if (spreads.length === 0) return 1;
  const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const slot = Math.min(spreads.length, Math.max(1, Math.round(clamped * spreads.length) || 1));
  return (spreads[slot - 1]?.[0] ?? 0) + 1;
}

export function clampComicViewOffset(
  offset: { readonly x: number; readonly y: number },
  scale: number,
  viewport: { readonly width: number; readonly height: number },
  content: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  if (scale <= 1 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0 };
  }
  const scaledWidth = Math.max(1, content.width) * scale;
  const scaledHeight = Math.max(1, content.height) * scale;
  const clampAxis = (value: number, scaled: number, view: number): number => {
    if (scaled <= view) return (view - scaled) / 2;
    return Math.min(0, Math.max(view - scaled, value));
  };
  return {
    x: clampAxis(offset.x, scaledWidth, viewport.width),
    y: clampAxis(offset.y, scaledHeight, viewport.height),
  };
}

export function advanceComicPage(
  pageIndex: number,
  totalPages: number,
  direction: 1 | -1,
  preferences: ComicSpreadPreferences,
  landscapePages?: ReadonlySet<number>,
): number {
  if (totalPages <= 0) return 0;
  if (preferences.mode !== 'paged' || preferences.spread !== 'double') {
    return clampComicPageIndex(pageIndex + direction, totalPages);
  }
  const spreads = comicSpreadList(totalPages, preferences, landscapePages);
  const current = spreadContaining(pageIndex, totalPages, preferences, landscapePages)[0] ?? 0;
  const at = spreads.findIndex((spread) => spread[0] === current);
  const next = spreads[at + direction];
  return next?.[0] ?? current;
}

function clampComicPageIndex(pageIndex: number, totalPages: number): number {
  return Math.min(Math.max(0, Math.floor(pageIndex)), Math.max(0, totalPages - 1));
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
    spread:
      preferences.spread === 'single' || preferences.spread === 'auto'
        ? preferences.spread
        : 'double',
    fit: parseFit({ fit: preferences.fit }),
    cropMargins: preferences.cropMargins === true,
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
  if (value === 'single' || value === 'auto') return value;
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
