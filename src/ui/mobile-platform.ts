/**
 * `mobile-platform` — 前端唯一平台事实点：Android 应用判定与触屏优先判定。
 *
 * Android 判定机制（文档化回退）：`@tauri-apps/plugin-os` 不在依赖清单中
 * （见 package.json），Tauri v2 的 `os.type()` 不可用；Tauri Android WebView
 * 的 UA 稳定包含 "Android"（`navigator.userAgentData.platform` 可用时优先），
 * 以此作为判定来源。若后续引入 plugin-os，只需替换 `detectAndroidApp` 默认
 * 实现，消费方（workspace-mode 裁剪、入口抑制、触控门控）不变。
 *
 * 职责分离：`platform.ts` 的 detectPlatform 继续负责桌面外壳判定
 * （mac/windows/linux，用于快捷键标签与修饰键展示），本模块不替代它。
 */

interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { platform?: string };
}

type MediaQuery = (media: string) => { matches: boolean };

function defaultMediaQuery(): MediaQuery | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return (media) => window.matchMedia(media);
}

/** 判定是否运行在 Android 应用中。可注入 navigator 以便测试。 */
export function detectAndroidApp(
  nav: NavigatorLike | null = typeof navigator !== 'undefined' ? navigator : null,
): boolean {
  if (nav === null) {
    return false;
  }
  if (nav.userAgentData?.platform?.toLowerCase() === 'android') {
    return true;
  }
  return /android/i.test(nav.userAgent ?? '');
}

/**
 * 判定主指针是否为触屏（`pointer: coarse`）。SSR/测试环境无 matchMedia、
 * 或查询抛错时安全返回 false（桌面语义）。
 */
export function detectTouchPrimary(query: MediaQuery | null = defaultMediaQuery()): boolean {
  if (query === null) {
    return false;
  }
  try {
    return query('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** 是否 Android 应用（模块加载时判定一次，进程内稳定）。 */
export const isAndroidApp: boolean = detectAndroidApp();

/** 是否触屏优先（pointer: coarse）。 */
export const isTouchPrimary: boolean = detectTouchPrimary();
