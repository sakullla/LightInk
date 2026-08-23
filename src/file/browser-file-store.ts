/**
 * Browser-only file store for `npm run dev` without Tauri.
 * Virtual paths (`browser-file:name.ext`) feed the existing reader load path.
 */

import { extOfPath } from './path-ext.js';
import { READER_EXTS } from './file-drop.js';

export const BROWSER_FILE_PREFIX = 'browser-file:';

const files = new Map<string, File>();

/** Test-only reset so virtual paths do not leak across cases. */
export function clearBrowserFileStore(): void {
  files.clear();
}

const BROWSER_OPEN_ACCEPT = [
  ...[...READER_EXTS].map((ext) => `.${ext}`),
  '.md',
  '.markdown',
  'application/epub+zip',
  'application/pdf',
  'text/plain',
].join(',');

export function isBrowserFilePath(path: string): boolean {
  return path.startsWith(BROWSER_FILE_PREFIX);
}

export function isTauriRuntime(
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  return win !== undefined && '__TAURI_INTERNALS__' in win;
}

export function registerBrowserFile(file: File): string {
  const base = file.name.trim() === '' ? 'book.bin' : file.name.replace(/[/\\]/g, '_');
  let path = `${BROWSER_FILE_PREFIX}${base}`;
  let suffix = 1;
  while (files.has(path) && files.get(path) !== file) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    path = `${BROWSER_FILE_PREFIX}${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  files.set(path, file);
  return path;
}

export function getBrowserFile(path: string): File | undefined {
  return files.get(path);
}

export async function readBrowserFileBytes(path: string): Promise<Uint8Array> {
  const file = files.get(path);
  if (file === undefined) {
    throw new Error(`browser file not found: ${path}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

export async function readBrowserFileChunk(
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const file = files.get(path);
  if (file === undefined) {
    throw new Error(`browser file not found: ${path}`);
  }
  const start = Math.max(0, offset);
  const end = Math.min(file.size, start + Math.max(0, length));
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

export function browserFileSize(path: string): number {
  const file = files.get(path);
  if (file === undefined) {
    throw new Error(`browser file not found: ${path}`);
  }
  return file.size;
}

export function pickBrowserFile(
  doc: Document = document,
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = BROWSER_OPEN_ACCEPT;
    input.addEventListener('change', () => {
      const file = input.files?.item(0) ?? null;
      input.remove();
      resolve(file === null ? null : registerBrowserFile(file));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    doc.body.appendChild(input);
    input.click();
  });
}

export function browserPathIsReader(path: string): boolean {
  return READER_EXTS.has(extOfPath(path));
}
