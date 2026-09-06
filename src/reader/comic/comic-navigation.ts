/**
 * 漫画进度跳页（T2，ADR-3）：
 * - pageSlider 拖动页码气泡：拖拽中实时显示目标页码（双页 spread 模式显示
 *   该跨页首页码），松手隐藏；拖动期间暂停 chrome 自动隐藏，松手后重新计时。
 * - 顶栏 pageButton 页码跳转对话框：复用通用 chrome 覆盖层模式
 *   （mountReaderOverlay 挂到 document.body）与 TOC 搜索框的 IME 安全
 *   keydown（Escape 清空/关闭、Enter 提交、组合键不吞）；合法页码直达，
 *   越界/非数字给出反馈且不跳转。
 *
 * 全部函数以 ComicSession 为第一参数；scrollToIndex 由装配入口注入，
 * 本模块不反向依赖 cbz.ts。
 */

import { comicSpreadList } from '../comic-preferences.js';
import { mountReaderOverlay } from '../reader-chrome-panels.js';
import { outlineSearchKeyIsComposing } from '../../outline/outline-model.js';
import { scheduleChromeHide, setChromeVisible } from './comic-chrome.js';
import { comicLayoutSpreadPrefs, type ComicSession } from './comic-session.js';

/** 滑杆 thumb 宽度的近似值（px），用于气泡跟随 thumb 中心的边缘补偿。 */
const COMIC_SCRUB_THUMB_PX = 16;

/**
 * 滑杆值 → 目标页码（1 基）。双页 spread 模式下滑杆值是跨页序号，
 * 显示/落到该跨页首页码；其余模式滑杆值即页码。越界值钳制到总页数内。
 */
export function comicScrubTargetPage(session: ComicSession, sliderValue: number): number {
  const total = session.images.length;
  const spreadPrefs = comicLayoutSpreadPrefs(session);
  if (session.preferences.mode === 'paged' && spreadPrefs.spread === 'double') {
    const spreads = comicSpreadList(total, spreadPrefs, session.landscapePages);
    const clamped = Math.min(spreads.length, Math.max(1, sliderValue));
    const first = spreads[clamped - 1]?.[0];
    if (first !== undefined) return first + 1;
  }
  return Math.min(total, Math.max(1, sliderValue));
}

export interface ComicScrubFeedback {
  /** 显示气泡并按当前滑杆值同步标签与位置。 */
  show(): void;
  /** 拖动中同步标签与位置（滑杆值已变化时调用）。 */
  sync(): void;
  hide(): void;
}

/**
 * 在滑杆容器（buildComicChrome 的 slider-wrap）内创建页码气泡。
 * 气泡只做读反馈，不拦截指针。
 */
export function createComicScrubFeedback(session: ComicSession): ComicScrubFeedback {
  const bubble = document.createElement('div');
  bubble.className = 'lightink-reader-comic-scrub-bubble';
  bubble.hidden = true;
  bubble.setAttribute('aria-hidden', 'true');
  const wrap = session.pageSlider.parentElement;
  (wrap ?? session.pageSlider).appendChild(bubble);

  const sync = (): void => {
    const value = Number.parseInt(session.pageSlider.value, 10);
    if (!Number.isSafeInteger(value)) return;
    bubble.textContent = String(comicScrubTargetPage(session, value));
    const min = Number.parseFloat(session.pageSlider.min) || 0;
    const max = Number.parseFloat(session.pageSlider.max) || min;
    const percent = max > min ? (value - min) / (max - min) : 0;
    bubble.style.left = `calc(${(percent * 100).toFixed(2)}% + ${((0.5 - percent) * COMIC_SCRUB_THUMB_PX).toFixed(1)}px)`;
  };

  return {
    show(): void {
      sync();
      bubble.hidden = false;
    },
    sync,
    hide(): void {
      bubble.hidden = true;
    },
  };
}

/**
 * 接线 pageSlider：拖动即时跳页（拆分前行为保留）+ 拖动页码气泡 +
 * 拖动期间暂停 chrome 自动隐藏（触屏拖动不会让滑杆拿到焦点，
 * scheduleChromeHide 的 focus 豁免不可靠，需显式清计时器）。
 */
