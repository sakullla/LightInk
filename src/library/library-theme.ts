/**
 * Shelf chrome themes (Apple Books / Kindle library, not editor paper).
 *
 * Owns `lightink.library.theme` and never reads or writes the editor key
 * `lightink.theme` or the reader key `lightink.reader.theme`.
 */

export const LIBRARY_THEME_STORAGE_KEY = 'lightink.library.theme';

export const LIBRARY_THEME_IDS = ['gallery', 'paper', 'moss', 'walnut', 'ink'] as const;

export type LibraryThemeId = (typeof LIBRARY_THEME_IDS)[number];

export const DEFAULT_LIBRARY_THEME: LibraryThemeId = 'gallery';

export interface LibraryThemeTokens {
  readonly id: LibraryThemeId;
  readonly page: string;
  readonly elevated: string;
  readonly ink: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly overlay: string;
  readonly shadow: string;
  readonly danger: string;
  readonly colorScheme: 'light' | 'dark';
}

export const LIBRARY_THEMES: readonly LibraryThemeTokens[] = [
  {
    id: 'gallery',
    page: '#e8edf2',
    elevated: '#f7f9fb',
    ink: '#243038',
    muted: '#6b7882',
    border: '#c5ced6',
    accent: '#3d6f8f',
    accentSoft: '#d5e3ec',
    overlay: '#24303848',
    shadow: '0 10px 28px #2430381f',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'paper',
    page: '#f4efe6',
    elevated: '#fffaf2',
    ink: '#3a3228',
    muted: '#7d7163',
    border: '#d5cbb8',
    accent: '#9a5b2c',
    accentSoft: '#efe0cc',
    overlay: '#3a322848',
    shadow: '0 10px 28px #3a32281f',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'moss',
    page: '#e8efe4',
    elevated: '#f5f8f2',
    ink: '#2a3528',
    muted: '#66705f',
    border: '#c5d0bf',
    accent: '#4d7348',
    accentSoft: '#d7e4d3',
    overlay: '#2a352848',
    shadow: '0 10px 28px #2a35281f',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'walnut',
    page: '#241c17',
    elevated: '#322820',
    ink: '#eadcc8',
    muted: '#a8947c',
    border: '#4a3c32',
    accent: '#d4a06a',
    accentSoft: '#3d2f24',
    overlay: '#100c0a73',
    shadow: '0 12px 32px #100c0a59',
    danger: '#f97066',
    colorScheme: 'dark',
  },
  {
    id: 'ink',
    page: '#14161a',
    elevated: '#1e2228',
    ink: '#d5dae2',
    muted: '#8b93a0',
    border: '#2c323c',
    accent: '#7ba3c9',
    accentSoft: '#243040',
    overlay: '#0a0c0f73',
    shadow: '0 12px 32px #0a0c0f59',
    danger: '#f97066',
    colorScheme: 'dark',
  },
];

export interface LibraryThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LibraryThemeRoot {
  dataset: DOMStringMap;
  style: {
    setProperty?(name: string, value: string, priority?: string): void;
    colorScheme?: string;
    color?: string;
    backgroundColor?: string;
  };
}

export function isLibraryThemeId(value: string | null | undefined): value is LibraryThemeId {
  return (
    value === 'gallery' ||
    value === 'paper' ||
    value === 'moss' ||
    value === 'walnut' ||
    value === 'ink'
  );
}

export function parseLibraryTheme(raw: string | null | undefined): LibraryThemeId {
  return isLibraryThemeId(raw) ? raw : DEFAULT_LIBRARY_THEME;
}

export function libraryThemeTokens(id: LibraryThemeId): LibraryThemeTokens {
  return LIBRARY_THEMES.find((theme) => theme.id === id) ?? LIBRARY_THEMES[0]!;
}

export function libraryNativeWindowChrome(theme: LibraryThemeId): {
  readonly dark: boolean;
  readonly caption: string;
  readonly text: string;
} {
  const tokens = libraryThemeTokens(parseLibraryTheme(theme));
  return {
    dark: tokens.colorScheme === 'dark',
    caption: tokens.page,
    text: tokens.ink,
  };
}

export function loadLibraryTheme(storage: LibraryThemeStorage | null | undefined): LibraryThemeId {
  if (storage == null) {
    return DEFAULT_LIBRARY_THEME;
  }
  try {
    return parseLibraryTheme(storage.getItem(LIBRARY_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_LIBRARY_THEME;
  }
}

export function saveLibraryTheme(
  storage: LibraryThemeStorage | null | undefined,
  theme: LibraryThemeId,
): LibraryThemeId {
  const next = parseLibraryTheme(theme);
  if (storage == null) {
    return next;
  }
  try {
    storage.setItem(LIBRARY_THEME_STORAGE_KEY, next);
  } catch {
    // Privacy mode / quota — keep the session value.
  }
  return next;
}

export function applyLibraryTheme(root: LibraryThemeRoot, theme: LibraryThemeId): LibraryThemeId {
  const next = parseLibraryTheme(theme);
  const tokens = libraryThemeTokens(next);
  root.dataset.libraryTheme = next;
  if (typeof root.style.setProperty !== 'function') {
    return next;
  }
  root.style.setProperty('--lightink-bg', tokens.page);
  root.style.setProperty('--lightink-bg-elevated', tokens.elevated);
  root.style.setProperty('--lightink-fg', tokens.ink);
  root.style.setProperty('--lightink-muted', tokens.muted);
  root.style.setProperty('--lightink-border', tokens.border);
  root.style.setProperty('--lightink-accent', tokens.accent);
  root.style.setProperty('--lightink-accent-soft', tokens.accentSoft);
  root.style.setProperty('--lightink-overlay', tokens.overlay);
  root.style.setProperty('--lightink-shadow', tokens.shadow);
  root.style.setProperty('--lightink-danger', tokens.danger);
  root.style.colorScheme = tokens.colorScheme;
  root.style.color = tokens.ink;
  root.style.backgroundColor = tokens.page;
  return next;
}

const LIBRARY_OVERLAY_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-fg',
  '--lightink-muted',
  '--lightink-border',
  '--lightink-accent',
  '--lightink-accent-soft',
  '--lightink-overlay',
  '--lightink-shadow',
  '--lightink-danger',
] as const;

/**
 * Copy shelf tokens onto a portaled overlay so it does not inherit editor paper.
 */
export function adoptLibraryOverlayTheme(overlay: HTMLElement, host: HTMLElement): void {
  if (typeof getComputedStyle !== 'function') {
    return;
  }
  const style = getComputedStyle(host);
  for (const name of LIBRARY_OVERLAY_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== '') overlay.style.setProperty(name, value);
  }
  const theme = host.dataset.libraryTheme;
  if (theme !== undefined && theme !== '') overlay.dataset.libraryTheme = theme;
  if (style.color !== '') overlay.style.color = style.color;
}

/** Escape library overflow clip by mounting on document.body. */
export function mountLibraryOverlay(overlay: HTMLElement, host: HTMLElement): void {
  adoptLibraryOverlayTheme(overlay, host);
  const layer = host.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null);
  if (layer !== null && overlay.parentNode !== layer) {
    layer.appendChild(overlay);
  }
}
