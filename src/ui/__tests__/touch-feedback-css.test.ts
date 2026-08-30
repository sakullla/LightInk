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
 * Touch-branch `:active` blocks: selector carries the html gate so desktop
 * output stays identical without the flags.
 */
function touchActiveBlocks(css: string): Array<{ selector: string; body: string }> {
  return cssDeclarationBlocks(stripComments(css)).filter(
    (rule) =>
      rule.selector.includes(':active') &&
      !rule.selector.includes(':hover') &&
      rule.selector.includes(TOUCH_GATE),
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
        `${TOUCH_GATE_RE}\\s*\\.lightink-library button:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent[^}]*color:\\s*inherit`,
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

  it('A2/F1: solid-state families keep their base backgrounds through sticky touch hover', () => {
    // manage-row 恢复 elevated 实底与 fg 字色；激活主题卡 / 打开态图标按钮恢复 accent-soft。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-manage-row:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-bg-elevated\\)[^}]*color:\\s*var\\(--lightink-fg\\)`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-theme-swatch\\.is-active:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-accent-soft\\)`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-icon-button\\.is-open:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-accent-soft\\)`,
      ),
    );
    // 键盘 focus-visible 与 hover 并存时 focus 配色单独恢复（中和不破坏键盘对比）。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library button:focus-visible:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-accent-soft\\)[^}]*color:\\s*var\\(--lightink-accent\\)`,
      ),
    );
  });

  it('A3/FC1: solid-base library button families keep base backgrounds through sticky touch hover', () => {
    // FC1：status 按钮 accent-soft 实底 / travel 编辑按钮 elevated 实底 /
    // catalog-more fg 7% 混合底，逐族恢复基础底色与字色（中和的透明底不适用实底族）。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-status button:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-accent-soft\\)[^}]*color:\\s*var\\(--lightink-fg\\)`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-edit\\.lightink-workspace-travel:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*var\\(--lightink-bg-elevated\\)[^}]*color:\\s*var\\(--lightink-fg\\)`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-catalog-more:hover:not\\(:disabled\\):not\\(:active\\)\\s*\\{[^}]*background:\\s*color-mix\\(in srgb, var\\(--lightink-fg\\) 7%, transparent\\)[^}]*color:\\s*var\\(--lightink-muted\\)`,
      ),
    );
    // FC2 抽样：导入封面 hover 底色/字色复位（基础态 elevated 底 + muted 字色）。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-item--import:hover:not\\(:active\\)\\s*\\.lightink-library-cover--import\\s*\\{[^}]*background:\\s*var\\(--lightink-bg-elevated\\)[^}]*color:\\s*var\\(--lightink-muted\\)`,
      ),
    );
    // FC3 抽样：沉浸 chrome 触发条 hover 底色复位（基础态透明）。
    expect(themeCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-chrome-trigger:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
  });

  it('A2/F2: modal primary/danger buttons keep readable solid press states', () => {
    // 按压洗色排除实底变体；primary/danger 用自身色派生加深实底（文字仍取 --lightink-bg）。
    expect(themeCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-modal-btn:not\\(:disabled\\):not\\(\\.lightink-modal-btn--primary\\):not\\(\\s*\\.lightink-modal-btn--danger\\s*\\):active\\s*\\{[^}]*${WASH_RE}`,
      ),
    );
    expect(themeCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-modal-btn--primary:not\\(:disabled\\):active\\s*\\{[^}]*background:\\s*color-mix\\(in srgb, var\\(--lightink-accent\\) 82%, var\\(--lightink-bg\\)\\)`,
      ),
    );
    expect(themeCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-modal-btn--danger:not\\(:disabled\\):active\\s*\\{[^}]*background:\\s*color-mix\\(in srgb, var\\(--lightink-danger\\) 82%, var\\(--lightink-bg\\)\\)[^}]*color:\\s*var\\(--lightink-bg\\)`,
      ),
    );
  });

  it('A2/F3-F4: completes hover neutralization for cover wall, rows, headings and panel/toolbar controls', () => {
    // F3(b)：封面墙 hover 阴影与位移同步复位。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-item:not\\(\\.is-selected\\):hover:not\\(:active\\)\\s*\\.lightink-library-cover\\s*\\{[^}]*transform:\\s*none[^}]*box-shadow:\\s*var\\(--lightink-shadow\\)`,
      ),
    );
    // F3(c)：来源行 / 分区标题 hover 底色复位。
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-source-row:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    expect(libraryCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-library-pane-heading:hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    // F4：标注面板列表项边框/阴影复位（当前命中项保持 is-current 高亮）。
    expect(annotationCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sidebar-item:not\\(\\.is-current\\):hover:not\\(:active\\)\\s*\\{[^}]*border-color:\\s*color-mix\\(in srgb, var\\(--lightink-border\\) 70%, transparent\\)[^}]*box-shadow:\\s*0 1px 3px rgba\\(0, 0, 0, 0\\.06\\)`,
      ),
    );
    // F4：头部按钮透明底 + muted 字色复位。
    expect(annotationCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sidebar-close:hover:not\\(:active\\),[\\s\\S]*?\\{[^}]*background:\\s*transparent[^}]*color:\\s*var\\(--lightink-muted\\)`,
      ),
    );
    // F4：颜色圆点 hover 放大复位（激活圆点保持 accent 环）。
    expect(annotationCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-sidebar-color-filter:not\\(\\[data-color='all'\\]\\):not\\(\\s*\\.lightink-reader-sidebar-filter--active\\s*\\):hover:not\\(:active\\)\\s*\\{[^}]*transform:\\s*none`,
      ),
    );
    // F4：划选工具条 action hover 底色复位。
    expect(readerCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-selection-action:not\\(:disabled\\):hover:not\\(:active\\)\\s*\\{[^}]*background:\\s*transparent`,
      ),
    );
    // F4：阅读器主题卡 hover 抬升复位（激活卡保持 is-active 描边）。
    expect(panelsCss).toMatch(
      new RegExp(
        `${TOUCH_GATE_RE}\\s*\\.lightink-reader-theme-swatch:not\\(\\.is-active\\):hover:not\\(:active\\)\\s*\\.lightink-reader-theme-page\\s*\\{[^}]*transform:\\s*none[^}]*box-shadow:`,
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
        if (!block.selector.includes(':active')) continue;
        // 已门控的按压规则直接放行。
        if (block.selector.includes(TOUCH_GATE)) continue;
        // hover 驻留中和块（gate + :hover:not(:active) 复位语义）只做复位，不算按压规则；
        // 无门控的 `.x:active:hover` 类块不跳过，仍须被门控断言覆盖。
        if (block.selector.includes(':hover:not(:active)')) continue;
        const allowlisted = ungatedAllowlist.some((re) => re.test(block.selector));
        expect(
          allowlisted,
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
