// @vitest-environment jsdom

/**
 * PDF 渲染内核（官方组件层）生命周期测试。
 *
 * mock 策略（叶子替换，引导链路走真代码）：
 * - `vi.mock('pdfjs-dist')` / `vi.mock('pdfjs-dist/web/pdf_viewer.mjs')`：主库与
 *   组件层都替换为轻量 mock，`pdfjs-boot` 的真实引导代码在 mock 之上运行——
 *   worker/组件层一次拿到、装配参数与顺序都可断言。真 pdfjs-dist 永不进模块
 *   缓存，因此本文件不需要 T1 的带 query 独立 URL 规避（也不用 vi.resetModules）。
 * - `pdf-worker-entry` 与 `text-layer-selection` 同样 mock；`pdfjs-boot` 不 mock。
 *
 * 打开链路（range transport / browserLocal 整读 / 同源 boot / useWasm 与
 * useWorkerFetch 关闭）断言与旧内核期一致；渲染管线断言改为钉官方装配接缝：
 * 先 append `div.pdfViewer` 再构造 PDFViewer、构造参数、setDocument、
 * pagesinit→fitWidth→currentScale、pagechanging 页码回写（含触底钳制）、
 * scrollToPage 映射、rerender 重设 scale、destroy 对称作废（监听摘除/
 * setDocument(null) 官方清空/loadingTask.destroy 恰一次/源关闭/viewer DOM
 * 移除）与 grep 型负例。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pdfRuntime = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerOptions: {} as { workerSrc?: string },
}));

/** 官方组件层 mock 的运行时记录（EventBus/PDFViewer/PDFLinkService 实例）。 */
const viewerRuntime = vi.hoisted(() => ({
  eventBuses: [] as unknown[],
  viewers: [] as unknown[],
  linkServices: [] as unknown[],
  scaleSets: [] as number[],
}));

const textLayerRuntime = vi.hoisted(() => ({ bind: vi.fn() }));

type BusListener = (data: unknown) => void;

/** 官方 EventBus 的行为镜像：on/off/dispatch + { signal } 摘除语义。 */
class MockEventBus {
  readonly listeners = new Map<string, BusListener[]>();

  constructor() {
    viewerRuntime.eventBuses.push(this);
  }

  on(eventName: string, listener: BusListener, options?: { signal?: AbortSignal } | null): void {
    const signal = options?.signal;
    if (signal instanceof AbortSignal) {
      if (signal.aborted) {
        return;
      }
      signal.addEventListener('abort', () => this.off(eventName, listener));
    }
    const list = this.listeners.get(eventName) ?? [];
    list.push(listener);
    this.listeners.set(eventName, list);
  }

  off(eventName: string, listener: BusListener): void {
    const list = this.listeners.get(eventName);
    if (list === undefined) {
      return;
    }
    const index = list.indexOf(listener);
    if (index >= 0) {
      list.splice(index, 1);
    }
  }

  dispatch(eventName: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(eventName) ?? [])]) {
      listener(data);
    }
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.length ?? 0;
  }
}

class MockPDFLinkService {
  constructor(readonly options: { eventBus?: MockEventBus } = {}) {
    viewerRuntime.linkServices.push(this);
  }
}

interface MockPageView {
  width: number;
  scale: number;
  textLayer: { div: HTMLDivElement } | null;
}

interface CapturedViewerOptions {
  container: HTMLElement;
  viewer?: HTMLDivElement;
  eventBus: MockEventBus;
  linkService?: MockPDFLinkService;
  textLayerMode?: number;
  enableSelectionRendering?: boolean;
  abortSignal?: AbortSignal;
}

class MockPDFViewer {
  readonly options: CapturedViewerOptions;
  /** 构造器求值时宿主是否已含 .pdfViewer 子元素（装配顺序合同）。 */
  readonly hadViewerChildAtConstruction: boolean;
  readonly setDocument = vi.fn((pdfDocument: unknown): void => {
    this.pdfDocument = pdfDocument;
  });
  readonly cleanup = vi.fn();
  readonly scrollPageIntoView = vi.fn();
  pageViews: MockPageView[] = [{ width: 160, scale: 1, textLayer: null }];
  pdfDocument: unknown = null;
  #currentScale = 1;

