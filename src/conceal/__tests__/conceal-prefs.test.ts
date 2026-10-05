import { describe, expect, it } from 'vitest';

import {
  CONCEAL_GRADIENT_PRESETS,
  CONCEAL_PREFS_STORAGE_KEY,
  CONCEAL_SCENE_CHOICES,
  applyConcealScene,
  concealBackgroundToCss,
  concealSceneOf,
  defaultConcealPrefs,
  isSameHotkeyCombo,
  isValidConcealColor,
  isValidHotkeyCombo,
  loadConcealPrefs,
  saveConcealPrefs,
  type ConcealPrefs,
  type ConcealStorageLike,
} from '../conceal-prefs.js';

function memoryStorage(initial: Record<string, string> = {}): ConcealStorageLike & {
  dump(): Record<string, string>;
} {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    dump: () => Object.fromEntries(store.entries()),
  };
}

describe('conceal prefs defaults (R2/R5/R6/R7/R8/R9/R13)', () => {
  it('uses Alt+Z / Alt+X on Windows and Linux', () => {
    const prefs = defaultConcealPrefs(false);
    expect(prefs.bossPrimary).toBe('Alt+Z');
    expect(prefs.bossSecondary).toBe('Alt+X');
  });

  it('uses Control+Z / Control+X on macOS', () => {
    const prefs = defaultConcealPrefs(true);
    expect(prefs.bossPrimary).toBe('Control+Z');
    expect(prefs.bossSecondary).toBe('Control+X');
  });

  it('keeps every effect switch off and opacity at 100 by default', () => {
    const prefs = defaultConcealPrefs(false);
    expect(prefs.enabled).toBe(true);
    expect(prefs.transparentMode).toBe(false);
    expect(prefs.contentOpacity).toBe(100);
    expect(prefs.background).toEqual({ kind: 'theme' });
    expect(prefs.hideTop).toBe(false);
    expect(prefs.hideBody).toBe(false);
    expect(prefs.hideBottom).toBe(false);
    expect(prefs.alwaysOnTop).toBe(false);
    expect(prefs.miniWindow).toBe(false);
    expect(prefs.clickThrough).toBe(false);
    // 后台运行默认关闭：点关闭走原有退出流程，不收起到托盘。
    expect(prefs.runInBackground).toBe(false);
  });
});

describe('hotkey combo validation (R2)', () => {
  it('accepts modifier-first combos with exactly one main key', () => {
    expect(isValidHotkeyCombo('Alt+Z')).toBe(true);
    expect(isValidHotkeyCombo('Control+Z')).toBe(true);
    expect(isValidHotkeyCombo('Control+Shift+X')).toBe(true);
    expect(isValidHotkeyCombo('F9')).toBe(true);
  });

  it('rejects empty and modifier-only combos', () => {
    expect(isValidHotkeyCombo('')).toBe(false);
    expect(isValidHotkeyCombo('   ')).toBe(false);
    expect(isValidHotkeyCombo('Control')).toBe(false);
    expect(isValidHotkeyCombo('Control+Shift')).toBe(false);
    expect(isValidHotkeyCombo('Control+')).toBe(false);
  });

  it('rejects main keys placed before modifiers', () => {
    expect(isValidHotkeyCombo('Z+Control')).toBe(false);
  });

  it('treats case and whitespace variations of the same combo as equal', () => {
    expect(isSameHotkeyCombo('Alt+Z', ' alt+z ')).toBe(true);
    expect(isSameHotkeyCombo('Control+Shift+X', 'Control+shift+X')).toBe(true);
    expect(isSameHotkeyCombo('Alt+Z', 'Alt+X')).toBe(false);
    expect(isSameHotkeyCombo('', '')).toBe(false);
  });
});

