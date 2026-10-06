/**
 * `selection-toolbar` — 划选工具栏（R3）。
 *
 * 选中正文文字后在选区附近弹出的行内工具栏（高亮/笔记/复制/查词/AI 翻译）。纯 DOM 装配 +
 * 回调派发；选区包围盒由调用方换算为外层 client 坐标后传入 `showAt`（flow/txt 的
 * iframe 内选区坐标需叠加 frame 偏移，PDF 文本层选区直接可用）。点击工具栏外部或
 * 再次 `hide()` 隐藏；Escape 由 reader-view 统一处理。
 */

import type { MessageKey } from '../i18n/messages.js';
import {
  ANNOTATION_COLORS,
  annotationColorKey,
  type AnnotationColor,
} from './annotations.js';
import { concealSheet, revealSheet } from '../ui/touch/sheet-transition.js';

export type SelectionToolbarAction =
  | 'highlight'
  | 'note'
  | 'copy'
  | 'removeHighlight'
  | 'lookup'
  | 'aiTranslate'
  | 'explain'
  | 'summarize';

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
  showAt(
    rect: SelectionToolbarRect,
    options: {
      canRemoveHighlight: boolean;
      /** AI 提供商四要素完备时才显示 AI 翻译动作（R3）。 */
      aiTranslateEnabled?: boolean;
      /** AI 已配置时才显示解释/总结快捷动作（R5，结果进助手面板）。 */
      aiAssistEnabled?: boolean;
    },
  ): void;
  setAiTranslateEnabled(enabled: boolean): void;
  setAiAssistEnabled(enabled: boolean): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

/** 工具栏外边距（选区与视口边）。 */
const MARGIN = 4;

/** 阅读顶栏、底栏等已经占用的区域。工具栏应让开，而不是盖住目录和排版。 */
export interface ToolbarObstacle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlapsBox(
  left: number,
  top: number,
  width: number,
  height: number,
  obstacle: ToolbarObstacle,
): boolean {
  return (
    left < obstacle.right &&
    left + width > obstacle.left &&
    top < obstacle.bottom &&
    top + height > obstacle.top
  );
}

/**
 * 计算工具栏位置：优先选区上方，越顶则下移到选区下方；水平居中于选区并夹在视口内。
 * 与阅读顶栏/底栏重叠时改放到另一侧。纯函数，node 可测。
 */
export function toolbarPosition(
  rect: SelectionToolbarRect,
  toolbar: { width: number; height: number },
  viewport: { width: number; height: number },
  obstacles: readonly ToolbarObstacle[] = [],
): { left: number; top: number } {
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), Math.max(low, high));
  const above = rect.top - toolbar.height - MARGIN;
  const below = rect.top + rect.height + MARGIN;
  const coversSelection = (candidate: number): boolean =>
    candidate < rect.top + rect.height && candidate + toolbar.height > rect.top;
  const left = clamp(
    rect.left + rect.width / 2 - toolbar.width / 2,
    MARGIN,
    Math.max(MARGIN, viewport.width - toolbar.width - MARGIN),
  );
  const hitsObstacle = (candidate: number): boolean =>
    obstacles.some((obstacle) => overlapsBox(left, candidate, toolbar.width, toolbar.height, obstacle));
  let top = above >= MARGIN ? above : below;
  if (coversSelection(top)) {
    const alternate = top < rect.top ? below : above;
    if (!coversSelection(alternate)) top = alternate;
  }
  if (hitsObstacle(top)) {
    const alternate = top < rect.top ? below : above;
    if (!hitsObstacle(alternate) && !coversSelection(alternate)) {
      top = alternate;
    } else {
      const floor = obstacles.reduce((lowest, obstacle) => Math.max(lowest, obstacle.bottom), 0) + MARGIN;
      if (!coversSelection(floor) && !hitsObstacle(floor)) top = floor;
    }
  }
  top = clamp(top, MARGIN, viewport.height - toolbar.height - MARGIN);
  return { left, top };
}

function visibleChromeObstacles(anchor: HTMLElement): ToolbarObstacle[] {
  // The toolbar is portaled to document.body, so it is not inside .lightink-reader.
  const scope = anchor.ownerDocument;
  if (scope === null) return [];
  const obstacles: ToolbarObstacle[] = [];
  for (const node of scope.querySelectorAll('.lightink-reader-chrome-bar, .lightink-reader-chrome-footer')) {
    if (!(node instanceof HTMLElement) || node.hidden) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    obstacles.push({ left: box.left, top: box.top, right: box.right, bottom: box.bottom });
  }
  return obstacles;
}