  constructor(options: CapturedViewerOptions) {
    this.options = options;
    this.hadViewerChildAtConstruction =
      options.container.querySelector(':scope > .pdfViewer') !== null;
    viewerRuntime.viewers.push(this);
  }

  get currentScale(): number {
    return this.#currentScale;
  }

  set currentScale(value: number) {
    this.#currentScale = value;
    viewerRuntime.scaleSets.push(value);
  }

  getPageView(index: number): MockPageView | undefined {
    return this.pageViews[index];
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
  PDFDataRangeTransport: MockPDFDataRangeTransport,
  PDFWorker: class MockPDFWorker {
    constructor(public readonly options: { port?: unknown } = {}) {}
    destroy(): void {}
  },
}));

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: MockEventBus,
  PDFLinkService: MockPDFLinkService,
  PDFViewer: MockPDFViewer,
}));

vi.mock('../formats/pdf-worker-entry.ts', () => ({
  pdfWorkerSrc: vi.fn(() => 'mock-boot-worker.js'),
  preparePdfjsWorker: vi.fn(async () => undefined),
  PDF_WORKER_BOOT_DEV_PATH: '/__lightink/pdf.worker.boot.mjs',
  PDF_WORKER_DEV_PATH: '/__lightink/pdf.worker.min.mjs',
}));

vi.mock('../text-layer-selection.js', () => ({
  bindTextLayerSelection: textLayerRuntime.bind,
}));

import { createReaderView } from '../reader-view.js';
import { renderPdfInto } from '../formats/pdf.js';

beforeEach(() => {
  viewerRuntime.eventBuses.length = 0;
  viewerRuntime.viewers.length = 0;
  viewerRuntime.linkServices.length = 0;
  viewerRuntime.scaleSets.length = 0;
  textLayerRuntime.bind.mockReset();
  textLayerRuntime.bind.mockImplementation(() => vi.fn());
  document.documentElement.style.setProperty('--lightink-font-scale', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  pdfRuntime.getDocument.mockReset();
  delete document.documentElement.dataset.readingLayout;
  document.body.replaceChildren();
});

function mockPdf(numPages = 1): {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getPage: ReturnType<typeof vi.fn>;
} {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 100 * scale,
      height: 200 * scale,
    }),
    getTextContent: vi.fn(async () => ({ items: [], styles: {} })),
  };
  const destroy = vi.fn(async () => undefined);
  const getPage = vi.fn(async () => page);
  pdfRuntime.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages,
      getPage,
      getOutline: vi.fn(async () => []),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
    }),
    destroy,
  });
  return { destroy, getPage };
}

/** 最近一次装配的 viewer（renderPdfInto 返回后调用）。 */
function lastViewer(): MockPDFViewer {
  const viewer = viewerRuntime.viewers[viewerRuntime.viewers.length - 1] as
    | MockPDFViewer
    | undefined;
  if (viewer === undefined) {
    throw new Error('renderPdfInto has not assembled a PDFViewer yet');
  }
  return viewer;
}

/** 最近一条 EventBus。 */
function lastEventBus(): MockEventBus {
  const bus = viewerRuntime.eventBuses[viewerRuntime.eventBuses.length - 1] as
    | MockEventBus
    | undefined;
  if (bus === undefined) {
    throw new Error('renderPdfInto has not created an EventBus yet');
  }
  return bus;
}

