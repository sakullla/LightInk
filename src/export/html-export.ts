/**
 * `html-export` — 独立 HTML 文档装配与图片内嵌（T10, R5）。纯逻辑层，
 * 不触达 DOM / Tauri IPC，全部依赖以参数注入，vitest 在 node 环境直测。
 *
 * 保真策略：导出的 body HTML 来自活动编辑器渲染后的 DOM 序列化
 * （`.ProseMirror` 的 innerHTML，由 export-service 提取），而非用 markdown
 * 重新渲染 —— 代码高亮（hljs 类）、KaTeX 公式、mermaid SVG 等 widget
 * 装饰原样携带，「与编辑器内渲染一致」由构造保证。样式由
 * export-css.ts 装配并整体内嵌进 `<style>`。
 *
 * 图片内嵌：编辑器内的图片引用是相对路径（`assets/<name>.<ext>`、
 * 同级 `*-assets/…` 等），独立 HTML 离开文档目录后即失效，因此导出时
 * 把相对 src 的图片读为 base64 并改写为 data URI（读取由注入的 resolver
 * 完成，生产走 Rust `read_image_base64`，已保存文档按文档目录沙箱）。
 * 已是绝对 URL（http(s):/data:/blob: 等）的图片保留原 src 不动。读取
 * 失败的图片：保留原 src 并列入 `missing`（导出继续，调用方负责提示），
 * 不静默丢弃也不中断整个导出。
 */

export interface HtmlExportOutlineItem {
  readonly level: number;
  readonly text: string;
  readonly id: string;
}

export interface HtmlExportOptions {
  /** 文档标题（写入 <title>，会做 HTML 转义）。 */
  readonly title: string;
  /** 当前主题 id（写入 <html data-theme>）；空串回退 'warm-light'。 */
  readonly theme: string;
  /** 序列化后的编辑器内容 HTML（原样放入 <body>，不做消毒/改写）。 */
  readonly bodyHtml: string;
  /** 内嵌样式文本（生产为 buildExportCss 的产物）。 */
  readonly cssText: string;
  /** 可选目录：写入导航 + 标题 id，供 PDF 书签定位。 */
  readonly outline?: readonly HtmlExportOutlineItem[];
}

const STYLE_END_BOUNDARY = /<\/style/i;

export class UnsafeCssBoundaryError extends Error {
  constructor() {
    super('CSS contains the reserved </style sequence');
    this.name = 'UnsafeCssBoundaryError';
  }
}

/** CSS is embedded in an HTML raw-text element and must not contain its end boundary. */
export function assertSafeCssBoundary(cssText: string): void {
  if (STYLE_END_BOUNDARY.test(cssText)) {
    throw new UnsafeCssBoundaryError();
  }
}

