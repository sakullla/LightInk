import type { ArchiveEntryMetadata } from './sources/types.js';

export const COMIC_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export interface ComicInfoPage {
  readonly image: number;
  readonly type?: string;
}

export interface ComicMetadata {
  readonly title?: string;
  readonly series?: string;
  readonly number?: string;
  readonly volume?: string;
  readonly pageCount?: number;
  readonly coverPage?: number;
  readonly readingDirection?: 'ltr' | 'rtl';
  readonly pages: readonly ComicInfoPage[];
}

export interface ComicPageCandidate extends ArchiveEntryMetadata {
  readonly id: string;
  readonly filename: string;
}

const naturalCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
  usage: 'sort',
});

function normalizedSegments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

/** Compare each path segment naturally so directory names do not bleed into filenames. */
export function compareComicPaths(left: string, right: string): number {
  const leftSegments = normalizedSegments(left);
  const rightSegments = normalizedSegments(right);
  const count = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftSegments[index];
    const b = rightSegments[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const compared = naturalCollator.compare(a, b);
    if (compared !== 0) return compared;
    const stable = a < b ? -1 : a > b ? 1 : 0;
    if (stable !== 0) return stable;
  }
  return left.localeCompare(right);
}

function extensionOf(path: string): string {
  const segments = normalizedSegments(path);
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function comicImageMimeType(path: string): string | undefined {
  return COMIC_IMAGE_MIME_TYPES[extensionOf(path)];
}

/** Prefer magic bytes so garbled ZIP names still decode as the real image. */
export function sniffComicImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  return undefined;
}

function comicImageBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Object URL from the viewed bytes only — never the backing ArrayBuffer. */
export function comicImageObjectUrl(bytes: Uint8Array, filename: string): string {
  return URL.createObjectURL(comicImageBlob(bytes, filename));
}

export function comicImageBlob(bytes: Uint8Array, filename: string): Blob {
  const mime = sniffComicImageMime(bytes) ?? comicImageMimeType(filename);
  if (mime === undefined) {
    throw new Error('COMIC_IMAGE_TYPE_UNSUPPORTED');
  }
  return new Blob([comicImageBytes(bytes)], { type: mime });
}

export function comicDisplayWidthPx(slot: HTMLElement | undefined, fallback = 800): number {
  const css = slot?.clientWidth || slot?.parentElement?.clientWidth || fallback;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(4096, Math.max(1, Math.round(css * dpr)));
}

export interface ComicPageElement {
  readonly element: HTMLElement;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

function comicAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

/** Apply resizeWidth as a CSS display cap; do not resample the decoded bitmap. */
function applyComicDisplayConstraint(
  image: HTMLImageElement,
  resizeWidth: number | undefined,
): void {
  if (resizeWidth === undefined || !Number.isFinite(resizeWidth) || resizeWidth < 1) {
    return;
  }
  const displayWidth = Math.min(4096, Math.max(1, Math.round(resizeWidth)));
  image.sizes = `${displayWidth}px`;
}

function decodeComicImage(image: HTMLImageElement, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(comicAbortError());
  }
  if (typeof image.decode !== 'function') {
    // jsdom has no decode() and never fires load for blob URLs. Real browsers expose decode().
    return Promise.resolve();
  }
  const decoded = image.decode();
  if (signal === undefined) {
    return decoded;
  }
  return Promise.race([
    decoded,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(comicAbortError()), { once: true });
    }),
  ]);
}

/**
 * Paint with an async &lt;img&gt;. createImageBitmap + canvas draw of a 3–4MB
 * manga JPEG can occupy WebView2's renderer thread long enough that cancel
 * and CDP both die, even when Rust is idle.
 */
