import { invoke } from '@tauri-apps/api/core';

/** OPDS 1.x link returned by the native parser. */
export interface OpdsLink {
  readonly href: string;
  readonly rel: string;
  readonly mediaType?: string;
  readonly title?: string;
  readonly size?: number;
  readonly extension?: string;
  readonly acquisition: boolean;
}

export interface OpdsEntry {
  readonly id: string;
  readonly itemId?: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly updated?: string;
  readonly summary?: string;
  readonly coverUrl?: string;
  readonly links: readonly OpdsLink[];
}

export interface OpdsFeed {
  readonly id?: string;
  readonly title: string;
  readonly updated?: string;
  readonly entries: readonly OpdsEntry[];
  readonly links: readonly OpdsLink[];
  readonly nextUrl?: string;
  readonly previousUrl?: string;
  readonly searchTemplate?: string;
  readonly sourceUrl: string;
}

export interface OpdsSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly credentialRef?: string;
  readonly allowHttp: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OpdsCredential {
  readonly kind: 'basic' | 'bearer';
  readonly username?: string;
  readonly password?: string;
  readonly token?: string;
}

export interface OpdsSourceInput {
  readonly id?: string;
  readonly title: string;
  readonly url: string;
  readonly allowHttp?: boolean;
  readonly credentialRef?: string;
  readonly credential?: OpdsCredential;
  readonly clearCredential?: boolean;
}

export interface OpdsClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const SUPPORTED_EXTENSIONS = new Set([
  'epub',
  'pdf',
  'cbz',
  'cbr',
  'rar',
  'cb7',
  '7z',
  'mobi',
  'fb2',
  'txt',
]);

const ACQUISITION_RELS = new Set([
  'acquisition',
  'download',
  'borrow',
  'buy',
  'http://opds-spec.org/acquisition',
]);

const OPDS_JSON_MEDIA_TYPES = new Set([
  'application/opds+json',
  'application/opds-publication+json',
]);

const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/jxl',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaTypeBase(mediaType: string | undefined): string {
  return (mediaType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function isAtomMediaType(mediaType: string | undefined): boolean {
  const type = mediaTypeBase(mediaType);
  return type === 'application/atom+xml' || type === 'text/xml' || type === 'application/xml';
}

function isOpdsJsonMediaType(mediaType: string | undefined): boolean {
  return OPDS_JSON_MEDIA_TYPES.has(mediaTypeBase(mediaType));
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function contributorNames(value: unknown): string[] {
  if (typeof value === 'string') {
    const name = asTrimmedString(value);
    return name === undefined ? [] : [name];
  }
  if (Array.isArray(value)) return value.flatMap(contributorNames);
  if (isRecord(value)) return contributorNames(value.name);
  return [];
}

function relTokens(rel: unknown): string[] {
  if (typeof rel === 'string') return rel.split(/\s+/).filter((token) => token !== '');
  if (Array.isArray(rel)) {
    return rel.flatMap((item) => (typeof item === 'string' ? item.split(/\s+/) : []));
  }
  return [];
}

function relValue(rel: unknown): string {
  const tokens = relTokens(rel);
  return tokens.length === 0 ? 'alternate' : tokens.join(' ');
}

function extensionFromHref(href: string): string | undefined {
  let path = href;
  try {
    path = new URL(href).pathname;
  } catch {
    path = href.split('?')[0] ?? href;
  }
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return extension === '' ? undefined : extension;
}

function extensionFromMediaType(mediaType: string | undefined, href: string): string | undefined {
  switch (mediaTypeBase(mediaType)) {
    case 'application/epub+zip':
      return 'epub';
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.comicbook+zip':
    case 'application/x-cbz':
      return 'cbz';
    case 'application/vnd.rar':
    case 'application/x-rar-compressed':
      return extensionFromHref(href) === 'cbr' ? 'cbr' : 'rar';
    case 'application/x-7z-compressed':
      return extensionFromHref(href) === 'cb7' ? 'cb7' : '7z';
    case 'application/x-mobipocket-ebook':
      return 'mobi';
    case 'application/x-fictionbook+xml':
      return 'fb2';
    case 'text/plain':
      return 'txt';
    default:
      return extensionFromHref(href);
  }
}

function restoreTemplateBraces(href: string): string {
  return href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

function resolveLinkUrl(baseUrl: string, href: string): string {
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    throw new Error('OPDS_LINK_INVALID: OPDS link URL 无效');
  }
  if (
    (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
    resolved.hostname === '' ||
    resolved.username !== '' ||
    resolved.password !== ''
  ) {
    throw new Error(
      'OPDS_LINK_INVALID: OPDS link 必须是不含内嵌凭据且不从 HTTPS 降级的 HTTP(S) URL',
    );
  }
  const base = new URL(baseUrl);
  if (base.protocol === 'https:' && resolved.protocol === 'http:') {
    throw new Error(
      'OPDS_LINK_INVALID: OPDS link 必须是不含内嵌凭据且不从 HTTPS 降级的 HTTP(S) URL',
    );
  }
  return restoreTemplateBraces(resolved.toString());
}

function resolveHref(baseUrl: string, href: string): string {
  const templateIndex = href.indexOf('{');
  if (templateIndex === -1) return resolveLinkUrl(baseUrl, href);
  const prefix = href.slice(0, templateIndex);
  const template = href.slice(templateIndex);
  if (prefix === '') return resolveLinkUrl(baseUrl, '.') + template;
  return resolveLinkUrl(baseUrl, prefix) + template;
}

function searchTemplateFromHref(href: string): string | undefined {
  const template = href
    .replace(/\{\?query(?:,[^}]*)?\}/g, '?query={searchTerms}')
    .replace(/\{&query(?:,[^}]*)?\}/g, '&query={searchTerms}')
    .replace(/\{query\}/g, '{searchTerms}');
  return template.includes('{searchTerms}') ? template : undefined;
}

function isAcquisitionRel(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      ACQUISITION_RELS.has(token) ||
      token.includes('opds-spec.org/acquisition') ||
      token === 'http://opds-spec.org/acquisition/open-access',
  );
}

