// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { showSyncPanel } from '../sync-panel.js';
import type { SyncPanelDeps } from '../sync-panel.js';
import type { SyncStatus } from '../sync-client.js';
import type { SyncProfileInput } from '../webdav-client.js';
import type { ManagedMigrationPreview, ManagedMigrationResult } from '../../library/library-client.js';
import { applyReaderTheme, READER_THEME_STORAGE_KEY } from '../../reader/reader-theme.js';

const idle: SyncStatus = {
  state: 'idle',
  uploaded: 0,
  downloaded: 0,
  conflicts: 0,
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('sync panel', () => {
  it('saves a WebDAV profile and runs a manual sync', async () => {
    const panelDeps = createDeps();
    const saveProfile = vi.fn(async (input: SyncProfileInput) => ({
      id: input.id ?? 'profile-1',
      name: input.name,
      url: input.url,
      authType: input.authType,
      allowHttp: input.allowHttp === true,
      needsCredential: false,
      updatedAt: 1,
    }));
    const run = vi.fn(async () => ({ ...idle, state: 'success' as const, uploaded: 2 }));
    panelDeps.webdav.saveProfile = saveProfile;
    panelDeps.sync.run = run;
    showSyncPanel(panelDeps);

    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog');
    expect(dialog).not.toBeNull();
    const fields = dialog!.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    fields[0]!.value = 'Nextcloud';
    fields[1]!.value = 'https://dav.example/remote.php/dav/files/me';
    const username = fields[2]!;
    const password = fields[3]!;
    username.value = 'me';
    password.value = 'app-password';
    const save = button(dialog!, '保存配置');
    save.click();
    await settle();

    expect(saveProfile).toHaveBeenCalledWith({
      name: 'Nextcloud',
      url: 'https://dav.example/remote.php/dav/files/me',
      authType: 'basic',
      allowHttp: false,
      credential: { kind: 'basic', username: 'me', password: 'app-password' },
    });
    button(dialog!, '立即同步').click();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(dialog!.textContent).toContain('↑2');
    button(dialog!, '关闭').click();
    expect(document.querySelector('.lightink-sync-dialog')).toBeNull();
  });

  it('renders migration candidates and applies selected entries', async () => {
    const panelDeps = createDeps();
    const apply = vi.fn(async (): Promise<ManagedMigrationResult> => ({
      migrated: 1,
      duplicates: 0,
      failed: [],
      aliases: [],
    }));
    const preview = vi.fn(async (): Promise<ManagedMigrationPreview> => ({
      entries: [
        {
          itemId: 'local:/book.epub',
          title: '书籍',
          path: '/book.epub',
          status: 'ready' as const,
          size: 1024,
        },
        {
          itemId: 'local:/duplicate.epub',
          title: '重复正文',
          path: '/duplicate.epub',
          status: 'duplicate' as const,
          size: 1024,
        },
      ],
    }));
    showSyncPanel({ ...panelDeps, migration: { preview, apply } });
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '预览迁移').click();
    await settle();
    const checkbox = dialog.querySelector<HTMLInputElement>('.lightink-sync-migration-row input')!;
    expect(
      dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-migration-row input')[1]!.disabled,
    ).toBe(false);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    button(dialog, '导入选中').click();
    await settle();
    expect(apply).toHaveBeenCalledWith(['local:/book.epub']);
    button(dialog, '关闭').click();
  });

  it('reports required WebDAV capabilities that the server lacks', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.testProfile = vi.fn(async () => ({
      reachable: true,
      supportsPropfind: true,
      supportsMkcol: true,
      supportsMove: false,
      supportsConditionalPut: false,
      finalUrl: 'https://dav.example',
    }));
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '测试连接').click();
    await settle();
    expect(dialog.textContent).toContain('服务器缺少同步所需的 WebDAV 能力');
    expect(dialog.textContent).toContain('MOVE, If-None-Match');
  });

  it('shows only the credential fields that match the selected sign-in method', async () => {
    showSyncPanel(createDeps());
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const auth = dialog.querySelector('select')!;
    const hint = dialog.querySelector('.lightink-sync-auth-hint')!;
    const fields = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    const username = fields[2]!.parentElement!;
    const password = fields[3]!.parentElement!;
    const token = fields[4]!.parentElement!;

    expect(auth.value).toBe('basic');
    expect(hint.textContent).toContain('应用密码');
    expect(username.hidden).toBe(false);
    expect(password.hidden).toBe(false);
    expect(token.hidden).toBe(true);

    auth.value = 'bearer';
    auth.dispatchEvent(new Event('change'));
    expect(hint.textContent).toContain('访问令牌');
    expect(username.hidden).toBe(true);
    expect(password.hidden).toBe(true);
    expect(token.hidden).toBe(false);
    button(dialog, '关闭').click();
  });

  it('groups connection, status, and danger actions into separate sections', async () => {
    const panelDeps = createDeps();
    showSyncPanel({ ...panelDeps, migration: { preview: vi.fn(async () => ({ entries: [] })), apply: vi.fn(async () => ({ migrated: 0, duplicates: 0, failed: [], aliases: [] })) } });
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const titles = [...dialog.querySelectorAll('.lightink-sync-section-title')].map((el) => el.textContent);
    expect(titles).toEqual(['连接', '状态', '冲突', '管理旧书', '危险操作']);
    expect(dialog.querySelector('.lightink-sync-form-actions')?.textContent).toContain('保存配置');
    expect(dialog.querySelector('.lightink-sync-status-actions')?.textContent).toContain('立即同步');
    expect(dialog.querySelector('.lightink-sync-section--danger')?.textContent).toContain('忘记目标');
    expect(dialog.querySelector('.lightink-sync-footer')?.textContent).toContain('关闭');
    expect(dialog.querySelector('.lightink-sync-status-state')?.textContent).toBe('就绪');
    button(dialog, '关闭').click();
  });

  it('keeps the configured profile visible when forgetting it fails', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.getProfile = vi.fn(async () => ({
      id: 'profile-1',
      name: 'Nextcloud',
      url: 'https://dav.example',
      authType: 'basic' as const,
      allowHttp: false,
      needsCredential: false,
      updatedAt: 1,
    }));
    panelDeps.webdav.forgetProfile = vi.fn(async () => {
      throw new Error('disk is read-only');
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '忘记目标').click();
    await settle();

    const fields = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    expect(fields[0]!.value).toBe('Nextcloud');
    expect(fields[1]!.value).toBe('https://dav.example');
    expect(dialog.textContent).toContain('disk is read-only');
  });

  it('paints the dialog with reader paper instead of editor cream', () => {
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    applyReaderTheme(host, 'white');
    document.body.append(host);
    showSyncPanel({ ...createDeps(), themeHost: host });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.dataset.readerTheme).toBe('white');
    expect(overlay!.style.getPropertyValue('--lightink-bg')).toBe('#ffffff');
    expect(overlay!.style.getPropertyValue('--lightink-accent')).toBe('#1a1a1a');
    expect(overlay!.style.backgroundColor).toBe('');
    host.remove();
  });

  it('falls back to the stored reader theme when no book host is mounted', () => {
    const storage = {
      getItem: (key: string) => (key === READER_THEME_STORAGE_KEY ? 'night' : null),
      setItem: () => undefined,
    };
    showSyncPanel({ ...createDeps(), themeStorage: storage });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay!.dataset.readerTheme).toBe('night');
    expect(overlay!.style.getPropertyValue('--lightink-bg')).toBe('#121212');
    expect(overlay!.style.getPropertyValue('--lightink-fg')).toBe('#c8c8c8');
  });

  it('closes on Escape so the Android back chain returns to the manage page', async () => {
    const onClose = vi.fn();
    showSyncPanel({ ...createDeps(), onClose });
    await settle();
    expect(document.querySelector('.lightink-sync-dialog')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(document.querySelector('.lightink-sync-dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('presents full-screen with touch-sized controls at the ≤760px mobile breakpoint', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    // 全屏呈现：铺满视口、去掉边框圆角，仅门控在移动 chrome flag 下。
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-sync-dialog\s*\{[^}]*max-width:\s*100vw[^}]*max-height:\s*none[^}]*border-radius:\s*0/,
    );
    // 页脚保留关闭 affordance，按钮触控目标 ≥44px。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-sync-dialog \.lightink-modal-btn\s*\{[^}]*min-height:\s*44px/,
    );
    // 输入 44px 高 + 16px 字号（避免移动 WebView 聚焦自动放大）。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-sync-field input,[\s\S]*?\.lightink-sync-field select\s*\{[^}]*min-height:\s*44px[^}]*font-size:\s*16px/,
    );
    // 冲突/迁移列表行保持整行触控目标。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-sync-checkbox,[\s\S]*?\.lightink-sync-migration-row\s*\{[^}]*min-height:\s*44px/,
    );
  });
});

function button(root: ParentNode, label: string): HTMLButtonElement {
  const value = Array.from(root.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!(value instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return value;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createDeps(): SyncPanelDeps {
  return {
    doc: document,
    webdav: {
      getProfile: vi.fn(async () => null),
      saveProfile: vi.fn(async (input: SyncProfileInput) => ({
        id: input.id ?? 'profile-1',
        name: input.name,
        url: input.url,
        authType: input.authType,
        allowHttp: input.allowHttp === true,
        needsCredential: false,
        updatedAt: 1,
      })),
      testProfile: vi.fn(async () => ({
        reachable: true,
        supportsPropfind: true,
        supportsMkcol: true,
        supportsMove: true,
        supportsConditionalPut: true,
        finalUrl: 'https://dav.example',
      })),
      forgetProfile: vi.fn(async () => undefined),
    },
    sync: {
      status: vi.fn(async () => idle),
      run: vi.fn(async () => idle),
      cancel: vi.fn(async () => undefined),
      listConflicts: vi.fn(async () => []),
      resolveConflict: vi.fn(async () => undefined),
    },
    migration: undefined,
    locale: 'zh-CN',
  };
}
