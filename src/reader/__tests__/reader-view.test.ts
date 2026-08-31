// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';
import {
  applyFrameWheelToScroller,
  createFlowRenderer,
  mapFrameClientRect,
  resolveFlowFrameClick,
  shouldDeferFlowPointerTap,
} from '../flow-renderer.js';
import type { FlowRendererHooks } from '../flow-renderer.js';
import { sessionRemoteImagePolicy } from '../../media/remote-image-policy.js';
import { createSelectionToolbar, selectionClientRect, toolbarPosition } from '../selection-toolbar.js';
import { SHEET_TRANSITION_FALLBACK_MS } from '../../ui/touch/sheet-transition.js';
import {
  applyPagedSpreadVars,
  clearPagedSpreadVars,
  pagedSpreadMetrics,
} from '../../ui/reading-layout.js';
import { readerFlowSpreadFromTypography } from '../reader-layout.js';
import { applyReaderTheme } from '../reader-theme.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';

const cbzMock = vi.hoisted(() => ({ renderCbzInto: vi.fn() }));
vi.mock('../formats/cbz.js', () => ({ renderCbzInto: cbzMock.renderCbzInto }));

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

  it('notifies onDismiss when pressing outside the toolbar', () => {
    const onDismiss = vi.fn();
    const toolbar = createSelectionToolbar({
      t: (key) => key,
      onAction: () => undefined,
      onDismiss,
    });
    document.body.appendChild(toolbar.element);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(toolbar.isVisible()).toBe(false);
  });

  it('dismisses from the full-page catcher without firing an action', () => {
    const onDismiss = vi.fn();
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({
      t: (key) => key,
      onAction: (action) => actions.push(action),
      onDismiss,
    });
    document.body.appendChild(toolbar.element);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    const catcher = document.querySelector<HTMLElement>('.lightink-reader-selection-dismiss');
    expect(catcher).not.toBeNull();
    expect(catcher!.hidden).toBe(false);
    catcher!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    catcher!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(actions).toEqual([]);
    expect(toolbar.isVisible()).toBe(false);
    expect(catcher!.hidden).toBe(true);
  });

  it('hide 后退场过渡收尾才置 hidden（settle 前可见、settle 后摘外部监听）', () => {
    vi.useFakeTimers();
    // stub computed transition-duration 走异步退场分支（真机 180ms 过渡窗口）。
    const computeSpy = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation(() => ({ transitionDuration: '0.18s' }) as CSSStyleDeclaration);
    try {
      const onDismiss = vi.fn();
      const toolbar = createSelectionToolbar({ t: (key) => key, onAction: () => undefined, onDismiss });
      document.body.appendChild(toolbar.element);
      // FC2：直接监听 document 的 add/removeEventListener 调用——原「settle 后
      // 派发外部 mousedown 断言 onDismiss 零调用」恒真（onPointerDownOutside
      // 以 root.hidden 为首行守卫，即使监听器未摘也不会派发）。
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
      expect(toolbar.element.dataset.open).toBe('');
      // 显示期间挂上 pointerdown/mousedown 两个 capture 外部监听。
      const added = addSpy.mock.calls.filter(
        ([type]) => type === 'pointerdown' || type === 'mousedown',
      );
      expect(added.length).toBe(2);

      toolbar.hide();
      // hide 后 settle 前：hidden 不置（退场过渡进行中），data-open 已摘。
      expect(toolbar.element.hidden).toBe(false);
      expect(toolbar.isVisible()).toBe(true);
      expect(toolbar.element.dataset.open).toBeUndefined();
      // 兜底 timer 未到：外部点击监听仍挂着（退场中的工具条仍可交互收尾）。
      vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS - 1);
      expect(toolbar.element.hidden).toBe(false);

      // settle 落地：置 hidden，且挂上的同一个监听器（含 capture 标志）被摘除。
      vi.advanceTimersByTime(1);
      expect(toolbar.element.hidden).toBe(true);
      expect(toolbar.isVisible()).toBe(false);
      for (const [type, listener, options] of added) {
        expect(removeSpy).toHaveBeenCalledWith(type, listener, options);
      }
    } finally {
      computeSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('触屏颜色圆点 44px 热区：命中盒达标、圆点视觉尺寸保持（FB8/FC1）；工具条防溢出（FC1）', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    const hitRule = css.match(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-selection-color\s*\{[^}]*\}/,
    )?.[0];
    expect(hitRule, 'touch selection-color hit rule').toBeTruthy();
    // FC1：48px→44px（EN 单行溢出收窄；仍高于 WCAG 2.5.8 的 24px，与 T4 44px 基线一致）。
    expect(hitRule).toMatch(/min-width:\s*44px/);
    expect(hitRule).toMatch(/min-height:\s*44px/);
    // 圆点视觉尺寸保持：背景裁剪到 content-box，padding 只贡献热区。
    expect(hitRule).toMatch(/background-clip:\s*content-box/);
    expect(hitRule).toMatch(/padding:\s*calc\(\(44px - 1\.15rem\) \/ 2\)/);
    // FC1：触屏工具条防溢出——max-width 与 MARGIN 对齐 + 允许折行。
    const toolbarRule = css.match(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-selection-toolbar\s*\{[^}]*\}/g,
    );
    expect(toolbarRule, 'touch selection-toolbar rules').toBeTruthy();
    const overflowRule = toolbarRule!
      .find((rule) => /max-width:/.test(rule));
    expect(overflowRule, 'touch toolbar overflow rule').toBeTruthy();
    expect(overflowRule).toMatch(/flex-wrap:\s*wrap/);
    expect(overflowRule).toMatch(/max-width:\s*calc\(100vw - 8px\)/);
    // action 48px 热区保持（T3-A2 基线不动）。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-selection-action\s*\{[^}]*min-height:\s*48px[^}]*min-width:\s*48px/,
    );
    // 内联色必须用 background-color 长属性，否则简写重置 clip 压过触屏规则。
    const toolbarSource = readFileSync(
      resolve(process.cwd(), 'src/reader/selection-toolbar.ts'),
      'utf-8',
    );
    expect(toolbarSource).toMatch(/style\.backgroundColor = color/);
    expect(toolbarSource).not.toMatch(/style\.background = color/);
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

  it('anchors on the last line box instead of a column-spanning bounding rect', () => {
    const range = document.createRange();
    range.getBoundingClientRect = () =>
      ({
        x: 40,
        y: 80,
        left: 40,
        top: 80,
        width: 720,
        height: 40,
        right: 760,
        bottom: 120,
        toJSON: () => ({}),
      }) as DOMRect;
    range.getClientRects = () =>
      [
        { left: 40, top: 80, width: 300, height: 18, right: 340, bottom: 98 },
        { left: 48, top: 100, width: 260, height: 18, right: 308, bottom: 118 },
      ] as unknown as DOMRectList;
    expect(selectionClientRect(range)).toEqual({
      left: 48,
      top: 100,
      width: 260,
      height: 18,
    });
  });

  it('maps an iframe-local rect into the parent viewport', () => {
    const frame = document.createElement('iframe');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 80,
      width: 800,
      height: 600,
      right: 1000,
      bottom: 680,
      x: 200,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect);
    expect(mapFrameClientRect(frame, { left: 40, top: 100, width: 260, height: 18 })).toEqual({
      left: 240,
      top: 180,
      width: 260,
      height: 18,
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

  it('defers desktop pointer taps on EPUB in-book links and annotation marks', () => {
    const link = document.createElement('a');
    link.setAttribute('href', '#lightink-chapter?chapter=2');
    const wrap = document.createElement('a');
    wrap.setAttribute('href', 'https://example.invalid/next');
    const mark = document.createElement('mark');
    mark.setAttribute('data-annotation-id', 'n1');
    mark.className = 'lightink-reader-highlight';
    expect(shouldDeferFlowPointerTap(link)).toBe(true);
    expect(shouldDeferFlowPointerTap(wrap)).toBe(false);
    expect(shouldDeferFlowPointerTap(mark)).toBe(true);
    expect(shouldDeferFlowPointerTap(mark.appendChild(document.createTextNode('highlighted')))).toBe(
      true,
    );
    expect(shouldDeferFlowPointerTap(document.createElement('p'))).toBe(false);
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
    expect(scrollHost.querySelector('[data-chapter-index="5"]')).not.toBeNull();
    expect(scrollHost.querySelector('[data-chapter-index="0"]')).toBeNull();
    vi.advanceTimersByTime(2000);
    expect(scrollHost.querySelector('[data-chapter-index="20"]')).toBeNull();
    renderer.clear();
    vi.useRealTimers();
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

  it('scroll mode materializes the next lazy chapter when the window slides', async () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    const chapters = Array.from({ length: 40 }, (_, index) => {
      if (index < 2) {
        return { title: `C${index + 1}`, html: `<p>${index}</p>` };
      }
      const chapter = {
        title: `C${index + 1}`,
        html: '',
        load: async (): Promise<void> => {
          chapter.html = `<p>${index}</p>`;
        },
      };
      return chapter;
    });
    renderer.render(chapters);
    renderer.setActiveChapter(7);
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    expect(
      scrollHost.querySelector<HTMLIFrameElement>(
        '[data-chapter-index="8"] .lightink-reader-chapter-frame',
      )?.srcdoc,
    ).toContain('<p>8</p>');
    expect(scrollHost.querySelector('[data-chapter-index="0"]')).toBeNull();
    renderer.clear();
    vi.useRealTimers();
  });

  it('drops scroll spacers when switching to paginated so the active chapter is on the face', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render(
      Array.from({ length: 40 }, (_, index) => ({
        title: `C${index + 1}`,
        html: `<p>${index}</p>`,
      })),
    );
    renderer.setActiveChapter(10);
    for (const chapter of scrollHost.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      Object.defineProperty(chapter, 'offsetHeight', { configurable: true, value: 80 });
    }
    vi.advanceTimersByTime(0);
    expect(scrollHost.querySelector('[data-chapter-spacer="0"]')).not.toBeNull();

    root.dataset.readingLayout = 'paginated';
    renderer.setActiveChapter(10);
    expect(scrollHost.querySelector('.lightink-reader-chapter-spacer')).toBeNull();
    expect(
      scrollHost.querySelector('[data-chapter-index="10"]')?.classList.contains('is-active'),
    ).toBe(true);
    renderer.clear();
    vi.useRealTimers();
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

  it('scroll mode mounts the next chapter when the viewport reaches the window edge', async () => {
    vi.useFakeTimers();
    const store: Record<string, string> = { 'lightink.reader.flow.layout': 'scroll' };
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
      preferenceStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      },
    });
    await view.load('scroll-next.epub');
    vi.advanceTimersByTime(0);
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    expect(scroll.querySelector('[data-chapter-index="3"]')).toBeNull();

    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
    for (const chapter of scroll.querySelectorAll<HTMLElement>('.lightink-reader-chapter')) {
      const index = Number(chapter.dataset.chapterIndex);
      vi.spyOn(chapter, 'getBoundingClientRect').mockReturnValue({
        top: (index - 2) * 120,
      } as DOMRect);
    }
    scroll.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(16);
    vi.advanceTimersByTime(0);
    expect(scroll.querySelector('[data-chapter-index="4"]')).not.toBeNull();
    await view.destroy();
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
    expect(frame.srcdoc).toMatch(
      /mark\.lightink-reader-highlight\[data-annotation-kind='note'\]\s*\{[^}]*background:\s*var\(--lightink-annotation-color/,
    );
    expect(frame.srcdoc).toMatch(/mark\.lightink-reader-highlight\s*\{[^}]*display:\s*inline\s*!important/);
    expect(frame.srcdoc).toMatch(/\.lightink-reader-highlight-layer\s*\{[^}]*position:\s*fixed/);
    expect(frame.srcdoc).toMatch(/::highlight\(lightink-hl-f2d675\)/);
    expect(frame.srcdoc).not.toMatch(
      /mark\.lightink-reader-highlight\[data-annotation-kind='note'\]\s*\{[^}]*background:\s*color-mix/,
    );
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    expect(frameDocument.documentElement.style.overflow).toBe('hidden');
    expect(frameDocument.body.style.overflow).toBe('hidden');
    renderer.clear();
  });

  it('hides the in-body chapter heading in scroll mode so the article title is not doubled', () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const root = document.createElement('div');
    root.dataset.readingLayout = 'scroll';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    document.body.appendChild(root);
    const renderer = createFlowRenderer(scrollHost, root, flowRendererHooks());
    renderer.render([
      {
        title: '第10章 标题',
        html: '<p>第10章 标题</p><p>正文甲。</p>',
      },
    ]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    const frameDocument = frame.contentDocument!;
    frameDocument.body.innerHTML = '<p>第10章 标题</p><p>正文甲。</p>';
    renderer.remasureScrollFrames();
    expect(scrollHost.querySelector('.lightink-reader-chapter-title')?.textContent).toBe(
      '第10章 标题',
    );
    expect(frameDocument.querySelector('[data-reader-split-heading]')?.textContent).toBe(
      '第10章 标题',
    );
    expect(frameDocument.body.textContent).toContain('正文甲');
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

  it('applies one scroll-mode wheel tick across mounted frames only once', () => {
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
    renderer.render([
      { title: '第1章 标题', html: '<p>正文甲</p>' },
      { title: '第2章 标题', html: '<p>正文乙</p>' },
    ]);
    const frames = scrollHost.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame');
    expect(frames).toHaveLength(2);
    const stamp = 1234.5;
    for (const frame of frames) {
      frame.dispatchEvent(new Event('load'));
      const image = frame.contentDocument!.createElement('img');
      frame.contentDocument!.body.appendChild(image);
      const event = new WheelEvent('wheel', {
        deltaY: 80,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, 'timeStamp', { value: stamp });
      image.dispatchEvent(event);
    }
    expect(scroller.scrollTop).toBe(120);
    renderer.clear();
  });

  it('does not eat the next scroll-mode wheel after a tick that could not move', () => {
    let top = 40;
    const scroller = {
      clientHeight: 600,
      scrollLeft: 0,
      get scrollTop() {
        return top;
      },
      set scrollTop(value: number) {
        top = Math.min(40, Math.max(0, value));
      },
    };
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
    renderer.render([{ title: '第1章 标题', html: '<p>正文甲</p>' }]);
    const frame = scrollHost.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    frame.dispatchEvent(new Event('load'));
    const image = frame.contentDocument!.createElement('img');
    frame.contentDocument!.body.appendChild(image);
    const stamp = 88;
    const down = new WheelEvent('wheel', {
      deltaY: 80,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(down, 'timeStamp', { value: stamp });
    image.dispatchEvent(down);
    expect(scroller.scrollTop).toBe(40);
    const up = new WheelEvent('wheel', {
      deltaY: -80,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(up, 'timeStamp', { value: stamp });
    image.dispatchEvent(up);
    expect(scroller.scrollTop).toBe(0);
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
    globalThis.localStorage?.clear();
    // Sibling tests persist book.epub at chapter 0. If jump does not cancel
    // pendingRestore, iframe load reapplies that leftover and current stays 1.
    globalThis.localStorage?.setItem(
      'lightink.reader.progress.book.epub',
      JSON.stringify({
        version: 2,
        kind: 'flow',
        index: 0,
        ratio: 0,
        total: 40,
        updatedAt: 1,
      }),
    );
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

  it('shows the existing selection toolbar on desktop iframe mouseup and consumes contextmenu when a quote is selected', async () => {
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
    expect(menu.defaultPrevented).toBe(true);
    await view.destroy();
  });

  it('shows the existing toolbar after touch selectionchange or touchend and consumes contextmenu', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-touch-primary', '');
    const { view, frames } = await loadFlowSelectionBook();
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    expect(frame.srcdoc).toMatch(/-webkit-touch-callout:\s*none/);
    expect(frame.srcdoc).toMatch(/user-select:\s*text/);

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

  it('keeps the quote snapshot after iframe selection collapses, then wraps a highlight', async () => {
    vi.useFakeTimers();
    const { view, reader, frames } = await loadFlowSelectionBook();
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    const toolbar = visibleSelectionToolbar();
    expect(toolbar).not.toBeNull();
    expect(reader.dataset.selectionToolbar).toBe('open');

    frame.contentWindow!.getSelection()!.removeAllRanges();
    frameDocument.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(visibleSelectionToolbar()).not.toBeNull();

    toolbar!.querySelector<HTMLButtonElement>('.lightink-reader-selection-action--highlight')!.click();
    expect(visibleSelectionToolbar()).toBeNull();
    expect(reader.dataset.selectionToolbar).toBeUndefined();
    expect(
      frameDocument.querySelector('mark.lightink-reader-highlight[data-annotation-kind="highlight"]'),
    ).not.toBeNull();
    await view.destroy();
  });

  it('wraps a TXT highlight in the selected chapter instead of chapter 0', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [
          { title: 'Chapter 1', html: '<p>chapter 1 other body</p>' },
          { title: 'Chapter 2', html: '<p>chapter 2 selectable body</p>' },
          { title: 'Chapter 3', html: '<p>chapter 3 other body</p>' },
        ],
      }),
    });
    await view.load('book.txt');
    const frames = Array.from(
      host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame'),
    );
    for (const frame of frames) {
      Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 400 });
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    const chapterTwo = frames.find((frame) => frame.dataset.chapterIndex === '1') ?? frames[1]!;
    const chapterOne = frames.find((frame) => frame.dataset.chapterIndex === '0') ?? frames[0]!;
    const doc = chapterTwo.contentDocument!;
    stubRangeClientRect(doc);
    let paragraph = doc.querySelector('p');
    if (paragraph === null) {
      paragraph = doc.createElement('p');
      paragraph.textContent = 'chapter 2 selectable body';
      doc.body.appendChild(paragraph);
    }
    const node = paragraph.firstChild as Text;
    const start = (node.textContent ?? '').indexOf('selectable');
    const range = doc.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'selectable'.length);
    const selection = doc.defaultView!.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const toolbar = visibleSelectionToolbar();
    expect(toolbar).not.toBeNull();
    toolbar!.querySelector<HTMLButtonElement>('.lightink-reader-selection-action--highlight')!.click();
    expect(
      chapterTwo.contentDocument!.querySelector(
        'mark.lightink-reader-highlight[data-annotation-kind="highlight"]',
      ),
    ).not.toBeNull();
    expect(chapterOne.contentDocument!.querySelector('mark.lightink-reader-highlight')).toBeNull();
    await view.destroy();
  });

  it('clears the live selection so dismissing the toolbar does not bring it back', async () => {
    vi.useFakeTimers();
    const { view, frames } = await loadFlowSelectionBook();
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(visibleSelectionToolbar()).not.toBeNull();

    document.querySelector<HTMLElement>('.lightink-reader-selection-dismiss')!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    expect(visibleSelectionToolbar()).toBeNull();
    expect(frame.contentWindow!.getSelection()?.toString() ?? '').toBe('');

    frameDocument.dispatchEvent(new Event('selectionchange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(visibleSelectionToolbar()).toBeNull();
    await view.destroy();
  });

  it('does not turn the page when the click that finishes a selection lands in an edge zone', async () => {
    vi.useFakeTimers();
    const { view, frames } = await loadFlowSelectionBook(3);
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    Object.defineProperty(frame.contentWindow!, 'innerWidth', { configurable: true, value: 400 });
    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(visibleSelectionToolbar()).not.toBeNull();
    frameDocument.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 350, clientY: 100 }),
    );
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('0');
    expect(visibleSelectionToolbar()).not.toBeNull();
    await view.destroy();
  });

  it('does not turn the page when clicking a highlight in an edge zone', async () => {
    vi.useFakeTimers();
    const { view, frames } = await loadFlowSelectionBook(3);
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    Object.defineProperty(frame.contentWindow!, 'innerWidth', { configurable: true, value: 400 });
    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    visibleSelectionToolbar()!.querySelector<HTMLButtonElement>(
      '.lightink-reader-selection-action--highlight',
    )!.click();
    const mark = frameDocument.querySelector('mark.lightink-reader-highlight')!;
    expect(mark).not.toBeNull();
    mark.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 350, clientY: 100 }),
    );
    mark.firstChild?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 350, clientY: 100 }),
    );
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('0');
    await view.destroy();
  });

  it('dismisses the toolbar from a tap in the chapter without paging', async () => {
    vi.useFakeTimers();
    const { view, frames } = await loadFlowSelectionBook(3);
    const frame = frames[0]!;
    const frameDocument = frame.contentDocument!;
    Object.defineProperty(frame.contentWindow!, 'innerWidth', { configurable: true, value: 400 });
    selectFrameQuote(frame);
    frameDocument.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(visibleSelectionToolbar()).not.toBeNull();

    frameDocument.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        clientX: 200,
        clientY: 100,
      }),
    );
    expect(visibleSelectionToolbar()).toBeNull();
    expect(frame.contentWindow!.getSelection()?.toString() ?? '').toBe('');

    frameDocument.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: 350,
        clientY: 100,
      }),
    );
    frameDocument.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 350, clientY: 100 }),
    );
    expect(
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex,
    ).toBe('0');
    await view.destroy();
  });
});

