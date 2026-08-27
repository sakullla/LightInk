import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const themeCss = readFileSync(new URL('../theme.css', import.meta.url), 'utf-8');
const readerCss = readFileSync(new URL('../../reader/reader.css', import.meta.url), 'utf-8');
const libraryCss = readFileSync(new URL('../../library/library.css', import.meta.url), 'utf-8');

const overlayCss = `${libraryCss}\n${themeCss}\n${readerCss}`;

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

function overlayKeyboardRules(
  css: string,
  token: string,
): Array<{ selector: string; body: string }> {
  return cssDeclarationBlocks(css).filter(
    (rule) => rule.selector.includes(token) && rule.body.includes('--lightink-keyboard-inset'),
  );
}

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

  it('source/group/cache/membership/archive-password overlays consume keyboard-inset', () => {
    const overlays: Array<{ name: string; tokens: readonly string[] }> = [
      { name: 'source', tokens: ['.lightink-library-source-modal'] },
      { name: 'group', tokens: ['.lightink-library-group-modal'] },
      { name: 'cache', tokens: ['.lightink-library-cache-limit-modal'] },
      {
        name: 'membership',
        tokens: ['.lightink-library-membership-overlay', '.lightink-library-membership-dialog'],
      },
      {
        name: 'archive-password',
        tokens: ['#lightink-archive-password', '.lightink-link-dialog'],
      },
      { name: 'groups-sheet', tokens: ['.lightink-library-groups-sheet'] },
      { name: 'note-dialog', tokens: ['.lightink-note-dialog'] },
    ];

    for (const overlay of overlays) {
      const rules = overlay.tokens.flatMap((token) => overlayKeyboardRules(overlayCss, token));
      expect(rules, `${overlay.name} rules must include --lightink-keyboard-inset`).not.toHaveLength(
        0,
      );
      for (const rule of rules) {
        expect(rule.body).toMatch(/var\(\s*--lightink-keyboard-inset\s*,\s*0px\s*\)/);
        expect(rule.body).not.toMatch(/pointer-events:\s*none/);
        expect(rule.body).not.toMatch(/visibility:\s*hidden/);
      }
    }
  });

  it('keeps mobile input overlays closable when keyboard-inset is 0', () => {
    expect(libraryCss).toMatch(
      /\.lightink-modal-overlay\.lightink-library-source-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-modal-overlay\.lightink-library-group-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-modal-overlay\.lightink-library-cache-limit-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-library-membership-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-library-source-modal\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-library-group-modal\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    expect(libraryCss).toMatch(
      /\.lightink-library-cache-limit-modal\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    expect(themeCss).toMatch(/\.lightink-modal-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/);
  });
});
