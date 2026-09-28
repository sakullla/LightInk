import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../library.css', import.meta.url), 'utf-8');
const preview = readFileSync(new URL('../shelf-home-preview.ts', import.meta.url), 'utf-8');
const previewHtml = readFileSync(new URL('../shelf-home-preview.html', import.meta.url), 'utf-8');

function ruleBody(selector: RegExp): string {
  return css.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, selector.flags))?.[1] ?? '';
}

function editorialSection(): string {
  const start = css.indexOf('/* ===== Shelf-only editorial study home =====');
  const end = css.indexOf('/* ===== R7 通用书源管理面板', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe('shelf home editorial visual contract', () => {
  it('provides a readable editorial surface in every shelf theme', () => {
    for (const theme of ['gallery', 'paper', 'moss', 'walnut', 'ink']) {
      const block = ruleBody(new RegExp(`\\[data-library-theme='${theme}'\\]`));
      expect(block, theme).toMatch(/--lightink-home-paper:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-home-wash:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-home-rule:\s*#[0-9a-f]{6}/i);
      expect(block, theme).toMatch(/--lightink-accent-ink:\s*#[0-9a-f]{6}/i);
    }

    const home = editorialSection();
    expect(home).toMatch(/font-family:\s*var\(--lightink-font-serif/);
    expect(home).toMatch(/background:[\s\S]*var\(--lightink-home-wash\)/);
    expect(home).toMatch(/color:\s*var\(--lightink-accent-ink\)/);
    expect(home).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('keeps one vertical scroll owner and scopes the redesign to the shelf home', () => {
    const home = ruleBody(
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home/,
    );
    expect(home).toMatch(/height:\s*100%/);
    expect(home).toMatch(/overflow-x:\s*hidden/);
    expect(home).toMatch(/overflow-y:\s*auto/);
    expect(home).toMatch(/overscroll-behavior:\s*contain/);

    const section = editorialSection();
    expect(section).toMatch(
      /\.lightink-library\[data-library-nav='shelf'\] \.lightink-library-home-books \.lightink-library-cover-wall,[\s\S]*?overflow:\s*visible/,
    );
    expect(section).not.toMatch(/data-library-nav='catalog'/);
    expect(section).not.toMatch(/data-library-nav='manage'/);
    expect(section).not.toMatch(/data-library-nav='sources'/);
  });

  it('gives primary, recent, shortcuts, and cover wall distinct hierarchy', () => {
    const section = editorialSection();
    expect(section).toMatch(/\.lightink-library-continue\s*\{[\s\S]*?grid-template-columns/);
    expect(section).toMatch(/\.lightink-library-continue-text strong\s*\{[\s\S]*?clamp\(24px, 3vw, 42px\)/);
    expect(section).toMatch(/\.lightink-library-home-recent-list\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
    expect(section).toMatch(
      /\.lightink-library-home-shortcut-list\s*\{[\s\S]*?flex-wrap:\s*nowrap[\s\S]*?overflow-x:\s*auto[\s\S]*?overflow-y:\s*hidden/,
    );
    expect(section).toMatch(
      /\.lightink-library-home-shortcut\s*\{[\s\S]*?flex:\s*0 0 auto[\s\S]*?max-width:\s*min\(100%, 24rem\)/,
    );
    expect(section).toMatch(/\.lightink-library-wall-heading\s*\{[\s\S]*?position:\s*sticky/);
    expect(section).toMatch(/\.lightink-library-home-empty\s*\{[\s\S]*?repeating-linear-gradient/);
  });

  it('defines narrow desktop, phone, safe-area, keyboard, touch, focus, and reduced-motion results', () => {
    const section = editorialSection();
    expect(section).toMatch(/@container library-content \(max-width:\s*46rem\)/);
    expect(section).toMatch(/@media \(max-width:\s*760px\)/);
    expect(section).toMatch(/:is\(html\[data-android\], html\[data-touch-primary\]\)[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
    expect(section).toMatch(/@media \(max-width:\s*430px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
    expect(section).toMatch(/var\(--lightink-safe-bottom, 0px\)/);
    expect(section).toMatch(/html\[data-keyboard\]:is\(\[data-android\], \[data-touch-primary\]\)/);
    expect(section).toMatch(/var\(--lightink-keyboard-inset, 0px\)/);
    expect(section).toMatch(/@media \(pointer:\s*coarse\)[\s\S]*?min-height:\s*48px/);
    expect(section).toMatch(/:focus-visible\s*\{[\s\S]*?outline:\s*3px solid var\(--lightink-accent\)/);
    expect(section).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition:\s*none !important/);
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
