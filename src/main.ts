/**
 * 应用入口（T6 正式极简外壳）。
 *
 * 组装顺序：主题服务（默认护眼浅色/深色切换/自定义主题注入槽）→
 * 极简外壳（src/ui/app-shell：命令行 + 标签栏 + 编辑区）→ TabManager
 * （接线保持 T3 语义不变：宿主元素、崩溃快照、恢复流程）→ 快捷键注册。
 */

import { invoke } from '@tauri-apps/api/core';
import { message as dialogMessage, open as openDialog, save } from '@tauri-apps/plugin-dialog';

import { mountEditor } from './editor/index.js';
import { classifyLink } from './editor/link-navigation.js';
import { imageMarkdownSnippet } from './editor/plugins/image.js';
import {
  setFormatToolbarLinkEditor,
  setFormatToolbarTitles,
} from './editor/plugins/format-toolbar.js';
import { setCodeChromeLabels } from './editor/plugins/code-highlight.js';
import { setMathEditTitle } from './editor/plugins/math.js';
import { setMermaidEditTitle } from './editor/plugins/mermaid.js';
import { setTaskCheckboxLabels } from './editor/plugins/task-checkbox.js';
import { setSlashImageHandler, setSlashTranslate } from './editor/plugins/slash-menu.js';
import { setAppDisplayName } from './ui/window-title.js';
import { SourceView } from './editor/source-view.js';
import {
  clearFindReplace,
  collectSourceMatches,
  createFindReplacePanel,
  findReplaceViewForHost,
  nextMatchIndex,
  readFindReplaceState,
  replaceAllMatches,
  replaceCurrentMatch,
  setFindQuery,
  stepFindMatch,
  subscribeFindReplaceStatus,
  type FindReplaceLabels,
  type FindReplacePanel,
} from './editor/plugins/find-replace.js';
import {
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
} from './ui/context-menu.js';
import { showLinkDialog, showOpenLinkConfirm } from './ui/link-dialog.js';
import { showArchivePasswordDialog } from './ui/archive-password-dialog.js';
import {
  formatLinkMarkdown,
  getInsertElement,
  insertElementMarkdown,
  type InsertElementId,
} from './editor/insert-commands.js';
import { fileNameStem, importImageAsset } from './asset/asset-service.js';
import { isReaderPath, planDroppedFiles } from './file/file-drop.js';
import { OPEN_FILTERS } from './file/file-dialog.js';
import { openDocumentPath } from './file/document-router.js';
import { extOfPath } from './file/path-ext.js';
import type {
  ExportServiceDeps,
  ExportTabSnapshot,
} from './export/export-service.js';
import {
  clearSnapshot as clearCrashSnapshot,
  listUntitledDrafts as listCrashDrafts,
  readFile,
  writeFile,
  writeSnapshot as writeCrashSnapshot,
  type UntitledDraft,
} from './file/file-service.js';
import {
  createOutlineView,
  OUTLINE_WIDTH_DEFAULT,
  readStoredOutlineWidth,
  type OutlineView,
} from './outline/outline-view.js';
import {
  createMarkdownAnnotationHost,
  type MarkdownAnnotationHost,
} from './reader/markdown-annotations.js';
import type { RemoteOpenResult } from './reader/sources/remote-source.js';
import type { ReaderTarget, RemoteReaderTarget } from './reader/sources/types.js';
import { readerLoadErrorDetail } from './reader/error-message.js';
import { loadReaderTheme, readerNativeWindowChrome } from './reader/reader-theme.js';
import { loadReaderTypography, nextReaderFontScaleStep } from './reader/reader-typography.js';
import { TabManager, isMarkdownTab } from './tabs/tab-manager.js';
import {
  createAutosave,
  loadAutosaveEnabled,
  type AutosaveController,
} from './tabs/autosave.js';
import type { CloseChoice, MarkdownTabState, ReaderTabState, TabState } from './tabs/types.js';
import { createStyleTagSlot, ThemeService } from './theme/theme-service.js';
import type { CheatBinding } from './ui/help-cheatsheet.js';
import { createAppShell } from './ui/app-shell.js';
import {
  applyWorkspaceVisibility,
  createWorkspaceMode,
  workspaceVisibility,
  type WorkspaceMode,
  type WorkspaceSnapshot,
} from './ui/workspace-mode.js';
import {
  handleExternalOpen,
  revealExistingWindow,
  type ExternalOpenOrigin,
  type ExternalOpenTab,
} from './ui/external-open.js';
import { showConfirmDialog } from './ui/confirm-dialog.js';
import { showExitConfirmation } from './ui/exit-confirmation.js';
import {
  createStatusBar,
  cursorPositionFromOffset,
  loadStatusBarVisible,
  type StatusBar,
  type StatusBarSnapshot,
} from './ui/status-bar.js';
import { createI18n, loadLocale } from './i18n/i18n.js';
import { installDisplayScale } from './ui/display-scale.js';
import { installFontScale, loadFontScale, type FontScaleHandle } from './ui/font-scale.js';
import { installWheelZoom } from './ui/wheel-zoom.js';
import {
  advancePagedScroller,
  advanceScrolledScroller,
  applyPagedSpreadVars,
  applyReadingLayout,
  clearPagedSpreadVars,
  createPagedWheelGate,
  createResizeSettle,
  isReadingNavKey,
  loadReadingLayout,
  pagedSpreadMetrics,
  readingNavDirection,
  saveReadingLayout,
  type ReadingLayout,
} from './ui/reading-layout.js';
import { formatShortcutLabel, isMacPlatform } from './ui/platform.js';
import { loadChromePinPrefs } from './ui/chrome-prefs.js';
import { ShortcutRegistry, pagingShouldIgnoreTarget, wheelPagingShouldIgnoreTarget } from './ui/shortcuts.js';
import { setNativeCaptionColors, setNativeTheme, setNativeTitleBar, toggleFullscreen } from './ui/window-chrome.js';
import { formatDocumentTitle } from './ui/window-title.js';
import { installWindowCloseProtection } from './ui/window-lifecycle.js';
import { libraryClient, type ManagedItemLocation } from './library/library-client.js';
import {
  bindLibraryProgress,
  migrateLibraryProgressAliases,
  saveLibraryProgressAlias,
} from './library/library-progress.js';
import {
  createLibraryView,
  type LibraryOpenRequest,
  type LibraryView,
} from './library/library-view.js';
import { credentialRefForResource, opdsClient } from './library/opds-client.js';
import { createSyncableStorage } from './storage/syncable-storage.js';
import { documentClient } from './sync/document-client.js';
import { syncRecordClient } from './sync/sync-client.js';
import { currentSyncRecords, ApplicationStateSync } from './sync/app-state-sync.js';
import { webDavClient } from './sync/webdav-client.js';
import { showSyncPanel } from './sync/sync-panel.js';
import {
  createBoundVersionActions,
  showVersionsModal,
  type VersionMeta,
} from './ui/versions.js';
import './theme/tokens.css';
import './ui/theme.css';
import './library/library.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) {
  throw new Error('LightInk: #app root container not found in index.html');
}

let applicationStateSync: ApplicationStateSync | undefined;
const syncableStorage = createSyncableStorage(window.localStorage, {
  onChange: (key, value) => {
    window.dispatchEvent(
      new CustomEvent('lightink:syncable-storage-change', { detail: { key, value } }),
    );
    applicationStateSync?.notifyStorageChange(key, value);
  },
});

// 1080p / 2K / 4K layout tier → html[data-display]; theme.css scales tokens.
const displayScale = installDisplayScale(document.documentElement, window);

// Reading font zoom (body/code) over tier baselines; persists lightink.fontScale.
const fontScale = installFontScale(document.documentElement, syncableStorage);

// R5：Ctrl/Cmd + 滚轮字号缩放（与 Ctrl+=/- 同档位）。阅读工作区走阅读排版键。
const readingZoomHandle: FontScaleHandle = {
  get scale() {
    return fontScale.scale;
  },
  get label() {
    return fontScale.label;
  },
  zoomIn: () => changeReadingScale('in'),
  zoomOut: () => changeReadingScale('out'),
  reset: () => changeReadingScale('reset'),
  setScale: (value) => fontScale.setScale(value),
  dispose: () => fontScale.dispose(),
};
const wheelZoom = installWheelZoom(document, readingZoomHandle);

let readingLayout = loadReadingLayout(syncableStorage);
applyReadingLayout(document.documentElement, readingLayout);

function readingSurfaceWidth(): number {
  const scroller = document.getElementById('lightink-editor-area');
  if (scroller === null) {
    return 0;
  }
  const sidebar = scroller.querySelector<HTMLElement>('.lightink-reader-sidebar');
  const sidebarWidth =
    sidebar !== null && !sidebar.hidden && getComputedStyle(sidebar).display !== 'none'
      ? sidebar.getBoundingClientRect().width
      : 0;
  return Math.max(1, scroller.clientWidth - sidebarWidth);
}

/**
 * Markdown 侧翻页分栏：与流式 iframe 根共用同一宿主布局应用器
 * （applyPagedSpreadVars）与同一度量（pagedSpreadMetrics），CSS 变量同源，
 * 两宿主按整页步进（平行 readingColumnLayout 直写实现已删除）。
 */
function syncReadingColumns(): void {
  const scroller = document.getElementById('lightink-editor-area');
  if (scroller === null) {
    return;
  }
  if (readingLayout !== 'paginated') {
    clearPagedSpreadVars(scroller);
    return;
  }
  const fontSize = parseFloat(getComputedStyle(scroller).fontSize);
  applyPagedSpreadVars(scroller, pagedSpreadMetrics(readingSurfaceWidth(), fontSize));
}

// R5：窗口尺寸/大纲三态/chrome pin 变化时分栏重算合并去抖（settle 180ms），
// 避免 resize 突发强制回流；字号缩放（lightink:font-scale）保持即时同步。
const settleReadingColumns = createResizeSettle(180);
function scheduleReadingColumnSync(): void {
  settleReadingColumns(syncReadingColumns);
}

function setReadingLayout(next: ReadingLayout): void {
  readingLayout = next;
  saveReadingLayout(syncableStorage, next);
  applyReadingLayout(document.documentElement, next);
  syncReadingColumns();
}

function toggleReadingLayoutMode(): void {
  setReadingLayout(readingLayout === 'paginated' ? 'scroll' : 'paginated');
  shell?.rebuildMenus();
}

// UI language (en / zh-CN) + macOS shortcut labels.
const i18n = createI18n(syncableStorage);
const isMac = isMacPlatform();

type RecentMutationCommand = 'add_recent' | 'remove_recent' | 'clear_recents';
let recentPersistenceNotice: Promise<void> | null = null;

function reportRecentPersistenceError(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[lightink/recents] persistence failed', error);
  if (recentPersistenceNotice !== null) return;
  const pending = dialogMessage(i18n.t('error.recentsPersistFailed'), {
    title: i18n.t('app.name'),
    kind: 'error',
  })
    .then(() => undefined)
    .catch((dialogError: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[lightink/recents] error dialog failed', dialogError);
    })
    .finally(() => {
      recentPersistenceNotice = null;
    });
  recentPersistenceNotice = pending;
}

async function persistRecentMutation(
  command: RecentMutationCommand,
  payload?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await invoke<void>(command, payload);
    return true;
  } catch (error) {
    reportRecentPersistenceError(error);
    return false;
  }
}

/** Apply locale-dependent chrome labels (window title, format bar, code blocks). */
function applyLocaleChrome(): void {
  setAppDisplayName(i18n.t('app.name'));
  setFormatToolbarTitles({
    bold: i18n.t('format.bold'),
    italic: i18n.t('format.italic'),
    strikethrough: i18n.t('format.strikethrough'),
    code: i18n.t('format.code'),
    link: i18n.t('format.link'),
    highlight: i18n.t('format.highlight'),
    note: i18n.t('format.note'),
    copy: i18n.t('format.copy'),
  });
  setCodeChromeLabels({
    copy: i18n.t('code.copy'),
    copied: i18n.t('code.copied'),
    plain: i18n.t('code.plain'),
    filterPlaceholder: i18n.t('code.filterPlaceholder'),
    emptyFilter: i18n.t('code.emptyFilter'),
    mermaid: i18n.t('code.mermaid'),
    math: i18n.t('code.math'),
  });
  setMathEditTitle(i18n.t('math.editTitle'));
  setMermaidEditTitle(i18n.t('mermaid.editTitle'));
  setTaskCheckboxLabels({
    check: i18n.t('task.markComplete'),
    uncheck: i18n.t('task.markIncomplete'),
  });
  setSlashTranslate((key) => i18n.t(key));
}
applyLocaleChrome();

function refreshLocalizedSurfaces(revealMenu = false): void {
  applyLocaleChrome();
  shell?.rebuildMenus();
  if (revealMenu) shell?.revealMenu();
  outline?.retranslate();
  libraryView?.retranslate();
  statusBar?.refresh(getActiveStatusSnapshot);
  const tab = manager?.activeTab ?? null;
  document.title = formatDocumentTitle(
    tab === null ? null : { title: tab.title, dirty: tab.dirty },
  );
}

// 主题服务：首次启动默认 warm-light，恢复上次选择；自定义主题走 <style> 注入槽。
// R3：主题切换同步原生窗口明暗（Tauri setTheme → 原生标题栏颜色）。
const themeService = new ThemeService({
  root: document.documentElement,
  customStyleSlot: createStyleTagSlot(document),
  storage: syncableStorage,
  readFile,
  syncNativeTheme: (dark) => void setNativeTheme(dark),
  onThemeChange: () => {
    document.dispatchEvent(new CustomEvent('lightink:theme-change'));
  },
});

function reportCustomThemeError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error ?? '');
  void dialogMessage(i18n.t('error.customTheme', { detail }), {
    title: i18n.t('app.name'),
    kind: 'error',
  });
}

void themeService.restorePersistedCustomTheme().catch(reportCustomThemeError);

async function selectCustomTheme(): Promise<void> {
  try {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'CSS', extensions: ['css'] }],
    });
    if (typeof selected === 'string') {
      await themeService.reloadCustomThemeFile(selected);
    }
  } catch (error) {
    reportCustomThemeError(error);
  }
}

// 外壳按钮/快捷键回调仅在用户交互时触发，此时 manager 必然已赋值。
let manager: TabManager;
// Shell is assigned after createAppShell returns; menu labels/actions use optional access.
let shell: ReturnType<typeof createAppShell>;
// T7：大纲视图在 TabManager 之后创建（见下），回调触发时必然已赋值。
let outline: OutlineView;
// T5/R3：字数状态栏在 TabManager 之后创建（见下），菜单回调用 ?. 短路。
let statusBar: StatusBar;
// Per-tab source surfaces must be available to status callbacks during manager startup.
const sourceViews = new Map<string, SourceView>();
const markdownAnnotations = new Map<string, MarkdownAnnotationHost>();
// R14：自动保存控制器在 TabManager 之后创建（见下），菜单回调用 ?. 短路。
let autosave: AutosaveController;
let libraryView: LibraryView | undefined;
const workspace = createWorkspaceMode();
// Cold start is the reader cover wall, not the Markdown editor.
workspace.enterReaderHome();
let applyingWorkspaceSurfaces = false;
// R6：外部变更秒级轮询句柄（退出时清理）。
let externalChangeTimer: number | null = null;
/** 跟踪上次记录的活动标签 kind；markdown↔reader 切换时重建菜单结构。 */
let lastActiveMenuKind: 'markdown' | 'reader' | null = null;

/**
 * 活动 markdown 标签：reader 标签活动时返回 null，编辑器动作据此系统性空转。
 * 构造期 manager 尚未赋值时经 ?. 短路返回 null（菜单 enabled 回调安全）。
 */
