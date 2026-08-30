/**
 * `pdf` — PDF 页格式渲染（ebook-reader T5 + 文本层）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 懒加载 pdfjs-dist（worker 经 `?url` 独立 chunk），把当前页渲染到 canvas，
 * 并在其上叠加 pdfjs `TextLayer` 文本层（DOM span 承载文字选择，版式仍由 canvas 保真）。
 * 文本层与 canvas 同生命周期：懒渲染、缩放按视口中心锚定并只重绘可见页、离屏回收；渲染失败降级纯 canvas。
 * 返回 handle 供导航/缩放重绘。canvas/文本层真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import type { OutlineItem } from '../../outline/outline-model.js';
import { outlineFromPdf } from '../outline.js';
import { ParseError } from './types.js';
import { enforcePageCount } from '../reader-limits.js';
import { findPdfMatches, type PdfSearchMatch } from '../search-panel.js';
import { bindTextLayerSelection } from '../text-layer-selection.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import {
  createCoalescedScrollHandler,
  nearestVisibleSlot,
  rafFrameScheduler,
} from '../../ui/reading-layout.js';
import { isRandomAccessSource, type RandomAccessSource } from '../sources/types.js';

/** 缩放档位（与字号缩放独立，PDF 像素级）。 */
export const PDF_SCALE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const DEFAULT_SCALE_IDX = 2; // 1.0

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

/** 当前设备像素比（WebView2 下读 window.devicePixelRatio）。 */
function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/** 阅读字号缩放（页宿主不走 CSS zoom，栅格化时乘入 viewport）。 */
export function readingFontScale(): number {
  if (typeof document === 'undefined') {
    return 1;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--lightink-font-scale')
    .trim();
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * 用 pdfjs-dist 把 PDF 以**连续垂直滚动**渲染进容器。worker 经 `?url` 独立 chunk
 * 懒加载。每页一个 `.lightink-reader-page-slot` 占位（预取 viewport 定高，避免滚动
 * 跳变），IntersectionObserver 懒栅格化：仅渲染视口附近（rootMargin 缓冲）的页到
 * canvas，离屏过远的清画布省内存。缩放重算所有 slot 高度并重渲染可见页。
 *
 * 真实 canvas/滚动渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */
export async function renderPdfInto(
  input: Uint8Array | RandomAccessSource,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<PdfRenderHandle> {
  throwIfReaderLoadCancelled(signal);
  const pdfjs = await import('pdfjs-dist');
  const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  throwIfReaderLoadCancelled(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;

  const randomSource = isRandomAccessSource(input) ? input : null;
  let rangeFailure: unknown = null;
  let rangeController: AbortController | null = null;
  let loadingTask: ReturnType<typeof pdfjs.getDocument>;
  if (randomSource === null) {
    // 字节来自 raw IPC 专属拷贝，无复用方，直接移交 pdfjs，避免整本 PDF 防御拷贝。
    loadingTask = pdfjs.getDocument({ data: input as Uint8Array });
  } else {
    rangeController = new AbortController();
    const controller = rangeController;
    class SourceRangeTransport extends pdfjs.PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number): void {
        void randomSource!
          .readRange(begin, end - begin, controller.signal)
          .then((chunk) => {
            if (!controller.signal.aborted) {
              this.onDataRange(begin, chunk);
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

  // 每页一个占位 slot；预取 viewport 定高（getPage 不栅格化，开销远小于 render）。
  const slots: HTMLDivElement[] = [];
  const sizes: { width: number; height: number }[] = [];
  const sizeSlot = (slot: HTMLDivElement, w: number, h: number): void => {
    slot.style.width = `${Math.floor(w)}px`;
    slot.style.height = `${Math.floor(h)}px`;
  };

  const pageCssScale = (): number => controller.scale * readingFontScale();
  let appliedCssScale = pageCssScale();

  container.replaceChildren();
  for (let i = 1; i <= total; i += 1) {
    const page = await doc.getPage(i);
    throwIfReaderLoadCancelled(signal);
    const vp = page.getViewport({ scale: appliedCssScale });
    sizes.push({ width: vp.width, height: vp.height });
    const slot = document.createElement('div');
    slot.className = 'lightink-reader-page-slot';
    slot.dataset.pageIndex = String(i - 1);
    sizeSlot(slot, vp.width, vp.height);
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

  const queueRender = (index: number): void => {
    void renderSlot(index).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[lightink/reader] PDF page render failed', error);
    });
  };

  /** 清掉离屏过远的 slot 画布与文本层，释放内存（再次进入视口会重渲染）。 */
  const clearSlot = (index: number): void => {
    renderTasks.get(index)?.cancel();
    textLayers.get(index)?.cancel();
    slots[index]?.replaceChildren();
  };

  // PDF 只在页宿主连续竖滚；不按 html[data-reading-layout] 切到 editor-area。
  const scroller = container;

  const paintVisibleBuffer = async (generation: number): Promise<void> => {
    const visible = scroller.getBoundingClientRect();
    if (visible.height <= 0) {
      if (slots[0] !== undefined) {
        await renderSlot(0, generation);
      }
      return;
    }
    const buffer = visible.height * 2;
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

  // 懒渲染：视口附近（上下各 ~2 屏缓冲）的页栅格化，离屏过远的清画布。
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
          { root: scroller, rootMargin: '200% 0px 200% 0px' },
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

  // 首屏不把出页只交给 IntersectionObserver（root 不对或首帧未相交时会空白）。
  // 放到 rAF：调用方若立刻 rerender/destroy，世代变化后这次会自动作废。
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

  // 滚动时把视口顶部最近的页回写 controller.page（供书签/笔记定位与侧栏跳转）。
  // 槽位判定走共享 nearestVisibleSlot；scroll 事件经 rAF 合并，帧内连发只同步一次。
  const onScroll = (): void => {
    const top = scroller.getBoundingClientRect().top;
    const slotTops = slots.map((slot) => slot.getBoundingClientRect().top);
    const nearest = nearestVisibleSlot(slotTops, top);
    if (nearest >= 0) {
      controller.setPage(nearest + 1);
    }
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
    const view = scroller.getBoundingClientRect();
    const slotRects = slots.map((slot) => slot.getBoundingClientRect());
    const anchor = pdfViewportAnchor(view, slotRects, Math.max(0, controller.page - 1));
    const nextScale = pageCssScale();
    const factor = appliedCssScale > 0 ? nextScale / appliedCssScale : 1;
    appliedCssScale = nextScale;
    for (let i = 0; i < total; i += 1) {
      const current = sizes[i];
      if (current === undefined) {
        continue;
      }
      const next = {
        width: current.width * factor,
        height: current.height * factor,
      };
      sizes[i] = next;
      sizeSlot(slots[i]!, next.width, next.height);
      clearSlot(i);
    }
    const nextSlot = slots[anchor.index]?.getBoundingClientRect();
    if (nextSlot !== undefined) {
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
    }
    // 重渲染范围与 IntersectionObserver 的懒加载缓冲（rootMargin 200% ≈ 上下各 2 屏）
    // 对齐：observer 只在相交状态变化时派发事件，仍在缓冲区内的页被 clearSlot 清掉后
    // 不会再收到通知，必须由 rerender 主动补画，否则缩放后滚动会出现空白页。
    await paintVisibleBuffer(generation);
    onScroll();
  };

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
      scrollCoordinator?.cancel();
      observer?.disconnect();
      try {
        await loadingTask.destroy();
      } finally {
        rangeController?.abort();
        await randomSource?.close().catch(() => undefined);
      }
    },
  };
}
