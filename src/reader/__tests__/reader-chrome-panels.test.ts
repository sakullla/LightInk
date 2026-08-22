// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';
import {
  defaultReaderChromePanelCopy,
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  pinFixedOverlay,
  positionReaderChromePanel,
  unpinFixedOverlay,
} from '../reader-chrome-panels.js';

describe('reader chrome panels', () => {
  it('renders a vertical contents list and marks the current chapter', () => {
    const panel = document.createElement('div');
    const onSelect = vi.fn();
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 2, text: '小节', anchor: 1, chapter: 1 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 1 },
      onSelect,
    );
    const items = panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item');
    expect(panel.querySelector('nav')).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(items[1]!.classList.contains('is-current')).toBe(true);
    expect(items[1]!.dataset.outlineLevel).toBe('2');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    items[0]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('groups typography controls and exposes paper swatches', () => {
    const panel = document.createElement('div');
    const onTypography = vi.fn();
    const onTheme = vi.fn();
    const onSize = vi.fn();
    const onLayout = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'sepia',
      defaultReaderChromePanelCopy(),
      onTypography,
      onTheme,
      onSize,
      'paginated',
      onLayout,
    );
    expect(panel.classList.contains('lightink-reader-type-sheet')).toBe(true);
    expect(panel.querySelector('[data-type-section="size"]')).not.toBeNull();
    expect(panel.querySelector('[data-type-section="theme"]')).not.toBeNull();
    expect(panel.querySelector('[data-type-section="layout"]')).not.toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-type-section').length).toBeGreaterThanOrEqual(5);
    const visibleLabels: Array<[string, string]> = [
      ['theme', '纸张'],
      ['font', '字体'],
      ['layout', '版式'],
    ];
    for (const [kind, text] of visibleLabels) {
      const label = panel
        .querySelector(`[data-type-section="${kind}"]`)!
        .querySelector('.lightink-reader-type-label');
      expect(label).not.toBeNull();
      expect(label!.classList.contains('lightink-reader-type-label--hidden')).toBe(false);
      expect(label!.textContent).toBe(text);
    }
    const sizeLabel = panel
      .querySelector('[data-type-section="size"]')!
      .querySelector('.lightink-reader-type-label');
    expect(sizeLabel?.classList.contains('lightink-reader-type-label--hidden')).toBe(true);
    expect(panel.querySelectorAll('.lightink-reader-theme-swatch')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-theme-page')).toHaveLength(4);
    expect(panel.querySelector('.lightink-reader-theme-swatch-name')?.textContent).toBe('白纸');
    expect(panel.querySelector('.lightink-reader-type-hero-sample')?.textContent).toBe('轻墨');
    expect(panel.querySelector('.lightink-reader-type-step-mark')?.textContent).toBe('100%');
    expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-type-mode')).toHaveLength(2);
    expect(panel.querySelectorAll('.lightink-reader-type-slider')).toHaveLength(2);
    expect(
      panel.querySelector<HTMLButtonElement>('[data-reader-theme="sepia"]')?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    panel.querySelector<HTMLButtonElement>('[data-type-action="size-in"]')!.click();
    expect(onSize).toHaveBeenCalledWith('in');
    panel.querySelector<HTMLButtonElement>('[data-reader-theme="night"]')!.click();
    expect(onTheme).toHaveBeenCalledWith('night');
    const scroll = [...panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-type-choice')].find(
      (button) => button.getAttribute('aria-label') === '滚动',
    );
    scroll!.click();
    expect(onLayout).toHaveBeenCalledWith('scroll');
    expect(panel.querySelectorAll('.lightink-reader-type-glyph--spacing')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-type-glyph--measure')).toHaveLength(5);
    expect(panel.textContent).not.toContain('✓');
    expect(panel.getAttribute('aria-modal')).toBe('true');
  });

  it('does not put a status-bar toggle in typography — reader chrome owns the footer', () => {
    const panel = document.createElement('div');
    fillReaderTypographyPanel(
      panel,
      { ...DEFAULT_READER_TYPOGRAPHY },
      'white',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(panel.querySelector('[data-type-section="status-bar"]')).toBeNull();
    expect(panel.textContent).not.toContain('状态栏');
  });

  it('anchors a sheet under its toolbar button instead of the far edge', () => {
    const host = document.createElement('div');
    const panel = document.createElement('div');
    const anchor = document.createElement('button');
    host.append(anchor, panel);
    document.body.append(host);
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }) as DOMRect;
    anchor.getBoundingClientRect = () =>
      ({ left: 180, top: 8, width: 48, height: 28, right: 228, bottom: 36 }) as DOMRect;
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 320 });
    positionReaderChromePanel(panel, host, anchor);
    expect(panel.style.position).toBe('fixed');
    expect(panel.style.left).toBe('180px');
    expect(panel.style.top).toBe('44px');
    expect(panel.style.right).toBe('auto');
    expect(panel.classList.contains('lightink-reader-chrome-popover')).toBe(true);
    expect(panel.style.getPropertyValue('--lightink-reader-popover-arrow')).toBe('24px');
    host.remove();
  });

  it('pins a sidebar overlay to the visible pane instead of the tall book', () => {
    const overlay = document.createElement('div');
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 20, top: 40, width: 800, height: 600, right: 820, bottom: 640 }) as DOMRect,
    };
    pinFixedOverlay(overlay, pane, { innerWidth: 1000, innerHeight: 700 });
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.top).toBe('40px');
    expect(overlay.style.right).toBe('180px');
    expect(overlay.style.bottom).toBe('60px');
    unpinFixedOverlay(overlay);
    expect(overlay.style.position).toBe('');
  });
});
