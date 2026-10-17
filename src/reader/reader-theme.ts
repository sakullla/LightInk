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
  /** 凹面/侧栏/轨道（三层表面的最底层；纸墨工作室 §1.1）。 */
  readonly sunken: string;
  readonly ink: string;
  /** 标题/强调（比 ink 更进一步；查词词条等浮层强调用）。 */
  readonly inkStrong: string;
  readonly muted: string;
  readonly border: string;
  /** 荧光笔底色（纸主题分档：浅纸偏亮黄、深纸压暗）。 */
  readonly highlight: string;
  /** 荧光笔洗色上的文字色（暗纸取亮值）。 */
  readonly highlightInk: string;
  readonly colorScheme: 'light' | 'dark';
}

/** 纸墨工作室色板（ui-redesign-2026-10 §1.1/§3.21）：浅纸更深一档、深纸更沉一档。 */
export const READER_THEMES: readonly ReaderThemeTokens[] = [
  {
    id: 'white',
    page: '#fdfcf8',
    elevated: '#f5f2ea',
    sunken: '#f0ece1',
    ink: '#241f18',
    inkStrong: '#17130c',
    muted: '#6d6455',
    border: 'rgba(36, 31, 24, 0.16)',
    highlight: '#e8d28a',
    highlightInk: '#5f521c',
    colorScheme: 'light',
  },
  {
    id: 'sepia',
    page: '#f5e9d2',
    elevated: '#eddfc3',
    sunken: '#ead9b8',
    ink: '#4e3d28',
    inkStrong: '#3e2f1c',
    muted: '#7a6750',
    border: 'rgba(78, 61, 40, 0.2)',
    highlight: '#e3c96e',
    highlightInk: '#574f1f',
    colorScheme: 'light',
  },
  {
    id: 'gray',
    page: '#262421',
    elevated: '#312e29',
    sunken: '#201e1b',
    ink: '#d9d2c4',
    inkStrong: '#e6dfd1',
    muted: '#a49a89',
    border: 'rgba(217, 210, 196, 0.14)',
    highlight: '#8a7430',
    highlightInk: '#f0e2ac',
    colorScheme: 'dark',
  },
  {
    id: 'night',
    page: '#141822',
    elevated: '#1c2330',
    sunken: '#0f131b',
    ink: '#d3dae6',
    inkStrong: '#e8edf6',
    muted: '#8b94a6',
    border: 'rgba(211, 218, 230, 0.12)',
    highlight: '#7d7440',
    highlightInk: '#eadfa9',
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
    removeProperty?(name: string): string;
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

/**
 * Inline custom properties `applyReaderTheme` writes onto a theme root.
 *
 * 名单纪律（ui-redesign-2026-10 §2.3 修订版）：只有被纸主题**内联覆盖**的
 * 主题级令牌才进这份名单——highlight/-ink/sunken/fg-strong 四个本可继承
 * 应用主题，但纸色分档必须改写它们（暗纸压暗、浅纸偏亮黄），因此随纸
 * 主题内联提供并在此登记，`resetReaderTheme` 借同一份名单对称清除。
 */
export const READER_THEME_INLINE_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-bg-sunken',
  '--lightink-fg',
  '--lightink-fg-strong',
  '--lightink-muted',
  '--lightink-border',
  '--lightink-highlight',
  '--lightink-highlight-ink',
] as const;

export function applyReaderTheme(root: ReaderThemeRoot, theme: ReaderThemeId): ReaderThemeId {
  const next = parseReaderTheme(theme);
  const tokens = readerThemeTokens(next);
  root.dataset.readerTheme = next;
  if (typeof root.style.setProperty !== 'function') {
    return next;
  }
  root.style.setProperty('--lightink-bg', tokens.page);
  root.style.setProperty('--lightink-bg-elevated', tokens.elevated);
  root.style.setProperty('--lightink-bg-sunken', tokens.sunken);
  root.style.setProperty('--lightink-fg', tokens.ink);
  root.style.setProperty('--lightink-fg-strong', tokens.inkStrong);
  root.style.setProperty('--lightink-muted', tokens.muted);
  root.style.setProperty('--lightink-border', tokens.border);
  root.style.setProperty('--lightink-highlight', tokens.highlight);
  root.style.setProperty('--lightink-highlight-ink', tokens.highlightInk);
  root.style.colorScheme = tokens.colorScheme;
  root.style.color = tokens.ink;
  root.style.backgroundColor = tokens.page;
  return next;
}

/**
 * Drop an inline paper theme again. `#lightink-editor-area` is shared by
 * Markdown and reader tabs, so reader paper tokens must not survive a switch
 * back to a Markdown tab: inline custom properties outrank every `data-theme`
 * token and would freeze the pane on the last book's paper (default sepia)
 * no matter which editor theme the user picks.
 */
export function resetReaderTheme(root: ReaderThemeRoot): void {
  delete root.dataset.readerTheme;
  const style = root.style;
  if (typeof style.removeProperty !== 'function') {
    return;
  }
  for (const name of READER_THEME_INLINE_VARS) {
    style.removeProperty(name);
  }
  style.colorScheme = '';
  style.color = '';
  style.backgroundColor = '';
}
