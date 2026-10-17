import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LIBRARY_THEMES } from '../library-theme.js';

const css = readFileSync(new URL('../library.css', import.meta.url), 'utf-8');

function ruleBody(source: string, selector: RegExp): string {
  return source.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, selector.flags))?.[1] ?? '';
}

function ruleBodiesAll(source: string, selector: RegExp): string[] {
  const matcher = new RegExp(
    `${selector.source}\\s*\\{([^}]*)\\}`,
    selector.flags.includes('g') ? selector.flags : `${selector.flags}g`,
  );
  return Array.from(source.matchAll(matcher), (match) => match[1] ?? '');
}

/*
 * 纸墨工作室书库改造（docs/design/ui-redesign-2026-10.md §3.2–§3.4，B 包）：
 * 把本包的关键视觉决策钉进测试，防止回归。
 */
describe('library shelf ink-studio refresh', () => {
  it('double-writes every preset token between LIBRARY_THEMES and the CSS presets', () => {
    // TS 字段名 → CSS 变量名（同名异写处显式映射）。
    const cssVarName: Record<string, string> = {
      page: 'bg',
      elevated: 'bg-elevated',
      sunken: 'bg-sunken',
      ink: 'fg',
      inkStrong: 'fg-strong',
      accentInk: 'accent-ink',
      accentSoft: 'accent-soft',
      accentContrast: 'accent-contrast',
      shadowPop: 'shadow-pop',
    };
    for (const theme of LIBRARY_THEMES) {
      const block = ruleBody(css, new RegExp(`\\[data-library-theme='${theme.id}'\\]`));
      expect(block, theme.id).not.toBe('');
      const pairs: Array<[string, string]> = [
        ['page', theme.page],
        ['elevated', theme.elevated],
        ['sunken', theme.sunken],
        ['ink', theme.ink],
        ['inkStrong', theme.inkStrong],
        ['accentInk', theme.accentInk],
        ['muted', theme.muted],
        ['border', theme.border],
        ['accent', theme.accent],
        ['accentSoft', theme.accentSoft],
        ['accentContrast', theme.accentContrast],
        ['overlay', theme.overlay],
        ['shadow', theme.shadow],
        ['shadowPop', theme.shadowPop],
        ['danger', theme.danger],
        ['success', theme.success],
        ['warning', theme.warning],
        ['info', theme.info],
      ];
      for (const [token, value] of pairs) {
        const varName = cssVarName[token] ?? token;
        expect(block, `${theme.id} ${token}`).toContain(`--lightink-${varName}: ${value}`);
      }
      expect(block, theme.id).toContain(`color-scheme: ${theme.colorScheme}`);
    }
  });

  it('keeps the sunken nav surface distinct from the page and the 26px nav density', () => {
    const nav = ruleBody(css, /\.lightink-library-nav(?![\w-])/);
    expect(nav).toMatch(/background:\s*var\(--lightink-bg-sunken/);
    // 密度锁（app-shell.test.ts 正/负向断言的镜像）：导航行维持 26px，不挑战。
    const navRows = ruleBody(
      css,
      /\.lightink-library-nav-item,\s*\.lightink-library-source,\s*\.lightink-library-group,\s*\.lightink-library-smart-group/,
    );
    expect(navRows).toMatch(/min-height:\s*26px/);
    expect(ruleBody(css, /\.lightink-library-pane-heading(?![\w-])/)).toMatch(/min-height:\s*26px/);
  });

  it('shows pane actions at rest with 28px targets and keeps the hover path', () => {
    const action = ruleBody(css, /\.lightink-library-pane-action(?![\w-])/);
    expect(action).toMatch(/opacity:\s*0\.65/);
    expect(action).toMatch(/width:\s*28px/);
    expect(action).not.toMatch(/pointer-events:\s*none/);
    const actionButtons = ruleBody(
      css,
      /\.lightink-library-pane-actions \.lightink-library-icon-button/,
    );
    expect(actionButtons).toMatch(/width:\s*28px/);
    expect(actionButtons).toMatch(/min-height:\s*28px/);
    // capture 依赖「悬停标题 → 点击操作」路径：hover/focus-within 仍把透明度提到 1。
    expect(css).toMatch(
      /\.lightink-library-pane-heading:hover \.lightink-library-pane-action,[\s\S]*?\.lightink-library-pane-heading:focus-within \.lightink-library-pane-action,[\s\S]*?opacity:\s*1/,
    );
  });

  it('centers the elastic search and reserves space-5 before the window controls', () => {
    // 桌面三列网格 1fr|auto|1fr：标题贴左、搜索真居中、动作组贴右。
    const desktopMain = ruleBody(
      css,
      /html:not\(\[data-android\]\):not\(\[data-touch-primary\]\) \.lightink-library-header-main/,
    );
    expect(desktopMain).toMatch(/display:\s*grid/);
    expect(desktopMain).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, auto\) minmax\(0, 1fr\)/,
    );
    const desktopSearch = ruleBodiesAll(
      css,
      /html:not\(\[data-android\]\):not\(\[data-touch-primary\]\) \.lightink-library-search(?![\w-])/,
    ).join('\n');
    expect(desktopSearch).toMatch(/justify-self:\s*center/);
    expect(desktopSearch).toMatch(/width:\s*min\(28rem, 42vw\)/);
    expect(
      ruleBodiesAll(
        css,
        /html:not\(\[data-android\]\):not\(\[data-touch-primary\]\) \.lightink-library-header-actions/,
      ).join('\n'),
    ).toMatch(/justify-self:\s*end/);
    expect(css).toMatch(
      /\.lightink-library-header\s*\{[^}]*padding-right:\s*calc\(var\(--lightink-titlebar-caption, 36px\) \* 3 \+ var\(--lightink-space-5, 24px\)\)/,
    );
  });

  it('sets the continue hero title to text-xl fg-strong 650 with the only accent-solid CTA', () => {
    const heroTitle = ruleBody(
      css,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-continue \.lightink-library-item-text strong/,
    );
    expect(heroTitle).toMatch(/font-size:\s*var\(--lightink-text-xl, 22px\)/);
    expect(heroTitle).toMatch(/color:\s*var\(--lightink-fg-strong/);
    expect(heroTitle).toMatch(/font-weight:\s*650/);
    const cue = ruleBody(css, /\.lightink-library-continue-cue(?![\w-])/);
    expect(cue).toMatch(/background:\s*var\(--lightink-accent\)/);
    expect(cue).toMatch(/color:\s*var\(--lightink-accent-contrast/);
    expect(cue).toMatch(/min-height:\s*var\(--lightink-control-h/);
  });

  it('side-pushes the book detail at >=900px and overlays it below with a backdrop', () => {
    // <900px：覆盖式（absolute + 背板点外即收）。
    const overlay = ruleBody(css, /\.lightink-library-detail(?![\w-])/);
    expect(overlay).toMatch(/position:\s*absolute/);
    expect(overlay).toMatch(/background:\s*var\(--lightink-bg-elevated\)/);
    expect(css).toMatch(
      /@media \(max-width:\s*899\.98px\)\s*\{\s*\.lightink-library-detail-backdrop:not\(\[hidden\]\)\s*\{[^}]*display:\s*block[^}]*background:\s*var\(--lightink-overlay\)/,
    );
    // >=900px：回到文档流，workArea 双列推挤。
    const pushStart = css.indexOf('@media (min-width: 900px)');
    expect(pushStart).toBeGreaterThan(0);
    const push = css.slice(pushStart, css.indexOf('}', css.indexOf('grid-template-columns', pushStart)) + 1);
    expect(push).toMatch(/\.lightink-library-detail\s*\{[^}]*position:\s*static/);
    expect(css).toMatch(
      /@media \(min-width:\s*900px\)\s*\{[\s\S]*?\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-workarea:has\(\s*\.lightink-library-detail:not\(\[hidden\]\)\s*\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(var\(--lightink-library-detail-min\), 32%\)/,
    );
    // [hidden] 与关闭钮钩子（capture-ui.mjs:760-770）保留。
    expect(css).toMatch(/\.lightink-library-detail\[hidden\]\s*\{/);
    expect(css).toMatch(/\.lightink-library-detail-close/);
  });

  it('lifts cover cards on hover with shadow-pop and rings the selection with accent-soft', () => {
    const hover = ruleBody(
      css,
      /\.lightink-library-item:hover \.lightink-library-cover,\s*\.lightink-library-item:focus-visible \.lightink-library-cover/,
    );
    expect(hover).toMatch(/transform:\s*translateY\(-2px\)/);
    expect(hover).toMatch(/var\(--lightink-shadow-pop\)/);
    const selected = ruleBody(css, /\.lightink-library-item\.is-selected \.lightink-library-cover/);
    expect(selected).toMatch(/0 0 0 3px var\(--lightink-accent-soft\)/);
  });

  it('cards the manage settings groups: 40px title rows, icons, 280ms reveal, mono cache stats', () => {
    const toggle = ruleBody(css, /\.lightink-library-manage-group-toggle(?![\w-])/);
    expect(toggle).toMatch(/min-height:\s*var\(--lightink-control-h-lg, 40px\)/);
    expect(css).toMatch(
      /\.lightink-library-manage-group:not\(\[data-collapsed='true'\]\) > :not\(h2\)\s*\{[^}]*var\(--lightink-duration-slow, 280ms\)/,
    );
    expect(css).toMatch(
      /\.lightink-library-manage-group > h2::before\s*\{[^}]*mask:\s*var\(--lightink-manage-group-icon\)/,
    );
    for (const group of ['appearance', 'reading', 'ai', 'storage', 'sync', 'other', 'conceal']) {
      expect(css).toMatch(new RegExp(`\\.lightink-library-manage-group\\[data-manage-group='${group}'\\]`));
    }
    const cacheStats = ruleBody(css, /\.lightink-library-cache-summary > span/);
    expect(cacheStats).toMatch(/font-family:\s*var\(--lightink-font-mono/);
    expect(cacheStats).toMatch(/font-size:\s*var\(--lightink-text-lg/);
  });

  it('keeps download progress on the accent thin track with a danger ghost cancel', () => {
    const track = ruleBody(css, /\.lightink-library-book-source-download-progress(?![\w-])/);
    expect(track).toMatch(/height:\s*4px/);
    const cancel = ruleBody(
      css,
      /\.lightink-library-book-sources\s*button\.lightink-library-book-source-download-cancel/,
    );
    expect(cancel).toMatch(/color:\s*var\(--lightink-danger\)/);
    expect(cancel).toMatch(/background:\s*transparent/);
  });
});
