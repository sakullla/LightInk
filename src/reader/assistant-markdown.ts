/**
 * Sanitized GFM rendering for assistant replies (R3 / ADR-5).
 *
 * Parses with `parseMarkdownToMdast` (remark-gfm), emits HTML, then runs a
 * DOMPurify config independent of the reader allowlist: headings/lists/quotes/
 * code/tables/links/emphasis are kept; img/iframe/script/`javascript:` are not.
 * Unclosed fences stay plain text so they cannot swallow later copy. Sanitize
 * or parse failure falls back to escaped text.
 */

import type { Root as MdastRoot } from 'mdast';
import createDOMPurify, {
  type DOMPurify,
  type UponSanitizeAttributeHookEvent,
  type WindowLike,
} from 'dompurify';

import { parseMarkdownToMdast } from '../editor/parser.js';
import {
  highlightEngine as hljs,
  isHighlightLanguageLoaded,
  resolveHighlightLanguage,
} from '../editor/plugins/code-languages.js';
import { escapeHtml } from './html-escape.js';

const ASSISTANT_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

const ASSISTANT_ATTRIBUTES = [
  'class',
  'colspan',
  'data-chapter',
  'data-page',
  'href',
  'rel',
  'rowspan',
  'start',
  'title',
] as const;

const FORBIDDEN_TAGS = [
  'applet',
  'audio',
  'base',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'img',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'video',
] as const;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CHAPTER_HREF = /^chapter:(.+)$/i;
const PAGE_HREF = /^page:(.+)$/i;
const PLAIN_FENCE_TAGS = new Set(['text', 'plain', 'plaintext', 'txt', 'none']);
const DIAGRAM_FENCE_TAGS = new Set(['mermaid', 'math', 'latex', 'katex']);

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  url?: string | null;
  title?: string | null;
  alt?: string | null;
  identifier?: string | null;
  label?: string | null;
};

type LinkDefinition = {
  url: string;
  title?: string | null;
};

let purifierWindow: WindowLike | null = null;
let purifier: DOMPurify | null = null;

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function renderPlainText(text: string): string {
  if (text.length === 0) return '';
  return escapeHtml(text).replace(/\r\n|\n|\r/g, '<br>');
}

