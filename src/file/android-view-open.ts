/**
 * `android-view-open` — Android 文件关联打开桥（前端侧）。
 *
 * Kotlin 契约见 src-tauri/gen/android/.../MainActivity.kt「外部打开桥」注释
 * （两侧注释互相引用）：
 * - 第三方应用（Telegram 等）「用其他应用打开」送达 content:// URI；
 *   MainActivity 把流复制成真实缓存文件路径写入单槽，随后 evaluateJavascript
 *   调 `window.__lightinkExternalOpenNotify()` 提醒拉取。
 * - JS 经 `window.LightInkExternalOpen.takePendingPath()` 拉取（取出即清空，
 *   一次打开只消费一次；无待打开文件返回 null）。
 * - 复制失败不静默：Kotlin 写入 `EXTERNAL_OPEN_FAILURE_PREFIX` + 消息，
 *   同样 notify；drain / 运行期通知都能拿到。前端经 `handleExternalOpen` 走
 *   既有 `reportOpenFailure` / `showAppAlert`，不当 Markdown 打开。
 * - 冷启动时复制可能先于前端就绪完成、通知丢失，因此 bootstrap 必须在装好
 *   通知处理器后主动 drain 一次（`installExternalOpenBridge` 的返回值）。
 *
 * 桌面 / 纯前端环境桥对象缺失，所有入口都是 no-op；file:// 关联仍走
 * Rust RunEvent::Opened → take_pending_file 既有路径。
 */

/**
 * Kotlin 复制失败写入单槽的前缀（与 MainActivity.EXTERNAL_OPEN_FAILURE_PREFIX
 * 逐字相同）。后面跟异常消息；整串不是文件系统路径。
 */
export const EXTERNAL_OPEN_FAILURE_PREFIX = 'lightink-external-open-error:';

/** True when `takePendingPath` returned a copy/unrecognized-file failure token. */
export function isExternalOpenFailureToken(value: string): boolean {
  return value.startsWith(EXTERNAL_OPEN_FAILURE_PREFIX);
}

/**
 * Path-like label for `reportOpenFailure`. Dots are stripped so `isReaderPath`
 * / Markdown routing cannot swallow the existing error dialog.
 */
export function externalOpenFailureReportPath(token: string): string {
  const detail = (
    isExternalOpenFailureToken(token)
      ? token.slice(EXTERNAL_OPEN_FAILURE_PREFIX.length)
      : token
  ).trim();
  const safe = detail.replace(/[\\/:*?"<>.|]/g, '_');
  return safe === '' ? 'external-open' : safe;
}

/** MainActivity 经 addJavascriptInterface 暴露的外部打开桥。 */
export interface ExternalOpenBridgeInterface {
  takePendingPath(): string | null;
}

/** 外部打开桥挂载宿主（window；测试注入普通对象）。 */
export interface ExternalOpenBridgeHost {
  LightInkExternalOpen?: ExternalOpenBridgeInterface;
  __lightinkExternalOpenNotify?: () => void;
}

function defaultHost(): ExternalOpenBridgeHost | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as unknown as ExternalOpenBridgeHost;
}

/** 取出并清空 Kotlin 侧待打开路径；桥缺失 / 空槽 / 异常一律返回 null。 */
export function takePendingExternalOpenPath(
  host: ExternalOpenBridgeHost | null = defaultHost(),
): string | null {
  const bridge = host?.LightInkExternalOpen;
  if (bridge === undefined || typeof bridge.takePendingPath !== 'function') {
    return null;
  }
  try {
    const path = bridge.takePendingPath();
    return typeof path === 'string' && path !== '' ? path : null;
  } catch {
    return null;
  }
}

/**
 * 安装通知处理器（运行期打开 → onOpen），并返回冷启动期间已落槽的待打开
 * 路径或失败标记（无则 null），由调用方按冷启动语义打开。先装处理器再 drain：
 * 复制完成落在两步之间时由 takePendingPath 的取出即清空保证不双开。
 */
export function installExternalOpenBridge(
  onOpen: (path: string) => void,
  host: ExternalOpenBridgeHost | null = defaultHost(),
): string | null {
  if (host === null) {
    return null;
  }
  host.__lightinkExternalOpenNotify = () => {
    const path = takePendingExternalOpenPath(host);
    if (path !== null) {
      onOpen(path);
    }
  };
  return takePendingExternalOpenPath(host);
}
