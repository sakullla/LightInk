/**
 * Table ops pure helpers: TSV parse / matrix → markdown / HTML / detection.
 */
import { describe, expect, it } from 'vitest';

import {
  decodeMatrixClipboardText,
  encodeMatrixClipboardText,
  escapeTsvField,
  matrixToTsv,
  looksLikeHtmlTable,
  looksLikeTsvGrid,
  matrixToHtmlTable,
  matrixToMarkdownTable,
  parseHtmlTableMatrix,
  parseTsvMatrix,
  resolvePasteMatrix,
  setSessionTableMatrix,
  TABLE_OP_LABELS,
} from '../plugins/table-ops.js';

describe('looksLikeTsvGrid', () => {
  it('detects tab-separated rows', () => {
    expect(looksLikeTsvGrid('a\tb\nc\td')).toBe(true);
    expect(looksLikeTsvGrid('plain text')).toBe(false);
    expect(looksLikeTsvGrid('')).toBe(false);
  });

  it('detects multi-line single-column export', () => {
    expect(looksLikeTsvGrid('alpha\nbeta\ngamma')).toBe(true);
  });
});

describe('parseTsvMatrix', () => {
  it('parses rectangular matrix and pads short rows', () => {
    expect(parseTsvMatrix('a\tb\nc')).toEqual([
      ['a', 'b'],
      ['c', ''],
    ]);
  });

  it('drops trailing empty line', () => {
    expect(parseTsvMatrix('a\tb\n')).toEqual([['a', 'b']]);
  });
});

describe('matrixToMarkdownTable', () => {
  it('builds GFM table with first row as header', () => {
    const md = matrixToMarkdownTable([
      ['Name', 'Age'],
      ['Ada', '36'],
    ]);
    expect(md).toBe('| Name | Age |\n| --- | --- |\n| Ada | 36 |');
  });

  it('synthesizes headers when requested', () => {
    const md = matrixToMarkdownTable([['a', 'b']], false);
    expect(md).toContain('| 列1 | 列2 |');
    expect(md).toContain('| a | b |');
  });
});

describe('HTML table clipboard helpers', () => {
  it('round-trips matrix through HTML', () => {
    const html = matrixToHtmlTable([
      ['A', 'B'],
      ['1', '2'],
    ]);
    expect(looksLikeHtmlTable(html)).toBe(true);
    expect(parseHtmlTableMatrix(html)).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ]);
  });
});

describe('TABLE_OP_LABELS', () => {
  it('covers all ops in Chinese (including column alignment)', () => {
    expect(TABLE_OP_LABELS['insert-col-left']).toContain('左');
    expect(TABLE_OP_LABELS['insert-row-below']).toContain('下');
    expect(TABLE_OP_LABELS['align-col-center']).toContain('居中');
    expect(Object.keys(TABLE_OP_LABELS)).toHaveLength(12);
  });
});

describe('matrix copy shape', () => {
  it('row matrix joins with tabs; column matrix joins with newlines', () => {
    const row = [
      ['a', 'b', 'c'],
    ];
    expect(row.map((r) => r.join('\t')).join('\n')).toBe('a\tb\tc');
    const col = [['a'], ['b'], ['c']];
    expect(col.map((r) => r.join('\t')).join('\n')).toBe('a\nb\nc');
  });

  it('row TSV is detected as a grid even without tabs when multi-line col', () => {
    expect(looksLikeTsvGrid('a\tb\tc')).toBe(true);
    expect(looksLikeTsvGrid('a\nb\nc')).toBe(true);
  });
});

describe('tab-safe matrix clipboard wire format', () => {
  it('round-trips a row even when tabs would be lost', () => {
    const matrix = [['232', '223']];
    const encoded = encodeMatrixClipboardText(matrix);
    expect(encoded).toContain('lightink-table-v1:');
    expect(decodeMatrixClipboardText(encoded)).toEqual(matrix);
  });

  it('decodes wire payload when TSV line has tabs normalized to spaces', () => {
    const matrix = [['232', '223']];
    const encoded = encodeMatrixClipboardText(matrix);
    // Simulate WebView: smash TSV tabs into spaces; keep printable wire line.
    const smashed = encoded
      .split('\n')
      .map((line) =>
        line.includes('lightink-table-v1:') ? line : line.replace(/\t/g, ' '),
      )
      .join('\n');
    expect(decodeMatrixClipboardText(smashed)).toEqual(matrix);
  });

  it('resolvePasteMatrix prefers session when OS text is unstructured', () => {
    setSessionTableMatrix([['232', '223']]);
    // What the user saw: both cells joined by a space into one cell.
    expect(resolvePasteMatrix('', '232 223')).toEqual([['232', '223']]);
    setSessionTableMatrix(null);
  });

  it('resolvePasteMatrix uses HTML multi-cell table', () => {
    setSessionTableMatrix(null);
    const html = matrixToHtmlTable([['232', '223']]);
    expect(resolvePasteMatrix(html, '232 223')).toEqual([['232', '223']]);
  });
});

