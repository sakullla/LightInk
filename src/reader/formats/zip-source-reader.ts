import type { RandomAccessSource } from '../sources/types.js';

/**
 * EPUB chapters are normally adjacent ZIP entries. A one-megabyte sliding
 * window turns hundreds of tiny backend/HTTP reads into a handful of bounded
 * sequential reads while keeping the complete archive out of WebView memory.
 * Remote OPDS sources keep a Readium-sized window: the ZIP central directory
 * lives in the last ~64KB, and first-paint only needs container/OPF/chapter 1.
 *
 * Comic first-paint calls zip.js `getData` on several pages at once. A single
 * window would evict the page still being inflated. Keep a few independent
 * windows so parallel readers stay on their own range.
 */
export const ZIP_LOCAL_READ_AHEAD_BYTES = 1 * 1024 * 1024;
export const ZIP_REMOTE_READ_AHEAD_BYTES = 256 * 1024;
export const ZIP_REMOTE_TAIL_AHEAD_BYTES = 512 * 1024;
export const ZIP_LOCAL_WINDOW_COUNT = 4;
export const ZIP_REMOTE_WINDOW_COUNT = 2;

export function zipReadAheadBytes(
  source: Pick<RandomAccessSource, 'size' | 'access'>,
  index: number,
  length: number,
): number {
  const available = Math.max(0, source.size - index);
  if (source.access !== 'remote') {
    return Math.min(available, Math.max(length, ZIP_LOCAL_READ_AHEAD_BYTES));
  }
  const tailStart = Math.max(0, source.size - ZIP_REMOTE_TAIL_AHEAD_BYTES);
  if (index >= tailStart) {
    return available;
  }
  return Math.min(available, Math.max(length, ZIP_REMOTE_READ_AHEAD_BYTES));
}

export function zipSourceWindowCount(source: Pick<RandomAccessSource, 'access'>): number {
  return source.access === 'remote' ? ZIP_REMOTE_WINDOW_COUNT : ZIP_LOCAL_WINDOW_COUNT;
}

interface CachedWindow {
  offset: number;
  bytes: Uint8Array;
  lastUsed: number;
}

interface InflightRead {
  offset: number;
  size: number;
  promise: Promise<Uint8Array>;
}

export interface ZipRangeCacheOptions {
  readonly size: number;
  readonly maxWindows: number;
  readonly readAhead: (index: number, length: number) => number;
  readonly readRange: (
    index: number,
    length: number,
    signal?: AbortSignal,
  ) => Promise<Uint8Array>;
}

/**
 * Concurrent-safe ZIP range cache for a zip.js `Reader`.
 *
 * Each `read` returns an owned copy. Cache hits snapshot the window before
 * slicing so a later fill cannot rewrite bytes already handed to zip.js.
 * Identical or contained in-flight fills share one `readRange`.
 */
export class ZipRangeCache {
  private readonly windows: CachedWindow[] = [];
  private readonly inflight: InflightRead[] = [];
  private clock = 0;

  constructor(private readonly options: ZipRangeCacheOptions) {}

  async read(index: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    const need = this.neededBytes(index, length);
    if (need === 0) return new Uint8Array();

    const hit = this.hit(index, need);
    if (hit !== undefined) return hit;

    const covering = this.findCoveringInflight(index, need);
    if (covering !== undefined) {
      const bytes = await covering.promise;
      const start = index - covering.offset;
      const cached = this.hit(index, need);
      if (cached !== undefined) return cached;
      if (bytes.byteLength < start + need) {
        throw new Error('ZIP source returned an incomplete range');
      }
      return bytes.slice(start, start + need);
    }

    const requested = this.options.readAhead(index, need);
    const pending: InflightRead = {
      offset: index,
      size: requested,
      promise: Promise.resolve(new Uint8Array()),
    };
    pending.promise = this.options
      .readRange(index, requested, signal)
      .then((bytes) => {
        if (bytes.byteLength < need) {
          throw new Error('ZIP source returned an incomplete range');
        }
        const owned = bytes.slice();
        this.install(index, owned);
        return owned;
      })
      .finally(() => {
        const position = this.inflight.indexOf(pending);
        if (position >= 0) this.inflight.splice(position, 1);
      });
    this.inflight.push(pending);
    const owned = await pending.promise;
    return owned.slice(0, need);
  }

  private neededBytes(index: number, length: number): number {
    if (length <= 0 || index >= this.options.size) return 0;
    return Math.min(length, this.options.size - index);
  }

  private hit(index: number, length: number): Uint8Array | undefined {
    for (const window of this.windows) {
      const end = window.offset + window.bytes.byteLength;
      if (index >= window.offset && index + length <= end) {
        window.lastUsed = ++this.clock;
        const start = index - window.offset;
        return window.bytes.slice(start, start + length);
      }
    }
    return undefined;
  }

  private findCoveringInflight(index: number, length: number): InflightRead | undefined {
    for (const pending of this.inflight) {
      if (index >= pending.offset && index + length <= pending.offset + pending.size) {
        return pending;
      }
    }
    return undefined;
  }

  private install(offset: number, bytes: Uint8Array): void {
    const end = offset + bytes.byteLength;
    for (const window of this.windows) {
      if (window.offset <= offset && window.offset + window.bytes.byteLength >= end) {
        window.lastUsed = ++this.clock;
        return;
      }
    }
    for (let index = this.windows.length - 1; index >= 0; index -= 1) {
      const window = this.windows[index]!;
      if (offset <= window.offset && end >= window.offset + window.bytes.byteLength) {
        this.windows.splice(index, 1);
      }
    }
    const next: CachedWindow = { offset, bytes, lastUsed: ++this.clock };
    if (this.windows.length < this.options.maxWindows) {
      this.windows.push(next);
      return;
    }
    let lru = 0;
    for (let index = 1; index < this.windows.length; index += 1) {
      if (this.windows[index]!.lastUsed < this.windows[lru]!.lastUsed) lru = index;
    }
    this.windows[lru] = next;
  }
}

export function createZipRangeCache(source: RandomAccessSource): ZipRangeCache {
  return new ZipRangeCache({
    size: source.size,
    maxWindows: zipSourceWindowCount(source),
    readAhead: (index, length) => zipReadAheadBytes(source, index, length),
    readRange: (index, length, signal) => source.readRange(index, length, signal),
  });
}
