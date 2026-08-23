import type { SyncStorageLike } from '../storage/syncable-storage.js';
import {
  parseOpdsCatalog,
  validateRemoteCatalogUrl,
  type OpdsClient,
  type OpdsCredential,
  type OpdsFeed,
  type OpdsSource,
  type OpdsSourceInput,
} from './opds-client.js';

export const OPDS_SOURCES_STORAGE_KEY = 'lightink.opds.sources';
/** Device-local secrets. Never write this key into the portable/sync allow-list. */
export const OPDS_CREDENTIALS_STORAGE_KEY = 'lightink.opds.credentials';
export const BROWSER_OPDS_PROXY_PATH = '/__lightink/opds-proxy';

export interface BrowserOpdsClientOptions {
  readonly storage: Pick<SyncStorageLike, 'getItem' | 'setItem'>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Same-origin Vite proxy. `null` fetches the catalog URL directly. */
  readonly proxyPath?: string | null;
}

type PortableOpdsSource = {
  id: string;
  title: string;
  url: string;
  allowHttp: boolean;
  createdAt: number;
  updatedAt: number;
};

function defaultProxyPath(): string | null {
  if (typeof window === 'undefined') return null;
  const protocol = window.location?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return BROWSER_OPDS_PROXY_PATH;
}

function isPortableSource(value: unknown): value is PortableOpdsSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.id === 'string' &&
    typeof source.title === 'string' &&
    typeof source.url === 'string' &&
    typeof source.allowHttp === 'boolean' &&
    typeof source.createdAt === 'number' &&
    typeof source.updatedAt === 'number'
  );
}

function isLikelyCorsFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /failed to fetch|networkerror|load failed|cors/i.test(error.message);
}

async function stableSourceId(url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `opds-${hex}`;
}

function isStoredCredential(value: unknown): value is OpdsCredential {
  if (typeof value !== 'object' || value === null) return false;
  const credential = value as Record<string, unknown>;
  if (credential.kind === 'basic') {
    return typeof credential.username === 'string' && typeof credential.password === 'string';
  }
  if (credential.kind === 'bearer') {
    return typeof credential.token === 'string';
  }
  return false;
}

