import { describe, expect, it } from 'vitest';

import type { AcquisitionLink, LibraryItem } from '../library-client.js';
import {
  cacheLibraryRemoteItem,
  libraryRemoteOpenArgs,
  openLibraryRemote,
  remoteNeedsRangeWarning,
} from '../library-remote.js';
import { libraryRemoteSourceOf, type LibraryRemoteSource } from '../opds-client.js';
import type { RemoteOpenResult, RemoteSourceInvoker } from '../../reader/sources/remote-source.js';

const webdavSource: LibraryRemoteSource = {
  url: 'https://dav.example/remote.php/dav',
  allowHttp: false,
  credentialRef: 'webdav-source-webdav-1',
};

const acquisition: AcquisitionLink = {
  itemId: 'webdav-item-1',
  href: 'https://dav.example/remote.php/dav/One%20Piece%2001.cbz',
  rel: 'http://opds-spec.org/acquisition',
  mediaType: 'application/vnd.comicbook+zip',
  extension: 'cbz',
  size: 4_301_445,
};

function webdavItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'webdav-item-1',
    sourceId: 'webdav-1',
    sourceKind: 'webdav',
    title: 'One Piece 01.cbz',
    authors: [],
    acquisitionUrl: acquisition.href,
    mediaType: acquisition.mediaType,
    extension: 'cbz',
    size: acquisition.size,
    updatedAt: 1,
    ...overrides,
  };
}

function opened(overrides: Partial<RemoteOpenResult> = {}): RemoteOpenResult {
  return {
    resourceId: 'remote-webdav-1',
    size: 20 * 1024 * 1024,
    identity: 'webdav-item-1@etag',
    etag: 'etag-1',
    lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT',
    mimeType: 'application/vnd.comicbook+zip',
    supportsRanges: true,
    cacheComplete: false,
    ...overrides,
  };
}

function recordingInvoker(
  handler: RemoteSourceInvoker['invoke'] = async <T>(command: string): Promise<T> => {
    if (command === 'remote_open') return opened() as T;
    return undefined as T;
  },
): { invoker: RemoteSourceInvoker; calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return handler(command, args);
  }) as RemoteSourceInvoker['invoke'];
  return { invoker: { invoke }, calls };
}

describe('libraryRemoteOpenArgs', () => {
  it('forwards a WebDAV credentialRef only to a same-origin acquisition', () => {
    const request = { item: webdavItem(), acquisition, source: webdavSource };
    const sameOrigin = libraryRemoteOpenArgs(request, 'library-open-1');
    expect(sameOrigin).toEqual({
      url: acquisition.href,
      itemId: 'webdav-item-1',
      allowHttp: false,
      credentialRef: 'webdav-source-webdav-1',
      requestId: 'library-open-1',
      expectedSize: 4_301_445,
    });
    expect(JSON.stringify(sameOrigin)).not.toMatch(/password|token|secret/i);

    const crossOrigin = libraryRemoteOpenArgs(
      {
        ...request,
        acquisition: { ...acquisition, href: 'https://cdn.example/One Piece 01.cbz' },
      },
      'library-open-2',
    );
    expect(crossOrigin.credentialRef).toBeUndefined();
    expect(crossOrigin.url).toBe('https://cdn.example/One Piece 01.cbz');
  });

  it('passes allowHttp for an HTTP WebDAV source and still scopes the credential by origin', () => {
    const source: LibraryRemoteSource = {
      url: 'http://192.168.1.2/dav',
      allowHttp: true,
      credentialRef: 'webdav-source-lan',
    };
    const args = libraryRemoteOpenArgs(
      {
        item: webdavItem({ id: 'webdav-item-lan' }),
        acquisition: { ...acquisition, href: 'http://192.168.1.2/dav/book.cbz' },
        source,
      },
      'library-open-http',
    );
    expect(args.allowHttp).toBe(true);
    expect(args.credentialRef).toBe('webdav-source-lan');
    expect(
      libraryRemoteOpenArgs(
        {
          item: webdavItem(),
          acquisition: { ...acquisition, href: 'https://192.168.1.2/dav/book.cbz' },
          source,
        },
        'library-open-https',
      ).credentialRef,
    ).toBeUndefined();
  });

  it('keeps OPDS acquisitions on the same shared source shape', () => {
    const source: LibraryRemoteSource = {
      url: 'https://books.example/opds',
      allowHttp: false,
      credentialRef: 'credential-1',
    };
    expect(
      libraryRemoteOpenArgs(
        {
          item: { ...webdavItem(), id: 'opds:source-1:book-12', sourceKind: 'opds' },
          acquisition: { ...acquisition, href: 'https://books.example/get/EPUB/12' },
          source,
        },
        'library-open-opds',
      ).credentialRef,
    ).toBe('credential-1');
  });
});

