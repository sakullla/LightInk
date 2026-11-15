/**
 * `[TOC]` 目录插件（T2 / R6）。
 *
 * 设计（docs/sakullla-workflow/.../02-technical-solution.md §4）：
 *
 *   - 检测「仅含 `[TOC]` 的顶层段落」（trim 后恰为字面标记；行内出现、夹杂
 *     其它文本、标题内的 `[TOC]` 均不触发；嵌套在列表/引用/表格等容器内
 *     的同文段落也不触发），用 widget decoration 把该段落渲染为由当前
 *     标题树生成的可点击目录，原段落经 node decoration 隐藏。
 *
 *   - 文档内容不被改写：本插件只挂 decoration。但序列化层会把 `[TOC]`
 *     转义为 `\[TOC]`（remark-stringify 对 link 语法的消歧，属产品约定
 *     的可往返表示）；重解析后段落文本仍还原为字面 `[TOC]`，触发条件
 *     不变，保存重开后功能往返安全（回归测试见 __tests__/toc.test.ts
 *     「remark 序列化往返」）。
 *
 *   - 点击目录项跳转：点击时按当前文档重新收集标题、按文本+序号匹配
 *     目标位置（不沿用 widget 构建期的 pos，防抖窗口内的标题编辑不会
 *     把跳转带偏），再向该位置 dispatch 选区事务并 scrollIntoView，
 *     同时直接滚动标题 DOM 到可视区顶部。
 *
 *   - 更新时机（防抖重建）：标题/文档变更后 decoration 先按 mapping 平移
 *     （目录内容在防抖窗口内短暂滞后），由 plugin view 调度
 *     `TOC_REBUILD_DEBOUNCE_MS` 防抖后注入 refresh meta 事务统一重建，
 *     保证「防抖窗口内重建一致」且避免每次击键全量重算。
 *
 *   - 标题来源：直接从 live ProseMirror 文档按文档顺序收集 heading 节点，
 *     与 `src/outline/outline-model.ts` 的标题语义同源（同一解析栈产出的
 *     文档顺序 + 层级 + 纯文本），不在编辑器内引入第二份 markdown 重解析。
 *
 *   - 失败行为：无标题时目录渲染空态文案；插件异常不影响文档内容。
 *
 * 纯逻辑层（`isTocParagraphNode` / `collectTocParagraphPositions` /
 * `collectTocHeadings` / `debounce` / `createTocProsePlugin`）headless 可测；
 * 仅 widget DOM 渲染与点击跳转依赖浏览器。
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
} from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

/** 触发目录渲染的字面标记（段落 trim 后须完全等于它）。 */
export const TOC_MARK = '[TOC]';

export interface TocLabels {
  readonly title?: string;
  readonly empty?: string;
}

let tocTitleLabel = '目录';
let tocEmptyLabel = '添加标题后将在此自动生成目录';
const tocViews = new Set<EditorView>();

export function setTocLabels(labels: TocLabels): void {
  let changed = false;
  if (typeof labels.title === 'string' && labels.title !== '' && labels.title !== tocTitleLabel) {
    tocTitleLabel = labels.title;
    changed = true;
  }
  if (typeof labels.empty === 'string' && labels.empty !== '' && labels.empty !== tocEmptyLabel) {
    tocEmptyLabel = labels.empty;
    changed = true;
  }
  if (!changed) return;
  for (const view of tocViews) {
    try {
      view.dispatch(view.state.tr.setMeta(TOC_PLUGIN_KEY, TOC_REFRESH_META));
    } catch {
      /* ignore stale view */
    }
  }
}

/** 目录重建防抖窗口（毫秒）：文档变更后在此窗口内合并重建一次。 */
export const TOC_REBUILD_DEBOUNCE_MS = 150;

/** 触发 decoration 全量重建的 plugin meta 值。 */
export const TOC_REFRESH_META = 'refresh';

export const TOC_PLUGIN_KEY = new PluginKey<DecorationSet>('lightink-toc');

/** 目录条目：标题层级（1-6）、纯文本标题、文档内位置。 */
export interface TocHeading {
  readonly level: number;
  readonly text: string;
  readonly pos: number;
}