describe('搜索会话接线（session-search 收口：世代失效/无命中空态）', () => {
  const loadSearchBook = async (
    chapters: Array<{ title: string; html: string }>,
  ): Promise<{ host: HTMLDivElement; view: ReturnType<typeof createReaderView> }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new TextEncoder().encode('unused'),
      parseContent: async () => ({ chapters }),
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    return { host, view };
  };

  it('新查询使旧结果世代失效：旧命中列表清空、不误跳章；无命中保持空态不报错', async () => {
    // jsdom 不解析 iframe srcdoc 正文（帧内 overlay 无法观察），帧内命中解包由
    // pdf-search.test.ts 的会话核心用例与共享幂等引擎用例覆盖；此处观察侧栏表面。
    const { host, view } = await loadSearchBook([
      { title: 'One', html: '<p>alpha keyword beta keyword</p>' },
      { title: 'Two', html: '<p>keyword again</p>' },
    ]);

    view.openSearch?.('keyword');
    const sidebar = host.querySelector<HTMLElement>('.lightink-reader-sidebar')!;
    expect(sidebar.hidden).toBe(false);
    await vi.waitFor(() => {
      expect(sidebar.querySelectorAll('.lightink-reader-sidebar-hit').length).toBeGreaterThan(0);
    });
    expect(view.state.current).toBe(1);

    // 新查询（全书无命中）：旧世代结果世代失效——命中列表被新会话整体取代。
    view.openSearch?.('全书都不存在的词');
    await vi.waitFor(() => {
      expect(sidebar.querySelectorAll('.lightink-reader-sidebar-hit')).toHaveLength(0);
    });
    expect(sidebar.hidden).toBe(false);
    expect(sidebar.classList.contains('is-searching')).toBe(true);
    await vi.waitFor(() => {
      expect(
        sidebar
          .querySelector<HTMLElement>('.lightink-reader-sidebar-search-status')
          ?.getAttribute('data-search-empty'),
      ).toBe('true');
    });
    expect(sidebar.querySelector('.lightink-reader-sidebar-more')).toBeNull();
    // 不误跳、不报错：阅读位置保持、阶段仍 ready。
    expect(view.state.current).toBe(1);
    expect(view.state.phase).toBe('ready');
    await view.destroy();
  });
});

