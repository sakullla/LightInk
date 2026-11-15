/**
 * Table operations (Typora / Obsidian Advanced Tables–style):
 *   - Insert column left/right, row above/below
 *   - Delete row / column / table
 *   - Select current row / column
 *   - Ctrl/Cmd+Enter → insert row below (Typora)
 *   - Ctrl/Cmd+Shift+Enter → insert row above
 *   - Ctrl/Cmd+Alt+ArrowLeft/Right → insert column left/right
 *   - Ctrl/Cmd+Shift+Backspace → delete current row
 *   - TSV paste from spreadsheets (when inside a table)
 *
 * Pure helpers are headless-testable; keymap/paste live in `$prose`.
 *
 * @see https://support.typora.io/Table-Editing/
 * @see https://github.com/tgrosinger/advanced-tables-obsidian
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { Command, EditorState, Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { Fragment } from '@milkdown/prose/model';
import {
  addColumn,
  addColumnAfter,
  addColumnBefore,
  addRow,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect,
  selectionCell,
  TableMap,
} from '@milkdown/prose/tables';

const PLUGIN_KEY = new PluginKey('lightink-table-ops');

export type TableColumnAlign = 'left' | 'center' | 'right';

export type TableOpId =
  | 'insert-col-left'
  | 'insert-col-right'
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'delete-column'
  | 'delete-table'
  | 'select-row'
  | 'select-column'
  | 'align-col-left'
  | 'align-col-center'
  | 'align-col-right';

/** True when the caret/selection is inside a GFM table. */
export function editorIsInTable(state: EditorState): boolean {
  return isInTable(state);
}

/** Run a prosemirror-tables command; returns whether it applied. */
export function runTableCommand(view: EditorView, command: Command): boolean {
  return command(view.state, (tr) => view.dispatch(tr));
}

export function insertColumnLeft(view: EditorView): boolean {
  return runTableCommand(view, addColumnBefore);
}

export function insertColumnRight(view: EditorView): boolean {
  return runTableCommand(view, addColumnAfter);
}

export function insertRowAbove(view: EditorView): boolean {
  return runTableCommand(view, addRowBefore);
}

export function insertRowBelow(view: EditorView): boolean {
  return runTableCommand(view, addRowAfter);
}

export function removeCurrentRow(view: EditorView): boolean {
  return runTableCommand(view, deleteRow);
}

export function removeCurrentColumn(view: EditorView): boolean {
  return runTableCommand(view, deleteColumn);
}

export function removeTable(view: EditorView): boolean {
  return runTableCommand(view, deleteTable);
}

/** Select the full row containing the caret (CellSelection). */
export function selectCurrentRow(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  const $cell = selectionCell(view.state);
  if ($cell === null || $cell === undefined) return false;
  const sel = CellSelection.rowSelection($cell);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  return true;
}

/** Select the full column containing the caret. */
export function selectCurrentColumn(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  const $cell = selectionCell(view.state);
  if ($cell === null || $cell === undefined) return false;
  const sel = CellSelection.colSelection($cell);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
  return true;
}

/** Read the GFM alignment of the active column (defaults to `'left'`). */
export function getActiveColumnAlignment(state: EditorState): TableColumnAlign | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    if (rect.map.width <= 0 || rect.map.height <= 0) return null;
    const col = Math.min(Math.max(0, rect.left), rect.map.width - 1);
    const offset = rect.map.positionAt(0, col, rect.table);
    const cell = rect.table.nodeAt(offset);
    const raw = cell?.attrs?.['alignment'];
    if (raw === 'center' || raw === 'right' || raw === 'left') {
      return raw;
    }
    return 'left';
  } catch {
    return null;
  }
}

/**
 * Set GFM column alignment (`left` | `center` | `right`) on every row of the
 * selected column(s) in a single undoable transaction. Milkdown GFM serializes
 * column alignment from the header row's `alignment` cell attribute and paints
 * `text-align` on each cell in DOM.
 */
