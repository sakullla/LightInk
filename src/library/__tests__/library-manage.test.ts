// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import {
  bytesLabel,
  createLibraryManage,
  type ConcealBossKeysStatus,
  type ConcealManageDeps,
  type ConcealManageLabels,
  type LibraryManageLabels,
  type LibraryManageOptions,
} from '../library-manage.js';
import {
  applyConcealScene,
  defaultConcealPrefs,
  type ConcealPrefs,
} from '../../conceal/conceal-prefs.js';
import type { ConcealSwitchRefusalKey } from '../library-manage.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
import {
  createLibraryTabbar,
  type LibraryTabbarLabels,
} from '../library-tabbar.js';
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
    pageTurnStyle: 'Page-turn animation',
    pageTurnStyleAuto: 'Auto (follow system)',
    pageTurnStyleSlide: 'Slide',
    pageTurnStyleFade: 'Fade',
    pageTurnStyleCurl: 'Page curl',
    pageTurnStyleNone: 'None',
    aiGroup: 'AI',
    aiHint:
      'Configure the single AI provider. Saving a new configuration replaces the previous one.',
    aiEndpointKind: 'Endpoint format',
    aiEndpointOpenaiResponses: 'OpenAI Responses',
    aiEndpointOpenaiChat: 'OpenAI Chat Completions',
    aiEndpointClaudeMessages: 'Claude Messages',
    aiBaseUrl: 'Base URL',
    aiModel: 'Model',
    aiKey: 'API key',
    aiKeyClear: 'Clear key',
    aiKeyShow: 'Show',
    aiKeyHide: 'Hide',
    aiKeySavedPlaceholder: 'Saved on this device. Enter a new key to replace it.',
    aiAllowHttp: 'Allow HTTP address (insecure)',
    aiTargetLang: 'Translation target language',
    aiTargetLangAuto: 'Auto (follow interface language)',
    aiLangZhCN: '简体中文',
    aiLangEn: 'English',
    aiLangJa: '日本語',
    aiLangKo: '한국어',
    aiLangFr: 'Français',
    aiLangDe: 'Deutsch',
    aiLangEs: 'Español',
    aiLangRu: 'Русский',
    aiSave: 'Save configuration',
    aiTest: 'Test connection',
    aiTesting: 'Testing connection…',
    aiTestOk: 'Connection succeeded ({ms} ms).',
    aiConfigured: 'AI provider configured and ready.',
    aiUnconfigured: 'AI provider is not fully configured yet.',
    aiUnconfiguredGaps: 'AI provider is not fully configured (missing: {missing}).',
    aiSaved: 'AI configuration saved.',
    aiKeyCleared: 'API key cleared.',
    aiErrorHttpNotAllowed: 'HTTP addresses are rejected unless Allow HTTP address is checked.',
    aiErrorUrlInvalid:
      'The base URL is invalid: use an http(s) address without user info, query, or fragment.',
    aiErrorConfigInvalid: 'The configuration values are invalid or too long.',
    aiErrorStorage: 'Could not read or save the AI configuration on this device.',
    aiErrorKeyInvalid: 'The provider rejected the API key.',
    aiErrorModelNotFound: 'The model does not exist or is unavailable.',
    aiErrorQuota: 'Requests are rate-limited or the quota is exhausted.',
    aiErrorUnconfigured: 'Complete and save the configuration first (missing: {missing}).',
    aiErrorTimeout: 'The request timed out.',
    aiErrorNetwork: 'Could not reach the AI service; check the address and network.',
    aiErrorKeyStore: 'Could not save the key to the device keychain.',
    aiErrorTooLarge: 'The AI response exceeded the size limit.',
    aiErrorFailed: 'The AI request failed.',
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
    pageTurnStyle: '翻页动画',
    pageTurnStyleAuto: '自动（跟随系统）',
    pageTurnStyleSlide: '滑动',
    pageTurnStyleFade: '淡入',
    pageTurnStyleCurl: '仿真翻页',
    pageTurnStyleNone: '无',
    aiGroup: 'AI',
    aiHint: '为 AI 翻译与 AI 助手配置唯一 AI 提供商；保存新配置即覆盖原配置。',
    aiEndpointKind: '端点格式',
    aiEndpointOpenaiResponses: 'OpenAI Responses',
    aiEndpointOpenaiChat: 'OpenAI Chat Completions',
    aiEndpointClaudeMessages: 'Claude Messages',
    aiBaseUrl: 'Base URL',
    aiModel: '模型名',
    aiKey: 'API 密钥',
    aiKeyClear: '清除密钥',
    aiKeyShow: '显示',
    aiKeyHide: '隐藏',
    aiKeySavedPlaceholder: '已保存在本机。输入新密钥以替换。',
    aiAllowHttp: '允许 HTTP 地址（不安全）',
    aiTargetLang: '翻译目标语言',
    aiTargetLangAuto: '自动（跟随界面语言）',
    aiLangZhCN: '简体中文',
    aiLangEn: 'English',
    aiLangJa: '日本語',
    aiLangKo: '한국어',
    aiLangFr: 'Français',
    aiLangDe: 'Deutsch',
    aiLangEs: 'Español',
    aiLangRu: 'Русский',
    aiSave: '保存配置',
    aiTest: '测试连接',
    aiTesting: '正在测试连接…',
    aiTestOk: '连接成功（{ms} ms）。',
    aiConfigured: 'AI 提供商已配置完成。',
    aiUnconfigured: 'AI 尚未完成配置。',
    aiUnconfiguredGaps: 'AI 尚未完成配置（缺少：{missing}）。',
    aiSaved: 'AI 配置已保存。',
    aiKeyCleared: 'API 密钥已清除。',
    aiErrorHttpNotAllowed: '未勾选「允许 HTTP 地址」时不能保存 HTTP 地址。',
    aiErrorUrlInvalid: 'Base URL 无效：需要不带用户信息、查询参数或片段的 http(s) 地址。',
    aiErrorConfigInvalid: '配置值无效或过长。',
    aiErrorStorage: '无法在本机读取或保存 AI 配置。',
    aiErrorKeyInvalid: '服务商拒绝了 API 密钥。',
    aiErrorModelNotFound: '模型不存在或不可用。',
    aiErrorQuota: '请求过于频繁或额度不足。',
    aiErrorUnconfigured: '请先完成并保存配置（缺少：{missing}）。',
    aiErrorTimeout: '请求超时。',
    aiErrorNetwork: '无法连接 AI 服务，请检查地址与网络。',
    aiErrorKeyStore: '无法将密钥写入本机钥匙串。',
    aiErrorTooLarge: 'AI 响应超过大小上限。',
    aiErrorFailed: 'AI 请求失败。',
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

function confirmDialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('.lightink-confirm-dialog');
  const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`confirm button not found: ${label}`);
  return button;
}

function groupTitles(panel: ParentNode): string[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>('.lightink-library-manage-home [data-manage-group]'),
  ).map((group) => group.dataset.manageGroup ?? '');
}

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.readerProgressBar;
  delete document.documentElement.dataset.readerPageTurn;
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ configured: false });
});

