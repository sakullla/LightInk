/**
 * `reader-limits` — 阅读器资源限额唯一注册表（R4 单点化）。
 *
 * 图字节/图片 MIME、pdf/cbz 页数、归档条目与大小、整读上限、ComicInfo 字节、
 * epub 远程样式数全部在这里单点定义；formats 与 reader 各处不得再声明局部
 * 限额常量，消费方必须在读取点访问 `READER_LIMITS` 属性（不得解构固化数值）。
 * 生产数值冻结：调整数值与错误种类（ReaderLimitError kind /
 * ReaderFileTooLargeError）保持重构前语义；`injectReaderLimit` 仅供测试注入
 * 单项限额验证传播（对齐 text-encoding 的注入钩子模式）。
 */

import { ReaderLimitError } from './formats/types.js';

/** 阅读器资源限额注册表：每项预算恰好一个条目。 */
export interface ReaderLimits {
  /** 单张包内/内嵌图片解压后字节上限（EPUB manifest 校验、FB2 binary 解码）。 */
  readonly maxImageBytes: number;
  /** 允许物化的图片 MIME 集合（EPUB/FB2/封面提取共用）。 */
  readonly safeImageMimeTypes: ReadonlySet<string>;
  /** 消毒后保留的 publisher CSS 总字节上限（EPUB 样式表选取与消毒截断共用）。 */
  readonly maxCssBytes: number;
  /** 远程 EPUB 首次加载最多合并的样式表数。 */
  readonly epubRemoteMaxStylesheets: number;
  /** PDF 页数上限。 */
  readonly maxPdfPages: number;
  /** 漫画归档页数上限。 */
  readonly maxCbzPages: number;
  /** 归档条目数上限（zip central-directory 预算）。 */
  readonly maxArchiveEntries: number;
  /** 归档解压后总字节上限。 */
  readonly maxArchiveTotalUncompressedBytes: number;
  /** 单个归档条目解压后字节上限。 */
  readonly maxArchiveEntryUncompressedBytes: number;
  /** 归档压缩比上限（zip 炸弹防御）。 */
  readonly maxArchiveCompressionRatio: number;
  /** 整读文本文件字节上限（raw IPC 前端防御）。 */
  readonly maxTextReaderBytes: number;
  /** 整读二进制容器字节上限（raw IPC 前端防御）。 */
  readonly maxBinaryReaderBytes: number;
  /** ComicInfo.xml 条目字节上限（超限跳过元数据，现行语义）。 */
  readonly maxComicInfoBytes: number;
}

export const READER_LIMITS: ReaderLimits = {
  maxImageBytes: 32 * 1024 * 1024,
  safeImageMimeTypes: new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ]),
  maxCssBytes: 256 * 1024,
  epubRemoteMaxStylesheets: 2,
  maxPdfPages: 10_000,
  maxCbzPages: 5_000,
  maxArchiveEntries: 5_000,
  maxArchiveTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveEntryUncompressedBytes: 64 * 1024 * 1024,
  maxArchiveCompressionRatio: 200,
  maxTextReaderBytes: 32 * 1024 * 1024,
  maxBinaryReaderBytes: 2 * 1024 * 1024 * 1024,
  maxComicInfoBytes: 1024 * 1024,
};

export type PageFormat = 'pdf' | 'cbz';

/** Reject page collections before allocating slots or decoding page bodies. */
export function enforcePageCount(format: PageFormat, pageCount: number): void {
  const limit = format === 'pdf' ? READER_LIMITS.maxPdfPages : READER_LIMITS.maxCbzPages;
  if (pageCount > limit) {
    throw new ReaderLimitError(format === 'pdf' ? 'pdfPages' : 'cbzPages', pageCount, limit);
  }
}

/**
 * 测试钩子：临时覆盖注册表单项并返回恢复函数（生产代码不得调用）。
 * 覆盖即时对全部在读取点访问注册表的消费方生效，用于验证单项限额传播。
 */
export function injectReaderLimit<K extends keyof ReaderLimits>(
  key: K,
  value: ReaderLimits[K],
): () => void {
  const previous = READER_LIMITS[key];
  (READER_LIMITS as Record<K, unknown>)[key] = value;
  return () => {
    (READER_LIMITS as Record<K, unknown>)[key] = previous;
  };
}
