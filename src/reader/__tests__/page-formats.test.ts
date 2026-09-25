// @vitest-environment jsdom

/**
 * 页格式解析测试（ebook-reader T5）。
 *
 * 纯逻辑单测：CBZ 图片条目过滤 + 自然序排序（listImageEntries/naturalCompare）、
 * PDF 页码/缩放状态机（createPdfPageController：next/prev/setPage/zoom/clamp）、
 * ComicInfo 共享解码（readComicInfo）。真实 canvas/zip 渲染（renderPdfInto/
 * renderCbzInto）留手工验证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listImageEntries, naturalCompare, readComicInfo } from '../formats/cbz.js';
import { injectEncodingSniffOrder } from '../formats/text-encoding.js';
import type { ArchiveProvider } from '../sources/types.js';
import {
  enforcePageCount,
  injectReaderLimit,
  READER_LIMITS,
} from '../reader-limits.js';
import {
  cancelPdfThumb,
  createPdfPageController,
  openPdfTextDocument,
  PDF_SCALE_STEPS,
  PDF_THUMB_MAX_EDGE,
  PdfEncryptedError,
  pdfCssScale,
  pdfFitWidthScale,
  pdfHostFitContentWidth,
  renderPdfThumb,
} from '../formats/pdf.js';
import { ReaderLimitError } from '../formats/types.js';

/** 无头文本测试只 mock 引导层：openPdfTextDocument 自身的打开链走真代码。 */
const pdfBootRuntime = vi.hoisted(() => ({ loadPdfjsComponents: vi.fn() }));

vi.mock('../formats/pdfjs-boot.js', () => ({
  loadPdfjsComponents: pdfBootRuntime.loadPdfjsComponents,
}));

describe('CBZ listImageEntries', () => {
  it('只保留图片扩展名，过滤目录项与非图片', () => {
    const names = ['comic/', 'page1.jpg', 'notes.txt', 'page2.png', 'thumbs.db', 'sub/page3.gif'];
    expect(listImageEntries(names)).toEqual(['page1.jpg', 'page2.png', 'sub/page3.gif']);
  });

  it('按自然序排序（page2 < page10）', () => {
    const names = ['page10.jpg', 'page2.jpg', 'page1.jpg'];
    expect(listImageEntries(names)).toEqual(['page1.jpg', 'page2.jpg', 'page10.jpg']);
  });

  it('空或全非图片返回空数组', () => {
    expect(listImageEntries(['a.txt', 'b/'])).toEqual([]);
    expect(listImageEntries([])).toEqual([]);
  });
});

describe('naturalCompare', () => {
  it('数字段按数值比较', () => {
    expect(naturalCompare('p2', 'p10')).toBeLessThan(0);
    expect(naturalCompare('p10', 'p2')).toBeGreaterThan(0);
    expect(naturalCompare('p2', 'p2')).toBe(0);
  });

  it('非数字段按字典序', () => {
    expect(naturalCompare('abc', 'abd')).toBeLessThan(0);
  });
});

