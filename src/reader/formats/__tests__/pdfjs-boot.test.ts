// @vitest-environment jsdom

/**
 * pdfjs-boot 引导链路测试：真实模块导入，不 mock pdfjs-dist / pdf-worker-entry /
 * pdfjs-boot 中任何一环。只补 jsdom 缺失的平台能力（DOMMatrix、Worker），让
 * 现代 build 与 worker 探测能在 node 测试环境里走真路径。
 *
 * 环境事实（决定用例结构）：
 * - `build/pdf.mjs` 求值时自己会 `globalThis.pdfjsLib = {...}`（给 script 标签
 *   场景的导出副作用），因此挂载断言用版本一致而非对象同一；版本守卫的注入
 *   必须发生在 pdfjs-dist 已进模块缓存之后。
 * - pdfjs-dist 的 webpack 循环图在 vi.resetModules 后重求值会 TDZ
 *   （GlobalWorkerOptions before initialization），因此本文件不 resetModules；
 *   需要全新引导记忆时经带 query 的独立 URL import 一份引导模块实例，其内部
 *   `import('pdfjs-dist')` 仍命中规范 specifier 的缓存，不会重求值。
 * - 乱序反例同样经带 query 的独立 URL 求值组件层：pdfjsLib 未挂载时
 *   pdf_viewer.mjs 顶层解构直接 TypeError，且不污染规范 specifier 的缓存。
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPdfjsComponents } from '../pdfjs-boot.js';

type PdfjsGlobalScope = typeof globalThis & { pdfjsLib?: { version: string } };

function mountedPdfjsLib(): { version: string } | undefined {
  return (globalThis as PdfjsGlobalScope).pdfjsLib;
}

function deleteMountedPdfjsLib(): void {
  delete (globalThis as PdfjsGlobalScope).pdfjsLib;
}

/** pdf.mjs 模块顶层 `new DOMMatrix()`（SCALE_MATRIX）；jsdom 未实现 DOMMatrix。 */
class MinimalDOMMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
}

/**
 * jsdom 没有 Worker，preparePdfjsWorker 的探测会走 fake worker 回退并在 node 里
 * import http URL。装一个能回 ping 的最小 Worker，让探测走真路径（同源 boot 分支）。
 */
function stubResponsiveWorker(): void {
  vi.stubGlobal(
    'Worker',
    class {
      addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        if (type === 'message') {
          queueMicrotask(() => listener({ data: 1 } as MessageEvent));
        }
      }
      removeEventListener(): void {}
      terminate(): void {}
    },
  );
}

function isolatedHref(relative: string, tag: string): string {
  const file = path.resolve(process.cwd(), relative);
  return `${pathToFileURL(file).href}?${tag}`;
}

/** 带独立 query 的引导模块实例：得到一份全新的引导 promise 记忆。 */
async function importBootInstance(tag: string): Promise<typeof import('../pdfjs-boot.js')> {
  return import(/* @vite-ignore */ isolatedHref('src/reader/formats/pdfjs-boot.ts', tag));
}

describe('引导顺序（反例）', () => {
  beforeEach(() => {
    deleteMountedPdfjsLib();
    vi.stubGlobal('DOMMatrix', MinimalDOMMatrix);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pdfjsLib 未挂载时求值组件层会抛错（顺序不可调换）', async () => {
    const viewerHref = isolatedHref('node_modules/pdfjs-dist/web/pdf_viewer.mjs', 'boot-order');
    await expect(import(/* @vite-ignore */ viewerHref)).rejects.toThrow(
      /pdfjsLib|Cannot destructure/i,
    );
  });
});

describe('loadPdfjsComponents', () => {
  beforeEach(() => {
    vi.stubGlobal('DOMMatrix', MinimalDOMMatrix);
    stubResponsiveWorker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功引导：挂载 globalThis.pdfjsLib、版本一致、workerSrc 指向同源 boot、组件可构造', async () => {
    const components = await loadPdfjsComponents();
    expect(mountedPdfjsLib()).toBeDefined();
    expect(mountedPdfjsLib()?.version).toBe(components.pdfjs.version);
    expect(components.pdfjs.GlobalWorkerOptions.workerSrc).toContain('__lightink/pdf.worker');
    expect(typeof components.viewer.PDFViewer).toBe('function');
    expect(typeof components.viewer.EventBus).toBe('function');
    expect(typeof components.viewer.PDFLinkService).toBe('function');
    expect(typeof components.viewer.PDFFindController).toBe('function');
  });

  it('版本不符时抛出明确错误，恢复后可重试（反例）', async () => {
    // pdfjs-dist 已在上一个用例进入模块缓存：本次 import 不会重求值，
    // 预挂的伪实例才能存活到版本守卫。
    const boot = await importBootInstance('guard-negative');
    (globalThis as PdfjsGlobalScope).pdfjsLib = { version: '0.0.0-foreign-instance' };
    const error = await boot.loadPdfjsComponents().then(
      () => {
        throw new Error('expected the version guard to reject');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('已挂载版本');
    expect((error as Error).message).toContain('0.0.0-foreign-instance');
    // 引导失败后记忆被清空：恢复全局即可重试成功。
    deleteMountedPdfjsLib();
    await expect(boot.loadPdfjsComponents()).resolves.toBeDefined();
  });

  it('重复调用返回同一实例（不重复 import）', async () => {
    const first = await loadPdfjsComponents();
    const second = await loadPdfjsComponents();
    expect(second).toBe(first);
    const [a, b] = await Promise.all([loadPdfjsComponents(), loadPdfjsComponents()]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(mountedPdfjsLib()?.version).toBe(first.pdfjs.version);
  });

  it('并发调用复用同一引导 promise', async () => {
    const first = loadPdfjsComponents();
    const second = loadPdfjsComponents();
    expect(second).toBe(first);
    await first;
  });
});
