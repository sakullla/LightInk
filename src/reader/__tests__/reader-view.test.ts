// @vitest-environment jsdom

// Abandoned last-coverage (Duration still >15s after unused-helper repair):
// reader-view: color swatches; outside-click toolbar hide; syncTheme paper paint;
// single-column iframe measure; two-column spread; cover-only full page;
// grown-pane pagination cap; compact gutter; consecutive illustration plates;
// paginated-to-scroll remount; IO-hidden packaged images; junk converter titles;
// scroll lazy next chapter; drop spacers on paginated switch; spine-total status
// for 1200 chapters; page past first window; scroll edge mount; hide in-body
// heading; one-tick multi-frame wheel; wheel after unmoved tick; inline text
// image not full-page; remasure after paginated !important height; Ctrl+F not
// re-dispatched; chrome-offset zoom anchor; pending zoom cancelled on reload;
// refreshViewport scroll restore; paginated-to-scroll progress vs mounted 86%;
// progress-bar jump by spine; theme-change frame color; touch toolbar +
// contextmenu consume; layoutSwitching tap paging restore; search generation
// empty-state; window scroll paging bounds; outline jump no-op; paginated
// facade step; paginated home/end bounds.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';
import {
  applyFrameWheelToScroller,
  createFlowRenderer,
  resolveFlowFrameClick,
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
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';

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

  it('同步只挂载前两章，空闲计时器不会继续创建全书 iframe', async () => {
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

    expect(scrollHost.querySelectorAll('.lightink-reader-chapter')).toHaveLength(2);
    expect(scrollHost.querySelectorAll('iframe')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scrollHost.querySelectorAll('.lightink-reader-chapter')).toHaveLength(2);
    expect(scrollHost.querySelectorAll('iframe')).toHaveLength(2);
    renderer.setActiveChapter(30);
    vi.advanceTimersByTime(0);
    expect(
      scrollHost.querySelector<HTMLElement>('[data-chapter-index="30"]'),
    ).not.toBeNull();
    expect(
      Array.from(scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')).map(
        (chapter) => Number(chapter.dataset.chapterIndex),
      ),
    ).toEqual([28, 29, 30, 31, 32]);
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
    expect(frame.srcdoc).toMatch(
      /html\[data-reading-layout='scroll'\] \[data-reader-split-heading\][\s\S]*?display:\s*none/,
    );
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    expect(frameDocument.documentElement.style.overflow).toBe('hidden');
    expect(frameDocument.body.style.overflow).toBe('hidden');
    renderer.clear();
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
});
