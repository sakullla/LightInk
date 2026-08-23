// @vitest-environment jsdom

/**
 * reader-view 骨架测试：挂载结构（滚动/页两种宿主 + 空态占位）、i18n、销毁移除 DOM。
 * 骨架用例沿用最小 fake document；划选工具栏用例（R3）用 jsdom 真实 DOM。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';
import {
  applyFrameWheelToScroller,
  createFlowRenderer,
  flowFrameContentHeight,
  resolveFlowFrameClick,
  shouldForwardFrameShortcut,
  totalColumnCount,
} from '../flow-renderer.js';
import type { FlowRendererHooks } from '../flow-renderer.js';
import { sessionRemoteImagePolicy } from '../../media/remote-image-policy.js';
import { createSelectionToolbar, toolbarPosition } from '../selection-toolbar.js';
import {
  applyPagedSpreadVars,
  clearPagedSpreadVars,
  pagedSpreadMetrics,
} from '../../ui/reading-layout.js';
import { readerFlowSpreadFromTypography } from '../reader-layout.js';
import { applyReaderTheme } from '../reader-theme.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';

/** 最小 fake 元素：覆盖 createReaderView 用到的 DOM 表面。 */
class FakeEl {
  className = '';
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private ownText = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).filter(Boolean).includes(c),
    add: (c: string): void => {
      if (!this.classList.contains(c)) {
        this.className = this.className === '' ? c : `${this.className} ${c}`;
      }
    },
    toggle: (c: string, force?: boolean): boolean => {
      const on = force ?? !this.classList.contains(c);
      if (on) {
        this.classList.add(c);
      } else if (this.classList.contains(c)) {
        this.className = this.className
          .split(/\s+/)
          .filter((name) => name !== '' && name !== c)
          .join(' ');
      }
      return on;
    },
  };

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    for (const kid of kids) {
      this.appendChild(kid);
    }
  }

  remove(): void {
    if (this.parent !== null) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }

  /** 深度查找首个满足断言的元素（含自身）。 */
  find(pred: (el: FakeEl) => boolean): FakeEl | null {
    if (pred(this)) {
      return this;
    }
    for (const child of this.children) {
      const hit = child.find(pred);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }

  addEventListener(): void {
    /* no-op for reader-view tests（T5 起 reader-view 在 root 上挂 keydown） */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

class FakeDoc {
  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }

  addEventListener(): void {
    /* no-op：reader-view 监听 lightink:font-scale */
  }

  removeEventListener(): void {
    /* no-op */
  }
}

const originalDocument = (globalThis as { document?: unknown }).document;

/** 骨架用例沿用 fake document；工具栏用例（文件尾 describe）用 jsdom 真实 DOM。 */
function useFakeDocument(): void {
  beforeEach(() => {
    (globalThis as { document: unknown }).document = new FakeDoc();
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });
}

function asHost(): HTMLElement {
  return new FakeEl('div') as unknown as HTMLElement;
}

function asFake(el: HTMLElement): FakeEl {
  return el as unknown as FakeEl;
}

describe('createReaderView 骨架', () => {
  useFakeDocument();

  it('挂载滚动/页两种宿主与空态占位', () => {
    const host = asHost();
    createReaderView(host);
    const root = asFake(host).children[0]!;
    expect(root.classList.contains('lightink-reader')).toBe(true);
    expect(root.getAttribute('role')).toBe('document');

    const scroll = root.find((e) => e.dataset.readerHost === 'scroll');
    const pages = root.find((e) => e.dataset.readerHost === 'pages');
    expect(scroll).not.toBeNull();
    expect(pages).not.toBeNull();
    expect(pages!.hidden).toBe(true); // 默认隐藏页模式宿主（T5 激活）

    const empty = root.find((e) => e.classList.contains('lightink-reader-empty'));
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('reader.empty'); // 默认 t 返回 key 本身
  });

  it('空态文案经注入的 t 翻译', () => {
    const host = asHost();
    createReaderView(host, {
      t: (key) => (key === 'reader.empty' ? 'EMPTY_TEXT' : key),
    });
    const root = asFake(host).children[0]!;
    const empty = root.find((e) => e.classList.contains('lightink-reader-empty'));
    expect(empty!.textContent).toBe('EMPTY_TEXT');
  });

  it('destroy 移除视图 DOM', async () => {
    const host = asHost();
    const view = createReaderView(host);
    expect(asFake(host).children).toHaveLength(1);
    await view.destroy();
    expect(asFake(host).children).toHaveLength(0);
  });

  it('多实例独立 root，销毁互不干扰', async () => {
    const host = asHost();
    const a = createReaderView(host);
    const b = createReaderView(host);
    expect(asFake(host).children).toHaveLength(2);
    await a.destroy();
    expect(asFake(host).children).toHaveLength(1);
    await b.destroy();
    expect(asFake(host).children).toHaveLength(0);
  });
});

describe('划选工具栏（selection-toolbar）', () => {
  const buttonByAction = (toolbar: ReturnType<typeof createSelectionToolbar>, action: string) =>
    toolbar.element.querySelector<HTMLButtonElement>(
      `.lightink-reader-selection-action--${action}`,
    );

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('显示高亮/笔记按钮，取消高亮按需出现', () => {
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: () => undefined });
    document.body.appendChild(toolbar.element);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    expect(toolbar.isVisible()).toBe(true);
    expect(buttonByAction(toolbar, 'highlight')!.textContent).toBe('annotation.highlight');
    expect(buttonByAction(toolbar, 'note')!.textContent).toBe('annotation.note');
    expect(buttonByAction(toolbar, 'copy')!.textContent).toBe('annotation.copy');
    expect(buttonByAction(toolbar, 'removeHighlight')!.hidden).toBe(true);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: true });
    expect(buttonByAction(toolbar, 'removeHighlight')!.hidden).toBe(false);
    toolbar.hide();
    expect(toolbar.isVisible()).toBe(false);
  });

  it('点击动作派发回调并隐藏工具栏', () => {
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: (a) => actions.push(a) });
    document.body.appendChild(toolbar.element);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    buttonByAction(toolbar, 'highlight')!.click();
    expect(actions).toEqual(['highlight']);
    expect(toolbar.isVisible()).toBe(false);
  });

  it('exposes color swatches that highlight with the chosen color', () => {
    const actions: Array<{ action: string; color?: string }> = [];
    const toolbar = createSelectionToolbar({
      t: (key) => key,
      onAction: (action, detail) => actions.push({ action, color: detail?.color }),
    });
    document.body.appendChild(toolbar.element);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    const swatches = toolbar.element.querySelectorAll<HTMLButtonElement>(
      '.lightink-reader-selection-color',
    );
    expect(swatches.length).toBeGreaterThanOrEqual(4);
    swatches[1]!.click();
    expect(actions[0]?.action).toBe('highlight');
    expect(actions[0]?.color).toMatch(/^#/);
    expect(toolbar.isVisible()).toBe(false);
  });

  it('点击工具栏外部隐藏且不派发动作', () => {
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: (a) => actions.push(a) });
    document.body.appendChild(toolbar.element);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(toolbar.isVisible()).toBe(false);
    expect(actions).toEqual([]);
  });

  it('工具栏定位：优先选区上方，越顶下移并夹在视口内', () => {
    const rect = { left: 200, top: 300, width: 100, height: 20 };
    const toolbarSize = { width: 160, height: 32 };
    const viewport = { width: 1280, height: 800 };
    // 上方放得下：贴选区上沿。
    expect(toolbarPosition(rect, toolbarSize, viewport)).toEqual({ left: 170, top: 264 });
    // 选区贴近顶部：下移到选区下方。
    expect(toolbarPosition({ ...rect, top: 10 }, toolbarSize, viewport)).toEqual({ left: 170, top: 34 });
    // 视口窄于工具栏：左移被夹在边距。
    expect(toolbarPosition({ left: -50, top: 300, width: 0, height: 20 }, toolbarSize, viewport)).toEqual({
      left: 4,
      top: 264,
    });
  });
});

