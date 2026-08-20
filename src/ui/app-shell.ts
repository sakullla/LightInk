/**
 * `app-shell` — 沉浸写作外壳：默认隐藏菜单与标签 chrome，边缘/快捷键按需唤出；
 * 大纲槽位 + 编辑区仍由既有接线驱动。
 *
 * 顶部为下拉菜单（文件/编辑/插入/视图/帮助），菜单项标注快捷键。
 * 插入菜单与斜杠命令共用 `insert-commands` 元素目录。
 * 帮助菜单的快捷键速查动态读取快捷键注册表。
 */

import type { InsertElementId } from '../editor/insert-commands.js';
import { INSERT_ELEMENTS } from '../editor/insert-commands.js';
import type { MessageKey } from '../i18n/messages.js';
import {
  applyReaderDocumentLayout,
  applyReaderLayout,
  DEFAULT_READER_FLOW_LAYOUT,
  loadReaderLayout,
  saveReaderLayout,
  toggleReaderFlowLayout,
  type ReaderFlowLayout,
} from '../reader/reader-layout.js';
import {
  applyReaderTheme,
  loadReaderTheme,
} from '../reader/reader-theme.js';
import {
  applyReaderTypography,
  defaultReaderTypography,
  loadReaderTypography,
  nextReaderFontScaleStep,
  normalizeReaderTypography,
  READER_FONT_FAMILY_PRESETS,
  saveReaderTypography,
  type ReaderFontFamilyPreset,
  type ReaderTypography,
} from '../reader/reader-typography.js';
import { BUILTIN_THEMES, type BuiltinThemeId } from '../theme/theme-service.js';
import { createChromeController, type ChromeController } from './chrome-controller.js';
import {
  loadChromePinPrefs,
  saveChromePinPrefs,
  type ChromePinPrefs,
  type StorageLike,
} from './chrome-prefs.js';
import { DEFAULT_FONT_SCALE, formatFontScaleLabel } from './font-scale.js';
import { renderCheatsheet, type CheatBinding } from './help-cheatsheet.js';
import { createMenuBar, type Menu, type MenuItem } from './menus.js';
import { labelModal, mountModalFocus } from './modal-focus.js';
import { matchEvent } from './shortcuts.js';
import {
  applyWorkspaceSurface,
  resolveWorkspaceSurface,
  type WorkspaceMode,
  type WorkspaceSnapshot,
} from './workspace-mode.js';

const READER_FONT_PRESETS = Object.keys(
  READER_FONT_FAMILY_PRESETS,
) as ReaderFontFamilyPreset[];

const READER_LINE_HEIGHTS = [1.5, 1.65, 1.8, 2] as const;
const READER_MEASURE_REMS = [16, 18, 22, 26, 32] as const;

