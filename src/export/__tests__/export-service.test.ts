/**
 * export-service 编排测试：活动标签快照 → 内嵌图片 → 保存/打印分支。
 * 全部依赖经 ExportServiceDeps 注入 fake，node 环境直测。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultExportFileName,
  exportActiveTabHtml,
  exportActiveTabPdf,
  serializeEditorContent,
  type ExportServiceDeps,
  type ExportTabSnapshot,
} from '../export-service.js';
import { UnsafeCssBoundaryError } from '../html-export.js';
import { PRINT_CSS } from '../pdf-export.js';

const SNAPSHOT: ExportTabSnapshot = {
  title: '笔记.md',
  filePath: 'C:\\docs\\笔记.md',
  sessionId: 'untitled-ab12',
  contentHtml:
    '<h1>标题</h1><p><img src="assets/a.png" alt="图"></p>' +
    '<img src="https://example.com/ext.png">',
};

function makeDeps(overrides: Partial<ExportServiceDeps> = {}) {
  const deps: ExportServiceDeps = {
    getActiveSnapshot: () => SNAPSHOT,
    getTheme: () => 'warm-light',
    getCssText: () => '/* fake-css */',
    readImageBase64: vi.fn(async () => 'QUJD'),
    showHtmlSaveDialog: vi.fn(async () => 'C:\\out\\笔记.html'),
    writeFile: vi.fn(async () => undefined),
    printHtml: vi.fn(),
    getUnsafeCssErrorMessage: () => 'Unsafe custom theme CSS',
    reportError: vi.fn(),
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('serializeEditorContent', () => {
  it('优先取 .ProseMirror 内容，缺失时回退宿主 innerHTML', () => {
    const host = {
      querySelector: (sel: string) =>
        sel === '.ProseMirror' ? { innerHTML: '<p>正文</p>' } : null,
      innerHTML: '<div>宿主</div>',
    };
    expect(serializeEditorContent(host)).toBe('<p>正文</p>');
    const bare = { querySelector: () => null, innerHTML: '<div>宿主</div>' };
    expect(serializeEditorContent(bare)).toBe('<div>宿主</div>');
  });
});

describe('defaultExportFileName', () => {
  it('去掉原扩展名加 .html；空主干回退「未命名」', () => {
    expect(defaultExportFileName('笔记.md')).toBe('笔记.html');
    expect(defaultExportFileName('未命名-1')).toBe('未命名-1.html');
    expect(defaultExportFileName('.md')).toBe('未命名.html');
  });
});

