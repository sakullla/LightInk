// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { beginOpenProgress } from '../open-progress.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('beginOpenProgress', () => {
  it('shows an indeterminate bar and closes when the last handle ends', () => {
    const first = beginOpenProgress({ title: '星空职业者', label: '正在下载…' });
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

  it('paints a determinate ratio and cancels from the action', () => {
    const onCancel = vi.fn();
    const handle = beginOpenProgress({
      title: 'Pride and Prejudice',
      label: 'Downloading…',
      cancelLabel: 'Cancel',
      onCancel,
    });
    handle.update({ ratio: 0.42 });
    const overlay = document.querySelector<HTMLElement>('.lightink-open-progress')!;
    expect(overlay.dataset.progressDeterminate).toBe('true');
    expect(overlay.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
    expect(overlay.textContent).toContain('42%');

    overlay.querySelector<HTMLButtonElement>('.lightink-open-progress-cancel')!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    handle.close();
  });
});
