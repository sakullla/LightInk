/**
 * `ThemeService` — 主题系统唯一 owner（T6, R6）。
 *
 * 职责：
 *   - 内置主题：4 套预设（warm-light 纸墨浅色默认护眼 / cool-light 云白浅色 /
 *     dark 墨夜深色 / midnight 深空深色），令牌定义在 tokens.css，通过
 *     `<html data-theme="...">` 属性切换；
 *   - 首次启动默认 warm-light（按 Recipe 明确不跟随系统偏好），上次选择
 *     持久化到 localStorage（键 `lightink.theme`）；
 *   - 自定义主题：一份用户 CSS 文本，注入专用 <style>（热替换 = 重新设置
 *     该标签内容，无需重启）。自定义 CSS 未覆盖的令牌回退到 :root 上的
 *     warm-light 定义（见 tokens.css）；
 *   - 自定义主题文件的热重载：`reloadCustomThemeFile(path)` 每次调用重新
 *     读取文件并替换注入内容。文件变更的触发（watcher 或「重新加载主题」
 *     按钮）由 UI 层（T11）接线，本服务只提供原子 reload API。
 *
 * 可测试性：root / 样式槽 / localStorage / readFile 全部依赖注入，
 * vitest 在 node 环境下以 fake 替换即可，无需 DOM。
 */

export type BuiltinThemeId =
  | 'warm-light'
  | 'cool-light'
  | 'dark'
  | 'midnight';

export interface BuiltinTheme {
  id: BuiltinThemeId;
  label: string;
}

/** 内置主题列表（顺序即视图菜单展示顺序）。浅/深各两套，配色定义见 tokens.css。 */
export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { id: 'warm-light', label: '纸墨浅色' },
  { id: 'cool-light', label: '云白浅色' },
  { id: 'dark', label: '墨夜深色' },
  { id: 'midnight', label: '深空深色' },
];

/** 首次启动的默认主题（Recipe：默认暖色护眼，非纯白背景）。 */
export const DEFAULT_THEME_ID: BuiltinThemeId = 'warm-light';

/** localStorage 键：上次选择的主题 id（内置 id 或 'custom'）。 */
export const THEME_STORAGE_KEY = 'lightink.theme';
/** localStorage 键：自定义主题 CSS 文件路径（供重载/下次启动恢复）。 */
export const CUSTOM_THEME_PATH_KEY = 'lightink.theme.customPath';
/** Managed CSS text used for sync; unlike the path, this is portable. */
export const CUSTOM_THEME_CSS_KEY = 'lightink.theme.customCss';
/** 自定义主题激活时的 currentThemeId。 */
export const CUSTOM_THEME_ID = 'custom';

/** 承载 data-theme 属性的根元素（生产为 document.documentElement）。 */
export interface ThemeRootLike {
  setAttribute(name: string, value: string): void;
}

/** 自定义 CSS 的注入槽：set 为热替换（覆盖式写入），clear 为移除。 */
export interface CustomStyleSlot {
  set(cssText: string): void;
  clear(): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ThemeServiceDeps {
  root: ThemeRootLike;
  customStyleSlot: CustomStyleSlot;
  /** 可空：无存储环境（如隐私模式）时仅本次会话生效。 */
  storage?: StorageLike | null;
  /** 重新读取自定义主题文件（生产为 file-service 的 readFile）。 */
  readFile?: (path: string) => Promise<string>;
  /** 主题切换后同步原生窗口明暗（生产为 Tauri setTheme）。 */
  syncNativeTheme?: (dark: boolean) => void;
  /** 主题切换后广播通知（生产派发 lightink:theme-change，供 reader 等订阅）。 */
  onThemeChange?: () => void;
}

/** 生产实现：在 document.head 创建专用 <style> 并返回其注入槽。 */
export function createStyleTagSlot(doc: Document): CustomStyleSlot {
  const tag = doc.createElement('style');
  tag.id = 'lightink-custom-theme';
  doc.head.appendChild(tag);
  return {
    set(cssText: string): void {
      tag.textContent = cssText;
    },
    clear(): void {
      tag.textContent = '';
    },
  };
}

function isBuiltinThemeId(value: string | null): value is BuiltinThemeId {
  return (
    value === 'warm-light' ||
    value === 'cool-light' ||
    value === 'dark' ||
    value === 'midnight'
  );
}

/** 解析自定义 CSS 的首个 `color-scheme` 值是否为深色（缺失/无法解析回退浅色）。 */
export function customThemeIsDark(cssText: string): boolean {
  const match = /(?:^|[;{}\s])color-scheme\s*:\s*([^;}{]+)/i.exec(cssText);
  if (match === null) {
    return false;
  }
  const first = match[1]?.trim().split(/\s+/)[0]?.toLowerCase();
  return first === 'dark';
}

export class ThemeService {
  private readonly deps: ThemeServiceDeps;
  private current: BuiltinThemeId | typeof CUSTOM_THEME_ID;
  private customPath: string | null = null;
  private customCss: string | null = null;

  constructor(deps: ThemeServiceDeps) {
    this.deps = deps;
    const saved = deps.storage?.getItem(THEME_STORAGE_KEY) ?? null;
    this.customPath = deps.storage?.getItem(CUSTOM_THEME_PATH_KEY) ?? null;
    const savedCss = deps.storage?.getItem(CUSTOM_THEME_CSS_KEY) ?? null;
    const savedCustom = saved === CUSTOM_THEME_ID && (savedCss !== null || this.customPath !== null);
    // Custom CSS is injected asynchronously by restorePersistedCustomTheme.
    this.current = savedCustom
      ? CUSTOM_THEME_ID
      : isBuiltinThemeId(saved)
        ? saved
        : DEFAULT_THEME_ID;
    this.deps.root.setAttribute('data-theme', this.current);
    this.notifyNativeTheme();
  }

