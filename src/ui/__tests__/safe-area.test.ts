// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { applySafeAreaInsets, bindSafeAreaBridge } from '../safe-area.js';

describe('applySafeAreaInsets', () => {
  it('writes CSS pixel variables used by reader chrome', () => {
    const root = document.createElement('html');
    applySafeAreaInsets({ top: 28, right: 0, bottom: 16, left: 0 }, root);
    expect(root.style.getPropertyValue('--lightink-safe-top')).toBe('28px');
    expect(root.style.getPropertyValue('--lightink-safe-bottom')).toBe('16px');
    expect(root.style.getPropertyValue('--lightink-safe-right')).toBe('0px');
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
