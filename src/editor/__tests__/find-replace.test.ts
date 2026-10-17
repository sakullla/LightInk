/**
 * 查找与替换（T4 / R2）纯逻辑与插件行为测试（headless，无 DOM）。
 *
 * 覆盖：
 *   - collectMatches / collectSourceMatches：大小写不敏感、多段落、空查询、无命中；
 *   - nextMatchIndex 环形步进；
 *   - 插件状态：query meta 收集命中 + decoration（全部命中 + 当前命中独立样式）、
 *     文档变更后命中重收、清空查询移除 decoration；
 *   - 事务构建器：findQueryTr 选中首命中、stepMatchTr 环形移动、
 *     replaceCurrentTr 单事务替换当前命中、replaceAllTr 单事务替换全部命中；
 *   - 可撤销：replaceAllTr 经 prosemirror-history 一次 undo 回到替换前。
 *
 * 面板 DOM 渲染依赖浏览器，不在 node 环境覆盖（同 toc 插件约定）。
 */
import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, type Transaction } from '@milkdown/prose/state';
import { history, undo } from '@milkdown/prose/history';

import {
  FIND_MATCH_CLASS,
  FIND_MATCH_CURRENT_CLASS,
  FIND_REPLACE_PLUGIN_KEY,
  collectMatches,
  collectSourceMatches,
  computeFindPanelPin,
  createFindReplaceProsePlugin,
  findQueryTr,
  nextMatchIndex,
  replaceAllTr,
  replaceCurrentTr,
  stepMatchTr,
} from '../plugins/find-replace.js';

/** Minimal schema mirroring Milkdown doc/paragraph/heading. */
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
      toDOM: (node) => [`h${String(node.attrs['level'])}`, 0],
    },
    text: { group: 'inline' },
  },
});

type BlockSpec =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string };

function makeState(blocks: BlockSpec[], withPlugin = true, withHistory = false): EditorState {
  const nodes = blocks.map((block) => {
    if (block.kind === 'h') {
      return schema.nodes.heading!.create(
        { level: block.level },
        block.text === '' ? undefined : schema.text(block.text),
      );
    }
    return schema.nodes.paragraph!.create(
      null,
      block.text === '' ? undefined : schema.text(block.text),
    );
  });
  const doc = schema.nodes.doc!.create(null, nodes);
  return EditorState.create({
    doc,
    schema,
    plugins: [
      ...(withPlugin ? [createFindReplaceProsePlugin()] : []),
      ...(withHistory ? [history()] : []),
    ],
  });
}

function pluginState(state: EditorState) {
  const fr = FIND_REPLACE_PLUGIN_KEY.getState(state);
  if (fr === undefined) throw new Error('find-replace plugin state missing');
  return fr;
}

function applyTr(state: EditorState, tr: Transaction): EditorState {
  return state.apply(tr);
}

describe('collectMatches', () => {
  it('collects case-insensitive matches across text nodes in document order', () => {
    const state = makeState([
      { kind: 'h', level: 1, text: 'Hello 标题' },
      { kind: 'p', text: 'say hello and HELLO again' },
      { kind: 'p', text: 'none here' },
    ]);
    const matches = collectMatches(state.doc, 'hello');
    expect(matches).toHaveLength(3);
    for (const match of matches) {
      expect(state.doc.textBetween(match.from, match.to).toLowerCase()).toBe('hello');
    }
    // 文档顺序：from 递增。
    expect(matches[0]!.from).toBeLessThan(matches[1]!.from);
    expect(matches[1]!.from).toBeLessThan(matches[2]!.from);
  });

  it('returns empty for empty query or no hits', () => {
    const state = makeState([{ kind: 'p', text: '正文内容' }]);
    expect(collectMatches(state.doc, '')).toEqual([]);
    expect(collectMatches(state.doc, '不存在')).toEqual([]);
  });

  it('does not overlap matches within one text node', () => {
    const state = makeState([{ kind: 'p', text: 'aaaa' }]);
    expect(collectMatches(state.doc, 'aa')).toHaveLength(2);
  });
});

