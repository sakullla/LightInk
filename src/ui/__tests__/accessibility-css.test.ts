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
    expect(readerCss).toContain('--lightink-keyboard-inset');
  });
});
