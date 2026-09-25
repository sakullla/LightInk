/**
 * `library-content` — 库作用域只读内容服务（ADR-5 / R5）。
 *
 * 助手要回答「《A》第一章讲了什么」，必须在不打开书、不写书库的前提下定位任意
 * 已入库书籍并读取元数据、目录与指定章节正文。本模块把这条读取链收在一个
 * surface 无关的服务里：
 *
 * - 定位：按书名或作者匹配 `library_items`；同名多本返回 candidates，不猜测。
 * - 元数据：`library_items` 为权威；仅当书名/作者缺失时才读 EPUB 包补缺口
 *   （读正文的路径永远不重复解析元数据）。
 * - 目录/正文：流式格式复用 `parseReaderContent`（txt/fb2/epub/mobi）与惰性
 *   `chapter.load()`，PDF 走 `openPdfTextDocument` 无头文本，CBZ 只提供页目录。
 * - 不可读：远程且正文不在本机、加密 PDF/密码归档、不支持格式、损坏文件全部
 *   返回结构化错误码；读取不触发下载、不写盘、不产生任何书库副作用。远程条目
 *   （opds/remote/webdav）一律不尝试远程打开——前端无法区分后端稀疏缓存是否
 *   完整，保守返回 `not_cached`，下载建议由工具层承接（R8）。
 * - 超长正文按 `maxAssistantContextChars` 截断并标注 `truncated`。
 *
 * 内容后端（解析器 / PDF 无头 / 归档）经 `LibraryContentDeps` 注入：生产默认走
 * 动态 import，测试可注入替身，不 mock 重模块。
 */

import { invoke } from '@tauri-apps/api/core';

import { extOfPath } from '../file/path-ext.js';
import type { LibraryItem, ManagedItemLocation } from '../library/library-client.js';
import { libraryClient } from '../library/library-client.js';
import { readerBytesFromIpc, readerChunkFromIpc } from '../reader/file-bytes.js';
import { ReaderLimitError, type ReaderContent } from '../reader/formats/types.js';
import { outlineFromEntries } from '../reader/outline.js';
import type { OutlineItem } from '../outline/outline-model.js';
import { READER_LIMITS } from '../reader/reader-limits.js';
import { htmlToSearchText } from '../reader/search-panel.js';
import type { ArchiveProvider, RandomAccessSource } from '../reader/sources/types.js';

/** 支持读取正文的格式；pdf 走无头文本、cbz 只出页目录。 */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  'pdf',
  'epub',
  'txt',
  'fb2',
  'mobi',
  'cbz',
]);

/** 结构化不可读原因：工具层据此给出下载/换书建议，不靠错误文案猜。 */
export type LibraryContentErrorCode =
  | 'invalid_query'
  | 'not_found'
  | 'ambiguous'
  | 'not_cached'
  | 'unsupported_format'
  | 'encrypted'
  | 'unreadable'
  | 'missing_chapter'
  | 'chapter_not_found'
  | 'ambiguous_chapter'
  | 'no_text';

/** 按书名/作者定位时的查询条件；两者至少一个非空。 */
export interface LibraryBookLookup {
  readonly title?: string;
  readonly author?: string;
}

/** 单本候选：定位结果与歧义错误共用同一形状。 */
export interface LibraryBookCandidate {
  readonly itemId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly format: string;
}

/**
 * 目标书：字符串按书名处理；对象给 `itemId` 时精确命中，否则按 `title`/`author`
 * 组合查找。
 */
export type LibraryContentTarget =
  | string
  | { readonly itemId?: string; readonly title?: string; readonly author?: string };

/** 正文定位：章序号（0-based）或标题；PDF/CBZ 另有 1-based 页码。 */
export interface LibraryChapterTarget {
  readonly chapter?: number;
  readonly page?: number;
  readonly title?: string;
}

export interface LibraryOutlineEntry {
  readonly level: number;
  readonly text: string;
  readonly chapter?: number;
  readonly page?: number;
}

