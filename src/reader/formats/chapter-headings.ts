/**
 * 流式网文唯一行首标题 / 假目录 / 不足 4 章篇幅切开 owner。
 *
 * TXT 必走；FB2 / MOBI / 瘦 EPUB 仅在原生结构章数 < 4 时把抽出的纯文本交给这里。
 * 打开期只扫边界并填 title；章数 > 8 时仅前 EAGER_CHAPTER_COUNT 章急切 html，
 * 其余经 ReaderChapter.load 幂等物化，对齐 flow 窗口。
 */

import { escapeHtml } from '../html-escape.js';
import type { ReaderChapter, ReaderContent } from './types.js';

/** 章数 > 8 时急切物化的章数，对齐 flow 窗口。 */
export const EAGER_CHAPTER_COUNT = 2;

const MAX_HEADING_CHARS = 30;
const MIN_HEADING_CHAPTERS = 4;
const LENGTH_SPLIT_CHARS = 8000;
const MIN_FAKE_TOC_RUN = 3;
const NUMBER_CLASS = '零〇一二三四五六七八九十百千万两0-9';
const NUMBERED_HEADING = new RegExp(
  `^第\\s*([${NUMBER_CLASS}]+)\\s*([章回节卷])(.*)$`,
);
const SPECIAL_HEADING = /^(序章|序言|楔子|引子|前言|后记|尾声|番外)/;
const ENGLISH_HEADING = /^Chapter\s+\d+\b/i;

interface HeadingHit {
  start: number;
  end: number;
  title: string;
}

interface ChapterRange {
  title: string;
  start: number;
  end: number;
}

/**
 * 从纯文本切章。只认独立行；trim 后 ≤30 字；匹配 第X章/回/节（含第0001章）、
 * 序章|序言|楔子|引子|前言|后记|尾声|番外、行首 Chapter X。
 * 第X卷只作分界（假目录/卷首），合并进随后的章，不单独占一章、不计入章数。
 * 不切句中第X章；排除 部分/节课/部门/部队/集合 与 前言不搭后语。
 * 有效标题 < 4：在段落边界按约 8000 汉字切开。扉页保留。书前假目录不切空章。
 * 章数 > 8：仅前 EAGER_CHAPTER_COUNT 章 html 非空，其余 html==='' 且提供幂等 load()。
 */
export function splitPlainTextChapters(text: string): ReaderContent {
  const source = text.replace(/\r\n?/g, '\n');
  if (source.trim().length === 0) {
    return { chapters: [{ title: '', html: '' }] };
  }

  const realHits = selectRealHeadings(source, collectHeadingHits(source));
  const ranges =
    realHits.length >= MIN_HEADING_CHAPTERS
      ? mergeVolumeRanges(rangesFromHeadings(source, realHits))
      : rangesFromLength(source);

  return { chapters: materializeChapters(source, ranges) };
}

