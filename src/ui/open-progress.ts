/**
 * Full-screen open/download progress overlay used while a book is fetched
 * or parsed. One instance at a time; nested begins share the same card.
 * The card waits {@link OPEN_PROGRESS_APPEAR_MS} before mounting so fast
 * opens never flash a dialog. Cancel aborts the in-flight open immediately.
 */

import { adoptDialogSurfaceTheme, inferDialogThemeHost } from './confirm-dialog.js';

/** Wait this long before showing the overlay. Faster opens stay silent. */
export const OPEN_PROGRESS_APPEAR_MS = 1500;

export interface OpenProgressUpdate {
  readonly title?: string;
  readonly label?: string;
  readonly cancelLabel?: string;
  /** Inclusive 0..1. Omit or pass NaN for an indeterminate bar. */
  readonly ratio?: number;
}

export interface OpenProgressOptions extends OpenProgressUpdate {
  readonly cancelLabel?: string;
  readonly onCancel?: () => void;
  /** Override the appear delay. Tests pass `0` to mount immediately. */
  readonly appearAfterMs?: number;
}

export interface OpenProgressHandle {
  update(next: OpenProgressUpdate): void;
  close(): void;
}

interface OpenProgressSession {
  readonly overlay: HTMLElement | null;
  update(next: OpenProgressUpdate): void;
  setCancel(onCancel: (() => void) | undefined): void;
  destroy(): void;
}

let session: OpenProgressSession | null = null;
let depth = 0;

function clampRatio(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function currentSession(): OpenProgressSession | null {
  if (session !== null && session.overlay !== null && !session.overlay.isConnected) {
    session = null;
    depth = 0;
  }
  return session;
}

function mountDialog(
  options: OpenProgressOptions,
  onCancelRef: { current: (() => void) | undefined },
): { overlay: HTMLElement; paint: (next: OpenProgressUpdate) => void } {
  const doc = document;
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-open-progress';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-busy', 'true');

  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-open-progress-dialog';

  const title = doc.createElement('h2');
  title.className = 'lightink-modal-title';

  const label = doc.createElement('p');
  label.className = 'lightink-modal-message lightink-open-progress-label';

  const track = doc.createElement('div');
  track.className = 'lightink-open-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');

  const fill = doc.createElement('div');
  fill.className = 'lightink-open-progress-fill';
  track.appendChild(fill);

  const percent = doc.createElement('p');
  percent.className = 'lightink-open-progress-percent';
  percent.hidden = true;

  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'lightink-modal-btn lightink-modal-btn--plain lightink-open-progress-cancel';
  cancel.hidden = options.cancelLabel === undefined || options.cancelLabel === '';

  dialog.append(title, label, track, percent, cancel);
  overlay.appendChild(dialog);
  const themeHost = inferDialogThemeHost(doc);
  if (themeHost !== null) adoptDialogSurfaceTheme(overlay, themeHost);
  doc.body.appendChild(overlay);

  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancel.disabled = true;
    onCancelRef.current?.();
    overlay.remove();
  });

  const paint = (next: OpenProgressUpdate): void => {
    if (next.title !== undefined) {
      title.textContent = next.title;
      overlay.setAttribute('aria-label', next.title);
    }
    if (next.label !== undefined) label.textContent = next.label;
    if (next.cancelLabel !== undefined) {
      cancel.textContent = next.cancelLabel;
      cancel.hidden = next.cancelLabel === '';
    }
    const ratio = clampRatio(next.ratio);
    if (ratio === undefined) {
      overlay.dataset.progressDeterminate = 'false';
      track.removeAttribute('aria-valuenow');
      fill.style.removeProperty('--lightink-open-progress');
      percent.hidden = true;
      percent.textContent = '';
      return;
    }
    overlay.dataset.progressDeterminate = 'true';
    const shown = Math.round(ratio * 100);
    track.setAttribute('aria-valuenow', String(shown));
    fill.style.setProperty('--lightink-open-progress', String(ratio));
    percent.hidden = false;
    percent.textContent = `${shown}%`;
  };

  paint({
    title: options.title ?? '',
    label: options.label ?? '',
    cancelLabel: options.cancelLabel,
    ratio: options.ratio,
  });

  return { overlay, paint };
}

function createSession(options: OpenProgressOptions): OpenProgressSession {
  const onCancelRef: { current: (() => void) | undefined } = { current: options.onCancel };
  let snapshot: OpenProgressOptions = { ...options };
  let mounted: { overlay: HTMLElement; paint: (next: OpenProgressUpdate) => void } | null = null;
  let appearTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  const delay = options.appearAfterMs ?? OPEN_PROGRESS_APPEAR_MS;

  const ensureMounted = (): void => {
    if (destroyed || mounted !== null) return;
    mounted = mountDialog(snapshot, onCancelRef);
  };

  if (delay <= 0) {
    ensureMounted();
  } else {
    appearTimer = globalThis.setTimeout(() => {
      appearTimer = null;
      ensureMounted();
    }, delay);
  }

  return {
    get overlay() {
      return mounted?.overlay ?? null;
    },
    update(next) {
      snapshot = { ...snapshot, ...next };
      mounted?.paint(next);
    },
    setCancel(next) {
      const previous = onCancelRef.current;
      onCancelRef.current =
        next === undefined
          ? previous
          : () => {
              previous?.();
              next();
            };
    },
    destroy() {
      destroyed = true;
      if (appearTimer !== null) {
        globalThis.clearTimeout(appearTimer);
        appearTimer = null;
      }
      mounted?.overlay.remove();
      mounted = null;
    },
  };
}

/** Show or reuse the open-progress card. Pair every call with `close()`. */
export function beginOpenProgress(options: OpenProgressOptions = {}): OpenProgressHandle {
  const existing = currentSession();
  if (existing === null) {
    session = createSession(options);
  } else {
    existing.update(options);
    if (options.onCancel !== undefined) existing.setCancel(options.onCancel);
  }
  depth += 1;
  let closed = false;
  return {
    update(next) {
      if (!closed) currentSession()?.update(next);
    },
    close() {
      if (closed) return;
      closed = true;
      depth = Math.max(0, depth - 1);
      if (depth > 0) return;
      currentSession()?.destroy();
      session = null;
    },
  };
}