function activeMarkdownTab(): MarkdownTabState | null {
  const tab = manager?.activeTab ?? null;
  return tab !== null && isMarkdownTab(tab) ? tab : null;
}

/**
 * 活动 reader 标签：阅读态菜单动作据此取 reader 实例；markdown 标签活动或构造期
 * 返回 null（菜单 enabled 回调安全空转）。
 */
function activeReaderTab(): ReaderTabState | null {
  const tab = manager?.activeTab ?? null;
  if (tab === null) {
    return null;
  }
  return tab.kind === 'reader' ? tab : null;
}

function throwIfReaderReadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Error('Reader load cancelled');
  }
}

/** read_file_bytes 错误映射：原生/前端超限统一本地化为 reader.fileTooLarge。 */
function throwReaderReadError(
  error: unknown,
  tooLargeError: typeof import('./reader/file-bytes.js').ReaderFileTooLargeError,
): never {
  const detail = String(error);
  const nativeLimit = detail.match(/FILE_TOO_LARGE:(\d+):(\d+)/);
  if (nativeLimit !== null) {
    throw new Error(
      i18n.t('reader.fileTooLarge', { actual: nativeLimit[1]!, limit: nativeLimit[2]! }),
    );
  }
  if (error instanceof tooLargeError) {
    throw new Error(
      i18n.t('reader.fileTooLarge', {
        actual: String(error.actualBytes),
        limit: String(error.limitBytes),
      }),
    );
  }
  throw error;
}

/** 读取阅读文件原始字节（read_file_bytes raw IPC → Uint8Array），供 reader-view.load。 */
async function readReaderBytes(
  filePath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfReaderReadCancelled(signal);
  const { readerBytesFromIpc, ReaderFileTooLargeError } = await import(
    './reader/file-bytes.js'
  );
  try {
    throwIfReaderReadCancelled(signal);
    const raw = await invoke<ArrayBuffer>('read_file_bytes', { path: filePath });
    throwIfReaderReadCancelled(signal);
    const bytes = readerBytesFromIpc(filePath, raw);
    throwIfReaderReadCancelled(signal);
    return bytes;
  } catch (error) {
    throwReaderReadError(error, ReaderFileTooLargeError);
  }
}

/**
 * 分块读取阅读文件字节（T8 txt 分块解析）：read_file_bytes 带 offset/length，
 * raw IPC 返回 [offset, offset+length) 窗口字节，EOF 处返回短块；上限与错误
 * 语义与整读一致。
 */
async function readReaderChunk(
  filePath: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfReaderReadCancelled(signal);
  const { readerChunkFromIpc, ReaderFileTooLargeError } = await import(
    './reader/file-bytes.js'
  );
  try {
    throwIfReaderReadCancelled(signal);
    const raw = await invoke<ArrayBuffer>('read_file_bytes', {
      path: filePath,
      offset,
      length,
    });
    throwIfReaderReadCancelled(signal);
    return readerChunkFromIpc(raw, length);
  } catch (error) {
    throwReaderReadError(error, ReaderFileTooLargeError);
  }
}

const localizedReaderError = (error: unknown): string =>
  readerLoadErrorDetail(error, (key, vars) => i18n.t(key, vars));

function reportReaderLoadError(error: unknown): void {
  void dialogMessage(i18n.t('reader.loadFailed', { detail: localizedReaderError(error) }), {
    title: i18n.t('app.name'),
    kind: 'error',
  });
}

/**
 * 按扩展名把路径路由到 markdown 编辑标签或只读 reader 标签，并加载/解析内容。
 * reader 标签：openReader 后调用 reader.load；解析失败（DRM/损坏）弹 i18n 错误提示，
 * 失败标签会立即清理。菜单打开 / 最近打开 / 拖入 / CLI 与文件关联入口共用此分发。
 */
async function openPathByKind(path: string): Promise<TabState | null> {
  const tab = await openDocumentPath(path, {
    manager,
    onReaderOpenError: (failedPath, error) => {
      // eslint-disable-next-line no-console
      console.error(`[lightink] 打开阅读文件失败: ${failedPath}`, error);
      reportReaderLoadError(error);
    },
    onReaderLoadError: (error) => {
      reportReaderLoadError(error);
    },
  });
  // File→Open / recents / drop share this helper. A reader tab opened while
  // the shelf is showing must flip hasOpenBook so the book is not left under
  // the library. Markdown opened from the shelf must enter the editor.
  if (tab?.kind === 'reader') {
    workspace.openBook();
  } else if (tab !== null && isMarkdownTab(tab)) {
    workspace.enterEditor();
  }
  return tab;
}

/**
 * File-association / second-instance open: restore the window, land on the
 * matching surface, and show a short success notify (runtime) or the existing
 * missing/load dialog (failure). Cold-start skips the success toast.
 */
async function openExternalAssociationPath(
  path: string,
  origin: ExternalOpenOrigin,
): Promise<void> {
  await handleExternalOpen(path, origin, {
    openPath: async (filePath): Promise<ExternalOpenTab | null> => {
      const tab = await openPathByKind(filePath);
      if (tab === null) {
        return null;
      }
      if (tab.kind === 'reader') {
        return { kind: 'reader', title: tab.title, filePath: tab.filePath };
      }
      if (isMarkdownTab(tab)) {
        return { kind: 'markdown', title: tab.title, filePath: tab.filePath };
      }
      return null;
    },
    workspace,
    notify: (message, kind = 'info') => {
      const dialogKind = kind === 'warning' || kind === 'error' ? kind : 'info';
      void dialogMessage(message, { title: i18n.t('app.name'), kind: dialogKind });
    },
    reportOpenFailure: (filePath) => {
      // Reader load/open already used reportReaderLoadError inside openPathByKind.
      if (isReaderPath(filePath)) {
        return;
      }
      void dialogMessage(i18n.t('error.openFileMissing', { path: filePath }), {
        title: i18n.t('app.name'),
        kind: 'warning',
      });
    },
    restoreWindow: () => revealExistingWindow(),
    locale: i18n.locale,
  });
}

let outlineVisibilityBeforeLibrary: import('./outline/outline-view.js').OutlineVisibility | null = null;

function setLibraryVisibility(visible: boolean): void {
  if (outline === undefined) return;
  if (visible) {
    if (outline.visibility !== 'hidden') {
      outlineVisibilityBeforeLibrary = outline.visibility;
      outline.setVisibility('hidden');
    }
    return;
  }
  if (outlineVisibilityBeforeLibrary !== null) {
    outline.setVisibility(outlineVisibilityBeforeLibrary);
    outlineVisibilityBeforeLibrary = null;
  }
}

function revealEditorMarkdownTab(): void {
  if (manager === undefined) return;
  const active = manager.activeTab;
  if (active !== null && isMarkdownTab(active)) return;
  const markdown = manager.tabList.find((tab) => tab.kind === 'markdown');
  if (markdown !== undefined) {
    manager.switchTab(markdown.id);
  }
}

function revealReaderBookTab(): void {
  if (manager === undefined) return;
  const active = manager.activeTab;
  if (active !== null && active.kind === 'reader') return;
  const reader = manager.tabList.find((tab) => tab.kind === 'reader');
  if (reader !== undefined) {
    manager.switchTab(reader.id);
  }
}

let appliedWorkspaceSurface: WorkspaceSnapshot['surface'] = workspace.surface;

function applyWorkspaceState(state: WorkspaceSnapshot = workspace.snapshot()): void {
  applyingWorkspaceSurfaces = true;
  try {
    shell?.applyWorkspace(state);
    const vis = workspaceVisibility(state.surface);
    setLibraryVisibility(vis.outlineHidden);
    if (libraryView !== undefined) {
      applyWorkspaceVisibility({ shelf: libraryView.element }, state.surface);
    }
    if (state.surface === 'shelf') {
      void libraryView?.show();
    } else {
      libraryView?.hide({ notifyVisibility: false });
    }
    if (state.surface === 'editor') {
      // Only steal focus when entering the editor surface. openBook() from
      // File→Open of a PDF in the editor must not bounce back to Markdown.
      if (appliedWorkspaceSurface !== 'editor') {
        revealEditorMarkdownTab();
      }
    } else if (state.surface === 'reader') {
      revealReaderBookTab();
    }
    appliedWorkspaceSurface = state.surface;
    syncNativeWindowChrome(state);
    if (manager !== undefined) {
      const shelf = state.surface === 'shelf';
      for (const tab of manager.tabList) {
        tab.hostElement.toggleAttribute('inert', shelf);
        tab.hostElement.setAttribute('aria-hidden', shelf ? 'true' : 'false');
      }
    }
  } catch {
    // Stay on the current workspace; do not dispose tab-manager state.
  } finally {
    applyingWorkspaceSurfaces = false;
  }
}

function onLibraryMenu(): void {
  workspace.enterReaderHome();
}

function onSetWorkspaceMode(mode: WorkspaceMode): void {
  if (mode === 'reader') {
    workspace.enterReaderHome();
    return;
  }
  workspace.enterEditor();
}

function onLibraryVisibilityChange(visible: boolean): void {
  if (applyingWorkspaceSurfaces) {
    setLibraryVisibility(visible);
    return;
  }
  // Shelf hide is not an editor entry. Keep the cover wall if we are on it.
  if (!visible && workspace.surface === 'shelf') {
    if (libraryView !== undefined) {
      applyWorkspaceVisibility({ shelf: libraryView.element }, 'shelf');
    }
    setLibraryVisibility(true);
    return;
  }
  setLibraryVisibility(visible);
}

workspace.subscribe((state) => {
  applyWorkspaceState(state);
  shell?.rebuildMenus();
});

function syncNativeWindowChrome(state: WorkspaceSnapshot = workspace.snapshot()): void {
  if (state.surface === 'reader') {
    const chrome = readerNativeWindowChrome(loadReaderTheme(syncableStorage));
    void setNativeTheme(chrome.dark);
    void setNativeCaptionColors({ caption: chrome.caption, text: chrome.text });
    return;
  }
  void setNativeCaptionColors(null);
  void setNativeTheme(themeService.isDark());
}

document.addEventListener('lightink:reader-theme', () => {
  syncNativeWindowChrome();
});

function libraryItemIdForTarget(target: ReaderTarget): string {
  return target.kind === 'remote'
    ? target.itemId
    : (managedItemIdsByPath.get(target.path) ?? target.identity.id);
}

const managedItemIdsByPath = new Map<string, string>();

function bindOpenedBookProgress(progressId: string, target: ReaderTarget): void {
  saveLibraryProgressAlias(syncableStorage, libraryItemIdForTarget(target), progressId);
}

function rememberManagedRecent(documentId: string): void {
  if (documentId.trim() === '') return;
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(syncableStorage.getItem('lightink.recent.managed') ?? '[]');
    if (Array.isArray(parsed)) ids = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    ids = [];
  }
  ids = [documentId, ...ids.filter((id) => id !== documentId)].slice(0, 20);
  syncableStorage.setItem('lightink.recent.managed', JSON.stringify(ids));
}

async function applyManagedRecents(records: readonly import('./sync/sync-client.js').SyncRecord[]): Promise<void> {
  const record = currentSyncRecords(records, 'app-state').find(
    (candidate) => candidate.field === 'lightink.recent.managed',
  );
  if (record === undefined || record.tombstone || typeof record.value !== 'string') return;
  let ids: string[];
  try {
    const parsed: unknown = JSON.parse(record.value);
    if (!Array.isArray(parsed)) return;
    ids = parsed.filter((value): value is string => typeof value === 'string').slice(0, 20);
  } catch {
    return;
  }
  const documents = await documentClient.list().catch(() => []);
  for (const id of ids) {
    const document = documents.find((candidate) => candidate.id === id && candidate.localPath);
    if (document?.localPath != null && document.localPath !== '') {
      await persistRecentMutation('add_recent', { path: document.localPath });
    }
  }
}

const synchronizedDraftIdsByKey = new Map<string, string>();
const offeredDraftKeys = new Set<string>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUntitledSnapshotKey(key: string): boolean {
  return /^untitled-[A-Za-z0-9-]{1,96}$/.test(key);
}

function embeddedDraftId(key: string): string | undefined {
  const candidate = key.slice('untitled-'.length);
  return UUID_PATTERN.test(candidate) ? candidate : undefined;
}

async function writeSynchronizedSnapshot(key: string, content: string): Promise<void> {
  await writeCrashSnapshot(key, content);
  if (!isUntitledSnapshotKey(key)) return;
  const deviceId = await syncRecordClient.deviceId();
  const draft = await documentClient.saveDraft(
    undefined,
    key,
    deviceId,
    content,
    synchronizedDraftIdsByKey.get(key) ?? embeddedDraftId(key),
  );
  synchronizedDraftIdsByKey.set(key, draft.id);
  applicationStateSync?.schedule();
}

async function clearSynchronizedSnapshot(key: string): Promise<void> {
  await clearCrashSnapshot(key);
  if (!isUntitledSnapshotKey(key)) return;
  const draftId = synchronizedDraftIdsByKey.get(key) ?? embeddedDraftId(key);
  synchronizedDraftIdsByKey.delete(key);
  if (draftId !== undefined) {
    await documentClient.deleteDraft(draftId);
    applicationStateSync?.schedule();
  }
}

async function listRecoverableDrafts(): Promise<UntitledDraft[]> {
  const localDrafts = await listCrashDrafts().catch(() => []);
  const available = new Map(localDrafts.map((draft) => [draft.key, draft]));
  const synchronized = await documentClient.listDrafts().catch(() => []);
  for (const draft of synchronized) {
    if (draft.documentId !== undefined) continue;
    const storedKey = draft.title;
    const key =
      storedKey !== undefined && isUntitledSnapshotKey(storedKey)
        ? storedKey
        : `untitled-sync-${draft.id}`;
    synchronizedDraftIdsByKey.set(key, draft.id);
    if (available.has(key) || offeredDraftKeys.has(key)) continue;
    const content = await documentClient
      .readDraft(draft.id)
      .catch(() => syncRecordClient.downloadDraft(draft.id))
      .catch(() => null);
    if (content !== null) available.set(key, { key, content });
  }
  const drafts = [...available.values()].filter((draft) => !offeredDraftKeys.has(draft.key));
  for (const draft of drafts) offeredDraftKeys.add(draft.key);
  return drafts;
}

let draftRecoveryQueue: Promise<void> = Promise.resolve();

function recoverAvailableDrafts(): Promise<void> {
  const recover = async (): Promise<void> => {
    await manager.recoverUntitledDrafts();
  };
  const task = draftRecoveryQueue.then(recover, recover);
  draftRecoveryQueue = task.catch(() => undefined);
  return task;
}

function remoteExtension(item: LibraryOpenRequest['item'], acquisition: NonNullable<LibraryOpenRequest['acquisition']>): string {
  if (acquisition.extension !== undefined && acquisition.extension !== '') return acquisition.extension;
  if (item.extension !== undefined && item.extension !== '') return item.extension;
  try {
    const path = new URL(acquisition.href).pathname;
    return extOfPath(path);
  } catch {
    return extOfPath(acquisition.href);
  }
}

function remoteOperationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function throwIfOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