function collectHeadingHits(source: string): HeadingHit[] {
  const hits: HeadingHit[] = [];
  let start = 0;
  while (start <= source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline;
    const title = headingTitleAt(source, start, end);
    if (title !== null) {
      hits.push({ start, end, title });
    }
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
  return hits;
}

function isTrimWs(code: number): boolean {
  return (
    code <= 32 ||
    code === 0xa0 ||
    code === 0x3000 ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

function headingTitleAt(source: string, start: number, end: number): string | null {
  let from = start;
  let to = end;
  while (from < to && isTrimWs(source.charCodeAt(from))) {
    from += 1;
  }
  while (to > from && isTrimWs(source.charCodeAt(to - 1))) {
    to -= 1;
  }
  if (from === to || to - from > MAX_HEADING_CHARS) {
    return null;
  }
  const trimmed = source.slice(from, to);
  if (trimmed.includes('前言不搭后语')) {
    return null;
  }
  const unwrapped = unwrapHeading(trimmed);
  return isHeadingText(unwrapped) ? unwrapped : null;
}

function unwrapHeading(line: string): string {
  const unwrapped = line
    .replace(/^[【\[（(「『《]+/, '')
    .replace(/[】\]）)」』》]+$/, '')
    .trim();
  return unwrapped.length > 0 ? unwrapped : line;
}

function isHeadingText(line: string): boolean {
  if (ENGLISH_HEADING.test(line)) {
    return true;
  }
  if (SPECIAL_HEADING.test(line)) {
    return true;
  }
  const numbered = NUMBERED_HEADING.exec(line);
  if (numbered === null) {
    return false;
  }
  const unit = numbered[2];
  const rest = numbered[3] ?? '';
  return !(unit === '节' && rest.startsWith('课'));
}

function selectRealHeadings(
  source: string,
  hits: readonly HeadingHit[],
): HeadingHit[] {
  if (hits.length === 0) {
    return [];
  }

  const fake = new Set<number>();
  const lastIndexByTitle = new Map<string, number>();
  for (let index = 0; index < hits.length; index += 1) {
    lastIndexByTitle.set(hits[index]!.title, index);
  }

  for (let index = 0; index < hits.length; index += 1) {
    if (!headingHasBody(source, hits, index) && (lastIndexByTitle.get(hits[index]!.title) ?? index) > index) {
      fake.add(index);
    }
  }

  let emptyRun = 0;
  for (let index = 0; index < hits.length; index += 1) {
    if (headingHasBody(source, hits, index)) {
      break;
    }
    emptyRun += 1;
  }
  if (emptyRun >= MIN_FAKE_TOC_RUN) {
    for (let index = 0; index < emptyRun; index += 1) {
      fake.add(index);
    }
  }

  return hits.filter((_, index) => !fake.has(index));
}

function headingHasBody(
  source: string,
  hits: readonly HeadingHit[],
  index: number,
): boolean {
  const from = hits[index]!.end;
  const until = index + 1 < hits.length ? hits[index + 1]!.start : source.length;
  for (let offset = from; offset < until; offset += 1) {
    const code = source.charCodeAt(offset);
    if (code !== 10 && code !== 13 && code !== 32 && code !== 9) {
      return true;
    }
  }
  return false;
}

function rangesFromHeadings(source: string, hits: readonly HeadingHit[]): ChapterRange[] {
  const ranges: ChapterRange[] = [];
  const firstStart = hits[0]!.start;
  if (firstStart > 0 && source.slice(0, firstStart).trim().length > 0) {
    ranges.push({ title: '', start: 0, end: firstStart });
  }
  for (let index = 0; index < hits.length; index += 1) {
    const end = index + 1 < hits.length ? hits[index + 1]!.start : source.length;
    ranges.push({ title: hits[index]!.title, start: hits[index]!.start, end });
  }
  return ranges;
}

/** 第X卷 is a divider, not a numbered chapter. Fold it into the following 章. */
function isVolumeHeadingTitle(title: string): boolean {
  const numbered = NUMBERED_HEADING.exec(title.trim());
  return numbered !== null && numbered[2] === '卷';
}

function mergeVolumeRanges(ranges: readonly ChapterRange[]): ChapterRange[] {
  const pending = ranges.map((range) => ({ ...range }));
  const merged: ChapterRange[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    const range = pending[index]!;
    if (!isVolumeHeadingTitle(range.title)) {
      merged.push(range);
      continue;
    }
    const next = pending[index + 1];
    if (next !== undefined) {
      pending[index + 1] = { ...next, start: range.start };
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous !== undefined) {
      merged[merged.length - 1] = { ...previous, end: range.end };
    } else {
      merged.push({ title: '', start: range.start, end: range.end });
    }
  }
  return merged;
}

interface ParagraphSpan {
  start: number;
  end: number;
  chars: number;
}

function rangesFromLength(source: string): ChapterRange[] {
  const spans = collectParagraphSpans(source);
  if (spans.length === 0) {
    return [{ title: '', start: 0, end: source.length }];
  }

  const groups: ParagraphSpan[][] = [];
  let current: ParagraphSpan[] = [];
  let chars = 0;
  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      chars = 0;
    }
  };

  for (const span of spans) {
    if (current.length > 0 && chars + span.chars > LENGTH_SPLIT_CHARS) {
      flush();
    }
    current.push(span);
    chars += span.chars;
  }
  flush();

  return groups.map((group) => ({
    title: '',
    start: group[0]!.start,
    end: group[group.length - 1]!.end,
  }));
}

function collectParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function collectParagraphSpans(text: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = [];
  const pieces = text.split(/(\n{2,})/);
  let offset = 0;
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    if (index % 2 === 0) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        const lead = piece.length - piece.trimStart().length;
        const start = offset + lead;
        const end = start + trimmed.length;
        if (countChars(trimmed) > LENGTH_SPLIT_CHARS) {
          spans.push(...splitOversizedParagraph(text, start, end));
        } else {
          spans.push({ start, end, chars: countChars(trimmed) });
        }
      }
    }
    offset += piece.length;
  }
  return spans;
}

