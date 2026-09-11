/**
 * Interactive GFM task-list checkboxes (click to toggle complete).
 *
 * Milkdown's `preset-gfm` extends `list_item` with `checked: boolean | null`
 * and serializes `- [ ]` / `- [x]`, but only emits data attributes on the
 * `<li>` — no clickable UI. This plugin:
 *   1. Decorates task items (`checked` is boolean) with a checkbox widget;
 *   2. Toggles `checked` on click (round-trips through getMarkdown);
 *   3. Leaves ordinary list items (`checked == null`) as plain bullets.
 *
 * Pure helpers are headless-testable; the `$prose` factory owns DOM/view.
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

const PLUGIN_KEY = new PluginKey('lightink-task-checkbox');

let taskCheckboxLabels = {
  check: 'Mark complete',
  uncheck: 'Mark incomplete',
};

export function setTaskCheckboxLabels(labels: { check: string; uncheck: string }): void {
  taskCheckboxLabels = { ...labels };
}

export interface TaskItemPos {
  readonly pos: number;
  readonly checked: boolean;
  readonly nodeSize: number;
}

/** True when this ProseMirror node is a GFM task list item (not a plain bullet). */
export function isTaskListItemNode(node: PMNode): boolean {
  return node.type.name === 'list_item' && typeof node.attrs['checked'] === 'boolean';
}

/** Walk the doc and collect task-item positions in source order. */
export function collectTaskItemPositions(doc: PMNode): TaskItemPos[] {
  const out: TaskItemPos[] = [];
  doc.descendants((node, pos) => {
    if (!isTaskListItemNode(node)) return;
    out.push({
      pos,
      checked: Boolean(node.attrs['checked']),
      nodeSize: node.nodeSize,
    });
  });
  return out;
}

/**
 * Pure: produce a transaction that flips `checked` on the list_item at `pos`.
 * Returns null when the node is missing or not a task item.
 */
export function toggleTaskCheckedTr(
  state: EditorState,
  pos: number,
): Transaction | null {
  if (pos < 0 || pos >= state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  if (node === null || !isTaskListItemNode(node)) return null;
  const checked = Boolean(node.attrs['checked']);
  return state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    checked: !checked,
  });
}

/** Dispatch toggle; returns whether a transaction was applied. */
export function toggleTaskChecked(view: EditorView, pos: number): boolean {
  if (view.editable === false) return false;
  const tr = toggleTaskCheckedTr(view.state, pos);
  if (tr === null) return false;
  view.dispatch(tr);
  return true;
}

export function createTaskCheckboxWidget(
  checked: boolean,
  pos: number,
  getView: () => EditorView | null,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = checked
    ? 'lightink-task-checkbox is-checked'
    : 'lightink-task-checkbox';
  btn.setAttribute('role', 'checkbox');
  btn.setAttribute('aria-checked', checked ? 'true' : 'false');
  const label = checked ? taskCheckboxLabels.uncheck : taskCheckboxLabels.check;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.contentEditable = 'false';
  btn.tabIndex = 0;

  // Prevent PM from taking focus / placing caret when pressing the box.
  btn.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const view = getView();
    if (view !== null) {
      toggleTaskChecked(view, pos);
    }
  });
  btn.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    const view = getView();
    if (view !== null) toggleTaskChecked(view, pos);
  });
  return btn;
}

function buildDecorations(
  doc: PMNode,
  getView: () => EditorView | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  for (const item of collectTaskItemPositions(doc)) {
    const { pos, checked, nodeSize } = item;
    // Widget at start of list_item content (pos + 1), drawn before text.
    decorations.push(
      Decoration.widget(
        pos + 1,
        () => createTaskCheckboxWidget(checked, pos, getView),
        {
          side: -1,
          key: `task-cb-${pos}-${checked ? '1' : '0'}`,
          ignoreSelection: true,
        },
      ),
    );
    decorations.push(
      Decoration.node(pos, pos + nodeSize, {
        class: checked ? 'lightink-task-item is-checked' : 'lightink-task-item',
        'data-checked': checked ? 'true' : 'false',
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * Milkdown `$prose` plugin: clickable task checkboxes for GFM task items.
 */
export const taskCheckboxPlugin = $prose(() => {
  let viewRef: EditorView | null = null;
  const getView = (): EditorView | null => viewRef;

  return new Plugin({
    key: PLUGIN_KEY,
    state: {
      init: (_config, state) => buildDecorations(state.doc, getView),
      apply: (tr, old, _oldState, newState) => {
        if (tr.docChanged || tr.getMeta(PLUGIN_KEY) !== undefined) {
          return buildDecorations(newState.doc, getView);
        }
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return PLUGIN_KEY.getState(state) as DecorationSet | undefined;
      },
      // Keyboard: Space on empty selection inside a task item toggles it.
      handleKeyDown(view, event) {
        if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) {
          return false;
        }
        const { $from, empty } = view.state.selection;
        if (!empty) return false;
        for (let d = $from.depth; d > 0; d -= 1) {
          const node = $from.node(d);
          if (isTaskListItemNode(node)) {
            const pos = $from.before(d);
            // Only when caret is at the very start of the item's first textblock
            // (so Space still inserts spaces while typing mid-line).
            if ($from.parentOffset === 0) {
              event.preventDefault();
              return toggleTaskChecked(view, pos);
            }
            return false;
          }
        }
        return false;
      },
    },
    view(editorView) {
      viewRef = editorView;
      return {
        update(v) {
          viewRef = v;
        },
        destroy() {
          viewRef = null;
        },
      };
    },
  });
});
