/**
 * 查找与替换插件（T4 / R2）。
 *
 * 组成：
 *
 *   - `$prose` 插件（WYSIWYG）：按查询串在 live ProseMirror 文档内收集全部命中
 *     （逐 text 节点、大小写不敏感、不跨节点），以 inline decoration 高亮全部
 *     命中，当前命中叠加独立样式；查询/当前项经 plugin meta 事务驱动。
 *
 *   - 事务构建器（headless 可测）：`findQueryTr` / `stepMatchTr` /
 *     `replaceCurrentTr` / `replaceAllTr` 均以「单个 ProseMirror 事务」完成
 *     选区移动或替换（参考 EditorInstance.setLink 的单事务模式），因此替换可
 *     经既有 history 撤销一次回到替换前。
 *
 *   - 视图注册表：Milkdown 的 EditorInstance 不暴露底层 EditorView，本模块在
 *     插件 view 钩子中把 `view.dom → EditorView` 登记进模块级 Map，壳层经
 *     `findReplaceViewForHost(tab.hostElement)` 反查当前标签的视图。
 *
 *   - 源码模式纯逻辑：`collectSourceMatches` 在 textarea 文本上收集命中；
 *     壳层用原生 selection + document.execCommand('insertText') 执行替换以
 *     保留 textarea 原生 undo（不用 setRangeText，它会清空原生撤销栈）。
 *
 *   - 壳层面板 `createFindReplacePanel`：查找/替换输入、上一处/下一处、
 *     「替换」「全部替换」两个可区分按钮、命中计数；无匹配时显示可观察空态
 *     （data 属性 + 文案）并禁用替换按钮。面板自身不触模型，全部经 handlers
 *     回调由壳层按当前模式分派。
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

export const FIND_REPLACE_PLUGIN_KEY = new PluginKey<FindReplaceState>('lightink-find-replace');

/** 一处命中在 PM 文档中的位置区间。 */
export interface FindMatch {
  readonly from: number;
  readonly to: number;
}

/** 插件状态：当前查询串、命中列表、当前命中下标（-1 = 无）、decoration 集。 */
export interface FindReplaceState {
  readonly query: string;
  readonly matches: readonly FindMatch[];
  readonly active: number;
  readonly decorations: DecorationSet;
}

type FindReplaceMeta =
  | { readonly type: 'query'; readonly query: string }
  | { readonly type: 'active'; readonly index: number };

/** 全部命中的 decoration class；当前命中额外叠加 current class。 */
export const FIND_MATCH_CLASS = 'lightink-find-match';
export const FIND_MATCH_CURRENT_CLASS = 'lightink-find-match-current';

// ---------------------------------------------------------------------------
// 纯逻辑层（headless 可测）
// ---------------------------------------------------------------------------

/**
 * 在 PM 文档内收集查询串的全部命中（逐 text 节点、大小写不敏感、不重叠、
 * 不跨节点边界）。空查询返回空数组。
 */
export function collectMatches(doc: PMNode, query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const haystack = (node.text ?? '').toLowerCase();
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      out.push({ from: pos + idx, to: pos + idx + needle.length });
      idx = haystack.indexOf(needle, idx + needle.length);
    }
  });
  return out;
}

/** 源码模式：在纯文本上收集命中（与 collectMatches 同一大小写口径）。 */
export interface SourceTextMatch {
  readonly start: number;
  readonly end: number;
}

export function collectSourceMatches(text: string, query: string): SourceTextMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const out: SourceTextMatch[] = [];
  const haystack = text.toLowerCase();
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push({ start: idx, end: idx + needle.length });
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/** 环形步进：total 为 0 返回 -1；active 越界时按方向落到首/尾。 */
export function nextMatchIndex(total: number, active: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (active < 0 || active >= total) return dir === 1 ? 0 : total - 1;
  return (active + dir + total) % total;
}

