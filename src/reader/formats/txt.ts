/**
 * `txt` — 纯文本解析（ebook-reader T4；T8 增加分块解析）。
 *
 * 字节经 UTF-8 解码；出现替换字符 U+FFFD（非 UTF-8）时回退 GBK，仍失败则按
 * UTF-8 原样显示（best effort）。文本按空行分段为 <p>，逐段 HTML 转义。
 * 纯逻辑、无 DOM 依赖，node 可测。
 *
 * T8：`parseTxtFromSource` 按块读取（默认 1 MiB/块）流式解码并增量冲刷段落，
 * 原始字节不整文件驻留；编码经首块前 64 KiB 嗅探（UTF-8 优先，回退 GBK）。
 * `parseTxt`（整读字节）行为保持不变。
 */

import type { ReaderByteSource, ReaderContent } from './types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { escapeHtml } from '../html-escape.js';
import { decodeReaderText, detectTextLabel } from './text-encoding.js';

/** 分块解析的块大小：原始字节峰值有界，不整文件驻留。 */
const TXT_CHUNK_BYTES = 1024 * 1024;
/** 编码嗅探窗口：取首块前 64 KiB 判定 UTF-8/GBK。 */
const TXT_SNIFF_BYTES = 64 * 1024;
/** 无空行的超长段累计上限：超出即按段冲刷，避免单段常驻整文件。 */
const TXT_MAX_PENDING_CHARS = TXT_CHUNK_BYTES;

function decodeText(bytes: Uint8Array, label: string): string {
  return decodeReaderText(bytes, label);
}

function paragraphHtml(raw: string): string | null {
  const paragraph = raw.trim();
  if (paragraph.length === 0) {
    return null;
  }
  return `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`;
}

/** 把纯文本按空行分段为单个章节的 HTML（段内换行 → <br>）。 */
function chaptersFromText(text: string): ReaderContent {
  const trimmed = text.replace(/\r\n?/g, '\n');
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const html = paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return { chapters: [{ title: '', html }] };
}

/**
 * 解析 TXT 字节为阅读内容。UTF-8 优先；非 UTF-8（含替换字符）回退 GBK；
 * GBK 不可用或仍失败时按 UTF-8 原样显示。
 */
export function parseTxt(bytes: Uint8Array): ReaderContent {
  return chaptersFromText(decodeText(bytes, detectTextLabel(bytes)));
}

export interface TxtChunkedParseOptions {
  /** 测试钩子：覆盖块大小（生产缺省 TXT_CHUNK_BYTES）。 */
  chunkBytes?: number;
}

/**
 * T8：分块读取解析 TXT。逐块流式解码（TextDecoder stream 模式处理跨块多字节
 * 字符与跨块 \r\n），空行分段的段落即满即冲刷进 parts，pending 缓冲有界；
 * 原始字节任意时刻最多驻留一块。与 parseTxt 产出同一单章结构；损坏字节按
 * best effort 替换字符处理，无新增错误路径。
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
  let pending = '';
  let previousEndedWithCR = false;

  /** 冲刷 pending 中以空行结尾的完整段落；final 时冲刷残余。超长无空行段落按上限切断。 */
  const drain = (final: boolean): void => {
    let boundary = /\n{2,}/.exec(pending);
    while (boundary !== null) {
      const html = paragraphHtml(pending.slice(0, boundary.index));
      if (html !== null) {
        parts.push(html);
      }
      pending = pending.slice(boundary.index + boundary[0].length);
      boundary = /\n{2,}/.exec(pending);
    }
    if (final || pending.length > TXT_MAX_PENDING_CHARS) {
      const html = paragraphHtml(pending);
      if (html !== null) {
        parts.push(html);
      }
      pending = '';
    }
  };
  const feed = (text: string): void => {
    let chunk = text;
    if (previousEndedWithCR && chunk.startsWith('\n')) {
      chunk = chunk.slice(1); // 跨块的 \r\n 只算一次换行
    }
    previousEndedWithCR = chunk.endsWith('\r');
    pending += chunk.replace(/\r\n?/g, '\n');
    drain(false);
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
  drain(true);
  return { chapters: [{ title: '', html: parts.join('\n') }] };
}
