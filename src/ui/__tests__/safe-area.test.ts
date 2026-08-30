// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { translate } from '../../i18n/messages.js';
import { showArchivePasswordDialog } from '../archive-password-dialog.js';
import {
  applyKeyboardInset,
  applySafeAreaInsets,
  bindSafeAreaBridge,
  bindVisualViewportInsets,
} from '../safe-area.js';

const libraryCss = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');

function overlayConsumesKeyboardInset(css: string, token: string): void {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(css).toMatch(new RegExp(`${escaped}[^{}]*\\{[^{}]*--lightink-keyboard-inset`));
}

describe('applySafeAreaInsets', () => {
  it('writes CSS pixel variables used by reader chrome', () => {
    const root = document.createElement('html');
    applySafeAreaInsets({ top: 28, right: 0, bottom: 16, left: 0 }, root);
    expect(root.style.getPropertyValue('--lightink-safe-top')).toBe('28px');
    expect(root.style.getPropertyValue('--lightink-safe-bottom')).toBe('16px');
    expect(root.style.getPropertyValue('--lightink-safe-right')).toBe('0px');
  });

  it('keeps a 16px Android bottom floor when the WebView reports 0', () => {
    const root = document.createElement('html');
    root.setAttribute('data-android', '');
    applySafeAreaInsets({ top: 28, right: 0, bottom: 0, left: 0 }, root);
    expect(root.style.getPropertyValue('--lightink-safe-bottom')).toBe('16px');
  });
});

describe('bindSafeAreaBridge', () => {
  it('applies a pending Android payload and exposes the JS hook', () => {
    const root = document.createElement('html');
    const host = {
      __lightinkSafeArea: { top: 32, right: 0, bottom: 20, left: 0 },
    } as Window;
    const release = bindSafeAreaBridge(root, host);
    expect(root.style.getPropertyValue('--lightink-safe-top')).toBe('32px');
    host.__lightinkApplySafeArea?.({ top: 40, right: 0, bottom: 12, left: 4 });
    expect(root.style.getPropertyValue('--lightink-safe-top')).toBe('40px');
    expect(root.style.getPropertyValue('--lightink-safe-left')).toBe('4px');
    release();
    expect(host.__lightinkApplySafeArea).toBeUndefined();
  });
});

describe('bindVisualViewportInsets', () => {
  it('writes the obscured keyboard height from visualViewport', () => {
    const root = document.createElement('html');
    const listeners: Array<(type: string, fn: () => void) => void> = [];
    const viewport = {
      height: 400,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => {
        listeners.push(() => fn());
        void type;
      },
      removeEventListener: () => undefined,
    };
    const host = {
      innerHeight: 720,
      visualViewport: viewport,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;
    const release = bindVisualViewportInsets(root, host);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('320px');
    expect(root.hasAttribute('data-keyboard')).toBe(true);
    release();
  });

  it('prefers the native IME inset when visualViewport stays full height', () => {
    const root = document.createElement('html');
    const host = {
      innerHeight: 720,
      visualViewport: { height: 720, offsetTop: 0 },
      __lightinkKeyboardInset: 280,
    } as unknown as Window;
    applyKeyboardInset(280, root, host);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('280px');
    expect(root.hasAttribute('data-keyboard')).toBe(true);
  });

  it('applies a pending Android IME payload through the JS hook', () => {
    const root = document.createElement('html');
    const host = {
      innerHeight: 800,
      visualViewport: {
        height: 800,
        offsetTop: 0,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      __lightinkKeyboardInset: 240,
    } as unknown as Window;
    const release = bindVisualViewportInsets(root, host);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('240px');
    host.__lightinkApplyKeyboardInset?.(0);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('0px');
    expect(root.hasAttribute('data-keyboard')).toBe(false);
    release();
    expect(host.__lightinkApplyKeyboardInset).toBeUndefined();
  });
});

describe('keyboard-inset overlay consumers', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-android');
    document.documentElement.removeAttribute('data-keyboard');
    document.documentElement.style.removeProperty('--lightink-keyboard-inset');
  });

  it('keeps the safe-area write contract for --lightink-keyboard-inset', () => {
    const root = document.createElement('html');
    applyKeyboardInset(280, root);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('280px');
    expect(root.hasAttribute('data-keyboard')).toBe(true);
    applyKeyboardInset(0, root);
    expect(root.style.getPropertyValue('--lightink-keyboard-inset')).toBe('0px');
    expect(root.hasAttribute('data-keyboard')).toBe(false);
  });

  it('source/group/cache/membership overlays consume --lightink-keyboard-inset in CSS', () => {
    overlayConsumesKeyboardInset(libraryCss, '.lightink-library-source-modal');
    overlayConsumesKeyboardInset(libraryCss, '.lightink-library-group-modal');
    overlayConsumesKeyboardInset(libraryCss, '.lightink-library-cache-limit-modal');
    overlayConsumesKeyboardInset(libraryCss, '.lightink-library-membership-overlay');
    // 单一扣减（T4-A2）：membership dialog 的 max-height 不含 keyboard-inset 项；
    // inset 只由 membership-overlay 的 padding-bottom 通道消费（键盘态由
    // html[data-keyboard] 锚定的 max-height: 100% 接管高度收敛）。
    expect(libraryCss).not.toMatch(
      /\.lightink-library-membership-dialog[^{}]*\{[^{}]*max-height\s*:[^;}]*--lightink-keyboard-inset/,
    );
  });

  it('archive-password overlay consumes keyboard-inset and can close after inset returns to 0', async () => {
    document.documentElement.setAttribute('data-android', '');
    const pending = showArchivePasswordDialog(document, {
      displayName: 'secret.cbz',
      retry: false,
      t: (key, vars) => translate('zh-CN', key, vars),
    });
    const overlay = document.querySelector<HTMLElement>('.lightink-modal-overlay')!;
    const dialog = document.querySelector<HTMLElement>('.lightink-link-dialog')!;
    const input = document.querySelector<HTMLInputElement>('#lightink-archive-password')!;
    expect(overlay.style.paddingBottom).toBe('var(--lightink-keyboard-inset, 0px)');
    // 单一扣减（T4）：触屏高度预算交给 library.css 触屏规则（html[data-keyboard] 锚定），
    // 内联 max-height 不再消费 keyboard-inset，避免 bottom 与 max-height 双扣。
    expect(dialog.style.maxHeight).toBe('');
    expect(input).toBeInstanceOf(HTMLInputElement);
    applyKeyboardInset(280);
    expect(document.documentElement.style.getPropertyValue('--lightink-keyboard-inset')).toBe(
      '280px',
    );
    expect(overlay.hidden).toBe(false);
    applyKeyboardInset(0);
    expect(document.documentElement.style.getPropertyValue('--lightink-keyboard-inset')).toBe('0px');
    expect(document.documentElement.hasAttribute('data-keyboard')).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(pending).resolves.toBeNull();
    expect(document.querySelector('.lightink-modal-overlay')).toBeNull();
  });
});
