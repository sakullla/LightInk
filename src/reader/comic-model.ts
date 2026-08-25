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

const COMIC_DISPLAY_MAX_DEVICE_PX = 8192;

export function comicDevicePixelRatio(
  host: { readonly devicePixelRatio?: number } | null = typeof window !== 'undefined' ? window : null,
): number {
  const ratio = host?.devicePixelRatio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
    return 1;
  }
  return Math.min(4, Math.max(1, ratio));
}

/** Slot paint budget in device pixels. CSS layout still uses slot width / dpr. */
export function comicDisplayWidthPx(
  slot: HTMLElement | undefined,
  fallback = 800,
  host: { readonly devicePixelRatio?: number } | null = typeof window !== 'undefined' ? window : null,
): number {
  const css = slot?.clientWidth || slot?.parentElement?.clientWidth || fallback;
  const device = Math.round(Math.max(1, css) * comicDevicePixelRatio(host));
  return Math.min(COMIC_DISPLAY_MAX_DEVICE_PX, Math.max(1, device));
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

/** Apply resizeWidth (device px) as a CSS cap; do not resample the decoded bitmap. */
function applyComicDisplayConstraint(
  image: HTMLImageElement,
  resizeWidth: number | undefined,
): void {
  if (resizeWidth === undefined || !Number.isFinite(resizeWidth) || resizeWidth < 1) {
    return;
  }
  const deviceWidth = Math.min(COMIC_DISPLAY_MAX_DEVICE_PX, Math.max(1, Math.round(resizeWidth)));
  const cssWidth = Math.min(
    COMIC_DISPLAY_MAX_DEVICE_PX,
    Math.max(1, Math.round(deviceWidth / comicDevicePixelRatio())),
  );
  const css = `${cssWidth}px`;
  image.style.maxWidth = css;
  image.style.setProperty('--lightink-comic-display-width', css);
  image.sizes = css;
}

export interface ComicCropInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const COMIC_CROP_NONE: ComicCropInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

const COMIC_CROP_SAMPLE_MAX = 96;
const COMIC_CROP_LUMA_DELTA = 28;
const COMIC_CROP_EDGE_SPREAD = 36;
const COMIC_CROP_CONTENT_RATIO = 0.08;
const COMIC_CROP_PAD = 0.012;
const COMIC_CROP_MIN_EDGE = 0.02;
const COMIC_CROP_MAX_EDGE = 0.32;
const COMIC_CROP_MIN_AREA = 0.42;

export function isComicCropEmpty(insets: ComicCropInsets): boolean {
  return insets.top <= 0 && insets.right <= 0 && insets.bottom <= 0 && insets.left <= 0;
}

export function comicCroppedSize(
  width: number,
  height: number,
  insets: ComicCropInsets,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * (1 - insets.left - insets.right))),
    height: Math.max(1, Math.round(height * (1 - insets.top - insets.bottom))),
  };
}

function pixelLuma(data: Uint8ClampedArray, offset: number): number {
  return 0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!;
}

function lumaAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  return pixelLuma(data, (y * width + x) * 4);
}

function edgeStripStats(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  vertical: boolean,
  fromStart: boolean,
): { readonly uniform: boolean; readonly luma: number } {
  const other = vertical ? width : height;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let cursor = 0; cursor < other; cursor += 1) {
    const x = vertical ? cursor : fromStart ? 0 : width - 1;
    const y = vertical ? (fromStart ? 0 : height - 1) : cursor;
    const luma = lumaAt(data, width, x, y);
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    sum += luma;
  }
  return { uniform: max - min <= COMIC_CROP_EDGE_SPREAD, luma: sum / Math.max(1, other) };
}

/** Uniform-border crop from a downscaled RGBA buffer. Empty if the page is already tight. */
export function comicCropInsetsFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): ComicCropInsets {
  if (width < 8 || height < 8 || data.length < width * height * 4) return COMIC_CROP_NONE;
  const scan = (vertical: boolean, fromStart: boolean): number => {
    const edge = edgeStripStats(data, width, height, vertical, fromStart);
    const limit = vertical ? height : width;
    if (!edge.uniform) return fromStart ? 0 : limit - 1;
    const other = vertical ? width : height;
    const minHits = Math.max(2, Math.ceil(other * COMIC_CROP_CONTENT_RATIO));
    for (let step = 0; step < limit; step += 1) {
      const pos = fromStart ? step : limit - 1 - step;
      let hits = 0;
      for (let cursor = 0; cursor < other; cursor += 1) {
        const x = vertical ? cursor : pos;
        const y = vertical ? pos : cursor;
        if (Math.abs(lumaAt(data, width, x, y) - edge.luma) > COMIC_CROP_LUMA_DELTA) hits += 1;
      }
      if (hits >= minHits) return pos;
    }
    return fromStart ? 0 : limit - 1;
  };
  const topPx = scan(true, true);
  const bottomPx = scan(true, false);
  const leftPx = scan(false, true);
  const rightPx = scan(false, false);
  if (bottomPx <= topPx || rightPx <= leftPx) return COMIC_CROP_NONE;
  const raw: ComicCropInsets = {
    top: topPx / height,
    right: (width - 1 - rightPx) / width,
    bottom: (height - 1 - bottomPx) / height,
    left: leftPx / width,
  };
  const padded: ComicCropInsets = {
    top: Math.max(0, raw.top - COMIC_CROP_PAD),
    right: Math.max(0, raw.right - COMIC_CROP_PAD),
    bottom: Math.max(0, raw.bottom - COMIC_CROP_PAD),
    left: Math.max(0, raw.left - COMIC_CROP_PAD),
  };
  const keep = (1 - padded.left - padded.right) * (1 - padded.top - padded.bottom);
  if (
    keep < COMIC_CROP_MIN_AREA ||
    padded.top > COMIC_CROP_MAX_EDGE ||
    padded.right > COMIC_CROP_MAX_EDGE ||
    padded.bottom > COMIC_CROP_MAX_EDGE ||
    padded.left > COMIC_CROP_MAX_EDGE
  ) {
    return COMIC_CROP_NONE;
  }
  if (
    padded.top < COMIC_CROP_MIN_EDGE &&
    padded.right < COMIC_CROP_MIN_EDGE &&
    padded.bottom < COMIC_CROP_MIN_EDGE &&
    padded.left < COMIC_CROP_MIN_EDGE
  ) {
    return COMIC_CROP_NONE;
  }
  return padded;
}