function isCoverRel(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) => token.endsWith('/image') || token.endsWith('/image/thumbnail') || token === 'cover',
  );
}

function linkSize(link: Record<string, unknown>): number | undefined {
  if (typeof link.length === 'number' && Number.isFinite(link.length)) return link.length;
  if (isRecord(link.properties) && typeof link.properties.numberOfBytes === 'number') {
    return link.properties.numberOfBytes;
  }
  return undefined;
}

function mapLink(link: unknown, baseUrl: string): OpdsLink {
  if (!isRecord(link)) {
    throw new Error('OPDS_LINK_INVALID: OPDS link 缺少 href');
  }
  const href = asTrimmedString(link.href);
  if (href === undefined) {
    throw new Error('OPDS_LINK_INVALID: OPDS link 缺少 href');
  }
  const resolved = resolveHref(baseUrl, href);
  const mediaType = asTrimmedString(link.type);
  const extension = extensionFromMediaType(mediaType, resolved);
  const rel = relValue(link.rel);
  const tokens = relTokens(rel);
  return {
    href: resolved,
    rel,
    mediaType,
    title: asTrimmedString(link.title),
    size: linkSize(link),
    extension,
    acquisition: isAcquisitionRel(tokens) && SUPPORTED_EXTENSIONS.has(extension ?? ''),
  };
}

function mapLinks(value: unknown, baseUrl: string): OpdsLink[] {
  if (!Array.isArray(value)) return [];
  return value.map((link) => mapLink(link, baseUrl));
}

function coverFromImages(images: unknown, baseUrl: string): string | undefined {
  if (!Array.isArray(images)) return undefined;
  for (const image of images) {
    if (!isRecord(image)) continue;
    const href = asTrimmedString(image.href);
    if (href === undefined) continue;
    const type = asTrimmedString(image.type);
    if (type !== undefined && !IMAGE_MEDIA_TYPES.has(mediaTypeBase(type))) continue;
    return resolveHref(baseUrl, href);
  }
  return undefined;
}

function coverFromLinks(links: readonly OpdsLink[]): string | undefined {
  return links.find((link) => isCoverRel(relTokens(link.rel)))?.href;
}

function catalogBaseUrl(catalog: Record<string, unknown>, sourceUrl: string): string {
  if (sourceUrl.trim() !== '') return sourceUrl;
  if (Array.isArray(catalog.links)) {
    for (const link of catalog.links) {
      if (!isRecord(link)) continue;
      const href = asTrimmedString(link.href);
      if (href !== undefined && /^https?:\/\//i.test(href) && relTokens(link.rel).includes('self')) {
        return href;
      }
    }
  }
  throw new Error('OPDS_FEED_INVALID: OPDS Feed 缺少来源 URL');
}

