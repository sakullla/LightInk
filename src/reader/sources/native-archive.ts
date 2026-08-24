import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../file/browser-file-store.js';
import type {
  ArchiveEntryMetadata,
  ArchiveProvider,
  ArchiveReadProgress,
  ReaderTarget,
} from './types.js';
import { readerIdentityKey } from './types.js';
import { fnv1a64Hex } from '../document-hash.js';

export const NATIVE_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'cbr',
  'cb7',
  'rar',
  '7z',
]);

const NATIVE_ZIP_EXTENSIONS: ReadonlySet<string> = new Set(['cbz', 'zip']);

/**
 * RAR/7z always use the Rust session. Local CBZ/ZIP do too in Tauri so inflate
 * stays off the WebView thread (OpenPanel / Readest). The browser build keeps
 * zip.js with CompressionStream workers.
 */
export function usesNativeArchive(
  extension: string,
  runtime: Window | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  const ext = extension.toLowerCase();
  if (NATIVE_ARCHIVE_EXTENSIONS.has(ext)) return true;
  return NATIVE_ZIP_EXTENSIONS.has(ext) && isTauriRuntime(runtime);
}

export interface NativeArchiveEntry extends ArchiveEntryMetadata {
  readonly id: string;
  readonly filename: string;
  readonly encrypted: boolean;
  readonly solid: boolean;
  readonly split: boolean;
}

interface NativeArchiveOpenResult {
  readonly archiveId: string;
  readonly format: string;
  readonly accessMode: 'random' | 'sequential';
  readonly solid: boolean;
  readonly encrypted: boolean;
  readonly multivolume: boolean;
  readonly entries: readonly NativeArchiveEntry[];
  readonly depth?: number;
  readonly cumulativeUncompressedBytes?: number;
}

export interface NativeArchiveInvoker {
  invoke<T>(
    command: string,
    args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
    options?: { readonly headers: HeadersInit },
  ): Promise<T>;
}

export interface ArchivePasswordRequest {
  readonly displayName: string;
  readonly retry: boolean;
}

export type ArchivePasswordProvider = (
  request: ArchivePasswordRequest,
) => Promise<string | null>;

export class NativeArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NativeArchiveError';
  }
}

const defaultInvoker: NativeArchiveInvoker = {
  invoke: (command, args, options) => invoke(command, args, options),
};

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw abortError();
  }
}

function throwIfCancelled(error: unknown, signal?: AbortSignal): never | void {
  if (signal?.aborted === true) {
    throw abortError();
  }
  if (error instanceof NativeArchiveError && error.code === 'ARCHIVE_CANCELLED') {
    throw abortError();
  }
}

function archiveError(error: unknown): NativeArchiveError {
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value['code'] === 'string' && typeof value['message'] === 'string') {
      return new NativeArchiveError(value['code'], value['message']);
    }
  }
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error) as Record<string, unknown>;
      if (typeof parsed['code'] === 'string' && typeof parsed['message'] === 'string') {
        return new NativeArchiveError(parsed['code'], parsed['message']);
      }
    } catch {
      // Tauri may reject with a plain backend message.
    }
  }
  return new NativeArchiveError('ARCHIVE_UNKNOWN', String(error ?? '归档读取失败'));
}

function isPasswordError(error: NativeArchiveError): boolean {
  return (
    error.code === 'ARCHIVE_PASSWORD_REQUIRED' ||
    error.code === 'ARCHIVE_PASSWORD_INCORRECT'
  );
}

function bytesFromIpc(raw: ArrayBuffer | Uint8Array | readonly number[]): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  throw new NativeArchiveError('ARCHIVE_IPC_INVALID', '归档条目返回了无效字节');
}

async function requestPassword(
  provider: ArchivePasswordProvider | undefined,
  displayName: string,
  retry: boolean,
): Promise<string> {
  const password = await provider?.({ displayName, retry });
  if (password === undefined || password === null) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  return password;
}

