/**
 * 大纲模型测试（node 环境，纯函数）：
 *   - h1-h6 多级标题的层级/文本/序号锚点；
 *   - 无标题、空文档、代码块中的 '#' 行不出现；
 *   - 中文标题、重复标题（锚点互异）、行内格式（粗体/行内代码）文本提取；
 *   - blockquote 内嵌套标题按文档顺序收集（与渲染 DOM 顺序一致）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildOutline,
  filterOutlineItems,
  lastCurrentOutlineIndex,
  leafHeadingAnchors,
  outlineItemIsCurrent,
  outlineLocationFromReader,
  outlineSearchKeyAction,
  outlineSearchKeyIsComposing,
} from '../outline-model.js';

describe('buildOutline', () => {
  it('无标题时返回空数组', () => {
    expect(buildOutline('')).toEqual([]);
    expect(buildOutline('   \n\n  ')).toEqual([]);
    expect(buildOutline('只是普通段落。\n\n- 列表项\n')).toEqual([]);
  });

  it('提取 h1-h6 全部层级并保留文档顺序锚点', () => {
    const md = [
      '# 一级',
      '## 二级',
      '### 三级',
      '#### 四级',
      '##### 五级',
      '###### 六级',
    ].join('\n');
    const items = buildOutline(md);
    expect(items).toEqual([
      { level: 1, text: '一级', anchor: 0 },
      { level: 2, text: '二级', anchor: 1 },
      { level: 3, text: '三级', anchor: 2 },
      { level: 4, text: '四级', anchor: 3 },
      { level: 5, text: '五级', anchor: 4 },
      { level: 6, text: '六级', anchor: 5 },
    ]);
  });

  it('嵌套结构：子标题按文档顺序排列在父标题之后', () => {
    const md = '# 章节一\n\n正文。\n\n## 小节 1.1\n\n## 小节 1.2\n\n# 章节二\n';
    const items = buildOutline(md);
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, '章节一'],
      [2, '小节 1.1'],
      [2, '小节 1.2'],
      [1, '章节二'],
    ]);
    expect(items.map((i) => i.anchor)).toEqual([0, 1, 2, 3]);
  });

  it('中文标题原样保留', () => {
    const items = buildOutline('# 轻墨 LightInk 设计\n\n## 关于「极简」\n');
    expect(items[0]?.text).toBe('轻墨 LightInk 设计');
    expect(items[1]?.text).toBe('关于「极简」');
  });

  it('重复标题文本得到互异的序号锚点', () => {
    const items = buildOutline('# 总结\n\n正文。\n\n# 总结\n');
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe('总结');
    expect(items[1]?.text).toBe('总结');
    expect(items[0]?.anchor).toBe(0);
    expect(items[1]?.anchor).toBe(1);
  });

  it('行内格式（粗体/斜体/行内代码）剥离为纯文本', () => {
    const items = buildOutline('# 这是 **粗体** 与 *斜体* 与 `code()` 混排\n');
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('这是 粗体 与 斜体 与 code() 混排');
  });

  it('代码块与行内代码中的 # 行不产生大纲条目', () => {
    const md = [
      '# 真标题',
      '',
      '```md',
      '# 代码块里的假标题',
      '## 也是假的',
      '```',
      '',
      '段落里有 `# 不是标题` 行内代码。',
      '',
      '## 另一个真标题',
    ].join('\n');
    const items = buildOutline(md);
    expect(items.map((i) => i.text)).toEqual(['真标题', '另一个真标题']);
  });

  it('setext 风格标题（下划线式）同样识别', () => {
    const items = buildOutline('标题一\n=====\n\n标题二\n-----\n');
    expect(items).toEqual([
      { level: 1, text: '标题一', anchor: 0 },
      { level: 2, text: '标题二', anchor: 1 },
    ]);
  });

  it('blockquote 内标题按文档顺序收集（与渲染 DOM 顺序一致）', () => {
    const md = '# 外部\n\n> ## 引用内标题\n\n# 末尾\n';
    const items = buildOutline(md);
    expect(items.map((i) => [i.level, i.text, i.anchor])).toEqual([
      [1, '外部', 0],
      [2, '引用内标题', 1],
      [1, '末尾', 2],
    ]);
  });
});

describe('leafHeadingAnchors', () => {
  it('有更深子标题的标题不是叶子；叶子标题返回其 anchor', () => {
    const items = buildOutline('# A\n\n## A1\n\n### A1a\n\n# B\n\n## B1\n');
    expect([...leafHeadingAnchors(items)].sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it('全部平级标题均为叶子', () => {
    const items = buildOutline('# 一\n\n# 二\n\n# 三\n');
    expect([...leafHeadingAnchors(items)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('单标题为叶子', () => {
    const items = buildOutline('# 唯一\n');
    expect([...leafHeadingAnchors(items)]).toEqual([0]);
  });

  it('空大纲返回空集合', () => {
    expect(leafHeadingAnchors([]).size).toBe(0);
  });
});

describe('outline location and search', () => {
  it('maps reader chapter/page snapshots and matches the current row', () => {
    expect(outlineLocationFromReader({ locationKind: 'chapter', current: 2 })).toEqual({
      chapter: 1,
    });
    expect(outlineLocationFromReader({ locationKind: 'page', current: 4 })).toEqual({
      page: 4,
    });
    expect(outlineLocationFromReader({ locationKind: null, current: 1 })).toEqual({});
    expect(
      outlineItemIsCurrent({ level: 1, text: '一', anchor: 0, chapter: 1 }, { chapter: 1 }),
    ).toBe(true);
    expect(
      outlineItemIsCurrent({ level: 1, text: '一', anchor: 0, page: 4 }, { page: 3 }),
    ).toBe(false);
  });

  it('keeps ancestor headings when filtering nested outline items', () => {
    expect(
      filterOutlineItems(
        [
          { level: 1, text: '开篇', anchor: 0, chapter: 0 },
          { level: 2, text: '白月光', anchor: 1, chapter: 1 },
          { level: 1, text: '终章', anchor: 2, chapter: 2 },
        ],
        '白月',
      ),
    ).toEqual([
      { level: 1, text: '开篇', anchor: 0, chapter: 0 },
      { level: 2, text: '白月光', anchor: 1, chapter: 1 },
    ]);
  });

  it('picks the deepest current row and maps search keys', () => {
    expect(
      lastCurrentOutlineIndex(
        [
          { level: 1, text: '一', anchor: 0, chapter: 1 },
          { level: 2, text: '1.1', anchor: 1, chapter: 1 },
        ],
        { chapter: 1 },
      ),
    ).toBe(1);
    expect(outlineSearchKeyAction('Escape', '白月')).toEqual({ kind: 'clear' });
    expect(outlineSearchKeyAction('Escape', '')).toEqual({ kind: 'dismiss' });
    expect(outlineSearchKeyAction('ArrowDown', '')).toEqual({ kind: 'move', delta: 1 });
    expect(outlineSearchKeyAction('Enter', '')).toEqual({ kind: 'select' });
    expect(outlineSearchKeyAction('a', '')).toBeNull();
    expect(outlineSearchKeyAction('Enter', '', true)).toBeNull();
    expect(outlineSearchKeyAction('Escape', '', true)).toBeNull();
    expect(outlineSearchKeyAction('ArrowDown', '白月', true)).toBeNull();
    expect(outlineSearchKeyIsComposing({ isComposing: true, key: 'Enter' })).toBe(true);
    expect(outlineSearchKeyIsComposing({ key: 'Process' })).toBe(true);
    expect(outlineSearchKeyIsComposing({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(outlineSearchKeyIsComposing({ key: 'Enter' })).toBe(false);
  });
});
