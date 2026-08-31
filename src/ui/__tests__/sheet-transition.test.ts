// @vitest-environment jsdom

/**
 * touch/sheet-transition — data-open 状态机（T3-A2 FB7）：
 *   - reveal→conceal→settle 正常收尾（transitionend 通道，propertyName 过滤）；
 *   - conceal 中途 reveal：旧 settle 丢弃、data-open 回挂、不被拉回；
 *   - 连续 conceal 的 generation 唯一（只最新一代 settle 生效）；
 *   - 兜底 timer 路径（transitionend 未派发，240ms）；
 *   - settle 后监听清理与 finish 幂等（再派发无副作用）；
 *   - cancelSheetTransition 作废在途 settle（拖拽接管优先）；
 *   - 同步落地路径（computed transition-duration 为 0，桌面/jsdom 等价瞬跳）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelSheetTransition,
  concealSheet,
  revealSheet,
  SHEET_TRANSITION_FALLBACK_MS,
} from '../touch/sheet-transition.js';

/** jsdom 无样式表：stub computed transition-duration 走异步过渡分支。 */
function stubTransitionDuration(duration: string): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ transitionDuration: duration }) as CSSStyleDeclaration,
  );
}

function fireTransitionEnd(panel: HTMLElement, propertyName = 'transform'): void {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  panel.dispatchEvent(event);
}

function mount(): { container: HTMLElement; panel: HTMLElement } {
  const container = document.createElement('div');
  const panel = document.createElement('div');
  container.appendChild(panel);
  document.body.appendChild(container);
  return { container, panel };
}

describe('sheet-transition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 个别环境为 jsdom polyfill matchMedia：显式回到「无 reduce-motion」口径。
    if (typeof window.matchMedia === 'function') {
      vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('reveal 挂 data-open；conceal 在 transform transitionend 后收尾 settle', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    container.hidden = false;
    revealSheet(container, panel);
    expect(container.dataset.open).toBe('');

    const settle = vi.fn(() => {
      container.hidden = true;
    });
    concealSheet(container, settle, panel);
    // 退场进行中：data-open 已摘、settle 未落地、hidden 延迟。
    expect(container.dataset.open).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
    expect(container.hidden).toBe(false);
    // 非目标属性（opacity）的 transitionend 不触发收尾。
    fireTransitionEnd(panel, 'opacity');
    expect(settle).not.toHaveBeenCalled();

    fireTransitionEnd(panel, 'transform');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(container.hidden).toBe(true);
  });

  it('conceal 中途 reveal：旧 settle 丢弃、data-open 回挂、不被拉回 hidden', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    container.hidden = false;
    revealSheet(container, panel);
    const settle = vi.fn(() => {
      container.hidden = true;
    });
    concealSheet(container, settle, panel);
    expect(container.dataset.open).toBeUndefined();

    // 反向：退场窗口内重新打开。
    container.hidden = false;
    revealSheet(container, panel);
    expect(container.dataset.open).toBe('');

    // 旧关闭的 transitionend 与兜底 timer 都不得把重开的 sheet 拉回 hidden。
    fireTransitionEnd(panel);
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS);
    fireTransitionEnd(panel);
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS);
    expect(settle).not.toHaveBeenCalled();
    expect(container.hidden).toBe(false);
    expect(container.dataset.open).toBe('');
  });

  it('连续 conceal：generation 唯一，只有最新一代 settle 生效', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    const first = vi.fn();
    const second = vi.fn();
    concealSheet(container, first, panel);
    concealSheet(container, second, panel);
    fireTransitionEnd(panel);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // 收尾后兜底 timer 不再重复落地。
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('transitionend 未派发时由兜底 timer 收尾（240ms）', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    const settle = vi.fn();
    concealSheet(container, settle, panel);
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS - 1);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('settle 后监听已清理：再派发 transitionend 无副作用', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    const settle = vi.fn();
    concealSheet(container, settle, panel);
    fireTransitionEnd(panel);
    expect(settle).toHaveBeenCalledTimes(1);
    // 收尾后监听已摘：迟到的 transitionend 与 timer 都不再落地。
    fireTransitionEnd(panel);
    fireTransitionEnd(panel, 'opacity');
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS * 2);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('finish 幂等：transitionend 与兜底 timer 双触发只落地一次', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    const settle = vi.fn();
    concealSheet(container, settle, panel);
    fireTransitionEnd(panel);
    fireTransitionEnd(panel);
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('cancelSheetTransition 作废在途 settle（拖拽接管优先，取消关闭）', () => {
    stubTransitionDuration('0.22s');
    const { container, panel } = mount();
    const settle = vi.fn();
    concealSheet(container, settle, panel);
    cancelSheetTransition(container);
    // 残留的 transitionend 与兜底 timer 都不落地 settle。
    fireTransitionEnd(panel);
    vi.advanceTimersByTime(SHEET_TRANSITION_FALLBACK_MS * 2);
    expect(settle).not.toHaveBeenCalled();
    // 幂等：无在途过渡时再取消无副作用（后续正常 conceal 不受影响）。
    const next = vi.fn();
    concealSheet(container, next, panel);
    fireTransitionEnd(panel);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('同步落地路径（无过渡样式）：conceal 立即 settle、reveal 立即挂 data-open', () => {
    // jsdom 无样式表：真实 getComputedStyle 的 transition-duration 为 0。
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.hidden = false;
    revealSheet(container);
    expect(container.dataset.open).toBe('');
    const settle = vi.fn(() => {
      container.hidden = true;
    });
    concealSheet(container, settle);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(container.hidden).toBe(true);
    expect(container.dataset.open).toBeUndefined();
  });
});
