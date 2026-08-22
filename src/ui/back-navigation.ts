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
 * 分层语义：不新建第二套判定。`dispatchLayeredBackPress` 以真实键盘 Escape
 * 的派发目标（焦点元素，退化为 body/documentElement）派发合成 Escape
 * keydown，与键盘 Escape 走完全相同的监听链——overlay 各自的 Escape 监听
 * （modal-focus/context-menu 的 document 捕获监听在捕获阶段先于 main.ts
 * 启动期注册的文档级冒泡监听运行；reader/library 根元素上的元素级监听在
 * 焦点位于其子树时参与冒泡）先消费（preventDefault），剩余事件落到
 * main.ts 文档级共享判定 `consumeLayeredEscapeLeftover`（阅读器
 * returnToShelf）；书架无人消费，返回 false 交还系统默认。desktop 下
 * `registerAndroidBackNavigation` 为 no-op，桌面行为逐字节不变。
 */

import { isAndroidApp } from './mobile-platform.js';

/** Kotlin 侧 evaluateJavascript 求值的全局桥函数名（两侧保持同步）。 */
export const ANDROID_BACK_BRIDGE_GLOBAL = '__lightinkAndroidBackPress';

/** 可被派发 Escape keydown 的最小目标（document 或等价物），便于测试注入。 */
export interface BackPressDispatchTarget {
  dispatchEvent(event: Event): boolean;
}

/**
 * 若 target 是可访问同源 contentDocument 的 iframe 元素，返回其 Document；
 * 普通元素或跨域 frame（访问抛错）返回 null。
 */
function frameDocumentOf(target: BackPressDispatchTarget): Document | null {
  const element = target as Element & { contentDocument?: Document | null };
  if (typeof element.tagName !== 'string' || element.tagName !== 'IFRAME') {
    return null;
  }
  try {
    const doc = element.contentDocument ?? null;
    return doc !== null && typeof doc.dispatchEvent === 'function' ? doc : null;
  } catch {
    // 跨域 frame 的 contentDocument 访问会抛错：按不可转发处理。
    return null;
  }
}

/**
 * 父文档侧的派发目标（不下钻 frame）：`document.activeElement`（焦点位于
 * 同源 frame 内时即 iframe 宿主元素），无焦点时为 body/documentElement。
 */
function parentDocumentFocusTarget(): BackPressDispatchTarget {
  return (
    document.activeElement ??
    document.body ??
    document.documentElement ??
    document
  );
}

/**
 * 合成 Escape 的默认派发目标：与真实键盘 Escape 一致取焦点元素
 * （`document.activeElement`，无焦点时浏览器即 body）。焦点位于同源
 * flow iframe 内时，父文档的 activeElement 是 iframe 宿主元素——继续
 * 下钻到帧内焦点元素，使帧内 Escape 监听（如选择工具栏）优先消费；
 * 跨域/不可访问的 frame 不下钻。不能直接以 document 为目标——
 * document 目标的 at-target 阶段按注册序运行监听（忽略 capture），
 * main.ts 启动期注册的文档级 leftover 监听会先于 overlay 打开时才注册的
 * document 捕获监听运行（reader+modal 一次返回被双重消费），且 reader/library
 * 根元素上的元素级监听根本看不到以 document 为目标的事件。以焦点子树中的
 * 元素为目标时，document 捕获监听在捕获阶段先运行，元素级监听在冒泡阶段参与，
 * 复现真实 Escape 传播。
 */
export function resolveBackPressTarget(): BackPressDispatchTarget {
  let candidate: BackPressDispatchTarget = parentDocumentFocusTarget();
  // 有界下钻嵌套 iframe（防循环引用），与真实焦点链一致。
  for (let depth = 0; depth < 4; depth += 1) {
    const doc = frameDocumentOf(candidate);
    if (doc === null) {
      break;
    }
    const inner: BackPressDispatchTarget =
      doc.activeElement ?? doc.body ?? doc.documentElement ?? doc;
    if (inner === candidate) {
      break;
    }
    candidate = inner;
  }
  return candidate;
}

function dispatchEscape(target: BackPressDispatchTarget): boolean {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * 分层返回判定：合成一个与键盘 Escape 等价的 keydown，默认以焦点元素
 * （见 `resolveBackPressTarget`）为目标走完既有监听链；任一环节
 * `preventDefault()` 即视为已消费（返回 true），无人消费返回 false
 * （书架顶层 → 系统默认）。
 *
 * 焦点位于同源 flow iframe 内且帧内未消费时（如选择工具栏未打开），
 * 再以父文档侧目标（iframe 宿主元素）派发一次走父文档分层链
 * （overlay → returnToShelf → 书架）——真实键盘 Escape 不跨 frame
 * 边界，但返回键若因此直接交还系统会退出应用，此处为返回键特意的
 * 父侧兜底。
 */
export function dispatchLayeredBackPress(
  target: BackPressDispatchTarget = resolveBackPressTarget(),
): boolean {
  if (dispatchEscape(target)) {
    return true;
  }
  const hostSide = parentDocumentFocusTarget();
  if (hostSide !== target && dispatchEscape(hostSide)) {
    return true;
  }
  return false;
}

export interface AndroidBackNavigationOptions {
  /** 覆盖平台判定（测试注入）；默认取 mobile-platform 的 isAndroidApp。 */
  readonly android?: boolean;
  /** 桥函数挂载宿主（默认 window）。 */
  readonly host?: Record<string, unknown>;
  /** Escape 派发目标（默认按按下时的焦点元素实时解析，见 resolveBackPressTarget）。 */
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
  // 不在注册时固化目标：默认目标在每次按下时按当前焦点实时解析，
  // 复现真实键盘 Escape 的传播路径（见 resolveBackPressTarget）。
  const target = options.target;
  host[ANDROID_BACK_BRIDGE_GLOBAL] = (): boolean => {
    try {
      return dispatchLayeredBackPress(target);
    } catch {
      return false;
    }
  };
}
