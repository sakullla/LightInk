import { describe, expect, it, vi } from 'vitest';

import {
  createWindowCloseGuard,
  installWindowCloseProtection,
  type BeforeUnloadEventLike,
} from '../window-lifecycle.js';

function closeEvent() {
  return { preventDefault: vi.fn<() => void>() };
}

describe('native window close guard', () => {
  it('allows a clean window to close without interception', () => {
    const confirmExit = vi.fn(async () => 'cancel' as const);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => false,
      confirmExit,
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
    });
    const event = closeEvent();

    expect(guard.handleCloseRequested(event)).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirmExit).not.toHaveBeenCalled();
  });

  it('shares repeated close events and destroys after confirmation without re-entry', async () => {
    let releaseChoice: ((choice: 'save') => void) | undefined;
    const confirmExit = vi.fn(
      () =>
        new Promise<'save'>((resolve) => {
          releaseChoice = resolve;
        }),
    );
    const closeWindow = vi.fn(async () => undefined);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit,
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
      closeWindow,
    });
    const firstEvent = closeEvent();
    const repeatedEvent = closeEvent();

    const first = guard.handleCloseRequested(firstEvent);
    const repeated = guard.handleCloseRequested(repeatedEvent);
    expect(repeated).toBe(first);
    expect(confirmExit).toHaveBeenCalledOnce();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    releaseChoice!('save');
    await first;

    expect(closeWindow).toHaveBeenCalledOnce();
  });

  it('keeps the window open and flushes snapshots on cancel or save failure', async () => {
    const flushDirtySnapshots = vi.fn();
    const closeWindow = vi.fn(async () => undefined);
    const cancelGuard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit: vi.fn(async (): Promise<'cancel'> => 'cancel'),
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots,
      closeWindow,
    });
    await cancelGuard.handleCloseRequested(closeEvent());

    const failedGuard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit: vi.fn(async (): Promise<'save'> => 'save'),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots,
      closeWindow,
    });
    await failedGuard.handleCloseRequested(closeEvent());

    expect(flushDirtySnapshots).toHaveBeenCalledTimes(2);
    expect(closeWindow).not.toHaveBeenCalled();
  });
});

describe('browser beforeunload fallback', () => {
  it('blocks unload and flushes recovery snapshots only when dirty', async () => {
    let dirty = true;
    const flushDirtySnapshots = vi.fn();
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => dirty,
      confirmExit: vi.fn(async (): Promise<'cancel'> => 'cancel'),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots,
      closeWindow: vi.fn(async () => undefined),
    });
    const event = {
      preventDefault: vi.fn(),
      returnValue: 'unchanged',
    } satisfies BeforeUnloadEventLike;

    guard.handleBeforeUnload(event);
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
    expect(flushDirtySnapshots).toHaveBeenCalledOnce();

    dirty = false;
    guard.handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('falls back to beforeunload when the native close bridge cannot initialize', async () => {
    const addEventListener = vi.fn();
    const reportError = vi.fn();
    const failure = new Error('window bridge unavailable');
    installWindowCloseProtection({
      window: { addEventListener },
      isNative: true,
      getNativeWindow: vi.fn(async () => {
        throw failure;
      }),
      hasUnsavedChanges: () => false,
      confirmExit: vi.fn(async () => 'cancel' as const),
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots: vi.fn(),
      reportError,
    });

    await vi.waitFor(() => expect(addEventListener).toHaveBeenCalledOnce());
    expect(addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(reportError).toHaveBeenCalledWith(failure);
  });

  it('uses force destroy after a confirmed dirty close', async () => {
    const destroy = vi.fn(async () => undefined);
    let listener: ((event: ReturnType<typeof closeEvent>) => void) | undefined;
    installWindowCloseProtection({
      window: { addEventListener: vi.fn() },
      isNative: true,
      getNativeWindow: vi.fn(async () => ({
        destroy,
        onCloseRequested: vi.fn(async (handler) => {
          listener = handler;
        }),
      })),
      hasUnsavedChanges: () => true,
      confirmExit: vi.fn(async () => 'discard' as const),
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
    });

    await vi.waitFor(() => expect(listener).toBeDefined());
    const event = closeEvent();
    await listener!(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('R14 tray-first close path', () => {
  it('hides to the tray on close with dirty documents and no confirmation dialog', async () => {
    const confirmExit = vi.fn(async () => 'cancel' as const);
    const closeAllTabs = vi.fn(async () => true);
    const hideToTray = vi.fn(async () => undefined);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit,
      closeAllTabs,
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
      closeToTray: () => true,
      hideToTray,
    });
    const event = closeEvent();

    const pending = guard.handleCloseRequested(event);
    await Promise.resolve();
    await pending;

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(hideToTray).toHaveBeenCalledOnce();
    // 脏文档也不弹确认、不销毁、不关标签（进度/编辑/界面全保留）。
    expect(confirmExit).not.toHaveBeenCalled();
    expect(closeAllTabs).not.toHaveBeenCalled();
  });

  it('hides to the tray on close even for a clean window', async () => {
    const hideToTray = vi.fn(async () => undefined);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => false,
      confirmExit: vi.fn(),
      closeAllTabs: vi.fn(),
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
      closeToTray: () => true,
      hideToTray,
    });
    const event = closeEvent();

    const pending = guard.handleCloseRequested(event);
    await Promise.resolve();
    await pending;

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(hideToTray).toHaveBeenCalledOnce();
  });

  it('keeps the window visible and notifies when the tray is unavailable', async () => {
    const hideToTray = vi.fn(async () => undefined);
    const trayUnavailableNotice = vi.fn();
    const confirmExit = vi.fn(async () => 'cancel' as const);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit,
      closeAllTabs: vi.fn(async () => false),
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
      closeToTray: () => false,
      hideToTray,
      trayUnavailableNotice,
    });
    const event = closeEvent();

    const pending = guard.handleCloseRequested(event);
    await Promise.resolve();
    await pending;

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(trayUnavailableNotice).toHaveBeenCalledOnce();
    // 不收起、不销毁、不弹退出确认——退出走 File 菜单/老板键 2。
    expect(hideToTray).not.toHaveBeenCalled();
    expect(confirmExit).not.toHaveBeenCalled();
  });

  it('reports a hideToTray failure without crashing the guard', async () => {
    const reportError = vi.fn();
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => false,
      confirmExit: vi.fn(),
      closeAllTabs: vi.fn(),
      flushDirtySnapshots: vi.fn(),
      closeWindow: vi.fn(async () => undefined),
      closeToTray: () => true,
      hideToTray: vi.fn(async () => {
        throw new Error('tray gone');
      }),
      reportError,
    });
    const event = closeEvent();

    const pending = guard.handleCloseRequested(event);
    await Promise.resolve();
    await pending;
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'tray gone' }));
  });

  it('keeps the legacy dirty-close flow when no tray deps are wired (browser preview)', async () => {
    let releaseChoice: ((choice: 'save') => void) | undefined;
    const confirmExit = vi.fn(
      () =>
        new Promise<'save'>((resolve) => {
          releaseChoice = resolve;
        }),
    );
    const closeWindow = vi.fn(async () => undefined);
    const guard = createWindowCloseGuard({
      hasUnsavedChanges: () => true,
      confirmExit,
      closeAllTabs: vi.fn(async () => true),
      flushDirtySnapshots: vi.fn(),
      closeWindow,
    });
    const event = closeEvent();

    const pending = guard.handleCloseRequested(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    releaseChoice!('save');
    await pending;
    expect(closeWindow).toHaveBeenCalledOnce();
  });
});
