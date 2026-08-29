/**
 * Reader TOC and typography sheets.
 *
 * Typography is a visual Aa sheet (Apple Books Themes & Settings / Kindle):
 * size is the hero, paper is a page card, fonts are live specimens, layout
 * is two mode tiles, spacing and measure are discrete tracks. Reader-only.
 */

import { FONT_SCALE_STEPS } from '../ui/font-scale.js';
import { bindSheetDrag } from '../ui/touch/sheet-drag.js';
import {
  filterOutlineItems,
  lastCurrentOutlineIndex,
  outlineItemIsCurrent,
  outlineSearchKeyAction,
  outlineSearchKeyIsComposing,
  scrollChildIntoScroller,
  type OutlineItem,
  type OutlineLocation,
} from '../outline/outline-model.js';

export {
  filterOutlineItems,
  outlineItemMatchesQuery,
} from '../outline/outline-model.js';
import {
  READER_FONT_FAMILY_PRESETS,
  type ReaderFontFamilyPreset,
  type ReaderTypography,
} from './reader-typography.js';
import type { ReaderFlowLayout } from './reader-layout.js';
import { READER_THEMES, type ReaderThemeId } from './reader-theme.js';
import type { ComicPreferences } from './comic-preferences.js';
import { observeLoadMore } from './search-panel.js';

export const READER_TYPE_LINE_HEIGHTS = [1.5, 1.65, 1.8, 2] as const;
export const READER_TYPE_MEASURE_REMS = [16, 18, 22, 26, 32] as const;

/** IME-safe debounce for the contents search box. */
export const READER_TOC_SEARCH_DEBOUNCE_MS = 200;
/** Above this many visible rows the contents sheet renders in batches. */
export const READER_TOC_BATCH_THRESHOLD = 500;
/** Rows painted per batch (first paint plus each scroll-append). */
export const READER_TOC_RENDER_BATCH = 200;

/**
 * Format gate for the typography sheet: flow gets every control, pdf keeps
 * only theme plus paginated/scroll, comic maps existing comic preferences.
 * Anything unrecognized falls back to the full flow sheet.
 */
export type ReaderTypographyFormatKind = 'flow' | 'pdf' | 'comic';

/** Existing comic capabilities injected by the reader; the sheet adds none. */
export interface ReaderTypographyComicControls {
  readonly preferences: ComicPreferences;
  readonly onPreferences: (patch: Partial<ComicPreferences>) => void;
}

export interface ReaderChromePanelComicCopy {
  direction: string;
  spread: string;
  /** Host copy may still send the v2 key; the sheet treats it as strip. */
  vertical: string;
  strip?: string;
  paged: string;
  leftToRight: string;
  rightToLeft: string;
  singlePage: string;
  doublePage: string;
  fit?: string;
  fitWidth: string;
  fitScreen?: string;
  fitHeight?: string;
  fitOriginal?: string;
  cropMargins?: string;
  keepMargins?: string;
  margins?: string;
}

export interface ReaderChromePanelCopy {
  tocTitle: string;
  tocEmpty: string;
  tocSearch?: string;
  tocEmptySearch?: string;
  tocSearchCount?: string;
  typeTitle: string;
  theme: string;
  size: string;
  font: string;
  lineHeight: string;
  measure: string;
  layout: string;
  paginated: string;
  scroll: string;
  smaller: string;
  larger: string;
  fonts: Readonly<Record<ReaderFontFamilyPreset, string>>;
  lineHeights: readonly string[];
  measures: readonly string[];
  themes: Readonly<Record<ReaderThemeId, string>>;
  comic?: Readonly<ReaderChromePanelComicCopy>;
}

/** Labels mirror the comic toolbar wording in formats/cbz.ts. */
export function defaultReaderChromePanelComicCopy(): ReaderChromePanelComicCopy {
  return {
    direction: '方向',
    spread: '页面',
    vertical: '连续条',
    strip: '连续条',
    paged: '横向翻页',
    leftToRight: '从左到右',
    rightToLeft: '从右到左',
    singlePage: '单页',
    doublePage: '双页',
    fit: '适配',
    fitWidth: '适合宽度',
    fitScreen: '适合屏幕',
    fitHeight: '适合高度',
    fitOriginal: '原图',
    cropMargins: '裁白边',
    keepMargins: '保留边距',
    margins: '边距',
  };
}

export function defaultReaderChromePanelCopy(): ReaderChromePanelCopy {
  return {
    tocTitle: '目录',
    tocEmpty: '暂无目录',
    tocSearch: '搜索',
    tocEmptySearch: '没有匹配的条目',
    tocSearchCount: '{n} 条匹配',
    typeTitle: '排版',
    theme: '纸张',
    size: '字号',
    font: '字体',
    lineHeight: '行距',
    measure: '行长',
    layout: '版式',
    paginated: '翻页',
    scroll: '滚动',
    smaller: '缩小',
    larger: '放大',
    fonts: {
      body: '原文',
      sans: '黑体',
      serif: '宋体',
      mono: '等宽',
    },
    lineHeights: ['紧', '适中', '宽松', '更宽'],
    measures: ['更窄', '窄', '适中', '宽', '更宽'],
    themes: {
      white: '白纸',
      sepia: '羊皮纸',
      gray: '石墨',
      night: '夜间',
    },
    comic: defaultReaderChromePanelComicCopy(),
  };
}

