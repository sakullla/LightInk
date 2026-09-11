/**
 * Markdown paste handler.
 *
 * When a user pastes plain text into the editor we need to decide:
 *   - paste it as plain text (current paragraph), or
 *   - parse it as markdown and replace selection with a structured block.
 *
 * The heuristic in `looksLikeMarkdown` covers the common markers
 * (headings, bullet markers, ordered lists, blockquote, fenced code, tables,
 * task list ` [ ]` / ` [x]`, horizontal rules). The function is intentionally
 * a fast O(n) scan — once any marker matches we return true, no need to
 * validate the whole document.
 */

import { collectMdastTypes, parseDocument } from './parser.js';
import type { ParsedDocument } from './types.js';

export type PasteKind = 'markdown' | 'plain';

/** Custom MIME for LightInk Markdown source (same-app round-trip). */
export const LIGHTINK_MARKDOWN_MIME = 'application/x-lightink-markdown' as const;

const LIGHTINK_HTML_ATTR = /data-lightink-clipboard\s*=\s*(['"]?)markdown\1/i;
const LIGHTINK_HTML_COMMENT = /<!--\s*lightink-clipboard:markdown\s*-->/i;

export type ClipboardPasteAction =
  | { readonly kind: 'markdown-source'; readonly text: string }
  | { readonly kind: 'html'; readonly html: string }
  | { readonly kind: 'plain' };

export interface ClipboardPasteInput {
  readonly html: string;
  readonly text: string;
  readonly ownMarkdown?: string;
}

/** Markers used by the markdown detector. Order matters for readability only. */
const HEADING_MARKER = /(^|\n)#{1,6}\s+\S/;
const BULLET_MARKER = /(^|\n)\s*[-*+]\s+\S/;
const ORDERED_MARKER = /(^|\n)\s*\d+\.\s+\S/;
const BLOCKQUOTE_MARKER = /(^|\n)>\s+\S/;
const FENCED_CODE_MARKER = /(^|\n)```/;
const TABLE_MARKER = /(^|\n)\|.+\|.+\n\s*\|?\s*[-:|\s]+\|/;
const TASK_MARKER = /(^|\n)\s*[-*+]\s+\[[ xX]\]\s+\S/;
const HR_MARKER = /(^|\n)(-{3,}|\*{3,}|_{3,})(\s*$|\n)/;
const LINK_MARKER = /\[[^\]\n]{1,200}\]\([^)\n]{1,400}\)/;
const IMAGE_MARKER = /!\[[^\]\n]{0,200}\]\([^)\n]{0,400}\)/;
const STRIKETHROUGH_MARKER = /~~[^~\n]{1,400}~~/;
const INLINE_EMPHASIS_MARKER = /(^|\W)(\*\*[^*\n]{1,400}\*\*|\*[^*\n]{1,400}\*|`[^`\n]{1,400}`)/;

/**
 * Cheap, allocation-light check: does this text look like markdown we want
 * to render rather than drop in as plain text?
 */
export function looksLikeMarkdown(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (HEADING_MARKER.test(text)) return true;
  if (BULLET_MARKER.test(text)) return true;
  if (ORDERED_MARKER.test(text)) return true;
  if (BLOCKQUOTE_MARKER.test(text)) return true;
  if (FENCED_CODE_MARKER.test(text)) return true;
  if (TABLE_MARKER.test(text)) return true;
  if (TASK_MARKER.test(text)) return true;
  if (HR_MARKER.test(text)) return true;
  if (IMAGE_MARKER.test(text)) return true;
  if (STRIKETHROUGH_MARKER.test(text)) return true;
  if (INLINE_EMPHASIS_MARKER.test(text)) return true;
  // Link markers are very common in prose; only enable for short samples.
  if (text.length <= 4096 && LINK_MARKER.test(text)) return true;
  return false;
}

export interface PastePayload {
  readonly kind: PasteKind;
  readonly text: string;
  /**
   * Parsed document. Only populated when `kind === 'markdown'`.
   * Undefined for plain-text pastes (the consumer should fall back to the
   * text body).
   */
  readonly parsed?: ParsedDocument;
}

/**
 * Build a paste payload from raw clipboard text. Detects whether to treat
 * the paste as markdown or as plain text, and in the markdown case attaches
 * a pre-parsed `ParsedDocument` so the consumer can call
 * `editor.setMarkdown()` or replace the selection without re-parsing.
 */
export function buildPastePayload(text: string): PastePayload {
  const normalized = typeof text === 'string' ? text : String(text ?? '');
  if (!looksLikeMarkdown(normalized)) {
    return { kind: 'plain', text: normalized };
  }
  const parsed = parseDocument(normalized);
  return { kind: 'markdown', text: normalized, parsed };
}

/**
 * 剪贴板粘贴路由（R9）：给定剪贴板纯文本，判定应作为 Markdown 源解析还是作为
 * 纯文本交默认粘贴。纯逻辑（复用 `buildPastePayload`），供 `clipboard-md` 插件与
 * 测试使用。
 */
export function routeClipboardPaste(text: string): PasteKind {
  return buildPastePayload(text).kind;
}

/**
 * 安全读取剪贴板某 MIME：部分宿主对自定义/未知 MIME 调 getData 会抛错或返回非串。
 */
export function readClipboardMime(dt: DataTransfer | null | undefined, mime: string): string {
  if (dt === null || dt === undefined) return '';
  try {
    return dt.getData(mime) ?? '';
  } catch {
    return '';
  }
}

/** True when HTML was written by LightInk dual-format copy. */
export function isLightInkClipboardHtml(html: string): boolean {
  if (typeof html !== 'string' || html.length === 0) return false;
  return LIGHTINK_HTML_ATTR.test(html) || LIGHTINK_HTML_COMMENT.test(html);
}

/** Wrap rendered selection HTML with a LightInk marker Word/Feishu will not emit. */
export function wrapLightInkClipboardHtml(innerHtml: string): string {
  if (typeof innerHtml !== 'string' || innerHtml === '') return '';
  if (isLightInkClipboardHtml(innerHtml)) return innerHtml;
  return `<!--lightink-clipboard:markdown--><div data-lightink-clipboard="markdown">${innerHtml}</div>`;
}

/**
 * Dual-format paste router: LightInk copies prefer Markdown source; external
 * HTML still converts; plain-only markdown uses the existing heuristic.
 */
export function resolveClipboardPaste(input: ClipboardPasteInput): ClipboardPasteAction {
  const html = typeof input.html === 'string' ? input.html : '';
  const text = typeof input.text === 'string' ? input.text : '';
  const own = typeof input.ownMarkdown === 'string' ? input.ownMarkdown : '';
  const fromSelf = own !== '' || isLightInkClipboardHtml(html);
  if (fromSelf) {
    const source = own !== '' ? own : text;
    if (source !== '') {
      return { kind: 'markdown-source', text: source };
    }
  }
  if (html !== '') {
    return { kind: 'html', html };
  }
  if (routeClipboardPaste(text) === 'markdown') {
    return { kind: 'markdown-source', text };
  }
  return { kind: 'plain' };
}

/**
 * Verify a payload's parsed structure actually produced structured nodes
 * (i.e. not just a single paragraph). Used in tests and as a sanity check
 * before we route the paste through the editor's structured insertion.
 */
export function payloadHasStructuredBlocks(payload: PastePayload): boolean {
  if (payload.kind !== 'markdown' || !payload.parsed) return false;
  const types = collectMdastTypes(payload.parsed.root);
  // A bare plain-text document would yield at most `paragraph` + `text` nodes.
  return types.some(
    (t) =>
      t !== 'root' &&
      t !== 'paragraph' &&
      t !== 'text' &&
      t !== 'break' &&
      t !== 'html',
  );
}