export interface LibraryContentFailure {
  readonly ok: false;
  readonly error: LibraryContentErrorCode;
  /** 面向模型/用户的短说明（含不可读原因）。 */
  readonly message: string;
  /** 书名/作者定位歧义时的候选列表。 */
  readonly candidates?: readonly LibraryBookCandidate[];
  /** 章节标题歧义时的目录候选。 */
  readonly chapters?: readonly LibraryOutlineEntry[];
}

export interface LibraryBookLookupResult {
  readonly ok: true;
  readonly candidates: readonly LibraryBookCandidate[];
}

export interface LibraryMetadataResult extends LibraryBookCandidate {
  readonly ok: true;
  readonly sourceKind: LibraryItem['sourceKind'];
  readonly availability?: LibraryItem['availability'];
  readonly series?: string;
  readonly number?: string;
  readonly volume?: string;
  readonly pageCount?: number;
  readonly subjects: readonly string[];
  /** 正文是否在本机可读；false 表示需先下载/重新定位（本服务绝不代下载）。 */
  readonly bodyAvailable: boolean;
}

export interface LibraryOutlineResult {
  readonly ok: true;
  readonly items: readonly LibraryOutlineEntry[];
}

export interface LibraryChapterResult {
  readonly ok: true;
  readonly text: string;
  readonly truncated: boolean;
  readonly title?: string;
  readonly chapter?: number;
  readonly page?: number;
  /** 正文为空时的原因（如 `no_text`）。 */
  readonly reason?: string;
}

/** pdf.ts 无头文本句柄的最小结构依赖（不静态拉入渲染模块）。 */
export interface LibraryPdfTextSource {
  readonly pageCount: number;
  outline(): Promise<readonly OutlineItem[]>;
  pageText(page: number): Promise<string>;
  destroy(): Promise<void>;
}

export interface LibraryLocalBookMeta {
  readonly title?: string;
  readonly authors: readonly string[];
}

/** 流式格式解析请求：整读需求由实现按格式决定（txt/epub 走随机源）。 */
export interface LibraryFlowParseRequest {
  readonly path: string;
  readonly format: string;
  readonly source: RandomAccessSource;
  /** 本机正文整读（fb2/mobi 需要）；实现不调用则不整读。 */
  readonly readBytes: () => Promise<Uint8Array>;
}

export interface LibraryContentDeps {
  /** 库内全部条目（默认 `libraryClient.listItems`）。 */
  readonly listItems: () => Promise<readonly LibraryItem[]>;
  /** 条目正文位置（默认 `libraryClient.materializeItem`；只返回本机路径，不下载）。 */
  readonly materializeItem: (itemId: string) => Promise<ManagedItemLocation>;
  /** 本机正文随机访问源（默认 `reader_file_size` + `read_file_bytes` 区间读）。 */
  readonly openSource: (path: string) => Promise<RandomAccessSource>;
  /** 本机正文整读（默认 `read_file_bytes` +前端限额校验）。 */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  /** 流式格式解析（默认 `parseReaderContent`）；测试注入。 */
  readonly parseFlow?: (
    request: LibraryFlowParseRequest,
    signal?: AbortSignal,
  ) => Promise<ReaderContent>;
  /** PDF 无头文本（默认 `openPdfTextDocument`）；测试注入。 */
  readonly openPdf?: (
    source: RandomAccessSource,
    signal?: AbortSignal,
  ) => Promise<LibraryPdfTextSource>;
  /** CBZ 归档（默认 `openSafeArchive(..., 'CBZ')`）；测试注入。 */
  readonly openArchive?: (
    source: RandomAccessSource,
    signal?: AbortSignal,
  ) => Promise<ArchiveProvider>;
  /** EPUB 包元数据补缺口（默认 `extractLocalBookMeta`）；测试注入。 */
  readonly readLocalBookMeta?: (
    path: string,
    source: RandomAccessSource,
  ) => Promise<LibraryLocalBookMeta>;
}