let tocSearchSeq = 0;

function formatOutlineSearchCount(template: string, count: number): string {
  return template.replace(/\{n\}/g, String(count));
}

export function fillReaderTocPanel(
  panel: HTMLElement,
  items: readonly OutlineItem[],
  copy: ReaderChromePanelCopy,
  current: OutlineLocation,
  onSelect: (item: OutlineItem) => void,
  onDismiss?: () => void,
): void {
  const previousQuery =
    panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search')?.value ?? '';
  panel.replaceChildren();
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', copy.tocTitle);
  const heading = document.createElement('h2');
  heading.className = 'lightink-reader-chrome-panel-title';
  heading.textContent = copy.tocTitle;
  panel.appendChild(heading);
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lightink-reader-chrome-panel-empty';
    empty.textContent = copy.tocEmpty;
    panel.appendChild(empty);
    return;
  }
  const listId = `lightink-reader-toc-list-${(tocSearchSeq += 1)}`;
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'lightink-reader-toc-search';
  search.autocomplete = 'off';
  search.placeholder = copy.tocSearch ?? '搜索';
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-controls', listId);
  search.setAttribute('aria-label', copy.tocSearch ?? copy.tocTitle);
  search.value = previousQuery;
  search.addEventListener('click', (event) => event.stopPropagation());
  search.addEventListener('pointerdown', (event) => event.stopPropagation());
  panel.appendChild(search);
  const live = document.createElement('div');
  live.className = 'lightink-reader-toc-live';
  live.setAttribute('aria-live', 'polite');
  panel.appendChild(live);
  const list = document.createElement('nav');
  list.id = listId;
  list.className = 'lightink-reader-toc-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', copy.tocTitle);
  panel.appendChild(list);

  let visibleItems: OutlineItem[] = [];
  let activeIndex = 0;
  let renderedCount = 0;
  let loadMoreSentinel: HTMLElement | null = null;
  let disconnectLoadMore: () => void = () => undefined;

  const optionButtons = (): HTMLButtonElement[] =>
    [...list.querySelectorAll<HTMLButtonElement>('.lightink-reader-toc-item')];

  const setActive = (index: number, scroll: boolean): void => {
    const buttons = optionButtons();
    if (buttons.length === 0) {
      activeIndex = -1;
      search.removeAttribute('aria-activedescendant');
      return;
    }
    activeIndex = Math.max(0, Math.min(index, buttons.length - 1));
    buttons.forEach((button, optionIndex) => {
      const selected = optionIndex === activeIndex;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    const active = buttons[activeIndex]!;
    search.setAttribute('aria-activedescendant', active.id);
    if (scroll) {
      scrollChildIntoScroller(list, active);
    }
  };

  const buildItemButton = (item: OutlineItem, index: number): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${listId}-opt-${index}`;
    button.className = 'lightink-reader-toc-item';
    button.setAttribute('role', 'option');
    button.dataset.outlineLevel = String(item.level);
    button.style.setProperty('--lightink-reader-toc-level', String(Math.max(0, item.level - 1)));
    button.textContent = item.text;
    if (outlineItemIsCurrent(item, current)) {
      button.setAttribute('aria-current', 'location');
      button.classList.add('is-current');
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(item);
    });
    return button;
  };

  const renderNextBatch = (): void => {
    if (loadMoreSentinel === null || renderedCount >= visibleItems.length) {
      return;
    }
    const nextCount = Math.min(renderedCount + READER_TOC_RENDER_BATCH, visibleItems.length);
    for (let index = renderedCount; index < nextCount; index += 1) {
      list.insertBefore(buildItemButton(visibleItems[index]!, index), loadMoreSentinel);
    }
    renderedCount = nextCount;
    if (renderedCount >= visibleItems.length) {
      disconnectLoadMore();
      disconnectLoadMore = () => undefined;
      loadMoreSentinel.remove();
      loadMoreSentinel = null;
    }
  };

  const appendLoadMoreSentinel = (): void => {
    const sentinel = document.createElement('div');
    sentinel.className = 'lightink-reader-toc-load-more';
    sentinel.setAttribute('aria-hidden', 'true');
    list.appendChild(sentinel);
    loadMoreSentinel = sentinel;
    disconnectLoadMore = observeLoadMore(list, sentinel, renderNextBatch);
  };

  const paintItems = (query: string): void => {
    disconnectLoadMore();
    disconnectLoadMore = () => undefined;
    loadMoreSentinel = null;
    list.replaceChildren();
    const visible = filterOutlineItems(items, query);
    visibleItems = visible;
    if (visible.length === 0) {
      renderedCount = 0;
      const empty = document.createElement('p');
      empty.className = 'lightink-reader-chrome-panel-empty';
      empty.textContent = copy.tocEmptySearch ?? copy.tocEmpty;
      list.appendChild(empty);
      live.textContent = copy.tocEmptySearch ?? copy.tocEmpty;
      search.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    live.textContent = formatOutlineSearchCount(copy.tocSearchCount ?? '{n}', visible.length);
    renderedCount = Math.min(
      visible.length,
      visible.length > READER_TOC_BATCH_THRESHOLD ? READER_TOC_RENDER_BATCH : visible.length,
    );
    for (let index = 0; index < renderedCount; index += 1) {
      list.appendChild(buildItemButton(visible[index]!, index));
    }
    if (renderedCount < visible.length) {
      appendLoadMoreSentinel();
    }
    const currentIndex = lastCurrentOutlineIndex(visible, current);
    setActive(
      currentIndex >= 0 ? currentIndex : 0,
      query.trim() === '' && panel.hidden !== true,
    );
  };

  // IME-safe debounce (bindImeSafeQuery pattern): composition never paints;
  // compositionend paints immediately, steady typing repaints after the pause.
  // paintNow also cancels a pending debounce so Escape-clear cannot be undone.
  let searchComposing = false;
  let skipTrailingInput = false;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  const paintNow = (query: string): void => {
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    paintItems(query);
  };

  search.addEventListener('compositionstart', () => {
    searchComposing = true;
    skipTrailingInput = false;
  });
  search.addEventListener('compositionend', () => {
    searchComposing = false;
    skipTrailingInput = true;
    paintNow(search.value);
    setTimeout(() => {
      skipTrailingInput = false;
    }, 0);
  });
  search.addEventListener('input', (event) => {
    if (skipTrailingInput) {
      skipTrailingInput = false;
      return;
    }
    if (searchComposing || (event instanceof InputEvent && event.isComposing)) {
      return;
    }
    if (searchDebounce !== null) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    const query = search.value;
    if (query.trim() === '') {
      paintItems(query);
      return;
    }
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      paintItems(query);
    }, READER_TOC_SEARCH_DEBOUNCE_MS);
  });

  search.addEventListener('keydown', (event) => {
    const action = outlineSearchKeyAction(
      event.key,
      search.value,
      outlineSearchKeyIsComposing(event),
    );
    if (action === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === 'clear') {
      search.value = '';
      paintNow('');
      return;
    }
    if (action.kind === 'dismiss') {
      onDismiss?.();
      return;
    }
    if (action.kind === 'move') {
      setActive(activeIndex + action.delta, true);
      return;
    }
    if (action.kind === 'select') {
      const item = visibleItems[activeIndex];
      if (item !== undefined) {
        onSelect(item);
      }
    }
  });
  paintItems(previousQuery);
}

/** After the contents sheet is visible: scroll the current row and focus search. */
export function activateReaderTocPanel(panel: HTMLElement): void {
  const list = panel.querySelector<HTMLElement>('.lightink-reader-toc-list');
  const target =
    list?.querySelector<HTMLElement>('.lightink-reader-toc-item.is-active') ??
    list?.querySelector<HTMLElement>('.lightink-reader-toc-item.is-current');
  if (list !== null && list !== undefined && target !== null && target !== undefined) {
    scrollChildIntoScroller(list, target);
  }
  const search = panel.querySelector<HTMLInputElement>('.lightink-reader-toc-search');
  if (search === null || typeof search.focus !== 'function') {
    return;
  }
  try {
    search.focus({ preventScroll: true });
  } catch {
    search.focus();
  }
}

export function fillReaderTypographyPanel(
  panel: HTMLElement,
  typography: ReaderTypography,
  theme: ReaderThemeId,
  copy: ReaderChromePanelCopy,
  onTypography: (patch: Partial<ReaderTypography>) => void,
  onTheme: (next: ReaderThemeId) => void,
  onSize: (direction: 'in' | 'out') => void,
  layout: ReaderFlowLayout = 'paginated',
  onLayout: (next: ReaderFlowLayout) => void = () => undefined,
  formatKind: ReaderTypographyFormatKind = 'flow',
  comic: ReaderTypographyComicControls | null = null,
): void {
  panel.replaceChildren();
  panel.classList.add('lightink-reader-type-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', copy.typeTitle);

  // Undecidable formats fall back to the full flow sheet rather than hiding
  // controls the reader might need; comic needs its injected capabilities.
  const kind: ReaderTypographyFormatKind =
    formatKind === 'pdf' || (formatKind === 'comic' && comic !== null) ? formatKind : 'flow';

  if (kind === 'comic' && comic !== null) {
    fillComicTypographySections(panel, copy, comic);
    return;
  }
  const flowOnly = kind === 'flow';

  if (flowOnly) {
    appendSizeSection(panel, typography, copy, onSize);
  }

  const themeSection = section(copy.theme, 'theme');
  const swatches = document.createElement('div');
  swatches.className = 'lightink-reader-theme-swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', copy.theme);
  for (const preset of READER_THEMES) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'lightink-reader-theme-swatch';
    swatch.dataset.readerTheme = preset.id;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', preset.id === theme ? 'true' : 'false');
    swatch.setAttribute('aria-label', copy.themes[preset.id]);
    swatch.title = copy.themes[preset.id];
    swatch.style.setProperty('--lightink-reader-swatch-page', preset.page);
    swatch.style.setProperty('--lightink-reader-swatch-ink', preset.ink);
    swatch.classList.toggle('is-active', preset.id === theme);
    const page = document.createElement('span');
    page.className = 'lightink-reader-theme-page';
    page.setAttribute('aria-hidden', 'true');
    for (let line = 0; line < 3; line += 1) {
      page.appendChild(document.createElement('i'));
    }
    const name = document.createElement('span');
    name.className = 'lightink-reader-theme-swatch-name';
    name.textContent = copy.themes[preset.id];
    swatch.append(page, name);
    swatch.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTheme(preset.id);
    });
    swatches.appendChild(swatch);
  }
  themeSection.appendChild(swatches);
  panel.appendChild(themeSection);

  if (flowOnly) {
    appendFontSection(panel, typography, copy, onTypography);
  }

  const layoutSection = section(copy.layout, 'layout');
  const modes = document.createElement('div');
  modes.className = 'lightink-reader-type-modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', copy.layout);
  modes.append(
    modeCard(copy.paginated, 'paginated', layout === 'paginated', () => onLayout('paginated')),
    modeCard(copy.scroll, 'scroll', layout === 'scroll', () => onLayout('scroll')),
  );
  layoutSection.appendChild(modes);
  panel.appendChild(layoutSection);

  if (!flowOnly) {
    return;
  }
  panel.appendChild(
    sliderRow(
      copy.lineHeight,
      'spacing',
      READER_TYPE_LINE_HEIGHTS.map((lineHeight, index) => ({
        label: copy.lineHeights[index] ?? String(lineHeight),
        selected: typography.lineHeight === lineHeight,
        apply: () => onTypography({ lineHeight }),
        glyph: spacingGlyph(index + 1),
      })),
    ),
  );
  panel.appendChild(
    sliderRow(
      copy.measure,
      'measure',
      READER_TYPE_MEASURE_REMS.map((measureRem, index) => ({
        label: copy.measures[index] ?? String(measureRem),
        selected: typography.measureRem === measureRem,
        apply: () => onTypography({ measureRem }),
        glyph: measureGlyph(index + 1),
      })),
    ),
  );
}

function appendSizeSection(
  panel: HTMLElement,
  typography: ReaderTypography,
  copy: ReaderChromePanelCopy,
  onSize: (direction: 'in' | 'out') => void,
): void {
  const minScale = FONT_SCALE_STEPS[0] ?? 0.85;
  const maxScale = FONT_SCALE_STEPS[FONT_SCALE_STEPS.length - 1] ?? 5;
  const sizeSection = section(copy.size, 'size', true);
  const sizeRow = document.createElement('div');
  sizeRow.className = 'lightink-reader-type-hero';
  const smaller = document.createElement('button');
  smaller.type = 'button';
  smaller.className = 'lightink-reader-type-step lightink-reader-type-step--out';
  smaller.textContent = 'A';
  smaller.setAttribute('aria-label', copy.smaller);
  smaller.dataset.typeAction = 'size-out';
  smaller.disabled = typography.fontScaleStep <= minScale;
  smaller.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSize('out');
  });
  const preview = document.createElement('div');
  preview.className = 'lightink-reader-type-hero-preview';
  preview.setAttribute('aria-hidden', 'true');
  const sample = document.createElement('span');
  sample.className = 'lightink-reader-type-hero-sample';
  sample.textContent = '轻墨';
  sample.style.fontFamily = typography.fontFamily;
  sample.style.setProperty('--lightink-reader-hero-scale', String(typography.fontScaleStep));
  const sizeMark = document.createElement('span');
  sizeMark.className = 'lightink-reader-type-step-mark';
  sizeMark.textContent = `${Math.round(typography.fontScaleStep * 100)}%`;
  preview.append(sample, sizeMark);
  const larger = document.createElement('button');
  larger.type = 'button';
  larger.className = 'lightink-reader-type-step lightink-reader-type-step--in';
  larger.textContent = 'A';
  larger.setAttribute('aria-label', copy.larger);
  larger.dataset.typeAction = 'size-in';
  larger.disabled = typography.fontScaleStep >= maxScale;
  larger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSize('in');
  });
  sizeRow.append(smaller, preview, larger);
  sizeSection.appendChild(sizeRow);
  panel.appendChild(sizeSection);
}

function appendFontSection(
  panel: HTMLElement,
  typography: ReaderTypography,
  copy: ReaderChromePanelCopy,
  onTypography: (patch: Partial<ReaderTypography>) => void,
): void {
  const fontSection = section(copy.font, 'font');
  const fonts = document.createElement('div');
  fonts.className = 'lightink-reader-type-fonts';
  fonts.setAttribute('role', 'group');
  fonts.setAttribute('aria-label', copy.font);
  for (const family of Object.keys(READER_FONT_FAMILY_PRESETS) as ReaderFontFamilyPreset[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-type-font';
    button.style.fontFamily = READER_FONT_FAMILY_PRESETS[family];
    button.textContent = copy.fonts[family];
    button.setAttribute('aria-pressed', (
      typography.fontFamily === family ||
      typography.fontFamily === READER_FONT_FAMILY_PRESETS[family]
    ) ? 'true' : 'false');
    button.classList.toggle(
      'is-active',
      typography.fontFamily === family ||
        typography.fontFamily === READER_FONT_FAMILY_PRESETS[family],
    );
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTypography({ fontFamily: family });
    });
    fonts.appendChild(button);
  }
  fontSection.appendChild(fonts);
  panel.appendChild(fontSection);
}

/**
 * Comic sheet: ComicPreferences (mode, direction, spread, fit, cropMargins).
 * No flow controls, and hidden items are not rendered — no disabled placeholders.
 */
function fillComicTypographySections(
  panel: HTMLElement,
  copy: ReaderChromePanelCopy,
  comic: ReaderTypographyComicControls,
): void {
  const comicCopy = copy.comic ?? defaultReaderChromePanelComicCopy();
  const defaults = defaultReaderChromePanelComicCopy();
  const preferences = comic.preferences;
  const stripLabel = comicCopy.strip ?? comicCopy.vertical;

  const layoutSection = section(copy.layout, 'layout');
  const modes = document.createElement('div');
  modes.className = 'lightink-reader-type-modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', copy.layout);
  modes.append(
    modeCard(comicCopy.paged, 'paginated', preferences.mode === 'paged', () =>
      comic.onPreferences({ mode: 'paged' }),
    ),
    modeCard(stripLabel, 'scroll', preferences.mode === 'strip', () =>
      comic.onPreferences({ mode: 'strip' }),
    ),
  );
  layoutSection.appendChild(modes);
  panel.appendChild(layoutSection);

  panel.appendChild(
    comicChoiceSection(comicCopy.direction, 'comic-direction', [
      {
        label: comicCopy.leftToRight,
        selected: preferences.direction === 'ltr',
        apply: () => comic.onPreferences({ direction: 'ltr' }),
      },
      {
        label: comicCopy.rightToLeft,
        selected: preferences.direction === 'rtl',
        apply: () => comic.onPreferences({ direction: 'rtl' }),
      },
    ]),
  );
  panel.appendChild(
    comicChoiceSection(comicCopy.spread, 'comic-spread', [
      {
        label: comicCopy.singlePage,
        selected: preferences.spread === 'single',
        apply: () => comic.onPreferences({ spread: 'single' }),
      },
      {
        label: comicCopy.doublePage,
        selected: preferences.spread === 'double',
        apply: () => comic.onPreferences({ spread: 'double' }),
      },
    ]),
  );
  panel.appendChild(
    comicChoiceSection(comicCopy.fit ?? defaults.fit ?? '适配', 'comic-fit', [
      {
        label: comicCopy.fitScreen ?? defaults.fitScreen ?? comicCopy.fitWidth,
        selected: preferences.fit === 'screen',
        apply: () => comic.onPreferences({ fit: 'screen' }),
      },
      {
        label: comicCopy.fitWidth,
        selected: preferences.fit === 'width',
        apply: () => comic.onPreferences({ fit: 'width' }),
      },
      {
        label: comicCopy.fitHeight ?? defaults.fitHeight ?? comicCopy.fitWidth,
        selected: preferences.fit === 'height',
        apply: () => comic.onPreferences({ fit: 'height' }),
      },
      {
        label: comicCopy.fitOriginal ?? defaults.fitOriginal ?? comicCopy.fitWidth,
        selected: preferences.fit === 'original',
        apply: () => comic.onPreferences({ fit: 'original' }),
      },
    ]),
  );
  panel.appendChild(
    comicChoiceSection(comicCopy.margins ?? defaults.margins ?? '边距', 'comic-margins', [
      {
        label: comicCopy.keepMargins ?? defaults.keepMargins ?? '保留边距',
        selected: preferences.cropMargins !== true,
        apply: () => comic.onPreferences({ cropMargins: false }),
      },
      {
        label: comicCopy.cropMargins ?? defaults.cropMargins ?? '裁白边',
        selected: preferences.cropMargins === true,
        apply: () => comic.onPreferences({ cropMargins: true }),
      },
    ]),
  );
}

function comicChoiceSection(
  label: string,
  kind: string,
  choices: readonly { label: string; selected: boolean; apply: () => void }[],
): HTMLElement {
  const block = section(label, kind);
  const group = document.createElement('div');
  group.className = 'lightink-reader-type-fonts lightink-reader-type-comic-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-type-choice lightink-reader-type-comic-choice';
    button.textContent = choice.label;
    button.setAttribute('aria-pressed', choice.selected ? 'true' : 'false');
    button.classList.toggle('is-active', choice.selected);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      choice.apply();
    });
    group.appendChild(button);
  }
  block.appendChild(group);
  return block;
}

const READER_OVERLAY_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-fg',
  '--lightink-muted',
  '--lightink-border',
] as const;

/**
 * Copy reader paper tokens onto a portaled overlay so it does not inherit
 * the editor / markdown theme on document.body.
 */
export function adoptReaderOverlayTheme(overlay: HTMLElement, host: HTMLElement): void {
  if (typeof getComputedStyle !== 'function') {
    return;
  }
  const style = getComputedStyle(host);
  for (const name of READER_OVERLAY_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== '') overlay.style.setProperty(name, value);
  }
  const theme = host.dataset.readerTheme;
  if (theme !== undefined && theme !== '') overlay.dataset.readerTheme = theme;
  if (style.color !== '') overlay.style.color = style.color;
  const colorScheme = style.colorScheme?.trim() ?? '';
  if (colorScheme !== '') overlay.style.colorScheme = colorScheme;
  // Reader paper has no accent token; use ink so chips/focus are not editor brown.
  const ink = overlay.style.getPropertyValue('--lightink-fg').trim() || style.color;
  const elevated =
    overlay.style.getPropertyValue('--lightink-bg-elevated').trim() ||
    style.getPropertyValue('--lightink-bg-elevated').trim();
  if (ink !== '') overlay.style.setProperty('--lightink-accent', ink);
  if (elevated !== '') overlay.style.setProperty('--lightink-accent-soft', elevated);
}

/** Escape #lightink-editor-area overflow:hidden by mounting on document.body. */
export function mountReaderOverlay(overlay: HTMLElement, host: HTMLElement): void {
  adoptReaderOverlayTheme(overlay, host);
  const layer = host.ownerDocument?.body ?? (typeof document !== 'undefined' ? document.body : null);
  if (layer !== null && overlay.parentNode !== layer) {
    layer.appendChild(overlay);
  }
}

export function readerChromeFooterInset(
  root: ParentNode | null = typeof document !== 'undefined' ? document : null,
): number {
  const footer = root?.querySelector<HTMLElement>('.lightink-reader-chrome-footer');
  if (footer == null || footer.hidden) return 0;
  const height = footer.getBoundingClientRect().height;
  return Number.isFinite(height) ? Math.max(0, Math.round(height)) : 0;
}

/** Anchor a sheet under its toolbar button, clamped to the reading host. */
export function positionReaderChromePanel(
  panel: HTMLElement,
  host: HTMLElement,
  anchor: HTMLElement | null,
): void {
  if (isTouchReaderChrome()) {
    pinFixedOverlay(panel, host);
    return;
  }
  if (typeof host.getBoundingClientRect !== 'function') {
    return;
  }
  const hostBox = host.getBoundingClientRect();
  const viewportWidth =
    typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
      ? window.innerWidth
      : hostBox.width;
  const viewportHeight =
    typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
      ? window.innerHeight
      : hostBox.height;
  const panelWidth = Math.min(panel.offsetWidth || 320, Math.max(160, hostBox.width - 16));
  const gap = 8;
  let left = Math.max(8, hostBox.left + 12);
  let top = Math.max(8, Math.max(0, hostBox.top) + 44);
  let arrow = 18;
  if (anchor !== null && typeof anchor.getBoundingClientRect === 'function') {
    const box = anchor.getBoundingClientRect();
    left = box.left;
    top = box.bottom + gap;
    arrow = Math.max(12, box.left + box.width / 2 - left);
  }
  const maxLeft = Math.max(8, viewportWidth - panelWidth - 8);
  const maxTop = Math.max(8, viewportHeight - 24);
  const nextLeft = Math.min(Math.max(8, left), maxLeft);
  if (anchor !== null && typeof anchor.getBoundingClientRect === 'function') {
    const box = anchor.getBoundingClientRect();
    arrow = Math.max(12, Math.min(panelWidth - 12, box.left + box.width / 2 - nextLeft));
  }
  panel.classList.add('lightink-reader-chrome-popover');
  panel.style.position = 'fixed';
  panel.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
  panel.style.left = `${nextLeft}px`;
  panel.style.right = 'auto';
  panel.style.setProperty('--lightink-reader-popover-arrow', `${Math.round(arrow)}px`);
}

const READER_SHEET_HANDLE_CLASS = 'lightink-reader-sheet-handle';
const sheetDragUnbinds = new WeakMap<HTMLElement, () => void>();

/**
 * Touch sheets re-pin when the keyboard state flips (safe-area.ts toggles
 * `data-keyboard` on <html> at the >=80px inset threshold): keyboard-open
 * geometry double-anchors top/bottom, keyboard-closed keeps the footer gap.
 */
const touchSheetPins = new Map<
  HTMLElement,
  {
    pane: { getBoundingClientRect(): DOMRect } | null;
    viewport: { innerWidth: number; innerHeight: number };
  }
>();
let touchSheetKeyboardObserver: MutationObserver | null = null;

function trackTouchSheetPin(
  overlay: HTMLElement,
  pane: { getBoundingClientRect(): DOMRect } | null,
  viewport: { innerWidth: number; innerHeight: number },
): void {
  touchSheetPins.set(overlay, { pane, viewport });
  if (touchSheetKeyboardObserver !== null || typeof MutationObserver !== 'function') {
    return;
  }
  const root = overlay.ownerDocument?.documentElement ?? null;
  if (root === null) {
    return;
  }
  try {
    touchSheetKeyboardObserver = new MutationObserver(() => {
      for (const [sheet, pin] of touchSheetPins) {
        pinFixedOverlay(sheet, pin.pane, pin.viewport);
      }
    });
    touchSheetKeyboardObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-keyboard'],
    });
  } catch {
    // Fake documents in unit tests are not MutationObserver targets.
    touchSheetKeyboardObserver = null;
  }
}

function releaseTouchSheetPin(overlay: HTMLElement): void {
  touchSheetPins.delete(overlay);
  if (touchSheetPins.size === 0 && touchSheetKeyboardObserver !== null) {
    touchSheetKeyboardObserver.disconnect();
    touchSheetKeyboardObserver = null;
  }
}

/** Pin an overlay to the visible reading pane so scroll mode cannot carry it away. */
function isTouchReaderChrome(
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): boolean {
  return root !== null && (root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary'));
}

function releaseTouchSheetDrag(overlay: HTMLElement): void {
  const unbind = sheetDragUnbinds.get(overlay);
  if (unbind !== undefined) {
    unbind();
    sheetDragUnbinds.delete(overlay);
  }
  overlay.querySelector<HTMLElement>(`.${READER_SHEET_HANDLE_CLASS}[data-reader-pin-handle]`)?.remove();
  overlay.style.removeProperty('transform');
}

function closePinnedTouchSheet(sheet: HTMLElement): void {
  sheet.style.removeProperty('transform');
  const closer = sheet.querySelector<HTMLElement>('.lightink-reader-sidebar-close');
  if (closer !== null) {
    closer.click();
    return;
  }
  const host =
    (typeof sheet.closest === 'function' ? sheet.closest<HTMLElement>('.lightink-reader') : null) ??
    sheet.ownerDocument?.querySelector<HTMLElement>('.lightink-reader') ??
    null;
  if (host === null) {
    sheet.hidden = true;
    return;
  }
  // Host click — never `.lightink-reader-page` (comic tap at 0,0 can advancePage).
  host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  if (sheet.hidden) {
    return;
  }
  // Comic hosts swallow surface clicks; Escape is the same dismissOverlay owner.
  host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (!sheet.hidden) {
    sheet.hidden = true;
  }
}

function bindTouchSheetDrag(overlay: HTMLElement): void {
  const existingUnbind = sheetDragUnbinds.get(overlay);
  if (existingUnbind !== undefined) {
    existingUnbind();
    sheetDragUnbinds.delete(overlay);
  }
  let handle = overlay.querySelector<HTMLElement>(`.${READER_SHEET_HANDLE_CLASS}`);
  if (handle === null) {
    handle = overlay.ownerDocument.createElement('div');
    handle.className = READER_SHEET_HANDLE_CLASS;
    handle.dataset.readerPinHandle = '';
    handle.setAttribute('aria-hidden', 'true');
    overlay.insertBefore(handle, overlay.firstChild);
  }
  const unbind = bindSheetDrag(handle, {
    sheet: overlay,
    onClose: () => {
      closePinnedTouchSheet(overlay);
    },
  });
  sheetDragUnbinds.set(overlay, unbind);
}

export function pinFixedOverlay(
  overlay: HTMLElement,
  pane: { getBoundingClientRect(): DOMRect } | null,
  viewport: { innerWidth: number; innerHeight: number } = typeof window !== 'undefined'
    ? window
    : { innerWidth: 0, innerHeight: 0 },
): void {
  if (pane === null || typeof pane.getBoundingClientRect !== 'function') {
    return;
  }
  if (isTouchReaderChrome()) {
    const box = pane.getBoundingClientRect();
    const keyboardOpen =
      typeof document !== 'undefined' && document.documentElement.hasAttribute('data-keyboard');
    overlay.classList.add('is-touch-sheet');
    overlay.classList.remove('lightink-reader-chrome-popover');
    overlay.style.position = 'fixed';
    overlay.style.left = `${Math.max(0, box.left)}px`;
    overlay.style.right = `${Math.max(0, viewport.innerWidth - box.right)}px`;
    if (keyboardOpen) {
      // Keyboard up: double-anchor between the safe top and the keyboard top;
      // the keyboard already covers the footer, so no footer inset is added.
      overlay.style.top = 'calc(var(--lightink-safe-top, 0px) + 4.5rem)';
      overlay.style.bottom = 'var(--lightink-keyboard-inset, 0px)';
      overlay.style.maxHeight = 'none';
    } else {
      const inset = readerChromeFooterInset(overlay.ownerDocument);
      const bottomGap = Math.max(0, viewport.innerHeight - box.bottom);
      overlay.style.top = 'auto';
      overlay.style.bottom = `calc(${bottomGap + inset}px + var(--lightink-keyboard-inset, 0px))`;
      overlay.style.removeProperty('max-height');
    }
    overlay.style.width = 'auto';
    overlay.style.height = 'auto';
    overlay.style.zIndex = '40';
    trackTouchSheetPin(overlay, pane, viewport);
    bindTouchSheetDrag(overlay);
    return;
  }
  releaseTouchSheetPin(overlay);
  releaseTouchSheetDrag(overlay);
  overlay.classList.remove('is-touch-sheet');
  const box = pane.getBoundingClientRect();
  const titlebar = titlebarOffsetPx();
  overlay.style.position = 'fixed';
  overlay.style.top = `${Math.max(titlebar, Math.max(0, box.top))}px`;
  overlay.style.right = `${Math.max(0, viewport.innerWidth - box.right)}px`;
  overlay.style.bottom = `${Math.max(0, viewport.innerHeight - box.bottom)}px`;
  overlay.style.left = 'auto';
  overlay.style.height = 'auto';
}

function titlebarOffsetPx(): number {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') {
    return 0;
  }
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      '--lightink-titlebar-height',
    );
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function unpinFixedOverlay(overlay: HTMLElement): void {
  releaseTouchSheetPin(overlay);
  releaseTouchSheetDrag(overlay);
  overlay.classList.remove('is-touch-sheet');
  overlay.style.removeProperty('position');
  overlay.style.removeProperty('top');
  overlay.style.removeProperty('right');
  overlay.style.removeProperty('bottom');
  overlay.style.removeProperty('left');
  overlay.style.removeProperty('width');
  overlay.style.removeProperty('height');
  overlay.style.removeProperty('max-height');
  overlay.style.removeProperty('z-index');
}

function section(label: string, kind?: string, hideLabel = false): HTMLElement {
  const block = document.createElement('section');
  block.className = 'lightink-reader-type-section';
  if (kind !== undefined) {
    block.dataset.typeSection = kind;
  }
  const title = document.createElement('h3');
  title.className = hideLabel
    ? 'lightink-reader-type-label lightink-reader-type-label--hidden'
    : 'lightink-reader-type-label';
  title.textContent = label;
  block.appendChild(title);
  return block;
}

function modeCard(
  label: string,
  kind: 'paginated' | 'scroll',
  selected: boolean,
  apply: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lightink-reader-type-choice lightink-reader-type-mode lightink-reader-type-mode--${kind}`;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  button.classList.toggle('is-active', selected);
  const art = document.createElement('span');
  art.className = 'lightink-reader-type-mode-art';
  art.setAttribute('aria-hidden', 'true');
  if (kind === 'paginated') {
    art.append(document.createElement('i'), document.createElement('i'));
  } else {
    art.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  }
  const name = document.createElement('span');
  name.className = 'lightink-reader-type-mode-name';
  name.textContent = label;
  button.append(art, name);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    apply();
  });
  return button;
}

