import { describe, expect, it } from 'vitest';

import {
  validateArchiveMetadata,
  type ArchiveEntryMetadata,
  type ArchiveLimits,
} from '../formats/safe-archive.js';
import { ReaderLimitError } from '../formats/types.js';
import { injectReaderLimit, READER_LIMITS } from '../reader-limits.js';

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

/** 以注册表缺省预算校验并断言拒绝种类（传播探针用）。 */
function expectDefaultLimit(
  entries: readonly ArchiveEntryMetadata[],
  kind: ReaderLimitError['kind'],
): void {
  try {
    validateArchiveMetadata(entries);
    throw new Error('expected archive validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ReaderLimitError);
    expect((error as ReaderLimitError).kind).toBe(kind);
  }
}

describe('reader archive limits', () => {
  it('publishes the product safety budgets from the registry', () => {
    // shared-utils：归档预算数值唯一事实源在限额注册表（缺省值与重构前逐值相同）。
    expect(READER_LIMITS.maxArchiveEntries).toBe(5_000);
    expect(READER_LIMITS.maxArchiveTotalUncompressedBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(READER_LIMITS.maxArchiveEntryUncompressedBytes).toBe(64 * 1024 * 1024);
    expect(READER_LIMITS.maxArchiveCompressionRatio).toBe(200);
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

  it('注册表单项收紧后归档校验同步以同错误种类拒绝（传播探针）', () => {
    // shared-utils：openSafeArchive/validateArchiveMetadata 在调用时从注册表取
    // 预算——单项收紧后走缺省预算的校验同步拒绝，错误种类仍为 archiveEntries。
    expect(() => validateArchiveMetadata([entry(1), entry(1), entry(1)])).not.toThrow();
    const restore = injectReaderLimit('maxArchiveEntries', 2);
    try {
      expectDefaultLimit([entry(1), entry(1), entry(1)], 'archiveEntries');
    } finally {
      restore();
    }
    expect(() => validateArchiveMetadata([entry(1), entry(1), entry(1)])).not.toThrow();
  });
});
