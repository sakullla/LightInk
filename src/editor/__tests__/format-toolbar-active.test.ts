/**
 * 格式条 active 态联动测试（纸墨工作室 §3.10，headless）。
 *
 * 覆盖：
 *   - selectionHasMark：空选区看 storedMarks/$from、非空选区要求区间内全部
 *     文本带该 mark（部分命中不算 active）、未知 mark 名恒 false；
 *   - formatToolActiveStates：目录驱动、标注工具恒 false；
 *   - keyboardToolActiveStates：inline 同 marks 口径、列表/任务列表/引用看祖先。
 */
import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from '@milkdown/prose/model';
import { EditorState, TextSelection } from '@milkdown/prose/state';

import {
  formatToolActiveStates,
  selectionHasMark,
  FORMAT_TOOLS,
} from '../plugins/format-toolbar.js';
import { keyboardToolActiveStates } from '../plugins/keyboard-format-bar.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    bullet_list: { group: 'block', content: 'list_item+' },
    list_item: { content: 'block+', attrs: { checked: { default: null } } },
    blockquote: { group: 'block', content: 'block+' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: {},
    link: {
      attrs: { href: { default: '' } },
      inclusive: false,
    },
  },
});

function para(content: string, marks: string[] = []): PMNode {
  const markTypes = marks.map((name) => schema.marks[name]!.create());
  return schema.nodes.paragraph!.create(null, schema.text(content, markTypes));
}

function stateWithSelection(doc: PMNode, from: number, to?: number): EditorState {
  const tr = EditorState.create({ doc, schema }).tr;
  tr.setSelection(TextSelection.create(tr.doc, from, to ?? from));
  return EditorState.create({ doc: tr.doc, schema, selection: tr.selection });
}

describe('selectionHasMark', () => {
  it('非空选区全部带 mark → active', () => {
    const doc = schema.nodes.doc.create(null, [
      para('加粗文字', ['strong']),
      para('普通文字'),
    ]);
    // 第一段 0..(0+4)。段落内容起点：doc(0) → para 从 1 开始。
    const state = stateWithSelection(doc, 1, 5);
    expect(selectionHasMark(state, 'strong')).toBe(true);
    expect(selectionHasMark(state, 'emphasis')).toBe(false);
  });

  it('区间内存在无 mark 文本节点 → 不 active（部分命中不算）', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text('粗', [schema.marks.strong.create()]),
        schema.text('细'),
      ]),
    ]);
    const state = stateWithSelection(doc, 1, 3);
    expect(selectionHasMark(state, 'strong')).toBe(false);
  });

  it('空选区看 storedMarks', () => {
    const doc = schema.nodes.doc.create(null, [para('字')]);
    const base = EditorState.create({ doc, schema });
    const state = base.apply(
      base.tr.setStoredMarks([schema.marks.emphasis.create()]),
    );
    expect(selectionHasMark(state, 'emphasis')).toBe(true);
    expect(selectionHasMark(state, 'strong')).toBe(false);
  });

  it('未知 mark 名 / 空 mark 名恒 false', () => {
    const doc = schema.nodes.doc.create(null, [para('字')]);
    const state = stateWithSelection(doc, 1, 2);
    expect(selectionHasMark(state, 'nope')).toBe(false);
    expect(selectionHasMark(state, '')).toBe(false);
  });
});

describe('formatToolActiveStates', () => {
  it('marks 工具取选区状态，标注工具（无 mark）恒 false', () => {
    const doc = schema.nodes.doc.create(null, [para('链接字', ['link'])]);
    const state = stateWithSelection(doc, 1, 3);
    const states = formatToolActiveStates(state);
    expect(states['link']).toBe(true);
    expect(states['bold']).toBe(false);
    expect(states['highlight']).toBe(false);
    expect(states['note']).toBe(false);
    expect(states['copy']).toBe(false);
    // 目录完整覆盖（id 不漂移）。
    expect(Object.keys(states).sort()).toEqual(
      FORMAT_TOOLS.map((tool) => tool.id).sort(),
    );
  });
});

describe('keyboardToolActiveStates', () => {
  it('列表/任务列表/引用按光标祖先判定', () => {
    const list = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create({ checked: false }, para('项')),
    ]);
    const doc = schema.nodes.doc.create(null, [list]);
    const inList = stateWithSelection(doc, 4);
    const listStates = keyboardToolActiveStates(inList);
    expect(listStates['list']).toBe(true);
    expect(listStates['task-list']).toBe(true);
    expect(listStates['blockquote']).toBe(false);

    const quoted = schema.nodes.doc.create(null, [
      schema.nodes.blockquote.create(null, [para('引')]),
    ]);
    const inQuote = stateWithSelection(quoted, 3);
    const quoteStates = keyboardToolActiveStates(inQuote);
    expect(quoteStates['blockquote']).toBe(true);
    expect(quoteStates['list']).toBe(false);
  });

  it('普通段落里 inline 态随选区 marks', () => {
    const doc = schema.nodes.doc.create(null, [para('粗体', ['strong'])]);
    const state = stateWithSelection(doc, 1, 3);
    const states = keyboardToolActiveStates(state);
    expect(states['bold']).toBe(true);
    expect(states['italic']).toBe(false);
    expect(states['list']).toBe(false);
  });
});