function dispatchReaderPrefEvent(name: string, detail: unknown): void {
  if (typeof document === 'undefined' || typeof CustomEvent !== 'function') {
    return;
  }
  if (typeof document.dispatchEvent !== 'function') {
    return;
  }
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function canSetCssVars(target: { style: { setProperty?: unknown } }): boolean {
  return typeof target.style.setProperty === 'function';
}

function applyReaderShellChrome(
  target: HTMLElement,
  layout: ReaderFlowLayout,
  prefs: ReaderTypography,
  storage?: StorageLike | null,
): void {
  applyReaderLayout(target, layout);
  target.dataset.readerFlowLayout = layout;
  if (canSetCssVars(target)) {
    applyReaderTypography(target, prefs);
    applyReaderTheme(target, loadReaderTheme(storage));
  }
}

function collectReaderHosts(primary: ParentNode): HTMLElement[] {
  const hosts: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const scan = (node: ParentNode): void => {
    if (typeof node.querySelectorAll !== 'function') {
      return;
    }
    for (const el of Array.from(node.querySelectorAll('.lightink-reader'))) {
      if (seen.has(el as HTMLElement)) {
        continue;
      }
      seen.add(el as HTMLElement);
      hosts.push(el as HTMLElement);
    }
  };
  scan(primary);
  if (typeof document !== 'undefined' && document !== primary) {
    scan(document);
  }
  return hosts;
}

export interface ShellTabInfo {
  id: string;
  title: string;
  dirty: boolean;
}

export interface TabBarCallbacks {
  onSwitch(id: string): void;
  onClose(id: string): void;
}

export interface AppShellActions {
  // 文件
  onNew(): void;
  onOpen(): void;
  /**
   * File → Library fallback. Must not toggle the shelf back to the editor;
   * prefer `onEnterReaderHome` (always lands on the cover wall).
   */
  onToggleLibrary?(): void;
  /** Session workspace; defaults to editor. Owned by workspace-mode. */
  getWorkspaceMode?(): WorkspaceMode;
  /** Current mode + surface snapshot for chrome dataset. */
  getWorkspaceSnapshot?(): Pick<WorkspaceSnapshot, 'mode' | 'surface'>;
  /** View menu fallback when the dedicated travel actions are omitted. */
  onSetWorkspaceMode?(mode: WorkspaceMode): void;
  /** Shelf labeled「编辑」: enter the editor workspace. */
  onEnterEditor?(): void;
  /** Editor labeled「阅读/书架」: always land on the shelf cover wall. */
  onEnterReaderHome?(): void;
  /** True when reader workspace is showing an open book, not the shelf. */
  isReaderBookOpen?(): boolean;
  /** R12：列出最近打开文件路径（MRU 序）。 */
  listRecents(): Promise<string[]>;
  /** R12：打开某个最近文件；返回是否成功打开（false=文件缺失等）。 */
  openRecent(path: string): Promise<boolean>;
  /** R12：清空最近打开列表。 */
  clearRecents(): Promise<void>;
  /** R13：打开活动文件版本历史弹层。 */
  onShowVersions(): void;
  /** R13：是否存在已保存的活动文件（决定「版本历史」是否可用）。 */
  hasActiveFile(): boolean;
  onSave(): void;
  onSaveAs(): void;
  /** 将当前已保存 Markdown 加入同步空间并切换到受管副本。 */
  onJoinSyncSpace?(): void;
  canJoinSyncSpace?(): boolean;
  /** 打开 WebDAV 同步状态、配置和冲突面板。 */
  onOpenSyncPanel?(): void;
  /**
   * R14：切换自动保存开关。可选——测试 stub 可省略（菜单动作空操作）。
   * 实现方负责持久化偏好（lightink.autosave.enabled，默认关）。
   */
  onToggleAutosave?(): void;
  /** R14：自动保存当前是否开启（文件菜单勾选标记）。 */
  isAutosaveEnabled?(): boolean;
  onExportHtml(): void;
  onExportPdf(): void;
  // 编辑
  onUndo(): void;
  onRedo(): void;
  onCut(): void;
  onCopy(): void;
  onPaste(): void;
  /**
   * T6/R10：全选当前文档内容（双模式：WYSIWYG 渐进式 / 源码 textarea）。
   * 可选——测试 stub 可省略（菜单动作空操作）。
   */
  onSelectAll?(): void;
  /** T6/R10：是否有活动文档（编辑菜单「全选」启用判定，含未保存新标签）。 */
  hasActiveDocument?(): boolean;
  /**
   * T4/R2：打开查找替换面板。可选——测试 stub 可省略（菜单动作空操作）。
   * 无活动标签时实现方自行空操作。
   */
  onFind?(): void;
  // 插入（元素 id）
  onInsertElement(id: InsertElementId): void;
  // ---- 只读阅读标签（reader）专用：阅读态菜单据此装配「标注」菜单 ----
  /** 活动标签类型；reader 时菜单隐藏「插入」；markdown/reader 都挂「标注」。 */
  activeTabKind?(): 'markdown' | 'reader' | null;
  /** reader：当前文档是否启用标注（决定书签/笔记是否可用）。 */
  isReaderAnnotationEnabled?(): boolean;
  /** reader：标注侧栏当前是否可见（菜单勾选标记）。 */
  isReaderSidebarVisible?(): boolean;
  /** reader：在当前阅读位置添加书签。 */
  onReaderAddBookmark?(): void;
  /** reader：在当前阅读位置添加笔记（弹 prompt）。 */
  onReaderAddNote?(): void;
  /** reader：切换标注侧栏显隐（默认隐藏）。 */
  onReaderToggleSidebar?(): void;
  // 视图
  onToggleTheme(): void;
  /** 应用某个内置预设主题（视图菜单逐项列出全部预设）。 */
  onApplyTheme(themeId: BuiltinThemeId): void;
  /** 当前主题 id（内置 id 或 'custom'），用于菜单标记当前项。 */
  getCurrentThemeId(): string;
  /** 热重载自定义主题文件（R15：接通既有 reloadCustomThemeFile）。 */
  onReloadCustomTheme(): void;
  /** Select and activate a custom CSS theme file. */
  onSelectCustomTheme(): void;
  /** Remove the custom theme and return to the default. */
  onResetCustomTheme(): void;
  /** 是否存在可重载的自定义主题文件。 */
  canReloadCustomTheme(): boolean;
  canResetCustomTheme(): boolean;
  onToggleOutline(): void;
  onToggleSourceMode(): void;
  /** 切换编辑器 Markdown 滚动 / 翻页（`lightink.reading.layout`，默认滚动）。 */
  onToggleReadingLayout?(): void;
  getReadingLayout?(): 'scroll' | 'paginated';
  /**
   * 阅读流式布局（`lightink.reader.flow.layout`，默认翻页）。
   * 与编辑器键分存，菜单不得回写 `getReadingLayout`。
   */
  getReaderFlowLayout?(): ReaderFlowLayout;
  onSetReaderFlowLayout?(layout: ReaderFlowLayout): void;
  /** 阅读流式字体/字号/行高/行长（`lightink.reader.typography`）。 */
  getReaderTypography?(): ReaderTypography;
  onSetReaderTypography?(patch: Partial<ReaderTypography>): void;
  /**
   * T5/R3：切换字数状态栏显隐。可选——测试 stub 可省略（菜单动作空操作）。
   * 实现方负责持久化偏好；关闭即不渲染状态栏。
   */
  onToggleStatusBar?(): void;
  /** T5/R3：字数状态栏当前是否可见（视图菜单勾选标记）。 */
  isStatusBarVisible?(): boolean;
  /** Toggle native window fullscreen (wired in main). */
  onToggleFullscreen(): void;
  /** Whether chrome navigation (menu + tabs) is currently pinned open. */
  isChromePinned(): boolean;
  /** Toggle pin for both menu and tabs chrome (fixed navigation). */
  onToggleChromePinned(): void;
  /** Reading font: larger / smaller / reset to display-tier default. */
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
  /** Current font scale label (e.g. `100%`) for the menu. */
  getFontScaleLabel(): string;
  /** Translate UI string (en / zh-CN). */
  t(key: MessageKey, vars?: Readonly<Record<string, string>>): string;
  /** Format shortcut for current OS (⌘ on macOS). */
  formatShortcut(combo: string): string;
  /** Current UI locale. */
  getLocale(): 'en' | 'zh-CN';
  /** Switch UI language (rebuilds menus). */
  setLocale(locale: 'en' | 'zh-CN'): void;
}

export interface AppShellOptions {
  /** 快捷键速查表数据源（由快捷键注册表派生）。 */
  shortcutBindings(): readonly CheatBinding[];
  /**
   * Optional storage for chrome pin prefs (default: localStorage when available).
   * Pass null to disable persistence.
   */
  storage?: StorageLike | null;
  /** Initial pin prefs override (tests); otherwise loaded from storage. */
  initialPinPrefs?: ChromePinPrefs;
}

export interface AppShell {
  readonly toolbar: HTMLDivElement;
  readonly tabBar: HTMLDivElement;
  readonly editorArea: HTMLDivElement;
  /** 大纲侧栏槽位（主区左侧），由 outline 视图挂载内容。 */
  readonly outlineSidebar: HTMLDivElement;
  /** T5/R3：状态栏挂载槽位（shell 根部最后一行），由 status-bar 挂载内容。 */
  readonly statusBarHost: HTMLDivElement;
  /** Immersive chrome visibility owner (menu + tabs surfaces). */
  readonly chrome: ChromeController;
  /** Reveal menu chrome and open the File menu (hotkey / first-run path). */
  revealMenu(): void;
  /** Toggle menu chrome reveal without forcing a specific panel open. */
  toggleMenuChrome(): void;
  /** Toggle tabs chrome reveal (hotkey path). */
  toggleTabsChrome(): void;
  /** Hold tabs chrome open while a nested UI (e.g. context menu) is active. */
  setTabsHold(hold: boolean): void;
  /** Whether both menu and tabs chrome are pinned open. */
  isChromePinned(): boolean;
  /** Pin/unpin menu + tabs together (fixed navigation bar). */
  setChromePinned(pinned: boolean): void;
  /** Toggle pin; returns the new pinned value. */
  toggleChromePinned(): boolean;
  /** Rebuild menu bar labels/items after language switch. */
  rebuildMenus(): void;
  /** Re-read synchronized reader layout/typography/theme fields and apply them. */
  refreshReaderPreferences(): void;
  /**
   * Persist reader typography (`lightink.reader.typography`) and restamp
   * reader hosts. Used by the view menu and by host zoom shortcuts/wheel
   * so those paths never write `lightink.fontScale`.
   */
  setReaderTypography(patch: Partial<ReaderTypography>): void;
  /** Stamp workspace mode/surface on the shell root (dataset + class). */
  applyWorkspace(snapshot: Pick<WorkspaceSnapshot, 'mode' | 'surface'>): void;
  /** Shelf header travel control; library view relocates this into its toolbar. */
  readonly enterEditorButton: HTMLButtonElement;
  /** 按当前标签状态重绘标签栏。 */
  renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void;
  /** Remove document listeners installed by the shell. */
  destroy(): void;
}

function menuItem(
  id: string,
  label: string | (() => string),
  action: () => void,
  shortcut = '',
  enabled?: () => boolean,
): MenuItem {
  return shortcut === '' ? { id, label, action, enabled } : { id, label, shortcut, action, enabled };
}

/** 菜单分隔符：渲染为 <hr>，不可点击（修复 P2[blocking]：此前分隔项漏设 separator:true）。 */
function separator(id: string): MenuItem {
  return { id, label: '', separator: true, action: () => undefined };
}

// ---------------------------------------------------------------------------
// R12「最近打开」子菜单（VS Code 式：悬停展开列表，替代模态弹窗）
// ---------------------------------------------------------------------------

/** 取路径的文件名（兼容 / 与 \；末尾分隔符已剥除）。 */
export function pathBaseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** 取路径的目录部分（无目录段返回空串，description 不渲染）。 */
export function pathDirName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx > 0 ? path.slice(0, idx) : '';
}

