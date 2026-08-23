// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  acquisitionFileName,
  BROWSER_OPDS_PROXY_PATH,
  createBrowserOpdsClient,
  fetchProxiedRemoteFile,
  OPDS_CREDENTIALS_STORAGE_KEY,
  OPDS_SOURCES_STORAGE_KEY,
} from '../browser-opds-client.js';
import { mapOpdsAtomFeed, validateRemoteCatalogUrl } from '../opds-client.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    dump: () => data,
  };
}

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>catalog</id><title>测试书库</title><updated>2026-01-01</updated>
  <link rel="next" href="?page=2" />
  <link rel="search" href="search?q={searchTerms}" type="application/atom+xml" />
  <entry><id>book-1</id><title>Book 10</title><author><name>Alice</name></author>
    <link rel="http://opds-spec.org/acquisition" href="books/a.cbz" type="application/vnd.comicbook+zip" length="123" />
    <link rel="http://opds-spec.org/image" href="covers/a.jpg" type="image/jpeg" />
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
  metadata: { title: 'OPDS 2.0 书库' },
  publications: [
    {
      metadata: { identifier: 'urn:book', title: '三体', author: '刘慈欣' },
      links: [
        {
          rel: 'http://opds-spec.org/acquisition',
          href: '/books/santi.epub',
          type: 'application/epub+zip',
        },
      ],
    },
  ],
  links: [{ rel: 'search', href: '/search?q={searchTerms}' }],
});

describe('validateRemoteCatalogUrl', () => {
  it('accepts https and opt-in http, and rejects credentials or other schemes', () => {
    expect(validateRemoteCatalogUrl('https://books.example/opds')).toBe(
      'https://books.example/opds',
    );
    expect(validateRemoteCatalogUrl('http://192.168.1.2/opds', true)).toBe(
      'http://192.168.1.2/opds',
    );
    expect(() => validateRemoteCatalogUrl('http://192.168.1.2/opds')).toThrow(
      'HTTP 源需要由用户明确允许',
    );
    expect(() => validateRemoteCatalogUrl('https://user:pass@books.example/opds')).toThrow(
      'URL 不能包含用户名或密码',
    );
    expect(() => validateRemoteCatalogUrl('file:///tmp/opds')).toThrow('URL 缺少主机名');
    expect(() => validateRemoteCatalogUrl('ftp://books.example/opds')).toThrow('仅支持 HTTP(S)');
  });
});

describe('mapOpdsAtomFeed', () => {
  it('parses relative links, pagination, search, and covers', () => {
    const feed = mapOpdsAtomFeed(ATOM_FEED, 'https://example.test/opds/index.xml');
    expect(feed.title).toBe('测试书库');
    expect(feed.nextUrl).toBe('https://example.test/opds/index.xml?page=2');
    expect(feed.searchTemplate).toBe('https://example.test/opds/search?q={searchTerms}');
    expect(feed.entries[0]?.authors).toEqual(['Alice']);
    expect(feed.entries[0]?.coverUrl).toBe('https://example.test/opds/covers/a.jpg');
    expect(feed.entries[0]?.links[0]?.acquisition).toBe(true);
    expect(feed.entries[0]?.links[0]?.extension).toBe('cbz');
  });

  it('skips data: cover links so the rest of an Atom catalog still loads', () => {
    const feed = mapOpdsAtomFeed(
      `<?xml version="1.0" encoding="UTF-8"?>
       <feed xmlns="http://www.w3.org/2005/Atom">
         <title>Gutenberg</title>
         <entry>
           <id>ebook-1</id><title>Pride</title>
           <link rel="http://opds-spec.org/image" href="data:image/png;base64,AAAA" type="image/png" />
           <link rel="subsection" href="/ebooks/1.opds" type="application/atom+xml" />
         </entry>
       </feed>`,
      'https://www.gutenberg.org/ebooks/search.opds/',
    );
    expect(feed.title).toBe('Gutenberg');
    expect(feed.entries[0]?.title).toBe('Pride');
    expect(feed.entries[0]?.coverUrl).toBeUndefined();
    expect(feed.entries[0]?.links[0]?.href).toBe('https://www.gutenberg.org/ebooks/1.opds');
  });
});

