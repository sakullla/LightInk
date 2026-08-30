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

describe('T4 modal touch form and keyboard-inset single deduction', () => {
  const KEYBOARD_INSET = '--lightink-keyboard-inset';

  const libraryManageSource = readFileSync(
    new URL('../../library/library-manage.ts', import.meta.url),
    'utf-8',
  );
  const archiveDialogSource = readFileSync(
    new URL('../archive-password-dialog.ts', import.meta.url),
    'utf-8',
  );

  /** Balanced-brace @media blocks; the flat rule regex cannot span nested blocks. */
  function mediaQueryBlocks(css: string, query: string): string[] {
    const blocks: string[] = [];
    const needle = `@media ${query} {`;
    let index = css.indexOf(needle);
    while (index !== -1) {
      let depth = 1;
      let cursor = index + needle.length;
      while (cursor < css.length && depth > 0) {
        const ch = css[cursor];
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        cursor += 1;
      }
      blocks.push(css.slice(index, cursor));
      index = css.indexOf(needle, cursor);
    }
    return blocks;
  }

  it('deducts keyboard-inset once per overlay: bottom offset only, never in max-height', () => {
    const points: Array<{ name: string; css: string; token: string }> = [
      { name: 'context menu', css: themeCss, token: '.lightink-context-menu' },
      { name: 'source overlay', css: libraryCss, token: '.lightink-library-source-modal' },
      { name: 'group overlay', css: libraryCss, token: '.lightink-library-group-modal' },
      { name: 'cache-limit overlay', css: libraryCss, token: '.lightink-library-cache-limit-modal' },
      { name: 'archive-password overlay', css: libraryCss, token: '#lightink-archive-password' },
    ];
    for (const point of points) {
      const rules = cssDeclarationBlocks(point.css).filter(
        (rule) => rule.selector.includes(point.token) && rule.body.includes(KEYBOARD_INSET),
      );
      expect(rules, `${point.name} must consume keyboard-inset`).not.toHaveLength(0);
      for (const rule of rules) {
        expect(
          rule.body,
          `${point.name} max-height must not consume keyboard-inset: ${rule.selector}`,
        ).not.toMatch(new RegExp(`max-height\\s*:[^;]*${KEYBOARD_INSET}`));
      }
      // 单一扣减通道：keyboard-inset 由 bottom/padding-bottom 偏移消费——
      // 键盘弹起（如 inset=300px）时底部上移恰等于 inset，无双倍位移。
      expect(
        rules.some((rule) =>
          new RegExp(`(?:bottom|padding-bottom)\\s*:[^;]*${KEYBOARD_INSET}`).test(rule.body),
        ),
        `${point.name} must deduct keyboard-inset via the bottom offset`,
      ).toBe(true);
    }
  });

  it('keeps the TS keyboard-inset appliers single-channel (padding only, no max-height term)', () => {
    for (const [name, source] of [
      ['library-manage', libraryManageSource],
      ['archive-password-dialog', archiveDialogSource],
    ] as const) {
      expect(source, `${name} lifts via the overlay bottom offset`).toContain(
        "paddingBottom = 'var(--lightink-keyboard-inset, 0px)'",
      );
      expect(
        source,
        `${name} max-height must not consume keyboard-inset`,
      ).not.toMatch(/maxHeight\s*=\s*'[^']*--lightink-keyboard-inset/);
    }
  });

  it('presents the source/group/cache-limit modals as bottom sheets on touch phones', () => {
    const sheetBlocks = mediaQueryBlocks(libraryCss, '(max-width: 760px)').filter((block) =>
      block.includes('.lightink-library-source-modal'),
    );
    expect(sheetBlocks).toHaveLength(1);
    const sheet = sheetBlocks[0]!;
    for (const token of [
      '.lightink-library-source-modal',
      '.lightink-library-group-modal',
      '.lightink-library-cache-limit-modal',
    ]) {
      expect(sheet, `${token} joins the bottom-sheet form`).toContain(token);
    }
    // 底部锚定；safe-bottom/keyboard-inset 经 bottom 通道单一消费。
    expect(sheet).toMatch(/align-items:\s*end/);
    expect(sheet).toMatch(
      /padding-bottom:\s*max\(var\(--lightink-safe-bottom, 0px\), var\(--lightink-keyboard-inset, 0px\)\)/,
    );
    // 底部 sheet：圆角只在上缘（16-20px），高度随内容盒（无 inset 项）。
    expect(sheet).toMatch(/border-radius:\s*20px 20px 0 0/);
    expect(sheet).toMatch(/border-bottom:\s*none/);
    expect(sheet).toMatch(/max-height:\s*100%/);
  });

  it('anchors dialogs above the keyboard via html[data-keyboard] without double deduction', () => {
    for (const token of [
      '.lightink-library-source-modal',
      '.lightink-library-group-modal',
      '.lightink-library-cache-limit-modal',
    ]) {
      const anchored = cssDeclarationBlocks(libraryCss).find(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes(token) &&
          /align-items:\s*end/.test(rule.body),
      );
      expect(anchored, `${token} anchors to the keyboard top when open`).toBeDefined();
      const capped = cssDeclarationBlocks(libraryCss).find(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes(token) &&
          rule.selector.includes('.lightink-modal-dialog') &&
          /max-height:\s*100%/.test(rule.body),
      );
      expect(capped, `${token} dialog caps to the visible area when open`).toBeDefined();
    }
    // 密码对话框（flex overlay）同样锚到键盘上缘、高度收敛可视区。
    expect(
      cssDeclarationBlocks(libraryCss).some(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes('#lightink-archive-password') &&
          /align-items:\s*flex-end/.test(rule.body),
      ),
    ).toBe(true);
  });

  it('unifies confirm/password dialog radii on touch and keeps desktop cards untouched', () => {
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\s*\.lightink-confirm-dialog\s*\{[^}]*border-radius:\s*16px/,
    );
    expect(archiveDialogSource).toContain("borderRadius = '16px'");
    // 桌面居中卡片基线不变（无触屏旗标时不命中任何新规则）。
    const sourceDialog = libraryCss.match(
      /\.lightink-library-source-modal \.lightink-modal-dialog\s*\{[^}]*\}/,
    )?.[0];
    expect(sourceDialog).toMatch(/width:\s*min\(22rem, calc\(100vw - 48px\)\)/);
    expect(sourceDialog).toMatch(/border-radius:\s*12px/);
  });

  it('keeps every keyboard-inset consumer touch-gated so desktop output is unchanged', () => {
    for (const [name, css] of [
      ['theme', themeCss],
      ['library', libraryCss],
    ] as const) {
      for (const rule of cssDeclarationBlocks(css)) {
        if (!rule.body.includes(KEYBOARD_INSET)) continue;
        expect(
          rule.selector,
          `${name} keyboard-inset rule must be touch-gated: ${rule.selector}`,
        ).toMatch(/html\[data-(android|touch-primary|keyboard)\]/);
      }
    }
  });
});
