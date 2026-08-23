/**
 * `path-ext` — 路径扩展名的唯一事实来源。
 *
 * 语义：取最后一个路径段（同时接受 `/` 与 `\` 分隔符）的小写扩展名；
 * 无扩展名、点文件（如 `.gitignore`）或以点结尾的文件名返回 `''`。
 * file 域与 reader 侧的路径扩展名判断都必须从这里导入，禁止再本地定义。
 */
export function extOfPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Typical UTF-8-as-Latin-1 / Windows-1252 leftovers (Chinese names become æ/å/ç… tofu). */
const UTF8_MOJIBAKE_HINT = /[ÃÂæçåéèêëïîìÄÅÆøØŸŒ€…]/;

/** Maps Windows-1252 punctuation back to the original UTF-8 byte. */
const WINDOWS_1252_REVERSE: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

function decodeOncePercent(value: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function bytesFromMisdecoded(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0xff) {
      bytes[index] = code;
      continue;
    }
    const mapped = WINDOWS_1252_REVERSE[code];
    if (mapped === undefined) {
      return null;
    }
    bytes[index] = mapped;
  }
  return bytes;
}

function recoverUtf8Mojibake(value: string): string {
  if (!UTF8_MOJIBAKE_HINT.test(value)) {
    return value;
  }
  const bytes = bytesFromMisdecoded(value);
  if (bytes === null) {
    return value;
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u3400-\u9fff]/.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const hash = normalized.indexOf('#');
  const query = normalized.indexOf('?');
  const cut = Math.min(
    hash === -1 ? normalized.length : hash,
    query === -1 ? normalized.length : query,
  );
  const withoutSuffix = normalized.slice(0, cut);
  const base = withoutSuffix.slice(withoutSuffix.lastIndexOf('/') + 1);
  return base || withoutSuffix;
}

/**
 * Human file name for chrome (open-progress, tabs, toasts).
 * Decodes a single percent-encoding pass and UTF-8 bytes that were
 * misread as Latin-1 so Chinese names do not show as `%E6…` or `æ˜Ÿ`.
 */
export function displayNameOfPath(path: string): string {
  const raw = path.trim();
  if (raw === '') {
    return path;
  }
  let candidate = raw;
  if (/^file:/i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      // Keep the raw path and still decode the last segment.
    }
  }
  let base = decodeOncePercent(lastPathSegment(candidate));
  if (/[\\/]/.test(base)) {
    base = lastPathSegment(base);
  }
  const decoded = recoverUtf8Mojibake(base);
  return decoded === '' ? path : decoded;
}