describe('createBrowserOpdsClient', () => {
  it('adds a source without invoking Tauri and persists the portable record', async () => {
    const storage = memoryStorage();
    const client = createBrowserOpdsClient({
      storage,
      now: () => 1000,
      proxyPath: null,
    });

    const source = await client.addSource({
      title: '本地书库',
      url: 'https://books.example/opds',
    });

    expect(source.title).toBe('本地书库');
    expect(source.url).toBe('https://books.example/opds');
    expect(source.id).toMatch(/^opds-[0-9a-f]{16}$/);
    expect(await client.listSources()).toEqual([source]);
    expect(JSON.parse(storage.getItem(OPDS_SOURCES_STORAGE_KEY) ?? '[]')).toEqual([
      {
        id: source.id,
        title: '本地书库',
        url: 'https://books.example/opds',
        allowHttp: false,
        createdAt: 1000,
        updatedAt: 1000,
      },
    ]);
  });

  it('rejects an empty title and HTTP without allowHttp', async () => {
    const client = createBrowserOpdsClient({ storage: memoryStorage(), proxyPath: null });
    await expect(client.addSource({ title: '  ', url: 'https://books.example/opds' })).rejects.toThrow(
      'OPDS 源标题不能为空',
    );
    await expect(
      client.addSource({ title: 'LAN', url: 'http://192.168.1.2/opds' }),
    ).rejects.toThrow('HTTP 源需要由用户明确允许');
  });

  it('browses OPDS 1.x and 2.0 through the same-origin Vite proxy', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const href = String(input);
      expect(href.startsWith(`${BROWSER_OPDS_PROXY_PATH}?url=`)).toBe(true);
      const target = new URL(href, 'http://localhost:1420').searchParams.get('url');
      if (target?.includes('opds2')) {
        return new Response(JSON_FEED, { headers: { 'Content-Type': 'application/opds+json' } });
      }
      return new Response(ATOM_FEED, { headers: { 'Content-Type': 'application/atom+xml' } });
    });
    const client = createBrowserOpdsClient({
      storage,
      fetch: fetchImpl as unknown as typeof fetch,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
    });
    const atomSource = await client.addSource({
      title: 'Atom',
      url: 'https://example.test/opds/index.xml',
    });
    const jsonSource = await client.addSource({
      title: 'JSON',
      url: 'https://books.example/opds2',
    });

    const atom = await client.browse(atomSource.id);
    const json = await client.browse(jsonSource.id);

    expect(atom.title).toBe('测试书库');
    expect(atom.entries[0]?.title).toBe('Book 10');
    expect(json.title).toBe('OPDS 2.0 书库');
    expect(json.entries[0]?.title).toBe('三体');
    expect(json.searchTemplate).toBe('https://books.example/search?q={searchTerms}');
  });

  it('searches with the catalog template and sends stored credentials', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('reader:secret')}`);
      if (href.includes(encodeURIComponent('q=%E4%B8%89%E4%BD%93'))) {
        return new Response(JSON_FEED, { headers: { 'Content-Type': 'application/opds+json' } });
      }
      return new Response(JSON_FEED, { headers: { 'Content-Type': 'application/opds+json' } });
    });
    const client = createBrowserOpdsClient({
      storage: memoryStorage(),
      fetch: fetchImpl as unknown as typeof fetch,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
    });
    const source = await client.addSource({
      title: '受保护书库',
      url: 'https://books.example/opds2',
      credential: { kind: 'basic', username: 'reader', password: 'secret' },
    });

    await client.browse(source.id);
    fetchImpl.mockClear();
    const feed = await client.search(source.id, '三体');
    expect(feed.title).toBe('OPDS 2.0 书库');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const searchUrl = String(fetchImpl.mock.calls[0]?.[0]);
    expect(searchUrl).toContain(encodeURIComponent('https://books.example/search?q='));
  });

  it('aborts an in-flight catalog search when the signal fires', async () => {
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
          release = () =>
            resolve(new Response(JSON_FEED, { headers: { 'Content-Type': 'application/opds+json' } }));
        }),
    );
    const client = createBrowserOpdsClient({
      storage: memoryStorage(),
      fetch: fetchImpl as unknown as typeof fetch,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
    });
    const source = await client.addSource({
      title: '书库',
      url: 'https://books.example/opds2',
    });
    const controller = new AbortController();
    const pending = client.search(source.id, '三体', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release?.();
  });

  it('keeps OPDS credentials on this device after a client remount', async () => {
    const storage = memoryStorage();
    const first = createBrowserOpdsClient({
      storage,
      now: () => 1000,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
      fetch: (async () => new Response(JSON_FEED, {
        headers: { 'Content-Type': 'application/opds+json' },
      })) as unknown as typeof fetch,
    });
    const source = await first.addSource({
      title: '受保护书库',
      url: 'https://books.example/opds2',
      credential: { kind: 'basic', username: 'reader', password: 'secret' },
    });

    expect(JSON.parse(storage.getItem(OPDS_SOURCES_STORAGE_KEY) ?? '[]')[0]).not.toHaveProperty(
      'credential',
    );
    expect(JSON.parse(storage.getItem(OPDS_SOURCES_STORAGE_KEY) ?? '[]')[0]).not.toHaveProperty(
      'credentialRef',
    );
    expect(JSON.parse(storage.getItem(OPDS_CREDENTIALS_STORAGE_KEY) ?? '{}')).toEqual({
      [source.id]: { kind: 'basic', username: 'reader', password: 'secret' },
    });

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('reader:secret')}`);
      return new Response(JSON_FEED, { headers: { 'Content-Type': 'application/opds+json' } });
    });
    const remounted = createBrowserOpdsClient({
      storage,
      fetch: fetchImpl as unknown as typeof fetch,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
    });
    expect((await remounted.listSources())[0]?.credentialRef).toBe(`opds-source-${source.id}`);
    await remounted.browse(source.id);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await remounted.removeSource(source.id);
    expect(JSON.parse(storage.getItem(OPDS_CREDENTIALS_STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('explains a CORS failure when fetching the catalog directly', async () => {
    const client = createBrowserOpdsClient({
      storage: memoryStorage(),
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      proxyPath: null,
    });
    const source = await client.addSource({
      title: '公开书库',
      url: 'https://books.example/opds',
    });
    await expect(client.browse(source.id)).rejects.toThrow('浏览器无法跨域访问此书库源');
  });

  it('downloads an acquisition through the proxy and names the file from the title', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]), {
      headers: { 'Content-Type': 'application/epub+zip' },
    }));
    const client = createBrowserOpdsClient({
      storage: memoryStorage(),
      fetch: fetchImpl as unknown as typeof fetch,
      proxyPath: BROWSER_OPDS_PROXY_PATH,
    });
    const source = await client.addSource({
      title: 'calibre',
      url: 'http://192.168.1.8:8080/opds',
      allowHttp: true,
    });
    const file = await client.fetchAcquisition(source.id, 'http://192.168.1.8:8080/get/EPUB/12', {
      filename: acquisitionFileName({ title: '星空职业者', extension: 'epub' }),
      mimeType: 'application/epub+zip',
    });
    expect(file.name).toBe('星空职业者.epub');
    expect(await file.arrayBuffer()).toEqual(new Uint8Array([80, 75, 3, 4]).buffer);
    expect(JSON.stringify(fetchImpl.mock.calls)).toContain(
      encodeURIComponent('http://192.168.1.8:8080/get/EPUB/12'),
    );
  });
});

