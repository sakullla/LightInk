// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createWindowTitlebar,
  resetWindowTitlebarTheme,
  syncReaderTitlebarReveal,
} from '../window-titlebar.js';
import type { AppWindowLike } from '../window-chrome.js';

describe('window titlebar', () => {
  it('renders a drag strip and caption buttons', () => {
    const bar = createWindowTitlebar(document, { getLocale: () => 'zh-CN' });
    expect(bar.element.id).toBe('lightink-window-titlebar');
    expect(bar.element.getAttribute('data-tauri-drag-region')).toBe('');
    expect(bar.element.querySelector('.lightink-window-titlebar-drag')).toBeTruthy();
    expect(bar.element.textContent).not.toContain('轻墨');
    expect(bar.element.querySelector('[data-window-caption="min"]')?.getAttribute('aria-label')).toBe(
      '最小化',
    );
    expect(bar.element.querySelector('[data-window-caption="close"]')?.getAttribute('aria-label')).toBe(
      '关闭',
    );
    bar.dispose();
  });

  it('forwards caption actions to the native window', async () => {
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      minimize: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isMaximized: vi.fn(async () => false),
    };
    const bar = createWindowTitlebar(document, {
      getWindow: async () => win,
      getLocale: () => 'en',
    });
    bar.element.querySelector<HTMLButtonElement>('[data-window-caption="min"]')!.click();
    bar.element.querySelector<HTMLButtonElement>('[data-window-caption="max"]')!.click();
    bar.element.querySelector<HTMLButtonElement>('[data-window-caption="close"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(win.minimize).toHaveBeenCalled();
    expect(win.toggleMaximize).toHaveBeenCalled();
    expect(win.close).toHaveBeenCalled();
    bar.dispose();
  });

  it('syncs native outer rounding on refresh and resize without restoring decorations', async () => {
    const invoke = vi.fn(async () => undefined);
    let onResized: (() => void) | undefined;
    let maximized = false;
    const win: AppWindowLike = {
      isFullscreen: vi.fn(async () => false),
      setFullscreen: vi.fn(async () => undefined),
      setDecorations: vi.fn(async () => undefined),
      toggleMaximize: vi.fn(async () => {
        maximized = !maximized;
      }),
      isMaximized: vi.fn(async () => maximized),
      onResized: vi.fn(async (handler) => {
        onResized = handler;
        return () => undefined;
      }),
    };
    const bar = createWindowTitlebar(document, {
      getWindow: async () => win,
      getLocale: () => 'en',
      invokeOuterRounded: invoke,
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: true });
    });
    expect(win.setDecorations).not.toHaveBeenCalled();

    invoke.mockClear();
    bar.element.querySelector<HTMLButtonElement>('[data-window-caption="max"]')!.click();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: false });
    });
    expect(win.setDecorations).not.toHaveBeenCalled();

    invoke.mockClear();
    maximized = false;
    onResized?.();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('set_window_outer_rounded', { rounded: true });
    });
    bar.dispose();
  });

  it('stamps reader chrome reveal on the app root so caption chips can appear', () => {
    const app = document.createElement('div');
    app.id = 'app';
    const reader = document.createElement('div');
    app.appendChild(reader);
    document.body.appendChild(app);

    syncReaderTitlebarReveal(reader, true);
    expect(app.classList.contains('is-reader-chrome-revealed')).toBe(true);
    syncReaderTitlebarReveal(reader, false);
    expect(app.classList.contains('is-reader-chrome-revealed')).toBe(false);
    app.remove();
  });

  it('hides reader caption chips until the reading chrome is revealed', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/window-titlebar.css'), 'utf-8');
    expect(css).toMatch(
      /#app\.is-workspace-reader \.lightink-window-titlebar\s*\{[^}]*opacity:\s*0/,
    );
    expect(css).toMatch(
      /#app\.is-workspace-reader\.is-reader-chrome-revealed \.lightink-window-titlebar/,
    );
    expect(css).toMatch(
      /html\[data-android\] \.lightink-window-titlebar,\s*html\[data-touch-primary\] \.lightink-window-titlebar\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.lightink-window-titlebar\s*\{[^}]*background:\s*transparent\s*!important/,
    );
    expect(css).toMatch(
      /#app\.is-comic-reader \.lightink-window-titlebar\s*\{[^}]*color:\s*#e6e6e6/,
    );
    expect(css).not.toMatch(/#app:has\(\[data-comic-reader=/);
  });

  it('keeps editor caption chips on the right so they do not cover the menu bar', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/window-titlebar.css'), 'utf-8');
    expect(css).toMatch(
      /#app\.is-workspace-editor \.lightink-window-titlebar\s*\{[^}]*left:\s*auto/,
    );
    expect(css).toMatch(
      /#app\.is-workspace-editor \.lightink-window-titlebar-drag\s*\{[^}]*display:\s*none/,
    );
    const theme = readFileSync(resolve(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    expect(theme).toMatch(
      /#app\.is-workspace-editor #lightink-toolbar,\s*#app\.is-workspace-editor #lightink-tabbar\s*\{[^}]*padding-right:\s*calc\(\s*var\(--lightink-titlebar-caption/,
    );
    expect(theme).toMatch(/\.lightink-chrome-drag\s*\{[^}]*-webkit-app-region:\s*drag/);
  });

  it('lets the empty shelf title row drag the window', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/window-titlebar.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-library-header-main,\s*\.lightink-library-header h1\s*\{[^}]*-webkit-app-region:\s*drag/,
    );
    expect(css).toMatch(
      /\.lightink-library-header input,\s*\.lightink-library-header button,\s*\.lightink-library-search,\s*\.lightink-library-toolbar/,
    );
    expect(css).toMatch(/\.lightink-library-toolbar[\s\S]*?-webkit-app-region:\s*no-drag/);
  });

  it('clears stamped shelf tokens from the titlebar', () => {
    const root = document.createElement('div');
    root.dataset.libraryTheme = 'gallery';
    root.style.setProperty('--lightink-bg', '#e8edf2');
    root.style.backgroundColor = '#e8edf2';
    resetWindowTitlebarTheme(root);
    expect(root.dataset.libraryTheme).toBeUndefined();
    expect(root.style.getPropertyValue('--lightink-bg')).toBe('');
    expect(root.style.backgroundColor).toBe('');
  });
});
