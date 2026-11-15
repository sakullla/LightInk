import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';
import { tableNodes } from '@milkdown/prose/tables';
import type { DecorationSet, EditorView } from '@milkdown/prose/view';

import {
  createPlaceholderProsePlugin,
  isEmptyPlaceholderDoc,
} from '../placeholder.js';
import {
  getActiveColumnAlignment,
  setColumnAlignment,
} from '../table-ops.js';
import { placeTableToolbar } from '../table-toolbar.js';

const tableSpec = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph',
  cellAttributes: {
    alignment: {
      default: 'left',
      getFromDOM: () => 'left',
      setDOMAttr: () => undefined,
    },
  },
});

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    heading: {
      group: 'block',
      content: 'text*',
      attrs: { level: { default: 1 } },
      toDOM: () => ['h1', 0],
    },
    text: { group: 'inline' },
    ...tableSpec,
  },
});

describe('placeholder plugin', () => {
  it('detects only a sole empty top-level paragraph', () => {
    const emptyDoc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(),
    ]);
    expect(isEmptyPlaceholderDoc(emptyDoc)).toBe(true);

    const textDoc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text('hi')),
    ]);
    expect(isEmptyPlaceholderDoc(textDoc)).toBe(false);

    const twoParas = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(),
      schema.nodes.paragraph!.create(),
    ]);
    expect(isEmptyPlaceholderDoc(twoParas)).toBe(false);

    const headingDoc = schema.nodes.doc!.create(null, [
      schema.nodes.heading!.create(),
    ]);
    expect(isEmptyPlaceholderDoc(headingDoc)).toBe(false);
  });

  it('attaches data-placeholder decoration only while empty', () => {
    const plugin = createPlaceholderProsePlugin(() => '输入正文…');
    let state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create()]),
      schema,
      plugins: [plugin],
    });
    const decosBefore = plugin.props.decorations?.call(plugin, state) as DecorationSet | null | undefined;
    expect(decosBefore).not.toBeNull();
    expect(decosBefore?.find()).toHaveLength(1);

    state = state.apply(state.tr.insertText('A', 1));
    const decosAfter = plugin.props.decorations?.call(plugin, state);
    expect(decosAfter).toBeNull();
  });
});

describe('placeTableToolbar', () => {
  const bounds = { top: 80, left: 220, right: 1260, bottom: 860 };
  const viewport = { width: 1280, height: 900 };
  const size = { width: 280, height: 34 };

  it('docks cleanly above the top-right edge of a visible table', () => {
    const p = placeTableToolbar(
      { top: 200, bottom: 420, left: 280, right: 980 },
      size,
      bounds,
      viewport,
    );
    expect(p.visible).toBe(true);
    expect(p.top).toBe(200 - 34 - 6);
    expect(p.left).toBe(980 - 280);
  });

  it('sticks inside the top of the scroller when a tall table scrolls upward', () => {
    const p = placeTableToolbar(
      { top: 20, bottom: 520, left: 280, right: 980 },
      size,
      bounds,
      viewport,
    );
    expect(p.visible).toBe(true);
    expect(p.top).toBe(bounds.top + 6);
  });

  it('hides when the table scrolls completely out of the scroller bounds', () => {
    const above = placeTableToolbar(
      { top: -200, bottom: 60, left: 280, right: 980 },
      size,
      bounds,
      viewport,
    );
    expect(above.visible).toBe(false);

    const below = placeTableToolbar(
      { top: 870, bottom: 1080, left: 280, right: 980 },
      size,
      bounds,
      viewport,
    );
    expect(below.visible).toBe(false);
  });
});

describe('table column alignment ops', () => {
  function makeTableState(): EditorState {
    const p = (t: string) =>
      schema.nodes.paragraph!.create(null, t ? schema.text(t) : undefined);
    const th = (t: string) => schema.nodes.table_header!.create(null, p(t));
    const td = (t: string) => schema.nodes.table_cell!.create(null, p(t));
    const table = schema.nodes.table!.create(null, [
      schema.nodes.table_row!.create(null, [th('Col 1'), th('Col 2')]),
      schema.nodes.table_row!.create(null, [td('A1'), td('B1')]),
    ]);
    const doc = schema.nodes.doc!.create(null, [table]);
    // Caret inside second header cell ("Col 2")
    let secondHeaderPos = 1;
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Col 2') {
        secondHeaderPos = pos;
      }
    });
    return EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, secondHeaderPos),
    });
  }

  it('reads default left alignment and updates every row in the active column', () => {
    let state = makeTableState();
    expect(getActiveColumnAlignment(state)).toBe('left');

    const fakeView = {
      get state() {
        return state;
      },
      dispatch(tr: Parameters<EditorState['apply']>[0]) {
        state = state.apply(tr);
      },
    } as unknown as EditorView;

    expect(setColumnAlignment(fakeView, 'center')).toBe(true);
    expect(getActiveColumnAlignment(state)).toBe('center');

    // Col 0 remains left; Col 1 in both header and body row becomes center.
    const table = state.doc.firstChild!;
    const headerRow = table.child(0);
    const bodyRow = table.child(1);
    expect(headerRow.child(0).attrs['alignment']).toBe('left');
    expect(headerRow.child(1).attrs['alignment']).toBe('center');
    expect(bodyRow.child(0).attrs['alignment']).toBe('left');
    expect(bodyRow.child(1).attrs['alignment']).toBe('center');
  });
});
