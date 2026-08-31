/**
 * pdf-export 测试：打印 HTML 与 HTML 导出同管线（另加打印样式），
 * print 触发经注入 stub 断言 —— 实际 PDF 生成在系统打印对话框中完成，
 * 不可 headless 验证（见 pdf-export.ts 头部注释）。
 *
 * 主窗口挂载路径用最小 fake Document（项目无 jsdom/happy-dom）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPrintHtml,
  CAPTURE_WINDOW_CSS,
  EXPORT_ROOT_ID,
  extractPrintParts,
  MAIN_WINDOW_PRINT_CSS,
  measureExportCaptureSize,
  PRINT_CSS,
  PRINT_STYLE_ID,
  printToPdfFile,
  printViaMainWindow,
  runPrint,
} from '../pdf-export.js';

describe('buildPrintHtml', () => {
  it('与导出文档同结构，并追加 @page / 打印微调样式', () => {
    const html = buildPrintHtml({
      title: '打印文档',
      theme: 'warm-light',
      bodyHtml: '<p>中文内容</p>',
      cssText: ':root{--x:1}',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('data-theme="warm-light"');
    expect(html).toContain('<p>中文内容</p>');
    expect(html).toContain('@page');
    expect(html).toContain('@media print');
    expect(html).toContain('page-break-inside: avoid');
    expect(html).toContain('.lightink-export-toc');
    expect(html).toMatch(/\.lightink-export-toc[^{]*\{[^}]*page-break-after:\s*always/);
    expect(html).toMatch(/\.lightink-export-toc \+ \*[^{]*\{[^}]*page-break-before:\s*always/);
    expect(html).toContain('max-height: calc(100vh - 32mm)');
    // 基础 CSS 在前、打印微调在后（后者可覆盖前者）。
    expect(html.indexOf(':root{--x:1}')).toBeLessThan(html.indexOf(PRINT_CSS));
  });
});

describe('MAIN_WINDOW_PRINT_CSS', () => {
  it('打印时复位屏幕隐藏的内联属性，避免导出空白', () => {
    // 屏幕隐藏根节点用内联 style 写死 opacity:0 / height:0 / overflow:hidden，
    // 优先级高于普通 CSS；@media print 必须逐条 !important 复位，
    // 否则 window.print() 渲染出空白页（回归：Windows 导出 PDF 空白）。
    expect(MAIN_WINDOW_PRINT_CSS).toMatch(/#lightink-export-print-root[^}]*height:\s*auto\s*!important/s);
    expect(MAIN_WINDOW_PRINT_CSS).toMatch(/#lightink-export-print-root[^}]*opacity:\s*1\s*!important/s);
    expect(MAIN_WINDOW_PRINT_CSS).toMatch(/#lightink-export-print-root[^}]*overflow:\s*visible\s*!important/s);
  });
});

describe('runPrint', () => {
  it('装配好的 HTML 交给注入的 print 实现', () => {
    const print = vi.fn();
    runPrint('<html>doc</html>', print);
    expect(print).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledWith('<html>doc</html>');
  });
});

describe('extractPrintParts', () => {
  it('抽出 style 与 body 内层', () => {
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<p>正文</p>',
      cssText: '/* css */',
    });
    const parts = extractPrintParts(html);
    expect(parts.bodyHtml).toContain('<p>正文</p>');
    expect(parts.styleText).toContain('/* css */');
    expect(parts.styleText).toContain('@page');
  });

  it('缺标签时回退空串', () => {
    expect(extractPrintParts('<html></html>')).toEqual({ bodyHtml: '', styleText: '' });
  });
});

/** 最小 fake 元素：覆盖 printViaMainWindow 用到的 DOM 子集。 */
class FakeEl {
  id = '';
  textContent = '';
  innerHTML = '';
  scrollWidth = 800;
  scrollHeight = 2400;
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

function makeFakeDocument(): {
  doc: Document;
  head: FakeEl;
  body: FakeEl;
  byId: Map<string, FakeEl>;
} {
  const byId = new Map<string, FakeEl>();
  const head = new FakeEl();
  const body = new FakeEl();

  const track = (el: FakeEl): void => {
    if (el.id) byId.set(el.id, el);
  };

  const documentElement = new FakeEl();
  documentElement.scrollWidth = 800;
  documentElement.scrollHeight = 2400;

  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => {
      void tag;
      return new FakeEl();
    },
    documentElement,
    head: {
      appendChild: (el: FakeEl) => {
        head.appendChild(el);
        track(el);
        return el;
      },
    },
    body: {
      appendChild: (el: FakeEl) => {
        body.appendChild(el);
        track(el);
        return el;
      },
    },
  } as unknown as Document;

  return { doc, head, body, byId };
}

