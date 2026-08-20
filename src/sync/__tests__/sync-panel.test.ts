// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { showSyncPanel } from '../sync-panel.js';
import type { SyncPanelDeps } from '../sync-panel.js';
import type { SyncStatus } from '../sync-client.js';
import type { SyncProfileInput } from '../webdav-client.js';
import type { ManagedMigrationPreview, ManagedMigrationResult } from '../../library/library-client.js';

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
