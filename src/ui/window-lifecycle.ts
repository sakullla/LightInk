import type { ExitChoice } from './exit-confirmation.js';

export interface CloseRequestEventLike {
  preventDefault(): void;
}

export interface BeforeUnloadEventLike extends CloseRequestEventLike {
  returnValue: string;
}

/** R14 关闭决策：'tray' 收起到托盘；'tray-unavailable' 提示并保持打开；null 走原有退出流程。 */
export type CloseToTrayDecision = 'tray' | 'tray-unavailable' | null;

export interface WindowCloseGuardDeps {
  hasUnsavedChanges(): boolean;
  confirmExit(): Promise<ExitChoice>;
  closeAllTabs(action: Exclude<ExitChoice, 'cancel'>): Promise<boolean>;
  flushDirtySnapshots(): void | Promise<void>;
  closeWindow(): Promise<void>;
  /** 关闭窗口前释放 app 生命周期资源（定时器/监听器）。 */
  shutdown?(): void;
  reportError?: (error: unknown) => void;
  /**
   * R14：后台运行决策。'tray'：收起到托盘——含脏文档也不弹确认（进度/
   * 未保存编辑/界面全保留，进程不退）；'tray-unavailable'：已开启后台运行
   * 但托盘不可用，提示且不收起不退出；null：后台运行未开启（或非桌面），
   * 走原有退出确认流程。
   */
  closeToTray?(): CloseToTrayDecision;
  /** R14：收起到托盘（conceal_hide_to_tray 封装）。 */
  hideToTray?(): Promise<void>;
  /** R14：托盘不可用时的一次性提示（关闭按钮既不收起也不退出）。 */
  trayUnavailableNotice?(): void;
}

export interface WindowCloseGuard {
  handleCloseRequested(event: CloseRequestEventLike): Promise<void> | null;
  handleBeforeUnload(event: BeforeUnloadEventLike): void;
  isHandlingClose(): boolean;
}

export interface NativeWindowCloseTarget {
  destroy(): Promise<void>;
  onCloseRequested(listener: (event: CloseRequestEventLike) => void): Promise<unknown>;
}

export interface BrowserCloseTarget {
  addEventListener(
    type: 'beforeunload',
    listener: (event: BeforeUnloadEventLike) => void,
  ): void;
}

export interface WindowCloseProtectionDeps
  extends Omit<WindowCloseGuardDeps, 'closeWindow'> {
  readonly window: BrowserCloseTarget;
  readonly isNative: boolean;
  readonly getNativeWindow: () => Promise<NativeWindowCloseTarget>;
}

/** Coordinate native close requests without allowing async confirmation races. */
export function createWindowCloseGuard(deps: WindowCloseGuardDeps): WindowCloseGuard {
  let inFlight: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
    deps.reportError?.(error);
  };

  const flushSnapshots = async (): Promise<void> => {
    try {
      await deps.flushDirtySnapshots();
    } catch (error) {
      reportError(error);
    }
  };

  const runCloseDecision = async (): Promise<void> => {
    const choice = await deps.confirmExit();
    if (choice === 'cancel') {
      await flushSnapshots();
      return;
    }
    const closed = await deps.closeAllTabs(choice);
    if (!closed) {
      await flushSnapshots();
      return;
    }

    try {
      deps.shutdown?.();
      await deps.closeWindow();
    } catch (error) {
      reportError(error);
    }
  };

  return {
    handleCloseRequested(event) {
      // R14 首判托盘路径：'tray'→preventDefault + 收起到托盘（脏文档也不弹
      // 确认）；'tray-unavailable'→preventDefault + 提示，不走退出确认/销毁
      // （退出经 File 菜单/老板键 2）；null→后台运行未开启，回落原有退出
      // 确认流程。浏览器回退路径（closeToTray 未接线）不变。
      const trayDecision = deps.closeToTray?.() ?? null;
      if (trayDecision === 'tray') {
        event.preventDefault();
        void deps
          .hideToTray?.()
          .then(() => undefined)
          .catch(reportError);
        return null;
      }
      if (trayDecision === 'tray-unavailable') {
        event.preventDefault();
        deps.trayUnavailableNotice?.();
        return null;
      }

      if (!deps.hasUnsavedChanges()) {
        return null;
      }

      // Tauri requires cancellation during the event callback; awaiting the
      // confirmation first would let the native window be destroyed.
      event.preventDefault();
      if (inFlight !== null) {
        return inFlight;
      }

      const pending = runCloseDecision().catch(reportError);
      inFlight = pending;
      void pending.then(() => {
        if (inFlight === pending) {
          inFlight = null;
        }
      });
      return pending;
    },
    handleBeforeUnload(event) {
      if (!deps.hasUnsavedChanges()) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
      void flushSnapshots();
    },
    isHandlingClose: () => inFlight !== null,
  };
}

/** Bind the shared guard to Tauri close events or the browser beforeunload fallback. */
export function installWindowCloseProtection(deps: WindowCloseProtectionDeps): void {
  const installBrowserFallback = (): void => {
    const guard = createWindowCloseGuard({
      ...deps,
      closeWindow: async () => undefined,
    });
    deps.window.addEventListener('beforeunload', (event) => {
      guard.handleBeforeUnload(event);
    });
  };

  if (!deps.isNative) {
    installBrowserFallback();
    return;
  }

  void deps
    .getNativeWindow()
    .then(async (appWindow) => {
      const guard = createWindowCloseGuard({
        ...deps,
        // Tauri's onCloseRequested wrapper already destroys a clean window.
        // After an intercepted dirty close, destroy directly so close() does
        // not emit another CloseRequested event and re-enter this guard.
        closeWindow: () => appWindow.destroy(),
      });
      await appWindow.onCloseRequested((event) => {
        return guard.handleCloseRequested(event) ?? undefined;
      });
    })
    .catch((error: unknown) => {
      installBrowserFallback();
      deps.reportError?.(error);
    });
}
