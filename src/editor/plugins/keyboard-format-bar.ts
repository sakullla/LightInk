/**
 * Keyboard-adjacent touch format bar (R2 / ADR-5).
 *
 * Shown only while the visible immersive Markdown tab is editable.
 * Comic, novel, and Markdown reading stay clear: a background editor
 * must not pin the bar over another surface. Sits at
 * `bottom: var(--lightink-keyboard-inset, 0px)`. Clicks while
 * `view.composing` are ignored so IME composition is not rewritten.
 */

import { parserCtx } from '@milkdown/core';
import type { Ctx } from '@milkdown/ctx';
import { setBlockType, wrapIn } from '@milkdown/prose/commands';
import { redo, undo } from '@milkdown/prose/history';
import { wrapInList } from '@milkdown/prose/schema-list';
import type { Node as PMNode, ResolvedPos } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { $prose } from '@milkdown/utils';

import { insertMarkdownAtSelection } from '../insert-markdown.js';
import { applyFormatTool, selectionHasMark } from './format-toolbar.js';
import { getSlashImageHandler } from './slash-menu.js';

const PLUGIN_KEY = new PluginKey('lightink-keyboard-format-bar');

export type KeyboardFormatToolId =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'link'
  | 'heading'
  | 'list'
  | 'task-list'
  | 'blockquote'
  | 'code-block'
  | 'image'
  | 'undo'
  | 'redo';

export interface KeyboardFormatTool {
  readonly id: KeyboardFormatToolId;
  readonly label: string;
  readonly title: string;
}

const LINK_ICON_SVG =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l1.8-1.8a2.83 2.83 0 0 0-4-4l-1 1"/>' +
  '<path d="M9.4 6.6a2.8 2.8 0 0 0-4 0L3.6 8.4a2.83 2.83 0 0 0 4 4l1-1"/>' +
  '</svg>';

/** Display order is the R2 catalog (no table / formula / mermaid). */
export const KEYBOARD_FORMAT_TOOLS: KeyboardFormatTool[] = [
  { id: 'bold', label: 'B', title: 'Bold' },
  { id: 'italic', label: 'I', title: 'Italic' },
  { id: 'strikethrough', label: 'S', title: 'Strikethrough' },
  { id: 'code', label: '</>', title: 'Inline code' },
  { id: 'link', label: 'link', title: 'Link' },
  { id: 'heading', label: 'H', title: 'Heading' },
  { id: 'list', label: '•', title: 'List' },
  { id: 'task-list', label: '☑', title: 'Task list' },
  { id: 'blockquote', label: '“', title: 'Quote' },
  { id: 'code-block', label: '{ }', title: 'Code block' },
  { id: 'image', label: 'img', title: 'Image' },
  { id: 'undo', label: '↩', title: 'Undo' },
  { id: 'redo', label: '↪', title: 'Redo' },
];

const INLINE_FORMAT_IDS: ReadonlySet<KeyboardFormatToolId> = new Set([
  'bold',
  'italic',
  'strikethrough',
  'code',
  'link',
]);

export function setKeyboardFormatBarTitles(
  titles: Partial<Record<KeyboardFormatToolId, string>>,
): void {
  for (const tool of KEYBOARD_FORMAT_TOOLS) {
    const next = titles[tool.id];
    if (typeof next === 'string' && next !== '') {
      (tool as { title: string }).title = next;
    }
  }
}

