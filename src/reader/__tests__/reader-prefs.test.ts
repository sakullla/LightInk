import { describe, expect, it } from 'vitest';

import {
  DEFAULT_READER_PREFS,
  READER_PREFS_STORAGE_KEY,
  applyReaderPrefs,
  loadReaderPrefs,
  parseReaderPrefs,
  saveReaderPrefs,
} from '../reader-prefs.js';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return store[key] ?? null;
    },
    setItem(key, value) {
      store[key] = value;
    },
  };
}

describe('reader prefs', () => {
  it('defaults the progress bar on so first-run reading still shows location', () => {
    expect(loadReaderPrefs(null)).toEqual(DEFAULT_READER_PREFS);
    expect(loadReaderPrefs(memoryStorage())).toEqual({ showProgressBar: true });
    expect(parseReaderPrefs(undefined)).toEqual({ showProgressBar: true });
  });

  it('round-trips turning the progress bar off', () => {
    const storage = memoryStorage();
    expect(saveReaderPrefs(storage, { showProgressBar: false })).toEqual({
      showProgressBar: false,
    });
    expect(storage.store[READER_PREFS_STORAGE_KEY]).toContain('"showProgressBar":false');
    expect(loadReaderPrefs(storage)).toEqual({ showProgressBar: false });
  });

  it('ignores corrupt storage and missing fields', () => {
    expect(parseReaderPrefs('{not-json')).toEqual({ showProgressBar: true });
    expect(parseReaderPrefs('{"showProgressBar":"no"}')).toEqual({ showProgressBar: true });
  });

  it('stamps the document dataset used by reader CSS', () => {
    const root = { dataset: {} as DOMStringMap };
    applyReaderPrefs(root, { showProgressBar: true });
    expect(root.dataset.readerProgressBar).toBe('on');
    applyReaderPrefs(root, { showProgressBar: false });
    expect(root.dataset.readerProgressBar).toBe('off');
  });
});