describe('窗口级翻页与大纲跳转接线（session-navigation 经 reader-view 门面）', () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollIntoView',
  );

  const loadNavigationBook = async (
    chapterCount: number,
  ): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
    reader: HTMLElement;
    scroll: HTMLElement;
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
    const reader = host.querySelector<HTMLElement>('.lightink-reader')!;
    const scroll = host.querySelector<HTMLElement>('.lightink-reader-scroll')!;
    reader.dataset.readingLayout = 'scroll';
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    return { host, view, reader, scroll };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    // jsdom 未实现 scrollIntoView：滚动模式章节落位按 reader-load-lifecycle 先例打桩。
    if (originalScrollIntoView === undefined) {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    } else {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    }
  });

  it('窗口级翻页（滚动视口步进）：移动返回 true；首屏上翻/末屏下翻不越界', async () => {
    vi.useFakeTimers();
    const { view, scroll } = await loadNavigationBook(2);
    // 视口 400、全书 1200：两步到滚动末尾（max = 1200 - 400 = 800）。
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1200 });
    scroll.scrollTop = 0;

    expect(view.advanceReading(1)).toBe(true);
    expect(scroll.scrollTop).toBe(400);
    expect(view.advanceReading(1)).toBe(true);
    expect(scroll.scrollTop).toBe(800);
    // 末屏下翻：已在滚动末尾，返回 false 放行原生滚动（窗口级调用方不吞事件）。
    expect(view.advanceReading(1)).toBe(false);
    expect(scroll.scrollTop).toBe(800);
    // 首屏上翻：同理不越界。
    scroll.scrollTop = 0;
    expect(view.advanceReading(-1)).toBe(false);
    expect(scroll.scrollTop).toBe(0);
    await view.destroy();
  });

  it('大纲跳转按章落位：迟到恢复不回跳；无落点条目不跳转不报错', async () => {
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const { view } = await loadNavigationBook(3);
    expect(view.getOutline()).toHaveLength(3);
    expect(view.getOutline()[0]?.chapter).toBe(0); // flow 大纲为章节条目

    view.jumpToOutlineItem({ level: 1, text: 'Chapter 2', anchor: 1, chapter: 1 });
    await vi.advanceTimersByTimeAsync(0);
    const activeChapter = () =>
      document.querySelector<HTMLElement>('.lightink-reader-chapter.is-active')?.dataset.chapterIndex;
    expect(activeChapter()).toBe('1');

    // 无 page/chapter 落点的条目（无大纲条目时的防御调用）：不跳转、不报错。
    expect(() => view.jumpToOutlineItem({ level: 1, text: '无落点', anchor: 9 })).not.toThrow();
    expect(activeChapter()).toBe('1');
    await view.destroy();
  });
});

