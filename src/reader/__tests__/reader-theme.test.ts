// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '../../theme/theme-service.js';
import {
  applyReaderTheme,
  COMIC_NATIVE_WINDOW_CHROME,
  COMIC_WINDOW_CHROME_CLASS,
  DEFAULT_READER_THEME,
  hostShowsComicReader,
  loadReaderTheme,
  parseReaderTheme,
  READER_THEME_STORAGE_KEY,
  readerNativeWindowChrome,
  saveReaderTheme,
  syncComicWindowChromeClass,
} from '../reader-theme.js';

describe('reader paper themes', () => {
  it('defaults to sepia and never writes the editor theme key', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    expect(parseReaderTheme(null)).toBe(DEFAULT_READER_THEME);
    expect(parseReaderTheme('midnight')).toBe('sepia');
    expect(loadReaderTheme(storage)).toBe('sepia');
    expect(saveReaderTheme(storage, 'night')).toBe('night');
    expect(store[READER_THEME_STORAGE_KEY]).toBe('night');
    expect(store[THEME_STORAGE_KEY]).toBeUndefined();
  });

  it('stamps paper tokens on the reading host only', () => {
    const root = document.createElement('div');
    applyReaderTheme(root, 'night');
    expect(root.dataset.readerTheme).toBe('night');
    expect(root.style.getPropertyValue('--lightink-bg')).toBe('#121212');
    expect(root.style.getPropertyValue('--lightink-fg')).toBe('#c8c8c8');
    expect(root.style.colorScheme).toBe('dark');
    expect(root.style.color).toMatch(/#c8c8c8|rgb\(200,\s*200,\s*200\)/);
    expect(root.style.backgroundColor).toMatch(/#121212|rgb\(18,\s*18,\s*18\)/);
  });

  it('maps paper themes onto native caption colors', () => {
    expect(readerNativeWindowChrome('sepia')).toEqual({
      dark: false,
      caption: '#fbf0d9',
      text: '#5c4a32',
    });
    expect(readerNativeWindowChrome('night')).toEqual({
      dark: true,
      caption: '#121212',
      text: '#c8c8c8',
    });
    expect(COMIC_NATIVE_WINDOW_CHROME).toEqual({
      dark: true,
      caption: '#111111',
      text: '#e6e6e6',
    });
  });

  it('only treats the active host as a comic window', () => {
    const comic = document.createElement('div');
    const pages = document.createElement('div');
    pages.dataset.comicReader = 'true';
    comic.appendChild(pages);
    comic.style.display = 'none';
    const epub = document.createElement('div');
    epub.appendChild(document.createElement('div'));
    document.body.append(comic, epub);

    expect(hostShowsComicReader(comic)).toBe(true);
    expect(hostShowsComicReader(epub)).toBe(false);
    expect(hostShowsComicReader(null)).toBe(false);
    expect(document.querySelector('[data-comic-reader="true"]')).not.toBeNull();

    const app = document.createElement('div');
    syncComicWindowChromeClass(app, hostShowsComicReader(epub));
    expect(app.classList.contains(COMIC_WINDOW_CHROME_CLASS)).toBe(false);
    syncComicWindowChromeClass(app, hostShowsComicReader(comic));
    expect(app.classList.contains(COMIC_WINDOW_CHROME_CLASS)).toBe(true);
    comic.remove();
    epub.remove();
  });
});
