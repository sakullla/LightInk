/**
 * Reader-flow typography (R4).
 *
 * Owns `lightink.reader.typography`: font, size step, line height, and
 * measure. Size steps reuse `font-scale.ts` values but never write
 * `lightink.fontScale`. Column `minRem` is this stored measure so a
 * row-length change reopens or closes the second column.
 */

import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_STEPS,
  snapFontScale,
  type FontScaleStep,
} from '../ui/font-scale.js';
import {
  DEFAULT_READING_MEASURE_REM,
  type ReadingColumnLayoutOptions,
} from '../ui/reading-layout.js';

export const READER_TYPOGRAPHY_STORAGE_KEY = 'lightink.reader.typography';

/** Existing flow body stack (`reader.css` / theme tokens). */
export const READER_FONT_FAMILY_PRESETS = {
  body: 'var(--lightink-font-body)',
  sans: 'var(--lightink-font-ui)',
  serif:
    '"Palatino Linotype", Palatino, "Iowan Old Style", "Songti SC", "STSong", "Noto Serif SC", Georgia, serif',
  mono: 'var(--lightink-font-mono)',
} as const;

export type ReaderFontFamilyPreset = keyof typeof READER_FONT_FAMILY_PRESETS;

export const DEFAULT_READER_FONT_FAMILY = READER_FONT_FAMILY_PRESETS.body;

export const MIN_READER_LINE_HEIGHT = 1.5;
export const MAX_READER_LINE_HEIGHT = 2.2;
export const DEFAULT_READER_LINE_HEIGHT = 1.8;

export const MIN_READER_MEASURE_REM = 16;
export const MAX_READER_MEASURE_REM = 32;
export const DEFAULT_READER_MEASURE_REM = DEFAULT_READING_MEASURE_REM;

export const READER_TYPOGRAPHY_VARS = {
  fontFamily: '--lightink-reader-font-family',
  fontScale: '--lightink-reader-font-scale',
  lineHeight: '--lightink-reader-line-height',
  measureRem: '--lightink-reader-measure-rem',
  measure: '--lightink-reader-measure',
} as const;

export interface ReaderTypography {
  readonly fontFamily: string;
  readonly fontScaleStep: FontScaleStep;
  readonly lineHeight: number;
  readonly measureRem: number;
  /** 阅读态下完全隐藏底部状态栏（编辑器状态栏不受影响）。 */
  readonly hideStatusBar: boolean;
}

export const DEFAULT_READER_TYPOGRAPHY: ReaderTypography = {
  fontFamily: DEFAULT_READER_FONT_FAMILY,
  fontScaleStep: DEFAULT_FONT_SCALE,
  lineHeight: DEFAULT_READER_LINE_HEIGHT,
  measureRem: DEFAULT_READER_MEASURE_REM,
  hideStatusBar: false,
};

export interface ReaderTypographyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReaderTypographyRoot {
  style: {
    setProperty(name: string, value: string, priority?: string): void;
    removeProperty(name: string): string | void;
  };
}

export function defaultReaderTypography(): ReaderTypography {
  return { ...DEFAULT_READER_TYPOGRAPHY };
}

export function snapReaderLineHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_READER_LINE_HEIGHT;
  }
  const clamped = Math.min(MAX_READER_LINE_HEIGHT, Math.max(MIN_READER_LINE_HEIGHT, value));
  return Math.round(clamped * 20) / 20;
}

export function snapReaderMeasureRem(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_READER_MEASURE_REM;
  }
  return Math.min(MAX_READER_MEASURE_REM, Math.max(MIN_READER_MEASURE_REM, Math.round(value)));
}

export function resolveReaderFontFamily(fontFamily: string): string {
  if (fontFamily in READER_FONT_FAMILY_PRESETS) {
    return READER_FONT_FAMILY_PRESETS[fontFamily as ReaderFontFamilyPreset];
  }
  if (isSafeFontFamily(fontFamily)) {
    return fontFamily;
  }
  return READER_FONT_FAMILY_PRESETS.body;
}

/** Unsnapped draft accepted from storage, CSS, or tests before `snapFontScale`. */
export interface ReaderTypographyInput {
  readonly fontFamily?: string;
  readonly fontScaleStep?: number;
  readonly lineHeight?: number;
  readonly measureRem?: number;
  readonly hideStatusBar?: boolean;
}