function defineClientSize(element: HTMLElement, measures: { clientWidth?: number; clientHeight?: number; scrollHeight?: number }): void {
  for (const [key, value] of Object.entries(measures)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

describe('PDF open chain (official kernel, unchanged contract)', () => {
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
      useWasm: boolean;
      useWorkerFetch: boolean;
    };
    expect(options.data).toBeUndefined();
    expect(options.disableStream).toBe(true);
    expect(options.disableAutoFetch).toBe(true);
    expect(options.useWasm).toBe(false);
    expect(options.useWorkerFetch).toBe(false);
    options.range.requestDataRange(128, 384);
    await vi.waitFor(() => expect(source.readRange).toHaveBeenCalledWith(128, 256, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(options.range.received).toEqual([
      { begin: 128, chunk: bytes.slice(128, 384) },
    ]));

    await handle.destroy();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('sets workerSrc to the same-origin boot so pdf.js can handshake', async () => {
    mockPdf();
    const handle = await renderPdfInto(new Uint8Array([1]), document.createElement('div'));
    expect(pdfRuntime.workerOptions.workerSrc).toBe('mock-boot-worker.js');
    const options = pdfRuntime.getDocument.mock.calls[0]?.[0] as { worker?: unknown };
    expect(options.worker).toBeUndefined();
    await handle.destroy();
  });

  it('builds a same-origin boot that polyfills upsert then imports the official worker', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/reader/formats/pdf-worker-entry.ts'),
      'utf-8',
    );
    expect(source).toMatch(/MAP_UPSERT_POLYFILL_SOURCE/);
    expect(source).toMatch(/pdfWorkerBootModule/);
    expect(source).toMatch(/\/__lightink\/pdf\.worker\.boot\.mjs/);
    expect(source).toMatch(/WorkerMessageHandler\.initializeFromPort\(self\)/);
    expect(source).toMatch(/preparePdfjsWorker/);
    expect(source).toMatch(/pdfWorkerThreadsAvailable/);
    expect(source).not.toMatch(/createPdfModuleWorker/);
    expect(source).not.toMatch(/\?worker&url/);
    expect(source).not.toMatch(/void import\(/);
  });

  it('loads a browser-local random-access PDF as a single data buffer', async () => {
    mockPdf();
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const source = {
      size: bytes.length,
      identity: { id: 'local-pdf' },
      access: 'local' as const,
      readRange: vi.fn(async (offset: number, length: number) =>
        bytes.slice(offset, offset + length),
      ),
      close: vi.fn(async () => undefined),
    };
    const handle = await renderPdfInto(source, document.createElement('div'));
    const options = pdfRuntime.getDocument.mock.calls[0]?.[0] as {
      data?: Uint8Array;
      range?: MockPDFDataRangeTransport;
    };
    expect(options.range).toBeUndefined();
    expect(Array.from(options.data ?? [])).toEqual([7, 8, 9, 10]);
    expect(source.readRange).toHaveBeenCalledWith(0, 4, undefined);
    await handle.destroy();
  });

  it('disables wasm fetch so the wrapped worker URL cannot hang getDocument', async () => {
    mockPdf();
    const handle = await renderPdfInto(new Uint8Array([1]), document.createElement('div'));
    const options = pdfRuntime.getDocument.mock.calls[0]?.[0] as { useWasm?: boolean; useWorkerFetch?: boolean };
    expect(options.useWasm).toBe(false);
    expect(options.useWorkerFetch).toBe(false);
    await handle.destroy();
  });
});

describe('official viewer assembly', () => {
  it('appends div.pdfViewer into the host before constructing PDFViewer (order contract)', async () => {
    mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    // 顺序负例观察点：构造器求值时宿主必须已含 .pdfViewer 子元素——颠倒
    // append/构造顺序时此断言失败（reader.css 的 :has(> .pdfViewer) absolute
    // pin 与官方构造器校验都以先 append 为前提）。
    expect(viewer.hadViewerChildAtConstruction).toBe(true);
    expect(viewer.options.container).toBe(container);
    const viewerDiv = viewer.options.viewer;
    expect(viewerDiv).toBeInstanceOf(HTMLDivElement);
    expect(viewerDiv?.classList.contains('pdfViewer')).toBe(true);
    expect(container.querySelector(':scope > .pdfViewer')).toBe(viewerDiv);
    await handle.destroy();
  });

  it('constructs PDFLinkService on the shared EventBus and passes the pinned PDFViewer options', async () => {
    mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    const bus = viewer.options.eventBus;
    expect(bus).toBeInstanceOf(MockEventBus);
    expect(viewer.options.linkService).toBe(
      viewerRuntime.linkServices[viewerRuntime.linkServices.length - 1],
    );
    expect(viewer.options.linkService?.options.eventBus).toBe(bus);
    expect(viewer.options.textLayerMode).toBe(1); // 官方 TextLayerMode.ENABLE
    // 选区观感决策：false = 原生选区 + 应用 wash（见 pdf.ts 决策注释）。
    expect(viewer.options.enableSelectionRendering).toBe(false);
    expect(viewer.options.abortSignal).toBeInstanceOf(AbortSignal);
    await handle.destroy();
  });

  it('hands the loaded document to the viewer via setDocument exactly once', async () => {
    mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const loadingTask = pdfRuntime.getDocument.mock.results[0]!.value as {
      promise: Promise<unknown>;
    };
    const doc = await loadingTask.promise;
    // setDocument 负例观察点：装配遗漏 setDocument 时此断言失败（pagesinit/
    // 页视图/渲染队列全部不会启动）。
    expect(lastViewer().setDocument).toHaveBeenCalledTimes(1);
    expect(lastViewer().setDocument).toHaveBeenCalledWith(doc);
    expect(lastViewer().pdfDocument).toBe(doc);
    await handle.destroy();
  });
});

describe('viewer event wiring', () => {
  it('measures page 1 on pagesinit and sets currentScale to fit-width × user step', async () => {
    mockPdf();
    const container = document.createElement('div');
    defineClientSize(container, { clientWidth: 400 });
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    viewer.pageViews = [{ width: 160, scale: 1, textLayer: null }];
    // pagesinit 前不动 scale（由官方初始化流程持有初值）。
    expect(viewerRuntime.scaleSets).toEqual([]);

    lastEventBus().dispatch('pagesinit', { source: viewer });
    // fit = 400 / 160 = 2.5；userZoom 1 → currentScale 2.5。
    expect(viewer.currentScale).toBe(2.5);
    expect(viewerRuntime.scaleSets).toEqual([2.5]);
    await handle.destroy();
  });

  it('writes viewer pagechanging back to controller.page and adopts the last page at the document end', async () => {
    // 回归（触底钳制）：缩小后多页同屏时末页顶边永远到不了视口顶，viewer 的
    // 可见度选页会钉在中间页；滚到底必须直接采纳末页（看着最后一页却显示
    // n-1/n）。未触底时采纳事件页码。
    mockPdf(7);
    const container = document.createElement('div');
    defineClientSize(container, { clientHeight: 1000, scrollHeight: 1540 });
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    expect(handle.controller.totalPages).toBe(7);

    const bus = lastEventBus();
    // 每页 220px，7 页共 1540；视口 1000 → maxScrollTop = 540；触底（540 ≥ 538）。
    container.scrollTop = 540;
    bus.dispatch('pagechanging', { source: lastViewer(), pageNumber: 3 });
    expect(handle.controller.page).toBe(7);

    // 未触底：采纳事件页码。
    container.scrollTop = 300;
    bus.dispatch('pagechanging', { source: lastViewer(), pageNumber: 2 });
    expect(handle.controller.page).toBe(2);
    await handle.destroy();
  });

  it('maps scrollToPage to viewer.scrollPageIntoView and syncs the controller', async () => {
    mockPdf(5);
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    handle.scrollToPage(3);
    expect(lastViewer().scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 3 });
    expect(handle.controller.page).toBe(3);
    // 越界钳制到有效页。
    handle.scrollToPage(99);
    expect(lastViewer().scrollPageIntoView).toHaveBeenLastCalledWith({ pageNumber: 5 });
    await handle.destroy();
  });

  it('rerender recomputes fit-width and re-applies the current user step', async () => {
    mockPdf();
    const container = document.createElement('div');
    defineClientSize(container, { clientWidth: 400 });
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    viewer.pageViews = [{ width: 160, scale: 1, textLayer: null }];
    lastEventBus().dispatch('pagesinit', { source: viewer });
    expect(viewer.currentScale).toBe(2.5);

    handle.controller.zoomIn(); // 1.25
    await handle.rerender();
    expect(viewer.currentScale).toBe(2.5 * 1.25);

    handle.controller.resetScale();
    await handle.rerender();
    expect(viewer.currentScale).toBe(2.5);
    await handle.destroy();
  });

  it('snaps the controller step when the viewer changes scale on its own (scalechanging)', async () => {
    mockPdf();
    const container = document.createElement('div');
    defineClientSize(container, { clientWidth: 400 });
    document.body.appendChild(container);
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    viewer.pageViews = [{ width: 160, scale: 1, textLayer: null }];
    const bus = lastEventBus();
    bus.dispatch('pagesinit', { source: viewer }); // fit = 2.5
    expect(handle.controller.scale).toBe(1);

    bus.dispatch('scalechanging', { source: viewer, scale: 2.5 });
    expect(handle.controller.scale).toBe(1); // 同档位不跳
    bus.dispatch('scalechanging', { source: viewer, scale: 5 }); // userZoom = 2
    expect(handle.controller.scale).toBe(2);
    await handle.destroy();
  });

  it('installs the selection guard on the official text layer root on textlayerrendered', async () => {
    mockPdf(2);
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);

    const viewer = lastViewer();
    const layerDiv = document.createElement('div');
    viewer.pageViews = [
      { width: 160, scale: 1, textLayer: { div: layerDiv } },
      { width: 160, scale: 1, textLayer: null },
    ];
    const bus = lastEventBus();

    bus.dispatch('textlayerrendered', { source: viewer, pageNumber: 1, error: null });
    expect(textLayerRuntime.bind).toHaveBeenCalledTimes(1);
    expect(textLayerRuntime.bind).toHaveBeenCalledWith(layerDiv);

    // 官方降级（error）不安装护栏。
    textLayerRuntime.bind.mockClear();
    bus.dispatch('textlayerrendered', {
      source: viewer,
      pageNumber: 2,
      error: new Error('text layer boom'),
    });
    expect(textLayerRuntime.bind).not.toHaveBeenCalled();
    await handle.destroy();
  });
});

