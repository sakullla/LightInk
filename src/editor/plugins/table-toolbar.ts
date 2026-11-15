/**
 * Contextual floating Table Action Bar (`$prose` plugin).
 *
 * Appears anchored at the top-right edge of the active `.tableWrapper` when an
 * editable editor is focused inside a table without a competing non-empty text
 * selection (so `format-toolbar` and `table-toolbar` never collide).
 *
 * Pure placement helper `placeTableToolbar` is headless-testable.
 */

import { $prose } from '@milkdown/utils';
import { CellSelection, isInTable } from '@milkdown/prose/tables';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import {
  getActiveColumnAlignment,
  runTableOp,
  TABLE_OP_LABELS,
  type TableColumnAlign,
  type TableOpId,
} from './table-ops.js';

const PLUGIN_KEY = new PluginKey('lightink-table-toolbar');

export type TableToolbarActionId =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'insert-col-left'
  | 'insert-col-right'
  | 'align-col-left'
  | 'align-col-center'
  | 'align-col-right'
  | 'delete-row'
  | 'delete-column'
  | 'delete-table';

export interface TableToolbarLabels {
  toolbarLabel?: string;
  titles?: Partial<Record<TableToolbarActionId, string>>;
}

let toolbarAriaLabel = '表格操作';
const actionTitles: Record<TableToolbarActionId, string> = {
  'insert-row-above': TABLE_OP_LABELS['insert-row-above'],
  'insert-row-below': TABLE_OP_LABELS['insert-row-below'],
  'insert-col-left': TABLE_OP_LABELS['insert-col-left'],
  'insert-col-right': TABLE_OP_LABELS['insert-col-right'],
  'align-col-left': TABLE_OP_LABELS['align-col-left'],
  'align-col-center': TABLE_OP_LABELS['align-col-center'],
  'align-col-right': TABLE_OP_LABELS['align-col-right'],
  'delete-row': TABLE_OP_LABELS['delete-row'],
  'delete-column': TABLE_OP_LABELS['delete-column'],
  'delete-table': TABLE_OP_LABELS['delete-table'],
};

const liveToolbars = new Set<HTMLElement>();

export function setTableToolbarLabels(next: TableToolbarLabels): void {
  if (typeof next.toolbarLabel === 'string' && next.toolbarLabel !== '') {
    toolbarAriaLabel = next.toolbarLabel;
  }
  if (next.titles !== undefined) {
    for (const [id, value] of Object.entries(next.titles) as Array<
      [TableToolbarActionId, string | undefined]
    >) {
      if (typeof value === 'string' && value !== '') {
        actionTitles[id] = value;
      }
    }
  }
  for (const el of liveToolbars) {
    el.setAttribute('aria-label', toolbarAriaLabel);
    for (const btn of el.querySelectorAll<HTMLButtonElement>('button[data-table-op]')) {
      const id = btn.dataset['tableOp'] as TableToolbarActionId | undefined;
      if (id !== undefined && actionTitles[id] !== undefined) {
        btn.title = actionTitles[id];
        btn.setAttribute('aria-label', actionTitles[id]);
      }
    }
  }
}

