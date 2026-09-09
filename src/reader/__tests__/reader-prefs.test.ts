import { describe, expect, it } from 'vitest';

import {
  DEFAULT_READER_PREFS,
  READER_PREFS_STORAGE_KEY,
  applyReaderPrefs,
  currentReaderPageTurnStyle,
  effectiveReaderPageTurnEffect,
  loadReaderPrefs,
  parseReaderPrefs,
  resolveReaderPageTurnEffect,
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
    expect(loadReaderPrefs(memoryStorage())).toEqual({
      showProgressBar: true,
      pageTurnStyle: 'auto',
    });
    expect(parseReaderPrefs(undefined)).toEqual(DEFAULT_READER_PREFS);
  });

  it('round-trips turning the progress bar off', () => {
    const storage = memoryStorage();
    expect(
      saveReaderPrefs(storage, { showProgressBar: false, pageTurnStyle: 'auto' }),
    ).toEqual({
      showProgressBar: false,
      pageTurnStyle: 'auto',
    });
    expect(storage.store[READER_PREFS_STORAGE_KEY]).toContain('"showProgressBar":false');
    expect(loadReaderPrefs(storage)).toEqual({ showProgressBar: false, pageTurnStyle: 'auto' });
  });

  it('ignores corrupt storage and missing fields', () => {
    expect(parseReaderPrefs('{not-json')).toEqual(DEFAULT_READER_PREFS);
    expect(parseReaderPrefs('{"showProgressBar":"no"}')).toEqual(DEFAULT_READER_PREFS);
  });

  it('stamps the document dataset used by reader CSS', () => {
    const root = { dataset: {} as DOMStringMap };
    applyReaderPrefs(root, { showProgressBar: true, pageTurnStyle: 'auto' });
    expect(root.dataset.readerProgressBar).toBe('on');
    applyReaderPrefs(root, { showProgressBar: false, pageTurnStyle: 'auto' });
    expect(root.dataset.readerProgressBar).toBe('off');
  });
});

describe('page turn style preference (R1)', () => {
  it('defaults to auto and round-trips every explicit style', () => {
    const storage = memoryStorage();
    for (const style of ['slide', 'fade', 'curl', 'none'] as const) {
      expect(saveReaderPrefs(storage, { showProgressBar: true, pageTurnStyle: style })).toEqual({
        showProgressBar: true,
        pageTurnStyle: style,
      });
      expect(loadReaderPrefs(storage).pageTurnStyle).toBe(style);
    }
    // 显式选择持久化在既有 chrome 偏好键里，重启（重读存储）后保留。
    saveReaderPrefs(storage, { showProgressBar: true, pageTurnStyle: 'curl' });
    expect(JSON.parse(storage.store[READER_PREFS_STORAGE_KEY]!)).toMatchObject({
      pageTurnStyle: 'curl',
    });
  });

  it('treats legacy payloads and unknown values as auto', () => {
    expect(parseReaderPrefs('{"showProgressBar":true}').pageTurnStyle).toBe('auto');
    expect(parseReaderPrefs('{"showProgressBar":true,"pageTurnStyle":"zoom"}').pageTurnStyle).toBe(
      'auto',
    );
    expect(
      saveReaderPrefs(memoryStorage(), {
        showProgressBar: true,
        pageTurnStyle: 'zoom' as unknown as 'slide',
      }).pageTurnStyle,
    ).toBe('auto');
  });

  it('resolves auto by prefers-reduced-motion and passes explicit choices through', () => {
    expect(resolveReaderPageTurnEffect('auto', false)).toBe('slide');
    expect(resolveReaderPageTurnEffect('auto', true)).toBe('none');
    // 显式选择覆盖系统设置：reduce 下按用户选择执行。
    expect(resolveReaderPageTurnEffect('slide', true)).toBe('slide');
    expect(resolveReaderPageTurnEffect('fade', true)).toBe('fade');
    expect(resolveReaderPageTurnEffect('curl', false)).toBe('curl');
    expect(resolveReaderPageTurnEffect('none', false)).toBe('none');
  });

  it('exposes the applied style through the in-memory cache', () => {
    const root = { dataset: {} as DOMStringMap };
    try {
      applyReaderPrefs(root, { showProgressBar: true, pageTurnStyle: 'fade' });
      expect(currentReaderPageTurnStyle()).toBe('fade');
      expect(effectiveReaderPageTurnEffect(() => ({ matches: true }))).toBe('fade');
      applyReaderPrefs(root, { showProgressBar: true, pageTurnStyle: 'auto' });
      expect(effectiveReaderPageTurnEffect(() => ({ matches: true }))).toBe('none');
      expect(effectiveReaderPageTurnEffect(() => ({ matches: false }))).toBe('slide');
    } finally {
      applyReaderPrefs(root, DEFAULT_READER_PREFS);
    }
  });

  it('stamps data-reader-page-turn for CSS reduce-motion gating', () => {
    const root = { dataset: {} as DOMStringMap };
    applyReaderPrefs(root, { showProgressBar: true, pageTurnStyle: 'curl' });
    expect(root.dataset.readerPageTurn).toBe('curl');
    applyReaderPrefs(root, { showProgressBar: true, pageTurnStyle: 'auto' });
    expect(root.dataset.readerPageTurn).toBe('auto');
  });
});
