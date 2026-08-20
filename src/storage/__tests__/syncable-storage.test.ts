import { describe, expect, it, vi } from 'vitest';
import {
  createSyncableStorage,
  isSyncableStorageEntry,
  isSyncableStorageKey,
} from '../syncable-storage.js';

const SHA256 = 'a'.repeat(64);
const PROGRESS_KEY = 'lightink.reader.progress.0123456789abcdef';
const PROGRESS = JSON.stringify({
  version: 1,
  kind: 'flow',
  index: 2,
  ratio: 0.5,
  updatedAt: 10,
});

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    values,
  };
}

describe('SyncableStorage', () => {
  it('allows whitelisted preferences and progress prefixes only', () => {
    expect(isSyncableStorageKey('lightink.theme')).toBe(true);
    expect(isSyncableStorageKey('lightink.theme.customCss')).toBe(true);
    expect(isSyncableStorageKey('lightink.opds.sources')).toBe(true);
    expect(isSyncableStorageKey(PROGRESS_KEY)).toBe(true);
    expect(isSyncableStorageKey('lightink.reader.progress./home/user/book.epub')).toBe(false);
    expect(isSyncableStorageKey('lightink.library.progressAlias.local:/books/a.epub')).toBe(false);
    expect(isSyncableStorageKey(`lightink.library.progressAlias.managed:${SHA256}`)).toBe(true);
    expect(isSyncableStorageKey('lightink.annotation./home/user/book.epub')).toBe(false);
    expect(isSyncableStorageKey('lightink.recent.other')).toBe(false);
    expect(isSyncableStorageKey('lightink.recent.managed')).toBe(true);
    expect(isSyncableStorageKey('lightink.theme.customPath')).toBe(false);
    expect(isSyncableStorageKey('lightink.remote.password')).toBe(false);
    expect(isSyncableStorageKey('lightink.crash.snapshot')).toBe(false);
  });

  it('exports and applies only syncable keys and reports mutations', () => {
    const base = storage({
      'lightink.theme': 'dark',
      'lightink.theme.customPath': '/home/user/theme.css',
      [PROGRESS_KEY]: PROGRESS,
    });
    const changes: Array<[string, string | null]> = [];
    const sync = createSyncableStorage(base, {
      onChange: (key, value) => changes.push([key, value]),
    });

    expect(sync.snapshot()).toEqual({
      'lightink.theme': 'dark',
      [PROGRESS_KEY]: PROGRESS,
    });
    sync.applySnapshot({ 'lightink.locale': 'zh-CN', 'lightink.remote.password': 'secret' });
    sync.removeItem('lightink.theme');
    expect(base.values.get('lightink.locale')).toBe('zh-CN');
    expect(base.values.has('lightink.remote.password')).toBe(false);
    expect(sync.snapshot()).not.toHaveProperty('lightink.remote.password');
    expect(changes).toEqual([
      ['lightink.locale', 'zh-CN'],
      ['lightink.theme', null],
    ]);
  });

  it('rejects path-bearing legacy values from portable snapshots', () => {
    const aliasKey = `lightink.library.progressAlias.managed:${SHA256}`;
    const base = storage({
      [aliasKey]: '/home/user/books/private.epub',
      'lightink.reader.progress./home/user/books/private.epub': PROGRESS,
      'lightink.recent.managed': JSON.stringify(['/home/user/notes/private.md']),
    });
    const onChange = vi.fn();
    const sync = createSyncableStorage(base, { onChange });

    expect(sync.snapshot()).toEqual({});
    expect(isSyncableStorageEntry(aliasKey, '0123456789abcdef')).toBe(true);
    expect(isSyncableStorageEntry(aliasKey, '/home/user/books/private.epub')).toBe(false);

    sync.setItem(aliasKey, '0123456789abcdef');
    expect(onChange).toHaveBeenCalledWith(aliasKey, '0123456789abcdef');
    sync.setItem(aliasKey, 'C:\\Users\\user\\private.epub');
    expect(onChange).toHaveBeenLastCalledWith(aliasKey, null);
  });

  it('does not turn a storage failure into an application crash on reads', () => {
    const broken = storage();
    broken.getItem = vi.fn(() => {
      throw new Error('quota');
    });
    const sync = createSyncableStorage(broken);
    expect(sync.getItem('lightink.theme')).toBeNull();
  });

  it('reports only effective mutations', () => {
    const base = storage({ 'lightink.theme': 'dark' });
    const onChange = vi.fn();
    const sync = createSyncableStorage(base, { onChange });

    sync.setItem('lightink.theme', 'dark');
    sync.removeItem('lightink.locale');
    sync.setItem('lightink.theme', 'warm-light');
    sync.removeItem('lightink.theme');

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, 'lightink.theme', 'warm-light');
    expect(onChange).toHaveBeenNthCalledWith(2, 'lightink.theme', null);
  });
});