/**
 * Abbreviate a directory path for the recents submenu secondary line.
 * Keeps the drive/root and the last 1–2 segments so siblings stay distinguishable
 * without the old RTL ellipsis hack that mangled mixed CJK/ASCII paths.
 *
 * Examples (maxLen=42):
 *   C:\Users\a\project\docs\req  →  C:\…\project\docs\req  (if short enough)
 *   very/long/unix/path/here     →  …/path/here
 */
export function abbreviatePath(path: string, maxLen = 42): string {
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed.length <= maxLen) return trimmed;
  const sep = trimmed.includes('\\') ? '\\' : '/';
  const parts = trimmed.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length <= 1) {
    return `…${trimmed.slice(-(maxLen - 1))}`;
  }
  const tailCount = parts.length >= 3 ? 2 : 1;
  const tail = parts.slice(-tailCount).join(sep);
  const head = parts[0]!;
  // Prefer "C:\…\parent\name" when the drive/root is short.
  if (head.length <= 12) {
    const withHead = `${head}${sep}…${sep}${tail}`;
    if (withHead.length <= maxLen) return withHead;
  }
  const tailOnly = `…${sep}${tail}`;
  if (tailOnly.length <= maxLen) return tailOnly;
  return `…${sep}${tail.slice(-(maxLen - 2))}`;
}

export interface RecentsMenuActions {
  open(path: string): void;
  clear(): void;
}

/**
 * 构建「最近打开」子菜单项：
 *   两行布局 = 文件名（主行）+ 缩略目录（次行，muted）
 *   title = 完整路径（悬停可读）
 * 末尾分隔线 + 清空入口；空列表给占位禁用项。
 */
export function buildRecentsMenuItems(
  paths: readonly string[],
  actions: RecentsMenuActions,
  t: (key: MessageKey) => string = (k) => k,
): MenuItem[] {
  if (paths.length === 0) {
    return [
      {
        id: 'recents-empty',
        label: () => t('file.recentsEmpty'),
        action: () => undefined,
        enabled: () => false,
      },
    ];
  }
  return [
    ...paths.map((path, index) => {
      const dir = pathDirName(path);
      return {
        id: `recent-${index}`,
        label: pathBaseName(path),
        description: dir === '' ? undefined : abbreviatePath(dir),
        title: path,
        action: () => actions.open(path),
      };
    }),
    separator('recents-sep'),
    { id: 'recents-clear', label: () => t('file.clearRecents'), action: actions.clear },
  ];
}

function sc(actions: AppShellActions, combo: string): string {
  return actions.formatShortcut(combo);
}

function isReaderTypographyContext(actions: AppShellActions): boolean {
  return actions.getWorkspaceMode?.() === 'reader' || actions.activeTabKind?.() === 'reader';
}

function workspaceTravelLabel(
  kind: 'editor' | 'readerHome',
  locale: 'en' | 'zh-CN',
): string {
  if (kind === 'editor') {
    return locale === 'en' ? 'Edit' : '编辑';
  }
  return locale === 'en' ? 'Reading / Shelf' : '阅读/书架';
}

/** Shelf「编辑」— never a close/return-to-shelf control. */
function enterEditorWorkspace(actions: AppShellActions): void {
  actions.onEnterEditor?.() ?? actions.onSetWorkspaceMode?.('editor');
}

/**
 * Editor「阅读/书架」and File→书库: always the cover wall.
 * Does not call a toggle that would leave the shelf for the editor.
 */
function enterReaderHomeWorkspace(actions: AppShellActions): void {
  if (actions.onEnterReaderHome !== undefined) {
    actions.onEnterReaderHome();
    return;
  }
  if (actions.getWorkspaceMode?.() === 'reader' && actions.isReaderBookOpen?.() !== true) {
    return;
  }
  actions.onToggleLibrary?.();
}

function resolveShellSnapshot(
  actions: AppShellActions,
): Pick<WorkspaceSnapshot, 'mode' | 'surface'> {
  const provided = actions.getWorkspaceSnapshot?.();
  if (provided !== undefined) {
    return { mode: provided.mode, surface: provided.surface };
  }
  const mode = actions.getWorkspaceMode?.() ?? 'editor';
  return {
    mode,
    surface: resolveWorkspaceSurface(mode, actions.isReaderBookOpen?.() ?? false),
  };
}

