import { invoke } from '@tauri-apps/api/core';

export interface LibraryItem {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourceKind: 'local' | 'managed' | 'opds' | 'remote' | 'webdav';
  readonly title: string;
  readonly authors: readonly string[];
  readonly coverUrl?: string;
  readonly localPath?: string;
  readonly acquisitionUrl?: string;
  readonly mediaType?: string;
  readonly extension?: string;
  readonly size?: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly series?: string;
  readonly number?: string;
  readonly volume?: string;
  readonly pageCount?: number;
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly coverPage?: number;
  readonly blobHash?: string;
  readonly availability?: 'external' | 'local' | 'remote' | 'missing' | 'downloading';
  readonly offlinePinned?: boolean;
  readonly subjects?: readonly string[];
  readonly updatedAt: number;
}

export interface ManagedMigrationEntry {
  readonly itemId: string;
  readonly title: string;
  readonly path: string;
  readonly status: 'ready' | 'duplicate' | 'missing' | 'tooLarge' | 'unreadable' | 'failed';
  readonly size?: number;
  readonly blobHash?: string;
  readonly error?: string;
}

export interface ManagedMigrationPreview {
  readonly entries: readonly ManagedMigrationEntry[];
}

export interface LibraryItemAlias {
  readonly aliasId: string;
  readonly itemId: string;
}

export interface ManagedMigrationResult {
  readonly migrated: number;
  readonly duplicates: number;
  readonly failed: readonly ManagedMigrationEntry[];
  readonly aliases: readonly LibraryItemAlias[];
}

export interface ManagedItemLocation {
  readonly itemId: string;
  readonly path: string;
  readonly availability: LibraryItem['availability'];
}

export interface LibraryGroup {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly kind: 'custom' | 'smart';
  readonly rule?: Readonly<Record<string, unknown>>;
  readonly sortOrder: number;
}

export interface LibraryGroupMembership {
  readonly groupId: string;
  readonly itemId: string;
}

export interface LibraryComicMetadata {
  readonly series?: string;
  readonly number?: string;
  readonly volume?: string;
  readonly pageCount?: number;
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly coverPage?: number;
}

export interface AcquisitionLink {
  readonly itemId: string;
  readonly href: string;
  readonly rel: string;
  readonly title?: string;
  readonly mediaType?: string;
  readonly extension?: string;
  readonly size?: number;
}

export interface LibraryCacheStats {
  readonly bytesCached: number;
  readonly limitBytes: number;
}

export interface LibraryClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: LibraryClientInvoker = { invoke };

export class LibraryClient {
  private readonly invoker: LibraryClientInvoker;

  constructor(invoker: LibraryClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  listItems(sourceId?: string): Promise<LibraryItem[]> {
    return this.invoker.invoke<LibraryItem[]>('library_list_items', { sourceId });
  }

  importManagedBook(path: string): Promise<LibraryItem> {
    return this.invoker.invoke<LibraryItem>('library_import_managed_book', { path });
  }

  previewManagedMigration(): Promise<ManagedMigrationPreview> {
    return this.invoker.invoke<ManagedMigrationPreview>('library_preview_managed_migration');
  }

  applyManagedMigration(itemIds: readonly string[]): Promise<ManagedMigrationResult> {
    return this.invoker.invoke<ManagedMigrationResult>('library_apply_managed_migration', {
      itemIds: [...itemIds],
    });
  }

  materializeItem(itemId: string): Promise<ManagedItemLocation> {
    return this.invoker.invoke<ManagedItemLocation>('library_materialize_item', { itemId });
  }

  listGroups(): Promise<LibraryGroup[]> {
    return this.invoker.invoke<LibraryGroup[]>('library_list_groups');
  }

  createGroup(name: string, parentId?: string): Promise<LibraryGroup> {
    return this.invoker.invoke<LibraryGroup>('library_create_group', { name, parentId });
  }

  updateGroup(groupId: string, name: string): Promise<LibraryGroup> {
    return this.invoker.invoke<LibraryGroup>('library_update_group', { groupId, name });
  }

  moveGroup(groupId: string, parentId: string | undefined, sortOrder: number): Promise<LibraryGroup> {
    return this.invoker.invoke<LibraryGroup>('library_move_group', {
      groupId,
      parentId,
      sortOrder,
    });
  }

  deleteGroup(groupId: string): Promise<void> {
    return this.invoker.invoke<void>('library_delete_group', { groupId });
  }

  listGroupMemberships(): Promise<LibraryGroupMembership[]> {
    return this.invoker.invoke<LibraryGroupMembership[]>('library_list_group_memberships');
  }

  setGroupMember(groupId: string, itemId: string, present: boolean): Promise<void> {
    return this.invoker.invoke<void>('library_set_group_member', { groupId, itemId, present });
  }

  setItemGroups(itemId: string, groupIds: readonly string[]): Promise<void> {
    return this.invoker.invoke<void>('library_set_item_groups', {
      itemId,
      groupIds: [...groupIds],
    });
  }

  listAcquisitionLinks(itemId: string): Promise<AcquisitionLink[]> {
    return this.invoker.invoke<AcquisitionLink[]>('library_list_acquisition_links', { itemId });
  }

  upsertItem(item: LibraryItem): Promise<void> {
    return this.invoker.invoke<void>('library_upsert_item', { item });
  }

  updateComicMetadata(itemId: string, metadata: LibraryComicMetadata): Promise<void> {
    return this.invoker.invoke<void>('library_update_comic_metadata', { itemId, metadata });
  }

  setOfflinePinned(itemId: string, pinned: boolean): Promise<void> {
    return this.invoker.invoke<void>('library_set_offline_pinned', { itemId, pinned });
  }

  removeItem(itemId: string): Promise<void> {
    return this.invoker.invoke<void>('library_remove_item', { itemId });
  }

  clearCache(): Promise<void> {
    return this.invoker.invoke<void>('library_clear_cache');
  }

  setCacheLimit(limitBytes: number): Promise<void> {
    return this.invoker.invoke<void>('library_set_cache_limit', { limitBytes });
  }

  cacheStats(): Promise<LibraryCacheStats> {
    return this.invoker.invoke<LibraryCacheStats>('library_cache_stats');
  }
}

export const libraryClient = new LibraryClient();