describe('导航会话接线（session-navigation：翻页模式门面路径）', () => {
  // 策略表规则（成员效果/rtl 翻转/跨族载荷 no-op）已由「导航会话策略表」用例
  // 经记账宿主直测；滚动模式边界与大纲落位由「窗口级翻页与大纲跳转接线」
  // 经门面覆盖。此处补翻页模式（偏好存储接线）的门面路径。
  const loadPaginatedBook = async (
    chapters: Array<{ title: string; html: string }>,
  ): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
    activeChapter: () => string | undefined;
  }> => {
    const store: Record<string, string> = { 'lightink.reader.flow.layout': 'paginated' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new TextEncoder().encode('unused'),
      parseContent: async () => ({ chapters }),
      preferenceStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      },
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    const activeChapter = () =>
      host
        .querySelector<HTMLElement>('.lightink-reader-chapter.is-active')
        ?.dataset.chapterIndex;
    return { host, view, activeChapter };
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('窗口级翻页经策略表：翻页模式步进移动活动章并返回 true', async () => {
    vi.useFakeTimers();
    const { view, activeChapter } = await loadPaginatedBook([
      { title: 'One', html: '<p>chapter one body</p>' },
      { title: 'Two', html: '<p>chapter two body</p>' },
    ]);
    expect(activeChapter()).toBe('0');
    expect(view.advanceReading(1)).toBe(true);
    expect(activeChapter()).toBe('1');
    expect(view.state.current).toBe(2);
    await view.destroy();
  });

  it('边界不越界：翻页模式首页上翻/末页下翻返回 false，阅读位置不动', async () => {
    vi.useFakeTimers();
    const { view, activeChapter } = await loadPaginatedBook([
      { title: 'Only', html: '<p>single short chapter</p>' },
    ]);
    expect(view.advanceReading(-1)).toBe(false); // 首页上翻
    expect(view.advanceReading(1)).toBe(false); // 末页下翻（无下一章）
    expect(activeChapter()).toBe('0');
    expect(view.state.current).toBe(1);
    expect(view.state.phase).toBe('ready');
    await view.destroy();
  });
});

