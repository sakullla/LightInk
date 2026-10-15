// @vitest-environment jsdom

/**
 * 统一 tooltip 层测试：
 *   - 文案来源优先级（data-tip > 收编的 title > aria-label）与「无可视文本才出气泡」；
 *   - 原生 title 收编幂等，不与自绘气泡重复；
 *   - 悬停延迟 / 聚焦即时、离开/按下/滚动/Esc 收起；
 *   - 视口内翻转与夹紧；
 *   - `(hover: none)` 触屏环境只保留聚焦提示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installTooltips,
  TOOLTIP_EDGE_PADDING_PX,
  TOOLTIP_HIDE_DELAY_MS,
  TOOLTIP_POINTER_OFFSET_PX,
  type TooltipController,
} from '../tooltip.js';

let controller: TooltipController | null = null;
let restoreRects: (() => void) | null = null;

function mount(html: string): void {
  document.body.innerHTML = html;
}

function tooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-tooltip');
}

/** 装控制器但不 dispose 前一个——「同 document 只装一次」要用例自己验证。 */
function install(overrides: Parameters<typeof installTooltips>[0] = {}): TooltipController {
  controller = installTooltips({ showDelayMs: 0, focusDelayMs: 0, ...overrides });
  return controller;
}

/** 派发事件并推进定时器：显示走 setTimeout，断言前必须让它落定。 */
function fire(target: EventTarget, event: Event, advanceMs = 1): void {
  target.dispatchEvent(event);
  vi.advanceTimersByTime(advanceMs);
}

function hover(target: EventTarget): void {
  fire(target, new MouseEvent('mouseover', { bubbles: true }));
}

/**
 * jsdom 的矩形全是 0，无法验证定位。桩掉视口尺寸、锚点矩形，
 * 并让「带 lightink-tooltip 类的元素」返回给定尺寸。
 */