function isAllowedAssistantHref(rawValue: string): boolean {
  const value = rawValue.trim();
  if (value === '' || CONTROL_CHARACTERS.test(value) || value.startsWith('//')) {
    return false;
  }
  const match = value.match(SCHEME);
  if (match === null) {
    return value.startsWith('#');
  }
  const scheme = match[1]!.toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

function assistantPurifier(): DOMPurify {
  const currentWindow = globalThis.window as unknown as WindowLike | undefined;
  if (currentWindow === undefined) {
    throw new Error('Assistant markdown sanitization requires a DOM window');
  }
  if (purifier !== null && purifierWindow === currentWindow) {
    return purifier;
  }

  const next = createDOMPurify(currentWindow);
  next.addHook(
    'uponSanitizeAttribute',
    (node: Element, event: UponSanitizeAttributeHookEvent) => {
      const attribute = event.attrName.toLowerCase();
      if (attribute === 'href' && !isAllowedAssistantHref(event.attrValue)) {
        event.keepAttr = false;
      }
      if (
        (attribute === 'data-chapter' || attribute === 'data-page') &&
        node.tagName.toLowerCase() !== 'a'
      ) {
        event.keepAttr = false;
      }
    },
  );
  purifierWindow = currentWindow;
  purifier = next;
  return next;
}

function sanitizeAssistantHtml(html: string): string {
  const fragment = assistantPurifier().sanitize(html, {
    ALLOWED_TAGS: [...ASSISTANT_TAGS],
    ALLOWED_ATTR: [...ASSISTANT_ATTRIBUTES],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: [...FORBIDDEN_TAGS],
    FORBID_ATTR: ['style', 'src', 'srcset', 'ping', 'formaction', 'xlink:href'],
    RETURN_DOM_FRAGMENT: true,
  });
  const container = document.createElement('div');
  container.appendChild(fragment);
  if (container.querySelector('img, script, iframe') !== null) {
    throw new Error('Assistant markdown sanitizer leaked forbidden tags');
  }
  return container.innerHTML;
}

/**
 * Split off a trailing unclosed ` ``` ` / `~~~` fence so remark cannot treat
 * the remainder of the document as one code block.
 */
export function splitUnclosedFence(source: string): {
  complete: string;
  tail: string;
} {
  const lines = source.split('\n');
  let open: { char: string; len: number; startLine: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (open === null) {
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (match === null) continue;
      const marker = match[2]!;
      const info = match[3] ?? '';
      const char = marker[0]!;
      if (char === '`' && info.includes('`')) continue;
      open = { char, len: marker.length, startLine: index };
      continue;
    }

    const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (match === null) continue;
    const marker = match[2]!;
    if (marker[0] === open.char && marker.length >= open.len) {
      open = null;
    }
  }

  if (open === null) {
    return { complete: source, tail: '' };
  }
  return {
    complete: lines.slice(0, open.startLine).join('\n'),
    tail: lines.slice(open.startLine).join('\n'),
  };
}

function highlightFence(lang: string | null | undefined, value: string): string {
  const tag = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (tag === '' || PLAIN_FENCE_TAGS.has(tag) || DIAGRAM_FENCE_TAGS.has(tag)) {
    return escapeHtml(value);
  }
  const resolved = resolveHighlightLanguage(tag);
  if (resolved === null || !isHighlightLanguageLoaded(resolved)) {
    return escapeHtml(value);
  }
  try {
    return hljs.highlight(value, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(value);
  }
}

function collectDefinitions(root: MdastRoot): Map<string, LinkDefinition> {
  const defs = new Map<string, LinkDefinition>();
  const walk = (node: MdastNode): void => {
    if (
      node.type === 'definition' &&
      typeof node.identifier === 'string' &&
      typeof node.url === 'string'
    ) {
      defs.set(node.identifier.toLowerCase(), {
        url: node.url,
        title: node.title,
      });
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(root as unknown as MdastNode);
  return defs;
}

function renderLink(
  url: string,
  title: string | null | undefined,
  inner: string,
): string {
  const trimmed = url.trim();
  const chapter = CHAPTER_HREF.exec(trimmed);
  if (chapter !== null) {
    const id = chapter[1]!.trim();
    return `<a href="#chapter-${escapeAttr(id)}" data-chapter="${escapeAttr(id)}">${inner}</a>`;
  }
  const page = PAGE_HREF.exec(trimmed);
  if (page !== null) {
    const id = page[1]!.trim();
    return `<a href="#page-${escapeAttr(id)}" data-page="${escapeAttr(id)}">${inner}</a>`;
  }
  if (!isAllowedAssistantHref(trimmed)) {
    return inner;
  }
  const titleAttr =
    title !== null && title !== undefined && title.length > 0
      ? ` title="${escapeAttr(title)}"`
      : '';
  return `<a href="${escapeAttr(trimmed)}" rel="noreferrer noopener"${titleAttr}>${inner}</a>`;
}

function renderNodes(
  nodes: readonly MdastNode[] | undefined,
  defs: Map<string, LinkDefinition>,
): string {
  if (nodes === undefined) return '';
  return nodes.map((node) => renderNode(node, defs)).join('');
}

function renderNode(node: MdastNode, defs: Map<string, LinkDefinition>): string {
  switch (node.type) {
    case 'root':
      return renderNodes(node.children, defs);
    case 'paragraph':
      return `<p>${renderNodes(node.children, defs)}</p>`;
    case 'heading': {
      const depth = Math.min(Math.max(node.depth ?? 1, 1), 6);
      return `<h${depth}>${renderNodes(node.children, defs)}</h${depth}>`;
    }
    case 'blockquote':
      return `<blockquote>${renderNodes(node.children, defs)}</blockquote>`;
    case 'thematicBreak':
      return '<hr>';
    case 'break':
      return '<br>';
    case 'list': {
      const tag = node.ordered === true ? 'ol' : 'ul';
      const start =
        tag === 'ol' && typeof node.start === 'number' && node.start !== 1
          ? ` start="${escapeAttr(String(node.start))}"`
          : '';
      return `<${tag}${start}>${renderNodes(node.children, defs)}</${tag}>`;
    }
    case 'listItem': {
      const marker =
        typeof node.checked === 'boolean' ? (node.checked ? '[x] ' : '[ ] ') : '';
      return `<li>${marker}${renderNodes(node.children, defs)}</li>`;
    }
    case 'code': {
      const lang = node.lang ?? '';
      const highlighted = highlightFence(lang, node.value ?? '');
      const tag = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      const resolved = tag === '' ? null : resolveHighlightLanguage(tag);
      const className =
        resolved !== null
          ? ` class="hljs language-${escapeAttr(resolved)}"`
          : tag !== '' && !PLAIN_FENCE_TAGS.has(tag)
            ? ` class="language-${escapeAttr(tag)}"`
            : '';
      return `<pre><code${className}>${highlighted}</code></pre>`;
    }
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`;
    case 'text':
      return escapeHtml(node.value ?? '');
    case 'emphasis':
      return `<em>${renderNodes(node.children, defs)}</em>`;
    case 'strong':
      return `<strong>${renderNodes(node.children, defs)}</strong>`;
    case 'delete':
      return `<del>${renderNodes(node.children, defs)}</del>`;
    case 'link':
      return renderLink(
        node.url ?? '',
        node.title,
        renderNodes(node.children, defs),
      );
    case 'linkReference': {
      const def =
        typeof node.identifier === 'string'
          ? defs.get(node.identifier.toLowerCase())
          : undefined;
      const inner = renderNodes(node.children, defs);
      if (def === undefined) return inner;
      return renderLink(def.url, def.title, inner);
    }
    case 'image':
    case 'imageReference':
      return escapeHtml(node.alt ?? node.label ?? '');
    case 'table': {
      const rows = node.children ?? [];
      if (rows.length === 0) return '';
      const head = rows[0]!;
      const body = rows.slice(1);
      return `<table><thead>${renderTableRow(head, defs, true)}</thead><tbody>${body
        .map((row) => renderTableRow(row, defs, false))
        .join('')}</tbody></table>`;
    }
    case 'tableRow':
      return renderTableRow(node, defs, false);
    case 'tableCell':
      return `<td>${renderNodes(node.children, defs)}</td>`;
    case 'html':
      return escapeHtml(node.value ?? '');
    case 'footnoteReference':
      return escapeHtml(`[${node.label ?? node.identifier ?? ''}]`);
    case 'footnoteDefinition':
      return `<p>${escapeHtml(`[${node.label ?? node.identifier ?? ''}]: `)}${renderNodes(node.children, defs)}</p>`;
    case 'yaml':
    case 'definition':
      return '';
    default:
      return renderNodes(node.children, defs);
  }
}

function renderTableRow(
  row: MdastNode,
  defs: Map<string, LinkDefinition>,
  header: boolean,
): string {
  const tag = header ? 'th' : 'td';
  const cells = (row.children ?? [])
    .map((cell) => `<${tag}>${renderNodes(cell.children, defs)}</${tag}>`)
    .join('');
  return `<tr>${cells}</tr>`;
}

function mdastToHtml(root: MdastRoot): string {
  return renderNode(root as unknown as MdastNode, collectDefinitions(root));
}

/** Drop leftover “（当前章节）” after a chapter locator so it is not a second caption. */
function tidyCurrentChapterCitations(html: string): string {
  return html.replace(
    /(data-chapter="[^"]*"[\s\S]*?<\/a>)\s*[（(]\s*(当前章节|current chapter)\s*[)）]/gi,
    '$1',
  );
}

/** Render accumulated assistant markdown to sanitized HTML. */
export function renderAssistantMarkdown(source: string): string {
  if (typeof source !== 'string' || source.length === 0) {
    return '';
  }
  try {
    const { complete, tail } = splitUnclosedFence(source);
    const parts: string[] = [];
    if (complete.length > 0) {
      parts.push(mdastToHtml(parseMarkdownToMdast(complete)));
    }
    if (tail.length > 0) {
      parts.push(renderPlainText(tail));
    }
    return tidyCurrentChapterCitations(sanitizeAssistantHtml(parts.join('')));
  } catch {
    return renderPlainText(source);
  }
}

export interface AssistantMarkdownStream {
  append(delta: string): string;
  replace(source: string): string;
  readonly source: string;
  readonly html: string;
}

/** Incremental renderer: each delta re-renders the accumulated source. */
export function createAssistantMarkdownStream(
  initial = '',
): AssistantMarkdownStream {
  let source = typeof initial === 'string' ? initial : '';
  let html = renderAssistantMarkdown(source);
  const update = (next: string): string => {
    source = next;
    html = renderAssistantMarkdown(source);
    return html;
  };
  return {
    append(delta: string): string {
      return update(source + (typeof delta === 'string' ? delta : ''));
    },
    replace(next: string): string {
      return update(typeof next === 'string' ? next : '');
    },
    get source() {
      return source;
    },
    get html() {
      return html;
    },
  };
}
