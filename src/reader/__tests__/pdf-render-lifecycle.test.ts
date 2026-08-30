// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: {} as { workerSrc?: string },
  textLayerInstances: [] as MockTextLayer[],
}));

interface MockTextLayerOptions {
  readonly container: HTMLElement;
  readonly viewport: { width: number; height: number };
  readonly textContentSource: unknown;
}

class MockTextLayer {
  readonly container: HTMLElement;
  readonly cancel = vi.fn(() => undefined);
  readonly render: ReturnType<typeof vi.fn>;
  readonly #renderPromise: Promise<void>;
  #resolveRender!: () => void;
  #rejectRender!: (error: unknown) => void;

  constructor(readonly options: MockTextLayerOptions) {
    this.container = options.container;
    this.#renderPromise = new Promise<void>((resolve, reject) => {
      this.#resolveRender = resolve;
      this.#rejectRender = reject;
    });
    this.render = vi.fn(() => this.#renderPromise);
    pdfRuntime.textLayerInstances.push(this);
  }

  resolveRender(): void {
    this.#resolveRender();
  }

  rejectRender(error: unknown): void {
    this.#rejectRender(error);
  }
}

class MockPDFDataRangeTransport {
  readonly received: Array<{ begin: number; chunk: Uint8Array | null }> = [];

  constructor(
    readonly length: number,
    readonly initialData: Uint8Array | null,
  ) {}

  onDataRange(begin: number, chunk: Uint8Array | null): void {
    this.received.push({ begin, chunk });
  }

  requestDataRange(_begin: number, _end: number): void {}
  abort(): void {}
}

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: pdfRuntime.workerOptions,
  getDocument: pdfRuntime.getDocument,
  TextLayer: MockTextLayer,
  PDFDataRangeTransport: MockPDFDataRangeTransport,
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));

import { renderPdfInto } from '../formats/pdf.js';

interface ControlledRenderTask {
  readonly promise: Promise<void>;
  readonly cancel: ReturnType<typeof vi.fn>;
  resolve(): void;
}

function renderTask(): ControlledRenderTask {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const cancel = vi.fn(() => {
    reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
  });
  return { promise, cancel, resolve };
}

class IdleIntersectionObserver {
  constructor(_callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  globalThis.IntersectionObserver =
    IdleIntersectionObserver as unknown as typeof IntersectionObserver;
  document.documentElement.style.setProperty('--lightink-font-scale', '1');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  pdfRuntime.getDocument.mockReset();
  pdfRuntime.textLayerInstances.length = 0;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  delete document.documentElement.dataset.readingLayout;
  document.body.replaceChildren();
});

function mockPdf(): {
  readonly tasks: ControlledRenderTask[];
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getTextContent: ReturnType<typeof vi.fn>;
} {
  const tasks: ControlledRenderTask[] = [];
  const getTextContent = vi.fn(async () => ({ items: [], styles: {} }));
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    getTextContent,
    render: vi.fn(() => {
      const task = renderTask();
      tasks.push(task);
      return task;
    }),
  };
  const destroy = vi.fn(async () => undefined);
  pdfRuntime.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => page),
      getOutline: vi.fn(async () => []),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
    }),
    destroy,
  });
  return { tasks, destroy, getTextContent };
}

/** 多页文档 mock：numPages 可指定。 */
function mockMultiPagePdf(numPages: number): {
  readonly tasks: ControlledRenderTask[];
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const tasks: ControlledRenderTask[] = [];
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    getTextContent: vi.fn(async () => ({ items: [], styles: {} })),
    render: vi.fn(() => {
      const task = renderTask();
      tasks.push(task);
      return task;
    }),
  };
  const destroy = vi.fn(async () => undefined);
  pdfRuntime.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages,
      getPage: vi.fn(async () => page),
      getOutline: vi.fn(async () => []),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
    }),
    destroy,
  });
  return { tasks, destroy };
}

/**
 * 给 container/slot 布置几何：viewport 固定 [top, top+600]，slot i 的 top 依次
 * 为 tops[i]。jsdom 的 getBoundingClientRect 恒为 0，必须按元素覆写才能模拟滚动布局。
 */