describe('flowFrameContentHeight', () => {
  it('uses body content height, not a stretched iframe viewport', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 420 });
    Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, value: 100000 });
    doc.documentElement.style.overflow = 'hidden';
    doc.body.style.overflow = 'hidden';
    // jsdom body fontSize 16px → 0.2em 底部安全余量 = 3.2px。
    expect(flowFrameContentHeight(doc)).toBe(Math.ceil(420 + 16 * 0.2));
    expect(doc.documentElement.style.overflow).toBe('hidden');
    expect(doc.body.style.overflow).toBe('hidden');
    iframe.remove();
  });

  it('adds the trailing child margin-bottom that collapses out of scrollHeight', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<div><p>chapter tail</p></div>';
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 420 });
    const view = doc.defaultView!;
    const original = view.getComputedStyle.bind(view);
    vi.spyOn(view, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      // jsdom 对无 border 元素也返回 borderBottomWidth='16px'，与真实浏览器
      // （border-style:none → 0）不符；归一化后仅对末尾 <p> 注入底部边距。
      Object.defineProperty(style, 'borderBottomWidth', { configurable: true, value: '0px' });
      Object.defineProperty(style, 'paddingBottom', { configurable: true, value: '0px' });
      if (el.tagName === 'P') {
        Object.defineProperty(style, 'marginBottom', { configurable: true, value: '17.6px' });
      }
      return style;
    });
    expect(flowFrameContentHeight(doc)).toBe(Math.ceil(420 + 17.6 + 16 * 0.2));
    iframe.remove();
  });

  it('uses the last painted box when scrollHeight misses a wrapped last line', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter tail that wrapped one extra line</p>';
    Object.defineProperty(doc.body, 'scrollHeight', { configurable: true, value: 420 });
    const last = doc.body.lastElementChild as HTMLElement;
    vi.spyOn(doc.documentElement, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 420,
      left: 0,
      right: 400,
      width: 400,
      height: 420,
    } as DOMRect);
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 452,
      left: 0,
      right: 400,
      width: 400,
      height: 452,
    } as DOMRect);
    const view = doc.defaultView!;
    const original = view.getComputedStyle.bind(view);
    vi.spyOn(view, 'getComputedStyle').mockImplementation((el) => {
      const style = original(el);
      Object.defineProperty(style, 'borderBottomWidth', { configurable: true, value: '0px' });
      Object.defineProperty(style, 'paddingBottom', { configurable: true, value: '0px' });
      if (el.tagName === 'P') {
        Object.defineProperty(style, 'marginBottom', { configurable: true, value: '17.6px' });
      }
      return style;
    });
    // 末行折到 scrollHeight 之外（Windows 滚动条槽把栏宽挤窄）：取绘制底边 + 塌陷边距。
    expect(flowFrameContentHeight(doc)).toBe(Math.ceil(452 + 17.6 + 16 * 0.2));
    iframe.remove();
  });
});

