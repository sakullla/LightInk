/**
 * Reader chrome preferences owned by Manage → 阅读器.
 * Separate from typography so layout chrome is not mixed into font/measure.
 */

export const READER_PREFS_STORAGE_KEY = 'lightink.reader.prefs';

export interface ReaderPrefs {
  /** Immersive whisper bar and footer scrubber. */
  readonly showProgressBar: boolean;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  showProgressBar: true,
};

export interface ReaderPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReaderPrefsRoot {
  dataset: DOMStringMap;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function parseReaderPrefs(raw: string | null | undefined): ReaderPrefs {
  if (raw === null || raw === undefined || raw === '') {
    return { ...DEFAULT_READER_PREFS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return { ...DEFAULT_READER_PREFS };
    }
    return {
      showProgressBar:
        typeof parsed.showProgressBar === 'boolean'
          ? parsed.showProgressBar
          : DEFAULT_READER_PREFS.showProgressBar,
    };
  } catch {
    return { ...DEFAULT_READER_PREFS };
  }
}

export function loadReaderPrefs(storage: ReaderPrefsStorage | null | undefined): ReaderPrefs {
  if (storage == null) {
    return { ...DEFAULT_READER_PREFS };
  }
  try {
    return parseReaderPrefs(storage.getItem(READER_PREFS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_READER_PREFS };
  }
}

export function saveReaderPrefs(
  storage: ReaderPrefsStorage | null | undefined,
  prefs: ReaderPrefs,
): ReaderPrefs {
  const next: ReaderPrefs = {
    showProgressBar: prefs.showProgressBar === true,
  };
  if (storage == null) {
    return next;
  }
  try {
    storage.setItem(READER_PREFS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Privacy mode / quota — keep the in-memory choice.
  }
  return next;
}

/** `html[data-reader-progress-bar=off]` hides tracks; chapter and percent stay. */
export function applyReaderPrefs(root: ReaderPrefsRoot, prefs: ReaderPrefs): void {
  root.dataset.readerProgressBar = prefs.showProgressBar ? 'on' : 'off';
}
