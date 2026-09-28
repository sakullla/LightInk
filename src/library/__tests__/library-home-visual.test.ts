import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../library.css', import.meta.url), 'utf-8');
const preview = readFileSync(new URL('../shelf-home-preview.ts', import.meta.url), 'utf-8');
const previewHtml = readFileSync(new URL('../shelf-home-preview.html', import.meta.url), 'utf-8');

/** Default desktop window and titlebar. See tauri.conf.json and window-titlebar.css. */
const DESKTOP_WINDOW = { width: 1024, height: 768, titlebar: 36, scrollbar: 16 };

function ruleBody(source: string, selector: RegExp): string {
  return source.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, selector.flags))?.[1] ?? '';
}

function shelfHomeSection(): string {
  const start = css.indexOf('/* ===== Shelf home cover grid =====');
  const end = css.indexOf('/* ===== R7 通用书源管理面板', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

function decl(block: string, property: string): string {
  const match = block.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`));
  return match?.[1]?.trim() ?? '';
}

function px(value: string): number {
  const match = value.match(/(\d+(?:\.\d+)?)px/);
  return match === null ? Number.NaN : Number(match[1]);
}

function tokenPx(block: string, name: string): number {
  return px(decl(block, name));
}

describe('shelf home cover grid', () => {
  it('keeps five shelf themes on background, text, and accent without study colors', () => {
    for (const theme of ['gallery', 'paper', 'moss', 'walnut', 'ink']) {
      const block = ruleBody(css, new RegExp(`\\[data-library-theme='${theme}'\\]`));
      expect(block, theme).toMatch(/--lightink-bg:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-fg:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-muted:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-accent:\s*#[0-9a-f]{6}/i);
      expect(block, theme).not.toMatch(/--lightink-home-paper|--lightink-home-wash|--lightink-home-rule/);
    }

    const home = shelfHomeSection();
    expect(home).toMatch(/background:\s*var\(--lightink-bg\)/);
    expect(home).toMatch(/color:\s*var\(--lightink-fg\)/);
    expect(css).not.toMatch(/--lightink-home-paper|--lightink-home-wash|--lightink-home-rule/);
  });

  it('drops the study banner, horizontal cards, and title rule from the shelf home', () => {
    const home = shelfHomeSection();
    expect(home).not.toMatch(/lightink-library-home-recent/);
    expect(home).not.toMatch(/lightink-library-home-shortcut/);
    expect(home).not.toMatch(/home-heading::after/);
    expect(home).not.toMatch(/clamp\(\s*24px,\s*3vw,\s*42px\s*\)/);
    expect(home).not.toMatch(/font-family:\s*var\(--lightink-font-serif/);
    expect(home).not.toMatch(/linear-gradient/);
    expect(home).not.toMatch(/translateY\(/);
    expect(home).toMatch(
      /\.lightink-library-item:hover \.lightink-library-cover,[\s\S]*?transform:\s*none/,
    );
    expect(home).toMatch(/\.lightink-library-continue-open:hover[\s\S]*?transform:\s*none/);
  });

  it('uses one 2:3 cover spec, cover-gap spacing, and three UI type sizes', () => {
    const home = shelfHomeSection();
    const covers = home.match(
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home \.lightink-library-cover,\s*\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-continue \.lightink-library-cover\s*\{([^}]*)\}/,
    );
    expect(covers).not.toBeNull();
    expect(covers?.[1]).toMatch(/width:\s*100%/);
    expect(covers?.[1]).toMatch(/aspect-ratio:\s*2\s*\/\s*3/);
    expect(covers?.[1]).toMatch(/border-radius:\s*6px/);
    expect(covers?.[1]).toMatch(/transition:\s*none/);

    const homeGrid = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home/,
    );
    expect(homeGrid).toMatch(/repeat\(\s*auto-fill,\s*minmax\(132px,\s*1fr\)\)/);
    expect(homeGrid).toMatch(/column-gap:\s*var\(--lightink-library-cover-gap-x\)/);
    expect(homeGrid).toMatch(/row-gap:\s*var\(--lightink-library-cover-gap-y\)/);
    expect(homeGrid).toMatch(/overflow-y:\s*auto/);
    expect(home).toMatch(/\.lightink-library-home-books \.lightink-library-cover-wall,[\s\S]*?display:\s*contents/);

    const heading = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home-heading/,
    );
    const title = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-item-text strong/,
    );
    const progress = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-item-progress/,
    );
    expect(heading).toMatch(/font-family:\s*var\(--lightink-font-ui\)/);
    expect(title).toMatch(/font-family:\s*var\(--lightink-font-ui\)/);
    expect(progress).toMatch(/font-family:\s*var\(--lightink-font-ui\)/);
    expect(px(decl(heading, 'font-size'))).toBe(15);
    expect(px(decl(title, 'font-size'))).toBe(13);
    expect(px(decl(progress, 'font-size'))).toBe(12);
    expect(title).toMatch(/-webkit-line-clamp:\s*2/);
    expect(home).toMatch(/\.lightink-library-cover--jacket\s*\{[^}]*color:\s*var\(--lightink-muted\)/);
    expect(home).toMatch(/cover-jacket-title::after\s*\{[^}]*content:\s*none/);
    expect(home).toMatch(/data-progress-fill[\s\S]*?height:\s*3px/);

    const selected = home.match(
      /\.lightink-library-nav-item\.is-active,[\s\S]*?\)\s*\{([^}]*)\}/,
    )?.[1] ?? '';
    expect(selected).toMatch(/border-radius:\s*6px/);
    expect(selected).toMatch(/background:\s*var\(--lightink-accent-soft\)/);
    expect(selected).toMatch(/color:\s*var\(--lightink-accent-ink/);
  });

  it('fits two rows of at least four covers on the default desktop, and at least two on a phone', () => {
    const home = shelfHomeSection();
    const grid = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home/,
    );
    const trackMin = Number(grid.match(/minmax\((\d+)px,\s*1fr\)/)?.[1]);
    const padTop = px(decl(grid, 'padding'));
    const title = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-item-text strong/,
    );
    const progress = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-item-progress/,
    );
    const itemGap = px(
      decl(
        ruleBody(
          home,
          /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-continue-open/,
        ),
        'gap',
      ),
    );
    const textGap = px(
      decl(
        ruleBody(home, /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-item-text/),
        'gap',
      ),
    );
    const titleSize = px(decl(title, 'font-size'));
    const titleLine = Number(decl(title, 'line-height'));
    const progressSize = px(decl(progress, 'font-size'));
    const progressLine = Number(decl(progress, 'line-height'));
    const textBlock = itemGap + titleSize * titleLine * 2 + textGap + progressSize * progressLine;

    function fits(tokens: string, windowWidth: number, windowHeight: number): void {
      const nav = tokenPx(tokens, '--lightink-library-nav-width');
      const padX = tokenPx(tokens, '--lightink-library-pad-x');
      const gapX = tokenPx(tokens, '--lightink-library-cover-gap-x');
      const gapY = tokenPx(tokens, '--lightink-library-cover-gap-y');
      const inner = windowWidth - nav - padX * 2 - DESKTOP_WINDOW.scrollbar;
      const columns = Math.floor((inner + gapX) / (trackMin + gapX));
      expect(columns).toBeGreaterThanOrEqual(4);
      const track = (inner - (columns - 1) * gapX) / columns;
      const row = track * (3 / 2) + textBlock;
      const twoRows = row * 2 + gapY + padTop;
      expect(twoRows).toBeLessThanOrEqual(windowHeight - DESKTOP_WINDOW.titlebar);
    }

    const base = ruleBody(css, /\.lightink-library/);
    const compact = ruleBody(css, /html\[data-display='compact'\] \.lightink-library/);
    fits(base, DESKTOP_WINDOW.width, DESKTOP_WINDOW.height);
    fits(compact, DESKTOP_WINDOW.width, DESKTOP_WINDOW.height);

    expect(home).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?repeat\(\s*3,\s*minmax\(0,\s*1fr\)\)/);
    expect(home).toMatch(/@media \(max-width:\s*430px\)[\s\S]*?repeat\(\s*2,\s*minmax\(0,\s*1fr\)\)/);
    expect(home).not.toMatch(/repeat\(\s*1,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('keeps focus, dismiss-on-hover, safe area, keyboard inset, and reduced motion', () => {
    const home = shelfHomeSection();
    expect(home).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--lightink-accent\)/);
    const dismiss = ruleBody(
      home,
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-continue-dismiss/,
    );
    expect(dismiss).toMatch(/position:\s*absolute/);
    expect(dismiss).toMatch(/opacity:\s*0/);
    expect(home).toMatch(/focus-within \.lightink-library-continue-dismiss\s*\{[^}]*opacity:\s*1/);
    expect(home).toMatch(/var\(--lightink-safe-bottom, 0px\)/);
    expect(home).toMatch(/html\[data-keyboard\]:is\(\[data-android\], \[data-touch-primary\]\)/);
    expect(home).toMatch(/var\(--lightink-keyboard-inset, 0px\)/);
    expect(home).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition:\s*none !important/);
  });

  it('keeps the preview reproducible across required content and responsive samples', () => {
    for (const scenario of [
      "'empty'",
      "'single'",
      "'reading'",
      "'groups-tags'",
      "'long-missing'",
      "'filter-empty'",
    ]) {
      expect(preview).toContain(scenario);
    }
    for (const layout of ["'desktop'", "'narrow'", "'phone'", "'phone-safe'", "'phone-keyboard'"]) {
      expect(preview).toContain(layout);
    }
    expect(preview).toMatch(/LIBRARY_THEME_IDS/);
    expect(preview).toMatch(/listGroups:\s*async \(\) => groupsFor/);
    expect(preview).toMatch(/listTags:\s*async \(\) => tagsFor/);
    expect(preview).toMatch(/searchParams\.set\('scenario'/);
    expect(preview).toMatch(/searchParams\.set\('theme'/);
    expect(preview).toMatch(/searchParams\.set\('layout'/);
    expect(preview).toMatch(/data-keyboard/);
    expect(preview).toMatch(/--lightink-keyboard-inset/);
    expect(previewHtml).toContain('viewport-fit=cover');
    expect(previewHtml).toContain('书架首页视觉样本');
  });
});
