// @vitest-environment jsdom

/**
 * toast（R4/ADR-5）测试：懒挂载 aria 表面、自动/手动消失、最多 3 条堆叠、
 * detail 只进 <details> 折叠区、挂载失败静默。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  showToast,
  TOAST_DISMISS_MS,
  TOAST_ERROR_DISMISS_MS,
  TOAST_EXIT_MS,
  TOAST_MAX_VISIBLE,
} from '../toast.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function region(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-toast-region');
}

function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.lightink-toast')];
}

describe('toast surface', () => {
  it('lazily mounts one role=status aria-live=polite region on first show', () => {
    expect(region()).toBeNull();
    showToast('info', 'Hello');
    const node = region();
    expect(node).not.toBeNull();
    expect(node!.getAttribute('role')).toBe('status');
    expect(node!.getAttribute('aria-live')).toBe('polite');
    showToast('success', 'Again');
    expect(document.querySelectorAll('.lightink-toast-region').length).toBe(1);
  });

  it('remounts after the region is removed from the document', () => {
    showToast('info', 'First');
    region()!.remove();
    showToast('info', 'Second');
    const node = region();
    expect(node).not.toBeNull();
    expect(node!.textContent).toContain('Second');
  });

  it('renders the title as primary text and raw detail only inside <details>', () => {
    showToast('error', '同步失败', 'error sending request for url (https://dav.example)');
    const toast = toasts()[0]!;
    expect(toast.dataset.kind).toBe('error');
    expect(toast.querySelector('.lightink-toast-title')?.textContent).toBe('同步失败');
    const details = toast.querySelector<HTMLDetailsElement>('details.lightink-toast-detail');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')?.textContent).toBe('技术详情');
    expect(details!.querySelector('pre')?.textContent).toContain('error sending request');
  });

  it('omits the details block when no detail is provided', () => {
    showToast('success', '已同步');
    const toast = toasts()[0]!;
    expect(toast.querySelector('details')).toBeNull();
  });
});

describe('toast dismissal', () => {
  it('auto-dismisses errors after 8s and other kinds after 5s', () => {
    vi.useFakeTimers();
    showToast('error', 'A');
    showToast('info', 'B');
    expect(toasts().length).toBe(2);
    vi.advanceTimersByTime(TOAST_DISMISS_MS);
    // 到期后先进入出场淡出（对称于入场动画），动画结束才算消失。
    expect(
      toasts().map((node) => node.querySelector('.lightink-toast-title')?.textContent),
    ).toEqual(['A', 'B']);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(
      toasts().map((node) => node.querySelector('.lightink-toast-title')?.textContent),
    ).toEqual(['A']);
    vi.advanceTimersByTime(TOAST_ERROR_DISMISS_MS - TOAST_DISMISS_MS - 1);
    expect(toasts().length).toBe(1); // 'A' 到期后淡出中
    vi.advanceTimersByTime(1 + TOAST_EXIT_MS);
    expect(toasts().length).toBe(0);
  });

  it('fades out on dismissal and removes the node on animationend', () => {
    vi.useFakeTimers();
    showToast('success', 'Done');
    const toast = toasts()[0]!;
    vi.advanceTimersByTime(TOAST_DISMISS_MS);
    expect(toast.classList.contains('lightink-toast-out')).toBe(true);
    expect(toasts().length).toBe(1); // 淡出中仍在文档内
    toast.dispatchEvent(new Event('animationend'));
    expect(toasts().length).toBe(0);
  });

  it('falls back to a timer when animationend never fires (jsdom / disabled animations)', () => {
    vi.useFakeTimers();
    showToast('success', 'Done');
    vi.advanceTimersByTime(TOAST_DISMISS_MS);
    expect(toasts().length).toBe(1);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(toasts().length).toBe(0);
  });

  it('pauses auto-dismiss while hovered and resumes with the remaining time', () => {
    vi.useFakeTimers();
    showToast('error', 'A');
    const toast = toasts()[0]!;
    vi.advanceTimersByTime(5000);
    toast.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(TOAST_ERROR_DISMISS_MS); // 悬停期间不消失
    expect(toasts().length).toBe(1);
    toast.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(TOAST_ERROR_DISMISS_MS - 5000 - 1); // 剩余 3000ms 的前 2999ms
    expect(toasts().length).toBe(1);
    vi.advanceTimersByTime(1); // 剩余时间耗尽 → 淡出
    expect(toasts()[0]?.classList.contains('lightink-toast-out')).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(toasts().length).toBe(0);
  });

  it('pauses auto-dismiss while keyboard focus is inside the toast', () => {
    vi.useFakeTimers();
    showToast('info', 'B');
    const toast = toasts()[0]!;
    toast.dispatchEvent(new Event('focusin'));
    vi.advanceTimersByTime(TOAST_DISMISS_MS * 3);
    expect(toasts().length).toBe(1);
    toast.dispatchEvent(new Event('focusout'));
    vi.advanceTimersByTime(TOAST_DISMISS_MS + TOAST_EXIT_MS);
    expect(toasts().length).toBe(0);
  });

  it('supports manual close and stops the auto-dismiss timer', () => {
    vi.useFakeTimers();
    showToast('warning', 'Careful');
    const toast = toasts()[0]!;
    const close = toast.querySelector<HTMLButtonElement>('.lightink-toast-close')!;
    expect(close.getAttribute('aria-label')).toBe('关闭通知');
    close.click();
    expect(toasts().length).toBe(1); // 关闭同样走淡出
    toast.dispatchEvent(new Event('animationend'));
    expect(toasts().length).toBe(0);
    vi.advanceTimersByTime(TOAST_DISMISS_MS * 2);
    expect(toasts().length).toBe(0);
  });

  it('keeps at most three stacked toasts by dropping the oldest', () => {
    for (let index = 0; index < TOAST_MAX_VISIBLE + 2; index += 1) {
      showToast('info', `Toast ${index}`);
    }
    const texts = toasts().map((node) => node.textContent ?? '');
    expect(texts.length).toBe(TOAST_MAX_VISIBLE);
    expect(texts[0]).toContain(`Toast ${TOAST_MAX_VISIBLE - 1}`);
    expect(texts[texts.length - 1]).toContain(`Toast ${TOAST_MAX_VISIBLE + 1}`);
  });

  it('drops the oldest entry together with its pending timer', () => {
    vi.useFakeTimers();
    showToast('info', 'Old');
    vi.advanceTimersByTime(TOAST_DISMISS_MS - 1000);
    showToast('info', 'New 1');
    showToast('info', 'New 2');
    showToast('info', 'New 3');
    expect(toasts().length).toBe(3);
    // 「Old」被丢弃后，它的到期计时器不得移除后来可见的条目。
    vi.advanceTimersByTime(1500);
    expect(toasts().length).toBe(3);
    // New 1–3 于 t=9000 同时到期（t=4000 起 5s）：随后 180ms 内为淡出窗口。
    vi.advanceTimersByTime(3500);
    expect(toasts().length).toBe(3); // 淡出中
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(toasts().length).toBe(0);
  });
});