function stubRects(
  anchorRect: Partial<DOMRect>,
  tooltipRect: Partial<DOMRect> = {},
  viewport = { width: 1000, height: 800 },
): void {
  Object.defineProperty(window, 'innerWidth', { value: viewport.width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: viewport.height, configurable: true });

  const anchor = document.querySelector('button');
  if (anchor !== null) {
    anchor.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...anchorRect }) as DOMRect;
  }

  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function patched(this: HTMLElement): DOMRect {
    if (this.classList.contains('lightink-tooltip')) {
      return {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        ...tooltipRect,
      } as DOMRect;
    }
    return original.call(this);
  };
  restoreRects = (): void => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  controller = null;
  restoreRects = null;
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  restoreRects?.();
  restoreRects = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('tooltip text resolution', () => {
  it('falls back to aria-label for an icon-only button', () => {
    mount('<button aria-label="关闭书库"></button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.textContent).toBe('关闭书库');
  });

  it('prefers data-tip over aria-label', () => {
    mount('<button aria-label="保存" data-tip="保存 (Ctrl+S)"></button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.textContent).toBe('保存 (Ctrl+S)');
  });

  it('treats a symbolic-only label such as "+" as no readable label', () => {
    // 书架侧栏的「+」按钮就是这个形状：符号不是名字，正需要气泡补上。
    mount('<button aria-label="新建分组">+</button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.textContent).toBe('新建分组');
  });

  it('stays silent for controls that already show visible text', () => {
    mount('<button aria-label="全部">全部</button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()).toBeNull();
  });

  it('shows for a visible-text control when data-tip opts in explicitly', () => {
    mount('<button aria-label="全部" data-tip="全部书籍 (5)">全部</button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.textContent).toBe('全部书籍 (5)');
  });

  it('treats data-tip="" as an explicit opt-out', () => {
    mount('<button aria-label="全部" data-tip="">全部</button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()).toBeNull();
  });

  it('does not fire for non-interactive regions that carry aria-label', () => {
    mount('<section aria-label="阅读区域"></section>');
    install();
    hover(document.querySelector('section')!);
    expect(tooltip()).toBeNull();
  });

  it('does not fire for disabled controls', () => {
    mount('<button aria-label="复制" disabled></button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()).toBeNull();
  });

  it('ignores an SVG <title> child when deciding whether text is visible', () => {
    mount('<button aria-label="目录"><svg><title>目录</title></svg></button>');
    install();
    hover(document.querySelector('button svg title')!);
    expect(tooltip()?.textContent).toBe('目录');
  });
});

describe('native title adoption', () => {
  it('adopts a native title into data-tip so the OS bubble never doubles up', () => {
    mount('<button title="发送"></button>');
    const button = document.querySelector('button')!;
    install();
    hover(button);
    expect(tooltip()?.textContent).toBe('发送');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('data-tip')).toBe('发送');
  });

  it('is idempotent across repeated hovers', () => {
    mount('<button title="发送"></button>');
    const button = document.querySelector('button')!;
    install();
    for (let i = 0; i < 3; i += 1) {
      hover(button);
      fire(button, new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    }
    expect(button.getAttribute('data-tip')).toBe('发送');
    expect(tooltip()?.textContent).toBe('发送');
  });

  it('leaves a visible-text control with a native title untouched', () => {
    mount('<button title="发送">发送</button>');
    const button = document.querySelector('button')!;
    install();
    hover(button);
    expect(button.getAttribute('title')).toBe('发送');
    expect(tooltip()).toBeNull();
  });
});

describe('show and hide triggers', () => {
  it('waits for the hover delay before showing', () => {
    mount('<button aria-label="目录"></button>');
    install({ showDelayMs: 400, focusDelayMs: 0 });
    const button = document.querySelector('button')!;
    // 这里不能用 hover()：它自己就推进了 1ms，会把延迟预算先花掉。
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(399);
    expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(tooltip()?.textContent).toBe('目录');
  });

  it('shows on keyboard focus without waiting for the hover delay', () => {
    mount('<button aria-label="目录"></button>');
    install({ showDelayMs: 400, focusDelayMs: 0 });
    fire(document.querySelector('button')!, new FocusEvent('focusin', { bubbles: true }));
    expect(tooltip()?.textContent).toBe('目录');
  });

  it('does not tear down while the pointer moves within the same control', () => {
    mount('<button aria-label="目录"><svg id="icon"></svg></button>');
    install();
    const button = document.querySelector('button')!;
    hover(button);
    const shown = tooltip();
    expect(shown?.textContent).toBe('目录');
    fire(
      document.querySelector('#icon')!,
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: button }),
    );
    expect(tooltip()).toBe(shown);
  });

  it('hides on pointer leave', () => {
    mount('<button aria-label="目录"></button>');
    const button = document.querySelector('button')!;
    install();
    hover(button);
    expect(tooltip()?.hidden).toBe(false);
    button.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    );
    // 留有一点过场，避免相邻控件之间频繁切换时气泡频闪。
    vi.advanceTimersByTime(TOOLTIP_HIDE_DELAY_MS + 1);
    expect(tooltip()?.hidden).toBe(true);
  });

  it('hides on press', () => {
    mount('<button aria-label="目录"></button>');
    install();
    hover(document.querySelector('button')!);
    fire(document, new MouseEvent('mousedown', { bubbles: true }));
    expect(tooltip()?.hidden).toBe(true);
  });

  it('hides on Escape', () => {
    mount('<button aria-label="目录"></button>');
    install();
    hover(document.querySelector('button')!);
    fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tooltip()?.hidden).toBe(true);
  });

  it('hides on scroll so the fixed bubble never detaches from its anchor', () => {
    mount('<button aria-label="目录"></button>');
    install();
    hover(document.querySelector('button')!);
    fire(document, new Event('scroll', { bubbles: true }));
    expect(tooltip()?.hidden).toBe(true);
  });

  it('marks the bubble aria-hidden so it is not announced twice', () => {
    mount('<button aria-label="目录"></button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('mounts the bubble on body, outside the anchor subtree', () => {
    mount('<button aria-label="目录"></button>');
    install();
    hover(document.querySelector('button')!);
    expect(tooltip()?.parentElement).toBe(document.body);
    expect(tooltip()!.contains(document.querySelector('button')!)).toBe(false);
  });
});

describe('placement', () => {
  it('centers above the anchor and points the arrow at it', () => {
    mount('<button aria-label="目录"></button>');
    stubRects(
      { top: 300, bottom: 332, left: 400, right: 432, width: 32, height: 32 },
      { width: 100, height: 24 },
    );
    install();
    hover(document.querySelector('button')!);

    const node = tooltip()!;
    expect(node.dataset.placement).toBe('top');
    // x = anchorCenter - width/2 = 416 - 50 = 366
    // y = anchorTop - offset - height = 300 - 8 - 24 = 268
    expect(node.style.transform).toBe('translate3d(366px, 268px, 0)');
    // 箭头停在气泡正中：anchorCenter - x = 416 - 366 = 50
    expect(node.style.getPropertyValue('--lightink-tooltip-arrow-x')).toBe('50px');
  });

  it('flips below when there is no room above', () => {
    mount('<button aria-label="目录"></button>');
    stubRects(
      { top: 4, bottom: 36, left: 400, right: 432, width: 32, height: 32 },
      { width: 100, height: 24 },
    );
    install();
    hover(document.querySelector('button')!);

    const node = tooltip()!;
    expect(node.dataset.placement).toBe('bottom');
    expect(node.style.transform).toBe('translate3d(366px, 44px, 0)');
  });

  it('clamps horizontally at the viewport edge and keeps the arrow inside', () => {
    mount('<button aria-label="目录"></button>');
    stubRects(
      { top: 300, bottom: 332, left: 980, right: 1012, width: 32, height: 32 },
      { width: 200, height: 24 },
      { width: 1000, height: 800 },
    );
    install();
    hover(document.querySelector('button')!);

    const node = tooltip()!;
    // 理想 x = 996 - 100 = 896 越界 → 夹到 1000 - 200 - 8 = 792
    expect(node.style.transform).toContain(
      `translate3d(${1000 - 200 - TOOLTIP_EDGE_PADDING_PX}px,`,
    );
    const arrow = Number.parseInt(node.style.getPropertyValue('--lightink-tooltip-arrow-x'), 10);
    expect(arrow).toBeGreaterThanOrEqual(10);
    expect(arrow).toBeLessThanOrEqual(200 - 10);
  });

  it('keeps the bubble inside a very short viewport', () => {
    mount('<button aria-label="目录"></button>');
    stubRects(
      { top: 2, bottom: 34, left: 100, right: 132, width: 32, height: 32 },
      { width: 100, height: 24 },
      { width: 1000, height: 40 },
    );
    install();
    hover(document.querySelector('button')!);

    const node = tooltip()!;
    // 上方放不下 → 走 bottom，但底部也溢出，最终夹回边缘内。
    expect(node.dataset.placement).toBe('bottom');
    expect(node.style.transform).toContain(`translate3d(66px, ${TOOLTIP_EDGE_PADDING_PX}px,`);
  });

  it('holds the pointer gap between bubble and anchor', () => {
    mount('<button aria-label="目录"></button>');
    stubRects(
      { top: 300, bottom: 332, left: 400, right: 432, width: 32, height: 32 },
      { width: 100, height: 24 },
    );
    install();
    hover(document.querySelector('button')!);
    const y = Number.parseInt(
      tooltip()!.style.transform.match(/,\s*(-?\d+)px/)?.[1] ?? 'NaN',
      10,
    );
    expect(y).toBe(300 - TOOLTIP_POINTER_OFFSET_PX - 24);
  });
});

describe('lifecycle', () => {
  it('reuses one controller per document', () => {
    const first = install();
    const second = installTooltips();
    controller = second;
    expect(second).toBe(first);
  });

  it('keeps at most one bubble mounted across repeated installs', () => {
    mount('<button aria-label="目录"></button>');
    install();
    installTooltips();
    hover(document.querySelector('button')!);
    expect(document.querySelectorAll('.lightink-tooltip').length).toBe(1);
  });

  it('stops responding after dispose', () => {
    mount('<button aria-label="目录"></button>');
    const local = install();
    local.dispose();
    hover(document.querySelector('button')!);
    expect(tooltip()).toBeNull();
  });

  it('shows nothing when installed disabled', () => {
    mount('<button aria-label="目录"></button>');
    install({ disabled: true });
    hover(document.querySelector('button')!);
    expect(tooltip()).toBeNull();
  });
});

describe('touch environment', () => {
  it('skips hover tooltips but keeps focus tooltips when hover is unavailable', () => {
    mount('<button aria-label="目录"></button>');
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        // `(hover: hover)` 不匹配 = 触屏主设备；其余查询同样按不匹配处理。
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    try {
      install();
      const button = document.querySelector('button')!;
      hover(button);
      expect(tooltip()).toBeNull();
      fire(button, new FocusEvent('focusin', { bubbles: true }));
      expect(tooltip()?.textContent).toBe('目录');
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
    }
  });
});
