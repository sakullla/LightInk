// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultComicPreferences } from '../comic-preferences.js';
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
  afterEach(() => {
    document.documentElement.removeAttribute('data-touch-primary');
    document.documentElement.removeAttribute('data-android');
  });

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

  it('keeps the full typography control set for flow books and unknown formats', () => {
    for (const formatKind of ['flow', undefined] as const) {
      const panel = document.createElement('div');
      fillReaderTypographyPanel(
        panel,
        DEFAULT_READER_TYPOGRAPHY,
        'white',
        defaultReaderChromePanelCopy(),
        vi.fn(),
        vi.fn(),
        vi.fn(),
        'paginated',
        vi.fn(),
        formatKind,
      );
      for (const kind of ['size', 'theme', 'font', 'layout', 'spacing', 'measure']) {
        expect(
          panel.querySelector(`[data-type-section="${kind}"]`),
          `${kind} for formatKind=${String(formatKind)}`,
        ).not.toBeNull();
      }
      expect(panel.querySelector('.lightink-reader-type-hero')).not.toBeNull();
      expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(4);
      expect(panel.querySelectorAll('.lightink-reader-type-slider')).toHaveLength(2);
    }
  });

  it('shows only theme and layout for pdf — flow-only controls are not rendered', () => {
    const panel = document.createElement('div');
    const onLayout = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'sepia',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      'paginated',
      onLayout,
      'pdf',
    );
    expect(panel.querySelector('[data-type-section="theme"]')).not.toBeNull();
    expect(panel.querySelector('[data-type-section="layout"]')).not.toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-theme-swatch')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-type-mode')).toHaveLength(2);
    for (const kind of ['size', 'font', 'spacing', 'measure']) {
      expect(panel.querySelector(`[data-type-section="${kind}"]`), kind).toBeNull();
    }
    expect(panel.querySelector('.lightink-reader-type-hero')).toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(0);
    expect(panel.querySelectorAll('.lightink-reader-type-slider')).toHaveLength(0);
    // Hidden items leave no disabled placeholders behind.
    expect(panel.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0);
    const scroll = [...panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-type-choice')].find(
      (button) => button.getAttribute('aria-label') === '滚动',
    );
    expect(scroll).toBeDefined();
    scroll!.click();
    expect(onLayout).toHaveBeenCalledWith('scroll');
  });

  it('maps comic typography onto the injected existing comic preferences only', () => {
    const panel = document.createElement('div');
    const onTypography = vi.fn();
    const onPreferences = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      onTypography,
      vi.fn(),
      vi.fn(),
      'paginated',
      vi.fn(),
      'comic',
      { preferences: defaultComicPreferences(), onPreferences },
    );
    for (const kind of ['size', 'font', 'spacing', 'measure']) {
      expect(panel.querySelector(`[data-type-section="${kind}"]`), kind).toBeNull();
    }
    expect(panel.querySelector('.lightink-reader-type-hero')).toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(0);
    expect(panel.querySelectorAll('.lightink-reader-type-slider')).toHaveLength(0);
    expect(panel.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0);
    const paged = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.getAttribute('aria-label') === '横向翻页' ||
        button.textContent?.includes('横向翻页') === true,
    );
    expect(paged).toBeDefined();
    paged!.click();
    expect(onPreferences).toHaveBeenCalledTimes(1);
    const patch = onPreferences.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      // Only existing comic preference keys — the sheet adds no new capability.
      expect(['mode', 'direction', 'spread', 'fitWidth']).toContain(key);
    }
    // No flow typography patches can originate from a comic panel.
    expect(onTypography).not.toHaveBeenCalled();
  });

  it('falls back to the full flow sheet when comic capabilities are not injected', () => {
    const panel = document.createElement('div');
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      'paginated',
      vi.fn(),
      'comic',
    );
    for (const kind of ['size', 'theme', 'font', 'layout', 'spacing', 'measure']) {
      expect(panel.querySelector(`[data-type-section="${kind}"]`), kind).not.toBeNull();
    }
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

  it('docks the overlay as a bottom sheet on a touch-primary document', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const overlay = document.createElement('div');
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 20, top: 40, width: 800, height: 600, right: 820, bottom: 640 }) as DOMRect,
    };
    pinFixedOverlay(overlay, pane, { innerWidth: 1000, innerHeight: 700 });
    expect(overlay.classList.contains('is-touch-sheet')).toBe(true);
    expect(overlay.style.left).toBe('0px');
    expect(overlay.style.bottom).toBe('0px');
    expect(overlay.style.top).toBe('auto');
    unpinFixedOverlay(overlay);
    expect(overlay.classList.contains('is-touch-sheet')).toBe(false);
    document.documentElement.removeAttribute('data-touch-primary');
  });
});
