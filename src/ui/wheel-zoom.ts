/**
 * Ctrl/Cmd + 滚轮 → 字号缩放（R5）。
 *
 * 与 Ctrl+= / Ctrl+- 共用同一 font-scale 档位与 localStorage 持久化：
 * 向上滚（deltaY<0）放大一档，向下滚缩小一档；放开修饰键则不介入，普通滚轮
 * 行为不变。监听注册在 capture 阶段，确保代码块 / 源码态 / 阅读器内各内容的
 * wheel 监听不会吞掉 Ctrl+滚轮；源码态（source-view.ts）额外在自身 onWheel
 * 顶部短路修饰键作为双保险。
 *
 * 鼠标锚点（R5 修复）：缩放只改 CSS 变量，scrollTop 不变 → 鼠标指针下的内容
 * 随重排上下漂移。缩放前记录指针下的块级锚点（元素 + 块内相对位置），缩放后
 * 补偿滚动容器 scrollTop，让指针下的内容保持在原处（浏览器 Ctrl+滚轮同款体验）。
 */
import type { FontScaleHandle } from './font-scale.js';

export type WheelListener = (event: WheelEvent) => void;

export interface WheelZoomTarget {
  addEventListener(type: 'wheel', listener: WheelListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: 'wheel', listener: WheelListener, options?: EventListenerOptions): void;
}

export interface WheelZoomHandle {
  dispose(): void;
}

export interface WheelZoomOptions {
  /** Override the zoom-modifier test（default: ctrlKey || metaKey）。 */
  isZoomModifier?: (event: WheelEvent) => boolean;
  /**
   * 锚点捕获的事件源（生产缺省为全局 document；测试注入 fake）。
   * 仅需要 elementFromPoint；显式传 null 可关闭锚点补偿。
   */
  anchorSource?: WheelZoomAnchorSource | null;
  /**
   * Minimum interval between zoom steps. Trackpads emit many wheel events per
   * gesture; without coalescing, EPUB iframes reflow on every step.
   */
  minIntervalMs?: number;
}

/** 参与锚点补偿的滚动容器（编辑区 / 阅读器滚动槽）。 */
export const ZOOM_SCROLLER_SELECTOR =
  '#lightink-editor-area, .lightink-reader-scroll, .lightink-reader-pages';

/** 锚点取指针下最近的块级元素（行内元素随折行跳动，块级更稳）。 */
export const ZOOM_ANCHOR_BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, ' +
  '.lightink-reader-chapter, .lightink-reader-page-slot';

/** 锚点捕获所需的 elementFromPoint 最小面。 */
export interface WheelZoomAnchorSource {
  elementFromPoint(x: number, y: number): WheelZoomAnchorElement | null;
}

/** 锚点元素最小面（真实 DOM Element 结构兼容）。 */
export interface WheelZoomAnchorElement {
  closest(selector: string): WheelZoomAnchorElement | null;
  getBoundingClientRect(): { readonly top: number; readonly height: number };
}

/** 缩放前捕获的鼠标锚点：块级元素 + 指针在块内的纵向比例 + 指针视口 Y。 */
export interface WheelZoomAnchor {
  readonly block: WheelZoomAnchorElement;
  readonly scroller: WheelZoomAnchorElement & { scrollTop: number };
  readonly frac: number;
  readonly clientY: number;
}

/**
 * 捕获指针 (x, y) 下的内容锚点。指针不在可补偿的滚动容器内（标签栏 / 大纲等）
 * 或命中不到元素时返回 null（缩放仍生效，只是不补偿）。
 */
export function captureWheelZoomAnchor(
  source: WheelZoomAnchorSource,
  x: number,
  y: number,
): WheelZoomAnchor | null {
  const el = source.elementFromPoint(x, y);
  if (el === null) return null;
  const scroller = el.closest(ZOOM_SCROLLER_SELECTOR) as
    | (WheelZoomAnchorElement & { scrollTop: number })
    | null;
  if (scroller === null) return null;
  const block = el.closest(ZOOM_ANCHOR_BLOCK_SELECTOR) ?? el;
  const rect = block.getBoundingClientRect();
  const raw = rect.height > 0 ? (y - rect.top) / rect.height : 0;
  const frac = Math.min(Math.max(raw, 0), 1);
  return { block, scroller, frac, clientY: y };
}