// ---------------------------------------------------------------------------
// 纯逻辑层（headless 可测）
// ---------------------------------------------------------------------------

/**
 * True when this node is a paragraph whose entire text content (trimmed) is
 * the literal `[TOC]` marker. Headings, list items, mixed text, and inline
 * occurrences do not qualify.
 */
export function isTocParagraphNode(node: PMNode): boolean {
  return node.type.name === 'paragraph' && node.textContent.trim() === TOC_MARK;
}

/**
 * Walk the doc's top-level children and collect positions of `[TOC]` marker
 * paragraphs. Marker paragraphs nested inside lists, blockquotes, tables, or
 * any other container do NOT trigger the TOC widget — only top-level
 * paragraphs qualify.
 */
export function collectTocParagraphPositions(doc: PMNode): number[] {
  const out: number[] = [];
  // Top-level children start at offset 0 within the doc, so forEach's offset
  // is the absolute position of each child node.
  doc.forEach((node, offset) => {
    if (isTocParagraphNode(node)) {
      out.push(offset);
    }
  });
  return out;
}

/**
 * Collect headings in document order (mirrors outline-model semantics applied
 * to the live PM doc). Returns level / plain text / position per heading.
 */
export function collectTocHeadings(doc: PMNode): TocHeading[] {
  const out: TocHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const rawLevel: unknown = node.attrs['level'];
    const level = typeof rawLevel === 'number' && rawLevel >= 1 && rawLevel <= 6
      ? rawLevel
      : 1;
    out.push({ level, text: node.textContent, pos });
  });
  return out;
}

/**
 * 点击时按当前文档重新定位目标标题：在所有标题里找第 `ordinal` 个（从 0
 * 计）文本为 `text` 的标题，返回其当前位置；无匹配返回 null。
 *
 * widget 点击不沿用构建期捕获的 pos——防抖窗口内的标题编辑会让旧 pos 指向
 * 偏移位置，按「文本 + 同文序号」重匹配能把跳转锚回用户看到的那个标题。
 */
export function resolveHeadingPos(
  doc: PMNode,
  text: string,
  ordinal: number,
): number | null {
  let seen = 0;
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null || node.type.name !== 'heading') return;
    if (node.textContent !== text) return;
    if (seen === ordinal) {
      found = pos;
      return;
    }
    seen += 1;
  });
  return found;
}

/** A debounced function with an attached `cancel()` for teardown. */
export interface DebouncedFn<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/**
 * Trailing-edge debounce: rapid calls collapse into one invocation `wait` ms
 * after the last call, with the latest arguments.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
): DebouncedFn<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

/**
 * 跳转滚动到 `pos` 处的标题：先把选区移到标题内（可撤销栈不受影响，
 * scrollIntoView 让 PM 自行滚动），再直接滚动标题 DOM 到视口顶部。
 * 目标位置无效或已非标题时返回 false。
 */
export function jumpToHeading(view: EditorView, pos: number): boolean {
  const { doc } = view.state;
  if (pos < 0 || pos >= doc.content.size) return false;
  const node = doc.nodeAt(pos);
  if (node === null || node.type.name !== 'heading') return false;
  const selPos = Math.min(pos + 1, doc.content.size);
  let tr = view.state.tr;
  try {
    tr = tr.setSelection(TextSelection.near(doc.resolve(selPos)));
  } catch {
    // 极端结构下选区解析失败：仍尝试滚动 DOM。
  }
  view.dispatch(tr.scrollIntoView());
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement) {
    let behavior: ScrollBehavior = 'smooth';
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        behavior = 'auto';
      }
    } catch {
      behavior = 'auto';
    }
    dom.scrollIntoView({ block: 'start', behavior });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Widget DOM（仅浏览器路径；headless 测试不触发）
// ---------------------------------------------------------------------------

