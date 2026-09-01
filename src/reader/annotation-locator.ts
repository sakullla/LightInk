import type { FlowLocator, PdfLocator, TextLocator, TextQuoteAnchor } from './annotations.js';
import { buildPdfNormalizedView } from './search-panel.js';

const CONTEXT_LENGTH = 32;

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

function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  const { spans } = textSpans(root);
  const from = boundaryAt(spans, start, true);
  if (from === null) {
    return null;
  }
  const range = documentOf(root).createRange();
  range.setStart(from.node, from.offset);
  if (start === end) {
    range.collapse(true);
    return range;
  }
  const to = boundaryAt(spans, end, false);
  if (to === null) {
    return null;
  }
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * Map a Range boundary onto the concatenated text-node model (no extra
 * newlines). Chromium Range.toString() inserts breaks between blocks, so
 * using it as the quote makes resolve miss the passage in EPUB bodies.
 */
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
    for (const span of spans) {
      const pos = node.compareDocumentPosition(span.node);
      if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
        return span.start;
      }
    }
    return 0;
  }
  if (offset >= kids.length) {
    let lastEnd = 0;
    let saw = false;
    for (const span of spans) {
      if (node.contains(span.node)) {
        lastEnd = span.end;
        saw = true;
      }
    }
    if (saw) {
      return lastEnd;
    }
    for (let index = spans.length - 1; index >= 0; index -= 1) {
      const span = spans[index]!;
      const pos = node.compareDocumentPosition(span.node);
      if ((pos & Node.DOCUMENT_POSITION_PRECEDING) !== 0) {
        return span.end;
      }
    }
    return 0;
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
  for (const span of spans) {
    const pos = child.compareDocumentPosition(span.node);
    if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
      return span.start;
    }
  }
  return spans[spans.length - 1]?.end ?? 0;
}

