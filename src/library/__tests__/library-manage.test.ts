// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bytesLabel,
  createLibraryManage,
  type LibraryManageLabels,
  type LibraryManageOptions,
} from '../library-manage.js';
import type { LibraryThemeId } from '../library-theme.js';
import '../library.css';

type Locale = 'en' | 'zh-CN';

const LABELS: Record<Locale, LibraryManageLabels> = {
  en: {
    appearance: 'Appearance',
    libraryTheme: 'Shelf theme',
    libraryThemeHint: 'Applies to the shelf only.',
    readingGroup: 'Reading preferences',
    readerPrefsHint: 'Applies while reading.',
    showProgressBar: 'Show progress bar',
    storageGroup: 'Storage & cache',
    clearCache: 'Clear cache',
    cacheUsage: '{used} of {limit}',
    cacheLimit: 'Cache limit (GiB)',
    changeCacheLimit: 'Change cache limit',
    apply: 'Apply',
    cancel: 'Cancel',
    syncGroup: 'Sync',
    webdavSync: 'WebDAV sync',
    otherGroup: 'Other',
    importLocal: 'Import local book',
    markdownEditor: 'Markdown editor',
  },
  'zh-CN': {
    appearance: '外观',
    libraryTheme: '书架主题',
    libraryThemeHint: '只改变书架外观，不影响编辑器和阅读器。',
    readingGroup: '阅读偏好',
    readerPrefsHint: '只影响阅读界面。关闭后阅读区底部不再显示进度条。',
    showProgressBar: '显示进度条',
    storageGroup: '存储与缓存',
    clearCache: '清理缓存',
    cacheUsage: '已用 {used} / {limit}',
    cacheLimit: '缓存上限（GiB）',
    changeCacheLimit: '调整缓存上限',
    apply: '应用',
    cancel: '取消',
    syncGroup: '同步',
    webdavSync: 'WebDAV 同步',
    otherGroup: '其他',
    importLocal: '导入本地书籍',
    markdownEditor: 'Markdown 编辑',
  },
};

function memoryStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}

function manageOptions(
  overrides: Partial<LibraryManageOptions> = {},
): { options: LibraryManageOptions; themeRoot: HTMLElement } {
  const themeRoot = document.createElement('section');
  themeRoot.className = 'lightink-library';
  const locale: Locale = 'zh-CN';
  const options: LibraryManageOptions = {
    labels: () => LABELS[locale],
    themeLabel: (id: LibraryThemeId) => id,
    themeRoot,
    library: {
      clearCache: vi.fn(async () => undefined),
      setCacheLimit: vi.fn(async () => undefined),
      cacheStats: vi.fn(async () => ({ bytesCached: 512 * 1024 ** 2, limitBytes: 2 * 1024 ** 3 })),
    },
    notify: vi.fn(),
    formatError: () => '无法连接此书库源。',
    onImport: vi.fn(async () => undefined),
    onOpenSyncPanel: vi.fn(),
    onEnterEditor: vi.fn(),
    ...overrides,
  };
  return { options, themeRoot };
}

function groupTitles(panel: ParentNode): string[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('.lightink-library-manage-home [data-manage-group]'),
  ).map((group) => group.dataset.manageGroup ?? '');
}

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.readerProgressBar;
});