interface SelectionBox {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

function selectionBox(box: {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
}): SelectionBox {
  const right = box.right ?? box.left + box.width;
  const bottom = box.bottom ?? box.top + box.height;
  return {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    right,
    bottom,
  };
}

/** Same page column: a spread's other page sits far to the side and must not widen the anchor. */
function sharesColumn(box: SelectionBox, anchor: SelectionBox): boolean {
  const overlap = Math.min(box.right, anchor.right) - Math.max(box.left, anchor.left);
  return overlap > Math.min(box.width, anchor.width) * 0.35;
}

/**
 * CSS columns make Range.getBoundingClientRect() a union that can span both
 * pages of a spread. Keep the column where the pointer released (the last
 * line box), and include every line of that column so the toolbar sits
 * outside the selection instead of covering the lines above the caret.
 */
export function selectionClientRect(range: Range): SelectionToolbarRect {
  const list =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  const fragments = list
    .map((box) => selectionBox(box))
    .filter((box) => box.width > 1 && box.height > 1);
  if (fragments.length === 0) {
    const box = selectionBox(range.getBoundingClientRect());
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  const anchor = fragments[fragments.length - 1]!;
  const column = fragments.filter((box) => sharesColumn(box, anchor));
  const left = Math.min(...column.map((box) => box.left));
  const top = Math.min(...column.map((box) => box.top));
  const right = Math.max(...column.map((box) => box.right));
  const bottom = Math.max(...column.map((box) => box.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * 划选工具栏 8 个动作的内联 SVG（24×24，stroke currentColor；fill 由 CSS 默认 none，
 * summarize 圆点用 fill="currentColor" 覆盖）。几何只用 rect/line/circle/path/polyline
 * 等基本 primitive，1em 缩放后暗色与亮色主题下都仍可辨；不引入第三方图标库或字体图标
 * （ADR-1 备选 B/C 否决）。
 */
const SELECTION_ACTION_ICONS: Record<SelectionToolbarAction, string> = {
  highlight:
    '<path d="M4 20 V17 L13 8 L16 11 L7 20 Z" stroke-linejoin="round" />' +
    '<line x1="11" y1="10" x2="14" y2="13" />',
  note:
    '<path d="M6 3 H15 L19 7 V21 H6 Z" stroke-linejoin="round" />' +
    '<path d="M15 3 V7 H19" stroke-linejoin="round" />' +
    '<line x1="9" y1="12" x2="16" y2="12" stroke-linecap="round" />' +
    '<line x1="9" y1="15" x2="16" y2="15" stroke-linecap="round" />' +
    '<line x1="9" y1="18" x2="13" y2="18" stroke-linecap="round" />',
  copy:
    '<rect x="8" y="8" width="11" height="11" rx="1.5" stroke-linejoin="round" />' +
    '<path d="M5 16 V6 a1.5 1.5 0 0 1 1.5 -1.5 H15" stroke-linejoin="round" stroke-linecap="round" />',
  lookup:
    '<circle cx="11" cy="11" r="6" />' +
    '<line x1="15.5" y1="15.5" x2="20" y2="20" stroke-linecap="round" />' +
    '<path d="M8.5 11 H13.5 M11 8.5 V13.5" stroke-linecap="round" />',
  aiTranslate:
    '<path d="M3 17 L6 8 L9 17 M4.5 14 H7.5" stroke-linejoin="round" stroke-linecap="round" />' +
    '<line x1="10.5" y1="12" x2="14.5" y2="12" stroke-linecap="round" />' +
    '<polyline points="12.5,9 14.5,12 12.5,15" stroke-linejoin="round" stroke-linecap="round" />' +
    '<path d="M16 17 V8 H19 a2 2 0 0 1 0 4 H16 a2 2 0 0 1 0 4 H16" stroke-linejoin="round" />',
  explain:
    '<path d="M8 17 H16 M9.5 19.5 H14.5" stroke-linecap="round" />' +
    '<path d="M7 11 a5 5 0 1 1 10 0 c0 2 -1.5 3 -2 4.5 V17 H9 V15.5 c-0.5 -1.5 -2 -2.5 -2 -4.5" stroke-linejoin="round" />',
  summarize:
    '<circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none" />' +
    '<circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none" />' +
    '<circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none" />' +
    '<line x1="9" y1="6" x2="20" y2="6" stroke-linecap="round" />' +
    '<line x1="9" y1="12" x2="20" y2="12" stroke-linecap="round" />' +
    '<line x1="9" y1="18" x2="20" y2="18" stroke-linecap="round" />',
  removeHighlight:
    '<path d="M4 20 V17 L13 8 L16 11 L7 20 Z" stroke-linejoin="round" />' +
    '<line x1="11" y1="10" x2="14" y2="13" />' +
    '<line x1="4" y1="4" x2="20" y2="20" stroke-linecap="round" stroke-width="1.75" />',
};

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
    const label = deps.t(labelKey);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.classList.add('lightink-reader-selection-action-icon');
    icon.innerHTML = SELECTION_ACTION_ICONS[action];
    const labelSpan = document.createElement('span');
    labelSpan.className = 'lightink-reader-selection-action-label';
    labelSpan.textContent = label;
    button.append(icon, labelSpan);
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
    // Named color, not the raw hex: screen reader + hover tooltip both say e.g. "高亮 · 黄色".
    const colorName = deps.t(annotationColorKey(color));
    swatch.setAttribute('aria-label', `${deps.t('annotation.highlight')} · ${colorName}`);
    swatch.title = colorName;
    // background-color 长属性而非 background 简写：简写会把内联
    // background-clip 重置为 border-box（内联优先级压过触屏 48px 热区规则的
    // content-box 裁剪），见 reader.css 触屏热区规则。
    swatch.style.backgroundColor = color;
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
  const lookupButton = makeButton('lookup', 'reader.lookup.action');
  const aiTranslateButton = makeButton('aiTranslate', 'reader.lookup.aiTranslate');
  const explainButton = makeButton('explain', 'reader.assistant.action.explain');
  const summarizeButton = makeButton('summarize', 'reader.assistant.action.summarize');
  const removeButton = makeButton('removeHighlight', 'annotation.removeHighlight');
  root.append(
    colors,
    highlightButton,
    noteButton,
    copyButton,
    lookupButton,
    aiTranslateButton,
    explainButton,
    summarizeButton,
    removeButton,
  );

  const applyAiTranslateEnabled = (enabled: boolean): void => {
    aiTranslateButton.hidden = !enabled;
    aiTranslateButton.disabled = !enabled;
    aiTranslateButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    aiTranslateButton.title = enabled ? deps.t('reader.lookup.aiTranslate') : '';
  };
  applyAiTranslateEnabled(false);

  /** R5：解释/总结与 AI 翻译同一配置态（aiConfigured），成对显隐。 */
  const applyAiAssistEnabled = (enabled: boolean): void => {
    for (const button of [explainButton, summarizeButton]) {
      button.hidden = !enabled;
      button.disabled = !enabled;
      button.setAttribute('aria-disabled', enabled ? 'false' : 'true');
      button.title = '';
    }
  };
  applyAiAssistEnabled(false);

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
    // 触屏退场（T3）：摘 data-open 走 180ms translateY+opacity 滑出，收尾
    // （transitionend/兜底 timeout）后才置 hidden、移除外部点击监听；
    // 桌面/jsdom 无过渡样式时同步落地，与既有瞬跳行为一致。
    dismiss.hidden = true;
    concealSheet(root, () => {
      root.hidden = true;
      if (listening) {
        listening = false;
        document.removeEventListener('pointerdown', onPointerDownOutside, true);
        document.removeEventListener('mousedown', onPointerDownOutside, true);
      }
    });
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
      if (options.aiTranslateEnabled !== undefined) {
        applyAiTranslateEnabled(options.aiTranslateEnabled);
      }
      if (options.aiAssistEnabled !== undefined) {
        applyAiAssistEnabled(options.aiAssistEnabled);
      }
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
        visibleChromeObstacles(root),
      );
      root.style.left = `${position.left}px`;
      root.style.top = `${position.top}px`;
      // 进场过渡（T3）：定位落地后强制回流，再挂 data-open（触屏 CSS 滑入；
      // 桌面选择器不命中，class 无视觉效果）。
      revealSheet(root);
    },
    setAiTranslateEnabled: applyAiTranslateEnabled,
    setAiAssistEnabled: applyAiAssistEnabled,
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
