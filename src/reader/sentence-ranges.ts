/**
 * Sentence Ranges for TTS follow-along (ADR-4).
 *
 * Splits concatenated text-node content on the same punctuation as
 * `SNIPPET_SENTENCE_BREAK` in search-panel. Returned Ranges are live DOM
 * Ranges, not Annotation locators, and must not be persisted.
 */

import { pagedGlyphInView, realPagedFragmentBox } from '../ui/reading-layout.js';

/** Same kind as `SNIPPET_SENTENCE_BREAK`, plus ASCII `.` for English sentences. */
export const SENTENCE_BREAK = /[。！？!?.;；;\n]/;

export interface SentenceSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

function documentOf(root: Node): Document {
  return root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
}

function textSpans(root: Node): { text: string; spans: TextSpan[] } {
  const ownerDocument = documentOf(root);
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(root, showText);
  const spans: TextSpan[] = [];
  let text = '';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null) !== null) {
    const value = node.nodeValue ?? '';
    spans.push({ node, start: text.length, end: text.length + value.length });
    text += value;
  }
  return { text, spans };
}

function boundaryAt(
  spans: readonly TextSpan[],
  offset: number,
  preferNext: boolean,
): { node: Text; offset: number } | null {
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    if (offset < span.end || (!preferNext && offset === span.end)) {
      return { node: span.node, offset: Math.max(0, offset - span.start) };
    }
  }
  const last = spans[spans.length - 1];
  return last === undefined
    ? null
    : { node: last.node, offset: last.node.nodeValue?.length ?? 0 };
}

export function concatenatedText(root: Node): string {
  return textSpans(root).text;
}

export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(0, Math.max(start, end));
  const { spans } = textSpans(root);
  const begin = boundaryAt(spans, from, true);
  if (begin === null) {
    return null;
  }
  const range = documentOf(root).createRange();
  range.setStart(begin.node, begin.offset);
  if (from === to) {
    range.collapse(true);
    return range;
  }
  const finish = boundaryAt(spans, to, false);
  if (finish === null) {
    return null;
  }
  range.setEnd(finish.node, finish.offset);
  return range;
}

function pointOffset(spans: readonly TextSpan[], node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    for (const span of spans) {
      if (span.node === node) {
        const length = span.end - span.start;
        return span.start + Math.max(0, Math.min(offset, length));
      }
    }
    return 0;
  }
  const kids = node.childNodes;
  if (offset <= 0) {
    for (const span of spans) {
      if (node.contains(span.node)) {
        return span.start;
      }
    }
    return 0;
  }
  if (offset >= kids.length) {
    let lastEnd = 0;
    for (const span of spans) {
      if (node.contains(span.node)) {
        lastEnd = span.end;
      }
    }
    return lastEnd;
  }
  const child = kids[offset]!;
  if (child.nodeType === Node.TEXT_NODE) {
    return pointOffset(spans, child, 0);
  }
  for (const span of spans) {
    if (child.contains(span.node)) {
      return span.start;
    }
  }
  return spans[spans.length - 1]?.end ?? 0;
}