function splitOversizedParagraph(source: string, start: number, end: number): ParagraphSpan[] {
  const paragraph = source.slice(start, end);
  const lines = paragraph.split('\n');
  if (lines.length <= 1) {
    return [{ start, end, chars: countChars(paragraph) }];
  }

  const spans: ParagraphSpan[] = [];
  let currentStart = -1;
  let currentEnd = -1;
  let chars = 0;
  let cursor = start;
  const flush = (): void => {
    if (currentStart >= 0) {
      spans.push({ start: currentStart, end: currentEnd, chars });
      currentStart = -1;
      currentEnd = -1;
      chars = 0;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineStart = cursor;
    const lineEnd = cursor + line.length;
    cursor = lineEnd + 1;
    if (line.trim().length === 0) {
      continue;
    }
    const size = countChars(line);
    if (currentStart >= 0 && chars + size > LENGTH_SPLIT_CHARS) {
      flush();
    }
    if (currentStart < 0) {
      currentStart = lineStart + (line.length - line.trimStart().length);
    }
    currentEnd = lineEnd - (line.length - line.trimEnd().length);
    chars += size;
  }
  flush();
  return spans.length > 0 ? spans : [{ start, end, chars: countChars(paragraph) }];
}

function countChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

function materializeChapters(source: string, ranges: readonly ChapterRange[]): ReaderChapter[] {
  const lazy = ranges.length > 8;
  return ranges.map((range, index) => {
    const eager = !lazy || index < EAGER_CHAPTER_COUNT;
    if (eager) {
      return {
        title: range.title,
        html: textToHtml(source.slice(range.start, range.end)),
      };
    }
    const chapter: ReaderChapter = {
      title: range.title,
      html: '',
    };
    let loaded = false;
    let inflight: Promise<void> | null = null;
    const start = range.start;
    const end = range.end;
    chapter.load = (): Promise<void> => {
      if (loaded) {
        return Promise.resolve();
      }
      if (inflight !== null) {
        return inflight;
      }
      inflight = Promise.resolve().then(() => {
        chapter.html = textToHtml(source.slice(start, end));
        loaded = true;
      });
      return inflight;
    };
    return chapter;
  });
}

function textToHtml(text: string): string {
  return collectParagraphs(text)
    .flatMap((paragraph) => splitParagraphOnHeadings(paragraph))
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Web-novel TXT often uses a single newline after the heading, so
 * `\n\n` paragraph splitting leaves `第X章 …<br>正文` in one block.
 * Scroll chrome already paints that title; a fused first line doubles it.
 */
function splitParagraphOnHeadings(paragraph: string): string[] {
  const lines = paragraph.split('\n');
  if (lines.length <= 1) {
    return [paragraph];
  }
  const blocks: string[] = [];
  let buffer: string[] = [];
  const flush = (): void => {
    const piece = buffer.join('\n').trim();
    if (piece.length > 0) {
      blocks.push(piece);
    }
    buffer = [];
  };
  for (const line of lines) {
    if (headingTitleAt(line, 0, line.length) !== null) {
      flush();
      blocks.push(line.trim());
    } else {
      buffer.push(line);
    }
  }
  flush();
  return blocks.length > 0 ? blocks : [paragraph];
}
