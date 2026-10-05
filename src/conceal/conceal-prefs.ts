/**
 * `conceal-prefs` — 书架与阅读器摸鱼（R2–R10/R13）的偏好模型与持久化。
 *
 * 纯函数模块（仿 src/ui/chrome-prefs.ts）：load 逐字段容错（缺失/损坏回
 * 默认），save 前整包校验（空组合、纯修饰键、两键同组、非法 #rrggbb、
 * opacity 越界 → 拒绝保存并保持旧值）。
 *
 * 场景（普通阅读 / 离开即隐 / 悬浮看文 / 自定义）由现有字段比较得出，不入库。
 *
 * 存储键为 `lightink.conceal.prefs`，走**普通 localStorage**（显式不加入
 * syncable-storage 允许清单）：老板键组合是平台相关的（macOS 用 Control，
 * Win/Linux 用 Alt），跨设备同步会把另一平台的默认键串过来。
 */

/** R5 预设渐变（书架与阅读器共用）。 */
export type ConcealGradientPreset = 'lavender' | 'mint' | 'peach' | 'sky' | 'butter';

/** R5 背景选择：主题背景 / 预设渐变 / 自定义起止色。 */
export type ConcealBackground =
  | { readonly kind: 'theme' }
  | { readonly kind: 'preset'; readonly preset: ConcealGradientPreset }
  | { readonly kind: 'custom'; readonly from: string; readonly to: string };

export interface ConcealPrefs {
  /**
   * R15 摸鱼总开关（默认 true；旧存储缺字段回 true，行为与升级前一致）。
   * false：书架设置段只剩总开关、阅读器顶栏调节条移除、全部窗口效果
   * （置顶/透明/迷你/穿透/分区隐藏）撤销、老板键注销、托盘摘除——
   * 已存偏好原样保留，重新打开即恢复。
   */
  readonly enabled: boolean;
  /** R2 老板键 1（accelerator 串，修饰键在前 + 恰好一个主键）。 */
  readonly bossPrimary: string;
  /** R2 老板键 2。 */
  readonly bossSecondary: string;
  /** R5 页面背景。 */
  readonly background: ConcealBackground;
  /** R6 透明模式（默认 false）。 */
  readonly transparentMode: boolean;
  /** R6 内容透明度 0–100（默认 100，超界不保存）。 */
  readonly contentOpacity: number;
  /** R7 顶栏/主体/底栏鼠标移出隐藏（主体与顶栏依赖透明模式，底栏独立）。 */
  readonly hideTop: boolean;
  readonly hideBody: boolean;
  readonly hideBottom: boolean;
  /** R8 置顶。 */
  readonly alwaysOnTop: boolean;
  /** R9 迷你窗口。 */
  readonly miniWindow: boolean;
  /** R13 点击穿透（依赖透明模式才生效）。 */
  readonly clickThrough: boolean;
  /**
   * 后台运行（默认 false）：点关闭收起到托盘继续运行，而非走退出确认。
   * 不参与场景匹配——场景只描述窗口效果，关闭行为独立保留。
   */
  readonly runInBackground: boolean;
}

export const CONCEAL_PREFS_STORAGE_KEY = 'lightink.conceal.prefs';

export const CONCEAL_GRADIENT_PRESETS: Readonly<Record<ConcealGradientPreset, { from: string; to: string }>> = {
  lavender: { from: '#c9b6e4', to: '#f1e9fb' },
  mint: { from: '#a9e2c8', to: '#e9fbf2' },
  peach: { from: '#f6c3a5', to: '#fdeee4' },
  sky: { from: '#a5cdf5', to: '#eaf4fe' },
  butter: { from: '#f7dc8f', to: '#fdf7e3' },
};

export interface ConcealStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 修饰键集合（与后端 global-hotkey 的解析口径对齐；macOS Ctrl=Control）。 */
const MODIFIER_KEYS = new Set([
  'CONTROL',
  'CTRL',
  'SHIFT',
  'ALT',
  'ALTGRAPH',
  'ALTGR',
  'SUPER',
  'META',
  'COMMAND',
  'CMD',
  'OS',
]);

/**
 * R2 组合串校验：非空、token 化后「前面的 token 全是修饰键、最后一个
 * token 是主键」。空串与纯修饰键（如 "Control+Shift"）都判 false。
 */
export function isValidHotkeyCombo(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  const tokens = value.split('+').map((token) => token.trim());
  if (tokens.some((token) => token === '')) {
    return false;
  }
  const main = tokens[tokens.length - 1];
  if (MODIFIER_KEYS.has(main.toUpperCase())) {
    return false;
  }
  return tokens.slice(0, -1).every((token) => MODIFIER_KEYS.has(token.toUpperCase()));
}

/** R2 同组判定：归一化（去空白 + 统一大小写）后字符串相等。 */
export function isSameHotkeyCombo(primary: string, secondary: string): boolean {
  const normalize = (value: string): string =>
    value.split('+').map((token) => token.trim().toUpperCase()).filter((t) => t !== '').join('+');
  return normalize(primary) === normalize(secondary) && normalize(primary) !== '';
}

