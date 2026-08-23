import { describe, expect, it } from 'vitest';

import {
  createMemorySource,
  normalizeReaderTarget,
  readerIdentityKey,
  readerTargetFromPath,
} from '../index.js';

describe('reader source contracts', () => {
  it('normalizes legacy local paths into stable targets', () => {
    const target = readerTargetFromPath('books\\novel.epub');
    expect(target.kind).toBe('local');
    expect(target.displayName).toBe('novel.epub');
    expect(readerTargetFromPath('/cache/%E4%B8%89%E4%BD%93.epub').displayName).toBe('三体.epub');
    expect(target.extension).toBe('epub');
    expect(normalizeReaderTarget('books/novel.epub')).toMatchObject({ kind: 'local' });
  });

  it('keeps validators in document identities', () => {
    expect(readerIdentityKey({ id: 'book-1', validator: 'etag-1' })).toBe('book-1@etag-1');
    expect(readerIdentityKey({ id: 'book-1' })).toBe('book-1');
  });

  it('reads bounded ranges without exposing the backing buffer', async () => {
    const source = createMemorySource(Uint8Array.from([0, 1, 2, 3, 4]), { id: 'fixture' });
    expect(await source.readRange(1, 3)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(await source.readRange(20, 2)).toEqual(new Uint8Array());
    await source.close();
    await expect(source.readRange(0, 1)).rejects.toThrow('closed');
  });
});
