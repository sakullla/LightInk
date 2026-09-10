/**
 * `assistant-markdown` — 助手回复的 Markdown 渲染（R3 / R10）。
 *
 * - 解析：`unified` + `remark-parse` + `remark-gfm`（与编辑器同一解析栈），
 *   mdast → 受控 HTML 序列化（所有文本经转义，`html` 节点按纯文本显示，不执行）。
 * - 覆盖：标题、列表（含任务列表）、引用、代码块、表格、链接、强调、删除线、
 *   分隔线、换行、行内代码。
 * - 不渲染：mermaid、公式、图片（R10）——围栏语言 mermaid/math 按普通代码块
 *   显示；图片降级为 `[alt]` 文本。
 * - 消毒：模型输出视为不可信，序列化结果再经 DOMPurify 独立实例过一遍
 *   （脚本、iframe、原始 HTML、事件属性、`javascript:` 链接均不落地）。
 * - 链接：外部链接只放行 http(s)（`rel="noopener"`，点击由面板委托宿主的外部
 *   打开策略；mailto 等其它协议按纯文本显示）；`lightink://chapter/<i>`
 *   渲染为按钮（`data-locate`），用户点击后由宿主跳转。
 * - 流式：累计全文再渲染；未闭合围栏在渲染前临时补齐，后续文本不会被吞进
 *   代码块、也不会闪回原始标记。
 * - 代码高亮：只对应用已允许（且已装载）的语言做高亮；未装载时先按纯文本
 *   显示并触发装载，装载完成经 `onLanguageLoaded` 请求重渲染。
 * - 失败：解析/消毒异常时降级为纯文本段落，界面不崩溃。
 */

import createDOMPurify, { type DOMPurify, type WindowLike } from 'dompurify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type {
  Blockquote,
  Code,
  Heading,
  Link,
  List,
  ListItem,
  Node,
  Parent,
  Root,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import {
  ensureHighlightLanguage,
  highlightEngine,
  isHighlightLanguageLoaded,
  resolveHighlightLanguage,
} from '../editor/plugins/code-languages.js';
import { parseAssistantLocate } from './assistant-tools.js';

export const ASSISTANT_LOCATE_CLASS = 'lightink-reader-assistant-locate';
export const ASSISTANT_MARKDOWN_CLASS = 'lightink-reader-assistant-markdown';

const ALLOWED_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'span',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'a',
  'strong',
  'em',
  'del',
  'br',
  'hr',
  'button',
] as const;

const ALLOWED_ATTR = ['href', 'class', 'start', 'align', 'rel', 'type', 'data-locate', 'data-lang'] as const;

const EXTERNAL_LINK = /^https?:/i;

let purifierWindow: WindowLike | null = null;
let purifier: DOMPurify | null = null;

