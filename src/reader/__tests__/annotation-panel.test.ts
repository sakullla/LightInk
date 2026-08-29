// @vitest-environment jsdom

/**
 * 统一融合标注搜索面板（annotation-panel，R2/R8）测试：
 * 标注列表（文档位置排序）/类型与颜色筛选/同一查询框双语义检索（标注筛 +
 * 正文命中合并）/跳转/编辑备注/删除回调/tombstone 隐藏与空态基线/触屏
 * is-touch-sheet 底栏形态（拖拽把手与关闭）/正文搜索不支持空态（漫画）/
 * Escape 与 dismiss 分层。附笔记弹层 Promise 语义与 Markdown 标注宿主装载。
 */
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

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
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
    const filterButton = (key: string) =>
      Array.from(
        panel.element.querySelectorAll<HTMLButtonElement>('.lightink-reader-sidebar-filter'),
      ).find((b) => b.textContent === key)!;

    filterButton('annotation.kind.highlight').click();
    let items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('h1');

    filterButton('annotation.kind.bookmark').click();
    items = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-sidebar-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.dataset.annotationId).toBe('b1');

    filterButton('annotation.filter.all').click();
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);

    filterButton('annotation.kind.bookmark').click();
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
    (panel.element.querySelector('[data-kind-filter="note"]') as HTMLButtonElement).click();
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
    (panel.element.querySelector('[data-kind-filter="document"]') as HTMLButtonElement).click();
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
    (panel.element.querySelector('[data-kind-filter="all"]') as HTMLButtonElement).click();
    expect(cleared).toBe(2);
    expect(panel.element.querySelectorAll('.lightink-reader-sidebar-item')).toHaveLength(3);
    expect(input.placeholder).toBe('annotation.search.placeholder');

    panel.render(annotations);
    panel.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
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

    (panel.element.querySelector('[data-kind-filter="document"]') as HTMLButtonElement).click();
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
