/**
 * 大纲模型（T7, R7）：从 markdown 文本派生标题大纲。
 *
 * 实现策略：复用 `src/editor/parser.ts` 的 `parseMarkdownToMdast`
 * （unified + remark-parse + remark-gfm，与 Milkdown 的 commonmark+gfm
 * 预设同源）解析出 MDAST，按文档顺序收集 heading 节点。代码块/行内代码
 * 中的 `#` 行由解析器天然排除，无需特判。
 *
 * 锚点（anchor）策略：标题在文档中的序号（第 n 个 heading，从 0 起）。
 *   - 选择理由：渲染侧 Milkdown 把每个 ProseMirror heading 节点渲染为
 *     宿主 DOM 中按文档顺序排列的 h1-h6 元素，`querySelectorAll` 的结果
 *     顺序与 MDAST 文档顺序一致，序号可在两侧无歧义对应；
 *     对重复标题文本天然免疫（不依赖文本匹配）。
 *   - 已知限制：若两次重算之间文档结构被编辑，旧序号可能指向别的标题；
 *     大纲在内容变化后防抖重算，下一次变更即自愈（见 outline-view）。
 */

import type { Heading, PhrasingContent, Root, RootContent } from 'mdast';

import { parseMarkdownToMdast } from '../editor/parser.js';

/** 大纲条目：标题层级（1-6）、纯文本标题、序号锚点。 */
export interface OutlineItem {
  /** 标题层级（h1-h6 → 1-6）。 */
  readonly level: number;
  /** 标题纯文本（行内格式已剥离：粗体/斜体取文字，行内代码取代码文本）。 */
  readonly text: string;
  /** 序号锚点：该标题是文档中第 n 个 heading（从 0 起，含各层级）。 */
  readonly anchor: number;
  /** 阅读器定位：PDF 页码（1-based）或流式章节序号（0-based）。 */
  readonly page?: number;
  readonly chapter?: number;
}

/** Current reading/editing location used to highlight a TOC/outline row. */
export interface OutlineLocation {
  readonly chapter?: number;
  readonly page?: number;
  readonly anchor?: number;
}

/** 递归提取行内节点的纯文本（text/inlineCode 取 value，image 取 alt）。 */
function phrasingText(nodes: readonly PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    const withValue = node as { value?: unknown; alt?: unknown };
    if (typeof withValue.value === 'string') {
      out += withValue.value;
    } else if (typeof withValue.alt === 'string') {
      out += withValue.alt;
    }
    const children = (node as { children?: PhrasingContent[] }).children;
    if (Array.isArray(children)) {
      out += phrasingText(children);
    }
  }
  return out;
}

/** 按文档顺序收集块级子树中的全部 heading（含 blockquote 内嵌套标题）。 */
function collectHeadings(children: readonly RootContent[], out: Heading[]): void {
  for (const child of children) {
    if (child.type === 'heading') {
      out.push(child);
      continue;
    }
    const nested = (child as { children?: RootContent[] }).children;
    if (Array.isArray(nested)) {
      collectHeadings(nested, out);
    }
  }
}

/**
 * 从 markdown 文本构建大纲。无标题时返回空数组。
 * 纯函数，不依赖 DOM/编辑器实例，node 环境可直接测试。
 */
export function buildOutline(markdown: string): OutlineItem[] {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    return [];
  }
  const root: Root = parseMarkdownToMdast(markdown);
  const headings: Heading[] = [];
  collectHeadings(root.children, headings);
  return headings.map((heading, index) => ({
    level: heading.depth,
    text: phrasingText(heading.children),
    anchor: index,
  }));
}

/**
 * 计算大纲中的「叶子标题」序号锚点集合：某标题之后到下一个同级或更高级标题
 * 之前没有任何更深子标题（level 更大），即该标题无子标题。无子标题的标题
 * 在大纲中不渲染展开/折叠三角（outline-view 据此跳过折叠标记）。
 */
