/**
 * Reader paper themes (Kindle / Apple Books / Kobo).
 *
 * Owns `lightink.reader.theme` and never reads or writes the editor key
 * `lightink.theme`. White / sepia / gray / night stay on the reading host
 * so the shelf and editor keep their own chrome.
 */

export const READER_THEME_STORAGE_KEY = 'lightink.reader.theme';

export const READER_THEME_IDS = ['white', 'sepia', 'gray', 'night'] as const;

export type ReaderThemeId = (typeof READER_THEME_IDS)[number];

export const DEFAULT_READER_THEME: ReaderThemeId = 'sepia';

export interface ReaderThemeTokens {
  readonly id: ReaderThemeId;
  readonly page: string;
  readonly elevated: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly colorScheme: 'light' | 'dark';
}

export const READER_THEMES: readonly ReaderThemeTokens[] = [
  {
    id: 'white',
    page: '#ffffff',
    elevated: '#f6f6f6',
    ink: '#1a1a1a',
    muted: '#6b6b6b',
    border: 'rgba(26, 26, 26, 0.14)',
    colorScheme: 'light',
  },
  {
    id: 'sepia',
    page: '#fbf0d9',
    elevated: '#f4e4c4',
    ink: '#5c4a32',
    muted: '#8a7355',
    border: 'rgba(92, 74, 50, 0.18)',
    colorScheme: 'light',
  },
  {
    id: 'gray',
    page: '#2a2a2a',
    elevated: '#353535',
    ink: '#d6d6d6',
    muted: '#a0a0a0',
    border: 'rgba(255, 255, 255, 0.12)',
    colorScheme: 'dark',
  },
  {
    id: 'night',
    page: '#121212',
    elevated: '#1c1c1c',
    ink: '#c8c8c8',
    muted: '#8e8e8e',
    border: 'rgba(255, 255, 255, 0.1)',
    colorScheme: 'dark',
  },
];

export interface ReaderThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReaderThemeRoot {
  dataset: DOMStringMap;
  style: {
    setProperty?(name: string, value: string, priority?: string): void;
    colorScheme?: string;
    color?: string;
    backgroundColor?: string;
  };
}

export function isReaderThemeId(value: string | null | undefined): value is ReaderThemeId {
  return value === 'white' || value === 'sepia' || value === 'gray' || value === 'night';
}

export function parseReaderTheme(raw: string | null | undefined): ReaderThemeId {
  return isReaderThemeId(raw) ? raw : DEFAULT_READER_THEME;
}

export function readerThemeTokens(id: ReaderThemeId): ReaderThemeTokens {
  return READER_THEMES.find((theme) => theme.id === id) ?? READER_THEMES[1]!;
}

/** Native title-bar pairing for a paper theme (Win11 caption tint + dark/light). */
export function readerNativeWindowChrome(theme: ReaderThemeId): {
  readonly dark: boolean;
  readonly caption: string;
  readonly text: string;
} {
  const tokens = readerThemeTokens(parseReaderTheme(theme));
  return {
    dark: tokens.colorScheme === 'dark',
    caption: tokens.page,
    text: tokens.ink,
  };
}

/** Caption pairing for the comic canvas, not EPUB paper. */
export const COMIC_NATIVE_WINDOW_CHROME = {
  dark: true,
  caption: '#111111',
  text: '#e6e6e6',
} as const;

/** Stamped on `#app` so caption CSS does not follow a hidden comic tab. */
export const COMIC_WINDOW_CHROME_CLASS = 'is-comic-reader';

export function hostShowsComicReader(host: ParentNode | null | undefined): boolean {
  return host instanceof Element && host.querySelector('[data-comic-reader="true"]') !== null;
}

export function syncComicWindowChromeClass(
  root: Element | null | undefined,
  comicOpen: boolean,
): void {
  if (root == null) return;
  root.classList.toggle(COMIC_WINDOW_CHROME_CLASS, comicOpen);
}

export function loadReaderTheme(storage: ReaderThemeStorage | null | undefined): ReaderThemeId {
  if (storage == null) {
    return DEFAULT_READER_THEME;
  }
  try {
    return parseReaderTheme(storage.getItem(READER_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_READER_THEME;
  }
}

export function saveReaderTheme(
  storage: ReaderThemeStorage | null | undefined,
  theme: ReaderThemeId,
): ReaderThemeId {
  const next = parseReaderTheme(theme);
  if (storage == null) {
    return next;
  }
  try {
    storage.setItem(READER_THEME_STORAGE_KEY, next);
  } catch {
    // Privacy mode / quota — keep the session value.
  }
  return next;
}

export function applyReaderTheme(root: ReaderThemeRoot, theme: ReaderThemeId): ReaderThemeId {
  const next = parseReaderTheme(theme);
  const tokens = readerThemeTokens(next);
  root.dataset.readerTheme = next;
  if (typeof root.style.setProperty !== 'function') {
    return next;
  }
  root.style.setProperty('--lightink-bg', tokens.page);
  root.style.setProperty('--lightink-bg-elevated', tokens.elevated);
  root.style.setProperty('--lightink-fg', tokens.ink);
  root.style.setProperty('--lightink-muted', tokens.muted);
  root.style.setProperty('--lightink-border', tokens.border);
  root.style.colorScheme = tokens.colorScheme;
  root.style.color = tokens.ink;
  root.style.backgroundColor = tokens.page;
  return next;
}
