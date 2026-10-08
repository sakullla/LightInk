/**
 * `export-service` — 导出编排层（T10, R5）：活动标签 → 序列化内容 →
 * 内嵌图片 → 装配文档 → 保存对话框 + 原子写（HTML）/ 系统打印（PDF）。
 *
 * 全部副作用（快照提取、主题/CSS 读取、图片读取、对话框、写文件、打印）
 * 经 `ExportServiceDeps` 注入，vitest 在 node 环境以 fake 直测编排分支。
 * DOM 相关的唯一薄点是 `serializeEditorContent`（结构化类型，可用 fake
 * 对象测）。
 */

import {
  buildHtmlDocument,
  embedImages,
  outlineFromHeadingHtml,
  UnsafeCssBoundaryError,
  type HtmlExportOptions,
} from './html-export.js';
import { buildPrintHtml, runPrint } from './pdf-export.js';

/** 活动标签的导出快照（由调用方从 TabManager/DOM 现取）。 */
export interface ExportTabSnapshot {
  /** 标签标题（用作 <title> 与默认导出文件名）。 */
  readonly title: string;
  /** 文档路径；null 表示未保存（图片走会话暂存目录解析）。 */
  readonly filePath: string | null;
  /** 会话 id（TabState.syntheticId），未保存文档定位暂存图片用。 */
  readonly sessionId: string;
  /** 编辑器渲染内容的序列化 HTML（见 serializeEditorContent）。 */
  readonly contentHtml: string;
}

export interface ExportServiceDeps {
  /** 现取活动标签快照；无活动标签返回 null。阅读器导出可能需先内嵌包内图。 */
  readonly getActiveSnapshot: () => ExportTabSnapshot | Promise<ExportTabSnapshot | null> | null;
  /** 当前主题 id（<html> 的 data-theme 值）。 */
  readonly getTheme: () => string;
  /** 导出 CSS 全文（生产为 buildExportCss(+自定义主题)）。 */
  readonly getCssText: () => string;
  /**
   * 读取相对路径图片为 base64（生产为 Rust read_image_base64）。
   * docPath 非 null 时相对文档目录解析；否则相对 sessionId 的暂存目录。
   */
  readonly readImageBase64: (
    docPath: string | null,
    sessionId: string | null,
    relPath: string,
  ) => Promise<string>;
  /** 「导出 HTML」保存对话框；用户取消返回 null。 */
  readonly showHtmlSaveDialog: (defaultPath?: string) => Promise<string | null>;
  /** 原子写文件（生产为 file-service 的 writeFile）。 */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** 触发打印（生产为 printViaHiddenIframe）。 */
  readonly printHtml: (html: string) => void;
  /** 「导出 PDF」原生保存对话框（生产为 .pdf 过滤）；用户取消返回 null。可选。 */
  readonly showPdfSaveDialog?: (defaultPath?: string) => Promise<string | null>;
  /**
   * 原生矢量 PDF 导出（生产为挂导出根 + invoke('print_webview_to_pdf')）。
   * 可选：提供时优先走原生路径（含可选文字）；失败/缺省回退到 printHtml。
   */
  readonly printPdfNative?: (html: string, path: string) => Promise<void>;
  /**
   * R1/T6：是否 macOS（生产为 isMacPlatform()）。macOS 上原生 createPDF 是唯一
   * 可靠 PDF 路径——原生失败不回退 window.print（WKWebView 打印 bug + 系统打印
   * 对话框，见 pdf-export.ts 注释）。缺省视为非 macOS（保留 printHtml 回退，
   * Windows/Linux 行为不变）。
   */
  readonly isMacOS?: () => boolean;
  /** Localized explanation used when custom CSS crosses the HTML style boundary. */
  readonly getUnsafeCssErrorMessage?: () => string;
  readonly reportError: (message: string, error: unknown) => void;
}

/** 可序列化的最小宿主结构（生产为标签宿主 HTMLElement）。 */
export interface HostLike {
  querySelector(selector: string): { innerHTML: string } | null;
  readonly innerHTML?: string;
}

/**
 * 提取编辑器渲染内容 HTML：优先取宿主内 `.ProseMirror` 的 innerHTML
 * （编辑区正文），取不到时回退宿主自身 innerHTML。
 */
export function serializeEditorContent(host: HostLike): string {
  const pm = host.querySelector('.ProseMirror');
  return pm?.innerHTML ?? host.innerHTML ?? '';
}

/** 默认导出文件名：标签标题去掉扩展名后加 .html。 */
export function defaultExportFileName(title: string): string {
  const stem = title.replace(/\.[^./\\]+$/, '').trim();
  return `${stem === '' ? '未命名' : stem}.html`;
}

interface AssembledExport {
  readonly options: HtmlExportOptions;
  /** 读取失败、保留原 src 的图片相对路径。 */
  readonly missingImages: readonly string[];
}

function reportDocumentBuildError(
  deps: ExportServiceDeps,
  fallbackMessage: string,
  error: unknown,
): void {
  const message =
    error instanceof UnsafeCssBoundaryError
      ? (deps.getUnsafeCssErrorMessage?.() ?? fallbackMessage)
      : fallbackMessage;
  deps.reportError(message, error);
}

