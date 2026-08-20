import { invoke } from '@tauri-apps/api/core';

import { parseFilenameSeries } from './filename-series.js';
import { classifyLibraryKind } from './library-kind.js';

export interface LibraryItem {
  readonly id: string;
  readonly sourceId?: string;
  readonly sourceKind: 'local' | 'opds' | 'remote';
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
  readonly updatedAt: number;
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

/** User-built or smart collection. The five shelf filters are not groups. */
export type LibraryGroupSource = 'user' | 'smart';

export interface LibraryGroup {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly source: LibraryGroupSource;
  readonly smartKey?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LibraryGroupInput {
  readonly name: string;
  readonly parentId?: string;
}

export interface LibraryGroupUpsert {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly name: string;
  readonly source?: LibraryGroupSource;
  readonly smartKey?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export interface LibraryGroupMember {
  readonly groupId: string;
  readonly itemId: string;
  readonly contentHash?: string;
  readonly updatedAt: number;
}

export interface LibraryOrganizeHint {
  readonly itemId: string;
  readonly authors: readonly string[];
  readonly seriesStem?: string;
  readonly kind?: 'text' | 'comic';
  readonly contentHash?: string;
}

export interface LibraryClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: LibraryClientInvoker = { invoke };

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Build an organize hint from a shelf item.
 * Filename series stems stay on the hint; they are never copied onto
 * `LibraryItem.series` (that field remains comic metadata).
 */
export function organizeHintForItem(
  item: LibraryItem,
  options?: { readonly seriesStem?: string; readonly contentHash?: string },
): LibraryOrganizeHint {
  const parsed = item.localPath === undefined ? undefined : parseFilenameSeries(item.localPath);
  return {
    itemId: item.id,
    authors: item.authors,
    seriesStem: emptyToUndefined(options?.seriesStem) ?? emptyToUndefined(parsed?.seriesStem),
    kind: classifyLibraryKind(item),
    contentHash: emptyToUndefined(options?.contentHash),
  };
}

export class LibraryClient {
  private readonly invoker: LibraryClientInvoker;

  constructor(invoker: LibraryClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  listItems(sourceId?: string): Promise<LibraryItem[]> {
    return this.invoker.invoke<LibraryItem[]>('library_list_items', { sourceId });
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

  removeItem(itemId: string): Promise<void> {
    return this.invoker.invoke<void>('library_remove_item', { itemId });
  }

  listGroups(): Promise<LibraryGroup[]> {
    return this.invoker.invoke<LibraryGroup[]>('library_list_groups');
  }

  listGroupMembers(groupId?: string): Promise<LibraryGroupMember[]> {
    return this.invoker.invoke<LibraryGroupMember[]>('library_list_group_members', { groupId });
  }

  upsertGroup(group: LibraryGroupUpsert): Promise<LibraryGroup> {
    return this.invoker.invoke<LibraryGroup>('library_upsert_group', {
      group: {
        id: group.id ?? '',
        parentId: group.parentId ?? undefined,
        name: group.name,
        source: group.source ?? 'user',
        smartKey: group.smartKey,
        createdAt: group.createdAt ?? 0,
        updatedAt: group.updatedAt ?? 0,
      },
    });
  }

  createGroup(input: LibraryGroupInput): Promise<LibraryGroup> {
    return this.upsertGroup({
      name: input.name,
      parentId: input.parentId,
      source: 'user',
    });
  }

  async renameGroup(groupId: string, name: string): Promise<LibraryGroup> {
    const current = await this.requireGroup(groupId);
    return this.upsertGroup({ ...current, name, updatedAt: 0 });
  }

  async moveGroup(groupId: string, parentId?: string | null): Promise<LibraryGroup> {
    const current = await this.requireGroup(groupId);
    return this.upsertGroup({ ...current, parentId: parentId ?? undefined, updatedAt: 0 });
  }

  deleteGroup(groupId: string): Promise<void> {
    return this.invoker.invoke<void>('library_remove_group', { groupId });
  }

  addGroupMember(groupId: string, itemId: string, contentHash?: string): Promise<void> {
    return this.invoker.invoke<void>('library_add_group_member', {
      groupId,
      itemId,
      contentHash,
    });
  }

  removeGroupMember(groupId: string, itemId: string): Promise<void> {
    return this.invoker.invoke<void>('library_remove_group_member', { groupId, itemId });
  }

  organizeGroups(hints: readonly LibraryOrganizeHint[] = []): Promise<void> {
    return this.invoker.invoke<void>('library_organize_groups', { hints });
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

  private async requireGroup(groupId: string): Promise<LibraryGroup> {
    const groups = await this.listGroups();
    const found = groups.find((group) => group.id === groupId);
    if (found === undefined) {
      throw new Error('分组不存在');
    }
    return found;
  }
}

export const libraryClient = new LibraryClient();