function isMappedOpdsFeed(value: unknown): value is OpdsFeed {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    Array.isArray(value.entries) &&
    Array.isArray(value.links) &&
    typeof value.sourceUrl === 'string' &&
    !isRecord(value.metadata)
  );
}

function isOpdsJsonObject(
  value: unknown,
): value is Record<string, unknown> & { metadata: Record<string, unknown> } {
  if (!isRecord(value) || isMappedOpdsFeed(value)) return false;
  if (!isRecord(value.metadata) || typeof value.metadata.title !== 'string') return false;
  return (
    Array.isArray(value.publications) ||
    Array.isArray(value.navigation) ||
    Array.isArray(value.groups) ||
    Array.isArray(value.links)
  );
}

function parseJsonCatalog(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('OPDS_JSON_INVALID: OPDS 2.0 JSON 无法解析');
  }
}

function mapPublication(publication: unknown, baseUrl: string): OpdsEntry {
  if (!isRecord(publication) || !isRecord(publication.metadata)) {
    throw new Error('OPDS_ENTRY_INVALID: OPDS 条目缺少 id 或 title');
  }
  const title = asTrimmedString(publication.metadata.title);
  if (title === undefined) {
    throw new Error('OPDS_ENTRY_INVALID: OPDS 条目缺少 id 或 title');
  }
  const links = mapLinks(publication.links, baseUrl);
  const selfHref = links.find((link) => relTokens(link.rel).includes('self'))?.href;
  const id =
    asTrimmedString(publication.metadata.identifier) ??
    asTrimmedString(publication.metadata.id) ??
    selfHref ??
    title;
  return {
    id,
    title,
    authors: contributorNames(publication.metadata.author),
    updated:
      asTrimmedString(publication.metadata.modified) ?? asTrimmedString(publication.metadata.updated),
    summary:
      asTrimmedString(publication.metadata.description) ??
      asTrimmedString(publication.metadata.summary),
    coverUrl: coverFromImages(publication.images, baseUrl) ?? coverFromLinks(links),
    links,
  };
}

function mapNavigation(link: unknown, baseUrl: string): OpdsEntry | undefined {
  if (!isRecord(link)) return undefined;
  const mapped = mapLink(link, baseUrl);
  const title = mapped.title;
  if (title === undefined) return undefined;
  return {
    id: mapped.href,
    title,
    authors: [],
    links: [mapped],
  };
}

function collectEntries(catalog: Record<string, unknown>, baseUrl: string): OpdsEntry[] {
  const entries: OpdsEntry[] = [];
  const pushNavigation = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const link of value) {
      const entry = mapNavigation(link, baseUrl);
      if (entry !== undefined) entries.push(entry);
    }
  };
  const pushPublications = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const publication of value) {
      entries.push(mapPublication(publication, baseUrl));
    }
  };
  pushNavigation(catalog.navigation);
  pushPublications(catalog.publications);
  if (Array.isArray(catalog.groups)) {
    for (const group of catalog.groups) {
      if (!isRecord(group)) continue;
      pushNavigation(group.navigation);
      pushPublications(group.publications);
    }
  }
  if (
    entries.length === 0 &&
    Array.isArray(catalog.links) &&
    !Array.isArray(catalog.publications) &&
    !Array.isArray(catalog.navigation) &&
    !Array.isArray(catalog.groups)
  ) {
    entries.push(mapPublication(catalog, baseUrl));
  }
  return entries;
}

function paginationFromLinks(links: readonly OpdsLink[]): {
  nextUrl?: string;
  previousUrl?: string;
  searchTemplate?: string;
} {
  let nextUrl: string | undefined;
  let previousUrl: string | undefined;
  let searchTemplate: string | undefined;
  for (const link of links) {
    const tokens = relTokens(link.rel);
    if (tokens.includes('next')) nextUrl = link.href;
    if (tokens.includes('previous') || tokens.includes('prev')) previousUrl = link.href;
    if (tokens.includes('search')) {
      searchTemplate = searchTemplateFromHref(link.href);
    }
  }
  return { nextUrl, previousUrl, searchTemplate };
}

