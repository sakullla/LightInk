// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clampMermaidPan,
  createMermaidViewer,
  DEFAULT_MERMAID_VIEWER_LABELS,
  fitMermaidScale,
  mermaidSvgSize,
  showMermaidLightbox,
  zoomMermaidTransform,
  type MermaidViewer,
} from '../mermaid-viewer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const viewers: MermaidViewer[] = [];

function diagramSvg(width = '1600', height = '900'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);
  return svg;
}

function mountViewer(svg = diagramSvg(), onExpand = vi.fn()): {
  viewer: MermaidViewer;
  onExpand: ReturnType<typeof vi.fn>;
} {
  const element = document.createElement('div');
  element.className = 'lightink-mermaid';
  document.body.appendChild(element);
  const viewer = createMermaidViewer(element, svg, {
    labels: DEFAULT_MERMAID_VIEWER_LABELS,
    onExpand,
    onEdit: () => undefined,
  });
  for (const [name, value] of [['clientWidth', 800], ['clientHeight', 450]] as const) {
    Object.defineProperty(viewer.viewport, name, { configurable: true, value });
  }
  vi.spyOn(viewer.viewport, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 450,
    right: 800,
    bottom: 450,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  viewer.fit();
  viewers.push(viewer);
  return { viewer, onExpand };
}

function control(viewer: MermaidViewer, action: string): HTMLButtonElement {
  return viewer.element.querySelector<HTMLButtonElement>(`[data-mermaid-action="${action}"]`)!;
}

function percent(viewer: MermaidViewer): string {
  return viewer.element.querySelector<HTMLOutputElement>('.lightink-mermaid-percent')!.textContent ?? '';
}

afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Mermaid geometry', () => {
  it('uses the viewBox for natural dimensions even when width is 100%', () => {
    expect(mermaidSvgSize(diagramSvg())).toEqual({ width: 1600, height: 900 });
  });

  it('fits both axes with breathing room and never enlarges past 100%', () => {
    expect(fitMermaidScale({ width: 1600, height: 900 }, { width: 800, height: 450 })).toBeCloseTo(
      394 / 900,
    );
    expect(fitMermaidScale({ width: 100, height: 80 }, { width: 800, height: 450 })).toBe(1);
    expect(fitMermaidScale({ width: 100, height: 80 }, { width: 0, height: 0 })).toBe(1);
  });

  it('keeps the pointed location stable while zooming', () => {
    const next = zoomMermaidTransform({ scale: 0.5, x: 20, y: 10 }, 1, { x: 100, y: 80 });
    expect(next).toEqual({ scale: 1, x: -60, y: -60 });
    expect(zoomMermaidTransform(next, 100, { x: 0, y: 0 }).scale).toBe(8);
    expect(zoomMermaidTransform(next, 0, { x: 0, y: 0 }).scale).toBe(0.1);
  });

  it('clamps panning but keeps a reachable edge on oversized diagrams', () => {
    const clamped = clampMermaidPan(
      { scale: 2, x: 10_000, y: -10_000 },
      { width: 1600, height: 900 },
      { width: 800, height: 450 },
    );
    expect(clamped.x).toBe(1952);
    expect(clamped.y).toBe(-1077);
    expect(clampMermaidPan({ scale: 0.1, x: 50, y: 50 }, { width: 100, height: 80 }, { width: 800, height: 450 })).toMatchObject({ x: 0, y: 0 });
  });
});

describe('Mermaid inline viewer', () => {
  it('offers accessible zoom, fit, expand and edit controls', () => {
    const { viewer, onExpand } = mountViewer();
    expect(percent(viewer)).toBe('44%');
    control(viewer, 'zoom-in').click();
    expect(percent(viewer)).toBe('55%');
    control(viewer, 'zoom-out').click();
    expect(percent(viewer)).toBe('44%');
    control(viewer, 'zoom-in').click();
    control(viewer, 'fit').click();
    expect(percent(viewer)).toBe('44%');
    control(viewer, 'expand').click();
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(control(viewer, 'edit').getAttribute('aria-label')).toBe('编辑流程图源码');
  });

  it('zooms with Ctrl + wheel around the pointer and supports keyboard reset', () => {
    const { viewer } = mountViewer();
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      clientX: 600,
      clientY: 200,
      bubbles: true,
      cancelable: true,
    });
    viewer.viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(percent(viewer)).toBe('52%');

    viewer.viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
    expect(percent(viewer)).toBe('44%');

    const ordinaryWheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    viewer.viewport.dispatchEvent(ordinaryWheel);
    expect(ordinaryWheel.defaultPrevented).toBe(false);
  });

  it('keeps zoom shortcuts local to the focused diagram viewport', () => {
    const { viewer } = mountViewer();
    const key = new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true });
    viewer.viewport.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(percent(viewer)).toBe('55%');
  });
});

describe('Mermaid full-screen viewer', () => {
  it('opens a focus-trapped dialog, zooms with plain wheel, and closes with Escape', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    showMermaidLightbox(document, diagramSvg(), DEFAULT_MERMAID_VIEWER_LABELS);

    const overlay = document.querySelector<HTMLElement>('.lightink-mermaid-lightbox');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const viewport = document.querySelector<HTMLElement>('.lightink-mermaid-viewport');
    expect(overlay).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId).not.toBeNull();
    expect(document.getElementById(titleId!)?.textContent).toBe('流程图');
    expect(document.activeElement).toBe(viewport);

    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    viewport!.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.lightink-mermaid-lightbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
