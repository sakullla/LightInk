// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHEET_DRAG_THRESHOLD_PX } from '../../ui/touch/sheet-drag.js';
import { createAnnotationPanel } from '../annotation-panel.js';
import { defaultComicPreferences } from '../comic-preferences.js';
import { createReaderChrome } from '../reader-chrome.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';
import {
  adoptReaderOverlayTheme,
  defaultReaderChromePanelCopy,
  activateReaderTocPanel,
  fillReaderTocPanel,
  fillReaderTypographyPanel,
  filterOutlineItems,
  mountReaderOverlay,
  pinFixedOverlay,
  positionReaderChromePanel,
  READER_TOC_BATCH_THRESHOLD,
  READER_TOC_RENDER_BATCH,
  READER_TOC_SEARCH_DEBOUNCE_MS,
  readerChromeFooterInset,
  unpinFixedOverlay,
} from '../reader-chrome-panels.js';
import type { OutlineItem } from '../../outline/outline-model.js';

const THUMB_ACTIONS = ['toc', 'typography', 'search'] as const;
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

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];

  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  trigger(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

describe('reader chrome panels', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute('data-touch-primary');
    document.documentElement.removeAttribute('data-android');
    document.documentElement.removeAttribute('data-keyboard');
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
    expect(panel.querySelector('.lightink-reader-toc-search')).not.toBeNull();
    expect(items).toHaveLength(2);
    expect(items[1]!.classList.contains('is-current')).toBe(true);
    expect(items[1]!.dataset.outlineLevel).toBe('2');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    // 标题行右侧显示章节总数（{n} 占位替换）。
    expect(panel.querySelector('.lightink-reader-toc-head')).not.toBeNull();
    expect(panel.querySelector('.lightink-reader-toc-count')?.textContent).toBe('2 章');
    items[0]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('filters the contents list and keeps ancestor headings for a nested hit', () => {
    expect(
      filterOutlineItems(
        [
          { level: 1, text: '开篇', anchor: 0, chapter: 0 },
          { level: 2, text: '白月光', anchor: 1, chapter: 1 },
          { level: 1, text: '终章', anchor: 2, chapter: 2 },
        ],
        '白月',
      ),
    ).toEqual([
      { level: 1, text: '开篇', anchor: 0, chapter: 0 },
      { level: 2, text: '白月光', anchor: 1, chapter: 1 },
    ]);

    const panel = document.createElement('div');
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 2, text: '小节', anchor: 1, chapter: 1 },
        { level: 1, text: '终章', anchor: 2, chapter: 2 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 1 },
      vi.fn(),
    );
    const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
    search.value = '终';
    // 输入经 IME 安全防抖，推进防抖窗口后应用过滤。
    vi.useFakeTimers();
    try {
      search.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS);
    } finally {
      vi.useRealTimers();
    }
    const items = panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toBe('终章');
  });

  it('clears search on Escape, then dismisses the contents sheet', () => {
    const panel = document.createElement('div');
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 1, text: '终章', anchor: 1, chapter: 1 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 0 },
      onSelect,
      onDismiss,
    );
    const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
    search.value = '终';
    vi.useFakeTimers();
    try {
      search.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS);
      expect(panel.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(1);

      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(search.value).toBe('');
      expect(panel.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(2);
      expect(onDismiss).not.toHaveBeenCalled();

      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      search.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the active contents row with arrows and selects it with Enter', () => {
    const panel = document.createElement('div');
    const onSelect = vi.fn();
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 1, text: '终章', anchor: 1, chapter: 1 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 0 },
      onSelect,
    );
    const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
    const first = panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item')[0]!;
    expect(first.classList.contains('is-active')).toBe(true);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    const second = panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item')[1]!;
    expect(second.classList.contains('is-active')).toBe(true);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSelect).toHaveBeenCalledWith({ level: 1, text: '终章', anchor: 1, chapter: 1 });
  });

  it('does not steal IME composition keys in contents search', () => {
    const panel = document.createElement('div');
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 1, text: '终章', anchor: 1, chapter: 1 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 0 },
      onSelect,
      onDismiss,
    );
    const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
    const composing = { isComposing: true, bubbles: true, cancelable: true } as const;
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ...composing }));
    expect(panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item')[0]!.classList.contains('is-active')).toBe(
      true,
    );
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ...composing }));
    expect(onSelect).not.toHaveBeenCalled();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ...composing }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('focuses the contents search after the sheet is shown', () => {
    const panel = document.createElement('div');
    document.body.append(panel);
    fillReaderTocPanel(
      panel,
      [
        { level: 1, text: '第一章', anchor: 0, chapter: 0 },
        { level: 1, text: '终章', anchor: 1, chapter: 1 },
      ],
      defaultReaderChromePanelCopy(),
      { chapter: 1 },
      vi.fn(),
    );
    activateReaderTocPanel(panel);
    expect(panel.querySelector('.lightink-reader-toc-search')).toBe(document.activeElement);
  });

  it('scrolls the deepest current contents row into view when the panel opens', () => {
    const panel = document.createElement('div');
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push(this.textContent ?? '');
    };
    try {
      fillReaderTocPanel(
        panel,
        [
          { level: 1, text: '第一章', anchor: 0, chapter: 1 },
          { level: 2, text: '小节', anchor: 1, chapter: 1 },
        ],
        defaultReaderChromePanelCopy(),
        { chapter: 1 },
        vi.fn(),
      );
      expect(scrolled[scrolled.length - 1]).toBe('小节');
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('keeps the desktop toc item rule multi-line and scopes compact single-line ellipsis to the touch sheet', () => {
    const sheet = panelsCss();
    // 桌面浮层排版不变：基础规则不带单行省略。
    const baseRule = sheet.match(/\.lightink-reader-toc-item\s*\{([^}]*)\}/);
    expect(baseRule, 'base .lightink-reader-toc-item rule').toBeTruthy();
    expect(baseRule![1]).not.toMatch(/white-space:\s*nowrap/);
    expect(baseRule![1]).not.toMatch(/text-overflow:\s*ellipsis/);
    // 列表是纵向 flex：行必须禁止收缩，否则整卷章节被压叠成一条线。
    expect(baseRule![1]).toMatch(/flex:\s*0 0 auto/);
    // 触屏 sheet：紧凑单行省略 + 列表保底高度，层级缩进变量保留。
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet \.lightink-reader-toc-item\s*\{[^}]*white-space:\s*nowrap/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet \.lightink-reader-toc-item\s*\{[^}]*overflow:\s*hidden/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet \.lightink-reader-toc-item\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet \.lightink-reader-toc-item\s*\{[^}]*--lightink-reader-toc-level/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet \.lightink-reader-toc-list\s*\{[^}]*min-height:\s*9\.5rem/,
    );
    // pointer:coarse 下 44px 触控目标规则保留。
    expect(sheet).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?\.lightink-reader-toc-item[^}]*min-height:\s*44px/);
  });

  it('debounces contents search input so steady typing repaints once per pause', () => {
    vi.useFakeTimers();
    try {
      const panel = document.createElement('div');
      fillReaderTocPanel(
        panel,
        [
          { level: 1, text: '第一章', anchor: 0, chapter: 0 },
          { level: 1, text: '第二节', anchor: 1, chapter: 1 },
          { level: 1, text: '终章', anchor: 2, chapter: 2 },
        ],
        defaultReaderChromePanelCopy(),
        { chapter: 0 },
        vi.fn(),
      );
      const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
      const nav = panel.querySelector<HTMLElement>('.lightink-reader-toc-list')!;
      // fillReaderTocPanel 的首批渲染已完成；此后每次重建都会 replaceChildren。
      const replaceSpy = vi.spyOn(nav, 'replaceChildren');
      search.value = '第';
      search.dispatchEvent(new Event('input'));
      search.value = '第二';
      search.dispatchEvent(new Event('input'));
      // 防抖窗口内：不逐键重建。
      expect(replaceSpy).not.toHaveBeenCalled();
      expect(nav.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(3);
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS - 1);
      expect(replaceSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      // 停顿后只按最后一个查询词重建一次。
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      const items = nav.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0]!.textContent).toBe('第二节');
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS * 2);
      expect(replaceSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending search debounce when Escape clears the box', () => {
    vi.useFakeTimers();
    try {
      const panel = document.createElement('div');
      fillReaderTocPanel(
        panel,
        [
          { level: 1, text: '第一章', anchor: 0, chapter: 0 },
          { level: 1, text: '终章', anchor: 1, chapter: 1 },
        ],
        defaultReaderChromePanelCopy(),
        { chapter: 0 },
        vi.fn(),
      );
      const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
      search.value = '终';
      search.dispatchEvent(new Event('input'));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      expect(panel.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(2);
      // 挂起的防抖回调不得用旧查询词覆盖 Escape 的清空结果。
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS * 2);
      expect(panel.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not repaint contents search while IME composition is in progress', () => {
    vi.useFakeTimers();
    try {
      const panel = document.createElement('div');
      fillReaderTocPanel(
        panel,
        [
          { level: 1, text: '第一章', anchor: 0, chapter: 0 },
          { level: 1, text: '终章', anchor: 1, chapter: 1 },
        ],
        defaultReaderChromePanelCopy(),
        { chapter: 0 },
        vi.fn(),
      );
      const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
      search.dispatchEvent(new CompositionEvent('compositionstart'));
      search.value = '终';
      search.dispatchEvent(new InputEvent('input', { isComposing: true }));
      vi.advanceTimersByTime(READER_TOC_SEARCH_DEBOUNCE_MS * 2);
      expect(panel.querySelectorAll('.lightink-reader-toc-item')).toHaveLength(2);
      search.dispatchEvent(new CompositionEvent('compositionend'));
      // compositionend 立即应用，不等防抖。
      const items = panel.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item');
      expect(items).toHaveLength(1);
      expect(items[0]!.textContent).toBe('终章');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders long contents lists in batches and appends more as the sentinel intersects', () => {
    const observers: FakeIntersectionObserver[] = [];
    const originalObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    FakeIntersectionObserver.instances = observers;
    try {
      const many: OutlineItem[] = Array.from({ length: 600 }, (_, index) => ({
        level: 1,
        text: `第${index + 1}章`,
        anchor: index,
        chapter: index,
      }));
      const panel = document.createElement('div');
      fillReaderTocPanel(panel, many, defaultReaderChromePanelCopy(), { chapter: 0 }, vi.fn());
      const list = panel.querySelector('.lightink-reader-toc-list')!;
      const count = () => list.querySelectorAll('.lightink-reader-toc-item').length;
      // 超阈值：首批只渲染一部分，底部挂 IntersectionObserver 哨兵。
      expect(count()).toBe(READER_TOC_RENDER_BATCH);
      expect(count()).toBeLessThan(many.length);
      const sentinel = list.querySelector('.lightink-reader-toc-load-more');
      expect(sentinel).not.toBeNull();
      expect(sentinel!.getAttribute('aria-hidden')).toBe('true');
      expect(observers).toHaveLength(1);
      observers[0]!.trigger(true);
      expect(count()).toBe(READER_TOC_RENDER_BATCH * 2);
      observers[0]!.trigger(true);
      expect(count()).toBe(many.length);
      expect(list.querySelector('.lightink-reader-toc-load-more')).toBeNull();
      // 分批渲染保留 aria/is-current 标记。
      const first = list.querySelector<HTMLButtonElement>('.lightink-reader-toc-item')!;
      expect(first.classList.contains('is-current')).toBe(true);
      expect(first.getAttribute('role')).toBe('option');

      // 未超阈值：一次渲染全部，不挂哨兵与观察器。
      const small: OutlineItem[] = Array.from(
        { length: READER_TOC_BATCH_THRESHOLD },
        (_, index) => ({ level: 1, text: `小${index}`, anchor: index, chapter: index }),
      );
      const smallPanel = document.createElement('div');
      fillReaderTocPanel(smallPanel, small, defaultReaderChromePanelCopy(), { chapter: 0 }, vi.fn());
      expect(
        smallPanel.querySelectorAll('.lightink-reader-toc-item'),
      ).toHaveLength(READER_TOC_BATCH_THRESHOLD);
      expect(smallPanel.querySelector('.lightink-reader-toc-load-more')).toBeNull();
      expect(observers).toHaveLength(1);
    } finally {
      globalThis.IntersectionObserver = originalObserver;
    }
  });

  it('paints the first batches up to the current chapter so long lists highlight and scroll to it', () => {
    const observers: FakeIntersectionObserver[] = [];
    const originalObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    FakeIntersectionObserver.instances = observers;
    const scrolled: string[] = [];
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push(this.textContent ?? '');
    };
    try {
      // 当前章（索引 550）在首批 200 行之外：首批必须覆盖到它。
      const many: OutlineItem[] = Array.from({ length: 900 }, (_, index) => ({
        level: 1,
        text: `第${index + 1}章`,
        anchor: index,
        chapter: index,
      }));
      const panel = document.createElement('div');
      fillReaderTocPanel(panel, many, defaultReaderChromePanelCopy(), { chapter: 550 }, vi.fn());
      const list = panel.querySelector('.lightink-reader-toc-list')!;
      const count = () => list.querySelectorAll('.lightink-reader-toc-item').length;
      // 首批渲染足够批次覆盖当前章（3 批 = 600 行），其余仍靠哨兵滚动追加。
      expect(count()).toBe(READER_TOC_RENDER_BATCH * 3);
      expect(count()).toBeLessThan(many.length);
      expect(list.querySelector('.lightink-reader-toc-load-more')).not.toBeNull();

      const currentRow = list.querySelector<HTMLButtonElement>(
        '.lightink-reader-toc-item.is-current',
      );
      expect(currentRow).not.toBeNull();
      expect(currentRow!.textContent).toBe('第551章');
      expect(currentRow!.getAttribute('aria-current')).toBe('location');
      // setActive 指向当前章而不是被钳制到首批最后一行。
      expect(currentRow!.classList.contains('is-active')).toBe(true);
      expect(currentRow!.getAttribute('aria-selected')).toBe('true');
      const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')!;
      expect(search.getAttribute('aria-activedescendant')).toBe(currentRow!.id);
      const rows = list.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item');
      expect(rows[READER_TOC_RENDER_BATCH - 1]!.classList.contains('is-active')).toBe(false);

      // 打开面板时滚动定位落在当前章行上。
      expect(scrolled[scrolled.length - 1]).toBe('第551章');
      activateReaderTocPanel(panel);
      expect(scrolled[scrolled.length - 1]).toBe('第551章');

      // 滚动追加语义保持：哨兵相交继续追加剩余批次。
      expect(observers).toHaveLength(1);
      observers[0]!.trigger(true);
      expect(count()).toBe(READER_TOC_RENDER_BATCH * 4);
      observers[0]!.trigger(true);
      observers[0]!.trigger(true);
      expect(count()).toBe(many.length);
      expect(list.querySelector('.lightink-reader-toc-load-more')).toBeNull();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      globalThis.IntersectionObserver = originalObserver;
    }
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
    for (const kind of ['size', 'theme', 'font', 'layout', 'spacing', 'measure']) {
      const label = panel
        .querySelector(`[data-type-section="${kind}"]`)!
        .querySelector('.lightink-reader-type-label');
      expect(label, kind).not.toBeNull();
      expect(label!.classList.contains('lightink-reader-type-label--hidden'), kind).toBe(true);
    }
    expect(panel.querySelectorAll('.lightink-reader-theme-swatch')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-theme-page')).toHaveLength(4);
    expect(panel.querySelector('.lightink-reader-theme-page')?.querySelectorAll('i')).toHaveLength(3);
    expect(panel.querySelector('.lightink-reader-theme-swatch-name')?.textContent).toBe('白纸');
    expect(panel.querySelector('.lightink-reader-type-preview')).not.toBeNull();
    expect(panel.querySelector('.lightink-reader-type-hero-sample')?.textContent).toBe(
      '春江潮水连海平，海上明月共潮生。',
    );
    expect(panel.querySelector('.lightink-reader-type-step-mark')?.textContent).toBe('100%');
    expect(panel.querySelector('.lightink-reader-type-size-track')).not.toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-type-font-glyph')).toHaveLength(4);
    expect(panel.querySelector('.lightink-reader-type-font-glyph')?.textContent).toBe('汉');
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

  it('lets the spacing and measure tracks commit by dragging, not only tapping ticks', () => {
    const panel = document.createElement('div');
    const onTypography = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      onTypography,
      vi.fn(),
      vi.fn(),
    );
    const track = panel.querySelector<HTMLElement>('[data-type-section="spacing"] .lightink-reader-type-track')!;
    expect(track.getAttribute('role')).toBe('group');
    stubRect(track, { width: 200, height: 28, top: 0, left: 0 });
    track.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 14 }));
    track.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 14 }));
    track.dispatchEvent(pointerEvent('pointerup', { clientX: 10, clientY: 14 }));
    expect(onTypography).toHaveBeenCalledWith({ lineHeight: 1.5 });
  });

  it('lets the size track commit a font scale step by dragging', () => {
    const panel = document.createElement('div');
    const onTypography = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      onTypography,
      vi.fn(),
      vi.fn(),
    );
    const track = panel.querySelector<HTMLElement>('.lightink-reader-type-size-track')!;
    stubRect(track, { width: 240, height: 28, top: 0, left: 0 });
    track.dispatchEvent(pointerEvent('pointerdown', { clientX: 8, clientY: 14 }));
    track.dispatchEvent(pointerEvent('pointermove', { clientX: 8, clientY: 14 }));
    track.dispatchEvent(pointerEvent('pointerup', { clientX: 8, clientY: 14 }));
    expect(onTypography).toHaveBeenCalledWith({ fontScaleStep: 0.85 });
  });

  it('lets a mouse drag starting on a tick finish on window after leaving the track', () => {
    const panel = document.createElement('div');
    document.body.append(panel);
    const onTypography = vi.fn();
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      onTypography,
      vi.fn(),
      vi.fn(),
    );
    const track = panel.querySelector<HTMLElement>(
      '[data-type-section="spacing"] .lightink-reader-type-track',
    )!;
    const tick = track.querySelector<HTMLButtonElement>('.lightink-reader-type-tick.is-active');
    expect(tick).not.toBeNull();
    stubRect(track, { width: 200, height: 28, top: 80, left: 40 });
    const mouse = (type: string, clientX: number, clientY: number): PointerEvent =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: type === 'pointerdown' ? 0 : undefined,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        clientX,
        clientY,
      });
    tick!.dispatchEvent(mouse('pointerdown', 140, 94));
    expect(track.classList.contains('is-dragging')).toBe(true);
    window.dispatchEvent(mouse('pointermove', 230, 40));
    window.dispatchEvent(mouse('pointerup', 230, 40));
    expect(onTypography).toHaveBeenCalledWith({ lineHeight: 2 });
    expect(track.classList.contains('is-dragging')).toBe(false);
  });

  it('keeps the touch sheet handle when typography is refilled', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const panel = document.createElement('div');
    panel.className = 'lightink-reader-chrome-panel';
    document.body.append(panel);
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 }) as DOMRect,
    };
    pinFixedOverlay(panel, pane, { innerWidth: 390, innerHeight: 700 });
    const handle = querySheetHandle(panel);
    fillReaderTypographyPanel(
      panel,
      DEFAULT_READER_TYPOGRAPHY,
      'white',
      defaultReaderChromePanelCopy(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    expect(querySheetHandle(panel)).toBe(handle);
    expect(panel.firstElementChild).toBe(handle);
  });

  it('adopts overlay chrome tokens without inheriting reader type scale', () => {
    const host = document.createElement('div');
    host.style.setProperty('--lightink-reader-font-scale', '2');
    host.style.setProperty('--lightink-reader-line-height', '2');
    host.style.fontFamily = 'serif';
    host.style.lineHeight = '2';
    const overlay = document.createElement('div');
    adoptReaderOverlayTheme(overlay, host);
    expect(overlay.style.getPropertyValue('--lightink-reader-font-scale')).toBe('1');
    expect(overlay.style.getPropertyValue('--lightink-reader-line-height')).toBe('1.35');
    expect(overlay.style.fontFamily).toBe('var(--lightink-font-ui)');
    expect(overlay.style.lineHeight).toBe('1.35');
    expect(panelsCss()).toMatch(
      /\.lightink-reader-chrome-panel\s*\{[^}]*--lightink-reader-font-scale:\s*1/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-track\s*\{[^}]*touch-action:\s*none/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-tick\s*\{[^}]*pointer-events:\s*none/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-slider\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-preview\s*\{[^}]*display:\s*none/,
    );
    expect(panelsCss()).not.toMatch(
      /\.lightink-reader-theme-page\s*\{[^}]*border-radius:\s*50%/,
    );
    expect(panelsCss()).not.toMatch(
      /\.lightink-reader-theme-page\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-fonts,\s*\.lightink-reader-type-modes\s*\{[^}]*background:\s*var\(--lightink-reader-seg-track\)/,
    );
    expect(panelsCss()).toMatch(
      /\.lightink-reader-type-font-glyph\s*\{[^}]*display:\s*none/,
    );
  });

  it('touch typography sheet is a short Aa menu so the book stays the preview', () => {
    const css = panelsCss();
    expect(css).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\.lightink-reader-chrome-typography\s*\{[^}]*max-height:\s*min\(56vh/,
    );
    // Sheet is paper-coloured like the page and the footer, not the elevated tint.
    expect(css).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\.lightink-reader-chrome-typography\s*\{[^}]*background:\s*var\(--lightink-bg\)/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-type-preview\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\[data-type-section='measure'\]\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-theme-swatch-name\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-type-font-glyph\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-type-step\s*\{[^}]*min-height:\s*44px/,
    );
  });

  it('touch typography rows are label + control, with one segmented style for font/layout/spacing', () => {
    const css = panelsCss();
    // Section labels are visually hidden on desktop; the touch sheet shows them in a left column.
    expect(css).toMatch(
      /\.is-touch-sheet\s+\[data-type-section='font'\]\s+\.lightink-reader-type-label[^{]*\{[^}]*position:\s*static/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\[data-type-section='spacing'\]\s*\{[^}]*grid-template-columns:\s*3\.1rem/,
    );
    // Fonts, layout modes and the line-height track share the segmented track + active pill tokens.
    for (const control of [
      '\\.lightink-reader-type-fonts',
      '\\.lightink-reader-type-modes',
      "\\[data-type-section='spacing'\\] \\.lightink-reader-type-track",
    ]) {
      expect(css, control).toMatch(
        new RegExp(`\\.is-touch-sheet\\s+${control}[^{]*\\{[^}]*background:\\s*var\\(--lightink-reader-seg-track\\)`),
      );
    }
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-type-font\.is-active,[\s\S]*?\{[^}]*background:\s*var\(--lightink-reader-seg-active\)/,
    );
    // Paper swatches are round chips; the active one gets an ink ring with a paper gap.
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-theme-page\s*\{[^}]*border-radius:\s*999px/,
    );
    expect(css).toMatch(
      /\.is-touch-sheet\s+\.lightink-reader-theme-swatch\.is-active\s+\.lightink-reader-theme-page\s*\{[^}]*0 0 0 2\.5px var\(--lightink-bg\),\s*0 0 0 4\.5px var\(--lightink-fg\)/,
    );
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

  it('shows only theme for pdf — no paginated or scroll tiles', () => {
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
    expect(panel.querySelector('[data-type-section="layout"]')).toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-theme-swatch')).toHaveLength(4);
    expect(panel.querySelectorAll('.lightink-reader-type-mode')).toHaveLength(0);
    for (const kind of ['size', 'font', 'spacing', 'measure', 'layout']) {
      expect(panel.querySelector(`[data-type-section="${kind}"]`), kind).toBeNull();
    }
    expect(panel.querySelector('.lightink-reader-type-hero')).toBeNull();
    expect(panel.querySelectorAll('.lightink-reader-type-font')).toHaveLength(0);
    expect(panel.querySelectorAll('.lightink-reader-type-slider')).toHaveLength(0);
    expect(panel.querySelectorAll('[disabled], [aria-disabled="true"]')).toHaveLength(0);
    expect(panel.textContent).not.toContain('翻页');
    expect(panel.textContent).not.toContain('滚动');
    expect(onLayout).not.toHaveBeenCalled();
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
    expect(overlay.style.bottom).toBe('calc(60px + var(--lightink-keyboard-inset, 0px))');
    expect(overlay.style.top).toBe('auto');
    expect(overlay.style.maxHeight).toBe('');
    unpinFixedOverlay(overlay);
    expect(overlay.classList.contains('is-touch-sheet')).toBe(false);
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('double-anchors the touch sheet between the safe top and the keyboard while it is open', async () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    document.documentElement.setAttribute('data-keyboard', '');
    const overlay = document.createElement('div');
    document.body.append(overlay);
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 }) as DOMRect,
    };
    pinFixedOverlay(overlay, pane, { innerWidth: 390, innerHeight: 700 });
    expect(overlay.classList.contains('is-touch-sheet')).toBe(true);
    // 键盘态：上下双锚定，不叠加 footer inset，清掉 max-height 的键盘扣减。
    expect(overlay.style.top).toBe('calc(var(--lightink-safe-top, 0px) + 4.5rem)');
    expect(overlay.style.bottom).toBe('var(--lightink-keyboard-inset, 0px)');
    expect(overlay.style.height).toBe('auto');
    expect(overlay.style.maxHeight).toBe('none');

    // 键盘收起：data-keyboard 摘除触发重 pin，回到既有 bottom 锚定字符串。
    document.documentElement.removeAttribute('data-keyboard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay.style.top).toBe('auto');
    expect(overlay.style.bottom).toBe('calc(0px + var(--lightink-keyboard-inset, 0px))');
    expect(overlay.style.maxHeight).toBe('');

    // 再弹起：同一监听把几何切回双锚定。
    document.documentElement.setAttribute('data-keyboard', '');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlay.style.top).toBe('calc(var(--lightink-safe-top, 0px) + 4.5rem)');
    expect(overlay.style.bottom).toBe('var(--lightink-keyboard-inset, 0px)');
    unpinFixedOverlay(overlay);
    expect(overlay.style.maxHeight).toBe('');
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
    expect(panel.style.bottom).toBe('calc(72px + var(--lightink-keyboard-inset, 0px))');
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

  it('re-adopts overlay tokens when the reader paper theme changes without remounting', () => {
    const host = document.createElement('div');
    host.dataset.readerTheme = 'sepia';
    host.style.setProperty('--lightink-bg-elevated', 'rgb(244, 228, 196)');
    host.style.setProperty('--lightink-fg', 'rgb(92, 74, 50)');
    document.body.append(host);
    const overlay = document.createElement('div');
    adoptReaderOverlayTheme(overlay, host);
    expect(overlay.dataset.readerTheme).toBe('sepia');
    expect(overlay.style.getPropertyValue('--lightink-bg-elevated')).toBe('rgb(244, 228, 196)');

    host.dataset.readerTheme = 'night';
    host.style.setProperty('--lightink-bg-elevated', 'rgb(28, 28, 28)');
    host.style.setProperty('--lightink-fg', 'rgb(200, 200, 200)');
    adoptReaderOverlayTheme(overlay, host);
    expect(overlay.dataset.readerTheme).toBe('night');
    expect(overlay.style.getPropertyValue('--lightink-bg-elevated')).toBe('rgb(28, 28, 28)');
    expect(overlay.style.getPropertyValue('--lightink-fg')).toBe('rgb(200, 200, 200)');
    overlay.remove();
    host.remove();
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
    expect(panel.style.bottom).toBe('calc(72px + var(--lightink-keyboard-inset, 0px))');
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
      expect(panel.style.bottom, kind).toBe(
        'calc(80px + var(--lightink-keyboard-inset, 0px))',
      );
      expect(overlay.style.bottom, kind).toBe(
        'calc(80px + var(--lightink-keyboard-inset, 0px))',
      );
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
    expect(panel.style.bottom).toBe('calc(64px + var(--lightink-keyboard-inset, 0px))');
    chrome.destroy();
  });

  it('sizes back-to-shelf and the three footer tools at least 48×48 on touch', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action\s*\{[^}]*min-(?:width|height):\s*48px[^}]*min-(?:width|height):\s*48px/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-action--(?:toc|typography|search)[\s\S]*?\{[^}]*min-(?:width|height):\s*48px/,
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

  it('keeps at least 8px between the three footer tools', () => {
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
    const panel = readFileSync(
      resolve(process.cwd(), 'src/reader/annotation-panel.css'),
      'utf-8',
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*--lightink-safe-top/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*padding-bottom:[^;]*--lightink-safe-bottom/,
    );
    expect(panel).toMatch(
      /\.lightink-reader-sidebar\.is-touch-sheet\s*\{[^}]*padding-bottom:\s*calc\(12px \+ var\(--lightink-safe-bottom/,
    );
    expect(panel).toMatch(
      /\.lightink-reader-sidebar\.is-touch-sheet\s*\{[^}]*--lightink-keyboard-inset/,
    );
    expect(sheet).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*--lightink-keyboard-inset/,
    );
    // D5：--lightink-reader-sheet-inset 死 token 无任何残留消费。
    expect(sheet).not.toContain('--lightink-reader-sheet-inset');
    expect(panel).not.toContain('--lightink-reader-sheet-inset');
    // 键盘态几何由 pinFixedOverlay 内联接管，max-height 不再重复扣减 keyboard-inset。
    expect(sheet).not.toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*max-height:[^;]*--lightink-keyboard-inset/,
    );
    expect(panel).not.toMatch(
      /\.lightink-reader-sidebar\.is-touch-sheet\s*\{[^}]*max-height:[^;]*--lightink-keyboard-inset/,
    );
    expect(sheet).toMatch(
      /#app\.is-workspace-shelf \.lightink-reader-chrome-panel,[\s\S]*?\.lightink-reader-sidebar\s*\{[^}]*display:\s*none/,
    );
    expect(readerCss()).toContain('--lightink-keyboard-inset');
    expect(sheet + readerCss()).toMatch(/--lightink-keyboard-inset/);
  });

  it('gives annotation, catalog, and typography sheets a real pointer handle', () => {
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

    const annotation = createAnnotationPanel({
      t: (key) => key,
      onJump: vi.fn(),
      onClose: vi.fn(),
    });
    host.append(annotation.element);
    pinFixedOverlay(annotation.element, host, { innerWidth: 390, innerHeight: 700 });

    for (const sheet of [catalog, typography, annotation.element]) {
      expect(sheet.classList.contains('is-touch-sheet'), sheet.className).toBe(true);
      const handle = querySheetHandle(sheet);
      expectPointerCapableHandle(handle, sheet);
    }

    expect(annotation.element.querySelector('.lightink-reader-sidebar-close')).not.toBeNull();
    annotation.destroy();
  });

  it('closes the unified annotation panel sheet from a downward handle drag and still honors the close button', () => {
    const onClose = vi.fn();
    const panel = createAnnotationPanel({
      t: (key) => key,
      onJump: vi.fn(),
      onClose,
    });
    document.body.append(panel.element);
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    stubRect(host, { width: 390, height: 700 });
    document.body.append(host);
    host.append(panel.element);
    pinFixedOverlay(panel.element, host, { innerWidth: 390, innerHeight: 700 });
    const handle = querySheetHandle(panel.element);
    expectPointerCapableHandle(handle, panel.element);

    dragHandlePastThreshold(handle);
    expect(onClose).toHaveBeenCalledTimes(1);

    panel
      .element!.querySelector<HTMLButtonElement>('.lightink-reader-sidebar-close')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(2);
    panel.destroy();
  });

  it('closes annotation, catalog, and typography sheets from a downward handle drag', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    const page = document.createElement('div');
    page.className = 'lightink-reader-page';
    const onPageClick = vi.fn();
    page.addEventListener('click', onPageClick);
    host.append(page);
    document.body.append(host);
    stubRect(host, { width: 390, height: 700 });

    const onAnnotationClose = vi.fn();
    const annotation = createAnnotationPanel({
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

    let chromePanel: 'toc' | 'typography' | null = 'toc';
    const closeChromePanel = vi.fn((): boolean => {
      if (chromePanel === null) {
        return false;
      }
      if (chromePanel === 'toc') {
        catalog.hidden = true;
      } else {
        typography.hidden = true;
      }
      chromePanel = null;
      return true;
    });
    const chrome = createReaderChrome(host, {
      touchMode: true,
      returnToShelf: vi.fn(),
      openOutline: vi.fn(),
      openTypography: vi.fn(),
      openSearch: vi.fn(),
      toggleSidebar: vi.fn(),
      isOverlayOpen: () => chromePanel !== null,
      dismissOverlay: () => closeChromePanel(),
    });
    chrome.reveal();

    dragHandlePastThreshold(querySheetHandle(catalog));
    expect(closeChromePanel).toHaveBeenCalledTimes(1);
    expect(catalog.hidden).toBe(true);
    expect(chromePanel).toBeNull();
    expect(onPageClick).not.toHaveBeenCalled();

    chromePanel = 'typography';
    host.dataset.comicReader = 'true';
    dragHandlePastThreshold(querySheetHandle(typography));
    expect(closeChromePanel).toHaveBeenCalledTimes(2);
    expect(typography.hidden).toBe(true);
    expect(chromePanel).toBeNull();
    expect(onPageClick).not.toHaveBeenCalled();

    annotation.destroy();
    chrome.destroy();
  });

  it('drag-closing a pinned sheet with no host force-settles it: hidden lands, data-open cleared, unpinned (FB13)', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const overlay = document.createElement('div');
    // 手动挂 data-open 模拟打开态（真机由 revealSheet 装配）。
    overlay.dataset.open = '';
    document.body.append(overlay);
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 }) as DOMRect,
    };
    pinFixedOverlay(overlay, pane, { innerWidth: 390, innerHeight: 700 });
    expect(overlay.classList.contains('is-touch-sheet')).toBe(true);

    // 宿主不存在（面板已从 .lightink-reader 移除）：closer/host 路径都不通，
    // 走 forceSettle 兜底直落。
    dragHandlePastThreshold(querySheetHandle(overlay));
    expect(overlay.hidden).toBe(true);
    expect(overlay.dataset.open).toBeUndefined();
    // 对称 unpin（FB11）：触屏 sheet pin 与拖拽把手一并收掉。
    expect(overlay.classList.contains('is-touch-sheet')).toBe(false);
    expect(overlay.querySelector('.lightink-reader-sheet-handle')).toBeNull();
    document.documentElement.removeAttribute('data-touch-primary');
  });

  it('keeps an in-flight conceal intact when the host swallows the close (no force-settle truncation, FB2)', () => {
    document.documentElement.setAttribute('data-touch-primary', '');
    const host = document.createElement('div');
    host.className = 'lightink-reader';
    document.body.append(host);
    const overlay = document.createElement('div');
    host.append(overlay);
    const pane = {
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 390, height: 700, right: 390, bottom: 700 }) as DOMRect,
    };
    pinFixedOverlay(overlay, pane, { innerWidth: 390, innerHeight: 700 });
    // 模拟 concealSheet 已接管退场：data-open 已摘、hidden 延迟落地中。
    overlay.dataset.open = '';
    delete overlay.dataset.open;
    overlay.hidden = false;

    // host click / Escape 均无消费者（sheet 无人关闭）：data-open 已摘说明
    // 过渡接管，兜底不得直落截断退场。
    dragHandlePastThreshold(querySheetHandle(overlay));
    expect(overlay.hidden).toBe(false);
    expect(overlay.dataset.open).toBeUndefined();
    document.documentElement.removeAttribute('data-touch-primary');
  });
});