/** R5 自定义颜色校验：#rrggbb。 */
export function isValidConcealColor(value: string): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** R2 平台默认组合：macOS Ctrl(=Control)+Z/X，Win/Linux Alt+Z/X。 */
export function defaultBossKeys(mac: boolean): { primary: string; secondary: string } {
  return mac
    ? { primary: 'Control+Z', secondary: 'Control+X' }
    : { primary: 'Alt+Z', secondary: 'Alt+X' };
}

export function defaultConcealPrefs(mac: boolean): ConcealPrefs {
  const boss = defaultBossKeys(mac);
  return {
    enabled: true,
    bossPrimary: boss.primary,
    bossSecondary: boss.secondary,
    background: { kind: 'theme' },
    transparentMode: false,
    contentOpacity: 100,
    hideTop: false,
    hideBody: false,
    hideBottom: false,
    alwaysOnTop: false,
    miniWindow: false,
    clickThrough: false,
    runInBackground: false,
  };
}

function parseBackground(raw: unknown): ConcealBackground {
  if (raw === null || typeof raw !== 'object') {
    return { kind: 'theme' };
  }
  const value = raw as { kind?: unknown; preset?: unknown; from?: unknown; to?: unknown };
  if (value.kind === 'theme') {
    return { kind: 'theme' };
  }
  if (value.kind === 'preset' && typeof value.preset === 'string' && value.preset in CONCEAL_GRADIENT_PRESETS) {
    return { kind: 'preset', preset: value.preset as ConcealGradientPreset };
  }
  if (
    value.kind === 'custom' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    isValidConcealColor(value.from) &&
    isValidConcealColor(value.to)
  ) {
    return { kind: 'custom', from: value.from, to: value.to };
  }
  return { kind: 'theme' };
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

/** 读取偏好；storage 缺失、键缺失、损坏 JSON 或字段非法都回默认值。 */
export function loadConcealPrefs(
  storage: ConcealStorageLike | null | undefined,
  mac: boolean,
): ConcealPrefs {
  const defaults = defaultConcealPrefs(mac);
  if (storage == null) {
    return defaults;
  }
  try {
    const raw = storage.getItem(CONCEAL_PREFS_STORAGE_KEY);
    if (raw === null || raw === '') {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<ConcealPrefs>;
    const opacityRaw = parsed.contentOpacity;
    return {
      enabled: parseBoolean(parsed.enabled, defaults.enabled),
      bossPrimary:
        typeof parsed.bossPrimary === 'string' && isValidHotkeyCombo(parsed.bossPrimary)
          ? parsed.bossPrimary
          : defaults.bossPrimary,
      bossSecondary:
        typeof parsed.bossSecondary === 'string' && isValidHotkeyCombo(parsed.bossSecondary)
          ? parsed.bossSecondary
          : defaults.bossSecondary,
      background: parseBackground(parsed.background),
      transparentMode: parseBoolean(parsed.transparentMode, defaults.transparentMode),
      contentOpacity:
        typeof opacityRaw === 'number' && Number.isInteger(opacityRaw) && opacityRaw >= 0 && opacityRaw <= 100
          ? opacityRaw
          : defaults.contentOpacity,
      hideTop: parseBoolean(parsed.hideTop, defaults.hideTop),
      hideBody: parseBoolean(parsed.hideBody, defaults.hideBody),
      hideBottom: parseBoolean(parsed.hideBottom, defaults.hideBottom),
      alwaysOnTop: parseBoolean(parsed.alwaysOnTop, defaults.alwaysOnTop),
      miniWindow: parseBoolean(parsed.miniWindow, defaults.miniWindow),
      clickThrough: parseBoolean(parsed.clickThrough, defaults.clickThrough),
      runInBackground: parseBoolean(parsed.runInBackground, defaults.runInBackground),
    };
  } catch {
    return defaults;
  }
}

/**
 * 整包校验：两键各自合法且互不同组、背景合法、opacity 为 0–100 整数。
 * 任一项不合法 → 不写存储，返回旧值（调用方继续用旧 prefs）。
 */
export function isConcealPrefsValid(prefs: ConcealPrefs): boolean {
  if (!isValidHotkeyCombo(prefs.bossPrimary) || !isValidHotkeyCombo(prefs.bossSecondary)) {
    return false;
  }
  if (isSameHotkeyCombo(prefs.bossPrimary, prefs.bossSecondary)) {
    return false;
  }
  if (
    prefs.background.kind === 'custom' &&
    (!isValidConcealColor(prefs.background.from) || !isValidConcealColor(prefs.background.to))
  ) {
    return false;
  }
  return (
    typeof prefs.contentOpacity === 'number' &&
    Number.isInteger(prefs.contentOpacity) &&
    prefs.contentOpacity >= 0 &&
    prefs.contentOpacity <= 100
  );
}

/**
 * 校验通过才持久化（R2/R5/R6「不保存保持旧值」）。返回实际落地的 prefs：
 * 校验失败时返回 `previous`（保持旧值），成功时返回规范化后的 `next`。
 */
export function saveConcealPrefs(
  storage: ConcealStorageLike | null | undefined,
  next: ConcealPrefs,
  previous: ConcealPrefs,
): ConcealPrefs {
  if (!isConcealPrefsValid(next)) {
    return previous;
  }
  const normalized: ConcealPrefs = {
    ...next,
    bossPrimary: next.bossPrimary.trim(),
    bossSecondary: next.bossSecondary.trim(),
    contentOpacity: Math.min(100, Math.max(0, Math.round(next.contentOpacity))),
  };
  if (storage != null) {
    try {
      storage.setItem(CONCEAL_PREFS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // 隐私模式/配额：忽略，内存值照常生效（下次启动回旧值）。
    }
  }
  return normalized;
}

/** 可写入的三个场景。自定义只是比较失败后的显示名，没有第四套写入。 */
export const CONCEAL_SCENE_CHOICES = ['normal', 'hideOnLeave', 'floating'] as const;

export type ConcealSceneChoice = (typeof CONCEAL_SCENE_CHOICES)[number];

/** `normal` 普通阅读，`hideOnLeave` 离开即隐，`floating` 悬浮看文，`custom` 自定义。 */
export type ConcealScene = ConcealSceneChoice | 'custom';

type ConcealSceneSwitches = Pick<
  ConcealPrefs,
  | 'transparentMode'
  | 'contentOpacity'
  | 'hideTop'
  | 'hideBody'
  | 'hideBottom'
  | 'alwaysOnTop'
  | 'miniWindow'
  | 'clickThrough'
>;

const NORMAL_SWITCHES: ConcealSceneSwitches = {
  transparentMode: false,
  contentOpacity: 100,
  hideTop: false,
  hideBody: false,
  hideBottom: false,
  alwaysOnTop: false,
  miniWindow: false,
  clickThrough: false,
};

const HIDE_ON_LEAVE_SWITCHES: ConcealSceneSwitches = {
  transparentMode: true,
  contentOpacity: 100,
  hideTop: true,
  hideBody: true,
  hideBottom: true,
  alwaysOnTop: true,
  miniWindow: false,
  clickThrough: true,
};

const FLOATING_SWITCHES: ConcealSceneSwitches = {
  transparentMode: true,
  contentOpacity: 60,
  hideTop: false,
  hideBody: false,
  hideBottom: false,
  alwaysOnTop: true,
  miniWindow: true,
  clickThrough: false,
};

const SCENE_SWITCHES: Readonly<Record<ConcealSceneChoice, ConcealSceneSwitches>> = {
  normal: NORMAL_SWITCHES,
  hideOnLeave: HIDE_ON_LEAVE_SWITCHES,
  floating: FLOATING_SWITCHES,
};

function switchesMatch(prefs: ConcealPrefs, switches: ConcealSceneSwitches): boolean {
  return (
    prefs.transparentMode === switches.transparentMode &&
    prefs.contentOpacity === switches.contentOpacity &&
    prefs.hideTop === switches.hideTop &&
    prefs.hideBody === switches.hideBody &&
    prefs.hideBottom === switches.hideBottom &&
    prefs.alwaysOnTop === switches.alwaysOnTop &&
    prefs.miniWindow === switches.miniWindow &&
    prefs.clickThrough === switches.clickThrough
  );
}

/**
 * 普通阅读连背景一起比较；离开即隐与悬浮看文忽略背景。
 * 三套写入互斥，顺序只把「背景也算」的普通阅读与另外两个场景分开。
 */
export function concealSceneOf(prefs: ConcealPrefs): ConcealScene {
  if (prefs.background.kind === 'theme' && switchesMatch(prefs, NORMAL_SWITCHES)) {
    return 'normal';
  }
  if (switchesMatch(prefs, HIDE_ON_LEAVE_SWITCHES)) {
    return 'hideOnLeave';
  }
  if (switchesMatch(prefs, FLOATING_SWITCHES)) {
    return 'floating';
  }
  return 'custom';
}

/** 按场景表覆盖负责字段。离开即隐与悬浮看文保留已存背景；老板键始终保留。 */
export function applyConcealScene(prefs: ConcealPrefs, scene: ConcealSceneChoice): ConcealPrefs {
  const next: ConcealPrefs = { ...prefs, ...SCENE_SWITCHES[scene] };
  return scene === 'normal' ? { ...next, background: { kind: 'theme' } } : next;
}

/** 背景选择 → CSS background 值；主题背景返回 null（CSS 回退主题变量）。 */
export function concealBackgroundToCss(background: ConcealBackground): string | null {
  if (background.kind === 'theme') {
    return null;
  }
  const colors =
    background.kind === 'preset'
      ? CONCEAL_GRADIENT_PRESETS[background.preset]
      : { from: background.from, to: background.to };
  return `linear-gradient(180deg, ${colors.from} 0%, ${colors.to} 100%)`;
}
