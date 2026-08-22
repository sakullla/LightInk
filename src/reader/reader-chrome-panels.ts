/**
 * Reader TOC and typography sheets.
 *
 * Typography is a visual Aa sheet (Apple Books Themes & Settings / Kindle):
 * size is the hero, paper is a page card, fonts are live specimens, layout
 * is two mode tiles, spacing and measure are discrete tracks. Reader-only.
 */

import { FONT_SCALE_STEPS } from '../ui/font-scale.js';
import type { OutlineItem } from '../outline/outline-model.js';
import {
  READER_FONT_FAMILY_PRESETS,
  type ReaderFontFamilyPreset,
  type ReaderTypography,
} from './reader-typography.js';
import type { ReaderFlowLayout } from './reader-layout.js';
import { READER_THEMES, type ReaderThemeId } from './reader-theme.js';

export const READER_TYPE_LINE_HEIGHTS = [1.5, 1.65, 1.8, 2] as const;
export const READER_TYPE_MEASURE_REMS = [16, 18, 22, 26, 32] as const;

export interface ReaderChromePanelCopy {
  tocTitle: string;
  tocEmpty: string;
  typeTitle: string;
  theme: string;
  size: string;
  font: string;
  lineHeight: string;
  measure: string;
  layout: string;
  paginated: string;
  scroll: string;
  statusBar: string;
  statusBarShow: string;
  statusBarHide: string;
  smaller: string;
  larger: string;
  fonts: Readonly<Record<ReaderFontFamilyPreset, string>>;
  lineHeights: readonly string[];
  measures: readonly string[];
  themes: Readonly<Record<ReaderThemeId, string>>;
}

export function defaultReaderChromePanelCopy(): ReaderChromePanelCopy {
  return {
    tocTitle: '目录',
    tocEmpty: '暂无目录',
    typeTitle: '排版',
    theme: '纸张',
    size: '字号',
    font: '字体',
    lineHeight: '行距',
    measure: '行长',
    layout: '版式',
    paginated: '翻页',
    scroll: '滚动',
    statusBar: '状态栏',
    statusBarShow: '显示',
    statusBarHide: '隐藏',
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
  };
}

export function fillReaderTocPanel(
  panel: HTMLElement,
  items: readonly OutlineItem[],
  copy: ReaderChromePanelCopy,
  current: { chapter?: number; page?: number },
  onSelect: (item: OutlineItem) => void,
): void {
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
  const list = document.createElement('nav');
  list.className = 'lightink-reader-toc-list';
  list.setAttribute('aria-label', copy.tocTitle);
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightink-reader-toc-item';
    button.dataset.outlineLevel = String(item.level);
    button.style.setProperty('--lightink-reader-toc-level', String(Math.max(0, item.level - 1)));
    button.textContent = item.text;
    const currentChapter =
      current.chapter !== undefined && item.chapter !== undefined && item.chapter === current.chapter;
    const currentPage =
      current.page !== undefined && item.page !== undefined && item.page === current.page;
    if (currentChapter || currentPage) {
      button.setAttribute('aria-current', 'location');
      button.classList.add('is-current');
    }
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(item);
    });
    list.appendChild(button);
  }
  panel.appendChild(list);
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
): void {
  panel.replaceChildren();
  panel.classList.add('lightink-reader-type-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', copy.typeTitle);

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

  // 状态栏：阅读态下可完全隐藏底部状态栏（编辑器状态栏不受影响）。
  const statusBarSection = section(copy.statusBar, 'status-bar');
  const statusBarModes = document.createElement('div');
  statusBarModes.className = 'lightink-reader-type-modes';
  statusBarModes.setAttribute('role', 'group');
  statusBarModes.setAttribute('aria-label', copy.statusBar);
  for (const option of [
    { label: copy.statusBarShow, hide: false },
    { label: copy.statusBarHide, hide: true },
  ] as const) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'lightink-reader-type-choice';
    choice.dataset.statusBarMode = option.hide ? 'hide' : 'show';
    choice.textContent = option.label;
    choice.setAttribute('aria-pressed', typography.hideStatusBar === option.hide ? 'true' : 'false');
    choice.classList.toggle('is-active', typography.hideStatusBar === option.hide);
    choice.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onTypography({ hideStatusBar: option.hide });
    });
    statusBarModes.appendChild(choice);
  }
  statusBarSection.appendChild(statusBarModes);
  panel.appendChild(statusBarSection);

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

/** Anchor a sheet under its toolbar button, clamped to the reading host. */
export function positionReaderChromePanel(
  panel: HTMLElement,
  host: HTMLElement,
  anchor: HTMLElement | null,
): void {
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

/** Pin an overlay to the visible reading pane so scroll mode cannot carry it away. */
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
  const box = pane.getBoundingClientRect();
  overlay.style.position = 'fixed';
  overlay.style.top = `${Math.max(0, box.top)}px`;
  overlay.style.right = `${Math.max(0, viewport.innerWidth - box.right)}px`;
  overlay.style.bottom = `${Math.max(0, viewport.innerHeight - box.bottom)}px`;
  overlay.style.left = 'auto';
  overlay.style.height = 'auto';
}

export function unpinFixedOverlay(overlay: HTMLElement): void {
  overlay.style.removeProperty('position');
  overlay.style.removeProperty('top');
  overlay.style.removeProperty('right');
  overlay.style.removeProperty('bottom');
  overlay.style.removeProperty('left');
  overlay.style.removeProperty('height');
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