describe('exportActiveTabHtml', () => {
  it('对话框选定路径 → 写入装配好的独立 HTML（图片已内嵌）并返回写盘路径', async () => {
    const deps = makeDeps();
    await expect(exportActiveTabHtml(deps)).resolves.toBe('C:\\out\\笔记.html');
    expect(deps.showHtmlSaveDialog).toHaveBeenCalledWith('笔记.html');
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [path, html] = vi.mocked(deps.writeFile).mock.calls[0];
    expect(path).toBe('C:\\out\\笔记.html');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('data-theme="warm-light"');
    expect(html).toContain('/* fake-css */');
    expect(html).toContain('lightink-export-toc');
    expect(html).toContain('<h1 id="section">标题</h1>');
    // 相对图片已内嵌为 data URI；绝对 URL 保留且未触达 resolver。
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    expect(html).toContain('src="https://example.com/ext.png"');
    expect(deps.readImageBase64).toHaveBeenCalledTimes(1);
    expect(deps.readImageBase64).toHaveBeenCalledWith(
      'C:\\docs\\笔记.md',
      null,
      'assets/a.png',
    );
  });

  it('未保存文档的图片按会话暂存目录解析（传 sessionId）', async () => {
    const deps = makeDeps({
      getActiveSnapshot: () => ({ ...SNAPSHOT, filePath: null }),
    });
    await expect(exportActiveTabHtml(deps)).resolves.toBe('C:\\out\\笔记.html');
    expect(deps.readImageBase64).toHaveBeenCalledWith(null, 'untitled-ab12', 'assets/a.png');
  });

  it('用户取消对话框 → 返回 null 且不写文件', async () => {
    const deps = makeDeps({ showHtmlSaveDialog: vi.fn(async () => null) });
    await expect(exportActiveTabHtml(deps)).resolves.toBeNull();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('无活动标签 → null 并上报', async () => {
    const deps = makeDeps({ getActiveSnapshot: () => null });
    await expect(exportActiveTabHtml(deps)).resolves.toBeNull();
    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(deps.showHtmlSaveDialog).not.toHaveBeenCalled();
  });

  it('写入失败 → null 并上报', async () => {
    const deps = makeDeps({
      writeFile: vi.fn(async () => {
        throw '磁盘错误';
      }),
    });
    await expect(exportActiveTabHtml(deps)).resolves.toBeNull();
    expect(deps.reportError).toHaveBeenCalledOnce();
  });

  it('不安全 CSS 在保存对话框前终止并显示错误', async () => {
    const deps = makeDeps({ getCssText: () => '/* </STYLE boundary */' });
    await expect(exportActiveTabHtml(deps)).resolves.toBeNull();
    expect(deps.reportError).toHaveBeenCalledWith(
      'Unsafe custom theme CSS',
      expect.any(UnsafeCssBoundaryError),
    );
    expect(deps.showHtmlSaveDialog).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('图片读取失败则中止导出并上报', async () => {
    const deps = makeDeps({
      readImageBase64: vi.fn(async () => {
        throw new Error('io');
      }),
    });
    await expect(exportActiveTabHtml(deps)).resolves.toBeNull();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(String(vi.mocked(deps.reportError).mock.calls[0][1])).toMatch(/图片读取失败/);
  });
});

describe('exportActiveTabPdf', () => {
  it('装配打印 HTML（含打印样式与内嵌图片）并触发 print（返回 null：落盘交给打印对话框）', async () => {
    const deps = makeDeps();
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(deps.printHtml).toHaveBeenCalledTimes(1);
    const html = vi.mocked(deps.printHtml).mock.calls[0][0];
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(PRINT_CSS);
    expect(html).toContain('src="data:image/png;base64,QUJD"');
    // PDF 走打印管线，不弹保存对话框、不写文件。
    expect(deps.showHtmlSaveDialog).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('无活动标签 → null 且不触发 print', async () => {
    const deps = makeDeps({ getActiveSnapshot: () => null });
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(deps.printHtml).not.toHaveBeenCalled();
  });

  it('提供原生 PDF 路径时优先走原生（含可选文字），成功返回写盘路径', async () => {
    const printPdfNative = vi.fn(async () => undefined);
    const showPdfSaveDialog = vi.fn(async () => 'C:\\out\\笔记.pdf');
    const deps = makeDeps({ printPdfNative, showPdfSaveDialog });
    await expect(exportActiveTabPdf(deps)).resolves.toBe('C:\\out\\笔记.pdf');
    expect(showPdfSaveDialog).toHaveBeenCalledWith('笔记.pdf');
    expect(printPdfNative).toHaveBeenCalledTimes(1);
    expect(deps.printHtml).not.toHaveBeenCalled();
  });

  it('原生保存对话框取消 → null 且不打印', async () => {
    const printPdfNative = vi.fn(async () => undefined);
    const deps = makeDeps({
      printPdfNative,
      showPdfSaveDialog: vi.fn(async () => null),
    });
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(printPdfNative).not.toHaveBeenCalled();
    expect(deps.printHtml).not.toHaveBeenCalled();
  });

  it('非 macOS 原生失败 → 回退到 printHtml（打印对话框），无路径可报', async () => {
    const printPdfNative = vi.fn(async () => {
      throw new Error('unsupported');
    });
    const deps = makeDeps({
      printPdfNative,
      showPdfSaveDialog: vi.fn(async () => 'C:\\out\\笔记.pdf'),
      isMacOS: () => false,
    });
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(printPdfNative).toHaveBeenCalled();
    expect(deps.printHtml).toHaveBeenCalledTimes(1); // 回退
    expect(deps.reportError).toHaveBeenCalled();
  });

  it('macOS 原生成功 → 一次保存框直接得 PDF 并返回路径，不触发 printHtml（R1/T6）', async () => {
    const printPdfNative = vi.fn(async (_html: string, _path: string) => undefined);
    const showPdfSaveDialog = vi.fn(async () => '/Users/me/笔记.pdf');
    const deps = makeDeps({
      printPdfNative,
      showPdfSaveDialog,
      isMacOS: () => true,
    });
    await expect(exportActiveTabPdf(deps)).resolves.toBe('/Users/me/笔记.pdf');
    expect(showPdfSaveDialog).toHaveBeenCalledWith('笔记.pdf');
    expect(printPdfNative).toHaveBeenCalledTimes(1);
    const nativeHtml = vi.mocked(printPdfNative).mock.calls[0]?.[0];
    expect(nativeHtml).toContain('标题</h1>');
    expect(deps.printHtml).not.toHaveBeenCalled(); // 不回退 window.print
    expect(deps.reportError).not.toHaveBeenCalled(); // 无错误框
  });

  it('macOS 原生失败 → 上报一次并返回 null，不回退 window.print（R1/T6）', async () => {
    const printPdfNative = vi.fn(async () => {
      throw new Error('wkwebview createPDF failed');
    });
    const deps = makeDeps({
      printPdfNative,
      showPdfSaveDialog: vi.fn(async () => '/Users/me/笔记.pdf'),
      isMacOS: () => true,
    });
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(printPdfNative).toHaveBeenCalledTimes(1);
    expect(deps.printHtml).not.toHaveBeenCalled(); // 关键：macOS 不回退打印对话框
    expect(deps.reportError).toHaveBeenCalledTimes(1); // 一次明确提示，不连锁弹多框
  });

  it('macOS 未注入原生导出 → 上报并返回 null，不回退 window.print', async () => {
    const deps = makeDeps({ isMacOS: () => true }); // 无 printPdfNative/showPdfSaveDialog
    await expect(exportActiveTabPdf(deps)).resolves.toBeNull();
    expect(deps.printHtml).not.toHaveBeenCalled();
    expect(deps.reportError).toHaveBeenCalledTimes(1);
  });
});
