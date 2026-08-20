import { describe, expect, it, vi } from 'vitest';

import {
  credentialRefForResource,
  OpdsClient,
  type OpdsClientInvoker,
  type OpdsCredential,
  type OpdsFeed,
  type OpdsSource,
} from '../opds-client.js';

function recordingClient(invoke: OpdsClientInvoker['invoke']): OpdsClient {
  return new OpdsClient({
    invoke: vi.fn(invoke) as unknown as OpdsClientInvoker['invoke'],
  });
}

/** Native layer already mapped an OPDS 2.0 JSON catalog onto the shared feed shape. */
function mappedOpds20Feed(): OpdsFeed {
  return {
    id: 'https://books.example/opds2',
    title: 'OPDS 2.0 书库',
    updated: '2026-01-01T00:00:00Z',
    entries: [
      {
        id: 'urn:isbn:9780000000001',
        itemId: 'opds-item-santi',
        title: '三体',
        authors: ['刘慈欣'],
        updated: '2026-01-01T00:00:00Z',
        summary: '科幻',
        coverUrl: 'https://books.example/covers/santi.jpg',
        links: [
          {
            href: 'https://books.example/books/santi.epub',
            rel: 'http://opds-spec.org/acquisition',
            mediaType: 'application/epub+zip',
            title: 'EPUB',
            size: 2048,
            extension: 'epub',
            acquisition: true,
          },
        ],
      },
    ],
    links: [
      {
        href: 'https://books.example/opds2?page=2',
        rel: 'next',
        mediaType: 'application/opds+json',
        acquisition: false,
      },
      {
        href: 'https://books.example/search?q={searchTerms}',
        rel: 'search',
        mediaType: 'application/opds+json',
        acquisition: false,
      },
    ],
    nextUrl: 'https://books.example/opds2?page=2',
    searchTemplate: 'https://books.example/search?q={searchTerms}',
    sourceUrl: 'https://books.example/opds2',
  };
}

function atomFeed(): OpdsFeed {
  return {
    id: 'catalog',
    title: 'OPDS 1.x 书库',
    updated: '2026-01-01',
    entries: [
      {
        id: 'book-1',
        title: 'Book 10',
        authors: ['Alice'],
        coverUrl: 'https://books.example/opds/covers/a.jpg',
        links: [
          {
            href: 'https://books.example/opds/books/a.cbz',
            rel: 'http://opds-spec.org/acquisition',
            mediaType: 'application/vnd.comicbook+zip',
            size: 123,
            extension: 'cbz',
            acquisition: true,
          },
        ],
      },
    ],
    links: [
      {
        href: 'https://books.example/opds?page=2',
        rel: 'next',
        acquisition: false,
      },
    ],
    nextUrl: 'https://books.example/opds?page=2',
    searchTemplate: 'https://books.example/opds/search?q={searchTerms}',
    sourceUrl: 'https://books.example/opds',
  };
}

