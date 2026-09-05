/**
 * Fullscreen helper unit tests (injected fake window).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  setNativeCaptionColors,
  setNativeTheme,
  setNativeTitleBar,
  syncNativeWindowOuterRounded,
  toggleFullscreen,
  type AppWindowLike,
} from '../window-chrome.js';

describe('toggleFullscreen', () => {
  it('returns false when no window is available', async () => {
    await expect(toggleFullscreen(async () => null)).resolves.toBe(false);
  });

  it('enters fullscreen when currently windowed', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(toggleFullscreen(async () => win)).resolves.toBe(true);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  it('exits fullscreen when currently fullscreen', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => true),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(toggleFullscreen(async () => win)).resolves.toBe(false);
    expect(win.setFullscreen).toHaveBeenCalledWith(false);
  });

  it('clears outer rounding after entering fullscreen', async () => {
    let fullscreen = false;
    const invoke = vi.fn(async () => undefined);
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => fullscreen),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async (value) => {
        fullscreen = value;
      }),
    };
    await expect(toggleFullscreen(async () => win, invoke)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: false });
  });

  it('restores outer rounding after leaving fullscreen unless maximized', async () => {
    let fullscreen = true;
    const invoke = vi.fn(async () => undefined);
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => fullscreen),
      isMaximized: vi.fn(async () => false),
      setFullscreen: vi.fn(async (value) => {
        fullscreen = value;
      }),
    };
    await expect(toggleFullscreen(async () => win, invoke)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: true });
  });
});

describe('syncNativeWindowOuterRounded', () => {
  it('rounds only when restored, not maximized or fullscreen', async () => {
    const invoke = vi.fn(async () => undefined);
    const restored: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
    };
    await syncNativeWindowOuterRounded(async () => restored, invoke);
    expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: true });

    invoke.mockClear();
    const maximized: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => true),
    };
    await syncNativeWindowOuterRounded(async () => maximized, invoke);
    expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: false });

    invoke.mockClear();
    const fullscreen: AppWindowLike = {
      isFullscreen: vi.fn(async () => true),
      setFullscreen: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
    };
    await syncNativeWindowOuterRounded(async () => fullscreen, invoke);
    expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: false });
  });

  it('no-ops without a window and swallows invoke failures', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('not tauri');
    });
    await expect(syncNativeWindowOuterRounded(async () => null, invoke)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
    };
    await expect(syncNativeWindowOuterRounded(async () => win, invoke)).resolves.toBeUndefined();
  });
});

describe('setNativeTitleBar', () => {
  it('hides and restores native decorations', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      setDecorations: vi.fn(async () => undefined),
    };
    await setNativeTitleBar(false, async () => win);
    expect(win.setDecorations).toHaveBeenCalledWith(false);
    await setNativeTitleBar(true, async () => win);
    expect(win.setDecorations).toHaveBeenCalledWith(true);
  });

  it('no-ops when no window or no setDecorations support', async () => {
    await expect(setNativeTitleBar(false, async () => null)).resolves.toBeUndefined();
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(setNativeTitleBar(true, async () => win)).resolves.toBeUndefined();
  });
});

describe('setNativeTheme', () => {
  it('syncs dark/light native window theme', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      setTheme: vi.fn(async () => undefined),
    };
    await setNativeTheme(true, async () => win);
    expect(win.setTheme).toHaveBeenCalledWith('dark');
    await setNativeTheme(false, async () => win);
    expect(win.setTheme).toHaveBeenCalledWith('light');
  });

  it('no-ops when no window or no setTheme support', async () => {
    await expect(setNativeTheme(false, async () => null)).resolves.toBeUndefined();
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
    };
    await expect(setNativeTheme(true, async () => win)).resolves.toBeUndefined();
  });
});

describe('setNativeCaptionColors', () => {
  it('sends paper colors and restores the system caption', async () => {
    const invoke = vi.fn(async () => undefined);
    await setNativeCaptionColors({ caption: '#fbf0d9', text: '#5c4a32' }, invoke);
    expect(invoke).toHaveBeenCalledWith('set_window_caption_color', {
      caption: '#fbf0d9',
      text: '#5c4a32',
    });
    await setNativeCaptionColors(null, invoke);
    expect(invoke).toHaveBeenCalledWith('set_window_caption_color', {
      caption: null,
      text: null,
    });
  });

  it('swallows invoke failures outside Tauri', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('not tauri');
    });
    await expect(setNativeCaptionColors({ caption: '#121212', text: '#c8c8c8' }, invoke)).resolves.toBeUndefined();
  });
});