  /** 当前主题 id：内置 id 或 'custom'。 */
  get currentThemeId(): string {
    return this.current;
  }

  get isCustomThemeActive(): boolean {
    return this.current === CUSTOM_THEME_ID;
  }

  /** 最近一次加载的自定义主题文件路径（若有）。 */
  get customThemePath(): string | null {
    return this.customPath;
  }

  builtinThemes(): readonly BuiltinTheme[] {
    return BUILTIN_THEMES;
  }

  /** 应用内置主题：设置 data-theme、清除自定义注入并持久化。 */
  apply(themeId: BuiltinThemeId): void {
    if (!isBuiltinThemeId(themeId)) {
      throw new Error(`ThemeService: unknown builtin theme "${String(themeId)}"`);
    }
    this.current = themeId;
    this.deps.customStyleSlot.clear();
    this.deps.root.setAttribute('data-theme', themeId);
    this.deps.storage?.setItem(THEME_STORAGE_KEY, themeId);
    this.notifyNativeTheme();
  }

  /** 浅色 ↔ 深色一键切换（自定义主题激活时切换到深色）。返回新主题 id。 */
  toggle(): BuiltinThemeId {
    const next: BuiltinThemeId = this.current === 'dark' ? 'warm-light' : 'dark';
    this.apply(next);
    return next;
  }

  /**
   * 加载自定义主题 CSS：覆盖式写入注入槽（重复调用即热替换），
   * data-theme 置为 'custom'。`path` 用于后续 reload 与持久化。
   */
  loadCustomTheme(cssText: string, path?: string): void {
    if (path !== undefined) {
      this.customPath = path;
    }
    this.current = CUSTOM_THEME_ID;
    this.customCss = cssText;
    this.deps.customStyleSlot.set(cssText);
    this.deps.root.setAttribute('data-theme', CUSTOM_THEME_ID);
    this.deps.storage?.setItem(THEME_STORAGE_KEY, CUSTOM_THEME_ID);
    this.deps.storage?.setItem(CUSTOM_THEME_CSS_KEY, cssText);
    if (this.customPath !== null) {
      this.deps.storage?.setItem(CUSTOM_THEME_PATH_KEY, this.customPath);
    }
    this.notifyNativeTheme();
  }

  /**
   * 热重载自定义主题文件：重新读取文件内容并覆盖注入（无需重启）。
   * 触发时机（文件 watcher / 手动按钮）由 UI 层决定。无可重载目标或
   * 未注入 readFile 时返回 false。
   */
  async reloadCustomThemeFile(path?: string): Promise<boolean> {
    const target = path ?? this.customPath;
    if (target === null || this.deps.readFile === undefined) {
      return false;
    }
    const cssText = await this.deps.readFile(target);
    this.loadCustomTheme(cssText, target);
    return true;
  }

  /** Restore a persisted custom file after startup dependency construction. */
  async restorePersistedCustomTheme(): Promise<boolean> {
    if (this.current !== CUSTOM_THEME_ID) {
      return false;
    }
    const storedCss = this.deps.storage?.getItem(CUSTOM_THEME_CSS_KEY) ?? null;
    if (storedCss !== null) {
      this.loadCustomTheme(storedCss, this.customPath ?? undefined);
      return true;
    }
    if (this.customPath === null || this.deps.readFile === undefined) return false;
    try {
      const cssText = await this.deps.readFile(this.customPath);
      this.loadCustomTheme(cssText, this.customPath);
      return true;
    } catch (error) {
      // Retain the path for an explicit retry without claiming unloaded CSS is active.
      this.apply(DEFAULT_THEME_ID);
      throw error;
    }
  }

  /** Re-apply portable theme fields after a remote storage merge. */
  refreshFromStorage(): void {
    const saved = this.deps.storage?.getItem(THEME_STORAGE_KEY) ?? null;
    if (saved === CUSTOM_THEME_ID) {
      const cssText = this.deps.storage?.getItem(CUSTOM_THEME_CSS_KEY) ?? null;
      if (cssText !== null) {
        this.current = CUSTOM_THEME_ID;
        this.customCss = cssText;
        this.deps.customStyleSlot.set(cssText);
        this.deps.root.setAttribute('data-theme', CUSTOM_THEME_ID);
        this.notifyNativeTheme();
        return;
      }
    }
    this.apply(isBuiltinThemeId(saved) ? saved : DEFAULT_THEME_ID);
  }

  /** 移除自定义主题并回到默认护眼浅色。 */
  resetCustomTheme(): void {
    this.customPath = null;
    this.customCss = null;
    this.deps.storage?.removeItem?.(CUSTOM_THEME_PATH_KEY);
    this.deps.storage?.removeItem?.(CUSTOM_THEME_CSS_KEY);
    this.apply(DEFAULT_THEME_ID);
  }

  /**
   * 当前主题是否为深色：内置主题按 id 判定（dark/midnight 为深），
   * 自定义主题按注入 CSS 的首个 `color-scheme` 判定（缺失回退浅色）。
   */
  isDark(): boolean {
    if (this.current === CUSTOM_THEME_ID) {
      return customThemeIsDark(this.customCss ?? '');
    }
    return this.current === 'dark' || this.current === 'midnight';
  }

  private notifyNativeTheme(): void {
    this.deps.syncNativeTheme?.(this.isDark());
    this.deps.onThemeChange?.();
  }
}