/**
 * 装配当前活动标签的导出选项（内容内嵌图片 + 主题 + CSS）。
 * 无活动标签返回 null；图片读取失败中止导出并上报。
 */
async function assembleActiveTab(
  deps: ExportServiceDeps,
): Promise<AssembledExport | null> {
  const snap = await deps.getActiveSnapshot();
  if (snap === null) {
    return null;
  }
  const embedded = await embedImages(snap.contentHtml, (relPath) =>
    deps.readImageBase64(
      snap.filePath,
      snap.filePath === null ? snap.sessionId : null,
      relPath,
    ),
  );
  if (embedded.missing.length > 0) {
    throw new Error(
      `有 ${embedded.missing.length} 张图片读取失败: ${embedded.missing.join(', ')}`,
    );
  }
  const outlined = outlineFromHeadingHtml(embedded.html);
  return {
    options: {
      title: snap.title,
      theme: deps.getTheme(),
      bodyHtml: outlined.bodyHtml,
      cssText: deps.getCssText(),
      outline: outlined.outline,
    },
    missingImages: embedded.missing,
  };
}

/**
 * 导出 HTML：装配 → 保存对话框 → 原子写。成功返回写盘的目标路径；用户取消
 * 或失败返回 null（失败经 reportError 上报）。
 */
export async function exportActiveTabHtml(deps: ExportServiceDeps): Promise<string | null> {
  let assembled: AssembledExport | null;
  try {
    assembled = await assembleActiveTab(deps);
  } catch (error) {
    deps.reportError('导出 HTML 失败', error);
    return null;
  }
  if (assembled === null) {
    deps.reportError('没有可导出的活动标签', null);
    return null;
  }
  let html: string;
  try {
    html = buildHtmlDocument(assembled.options);
  } catch (error) {
    reportDocumentBuildError(deps, '导出 HTML 失败', error);
    return null;
  }
  const target = await deps.showHtmlSaveDialog(defaultExportFileName(assembled.options.title));
  if (target === null) {
    return null;
  }
  try {
    await deps.writeFile(target, html);
    return target;
  } catch (error) {
    deps.reportError('导出 HTML 失败', error);
    return null;
  }
}

/**
 * 导出 PDF：装配 → 原生矢量 PDF（Windows WebView2 PrintToPdf / macOS WKWebView
 * createPDF），失败时非 macOS 回退 window.print 系统打印对话框。macOS（R1/T6）
 * 以原生为唯一路径：原生失败只 reportError 一次并返回 null，不回退 window.print
 * （WKWebView 打印 bug + 系统打印对话框）。无活动标签返回 null。原生路径成功返回
 * 写盘的 PDF 路径；回退 window.print 分支返回 null——落盘由用户在系统打印对话框
 * 完成，此处无路径可报。
 */
export async function exportActiveTabPdf(deps: ExportServiceDeps): Promise<string | null> {
  let assembled: AssembledExport | null;
  try {
    assembled = await assembleActiveTab(deps);
  } catch (error) {
    deps.reportError('导出 PDF 失败', error);
    return null;
  }
  if (assembled === null) {
    deps.reportError('没有可导出的活动标签', null);
    return null;
  }
  let html: string;
  try {
    html = buildPrintHtml(assembled.options);
  } catch (error) {
    reportDocumentBuildError(deps, '导出 PDF 失败', error);
    return null;
  }
  const isMac = deps.isMacOS?.() === true;

  // 优先原生矢量 PDF（Windows WebView2 PrintToPdf / macOS WKWebView createPDF）：
  // 含可选文字、保真度最高。
  if (deps.showPdfSaveDialog !== undefined && deps.printPdfNative !== undefined) {
    const target = await deps.showPdfSaveDialog(
      defaultExportFileName(assembled.options.title).replace(/\.html$/i, '.pdf'),
    );
    if (target === null) {
      return null; // 用户取消
    }
    try {
      await deps.printPdfNative(html, target);
      return target;
    } catch (error) {
      if (isMac) {
        // R1/T6：macOS 原生 createPDF 是唯一可靠路径（window.print 在 WKWebView
        // 因 Apple 打印 bug 不可靠，且会弹系统打印对话框）。失败只上报一次，不回退。
        deps.reportError('导出 PDF 失败', error);
        return null;
      }
      // 非 macOS：原生失败（平台不支持 / 运行时缺接口）→ 回退到打印对话框。
      deps.reportError('原生 PDF 导出失败，改用打印对话框', error);
    }
  } else if (isMac) {
    // macOS 但原生导出未注入（不应发生，main.ts 总注入）：防御性上报，不回退 window.print。
    deps.reportError('导出 PDF 失败：原生导出未配置', null);
    return null;
  }

  // 回退：window.print() 系统对话框（Linux 主路径；Windows 兜底；macOS 不达此分支）。
  runPrint(html, deps.printHtml);
  return null;
}
