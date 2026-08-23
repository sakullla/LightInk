/**
 * Shared ZIP boundary for reader formats.
 *
 * Central-directory metadata is validated before any entry is decompressed so a
 * small EPUB/CBZ cannot expand without a predictable memory budget.
 */

import type { FileEntry } from '@zip.js/zip.js';

import { ParseError, ReaderLimitError } from './types.js';
import type {
  ArchiveEntryMetadata as CommonArchiveEntryMetadata,
  ArchiveProvider,
  RandomAccessSource,
} from '../sources/types.js';
import { readerIdentityKey } from '../sources/types.js';
import { createMemorySource } from '../sources/memory-source.js';
import type {
  ArchivePasswordProvider,
  NativeArchiveInvoker,
} from '../sources/native-archive.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const READER_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = {
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export interface ArchiveEntryMetadata extends CommonArchiveEntryMetadata {
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

function compressionRatio(entry: ArchiveEntryMetadata): number {
  if (entry.uncompressedSize === 0) {
    return 0;
  }
  if (entry.compressedSize === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(entry.uncompressedSize / entry.compressedSize);
}

class ArchiveBudgetTracker {
  private entryCount = 0;
  private totalUncompressedBytes = 0;

  constructor(private readonly limits: Readonly<ArchiveLimits>) {}

  add(entry: ArchiveEntryMetadata): void {
    this.entryCount += 1;
    if (this.entryCount > this.limits.maxEntries) {
      throw new ReaderLimitError('archiveEntries', this.entryCount, this.limits.maxEntries);
    }
    if (entry.directory) {
      return;
    }
    if (entry.uncompressedSize > this.limits.maxEntryUncompressedBytes) {
      throw new ReaderLimitError(
        'archiveEntryBytes',
        entry.uncompressedSize,
        this.limits.maxEntryUncompressedBytes,
      );
    }
    const ratio = compressionRatio(entry);
    if (ratio > this.limits.maxCompressionRatio) {
      throw new ReaderLimitError(
        'archiveCompressionRatio',
        Number.isFinite(ratio) ? ratio : this.limits.maxCompressionRatio + 1,
        this.limits.maxCompressionRatio,
      );
    }
    this.totalUncompressedBytes += entry.uncompressedSize;
    if (this.totalUncompressedBytes > this.limits.maxTotalUncompressedBytes) {
      throw new ReaderLimitError(
        'archiveTotalBytes',
        this.totalUncompressedBytes,
        this.limits.maxTotalUncompressedBytes,
      );
    }
  }
}

/** Validate synthetic metadata independently of ZIP parsing for boundary tests. */
export function validateArchiveMetadata(
  entries: readonly ArchiveEntryMetadata[],
  limits: Readonly<ArchiveLimits> = READER_ARCHIVE_LIMITS,
): void {
  const tracker = new ArchiveBudgetTracker(limits);
  for (const entry of entries) {
    tracker.add(entry);
  }
}

export interface SafeArchiveEntry extends ArchiveEntryMetadata {
  readonly id: string;
  readonly filename: string;
  readText(signal?: AbortSignal): Promise<string>;
  readBytes(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface SafeArchive extends ArchiveProvider {
  readonly entries: readonly SafeArchiveEntry[];
  file(filename: string): SafeArchiveEntry | null;
}

export type ArchiveInput = Uint8Array | RandomAccessSource;

export interface SafeArchiveOptions {
  readonly identity?: string;
  readonly depth?: number;
  readonly parentUncompressedBytes?: number;
  readonly requestPassword?: ArchivePasswordProvider;
  readonly nativeInvoker?: NativeArchiveInvoker;
}

/**
 * EPUB chapters are normally adjacent ZIP entries. An eight-megabyte sliding
 * window turns hundreds of tiny backend/HTTP reads into a handful of bounded
 * sequential reads while keeping the complete archive out of WebView memory.
 * Remote OPDS sources keep a Readium-sized window: the ZIP central directory
 * lives in the last ~64KB, and first-paint only needs container/OPF/chapter 1.
 */
const ZIP_LOCAL_READ_AHEAD_BYTES = 8 * 1024 * 1024;
const ZIP_REMOTE_READ_AHEAD_BYTES = 256 * 1024;
const ZIP_REMOTE_TAIL_AHEAD_BYTES = 512 * 1024;

function zipReadAheadBytes(source: RandomAccessSource, index: number, length: number): number {
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

function isRandomAccessSource(input: ArchiveInput): input is RandomAccessSource {
  return typeof (input as RandomAccessSource).readRange === 'function';
}

/** Open and validate an archive without decompressing its entries. */
export async function openSafeArchive(
  input: ArchiveInput,
  formatName: 'EPUB' | 'CBZ',
  signal?: AbortSignal,
  options: SafeArchiveOptions = {},
): Promise<SafeArchive> {
  throwIfReaderLoadCancelled(signal);
  const zip = await import('@zip.js/zip.js');
  throwIfReaderLoadCancelled(signal);
  const source = isRandomAccessSource(input) ? input : createMemorySource(input);
  /**
   * zip.js asks its Reader for central-directory slices and entry headers. The
   * adapter keeps those reads on the backend-owned sparse cache instead of
   * materializing the complete archive in the WebView.
   */
  class SourceReader extends zip.Reader<RandomAccessSource> {
    private cachedOffset = 0;
    private cachedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();

    constructor(private readonly randomSource: RandomAccessSource) {
      super(randomSource);
      this.size = randomSource.size;
    }

    override async init(): Promise<void> {
      await super.init?.();
    }

    override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
      const cachedEnd = this.cachedOffset + this.cachedBytes.byteLength;
      if (index >= this.cachedOffset && index + length <= cachedEnd) {
        const start = index - this.cachedOffset;
        return this.cachedBytes.slice(start, start + length);
      }
      const requested = zipReadAheadBytes(this.randomSource, index, length);
      const bytes = await this.randomSource.readRange(index, requested, signal);
      if (bytes.byteLength < length) {
        throw new Error('ZIP source returned an incomplete range');
      }
      this.cachedOffset = index;
      this.cachedBytes = bytes;
      return bytes.slice(0, length);
    }
  }
  const reader = new zip.ZipReader(new SourceReader(source));
  const files: FileEntry[] = [];
  const budget = new ArchiveBudgetTracker(READER_ARCHIVE_LIMITS);
  const depth = options.depth ?? 0;
  const parentUncompressedBytes = options.parentUncompressedBytes ?? 0;
  const identity = options.identity ?? readerIdentityKey(source.identity);
  if (depth > 3) {
    await reader.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    throw new ParseError('ARCHIVE_NESTING_LIMIT');
  }
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      throwIfReaderLoadCancelled(signal);
      budget.add(entry);
      if (!entry.directory) {
        files.push(entry);
      }
    }
  } catch (error) {
    await reader.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    if (isReaderLoadCancelled(error, signal)) {
      throw new ReaderLoadCancelledError();
    }
    if (error instanceof ReaderLimitError) {
      throw error;
    }
    throw new ParseError(`${formatName} 文件损坏或不是有效的 zip 容器`);
  }
  const cumulativeUncompressedBytes = files.reduce(
    (total, entry) => total + entry.uncompressedSize,
    parentUncompressedBytes,
  );
  if (cumulativeUncompressedBytes > READER_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    await reader.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    throw new ReaderLimitError(
      'archiveTotalBytes',
      cumulativeUncompressedBytes,
      READER_ARCHIVE_LIMITS.maxTotalUncompressedBytes,
    );
  }

  const entries: SafeArchiveEntry[] = files.map((entry) => ({
    id: entry.filename,
    filename: entry.filename,
    directory: false,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    readText: (entrySignal) => entry.getData(new zip.TextWriter(), { signal: entrySignal }),
    readBytes: (entrySignal) =>
      entry.getData(new zip.Uint8ArrayWriter(), { signal: entrySignal }),
  }));
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  const children = new Set<ArchiveProvider>();
  let closed = false;

  return {
    entries,
    accessMode: 'random',
    identity,
    depth,
    cumulativeUncompressedBytes,
    file: (filename) => byName.get(filename) ?? null,
    readEntry: async (entryId, entrySignal) => {
      const entry = byName.get(entryId);
      if (entry === undefined) {
        throw new ParseError(`归档条目不存在：${entryId}`);
      }
      return entry.readBytes(entrySignal);
    },
    openNested: async (entryId, entrySignal) => {
      if (closed) {
        throw new ParseError('归档会话已关闭');
      }
      const entry = byName.get(entryId);
      if (entry === undefined) {
        throw new ParseError(`归档条目不存在：${entryId}`);
      }
      const nextDepth = depth + 1;
      if (nextDepth > 3) {
        throw new ParseError('ARCHIVE_NESTING_LIMIT');
      }
      const bytes = await entry.readBytes(entrySignal);
      throwIfReaderLoadCancelled(entrySignal);
      let child: ArchiveProvider;
      if (
        bytes.byteLength >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
      ) {
        child = await openSafeArchive(bytes, 'CBZ', entrySignal, {
          ...options,
          identity: `${identity}!${entryId}`,
          depth: nextDepth,
          parentUncompressedBytes: cumulativeUncompressedBytes,
        });
      } else {
        const { openNativeNestedPayload } = await import('../sources/native-archive.js');
        child = await openNativeNestedPayload(
          bytes,
          {
            parentIdentity: identity,
            entryId,
            displayName: entry.filename,
            depth: nextDepth,
            parentUncompressedBytes: cumulativeUncompressedBytes,
          },
          {
            signal: entrySignal,
            invoker: options.nativeInvoker,
            requestPassword: options.requestPassword,
          },
        );
      }
      if (closed) {
        await child.close().catch(() => undefined);
        throw new ParseError('归档会话已关闭');
      }
      children.add(child);
      return child;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...children].map((child) => child.close()));
      children.clear();
      await reader.close();
      await source.close();
    },
  };
}
