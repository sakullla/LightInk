// @vitest-environment jsdom

/**
 * 标注侧栏（R5）测试：摘录/备注搜索、类型与颜色筛、定位、跳转/改备注/删除；
 * 书内正文搜索仍与标注搜索并存；附笔记弹层 Promise 语义。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnnotationSidebar } from '../annotation-sidebar.js';
import { createMarkdownAnnotationHost } from '../markdown-annotations.js';
import { SEARCH_QUERY_DEBOUNCE_MS } from '../search-panel.js';
import { showNoteDialog } from '../note-dialog.js';
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

function mount() {
  const jumps: string[] = [];
  const removals: string[] = [];
  const edits: string[] = [];
  const sidebar = createAnnotationSidebar({
    t: t as never,
    onJump: (a) => jumps.push(a.id),
    onRemove: (a) => removals.push(a.id),
    onEditNote: (a) => edits.push(a.id),
  });
  document.body.appendChild(sidebar.element);
  sidebar.render(annotations);
  return { sidebar, jumps, removals, edits };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('annotation-sidebar 重做', () => {
  it('默认列出全部标注并显示定位信息；笔记优先显示备注', () => {
    const { sidebar } = mount();
    const items = sidebar.element.querySelectorAll('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(3);

    const textOf = (id: string) =>
      sidebar.element
        .querySelector(`[data-annotation-id="${id}"] .lightink-reader-sidebar-text`)
        ?.textContent;
    expect(textOf('h1')).toBe('pdf 文字'); // highlight 显示 quote
    expect(textOf('n1')).toBe('旧备注'); // note 优先显示 note（不被 quote 遮蔽）
    expect(
      sidebar.element.querySelector(
        '[data-annotation-id="n1"] .lightink-reader-sidebar-quote',
      )?.textContent,
    ).toBe('txt 片段');

    const locations = Array.from(
      sidebar.element.querySelectorAll('.lightink-reader-sidebar-location'),
    ).map((el) => el.textContent);
    expect(locations[0]).toBe(t('annotation.location.page', { page: '3' }));
    expect(locations[1]).toBe(t('reader.chapter', { n: '3' }));
    // txt 无章节定位：不显示 location
    expect(locations).toHaveLength(2);

    // 内联样式迁移锁定：备注搜索框边框改由 CSS 承接
    expect(
      sidebar.element.querySelector<HTMLInputElement>('.lightink-reader-sidebar-note-search-input')
        ?.style.border,
    ).toBe('');
    // 颜色 swatch 仍由内联设置背景色，且带 data-color 钩子
    const swatch = sidebar.element.querySelector<HTMLElement>(
      '[data-annotation-id="h1"] .lightink-reader-sidebar-color',
    )!;
    expect(swatch.style.backgroundColor).not.toBe('');
    expect(swatch.dataset.color).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it('按类型筛选只显示对应标注', () => {
    const { sidebar } = mount();
    const filterButton = (key: string) =>
      Array.from(sidebar.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter')).find(
        (b) => b.textContent === key,
      )!;

    filterButton('annotation.kind.highlight').click();
    let items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    filterButton('annotation.kind.bookmark').click();
    items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('b1');

    filterButton('annotation.filter.all').click();
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
  });

  it('筛选后无匹配显示筛选空态（区别于文档空态）', () => {
    const { sidebar } = mount();
    const noteFilter = Array.from(
      sidebar.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter'),
    ).find((b) => b.textContent === 'annotation.kind.bookmark')!;
    noteFilter.click();
    sidebar.render([annotations[0]!]);
    expect(
      sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent,
    ).toBe('annotation.filter.empty');
    // 文档本身无任何标注时仍是通用空态
    sidebar.render([]);
    expect(
      sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent,
    ).toBe('annotation.empty');
  });

  it('笔记条目有编辑入口，其他类型没有；按钮派发回调', () => {
    const { sidebar, jumps, removals, edits } = mount();
    const byId = (id: string) =>
      sidebar.element.querySelector(`[data-annotation-id="${id}"]`)!;

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

  it('reader search surface lists hits and Escape clears before close', () => {
    const queries: string[] = [];
    const jumps: string[] = [];
    const nav: string[] = [];
    let cleared = 0;
    let closed = 0;
    const sidebar = createAnnotationSidebar({
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
    document.body.appendChild(sidebar.element);
    sidebar.render(annotations);
    // 单输入框 + 分类行：宿主提供搜索时出现「搜索正文」分类
    expect(sidebar.element.querySelector('[data-kind-filter="document"]')).not.toBeNull();
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-search-stack')).not.toBeNull();
    const input = sidebar.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;
    expect(input.placeholder).toBe('annotation.search.placeholder');
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);

    // 输入文本后切到「搜索正文」分类：同一输入框触发正文检索，描述随之切换
    input.value = 'keyword';
    (sidebar.element.querySelector('[data-kind-filter="document"]') as HTMLButtonElement).click();
    expect(queries).toEqual(['keyword']);
    expect(input.placeholder).toBe('reader.search.document');

    sidebar.renderHits([]);
    expect(sidebar.element.classList.contains('is-searching')).toBe(true);
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.empty',
    );
    expect(
      sidebar.element.querySelector<HTMLElement>('.lightink-reader-sidebar-search-status')
        ?.dataset.searchEmpty,
    ).toBe('true');

    sidebar.setSearchQuery('keyword');
    sidebar.renderHits([
      { key: '1:0:7', snippet: 'alpha keyword', location: 'page 1', current: true },
      { key: '2:0:7', snippet: 'keyword again', location: 'page 2', current: false },
    ]);
    expect(sidebar.element.classList.contains('is-searching')).toBe(true);
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(2);
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-search-status')?.textContent).toBe(
      '1/2',
    );
    (sidebar.element.querySelector('[data-search-key="2:0:7"]') as HTMLElement).click();
    expect(jumps).toEqual(['2:0:7']);

    sidebar.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    sidebar.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(nav).toEqual(['next', 'prev']);

    sidebar.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cleared).toBe(1);
    expect(closed).toBe(0);
    expect(sidebar.getSearchQuery()).toBe('');

    // 切回标注分类：清除正文搜索会话并恢复标注列表
    (sidebar.element.querySelector('[data-kind-filter="all"]') as HTMLButtonElement).click();
    expect(cleared).toBe(2);
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
    expect(input.placeholder).toBe('annotation.search.placeholder');

    sidebar.render(annotations);
    sidebar.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
  });

  it('omits the document category when search is not enabled', () => {
    const { sidebar } = mount();
    expect(sidebar.element.querySelector('[data-kind-filter="document"]')).toBeNull();
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-note-search-input')).not.toBeNull();
  });

  it('默认「全部」分类下输入即同时筛选标注并检索正文，命中合并显示', () => {
    const queries: string[] = [];
    const sidebar = createAnnotationSidebar({
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
    document.body.appendChild(sidebar.element);
    sidebar.render(annotations);
    const input = sidebar.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;

    // 默认「全部」分类：标注筛选立即生效，正文检索等输入停顿后再跑。
    vi.useFakeTimers();
    input.value = '旧备注';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queries).toEqual([]);
    expect(
      sidebar.element.querySelector<HTMLElement>('[data-annotation-id="n1"]'),
    ).not.toBeNull();
    vi.advanceTimersByTime(SEARCH_QUERY_DEBOUNCE_MS);
    expect(queries).toEqual(['旧备注']);
    vi.useRealTimers();

    // 正文命中回流后与标注命中合并呈现（不互斥切换）
    sidebar.renderHits([{ key: '1:0:7', snippet: '旧备注 正文命中', location: 'page 1', current: true }]);
    expect(
      sidebar.element.querySelector<HTMLElement>('[data-annotation-id="n1"]'),
    ).not.toBeNull();
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(1);
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-search-status')?.textContent).toBe(
      '1/1',
    );

    // 选中具体类型后只筛标注，不再检索正文
    queries.length = 0;
    (sidebar.element.querySelector('[data-kind-filter="note"]') as HTMLButtonElement).click();
    input.value = '旧备';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queries).toEqual([]);
    sidebar.element.remove();
  });

  it('搜备注或摘录能命中，搜无关词不命中', () => {
    const { sidebar } = mount();
    const input = sidebar.element.querySelector<HTMLInputElement>(
      '.lightink-reader-sidebar-note-search-input',
    )!;

    input.value = '旧备注';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    let items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('n1');

    input.value = 'pdf 文字';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    input.value = '无关词';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sidebar.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(0);
    expect(sidebar.element.querySelector('.lightink-reader-sidebar-empty')?.textContent).toBe(
      'reader.search.empty',
    );
  });

  it('能筛成仅笔记或仅某高亮颜色；缺色视为默认黄', () => {
    const { sidebar } = mount();
    const green = ANNOTATION_COLORS[1]!;
    sidebar.render([
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

    const noteFilter = Array.from(
      sidebar.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter'),
    ).find((b) => b.textContent === 'annotation.kind.note')!;
    noteFilter.click();
    let items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('n1');

    const allKind = Array.from(
      sidebar.element.querySelectorAll<HTMLButtonElement>('[data-kind-filter]'),
    ).find((b) => b.dataset.kindFilter === 'all')!;
    allKind.click();

    const yellow = sidebar.element.querySelector<HTMLButtonElement>(
      `[data-color="${DEFAULT_ANNOTATION_COLOR}"]`,
    )!;
    yellow.click();
    items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(Array.from(items).map((el) => el.dataset.annotationId)).toEqual(['h1']);
    expect(items[0]!.dataset.annotationColor).toBe(DEFAULT_ANNOTATION_COLOR);

    const greenFilter = sidebar.element.querySelector<HTMLButtonElement>(
      `[data-color="${green}"]`,
    )!;
    greenFilter.click();
    items = sidebar.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h-green');
  });

  it('筛选或搜索后仍可跳转、改备注或删除', () => {
    const { sidebar, jumps, removals, edits } = mount();
    const green = ANNOTATION_COLORS[1]!;
    sidebar.render([
      annotations[2]!,
      {
        id: 'h-green',
        kind: 'highlight',
        locator: { format: 'pdf', page: 4, quote: '绿高亮' },
        quote: '绿高亮',
        color: green,
        createdAt: 4,
      },
    ]);

    sidebar.element.querySelector<HTMLButtonElement>(`[data-color="${green}"]`)!.click();
    const greenItem = sidebar.element.querySelector('[data-annotation-id="h-green"]')!;
    (greenItem.querySelector('.lightink-reader-sidebar-jump') as HTMLElement).click();
    (greenItem.querySelector('.lightink-reader-sidebar-remove') as HTMLElement).click();
    expect(jumps).toEqual(['h-green']);
    expect(removals).toEqual(['h-green']);

    sidebar.element.querySelector<HTMLButtonElement>('[data-color="all"]')!.click();
    const noteFilter = Array.from(
      sidebar.element.querySelectorAll<HTMLButtonElement>('[data-kind-filter]'),
    ).find((b) => b.dataset.kindFilter === 'note')!;
    noteFilter.click();
    const noteItem = sidebar.element.querySelector('[data-annotation-id="n1"]')!;
    (noteItem.querySelector('.lightink-reader-sidebar-edit') as HTMLElement).click();
    expect(edits).toEqual(['n1']);
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
    expect(payload.version).toBe(2);
    expect(payload.annotations).toHaveLength(1);
    expect((payload.annotations[0] as { kind: string }).kind).toBe('bookmark');

    view.destroy();
  });
});
