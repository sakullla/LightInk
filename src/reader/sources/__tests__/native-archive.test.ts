import { describe, expect, it, vi } from 'vitest';

import {
  NativeArchiveError,
  openNativeArchive,
  openNativeNestedPayload,
  usesNativeArchive,
  type NativeArchiveInvoker,
} from '../native-archive.js';
import type { ReaderTarget } from '../types.js';

const localTarget: ReaderTarget = {
  kind: 'local',
  path: '/books/comic.cbr',
  identity: { id: 'local:/books/comic.cbr' },
  displayName: 'comic.cbr',
  extension: 'cbr',
};

function openResult() {
  return {
    archiveId: 'archive-1',
    format: 'rar5',
    accessMode: 'random' as const,
    solid: false,
    encrypted: false,
    multivolume: false,
    entries: [
      {
        id: 'entry-0',
        filename: 'page1.png',
        directory: false,
        compressedSize: 2,
        uncompressedSize: 3,
        encrypted: false,
        solid: false,
        split: false,
      },
    ],
  };
}

describe('usesNativeArchive', () => {
  it('keeps RAR/7z native and uses the Rust ZIP session for CBZ in Tauri', () => {
    const tauri = { __TAURI_INTERNALS__: {} } as unknown as Window;
    const browser = {} as Window;
    expect(usesNativeArchive('cbr')).toBe(true);
    expect(usesNativeArchive('cb7')).toBe(true);
    expect(usesNativeArchive('cbz', tauri)).toBe(true);
    expect(usesNativeArchive('zip', tauri)).toBe(true);
    expect(usesNativeArchive('cbz', browser)).toBe(false);
    expect(usesNativeArchive('epub', tauri)).toBe(false);
  });
});