export async function createComicPageElement(
  bytes: Uint8Array,
  filename: string,
  options: { readonly resizeWidth?: number; readonly signal?: AbortSignal } = {},
): Promise<ComicPageElement> {
  if (options.signal?.aborted === true) {
    throw comicAbortError();
  }
  const blob = comicImageBlob(bytes, filename);
  const url = URL.createObjectURL(blob);
  const image = document.createElement('img');
  image.className = 'lightink-reader-page';
  image.alt = filename;
  image.draggable = false;
  image.decoding = 'async';
  image.loading = 'eager';
  image.src = url;
  try {
    await decodeComicImage(image, options.signal);
    if (options.signal?.aborted === true) {
      throw comicAbortError();
    }
    applyComicDisplayConstraint(image, options.resizeWidth);
    return {
      element: image,
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    image.removeAttribute('src');
    throw error;
  }
}

export function isIgnoredComicPath(path: string): boolean {
  const segments = normalizedSegments(path);
  if (segments.length === 0) return true;
  const lower = segments.map((segment) => segment.toLowerCase());
  if (
    lower.some(
      (segment) =>
        segment.startsWith('.') ||
        segment === '__macosx' ||
        segment === 'system volume information' ||
        segment === 'recycler',
    )
  ) {
    return true;
  }
  const base = lower[lower.length - 1]!;
  if (base === 'thumbs.db' || base === 'desktop.ini' || base === '.ds_store') return true;
  if (base.startsWith('._')) return true;
  return /^(?:thumb|thumbnail)(?:[-_. ]?\d+)?\.[^.]+$/i.test(base);
}

export function isComicImagePath(path: string): boolean {
  return !isIgnoredComicPath(path) && comicImageMimeType(path) !== undefined;
}

function text(root: Document, tag: string): string | undefined {
  const value = root.querySelector(tag)?.textContent?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse the safe text subset of ComicInfo.xml. No feed HTML is returned or rendered. */
export function parseComicInfo(xml: string): ComicMetadata | null {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE/i.test(xml)) return null;
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror') !== null || parsed.documentElement.localName !== 'ComicInfo') {
    return null;
  }
  const pages: ComicInfoPage[] = [];
  for (const page of parsed.querySelectorAll('Pages > Page')) {
    const image = Number.parseInt(page.getAttribute('Image') ?? '', 10);
    if (!Number.isSafeInteger(image) || image < 0) continue;
    const type = page.getAttribute('Type')?.trim();
    pages.push({ image, type: type === undefined || type === '' ? undefined : type });
  }
  const manga = text(parsed, 'Manga')?.toLowerCase();
  const readingDirection =
    manga === 'yesandrighttoleft' || manga === 'yes' ? 'rtl' : undefined;
  return {
    title: text(parsed, 'Title'),
    series: text(parsed, 'Series'),
    number: text(parsed, 'Number'),
    volume: text(parsed, 'Volume'),
    pageCount: positiveInteger(text(parsed, 'PageCount')),
    coverPage: pages.find((page) => page.type?.toLowerCase() === 'frontcover')?.image,
    readingDirection,
    pages,
  };
}

/** ComicInfo indices refer to archive image order; unspecified pages retain natural order. */
export function orderComicPages(
  archiveOrder: readonly ComicPageCandidate[],
  metadata: ComicMetadata | null,
): ComicPageCandidate[] {
  const natural = archiveOrder
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const compared = compareComicPaths(left.entry.filename, right.entry.filename);
      return compared === 0 ? left.index - right.index : compared;
    })
    .map(({ entry }) => entry);
  if (metadata === null || metadata.pages.length === 0) return natural;
  const ordered: ComicPageCandidate[] = [];
  const used = new Set<string>();
  for (const page of metadata.pages) {
    const entry = archiveOrder[page.image];
    if (entry === undefined || used.has(entry.id)) continue;
    used.add(entry.id);
    ordered.push(entry);
  }
  for (const entry of natural) {
    if (!used.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

/** Pick nearest pages while keeping the estimated decoded footprint bounded. */
export function selectComicCacheWindow(
  sizes: readonly number[],
  centers: readonly number[],
  budgetBytes: number,
): Set<number> {
  const validCenters = [...new Set(centers)]
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < sizes.length)
    .sort((a, b) => a - b);
  if (validCenters.length === 0) return new Set();
  const wanted = new Set<number>(validCenters);
  let used = validCenters.reduce((total, index) => total + Math.max(0, sizes[index] ?? 0), 0);
  const candidates = sizes
    .map((_size, index) => ({
      index,
      distance: Math.min(...validCenters.map((center) => Math.abs(index - center))),
    }))
    .filter(({ index }) => !wanted.has(index))
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  const budget = Math.max(1, budgetBytes);
  for (const candidate of candidates) {
    const size = Math.max(1, sizes[candidate.index] ?? 0);
    if (used + size > budget) continue;
    wanted.add(candidate.index);
    used += size;
  }
  return wanted;
}
