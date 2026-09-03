/**
 * `pdf` — PDF 页格式渲染（官方 pdfjs-dist 组件层内核，T3）。
 *
 * `createPdfPageController` 是纯页码/缩放状态机（next/prev/setPage/zoom），headless 可测；
 * `renderPdfInto` 经 `pdfjs-boot` 一次拿到主库与官方组件层（worker/组件层懒加载顺序由
 * 引导模块保证），getDocument 打开链路保持在应用侧（browserLocal 整读、自定义
 * SourceRangeTransport、useWasm/useWorkerFetch 关闭、enforcePageCount），文档交给官方
 * `PDFViewer` 渲染：`EventBus` + `PDFLinkService` + `PDFViewer` 装配后 `setDocument`。
 * 页 DOM（`.pdfViewer > .page[data-page-number]`）、懒渲染/缓冲（PDFPageViewBuffer）、
 * 缩放锚点与 scale 变量（`--scale-factor`→`.page` 级联）全部由官方组件承担；本模块只做
 * 事件接线（页码回写/档位映射/触底钳制/文本层护栏安装）、fit-width 计算、搜索/大纲
 * （面向 PDFDocumentProxy）与对称作废。
 *
 * canvas/文本层真实渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */

import '../pdf-viewer.css';

import { isTauriRuntime } from '../../file/browser-file-store.js';
import type { OutlineItem } from '../../outline/outline-model.js';
import { outlineFromPdf } from '../outline.js';
import { ParseError } from './types.js';
import { enforcePageCount } from '../reader-limits.js';
import { findPdfMatches, type PdfSearchMatch } from '../search-panel.js';
import { bindTextLayerSelection } from '../text-layer-selection.js';
import { bindPdfDragPan } from './pdf-drag-pan.js';
import { loadPdfjsComponents } from './pdfjs-boot.js';
import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import { isRandomAccessSource, type RandomAccessSource } from '../sources/types.js';

/** userZoom 档位。还原 = 1，即适合页宽（fitWidthScale * 1），不是 100% 设备像素。 */
export const PDF_SCALE_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const DEFAULT_SCALE_IDX = 2; // userZoom 1.0 = 适合页宽

/** 官方 TextLayerMode.ENABLE（pdf_viewer.mjs 未导出该常量，字面值 1）。 */
const TEXT_LAYER_MODE_ENABLE = 1;

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
  /** 官方 viewer 缩放事件回写：把 userZoom 吸附到最近档位（保持 controller.scale 与 currentScale 同源）。 */
  syncScale(userZoom: number): boolean;
}

/**
 * 创建页码/缩放状态机。所有变更返回是否真正改变（供调用方决定是否重绘）。
 * 纯逻辑、无 DOM，headless 可测。渲染内核接线时页码由 viewer `pagechanging`
 * 事件回写、档位由 `scalechanging` 回写（syncScale），消费方仍只读写本状态机。
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
    syncScale(userZoom) {
      if (!Number.isFinite(userZoom) || userZoom <= 0) {
        return false;
      }
      let best = scaleIdx;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < PDF_SCALE_STEPS.length; i += 1) {
        const dist = Math.abs(PDF_SCALE_STEPS[i]! - userZoom);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best === scaleIdx) {
        return false;
      }
      scaleIdx = best;
      return true;
    },
  };
}

export interface PdfRenderHandle {
  readonly controller: PdfPageController;
  /** 容器尺寸变化时重算适合页宽并重设 currentScale；官方组件自管重排与懒渲染。 */
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
  /** 释放 pdfjs 文档资源 + 摘除全部监听（关闭/重开 PDF 时调用）。 */
  destroy(): Promise<void>;
}

export type { PdfSearchMatch };

function pageHostContentWidth(host: HTMLElement): number {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  const pad =
    style !== null
      ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      : 0;
  return Math.max(0, host.clientWidth - pad);
}

type PdfjsComponents = Awaited<ReturnType<typeof loadPdfjsComponents>>;
type PdfViewerModule = PdfjsComponents['viewer'];
type PdfViewerInstance = InstanceType<PdfViewerModule['PDFViewer']>;
type PdfEventBusInstance = InstanceType<PdfViewerModule['EventBus']>;