function buildFindDecorations(
  doc: PMNode,
  matches: readonly FindMatch[],
  active: number,
): DecorationSet {
  const decorations = matches.map((match, index) => {
    const current = index === active;
    // 纸墨工作室：命中高亮消费主题令牌（accent=当前项、highlight=其余项），
    // 不再硬编码 rgba 橙/黄。inline style 中的 var() 在编辑器 DOM 内正常解析。
    return Decoration.inline(match.from, match.to, {
      class: current ? `${FIND_MATCH_CLASS} ${FIND_MATCH_CURRENT_CLASS}` : FIND_MATCH_CLASS,
      style: current
        ? 'background-color: color-mix(in srgb, var(--lightink-accent) 55%, transparent); ' +
          'outline: 1px solid color-mix(in srgb, var(--lightink-accent) 75%, transparent); ' +
          'border-radius: 2px;'
        : 'background-color: color-mix(in srgb, var(--lightink-highlight) 42%, transparent); ' +
          'border-radius: 2px;',
    });
  });
  return DecorationSet.create(doc, decorations);
}

const EMPTY_STATE: FindReplaceState = {
  query: '',
  matches: [],
  active: -1,
  decorations: DecorationSet.empty,
};

/**
 * 构建原生 ProseMirror 插件（导出供 headless 单测直接挂到 EditorState）。
 * 文档变更且查询非空时全量重收命中（替换/编辑后命中位置即 fresh），
 * 当前下标收敛到有效范围。
 */
