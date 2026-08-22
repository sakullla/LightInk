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