describe('native archive source', () => {
  it('keeps archive bytes behind an opaque session and closes idempotently', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') return openResult();
      if (command === 'archive_read_entry') return new Uint8Array([1, 2, 3]);
      return undefined;
    });
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
    });

    await expect(archive.readEntry('entry-0')).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await archive.close();
    await archive.close();

    expect(invoke).toHaveBeenCalledWith('archive_open', {
      path: '/books/comic.cbr',
      resourceId: undefined,
      password: undefined,
    });
    expect(invoke).toHaveBeenCalledWith('archive_read_entry', {
      archiveId: 'archive-1',
      entryId: 'entry-0',
      password: undefined,
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'archive_close')).toHaveLength(1);
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain('archive_progress');
  });

  it('does not poll archive_progress while reading random ZIP pages', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') {
        return { ...openResult(), format: 'zip', accessMode: 'random' as const };
      }
      if (command === 'archive_read_entry') return new Uint8Array([4, 5]);
      return undefined;
    });
    const archive = await openNativeArchive(
      { ...localTarget, path: '/books/comic.cbz', extension: 'cbz' },
      { invoker: { invoke } as NativeArchiveInvoker },
    );
    archive.subscribeProgress?.(() => undefined);
    await archive.readEntry('entry-0');
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain('archive_progress');
  });

  it('polls archive_progress only for sequential solid archives', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') {
        return {
          ...openResult(),
          format: 'rar5',
          accessMode: 'sequential' as const,
          solid: true,
        };
      }
      if (command === 'archive_progress') {
        return { phase: 'sequential', currentEntry: 0, targetEntry: 0, decodedBytes: 0 };
      }
      if (command === 'archive_read_entry') return new Uint8Array([9]);
      return undefined;
    });
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
    });
    archive.subscribeProgress?.(() => undefined);
    await archive.readEntry('entry-0');
    expect(invoke).toHaveBeenCalledWith('archive_progress', { archiveId: 'archive-1' });
  });

  it('closes a freshly opened session when the caller aborts', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') {
        controller.abort();
        return openResult();
      }
      return undefined;
    });

    await expect(
      openNativeArchive(localTarget, {
        invoker: { invoke } as NativeArchiveInvoker,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('archive_close', { archiveId: 'archive-1' });
  });

  it('requests a session password and retries a failed entry without persisting it', async () => {
    let reads = 0;
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'archive_open') return { ...openResult(), encrypted: true };
      if (command === 'archive_read_entry') {
        reads += 1;
        if (reads === 1) {
          throw { code: 'ARCHIVE_PASSWORD_INCORRECT', message: 'bad password' };
        }
        expect(args?.['password']).toBe('correct horse');
        return [7, 8];
      }
      return undefined;
    });
    const requestPassword = vi.fn(async () => 'correct horse');
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
      requestPassword,
    });

    await expect(archive.readEntry('entry-0')).resolves.toEqual(new Uint8Array([7, 8]));
    expect(requestPassword).toHaveBeenCalledWith({ displayName: 'comic.cbr', retry: true });
    await archive.close();
  });

  it('owns and closes an existing remote resource handle', async () => {
    const target: ReaderTarget = {
      kind: 'remote',
      itemId: 'item-1',
      resourceId: 'remote-1',
      identity: { id: 'item-1', validator: 'v1' },
      displayName: 'comic.cb7',
      extension: 'cb7',
      mimeType: 'application/x-7z-compressed',
    };
    const invoke = vi.fn(async (command: string) =>
      command === 'archive_open' ? { ...openResult(), format: '7z' } : undefined,
    );
    const archive = await openNativeArchive(target, {
      invoker: { invoke } as NativeArchiveInvoker,
    });

    await archive.close();
    expect(invoke).toHaveBeenCalledWith('remote_close', { resourceId: 'remote-1' });
  });

  it('preserves structured capability errors', async () => {
    const invoker: NativeArchiveInvoker = {
      invoke: vi.fn(async () => {
        throw { code: 'ARCHIVE_MULTIVOLUME_UNSUPPORTED', message: 'single volume only' };
      }),
    };

    await expect(openNativeArchive(localTarget, { invoker })).rejects.toEqual(
      expect.objectContaining<Partial<NativeArchiveError>>({
        name: 'NativeArchiveError',
        code: 'ARCHIVE_MULTIVOLUME_UNSUPPORTED',
      }),
    );
  });

  it('opens a nested backend archive without exposing the parent path', async () => {
    let nextArchive = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') return { ...openResult(), archiveId: 'archive-parent' };
      if (command === 'archive_open_nested') {
        nextArchive += 1;
        return {
          ...openResult(),
          archiveId: `archive-child-${nextArchive}`,
          format: 'zip',
          depth: 1,
          cumulativeUncompressedBytes: 42,
        };
      }
      return undefined;
    });
    const parent = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
    });

    const child = await parent.openNested?.('entry-0');
    expect(child?.depth).toBe(1);
    expect(invoke).toHaveBeenCalledWith('archive_open_nested', {
      parentArchiveId: 'archive-parent',
      entryId: 'entry-0',
      password: undefined,
    });
    await child?.close();
    await parent.close();
  });

  it('stages a ZIP.js child as raw IPC bytes and transfers its cache ownership', async () => {
    const invoke = vi.fn(
      async (
        command: string,
        _args?: Record<string, unknown> | ArrayBuffer | Uint8Array,
        _options?: { readonly headers: HeadersInit },
      ) => {
        if (command === 'archive_stage_nested') return { stageId: 'stage-1' };
        if (command === 'archive_open_staged') {
          return {
            ...openResult(),
            archiveId: 'archive-staged',
            depth: 2,
            cumulativeUncompressedBytes: 128,
          };
        }
        return undefined;
      },
    );
    const bytes = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf]);
    const child = await openNativeNestedPayload(
      bytes,
      {
        parentIdentity: 'book-1',
        entryId: 'nested.7z',
        displayName: 'nested.7z',
        depth: 2,
        parentUncompressedBytes: 64,
      },
      { invoker: { invoke } as NativeArchiveInvoker },
    );

    const stageCall = invoke.mock.calls.find(([command]) => command === 'archive_stage_nested');
    expect(stageCall?.[1]).toBe(bytes);
    expect(stageCall?.[2]).toEqual({
      headers: expect.objectContaining({
        'x-lightink-depth': '2',
        'x-lightink-parent-uncompressed-bytes': '64',
      }),
    });
    expect(child.cumulativeUncompressedBytes).toBe(128);
    expect(invoke).not.toHaveBeenCalledWith('archive_discard_staged', expect.anything());
    await child.close();
  });

  it('cancels an in-flight archive_open through archive_cancel_open', async () => {
    let finishOpen: ((value: ReturnType<typeof openResult>) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') {
        return new Promise<ReturnType<typeof openResult>>((resolve) => {
          finishOpen = resolve;
        });
      }
      if (command === 'archive_cancel_open') {
        finishOpen?.(openResult());
      }
      return undefined;
    });
    const controller = new AbortController();
    const opening = openNativeArchive(localTarget, {
      signal: controller.signal,
      invoker: { invoke } as NativeArchiveInvoker,
    });
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('archive_cancel_open', {
      path: '/books/comic.cbr',
      resourceId: undefined,
    });
  });

  it('cancels an in-flight sequential read when its page is no longer wanted', async () => {
    let finishRead: ((bytes: number[]) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'archive_open') {
        return { ...openResult(), accessMode: 'sequential' as const, solid: true };
      }
      if (command === 'archive_read_entry') {
        return new Promise<number[]>((resolve) => {
          finishRead = resolve;
        });
      }
      if (command === 'archive_cancel') finishRead?.([1, 2, 3]);
      return undefined;
    });
    const archive = await openNativeArchive(localTarget, {
      invoker: { invoke } as NativeArchiveInvoker,
    });
    const controller = new AbortController();
    const reading = archive.readEntry('entry-0', controller.signal);
    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledWith('archive_cancel', { archiveId: 'archive-1' });
    await archive.close();
  });
});