describe('collectSourceMatches', () => {
  it('collects case-insensitive ranges on plain text', () => {
    const matches = collectSourceMatches('Foo bar FOO baz', 'foo');
    expect(matches).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('returns empty for empty query', () => {
    expect(collectSourceMatches('text', '')).toEqual([]);
  });
});

describe('nextMatchIndex', () => {
  it('wraps around in both directions', () => {
    expect(nextMatchIndex(3, 2, 1)).toBe(0);
    expect(nextMatchIndex(3, 0, -1)).toBe(2);
    expect(nextMatchIndex(3, 1, 1)).toBe(2);
  });

  it('handles empty list and out-of-range active', () => {
    expect(nextMatchIndex(0, -1, 1)).toBe(-1);
    expect(nextMatchIndex(3, -1, 1)).toBe(0);
    expect(nextMatchIndex(3, 5, -1)).toBe(2);
  });
});

describe('find-replace prose plugin state', () => {
  it('starts empty (no query, no decorations)', () => {
    const state = makeState([{ kind: 'p', text: 'hello' }]);
    const fr = pluginState(state);
    expect(fr.query).toBe('');
    expect(fr.matches).toEqual([]);
    expect(fr.decorations.find()).toEqual([]);
  });

  it('query meta collects matches, highlights all, marks the first as current', () => {
    let state = makeState([
      { kind: 'p', text: 'foo one' },
      { kind: 'p', text: 'foo two foo' },
    ]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    const fr = pluginState(state);
    expect(fr.query).toBe('foo');
    expect(fr.matches).toHaveLength(3);
    expect(fr.active).toBe(0);

    const decorations = fr.decorations.find();
    expect(decorations).toHaveLength(3);
    // prosemirror-view  typings 不公开 Decoration.type，运行时存在；此处仅取 class 断言。
    const classes = decorations.map((d) =>
      String((d as unknown as { type: { attrs: Record<string, unknown> } }).type.attrs['class']),
    );
    expect(classes[0]).toBe(`${FIND_MATCH_CLASS} ${FIND_MATCH_CURRENT_CLASS}`);
    expect(classes[1]).toBe(FIND_MATCH_CLASS);
    expect(classes[2]).toBe(FIND_MATCH_CLASS);
  });

  it('no-match query keeps zero decorations (panel empty state reads total=0)', () => {
    let state = makeState([{ kind: 'p', text: '正文' }]);
    state = applyTr(state, findQueryTr(state, '不存在'));
    const fr = pluginState(state);
    expect(fr.matches).toHaveLength(0);
    expect(fr.active).toBe(-1);
    expect(fr.decorations.find()).toEqual([]);
  });

  it('recomputes matches when the document changes under an active query', () => {
    let state = makeState([{ kind: 'p', text: 'foo' }]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    expect(pluginState(state).matches).toHaveLength(1);

    // 追加一个含命中的段落：命中重收，当前下标保持有效。
    const end = state.doc.content.size;
    state = applyTr(
      state,
      state.tr.insert(end, schema.nodes.paragraph!.create(null, schema.text('foo foo'))),
    );
    const fr = pluginState(state);
    expect(fr.matches).toHaveLength(3);
    expect(fr.active).toBeGreaterThanOrEqual(0);
    expect(fr.decorations.find()).toHaveLength(3);
  });

  it('clearing the query removes all decorations', () => {
    let state = makeState([{ kind: 'p', text: 'foo foo' }]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    expect(pluginState(state).decorations.find()).toHaveLength(2);
    state = applyTr(state, findQueryTr(state, ''));
    const fr = pluginState(state);
    expect(fr.query).toBe('');
    expect(fr.decorations.find()).toEqual([]);
  });
});

describe('transaction builders', () => {
  it('findQueryTr selects the first match', () => {
    const state = makeState([{ kind: 'p', text: 'abc foo xyz' }]);
    const tr = findQueryTr(state, 'foo');
    const next = applyTr(state, tr);
    const match = pluginState(next).matches[0]!;
    expect(next.selection.from).toBe(match.from);
    expect(next.selection.to).toBe(match.to);
  });

  it('stepMatchTr moves the current match and wraps around', () => {
    let state = makeState([{ kind: 'p', text: 'foo foo foo' }]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    expect(pluginState(state).active).toBe(0);

    state = applyTr(state, stepMatchTr(state, 1)!);
    expect(pluginState(state).active).toBe(1);

    state = applyTr(state, stepMatchTr(state, 1)!);
    state = applyTr(state, stepMatchTr(state, 1)!);
    expect(pluginState(state).active).toBe(0); // 环形回到首命中

    state = applyTr(state, stepMatchTr(state, -1)!);
    expect(pluginState(state).active).toBe(2); // 反向环形到末命中
  });

  it('stepMatchTr returns null without matches', () => {
    const state = makeState([{ kind: 'p', text: 'none' }]);
    expect(stepMatchTr(state, 1)).toBeNull();
  });

  it('replaceCurrentTr replaces only the active match in one transaction', () => {
    let state = makeState([{ kind: 'p', text: 'foo bar foo' }]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    const tr = replaceCurrentTr(state, 'qux');
    expect(tr).not.toBeNull();
    state = applyTr(state, tr!);
    expect(state.doc.textContent).toBe('qux bar foo');
    // 替换后命中重收：仅剩一处，当前下标收敛有效。
    const fr = pluginState(state);
    expect(fr.matches).toHaveLength(1);
    expect(fr.active).toBe(0);
  });

  it('replaceCurrentTr returns null without an active match', () => {
    const state = makeState([{ kind: 'p', text: 'foo' }]);
    expect(replaceCurrentTr(state, 'bar')).toBeNull();
  });

  it('replaceAllTr replaces every match in a single transaction', () => {
    let state = makeState([
      { kind: 'p', text: 'foo one foo' },
      { kind: 'h', level: 2, text: 'foo 标题' },
    ]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    const result = replaceAllTr(state, 'baz');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    state = applyTr(state, result!.tr);
    expect(state.doc.textContent).toBe('baz one bazbaz 标题');
    expect(pluginState(state).matches).toHaveLength(0);
  });

  it('replaceAllTr returns null without matches', () => {
    const state = makeState([{ kind: 'p', text: 'none' }]);
    expect(replaceAllTr(state, 'x')).toBeNull();
  });

  it('replace-all is a single undo step back to the original text', () => {
    let state = makeState(
      [{ kind: 'p', text: 'foo one foo' }, { kind: 'p', text: 'foo' }],
      true,
      true,
    );
    const original = state.doc.textContent;
    state = applyTr(state, findQueryTr(state, 'foo'));
    const result = replaceAllTr(state, 'baz');
    state = applyTr(state, result!.tr);
    expect(state.doc.textContent).not.toBe(original);

    // 既有 undo（prosemirror-history）：一次撤销回替换前。
    const dispatched: Transaction[] = [];
    const ok = undo(state, (tr) => dispatched.push(tr));
    expect(ok).toBe(true);
    expect(dispatched).toHaveLength(1);
    state = applyTr(state, dispatched[0]!);
    expect(state.doc.textContent).toBe(original);
  });
});

describe('纸墨工作室 §3.10：命中高亮令牌化', () => {
  it('当前命中用 accent 洗色，其余命中用 highlight 洗色（不再硬编码 rgba）', () => {
    let state = makeState([{ kind: 'p', text: 'foo foo foo' }]);
    state = applyTr(state, findQueryTr(state, 'foo'));
    const decorations = pluginState(state).decorations.find();
    expect(decorations).toHaveLength(3);
    const styles = decorations.map((d) =>
      String((d as unknown as { type: { attrs: Record<string, unknown> } }).type.attrs['style']),
    );
    expect(styles[0]).toContain('var(--lightink-accent)');
    expect(styles[0]).not.toContain('rgba(');
    expect(styles[1]).toContain('var(--lightink-highlight)');
    expect(styles[1]).not.toContain('rgba(');
    expect(styles[2]).toContain('var(--lightink-highlight)');
  });
});

describe('纸墨工作室 §3.10：查找面板钉版心（computeFindPanelPin）', () => {
  it('top 贴编辑区顶缘 +8，right 与版心右缘对齐向内 12px', () => {
    const pin = computeFindPanelPin({
      main: { top: 40, right: 1280 },
      area: { top: 40 },
      host: { right: 900 },
    });
    expect(pin.top).toBe(8);
    expect(pin.right).toBe(1280 - 900 + 12);
  });

  it('版心右缘越出主区时 right 不小于 12（面板不出右边界）', () => {
    const pin = computeFindPanelPin({
      main: { top: 0, right: 500 },
      area: { top: 10 },
      host: { right: 520 },
    });
    expect(pin.right).toBe(12);
    expect(pin.top).toBe(18);
  });

  it('编辑区在主区内偏移（大纲占位）时 top 随之修正', () => {
    const pin = computeFindPanelPin({
      main: { top: 0, right: 1000 },
      area: { top: 24 },
      host: { right: 800 },
    });
    expect(pin.top).toBe(32);
  });
});
