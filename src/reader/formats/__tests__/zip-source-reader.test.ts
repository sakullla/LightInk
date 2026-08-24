import { describe, expect, it, vi } from 'vitest';

import type { RandomAccessSource } from '../../sources/types.js';
import {
  ZIP_LOCAL_READ_AHEAD_BYTES,
  ZIP_LOCAL_WINDOW_COUNT,
  ZIP_REMOTE_READ_AHEAD_BYTES,
  ZIP_REMOTE_WINDOW_COUNT,
  ZipRangeCache,
  createZipRangeCache,
  zipReadAheadBytes,
  zipSourceWindowCount,
} from '../zip-source-reader.js';

function delay(ms = 5): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sourceOf(
  bytes: Uint8Array,
  access: RandomAccessSource['access'] = 'local',
): RandomAccessSource {
  return {
    size: bytes.byteLength,
    identity: { id: 'test' },
    access,
    readRange: async (offset, length) => bytes.slice(offset, offset + length),
    close: async () => undefined,
  };
}

describe('zip range cache', () => {
  it('uses a local 1MiB window and a smaller remote window', () => {
    const local = { size: 40 * 1024 * 1024, access: 'local' as const };
    const remote = { size: 40 * 1024 * 1024, access: 'remote' as const };
    expect(zipReadAheadBytes(local, 0, 16)).toBe(ZIP_LOCAL_READ_AHEAD_BYTES);
    expect(zipReadAheadBytes(remote, 0, 16)).toBe(ZIP_REMOTE_READ_AHEAD_BYTES);
    expect(zipReadAheadBytes(local, local.size - 8, 16)).toBe(8);
    expect(zipSourceWindowCount(local)).toBe(ZIP_LOCAL_WINDOW_COUNT);
    expect(zipSourceWindowCount(remote)).toBe(ZIP_REMOTE_WINDOW_COUNT);
  });

  it('serves a later slice from the owned window without a second read', async () => {
    const file = Uint8Array.from({ length: 32 }, (_, index) => index);
    const readRange = vi.fn(async (offset: number, length: number) =>
      file.slice(offset, offset + length),
    );
    const cache = new ZipRangeCache({
      size: file.byteLength,
      maxWindows: 1,
      readAhead: (_index, length) => length,
      readRange,
    });

    await expect(cache.read(0, 8)).resolves.toEqual(file.slice(0, 8));
    await expect(cache.read(4, 4)).resolves.toEqual(file.slice(4, 8));
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it('keeps distant parallel windows so one page fill does not evict the other', async () => {
    const file = Uint8Array.from({ length: 64 }, (_, index) => index);
    let inflight = 0;
    let maxInflight = 0;
    const readRange = vi.fn(async (offset: number, length: number) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await delay();
      inflight -= 1;
      return file.slice(offset, offset + length);
    });
    const cache = new ZipRangeCache({
      size: file.byteLength,
      maxWindows: 2,
      readAhead: (_index, length) => length,
      readRange,
    });

    const [left, right] = await Promise.all([cache.read(0, 8), cache.read(32, 8)]);
    expect(left).toEqual(file.slice(0, 8));
    expect(right).toEqual(file.slice(32, 40));
    expect(maxInflight).toBe(2);
    expect(readRange).toHaveBeenCalledTimes(2);

    await expect(cache.read(2, 4)).resolves.toEqual(file.slice(2, 6));
    await expect(cache.read(34, 4)).resolves.toEqual(file.slice(34, 38));
    expect(readRange).toHaveBeenCalledTimes(2);
  });

  it('coalesces overlapping in-flight fills into one readRange', async () => {
    const file = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const readRange = vi.fn(async (offset: number, length: number) => {
      await delay();
      return file.slice(offset, offset + length);
    });
    const cache = new ZipRangeCache({
      size: file.byteLength,
      maxWindows: 1,
      readAhead: () => 16,
      readRange,
    });

    const [head, mid] = await Promise.all([cache.read(0, 4), cache.read(8, 4)]);
    expect(head).toEqual(file.slice(0, 4));
    expect(mid).toEqual(file.slice(8, 12));
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(readRange).toHaveBeenCalledWith(0, 16, undefined);
  });

  it('copies out of a reused source buffer so a later fill cannot rewrite a live page', async () => {
    const file = Uint8Array.from({ length: 16 }, (_, index) => index + 10);
    const reusable = new Uint8Array(16);
    const cache = new ZipRangeCache({
      size: file.byteLength,
      maxWindows: 2,
      readAhead: (_index, length) => length,
      readRange: async (offset, length) => {
        reusable.fill(0xff);
        reusable.set(file.subarray(offset, offset + length));
        await delay();
        return reusable.subarray(0, length);
      },
    });

    const first = await cache.read(0, 4);
    const second = await cache.read(8, 4);
    reusable.fill(0);
    expect(first).toEqual(new Uint8Array([10, 11, 12, 13]));
    expect(second).toEqual(new Uint8Array([18, 19, 20, 21]));
  });

  it('throws when the source returns fewer bytes than the requested page slice', async () => {
    const cache = new ZipRangeCache({
      size: 32,
      maxWindows: 1,
      readAhead: (_index, length) => length,
      readRange: async () => new Uint8Array([1, 2]),
    });
    await expect(cache.read(0, 8)).rejects.toThrow('ZIP source returned an incomplete range');
  });

  it('wires local sources to the multi-window cache', async () => {
    const file = new Uint8Array([9, 8, 7, 6]);
    const cache = createZipRangeCache(sourceOf(file));
    await expect(cache.read(1, 2)).resolves.toEqual(new Uint8Array([8, 7]));
    await expect(cache.read(100, 4)).resolves.toEqual(new Uint8Array());
  });
});
