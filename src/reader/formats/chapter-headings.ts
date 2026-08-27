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

interface TextLine {
  text: string;
  start: number;
}

interface HeadingHit {
  lineIndex: number;
  start: number;
  title: string;
}

interface ChapterRange {
  title: string;
  start: number;
  end: number;
}

/**
 * 从纯文本切章。只认独立行；trim 后 ≤30 字；匹配 第X章/回/节（含第0001章）、
 * 第X卷 / 第X卷 标题、序章|序言|楔子|引子|前言|后记|尾声|番外、行首 Chapter X。
 * 不切句中第X章；排除 部分/节课/部门/部队/集合 与 前言不搭后语。
 * 有效标题 < 4：在段落边界按约 8000 汉字切开。扉页保留。书前假目录不切空章。
 * 章数 > 8：仅前 EAGER_CHAPTER_COUNT 章 html 非空，其余 html==='' 且提供幂等 load()。
 */
export function splitPlainTextChapters(text: string): ReaderContent {
  const source = text.replace(/\r\n?/g, '\n');
  if (source.trim().length === 0) {
    return { chapters: [{ title: '', html: '' }] };
  }

  const lines = splitLines(source);
  const realHits = selectRealHeadings(lines, collectHeadingHits(lines));
  const ranges =
    realHits.length >= MIN_HEADING_CHAPTERS
      ? rangesFromHeadings(source, realHits)
      : rangesFromLength(source);

  return { chapters: materializeChapters(source, ranges) };
}

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), start });
      break;
    }
    lines.push({ text: text.slice(start, newline), start });
    start = newline + 1;
    if (start === text.length) {
      lines.push({ text: '', start });
      break;
    }
  }
  return lines;
}

function collectHeadingHits(lines: readonly TextLine[]): HeadingHit[] {
  const hits: HeadingHit[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const title = headingTitle(lines[index]!.text);
    if (title !== null) {
      hits.push({ lineIndex: index, start: lines[index]!.start, title });
    }
  }
  return hits;
}

function headingTitle(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAX_HEADING_CHARS) {
    return null;
  }
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
  lines: readonly TextLine[],
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
    if (!headingHasBody(lines, hits, index) && (lastIndexByTitle.get(hits[index]!.title) ?? index) > index) {
      fake.add(index);
    }
  }

  let emptyRun = 0;
  for (let index = 0; index < hits.length; index += 1) {
    if (headingHasBody(lines, hits, index)) {
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
  lines: readonly TextLine[],
  hits: readonly HeadingHit[],
  index: number,
): boolean {
  const start = hits[index]!.lineIndex + 1;
  const end = index + 1 < hits.length ? hits[index + 1]!.lineIndex : lines.length;
  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    if (lines[lineIndex]!.text.trim().length > 0) {
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
    const raw = source.slice(range.start, range.end);
    const eager = !lazy || index < EAGER_CHAPTER_COUNT;
    const chapter: ReaderChapter = {
      title: range.title,
      html: eager ? textToHtml(raw) : '',
    };
    if (eager) {
      return chapter;
    }
    let loaded = false;
    let inflight: Promise<void> | null = null;
    chapter.load = (): Promise<void> => {
      if (loaded) {
        return Promise.resolve();
      }
      if (inflight !== null) {
        return inflight;
      }
      inflight = Promise.resolve().then(() => {
        chapter.html = textToHtml(raw);
        loaded = true;
      });
      return inflight;
    };
    return chapter;
  });
}

function textToHtml(text: string): string {
  return collectParagraphs(text)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}
