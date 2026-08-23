import { describe, expect, it } from 'vitest';

import {
  attachRemoteSource,
  openRemoteSource,
  remoteOpenExpectedSize,
  type RemoteSourceInvoker,
} from '../remote-source.js';

describe('remoteOpenExpectedSize', () => {
  it('prefers the OPDS acquisition length so a 4MB Calibre book can skip Range probes', () => {
    expect(
      remoteOpenExpectedSize({ size: 99 }, { size: 4_301_445 }),
    ).toBe(4_301_445);
    expect(remoteOpenExpectedSize({ size: 4_301_445 })).toBe(4_301_445);
    expect(remoteOpenExpectedSize({}, {})).toBeUndefined();
    expect(remoteOpenExpectedSize({ size: 0 })).toBeUndefined();
  });
});

describe('openRemoteSource', () => {
  it('attaches to an existing backend handle without opening the URL again', async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string) => {
      commands.push(command);
      if (command === 'remote_info') {
        return {
          resourceId: 'remote-existing',
          size: 3,
          identity: 'item@v1',
          etag: 'v1',
          supportsRanges: true,
          cacheComplete: false,
        } as T;
      }
      if (command === 'remote_read_range') {
        return new Uint8Array([1, 2, 3]) as T;
      }
      return undefined as T;
    }) as RemoteSourceInvoker['invoke'];
    const target = {
      kind: 'remote' as const,
      itemId: 'item',
      resourceId: 'remote-existing',
      identity: { id: 'item', validator: 'v1' },
      displayName: 'book.cbz',
      extension: 'cbz',
      mimeType: 'application/zip',
    };

    const { source } = await attachRemoteSource(target, { invoker: { invoke } });
    expect(await source.readRange(0, 3)).toEqual(new Uint8Array([1, 2, 3]));
    await source.close();
    expect(commands).toEqual(['remote_info', 'remote_read_range', 'remote_close']);
    expect(commands).not.toContain('remote_open');
  });

  it('keeps a backend handle and forwards bounded range reads', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = (async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === 'remote_open') {
          return {
            resourceId: 'remote-1',
            size: 4,
            identity: 'item@etag',
            etag: 'etag',
            supportsRanges: true,
            cacheComplete: false,
          } as T;
        }
        if (command === 'remote_read_range') {
          return new Uint8Array([2, 3]) as T;
        }
        return undefined as T;
      }) as RemoteSourceInvoker['invoke'];
    const invoker = { invoke };
    const target = {
      kind: 'remote' as const,
      itemId: 'item',
      resourceId: 'https://example.test/book.cbz',
      identity: { id: 'item' },
      displayName: 'book.cbz',
      extension: 'cbz',
      mimeType: 'application/zip',
    };
    const { source } = await openRemoteSource(target, { invoker });
    expect(source.access).toBe('remote');
    expect(await source.readRange(1, 2)).toEqual(new Uint8Array([2, 3]));
    await source.close();
    expect(calls.map((call) => call.command)).toEqual([
      'remote_open',
      'remote_read_range',
      'remote_close',
    ]);
    expect(calls[1]?.args).toMatchObject({ offset: 1, length: 2, resourceId: 'remote-1' });
  });

  it('does not invoke close twice', async () => {
    const commands: string[] = [];
    const invoke = (async <T>(command: string) => {
      commands.push(command);
      if (command === 'remote_open') {
        return {
          resourceId: 'remote-1',
          size: 0,
          identity: 'item',
          supportsRanges: false,
          cacheComplete: true,
        } as T;
      }
      return undefined as T;
    }) as RemoteSourceInvoker['invoke'];
    const target = {
      kind: 'remote' as const,
      itemId: 'item',
      resourceId: 'https://example.test/empty',
      identity: { id: 'item' },
      displayName: 'empty',
      extension: '',
      mimeType: 'application/octet-stream',
    };
    const { source } = await openRemoteSource(target, { invoker: { invoke } });
    await source.close();
    await source.close();
    expect(commands.filter((command) => command === 'remote_close')).toHaveLength(1);
  });
});