describe('chrome 书签开关与页内角标（R1）', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('书签按钮开关当前章书签：按钮两态、章角丝带角标、存储写入 tombstone', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const writeAnnotations = vi.fn(async (_contentHash: string, _json: string) => undefined);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: Array.from({ length: 4 }, (_, index) => ({
          title: `Chapter ${index + 1}`,
          html: `<p>chapter ${index + 1} body</p>`,
        })),
      }),
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => '',
      writeAnnotations,
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);

    // 跳到第 2 章再开关书签（刻度避开轨道端点圆帽）。
    view.jumpToOutlineItem({ level: 1, text: 'Chapter 2', anchor: 1, chapter: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.state.current).toBe(2);

    const bookmarkButton = host.querySelector<HTMLButtonElement>(
      '[data-reader-chrome-action="bookmark"]',
    );
    expect(bookmarkButton).not.toBeNull();
    expect(view.isBookmarked?.()).toBe(false);

    bookmarkButton!.click();
    expect(view.isBookmarked?.()).toBe(true);
    expect(bookmarkButton!.getAttribute('aria-pressed')).toBe('true');
    expect(bookmarkButton!.classList.contains('is-bookmarked')).toBe(true);
    await vi.waitFor(() => expect(writeAnnotations).toHaveBeenCalledTimes(1));
    const first = JSON.parse(writeAnnotations.mock.calls[0]![1] as string) as {
      version: number;
      annotations: Array<Record<string, unknown>>;
    };
    expect(first.version).toBe(3);
    expect(first.annotations[0]).toMatchObject({
      kind: 'bookmark',
      locator: { format: 'flow', chapter: 1 },
    });

    // 页内持久指示：当前章渲染丝带角标。
    const article = host.querySelector<HTMLElement>(
      '.lightink-reader-chapter[data-chapter-index="1"]',
    );
    expect(article?.querySelector('.lightink-reader-bookmark-ribbon')).not.toBeNull();
    // 进度轨出现书签刻度（0.25，区别于章节刻度）。
    const tick = host.querySelector<HTMLButtonElement>('.lightink-reader-chrome-tick--bookmark');
    expect(tick).not.toBeNull();
    expect(tick!.style.left).toBe('25%');

    // 再点一次 = 取消：tombstone 写入，角标与刻度消失。
    bookmarkButton!.click();
    expect(view.isBookmarked?.()).toBe(false);
    expect(bookmarkButton!.getAttribute('aria-pressed')).toBe('false');
    await vi.waitFor(() => expect(writeAnnotations).toHaveBeenCalledTimes(2));
    const second = JSON.parse(writeAnnotations.mock.calls[1]![1] as string) as {
      annotations: Array<Record<string, unknown>>;
    };
    expect(second.annotations).toHaveLength(1);
    expect(second.annotations[0]?.deletedAt).toEqual(expect.any(Number));
    expect(article?.querySelector('.lightink-reader-bookmark-ribbon')).toBeNull();
    expect(host.querySelector('.lightink-reader-chrome-tick--bookmark')).toBeNull();
    await view.destroy();
  });

  it('进度轨书签刻度点击跳转到对应书签位置', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    cbzMock.renderCbzInto.mockImplementation(async (_source: unknown, stagedHost: HTMLElement) => {
      for (let index = 0; index < 4; index += 1) {
        const slot = document.createElement('div');
        slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
        slot.dataset.pageIndex = String(index);
        stagedHost.appendChild(slot);
      }
      return {
        totalPages: 4,
        currentPage: 1,
        metadata: { pages: [] },
        preferences: { mode: 'paged', direction: 'ltr', spread: 'single', fit: 'width', cropMargins: false },
        scrollToPage: vi.fn(),
        scrollToProgress: vi.fn(),
        nextPage: vi.fn(() => true),
        previousPage: vi.fn(() => true),
        setPreferences: vi.fn(),
        hideChrome: vi.fn(() => false),
        adjustZoom: vi.fn(),
        destroy: vi.fn(async () => undefined),
      };
    });
    const stored = JSON.stringify({
      version: 3,
      annotations: [
        {
          id: 'bm3',
          kind: 'bookmark',
          locator: { format: 'cbz', page: 3 },
          createdAt: 1,
        },
      ],
    });
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([0x89, 0x50]),
      readAnnotations: async () => stored,
    });
    await view.load('/comics/vol.cbz');
    await vi.advanceTimersByTimeAsync(50);

    // 书签页角标落在第 3 页 slot（页角，不侵入正文位图）。
    expect(
      host.querySelector(
        '.lightink-reader-page-slot[data-page-index="2"] .lightink-reader-bookmark-ribbon',
      ),
    ).not.toBeNull();
    expect(
      host.querySelector(
        '.lightink-reader-page-slot[data-page-index="0"] .lightink-reader-bookmark-ribbon',
      ),
    ).toBeNull();

    // 书签刻度点击 → 跳到对应书签页。
    const tick = host.querySelector<HTMLButtonElement>('.lightink-reader-chrome-tick--bookmark');
    expect(tick).not.toBeNull();
    tick!.click();
    const handle = (await cbzMock.renderCbzInto.mock.results[0]?.value) as {
      scrollToPage: ReturnType<typeof vi.fn>;
    };
    expect(handle.scrollToPage).toHaveBeenCalledWith(3);
    await view.destroy();
    cbzMock.renderCbzInto.mockReset();
  });
});

