/**
 * `link-classify` — 纯链接分类（无编辑器引擎依赖）。
 *
 * 从 `link-navigation.ts` 拆出：壳层点击链接时需要 `classifyLink`，但不应因此把
 * Milkdown/ProseMirror 拉进入口包。`link-navigation.ts` 仍重导出本模块，保持既有
 * 导入路径与测试不变。
 */

export type LinkKind = 'external' | 'localMd' | 'localFile' | 'invalid';

export interface ClassifiedLink {
  kind: LinkKind;
  /** external: canonical HTTP(S) URL; local*: resolved path; invalid: empty. */
  target: string;
}

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL = /^https?:\/\//i;
const PROTOCOL_RELATIVE = /^\/\//;
const WINDOWS_DRIVE_ABS = /^[a-z]:[\\/]/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_CHARACTER = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

/** Normalize a browser target while rejecting custom schemes and parser bypasses. */
export function normalizeExternalHttpUrl(href: string): string | null {
  if (CONTROL_CHARACTERS.test(href) || ENCODED_CONTROL_CHARACTER.test(href)) {
    return null;
  }
  const value = href.trim();
  const candidate = PROTOCOL_RELATIVE.test(value)
    ? `https:${value}`
    : HTTP_URL.test(value)
      ? value
      : null;
  if (candidate === null) return null;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function hidesExternalSyntaxWithEncoding(value: string): boolean {
  if (!value.includes('%')) return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded !== value &&
      (EXTERNAL_SCHEME.test(decoded) || PROTOCOL_RELATIVE.test(decoded))
    );
  } catch {
    return false;
  }
}

/** Pure: classify href with optional current document directory. */
export function classifyLink(href: string, currentDocDir: string): ClassifiedLink {
  if (typeof href !== 'string' || CONTROL_CHARACTERS.test(href)) {
    return { kind: 'invalid', target: '' };
  }
  const h = href.trim();
  if (h === '') {
    return { kind: 'invalid', target: '' };
  }
  if (HTTP_URL.test(h) || PROTOCOL_RELATIVE.test(h)) {
    const target = normalizeExternalHttpUrl(h);
    return target === null
      ? { kind: 'invalid', target: '' }
      : { kind: 'external', target };
  }
  if (
    (EXTERNAL_SCHEME.test(h) && !WINDOWS_DRIVE_ABS.test(h)) ||
    hidesExternalSyntaxWithEncoding(h)
  ) {
    return { kind: 'invalid', target: '' };
  }
  const pathPart = h.split(/[#?]/)[0] ?? '';
  if (pathPart === '') {
    return { kind: 'invalid', target: '' };
  }
  const resolved = resolveLocalPath(pathPart, currentDocDir);
  return MARKDOWN_EXT.test(pathPart)
    ? { kind: 'localMd', target: resolved }
    : { kind: 'localFile', target: resolved };
}

/** Resolve local path: absolute as-is, relative against current doc dir. */
export function resolveLocalPath(pathPart: string, currentDocDir: string): string {
  if (pathPart === '') {
    return '';
  }
  if (pathPart.startsWith('/') || WINDOWS_DRIVE_ABS.test(pathPart)) {
    return pathPart;
  }
  const base = currentDocDir.replace(/[\\/]+$/, '');
  if (base === '') {
    return pathPart;
  }
  return `${base}/${pathPart}`;
}
