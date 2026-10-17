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
  /**
   * 纸墨工作室扩展层（docs/design/ui-redesign-2026-10.md §3.21）：书架主题
   * 与全局主题同源的令牌。预设必须覆盖它们——书架根不带 data-theme，缺省会
   * 回退到编辑器主题的同名令牌，暗色书架配浅色编辑器时会得到深 fg-strong。
   */
  readonly sunken: string;
  readonly inkStrong: string;
  readonly accentContrast: string;
  readonly shadowPop: string;
  readonly success: string;
  readonly warning: string;
  readonly info: string;
}

/*
 * 色板与 library.css 的 [data-library-theme] 预设块双写（同提交改），由
 * tokens.test.ts 的「逐一相等」断言锁定。gallery/paper/ink 的 page、ink 与
 * gallery 的 elevated 另被 src/reader/__tests__/reader-theme.test.ts 的原生
 * 标题栏色断言锁定，刷新时保持不变；其余值按「浅纸更深一档、深纸更沉一档」
 * 对齐 2026-10 改版方向。
 */
export const LIBRARY_THEMES: readonly LibraryThemeTokens[] = [
  {
    id: 'gallery',
    page: '#f2efe8',
    elevated: '#fffcf8',
    ink: '#2a261f',
    accentInk: '#a8431a',
    muted: '#675f50',
    border: '#e1d9c9',
    accent: '#c45a28',
    accentSoft: '#f1ddca',
    overlay: '#2a261f48',
    shadow: '0 12px 32px #2a261f1c',
    danger: '#b42318',
    colorScheme: 'light',
    sunken: '#e9e1d0',
    inkStrong: '#211c15',
    accentContrast: '#fff6ec',
    shadowPop: '0 6px 20px #2a261f1f, 0 1px 3px #2a261f14',
    success: '#34693e',
    warning: '#8f641c',
    info: '#3e5c8c',
  },
  {
    id: 'paper',
    page: '#f6eadc',
    elevated: '#fdf3e3',
    ink: '#3a2f24',
    accentInk: '#8a4318',
    muted: '#6e5e4d',
    border: '#dfceb5',
    accent: '#a35a2b',
    accentSoft: '#eed8bd',
    overlay: '#3a2f2448',
    shadow: '0 12px 32px #3a2f241c',
    danger: '#b42318',
    colorScheme: 'light',
    sunken: '#ebdcc4',
    inkStrong: '#2f2518',
    accentContrast: '#fff6ec',
    shadowPop: '0 6px 20px #3a2f241f, 0 1px 3px #3a2f2414',
    success: '#34693e',
    warning: '#8f641c',
    info: '#3e5c8c',
  },
  {
    id: 'moss',
    page: '#e8efe1',
    elevated: '#f5f9f0',
    ink: '#243028',
    accentInk: '#3f6d48',
    muted: '#535e55',
    border: '#ced9c6',
    accent: '#3f6d48',
    accentSoft: '#d8e5d5',
    overlay: '#24302848',
    shadow: '0 12px 32px #2430281c',
    danger: '#b42318',
    colorScheme: 'light',
    sunken: '#dee8d3',
    inkStrong: '#1a2921',
    accentContrast: '#f4fbf4',
    shadowPop: '0 6px 20px #2430281f, 0 1px 3px #24302814',
    success: '#1e6b4f',
    warning: '#8f641c',
    info: '#3e5c8c',
  },
  {
    id: 'walnut',
    page: '#201812',
    elevated: '#2f251b',
    ink: '#eadcc8',
    accentInk: '#d4a06a',
    muted: '#a2917b',
    border: '#453931',
    accent: '#d4a06a',
    accentSoft: '#392c20',
    overlay: '#100c0a73',
    shadow: '0 12px 32px #100c0a59',
    danger: '#f97066',
    colorScheme: 'dark',
    sunken: '#181109',
    inkStrong: '#f7ecd9',
    accentContrast: '#241a0d',
    shadowPop: '0 8px 22px #100c0a66, 0 2px 6px #100c0a44',
    success: '#85b08e',
    warning: '#cfa75c',
    info: '#8fa9cc',
  },
  {
    id: 'ink',
    page: '#14161a',
    elevated: '#1d2127',
    ink: '#d5dae2',
    accentInk: '#7ba3c9',
    muted: '#8791a0',
    border: '#2a313c',
    accent: '#7ba3c9',
    accentSoft: '#223040',
    overlay: '#0a0c0f73',
    shadow: '0 12px 32px #0a0c0f59',
    danger: '#f97066',
    colorScheme: 'dark',
    sunken: '#0f1216',
    inkStrong: '#e9eef7',
    accentContrast: '#0c141f',
    shadowPop: '0 8px 22px #0a0c0f66, 0 2px 6px #0a0c0f44',
    success: '#74b39c',
    warning: '#c2a35c',
    info: '#7e9cc4',
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
    case '--lightink-bg-sunken':
      return tokens.sunken;
    case '--lightink-fg':
      return tokens.ink;
    case '--lightink-fg-strong':
      return tokens.inkStrong;
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
    case '--lightink-accent-contrast':
      return tokens.accentContrast;
    case '--lightink-overlay':
      return tokens.overlay;
    case '--lightink-shadow':
      return tokens.shadow;
    case '--lightink-shadow-pop':
      return tokens.shadowPop;
    case '--lightink-danger':
      return tokens.danger;
    case '--lightink-success':
      return tokens.success;
    case '--lightink-warning':
      return tokens.warning;
    case '--lightink-info':
      return tokens.info;
    default:
      return '';
  }
}

const LIBRARY_OVERLAY_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-bg-sunken',
  '--lightink-fg',
  '--lightink-fg-strong',
  '--lightink-accent-ink',
  '--lightink-muted',
  '--lightink-border',
  '--lightink-accent',
  '--lightink-accent-soft',
  '--lightink-accent-contrast',
  '--lightink-overlay',
  '--lightink-shadow',
  '--lightink-shadow-pop',
  '--lightink-danger',
  '--lightink-success',
  '--lightink-warning',
  '--lightink-info',
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