describe('background model (R5)', () => {
  it('accepts only #rrggbb custom colors', () => {
    expect(isValidConcealColor('#a1b2c3')).toBe(true);
    expect(isValidConcealColor('#A1B2C3')).toBe(true);
    expect(isValidConcealColor('a1b2c3')).toBe(false);
    expect(isValidConcealColor('#a1b2')).toBe(false);
    expect(isValidConcealColor('#a1b2c3d4')).toBe(false);
    expect(isValidConcealColor('red')).toBe(false);
  });

  it('serializes theme / preset / custom backgrounds to CSS values', () => {
    expect(concealBackgroundToCss({ kind: 'theme' })).toBeNull();
    const butter = CONCEAL_GRADIENT_PRESETS.butter;
    expect(concealBackgroundToCss({ kind: 'preset', preset: 'butter' })).toBe(
      `linear-gradient(180deg, ${butter.from} 0%, ${butter.to} 100%)`,
    );
    expect(concealBackgroundToCss({ kind: 'custom', from: '#101010', to: '#efefef' })).toBe(
      'linear-gradient(180deg, #101010 0%, #efefef 100%)',
    );
  });
});

describe('save validation keeps the previous value (R2/R5/R6)', () => {
  const base: ConcealPrefs = { ...defaultConcealPrefs(false) };

  it('refuses to persist an empty or modifier-only boss key', () => {
    const storage = memoryStorage();
    const saved = saveConcealPrefs(storage, { ...base, bossPrimary: 'Control+Shift' }, base);
    expect(saved).toBe(base);
    expect(storage.dump()[CONCEAL_PREFS_STORAGE_KEY]).toBeUndefined();
  });

  it('refuses to persist two identical boss keys', () => {
    const storage = memoryStorage();
    const saved = saveConcealPrefs(storage, { ...base, bossSecondary: base.bossPrimary }, base);
    expect(saved).toBe(base);
    expect(storage.dump()[CONCEAL_PREFS_STORAGE_KEY]).toBeUndefined();
  });

  it('refuses to persist an invalid custom gradient color', () => {
    const storage = memoryStorage();
    const saved = saveConcealPrefs(
      storage,
      { ...base, background: { kind: 'custom', from: 'nope', to: '#ffffff' } },
      base,
    );
    expect(saved).toBe(base);
  });

  it('refuses to persist out-of-range content opacity', () => {
    const storage = memoryStorage();
    expect(saveConcealPrefs(storage, { ...base, contentOpacity: 101 }, base)).toBe(base);
    expect(saveConcealPrefs(storage, { ...base, contentOpacity: -1 }, base)).toBe(base);
    expect(saveConcealPrefs(storage, { ...base, contentOpacity: 50.5 }, base)).toBe(base);
  });

  it('persists a fully valid bundle', () => {
    const storage = memoryStorage();
    const valid: ConcealPrefs = {
      ...base,
      transparentMode: true,
      contentOpacity: 40,
      background: { kind: 'custom', from: '#112233', to: '#332211' },
    };
    const saved = saveConcealPrefs(storage, valid, base);
    expect(saved).toEqual(valid);
    expect(storage.dump()[CONCEAL_PREFS_STORAGE_KEY]).toBe(JSON.stringify(valid));
  });
});

