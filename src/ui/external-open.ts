/**
 * External file-association / second-instance open (R1).
 *
 * Running instance: restore the window first, open the file, switch to
 * the matching workspace surface, and show a short success or failure
 * prompt. Cold-start `take_pending_file` skips restore and the success
 * toast — the window is already appearing — but still switches surface
 * and uses the existing error dialog on failure.
 */

import { displayNameOfPath } from '../file/path-ext.js';

export type ExternalOpenSource = 'running' | 'cold-start';
export type ExternalOpenOrigin = ExternalOpenSource | 'runtime';
export type ExternalOpenLocale = 'en' | 'zh-CN';
export type ExternalOpenNotifyKind = 'success' | 'info' | 'warning' | 'error';
export type ExternalOpenSurface = 'reader' | 'editor';

export interface RevealableWindow {
  unminimize(): Promise<void>;
  show(): Promise<void>;
  setFocus(): Promise<void>;
  isMinimized?(): Promise<boolean>;
  isVisible?(): Promise<boolean>;
}

export interface ExternalOpenedTab {
  readonly kind: 'reader' | 'markdown';
  readonly title: string;
  readonly filePath?: string | null;
}

/** @deprecated Prefer ExternalOpenedTab. */
export type ExternalOpenTab = ExternalOpenedTab;

export interface ExternalOpenWorkspace {
  openBook(): unknown;
  enterReader(): unknown;
  enterEditor(): unknown;
}

export interface ExternalOpenLabels {
  /** Short success text; `name` is the tab title or file basename. */
  readonly opened: (name: string) => string;
  /** Opened, but the window could not be brought forward. */
  readonly revealFailed: (name: string) => string;
}

export const EXTERNAL_OPEN_LABELS: Record<ExternalOpenLocale, ExternalOpenLabels> = {
  en: {
    opened: (name) => `Opened ${name}`,
    revealFailed: (name) =>
      `Opened ${name}, but the window could not be brought to the front.`,
  },
  'zh-CN': {
    opened: (name) => `已打开 ${name}`,
    revealFailed: (name) => `已打开 ${name}，但未能把窗口带到前台。`,
  },
};

export interface ExternalOpenDeps {
  readonly openPath: (path: string) => Promise<ExternalOpenedTab | null>;
  readonly workspace: ExternalOpenWorkspace;
  readonly notify: (message: string, kind?: ExternalOpenNotifyKind) => void;
  /** Existing missing/load error dialog. Always used on open failure. */
  readonly reportOpenFailure: (path: string) => void;
  /** True when the existing window reached the foreground. */
  readonly restoreWindow: () => Promise<boolean>;
  readonly locale?: ExternalOpenLocale;
  readonly labels?: Partial<ExternalOpenLabels>;
}

