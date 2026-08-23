import { extOfPath } from '../../file/path-ext.js';

/** A document identity used by progress, annotations, and cache records. */
export interface ReaderDocumentIdentity {
  /** Stable application-level identity (not a filesystem path). */
  readonly id: string;
  /** Server/content validator, when the source provides one. */
  readonly validator?: string;
}

export interface LocalReaderTarget {
  readonly kind: 'local';
  readonly path: string;
  readonly identity: ReaderDocumentIdentity;
  readonly displayName: string;
  readonly extension: string;
}

export interface RemoteReaderTarget {
  readonly kind: 'remote';
  readonly itemId: string;
  readonly resourceId: string;
  readonly identity: ReaderDocumentIdentity;
  readonly displayName: string;
  readonly extension: string;
  readonly mimeType: string;
}

export type ReaderTarget = LocalReaderTarget | RemoteReaderTarget;

/**
 * A random-access byte source. Implementations may be backed by a local file,
 * a sparse HTTP cache, or an in-memory test buffer.
 */
export interface RandomAccessSource {
  readonly size: number;
  readonly identity: ReaderDocumentIdentity;
  /**
   * Remote HTTP sources must use a smaller ZIP window than local files.
   * Readium streams OPDS EPUBs with Range requests instead of prefetching
   * multi-megabyte slices on first paint.
   */
  readonly access?: 'local' | 'remote';
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Metadata shared by ZIP and native archive providers. */
export interface ArchiveEntryMetadata {
  /** Provider-specific stable id; ZIP providers use the filename. */
  readonly id?: string;
  readonly filename?: string;
  readonly directory: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly encrypted?: boolean;
  readonly solid?: boolean;
  readonly split?: boolean;
}

export interface ArchiveReadProgress {
  readonly phase: 'idle' | 'decoding' | 'sequential' | 'ready' | 'cancelled' | 'error';
  readonly currentEntry: number;
  readonly targetEntry: number;
  readonly decodedBytes: number;
}

/** Format-neutral archive boundary used by reader renderers. */
export interface ArchiveProvider {
  readonly entries: readonly ArchiveEntryMetadata[];
  readonly accessMode: 'random' | 'sequential';
  readonly identity?: string;
  readonly depth?: number;
  readonly cumulativeUncompressedBytes?: number;
  readEntry(entryId: string, signal?: AbortSignal): Promise<Uint8Array>;
  openNested?(entryId: string, signal?: AbortSignal): Promise<ArchiveProvider>;
  cancel?(): Promise<void>;
  subscribeProgress?(listener: (progress: ArchiveReadProgress) => void): () => void;
  close(): Promise<void>;
}

function displayNameOfPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

/** Build a local target while preserving the existing path-based API. */
export function readerTargetFromPath(path: string): LocalReaderTarget {
  const displayName = displayNameOfPath(path);
  return {
    kind: 'local',
    path,
    identity: { id: `local:${path}` },
    displayName,
    extension: extOfPath(path),
  };
}

/** Normalize either legacy paths or a new source target. */
export function normalizeReaderTarget(target: string | ReaderTarget): ReaderTarget {
  return typeof target === 'string' ? readerTargetFromPath(target) : target;
}

/** Stable key used by localStorage and annotation storage. */
export function readerIdentityKey(identity: ReaderDocumentIdentity): string {
  return identity.validator === undefined
    ? identity.id
    : `${identity.id}@${identity.validator}`;
}
