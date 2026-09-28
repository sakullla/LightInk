import { describe, expect, it, vi, type Mock } from 'vitest';

import { createConcealQuitController, type ConcealQuitDeps } from '../conceal-quit.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface QuitMocks {
  commitSourceModes: Mock<() => void>;
  hasDirtyTabs: Mock<() => boolean>;
  flushStrict: Mock<() => Promise<boolean>>;
  shutdown: Mock<() => void>;
  exitApp: Mock<() => Promise<void>>;
  alert: Mock<(message: string) => void | Promise<void>>;
}

function makeDeps(overrides: Partial<ConcealQuitDeps> = {}): { deps: ConcealQuitDeps; mocks: QuitMocks } {
  // overrides 先并入 mocks：断言观察到的就是 deps 实际使用的同一 fake。
  const mocks: QuitMocks = {
    commitSourceModes: vi.fn<() => void>(),
    hasDirtyTabs: vi.fn<() => boolean>(() => false),
    flushStrict: vi.fn<() => Promise<boolean>>(async () => true),
    shutdown: vi.fn<() => void>(),
    exitApp: vi.fn<() => Promise<void>>(async () => undefined),
    alert: vi.fn<(message: string) => void | Promise<void>>(),
    ...(overrides as Partial<QuitMocks>),
  };
  const deps: ConcealQuitDeps = {
    ...mocks,
    exitAbortedMessage: (reason?: string) => `退出未发生：${reason ?? '快照失败'}`,
    exitFailedMessage: (reason?: string) => `退出失败：${reason ?? ''}`,
  };
  return { deps, mocks };
}

describe('conceal quit orchestration (R4)', () => {
  it('exits immediately when no tab is dirty (no flush, no dialog)', async () => {
    const { deps, mocks } = makeDeps();
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('boss-secondary');

    expect(mocks.commitSourceModes).toHaveBeenCalledOnce();
    expect(mocks.flushStrict).not.toHaveBeenCalled();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.exitApp).toHaveBeenCalledOnce();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('flushes strictly then exits when dirty tabs flush successfully', async () => {
    const { deps, mocks } = makeDeps({ hasDirtyTabs: vi.fn(() => true) });
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('tray-menu');

    expect(mocks.flushStrict).toHaveBeenCalledOnce();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
    expect(mocks.exitApp).toHaveBeenCalledOnce();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it('keeps the process alive and alerts when the strict flush fails', async () => {
    const { deps, mocks } = makeDeps({
      hasDirtyTabs: vi.fn(() => true),
      flushStrict: vi.fn(async () => false),
    });
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('boss-secondary');

    expect(mocks.alert).toHaveBeenCalledWith('退出未发生：快照失败');
    expect(mocks.shutdown).not.toHaveBeenCalled();
    expect(mocks.exitApp).not.toHaveBeenCalled();
  });

  it('treats a throwing strict flush as a failed flush (no exit)', async () => {
    const { deps, mocks } = makeDeps({
      hasDirtyTabs: vi.fn(() => true),
      flushStrict: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('menu');

    expect(mocks.alert).toHaveBeenCalledWith('退出未发生：disk full');
    expect(mocks.exitApp).not.toHaveBeenCalled();
  });

  it('mutual-excludes repeated requests while an orchestration is in flight', async () => {
    const gate = deferred<boolean>();
    const { deps, mocks } = makeDeps({
      hasDirtyTabs: vi.fn(() => true),
      flushStrict: vi.fn(() => gate.promise),
    });
    const controller = createConcealQuitController(deps);

    const first = controller.requestQuit('boss-secondary');
    const second = controller.requestQuit('boss-secondary');
    expect(second).toBe(first);
    expect(controller.isQuitting()).toBe(true);

    gate.resolve(true);
    await first;

    expect(mocks.flushStrict).toHaveBeenCalledOnce();
    expect(mocks.exitApp).toHaveBeenCalledOnce();
    // 编排结束后解锁。
    expect(controller.isQuitting()).toBe(false);
  });

  it('allows a retry after a failed orchestration unlocks', async () => {
    let fail = true;
    const { deps, mocks } = makeDeps({
      hasDirtyTabs: vi.fn(() => true),
      flushStrict: vi.fn(async () => {
        if (fail) return false;
        return true;
      }),
    });
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('boss-secondary');
    expect(mocks.exitApp).not.toHaveBeenCalled();

    fail = false;
    await controller.requestQuit('boss-secondary');
    expect(mocks.exitApp).toHaveBeenCalledOnce();
  });

  it('alerts but stays retryable when the exit command itself rejects', async () => {
    const { deps, mocks } = makeDeps({
      exitApp: vi.fn(async () => {
        throw new Error('tray remove failed');
      }),
    });
    const controller = createConcealQuitController(deps);

    await controller.requestQuit('menu');

    expect(mocks.alert).toHaveBeenCalledWith('退出失败：tray remove failed');
    expect(controller.isQuitting()).toBe(false);
  });

  it('never blocks on an alert that throws', async () => {
    const { deps, mocks } = makeDeps({
      hasDirtyTabs: vi.fn(() => true),
      flushStrict: vi.fn(async () => false),
      alert: vi.fn(() => {
        throw new Error('dialog broken');
      }),
    });
    const controller = createConcealQuitController(deps);

    await expect(controller.requestQuit('boss-secondary')).resolves.toBeUndefined();
    expect(mocks.exitApp).not.toHaveBeenCalled();
  });
});