async function openLibraryRemote(
  request: LibraryOpenRequest,
  signal?: AbortSignal,
): Promise<RemoteOpenResult> {
  const { item, acquisition } = request;
  if (acquisition === undefined) throw new Error('没有可用的获取链接');
  const requestId = remoteOperationId('library-open');
  const cancel = (): void => {
    void invoke<void>('remote_cancel', { requestId }).catch(() => undefined);
  };
  throwIfOperationAborted(signal);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const opened = await invoke<RemoteOpenResult>('remote_open', {
      url: acquisition.href,
      itemId: item.id,
      allowHttp: request.source?.allowHttp === true,
      credentialRef: credentialRefForResource(request.source, acquisition.href),
      requestId,
    });
    try {
      throwIfOperationAborted(signal);
    } catch (error) {
      await invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
      throw error;
    }
    return opened;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function openLibraryItem(
  request: LibraryOpenRequest,
  signal?: AbortSignal,
): Promise<void> {
  const { item } = request;
  if (item.sourceKind === 'local' || item.sourceKind === 'managed') {
    let location: ManagedItemLocation;
    try {
      location = await libraryClient.materializeItem(item.id);
    } catch (error) {
      // A synced managed row may have metadata but no local body yet. Opening
      // it is the same user action as pressing the explicit download button.
      if (item.sourceKind !== 'managed' || item.blobHash == null || item.blobHash === '') throw error;
      throwIfOperationAborted(signal);
      const path = await syncRecordClient.downloadBook(item.id);
      throwIfOperationAborted(signal);
      location = { itemId: item.id, path, availability: 'local' as const };
    }
    if (item.sourceKind === 'managed') {
      managedItemIdsByPath.set(location.path, location.itemId);
    }
    const tab = await openPathByKind(location.path);
    if (tab === null) {
      throw new Error(i18n.t('reader.loadFailed', { detail: item.title }));
    }
    workspace.openBook();
    return;
  }
  const acquisition = request.acquisition;
  if (acquisition === undefined) throw new Error('没有可用的获取链接');
  let opened: RemoteOpenResult;
  try {
    opened = await openLibraryRemote(request, signal);
  } catch (error) {
    throw new Error(localizedReaderError(error));
  }
  const cancel = (): void => {
    void invoke<void>('remote_cancel', { resourceId: opened.resourceId }).catch(() => undefined);
    void invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    throwIfOperationAborted(signal);
    if (!opened.supportsRanges) {
      await dialogMessage(i18n.t('reader.remote.noRange'), {
        title: i18n.t('app.name'),
        kind: 'warning',
      });
    }
    throwIfOperationAborted(signal);
    const extension = remoteExtension(item, acquisition);
    const target: RemoteReaderTarget = {
      kind: 'remote',
      itemId: item.id,
      resourceId: opened.resourceId,
      identity: { id: opened.identity },
      displayName: item.title,
      extension,
      mimeType: opened.mimeType ?? acquisition.mediaType ?? 'application/octet-stream',
    };
    const tab = await manager.openReader(target);
    // openReader switches to an existing identity. The newly opened backend
    // handle is redundant in that case and must be released immediately.
    if (tab.target.kind !== 'remote' || tab.target.resourceId !== opened.resourceId) {
      await invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
      workspace.openBook();
      return;
    }
    await tab.reader.load(target);
    workspace.openBook();
  } catch (error) {
    await invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
    throw new Error(localizedReaderError(error));
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function cacheLibraryItem(
  request: LibraryOpenRequest,
  signal?: AbortSignal,
): Promise<void> {
  const { item, acquisition } = request;
  if (item.sourceKind === 'local' || item.sourceKind === 'managed' || acquisition === undefined) {
    return;
  }
  let opened: RemoteOpenResult;
  try {
    opened = await openLibraryRemote(request, signal);
  } catch (error) {
    throw new Error(localizedReaderError(error));
  }
  const cancel = (): void => {
    void invoke<void>('remote_cancel', { resourceId: opened.resourceId }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const chunkSize = 16 * 1024 * 1024;
    for (let offset = 0; offset < opened.size; offset += chunkSize) {
      throwIfOperationAborted(signal);
      const length = Math.min(chunkSize, opened.size - offset);
      await invoke<ArrayBuffer | number[]>('remote_read_range', {
        resourceId: opened.resourceId,
        offset,
        length,
      });
      throwIfOperationAborted(signal);
    }
    await libraryClient.upsertItem({
      ...item,
      etag: opened.etag,
      lastModified: opened.lastModified,
      size: opened.size,
      updatedAt: Date.now(),
    });
  } catch (error) {
    throw new Error(localizedReaderError(error));
  } finally {
    signal?.removeEventListener('abort', cancel);
    await invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
  }
}

async function enrichLocalLibraryItem(
  item: import('./library/library-client.js').LibraryItem,
): Promise<import('./library/library-client.js').LibraryItem> {
  if (
    (item.sourceKind !== 'local' && item.sourceKind !== 'managed') ||
    item.localPath == null || item.localPath === ''
  ) {
    return item;
  }
  const extension = (item.extension ?? '').toLowerCase();
  if (extension !== 'epub' && extension !== 'cbz') {
    return item;
  }
  const { extractLocalBookMeta, isShelfCoverUrl } = await import('./library/local-book-meta.js');
  if (isShelfCoverUrl(item.coverUrl)) {
    return item;
  }
  try {
    const bytes = await readReaderBytes(item.localPath);
    const meta = await extractLocalBookMeta(item.localPath, bytes);
    const next = {
      ...item,
      title: meta.title !== undefined && meta.title !== '' ? meta.title : item.title,
      authors: meta.authors.length > 0 ? meta.authors : item.authors,
      coverUrl: meta.coverUrl ?? item.coverUrl,
      updatedAt: Date.now(),
    };
    if (next.title !== item.title || next.coverUrl !== item.coverUrl || next.authors !== item.authors) {
      await libraryClient.upsertItem(next);
    }
    return next;
  } catch {
    return item;
  }
}

async function importLocalLibraryItem(): Promise<import('./library/library-client.js').LibraryItem | null> {
  let selected: string | null = null;
  try {
    const result = await openDialog({ multiple: false, directory: false, filters: OPEN_FILTERS });
    selected = typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
  if (selected === null) return null;
  const item = await libraryClient.importManagedBook(selected);
  const enriched = await enrichLocalLibraryItem(item);
  await libraryClient.upsertItem(enriched);
  return enriched;
}

/**
 * 菜单「打开」/ Ctrl+O：弹出对话框（Markdown + 电子书），按所选扩展名路由到
 * markdown 或 reader 标签。
 */
async function openViaDialog(): Promise<void> {
  let picked: string | null;
  try {
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: OPEN_FILTERS,
    });
    picked = typeof result === 'string' ? result : null;
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无原生对话框，静默取消。
    return;
  }
  if (picked === null) {
    return;
  }
  await openPathByKind(picked);
}

function saveActiveAs(): void {
  const id = manager.activeTabId;
  if (id !== null) {
    void manager.saveTabAs(id);
  }
}

/** 将当前已保存的 Markdown 复制到应用数据目录并把标签切换到受管副本。 */
async function joinActiveMarkdownToSyncSpace(): Promise<void> {
  commitActiveSourceMode();
  const tab = activeMarkdownTab();
  if (tab === null || tab.filePath === null || tab.managedDocumentId !== undefined) {
    return;
  }
  if (tab.dirty) {
    const choice = await showConfirmDialog(document, {
      title: i18n.locale === 'en' ? 'Save before joining' : '加入同步空间前保存',
      message:
        i18n.locale === 'en'
          ? 'The source Markdown must be saved before it can be copied into the sync space.'
          : '加入同步空间前需要先保存当前 Markdown，原文件不会被移动或删除。',
      buttons: [
        {
          id: 'save',
          label: i18n.locale === 'en' ? 'Save and continue' : '保存并继续',
          kind: 'primary',
        },
        { id: 'cancel', label: i18n.t('dialog.cancel'), kind: 'plain' },
      ],
      cancelId: 'cancel',
    });
    if (choice !== 'save') return;
    if (!(await manager.saveTab(tab.id))) return;
  }
  try {
    const result = await documentClient.join(tab.filePath);
    const adopted = await manager.adoptManagedDocument(
      tab.id,
      result.document.id,
      result.managedPath,
      result.content,
    );
    if (!adopted) return;
    rememberManagedRecent(result.document.id);
    if (result.warnings.length > 0) {
      void dialogMessage(result.warnings.join('\n'), {
        title: i18n.locale === 'en' ? 'Sync space warnings' : '同步空间提示',
        kind: 'warning',
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    void dialogMessage(
      `${i18n.locale === 'en' ? 'Could not join the sync space' : '加入同步空间失败'}\n${detail}`,
      { title: i18n.t('app.name'), kind: 'error' },
    );
  }
}

/**
 * 向活动标签插入元素（R2 插入菜单 / R5 快捷键）：
 *   - 图片：走本地文件选择 → 落盘 assets → 光标处插入（见 insertImageFromFile）；
 *   - 链接：弹出文本+URL 对话框，确认后插入（不直接塞占位 snippet）；
 *   - 源码模式：片段插入到源码 textarea 光标处（否则写编辑器会被源码态退出时
 *     的 textarea 写回覆盖，用户感知为「插入无法使用」）；
 *   - WYSIWYG：结构化解析后在光标处插入。
 */
function insertElement(id: InsertElementId): void {
  const tab = activeMarkdownTab();
  if (tab === null) {
    return;
  }
  if (id === 'image') {
    void insertImageFromFile();
    return;
  }
  if (id === 'link') {
    void insertLinkViaDialog();
    return;
  }
  const element = getInsertElement(id);
  if (element === undefined) {
    return;
  }
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.insertSnippetAtCursor(element.snippet());
    return;
  }
  // Structured insert at caret (table/list/code as real nodes, not plain text).
  if (tab.editor.insertMarkdown(element.snippet())) {
    return;
  }
  // Fallback: append as markdown blocks at end of document.
  tab.editor.setMarkdown(insertElementMarkdown(tab.editor.getMarkdown(), id));
}

/** Insert → Link / shortcut: themed dialog for display text + URL. */
async function insertLinkViaDialog(): Promise<void> {
  const tab = activeMarkdownTab();
  if (tab === null) return;

  const sourceView = sourceViews.get(tab.id);
  const inSource = sourceView !== undefined && sourceView.isSourceMode;
  const existing = !inSource ? tab.editor.getLinkAtCursor() : null;

  const result = await showLinkDialog(document, {
    title: existing !== null ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
    initialText: existing?.text ?? '',
    initialHref: existing?.href ?? '',
    confirmLabel: i18n.t('dialog.link.apply'),
    labels: {
      text: i18n.t('dialog.link.textLabel'),
      textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
      href: i18n.t('dialog.link.hrefLabel'),
      hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
      cancel: i18n.t('dialog.cancel'),
    },
  });
  if (result === null) return;

  const md = formatLinkMarkdown(result.text, result.href);
  if (md === '') return;

  if (inSource && sourceView !== undefined) {
    sourceView.insertSnippetAtCursor(md);
  } else {
    // setLink wraps the current selection or inserts a linked run at the caret.
    tab.editor.setLink(result.href, result.text);
  }
}

/**
 * 插入图片（共享主流程）：Rust 侧落盘（文档旁 assets/ 或未保存文档的
 * 会话暂存目录）→ 在光标处插入引用。WYSIWYG 插入 image 节点；源码模式插入
 * Markdown 图片片段到 textarea 光标处。落盘失败提示且不插入引用（同粘贴路径）。
 * 调用方：插入菜单的文件选择器、OS 文件拖入。
 */
async function importAndInsertImage(sourcePath: string): Promise<void> {
  const tab = activeMarkdownTab();
  if (tab === null) {
    return;
  }
  let relPath: string;
  try {
    relPath = await importImageAsset(tab.filePath, tab.syntheticId, sourcePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    void dialogMessage(i18n.t('error.imageImport', { detail }), {
      title: i18n.t('error.imageImportTitle'),
      kind: 'error',
    });
    return;
  }
  const alt = fileNameStem(sourcePath);
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.insertSnippetAtCursor(imageMarkdownSnippet({ id: '', url: relPath, alt }));
  } else {
    tab.editor.insertImage(relPath, alt);
  }
}

/** 插入菜单「图片」：打开本地文件选择器，选中后走共享落盘/插入流程。 */
async function insertImageFromFile(): Promise<void> {
  const tab = manager.activeTab;
  if (tab === null) {
    return;
  }
  let selected: string | null;
  try {
    const result = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    selected = typeof result === 'string' ? result : null;
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无原生对话框，静默取消。
    return;
  }
  if (selected === null) {
    return;
  }
  await importAndInsertImage(selected);
}

/**
 * OS 文件拖入窗口（tauri://drag-drop）：.md/.markdown 逐个开标签；图片走共享
 * 落盘/插入流程（顺带覆盖 OS 拖图——dragDropEnabled 下 HTML5 handleDrop 收不到
 * OS 文件）；其余类型汇总一条提示。
 */
async function handleOsFileDrop(paths: readonly string[]): Promise<void> {
  const plan = planDroppedFiles(paths);
  let openedMarkdown = false;
  for (const path of plan.markdown) {
    const opened = await manager.openFile(path);
    if (opened === null) {
      void dialogMessage(i18n.t('error.openFileMissing', { path }), {
        title: i18n.t('app.name'),
        kind: 'warning',
      });
    } else {
      openedMarkdown = true;
    }
  }
  if (openedMarkdown) {
    workspace.enterEditor();
  }
  for (const path of plan.reader) {
    await openPathByKind(path);
  }
  for (const path of plan.images) {
    await importAndInsertImage(path);
  }
  if (plan.unsupported.length > 0) {
    const sep = i18n.locale === 'en' ? ', ' : '、';
    const names = plan.unsupported.map((p) => p.split(/[\\/]/).pop() ?? p).join(sep);
    void dialogMessage(i18n.t('error.unsupportedType', { names }), {
      title: i18n.t('app.name'),
      kind: 'warning',
    });
  }
}

/** Focus the active writing surface (source textarea or ProseMirror view). */
function focusActiveEditor(): void {
  const tab = activeMarkdownTab();
  if (tab === null) {
    return;
  }
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.focusEditor();
    return;
  }
  tab.editor.focus();
}

/**
 * Run after the menu click stack unwinds so the editor can take focus away from
 * the just-clicked menu button (menus steal focus on open/click).
 */
function afterMenuFocus(run: () => void): void {
  // Double rAF: first frame closes/hides the menu panel; second frame focuses editor.
  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

/** Menu undo: ProseMirror history in WYSIWYG; native undo in source mode. */
function undoActiveEditor(): void {
  afterMenuFocus(() => {
    const tab = activeMarkdownTab();
    if (tab === null) {
      return;
    }
    const sourceView = sourceViews.get(tab.id);
    if (sourceView !== undefined && sourceView.isSourceMode) {
      sourceView.focusEditor();
      document.execCommand('undo');
      sourceView.syncToEditor();
      return;
    }
    tab.editor.undo();
    tab.editor.focus();
  });
}

/** Menu redo: ProseMirror history in WYSIWYG; native redo in source mode. */
function redoActiveEditor(): void {
  afterMenuFocus(() => {
    const tab = activeMarkdownTab();
    if (tab === null) {
      return;
    }
    const sourceView = sourceViews.get(tab.id);
    if (sourceView !== undefined && sourceView.isSourceMode) {
      sourceView.focusEditor();
      document.execCommand('redo');
      sourceView.syncToEditor();
      return;
    }
    tab.editor.redo();
    tab.editor.focus();
  });
}

/**
 * Clipboard menu actions must run against a focused editable target.
 * Menu clicks steal focus, so re-focus before cut/copy/paste.
 */
function runClipboardCommand(command: 'cut' | 'copy' | 'paste'): void {
  afterMenuFocus(() => {
    focusActiveEditor();
    if (command === 'paste') {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (typeof text !== 'string' || text === '') {
            return;
          }
          focusActiveEditor();
          const ok = document.execCommand('insertText', false, text);
          if (!ok) {
            // Fallback for environments that still allow the paste command.
            document.execCommand('paste');
          }
        })
        .catch(() => {
          focusActiveEditor();
          document.execCommand('paste');
        });
      return;
    }
    document.execCommand(command);
  });
}

interface ExportPipeline {
  readonly buildExportCss: (extraCss?: string) => string;
  readonly exportHtml: (deps: ExportServiceDeps) => Promise<boolean>;
  readonly exportPdf: (deps: ExportServiceDeps) => Promise<boolean>;
  readonly printHtml: (doc: Document, html: string) => void;
  readonly printPdfNative: (
    doc: Document,
    html: string,
    invokeNative: (size: { readonly width: number; readonly height: number }) => Promise<void>,
  ) => Promise<void>;
}

let exportPipelinePromise: Promise<ExportPipeline> | null = null;

/** Load the export implementation and its self-contained CSS only after an export command. */
function loadExportPipeline(): Promise<ExportPipeline> {
  if (exportPipelinePromise !== null) {
    return exportPipelinePromise;
  }
  const pending = Promise.all([
    import('./export/export-css.js'),
    import('./export/export-service.js'),
    import('./export/pdf-export.js'),
  ]).then(([css, service, pdf]) => ({
    buildExportCss: css.buildExportCss,
    exportHtml: service.exportActiveTabHtml,
    exportPdf: service.exportActiveTabPdf,
    printHtml: pdf.printViaMainWindow,
    printPdfNative: pdf.printToPdfFile,
  }));
  exportPipelinePromise = pending;
  void pending.catch(() => {
    if (exportPipelinePromise === pending) {
      exportPipelinePromise = null;
    }
  });
  return pending;
}

// T10（R5）：导出依赖装配。DOM/IPC 薄接线集中在此，编排与纯逻辑在
// src/export/ 下（可 headless 测试）。
async function activeExportSnapshot(
  kind: 'html' | 'pdf' = 'html',
): Promise<ExportTabSnapshot | null> {
  const tab = manager.activeTab;
  if (tab === null) {
    return null;
  }
  if (tab.kind === 'reader') {
    const contentHtml = (await tab.reader.getExportHtml?.(kind === 'pdf' ? 'blob' : 'inline')) ?? null;
    if (contentHtml === null) {
      return null;
    }
    return {
      title: tab.title,
      filePath: tab.filePath,
      sessionId: tab.syntheticId,
      contentHtml,
    };
  }
  if (!isMarkdownTab(tab)) {
    return null;
  }
  return {
    title: tab.title,
    filePath: tab.filePath,
    sessionId: tab.syntheticId,
    // T4/R2：导出含完整内容——剥离 heading-fold 的折叠装饰（display:none 区间与
    // 三角 widget），它们挂在 .ProseMirror DOM 上，会被 serializeEditorContent 读到。
    contentHtml: exportContentHtmlWithoutFold(tab.hostElement),
  };
}

/**
 * T4/R2：导出用正文 HTML——克隆活动标签的 .ProseMirror 并剥离折叠装饰，确保
 * 折叠态下导出的 HTML/PDF 仍含全部内容且无三角 widget 污染（R2 outcome「导出
 * HTML/PDF 含完整内容」）。导出管线读取渲染后 DOM innerHTML（非 getMarkdown），
 * 故必须在此清理折叠留下的内联 display:none / 折叠 class / widget 节点。
 */
function exportContentHtmlWithoutFold(host: HTMLElement): string {
  const pm = host.querySelector('.ProseMirror');
  if (pm === null) {
    // 与 serializeEditorContent 相同的回退（不静态 import，保住导出管线懒加载）。
    return host.innerHTML;
  }
  const clone = pm.cloneNode(true) as HTMLElement;
  // 移除每个标题前的折叠三角 widget。
  clone.querySelectorAll('.lightink-fold-marker').forEach((el) => el.remove());
  // 解除折叠区间隐藏：移除内联 display:none 与折叠 class，使被折叠块在导出中可见。
  clone.querySelectorAll('.lightink-folded-region').forEach((el) => {
    el.classList.remove('lightink-folded-region');
    el.removeAttribute('style');
  });
  // 移除折叠标题的状态 class（不影响内容显示，仅清理）。
  clone.querySelectorAll('.lightink-heading-folded').forEach((el) => {
    el.classList.remove('lightink-heading-folded');
  });
  return clone.innerHTML;
}

/** 自定义主题激活时读取注入槽的 CSS，一并内嵌进导出文档。 */
function currentCustomThemeCss(): string {
  return document.getElementById('lightink-custom-theme')?.textContent ?? '';
}

function reportExportError(message: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[lightink/export] ${message}`, error);
  const detail = error instanceof Error ? error.message : String(error ?? '');
  void dialogMessage(`${message}\n${detail}`, {
    title: i18n.t('error.exportFailed'),
    kind: 'error',
  });
}

function createExportDeps(
  pipeline: ExportPipeline,
  snapshot: ExportTabSnapshot | null,
): ExportServiceDeps {
  return {
    getActiveSnapshot: () => snapshot,
    getTheme: () => document.documentElement.getAttribute('data-theme') ?? 'warm-light',
    getCssText: () => pipeline.buildExportCss(currentCustomThemeCss()),
    readImageBase64: (docPath, sessionId, relPath) =>
      invoke<string>('read_image_base64', { docPath, sessionId, relPath }),
    showHtmlSaveDialog: async (defaultPath) => {
      const selected = await save({
        defaultPath,
        filters: [
          { name: 'HTML', extensions: ['html', 'htm'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return typeof selected === 'string' ? selected : null;
    },
    writeFile,
    // macOS/Linux WebKit requires printing from the main window.
    printHtml: (html) => pipeline.printHtml(document, html),
    showPdfSaveDialog: async (defaultPath) => {
      const selected = await save({
        defaultPath,
        filters: [
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return typeof selected === 'string' ? selected : null;
    },
    printPdfNative: (html, path) =>
      pipeline.printPdfNative(document, html, (size) =>
        invoke<void>('print_webview_to_pdf', {
          path,
          contentWidth: size.width,
          contentHeight: size.height,
        }),
      ),
    // R1/T6：macOS 平台判断——原生 createPDF 失败时不回退 window.print。
    isMacOS: () => isMac,
    getUnsafeCssErrorMessage: () => i18n.t('error.exportUnsafeCss'),
    reportError: reportExportError,
  };
}

async function runActiveExport(kind: 'html' | 'pdf'): Promise<void> {
  try {
    const snapshot = await activeExportSnapshot(kind);
    const pipeline = await loadExportPipeline();
    const deps = createExportDeps(pipeline, snapshot);
    if (kind === 'html') {
      await pipeline.exportHtml(deps);
    } else {
      await pipeline.exportPdf(deps);
    }
  } catch (error) {
    reportExportError(i18n.t('error.exportFailed'), error);
  }
}

shell = createAppShell(
  app,
  {
    onNew: () => void manager.newTab(),
    onOpen: () => void openViaDialog(),
    onToggleLibrary: onLibraryMenu,
    getWorkspaceMode: () => workspace.mode,
    getWorkspaceSnapshot: () => workspace.snapshot(),
    onSetWorkspaceMode,
    onEnterEditor: () => workspace.enterEditor(),
    onEnterReaderHome: () => workspace.enterReaderHome(),
    isReaderBookOpen: () => workspace.mode === 'reader' && workspace.hasOpenBook,
    listRecents: () => invoke<string[]>('list_recents'),
    openRecent: async (path) => {
      const tab = await openPathByKind(path);
      if (tab === null) {
        // 文件缺失/不可读：移除该最近条目并提示。
        const removed = await persistRecentMutation('remove_recent', { path });
        void dialogMessage(
          `${i18n.t('error.openFile', { path })}${
            removed ? ` ${i18n.t('error.recentRemoved')}` : ''
          }`,
          { title: i18n.t('app.name'), kind: 'warning' },
        );
        return false;
      }
      return true;
    },
    clearRecents: async () => {
      await persistRecentMutation('clear_recents');
    },
    onShowVersions: () => showVersionsForActive(),
    // 注意：菜单 enabled 回调在 createAppShell 构造期就被同步调用（见 menus.ts 的
    // refreshItemEnabled），此时 manager 尚未赋值（于下方 new TabManager 处赋值）。
    // 用 ?. 短路避免构造期抛错；构造期返回 false（无活动文件）也正确，菜单打开时
    // 会经 refreshMenu 重算。
    hasActiveFile: () => activeMarkdownTab()?.filePath != null,
    onSave: () => {
      commitActiveSourceMode();
      void manager.saveActiveTab();
    },
    onSaveAs: () => {
      commitActiveSourceMode();
      void saveActiveAs();
    },
    onJoinSyncSpace: () => {
      void joinActiveMarkdownToSyncSpace();
    },
    canJoinSyncSpace: () => {
      const tab = activeMarkdownTab();
      return tab?.filePath !== null && tab?.filePath !== undefined && tab.managedDocumentId === undefined;
    },
    onOpenSyncPanel: () => {
      showSyncPanel({
        doc: document,
        webdav: webDavClient,
        sync: syncRecordClient,
        syncNow: () => applicationStateSync?.syncNow() ?? syncRecordClient.run(),
        migration: {
          preview: () => libraryClient.previewManagedMigration(),
          apply: async (itemIds) => {
            const selected = new Set(itemIds);
            const legacyPaths = new Map<string, string>();
            const currentItems = await libraryClient.listItems().catch(() => []);
            for (const item of currentItems) {
              if (selected.has(item.id) && item.localPath != null && item.localPath !== '') {
                legacyPaths.set(item.id, item.localPath);
              }
            }
            const result = await libraryClient.applyManagedMigration(itemIds);
            migrateLibraryProgressAliases(syncableStorage, result.aliases, legacyPaths);
            for (const alias of result.aliases) {
              const path = legacyPaths.get(alias.aliasId);
              if (path !== undefined) managedItemIdsByPath.set(path, alias.itemId);
            }
            return result;
          },
        },
        locale: i18n.locale,
      });
    },
    // R14：自动保存开关（文件菜单勾选项；autosave 在 TabManager 后创建，
    // 菜单动作经 ?. 短路，菜单打开时 isAutosaveEnabled 重算勾选态）。
    isAutosaveEnabled: () => autosave?.isEnabled() === true,
    onToggleAutosave: () => {
      autosave?.toggle();
    },
    onExportHtml: () => {
      commitActiveSourceMode();
      void runActiveExport('html');
    },
    onExportPdf: () => {
      commitActiveSourceMode();
      void runActiveExport('pdf');
    },
    onUndo: () => undoActiveEditor(),
    onRedo: () => redoActiveEditor(),
    onCut: () => runClipboardCommand('cut'),
    onCopy: () => runClipboardCommand('copy'),
    onPaste: () => runClipboardCommand('paste'),
    onFind: () => {
      // reader 标签活动时分流到阅读器搜索面板（与 Ctrl+F 一致）。
      const readerTab = activeReaderTab();
      if (readerTab !== null) {
        readerTab.reader.openSearch?.(window.getSelection()?.toString());
        return;
      }
      openFindPanel();
    },
    // T6/R10：全选（双模式）；含未保存新标签在内的任意活动文档均可用。
    onSelectAll: () => selectAllActive(),
    hasActiveDocument: () => activeMarkdownTab() != null,
    onInsertElement: insertElement,
    onToggleTheme: () => {
      themeService.toggle();
    },
    onApplyTheme: (themeId) => {
      themeService.apply(themeId);
    },
    getCurrentThemeId: () => themeService.currentThemeId,
    onReloadCustomTheme: () => {
      void themeService.reloadCustomThemeFile().catch(reportCustomThemeError);
    },
    onSelectCustomTheme: () => void selectCustomTheme(),
    onResetCustomTheme: () => themeService.resetCustomTheme(),
    canReloadCustomTheme: () => themeService.customThemePath !== null,
    canResetCustomTheme: () =>
      themeService.isCustomThemeActive || themeService.customThemePath !== null,
    onToggleOutline: () => outline.toggleCollapse(),
    // T7/R10：整窗 WYSIWYG ↔ 源码模式切换。
    onToggleSourceMode: () => toggleActiveSourceMode(),
    getReadingLayout: () => readingLayout,
    onToggleReadingLayout: () => toggleReadingLayoutMode(),
    // T5/R3：字数状态栏开关（视图菜单勾选项；statusBar 在 TabManager 后创建，
    // 菜单动作经 ?. 短路，菜单打开时 isStatusBarVisible 重算勾选态）。
    isStatusBarVisible: () => statusBar?.isVisible() === true,
    onToggleStatusBar: () => {
      statusBar?.toggle();
    },
    onToggleFullscreen: () => {
      void enterOrExitFullscreen();
    },
    // Shell is assigned after createAppShell returns; menu opens re-evaluate.
    isChromePinned: () => shell?.isChromePinned() === true,
    onToggleChromePinned: () => {
      toggleChromePinnedWithOutline();
    },
    onZoomIn: () => {
      changeReadingScale('in');
    },
    onZoomOut: () => {
      changeReadingScale('out');
    },
    onZoomReset: () => {
      changeReadingScale('reset');
    },
    getFontScaleLabel: () => fontScale.label,
    // ---- 标注：阅读器与 Markdown 共用菜单 ----
    activeTabKind: () => manager?.activeTab?.kind ?? null,
    isReaderAnnotationEnabled: () => activeAnnotationController()?.isAnnotationEnabled() ?? false,
    isReaderSidebarVisible: () => activeAnnotationController()?.isSidebarVisible() ?? false,
    onReaderAddBookmark: () => {
      activeAnnotationController()?.addBookmark();
    },
    onReaderAddNote: () => {
      activeAnnotationController()?.addNote();
    },
    onReaderToggleSidebar: () => {
      activeAnnotationController()?.toggleSidebar();
      shell?.rebuildMenus();
    },
    t: (key, vars) => i18n.t(key, vars),
    formatShortcut: (combo) => formatShortcutLabel(combo, isMac),
    getLocale: () => i18n.locale,
    setLocale: (locale) => {
      i18n.setLocale(locale);
      // Keep menu chrome visible so the user sees the new language immediately.
      refreshLocalizedSurfaces(true);
    },
  },
  { shortcutBindings: getShortcutBindings, storage: syncableStorage },
);

/**
 * Immersive chrome: unpinning hides menu + tabs; also fully hides the outline
 * so the writing surface is unobstructed. Pinning restores outline if we hid it.
 */
let outlineVisibilityBeforeImmersive: import('./outline/outline-view.js').OutlineVisibility | null =
  null;

function toggleChromePinnedWithOutline(): void {
  if (shell === undefined) {
    return;
  }
  const wasPinned = shell.isChromePinned();
  const nowPinned = shell.toggleChromePinned();
  if (!nowPinned && wasPinned) {
    // Enter immersive (unpinned): fully hide outline (not just rail).
    if (outline !== undefined && outline.visibility !== 'hidden') {
      outlineVisibilityBeforeImmersive = outline.visibility;
      outline.setVisibility('hidden');
    }
    scheduleReadingColumnSync();
    return;
  }
  if (nowPinned && outlineVisibilityBeforeImmersive !== null && outline !== undefined) {
    outline.setVisibility(outlineVisibilityBeforeImmersive);
    outlineVisibilityBeforeImmersive = null;
  }
  scheduleReadingColumnSync();
}

function applySynchronizedPreferences(): void {
  themeService.refreshFromStorage();

  i18n.setLocale(loadLocale(syncableStorage));
  refreshLocalizedSurfaces();

  fontScale.setScale(loadFontScale(syncableStorage));
  setReadingLayout(loadReadingLayout(syncableStorage));
  shell.refreshReaderPreferences();
  for (const tab of manager.tabList) {
    if (tab.kind === 'reader') tab.reader.refreshPreferences?.();
  }

  autosave?.setEnabled(loadAutosaveEnabled(syncableStorage));
  statusBar?.setVisible(loadStatusBarVisible(syncableStorage));
  outline?.setWidth(readStoredOutlineWidth(syncableStorage) ?? OUTLINE_WIDTH_DEFAULT);

  const chrome = loadChromePinPrefs(syncableStorage);
  const pinned = chrome.menu && chrome.tabs;
  if (shell.isChromePinned() !== pinned) {
    shell.setChromePinned(pinned);
    if (!pinned && outline.visibility !== 'hidden') {
      outlineVisibilityBeforeImmersive = outline.visibility;
      outline.setVisibility('hidden');
    } else if (pinned && outlineVisibilityBeforeImmersive !== null) {
      outline.setVisibility(outlineVisibilityBeforeImmersive);
      outlineVisibilityBeforeImmersive = null;
    }
  }
  syncNativeWindowChrome();
  scheduleReadingColumnSync();
}

/** Fullscreen also forces unpinned chrome + fully hidden outline for a clean canvas. */
async function enterOrExitFullscreen(): Promise<void> {
  const next = await toggleFullscreen();
  // R2：全屏隐藏原生标题栏，退出恢复（no-op 于非 Tauri / 无权限环境）。
  await setNativeTitleBar(!next);
  if (next) {
    if (shell !== undefined && shell.isChromePinned()) {
      shell.setChromePinned(false);
    }
    if (outline !== undefined && outline.visibility !== 'hidden') {
      outlineVisibilityBeforeImmersive = outline.visibility;
      outline.setVisibility('hidden');
    }
  } else if (outlineVisibilityBeforeImmersive !== null && outline !== undefined) {
    // Leaving fullscreen: restore prior outline mode if we hid it.
    // Keep chrome unpinned so user stays in writing mode unless they re-pin.
    outline.setVisibility(outlineVisibilityBeforeImmersive);
    outlineVisibilityBeforeImmersive = null;
  }
}

/** 关闭未保存标签的三选一确认（应用内主题化弹层，一次给出全部选择）。 */
async function confirmClose(tab: { title: string }): Promise<CloseChoice> {
  const choice = await showConfirmDialog(document, {
    title: i18n.t('dialog.closeTab.title'),
    message: i18n.t('dialog.closeTab.message', { title: tab.title }),
    buttons: [
      { id: 'save', label: i18n.t('dialog.save'), kind: 'primary' },
      { id: 'discard', label: i18n.t('dialog.discard'), kind: 'danger' },
      { id: 'cancel', label: i18n.t('dialog.cancel'), kind: 'plain' },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'save') return 'save';
  if (choice === 'discard') return 'discard';
  return 'cancel';
}

function renderTabBar(): void {
  pruneSourceViews();
  pruneMarkdownAnnotations();
  for (const tab of manager.tabList) {
    if (tab.kind === 'markdown') {
      annotationHostFor(tab);
    }
  }
  shell.renderTabBar(manager.tabList, manager.activeTabId, {
    onSwitch: (id) => {
      const tab = manager.tabList.find((item) => item.id === id);
      manager.switchTab(id);
      if (tab?.kind === 'markdown' && workspace.mode === 'reader') {
        workspace.enterEditor();
      } else if (tab?.kind === 'reader') {
        workspace.openBook();
        workspace.enterReader();
      }
    },
    onClose: (id) => {
      // 关闭前提交该标签的源码态编辑，避免 closeTab 保存分支写旧值/丢 textarea 编辑。
      commitSourceMode(id);
      void manager.closeTab(id).then(() => {
        if (
          workspace.mode === 'reader' &&
          workspace.hasOpenBook &&
          activeReaderTab() === null
        ) {
          workspace.returnToShelf();
        }
      });
    },
  });
  syncDocumentTitle();
  // markdown ↔ reader 切换时重建菜单（隐藏/显示「插入」与「标注」）。
  const kind = manager.activeTab?.kind ?? null;
  if (kind !== lastActiveMenuKind) {
    lastActiveMenuKind = kind;
    shell?.rebuildMenus();
  }
}

/** Window identity for immersive shell: active title + dirty without a permanent tab strip. */
function syncDocumentTitle(): void {
  const tab = manager.activeTab;
  document.title = formatDocumentTitle(
    tab === null ? null : { title: tab.title, dirty: tab.dirty },
  );
}

/** Cycle active tab without requiring the tab bar to be revealed. */
function cycleActiveTab(delta: 1 | -1): void {
  const tabs = manager.tabList;
  if (tabs.length === 0) {
    return;
  }
  const current = manager.activeTabId;
  const index = current === null ? 0 : Math.max(0, tabs.findIndex((t) => t.id === current));
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next !== undefined) {
    manager.switchTab(next.id);
    if (next.kind === 'markdown' && workspace.mode === 'reader') {
      workspace.enterEditor();
    } else if (next.kind === 'reader') {
      workspace.openBook();
      workspace.enterReader();
    }
  }
}

/** 清理已关闭标签的 SourceView（宿主已由 detachHost 移除；dispose 释放残留监听器与 DOM）。 */
function pruneSourceViews(): void {
  const live = new Set(manager.tabList.map((t) => t.id));
  for (const [id, view] of [...sourceViews.entries()]) {
    if (!live.has(id)) {
      view.dispose();
      sourceViews.delete(id);
    }
  }
}

async function writeSyncedAnnotations(contentHash: string, json: string): Promise<void> {
  await invoke<void>('write_annotations', { contentHash, json });
  // Annotation records are independent fields. A failed sync-record write must
  // never make the local annotation save appear to fail.
  await syncRecordClient
    .writeRecord(`annotation:${contentHash}`, 'json', json)
    .catch(() => undefined);
  applicationStateSync?.schedule();
}

async function applySyncedAnnotations(records: readonly import('./sync/sync-client.js').SyncRecord[]): Promise<void> {
  for (const objectId of new Set(records.map((record) => record.objectId).filter((id) => id.startsWith('annotation:')))) {
    const hash = objectId.slice('annotation:'.length);
    if (!/^[0-9a-f]{16,64}$/i.test(hash)) continue;
    const record = currentSyncRecords(records, objectId).find((candidate) => candidate.field === 'json');
    if (record?.tombstone || typeof record?.value !== 'string') continue;
    await invoke<void>('write_annotations', { contentHash: hash, json: record.value }).catch(() => undefined);
  }
}

async function applyPortableOpdsSources(
  records: readonly import('./sync/sync-client.js').SyncRecord[],
): Promise<void> {
  const record = currentSyncRecords(records, 'app-state').find(
    (candidate) => candidate.field === 'lightink.opds.sources',
  );
  if (record === undefined || record.tombstone || typeof record.value !== 'string') return;
  let remote: PortableOpdsSource[];
  try {
    const parsed: unknown = JSON.parse(record.value);
    if (!Array.isArray(parsed)) return;
    remote = parsed.filter(
      (source): source is PortableOpdsSource =>
        typeof source === 'object' &&
        source !== null &&
        typeof (source as Record<string, unknown>).id === 'string' &&
        typeof (source as Record<string, unknown>).title === 'string' &&
        typeof (source as Record<string, unknown>).url === 'string' &&
        typeof (source as Record<string, unknown>).allowHttp === 'boolean',
    );
  } catch {
    return;
  }
  const local = await opdsClient.listSources().catch(() => []);
  const remoteIds = new Set(remote.map((source) => source.id));
  for (const source of local) {
    if (!remoteIds.has(source.id)) await opdsClient.removeSource(source.id).catch(() => undefined);
  }
  for (const source of remote) {
    const existing = local.find((candidate) => candidate.id === source.id);
    await opdsClient
      .addSource({
        id: source.id,
        title: source.title,
        url: source.url,
        allowHttp: source.allowHttp,
        // Keep a credential reference already present on this device, but
        // never serialize it into the portable record sent to another device.
        credentialRef: existing?.credentialRef,
      })
      .catch(() => undefined);
  }
}

function annotationHostFor(tab: MarkdownTabState): MarkdownAnnotationHost {
  let host = markdownAnnotations.get(tab.id);
  if (host === undefined) {
    host = createMarkdownAnnotationHost(tab.hostElement, {
      t: (key, vars) => i18n.t(key, vars),
      getContentHash: (path) => invoke<string>('content_hash', { path }),
      readAnnotations: (contentHash) => invoke<string>('read_annotations', { contentHash }),
      writeAnnotations: writeSyncedAnnotations,
      notify: (message) => {
        void dialogMessage(message, { title: i18n.t('app.name'), kind: 'warning' });
      },
    });
    markdownAnnotations.set(tab.id, host);
  }
  host.syncIdentity(tab.filePath, tab.syntheticId);
  return host;
}

function pruneMarkdownAnnotations(): void {
  const live = new Set(manager.tabList.map((tab) => tab.id));
  for (const [id, host] of markdownAnnotations) {
    if (!live.has(id)) {
      host.destroy();
      markdownAnnotations.delete(id);
    }
  }
}

function activeAnnotationController(): {
  addBookmark(): void;
  addNote(): void;
  toggleSidebar(): void;
  isSidebarVisible(): boolean;
  isAnnotationEnabled(): boolean;
} | null {
  const reader = activeReaderTab();
  if (reader !== null) {
    return reader.reader;
  }
  const markdown = activeMarkdownTab();
  return markdown === null ? null : annotationHostFor(markdown);
}

// T3/R3：共享滚动容器 #lightink-editor-area——markdown 正文/源码的唯一样式滚动
// 元素（reader 视图 absolute inset:0 填充本槽位，自有分页，不滚动此容器）。
const editorScroller = shell.editorArea;
editorScroller.dataset.surface = 'markdown';

manager = new TabManager({
  formatUntitledTitle: (n) => i18n.t('app.untitled', { n: String(n) }),
  formatUntitledRestoredTitle: (n) => i18n.t('app.untitledRestored', { n: String(n) }),
  remoteImageLoadLabel: i18n.t('reader.remoteImageLoad'),
  writeSnapshot: writeSynchronizedSnapshot,
  clearSnapshot: clearSynchronizedSnapshot,
  listUntitledDrafts: listRecoverableDrafts,
  mountEditor,
  mountReader: async (host) => {
    host.classList.add('lightink-tab-host--reader');
    editorScroller.dataset.surface = 'reader';
    const { createReaderView } = await import('./reader/reader-view.js');
    const reader = createReaderView(host, {
      readBytes: readReaderBytes,
      readChunk: readReaderChunk,
      t: (key, vars) => i18n.t(key, vars),
      getContentHash: (path) => invoke<string>('content_hash', { path }),
      readAnnotations: (contentHash) => invoke<string>('read_annotations', { contentHash }),
      writeAnnotations: (contentHash, json) =>
        writeSyncedAnnotations(contentHash, json),
      notify: (message) => {
        void dialogMessage(message, { title: i18n.t('app.name'), kind: 'warning' });
      },
      requestArchivePassword: ({ displayName, retry }) =>
        showArchivePasswordDialog(document, {
          displayName,
          retry,
          t: (key, vars) => i18n.t(key, vars),
        }),
      onComicMetadata: async (target, metadata) => {
        await libraryClient.updateComicMetadata(libraryItemIdForTarget(target), {
          series: metadata.series,
          number: metadata.number,
          volume: metadata.volume,
          pageCount: metadata.pageCount,
          readingDirection: metadata.readingDirection,
          coverPage: metadata.coverPage,
        });
        applicationStateSync?.schedule();
      },
      onProgressBound: bindOpenedBookProgress,
      progressStorage: syncableStorage,
      preferenceStorage: syncableStorage,
      onReturnToShelf: () => workspace.returnToShelf(),
    });
    reader.subscribeState(() => {
      const active = manager?.activeTab;
      if (active?.kind === 'reader' && active.reader === reader) {
        statusBar?.refresh(getActiveStatusSnapshot);
        outline?.refreshNow();
      }
    });
    return reader;
  },
  createHostElement: (tabId) => {
    const el = document.createElement('div');
    el.className = 'lightink-tab-host';
    el.id = `lightink-panel-${tabId}`;
    el.dataset.tabId = tabId;
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', `lightink-tab-${tabId}`);
    return el;
  },
  attachHost: (el) => {
    shell.editorArea.appendChild(el);
  },
  detachHost: (el) => {
    el.remove();
  },
  confirmClose,
  promptRestore: async (path) =>
    (await showConfirmDialog(document, {
      title: i18n.t('dialog.crash.title'),
      message: i18n.t('dialog.crash.message', { path }),
      buttons: [
        { id: 'restore', label: i18n.t('dialog.crash.restore'), kind: 'primary' },
        { id: 'skip', label: i18n.t('dialog.crash.skip'), kind: 'plain' },
      ],
      cancelId: 'skip',
    })) === 'restore',
  // R13：未脏文件检测到磁盘更新（提示「可重新加载」）。
  confirmExternalReload: async (tab) =>
    (await showConfirmDialog(document, {
      title: i18n.t('dialog.externalReload.title'),
      message: i18n.t('dialog.externalReload.message', { title: tab.title }),
      buttons: [
        { id: 'reload', label: i18n.t('dialog.externalReload.reload'), kind: 'primary' },
        { id: 'ignore', label: i18n.t('dialog.externalReload.ignore'), kind: 'plain' },
      ],
      cancelId: 'ignore',
    })) === 'reload'
      ? 'reload'
      : 'ignore',
  // R13：已脏文件 / 保存前检测到外部冲突（保留内存 / 重新加载 / 覆盖磁盘）。
  confirmExternalConflict: async (tab) => {
    const choice = await showConfirmDialog(document, {
      title: i18n.t('dialog.externalConflict.title'),
      message: i18n.t('dialog.externalConflict.message', { title: tab.title }),
      buttons: [
        { id: 'keep', label: i18n.t('dialog.externalConflict.keep'), kind: 'primary' },
        { id: 'reload', label: i18n.t('dialog.externalConflict.reload'), kind: 'plain' },
        { id: 'overwrite', label: i18n.t('dialog.externalConflict.overwrite'), kind: 'danger' },
      ],
      cancelId: 'keep',
    });
    if (choice === 'reload') return 'reload';
    if (choice === 'overwrite') return 'overwrite';
    return 'keep';
  },
  onTabsChanged: renderTabBar,
  // T3/R3：切换完成后恢复目标 markdown 标签的滚动位置（reader 自有分页跳过）。
  onTabSwitched: () => {
    const tab = manager?.activeTab ?? null;
    editorScroller.dataset.surface = tab?.kind === 'reader' ? 'reader' : 'markdown';
    // reader 覆盖层（侧栏/搜索面板）portal 到共享 chrome，不随标签宿主隐藏——
    // 逐个 reader 标签同步可见性，防止残留在别的标签上。
    for (const item of manager.tabList) {
      if (item.kind === 'reader') {
        item.reader.setTabActive(item === tab);
      }
    }
    if (tab === null || tab.kind !== 'markdown') {
      return;
    }
    editorScroller.scrollTop = manager.getScrollPosition(tab.id);
  },
  // T4/R2：编辑器内点折叠三角切换后，立即刷新大纲的折叠标记态。
  onFoldChanged: () => {
    outline.refreshNow();
  },
  onActiveContentChanged: () => {
    outline.scheduleRefresh();
    // T5/R3：状态栏防抖刷新（内部在隐藏时短路不渲染）。
    statusBar.scheduleUpdate(getActiveStatusSnapshot);
    // 查找面板打开时：内容编辑后同步命中计数（WYSIWYG 插件已重算 decoration，
    // 源码模式需重收 matches；都不强制跳回首命中）。
    refreshFindOnContentChange();
  },
  onSaveStatusChanged: (tabId) => {
    if (manager?.activeTabId === tabId) {
      statusBar?.refresh(getActiveStatusSnapshot);
    }
  },
  onFileOpened: (filePath) => {
    void persistRecentMutation('add_recent', { path: filePath });
    const opened = manager?.tabList.find(
      (candidate) => candidate.kind === 'markdown' && candidate.filePath === filePath,
    );
    if (opened?.kind === 'markdown' && opened.managedDocumentId !== undefined) {
      rememberManagedRecent(opened.managedDocumentId);
    }
  },
  onFileSaved: (filePath, content) => {
    // R13：每次成功保存自动生成一份版本快照。
    void invoke('create_version', { filePath, content }).catch(() => undefined);
    const tab = manager.tabList.find((item) => item.kind === 'markdown' && item.filePath === filePath);
    if (tab !== undefined && tab.kind === 'markdown') {
      markdownAnnotations.get(tab.id)?.syncIdentity(tab.filePath, tab.syntheticId);
    }
  },
  onManagedDocumentSaved: (documentId, content) => {
    void syncRecordClient
      .deviceId()
      .then((deviceId) => documentClient.createVersion(documentId, content, deviceId))
      .catch(() => undefined);
    applicationStateSync?.schedule();
  },
  onLinkNavigate: (href) => handleLinkNavigation(href),
  // R13：轮询发现活动文件被删/不可读时的一次性可见提示（TabManager 按不可读期去重）。
  notifyExternalUnreadable: (tab) => {
    const message =
      i18n.locale === 'en'
        ? `The file is unreadable or was deleted externally:\n${tab.filePath ?? tab.title}`
        : `文件不可读或已被外部删除：\n${tab.filePath ?? tab.title}`;
    void dialogMessage(message, { title: i18n.t('app.name'), kind: 'warning' });
  },
  confirmLinkOpen: (href) =>
    showOpenLinkConfirm(document, href, {
      title: i18n.t('dialog.link.openTitle'),
      message: i18n.t('dialog.link.openMessage'),
      openLabel: i18n.t('dialog.open'),
      cancelLabel: i18n.t('dialog.cancel'),
    }),
});

// T3/R3：实时记录活动标签的滚动位置到其 TabState.scrollTop。共享容器只有一个，
// 故 markdown 标签的滚动需逐事件回写当前活动标签；切换时由 onTabSwitched 恢复
// 目标标签的存储值（reader 不滚动此容器，活动 reader 时此处 scrollTop 恒 0）。
editorScroller.addEventListener(
  'scroll',
  () => {
    const m = manager;
    if (m === undefined) {
      return;
    }
    const id = m.activeTabId;
    if (id !== null) {
      m.recordScrollPosition(id, editorScroller.scrollTop);
    }
  },
  { passive: true },
);

// Format toolbar / context menu: themed link editor (text + href).
setFormatToolbarLinkEditor(async (initial) => {
  const result = await showLinkDialog(document, {
    title: initial.href ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
    initialText: initial.text,
    initialHref: initial.href,
    confirmLabel: i18n.t('dialog.link.apply'),
    labels: {
      text: i18n.t('dialog.link.textLabel'),
      textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
      href: i18n.t('dialog.link.hrefLabel'),
      hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
      cancel: i18n.t('dialog.cancel'),
    },
  });
  return result;
});

// Slash `/image` uses the same file-picker path as Insert → Image.
setSlashImageHandler(() => insertImageFromFile());


// T7：大纲侧栏。闭包读取活动标签的宿主/markdown；刷新由 TabManager 的
// onActiveContentChanged 回调防抖驱动（切换标签/活动标签内容变化）。
outline = createOutlineView({
  storage: syncableStorage,
  getActiveHost: () => manager.activeTab?.hostElement ?? null,
  getActiveMarkdown: () => {
    const tab = activeMarkdownTab();
    if (tab === null) {
      return null;
    }
    try {
      return tab.editor.getMarkdown();
    } catch {
      return null;
    }
  },
  getActiveReaderOutline: () => {
    const tab = activeReaderTab();
    return tab === null ? null : tab.reader.getOutline();
  },
  jumpToReaderOutlineItem: (item) => {
    activeReaderTab()?.reader.jumpToOutlineItem(item);
  },
  // T4/R2：大纲↔编辑器折叠双向联动（序号口径与 buildOutline anchor 一致）。
  getFoldedOrdinals: () => activeMarkdownTab()?.editor.getFoldedOrdinals() ?? [],
  toggleFoldAtOrdinal: (ordinal) => {
    activeMarkdownTab()?.editor.toggleFoldAtOrdinal(ordinal);
  },
  t: (key) => i18n.t(key),
  onVisibilityChange: () => scheduleReadingColumnSync(),
});
shell.outlineSidebar.appendChild(outline.root);

// Document status bar: hidden by default. Content and cursor updates are
// debounced; save/conflict transitions refresh immediately.
// 标签闭包现读 locale，语言切换后下次刷新即用新文案。
statusBar = createStatusBar(document, shell.statusBarHost, {
  storage: syncableStorage,
  labels: () => ({
    words: i18n.t('status.words'),
    characters: i18n.t('status.characters'),
    line: i18n.t('status.line'),
    column: i18n.t('status.column'),
    encoding: i18n.t('status.encoding'),
    save: {
      saved: i18n.t('status.save.saved'),
      dirty: i18n.t('status.save.dirty'),
      saving: i18n.t('status.save.saving'),
      error: i18n.t('status.save.error'),
      conflict: i18n.t('status.save.conflict'),
    },
    reader: {
      phase: {
        empty: i18n.t('status.reader.empty'),
        loading: i18n.t('status.reader.loading'),
        ready: i18n.t('status.reader.ready'),
        cancelled: i18n.t('status.reader.cancelled'),
        error: i18n.t('status.reader.error'),
        destroyed: i18n.t('status.reader.destroyed'),
      },
      page: i18n.t('status.reader.page'),
      chapter: i18n.t('status.reader.chapter'),
      progress: i18n.t('status.reader.progress'),
      zoom: i18n.t('status.reader.zoom'),
    },
  }),
});

type PortableOpdsSource = {
  id: string;
  title: string;
  url: string;
  allowHttp: boolean;
  createdAt: number;
  updatedAt: number;
};

async function persistPortableOpdsSources(): Promise<void> {
  const sources = await opdsClient.listSources();
  const portable: PortableOpdsSource[] = sources.map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
    allowHttp: source.allowHttp,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }));
  syncableStorage.setItem('lightink.opds.sources', JSON.stringify(portable));
}

const syncedOpdsClient = {
  addSource: async (input: Parameters<typeof opdsClient.addSource>[0]) => {
    const source = await opdsClient.addSource(input);
    await persistPortableOpdsSources().catch(() => undefined);
    return source;
  },
  listSources: () => opdsClient.listSources(),
  removeSource: async (sourceId: string) => {
    await opdsClient.removeSource(sourceId);
    await persistPortableOpdsSources().catch(() => undefined);
  },
  browse: (sourceId: string, url?: string) => opdsClient.browse(sourceId, url),
  search: (sourceId: string, query: string) => opdsClient.search(sourceId, query),
};

libraryView = createLibraryView(shell.editorArea, {
  opds: syncedOpdsClient,
  library: libraryClient,
  getLocale: () => i18n.locale,
  getProgress: bindLibraryProgress(syncableStorage),
  workspaceTravel: shell.enterEditorButton,
  enrichLocalItem: enrichLocalLibraryItem,
  onOpen: openLibraryItem,
  onCache: cacheLibraryItem,
  onDownload: async (item, signal) => {
    throwIfOperationAborted(signal);
    const path = await syncRecordClient.downloadBook(item.id);
    throwIfOperationAborted(signal);
    return path;
  },
  onImportLocal: importLocalLibraryItem,
  onLocalChange: () => applicationStateSync?.schedule(),
  notify: (message, kind = 'warning') => {
    void dialogMessage(message, { title: i18n.t('app.name'), kind });
  },
  confirmGroupDelete: async (_group, message) =>
    (await showConfirmDialog(document, {
      title: i18n.t('app.name'),
      message,
      buttons: [
        { id: 'delete', label: i18n.t('dialog.discard'), kind: 'danger' },
        { id: 'cancel', label: i18n.t('dialog.cancel'), kind: 'plain' },
      ],
      cancelId: 'cancel',
    })) === 'delete',
  onVisibilityChange: onLibraryVisibilityChange,
});
applyWorkspaceState();

applicationStateSync = new ApplicationStateSync({
  storage: syncableStorage,
  records: syncRecordClient,
  getProfile: () => webDavClient.getProfile(),
  eventTarget: window,
  onStorageApplied: () => {
    applySynchronizedPreferences();
  },
  onRecordsApplied: async (records) => {
    await applySyncedAnnotations(records);
    await applyPortableOpdsSources(records);
    await applyManagedRecents(records);
    void recoverAvailableDrafts().catch((error: unknown) => {
      console.warn('[lightink/sync] synchronized draft recovery failed', error);
    });
  },
  onError: (error) => {
    // Automatic sync is intentionally quiet; the sync status surface can
    // present the backend error without interrupting editing.
    console.warn('[lightink/sync] automatic state sync failed', error);
  },
});
applicationStateSync.start();

/** R8：状态栏 Markdown 序列化缓存——按内容版本去重，避免光标移动时重复全量序列化。 */
let statusMarkdownCache: { tabId: string; revision: number; markdown: string } | null = null;

/** Build the active editor or Reader status from its owning instance. */
function getActiveStatusSnapshot(): StatusBarSnapshot {
  const tab = manager.activeTab;
  if (tab === null) return null;
  if (tab.kind === 'reader') {
    return {
      kind: 'reader',
      state: tab.reader.state,
      displayScale:
        tab.reader.state.scale * loadReaderTypography(syncableStorage).fontScaleStep,
    };
  }
  try {
    const revision = manager.getContentRevision(tab.id);
    let markdown: string;
    if (
      statusMarkdownCache !== null &&
      statusMarkdownCache.tabId === tab.id &&
      statusMarkdownCache.revision === revision
    ) {
      markdown = statusMarkdownCache.markdown;
    } else {
      markdown = tab.editor.getMarkdown();
      statusMarkdownCache = { tabId: tab.id, revision, markdown };
    }
    const source = sourceViews.get(tab.id);
    const textarea =
      source?.isSourceMode === true
        ? tab.hostElement.querySelector<HTMLTextAreaElement>('textarea.lightink-source-editor')
        : null;
    const cursor =
      textarea === null
        ? (tab.editor.getCursorPosition() ?? { line: 1, column: 1 })
        : cursorPositionFromOffset(textarea.value, textarea.selectionEnd);
    return {
      kind: 'markdown',
      markdown,
      saveStatus: manager.getSaveStatus(tab.id) ?? (tab.dirty ? 'dirty' : 'saved'),
      cursor,
    };
  } catch {
    return null;
  }
}

function isReaderZoomContext(): boolean {
  return workspace.mode === 'reader' || manager?.activeTab?.kind === 'reader';
}

function changeReadingScale(action: 'in' | 'out' | 'reset'): number {
  if (isReaderZoomContext()) {
    const fontScaleStep = nextReaderFontScaleStep(
      loadReaderTypography(syncableStorage).fontScaleStep,
      action,
    );
    shell?.setReaderTypography({ fontScaleStep });
    if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
      document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: fontScaleStep }));
    }
    syncReadingColumns();
    statusBar?.refresh(getActiveStatusSnapshot);
    return fontScaleStep;
  }
  const next =
    action === 'in' ? fontScale.zoomIn() : action === 'out' ? fontScale.zoomOut() : fontScale.reset();
  syncReadingColumns();
  statusBar?.refresh(getActiveStatusSnapshot);
  return next;
}

// 启动即渲染一次（可见偏好恢复时显示当前文档口径，不等首次编辑）。
statusBar.refresh(getActiveStatusSnapshot);
syncReadingColumns();
window.addEventListener('resize', scheduleReadingColumnSync);
document.addEventListener('lightink:font-scale', syncReadingColumns);
document.addEventListener('selectionchange', () => {
  statusBar.scheduleUpdate(getActiveStatusSnapshot);
});

// R14：可选自动保存（默认关；偏好 localStorage 跨会话保持）。tick 前先提交
// 活动标签的源码态编辑（与手动保存同口径），再扫全部有路径脏 tab 走同一保存流
// （含 R13 保存前 mtime 闸门；冲突由既有对话框分派，不静默覆盖）。
autosave = createAutosave({
  storage: syncableStorage,
  tick: () => {
    commitActiveSourceMode();
    return manager.autosaveDirtyTabs();
  },
  onError: (error) => {
    // eslint-disable-next-line no-console
    console.error('[lightink/autosave] tick failed', error);
  },
});

/** R13：为活动文件弹出版本历史（列表/预览/恢复/手动存档）。 */
function showVersionsForActive(): void {
  const tab = activeMarkdownTab();
  if (tab === null || tab.filePath === null) {
    return;
  }
  const filePath = tab.filePath;
  showVersionsModal(
    document,
    createBoundVersionActions({
      targetId: tab.id,
      filePath,
      getTarget: (id) => {
        const target = manager.tabList.find((candidate) => candidate.id === id) ?? null;
        return target !== null && isMarkdownTab(target) ? target : null;
      },
      getContent: (target) => target.editor.getMarkdown(),
      setContent: (target, content) => target.editor.setMarkdown(content),
      listVersions: (path) => invoke<VersionMeta[]>('list_versions', { filePath: path }),
      readVersion: (path, id) =>
        invoke<string>('read_version', { filePath: path, versionId: id }),
      restoreVersion: (path, id, currentContent) =>
        invoke<string>('restore_version', {
          filePath: path,
          versionId: id,
          currentContent,
        }),
      createVersion: (path, content) =>
        invoke('create_version', { filePath: path, content }),
    }),
    {
      title: i18n.t('dialog.versions.title'),
      loading: i18n.t('dialog.loading'),
      pick: i18n.t('dialog.versions.pick'),
      empty: i18n.t('dialog.versions.empty'),
      restore: i18n.t('dialog.versions.restore'),
      saveNew: i18n.t('dialog.versions.saveNew'),
      close: i18n.t('dialog.close'),
      loadFailed: i18n.t('dialog.versions.loadFailed'),
      justNow: i18n.t('dialog.justNow'),
      minutesAgo: (n) => i18n.t('dialog.minutesAgo', { n: String(n) }),
      hoursAgo: (n) => i18n.t('dialog.hoursAgo', { n: String(n) }),
      daysAgo: (n) => i18n.t('dialog.daysAgo', { n: String(n) }),
    },
  );
}

/** 取路径所在目录（兼容 / 与 \）。 */
function dirOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

/** R14：点击文档链接 → 分类跳转（外链浏览器 / 本地 .md 新标签 / 其他本地文件系统默认）。 */
function handleLinkNavigation(href: string): void {
  const docPath = manager.activeTab?.filePath ?? '';
  const currentDocDir = docPath !== '' ? dirOf(docPath) : '';
  const link = classifyLink(href, currentDocDir);
  switch (link.kind) {
    case 'external':
      void invoke('open_in_browser', { url: link.target }).catch(() => undefined);
      return;
    case 'localMd':
      void openLocalMdLink(link.target);
      return;
    case 'localFile':
      void invoke('open_path_default', { path: link.target }).catch(() => undefined);
      return;
    default:
      return;
  }
}

/** 相对/绝对 .md 链接：应用内新标签打开；目标不存在给出提示。 */
async function openLocalMdLink(path: string): Promise<void> {
  const opened = await manager.openFile(path);
  if (opened === null) {
    void dialogMessage(i18n.t('error.openFileMissing', { path }), {
      title: i18n.t('app.name'),
      kind: 'warning',
    });
  }
}

// T7/R10：每标签的源码视图（惰性创建）。整窗 WYSIWYG ↔ 源码模式，单窗格无并排。
function toggleActiveSourceMode(): void {
  const tab = activeMarkdownTab();
  if (tab === null) return;
  let view = sourceViews.get(tab.id);
  if (view === undefined) {
    view = new SourceView(tab.hostElement, tab.editor);
    sourceViews.set(tab.id, view);
  }
  view.toggle();
  statusBar.refresh(getActiveStatusSnapshot);
}
/** 源码态下把活动标签的 textarea 源码同步回编辑器（供保存/大纲读取一致）。 */
function commitActiveSourceMode(): void {
  const tab = manager.activeTab;
  if (tab === null) return;
  commitSourceMode(tab.id);
}
/** 按标签 id 提交其源码态编辑（同步到编辑器，不退出源码模式）。 */
function commitSourceMode(tabId: string): void {
  const view = sourceViews.get(tabId);
  if (view !== undefined && view.isSourceMode) {
    view.syncToEditor();
  }
}

/** Commit every source textarea before application-exit dirty-state inspection. */
function commitAllSourceModes(): void {
  for (const tab of manager.tabList) {
    commitSourceMode(tab.id);
  }
}

/**
 * T6/R10：全选活动文档（双模式）。WYSIWYG 走编辑器渐进式 selectAll（与 Mod-a 一致），
 * 源码模式选源码 textarea 全文。无活动文档时空操作。
 */
function selectAllActive(): void {
  const tab = activeMarkdownTab();
  if (tab === null) return;
  const sourceView = sourceViews.get(tab.id);
  if (sourceView !== undefined && sourceView.isSourceMode) {
    sourceView.selectAll();
    return;
  }
  tab.editor.selectAll();
}

// ---------------------------------------------------------------------------
// T4/R2：查找与替换壳层。面板本身不感知模式；这里按活动标签的当前模式分派：
//   WYSIWYG → find-replace 插件（decoration 高亮全部/当前命中；替换为单个
//     ProseMirror 事务，可经既有 undo 一次回到替换前）；
//   源码模式 → 直接操作源码 textarea（原生 selection + execCommand('insertText')
//     替换以保留原生 undo，不用 setRangeText；input 事件经 source-view 既有
//     refreshFromTextarea 同步回文档）。
// ---------------------------------------------------------------------------

let findPanel: FindReplacePanel | null = null;
/** 源码模式当前命中下标（WYSIWYG 的当前项由插件状态维护）。 */
let sourceFindActive = -1;

function findPanelLabels(): FindReplaceLabels {
  const zh = i18n.locale !== 'en';
  return {
    findPlaceholder: zh ? '查找' : 'Find',
    replacePlaceholder: zh ? '替换为' : 'Replace with',
    prev: zh ? '上一处' : 'Prev',
    next: zh ? '下一处' : 'Next',
    replace: zh ? '替换' : 'Replace',
    replaceAll: zh ? '全部替换' : 'Replace All',
    close: zh ? '关闭' : 'Close',
    empty: zh ? '无匹配' : 'No matches',
    count: (active, total) => `${String(active + 1)}/${String(total)}`,
  };
}

/** 活动标签处于源码模式时返回其源码 textarea；否则 null（走 WYSIWYG 路径）。 */
function activeSourceTextarea(): HTMLTextAreaElement | null {
  const tab = manager?.activeTab ?? null;
  if (tab === null) return null;
  const view = sourceViews.get(tab.id);
  if (view === undefined || !view.isSourceMode) return null;
  return tab.hostElement.querySelector<HTMLTextAreaElement>('textarea.lightink-source-editor');
}

/** 活动标签的 WYSIWYG EditorView（源码模式/无活动标签/未就绪时 null）。 */
function activeFindView(): ReturnType<typeof findReplaceViewForHost> {
  const tab = manager?.activeTab ?? null;
  if (tab === null || activeSourceTextarea() !== null) return null;
  return findReplaceViewForHost(tab.hostElement);
}

/** 只接线一次：查找状态 → 壳层刷新。 */
let contentObserversWired = false;

/**
 * 查找状态的全局观察者。文档变更由编辑器实例级回调直接绑定到所属标签。
 * 必须在应用启动时调用（不要等用户打开查找面板），否则字数栏与 1/N 不会动。
 * 注意：声明必须在调用点之前（避免 TDZ：contentObserversWired 未初始化就访问）。
 */
function wireEditorContentObservers(): void {
  if (contentObserversWired) return;
  contentObserversWired = true;

  // 查找插件状态变化（含 docChanged 后重收命中）：直接写面板计数。
  subscribeFindReplaceStatus((view, status) => {
    if (findPanel === null || !findPanel.isOpen()) return;
    const tab = manager?.activeTab ?? null;
    if (tab === null) return;
    if (activeSourceTextarea() !== null) return;
    const activeView = findReplaceViewForHost(tab.hostElement);
    if (activeView !== null && activeView !== view) return;
    if (activeView === null && !tab.hostElement.contains(view.dom)) return;
    if (findPanel.getQuery() === '' && status.query === '') {
      syncFindPanelStatus(0, -1);
      return;
    }
    if (status.query !== findPanel.getQuery() && findPanel.getQuery() !== '') {
      return;
    }
    syncFindPanelStatus(status.total, status.active);
  });
}

// 启动即挂上 WYSIWYG 文档/查找状态订阅（不依赖用户先打开查找面板）。
// 必须放在 contentObserversWired / findPanel 声明之后，否则会 TDZ 崩掉整页。
wireEditorContentObservers();

function ensureFindPanel(): FindReplacePanel {
  if (findPanel !== null) return findPanel;
  findPanel = createFindReplacePanel(document, findPanelLabels(), {
    onQueryChange: (query) => runFindQuery(query),
    onNext: () => stepFind(1),
    onPrev: () => stepFind(-1),
    onReplace: (replacement) => runReplaceCurrent(replacement),
    onReplaceAll: (replacement) => runReplaceAll(replacement),
    onClose: () => clearFindHighlights(),
  });
  // 挂到 #lightink-main（非滚动容器）而非 editor-area：上一处/下一处滚动
  // 命中时面板保持在视口右上，不会被卷出屏幕。
  const main = document.getElementById('lightink-main');
  (main ?? shell.editorArea).appendChild(findPanel.element);
  return findPanel;
}

function syncFindPanelStatus(total: number, active: number): void {
  findPanel?.setStatus(total, active);
}

/**
 * 源码模式：选中命中并滚动到可见。
 * 用 mirror 测量命中纵向位置（pre-wrap 下按硬换行 × 行高会偏，上一处/下一处
 * 都可能滚到错误行）。
 */
function selectSourceMatch(
  ta: HTMLTextAreaElement,
  match: { start: number; end: number },
): void {
  ta.focus();
  ta.setSelectionRange(match.start, match.end);
  scrollTextareaMatchIntoView(ta, match.start);
}

/**
 * 按命中字符偏移把源码命中滚到可见区（中部偏上）。
 * 源码表面与 WYSIWYG 共用 #lightink-editor-area 滚动；不再滚 textarea 自身。
 */
function scrollTextareaMatchIntoView(ta: HTMLTextAreaElement, offset: number): void {
  const style = window.getComputedStyle(ta);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  const mirrorStyle = mirror.style;
  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.wordBreak = style.wordBreak || 'break-word';
  mirrorStyle.overflowWrap = style.overflowWrap || 'break-word';
  mirrorStyle.font = style.font;
  mirrorStyle.fontFamily = style.fontFamily;
  mirrorStyle.fontSize = style.fontSize;
  mirrorStyle.fontWeight = style.fontWeight;
  mirrorStyle.fontStyle = style.fontStyle;
  mirrorStyle.letterSpacing = style.letterSpacing;
  mirrorStyle.lineHeight = style.lineHeight;
  mirrorStyle.tabSize = style.tabSize;
  mirrorStyle.boxSizing = style.boxSizing;
  mirrorStyle.padding = style.padding;
  mirrorStyle.border = style.border;
  mirrorStyle.width = `${ta.clientWidth}px`;
  // 末尾放 marker 测偏移高度。
  const before = ta.value.slice(0, Math.max(0, Math.min(offset, ta.value.length)));
  mirror.textContent = before;
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const topInTextarea = marker.offsetTop;
  mirror.remove();

  const scroller =
    ta.ownerDocument.getElementById('lightink-editor-area') ??
    findNearestScrollContainer(ta);
  if (scroller === null) {
    // 无外层滚动容器时回落：尽量滚 textarea 自身（测试/无壳层环境）。
    const viewH = ta.clientHeight;
    const desired = Math.max(0, topInTextarea - Math.min(viewH * 0.35, 3 * lineHeight));
    const maxScroll = Math.max(0, ta.scrollHeight - viewH);
    ta.scrollTop = Math.min(desired, maxScroll);
    return;
  }

  // textarea 相对滚动容器的文档偏移 + 命中在 textarea 内的偏移。
  const taRect = ta.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  const absoluteTop = scroller.scrollTop + (taRect.top - scRect.top) + topInTextarea;
  const viewH = scroller.clientHeight;
  const desired = Math.max(0, absoluteTop - Math.min(viewH * 0.35, 3 * lineHeight));
  const maxScroll = Math.max(0, scroller.scrollHeight - viewH);
  scroller.scrollTop = Math.min(desired, maxScroll);
}

/** 最近 overflow 可滚祖先（源码查找滚动回落）。 */
function findNearestScrollContainer(fromEl: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = fromEl.parentElement;
  while (el !== null && el !== fromEl.ownerDocument.body) {
    const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
    const oy = computed?.overflowY ?? '';
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function runFindQuery(query: string): void {
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    sourceFindActive = matches.length > 0 ? 0 : -1;
    const first = matches[0];
    if (first !== undefined) selectSourceMatch(ta, first);
    syncFindPanelStatus(matches.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) {
    syncFindPanelStatus(0, -1);
    return;
  }
  setFindQuery(view, query);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

/**
 * 文档内容变化后刷新查找面板状态（不重置当前命中、不强制滚动）。
 * 由 TabManager.onActiveContentChanged 驱动：用户编辑时 1/N 计数与高亮保持同步。
 */
function refreshFindOnContentChange(): void {
  if (findPanel === null || !findPanel.isOpen()) return;
  const query = findPanel.getQuery();
  if (query === '') {
    syncFindPanelStatus(0, -1);
    return;
  }
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    if (matches.length === 0) {
      sourceFindActive = -1;
      syncFindPanelStatus(0, -1);
      return;
    }
    // 保持当前下标；越界则夹到末项（内容删减后常见）。
    if (sourceFindActive < 0) {
      sourceFindActive = 0;
    } else if (sourceFindActive >= matches.length) {
      sourceFindActive = matches.length - 1;
    }
    syncFindPanelStatus(matches.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) {
    syncFindPanelStatus(0, -1);
    return;
  }
  // WYSIWYG：find-replace 插件在 docChanged 时已重收 matches/decorations，
  // 这里只把最新 total/active 写回面板。
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function stepFind(dir: 1 | -1): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    if (matches.length === 0) {
      sourceFindActive = -1;
      syncFindPanelStatus(0, -1);
      return;
    }
    // 与 WYSIWYG nextMatchIndex 同口径：active=-1 时 prev→末、next→首。
    sourceFindActive = nextMatchIndex(matches.length, sourceFindActive, dir);
    const match = matches[sourceFindActive];
    if (match !== undefined) selectSourceMatch(ta, match);
    syncFindPanelStatus(matches.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  stepFindMatch(view, dir);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

/**
 * 源码模式替换一处：选中命中后 execCommand('insertText')（保留原生 undo）；
 * insertText 触发 input 事件 → source-view 既有同步回文档。execCommand 不可用
 * 的环境回退 setRangeText + 手工 input 事件（功能正确，undo 粒度退化）。
 */
function replaceSourceRange(
  ta: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
): void {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function runReplaceCurrent(replacement: string): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    const match = matches[Math.min(Math.max(sourceFindActive, 0), matches.length - 1)];
    if (match === undefined) {
      syncFindPanelStatus(0, -1);
      return;
    }
    replaceSourceRange(ta, match.start, match.end, replacement);
    // 替换后命中重收：原下标处即下一未替换命中（收敛到范围内）。
    const next = collectSourceMatches(ta.value, query);
    sourceFindActive =
      next.length === 0
        ? -1
        : Math.min(Math.max(sourceFindActive, 0), next.length - 1);
    const current = next[sourceFindActive];
    if (current !== undefined) selectSourceMatch(ta, current);
    syncFindPanelStatus(next.length, sourceFindActive);
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  replaceCurrentMatch(view, replacement);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function runReplaceAll(replacement: string): void {
  const query = findPanel?.getQuery() ?? '';
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const matches = collectSourceMatches(ta.value, query);
    // 自后向前替换，位置不被前序替换带偏；每次 insertText 均为原生可撤销步。
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const match = matches[i];
      if (match !== undefined) replaceSourceRange(ta, match.start, match.end, replacement);
    }
    sourceFindActive = -1;
    syncFindPanelStatus(collectSourceMatches(ta.value, query).length, -1);
    return;
  }
  const view = activeFindView();
  if (view === null) return;
  replaceAllMatches(view, replacement);
  const state = readFindReplaceState(view);
  syncFindPanelStatus(state?.total ?? 0, state?.active ?? -1);
}

function clearFindHighlights(): void {
  sourceFindActive = -1;
  const view = activeFindView();
  if (view !== null) clearFindReplace(view);
}

/**
 * 打开查找时若编辑器有非空选区，预填到查找框（常见编辑器惯例）。
 * 多行选区只取首行；过长截断，避免把整段粘进输入框。
 */
function selectionForFindSeed(): string {
  const ta = activeSourceTextarea();
  if (ta !== null) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (end > start) {
      return sanitizeFindSeed(ta.value.slice(start, end));
    }
    return '';
  }
  const view = activeFindView();
  if (view === null) return '';
  const { from, to } = view.state.selection;
  if (to <= from) return '';
  try {
    return sanitizeFindSeed(view.state.doc.textBetween(from, to, '\n', '\n'));
  } catch {
    return '';
  }
}

function sanitizeFindSeed(raw: string): string {
  // 只取首行：跨段选区通常不是用户想搜的「词」。
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed === '') return '';
  // 输入框宽度有限，超长选区截断。
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

/** 编辑菜单「查找…」/ Ctrl+F：打开面板；有选区则预填，再应用到活动标签。 */
function openFindPanel(): void {
  const tab = manager?.activeTab ?? null;
  if (tab === null) return;
  const panel = ensureFindPanel();
  const seed = selectionForFindSeed();
  if (seed !== '') {
    panel.setQuery(seed);
  }
  panel.open();
  runFindQuery(panel.getQuery());
}

// Ctrl+F/Cmd+F 打开查找面板：捕获阶段接线，优先于 WebView/编辑器默认行为
//（shortcuts.ts 注册表属后续任务 scope，此处在 main.ts 独立监听）。
document.addEventListener(
  'keydown',
  (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      // reader 标签活动时打开阅读器搜索面板，编辑标签走原查找面板。
      const readerTab = activeReaderTab();
      if (readerTab !== null) {
        readerTab.reader.openSearch?.(window.getSelection()?.toString());
        return;
      }
      openFindPanel();
    }
  },
  true,
);


// 快捷键：捕获阶段注册，保存等操作在编辑器内同样生效。
const shortcuts = new ShortcutRegistry({
  new: () => void manager.newTab(),
  open: () => void manager.openFile(),
  // T6/R9：编辑器关闭活动标签，复用 closeTab 的未保存确认（与点标签关闭按钮
  // 同路径：先提交源码态编辑，再 closeTab）。阅读器态：无打开书时空操作；
  // 有打开书时与合书一样只回书架。注：WebView2 可能由外壳吞掉 Ctrl+W。
  'close-tab': () => {
    if (workspace.mode === 'reader') {
      if (workspace.hasOpenBook) {
        workspace.returnToShelf();
      }
      return;
    }
    const id = manager.activeTabId;
    if (id !== null) {
      commitSourceMode(id);
      void manager.closeTab(id);
    }
  },
  save: () => {
    commitActiveSourceMode();
    void manager.saveActiveTab();
  },
  'save-as': () => {
    commitActiveSourceMode();
    void saveActiveAs();
  },
  'toggle-theme': () => {
    themeService.toggle();
  },
  // R5：插入链接/图片、大纲显隐（源码模式 Ctrl+/ 由 T7 注册）。
  'insert-link': () => insertElement('link'),
  'insert-image': () => insertElement('image'),
  'toggle-outline': () => outline.toggleCollapse(),
  'toggle-source-mode': () => toggleActiveSourceMode(),
  'toggle-menu-chrome': () => shell.toggleMenuChrome(),
  'toggle-tabs-chrome': () => shell.toggleTabsChrome(),
  'toggle-chrome-pin': () => {
    toggleChromePinnedWithOutline();
  },
  'toggle-fullscreen': () => {
    void enterOrExitFullscreen();
  },
  'next-tab': () => cycleActiveTab(1),
  'prev-tab': () => cycleActiveTab(-1),
  'zoom-in': () => {
    changeReadingScale('in');
  },
  'zoom-out': () => {
    changeReadingScale('out');
  },
  'zoom-reset': () => {
    changeReadingScale('reset');
  },
  'toggle-reading-layout': () => toggleReadingLayoutMode(),
});
shortcuts.attach(document);

// Reader-owned Escape: overlay handlers preventDefault first; leftover Escape
// on an open book returns to the shelf. Shelf Escape is a no-op.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return;
  }
  if (workspace.mode !== 'reader') {
    return;
  }
  if (workspace.hasOpenBook) {
    workspace.returnToShelf();
    event.preventDefault();
  }
});

const gateMarkdownPagedWheel = createPagedWheelGate();

function advanceMarkdownReading(direction: 1 | -1): boolean {
  return readingLayout === 'paginated'
    ? advancePagedScroller(editorScroller, direction)
    : advanceScrolledScroller(editorScroller, direction);
}

document.addEventListener(
  'keydown',
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !isReadingNavKey(event.key)) {
      return;
    }
    // 打开应用模态，或焦点在输入框/可编辑内容（正文 contenteditable、源码 textarea、
    // 输入框）时不劫持翻页键：isReadingNavKey 含 Space 与方向键，放进翻页链会让
    // 正文输入/光标移动被劫持成翻页。
    if (pagingShouldIgnoreTarget(event.target)) {
      return;
    }
    const direction = readingNavDirection(event.key, event.shiftKey);
    if (direction === null) {
      return;
    }
    const readerTab = activeReaderTab();
    if (readerTab !== null) {
      if (readerTab.reader.advanceReading(direction)) {
        event.preventDefault();
      }
      return;
    }
    const tab = activeMarkdownTab();
    if (tab === null) {
      return;
    }
    if (advanceMarkdownReading(direction)) {
      event.preventDefault();
    }
  },
  true,
);

// R1：滚轮翻页提升到 window 级——窗口内任意位置（含正文、大纲侧栏、顶部菜单/标签
// chrome 与空白区）滚动滚轮均按分页模式翻页正文；仅目标为表单控件（输入框/源码
// textarea/select）或打开模态时早退、不劫持其自身滚动与文本输入。正文 contenteditable
// 是翻页面而非被排除对象（R1 验收：悬停大纲侧栏滚轮 → 正文翻页）。
window.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey || readingLayout !== 'paginated') {
      return;
    }
    if (wheelPagingShouldIgnoreTarget(event.target)) {
      return;
    }
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) {
      return;
    }
    const readerTab = activeReaderTab();
    if (readerTab !== null) {
      // PDF/CBZ 连续滚动仍走页宿主自身；只对流式分页劫持窗口滚轮。
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('.lightink-reader-pages') !== null
      ) {
        return;
      }
      event.preventDefault();
      gateMarkdownPagedWheel(delta > 0 ? 1 : -1, (dir) =>
        readerTab.reader.advanceReading(dir),
      );
      return;
    }
    if (activeMarkdownTab() === null) {
      return;
    }
    event.preventDefault();
    gateMarkdownPagedWheel(delta > 0 ? 1 : -1, advanceMarkdownReading);
  },
  { passive: false },
);

// T8/R3：右键上下文菜单（编辑区 + 标签页）。
function showEditorContextMenu(x: number, y: number): void {
  const tab = activeMarkdownTab();
  if (tab === null) return; // reader 标签不弹编辑器右键菜单（T3 阅读视图自理）
  const sourceView = sourceViews.get(tab.id);
  const inSource = sourceView !== undefined && sourceView.isSourceMode;
  // 源码态下选区/链接以源码 textarea 为准（WYSIWYG 编辑器被覆盖层遮住）。
  const sel = tab.editor.getSelection();
  const hasSelection = inSource
    ? sourceView?.hasTextSelection() === true
    : sel !== null && !sel.empty;
  const link = inSource ? null : tab.editor.getLinkAtPoint(x, y);
  const hasLink = link !== null;
  const inTable = !inSource && tab.editor.isInTable();
  const items = buildEditorContextMenuItems(
    {
      hasSelection,
      hasLink,
      inSourceMode: inSource,
      inTable,
      t: (key) => i18n.t(key),
      formatShortcut: (combo) => formatShortcutLabel(combo, isMac),
    },
    {
      cut: () => runClipboardCommand('cut'),
      copy: () => runClipboardCommand('copy'),
      paste: () => runClipboardCommand('paste'),
      pastePlain: () => runClipboardCommand('paste'),
      selectAll: () => selectAllActive(),
      bold: () => tab.editor.toggleMark('strong'),
      italic: () => tab.editor.toggleMark('emphasis'),
      link: () => {
        void (async () => {
          const cursorLink = tab.editor.getLinkAtCursor() ?? link;
          const result = await showLinkDialog(document, {
            title:
              cursorLink !== null ? i18n.t('dialog.link.edit') : i18n.t('dialog.link.add'),
            initialText: cursorLink?.text ?? '',
            initialHref: cursorLink?.href ?? '',
            confirmLabel: i18n.t('dialog.link.apply'),
            labels: {
              text: i18n.t('dialog.link.textLabel'),
              textPlaceholder: i18n.t('dialog.link.textPlaceholder'),
              href: i18n.t('dialog.link.hrefLabel'),
              hrefPlaceholder: i18n.t('dialog.link.hrefPlaceholder'),
              cancel: i18n.t('dialog.cancel'),
            },
          });
          if (result !== null) {
            tab.editor.setLink(result.href, result.text);
          }
        })();
      },
      openLink: () => {
        // Right-click open: still confirm, then same classify path as Ctrl+click.
        if (link === null) return;
        void showOpenLinkConfirm(document, link.href, {
          title: i18n.t('dialog.link.openTitle'),
          message: i18n.t('dialog.link.openMessage'),
          openLabel: i18n.t('dialog.open'),
          cancelLabel: i18n.t('dialog.cancel'),
        }).then((ok) => {
          if (ok) handleLinkNavigation(link.href);
        });
      },
      copyLinkAddress: () => {
        if (link !== null) void navigator.clipboard?.writeText(link.href);
      },
      insertColLeft: () => {
        tab.editor.runTableOp('insert-col-left');
      },
      insertColRight: () => {
        tab.editor.runTableOp('insert-col-right');
      },
      insertRowAbove: () => {
        tab.editor.runTableOp('insert-row-above');
      },
      insertRowBelow: () => {
        tab.editor.runTableOp('insert-row-below');
      },
      deleteRow: () => {
        tab.editor.runTableOp('delete-row');
      },
      deleteColumn: () => {
        tab.editor.runTableOp('delete-column');
      },
      selectRow: () => {
        tab.editor.runTableOp('select-row');
      },
      selectColumn: () => {
        tab.editor.runTableOp('select-column');
      },
      deleteTable: () => {
        tab.editor.runTableOp('delete-table');
      },
    },
  );
  createContextMenu(items, { x, y });
}

function showTabContextMenu(tabId: string, x: number, y: number): void {
  const tab = manager.tabList.find((t) => t.id === tabId) ?? null;
  const hasFile = tab !== null && tab.filePath !== null;
  const items = buildTabContextMenuItems(
    { hasFile, t: (key) => i18n.t(key) },
    {
      close: () => {
        commitSourceMode(tabId);
        void manager.closeTab(tabId);
      },
      closeOthers: () => {
        void (async () => {
          for (const other of [...manager.tabList]) {
            if (other.id === tabId) continue;
            commitSourceMode(other.id);
            if (!(await manager.closeTab(other.id))) break;
          }
        })();
      },
      copyPath: () => {
        if (tab?.filePath !== null && tab?.filePath !== undefined) {
          void navigator.clipboard?.writeText(tab.filePath);
        }
      },
      revealInFiles: () => {
        // 「在文件管理器中显示」走 opener reveal_path_in_files（lib.rs 已注册，与 R14 链接
        // 分类的 opener 能力同源）。能力未注册时忽略，避免阻塞右键菜单。
        const path = tab?.filePath;
        if (path === null || path === undefined) return;
        void invoke('reveal_path_in_files', { path }).catch(() => undefined);
      },
  });
  // Keep tabs chrome open while the menu is up; release on every close path.
  shell.setTabsHold(true);
  createContextMenu(items, { x, y }, document, {
    onClose: () => shell.setTabsHold(false),
  });
}

shell.editorArea.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showEditorContextMenu(event.clientX, event.clientY);
});
shell.tabBar.addEventListener('contextmenu', (event) => {
  const target = event.target;
  const btn = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-tab-id]') : null;
  if (btn === null || btn.dataset.tabId === undefined) return;
  event.preventDefault();
  showTabContextMenu(btn.dataset.tabId, event.clientX, event.clientY);
});

/** 快捷键速查表数据源（R5）：从注册表派生标签→组合键（随语言/平台）。 */
function getShortcutBindings(): CheatBinding[] {
  return shortcuts.entries().map(({ action, combo }) => ({
    label: i18n.t(`shortcut.${action}`),
    shortcut: formatShortcutLabel(combo, isMac),
  }));
}

/** Protect native title-bar, system-menu, and shortcut initiated application exits. */
function installApplicationCloseProtection(): void {
  installWindowCloseProtection({
    window,
    isNative: '__TAURI_INTERNALS__' in window,
    getNativeWindow: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      return getCurrentWindow();
    },
    hasUnsavedChanges: () => {
      commitAllSourceModes();
      return manager.tabList.some((tab) => tab.kind === 'markdown' && tab.dirty);
    },
    confirmExit: () => {
      const titles = manager.tabList
        .filter((tab) => tab.kind === 'markdown' && tab.dirty)
        .map((tab) => tab.title);
      return showExitConfirmation(document, titles, {
        title: i18n.t('dialog.exit.title'),
        message: (documents) => i18n.t('dialog.exit.message', { documents }),
        saveAll: i18n.t('dialog.exit.saveAll'),
        discardAll: i18n.t('dialog.exit.discardAll'),
        cancel: i18n.t('dialog.cancel'),
      });
    },
    closeAllTabs: (action) => manager.closeAllTabs(action),
    flushDirtySnapshots: () => manager.flushDirtySnapshots(),
    shutdown,
    reportError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[lightink/window-close] close protection failed', error);
    },
  });
}

/** 关闭窗口前释放 app 生命周期资源（外部变更轮询、自动保存、启动监听器）。 */
let didShutdown = false;
function shutdown(): void {
  if (didShutdown) return;
  didShutdown = true;
  if (externalChangeTimer !== null) {
    clearInterval(externalChangeTimer);
    externalChangeTimer = null;
  }
  autosave?.dispose();
  applicationStateSync?.dispose();
  displayScale.dispose();
  wheelZoom.dispose();
}

installApplicationCloseProtection();

// R13：外部文件变更检测——窗口聚焦 + 定时（秒级）轮询活动文件 stat/指纹。
// 检测逻辑与冲突/重载分派在 TabManager（可注入测试），这里只做时机触发。
async function pollExternalChange(): Promise<void> {
  try {
    await manager.checkActiveExternalChange();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[lightink/external-change] check failed', error);
  }
}
window.addEventListener('focus', () => {
  void pollExternalChange();
});
// 秒级轮询兜底（聚焦间隙的外部修改）；弹窗进行中由 TabManager 自身守卫跳过。
externalChangeTimer = window.setInterval(() => {
  void pollExternalChange();
}, 3000);
// Tauri 窗口聚焦事件比 DOM focus 更可靠地覆盖「从其它应用切回」的场景。
void (async () => {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) void pollExternalChange();
    });
  } catch {
    // 非 Tauri（纯前端 dev）：仅依赖 DOM focus + 定时轮询。
  }
})();

async function bootstrap(): Promise<void> {
  // 先恢复崩溃遗留的未命名草稿（其副作用：为每个恢复草稿开标签）。
  await recoverAvailableDrafts();
  // R1：先注册单实例 open-file 监听，再取首实例 pending——监听就绪前到达的第二实例
  // 文件由随后的初始 take_pending_file 抽干槽兜底，避免启动竞态内事件被孤立。
  // Runtime association/second-instance opens restore the window and notify;
  // the cold-start take below does not add a success toast.
  let externalOpenOrigin: ExternalOpenOrigin = 'cold-start';
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('open-file', () => {
      void invoke<string | null>('take_pending_file')
        .then((path) => {
          if (path !== null) {
            void openExternalAssociationPath(path, externalOpenOrigin);
          }
        })
        .catch(() => undefined);
    });
    // OS 文件拖入窗口：.md 开标签 / 图片插入 / 其他提示（dragDropEnabled 默认开启，
    // Tauri 把 OS 拖拽拦截为本事件，HTML5 drop 收不到 OS 文件）。
    await listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
      void handleOsFileDrop(event.payload.paths);
    });
  } catch {
    // 非 Tauri 环境（纯前端 dev）：无单实例/拖拽事件，忽略。
  }
  // R1：取出启动/关联文件（首实例 argv 经后端 take_pending_file；命令未就绪时静默）。
  const pendingFile = await invoke<string | null>('take_pending_file').catch(() => null);
  if (pendingFile !== null) {
    await openExternalAssociationPath(pendingFile, 'cold-start');
  }
  externalOpenOrigin = 'runtime';
  // 无标签（无恢复草稿、无启动文件）则新建欢迎标签。
  if (manager.tabList.length === 0) {
    await manager.newTab(i18n.t('welcome.body'));
  }
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[lightink] bootstrap failed:', err);
});
