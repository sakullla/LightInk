// @vitest-environment jsdom

/**
 * confirm-dialog 测试：纯逻辑（默认/取消按钮解析）+ 工厂形态断言
 * （挂载态 DOM 行为与 menus.ts 等同一测试惯例）。
 */

import { describe, expect, it } from 'vitest';

import {
  adoptDialogSurfaceTheme,
  inferDialogThemeHost,
  resolveCancelId,
  resolveDefaultId,
  showAlertDialog,
  showConfirmDialog,
  type ConfirmDialogSpec,
} from '../confirm-dialog.js';

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

describe('showAlertDialog 工厂形态', () => {
  it('导出为函数', () => {
    expect(typeof showAlertDialog).toBe('function');
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