describe('teardown symmetry', () => {
  it('detaches listeners, runs the official setDocument(null) clearing, cleans the viewer, destroys the task once, closes the source', async () => {
    const runtime = mockPdf();
    const source = {
      size: 4,
      identity: { id: 'remote-pdf' },
      readRange: vi.fn(async () => new Uint8Array(4)),
      close: vi.fn(async () => undefined),
    };
    const container = document.createElement('div');
    const handle = await renderPdfInto(source, container);

    const bus = lastEventBus();
    const viewer = lastViewer();
    expect(bus.listenerCount('pagesinit')).toBe(1);
    expect(bus.listenerCount('pagechanging')).toBe(1);
    expect(bus.listenerCount('scalechanging')).toBe(1);
    expect(bus.listenerCount('textlayerrendered')).toBe(1);

    await handle.destroy();
    // 监听摘除负例观察点：destroy 不 abort teardown 信号时这些计数保持 1，
    // 断言失败（EventBus 无 teardown，必须经 { signal } 逐个摘除）。
    expect(bus.listenerCount('pagesinit')).toBe(0);
    expect(bus.listenerCount('pagechanging')).toBe(0);
    expect(bus.listenerCount('scalechanging')).toBe(0);
    expect(bus.listenerCount('textlayerrendered')).toBe(0);
    // 官方清空路径负例观察点：destroy 不调 setDocument(null) 时官方
    // _resetView 不执行——#eventAC 未 abort（document 级 copy 监听滞留）、
    // viewer DOM/页视图对象图（含 FINISHED 页 canvas）不被释放，此断言失败。
    expect(viewer.setDocument).toHaveBeenCalledTimes(2); // doc + null
    expect(viewer.setDocument).toHaveBeenLastCalledWith(null);
    expect(viewer.cleanup).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.pdfViewer')).toBeNull();

    // 幂等：二次 destroy 不再触发任何作废。
    await handle.destroy();
    expect(viewer.setDocument).toHaveBeenCalledTimes(2);
    expect(viewer.cleanup).toHaveBeenCalledTimes(1);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('releases installed text-layer guards on destroy', async () => {
    mockPdf();
    const container = document.createElement('div');
    const handle = await renderPdfInto(new Uint8Array([1]), container);
    const viewer = lastViewer();
    const unbind = vi.fn();
    textLayerRuntime.bind.mockImplementation(() => unbind);
    const layerDiv = document.createElement('div');
    viewer.pageViews = [{ width: 160, scale: 1, textLayer: { div: layerDiv } }];
    lastEventBus().dispatch('textlayerrendered', { source: viewer, pageNumber: 1, error: null });
    expect(textLayerRuntime.bind).toHaveBeenCalledWith(layerDiv);

    await handle.destroy();
    expect(unbind).toHaveBeenCalledTimes(1);
  });
});

describe('hand-rolled pipeline removal (grep contract)', () => {
  it('drops the legacy slot/queue/observer/anchor pipeline and handwritten scale variables from pdf.ts', () => {
    const raw = readFileSync(path.join(process.cwd(), 'src/reader/formats/pdf.ts'), 'utf-8');
    // 只断言代码区：注释里描述官方内部机制（ResizeObserver 等）不算回流。
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

    const forbidden = [
      /sizeSlot/,
      /measureRemainingPages/,
      /IntersectionObserver/,
      /pumpRenderQueue/,
      /queueRender/,
      /clearSlot/,
      /renderSlot/,
      /appendTextLayer/,
      /keepViewportAnchor/,
      /captureViewportAnchor/,
      /paintVisibleBuffer/,
      /hostResizeObserver/,
      /new ResizeObserver/,
      /lightink-reader-page-slot/,
      /lightink-reader-text-layer/,
      /--total-scale-factor/,
      /--scale-round/,
      /PDF_RENDER_ROOT_MARGIN/,
      /installMapUpsertPolyfill/,
      /renderGeneration/,
      // 手搓缩放锚点纯函数（R1：缩放锚点逻辑不再存在于 pdf.ts）不得回补。
      /pdfViewportAnchor/,
      /pdfScrollToKeepAnchor/,
    ];
    for (const pattern of forbidden) {
      expect(source).not.toMatch(pattern);
    }

    // 官方装配接缝必须在：引导、setDocument、scrollPageIntoView、页宿主 CSS。
    expect(source).toMatch(/loadPdfjsComponents/);
    expect(source).toMatch(/\.setDocument\(doc\)/);
    expect(source).toMatch(/scrollPageIntoView/);
    expect(source).toMatch(/import '\.\.\/pdf-viewer\.css'/);
    expect(source).toMatch(/currentScale = pdfCssScale/);
  });
});

describe('page host CSS contract', () => {
  it('keeps PDF overflow on the page host so the official viewer scrolls the host itself', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    const theme = readFileSync(path.join(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader-pages\[data-reader-format='pdf'\]\[data-reader-active='true'\][\s\S]*?\{[^}]*overflow:\s*auto/,
    );
    expect(css).toMatch(
      /\.lightink-reader:has\(\.lightink-reader-pages\[data-reader-format='pdf'\]\)[\s\S]*?\.lightink-reader-chrome-footer[\s\S]*?\.lightink-reader-chrome-scrubber[\s\S]*?\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.lightink-reader:has\(\>\s*\.lightink-reader-pages\[data-reader-active='true'\]\)\s*\{[^}]*position:\s*absolute/,
    );
    expect(css).toMatch(
      /\.lightink-reader:has\(\>\s*\.lightink-reader-pages\[data-reader-active='true'\]\)\s*\{[^}]*overflow:\s*hidden/,
    );
    expect(theme).toMatch(
      /html\[data-reading-layout='scroll'\][\s\S]*?#lightink-editor-area\[data-surface='reader'\]:has\(\s*\.lightink-tab-host:not\(\[style\*='display: none'\]\)\s*\.lightink-reader-pages\[data-reader-active='true'\]\s*\)[\s\S]*?\{[^}]*overflow:\s*hidden/,
    );
    expect(theme).not.toMatch(
      /#lightink-editor-area\[data-surface='reader'\]:has\(\.lightink-reader-pages\[data-reader-active='true'\]\)/,
    );
    expect(theme).not.toMatch(
      /#lightink-editor-area\[data-surface='reader'\]:has\(\.lightink-reader\[data-reading-layout='scroll'\]\)/,
    );
    expect(css).not.toMatch(
      /html\[data-reading-layout='paginated'\] \.lightink-reader:has\([^)]*\)\s*\{[^}]*overflow:\s*auto/,
    );
    // 官方 viewer 构造器要求滚动宿主 position:absolute（.pdfViewer 挂入后由
    // :has(> .pdfViewer) 补定位）；宿主保持 overflow:auto 与稳定滚动条槽。
    expect(css).toMatch(
      /\.lightink-reader-pages\[data-reader-format='pdf'\]\[data-reader-active='true'\]:has\(\>\s*\.pdfViewer\)\s*\{[^}]*position:\s*absolute/,
    );
    expect(css).toMatch(
      /\.lightink-reader-pages\[data-reader-format='pdf'\]\[data-reader-active='true'\][\s\S]*?\{[^}]*scrollbar-gutter:\s*stable/,
    );
    // 漫画 slot（.lightink-reader-page-slot 现为 CBZ 专用）保持禁收缩 +
    // content-visibility，防止清画布后空槽塌陷触发宽度回弹。
    expect(css).toMatch(/\.lightink-reader-page-slot\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/\.lightink-reader-page-slot\s*\{[^}]*content-visibility:\s*auto/);
  });
});

describe('PDF user-zoom tab targeting', () => {
  it('dispatches lightink:pdf-user-zoom only to the active reader tab', async () => {
    mockPdf();
    const hostActive = document.createElement('div');
    const hostHidden = document.createElement('div');
    document.body.append(hostActive, hostHidden);
    const deps = { readBytes: async () => new Uint8Array([1]) };
    const active = createReaderView(hostActive, deps);
    const hidden = createReaderView(hostHidden, deps);

    await active.load('active.pdf');
    await hidden.load('hidden.pdf');
    hidden.setTabActive(false);

    expect(active.state.scale).toBe(1);
    expect(hidden.state.scale).toBe(1);

    document.dispatchEvent(
      new CustomEvent('lightink:pdf-user-zoom', { detail: { direction: 1 } }),
    );

    expect(active.state.scale).toBe(1.25);
    expect(hidden.state.scale).toBe(1);

    await active.destroy();
    await hidden.destroy();
  });
});

describe('PDF page host CSS contract', () => {
  it('pins the trimmed official subset and the narrowed selection wash in pdf-viewer.css', () => {
    const raw = readFileSync(path.join(process.cwd(), 'src/reader/pdf-viewer.css'), 'utf-8');
    // 只对规则区断言：文件头的来源/偏差注释同样提及这些类名与剔除项，先剥离
    // 注释，"删规则留注释"的回归才会红。
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

    // .pdfViewer 基础：官方 :root 页变量收敛在 .pdfViewer 上。
    expect(css).toMatch(/\.pdfViewer\s*\{[^}]*--scale-factor:\s*1;/);
    // .canvasWrapper：容器裁剪、canvas 绝对定位铺满。
    expect(css).toMatch(/\.canvasWrapper\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/canvas\s*\{[^}]*position:\s*absolute/);

    // .page 级联变量：--scale-factor 由 viewer JS 写在 .pdfViewer 上，
    // --total-scale-factor 经 .page 级联，--scale-round-x/y 在此定义（T3 不再手写）。
    expect(css).toMatch(
      /\.pdfViewer \.page\s*\{[^}]*--total-scale-factor:\s*calc\(var\(--scale-factor\) \* var\(--user-unit\)\)/,
    );
    expect(css).toMatch(/\.pdfViewer \.page\s*\{[^}]*--scale-round-x:\s*1px/);
    expect(css).toMatch(/\.pdfViewer \.page\s*\{[^}]*--scale-round-y:\s*1px/);

    // .textLayer 选区护栏：.endOfContent / .selecting（官方 615-762 原样）。
    expect(css).toMatch(/\.endOfContent\s*\{[^}]*inset:\s*100% 0 0/);
    expect(css).toMatch(/\.endOfContent\s*\{[^}]*user-select:\s*none/);
    expect(css).toMatch(/\.selecting \.endOfContent\s*\{[^}]*top:\s*0/);

    // 补齐 wash 收窄到非护栏状态 + 两条补偿护栏（pdf-viewer.css 文件头偏差 3）：
    // enableSelectionRendering 激活时原生选区必须透明，不得与 DrawLayer
    // `.selection` 覆盖层双重着色；br 选区始终透明。
    expect(css).toMatch(
      /\.pdfViewer \.textLayer:not\(\.selectionRendering\) ::selection\s*\{[^}]*background:\s*var\(--lightink-annotation-wash, rgba\(154, 88, 40, 0\.32\)\)/,
    );
    expect(css).toMatch(
      /\.pdfViewer \.textLayer\.selectionRendering ::selection\s*\{[^}]*background:\s*transparent/,
    );
    expect(css).toMatch(
      /\.pdfViewer \.textLayer:not\(\.selectionRendering\) br::selection\s*\{[^}]*background:\s*transparent/,
    );
    // 级联缺陷负例：未收窄的 wash 选择器（与官方护栏同特异性、靠后胜出）不得存在。
    expect(css).not.toMatch(/\.pdfViewer \.textLayer ::selection/);

    // 文件头裁剪声明的负例：这些官方区块不得回流。
    expect(css).not.toMatch(/annotationEditor/);
    expect(css).not.toMatch(/annotationLayer/);
    expect(css).not.toMatch(/findbar/);
    expect(css).not.toMatch(/toolbar/);
    expect(css).not.toMatch(/print/);
  });
});