describe('manage group collapsing', () => {
  it('navigates group headings with arrows and Home/End, then toggles with the keyboard', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    const titles = [...manage.element.querySelectorAll<HTMLElement>('.lightink-library-manage-group-toggle')];
    const press = (key: string): void => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };
    titles[0]!.focus();
    press('ArrowUp');
    expect(document.activeElement).toBe(titles[titles.length - 1]);
    press('ArrowDown');
    expect(document.activeElement).toBe(titles[0]);
    press('End');
    expect(document.activeElement).toBe(titles[titles.length - 1]);
    press('Home');
    press('ArrowDown');
    expect(document.activeElement).toBe(titles[1]);
    expect(titles[1]!.getAttribute('aria-expanded')).toBe('false');
    press('Enter');
    expect(titles[1]!.getAttribute('aria-expanded')).toBe('true');
    press(' ');
    expect(titles[1]!.getAttribute('aria-expanded')).toBe('false');
    manage.destroy();
  });

  it('groups always start collapsed; clicking a title toggles without persisting', () => {
    const storage = memoryStorage();
    const { options } = manageOptions({ themeStorage: storage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const groups = Array.from(
      manage.element.querySelectorAll<HTMLElement>('.lightink-library-manage-group'),
    );
    expect(groups.length).toBeGreaterThan(4);
    for (const group of groups) {
      expect(group.dataset.collapsed).toBe('true');
      expect(group.querySelector('h2')?.getAttribute('aria-expanded')).toBe('false');
    }

    const appearance = groups[0]!;
    const title = appearance.querySelector('h2')!;
    title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(appearance.dataset.collapsed).toBeUndefined();
    expect(title.getAttribute('aria-expanded')).toBe('true');
    // 不持久化：设置页重建（如下次打开）永远从全折叠开始。
    expect(Object.keys(storage.store)).not.toContain('lightink.library.manageExpanded');

    title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(appearance.dataset.collapsed).toBe('true');
    expect(title.getAttribute('aria-expanded')).toBe('false');
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-library-manage-group\[data-collapsed='true'\]\s*>\s*:not\(h2\):not\(\.lightink-library-manage-group-summary\)\s*\{[^}]*display:\s*none !important/,
    );
    manage.destroy();
  });

  it('shows a one-line current-value summary under collapsed group titles', async () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const summaryOf = (group: string) =>
      manage.element.querySelector<HTMLElement>(
        `[data-manage-group="${group}"] > .lightink-library-manage-group-summary`,
      );

    // 外观：当前主题名；阅读偏好：翻页样式标签；AI：配置状态。
    expect(summaryOf('appearance')?.hidden).toBe(false);
    expect(summaryOf('appearance')?.textContent?.trim()).not.toBe('');
    expect(summaryOf('reading')?.hidden).toBe(false);
    expect(summaryOf('reading')?.textContent).toContain('翻页动画');
    expect(summaryOf('ai')?.hidden).toBe(false);
    expect(summaryOf('ai')?.textContent).toContain('AI');

    // 存储：cacheStats 就绪后回显用量。
    await manage.refreshCache();
    expect(summaryOf('storage')?.hidden).toBe(false);
    expect(summaryOf('storage')?.textContent).toContain('512 MiB');

    // 标题本身保持纯分组名（摘要不进 h2 文本）。
    expect(
      manage.element.querySelector('[data-manage-group="appearance"] h2')?.textContent,
    ).toBe('外观');
    manage.destroy();
  });
});

describe('manage rows affordance', () => {
  it('adds a chevron to navigating rows and marks destructive actions', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    for (const selector of [
      '.lightink-library-cache-limit-entry',
      '.lightink-library-sync-entry',
      '.lightink-library-import-entry',
      '.lightink-library-editor-entry',
    ]) {
      const row = manage.element.querySelector<HTMLElement>(selector);
      expect(row?.querySelector('.lightink-library-manage-row-chevron')).not.toBeNull();
      expect(row?.querySelector('.lightink-library-manage-row-label')?.textContent).not.toBe('');
    }
    // 清理缓存是动作行：无 chevron，带危险着色标记。
    const clearCache = manage.element.querySelector<HTMLElement>('.lightink-library-manage-row');
    expect(clearCache?.classList.contains('is-danger')).toBe(true);
    expect(clearCache?.querySelector('.lightink-library-manage-row-chevron')).toBeNull();
    manage.destroy();
  });
});

describe('manage radiogroup keyboard navigation', () => {
  it('moves the theme selection with arrow keys and keeps roving tabindex', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const swatches = () =>
      Array.from(
        manage.element.querySelectorAll<HTMLElement>('.lightink-library-theme-swatch'),
      );
    // 初始：仅选中项进 Tab 序。
    expect(swatches().filter((el) => el.tabIndex === 0)).toHaveLength(1);

    const activeIndex = swatches().findIndex((el) => el.classList.contains('is-active'));
    const target = swatches()[activeIndex]!;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    const next = swatches()[(activeIndex + 1) % swatches().length]!;
    expect(next.classList.contains('is-active')).toBe(true);
    expect(next.getAttribute('aria-checked')).toBe('true');
    expect(next.tabIndex).toBe(0);
    expect(document.activeElement).toBe(next);

    // End 跳到末位。
    next.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const last = swatches()[swatches().length - 1]!;
    expect(last.classList.contains('is-active')).toBe(true);
    manage.destroy();
  });
});

describe('manage AI key reveal', () => {
  it('toggles the API key field between masked and plain text', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const keyInput = manage.element.querySelector<HTMLInputElement>(
      'input[name="aiApiKey"]',
    )!;
    const reveal = manage.element.querySelector<HTMLButtonElement>(
      '.lightink-library-ai-key-reveal',
    )!;

    // 空密钥框没有可核对内容：禁用并收起明文。
    expect(reveal.disabled).toBe(true);
    expect(keyInput.type).toBe('password');

    keyInput.value = 'sk-test';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(reveal.disabled).toBe(false);
    expect(reveal.textContent).toBe('显示');

    reveal.click();
    expect(keyInput.type).toBe('text');
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
    expect(reveal.textContent).toBe('隐藏');

    reveal.click();
    expect(keyInput.type).toBe('password');
    expect(reveal.getAttribute('aria-pressed')).toBe('false');

    // 清空输入回到禁用+掩码。
    keyInput.value = '';
    keyInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(reveal.disabled).toBe(true);
    expect(keyInput.type).toBe('password');
    manage.destroy();
  });
});

