/**
 * `conceal-client` — 摸鱼后端命令/事件的 typed 前端封装。
 *
 * 契约（与后端 src-tauri/src/conceal.rs 并行编码，字段名一字不差）：
 *   命令：conceal_register_boss_keys / conceal_set_always_on_top /
 *         conceal_set_transparent / conceal_set_mini_window /
 *         conceal_restore_window_baseline / conceal_set_click_through /
 *         conceal_hide_to_tray / conceal_restore_from_tray /
 *         conceal_get_status / conceal_exit_app
 *   事件：conceal-quit-requested / conceal-tray-status /
 *         conceal-pointer-zone / conceal-zones-stale
 *
 * 门控（R12 + Vitest jsdom）：桌面 Tauri 之外的任何环境（浏览器预览、
 * jsdom、Android Tauri——conceal_* 命令只 cfg(desktop) 注册，Android 侧
 * invoke 必然 reject）全部 no-op / 惰性成功值，不抛错、不弹提示。
 *
 * 启动顺序契约：先注册全部事件 listener，再调 conceal_get_status 取
 * 初始态（后端 setup 期首发的 conceal-tray-status 必然早于 listener，
 * 以查询为准，事件只作运行期重推）。
 */

import { isTauriRuntime } from '../file/browser-file-store.js';
import { isAndroidApp } from '../ui/mobile-platform.js';

/** R2 注册结果：null 组合 = 未注册；错误串 = 后端校验/系统拒绝原因。 */
export interface ConcealBossKeysStatus {
  readonly primary: string | null;
  readonly secondary: string | null;
  readonly primaryError: string | null;
  readonly secondaryError: string | null;
}

/** conceal_get_status 返回的启动态（camelCase，后端 serde rename）。 */
export interface ConcealStatus {
  readonly trayAvailable: boolean;
  readonly trayError: string | null;
  readonly bossPrimary: string | null;
  readonly bossSecondary: string | null;
}

/** 逻辑像素坐标带（相对视口/客户区顶部；宽度恒为窗口宽）。 */
export interface ConcealZone {
  readonly y: number;
  readonly height: number;
}

/**
 * R13 交互控件带（完整视口矩形，逻辑像素）：顶/底带之外仍必须由 LightInk
 * 接收点击的可见控件（书架设置入口/设置页、打开的阅读器 chrome 面板）。
 */
