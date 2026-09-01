/**
 * `search-panel` — 阅读器搜索纯函数（PDF / 流式共用）。
 *
 * `findTextHits`/`findPdfTextHits`/`findPdfMatches`/`nextMatchIndex`/`snippetAround`
 * 为 node 可测算法。PDF 页文本是原始字形坐标系（pdf.ts ensurePageText 以
 * disableNormalization 取串，与官方 TextLayer DOM 一致），连字/呈现形式的查询命中
 * 由规范化视图在匹配层保全；流式正文仍用 findTextHits 直配 DOM 文本。
 * 命中高亮 overlay 由 search-overlay 共享引擎完成；查找 UI 在标注侧栏，不在此装配。
 */

export interface PdfSearchMatch {
  /** 1-based 页码。 */
  page: number;
  /** 命中在该页拼接文本中的 [start, end) 偏移（与文本层 anchor 同一坐标系）。 */
  start: number;
  end: number;
  /** 命中附近有界上下文，供侧栏片段列表使用。 */
  snippet: string;
}

/** Characters of context kept on each side of a hit when building a snippet. */
export const SEARCH_SNIPPET_RADIUS = 40;

/** Bounded context around [start, end) in the same concatenated text used for matching. */
export function snippetAround(
  text: string,
  start: number,
  end: number,
  radius = SEARCH_SNIPPET_RADIUS,
): string {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const from = Math.max(0, safeStart - radius);
  const to = Math.min(text.length, safeEnd + radius);
  const core = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (core === '') {
    return '';
  }
  return `${from > 0 ? '…' : ''}${core}${to < text.length ? '…' : ''}`;
}

export interface TextSearchHit {
  start: number;
  end: number;
}

/**
 * 单段拼接文本内的大小写不敏感命中（PDF 页文本 / 流式章节正文共用）。
 * 大小写变形长度保护：小写化改变 UTF-16 长度的文本/查询（如 İ）会使偏移与 DOM 文本
 * 坐标系错位，此时退化为大小写敏感匹配，保持坐标系一致。空查询返回空。
 */
export function findTextHits(text: string, query: string): TextSearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const loweredText = text.toLowerCase();
  const loweredNeedle = trimmed.toLowerCase();
  let hay: string;
  let needle: string;
  if (loweredText.length === text.length && loweredNeedle.length === trimmed.length) {
    hay = loweredText;
    needle = loweredNeedle;
  } else {
    // 小写化改变 UTF-16 长度（如 İ）：退化大小写敏感，偏移保持与 DOM 文本对齐。
    hay = text;
    needle = trimmed;
  }
  const hits: TextSearchHit[] = [];
  let at = hay.indexOf(needle);
  while (at >= 0) {
    hits.push({ start: at, end: at + needle.length });
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}

/**
 * pdf.worker normalizeUnicode（pdf.worker.mjs:722-726）在默认 getTextContent 下
 * 展开的原始字形集合：连字（ﬀﬁﬂﬃﬄ/ﬆ）、希伯来/阿拉伯呈现形式与兼容空格等经
 * NFKC 展开（长度可变）。官方 TextLayerBuilder（pdf_viewer.mjs:6068-6071）与
 * PDFFindController #extractText（pdf_viewer.mjs:1160-1163）都以 disableNormalization
 * 建立层坐标系，归一化放在匹配层做。字符类与 worker 逐字一致，保证与旧内核
 * （worker 规范化的 pageTexts）等价的查询命中口径。
 */
const WORKER_NFKC_SOURCE =
  /[\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71\ufe77\ufe79\ufe7b\ufe7d]/;

/** ﬅ（U+FB05）在 worker 中映射为 ſt（U+017F + t，而非 NFKC 的 st），保持等价。 */
const WORKER_LONG_S_T = 'ſt';

