import { describe, expect, it, vi } from 'vitest';
import { LibraryClient, type LibraryClientInvoker } from '../library-client.js';
import {
  WebDavSourceClient,
  type WebDavSourceClientInvoker,
} from '../webdav-source-client.js';

describe('LibraryClient managed content', () => {
  it('imports a local file through the managed-content command', async () => {
    const item = {
      id: 'managed:abc',
      sourceKind: 'managed' as const,
      title: 'Book.epub',
      authors: [],
      blobHash: 'abc',
      availability: 'local' as const,
      updatedAt: 1,
    };
    const invoke = vi.fn(async () => item);
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);

    await expect(client.importManagedBook('/books/Book.epub')).resolves.toEqual(item);
    expect(invoke).toHaveBeenCalledWith('library_import_managed_book', {
      path: '/books/Book.epub',
    });
  });

  it('copies readonly migration ids into the invoke payload', async () => {
    const invoke = vi.fn(async () => ({ migrated: 0, duplicates: 0, failed: [], aliases: [] }));
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);
    const ids = ['local:a'] as const;

    await client.applyManagedMigration(ids);

    expect(invoke).toHaveBeenCalledWith('library_apply_managed_migration', {
      itemIds: ['local:a'],
    });
  });
});

describe('LibraryClient groups', () => {
  it('uses camel-case group commands and preserves explicit root placement', async () => {
    const group = {
      id: 'group-a',
      name: 'Favorites',
      kind: 'custom' as const,
      sortOrder: 0,
    };
    const invoke = vi.fn(async () => group);
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);

    await client.createGroup('Favorites');
    await client.moveGroup('group-a', undefined, 2);

    expect(invoke).toHaveBeenCalledWith('library_create_group', {
      name: 'Favorites',
      parentId: undefined,
    });
    expect(invoke).toHaveBeenCalledWith('library_move_group', {
      groupId: 'group-a',
      parentId: undefined,
      sortOrder: 2,
    });
  });

  it('copies readonly membership ids before invoking Rust', async () => {
    const invoke = vi.fn(async () => undefined);
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);
    const groupIds = ['group-a', 'group-b'] as const;

    await client.setItemGroups('book-a', groupIds);

    expect(invoke).toHaveBeenCalledWith('library_set_item_groups', {
      itemId: 'book-a',
      groupIds: ['group-a', 'group-b'],
    });
  });
});

describe('LibraryClient offline retention', () => {
  it('delegates offline pinning without changing the item id', async () => {
    const invoke = vi.fn(async () => undefined);
    const client = new LibraryClient({ invoke } as LibraryClientInvoker);
    await client.setOfflinePinned('managed:abc', true);
    expect(invoke).toHaveBeenCalledWith('library_set_offline_pinned', {
      itemId: 'managed:abc',
      pinned: true,
    });
  });
});

describe('WebDavSourceClient', () => {
  it('maps source, test, and browse calls to native commands', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return (command === 'webdav_source_list' ? [] : { ok: true, finalUrl: 'https://dav.example/' }) as T;
    };
    const invoker: WebDavSourceClientInvoker = {
      invoke: vi.fn(invoke) as unknown as WebDavSourceClientInvoker['invoke'],
    };
    const client = new WebDavSourceClient(invoker);

    await client.addSource({ title: '漫画柜', url: 'https://dav.example/dav' });
    await client.listSources();
    await client.test({ title: '漫画柜', url: 'https://dav.example/dav', allowHttp: false });
    await client.browse('webdav-1', 'https://dav.example/dav/books/');
    await client.removeSource('webdav-1');

    expect(calls).toEqual([
      {
        command: 'webdav_source_add',
        args: { input: { title: '漫画柜', url: 'https://dav.example/dav' } },
      },
      { command: 'webdav_source_list', args: undefined },
      {
        command: 'webdav_source_test',
        args: {
          input: { title: '漫画柜', url: 'https://dav.example/dav', allowHttp: false },
        },
      },
      {
        command: 'webdav_source_browse',
        args: { sourceId: 'webdav-1', url: 'https://dav.example/dav/books/' },
      },
      { command: 'webdav_source_remove', args: { sourceId: 'webdav-1' } },
    ]);
  });

  it('does not transform or persist credential fields in the client', async () => {
    const invoke = vi.fn(async <T>(_command: string, _args?: Record<string, unknown>): Promise<T> => ({
      id: 'webdav-1',
    }) as T);
    const client = new WebDavSourceClient({
      invoke: invoke as unknown as WebDavSourceClientInvoker['invoke'],
    });
    const credential = { kind: 'basic' as const, username: 'user', password: 'pass' };

    await client.addSource({
      title: '受保护书库',
      url: 'https://dav.example/dav',
      credential,
    });
    await client.test({
      title: '受保护书库',
      url: 'https://dav.example/dav',
      credential,
    });

    expect(invoke).toHaveBeenCalledWith('webdav_source_add', {
      input: expect.objectContaining({ credential }),
    });
    expect(invoke).toHaveBeenCalledWith('webdav_source_test', {
      input: expect.objectContaining({ credential }),
    });
  });
});