describe('标注渲染跳过 tombstone（v3 删除语义）', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('flow 渲染循环不渲染 tombstone 高亮，tombstone 书签不出角标', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const stored = JSON.stringify({
      version: 3,
      annotations: [
        {
          id: 'live1',
          kind: 'highlight',
          locator: {
            format: 'flow',
            chapter: 0,
            start: 0,
            end: 7,
            quote: 'chapter',
            prefix: '',
            suffix: ' 1 body',
          },
          quote: 'chapter',
          createdAt: 1,
        },
        // tombstone：定位完全可解析，若不跳过必然出 mark。
        {
          id: 'dead1',
          kind: 'highlight',
          locator: {
            format: 'flow',
            chapter: 0,
            start: 10,
            end: 14,
            quote: 'body',
            prefix: 'chapter 1 ',
            suffix: '',
          },
          quote: 'body',
          createdAt: 1,
          deletedAt: 2,
        },
        {
          id: 'dead-bookmark',
          kind: 'bookmark',
          locator: {
            format: 'flow',
            chapter: 0,
            start: 0,
            end: 0,
            quote: '',
            prefix: '',
            suffix: '',
          },
          createdAt: 1,
          deletedAt: 3,
        },
      ],
    });
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [{ title: 'Chapter 1', html: '<p>chapter 1 body</p>' }],
      }),
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => stored,
      // 滚动模式：refreshViewport 经 remasureScrollFrames 重跑渲染循环。
      preferenceStorage: {
        getItem: (key) => (key === 'lightink.reader.flow.layout' ? 'scroll' : null),
        setItem: () => undefined,
      },
    });
    await view.load('book.epub');
    const frame = host.querySelector<HTMLIFrameElement>('.lightink-reader-chapter-frame')!;
    // jsdom 不把 srcdoc 解析进 iframe 文档，且帧插入即自动绑定 load（正文为空）。
    // 注入正文后由 refreshViewport 重跑渲染循环落位。
    const frameDocument = frame.contentDocument!;
    const paragraph = frameDocument.createElement('p');
    paragraph.textContent = 'chapter 1 body';
    frameDocument.body.appendChild(paragraph);
    view.refreshViewport?.();
    await vi.advanceTimersByTimeAsync(50);

    expect(frameDocument.querySelector('mark[data-annotation-id="live1"]')).not.toBeNull();
    expect(frameDocument.querySelector('mark[data-annotation-id="dead1"]')).toBeNull();
    expect(host.querySelector('.lightink-reader-bookmark-ribbon')).toBeNull();
    await view.destroy();
  });
});

