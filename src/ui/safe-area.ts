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
  }
}

function cssPx(value: number): string {
  const next = Number.isFinite(value) && value > 0 ? value : 0;
  return `${next}px`;
}

export function applySafeAreaInsets(
  insets: SafeAreaInsets,
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
  if (root === null) {
    return;
  }
  root.style.setProperty('--lightink-safe-top', cssPx(insets.top));
  root.style.setProperty('--lightink-safe-right', cssPx(insets.right));
  root.style.setProperty('--lightink-safe-bottom', cssPx(insets.bottom));
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
    const keyboard =
      viewport == null
        ? 0
        : Math.max(0, host.innerHeight - viewport.height - viewport.offsetTop);
    root.style.setProperty('--lightink-keyboard-inset', cssPx(keyboard));
  };
  apply();
  const canListen =
    viewport != null &&
    typeof viewport.addEventListener === 'function' &&
    typeof host.addEventListener === 'function';
  if (!canListen || viewport == null) {
    return () => undefined;
  }
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  host.addEventListener('resize', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    host.removeEventListener('resize', apply);
  };
}