describe('printViaMainWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('挂载导出根与打印样式，并对主窗口调用 print', () => {
    vi.useFakeTimers();
    const print = vi.fn();
    const focus = vi.fn();
    const addEventListener = vi.fn();
    // 同步执行 rAF，便于断言挂载与 print 调用。
    const requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0);
      return 0;
    };
    const win = {
      print,
      focus,
      addEventListener,
      requestAnimationFrame,
    } as unknown as Window;

    const { doc, head, body, byId } = makeFakeDocument();
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<h1>导出</h1>',
      cssText: '/* theme */',
    });
    printViaMainWindow(doc, html, win);

    const root = byId.get(EXPORT_ROOT_ID);
    const style = byId.get(PRINT_STYLE_ID);
    expect(root).toBeDefined();
    expect(root?.innerHTML).toContain('<h1>导出</h1>');
    expect(style?.textContent).toContain('/* theme */');
    expect(style?.textContent).toContain(MAIN_WINDOW_PRINT_CSS);
    expect(body.children).toContain(root);
    expect(head.children).toContain(style);
    expect(print).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith(
      'afterprint',
      expect.any(Function),
      expect.objectContaining({ once: true }),
    );

    // 超时兜底清理。
    vi.advanceTimersByTime(60_000);
    expect(byId.get(EXPORT_ROOT_ID)?.parent).toBeNull();
    expect(byId.get(PRINT_STYLE_ID)?.parent).toBeNull();
  });

  it('导出样式裹进 @media print，避免屏幕上污染应用外壳', () => {
    // 回归：导出 CSS 含全局 `body { max-width:860px; font-size:14px; ... }`，
    // 若原样注入主文档，点导出 PDF 时应用界面被缩窄/字号变小。
    // 断言这类 body 规则只出现在 @media print 块内（屏幕不生效）。
    vi.useFakeTimers();
    const win = {
      print: vi.fn(),
      focus: vi.fn(),
      addEventListener: vi.fn(),
      requestAnimationFrame: (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      },
    } as unknown as Window;
    const { doc } = makeFakeDocument();
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<p>x</p>',
      cssText: 'body { max-width: 860px; font-size: 14px; }',
    });
    printViaMainWindow(doc, html, win);

    const style = doc.getElementById(PRINT_STYLE_ID);
    const text = style?.textContent ?? '';
    // 该 body 规则必须位于 @media print { ... } 之内。
    expect(text).toMatch(/@media print\s*\{[\s\S]*\bbody\s*\{[^}]*max-width:\s*860px[^}]*\}/);
    // 且不能在 @media print 块之外裸露（粗校验：去掉所有 @media print{...} 后无 body 规则）。
    const outsidePrint = text.replace(/@media print\s*\{[\s\S]*?\n\}/g, '');
    expect(outsidePrint).not.toMatch(/\bbody\s*\{/);

    vi.useRealTimers();
  });
});

describe('measureExportCaptureSize', () => {
  it('取导出根与 documentElement 的较大内容尺寸，而不是视口', () => {
    const { doc, byId } = makeFakeDocument();
    const root = new FakeEl();
    root.id = EXPORT_ROOT_ID;
    root.scrollWidth = 640;
    root.scrollHeight = 4000;
    byId.set(EXPORT_ROOT_ID, root);
    (doc.documentElement as unknown as FakeEl).scrollWidth = 800;
    (doc.documentElement as unknown as FakeEl).scrollHeight = 1200;
    expect(measureExportCaptureSize(doc)).toEqual({ width: 800, height: 4000 });
  });
});

describe('printToPdfFile', () => {
  it('invoke 前把文档画成屏幕可见捕获面，结束后卸根', async () => {
    const { doc, head, body, byId } = makeFakeDocument();
    (doc.documentElement as unknown as FakeEl).setAttribute('data-theme', 'dark');
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<h1>正文标题</h1><p>一段正文</p>',
      cssText: 'body { max-width: 860px; font-size: 14px; }',
    });
    let seenDuringInvoke = false;
    const invokeNative = vi.fn(async () => {
      const root = byId.get(EXPORT_ROOT_ID);
      const style = byId.get(PRINT_STYLE_ID);
      expect(root).toBeDefined();
      expect(root?.innerHTML).toContain('<h1>正文标题</h1>');
      expect(root?.getAttribute('style') ?? '').toMatch(/width:\s*100%/);
      expect(root?.getAttribute('style') ?? '').toMatch(/opacity:\s*1/);
      expect(root?.getAttribute('style') ?? '').not.toMatch(/width:\s*0/);
      const text = style?.textContent ?? '';
      expect(text).toContain(CAPTURE_WINDOW_CSS);
      expect(text).toContain(MAIN_WINDOW_PRINT_CSS);
      const outsidePrint = text.replace(/@media print\s*\{[\s\S]*?\n\}/g, '');
      expect(outsidePrint).toMatch(/\bbody\s*\{[^}]*max-width:\s*860px/);
      expect(outsidePrint).toContain('display: none !important');
      expect(outsidePrint).toMatch(
        /#lightink-export-print-root[^}]*color:\s*var\(--lightink-fg\)\s*!important/,
      );
      expect(body.children).toContain(root);
      expect(head.children).toContain(style);
      seenDuringInvoke = true;
    });
    const win = {
      requestAnimationFrame: (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      },
    } as unknown as Window;

    await printToPdfFile(doc, html, invokeNative, win);

    expect(invokeNative).toHaveBeenCalledTimes(1);
    expect(invokeNative).toHaveBeenCalledWith({ width: 800, height: 2400 });
    expect(seenDuringInvoke).toBe(true);
    expect(byId.get(EXPORT_ROOT_ID)?.parent).toBeNull();
    expect(byId.get(PRINT_STYLE_ID)?.parent).toBeNull();
  });

  it('invoke 失败也卸根，不残留导出样式', async () => {
    const { doc, byId } = makeFakeDocument();
    const html = buildPrintHtml({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<p>x</p>',
      cssText: '/* theme */',
    });
    const win = {
      requestAnimationFrame: (cb: FrameRequestCallback): number => {
        cb(0);
        return 0;
      },
    } as unknown as Window;

    await expect(
      printToPdfFile(doc, html, async () => {
        throw new Error('createPDF failed');
      }, win),
    ).rejects.toThrow('createPDF failed');
    expect(byId.get(EXPORT_ROOT_ID)?.parent).toBeNull();
    expect(byId.get(PRINT_STYLE_ID)?.parent).toBeNull();
  });
});
