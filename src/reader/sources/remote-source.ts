import { invoke } from '@tauri-apps/api/core';

import type { ReaderTarget, RandomAccessSource, RemoteReaderTarget } from './types.js';

export interface RemoteOpenResult {
  readonly resourceId: string;
  readonly size: number;
  readonly identity: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly mimeType?: string;
  readonly supportsRanges: boolean;
  readonly cacheComplete: boolean;
}

export interface RemoteSourceInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const defaultInvoker: RemoteSourceInvoker = { invoke };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}

function bytesFromIpc(raw: ArrayBuffer | Uint8Array | readonly number[]): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (Array.isArray(raw)) {
    return Uint8Array.from(raw);
  }
  throw new Error('远程读取返回了无效字节');
}

/** OPDS `length` / item.size: skip HEAD+Range when the file is already sized. */
export function remoteOpenExpectedSize(
  item: { readonly size?: number },
  acquisition?: { readonly size?: number },
): number | undefined {
  const size = acquisition?.size ?? item.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return undefined;
  }
  return Math.floor(size);
}

export function isRemoteTarget(target: ReaderTarget): target is RemoteReaderTarget {
  return target.kind === 'remote';
}

function createHandleSource(
  metadata: RemoteOpenResult,
  invoker: RemoteSourceInvoker,
  signal?: AbortSignal,
): RandomAccessSource {
  let closed = false;
  const abortListener = (): void => {
    void invoker.invoke('remote_cancel', { resourceId: metadata.resourceId }).catch(() => undefined);
  };
  signal?.addEventListener('abort', abortListener, { once: true });
  return {
    size: metadata.size,
    identity: { id: metadata.identity },
    access: 'remote',
    async readRange(offset, length, readSignal) {
      if (closed) {
        throw new Error('远程读取源已关闭');
      }
      if (
        offset < 0 ||
        length < 0 ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length)
      ) {
        throw new Error('远程读取区间无效');
      }
      if (offset + length > metadata.size) {
        throw new Error('远程读取区间超出资源大小');
      }
      throwIfAborted(readSignal);
      const requestId = `js-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const onAbort = (): void => {
        void invoker
          .invoke('remote_cancel', { resourceId: metadata.resourceId, requestId })
          .catch(() => undefined);
      };
      readSignal?.addEventListener('abort', onAbort, { once: true });
      try {
        const raw = await invoker.invoke<ArrayBuffer | Uint8Array | number[]>('remote_read_range', {
          resourceId: metadata.resourceId,
          offset,
          length,
          requestId,
        });
        throwIfAborted(readSignal);
        return bytesFromIpc(raw);
      } finally {
        readSignal?.removeEventListener('abort', onAbort);
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      signal?.removeEventListener('abort', abortListener);
      await invoker.invoke('remote_close', { resourceId: metadata.resourceId });
    },
  };
}

/** Attach a reader source to a handle that was opened by the application shell. */
export async function attachRemoteSource(
  target: RemoteReaderTarget,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: RemoteSourceInvoker;
  } = {},
): Promise<{ source: RandomAccessSource; metadata: RemoteOpenResult }> {
  const invoker = options.invoker ?? defaultInvoker;
  if (options.signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  const metadata = await invoker.invoke<RemoteOpenResult>('remote_info', {
    resourceId: target.resourceId,
  });
  return { source: createHandleSource(metadata, invoker, options.signal), metadata };
}

/** Open a backend-owned remote handle; credentials never enter this object. */
export async function openRemoteSource(
  target: RemoteReaderTarget,
  options: {
    readonly allowHttp?: boolean;
    readonly credentialRef?: string;
    readonly signal?: AbortSignal;
    readonly invoker?: RemoteSourceInvoker;
  } = {},
): Promise<{ source: RandomAccessSource; metadata: RemoteOpenResult }> {
  const invoker = options.invoker ?? defaultInvoker;
  if (options.signal?.aborted === true) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  const metadata = await invoker.invoke<RemoteOpenResult>('remote_open', {
    url: target.resourceId,
    itemId: target.itemId,
    allowHttp: options.allowHttp ?? false,
    credentialRef: options.credentialRef,
  });
  return { source: createHandleSource(metadata, invoker, options.signal), metadata };
}
