// @vitest-environment jsdom
/**
 * mobile-platform — 前端唯一平台事实点：Android UA 判定与 pointer:coarse
 * 触屏判定；SSR/测试环境安全回退为桌面语义（false）。
 */
import { describe, expect, it } from 'vitest';

import {
  detectAndroidApp,
  detectTouchPrimary,
  isAndroidApp,
  isTouchPrimary,
} from '../mobile-platform.js';

describe('detectAndroidApp', () => {
  it('returns false without a navigator (SSR/test-safe)', () => {
    expect(detectAndroidApp(null)).toBe(false);
  });

  it('detects Android WebView user agents', () => {
    expect(
      detectAndroidApp({
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      }),
    ).toBe(true);
  });

  it('prefers userAgentData.platform when available', () => {
    expect(detectAndroidApp({ userAgentData: { platform: 'Android' }, userAgent: '' })).toBe(true);
    expect(detectAndroidApp({ userAgentData: { platform: 'Windows' }, userAgent: '' })).toBe(false);
  });

  it('returns false for desktop user agents', () => {
    expect(
      detectAndroidApp({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }),
    ).toBe(false);
    expect(
      detectAndroidApp({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      }),
    ).toBe(false);
    expect(
      detectAndroidApp({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }),
    ).toBe(false);
  });

  it('handles missing fields without throwing', () => {
    expect(detectAndroidApp({})).toBe(false);
  });
});

describe('detectTouchPrimary', () => {
  it('returns false without matchMedia (SSR/test-safe)', () => {
    expect(detectTouchPrimary(null)).toBe(false);
  });

  it('reflects the (pointer: coarse) media query result', () => {
    const coarse = (media: string): { matches: boolean } => ({
      matches: media === '(pointer: coarse)',
    });
    expect(detectTouchPrimary(coarse)).toBe(true);
    expect(detectTouchPrimary(() => ({ matches: false }))).toBe(false);
  });

  it('queries exactly (pointer: coarse)', () => {
    const seen: string[] = [];
    detectTouchPrimary((media) => {
      seen.push(media);
      return { matches: false };
    });
    expect(seen).toEqual(['(pointer: coarse)']);
  });

  it('returns false when the query throws', () => {
    expect(
      detectTouchPrimary(() => {
        throw new Error('no media support');
      }),
    ).toBe(false);
  });
});

describe('applyMobileDocumentFlags', () => {
  it('stamps android and touch-primary flags for CSS', async () => {
    const { applyMobileDocumentFlags } = await import('../mobile-platform.js');
    const root = document.createElement('html');
    applyMobileDocumentFlags(root, { android: true, touchPrimary: true });
    expect(root.hasAttribute('data-android')).toBe(true);
    expect(root.hasAttribute('data-touch-primary')).toBe(true);
    applyMobileDocumentFlags(root, { android: false, touchPrimary: false });
    expect(root.hasAttribute('data-android')).toBe(false);
    expect(root.hasAttribute('data-touch-primary')).toBe(false);
  });
});

describe('module-level platform facts', () => {
  it('exports boolean facts, defaulting to desktop semantics in node', () => {
    expect(typeof isAndroidApp).toBe('boolean');
    expect(typeof isTouchPrimary).toBe('boolean');
    expect(isAndroidApp).toBe(false);
    expect(isTouchPrimary).toBe(false);
  });
});