export function isImmersiveTouchMarkdownSurface(): boolean {
  if (typeof document === 'undefined' || document.documentElement === null) {
    return false;
  }
  const root = document.documentElement;
  return (
    root.getAttribute('data-workspace-mode') === 'reader' &&
    (root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary'))
  );
}

/**
 * The bar is viewport-fixed, so `view.editable` alone is not enough:
 * a hidden Markdown tab, or a comic/novel surface sharing the editor
 * pane, would otherwise keep the reading view's bottom row.
 */
export function keyboardFormatBarHostVisible(view: EditorView): boolean {
  const dom = view.dom;
  if (dom == null || typeof dom.closest !== 'function') {
    return true;
  }
  const area = dom.closest('#lightink-editor-area');
  if (area instanceof HTMLElement && area.dataset.surface !== 'markdown') {
    return false;
  }
  let node: HTMLElement | null = dom instanceof HTMLElement ? dom : null;
  while (node !== null) {
    if (node.hidden || node.style.display === 'none') {
      return false;
    }
    if (node.classList.contains('lightink-tab-host')) {
      break;
    }
    node = node.parentElement;
  }
  return true;
}

export function shouldShowKeyboardFormatBar(view: EditorView): boolean {
  if (view.editable === false) {
    return false;
  }
  if (!isImmersiveTouchMarkdownSurface()) {
    return false;
  }
  return keyboardFormatBarHostVisible(view);
}

export function nextHeadingCycle(
  typeName: string,
  level: unknown,
): { type: 'paragraph' } | { type: 'heading'; level: 1 | 2 | 3 } {
  if (typeName === 'heading') {
    const lv = typeof level === 'number' ? level : 1;
    if (lv === 1) return { type: 'heading', level: 2 };
    if (lv === 2) return { type: 'heading', level: 3 };
    return { type: 'paragraph' };
  }
  return { type: 'heading', level: 1 };
}

function listItemDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'list_item') {
      return depth;
    }
  }
  return null;
}

function hasAncestor($pos: ResolvedPos, name: string): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === name) {
      return true;
    }
  }
  return false;
}

function insertSnippet(view: EditorView, ctx: Ctx | undefined, markdown: string): boolean {
  if (ctx === undefined) {
    return false;
  }
  try {
    const parse = ctx.get(parserCtx);
    return insertMarkdownAtSelection(view, markdown, parse);
  } catch {
    return false;
  }
}

function captureTransaction(
  run: (dispatch: (tr: Transaction) => void) => boolean,
): Transaction | null {
  let captured: Transaction | null = null;
  const ok = run((tr) => {
    captured = tr;
  });
  return ok ? captured : null;
}

function applyHeadingCycle(view: EditorView): boolean {
  const { state } = view;
  const $from = state.selection.$from;
  const parent = $from.parent;
  if (!parent.isTextblock) {
    return false;
  }
  const next = nextHeadingCycle(parent.type.name, parent.attrs['level']);
  const paragraph = state.schema.nodes['paragraph'];
  const heading = state.schema.nodes['heading'];
  if (next.type === 'paragraph') {
    if (paragraph === undefined) return false;
    return setBlockType(paragraph)(state, (tr) => view.dispatch(tr));
  }
  if (heading === undefined) return false;
  if (parent.type === heading) {
    view.dispatch(
      state.tr.setNodeMarkup($from.before(), undefined, {
        ...parent.attrs,
        level: next.level,
      }),
    );
    return true;
  }
  return setBlockType(heading, { level: next.level })(state, (tr) => view.dispatch(tr));
}

function applyList(view: EditorView, task: boolean, ctx: Ctx | undefined): boolean {
  const { state } = view;
  const $from = state.selection.$from;
  const depth = listItemDepth($from);
  if (depth !== null) {
    const node = $from.node(depth);
    const checked = node.attrs['checked'];
    const alreadyTask = typeof checked === 'boolean';
    if (task === alreadyTask) {
      return true;
    }
    view.dispatch(
      state.tr.setNodeMarkup($from.before(depth), undefined, {
        ...node.attrs,
        checked: task ? false : null,
      }),
    );
    return true;
  }
  const bullet = state.schema.nodes['bullet_list'];
  if (bullet === undefined) {
    return insertSnippet(view, ctx, task ? '- [ ] ' : '- ');
  }
  const wrapped =
    captureTransaction((dispatch) => wrapInList(bullet)(state, dispatch)) ??
    captureTransaction((dispatch) => wrapIn(bullet)(state, dispatch));
  if (wrapped === null) {
    return insertSnippet(view, ctx, task ? '- [ ] ' : '- ');
  }
  let tr: Transaction = wrapped;
  if (task) {
    const itemDepth = listItemDepth(tr.selection.$from);
    if (itemDepth !== null) {
      const node = tr.selection.$from.node(itemDepth);
      tr = tr.setNodeMarkup(tr.selection.$from.before(itemDepth), undefined, {
        ...node.attrs,
        checked: false,
      });
    }
  }
  view.dispatch(tr);
  return true;
}

