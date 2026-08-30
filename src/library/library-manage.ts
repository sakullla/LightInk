/**
 * Manage page (管理): a grouped settings page — appearance / reading
 * preferences / storage & cache / sync / other — with a cache-limit
 * dialog instead of a second page.
 *
 * Owns the manage DOM and the dialog state machine (`home | cache-limit`).
 * The dialog follows overlay Escape semantics: while it is open, a
 * (synthetic) Escape — including the Android back key dispatched through
 * ui/back-navigation.ts — is consumed to close it; on the manage home
 * nothing is consumed and the press falls through.
 */

import type { LibraryClient } from './library-client.js';
import {
  applyLibraryTheme,
  LIBRARY_THEMES,
  loadLibraryTheme,
  mountLibraryOverlay,
  saveLibraryTheme,
  type LibraryThemeId,
  type LibraryThemeStorage,
} from './library-theme.js';
import {
  READER_PREFS_STORAGE_KEY,
  applyReaderPrefs,
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderPrefsStorage,
} from '../reader/reader-prefs.js';

export type ManageSubpage = 'home' | 'cache-limit';

export interface LibraryManageLabels {
  readonly appearance: string;
  readonly libraryTheme: string;
  readonly libraryThemeHint: string;
  readonly readingGroup: string;
  readonly readerPrefsHint: string;
  readonly showProgressBar: string;
  readonly storageGroup: string;
  readonly clearCache: string;
  readonly cacheUsage: string;
  readonly cacheLimit: string;
  readonly changeCacheLimit: string;
  readonly apply: string;
  readonly cancel: string;
  readonly syncGroup: string;
  readonly webdavSync: string;
  readonly otherGroup: string;
  readonly importLocal: string;
  readonly markdownEditor: string;
}

export interface LibraryManageOptions {
  readonly labels: () => LibraryManageLabels;
  readonly themeLabel: (id: LibraryThemeId) => string;
  /** Library root element: shelf theme tokens are applied here. */
  readonly themeRoot: HTMLElement;
  readonly themeStorage?: LibraryThemeStorage | null;
  readonly readerPrefsStorage?: ReaderPrefsStorage | null;
  readonly library: Pick<LibraryClient, 'clearCache' | 'setCacheLimit' | 'cacheStats'>;
  readonly notify: (message: string, kind?: 'error' | 'warning') => void;
  readonly formatError: (error: unknown) => string;
  /** Import a local book; the host view owns post-import navigation. */
  readonly onImport: () => Promise<void>;
  readonly onOpenSyncPanel?: () => void;
  /** Desktop-only entry; the row is suppressed when absent. */
  readonly onEnterEditor?: () => void;
}

