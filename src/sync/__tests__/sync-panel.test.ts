// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { showSyncPanel, SYNC_ERROR_TITLES } from '../sync-panel.js';
import type { SyncPanelDeps } from '../sync-panel.js';
import type { SyncStatus } from '../sync-client.js';
import type { SyncProfileInput } from '../webdav-client.js';
import type { ManagedMigrationPreview, ManagedMigrationResult } from '../../library/library-client.js';
import { applyLibraryTheme, LIBRARY_THEME_STORAGE_KEY } from '../../library/library-theme.js';
import { applyReaderTheme } from '../../reader/reader-theme.js';

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

  it('names empty sync fields and keeps typed address and credentials when save fails', async () => {
    const panelDeps = createDeps();
    const saveProfile = vi.fn(async () => {
      throw new Error('disk is read-only');
    });
    panelDeps.webdav.saveProfile = saveProfile;
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const fields = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    const captions = [...dialog.querySelectorAll('.lightink-sync-field span')].map(
      (node) => node.textContent,
    );
    expect(fields[0]!.placeholder).not.toBe(captions[0]);
    expect(fields[1]!.placeholder).not.toBe(captions[1]);
    expect(fields[1]!.placeholder).toContain('https://');
    expect(fields[2]!.placeholder).not.toBe(captions[2]);
    expect(fields[3]!.placeholder).not.toBe(captions[3]);
    expect(fields[4]!.placeholder).not.toBe(captions[4]);

    button(dialog, '保存配置').click();
    await settle();
    expect(saveProfile).not.toHaveBeenCalled();
    const missingMessage = dialog.querySelector('.lightink-sync-message')?.textContent ?? '';
    expect(missingMessage).toContain('还没填写：');
    expect(missingMessage).toContain('名称');
    expect(missingMessage).toContain('WebDAV 地址');
    expect(missingMessage).toContain('用户名');
    expect(missingMessage).toContain('应用密码');
    expect(fields[0]!.getAttribute('aria-invalid')).toBe('true');
    expect(fields[1]!.getAttribute('aria-invalid')).toBe('true');

    fields[0]!.value = 'Nextcloud';
    fields[1]!.value = 'https://dav.example/remote.php/dav/files/me';
    fields[2]!.value = 'me';
    button(dialog, '保存配置').click();
    await settle();
    expect(saveProfile).not.toHaveBeenCalled();
    expect(dialog.querySelector('.lightink-sync-message')?.textContent).toContain('应用密码');
    expect(fields[1]!.value).toBe('https://dav.example/remote.php/dav/files/me');
    expect(fields[2]!.value).toBe('me');

    fields[3]!.value = 'app-password';
    button(dialog, '保存配置').click();
    await settle();
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(fields[0]!.value).toBe('Nextcloud');
    expect(fields[1]!.value).toBe('https://dav.example/remote.php/dav/files/me');
    expect(fields[2]!.value).toBe('me');
    expect(fields[3]!.value).toBe('app-password');
    expect(dialog.textContent).toContain('disk is read-only');

    const auth = dialog.querySelector('select')!;
    auth.value = 'bearer';
    auth.dispatchEvent(new Event('change'));
    fields[4]!.value = '';
    button(dialog, '保存配置').click();
    await settle();
    expect(dialog.querySelector('.lightink-sync-message')?.textContent).toContain('访问令牌');
    expect(saveProfile).toHaveBeenCalledTimes(1);
    fields[4]!.value = 'token-value';
    expect(fields[4]!.value).toBe('token-value');
    button(dialog, '关闭').click();
  });

  it('names empty English sync fields without using the label as the placeholder', async () => {
    showSyncPanel({ ...createDeps(), locale: 'en' });
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const url = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input')[1]!;
    expect(url.placeholder).not.toBe('WebDAV URL');
    button(dialog, 'Save').click();
    await settle();
    const message = dialog.querySelector('.lightink-sync-message')?.textContent ?? '';
    expect(message).toContain('Still empty:');
    expect(message).toContain('Name');
    expect(message).toContain('WebDAV URL');
    expect(message).toContain('Username');
    expect(message).toContain('App password');
    button(dialog, 'Close').click();
  });

  it('counts skipped remote files in the ↑ total so a no-op sync does not show ↑0', async () => {
    const panelDeps = createDeps();
    const done: SyncStatus = {
      state: 'success',
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      skipped: 16,
      finishedAt: Date.parse('2026-09-05T23:43:17'),
    };
    panelDeps.sync.status = vi.fn(async () => done);
    panelDeps.sync.run = vi.fn(async () => done);
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    expect(dialog.textContent).toContain('↑16');
    expect(dialog.textContent).toContain('↷16');
    button(dialog, '立即同步').click();
    await settle();
    expect(document.querySelector('.lightink-sync-status')?.textContent).toContain('↑16');
    button(dialog, '关闭').click();
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

  it('maps WebDavError codes to localized titles and keeps the raw message in an expandable detail', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.saveProfile = vi.fn(async () => {
      // Tauri 序列化 WebDavError 的真实形状：{code, message, status}。
      throw { code: 'SYNC_URL_INVALID', message: 'WebDAV 地址格式无效', status: null };
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const fields = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    fields[0]!.value = 'Nextcloud';
    fields[1]!.value = 'not-a-url';
    fields[2]!.value = 'me';
    fields[3]!.value = 'app-password';
    button(dialog, '保存配置').click();
    await settle();

    const message = dialog.querySelector<HTMLElement>('.lightink-sync-message')!;
    const title = message.querySelector('.lightink-sync-message-text')!.textContent ?? '';
    const detail = message.querySelector<HTMLDetailsElement>('.lightink-sync-message-detail');
    expect(title).toBe('WebDAV 地址无效。');
    expect(detail).not.toBeNull();
    expect(detail!.querySelector('summary')?.textContent).toBe('技术详情');
    expect(detail!.querySelector('pre')?.textContent).toBe('WebDAV 地址格式无效');
    expect(message.dataset.kind).toBe('error');
    button(dialog, '关闭').click();
  });

  it('localizes test-connection failures from the error code, not the raw message', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.testProfile = vi.fn(async () => {
      throw { code: 'SYNC_NETWORK_ERROR', message: 'error sending request for url (...)' };
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '测试连接').click();
    await settle();
    const message = dialog.querySelector<HTMLElement>('.lightink-sync-message')!;
    expect(message.querySelector('.lightink-sync-message-text')?.textContent).toBe(
      '无法连接 WebDAV 服务器，请检查地址与网络。',
    );
    expect(message.querySelector('.lightink-sync-message-detail pre')?.textContent).toContain(
      'error sending request',
    );
    button(dialog, '关闭').click();
  });

  it('keeps unknown sync failures on the fallback title with the raw text as detail', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.saveProfile = vi.fn(async () => {
      throw new Error('disk is read-only');
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const fields = dialog.querySelectorAll<HTMLInputElement>('.lightink-sync-field input');
    fields[0]!.value = 'Nextcloud';
    fields[1]!.value = 'https://dav.example/remote.php/dav/files/me';
    fields[2]!.value = 'me';
    fields[3]!.value = 'app-password';
    button(dialog, '保存配置').click();
    await settle();
    const message = dialog.querySelector<HTMLElement>('.lightink-sync-message')!;
    expect(message.querySelector('.lightink-sync-message-text')?.textContent).toBe('同步失败');
    expect(message.querySelector('.lightink-sync-message-detail')?.textContent).toContain(
      'disk is read-only',
    );
    button(dialog, '关闭').click();
  });

  it('shows the localized status-line title for an error state and expands lastError as detail', async () => {
    const panelDeps = createDeps();
    panelDeps.sync.status = vi.fn(async () => ({
      state: 'error' as const,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      lastError: '无法读取同步记录: database is locked',
    }));
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const status = dialog.querySelector<HTMLElement>('.lightink-sync-status')!;
    expect(status.querySelector('.lightink-sync-status-state')?.textContent).toBe('同步失败');
    const detail = status.querySelector<HTMLDetailsElement>('.lightink-sync-status-detail');
    expect(detail).not.toBeNull();
    expect(detail!.hidden).toBe(false);
    expect(detail!.querySelector('pre')?.textContent).toBe(
      '无法读取同步记录: database is locked',
    );
    button(dialog, '关闭').click();
  });

  it('localizes rejected credentials (401) instead of degrading to the generic title', async () => {
    const panelDeps = createDeps();
    // R4 验收场景：密码错误 → 后端 401 → SYNC_AUTH_REQUIRED（response_error 家族）。
    panelDeps.webdav.testProfile = vi.fn(async () => {
      throw { code: 'SYNC_AUTH_REQUIRED', message: 'WebDAV 需要重新输入凭据', status: 401 };
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '测试连接').click();
    await settle();
    const message = dialog.querySelector<HTMLElement>('.lightink-sync-message')!;
    expect(message.querySelector('.lightink-sync-message-text')?.textContent).toBe(
      'WebDAV 服务器拒绝了登录，请检查用户名和密码。',
    );
    expect(message.querySelector('.lightink-sync-message-detail pre')?.textContent).toBe(
      'WebDAV 需要重新输入凭据',
    );
    button(dialog, '关闭').click();
  });

  it('interpolates the HTTP status into the SYNC_HTTP_ERROR title', async () => {
    const panelDeps = createDeps();
    panelDeps.webdav.testProfile = vi.fn(async () => {
      throw { code: 'SYNC_HTTP_ERROR', message: '创建 WebDAV 目录失败', status: 507 };
    });
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    button(dialog, '测试连接').click();
    await settle();
    const message = dialog.querySelector<HTMLElement>('.lightink-sync-message')!;
    expect(message.querySelector('.lightink-sync-message-text')?.textContent).toBe(
      'WebDAV 服务器返回 HTTP 507。',
    );
    button(dialog, '关闭').click();
  });

  it('maps the status-line title from lastErrorCode and keeps lastError as detail', async () => {
    const panelDeps = createDeps();
    panelDeps.sync.status = vi.fn(async () => ({
      state: 'error' as const,
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
      lastError: '无法读取同步记录: database is locked',
      lastErrorCode: 'SYNC_NETWORK_ERROR',
    }));
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    const status = dialog.querySelector<HTMLElement>('.lightink-sync-status')!;
    expect(status.querySelector('.lightink-sync-status-state')?.textContent).toBe(
      '无法连接 WebDAV 服务器，请检查地址与网络。',
    );
    const detail = status.querySelector<HTMLDetailsElement>('.lightink-sync-status-detail');
    expect(detail).not.toBeNull();
    expect(detail!.hidden).toBe(false);
    expect(detail!.querySelector('pre')?.textContent).toBe(
      '无法读取同步记录: database is locked',
    );
    button(dialog, '关闭').click();
  });

  it('covers every SYNC_* error code emitted by the backend sources', () => {
    // 完备性守护：从 webdav.rs / sync.rs 提取全部引号字面量 SYNC_* 错误码，
    // 码表缺码或后端新增码未登记都会在此失败（A1 review P1 根因）。
    const sources = ['src-tauri/src/webdav.rs', 'src-tauri/src/sync.rs'].map((path) =>
      readFileSync(resolve(process.cwd(), path), 'utf-8'),
    );
    const emitted = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/"SYNC_[A-Z_]+"/g)) {
        emitted.add(match[0].slice(1, -1));
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    expect(Object.keys(SYNC_ERROR_TITLES).sort()).toEqual([...emitted].sort());
  });

  it('paints the dialog with the shelf theme instead of editor cream', () => {
    const host = document.createElement('div');
    host.className = 'lightink-library';
    applyLibraryTheme(host, 'ink');
    document.body.append(host);
    showSyncPanel({ ...createDeps(), themeHost: host });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.dataset.libraryTheme).toBe('ink');
    expect(overlay!.style.getPropertyValue('--lightink-bg')).toBe('#14161a');
    expect(overlay!.style.getPropertyValue('--lightink-accent')).toBe('#7ba3c9');
    expect(overlay!.style.backgroundColor).toBe('');
    host.remove();
  });

  it('copies a visible reader host when the shelf is hidden', () => {
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    applyReaderTheme(host, 'white');
    document.body.append(host);
    showSyncPanel({ ...createDeps(), themeHost: host });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay!.dataset.readerTheme).toBe('white');
    expect(overlay!.style.getPropertyValue('--lightink-bg')).toBe('#ffffff');
    host.remove();
  });

  it('falls back to the stored shelf theme when no host is mounted', () => {
    const storage = {
      getItem: (key: string) => (key === LIBRARY_THEME_STORAGE_KEY ? 'walnut' : null),
      setItem: () => undefined,
    };
    showSyncPanel({ ...createDeps(), themeStorage: storage });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay!.dataset.libraryTheme).toBe('walnut');
    expect(overlay!.style.getPropertyValue('--lightink-bg')).toBe('');
    expect(overlay!.style.backgroundColor).toBe('');
  });

  it('shows a progress dialog for an in-flight sync and cancels from the dialog', async () => {
    const panelDeps = createDeps();
    const status = vi.fn(async (): Promise<SyncStatus> => ({
      state: 'running',
      uploaded: 4,
      downloaded: 0,
      conflicts: 0,
      phase: 'upload-books',
      current: 4,
      total: 12,
    }));
    const cancel = vi.fn(async () => {
      status.mockResolvedValue({
        state: 'cancelled',
        uploaded: 4,
        downloaded: 0,
        conflicts: 0,
      });
    });
    panelDeps.sync.status = status;
    panelDeps.sync.cancel = cancel;
    showSyncPanel(panelDeps);
    await settle();

    const progress = document.querySelector<HTMLElement>('.lightink-sync-progress');
    expect(progress?.hidden).toBe(false);
    expect(progress?.textContent).toContain('正在同步');
    expect(progress?.textContent).toContain('上传书籍');
    expect(progress?.textContent).toContain('4 / 12');
    expect(progress?.textContent).toContain('↑4');
    const css = readFileSync(resolve(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    expect(css).toMatch(/\.lightink-sync-progress\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    expect(css).toMatch(/\.lightink-sync-progress\s*\{[^}]*position:\s*absolute/);
    const cancelButton = Array.from(progress!.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '取消同步',
    );
    expect(cancelButton).toBeTruthy();
    cancelButton!.click();
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLElement>('.lightink-sync-progress')?.hidden).toBe(true);
    expect(document.querySelector('.lightink-sync-status-state')?.textContent).toBe('已取消');
    button(document.querySelector('.lightink-sync-dialog')!, '关闭').click();
  });

  it('opens the progress dialog as soon as 立即同步 is clicked', async () => {
    const panelDeps = createDeps();
    let current: SyncStatus = idle;
    panelDeps.sync.status = vi.fn(async () => current);
    panelDeps.sync.run = vi.fn(async () => {
      current = {
        state: 'running',
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
        phase: 'connect',
      };
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      current = { ...idle, state: 'success', uploaded: 2, finishedAt: 1 };
      return current;
    });
    showSyncPanel(panelDeps);
    await settle();
    expect(document.querySelector<HTMLElement>('.lightink-sync-progress')?.hidden).toBe(true);
    button(document.querySelector('.lightink-sync-dialog')!, '立即同步').click();
    await settle();
    expect(document.querySelector<HTMLElement>('.lightink-sync-progress')?.hidden).toBe(false);
    expect(document.querySelector('.lightink-sync-progress')?.textContent).toContain('连接服务器');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector<HTMLElement>('.lightink-sync-progress')?.hidden).toBe(true);
    expect(document.querySelector('.lightink-sync-status-state')?.textContent).toContain('已同步');
    button(document.querySelector('.lightink-sync-dialog')!, '关闭').click();
  });

  it('shows a stuck running status and lets cancel clear it', async () => {
    const panelDeps = createDeps();
    const status = vi.fn(async (): Promise<SyncStatus> => ({
      state: 'running',
      uploaded: 0,
      downloaded: 0,
      conflicts: 0,
    }));
    const cancel = vi.fn(async () => {
      status.mockResolvedValue({
        state: 'cancelled',
        uploaded: 0,
        downloaded: 0,
        conflicts: 0,
      });
    });
    panelDeps.sync.status = status;
    panelDeps.sync.cancel = cancel;
    showSyncPanel(panelDeps);
    await settle();
    const dialog = document.querySelector<HTMLElement>('.lightink-sync-dialog')!;
    expect(dialog.querySelector('.lightink-sync-status-state')?.textContent).toBe('同步中…');
    expect(button(dialog, '立即同步').disabled).toBe(true);
    const cancelButton = button(dialog, '取消同步');
    expect(cancelButton.hidden).toBe(false);
    cancelButton.click();
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector('.lightink-sync-status-state')?.textContent).toBe('已取消');
    expect(button(dialog, '立即同步').disabled).toBe(false);
    button(dialog, '关闭').click();
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