/** True when the response media type or body is an OPDS 2.0 JSON catalog. */
export function isOpdsJson(value: unknown, mediaType?: string): boolean {
  if (isAtomMediaType(mediaType)) return false;
  if (isOpdsJsonMediaType(mediaType)) return true;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('<') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return false;
    }
    try {
      return isOpdsJsonObject(JSON.parse(trimmed) as unknown);
    } catch {
      return false;
    }
  }
  if (isRecord(value) && typeof value.body === 'string' && !isOpdsJsonObject(value)) {
    const nestedType = typeof value.mediaType === 'string' ? value.mediaType : mediaType;
    return isOpdsJson(value.body, nestedType);
  }
  return isOpdsJsonObject(value);
}

/** Map an OPDS 2.0 JSON catalog or publication to the existing Atom-shaped OpdsFeed. */
export function mapOpdsJsonFeed(catalog: unknown, sourceUrl: string): OpdsFeed {
  const parsed = typeof catalog === 'string' ? parseJsonCatalog(catalog) : catalog;
  if (!isOpdsJsonObject(parsed)) {
    throw new Error('OPDS_JSON_INVALID: 不是有效的 OPDS 2.0 JSON 目录');
  }
  const title = asTrimmedString(parsed.metadata.title);
  if (title === undefined) {
    throw new Error('OPDS_FEED_INVALID: OPDS Feed 缺少标题');
  }
  const baseUrl = catalogBaseUrl(parsed, sourceUrl);
  const links = mapLinks(parsed.links, baseUrl);
  const pagination = paginationFromLinks(links);
  return {
    id: asTrimmedString(parsed.metadata.identifier) ?? asTrimmedString(parsed.metadata.id),
    title,
    updated: asTrimmedString(parsed.metadata.modified) ?? asTrimmedString(parsed.metadata.updated),
    entries: collectEntries(parsed, baseUrl),
    links,
    nextUrl: pagination.nextUrl,
    previousUrl: pagination.previousUrl,
    searchTemplate: pagination.searchTemplate,
    sourceUrl: baseUrl,
  };
}

function feedFromNative(raw: unknown, fallbackUrl?: string): OpdsFeed {
  if (isMappedOpdsFeed(raw)) return raw;
  if (isRecord(raw) && typeof raw.body === 'string' && !isOpdsJsonObject(raw)) {
    const mediaType = typeof raw.mediaType === 'string' ? raw.mediaType : undefined;
    const sourceUrl =
      (typeof raw.sourceUrl === 'string' && raw.sourceUrl) || fallbackUrl || '';
    if (isOpdsJson(raw.body, mediaType)) {
      return mapOpdsJsonFeed(raw.body, sourceUrl);
    }
  }
  if (isOpdsJson(raw)) {
    const sourceUrl =
      (isRecord(raw) && typeof raw.sourceUrl === 'string' && raw.sourceUrl) || fallbackUrl || '';
    return mapOpdsJsonFeed(raw, sourceUrl);
  }
  return raw as OpdsFeed;
}

/** Never forward a catalog credential to an acquisition on another origin. */
export function credentialRefForResource(
  source: OpdsSource | undefined,
  resourceUrl: string,
): string | undefined {
  if (source?.credentialRef === undefined) return undefined;
  try {
    const sourceUrl = new URL(source.url);
    const targetUrl = new URL(resourceUrl, sourceUrl);
    return sourceUrl.origin === targetUrl.origin ? source.credentialRef : undefined;
  } catch {
    return undefined;
  }
}

const nativeInvoker: OpdsClientInvoker = { invoke };

/** Small typed facade for OPDS commands; credentials are handed to Rust only. */
export class OpdsClient {
  private readonly invoker: OpdsClientInvoker;

  constructor(invoker: OpdsClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  addSource(input: OpdsSourceInput): Promise<OpdsSource> {
    return this.invoker.invoke<OpdsSource>('opds_add_source', { source: input });
  }

  listSources(): Promise<OpdsSource[]> {
    return this.invoker.invoke<OpdsSource[]>('opds_list_sources');
  }

  removeSource(sourceId: string): Promise<void> {
    return this.invoker.invoke<void>('opds_remove_source', { sourceId });
  }

  browse(sourceId: string, url?: string): Promise<OpdsFeed> {
    return this.invoker
      .invoke<unknown>('opds_browse', { sourceId, url })
      .then((raw) => feedFromNative(raw, url));
  }

  search(sourceId: string, query: string): Promise<OpdsFeed> {
    return this.invoker
      .invoke<unknown>('opds_search', { sourceId, query })
      .then((raw) => feedFromNative(raw));
  }
}

export const opdsClient = new OpdsClient();