describe('openLibraryRemote', () => {
  it('opens a WebDAV book through remote_open without putting secrets on the wire', async () => {
    const { invoker, calls } = recordingInvoker();
    const result = await openLibraryRemote(
      { item: webdavItem(), acquisition, source: webdavSource },
      { invoker, requestId: 'library-open-webdav' },
    );
    expect(result.resourceId).toBe('remote-webdav-1');
    expect(result.supportsRanges).toBe(true);
    expect(calls).toEqual([
      {
        command: 'remote_open',
        args: {
          url: acquisition.href,
          itemId: 'webdav-item-1',
          allowHttp: false,
          credentialRef: 'webdav-source-webdav-1',
          requestId: 'library-open-webdav',
          expectedSize: 4_301_445,
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/password|token|secret/i);
  });

  it('closes the handle when a WebDAV open is aborted after remote_open returns', async () => {
    const controller = new AbortController();
    const { invoker, calls } = recordingInvoker(async <T>(command: string) => {
      if (command === 'remote_open') {
        controller.abort();
        return opened() as T;
      }
      return undefined as T;
    });
    await expect(
      openLibraryRemote(
        { item: webdavItem(), acquisition, source: webdavSource },
        { invoker, signal: controller.signal, requestId: 'library-open-abort' },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls.map((call) => call.command)).toEqual([
      'remote_open',
      'remote_cancel',
      'remote_close',
    ]);
  });
});

describe('cacheLibraryRemoteItem', () => {
  it('downloads a WebDAV book in 16MiB ranges and upserts the same shelf id twice', async () => {
    const upserted: LibraryItem[] = [];
    const { invoker, calls } = recordingInvoker();
    const request = { item: webdavItem(), acquisition, source: webdavSource };

    await cacheLibraryRemoteItem(request, {
      invoker,
      upsertItem: async (item) => {
        upserted.push(item);
      },
    });
    await cacheLibraryRemoteItem(request, {
      invoker,
      upsertItem: async (item) => {
        upserted.push(item);
      },
    });

    const ranges = calls.filter((call) => call.command === 'remote_read_range');
    expect(ranges).toHaveLength(4);
    expect(ranges[0]?.args).toMatchObject({
      resourceId: 'remote-webdav-1',
      offset: 0,
      length: 16 * 1024 * 1024,
    });
    expect(ranges[1]?.args).toMatchObject({
      resourceId: 'remote-webdav-1',
      offset: 16 * 1024 * 1024,
      length: 4 * 1024 * 1024,
    });
    expect(upserted).toHaveLength(2);
    expect(upserted[0]?.id).toBe('webdav-item-1');
    expect(upserted[1]?.id).toBe(upserted[0]?.id);
    expect(upserted[0]?.sourceKind).toBe('webdav');
    expect(upserted[0]?.etag).toBe('etag-1');
    expect(upserted[0]?.size).toBe(20 * 1024 * 1024);
    expect(calls.filter((call) => call.command === 'remote_close')).toHaveLength(2);
    expect(JSON.stringify(calls)).not.toMatch(/password|token|secret/i);
  });

  it('does not open or upsert local and managed shelf rows', async () => {
    const upserted: LibraryItem[] = [];
    const { invoker, calls } = recordingInvoker();
    await cacheLibraryRemoteItem(
      {
        item: webdavItem({ sourceKind: 'local', localPath: '/books/a.cbz' }),
        acquisition,
        source: webdavSource,
      },
      { invoker, upsertItem: async (item) => { upserted.push(item); } },
    );
    await cacheLibraryRemoteItem(
      {
        item: webdavItem({ sourceKind: 'managed', blobHash: 'abc' }),
        acquisition,
        source: webdavSource,
      },
      { invoker, upsertItem: async (item) => { upserted.push(item); } },
    );
    expect(calls).toEqual([]);
    expect(upserted).toEqual([]);
  });
});

describe('remoteNeedsRangeWarning', () => {
  it('reuses the existing noRange path when the WebDAV server has no Range support', () => {
    expect(remoteNeedsRangeWarning({ supportsRanges: false })).toBe(true);
    expect(remoteNeedsRangeWarning({ supportsRanges: true })).toBe(false);
  });
});

describe('libraryRemoteSourceOf', () => {
  it('drops catalog metadata and never copies a secret body', () => {
    const stripped = libraryRemoteSourceOf({
      url: webdavSource.url,
      allowHttp: false,
      credentialRef: 'webdav-source-webdav-1',
      password: 'hunter2',
    } as LibraryRemoteSource & { password: string });
    expect(stripped).toEqual({
      url: webdavSource.url,
      allowHttp: false,
      credentialRef: 'webdav-source-webdav-1',
    });
    expect(JSON.stringify(stripped)).not.toContain('hunter2');
  });
});
