import { describe, expect, it, vi } from 'vitest';

import {
  WebDavSourceClient,
  type WebDavSourceClientInvoker,
} from '../webdav-source-client.js';

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
