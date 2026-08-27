import { describe, expect, it } from 'vitest';

import {
  readerByteLimitForPath,
  readerBytesFromIpc,
  ReaderFileTooLargeError,
} from '../file-bytes.js';
import { injectReaderLimit, READER_LIMITS } from '../reader-limits.js';

describe('reader file byte budgets', () => {
  it('uses the text limit for TXT and the binary limit for reader containers', () => {
    expect(readerByteLimitForPath('notes.TXT')).toBe(READER_LIMITS.maxTextReaderBytes);
    expect(readerByteLimitForPath('/books/book.epub')).toBe(READER_LIMITS.maxBinaryReaderBytes);
    expect(readerByteLimitForPath('book.pdf')).toBe(READER_LIMITS.maxBinaryReaderBytes);
  });

  it('keeps dot-file text names on the text limit after wiring extOfPath', () => {
    // 回归（T3 advisory）：extOfPath 对点文件返回 ''，但历史上 `.txt` 这类点文件
    // 名按首点后的段走 32MB 文本上限——接线后不得静默落入 2GB 二进制上限。
    expect(readerByteLimitForPath('.txt')).toBe(READER_LIMITS.maxTextReaderBytes);
    expect(readerByteLimitForPath('.md')).toBe(READER_LIMITS.maxTextReaderBytes);
    expect(readerByteLimitForPath('C:\\books\\.markdown')).toBe(READER_LIMITS.maxTextReaderBytes);
    // 非文本点文件与无扩展名/末尾点仍走二进制上限。
    expect(readerByteLimitForPath('.gitignore')).toBe(READER_LIMITS.maxBinaryReaderBytes);
    expect(readerByteLimitForPath('notes')).toBe(READER_LIMITS.maxBinaryReaderBytes);
    expect(readerByteLimitForPath('notes.')).toBe(READER_LIMITS.maxBinaryReaderBytes);
  });

  it('consumes raw IPC ArrayBuffer without base64 decoding', () => {
    // T7：read_file_bytes raw IPC 直接返回字节，无 atob/逐字节解码路径。
    const raw = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    expect(readerBytesFromIpc('book.epub', raw.buffer as ArrayBuffer)).toEqual(raw);
    expect(readerBytesFromIpc('book.epub', raw)).toEqual(raw);
  });

  it('enforces the per-extension byte limit on raw IPC bytes', () => {
    const textBytes = new Uint8Array(READER_LIMITS.maxTextReaderBytes + 1);
    expect(() => readerBytesFromIpc('notes.txt', textBytes)).toThrow(
      ReaderFileTooLargeError,
    );
    // 二进制格式仍走 2GB 上限。
    expect(readerBytesFromIpc('book.pdf', new Uint8Array(1))).toHaveLength(1);
  });

  it('注册表单项收紧后整读上限同步收紧，错误带新限值（传播探针）', () => {
    // shared-utils：限额唯一事实源在注册表——改一处，file-bytes 的文本/二进制
    // 上限同步跟随，拒绝路径错误种类不变（ReaderFileTooLargeError），不静默放行。
    const restore = injectReaderLimit('maxTextReaderBytes', 3);
    try {
      expect(readerByteLimitForPath('notes.txt')).toBe(3);
      // 二进制上限不受单项调整影响。
      expect(readerByteLimitForPath('book.epub')).toBe(READER_LIMITS.maxBinaryReaderBytes);
      expect(() => readerBytesFromIpc('notes.txt', new Uint8Array(4))).toThrow(
        expect.objectContaining<Partial<ReaderFileTooLargeError>>({
          limitBytes: 3,
          actualBytes: 4,
        }),
      );
      // 未超新限值的输入照常通过。
      expect(readerBytesFromIpc('notes.txt', new Uint8Array(3))).toHaveLength(3);
    } finally {
      restore();
    }
    // 恢复后回到产品缺省值。
    expect(readerByteLimitForPath('notes.txt')).toBe(READER_LIMITS.maxTextReaderBytes);
  });

  it('publishes the product whole-read budgets from the registry', () => {
    expect(READER_LIMITS.maxTextReaderBytes).toBe(32 * 1024 * 1024);
    expect(READER_LIMITS.maxBinaryReaderBytes).toBe(2 * 1024 * 1024 * 1024);
  });
});