export function setColumnAlignment(
  view: EditorView,
  alignment: TableColumnAlign,
): boolean {
  if (!isInTable(view.state)) return false;
  let rect;
  try {
    rect = selectedRect(view.state);
  } catch {
    return false;
  }
  const { table, tableStart, map } = rect;
  if (map.width <= 0 || map.height <= 0) return false;
  const startCol = Math.max(0, rect.left);
  const endCol = Math.min(map.width, Math.max(startCol + 1, rect.right));
  const visitedOffsets = new Set<number>();
  let tr = view.state.tr;
  let changed = false;

  for (let row = 0; row < map.height; row += 1) {
    for (let col = startCol; col < endCol; col += 1) {
      const offset = map.positionAt(row, col, table);
      if (visitedOffsets.has(offset)) continue;
      visitedOffsets.add(offset);
      const cell = table.nodeAt(offset);
      if (cell === null) continue;
      if (cell.attrs['alignment'] === alignment) continue;
      tr = tr.setNodeMarkup(tableStart + offset, undefined, {
        ...cell.attrs,
        alignment,
      });
      changed = true;
    }
  }

  if (changed) {
    view.dispatch(tr);
  }
  return true;
}

export function runTableOp(view: EditorView, op: TableOpId): boolean {
  switch (op) {
    case 'insert-col-left':
      return insertColumnLeft(view);
    case 'insert-col-right':
      return insertColumnRight(view);
    case 'insert-row-above':
      return insertRowAbove(view);
    case 'insert-row-below':
      return insertRowBelow(view);
    case 'delete-row':
      return removeCurrentRow(view);
    case 'delete-column':
      return removeCurrentColumn(view);
    case 'delete-table':
      return removeTable(view);
    case 'select-row':
      return selectCurrentRow(view);
    case 'select-column':
      return selectCurrentColumn(view);
    case 'align-col-left':
      return setColumnAlignment(view, 'left');
    case 'align-col-center':
      return setColumnAlignment(view, 'center');
    case 'align-col-right':
      return setColumnAlignment(view, 'right');
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// TSV / spreadsheet paste helpers
// ---------------------------------------------------------------------------

/**
 * In-session matrix clipboard.
 * WebViews (Tauri) often normalize tabs in text/plain to spaces, so a copied
 * row "a\\tb" becomes "a b" and pastes into a single cell. Keeping the last
 * copied matrix in memory makes internal row/col copy→paste reliable.
 *
 * Do NOT put control-character wire formats into text/plain — WebView may strip
 * them and then default paste dumps the raw prefix into a cell.
 */
let sessionTableMatrix: string[][] | null = null;

/** Printable cell/row separators for optional wire fallback (no control chars). */
const CELL_SEP = '¦';
const ROW_SEP = '¶';
const MATRIX_PREFIX = 'lightink-table-v1:';

/** Remember a matrix for the next in-app paste (also written to OS clipboard). */
export function setSessionTableMatrix(matrix: string[][] | null): void {
  sessionTableMatrix =
    matrix === null
      ? null
      : matrix.map((row) => row.map((c) => (typeof c === 'string' ? c : String(c ?? ''))));
}

export function getSessionTableMatrix(): string[][] | null {
  return sessionTableMatrix;
}

/**
 * Escape one TSV field (Excel / RFC4180-style for tabs).
 * Quote when the cell contains tab, CR/LF, or `"`.
 * Internal `"` → `""`.
 */
export function escapeTsvField(cell: string): string {
  const value = cell ?? '';
  if (/[\t\r\n"]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Serialize a matrix to escaped TSV (tabs between cells, newlines between rows). */
export function matrixToTsv(matrix: string[][]): string {
  if (matrix.length === 0) return '';
  return matrix.map((row) => row.map(escapeTsvField).join('\t')).join('\n');
}

/**
 * Encode a matrix for text/plain.
 * - Prefer escaped TSV for Excel / external paste.
 * - Append a printable wire line as fallback when tabs get normalized to spaces.
 * Session memory is the primary path for in-app row/col paste.
 */
export function encodeMatrixClipboardText(matrix: string[][]): string {
  if (matrix.length === 0) return '';
  const tsv = matrixToTsv(matrix);
  const wire =
    MATRIX_PREFIX +
    matrix
      .map((row) =>
        row
          .map((c) =>
            // Escape wire separators that may appear in cell text.
            c
              .replace(/\\/g, '\\\\')
              .replace(/¦/g, '\\¦')
              .replace(/¶/g, '\\¶')
              .replace(/\r?\n/g, '\\n'),
          )
          .join(CELL_SEP),
      )
      .join(ROW_SEP);
  // TSV first for spreadsheets; wire second so external tools still get tabs.
  return tsv.includes('\t') || matrix.length > 1 ? `${tsv}\n${wire}` : `${tsv}\n${wire}`;
}

/** Unescape one lightink wire cell (\\n, \\¦, \\¶, \\\\). */
function unescapeWireCell(cell: string): string {
  let out = '';
  for (let i = 0; i < cell.length; i += 1) {
    if (cell[i] === '\\' && i + 1 < cell.length) {
      const next = cell[i + 1]!;
      if (next === 'n') {
        out += '\n';
        i += 1;
        continue;
      }
      if (next === '¦' || next === '¶' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += cell[i];
  }
  return out;
}

/** Decode wire / TSV clipboard text into a matrix (session is handled separately). */
export function decodeMatrixClipboardText(text: string): string[][] | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1) lightink-table-v1 wire (printable separators + backslash escapes).
  const wireIdx = normalized.indexOf(MATRIX_PREFIX);
  if (wireIdx !== -1) {
    let payload = normalized.slice(wireIdx + MATRIX_PREFIX.length).trim();
    // Wire may be its own line after TSV — take only the wire payload line(s)
    // until end, but stop if a second prefix appears.
    const nextPrefix = payload.indexOf('\n' + MATRIX_PREFIX);
    if (nextPrefix !== -1) payload = payload.slice(0, nextPrefix).trim();
    // Prefer single-line wire (encode writes one line).
    const firstNl = payload.indexOf('\n');
    // Allow escaped newlines inside cells (\\n), so only split on real newlines
    // that are not part of TSV above — payload is after prefix on its line.
    if (firstNl !== -1) {
      // Multi-line residual: keep full payload only if it has ROW_SEP; else first line.
      if (!payload.includes(ROW_SEP)) {
        payload = payload.slice(0, firstNl).trim();
      }
    }
    if (payload.length > 0 && (payload.includes(CELL_SEP) || payload.includes(ROW_SEP))) {
      const rows = payload
        .split(ROW_SEP)
        .map((row) => row.split(CELL_SEP).map(unescapeWireCell));
      if (rows.length > 0 && rows[0]!.length > 0) {
        const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
        return rows.map((r) => {
          const copy = r.slice();
          while (copy.length < width) copy.push('');
          return copy;
        });
      }
    }
    // Broken wire without separators — do not treat as a 1×1 matrix of garbage.
  }

  // 2) Escaped TSV (tabs survived). Skip lines that are our wire trailer.
  if (normalized.includes('\t') || /"[^"]*"/.test(normalized)) {
    const withoutWire = normalized
      .split('\n')
      .filter((l) => !l.includes(MATRIX_PREFIX))
      .join('\n');
    if (withoutWire.length > 0 && looksLikeTsvGrid(withoutWire)) {
      const m = parseTsvMatrix(withoutWire);
      if (m.length > 0) return m;
    }
  }

  return null;
}

/**
 * Detect spreadsheet-ish plain text we should paste as table cells.
 * - Classic TSV: any line with a tab
 * - lightink wire format
 * - Single-column multi-line (row copy from 1-col table): 2+ non-empty lines, no pipes
 *   (avoid treating ordinary multi-paragraph paste as a grid)
 */
export function looksLikeTsvGrid(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.includes(MATRIX_PREFIX)) return true;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.includes('\t')) {
    return normalized.split('\n').some((l) => l.includes('\t'));
  }
  // Single-column export: one cell per line, no markdown table pipes.
  const lines = normalized.split('\n').filter((l) => l.length > 0);
  if (lines.length >= 2 && lines.every((l) => !l.includes('|') && !l.startsWith('#'))) {
    // Only treat as grid when every line is a short cell-like token (not paragraphs).
    return lines.every((l) => l.length <= 200 && !l.includes('\n'));
  }
  return false;
}

/** Detect HTML table fragment from clipboard (our copy path / Excel). */
export function looksLikeHtmlTable(html: string): boolean {
  if (typeof html !== 'string' || html.length === 0) return false;
  return /<table[\s>]/i.test(html) && /<t[dh][\s>]/i.test(html);
}

/** Parse an HTML table string into a string matrix (best-effort, no DOM required). */
export function parseHtmlTableMatrix(html: string): string[][] {
  if (!looksLikeHtmlTable(html)) return [];
  const rows: string[][] = [];
  const rowRe = /<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    const cellRe = /<t[dh][\s\S]*?>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      const raw = cellMatch[1] ?? '';
      const text = raw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\n+/g, ' ')
        .trim();
      cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => {
    const copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
}

/** Build a minimal HTML table for clipboard (helps PM tableEditing + Excel). */
export function matrixToHtmlTable(matrix: string[][]): string {
  if (matrix.length === 0) return '';
  const esc = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const body = matrix
    .map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table data-lightink-table="1"><tbody>${body}</tbody></table>`;
}

/**
 * Parse TSV into a rectangular string matrix (rows × cols).
 * Supports RFC4180-style quoting: `"a\tb"` / `"say ""hi"""` / multiline quoted cells.
 * Unquoted cells still split on tab / newline (classic spreadsheet paste).
 */
export function parseTsvMatrix(text: string): string[][] {
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    // Drop a trailing empty row from a final newline (spreadsheet copy).
    if (row.length === 1 && row[0] === '' && rows.length > 0 && i >= src.length) {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Quote only starts a field at field boundary.
      if (field === '') {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Last field / row (no trailing newline).
  if (inQuotes) {
    // Unclosed quote: keep content as-is.
    pushField();
    pushRow();
  } else if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  } else if (rows.length === 0) {
    // Empty input.
    return [];
  }

  // Drop trailing empty line produced by final \n.
  while (
    rows.length > 0 &&
    rows[rows.length - 1]!.length === 1 &&
    rows[rows.length - 1]![0] === ''
  ) {
    rows.pop();
  }

  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => {
    const copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  });
}

/**
 * Convert a string matrix to a GFM markdown table (header = first row if
 * `headerFromFirst`; otherwise synthetic 列1… headers).
 */
export function matrixToMarkdownTable(
  matrix: string[][],
  headerFromFirst = true,
): string {
  if (matrix.length === 0) return '';
  const width = matrix[0]!.length;
  const escape = (cell: string): string =>
    cell.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  let header: string[];
  let body: string[][];
  if (headerFromFirst && matrix.length >= 1) {
    header = matrix[0]!.map(escape);
    body = matrix.slice(1).map((r) => r.map(escape));
  } else {
    header = Array.from({ length: width }, (_, i) => `列${i + 1}`);
    body = matrix.map((r) => r.map(escape));
  }
  // Ensure header cells non-empty (GFM).
  header = header.map((h, i) => (h === '' ? `列${i + 1}` : h));
  const sep = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Paste a string matrix into the table at the selection.
 *
 * Behaviour (Excel / Typora-ish):
 *   - Anchor = top-left of CellSelection, or the caret cell
 *   - Full-width single-row paste always starts at column 0 (copied row → new row)
 *   - Full-height single-column paste always starts at row 0 when pasting a column
 *   - Auto-grows rows/columns when paste exceeds the table
 *   - Overwrites cell text; preserves cell type (header vs body)
 *
 * Position rule: after each structural change we re-read the table from
 * `tableStart` (stable while edits stay inside the table) and use absolute
 * positions from the *current* map without mapping them again (double-map was
 * the bug that made “copy row → paste into new row” a no-op / scramble).
 */
export function pasteMatrixIntoTable(view: EditorView, matrix: string[][]): boolean {
  if (!isInTable(view.state)) return false;
  if (matrix.length === 0 || matrix[0]!.length === 0) return false;

  const state = view.state;
  let rect;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }

  const pasteH = matrix.length;
  const pasteW = matrix[0]!.length;
  let startRow = rect.top;
  let startCol = rect.left;

  // Copied a full row (or a row-wide TSV) → paste from column 0 of the target row.
  const isRowSel =
    state.selection instanceof CellSelection && state.selection.isRowSelection();
  const isColSel =
    state.selection instanceof CellSelection && state.selection.isColSelection();
  if (isRowSel || (pasteH === 1 && pasteW >= rect.map.width)) {
    startCol = 0;
    if (isRowSel) {
      startRow = Math.min(rect.top, Math.max(0, rect.bottom - 1));
    }
  }
  // Copied a full column → paste from row 0 of the target column (unless single cell).
  if (isColSel || (pasteW === 1 && pasteH >= rect.map.height && pasteH > 1)) {
    if (isColSel) {
      startCol = Math.min(rect.left, Math.max(0, rect.right - 1));
    }
    // Keep startRow at caret/selection top so “paste column into middle” still works;
    // only force row 0 when the selection itself is a whole column.
    if (isColSel && pasteH >= rect.map.height) {
      startRow = 0;
    }
  }

  const paragraphType = state.schema.nodes['paragraph'];
  if (paragraphType === undefined) return false;

  let tr: Transaction = state.tr;
  // tableStart is the position of the first child of the table node (content start).
  // Growing/replacing cells inside the table does not move tableStart.
  const tableStart = rect.tableStart;
  let table = rect.table;
  let map = rect.map;

  const recomp = (): boolean => {
    const node = tr.doc.nodeAt(tableStart - 1);
    if (node === null || node.type.spec.tableRole !== 'table') return false;
    table = node;
    map = TableMap.get(table);
    return true;
  };

  const asRect = () => ({
    left: 0,
    top: 0,
    right: map.width,
    bottom: map.height,
    map,
    tableStart,
    table,
  });

  const needBottom = startRow + pasteH;
  const needRight = startCol + pasteW;
  while (map.height < needBottom) {
    tr = addRow(tr, asRect(), map.height);
    if (!recomp()) return false;
  }
  while (map.width < needRight) {
    tr = addColumn(tr, asRect(), map.width);
    if (!recomp()) return false;
  }

  // Write cells using positions from the current map (no extra tr.mapping.map).
  for (let r = 0; r < pasteH; r += 1) {
    for (let c = 0; c < pasteW; c += 1) {
      const trRow = startRow + r;
      const trCol = startCol + c;
      if (!recomp()) return false;
      if (trRow >= map.height || trCol >= map.width) continue;
      const cellPos = tableStart + map.positionAt(trRow, trCol, table);
      const cellNode = tr.doc.nodeAt(cellPos);
      if (cellNode === null) continue;
      const cellText = matrix[r]![c] ?? '';
      const para =
        cellText === ''
          ? paragraphType.create()
          : paragraphType.create(null, state.schema.text(cellText));
      const newCell = cellNode.type.create(cellNode.attrs, Fragment.from(para));
      tr = tr.replaceWith(cellPos, cellPos + cellNode.nodeSize, newCell);
    }
  }

  // Select the pasted block so the user sees the result.
  try {
    if (!recomp()) {
      view.dispatch(tr.scrollIntoView());
      return true;
    }
    const endRow = Math.min(map.height - 1, startRow + pasteH - 1);
    const endCol = Math.min(map.width - 1, startCol + pasteW - 1);
    const $a = tr.doc.resolve(tableStart + map.positionAt(startRow, startCol, table));
    const $b = tr.doc.resolve(tableStart + map.positionAt(endRow, endCol, table));
    tr = tr.setSelection(new CellSelection($a, $b));
  } catch {
    try {
      if (recomp()) {
        const pos = tableStart + map.positionAt(startRow, startCol, table) + 1;
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
      }
    } catch {
      // keep default selection
    }
  }

  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Paste TSV / wire / single-col grid text into the table. */
export function pasteTsvIntoTable(view: EditorView, text: string): boolean {
  const decoded = decodeMatrixClipboardText(text);
  if (decoded !== null) {
    return pasteMatrixIntoTable(view, decoded);
  }
  if (!looksLikeTsvGrid(text) && !text.includes('\t')) {
    return false;
  }
  const matrix = parseTsvMatrix(text);
  return pasteMatrixIntoTable(view, matrix);
}

/** Paste HTML table into the current table. */
export function pasteHtmlTableIntoTable(view: EditorView, html: string): boolean {
  const matrix = parseHtmlTableMatrix(html);
  if (matrix.length === 0) return false;
  return pasteMatrixIntoTable(view, matrix);
}

/**
 * Resolve the best matrix from clipboard + session for an in-table paste.
 *
 * Priority:
 *   1. Multi-cell HTML table (Excel / our copy)
 *   2. Multi-cell wire/TSV text
 *   3. In-session matrix (always wins over broken single-cell plain text,
 *      and over any text that still carries our MATRIX_PREFIX)
 *   4. Single-cell structured sources
 *
 * Never return a 1×1 matrix whose only cell is a raw `lightink-table-v1:…`
 * blob — that is what the user saw pasted into a cell.
 */
export function resolvePasteMatrix(
  html: string,
  text: string,
): string[][] | null {
  const isGarbageWireCell = (m: string[][]): boolean =>
    m.length === 1 &&
    m[0]!.length === 1 &&
    typeof m[0]![0] === 'string' &&
    m[0]![0]!.includes(MATRIX_PREFIX);

  const fromHtml = looksLikeHtmlTable(html) ? parseHtmlTableMatrix(html) : [];
  if (fromHtml.length > 0 && (fromHtml.length > 1 || fromHtml[0]!.length > 1)) {
    return fromHtml;
  }

  const fromText = decodeMatrixClipboardText(text);
  if (
    fromText !== null &&
    !isGarbageWireCell(fromText) &&
    (fromText.length > 1 || fromText[0]!.length > 1)
  ) {
    return fromText;
  }

  // In-app row/col copy: session is authoritative when OS clipboard is degraded.
  if (sessionTableMatrix !== null && sessionTableMatrix.length > 0) {
    // Prefer session whenever clipboard looks like our wire or collapsed TSV.
    if (
      text.includes(MATRIX_PREFIX) ||
      fromText === null ||
      isGarbageWireCell(fromText) ||
      (fromHtml.length <= 1 && (fromHtml[0]?.length ?? 0) <= 1)
    ) {
      return sessionTableMatrix.map((r) => r.slice());
    }
  }

  if (fromHtml.length > 0 && !isGarbageWireCell(fromHtml)) return fromHtml;
  if (fromText !== null && !isGarbageWireCell(fromText)) return fromText;

  if (sessionTableMatrix !== null && sessionTableMatrix.length > 0) {
    return sessionTableMatrix.map((r) => r.slice());
  }

  // Plain TSV without our prefix.
  if (
    (looksLikeTsvGrid(text) || text.includes('\t')) &&
    !text.includes(MATRIX_PREFIX)
  ) {
    const m = parseTsvMatrix(text);
    return m.length > 0 ? m : null;
  }
  return null;
}

/**
 * Build a rectangular string matrix from the current table selection.
 * Uses TableMap.rectBetween so row/column selections stay rectangular
 * (forEachCell + index heuristics scramble column order).
 */
export function selectionToMatrix(state: EditorState): string[][] | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    const { table, map } = rect;
    // selectedRect already spans the CellSelection or the caret cell.
    const top = rect.top;
    const bottom = rect.bottom;
    const left = rect.left;
    const right = rect.right;
    if (bottom <= top || right <= left) return null;
    const rows: string[][] = [];
    for (let row = top; row < bottom; row += 1) {
      const cells: string[] = [];
      for (let col = left; col < right; col += 1) {
        const offset = map.positionAt(row, col, table);
        const cell = table.nodeAt(offset);
        cells.push((cell?.textContent ?? '').replace(/\t/g, ' ').replace(/\n/g, ' '));
      }
      rows.push(cells);
    }
    return rows;
  } catch {
    return null;
  }
}

/**
 * Serialize a CellSelection (or current cell if text caret in table) to TSV
 * for spreadsheet-friendly copy.
 */
export function selectionToTsv(state: EditorState): string | null {
  const matrix = selectionToMatrix(state);
  if (matrix === null || matrix.length === 0) return null;
  return matrixToTsv(matrix);
}

/** Build markdown for the selected cells / current row (GFM pipes). */
export function selectionToMarkdownTableFragment(state: EditorState): string | null {
  const matrix = selectionToMatrix(state);
  if (matrix === null || matrix.length === 0) return null;
  // Fragment (not full table with header) — just pipe rows for paste-as-md.
  return matrix
    .map((r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Plugin: keymap + TSV paste
// ---------------------------------------------------------------------------

function isMod(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

/** Shared paste body used by PM handlePaste and capture-phase DOM listener. */
export function tryPasteIntoTable(view: EditorView, event: ClipboardEvent): boolean {
  if (!isInTable(view.state)) return false;
  const html = event.clipboardData?.getData('text/html') ?? '';
  const text = event.clipboardData?.getData('text/plain') ?? '';
  // Custom MIME from our copy path (when host allows it).
  let custom: string[][] | null = null;
  try {
    const raw = event.clipboardData?.getData('application/x-lightink-table') ?? '';
    if (raw !== '') {
      const parsed = JSON.parse(raw) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'string'))
      ) {
        custom = parsed as string[][];
      }
    }
  } catch {
    custom = null;
  }

  if (custom !== null && custom.length > 0 && pasteMatrixIntoTable(view, custom)) {
    return true;
  }

  // Structured row/col paste: session memory + HTML + wire/TSV.
  const matrix = resolvePasteMatrix(html, text);
  if (matrix !== null && pasteMatrixIntoTable(view, matrix)) {
    return true;
  }

  // Never dump our wire prefix into a cell as plain text.
  if (text.includes(MATRIX_PREFIX)) {
    if (sessionTableMatrix !== null && pasteMatrixIntoTable(view, sessionTableMatrix)) {
      return true;
    }
    // Consume the event so default paste does not insert garbage.
    return true;
  }

  // Single-line plain text (no structure): fill caret cell or selection.
  if (text !== '' && !text.includes('\n') && !text.includes('\t')) {
    if (view.state.selection instanceof CellSelection) {
      let rect;
      try {
        rect = selectedRect(view.state);
      } catch {
        rect = null;
      }
      if (rect !== null) {
        const h = Math.max(1, rect.bottom - rect.top);
        const w = Math.max(1, rect.right - rect.left);
        if (
          (view.state.selection.isRowSelection() || view.state.selection.isColSelection()) &&
          (h > 1 || w > 1)
        ) {
          return pasteMatrixIntoTable(view, [[text]]);
        }
        const fill = Array.from({ length: h }, () =>
          Array.from({ length: w }, () => text),
        );
        return pasteMatrixIntoTable(view, fill);
      }
    } else {
      return pasteMatrixIntoTable(view, [[text]]);
    }
  }
  return false;
}

export const tableOpsPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        if (!isInTable(view.state)) return false;

        // Typora: Ctrl+Enter → row below; Ctrl+Shift+Enter → row above.
        if (event.key === 'Enter' && isMod(event) && !event.altKey) {
          event.preventDefault();
          return event.shiftKey ? insertRowAbove(view) : insertRowBelow(view);
        }

        // Ctrl+Alt+← / → → column left / right.
        if (
          isMod(event) &&
          event.altKey &&
          !event.shiftKey &&
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        ) {
          event.preventDefault();
          return event.key === 'ArrowLeft'
            ? insertColumnLeft(view)
            : insertColumnRight(view);
        }

        // Ctrl+Alt+↑ / ↓ → row above / below (alternate to Enter).
        if (
          isMod(event) &&
          event.altKey &&
          !event.shiftKey &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        ) {
          event.preventDefault();
          return event.key === 'ArrowUp' ? insertRowAbove(view) : insertRowBelow(view);
        }

        // Ctrl+Shift+Backspace → delete current row (Typora-ish).
        if (
          event.key === 'Backspace' &&
          isMod(event) &&
          event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          return removeCurrentRow(view);
        }

        // Ctrl+Shift+Delete → delete current column.
        if (
          event.key === 'Delete' &&
          isMod(event) &&
          event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          return removeCurrentColumn(view);
        }

        // Escape from CellSelection → caret in last cell.
        if (event.key === 'Escape' && view.state.selection instanceof CellSelection) {
          const $head = view.state.selection.$headCell;
          const pos = $head.pos + 1;
          try {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))),
            );
            event.preventDefault();
            return true;
          } catch {
            return false;
          }
        }

        return false;
      },

      handlePaste(view: EditorView, event: ClipboardEvent, _slice: unknown): boolean {
        if (tryPasteIntoTable(view, event)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    view(editorView: EditorView) {
      // Capture-phase paste: run before other handlers / default PM path so
      // row/col session paste never falls through as plain text.
      const onPaste = (event: Event): void => {
        const ce = event as ClipboardEvent;
        if (tryPasteIntoTable(editorView, ce)) {
          ce.preventDefault();
          ce.stopImmediatePropagation();
        }
      };
      editorView.dom.addEventListener('paste', onPaste, true);
      return {
        destroy() {
          editorView.dom.removeEventListener('paste', onPaste, true);
        },
      };
    },
  });
});

/** Menu labels for table ops (Chinese UI). */
export const TABLE_OP_LABELS: Readonly<Record<TableOpId, string>> = {
  'insert-col-left': '左侧插入列',
  'insert-col-right': '右侧插入列',
  'insert-row-above': '上方插入行',
  'insert-row-below': '下方插入行',
  'delete-row': '删除当前行',
  'delete-column': '删除当前列',
  'delete-table': '删除表格',
  'select-row': '选中当前行',
  'select-column': '选中当前列',
  'align-col-left': '列左对齐',
  'align-col-center': '列居中对齐',
  'align-col-right': '列右对齐',
};

export const TABLE_OP_SHORTCUTS: Readonly<Partial<Record<TableOpId, string>>> = {
  'insert-row-below': 'Ctrl+Enter',
  'insert-row-above': 'Ctrl+Shift+Enter',
  'insert-col-left': 'Ctrl+Alt+←',
  'insert-col-right': 'Ctrl+Alt+→',
  'delete-row': 'Ctrl+Shift+Backspace',
  'delete-column': 'Ctrl+Shift+Delete',
};
