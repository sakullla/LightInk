/**
 * Display scale — layout tier across common desktop resolutions.
 *
 * Why JS + CSS:
 *   Pure CSS `min-width` sees *CSS pixels*. On Windows a 4K panel at 200%
 *   scaling often reports ~1920 CSS px (same as 1080p@100%), so media queries
 *   alone cannot distinguish them. We combine viewport width with an estimate of
 *   physical width (`screen.width * devicePixelRatio`) and stamp
 *   `document.documentElement.dataset.display` for token overrides in theme.css.
 *
 * Tiers (common cases):
 *   - compact — <1080p / small laptop / narrow window (≤1366-class)
 *   - hd      — ≈1080p default
 *   - qhd     — 1440p / large laptop / 4K@150%
 *   - uhd     — 4K native / high-DPI 4K
 *   - xuhd    — >4K (5K / 8K / ultra-wide 4K+)
 */

export type DisplayTier = 'compact' | 'hd' | 'qhd' | 'uhd' | 'xuhd';

export interface DisplayMetrics {
  readonly innerWidth: number;
  readonly screenWidth: number;
  readonly devicePixelRatio: number;
}

/** Pure: map metrics → tier (unit-testable, no DOM). */
export function resolveDisplayTier(m: DisplayMetrics): DisplayTier {
  const dpr = Number.isFinite(m.devicePixelRatio) && m.devicePixelRatio > 0 ? m.devicePixelRatio : 1;
  // Prefer live viewport for "window is small"; fall back to screen for maximized.
  const viewport = m.innerWidth || m.screenWidth || 0;
  const screen = m.screenWidth || m.innerWidth || 0;
  // Approximate physical horizontal pixels (best-effort on Windows DPI scaling).
  const physicalWidth = screen * dpr;

  // 1) Compact first: narrow *window* always wins over large *screen*.
  //    Half-tiled 960px pane on a 2560 monitor must not inherit qhd gutters.
  if (viewport > 0 && viewport < 1280) {
    return 'compact';
  }
  // Small native panels (old 1366 laptops at 100%).
  if (viewport > 0 && viewport < 1400 && physicalWidth > 0 && physicalWidth < 1500) {
    return 'compact';
  }

  // Layout follows the live window. A restored 1400px pane on a 2K/4K
  // monitor must stay hd — only a filled window may lift via physical px
  // (4K@200% still reports CSS ~1920).
  const fillsScreen = screen > 0 && viewport >= screen * 0.88;
  const cssWidth = viewport;

  const physical = fillsScreen ? physicalWidth : 0;

  // 2) >4K: 5K (~5120), 8K, or ultra-wide high-DPI.
  if (cssWidth >= 4400 || physical >= 5000) {
    return 'xuhd';
  }
  // 3) 4K class: native 4K, or high-DPR panel with large physical width.
  //    (4K@200% → CSS ~1920 + physical 3840 → uhd, not hd.)
  if (cssWidth >= 3000 || physical >= 3400) {
    return 'uhd';
  }
  // 4) 2K / large laptop: 1440p (2560), ultrawide, 4K@~150% CSS ~2560.
  //    Keep 1920 (classic 1080p@100%) as hd — floor is 2200, not 1600.
  if (cssWidth >= 2200 || physical >= 2500) {
    return 'qhd';
  }
  return 'hd';
}

export interface DisplayScaleHandle {
  /** Current tier. */
  readonly tier: DisplayTier;
  /** Recompute from live window metrics. */
  refresh(): DisplayTier;
  /** Stop resize/DPR listeners. */
  dispose(): void;
}

/**
 * Apply `data-display` on the root element and keep it in sync with resize.
 * Safe to call once at app boot.
 */
export function installDisplayScale(
  root: HTMLElement = document.documentElement,
  win: Window = window,
): DisplayScaleHandle {
  const read = (): DisplayMetrics => ({
    innerWidth: win.innerWidth,
    screenWidth: win.screen?.width ?? win.innerWidth,
    devicePixelRatio: win.devicePixelRatio || 1,
  });

  let tier = resolveDisplayTier(read());
  root.dataset['display'] = tier;

  const refresh = (): DisplayTier => {
    const next = resolveDisplayTier(read());
    if (next !== tier) {
      tier = next;
      root.dataset['display'] = next;
    }
    return tier;
  };

  const onResize = (): void => {
    refresh();
  };
  win.addEventListener('resize', onResize);
  win.visualViewport?.addEventListener('resize', onResize);

  // Chromium fires this when OS display scale changes (not universally available).
  const dprMql =
    typeof win.matchMedia === 'function'
      ? win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`)
      : null;
  const onDpr = (): void => {
    refresh();
  };
  dprMql?.addEventListener?.('change', onDpr);

  return {
    get tier() {
      return tier;
    },
    refresh,
    dispose(): void {
      win.removeEventListener('resize', onResize);
      win.visualViewport?.removeEventListener('resize', onResize);
      dprMql?.removeEventListener?.('change', onDpr);
    },
  };
}
