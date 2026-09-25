// @vitest-environment jsdom

/**
 * 库作用域只读内容服务测试（R5 / ADR-5）。
 *
 * 全部经注入的 fake 依赖驱动：不起 Tauri、pdfjs 或 zip。覆盖定位与候选、
 * 元数据补缺口、目录、指定章正文与截断、结构化不可读错误（远程未缓存/
 * 加密/不支持/损坏）以及只读边界（不调用任何正文下载路径）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createLibraryContentService,
  formatOf,
  type LibraryContentDeps,
  type LibraryFlowParseRequest,
} from '../library-content.js';
import type { LibraryItem } from '../../library/library-client.js';
import type { OutlineItem } from '../../outline/outline-model.js';
import type { ReaderContent } from '../../reader/formats/types.js';
import { injectReaderLimit } from '../../reader/reader-limits.js';
import type { RandomAccessSource } from '../../reader/sources/types.js';

function book(
  overrides: Partial<LibraryItem> & { id: string; title: string },
): LibraryItem {
  return {
    sourceKind: 'local',
    authors: [],
    updatedAt: 1,
    ...overrides,
  };
}

function memorySource(size = 8): RandomAccessSource {
  return {
    size,
    identity: { id: 'mem:test' },
    readRange: vi.fn(async (offset: number, length: number) => {
      const available = Math.max(0, size - offset);
      return new Uint8Array(Math.min(length, available));
    }),
    close: vi.fn(async () => undefined),
  };
}

function flowContent(
  chapters: readonly { title: string; html: string; load?: () => Promise<void> }[],
): ReaderContent {
  return {
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      html: chapter.html,
      ...(chapter.load !== undefined ? { load: chapter.load } : {}),
    })),
  };
}

function deps(overrides: Partial<LibraryContentDeps> = {}): LibraryContentDeps {
  return {
    listItems: vi.fn(async () => [] as readonly LibraryItem[]),
    materializeItem: vi.fn(async (itemId: string) => ({
      itemId,
      path: `C:/books/${itemId}.bin`,
      availability: 'local' as const,
    })),
    openSource: vi.fn(async () => memorySource()),
    readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...overrides,
  };
}

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    const failure = result as { error?: string };
    throw new Error(`expected ok result, got error ${failure.error ?? 'unknown'}`);
  }
  return result as Extract<T, { ok: true }>;
}

describe('locate 按书名/作者定位', () => {
  const items = [
    book({ id: 'a', title: '三体', authors: ['刘慈欣'] }),
    book({ id: 'b', title: '三体', authors: ['刘慈欣'] }),
    book({ id: 'c', title: '球状闪电', authors: ['刘慈欣'] }),
    book({ id: 'd', title: '活着', authors: ['余华'] }),
  ];

  it('精确书名优先于包含匹配；同名多本返回全部候选且不猜测', async () => {
    const service = createLibraryContentService(
      deps({ listItems: async () => items }),
    );
    const byTitle = expectOk(await service.locate({ title: '三体' }));
    expect(byTitle.candidates.map((candidate) => candidate.itemId)).toEqual([
      'a',
      'b',
    ]);
    const byPartial = expectOk(await service.locate({ title: '闪电' }));
    expect(byPartial.candidates.map((candidate) => candidate.itemId)).toEqual([
      'c',
    ]);
  });

  it('按作者定位返回该作者全部书籍；书名+作者取交集', async () => {
    const service = createLibraryContentService(
      deps({ listItems: async () => items }),
    );
    const byAuthor = expectOk(await service.locate({ author: '刘慈欣' }));
    expect(byAuthor.candidates.map((candidate) => candidate.itemId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const both = expectOk(
      await service.locate({ title: '三体', author: '余华' }),
    );
    expect(both.candidates).toEqual([]);
  });

  it('空查询返回 invalid_query', async () => {
    const service = createLibraryContentService(
      deps({ listItems: async () => items }),
    );
    expect(await service.locate({})).toMatchObject({
      ok: false,
      error: 'invalid_query',
    });
  });

  it('同名多本读取目录前返回 ambiguous + candidates，不猜测', async () => {
    const parseFlow = vi.fn(async () => flowContent([]));
    const service = createLibraryContentService(
      deps({ listItems: async () => items, parseFlow }),
    );
    const result = await service.outline('三体');
    expect(result).toMatchObject({ ok: false, error: 'ambiguous' });
    expect(result.ok === false && result.candidates?.map((c) => c.itemId)).toEqual([
      'a',
      'b',
    ]);
    expect(parseFlow).not.toHaveBeenCalled();
  });
});

describe('metadata', () => {
  it('库内行为准返回元数据，不读正文也不补解析', async () => {
    const item = book({
      id: 'epub-1',
      title: '样本',
      authors: ['作者甲'],
      extension: 'epub',
      localPath: 'C:/books/epub-1.epub',
      series: '系列',
      pageCount: 12,
      subjects: ['科幻'],
    });
    const materializeItem = vi.fn(deps().materializeItem);
    const openSource = vi.fn(async () => memorySource());
    const readLocalBookMeta = vi.fn(async () => ({ authors: [] }));
    const service = createLibraryContentService(
      deps({
        listItems: async () => [item],
        materializeItem,
        openSource,
        readLocalBookMeta,
      }),
    );
    const result = expectOk(await service.metadata({ itemId: 'epub-1' }));
    expect(result).toMatchObject({
      itemId: 'epub-1',
      title: '样本',
      authors: ['作者甲'],
      format: 'epub',
      series: '系列',
      pageCount: 12,
      subjects: ['科幻'],
      bodyAvailable: true,
    });
    expect(materializeItem).not.toHaveBeenCalled();
    expect(openSource).not.toHaveBeenCalled();
    expect(readLocalBookMeta).not.toHaveBeenCalled();
  });

  it('作者缺失时从 EPUB 包补缺口', async () => {
    const item = book({
      id: 'epub-2',
      title: '无作者',
      authors: [],
      extension: 'epub',
    });
    const readLocalBookMeta = vi.fn(async () => ({
      title: '包内书名',
      authors: ['包内作者'],
    }));
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], readLocalBookMeta }),
    );
    const result = expectOk(await service.metadata('无作者'));
    expect(result.authors).toEqual(['包内作者']);
    expect(readLocalBookMeta).toHaveBeenCalledTimes(1);
  });

  it('远程未缓存条目的元数据可读，但 bodyAvailable 为 false', async () => {
    const item = book({
      id: 'opds-1',
      title: '远程书',
      authors: ['作者乙'],
      extension: 'epub',
      sourceKind: 'opds',
      availability: 'remote',
      acquisitionUrl: 'https://example.com/book.epub',
    });
    const materializeItem = vi.fn(deps().materializeItem);
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], materializeItem }),
    );
    const result = expectOk(await service.metadata({ itemId: 'opds-1' }));
    expect(result.bodyAvailable).toBe(false);
    expect(result.format).toBe('epub');
    expect(materializeItem).not.toHaveBeenCalled();
  });

  it('managed 重同步条目正文未落本机时 bodyAvailable 为 false', async () => {
    const item = book({
      id: 'managed-1',
      title: '同步书',
      authors: ['作者丙'],
      extension: 'epub',
      sourceKind: 'managed',
      availability: 'remote',
      blobHash: 'sha256:abc',
      localPath: '',
    });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item] }),
    );
    const result = expectOk(await service.metadata({ itemId: 'managed-1' }));
    expect(result.bodyAvailable).toBe(false);
  });
});

describe('outline', () => {
  it('流式格式给出章目录，空标题章回退序号', async () => {
    const item = book({ id: 'txt-1', title: '长文', extension: 'txt' });
    const readBytes = vi.fn(async () => new Uint8Array());
    const parseFlow = vi.fn(async (_request: LibraryFlowParseRequest) =>
      flowContent([
        { title: '第一章', html: '<p>甲</p>' },
        { title: '', html: '<p>乙</p>' },
      ]),
    );
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], readBytes, parseFlow }),
    );
    const result = expectOk(await service.outline({ itemId: 'txt-1' }));
    expect(result.items).toEqual([
      { level: 1, text: '第一章', chapter: 0 },
      { level: 1, text: '第 2 章', chapter: 1 },
    ]);
    // txt 走随机源分块，不整读。
    const request = parseFlow.mock.calls[0]![0];
    expect(request.format).toBe('txt');
    expect(request.source.size).toBeGreaterThan(0);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('fb2/mobi 由解析实现决定整读，服务提供 readBytes 通道', async () => {
    const item = book({ id: 'mobi-1', title: '老书', extension: 'mobi' });
    const readBytes = vi.fn(async () => new Uint8Array([9, 9]));
    const parseFlow = vi.fn(async (request: LibraryFlowParseRequest) => {
      await request.readBytes();
      return flowContent([{ title: '唯一章', html: '<p>正文</p>' }]);
    });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], readBytes, parseFlow }),
    );
    const result = expectOk(await service.outline({ itemId: 'mobi-1' }));
    expect(result.items).toEqual([{ level: 1, text: '唯一章', chapter: 0 }]);
    expect(readBytes).toHaveBeenCalledWith('C:/books/mobi-1.bin');
  });

  it('PDF 用书签目录，读完释放无头文档', async () => {
    const item = book({ id: 'pdf-1', title: '论文', extension: 'pdf' });
    const destroy = vi.fn(async () => undefined);
    const items: OutlineItem[] = [
      { level: 1, text: '前言', anchor: 0, page: 1 },
      { level: 2, text: '第一节', anchor: 1, page: 3 },
    ];
    const openPdf = vi.fn(async () => ({
      pageCount: 10,
      outline: async () => items,
      pageText: async () => '',
      destroy,
    }));
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], openPdf }),
    );
    const result = expectOk(await service.outline({ itemId: 'pdf-1' }));
    expect(result.items).toEqual([
      { level: 1, text: '前言', page: 1 },
      { level: 2, text: '第一节', page: 3 },
    ]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it(
    'CBZ 按自然序列出页目录',
    async () => {
    const item = book({ id: 'cbz-1', title: '漫画', extension: 'cbz' });
    const close = vi.fn(async () => undefined);
    const openArchive = vi.fn(async () => ({
      entries: [
        {
          filename: 'page10.jpg',
          directory: false,
          compressedSize: 1,
          uncompressedSize: 1,
        },
        {
          filename: 'page2.jpg',
          directory: false,
          compressedSize: 1,
          uncompressedSize: 1,
        },
        {
          filename: 'notes.txt',
          directory: false,
          compressedSize: 1,
          uncompressedSize: 1,
        },
      ],
      accessMode: 'random' as const,
      readEntry: async () => new Uint8Array(),
      close,
    }));
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], openArchive }),
    );
    const result = expectOk(await service.outline({ itemId: 'cbz-1' }));
    expect(result.items).toEqual([
      { level: 1, text: '1', page: 1 },
      { level: 1, text: '2', page: 2 },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    },
    // 全量并行下的 archive 装载偶发超过默认 5s（单跑恒绿），放宽时序容差。
    15_000,
  );
});

describe('chapter', () => {
  it('读取指定章正文；超长按 maxAssistantContextChars 截断并标注', async () => {
    const item = book({ id: 'txt-1', title: '长文', extension: 'txt' });
    const parseFlow = vi.fn(async () =>
      flowContent([{ title: '第一章', html: `<p>${'字'.repeat(50)}</p>` }]),
    );
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    const restore = injectReaderLimit('maxAssistantContextChars', 10);
    try {
      const result = expectOk(await service.chapter('长文', { chapter: 0 }));
      expect(result.truncated).toBe(true);
      expect(result.chapter).toBe(0);
      expect(result.title).toBe('第一章');
      expect(result.text).toHaveLength(10);
      expect(result.text).toBe('字'.repeat(10));
    } finally {
      restore();
    }
  });

  it('按标题唯一命中章节；歧义返回候选目录', async () => {
    const item = book({ id: 'epub-1', title: '结构书', extension: 'epub' });
    const chapters = [
      { title: '第一章 起点', html: '<p>甲</p>' },
      { title: '第二章 归途', html: '<p>乙</p>' },
      { title: '第二章 归途（下）', html: '<p>丙</p>' },
    ];
    const parseFlow = vi.fn(async () => flowContent(chapters));
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    const unique = expectOk(
      await service.chapter({ itemId: 'epub-1' }, { title: '第一章 起点' }),
    );
    expect(unique.text).toBe('甲');
    expect(unique.chapter).toBe(0);

    const ambiguous = await service.chapter(
      { itemId: 'epub-1' },
      { title: '第二章' },
    );
    expect(ambiguous).toMatchObject({
      ok: false,
      error: 'ambiguous_chapter',
    });
    expect(
      ambiguous.ok === false ? ambiguous.chapters?.map((c) => c.chapter) : [],
    ).toEqual([1, 2]);
  });

  it('章序号越界与缺省目标返回结构化章节错误', async () => {
    const item = book({ id: 'txt-2', title: '小文', extension: 'txt' });
    const parseFlow = vi.fn(async () =>
      flowContent([{ title: '第一章', html: '<p>甲</p>' }]),
    );
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    expect(
      await service.chapter({ itemId: 'txt-2' }, { chapter: 9 }),
    ).toMatchObject({ ok: false, error: 'chapter_not_found' });
    expect(
      await service.chapter({ itemId: 'txt-2' }, {}),
    ).toMatchObject({ ok: false, error: 'missing_chapter' });
    expect(
      await service.chapter({ itemId: 'txt-2' }, { title: '找不到' }),
    ).toMatchObject({ ok: false, error: 'chapter_not_found' });
  });

  it('PDF 按 1-based 页码取文本；页序号 0-based；越界报错且释放文档', async () => {
    const item = book({ id: 'pdf-1', title: '论文', extension: 'pdf' });
    const destroy = vi.fn(async () => undefined);
    const pageText = vi.fn(async (page: number) => `第 ${page} 页正文`);
    const openPdf = vi.fn(async () => ({
      pageCount: 3,
      outline: async () =>
        [{ level: 1, text: '第二页', anchor: 0, page: 2 }] as OutlineItem[],
      pageText,
      destroy,
    }));
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], openPdf }),
    );
    const byPage = expectOk(
      await service.chapter({ itemId: 'pdf-1' }, { page: 2 }),
    );
    expect(byPage.page).toBe(2);
    expect(byPage.text).toBe('第 2 页正文');
    const byIndex = expectOk(
      await service.chapter({ itemId: 'pdf-1' }, { chapter: 0 }),
    );
    expect(byIndex.page).toBe(1);
    expect(
      await service.chapter({ itemId: 'pdf-1' }, { page: 99 }),
    ).toMatchObject({ ok: false, error: 'chapter_not_found' });
    expect(
      await service.chapter({ itemId: 'pdf-1' }, { chapter: 3 }),
    ).toMatchObject({ ok: false, error: 'chapter_not_found' });
    // 每次调用独立开合无头文档：4 次成功/失败的读取都各释放一次。
    expect(destroy).toHaveBeenCalledTimes(4);
  });

  it('CBZ 正文请求返回结构化 no_text', async () => {
    const item = book({ id: 'cbz-1', title: '漫画', extension: 'cbz' });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item] }),
    );
    expect(
      await service.chapter({ itemId: 'cbz-1' }, { page: 1 }),
    ).toMatchObject({ ok: false, error: 'no_text' });
  });
});

describe('结构化不可读错误与只读边界', () => {
  it('未缓存远程书籍的目录/正文返回 not_cached，且不触发任何下载或读取', async () => {
    const item = book({
      id: 'opds-1',
      title: '远程书',
      authors: ['作者乙'],
      extension: 'epub',
      sourceKind: 'opds',
      availability: 'remote',
      acquisitionUrl: 'https://example.com/book.epub',
    });
    const materializeItem = vi.fn(deps().materializeItem);
    const openSource = vi.fn(async () => memorySource());
    const readBytes = vi.fn(async () => new Uint8Array());
    const parseFlow = vi.fn(async () => flowContent([]));
    const openPdf = vi.fn();
    const openArchive = vi.fn();
    const service = createLibraryContentService(
      deps({
        listItems: async () => [item],
        materializeItem,
        openSource,
        readBytes,
        parseFlow,
        openPdf,
        openArchive,
      }),
    );
    expect(await service.outline({ itemId: 'opds-1' })).toMatchObject({
      ok: false,
      error: 'not_cached',
    });
    expect(
      await service.chapter({ itemId: 'opds-1' }, { chapter: 0 }),
    ).toMatchObject({ ok: false, error: 'not_cached' });
    expect(materializeItem).not.toHaveBeenCalled();
    expect(openSource).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(parseFlow).not.toHaveBeenCalled();
    expect(openPdf).not.toHaveBeenCalled();
    expect(openArchive).not.toHaveBeenCalled();
  });

  it('managed 条目正文未落本机返回 not_cached，不触发同步下载', async () => {
    const item = book({
      id: 'managed-1',
      title: '同步书',
      extension: 'epub',
      sourceKind: 'managed',
      availability: 'remote',
      blobHash: 'sha256:abc',
    });
    const materializeItem = vi.fn(async () => {
      throw new Error('书籍正文尚未下载');
    });
    const openSource = vi.fn(async () => memorySource());
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], materializeItem, openSource }),
    );
    expect(await service.outline({ itemId: 'managed-1' })).toMatchObject({
      ok: false,
      error: 'not_cached',
    });
    expect(openSource).not.toHaveBeenCalled();
  });

  it('加密 PDF 返回 encrypted', async () => {
    const item = book({ id: 'pdf-enc', title: '加密论文', extension: 'pdf' });
    const openPdf = vi.fn(async () => {
      throw Object.assign(new Error('No password given'), {
        name: 'PdfEncryptedError',
      });
    });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], openPdf }),
    );
    expect(
      await service.chapter({ itemId: 'pdf-enc' }, { page: 1 }),
    ).toMatchObject({ ok: false, error: 'encrypted' });
  });

  it('密码归档返回 encrypted，不误报为损坏', async () => {
    const item = book({ id: 'epub-enc', title: '加密包', extension: 'epub' });
    const parseFlow = vi.fn(async () => {
      throw new Error('File contains encrypted entry');
    });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    expect(await service.outline({ itemId: 'epub-enc' })).toMatchObject({
      ok: false,
      error: 'encrypted',
    });
  });

  it('损坏/解析失败返回 unreadable，超限返回结构化原因', async () => {
    const item = book({ id: 'epub-bad', title: '坏包', extension: 'epub' });
    const parseFlow = vi.fn(async () => {
      throw new Error('EPUB 文件损坏或不是有效的 zip 容器');
    });
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    const broken = await service.outline({ itemId: 'epub-bad' });
    expect(broken).toMatchObject({ ok: false, error: 'unreadable' });
    expect(broken.ok === false && broken.message).toContain('损坏');
  });

  it('本机正文丢失或无法打开返回 unreadable，不误报格式', async () => {
    const item = book({
      id: 'gone',
      title: '丢书',
      extension: 'epub',
      localPath: 'C:/books/gone.epub',
    });
    const service = createLibraryContentService(
      deps({
        listItems: async () => [item],
        materializeItem: async () => {
          throw new Error('book body missing');
        },
      }),
    );
    expect(await service.outline({ itemId: 'gone' })).toMatchObject({
      ok: false,
      error: 'unreadable',
    });

    const openSource = vi.fn(async () => {
      throw new Error('open failed');
    });
    const service2 = createLibraryContentService(
      deps({ listItems: async () => [item], openSource }),
    );
    expect(await service2.outline({ itemId: 'gone' })).toMatchObject({
      ok: false,
      error: 'unreadable',
    });
  });

  it('章节正文为空时 ok 结果带 no_text 原因', async () => {
    const item = book({ id: 'empty-1', title: '空章', extension: 'txt' });
    const parseFlow = vi.fn(async () =>
      flowContent([{ title: '第一章', html: '' }]),
    );
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], parseFlow }),
    );
    expect(
      await service.chapter({ itemId: 'empty-1' }, { chapter: 0 }),
    ).toMatchObject({ ok: true, text: '', reason: 'no_text' });
  });

  it('不支持格式返回 unsupported_format', async () => {
    const item = book({ id: 'md-1', title: '笔记', extension: 'md' });
    const materializeItem = vi.fn(deps().materializeItem);
    const service = createLibraryContentService(
      deps({ listItems: async () => [item], materializeItem }),
    );
    expect(await service.outline({ itemId: 'md-1' })).toMatchObject({
      ok: false,
      error: 'unsupported_format',
    });
    expect(materializeItem).not.toHaveBeenCalled();
  });

  it('正常读取只调用物化 + 随机源，不写任何库状态', async () => {
    const item = book({ id: 'txt-3', title: '只读样本', extension: 'txt' });
    const parseFlow = vi.fn(async () =>
      flowContent([{ title: '第一章', html: '<p>甲</p>' }]),
    );
    const materializeItem = vi.fn(deps().materializeItem);
    const openSource = vi.fn(async () => memorySource());
    const svcDeps = deps({
      listItems: async () => [item],
      materializeItem,
      openSource,
      parseFlow,
    });
    const service = createLibraryContentService(svcDeps);
    const result = expectOk(await service.chapter('只读样本', { chapter: 0 }));
    expect(result.text).toBe('甲');
    expect(materializeItem).toHaveBeenCalledTimes(1);
    expect(openSource).toHaveBeenCalledTimes(1);
    // 依赖面没有写入/下载入口：可写入的随机源 readRange 只被解析器读用。
    expect(Object.keys(svcDeps).sort()).toEqual([
      'listItems',
      'materializeItem',
      'openSource',
      'parseFlow',
      'readBytes',
    ]);
  });
});

describe('formatOf', () => {
  it('扩展名优先，其次本机路径与获取链接', () => {
    expect(formatOf(book({ id: 'x', title: 'x', extension: 'EPUB' }))).toBe(
      'epub',
    );
    expect(formatOf(book({ id: 'y', title: 'y', localPath: 'C:/a/b.mobi' }))).toBe(
      'mobi',
    );
    expect(
      formatOf(
        book({ id: 'z', title: 'z', acquisitionUrl: 'https://x/y.PDF' }),
      ),
    ).toBe('pdf');
  });
});
