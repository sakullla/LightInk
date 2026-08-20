/**
 * Filename series / title parsing for local EPUB shelf items (R5).
 *
 * Pure functions only. Parent directories never participate.
 * Informative names keep the filename as the shelf title; volume rules
 * expose a series stem for later smart groups. Does not write
 * `LibraryItem.series`.
 */

import { extOfPath } from '../file/path-ext.js';

export interface FilenameSeriesParse {
  /** True when the basename has a real title, or a stem plus volume. */
  readonly informative: boolean;
  /** Basename without extension; trailing decorations may be stripped. */
  readonly title: string;
  /** Stem after removing the first volume, author prefix, and decorations. */
  readonly seriesStem?: string;
  /** First volume token (digits or 上/中/下). */
  readonly volume?: string;
}

interface VolumeHit {
  readonly index: number;
  readonly length: number;
  readonly volume: string;
}

interface VolumeRule {
  readonly pattern: RegExp;
  readonly volumeOf: (match: RegExpExecArray) => string | undefined;
}

const CN_DIGIT: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const TRAILING_DECORATION_RE =
  /(?:\s*[(（][^()（）]*[)）]|\s*\[[^\[\]]*\]|\s*【[^】]*】)+\s*$/u;

const AUTHOR_PREFIX_RE = /^(?:\[[^\[\]]+\]\s*)+/u;

const ONLY_DIGITS_RE = /^[0-9]+$/;

const VOLUME_RULES: readonly VolumeRule[] = [
  {
    pattern: /第([0-9]+|[一二三四五六七八九十百两〇零]+)[卷册巻]/u,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /(?<![A-Za-z])[Vv]ol(?:ume)?\.?\s*([0-9]+)/,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /(?<![A-Za-z0-9])[Vv]([0-9]+)/,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /([0-9]+)巻/u,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /[卷册]([0-9]+)/u,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /([上中下])[册卷巻]/u,
    volumeOf: (match) => match[1],
  },
  {
    pattern: /[(（]\s*([上中下])[册卷巻]?\s*[)）]/u,
    volumeOf: (match) => match[1],
  },
  {
    pattern: /(?:^|[-–—_·・.\s])([上中下])(?=$|[-–—_·・.\s(（[])/u,
    volumeOf: (match) => match[1],
  },
  {
    pattern: /[-–—_]\s*([0-9]{1,4})\b/,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /(?<=[》」』\u3400-\u9fff])([0-9]{1,3})$/u,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
  {
    pattern: /\s+([0-9]{1,3})$/,
    volumeOf: (match) => normalizeVolumeToken(match[1] ?? ''),
  },
];

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

function stripExtension(basename: string): string {
  const extension = extOfPath(basename);
  if (extension === '') {
    return basename;
  }
  return basename.slice(0, -(extension.length + 1));
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function parseChineseNumeral(token: string): string | undefined {
  if (token === '十') {
    return '10';
  }
  if (token === '百') {
    return '100';
  }
  const ten = token.indexOf('十');
  if (ten === -1) {
    if (token.length === 1) {
      const digit = CN_DIGIT[token];
      return digit === undefined ? undefined : String(digit);
    }
    return undefined;
  }
  const tensChar = ten === 0 ? undefined : token[0];
  const onesChar = ten === token.length - 1 ? undefined : token[ten + 1];
  const tens = ten === 0 ? 1 : tensChar === undefined ? undefined : CN_DIGIT[tensChar];
  const ones = onesChar === undefined ? 0 : CN_DIGIT[onesChar];
  if (tens === undefined || ones === undefined) {
    return undefined;
  }
  return String(tens * 10 + ones);
}

function normalizeVolumeToken(token: string): string | undefined {
  const ascii = toAsciiDigits(token).trim();
  if (ascii === '') {
    return undefined;
  }
  if (ONLY_DIGITS_RE.test(ascii)) {
    return ascii;
  }
  return parseChineseNumeral(ascii);
}

function stripAuthorPrefix(text: string): string {
  const stripped = text.replace(AUTHOR_PREFIX_RE, '').trim();
  return stripped === '' ? text : stripped;
}

function stripTrailingDecorations(text: string): string {
  return text.replace(TRAILING_DECORATION_RE, '').trim();
}

function unwrapTitleMarks(text: string): string {
  const marked = text.match(/^[《「『]([^》」』]+)[》」』]$/u);
  return marked?.[1]?.trim() || text;
}

function cleanStem(text: string): string {
  let current = stripTrailingDecorations(text.trim());
  current = current.replace(/[-–—_·・.\s(（[【]+$/u, '').trim();
  return unwrapTitleMarks(stripTrailingDecorations(current));
}

function findFirstVolume(text: string): VolumeHit | undefined {
  let best: VolumeHit | undefined;
  for (const rule of VOLUME_RULES) {
    const match = rule.pattern.exec(text);
    if (match === null || match.index === undefined) {
      continue;
    }
    const volume = rule.volumeOf(match);
    if (volume === undefined || volume === '') {
      continue;
    }
    const hit: VolumeHit = { index: match.index, length: match[0].length, volume };
    if (
      best === undefined ||
      hit.index < best.index ||
      (hit.index === best.index && hit.length > best.length)
    ) {
      best = hit;
    }
  }
  return best;
}

function isOnlyDigits(text: string): boolean {
  return ONLY_DIGITS_RE.test(toAsciiDigits(text).trim());
}

/**
 * Parse a local book path or basename into a shelf title and optional series.
 *
 * Uninformative names (`2`, `01`, `v02`) keep no series stem so callers can
 * fall back to `dc:title` and skip a filename series group.
 */
export function parseFilenameSeries(path: string): FilenameSeriesParse {
  const raw = toAsciiDigits(stripExtension(basenameOf(path))).trim();
  const title = stripTrailingDecorations(raw) || raw;
  if (raw === '') {
    return { informative: false, title };
  }

  const working = stripAuthorPrefix(raw);
  const hit = findFirstVolume(working);
  if (hit !== undefined) {
    const stem = cleanStem(working.slice(0, hit.index));
    if (stem !== '') {
      return { informative: true, title, seriesStem: stem, volume: hit.volume };
    }
    const after = cleanStem(working.slice(hit.index + hit.length));
    if (after !== '' && !isOnlyDigits(after)) {
      return { informative: true, title, volume: hit.volume };
    }
    return { informative: false, title };
  }

  const decorated = cleanStem(working);
  if (decorated === '' || isOnlyDigits(decorated)) {
    return { informative: false, title };
  }
  return { informative: true, title };
}

/**
 * Prefer an informative filename over EPUB `dc:title`.
 * Uninformative names and missing titles fall back to `dcTitle`, then basename.
 */
export function resolveLocalEpubTitle(path: string, dcTitle?: string): string {
  const parsed = parseFilenameSeries(path);
  if (parsed.informative && parsed.title !== '') {
    return parsed.title;
  }
  const fallback = (dcTitle ?? '').trim();
  if (fallback !== '') {
    return fallback;
  }
  return parsed.title;
}