export interface LibraryContentService {
  /**
   * 按书名/作者检索候选；查询条件为空返回 `invalid_query`。检索是纯查询：
   * 无匹配返回空 `candidates`，不折算成错误；单目标操作（metadata/outline/
   * chapter）才把多本/零本折算成 ambiguous/not_found。
   */
  locate(query: LibraryBookLookup): Promise<LibraryBookLookupResult | LibraryContentFailure>;
  /** 元数据（库内行为准，必要时从 EPUB 包补缺口）；不读正文。 */
  metadata(target: LibraryContentTarget): Promise<LibraryMetadataResult | LibraryContentFailure>;
  /** 目录：PDF 书签、CBZ 页序、流式格式章节。 */
  outline(target: LibraryContentTarget): Promise<LibraryOutlineResult | LibraryContentFailure>;
  /** 指定章/页正文；超长按上限截断并标注。 */
  chapter(
    target: LibraryContentTarget,
    chapterTarget: LibraryChapterTarget,
  ): Promise<LibraryChapterResult | LibraryContentFailure>;
}

export function formatOf(item: LibraryItem): string {
  const extension = (item.extension ?? '').trim().toLowerCase();
  if (extension !== '') {
    return extension;
  }
  if (item.localPath != null && item.localPath !== '') {
    return extOfPath(item.localPath);
  }
  if (item.acquisitionUrl != null && item.acquisitionUrl !== '') {
    return extOfPath(item.acquisitionUrl);
  }
  return '';
}

function hasLocalBody(item: LibraryItem): boolean {
  return item.sourceKind === 'local' || item.sourceKind === 'managed';
}

function bodyAvailable(item: LibraryItem): boolean {
  if (item.sourceKind === 'local') {
    return item.localPath != null && item.localPath !== '';
  }
  if (item.sourceKind !== 'managed') {
    return false;
  }
  return (
    item.localPath != null && item.localPath !== '' && item.availability === 'local'
  );
}

function candidateOf(item: LibraryItem): LibraryBookCandidate {
  return {
    itemId: item.id,
    title: item.title,
    authors: [...item.authors],
    format: formatOf(item),
  };
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function filterByTitle(items: readonly LibraryItem[], raw: string): LibraryItem[] {
  const needle = normalizeTitle(raw);
  if (needle === '') {
    return [];
  }
  const exact = items.filter((item) => normalizeTitle(item.title) === needle);
  if (exact.length > 0) {
    return exact;
  }
  return items.filter((item) => normalizeTitle(item.title).includes(needle));
}

function filterByAuthor(items: readonly LibraryItem[], raw: string): LibraryItem[] {
  const needle = normalizeTitle(raw);
  if (needle === '') {
    return [];
  }
  const authorsOf = (item: LibraryItem): string[] =>
    item.authors.map((author) => normalizeTitle(author));
  const exact = items.filter((item) =>
    authorsOf(item).some((author) => author === needle),
  );
  if (exact.length > 0) {
    return exact;
  }
  return items.filter((item) =>
    authorsOf(item).some((author) => author !== '' && author.includes(needle)),
  );
}

/** 书名与作者同时给出时取交集；空查询返回 null（调用方报 invalid_query）。 */
function filterBooks(
  items: readonly LibraryItem[],
  query: LibraryBookLookup,
): LibraryItem[] | null {
  const title = query.title?.trim() ?? '';
  const author = query.author?.trim() ?? '';
  if (title === '' && author === '') {
    return null;
  }
  let matches: readonly LibraryItem[] = items;
  if (title !== '') {
    matches = filterByTitle(matches, title);
  }
  if (author !== '') {
    matches = filterByAuthor(matches, author);
  }
  return [...matches];
}

function matchOutlineByTitle(
  items: readonly OutlineItem[],
  title: string,
): OutlineItem[] {
  const needle = normalizeTitle(title);
  if (needle === '') {
    return [];
  }
  const exact = items.filter((item) => normalizeTitle(item.text) === needle);
  if (exact.length > 0) {
    return exact;
  }
  return items.filter((item) => {
    const haystack = normalizeTitle(item.text);
    return (
      haystack !== '' && (haystack.includes(needle) || needle.includes(haystack))
    );
  });
}

function outlineEntry(item: OutlineItem): LibraryOutlineEntry {
  return {
    level: item.level,
    text: item.text,
    ...(item.chapter !== undefined ? { chapter: item.chapter } : {}),
    ...(item.page !== undefined ? { page: item.page } : {}),
  };
}

/** 与 assistant-tools.clipToolText 同口径：截断保留前部并标注。 */
function clipAssistantText(text: string): { text: string; truncated: boolean } {
  const clean = text.trim();
  const limit = READER_LIMITS.maxAssistantContextChars;
  if (clean.length <= limit) {
    return { text: clean, truncated: false };
  }
  let cut = clean.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

function isEncryptedError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { name?: unknown; message?: unknown };
  if (
    candidate.name === 'PdfEncryptedError' ||
    candidate.name === 'PasswordException'
  ) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /encrypt|password|加密|密码/i.test(candidate.message)
  );
}