describe('createLibraryManage grouped settings page', () => {
  it('renders all groups in order with every feature entry reachable', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    expect(groupTitles(manage.element)).toEqual([
      'appearance',
      'reading',
      'storage',
      'sync',
      'other',
    ]);
    const zh = LABELS['zh-CN'];
    expect(manage.element.querySelector('.lightink-library-appearance h2')?.textContent).toBe(
      zh.appearance,
    );
    expect(manage.element.querySelector('.lightink-library-reader-prefs h2')?.textContent).toBe(
      zh.readingGroup,
    );
    expect(
      manage.element.querySelector('[data-manage-group="storage"] h2')?.textContent,
    ).toBe(zh.storageGroup);
    expect(manage.element.querySelector('[data-manage-group="sync"] h2')?.textContent).toBe(
      zh.syncGroup,
    );
    expect(manage.element.querySelector('[data-manage-group="other"] h2')?.textContent).toBe(
      zh.otherGroup,
    );
    // 功能项一一保留：主题色板、进度条开关、清理缓存、缓存上限、WebDAV 同步、导入、编辑器。
    expect(manage.element.querySelectorAll('.lightink-library-theme-swatch')).toHaveLength(5);
    expect(
      manage.element.querySelector<HTMLInputElement>('input[name="showProgressBar"]')?.checked,
    ).toBe(true);
    expect(manage.element.textContent).toContain(zh.clearCache);
    expect(manage.element.textContent).toContain(zh.changeCacheLimit);
    expect(manage.element.textContent).toContain(zh.webdavSync);
    expect(manage.element.textContent).toContain(zh.importLocal);
    expect(manage.element.textContent).toContain(zh.markdownEditor);
    manage.destroy();
  });

  it('covers the groups and entries with English labels', () => {
    const { options } = manageOptions({ labels: () => LABELS.en });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const en = LABELS.en;
    expect(manage.element.querySelector('.lightink-library-appearance h2')?.textContent).toBe(
      en.appearance,
    );
    expect(manage.element.querySelector('.lightink-library-reader-prefs h2')?.textContent).toBe(
      en.readingGroup,
    );
    expect(manage.element.querySelector('[data-manage-group="storage"] h2')?.textContent).toBe(
      en.storageGroup,
    );
    expect(manage.element.querySelector('[data-manage-group="sync"] h2')?.textContent).toBe(
      en.syncGroup,
    );
    expect(manage.element.querySelector('[data-manage-group="other"] h2')?.textContent).toBe(
      en.otherGroup,
    );
    manage.destroy();
  });

  it('suppresses the sync group and editor entry when the deps are absent', () => {
    const { options } = manageOptions({ onOpenSyncPanel: undefined, onEnterEditor: undefined });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    expect(groupTitles(manage.element)).toEqual(['appearance', 'reading', 'storage', 'other']);
    expect(manage.element.querySelector('.lightink-library-sync-entry')).toBeNull();
    expect(manage.element.querySelector('.lightink-library-editor-entry')).toBeNull();
    manage.destroy();
  });

  it('opens the cache-limit dialog without leaving the manage home', async () => {
    const { options, themeRoot } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.append(themeRoot, manage.element);

    // 主页不消费 Escape。
    expect(manage.handleEscape()).toBe(false);

    await manage.refreshCache();
    expect(
      manage.element.querySelector('.lightink-library-cache-summary')?.textContent,
    ).toContain('512 MiB');

    const entry = manage.element.querySelector<HTMLButtonElement>(
      '[aria-label="调整缓存上限"]',
    )!;
    entry.click();
    expect(manage.element.dataset.managePage).toBe('cache-limit');
    expect(manage.element.querySelector<HTMLElement>('.lightink-library-manage-home')!.hidden).toBe(
      false,
    );
    const overlay = document.querySelector<HTMLElement>('.lightink-library-cache-limit-modal')!;
    expect(overlay.hidden).toBe(false);
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay.querySelector('.lightink-library-cache-limit-title')?.textContent).toBe(
      '调整缓存上限',
    );

    const input = overlay.querySelector<HTMLInputElement>('input[name="cacheLimitGiB"]')!;
    expect(input.value).toBe('2');

    // 弹层打开时消费 Escape 并关掉弹层。
    expect(manage.handleEscape()).toBe(true);
    expect(manage.element.dataset.managePage).toBe('home');
    expect(overlay.hidden).toBe(true);
    expect(manage.handleEscape()).toBe(false);
    manage.destroy();
  });

  it('submits a new cache limit and returns to the manage home', async () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    manage.element.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    const form = document.querySelector<HTMLFormElement>(
      '.lightink-library-cache-limit-form',
    )!;
    (form.elements.namedItem('cacheLimitGiB') as HTMLInputElement).value = '4';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(options.library.setCacheLimit).toHaveBeenCalledWith(4 * 1024 ** 3);
    expect(manage.element.dataset.managePage).toBe('home');
    manage.destroy();
  });

  it('clears the cache and keeps the usage row readable on stats failure', async () => {
    const { options } = manageOptions({
      library: {
        clearCache: vi.fn(async () => undefined),
        setCacheLimit: vi.fn(async () => undefined),
        cacheStats: vi.fn(async () => {
          throw new Error('offline');
        }),
      },
    });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const clear = Array.from(manage.element.querySelectorAll('button')).find(
      (button) => button.textContent === '清理缓存',
    )!;
    clear.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(options.library.clearCache).toHaveBeenCalledTimes(1);
    const summary = manage.element.querySelector<HTMLElement>('.lightink-library-cache-summary');
    expect(summary?.textContent).toBe('');
    expect(summary?.hidden).toBe(true);
    manage.destroy();
  });

  it('switches the shelf theme on the theme root without touching editor keys', () => {
    const themeStorage = memoryStorage();
    const { options, themeRoot } = manageOptions({ themeStorage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(themeRoot);
    themeRoot.appendChild(manage.element);

    const ink = manage.element.querySelector<HTMLButtonElement>(
      '.lightink-library-theme-swatch[data-library-theme="ink"]',
    )!;
    ink.click();

    expect(themeRoot.dataset.libraryTheme).toBe('ink');
    expect(themeRoot.style.getPropertyValue('--lightink-bg')).toBe('#14161a');
    expect(themeStorage.store['lightink.library.theme']).toBe('ink');
    expect(themeStorage.store['lightink.theme']).toBeUndefined();
    expect(themeStorage.store['lightink.reader.theme']).toBeUndefined();
    // 色板重新渲染后 ink 项为选中态。
    const active = manage.element.querySelector<HTMLButtonElement>(
      '.lightink-library-theme-swatch[data-library-theme="ink"]',
    )!;
    expect(active.getAttribute('aria-checked')).toBe('true');
    expect(active.classList.contains('is-active')).toBe(true);
    manage.destroy();
  });

  it('persists the reader progress bar pref and syncs external changes', () => {
    const readerPrefsStorage = memoryStorage();
    const { options } = manageOptions({ readerPrefsStorage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const input = manage.element.querySelector<HTMLInputElement>(
      'input[name="showProgressBar"]',
    )!;
    expect(input.checked).toBe(true);
    expect(document.documentElement.dataset.readerProgressBar).toBe('on');

    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readerPrefsStorage.store['lightink.reader.prefs']).toContain('"showProgressBar":false');
    expect(document.documentElement.dataset.readerProgressBar).toBe('off');

    readerPrefsStorage.store['lightink.reader.prefs'] = JSON.stringify({ showProgressBar: true });
    window.dispatchEvent(
      new CustomEvent('lightink:syncable-storage-change', {
        detail: { key: 'lightink.reader.prefs' },
      }),
    );
    expect(input.checked).toBe(true);
    expect(document.documentElement.dataset.readerProgressBar).toBe('on');

    // destroy 后不再响应外部存储变更。
    readerPrefsStorage.store['lightink.reader.prefs'] = JSON.stringify({ showProgressBar: false });
    manage.destroy();
    window.dispatchEvent(
      new CustomEvent('lightink:syncable-storage-change', {
        detail: { key: 'lightink.reader.prefs' },
      }),
    );
    expect(document.documentElement.dataset.readerProgressBar).toBe('on');
  });
});

describe('bytesLabel', () => {
  it('formats cache sizes with binary units', () => {
    expect(bytesLabel(0)).toBe('0 B');
    expect(bytesLabel(512)).toBe('512 B');
    expect(bytesLabel(1536)).toBe('1.5 KiB');
    expect(bytesLabel(2 * 1024 ** 3)).toBe('2.0 GiB');
  });
});
