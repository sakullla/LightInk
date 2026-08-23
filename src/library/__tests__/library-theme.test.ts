// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '../../theme/theme-service.js';
import { READER_THEME_STORAGE_KEY } from '../../reader/reader-theme.js';
import {
  adoptLibraryOverlayTheme,
  applyLibraryTheme,
  DEFAULT_LIBRARY_THEME,
  libraryNativeWindowChrome,
  LIBRARY_THEME_STORAGE_KEY,
  loadLibraryTheme,
  mountLibraryOverlay,
  parseLibraryTheme,
  saveLibraryTheme,
} from '../library-theme.js';

describe('library shelf themes', () => {
  it('defaults to gallery and never writes editor or reader theme keys', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    expect(parseLibraryTheme(null)).toBe(DEFAULT_LIBRARY_THEME);
    expect(parseLibraryTheme('warm-light')).toBe('gallery');
    expect(loadLibraryTheme(storage)).toBe('gallery');
    expect(saveLibraryTheme(storage, 'ink')).toBe('ink');
    expect(store[LIBRARY_THEME_STORAGE_KEY]).toBe('ink');
    expect(store[THEME_STORAGE_KEY]).toBeUndefined();
    expect(store[READER_THEME_STORAGE_KEY]).toBeUndefined();
  });

  it('stamps shelf tokens on the library host only', () => {
    const root = document.createElement('div');
    applyLibraryTheme(root, 'walnut');
    expect(root.dataset.libraryTheme).toBe('walnut');
    expect(root.style.getPropertyValue('--lightink-bg')).toBe('#241c17');
    expect(root.style.getPropertyValue('--lightink-accent')).toBe('#d4a06a');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('maps shelf themes onto native caption colors', () => {
    expect(libraryNativeWindowChrome('gallery')).toEqual({
      dark: false,
      caption: '#e8edf2',
      text: '#243038',
    });
    expect(libraryNativeWindowChrome('paper')).toEqual({
      dark: false,
      caption: '#f4efe6',
      text: '#3a3228',
    });
    expect(libraryNativeWindowChrome('ink')).toEqual({
      dark: true,
      caption: '#14161a',
      text: '#d5dae2',
    });
  });

  it('copies shelf tokens onto a body-mounted overlay so it does not use editor paper', () => {
    const host = document.createElement('div');
    applyLibraryTheme(host, 'gallery');
    document.body.style.setProperty('--lightink-bg-elevated', '#fffaf2');
    document.body.append(host);
    const overlay = document.createElement('div');
    adoptLibraryOverlayTheme(overlay, host);
    mountLibraryOverlay(overlay, host);
    expect(overlay.style.getPropertyValue('--lightink-bg-elevated')).toBe('#f7f9fb');
    expect(overlay.dataset.libraryTheme).toBe('gallery');
    expect(overlay.parentElement).toBe(document.body);
    overlay.remove();
    host.remove();
    document.body.style.removeProperty('--lightink-bg-elevated');
  });
});