export function rangeOffsets(root: Node, range: Range): { start: number; end: number } {
  const { spans } = textSpans(root);
  const start = pointOffset(spans, range.startContainer, range.startOffset);
  const end = pointOffset(spans, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

export interface ViewportClip {
  readonly left: number;
  readonly top: number;
}

function caretRangeAt(doc: Document, x: number, y: number): Range | null {
  const withCaret = doc as Document & {
    caretRangeFromPoint?: (clientX: number, clientY: number) => Range | null;
    caretPositionFromPoint?: (
      clientX: number,
      clientY: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof withCaret.caretRangeFromPoint === 'function') {
    return withCaret.caretRangeFromPoint(x, y);
  }
  const position = withCaret.caretPositionFromPoint?.(x, y);
  if (position === null || position === undefined) {
    return null;
  }
  const range = doc.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

/**
 * Text offset at the top-left of the visible reading surface.
 * Paginated columns live in the iframe viewport; scroll mode clips the iframe
 * inside the outer host — `clip` is that host's getBoundingClientRect().
 */
export function visibleStartOffset(root: Node, clip?: ViewportClip): number {
  const doc = documentOf(root);
  const view = doc.defaultView;
  let x = 8;
  let y = 8;
  const frame = view?.frameElement;
  if (clip !== undefined && frame instanceof Element) {
    const frameRect = frame.getBoundingClientRect();
    x = Math.max(4, clip.left - frameRect.left + 8);
    y = Math.max(4, clip.top - frameRect.top + 8);
  }
  const caret = caretRangeAt(doc, x, y);
  if (caret === null) {
    return 0;
  }
  const container = caret.startContainer;
  if (container !== root && !root.contains(container)) {
    return 0;
  }
  return rangeOffsets(root, caret).start;
}

export interface ViewportBox {
  readonly left: number;
  readonly width: number;
}

/**
 * Map a paged scroller's scrollLeft onto concatenated text without layout.
 * `scrollLeft / scrollWidth` is the left edge of the current spread — not
 * `scrollLeft / max`, which is 1 on the last page and would start at EOF.
 */
export function offsetAtPagedProgress(
  textLength: number,
  scroller: { scrollLeft: number; scrollWidth: number },
): number {
  if (!(textLength > 0) || !(scroller.scrollWidth > 0)) {
    return 0;
  }
  const raw = (textLength * Math.max(0, scroller.scrollLeft)) / scroller.scrollWidth;
  return Math.min(textLength, Math.max(0, Math.floor(raw)));
}

/**
 * First concatenated offset whose real glyph box sits in `view`.
 * Uses getClientRects + the paged fragment filter so CSS columns don't
 * report the previous spread's right column as the start of the page.
 */
function glyphBoxes(range: Range): Array<{ left: number; width: number; height: number }> {
  try {
    return Array.from(range.getClientRects()).map((rect) => ({
      left: rect.left,
      width: rect.width,
      height: rect.height,
    }));
  } catch {
    return [];
  }
}

function offsetGlyphLeft(
  spans: readonly TextSpan[],
  offset: number,
  lineHeight: number,
): number | null {
  const point = boundaryAt(spans, offset, true);
  if (point === null) {
    return null;
  }
  const doc = documentOf(point.node);
  const range = doc.createRange();
  const length = point.node.nodeValue?.length ?? 0;
  range.setStart(point.node, point.offset);
  range.setEnd(point.node, Math.min(length, point.offset + 1));
  const box = realPagedFragmentBox(glyphBoxes(range), lineHeight);
  return box?.left ?? null;
}

export function firstOffsetInViewport(root: Node, view: ViewportBox): number | null {
  if (!(view.width > 1)) {
    return null;
  }
  const { text, spans } = textSpans(root);
  if (text.length === 0 || spans.length === 0) {
    return null;
  }
  const parent = spans[0]?.node.parentElement;
  const lineHeight = Number.parseFloat(
    parent === null
      ? ''
      : (documentOf(root).defaultView?.getComputedStyle(parent).lineHeight ?? ''),
  );
  const viewRight = view.left + view.width;
  let low = 0;
  let high = text.length;
  let hit: number | null = null;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const left = offsetGlyphLeft(spans, mid, lineHeight);
    if (left !== null && pagedGlyphInView(left, view.left, view.width)) {
      hit = mid;
      high = mid;
      continue;
    }
    if (left !== null && left >= viewRight) {
      high = mid;
      continue;
    }
    low = mid + 1;
  }
  return hit;
}

/** Snap a mid-sentence offset back to that sentence's start. */
export function sentenceStartOffset(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const spans = splitSentenceSpans(text);
  for (const span of spans) {
    if (clamped < span.end) {
      return span.start;
    }
  }
  return spans[spans.length - 1]?.start ?? 0;
}

export function splitSentenceSpans(
  text: string,
  fromOffset = 0,
  toOffset: number = text.length,
): SentenceSpan[] {
  if (text.length === 0) {
    return [];
  }
  const startBound = Math.max(0, Math.min(fromOffset, text.length));
  const endBound = Math.max(startBound, Math.min(toOffset, text.length));
  const spans: SentenceSpan[] = [];
  let cursor = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_BREAK.test(text.charAt(index))) {
      continue;
    }
    const end = index + 1;
    pushSpan(spans, text, cursor, end, startBound, endBound);
    cursor = end;
  }
  pushSpan(spans, text, cursor, text.length, startBound, endBound);
  return spans;
}

function pushSpan(
  spans: SentenceSpan[],
  text: string,
  rawStart: number,
  rawEnd: number,
  startBound: number,
  endBound: number,
): void {
  if (rawEnd <= startBound || rawStart >= endBound) {
    return;
  }
  const start = Math.max(rawStart, startBound);
  const end = Math.min(rawEnd, endBound);
  const slice = text.slice(start, end);
  if (slice.trim() === '') {
    return;
  }
  spans.push({ start, end, text: slice });
}

export function sentenceSpansFromRoot(
  root: Node,
  fromOffset = 0,
  toOffset?: number,
): SentenceSpan[] {
  const text = concatenatedText(root);
  return splitSentenceSpans(text, fromOffset, toOffset ?? text.length);
}

export function sentenceSpansFromRange(root: Node, range: Range): SentenceSpan[] {
  const { start, end } = rangeOffsets(root, range);
  return sentenceSpansFromRoot(root, start, end);
}

export function findQuoteOffsets(root: Node, quote: string): { start: number; end: number } | null {
  const needle = quote.trim();
  if (needle === '') {
    return null;
  }
  const text = concatenatedText(root);
  const exact = text.indexOf(needle);
  if (exact >= 0) {
    return { start: exact, end: exact + needle.length };
  }
  const collapsed = text.replace(/\s+/g, ' ');
  const collapsedNeedle = needle.replace(/\s+/g, ' ');
  const at = collapsed.indexOf(collapsedNeedle);
  if (at < 0) {
    return null;
  }
  return mapCollapsedOffsets(text, at, at + collapsedNeedle.length);
}

function mapCollapsedOffsets(
  text: string,
  collapsedStart: number,
  collapsedEnd: number,
): { start: number; end: number } {
  let collapsed = 0;
  let start = 0;
  let end = text.length;
  let inSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const space = /\s/.test(text.charAt(index));
    if (space) {
      if (inSpace) {
        continue;
      }
      inSpace = true;
    } else {
      inSpace = false;
    }
    if (collapsed === collapsedStart) {
      start = index;
    }
    collapsed += 1;
    if (collapsed === collapsedEnd) {
      end = index + 1;
      break;
    }
  }
  return { start, end };
}