function readFailure(error: unknown): LibraryContentFailure {
  if (isEncryptedError(error)) {
    return {
      ok: false,
      error: 'encrypted',
      message: '文件已加密（受密码保护），无法提取正文。',
    };
  }
  if (error instanceof ReaderLimitError) {
    return {
      ok: false,
      error: 'unreadable',
      message: `内容超出读取上限（${error.kind}：${error.actual} > ${error.limit}）。`,
    };
  }
  if (error instanceof Error && error.message !== '') {
    return { ok: false, error: 'unreadable', message: error.message };
  }
  return { ok: false, error: 'unreadable', message: '读取正文失败。' };
}

interface OpenedBody {
  readonly path: string;
  readonly format: string;
  readonly source: RandomAccessSource;
}

function resolveFromItems(
  items: readonly LibraryItem[],
  query: LibraryBookLookup,
): { ok: true; item: LibraryItem } | LibraryContentFailure {
  const matches = filterBooks(items, query);
  if (matches === null) {
    return {
      ok: false,
      error: 'invalid_query',
      message: '需要书名、作者或书籍 id 才能定位。',
    };
  }
  if (matches.length === 0) {
    return { ok: false, error: 'not_found', message: '书库里没有匹配的书。' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      message: `匹配到 ${matches.length} 本书，请指定书名、作者或书籍 id。`,
      candidates: matches.map(candidateOf),
    };
  }
  return { ok: true, item: matches[0]! };
}

/** 生产默认依赖：Tauri 客户端 + 懒加载解析器。 */
export function defaultLibraryContentDeps(): LibraryContentDeps {
  return {
    listItems: () => libraryClient.listItems(),
    materializeItem: (itemId) => libraryClient.materializeItem(itemId),
    openSource: async (path) => {
      const size = await invoke<number>('reader_file_size', { path });
      return {
        size,
        identity: { id: path },
        access: 'local',
        readRange: async (offset, length) => {
          const raw = await invoke<ArrayBuffer | Uint8Array>('read_file_bytes', {
            path,
            offset,
            length,
          });
          return readerChunkFromIpc(raw, length);
        },
        close: async () => undefined,
      };
    },
    readBytes: async (path) =>
      readerBytesFromIpc(
        path,
        await invoke<ArrayBuffer | Uint8Array>('read_file_bytes', { path }),
      ),
    parseFlow: async (request, signal) => {
      const { parseReaderContent } = await import('../reader/formats/index.js');
      // txt 走分块随机源；fb2/mobi 解析器需要整读字节（读前经限额校验）。
      if (request.format === 'fb2' || request.format === 'mobi') {
        return parseReaderContent(request.path, await request.readBytes(), signal);
      }
      return parseReaderContent(request.path, request.source, signal);
    },
    openPdf: async (source, signal) => {
      const { openPdfTextDocument } = await import('../reader/formats/pdf.js');
      return openPdfTextDocument(source, signal);
    },
    openArchive: async (source, signal) => {
      const { openSafeArchive } = await import('../reader/formats/safe-archive.js');
      return openSafeArchive(source, 'CBZ', signal);
    },
    readLocalBookMeta: async (path, source) => {
      const { extractLocalBookMeta } = await import('../library/local-book-meta.js');
      const meta = await extractLocalBookMeta(path, source);
      return {
        ...(meta.title !== undefined && meta.title !== ''
          ? { title: meta.title }
          : {}),
        authors: meta.authors,
      };
    },
  };
}

