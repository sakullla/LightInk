import { describe, expect, it, vi } from 'vitest';

import { createConcealClient } from '../conceal-client.js';

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type ListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

const asInvoke = (
  fn: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): InvokeFn => fn as InvokeFn;
const asListen = (
  fn: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>,
): ListenFn => fn as unknown as ListenFn;

describe('conceal client gating (R12 + jsdom)', () => {
  it('is disabled outside desktop Tauri: commands resolve inert and listeners are no-ops', async () => {
    const invoke = vi.fn(async () => null);
    const listen = vi.fn(async () => () => undefined);
    const client = createConcealClient({
      invoke: asInvoke(invoke),
      listen: asListen(listen),
      isTauri: () => false,
      isAndroid: () => false,
    });

    expect(client.isEnabled()).toBe(false);
    expect(await client.getStatus()).toEqual({
      trayAvailable: false,
      trayError: null,
      bossPrimary: null,
      bossSecondary: null,
    });
    expect(await client.registerBossKeys({ primary: 'Alt+Z', secondary: 'Alt+X' })).toEqual({
      primary: null,
      secondary: null,
      primaryError: null,
      secondaryError: null,
    });
    // 门控路径返回惰性成功值——调用方照常 await，不感知环境差异。
    await expect(client.setAlwaysOnTop(true)).resolves.toBeUndefined();
    await expect(
      client.setClickThrough({
        enabled: true,
        topZone: null,
        bottomZone: null,
        topVisible: false,
        bottomVisible: false,
        uiZone: null,
      }),
    ).resolves.toBeUndefined();
    // exitApp 的惰性分支显式返回 null（与 ConcealClient.exitApp 的 null 合同一致）。
    await expect(client.exitApp()).resolves.toBeNull();
    expect(typeof (await client.onQuitRequested(() => undefined))).toBe('function');
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it('is disabled on Android Tauri (conceal_* commands are cfg(desktop)-only)', async () => {
    const invoke = vi.fn(async () => null);
    const client = createConcealClient({
      invoke: asInvoke(invoke),
      isTauri: () => true,
      isAndroid: () => true,
    });
    expect(client.isEnabled()).toBe(false);
    await expect(client.setAlwaysOnTop(true)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes exact contract command names with camelCase args when enabled', async () => {
    const commands: string[] = [];
    const argsLog: Array<Record<string, unknown>> = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      commands.push(command);
      argsLog.push(args ?? {});
      return null;
    });
    const client = createConcealClient({
      invoke: asInvoke(invoke),
      isTauri: () => true,
      isAndroid: () => false,
    });

    await client.setAlwaysOnTop(true);
    await client.setTransparent(false);
    await client.setMiniWindow(true);
    await client.restoreWindowBaseline();
    await client.setClickThrough({
      enabled: true,
      topZone: { y: 0, height: 48 },
      bottomZone: null,
      topVisible: true,
      bottomVisible: false,
      uiZone: { x: 8, y: 300, width: 240, height: 360 },
    });
    await client.hideToTray();
    await client.restoreFromTray();
    await client.exitApp();

    expect(commands).toEqual([
      'conceal_set_always_on_top',
      'conceal_set_transparent',
      'conceal_set_mini_window',
      'conceal_restore_window_baseline',
      'conceal_set_click_through',
      'conceal_hide_to_tray',
      'conceal_restore_from_tray',
      'conceal_exit_app',
    ]);
    expect(argsLog[0]).toEqual({ enabled: true });
    expect(argsLog[4]).toEqual({
      enabled: true,
      topZone: { y: 0, height: 48 },
      bottomZone: null,
      topVisible: true,
      bottomVisible: false,
      uiZone: { x: 8, y: 300, width: 240, height: 360 },
    });
  });

  it('registers boss keys verbatim; a missing backend is not a rejection', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'conceal_register_boss_keys') {
        return {
          primary: 'Alt+Z',
          secondary: null,
          primaryError: null,
          secondaryError: '与老板键 1 相同',
        };
      }
      return null;
    });
    const client = createConcealClient({
      invoke: asInvoke(invoke),
      isTauri: () => true,
      isAndroid: () => false,
    });
    const status = await client.registerBossKeys({ primary: 'Alt+Z', secondary: 'Alt+Z' });
    expect(status).toEqual({
      primary: 'Alt+Z',
      secondary: null,
      primaryError: null,
      secondaryError: '与老板键 1 相同',
    });

    const broken = createConcealClient({
      invoke: asInvoke(
        vi.fn(async () => {
          throw new Error('command not registered');
        }),
      ),
      isTauri: () => true,
      isAndroid: () => false,
    });
    await expect(broken.registerBossKeys({ primary: 'Alt+Z', secondary: 'Alt+X' })).resolves.toEqual({
      primary: null,
      secondary: null,
      primaryError: null,
      secondaryError: null,
    });
    // getStatus 失败按托盘不可用处理（R14 失败边界），不 reject。
    await expect(broken.getStatus()).resolves.toMatchObject({ trayAvailable: false });
  });

  it('subscribes to the four contract events and forwards payloads', async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const listen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      handlers.set(event, (payload: unknown) => handler({ payload }));
      return () => undefined;
    });
    const client = createConcealClient({
      listen: asListen(listen),
      isTauri: () => true,
      isAndroid: () => false,
    });

    const quitSources: string[] = [];
    const zones: string[] = [];
    const tray: boolean[] = [];
    let stale = 0;
    await client.onQuitRequested(({ source }) => {
      quitSources.push(source);
    });
    await client.onTrayStatusChanged(({ available }) => {
      tray.push(available);
    });
    await client.onPointerZone(({ zone }) => {
      zones.push(zone);
    });
    await client.onZonesStale(() => {
      stale += 1;
    });

    expect([...handlers.keys()].sort()).toEqual(
      [
        'conceal-pointer-zone',
        'conceal-quit-requested',
        'conceal-tray-status',
        'conceal-zones-stale',
      ].sort(),
    );
    handlers.get('conceal-quit-requested')!({ source: 'tray-menu' });
    handlers.get('conceal-tray-status')!({ available: true, error: null });
    handlers.get('conceal-pointer-zone')!({ zone: 'top' });
    handlers.get('conceal-zones-stale')!(undefined);
    expect(quitSources).toEqual(['tray-menu']);
    expect(tray).toEqual([true]);
    expect(zones).toEqual(['top']);
    expect(stale).toBe(1);
  });
});
