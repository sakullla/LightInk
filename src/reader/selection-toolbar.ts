/**
 * `selection-toolbar` — 划选工具栏（R3）。
 *
 * 选中正文文字后在选区附近弹出的行内工具栏（高亮/笔记/取消高亮）。纯 DOM 装配 +
 * 回调派发；选区包围盒由调用方换算为外层 client 坐标后传入 `showAt`（flow/txt 的
 * iframe 内选区坐标需叠加 frame 偏移，PDF 文本层选区直接可用）。点击工具栏外部或
 * 再次 `hide()` 隐藏；Escape 由 reader-view 统一处理。
 */

import type { MessageKey } from '../i18n/messages.js';
import { ANNOTATION_COLORS, type AnnotationColor } from './annotations.js';

export type SelectionToolbarAction = 'highlight' | 'note' | 'copy' | 'removeHighlight';

export interface SelectionToolbarActionDetail {
  color?: AnnotationColor;
}

export interface SelectionToolbarRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SelectionToolbarDeps {
  t: (key: MessageKey) => string;
  onAction: (action: SelectionToolbarAction, detail?: SelectionToolbarActionDetail) => void;
  /** Host toolbar dismissed by an outside press; snapshot should drop. */
  onDismiss?: () => void;
}

export interface SelectionToolbar {
  readonly element: HTMLElement;
  /** 在选区包围盒附近显示；canRemoveHighlight 时含"取消高亮"按钮。 */
  showAt(rect: SelectionToolbarRect, options: { canRemoveHighlight: boolean }): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

/** 工具栏外边距（选区与视口边）。 */
const MARGIN = 4;

/**
 * 计算工具栏位置：优先选区上方，越顶则下移到选区下方；水平居中于选区并夹在视口内。
 * 纯函数，node 可测。
 */
export function toolbarPosition(
  rect: SelectionToolbarRect,
  toolbar: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), Math.max(low, high));
  let top = rect.top - toolbar.height - MARGIN;
  if (top < MARGIN) {
    top = rect.top + rect.height + MARGIN;
  }
  top = clamp(top, MARGIN, viewport.height - toolbar.height - MARGIN);
  const left = clamp(
    rect.left + rect.width / 2 - toolbar.width / 2,
    MARGIN,
    Math.max(MARGIN, viewport.width - toolbar.width - MARGIN),
  );
  return { left, top };
}

/**
 * CSS columns (and other fragmentation) make Range.getBoundingClientRect() a
 * union that can span both pages of a spread. Anchor the toolbar on the last
 * visible line box instead — that is where the pointer released.
 */
export function selectionClientRect(range: Range): SelectionToolbarRect {
  const list =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  const fragments = list.filter((box) => box.width > 1 && box.height > 1);
  const box = fragments.length > 0 ? fragments[fragments.length - 1]! : range.getBoundingClientRect();
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
}

/**
 * 创建划选工具栏。element 挂到 reader 视图；showAt/hide 控制显隐并派发动作回调。
 */
export function createSelectionToolbar(deps: SelectionToolbarDeps): SelectionToolbar {
  const root = document.createElement('div');
  root.className = 'lightink-reader-selection-toolbar';
  root.setAttribute('role', 'toolbar');
  root.hidden = true;

  const dismiss = document.createElement('div');
  dismiss.className = 'lightink-reader-selection-dismiss';
  dismiss.setAttribute('aria-hidden', 'true');
  dismiss.hidden = true;

  const makeButton = (action: SelectionToolbarAction, labelKey: MessageKey): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `lightink-reader-selection-action lightink-reader-selection-action--${action}`;
    button.textContent = deps.t(labelKey);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hide();
      deps.onAction(action);
    });
    return button;
  };

  const colors = document.createElement('div');
  colors.className = 'lightink-reader-selection-colors';
  colors.setAttribute('role', 'group');
  colors.setAttribute('aria-label', deps.t('annotation.highlight'));
  for (const color of ANNOTATION_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'lightink-reader-selection-color';
    swatch.dataset.annotationColor = color;
    swatch.setAttribute('aria-label', deps.t('annotation.highlight'));
    swatch.title = deps.t('annotation.highlight');
    swatch.style.background = color;
    swatch.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      hide();
      deps.onAction('highlight', { color });
    });
    colors.appendChild(swatch);
  }

  const highlightButton = makeButton('highlight', 'annotation.highlight');
  const noteButton = makeButton('note', 'annotation.note');
  const copyButton = makeButton('copy', 'annotation.copy');
  const removeButton = makeButton('removeHighlight', 'annotation.removeHighlight');
  root.append(colors, highlightButton, noteButton, copyButton, removeButton);

  root.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  root.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });

  const dismissNow = (event: Event): void => {
    if (root.hidden) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hide();
    deps.onDismiss?.();
  };
  dismiss.addEventListener('pointerdown', dismissNow);
  dismiss.addEventListener('mousedown', dismissNow);

  /** 显示期间点击工具栏外部即隐藏（capture：先于正文点击收尾）。 */
  const onPointerDownOutside = (event: Event): void => {
    if (root.hidden) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && (root.contains(target) || dismiss.contains(target))) {
      return;
    }
    hide();
    deps.onDismiss?.();
  };
  let listening = false;

  const hide = (): void => {
    root.hidden = true;
    dismiss.hidden = true;
    if (listening) {
      listening = false;
      document.removeEventListener('pointerdown', onPointerDownOutside, true);
      document.removeEventListener('mousedown', onPointerDownOutside, true);
    }
  };

  const mountDismiss = (): void => {
    const layer = typeof document !== 'undefined' ? document.body : null;
    if (layer !== null && dismiss.parentNode !== layer) {
      layer.appendChild(dismiss);
    }
  };

  return {
    element: root,
    showAt(rect, options) {
      removeButton.hidden = !options.canRemoveHighlight;
      root.hidden = false;
      dismiss.hidden = false;
      mountDismiss();
      if (!listening) {
        listening = true;
        document.addEventListener('pointerdown', onPointerDownOutside, true);
        document.addEventListener('mousedown', onPointerDownOutside, true);
      }
      const box = root.getBoundingClientRect();
      const viewport =
        typeof window !== 'undefined' && window.innerWidth > 0
          ? { width: window.innerWidth, height: window.innerHeight }
          : { width: box.width, height: box.height };
      const position = toolbarPosition(
        rect,
        { width: box.width, height: box.height },
        viewport,
      );
      root.style.left = `${position.left}px`;
      root.style.top = `${position.top}px`;
    },
    hide,
    isVisible() {
      return !root.hidden;
    },
    destroy() {
      hide();
      dismiss.remove();
      root.remove();
    },
  };
}
