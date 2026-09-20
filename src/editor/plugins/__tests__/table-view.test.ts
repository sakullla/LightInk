// @vitest-environment jsdom

/**
 * Table nodeView: unique `.tableWrapper` around `table > tbody`, no colwidth.
 */

import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { DecorationSet } from '@milkdown/prose/view';

import { mountEditor } from '../../index.js';
import {
  createTableNodeView,
  TABLE_WRAPPER_CLASS,
  tableViewPlugin,
} from '../table-view.js';

const TABLE_MD = [
  '| 模块 | 对齐 | 优先级 |',
  '| --- | :---: | ---: |',
  '| 前端 | 居中 | 高 |',
  '',
].join('\n');

const tableSchema = new Schema({
  nodes: {
    doc: { content: 'table' },
    table: { content: 'table_row+', toDOM: () => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', toDOM: () => ['tr', 0] },
    table_cell: { content: 'text*', toDOM: () => ['td', 0] },
    text: {},
  },
});

describe('tableViewPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(tableViewPlugin).toBeDefined();
    expect(typeof tableViewPlugin).toBe('function');
    const shaped = tableViewPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    expect(shaped.plugin()).toBeUndefined();
  });
});

function makeTableNode() {
  const cell = tableSchema.nodes['table_cell']!.create();
  const row = tableSchema.nodes['table_row']!.create(null, cell);
  return tableSchema.nodes['table']!.create(null, row);
}

describe('createTableNodeView', () => {
  it('wraps a single .tableWrapper around table > tbody and has no colgroup', () => {
    const nv = createTableNodeView(makeTableNode());
    const dom = nv.dom as HTMLElement;

    expect(dom.tagName).toBe('DIV');
    expect(dom.className).toBe(TABLE_WRAPPER_CLASS);
    expect(dom.querySelectorAll('.tableWrapper')).toHaveLength(0);

    const table = dom.querySelector('table');
    expect(table).not.toBeNull();
    expect(table!.parentElement).toBe(dom);
    expect(nv.contentDOM).toBe(table!.querySelector('tbody'));
    expect(nv.contentDOM?.tagName).toBe('TBODY');
    expect(table!.querySelector('colgroup')).toBeNull();
  });

  it('update accepts the same table type and rejects another', () => {
    const table = makeTableNode();
    const nv = createTableNodeView(table);
    expect(nv.update?.(table, [], DecorationSet.empty)).toBe(true);
    expect(nv.update?.(tableSchema.nodes['table_cell']!.create(), [], DecorationSet.empty)).toBe(
      false,
    );
  });
});

describe('mountEditor table display', () => {
  async function mount(initialMarkdown: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = await mountEditor(host, { initialMarkdown });
    await editor.ready;
    return { host, editor };
  }

  it('renders one .tableWrapper with an inner table and keeps GFM cells', async () => {
    const { host, editor } = await mount(TABLE_MD);
    try {
      const wrappers = host.querySelectorAll('.tableWrapper');
      expect(wrappers).toHaveLength(1);
      const wrapper = wrappers[0] as HTMLElement;
      expect(wrapper.querySelectorAll('.tableWrapper')).toHaveLength(0);

      const table = wrapper.querySelector(':scope > table');
      expect(table).not.toBeNull();
      expect(table!.querySelector('tbody')).not.toBeNull();
      expect(table!.querySelector('colgroup')).toBeNull();
      expect(host.querySelectorAll('th').length).toBeGreaterThan(0);
      expect(host.querySelectorAll('td').length).toBeGreaterThan(0);
      expect(
        host.querySelector('[style*="text-align: center"]'),
      ).not.toBeNull();
      expect(host.querySelector('[style*="text-align: right"]')).not.toBeNull();
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('round-trips markdown without colwidth and keeps alignment markers', async () => {
    const { host, editor } = await mount(TABLE_MD);
    try {
      const out = editor.getMarkdown();
      expect(out).toContain('模块');
      expect(out).toContain('前端');
      expect(out).not.toMatch(/colwidth/i);
      expect(out).not.toMatch(/colgroup/i);
      expect(out).toMatch(/:-:/);
      expect(out).toMatch(/--:/);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('keeps the wrapper after insert-col and still writes no colwidth', async () => {
    const { host, editor } = await mount(TABLE_MD);
    try {
      expect(editor.isInTable()).toBe(true);
      expect(editor.runTableOp('insert-col-right')).toBe(true);
      expect(host.querySelectorAll('.tableWrapper')).toHaveLength(1);
      expect(host.querySelector('.tableWrapper > table tbody')).not.toBeNull();
      expect(editor.getMarkdown()).not.toMatch(/colwidth/i);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });
});