/** 官方 viewer 事件载荷（组件层 dispatch 的对象形状，类型未随包导出）。 */
interface ViewerPageEvent {
  readonly pageNumber: number;
}
interface ViewerScaleEvent {
  readonly scale: number;
  readonly presetValue?: string | undefined;
}
interface ViewerTextLayerEvent {
  readonly pageNumber: number;
  readonly error?: unknown;
}

/**
 * 用官方 pdfjs-dist 组件层把 PDF 以**连续垂直滚动**渲染进容器。打开链路
 * （同源 boot worker、browserLocal 整读、SourceRangeTransport 有界随机读、
 * useWasm/useWorkerFetch 关闭、enforcePageCount、取消语义）保持在应用侧；
 * 文档就绪后按顺序装配：宿主 → append `div.pdfViewer` → `EventBus` →
 * `PDFLinkService{eventBus}` → `PDFViewer{container, viewer, eventBus,
 * linkService, textLayerMode:ENABLE}` → `setDocument(doc)`。
 *
 * 真实 canvas/滚动渲染留手工验证（无 jsdom/pdf 样本的 node 测试）。
 */
export async function renderPdfInto(
  input: Uint8Array | RandomAccessSource,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<PdfRenderHandle> {
  throwIfReaderLoadCancelled(signal);
  // 引导（polyfill → 主库 → 幂等挂 globalThis.pdfjsLib → 同源 boot worker →
  // 组件层）一次拿到主库与 viewer 组件；渲染内核只经 pdfjs-boot 取 pdfjs。
  const { pdfjs, viewer: viewerModule } = await loadPdfjsComponents();
  throwIfReaderLoadCancelled(signal);

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
  const isAborted = (): boolean => signal?.aborted === true;

  // —— 官方装配（顺序合同，测试钉死）——
  // 先 append `div.pdfViewer` 再构造 PDFViewer：reader.css 以
  // `.lightink-reader-pages:has(> .pdfViewer)` 给宿主补 position:absolute（官方
  // 构造器在 offsetParent 存在时校验宿主必须 absolute），顺序颠倒即失去样式
  // 前提；官方构造器另要求 container/viewer 均为 DIV。
  container.replaceChildren();
  const viewerDiv = document.createElement('div');
  viewerDiv.className = 'pdfViewer';
  container.appendChild(viewerDiv);

  // 监听与 viewer 内部 observer 的统一作废信号：EventBus.on 支持 { signal }
  //（组件层无 teardown 方法），PDFViewer 的 abortSignal 同源断开其
  // ResizeObserver 与 scroll 监听。destroy / 载入中止时 abort 一次全摘。
  const teardown = new AbortController();
  const listenOptions = { signal: teardown.signal };

  let eventBus: PdfEventBusInstance;
  let pdfViewer: PdfViewerInstance;
  try {
    eventBus = new viewerModule.EventBus();
    const linkService = new viewerModule.PDFLinkService({ eventBus });
    // 运行时支持 abortSignal（构造器据此断开内部 ResizeObserver/scroll 监听，
    // pdf_viewer.mjs:7910-7919），pdf_viewer.d.ts 的 PDFViewerOptions 未声明该
    // 键，这里以交叉类型补上。
    const viewerOptions: ConstructorParameters<PdfViewerModule['PDFViewer']>[0] & {
      readonly abortSignal?: AbortSignal;
    } = {
      container: container as HTMLDivElement,
      viewer: viewerDiv,
      eventBus,
      linkService,
      textLayerMode: TEXT_LAYER_MODE_ENABLE,
      // 选区观感显式决策（两态 pdf-viewer.css 均已支持）：
      // false = 原生选区 + 应用标注 wash（收窄 wash 规则着色），对齐现行阅读器
      // 选色与主题令牌，且免掉 DrawLayer 选区覆盖层的额外合成；true 则是官方
      // DrawLayer 蓝色覆盖层 + 原生选区护栏态透明。取 false 保持观感延续。
      enableSelectionRendering: false,
      abortSignal: teardown.signal,
    };
    pdfViewer = new viewerModule.PDFViewer(viewerOptions);
  } catch (error) {
    teardown.abort();
    await loadingTask.destroy().catch(() => undefined);
    await randomSource?.close().catch(() => undefined);
    viewerDiv.remove();
    throw error;
  }

  let fitWidthScale = 1;
  /** pagesinit 时量得的第 1 页 CSS 宽（scale=1 口径；官方 page-fit 同式归一）。 */
  let firstPageCssWidth = 0;

  // PDF 只在页宿主连续竖滚；不按 html[data-reading-layout] 切到 editor-area。
  // 触屏环境：放大出横向溢出后由指针拖拽平移；捏合/双击经注入的 scale 绑定
  // 直写 currentScale（rAF 合并 + 应用侧锚点修正），落档仍由下方
  // scalechanging→syncScale 吸档回环负责（官方不提供触屏手势，见 pdf-drag-pan）。
  const dragPan = bindPdfDragPan(container, {
    scale: {
      getCurrentScale: () => pdfViewer.currentScale,
      setCurrentScale: (scale: number): void => {
        pdfViewer.currentScale = scale;
      },
      getFitWidthScale: () => fitWidthScale,
      steps: PDF_SCALE_STEPS,
    },
  });
  /** 每页拼接文本缓存（原始字形坐标系，与官方文本层 DOM 拼接文本一致；懒填充）。 */
  const pageTexts: string[] = [];
  /** 文本层选区护栏卸载函数（层根键控）：官方渲染缓冲驱逐/模块注册表 prune 掉
   * detached 层后按连接性对称摘除，防已作废卸载闭包滞留到 destroy。 */
  const textLayerUnbinds = new Map<HTMLElement, () => void>();

  /** 修剪已脱离文档的层根条目（unbind 幂等，模块侧已执行过也无副作用）。 */
  const pruneDetachedTextLayerUnbinds = (): void => {
    for (const [layer, unbind] of textLayerUnbinds) {
      if (!layer.isConnected) {
        textLayerUnbinds.delete(layer);
        try {
          unbind();
        } catch {
          // 层根已被官方回收时卸载可能失效，忽略。
        }
      }
    }
  };

  const refreshFitWidth = (): void => {
    fitWidthScale = pdfFitWidthScale(pageHostContentWidth(container), firstPageCssWidth);
  };

  /** 档位 → currentScale：官方自管重排、懒渲染与滚动锚点。 */
  const applyScale = (): void => {
    pdfViewer.currentScale = pdfCssScale(fitWidthScale, controller.scale);
  };

  // pagesinit：第 1 页已就位（官方在 firstPagePromise 后建页并写 --scale-factor），
  // 量页宽定适合页宽并落初始比例；文本层/画布渲染由官方渲染队列自管。
  const onPagesInit = (): void => {
    if (destroyed) {
      return;
    }
    const first = pdfViewer.getPageView(0) as { width?: unknown; scale?: unknown } | undefined;
    if (
      first !== undefined &&
      typeof first.width === 'number' &&
      typeof first.scale === 'number' &&
      first.scale > 0
    ) {
      firstPageCssWidth = first.width / first.scale;
    }
    refreshFitWidth();
    applyScale();
    dragPan.sync();
  };

  // 页码回写：viewer 以可见度选中当前页；触底钳制保留现行语义——缩小后多页
  // 同屏时末页顶边永远到不了视口顶，滚到底直接采纳末页（看着最后一页却显示
  // n-1/n）。
  const onPageChanging = (evt: ViewerPageEvent): void => {
    if (destroyed) {
      return;
    }
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const page =
      maxScrollTop > 0 && container.scrollTop >= maxScrollTop - 2 ? total : evt.pageNumber;
    controller.setPage(page);
  };

  // 官方自发的缩放变化（触屏手势/未来接线）回写档位，避免 controller.scale 与
  // currentScale 脱钩；缩放后横向溢出可能出现/消失，重估拖拽平移开关。
  const onScaleChanging = (evt: ViewerScaleEvent): void => {
    if (destroyed) {
      return;
    }
    if (fitWidthScale > 0) {
      controller.syncScale(evt.scale / fitWidthScale);
    }
    dragPan.sync();
  };

  // 官方 TextLayerBuilder 生命周期：渲染完成后对层根装现有选区护栏（其内部
  // 适配属 T4；此处只保证调用点与层根正确）。失败/取消由官方记录并降级纯
  // canvas，不重复报错。
  const onTextLayerRendered = (evt: ViewerTextLayerEvent): void => {
    if (destroyed || evt.error != null) {
      return;
    }
    // 新层渲染 = 缓冲刚换页的时刻：顺手修剪被官方驱逐层的滞留条目。
    pruneDetachedTextLayerUnbinds();
    const layerDiv = (
      pdfViewer.getPageView(evt.pageNumber - 1) as { textLayer?: { div?: unknown } } | undefined
    )?.textLayer?.div;
    if (layerDiv instanceof HTMLElement) {
      textLayerUnbinds.set(layerDiv, bindTextLayerSelection(layerDiv));
    }
  };

  eventBus.on('pagesinit', onPagesInit, listenOptions);
  eventBus.on('pagechanging', onPageChanging, listenOptions);
  eventBus.on('scalechanging', onScaleChanging, listenOptions);
  eventBus.on('textlayerrendered', onTextLayerRendered, listenOptions);

  pdfViewer.setDocument(doc);

  const releaseTextLayerBindings = (): void => {
    for (const [layer, unbind] of textLayerUnbinds) {
      textLayerUnbinds.delete(layer);
      try {
        unbind();
      } catch {
        // 页视图已被官方回收时层根随之失效。
      }
    }
  };

  /**
   * 官方清空路径：`setDocument(null)` 同步 dispatch `pagesdestroy` →
   * `_cancelRendering` → `_resetView`——abort `#eventAC`（摘除 setDocument 在
   * document 上以 {signal} 注册的 copy 监听）、移除 `#hiddenCopyElement`、
   * 清空 viewer DOM 与全部页视图对象图（`cleanup` 只 reset 非 FINISHED 页，
   * 已渲染页的全分辨率 canvas 只有本路径能释放）。teardown.abort 之后调用
   * 安全：清空路径只触实例字段与 viewer DOM，不依赖未中止的信号。类型上
   * d.ts 的 setDocument 形参未声明 null（运行时官方清空分支支持），以窄化
   * 断言传入。
   */
  const clearViewerDocument = (): void => {
    (pdfViewer.setDocument as (pdfDocument: unknown) => void)(null);
  };

  const onAbort = (): void => {
    teardown.abort();
    dragPan.release();
    releaseTextLayerBindings();
    try {
      clearViewerDocument();
    } catch {
      // 官方清空路径只触实例字段与 viewer DOM；极端抛错不阻断其余清理。
    }
    rangeController?.abort();
    void loadingTask.destroy();
    void randomSource?.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  throwIfReaderLoadCancelled(signal);

  const rerender = async (): Promise<void> => {
    if (destroyed) {
      return;
    }
    refreshFitWidth();
    applyScale();
  };

  const scrollToPage = (page: number): void => {
    const target = Math.min(total, Math.max(1, Math.floor(page)));
    controller.setPage(target);
    pdfViewer.scrollPageIntoView({ pageNumber: target });
  };

  /**
   * 懒取某页拼接文本（缓存优先；未渲染过的页经 getPage/getTextContent 补齐）。
   * 坐标系合同（T4 P1）：必须与官方 TextLayer DOM 同为**原始字形串**。默认
   * getTextContent 会让 worker normalizeUnicode（pdf.worker.mjs:722-726）展开
   * ﬁ/ﬂ/ﬀ/ﬆ 及希伯来/阿拉伯呈现形式（文本变长），命中 offset 映射到层 DOM 即
   * 错位/整页缺失。官方 TextLayerBuilder（pdf_viewer.mjs:6068-6071
   * streamTextContent disableNormalization:true）与 PDFFindController
   * #extractText（pdf_viewer.mjs:1160-1163）同口径取原始字形串；连字查询命中
   * 能力（"fi" 命中 "ﬁ"）由 findPdfTextHits 的规范化视图在匹配层保全。
   */
  const ensurePageText = async (index: number): Promise<string> => {
    const cached = pageTexts[index];
    if (cached !== undefined) {
      return cached;
    }
    const page = await doc.getPage(index + 1);
    const content = await page.getTextContent({ disableNormalization: true });
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
      signal?.removeEventListener('abort', onAbort);
      teardown.abort();
      dragPan.release();
      releaseTextLayerBindings();
      // 先官方清空再 cleanup/destroy（贴官方 setDocument 卸载序）：释放
      // cleanup 覆盖不到的 FINISHED 页 canvas、页视图对象图与 document 级
      // copy 监听，否则随会话内开关书次数无界累积。置于 try 内：清空极端
      // 抛错时 finally 仍保证 range abort/源关闭/DOM 移除。
      try {
        clearViewerDocument();
        pdfViewer.cleanup();
        await loadingTask.destroy();
      } finally {
        rangeController?.abort();
        await randomSource?.close().catch(() => undefined);
        viewerDiv.remove();
      }
    },
  };
}
