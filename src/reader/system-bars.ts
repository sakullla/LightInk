/**
 * `system-bars` — Android 系统栏桥（owner：MainActivity `LightInkSystemBars`
 * JavascriptInterface + 一条 `set_system_bars_visible` invoke 回落）。
 *
 * 阅读态成对显隐系统栏：应用 chrome 藏起时隐藏 status/navigation 进入沉浸
 * 阅读（Android 15+/16 强制 edge-to-edge，透明系统栏直接叠在页面上），唤出
 * chrome 时恢复。文本/PDF/漫画阅读器与 Markdown 沉浸阅读共用；桌面与非
 * Android 宿主为 no-op。桥缺失或 invoke 失败时仍只藏应用 chrome，阅读不中断。
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../file/browser-file-store.js';

export const SET_SYSTEM_BARS_VISIBLE_COMMAND = 'set_system_bars_visible';

export interface SystemBarsBridge {
  setVisible(visible: boolean): void;
}

export interface SystemBarsHost {
  LightInkSystemBars?: SystemBarsBridge;
}

export function androidReaderRoot(
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): HTMLElement | null {
  if (root === null || !root.hasAttribute('data-android')) return null;
  return root;
}

/** 成对显隐系统栏；非 Android、桥缺失或 invoke 失败均为 no-op。 */
export function syncSystemBarsVisible(
  visible: boolean,
  host: (Window & SystemBarsHost) | null = typeof window === 'undefined'
    ? null
    : (window as Window & SystemBarsHost),
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (androidReaderRoot(root) === null) return;
  try {
    const bridge = host?.LightInkSystemBars;
    if (bridge !== undefined && typeof bridge.setVisible === 'function') {
      bridge.setVisible(visible);
      return;
    }
    if (host !== null && isTauriRuntime(host)) {
      void invoke(SET_SYSTEM_BARS_VISIBLE_COMMAND, { visible }).catch(() => undefined);
    }
  } catch {
    // invoke 失败仍只藏应用 chrome，阅读不中断。
  }
}