describe('createPdfPageController', () => {
  it('初始在第 1 页、缩放 1.0', () => {
    const c = createPdfPageController(5);
    expect(c.page).toBe(1);
    expect(c.scale).toBe(1);
    expect(c.totalPages).toBe(5);
    expect(c.canPrev).toBe(false);
    expect(c.canNext).toBe(true);
  });

  it('next/prev 翻页并钳制边界', () => {
    const c = createPdfPageController(3);
    expect(c.next()).toBe(true);
    expect(c.page).toBe(2);
    expect(c.next()).toBe(true);
    expect(c.page).toBe(3);
    expect(c.canNext).toBe(false);
    expect(c.next()).toBe(false); // 末页不再前进
    expect(c.page).toBe(3);
    expect(c.prev()).toBe(true);
    expect(c.page).toBe(2);
  });

  it('setPage 钳制到有效范围', () => {
    const c = createPdfPageController(4);
    expect(c.setPage(10)).toBe(true); // 钳制到 4
    expect(c.page).toBe(4);
    expect(c.setPage(0)).toBe(true); // 钳制到 1
    expect(c.page).toBe(1);
    expect(c.setPage(1)).toBe(false); // 未变化
  });

  it('zoomIn/Out/reset 在档位间移动并钳制', () => {
    const c = createPdfPageController(2);
    const max = PDF_SCALE_STEPS[PDF_SCALE_STEPS.length - 1]!;
    c.zoomIn();
    expect(c.scale).toBeGreaterThan(1);
    // 一直放大到最大档。
    for (let i = 0; i < PDF_SCALE_STEPS.length; i++) {
      c.zoomIn();
    }
    expect(c.scale).toBe(max);
    expect(c.zoomIn()).toBe(false); // 已到最大
    c.resetScale();
    expect(c.scale).toBe(1);
    c.zoomOut();
    expect(c.scale).toBeLessThan(1);
  });

  it('reset userZoom is 1 so restore is fit-width, not 100% device pixels', () => {
    expect(pdfFitWidthScale(800, 400)).toBe(2);
    expect(pdfFitWidthScale(0, 400)).toBe(1);
    expect(pdfFitWidthScale(800, 0)).toBe(1);
    expect(pdfHostFitContentWidth({ clientWidth: 0 }, 0)).toBe(0);
    expect(pdfHostFitContentWidth({ clientWidth: 0, getBoundingClientRect: () => ({ width: 390 }) }, 0)).toBe(
      390,
    );
    expect(pdfHostFitContentWidth({ clientWidth: 980 }, 0, 360)).toBe(360);
    expect(pdfHostFitContentWidth({ clientWidth: 390 }, 16, 390)).toBe(374);
    const c = createPdfPageController(2);
    c.zoomIn();
    expect(pdfCssScale(2.5, c.scale)).toBeGreaterThan(2.5);
    c.resetScale();
    expect(c.scale).toBe(1);
    expect(pdfCssScale(2.5, c.scale)).toBe(2.5);
  });

  it('totalPages 至少为 1', () => {
    expect(createPdfPageController(0).totalPages).toBe(1);
    expect(createPdfPageController(-3).totalPages).toBe(1);
  });
});