describe('pasteMatrixIntoTable (PM integration)', () => {
  it('pastes a copied row into a newly inserted empty row', async () => {
    const { EditorState, TextSelection, Plugin } = await import('@milkdown/prose/state');
    const { Schema, Fragment } = await import('@milkdown/prose/model');
    const {
      tableNodes,
      TableMap,
      CellSelection,
      selectedRect,
      addRowAfter,
    } = await import('@milkdown/prose/tables');
    const { pasteMatrixIntoTable, selectionToMatrix } = await import(
      '../plugins/table-ops.js'
    );

    const nodes = tableNodes({
      tableGroup: 'block',
      cellContent: 'block+',
      cellAttributes: {},
    });
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'inline*' },
        text: { group: 'inline' },
        table: nodes.table,
        table_row: nodes.table_row,
        table_cell: nodes.table_cell,
        table_header: nodes.table_header,
      },
    });

    const cell = (text: string, header = false) => {
      const type = header ? schema.nodes.table_header! : schema.nodes.table_cell!;
      const para =
        text === ''
          ? schema.nodes.paragraph!.create()
          : schema.nodes.paragraph!.create(null, schema.text(text));
      return type.create(null, Fragment.from(para));
    };
    const row = (...cells: ReturnType<typeof cell>[]) =>
      schema.nodes.table_row!.create(null, Fragment.from(cells));
    const table = schema.nodes.table!.create(
      null,
      Fragment.from([
        row(cell('H1', true), cell('H2', true), cell('H3', true)),
        row(cell('a'), cell('b'), cell('c')),
        row(cell('d'), cell('e'), cell('f')),
      ]),
    );
    const doc = schema.nodes.doc!.create(null, table);

    // Minimal EditorView stub: pasteMatrixIntoTable only needs state + dispatch.
    let state = EditorState.create({ doc, schema });
    // Put caret in body row 1 (index 1), cell 0.
    const map = TableMap.get(table);
    const tableStart = 1; // doc pos of table content start when table is first child
    const cellPos = tableStart + map.positionAt(1, 0, table);
    state = state.apply(
      state.tr.setSelection(CellSelection.rowSelection(state.doc.resolve(cellPos))),
    );

    const matrix = selectionToMatrix(state);
    expect(matrix).toEqual([['a', 'b', 'c']]);

    // Insert a row below the selected row, then select that new empty row.
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: import('@milkdown/prose/state').Transaction) {
        state = state.apply(tr);
      },
    } as unknown as import('@milkdown/prose/view').EditorView;

    expect(addRowAfter(state, (tr) => view.dispatch(tr))).toBe(true);
    // After addRowAfter with a row selection, selection may stay; put caret in new row.
    {
      const t = state.doc.firstChild!;
      const m = TableMap.get(t);
      // New row is at index 2 (was inserted after row 1).
      const pos = 1 + m.positionAt(2, 0, t);
      state = state.apply(
        state.tr.setSelection(CellSelection.rowSelection(state.doc.resolve(pos))),
      );
    }

    expect(pasteMatrixIntoTable(view, matrix!)).toBe(true);
    const after = selectionToMatrix(state);
    // Pasted selection should cover the new row with the copied values.
    expect(after).toEqual([['a', 'b', 'c']]);

    // And the table body row at index 2 should hold a/b/c.
    const t2 = state.doc.firstChild!;
    const m2 = TableMap.get(t2);
    const texts: string[] = [];
    for (let c = 0; c < 3; c += 1) {
      const n = t2.nodeAt(m2.positionAt(2, c, t2));
      texts.push(n?.textContent ?? '');
    }
    expect(texts).toEqual(['a', 'b', 'c']);
    // Original row 1 unchanged.
    const orig: string[] = [];
    for (let c = 0; c < 3; c += 1) {
      const n = t2.nodeAt(m2.positionAt(1, c, t2));
      orig.push(n?.textContent ?? '');
    }
    expect(orig).toEqual(['a', 'b', 'c']);
    void Plugin;
    void TextSelection;
    void selectedRect;
  });
});


describe('TSV field escaping', () => {
  it('quotes fields that contain tab, newline, or double-quote', () => {
    expect(escapeTsvField('plain')).toBe('plain');
    expect(escapeTsvField('a\tb')).toBe('"a\tb"');
    expect(escapeTsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeTsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('round-trips escaped TSV with tabs and quotes inside cells', () => {
    const matrix = [
      ['a\tb', 'say "hi"'],
      ['line1\nline2', 'ok'],
    ];
    const tsv = matrixToTsv(matrix);
    expect(tsv).toContain('"a\tb"');
    expect(tsv).toContain('"say ""hi"""');
    expect(parseTsvMatrix(tsv)).toEqual(matrix);
  });

  it('encode/decode preserves cells that need TSV escaping', () => {
    const matrix = [
      ['453', 'has\t tab'],
      ['x', 'y'],
    ];
    const encoded = encodeMatrixClipboardText(matrix);
    expect(decodeMatrixClipboardText(encoded)).toEqual(matrix);
  });
});