function setChromeSetVisible(host: HTMLElement, visible: boolean): void {
  host.hidden = !visible;
  host.inert = !visible;
  host.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function readerTypographyOrDefault(actions: AppShellActions): ReaderTypography {
  return actions.getReaderTypography?.() ?? defaultReaderTypography();
}

function readerFontFamilyLabel(family: ReaderFontFamilyPreset, en: boolean): string {
  switch (family) {
    case 'serif':
      return en ? 'Serif' : '宋体';
    case 'sans':
      return en ? 'Sans' : '黑体';
    case 'mono':
      return en ? 'Mono' : '等宽';
    default:
      return en ? 'Original' : '原文';
  }
}

function isReaderFontSelected(current: string, preset: ReaderFontFamilyPreset): boolean {
  return current === preset || current === READER_FONT_FAMILY_PRESETS[preset];
}

function readerMeasureLabel(measureRem: number, en: boolean): string {
  if (measureRem <= 16) return en ? `Narrow (${measureRem})` : `窄（${measureRem}）`;
  if (measureRem <= 18) return en ? `Compact (${measureRem})` : `较窄（${measureRem}）`;
  if (measureRem <= 22) return en ? `Standard (${measureRem})` : `标准（${measureRem}）`;
  if (measureRem <= 26) return en ? `Relaxed (${measureRem})` : `宽松（${measureRem}）`;
  return en ? `Wide (${measureRem})` : `宽（${measureRem}）`;
}

export function buildMenus(actions: AppShellActions): Menu[] {
  const t = (key: MessageKey) => actions.t(key);
  const insertItems: MenuItem[] = INSERT_ELEMENTS.map((element) =>
    menuItem(
      `insert-${element.id}`,
      () => t(`insert.${element.id}`),
      () => actions.onInsertElement(element.id),
      element.id === 'link'
        ? sc(actions, 'Ctrl+K')
        : element.id === 'image'
          ? sc(actions, 'Ctrl+Alt+I')
          : '',
    ),
  );

  /** View → Theme submenu: toggle + presets + custom reload. */
  const themeSubmenu = (): MenuItem[] => [
    menuItem(
      'view-theme-toggle',
      () => t('view.toggleTheme'),
      actions.onToggleTheme,
      sc(actions, 'Ctrl+J'),
    ),
    separator('view-theme-sep1'),
    // R15：逐项列出全部预设主题，当前主题禁用（不可重复选择）。
    ...BUILTIN_THEMES.map((theme) =>
      menuItem(
        `view-theme-${theme.id}`,
        () => t(`theme.${theme.id}`),
        () => actions.onApplyTheme(theme.id),
        '',
        () => actions.getCurrentThemeId() !== theme.id,
      ),
    ),
    separator('view-theme-sep2'),
    menuItem(
      'view-select-custom-theme',
      () =>
        actions.getCurrentThemeId() === 'custom'
          ? `✓ ${t('theme.custom')}`
          : t('theme.custom'),
      actions.onSelectCustomTheme,
    ),
    menuItem(
      'view-reload-custom-theme',
      () => t('view.reloadCustomTheme'),
      actions.onReloadCustomTheme,
      '',
      () => actions.canReloadCustomTheme(),
    ),
    menuItem(
      'view-reset-custom-theme',
      () => t('view.resetCustomTheme'),
      actions.onResetCustomTheme,
      '',
      () => actions.canResetCustomTheme(),
    ),
  ];

  const isReader = actions.activeTabKind?.() === 'reader';
  // 内联双语（同既有「查找…」「字数统计」先例：i18n 目录不在本改动 scope）。
  const ll = (en: string, zh: string): string => (actions.getLocale() === 'en' ? en : zh);

  /**
   * T1：视图 →「字体布局」子菜单——收纳放大/缩小/重置缩放与滚动/翻页模式
   * （当前模式打勾并禁用，选择另一模式即切换；Ctrl+M 快捷键行为不变）。
   * 阅读模式另用流式键（默认翻页）并挂字体/行高/行长分档，不回写编辑器布局。
   * 工厂在每次展开时现取，勾选态随布局切换刷新。
   */
  const fontLayoutSubmenu = (): MenuItem[] => {
    const reader = isReaderTypographyContext(actions);
    const current = reader
      ? (actions.getReaderFlowLayout?.() ?? DEFAULT_READER_FLOW_LAYOUT)
      : (actions.getReadingLayout?.() ?? 'scroll');
    const typography = readerTypographyOrDefault(actions);
    const scaleLabel = (): string =>
      reader && actions.getReaderTypography !== undefined
        ? formatFontScaleLabel(typography.fontScaleStep)
        : actions.getFontScaleLabel();
    const zoomBy = (direction: 1 | -1 | 0): void => {
      if (reader && actions.onSetReaderTypography !== undefined) {
        const fontScaleStep =
          direction === 0
            ? DEFAULT_FONT_SCALE
            : nextReaderFontScaleStep(typography.fontScaleStep, direction > 0 ? 'in' : 'out');
        actions.onSetReaderTypography({ fontScaleStep });
        return;
      }
      if (direction > 0) actions.onZoomIn();
      else if (direction < 0) actions.onZoomOut();
      else actions.onZoomReset();
    };
    const layoutItem = (mode: 'scroll' | 'paginated'): MenuItem =>
      menuItem(
        `view-layout-${mode}`,
        () => {
          const label =
            mode === 'paginated' ? t('view.layout.paginated') : t('view.layout.scroll');
          return current === mode ? `✓ ${label}` : label;
        },
        () => {
          if (current === mode) return;
          // 阅读流式只写阅读键；编辑器仍走既有 toggle（不跨键回写）。
          if (reader) {
            actions.onSetReaderFlowLayout?.(mode);
            return;
          }
          actions.onToggleReadingLayout?.();
        },
        sc(actions, 'Ctrl+M'),
        () => current !== mode,
      );
    const choiceItem = (
      id: string,
      selected: boolean,
      label: string,
      action: () => void,
    ): MenuItem =>
      menuItem(id, () => (selected ? `✓ ${label}` : label), action, '', () => !selected);
    const items: MenuItem[] = [
      menuItem('view-zoom-in', () => t('view.zoomIn'), () => zoomBy(1), sc(actions, 'Ctrl+=')),
      menuItem('view-zoom-out', () => t('view.zoomOut'), () => zoomBy(-1), sc(actions, 'Ctrl+-')),
      menuItem(
        'view-zoom-reset',
        () => `${t('view.zoomReset')} (${scaleLabel()})`,
        () => zoomBy(0),
        sc(actions, 'Ctrl+0'),
      ),
      separator('view-font-layout-sep'),
      layoutItem('scroll'),
      layoutItem('paginated'),
    ];
    if (!reader) {
      return items;
    }
    const en = actions.getLocale() === 'en';
    items.push(
      separator('view-reader-type-sep'),
      {
        id: 'view-reader-font',
        label: () => ll('Reading font', '阅读字体'),
        action: () => undefined,
        submenu: () =>
          READER_FONT_PRESETS.map((family) =>
            choiceItem(
              `view-reader-font-${family}`,
              isReaderFontSelected(typography.fontFamily, family),
              readerFontFamilyLabel(family, en),
              () => actions.onSetReaderTypography?.({ fontFamily: family }),
            ),
          ),
      },
      {
        id: 'view-reader-line-height',
        label: () => ll('Line height', '行高'),
        action: () => undefined,
        submenu: () =>
          READER_LINE_HEIGHTS.map((lineHeight) =>
            choiceItem(
              `view-reader-line-height-${String(lineHeight).replace('.', '-')}`,
              typography.lineHeight === lineHeight,
              lineHeight.toFixed(2).replace(/0$/, ''),
              () => actions.onSetReaderTypography?.({ lineHeight }),
            ),
          ),
      },
      {
        id: 'view-reader-measure',
        label: () => ll('Measure', '行长'),
        action: () => undefined,
        submenu: () =>
          READER_MEASURE_REMS.map((measureRem) =>
            choiceItem(
              `view-reader-measure-${measureRem}`,
              typography.measureRem === measureRem,
              readerMeasureLabel(measureRem, en),
              () => actions.onSetReaderTypography?.({ measureRem }),
            ),
          ),
      },
    );
    return items;
  };

  /** reader 态「标注」菜单：书签 / 笔记 / 侧栏开关（侧栏默认隐藏，勾选标记当前态）。 */
  const annotationMenu: Menu = {
    id: 'annotation',
    label: () => ll('Annotate', '标注'),
    items: [
      menuItem(
        'ann-bookmark',
        () => ll('Add Bookmark', '添加书签'),
        () => actions.onReaderAddBookmark?.(),
        '',
        () => actions.isReaderAnnotationEnabled?.() !== false,
      ),
      menuItem(
        'ann-note',
        () => ll('Add Note', '添加笔记'),
        () => actions.onReaderAddNote?.(),
        '',
        () => actions.isReaderAnnotationEnabled?.() !== false,
      ),
      separator('ann-sep'),
      menuItem(
        'ann-sidebar',
        () => {
          const base = ll('Annotation Panel', '标注侧栏');
          return actions.isReaderSidebarVisible?.() ? `✓ ${base}` : base;
        },
        () => actions.onReaderToggleSidebar?.(),
      ),
    ],
  };

  const menus: Menu[] = [
    {
      id: 'file',
      label: () => t('menu.file'),
      items: [
        menuItem('file-new', () => t('file.new'), actions.onNew, sc(actions, 'Ctrl+N')),
        menuItem('file-open', () => t('file.open'), actions.onOpen, sc(actions, 'Ctrl+O')),
        menuItem(
          'file-library',
          () => {
            const en = actions.getLocale() === 'en';
            if (actions.getWorkspaceMode?.() === 'reader' && actions.isReaderBookOpen?.()) {
              return en ? 'Back to Shelf' : '返回书架';
            }
            return en ? 'Library' : '书库';
          },
          () => enterReaderHomeWorkspace(actions),
        ),
        // R12：VS Code 式「最近打开」子菜单——悬停展开列表（打开时现取，
        // 读取失败按空列表处理），不再弹模态层。
        {
          id: 'file-recents',
          label: () => t('file.recents'),
          action: () => undefined,
          submenu: () =>
            actions
              .listRecents()
              .catch(() => [] as string[])
              .then((paths) =>
                buildRecentsMenuItems(
                  paths,
                  {
                    open: (path) => void actions.openRecent(path),
                    clear: () => void actions.clearRecents(),
                  },
                  t,
                ),
              ),
        },
        separator('file-sep1'),
        menuItem('file-save', () => t('file.save'), actions.onSave, sc(actions, 'Ctrl+S')),
        menuItem('file-save-as', () => t('file.saveAs'), actions.onSaveAs, sc(actions, 'Ctrl+Shift+S')),
        menuItem(
          'file-join-sync-space',
          () => (actions.getLocale() === 'en' ? 'Add to sync space' : '加入同步空间'),
          () => actions.onJoinSyncSpace?.(),
          '',
          () => actions.canJoinSyncSpace?.() === true,
        ),
        menuItem(
          'file-sync-settings',
          () => (actions.getLocale() === 'en' ? 'WebDAV sync…' : 'WebDAV 同步…'),
          () => actions.onOpenSyncPanel?.(),
        ),
        // R14：自动保存开关（勾选标记式）。i18n 目录不在本任务 scope，
        // 标签按当前 locale 内联双语（同 T5「字数统计」先例）。
        menuItem(
          'file-autosave',
          () => {
            const base = actions.getLocale() === 'en' ? 'Auto Save' : '自动保存';
            return actions.isAutosaveEnabled?.() === true ? `✓ ${base}` : base;
          },
          () => actions.onToggleAutosave?.(),
        ),
        separator('file-sep2'),
        menuItem(
          'file-versions',
          () => t('file.versions'),
          actions.onShowVersions,
          '',
          () => actions.hasActiveFile(),
        ),
        menuItem('file-export-html', () => t('file.exportHtml'), actions.onExportHtml),
        menuItem('file-export-pdf', () => t('file.exportPdf'), actions.onExportPdf),
      ],
    },
    {
      id: 'edit',
      label: () => t('menu.edit'),
      items: [
        menuItem('edit-undo', () => t('edit.undo'), actions.onUndo, sc(actions, 'Ctrl+Z')),
        menuItem('edit-redo', () => t('edit.redo'), actions.onRedo, sc(actions, 'Ctrl+Shift+Z')),
        separator('edit-sep1'),
        menuItem('edit-cut', () => t('edit.cut'), actions.onCut, sc(actions, 'Ctrl+X')),
        menuItem('edit-copy', () => t('edit.copy'), actions.onCopy, sc(actions, 'Ctrl+C')),
        menuItem('edit-paste', () => t('edit.paste'), actions.onPaste, sc(actions, 'Ctrl+V')),
        // T6/R10：全选（双模式）。无活动文档时禁用；Ctrl+A 由 progressive-select 插件
        //（WYSIWYG）与原生 textarea（源码模式）处理，此处仅为菜单显式入口与快捷键提示。
        menuItem(
          'edit-select-all',
          () => t('edit.selectAll'),
          () => actions.onSelectAll?.(),
          sc(actions, 'Ctrl+A'),
          () => actions.hasActiveDocument?.() !== false,
        ),
        separator('edit-sep2'),
        // T4/R2：查找与替换面板。i18n 目录（src/i18n/messages.ts）不在本任务
        // scope 内，标签按当前 locale 内联双语；快捷键 Ctrl+F/Cmd+F 在 main.ts
        // 捕获阶段接线（shortcuts.ts 属后续任务 scope）。
        menuItem(
          'edit-find',
          () => (actions.getLocale() === 'en' ? 'Find…' : '查找…'),
          () => actions.onFind?.(),
          sc(actions, 'Ctrl+F'),
        ),
      ],
    },
    // reader 标签：以「标注」菜单取代「插入」（只读，无插入元素）。
    // markdown 标签：插入与标注并存。
    ...(isReader ? [] : [{ id: 'insert', label: () => t('menu.insert'), items: insertItems }]),
    annotationMenu,
    {
      id: 'view',
      label: () => t('menu.view'),
      items: [
        menuItem(
          'view-workspace-editor',
          () => workspaceTravelLabel('editor', actions.getLocale()),
          () => enterEditorWorkspace(actions),
          '',
          () => actions.getWorkspaceMode?.() === 'reader',
        ),
        menuItem(
          'view-workspace-reader',
          () => workspaceTravelLabel('readerHome', actions.getLocale()),
          () => enterReaderHomeWorkspace(actions),
          '',
          () => actions.getWorkspaceMode?.() !== 'reader',
        ),
        separator('view-workspace-sep'),
        // Theme controls live under a single submenu (3rd level from the top bar).
        {
          id: 'view-theme',
          label: () => t('view.theme'),
          action: () => undefined,
          submenu: themeSubmenu,
        },
        separator('view-theme-sep'),
        menuItem(
          'view-pin-chrome',
          () => (actions.isChromePinned() ? t('view.unpinChrome') : t('view.pinChrome')),
          actions.onToggleChromePinned,
          sc(actions, 'Alt+P'),
        ),
        menuItem(
          'view-fullscreen',
          () => t('view.fullscreen'),
          actions.onToggleFullscreen,
          sc(actions, 'F11'),
        ),
        separator('view-chrome-sep'),
        menuItem(
          'view-outline',
          () => t('view.outline'),
          actions.onToggleOutline,
          sc(actions, 'Ctrl+Shift+L'),
        ),
        // T1：reader 态隐藏「源码模式」（只读文档无源码视图；markdown 标签恢复）。
        ...(isReader
          ? []
          : [
              menuItem(
                'view-source-mode',
                () => t('view.sourceMode'),
                actions.onToggleSourceMode,
                sc(actions, 'Ctrl+/'),
                () => true,
              ),
            ]),
        // T5/R3：字数统计状态栏开关（勾选标记式）。i18n 目录不在本任务 scope，
        // 标签按当前 locale 内联双语（同 T4「查找…」先例）。
        menuItem(
          'view-word-count',
          () => {
            const base = actions.getLocale() === 'en' ? 'Word Count' : '字数统计';
            return actions.isStatusBarVisible?.() === true ? `✓ ${base}` : base;
          },
          () => actions.onToggleStatusBar?.(),
        ),
        // T1：放大/缩小/重置与滚动/翻页收纳为「字体布局」子菜单，主菜单原位置移除。
        {
          id: 'view-font-layout',
          label: () => t('view.fontLayout'),
          action: () => undefined,
          submenu: fontLayoutSubmenu,
        },
      ],
    },
    {
      id: 'help',
      label: () => t('menu.help'),
      items: [
        menuItem('help-cheatsheet', () => t('help.cheatsheet'), () => undefined),
        separator('help-lang-sep'),
        menuItem(
          'help-lang-en',
          () => t('view.language.en'),
          () => actions.setLocale('en'),
          '',
          () => actions.getLocale() !== 'en',
        ),
        menuItem(
          'help-lang-zh',
          () => t('view.language.zh'),
          () => actions.setLocale('zh-CN'),
          '',
          () => actions.getLocale() !== 'zh-CN',
        ),
      ],
    },
  ];
  return menus;
}

function resolveStorage(options: AppShellOptions): StorageLike | null {
  if (options.storage !== undefined) {
    return options.storage;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    /* privacy mode */
  }
  return null;
}

export function createAppShell(
  root: HTMLElement,
  actions: AppShellActions,
  options: AppShellOptions,
): AppShell {
  const chrome = createChromeController();
  const storage = resolveStorage(options);
  let fallbackReaderLayout = loadReaderLayout(storage);
  let fallbackReaderTypography = loadReaderTypography(storage);
  let rebuildMenusRef = (): void => undefined;

  const currentReaderLayout = (): ReaderFlowLayout =>
    actions.getReaderFlowLayout?.() ?? fallbackReaderLayout;
  const currentReaderTypography = (): ReaderTypography =>
    actions.getReaderTypography?.() ?? fallbackReaderTypography;

  const applyReaderChrome = (): void => {
    const layout = currentReaderLayout();
    const prefs = currentReaderTypography();
    for (const reader of collectReaderHosts(editorArea)) {
      applyReaderShellChrome(reader, layout, prefs, storage);
    }
    const workspace =
      actions.getWorkspaceMode?.() ?? actions.getWorkspaceSnapshot?.()?.mode ?? 'editor';
    const documentRoot =
      typeof document !== 'undefined' && document.documentElement != null
        ? document.documentElement
        : null;
    if (documentRoot !== null) {
      applyReaderDocumentLayout(
        documentRoot,
        workspace,
        layout,
        actions.getReadingLayout?.() ?? 'scroll',
      );
    }
    dispatchReaderPrefEvent('lightink:reader-flow-layout', layout);
    dispatchReaderPrefEvent('lightink:reader-typography', prefs);
  };

  const menuActions: AppShellActions = {
    ...actions,
    getReaderFlowLayout: currentReaderLayout,
    onSetReaderFlowLayout: (layout) => {
      if (actions.getReaderFlowLayout === undefined) {
        fallbackReaderLayout = layout;
        saveReaderLayout(storage, layout);
      }
      actions.onSetReaderFlowLayout?.(layout);
      applyReaderChrome();
      rebuildMenusRef();
    },
    getReaderTypography: currentReaderTypography,
    onSetReaderTypography: (patch) => {
      const next = normalizeReaderTypography({ ...currentReaderTypography(), ...patch });
      if (actions.getReaderTypography === undefined) {
        fallbackReaderTypography = saveReaderTypography(storage, next);
      }
      actions.onSetReaderTypography?.(patch);
      applyReaderChrome();
      rebuildMenusRef();
    },
    getFontScaleLabel: () =>
      isReaderTypographyContext(actions)
        ? formatFontScaleLabel(currentReaderTypography().fontScaleStep)
        : actions.getFontScaleLabel(),
  };

  const onReaderLayoutShortcut = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (!matchEvent(keyEvent, 'Ctrl+M')) {
      return;
    }
    const workspace =
      actions.getWorkspaceMode?.() ?? actions.getWorkspaceSnapshot?.()?.mode ?? 'editor';
    if (workspace !== 'reader') {
      return;
    }
    keyEvent.preventDefault();
    // Same-document capture listeners (ShortcutRegistry) still run after
    // stopPropagation; only stopImmediatePropagation keeps Ctrl+M from also
    // writing the editor layout key.
    keyEvent.stopImmediatePropagation();
    menuActions.onSetReaderFlowLayout?.(toggleReaderFlowLayout(currentReaderLayout()));
  };
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('keydown', onReaderLayoutShortcut, true);
  }

  const pinPrefs = options.initialPinPrefs ?? loadChromePinPrefs(storage);
  if (pinPrefs.menu) {
    chrome.setPinned('menu', true);
  }
  if (pinPrefs.tabs) {
    chrome.setPinned('tabs', true);
  }

  const chromeHost = document.createElement('div');
  chromeHost.id = 'lightink-chrome-host';
  chromeHost.className = 'lightink-chrome-host';

  const menuTrigger = document.createElement('div');
  menuTrigger.id = 'lightink-menu-trigger';
  menuTrigger.className = 'lightink-chrome-trigger lightink-chrome-trigger--menu';
  menuTrigger.setAttribute('role', 'button');
  menuTrigger.setAttribute('aria-label', actions.t('chrome.showMenu'));
  menuTrigger.tabIndex = 0;

  const toolbar = document.createElement('div');
  toolbar.id = 'lightink-toolbar';

  const tabsHost = document.createElement('div');
  tabsHost.id = 'lightink-tabs-host';
  tabsHost.className = 'lightink-tabs-host';

  const tabsTrigger = document.createElement('div');
  tabsTrigger.id = 'lightink-tabs-trigger';
  tabsTrigger.className = 'lightink-chrome-trigger lightink-chrome-trigger--tabs';
  tabsTrigger.setAttribute('role', 'button');
  tabsTrigger.setAttribute('aria-label', actions.t('chrome.showTabs'));
  tabsTrigger.tabIndex = 0;

  const tabBar = document.createElement('div');
  tabBar.id = 'lightink-tabbar';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', actions.t('chrome.showTabs'));

  const enterReaderHomeBtn = document.createElement('button');
  enterReaderHomeBtn.type = 'button';
  enterReaderHomeBtn.id = 'lightink-enter-reader-home';
  enterReaderHomeBtn.className = 'lightink-workspace-travel';
  enterReaderHomeBtn.addEventListener('click', () => enterReaderHomeWorkspace(actions));

  const readerShell = document.createElement('div');
  readerShell.id = 'lightink-reader-shell';
  readerShell.className = 'lightink-reader-shell';

  const enterEditorBtn = document.createElement('button');
  enterEditorBtn.type = 'button';
  enterEditorBtn.id = 'lightink-enter-editor';
  enterEditorBtn.className = 'lightink-workspace-travel';
  enterEditorBtn.addEventListener('click', () => enterEditorWorkspace(actions));
  readerShell.appendChild(enterEditorBtn);

  function syncTravelLabels(): void {
    const locale = actions.getLocale();
    const editorLabel = workspaceTravelLabel('editor', locale);
    const readerHomeLabel = workspaceTravelLabel('readerHome', locale);
    enterEditorBtn.textContent = editorLabel;
    enterEditorBtn.title = editorLabel;
    enterEditorBtn.setAttribute('aria-label', editorLabel);
    enterReaderHomeBtn.textContent = readerHomeLabel;
    enterReaderHomeBtn.title = readerHomeLabel;
    enterReaderHomeBtn.setAttribute('aria-label', readerHomeLabel);
  }
  syncTravelLabels();

  const editorArea = document.createElement('div');
  editorArea.id = 'lightink-editor-area';
  const outlineSidebar = document.createElement('div');
  outlineSidebar.id = 'lightink-outline-sidebar';
  const mainRow = document.createElement('div');
  mainRow.id = 'lightink-main';
  mainRow.replaceChildren(outlineSidebar, editorArea);

  // T5/R3：状态栏槽位（根部最后一行，默认空——状态栏关闭时不渲染任何内容）。
  const statusBarHost = document.createElement('div');
  statusBarHost.id = 'lightink-status-bar-host';

  // 下拉菜单栏（语言切换时 rebuildMenus 整栏重建）。
  function wireHelpCheatsheet(menus: Menu[]): void {
    const helpMenu = menus.find((m) => m.id === 'help');
    if (helpMenu === undefined) return;
    const cheatsheetItem = helpMenu.items.find((i) => i.id === 'help-cheatsheet');
    if (cheatsheetItem !== undefined) {
      cheatsheetItem.action = () => showCheatsheet(options.shortcutBindings());
    }
  }

  const initialMenus = buildMenus(menuActions);
  wireHelpCheatsheet(initialMenus);
  const menuBar = createMenuBar({
    menus: initialMenus,
    loadingLabel: () => actions.t('menu.loading'),
    overflowLabel: () => actions.t('menu.more'),
    onOpenChange: (openMenuId) => {
      const hold = openMenuId !== null;
      chrome.setHold('menu', hold);
      syncMenuChrome();
      // setHold(false) schedules leave hysteresis when pointer already left;
      // resync class after the controller timer so is-menu-revealed can clear.
      if (!hold) {
        afterLeaveSync(syncMenuChrome);
      }
    },
  });
  toolbar.append(menuBar.element, enterReaderHomeBtn);

  function rebuildMenus(): void {
    const next = buildMenus(menuActions);
    wireHelpCheatsheet(next);
    menuBar.rebuild(next, {
      loadingLabel: () => actions.t('menu.loading'),
      overflowLabel: () => actions.t('menu.more'),
    });
    syncTravelLabels();
  }
  rebuildMenusRef = rebuildMenus;

  function refreshReaderPreferences(): void {
    fallbackReaderLayout = loadReaderLayout(storage);
    fallbackReaderTypography = loadReaderTypography(storage);
    applyReaderChrome();
    rebuildMenus();
  }

  chromeHost.replaceChildren(menuTrigger, toolbar);
  tabsHost.replaceChildren(tabsTrigger, tabBar);
  root.replaceChildren(chromeHost, tabsHost, readerShell, mainRow, statusBarHost);
  root.classList.add('lightink-immersive');

  function applyWorkspace(snapshot: Pick<WorkspaceSnapshot, 'mode' | 'surface'>): void {
    applyWorkspaceSurface(root, snapshot);
    applyWorkspaceSurface(mainRow, snapshot);
    applyWorkspaceSurface(editorArea, snapshot);
    const editorChrome = snapshot.surface === 'editor';
    const shelfChrome = snapshot.surface === 'shelf';
    setChromeSetVisible(chromeHost, editorChrome);
    setChromeSetVisible(tabsHost, editorChrome);
    setChromeSetVisible(readerShell, shelfChrome);
    if (!editorChrome) {
      menuBar.closeAll();
    }
    applyReaderChrome();
  }

  applyWorkspace(resolveShellSnapshot(actions));

  function syncMenuChrome(): void {
    const revealed = chrome.isRevealed('menu');
    const pinned = chrome.isPinned('menu');
    chromeHost.classList.toggle('is-menu-revealed', revealed);
    chromeHost.classList.toggle('is-chrome-pinned', pinned);
    menuTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    menuTrigger.hidden = pinned;
  }

  function syncTabsChrome(): void {
    const revealed = chrome.isRevealed('tabs');
    const pinned = chrome.isPinned('tabs');
    tabsHost.classList.toggle('is-tabs-revealed', revealed);
    tabsHost.classList.toggle('is-chrome-pinned', pinned);
    tabsTrigger.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    tabsTrigger.hidden = pinned;
  }

  function persistPinPrefs(): void {
    saveChromePinPrefs(storage, {
      menu: chrome.isPinned('menu'),
      tabs: chrome.isPinned('tabs'),
    });
  }

  function isChromePinned(): boolean {
    return chrome.isPinned('menu') && chrome.isPinned('tabs');
  }

  function setChromePinned(pinned: boolean): void {
    chrome.setPinned('menu', pinned);
    chrome.setPinned('tabs', pinned);
    syncMenuChrome();
    syncTabsChrome();
    persistPinPrefs();
    if (!pinned) {
      afterLeaveSync(syncMenuChrome);
      afterLeaveSync(syncTabsChrome);
    }
  }

  function toggleChromePinned(): boolean {
    const next = !isChromePinned();
    setChromePinned(next);
    return next;
  }

  function revealMenu(): void {
    chrome.reveal('menu');
    syncMenuChrome();
    menuBar.openMenu('file');
  }

  function toggleMenuChrome(): void {
    chrome.toggle('menu');
    syncMenuChrome();
    if (!chrome.isRevealed('menu')) {
      menuBar.closeAll();
    }
  }

  function toggleTabsChrome(): void {
    chrome.toggle('tabs');
    syncTabsChrome();
  }

  function setTabsHold(hold: boolean): void {
    chrome.setHold('tabs', hold);
    syncTabsChrome();
    // Match pointerleave: hold release may schedule leave while revealed is still
    // true; delayed sync clears is-tabs-revealed after hysteresis.
    if (!hold) {
      afterLeaveSync(syncTabsChrome);
    }
  }

  function afterLeaveSync(sync: () => void): void {
    // Match chrome-controller leave hysteresis (180ms) with a small buffer.
    const schedule =
      typeof setTimeout === 'undefined'
        ? (fn: () => void) => {
            fn();
            return 0;
          }
        : (fn: () => void) => setTimeout(fn, 200);
    schedule(sync);
  }

  function bindSurfacePointer(
    surface: 'menu' | 'tabs',
    elements: readonly HTMLElement[],
    sync: () => void,
  ): void {
    for (const el of elements) {
      el.addEventListener('pointerenter', () => {
        chrome.pointerEnter(surface);
        sync();
      });
      el.addEventListener('pointerleave', () => {
        chrome.pointerLeave(surface);
        afterLeaveSync(sync);
      });
    }
  }

  bindSurfacePointer('menu', [menuTrigger, toolbar], syncMenuChrome);
  bindSurfacePointer('tabs', [tabsTrigger, tabBar], syncTabsChrome);

  menuTrigger.addEventListener('click', () => {
    chrome.reveal('menu');
    syncMenuChrome();
  });
  menuTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chrome.reveal('menu');
      syncMenuChrome();
    }
  });

  tabsTrigger.addEventListener('click', () => {
    chrome.reveal('tabs');
    syncTabsChrome();
  });
  tabsTrigger.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chrome.reveal('tabs');
      syncTabsChrome();
    }
  });

  // Tab context-menu hold is owned by main via setTabsHold + createContextMenu onClose.

  syncMenuChrome();
  syncTabsChrome();

  function showCheatsheet(bindings: readonly CheatBinding[]): void {
    const overlay = document.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'lightink-modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const title = document.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = actions.t('help.cheatsheet');
    labelModal(dialog, title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lightink-modal-close';
    close.textContent = actions.t('dialog.close');
    dialog.append(title, renderCheatsheet(bindings), close);
    overlay.appendChild(dialog);
    let releaseModal = (): void => overlay.remove();
    function dismiss(): void {
      releaseModal();
    }
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        dismiss();
      }
    });
    close.addEventListener('click', dismiss);
    releaseModal = mountModalFocus(document, overlay, dialog, {
      initialFocus: close,
      onEscape: dismiss,
    });
  }

  function renderTabBar(
    tabs: readonly ShellTabInfo[],
    activeId: string | null,
    callbacks: TabBarCallbacks,
  ): void {
    // Always render the full open-tab list; visibility is chrome pin/reveal CSS only.
    tabBar.replaceChildren(
      ...tabs.map((tab) => {
        const item = document.createElement('div');
        item.className = 'lightink-tab';
        item.dataset.tabId = tab.id;
        if (tab.id === activeId) {
          item.classList.add('active');
        }
        if (tab.dirty) {
          item.classList.add('dirty');
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lightink-tab-button';
        btn.id = `lightink-tab-${tab.id}`;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', tab.id === activeId ? 'true' : 'false');
        btn.setAttribute('aria-controls', `lightink-panel-${tab.id}`);
        btn.tabIndex = tab.id === activeId ? 0 : -1;
        const label = document.createElement('span');
        label.className = 'lightink-tab-label';
        label.textContent = tab.dirty ? `● ${tab.title}` : tab.title;
        btn.title = tab.title;
        btn.appendChild(label);
        btn.addEventListener('click', () => callbacks.onSwitch(tab.id));
        btn.addEventListener('keydown', (event) => {
          const current = tabs.findIndex((candidate) => candidate.id === tab.id);
          let next = current;
          if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
          else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = tabs.length - 1;
          else if (event.key === 'Delete') {
            event.preventDefault();
            callbacks.onClose(tab.id);
            return;
          } else {
            return;
          }
          event.preventDefault();
          const target = tabs[next];
          if (target === undefined) return;
          callbacks.onSwitch(target.id);
          const targetItem = Array.from(tabBar.children).find(
            (candidate) => (candidate as HTMLElement).dataset.tabId === target.id,
          );
          const targetButton = Array.from(targetItem?.children ?? []).find((child) =>
            child.classList.contains('lightink-tab-button'),
          );
          (targetButton as HTMLButtonElement | undefined)?.focus();
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'lightink-tab-close';
        close.textContent = '×';
        const closeLabel = actions.t('chrome.closeTab', { title: tab.title });
        close.setAttribute('aria-label', closeLabel);
        close.setAttribute('title', closeLabel);
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          callbacks.onClose(tab.id);
        });
        item.append(btn, close);
        return item;
      }),
    );
  }

  return {
    toolbar,
    tabBar,
    editorArea,
    outlineSidebar,
    statusBarHost,
    chrome,
    revealMenu,
    toggleMenuChrome,
    toggleTabsChrome,
    setTabsHold,
    isChromePinned,
    setChromePinned,
    toggleChromePinned,
    rebuildMenus,
    refreshReaderPreferences,
    setReaderTypography: (patch) => {
      menuActions.onSetReaderTypography?.(patch);
    },
    applyWorkspace,
    enterEditorButton: enterEditorBtn,
    renderTabBar,
    destroy: () => {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('keydown', onReaderLayoutShortcut, true);
      }
    },
  };
}
