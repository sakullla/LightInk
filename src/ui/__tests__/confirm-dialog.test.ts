// @vitest-environment jsdom

/**
 * confirm-dialog 测试：纯逻辑（默认/取消按钮解析）+ 工厂形态断言
 * （挂载态 DOM 行为与 menus.ts 等同一测试惯例）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { translate } from '../../i18n/messages.js';
import { showArchivePasswordDialog } from '../archive-password-dialog.js';
import { beginOpenProgress, OPEN_PROGRESS_APPEAR_MS } from '../open-progress.js';
import {
  adoptDialogSurfaceTheme,
  inferDialogThemeHost,
  resolveCancelId,
  resolveDefaultId,
  showAlertDialog,
  showConfirmDialog,
  type ConfirmDialogSpec,
} from '../confirm-dialog.js';
import { labelModal, mountModalFocus } from '../modal-focus.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const SPEC: ConfirmDialogSpec = {
  title: '关闭标签',
  message: '「未命名-1」有未保存的更改。',
  buttons: [
    { id: 'save', label: '保存', kind: 'primary' },
    { id: 'discard', label: '不保存', kind: 'danger' },
    { id: 'cancel', label: '取消', kind: 'plain' },
  ],
  cancelId: 'cancel',
};

describe('resolveDefaultId（Enter / 默认聚焦）', () => {
  it('取第一个 primary 按钮', () => {
    expect(resolveDefaultId(SPEC)).toBe('save');
  });

  it('无 primary 取首个按钮', () => {
    expect(
      resolveDefaultId({
        buttons: [
          { id: 'a', label: 'A', kind: 'plain' },
          { id: 'b', label: 'B', kind: 'danger' },
        ],
      }),
    ).toBe('a');
  });

  it('无按钮返回 null', () => {
    expect(resolveDefaultId({ buttons: [] })).toBeNull();
  });
});

describe('resolveCancelId（Esc / 遮罩）', () => {
  it('显式 cancelId 优先', () => {
    expect(resolveCancelId(SPEC)).toBe('cancel');
  });

  it('缺省取最后一个按钮', () => {
    expect(
      resolveCancelId({
        title: 't',
        message: 'm',
        buttons: [
          { id: 'restore', label: '恢复', kind: 'primary' },
          { id: 'skip', label: '不恢复', kind: 'plain' },
        ],
      }),
    ).toBe('skip');
  });

  it('无按钮返回 null', () => {
    expect(resolveCancelId({ title: 't', message: 'm', buttons: [] })).toBeNull();
  });
});

describe('showConfirmDialog 工厂形态', () => {
  it('导出为函数', () => {
    expect(typeof showConfirmDialog).toBe('function');
  });
});

describe('dialog surface theme', () => {
  it('prefers a visible library host over a hidden one', () => {
    const hidden = document.createElement('section');
    hidden.className = 'lightink-library';
    hidden.hidden = true;
    const visible = document.createElement('section');
    visible.className = 'lightink-library';
    document.body.append(hidden, visible);
    expect(inferDialogThemeHost(document)).toBe(visible);
    hidden.remove();
    visible.remove();
  });

  it('copies shelf tokens onto the alert overlay instead of editor paper', async () => {
    const host = document.createElement('section');
    host.className = 'lightink-library';
    host.dataset.libraryTheme = 'gallery';
    host.style.setProperty('--lightink-bg-elevated', '#f7f9fb');
    host.style.setProperty('--lightink-accent', '#3d6f8f');
    document.body.appendChild(host);
    const pending = showAlertDialog(document, {
      title: 'LightInk',
      message: 'Could not reach this source.',
      okLabel: 'OK',
    });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay');
    expect(overlay?.dataset.libraryTheme).toBe('gallery');
    expect(overlay?.style.getPropertyValue('--lightink-bg-elevated')).toBe('#f7f9fb');
    expect(overlay?.style.getPropertyValue('--lightink-accent')).toBe('#3d6f8f');
    overlay?.querySelector<HTMLButtonElement>('.lightink-modal-btn--primary')?.click();
    await pending;
    host.remove();
  });

  it('adopts an explicit theme host', () => {
    const host = document.createElement('div');
    host.dataset.libraryTheme = 'ink';
    host.style.setProperty('--lightink-accent', '#7ba3c9');
    const overlay = document.createElement('div');
    adoptDialogSurfaceTheme(overlay, host);
    expect(overlay.dataset.libraryTheme).toBe('ink');
    expect(overlay.style.getPropertyValue('--lightink-accent')).toBe('#7ba3c9');
  });
});

describe('modal focus management', () => {
  it('traps focus, restores the background, and returns focus on Escape', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const overlay = document.createElement('div');
    const dialog = document.createElement('div');
    const title = document.createElement('h2');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.append(title, first, last);
    overlay.appendChild(dialog);
    labelModal(dialog, title);

    let release = (): void => undefined;
    const onEscape = vi.fn(() => release());
    release = mountModalFocus(document, overlay, dialog, { initialFocus: first, onEscape });

    expect(opener.inert).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(opener.inert).not.toBe(true);
    expect(document.activeElement).toBe(opener);
    expect(overlay.isConnected).toBe(false);
  });
});

/** Node 实验性 localStorage 在未设 --localstorage-file 时是 undefined，jsdom 盖不掉。 */
function ensureTestStorage(): Storage {
  const current = globalThis.localStorage;
  if (typeof current === 'object' && current !== null) {
    return current;
  }
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

describe('archive password dialog', () => {
  it('returns the password without writing browser storage', async () => {
    const storage = ensureTestStorage();
    storage.clear();
    const result = showArchivePasswordDialog(document, {
      displayName: 'secret.cb7',
      retry: false,
      t: (key, vars) => translate('zh-CN', key, vars),
    });
    const input = document.querySelector<HTMLInputElement>('#lightink-archive-password')!;
    input.value = 'session-only';
    document.querySelector<HTMLFormElement>('form')!.requestSubmit();

    await expect(result).resolves.toBe('session-only');
    expect(storage).toHaveLength(0);
    expect(document.querySelector('.lightink-modal-overlay')).toBeNull();
  });

  it('shows retry copy and cancels with Escape', async () => {
    const result = showArchivePasswordDialog(document, {
      displayName: 'secret.cbr',
      retry: true,
      t: (key, vars) => translate('en', key, vars),
    });
    expect(document.querySelector('.lightink-modal-message')?.textContent).toContain('incorrect');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(result).resolves.toBeNull();
  });
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
