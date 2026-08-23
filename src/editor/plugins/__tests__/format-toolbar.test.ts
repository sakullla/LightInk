/**
 * format-toolbar 纯逻辑测试（R7）：工具目录与放置决策。
 *
 * 不覆盖（需挂载编辑器/DOM）：工具条 DOM 显隐、coordsAtPos 定位、点击 toggleMark/addMark
 * —— 属编辑器集成面，同既有插件仅断言工厂形态。
 */
import { describe, expect, it } from 'vitest';

import { AllSelection, EditorState, NodeSelection, TextSelection } from '@milkdown/prose/state';
import { Schema } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';

import {
  FORMAT_TOOLS,
  formatToolbarPlugin,
  placeToolbar,
  shouldShowFormatToolbar,
} from '../format-toolbar.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    image: { group: 'block', atom: true, selectable: true },
    text: { inline: true },
  },
});

function viewOf(state: EditorState, focused: boolean): EditorView {
  return { hasFocus: () => focused, state } as EditorView;
}

describe('FORMAT_TOOLS catalog (R7)', () => {
  it('exposes the five format tools in display order', () => {
    expect(FORMAT_TOOLS.map((t) => t.id)).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'code',
      'link',
      'highlight',
      'note',
      'copy',
    ]);
  });

  it('maps each tool to its Milkdown schema mark name', () => {
    const byId = Object.fromEntries(FORMAT_TOOLS.map((t) => [t.id, t.markName]));
    expect(byId.bold).toBe('strong');
    expect(byId.italic).toBe('emphasis');
    expect(byId.strikethrough).toBe('strike_through');
    expect(byId.code).toBe('inlineCode');
    expect(byId.link).toBe('link');
  });

  it('every tool has a non-empty label and title', () => {
    for (const tool of FORMAT_TOOLS) {
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });
});

describe('placeToolbar placement decision (R7)', () => {
  const size = { width: 200, height: 40 };
  const viewport = { width: 1000, height: 800 };

  it('places above the selection anchor when there is room', () => {
    const p = placeToolbar({ top: 200, bottom: 220, left: 500 }, size, viewport);
    // 上方：200 - 40 - 6 = 154
    expect(p.top).toBe(154);
    // 居中于起点：500 - 100 = 400
    expect(p.left).toBe(400);
  });

  it('flips below the selection bottom when not enough room above', () => {
    const p = placeToolbar({ top: 20, bottom: 40, left: 500 }, size, viewport);
    // 上方 20-40-6=-26 < 0 → 放到选区末行底部以下：bottom + gap = 40 + 6 = 46
    // （不压住所选首行）
    expect(p.top).toBe(46);
  });

  it('clamps left within the viewport (near right edge)', () => {
    const p = placeToolbar({ top: 200, bottom: 220, left: 990 }, size, viewport);
    // 居中 990-100=890；maxLeft=1000-6-200=794 → 夹到 794
    expect(p.left).toBe(794);
  });

  it('clamps left to the gap when anchor is near the left edge', () => {
    const p = placeToolbar({ top: 200, bottom: 220, left: 10 }, size, viewport);
    // 居中 10-100=-90 → 夹到 gap=6
    expect(p.left).toBe(6);
  });

  it('respects a custom gap', () => {
    const p = placeToolbar({ top: 200, bottom: 220, left: 500 }, size, viewport, 20);
    // 上方 200-40-20=140
    expect(p.top).toBe(140);
  });
});

describe('shouldShowFormatToolbar', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);

  it('hides when the editor is not focused or the caret is empty', () => {
    const selected = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const caret = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 1),
    });
    expect(shouldShowFormatToolbar(viewOf(selected, false))).toBe(false);
    expect(shouldShowFormatToolbar(viewOf(caret, true))).toBe(false);
  });

  it('shows for a focused text range and a user select-all', () => {
    const selected = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const all = EditorState.create({
      schema,
      doc,
      selection: new AllSelection(doc),
    });
    expect(shouldShowFormatToolbar(viewOf(selected, true))).toBe(true);
    expect(shouldShowFormatToolbar(viewOf(all, true))).toBe(true);
  });

  it('hides for a node selection so open-file first-block select does not float the bar', () => {
    const imageDoc = schema.node('doc', null, [schema.node('image')]);
    const state = EditorState.create({
      schema,
      doc: imageDoc,
      selection: NodeSelection.create(imageDoc, 0),
    });
    expect(shouldShowFormatToolbar(viewOf(state, true))).toBe(false);
  });
});

describe('formatToolbarPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(formatToolbarPlugin).toBeDefined();
    expect(typeof formatToolbarPlugin).toBe('function');
    const shaped = formatToolbarPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });
});
