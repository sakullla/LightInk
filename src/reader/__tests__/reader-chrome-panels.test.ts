// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHEET_DRAG_THRESHOLD_PX } from '../../ui/touch/sheet-drag.js';
import { createAnnotationSidebar } from '../annotation-sidebar.js';
import { defaultComicPreferences } from '../comic-preferences.js';
import { createReaderChrome } from '../reader-chrome.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';
import {
  adoptReaderOverlayTheme,
  defaultReaderChromePanelCopy,
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  mountReaderOverlay,
  pinFixedOverlay,
  positionReaderChromePanel,
  readerChromeFooterInset,
  unpinFixedOverlay,
} from '../reader-chrome-panels.js';
import { createSearchSheet } from '../search-sheet.js';

const THUMB_ACTIONS = ['toc', 'typography', 'search', 'annotations'] as const;
const MIN_HIT_PX = 48;
const MIN_GAP_PX = 8;

function readerCss(): string {
  return readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
}

function panelsCss(): string {
  return readFileSync(resolve(process.cwd(), 'src/reader/reader-chrome-panels.css'), 'utf-8');
}

function findLabeledButton(panel: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...panel.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) =>
      button.getAttribute('aria-label') === label || button.textContent?.includes(label) === true,
  );
}

function stubRect(
  el: HTMLElement,
  box: { width: number; height: number; top?: number; left?: number },
): void {
  const top = box.top ?? 0;
  const left = box.left ?? 0;
  el.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      top,
      left,
      width: box.width,
      height: box.height,
      right: left + box.width,
      bottom: top + box.height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

function actionButton(root: ParentNode, action: string): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>('[data-reader-chrome-action]')].find(
    (button) => button.dataset.readerChromeAction === action,
  );
  expect(match, `missing chrome action "${action}"`).toBeTruthy();
  return match!;
}

const SHEET_HANDLE_SELECTOR =
  '.lightink-reader-sheet-handle, .lightink-reader-search-sheet-handle, .lightink-reader-chrome-sheet-handle, [data-sheet-handle]';

function querySheetHandle(root: HTMLElement): HTMLElement {
  const handle = root.querySelector<HTMLElement>(SHEET_HANDLE_SELECTOR);
  expect(handle, 'sheet must expose a real drag handle node').not.toBeNull();
  return handle!;
}

function expectPointerCapableHandle(handle: HTMLElement, sheetRoot: HTMLElement): void {
  expect(handle, 'handle must be a child node, not the sheet ::after').not.toBe(sheetRoot);
  expect(sheetRoot.contains(handle)).toBe(true);
  expect(handle.hidden).toBe(false);
  const inline = handle.style.pointerEvents;
  if (inline) {
    expect(inline).not.toBe('none');
  }
  const computed = getComputedStyle(handle).pointerEvents;
  if (computed !== '' && computed !== 'auto') {
    expect(computed).not.toBe('none');
  }
}

function pointerEvent(
  type: string,
  point: { clientX: number; clientY: number },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    pointerId: 1,
    pointerType: 'touch',
    clientX: point.clientX,
    clientY: point.clientY,
  });
}

function dragHandlePastThreshold(handle: HTMLElement): void {
  if (typeof handle.setPointerCapture !== 'function') {
    Object.defineProperty(handle, 'setPointerCapture', {
      value: () => undefined,
      configurable: true,
    });
  }
  if (typeof handle.releasePointerCapture !== 'function') {
    Object.defineProperty(handle, 'releasePointerCapture', {
      value: () => undefined,
      configurable: true,
    });
  }
  const startY = 10;
  const endY = startY + SHEET_DRAG_THRESHOLD_PX;
  handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 20, clientY: startY }));
  handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: endY }));
  handle.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: endY }));
}

