import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(new URL('../theme.css', import.meta.url), 'utf-8');
const readerCss = readFileSync(new URL('../../reader/reader.css', import.meta.url), 'utf-8');
const panelsCss = readFileSync(new URL('../../reader/reader-chrome-panels.css', import.meta.url), 'utf-8');
const annotationCss = readFileSync(
  new URL('../../reader/annotation-panel.css', import.meta.url),
  'utf-8',
);
const libraryCss = readFileSync(new URL('../../library/library.css', import.meta.url), 'utf-8');

const allCss = [
  { name: 'theme', css: themeCss },
  { name: 'reader', css: readerCss },
  { name: 'reader-chrome-panels', css: panelsCss },
  { name: 'annotation-panel', css: annotationCss },
  { name: 'library', css: libraryCss },
];

const TOUCH_GATE = ':is(html[data-android], html[data-touch-primary])';
const TOUCH_GATE_RE = ':is\\(html\\[data-android\\], html\\[data-touch-primary\\]\\)';
const WASH_RE = 'color-mix\\(in srgb, var\\(--lightink-accent\\) 14%, transparent\\)';

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flat `{ selector, body }` pairs; nested `@media` inners still match. */
function cssDeclarationBlocks(css: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    blocks.push({ selector: match[1].replace(/\s+/g, ' ').trim(), body: match[2] });
  }
  return blocks;
}

/**
 * Touch-branch `:active` blocks: selector carries the html gate (or sits inside a
 * coarse-pointer media query) so desktop output stays identical without the flags.
 */
function touchActiveBlocks(css: string): Array<{ selector: string; body: string }> {
  return cssDeclarationBlocks(stripComments(css)).filter(
    (rule) =>
      rule.selector.includes(':active') &&
      !rule.selector.includes(':hover') &&
      !rule.selector.startsWith('@') &&
      (rule.selector.includes(TOUCH_GATE) || rule.selector.includes('(pointer: coarse)')),
  );
}

describe('touch press feedback baseline (T1)', () => {
  it('suppresses the inherited system tap highlight at the html level on touch', () => {
    expect(themeCss).toMatch(
      /html:is\(\[data-android\], \[data-touch-primary\]\)\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent/,
    );
  });

  it('washes the tab bar tab on :active and gives is-active an accent-soft rounded base', () => {
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-tabbar-tab:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-tabbar-tab\\.is-active\\s*\\{[^}]*background:\\s*var\\(--lightink-accent-soft\\)[^}]*transition:\\s*background-color 150ms ease, color 150ms ease, font-weight 150ms ease`,
      ),
    );
    // 底色来自既有 token，基块圆角 10px 两态一致（下方形状断言兜底）。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-tabbar-tab\\s*\\{[^}]*border-radius:\\s*10px`,
      ),
    );
  });

  it('washes generic library buttons, chrome actions, TOC items and sheet handles on :active', () => {
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library button:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-groups-sheet-item:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-groups-sheet-handle:active\\s*\\{[^}]*transform:\\s*scale\\(0\\.99\\)[^}]*transition:\\s*transform 100ms ease`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-source-form label:active[^{]*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-chrome-action:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}[^}]*transition:\\s*background-color 100ms ease, transform 100ms ease`,
      ),
    );
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-selection-action:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(panelsCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-toc-item:not\\(:disabled\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(panelsCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sheet-handle:active\\s*\\{[^}]*transform:\\s*scale\\(0\\.99\\)[^}]*transition:\\s*transform 100ms ease`,
      ),
    );
    expect(annotationCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sidebar-item:active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(annotationCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sidebar-close:active,[^{]*\\{[^}]*${WASH_RE}`,
      ),
    );
  });

  it('grows the progress thumb on press with the same easing curve and keeps it round', () => {
    // 触屏 thumb：按下 16→18px，基块带同曲线 transition（50% 圆角来自基块，不被覆盖）。
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-chrome-progress:active::-webkit-slider-thumb\\s*\\{[^}]*width:\\s*18px[^}]*height:\\s*18px`,
      ),
    );
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-chrome-progress:active::-moz-range-thumb\\s*\\{[^}]*width:\\s*18px`,
      ),
    );
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-chrome-progress::-webkit-slider-thumb\\s*\\{[^}]*transition:\\s*width 100ms ease, height 100ms ease, margin-top 100ms ease`,
      ),
    );
    // 桌面 thumb：既有 12→14px 按下放大补同曲线 transition，圆角 50% 不变。
    expect(readerCss).toMatch(
      /\.lightink-reader-chrome-progress:active::-webkit-slider-thumb\s*\{[^}]*width:\s*14px/,
    );
    expect(readerCss).toMatch(
      /\.lightink-reader-chrome-progress::-webkit-slider-thumb\s*\{[^}]*border-radius:\s*50%[^}]*transition:\s*width 100ms ease/,
    );
  });

  it('keeps both press states shape-consistent: no border-radius or box-shadow overrides in :active blocks', () => {
    for (const { name, css } of allCss) {
      const activeBlocks = touchActiveBlocks(css);
      expect(activeBlocks.length, `${name} must declare touch :active blocks`).toBeGreaterThan(0);
      for (const block of activeBlocks) {
        expect(block.body, `${name} ${block.selector}`).not.toMatch(/border-radius\s*:/);
        expect(block.body, `${name} ${block.selector}`).not.toMatch(/box-shadow\s*:/);
      }
    }
  });

  it('neutralizes sticky :hover states on touch so the base background returns after release', () => {
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library button:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-tabbar-tab:not\\(\\.is-active\\):hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    // 侧栏导航 hover 带 !important；中和规则同级 !important 才能对账。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-nav-item:not\\(\\.is-active\\):hover:not\\(:active\\)[\\s\\S]*?\\{[^}]*background:\\s*transparent !important`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-item--row:not\\(\\.is-selected\\):hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent !important`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-item:not\\(\\.is-selected\\):hover:not\\(:active\\)\\s*\\.lightink-library-cover\\s*\\{[^}]*transform:\\s*none`,
      ),
    );
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-chrome-action:not\\(\\.is-open\\):hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    expect(panelsCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-toc-item:not\\(\\.is-current\\):not\\(\\.is-active\\):hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    expect(panelsCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-type-font:not\\(\\.is-active\\):hover:not\\(:active\\),[\\s\\S]*?\\{[^}]*color:\\s*var\\(--lightink-muted\\)`,
      ),
    );
  });

  it('keeps desktop output identical: every :active rule is touch-gated except the desktop thumb', () => {
    // 既有桌面 thumb :active（12→14px）是唯一允许的无门控 :active 规则。
    const ungatedAllowlist = [
      /^\.lightink-reader-chrome-progress:active::-webkit-slider-thumb$/,
      /^\.lightink-reader-chrome-progress:active::-moz-range-thumb$/,
    ];
    for (const { name, css } of allCss) {
      for (const block of cssDeclarationBlocks(stripComments(css))) {
        if (!block.selector.includes(':active') || block.selector.includes(':hover')) continue;
        const gated =
          block.selector.includes(TOUCH_GATE) || block.selector.includes('(pointer: coarse)');
        const allowlisted = ungatedAllowlist.some((re) => re.test(block.selector));
        expect(
          gated || allowlisted,
          `${name} :active rule must be touch-gated: ${block.selector}`,
        ).toBe(true);
      }
    }
  });

  it('kills the new press transitions under prefers-reduced-motion via the global switch', () => {
    expect(themeCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(themeCss).toContain('transition-duration: 0.01ms !important');
    expect(themeCss).toContain('animation-duration: 0.01ms !important');
  });
});
