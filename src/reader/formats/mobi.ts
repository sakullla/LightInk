/**
 * `mobi` — MOBI/PalmDOC 解析（ebook-reader T4）。
 *
 * 解包 PalmDB（PDB 头 + 记录索引），读 record 0 的 PalmDOC 头得到压缩方式、正文
 * 总长、文本记录数与加密标志；DRM（encryption≠0）立即报错。按记录拼装正文字节，
 * PalmDOC LZ77（compression==2）逐记录解压；无压缩（==1）原样。正文为 HTML，
 * 按 <mbp:pagebreak/> 切章并消毒。仅支持无 DRM 的经典 PalmDOC MOBI；KF8/MOBI8
 * 复杂版式与 HUFF/CDIC 压缩不在本任务范围（遇 HUFF 报错）。
 *
 * 纯二进制 + 字符串实现，node 可测（测试合成最小 PalmDOC MOBI）。
 *
 * 正文解码经 text-encoding 的共享 decodeReaderText；label 由 MOBI codepage 声明
 * （65001→UTF-8，其余→windows-1252），不参与编码嗅探。
 */

import { sanitizeHtml } from '../sanitize.js';
import { decodeReaderText } from './text-encoding.js';
import {
  ParseError,
  ReaderCapabilityError,
  type ReaderContent,
} from './types.js';

function be16(dv: DataView, off: number): number {
  return dv.getUint16(off, false);
}
function be32(dv: DataView, off: number): number {
  return dv.getUint32(off, false);
}

/** PalmDOC LZ77 解压（每条文本记录独立压缩，窗口随记录重置）。 */
function palmDocDecompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i++]!;
    if (c === 0) {
      // 字面转义：拷贝下一字节（用于无法作单字节字面量的字节）。
      if (i < input.length) {
        out.push(input[i++]!);
      }
    } else if (c <= 8) {
      // 复制随后 c 字节字面量。
      for (let k = 0; k < c && i < input.length; k++) {
        out.push(input[i++]!);
      }
    } else if (c <= 0x7f) {
      // 单字节字面量。
      out.push(c);
    } else if (c <= 0xbf) {
      // 两字节回引：length 3 位 + distance 11 位（distance 编码为 0 基，解码 +1）。
      const d = i < input.length ? input[i++]! : 0;
      const count = (c & 0x07) + 3;
      const distance = (((c >> 3) & 0x07) << 8) + d + 1;
      for (let k = 0; k < count; k++) {
        const src = out.length - distance;
        out.push(src >= 0 && src < out.length ? (out[src] ?? 0) : 0);
      }
    } else {
      // 0xc0-0xff：空格 + (c & 0x7f)。
      out.push(0x20, c & 0x7f);
    }
  }
  return Uint8Array.from(out);
}

/** 取首块 HTML 的首个 <h1>/<h2> 文本作标题（无则空串）。 */
function firstHeadingOrEmpty(html: string): string {
  const m = html.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i);
  return m && m[1] !== undefined ? m[1].replace(/<[^>]+>/g, '').trim() : '';
}

/**
 * 解析 MOBI 字节为章节化阅读内容。DRM/HUFF/损坏抛 ParseError。
 */
export function parseMobi(bytes: Uint8Array): ReaderContent {
  if (bytes.length < 78) {
    throw new ParseError('MOBI 文件过小，不是有效的 PalmDB 文件');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const numRecords = be16(dv, 76);
  if (numRecords < 1 || 78 + numRecords * 8 > bytes.length) {
    throw new ParseError('MOBI 文件损坏：记录索引越界');
  }

  // 记录偏移索引（每条 8 字节：offset 4 + attrib 1 + uniqueID 3）。
  const recordOffsets: number[] = [];
  for (let r = 0; r < numRecords; r++) {
    recordOffsets.push(be32(dv, 78 + r * 8));
  }
  recordOffsets.push(bytes.length); // 末记录结束边界兜底

  const rec0Start = recordOffsets[0]!;
  const rec0End = recordOffsets[1] ?? bytes.length;
  const rec0 = bytes.subarray(rec0Start, rec0End);
  if (rec0.length < 16) {
    throw new ParseError('MOBI 记录 0 过小，缺少 PalmDOC 头');
  }
  const r0 = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);

  const compression = be16(r0, 0);
  const textLength = be32(r0, 4);
  const recordCount = be16(r0, 8);
  const encryption = be16(r0, 12);

  if (encryption !== 0) {
    throw new ReaderCapabilityError('mobiDrm');
  }
  if (compression !== 1 && compression !== 2) {
    // 17480 = HUFF/CDIC（复杂字典压缩），本任务不支持。
    throw new ReaderCapabilityError('mobiHuff');
  }

  // 编码：MOBI header（若有）的 codepage，否则 cp1252。
  let codepage = 1252;
  const isMobi =
    rec0.length >= 20 &&
    rec0[16] === 0x4d /* M */ &&
    rec0[17] === 0x4f /* O */ &&
    rec0[18] === 0x42 /* B */ &&
    rec0[19] === 0x49; /* I */
  if (isMobi && rec0.length >= 32) {
    const cp = be32(r0, 28);
    if (cp === 65001) {
      codepage = 65001;
    }
    // MOBI header fileVersion >= 8 denotes KF8/MOBI8, which this PalmDOC parser cannot decode.
    if (rec0.length >= 40 && be32(r0, 36) >= 8) {
      throw new ReaderCapabilityError('mobiKf8');
    }
  }

  // 拼接文本记录（1..recordCount）。
  const n = Math.min(recordCount, numRecords - 1);
  const textBytes: number[] = [];
  for (let r = 0; r < n; r++) {
    const start = recordOffsets[r + 1]!;
    const end = recordOffsets[r + 2] ?? bytes.length;
    const rec = bytes.subarray(start, end);
    const decoded = compression === 2 ? palmDocDecompress(rec) : rec;
    for (let k = 0; k < decoded.length; k++) {
      textBytes.push(decoded[k]!);
    }
    if (textLength > 0 && textBytes.length >= textLength) {
      break;
    }
  }
  const limit = textLength > 0 ? textLength : textBytes.length;
  const full = Uint8Array.from(textBytes.slice(0, limit));
  // codepage→label 决策留在 mobi 解析内；以声明 label 调用共享 decode（不参与
  // 嗅探，嗅探顺序调整不影响 mobi 输出）。运行时缺该 label 时共享 decode 按
  // UTF-8 尽力显示。
  const html = decodeReaderText(full, codepage === 65001 ? 'utf-8' : 'windows-1252');

  // 按 <mbp:pagebreak/>（MOBI 分页符）切章；无则整篇一章。
  const pieces = html.split(/<mbp:pagebreak\s*\/?>/i);
  const chapters: ReaderContent['chapters'] = [];
  pieces.forEach((piece, idx) => {
    const body = sanitizeHtml(piece);
    if (body.trim().length === 0) {
      return;
    }
    const title = idx === 0 ? firstHeadingOrEmpty(piece) : `Section ${idx + 1}`;
    chapters.push({ title, html: body });
  });

  if (chapters.length === 0) {
    throw new ParseError('MOBI 未提取到正文内容');
  }
  return { chapters };
}
