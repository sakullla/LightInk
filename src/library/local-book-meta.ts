/**
 * Shelf metadata for a local book. EPUB/CBZ covers stay in the package until
 * import; this module reads title / authors / cover from a ranged archive
 * source without copying the whole file into the WebView.
 *
 * Informative local EPUB filenames win over `dc:title`. Series stem and
 * volume stay on this object for later smart groups; they are not
 * `LibraryItem.series`.
 */

import { bytesToBase64 } from '../asset/asset-service.js';
import { extOfPath } from '../file/path-ext.js';
import { openSafeArchive, type ArchiveInput } from '../reader/formats/safe-archive.js';
import { SAFE_READER_IMAGE_MIME_TYPES } from '../reader/formats/resource-limits.js';
import { decodeReaderText } from '../reader/formats/text-encoding.js';
import { parseFilenameSeries } from './filename-series.js';

export const MAX_SHELF_COVER_BYTES = 1_500_000;

export interface LocalBookMeta {
  readonly title?: string;
  readonly authors: readonly string[];
  readonly coverUrl?: string;
  /** Filename series stem. Omit when the basename is uninformative. */
  readonly seriesStem?: string;
  /** First filename volume token. Omit when the basename is uninformative. */
  readonly seriesVolume?: string;
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3] ?? '') : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .trim();
}