export function leafHeadingAnchors(items: readonly OutlineItem[]): Set<number> {
  const leaves = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const next = items[i + 1];
    // 下一个标题更深 → 有子标题；否则（同级 / 更高级 / 已是末尾）→ 叶子。
    if (next === undefined || next.level <= items[i].level) {
      leaves.add(items[i].anchor);
    }
  }
  return leaves;
}

export function outlineItemMatchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || text.toLowerCase().includes(needle);
}

/** Keep matches and their ancestor headings so a nested hit still has context. */
export function filterOutlineItems(
  items: readonly OutlineItem[],
  query: string,
): OutlineItem[] {
  if (query.trim() === '') {
    return [...items];
  }
  const matched = new Set<number>();
  items.forEach((item, index) => {
    if (!outlineItemMatchesQuery(item.text, query)) {
      return;
    }
    matched.add(index);
    let level = item.level;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const ancestor = items[cursor]!;
      if (ancestor.level < level) {
        matched.add(cursor);
        level = ancestor.level;
      }
    }
  });
  return items.filter((_, index) => matched.has(index));
}

export function outlineLocationFromReader(state: {
  readonly locationKind: 'page' | 'chapter' | null;
  readonly current: number;
}): OutlineLocation {
  if (state.current <= 0) {
    return {};
  }
  if (state.locationKind === 'chapter') {
    return { chapter: state.current - 1 };
  }
  if (state.locationKind === 'page') {
    return { page: state.current };
  }
  return {};
}

export function outlineItemIsCurrent(
  item: OutlineItem,
  current: OutlineLocation,
): boolean {
  if (current.chapter !== undefined && item.chapter === current.chapter) {
    return true;
  }
  if (current.page !== undefined && item.page === current.page) {
    return true;
  }
  return current.anchor !== undefined && item.anchor === current.anchor;
}

export function lastCurrentOutlineIndex(
  items: readonly OutlineItem[],
  current: OutlineLocation,
): number {
  let found = -1;
  items.forEach((item, index) => {
    if (outlineItemIsCurrent(item, current)) {
      found = index;
    }
  });
  return found;
}

export type OutlineSearchKeyAction =
  | { readonly kind: 'clear' }
  | { readonly kind: 'dismiss' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'select' }
  | { readonly kind: 'stop' };

/** Keys the reader would steal while the contents search field is focused. */
export function outlineSearchKeyIsComposing(event: {
  readonly isComposing?: boolean;
  readonly key?: string;
  readonly keyCode?: number;
}): boolean {
  return event.isComposing === true || event.key === 'Process' || event.keyCode === 229;
}

export function outlineSearchKeyAction(
  key: string,
  query: string,
  composing = false,
): OutlineSearchKeyAction | null {
  if (composing) {
    return null;
  }
  if (key === 'Escape') {
    return query.trim() === '' ? { kind: 'dismiss' } : { kind: 'clear' };
  }
  if (key === 'ArrowDown') {
    return { kind: 'move', delta: 1 };
  }
  if (key === 'ArrowUp') {
    return { kind: 'move', delta: -1 };
  }
  if (key === 'Enter') {
    return { kind: 'select' };
  }
  if (key === 'PageUp' || key === 'PageDown') {
    return { kind: 'stop' };
  }
  return null;
}

/** Scroll only the list, not ancestor windows (WAI listbox: nearest). */
export function scrollChildIntoScroller(scroller: HTMLElement, child: HTMLElement): void {
  if (
    typeof scroller.getBoundingClientRect === 'function' &&
    typeof child.getBoundingClientRect === 'function'
  ) {
    const scrollerBox = scroller.getBoundingClientRect();
    const childBox = child.getBoundingClientRect();
    const scrollerHeight = scrollerBox.bottom - scrollerBox.top;
    if (Number.isFinite(scrollerHeight) && scrollerHeight > 0) {
      if (childBox.top < scrollerBox.top) {
        scroller.scrollTop += childBox.top - scrollerBox.top;
        return;
      }
      if (childBox.bottom > scrollerBox.bottom) {
        scroller.scrollTop += childBox.bottom - scrollerBox.bottom;
        return;
      }
      return;
    }
  }
  if (typeof child.scrollIntoView === 'function') {
    child.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