describe('fetchProxiedRemoteFile', () => {
  it('reports download progress from the response body', async () => {
    const onProgress = vi.fn();
    const payload = new Uint8Array([80, 75, 3, 4]);
    const file = await fetchProxiedRemoteFile('https://books.example/get/1', {
      allowHttp: false,
      filename: 'book.epub',
      proxyPath: null,
      onProgress,
      fetch: (async () =>
        new Response(payload, {
          headers: {
            'Content-Type': 'application/epub+zip',
            'Content-Length': String(payload.byteLength),
          },
        })) as unknown as typeof fetch,
    });
    expect(file.size).toBe(4);
    expect(onProgress).toHaveBeenCalled();
    const last = onProgress.mock.calls[onProgress.mock.calls.length - 1] as
      | [number, number]
      | undefined;
    expect(last?.[0]).toBe(4);
    expect(last?.[1]).toBe(4);
  });

  it('uses the OPDS/WebDAV catalog size when the response has no Content-Length', async () => {
    const onProgress = vi.fn();
    const payload = new Uint8Array([80, 75, 3, 4]);
    await fetchProxiedRemoteFile('https://books.example/get/1', {
      allowHttp: false,
      filename: 'book.epub',
      proxyPath: null,
      expectedSize: 12345,
      onProgress,
      fetch: (async () =>
        new Response(payload, {
          headers: { 'Content-Type': 'application/epub+zip' },
        })) as unknown as typeof fetch,
    });
    const progressCalls = onProgress.mock.calls as [number, number?][];
    expect(progressCalls[0]?.[1]).toBe(12345);
    expect(progressCalls[progressCalls.length - 1]?.[1]).toBe(12345);
  });

  it('rejects an HTML login page instead of treating it as a book', async () => {
    await expect(
      fetchProxiedRemoteFile('https://books.example/get/1', {
        allowHttp: false,
        filename: 'book.epub',
        proxyPath: null,
        fetch: (async () =>
          new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow('网页而不是书籍');
  });
});
