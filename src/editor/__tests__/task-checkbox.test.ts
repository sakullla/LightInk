// @vitest-environment jsdom

/**
 * Task checklist helpers: detect task items, collect positions, toggle checked.
 * (DOM/widget wiring is covered by plugin factory shape + insert snippet tests.)
 */
import { describe, expect, it } from 'vitest';
import { FOLD_REBUILD_DEBOUNCE_MS } from '../plugins/heading-fold.js';
import { mountEditor } from '../index.js';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import {
  collectTaskItemPositions,
  createTaskCheckboxWidget,
  isTaskListItemNode,
  toggleTaskCheckedTr,
} from '../plugins/task-checkbox.js';
import { getInsertElement } from '../insert-commands.js';

/** Minimal schema mirroring Milkdown list_item + checked attr. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      toDOM: () => ['ul', 0],
    },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        checked: { default: null },
        label: { default: '•' },
        listType: { default: 'bullet' },
        spread: { default: true },
      },
      toDOM: (node) => [
        'li',
        {
          'data-item-type': node.attrs['checked'] == null ? 'bullet' : 'task',
          'data-checked':
            node.attrs['checked'] == null ? undefined : String(node.attrs['checked']),
        },
        0,
      ],
      parseDOM: [{ tag: 'li' }],
    },
  },
});

function makeDoc(
  items: Array<{ text: string; checked: boolean | null }>,
): EditorState {
  const listItems = items.map((item) =>
    schema.nodes.list_item!.create(
      {
        checked: item.checked,
        label: '•',
        listType: 'bullet',
        spread: true,
      },
      schema.nodes.paragraph!.create(null, item.text ? schema.text(item.text) : undefined),
    ),
  );
  const list = schema.nodes.bullet_list!.create(null, listItems);
  const doc = schema.nodes.doc!.create(null, list);
  return EditorState.create({ doc, schema });
}

describe('isTaskListItemNode', () => {
  it('true only when checked is boolean', () => {
    const state = makeDoc([
      { text: 'plain', checked: null },
      { text: 'open', checked: false },
      { text: 'done', checked: true },
    ]);
    const positions = collectTaskItemPositions(state.doc);
    // plain bullet excluded
    expect(positions).toHaveLength(2);
    expect(positions[0]!.checked).toBe(false);
    expect(positions[1]!.checked).toBe(true);

    let plainPos = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'list_item' && node.attrs['checked'] === null) {
        plainPos = pos;
      }
    });
    expect(plainPos).toBeGreaterThanOrEqual(0);
    expect(isTaskListItemNode(state.doc.nodeAt(plainPos)!)).toBe(false);
  });
});

describe('toggleTaskCheckedTr', () => {
  it('flips false → true and true → false', () => {
    const state = makeDoc([
      { text: 'open', checked: false },
      { text: 'done', checked: true },
    ]);
    const [open, done] = collectTaskItemPositions(state.doc);
    expect(open).toBeDefined();
    expect(done).toBeDefined();

    const trOpen = toggleTaskCheckedTr(state, open!.pos);
    expect(trOpen).not.toBeNull();
    const afterOpen = state.apply(trOpen!);
    expect(afterOpen.doc.nodeAt(open!.pos)!.attrs['checked']).toBe(true);

    const trDone = toggleTaskCheckedTr(state, done!.pos);
    expect(trDone).not.toBeNull();
    const afterDone = state.apply(trDone!);
    expect(afterDone.doc.nodeAt(done!.pos)!.attrs['checked']).toBe(false);
  });

  it('returns null for plain list items and bad positions', () => {
    const state = makeDoc([{ text: 'plain', checked: null }]);
    let plainPos = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'list_item') plainPos = pos;
    });
    expect(toggleTaskCheckedTr(state, plainPos)).toBeNull();
    expect(toggleTaskCheckedTr(state, 9999)).toBeNull();
  });
});

describe('task checkbox keyboard widget', () => {
  it('is tabbable and toggles once on Space', () => {
    let state = makeDoc([{ text: 'open', checked: false }]);
    const item = collectTaskItemPositions(state.doc)[0]!;
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: ReturnType<typeof toggleTaskCheckedTr>) {
        state = state.apply(tr!);
      },
    };
    const button = createTaskCheckboxWidget(false, item.pos, () => view as never);
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute('role')).toBe('checkbox');

    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(state.doc.nodeAt(item.pos)!.attrs['checked']).toBe(true);
  });
});

describe('task-list insert default', () => {
  it('inserts a multi-item GFM checklist (not a plain bullet)', () => {
    const el = getInsertElement('task-list');
    expect(el).toBeDefined();
    const snippet = el!.snippet();
    expect(snippet).toMatch(/^- \[ \] /m);
    expect(snippet).toMatch(/^- \[x\] /m);
    expect(snippet.split('\n').length).toBeGreaterThanOrEqual(2);
    // Must not be the plain list snippet.
    expect(snippet).not.toBe('- 列表项');
  });
});

function waitForMountRefresh(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FOLD_REBUILD_DEBOUNCE_MS * 2));
}

describe('折叠三角挂载渲染（回归）', () => {
  it('新挂载的编辑器为每个标题渲染折叠三角（无需先折叠一次）', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = await mountEditor(host, {
      initialMarkdown: '# A\n\npara one\n\n## B\n\npara two\n',
    });
    await editor.ready;
    await waitForMountRefresh();
    expect(host.querySelectorAll('.lightink-fold-marker').length).toBe(2);
    await editor.destroy();
    host.remove();
  });
});
