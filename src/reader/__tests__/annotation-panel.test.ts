// @vitest-environment jsdom

/**
 * 统一融合标注搜索面板（annotation-panel，R2/R8）测试：
 * 标注列表（文档位置排序）/范围 chips（全部/正文/高亮/笔记/书签 + 色点）/
 * 同一查询框双语义检索（标注筛 + 正文命中合并）/跳转/编辑备注/删除回调/
 * tombstone 隐藏与空态基线/触屏 is-touch-sheet 底栏形态（拖拽把手与关闭）/
 * 正文搜索不支持空态（漫画）/ Escape 与 dismiss 分层。附笔记弹层 Promise
 * 语义与 Markdown 标注宿主装载。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnnotationPanel } from '../annotation-panel.js';
import { createMarkdownAnnotationHost } from '../markdown-annotations.js';
import { SEARCH_QUERY_DEBOUNCE_MS } from '../search-panel.js';
import { showNoteDialog } from '../note-dialog.js';
import { createReaderChrome } from '../reader-chrome.js';
import { pinFixedOverlay } from '../reader-chrome-panels.js';
import { SHEET_DRAG_THRESHOLD_PX } from '../../ui/touch/sheet-drag.js';
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  type Annotation,
} from '../annotations.js';

const t = (key: string, vars?: Readonly<Record<string, string>>): string => {
  let text = key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(v);
    }
  }
  return text;
};

const annotations: Annotation[] = [
  {
    id: 'h1',
    kind: 'highlight',
    locator: {
      format: 'pdf',
      page: 3,
      quote: 'pdf 文字',
      anchor: { start: 0, end: 5, quote: 'pdf 文字', prefix: '', suffix: '' },
    },
    quote: 'pdf 文字',
    createdAt: 1,
  },
  {
    id: 'b1',
    kind: 'bookmark',
    locator: {
      format: 'flow',
      chapter: 2,
      start: 0,
      end: 0,
      quote: '',
      prefix: '',
      suffix: '',
    },
    createdAt: 2,
  },
  {
    id: 'n1',
    kind: 'note',
    locator: {
      format: 'text',
      start: 4,
      end: 9,
      quote: 'txt 片段',
      prefix: '',
      suffix: '',
    },
    quote: 'txt 片段',
    note: '旧备注',
    createdAt: 3,
  },
];

function mount(overrides: Record<string, unknown> = {}) {
  const jumps: string[] = [];
  const removals: string[] = [];
  const edits: string[] = [];
  const panel = createAnnotationPanel({
    t: t as never,
    onJump: (a) => jumps.push(a.id),
    onRemove: (a) => removals.push(a.id),
    onEditNote: (a) => edits.push(a.id),
    ...overrides,
  });
  document.body.appendChild(panel.element);
  panel.render(annotations);
  return { panel, jumps, removals, edits };
}

function scopePanel(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('.lightink-reader-sidebar-search-scope')!;
}

function openScope(host: HTMLElement): HTMLElement {
  return scopePanel(host);
}

function scopeOption(host: HTMLElement, filter: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[data-kind-filter="${filter}"]`)!;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-keyboard');
});

describe('annotation-panel 标注列表', () => {
  it('列出全部标注并按文档位置排序；笔记优先显示备注；显示定位', () => {
    const { panel } = mount();
    // 打乱输入顺序（页 5 的高亮先入集合）：列表仍按位置输出。
    panel.render([
      {
        id: 'h-late',
        kind: 'highlight',
        locator: { format: 'pdf', page: 5, quote: '后页' },
        quote: '后页',
        createdAt: 9,
      },
      annotations[0]!,
      {
        id: 'b0',
        kind: 'bookmark',
        locator: { format: 'pdf', page: 2, quote: '' },
        createdAt: 8,
      },
    ]);
    const items = panel.element.querySelectorAll('.lightink-reader-sidebar-item');
    expect(Array.from(items).map((el) => (el as HTMLElement).dataset.annotationId)).toEqual([
      'b0',
      'h1',
      'h-late',
    ]);

    // flow 章节排序：chapter 1 的记录排在 chapter 3 之前。
    panel.render([
      {
        id: 'f3',
        kind: 'bookmark',
        locator: {
          format: 'flow',
          chapter: 3,
          start: 0,
          end: 0,
          quote: '',
          prefix: '',
          suffix: '',
        },
        createdAt: 1,
      },
      {
        id: 'f1',
        kind: 'bookmark',
        locator: {
          format: 'flow',
          chapter: 1,
          start: 9,
          end: 9,
          quote: '',
          prefix: '',
          suffix: '',
        },
        createdAt: 2,
      },
    ]);
    expect(
      Array.from(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).map(
        (el) => (el as HTMLElement).dataset.annotationId,
      ),
    ).toEqual(['f1', 'f3']);

    const { panel: basic } = mount();
    expect(basic.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
    const textOf = (id: string) =>
      basic.element
        .querySelector(`[data-annotation-id="${id}"] .lightink-reader-sidebar-text`)
        ?.textContent;
    expect(textOf('h1')).toBe('pdf 文字'); // highlight 显示 quote
    expect(textOf('n1')).toBe('旧备注'); // note 优先显示 note（不被 quote 遮蔽）
    expect(
      basic.element.querySelector(
        '[data-annotation-id="n1"] .lightink-reader-sidebar-quote',
      )?.textContent,
    ).toBe('txt 片段');

    const locations = Array.from(
      basic.element.querySelectorAll('.lightink-reader-sidebar-location'),
    ).map((el) => el.textContent);
    expect(locations[0]).toBe(t('annotation.location.page', { page: '3' }));
    expect(locations[1]).toBe(t('reader.chapter', { n: '3' }));
    // txt 无章节定位：不显示 location
    expect(locations).toHaveLength(2);

    // 颜色 swatch 由内联设置背景色，且带 data-color 钩子
    const swatch = basic.element.querySelector<HTMLElement>(
      '[data-annotation-id="h1"] .lightink-reader-sidebar-color',
    )!;
    expect(swatch.style.backgroundColor).not.toBe('');
    expect(swatch.dataset.color).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it('tombstone（已删除）记录不出列；全 tombstone 时空态为无标注文案', () => {
    const { panel } = mount();
    panel.render([
      annotations[2]!,
      { ...annotations[0]!, deletedAt: 10, updatedAt: 10 },
    ]);
    expect(
      Array.from(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).map(
        (el) => (el as HTMLElement).dataset.annotationId,
      ),
    ).toEqual(['n1']);

    // 全部记录都是 tombstone：空态用「无标注」基线（修复 T1 审查 P3 失真）。
    panel.render([
      { ...annotations[0]!, deletedAt: 10, updatedAt: 10 },
      { ...annotations[2]!, deletedAt: 11, updatedAt: 11 },
    ]);
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(0);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'annotation.empty',
    );
    expect(panel.element.classList.contains('is-searching')).toBe(false);
  });

  it('按类型筛选只显示对应标注；筛选无匹配显示筛选空态', () => {
    const { panel } = mount();
    expect(panel.element.querySelector('.lightink-reader-sidebar-filters')).toBeNull();
    openScope(panel.element);

    scopeOption(panel.element, 'highlight').click();
    let items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    scopeOption(panel.element, 'bookmark').click();
    items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('b1');

    scopeOption(panel.element, 'all').click();
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);

    scopeOption(panel.element, 'bookmark').click();
    panel.render([annotations[0]!]);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'annotation.filter.empty',
    );
    panel.render([]);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'annotation.empty',
    );
  });

  it('能筛成仅某高亮颜色；缺色视为默认黄', () => {
    const { panel } = mount();
    const green = ANNOTATION_COLORS[1]!;
    panel.render([
      ...annotations,
      {
        id: 'h-green',
        kind: 'highlight',
        locator: {
          format: 'pdf',
          page: 4,
          quote: '绿高亮',
          anchor: { start: 0, end: 3, quote: '绿高亮', prefix: '', suffix: '' },
        },
        quote: '绿高亮',
        color: green,
        createdAt: 4,
      },
    ]);

    openScope(panel.element);
    const yellow = panel.element.querySelector<HTMLButtonElement>(
      `[data-color="${DEFAULT_ANNOTATION_COLOR}"]`,
    )!;
    yellow.click();
    let items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(Array.from(items).map((el) => el.dataset.annotationId)).toEqual(['h1']);
    expect(items[0]!.dataset.annotationColor).toBe(DEFAULT_ANNOTATION_COLOR);

    const greenFilter = panel.element.querySelector<HTMLButtonElement>(
      `[data-color="${green}"]`,
    )!;
    greenFilter.click();
    items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h-green');
  });

  it('选中高亮颜色后再切到笔记，笔记仍列出', () => {
    const { panel } = mount();
    openScope(panel.element);
    panel.element
      .querySelector<HTMLButtonElement>(`[data-color="${DEFAULT_ANNOTATION_COLOR}"]`)!
      .click();
    expect(
      Array.from(
        panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item'),
      ).map((el) => el.dataset.annotationId),
    ).toEqual(['h1']);

    scopeOption(panel.element, 'note').click();
    const items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('n1');
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-sidebar-search-scope-colors')
        ?.hidden,
    ).toBe(true);
  });

  it('笔记条目有编辑入口，其他类型没有；按钮派发跳转/编辑/删除回调', () => {
    const { panel, jumps, removals, edits } = mount();
    const byId = (id: string) =>
      panel.element.querySelector(`[data-annotation-id="${id}"]`)!;

    expect(byId('n1').querySelector('.lightink-reader-sidebar-edit')).not.toBeNull();
    expect(byId('h1').querySelector('.lightink-reader-sidebar-edit')).toBeNull();
    expect(byId('b1').querySelector('.lightink-reader-sidebar-edit')).toBeNull();

    (byId('n1').querySelector('.lightink-reader-sidebar-edit') as HTMLElement).click();
    (byId('h1').querySelector('.lightink-reader-sidebar-jump') as HTMLElement).click();
    (byId('h1').querySelector('.lightink-reader-sidebar-remove') as HTMLElement).click();
    expect(edits).toEqual(['n1']);
    expect(jumps).toEqual(['h1']);
    expect(removals).toEqual(['h1']);

    (byId('b1').querySelector('.lightink-reader-sidebar-text') as HTMLElement).click();
    expect(jumps).toEqual(['h1', 'b1']);

    (byId('n1').querySelector('.lightink-reader-sidebar-text') as HTMLElement).click();
    expect(jumps).toEqual(['h1', 'b1', 'n1']);
    expect(edits).toEqual(['n1', 'n1']);
  });
});

describe('annotation-panel 融合搜索', () => {
  it('「全部」分类下输入即同时筛选标注并检索正文，命中合并显示', () => {
    const queries: string[] = [];
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: (query) => queries.push(query),
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);
    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    expect(input.placeholder).toBe('annotation.search.placeholder');
    expect(panel.element.querySelector('.lightink-reader-sidebar-filters')).toBeNull();
    openScope(panel.element);
    expect(panel.element.querySelector('[data-kind-filter="document"]')).not.toBeNull();

    // 默认「全部」分类：标注筛选立即生效，正文检索等输入停顿后再跑。
    vi.useFakeTimers();
    input.value = '旧备注';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queries).toEqual([]);
    expect(
      panel.element.querySelector<HTMLElement>('[data-annotation-id="n1"]'),
    ).not.toBeNull();
    vi.advanceTimersByTime(SEARCH_QUERY_DEBOUNCE_MS);
    expect(queries).toEqual(['旧备注']);
    vi.useRealTimers();

    // 正文命中回流后与标注命中合并呈现（不互斥切换）
    panel.renderHits([
      { key: '1:0:7', snippet: '旧备注 正文命中', location: 'page 1', current: true },
    ]);
    expect(panel.element.querySelector<HTMLElement>('[data-annotation-id="n1"]')).not.toBeNull();
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(1);
    expect(
      panel.element.querySelector('.lightink-reader-sidebar-search-status')?.textContent,
    ).toBe('1/1');

    // 选中具体类型后只筛标注，不再检索正文
    queries.length = 0;
    scopeOption(panel.element, 'note').click();
    input.value = '旧备';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queries).toEqual([]);
    panel.element.remove();
  });

  it('「搜索正文」分类只检索全书：命中列表/计数/跳转/Enter 步进/切回恢复', () => {
    const queries: string[] = [];
    const jumps: string[] = [];
    const nav: string[] = [];
    let cleared = 0;
    let closed = 0;
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      onClose: () => {
        closed += 1;
      },
      search: {
        onQuery: (query) => queries.push(query),
        onJump: (key) => jumps.push(key),
        onNext: () => nav.push('next'),
        onPrev: () => nav.push('prev'),
        onClear: () => {
          cleared += 1;
        },
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);

    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    input.value = 'keyword';
    openScope(panel.element);
    scopeOption(panel.element, 'document').click();
    expect(queries).toEqual(['keyword']);
    expect(input.placeholder).toBe('reader.search.document');

    panel.renderHits([]);
    expect(panel.element.classList.contains('is-searching')).toBe(true);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.empty',
    );
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-sidebar-search-status')
        ?.dataset.searchEmpty,
    ).toBe('true');

    panel.setSearchQuery('keyword');
    panel.renderHits([
      { key: '1:0:7', snippet: 'alpha keyword', location: 'page 1', current: true },
      { key: '2:0:7', snippet: 'keyword again', location: 'page 2', current: false },
    ]);
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(2);
    expect(
      panel.element.querySelector('.lightink-reader-sidebar-search-status')?.textContent,
    ).toBe('1/2');
    (panel.element.querySelector('[data-search-key="2:0:7"]') as HTMLElement).click();
    expect(jumps).toEqual(['2:0:7']);

    panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    panel.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(nav).toEqual(['next', 'prev']);

    panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cleared).toBe(1);
    expect(closed).toBe(0);
    expect(panel.getSearchQuery()).toBe('');

    // 切回标注分类：清除正文搜索会话并恢复标注列表
    openScope(panel.element);
    scopeOption(panel.element, 'all').click();
    expect(cleared).toBe(2);
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
    expect(input.placeholder).toBe('annotation.search.placeholder');

    panel.render(annotations);
    panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
  });

  it('正文模式：扫描分批发布做增量渲染，已有命中行不重建（点击不因重建落空）', () => {
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
        onLoadMore: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render([]);
    openScope(panel.element);
    scopeOption(panel.element, 'document').click();
    panel.setSearchQuery('keyword');

    panel.renderHits(
      [{ key: '0:0:0:7', snippet: 'keyword one', location: 'Chapter 1', current: true }],
      { searching: true, hasMore: true },
    );
    const first = panel.element.querySelector('[data-search-key="0:0:0:7"]');
    expect(first).not.toBeNull();
    expect(
      panel.element.querySelector('.lightink-reader-sidebar-more button')?.textContent,
    ).toBe('reader.search.searching');

    // 追加批：前缀行复用同一节点（按下中的点击不被 replaceChildren 打断）。
    panel.renderHits(
      [
        { key: '0:0:0:7', snippet: 'keyword one', location: 'Chapter 1', current: true },
        { key: '1:0:0:7', snippet: 'keyword two', location: 'Chapter 2', current: false },
      ],
      { searching: true, hasMore: true },
    );
    expect(panel.element.querySelector('[data-search-key="0:0:0:7"]')).toBe(first);
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(2);

    // 完成批 + current 迁移：仍复用节点，只校正 is-current 类名。
    panel.renderHits([
      { key: '0:0:0:7', snippet: 'keyword one', location: 'Chapter 1', current: false },
      { key: '1:0:0:7', snippet: 'keyword two', location: 'Chapter 2', current: true },
    ]);
    expect(panel.element.querySelector('[data-search-key="0:0:0:7"]')).toBe(first);
    expect(first!.classList.contains('is-current')).toBe(false);
    expect(
      panel.element
        .querySelector('[data-search-key="1:0:0:7"]')
        ?.classList.contains('is-current'),
    ).toBe(true);
    expect(panel.element.querySelector('.lightink-reader-sidebar-more')).toBeNull();

    // 查询变化 key 全换：从失配处整段重建。
    panel.renderHits([
      { key: '0:0:2:5', snippet: 'other', location: 'Chapter 1', current: true },
    ]);
    expect(panel.element.querySelector('[data-search-key="0:0:0:7"]')).toBeNull();
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(1);
  });

  it('全部范围扫描分批也不重建已有命中行，点结果能跳', () => {
    const jumps: string[] = [];
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: () => undefined,
        onJump: (key) => jumps.push(key),
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
        onLoadMore: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);
    panel.setSearchQuery('宋');
    panel.renderHits(
      [{ key: 'a', snippet: 'one 宋', location: 'Chapter 2', current: true }],
      { searching: true, hasMore: true },
    );
    const first = panel.element.querySelector('[data-search-key="a"]');
    expect(first).not.toBeNull();
    panel.renderHits(
      [
        { key: 'a', snippet: 'one 宋', location: 'Chapter 2', current: true },
        { key: 'b', snippet: 'two 宋', location: 'Chapter 7', current: false },
      ],
      { searching: true, hasMore: true },
    );
    expect(panel.element.querySelector('[data-search-key="a"]')).toBe(first);
    (first as HTMLElement).click();
    expect(jumps).toEqual(['a']);
    panel.element.remove();
  });

  it('点到哪一行就跳哪一行；行被换掉后不拿按下时的旧 key 乱跳', () => {
    const jumps: string[] = [];
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: () => undefined,
        onJump: (key) => jumps.push(key),
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render([]);
    panel.setSearchQuery('宋');
    panel.renderHits([
      { key: 'a', snippet: 'one 宋青书', location: 'Chapter 2', current: true },
      { key: 'b', snippet: 'two 宋卿疏', location: 'Chapter 2', current: false },
    ]);
    const first = panel.element.querySelector('[data-search-key="a"]') as HTMLElement;
    const second = panel.element.querySelector('[data-search-key="b"]') as HTMLElement;
    first.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    second.click();
    expect(jumps).toEqual(['b']);

    first.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    panel.renderHits([{ key: 'z', snippet: 'other 宋', location: 'Chapter 9', current: true }]);
    panel.element.querySelector('.lightink-reader-sidebar-list')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(jumps).toEqual(['b']);
    panel.element.remove();
  });

  it('连续同章命中只在首条展示章节，避免每条都盖 Chapter 标签', () => {
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render([]);
    openScope(panel.element);
    scopeOption(panel.element, 'document').click();
    panel.setSearchQuery('宋');
    panel.renderHits([
      { key: 'a', snippet: 'one 宋', location: 'Chapter 2', current: true },
      { key: 'b', snippet: 'two 宋', location: 'Chapter 2', current: false },
      { key: 'c', snippet: 'three 宋', location: 'Chapter 3', current: false },
    ]);
    const rows = Array.from(
      panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-hit'),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('.lightink-reader-sidebar-location')?.textContent).toBe(
      'Chapter 2',
    );
    expect(rows[1]!.querySelector('.lightink-reader-sidebar-location')).toBeNull();
    expect(rows[2]!.querySelector('.lightink-reader-sidebar-location')?.textContent).toBe(
      'Chapter 3',
    );
    panel.element.remove();
  });

  it('正文范围只换占位符，不改弹窗骨架；清除按钮清词不关面板，命中片段高亮查询词', () => {
    let closed = 0;
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      onClose: () => {
        closed += 1;
      },
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);

    const title = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-sidebar-header span',
    )!;
    expect(title.textContent).toBe('annotation.sidebar');
    expect(panel.element.querySelector('.lightink-reader-sidebar-export')).toBeNull();

    panel.setSearchQuery('命中');
    expect(title.textContent).toBe('annotation.sidebar');
    expect(title.hidden).toBe(false);
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.querySelector('.lightink-reader-sidebar-filters')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-sidebar-search-advanced')).toBeNull();
    expect(scopePanel(panel.element).hidden).toBe(false);
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');

    openScope(panel.element);
    scopeOption(panel.element, 'document').click();
    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    expect(input.placeholder).toBe('reader.search.document');
    expect(title.textContent).toBe('annotation.sidebar');
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');

    panel.renderHits([
      { key: '1:0:2', snippet: '前文 命中 后文', location: 'page 1', current: true },
    ]);
    const mark = panel.element.querySelector('.lightink-reader-sidebar-hit-mark');
    expect(mark?.textContent).toBe('命中');

    panel.setSearchQuery('宋');
    panel.renderHits([
      {
        key: '9:0:2',
        snippet: '变成了宋青书，宋卿疏逐渐醒来',
        location: 'page 1',
        current: true,
        markStart: 3,
        markEnd: 6,
      },
    ]);
    expect(
      Array.from(panel.element.querySelectorAll('.lightink-reader-sidebar-hit-mark')).map(
        (node) => node.textContent,
      ),
    ).toEqual(['宋青书']);

    const clear = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-search-clear',
    )!;
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(panel.getSearchQuery()).toBe('');
    expect(closed).toBe(0);
    expect(clear.hidden).toBe(true);

    openScope(panel.element);
    scopeOption(panel.element, 'all').click();
    expect(title.textContent).toBe('annotation.sidebar');
    expect(input.placeholder).toBe('annotation.search.placeholder');
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');
  });

  it('全部范围下正文检索进行中不闪「无标注」空态，也不改弹窗骨架', () => {
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render([]);
    panel.setSearchQuery('keyword');
    panel.renderHits([], { pending: true });

    expect(panel.element.classList.contains('is-searching')).toBe(true);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')).toBeNull();
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-sidebar-header span')?.hidden,
    ).toBe(false);
  });

  it('omits the document category when search is not enabled and not declared unsupported', () => {
    const { panel } = mount();
    expect(panel.element.querySelector('[data-kind-filter="document"]')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-sidebar-note-search-input')).not.toBeNull();
  });

  it('漫画（正文搜索不支持）：保留「搜索正文」分类并显示不支持空态，标注列表照常', () => {
    const onQuery = vi.fn();
    const { panel } = mount({
      isDocumentSearchUnsupported: () => true,
      search: {
        onQuery,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    panel.render([
      {
        id: 'cbz-b1',
        kind: 'bookmark',
        locator: { format: 'cbz', page: 12 },
        createdAt: 1,
      },
      {
        id: 'cbz-n1',
        kind: 'note',
        locator: { format: 'cbz', page: 4 },
        note: '这页构图',
        createdAt: 2,
      },
    ]);

    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    // 页级书签/笔记列表与筛选照常（按页排序）。
    expect(
      Array.from(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).map(
        (el) => (el as HTMLElement).dataset.annotationId,
      ),
    ).toEqual(['cbz-n1', 'cbz-b1']);

    openScope(panel.element);
    scopeOption(panel.element, 'document').click();
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.unsupported',
    );
    expect(panel.element.classList.contains('is-searching')).toBe(false);

    // 输入不触发正文检索；宿主回灌的命中也不改不支持空态。
    input.value = 'word';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers();
    vi.advanceTimersByTime(SEARCH_QUERY_DEBOUNCE_MS);
    vi.useRealTimers();
    expect(onQuery).not.toHaveBeenCalled();
    panel.renderHits([{ key: '1:0:1', snippet: 'never', location: null, current: true }]);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.unsupported',
    );
    expect(panel.element.classList.contains('is-searching')).toBe(false);
  });

  it('搜备注或摘录能命中，搜无关词显示搜索空态', () => {
    const { panel } = mount();
    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;

    input.value = '旧备注';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    let items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('n1');

    input.value = 'pdf 文字';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    input.value = '无关词';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(0);
    expect(panel.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.empty',
    );
  });
});

describe('annotation-panel 范围 chips', () => {
  it('范围 chips 常显在搜索框下；清空只清查询，不关面板、不改范围', () => {
    let closed = 0;
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      onClose: () => {
        closed += 1;
      },
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);

    expect(panel.element.querySelector('.lightink-reader-sidebar-filters')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-sidebar-colors')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-sidebar-search-advanced')).toBeNull();
    const pill = panel.element.querySelector('.lightink-reader-sidebar-search-pill')!;
    const clear = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-sidebar-search-clear',
    )!;
    expect(pill.contains(clear)).toBe(true);
    expect(clear.hidden).toBe(true);
    const scope = scopePanel(panel.element);
    expect(scope.hidden).toBe(false);
    expect(pill.contains(scope)).toBe(false);
    expect(
      Array.from(scope.querySelectorAll<HTMLButtonElement>('[data-kind-filter]')).map(
        (button) => button.dataset.kindFilter,
      ),
    ).toEqual(['all', 'document', 'highlight', 'note', 'bookmark']);

    const colorsHidden = (): boolean | undefined =>
      scope.querySelector<HTMLElement>('.lightink-reader-sidebar-search-scope-colors')?.hidden;
    expect(colorsHidden()).toBe(false);
    scopeOption(panel.element, 'highlight').click();
    expect(colorsHidden()).toBe(false);
    scopeOption(panel.element, 'note').click();
    expect(colorsHidden()).toBe(true);
    scopeOption(panel.element, 'bookmark').click();
    expect(colorsHidden()).toBe(true);
    scopeOption(panel.element, 'document').click();
    expect(colorsHidden()).toBe(true);
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');

    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    input.value = 'keyword';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clear.hidden).toBe(false);

    clear.click();
    expect(panel.getSearchQuery()).toBe('');
    expect(clear.hidden).toBe(true);
    expect(closed).toBe(0);
    expect(scopeOption(panel.element, 'document').getAttribute('aria-pressed')).toBe('true');
    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(scope.hidden).toBe(false);
  });
});

describe('annotation-panel 触屏 sheet 形态与 Escape 分层', () => {
  function pointerEvent(
    type: string,
    point: { clientX: number; clientY: number },
  ): PointerEvent {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      pointerId: 1,
      pointerType: 'touch',
      clientX: point.clientX,
      clientY: point.clientY,
    });
  }

  function dragHandlePastThreshold(handle: HTMLElement): void {
    if (typeof handle.setPointerCapture !== 'function') {
      Object.defineProperty(handle, 'setPointerCapture', {
        value: () => undefined,
        configurable: true,
      });
    }
    if (typeof handle.releasePointerCapture !== 'function') {
      Object.defineProperty(handle, 'releasePointerCapture', {
        value: () => undefined,
        configurable: true,
      });
    }
    const startY = 10;
    const endY = startY + SHEET_DRAG_THRESHOLD_PX;
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: startY }));
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: endY }));
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: endY }));
  }

  function stubRect(el: HTMLElement, box: { width: number; height: number }): void {
    el.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        width: box.width,
        height: box.height,
        right: box.width,
        bottom: box.height,
        toJSON() {
          return {};
        },
      }) as DOMRect;
  }

  it('pinFixedOverlay 触屏旗标下呈 is-touch-sheet 底栏形态并带真实拖拽把手', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    document.body.append(host);
    const { panel } = mount();
    host.append(panel.element);
    stubRect(host, { width: 390, height: 700 });
    pinFixedOverlay(panel.element, host, { innerWidth: 390, innerHeight: 700 });

    expect(panel.element.classList.contains('is-touch-sheet')).toBe(true);
    expect(panel.element.classList.contains('lightink-reader-annotation-panel')).toBe(true);
    const handle = panel.element.querySelector<HTMLElement>('.lightink-reader-sheet-handle');
    expect(handle).not.toBeNull();
    expect(panel.element.contains(handle!)).toBe(true);
    expect(handle!.hidden).toBe(false);
    expect(handle!.style.pointerEvents === '' || handle!.style.pointerEvents === 'auto').toBe(
      true,
    );
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')).not.toBeNull();
  });

  it('键盘弹起时全页窗口顶缘不下塌，只把底缘抬到键盘上方；摘除 data-keyboard 后回到全页窗口', async () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    document.documentElement.setAttribute('data-keyboard', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    document.body.append(host);
    const { panel } = mount();
    host.append(panel.element);
    stubRect(host, { width: 390, height: 700 });
    pinFixedOverlay(panel.element, host, { innerWidth: 390, innerHeight: 700 });

    expect(panel.element.classList.contains('is-touch-sheet')).toBe(true);
    // 顶缘仍贴视口顶（不让出 safe-top + 4.5rem 的底栏面板 chrome 位），左右铺满。
    expect(panel.element.style.top).toBe('0px');
    expect(panel.element.style.left).toBe('0px');
    expect(panel.element.style.right).toBe('0px');
    expect(panel.element.style.bottom).toBe('var(--lightink-keyboard-inset, 0px)');
    expect(panel.element.style.height).toBe('auto');
    expect(panel.element.style.maxHeight).toBe('none');

    document.documentElement.removeAttribute('data-keyboard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.element.style.top).toBe('0px');
    expect(panel.element.style.bottom).toBe('0px');
    expect(panel.element.style.height).toBe('100dvh');
    expect(panel.element.style.maxHeight).toBe('none');
  });

  it('触屏书内搜索是全页窗口，不改搜索框骨架', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    document.body.append(host);
    const { panel } = mount({
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => undefined,
      },
    });
    host.append(panel.element);
    stubRect(host, { width: 390, height: 700 });
    panel.setSearchQuery('宋');
    pinFixedOverlay(panel.element, host, { innerWidth: 390, innerHeight: 700 });

    expect(panel.element.dataset.searchPage).toBeUndefined();
    expect(panel.element.classList.contains('is-touch-search-page')).toBe(false);
    expect(panel.element.classList.contains('is-touch-sheet')).toBe(true);
    expect(panel.element.style.top).toBe('0px');
    expect(panel.element.style.height).toBe('100dvh');
    expect(panel.element.querySelector('.lightink-reader-sheet-handle')).not.toBeNull();
    expect(panel.element.querySelector('.lightink-reader-sidebar-close')?.textContent).toBe('×');
  });

  it('正文命中是发丝扁平行，不用标注卡片壳', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/annotation-panel.css'), 'utf-8');
    const hitRule = css.match(
      /\.lightink-reader-sidebar-item\.lightink-reader-sidebar-hit\s*\{[^}]*\}/,
    )?.[0];
    expect(hitRule, 'flattened hit row rule').toBeTruthy();
    expect(hitRule).toMatch(/background:\s*transparent/);
    expect(hitRule).toMatch(/border-radius:\s*0/);
    expect(hitRule).toMatch(/box-shadow:\s*none/);
    expect(hitRule).toMatch(/border-bottom:\s*1px solid/);
    expect(css).toMatch(
      /\.lightink-reader-sidebar-item\.lightink-reader-sidebar-hit\.is-current\s*\{[^}]*background:\s*color-mix/,
    );
    const markRule = css.match(/\.lightink-reader-sidebar-hit-mark\s*\{[^}]*\}/)?.[0];
    expect(markRule, 'search hit mark uses a highlighter wash').toBeTruthy();
    expect(markRule).toMatch(/background:\s*#f6d45e/);
    expect(markRule).toMatch(/color:\s*inherit/);
    expect(markRule).not.toMatch(/font-weight:\s*600/);
  });

  it('触屏 sheet CSS：正文命中片段两行截断，一屏可扫多条结果', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/annotation-panel.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader-sidebar\.is-touch-sheet \.lightink-reader-sidebar-hit \.lightink-reader-sidebar-text\s*\{[^}]*-webkit-line-clamp:\s*2/,
    );
    // 色点行：author display:flex 必须被 [hidden] 显式归零。
    expect(css).toMatch(
      /\.lightink-reader-sidebar-search-scope\[hidden\],\s*\.lightink-reader-sidebar-search-scope-colors\[hidden\]\s*\{[^}]*display:\s*none/,
    );
  });

  it('触屏 sheet CSS：列表有最小高度保障且键盘态保留颜色行、压缩固定 chrome', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/annotation-panel.css'), 'utf-8');
    // 列表仍是唯一滚动区，is-touch-sheet 下 min-height 保障 ≥3 行条目。
    const listRule = css.match(
      /\.lightink-reader-sidebar\.is-touch-sheet \.lightink-reader-sidebar-list\s*\{[^}]*\}/,
    )?.[0];
    expect(listRule, 'touch sheet list min-height rule').toBeTruthy();
    const minHeight = listRule!.match(/min-height:\s*([\d.]+)(rem|px)/);
    expect(minHeight, 'touch sheet list declares a min-height').toBeTruthy();
    const minHeightPx = minHeight![2] === 'rem' ? parseFloat(minHeight![1]) * 16 : parseFloat(minHeight![1]);
    expect(minHeightPx).toBeGreaterThanOrEqual(9 * 16 * 0.9);
    // 键盘态：色点行（颜色筛选）必须保持可见，只收紧 header/搜索区。
    expect(css).not.toMatch(
      /html\[data-keyboard\][^{]*\.lightink-reader-sidebar-search-scope-colors\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /html\[data-keyboard\] \.lightink-reader-sidebar\.is-touch-sheet \.lightink-reader-sidebar-header\s*\{[^}]*padding:/,
    );
    // 键盘态压缩不砍 chip 触控目标：data-keyboard 规则内不得出现 <44px 的 min-height。
    const keyboardRules = css.match(/html\[data-keyboard\][^{]*\{[^}]*\}/g) ?? [];
    for (const rule of keyboardRules) {
      const declared = rule.match(/min-height:\s*([\d.]+)px/);
      if (declared !== null) {
        expect(parseFloat(declared[1])).toBeGreaterThanOrEqual(44);
      }
    }
    // D5：死 token 无残留消费；搜索不得再切整页骨架（全页由 is-touch-sheet 几何承担）。
    expect(css).not.toContain('--lightink-reader-sheet-inset');
    expect(css).not.toContain("data-search-page='document'");
    expect(css).toMatch(/\.lightink-reader-sidebar\.is-touch-sheet\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/\.lightink-reader-sidebar\.is-touch-sheet\s*\{[^}]*border-radius:\s*0/);
    expect(css).not.toContain('lightink-reader-sidebar-search-advanced');
    // 窄屏：范围 chips 紧凑常显，查询字段保持 44，清空不撑破字段。
    expect(css).toMatch(
      /@media \(max-width:\s*760px\)[\s\S]*?\.lightink-reader-sidebar-search-scope-option\s*\{[^}]*min-height:\s*36px/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-sidebar-search-pill\s*\{[^}]*min-height:\s*44px/,
    );
    const optionMin = css.match(
      /@media \(max-width:\s*760px\)[\s\S]*?\.lightink-reader-sidebar-search-scope-option[\s\S]*?min-height:\s*([\d.]+)px/,
    );
    expect(optionMin, 'phone scope chip min-height').toBeTruthy();
    expect(parseFloat(optionMin![1])).toBeGreaterThanOrEqual(36);
  });

  it('下拉拖拽把手经关闭按钮关面板（onClose 恰一次）；关闭按钮直点同语义', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    document.body.append(host);
    const onClose = vi.fn();
    const { panel } = mount({ onClose });
    host.append(panel.element);
    stubRect(host, { width: 390, height: 700 });
    pinFixedOverlay(panel.element, host, { innerWidth: 390, innerHeight: 700 });

    const handle = panel.element.querySelector<HTMLElement>('.lightink-reader-sheet-handle')!;
    dragHandlePastThreshold(handle);
    expect(onClose).toHaveBeenCalledTimes(1);

    panel
      .element!.querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('输入框 Escape：有查询先清查询并消费事件；无查询退一层关面板', () => {
    const onClose = vi.fn();
    let cleared = 0;
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      onClose,
      search: {
        onQuery: () => undefined,
        onJump: () => undefined,
        onNext: () => undefined,
        onPrev: () => undefined,
        onClear: () => {
          cleared += 1;
        },
      },
    });
    document.body.appendChild(panel.element);
    panel.render(annotations);
    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    input.value = 'keyword';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const escapeWithValue = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeWithValue);
    expect(escapeWithValue.defaultPrevented).toBe(true);
    expect(panel.getSearchQuery()).toBe('');
    expect(cleared).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    const escapeEmpty = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(escapeEmpty);
    expect(escapeEmpty.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('接入 reader-chrome 返回分层：面板内 Escape 只关面板，不退书不藏 chrome', () => {
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    host.append(page);
    document.body.append(host);

    const returnToShelf = vi.fn();
    const toggleSidebar = vi.fn();
    const onClose = vi.fn();
    const panel = createAnnotationPanel({
      t: t as never,
      onJump: () => undefined,
      onClose,
    });
    panel.render(annotations);
    // 触屏生产接线：面板 portal 到 document.body（mountReaderOverlay），
    // chrome 的宿主级捕获 Escape 看不到层内按键，由面板自行消费。
    document.body.append(panel.element);
    let visible = true;
    panel.element.hidden = false;
    const closePanel = (): boolean => {
      if (!visible) {
        return false;
      }
      visible = false;
      panel.element.hidden = true;
      return true;
    };
    const chrome = createReaderChrome(host, {
      touchMode: true,
      returnToShelf,
      toggleSidebar,
      isSidebarVisible: () => visible,
      isSelectionToolbarVisible: () => false,
      hideSelectionToolbar: () => undefined,
      isOverlayOpen: () => visible,
      dismissOverlay: closePanel,
    });
    chrome.reveal();

    const input = panel.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    input.value = 'keyword';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(panel.getSearchQuery()).toBe('');
    expect(panel.element.hidden).toBe(false);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(chrome.isRevealed()).toBe(true);
    expect(returnToShelf).not.toHaveBeenCalled();
    expect(toggleSidebar).not.toHaveBeenCalled();

    // 重开面板后点正文空白：走 dismissOverlay 链，一次只关面板这一层。
    visible = true;
    panel.element.hidden = false;
    page.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }),
    );
    expect(visible).toBe(false);
    expect(chrome.isRevealed()).toBe(true);
    expect(returnToShelf).not.toHaveBeenCalled();
    chrome.destroy();
  });
});

describe('note-dialog', () => {
  const dialogTextarea = (): HTMLTextAreaElement =>
    document.querySelector<HTMLTextAreaElement>('.lightink-note-textarea')!;

  it('保存解析为输入文本（可空串），取消/Esc 解析 null', async () => {
    const saved = showNoteDialog(document, '初始', { t: t as never });
    const textarea = dialogTextarea();
    expect(textarea.value).toBe('初始');
    expect(document.querySelector('.lightink-note-quote')).toBeNull();
    textarea.value = '新备注';
    (
      document.querySelector<HTMLButtonElement>('.lightink-modal-btn--primary')!
    ).click();
    await expect(saved).resolves.toBe('新备注');
    expect(document.querySelector('.lightink-note-dialog')).toBeNull();

    const cancelled = showNoteDialog(document, '', { t: t as never });
    (
      document.querySelector<HTMLButtonElement>('.lightink-modal-btn--plain')!
    ).click();
    await expect(cancelled).resolves.toBeNull();

    const escaped = showNoteDialog(document, '', { t: t as never });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(escaped).resolves.toBeNull();
  });

  it('传入划选原文时显示引用预览，编辑态用编辑标题', async () => {
    const pending = showNoteDialog(document, '', { t: t as never }, '划选的句子');
    expect(document.querySelector('.lightink-note-quote')?.textContent).toBe('划选的句子');
    expect(document.querySelector('.lightink-note-title')?.textContent).toBe(
      'annotation.noteDialog.title',
    );
    expect(document.querySelector('.lightink-note-label')?.textContent).toBe(
      'annotation.noteDialog.quoteLabel',
    );
    (
      document.querySelector<HTMLButtonElement>('.lightink-modal-btn--plain')!
    ).click();
    await expect(pending).resolves.toBeNull();

    const editing = showNoteDialog(document, '旧备注', { t: t as never, editing: true });
    expect(document.querySelector('.lightink-note-title')?.textContent).toBe(
      'annotation.noteDialog.editTitle',
    );
    (
      document.querySelector<HTMLButtonElement>('.lightink-note-close')!
    ).click();
    await expect(editing).resolves.toBeNull();
  });
});

describe('markdown annotation host load', () => {
  it('treats a failed annotation read as empty and does not notify', async () => {
    const notify = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createMarkdownAnnotationHost(host, {
      t: (key) => key,
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => {
        throw new Error('IPC unavailable');
      },
      writeAnnotations: async () => undefined,
      notify,
    });

    view.syncIdentity(null, 'untitled-1');
    await vi.waitFor(() => {
      expect(notify).not.toHaveBeenCalled();
    });
    expect(view.isAnnotationEnabled()).toBe(true);
    view.destroy();
  });

  it('serializes a bookmark write through the per-identity queue', async () => {
    const writeAnnotations = vi.fn<(contentHash: string, json: string) => Promise<void>>(
      async () => undefined,
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createMarkdownAnnotationHost(host, {
      t: (key) => key,
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => '',
      writeAnnotations,
    });

    view.syncIdentity('/notes/book.md', 'untitled-1');
    await vi.waitFor(() => {
      expect(writeAnnotations).not.toHaveBeenCalled();
    });

    view.addBookmark();
    await vi.waitFor(() => {
      expect(writeAnnotations).toHaveBeenCalledTimes(1);
    });

    const [contentHash, json] = writeAnnotations.mock.calls[0];
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
    const payload = JSON.parse(json) as { version: number; annotations: unknown[] };
    expect(payload.version).toBe(3);
    expect(payload.annotations).toHaveLength(1);
    expect((payload.annotations[0] as { kind: string }).kind).toBe('bookmark');

    view.destroy();
  });
});
