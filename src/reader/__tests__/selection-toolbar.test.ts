// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { createSelectionToolbar, selectionClientRect } from '../selection-toolbar.js';

interface FakeRectInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

const toClientRect = ({
  left,
  top,
  width,
  height,
}: FakeRectInput): DOMRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});

const buildRange = (rects: FakeRectInput[]): Range => {
  const range = document.createRange();
  range.getClientRects = () =>
    ({
      length: rects.length,
      item: (index: number) => (index >= 0 && index < rects.length ? toClientRect(rects[index]!) : null),
      [Symbol.iterator]: function* (): IterableIterator<DOMRect> {
        for (const rect of rects) yield toClientRect(rect);
      },
    }) as unknown as DOMRectList;
  if (rects.length === 0) {
    range.getBoundingClientRect = () => toClientRect({ left: 0, top: 0, width: 0, height: 0 });
  } else {
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.left + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
    range.getBoundingClientRect = () =>
      toClientRect({ left, top, width: right - left, height: bottom - top });
  }
  return range;
};

describe('selection-toolbar 多列划选锚点（T2 / R25）', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('双列 getClientRects：指针释放在最末 fragment 所在列，返回该列矩形', () => {
    // 双列布局：左列 right=300，右列 left=400（gap=100）。
    // 选区从右列第一行起，向左延伸至左列第二行（pointer released）。
    // fragment 按文档顺序：右列 L1、左列 L1、左列 L2（最末）。
    const range = buildRange([
      { left: 400, top: 80, width: 280, height: 20 },
      { left: 40, top: 80, width: 240, height: 20 },
      { left: 40, top: 110, width: 200, height: 20 },
    ]);
    // 锚定列 = 左列（pointer released），并集行高 110-80=30，加上首行 80-100 → 总高 50。
    expect(selectionClientRect(range)).toEqual({
      left: 40,
      top: 80,
      width: 240,
      height: 50,
    });
  });

  it('双列 getClientRects：指针释放在右列，返回右列矩形（单段，无左侧并入）', () => {
    // 选区从左列起，跨越 gap 延伸至右列最后一行（pointer released）。
    const range = buildRange([
      { left: 40, top: 80, width: 240, height: 20 },
      { left: 40, top: 110, width: 220, height: 20 },
      { left: 400, top: 80, width: 280, height: 20 },
    ]);
    // 锚定列 = 右列，只含该列一段。
    expect(selectionClientRect(range)).toEqual({
      left: 400,
      top: 80,
      width: 280,
      height: 20,
    });
  });

  it('单列多段：所有 fragment 同列时返回并集', () => {
    // 同一列内三段连续行（无 column 折行）；anchor=末段，并集 = 所有行。
    const range = buildRange([
      { left: 100, top: 50, width: 300, height: 18 },
      { left: 100, top: 68, width: 280, height: 18 },
      { left: 100, top: 86, width: 250, height: 18 },
    ]);
    expect(selectionClientRect(range)).toEqual({
      left: 100,
      top: 50,
      width: 300,
      height: 54,
    });
  });

  it('单段（不可见 fragments 被 1px 过滤）回退到 getBoundingClientRect', () => {
    // fragments 全部被 width<=1 过滤，回退到 range.getBoundingClientRect()。
    const range = buildRange([{ left: 200, top: 100, width: 0, height: 0 }]);
    expect(selectionClientRect(range)).toEqual({
      left: 200,
      top: 100,
      width: 0,
      height: 0,
    });
  });
});

describe('selection-toolbar SVG 图标（T2 / R16）', () => {
  const actions = [
    'highlight',
    'note',
    'copy',
    'removeHighlight',
    'lookup',
    'aiTranslate',
    'explain',
    'summarize',
  ] as const;

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('每个动作按钮内嵌 24x24 svg 节点 + label span', () => {
    const toolbar = createSelectionToolbar({ t: (key) => key, onAction: () => undefined });
    document.body.appendChild(toolbar.element);
    toolbar.setAiTranslateEnabled(true);
    toolbar.setAiAssistEnabled(true);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: true });

    for (const action of actions) {
      const button = toolbar.element.querySelector<HTMLButtonElement>(
        `.lightink-reader-selection-action--${action}`,
      );
      expect(button, `${action} button exists`).toBeTruthy();
      const svg = button!.querySelector('svg');
      expect(svg, `${action} has svg child`).not.toBeNull();
      expect(svg!.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('focusable')).toBe('false');
      expect(svg!.classList.contains('lightink-reader-selection-action-icon')).toBe(true);
      // 至少含一个绘制 primitive（path/line/rect/circle/polyline）。
      const primitives = svg!.querySelectorAll('path, line, rect, circle, polyline');
      expect(primitives.length, `${action} svg has drawing primitives`).toBeGreaterThan(0);

      const label = button!.querySelector<HTMLSpanElement>(
        '.lightink-reader-selection-action-label',
      );
      expect(label, `${action} has label span`).not.toBeNull();
      expect(label!.textContent).toBeTruthy();
      // textContent 仍含原 label 字符串（保留向后兼容）。
      expect(button!.textContent).toBe(label!.textContent);
    }
  });

  it('点击动作按钮仍派发原 action（DOM 改造不破坏行为）', () => {
    const dispatched: string[] = [];
    const toolbar = createSelectionToolbar({
      t: (key) => key,
      onAction: (action) => dispatched.push(action),
    });
    document.body.appendChild(toolbar.element);
    toolbar.setAiTranslateEnabled(true);
    toolbar.setAiAssistEnabled(true);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: true });

    for (const action of actions) {
      const button = toolbar.element.querySelector<HTMLButtonElement>(
        `.lightink-reader-selection-action--${action}`,
      )!;
      button.click();
      expect(dispatched[dispatched.length - 1]).toBe(action);
    }
  });
});
