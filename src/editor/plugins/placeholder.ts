/**
 * Empty-document placeholder decoration plugin.
 *
 * Attaches `data-placeholder` on the sole empty top-level paragraph of an
 * editable document. Rendered via CSS `::before` so the ProseMirror document,
 * `getMarkdown()`, undo history, and HTML/PDF export remain untouched.
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

export const PLACEHOLDER_PLUGIN_KEY = new PluginKey('lightink-placeholder');

let placeholderText = '输入正文，或按 / 插入块…';
const activeViews = new Set<EditorView>();

export function setEditorPlaceholder(text: string): void {
  if (typeof text !== 'string' || text === placeholderText) {
    return;
  }
  placeholderText = text;
  for (const view of activeViews) {
    try {
      view.dispatch(view.state.tr.setMeta(PLACEHOLDER_PLUGIN_KEY, true));
    } catch {
      /* ignore destroyed views */
    }
  }
}

export function getEditorPlaceholder(): string {
  return placeholderText;
}

/** Pure check: true only when `doc` is a single empty paragraph. */
export function isEmptyPlaceholderDoc(doc: PMNode): boolean {
  if (doc.childCount !== 1) {
    return false;
  }
  const first = doc.firstChild;
  return (
    first !== null &&
    first.type.name === 'paragraph' &&
    first.content.size === 0
  );
}

export function createPlaceholderProsePlugin(
  getText: () => string = getEditorPlaceholder,
): Plugin {
  let viewRef: EditorView | null = null;
  let composing = false;

  return new Plugin({
    key: PLACEHOLDER_PLUGIN_KEY,
    props: {
      handleDOMEvents: {
        compositionstart(view) {
          composing = true;
          view.dispatch(view.state.tr.setMeta(PLACEHOLDER_PLUGIN_KEY, true));
          return false;
        },
        compositionend(view) {
          composing = false;
          view.dispatch(view.state.tr.setMeta(PLACEHOLDER_PLUGIN_KEY, true));
          return false;
        },
      },
      decorations(state) {
        if (composing) {
          return null;
        }
        if (viewRef !== null && viewRef.editable === false) {
          return null;
        }
        const text = getText();
        if (text === '' || !isEmptyPlaceholderDoc(state.doc)) {
          return null;
        }
        const first = state.doc.firstChild;
        if (first === null) {
          return null;
        }
        return DecorationSet.create(state.doc, [
          Decoration.node(0, first.nodeSize, {
            class: 'lightink-empty-paragraph',
            'data-placeholder': text,
          }),
        ]);
      },
    },
    view(editorView) {
      viewRef = editorView;
      activeViews.add(editorView);
      return {
        update(nextView) {
          viewRef = nextView;
        },
        destroy() {
          activeViews.delete(editorView);
          viewRef = null;
        },
      };
    },
  });
}

export const placeholderPlugin = $prose(() => createPlaceholderProsePlugin());
