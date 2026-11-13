import { labelModal, mountModalFocus } from '../../ui/modal-focus.js';

export interface MermaidViewerLabels {
  readonly diagram: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly fit: string;
  readonly expand: string;
  readonly close: string;
  readonly edit: string;
  readonly hint: string;
  readonly modalHint: string;
}

export const DEFAULT_MERMAID_VIEWER_LABELS: MermaidViewerLabels = {
  diagram: '流程图',
  zoomIn: '放大',
  zoomOut: '缩小',
  fit: '适应窗口',
  expand: '全屏查看',
  close: '关闭',
  edit: '编辑流程图源码',
  hint: 'Ctrl + 滚轮缩放 · 拖拽平移 · 双击编辑',
  modalHint: '滚轮缩放 · 拖拽平移 · 方向键移动',
};

export interface MermaidSize {
  readonly width: number;
  readonly height: number;
}

export interface MermaidTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface MermaidViewer {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  fit(): void;
  destroy(): void;
}

interface MermaidViewerOptions {
  readonly labels?: MermaidViewerLabels;
  readonly modal?: boolean;
  readonly onEdit?: () => void;
  readonly onExpand?: () => void;
  readonly onClose?: () => void;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const FIT_PADDING = 28;
const PAN_EDGE = 48;

function positiveNumber(value: string | null): number | null {
  if (value === null || value.trim() === '' || value.trim().endsWith('%')) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function mermaidSvgSize(svg: SVGElement): MermaidSize {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? [];
  const viewBoxWidth = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0
    ? viewBox[2]!
    : null;
  const viewBoxHeight = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[3]! > 0
    ? viewBox[3]!
    : null;
  const width = viewBoxWidth ?? positiveNumber(svg.getAttribute('width')) ?? 800;
  const height = viewBoxHeight ?? positiveNumber(svg.getAttribute('height')) ?? 600;
  return { width, height };
}

export function fitMermaidScale(
  natural: MermaidSize,
  viewport: MermaidSize,
  padding = FIT_PADDING,
): number {
  const availableWidth = viewport.width - padding * 2;
  const availableHeight = viewport.height - padding * 2;
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    availableWidth <= 0 ||
    availableHeight <= 0
  ) {
    return 1;
  }
  return Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
}

export function zoomMermaidTransform(
  current: MermaidTransform,
  nextScale: number,
  point: { readonly x: number; readonly y: number },
): MermaidTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  if (!Number.isFinite(scale) || current.scale <= 0) return current;
  const ratio = scale / current.scale;
  return {
    scale,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio,
  };
}

export function clampMermaidPan(
  transform: MermaidTransform,
  natural: MermaidSize,
  viewport: MermaidSize,
): MermaidTransform {
  const scaledWidth = natural.width * transform.scale;
  const scaledHeight = natural.height * transform.scale;
  const maxX = scaledWidth <= viewport.width - PAN_EDGE
    ? 0
    : scaledWidth / 2 + viewport.width / 2 - PAN_EDGE;
  const maxY = scaledHeight <= viewport.height - PAN_EDGE
    ? 0
    : scaledHeight / 2 + viewport.height / 2 - PAN_EDGE;
  return {
    ...transform,
    x: Math.min(maxX, Math.max(-maxX, transform.x)),
    y: Math.min(maxY, Math.max(-maxY, transform.y)),
  };
}

function makeButton(
  doc: Document,
  action: string,
  label: string,
  content: string,
): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `lightink-mermaid-control lightink-mermaid-control--${action}`;
  button.dataset.mermaidAction = action;
  button.contentEditable = 'false';
  button.setAttribute('aria-label', label);
  button.title = label;
  if (content.startsWith('<svg')) button.innerHTML = content;
  else button.textContent = content;
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('dblclick', (event) => event.stopPropagation());
  return button;
}