describe('renderPdfThumb', () => {
  function fakeThumbContext(): CanvasRenderingContext2D {
    return {
      drawImage: vi.fn(),
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    } as unknown as CanvasRenderingContext2D;
  }

  function fakeCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getContext: () => fakeThumbContext(),
    };
    return canvas as unknown as HTMLCanvasElement;
  }

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeThumbContext());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sizes the backing store to at least CSS long edge × dpr', async () => {
    const cssEdge = 160;
    const dpr = 1.25;
    const targetLong = Math.round(cssEdge * dpr);
    const render = vi.fn(async () => undefined);
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 400 * scale,
      }),
      render: () => ({ promise: render() }),
    };
    const canvas = fakeCanvas();
    await expect(renderPdfThumb(page, canvas, cssEdge, dpr)).resolves.toBe(true);
    expect(Math.max(canvas.width, canvas.height)).toBeGreaterThanOrEqual(targetLong);
    expect(canvas.width).toBe(Math.round(targetLong / 2));
    expect(canvas.height).toBe(targetLong);
    expect(canvas.style.height).toBe(`${cssEdge}px`);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('rasters at about 2× target pixels then steps the final canvas down to the target size', async () => {
    const cssEdge = 128;
    const dpr = 2;
    const targetLong = Math.round(cssEdge * dpr);
    let renderLong = 0;
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 400 * scale,
      }),
      render: ({ viewport }: { viewport: { width: number; height: number } }) => {
        renderLong = Math.max(viewport.width, viewport.height);
        return { promise: Promise.resolve() };
      },
    };
    const canvas = fakeCanvas();
    await expect(renderPdfThumb(page, canvas, cssEdge, dpr)).resolves.toBe(true);
    expect(renderLong).toBeCloseTo(targetLong * 2);
    expect(Math.max(canvas.width, canvas.height)).toBe(targetLong);
    expect(canvas.width).toBe(Math.round(targetLong / 2));
    expect(canvas.height).toBe(targetLong);
  });

  it('defaults the CSS long edge so preview() callers keep working', async () => {
    const dpr =
      typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
    const targetLong = Math.round(PDF_THUMB_MAX_EDGE * dpr);
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 400 * scale,
      }),
      render: () => ({ promise: Promise.resolve() }),
    };
    const canvas = fakeCanvas();
    await expect(renderPdfThumb(page, canvas)).resolves.toBe(true);
    expect(Math.max(canvas.width, canvas.height)).toBeGreaterThanOrEqual(targetLong);
  });

  it('returns false when a page render throws, without leaking the error', async () => {
    const page = {
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({
        promise: Promise.reject(new Error('render failed')),
      }),
    };
    await expect(renderPdfThumb(page, fakeCanvas())).resolves.toBe(false);
  });

  it('returns false when the canvas has no 2d context', async () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    const page = {
      getViewport: () => ({ width: 80, height: 120 }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    };
    await expect(renderPdfThumb(page, canvas)).resolves.toBe(false);
    expect(page.render).not.toHaveBeenCalled();
  });

  it('returns false when the page viewport has no area, without throwing', async () => {
    const page = {
      getViewport: () => ({ width: 0, height: 120 }),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    };
    await expect(renderPdfThumb(page, fakeCanvas())).resolves.toBe(false);
    expect(page.render).not.toHaveBeenCalled();
  });

  it('cancelPdfThumb aborts the render task and does not paint the destination canvas', async () => {
    const cancel = vi.fn();
    let rejectRender!: (error: Error) => void;
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 200 * scale,
        height: 400 * scale,
      }),
      render: () => ({
        promise: new Promise<void>((_resolve, reject) => {
          rejectRender = reject;
        }),
        cancel,
      }),
    };
    const canvas = fakeCanvas();
    const pending = renderPdfThumb(page, canvas, 128, 1);
    cancelPdfThumb(canvas);
    expect(cancel).toHaveBeenCalledTimes(1);
    rejectRender(new Error('RenderingCancelledException'));
    await expect(pending).resolves.toBe(false);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });
});