function applyBlockquote(view: EditorView, ctx: Ctx | undefined): boolean {
  if (hasAncestor(view.state.selection.$from, 'blockquote')) {
    return true;
  }
  const blockquote = view.state.schema.nodes['blockquote'];
  if (blockquote !== undefined && wrapIn(blockquote)(view.state, (tr) => view.dispatch(tr))) {
    return true;
  }
  return insertSnippet(view, ctx, '> ');
}

function applyCodeBlock(view: EditorView, ctx: Ctx | undefined): boolean {
  const code = view.state.schema.nodes['code_block'];
  if (code !== undefined && setBlockType(code)(view.state, (tr) => view.dispatch(tr))) {
    return true;
  }
  return insertSnippet(view, ctx, '```\n\n```');
}

function applyImage(view: EditorView, ctx: Ctx | undefined): boolean {
  const handler = getSlashImageHandler();
  if (handler !== null) {
    void Promise.resolve(handler()).finally(() => {
      view.focus();
    });
    return true;
  }
  return insertSnippet(view, ctx, '![描述](assets/image.png)');
}

export function applyKeyboardFormatCommand(
  view: EditorView,
  id: KeyboardFormatToolId,
  ctx?: Ctx,
): boolean {
  if (view.composing === true || view.editable === false) {
    return false;
  }
  if (INLINE_FORMAT_IDS.has(id)) {
    applyFormatTool(view, id as 'bold' | 'italic' | 'strikethrough' | 'code' | 'link');
    return true;
  }
  switch (id) {
    case 'heading':
      return applyHeadingCycle(view);
    case 'list':
      return applyList(view, false, ctx);
    case 'task-list':
      return applyList(view, true, ctx);
    case 'blockquote':
      return applyBlockquote(view, ctx);
    case 'code-block':
      return applyCodeBlock(view, ctx);
    case 'image':
      return applyImage(view, ctx);
    case 'undo':
      return undo(view.state, view.dispatch);
    case 'redo':
      return redo(view.state, view.dispatch);
    default:
      return false;
  }
}

function headingButtonLabel(parent: PMNode): string {
  if (parent.type.name === 'heading') {
    const level = parent.attrs['level'];
    return typeof level === 'number' ? `H${level}` : 'H';
  }
  return 'H';
}

function createBarElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lightink-keyboard-format-bar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', '格式条');
  for (const tool of KEYBOARD_FORMAT_TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lightink-keyboard-format-bar__btn lightink-keyboard-format-bar__btn--${tool.id}`;
    if (tool.id === 'link') {
      btn.innerHTML = LINK_ICON_SVG;
    } else {
      btn.textContent = tool.label;
    }
    btn.title = tool.title;
    btn.setAttribute('aria-label', tool.title);
    btn.dataset['tool'] = tool.id;
    el.appendChild(btn);
  }
  return el;
}

function resolveBarHost(view: EditorView): HTMLElement {
  // Stay inside the tab host. Inactive tabs use display:none, which also
  // hides a position:fixed bar. Parking it on #lightink-editor-area let a
  // background Markdown editor cover comic and novel readers.
  const tab = view.dom.closest('.lightink-tab-host');
  if (tab instanceof HTMLElement) {
    return tab;
  }
  const parent = view.dom.parentElement;
  if (parent instanceof HTMLElement) {
    return parent;
  }
  return document.body;
}

function watchFormatBarVisibility(view: EditorView, onChange: () => void): () => void {
  if (typeof MutationObserver !== 'function' || view.dom == null) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onChange();
  });
  const watch = (node: Node | null, attributeFilter: string[]): void => {
    if (node instanceof HTMLElement) {
      observer.observe(node, { attributes: true, attributeFilter });
    }
  };
  watch(document.documentElement, [
    'data-workspace-mode',
    'data-android',
    'data-touch-primary',
  ]);
  watch(view.dom.closest('#lightink-editor-area'), ['data-surface']);
  watch(view.dom.closest('.lightink-tab-host'), ['style', 'hidden']);
  return () => observer.disconnect();
}

/** marks 工具 → schema mark 名（与 FORMAT_TOOLS 同源，便于 active 联动）。 */
const KEYBOARD_MARK_NAMES: Readonly<Partial<Record<KeyboardFormatToolId, string>>> = {
  bold: 'strong',
  italic: 'emphasis',
  strikethrough: 'strike_through',
  code: 'inlineCode',
  link: 'link',
};

/**
 * 纸墨工作室 §3.10 行为联动：触屏格式条的 active 态。inline 工具看选区
 * marks；块工具（列表/任务列表/引用）看光标祖先节点。headless 可测。
 */
export function keyboardToolActiveStates(state: EditorState): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [id, markName] of Object.entries(KEYBOARD_MARK_NAMES)) {
    out[id] = selectionHasMark(state, markName ?? '');
  }
  const $from = state.selection.$from;
  out['list'] = hasAncestor($from, 'bullet_list') || hasAncestor($from, 'ordered_list');
  const listDepth = listItemDepth($from);
  out['task-list'] =
    listDepth !== null && typeof $from.node(listDepth).attrs['checked'] === 'boolean';
  out['blockquote'] = hasAncestor($from, 'blockquote');
  return out;
}

function syncBar(view: EditorView, bar: HTMLElement): void {
  const show = shouldShowKeyboardFormatBar(view);
  bar.classList.toggle('is-visible', show);
  const activeStates = keyboardToolActiveStates(view.state);
  for (const tool of KEYBOARD_FORMAT_TOOLS) {
    const btn = bar.querySelector<HTMLButtonElement>(`button[data-tool="${tool.id}"]`);
    if (btn === null) continue;
    btn.title = tool.title;
    btn.setAttribute('aria-label', tool.title);
    if (tool.id === 'heading') {
      btn.textContent = headingButtonLabel(view.state.selection.$from.parent);
    }
    // active 联动（§3.10）：当前光标/选区已处于该格式时按钮亮起。
    if (tool.id in activeStates) {
      const active = activeStates[tool.id] === true;
      btn.toggleAttribute('data-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }
}

export const keyboardFormatBarPlugin = $prose((ctx: Ctx) => {
  return new Plugin({
    key: PLUGIN_KEY,
    view(view: EditorView) {
      const bar = createBarElement();
      const onMouseDown = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      const onClick = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('button[data-tool]');
        if (!(btn instanceof HTMLButtonElement) || !bar.contains(btn)) return;
        const id = btn.dataset['tool'] as KeyboardFormatToolId | undefined;
        if (id === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        applyKeyboardFormatCommand(view, id, ctx);
        syncBar(view, bar);
      };
      bar.addEventListener('mousedown', onMouseDown, true);
      bar.addEventListener('click', onClick);
      resolveBarHost(view).appendChild(bar);
      const stopWatch = watchFormatBarVisibility(view, () => {
        syncBar(view, bar);
      });
      syncBar(view, bar);
      return {
        update() {
          syncBar(view, bar);
        },
        destroy() {
          stopWatch();
          bar.removeEventListener('mousedown', onMouseDown, true);
          bar.removeEventListener('click', onClick);
          bar.remove();
        },
      };
    },
  });
});