function authorizationHeader(credential: OpdsCredential | undefined): string | undefined {
  if (credential === undefined) return undefined;
  if (credential.kind === 'bearer') {
    const token = credential.token?.trim() ?? '';
    return token === '' ? undefined : `Bearer ${token}`;
  }
  const username = credential.username ?? '';
  const password = credential.password ?? '';
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function catalogRequestUrl(url: string, proxyPath: string | null): string {
  if (proxyPath === null || proxyPath === '') return url;
  return `${proxyPath}?url=${encodeURIComponent(url)}`;
}

function fileNameFromTitle(title: string, extension?: string): string {
  const stem = title.replace(/[<>:"/\\|?*]+/g, ' ').trim().replace(/\s+/g, ' ');
  const base = stem === '' ? 'book' : stem.slice(0, 80);
  const ext = (extension ?? '').replace(/^\./, '').toLowerCase();
  return ext === '' ? base : `${base}.${ext}`;
}

export function acquisitionFileName(
  item: { readonly title: string; readonly extension?: string },
  acquisition?: { readonly extension?: string; readonly mediaType?: string },
): string {
  return fileNameFromTitle(item.title, acquisition?.extension ?? item.extension);
}

export interface FetchProxiedRemoteFileOptions {
  readonly allowHttp: boolean;
  readonly authorization?: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly proxyPath?: string | null;
  readonly onProgress?: (loaded: number, total?: number) => void;
  /** OPDS `length` / WebDAV `getcontentlength` when the response omits Content-Length. */
  readonly expectedSize?: number;
}

function positiveSize(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

async function readResponseBytes(
  response: Response,
  onProgress?: (loaded: number, total?: number) => void,
  expectedSize?: number,
): Promise<Uint8Array> {
  const lengthHeader = response.headers.get('content-length');
  const parsed = lengthHeader === null ? Number.NaN : Number(lengthHeader);
  const total =
    (Number.isFinite(parsed) && parsed > 0 ? parsed : undefined) ??
    positiveSize(expectedSize);
  if (onProgress === undefined || response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(bytes.byteLength, total ?? bytes.byteLength);
    return bytes;
  }
  onProgress(0, total);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Download an OPDS/WebDAV acquisition through the Vite proxy (or directly). */
export async function fetchProxiedRemoteFile(
  href: string,
  options: FetchProxiedRemoteFileOptions,
): Promise<File> {
  const target = validateRemoteCatalogUrl(href, options.allowHttp);
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const proxyPath = options.proxyPath === undefined ? defaultProxyPath() : options.proxyPath;
  const headers = new Headers({
    Accept: options.mimeType ?? 'application/octet-stream, */*;q=0.1',
  });
  if (options.authorization !== undefined && options.authorization !== '') {
    headers.set('Authorization', options.authorization);
  }
  let response: Response;
  try {
    response = await fetchImpl(catalogRequestUrl(target, proxyPath), {
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    if (proxyPath === null && isLikelyCorsFailure(error)) {
      throw new Error('浏览器无法跨域下载此书籍。请改用桌面应用，或确认该书库允许跨域。');
    }
    throw new Error('无法下载此书籍。');
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('此书库源需要身份验证。');
  }
  if (!response.ok) {
    throw new Error(`无法下载此书籍（HTTP ${response.status}）。`);
  }
  const mime = (response.headers.get('content-type') ?? options.mimeType ?? '').toLowerCase();
  if (mime.includes('text/html') || mime.includes('application/xhtml')) {
    throw new Error('此链接返回了网页而不是书籍。请确认获取链接，或先登录该书库源。');
  }
  const bytes = await readResponseBytes(response, options.onProgress, options.expectedSize);
  if (bytes.byteLength === 0) {
    throw new Error('书籍下载为空。');
  }
  const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new File([blob as ArrayBuffer], options.filename, {
    type: options.mimeType ?? response.headers.get('content-type') ?? 'application/octet-stream',
  });
}

/** Browser OPDS facade for `npm run dev` without Tauri IPC. */
export function createBrowserOpdsClient(
  options: BrowserOpdsClientOptions,
): Pick<OpdsClient, 'addSource' | 'listSources' | 'removeSource' | 'browse' | 'search'> & {
  fetchAcquisition(
    sourceId: string,
    href: string,
    init?: {
      readonly signal?: AbortSignal;
      readonly filename?: string;
      readonly mimeType?: string;
      readonly onProgress?: (loaded: number, total?: number) => void;
      readonly expectedSize?: number;
    },
  ): Promise<File>;
} {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const proxyPath = options.proxyPath === undefined ? defaultProxyPath() : options.proxyPath;
  const credentials = new Map<string, OpdsCredential>();
  const credentialRefs = new Map<string, string>();

  function persistCredentials(): void {
    const payload: Record<string, OpdsCredential> = {};
    for (const [sourceId, ref] of credentialRefs) {
      const credential = credentials.get(ref);
      if (credential !== undefined) payload[sourceId] = credential;
    }
    options.storage.setItem(OPDS_CREDENTIALS_STORAGE_KEY, JSON.stringify(payload));
  }

  function hydrateCredentials(): void {
    const raw = options.storage.getItem(OPDS_CREDENTIALS_STORAGE_KEY);
    if (raw === null || raw.trim() === '') return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      for (const [sourceId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (sourceId.trim() === '' || !isStoredCredential(value)) continue;
        const ref = `opds-source-${sourceId}`;
        credentialRefs.set(sourceId, ref);
        credentials.set(ref, value);
      }
    } catch {
      /* keep empty maps when the local blob is unreadable */
    }
  }

  hydrateCredentials();

  function readSources(): OpdsSource[] {
    const raw = options.storage.getItem(OPDS_SOURCES_STORAGE_KEY);
    if (raw === null || raw.trim() === '') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPortableSource).map((source) => ({
        ...source,
        credentialRef: credentialRefs.get(source.id),
      }));
    } catch {
      return [];
    }
  }

  function writeSources(sources: readonly OpdsSource[]): void {
    const portable: PortableOpdsSource[] = sources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      allowHttp: source.allowHttp,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    }));
    options.storage.setItem(OPDS_SOURCES_STORAGE_KEY, JSON.stringify(portable));
  }

  function requireSource(sourceId: string): OpdsSource {
    const source = readSources().find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      throw new Error('OPDS 源不存在');
    }
    return source;
  }

  const searchTemplates = new Map<string, string>();

  function rememberSearchTemplate(sourceId: string, feed: OpdsFeed): void {
    if (feed.searchTemplate !== undefined && feed.searchTemplate !== '') {
      searchTemplates.set(sourceId, feed.searchTemplate);
    }
  }

  async function fetchCatalog(
    source: OpdsSource,
    url: string,
    signal?: AbortSignal,
  ): Promise<OpdsFeed> {
    const target = validateRemoteCatalogUrl(url, source.allowHttp);
    const headers = new Headers({
      Accept:
        'application/atom+xml, application/opds+json;q=0.9, application/json;q=0.8, text/xml;q=0.7, */*;q=0.1',
    });
    const authorization = authorizationHeader(
      source.credentialRef === undefined ? undefined : credentials.get(source.credentialRef),
    );
    if (authorization !== undefined) headers.set('Authorization', authorization);
    let response: Response;
    try {
      response = await fetchImpl(catalogRequestUrl(target, proxyPath), { headers, signal });
    } catch (error) {
      if (signal?.aborted === true) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (proxyPath === null && isLikelyCorsFailure(error)) {
        throw new Error('浏览器无法跨域访问此书库源。请改用桌面应用，或确认该源允许跨域。');
      }
      throw new Error('无法连接此书库源。');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('此书库源需要身份验证。');
    }
    if (!response.ok) {
      throw new Error(`无法读取书库源（HTTP ${response.status}）。`);
    }
    const body = await response.text();
    if (body.trim() === '') {
      throw new Error('书库源返回了空目录。');
    }
    return parseOpdsCatalog(body, target, response.headers.get('content-type') ?? undefined);
  }

  return {
    async addSource(input: OpdsSourceInput): Promise<OpdsSource> {
      const title = input.title.trim();
      if (title === '') {
        throw new Error('OPDS 源标题不能为空');
      }
      if (input.clearCredential === true && input.credential !== undefined) {
        throw new Error('不能同时清除和设置 OPDS 凭据');
      }
      const url = validateRemoteCatalogUrl(input.url, input.allowHttp === true);
      const sources = readSources();
      const existing =
        input.id === undefined ? undefined : sources.find((source) => source.id === input.id);
      const id = input.id ?? (await stableSourceId(url));
      const credentialRef =
        input.clearCredential === true
          ? undefined
          : (input.credentialRef ??
            existing?.credentialRef ??
            (input.credential === undefined ? undefined : `opds-source-${id}`));
      if (input.clearCredential === true) {
        credentials.delete(`opds-source-${id}`);
        if (existing?.credentialRef !== undefined) credentials.delete(existing.credentialRef);
        credentialRefs.delete(id);
      } else if (credentialRef !== undefined) {
        credentialRefs.set(id, credentialRef);
        if (input.credential !== undefined) credentials.set(credentialRef, input.credential);
      }
      const timestamp = now();
      const saved: OpdsSource = {
        id,
        title,
        url,
        allowHttp: input.allowHttp === true,
        credentialRef,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      writeSources([...sources.filter((source) => source.id !== id), saved]);
      persistCredentials();
      return saved;
    },

    async listSources(): Promise<OpdsSource[]> {
      return readSources();
    },

    async removeSource(sourceId: string): Promise<void> {
      const sources = readSources();
      const existing = sources.find((source) => source.id === sourceId);
      if (existing?.credentialRef !== undefined) credentials.delete(existing.credentialRef);
      credentials.delete(`opds-source-${sourceId}`);
      credentialRefs.delete(sourceId);
      searchTemplates.delete(sourceId);
      writeSources(sources.filter((source) => source.id !== sourceId));
      persistCredentials();
    },

    async browse(sourceId: string, url?: string): Promise<OpdsFeed> {
      const source = requireSource(sourceId);
      const feed = await fetchCatalog(source, url ?? source.url);
      rememberSearchTemplate(sourceId, feed);
      return feed;
    },

    async fetchAcquisition(
      sourceId: string,
      href: string,
      init: {
        readonly signal?: AbortSignal;
        readonly filename?: string;
        readonly mimeType?: string;
        readonly onProgress?: (loaded: number, total?: number) => void;
        readonly expectedSize?: number;
      } = {},
    ): Promise<File> {
      const source = requireSource(sourceId);
      const authorization = authorizationHeader(
        source.credentialRef === undefined ? undefined : credentials.get(source.credentialRef),
      );
      return fetchProxiedRemoteFile(href, {
        allowHttp: source.allowHttp,
        authorization,
        filename: init.filename ?? fileNameFromTitle(source.title, 'bin'),
        mimeType: init.mimeType,
        signal: init.signal,
        fetch: fetchImpl,
        proxyPath,
        onProgress: init.onProgress,
        expectedSize: init.expectedSize,
      });
    },

    async search(
      sourceId: string,
      query: string,
      init: { readonly signal?: AbortSignal } = {},
    ): Promise<OpdsFeed> {
      if (query.trim() === '') {
        throw new Error('搜索词不能为空');
      }
      const source = requireSource(sourceId);
      let template = searchTemplates.get(sourceId);
      if (template === undefined) {
        const root = await fetchCatalog(source, source.url, init.signal);
        rememberSearchTemplate(sourceId, root);
        template = root.searchTemplate;
      }
      if (template === undefined) {
        throw new Error('该 OPDS 源未提供搜索模板');
      }
      const encoded = encodeURIComponent(query.trim());
      const feed = await fetchCatalog(
        source,
        template.replace('{searchTerms}', encoded),
        init.signal,
      );
      rememberSearchTemplate(sourceId, feed);
      return feed;
    },
  };
}
