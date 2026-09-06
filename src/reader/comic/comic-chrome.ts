/**
 * 漫画 chrome：DOM 构建、顶栏/底栏状态同步（updateToolbar）、显隐状态机
 * 与 Android 系统栏桥。行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../file/browser-file-store.js';
import type { ComicMetadata } from '../comic-model.js';
import {
  advanceComicPage,
  comicSpreadIndex,
  comicSpreadList,
  type ComicFit,
} from '../comic-preferences.js';
import type { CbzRenderOptions, ComicToolbarLabels } from '../formats/cbz.js';
import { comicLayoutSpreadPrefs, type ComicSession } from './comic-session.js';

const COMIC_CHROME_IDLE_MS = 2800;

/**
 * 系统栏桥契约（owner：MainActivity + 一条 invoke；本模块是漫画 consumer）。
 * `visible=false` 隐藏 status/navigation，并让画面贴边；`true` 再显示。
 * 桌面不调用；桥缺失或 reject 时只藏应用 chrome。
 */
export const SET_SYSTEM_BARS_VISIBLE_COMMAND = 'set_system_bars_visible';

export interface ComicSystemBarsBridge {
  setVisible(visible: boolean): void;
}

export interface ComicSystemBarsHost {
  LightInkSystemBars?: ComicSystemBarsBridge;
}

export function androidReaderRoot(
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): HTMLElement | null {
  if (root === null || !root.hasAttribute('data-android')) return null;
  return root;
}

/** 成对显隐系统栏；非 Android、桥缺失或 invoke 失败均为 no-op。 */
export function syncComicSystemBarsVisible(
  visible: boolean,
  host: (Window & ComicSystemBarsHost) | null = typeof window === 'undefined'
    ? null
    : (window as Window & ComicSystemBarsHost),
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (androidReaderRoot(root) === null) return;
  try {
    const bridge = host?.LightInkSystemBars;
    if (bridge !== undefined && typeof bridge.setVisible === 'function') {
      bridge.setVisible(visible);
      return;
    }
    if (host !== null && isTauriRuntime(host)) {
      void invoke(SET_SYSTEM_BARS_VISIBLE_COMMAND, { visible }).catch(() => undefined);
    }
  } catch {
    // invoke 失败仍只藏应用 chrome，阅读不中断。
  }
}

