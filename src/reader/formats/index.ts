/**
 * 流式格式调度（ebook-reader T4）。
 *
 * 按扩展名分发到对应解析器。各解析器经动态 import 懒加载（EPUB 的 jszip 在
 * epub.ts 内动态引入），首屏 bundle 不含格式解析实现。
 */

import { parseEpub } from './epub.js';
import { parseFb2 } from './fb2.js';
import { parseMobi } from './mobi.js';
import { parseTxt, parseTxtFromSource } from './txt.js';
import { ParseError, type ReaderByteSource, type ReaderContent } from './types.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { extOfPath } from '../../file/path-ext.js';
import { isRandomAccessSource, type RandomAccessSource } from '../sources/types.js';

/** epub/mobi/fb2 保持整读；只有 txt 走分块字节源（T8）。 */
export type ReaderInputSource = Uint8Array | ReaderByteSource | RandomAccessSource;

function isReaderByteSource(source: ReaderInputSource): source is ReaderByteSource {
  // 结构化判定：跨 realm（jsdom/node）Uint8Array instanceof 不可靠。
  return typeof (source as ReaderByteSource).read === 'function';
}

function requireBytes(source: ReaderInputSource, ext: string): Uint8Array {
  if (!isReaderByteSource(source) && !isRandomAccessSource(source)) {
    return source;
  }
  throw new ParseError(`内部错误：.${ext} 解析需要整读字节`);
}

/**
 * 按文件扩展名解析字节为章节化阅读内容。
 * txt 传入 ReaderByteSource 时按块读取解析（不整文件驻留）；epub/mobi/fb2
 * 维持整读；MOBI 仅支持明确检测过的 PalmDOC/MOBI6 子集。
 * 不支持的扩展名抛 ParseError。
 */
export async function parseReaderContent(
  path: string,
  source: ReaderInputSource,
  signal?: AbortSignal,
): Promise<ReaderContent> {
  throwIfReaderLoadCancelled(signal);
  const ext = extOfPath(path);
  let content: ReaderContent;
  switch (ext) {
    case 'txt':
      if (isRandomAccessSource(source)) {
        content = await parseTxtFromSource(
          { read: (offset, length, readSignal) => source.readRange(offset, length, readSignal) },
          signal,
        );
      } else {
        content = isReaderByteSource(source)
          ? await parseTxtFromSource(source, signal)
          : parseTxt(source);
      }
      break;
    case 'fb2':
      content = parseFb2(requireBytes(source, ext));
      break;
    case 'epub':
      content = await parseEpub(
        isRandomAccessSource(source) ? source : requireBytes(source, ext),
        signal,
      );
      break;
    case 'mobi':
      content = parseMobi(requireBytes(source, ext));
      break;
    default:
      throw new ParseError(`暂不支持的阅读格式：.${ext || '?'}`);
  }
  throwIfReaderLoadCancelled(signal);
  return content;
}
