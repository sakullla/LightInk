/**
 * Safe-area insets for edge-to-edge Android / notched phones.
 *
 * Official practice (Android edge-to-edge + WebView insets): draw the paper
 * behind system bars, but keep text and controls out of
 * `systemBars() | displayCutout()`. CSS `env(safe-area-inset-*)` is the
 * default; older WebViews report 0 even when the status bar overlaps, so
 * MainActivity injects `window.__lightinkSafeArea` / `__lightinkApplySafeArea`.
 */

export interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

declare global {
  interface Window {
    __lightinkSafeArea?: SafeAreaInsets;
    __lightinkApplySafeArea?: (insets: SafeAreaInsets) => void;
    __lightinkKeyboardInset?: number;
    __lightinkApplyKeyboardInset?: (inset: number) => void;
  }
}

function cssPx(value: number): string {
  const next = Number.isFinite(value) && value > 0 ? value : 0;
  return `${next}px`;
}

/** Gesture-nav WebViews often report a 0 bottom inset; keep the CSS floor. */
const ANDROID_SAFE_BOTTOM_FLOOR = 16;

export function applySafeAreaInsets(
  insets: SafeAreaInsets,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
  if (root === null) {
    return;
  }
  const bottom =
    Number.isFinite(insets.bottom) && insets.bottom > 0
      ? insets.bottom
      : root.hasAttribute('data-android')
        ? ANDROID_SAFE_BOTTOM_FLOOR
        : 0;
  root.style.setProperty('--lightink-safe-top', cssPx(insets.top));
  root.style.setProperty('--lightink-safe-right', cssPx(insets.right));
  root.style.setProperty('--lightink-safe-bottom', cssPx(bottom));
  root.style.setProperty('--lightink-safe-left', cssPx(insets.left));
}

export function bindSafeAreaBridge(
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
  host: Window | null = typeof window !== 'undefined' ? window : null,
): () => void {
  if (root === null || host === null) {
    return () => undefined;
  }
  const apply = (insets: SafeAreaInsets): void => {
    applySafeAreaInsets(insets, root);
  };
  host.__lightinkApplySafeArea = apply;
  const existing = host.__lightinkSafeArea;
  if (
    existing !== undefined &&
    typeof existing.top === 'number' &&
    typeof existing.right === 'number' &&
    typeof existing.bottom === 'number' &&
    typeof existing.left === 'number'
  ) {
    apply(existing);
  }
  const unbindKeyboard = bindVisualViewportInsets(root, host);
  return () => {
    unbindKeyboard();
    if (host.__lightinkApplySafeArea === apply) {
      delete host.__lightinkApplySafeArea;
    }
  };
}

const KEYBOARD_OPEN_FLOOR = 80;

function visualKeyboardInset(
  host: Window,
  viewport: Pick<VisualViewport, 'height' | 'offsetTop'> | null | undefined,
): number {
  if (viewport == null) {
    return 0;
  }
  return Math.max(0, host.innerHeight - viewport.height - viewport.offsetTop);
}

function writeKeyboardInset(root: HTMLElement, keyboard: number): void {
  root.style.setProperty('--lightink-keyboard-inset', cssPx(keyboard));
  if (keyboard >= KEYBOARD_OPEN_FLOOR) {
    root.setAttribute('data-keyboard', '');
  } else {
    root.removeAttribute('data-keyboard');
  }
}

/**
 * Edge-to-edge Android WebViews often keep visualViewport full-height while
 * the IME overlays the page. MainActivity pushes WindowInsetsCompat.Type.ime()
 * through this hook; visualViewport remains the fallback on other platforms.
 */
export function applyKeyboardInset(
  inset: number,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
  host: Window | null = typeof window !== 'undefined' ? window : null,
): void {
  if (root === null) {
    return;
  }
  const native = Number.isFinite(inset) && inset > 0 ? inset : 0;
  const visual = host == null ? 0 : visualKeyboardInset(host, host.visualViewport);
  writeKeyboardInset(root, Math.max(native, visual));
}

/**
 * IME / visualViewport overlap. Official WebView practice is to resize the
 * visual viewport; we expose the obscured bottom as `--lightink-keyboard-inset`
 * so fixed dialogs can sit above the keyboard.
 */
export function bindVisualViewportInsets(
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
  host: Window | null = typeof window !== 'undefined' ? window : null,
): () => void {
  if (root === null || host === null) {
    return () => undefined;
  }
  const viewport = host.visualViewport;
  const apply = (): void => {
    const pending = host.__lightinkKeyboardInset;
    const native = typeof pending === 'number' && pending > 0 ? pending : 0;
    writeKeyboardInset(root, Math.max(native, visualKeyboardInset(host, viewport)));
  };
  host.__lightinkApplyKeyboardInset = (inset: number): void => {
    host.__lightinkKeyboardInset = inset;
    applyKeyboardInset(inset, root, host);
  };
  apply();
  const canListen =
    viewport != null &&
    typeof viewport.addEventListener === 'function' &&
    typeof host.addEventListener === 'function';
  if (!canListen || viewport == null) {
    return () => {
      if (host.__lightinkApplyKeyboardInset !== undefined) {
        delete host.__lightinkApplyKeyboardInset;
      }
    };
  }
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  host.addEventListener('resize', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    host.removeEventListener('resize', apply);
    if (host.__lightinkApplyKeyboardInset !== undefined) {
      delete host.__lightinkApplyKeyboardInset;
    }
  };
}
