/**
 * 助手权限模式（审阅 / 自动 / YOLO）。
 *
 * 与 `chrome-prefs` 一样走本地存储：缺省和损坏值都是审阅。YOLO 与 bypass
 * 是同一个模式，不另存 bypass。模式只影响之后的新工具调用。
 */

export const ASSISTANT_PERMISSION_MODE_KEY = 'lightink.assistant.permissionMode';

export const ASSISTANT_PERMISSION_MODES = ['review', 'auto', 'yolo'] as const;

export type AssistantPermissionMode = (typeof ASSISTANT_PERMISSION_MODES)[number];

export interface AssistantPermissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MODE_SET: ReadonlySet<string> = new Set(ASSISTANT_PERMISSION_MODES);

export function loadAssistantPermissionMode(
  storage: AssistantPermissionStorage | null | undefined,
): AssistantPermissionMode {
  if (storage == null) {
    return 'review';
  }
  try {
    const raw = storage.getItem(ASSISTANT_PERMISSION_MODE_KEY);
    if (raw !== null && MODE_SET.has(raw)) {
      return raw as AssistantPermissionMode;
    }
    return 'review';
  } catch {
    return 'review';
  }
}

export function saveAssistantPermissionMode(
  storage: AssistantPermissionStorage | null | undefined,
  mode: AssistantPermissionMode,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(ASSISTANT_PERMISSION_MODE_KEY, mode);
  } catch {
    // Privacy mode / quota — keep the session value.
  }
}