export function createLibraryContentService(
  deps: LibraryContentDeps,
): LibraryContentService {
  const resolveItem = async (
    target: LibraryContentTarget,
  ): Promise<{ ok: true; item: LibraryItem } | LibraryContentFailure> => {
    const items = await deps.listItems();
    if (typeof target === 'string') {
      return resolveFromItems(items, { title: target });
    }
    const itemId = target.itemId?.trim() ?? '';
    if (itemId !== '') {
      const item = items.find((candidate) => candidate.id === itemId);
      if (item === undefined) {
        return {
          ok: false,
          error: 'not_found',
          message: '书库里找不到这本书（可能已被删除或移动）。',
        };
      }
      return { ok: true, item };
    }
    return resolveFromItems(items, {
      title: target.title ?? '',
      author: target.author ?? '',
    });
  };

  /** 只开本机正文；远程/未下载一律结构化 not_cached，绝不代下载。 */
  const openBody = async (
    item: LibraryItem,
  ): Promise<{ ok: true; body: OpenedBody } | LibraryContentFailure> => {
    if (!hasLocalBody(item)) {
      return {
        ok: false,
        error: 'not_cached',
        message:
          '这本书的正文不在本机（远程或未下载），请先在书库中下载或打开一次再提问。',
      };
    }
    const format = formatOf(item);
    if (!SUPPORTED_FORMATS.has(format)) {
      return {
        ok: false,
        error: 'unsupported_format',
        message: `暂不支持读取 .${format === '' ? '?' : format} 格式的正文。`,
      };
    }
    let location: ManagedItemLocation;
    try {
      location = await deps.materializeItem(item.id);
    } catch {
      return item.sourceKind === 'managed'
        ? {
            ok: false,
            error: 'not_cached',
            message: '这本书的正文还没有下载到本机，请先在书库中下载或打开一次。',
          }
        : {
            ok: false,
            error: 'unreadable',
            message: '无法找到这本书的本机正文文件，请在书库中重新定位。',
          };
    }
    try {
      const source = await deps.openSource(location.path);
      return { ok: true, body: { path: location.path, format, source } };
    } catch {
      return {
        ok: false,
        error: 'unreadable',
        message: '无法读取这本书的本机正文文件。',
      };
    }
  };

  const parseFlow = async (body: OpenedBody): Promise<ReaderContent> => {
    if (deps.parseFlow === undefined) {
      throw new Error('缺少流式格式解析依赖');
    }
    return deps.parseFlow({
      path: body.path,
      format: body.format,
      source: body.source,
      readBytes: () => deps.readBytes(body.path),
    });
  };

  const openPdfDocument = async (body: OpenedBody): Promise<LibraryPdfTextSource> => {
    if (deps.openPdf === undefined) {
      throw new Error('缺少 PDF 无头读取依赖');
    }
    return deps.openPdf(body.source);
  };

  const outlineBody = async (
    body: OpenedBody,
  ): Promise<LibraryOutlineResult | LibraryContentFailure> => {
    if (body.format === 'pdf') {
      const doc = await openPdfDocument(body);
      try {
        const items = await doc.outline();
        return { ok: true, items: items.map(outlineEntry) };
      } finally {
        await doc.destroy().catch(() => undefined);
      }
    }
    if (body.format === 'cbz') {
      if (deps.openArchive === undefined) {
        throw new Error('缺少归档读取依赖');
      }
      const archive = await deps.openArchive(body.source);
      try {
        const { listImageEntries } = await import('../reader/formats/cbz.js');
        const names = archive.entries.map(
          (entry) => entry.filename ?? entry.id ?? '',
        );
        const pages = listImageEntries(names);
        return {
          ok: true,
          items: outlineFromEntries(
            pages.map(() => ({ title: '' })),
            'page',
          ).map(outlineEntry),
        };
      } finally {
        await archive.close().catch(() => undefined);
      }
    }
    const content = await parseFlow(body);
    try {
      const titles = content.chapters.map((chapter, index) =>
        chapter.title.trim() !== '' ? chapter.title : `第 ${index + 1} 章`,
      );
      return {
        ok: true,
        items: outlineFromEntries(
          titles.map((title) => ({ title })),
          'chapter',
        ).map(outlineEntry),
      };
    } finally {
      content.dispose?.();
    }
  };

  const resolvePdfTarget = (
    items: readonly OutlineItem[],
    target: LibraryChapterTarget,
    pageCount: number,
  ):
    | { ok: true; page: number; item?: OutlineItem }
    | LibraryContentFailure => {
    const title = target.title?.trim() ?? '';
    if (title !== '') {
      const matches = matchOutlineByTitle(items, title);
      if (matches.length === 0) {
        return {
          ok: false,
          error: 'chapter_not_found',
          message: '目录里找不到匹配的章节标题。',
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          error: 'ambiguous_chapter',
          message: `标题匹配到 ${matches.length} 个章节，请改用页码。`,
          chapters: matches.map(outlineEntry),
        };
      }
      const item = matches[0]!;
      if (item.page === undefined) {
        return {
          ok: false,
          error: 'chapter_not_found',
          message: '该章节没有可定位的页码。',
        };
      }
      return { ok: true, page: Math.min(pageCount, Math.max(1, item.page)), item };
    }
    const page = readNumber(target.page);
    if (page !== undefined) {
      const whole = Math.trunc(page);
      if (whole < 1 || whole > pageCount) {
        return {
          ok: false,
          error: 'chapter_not_found',
          message: `页码超出范围（共 ${pageCount} 页）。`,
        };
      }
      return { ok: true, page: whole };
    }
    const index = readNumber(target.chapter);
    if (index !== undefined) {
      const whole = Math.trunc(index);
      if (whole < 0 || whole >= pageCount) {
        return {
          ok: false,
          error: 'chapter_not_found',
          message: `页序号超出范围（共 ${pageCount} 页）。`,
        };
      }
      return { ok: true, page: whole + 1 };
    }
    return {
      ok: false,
      error: 'missing_chapter',
      message: '需要页码、页序号或章节标题才能读取正文。',
    };
  };

  const resolveFlowTarget = (
    titles: readonly string[],
    target: LibraryChapterTarget,
  ): { ok: true; index: number } | LibraryContentFailure => {
    const title = target.title?.trim() ?? '';
    if (title !== '') {
      const needle = normalizeTitle(title);
      if (needle !== '') {
        const entries = titles.map((text, index) => ({ text, index }));
        const exact = entries.filter(
          (entry) => normalizeTitle(entry.text) === needle,
        );
        const matches =
          exact.length > 0
            ? exact
            : entries.filter((entry) => {
                const haystack = normalizeTitle(entry.text);
                return (
                  haystack !== '' &&
                  (haystack.includes(needle) || needle.includes(haystack))
                );
              });
        if (matches.length === 0) {
          return {
            ok: false,
            error: 'chapter_not_found',
            message: '目录里找不到匹配的章节标题。',
          };
        }
        if (matches.length > 1) {
          return {
            ok: false,
            error: 'ambiguous_chapter',
            message: `标题匹配到 ${matches.length} 个章节，请改用章序号或更精确的标题。`,
            chapters: matches.map((entry) => ({
              level: 1,
              text: entry.text,
              chapter: entry.index,
            })),
          };
        }
        return { ok: true, index: matches[0]!.index };
      }
    }
    const index = readNumber(target.chapter);
    if (index !== undefined) {
      const whole = Math.trunc(index);
      if (whole < 0 || whole >= titles.length) {
        return {
          ok: false,
          error: 'chapter_not_found',
          message: `章序号超出范围（共 ${titles.length} 章）。`,
        };
      }
      return { ok: true, index: whole };
    }
    return {
      ok: false,
      error: 'missing_chapter',
      message: '该格式按章节读取，请提供章序号或章节标题。',
    };
  };

  const chapterBody = async (
    body: OpenedBody,
    target: LibraryChapterTarget,
  ): Promise<LibraryChapterResult | LibraryContentFailure> => {
    if (body.format === 'pdf') {
      const doc = await openPdfDocument(body);
      try {
        const items = await doc.outline();
        const resolved = resolvePdfTarget(items, target, doc.pageCount);
        if (!resolved.ok) {
          return resolved;
        }
        const text = await doc.pageText(resolved.page);
        const clipped = clipAssistantText(text);
        const title = resolved.item?.text;
        return {
          ok: true,
          text: clipped.text,
          truncated: clipped.truncated,
          page: resolved.page,
          ...(title !== undefined && title !== '' ? { title } : {}),
          ...(clipped.text === '' ? { reason: 'no_text' } : {}),
        };
      } finally {
        await doc.destroy().catch(() => undefined);
      }
    }
    if (body.format === 'cbz') {
      return {
        ok: false,
        error: 'no_text',
        message: '这本漫画只有页面图像，没有可提取的正文文本。',
      };
    }
    const content = await parseFlow(body);
    try {
      const chapters = content.chapters;
      const resolved = resolveFlowTarget(
        chapters.map((chapter) => chapter.title),
        target,
      );
      if (!resolved.ok) {
        return resolved;
      }
      const chapter = chapters[resolved.index]!;
      await chapter.load?.();
      const clipped = clipAssistantText(htmlToSearchText(chapter.html));
      return {
        ok: true,
        text: clipped.text,
        truncated: clipped.truncated,
        chapter: resolved.index,
        ...(chapter.title.trim() !== '' ? { title: chapter.title } : {}),
        ...(clipped.text === '' ? { reason: 'no_text' } : {}),
      };
    } finally {
      content.dispose?.();
    }
  };

  return {
    async locate(query) {
      const items = await deps.listItems();
      const matches = filterBooks(items, query);
      if (matches === null) {
        return {
          ok: false,
          error: 'invalid_query',
          message: '需要书名或作者才能查找书籍。',
        };
      }
      return { ok: true, candidates: matches.map(candidateOf) };
    },

    async metadata(target) {
      const resolved = await resolveItem(target);
      if (!resolved.ok) {
        return resolved;
      }
      const item = resolved.item;
      let title = item.title;
      let authors = [...item.authors];
      // 内容提取只补缺口：书名/作者齐全时绝不解析正文包。
      if (
        formatOf(item) === 'epub' &&
        hasLocalBody(item) &&
        (title.trim() === '' || authors.length === 0)
      ) {
        const reader = deps.readLocalBookMeta;
        if (reader !== undefined) {
          try {
            const location = await deps.materializeItem(item.id);
            const source = await deps.openSource(location.path);
            const filled = await reader(location.path, source);
            if (title.trim() === '' && filled.title !== undefined && filled.title !== '') {
              title = filled.title;
            }
            if (authors.length === 0) {
              authors = [...filled.authors];
            }
          } catch {
            // 补缺口失败不阻断：库内行为准。
          }
        }
      }
      return {
        ok: true,
        itemId: item.id,
        title,
        authors,
        format: formatOf(item),
        sourceKind: item.sourceKind,
        ...(item.availability !== undefined ? { availability: item.availability } : {}),
        ...(item.series !== undefined && item.series !== ''
          ? { series: item.series }
          : {}),
        ...(item.number !== undefined && item.number !== ''
          ? { number: item.number }
          : {}),
        ...(item.volume !== undefined && item.volume !== ''
          ? { volume: item.volume }
          : {}),
        ...(item.pageCount !== undefined ? { pageCount: item.pageCount } : {}),
        subjects: [...(item.subjects ?? [])],
        bodyAvailable: bodyAvailable(item),
      };
    },

    async outline(target) {
      const resolved = await resolveItem(target);
      if (!resolved.ok) {
        return resolved;
      }
      const opened = await openBody(resolved.item);
      if (!opened.ok) {
        return opened;
      }
      try {
        return await outlineBody(opened.body);
      } catch (error) {
        return readFailure(error);
      }
    },

    async chapter(target, chapterTarget) {
      const resolved = await resolveItem(target);
      if (!resolved.ok) {
        return resolved;
      }
      const opened = await openBody(resolved.item);
      if (!opened.ok) {
        return opened;
      }
      try {
        return await chapterBody(opened.body, chapterTarget);
      } catch (error) {
        return readFailure(error);
      }
    },
  };
}
