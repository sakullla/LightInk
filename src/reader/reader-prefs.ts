/**
 * Reader chrome preferences owned by Manage → 阅读器.
 * Separate from typography so layout chrome is not mixed into font/measure.
 */

export const READER_PREFS_STORAGE_KEY = 'lightink.reader.prefs';

/**
 * 翻页动画样式偏好（R1）。`auto` = 未显式选择：系统无
 * prefers-reduced-motion 时按 slide，有则无动画；显式选择任何值（含
 * `none`）后一律按选择执行——用「未设置 = auto」单字段表达。
 */
export type ReaderPageTurnStyle = 'auto' | 'slide' | 'fade' | 'curl' | 'none';

/** 统一生效样式：`auto` 已解析后的四种实际动画。 */
export type ReaderPageTurnEffect = 'slide' | 'fade' | 'curl' | 'none';

export const READER_PAGE_TURN_STYLES: readonly ReaderPageTurnStyle[] = [
  'auto',
  'slide',
  'fade',
  'curl',
  'none',
];

export function isReaderPageTurnStyle(value: unknown): value is ReaderPageTurnStyle {
  return (
    value === 'auto' ||
    value === 'slide' ||
    value === 'fade' ||
    value === 'curl' ||
    value === 'none'
  );
}

/**
 * 生效样式计算（唯一分派口径）：`auto` 按 prefers-reduced-motion 解析为
 * slide/none；显式选择原样通过（含 reduce 下的显式动画——用户选择覆盖系统）。
 */
export function resolveReaderPageTurnEffect(
  style: ReaderPageTurnStyle,
  prefersReducedMotion: boolean,
): ReaderPageTurnEffect {
  if (style === 'auto') {
    return prefersReducedMotion ? 'none' : 'slide';
  }
  return style;
}

export interface ReaderPrefs {
  /** Immersive whisper bar and footer scrubber. */
  readonly showProgressBar: boolean;
  /** Page-turn animation style; `auto` until the reader picks one. */
  readonly pageTurnStyle: ReaderPageTurnStyle;
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  showProgressBar: true,
  pageTurnStyle: 'auto',
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
      pageTurnStyle: isReaderPageTurnStyle(parsed.pageTurnStyle)
        ? parsed.pageTurnStyle
        : DEFAULT_READER_PREFS.pageTurnStyle,
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
    pageTurnStyle: isReaderPageTurnStyle(prefs.pageTurnStyle)
      ? prefs.pageTurnStyle
      : DEFAULT_READER_PREFS.pageTurnStyle,
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

/**
 * 最近一次 apply 的翻页样式内存缓存：播放函数每次翻页读它（即时生效，
 * Manage 保存/同步应用都会走 applyReaderPrefs 刷新，无需重开书）。
 */
let appliedPageTurnStyle: ReaderPageTurnStyle = DEFAULT_READER_PREFS.pageTurnStyle;

export function currentReaderPageTurnStyle(): ReaderPageTurnStyle {
  return appliedPageTurnStyle;
}

/**
 * 当前生效翻页样式：内存缓存偏好 + prefers-reduced-motion 一次解析。
 * 播放/漫画映射/触屏 scroller 缓动共用，matchMedia 可注入（测试）。
 */
export function effectiveReaderPageTurnEffect(
  matchMedia?: ((query: string) => { matches: boolean }) | null,
): ReaderPageTurnEffect {
  const globalMatchMedia =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { matchMedia?: unknown }).matchMedia === 'function'
      ? ((globalThis as { matchMedia: (query: string) => { matches: boolean } }).matchMedia
      ).bind(globalThis)
      : null;
  const media = matchMedia ?? globalMatchMedia;
  const reduce = media?.('(prefers-reduced-motion: reduce)').matches === true;
  return resolveReaderPageTurnEffect(appliedPageTurnStyle, reduce);
}

/** `html[data-reader-progress-bar=off]` hides tracks; chapter and percent stay. */
export function applyReaderPrefs(root: ReaderPrefsRoot, prefs: ReaderPrefs): void {
  root.dataset.readerProgressBar = prefs.showProgressBar ? 'on' : 'off';
  const style = isReaderPageTurnStyle(prefs.pageTurnStyle)
    ? prefs.pageTurnStyle
    : DEFAULT_READER_PREFS.pageTurnStyle;
  root.dataset.readerPageTurn = style;
  appliedPageTurnStyle = style;
}
