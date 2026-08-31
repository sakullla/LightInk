/**
 * pdf.js workerSrc：同源 boot，而不是 blob + PDFWorker({ port })。
 *
 * 1. Vite 给 `pdf.worker.min.mjs` 注入 `@vite/client`（Worker 里没有
 *    `window`/`document`，模块求值挂起）。开发态必须走未转换的静态文件。
 * 2. pdf.js 看到非同源 workerSrc 会再包一层 `await import(url)` 的 blob，
 *    blob 源为 null，这个 import 会挂起，Opening 永远不结束。
 * 3. `new PDFWorker({ port })` 会立刻标成 ready。模块 worker 若尚未
 *    `initializeFromPort`，首开消息丢掉；若官方 worker 已经自己启动，
 *    再调一次会把 ready ping 卡死（第一次 Opening 超时）。
 *
 * 同源 boot：先装 upsert polyfill，再 import 官方 worker。静态块若已
 * `initializeFromPort` 就不再调；否则补一次。pdf.js 自己 `new Worker`
 * 并做 ready/test 握手。
 *
 * 部分 WebView（含当前预览浏览器）里 `new Worker` 能构造但永远不跑、也不
 * 报错，getDocument 会一直停在 Opening。探测失败时在主线程 import 官方
 * worker，让 pdf.js 走 fake worker。
 */

import { MAP_UPSERT_POLYFILL_SOURCE } from './map-upsert-polyfill.js';

/** 与 vite.config.ts `lightinkPdfWorkerStatic` 中间件路径保持一致。 */
export const PDF_WORKER_DEV_PATH = '/__lightink/pdf.worker.min.mjs';
export const PDF_WORKER_BOOT_DEV_PATH = '/__lightink/pdf.worker.boot.mjs';
export const PDF_WORKER_BOOT_FILE = 'pdf.worker.boot.mjs';
export const PDF_WORKER_OFFICIAL_FILE = 'pdf.worker.min.mjs';
export const PDF_WORKER_OFFICIAL_SPECIFIER = './pdf.worker.min.mjs';

export const PDF_WORKER_PING_TIMEOUT_MS = 800;

let workerThreads: boolean | null = null;

export function pdfWorkerBootModule(officialSpecifier: string): string {
  return `${MAP_UPSERT_POLYFILL_SOURCE}
const { WorkerMessageHandler } = await import(${JSON.stringify(officialSpecifier)});
if (typeof window === "undefined" && typeof self.onmessage !== "function") {
  WorkerMessageHandler.initializeFromPort(self);
}
export { WorkerMessageHandler };
`;
}

function urlFromPath(relative: string): string {
  return new URL(
    relative,
    typeof globalThis.location?.href === 'string' && globalThis.location.href !== ''
      ? globalThis.location.href
      : 'http://localhost/',
  ).href;
}

export function officialPdfWorkerHref(): string {
  const relative =
    import.meta.env.DEV === true
      ? PDF_WORKER_DEV_PATH
      : `${import.meta.env.BASE_URL}${PDF_WORKER_OFFICIAL_FILE}`;
  return urlFromPath(relative);
}

export function pdfWorkerSrc(): string {
  const relative =
    import.meta.env.DEV === true
      ? PDF_WORKER_BOOT_DEV_PATH
      : `${import.meta.env.BASE_URL}${PDF_WORKER_BOOT_FILE}`;
  return urlFromPath(relative);
}

export function resetPdfWorkerThreadProbe(): void {
  workerThreads = null;
}

export async function pdfWorkerThreadsAvailable(
  timeoutMs: number = PDF_WORKER_PING_TIMEOUT_MS,
): Promise<boolean> {
  if (workerThreads !== null) {
    return workerThreads;
  }
  if (typeof Worker === 'undefined') {
    workerThreads = false;
    return false;
  }
  workerThreads = await new Promise<boolean>((resolve) => {
    const src = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
    let worker: Worker;
    try {
      worker = new Worker(src);
    } catch {
      URL.revokeObjectURL(src);
      resolve(false);
      return;
    }
    const finish = (ok: boolean): void => {
      globalThis.clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      URL.revokeObjectURL(src);
      resolve(ok);
    };
    const onMessage = (): void => finish(true);
    const onError = (): void => finish(false);
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
  return workerThreads;
}

/**
 * Worker 线程可用时什么都不做，pdf.js 用同源 boot 握手。
 * 探测失败则在主线程加载官方 worker，`globalThis.pdfjsWorker` 会让
 * pdf.js 立刻走 fake worker，避免 Opening 永远等 handshake。
 */
export async function preparePdfjsWorker(): Promise<void> {
  if (await pdfWorkerThreadsAvailable()) {
    return;
  }
  const href = officialPdfWorkerHref();
  await import(/* @vite-ignore */ href);
}
