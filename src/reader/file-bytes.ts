import { extOfPath } from '../file/path-ext.js';
import { READER_LIMITS } from './reader-limits.js';

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt']);

export class ReaderFileTooLargeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Reader file is too large (${actualBytes} bytes; limit ${limitBytes} bytes)`);
    this.name = 'ReaderFileTooLargeError';
  }
}

export function readerByteLimitForPath(path: string): number {
  const base = path.split(/[\\/]/).pop() ?? path;
  let extension = extOfPath(path);
  if (extension === '' && base.length > 1 && base.startsWith('.') && !base.endsWith('.')) {
    // 点文件（如 `.txt`）：保留接线 extOfPath 前的历史语义——首点后的段仍按扩展名
    // 参与上限判定，点文件命名的文本文件不因此从 32MB 文本上限落入 2GB 二进制上限。
    extension = base.slice(1).toLowerCase();
  }
  return TEXT_EXTENSIONS.has(extension)
    ? READER_LIMITS.maxTextReaderBytes
    : READER_LIMITS.maxBinaryReaderBytes;
}

/**
 * 校验并归一 raw IPC 字节（T7）：`read_file_bytes` 经 tauri raw IPC 返回，JS 侧
 * 直接获得 ArrayBuffer/Uint8Array，不再有 base64 字符串与 atob 逐字节解码。
 * 上限校验保留为前端防御（Rust 侧已在分配前拒绝超限文件），错误语义不变。
 */
export function readerBytesFromIpc(
  path: string,
  data: ArrayBuffer | Uint8Array,
): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const limitBytes = readerByteLimitForPath(path);
  if (bytes.byteLength > limitBytes) {
    throw new ReaderFileTooLargeError(bytes.byteLength, limitBytes);
  }
  return bytes;
}

/**
 * 校验并归一分块读取响应（T8 txt 分块解析）：`read_file_bytes` 带 offset/length
 * 经 raw IPC 返回窗口字节，响应不得超过请求长度（Rust 侧已按 seek+take 保证，
 * 此为前端防御）；整文件大小上限由 Rust 侧在 stat 时强制执行，错误语义不变。
 */
export function readerChunkFromIpc(
  data: ArrayBuffer | Uint8Array,
  requestedBytes: number,
): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > requestedBytes) {
    throw new Error(
      `Reader chunk is too large (${bytes.byteLength} bytes; requested ${requestedBytes} bytes)`,
    );
  }
  return bytes;
}
