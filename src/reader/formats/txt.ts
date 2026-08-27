/**
 * `txt` — 纯文本解析（ebook-reader T4；T8 增加分块解析）。
 *
 * 字节经 UTF-8 解码；出现替换字符 U+FFFD（非 UTF-8）时回退 GBK，仍失败则按
 * UTF-8 原样显示（best effort）。解码后的纯文本交给 `splitPlainTextChapters`
 * 按唯一标题规则切章并懒物化 HTML。纯逻辑、无 DOM 依赖，node 可测。
 *
 * T8：`parseTxtFromSource` 按块读取（默认 1 MiB/块）流式解码为完整文本，
 * 原始字节不整文件驻留；编码经首块前 64 KiB 嗅探（UTF-8 优先，回退 GBK）。
 * `parseTxt`（整读字节）与分块路径共用同一切章入口。
 */

import type { ReaderByteSource, ReaderContent } from './types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { decodeReaderText, detectTextLabel } from './text-encoding.js';
import { splitPlainTextChapters } from './chapter-headings.js';

/** 分块解析的块大小：原始字节峰值有界，不整文件驻留。 */
const TXT_CHUNK_BYTES = 1024 * 1024;
/** 编码嗅探窗口：取首块前 64 KiB 判定 UTF-8/GBK。 */
const TXT_SNIFF_BYTES = 64 * 1024;

function decodeText(bytes: Uint8Array, label: string): string {
  return decodeReaderText(bytes, label);
}

/**
 * 解析 TXT 字节为阅读内容。UTF-8 优先；非 UTF-8（含替换字符）回退 GBK；
 * GBK 不可用或仍失败时按 UTF-8 原样显示。切章由 splitPlainTextChapters 负责。
 */
export function parseTxt(bytes: Uint8Array): ReaderContent {
  return splitPlainTextChapters(decodeText(bytes, detectTextLabel(bytes)));
}

export interface TxtChunkedParseOptions {
  /** 测试钩子：覆盖块大小（生产缺省 TXT_CHUNK_BYTES）。 */
  chunkBytes?: number;
}

/**
 * T8：分块读取解析 TXT。逐块流式解码（TextDecoder stream 模式处理跨块多字节
 * 字符与跨块 \r\n），解码文本拼接后交给 splitPlainTextChapters；
 * 原始字节任意时刻最多驻留一块。损坏字节按 best effort 替换字符处理，
 * 无新增错误路径。
 */
export async function parseTxtFromSource(
  source: ReaderByteSource,
  signal?: AbortSignal,
  options: TxtChunkedParseOptions = {},
): Promise<ReaderContent> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? TXT_CHUNK_BYTES);
  // 编码嗅探独立于分块读取：ReaderByteSource 随机访问，始终取文件头 64 KiB，
  // 嗅探窗口不随块大小缩水（小块场景 GBK/UTF-8 判定与整读一致）。
  const sniff = await source.read(0, TXT_SNIFF_BYTES, signal);
  throwIfReaderLoadCancelled(signal);
  const label = detectTextLabel(sniff);
  const decoder = new TextDecoder(label, { fatal: false });
  const parts: string[] = [];
  let previousEndedWithCR = false;

  const feed = (text: string): void => {
    let chunk = text;
    if (previousEndedWithCR && chunk.startsWith('\n')) {
      chunk = chunk.slice(1); // 跨块的 \r\n 只算一次换行
    }
    previousEndedWithCR = chunk.endsWith('\r');
    if (chunk.length > 0) {
      parts.push(chunk.replace(/\r\n?/g, '\n'));
    }
  };

  let offset = 0;
  while (true) {
    throwIfReaderLoadCancelled(signal);
    const chunk = await source.read(offset, chunkBytes, signal);
    throwIfReaderLoadCancelled(signal);
    offset += chunk.length;
    if (chunk.length === 0) {
      break;
    }
    feed(decoder.decode(chunk, { stream: true }));
    if (chunk.length < chunkBytes) {
      break; // 短块 = EOF
    }
  }
  feed(decoder.decode());
  return splitPlainTextChapters(parts.join(''));
}
