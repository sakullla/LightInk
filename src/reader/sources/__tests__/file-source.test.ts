import { describe, expect, it, vi } from 'vitest';

import { createLocalFileSource } from '../file-source.js';

describe('createLocalFileSource', () => {
  it('exposes a local random-access source without buffering the file', async () => {
    const readRange = vi.fn(async () => new Uint8Array([1, 2]));
    const source = createLocalFileSource({
      size: 4096,
      identity: { id: 'local:/book.cbz' },
      readRange,
    });

    expect(source.access).toBe('local');
    expect(source.size).toBe(4096);
    await expect(source.readRange(0, 2)).resolves.toEqual(new Uint8Array([1, 2]));
    await source.close();
    expect(readRange).toHaveBeenCalledTimes(1);
  });
});