export interface ConcealUiZone {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ConcealClickThroughArgs {
  readonly enabled: boolean;
  readonly topZone: ConcealZone | null;
  readonly bottomZone: ConcealZone | null;
  readonly topVisible: boolean;
  readonly bottomVisible: boolean;
  readonly uiZone: ConcealUiZone | null;
}

export type ConcealPointerZoneName = 'top' | 'body' | 'bottom' | 'outside';
export type ConcealQuitSource = 'boss-secondary' | 'tray-menu';

export const CONCEAL_QUIT_REQUESTED_EVENT = 'conceal-quit-requested';
export const CONCEAL_TRAY_STATUS_EVENT = 'conceal-tray-status';
export const CONCEAL_POINTER_ZONE_EVENT = 'conceal-pointer-zone';
export const CONCEAL_ZONES_STALE_EVENT = 'conceal-zones-stale';

/** 未启用（非桌面 Tauri）时的惰性状态：托盘不可用、老板键未注册、无错误。 */
export function inertConcealStatus(): ConcealStatus {
  return {
    trayAvailable: false,
    trayError: null,
    bossPrimary: null,
    bossSecondary: null,
  };
}

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenLike = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>;

export interface ConcealClientDeps {
  /** 生产默认动态 import '@tauri-apps/api/core'.invoke；测试注入 fake。 */
  invoke?: InvokeLike;
  /** 生产默认动态 import '@tauri-apps/api/event'.listen；测试注入 fake。 */
  listen?: ListenLike;
  /** 桌面 Tauri 判定（默认 isTauriRuntime()）。 */
  isTauri?: () => boolean;
  /** Android 判定（默认 mobile-platform 的模块级事实）。 */
  isAndroid?: () => boolean;
}

const noopUnlisten = (): void => undefined;

async function resolveInvoke(): Promise<InvokeLike> {
  const core = await import('@tauri-apps/api/core');
  return core.invoke as InvokeLike;
}

async function resolveListen(): Promise<ListenLike> {
  const event = await import('@tauri-apps/api/event');
  return event.listen as unknown as ListenLike;
}

export interface ConcealClient {
  /** R2：注册（或改注册）老板键。失败时返回错误串，绝不 reject。 */
  registerBossKeys(payload: { primary: string; secondary: string }): Promise<ConcealBossKeysStatus>;
  /** R8 置顶；Err → reject（前端回退开关并提示）。 */
  setAlwaysOnTop(enabled: boolean): Promise<null>;
  /** R6 窗口层透明（视觉透明由前端 CSS 承担）。 */
  setTransparent(enabled: boolean): Promise<null>;
  /** R9 迷你窗口。 */
  setMiniWindow(enabled: boolean): Promise<null>;
  /** R1 进入编辑器：撤销全部窗口效果（幂等）。 */
  restoreWindowBaseline(): Promise<null>;
  /** R13+R7 点击穿透与指针分区（后端 60ms 轮询）。 */
  setClickThrough(args: ConcealClickThroughArgs): Promise<null>;
  /** R14 收起到托盘。 */
  hideToTray(): Promise<null>;
  /** R14 从托盘恢复。 */
  restoreFromTray(): Promise<null>;
  /** 启动/托盘态权威查询（listener 注册完成后调用）。 */
  getStatus(): Promise<ConcealStatus>;
  /** R4 终退出口（仅在前端快照落盘后调用）。 */
  exitApp(): Promise<null>;
  /** 事件订阅；返回 unlisten。非桌面环境返回 no-op。 */
  onQuitRequested(handler: (payload: { source: ConcealQuitSource }) => void): Promise<() => void>;
  onTrayStatusChanged(
    handler: (payload: { available: boolean; error: string | null }) => void,
  ): Promise<() => void>;
  onPointerZone(handler: (payload: { zone: ConcealPointerZoneName }) => void): Promise<() => void>;
  onZonesStale(handler: () => void): Promise<() => void>;
  /** 当前是否启用（桌面 Tauri 且非 Android）。 */
  isEnabled(): boolean;
}

export function createConcealClient(deps: ConcealClientDeps = {}): ConcealClient {
  const isTauri = deps.isTauri ?? ((): boolean => isTauriRuntime());
  const isAndroid = deps.isAndroid ?? ((): boolean => isAndroidApp);
  const enabled = (): boolean => isTauri() && !isAndroid();

  const invokeFn: InvokeLike =
    deps.invoke ?? ((command, args) => resolveInvoke().then((fn) => fn(command, args)));
  const listenFn: ListenLike =
    deps.listen ?? ((event, handler) => resolveListen().then((fn) => fn(event, handler)));

  const run = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!enabled()) {
      return undefined as unknown as T;
    }
    return invokeFn<T>(command, args);
  };

  return {
    isEnabled: enabled,
    registerBossKeys: async (payload) => {
      if (!enabled()) {
        return { primary: null, secondary: null, primaryError: null, secondaryError: null };
      }
      try {
        return await invokeFn<ConcealBossKeysStatus>('conceal_register_boss_keys', payload);
      } catch {
        // 后端缺失/命令未注册（并行迭代窗口期）：静默按未注册处理，
        // 不阻塞启动（R2 注册失败绝不触发 R3/R4）。
        return { primary: null, secondary: null, primaryError: null, secondaryError: null };
      }
    },
    setAlwaysOnTop: (on) => run<null>('conceal_set_always_on_top', { enabled: on }),
    setTransparent: (on) => run<null>('conceal_set_transparent', { enabled: on }),
    setMiniWindow: (on) => run<null>('conceal_set_mini_window', { enabled: on }),
    restoreWindowBaseline: () => run<null>('conceal_restore_window_baseline', {}),
    setClickThrough: (args) =>
      run<null>('conceal_set_click_through', {
        enabled: args.enabled,
        topZone: args.topZone,
        bottomZone: args.bottomZone,
        topVisible: args.topVisible,
        bottomVisible: args.bottomVisible,
        uiZone: args.uiZone,
      }),
    hideToTray: () => run<null>('conceal_hide_to_tray', {}),
    restoreFromTray: () => run<null>('conceal_restore_from_tray', {}),
    getStatus: async () => {
      if (!enabled()) {
        return inertConcealStatus();
      }
      try {
        return await invokeFn<ConcealStatus>('conceal_get_status', {});
      } catch {
        // 后端未就绪/命令缺失：按托盘不可用处理（R14 失败边界）。
        return { ...inertConcealStatus(), trayError: 'unavailable' };
      }
    },
    exitApp: () => {
      if (!enabled()) {
        return Promise.resolve(null);
      }
      return invokeFn<null>('conceal_exit_app', {});
    },
    onQuitRequested: (handler) => {
      if (!enabled()) {
        return Promise.resolve(noopUnlisten);
      }
      return listenFn<{ source: ConcealQuitSource }>(CONCEAL_QUIT_REQUESTED_EVENT, (event) => {
        handler(event.payload);
      });
    },
    onTrayStatusChanged: (handler) => {
      if (!enabled()) {
        return Promise.resolve(noopUnlisten);
      }
      return listenFn<{ available: boolean; error: string | null }>(CONCEAL_TRAY_STATUS_EVENT, (event) => {
        handler(event.payload);
      });
    },
    onPointerZone: (handler) => {
      if (!enabled()) {
        return Promise.resolve(noopUnlisten);
      }
      return listenFn<{ zone: ConcealPointerZoneName }>(CONCEAL_POINTER_ZONE_EVENT, (event) => {
        handler(event.payload);
      });
    },
    onZonesStale: (handler) => {
      if (!enabled()) {
        return Promise.resolve(noopUnlisten);
      }
      return listenFn<unknown>(CONCEAL_ZONES_STALE_EVENT, () => {
        handler();
      });
    },
  };
}