/** 规范化视图：展开后的视图文本 + 视图偏移到原始码点区间的双坐标映射。 */
export interface PdfNormalizedView {
  /** 连字/呈现形式按 worker 集合展开后的视图文本（大小写不变）。 */
  readonly text: string;
  /** 视图偏移 k → 产生该视图字符的原始码点起始偏移（原始文本 UTF-16 下标）。 */
  readonly sourceStarts: readonly number[];
  /** 视图偏移 k → 产生该视图字符的原始码点结束偏移（不含）。 */
  readonly sourceEnds: readonly number[];
}

/**
 * 为原始字形文本构建规范化视图（worker normalizeUnicode 的最小等价）。逐码点展开：
 * 官方 PDFFindController 对 NFKC 类做整段 run 展开，跨字符再组合只影响罕见的邻接
 * 呈现形式；逐码点的展开让「视图偏移 → 原始码点区间」映射保持单调可预测。
 */
export function buildPdfNormalizedView(text: string): PdfNormalizedView {
  let view = '';
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  for (let offset = 0; offset < text.length; ) {
    const codePoint = text.codePointAt(offset)!;
    const size = codePoint > 0xffff ? 2 : 1;
    const source = String.fromCodePoint(codePoint);
    const piece =
      codePoint === 0xfb05
        ? WORKER_LONG_S_T
        : WORKER_NFKC_SOURCE.test(source)
          ? source.normalize('NFKC')
          : source;
    for (let index = 0; index < piece.length; index += 1) {
      sourceStarts.push(offset);
      sourceEnds.push(offset + size);
    }
    view += piece;
    offset += size;
  }
  return { text: view, sourceStarts, sourceEnds };
}

/**
 * PDF 页拼接文本（原始字形坐标系）内的大小写不敏感命中：匹配在规范化视图上做，
 * 偏移映射回原始文本（与官方层 DOM 拼接文本同坐标系，供 offsetRangeFrom/overlay
 * 直接消费）。查询 "fi" 可命中原始连字 "ﬁ"；命中落在展开内部时扩展到整个原始
 * 字形（同官方 getOriginalIndex 语义，overlay 永远包裹完整原始字形）。空查询返回空。
 */
export function findPdfTextHits(text: string, query: string): TextSearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const view = buildPdfNormalizedView(text);
  const needleView = buildPdfNormalizedView(trimmed).text;
  // 与 findTextHits 相同的大小写变形长度保护：小写化改变视图 UTF-16 长度（如 İ）
  // 时退化为大小写敏感。视图内偏移不被小写化扰动，原始偏移映射始终成立。
  const loweredHay = view.text.toLowerCase();
  const loweredNeedle = needleView.toLowerCase();
  const caseStable =
    loweredHay.length === view.text.length && loweredNeedle.length === needleView.length;
  const hay = caseStable ? loweredHay : view.text;
  const needle = caseStable ? loweredNeedle : needleView;
  const hits: TextSearchHit[] = [];
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const start = view.sourceStarts[at]!;
    // 同一原始字形内部的多次视图命中（如某呈现形式展开出重复字符）只计一次，
    // 避免 overlay key（page:start:end）与命中列表重复。
    if (hits.length === 0 || hits[hits.length - 1]!.start !== start) {
      hits.push({ start, end: view.sourceEnds[at + needle.length - 1]! });
    }
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}

/**
 * 在页文本数组（1:1 对应页码，原始字形坐标系）中查找全部命中（大小写不敏感，
 * 连字/呈现形式经规范化视图等价命中），按页序返回。空查询返回空。
 */
export function findPdfMatches(
  pageTexts: readonly string[],
  query: string,
): PdfSearchMatch[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const matches: PdfSearchMatch[] = [];
  for (let index = 0; index < pageTexts.length; index += 1) {
    for (const hit of findPdfTextHits(pageTexts[index]!, trimmed)) {
      matches.push({
        page: index + 1,
        ...hit,
        snippet: snippetAround(pageTexts[index]!, hit.start, hit.end),
      });
    }
  }
  return matches;
}

