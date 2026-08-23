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
 * Unminimize, show, and focus an existing window so a file-association
 * or second-instance open is not a silent background tab change.
 * No native window (pure frontend) is treated as already visible.
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
  try {
    await win.unminimize();
    await win.show();
    await win.setFocus();
    return true;
  } catch {
    return false;
  }
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
