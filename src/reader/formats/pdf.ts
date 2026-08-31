/**
 * `pdf` — PDF 页格式渲染（ebook-reader T5 + 文本层）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 懒加载 pdfjs-dist（workerSrc 经 pdf-worker-entry：同源 boot
 * 先装 upsert polyfill，再加载未经 Vite 注入的官方 worker），把当前页渲染到 canvas，
 * 并在其上叠加 pdfjs `TextLayer` 文本层（DOM span 承载文字选择，版式仍由 canvas 保真）。
 * 文本层与 canvas 同生命周期：懒渲染、缩放按视口中心锚定并只重绘可见页、离屏回收；渲染失败降级纯 canvas。
 * 打开先量第 1 页并出首屏，其余页先占位再后台补真实宽高。比例是 fitWidthScale * userZoom。
 * 返回 handle 供导航/缩放重绘。canvas/文本层真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import { isTauriRuntime } from '../../file/browser-file-store.js';
import type { OutlineItem } from '../../outline/outline-model.js';
import { installMapUpsertPolyfill } from './map-upsert-polyfill.js';
import { outlineFromPdf } from '../outline.js';
import { ParseError } from './types.js';
import { enforcePageCount } from '../reader-limits.js';
import { findPdfMatches, type PdfSearchMatch } from '../search-panel.js';
import { bindTextLayerSelection } from '../text-layer-selection.js';
import { bindPdfDragPan } from './pdf-drag-pan.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import {
  createCoalescedScrollHandler,
  rafFrameScheduler,
} from '../../ui/reading-layout.js';
import { isRandomAccessSource, type RandomAccessSource } from '../sources/types.js';

/** userZoom 档位。还原 = 1，即适合页宽（fitWidthScale * 1），不是 100% 设备像素。 */
export const PDF_SCALE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const DEFAULT_SCALE_IDX = 2; // userZoom 1.0 = 适合页宽
const RENDER_QUEUE_LIMIT = 2;
const MEASURE_BATCH = 8;
/** 懒栅格化缓冲：上下各约 0.8 屏。更大的 200% 会同时养活太多 canvas/文本层。 */
export const PDF_RENDER_ROOT_MARGIN = '80% 0px';
const PDF_RENDER_BUFFER_SCREENS = 0.8;
/** 高 DPR 屏上 canvas 按 2 封顶，避免一页几千万像素拖垮合成。 */
const PDF_MAX_DEVICE_PIXEL_RATIO = 2;

/** 页宿主内容宽 / 页 CSS 宽；量不到时退回 1，避免 jsdom 零宽把首屏画成空。 */
export function pdfFitWidthScale(hostContentWidth: number, pageCssWidth: number): number {
  if (!(hostContentWidth > 0) || !(pageCssWidth > 0)) {
    return 1;
  }
  return hostContentWidth / pageCssWidth;
}

/** PDF 唯一比例：适合页宽 × 用户档。 */
export function pdfCssScale(fitWidthScale: number, userZoom: number): number {
  return fitWidthScale * userZoom;
}

export interface PdfPageController {
  readonly totalPages: number;
  readonly page: number;
  readonly scale: number;
  readonly canPrev: boolean;
  readonly canNext: boolean;
  next(): boolean;
  prev(): boolean;
  setPage(page: number): boolean;
  zoomIn(): boolean;
  zoomOut(): boolean;
  resetScale(): boolean;
}

export interface PdfRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Slot under the viewport center, plus the point inside that slot (0..1). */
export function pdfViewportAnchor(
  viewport: PdfRect,
  slots: readonly PdfRect[],
  fallbackIndex = 0,
): { index: number; xRatio: number; yRatio: number } {
  const cx = viewport.left + viewport.width / 2;
  const cy = viewport.top + viewport.height / 2;
  let index = Math.max(0, Math.min(slots.length - 1, fallbackIndex));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const inside =
      cx >= slot.left &&
      cx <= slot.left + slot.width &&
      cy >= slot.top &&
      cy <= slot.top + slot.height;
    if (inside) {
      index = i;
      break;
    }
    const midX = slot.left + slot.width / 2;
    const midY = slot.top + slot.height / 2;
    const dist = (midX - cx) ** 2 + (midY - cy) ** 2;
    if (dist < best) {
      best = dist;
      index = i;
    }
  }
  const slot = slots[index];
  if (slot === undefined || slot.width <= 0 || slot.height <= 0) {
    return { index, xRatio: 0.5, yRatio: 0.5 };
  }
  return {
    index,
    xRatio: (cx - slot.left) / slot.width,
    yRatio: (cy - slot.top) / slot.height,
  };
}