function createTocWidget(
  headings: readonly TocHeading[],
  getView: () => EditorView | null,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'lightink-toc';
  container.contentEditable = 'false';
  container.setAttribute('role', 'navigation');
  container.setAttribute('aria-label', tocTitleLabel);

  const header = document.createElement('div');
  header.className = 'lightink-toc-header';
  header.textContent = tocTitleLabel;
  container.appendChild(header);

  if (headings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lightink-toc-empty';
    empty.textContent = tocEmptyLabel;
    container.appendChild(empty);
    return container;
  }

  const minLevel = headings.reduce((min, h) => Math.min(min, h.level), 6);
  const list = document.createElement('ul');
  list.className = 'lightink-toc-list';
  list.style.listStyle = 'none';
  list.style.margin = '0';
  list.style.padding = '0';
  // 同文标题的出现序号：点击时与文本一起用于在当前文档中重定位目标，
  // 避免沿用构建期 pos 在防抖窗口内被编辑带偏。
  const ordinals = new Map<string, number>();
  for (const heading of headings) {
    const ordinal = ordinals.get(heading.text) ?? 0;
    ordinals.set(heading.text, ordinal + 1);
    const item = document.createElement('li');
    item.className = 'lightink-toc-item';
    item.dataset['level'] = String(heading.level);
    const depth = Math.max(0, heading.level - minLevel);
    item.style.paddingLeft = `${depth * 1.15}em`;

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'lightink-toc-link';
    link.textContent = heading.text === '' ? '(无标题)' : heading.text;
    link.style.cursor = 'pointer';
    // 阻止 PM 抢占焦点/放置光标。
    link.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const view = getView();
      if (view === null) return;
      const target = resolveHeadingPos(view.state.doc, heading.text, ordinal);
      if (target !== null) {
        jumpToHeading(view, target);
      }
    });
    item.appendChild(link);
    list.appendChild(item);
  }
  container.appendChild(list);
  return container;
}

function buildDecorations(
  doc: PMNode,
  getView: () => EditorView | null,
): DecorationSet {
  const headings = collectTocHeadings(doc);
  const decorations: Decoration[] = [];
  for (const pos of collectTocParagraphPositions(doc)) {
    const node = doc.nodeAt(pos);
    if (node === null) continue;
    decorations.push(
      Decoration.widget(pos, () => createTocWidget(headings, getView), {
        side: -1,
        key: `lightink-toc-${pos}`,
        ignoreSelection: true,
      }),
    );
    // 隐藏字面 `[TOC]` 段落（文档内容不变，仅渲染替换）。
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'lightink-toc-source',
        style: 'display:none',
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// ProseMirror / Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * 构建原生 ProseMirror 插件（导出供 headless 单测直接挂到 EditorState）。
 * 文档变更时只映射旧 decoration，由 view 层防抖后注入 refresh meta 重建。
 */
export function createTocProsePlugin(): Plugin {
  let viewRef: EditorView | null = null;
  const getView = (): EditorView | null => viewRef;

  return new Plugin({
    key: TOC_PLUGIN_KEY,
    state: {
      init: (_config, state) => buildDecorations(state.doc, getView),
      apply: (tr, old, _oldState, newState) => {
        if (tr.getMeta(TOC_PLUGIN_KEY) === TOC_REFRESH_META) {
          return buildDecorations(newState.doc, getView);
        }
        // 防抖窗口内：decoration 随 mapping 平移，目录内容短暂滞后，待
        // refresh meta 事务统一重建（见 view.update 的调度）。
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return TOC_PLUGIN_KEY.getState(state);
      },
    },
    view(editorView) {
      viewRef = editorView;
      tocViews.add(editorView);
      const schedule = debounce(() => {
        const view = viewRef;
        if (view === null) return;
        view.dispatch(view.state.tr.setMeta(TOC_PLUGIN_KEY, TOC_REFRESH_META));
      }, TOC_REBUILD_DEBOUNCE_MS);
      return {
        update(view, prevState) {
          viewRef = view;
          if (!view.state.doc.eq(prevState.doc)) {
            schedule();
          }
        },
        destroy() {
          schedule.cancel();
          tocViews.delete(editorView);
          viewRef = null;
        },
      };
    },
  });
}

/**
 * Milkdown `$prose` 插件：把 `[TOC]` 段落渲染为可点击目录。
 * 在 `index.ts` 中于 gfm/frontmatter 之后注册（`editor.use(tocPlugin)`）。
 */
export const tocPlugin = $prose(() => createTocProsePlugin());