export function normalizeReaderTypography(
  value: ReaderTypographyInput | null | undefined,
): ReaderTypography {
  const fallback = defaultReaderTypography();
  if (value == null) {
    return fallback;
  }
  return {
    fontFamily: normalizeFontFamily(value.fontFamily, fallback.fontFamily),
    fontScaleStep: snapFontScale(
      typeof value.fontScaleStep === 'number' ? value.fontScaleStep : fallback.fontScaleStep,
    ),
    lineHeight: snapReaderLineHeight(
      typeof value.lineHeight === 'number' ? value.lineHeight : fallback.lineHeight,
    ),
    measureRem: snapReaderMeasureRem(
      typeof value.measureRem === 'number' ? value.measureRem : fallback.measureRem,
    ),
    hideStatusBar:
      typeof value.hideStatusBar === 'boolean' ? value.hideStatusBar : fallback.hideStatusBar,
  };
}

export function parseReaderTypography(raw: string | null | undefined): ReaderTypography {
  if (raw === null || raw === undefined || raw === '') {
    return defaultReaderTypography();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return defaultReaderTypography();
    }
    return normalizeReaderTypography({
      fontFamily: typeof parsed.fontFamily === 'string' ? parsed.fontFamily : undefined,
      fontScaleStep: typeof parsed.fontScaleStep === 'number' ? parsed.fontScaleStep : undefined,
      lineHeight: typeof parsed.lineHeight === 'number' ? parsed.lineHeight : undefined,
      measureRem: typeof parsed.measureRem === 'number' ? parsed.measureRem : undefined,
      hideStatusBar: typeof parsed.hideStatusBar === 'boolean' ? parsed.hideStatusBar : undefined,
    });
  } catch {
    return defaultReaderTypography();
  }
}

export function loadReaderTypography(
  storage: ReaderTypographyStorage | null | undefined,
): ReaderTypography {
  if (storage == null) {
    return defaultReaderTypography();
  }
  try {
    return parseReaderTypography(storage.getItem(READER_TYPOGRAPHY_STORAGE_KEY));
  } catch {
    return defaultReaderTypography();
  }
}

export function saveReaderTypography(
  storage: ReaderTypographyStorage | null | undefined,
  typography: ReaderTypographyInput,
): ReaderTypography {
  const next = normalizeReaderTypography({
    ...loadReaderTypography(storage),
    ...typography,
  });
  if (storage == null) {
    return next;
  }
  try {
    storage.setItem(READER_TYPOGRAPHY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Privacy mode / quota — keep the session value.
  }
  return next;
}

export function applyReaderTypography(
  root: ReaderTypographyRoot,
  typography: ReaderTypography,
): ReaderTypography {
  const next = normalizeReaderTypography(typography);
  const fontFamily = resolveReaderFontFamily(next.fontFamily);
  root.style.setProperty(READER_TYPOGRAPHY_VARS.fontFamily, fontFamily);
  root.style.setProperty(READER_TYPOGRAPHY_VARS.fontScale, String(next.fontScaleStep));
  root.style.setProperty(READER_TYPOGRAPHY_VARS.lineHeight, String(next.lineHeight));
  root.style.setProperty(READER_TYPOGRAPHY_VARS.measureRem, String(next.measureRem));
  root.style.setProperty(READER_TYPOGRAPHY_VARS.measure, `${next.measureRem}rem`);
  return next;
}

export function readerTypographyColumnMinRem(typography: ReaderTypography): number {
  return normalizeReaderTypography(typography).measureRem;
}

export function readerTypographyColumnOptions(
  typography: ReaderTypography,
): ReadingColumnLayoutOptions {
  const minRem = readerTypographyColumnMinRem(typography);
  return { minRem, optRem: minRem, maxColumns: 2 };
}

export function readerTypographyFontSizePx(
  typography: ReaderTypography,
  basePx = 16,
): number {
  const base = Number.isFinite(basePx) && basePx > 0 ? basePx : 16;
  return base * normalizeReaderTypography(typography).fontScaleStep;
}

export function readerFontScaleSteps(): readonly FontScaleStep[] {
  return FONT_SCALE_STEPS;
}

/** Next discrete reader size step; does not read or write `lightink.fontScale`. */
export function stepReaderFontScale(current: number, direction: 1 | -1): FontScaleStep {
  const snapped = snapFontScale(current);
  const idx = FONT_SCALE_STEPS.indexOf(snapped);
  const next = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, idx + direction));
  return FONT_SCALE_STEPS[next]!;
}

export function nextReaderFontScaleStep(
  current: number,
  action: 'in' | 'out' | 'reset',
): FontScaleStep {
  if (action === 'reset') {
    return DEFAULT_FONT_SCALE;
  }
  return stepReaderFontScale(current, action === 'in' ? 1 : -1);
}

function normalizeFontFamily(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw in READER_FONT_FAMILY_PRESETS || isSafeFontFamily(raw)) {
    return raw;
  }
  return fallback;
}

function isSafeFontFamily(value: string): boolean {
  return value.trim() !== '' && !/[;{}]/.test(value) && !/\n|\r/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
