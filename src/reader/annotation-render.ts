/**
 * `annotation-render` — 标注高亮共享幂等引擎（PDF 文本层 / 流式 iframe 正文）。
 *
 * 宿主差异（PDF 按页定位文本层、流式按章定位 body）由调用方适配注入；引擎只面向
 * 单个 host 工作：
 * - renderAnnotationMarks：幂等渲染。该标注的 mark 已存在则只同步 kind/颜色，
 *   避免重复嵌套包裹；anchor 在 host 文本中无法定位时跳过，由调用方观察器重试；
 * - syncAnnotationMarks：先清掉不在当前集合里的 mark，再渲染/同步剩余项
 *   （删除后书内标记与侧栏一致）；
 * - removeAnnotationMarks：按标注 id 解包移除全部对应 mark。
 *
 * 颜色与 `annotations.ts` 共用同一关闭色板与默认黄；缺省/非法视为默认，不改 CSS。
 */

import { ANNOTATION_COLORS, DEFAULT_ANNOTATION_COLOR, resolveAnnotationColor } from './annotations.js';
import type { TextQuoteAnchor } from './annotations.js';
import { markTextRange, removeTextRangeMarks, resolveTextQuoteRange } from './annotation-locator.js';

/** 一条待渲染的标注高亮：anchor 为 host 拼接文本坐标系中的文字级锚点。 */
export interface AnnotationMarkSpec {
  id: string;
  kind: string;
  anchor: TextQuoteAnchor;
  /** Optional palette color; missing/illegal values resolve to the default yellow. */
  color?: string;
}

/** Build a mark spec, including any stored highlight color. */
export function annotationMarkSpec(
  annotation: { id: string; kind: string; color?: string },
  anchor: TextQuoteAnchor,
): AnnotationMarkSpec {
  return {
    id: annotation.id,
    kind: annotation.kind,
    anchor,
    color: annotation.color,
  };
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function marksForId(host: ParentNode, annotationId: string): HTMLElement[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>(`[data-annotation-id="${cssEscape(annotationId)}"]`),
  );
}

/**
 * PDF 文本层宿主判定（T4 官方结构）：`.pdfViewer` 内的 `.textLayer`。
 * 限定在 `.pdfViewer` 内，流式 iframe 正文（body）不会误判；层内 mark 用
 * 半透明 color-mix 叠在 canvas 字形上，流式正文用不透明色。
 */
function isTextLayerHost(host: ParentNode): boolean {
  return (
    host instanceof Element &&
    host.classList.contains('textLayer') &&
    host.closest('.pdfViewer') !== null
  );
}

/** Paint kind/color onto an existing mark without re-wrapping text. */
function applyMarkAppearance(
  host: ParentNode,
  mark: HTMLElement,
  spec: AnnotationMarkSpec,
): void {
  const color = resolveAnnotationColor(spec.color);
  if (spec.kind !== '') {
    mark.dataset.annotationKind = spec.kind;
  }
  mark.dataset.annotationColor = color;
  mark.style.setProperty('--lightink-annotation-color', color);
  if (color === DEFAULT_ANNOTATION_COLOR) {
    mark.style.removeProperty('background');
    return;
  }
  mark.style.background = isTextLayerHost(host)
    ? `color-mix(in srgb, ${color} 32%, transparent)`
    : color;
}

/** 在单个 host 上幂等渲染标注高亮 mark（已渲染则同步外观，定位失败跳过）。 */
export function renderAnnotationMarks(
  host: ParentNode,
  specs: readonly AnnotationMarkSpec[],
): void {
  for (const spec of specs) {
    const existing = marksForId(host, spec.id);
    if (existing.length > 0) {
      for (const mark of existing) {
        applyMarkAppearance(host, mark, spec);
      }
      continue; // 已渲染：同步 kind/颜色，避免重复嵌套包裹
    }
    const range = resolveTextQuoteRange(host, spec.anchor);
    if (range !== null && !range.collapsed) {
      markTextRange(host, range, spec.id, spec.kind);
      for (const mark of marksForId(host, spec.id)) {
        applyMarkAppearance(host, mark, spec);
      }
    }
  }
}

/**
 * 将 host 上的 mark 对齐到当前标注集合：删除已不存在的 id，再渲染/同步剩余项。
 */
export function syncAnnotationMarks(
  host: ParentNode,
  specs: readonly AnnotationMarkSpec[],
): void {
  const keep = new Set(specs.map((spec) => spec.id));
  const present = new Set(
    Array.from(host.querySelectorAll<HTMLElement>('[data-annotation-id]'))
      .map((mark) => mark.dataset.annotationId ?? '')
      .filter((id) => id !== ''),
  );
  for (const id of present) {
    if (!keep.has(id)) {
      removeAnnotationMarks(host, id);
    }
  }
  renderAnnotationMarks(host, specs);
}