describe('OpdsClient', () => {
  it('maps source, browse, and search calls to native commands', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        calls.push({ command, args });
        return (command === 'opds_list_sources' ? [] : {}) as T;
    };
    const invoker: OpdsClientInvoker = {
      invoke: vi.fn(invoke) as unknown as OpdsClientInvoker['invoke'],
    };
    const client = new OpdsClient(invoker);

    await client.addSource({ title: '本地书库', url: 'https://books.example/opds' });
    await client.browse('source-1', 'https://books.example/opds?page=2');
    await client.search('source-1', '三体');
    await client.removeSource('source-1');

    expect(calls).toEqual([
      {
        command: 'opds_add_source',
        args: { source: { title: '本地书库', url: 'https://books.example/opds' } },
      },
      {
        command: 'opds_browse',
        args: { sourceId: 'source-1', url: 'https://books.example/opds?page=2' },
      },
      { command: 'opds_search', args: { sourceId: 'source-1', query: '三体' } },
      { command: 'opds_remove_source', args: { sourceId: 'source-1' } },
    ]);
  });

  it('does not transform or persist credential fields in the client', async () => {
    const invoke = vi.fn(async <T>(_command: string, _args?: Record<string, unknown>): Promise<T> => ({
      id: 'source-1',
    }) as T);
    const client = new OpdsClient({
      invoke: invoke as unknown as OpdsClientInvoker['invoke'],
    });
    const credential = { kind: 'bearer' as const, token: 'session-token' };

    await client.addSource({
      title: '受保护书库',
      url: 'https://books.example/opds',
      credential,
    });

    expect(invoke).toHaveBeenCalledWith('opds_add_source', {
      source: expect.objectContaining({ credential }),
    });
  });

  it('scopes source credentials to the same URL origin', () => {
    const source: OpdsSource = {
      id: 'source-1',
      title: '受保护书库',
      url: 'https://books.example/opds',
      credentialRef: 'credential-1',
      allowHttp: false,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(credentialRefForResource(source, 'https://books.example:443/book.cbz')).toBe(
      'credential-1',
    );
    expect(credentialRefForResource(source, 'https://cdn.example/book.cbz')).toBeUndefined();
    expect(credentialRefForResource(source, 'http://books.example/book.cbz')).toBeUndefined();
  });

  it('adds and browses an OPDS 2.0 catalog through the same native commands as 1.x', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = recordingClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return {} as T;
    });

    await client.addSource({
      title: 'OPDS 2.0 书库',
      url: 'https://books.example/opds2',
      allowHttp: false,
    });
    await client.browse('source-20', 'https://books.example/opds2?page=2');
    await client.search('source-20', '三体');

    expect(calls).toEqual([
      {
        command: 'opds_add_source',
        args: {
          source: {
            title: 'OPDS 2.0 书库',
            url: 'https://books.example/opds2',
            allowHttp: false,
          },
        },
      },
      {
        command: 'opds_browse',
        args: { sourceId: 'source-20', url: 'https://books.example/opds2?page=2' },
      },
      { command: 'opds_search', args: { sourceId: 'source-20', query: '三体' } },
    ]);
    expect(calls.every((call) => call.args && !('format' in call.args) && !('kind' in call.args))).toBe(
      true,
    );
  });

  it('returns a native-mapped OPDS 2.0 feed so catalog, search, and acquisition stay on OpdsFeed', async () => {
    const feed = mappedOpds20Feed();
    const client = recordingClient(async <T>(command: string) => {
      if (command === 'opds_browse' || command === 'opds_search') {
        return feed as T;
      }
      return {} as T;
    });

    const browsed = await client.browse('source-20');
    const searched = await client.search('source-20', '三体');

    expect(browsed).toBe(feed);
    expect(searched).toBe(feed);
    expect(browsed.entries[0]?.links[0]).toEqual(
      expect.objectContaining({
        href: 'https://books.example/books/santi.epub',
        mediaType: 'application/epub+zip',
        extension: 'epub',
        acquisition: true,
      }),
    );
    expect(browsed.searchTemplate).toBe('https://books.example/search?q={searchTerms}');
    expect(browsed.nextUrl).toBe('https://books.example/opds2?page=2');
  });

  it('keeps 1.x Atom browse on opds_browse after a 2.0 source is added', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const atom = atomFeed();
    const json = mappedOpds20Feed();
    const client = recordingClient(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === 'opds_browse') {
        return (args?.sourceId === 'source-1x' ? atom : json) as T;
      }
      return {} as T;
    });

    await client.addSource({ title: 'OPDS 2.0 书库', url: 'https://books.example/opds2' });
    const atomResult = await client.browse('source-1x', 'https://books.example/opds');
    const jsonResult = await client.browse('source-20', 'https://books.example/opds2');

    expect(calls.filter((call) => call.command === 'opds_browse')).toEqual([
      {
        command: 'opds_browse',
        args: { sourceId: 'source-1x', url: 'https://books.example/opds' },
      },
      {
        command: 'opds_browse',
        args: { sourceId: 'source-20', url: 'https://books.example/opds2' },
      },
    ]);
    expect(atomResult).toBe(atom);
    expect(jsonResult).toBe(json);
    expect(atomResult.title).toBe('OPDS 1.x 书库');
    expect(atomResult.entries[0]?.links[0]?.acquisition).toBe(true);
  });

  it('only forwards none, basic, or bearer credentials when adding a source', async () => {
    const payloads: unknown[] = [];
    const client = recordingClient(async <T>(_command: string, args?: Record<string, unknown>) => {
      payloads.push(args?.source);
      return {} as T;
    });
    const basic: OpdsCredential = { kind: 'basic', username: 'reader', password: 'secret' };
    const bearer: OpdsCredential = { kind: 'bearer', token: 'session-token' };

    await client.addSource({ title: '公开书库', url: 'https://books.example/opds2' });
    await client.addSource({
      title: 'Basic 书库',
      url: 'https://books.example/opds2',
      credential: basic,
    });
    await client.addSource({
      title: 'Bearer 书库',
      url: 'https://books.example/opds2',
      credential: bearer,
    });

    expect(payloads).toEqual([
      { title: '公开书库', url: 'https://books.example/opds2' },
      { title: 'Basic 书库', url: 'https://books.example/opds2', credential: basic },
      { title: 'Bearer 书库', url: 'https://books.example/opds2', credential: bearer },
    ]);
    for (const payload of payloads) {
      const credential = (payload as { credential?: OpdsCredential }).credential;
      expect(credential === undefined || credential.kind === 'basic' || credential.kind === 'bearer').toBe(
        true,
      );
    }
  });
});
