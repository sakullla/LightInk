/**
 * Native window chrome helpers (fullscreen). Thin wrapper around Tauri window
 * API so unit tests can inject a fake; browser-only fallbacks are no-ops.
 */

export interface AppWindowLike {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setDecorations?(decorations: boolean): Promise<void>;
  setTheme?(theme: 'light' | 'dark' | null): Promise<void>;
  minimize?(): Promise<void>;
  toggleMaximize?(): Promise<void>;
  close?(): Promise<void>;
  isMaximized?(): Promise<boolean>;
  onResized?(handler: () => void): Promise<(() => void) | void>;
}

/** Resolve the current Tauri webview/window, or null outside Tauri. */
export async function getAppWindow(): Promise<AppWindowLike | null> {
  // Prefer WebviewWindow (Tauri v2 primary surface), then Window.
  try {
    const webviewMod = await import('@tauri-apps/api/webviewWindow');
    if (typeof webviewMod.getCurrentWebviewWindow === 'function') {
      return webviewMod.getCurrentWebviewWindow() as unknown as AppWindowLike;
    }
  } catch {
    /* try window module next */
  }
  try {
    const winMod = await import('@tauri-apps/api/window');
    if (typeof winMod.getCurrentWindow === 'function') {
      return winMod.getCurrentWindow() as unknown as AppWindowLike;
    }
  } catch {
    return null;
  }
  return null;
}

/** Toggle native fullscreen; returns the new fullscreen state (false if unavailable). */
export async function toggleFullscreen(
  getWindow: () => Promise<AppWindowLike | null> = getAppWindow,
): Promise<boolean> {
  const win = await getWindow();
  if (win === null) {
    return false;
  }
  try {
    const current = await win.isFullscreen();
    const next = !current;
    await win.setFullscreen(next);
    return next;
  } catch (error) {
    // Permission / platform failure — do not throw into UI hotkey path.
    // eslint-disable-next-line no-console
    console.error('[lightink] setFullscreen failed', error);
    return false;
  }
}

/** Show/hide the native title bar (window decorations); no-op outside Tauri. */
export async function setNativeTitleBar(
  visible: boolean,
  getWindow: () => Promise<AppWindowLike | null> = getAppWindow,
): Promise<void> {
  const win = await getWindow();
  if (win === null || typeof win.setDecorations !== 'function') {
    return;
  }
  try {
    await win.setDecorations(visible);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[lightink] setDecorations failed', error);
  }
}

/** Sync the native window theme (title bar dark/light) with the app theme. */
export async function setNativeTheme(
  dark: boolean,
  getWindow: () => Promise<AppWindowLike | null> = getAppWindow,
): Promise<void> {
  const win = await getWindow();
  if (win === null || typeof win.setTheme !== 'function') {
    return;
  }
  try {
    await win.setTheme(dark ? 'dark' : 'light');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[lightink] setTheme failed', error);
  }
}

export interface NativeCaptionColors {
  readonly caption: string;
  readonly text: string;
}

export type NativeCaptionInvoke = (
  cmd: string,
  args: { caption: string | null; text: string | null },
) => Promise<unknown>;

/**
 * Tint the native caption to match paper, or pass null to restore the
 * system default. Windows 11 uses DWM caption color; macOS uses a
 * transparent titlebar plus window background; Linux tints GTK CSD
 * titlebars. Server-side window-manager bars stay light/dark only.
 */
export async function setNativeCaptionColors(
  colors: NativeCaptionColors | null,
  invokeFn?: NativeCaptionInvoke,
): Promise<void> {
  try {
    const invoke = invokeFn ?? (await import('@tauri-apps/api/core')).invoke;
    await invoke('set_window_caption_color', {
      caption: colors?.caption ?? null,
      text: colors?.text ?? null,
    });
  } catch {
    /* browser preview or unsupported host */
  }
}
