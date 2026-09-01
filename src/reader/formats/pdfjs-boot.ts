/**
 * `pdfjs-boot` — pdf.js 官方组件层的唯一引导链路。
 *
 * 顺序不可调换，每一步都有前置依赖：
 * 1. `installMapUpsertPolyfill()`：pdfjs ≥ 6 直接调用 Map/WeakMap 的 upsert 提案
 *    方法，主线程必须在 import pdfjs 模块之前装好（worker 侧由同源 boot 补）。
 * 2. `await import('pdfjs-dist')`：主库动态 import，保冷启动懒加载。
 * 3. 幂等挂 `globalThis.pdfjsLib`（`??=` 语义，src/ 全仓唯一赋值点）：组件层
 *    `pdf_viewer.mjs` 在模块顶层从 `globalThis.pdfjsLib` 解构全部 API，挂载必须
 *    先于组件层 import，顺序错会立刻 TypeError。现代 build 的 pdf.mjs 求值时
 *    自己也会 `globalThis.pdfjsLib = {...}`（script 标签场景的导出副作用），正常
 *    路径 ??= 观察到同版本挂载直接复用；这里的赋值兜底不自行挂载的 build。
 *    已挂实例与本次主库版本不一致时尽早抛错——双实例错位会在组件层求值或
 *    PDFViewer 构造（同样强校验版本）时 TypeError，晚炸更难排查。
 * 4. worker 同源 boot：复用 `pdf-worker-entry` 的 `workerSrc` 与
 *    `preparePdfjsWorker()`（Worker 线程不可用时回退主线程 fake worker）。
 * 5. `await import('pdfjs-dist/web/pdf_viewer.mjs')`：组件层作为第二个懒加载
 *    chunk，只在以上全部就绪后求值。
 *
 * 引导 promise 记忆化：并发/重复调用复用同一实例，不重复 import；引导失败时
 * 清空记忆，下一次调用可重试。渲染内核（pdf.ts）只经本模块取主库与 viewer 组件。
 */

import { installMapUpsertPolyfill } from './map-upsert-polyfill.js';

/** `await import('pdfjs-dist')` 的主库命名空间（getDocument/GlobalWorkerOptions/…）。 */
export type PdfjsMainModule = typeof import('pdfjs-dist');

/** `await import('pdfjs-dist/web/pdf_viewer.mjs')` 的组件层命名空间（PDFViewer/EventBus/…）。 */
export type PdfjsViewerModule = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

/** 引导产物：主库实例 + 官方 viewer 组件模块。 */
export interface PdfjsComponents {
  readonly pdfjs: PdfjsMainModule;
  readonly viewer: PdfjsViewerModule;
}

type PdfjsGlobalScope = typeof globalThis & { pdfjsLib?: PdfjsMainModule };

let bootPromise: Promise<PdfjsComponents> | null = null;

/**
 * `globalThis.pdfjsLib ??= pdfjs` 加版本守卫：同版本重复挂载直接复用；版本不一致
 * 说明出现了第二个 pdfjs 实例（双包实例化/重复打包，典型时序是主库已进模块缓存
 * 之后有外部把另一版本的 pdfjsLib 挂上全局），抛出明确错误而不是把错位带进
 * 组件层求值。
 */
function mountPdfjsLib(pdfjs: PdfjsMainModule): void {
  const globalScope = globalThis as PdfjsGlobalScope;
  const existing = globalScope.pdfjsLib;
  if (existing === undefined) {
    globalScope.pdfjsLib = pdfjs;
    return;
  }
  if (existing.version !== pdfjs.version) {
    throw new Error(
      `globalThis.pdfjsLib 已挂载版本 ${JSON.stringify(existing.version)}，与本次加载的 ` +
        `pdfjs-dist ${JSON.stringify(pdfjs.version)} 不一致；组件层从 globalThis.pdfjsLib ` +
        '解构 API，请确认只经 pdfjs-boot 引导 pdfjs。',
    );
  }
}

async function bootPdfjs(): Promise<PdfjsComponents> {
  installMapUpsertPolyfill();
  const pdfjs = await import('pdfjs-dist');
  mountPdfjsLib(pdfjs);
  const workerEntry = await import('./pdf-worker-entry.js');
  // 同源 boot：pdf.js 自己 new Worker 并做 ready/test 握手；线程不可用时
  // preparePdfjsWorker 回退主线程 fake worker。不要传 PDFWorker({ port })。
  pdfjs.GlobalWorkerOptions.workerSrc = workerEntry.pdfWorkerSrc();
  await workerEntry.preparePdfjsWorker();
  const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
  return { pdfjs, viewer };
}

/**
 * 引导（并返回）pdf.js 主库与官方 viewer 组件。并发/重复调用复用同一实例；
 * 失败后清除记忆，可重试。组件层只在 `globalThis.pdfjsLib` 挂载后才被 import。
 */
export function loadPdfjsComponents(): Promise<PdfjsComponents> {
  bootPromise ??= bootPdfjs().catch((error: unknown) => {
    bootPromise = null;
    throw error;
  });
  return bootPromise;
}