function svgIcon(paths: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

const ICONS = {
  fit: svgIcon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M3 8l6-6M21 8l-6-6M3 16l6 6M21 16l-6 6"/>'),
  expand: svgIcon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/><path d="M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/>'),
  close: svgIcon('<path d="m6 6 12 12M18 6 6 18"/>'),
  edit: svgIcon('<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/>'),
};

export function createMermaidViewer(
  element: HTMLElement,
  sourceSvg: SVGElement,
  options: MermaidViewerOptions = {},
): MermaidViewer {
  const doc = element.ownerDocument;
  const labels = options.labels ?? DEFAULT_MERMAID_VIEWER_LABELS;
  const modal = options.modal === true;
  const natural = mermaidSvgSize(sourceSvg);
  const svg = sourceSvg.cloneNode(true) as SVGElement;
  svg.setAttribute('width', String(natural.width));
  svg.setAttribute('height', String(natural.height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', labels.diagram);
  svg.classList.add('lightink-mermaid-svg');

  element.replaceChildren();
  element.classList.add('lightink-mermaid--interactive');
  element.dataset.mermaidPreview = '';
  element.contentEditable = 'false';

  const header = doc.createElement('div');
  header.className = 'lightink-mermaid-header';
  const title = doc.createElement('span');
  title.className = 'lightink-mermaid-title';
  title.textContent = labels.diagram;
  const hint = doc.createElement('span');
  hint.className = 'lightink-mermaid-hint';
  hint.textContent = modal ? labels.modalHint : labels.hint;
  const controls = doc.createElement('div');
  controls.className = 'lightink-mermaid-controls';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', labels.diagram);

  const zoomOut = makeButton(doc, 'zoom-out', labels.zoomOut, '−');
  const percent = doc.createElement('output');
  percent.className = 'lightink-mermaid-percent';
  percent.setAttribute('aria-live', 'off');
  const zoomIn = makeButton(doc, 'zoom-in', labels.zoomIn, '+');
  const fitButton = makeButton(doc, 'fit', labels.fit, ICONS.fit);
  controls.append(zoomOut, percent, zoomIn, fitButton);
  if (!modal) {
    controls.appendChild(makeButton(doc, 'expand', labels.expand, ICONS.expand));
  }
  if (options.onEdit !== undefined) {
    controls.appendChild(makeButton(doc, 'edit', labels.edit, ICONS.edit));
  }
  if (options.onClose !== undefined) {
    controls.appendChild(makeButton(doc, 'close', labels.close, ICONS.close));
  }
  header.append(title, hint, controls);

  const viewport = doc.createElement('div');
  viewport.className = 'lightink-mermaid-viewport';
  viewport.tabIndex = 0;
  viewport.contentEditable = 'false';
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', `${labels.diagram}。${labels.hint}`);
  const canvas = doc.createElement('div');
  canvas.className = 'lightink-mermaid-canvas';
  canvas.appendChild(svg);
  viewport.appendChild(canvas);
  element.append(header, viewport);

  let fitted = true;
  let transform: MermaidTransform = { scale: 1, x: 0, y: 0 };
  let destroyed = false;
  let dragging = false;
  let dragPointer: number | null = null;
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { distance: number; scale: number } | null = null;

  const viewportSize = (): MermaidSize => ({
    width: viewport.clientWidth,
    height: viewport.clientHeight,
  });
  const localPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = viewport.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  };
  const paint = (): void => {
    transform = clampMermaidPan(transform, natural, viewportSize());
    canvas.style.transform = `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`;
    percent.value = `${Math.round(transform.scale * 100)}%`;
    percent.textContent = percent.value;
    viewport.dataset.zoomed = fitted ? 'false' : 'true';
    viewport.style.touchAction = modal || !fitted ? 'none' : 'pan-y';
  };
  const syncInlineHeight = (): void => {
    if (modal || viewport.clientWidth <= 0) return;
    const ratioHeight = viewport.clientWidth * natural.height / natural.width + FIT_PADDING * 2;
    const height = Math.round(Math.min(540, Math.max(220, ratioHeight)));
    if (Number.parseFloat(viewport.style.height) !== height) {
      viewport.style.height = `${height}px`;
    }
  };
  const fit = (): void => {
    syncInlineHeight();
    transform = { scale: fitMermaidScale(natural, viewportSize()), x: 0, y: 0 };
    fitted = true;
    paint();
  };
  const setScale = (next: number, point = { x: 0, y: 0 }): void => {
    transform = zoomMermaidTransform(transform, next, point);
    fitted = false;
    paint();
  };
  const zoomBy = (factor: number, point?: { x: number; y: number }): void => {
    setScale(transform.scale * factor, point);
  };
  const panBy = (dx: number, dy: number): void => {
    transform = { ...transform, x: transform.x + dx, y: transform.y + dy };
    fitted = false;
    paint();
  };

  zoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
  zoomIn.addEventListener('click', () => zoomBy(1.25));
  fitButton.addEventListener('click', fit);
  controls.querySelector('[data-mermaid-action="expand"]')?.addEventListener('click', () => {
    options.onExpand?.();
  });
  controls.querySelector('[data-mermaid-action="edit"]')?.addEventListener('click', () => {
    options.onEdit?.();
  });
  controls.querySelector('[data-mermaid-action="close"]')?.addEventListener('click', () => {
    options.onClose?.();
  });

  const onWheel = (event: WheelEvent): void => {
    if (!modal && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = Math.min(1.35, Math.max(0.74, Math.exp(-event.deltaY * 0.0018)));
    zoomBy(factor, localPoint(event));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') zoomBy(1.25);
    else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.25);
    else if (event.key === '0' || event.key.toLowerCase() === 'f') fit();
    else if (event.key === 'ArrowLeft') panBy(48, 0);
    else if (event.key === 'ArrowRight') panBy(-48, 0);
    else if (event.key === 'ArrowUp') panBy(0, 48);
    else if (event.key === 'ArrowDown') panBy(0, -48);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onDblClick = (event: MouseEvent): void => {
    if (options.onEdit === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    options.onEdit();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture?.(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a !== undefined && b !== undefined) {
        pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale: transform.scale };
        dragging = false;
        dragPointer = null;
      }
      event.preventDefault();
      return;
    }
    if (pointers.size > 1 || (!modal && fitted)) return;
    dragging = true;
    dragPointer = event.pointerId;
    dragStart = { x: event.clientX, y: event.clientY, panX: transform.x, panY: transform.y };
    viewport.dataset.panning = 'true';
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch !== null && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      if (a !== undefined && b !== undefined) {
        const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        setScale(pinch.scale * distance / pinch.distance, localPoint(event));
      }
      event.preventDefault();
      return;
    }
    if (!dragging || dragPointer !== event.pointerId) return;
    transform = {
      ...transform,
      x: dragStart.panX + event.clientX - dragStart.x,
      y: dragStart.panY + event.clientY - dragStart.y,
    };
    fitted = false;
    paint();
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerEnd = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (dragPointer === event.pointerId) {
      dragging = false;
      dragPointer = null;
      delete viewport.dataset.panning;
    }
  };
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('keydown', onKeyDown);
  viewport.addEventListener('dblclick', onDblClick);
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerEnd);
  viewport.addEventListener('pointercancel', onPointerEnd);
  viewport.addEventListener('lostpointercapture', onPointerEnd);

  const resizeObserver = typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => {
        if (fitted) fit();
        else paint();
      });
  resizeObserver?.observe(viewport);
  const onWindowResize = (): void => {
    if (fitted) fit();
    else paint();
  };
  doc.defaultView?.addEventListener('resize', onWindowResize);
  fit();

  return {
    element,
    viewport,
    fit,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      doc.defaultView?.removeEventListener('resize', onWindowResize);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('keydown', onKeyDown);
      viewport.removeEventListener('dblclick', onDblClick);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerEnd);
      viewport.removeEventListener('pointercancel', onPointerEnd);
      viewport.removeEventListener('lostpointercapture', onPointerEnd);
      pointers.clear();
    },
  };
}

let activeMermaidClose: (() => void) | null = null;

export function closeMermaidLightbox(): void {
  activeMermaidClose?.();
}

export function showMermaidLightbox(
  doc: Document,
  svg: SVGElement,
  labels: MermaidViewerLabels,
): () => void {
  activeMermaidClose?.();
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-mermaid-lightbox';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-mermaid-lightbox-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  overlay.appendChild(dialog);

  let viewer: MermaidViewer | null = null;
  let releaseModal = (): void => overlay.remove();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (activeMermaidClose === close) activeMermaidClose = null;
    releaseModal();
    viewer?.destroy();
  };
  viewer = createMermaidViewer(dialog, svg, {
    labels,
    modal: true,
    onClose: close,
  });
  viewer.element.classList.add('lightink-mermaid-lightbox-viewer');
  const accessibleTitle = doc.createElement('h2');
  accessibleTitle.className = 'lightink-sr-only';
  accessibleTitle.textContent = labels.diagram;
  dialog.appendChild(accessibleTitle);
  labelModal(dialog, accessibleTitle);
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: viewer.viewport,
    onEscape: close,
  });
  viewer.fit();
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });
  activeMermaidClose = close;
  return close;
}