function markdownPurifier(): DOMPurify {
  const currentWindow = globalThis.window as unknown as WindowLike | undefined;
  if (currentWindow === undefined) {
    throw new Error('Assistant markdown rendering requires a DOM window');
  }
  if (purifier !== null && purifierWindow === currentWindow) {
    return purifier;
  }
  purifier = createDOMPurify(currentWindow);
  purifierWindow = currentWindow;
  return purifier;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 流式中未闭合的代码围栏临时补齐：按行统计围栏开合，奇数则在末尾补一个与
 * 最后一次开围栏同长的闭合围栏。
 */
export function closeOpenFences(markdown: string): string {
  let openFence: string | null = null;
  for (const rawLine of markdown.split('\n')) {
    // 围栏可以嵌在引用块 / 列表项里：剥掉前导的 > 与列表标记再识别。
    const line = rawLine.replace(/^(?:\s{0,3}(?:>|[-*+]|\d{1,9}[.)])\s?)*\s{0,3}/, '');
    const match = /^(`{3,}|~{3,})/.exec(line);
    if (match === null) {
      continue;
    }
    const fence = match[1]!;
    if (openFence === null) {
      openFence = fence;
    } else if (fence[0] === openFence[0] && fence.length >= openFence.length) {
      openFence = null;
    }
  }
  if (openFence === null) {
    return markdown;
  }
  return `${markdown}${markdown.endsWith('\n') ? '' : '\n'}${openFence}`;
}

/** 正在装载的语言 → 等待重渲染的回调（同一语言多次请求都要收到通知，不只第一个）。 */
const pendingLanguages = new Map<string, Array<() => void>>();

function highlightBlock(code: string, lang: string | null, onLoaded?: () => void): string {
  const resolved = lang === null ? null : resolveHighlightLanguage(lang);
  if (resolved === null) {
    return escapeHtml(code);
  }
  if (isHighlightLanguageLoaded(resolved)) {
    try {
      return highlightEngine.highlight(code, { language: resolved, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(code);
    }
  }
  if (onLoaded !== undefined) {
    const waiters = pendingLanguages.get(resolved);
    if (waiters !== undefined) {
      waiters.push(onLoaded);
    } else {
      const list = [onLoaded];
      pendingLanguages.set(resolved, list);
      void ensureHighlightLanguage(resolved)
        .then(() => {
          for (const callback of list) {
            callback();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          pendingLanguages.delete(resolved);
        });
    }
  }
  return escapeHtml(code);
}

interface SerializeOptions {
  readonly onLanguageLoaded?: () => void;
  /** 无 alt 图片的占位文案（i18n 由调用方给）。 */
  readonly imageFallback?: string;
  /** 引用式链接 / 图片的定义表（identifier → url）。 */
  readonly definitions?: ReadonlyMap<string, string>;
}

function nodeValue(node: Node): string {
  const value = (node as unknown as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
}

function nodeIdentifier(node: Node): string {
  const identifier = (node as unknown as { identifier?: unknown }).identifier;
  return typeof identifier === 'string' ? identifier : '';
}

function children(node: Node, options: SerializeOptions): string {
  const parent = node as Partial<Parent>;
  if (!Array.isArray(parent.children)) {
    return '';
  }
  return parent.children.map((child) => serialize(child, options)).join('');
}

function plainText(node: Node): string {
  if (node.type === 'text' || node.type === 'inlineCode') {
    return nodeValue(node);
  }
  const parent = node as Partial<Parent>;
  if (!Array.isArray(parent.children)) {
    return '';
  }
  return parent.children.map(plainText).join('');
}

function serializeLink(node: Link, options: SerializeOptions): string {
  const inner = children(node, options);
  const href = (node.url ?? '').trim();
  const locate = parseAssistantLocate(href);
  if (locate !== null) {
    const target = locate.kind === 'chapter' ? `chapter:${locate.index}` : `page:${locate.page}`;
    return `<button type="button" class="${ASSISTANT_LOCATE_CLASS}" data-locate="${target}">${inner}</button>`;
  }
  if (EXTERNAL_LINK.test(href) && !/[\u0000-\u0020]/.test(href)) {
    return `<a href="${escapeHtml(href)}" rel="noopener">${inner}</a>`;
  }
  return inner;
}

function serializeList(node: List, options: SerializeOptions): string {
  const tag = node.ordered === true ? 'ol' : 'ul';
  const start =
    node.ordered === true && typeof node.start === 'number' && node.start !== 1
      ? ` start="${node.start}"`
      : '';
  const items = (node.children ?? [])
    .map((item) => serializeListItem(item as ListItem, options))
    .join('');
  return `<${tag}${start}>${items}</${tag}>`;
}

function serializeListItem(node: ListItem, options: SerializeOptions): string {
  const marker =
    node.checked === true ? '☑ ' : node.checked === false ? '☐ ' : '';
  const body = (node.children ?? [])
    .map((child) => {
      if (child.type === 'paragraph' && node.spread !== true) {
        return children(child, options);
      }
      return serialize(child, options);
    })
    .join('');
  return `<li>${marker}${body}</li>`;
}

function serializeTable(node: Table, options: SerializeOptions): string {
  const rows = node.children ?? [];
  if (rows.length === 0) {
    return '';
  }
  const aligns = node.align ?? [];
  const cell = (row: TableRow, tag: 'th' | 'td'): string =>
    (row.children ?? [])
      .map((item, index) => {
        const align = aligns[index];
        const attr = align === 'left' || align === 'center' || align === 'right' ? ` align="${align}"` : '';
        return `<${tag}${attr}>${children(item as TableCell, options)}</${tag}>`;
      })
      .join('');
  const [head, ...body] = rows;
  const thead = `<thead><tr>${cell(head!, 'th')}</tr></thead>`;
  const tbody =
    body.length === 0 ? '' : `<tbody>${body.map((row) => `<tr>${cell(row, 'td')}</tr>`).join('')}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

function serialize(node: Node, options: SerializeOptions): string {
  switch (node.type) {
    case 'root':
      return children(node, options);
    case 'paragraph':
      return `<p>${children(node, options)}</p>`;
    case 'heading': {
      const depth = Math.min(6, Math.max(1, (node as Heading).depth));
      return `<h${depth}>${children(node, options)}</h${depth}>`;
    }
    case 'text':
      return escapeHtml(nodeValue(node));
    case 'emphasis':
      return `<em>${children(node, options)}</em>`;
    case 'strong':
      return `<strong>${children(node, options)}</strong>`;
    case 'delete':
      return `<del>${children(node, options)}</del>`;
    case 'inlineCode':
      return `<code>${escapeHtml(nodeValue(node))}</code>`;
    case 'code': {
      const code = node as Code;
      const lang = code.lang?.trim() ?? '';
      const body = highlightBlock(code.value ?? '', lang === '' ? null : lang, options.onLanguageLoaded);
      const langAttr = lang === '' ? '' : ` data-lang="${escapeHtml(lang)}"`;
      return `<pre${langAttr}><code>${body}</code></pre>`;
    }
    case 'blockquote':
      return `<blockquote>${children(node as Blockquote, options)}</blockquote>`;
    case 'list':
      return serializeList(node as List, options);
    case 'listItem':
      return serializeListItem(node as ListItem, options);
    case 'thematicBreak':
      return '<hr>';
    case 'break':
      return '<br>';
    case 'link':
      return serializeLink(node as Link, options);
    case 'linkReference': {
      // [text][ref] + [ref]: url —— 解析定义表后按普通链接处理（定位链接也常被写成引用式）。
      const url = options.definitions?.get(nodeIdentifier(node));
      if (url !== undefined) {
        return serializeLink({ ...(node as Link), type: 'link', url } as Link, options);
      }
      return children(node, options);
    }
    case 'image':
    case 'imageReference': {
      const alt = (node as { alt?: string | null }).alt ?? '';
      return escapeHtml(alt === '' ? (options.imageFallback ?? '[image]') : `[${alt}]`);
    }
    case 'table':
      return serializeTable(node as Table, options);
    case 'html':
      return escapeHtml(nodeValue(node));
    case 'footnoteReference':
      return escapeHtml(`[^${nodeIdentifier(node)}]`);
    case 'footnoteDefinition':
      return `<p>${escapeHtml(`[^${nodeIdentifier(node)}]:`)} ${children(node, options)}</p>`;
    case 'definition':
    case 'yaml':
      return '';
    default:
      return children(node, options) || escapeHtml(plainText(node));
  }
}

export interface RenderAssistantMarkdownOptions {
  /** 流式中：未闭合围栏临时补齐。 */
  readonly streaming?: boolean;
  /** 代码语言装载完成后请求重渲染。 */
  readonly onLanguageLoaded?: () => void;
  /** 无 alt 图片的占位文案。 */
  readonly imageFallback?: string;
}

/** 解析器只建一次：每次渲染都 use() 一遍插件是白花的分配。 */
const markdownProcessor = unified().use(remarkParse).use(remarkGfm).freeze();

function collectDefinitions(tree: Root): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  const visit = (node: Node): void => {
    if (node.type === 'definition') {
      const identifier = nodeIdentifier(node);
      const url = ((node as { url?: string }).url ?? '').trim();
      if (identifier !== '' && url !== '' && !definitions.has(identifier)) {
        definitions.set(identifier, url);
      }
    }
    for (const child of (node as { children?: Node[] }).children ?? []) {
      visit(child);
    }
  };
  visit(tree);
  return definitions;
}

/** Markdown → 受控 HTML 字符串（已转义、未消毒；供测试与 render 使用）。 */
export function assistantMarkdownToHtml(
  markdown: string,
  options: RenderAssistantMarkdownOptions = {},
): string {
  const source = options.streaming === true ? closeOpenFences(markdown) : markdown;
  const tree = markdownProcessor.parse(source) as Root;
  return serialize(tree, {
    onLanguageLoaded: options.onLanguageLoaded,
    imageFallback: options.imageFallback,
    definitions: collectDefinitions(tree),
  });
}

/**
 * 渲染助手消息：返回消毒后的容器元素。任何解析/消毒失败都降级为纯文本段落。
 */
export function renderAssistantMarkdown(
  markdown: string,
  options: RenderAssistantMarkdownOptions = {},
): HTMLElement {
  const container = document.createElement('div');
  container.className = ASSISTANT_MARKDOWN_CLASS;
  try {
    const html = assistantMarkdownToHtml(markdown, options);
    const fragment = markdownPurifier().sanitize(html, {
      ALLOWED_TAGS: [...ALLOWED_TAGS],
      ALLOWED_ATTR: [...ALLOWED_ATTR],
      ALLOW_DATA_ATTR: false, // 只放行 ALLOWED_ATTR 里点名的 data-locate / data-lang
      ALLOW_ARIA_ATTR: false,
      ALLOWED_URI_REGEXP: /^https?:/i,
      // 非 URI 属性的值不按 URI 正则校验（否则 rel/type/start/align 会被整个剥掉）。
      ADD_URI_SAFE_ATTR: ['rel', 'type', 'start', 'align', 'data-lang', 'data-locate'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'img', 'svg', 'math'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'srcset', 'ping', 'formaction'],
      RETURN_DOM_FRAGMENT: true,
    });
    container.appendChild(fragment);
  } catch {
    container.replaceChildren();
    const fallback = document.createElement('p');
    fallback.textContent = markdown;
    container.appendChild(fallback);
  }
  return container;
}
