/**
 * Client title bar: drag region + caption buttons.
 * Replaces the native Windows/Linux strip so the shelf and editor share one chrome.
 */

import {
  getAppWindow,
  syncNativeWindowOuterRounded,
  type AppWindowLike,
  type NativeWindowOuterRoundedInvoke,
} from './window-chrome.js';

export type TitlebarLocale = 'en' | 'zh-CN';

export interface WindowTitlebarOptions {
  getWindow?: () => Promise<AppWindowLike | null>;
  getLocale?: () => TitlebarLocale;
  invokeOuterRounded?: NativeWindowOuterRoundedInvoke;
}

export interface WindowTitlebar {
  readonly element: HTMLElement;
  retranslate(): void;
  dispose(): void;
}

const LABELS: Record<TitlebarLocale, { min: string; max: string; restore: string; close: string }> = {
  en: { min: 'Minimize', max: 'Maximize', restore: 'Restore', close: 'Close' },
  'zh-CN': { min: '最小化', max: '最大化', restore: '向下还原', close: '关闭' },
};

function captionButton(doc: Document, name: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `lightink-window-caption lightink-window-caption--${name}`;
  button.dataset.windowCaption = name;
  const mark = doc.createElement('span');
  mark.setAttribute('aria-hidden', 'true');
  button.appendChild(mark);
  return button;
}

const TITLEBAR_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-fg',
  '--lightink-muted',
  '--lightink-border',
  '--lightink-accent',
  '--lightink-accent-soft',
  '--lightink-overlay',
  '--lightink-shadow',
  '--lightink-danger',
] as const;

export const READER_CHROME_REVEALED_CLASS = 'is-reader-chrome-revealed';

export function syncReaderTitlebarReveal(
  root: ParentNode | Element | null | undefined,
  revealed: boolean,
): void {
  const fromTree =
    root instanceof Element
      ? root.closest('#app')
      : root instanceof Document
        ? root.getElementById('app')
        : null;
  const app =
    fromTree ??
    (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('app')
      : null);
  app?.classList.toggle(READER_CHROME_REVEALED_CLASS, revealed);
}

export function resetWindowTitlebarTheme(root: HTMLElement): void {
  delete root.dataset.libraryTheme;
  delete root.dataset.readerTheme;
  if (typeof root.style.removeProperty !== 'function') {
    return;
  }
  for (const name of TITLEBAR_THEME_VARS) {
    root.style.removeProperty(name);
  }
  root.style.colorScheme = '';
  root.style.color = '';
  root.style.backgroundColor = '';
}

export function createWindowTitlebar(
  doc: Document,
  options: WindowTitlebarOptions = {},
): WindowTitlebar {
  const getWindow = options.getWindow ?? getAppWindow;
  const getLocale = options.getLocale ?? ((): TitlebarLocale => 'zh-CN');
  const invokeOuterRounded = options.invokeOuterRounded;

  const element = doc.createElement('div');
  element.id = 'lightink-window-titlebar';
  element.className = 'lightink-window-titlebar';
  element.setAttribute('data-tauri-drag-region', '');

  const drag = doc.createElement('div');
  drag.className = 'lightink-window-titlebar-drag';
  drag.setAttribute('data-tauri-drag-region', '');

  const controls = doc.createElement('div');
  controls.className = 'lightink-window-titlebar-controls';
  const min = captionButton(doc, 'min');
  const max = captionButton(doc, 'max');
  const close = captionButton(doc, 'close');
  controls.append(min, max, close);
  element.append(drag, controls);

  let disposed = false;
  let maximized = false;

  const labels = (): (typeof LABELS)[TitlebarLocale] => LABELS[getLocale()] ?? LABELS['zh-CN'];

  const syncLabels = (): void => {
    const l = labels();
    min.title = l.min;
    min.setAttribute('aria-label', l.min);
    close.title = l.close;
    close.setAttribute('aria-label', l.close);
    const maxLabel = maximized ? l.restore : l.max;
    max.title = maxLabel;
    max.setAttribute('aria-label', maxLabel);
    max.dataset.maximized = maximized ? 'true' : 'false';
  };

  const withWindow = async (run: (win: AppWindowLike) => Promise<void>): Promise<void> => {
    if (disposed) return;
    try {
      const win = await getWindow();
      if (win === null || disposed) return;
      await run(win);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[lightink] window chrome failed', error);
    }
  };

  const refreshMaximized = (): void => {
    void withWindow(async (win) => {
      if (typeof win.isMaximized === 'function') {
        maximized = await win.isMaximized();
        syncLabels();
      }
      await syncNativeWindowOuterRounded(async () => win, invokeOuterRounded);
    });
  };

  min.addEventListener('click', (event) => {
    event.stopPropagation();
    void withWindow(async (win) => {
      await win.minimize?.();
    });
  });
  max.addEventListener('click', (event) => {
    event.stopPropagation();
    void withWindow(async (win) => {
      await win.toggleMaximize?.();
      refreshMaximized();
      doc.defaultView?.dispatchEvent(new Event('resize'));
    });
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    void withWindow(async (win) => {
      await win.close?.();
    });
  });
  element.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement | null)?.closest?.('.lightink-window-caption')) {
      return;
    }
    void withWindow(async (win) => {
      await win.toggleMaximize?.();
      refreshMaximized();
      doc.defaultView?.dispatchEvent(new Event('resize'));
    });
  });

  let unlistenResize: (() => void) | undefined;
  void withWindow(async (win) => {
    if (typeof win.onResized !== 'function') return;
    const unlisten = await win.onResized(() => {
      refreshMaximized();
    });
    if (typeof unlisten === 'function') {
      unlistenResize = unlisten;
    }
  });

  syncLabels();
  refreshMaximized();

  return {
    element,
    retranslate: syncLabels,
    dispose(): void {
      disposed = true;
      unlistenResize?.();
    },
  };
}
