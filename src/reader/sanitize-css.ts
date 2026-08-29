/**
 * Sanitize untrusted EPUB publisher CSS before it is inlined into a chapter frame.
 *
 * The frame already forbids scripts and remote stylesheets. This pass still
 * strips constructs that can cover chrome, fetch remote resources, or break
 * out of the wrapping `<style>` element.
 */

import { READER_LIMITS } from './reader-limits.js';

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CSS_COMMENTS = /\/\*[\s\S]*?\*\//g;
const CSS_IMPORT = /@import\b[^;{]*;?/gi;
const CSS_NAMESPACE = /@namespace\b[^;{]*;?/gi;
const CSS_URL = /url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
const CSS_EXPRESSION = /expression\s*\(/gi;
const CSS_MOZ_BINDING = /-moz-binding\s*:/gi;
const CSS_BEHAVIOR = /behavior\s*:/gi;
const CSS_FIXED_POSITION = /position\s*:\s*(?:fixed|sticky)\b/gi;
const CSS_USER_SELECT = /(?:-webkit-|-moz-|-ms-)?user-select\s*:[^;]+;?/gi;
const CSS_ROOT_HEIGHT = /(?:html|body)(?:\s*,\s*(?:html|body))*\s*\{[^}]*\}/gi;
const STYLE_END_BOUNDARY = /<\/style/gi;
/** 转义解码后可能出现裸 `<script` 文本（如 content 字符串）；一并剥除。 */
const HTML_SCRIPT_OPEN = /<script/gi;

function neutralizeRootViewportRules(block: string): string {
  return block
    .replace(/(?:min-|max-)?height\s*:\s*[^;]+;?/gi, '')
    .replace(/overflow(?:-[xy])?\s*:\s*[^;]+;?/gi, '')
    .replace(/pointer-events\s*:\s*[^;]+;?/gi, '')
    .replace(/touch-action\s*:\s*[^;]+;?/gi, '');
}

/**
 * Decode CSS escapes (css-syntax-3 §4.3.2) before sanitizing: the browser
 * decodes `u\72 l(…)` to `url(…)`, so regexes on the raw text would let
 * escaped constructs slip through (remote fetch / style breakout).
 */
export function decodeCssEscapes(input: string): string {
  return input.replace(
    /\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|(.))/gs,
    (_match, hex: string | undefined, ch: string | undefined) => {
      if (hex !== undefined && hex !== '') {
        const code = Number.parseInt(hex, 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
          return '�';
        }
        return String.fromCodePoint(code);
      }
      return ch ?? '';
    },
  );
}

/** Return publisher CSS that is safe to embed in a reader `<style>` tag. */
export function sanitizeReaderCss(input: string): string {
  const bounded =
    input.length > READER_LIMITS.maxCssBytes
      ? input.slice(0, READER_LIMITS.maxCssBytes)
      : input;
  const decoded = decodeCssEscapes(bounded);
  return decoded
    .replace(CSS_COMMENTS, '')
    .replace(CSS_IMPORT, '')
    .replace(CSS_NAMESPACE, '')
    .replace(CSS_URL, () => 'none')
    .replace(CSS_EXPRESSION, 'invalid(')
    .replace(CSS_MOZ_BINDING, 'invalid:')
    .replace(CSS_BEHAVIOR, 'invalid:')
    .replace(CSS_FIXED_POSITION, 'position: static')
    .replace(CSS_USER_SELECT, '')
    .replace(CSS_ROOT_HEIGHT, (block) => neutralizeRootViewportRules(block))
    .replace(STYLE_END_BOUNDARY, '')
    .replace(HTML_SCRIPT_OPEN, '')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
}