interface NativeProviderOptions {
  readonly invoker: NativeArchiveInvoker;
  readonly requestPassword?: ArchivePasswordProvider;
  readonly displayName: string;
  readonly identity: string;
  readonly closeRemoteResourceId?: string;
  readonly initialPassword?: string;
}

interface NativeNestedPayloadContext {
  readonly parentIdentity: string;
  readonly entryId: string;
  readonly displayName: string;
  readonly depth: number;
  readonly parentUncompressedBytes: number;
}

interface ArchiveStageResult {
  readonly stageId: string;
}

function providerFromOpened(
  opened: NativeArchiveOpenResult,
  options: NativeProviderOptions,
): ArchiveProvider {
  const listeners = new Set<(progress: ArchiveReadProgress) => void>();
  let password = options.initialPassword;
  let closed = false;

  const cancel = async (): Promise<void> => {
    if (!closed) {
      await options.invoker
        .invoke<void>('archive_cancel', { archiveId: opened.archiveId })
        .catch(() => undefined);
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await options.invoker.invoke<void>('archive_close', { archiveId: opened.archiveId });
    } finally {
      if (options.closeRemoteResourceId !== undefined) {
        await options.invoker.invoke<void>('remote_close', {
          resourceId: options.closeRemoteResourceId,
        });
      }
    }
  };

  const withCancellation = async <T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(signal);
    const onAbort = (): void => {
      void cancel();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  const startProgressPolling = (): (() => void) => {
    // Random ZIP/CBZ pages are independent seeks. Polling the sync
    // archive_progress command while archive_read_entry is still shipping
    // bytes deadlocks WebView2's renderer thread — cancel and CDP both die.
    if (listeners.size === 0 || opened.accessMode !== 'sequential') {
      return () => undefined;
    }
    let active = true;
    const poll = async (): Promise<void> => {
      if (!active || listeners.size === 0) return;
      try {
        const progress = await options.invoker.invoke<ArchiveReadProgress>('archive_progress', {
          archiveId: opened.archiveId,
        });
        for (const listener of listeners) listener(progress);
      } catch {
        // Progress is advisory; the entry read carries the structured failure.
      }
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), 150);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  };

  const readEntry = async (entryId: string, signal?: AbortSignal): Promise<Uint8Array> => {
    if (closed) {
      throw new NativeArchiveError('ARCHIVE_SESSION_NOT_FOUND', '归档会话已关闭');
    }
    return withCancellation(signal, async () => {
      const stopProgress = startProgressPolling();
      try {
        while (true) {
          try {
            const raw = await options.invoker.invoke<ArrayBuffer | Uint8Array | number[]>(
              'archive_read_entry',
              { archiveId: opened.archiveId, entryId, password },
            );
            throwIfAborted(signal);
            return bytesFromIpc(raw);
          } catch (error) {
            throwIfCancelled(error, signal);
            const structured = archiveError(error);
            throwIfCancelled(structured, signal);
            if (!isPasswordError(structured)) throw structured;
            password = await requestPassword(
              options.requestPassword,
              options.displayName,
              structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
            );
            throwIfAborted(signal);
          }
        }
      } finally {
        stopProgress();
      }
    });
  };

  return {
    entries: opened.entries,
    accessMode: opened.accessMode,
    identity: options.identity,
    depth: opened.depth ?? 0,
    cumulativeUncompressedBytes: opened.cumulativeUncompressedBytes ?? 0,
    readEntry,
    async openNested(entryId, signal) {
      const entry = opened.entries.find((candidate) => candidate.id === entryId);
      const displayName = entry?.filename ?? options.displayName;
      let nestedPassword: string | undefined;
      const nested = await withCancellation(signal, async () => {
        while (true) {
          try {
            return await options.invoker.invoke<NativeArchiveOpenResult>(
              'archive_open_nested',
              { parentArchiveId: opened.archiveId, entryId, password: nestedPassword },
            );
          } catch (error) {
            throwIfCancelled(error, signal);
            const structured = archiveError(error);
            throwIfCancelled(structured, signal);
            if (!isPasswordError(structured)) throw structured;
            nestedPassword = await requestPassword(
              options.requestPassword,
              displayName,
              structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
            );
          }
        }
      });
      return providerFromOpened(nested, {
        ...options,
        displayName,
        identity: `${options.identity}!${entryId}`,
        closeRemoteResourceId: undefined,
        initialPassword: nestedPassword,
      });
    },
    cancel,
    subscribeProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
}

/** Stage a bounded native archive nested in a ZIP.js parent, then open it by magic. */
export async function openNativeNestedPayload(
  bytes: Uint8Array,
  context: NativeNestedPayloadContext,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: NativeArchiveInvoker;
    readonly requestPassword?: ArchivePasswordProvider;
  } = {},
): Promise<ArchiveProvider> {
  const invoker = options.invoker ?? defaultInvoker;
  throwIfAborted(options.signal);
  const headers = {
    'x-lightink-parent-identity': fnv1a64Hex(context.parentIdentity),
    'x-lightink-entry-id': fnv1a64Hex(context.entryId),
    'x-lightink-depth': String(context.depth),
    'x-lightink-parent-uncompressed-bytes': String(context.parentUncompressedBytes),
  };
  const staged = await invoker.invoke<ArchiveStageResult>(
    'archive_stage_nested',
    bytes,
    { headers },
  );
  let opened = false;
  let password: string | undefined;
  try {
    while (true) {
      throwIfAborted(options.signal);
      try {
        const result = await invoker.invoke<NativeArchiveOpenResult>('archive_open_staged', {
          stageId: staged.stageId,
          password,
        });
        opened = true;
        return providerFromOpened(result, {
          invoker,
          requestPassword: options.requestPassword,
          displayName: context.displayName,
          identity: `${context.parentIdentity}!${context.entryId}`,
          initialPassword: password,
        });
      } catch (error) {
        const structured = archiveError(error);
        if (!isPasswordError(structured)) throw structured;
        password = await requestPassword(
          options.requestPassword,
          context.displayName,
          structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
        );
      }
    }
  } finally {
    if (!opened) {
      await invoker
        .invoke<void>('archive_discard_staged', { stageId: staged.stageId })
        .catch(() => undefined);
    }
  }
}

