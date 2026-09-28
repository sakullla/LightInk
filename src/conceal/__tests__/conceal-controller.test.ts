// @vitest-environment jsdom

/**
 * conceal-controller 契约测试（R1/R6/R7/R8/R9/R13）：
 * 命令 facade、zones 测量与持久化全部注入 fake；断言 DOM data 属性、
 * reader-chrome 接管调用序列与 conceal_set_click_through 的 zones 推送。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  CONCEAL_PAGE_BACKGROUND_EVENT,
  createConcealController,
  type ConcealControllerDeps,
  type ConcealNoticeKind,
  type ReaderConcealZoneMode,
} from '../conceal-controller.js';
import type { ConcealClient, ConcealUiZone } from '../conceal-client.js';
import { defaultConcealPrefs, type ConcealPrefs } from '../conceal-prefs.js';

interface CallLog {
  cmd: string;
  args: Record<string, unknown>;
}

function makeClient(overrides: {
  fail?: (cmd: string) => string | undefined;
} = {}): ConcealClient & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const client: ConcealClient = {
    isEnabled: () => true,
    registerBossKeys: async (payload) => {
      calls.push({ cmd: 'conceal_register_boss_keys', args: { ...payload } });
      return {
        primary: payload.primary,
        secondary: payload.secondary,
        primaryError: null,
        secondaryError: null,
      };
    },
    setAlwaysOnTop: async (enabled) => {
      calls.push({ cmd: 'conceal_set_always_on_top', args: { enabled } });
      const fail = overrides.fail?.('conceal_set_always_on_top');
      if (fail !== undefined) {
        throw fail;
      }
      return null;
    },
    setTransparent: async (enabled) => {
      calls.push({ cmd: 'conceal_set_transparent', args: { enabled } });
      const fail = overrides.fail?.('conceal_set_transparent');
      if (fail !== undefined) {
        throw fail;
      }
      return null;
    },
    setMiniWindow: async (enabled) => {
      calls.push({ cmd: 'conceal_set_mini_window', args: { enabled } });
      const fail = overrides.fail?.('conceal_set_mini_window');
      if (fail !== undefined) {
        throw fail;
      }
      return null;
    },
    restoreWindowBaseline: async () => {
      calls.push({ cmd: 'conceal_restore_window_baseline', args: {} });
      const fail = overrides.fail?.('conceal_restore_window_baseline');
      if (fail !== undefined) {
        throw fail;
      }
      return null;
    },
    setClickThrough: async (args) => {
      calls.push({
        cmd: 'conceal_set_click_through',
        args: { ...(args as unknown as Record<string, unknown>) },
      });
      const fail = overrides.fail?.('conceal_set_click_through');
      if (fail !== undefined) {
        throw fail;
      }
      return null;
    },
    hideToTray: async () => null,
    restoreFromTray: async () => null,
    getStatus: async () => ({
      trayAvailable: true,
      trayError: null,
      bossPrimary: null,
      bossSecondary: null,
    }),
    exitApp: async () => null,
    onQuitRequested: async () => () => undefined,
    onTrayStatusChanged: async () => () => undefined,
    onPointerZone: async () => () => undefined,
    onZonesStale: async () => () => undefined,
  };
  return Object.assign(client, { calls });
}

interface ChromeSpy {
  setConcealZones: Mock<(top: ReaderConcealZoneMode, bottom: ReaderConcealZoneMode) => void>;
}

interface Harness {
  client: ReturnType<typeof makeClient>;
  chrome: ChromeSpy;
  notices: { kind: ConcealNoticeKind; reason?: string }[];
  controller: ReturnType<typeof createConcealController>;
  dom: { html: HTMLElement; app: HTMLElement };
  prefs: ConcealPrefs;
  persistWrites: () => number;
  measures: {
    top: { y: number; height: number } | null;
    bottom: { y: number; height: number } | null;
    ui: ConcealUiZone | null;
  };
  setMeasures(top: { y: number; height: number } | null, bottom: { y: number; height: number } | null): void;
  setUiZone(ui: ConcealUiZone | null): void;
}

function makeHarness(prefsOverride: Partial<ConcealPrefs> = {}, clientOverride?: Parameters<typeof makeClient>[0]): Harness {
  const client = makeClient(clientOverride);
  const chrome: ChromeSpy = {
    setConcealZones: vi.fn<(top: ReaderConcealZoneMode, bottom: ReaderConcealZoneMode) => void>(),
  };
  const notices: { kind: ConcealNoticeKind; reason?: string }[] = [];
  const html = document.documentElement;
  const app = document.createElement('div');
  app.id = 'app';
  document.body.appendChild(app);
  const prefs: ConcealPrefs = { ...defaultConcealPrefs(false), ...prefsOverride };
  let persistWrites = 0;
  const geometry = {
    top: { y: 0, height: 48 } as { y: number; height: number } | null,
    bottom: { y: 660, height: 40 } as { y: number; height: number } | null,
    ui: null as ConcealUiZone | null,
  };
  // 模拟真实测量：栏被 R7 隐藏（display:none）→ rect=0 → null。
  const state = { surface: 'shelf' as 'shelf' | 'reader' | 'editor', pointerZone: null as string | null };
  const topBarVisible = () => !(prefs.hideTop && prefs.transparentMode && state.pointerZone !== 'top');
  const bottomBarVisible = () =>
    state.surface === 'reader' && !(prefs.hideBottom && state.pointerZone !== 'bottom');
  const deps: ConcealControllerDeps = {
    client,
    prefs,
    persist: (next) => {
      persistWrites += 1;
      Object.assign(prefs, next);
      return { ...prefs };
    },
    doc: document,
    getActiveReaderChrome: () => ({ setConcealZones: chrome.setConcealZones }),
    measureTopZone: () => (topBarVisible() ? geometry.top : null),
    measureBottomZone: () => (bottomBarVisible() ? geometry.bottom : null),
    measureUiZone: () => geometry.ui,
    getViewportHeight: () => 700,
    fallbackTopHeight: 48,
    fallbackBottomHeight: 40,
    onNotice: (kind, reason) => {
      notices.push({ kind, reason });
    },
  };
  const raw = createConcealController(deps);
  const controller = {
    ...raw,
    setSurface(surface: 'editor' | 'shelf' | 'reader') {
      state.surface = surface;
      return raw.setSurface(surface);
    },
    handlePointerZone(zone: 'top' | 'body' | 'bottom' | 'outside') {
      state.pointerZone = zone;
      return raw.handlePointerZone(zone);
    },
    handlePointerMove(clientY: number | null) {
      if (clientY === null) {
        state.pointerZone = 'outside';
      } else if (clientY < 48) {
        state.pointerZone = 'top';
      } else if (clientY >= 660) {
        state.pointerZone = 'bottom';
      } else {
        state.pointerZone = 'body';
      }
      return raw.handlePointerMove(clientY);
    },
  };
  return {
    client,
    chrome,
    notices,
    controller,
    dom: { html, app },
    prefs,
    persistWrites: () => persistWrites,
    measures: geometry,
    setMeasures(top, bottom) {
      geometry.top = top;
      geometry.bottom = bottom;
    },
    setUiZone(ui) {
      geometry.ui = ui;
    },
  };
}

const clickThroughCalls = (h: Harness) =>
  h.client.calls.filter((call) => call.cmd === 'conceal_set_click_through');
const lastClickThrough = (h: Harness): CallLog => {
  const calls = clickThroughCalls(h);
  return calls[calls.length - 1]!;
};


beforeEach(() => {
  document.documentElement.removeAttribute('data-conceal-surface');
  document.documentElement.removeAttribute('data-conceal-transparent');
  document.documentElement.removeAttribute('data-conceal-page-background');
  document.documentElement.style.removeProperty('--lightink-conceal-page-background');
  document.documentElement.style.removeProperty('--lightink-conceal-content-opacity');
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('conceal controller R1 surface scoping', () => {
  it('entering the editor calls conceal_restore_window_baseline and clears every data attribute', async () => {
    const h = makeHarness({
      transparentMode: true,
      alwaysOnTop: true,
      miniWindow: true,
      clickThrough: true,
      hideBody: true,
    });
    h.controller.setSurface('reader');
    h.controller.handlePointerZone('top');
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-transparent')).toBe('on');
    expect(h.dom.app.getAttribute('data-conceal-body')).toBe('hidden');

    h.controller.setSurface('editor');
    await h.controller.settled();

    const baseline = h.client.calls.find((c) => c.cmd === 'conceal_restore_window_baseline');
    expect(baseline).toBeDefined();
    expect(h.dom.html.getAttribute('data-conceal-surface')).toBe('editor');
    expect(h.dom.html.getAttribute('data-conceal-transparent')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-top')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-bottom')).toBeNull();
    // 阅读器接管态回 'auto'（原 idle 自动隐藏机制恢复）。
    expect(h.chrome.setConcealZones).toHaveBeenLastCalledWith('auto', 'auto');
  });

  it('replays the saved switches when returning to shelf/reader and never touches reader/tabs APIs', async () => {
    const h = makeHarness({ alwaysOnTop: true, transparentMode: true, miniWindow: true });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    const afterFirst = h.client.calls.length;

    h.controller.setSurface('editor');
    await h.controller.settled();
    // 再次进入 editor 是幂等的：baseline 不重复（后端幂等，前端也不重发）。
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_restore_window_baseline')).toHaveLength(1);

    h.controller.setSurface('shelf');
    await h.controller.settled();
    const cmds = (start: number) => h.client.calls.slice(start).map((c) => c.cmd);
    expect(cmds(afterFirst)).toContain('conceal_set_always_on_top');
    expect(cmds(afterFirst)).toContain('conceal_set_transparent');
    expect(cmds(afterFirst)).toContain('conceal_set_mini_window');
    // 全程不触碰 reader/tabs——deps 里没有它们，唯一的外呼是 conceal 命令；
    // reader-chrome 只在进入 editor 时被复位一次（'auto'）。
    expect(h.chrome.setConcealZones).toHaveBeenCalledTimes(1);
    expect(h.chrome.setConcealZones).toHaveBeenCalledWith('auto', 'auto');
  });

  it('shelf↔reader keeps window effects applied and only recomputes DOM/zones', async () => {
    const h = makeHarness({ alwaysOnTop: true });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_set_always_on_top')).toHaveLength(1);

    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_set_always_on_top')).toHaveLength(1);
    expect(h.dom.html.getAttribute('data-conceal-surface')).toBe('reader');
  });
});

describe('conceal controller R7 hide matrix', () => {
  it('top/body hiding requires transparent mode; bottom is independent', async () => {
    const h = makeHarness({ hideTop: true, hideBody: true, hideBottom: true });
    h.controller.setSurface('reader');
    h.controller.handlePointerZone('outside');
    await h.controller.settled();

    // 透明模式关闭：顶/主体立即显示（开关值仍保存），底栏独立隐藏。
    expect(h.dom.app.getAttribute('data-conceal-top')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-bottom')).toBe('hidden');
    expect(h.chrome.setConcealZones).toHaveBeenLastCalledWith('auto', 'hidden');

    // 开启透明模式后顶/主体按 zone 显隐。
    h.controller.applyPrefs({ transparentMode: true });
    h.controller.handlePointerZone('body');
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-top')).toBe('hidden');
    expect(h.dom.app.getAttribute('data-conceal-body')).toBeNull();
    expect(h.chrome.setConcealZones).toHaveBeenLastCalledWith('hidden', 'hidden');

    h.controller.handlePointerZone('top');
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-top')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBe('hidden');
    expect(h.chrome.setConcealZones).toHaveBeenLastCalledWith('held', 'hidden');
  });

  it('switching every R7 switch off shows everything immediately and returns reader chrome to auto', async () => {
    const h = makeHarness({
      transparentMode: true,
      hideTop: true,
      hideBody: true,
      hideBottom: true,
    });
    h.controller.setSurface('reader');
    h.controller.handlePointerZone('outside');
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBe('hidden');

    h.controller.applyPrefs({ hideTop: false, hideBody: false, hideBottom: false });
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-top')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBeNull();
    expect(h.dom.app.getAttribute('data-conceal-bottom')).toBeNull();
    expect(h.chrome.setConcealZones).toHaveBeenLastCalledWith('auto', 'auto');
  });

  it('backend conceal-pointer-zone events drive the same state machine as DOM moves', async () => {
    const h = makeHarness({ transparentMode: true, hideBody: true });
    h.controller.setSurface('reader');
    // DOM pointermove：y=300 落在 body 带。
    h.controller.handlePointerMove(300);
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBeNull();

    // 后端事件（穿透态唯一输入源）：指针离开 → 隐藏。
    h.controller.handlePointerZone('top');
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-body')).toBe('hidden');
  });

  it('shelf has no bottom zone: the bottom switch is a no-op there', async () => {
    const h = makeHarness({ hideBottom: true });
    h.controller.setSurface('shelf');
    h.controller.handlePointerZone('body');
    await h.controller.settled();
    expect(h.dom.app.getAttribute('data-conceal-bottom')).toBeNull();
    expect(h.chrome.setConcealZones).not.toHaveBeenCalled();
  });
});

describe('conceal controller R13 click-through', () => {
  it('pushes zones only while transparent mode and the switch are both on', async () => {
    const h = makeHarness({ transparentMode: true, clickThrough: true });
    h.controller.setSurface('reader');
    await h.controller.settled();
    const enabled = clickThroughCalls(h).filter((c) => c.args.enabled === true);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.args.topZone).toEqual({ y: 0, height: 48 });
    expect(enabled[0]!.args.bottomZone).toEqual({ y: 660, height: 40 });
    expect(enabled[0]!.args.topVisible).toBe(true);
    expect(enabled[0]!.args.bottomVisible).toBe(true);
  });

  it('bands are interactive only while the bar is visible; hidden bands re-push with visible=false', async () => {
    const h = makeHarness({
      transparentMode: true,
      clickThrough: true,
      hideTop: true,
      hideBottom: true,
    });
    h.controller.setSurface('reader');
    await h.controller.settled();
    // 初始 zone unknown → 顶/底隐藏（display:none → 测量 null）→
    // topVisible/bottomVisible=false，几何用兜底值上报。
    const first = lastClickThrough(h);
    expect(first.args.topVisible).toBe(false);
    expect(first.args.bottomVisible).toBe(false);
    expect(first.args.topZone).toEqual({ y: 0, height: 48 });
    expect(first.args.bottomZone).toEqual({ y: 660, height: 40 });

    // 指针进入顶带 → 顶栏显示，实测可见；底栏仍隐藏。
    h.controller.handlePointerZone('top');
    await h.controller.settled();
    const second = lastClickThrough(h);
    expect(second.args.topVisible).toBe(true);
    expect(second.args.bottomVisible).toBe(false);
  });

  it('hidden bars fall back to the cached rect (reader overlay keeps geometry)', async () => {
    const h = makeHarness({ transparentMode: true, clickThrough: true });
    h.controller.setSurface('reader');
    await h.controller.settled();
    // 底栏隐藏（display:none → 测量 null）→ 用缓存 rect 上报。
    h.setMeasures({ y: 0, height: 48 }, null);
    h.controller.notifyZonesStale();
    await h.controller.settled();
    const last = lastClickThrough(h);
    expect(last.args.bottomZone).toEqual({ y: 660, height: 40 });
    expect(last.args.bottomVisible).toBe(false);
  });

  it('transparent mode off → never enables click-through and immediately revokes it', async () => {
    const h = makeHarness({ transparentMode: true, clickThrough: true });
    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(clickThroughCalls(h).some((c) => c.args.enabled === true)).toBe(true);

    h.controller.applyPrefs({ transparentMode: false });
    await h.controller.settled();
    const revoke = lastClickThrough(h);
    expect(revoke.args.enabled).toBe(false);
    // 再关穿透开关：不再重发 revoke（已撤销）。
    const countAfterRevoke = clickThroughCalls(h).length;
    h.controller.applyPrefs({ clickThrough: false });
    await h.controller.settled();
    expect(clickThroughCalls(h)).toHaveLength(countAfterRevoke);
  });

  it('click-through on while transparent mode off never issues enabled=true', async () => {
    const h = makeHarness({ transparentMode: false, clickThrough: true });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(clickThroughCalls(h).some((c) => c.args.enabled === true)).toBe(false);
  });

  it('resize / conceal-zones-stale re-pushes with the new measurement', async () => {
    const h = makeHarness({ transparentMode: true, clickThrough: true });
    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(lastClickThrough(h).args.topZone).toEqual({ y: 0, height: 48 });

    h.setMeasures({ y: 0, height: 72 }, { y: 640, height: 60 });
    h.controller.notifyZonesStale();
    await h.controller.settled();
    const last = lastClickThrough(h);
    expect(last.args.topZone).toEqual({ y: 0, height: 72 });
    expect(last.args.bottomZone).toEqual({ y: 640, height: 60 });
  });

  it('a click-through command failure rolls the switch back and notifies', async () => {
    const h = makeHarness(
      { transparentMode: true, clickThrough: true },
      { fail: (cmd) => (cmd === 'conceal_set_click_through' ? '当前会话不支持点击穿透' : undefined) },
    );
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.controller.getEffectivePrefs().clickThrough).toBe(false);
    expect(h.notices).toContainEqual({
      kind: 'clickThroughFailed',
      reason: '当前会话不支持点击穿透',
    });
  });

  it('R13: rides the ui control zone along so visible settings controls stay clickable', async () => {
    const h = makeHarness({ transparentMode: true, clickThrough: true });
    h.setUiZone({ x: 8, y: 300, width: 240, height: 360 });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    const enabled = clickThroughCalls(h).filter((c) => c.args.enabled === true);
    expect(enabled).toHaveLength(1);
    // 书架设置入口/设置页矩形：这些可见按钮在 body 带内仍由 LightInk 接收。
    expect(enabled[0]!.args.uiZone).toEqual({ x: 8, y: 300, width: 240, height: 360 });

    // 控件不可见（面板关闭/R7 隐藏）→ 不再上报，该区点击按穿透处理。
    h.setUiZone(null);
    h.controller.notifyZonesStale();
    await h.controller.settled();
    expect(lastClickThrough(h).args.enabled).toBe(true);
    expect(lastClickThrough(h).args.uiZone).toBeNull();

    // 撤销穿透时 uiZone 一并清空。
    h.setUiZone({ x: 8, y: 300, width: 240, height: 360 });
    h.controller.applyPrefs({ clickThrough: false });
    await h.controller.settled();
    const revoke = lastClickThrough(h);
    expect(revoke.args.enabled).toBe(false);
    expect(revoke.args.uiZone).toBeNull();
  });

  it('R13: 穿透激活期间周期复测交互带（overlay 开合无需 zones-stale 也会重推）', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ transparentMode: true, clickThrough: true });
      h.controller.setSurface('shelf');
      await h.controller.settled();
      const enabled = () => clickThroughCalls(h).filter((c) => c.args.enabled === true);
      expect(enabled()).toHaveLength(1);
      expect(enabled()[0]!.args.uiZone).toBeNull();

      // 助手面板等 body 级 overlay 打开：测量结果变化，无需任何后端事件，
      // 周期复测在下一拍把新交互带推给后端（可见按钮恢复可点）。
      h.setUiZone({ x: 40, y: 40, width: 320, height: 480 });
      vi.advanceTimersByTime(600);
      await h.controller.settled();
      expect(enabled()).toHaveLength(2);
      expect(enabled()[1]!.args.uiZone).toEqual({ x: 40, y: 40, width: 320, height: 480 });

      // overlay 关闭：交互带随之撤下。
      h.setUiZone(null);
      vi.advanceTimersByTime(600);
      await h.controller.settled();
      expect(enabled()).toHaveLength(3);
      expect(enabled()[2]!.args.uiZone).toBeNull();

      // 关闭穿透后复测停表：交互带再变化也不产生新推送。
      h.controller.applyPrefs({ clickThrough: false });
      await h.controller.settled();
      h.setUiZone({ x: 1, y: 1, width: 5, height: 5 });
      vi.advanceTimersByTime(2000);
      await h.controller.settled();
      expect(enabled().length).toBe(3);
      expect(lastClickThrough(h).args.enabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('conceal controller R8/R9/R6 command failures', () => {
  it('always-on-top rejection rolls the effective switch back with a notice', async () => {
    const h = makeHarness(
      { alwaysOnTop: true },
      { fail: (cmd) => (cmd === 'conceal_set_always_on_top' ? '系统错误' : undefined) },
    );
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.controller.getEffectivePrefs().alwaysOnTop).toBe(false);
    expect(h.notices).toContainEqual({ kind: 'alwaysOnTopFailed', reason: '系统错误' });
  });

  it('mini-window rejection rolls the effective switch back with a notice', async () => {
    const h = makeHarness(
      { miniWindow: true },
      { fail: (cmd) => (cmd === 'conceal_set_mini_window' ? '窗口已过小，无法再缩小' : undefined) },
    );
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.controller.getEffectivePrefs().miniWindow).toBe(false);
    expect(h.notices).toContainEqual({ kind: 'miniWindowFailed', reason: '窗口已过小，无法再缩小' });
  });

  it('baseline restore failure rolls the mini switch back and retries on re-entry', async () => {
    let fail = true;
    const h = makeHarness(
      { miniWindow: true },
      { fail: (cmd) => (cmd === 'conceal_restore_window_baseline' && fail ? '窗口状态未稳定' : undefined) },
    );
    h.controller.setSurface('reader');
    await h.controller.settled();
    h.controller.setSurface('editor');
    await h.controller.settled();
    expect(h.controller.getEffectivePrefs().miniWindow).toBe(false);
    expect(h.notices).toContainEqual({ kind: 'baselineFailed', reason: '窗口状态未稳定' });

    // 幂等可重试：再次进入 editor 会再发一次 baseline。
    h.controller.setSurface('reader');
    h.controller.applyPrefs({ miniWindow: true });
    await h.controller.settled();
    fail = false;
    h.controller.setSurface('editor');
    await h.controller.settled();
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_restore_window_baseline')).toHaveLength(2);
    expect(h.notices).toHaveLength(1);
  });
});

describe('conceal controller R6 transparent + R5 gradient persistence', () => {
  it('keeps the gradient saved but never sets the transparent attribute while transparent mode is off', async () => {
    const h = makeHarness({ background: { kind: 'preset', preset: 'sky' } });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-transparent')).toBeNull();
    const css = h.dom.html.style.getPropertyValue('--lightink-conceal-page-background');
    expect(css).toContain('linear-gradient');

    h.controller.applyPrefs({ transparentMode: true });
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-transparent')).toBe('on');
    expect(
      h.dom.html.style.getPropertyValue('--lightink-conceal-page-background'),
    ).toBe('transparent');
    // 选择仍保存：关掉透明后渐变回来。
    h.controller.applyPrefs({ transparentMode: false });
    await h.controller.settled();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toContain(
      'linear-gradient',
    );
  });

  it('content opacity is only published below 100 and cleared on the editor surface', async () => {
    const h = makeHarness({ contentOpacity: 40 });
    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-content-opacity')).toBe('0.4');

    h.controller.setSurface('editor');
    await h.controller.settled();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-content-opacity')).toBe('');
  });

  it('theme background removes the custom page-background variable entirely', async () => {
    const h = makeHarness({ background: { kind: 'custom', from: '#101010', to: '#efefef' } });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toContain(
      '#101010',
    );
    h.controller.applyPrefs({ background: { kind: 'theme' } });
    await h.controller.settled();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toBe('');
  });
});

describe('conceal controller R5/R6 page background override marker + repaint event', () => {
  it('marks data-conceal-page-background only while the override variable is written', async () => {
    const h = makeHarness({ background: { kind: 'preset', preset: 'butter' } });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    // 渐变生效：属性=on（conceal.css 用它以 !important 压过阅读器/编辑区的内联纸色）。
    expect(h.dom.html.getAttribute('data-conceal-page-background')).toBe('on');
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toContain(
      'linear-gradient',
    );

    // 透明模式：变量改写为 transparent，属性保持 on。
    h.controller.applyPrefs({ transparentMode: true });
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-page-background')).toBe('on');
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toBe(
      'transparent',
    );

    // 主题背景：变量与属性一并移除（默认态与升级前一致，不命中覆盖规则）。
    h.controller.applyPrefs({ transparentMode: false, background: { kind: 'theme' } });
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-page-background')).toBeNull();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toBe('');
  });

  it('dispatches a repaint event whenever the effective override value changes', async () => {
    const h = makeHarness({ transparentMode: true });
    const events: Array<string | null> = [];
    const onEvent = (event: Event): void => {
      events.push((event as CustomEvent).detail?.background ?? null);
    };
    document.addEventListener(CONCEAL_PAGE_BACKGROUND_EVENT, onEvent);
    try {
      h.controller.setSurface('shelf');
      h.controller.setSurface('reader');
      await h.controller.settled();
      // shelf→reader 值未变：只发一次（初始 null → 'transparent'）。
      expect(events).toEqual(['transparent']);

      h.controller.setSurface('editor');
      await h.controller.settled();
      // 进编辑器：改写撤除 → null（阅读器 iframe 重涂回主题纸色）。
      expect(events).toEqual(['transparent', null]);

      h.controller.setSurface('reader');
      await h.controller.settled();
      expect(events).toEqual(['transparent', null, 'transparent']);
    } finally {
      document.removeEventListener(CONCEAL_PAGE_BACKGROUND_EVENT, onEvent);
    }
  });

  it('never marks the override or emits the event on the editor surface', async () => {
    const h = makeHarness({ background: { kind: 'preset', preset: 'sky' } });
    h.controller.setSurface('editor');
    await h.controller.settled();
    expect(h.dom.html.getAttribute('data-conceal-page-background')).toBeNull();
    expect(h.dom.html.style.getPropertyValue('--lightink-conceal-page-background')).toBe('');
  });
});

describe('conceal controller R2 boss key updates', () => {
  it('pre-validates client-side without invoking the backend', async () => {
    const h = makeHarness();
    h.controller.setSurface('shelf');

    const empty = await h.controller.updateBossKeys('', 'Alt+X');
    expect(empty.primaryError).toBe('组合不能为空');

    const modifierOnly = await h.controller.updateBossKeys('Control+Shift', 'Alt+X');
    expect(modifierOnly.primaryError).toBe('无效组合或仅修饰键');

    const same = await h.controller.updateBossKeys('Alt+Z', 'Alt+Z');
    expect(same.secondaryError).toBe('与老板键 1 相同');
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_register_boss_keys')).toHaveLength(0);
  });

  it('persists new combos only after a successful registration', async () => {
    const h = makeHarness();
    const result = await h.controller.updateBossKeys('Control+Shift+P', 'Control+Shift+Q');
    expect(result.primaryError).toBeNull();
    expect(h.controller.getEffectivePrefs().bossPrimary).toBe('Control+Shift+P');
    expect(h.client.calls.filter((c) => c.cmd === 'conceal_register_boss_keys')).toHaveLength(1);
  });
});

describe('conceal controller R5 rejected opens write that switch off', () => {
  const stored: Partial<ConcealPrefs> = {
    background: { kind: 'preset', preset: 'sky' },
    contentOpacity: 60,
    hideTop: true,
    hideBody: false,
    hideBottom: true,
    alwaysOnTop: false,
    miniWindow: false,
    transparentMode: false,
    clickThrough: false,
  };

  it.each([
    ['conceal_set_always_on_top', 'alwaysOnTop', 'alwaysOnTopFailed'],
    ['conceal_set_mini_window', 'miniWindow', 'miniWindowFailed'],
    ['conceal_set_transparent', 'transparentMode', 'transparentFailed'],
    ['conceal_set_click_through', 'clickThrough', 'clickThroughFailed'],
  ] as const)(
    '%s rejection persists that switch off and keeps every other field',
    async (cmd, key, kind) => {
      const h = makeHarness(stored, { fail: (name) => (name === cmd ? '系统拒绝' : undefined) });
      h.controller.setSurface('shelf');
      await h.controller.settled();
      const before = structuredClone(h.prefs);
      const writes = h.persistWrites();

      h.controller.applyPrefs({
        alwaysOnTop: true,
        miniWindow: true,
        transparentMode: true,
        clickThrough: true,
      });
      await h.controller.settled();

      const expected = { ...before, alwaysOnTop: true, miniWindow: true, transparentMode: true, clickThrough: true, [key]: false };
      expect(h.prefs).toEqual(expected);
      expect(h.controller.getEffectivePrefs()).toEqual(expected);
      expect(h.notices).toContainEqual({ kind, reason: '系统拒绝' });
      expect(h.persistWrites()).toBe(writes + 2);
    },
  );

  it('baseline restore failure writes only the mini window off', async () => {
    const h = makeHarness(
      {
        background: { kind: 'custom', from: '#112233', to: '#abcdef' },
        transparentMode: true,
        contentOpacity: 45,
        hideTop: true,
        hideBody: true,
        hideBottom: false,
        alwaysOnTop: true,
        miniWindow: true,
        clickThrough: true,
      },
      { fail: (cmd) => (cmd === 'conceal_restore_window_baseline' ? '窗口状态未稳定' : undefined) },
    );
    h.controller.setSurface('reader');
    await h.controller.settled();
    const before = structuredClone(h.prefs);
    const writes = h.persistWrites();
    const miniOn = () =>
      h.client.calls.filter((call) => call.cmd === 'conceal_set_mini_window' && call.args.enabled === true).length;
    expect(miniOn()).toBe(1);

    h.controller.setSurface('editor');
    await h.controller.settled();

    expect(h.dom.html.getAttribute('data-conceal-surface')).toBe('editor');
    expect(h.dom.html.getAttribute('data-conceal-transparent')).toBeNull();
    expect(h.prefs).toEqual({ ...before, miniWindow: false });
    expect(h.controller.getEffectivePrefs()).toEqual({ ...before, miniWindow: false });
    expect(h.notices).toContainEqual({ kind: 'baselineFailed', reason: '窗口状态未稳定' });
    expect(h.persistWrites()).toBe(writes + 1);

    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(miniOn()).toBe(1);
    expect(h.prefs.alwaysOnTop).toBe(true);
    expect(h.prefs.transparentMode).toBe(true);
    expect(h.prefs.clickThrough).toBe(true);
    expect(h.prefs.hideTop).toBe(true);
    expect(h.prefs.hideBody).toBe(true);
    expect(h.prefs.hideBottom).toBe(false);
    expect(h.prefs.contentOpacity).toBe(45);
  });

  it('baseline restore failure does not rewrite prefs when mini is already off', async () => {
    const h = makeHarness(
      { miniWindow: false, alwaysOnTop: true, transparentMode: true, hideTop: true, hideBody: true, clickThrough: true },
      { fail: (cmd) => (cmd === 'conceal_restore_window_baseline' ? '窗口状态未稳定' : undefined) },
    );
    h.controller.setSurface('reader');
    await h.controller.settled();
    const before = structuredClone(h.prefs);
    const writes = h.persistWrites();

    h.controller.setSurface('editor');
    await h.controller.settled();

    expect(h.prefs).toEqual(before);
    expect(h.persistWrites()).toBe(writes);
    expect(h.notices).toContainEqual({ kind: 'baselineFailed', reason: '窗口状态未稳定' });
  });
});

describe('conceal controller R5 content opacity preview', () => {
  const opacityOf = (h: Harness): string =>
    h.dom.html.style.getPropertyValue('--lightink-conceal-content-opacity');

  it('follows integers 0–100 without writing storage', async () => {
    const h = makeHarness({ contentOpacity: 100, alwaysOnTop: true, hideBottom: true });
    h.controller.setSurface('reader');
    await h.controller.settled();
    const before = structuredClone(h.prefs);
    const writes = h.persistWrites();

    h.controller.previewContentOpacity(0);
    expect(opacityOf(h)).toBe('0');
    h.controller.previewContentOpacity(40);
    expect(opacityOf(h)).toBe('0.4');
    h.controller.previewContentOpacity(100);
    expect(opacityOf(h)).toBe('');
    h.controller.previewContentOpacity(15);
    h.controller.handlePointerMove(200);
    expect(opacityOf(h)).toBe('0.15');

    expect(h.persistWrites()).toBe(writes);
    expect(h.prefs).toEqual(before);
    expect(h.controller.getEffectivePrefs().contentOpacity).toBe(100);
  });

  it('ignores preview values that are not integers from 0 to 100', async () => {
    const h = makeHarness({ contentOpacity: 80 });
    h.controller.setSurface('shelf');
    await h.controller.settled();
    expect(opacityOf(h)).toBe('0.8');
    const writes = h.persistWrites();

    h.controller.previewContentOpacity(101);
    h.controller.previewContentOpacity(-1);
    h.controller.previewContentOpacity(50.5);
    h.controller.previewContentOpacity(Number.NaN);
    expect(opacityOf(h)).toBe('0.8');
    expect(h.prefs.contentOpacity).toBe(80);
    expect(h.persistWrites()).toBe(writes);
  });

  it('saves an in-range integer and drops blank, out-of-range, or non-integer commits', async () => {
    const h = makeHarness({
      contentOpacity: 80,
      miniWindow: true,
      hideBody: true,
      alwaysOnTop: true,
      background: { kind: 'preset', preset: 'mint' },
    });
    h.controller.setSurface('reader');
    await h.controller.settled();

    h.controller.previewContentOpacity(25);
    expect(opacityOf(h)).toBe('0.25');
    const writes = h.persistWrites();
    expect(h.controller.commitContentOpacity(25).contentOpacity).toBe(25);
    expect(h.prefs.contentOpacity).toBe(25);
    expect(h.prefs.miniWindow).toBe(true);
    expect(h.prefs.hideBody).toBe(true);
    expect(h.prefs.alwaysOnTop).toBe(true);
    expect(h.prefs.background).toEqual({ kind: 'preset', preset: 'mint' });
    expect(opacityOf(h)).toBe('0.25');
    expect(h.persistWrites()).toBe(writes + 1);

    h.controller.previewContentOpacity(10);
    expect(opacityOf(h)).toBe('0.1');
    const afterSave = h.persistWrites();
    for (const rejected of [101, -3, 50.5, Number.NaN, '', '   ', 'abc', '60.0', null, undefined, false]) {
      h.controller.commitContentOpacity(rejected);
    }
    expect(h.prefs.contentOpacity).toBe(25);
    expect(h.controller.getEffectivePrefs().contentOpacity).toBe(25);
    expect(opacityOf(h)).toBe('0.25');
    expect(h.persistWrites()).toBe(afterSave);

    expect(h.controller.commitContentOpacity(' 60 ').contentOpacity).toBe(60);
    expect(h.prefs.contentOpacity).toBe(60);
    expect(opacityOf(h)).toBe('0.6');
    expect(h.controller.commitContentOpacity(0).contentOpacity).toBe(0);
    expect(opacityOf(h)).toBe('0');
    expect(h.controller.commitContentOpacity(100).contentOpacity).toBe(100);
    expect(opacityOf(h)).toBe('');
  });

  it('drops an unsaved preview when entering the editor', async () => {
    const h = makeHarness({ contentOpacity: 70 });
    h.controller.setSurface('reader');
    await h.controller.settled();
    h.controller.previewContentOpacity(30);
    expect(opacityOf(h)).toBe('0.3');

    h.controller.setSurface('editor');
    await h.controller.settled();
    expect(opacityOf(h)).toBe('');
    expect(h.prefs.contentOpacity).toBe(70);

    h.controller.setSurface('reader');
    await h.controller.settled();
    expect(opacityOf(h)).toBe('0.7');
    expect(h.prefs.contentOpacity).toBe(70);
  });
});
