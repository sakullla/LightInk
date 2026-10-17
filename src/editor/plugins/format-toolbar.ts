/**
 * `format-toolbar` — 选中文字浮出格式工具条（R7），`$prose` 插件。
 *
 * 设计（02-technical-solution.md R7）：订阅选区更新，工具条是一个 **PM 文本管理之外**
 * 的 div（append 到 document.body，position:fixed），用 `view.coordsAtPos` 定位到选区
 * 起点上方（放不下则下方），提供加粗/斜体/删除线/行内代码/链接；点击用 PM 事务变更
 * 选区 marks；空选区/失焦即隐藏。
 *
 * PM mark 名（经 $markSchema id 核实）：strong / emphasis / strike_through / inlineCode / link。
 *
 * 纯逻辑 `FORMAT_TOOLS`（工具目录）与 `placeToolbar`（放置决策）headless 可测；
 * DOM/PM 装配属编辑器集成面（同既有插件，仅断言工厂形态）。
 */

import { $prose } from '@milkdown/utils';
import { AllSelection, NodeSelection, Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { toggleMark } from '@milkdown/prose/commands';
import type { EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

const PLUGIN_KEY = new PluginKey('lightink-format-toolbar');

export type FormatToolId =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'link'
  | 'highlight'
  | 'note'
  | 'copy';

export interface FormatTool {
  readonly id: FormatToolId;
  readonly label: string;
  readonly title: string;
  /** 对应的 PM schema mark 名；link 特殊处理（带 href 属性）。 */
  readonly markName: string;
}

/** 工具条按钮目录（顺序即渲染顺序）。markName 与 Milkdown schema 一致。
 * label 是目录兜底文案（i18n 缺省语言为中文）；标注三工具在 DOM 里渲染
 * ANNOTATION_TOOL_ICONS 的线性图标，label 仅作无图标路径/测试的兜底。 */
/** Default English titles; host may retranslate via setFormatToolbarTitles. */
export const FORMAT_TOOLS: FormatTool[] = [
  { id: 'bold', label: 'B', title: 'Bold', markName: 'strong' },
  { id: 'italic', label: 'I', title: 'Italic', markName: 'emphasis' },
  { id: 'strikethrough', label: 'S', title: 'Strikethrough', markName: 'strike_through' },
  { id: 'code', label: '</>', title: 'Inline code', markName: 'inlineCode' },
  { id: 'link', label: 'link', title: 'Link', markName: 'link' },
  { id: 'highlight', label: '高亮', title: 'Highlight', markName: '' },
  { id: 'note', label: '笔记', title: 'Note', markName: '' },
  { id: 'copy', label: '复制', title: 'Copy', markName: '' },
];

/** Update tooltip titles after language switch (mutates FORMAT_TOOLS in place). */
export function setFormatToolbarTitles(titles: Partial<Record<FormatToolId, string>>): void {
  for (const tool of FORMAT_TOOLS) {
    const next = titles[tool.id];
    if (typeof next === 'string' && next !== '') {
      (tool as { title: string }).title = next;
    }
  }
}

/** 链接按钮的内联 SVG（描边取 currentColor，随主题令牌着色；替代风格不一的 emoji）。 */
const LINK_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l1.8-1.8a2.83 2.83 0 0 0-4-4l-1 1"/>' +
  '<path d="M9.4 6.6a2.8 2.8 0 0 0-4 0L3.6 8.4a2.83 2.83 0 0 0 4 4l1-1"/>' +
  '</svg>';

/**
 * 标注组（高亮/笔记/复制）的内联 SVG 图标——文案本地化经 title/aria-label
 * 供给，按钮面保持语言中立的线性图标（与链接按钮同一 16px 视窗/描边语言）。
 */
const ANNOTATION_TOOL_ICONS: Readonly<Record<'highlight' | 'note' | 'copy', string>> = {
  highlight:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.5 2.5 13.5 6.5 7.5 12.5H4v-3.5z"/>' +
    '<path d="M2.5 15h11"/>' +
    '</svg>',
  note:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 2h5l3.5 3.5V14H4z"/>' +
    '<path d="M9 2v4h3.5"/>' +
    '</svg>',
  copy:
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/>' +
    '<path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5V9A1.5 1.5 0 0 0 4 10.5h1.5"/>' +
    '</svg>',
};

export interface ToolbarPlacement {
  readonly top: number;
  readonly left: number;
}

/**
 * 纯逻辑：给定选区屏幕范围（首行 top、末行 bottom、起点 left）、工具条尺寸、视口尺寸，
 * 计算「不遮挡选区」的放置点。上方优先（top - height - gap）；上方放不下则放到选区
 * **末行底部以下**（bottom + gap，避免压住所选首行）；水平居中于起点并夹在视口内。
 */
export function placeToolbar(
  anchor: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
): ToolbarPlacement {
  const above = anchor.top - size.height - gap;
  const top = above >= 0 ? above : anchor.bottom + gap;
  let left = anchor.left - size.width / 2;
  const maxLeft = viewport.width - gap - size.width;
  if (left < gap) left = gap;
  if (left > maxLeft) left = Math.max(gap, maxLeft);
  return { top, left };
}

/** 创建工具条 DOM（按钮按 FORMAT_TOOLS 渲染，data-tool 标记动作）。仅挂载态调用。 */
function createToolbarElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lightink-format-toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', '格式工具条');
  el.style.display = 'none';
  el.style.position = 'fixed';
  el.style.zIndex = '1000';
  for (const tool of FORMAT_TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lightink-format-tool lightink-format-tool--${tool.id}`;
    if (tool.id === 'link') {
      btn.innerHTML = LINK_ICON_SVG;
    } else if (tool.id === 'highlight' || tool.id === 'note' || tool.id === 'copy') {
      btn.innerHTML = ANNOTATION_TOOL_ICONS[tool.id];
    } else {
      btn.textContent = tool.label;
    }
    btn.title = tool.title;
    btn.setAttribute('aria-label', tool.title);
    btn.dataset['tool'] = tool.id;
    // toggle 语义：marks 工具在选区已带该 mark 时呈 pressed 态（syncToolbar 联动）。
    if (tool.markName !== '') {
      btn.setAttribute('aria-pressed', 'false');
    }
    el.appendChild(btn);
  }
  return el;
}

/**
 * 纸墨工作室 §3.10 行为联动：判断选区是否整体处于某 mark（ProseMirror
 * `markActive` 惯例——空选区看 storedMarks/$from，非空选区要求 from..to
 * 每个位置都带该 mark，部分命中不算 active）。标注组（highlight/note/copy）
 * 无对应 mark，恒为 false。
 */
export function selectionHasMark(state: EditorState, markName: string): boolean {
  if (markName === '') return false;
  const markType = state.schema.marks[markName];
  if (markType === undefined) return false;
  const { from, to, empty } = state.selection;
  if (empty) {
    const stored = state.storedMarks ?? [];
    if (stored.some((m) => m.type === markType)) return true;
    return state.doc.resolve(from).marks().some((m) => m.type === markType);
  }
  let active = true;
  state.doc.nodesBetween(from, to, (node, _) => {
    if (!active) return false;
    if (node.isText && node.marks.every((m) => m.type !== markType)) {
      active = false;
    }
    return true;
  });
  return active;
}

/** 选区各 marks 工具的 active 状态（syncToolbar 消费；headless 可测）。 */
export function formatToolActiveStates(
  state: EditorState,
  tools: readonly FormatTool[] = FORMAT_TOOLS,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const tool of tools) {
    out[tool.id] = selectionHasMark(state, tool.markName);
  }
  return out;
}

/**
 * Optional host-provided link editor. Production wires a themed modal
 * (text + href). Falls back to window.prompt for href only when unset.
 */
export type LinkEditorFn = (initial: {
  text: string;
  href: string;
}) => Promise<{ text: string; href: string } | null> | { text: string; href: string } | null;

let linkEditor: LinkEditorFn | null = null;

export type FormatToolbarAnnotationAction = (id: 'highlight' | 'note' | 'copy') => void;

/**
 * 标注动作按编辑器 scope（标注宿主元素）注册：多个 Markdown 标签各自持有宿主，
 * 工具条点击时从触发它的 view.dom 向上解析最近的注册项，而不是被最后创建的
 * 标签全局覆盖。
 */
const annotationActions = new Map<Element, FormatToolbarAnnotationAction>();

export function setFormatToolbarAnnotationAction(
  scope: Element | null,
  handler: FormatToolbarAnnotationAction | null,
): void {
  if (scope === null) {
    return;
  }
  if (handler === null) {
    annotationActions.delete(scope);
    return;
  }
  annotationActions.set(scope, handler);
}

/** 解析 `from` 所属编辑器的标注动作（沿祖先找最近注册的 scope）。 */
export function resolveFormatToolbarAnnotationAction(
  from: Element | null,
): FormatToolbarAnnotationAction | null {
  let el = from;
  while (el !== null) {
    const handler = annotationActions.get(el);
    if (handler !== undefined) {
      return handler;
    }
    el = el.parentElement;
  }
  return null;
}

/** Inject the app-level link dialog (called once from main). */
export function setFormatToolbarLinkEditor(editor: LinkEditorFn | null): void {
  linkEditor = editor;
}

/**
 * Shared link dialog for format toolbar, slash menu, and Insert → Link.
 * Returns null when not wired (headless / tests).
 */
export function getFormatToolbarLinkEditor(): LinkEditorFn | null {
  return linkEditor;
}

const ANNOTATION_FORMAT_TOOLS: ReadonlySet<FormatToolId> = new Set([
  'highlight',
  'note',
  'copy',
]);

export function isAnnotationFormatTool(
  id: FormatToolId,
): id is Extract<FormatToolId, 'highlight' | 'note' | 'copy'> {
  return ANNOTATION_FORMAT_TOOLS.has(id);
}

/** 应用某个格式工具到当前选区（mark 切换 / link 包裹）。 */
export function applyFormatTool(view: EditorView, id: FormatToolId): void {
  if (isAnnotationFormatTool(id)) {
    resolveFormatToolbarAnnotationAction(view.dom)?.(id);
    return;
  }
  if (view.editable === false) {
    return;
  }
  const tool = FORMAT_TOOLS.find((t) => t.id === id);
  if (tool === undefined) return;
  const markType = view.state.schema.marks[tool.markName];
  if (markType === undefined) return;
  const { from, to, empty } = view.state.selection;
  if (tool.markName === 'link') {
    const selectedText = empty ? '' : view.state.doc.textBetween(from, to);
    // Prefer existing link href under selection when editing.
    let existingHref = '';
    if (!empty) {
      const marks = view.state.doc.resolve(from).marks();
      const link = marks.find((m) => m.type.name === 'link');
      if (link !== undefined && typeof link.attrs['href'] === 'string') {
        existingHref = link.attrs['href'] as string;
      }
    }
    const applyResult = (result: { text: string; href: string } | null): void => {
      if (result === null) return;
      const href = result.href.trim();
      if (href === '') return;
      const text = result.text.trim() || href;
      const linkMark = markType.create({ href, title: null });
      const withoutLink = <T extends { type: { name: string } }>(marks: readonly T[]): T[] =>
        marks.filter((m) => m.type !== markType);

      // Re-read selection in case the dialog stole focus / selection shifted.
      const sel = view.state.selection;
      let tr = view.state.tr;
      let end: number;
      if (sel.empty) {
        const insertAt = sel.from;
        tr = tr.insertText(text, insertAt);
        end = insertAt + text.length;
        tr = tr.addMark(insertAt, end, linkMark);
      } else {
        const current = view.state.doc.textBetween(sel.from, sel.to);
        if (text !== current) {
          tr = tr.insertText(text, sel.from, sel.to);
          end = sel.from + text.length;
          tr = tr.addMark(sel.from, end, linkMark);
        } else {
          end = sel.to;
          tr = tr.addMark(sel.from, sel.to, linkMark);
        }
      }
      tr = tr.setSelection(TextSelection.create(tr.doc, end));
      tr = tr.setStoredMarks(withoutLink(tr.selection.$from.marks()));
      view.dispatch(tr.scrollIntoView());
    };

    if (linkEditor !== null) {
      void Promise.resolve(
        linkEditor({ text: selectedText, href: existingHref }),
      ).then(applyResult);
      return;
    }
    // Headless / fallback: prompt for href only.
    const href =
      typeof prompt === 'function' ? (prompt('链接地址（https://…）') ?? '') : '';
    if (href === '') return;
    applyResult({ text: selectedText || href, href });
    return;
  }
  toggleMark(markType)(view.state, (tr) => view.dispatch(tr));
}

/**
 * Floating format bar is for a focused text range the user drew.
 * Opening a file often leaves a full-document / node selection at (0,0);
 * that must not pop the bar at the top-left of the page.
 */
function hideSelectionToolbarForKeyboardBar(view: EditorView): boolean {
  if (view.editable === false) {
    return false;
  }
  if (typeof document === 'undefined' || document.documentElement === null) {
    return false;
  }
  const root = document.documentElement;
  return (
    root.getAttribute('data-workspace-mode') === 'reader' &&
    (root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary'))
  );
}

export function shouldShowFormatToolbar(view: EditorView): boolean {
  // Immersive edit uses the keyboard format bar; keep this selection chrome off.
  if (hideSelectionToolbarForKeyboardBar(view)) {
    return false;
  }
  if (typeof view.hasFocus === 'function' && !view.hasFocus()) {
    return false;
  }
  const { selection } = view.state;
  if (selection.empty) {
    return false;
  }
  if (selection instanceof NodeSelection) {
    return false;
  }
  return selection instanceof TextSelection || selection instanceof AllSelection;
}

/** 依据当前选区同步工具条显隐与位置。 */
function syncToolbar(view: EditorView, toolbar: HTMLElement): void {
  if (!shouldShowFormatToolbar(view)) {
    toolbar.style.display = 'none';
    return;
  }
  const allowDocumentTools = view.editable !== false;
  const activeStates = formatToolActiveStates(view.state);
  const toolById = new Map(FORMAT_TOOLS.map((tool) => [tool.id, tool]));
  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    const id = btn.dataset['tool'] as FormatToolId | undefined;
    btn.hidden = id !== undefined && !isAnnotationFormatTool(id) && !allowDocumentTools;
    const tool = id !== undefined ? toolById.get(id) : undefined;
    if (tool !== undefined && tool.markName !== '') {
      const active = activeStates[tool.id] === true;
      btn.toggleAttribute('data-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
  // 先显示以测得尺寸（display:none 时 getBoundingClientRect 为 0）。
  toolbar.style.display = '';
  const { selection } = view.state;
  const start = view.coordsAtPos(selection.from);
  const end = view.coordsAtPos(selection.to);
  const rect = toolbar.getBoundingClientRect();
  const placement = placeToolbar(
    { top: start.top, bottom: end.bottom, left: start.left },
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  toolbar.style.top = `${placement.top}px`;
  toolbar.style.left = `${placement.left}px`;
}

export const formatToolbarPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    view(view: EditorView) {
      const toolbar = createToolbarElement();
      const onClick = (event: Event): void => {
        // Link icon is an <svg>; SVGElement is not HTMLElement, so use Element.
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('button[data-tool]');
        if (!(btn instanceof HTMLButtonElement)) return;
        const id = btn.dataset['tool'] as FormatToolId | undefined;
        if (id === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        applyFormatTool(view, id);
        // Keep toolbar visible for non-link tools; re-sync after mark toggle.
        // Link uses window.prompt which may clear selection — hide if empty.
        syncToolbar(view, toolbar);
      };
      // 关键：阻止工具条按钮在 mousedown 时抢走编辑器焦点——否则 view.dom 失焦 →
      // onHide 同步隐藏工具条 → 随后 click 落空、applyFormatTool 不执行（浮动菜单
      // 焦点抢占问题）。preventDefault 不阻止 click 本身。
      // Capture phase so SVG children inside the link button never steal the gesture.
      const onPointerDown = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      const onHide = (): void => {
        toolbar.style.display = 'none';
      };
      toolbar.addEventListener('mousedown', onPointerDown, true);
      toolbar.addEventListener('click', onClick);
      view.dom.addEventListener('blur', onHide, true);
      document.body.appendChild(toolbar);
      syncToolbar(view, toolbar);

      return {
        update() {
          syncToolbar(view, toolbar);
        },
        destroy() {
          toolbar.removeEventListener('mousedown', onPointerDown, true);
          toolbar.removeEventListener('click', onClick);
          view.dom.removeEventListener('blur', onHide, true);
          toolbar.remove();
        },
      };
    },
  });
});
