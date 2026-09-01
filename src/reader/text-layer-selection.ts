/**
 * 官方 TextLayerBuilder 文本层的选区护栏接线（T4：适配官方 `.textLayer` 结构）。
 *
 * pdfjs-dist 6.x 组件层自带完整护栏：`TextLayerBuilder.render()` 在层末追加
 * `.endOfContent`，`#bindMouse` 绑 mousedown 置 `.selecting`，全局
 * selectionchange 负责相交层置位/其余复位，并在旧 Chromium（<148）上做方向
 * 感知的填充层放置（与本模块的历史实现同源）。层回收（PDFPageViewBuffer
 * 驱逐 → `TextLayerBuilder.cancel`）时官方会从其内部注册表摘除。
 *
 * 本模块因此不再注入/搬动 `.endOfContent`（旧实现自建该元素并按拖选方向
 * 重新插入，官方已内建同款放置），只保留应用侧 `.selecting` 护栏与层注册表
 * 生命周期：
 * - mousedown / selectionchange 对相交层补 `.selecting`，pointerup / blur
 *   全量复位（与官方监听同语义、幂等叠加）；
 * - 官方渲染缓冲回收页后层根可能 detached：注册表按 `isConnected` 修剪，
 *   selectionchange 不再遍历 detached 层（T3 遗留接手点）；修剪即解绑，
 *   页面重新渲染时 `textlayerrendered` 会带来新的绑定。
 */

const SELECTING_CLASS = 'selecting';

/** 已绑定层 → 卸载函数（同一层重复绑定幂等复用，见 bindTextLayerSelection）。 */
const unbinds = new WeakMap<HTMLElement, () => void>();
/** 护栏层注册表（只含连接中的层；selectionchange 只遍历此表）。 */
const layers = new Set<HTMLElement>();
let selectionAbort: AbortController | null = null;

/** 修剪已脱离文档的层根（官方缓冲回收后遗留的注册表条目）：就地解绑。 */
function pruneDetachedLayers(): void {
  for (const layer of [...layers]) {
    if (!layer.isConnected) {
      unbinds.get(layer)?.();
    }
  }
}

function enableSelectionListener(): void {
  if (selectionAbort !== null) {
    return;
  }
  selectionAbort = new AbortController();
  const { signal } = selectionAbort;
  const resetAll = (): void => {
    for (const layer of layers) {
      layer.classList.remove(SELECTING_CLASS);
    }
  };
  document.addEventListener('pointerup', () => {
    pruneDetachedLayers();
    resetAll();
  }, { signal });
  window.addEventListener('blur', () => {
    pruneDetachedLayers();
    resetAll();
  }, { signal });
  document.addEventListener(
    'selectionchange',
    () => {
      pruneDetachedLayers();
      const selection = document.getSelection();
      if (selection === null || selection.rangeCount === 0) {
        resetAll();
        return;
      }
      const range = selection.getRangeAt(0);
      for (const layer of layers) {
        if (!range.intersectsNode(layer)) {
          layer.classList.remove(SELECTING_CLASS);
          continue;
        }
        layer.classList.add(SELECTING_CLASS);
      }
    },
    { signal },
  );
}

function disableSelectionListenerIfIdle(): void {
  if (layers.size > 0 || selectionAbort === null) {
    return;
  }
  selectionAbort.abort();
  selectionAbort = null;
}

/**
 * 文本层渲染完成后接线护栏；返回卸载函数（destroy 时由渲染内核调用）。
 * 官方层自带的 `.endOfContent` 不属于本护栏管辖：绑定不创建、卸载不移除。
 * 同一层重复绑定（缩放重渲染再发 `textlayerrendered`）返回同一卸载函数。
 */
export function bindTextLayerSelection(layer: HTMLElement): () => void {
  const existing = unbinds.get(layer);
  if (existing !== undefined) {
    return existing;
  }
  const onMouseDown = (): void => {
    layer.classList.add(SELECTING_CLASS);
  };
  layer.addEventListener('mousedown', onMouseDown);
  const unbind = (): void => {
    layer.removeEventListener('mousedown', onMouseDown);
    layers.delete(layer);
    layer.classList.remove(SELECTING_CLASS);
    unbinds.delete(layer);
    disableSelectionListenerIfIdle();
  };
  unbinds.set(layer, unbind);
  pruneDetachedLayers();
  layers.add(layer);
  enableSelectionListener();
  return unbind;
}
