// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  createLibraryTabbar,
  type LibraryTabbarLabels,
} from '../library-tabbar.js';

const zhLabels: LibraryTabbarLabels = {
  navigation: '书库导航',
  shelf: '书架',
  sources: '书源',
  manage: '管理',
};

function tabItems(bar: HTMLElement): HTMLButtonElement[] {
  return Array.from(bar.querySelectorAll<HTMLButtonElement>('[data-library-tab-item]'));
}

describe('library tabbar', () => {
  it('renders shelf / sources / manage tabs in order with icons', () => {
    const bar = createLibraryTabbar(document, { labels: zhLabels, onSelect: vi.fn() });
    expect(bar.element.className).toBe('lightink-library-tabbar');
    expect(bar.element.getAttribute('aria-label')).toBe('书库导航');
    const items = tabItems(bar.element);
    expect(items.map((item) => item.dataset.libraryTabItem)).toEqual([
      'shelf',
      'sources',
      'manage',
    ]);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      '书架',
      '书源',
      '管理',
    ]);
    for (const item of items) {
      expect(item.querySelector('svg.lightink-library-tabbar-icon')).not.toBeNull();
    }
  });

  it('marks shelf active by default and reports taps through onSelect', () => {
    const onSelect = vi.fn();
    const bar = createLibraryTabbar(document, { labels: zhLabels, onSelect });
    const items = tabItems(bar.element);
    expect(items[0]!.classList.contains('is-active')).toBe(true);
    expect(items[0]!.getAttribute('aria-current')).toBe('page');

    items[1]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('sources');
    items[2]!.click();
    expect(onSelect).toHaveBeenCalledWith('manage');
  });

  it('moves the active marker with setActive', () => {
    const bar = createLibraryTabbar(document, { labels: zhLabels, onSelect: vi.fn() });
    bar.setActive('manage');
    const items = tabItems(bar.element);
    expect(items[2]!.classList.contains('is-active')).toBe(true);
    expect(items[2]!.getAttribute('aria-current')).toBe('page');
    expect(items[0]!.classList.contains('is-active')).toBe(false);
    expect(items[0]!.getAttribute('aria-current')).toBeNull();
  });

  it('relabels tabs and the nav landmark on locale change', () => {
    const bar = createLibraryTabbar(document, { labels: zhLabels, onSelect: vi.fn() });
    bar.setLabels({
      navigation: 'Library navigation',
      shelf: 'Shelf',
      sources: 'Sources',
      manage: 'Manage',
    });
    expect(bar.element.getAttribute('aria-label')).toBe('Library navigation');
    expect(tabItems(bar.element).map((item) => item.textContent?.trim())).toEqual([
      'Shelf',
      'Sources',
      'Manage',
    ]);
  });
});