/** 文本节点转义（<title> 用）。 */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性值转义（data-theme 用）。 */
export function escapeHtmlAttr(text: string): string {
  return escapeHtmlText(text).replace(/"/g, '&quot;');
}

function slugifyHeading(text: string, used: Map<string, number>): string {
  const ascii = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/[^\x00-\x7f]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = ascii === '' ? 'section' : ascii;
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

/** 按文档顺序给 h1-h6 补稳定 id，并生成与大纲侧栏同序的目录项。 */
export function outlineFromHeadingHtml(html: string): {
  bodyHtml: string;
  outline: HtmlExportOutlineItem[];
} {
  const used = new Map<string, number>();
  const outline: HtmlExportOutlineItem[] = [];
  const bodyHtml = html.replace(
    /<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/h[1-6]>/gi,
    (full, tag: string, attrs = '', inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      const existing = attrs.match(/\sid\s*=\s*("([^"]*)"|'([^']*)')/i);
      const id = existing?.[2] ?? existing?.[3] ?? slugifyHeading(text || `section-${outline.length + 1}`, used);
      outline.push({
        level: Number(tag.slice(1)),
        text: text === '' ? id : text,
        id,
      });
      if (existing !== null) {
        return full;
      }
      return `<${tag}${attrs} id="${escapeHtmlAttr(id)}">${inner}</${tag}>`;
    },
  );
  return { bodyHtml, outline };
}

function renderExportToc(items: readonly HtmlExportOutlineItem[]): string {
  if (items.length === 0) {
    return '';
  }
  const rows = items
    .map((item) => {
      const indent = Math.min(6, Math.max(1, item.level));
      return `<li class="lightink-export-toc-item level-${indent}"><a href="#${escapeHtmlAttr(item.id)}">${escapeHtmlText(item.text)}</a></li>`;
    })
    .join('');
  return `<nav class="lightink-export-toc" aria-label="Outline"><ol>${rows}</ol></nav>`;
}

/**
 * 装配独立 HTML 文档：doctype + `<html data-theme>` + charset utf-8 +
 * 内嵌 `<style>` + 内容。charset 必须在文档前 1024 字节内才可靠，
 * 故 `<meta charset>` 放在 head 第一位。
 */
export function buildHtmlDocument(opts: HtmlExportOptions): string {
  assertSafeCssBoundary(opts.cssText);
  const theme = opts.theme.trim() === '' ? 'warm-light' : opts.theme;
  const toc = renderExportToc(opts.outline ?? []);
  return [
    '<!DOCTYPE html>',
    `<html lang="zh-CN" data-theme="${escapeHtmlAttr(theme)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="LightInk 轻墨">',
    `<title>${escapeHtmlText(opts.title)}</title>`,
    `<style>${opts.cssText}</style>`,
    '</head>',
    '<body class="lightink-prose">',
    ...(toc === '' ? [] : [toc]),
    opts.bodyHtml,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 文件扩展名 → 图片 MIME（data URI 用）；未知扩展回退 octet-stream。 */
export function mimeFromPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 该 src 是否需要/可以内嵌：仅相对路径（`assets/x.png`、`./x.png`、
 * `note-assets/x.png`）。带 scheme 的（http:/https:/data:/blob:/file: 等）
 * 与协议相对（//host/x）一律保留原样。越界 `../` 由后端沙箱拒绝读取。
 */
export function isEmbeddableImageSrc(src: string): boolean {
  if (src.startsWith('//')) {
    return false;
  }
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
}

/** 匹配 <img> 标签内的双引号 src（innerHTML 序列化产物恒为双引号）。 */
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi;

/**
 * innerHTML 序列化会把属性值里的 `&` 等字符实体编码（如 `a&amp;b.png`）。
 * 解析文件路径前需还原，否则含这些字符的文件名会被误判 missing。
 * 单趟替换避免链式二次解码（`&amp;lt;` 只解一层为 `&lt;`，不再变 `<`）。
 */
const ATTR_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

function decodeAttrEntities(src: string): string {
  return src.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_whole, name: string) => ATTR_ENTITY_MAP[name] ?? _whole,
  );
}

export interface EmbedImagesResult {
  /** 相对图片已改写为 data URI 后的 HTML。 */
  readonly html: string;
  /** 成功内嵌的相对 src 列表（去重）。 */
  readonly embedded: readonly string[];
  /** 读取失败、保留原 src 的相对 src 列表（去重）。 */
  readonly missing: readonly string[];
}

/**
 * 把 HTML 中相对路径的 <img> src 内嵌为 data URI。resolver 返回 base64
 * 字符串；返回 null 或抛错均视为读取失败（保留原 src 并记入 missing）。
 * 同一 src 只解析一次（缓存），所有出现处一起改写。
 */
export async function embedImages(
  html: string,
  resolve: (relPath: string) => Promise<string | null>,
): Promise<EmbedImagesResult> {
  const srcs = [...html.matchAll(IMG_SRC_RE)].map((m) => m[2]);
  const uniqueRelSrcs = [...new Set(srcs)].filter(isEmbeddableImageSrc);

  const cache = new Map<string, string | null>();
  for (const src of uniqueRelSrcs) {
    let base64: string | null = null;
    try {
      // resolver 需要真实文件路径：先还原 innerHTML 序列化时的实体编码。
      base64 = await resolve(decodeAttrEntities(src));
    } catch {
      base64 = null;
    }
    cache.set(src, base64 === '' ? null : base64);
  }

  const embedded: string[] = [];
  const missing: string[] = [];
  for (const [src, base64] of cache) {
    // 对外展示用解码后的真实文件名（encoded 形式仅用于 HTML 替换定位）。
    (base64 === null ? missing : embedded).push(decodeAttrEntities(src));
  }

  const out = html.replace(
    IMG_SRC_RE,
    (whole: string, pre: string, src: string, post: string) => {
      const base64 = cache.get(src);
      if (base64 === undefined || base64 === null) {
        return whole;
      }
      return `${pre}data:${mimeFromPath(src)};base64,${base64}${post}`;
    },
  );
  return { html: out, embedded, missing };
}