const HIGHLIGHT_LAYER_CLASS = 'lightink-reader-highlight-layer';

export function highlightCssName(color: string): string {
  return `lightink-hl-${color.replace('#', '').toLowerCase()}`;
}

/** ::highlight rules for the closed palette (iframe stylesheet). */
export const ANNOTATION_HIGHLIGHT_API_CSS = ANNOTATION_COLORS.map(
  (color) =>
    `::highlight(${highlightCssName(color)}){background-color:color-mix(in srgb, ${color} 62%, transparent);color:inherit;}`,
).join('');

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
  keys(): IterableIterator<string>;
}

function overlayHost(doc: Document): HTMLElement {
  return doc.documentElement;
}

function markHighlightColor(mark: HTMLElement): string {
  const fromStyle = mark.style.getPropertyValue('--lightink-annotation-color').trim();
  if (fromStyle !== '') {
    return fromStyle;
  }
  const fromData = mark.dataset.annotationColor ?? '';
  return fromData === '' ? DEFAULT_ANNOTATION_COLOR : fromData;
}

function cssHighlightApi(win: Window | null): {
  highlights: HighlightRegistry;
  Highlight: new (...ranges: Range[]) => { add(range: Range): void };
} | null {
  if (win === null) {
    return null;
  }
  const css = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const HighlightCtor = (win as unknown as { Highlight?: new (...ranges: Range[]) => { add(range: Range): void } })
    .Highlight;
  if (css === undefined || css.highlights === undefined || HighlightCtor === undefined) {
    return null;
  }
  return { highlights: css.highlights, Highlight: HighlightCtor };
}

function clearCssHighlights(api: { highlights: HighlightRegistry }): void {
  for (const key of [...api.highlights.keys()]) {
    if (key.startsWith('lightink-hl-')) {
      api.highlights.delete(key);
    }
  }
}

function textNodeClientRects(mark: HTMLElement): Array<{ left: number; top: number; width: number; height: number; right: number; bottom: number }> {
  const doc = mark.ownerDocument;
  const boxes: Array<{ left: number; top: number; width: number; height: number; right: number; bottom: number }> = [];
  const walker = doc.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node !== null) {
    const text = node as Text;
    if ((text.nodeValue ?? '').length > 0) {
      const range = doc.createRange();
      range.selectNodeContents(text);
      try {
        for (const rect of Array.from(range.getClientRects())) {
          boxes.push(rect);
        }
      } catch {
        // jsdom
      }
    }
    node = walker.nextNode();
  }
  if (boxes.length === 0) {
    try {
      for (const rect of Array.from(mark.getClientRects())) {
        boxes.push(rect);
      }
    } catch {
      // jsdom
    }
  }
  return boxes;
}

export function visibleHighlightOverlayBoxes(
  doc: Document,
  marks: Iterable<HTMLElement>,
): Array<{ left: number; top: number; width: number; height: number; color: string }> {
  const win = doc.defaultView;
  const viewportW = win !== null && win.innerWidth > 0 ? win.innerWidth : doc.documentElement.clientWidth;
  const viewportH = win !== null && win.innerHeight > 0 ? win.innerHeight : doc.documentElement.clientHeight;
  const painted: Array<{ left: number; top: number; width: number; height: number; color: string }> = [];
  for (const mark of marks) {
    const color = markHighlightColor(mark);
    const lineHeight = Number.parseFloat(win?.getComputedStyle(mark).lineHeight || '') || 28;
    for (const rect of textNodeClientRects(mark)) {
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }
      // Column-break phantoms: hairline or taller than two lines.
      if (rect.width < 2 || rect.height > lineHeight * 2.5) {
        continue;
      }
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(viewportW, rect.right);
      const bottom = Math.min(viewportH, rect.bottom);
      if (right - left < 1 || bottom - top < 1) {
        continue;
      }
      painted.push({ left, top, width: right - left, height: bottom - top, color });
    }
  }
  return painted;
}

function clearOverlayLayer(doc: Document): void {
  overlayHost(doc).querySelector(`:scope > .${HIGHLIGHT_LAYER_CLASS}`)?.remove();
}

/**
 * Do not paint CSS Custom Highlights or range overlays on flow chapters.
 * Both 错行 in CSS columns (black bars / off-glyph boxes). The <mark>
 * background is the first-page highlight that already sat on the glyphs.
 */
export function paintAnnotationOverlays(doc: Document): void {
  const api = cssHighlightApi(doc.defaultView);
  if (api !== null) {
    clearCssHighlights(api);
  }
  clearOverlayLayer(doc);
}

/** 移除 host 上指定标注的全部高亮 mark（与 renderAnnotationMarks 成对）。 */
export function removeAnnotationMarks(host: ParentNode, annotationId: string): void {
  removeTextRangeMarks(host, annotationId);
}