describe('reader page limits', () => {
  it('accepts PDF and CBZ counts exactly at their limits', () => {
    expect(() => enforcePageCount('pdf', READER_LIMITS.maxPdfPages)).not.toThrow();
    expect(() => enforcePageCount('cbz', READER_LIMITS.maxCbzPages)).not.toThrow();
  });

  it('rejects one page over each limit with structured details', () => {
    for (const [format, limit, kind] of [
      ['pdf', READER_LIMITS.maxPdfPages, 'pdfPages'],
      ['cbz', READER_LIMITS.maxCbzPages, 'cbzPages'],
    ] as const) {
      try {
        enforcePageCount(format, limit + 1);
        throw new Error('expected page validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ReaderLimitError);
        expect(error).toMatchObject({ kind, actual: limit + 1, limit });
      }
    }
  });

  it('注册表单项收紧后 pdf/cbz 页数校验同步以同错误种类拒绝（传播探针）', () => {
    // shared-utils：页数上限唯一事实源在限额注册表——单项收紧后 pdf 与 cbz
    // 同步拒绝，错误种类（pdfPages/cbzPages）不变，不静默截断。
    expect(() => enforcePageCount('pdf', 3)).not.toThrow();
    const restore = injectReaderLimit('maxPdfPages', 2);
    try {
      expect(() => enforcePageCount('pdf', 3)).toThrow(
        expect.objectContaining<Partial<ReaderLimitError>>({
          kind: 'pdfPages',
          actual: 3,
          limit: 2,
        }),
      );
      // cbz 上限不受单项调整影响。
      expect(() => enforcePageCount('cbz', 3)).not.toThrow();
    } finally {
      restore();
    }
    expect(() => enforcePageCount('pdf', 3)).not.toThrow();
  });
});

describe('openPdfTextDocument（PDF 无头文本，R5）', () => {
  afterEach(() => {
    pdfBootRuntime.loadPdfjsComponents.mockReset();
  });

  function mockTextPdf(options: { pages: readonly (readonly string[])[] }) {
    const textOptions: Array<{ disableNormalization?: boolean }> = [];
    const getPage = vi.fn(async (page: number) => ({
      getTextContent: async (params: { disableNormalization?: boolean }) => {
        textOptions.push(params);
        return {
          items: (options.pages[page - 1] ?? []).map((str) => ({ str })),
          styles: {},
        };
      },
    }));
    const destroy = vi.fn(async () => undefined);
    const doc = {
      numPages: options.pages.length,
      getPage,
      getOutline: vi.fn(async () => [{ title: '前言', dest: [null] }]),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
    };
    const getDocument = vi.fn(() => ({ promise: Promise.resolve(doc), destroy }));
    pdfBootRuntime.loadPdfjsComponents.mockResolvedValue({
      pdfjs: { getDocument },
      viewer: {},
    });
    return { getDocument, destroy, getPage, textOptions };
  }

  it('按页取原始字形文本（disableNormalization）并缓存，destroy 幂等', async () => {
    const runtime = mockTextPdf({ pages: [['第', '一', '页'], ['第', '二', '页']] });
    const handle = await openPdfTextDocument(new Uint8Array([1, 2, 3]));
    expect(handle.pageCount).toBe(2);
    await expect(handle.pageText(1)).resolves.toBe('第一页');
    await expect(handle.pageText(2)).resolves.toBe('第二页');
    await expect(handle.pageText(1)).resolves.toBe('第一页');
    expect(runtime.getPage).toHaveBeenCalledTimes(2); // 缓存命中不重复取页
    // 与渲染文本层/搜索同口径：不 normalize，命中 offset 才能对齐。
    expect(runtime.textOptions).toEqual([
      { disableNormalization: true },
      { disableNormalization: true },
    ]);
    await expect(handle.pageText(99)).resolves.toBe('第二页'); // 越界钳制
    const outline = await handle.outline();
    expect(outline.map((item) => ({ level: item.level, text: item.text }))).toEqual([
      { level: 1, text: '前言' },
    ]);
    await handle.destroy();
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    await handle.destroy();
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
  });

  it('加密 PDF 抛 PdfEncryptedError，损坏 PDF 仍抛通用 ParseError', async () => {
    const passwordError = Object.assign(new Error('No password given'), {
      name: 'PasswordException',
      code: 1,
    });
    pdfBootRuntime.loadPdfjsComponents.mockResolvedValue({
      pdfjs: {
        getDocument: vi.fn(() => ({
          promise: Promise.reject(passwordError),
          destroy: vi.fn(async () => undefined),
        })),
      },
      viewer: {},
    });
    await expect(openPdfTextDocument(new Uint8Array([1]))).rejects.toBeInstanceOf(
      PdfEncryptedError,
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      pdfBootRuntime.loadPdfjsComponents.mockResolvedValue({
        pdfjs: {
          getDocument: vi.fn(() => ({
            promise: Promise.reject(new Error('boom')),
            destroy: vi.fn(async () => undefined),
          })),
        },
        viewer: {},
      });
      await expect(openPdfTextDocument(new Uint8Array([1]))).rejects.toThrow(
        'PDF 文件损坏或无法解析',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('页数超限按限额注册表抛 ReaderLimitError 并释放文档', async () => {
    const runtime = mockTextPdf({ pages: [['a'], ['b'], ['c']] });
    const restore = injectReaderLimit('maxPdfPages', 2);
    try {
      await expect(openPdfTextDocument(new Uint8Array([1]))).rejects.toMatchObject({
        name: 'ReaderLimitError',
        kind: 'pdfPages',
        actual: 3,
        limit: 2,
      });
    } finally {
      restore();
    }
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('readComicInfo 共享解码', () => {
  /** 单条 ComicInfo.xml 的随机访问 provider（readComicInfo 的测试替身）。 */
  function comicInfoArchive(bytes: Uint8Array) {
    const entries = [
      {
        id: 'comicinfo',
        filename: 'ComicInfo.xml',
        directory: false,
        compressedSize: bytes.byteLength,
        uncompressedSize: bytes.byteLength,
      },
    ];
    const provider: ArchiveProvider = {
      entries,
      accessMode: 'random',
      readEntry: async () => bytes,
      close: async () => undefined,
    };
    return { provider, entries };
  }

  it('洁净 UTF-8 ComicInfo 元数据解析不变', async () => {
    const xml =
      '<?xml version="1.0"?><ComicInfo><Title>第十卷</Title><Series>示例系列</Series></ComicInfo>';
    const { provider, entries } = comicInfoArchive(new TextEncoder().encode(xml));
    const metadata = await readComicInfo(provider, entries);
    expect(metadata?.title).toBe('第十卷');
    expect(metadata?.series).toBe('示例系列');
  });

  it('GBK 编码的 ComicInfo 经共享嗅探解码为可读文本（D1 行为差）', async () => {
    let gbkDecoded = false;
    try {
      new TextDecoder('gbk');
      gbkDecoded = true;
    } catch {
      gbkDecoded = false;
    }
    if (!gbkDecoded) {
      return; // 运行时无 GBK，跳过本例（UTF-8 兜底路径在其它用例覆盖）。
    }
    // “书名”(CAE9 C3FB) 的 GBK 字节 + ASCII 结构。
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0"?><ComicInfo><Title>'),
      0xca, 0xe9, 0xc3, 0xfb,
      ...new TextEncoder().encode('</Title></ComicInfo>'),
    ]);
    const { provider, entries } = comicInfoArchive(bytes);
    const metadata = await readComicInfo(provider, entries);
    expect(metadata?.title).toBe('书名');
  });

  it('UTF-8 与 GBK 均无法解码的字节按 UTF-8 尽力显示，不抛新错误', async () => {
    // 0xFF 在两种编码下都非法：嗅探落回 UTF-8，标题显示替换字符。
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0"?><ComicInfo><Title>A'),
      0xff,
      ...new TextEncoder().encode('B</Title></ComicInfo>'),
    ]);
    const { provider, entries } = comicInfoArchive(bytes);
    const metadata = await readComicInfo(provider, entries);
    expect(metadata?.title).toBe('A�B');
  });

  it('改变嗅探顺序后 ComicInfo 输出同步变化（探针传播）', async () => {
    const xml =
      '<?xml version="1.0"?><ComicInfo><Title>书名</Title><Series>系列</Series></ComicInfo>';
    const bytes = new TextEncoder().encode(xml);
    const { provider, entries } = comicInfoArchive(bytes);
    const before = await readComicInfo(provider, entries);
    expect(before?.title).toBe('书名');
    // windows-1252 前置：UTF-8 中文改道解码为 mojibake，元数据同步变化。
    const restore = injectEncodingSniffOrder(['windows-1252', 'utf-8', 'gbk']);
    try {
      const after = await readComicInfo(provider, entries);
      expect(after?.title).not.toBe('书名');
      expect(after?.title).not.toBe(undefined);
    } finally {
      restore();
    }
    expect((await readComicInfo(provider, entries))?.title).toBe('书名');
  });

  it('注册表单项收紧后 ComicInfo 同步按新限值跳过元数据（传播探针）', async () => {
    // shared-utils：ComicInfo 体积上限唯一事实源在限额注册表——收紧后 cbz 读取
    // 同步丢弃超限元数据（现行"超限忽略"语义不变），恢复后照常解析。
    const xml = '<?xml version="1.0"?><ComicInfo><Title>书名</Title></ComicInfo>';
    const bytes = new TextEncoder().encode(xml);
    const { provider, entries } = comicInfoArchive(bytes);
    expect((await readComicInfo(provider, entries))?.title).toBe('书名');
    const restore = injectReaderLimit('maxComicInfoBytes', bytes.byteLength - 1);
    try {
      expect(await readComicInfo(provider, entries)).toBeNull();
    } finally {
      restore();
    }
    expect((await readComicInfo(provider, entries))?.title).toBe('书名');
  });
});