/** Resolve the current Tauri window for restore, or null outside Tauri. */
export async function getRevealableWindow(): Promise<RevealableWindow | null> {
  try {
    const webviewMod = await import('@tauri-apps/api/webviewWindow');
    if (typeof webviewMod.getCurrentWebviewWindow === 'function') {
      return webviewMod.getCurrentWebviewWindow() as unknown as RevealableWindow;
    }
  } catch {
    /* try window module next */
  }
  try {
    const winMod = await import('@tauri-apps/api/window');
    if (typeof winMod.getCurrentWindow === 'function') {
      return winMod.getCurrentWindow() as unknown as RevealableWindow;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * True when the window is known to be on-screen, false when it is still
 * minimized or hidden, and undefined when neither query is available.
 */
async function windowIsShown(win: RevealableWindow): Promise<boolean | undefined> {
  let minimized: boolean | undefined;
  let visible: boolean | undefined;
  if (typeof win.isMinimized === 'function') {
    try {
      minimized = await win.isMinimized();
    } catch {
      /* query is best-effort */
    }
  }
  if (typeof win.isVisible === 'function') {
    try {
      visible = await win.isVisible();
    } catch {
      /* query is best-effort */
    }
  }
  if (minimized === undefined && visible === undefined) {
    return undefined;
  }
  if (minimized === true || visible === false) {
    return false;
  }
  return true;
}

/**
 * Unminimize, show, and focus an existing window so a file-association
 * or second-instance open is not a silent background tab change.
 * No native window (pure frontend) is treated as already visible.
 * An already-visible window counts as restored even if unminimize/show
 * throw; setFocus failure never decides the result.
 */
export async function revealExistingWindow(
  getWindow: () => Promise<RevealableWindow | null> = getRevealableWindow,
): Promise<boolean> {
  let win: RevealableWindow | null;
  try {
    win = await getWindow();
  } catch {
    return false;
  }
  if (win === null) {
    return true;
  }
  let restored = false;
  try {
    await win.unminimize();
    restored = true;
  } catch {
    /* window may already be visible */
  }
  try {
    await win.show();
    restored = true;
  } catch {
    /* show can fail independently of unminimize */
  }
  try {
    await win.setFocus();
  } catch {
    // Windows often denies focus steal when the app is already in the
    // foreground or another window owns the input queue.
  }
  if (restored) {
    return true;
  }
  return (await windowIsShown(win)) === true;
}

/** Tab title, or the last path segment when the title is empty. */
export function displayNameForExternalOpen(
  path: string,
  tab?: Pick<ExternalOpenedTab, 'title'> | null,
): string {
  const title = tab?.title.trim();
  if (title !== undefined && title.length > 0) {
    return title;
  }
  return displayNameOfPath(path);
}

export function resolveExternalOpenLabels(
  locale: ExternalOpenLocale = 'en',
  overrides?: Partial<ExternalOpenLabels>,
): ExternalOpenLabels {
  const base = EXTERNAL_OPEN_LABELS[locale] ?? EXTERNAL_OPEN_LABELS.en;
  return {
    opened: overrides?.opened ?? base.opened,
    revealFailed: overrides?.revealFailed ?? base.revealFailed,
  };
}

/**
 * Ebook → reader page (`openBook` + `enterReader`).
 * Markdown → editor surface on that tab (`enterEditor`).
 */
export function applyExternalOpenSurface(
  tab: ExternalOpenedTab,
  workspace: ExternalOpenWorkspace,
): ExternalOpenSurface {
  if (tab.kind === 'reader') {
    workspace.openBook();
    workspace.enterReader();
    return 'reader';
  }
  workspace.enterEditor();
  return 'editor';
}

function isColdStart(source: ExternalOpenOrigin): boolean {
  return source === 'cold-start';
}

/**
 * Where a cold start lands before its first pending file is opened.
 *
 * - `shelf`: no file, or an ebook — build and show the cover wall first
 *   (existing behavior; the book then lands on the reader).
 * - `editor`: desktop Markdown — enter the editor before the open so the
 *   shelf is never built or loaded, even if the file turns out missing.
 * - `open-first`: immersive (Android/touch) Markdown — the reader surface
 *   comes from the open itself; only fall back to the shelf when the open
 *   fails and the workspace is still on the shelf.
 */
export type ColdStartSurfacePlan = 'shelf' | 'editor' | 'open-first';

export function planColdStartSurface(
  startupPath: string | null,
  options: { readonly isReaderPath: (path: string) => boolean; readonly immersive: boolean },
): ColdStartSurfacePlan {
  if (startupPath === null || options.isReaderPath(startupPath)) {
    return 'shelf';
  }
  return options.immersive ? 'open-first' : 'editor';
}

function announceExternalOpen(
  source: ExternalOpenOrigin,
  restored: boolean,
  name: string,
  deps: Pick<ExternalOpenDeps, 'notify' | 'locale' | 'labels'>,
): void {
  if (isColdStart(source)) {
    return;
  }
  const labels = resolveExternalOpenLabels(deps.locale, deps.labels);
  if (!restored) {
    deps.notify(labels.revealFailed(name), 'warning');
    return;
  }
  deps.notify(labels.opened(name), 'success');
}

/**
 * Restore the window (running source only), open `path`, switch to the
 * matching surface, and announce the result. Open failure uses the
 * existing error dialog — never a silent no-op.
 */
export async function handleExternalOpen(
  path: string,
  source: ExternalOpenOrigin,
  deps: ExternalOpenDeps,
): Promise<ExternalOpenedTab | null> {
  let restored = true;
  if (!isColdStart(source)) {
    try {
      restored = await deps.restoreWindow();
    } catch {
      restored = false;
    }
  }

  let tab: ExternalOpenedTab | null;
  try {
    tab = await deps.openPath(path);
  } catch {
    deps.reportOpenFailure(path);
    return null;
  }
  if (tab === null) {
    deps.reportOpenFailure(path);
    return null;
  }

  applyExternalOpenSurface(tab, deps.workspace);
  announceExternalOpen(source, restored, displayNameForExternalOpen(path, tab), deps);
  return tab;
}