function declaredHitPx(el: HTMLElement): number {
  const computed = getComputedStyle(el);
  for (const raw of [el.style.minHeight, el.style.minWidth, computed.minHeight, computed.minWidth]) {
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

describe('reader chrome panels', () => {
  afterEach(() => {
    document.body.replaceChildren();
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
    const paged = findLabeledButton(panel, '横向翻页');
    const strip = findLabeledButton(panel, '连续条');
    expect(paged).toBeDefined();
    expect(strip).toBeDefined();
    paged!.click();
    strip!.click();
    findLabeledButton(panel, '从右到左')!.click();
    findLabeledButton(panel, '单页')!.click();
    findLabeledButton(panel, '适合屏幕')!.click();
    findLabeledButton(panel, '适合宽度')!.click();
    findLabeledButton(panel, '适合高度')!.click();
    findLabeledButton(panel, '原图')!.click();
    findLabeledButton(panel, '裁白边')!.click();
    findLabeledButton(panel, '保留边距')!.click();
    expect(onPreferences.mock.calls.map((call) => call[0])).toEqual([
      { mode: 'paged' },
      { mode: 'strip' },
      { direction: 'rtl' },
      { spread: 'single' },
      { fit: 'screen' },
      { fit: 'width' },
      { fit: 'height' },
      { fit: 'original' },
      { cropMargins: true },
      { cropMargins: false },
    ]);
    for (const patch of onPreferences.mock.calls.map((call) => call[0] as Record<string, unknown>)) {
      for (const key of Object.keys(patch)) {
        expect(['mode', 'direction', 'spread', 'fit', 'cropMargins']).toContain(key);
      }
      expect(patch).not.toHaveProperty('fitWidth');
      expect(patch.mode).not.toBe('vertical');
    }
    // No flow typography patches can originate from a comic panel.
    expect(onTypography).not.toHaveBeenCalled();
    expect(panel.dataset.comicReader).toBeUndefined();
    expect(panel.dataset.comicCanvas).toBeUndefined();
  });

  it('still maps v2 host copy onto strip and the four fit values', () => {
    const panel = document.createElement('div');
    const onPreferences = vi.fn();
    const copy = defaultReaderChromePanelCopy();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      {
        ...copy,
        comic: {
          direction: '方向',
          spread: '页面',
          vertical: '竖向滚动',
          paged: '横向翻页',
          leftToRight: '从左到右',
          rightToLeft: '从右到左',
          singlePage: '单页',
          doublePage: '双页',
          fitWidth: '适合宽度',
        },
      },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      'paginated',
      vi.fn(),
      'comic',
      { preferences: defaultComicPreferences(), onPreferences },
    );
    findLabeledButton(panel, '竖向滚动')!.click();
    expect(onPreferences).toHaveBeenCalledWith({ mode: 'strip' });
    expect(panel.querySelectorAll('[data-type-section="comic-fit"] button')).toHaveLength(4);
    findLabeledButton(panel, '适合宽度')!.click();
    expect(onPreferences).toHaveBeenLastCalledWith({ fit: 'width' });
    for (const patch of onPreferences.mock.calls.map((call) => call[0] as Record<string, unknown>)) {
      for (const key of Object.keys(patch)) {
        expect(['mode', 'direction', 'spread', 'fit', 'cropMargins']).toContain(key);
      }
    }
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

  it('does not paint a comic near-black canvas on flow, pdf, or uninjected comic sheets', () => {
    for (const formatKind of ['flow', 'pdf', 'comic', undefined] as const) {
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
      expect(panel.dataset.comicReader, String(formatKind)).toBeUndefined();
      expect(panel.dataset.comicCanvas, String(formatKind)).toBeUndefined();
      expect(panel.getAttribute('data-comic-reader')).toBeNull();
      expect(panel.style.getPropertyValue('--lightink-comic-canvas')).toBe('');
      expect(panel.querySelector('[data-comic-reader], [data-comic-canvas]')).toBeNull();
      expect(panel.querySelector('[data-type-section="comic-direction"]')).toBeNull();
      expect(panel.querySelector('[data-type-section="comic-spread"]')).toBeNull();
      expect(panel.querySelector('[data-type-section="comic-fit"]')).toBeNull();
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
    expect(overlay.style.left).toBe('20px');
    expect(overlay.style.right).toBe('180px');
    expect(overlay.style.bottom).toBe('60px');
    expect(overlay.style.top).toBe('auto');
    unpinFixedOverlay(overlay);
    expect(overlay.classList.contains('is-touch-sheet')).toBe(false);
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('lifts the touch sheet above the reader footer instead of anchoring under the thumb button', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const footer = document.createElement('div');
    footer.className = 'lightink-reader-chrome-footer';
    footer.getBoundingClientRect = () =>
      ({ left: 0, top: 700, width: 390, height: 72, right: 390, bottom: 772 }) as DOMRect;
    document.body.append(footer);
    const panel = document.createElement('div');
    panel.className = 'lightink-reader-chrome-popover';
    const host = document.createElement('div');
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 390, height: 772, right: 390, bottom: 772 }) as DOMRect;
    const anchor = document.createElement('button');
    expect(readerChromeFooterInset(document)).toBe(72);
    positionReaderChromePanel(panel, host, anchor);
    expect(panel.classList.contains('is-touch-sheet')).toBe(true);
    expect(panel.classList.contains('lightink-reader-chrome-popover')).toBe(false);
    expect(panel.style.bottom).toBe('72px');
    expect(panel.style.top).toBe('auto');
    footer.remove();
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('copies reader tokens onto a body-mounted overlay so it does not use editor paper', () => {
    const host = document.createElement('div');
    host.dataset.readerTheme = 'white';
    host.style.setProperty('--lightink-bg-elevated', 'rgb(246, 246, 246)');
    host.style.setProperty('--lightink-fg', 'rgb(26, 26, 26)');
    document.body.style.setProperty('--lightink-bg-elevated', 'rgb(251, 240, 217)');
    document.body.append(host);
    const overlay = document.createElement('div');
    adoptReaderOverlayTheme(overlay, host);
    mountReaderOverlay(overlay, host);
    expect(overlay.style.getPropertyValue('--lightink-bg-elevated')).toBe('rgb(246, 246, 246)');
    expect(overlay.style.getPropertyValue('--lightink-accent')).toBe('rgb(26, 26, 26)');
    expect(overlay.style.getPropertyValue('--lightink-comic-canvas')).toBe('');
    expect(overlay.dataset.readerTheme).toBe('white');
    expect(overlay.dataset.comicReader).toBeUndefined();
    expect(overlay.dataset.comicCanvas).toBeUndefined();
    expect(overlay.parentElement).toBe(document.body);
    overlay.remove();
    host.remove();
    document.body.style.removeProperty('--lightink-bg-elevated');
  });

  it('reveals footer four tools and top-bar 回书架 by tap, then docks the sheet above the footer', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    host.append(page);
    document.body.append(host);
    const viewportHeight = window.innerHeight;
    stubRect(host, { width: 390, height: viewportHeight });
    stubRect(page, { width: 390, height: viewportHeight });
    const deps = {
      returnToShelf: vi.fn(),
      openOutline: vi.fn(),
      openTypography: vi.fn(),
      openSearch: vi.fn(),
      toggleSidebar: vi.fn(),
    };
    const chrome = createReaderChrome(host, { touchMode: true, ...deps });

    expect(chrome.isRevealed()).toBe(false);
    expect(host.querySelector('#lightink-toolbar')).toBeNull();
    expect(host.querySelector('#lightink-tabbar')).toBeNull();
    expect(host.querySelector('#lightink-chrome-host')).toBeNull();
    const before = page.getBoundingClientRect();

    page.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 180, clientY: 280 }),
    );
    expect(chrome.isRevealed()).toBe(true);
    expect(chrome.bar.contains(actionButton(host, 'backToShelf'))).toBe(true);
    expect(chrome.footer.contains(actionButton(host, 'backToShelf'))).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.footer.contains(actionButton(host, action)), action).toBe(true);
      expect(chrome.bar.contains(actionButton(host, action)), action).toBe(false);
    }
    const shown = page.getBoundingClientRect();
    expect(shown.top).toBe(before.top);
    expect(shown.height).toBe(before.height);

    chrome.footer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: viewportHeight - 72,
        width: 390,
        height: 72,
        right: 390,
        bottom: viewportHeight,
      }) as DOMRect;
    const panel = document.createElement('div');
    panel.className = 'lightink-reader-chrome-panel';
    positionReaderChromePanel(panel, host, actionButton(host, 'toc'));
    expect(panel.classList.contains('is-touch-sheet')).toBe(true);
    expect(panel.style.bottom).toBe('72px');
    expect(panel.style.top).toBe('auto');

    page.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 180, clientY: 280 }),
    );
    expect(chrome.isRevealed()).toBe(false);
    const hidden = page.getBoundingClientRect();
    expect(hidden.top).toBe(before.top);
    expect(hidden.height).toBe(before.height);
    expect(deps.returnToShelf).not.toHaveBeenCalled();
    chrome.destroy();
  });

  it('uses the same footer-above sheet for flow and comic hosts', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const footer = document.createElement('div');
    footer.className = 'lightink-reader-chrome-footer';
    footer.getBoundingClientRect = () =>
      ({ left: 0, top: 700, width: 390, height: 80, right: 390, bottom: 780 }) as DOMRect;
    document.body.append(footer);

    for (const kind of ['flow', 'comic'] as const) {
      const host = document.createElement('div');
      host.className = 'lightink-reader';
      if (kind === 'comic') {
        host.dataset.comicReader = 'true';
      }
      host.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 390, height: 780, right: 390, bottom: 780 }) as DOMRect;
      const panel = document.createElement('div');
      panel.className = 'lightink-reader-chrome-panel';
      const overlay = document.createElement('div');
      positionReaderChromePanel(panel, host, document.createElement('button'));
      pinFixedOverlay(overlay, host, { innerWidth: 390, innerHeight: 780 });
      expect(panel.classList.contains('is-touch-sheet'), kind).toBe(true);
      expect(overlay.classList.contains('is-touch-sheet'), kind).toBe(true);
      expect(panel.style.bottom, kind).toBe('80px');
      expect(overlay.style.bottom, kind).toBe('80px');
      expect(panel.style.top, kind).toBe('auto');
      expect(overlay.style.top, kind).toBe('auto');
    }
  });

  it('keeps comic progress-dock suppression from hiding the shared footer tools', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    document.body.append(host);
    stubRect(host, { width: 390, height: window.innerHeight });
    const chrome = createReaderChrome(host, {
      touchMode: true,
      suppressProgressDock: () => true,
      returnToShelf: vi.fn(),
      openOutline: vi.fn(),
      openTypography: vi.fn(),
      openSearch: vi.fn(),
      toggleSidebar: vi.fn(),
    });
    chrome.reveal();
    expect(chrome.footer.hidden).toBe(false);
    for (const action of THUMB_ACTIONS) {
      expect(chrome.footer.contains(actionButton(host, action)), action).toBe(true);
    }
    chrome.footer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: window.innerHeight - 64,
        width: 390,
        height: 64,
        right: 390,
        bottom: window.innerHeight,
      }) as DOMRect;
    const panel = document.createElement('div');
    positionReaderChromePanel(panel, host, actionButton(host, 'typography'));
    expect(panel.classList.contains('is-touch-sheet')).toBe(true);
    expect(panel.style.bottom).toBe('64px');
    chrome.destroy();
  });

  it('sizes back-to-shelf and the four footer tools at least 48×48 on touch', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action\s*\{[^}]*min-(?:width|height):\s*48px[^}]*min-(?:width|height):\s*48px/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-action--(?:toc|typography|search|annotations)[\s\S]*?\{[^}]*min-(?:width|height):\s*48px/,
    );
    expect(css).not.toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action\s*\{[^}]*min-height:\s*44px/,
    );

    document.documentElement.setAttribute('data-touch-primary', '');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const host = document.createElement('div');
    document.body.append(host);
    const chrome = createReaderChrome(host, { touchMode: true, returnToShelf: vi.fn() });
    chrome.reveal();
    for (const action of ['backToShelf', ...THUMB_ACTIONS]) {
      const button = actionButton(host, action);
      const size = declaredHitPx(button);
      if (size > 0) {
        expect(size, `${action} hit target`).toBeGreaterThanOrEqual(MIN_HIT_PX);
      }
    }
    chrome.destroy();
    style.remove();
  });

  it('keeps at least 8px between the four footer tools', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-tools\s*\{[^}]*gap:\s*(?:8px|0\.5rem|[1-9]\d?px)/,
    );
    const toolsRule = css.match(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-tools\s*\{[^}]*\}/,
    )?.[0];
    expect(toolsRule).toBeTruthy();
    const gap = toolsRule!.match(/gap:\s*([^;]+)/)?.[1]?.trim();
    expect(gap, 'footer tools gap').toBeTruthy();
    const px = gap!.endsWith('rem') ? parseFloat(gap!) * 16 : parseFloat(gap!);
    expect(px).toBeGreaterThanOrEqual(MIN_GAP_PX);
  });

  it('consumes safe-area and keyboard inset on the touch sheet instead of inventing a new stack', () => {
    const sheet = panelsCss();
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*--lightink-safe-top/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*padding-bottom:[^;]*--lightink-safe-bottom/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-search-sheet\s*\{[^}]*padding-bottom:\s*calc\(12px \+ var\(--lightink-safe-bottom/,
    );
    expect(readerCss()).toContain('--lightink-keyboard-inset');
    expect(sheet + readerCss()).toMatch(/--lightink-keyboard-inset/);
  });

  it('gives annotation, search, catalog, and typography sheets a real pointer handle', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    host.append(page);
    document.body.append(host);
    stubRect(host, { width: 390, height: 700 });

    const catalog = document.createElement('div');
    catalog.className = 'lightink-reader-chrome-panel';
    fillReaderTocPanel(
      catalog,
      [{ level: 1, text: '第一章', anchor: 0, chapter: 0 }],
      defaultReaderChromePanelCopy(),
      { chapter: 0 },
      vi.fn(),
    );
    host.append(catalog);
    positionReaderChromePanel(catalog, host, document.createElement('button'));

    const typography = document.createElement('div');
    typography.className = 'lightink-reader-chrome-panel';
    fillReaderTypographyPanel(
      typography,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    host.append(typography);
    positionReaderChromePanel(typography, host, document.createElement('button'));

    const annotation = createAnnotationSidebar({
      t: (key) => key,
      onJump: vi.fn(),
      onClose: vi.fn(),
    });
    host.append(annotation.element);
    pinFixedOverlay(annotation.element, host, { innerWidth: 390, innerHeight: 700 });

    const search = createSearchSheet({
      t: (key) => key,
      onQuery: vi.fn(),
      onClose: vi.fn(),
    });
    host.append(search.element);
    search.open('keyword');

    for (const sheet of [catalog, typography, annotation.element, search.element]) {
      expect(sheet.classList.contains('is-touch-sheet'), sheet.className).toBe(true);
      const handle = querySheetHandle(sheet);
      expectPointerCapableHandle(handle, sheet);
    }

    expect(search.element.querySelector('.lightink-reader-search-sheet-close')).not.toBeNull();
    expect(annotation.element.querySelector('.lightink-reader-sidebar-close')).not.toBeNull();
    search.destroy();
    annotation.destroy();
  });

  it('closes the search sheet from a downward handle drag and still honors the close button', () => {
    const onClose = vi.fn();
    const sheet = createSearchSheet({
      t: (key) => key,
      onQuery: vi.fn(),
      onClose,
    });
    document.body.append(sheet.element);
    sheet.open('keyword');
    const handle = querySheetHandle(sheet.element);
    expectPointerCapableHandle(handle, sheet.element);

    dragHandlePastThreshold(handle);
    expect(sheet.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    sheet.open('keyword');
    expect(sheet.isOpen()).toBe(true);
    sheet.element.querySelector<HTMLButtonElement>('.lightink-reader-search-sheet-close')!.click();
    expect(sheet.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
    sheet.destroy();
  });

  it('closes annotation, catalog, and typography sheets from a downward handle drag', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    host.append(page);
    document.body.append(host);
    stubRect(host, { width: 390, height: 700 });

    const onAnnotationClose = vi.fn();
    const annotation = createAnnotationSidebar({
      t: (key) => key,
      onJump: vi.fn(),
      onClose: onAnnotationClose,
    });
    host.append(annotation.element);
    pinFixedOverlay(annotation.element, host, { innerWidth: 390, innerHeight: 700 });
    dragHandlePastThreshold(querySheetHandle(annotation.element));
    expect(onAnnotationClose).toHaveBeenCalledTimes(1);
    annotation.element.querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')!.click();
    expect(onAnnotationClose).toHaveBeenCalledTimes(2);

    const catalog = document.createElement('div');
    catalog.className = 'lightink-reader-chrome-panel';
    fillReaderTocPanel(
      catalog,
      [{ level: 1, text: '第一章', anchor: 0, chapter: 0 }],
      defaultReaderChromePanelCopy(),
      { chapter: 0 },
      vi.fn(),
    );
    host.append(catalog);
    positionReaderChromePanel(catalog, host, document.createElement('button'));
    dragHandlePastThreshold(querySheetHandle(catalog));
    expect(catalog.hidden).toBe(true);

    const typography = document.createElement('div');
    typography.className = 'lightink-reader-chrome-panel';
    fillReaderTypographyPanel(
      typography,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    host.append(typography);
    positionReaderChromePanel(typography, host, document.createElement('button'));
    dragHandlePastThreshold(querySheetHandle(typography));
    expect(typography.hidden).toBe(true);

    annotation.destroy();
  });
});
