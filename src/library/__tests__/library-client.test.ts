import { describe, expect, it, vi } from 'vitest';
import { LibraryClient, type LibraryClientInvoker } from '../library-client.js';

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

    expect(invoke).toHaveBeenNthCalledWith(1, 'library_create_group', {
      name: 'Favorites',
      parentId: undefined,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'library_move_group', {
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