export interface TableToolbarBox {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface TableToolbarPlacement {
  readonly visible: boolean;
  readonly top: number;
  readonly left: number;
}

/**
 * Pure placement: dock above the table's top-right edge; if the table's top is
 * scrolled above the visible pane, stick inside the top of the pane until the
 * table scrolls out of view.
 */
export function placeTableToolbar(
  table: TableToolbarBox,
  size: { readonly width: number; readonly height: number },
  bounds: TableToolbarBox,
  viewport: { readonly width: number; readonly height: number },
  gap = 6,
): TableToolbarPlacement {
  const minVisibleBottom = bounds.top + size.height + gap * 2;
  const maxVisibleTop = bounds.bottom - gap * 2;
  if (table.bottom < minVisibleBottom || table.top > maxVisibleTop) {
    return { visible: false, top: 0, left: 0 };
  }

  let top = table.top - size.height - gap;
  if (top < bounds.top + gap) {
    top = Math.min(bounds.top + gap, table.bottom - size.height - gap);
  }
  top = Math.max(gap, Math.min(top, viewport.height - size.height - gap));

  let left = table.right - size.width;
  const minLeft = Math.max(gap, bounds.left + gap);
  const maxLeft = Math.max(minLeft, Math.min(viewport.width - size.width - gap, bounds.right - size.width - gap));
  left = Math.min(Math.max(minLeft, left), maxLeft);

  return { visible: true, top: Math.round(top), left: Math.round(left) };
}

function iconSvg(paths: string): string {
  return (
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

const ICONS: Readonly<Record<TableToolbarActionId, string>> = {
  'insert-row-above': iconSvg(
    '<rect x="2.5" y="7.5" width="11" height="5.5" rx="1"/>' +
      '<path d="M8 2v3.5M6.25 3.75h3.5"/>',
  ),
  'insert-row-below': iconSvg(
    '<rect x="2.5" y="3" width="11" height="5.5" rx="1"/>' +
      '<path d="M8 10.5V14M6.25 12.25h3.5"/>',
  ),
  'insert-col-left': iconSvg(
    '<rect x="7.5" y="2.5" width="5.5" height="11" rx="1"/>' +
      '<path d="M3.75 6.25v3.5M2 8h3.5"/>',
  ),
  'insert-col-right': iconSvg(
    '<rect x="3" y="2.5" width="5.5" height="11" rx="1"/>' +
      '<path d="M12.25 6.25v3.5M10.5 8H14"/>',
  ),
  'align-col-left': iconSvg(
    '<path d="M2.5 4h11M2.5 8h7M2.5 12h9.5"/>',
  ),
  'align-col-center': iconSvg(
    '<path d="M2.5 4h11M4.5 8h7M3.25 12h9.5"/>',
  ),
  'align-col-right': iconSvg(
    '<path d="M2.5 4h11M6.5 8h7M4 12h9.5"/>',
  ),
  'delete-row': iconSvg(
    '<rect x="2.5" y="5.25" width="11" height="5.5" rx="1"/>' +
      '<path d="M5.5 8h5"/>',
  ),
  'delete-column': iconSvg(
    '<rect x="5.25" y="2.5" width="5.5" height="11" rx="1"/>' +
      '<path d="M6.2 8h3.6"/>',
  ),
  'delete-table': iconSvg(
    '<path d="M3.5 4.5h9M6 4.5V3.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3"/>' +
      '<path d="M4.5 4.5l.6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3"/>',
  ),
};

interface ToolbarEntry {
  readonly kind: 'action';
  readonly id: TableToolbarActionId;
  readonly align?: TableColumnAlign;
  readonly danger?: boolean;
}

interface ToolbarSep {
  readonly kind: 'sep';
}

const TOOLBAR_SPEC: ReadonlyArray<ToolbarEntry | ToolbarSep> = [
  { kind: 'action', id: 'insert-row-above' },
  { kind: 'action', id: 'insert-row-below' },
  { kind: 'action', id: 'insert-col-left' },
  { kind: 'action', id: 'insert-col-right' },
  { kind: 'sep' },
  { kind: 'action', id: 'align-col-left', align: 'left' },
  { kind: 'action', id: 'align-col-center', align: 'center' },
  { kind: 'action', id: 'align-col-right', align: 'right' },
  { kind: 'sep' },
  { kind: 'action', id: 'delete-row', danger: true },
  { kind: 'action', id: 'delete-column', danger: true },
  { kind: 'action', id: 'delete-table', danger: true },
];

function createTableToolbarElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lightink-table-toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', toolbarAriaLabel);
  el.style.display = 'none';
  el.style.position = 'fixed';
  el.style.zIndex = '990';

  for (const item of TOOLBAR_SPEC) {
    if (item.kind === 'sep') {
      const sep = document.createElement('span');
      sep.className = 'lightink-table-toolbar__sep';
      sep.setAttribute('aria-hidden', 'true');
      el.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'lightink-table-tool' +
      (item.danger === true ? ' lightink-table-tool--danger' : '');
    btn.dataset['tableOp'] = item.id;
    if (item.align !== undefined) {
      btn.dataset['tableAlign'] = item.align;
      btn.setAttribute('aria-pressed', 'false');
    }
    btn.innerHTML = ICONS[item.id];
    const label = actionTitles[item.id];
    btn.title = label;
    btn.setAttribute('aria-label', label);
    el.appendChild(btn);
  }
  return el;
}

function findActiveTableWrapper(view: EditorView): HTMLElement | null {
  try {
    const domAt = view.domAtPos(view.state.selection.from);
    const startEl =
      domAt.node instanceof HTMLElement ? domAt.node : domAt.node.parentElement;
    if (startEl === null) return null;
    return (
      startEl.closest<HTMLElement>('.tableWrapper') ??
      startEl.closest<HTMLElement>('table')
    );
  } catch {
    return null;
  }
}

export function shouldShowTableToolbar(view: EditorView): boolean {
  if (view.editable === false) {
    return false;
  }
  if (typeof view.hasFocus === 'function' && !view.hasFocus()) {
    return false;
  }
  if (!isInTable(view.state)) {
    return false;
  }
  const { selection } = view.state;
  // Yield to the text selection format-toolbar when dragging across text inside a cell.
  if (!selection.empty && !(selection instanceof CellSelection)) {
    return false;
  }
  return true;
}

function syncTableToolbar(view: EditorView, toolbar: HTMLElement): void {
  if (!shouldShowTableToolbar(view)) {
    toolbar.style.display = 'none';
    return;
  }
  const wrapper = findActiveTableWrapper(view);
  if (wrapper === null || wrapper.offsetParent === null) {
    toolbar.style.display = 'none';
    return;
  }

  const activeAlign = getActiveColumnAlignment(view.state);
  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-table-align]')) {
    const isActive = btn.dataset['tableAlign'] === activeAlign;
    btn.toggleAttribute('data-active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }

  toolbar.style.display = '';
  const tableRect = wrapper.getBoundingClientRect();
  const toolbarRect = toolbar.getBoundingClientRect();
  const scroller =
    view.dom.ownerDocument.getElementById('lightink-editor-area') ??
    view.dom.parentElement;
  const bounds: TableToolbarBox =
    scroller !== null
      ? scroller.getBoundingClientRect()
      : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

  const placement = placeTableToolbar(
    tableRect,
    { width: toolbarRect.width, height: toolbarRect.height },
    bounds,
    { width: window.innerWidth, height: window.innerHeight },
  );
  if (!placement.visible) {
    toolbar.style.display = 'none';
    return;
  }
  toolbar.style.top = `${placement.top}px`;
  toolbar.style.left = `${placement.left}px`;
}

export const tableToolbarPlugin = $prose(() => {
  return new Plugin({
    key: PLUGIN_KEY,
    view(view: EditorView) {
      const toolbar = createTableToolbarElement();
      liveToolbars.add(toolbar);

      const onPointerDown = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      const onClick = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const btn = target.closest('button[data-table-op]');
        if (!(btn instanceof HTMLButtonElement)) return;
        const op = btn.dataset['tableOp'] as TableOpId | undefined;
        if (op === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        runTableOp(view, op);
        syncTableToolbar(view, toolbar);
      };
      const onBlur = (): void => {
        toolbar.style.display = 'none';
      };
      const onReposition = (): void => {
        if (toolbar.style.display !== 'none' || shouldShowTableToolbar(view)) {
          syncTableToolbar(view, toolbar);
        }
      };

      toolbar.addEventListener('mousedown', onPointerDown, true);
      toolbar.addEventListener('click', onClick);
      view.dom.addEventListener('blur', onBlur, true);
      view.dom.addEventListener('focus', onReposition, true);
      window.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
      document.body.appendChild(toolbar);
      syncTableToolbar(view, toolbar);

      return {
        update(nextView) {
          syncTableToolbar(nextView, toolbar);
        },
        destroy() {
          liveToolbars.delete(toolbar);
          toolbar.removeEventListener('mousedown', onPointerDown, true);
          toolbar.removeEventListener('click', onClick);
          view.dom.removeEventListener('blur', onBlur, true);
          view.dom.removeEventListener('focus', onReposition, true);
          window.removeEventListener('scroll', onReposition, true);
          window.removeEventListener('resize', onReposition);
          toolbar.remove();
        },
      };
    },
  });
});
