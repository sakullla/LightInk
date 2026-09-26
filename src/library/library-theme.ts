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
  /**
   * Text-safe accent. `accent` is a fill/outline hue and can fall below 4.5:1
   * on light pages; home typography and hover text must use this token so the
   * magazine chrome stays readable in every theme.
   */
  readonly accentInk: string;
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
    page: '#f2efe8',
    elevated: '#fffcf8',
    ink: '#2a261f',
    accentInk: '#a8431a',
    muted: '#6b6459',
    border: '#e5dfd4',
    accent: '#c45a28',
    accentSoft: '#f3e2d4',
    overlay: '#2a261f48',
    shadow: '0 12px 32px #2a261f1c',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'paper',
    page: '#f6eadc',
    elevated: '#fff8ef',
    ink: '#3a2f24',
    accentInk: '#8a4318',
    muted: '#756454',
    border: '#e4d5c2',
    accent: '#a35a2b',
    accentSoft: '#f0dfcc',
    overlay: '#3a2f2448',
    shadow: '0 12px 32px #3a2f241c',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'moss',
    page: '#eef3ea',
    elevated: '#f8fbf6',
    ink: '#243028',
    accentInk: '#3f6d48',
    muted: '#59635a',
    border: '#d4ddd0',
    accent: '#3f6d48',
    accentSoft: '#dce8dc',
    overlay: '#24302848',
    shadow: '0 12px 32px #2430281c',
    danger: '#b42318',
    colorScheme: 'light',
  },
  {
    id: 'walnut',
    page: '#241c17',
    elevated: '#322820',
    ink: '#eadcc8',
    accentInk: '#d4a06a',
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
    accentInk: '#7ba3c9',
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
    removeProperty?(name: string): string;
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

/**
 * Preset colors live on `[data-library-theme]` in library.css, not inline.
 * Inline variables would beat `#lightink-custom-theme`. Clearing leftovers
 * from older sessions lets that stylesheet (and a later custom sheet) win.
 */
export function applyLibraryTheme(root: LibraryThemeRoot, theme: LibraryThemeId): LibraryThemeId {
  const next = parseLibraryTheme(theme);
  root.dataset.libraryTheme = next;
  const style = root.style;
  if (typeof style.removeProperty === 'function') {
    for (const name of LIBRARY_OVERLAY_THEME_VARS) style.removeProperty(name);
  }
  style.colorScheme = '';
  style.color = '';
  style.backgroundColor = '';
  return next;
}

function libraryThemeVariable(theme: LibraryThemeId, name: string): string {
  const tokens = libraryThemeTokens(theme);
  switch (name) {
    case '--lightink-bg':
      return tokens.page;
    case '--lightink-bg-elevated':
      return tokens.elevated;
    case '--lightink-fg':
      return tokens.ink;
    case '--lightink-accent-ink':
      return tokens.accentInk;
    case '--lightink-muted':
      return tokens.muted;
    case '--lightink-border':
      return tokens.border;
    case '--lightink-accent':
      return tokens.accent;
    case '--lightink-accent-soft':
      return tokens.accentSoft;
    case '--lightink-overlay':
      return tokens.overlay;
    case '--lightink-shadow':
      return tokens.shadow;
    case '--lightink-danger':
      return tokens.danger;
    default:
      return '';
  }
}

const LIBRARY_OVERLAY_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-fg',
  '--lightink-accent-ink',
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
  const parent = host.parentElement;
  const parentStyle = parent === null ? null : getComputedStyle(parent);
  const theme = host.dataset.libraryTheme;
  for (const name of LIBRARY_OVERLAY_THEME_VARS) {
    const inline = host.style.getPropertyValue(name).trim();
    const computed = style.getPropertyValue(name).trim();
    const inherited = parentStyle?.getPropertyValue(name).trim() ?? '';
    // Inherited values are the editor/page underneath the shelf. A preset or a
    // custom rule that actually targets the host differs from that parent.
    const value =
      inline !== ''
        ? inline
        : computed !== '' && computed !== inherited
          ? computed
          : isLibraryThemeId(theme)
            ? libraryThemeVariable(theme, name)
            : computed;
    if (value !== '') overlay.style.setProperty(name, value);
  }
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
