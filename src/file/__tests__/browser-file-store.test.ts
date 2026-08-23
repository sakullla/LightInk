// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_FILE_PREFIX,
  browserFileSize,
  clearBrowserFileStore,
  isBrowserFilePath,
  isTauriRuntime,
  readBrowserFileBytes,
  readBrowserFileChunk,
  registerBrowserFile,
} from '../browser-file-store.js';

describe('browser file store', () => {
  beforeEach(() => {
    clearBrowserFileStore();
  });
  it('registers a file under a virtual path and reads bytes and chunks', async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'demo.epub');
    const path = registerBrowserFile(file);
    expect(path).toBe(`${BROWSER_FILE_PREFIX}demo.epub`);
    expect(isBrowserFilePath(path)).toBe(true);
    expect(browserFileSize(path)).toBe(5);
    await expect(readBrowserFileBytes(path)).resolves.toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(readBrowserFileChunk(path, 1, 2)).resolves.toEqual(new Uint8Array([2, 3]));
  });

  it('disambiguates colliding file names', () => {
    const first = registerBrowserFile(new File(['a'], 'same.txt'));
    const second = registerBrowserFile(new File(['b'], 'same.txt'));
    expect(first).toBe(`${BROWSER_FILE_PREFIX}same.txt`);
    expect(second).toBe(`${BROWSER_FILE_PREFIX}same-1.txt`);
  });

  it('treats a page without Tauri internals as a browser runtime', () => {
    expect(isTauriRuntime(window)).toBe(false);
    const native = { __TAURI_INTERNALS__: {} } as unknown as Window;
    expect(isTauriRuntime(native)).toBe(true);
  });
});