export function wireComicScrubNavigation(
  session: ComicSession,
  scrollToIndex: (index: number) => boolean,
): void {
  const feedback = createComicScrubFeedback(session);
  const suspendChromeHide = (): void => {
    if (session.chromeTimer !== null) {
      clearTimeout(session.chromeTimer);
      session.chromeTimer = null;
    }
  };
  session.pageSlider.addEventListener('pointerdown', () => {
    suspendChromeHide();
    feedback.show();
  });
  session.pageSlider.addEventListener('input', () => {
    const next = Number.parseInt(session.pageSlider.value, 10);
    if (!Number.isSafeInteger(next)) return;
    scrollToIndex(comicScrubTargetPage(session, next) - 1);
    feedback.sync();
  });
  const finishScrub = (): void => {
    feedback.hide();
    scheduleChromeHide(session);
  };
  session.pageSlider.addEventListener('pointerup', finishScrub);
  session.pageSlider.addEventListener('pointercancel', finishScrub);
  session.pageSlider.addEventListener('blur', () => feedback.hide());
}

export interface ComicPageJumpDialog {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** 页码输入合法性：仅接受十进制整数且落在 1..totalPages。 */
export function comicJumpTargetPage(raw: string, totalPages: number): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const page = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) return null;
  return page;
}

/**
 * 页码跳转对话框（懒创建，open 时挂载、close 时摘除，随 destroy 清理）。
 * 打开期间暂停 chrome 自动隐藏并保持 chrome 可见；关闭后重新计时。
 */
export function createComicPageJumpDialog(
  session: ComicSession,
  scrollToIndex: (index: number) => boolean,
): ComicPageJumpDialog {
  const dialogLabel = (): string => session.labels.jumpToPage ?? session.labels.pageSlider;
  let overlay: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let error: HTMLElement | null = null;

  const isOpen = (): boolean => overlay !== null;

  const clearError = (): void => {
    if (error !== null) error.textContent = '';
    input?.removeAttribute('aria-invalid');
  };

  const showError = (): void => {
    if (error !== null) {
      error.textContent = (session.labels.jumpToPageInvalid ?? '').replace(
        '{total}',
        String(session.images.length),
      );
    }
    input?.setAttribute('aria-invalid', 'true');
    input?.focus();
    input?.select();
  };

  const close = (): void => {
    if (overlay === null) return;
    overlay.remove();
    overlay = null;
    input = null;
    error = null;
    if (!session.destroyed) scheduleChromeHide(session);
  };

  const submit = (): void => {
    if (input === null) return;
    const page = comicJumpTargetPage(input.value, session.images.length);
    if (page === null) {
      showError();
      return;
    }
    scrollToIndex(page - 1);
    close();
  };

  const open = (): void => {
    if (overlay !== null || session.destroyed) return;
    const label = dialogLabel();
    overlay = document.createElement('div');
    overlay.className = 'lightink-reader-comic-jump';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', label);
    const panel = document.createElement('div');
    panel.className = 'lightink-reader-comic-jump-panel';
    const title = document.createElement('div');
    title.className = 'lightink-reader-comic-jump-title';
    title.textContent = label;
    const row = document.createElement('div');
    row.className = 'lightink-reader-comic-jump-row';
    input = document.createElement('input');
    input.className = 'lightink-reader-comic-jump-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.value = String(session.currentPage);
    input.setAttribute('aria-label', label);
    error = document.createElement('div');
    error.className = 'lightink-reader-comic-jump-error';
    error.setAttribute('aria-live', 'polite');
    const errorId = 'lightink-reader-comic-jump-error';
    error.id = errorId;
    input.setAttribute('aria-describedby', errorId);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'lightink-reader-comic-jump-confirm';
    confirm.textContent = session.labels.jumpToPageConfirm ?? label;
    confirm.addEventListener('click', submit);
    row.append(input, confirm);
    panel.append(title, row, error);
    overlay.append(panel);
    // 点背板关闭；面板内点击不冒泡到背板判断。
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });
    // IME 安全 keydown（TOC 搜索框口径）：组合期间的 Enter/Escape 不吞。
    input.addEventListener('keydown', (event) => {
      if (outlineSearchKeyIsComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (input !== null && input.value.trim() !== '') {
          input.value = '';
          clearError();
        } else {
          close();
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    });
    input.addEventListener('input', clearError);
    mountReaderOverlay(overlay, session.container);
    if (session.chromeTimer !== null) {
      clearTimeout(session.chromeTimer);
      session.chromeTimer = null;
    }
    setChromeVisible(session, true);
    input.focus();
    input.select();
  };

  return {
    open,
    close,
    isOpen,
    destroy(): void {
      close();
    },
  };
}

/** 顶栏 pageButton 点击从「聚焦滑杆」改为打开页码跳转对话框。 */
export function wireComicPageJump(
  session: ComicSession,
  scrollToIndex: (index: number) => boolean,
): ComicPageJumpDialog {
  const dialog = createComicPageJumpDialog(session, scrollToIndex);
  session.pageButton.addEventListener('click', () => {
    setChromeVisible(session, true);
    dialog.open();
  });
  return dialog;
}
