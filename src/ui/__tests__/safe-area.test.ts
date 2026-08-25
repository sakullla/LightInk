// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  applyKeyboardInset,
  applySafeAreaInsets,
  bindSafeAreaBridge,
  bindVisualViewportInsets,
} from '../safe-area.js';

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
