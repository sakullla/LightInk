import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(new URL('../theme.css', import.meta.url), 'utf-8');
const readerCss = readFileSync(new URL('../../reader/reader.css', import.meta.url), 'utf-8');

describe('accessibility media preferences', () => {
  it('disables application motion when reduced motion is requested', () => {
    expect(themeCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(themeCss).toContain('animation-duration: 0.01ms !important');
    expect(themeCss).toContain('transition-duration: 0.01ms !important');
  });

  it('keeps focus and selected content visible in forced colors', () => {
    expect(themeCss).toContain('@media (forced-colors: active)');
    expect(themeCss).toContain('outline-color: Highlight');
    expect(readerCss).toContain('@media (forced-colors: active)');
    expect(readerCss).toContain('color: HighlightText');
  });

  it('locks the mobile viewport and lifts note/selection chrome above the keyboard', () => {
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/,
    );
    expect(themeCss).toContain('.lightink-context-menu__shortcut');
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-context-menu__shortcut\s*\{[^}]*display:\s*none/,
    );
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\.is-workspace-editor \.lightink-mobile-back-to-shelf/,
    );
    expect(themeCss).toContain('.lightink-mobile-back-to-shelf {\n  display: none;\n}');
    expect(readerCss).toContain('--lightink-keyboard-inset');
  });

  it('R5: mobile reader/markdown has no persistent 返回书架 overlay or 56px pad', () => {
    expect(themeCss).toContain('.lightink-mobile-back-to-shelf {\n  display: none;\n}');

    const readerOverlay = themeCss.match(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\.is-workspace-reader \.lightink-mobile-back-to-shelf[\s\S]*?\{[^}]*\}/,
    )?.[0];
    expect(readerOverlay).toMatch(/display:\s*none/);
    expect(readerOverlay).not.toMatch(/display:\s*inline-flex/);
    expect(readerOverlay).toMatch(
      /#app\.is-workspace-shelf:has\(\.lightink-library\[hidden\]\)\s*\.lightink-mobile-back-to-shelf/,
    );

    const readerPad = themeCss.match(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\.is-workspace-reader #lightink-editor-area[\s\S]*?\{[^}]*\}/,
    )?.[0];
    expect(readerPad).toMatch(/padding-top:\s*0/);
    expect(readerPad).not.toMatch(/56px/);
    expect(readerPad).toMatch(
      /#app\.is-workspace-shelf:has\(\.lightink-library\[hidden\]\)\s*#lightink-editor-area/,
    );

    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\.is-workspace-editor \.lightink-mobile-back-to-shelf\s*\{[^}]*display:\s*inline-flex/,
    );
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) #app\.is-workspace-editor #lightink-editor-area\s*\{[^}]*padding-top:\s*calc\(var\(--lightink-safe-top,\s*0px\) \+ 56px\)/,
    );
  });
});
