/**
 * `export-css` — 导出样式装配（T10, R5）。
 *
 * 导出 HTML / PDF 打印视图都是脱离应用的独立文档，所需样式必须内嵌：
 *   - `tokens.css` 经 `?raw` 原样读入：`[data-theme]` 令牌 + hljs 语法高亮
 *     映射全部在此，导出文档带上同一 `data-theme` 属性即与编辑器配色一致
 *     （含语法高亮）；自定义主题 CSS 由调用方经 `buildExportCss(extra)` 追加；
 *   - `katex.min.css` 经 `?inline` 由 Vite 内联；其中 @font-face 引用的
 *     KaTeX 字体由 vite.config.ts 的 `build.assetsInlineLimit` 回调强制
 *     内联为 data URI（woff2/ttf 超过默认 4KB 上限，不设该回调时字体仍是
 *     独立文件、独立 HTML 经 file:// 打开会 404），公式在独立 HTML 中
 *     离线可用；
 *   - `prose.css` 经 `?raw` 原样读入：标题比例、块级节奏与 CJK 处理的唯一源，
 *     选择器为 `.lightink-prose`；导出 body / PDF 根挂同一 class 即复用；
 *   - `EXPORT_BASE_CSS` 只保留导出文档壳层（背景/栏宽/内边距/代码块边框等），
 *     并在 `body.lightink-prose` 上以令牌覆盖 14px/1.7 打印向基准，使
 *     `--lightink-rhythm-unit` 与 font-size/line-height 取同一组值。
 *     应用外壳样式（工具栏/标签栏）不进入导出文档。
 *
 * 中文字体策略（R5「PDF 中文无乱码」）：正文与等宽字体走
 * `var(--lightink-font-body)` / `var(--lightink-font-mono)`（tokens.css
 * 系统 CJK 栈），WebView 打印走系统字体，Windows/macOS 上中文不会出现
 * 豆腐块；KaTeX 数学字体随 CSS 内嵌。
 *
 * 注意：vitest（node 环境）不处理 CSS 导入，`?raw`/`?inline` 在测试下得到
 * 空串。因此纯逻辑（html-export / pdf-export）一律以 `cssText` 参数注入，
 * 本模块只做生产装配；测试只断言本模块自身可组合（见 __tests__）。
 */

import katexCss from 'katex/dist/katex.min.css?inline';
import proseCss from '../theme/prose.css?raw';
import tokensCss from '../theme/tokens.css?raw';

/** 导出文档壳层（栏宽/色/边框）。排版节奏由 prose.css 提供；14px/1.7 打印向基准在此覆盖。 */
export const EXPORT_BASE_CSS = `/* LightInk 导出文档基础样式（与编辑器共用 prose.css，作用域 body.lightink-prose） */
body.lightink-prose {
  background: var(--lightink-bg);
  color: var(--lightink-fg);
  --lightink-font-size: 14px;
  --lightink-line-height-body: 1.7;
  --lightink-font-scale: 1;
  font-family: var(--lightink-font-body);
  font-size: var(--lightink-font-size);
  line-height: var(--lightink-line-height-body);
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 32px 48px;
}
/* PDF 主窗口根不是 body：同一组打印向令牌必须挂在 .lightink-prose 根上，
   否则 rhythm-unit 会落到 tokens.css 的 16px/1.75。 */
#lightink-export-print-root.lightink-prose {
  --lightink-font-size: 14px;
  --lightink-line-height-body: 1.7;
  --lightink-font-scale: 1;
  font-family: var(--lightink-font-body);
  font-size: var(--lightink-font-size);
  line-height: var(--lightink-line-height-body);
}
pre {
  background: var(--lightink-code-bg);
  border: 1px solid var(--lightink-border);
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
}
code {
  font-family: var(--lightink-font-mono);
}
:not(pre) > code {
  background: var(--lightink-code-bg);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 0.92em;
}
blockquote {
  padding-left: 14px;
  border-left: 3px solid var(--lightink-border);
  color: var(--lightink-muted);
}
a { color: var(--lightink-accent); }
hr { border: none; border-top: 1px solid var(--lightink-border); }
/* 默认响应式；显式宽度（nodeView 写入 width 样式）不被钳制（R12）。 */
img { max-width: 100%; height: auto; }
img[style*="width"] { max-width: none; }
/* nodeView 交互 chrome（缩放柄/对齐条）不得外泄到导出文档——PM 失焦不调
   deselectNode，选中态可能保留，故用 !important 兜底隐藏（R12 导出无回归）。 */
.lightink-image-handle, .lightink-image-alignbar { display: none !important; }
table { border-collapse: collapse; }
th, td { border: 1px solid var(--lightink-border); padding: 4px 10px; }
th { background: var(--lightink-bg-elevated); }
.lightink-export-toc {
  margin: 0 0 1.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--lightink-border);
  border-radius: 6px;
  background: var(--lightink-bg-elevated);
}
.lightink-export-toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.lightink-export-toc-item { margin: 0.15rem 0; }
.lightink-export-toc-item.level-2 { padding-left: 1rem; }
.lightink-export-toc-item.level-3 { padding-left: 2rem; }
.lightink-export-toc-item.level-4 { padding-left: 3rem; }
.lightink-export-toc-item.level-5 { padding-left: 4rem; }
.lightink-export-toc-item.level-6 { padding-left: 5rem; }
.lightink-export-toc a { color: inherit; text-decoration: none; }
.lightink-export-toc a:hover { color: var(--lightink-accent); }
.lightink-math-error, .lightink-mermaid-error { color: var(--lightink-accent); }
::selection { background: var(--lightink-selection); }
`;

/**
 * 装配导出 CSS：主题令牌 + prose 排版 + KaTeX 样式（含内嵌字体）+ 导出壳层
 * + 可选附加 CSS（生产为当前自定义主题文本；内置主题时传空串）。
 */
export function buildExportCss(extraCss = ''): string {
  return [tokensCss, proseCss, katexCss, EXPORT_BASE_CSS, extraCss]
    .filter((part) => part.length > 0)
    .join('\n');
}
