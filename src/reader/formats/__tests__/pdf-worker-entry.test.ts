// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PDF_WORKER_BOOT_DEV_PATH,
  PDF_WORKER_DEV_PATH,
  PDF_WORKER_OFFICIAL_SPECIFIER,
  pdfWorkerBootModule,
  pdfWorkerSrc,
  pdfWorkerThreadsAvailable,
  resetPdfWorkerThreadProbe,
} from '../pdf-worker-entry.js';

describe('pdfWorkerBootModule', () => {
  it('polyfills upsert then imports the official worker and boots if needed', () => {
    const source = pdfWorkerBootModule(PDF_WORKER_OFFICIAL_SPECIFIER);
    expect(source).toContain('getOrInsertComputed');
    expect(source).toContain(`await import("${PDF_WORKER_OFFICIAL_SPECIFIER}")`);
    expect(source).toContain('WorkerMessageHandler.initializeFromPort(self)');
    expect(source).toContain('typeof self.onmessage !== "function"');
    expect(source).toContain('export { WorkerMessageHandler }');
  });
});

describe('pdfWorkerSrc', () => {
  it('points at the same-origin boot URL', () => {
    expect(pdfWorkerSrc()).toBe(new URL(PDF_WORKER_BOOT_DEV_PATH, globalThis.location.href).href);
    expect(PDF_WORKER_DEV_PATH).toBe('/__lightink/pdf.worker.min.mjs');
  });
});

describe('pdfWorkerThreadsAvailable', () => {
  afterEach(() => {
    resetPdfWorkerThreadProbe();
    vi.unstubAllGlobals();
  });

  it('is true when a classic Worker can postMessage', async () => {
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
    await expect(pdfWorkerThreadsAvailable()).resolves.toBe(true);
  });

  it('is false when the Worker never messages', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        addEventListener(): void {}
        removeEventListener(): void {}
        terminate(): void {}
      },
    );
    await expect(pdfWorkerThreadsAvailable(5)).resolves.toBe(false);
  });
});

describe('vite pdf worker static plugin', () => {
  it('serves the untransformed official worker and the boot module', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const config = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf-8');
    expect(config).toContain('PDF_WORKER_BOOT_DEV_PATH');
    expect(config).toContain('pdfWorkerBootModule');
    expect(config).toContain('generateBundle');
  });
});
