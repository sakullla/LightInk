/**
 * Table display nodeView: wrap GFM tables in `.tableWrapper` so wide tables
 * scroll inside the measure column. Does not enable columnResizing (no colwidth).
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { NodeView } from '@milkdown/prose/view';

const PLUGIN_KEY = new PluginKey('lightink-table-view');

export const TABLE_WRAPPER_CLASS = 'tableWrapper';

/**
 * Outer `div.tableWrapper`; `contentDOM` is `table > tbody` so Milkdown GFM
 * rows stay `tr > th|td` for tableEditing / CellSelection / table-ops.
 */
export function createTableNodeView(initialNode: PMNode): NodeView {
  let node = initialNode;

  const dom = document.createElement('div');
  dom.className = TABLE_WRAPPER_CLASS;

  const table = document.createElement('table');
  const contentDOM = document.createElement('tbody');
  table.appendChild(contentDOM);
  dom.appendChild(table);

  return {
    dom,
    contentDOM,
    update(incoming: PMNode): boolean {
      if (incoming.type !== node.type) {
        return false;
      }
      node = incoming;
      return true;
    },
  };
}

export const tableViewPlugin = $prose(
  () =>
    new Plugin({
      key: PLUGIN_KEY,
      props: {
        nodeViews: {
          table: (node: PMNode) => createTableNodeView(node),
        },
      },
    }),
);