/** Keep the captured document point under the viewport center after a zoom. */
export function pdfScrollToKeepAnchor(
  scroller: { scrollLeft: number; scrollTop: number; clientWidth: number; clientHeight: number },
  slotInViewport: PdfRect,
  anchor: { xRatio: number; yRatio: number },
): { scrollLeft: number; scrollTop: number } {
  const targetX = scroller.scrollLeft + slotInViewport.left + slotInViewport.width * anchor.xRatio;
  const targetY = scroller.scrollTop + slotInViewport.top + slotInViewport.height * anchor.yRatio;
  return {
    scrollLeft: Math.max(0, targetX - scroller.clientWidth / 2),
    scrollTop: Math.max(0, targetY - scroller.clientHeight / 2),
  };
}

/**
 * 创建页码/缩放状态机。所有变更返回是否真正改变（供调用方决定是否重绘）。
 * 纯逻辑、无 DOM，headless 可测。
 */
export function createPdfPageController(totalPages: number): PdfPageController {
  const total = Math.max(1, Math.floor(totalPages));
  let page = 1;
  let scaleIdx = DEFAULT_SCALE_IDX;
  const clampPage = (p: number): number => Math.min(total, Math.max(1, Math.floor(p)));
  return {
    get totalPages() {
      return total;
    },
    get page() {
      return page;
    },
    get scale() {
      return PDF_SCALE_STEPS[scaleIdx]!;
    },
    get canPrev() {
      return page > 1;
    },
    get canNext() {
      return page < total;
    },
    next() {
      if (page < total) {
        page += 1;
        return true;
      }
      return false;
    },
    prev() {
      if (page > 1) {
        page -= 1;
        return true;
      }
      return false;
    },
    setPage(p) {
      const n = clampPage(p);
      if (n === page) {
        return false;
      }
      page = n;
      return true;
    },
    zoomIn() {
      if (scaleIdx < PDF_SCALE_STEPS.length - 1) {
        scaleIdx += 1;
        return true;
      }
      return false;
    },
    zoomOut() {
      if (scaleIdx > 0) {
        scaleIdx -= 1;
        return true;
      }
      return false;
    },
    resetScale() {
      if (scaleIdx === DEFAULT_SCALE_IDX) {
        return false;
      }
      scaleIdx = DEFAULT_SCALE_IDX;
      return true;
    },
  };
}

export interface PdfRenderHandle {
  readonly controller: PdfPageController;
  /** 按当前缩放重算可见页；以视口中心为锚点，不整本重排。 */
  rerender(): Promise<void>;
  /** 滚动到指定页（1-based），并同步 controller.page。供翻页/侧栏跳转。 */
  scrollToPage(page: number): void;
  /** 全文搜索（大小写不敏感）：按页序返回命中（页码 + 该页拼接文本偏移）。 */
  search(
    query: string,
    options?: {
      readonly onProgress?: (matches: PdfSearchMatch[], done: boolean) => void;
    },
  ): Promise<PdfSearchMatch[]>;
  /** PDF 书签树拍平后的大纲（无书签则为空）。 */
  outline(): Promise<OutlineItem[]>;
  /** 释放 pdfjs 文档资源 + 断开 observer（关闭/重开 PDF 时调用）。 */
  destroy(): Promise<void>;
}

export type { PdfSearchMatch };

/** 当前设备像素比（WebView2 下读 window.devicePixelRatio），封顶以免超大 canvas。 */
function devicePixelRatio(): number {
  const raw =
    typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  return Math.min(raw, PDF_MAX_DEVICE_PIXEL_RATIO);
}

