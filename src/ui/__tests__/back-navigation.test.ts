// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANDROID_BACK_BRIDGE_GLOBAL,
  dispatchLayeredBackPress,
  registerAndroidBackNavigation,
} from '../back-navigation.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!();
  }
  delete (window as unknown as Record<string, unknown>)[ANDROID_BACK_BRIDGE_GLOBAL];
});

function onDocumentKeyDown(listener: (event: KeyboardEvent) => void): void {
  document.addEventListener('keydown', listener);
  cleanups.push(() => document.removeEventListener('keydown', listener));
}

/**
 * 复刻 main.ts 的分层链：overlay 监听先注册并可消费；文档级共享判定
 * （consumeLayeredEscapeLeftover 等价物）只在未被消费时运行。
 */
function installLayeredChain(workspace: {
  mode: 'reader' | 'shelf';
  hasOpenBook: boolean;
  returnToShelf: () => void;
}): void {
  onDocumentKeyDown((event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) {
      return;
    }
    if (workspace.mode !== 'reader' || !workspace.hasOpenBook) {
      return;
    }
    workspace.returnToShelf();
    event.preventDefault();
  });
}

describe('dispatchLayeredBackPress 分层判定', () => {
  it('overlay 打开 → 合成 Escape 关闭最上层 overlay 并消费，不触达文档级判定', () => {
    const returnToShelf = vi.fn();

    let overlayOpen = true;
    // overlay 监听先于文档级判定注册（modal-focus 以捕获监听达成同效）。
    const overlayListener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && overlayOpen) {
        overlayOpen = false;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', overlayListener);
    cleanups.push(() => document.removeEventListener('keydown', overlayListener));
    installLayeredChain({ mode: 'reader', hasOpenBook: true, returnToShelf });

    const consumed = dispatchLayeredBackPress(document);
    expect(consumed).toBe(true);
    expect(overlayOpen).toBe(false);
    expect(returnToShelf).not.toHaveBeenCalled();
  });

  it('阅读器打开书且无 overlay → returnToShelf 并消费', () => {
    const returnToShelf = vi.fn();
    installLayeredChain({ mode: 'reader', hasOpenBook: true, returnToShelf });

    expect(dispatchLayeredBackPress(document)).toBe(true);
    expect(returnToShelf).toHaveBeenCalledTimes(1);
  });

  it('书架顶层 → 无人消费，返回 false 交还系统默认', () => {
    const returnToShelf = vi.fn();
    installLayeredChain({ mode: 'shelf', hasOpenBook: false, returnToShelf });

    expect(dispatchLayeredBackPress(document)).toBe(false);
    expect(returnToShelf).not.toHaveBeenCalled();
  });

  it('阅读器无打开书 → 不消费', () => {
    const returnToShelf = vi.fn();
    installLayeredChain({ mode: 'reader', hasOpenBook: false, returnToShelf });

    expect(dispatchLayeredBackPress(document)).toBe(false);
    expect(returnToShelf).not.toHaveBeenCalled();
  });

  it('与键盘 Escape 走同一监听链（同一监听器同时响应真实 Escape 与系统返回）', () => {
    const seen: string[] = [];
    onDocumentKeyDown((event) => {
      if (event.key === 'Escape') {
        seen.push(event.key);
        event.preventDefault();
      }
    });

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(dispatchLayeredBackPress(document)).toBe(true);
    expect(seen).toEqual(['Escape', 'Escape']);
  });
});

describe('registerAndroidBackNavigation', () => {
  it('Android 下挂载全局桥函数，返回值即消费标记', () => {
    const host: Record<string, unknown> = {};
    const returnToShelf = vi.fn();
    installLayeredChain({ mode: 'reader', hasOpenBook: true, returnToShelf });
    registerAndroidBackNavigation({ android: true, host });

    const bridge = host[ANDROID_BACK_BRIDGE_GLOBAL] as () => boolean;
    expect(typeof bridge).toBe('function');
    expect(bridge()).toBe(true);
    expect(returnToShelf).toHaveBeenCalledTimes(1);
  });

  it('书架顶层桥函数返回 false（Kotlin 据此回落系统默认）', () => {
    const host: Record<string, unknown> = {};
    installLayeredChain({ mode: 'shelf', hasOpenBook: false, returnToShelf: vi.fn() });
    registerAndroidBackNavigation({ android: true, host });

    const bridge = host[ANDROID_BACK_BRIDGE_GLOBAL] as () => boolean;
    expect(bridge()).toBe(false);
  });

  it('派发目标抛错时桥函数收敛为 false（桥丢失/异常不卡死）', () => {
    const host: Record<string, unknown> = {};
    registerAndroidBackNavigation({
      android: true,
      host,
      target: {
        dispatchEvent: () => {
          throw new Error('bridge lost');
        },
      },
    });

    const bridge = host[ANDROID_BACK_BRIDGE_GLOBAL] as () => boolean;
    expect(bridge()).toBe(false);
  });

  it('非 Android 注册为 no-op', () => {
    const host: Record<string, unknown> = {};
    registerAndroidBackNavigation({ android: false, host });
    expect(host[ANDROID_BACK_BRIDGE_GLOBAL]).toBeUndefined();
  });

  it('默认平台判定来自 mobile-platform（测试环境 UA 非 Android → no-op）', () => {
    registerAndroidBackNavigation();
    expect(
      (window as unknown as Record<string, unknown>)[ANDROID_BACK_BRIDGE_GLOBAL],
    ).toBeUndefined();
  });
});
