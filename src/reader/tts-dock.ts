/**
 * In-session TTS dock (ADR-4): pause / resume / stop / rate.
 * Desktop sits near the footer; touch uses the existing sheet transition.
 * Not a chrome action and not an Annotation surface.
 */

import type { MessageKey } from '../i18n/messages.js';
import {
  adoptReaderOverlayTheme,
  mountReaderOverlay,
  pinFixedOverlay,
  readerChromeFooterInset,
  unpinFixedOverlay,
} from './reader-chrome-panels.js';
import { concealSheet, revealSheet } from '../ui/touch/sheet-transition.js';
import { readerChromeTouchMode } from './view/reader-dom.js';

export const TTS_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
const TTS_DOCK_STYLE_ID = 'lightink-reader-tts-dock-style';

export function nextTtsRate(
  current: number,
): (typeof TTS_RATES)[number] {
  const index = TTS_RATES.findIndex((rate) => rate === current);
  const at = index < 0 ? 0 : (index + 1) % TTS_RATES.length;
  return TTS_RATES[at]!;
}

function formatTtsRate(value: number): string {
  return `${value}×`;
}

export interface TtsDockDeps {
  t: (key: MessageKey) => string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRate: (rate: number) => void;
}

export interface TtsDock {
  readonly element: HTMLElement;
  show(host: HTMLElement): void;
  showError(host: HTMLElement, message: string): void;
  setPaused(paused: boolean): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

function ensureDockStyle(doc: Document): void {
  let style = doc.getElementById(TTS_DOCK_STYLE_ID) as HTMLStyleElement | null;
  if (style === null) {
    style = doc.createElement('style');
    style.id = TTS_DOCK_STYLE_ID;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = `
.lightink-reader-tts-dock {
  position: fixed;
  z-index: 28;
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.35rem;
  width: max-content;
  max-width: calc(100vw - 24px);
  padding: 0.35rem 0.4rem;
  color: var(--lightink-fg);
  background: var(--lightink-bg-elevated);
  border: 1px solid color-mix(in srgb, var(--lightink-border) 70%, transparent);
  border-radius: 14px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--lightink-fg) 4%, transparent),
    0 8px 24px rgba(0, 0, 0, 0.16);
  font-family: var(--lightink-font-ui);
  font-size: 0.82rem;
  pointer-events: auto;
}
.lightink-reader-tts-dock.lightink-reader-chrome-popover::before {
  display: none;
}
.lightink-reader-tts-dock[hidden] { display: none; }
.lightink-reader-tts-dock-title {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.lightink-reader-tts-dock-error {
  margin: 0;
  flex: 1 1 100%;
}
.lightink-reader-tts-dock[data-tts-status='playing'] .lightink-reader-tts-dock-error,
.lightink-reader-tts-dock[data-tts-status='paused'] .lightink-reader-tts-dock-error { display: none; }
.lightink-reader-tts-dock[data-tts-status='error'] [data-tts-action='pause'],
.lightink-reader-tts-dock[data-tts-status='error'] [data-tts-action='resume'],
.lightink-reader-tts-dock[data-tts-status='error'] .lightink-reader-tts-rate { display: none; }
.lightink-reader-tts-dock button {
  flex: 0 0 auto;
  padding: 0.25rem 0.6rem;
  border: 0;
  border-radius: 8px;
  background: color-mix(in srgb, var(--lightink-fg) 8%, transparent);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.lightink-reader-tts-dock .lightink-reader-tts-rate {
  min-width: 3.1em;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
:is(html[data-android], html[data-touch-primary]) .lightink-reader-tts-dock.is-touch-sheet {
  width: auto;
  max-width: none;
  justify-content: center;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  transition: transform 220ms ease-out, opacity 220ms ease-out;
}
:is(html[data-android], html[data-touch-primary])
  .lightink-reader-tts-dock.is-touch-sheet:not([data-open]) {
  transform: translateY(100%);
  opacity: 0;
}
:is(html[data-android], html[data-touch-primary]) .lightink-reader-tts-dock button {
  min-height: 48px;
  min-width: 48px;
}
`;
}

function positionDock(panel: HTMLElement, host: HTMLElement): void {
  if (readerChromeTouchMode()) {
    panel.style.removeProperty('transform');
    panel.style.removeProperty('max-width');
    pinFixedOverlay(panel, host);
    return;
  }
  unpinFixedOverlay(panel);
  panel.classList.remove('is-touch-sheet');
  const box = host.getBoundingClientRect();
  const inset = readerChromeFooterInset(host.ownerDocument);
  panel.style.position = 'fixed';
  panel.style.left = `${box.left + box.width / 2}px`;
  panel.style.width = 'max-content';
  panel.style.maxWidth = `${Math.max(160, box.width - 24)}px`;
  panel.style.right = 'auto';
  panel.style.top = 'auto';
  panel.style.bottom = `${Math.max(12, inset + 12)}px`;
  panel.style.transform = 'translateX(-50%)';
}

export function createTtsDock(deps: TtsDockDeps): TtsDock {
  const root = document.createElement('div');
  root.className = 'lightink-reader-tts-dock lightink-reader-chrome-popover';
  root.setAttribute('role', 'group');
  root.hidden = true;

  const title = document.createElement('p');
  title.className = 'lightink-reader-tts-dock-title';
  const error = document.createElement('p');
  error.className = 'lightink-reader-tts-dock-error';
  error.setAttribute('aria-live', 'polite');

  const pause = document.createElement('button');
  pause.type = 'button';
  pause.dataset.ttsAction = 'pause';
  const resume = document.createElement('button');
  resume.type = 'button';
  resume.dataset.ttsAction = 'resume';
  resume.hidden = true;
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.dataset.ttsAction = 'stop';

  const rate = document.createElement('button');
  rate.type = 'button';
  rate.className = 'lightink-reader-tts-rate';
  rate.dataset.ttsAction = 'rate';
  let currentRate: (typeof TTS_RATES)[number] = 1;
  const syncRate = (): void => {
    rate.textContent = formatTtsRate(currentRate);
    rate.dataset.rate = String(currentRate);
    const rateName = deps.t('reader.tts.rate');
    rate.setAttribute('aria-label', `${rateName} ${formatTtsRate(currentRate)}`);
    rate.title = rateName;
  };
  root.append(title, error, pause, resume, stop, rate);

  const syncCopy = (): void => {
    title.textContent = deps.t('reader.tts.dock');
    root.setAttribute('aria-label', deps.t('reader.tts.dock'));
    pause.textContent = deps.t('reader.tts.pause');
    pause.setAttribute('aria-label', deps.t('reader.tts.pause'));
    resume.textContent = deps.t('reader.tts.resume');
    resume.setAttribute('aria-label', deps.t('reader.tts.resume'));
    stop.textContent = deps.t('reader.tts.stop');
    stop.setAttribute('aria-label', deps.t('reader.tts.stop'));
    syncRate();
  };
  syncCopy();

  const setPaused = (paused: boolean): void => {
    if (root.dataset.ttsStatus === 'error') {
      return;
    }
    root.dataset.ttsStatus = paused ? 'paused' : 'playing';
    pause.hidden = paused;
    resume.hidden = !paused;
  };

  const hide = (): void => {
    if (readerChromeTouchMode()) {
      concealSheet(root, () => {
        root.hidden = true;
        unpinFixedOverlay(root);
      });
      return;
    }
    delete root.dataset.open;
    root.hidden = true;
  };

  const present = (host: HTMLElement, status: 'playing' | 'error', message = ''): void => {
    ensureDockStyle(root.ownerDocument ?? document);
    syncCopy();
    root.dataset.ttsStatus = status;
    error.textContent = message;
    pause.hidden = status === 'error';
    resume.hidden = true;
    rate.hidden = status === 'error';
    root.hidden = false;
    mountReaderOverlay(root, host);
    adoptReaderOverlayTheme(root, host);
    positionDock(root, host);
    revealSheet(root);
  };

  pause.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.onPause();
    setPaused(true);
  });
  resume.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.onResume();
    setPaused(false);
  });
  stop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    deps.onStop();
    hide();
  });
  rate.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    currentRate = nextTtsRate(currentRate);
    syncRate();
    deps.onRate(currentRate);
  });
  return {
    element: root,
    show(host) {
      present(host, 'playing');
    },
    showError(host, message) {
      present(host, 'error', message);
    },
    setPaused,
    hide,
    isVisible() {
      return !root.hidden;
    },
    destroy() {
      hide();
      unpinFixedOverlay(root);
      root.remove();
    },
  };
}
