/**
 * Persistable reader flow typography: font, size, line-height, and measure.
 *
 * Contract for `src/reader/reader-typography.ts`:
 * - `READER_TYPOGRAPHY_STORAGE_KEY` is `lightink.reader.typography`
 * - stored shape is `{ fontFamily, fontScaleStep, lineHeight, measureRem }`
 * - defaults: current flow font token, `FONT_SCALE_STEPS` default, line-height 1.8, measure 22
 * - never writes `lightink.fontScale`
 * - `applyReaderTypography` writes reader CSS variables immediately
 * - changing `measureRem` re-decides column count via `readerFlowColumnLayout`
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FONT_SCALE, FONT_SCALE_STORAGE_KEY, FONT_SCALE_STEPS } from '../../ui/font-scale.js';
import { readerFlowColumnLayout } from '../reader-layout.js';
import {
  DEFAULT_READER_TYPOGRAPHY,
  READER_FONT_FAMILY_PRESETS,
  READER_TYPOGRAPHY_STORAGE_KEY,
  applyReaderTypography,
  loadReaderTypography,
  nextReaderFontScaleStep,
  parseReaderTypography,
  resolveReaderFontFamily,
  saveReaderTypography,
  stepReaderFontScale,
} from '../reader-typography.js';

function memoryStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
} {
  const store = { ...initial };
  return {
    store,
    storage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    },
  };
}

describe('DEFAULT_READER_TYPOGRAPHY', () => {
  it('keeps the current flow font, a font-scale step, readable line-height, and 22rem measure', () => {
    expect(DEFAULT_READER_TYPOGRAPHY.fontFamily).toBe('var(--lightink-font-body)');
    expect(DEFAULT_READER_TYPOGRAPHY.fontScaleStep).toBe(DEFAULT_FONT_SCALE);
    expect(FONT_SCALE_STEPS).toContain(DEFAULT_READER_TYPOGRAPHY.fontScaleStep);
    expect(DEFAULT_READER_TYPOGRAPHY.lineHeight).toBe(1.8);
    expect(DEFAULT_READER_TYPOGRAPHY.lineHeight).toBeGreaterThanOrEqual(1.5);
    expect(DEFAULT_READER_TYPOGRAPHY.measureRem).toBe(22);
  });
});

describe('parseReaderTypography', () => {
  it('accepts a full preference object and snaps font scale to an existing step', () => {
    expect(
      parseReaderTypography(
        JSON.stringify({
          fontFamily: '"Source Serif 4", serif',
          fontScaleStep: 1.25,
          lineHeight: 1.5,
          measureRem: 28,
        }),
      ),
    ).toEqual({
      fontFamily: '"Source Serif 4", serif',
      fontScaleStep: 1.25,
      lineHeight: 1.5,
      measureRem: 28,
      // 旧偏好没有 hideStatusBar 字段，解析后默认 false（向后兼容）
      hideStatusBar: false,
    });
    expect(
      parseReaderTypography(
        JSON.stringify({
          fontFamily: 'Georgia, serif',
          fontScaleStep: 1.1,
          lineHeight: 1.65,
          measureRem: 18,
        }),
      ).fontScaleStep,
    ).toBe(1.125);
  });

  it('returns defaults for missing, corrupt, or partial records', () => {
    expect(parseReaderTypography(null)).toEqual(DEFAULT_READER_TYPOGRAPHY);
    expect(parseReaderTypography('{')).toEqual(DEFAULT_READER_TYPOGRAPHY);
    expect(parseReaderTypography(JSON.stringify({ fontFamily: 'Georgia, serif' }))).toEqual({
      ...DEFAULT_READER_TYPOGRAPHY,
      fontFamily: 'Georgia, serif',
    });
  });
});

describe('load/saveReaderTypography', () => {
  it('round-trips a non-default font, size, line-height, and measure without touching the app font scale', () => {
    const { store, storage } = memoryStorage();
    const next = {
      fontFamily: 'Georgia, serif',
      fontScaleStep: 1.25,
      lineHeight: 1.5,
      measureRem: 18,
      hideStatusBar: false,
    };
    saveReaderTypography(storage, next);
    expect(store[FONT_SCALE_STORAGE_KEY]).toBeUndefined();
    expect(JSON.parse(store[READER_TYPOGRAPHY_STORAGE_KEY]!)).toEqual(next);
    expect(loadReaderTypography(storage)).toEqual(next);
    expect(loadReaderTypography(storage)).not.toEqual(DEFAULT_READER_TYPOGRAPHY);
  });

  it('reloads the same choices after a later reading-mode session', () => {
    const { storage } = memoryStorage();
    const chosen = {
      fontFamily: '"Iowan Old Style", serif',
      fontScaleStep: 1.125,
      lineHeight: 1.65,
      measureRem: 28,
      hideStatusBar: true,
    };
    saveReaderTypography(storage, chosen);
    expect(loadReaderTypography(storage)).toEqual(chosen);
    expect(loadReaderTypography(storage)).toEqual(chosen);
  });

  it('returns defaults when storage is missing or throws', () => {
    expect(loadReaderTypography(null)).toEqual(DEFAULT_READER_TYPOGRAPHY);
    expect(
      loadReaderTypography({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
      }),
    ).toEqual(DEFAULT_READER_TYPOGRAPHY);
  });
});

describe('resolveReaderFontFamily', () => {
  it('maps preset keys and falls back to the body stack for unsafe families', () => {
    expect(resolveReaderFontFamily('serif')).toBe(READER_FONT_FAMILY_PRESETS.serif);
    expect(resolveReaderFontFamily('Georgia, serif')).toBe('Georgia, serif');
    expect(resolveReaderFontFamily('evil; background:red')).toBe(READER_FONT_FAMILY_PRESETS.body);
  });
});

describe('stepReaderFontScale', () => {
  it('steps along FONT_SCALE_STEPS and clamps at the ends without writing the editor key', () => {
    const { store, storage } = memoryStorage();
    expect(stepReaderFontScale(1, 1)).toBe(1.125);
    expect(stepReaderFontScale(1.1, -1)).toBe(1);
    expect(nextReaderFontScaleStep(1, 'in')).toBe(1.125);
    expect(nextReaderFontScaleStep(1.25, 'out')).toBe(1.125);
    expect(nextReaderFontScaleStep(1.25, 'reset')).toBe(DEFAULT_FONT_SCALE);
    expect(stepReaderFontScale(FONT_SCALE_STEPS[0]!, -1)).toBe(FONT_SCALE_STEPS[0]);
    expect(stepReaderFontScale(FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1]!, 1)).toBe(
      FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1],
    );
    expect(store[FONT_SCALE_STORAGE_KEY]).toBeUndefined();
    expect(storage.getItem(FONT_SCALE_STORAGE_KEY)).toBeNull();
  });
});

describe('applyReaderTypography', () => {
  it('writes reader CSS variables immediately without using the theme CSS editor', () => {
    const props: Record<string, string> = {};
    const root = {
      style: {
        setProperty(name: string, value: string) {
          props[name] = value;
        },
        removeProperty(name: string) {
          delete props[name];
        },
      },
    };
    applyReaderTypography(root, {
      fontFamily: 'Georgia, serif',
      fontScaleStep: 1.25,
      lineHeight: 1.5,
      measureRem: 18,
      hideStatusBar: false,
    });
    expect(props['--lightink-reader-font-family']).toBe('Georgia, serif');
    expect(props['--lightink-reader-font-scale']).toBe('1.25');
    expect(props['--lightink-reader-line-height']).toBe('1.5');
    expect(props['--lightink-reader-measure-rem']).toBe('18');
    expect(props['--lightink-reader-measure']).toBe('18rem');
    expect(props['--lightink-font-scale']).toBeUndefined();
  });
});

describe('measureRem and columns', () => {
  it('recomputes facing columns from the stored measure instead of a frozen 22rem', () => {
    const comfortable = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 22 };
    const longer = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 32 };
    expect(readerFlowColumnLayout(1000, 16, comfortable.measureRem).columns).toBe(2);
    expect(readerFlowColumnLayout(1000, 16, longer.measureRem).columns).toBe(1);
  });
});