/** Open a backend-native RAR/7z session without exposing its source bytes to the WebView. */
export async function openNativeArchive(
  target: ReaderTarget,
  options: {
    readonly signal?: AbortSignal;
    readonly invoker?: NativeArchiveInvoker;
    readonly requestPassword?: ArchivePasswordProvider;
  } = {},
): Promise<ArchiveProvider> {
  const invoker = options.invoker ?? defaultInvoker;
  const sourceArgs =
    target.kind === 'local'
      ? { path: target.path, resourceId: undefined }
      : { path: undefined, resourceId: target.resourceId };
  let password: string | undefined;
  let opened: NativeArchiveOpenResult;
  const cancelOpen = (): void => {
    void invoker
      .invoke<void>('archive_cancel_open', sourceArgs)
      .catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancelOpen, { once: true });
  try {
    while (true) {
      throwIfAborted(options.signal);
      try {
        opened = await invoker.invoke<NativeArchiveOpenResult>('archive_open', {
          ...sourceArgs,
          password,
        });
        break;
      } catch (error) {
        throwIfCancelled(error, options.signal);
        const structured = archiveError(error);
        throwIfCancelled(structured, options.signal);
        if (!isPasswordError(structured)) throw structured;
        password = await requestPassword(
          options.requestPassword,
          target.displayName,
          structured.code === 'ARCHIVE_PASSWORD_INCORRECT',
        );
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelOpen);
  }

  const provider = providerFromOpened(opened, {
    invoker,
    requestPassword: options.requestPassword,
    displayName: target.displayName,
    identity: readerIdentityKey(target.identity),
    closeRemoteResourceId: target.kind === 'remote' ? target.resourceId : undefined,
    initialPassword: password,
  });
  if (options.signal?.aborted === true) {
    await provider.close().catch(() => undefined);
    throwIfAborted(options.signal);
  }
  return provider;
}