describe('阅读活动信号接线（进度 v2 noteActivity）', () => {
  afterEach(() => {
    vi.useRealTimers();
    cbzMock.renderCbzInto.mockReset();
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
  });

  it('空闲超时后点击阅读面恢复阅读时长累计', async () => {
    const store: Record<string, string> = {};
    cbzMock.renderCbzInto.mockResolvedValue({
      totalPages: 3,
      currentPage: 1,
      metadata: { pages: [] },
      preferences: { mode: 'paged', direction: 'ltr', spread: 'single', fit: 'width', cropMargins: false },
      scrollToPage: vi.fn(),
      scrollToProgress: vi.fn(),
      nextPage: vi.fn(() => true),
      previousPage: vi.fn(() => true),
      setPreferences: vi.fn(),
      hideChrome: vi.fn(() => false),
      adjustZoom: vi.fn(),
      destroy: vi.fn(async () => undefined),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([0x89, 0x50]),
      readAnnotations: async () => '',
      progressStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
      },
    });
    await view.load('/comics/vol.cbz'); // 真实计时器完成装载

    vi.useFakeTimers();
    vi.advanceTimersByTime(3 * 60 * 1000); // 超过 2 分钟空闲阈值：计时暂停
    const reader = host.querySelector<HTMLElement>('.lightink-reader')!;
    reader.dispatchEvent(new MouseEvent('click', { bubbles: true })); // 输入信号恢复计时
    vi.advanceTimersByTime(1000);
    await view.destroy();

    const stored = JSON.parse(
      store['lightink.reader.progress./comics/vol.cbz'] ?? 'null',
    ) as { readingMs?: number } | null;
    expect(stored).not.toBeNull();
    // 初始活跃窗口 2 分钟 + 点击后的 1 秒；无点击接线则只有 120000。
    expect(stored!.readingMs).toBeGreaterThanOrEqual(120000 + 1000);
  });
});