describe('shouldForwardFrameShortcut', () => {
  it('forwards reading zoom and fullscreen chords', () => {
    expect(
      shouldForwardFrameShortcut(
        new KeyboardEvent('keydown', { key: '=', ctrlKey: true }),
      ),
    ).toBe(true);
    expect(
      shouldForwardFrameShortcut(
        new KeyboardEvent('keydown', { key: '-', ctrlKey: true }),
      ),
    ).toBe(true);
    expect(
      shouldForwardFrameShortcut(new KeyboardEvent('keydown', { key: 'F11' })),
    ).toBe(true);
    expect(
      shouldForwardFrameShortcut(
        new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it('does not steal in-frame copy or select-all', () => {
    expect(
      shouldForwardFrameShortcut(
        new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldForwardFrameShortcut(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }),
      ),
    ).toBe(false);
  });
});

describe('totalColumnCount', () => {
  it('reverse-computes rendered column count from scrollWidth', () => {
    const columnWidth = 370;
    const gap = 24;
    expect(totalColumnCount(3 * columnWidth + 2 * gap, columnWidth, gap)).toBe(3);
    expect(totalColumnCount(4 * columnWidth + 3 * gap, columnWidth, gap)).toBe(4);
  });

  it('returns 0 for empty/unknown scrollWidth (jsdom, no layout)', () => {
    expect(totalColumnCount(0, 370, 24)).toBe(0);
  });
});

describe('共享翻页布局应用器（T5：markdown 与流式同源）', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('applyPagedSpreadVars 写入 pagedSpreadMetrics 派生的共享列变量', () => {
    const el = document.createElement('div');
    const metrics = pagedSpreadMetrics(1000, 16);
    applyPagedSpreadVars(el, metrics);
    expect(el.style.getPropertyValue('--lightink-reader-column-width')).toBe(
      `${metrics.columnWidth}px`,
    );
    expect(el.style.getPropertyValue('--lightink-reader-column-gap')).toBe(`${metrics.gap}px`);
    expect(el.style.getPropertyValue('--lightink-reader-column-count')).toBe(
      String(metrics.columns),
    );
    clearPagedSpreadVars(el);
    expect(el.style.getPropertyValue('--lightink-reader-column-width')).toBe('');
    expect(el.style.getPropertyValue('--lightink-reader-column-gap')).toBe('');
    expect(el.style.getPropertyValue('--lightink-reader-column-count')).toBe('');
  });

  it('does not let a wrapping EPUB link swallow edge paging or chrome toggles', () => {
    expect(
      resolveFlowFrameClick({
        href: 'https://example.invalid/next',
        clientX: 390,
        viewportWidth: 400,
        paginated: true,
      }),
    ).toEqual({ kind: 'page', direction: 1 });
    expect(
      resolveFlowFrameClick({
        href: 'https://example.invalid/next',
        clientX: 200,
        viewportWidth: 400,
        paginated: true,
      }),
    ).toEqual({ kind: 'surface' });
    expect(
      resolveFlowFrameClick({
        href: '#lightink-chapter?chapter=2',
        clientX: 390,
        viewportWidth: 400,
        paginated: true,
      }),
    ).toEqual({ kind: 'in-book-nav', href: '#lightink-chapter?chapter=2' });
    expect(
      resolveFlowFrameClick({
        href: null,
        clientX: 12,
        viewportWidth: 400,
        paginated: true,
      }),
    ).toEqual({ kind: 'page', direction: -1 });
  });

  it('flow-renderer applyPaginatedDocument 写入阅读页栏变量且 iframe 铺满纸面', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 800 });
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, hooks);

    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    renderer.applyPaginatedDocument(iframe, doc);

    const html = doc.documentElement;
    const metrics = readerFlowSpreadFromTypography(
      1020,
      16,
      DEFAULT_READER_TYPOGRAPHY,
    );
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(html.style.getPropertyValue('--lightink-reader-column-count')).toBe(
      String(metrics.columns),
    );
    expect(pageBox.style.columnCount).toBe(String(metrics.columns));
    expect(pageBox.style.columnWidth).toBe(`${metrics.columnWidth}px`);
    expect(pageBox.style.overflowX).toBe('auto');
    expect(pageBox.style.overflowY).toBe('hidden');
    expect(metrics.columnWidth * metrics.columns + metrics.gap).toBeLessThanOrEqual(1020);
    expect(html.style.getPropertyValue('--lightink-reader-column-width')).toBe(
      `${metrics.columnWidth}px`,
    );
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.border).toMatch(/^0(px)?$/);
    const image = doc.createElement('img');
    const figure = doc.createElement('figure');
    figure.appendChild(image);
    doc.body.appendChild(figure);
    renderer.applyPaginatedDocument(iframe, doc);
    expect(image.style.maxWidth).toBe(`${metrics.columnWidth}px`);
    expect(image.style.maxHeight).toBe(html.style.height);
    expect(image.style.columnSpan).toBe('none');
    expect(image.style.breakBefore).toBe('');
    expect(figure.style.breakInside).toBe('auto');
    iframe.remove();
  });

  it('syncTheme paints iframe paper when the host paper theme changes', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    applyReaderTheme(root, 'white');
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    iframe.className = 'lightink-reader-chapter-frame';
    scrollHost.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    renderer.applyPaginatedDocument(iframe, doc);
    applyReaderTheme(root, 'sepia');
    renderer.syncTheme();
    expect(doc.documentElement.style.getPropertyValue('--lightink-bg')).toMatch(
      /#fbf0d9|rgb\(251,\s*240,\s*217\)/,
    );
    expect(`${doc.documentElement.style.background} ${doc.body.style.background} ${iframe.style.background}`).toMatch(
      /#fbf0d9|rgb\(251,\s*240,\s*217\)/,
    );
    iframe.remove();
    root.remove();
  });

  it('does not shrink the iframe to the text measure on a single-column page', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 520 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 800 });
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    renderer.applyPaginatedDocument(iframe, doc);
    const html = doc.documentElement;
    const page = readerFlowSpreadFromTypography(520, 16, DEFAULT_READER_TYPOGRAPHY);
    expect(page.columns).toBe(1);
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(iframe.style.width).toBe('100%');
    expect(html.style.width).toBe(`${page.width}px`);
    expect(pageBox.style.columnCount).toBe('1');
    expect(pageBox.style.columnWidth).toBe('440px');
    expect(html.style.paddingLeft).toMatch(/^0(px)?$/);
    expect(html.style.paddingRight).toMatch(/^0(px)?$/);
    expect(doc.body.style.maxWidth).toBe('none');
    iframe.remove();
  });

  it('opens two columns when the paged host is wide enough for a spread', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 800 });
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>chapter</p>';
    renderer.applyPaginatedDocument(iframe, doc);
    const html = doc.documentElement;
    const page = readerFlowSpreadFromTypography(1020, 16, DEFAULT_READER_TYPOGRAPHY);
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(page.columns).toBe(2);
    expect(pageBox.style.columnCount).toBe('2');
    expect(pageBox.style.columnWidth).toBe(`${page.columnWidth}px`);
    expect(pageBox.style.width).toBe('1020px');
    expect(iframe.style.width).toBe('100%');
    expect(html.style.width).toBe('1100px');
    expect(pageBox.style.getPropertyValue('--lightink-reader-page-step')).toBe(`${page.step}px`);
    iframe.remove();
  });

  it('lays out a cover-only chapter as one full page, not a left-column image', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 800 });
    const root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 4000 });
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<img src="cover.jpg" alt="cover">';
    renderer.applyPaginatedDocument(iframe, doc);
    const html = doc.documentElement;
    const image = doc.querySelector('img')!;
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(pageBox.style.columnCount).toBe('1');
    expect(pageBox.style.height).toBe('800px');
    expect(html.style.height).toBe('800px');
    expect(image.style.columnSpan).toBe('all');
    expect(Number.parseInt(image.style.maxWidth, 10)).toBeGreaterThan(700);
    expect(image.style.width).toBe(image.style.maxWidth);
    expect(image.style.height).toBe('800px');
    expect(image.style.objectFit).toBe('contain');
    iframe.remove();
    pane.remove();
  });

  it('caps a grown editor pane so a text chapter still paginates inside the window', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 5000 });
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 5000 });
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 5000 });
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>一段足够长的正文，用来确认翻页高度被窗口卡住。</p>'.repeat(40);
    renderer.applyPaginatedDocument(iframe, doc);
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(pageBox.style.height).toBe('720px');
    expect(pageBox.style.columnCount).toBe('2');
    iframe.remove();
    pane.remove();
  });

  it('uses a narrow gutter on compact surfaces so a phone page is not 40px padded', () => {
    document.documentElement.setAttribute('data-android', '');
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 720 });
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 720 });
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 360 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 720 });
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<p>手机正文</p>';
    renderer.applyPaginatedDocument(iframe, doc);
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    const width = Number.parseInt(pageBox.style.width, 10);
    expect(width).toBeGreaterThan(320);
    expect(pageBox.style.columnCount).toBe('1');
    iframe.remove();
    pane.remove();
    document.documentElement.removeAttribute('data-android');
  });

  it('gives consecutive illustration plates a page each so the second is not clipped', () => {
    const hooks: FlowRendererHooks = {
      t: (key) => key,
      remoteImagePolicy: sessionRemoteImagePolicy,
      syncState: () => undefined,
      applyPendingRestore: () => undefined,
      renderHighlights: () => undefined,
      handleNoteMarkClick: () => false,
      onSelectionMouseUp: () => undefined,
      openSearch: () => undefined,
      advanceReading: () => false,
      advancePagedWheel: () => false,
      dismissSelectionToolbar: () => false,
      isLayoutSwitching: () => false,
      scrollContainer: () => document.body,
    };
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 800 });
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, hooks);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.body.innerHTML = '<img src="plate-a.jpg" alt=""><img src="plate-b.jpg" alt="">';
    renderer.applyPaginatedDocument(iframe, doc);
    const images = doc.querySelectorAll('img');
    const pageBox = doc.querySelector<HTMLElement>('.lightink-reader-spread')!;
    expect(pageBox.style.columnCount).toBe('1');
    expect(images[0]?.style.breakBefore).toBe('');
    expect(images[1]?.style.breakBefore).toBe('column');
    expect(images[0]?.style.maxHeight).toBe(pageBox.style.height);
    expect(images[0]?.style.height).toBe(pageBox.style.height);
    expect(images[0]?.style.objectFit).toBe('contain');
    expect(images[0]?.style.marginBottom).toMatch(/^0(px)?$/);
    iframe.remove();
  });
});

