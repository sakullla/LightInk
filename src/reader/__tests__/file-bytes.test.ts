import { describe, expect, it } from 'vitest';

import {
  MAX_BINARY_READER_BYTES,
  MAX_TEXT_READER_BYTES,
  readerByteLimitForPath,
  readerBytesFromIpc,
  ReaderFileTooLargeError,
} from '../file-bytes.js';

describe('reader file byte budgets', () => {
  it('uses the text limit for TXT and the binary limit for reader containers', () => {
    expect(readerByteLimitForPath('notes.TXT')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('/books/book.epub')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('book.pdf')).toBe(MAX_BINARY_READER_BYTES);
  });

  it('keeps dot-file text names on the text limit after wiring extOfPath', () => {
    // 回归（T3 advisory）：extOfPath 对点文件返回 ''，但历史上 `.txt` 这类点文件
    // 名按首点后的段走 32MB 文本上限——接线后不得静默落入 2GB 二进制上限。
    expect(readerByteLimitForPath('.txt')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('.md')).toBe(MAX_TEXT_READER_BYTES);
    expect(readerByteLimitForPath('C:\\books\\.markdown')).toBe(MAX_TEXT_READER_BYTES);
    // 非文本点文件与无扩展名/末尾点仍走二进制上限。
    expect(readerByteLimitForPath('.gitignore')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('notes')).toBe(MAX_BINARY_READER_BYTES);
    expect(readerByteLimitForPath('notes.')).toBe(MAX_BINARY_READER_BYTES);
  });

  it('consumes raw IPC ArrayBuffer without base64 decoding', () => {
    // T7：read_file_bytes raw IPC 直接返回字节，无 atob/逐字节解码路径。
    const raw = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    expect(readerBytesFromIpc('book.epub', raw.buffer as ArrayBuffer)).toEqual(raw);
    expect(readerBytesFromIpc('book.epub', raw)).toEqual(raw);
  });

  it('enforces the per-extension byte limit on raw IPC bytes', () => {
    const textBytes = new Uint8Array(MAX_TEXT_READER_BYTES + 1);
    expect(() => readerBytesFromIpc('notes.txt', textBytes)).toThrow(
      ReaderFileTooLargeError,
    );
    // 二进制格式仍走 2GB 上限。
    expect(readerBytesFromIpc('book.pdf', new Uint8Array(1))).toHaveLength(1);
  });
});