describe('触屏 chrome 面板 pin 释放（touchSheetPins/键盘观察者对称收尾）', () => {
  const loadTouchBook = async (): Promise<{
    host: HTMLDivElement;
    view: ReturnType<typeof createReaderView>;
  }> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array(),
      parseContent: async () => ({
        chapters: [
          { title: 'Chapter 1', html: '<p>chapter 1 body</p>' },
          { title: 'Chapter 2', html: '<p>chapter 2 body</p>' },
        ],
      }),
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => '',
      writeAnnotations: async () => undefined,
    });
    await view.load('book.epub');
    for (const frame of host.querySelectorAll<HTMLIFrameElement>('.lightink-reader-chapter-frame')) {
      frame.dispatchEvent(new Event('load'));
    }
    await vi.advanceTimersByTimeAsync(50);
    return { host, view };
  };

  const chromeAction = (action: string): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>(
      `[data-reader-chrome-action="${action}"]`,
    );
    expect(button).not.toBeNull();
    return button!;
  };

  const flushKeyboardMutation = async (): Promise<void> => {
    document.documentElement.setAttribute('data-keyboard', '');
    await vi.advanceTimersByTimeAsync(0);
    document.documentElement.removeAttribute('data-keyboard');
    await vi.advanceTimersByTimeAsync(0);
  };

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-touch-primary');
    document.documentElement.removeAttribute('data-android');
    document.documentElement.removeAttribute('data-keyboard');
    delete document.documentElement.dataset.readingLayout;
  });

  it('关闭 chrome 面板即 unpin：键盘切换不再回写已关闭的 sheet', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-touch-primary', '');
    const { view } = await loadTouchBook();

    chromeAction('toc').click();
    const tocPanel = document.querySelector<HTMLElement>('.lightink-reader-chrome-toc');
    expect(tocPanel).not.toBeNull();
    expect(tocPanel!.hidden).toBe(false);
    expect(tocPanel!.classList.contains('is-touch-sheet')).toBe(true);
    expect(tocPanel!.style.position).toBe('fixed');

    // 再点同一动作 = closeChromePanel：pin 对称释放（类与内联几何清理）。
    chromeAction('toc').click();
    expect(tocPanel!.hidden).toBe(true);
    expect(tocPanel!.classList.contains('is-touch-sheet')).toBe(false);
    expect(tocPanel!.style.position).toBe('');
    expect(tocPanel!.style.bottom).toBe('');

    // 最后一个 pin 已释放 → 键盘 MutationObserver disconnect，不再触碰已关闭面板。
    await flushKeyboardMutation();
    expect(tocPanel!.classList.contains('is-touch-sheet')).toBe(false);
    expect(tocPanel!.style.position).toBe('');
    expect(tocPanel!.style.top).toBe('');
    expect(tocPanel!.style.bottom).toBe('');
    await view.destroy();
  });

  it('destroy 释放仍 pinned 的 chrome 面板与标注侧栏', async () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute('data-touch-primary', '');
    const { view } = await loadTouchBook();

    chromeAction('typography').click();
    const typePanel = document.querySelector<HTMLElement>('.lightink-reader-chrome-typography');
    expect(typePanel).not.toBeNull();
    expect(typePanel!.hidden).toBe(false);
    expect(typePanel!.classList.contains('is-touch-sheet')).toBe(true);
    expect(typePanel!.style.position).toBe('fixed');

    view.toggleSidebar();
    await vi.advanceTimersByTimeAsync(0);
    const sidebar = document.querySelector<HTMLElement>('.lightink-reader-annotation-panel');
    expect(sidebar).not.toBeNull();
    expect(sidebar!.hidden).toBe(false);
    expect(sidebar!.classList.contains('is-touch-sheet')).toBe(true);

    // 面板与侧栏均 pinned 时销毁：模块级 Map 清空、键盘观察者 disconnect。
    await view.destroy();
    expect(typePanel!.classList.contains('is-touch-sheet')).toBe(false);
    expect(typePanel!.style.position).toBe('');
    expect(sidebar!.classList.contains('is-touch-sheet')).toBe(false);
    expect(sidebar!.style.position).toBe('');

    await flushKeyboardMutation();
    expect(typePanel!.style.top).toBe('');
    expect(sidebar!.style.top).toBe('');
  });
});