export interface LibraryManageView {
  readonly element: HTMLElement;
  /** Close the cache-limit dialog and stay on the manage home. */
  showHome(): void;
  /** Overlay Escape semantics: closes the open dialog; true when consumed. */
  handleEscape(): boolean;
  refreshCache(): Promise<void>;
  retranslate(): void;
  destroy(): void;
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

/**
 * Consume --lightink-keyboard-inset (written by safe-area.ts). Inset 0 keeps the
 * layer closable. Single deduction (reader-chrome-panels.ts pinFixedOverlay
 * paradigm): the overlay bottom offset is the only keyboard-inset consumer; on
 * touch the dialog height budget — keyboard-open anchor included — is owned by
 * the touch rules in library.css, so the inset is never subtracted from both
 * the bottom offset and max-height.
 */
function applyCacheLimitKeyboardInset(overlay: HTMLElement, dialog: HTMLElement): void {
  overlay.style.paddingBottom = 'var(--lightink-keyboard-inset, 0px)';
  const root = overlay.ownerDocument.documentElement;
  const touch = root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary');
  // 桌面保留既有高度上限（keyboard-inset 恒为 0，与改版前等价）。
  if (!touch) {
    dialog.style.maxHeight = 'calc(100dvh - 24px)';
  }
}

function button(doc: Document, text: string, className = ''): HTMLButtonElement {
  const el = doc.createElement('button');
  el.type = 'button';
  if (className !== '') el.className = className;
  el.textContent = text;
  return el;
}

export function createLibraryManage(
  doc: Document,
  options: LibraryManageOptions,
): LibraryManageView {
  const labels = options.labels;
  let currentLibraryTheme = loadLibraryTheme(options.themeStorage);
  let currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
  applyReaderPrefs(doc.documentElement, currentReaderPrefs);
  let subpage: ManageSubpage = 'home';

  const element = doc.createElement('div');
  element.className = 'lightink-library-manage-panel';
  element.dataset.managePage = subpage;

  const home = doc.createElement('div');
  home.className = 'lightink-library-manage-home';

  // 外观：书架主题色板，内联。
  const appearance = doc.createElement('section');
  appearance.className = 'lightink-library-manage-group lightink-library-appearance';
  appearance.dataset.manageGroup = 'appearance';
  const appearanceTitle = doc.createElement('h2');
  appearanceTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const appearanceHint = doc.createElement('p');
  appearanceHint.className = 'lightink-library-appearance-hint';
  const themeSwatches = doc.createElement('div');
  themeSwatches.className = 'lightink-library-theme-swatches';
  themeSwatches.setAttribute('role', 'radiogroup');
  appearance.append(appearanceTitle, appearanceHint, themeSwatches);

  // 阅读偏好：阅读器进度条开关，内联。
  const readerPrefs = doc.createElement('section');
  readerPrefs.className = 'lightink-library-manage-group lightink-library-reader-prefs';
  readerPrefs.dataset.manageGroup = 'reading';
  const readerPrefsTitle = doc.createElement('h2');
  readerPrefsTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const readerPrefsHint = doc.createElement('p');
  readerPrefsHint.className = 'lightink-library-appearance-hint';
  const progressBarLabel = doc.createElement('label');
  progressBarLabel.className = 'lightink-library-reader-pref';
  const progressBarInput = doc.createElement('input');
  progressBarInput.type = 'checkbox';
  progressBarInput.name = 'showProgressBar';
  const progressBarText = doc.createElement('span');
  progressBarLabel.append(progressBarInput, progressBarText);
  readerPrefs.append(readerPrefsTitle, readerPrefsHint, progressBarLabel);

  // 存储与缓存：用量摘要 + 清理缓存 + 缓存上限（弹层入口）。
  const storage = doc.createElement('section');
  storage.className = 'lightink-library-manage-group';
  storage.dataset.manageGroup = 'storage';
  const storageTitle = doc.createElement('h2');
  storageTitle.className = 'lightink-library-manage-group-title';
  const cacheSummary = doc.createElement('div');
  cacheSummary.className = 'lightink-library-cache-summary';
  cacheSummary.hidden = true;
  const cacheUsage = doc.createElement('span');
  cacheSummary.append(cacheUsage);
  const clearCacheButton = button(doc, '', 'lightink-library-manage-row');
  const cacheLimitButton = button(
    doc,
    '',
    'lightink-library-manage-row lightink-library-cache-limit-entry',
  );
  storage.append(storageTitle, cacheSummary, clearCacheButton, cacheLimitButton);

  // 同步：WebDAV 同步入口（deps 缺省时整组抑制）。
  let sync: HTMLElement | null = null;
  let syncButton: HTMLButtonElement | null = null;
  let syncTitle: HTMLHeadingElement | null = null;
  if (options.onOpenSyncPanel !== undefined) {
    sync = doc.createElement('section');
    sync.className = 'lightink-library-manage-group';
    sync.dataset.manageGroup = 'sync';
    syncTitle = doc.createElement('h2');
    syncTitle.className = 'lightink-library-manage-group-title';
    syncButton = button(doc, '', 'lightink-library-manage-row lightink-library-sync-entry');
    sync.append(syncTitle, syncButton);
  }

  // 其他：导入本地书籍 + 编辑器入口（仅桌面，deps 缺省抑制）。
  const other = doc.createElement('section');
  other.className = 'lightink-library-manage-group';
  other.dataset.manageGroup = 'other';
  const otherTitle = doc.createElement('h2');
  otherTitle.className = 'lightink-library-manage-group-title';
  const importButton = button(doc, '', 'lightink-library-manage-row lightink-library-import-entry');
  other.append(otherTitle, importButton);
  let editorButton: HTMLButtonElement | null = null;
  if (options.onEnterEditor !== undefined) {
    editorButton = button(doc, '', 'lightink-library-manage-row lightink-library-editor-entry');
    other.append(editorButton);
  }

  home.append(appearance, readerPrefs, storage, ...(sync === null ? [] : [sync]), other);
  element.append(home);

  const cacheLimitOverlay = doc.createElement('div');
  cacheLimitOverlay.className = 'lightink-modal-overlay lightink-library-cache-limit-modal';
  cacheLimitOverlay.hidden = true;
  const cacheLimitDialog = doc.createElement('div');
  cacheLimitDialog.className = 'lightink-modal-dialog';
  cacheLimitDialog.setAttribute('role', 'dialog');
  cacheLimitDialog.setAttribute('aria-modal', 'true');
  cacheLimitDialog.setAttribute('aria-labelledby', 'lightink-library-cache-limit-title');
  const cacheLimitTitle = doc.createElement('h2');
  cacheLimitTitle.id = 'lightink-library-cache-limit-title';
  cacheLimitTitle.className = 'lightink-library-cache-limit-title';
  const cacheLimitForm = doc.createElement('form');
  cacheLimitForm.className = 'lightink-library-cache-limit-form';
  const cacheLimitLabel = doc.createElement('label');
  cacheLimitLabel.className = 'lightink-library-field';
  const cacheLimitLabelText = doc.createElement('span');
  const cacheLimitInput = doc.createElement('input');
  cacheLimitInput.type = 'number';
  cacheLimitInput.name = 'cacheLimitGiB';
  cacheLimitInput.min = '0.25';
  cacheLimitInput.max = '1024';
  cacheLimitInput.step = '0.25';
  cacheLimitInput.required = true;
  cacheLimitLabel.append(cacheLimitLabelText, cacheLimitInput);
  const cacheLimitActions = doc.createElement('div');
  cacheLimitActions.className = 'lightink-library-cache-limit-actions';
  const cacheLimitSave = button(doc, '', 'lightink-library-primary');
  cacheLimitSave.type = 'submit';
  const cacheLimitCancel = button(doc, '', 'lightink-library-cache-limit-cancel');
  cacheLimitActions.append(cacheLimitSave, cacheLimitCancel);
  cacheLimitForm.append(cacheLimitLabel, cacheLimitActions);
  cacheLimitDialog.append(cacheLimitTitle, cacheLimitForm);
  cacheLimitOverlay.append(cacheLimitDialog);
  applyCacheLimitKeyboardInset(cacheLimitOverlay, cacheLimitDialog);

  let ignoreCacheBackdrop = true;

  function setSubpage(next: ManageSubpage): void {
    subpage = next;
    element.dataset.managePage = next;
    cacheLimitOverlay.hidden = next === 'home';
    if (next === 'cache-limit') {
      ignoreCacheBackdrop = true;
      mountLibraryOverlay(cacheLimitOverlay, options.themeRoot);
      cacheLimitInput.focus();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ignoreCacheBackdrop = false;
        });
      });
    }
  }

  function renderThemeSwatches(): void {
    themeSwatches.replaceChildren();
    themeSwatches.setAttribute('aria-label', labels().libraryTheme);
    for (const theme of LIBRARY_THEMES) {
      const swatch = button(doc, '', 'lightink-library-theme-swatch');
      swatch.dataset.libraryTheme = theme.id;
      const preview = doc.createElement('span');
      preview.className = 'lightink-library-theme-preview';
      preview.style.backgroundColor = theme.page;
      preview.style.borderColor = theme.border;
      const accent = doc.createElement('i');
      accent.style.backgroundColor = theme.accent;
      preview.append(accent);
      const name = doc.createElement('span');
      name.className = 'lightink-library-theme-swatch-name';
      name.textContent = options.themeLabel(theme.id);
      swatch.append(preview, name);
      swatch.title = name.textContent ?? '';
      swatch.setAttribute('aria-label', name.textContent ?? '');
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(theme.id === currentLibraryTheme));
      swatch.classList.toggle('is-active', theme.id === currentLibraryTheme);
      swatch.addEventListener('click', () => {
        currentLibraryTheme = saveLibraryTheme(options.themeStorage, theme.id);
        applyLibraryTheme(options.themeRoot, currentLibraryTheme);
        renderThemeSwatches();
        doc.dispatchEvent(
          new CustomEvent('lightink:library-theme', { detail: currentLibraryTheme }),
        );
      });
      themeSwatches.append(swatch);
    }
  }

  const syncReaderPrefsFromStorage = (): void => {
    currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    progressBarInput.checked = currentReaderPrefs.showProgressBar;
  };

  const onReaderPrefsStorage = (event: Event): void => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== READER_PREFS_STORAGE_KEY) {
      return;
    }
    syncReaderPrefsFromStorage();
  };
  const prefsTarget: Document | Window = doc.defaultView ?? doc;
  prefsTarget.addEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);

  progressBarInput.addEventListener('change', () => {
    currentReaderPrefs = saveReaderPrefs(options.readerPrefsStorage, {
      showProgressBar: progressBarInput.checked,
    });
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    doc.dispatchEvent(new CustomEvent('lightink:reader-prefs', { detail: currentReaderPrefs }));
  });

  importButton.addEventListener('click', () => {
    void options.onImport();
  });
  editorButton?.addEventListener('click', () => options.onEnterEditor?.());
  syncButton?.addEventListener('click', () => options.onOpenSyncPanel?.());

  clearCacheButton.addEventListener('click', async () => {
    try {
      await options.library.clearCache();
      await view.refreshCache();
    } catch (error) {
      options.notify(options.formatError(error), 'error');
    }
  });

  cacheLimitButton.addEventListener('click', () => {
    setSubpage('cache-limit');
  });
  cacheLimitCancel.addEventListener('click', () => {
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('click', (event) => {
    if (ignoreCacheBackdrop || event.target !== cacheLimitOverlay) return;
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const gibibytes = cacheLimitInput.valueAsNumber;
    if (!Number.isFinite(gibibytes) || gibibytes <= 0) return;
    try {
      await options.library.setCacheLimit(Math.round(gibibytes * 1024 ** 3));
      setSubpage('home');
      await view.refreshCache();
      cacheLimitButton.focus();
    } catch (error) {
      options.notify(options.formatError(error), 'error');
    }
  });

  function retranslate(): void {
    const l = labels();
    appearanceTitle.textContent = l.appearance;
    appearanceHint.textContent = l.libraryThemeHint;
    readerPrefsTitle.textContent = l.readingGroup;
    readerPrefsHint.textContent = l.readerPrefsHint;
    progressBarText.textContent = l.showProgressBar;
    progressBarLabel.title = l.showProgressBar;
    storageTitle.textContent = l.storageGroup;
    clearCacheButton.textContent = l.clearCache;
    cacheLimitButton.textContent = l.changeCacheLimit;
    cacheLimitButton.title = l.changeCacheLimit;
    cacheLimitButton.setAttribute('aria-label', l.changeCacheLimit);
    if (syncTitle !== null) syncTitle.textContent = l.syncGroup;
    if (syncButton !== null) {
      syncButton.textContent = l.webdavSync;
      syncButton.title = l.webdavSync;
      syncButton.setAttribute('aria-label', l.webdavSync);
    }
    otherTitle.textContent = l.otherGroup;
    importButton.textContent = l.importLocal;
    if (editorButton !== null) {
      editorButton.textContent = l.markdownEditor;
      editorButton.title = l.markdownEditor;
      editorButton.setAttribute('aria-label', l.markdownEditor);
    }
    cacheLimitTitle.textContent = l.changeCacheLimit;
    cacheLimitLabelText.textContent = l.cacheLimit;
    cacheLimitSave.textContent = l.apply;
    cacheLimitCancel.textContent = l.cancel;
    renderThemeSwatches();
    syncReaderPrefsFromStorage();
  }

  const view: LibraryManageView = {
    element,
    showHome(): void {
      setSubpage('home');
    },
    handleEscape(): boolean {
      if (subpage === 'home') return false;
      setSubpage('home');
      cacheLimitButton.focus();
      return true;
    },
    async refreshCache(): Promise<void> {
      try {
        const cache = await options.library.cacheStats();
        cacheUsage.textContent = labels()
          .cacheUsage.replace('{used}', bytesLabel(cache.bytesCached))
          .replace('{limit}', bytesLabel(cache.limitBytes));
        if (doc.activeElement !== cacheLimitInput) {
          cacheLimitInput.value = String(cache.limitBytes / 1024 ** 3);
        }
      } catch {
        // 浏览器预览无 cacheStats：隐藏空用量盒，避免盖住「存储与缓存」。
        cacheUsage.textContent = '';
      }
      cacheSummary.hidden = cacheUsage.textContent.trim() === '';
    },
    retranslate,
    destroy(): void {
      prefsTarget.removeEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);
      cacheLimitOverlay.remove();
      element.remove();
    },
  };

  retranslate();
  return view;
}
