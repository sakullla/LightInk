import { describe, expect, it } from 'vitest';

import { installMapUpsertPolyfill, MAP_UPSERT_POLYFILL_SOURCE } from '../formats/map-upsert-polyfill.js';

/**
 * pdfjs ≥ 6 直接调用 TC39 upsert 提案方法；运行时缺失时 polyfill 必须补齐
 * Map/WeakMap 的 getOrInsert / getOrInsertComputed（pdf.ts 主线程与
 * pdf-worker-entry worker 两个上下文都依赖）。
 */
describe('installMapUpsertPolyfill', () => {
  interface Upsertable<K, V> {
    getOrInsert(key: K, defaultValue: V): V;
    getOrInsertComputed(key: K, compute: (key: K) => V): V;
  }

  it('installs getOrInsert / getOrInsertComputed on Map and stays idempotent', () => {
    installMapUpsertPolyfill();
    installMapUpsertPolyfill();
    const map = new Map<string, number>() as Map<string, number> &
      Upsertable<string, number>;

    expect(map.getOrInsert('a', 1)).toBe(1);
    expect(map.getOrInsert('a', 2)).toBe(1);

    let computed = 0;
    const compute = (): number => {
      computed += 1;
      return 10;
    };
    expect(map.getOrInsertComputed('b', compute)).toBe(10);
    expect(map.getOrInsertComputed('b', compute)).toBe(10);
    expect(computed).toBe(1);
    expect(map.get('b')).toBe(10);
  });

  it('exposes a self-contained worker snippet with the same methods', () => {
    expect(MAP_UPSERT_POLYFILL_SOURCE).toContain('getOrInsert');
    expect(MAP_UPSERT_POLYFILL_SOURCE).toContain('getOrInsertComputed');
    expect(MAP_UPSERT_POLYFILL_SOURCE).toContain('WeakMap');
    new Function(MAP_UPSERT_POLYFILL_SOURCE)();
    const map = new Map<string, number>() as Map<string, number> &
      Upsertable<string, number>;
    expect(map.getOrInsert('from-source', 7)).toBe(7);
  });

  it('installs the same methods on WeakMap', () => {
    installMapUpsertPolyfill();
    const map = new WeakMap<object, string>() as WeakMap<object, string> &
      Upsertable<object, string>;
    const key = {};

    expect(map.getOrInsert(key, 'x')).toBe('x');
    expect(map.getOrInsert(key, 'y')).toBe('x');
    expect(map.getOrInsertComputed(key, () => 'z')).toBe('x');
  });
});