describe('save → load round trip (R10)', () => {
  it('restores a saved bundle unchanged', () => {
    const storage = memoryStorage();
    const next: ConcealPrefs = {
      ...defaultConcealPrefs(true),
      bossPrimary: 'Control+Shift+P',
      bossSecondary: 'Control+Shift+Q',
      background: { kind: 'preset', preset: 'sky' },
      transparentMode: true,
      contentOpacity: 65,
      hideTop: true,
      hideBody: true,
      hideBottom: true,
      alwaysOnTop: true,
      miniWindow: true,
      clickThrough: true,
    };
    saveConcealPrefs(storage, next, defaultConcealPrefs(true));
    expect(loadConcealPrefs(storage, true)).toEqual(next);
  });

  it('falls back to defaults on a missing key', () => {
    expect(loadConcealPrefs(memoryStorage(), false)).toEqual(defaultConcealPrefs(false));
  });

  it('R15: restores a stored enabled=false and defaults missing field to true', () => {
    const off = { ...defaultConcealPrefs(false), enabled: false };
    const storage = memoryStorage({
      [CONCEAL_PREFS_STORAGE_KEY]: JSON.stringify(off),
    });
    expect(loadConcealPrefs(storage, false).enabled).toBe(false);

    // 旧版本存储没有 enabled 字段 → 回 true（行为与升级前一致）。
    const legacy = { ...off } as Record<string, unknown>;
    delete legacy.enabled;
    const legacyStorage = memoryStorage({
      [CONCEAL_PREFS_STORAGE_KEY]: JSON.stringify(legacy),
    });
    expect(loadConcealPrefs(legacyStorage, false).enabled).toBe(true);
  });

  it('后台运行: restores a stored true and defaults a missing field to false', () => {
    const on = { ...defaultConcealPrefs(false), runInBackground: true };
    const storage = memoryStorage({
      [CONCEAL_PREFS_STORAGE_KEY]: JSON.stringify(on),
    });
    expect(loadConcealPrefs(storage, false).runInBackground).toBe(true);

    // 旧版本存储没有 runInBackground 字段 → 回 false（默认不后台运行）。
    const legacy = { ...on } as Record<string, unknown>;
    delete legacy.runInBackground;
    const legacyStorage = memoryStorage({
      [CONCEAL_PREFS_STORAGE_KEY]: JSON.stringify(legacy),
    });
    expect(loadConcealPrefs(legacyStorage, false).runInBackground).toBe(false);
  });

  it('falls back to defaults on corrupt JSON', () => {
    const storage = memoryStorage({ [CONCEAL_PREFS_STORAGE_KEY]: '{not-json' });
    expect(loadConcealPrefs(storage, false)).toEqual(defaultConcealPrefs(false));
  });

  it('falls back per-field when individual values are invalid', () => {
    const storage = memoryStorage({
      [CONCEAL_PREFS_STORAGE_KEY]: JSON.stringify({
        bossPrimary: 'Control+Shift',
        bossSecondary: 'Alt+X',
        contentOpacity: 300,
        background: { kind: 'custom', from: 'bad', to: '#ffffff' },
        transparentMode: 'yes',
      }),
    });
    const prefs = loadConcealPrefs(storage, false);
    expect(prefs.bossPrimary).toBe('Alt+Z');
    expect(prefs.bossSecondary).toBe('Alt+X');
    expect(prefs.contentOpacity).toBe(100);
    expect(prefs.background).toEqual({ kind: 'theme' });
    expect(prefs.transparentMode).toBe(false);
  });

  it('treats a null storage as defaults (non-persisted environments)', () => {
    expect(loadConcealPrefs(null, false)).toEqual(defaultConcealPrefs(false));
  });
});