describe('翻页模式插图约束', () => {
  it('paginated chrome clamps images to column width, not the full page', () => {
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: '插图', html: '<img src="cover.jpg">' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    expect(frame.srcdoc).toContain('column-span: none');
    expect(frame.srcdoc).toContain(
      'max-width: var(--lightink-reader-column-width, 100%) !important',
    );
    expect(frame.srcdoc).not.toMatch(
      /html\[data-reading-layout='paginated'\] img[\s\S]*?break-before:\s*column/,
    );
  });
});

const flowRendererHooks = (
  overrides: Partial<FlowRendererHooks> = {},
): FlowRendererHooks => ({
  t: (key) => key,
  remoteImagePolicy: sessionRemoteImagePolicy,
  syncState: () => undefined,
  applyPendingRestore: () => undefined,
  renderHighlights: () => undefined,
  handleNoteMarkClick: () => false,
  onSelectionMouseUp: () => undefined,
  openSearch: () => undefined,
  advanceReading: () => false,
  advancePagedWheel: () => false,
  dismissSelectionToolbar: () => false,
  isLayoutSwitching: () => false,
  scrollContainer: () => document.body,
  ...overrides,
});

describe('大型流式书首次渲染预算', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('同步只挂载前八章，空闲计时器不会继续创建全书 iframe', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render(
      Array.from({ length: 40 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        html: `<p>${index + 1}</p>`,
      })),
    );

    expect(scrollHost.querySelectorAll('.lightink-reader-chapter')).toHaveLength(8);
    expect(scrollHost.querySelectorAll('iframe')).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scrollHost.querySelectorAll('.lightink-reader-chapter')).toHaveLength(8);
    expect(scrollHost.querySelectorAll('iframe')).toHaveLength(8);
    renderer.setActiveChapter(30);
    expect(
      scrollHost.querySelector<HTMLElement>('[data-chapter-index="30"]'),
    ).not.toBeNull();
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 28, 29, 30, 31, 32]);
    renderer.clear();
  });

  it('paginated mode keeps a three-chapter window and can page past it', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render(
      Array.from({ length: 40 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        html: `<p>${index + 1}</p>`,
      })),
    );
    renderer.setActiveChapter(0);
    vi.advanceTimersByTime(0);
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([0, 1, 2]);
    expect(
      scrollHost.querySelector<HTMLIFrameElement>(
        '[data-chapter-index="1"] .lightink-reader-chapter-frame',
      )?.srcdoc,
    ).toContain('<p>2</p>');
    vi.advanceTimersByTime(2000);
    expect(scrollHost.querySelectorAll('.lightink-reader-chapter')).toHaveLength(3);
    expect(scrollHost.querySelector('[data-chapter-index="8"]')).toBeNull();

    renderer.setActiveChapter(7);
    vi.advanceTimersByTime(0);
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([5, 6, 7, 8, 9]);
    const moved = renderer.advancePage(1);
    expect(moved).toBe(true);
    expect(
      scrollHost.querySelector('[data-chapter-index="8"]')?.classList.contains('is-active'),
    ).toBe(true);
    expect(scrollHost.querySelector('[data-chapter-index="0"]')).toBeNull();
    renderer.clear();
    vi.useRealTimers();
  });

  it('switching paginated to scroll remounts evicted chapters and continues the spine', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render(
      Array.from({ length: 40 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        html: `<p>${index + 1}</p>`,
      })),
    );
    renderer.setActiveChapter(5);
    vi.advanceTimersByTime(0);
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([3, 4, 5, 6, 7]);
    expect(scrollHost.querySelector('[data-chapter-index="0"]')).toBeNull();
    expect(scrollHost.querySelector('[data-chapter-index="20"]')).toBeNull();

    root.dataset.readingLayout = 'scroll';
    renderer.remasureScrollFrames();
    expect(scrollHost.querySelector('[data-chapter-index="0"]')).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(scrollHost.querySelector('[data-chapter-index="20"]')).toBeNull();
    renderer.clear();
    vi.useRealTimers();
  });

  it('ignores the iframe about:blank load so srcdoc still gets columns and images', async () => {
    const resolveResources = vi.fn(async () => undefined);
    let releaseLoad: (() => void) | undefined;
    const chapter = {
      title: 'Cover',
      html: '',
      load: () =>
        new Promise<void>((resolve) => {
          releaseLoad = () => {
            chapter.html = '<p>正文</p><img src="OEBPS/images/cover.jpg" alt="Cover">';
            resolve();
          };
        }),
      resolveResources,
    };
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([chapter]);
    renderer.setActiveChapter(0);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    expect(frame.dataset.frameBound).toBeUndefined();
    expect(resolveResources).not.toHaveBeenCalled();

    releaseLoad!();
    await Promise.resolve();
    await Promise.resolve();
    expect(frame.srcdoc).toContain('OEBPS/images/cover.jpg');
    frame.dispatchEvent(new Event('load'));
    await vi.waitFor(() => {
      expect(frame.dataset.frameBound).toBe('true');
      expect(resolveResources).toHaveBeenCalled();
    });
    renderer.clear();
  });

  it('materializes packaged images on the active paginated chapter even when IO says hidden', async () => {
    const resolveResources = vi.fn(async () => undefined);
    const OriginalIO = globalThis.IntersectionObserver;
    class HiddenObserver {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element): void {
        this.callback(
          [{ target, isIntersecting: false } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    vi.stubGlobal('IntersectionObserver', HiddenObserver);
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([
      {
        title: 'Cover',
        html: '<img src="OEBPS/images/cover.jpg" alt="Cover">',
        resolveResources,
      },
    ]);
    renderer.setActiveChapter(0);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolveResources).toHaveBeenCalled();
    renderer.clear();
    if (OriginalIO === undefined) {
      vi.unstubAllGlobals();
    } else {
      vi.stubGlobal('IntersectionObserver', OriginalIO);
    }
  });

  it('replaces junk converter titles on the chapter heading', () => {
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: 'ccdqxkhp', html: '<p>正文</p>' }]);
    expect(scrollHost.querySelector('.lightink-reader-chapter-title')?.textContent).toBe(
      'reader.chapter',
    );
    expect(
      scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')?.title,
    ).toBe('reader.chapter');
    renderer.clear();
  });

  it('paginated prefetch materializes images on neighbor chapters before they become active', async () => {
    const resolve0 = vi.fn(async () => undefined);
    const resolve1 = vi.fn(async () => undefined);
    const resolve2 = vi.fn(async () => undefined);
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([
      { title: 'Cover', html: '<img src="a.jpg" alt="">', resolveResources: resolve0 },
      { title: 'Chapter 2', html: '<p>2</p><img src="b.jpg" alt="">', resolveResources: resolve1 },
      { title: 'Chapter 3', html: '<p>3</p><img src="c.jpg" alt="">', resolveResources: resolve2 },
    ]);
    renderer.setActiveChapter(0);
    for (const frame of scrollHost.querySelectorAll('iframe')) {
      frame.dispatchEvent(new Event('load'));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(resolve0).toHaveBeenCalled();
    expect(resolve1).toHaveBeenCalled();
    expect(resolve2).toHaveBeenCalled();
    renderer.clear();
  });

  it('scroll mode does not release mounted chapter images after a jump', async () => {
    const resolve0 = vi.fn(async () => undefined);
    const release0 = vi.fn();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([
      {
        title: 'Chapter 1',
        html: '<img src="a.jpg" alt="">',
        resolveResources: resolve0,
        releaseResources: release0,
      },
      ...Array.from({ length: 39 }, (_, index) => ({
        title: `Chapter ${index + 2}`,
        html: `<p>${index + 2}</p>`,
      })),
    ]);
    const first = scrollHost.querySelector<HTMLIFrameElement>(
      '[data-chapter-index="0"] .lightink-reader-chapter-frame',
    )!;
    first.dispatchEvent(new Event('load'));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolve0).toHaveBeenCalled();
    renderer.setActiveChapter(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(release0).not.toHaveBeenCalled();
    renderer.clear();
  });

  it('状态栏立即使用 spine 总数，不把已挂载 iframe 数当作总章节数', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: 1_200 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>${index + 1}</p>`,
        })),
      }),
    });

    await view.load('large.epub');

    expect(view.state).toMatchObject({ current: 1, total: 1_200, locationKind: 'chapter' });
    expect(host.querySelectorAll('.lightink-reader-chapter').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('.lightink-reader-chapter').length).toBeLessThan(16);
    await view.destroy();
  });

  it('翻页越过首批窗口时按需挂载下一章', () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'paginated';
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render(
      Array.from({ length: 1_200 }, (_, index) => ({
        title: `Chapter ${index + 1}`,
        html: `<p>${index + 1}</p>`,
      })),
    );
    renderer.setActiveChapter(7);
    vi.advanceTimersByTime(0);

    expect(renderer.advancePage(1)).toBe(true);
    vi.advanceTimersByTime(0);
    expect(
      scrollHost.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset
        .chapterIndex,
    ).toBe('8');
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([5, 6, 7, 8, 9, 10]);
    renderer.clear();
    vi.useRealTimers();
  });
});

describe('滚动模式章节帧高度（末行裁切）', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('scroll chrome uses overflow:hidden so Windows does not reserve a scrollbar gutter', () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: 'Chapter 1', html: '<p>tail line</p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    expect(frame.srcdoc).toMatch(
      /html\[data-reading-layout='scroll'\][\s\S]*?overflow:\s*hidden/,
    );
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    expect(frameDocument.documentElement.style.overflow).toBe('hidden');
    expect(frameDocument.body.style.overflow).toBe('hidden');
  });

  it('forwards a wheel over an image onto the host scroller', () => {
    const scroller = { scrollTop: 40, scrollLeft: 0, clientHeight: 600 };
    document.documentElement.dataset.readingLayout = 'scroll';
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({ scrollContainer: () => scroller as unknown as HTMLElement }),
    );
    renderer.render([{ title: '插图', html: '<p>text</p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    const image = frameDocument.createElement('img');
    frameDocument.body.appendChild(image);
    const event = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    image.dispatchEvent(event);
    expect(scroller.scrollTop).toBe(120);
    expect(event.defaultPrevented).toBe(true);
    expect(applyFrameWheelToScroller({ deltaX: 0, deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: false }, scroller)).toBe(
      true,
    );
    expect(scroller.scrollTop).toBe(150);
    renderer.clear();
  });

  it('sizes scroll-mode images with parent-pane pixels, not iframe vh', () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 700 });
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 700 });
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 900 });
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: '封面', html: '<p></p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    expect(frame.srcdoc).not.toContain('60vh');
    expect(frame.srcdoc).toContain('--lightink-reader-image-max-height');
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    const image = frameDocument.createElement('img');
    image.alt = 'cover';
    frameDocument.body.replaceChildren(image);
    renderer.remasureScrollFrames();
    const html = frameDocument.documentElement;
    const maxHeight = html.style.getPropertyValue('--lightink-reader-image-max-height');
    expect(maxHeight).toMatch(/^\d+px$/);
    expect(Number.parseInt(maxHeight, 10)).toBeGreaterThan(400);
    expect(Number.parseInt(maxHeight, 10)).toBeLessThanOrEqual(700);
    expect(image.style.height).toBe(maxHeight);
    expect(image.style.width).toBe(html.style.getPropertyValue('--lightink-reader-image-max-width'));
    expect(image.classList.contains('lightink-reader-media--page')).toBe(true);
    expect(image.style.objectFit).toBe('contain');
    renderer.clear();
  });

  it('keeps inline text images from growing to a full page in scroll mode', () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 700 });
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([
      { title: '正文', html: '<p>一段说明文字足够把这一章当成正文而不是封面。</p>' },
    ]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    const paragraph = frameDocument.createElement('p');
    paragraph.textContent = '一段说明文字足够把这一章当成正文而不是封面。';
    const image = frameDocument.createElement('img');
    frameDocument.body.replaceChildren(paragraph, image);
    renderer.remasureScrollFrames();
    expect(image.style.width).toMatch(/^auto$/);
    expect(image.style.height).toMatch(/^auto$/);
    expect(image.classList.contains('lightink-reader-media--page')).toBe(false);
    expect(image.style.maxHeight).toMatch(/^\d+px$/);
    renderer.clear();
  });

  it('remasure after paginated !important height lets the chapter grow', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const pane = document.createElement('div');
    pane.id = 'lightink-editor-area';
    Object.defineProperty(pane, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 800 });
    const root = document.createElement('div');
    root.dataset.readingLayout = 'paginated';
    Object.defineProperty(root, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(root, 'clientHeight', { configurable: true, value: 800 });
    const scrollHost = document.createElement('div');
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 1100 });
    Object.defineProperty(scrollHost, 'clientHeight', { configurable: true, value: 800 });
    root.appendChild(scrollHost);
    pane.appendChild(root);
    document.body.appendChild(pane);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: '长章', html: `<p>${'正文'.repeat(40)}</p>`.repeat(20) }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    expect(frameDocument.documentElement.style.getPropertyPriority('height')).toBe('important');
    expect(frameDocument.documentElement.style.height).toBe('800px');
    expect(frame.style.height).toBe('800px');

    Object.defineProperty(frameDocument.body, 'scrollHeight', {
      configurable: true,
      value: 2400,
    });
    root.dataset.readingLayout = 'scroll';
    renderer.remasureScrollFrames();
    expect(frameDocument.documentElement.style.getPropertyPriority('height')).toBe('');
    expect(frameDocument.documentElement.style.height).toBe('auto');
    expect(frameDocument.body.style.getPropertyPriority('height')).toBe('');
    expect(frameDocument.body.style.height).toBe('auto');
    const pageBox = frameDocument.querySelector<HTMLElement>('.lightink-reader-spread');
    expect(pageBox?.style.columnCount ?? '').toBe('');
    expect(Number.parseInt(frame.style.height, 10)).toBeGreaterThan(800);
    renderer.clear();
  });
});

describe('章节 iframe 快捷键转发', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('re-dispatches zoom and fullscreen keys onto the parent document', () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([{ title: 'Chapter 1', html: '<p>body</p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));

    const received: string[] = [];
    const onHostKey = (event: KeyboardEvent): void => {
      received.push(`${event.ctrlKey ? 'Ctrl+' : ''}${event.key}`);
    };
    document.addEventListener('keydown', onHostKey);
    try {
      frame.contentDocument!.dispatchEvent(
        new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      frame.contentDocument!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F11', bubbles: true, cancelable: true }),
      );
      expect(received).toContain('Ctrl+=');
      expect(received).toContain('F11');
    } finally {
      document.removeEventListener('keydown', onHostKey);
    }
  });

  it('does not re-dispatch Ctrl+F after opening in-frame search', () => {
    const openSearch = vi.fn();
    document.documentElement.dataset.readingLayout = 'scroll';
    const root = document.createElement('div');
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks({ openSearch }));
    renderer.render([{ title: 'Chapter 1', html: '<p>body</p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));

    const received: string[] = [];
    const onHostKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        received.push('Ctrl+F');
      }
    };
    document.addEventListener('keydown', onHostKey);
    try {
      frame.contentDocument!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(openSearch).toHaveBeenCalledTimes(1);
      expect(received).toEqual([]);
    } finally {
      document.removeEventListener('keydown', onHostKey);
    }
  });
});

describe('缩放性能（T6：档位合并去抖 + 仅可见章分栏 + 流式锚点不漂移）', () => {
  const rect = (top: number, height: number): DOMRect =>
    ({ top, bottom: top + height, left: 0, right: 400, width: 400, height }) as DOMRect;

  const loadFlowBook = async (
    chapterCount: number,
  ): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
    scroll: HTMLElement;
    chapters: HTMLElement[];
    frames: HTMLIFrameElement[];
  }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: chapterCount }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>chapter ${index + 1} body</p>`,
        })),
      }),
    });
    await view.load('book.epub');
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const chapters = Array.from(scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter'));
    const frames = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      frame.dispatchEvent(new Event('load'));
    }
    // 冲掉帧 load 时排队的 rAF chrome 重放，避免迟到帧改写测试预设的样式。
    await vi.advanceTimersByTimeAsync(50);
    return { host, view, scroll, chapters, frames };
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    document.documentElement.style.removeProperty('--lightink-font-scale');
  });

  it('滚动模式：字号缩放经 ~200ms settle 合并去抖，仅刷新可见帧并保持视口锚点', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { host, view, scroll, chapters, frames } = await loadFlowBook(2);
    host.querySelector<HTMLElement>('.lightink-reader')!.dataset.readingLayout = 'scroll';

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    vi.spyOn(frames[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    // 缩放前章高 800、缩放后重排为 1600：锚点恢复必须把视口中心内容按比例带回。
    // （jsdom 会把 calc(16px * 2) 归一化为 calc(32px)，故提取像素数值区分前后。）
    const bodyFontPx = (body: HTMLElement): number =>
      Number(body.style.fontSize.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 0);
    const visibleBody = frames[0]!.contentDocument!.body;
    const scaledUp = (): boolean => bodyFontPx(visibleBody) >= 32;
    // 帧高重同步是异步的：syncVisibleFrames 只改字号，帧高由 ResizeObserver
    // 在首个 rAF 后重写——settle 同步时刻章高仍是旧几何，锚点恢复必须推迟
    // 到新几何落地（测试分帧推进模拟该时序）。
    let heightResynced = false;
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockImplementation(() =>
      heightResynced ? rect(50, 1600) : rect(100, 800),
    );
    vi.spyOn(frames[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 800));
    scroll.scrollTop = 100;

    document.documentElement.style.setProperty('--lightink-font-scale', '2');
    host.querySelector<HTMLElement>('.lightink-reader')!.style.setProperty(
      '--lightink-reader-font-scale',
      '2',
    );
    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));

    // settle 窗口内不重排（连续缩放合并去抖，避免每档整章 column 重排）。
    expect(scaledUp()).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    expect(scaledUp()).toBe(true); // 可见帧已按新档刷新
    expect(bodyFontPx(frames[1]!.contentDocument!.body)).toBeLessThan(32); // 离屏帧不动
    // settle 时帧高未重同步（heightResynced 仍为 false）：不得用旧几何抢跑恢复。
    expect(scroll.scrollTop).toBe(100);
    await vi.advanceTimersByTimeAsync(16); // 首个 rAF：此刻模拟 RO 重写帧高
    heightResynced = true;
    await vi.advanceTimersByTimeAsync(16); // 第二个 rAF：新几何落地后恢复锚点
    // 视口锚点（章内 0.1875 处）回到中心：scrollTop 100 → 200，内容不漂移。
    expect(scroll.scrollTop).toBe(200);
    await view.destroy();
  });

  it('滚动模式锚点恢复：scroller 视口偏移非零时按相对坐标归一化，不把 chrome 偏移累进滚动量', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { view, scroll, chapters, frames } = await loadFlowBook(2);
    scroll.closest<HTMLElement>('.lightink-reader')!.dataset.readingLayout = 'scroll';

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    // scroller 不在视口原点（上方有标签栏/工具栏 chrome）：top 70、left 30。
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      ...rect(70, 500),
      left: 30,
      right: 430,
    } as DOMRect);
    vi.spyOn(chapters[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    vi.spyOn(frames[1]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 800));
    let heightResynced = false;
    // 章节坐标是 getBoundingClientRect 的视口绝对坐标（含 chrome 偏移 70/30）。
    // 旧几何 top 170（= 70 + 100）、新几何 top 120（= 70 + 50）、高 800 → 1600。
    const chapterRect = (top: number, height: number): DOMRect =>
      ({ ...rect(top, height), left: 30 }) as DOMRect;
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockImplementation(() =>
      heightResynced ? chapterRect(120, 1600) : chapterRect(170, 800),
    );
    vi.spyOn(frames[0]!, 'getBoundingClientRect').mockReturnValue(chapterRect(170, 800));
    scroll.scrollTop = 100;

    document.documentElement.style.setProperty('--lightink-font-scale', '2');
    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(16); // 首个 rAF：此刻模拟 RO 重写帧高
    heightResynced = true;
    await vi.advanceTimersByTimeAsync(16); // 第二个 rAF：恢复锚点

    // 不归一化时 slot.top=120 会被当作 scroller 内偏移，scrollTop 错成
    // 100 + 120 + 300 - 250 = 270（多算 70 的 chrome 偏移）；归一化后 200。
    expect(scroll.scrollTop).toBe(200);
    await view.destroy();
  });

  it('翻页模式：settle 时仅可见章立即重分栏，离屏章激活时才惰性补分栏', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'paginated';
    const { view, scroll, chapters, frames } = await loadFlowBook(3);

    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    vi.spyOn(chapters[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    vi.spyOn(frames[0]!, 'getBoundingClientRect').mockReturnValue(rect(100, 300));
    for (let i = 1; i < 3; i += 1) {
      vi.spyOn(chapters[i]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 300));
      vi.spyOn(frames[i]!, 'getBoundingClientRect').mockReturnValue(rect(5000, 300));
    }
    // 模拟“未按当前档分栏”的陈旧宽度：可见章 0 与离屏章 1/2 各自不同。
    const htmls = frames.map((frame) => frame.contentDocument!.documentElement);
    htmls[0]!.style.width = '555px';
    htmls[1]!.style.width = '777px';
    htmls[2]!.style.width = '888px';

    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));
    expect(htmls[0]!.style.width).toBe('555px'); // 未到 settle 不重分栏

    await vi.advanceTimersByTimeAsync(200);
    expect(htmls[0]!.style.width).not.toBe('555px'); // 可见章立即重分栏
    expect(htmls[1]!.style.width).toBe('777px'); // 离屏章不参与整批重分栏
    expect(htmls[2]!.style.width).toBe('888px');

    // 激活离屏章 1：惰性补分栏；其余离屏章保持惰性。
    view.jumpToOutlineItem({ level: 1, text: 'Chapter 2', anchor: 1, chapter: 1 });
    expect(htmls[1]!.style.width).not.toBe('777px');
    expect(htmls[2]!.style.width).toBe('888px');
    await view.destroy();
  });

  it('settle 前加载新文档：pending 缩放刷新（含锚点恢复）被作废，不抢跑新文档滚动', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { view, scroll } = await loadFlowBook(2);

    document.documentElement.style.setProperty('--lightink-font-scale', '2');
    document.dispatchEvent(new CustomEvent('lightink:font-scale', { detail: 2 }));
    document.documentElement.style.removeProperty('--lightink-font-scale');

    // renderChapters：作废待 settle 的缩放刷新与推迟中的锚点恢复（与 destroy 对称）。
    await view.load('book.epub');
    const frames = Array.from(
      scroll.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      frame.dispatchEvent(new Event('load'));
    }
    scroll.scrollTop = 300; // 用户已在新文档开始阅读
    await vi.advanceTimersByTimeAsync(200 + 64);
    // 未作废的迟到 settle 会按旧几何重算锚点把 scrollTop 抢走（jsdom 零尺寸下变为 50）。
    expect(scroll.scrollTop).toBe(300);
    await view.destroy();
  });

  it('排版刷新（refreshViewport）后恢复滚动位置：重排丢失 scrollTop 时按快照还原', async () => {
    // 回归：排版面板调行距/行长/翻页模式走 refreshViewport，旧实现只重排不恢复，
    // 真实 WebView 重测帧高时 scrollTop 被钳回 0，用户看到“跳回书的第一页”。
    vi.useFakeTimers();
    globalThis.localStorage?.clear();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { host, view, scroll, chapters } = await loadFlowBook(2);
    host.querySelector<HTMLElement>('.lightink-reader')!.dataset.readingLayout = 'scroll';

    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1600 });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 500));
    // 两章各 800 高；rect 随当前 scrollTop 变化，保证快照与恢复读到的几何一致。
    chapters.forEach((chapter, index) => {
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 800 });
      vi.spyOn(chapter, 'getBoundingClientRect').mockImplementation(() =>
        rect(index * 800 - scroll.scrollTop, 800),
      );
    });

    // 用户读到章 0 的 50%（scrollTop 400）：滚动事件经 rAF 记录 lastFlowProgress。
    scroll.scrollTop = 400;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);

    // 模拟浏览器在重排过程中把 scrollTop 钳回 0（jsdom 不会自发重置，显式模拟）。
    scroll.scrollTop = 0;

    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(200); // createResizeSettle 默认 180ms

    // 修复前：scrollTop 停留在 0（跳回书的第一页）；修复后：按快照恢复到 400。
    expect(scroll.scrollTop).toBe(400);
    await view.destroy();
  });

  it('翻页切到滚动后进度按全书章节算，不把已挂载窗口当成 86%', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: 40 }, (_, index) => ({
          title: `第${index + 1}章`,
          html: `<p>chapter ${index + 1}</p>`,
        })),
      }),
      preferenceStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      },
    });
    await view.load('book.epub');
    view.jumpToOutlineItem({ level: 1, text: '第6章', anchor: 5, chapter: 5 });
    await vi.advanceTimersByTimeAsync(0);
    for (const frame of host.querySelectorAll('iframe')) {
      frame.dispatchEvent(new Event('load'));
    }
    expect(view.state.current).toBe(6);

    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const reader = host.querySelector<HTMLElement>('.lightink-reader')!;
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 800 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2400 });
    scroll.scrollTop = 1376;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 800,
      left: 0,
      right: 400,
      width: 400,
      height: 800,
    } as DOMRect);
    for (const chapter of scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      const index = Number(chapter.dataset.chapterIndex);
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 800 });
      vi.spyOn(chapter, 'getBoundingClientRect').mockReturnValue({
        top: (index - 5) * 800,
        bottom: (index - 4) * 800,
        left: 0,
        right: 400,
        width: 400,
        height: 800,
      } as DOMRect);
    }

    store['lightink.reader.flow.layout'] = 'scroll';
    view.refreshPreferences?.();
    expect(reader.dataset.readingLayout).toBe('scroll');
    await vi.advanceTimersByTimeAsync(2000);
    for (const chapter of scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      const index = Number(chapter.dataset.chapterIndex);
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 800 });
      vi.spyOn(chapter, 'getBoundingClientRect').mockReturnValue({
        top: (index - 5) * 800,
        bottom: (index - 4) * 800,
        left: 0,
        right: 400,
        width: 400,
        height: 800,
      } as DOMRect);
    }
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);
    expect(view.state.current).toBe(6);
    expect(view.state.total).toBe(40);
    expect(view.state.progress).toBeLessThan(0.25);
    expect(view.state.progress).toBeCloseTo(5 / 40, 5);
    await view.destroy();
  });

  it('拖动进度条按全书章节跳转，而不是已挂载窗口高度', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: 40 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>${index + 1}</p>`,
        })),
      }),
    });
    await view.load('book.epub');
    const slider = host.querySelector<HTMLInputElement>('.lightink-reader-chrome-progress');
    expect(slider).not.toBeNull();
    slider!.value = '500';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    const active = host.querySelector<HTMLElement>('.lightink-reader-chapter.is-active');
    expect(Number(active?.dataset.chapterIndex)).toBe(20);
    expect(view.state.current).toBe(21);
    expect(view.state.progress).toBeCloseTo(20 / 40, 5);
    await view.destroy();
  });
});

describe('主题切换刷新（R4）', () => {
  const loadFlowBook = async (): Promise<{
    view: ReturnType<typeof createReaderView>;
    frames: HTMLIFrameElement[];
  }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [{ title: 'Chapter 1', html: '<p>chapter 1 body</p>' }],
      }),
    });
    await view.load('book.epub');
    const frames = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    return { view, frames };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('lightink:theme-change 重应用 flow 帧文字色', async () => {
    vi.useFakeTimers();
    document.documentElement.dataset.readingLayout = 'scroll';
    const { view, frames } = await loadFlowBook();
    const frameBody = frames[0]!.contentDocument!.body;
    const original = frameBody.style.color;

    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      color: 'rgb(1, 2, 3)',
      fontFamily: 'serif',
      fontSize: '16px',
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);

    document.dispatchEvent(new CustomEvent('lightink:theme-change'));
    expect(frameBody.style.color).toBe('rgb(1, 2, 3)');
    expect(frameBody.style.color).not.toBe(original);
    await view.destroy();
  });
});

describe('窗口级翻页（R1：不限中间章节容器）', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('exposes advanceReading on the reader instance', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [{ title: 'Chapter 1', html: '<p>body</p>' }],
      }),
    });
    await view.load('book.epub');
    expect(typeof view.advanceReading).toBe('function');
    expect(view.advanceReading(1)).toBe(false);
    const exported = await view.getExportHtml?.();
    expect(exported).toContain('page-break-before:always');
    expect(exported).toContain('lightink-export-bookmark');
    expect(exported).toContain('<h1 class="lightink-export-bookmark">Chapter 1</h1><p>body</p>');
    expect(exported).not.toMatch(/<h1>Chapter 1<\/h1>/);
    await view.destroy();
  });

  it('does not add a hidden bookmark when the chapter already has a heading', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [{ title: '第一章', html: '<h1>第一章</h1><p>正文</p>' }],
      }),
    });
    await view.load('book2.epub');
    const headed = await view.getExportHtml?.();
    expect(headed).toContain('<h1>第一章</h1>');
    expect(headed).not.toContain('<h1 class="lightink-export-bookmark">');
    await view.destroy();
  });
});

describe('流式触屏划选与版式切换（R6/R7）', () => {
  const loadFlowSelectionBook = async (
    chapterCount = 1,
    extras: { preferenceStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } } = {},
  ): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
    reader: HTMLElement;
    scroll: HTMLElement;
    frames: HTMLIFrameElement[];
  }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: chapterCount }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>chapter ${index + 1} selectable body</p>`,
        })),
      }),
      preferenceStorage: extras.preferenceStorage,
    });
    await view.load('book.epub');
    const reader = host.querySelector<HTMLElement>('.lightink-reader')!;
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    const frames = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 400 });
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    return { host, view, reader, scroll, frames };
  };

  const stubRangeClientRect = (doc: Document): void => {
    const proto = doc.defaultView?.Range?.prototype;
    if (proto === undefined || typeof proto.getBoundingClientRect === 'function') {
      return;
    }
    proto.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 20,
        y: 40,
        left: 20,
        top: 40,
        width: 80,
        height: 16,
        right: 100,
        bottom: 56,
        toJSON: () => ({}),
      } as DOMRect;
    };
  };

  const selectFrameQuote = (frame: HTMLIFrameElement, quote = 'selectable'): void => {
    const doc = frame.contentDocument!;
    stubRangeClientRect(doc);
    // jsdom 不把 srcdoc 解析进 iframe 文档；与既有帧测一样在 load 后注入正文。
    let paragraph = doc.querySelector('p');
    if (paragraph === null) {
      paragraph = doc.createElement('p');
      paragraph.textContent = 'chapter 1 selectable body';
      doc.body.appendChild(paragraph);
    }
    expect(paragraph.firstChild).not.toBeNull();
    const node = paragraph.firstChild as Text;
    const start = (node.textContent ?? '').indexOf(quote);
    expect(start).toBeGreaterThanOrEqual(0);
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + quote.length);
    const selection = doc.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const visibleSelectionToolbar = (): HTMLElement | null => {
    const toolbar = document.querySelector<HTMLElement>('.lightink-reader-selection-toolbar');
    if (toolbar === null || toolbar.hidden) {
      return null;
    }
    return toolbar;
  };

  const touchAt = (type: string, point: { clientX: number; clientY: number }): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const points = [point];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
    Object.defineProperty(event, 'changedTouches', { value: points });
    return event;
  };

  const tapRightZone = (target: EventTarget): void => {
    target.dispatchEvent(touchAt('touchstart', { clientX: 350, clientY: 100 }));
    target.dispatchEvent(touchAt('touchend', { clientX: 350, clientY: 100 }));
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-touch-primary');
    document.documentElement.removeAttribute('data-android');
    delete document.documentElement.dataset.readingLayout;
  });

  it('shows the existing selection toolbar on desktop iframe mouseup and does not consume contextmenu', async () => {
    vi.useFakeTimers();
    const { view, frames } = await loadFlowSelectionBook();
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;

    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const toolbar = visibleSelectionToolbar();
    expect(toolbar).not.toBeNull();
    expect(toolbar!.querySelector('.lightink-reader-selection-action--highlight')).not.toBeNull();
    expect(toolbar!.querySelector('.lightink-reader-selection-action--note')).not.toBeNull();
    expect(toolbar!.querySelector('.lightink-reader-selection-action--copy')).not.toBeNull();

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    frameDocument.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
    await view.destroy();
  });

  it('shows the existing toolbar after touch selectionchange or touchend and consumes contextmenu', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-touch-primary', '');
    const { view, frames } = await loadFlowSelectionBook();
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    expect(frame.srcdoc).toMatch(/-webkit-touch-callout:\s*none/);

    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(100);
    if (visibleSelectionToolbar() === null) {
      frameDocument.dispatchEvent(touchAt('touchend', { clientX: 200, clientY: 80 }));
      await vi.advanceTimersByTimeAsync(100);
    }

    const toolbar = visibleSelectionToolbar();
    expect(toolbar).not.toBeNull();
    expect(toolbar!.classList.contains('lightink-reader-selection-toolbar')).toBe(true);
    expect(toolbar!.querySelector('.lightink-reader-selection-action--highlight')).not.toBeNull();

    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    frameDocument.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    await view.destroy();
  });

  it('releases layoutSwitching after switching to scroll, disables tap paging, and restores paging when paginated', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
    const { view, reader, frames } = await loadFlowSelectionBook(3, {
      preferenceStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      },
    });
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    expect(reader.dataset.readingLayout).toBe('paginated');

    tapRightZone(frameDocument);
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('1');

    view.jumpToOutlineItem({ level: 1, text: 'Chapter 1', anchor: 0, chapter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('0');

    store['lightink.reader.flow.layout'] = 'scroll';
    view.refreshPreferences?.();
    expect(reader.dataset.readingLayout).toBe('scroll');
    expect(document.documentElement.dataset.readingLayout).toBe('scroll');
    const pageBox = frameDocument.querySelector<HTMLElement>('.lightink-reader-spread');
    expect(pageBox?.style.columnCount ?? '').toBe('');

    Object.defineProperty(frameDocument.body, 'scrollHeight', {
      configurable: true,
      value: 2400,
    });
    view.refreshViewport?.();
    expect(Number.parseInt(frame.style.height, 10)).toBeGreaterThan(800);

    tapRightZone(frameDocument);
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('0');

    store['lightink.reader.flow.layout'] = 'paginated';
    view.refreshPreferences?.();
    expect(reader.dataset.readingLayout).toBe('paginated');
    tapRightZone(frameDocument);
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('1');
    await view.destroy();
  });
});
