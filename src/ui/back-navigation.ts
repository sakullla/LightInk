/**
 * `back-navigation` — Android 系统返回键的前端桥（02 D4 / R5）。
 *
 * 通道契约（与 `src-tauri/gen/android/.../MainActivity.kt` 对应，两侧注释互相引用）：
 * Kotlin 侧在系统返回时经 `WebView.evaluateJavascript` 同步求值
 * `window.__lightinkAndroidBackPress()`，取 boolean 返回值：
 * - `true`：前端已消费（关闭最上层 overlay / 阅读器返回书架），Kotlin 不做任何事；
 * - `false`、`null`（桥函数缺失或抛错）：未消费，Kotlin 回落系统默认（结束 Activity）。
 * `evaluateJavascript` 的回调是异步的，因此“是否消费”必须由 JS 同步函数一次
 * 返回，不做 invoke/事件回传——不存在等待中的卡死窗口。
 *
 * 分层语义：不新建第二套判定。`dispatchLayeredBackPress` 向 document 派发
 * 合成 Escape keydown，与键盘 Escape 走完全相同的监听链——overlay 各自的
 * Escape 监听（modal-focus/context-menu/menus/library-view/reader overlay）
 * 先消费（preventDefault），剩余事件落到 main.ts 文档级共享判定
 * `consumeLayeredEscapeLeftover`（阅读器 returnToShelf）；书架无人消费，
 * 返回 false 交还系统默认。desktop 下 `registerAndroidBackNavigation` 为
 * no-op，桌面行为逐字节不变。
 */

import { isAndroidApp } from './mobile-platform.js';

/** Kotlin 侧 evaluateJavascript 求值的全局桥函数名（两侧保持同步）。 */
export const ANDROID_BACK_BRIDGE_GLOBAL = '__lightinkAndroidBackPress';

/** 可被派发 Escape keydown 的最小目标（document 或等价物），便于测试注入。 */
export interface BackPressDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

/**
 * 分层返回判定：合成一个与键盘 Escape 等价的 keydown 走完 document 上的
 * 既有监听链；任一环节 `preventDefault()` 即视为已消费（返回 true），
 * 无人消费返回 false（书架顶层 → 系统默认）。
 */
export function dispatchLayeredBackPress(
  target: BackPressDispatchTarget = document,
): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

export interface AndroidBackNavigationOptions {
  /** 覆盖平台判定（测试注入）；默认取 mobile-platform 的 isAndroidApp。 */
  readonly android?: boolean;
  /** 桥函数挂载宿主（默认 window）。 */
  readonly host?: Record<string, unknown>;
  /** Escape 派发目标（默认 document）。 */
  readonly target?: BackPressDispatchTarget;
}

/**
 * Android 下注册 `window.__lightinkAndroidBackPress` 桥；非 Android 为 no-op。
 * 桥函数同步返回消费标记；内部任何异常都收敛为 false（未消费），保证
 * Kotlin 侧始终能回落系统默认，不出现卡死。
 */
export function registerAndroidBackNavigation(
  options: AndroidBackNavigationOptions = {},
): void {
  const android = options.android ?? isAndroidApp;
  if (!android) {
    return;
  }
  const host =
    options.host ?? (window as unknown as Record<string, unknown>);
  const target = options.target ?? document;
  host[ANDROID_BACK_BRIDGE_GLOBAL] = (): boolean => {
    try {
      return dispatchLayeredBackPress(target);
    } catch {
      return false;
    }
  };
}
