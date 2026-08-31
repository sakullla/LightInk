/**
 * `pdf-export` — PDF 导出（T10, R5）：WebView 打印管线。
 *
 * Tauri WebView 内 `window.print()` 打开系统打印对话框，用户选择
 * 「另存为 PDF」即得 PDF。因此前端职责是：装配一份与 HTML 导出同一管线
 * 的打印就绪文档（同一 buildHtmlDocument + 图片内嵌，另加 @page / 打印
 * 微调样式），装入可打印表面后调用 print()。
 *
 * 平台注意（macOS / Linux WebKit）：
 *   - `iframe.contentWindow.print()` 在 Tauri 的 WKWebView / WebKitGTK 上
 *     会静默失败（上游：tauri#13451 / wry iframe print）。Windows WebView2
 *     可用，但不能只依赖 iframe 路径。
 *   - 因此生产路径改为：把打印文档 body 写入隐藏的主文档导出根节点，
 *     用 `@media print` 隐藏其余 UI 后对 **主窗口** `window.print()`。
 *     这样三端同一实现，且不依赖 iframe 打印。
 *
 * 中文无乱码策略：与 HTML 导出共用 export-css 的字体栈（系统 CJK 字体，
 * 见 export-css.ts 头部注释），打印渲染由 WebView 使用系统字体完成，
 * Windows/macOS 上无需内嵌中文字体；KaTeX 数学字体已随 CSS 内嵌。
 */

import { buildHtmlDocument, type HtmlExportOptions } from './html-export.js';

/** 打印微调：页边距 + 取消屏幕版居中窄栏宽度上限。 */
export const PRINT_CSS = `/* LightInk 打印微调 */
@page { margin: 16mm; }
@media print {
  body { max-width: none; padding: 0; }
  pre { white-space: pre-wrap; word-break: break-word; }
  /* 自动目录独占首页，正文从下一页起。后随兄弟再强制 break-before，
     避免部分打印引擎忽略 nav 上的 break-after。 */
  .lightink-export-toc {
    display: block;
    break-after: page;
    page-break-after: always;
  }
  .lightink-export-toc + * {
    break-before: page;
    page-break-before: always;
  }
  .lightink-export-chapter { break-before: page; page-break-before: always; }
  .lightink-export-chapter:first-of-type { break-before: auto; page-break-before: auto; }
  .lightink-export-toc + .lightink-export-chapter:first-of-type {
    break-before: page;
    page-break-before: always;
  }
  img, svg, figure {
    break-inside: avoid;
    page-break-inside: avoid;
    max-width: 100% !important;
    max-height: calc(100vh - 32mm);
    width: auto !important;
    height: auto !important;
    display: block;
    object-fit: contain;
  }
}
`;

export const EXPORT_ROOT_ID = 'lightink-export-print-root';
export const PRINT_STYLE_ID = 'lightink-export-print-style';

/**
 * 主窗口打印时注入：隐藏应用壳层，只显示导出根。
 * 必须与 `EXPORT_ROOT_ID` 配套。
 */
const EXPORT_ROOT_LAYOUT_CSS = `body > *:not(#${EXPORT_ROOT_ID}) { display: none !important; }
#${EXPORT_ROOT_ID} {
  position: static !important;
  left: auto !important;
  top: auto !important;
  width: 100% !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  background: #fff !important;
  color: var(--lightink-fg) !important;
  opacity: 1 !important;
  overflow: visible !important;
}`;

export const MAIN_WINDOW_PRINT_CSS = `/* LightInk 主窗口导出打印 */
@media print {
  /* 隐藏应用外壳：用 display:none（不占布局），而非 visibility:hidden（仍占位，
     会导致导出 PDF 尾部出现大量空白页）。只保留导出根参与分页。 */
  ${EXPORT_ROOT_LAYOUT_CSS}
}
`;

/**
 * 原生 createPDF / PrintToPdf 的屏幕捕获面：选择器与 MAIN_WINDOW_PRINT_CSS 对齐，
 * 但必须在屏幕媒体生效。macOS WKWebView createPDF 拍的是当前画面，不走 @media print。
 */
export const CAPTURE_WINDOW_CSS = `/* LightInk 主窗口原生 PDF 屏幕捕获 */
${EXPORT_ROOT_LAYOUT_CSS}
`;

/** 装配打印就绪 HTML：与 HTML 导出同管线，追加打印样式。 */
export function buildPrintHtml(opts: HtmlExportOptions): string {
  return buildHtmlDocument({ ...opts, cssText: `${opts.cssText}\n${PRINT_CSS}` });
}

/**
 * 从完整打印 HTML 中取出 body 内层与 style 文本，供主窗口挂载。
 * 解析失败时 bodyHtml 回退为空串、styleText 为空（调用方仍可尝试打印）。
 */
export function extractPrintParts(html: string): { bodyHtml: string; styleText: string } {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const styleText = styleMatch?.[1] ?? '';
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch?.[1] ?? '';
  return { bodyHtml, styleText };
}

/**
 * 触发打印。`print` 由调用方注入（生产为 printViaMainWindow，测试为
 * stub）——打印本身不可 headless 验证，此函数只保证管线衔接。
 */
export function runPrint(html: string, print: (html: string) => void): void {
  print(html);
}

/** 导出根强制使用的浅色主题：PDF 以深字白底输出，与活动（可能为暗色）主题无关，
 *  保证「不打印背景」默认下文字仍清晰，且为矢量原生文字。tokens.css 的
 *  `[data-theme]` 规则匹配任意元素，故挂在导出根上即让子树改用浅色令牌。 */