export function createFindReplaceProsePlugin(): Plugin {
  return new Plugin({
    key: FIND_REPLACE_PLUGIN_KEY,
    state: {
      init: (): FindReplaceState => EMPTY_STATE,
      apply: (tr, old, _oldState, newState): FindReplaceState => {
        const meta = tr.getMeta(FIND_REPLACE_PLUGIN_KEY) as FindReplaceMeta | undefined;
        let query = old.query;
        let matches = old.matches;
        let active = old.active;
        let decorations = old.decorations;
        let rebuilt = false;

        const recompute = (nextQuery: string, preferredActive: number): void => {
          query = nextQuery;
          matches = collectMatches(newState.doc, query);
          if (matches.length === 0) {
            active = -1;
          } else if (preferredActive < 0) {
            active = 0;
          } else {
            active = Math.min(preferredActive, matches.length - 1);
          }
          decorations = buildFindDecorations(newState.doc, matches, active);
          rebuilt = true;
        };

        if (meta?.type === 'query') {
          // 显式设置查询：跳到首命中（-1 语义 → 0）。
          recompute(meta.query, -1);
        } else if (tr.docChanged && query !== '') {
          // 编辑/替换后按当前查询重收，保持当前下标（收敛到范围内）。
          recompute(query, active);
        }

        if (meta?.type === 'active') {
          active = matches.length === 0 ? -1 : Math.min(Math.max(meta.index, 0), matches.length - 1);
          decorations = buildFindDecorations(newState.doc, matches, active);
          rebuilt = true;
        }

        if (!rebuilt && tr.docChanged && matches.length > 0) {
          // 防御：理论上 docChanged 且 query 非空必然 recompute；兜底映射。
          decorations = decorations.map(tr.mapping, tr.doc);
        }
        return { query, matches, active, decorations };
      },
    },
    props: {
      decorations(state) {
        return FIND_REPLACE_PLUGIN_KEY.getState(state)?.decorations ?? null;
      },
    },
    view(editorView) {
      findReplaceViews.set(editorView.dom, editorView);
      let lastKey = '';
      let lastDoc = editorView.state.doc;
      return {
        update(view) {
          // 文档变了：先通知壳层（脏标记 / 字数栏 / 大纲），再同步查找面板。
          if (view.state.doc !== lastDoc) {
            lastDoc = view.state.doc;
            emitFindReplaceDocChange(view);
          }
          const fr = pluginStateOf(view.state);
          if (fr === null) return;
          // 任意文档变更/查询变更后，命中列表或当前项可能变；通知壳层面板。
          const key = `${fr.query}|${fr.active}|${fr.matches.length}|${view.state.doc.content.size}`;
          if (key === lastKey) return;
          lastKey = key;
          emitFindReplaceStatus(view);
        },
        destroy() {
          findReplaceViews.delete(editorView.dom);
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 事务构建器（headless 可测；view 包装层仅 dispatch）
// ---------------------------------------------------------------------------

function pluginStateOf(state: EditorState): FindReplaceState | null {
  return FIND_REPLACE_PLUGIN_KEY.getState(state) ?? null;
}

/**
 * 设置查询串的事务：meta 驱动命中重收；有命中时把选区移到首命中并滚动可见
 * （选区事务不产生 history 撤销步）。查询为空即清除全部高亮。
 */
export function findQueryTr(state: EditorState, query: string): Transaction {
  const tr = state.tr.setMeta(FIND_REPLACE_PLUGIN_KEY, {
    type: 'query',
    query,
  } satisfies FindReplaceMeta);
  const matches = collectMatches(state.doc, query);
  const first = matches[0];
  if (first !== undefined) {
    tr.setSelection(TextSelection.create(state.doc, first.from, first.to)).scrollIntoView();
  }
  return tr;
}

/** 步进到上/下一命中的事务（环形）；无命中返回 null。 */
export function stepMatchTr(state: EditorState, dir: 1 | -1): Transaction | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.matches.length === 0) return null;
  const next = nextMatchIndex(fr.matches.length, fr.active, dir);
  const match = fr.matches[next];
  if (match === undefined) return null;
  return state.tr
    .setMeta(FIND_REPLACE_PLUGIN_KEY, { type: 'active', index: next } satisfies FindReplaceMeta)
    .setSelection(TextSelection.create(state.doc, match.from, match.to))
    .scrollIntoView();
}

/**
 * 「替换当前」：单个事务把当前命中替换为 replacement，光标落在替换文本末尾。
 * 插件 apply 会因 docChanged 自动重收命中并保持下标（下一次替换即原位置的
 * 下一命中）。无当前命中返回 null。
 */
export function replaceCurrentTr(state: EditorState, replacement: string): Transaction | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.active < 0 || fr.active >= fr.matches.length) return null;
  const match = fr.matches[fr.active];
  if (match === undefined) return null;
  const tr = state.tr.insertText(replacement, match.from, match.to);
  tr.setSelection(TextSelection.create(tr.doc, match.from + replacement.length)).scrollIntoView();
  return tr;
}

/**
 * 「全部替换」：全部命中在单个事务内自后向前替换（位置不被前序替换带偏），
 * 因此一次 undo 即回到替换前。返回事务与替换处数；无命中返回 null。
 */
export function replaceAllTr(
  state: EditorState,
  replacement: string,
): { tr: Transaction; count: number } | null {
  const fr = pluginStateOf(state);
  if (fr === null || fr.matches.length === 0) return null;
  const tr = state.tr;
  for (let i = fr.matches.length - 1; i >= 0; i -= 1) {
    const match = fr.matches[i];
    if (match !== undefined) {
      tr.insertText(replacement, match.from, match.to);
    }
  }
  tr.scrollIntoView();
  return { tr, count: fr.matches.length };
}

// ---------------------------------------------------------------------------
// EditorView 包装层 + 视图注册表（壳层经 host 反查当前标签视图）
// ---------------------------------------------------------------------------

const findReplaceViews = new Map<HTMLElement, EditorView>();

/**
 * 查找状态变化订阅者（粘贴/键入/替换等任意 PM 事务后触发）。
 * 壳层面板靠此刷新 1/N——仅靠宿主 `input` 会漏掉 Milkdown insert()/部分粘贴路径。
 */
export type FindReplaceStatusListener = (
  view: EditorView,
  status: { query: string; active: number; total: number },
) => void;

const findReplaceStatusListeners = new Set<FindReplaceStatusListener>();

/** 订阅查找状态变化；返回取消订阅函数。 */
export function subscribeFindReplaceStatus(listener: FindReplaceStatusListener): () => void {
  findReplaceStatusListeners.add(listener);
  return () => {
    findReplaceStatusListeners.delete(listener);
  };
}

function emitFindReplaceStatus(view: EditorView): void {
  if (findReplaceStatusListeners.size === 0) return;
  const fr = pluginStateOf(view.state);
  if (fr === null) return;
  const status = { query: fr.query, active: fr.active, total: fr.matches.length };
  for (const listener of findReplaceStatusListeners) {
    try {
      listener(view, status);
    } catch {
      // 壳层监听器异常不影响编辑器事务。
    }
  }
}

/**
 * WYSIWYG 文档变更订阅（任意 docChanged 事务后）。
 * 粘贴经 handlePaste/insert() 时宿主常只收到 paste、收不到事后 input，
 * 字数栏/脏标记/查找计数都依赖此通道在事务提交后重读 getMarkdown。
 */
export type FindReplaceDocChangeListener = (view: EditorView) => void;

const findReplaceDocChangeListeners = new Set<FindReplaceDocChangeListener>();

/** 订阅 WYSIWYG 文档变更；返回取消订阅函数。 */
export function subscribeFindReplaceDocChange(
  listener: FindReplaceDocChangeListener,
): () => void {
  findReplaceDocChangeListeners.add(listener);
  return () => {
    findReplaceDocChangeListeners.delete(listener);
  };
}

function emitFindReplaceDocChange(view: EditorView): void {
  for (const listener of findReplaceDocChangeListeners) {
    try {
      listener(view);
    } catch {
      // 壳层监听器异常不影响编辑器事务。
    }
  }
}

/** 反查标签宿主内 WYSIWYG 视图的 EditorView（源码覆盖层/未挂载时返回 null）。 */
export function findReplaceViewForHost(host: HTMLElement): EditorView | null {
  const dom = host.querySelector('.ProseMirror');
  if (!(dom instanceof HTMLElement)) return null;
  return findReplaceViews.get(dom) ?? null;
}

/** 读取当前查询状态（壳层面板计数用）。 */
export function readFindReplaceState(
  view: EditorView,
): { query: string; active: number; total: number } | null {
  const fr = pluginStateOf(view.state);
  if (fr === null) return null;
  return { query: fr.query, active: fr.active, total: fr.matches.length };
}

export function setFindQuery(view: EditorView, query: string): void {
  view.dispatch(findQueryTr(view.state, query));
  scrollActiveMatchIntoView(view);
}

/**
 * 把当前活动命中滚动到编辑区可视范围。
 *
 * 面板按钮/输入框驱动时 DOM 焦点在面板里：ProseMirror 的 tr.scrollIntoView()
 * 走 scrollToSelection()，要求 DOM 选区 focusNode 落在编辑器内，否则直接跳过
 * （2026-08-09 实测：点「下一处」选区已移动但容器不滚动）。
 *
 * 另外 `Element.scrollIntoView({block:'nearest'})` 在命中已部分可见时几乎
 * 不滚，点「上一处」回跳上方时尤其明显；这里按 match 的 viewport 坐标直接
 * 调整 `#lightink-editor-area`（或最近的可滚动祖先）的 scrollTop，并留边距。
 */
function scrollActiveMatchIntoView(view: EditorView): void {
  const { from, to } = view.state.selection;
  let start: { top: number; bottom: number };
  let end: { top: number; bottom: number };
  try {
    start = view.coordsAtPos(from);
    end = view.coordsAtPos(Math.max(to, from));
  } catch {
    return; // stub view / 未挂载等环境：静默跳过
  }

  const scroller = findFindScrollContainer(view.dom);
  if (scroller === null) {
    // 无滚动容器时回落：尽量把命中节点滚到视口中部。
    let domPos: { node: Node; offset: number };
    try {
      domPos = view.domAtPos(from);
    } catch {
      return;
    }
    const node = domPos.node;
    const el =
      node.nodeType === 3
        ? node.parentElement
        : node instanceof HTMLElement
          ? node
          : null;
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return;
  }

  const scRect = scroller.getBoundingClientRect();
  const targetTop = Math.min(start.top, end.top);
  const targetBottom = Math.max(start.bottom, end.bottom);
  // 面板叠在右上角：上下各留边，避免命中被面板/边缘挡住。
  const margin = 72;
  if (targetTop < scRect.top + margin) {
    scroller.scrollTop -= scRect.top + margin - targetTop;
  } else if (targetBottom > scRect.bottom - margin) {
    scroller.scrollTop += targetBottom - (scRect.bottom - margin);
  }
}

/** 查找编辑区滚动容器：优先 #lightink-editor-area，否则最近 overflow 可滚祖先。 */
function findFindScrollContainer(fromEl: HTMLElement): HTMLElement | null {
  const byId = fromEl.ownerDocument.getElementById('lightink-editor-area');
  if (byId instanceof HTMLElement) return byId;
  let el: HTMLElement | null = fromEl.parentElement;
  while (el !== null && el !== fromEl.ownerDocument.body) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    const oy = style?.overflowY ?? '';
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function stepFindMatch(view: EditorView, dir: 1 | -1): void {
  const tr = stepMatchTr(view.state, dir);
  if (tr !== null) {
    view.dispatch(tr);
    scrollActiveMatchIntoView(view);
  }
}

/** 「替换当前」。返回是否实际执行了替换。 */
export function replaceCurrentMatch(view: EditorView, replacement: string): boolean {
  const tr = replaceCurrentTr(view.state, replacement);
  if (tr === null) return false;
  view.dispatch(tr);
  scrollActiveMatchIntoView(view);
  return true;
}

/** 「全部替换」（单事务、一次 undo 可回）。返回替换处数。 */
export function replaceAllMatches(view: EditorView, replacement: string): number {
  const result = replaceAllTr(view.state, replacement);
  if (result === null) return 0;
  view.dispatch(result.tr);
  return result.count;
}

/** 清除高亮（关闭面板时调用）。 */
export function clearFindReplace(view: EditorView): void {
  if (pluginStateOf(view.state)?.query !== '') {
    view.dispatch(findQueryTr(view.state, ''));
  }
}

/**
 * Milkdown `$prose` 插件：WYSIWYG 查找高亮。在 `index.ts` 中随其余
 * decoration 插件注册（`editor.use(findReplacePlugin)`）。
 */
export const findReplacePlugin = $prose(() => createFindReplaceProsePlugin());

// ---------------------------------------------------------------------------
// 壳层面板（DOM 层；纯逻辑在上，面板只发 handlers 回调）
// ---------------------------------------------------------------------------

/**
 * 纸墨工作室 §3.10：查找面板钉版心右上。纯几何计算（headless 可测）——
 * 输入三个矩形（面板定位容器 #lightink-main、滚动容器 #lightink-editor-area、
 * 活动版心 .lightink-tab-host，均为 viewport 坐标），输出面板在定位容器内的
 * `top` / `right` 偏移：
 *   - top = 编辑区顶缘 + 8px（面板不随内容滚动，钉在可视区顶部）；
 *   - right = 版心右缘向内 12px（与版心右缘对齐，而非整个主区右缘）。
 * 版心缺失（无活动 markdown 标签）返回 null，调用方保留 theme.css 的右上角
 * 兜底定位。
 */
export interface FindPanelPinRects {
  /** 面板定位容器（#lightink-main）。 */
  readonly main: { readonly top: number; readonly right: number };
  /** 编辑区滚动容器（#lightink-editor-area）。 */
  readonly area: { readonly top: number };
  /** 活动版心（.lightink-tab-host）。 */
  readonly host: { readonly right: number };
}

export interface FindPanelPin {
  readonly top: number;
  readonly right: number;
}

export function computeFindPanelPin(rects: FindPanelPinRects): FindPanelPin {
  const top = rects.area.top - rects.main.top + 8;
  const right = Math.max(rects.main.right - rects.host.right + 12, 12);
  return { top, right };
}

/** 面板内边距（top/right），钉位失败时清除 inline 值回落 theme.css 兜底。 */
function applyFindPanelPin(root: HTMLElement, pin: FindPanelPin | null): void {
  if (pin === null) {
    root.style.removeProperty('top');
    root.style.removeProperty('right');
    return;
  }
  root.style.top = `${pin.top}px`;
  root.style.right = `${pin.right}px`;
}

/** 解析当前可视版心（多标签时未激活宿主 display:none → offsetParent 为 null）。 */
function visibleTabHost(doc: Document): HTMLElement | null {
  const area = doc.getElementById('lightink-editor-area');
  if (area === null) return null;
  for (const host of area.querySelectorAll<HTMLElement>('.lightink-tab-host')) {
    if (!(host.classList.contains('lightink-tab-host--reader')) && host.offsetParent !== null) {
      return host;
    }
  }
  return null;
}

export interface FindReplaceLabels {
  readonly findPlaceholder: string;
  readonly replacePlaceholder: string;
  readonly prev: string;
  readonly next: string;
  readonly replace: string;
  readonly replaceAll: string;
  readonly close: string;
  /** 无匹配空态文案。 */
  readonly empty: string;
  /** 命中计数文案（active 为 0 基下标）。 */
  count(active: number, total: number): string;
}

export interface FindReplacePanelHandlers {
  onQueryChange(query: string): void;
  onNext(): void;
  onPrev(): void;
  onReplace(replacement: string): void;
  onReplaceAll(replacement: string): void;
  onClose(): void;
}

export interface FindReplacePanel {
  readonly element: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** 刷新计数/空态/替换按钮可用性（total=0 且无命中时禁用替换）。 */
  setStatus(total: number, active: number): void;
  getQuery(): string;
  /** 预填查找框（Ctrl+F 带上当前选区时用）；不自动触发 onQueryChange。 */
  setQuery(query: string): void;
  focusFind(): void;
}

/** 内联 SVG 图标（currentColor，随主题）。 */
const FIND_ICON_SEARCH =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';
const FIND_ICON_REPLACE =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3 5h8.5M9 2.5 11.5 5 9 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M13 11H4.5M7 8.5 4.5 11 7 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const FIND_ICON_PREV =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const FIND_ICON_NEXT =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const FIND_ICON_CLOSE =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
  '</svg>';
const FIND_ICON_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

function iconButton(
  doc: Document,
  className: string,
  svg: string,
  label: string,
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = `lightink-find-icon-btn ${className}`;
  btn.innerHTML = svg;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  return btn;
}

function fieldIcon(doc: Document, svg: string, className: string): HTMLSpanElement {
  const el = doc.createElement('span');
  el.className = `lightink-find-panel__glyph ${className}`;
  el.innerHTML = svg;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * 创建查找替换面板（初始隐藏）。
 * 壳层应 append 到非滚动容器（#lightink-main），用 absolute 贴右上角——
 * 若挂在 #lightink-editor-area 内，滚动命中时面板会一起被卷走。
 * 面板不感知模式：查询/步进/替换全部经 handlers 由壳层按 WYSIWYG/源码分派。
 * 外观由 theme.css `.lightink-find-panel*` 负责（VS Code / Typora 风格紧凑浮层）。
 */
export function createFindReplacePanel(
  doc: Document,
  labels: FindReplaceLabels,
  handlers: FindReplacePanelHandlers,
): FindReplacePanel {
  const root = doc.createElement('div');
  root.className = 'lightink-find-panel';
  root.setAttribute('role', 'search');
  root.setAttribute('aria-label', labels.findPlaceholder);

  // —— 查找行 ——
  const expandBtn = iconButton(
    doc,
    'lightink-find-expand',
    FIND_ICON_CHEVRON,
    labels.replacePlaceholder,
  );
  expandBtn.setAttribute('aria-expanded', 'false');
  expandBtn.setAttribute('aria-controls', 'lightink-find-replace-row');

  const findInput = doc.createElement('input');
  findInput.type = 'text';
  findInput.className = 'lightink-find-input';
  findInput.placeholder = labels.findPlaceholder;
  findInput.setAttribute('aria-label', labels.findPlaceholder);
  findInput.autocomplete = 'off';
  findInput.spellcheck = false;

  const status = doc.createElement('span');
  status.className = 'lightink-find-status';
  status.setAttribute('aria-live', 'polite');

  const findField = doc.createElement('div');
  findField.className = 'lightink-find-panel__field';
  findField.append(
    fieldIcon(doc, FIND_ICON_SEARCH, 'lightink-find-panel__glyph--search'),
    findInput,
    status,
  );

  const prevBtn = iconButton(doc, 'lightink-find-prev', FIND_ICON_PREV, labels.prev);
  const nextBtn = iconButton(doc, 'lightink-find-next', FIND_ICON_NEXT, labels.next);
  const closeBtn = iconButton(doc, 'lightink-find-close', FIND_ICON_CLOSE, labels.close);

  const rowFind = doc.createElement('div');
  rowFind.className = 'lightink-find-panel__row lightink-find-panel__row--find';
  rowFind.append(expandBtn, findField, prevBtn, nextBtn, closeBtn);

  // —— 替换行（可折叠，默认收起；点展开或 Ctrl+H 语义由壳层 open 后 setReplaceOpen）——
  const replaceInput = doc.createElement('input');
  replaceInput.type = 'text';
  replaceInput.className = 'lightink-replace-input';
  replaceInput.placeholder = labels.replacePlaceholder;
  replaceInput.setAttribute('aria-label', labels.replacePlaceholder);
  replaceInput.autocomplete = 'off';
  replaceInput.spellcheck = false;

  const replaceField = doc.createElement('div');
  replaceField.className = 'lightink-find-panel__field';
  replaceField.append(
    fieldIcon(doc, FIND_ICON_REPLACE, 'lightink-find-panel__glyph--replace'),
    replaceInput,
  );

  const replaceBtn = doc.createElement('button');
  replaceBtn.type = 'button';
  replaceBtn.className = 'lightink-find-text-btn lightink-replace-current';
  replaceBtn.textContent = labels.replace;
  replaceBtn.title = labels.replace;

  const replaceAllBtn = doc.createElement('button');
  replaceAllBtn.type = 'button';
  replaceAllBtn.className = 'lightink-find-text-btn lightink-replace-all';
  replaceAllBtn.textContent = labels.replaceAll;
  replaceAllBtn.title = labels.replaceAll;

  const rowReplace = doc.createElement('div');
  rowReplace.className = 'lightink-find-panel__row lightink-find-panel__row--replace';
  rowReplace.id = 'lightink-find-replace-row';
  rowReplace.hidden = true;
  rowReplace.append(replaceField, replaceBtn, replaceAllBtn);

  root.append(rowFind, rowReplace);

  let open = false;
  let replaceOpen = false;

  // —— 钉版心右上（§3.10）——
  const view = doc.defaultView;
  let pinCleanup: (() => void) | null = null;
  // 同值短路：写 inline top/right 本身会触发下方的 MutationObserver，
  // 位置未变时跳过写入，避免观察器自反馈循环。
  let lastPinKey = '';

  const pinNow = (): void => {
    const mainEl = root.parentElement;
    const areaEl = doc.getElementById('lightink-editor-area');
    const hostEl = visibleTabHost(doc);
    if (
      mainEl === null ||
      areaEl === null ||
      hostEl === null ||
      typeof mainEl.getBoundingClientRect !== 'function' ||
      typeof areaEl.getBoundingClientRect !== 'function' ||
      typeof hostEl.getBoundingClientRect !== 'function'
    ) {
      if (lastPinKey !== 'fallback') {
        lastPinKey = 'fallback';
        applyFindPanelPin(root, null);
      }
      return;
    }
    const pin = computeFindPanelPin({
      main: mainEl.getBoundingClientRect(),
      area: areaEl.getBoundingClientRect(),
      host: hostEl.getBoundingClientRect(),
    });
    const key = `${pin.top}|${pin.right}`;
    if (key === lastPinKey) return;
    lastPinKey = key;
    applyFindPanelPin(root, pin);
  };

  const stopPinning = (): void => {
    pinCleanup?.();
    pinCleanup = null;
  };

  const startPinning = (): void => {
    stopPinning();
    pinNow();
    const cleanups: Array<() => void> = [];
    if (view !== null && typeof view.addEventListener === 'function') {
      const onResize = (): void => {
        pinNow();
      };
      view.addEventListener('resize', onResize);
      cleanups.push(() => view.removeEventListener('resize', onResize));
    }
    // 大纲调宽/三态切换、标签切换都会改动 #lightink-main 子树的 style/class，
    // 据此重钉；attributes-only 观察开销可忽略（仅面板打开期间存在）。
    if (typeof MutationObserver === 'function' && root.parentElement !== null) {
      let raf = 0;
      const observer = new MutationObserver(() => {
        if (raf !== 0) return;
        raf = view?.requestAnimationFrame?.(() => {
          raf = 0;
          pinNow();
        }) ?? 0;
        if (raf === 0) pinNow();
      });
      observer.observe(root.parentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
        subtree: true,
      });
      cleanups.push(() => {
        if (raf !== 0 && view !== null) view.cancelAnimationFrame?.(raf);
        observer.disconnect();
      });
    }
    pinCleanup = () => {
      for (const cleanup of cleanups) cleanup();
    };
  };

  const setReplaceOpen = (next: boolean): void => {
    replaceOpen = next;
    rowReplace.hidden = !next;
    root.classList.toggle('is-replace-open', next);
    expandBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    expandBtn.classList.toggle('is-expanded', next);
  };

  findInput.addEventListener('input', () => {
    handlers.onQueryChange(findInput.value);
  });
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        handlers.onPrev();
      } else {
        handlers.onNext();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  });
  replaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        handlers.onReplaceAll(replaceInput.value);
      } else {
        handlers.onReplace(replaceInput.value);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      panel.close();
    }
  });
  prevBtn.addEventListener('click', () => handlers.onPrev());
  nextBtn.addEventListener('click', () => handlers.onNext());
  replaceBtn.addEventListener('click', () => handlers.onReplace(replaceInput.value));
  replaceAllBtn.addEventListener('click', () => handlers.onReplaceAll(replaceInput.value));
  closeBtn.addEventListener('click', () => panel.close());
  expandBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = !replaceOpen;
    setReplaceOpen(next);
    if (next) {
      // 展开后把焦点放进替换框，便于直接输入。
      queueMicrotask(() => replaceInput.focus());
    } else {
      findInput.focus();
    }
  });

  const panel: FindReplacePanel = {
    element: root,
    open(): void {
      open = true;
      root.classList.add('is-open');
      startPinning();
      panel.focusFind();
    },
    close(): void {
      if (!open) return;
      open = false;
      root.classList.remove('is-open');
      stopPinning();
      lastPinKey = '';
      applyFindPanelPin(root, null);
      handlers.onClose();
    },
    isOpen(): boolean {
      return open;
    },
    setStatus(total: number, active: number): void {
      const hasQuery = findInput.value !== '';
      const empty = hasQuery && total === 0;
      root.dataset['findTotal'] = String(total);
      root.dataset['findEmpty'] = empty ? 'true' : 'false';
      root.classList.toggle('is-empty', empty);
      status.textContent = empty
        ? labels.empty
        : total > 0
          ? labels.count(active, total)
          : '';
      const noHits = total === 0;
      replaceBtn.disabled = noHits;
      replaceAllBtn.disabled = noHits;
      prevBtn.disabled = noHits;
      nextBtn.disabled = noHits;
    },
    getQuery(): string {
      return findInput.value;
    },
    setQuery(query: string): void {
      findInput.value = query;
    },
    focusFind(): void {
      findInput.focus();
      findInput.select();
    },
  };
  return panel;
}