/**
 * 缩放后补偿：调整滚动容器 scrollTop，使锚点块内同一相对位置回到指针 Y。
 * 读取 getBoundingClientRect 强制同步重排，故新几何已反映缩放后布局。
 * 触底/触顶的钳制由浏览器完成（边界处内容仍可能微移，不可避免）。
 */
export function restoreWheelZoomAnchor(anchor: WheelZoomAnchor): void {
  const rect = anchor.block.getBoundingClientRect();
  const delta = rect.top + anchor.frac * rect.height - anchor.clientY;
  if (delta !== 0) {
    anchor.scroller.scrollTop += delta;
  }
}

function datasetOf(el: { dataset?: DOMStringMap } | null): DOMStringMap | undefined {
  return el?.dataset;
}

/** 指针或事件目标落在直播 PDF 页宿主上。 */
export function wheelEventHitsLivePdf(
  event: { readonly target?: EventTarget | null; readonly clientX?: number; readonly clientY?: number },
  source: WheelZoomAnchorSource | null,
): boolean {
  const fromPoint =
    source !== null && typeof event.clientX === 'number' && typeof event.clientY === 'number'
      ? source.elementFromPoint(event.clientX, event.clientY)
      : null;
  const node = (event.target as WheelZoomAnchorElement | null) ?? fromPoint;
  if (node === null || typeof node.closest !== 'function') {
    return false;
  }
  const pages = node.closest('.lightink-reader-pages') as
    | (WheelZoomAnchorElement & { dataset?: DOMStringMap })
    | null;
  const dataset = datasetOf(pages);
  return dataset?.readerFormat === 'pdf' && dataset.readerActive === 'true';
}

/**
 * Install Ctrl/Cmd + wheel font zoom on `target`（usually `document`）。
 * Captures at the target so the event reaches this handler before any
 * content-level wheel listeners.
 */
export function installWheelZoom(
  target: WheelZoomTarget,
  handle: FontScaleHandle,
  options: WheelZoomOptions = {},
): WheelZoomHandle {
  const isZoom =
    options.isZoomModifier ?? ((event: WheelEvent) => event.ctrlKey || event.metaKey);
  const anchorSource =
    options.anchorSource !== undefined
      ? options.anchorSource
      : typeof document !== 'undefined'
        ? (document as unknown as WheelZoomAnchorSource)
        : null;
  const minIntervalMs = options.minIntervalMs ?? 80;
  let lastStepAt = 0;
  const onWheel: WheelListener = (event) => {
    if (!isZoom(event)) return;
    if (event.deltaY === 0) return;
    event.preventDefault();
    // 事件已在 capture 阶段完整作为缩放处理，不再传给内容层 wheel 监听
    // （如源码态 textarea 的滚动转发）。
    event.stopPropagation();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastStepAt < minIntervalMs) {
      return;
    }
    lastStepAt = now;
    // 直播 PDF：改 userZoom，不写字号，也不做流式块锚补偿（PDF 自己按视口中心锚定）。
    if (wheelEventHitsLivePdf(event, anchorSource)) {
      if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
        document.dispatchEvent(
          new CustomEvent('lightink:pdf-user-zoom', {
            detail: { direction: event.deltaY < 0 ? 1 : -1 },
          }),
        );
      }
      return;
    }
    // 缩放前捕获指针锚点；无坐标事件（headless 测试 / 合成事件）跳过补偿。
    const anchor =
      anchorSource !== null &&
      typeof event.clientX === 'number' &&
      typeof event.clientY === 'number'
        ? captureWheelZoomAnchor(anchorSource, event.clientX, event.clientY)
        : null;
    if (event.deltaY < 0) {
      handle.zoomIn();
    } else {
      handle.zoomOut();
    }
    if (anchor !== null) {
      restoreWheelZoomAnchor(anchor);
    }
  };
  target.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return {
    dispose(): void {
      target.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}