export const PRINT_THEME = 'warm-light';

const HIDDEN_PRINT_ROOT_STYLE =
  'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;';
const CAPTURE_PRINT_ROOT_STYLE =
  'position:static;width:100%;height:auto;overflow:visible;opacity:1;background:#fff;';

function mountExportRoot(
  doc: Document,
  html: string,
  options: { readonly capture: boolean },
): () => void {
  doc.getElementById(EXPORT_ROOT_ID)?.remove();
  doc.getElementById(PRINT_STYLE_ID)?.remove();

  const { bodyHtml, styleText } = extractPrintParts(html);

  const styleEl = doc.createElement('style');
  styleEl.id = PRINT_STYLE_ID;
  // 打印对话框路径：导出 CSS 只进 @media print，避免屏幕缩窄/字号污染。
  // 原生捕获路径：同一份文档 CSS 必须在屏幕媒体生效，createPDF 才能拍到正文。
  styleEl.textContent = options.capture
    ? `${styleText}\n${CAPTURE_WINDOW_CSS}\n${MAIN_WINDOW_PRINT_CSS}`
    : `@media print {\n${styleText}\n}\n${MAIN_WINDOW_PRINT_CSS}`;

  const root = doc.createElement('div');
  root.id = EXPORT_ROOT_ID;
  root.setAttribute('data-theme', PRINT_THEME);
  root.setAttribute(
    'style',
    options.capture ? CAPTURE_PRINT_ROOT_STYLE : HIDDEN_PRINT_ROOT_STYLE,
  );
  root.innerHTML = bodyHtml;

  doc.head.appendChild(styleEl);
  doc.body.appendChild(root);

  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    root.remove();
    styleEl.remove();
  };
}

/**
 * 把导出 HTML 装配到主文档隐藏根节点（data-theme=浅色），返回清理函数。
 * 屏幕不可见（opacity:0），`window.print` / 打印媒体时由 MAIN_WINDOW_PRINT_CSS 可见化。
 * 导出样式裹进 @media print，避免污染应用外壳（屏幕缩窄，见回归测试）。
 */
export function mountPrintRoot(doc: Document, html: string): () => void {
  return mountExportRoot(doc, html, { capture: false });
}

/**
 * 原生 PDF 捕获面：装配文档作为屏幕可见内容，供 createPDF / PrintToPdf 拍摄。
 * 仍保留 MAIN_WINDOW_PRINT_CSS，Windows 打印媒体路径不被拆掉。
 */
export function mountCaptureRoot(doc: Document, html: string): () => void {
  return mountExportRoot(doc, html, { capture: true });
}

export interface PdfNativeCaptureSize {
  readonly width: number;
  readonly height: number;
}

function elementExtent(el: Element | null, key: 'scrollWidth' | 'scrollHeight'): number {
  if (el === null) {
    return 0;
  }
  const value = (el as HTMLElement)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 装配文档的完整内容尺寸。createPDF 空 rect 只会拍当前可视第一屏。 */
export function measureExportCaptureSize(doc: Document): PdfNativeCaptureSize {
  const root = doc.getElementById(EXPORT_ROOT_ID);
  return {
    width: Math.max(
      elementExtent(root, 'scrollWidth'),
      elementExtent(doc.documentElement, 'scrollWidth'),
      1,
    ),
    height: Math.max(
      elementExtent(root, 'scrollHeight'),
      elementExtent(doc.documentElement, 'scrollHeight'),
      1,
    ),
  };
}

/**
 * 原生矢量 PDF 导出：挂载屏幕捕获面，按整份文档尺寸调用 `invokeNative`
 * （生产为 `invoke('print_webview_to_pdf')`）；成功或失败都立即卸根。
 */
export async function printToPdfFile(
  doc: Document,
  html: string,
  invokeNative: (size: PdfNativeCaptureSize) => Promise<void>,
  win: Window = window,
): Promise<void> {
  const cleanup = mountCaptureRoot(doc, html);
  try {
    await new Promise<void>((resolve) =>
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame(() => resolve())
        : setTimeout(resolve, 0),
    );
    await invokeNative(measureExportCaptureSize(doc));
  } finally {
    cleanup();
  }
}

/**
 * 生产打印实现（`window.print()` 系统对话框回退路径）：挂载导出根，主窗口 print。
 *
 * 为何不用隐藏 iframe：
 *   macOS WKWebView / Linux WebKitGTK 上 `iframe.contentWindow.print()` 静默
 *   无对话框（tauri#13451）；主窗口 print 三端可用。
 *
 * 清理：afterprint + 超时兜底，避免导出根常驻 DOM。
 */
export function printViaMainWindow(doc: Document, html: string, win: Window = window): void {
  const cleanup = mountPrintRoot(doc, html);

  // 等布局/样式应用后再 print（双 rAF：style 插入后一帧再触发）。
  const schedulePrint = (): void => {
    try {
      win.focus();
      win.print();
    } finally {
      // 部分 WebView 不派发 afterprint，超时兜底。
      win.addEventListener('afterprint', cleanup, { once: true });
      setTimeout(cleanup, 60_000);
    }
  };

  if (typeof win.requestAnimationFrame === 'function') {
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(schedulePrint);
    });
  } else {
    setTimeout(schedulePrint, 0);
  }
}

/**
 * @deprecated 保留名以免外部误引用；内部转发到主窗口打印。
 * iframe 路径在 macOS/Linux WebKit 上不可用。
 */
export function printViaHiddenIframe(doc: Document, html: string): void {
  printViaMainWindow(doc, html);
}