function layoutRects(
  container: HTMLElement,
  viewportTop: number,
  slotTops: readonly number[],
): void {
  const viewport = { top: viewportTop, bottom: viewportTop + 600, left: 0, right: 800, width: 800, height: 600, x: 0, y: viewportTop, toJSON: () => ({}) };
  container.getBoundingClientRect = () => viewport as DOMRect;
  const slots = [...container.children] as HTMLElement[];
  slotTops.forEach((top, i) => {
    const rect = { top, bottom: top + 500, left: 0, right: 800, width: 800, height: 500, x: 0, y: top, toJSON: () => ({}) };
    slots[i]!.getBoundingClientRect = () => rect as DOMRect;
  });
}

async function waitForTask(tasks: readonly ControlledRenderTask[], count: number): Promise<void> {
  await vi.waitFor(() => expect(tasks).toHaveLength(count));
}

describe('PDF render lifecycle', () => {
  it('uses PDF.js range transport for a random-access source', async () => {
    mockPdf();
    const bytes = new Uint8Array(1024).map((_value, index) => index % 251);
    const source = {
      size: bytes.length,
      identity: { id: 'remote-pdf' },
      readRange: vi.fn(async (offset: number, length: number) =>
        bytes.slice(offset, offset + length),
      ),
      close: vi.fn(async () => undefined),
    };
    const container = document.createElement('div');
    const handle = await renderPdfInto(source, container);

    const options = pdfRuntime.getDocument.mock.calls[0]?.[0] as {
      data?: Uint8Array;
      range: MockPDFDataRangeTransport;
      disableStream: boolean;
      disableAutoFetch: boolean;
    };
    expect(options.data).toBeUndefined();
    expect(options.disableStream).toBe(true);
    expect(options.disableAutoFetch).toBe(true);
    options.range.requestDataRange(128, 384);
    await vi.waitFor(() => expect(source.readRange).toHaveBeenCalledWith(128, 256, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(options.range.received).toEqual([
      { begin: 128, chunk: bytes.slice(128, 384) },
    ]));

    await handle.destroy();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('cancels the previous render when zoom requests overlap', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const first = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    handle.controller.zoomIn();
    const second = handle.rerender();
    await waitForTask(runtime.tasks, 2);

    expect(runtime.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    runtime.tasks[1]!.resolve();
    await Promise.all([first, second]);
    await handle.destroy();
  });

  it('cancels active page work and destroys pdf.js resources on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    handle.controller.zoomIn();
    const rerender = handle.rerender();
    await waitForTask(runtime.tasks, 1);

    await handle.destroy();
    await rerender;
    expect(runtime.tasks[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the zoom anchor centered when the scroller sits below app chrome', async () => {
    // 回归：锚点补偿必须用相对 scroller 的坐标。scroller 视口顶在 y=100（标签栏
    // 偏移），slot 覆盖视口中心；等比 rerender 后 scrollTop 应保持不变——旧实现
    // 用视口绝对坐标会把 100px chrome 偏移加进新滚动位置。
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    layoutRects(container, 100, [200]);
    container.scrollTop = 0;

    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;
    // jsdom clientHeight=0：newScroll = relTop(200-100) + 500*0.4 = 300。
    // 未归一化时视口绝对坐标会再加 100px chrome 偏移（= 400）。
    expect(container.scrollTop).toBe(300);
    await handle.destroy();
  });

  it('paints the first screen after slots exist without waiting for IntersectionObserver', async () => {
    const runtime = mockMultiPagePdf(3);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    layoutRects(container, 0, [0, 700, 1400]);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await vi.waitFor(() => {
      const first = container.children[0] as HTMLElement;
      expect(first.querySelector('canvas')).not.toBeNull();
    });
    await handle.destroy();
  });

  it('in paginated layout paints later pages from the page-host scroller, not an ancestor', async () => {
    document.documentElement.dataset.readingLayout = 'paginated';
    const observedRoots: Array<Element | Document | null> = [];
    class CapturingObserver {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observedRoots.push((options?.root as Element | Document | null) ?? null);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
    }
    globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

    const runtime = mockMultiPagePdf(4);
    const editorArea = document.createElement('div');
    editorArea.id = 'lightink-editor-area';
    const reader = document.createElement('div');
    reader.className = 'lightink-reader';
    const container = document.createElement('div');
    container.className = 'lightink-reader-pages';
    container.dataset.readerFormat = 'pdf';
    reader.appendChild(container);
    editorArea.appendChild(reader);
    document.body.appendChild(editorArea);

    const handle = await renderPdfInto(new Uint8Array([1]), container);
    expect(observedRoots[0]).toBe(container);

    // 页宿主视口 [0,600]；第 4 页 top=2800 在 ±2 屏缓冲外。
    layoutRects(container, 0, [0, 700, 1400, 2800]);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await vi.waitFor(() => expect(runtime.tasks).toHaveLength(3));
    for (const task of runtime.tasks) task.resolve();
    await vi.waitFor(() => {
      expect((container.children[0] as HTMLElement).querySelector('canvas')).not.toBeNull();
    });
    expect((container.children[3] as HTMLElement).querySelector('canvas')).toBeNull();

    // 祖先滚动不改变页宿主视口：rerender 仍不画第 4 页。
    reader.getBoundingClientRect = () =>
      ({
        top: -2100,
        bottom: -1500,
        left: 0,
        right: 800,
        width: 800,
        height: 600,
        x: 0,
        y: -2100,
        toJSON: () => ({}),
      }) as DOMRect;
    const afterAncestor = handle.rerender();
    await waitForTask(runtime.tasks, 4);
    runtime.tasks[3]!.resolve();
    await vi.waitFor(() => expect(runtime.tasks).toHaveLength(6));
    for (const task of runtime.tasks.slice(3)) task.resolve();
    await afterAncestor;
    expect((container.children[3] as HTMLElement).querySelector('canvas')).toBeNull();

    // 页宿主视口滚到第 4 页后必须画出该页。
    layoutRects(container, 0, [-2100, -1400, -700, 0]);
    const afterHost = handle.rerender();
    await vi.waitFor(() => {
      expect((container.children[3] as HTMLElement).querySelector('canvas')).not.toBeNull();
    });
    for (const task of runtime.tasks.slice(6)) task.resolve();
    await afterHost;
    await handle.destroy();
  });

  it('keeps PDF overflow on the page host so IntersectionObserver can see later slots', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader-pages\[data-reader-format='pdf'\]\[data-reader-active='true'\][\s\S]*?\{[^}]*overflow:\s*auto/,
    );
    expect(css).not.toMatch(
      /html\[data-reading-layout='paginated'\] \.lightink-reader:has\([^)]*\)\s*\{[^}]*overflow:\s*auto/,
    );
  });

  it('uses the page host as observer root even when html is paginated and editor-area exists', async () => {
    document.documentElement.dataset.readingLayout = 'paginated';
    const observedRoots: Array<Element | Document | null> = [];
    class CapturingObserver {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observedRoots.push((options?.root as Element | Document | null) ?? null);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
    }
    globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;
    mockMultiPagePdf(2);
    const editorArea = document.createElement('div');
    editorArea.id = 'lightink-editor-area';
    const container = document.createElement('div');
    container.className = 'lightink-reader-pages';
    container.dataset.readerFormat = 'pdf';
    editorArea.appendChild(container);
    document.body.appendChild(editorArea);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    expect(observedRoots[0]).toBe(container);
    expect(observedRoots[0]).not.toBe(editorArea);
    await handle.destroy();
  });

  it('uses the page host as observer root even when html is scroll and editor-area exists', async () => {
    document.documentElement.dataset.readingLayout = 'scroll';
    const observedRoots: Array<Element | Document | null> = [];
    class CapturingObserver {
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observedRoots.push((options?.root as Element | Document | null) ?? null);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
    }
    globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;
    mockMultiPagePdf(2);
    const editorArea = document.createElement('div');
    editorArea.id = 'lightink-editor-area';
    const container = document.createElement('div');
    container.className = 'lightink-reader-pages';
    container.dataset.readerFormat = 'pdf';
    editorArea.appendChild(container);
    document.body.appendChild(editorArea);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    expect(observedRoots[0]).toBe(container);
    expect(observedRoots[0]).not.toBe(editorArea);
    await handle.destroy();
  });

  it('re-renders pages inside the lazy-render buffer, not only the strict viewport', async () => {
    // 回归：缩放后 rerender 清掉所有画布；IntersectionObserver 只在相交状态变化时
    // 派发事件，仍在 ±2 屏缓冲区内的页不会收到通知。rerender 必须把这些页一并重画，
    // 否则缩放后滚动会出现空白页（用户可见为“缺页/页间距异常大”）。
    const runtime = mockMultiPagePdf(5);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    // viewport [0,600]；缓冲区 = ±2 屏（±1200）。第 3 页 top=1400 严格视口外、缓冲区内；
    // 第 4 页 top=2100 缓冲区外（滚动进入时应由 observer 懒补，rerender 不管）。
    layoutRects(container, 0, [0, 700, 1400, 2100, 2800]);

    const rerendering = handle.rerender();
    // 严格可见的第 1 页串行先画；解开它的任务让循环继续走完缓冲区补画。
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await vi.waitFor(() => {
      const slots = [...container.children] as HTMLElement[];
      expect(slots[2]!.querySelector('canvas')).not.toBeNull(); // 缓冲区内的第 3 页必须重画
    });
    // 只渲染视口 + 缓冲区内的 1–3 页；第 4/5 页留给 observer。
    await vi.waitFor(() => expect(runtime.tasks).toHaveLength(3));
    const slots = [...container.children] as HTMLElement[];
    expect(slots[3]!.querySelector('canvas')).toBeNull();
    expect(slots[4]!.querySelector('canvas')).toBeNull();
    for (const task of runtime.tasks) task.resolve();
    await rerendering;
    await handle.destroy();
  });
});

describe('PDF text layer', () => {
  it('builds a text layer with a css-scale viewport and cancels it on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn(); // 1.25
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    expect(layer.container.classList.contains('lightink-reader-text-layer')).toBe(true);
    expect(layer.container.parentElement?.className).toBe('lightink-reader-page-slot');
    // 文本层用 CSS 尺寸 viewport（controller.scale × 字号，不含 dpr）。
    expect(layer.options.viewport.width).toBe(100 * 1.25);
    expect(layer.container.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    layer.resolveRender();
    await handle.destroy();
  });

  it('cancels an in-flight text layer on teardown', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    await handle.destroy(); // render 仍 pending
    expect(layer.cancel).toHaveBeenCalledTimes(1);
    layer.resolveRender();
  });

  it('degrades to canvas-only when the text layer render fails', async () => {
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.controller.zoomIn();
    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    layer.rejectRender(new Error('text layer boom'));

    await vi.waitFor(() => {
      const slot = container.querySelector('.lightink-reader-page-slot');
      expect(slot?.querySelector('.lightink-reader-text-layer')).toBeNull();
      expect(slot?.querySelector('canvas')).not.toBeNull();
    });
    await handle.destroy();
  });

  it('multiplies the text-layer viewport by the reading font scale', async () => {
    document.documentElement.style.setProperty('--lightink-font-scale', '1.25');
    const runtime = mockPdf();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const rerendering = handle.rerender();
    await waitForTask(runtime.tasks, 1);
    runtime.tasks[0]!.resolve();
    await rerendering;

    await vi.waitFor(() => expect(pdfRuntime.textLayerInstances).toHaveLength(1));
    const layer = pdfRuntime.textLayerInstances[0]!;
    expect(layer.options.viewport.width).toBe(100 * 1.25);
    expect(layer.container.style.getPropertyValue('--total-scale-factor')).toBe('1.25');
    layer.resolveRender();
    await handle.destroy();
  });
});