function pageHostContentWidth(host: HTMLElement): number {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  const pad =
    style !== null
      ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      : 0;
  return Math.max(0, host.clientWidth - pad);
}

/**
 * 用 pdfjs-dist 把 PDF 以**连续垂直滚动**渲染进容器。workerSrc 指向同源 boot
 *（polyfill + 官方 worker）。先量第 1 页算出适合
 * 页宽并插完全部槽位，其余页后台补真实宽高。IntersectionObserver 懒栅格化：仅渲染
 * 视口附近（rootMargin 缓冲）的页到 canvas，离屏过远的清画布省内存。缩放按视口中心
 * 锚定，只重画可见与缓冲页。
 *
 * 真实 canvas/滚动渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */
export async function renderPdfInto(
  input: Uint8Array | RandomAccessSource,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<PdfRenderHandle> {
  throwIfReaderLoadCancelled(signal);
  // pdfjs ≥ 6 直接调用 Map/WeakMap upsert 提案方法：主线程在此补，worker 侧由
  // 同源 boot 补（两个独立 JS 上下文，缺一不可）。
  installMapUpsertPolyfill();
  const pdfjs = await import('pdfjs-dist');
  const workerEntry = await import('./pdf-worker-entry.js');
  throwIfReaderLoadCancelled(signal);
  // 同源 boot：pdf.js 自己 new Worker 并做 ready/test 握手。不要传
  // PDFWorker({ port })——那会立刻标 ready，首开消息会在 worker 求值前丢掉。
  // Worker 线程不可用时 preparePdfjsWorker 会改走主线程 fake worker。
  pdfjs.GlobalWorkerOptions.workerSrc = workerEntry.pdfWorkerSrc();
  await workerEntry.preparePdfjsWorker();

  const randomSource = isRandomAccessSource(input) ? input : null;
  let rangeFailure: unknown = null;
  let rangeController: AbortController | null = null;
  let loadingTask: ReturnType<typeof pdfjs.getDocument>;
  // pdfjs 6 默认从 workerSrc 目录拉 wasm/cmap。boot 没有官方资源目录，
  // 请求会挂起。关掉 wasm 与 worker fetch，解码走 JS 回退。
  const pdfOpenOptions = { useWasm: false as const, useWorkerFetch: false as const };
  const browserLocal =
    randomSource !== null && randomSource.access === 'local' && !isTauriRuntime();
  if (randomSource === null || browserLocal) {
    // 浏览器预览的 File 已在内存里。pdfjs 6 的 range 传输要等 transportReady
    // 挂上 listener 之后才能 onDataRange；首块若提前到达会丢掉，getDocument
    // 一直不 resolve。桌面 Tauri 仍走下面的有界随机读，避免整本跨 IPC。
    const data =
      randomSource === null
        ? (input as Uint8Array)
        : await randomSource.readRange(0, randomSource.size, signal);
    throwIfReaderLoadCancelled(signal);
    loadingTask = pdfjs.getDocument({ data, ...pdfOpenOptions });
  } else {
    rangeController = new AbortController();
    const controller = rangeController;
    class SourceRangeTransport extends pdfjs.PDFDataRangeTransport {
      readonly queued: Array<{ begin: number; chunk: Uint8Array }> = [];
      override transportReady(listener?: unknown): void {
        const parent = super.transportReady as ((next?: unknown) => void) | undefined;
        parent?.call(this, listener);
        for (const item of this.queued) {
          this.onDataRange(item.begin, item.chunk);
        }
        this.queued.length = 0;
      }
      override requestDataRange(begin: number, end: number): void {
        void randomSource!
          .readRange(begin, end - begin, controller.signal)
          .then((chunk) => {
            if (controller.signal.aborted) {
              return;
            }
            try {
              this.onDataRange(begin, chunk);
            } catch {
              this.queued.push({ begin, chunk });
            }
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              rangeFailure = error;
              controller.abort();
              void loadingTask.destroy();
            }
          });
      }

      override abort(): void {
        controller.abort();
      }
    }
    loadingTask = pdfjs.getDocument({
      range: new SourceRangeTransport(randomSource.size, null),
      rangeChunkSize: 256 * 1024,
      disableStream: true,
      disableAutoFetch: true,
      ...pdfOpenOptions,
    });
  }
  let doc: Awaited<typeof loadingTask.promise>;
  const cancelInitialLoad = (): void => {
    rangeController?.abort();
    void loadingTask.destroy();
  };
  try {
    signal?.addEventListener('abort', cancelInitialLoad, { once: true });
    doc = await loadingTask.promise;
    throwIfReaderLoadCancelled(signal);
  } catch (error) {
    await randomSource?.close().catch(() => undefined);
    if (isReaderLoadCancelled(error, signal)) {
      throw new ReaderLoadCancelledError();
    }
    if (rangeFailure !== null) {
      throw rangeFailure;
    }
    // 兜底信息面向用户；原始原因必须落日志，否则打开失败无法定位。
    console.error('[lightink/reader] PDF open failed', error);
    throw new ParseError('PDF 文件损坏或无法解析');
  } finally {
    signal?.removeEventListener('abort', cancelInitialLoad);
  }
  try {
    enforcePageCount('pdf', doc.numPages);
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    await randomSource?.close().catch(() => undefined);
    throw error;
  }
  const controller = createPdfPageController(doc.numPages);
  const total = controller.totalPages;
  let destroyed = false;
  let renderGeneration = 0;
  const renderTasks = new Map<
    number,
    { cancel(): void; readonly promise: Promise<unknown> }
  >();
  /** 每页活动文本层任务（与 canvas 同生命周期，clearSlot/destroy 时 cancel）。 */
  const textLayers = new Map<number, { cancel(): void }>();
  /** 每页拼接文本缓存（文本层/搜索共用同一坐标系，懒填充）。 */
  const pageTexts: string[] = [];
  let observer: IntersectionObserver | null = null;
  const isAborted = (): boolean => signal?.aborted === true;

  const cancelRenderTasks = (): void => {
    for (const task of renderTasks.values()) {
      try {
        task.cancel();
      } catch {
        // A completed pdf.js task may reject a late cancellation.
      }
    }
    renderTasks.clear();
  };

  const cancelTextLayers = (): void => {
    for (const layer of textLayers.values()) {
      try {
        layer.cancel();
      } catch {
        // A finished pdf.js TextLayer may reject a late cancellation.
      }
    }
    textLayers.clear();
  };

  const onAbort = (): void => {
    renderGeneration += 1;
    rangeController?.abort();
    cancelRenderTasks();
    cancelTextLayers();
    observer?.disconnect();
    void loadingTask.destroy();
    void randomSource?.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  throwIfReaderLoadCancelled(signal);

  // 先量第 1 页：定适合页宽，立刻插完全部槽。其余页先用页 1 估算高度。
  const slots: HTMLDivElement[] = [];
  const nativeSizes: Array<{ width: number; height: number } | undefined> = [];
  const sizeSlot = (slot: HTMLDivElement, w: number, h: number): void => {
    slot.style.width = `${Math.floor(w)}px`;
    slot.style.height = `${Math.floor(h)}px`;
  };

  let fitWidthScale = 1;
  const pageCssScale = (): number => pdfCssScale(fitWidthScale, controller.scale);

  const refreshFitWidth = (pageCssWidth: number): void => {
    fitWidthScale = pdfFitWidthScale(pageHostContentWidth(container), pageCssWidth);
  };

  const displaySize = (index: number): { width: number; height: number } => {
    const native = nativeSizes[index] ?? nativeSizes[0];
    const scale = pageCssScale();
    if (native === undefined) {
      return { width: 0, height: 0 };
    }
    return { width: native.width * scale, height: native.height * scale };
  };

  const applySlotMetrics = (index: number): void => {
    const slot = slots[index];
    const size = displaySize(index);
    if (slot === undefined) {
      return;
    }
    sizeSlot(slot, size.width, size.height);
  };

  const firstPage = await doc.getPage(1);
  throwIfReaderLoadCancelled(signal);
  const firstNative = firstPage.getViewport({ scale: 1 });
  nativeSizes[0] = { width: firstNative.width, height: firstNative.height };
  refreshFitWidth(firstNative.width);

  container.replaceChildren();
  for (let i = 0; i < total; i += 1) {
    if (i > 0) {
      nativeSizes[i] = nativeSizes[0];
    }
    const size = displaySize(i);
    const slot = document.createElement('div');
    slot.className = 'lightink-reader-page-slot';
    slot.dataset.pageIndex = String(i);
    sizeSlot(slot, size.width, size.height);
    container.appendChild(slot);
    slots.push(slot);
  }

  /**
   * 在已渲染 canvas 的 slot 上叠加 pdfjs `TextLayer`（CSS 尺寸 viewport，span 百分比
   * 定位 + `--total-scale-factor` 约定见 reader.css）。失败/取消降级移除容器，不阻断
   * canvas 阅读；扫描件 getTextContent 为空时容器内无 span，自然无可选文字。
   */
  const appendTextLayer = async (
    index: number,
    page: Awaited<ReturnType<typeof doc.getPage>>,
    generation: number,
  ): Promise<void> => {
    const slot = slots[index];
    if (slot === undefined || destroyed || isAborted() || generation !== renderGeneration) {
      return;
    }
    if (slot.querySelector('.lightink-reader-text-layer') !== null) {
      return; // 已存在
    }
    if (slot.querySelector('canvas') === null) {
      return; // canvas 已被回收，不孤立文本层
    }
    const textContent = await page.getTextContent();
    if (
      destroyed ||
      isAborted() ||
      generation !== renderGeneration ||
      slot.querySelector('canvas') === null ||
      slot.querySelector('.lightink-reader-text-layer') !== null // 并发 appendTextLayer 复检去重
    ) {
      return;
    }
    // 页拼接文本缓存（搜索与文本层 anchor 同一坐标系）。
    pageTexts[index] = textContent.items
      .map((item) => ('str' in item ? item.str : ''))
      .join('');
    const container = document.createElement('div');
    container.className = 'lightink-reader-text-layer';
    // pdfjs TextLayer 约定：容器按 CSS 变量计算宽高，缩放因子为 CSS 尺寸 scale（非 dpr）。
    const cssScale = pageCssScale();
    container.style.setProperty('--total-scale-factor', String(cssScale));
    container.style.setProperty('--scale-round-x', '1px');
    container.style.setProperty('--scale-round-y', '1px');
    slot.appendChild(container);
    const layer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container,
      viewport: page.getViewport({ scale: cssScale }),
    });
    textLayers.set(index, layer);
    try {
      await layer.render();
      if (
        !destroyed &&
        !isAborted() &&
        generation === renderGeneration &&
        container.isConnected
      ) {
        const unbind = bindTextLayerSelection(container);
        textLayers.set(index, {
          cancel() {
            unbind();
            layer.cancel();
          },
        });
      }
    } catch (error) {
      container.remove();
      if (
        !destroyed &&
        !isAborted() &&
        generation === renderGeneration &&
        (error as { name?: unknown }).name !== 'AbortException'
      ) {
        // 真实失败才记录；cancel/换代/离屏回收引起的 AbortException 静默降级为纯 canvas。
        console.warn('[lightink/reader] PDF text layer failed', error);
      }
    } finally {
      if (textLayers.get(index) === layer) {
        textLayers.delete(index);
      }
    }
  };

  /** 渲染单页到其 slot（幂等：已有 canvas 则跳过）。 */
  const renderSlot = async (
    index: number,
    generation = renderGeneration,
  ): Promise<void> => {
    const slot = slots[index];
    if (
      slot === undefined ||
      destroyed ||
      isAborted() ||
      generation !== renderGeneration
    ) {
      return;
    }
    if (slot.querySelector('canvas') !== null) {
      return; // 已渲染
    }
    const page = await doc.getPage(index + 1);
    if (destroyed || isAborted() || generation !== renderGeneration) {
      return;
    }
    const dpr = devicePixelRatio();
    const cssScale = pageCssScale();
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'lightink-reader-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    slot.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      canvas.remove();
      return;
    }
    const task = page.render({ canvas, canvasContext: ctx, viewport });
    renderTasks.set(index, task);
    try {
      await task.promise;
    } catch (error) {
      if (
        destroyed ||
        isAborted() ||
        generation !== renderGeneration ||
        (error as { name?: unknown }).name === 'RenderingCancelledException'
      ) {
        canvas.remove();
        return;
      }
      canvas.remove();
      throw error;
    } finally {
      if (renderTasks.get(index) === task) {
        renderTasks.delete(index);
      }
    }
    void appendTextLayer(index, page, generation).catch(() => undefined);
  };

  const queued = new Set<number>();
  let inflightRenders = 0;
  const pendingRender: number[] = [];

  const reportRenderError = (error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error('[lightink/reader] PDF page render failed', error);
  };

  const pumpRenderQueue = (): void => {
    while (inflightRenders < RENDER_QUEUE_LIMIT && pendingRender.length > 0) {
      const index = pendingRender.shift();
      if (index === undefined) {
        break;
      }
      inflightRenders += 1;
      void renderSlot(index)
        .catch(reportRenderError)
        .finally(() => {
          queued.delete(index);
          inflightRenders -= 1;
          pumpRenderQueue();
        });
    }
  };

  const queueRender = (index: number): void => {
    if (queued.has(index) || Number.isNaN(index) || index < 0 || index >= total) {
      return;
    }
    queued.add(index);
    pendingRender.push(index);
    pumpRenderQueue();
  };

  /** 清掉离屏过远的 slot 画布与文本层，释放内存（再次进入视口会重渲染）。 */
  const clearSlot = (index: number): void => {
    renderTasks.get(index)?.cancel();
    textLayers.get(index)?.cancel();
    slots[index]?.replaceChildren();
  };

  // PDF 只在页宿主连续竖滚；不按 html[data-reading-layout] 切到 editor-area。
  const scroller = container;
  // 触屏环境：放大出横向溢出后由指针拖拽平移（见 pdf-drag-pan 模块注释）。
  const dragPan = bindPdfDragPan(scroller);

  const keepViewportAnchor = (
    view: DOMRect,
    anchor: { index: number; xRatio: number; yRatio: number },
  ): void => {
    const nextSlot = slots[anchor.index]?.getBoundingClientRect();
    if (nextSlot === undefined) {
      return;
    }
    // getBoundingClientRect 是视口绝对坐标，pdfScrollToKeepAnchor 期望相对
    // scroller 的坐标；不归一化会把应用 chrome（标签栏/侧栏）的偏移累加进
    // 新滚动位置，锚点随每次缩放漂移。
    const next = pdfScrollToKeepAnchor(
      scroller,
      {
        left: nextSlot.left - view.left,
        top: nextSlot.top - view.top,
        width: nextSlot.width,
        height: nextSlot.height,
      },
      anchor,
    );
    scroller.scrollLeft = next.scrollLeft;
    scroller.scrollTop = next.scrollTop;
  };

  const captureViewportAnchor = (): {
    view: DOMRect;
    anchor: { index: number; xRatio: number; yRatio: number };
  } => {
    const view = scroller.getBoundingClientRect();
    const slotRects = slots.map((slot) => slot.getBoundingClientRect());
    return {
      view,
      anchor: pdfViewportAnchor(view, slotRects, Math.max(0, controller.page - 1)),
    };
  };

  const paintVisibleBuffer = async (generation: number): Promise<void> => {
    const visible = scroller.getBoundingClientRect();
    if (visible.height <= 0) {
      if (slots[0] !== undefined) {
        await renderSlot(0, generation);
      }
      return;
    }
    const buffer = visible.height * PDF_RENDER_BUFFER_SCREENS;
    for (let i = 0; i < total; i += 1) {
      const rect = slots[i]!.getBoundingClientRect();
      const strictlyVisible = rect.bottom >= visible.top && rect.top <= visible.bottom;
      const buffered =
        rect.bottom >= visible.top - buffer && rect.top <= visible.bottom + buffer;
      if (strictlyVisible) {
        await renderSlot(i, generation);
      } else if (buffered) {
        queueRender(i);
      }
    }
  };

  // 懒渲染：视口附近（上下各 ~0.8 屏缓冲）的页栅格化，离屏过远的清画布。
  observer =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const idx = Number((entry.target as HTMLElement).dataset.pageIndex);
              if (entry.isIntersecting) {
                queueRender(idx);
              } else {
                clearSlot(idx);
              }
            }
          },
          { root: scroller, rootMargin: PDF_RENDER_ROOT_MARGIN },
        )
      : null;
  if (observer !== null) {
    for (const slot of slots) {
      observer.observe(slot);
    }
  } else {
    // 无 IntersectionObserver（理论上 WebView2 不会有）兜底：渲染全部。
    for (let i = 0; i < total; i += 1) {
      queueRender(i);
    }
  }

  // 槽位已齐即可返回 handle。首屏画页放到 rAF：不必等其余 getPage，
  // 调用方若立刻 rerender/destroy，世代变化后这次会自动作废。
  const born = renderGeneration;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (destroyed || isAborted() || born !== renderGeneration) {
        return;
      }
      void paintVisibleBuffer(born);
    });
  } else {
    void paintVisibleBuffer(born);
  }

  const measureRemainingPages = async (): Promise<void> => {
    if (total <= 1) {
      return;
    }
    for (let i = 1; i < total; i += 1) {
      if (destroyed || isAborted()) {
        return;
      }
      const page = await doc.getPage(i + 1);
      if (destroyed || isAborted()) {
        return;
      }
      const native = page.getViewport({ scale: 1 });
      nativeSizes[i] = { width: native.width, height: native.height };
      // 用户可能已滚离首屏：每批改槽高前重采当前锚点，避免把旧首屏点写回。
      const live = captureViewportAnchor();
      applySlotMetrics(i);
      if (i % MEASURE_BATCH === 0 || i === total - 1) {
        keepViewportAnchor(live.view, live.anchor);
      }
      if (i % MEASURE_BATCH === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
  };
  void measureRemainingPages()
    .then(() => {
      // 真实页宽回填后（可能比页 1 宽）重估横向溢出。
      dragPan.sync();
    })
    .catch(() => undefined);

  // 滚动时把视口顶部最近的页回写 controller.page（供书签/笔记定位与侧栏跳转）。
  // 从上一帧页码附近走，避免每帧对全部槽位 getBoundingClientRect。
  // scroll 事件经 rAF 合并，帧内连发只同步一次。
  let pageHint = 0;
  const onScroll = (): void => {
    // 触底钳制：缩小后多页同屏时，末页顶边永远到不了视口顶，nearest-top
    // 会把页码钉在前面的页（看着最后一页却显示 n-1/n）；滚到底直接采纳末页。
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    if (maxScrollTop > 0 && scroller.scrollTop >= maxScrollTop - 2) {
      pageHint = total - 1;
      controller.setPage(total);
      return;
    }
    const viewTop = scroller.getBoundingClientRect().top;
    const topOf = (index: number): number => slots[index]!.getBoundingClientRect().top;
    let i = Math.max(0, Math.min(total - 1, pageHint));
    while (i > 0 && topOf(i) > viewTop) {
      i -= 1;
    }
    while (i < total - 1 && topOf(i + 1) <= viewTop) {
      i += 1;
    }
    if (i < total - 1 && Math.abs(topOf(i + 1) - viewTop) < Math.abs(topOf(i) - viewTop)) {
      i += 1;
    }
    pageHint = i;
    controller.setPage(i + 1);
  };
  const scrollFrames = rafFrameScheduler();
  const scrollCoordinator =
    scrollFrames === null ? null : createCoalescedScrollHandler(onScroll, scrollFrames);
  const onScrollEvent = (): void => {
    if (scrollCoordinator === null) {
      onScroll();
      return;
    }
    scrollCoordinator.schedule();
  };
  scroller.addEventListener('scroll', onScrollEvent, { passive: true });

  const rerender = async (): Promise<void> => {
    renderGeneration += 1;
    const generation = renderGeneration;
    cancelRenderTasks();
    cancelTextLayers();
    queued.clear();
    pendingRender.length = 0;
    const captured = captureViewportAnchor();
    const firstNative = nativeSizes[0];
    if (firstNative !== undefined) {
      refreshFitWidth(firstNative.width);
    }
    for (let i = 0; i < total; i += 1) {
      applySlotMetrics(i);
      clearSlot(i);
    }
    keepViewportAnchor(captured.view, captured.anchor);
    dragPan.sync(); // 缩放后横向溢出可能出现/消失，重估拖拽平移开关
    // 重渲染范围与 IntersectionObserver 的懒加载缓冲（rootMargin 80% ≈ 上下各 0.8 屏）
    // 对齐：observer 只在相交状态变化时派发事件，仍在缓冲区内的页被 clearSlot 清掉后
    // 不会再收到通知，必须由 rerender 主动补画，否则缩放后滚动会出现空白页。
    await paintVisibleBuffer(generation);
    onScroll();
  };

  const onHostResize = (): void => {
    if (destroyed || isAborted()) {
      return;
    }
    const firstNative = nativeSizes[0];
    if (firstNative === undefined) {
      return;
    }
    const nextFit = pdfFitWidthScale(pageHostContentWidth(container), firstNative.width);
    if (Math.abs(nextFit - fitWidthScale) < 1e-6) {
      return;
    }
    void rerender();
  };
  const hostResizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onHostResize) : null;
  hostResizeObserver?.observe(container);

  const scrollToPage = (page: number): void => {
    const target = Math.min(total, Math.max(1, Math.floor(page)));
    controller.setPage(target);
    slots[target - 1]?.scrollIntoView({ block: 'start' });
  };

  /** 懒取某页拼接文本（缓存优先；未渲染过的页经 getPage/getTextContent 补齐）。 */
  const ensurePageText = async (index: number): Promise<string> => {
    const cached = pageTexts[index];
    if (cached !== undefined) {
      return cached;
    }
    const page = await doc.getPage(index + 1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
    pageTexts[index] = text;
    return text;
  };

  const search = async (
    query: string,
    options?: {
      readonly onProgress?: (matches: PdfSearchMatch[], done: boolean) => void;
    },
  ): Promise<PdfSearchMatch[]> => {
    if (query.trim().length === 0 || destroyed || isAborted()) {
      return [];
    }
    // 逐页懒取文本后复用 findPdfMatches；每几页交出一帧，避免整本扫描锁死输入。
    const texts: string[] = [];
    let matches: PdfSearchMatch[] = [];
    for (let index = 0; index < total && !destroyed && !isAborted(); index += 1) {
      texts.push(await ensurePageText(index));
      const done = index === total - 1;
      if (done || (index + 1) % 2 === 0) {
        matches = findPdfMatches(texts, query);
        options?.onProgress?.(matches, done);
        if (!done) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
        }
      }
    }
    return matches;
  };

  const outline = async (): Promise<OutlineItem[]> => {
    if (destroyed || isAborted()) {
      return [];
    }
    return outlineFromPdf(doc);
  };

  return {
    controller,
    rerender,
    scrollToPage,
    search,
    outline,
    destroy: async () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      renderGeneration += 1;
      signal?.removeEventListener('abort', onAbort);
      cancelRenderTasks();
      cancelTextLayers();
      scroller.removeEventListener('scroll', onScrollEvent);
      dragPan.release();
      scrollCoordinator?.cancel();
      observer?.disconnect();
      hostResizeObserver?.disconnect();
      try {
        await loadingTask.destroy();
      } finally {
        rangeController?.abort();
        await randomSource?.close().catch(() => undefined);
      }
    },
  };
}