describe('createLibraryManage grouped settings page', () => {
  it('renders all groups in order with every feature entry reachable', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    expect(groupTitles(manage.element)).toEqual([
      'appearance',
      'reading',
      'ai',
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
    expect(manage.element.querySelector('[data-manage-group="translate"]')).toBeNull();
    expect(manage.element.textContent).not.toContain('DeepL');
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

    expect(groupTitles(manage.element)).toEqual([
      'appearance',
      'reading',
      'ai',
      'storage',
      'other',
    ]);
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

  it('clears the cache only after confirmation and keeps the usage row readable on stats failure', async () => {
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
    const dialog = document.querySelector<HTMLElement>('.lightink-confirm-dialog');
    expect(dialog?.textContent).toContain('已下载缓存');
    expect(dialog?.textContent).toContain('书库条目');
    confirmDialogButton('取消').click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(options.library.clearCache).not.toHaveBeenCalled();

    clear.click();
    confirmDialogButton('清理缓存').click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(options.library.clearCache).toHaveBeenCalledTimes(1);
    const summary = manage.element.querySelector<HTMLElement>('.lightink-library-cache-summary');
    expect(summary?.textContent).toBe('');
    expect(summary?.hidden).toBe(true);
    manage.destroy();
  });

  it('leaves cache usage unchanged when clearing is cancelled', async () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await manage.refreshCache();
    const summary = manage.element.querySelector<HTMLElement>('.lightink-library-cache-summary')!;
    const before = summary.textContent;
    expect(summary.hidden).toBe(false);

    const clear = Array.from(manage.element.querySelectorAll('button')).find(
      (button) => button.textContent === '清理缓存',
    )!;
    clear.click();
    confirmDialogButton('取消').click();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(options.library.clearCache).not.toHaveBeenCalled();
    expect(summary.textContent).toBe(before);
    expect(document.querySelector('.lightink-confirm-dialog')).toBeNull();
    manage.destroy();
  });

  it('explains downloaded cache in English before clearing', () => {
    const { options } = manageOptions({ labels: () => LABELS.en });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    const clear = Array.from(manage.element.querySelectorAll('button')).find(
      (button) => button.textContent === 'Clear cache',
    )!;
    clear.click();
    const dialog = document.querySelector<HTMLElement>('.lightink-confirm-dialog');
    expect(dialog?.textContent).toContain('downloaded cache');
    expect(dialog?.textContent).toContain('Library entries');
    confirmDialogButton('Cancel').click();
    manage.destroy();
  });

  it('switches the shelf theme on the theme root without touching editor keys', () => {
    const themeStorage = memoryStorage();
    const { options, themeRoot } = manageOptions({ themeStorage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(themeRoot);
    themeRoot.appendChild(manage.element);

    const ink = manage.element.querySelector<HTMLButtonElement>(
      '.lightink-library-theme-swatch[data-library-theme-id="ink"]',
    )!;
    expect(ink.hasAttribute('data-library-theme')).toBe(false);
    ink.click();

    expect(themeRoot.dataset.libraryTheme).toBe('ink');
    expect(themeRoot.style.getPropertyValue('--lightink-bg')).toBe('');
    expect(themeStorage.store['lightink.library.theme']).toBe('ink');
    expect(themeStorage.store['lightink.theme']).toBeUndefined();
    expect(themeStorage.store['lightink.reader.theme']).toBeUndefined();
    // 色板重新渲染后 ink 项为选中态。
    const active = manage.element.querySelector<HTMLButtonElement>(
      '.lightink-library-theme-swatch[data-library-theme-id="ink"]',
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

  it('persists the page-turn style, applies it immediately, and round-trips with the bar pref', () => {
    const readerPrefsStorage = memoryStorage();
    const { options } = manageOptions({ readerPrefsStorage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    const select = manage.element.querySelector<HTMLSelectElement>(
      'select[name="pageTurnStyle"]',
    )!;
    // 默认 auto（未显式选择）；五个选项齐备且当前值生效。
    expect(select.value).toBe('auto');
    expect(
      Array.from(select.options).map((option) => option.value),
    ).toEqual(['auto', 'slide', 'fade', 'curl', 'none']);
    expect(document.documentElement.dataset.readerPageTurn).toBe('auto');

    const prefsEvents: Array<Record<string, unknown>> = [];
    const onPrefs = (event: Event): void => {
      prefsEvents.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    document.addEventListener('lightink:reader-prefs', onPrefs);

    // 选择 slide：立即写入存储、盖章 dataset、派发事件（下一次翻页即生效）。
    select.value = 'slide';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readerPrefsStorage.store['lightink.reader.prefs']).toContain('"pageTurnStyle":"slide"');
    expect(document.documentElement.dataset.readerPageTurn).toBe('slide');
    expect(prefsEvents).toEqual([
      expect.objectContaining({ showProgressBar: true, pageTurnStyle: 'slide' }),
    ]);

    // 切回进度条开关不重置已选样式（完整 ReaderPrefs 一起保存）。
    const bar = manage.element.querySelector<HTMLInputElement>('input[name="showProgressBar"]')!;
    bar.checked = false;
    bar.dispatchEvent(new Event('change', { bubbles: true }));
    expect(readerPrefsStorage.store['lightink.reader.prefs']).toContain('"pageTurnStyle":"slide"');
    expect(readerPrefsStorage.store['lightink.reader.prefs']).toContain('"showProgressBar":false');
    document.removeEventListener('lightink:reader-prefs', onPrefs);

    // 外部（同步/另一入口）变更样式回 fade 时 select 跟随。
    readerPrefsStorage.store['lightink.reader.prefs'] = JSON.stringify({
      showProgressBar: false,
      pageTurnStyle: 'fade',
    });
    window.dispatchEvent(
      new CustomEvent('lightink:syncable-storage-change', {
        detail: { key: 'lightink.reader.prefs' },
      }),
    );
    expect(select.value).toBe('fade');
    manage.destroy();
  });
});

describe('createLibraryManage AI provider group (R2)', () => {
  const AI_DEFAULTS = [
    { endpointKind: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    { endpointKind: 'openai-chat', baseUrl: 'https://api.openai.com/v1' },
    { endpointKind: 'claude-messages', baseUrl: 'https://api.anthropic.com/v1' },
  ];

  function aiStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      endpointKind: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      allowHttp: false,
      hasKey: false,
      configured: false,
      missing: ['endpoint_kind', 'base_url', 'model', 'api_key'],
      defaults: AI_DEFAULTS,
      ...overrides,
    };
  }

  function mockAiCommands(overrides: Record<string, unknown> = {}): void {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'ai_get_config') return overrides.getConfig ?? aiStatus();
      if (command === 'ai_save_config') {
        if (overrides.saveConfigError !== undefined) throw overrides.saveConfigError;
        return overrides.saveConfig ?? aiStatus();
      }
      if (command === 'ai_store_key') {
        if (overrides.storeKeyError !== undefined) throw overrides.storeKeyError;
        return overrides.storeKey ?? aiStatus();
      }
      if (command === 'ai_forget_key') return overrides.forgetKey ?? aiStatus();
      if (command === 'ai_test_connection') {
        if (overrides.testError !== undefined) throw overrides.testError;
        return overrides.testResult ?? { ok: true, latencyMs: 1234, reply: 'pong' };
      }
      return undefined;
    });
  }

  function aiField(manage: { element: HTMLElement }, name: string): HTMLInputElement {
    return manage.element.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  }

  function aiSelect(manage: { element: HTMLElement }, name: string): HTMLSelectElement {
    return manage.element.querySelector<HTMLSelectElement>(`[name="${name}"]`)!;
  }

  function aiFeedbackOf(manage: { element: HTMLElement }): HTMLElement {
    return manage.element.querySelector<HTMLElement>('.lightink-library-ai-feedback')!;
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('renders endpoint select, inputs, allowHttp, target lang default auto, and gap status', async () => {
    mockAiCommands();
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const zh = LABELS['zh-CN'];
    expect(
      manage.element.querySelector('[data-manage-group="ai"] h2')?.textContent,
    ).toBe(zh.aiGroup);
    const endpoint = aiSelect(manage, 'aiEndpointKind');
    expect(Array.from(endpoint.options).map((option) => option.value)).toEqual([
      'openai-responses',
      'openai-chat',
      'claude-messages',
    ]);
    expect(Array.from(endpoint.options).map((option) => option.textContent)).toEqual([
      zh.aiEndpointOpenaiResponses,
      zh.aiEndpointOpenaiChat,
      zh.aiEndpointClaudeMessages,
    ]);
    // 未保存过:后端默认形态 openai-chat + 官方 base URL 预填。
    expect(endpoint.value).toBe('openai-chat');
    const baseUrl = aiField(manage, 'aiBaseUrl');
    expect(baseUrl.type).toBe('url');
    expect(baseUrl.value).toBe('https://api.openai.com/v1');
    expect(baseUrl.placeholder).not.toBe(zh.aiBaseUrl);
    expect(baseUrl.placeholder).toContain('https://');
    const model = aiField(manage, 'aiModel');
    expect(model.type).toBe('text');
    expect(model.placeholder).not.toBe(zh.aiModel);
    expect(model.placeholder.length).toBeGreaterThan(zh.aiModel.length);
    const key = aiField(manage, 'aiApiKey');
    expect(key.type).toBe('password');
    expect(key.placeholder).not.toBe(zh.aiKey);
    expect(key.placeholder).not.toBe(zh.aiKeySavedPlaceholder);
    expect(model.getAttribute('aria-invalid')).toBe('true');
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(aiField(manage, 'aiAllowHttp').checked).toBe(false);
    const target = aiSelect(manage, 'aiTargetLang');
    expect(target.value).toBe('auto');
    expect(Array.from(target.options).map((option) => option.value)).toEqual([
      'auto',
      'zh-CN',
      'en',
      'ja',
      'ko',
      'fr',
      'de',
      'es',
      'ru',
    ]);
    expect(Array.from(target.options)[0]?.textContent).toBe(zh.aiTargetLangAuto);
    // 测试连接结果区:role=status,初始隐藏;状态行明示四要素缺口。
    const feedback = aiFeedbackOf(manage);
    expect(feedback.getAttribute('role')).toBe('status');
    expect(feedback.hidden).toBe(true);
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.dataset.aiConfigured).toBe('false');
    expect(status.textContent).toContain(zh.aiUnconfiguredGaps.split('{missing}')[0]);
    expect(status.textContent).toContain(zh.aiModel);
    expect(status.textContent).toContain(zh.aiKey);
    expect(manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.hidden).toBe(
      true,
    );
    const keyRow = manage.element.querySelector('.lightink-library-ai-key-row');
    expect(keyRow?.querySelector('[name="aiApiKey"]')).not.toBeNull();
    expect(keyRow?.querySelector('.lightink-library-ai-key-clear')).not.toBeNull();
    expect(manage.element.querySelector('.lightink-library-ai-actions .lightink-library-ai-key-clear')).toBeNull();
    expect(
      manage.element.querySelector('.lightink-library-ai-endpoint-field')?.firstElementChild?.tagName,
    ).toBe('SPAN');
    expect(
      manage.element.querySelector('.lightink-library-ai-target-lang-field')?.firstElementChild?.tagName,
    ).toBe('SPAN');
    manage.destroy();
  });

  it('prefills the official base URL on endpoint switch and keeps custom URLs', async () => {
    mockAiCommands();
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const endpoint = aiSelect(manage, 'aiEndpointKind');
    const baseUrl = aiField(manage, 'aiBaseUrl');

    // 官方默认(未改动)→ 切换 Claude 联动预填 Anthropic 官方地址。
    endpoint.value = 'claude-messages';
    endpoint.dispatchEvent(new Event('change', { bubbles: true }));
    expect(baseUrl.value).toBe('https://api.anthropic.com/v1');

    // 改成自定义地址后再切换:保留用户地址。
    baseUrl.value = 'https://my-proxy.example:8443/openai';
    endpoint.value = 'openai-responses';
    endpoint.dispatchEvent(new Event('change', { bubbles: true }));
    expect(baseUrl.value).toBe('https://my-proxy.example:8443/openai');

    // 清空后切换:预填新格式默认(空视为未改动)。
    baseUrl.value = '';
    endpoint.value = 'openai-chat';
    endpoint.dispatchEvent(new Event('change', { bubbles: true }));
    expect(baseUrl.value).toBe('https://api.openai.com/v1');
    manage.destroy();
  });

  it('saves the single active config with the full input and broadcasts the event', async () => {
    const saved = aiStatus({
      endpointKind: 'openai-chat',
      model: 'gpt-4o-mini',
      targetLang: 'ja',
      hasKey: true,
      configured: true,
      missing: [],
    });
    mockAiCommands({ saveConfig: saved });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const events: Array<Record<string, unknown>> = [];
    const onAi = (event: Event): void => {
      events.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    const onWindowAi = vi.fn();
    document.addEventListener('lightink:reader-ai-configured', onAi);
    window.addEventListener('lightink:reader-ai-configured', onWindowAi);

    aiField(manage, 'aiModel').value = 'gpt-4o-mini';
    aiSelect(manage, 'aiTargetLang').value = 'ja';
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', {
      input: {
        endpointKind: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        allowHttp: false,
        targetLang: 'ja',
      },
    });
    const feedback = aiFeedbackOf(manage);
    expect(feedback.hidden).toBe(false);
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiSaved);
    expect(feedback.dataset.kind).toBe('success');
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.dataset.aiConfigured).toBe('true');
    expect(status.textContent).toBe(LABELS['zh-CN'].aiConfigured);
    // 保存返回 hasKey=true → 清除密钥可见。
    expect(manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.hidden).toBe(
      false,
    );
    expect(events).toEqual([{ configured: true, missing: [] }]);
    expect(onWindowAi).not.toHaveBeenCalled();

    // 切换端点再保存:唯一活动配置被完整覆盖(不叠加第二配置)。
    invokeMock.mockClear();
    const endpoint = aiSelect(manage, 'aiEndpointKind');
    endpoint.value = 'claude-messages';
    endpoint.dispatchEvent(new Event('change', { bubbles: true }));
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', {
      input: {
        endpointKind: 'claude-messages',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'gpt-4o-mini',
        allowHttp: false,
        targetLang: 'ja',
      },
    });
    document.removeEventListener('lightink:reader-ai-configured', onAi);
    window.removeEventListener('lightink:reader-ai-configured', onWindowAi);
    manage.destroy();
  });

  it('rejects HTTP saves without allowHttp, then saves after checking the box', async () => {
    const saved = aiStatus({
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
      allowHttp: true,
      hasKey: true,
      configured: true,
      missing: [],
    });
    mockAiCommands({
      saveConfigError: { code: 'AI_HTTP_NOT_ALLOWED', message: 'HTTP 地址必须显式勾选允许' },
      saveConfig: saved,
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const events: unknown[] = [];
    const onAi = (event: Event): void => {
      events.push((event as CustomEvent).detail);
    };
    document.addEventListener('lightink:reader-ai-configured', onAi);

    aiField(manage, 'aiBaseUrl').value = 'http://127.0.0.1:1234/v1';
    aiField(manage, 'aiModel').value = 'local-model';
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    // 未勾选允许:保存被拒绝,role=status 提示且不广播。
    const feedback = aiFeedbackOf(manage);
    expect(feedback.dataset.kind).toBe('error');
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiErrorHttpNotAllowed);
    expect(events).toEqual([]);

    // 勾选后可保存并广播 configured。
    aiField(manage, 'aiAllowHttp').checked = true;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'ai_get_config') return aiStatus();
      return saved;
    });
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', {
      input: {
        endpointKind: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'local-model',
        allowHttp: true,
        targetLang: undefined,
      },
    });
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiSaved);
    expect(events).toEqual([{ configured: true, missing: [] }]);
    document.removeEventListener('lightink:reader-ai-configured', onAi);
    manage.destroy();
  });

  it('stores and clears the key, broadcasting configured with missing gaps', async () => {
    const withKey = aiStatus({
      model: 'gpt-4o-mini',
      hasKey: true,
      configured: true,
      missing: [],
    });
    const noKey = aiStatus({
      model: 'gpt-4o-mini',
      hasKey: false,
      configured: false,
      missing: ['api_key'],
    });
    const readerPrefsStorage = memoryStorage();
    mockAiCommands({
      getConfig: aiStatus(),
      storeKey: withKey,
      saveConfig: withKey,
      forgetKey: noKey,
    });
    const { options } = manageOptions({ readerPrefsStorage });
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const events: Array<Record<string, unknown>> = [];
    const onAi = (event: Event): void => {
      events.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    document.addEventListener('lightink:reader-ai-configured', onAi);

    const keyInput = aiField(manage, 'aiApiKey');
    keyInput.value = 'sk-test-secret';
    // 单一「保存配置」:密钥框有内容时一并写入钥匙串。
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_store_key', { key: 'sk-test-secret' });
    expect(invokeMock).toHaveBeenCalledWith('ai_save_config', expect.anything());
    expect(keyInput.value).toBe('');
    const feedback = aiFeedbackOf(manage);
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiSaved);
    expect(events).toEqual([{ configured: true, missing: [] }]);
    expect(manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.hidden).toBe(
      false,
    );
    // 密钥材料不进入任何本地存储。
    expect(JSON.stringify(readerPrefsStorage.store)).not.toContain('sk-test-secret');

    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_forget_key');
    expect(events).toEqual([
      { configured: true, missing: [] },
      { configured: false, missing: ['api_key'] },
    ]);
    expect(manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.hidden).toBe(
      true,
    );
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.dataset.aiConfigured).toBe('false');
    expect(status.textContent).toContain(LABELS['zh-CN'].aiKey);
    document.removeEventListener('lightink:reader-ai-configured', onAi);
    manage.destroy();
  });

  it('shows test connection success and distinguishable failures in role=status', async () => {
    mockAiCommands({ testResult: { ok: true, latencyMs: 812, reply: 'pong' } });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const test = manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-test')!;
    const feedback = aiFeedbackOf(manage);
    test.click();
    await settle();

    expect(invokeMock).toHaveBeenCalledWith('ai_test_connection');
    expect(feedback.getAttribute('role')).toBe('status');
    expect(feedback.dataset.kind).toBe('success');
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiTestOk.replace('{ms}', '812'));
    expect(test.disabled).toBe(false);
    expect(test.textContent).toBe(LABELS['zh-CN'].aiTest);

    // 错误密钥:可区分失败(密钥被拒 + HTTP 状态)。
    mockAiCommands({
      testError: { code: 'AI_KEY_INVALID', message: 'AI 服务商拒绝了 API Key (HTTP 401)', status: 401 },
    });
    test.click();
    await settle();
    expect(feedback.dataset.kind).toBe('error');
    expect(feedback.textContent).toBe(`${LABELS['zh-CN'].aiErrorKeyInvalid} (HTTP 401)`);

    // 模型不可用:另一类失败文案。
    mockAiCommands({
      testError: { code: 'AI_MODEL_NOT_FOUND', message: 'model not found', status: 404 },
    });
    test.click();
    await settle();
    expect(feedback.textContent).toBe(`${LABELS['zh-CN'].aiErrorModelNotFound} (HTTP 404)`);

    // 未完成配置:提示缺口而不是空白(重新加载配置使缺口为 model/api_key)。
    mockAiCommands({
      getConfig: aiStatus({ hasKey: true, missing: ['model', 'api_key'] }),
      testError: {
        code: 'AI_NOT_CONFIGURED',
        message: 'AI 尚未完成配置,缺少: model、api_key',
      },
    });
    manage.retranslate();
    await settle();
    test.click();
    await settle();
    expect(feedback.textContent).toBe(
      LABELS['zh-CN'].aiErrorUnconfigured.replace('{missing}', '模型名, API 密钥'),
    );
    manage.destroy();
  });

  it('keeps the address, model, and key when saving the AI configuration fails', async () => {
    mockAiCommands({
      saveConfigError: { code: 'AI_STORAGE_ERROR', message: 'app data dir unavailable' },
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const baseUrl = aiField(manage, 'aiBaseUrl');
    const model = aiField(manage, 'aiModel');
    const key = aiField(manage, 'aiApiKey');
    baseUrl.value = 'https://proxy.example/v1';
    model.value = 'my-model';
    key.value = 'sk-secret';
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
    model.dispatchEvent(new Event('input', { bubbles: true }));
    key.dispatchEvent(new Event('input', { bubbles: true }));
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.textContent).not.toContain(LABELS['zh-CN'].aiModel);
    expect(status.textContent).not.toContain(LABELS['zh-CN'].aiKey);

    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();

    expect(baseUrl.value).toBe('https://proxy.example/v1');
    expect(model.value).toBe('my-model');
    expect(key.value).toBe('sk-secret');
    expect(aiFeedbackOf(manage).textContent).toBe(LABELS['zh-CN'].aiErrorStorage);
    manage.destroy();
  });

  it('names the AI fields that are still empty', async () => {
    mockAiCommands({
      getConfig: aiStatus({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        hasKey: true,
        configured: true,
        missing: [],
      }),
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const model = aiField(manage, 'aiModel');
    model.value = '';
    model.dispatchEvent(new Event('input', { bubbles: true }));
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.dataset.aiConfigured).toBe('false');
    expect(status.textContent).toContain(LABELS['zh-CN'].aiModel);
    expect(status.textContent).not.toContain(LABELS['zh-CN'].aiKey);
    manage.destroy();
  });

  it('collapses camelCase gap tokens so baseUrl is not listed beside Base URL', async () => {
    mockAiCommands({
      getConfig: aiStatus({
        baseUrl: '',
        model: '',
        hasKey: false,
        configured: false,
        missing: ['baseUrl', 'model'],
      }),
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    const text = status.textContent ?? '';
    expect(text).not.toMatch(/baseUrl/);
    expect(text).toContain(LABELS['zh-CN'].aiBaseUrl);
    expect(text).toContain(LABELS['zh-CN'].aiModel);
    expect(text.split(LABELS['zh-CN'].aiBaseUrl).length - 1).toBe(1);
    manage.destroy();
  });

  it('maps AI_STORAGE_ERROR to the dedicated storage copy, not config-invalid', async () => {
    mockAiCommands({
      saveConfigError: { code: 'AI_STORAGE_ERROR', message: 'app data dir unavailable' },
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();
    const feedback = aiFeedbackOf(manage);
    expect(feedback.dataset.kind).toBe('error');
    expect(feedback.textContent).toBe(LABELS['zh-CN'].aiErrorStorage);
    manage.destroy();
  });

  it('keeps unsaved edits when retranslate refreshes the saved configuration', async () => {
    mockAiCommands({
      getConfig: aiStatus({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }),
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();
    const baseUrl = aiField(manage, 'aiBaseUrl');
    const model = aiField(manage, 'aiModel');
    expect(baseUrl.value).toBe('https://api.openai.com/v1');

    // 用户手改 base URL/模型但未保存 → 语言切换触发 retranslate 刷新时不得覆写。
    baseUrl.value = 'https://my-proxy.example/v1';
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }));
    model.value = 'my-model';
    model.dispatchEvent(new Event('input', { bubbles: true }));
    manage.retranslate();
    await settle();
    expect(baseUrl.value).toBe('https://my-proxy.example/v1');
    expect(model.value).toBe('my-model');

    // 保存成功后 dirty 复位,后续刷新恢复回填。
    mockAiCommands({
      getConfig: aiStatus({
        baseUrl: 'https://my-proxy.example/v1',
        model: 'my-model',
        configured: true,
        missing: [],
      }),
      saveConfig: aiStatus({
        baseUrl: 'https://my-proxy.example/v1',
        model: 'my-model',
        configured: true,
        missing: [],
      }),
    });
    manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-save')!.click();
    await settle();
    manage.retranslate();
    await settle();
    expect(baseUrl.value).toBe('https://my-proxy.example/v1');
    expect(model.value).toBe('my-model');
    manage.destroy();
  });

  it('restores a previously saved configuration when the manage page reopens', async () => {
    mockAiCommands({
      getConfig: aiStatus({
        endpointKind: 'claude-messages',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet',
        targetLang: 'en',
        hasKey: true,
        configured: true,
        missing: [],
      }),
    });
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);
    await settle();

    // 重启(重新创建)后:ai_get_config 回填全部字段,配置仍在、密钥在钥匙串。
    expect(aiSelect(manage, 'aiEndpointKind').value).toBe('claude-messages');
    expect(aiField(manage, 'aiBaseUrl').value).toBe('https://api.anthropic.com/v1');
    expect(aiField(manage, 'aiModel').value).toBe('claude-3-5-sonnet');
    expect(aiField(manage, 'aiAllowHttp').checked).toBe(false);
    expect(aiSelect(manage, 'aiTargetLang').value).toBe('en');
    const status = manage.element.querySelector<HTMLElement>('.lightink-library-ai-status')!;
    expect(status.dataset.aiConfigured).toBe('true');
    expect(status.textContent).toBe(LABELS['zh-CN'].aiConfigured);
    expect(manage.element.querySelector<HTMLButtonElement>('.lightink-library-ai-key-clear')!.hidden).toBe(
      false,
    );
    manage.destroy();
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

describe('cache-limit dialog keyboard-inset single deduction (T4)', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-android');
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('defers both keyboard channels to CSS so the sheet bottom rule applies', () => {
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    manage.element.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    const overlay = document.querySelector<HTMLElement>('.lightink-library-cache-limit-modal')!;
    const dialog = overlay.querySelector<HTMLElement>('.lightink-modal-dialog')!;

    // 单一扣减（T4-A2）：bottom 通道完全交给 library.css 的门控规则
    // （触屏 padding-bottom: max(safe-bottom, keyboard-inset)）。不再写内联
    // paddingBottom——内联特异性更高，会把 sheet 的 safe-bottom 通道覆盖归零
    // （键盘收起时贴屏幕底缘，与 group/source sheet 不一致）。
    expect(overlay.style.paddingBottom).toBe('');
    // max-height 不含 keyboard-inset；inset=0（键盘收起）时与改版前的
    // calc(100dvh - 24px - 0px) 布局等价。
    expect(dialog.style.maxHeight).toBe('calc(100dvh - 24px)');
    expect(dialog.style.maxHeight).not.toContain('--lightink-keyboard-inset');
    manage.destroy();
  });

  it('defers the touch height budget to CSS so the keyboard-open anchor applies', () => {
    document.documentElement.setAttribute('data-android', '');
    const { options } = manageOptions();
    const manage = createLibraryManage(document, options);
    document.body.appendChild(manage.element);

    manage.element.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    const overlay = document.querySelector<HTMLElement>('.lightink-library-cache-limit-modal')!;
    const dialog = overlay.querySelector<HTMLElement>('.lightink-modal-dialog')!;

    // 触屏：bottom 偏移与高度预算都由 library.css 持有（含 html[data-keyboard]
    // 键盘态锚定 max-height: 100%），内联不再双扣、不再覆盖 sheet 的
    // max(safe-bottom, keyboard-inset) 通道。
    expect(overlay.style.paddingBottom).toBe('');
    expect(dialog.style.maxHeight).toBe('');
    manage.destroy();
  });
});

const zhTabLabels: LibraryTabbarLabels = {
  navigation: '书库导航',
  shelf: '书架',
  sources: '书源',
  manage: '管理',
};

function tabItems(bar: HTMLElement): HTMLButtonElement[] {
  return Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-library-tab-item]'));
}

describe('library tabbar', () => {
  it('renders shelf / sources / manage tabs in order with icons', () => {
    const bar = createLibraryTabbar(document, { labels: zhTabLabels, onSelect: vi.fn() });
    expect(bar.element.className).toBe('lightink-library-tabbar');
    expect(bar.element.getAttribute('aria-label')).toBe('书库导航');
    const items = tabItems(bar.element);
    expect(items.map((item) => item.dataset.libraryTabItem)).toEqual([
      'shelf',
      'sources',
      'manage',
    ]);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      '书架',
      '书源',
      '管理',
    ]);
    for (const item of items) {
      expect(item.querySelector('svg.lightink-library-tabbar-icon')).not.toBeNull();
    }
  });

  it('marks shelf active by default and reports taps through onSelect', () => {
    const onSelect = vi.fn();
    const bar = createLibraryTabbar(document, { labels: zhTabLabels, onSelect });
    const items = tabItems(bar.element);
    expect(items[0]!.classList.contains('is-active')).toBe(true);
    expect(items[0]!.getAttribute('aria-current')).toBe('page');

    items[1]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('sources');
    items[2]!.click();
    expect(onSelect).toHaveBeenCalledWith('manage');
  });

  it('moves the active marker with setActive', () => {
    const bar = createLibraryTabbar(document, { labels: zhTabLabels, onSelect: vi.fn() });
    bar.setActive('manage');
    const items = tabItems(bar.element);
    expect(items[2]!.classList.contains('is-active')).toBe(true);
    expect(items[2]!.getAttribute('aria-current')).toBe('page');
    expect(items[0]!.classList.contains('is-active')).toBe(false);
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('relabels tabs and the nav landmark on locale change', () => {
    const bar = createLibraryTabbar(document, { labels: zhTabLabels, onSelect: vi.fn() });
    bar.setLabels({
      navigation: 'Library navigation',
      shelf: 'Shelf',
      sources: 'Sources',
      manage: 'Manage',
    });
    expect(bar.element.getAttribute('aria-label')).toBe('Library navigation');
    expect(tabItems(bar.element).map((item) => item.textContent?.trim())).toEqual([
      'Shelf',
      'Sources',
      'Manage',
    ]);
  });
});

describe('createLibraryManage 摸鱼段（R2/R5–R10/R13，R12 桌面门控）', () => {
  const concealLabels = (): ConcealManageLabels => ({
    group: '摸鱼',
    groupHint: '仅在书架与阅读器界面生效。',
    bossKeyHint: '全局快捷键注册成功后系统级生效，可能影响其他应用的同名按键，可随时改键。',
    macBossKeyHint: 'macOS 默认使用 Ctrl+Z / Ctrl+X。',
    bossKey1: '老板键（隐藏 / 恢复窗口）',
    bossKey2: '退出快捷键',
    bossKeyActive: '当前生效：{combo}',
    bossKeyEmpty: '组合不能为空。',
    bossKeyInvalid: '无效组合或仅修饰键。',
    bossKeySame: '与另一快捷键相同。',
    bossKeyUnregistered: '未注册。',
    recordCombo: '按下组合键。',
    sceneNormal: '普通阅读',
    sceneHideOnLeave: '离开即隐',
    sceneFloating: '悬浮看文',
    sceneCustom: '自定义',
    groupDodge: '躲开',
    groupDisguise: '看起来不像在看书',
    groupFloat: '浮在工作上',
    groupExit: '退出快捷键',
    exitHint: '按下会退出轻墨。',
    needsTransparent: '需要先打开透明模式。',
    gradientHidden: '渐变要等透明模式关闭后才显示。',
    opacityScale: '100 为完全不透明，0 为完全淡出。',
    background: '页面背景',
    backgroundTheme: '主题背景',
    backgroundPresets: {
      lavender: '薰衣草',
      mint: '薄荷绿',
      peach: '蜜桃粉',
      sky: '天空蓝',
      butter: '奶油黄',
    },
    backgroundCustom: '自定义渐变',
    customFrom: '起始色',
    customTo: '结束色',
    transparentMode: '透明模式',
    contentOpacity: '不透明度（0–100%）',
    hideTop: '鼠标移出时隐藏顶栏',
    hideBody: '鼠标移出时隐藏主体',
    hideBottom: '鼠标移出时隐藏底栏',
    alwaysOnTop: '窗口置顶',
    miniWindow: '迷你窗口',
    clickThrough: '点击穿透',
    clickThroughHint: '需开启透明模式。',
    sceneNormalResult:
      '页面回到主题背景；窗口不透明；正文完全不透明；鼠标离开时不隐藏顶栏、正文或底栏；不置顶；不是迷你窗口；点击不穿透。',
    sceneHideOnLeaveResult:
      '保留已选页面背景；窗口透明；正文完全不透明；鼠标离开时隐藏顶栏、正文和底栏；置顶；不是迷你窗口；点击穿透，看得见的轻墨控件仍可操作。',
    sceneFloatingResult:
      '保留已选页面背景；窗口透明；正文不透明度为 60；鼠标离开时不隐藏顶栏、正文或底栏；置顶；迷你窗口；点击不穿透。',
    effectWindowTransparent: '窗口透明',
    effectWindowOpaque: '窗口不透明',
    effectOpacity: '正文不透明度为 {value}',
    effectHideNone: '鼠标离开时不隐藏顶栏、正文或底栏',
    effectHidePrefix: '鼠标离开时隐藏',
    regionSeparator: '、',
    regionTop: '顶栏',
    regionBody: '正文',
    regionBottom: '底栏',
    effectPinned: '置顶',
    effectNotPinned: '不置顶',
    effectMini: '迷你窗口',
    effectNotMini: '不是迷你窗口',
    effectClickThrough: '点击穿透，看得见的轻墨控件仍可操作',
    effectNoClickThrough: '点击不穿透',
    effectSeparator: '；',
  });

  const englishConcealLabels = (): ConcealManageLabels => ({
    ...concealLabels(),
    group: 'Stealth reading',
    bossKey1: 'Boss key (hide / restore window)',
    bossKey2: 'Exit shortcut',
    bossKeyEmpty: 'The combination cannot be empty.',
    bossKeyInvalid: 'Invalid combination, or modifiers only.',
    bossKeySame: 'Same as the other shortcut.',
    sceneNormal: 'Normal reading',
    sceneHideOnLeave: 'Hide on leave',
    sceneFloating: 'Floating read',
    sceneCustom: 'Custom',
    groupDodge: 'Duck away',
    groupDisguise: "Doesn't look like reading",
    groupFloat: 'Float over work',
    groupExit: 'Exit shortcut',
    exitHint: 'Pressing this quits LightInk.',
    needsTransparent: 'Turn on transparent mode first.',
    gradientHidden: 'The gradient shows after transparent mode is turned off.',
    opacityScale: '100 is fully opaque, 0 is fully faded.',
    contentOpacity: 'Content opacity (0–100%)',
    sceneNormalResult:
      'Page background returns to the theme; the window is opaque; text stays fully opaque; leaving does not hide the top bar, text, or bottom bar; not pinned; not a mini window; clicks do not pass through.',
    sceneHideOnLeaveResult:
      'Keeps the chosen page background; the window is transparent; text stays fully opaque; leaving hides the top bar, text, and bottom bar; pinned; not a mini window; clicks pass through, and visible LightInk controls still work.',
    sceneFloatingResult:
      'Keeps the chosen page background; the window is transparent; text opacity is 60; leaving does not hide the top bar, text, or bottom bar; pinned; mini window; clicks do not pass through.',
    effectWindowTransparent: 'Window is transparent',
    effectWindowOpaque: 'Window is opaque',
    effectOpacity: 'Text opacity is {value}',
    effectHideNone: 'Leaving does not hide the top bar, text, or bottom bar',
    effectHidePrefix: 'Leaving hides ',
    regionSeparator: ', ',
    regionTop: 'the top bar',
    regionBody: 'the text',
    regionBottom: 'the bottom bar',
    effectPinned: 'pinned',
    effectNotPinned: 'not pinned',
    effectMini: 'mini window',
    effectNotMini: 'not a mini window',
    effectClickThrough: 'clicks pass through, and visible LightInk controls still work',
    effectNoClickThrough: 'clicks do not pass through',
    effectSeparator: '; ',
    backgroundTheme: 'Theme background',
    backgroundPresets: {
      lavender: 'Lavender',
      mint: 'Mint',
      peach: 'Peach',
      sky: 'Sky',
      butter: 'Butter',
    },
    backgroundCustom: 'Custom gradient',
  });

  function concealDeps(prefs = defaultConcealPrefs(false)): {
    deps: ConcealManageDeps;
    updates: Partial<ConcealPrefs>[];
    bossKeyCalls: Array<{ primary: string; secondary: string }>;
    clearedRefusals: ConcealSwitchRefusalKey[];
    setPrefs: (next: ConcealPrefs) => void;
    setBossKeyResult: (result: ConcealBossKeysStatus) => void;
    refusals: Map<ConcealSwitchRefusalKey, string>;
  } {
    const updates: Partial<ConcealPrefs>[] = [];
    const bossKeyCalls: Array<{ primary: string; secondary: string }> = [];
    const clearedRefusals: ConcealSwitchRefusalKey[] = [];
    const refusals = new Map<ConcealSwitchRefusalKey, string>();
    let current = { ...prefs };
    let bossKeyResult: ConcealBossKeysStatus | null = null;
    let listener: ((key: ConcealSwitchRefusalKey, reason: string) => void) | null = null;
    return {
      deps: {
        labels: concealLabels,
        isMac: false,
        getPrefs: () => current,
        update: (update) => {
          updates.push(update);
          current = { ...current, ...update };
        },
        updateBossKeys: async (primary, secondary) => {
          bossKeyCalls.push({ primary, secondary });
          const result = bossKeyResult ?? {
            primary,
            secondary,
            primaryError: null,
            secondaryError: null,
          };
          if (result.primaryError === null && result.secondaryError === null) {
            current = { ...current, bossPrimary: primary, bossSecondary: secondary };
          }
          return result;
        },
        subscribeSwitchRefusal: (next) => {
          listener = next;
          for (const [key, reason] of refusals) {
            next(key, reason);
          }
          return () => {
            if (listener === next) listener = null;
          };
        },
        clearSwitchRefusal: (key) => {
          clearedRefusals.push(key);
          refusals.delete(key);
        },
      },
      updates,
      bossKeyCalls,
      clearedRefusals,
      refusals,
      setPrefs: (next) => {
        current = next;
      },
      setBossKeyResult: (result) => {
        bossKeyResult = result;
      },
    };
  }

  it('renders the conceal group on desktop but not when deps are absent (R12)', () => {
    const conceal = concealDeps();
    const { options } = manageOptions({ conceal: conceal.deps });
    const manage = createLibraryManage(document, options);
    expect(groupTitles(manage.element)).toContain('conceal');

    const plain = createLibraryManage(document, manageOptions().options);
    expect(groupTitles(plain.element)).not.toContain('conceal');
  });

  it('shows the global-shortcut impact hint and the macOS Ctrl default note only on mac', () => {
    const mac = concealDeps();
    const macDeps: ConcealManageDeps = { ...mac.deps, isMac: true };
    const macManage = createLibraryManage(
      document,
      manageOptions({ conceal: macDeps }).options,
    );
    const macText = macManage.element.textContent ?? '';
    expect(macText).toContain('可能影响其他应用的同名按键');
    expect(macText).toContain('macOS 默认使用 Ctrl');

    const pc = concealDeps();
    const pcManage = createLibraryManage(document, manageOptions({ conceal: pc.deps }).options);
    expect(pcManage.element.textContent ?? '').not.toContain('macOS 默认使用 Ctrl');
  });

  it('capturing a combo on the boss key field registers it and shows the active status', async () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const primary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossPrimary"]',
    );
    expect(primary).not.toBeNull();

    primary!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(conceal.bossKeyCalls).toHaveLength(1));
    expect(conceal.bossKeyCalls[0]).toEqual({ primary: 'Control+Shift+Z', secondary: 'Alt+X' });
    await vi.waitFor(() =>
      expect(manage.element.textContent).toContain('当前生效：Control+Shift+Z'),
    );
  });

  it('modifier-only presses preview but never register (R2 纯修饰键)', async () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const primary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossPrimary"]',
    )!;
    primary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(primary.value).toBe('Shift');
    await Promise.resolve();
    expect(conceal.bossKeyCalls).toHaveLength(0);
  });

  it('Escape cancels recording and restores the saved combo', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const primary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossPrimary"]',
    )!;
    primary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true, cancelable: true }),
    );
    primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(primary.value).toBe('Alt+Z');
  });

  it('toggling switches and changing background/opacity route through update()', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const toggles = manage.element.querySelectorAll<HTMLInputElement>('[data-conceal-toggle]');
    expect(toggles.length).toBe(7);

    const transparent = [...toggles].find((t) => t.dataset.concealToggle === 'transparentMode')!;
    transparent.checked = true;
    transparent.dispatchEvent(new Event('change', { bubbles: true }));

    const mini = [...toggles].find((t) => t.dataset.concealToggle === 'miniWindow')!;
    mini.checked = true;
    mini.dispatchEvent(new Event('change', { bubbles: true }));

    manage.element
      .querySelector<HTMLButtonElement>('[data-conceal-background="sky"]')!
      .click();

    const opacity = manage.element.querySelector<HTMLInputElement>('[data-conceal-opacity]')!;
    opacity.value = '55';
    opacity.dispatchEvent(new Event('change', { bubbles: true }));

    expect(conceal.updates).toContainEqual({ transparentMode: true });
    expect(conceal.updates).toContainEqual({ miniWindow: true });
    expect(conceal.updates).toContainEqual({ background: { kind: 'preset', preset: 'sky' } });
    expect(conceal.updates).toContainEqual({ contentOpacity: 55 });
  });

  it('keeps transparent mode off and shows a reason when the update does not stick', () => {
    const conceal = concealDeps();
    const stuck = {
      ...conceal.deps,
      update: (update: Partial<ConcealPrefs>) => {
        conceal.updates.push(update);
      },
    };
    const manage = createLibraryManage(document, manageOptions({ conceal: stuck }).options);
    const toggle = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-toggle="transparentMode"]',
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).toContainEqual({ transparentMode: true });
    expect(toggle.checked).toBe(false);
    const reason = manage.element.querySelector<HTMLElement>(
      '[data-conceal-switch-reason="transparentMode"]',
    )!;
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toContain('没有生效');
  });

  it('out-of-range opacity is not saved and falls back to the effective value (R6)', () => {
    const conceal = concealDeps({ ...defaultConcealPrefs(false), contentOpacity: 60 });
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const opacity = manage.element.querySelector<HTMLInputElement>('[data-conceal-opacity]')!;
    opacity.value = '250';
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).toHaveLength(0);
    expect(opacity.value).toBe('60');

    opacity.value = '55.5';
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    opacity.value = '';
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).toHaveLength(0);
    expect(opacity.value).toBe('60');
  });

  it('custom colors commit through update() and the row only shows for custom', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const customRow = manage.element.querySelector<HTMLElement>('.lightink-library-conceal-custom-row')!;
    expect(customRow.hidden).toBe(true);

    manage.element
      .querySelector<HTMLButtonElement>('[data-conceal-background="custom"]')!
      .click();
    expect(conceal.updates).toContainEqual({
      background: { kind: 'custom', from: '#c9b6e4', to: '#f1e9fb' },
    });
    expect(customRow.hidden).toBe(false);

    const from = manage.element.querySelector<HTMLInputElement>('input[type="color"]')!;
    from.value = '#123456';
    from.dispatchEvent(new Event('change', { bubbles: true }));
    const to = manage.element.querySelectorAll<HTMLInputElement>('input[type="color"]')[1]!;
    to.value = '#abcdef';
    to.dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).toContainEqual({
      background: { kind: 'custom', from: '#123456', to: '#abcdef' },
    });
  });

  it('shows three groups, scenes, and the collapsed boss-key summary in Chinese and English', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const group = manage.element.querySelector<HTMLElement>('[data-manage-group="conceal"]')!;
    expect(group.dataset.collapsed).toBe('true');
    const title = group.querySelector(':scope > h2')!;
    expect(title.textContent).toContain('摸鱼');
    expect(title.textContent).toContain('普通阅读');
    expect(title.textContent).toContain('Alt+Z');
    expect(group.querySelector('[data-conceal-group="dodge"] h3')?.textContent).toBe('躲开');
    expect(group.querySelector('[data-conceal-group="disguise"] h3')?.textContent).toBe(
      '看起来不像在看书',
    );
    expect(group.querySelector('[data-conceal-group="float"] h3')?.textContent).toBe('浮在工作上');
    expect(group.textContent).toContain('离开即隐');
    expect(group.textContent).toContain('悬浮看文');
    expect(group.querySelector('[data-conceal-scene="custom"]')?.textContent).toBe('自定义');
    expect(group.querySelector('[data-conceal-scene-result="normal"]')?.textContent).toBe(
      concealLabels().sceneNormalResult,
    );
    expect(group.querySelector('[data-conceal-scene-result="hideOnLeave"]')?.textContent).toBe(
      concealLabels().sceneHideOnLeaveResult,
    );
    expect(group.querySelector('[data-conceal-scene-result="floating"]')?.textContent).toBe(
      concealLabels().sceneFloatingResult,
    );
    expect(group.querySelector('[data-conceal-scene="hideOnLeave"]')?.contains(
      group.querySelector('[data-conceal-scene-result="hideOnLeave"]'),
    )).toBe(false);
    expect(group.querySelector<HTMLElement>('[data-conceal-custom-effect]')?.hidden).toBe(true);
    expect(group.querySelector('[data-conceal-key-name="bossPrimary"]')?.textContent).toBe(
      '老板键（隐藏 / 恢复窗口）',
    );
    expect(group.querySelector('[data-conceal-key-name="bossSecondary"]')?.textContent).toBe(
      '退出快捷键',
    );
    expect(group.textContent).toContain('不透明度（0–100%）');
    expect(group.textContent).toContain('100 为完全不透明，0 为完全淡出。');

    const english = concealDeps();
    const englishManage = createLibraryManage(
      document,
      manageOptions({
        conceal: { ...english.deps, labels: englishConcealLabels },
      }).options,
    );
    const englishGroup = englishManage.element.querySelector<HTMLElement>(
      '[data-manage-group="conceal"]',
    )!;
    expect(englishGroup.querySelector(':scope > h2')?.textContent).toContain('Normal reading');
    expect(englishGroup.querySelector(':scope > h2')?.textContent).toContain('Alt+Z');
    expect(englishGroup.textContent).toContain('Duck away');
    expect(englishGroup.textContent).toContain("Doesn't look like reading");
    expect(englishGroup.textContent).toContain('Float over work');
    expect(englishGroup.textContent).toContain('Hide on leave');
    expect(englishGroup.textContent).toContain('Floating read');
    expect(englishGroup.textContent).toContain('Custom');
    expect(englishGroup.textContent).toContain('100 is fully opaque, 0 is fully faded.');
    expect(englishGroup.querySelector('[data-conceal-scene-result="normal"]')?.textContent).toBe(
      englishConcealLabels().sceneNormalResult,
    );
    expect(englishGroup.textContent).not.toContain('页面回到主题背景');
    expect(englishGroup.querySelector('[data-conceal-key-name="bossPrimary"]')?.textContent).toBe(
      'Boss key (hide / restore window)',
    );
    expect(englishGroup.querySelector('[data-conceal-key-name="bossSecondary"]')?.textContent).toBe(
      'Exit shortcut',
    );
  });

  it('keeps the boss key free of exit wording and puts quit in its own group', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const dodge = manage.element.querySelector<HTMLElement>('[data-conceal-group="dodge"]')!;
    const exit = manage.element.querySelector<HTMLElement>('[data-conceal-group="exit"]')!;
    expect(dodge.querySelector('[data-conceal-key-field="bossPrimary"]')).not.toBeNull();
    expect(dodge.querySelector('[data-conceal-key-field="bossSecondary"]')).toBeNull();
    expect(dodge.textContent).not.toContain('退出');
    expect(exit.querySelector('[data-conceal-key-field="bossSecondary"]')).not.toBeNull();
    expect(exit.textContent).toContain('按下会退出轻墨。');
    expect(manage.element.querySelector('[data-conceal-group="disguise"] [data-conceal-toggle="transparentMode"]')).not.toBeNull();
    expect(manage.element.querySelector('[data-conceal-group="float"] [data-conceal-toggle="alwaysOnTop"]')).not.toBeNull();
    expect(manage.element.querySelector('[data-conceal-group="float"] [data-conceal-toggle="clickThrough"]')).not.toBeNull();
  });

  it('rejects empty, modifier-only, and duplicate combos without replacing the saved one', async () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const primary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossPrimary"]',
    )!;
    const status = manage.element.querySelector<HTMLElement>(
      '[data-conceal-key-status="bossPrimary"]',
    )!;

    primary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true, cancelable: true }),
    );
    expect(conceal.bossKeyCalls).toHaveLength(0);
    expect(primary.value).toBe('Alt+Z');
    expect(status.textContent).toBe('组合不能为空。');

    primary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(conceal.bossKeyCalls).toHaveLength(0);
    expect(primary.value).toBe('Alt+Z');
    expect(status.textContent).toBe('与另一快捷键相同。');

    primary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(primary.value).toBe('Alt+Z');
    primary.dispatchEvent(new FocusEvent('blur'));
    expect(primary.value).toBe('Alt+Z');
    expect(conceal.bossKeyCalls).toHaveLength(0);

    const secondary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossSecondary"]',
    )!;
    secondary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', altKey: true, bubbles: true, cancelable: true }),
    );
    expect(secondary.value).toBe('Alt+X');
    expect(
      manage.element.querySelector('[data-conceal-key-status="bossSecondary"]')?.textContent,
    ).toBe('与另一快捷键相同。');
  });

  it('shows the registrar error beside the field and keeps the previous combo', async () => {
    const conceal = concealDeps();
    conceal.setBossKeyResult({
      primary: null,
      secondary: null,
      primaryError: '系统拒绝注册',
      secondaryError: null,
    });
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const primary = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-key-field="bossPrimary"]',
    )!;
    primary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'q', altKey: true, bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() =>
      expect(
        manage.element.querySelector('[data-conceal-key-status="bossPrimary"]')?.textContent,
      ).toBe('系统拒绝注册'),
    );
    expect(primary.value).toBe('Alt+Z');
    expect(conceal.bossKeyCalls).toEqual([{ primary: 'Alt+Q', secondary: 'Alt+X' }]);
  });

  it('locks hide-top, hide-body, and click-through until transparent mode is on', () => {
    const conceal = concealDeps({
      ...defaultConcealPrefs(false),
      hideTop: true,
      hideBody: false,
      clickThrough: true,
      hideBottom: false,
    });
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const toggle = (key: string): HTMLInputElement =>
      manage.element.querySelector<HTMLInputElement>(`[data-conceal-toggle="${key}"]`)!;
    const reason = (key: string): HTMLElement =>
      manage.element.querySelector<HTMLElement>(`[data-conceal-switch-reason="${key}"]`)!;

    expect(toggle('hideTop').disabled).toBe(true);
    expect(toggle('hideTop').checked).toBe(true);
    expect(toggle('hideBody').disabled).toBe(true);
    expect(toggle('clickThrough').disabled).toBe(true);
    expect(toggle('clickThrough').checked).toBe(true);
    expect(toggle('hideBottom').disabled).toBe(false);
    expect(reason('hideTop').textContent).toBe('需要先打开透明模式。');
    expect(reason('hideBody').textContent).toBe('需要先打开透明模式。');
    expect(reason('clickThrough').textContent).toBe('需要先打开透明模式。');

    toggle('hideTop').checked = false;
    toggle('hideTop').dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).not.toContainEqual({ hideTop: false });
    expect(toggle('hideTop').checked).toBe(true);

    toggle('hideBottom').checked = true;
    toggle('hideBottom').dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.updates).toContainEqual({ hideBottom: true });

    toggle('transparentMode').checked = true;
    toggle('transparentMode').dispatchEvent(new Event('change', { bubbles: true }));
    expect(toggle('hideTop').disabled).toBe(false);
    expect(reason('hideTop').hidden).toBe(true);
    expect(
      manage.element.querySelector<HTMLElement>('[data-conceal-gradient-note]')?.hidden,
    ).toBe(false);
    manage.element.querySelector<HTMLButtonElement>('[data-conceal-background="mint"]')!.click();
    expect(conceal.updates).toContainEqual({ background: { kind: 'preset', preset: 'mint' } });
  });

  it('shows a refusal beside the switch that was turned back off', () => {
    const conceal = concealDeps();
    conceal.refusals.set('alwaysOnTop', '置顶被系统拒绝，开关已回退。系统拒绝');
    conceal.setPrefs({ ...defaultConcealPrefs(false), alwaysOnTop: false, transparentMode: true });
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    const toggle = manage.element.querySelector<HTMLInputElement>(
      '[data-conceal-toggle="alwaysOnTop"]',
    )!;
    const reason = manage.element.querySelector<HTMLElement>(
      '[data-conceal-switch-reason="alwaysOnTop"]',
    )!;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toContain('置顶被系统拒绝');
    expect(reason.closest('[data-conceal-switch="alwaysOnTop"]')).not.toBeNull();

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(conceal.clearedRefusals).toContain('alwaysOnTop');
    expect(reason.hidden).toBe(true);
  });

  it('applies a scene through the shared scene function and then shows custom', () => {
    const conceal = concealDeps();
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    manage.element.querySelector<HTMLButtonElement>('[data-conceal-scene="floating"]')!.click();
    expect(conceal.updates[conceal.updates.length - 1]).toEqual(
      applyConcealScene(defaultConcealPrefs(false), 'floating'),
    );
    expect(conceal.bossKeyCalls).toHaveLength(0);
    expect(manage.element.querySelector(':scope [data-manage-group="conceal"] > h2, [data-manage-group="conceal"] > h2')?.textContent).toContain(
      '悬浮看文',
    );

    const opacity = manage.element.querySelector<HTMLInputElement>('[data-conceal-opacity]')!;
    opacity.value = '80';
    opacity.dispatchEvent(new Event('change', { bubbles: true }));
    const title = manage.element.querySelector('[data-manage-group="conceal"] > h2');
    expect(title?.textContent).toContain('自定义');
    expect(
      manage.element.querySelector('[data-conceal-scene="custom"]')?.classList.contains('is-active'),
    ).toBe(true);
    expect(
      manage.element.querySelector('[data-conceal-scene="floating"]')?.getAttribute('aria-checked'),
    ).toBe('false');
    expect(manage.element.querySelector('[data-conceal-scene="custom"]')?.tagName).toBe('SPAN');
    expect(manage.element.querySelector('[data-conceal-scene="custom"]')?.textContent).toBe('自定义');
    const effect = manage.element.querySelector<HTMLElement>('[data-conceal-custom-effect]');
    expect(effect?.hidden).toBe(false);
    expect(effect?.textContent).toBe(
      '窗口透明；正文不透明度为 80；鼠标离开时不隐藏顶栏、正文或底栏；置顶；迷你窗口；点击不穿透',
    );
    expect(manage.element.querySelector('[data-conceal-scene="custom"]')?.contains(effect)).toBe(false);
    const updatesBeforeCustom = conceal.updates.length;
    manage.element.querySelector('[data-conceal-scene="custom"]')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(conceal.updates).toHaveLength(updatesBeforeCustom);
  });

  it('describes only effects that still apply after transparent mode is turned off', () => {
    const conceal = concealDeps({
      ...defaultConcealPrefs(false),
      transparentMode: false,
      hideTop: true,
      hideBody: true,
      hideBottom: true,
      alwaysOnTop: true,
      clickThrough: true,
    });
    const manage = createLibraryManage(document, manageOptions({ conceal: conceal.deps }).options);
    expect(manage.element.querySelector<HTMLElement>('[data-conceal-custom-effect]')?.textContent).toBe(
      '窗口不透明；正文不透明度为 100；鼠标离开时隐藏底栏；置顶；不是迷你窗口；点击不穿透',
    );
  });
});