const RESPONSIBLE_SWITCHES = [
  'transparentMode',
  'contentOpacity',
  'hideTop',
  'hideBody',
  'hideBottom',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const;

type ResponsibleSwitch = (typeof RESPONSIBLE_SWITCHES)[number];

function deviateSwitch(prefs: ConcealPrefs, key: ResponsibleSwitch): ConcealPrefs {
  if (key === 'contentOpacity') {
    return { ...prefs, contentOpacity: 80 };
  }
  return { ...prefs, [key]: !prefs[key] };
}

describe('conceal scenes (R1)', () => {
  const seed: ConcealPrefs = {
    ...defaultConcealPrefs(false),
    bossPrimary: 'Control+Shift+P',
    bossSecondary: 'Control+Shift+Q',
    background: { kind: 'custom', from: '#010203', to: '#040506' },
    transparentMode: true,
    contentOpacity: 40,
    hideTop: true,
    hideBody: false,
    hideBottom: true,
    alwaysOnTop: false,
    miniWindow: true,
    clickThrough: false,
  };

  it('writes normal reading, including the theme background', () => {
    const next = applyConcealScene(seed, 'normal');
    expect(next).toEqual({
      ...seed,
      background: { kind: 'theme' },
      transparentMode: false,
      contentOpacity: 100,
      hideTop: false,
      hideBody: false,
      hideBottom: false,
      alwaysOnTop: false,
      miniWindow: false,
      clickThrough: false,
    });
    expect(next.bossPrimary).toBe(seed.bossPrimary);
    expect(next.bossSecondary).toBe(seed.bossSecondary);
    expect(concealSceneOf(next)).toBe('normal');
    expect(concealSceneOf(defaultConcealPrefs(false))).toBe('normal');
    expect(concealSceneOf(defaultConcealPrefs(true))).toBe('normal');
  });

  it('writes hide-on-leave without changing the stored background', () => {
    const next = applyConcealScene(seed, 'hideOnLeave');
    expect(next).toEqual({
      ...seed,
      transparentMode: true,
      contentOpacity: 100,
      hideTop: true,
      hideBody: true,
      hideBottom: true,
      alwaysOnTop: true,
      miniWindow: false,
      clickThrough: true,
    });
    expect(next.background).toBe(seed.background);
    expect(concealSceneOf(next)).toBe('hideOnLeave');
    const onTheme = applyConcealScene(defaultConcealPrefs(false), 'hideOnLeave');
    expect(onTheme.background).toEqual({ kind: 'theme' });
    expect(concealSceneOf(onTheme)).toBe('hideOnLeave');
  });

  it('writes floating read without changing the stored background', () => {
    const next = applyConcealScene(seed, 'floating');
    expect(next).toEqual({
      ...seed,
      transparentMode: true,
      contentOpacity: 60,
      hideTop: false,
      hideBody: false,
      hideBottom: false,
      alwaysOnTop: true,
      miniWindow: true,
      clickThrough: false,
    });
    expect(next.background).toBe(seed.background);
    expect(concealSceneOf(next)).toBe('floating');
    const onTheme = applyConcealScene(defaultConcealPrefs(true), 'floating');
    expect(onTheme.background).toEqual({ kind: 'theme' });
    expect(onTheme.bossPrimary).toBe('Control+Z');
    expect(concealSceneOf(onTheme)).toBe('floating');
  });

  it.each(
    (['hideOnLeave', 'floating'] as const).flatMap((scene) =>
      RESPONSIBLE_SWITCHES.map((key) => [scene, key] as const),
    ),
  )('%s becomes custom after only %s changes, then that scene restores it', (scene, key) => {
    const applied = applyConcealScene(seed, scene);
    const changed = deviateSwitch(applied, key);
    expect(concealSceneOf(changed)).toBe('custom');
    expect(applyConcealScene(changed, scene)).toEqual(applied);
  });

  it.each(['hideOnLeave', 'floating'] as const)('keeps %s when only the background changes', (scene) => {
    const applied = applyConcealScene(seed, scene);
    const changed: ConcealPrefs = {
      ...applied,
      background: { kind: 'preset', preset: 'butter' },
    };
    expect(concealSceneOf(changed)).toBe(scene);
    const again = applyConcealScene(changed, scene);
    expect(again.background).toBe(changed.background);
    expect(concealSceneOf(again)).toBe(scene);
  });

  it('becomes custom when normal reading background leaves the theme', () => {
    const applied = applyConcealScene(seed, 'normal');
    expect(concealSceneOf({ ...applied, background: { kind: 'preset', preset: 'sky' } })).toBe('custom');
    expect(
      concealSceneOf({ ...applied, background: { kind: 'custom', from: '#112233', to: '#445566' } }),
    ).toBe('custom');
  });

  it('ignores boss keys when deriving the scene', () => {
    for (const scene of CONCEAL_SCENE_CHOICES) {
      const applied = applyConcealScene(seed, scene);
      expect(concealSceneOf({ ...applied, bossPrimary: 'Alt+P', bossSecondary: 'Alt+Q' })).toBe(scene);
    }
  });

  it('ignores runInBackground when deriving the scene', () => {
    for (const scene of CONCEAL_SCENE_CHOICES) {
      const applied = applyConcealScene(seed, scene);
      expect(concealSceneOf({ ...applied, runInBackground: true })).toBe(scene);
    }
  });

  it('does not store a scene field', () => {
    const storage = memoryStorage();
    const applied = applyConcealScene(seed, 'hideOnLeave');
    saveConcealPrefs(storage, applied, seed);
    const raw = JSON.parse(storage.dump()[CONCEAL_PREFS_STORAGE_KEY] ?? '') as Record<string, unknown>;
    expect(raw).not.toHaveProperty('scene');
    expect(concealSceneOf(loadConcealPrefs(storage, false))).toBe('hideOnLeave');
  });
});
