/**
 * 流式阅读内容模型（ebook-reader T4）。
 *
 * EPUB/MOBI/FB2/TXT 解析器统一产出 `ReaderContent`（章节化 HTML），由 reader-view
 * 渲染到滚动宿主。HTML 经 `sanitizeHtml` 消毒后再放入 chapters[].html。
 */

/** 单个阅读章节。 */
export interface ReaderChapter {
  /** 章节标题（可为空，渲染时回退到序号）。 */
  title: string;
  /** 已消毒的章节正文 HTML。 */
  html: string;
  /**
   * Materialize a deferred chapter. Large EPUBs keep non-visible spine items
   * compressed until the renderer, search, or export path needs them.
   * Implementations update `title` and `html` before resolving and are idempotent.
   */
  load?: () => Promise<void>;
  /**
   * 懒物化章节引用的打包资源（T8，如 EPUB 包内图片）：渲染方在章节帧进入
   * 视口/就绪时调用，把占位 src（包内路径）换成物化的 blob URL。幂等。
   */
  resolveResources?: (doc: Document) => Promise<void>;
  /**
   * 与 resolveResources 配对：渲染方在章节离屏/卸载时调用，src 还原为包内
   * 路径并按引用计数 revokeObjectURL。幂等。
   */
  releaseResources?: (doc: Document) => void;
}

/**
 * 分块字节源（T8 txt 分块解析）：读取 [offset, offset+length) 窗口；读取方
 * 必须尽量填满 length，短块（含空块）表示 EOF。整文件不驻留内存。
 */
export interface ReaderByteSource {
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** 按阅读顺序的章节集合。 */
export interface ReaderContent {
  chapters: ReaderChapter[];
  /** Sanitized publisher CSS, injected into the chapter frame before reader chrome styles. */
  stylesheet?: string;
  /** Non-fatal fidelity limitations that should be shown once after load. */
  warnings?: readonly ReaderWarningKind[];
  /** Release parser-owned blob/object URLs. Idempotent when provided. */
  dispose?: () => void;
  /**
   * 导出用图片解析：把章节 HTML 中的包内路径换成可打印 src。
   * `inline` 写 data URI（独立 HTML）；`blob` 复用/补物化 blob URL（PDF 打印，避免整本 base64 撑爆 WebView）。
   */
  embedExportImages?: (
    html: string,
    mode?: 'inline' | 'blob',
  ) => Promise<{ html: string; missing: readonly string[] }>;
}

export type ReaderWarningKind = 'epubStylesIgnored';

/** 格式解析失败（DRM、损坏、不支持）。携带可向用户展示的原因。 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export type ReaderLimitKind =
  | 'archiveEntries'
  | 'archiveTotalBytes'
  | 'archiveEntryBytes'
  | 'archiveCompressionRatio'
  | 'readerImageBytes'
  | 'pdfPages'
  | 'cbzPages';

/** Structured reader budget failure, localized only at the application boundary. */
export class ReaderLimitError extends ParseError {
  constructor(
    readonly kind: ReaderLimitKind,
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`READER_LIMIT:${kind}:${actual}:${limit}`);
    this.name = 'ReaderLimitError';
  }
}

export type ReaderCapabilityKind = 'mobiDrm' | 'mobiKf8' | 'mobiHuff';

/** Known format variant that LightInk intentionally does not claim to support. */
export class ReaderCapabilityError extends ParseError {
  constructor(readonly kind: ReaderCapabilityKind) {
    super(`READER_CAPABILITY:${kind}`);
    this.name = 'ReaderCapabilityError';
  }
}
