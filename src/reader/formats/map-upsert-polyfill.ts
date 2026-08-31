/**
 * `map-upsert-polyfill` — TC39 upsert 提案（`Map`/`WeakMap` 的 `getOrInsert` /
 * `getOrInsertComputed`）polyfill。
 *
 * pdfjs-dist ≥ 6 直接调用这两个方法且不自带兼容层，而 WebView2 与当前主流
 * 浏览器尚未实装；缺失时 range 加载在 worker 的 ChunkedStreamManager 处抛
 * `getOrInsertComputed is not a function`，被兜底成“PDF 文件损坏或无法解析”。
 * 主线程（pdf.ts）与 pdf.js worker 是两个独立 JS 上下文，都必须在加载
 * pdfjs 模块前安装。worker 侧只能跑无 Vite 依赖的纯 JS（见
 * {@link MAP_UPSERT_POLYFILL_SOURCE}），不能 import 本模块。
 */

interface UpsertableMap {
  has(key: unknown): boolean;
  get(key: unknown): unknown;
  set(key: unknown, value: unknown): unknown;
}

/** 幂等安装；运行时原生支持后自动退化为 no-op。函数体必须自包含，供 worker blob 序列化。 */
export function installMapUpsertPolyfill(): void {
  const installOn = (prototype: object): void => {
    const target = prototype as Record<string, unknown>;
    if (typeof target['getOrInsert'] !== 'function') {
      Object.defineProperty(prototype, 'getOrInsert', {
        value(this: UpsertableMap, key: unknown, defaultValue: unknown): unknown {
          if (this.has(key)) {
            return this.get(key);
          }
          this.set(key, defaultValue);
          return defaultValue;
        },
        writable: true,
        configurable: true,
      });
    }
    if (typeof target['getOrInsertComputed'] !== 'function') {
      Object.defineProperty(prototype, 'getOrInsertComputed', {
        value(
          this: UpsertableMap,
          key: unknown,
          compute: (key: unknown) => unknown,
        ): unknown {
          if (this.has(key)) {
            return this.get(key);
          }
          const value = compute(key);
          this.set(key, value);
          return value;
        },
        writable: true,
        configurable: true,
      });
    }
  };
  installOn(Map.prototype);
  installOn(WeakMap.prototype);
}

/**
 * 写入 pdf.js worker blob 的纯 JS。Vite 会给 `pdf.worker.min.mjs` 注入
 * `@vite/client`，在 Worker 里会挂起；blob 里不能再 import 任何经 Vite 转换的模块。
 */
export const MAP_UPSERT_POLYFILL_SOURCE = `(${installMapUpsertPolyfill.toString()})();`;