/** First match at or after the current reading position; empty set returns -1. */
export function nearestMatchIndex(total: number, firstAtOrAfter: number): number {
  if (total <= 0) {
    return -1;
  }
  if (firstAtOrAfter < 0) {
    return 0;
  }
  return firstAtOrAfter < total ? firstAtOrAfter : 0;
}

/** Keep the current hit across a layout rebuild when that index is still valid. */
export function preserveMatchIndex(total: number, previous: number, fallback: number): number {
  if (total <= 0) {
    return -1;
  }
  if (previous >= 0 && previous < total) {
    return previous;
  }
  return nearestMatchIndex(total, fallback);
}

/** 环形步进命中索引（direction 1 下一个 / -1 上一个）；空集返回 -1。 */
export function nextMatchIndex(total: number, active: number, direction: 1 | -1): number {
  if (total <= 0) {
    return -1;
  }
  if (active < 0) {
    return 0;
  }
  return (active + direction + total) % total;
}

/** Pause after a committed keystroke before scanning the book. Empty query skips this. */
export const SEARCH_QUERY_DEBOUNCE_MS = 280;

/** First page of hit rows / highlights. More arrive as the scan continues or the list scrolls. */
export const SEARCH_HIT_CAP = 80;

/**
 * Hold busy chrome (spinner, “12+”, load-more sentinel) until the scan has
 * actually taken this long. Sub-second flashes only add a scrollbar.
 */
export const SEARCH_BUSY_REVEAL_MS = 1000;

export interface SearchBusyReveal {
  start(): void;
  clear(): void;
  revealed(): boolean;
}

/** Reveal in-flight search chrome only after SEARCH_BUSY_REVEAL_MS. */
export function createSearchBusyReveal(
  onReveal: () => void,
  delayMs = SEARCH_BUSY_REVEAL_MS,
): SearchBusyReveal {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let visible = false;
  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    visible = false;
  };
  return {
    start() {
      clear();
      timer = setTimeout(() => {
        timer = null;
        visible = true;
        onReveal();
      }, delayMs);
    },
    clear,
    revealed() {
      return visible;
    },
  };
}

export function capSearchHits<T>(hits: readonly T[], cap = SEARCH_HIT_CAP): T[] {
  return hits.length <= cap ? [...hits] : hits.slice(0, cap);
}

const CJK_QUERY_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** CJK can be a useful query at one character; Latin still waits for two. */
export function liveSearchMinChars(query: string): number {
  return CJK_QUERY_RE.test(query) ? 1 : 2;
}