function sliderRow(
  label: string,
  kind: string,
  choices: readonly {
    label: string;
    selected: boolean;
    apply: () => void;
    glyph: HTMLElement;
  }[],
): HTMLElement {
  const block = section(label, kind);
  block.classList.add('lightink-reader-type-slider');
  const track = document.createElement('div');
  track.className = 'lightink-reader-type-track';
  track.setAttribute('role', 'group');
  track.setAttribute('aria-label', label);
  const active = Math.max(0, choices.findIndex((choice) => choice.selected));
  track.style.setProperty('--lightink-reader-track-fill', `${(active / Math.max(1, choices.length - 1)) * 100}%`);
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-type-choice lightink-reader-type-tick';
    button.appendChild(choice.glyph);
    button.setAttribute('aria-label', choice.label);
    button.setAttribute('aria-pressed', choice.selected ? 'true' : 'false');
    button.title = choice.label;
    button.classList.toggle('is-active', choice.selected);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      choice.apply();
    });
    track.appendChild(button);
  }
  block.appendChild(track);
  return block;
}

function spacingGlyph(level: number): HTMLElement {
  const glyph = document.createElement('span');
  glyph.className = 'lightink-reader-type-glyph lightink-reader-type-glyph--spacing';
  glyph.dataset.level = String(level);
  glyph.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 3; index += 1) {
    glyph.appendChild(document.createElement('i'));
  }
  return glyph;
}

function measureGlyph(level: number): HTMLElement {
  const glyph = document.createElement('span');
  glyph.className = 'lightink-reader-type-glyph lightink-reader-type-glyph--measure';
  glyph.dataset.level = String(level);
  glyph.setAttribute('aria-hidden', 'true');
  glyph.appendChild(document.createElement('i'));
  return glyph;
}
