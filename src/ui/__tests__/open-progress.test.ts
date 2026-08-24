// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { beginOpenProgress, OPEN_PROGRESS_APPEAR_MS } from '../open-progress.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('beginOpenProgress', () => {
  it('does not mount the overlay until the appear delay elapses', () => {
    vi.useFakeTimers();
    const first = beginOpenProgress({ title: '星空职业者', label: '正在下载…' });
    expect(document.querySelector('.lightink-open-progress')).toBeNull();

    vi.advanceTimersByTime(OPEN_PROGRESS_APPEAR_MS - 1);
    expect(document.querySelector('.lightink-open-progress')).toBeNull();

    vi.advanceTimersByTime(1);
    const overlay = document.querySelector<HTMLElement>('.lightink-open-progress');
    expect(overlay).not.toBeNull();
    expect(overlay?.dataset.progressDeterminate).toBe('false');
    expect(overlay?.textContent).toContain('星空职业者');
    expect(overlay?.textContent).toContain('正在下载…');
    expect(overlay?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBeNull();

    const nested = beginOpenProgress({ label: '正在打开…' });
    expect(document.querySelectorAll('.lightink-open-progress').length).toBe(1);
    expect(overlay?.textContent).toContain('正在打开…');

    first.close();
    expect(document.querySelector('.lightink-open-progress')).not.toBeNull();
    nested.close();
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
  });

  it('never shows the overlay when the open finishes before the delay', () => {
    vi.useFakeTimers();
    const handle = beginOpenProgress({ title: '星空职业者', label: '正在打开…' });
    handle.close();
    vi.advanceTimersByTime(OPEN_PROGRESS_APPEAR_MS);
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
  });

  it('paints a determinate ratio and cancels from the action', () => {
    const onCancel = vi.fn();
    const handle = beginOpenProgress({
      title: 'Pride and Prejudice',
      label: 'Downloading…',
      cancelLabel: 'Cancel',
      onCancel,
      appearAfterMs: 0,
    });
    handle.update({ ratio: 0.42 });
    const overlay = document.querySelector<HTMLElement>('.lightink-open-progress')!;
    expect(overlay.dataset.progressDeterminate).toBe('true');
    expect(overlay.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(overlay.textContent).toContain('42%');

    overlay.querySelector<HTMLButtonElement>('.lightink-open-progress-cancel')!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
    handle.close();
  });

  it('keeps the first cancel handler when a nested open starts', () => {
    const parentCancel = vi.fn();
    const childCancel = vi.fn();
    const parent = beginOpenProgress({
      title: '星空职业者',
      label: '正在打开…',
      cancelLabel: '取消',
      onCancel: parentCancel,
      appearAfterMs: 0,
    });
    const child = beginOpenProgress({
      label: '正在解析…',
      onCancel: childCancel,
    });

    document.querySelector<HTMLButtonElement>('.lightink-open-progress-cancel')!.click();
    expect(parentCancel).toHaveBeenCalledTimes(1);
    expect(childCancel).toHaveBeenCalledTimes(1);
    parent.close();
    child.close();
  });
});