/** Strip chapter HTML to the same concatenated text the overlay uses. */
export function htmlToSearchText(html: string): string {
  const trimmed = html.trim();
  if (trimmed === '') {
    return '';
  }
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<body>${trimmed}</body>`, 'text/html');
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Yield so a long scan cannot lock typing, scrolling, or the result list. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Sentinel at the bottom of a scrollable result list. */
export function observeLoadMore(
  root: HTMLElement,
  sentinel: HTMLElement,
  onLoadMore: () => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    return () => undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    },
    { root, rootMargin: '120px' },
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}

/**
 * IME-safe search input: keep the caret live, but only emit an expensive query
 * after composition ends or the user pauses. Emptying the box emits immediately.
 */
export function bindImeSafeQuery(
  input: HTMLInputElement,
  onQuery: (query: string) => void,
  options?: { debounceMs?: number },
): () => void {
  const debounceMs = options?.debounceMs ?? SEARCH_QUERY_DEBOUNCE_MS;
  let composing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let skipNextInput = false;

  const emit = (query: string, immediate: boolean): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (immediate || query.trim() === '') {
      onQuery(query);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      onQuery(query);
    }, debounceMs);
  };

  const onCompositionStart = (): void => {
    composing = true;
    skipNextInput = false;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    skipNextInput = true;
    emit(input.value, true);
    // 部分引擎在 compositionend 后同步再派发一次 input；下一事件循环清掉闸门，
    // 避免没有这条尾巴时把用户的下一个字也吞掉。
    setTimeout(() => {
      skipNextInput = false;
    }, 0);
  };
  const onInput = (event: Event): void => {
    if (skipNextInput) {
      skipNextInput = false;
      return;
    }
    if (composing || (event instanceof InputEvent && event.isComposing)) {
      return;
    }
    emit(input.value, input.value.trim() === '');
  };

  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('input', onInput);
  return () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('input', onInput);
  };
}

/** First line, trimmed, capped — same seed rules as Markdown Ctrl+F. */
export function sanitizeSearchQuery(raw: string | null | undefined): string {
  const firstLine = (raw ?? '').split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed === '') {
    return '';
  }
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

/** 把 range 覆盖的文本片段包进带类名的 span（搜索命中 overlay，非持久标注）。可选 key 戳记用于幂等复检。 */
export function wrapTextRangeWithSpan(
  root: Node,
  range: Range,
  className: string,
  key?: string,
): number {
  const walkerOwner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = walkerOwner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const selected = nodes.flatMap((node) => {
    if (!range.intersectsNode(node)) {
      return [];
    }
    const length = node.nodeValue?.length ?? 0;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : length;
    return start < end ? [{ node, start, end }] : [];
  });
  for (const { node, start, end } of selected.reverse()) {
    const selectedNode = start === 0 ? node : node.splitText(start);
    const selectedLength = end - start;
    if (selectedLength < selectedNode.length) {
      selectedNode.splitText(selectedLength);
    }
    const span = walkerOwner.createElement('span');
    span.className = className;
    if (key !== undefined) {
      span.dataset.searchKey = key;
    }
    selectedNode.replaceWith(span);
    span.appendChild(selectedNode);
  }
  return selected.length;
}

/** 解包并移除指定类名的 overlay span（与 wrapTextRangeWithSpan 成对）。 */
export function unwrapSpans(root: ParentNode, className: string): void {
  for (const span of Array.from(
    root.querySelectorAll<HTMLElement>(`.${className}`),
  )) {
    const parent = span.parentNode;
    span.replaceWith(...Array.from(span.childNodes));
    parent?.normalize();
  }
}

/** root 拼接文本总长（判断 pdfjs 文本层是否已填充到命中末尾，避免部分包裹）。 */
export function textLengthOf(root: Node): number {
  const owner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let length = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    length += node.nodeValue?.length ?? 0;
  }
  return length;
}

/**
 * overlay 包裹判定：已有该 key 的 overlay（幂等，防 observer 自激循环）或
 * 层文本尚未填充到命中末尾（防部分包裹被 key 戳记定格）时不可包裹。
 */
export function canWrapSearchMark(layer: HTMLElement, key: string, end: number): boolean {
  if (layer.querySelector(`[data-search-key="${key.replace(/["\\]/g, '\\$&')}"]`) !== null) {
    return false;
  }
  return textLengthOf(layer) >= end;
}

/** root 拼接文本的 [start, end) 偏移 → Range（与文本层 anchor 同一坐标系）。 */
export function offsetRangeFrom(root: Node, start: number, end: number): Range | null {
  const owner = root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  const locate = (target: number, preferNext: boolean): { node: Text; offset: number } | null => {
    let offset = 0;
    for (const node of nodes) {
      const length = node.nodeValue?.length ?? 0;
      if (target < offset + length || (!preferNext && target === offset + length)) {
        return { node, offset: Math.max(0, target - offset) };
      }
      offset += length;
    }
    const last = nodes[nodes.length - 1];
    return last === undefined
      ? null
      : { node: last, offset: last.nodeValue?.length ?? 0 };
  };
  const from = locate(start, true);
  if (from === null) {
    return null;
  }
  const range = owner.createRange();
  range.setStart(from.node, from.offset);
  if (start === end) {
    range.collapse(true);
    return range;
  }
  const to = locate(end, false);
  if (to === null) {
    return null;
  }
  range.setEnd(to.node, to.offset);
  return range;
}
