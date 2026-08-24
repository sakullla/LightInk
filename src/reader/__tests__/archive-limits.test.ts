import { describe, expect, it } from 'vitest';

import {
  READER_ARCHIVE_LIMITS,
  validateArchiveMetadata,
  type ArchiveEntryMetadata,
  type ArchiveLimits,
} from '../formats/safe-archive.js';
import { ReaderLimitError } from '../formats/types.js';

const limits: ArchiveLimits = {
  maxEntries: 2,
  maxTotalUncompressedBytes: 10,
  maxEntryUncompressedBytes: 8,
  maxCompressionRatio: 4,
};

const entry = (
  uncompressedSize: number,
  compressedSize = uncompressedSize,
): ArchiveEntryMetadata => ({ directory: false, compressedSize, uncompressedSize });

function expectLimit(
  entries: readonly ArchiveEntryMetadata[],
  kind: ReaderLimitError['kind'],
): void {
  try {
    validateArchiveMetadata(entries, limits);
    throw new Error('expected archive validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ReaderLimitError);
    expect((error as ReaderLimitError).kind).toBe(kind);
  }
}

describe('reader archive limits', () => {
  it('publishes the product safety budgets', () => {
    expect(READER_ARCHIVE_LIMITS).toEqual({
      maxEntries: 5_000,
      maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
      maxEntryUncompressedBytes: 64 * 1024 * 1024,
      maxCompressionRatio: 200,
    });
  });

  it('accepts values exactly at every configured boundary', () => {
    expect(() => validateArchiveMetadata([entry(8, 2), entry(2, 1)], limits)).not.toThrow();
  });

  it('rejects one entry over the count limit', () => {
    expectLimit([entry(1), entry(1), entry(1)], 'archiveEntries');
  });

  it('rejects one byte over entry and total size limits', () => {
    expectLimit([entry(9, 9)], 'archiveEntryBytes');
    expectLimit([entry(8, 8), entry(3, 3)], 'archiveTotalBytes');
  });

  it('rejects a compression ratio over the limit, including zero compressed bytes', () => {
    expectLimit([entry(5, 1)], 'archiveCompressionRatio');
    expectLimit([entry(1, 0)], 'archiveCompressionRatio');
  });
});