function toolbarButton(
  symbol: string,
  label: string,
  className = '',
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lightink-reader-comic-tool ${className}`.trim();
  button.textContent = symbol;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function comicTitle(metadata: ComicMetadata, fallback: string): string {
  const title = metadata.title?.trim();
  if (title !== undefined && title !== '') return title;
  const series = metadata.series?.trim();
  if (series === undefined || series === '') return fallback;
  const volume = metadata.volume?.trim();
  return volume === undefined || volume === '' ? series : `${series} ${volume}`;
}

/** buildComicChrome 创建并返回的全部 chrome/页面 DOM 引用。 */
export interface ComicChromeDom {
  readonly chrome: HTMLElement;
  readonly topbar: HTMLElement;
  readonly pageButton: HTMLButtonElement;
  readonly pagesRoot: HTMLElement;
  readonly previousButton: HTMLButtonElement;
  readonly nextButton: HTMLButtonElement;
  readonly pageSlider: HTMLInputElement;
  readonly sliderWrap: HTMLElement;
  readonly verticalButton: HTMLButtonElement;
  readonly pagedButton: HTMLButtonElement;
  readonly ltrButton: HTMLButtonElement;
  readonly rtlButton: HTMLButtonElement;
  readonly singleButton: HTMLButtonElement;
  readonly doubleButton: HTMLButtonElement;
  readonly autoButton: HTMLButtonElement;
  readonly fitButton: HTMLButtonElement;
  readonly cropButton: HTMLButtonElement;
  readonly spreadGroup: HTMLElement;
}

function fitLabelFor(labels: ComicToolbarLabels, fit: ComicFit): string {
  if (fit === 'width') return labels.fitWidth;
  if (fit === 'height') return labels.fitHeight ?? labels.fitWidth;
  if (fit === 'original') return labels.fitOriginal ?? labels.fitWidth;
  return labels.fitScreen ?? labels.fitWidth;
}

function fitChipFor(labels: ComicToolbarLabels, fit: ComicFit): string {
  const chineseChrome = labels.paged === '横向翻页';
  if (chineseChrome) {
    return fit === 'width'
      ? '适宽'
      : fit === 'height'
        ? '适高'
        : fit === 'original'
          ? '原图'
          : '适屏';
  }
  return fit === 'width'
    ? 'Width'
    : fit === 'height'
      ? 'Height'
      : fit === 'original'
        ? '1:1'
        : 'Fit';
}

/** 构建 chrome DOM 与 pagesRoot 并挂载到 container；交互接线由装配入口完成。 */
export function buildComicChrome(
  container: HTMLElement,
  metadata: ComicMetadata,
  preferences: { readonly fit: ComicFit },
  labels: ComicToolbarLabels,
  options: CbzRenderOptions,
): ComicChromeDom {
  container.replaceChildren();
  container.tabIndex = -1;
  container.dataset.comicReader = 'true';
  container.dataset.comicChrome = 'visible';
  container.dataset.comicCanvas = 'near-black';
  container.style.backgroundColor = 'var(--lightink-comic-canvas, #121212)';
  const chrome = document.createElement('div');
  chrome.className = 'lightink-reader-comic-chrome lightink-reader-comic-overlay';
  const topbar = document.createElement('div');
  topbar.className = 'lightink-reader-comic-topbar';
  topbar.setAttribute('data-tauri-drag-region', '');
  const title = document.createElement('div');
  title.className = 'lightink-reader-comic-title';
  title.textContent = comicTitle(metadata, labels.paged);
  const pageButton = document.createElement('button');
  pageButton.type = 'button';
  pageButton.className = 'lightink-reader-comic-page';
  pageButton.title = labels.jumpToPage ?? labels.pageSlider;
  const bottombar = document.createElement('div');
  bottombar.className = 'lightink-reader-comic-bottombar';
  bottombar.setAttribute('role', 'toolbar');
  bottombar.setAttribute('aria-label', comicTitle(metadata, labels.paged));
  const scrub = document.createElement('div');
  scrub.className = 'lightink-reader-comic-scrub';
  const modes = document.createElement('div');
  modes.className = 'lightink-reader-comic-modes';
  const pagesRoot = document.createElement('div');
  pagesRoot.className = 'lightink-reader-comic-pages';
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'lightink-reader-comic-back';
  backButton.textContent = labels.backToShelf;
  backButton.setAttribute('aria-label', labels.backToShelf);
  backButton.addEventListener('click', () => options.onReturnToShelf?.());
  topbar.append(backButton, title, pageButton);
  bottombar.append(scrub, modes);
  chrome.append(topbar, bottombar);
  container.append(chrome, pagesRoot);

  const previousButton = toolbarButton('‹', labels.previous, 'lightink-reader-comic-nav');
  const nextButton = toolbarButton('›', labels.next, 'lightink-reader-comic-nav');
  const pageSlider = document.createElement('input');
  pageSlider.type = 'range';
  pageSlider.className = 'lightink-reader-comic-slider';
  pageSlider.min = '1';
  pageSlider.step = '1';
  pageSlider.setAttribute('aria-label', labels.pageSlider);
  // 滑杆轨道包裹层：拖动页码气泡（comic-navigation）相对它定位跟随 thumb。
  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'lightink-reader-comic-slider-wrap';
  sliderWrap.appendChild(pageSlider);
  const chip = (visible: string, label: string): HTMLButtonElement =>
    toolbarButton(visible, label, 'lightink-reader-comic-chip');
  const chineseChrome = labels.paged === '横向翻页';
  const stripLabel = labels.strip ?? labels.vertical;
  const verticalButton = chip(chineseChrome ? '连续' : 'Strip', stripLabel);
  const pagedButton = chip(chineseChrome ? '翻页' : 'Pages', labels.paged);
  const ltrButton = chip(chineseChrome ? '左到右' : 'LTR', labels.leftToRight);
  const rtlButton = chip(chineseChrome ? '右到左' : 'RTL', labels.rightToLeft);
  const singleButton = chip(chineseChrome ? '单页' : '1', labels.singlePage);
  const doubleButton = chip(chineseChrome ? '双页' : '2', labels.doublePage);
  const autoButton = chip(chineseChrome ? '自动' : 'Auto', labels.autoPage ?? labels.doublePage);
  const fitButton = chip(fitChipFor(labels, preferences.fit), fitLabelFor(labels, preferences.fit));
  const cropButton = chip(chineseChrome ? '裁边' : 'Crop', labels.cropMargins);
  const group = (...buttons: HTMLButtonElement[]): HTMLDivElement => {
    const element = document.createElement('div');
    element.className = 'lightink-reader-comic-tool-group';
    element.setAttribute('role', 'group');
    element.append(...buttons);
    return element;
  };
  const spreadGroup = group(singleButton, doubleButton, autoButton);
  scrub.append(previousButton, sliderWrap, nextButton);
  modes.append(
    group(pagedButton, verticalButton),
    group(ltrButton, rtlButton),
    spreadGroup,
    group(fitButton),
    group(cropButton),
  );

  return {
    chrome,
    topbar,
    pageButton,
    pagesRoot,
    previousButton,
    nextButton,
    pageSlider,
    sliderWrap,
    verticalButton,
    pagedButton,
    ltrButton,
    rtlButton,
    singleButton,
    doubleButton,
    autoButton,
    fitButton,
    cropButton,
    spreadGroup,
  };
}

export function updateToolbar(session: ComicSession): void {
  const { labels, preferences } = session;
  const progress = `${session.currentPage} / ${session.images.length}`;
  session.verticalButton.setAttribute('aria-pressed', String(preferences.mode === 'strip'));
  session.pagedButton.setAttribute('aria-pressed', String(preferences.mode === 'paged'));
  session.ltrButton.setAttribute('aria-pressed', String(preferences.direction === 'ltr'));
  session.rtlButton.setAttribute('aria-pressed', String(preferences.direction === 'rtl'));
  session.singleButton.setAttribute('aria-pressed', String(preferences.spread === 'single'));
  session.doubleButton.setAttribute('aria-pressed', String(preferences.spread === 'double'));
  session.autoButton.setAttribute('aria-pressed', String(preferences.spread === 'auto'));
  session.fitButton.removeAttribute('aria-pressed');
  session.fitButton.textContent = fitChipFor(labels, preferences.fit);
  session.fitButton.title = fitLabelFor(labels, preferences.fit);
  session.fitButton.setAttribute('aria-label', fitLabelFor(labels, preferences.fit));
  session.cropButton.setAttribute('aria-pressed', String(preferences.cropMargins));
  session.spreadGroup.hidden = preferences.mode === 'strip';
  const spreadPrefs = comicLayoutSpreadPrefs(session);
  session.previousButton.disabled = session.currentPage <= 1;
  session.nextButton.disabled =
    advanceComicPage(
      session.currentPage - 1,
      session.images.length,
      1,
      spreadPrefs,
      session.landscapePages,
    ) ===
    session.currentPage - 1;
  const sliderMax =
    preferences.mode === 'paged' && spreadPrefs.spread === 'double'
      ? Math.max(
          1,
          comicSpreadList(session.images.length, spreadPrefs, session.landscapePages).length,
        )
      : Math.max(1, session.images.length);
  const sliderValue =
    preferences.mode === 'paged' && spreadPrefs.spread === 'double'
      ? comicSpreadIndex(
          session.currentPage - 1,
          session.images.length,
          spreadPrefs,
          session.landscapePages,
        ) + 1
      : session.currentPage;
  session.pageSlider.max = String(sliderMax);
  session.pageSlider.value = String(sliderValue);
  session.pageButton.textContent = progress;
  session.pageButton.setAttribute('aria-label', `${labels.pageSlider}: ${progress}`);
}

/** 成对显隐系统栏：优先注入桥，缺省走 MainActivity 桥 / Tauri invoke。 */
export function notifyComicSystemBars(session: ComicSession, visible: boolean): void {
  try {
    if (session.options.setSystemBarsVisible !== undefined) {
      void Promise.resolve(session.options.setSystemBarsVisible(visible)).catch(() => undefined);
      return;
    }
    syncComicSystemBarsVisible(visible);
  } catch {
    // invoke 失败仍只藏应用 chrome，阅读不中断。
  }
}

export function setChromeVisible(session: ComicSession, visible: boolean): void {
  const changed = session.chromeVisible !== visible;
  session.chromeVisible = visible;
  // data-comic-chrome 被 reader-view 的 MutationObserver 监听；等值重写
  // 也会触发回调，只在变化时写。
  const state = visible ? 'visible' : 'hidden';
  if (session.container.dataset.comicChrome !== state) {
    session.container.dataset.comicChrome = state;
  }
  session.chrome.setAttribute('aria-hidden', String(!visible));
  if (visible) {
    session.topbar.setAttribute('data-tauri-drag-region', '');
  } else {
    session.topbar.removeAttribute('data-tauri-drag-region');
  }
  if (changed) notifyComicSystemBars(session, visible);
}

export function scheduleChromeHide(session: ComicSession): void {
  if (session.chromeTimer !== null) clearTimeout(session.chromeTimer);
  session.chromeTimer = setTimeout(() => {
    if (!session.destroyed && !session.chrome.contains(document.activeElement)) {
      setChromeVisible(session, false);
    }
  }, COMIC_CHROME_IDLE_MS);
}

export function revealChrome(session: ComicSession): void {
  setChromeVisible(session, true);
  scheduleChromeHide(session);
}
