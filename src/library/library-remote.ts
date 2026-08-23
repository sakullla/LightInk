import { invoke } from '@tauri-apps/api/core';

import type { AcquisitionLink, LibraryItem } from './library-client.js';
import { credentialRefForResource, type LibraryRemoteSource } from './opds-client.js';
import {
  remoteOpenExpectedSize,
  type RemoteOpenResult,
  type RemoteSourceInvoker,
} from '../reader/sources/remote-source.js';

const defaultInvoker: RemoteSourceInvoker = { invoke };
export const REMOTE_CACHE_CHUNK_SIZE = 16 * 1024 * 1024;

/** Library open/cache request using the OPDS/WebDAV shared remote-source shape. */
export interface LibraryRemoteRequest {
  readonly item: LibraryItem;
  readonly acquisition?: AcquisitionLink;
  readonly source?: LibraryRemoteSource;
}

export interface LibraryRemoteOpenArgs {
  readonly url: string;
  readonly itemId: string;
  readonly allowHttp: boolean;
  readonly credentialRef: string | undefined;
  readonly requestId: string;
  readonly expectedSize: number | undefined;
}

function throwIfOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

function remoteOperationId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Map a library request onto remote_open args; credentialRef is same-origin only. */
export function libraryRemoteOpenArgs(
  request: LibraryRemoteRequest,
  requestId: string,
): LibraryRemoteOpenArgs {
  const { item, acquisition } = request;
  if (acquisition === undefined) throw new Error('没有可用的获取链接');
  return {
    url: acquisition.href,
    itemId: item.id,
    allowHttp: request.source?.allowHttp === true,
    credentialRef: credentialRefForResource(request.source, acquisition.href),
    requestId,
    expectedSize: remoteOpenExpectedSize(item, acquisition),
  };
}

export function remoteNeedsRangeWarning(opened: {
  readonly supportsRanges: boolean;
}): boolean {
  return opened.supportsRanges !== true;
}

/** Pull the remote body into the backend sparse cache without a second open. */
export async function readRemoteCacheChunks(
  opened: Pick<RemoteOpenResult, 'resourceId' | 'size'>,
  invoker: RemoteSourceInvoker,
  options: {
    readonly signal?: AbortSignal;
    readonly throwIfAborted?: (signal?: AbortSignal) => void;
    readonly chunkSize?: number;
  } = {},
): Promise<void> {
  const throwIfAborted = options.throwIfAborted ?? throwIfOperationAborted;
  const chunkSize = options.chunkSize ?? REMOTE_CACHE_CHUNK_SIZE;
  for (let offset = 0; offset < opened.size; offset += chunkSize) {
    throwIfAborted(options.signal);
    const length = Math.min(chunkSize, opened.size - offset);
    await invoker.invoke<ArrayBuffer | number[]>('remote_read_range', {
      resourceId: opened.resourceId,
      offset,
      length,
    });
    throwIfAborted(options.signal);
  }
}

/** Upsert payload keeps the catalog item id so re-entering the source cannot duplicate the shelf row. */
export function libraryItemFromRemoteCache(
  item: LibraryItem,
  opened: Pick<RemoteOpenResult, 'etag' | 'lastModified' | 'size'>,
  updatedAt: number,
): LibraryItem {
  return {
    ...item,
    etag: opened.etag,
    lastModified: opened.lastModified,
    size: opened.size,
    updatedAt,
  };
}

export async function openLibraryRemote(
  request: LibraryRemoteRequest,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: RemoteSourceInvoker;
    readonly requestId?: string;
  } = {},
): Promise<RemoteOpenResult> {
  const invoker = options.invoker ?? defaultInvoker;
  const signal = options.signal;
  const args = libraryRemoteOpenArgs(
    request,
    options.requestId ?? remoteOperationId('library-open'),
  );
  const cancel = (): void => {
    void invoker.invoke<void>('remote_cancel', { requestId: args.requestId }).catch(() => undefined);
  };
  throwIfOperationAborted(signal);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const opened = await invoker.invoke<RemoteOpenResult>('remote_open', { ...args });
    try {
      throwIfOperationAborted(signal);
    } catch (error) {
      await invoker
        .invoke<void>('remote_close', { resourceId: opened.resourceId })
        .catch(() => undefined);
      throw error;
    }
    return opened;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** Chunked range download into the backend sparse cache, then upsert the shelf row. */
export async function cacheLibraryRemoteItem(
  request: LibraryRemoteRequest,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: RemoteSourceInvoker;
    readonly upsertItem: (item: LibraryItem) => Promise<void>;
    readonly now?: () => number;
  },
): Promise<void> {
  const { item, acquisition } = request;
  if (item.sourceKind === 'local' || item.sourceKind === 'managed' || acquisition === undefined) {
    return;
  }
  const invoker = options.invoker ?? defaultInvoker;
  const signal = options.signal;
  const opened = await openLibraryRemote(request, { signal, invoker });
  const cancel = (): void => {
    void invoker.invoke<void>('remote_cancel', { resourceId: opened.resourceId }).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await readRemoteCacheChunks(opened, invoker, { signal });
    await options.upsertItem(
      libraryItemFromRemoteCache(item, opened, (options.now ?? Date.now)()),
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
    await invoker.invoke<void>('remote_close', { resourceId: opened.resourceId }).catch(() => undefined);
  }
}