let cropSampleCanvas: HTMLCanvasElement | null = null;

function cropSampleContext(
  sampleWidth: number,
  sampleHeight: number,
): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = cropSampleCanvas ?? document.createElement('canvas');
  cropSampleCanvas = canvas;
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  return canvas.getContext('2d', { willReadFrequently: true });
}

export function detectComicCropInsets(
  source: CanvasImageSource & {
    readonly naturalWidth?: number;
    readonly naturalHeight?: number;
    readonly width?: number;
    readonly height?: number;
  },
): ComicCropInsets {
  const width = source.naturalWidth || source.width || 0;
  const height = source.naturalHeight || source.height || 0;
  if (width < 8 || height < 8 || typeof document === 'undefined') return COMIC_CROP_NONE;
  const scale = Math.min(1, COMIC_CROP_SAMPLE_MAX / Math.max(width, height));
  const sampleWidth = Math.max(8, Math.round(width * scale));
  const sampleHeight = Math.max(8, Math.round(height * scale));
  const context = cropSampleContext(sampleWidth, sampleHeight);
  if (context === null) return COMIC_CROP_NONE;
  try {
    context.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight);
    return comicCropInsetsFromRgba(pixels.data, sampleWidth, sampleHeight);
  } catch {
    return COMIC_CROP_NONE;
  }
}

export interface ComicCropDisplayOptions {
  /** When crop is off, keep a natural box for strip / fit-width. Screen-fit uses none. */
  readonly fallbackAspect?: 'natural' | 'none';
}

/** Clip the bitmap in CSS so the cropped region fills the slot. No pixel resample. */
export function applyComicCropDisplay(
  slot: HTMLElement,
  image: HTMLElement | null,
  naturalWidth: number,
  naturalHeight: number,
  insets: ComicCropInsets | null | undefined,
  options: ComicCropDisplayOptions = {},
): void {
  if (insets === null || insets === undefined || isComicCropEmpty(insets)) {
    slot.removeAttribute('data-comic-cropped');
    slot.style.removeProperty('overflow');
    slot.style.removeProperty('--lightink-comic-crop-w');
    slot.style.removeProperty('--lightink-comic-crop-h');
    if (options.fallbackAspect === 'natural' && naturalWidth > 0 && naturalHeight > 0) {
      slot.style.aspectRatio = `${naturalWidth} / ${naturalHeight}`;
    } else {
      slot.style.removeProperty('aspect-ratio');
    }
    if (image !== null) {
      image.style.removeProperty('margin-left');
      image.style.removeProperty('margin-top');
    }
    return;
  }
  const cropped = comicCroppedSize(naturalWidth, naturalHeight, insets);
  const keepWidth = Math.max(0.05, 1 - insets.left - insets.right);
  const keepHeight = Math.max(0.05, 1 - insets.top - insets.bottom);
  slot.dataset.comicCropped = 'true';
  slot.style.overflow = 'hidden';
  slot.style.width = 'auto';
  slot.style.height = 'auto';
  slot.style.maxWidth = '100%';
  slot.style.maxHeight = '100%';
  slot.style.aspectRatio = `${cropped.width} / ${cropped.height}`;
  slot.style.setProperty('--lightink-comic-crop-w', String(keepWidth));
  slot.style.setProperty('--lightink-comic-crop-h', String(keepHeight));
  if (image === null) return;
  image.style.objectFit = 'fill';
  image.style.width = `${100 / keepWidth}%`;
  image.style.height = `${100 / keepHeight}%`;
  image.style.maxWidth = 'none';
  image.style.maxHeight = 'none';
  image.style.marginLeft = `${(-100 * insets.left) / keepWidth}%`;
  image.style.marginTop = `${(-100 * insets.top) / keepHeight}%`;
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