function resolvePackagePath(basePath: string, href: string): string | null {
  const value = href.trim();
  if (value === '' || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return null;
  }
  const withoutHash = value.split('#')[0] ?? value;
  const encoded = withoutHash.split('?')[0] ?? withoutHash;
  let referencePath: string;
  try {
    referencePath = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  const joined = referencePath.startsWith('/') ? referencePath.slice(1) : dir + referencePath;
  for (const segment of joined.split('/')) {
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (segment !== '.' && segment !== '') {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

function mimeFromPath(path: string): string | undefined {
  const ext = extOfPath(path);
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return undefined;
}

const MAX_SHELF_COVER_EDGE = 512;

async function toCoverDataUrl(bytes: Uint8Array, mime: string): Promise<string | undefined> {
  if (bytes.byteLength === 0 || !SAFE_READER_IMAGE_MIME_TYPES.has(mime)) {
    return undefined;
  }
  if (bytes.byteLength <= MAX_SHELF_COVER_BYTES) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }
  if (typeof createImageBitmap !== 'function') {
    return undefined;
  }
  try {
    const blob = new Blob([bytes.slice()], { type: mime });
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SHELF_COVER_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) {
      bitmap.close();
      return undefined;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return undefined;
  }
}

function collectText(xml: string, tag: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const text = decodeXml(match[1] ?? '');
    if (text !== '') values.push(text);
  }
  return values;
}

interface ManifestItem {
  readonly id: string;
  readonly href: string;
  readonly mediaType: string;
  readonly properties: string;
}

function parseManifest(opf: string): ManifestItem[] {
  const items: ManifestItem[] = [];
  const itemRe = /<item\b[^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(opf)) !== null) {
    const tag = match[0];
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    if (id === null || href === null) continue;
    items.push({
      id,
      href,
      mediaType: attr(tag, 'media-type') ?? '',
      properties: attr(tag, 'properties') ?? '',
    });
  }
  return items;
}

function coverItem(opf: string, items: readonly ManifestItem[]): ManifestItem | undefined {
  const propertyHit = items.find(
    (item) =>
      /\bcover-image\b/i.test(item.properties) && SAFE_READER_IMAGE_MIME_TYPES.has(item.mediaType),
  );
  if (propertyHit !== undefined) return propertyHit;
  const meta = opf.match(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i)?.[0];
  const coverId = meta === undefined ? null : attr(meta, 'content');
  if (coverId !== null) {
    const byId = items.find((item) => item.id === coverId);
    if (byId !== undefined && SAFE_READER_IMAGE_MIME_TYPES.has(byId.mediaType)) {
      return byId;
    }
  }
  return items.find(
    (item) =>
      SAFE_READER_IMAGE_MIME_TYPES.has(item.mediaType) &&
      (/cover/i.test(item.id) || /cover\.(jpe?g|png|gif|webp)$/i.test(item.href)),
  );
}

async function extractEpubMeta(source: ArchiveInput): Promise<LocalBookMeta> {
  const archive = await openSafeArchive(source, 'EPUB');
  try {
    let opfPath: string | null = null;
    const container = archive.file('META-INF/container.xml');
    if (container !== null) {
      const xml = decodeReaderText(await container.readBytes());
      opfPath = attr(
        xml.match(/<rootfile\b[^>]*?\/?>/i)?.[0] ?? '',
        'full-path',
      );
    }
    if (opfPath === null) {
      opfPath = archive.entries.map((entry) => entry.filename).find((name) => /\.opf$/i.test(name)) ?? null;
    }
    if (opfPath === null) {
      return { authors: [] };
    }
    const opfFile = archive.file(opfPath);
    if (opfFile === null) {
      return { authors: [] };
    }
    const opf = decodeReaderText(await opfFile.readBytes());
    const items = parseManifest(opf);
    const chosen = coverItem(opf, items);
    let coverUrl: string | undefined;
    if (chosen !== undefined) {
      const path = resolvePackagePath(opfPath, chosen.href);
      const file = path === null ? null : archive.file(path);
      if (file !== null) {
        coverUrl = await toCoverDataUrl(await file.readBytes(), chosen.mediaType);
      }
    }
    if (coverUrl === undefined) {
      const fallback = archive.entries
        .map((entry) => entry.filename)
        .find((name) => /(?:^|\/)cover\.(jpe?g|png|gif|webp)$/i.test(name));
      if (fallback !== undefined) {
        const file = archive.file(fallback);
        const mime = mimeFromPath(fallback);
        if (file !== null && mime !== undefined) {
          coverUrl = await toCoverDataUrl(await file.readBytes(), mime);
        }
      }
    }
    return {
      title: collectText(opf, 'dc:title')[0],
      authors: collectText(opf, 'dc:creator'),
      coverUrl,
    };
  } finally {
    await archive.close().catch(() => undefined);
  }
}

async function extractCbzCover(source: ArchiveInput): Promise<LocalBookMeta> {
  const archive = await openSafeArchive(source, 'CBZ');
  try {
    const image = [...archive.entries]
      .map((entry) => entry.filename)
      .filter((name) => /\.(jpe?g|png|gif|webp)$/i.test(name))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))[0];
    if (image === undefined) {
      return { authors: [] };
    }
    const file = archive.file(image);
    const mime = mimeFromPath(image);
    if (file === null || mime === undefined) {
      return { authors: [] };
    }
    return { authors: [], coverUrl: await toCoverDataUrl(await file.readBytes(), mime) };
  } finally {
    await archive.close().catch(() => undefined);
  }
}

export function isShelfCoverUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  if (value.startsWith('data:image/')) {
    const mime = value.slice('data:'.length, value.indexOf(';'));
    return SAFE_READER_IMAGE_MIME_TYPES.has(mime);
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'blob:';
  } catch {
    return false;
  }
}

function applyFilenameSeries(path: string, pack: LocalBookMeta): LocalBookMeta {
  const parsed = parseFilenameSeries(path);
  if (!parsed.informative) {
    return {
      title: pack.title,
      authors: pack.authors,
      coverUrl: pack.coverUrl,
    };
  }
  return {
    title: parsed.title !== '' ? parsed.title : pack.title,
    authors: pack.authors,
    coverUrl: pack.coverUrl,
    ...(parsed.seriesStem !== undefined ? { seriesStem: parsed.seriesStem } : {}),
    ...(parsed.volume !== undefined ? { seriesVolume: parsed.volume } : {}),
  };
}

export async function extractLocalBookMeta(
  path: string,
  source: ArchiveInput,
): Promise<LocalBookMeta> {
  const extension = extOfPath(path);
  if (extension === 'epub') {
    return applyFilenameSeries(path, await extractEpubMeta(source));
  }
  if (extension === 'cbz') {
    return extractCbzCover(source);
  }
  return { authors: [] };
}