function rangeOffsets(root: Node, range: Range): { start: number; end: number } {
  const { spans } = textSpans(root);
  const start = pointOffset(spans, range.startContainer, range.startOffset);
  const end = pointOffset(spans, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

export function captureTextQuoteAnchor(root: Node, range: Range): TextQuoteAnchor | null {
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const { text } = textSpans(root);
  const { start, end } = rangeOffsets(root, range);
  const quote = text.slice(start, end);
  if (quote === '') {
    return null;
  }
  return {
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  };
}

/**
 * CSS columns / WebView2 can paint a long native selection while
 * Range.getRangeAt(0) only covers the first glyph. Chromium also inserts
 * newlines in Selection.toString() between blocks; strip those so the quote
 * matches the concatenated text-node model.
 */
export function captureSelectionAnchor(root: Node, selection: Selection): TextQuoteAnchor | null {
  if (selection.rangeCount === 0) {
    return null;
  }
  const rangeAnchor = captureTextQuoteAnchor(root, selection.getRangeAt(0));
  const visual = selection.toString().replace(/\r\n|\r|\n/g, '');
  if (visual === '' || (rangeAnchor !== null && rangeAnchor.quote.length >= visual.length)) {
    return rangeAnchor;
  }
  const { text } = textSpans(root);
  const hint = rangeAnchor?.start ?? 0;
  let start = text.indexOf(visual, Math.max(0, hint - visual.length));
  if (start < 0) {
    start = text.indexOf(visual);
  }
  if (start < 0) {
    return rangeAnchor;
  }
  const end = start + visual.length;
  return {
    start,
    end,
    quote: visual,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
  };
}

function contextScore(text: string, start: number, anchor: TextQuoteAnchor): number {
  const prefix = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const suffix = text.slice(
    start + anchor.quote.length,
    start + anchor.quote.length + anchor.suffix.length,
  );
  let score = 0;
  if (anchor.prefix !== '' && prefix === anchor.prefix) score += 2;
  if (anchor.suffix !== '' && suffix === anchor.suffix) score += 2;
  score -= Math.min(1, Math.abs(start - anchor.start) / Math.max(1, text.length));
  return score;
}

function contextMatches(text: string, start: number, anchor: TextQuoteAnchor): boolean {
  const prefixMatches =
    anchor.prefix === '' ||
    text.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix;
  const quoteMatches =
    text.slice(start, start + anchor.quote.length) === anchor.quote;
  const suffixMatches =
    anchor.suffix === '' ||
    text.slice(
      start + anchor.quote.length,
      start + anchor.quote.length + anchor.suffix.length,
    ) === anchor.suffix;
  return prefixMatches && quoteMatches && suffixMatches;
}

function candidateOffsets(text: string, anchor: TextQuoteAnchor): number[] {
  const candidates = new Set<number>();
  const collect = (needle: string, offsetAfterMatch: number): void => {
    let index = text.indexOf(needle);
    while (index >= 0) {
      candidates.add(index + offsetAfterMatch);
      index = text.indexOf(needle, index + 1);
    }
  };

  if (anchor.quote !== '') {
    collect(anchor.quote, 0);
  } else {
    if (anchor.prefix !== '') {
      collect(anchor.prefix, anchor.prefix.length);
    }
    if (anchor.suffix !== '') {
      collect(anchor.suffix, 0);
    }
  }
  return [...candidates].filter(
    (candidate) => candidate >= 0 && candidate <= text.length,
  );
}

export function resolveTextQuoteOffsets(
  text: string,
  anchor: TextQuoteAnchor,
): { start: number; end: number } | null {
  let start = anchor.start;
  const storedOffsetsMatch =
    start >= 0 &&
    anchor.end === start + anchor.quote.length &&
    anchor.end <= text.length &&
    contextMatches(text, start, anchor);
  if (!storedOffsetsMatch) {
    const candidates = candidateOffsets(text, anchor);
    if (candidates.length === 0) {
      if (anchor.quote !== '' || start < 0 || start > text.length) {
        return null;
      }
      start = Math.min(start, text.length);
    } else {
      start = candidates.reduce((best, candidate) =>
        contextScore(text, candidate, anchor) > contextScore(text, best, anchor)
          ? candidate
          : best,
      );
    }
  }
  return { start, end: start + anchor.quote.length };
}

/**
 * 官方 PDF 文本层宿主判定（与 annotation-render 的 isTextLayerHost 同口径）：
 * `.pdfViewer` 内的 `.textLayer`。仅该宿主的 quote resolve 启用规范化回退，
 * 流式 iframe 正文 / Markdown 等其他 root 的 resolve 行为不变。
 */
function isPdfTextLayerRoot(root: Node): boolean {
  if (root.nodeType !== Node.ELEMENT_NODE || typeof (root as Element).closest !== 'function') {
    return false;
  }
  const element = root as Element;
  return element.classList.contains('textLayer') && element.closest('.pdfViewer') !== null;
}

/**
 * PDF 文本层 anchor resolve（fast path 优先 + 旧内核存量 anchor 的规范化回退）。
 *
 * 旧内核（默认 getTextContent，worker normalizeUnicode 生效）创建的存量 anchor
 * 的 quote/prefix/suffix/offset 处于规范化文本坐标系；A2 后层 DOM 与拼接文本为
 * 原始字形坐标系，quote 含 NFKC 类码点（连字/呈现形式/兼容空格）时严格匹配
 * storedOffsetsMatch 与 candidateOffsets 双失败。回退：以 buildPdfNormalizedView
 * (原始层文本) 构建规范化视图（视图与旧内核规范化页文本逐字等价，已在 A2 验算），
 * 在视图上重试 quote/prefix/suffix，命中后经 sourceStarts/sourceEnds 映射回原始
 * 偏移渲染 mark（命中落在展开字形内部时扩展到整个原始字形，与 A2 搜索链同口径）。
 * 读路径适配：只在 resolve 时回退，不回写 anchor，标注存储 schema 零变更（R5）。
 */
export function resolvePdfTextQuoteOffsets(
  text: string,
  anchor: TextQuoteAnchor,
): { start: number; end: number } | null {
  const direct = resolveTextQuoteOffsets(text, anchor);
  if (direct !== null) {
    return direct; // fast path：原始坐标系严格命中（新内核 anchor 常态，零回退开销）
  }
  const view = buildPdfNormalizedView(text);
  if (view.text === text) {
    return null; // 层文本无可展开码点：视图与原文全等，回退不可能改写失败
  }
  const normalized = resolveTextQuoteOffsets(view.text, anchor);
  if (normalized === null) {
    return null; // 两种坐标系都不存在该 quote：回退不制造假命中
  }
  const sourceStart = view.sourceStarts[normalized.start];
  const sourceEnd = normalized.end > normalized.start
    ? view.sourceEnds[normalized.end - 1]
    : sourceStart;
  if (sourceStart === undefined || sourceEnd === undefined || sourceEnd < sourceStart) {
    return null;
  }
  return { start: sourceStart, end: sourceEnd };
}

export function resolveTextQuoteRange(root: Node, anchor: TextQuoteAnchor): Range | null {
  const { text } = textSpans(root);
  // PDF 文本层宿主多一条旧内核存量 anchor 的规范化回退；其余 root 维持严格 resolve。
  const offsets = isPdfTextLayerRoot(root)
    ? resolvePdfTextQuoteOffsets(text, anchor)
    : resolveTextQuoteOffsets(text, anchor);
  return offsets === null ? null : rangeFromOffsets(root, offsets.start, offsets.end);
}

/** Wrap each selected text fragment independently so highlighting preserves element structure. */
export function markTextRange(
  root: Node,
  range: Range,
  annotationId: string,
  kind?: string,
): number {
  const { start, end } = rangeOffsets(root, range);
  if (start === end) {
    return 0;
  }
  const { spans } = textSpans(root);
  const selected = spans.flatMap((span) => {
    const from = Math.max(span.start, start);
    const to = Math.min(span.end, end);
    return from < to
      ? [{ node: span.node, start: from - span.start, end: to - span.start }]
      : [];
  });

  for (const piece of selected.reverse()) {
    const selectedNode = piece.start === 0 ? piece.node : piece.node.splitText(piece.start);
    const selectedLength = piece.end - piece.start;
    if (selectedLength < selectedNode.length) {
      selectedNode.splitText(selectedLength);
    }
    const mark = documentOf(root).createElement('mark');
    mark.className = 'lightink-reader-highlight';
    mark.dataset.annotationId = annotationId;
    if (kind !== undefined && kind !== '') {
      mark.dataset.annotationKind = kind;
    }
    selectedNode.replaceWith(mark);
    mark.appendChild(selectedNode);
  }
  return selected.length;
}

/** Walk from a click target (element or text node) to its annotation mark. */
export function annotationMarkFromEventTarget(target: EventTarget | null): HTMLElement | null {
  if (target === null || typeof (target as Node).nodeType !== 'number') {
    return null;
  }
  const node = target as Node;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (element === null || typeof element.closest !== 'function') {
    return null;
  }
  return element.closest('[data-annotation-id]');
}

export function removeTextRangeMarks(root: ParentNode, annotationId: string): void {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>('.lightink-reader-highlight[data-annotation-id]'),
  ).filter((mark) => mark.dataset.annotationId === annotationId);
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(...Array.from(mark.childNodes));
    parent?.normalize();
  }
}

export function flowLocatorFromRange(
  root: Node,
  range: Range,
  chapter: number,
  format: 'flow' | 'text',
): FlowLocator | TextLocator | null {
  const anchor = captureTextQuoteAnchor(root, range);
  if (anchor === null) {
    return null;
  }
  return { format, chapter, ...anchor };
}

export function flowLocatorFromSelection(
  root: Node,
  selection: Selection,
  chapter: number,
  format: 'flow' | 'text',
): FlowLocator | TextLocator | null {
  const anchor = captureSelectionAnchor(root, selection);
  if (anchor === null) {
    return null;
  }
  return { format, chapter, ...anchor };
}

/**
 * PDF 文本层选区 → 文字级 PdfLocator（page + anchor；页码级书签/笔记仍无 anchor）。
 * 层根为官方 `.pdfViewer .page[data-page-number] .textLayer`（T4），拼接文本坐标
 * 系不变，标注存储 schema 零变更（R5）。
 */
export function pdfTextLocatorFromRange(
  root: Node,
  range: Range,
  page: number,
): PdfLocator | null {
  const anchor = captureTextQuoteAnchor(root, range);
  if (anchor === null) {
    return null;
  }
  return { format: 'pdf', page, quote: anchor.quote, anchor };
}
