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

  it('source/group/cache/membership/sheet/note overlays consume keyboard-inset', () => {
    const overlays: Array<{ name: string; tokens: readonly string[] }> = [
      { name: 'source', tokens: ['.lightink-library-source-modal'] },
      { name: 'group', tokens: ['.lightink-library-group-modal'] },
      { name: 'cache', tokens: ['.lightink-library-cache-limit-modal'] },
      {
        // 单一扣减（T4-A2）：membership 只有 overlay 消费 keyboard-inset；
        // dialog 的 max-height 无 inset 项（见下方 points 校验）。
        name: 'membership',
        tokens: ['.lightink-library-membership-overlay'],
      },
      // archive-password overlay 的 keyboard-inset 消费在 TS 内联样式
      // （archive-password-dialog.ts 的 overlay.style.paddingBottom，
      // 见下方 TS 断言）；CSS 侧死规则已删（T3 清理）。
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
      // archive-password 的 bottom 通道由 TS 内联 paddingBottom 提供
      // （下方 TS 断言）；CSS 侧死规则已删（T3 清理），不在此校验。
      // 前缀 token 同时覆盖 membership-overlay（bottom 通道）与
      // membership-dialog（max-height 不得含 inset 项）两个双扣点。
      { name: 'membership overlay/dialog', css: libraryCss, token: '.lightink-library-membership' },
    ];
    for (const point of points) {
      const rules = cssDeclarationBlocks(point.css).filter(
        (rule) => rule.selector.includes(point.token) && rule.body.includes(KEYBOARD_INSET),
      );
      expect(rules, `${point.name} must consume keyboard-inset`).not.toHaveLength(0);
      for (const rule of rules) {
        // 键盘态（html[data-keyboard]）规则是第二锚（pinFixedOverlay 范式）：
        // bottom 通道已完成唯一位移扣减，max-height 只钳视口上缘，不是双扣。
        if (rule.selector.includes('html[data-keyboard]')) continue;
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
    expect(archiveDialogSource, 'archive-password lifts via the overlay bottom offset').toContain(
      "paddingBottom = 'var(--lightink-keyboard-inset, 0px)'",
    );
    expect(
      archiveDialogSource,
      'archive-password max-height must not consume keyboard-inset',
    ).not.toMatch(/maxHeight\s*=\s*'[^']*--lightink-keyboard-inset/);
    // T4-A2：cache-limit overlay 的 bottom 通道完全交给 library.css 的
    // max(safe-bottom, keyboard-inset)——内联 paddingBottom 特异性更高，会把
    // sheet 的 safe-bottom 通道覆盖归零（键盘收起时贴屏幕底缘）。
    expect(
      libraryManageSource,
      'library-manage must not inline any keyboard-inset style',
    ).not.toContain('--lightink-keyboard-inset');
  });

  it('keeps the source/group dialogs centered cards on touch phones (no bottom sheet)', () => {
    // 旧 ≤760px sheet 块在无显式列的 grid 里用 width:100% 会退化成内容宽度，
    // 渲成贴底窄盒；居中卡片不再有任何 sheet 媒体块。
    const sheetBlocks = mediaQueryBlocks(libraryCss, '(max-width: 760px)').filter(
      (block) =>
        block.includes('.lightink-library-source-modal') ||
        block.includes('.lightink-library-group-modal'),
    );
    expect(sheetBlocks).toHaveLength(0);
    for (const token of ['.lightink-library-source-modal', '.lightink-library-group-modal']) {
      const centered = cssDeclarationBlocks(libraryCss).find(
        (rule) =>
          rule.selector.includes('html[data-android]') &&
          rule.selector.includes(token) &&
          !rule.selector.includes('.lightink-modal-dialog') &&
          /place-items:\s*center/.test(rule.body),
      );
      expect(centered, `${token} is a centered card on touch`).toBeDefined();
      // 任何触屏/键盘态规则都不得把来源/组锚到底部。
      const bottomAnchored = cssDeclarationBlocks(libraryCss).filter(
        (rule) => rule.selector.includes(token) && /align-items:\s*end/.test(rule.body),
      );
      expect(bottomAnchored, `${token} must not anchor to the bottom`).toHaveLength(0);
    }
    // 卡片宽度沿通用触屏规则（近全宽、16px 圆角）。
    expect(libraryCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\s*\.lightink-library-group-modal\s*\.lightink-modal-dialog,[\s\S]*?\.lightink-library-membership-dialog\s*\{[^}]*width:\s*calc\(100vw - 24px\)[^}]*border-radius:\s*16px/,
    );
  });

  it('keeps the cache-limit dialog centered on touch instead of a bottom sheet', () => {
    expect(libraryCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-cache-limit-modal\s*\{[^}]*place-items:\s*center/,
    );
    const keyboardEnd = cssDeclarationBlocks(libraryCss).find(
      (rule) =>
        rule.selector.includes('html[data-keyboard]') &&
        rule.selector.includes('.lightink-library-cache-limit-modal') &&
        /align-items:\s*end/.test(rule.body),
    );
    expect(keyboardEnd, 'cache-limit must not pin to the keyboard top').toBeUndefined();
  });

  it('keeps source/group dialogs centered above the keyboard and caps their height without double deduction', () => {
    for (const token of ['.lightink-library-source-modal', '.lightink-library-group-modal']) {
      // 键盘态：1fr 行让 dialog 的百分比 max-height 有定高可解析；避开 safe-top。
      const row = cssDeclarationBlocks(libraryCss).find(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes(token) &&
          !rule.selector.includes('.lightink-modal-dialog') &&
          /grid-template-rows:\s*minmax\(0, 1fr\)/.test(rule.body),
      );
      expect(row, `${token} gives the dialog a definite row when the keyboard is open`).toBeDefined();
      expect(row!.body).toMatch(/padding-top:\s*var\(--lightink-safe-top, 0px\)/);
      expect(row!.body).not.toMatch(/align-items:\s*end/);
      const capped = cssDeclarationBlocks(libraryCss).find(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes(token) &&
          rule.selector.includes('.lightink-modal-dialog') &&
          /max-height:\s*calc\(100% - 24px\)/.test(rule.body),
      );
      expect(capped, `${token} dialog caps to the visible area when open`).toBeDefined();
    }
    // 成员 sheet 仍锚到键盘上缘。
    expect(
      cssDeclarationBlocks(libraryCss).some(
        (rule) =>
          rule.selector.includes('html[data-keyboard]') &&
          rule.selector.includes('.lightink-library-membership-overlay') &&
          /align-items:\s*end/.test(rule.body),
      ),
    ).toBe(true);
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

  it('re-anchors the touch context menu above the keyboard (height clamp, no double shift)', () => {
    // FB4：键盘态 max-height 钳到键盘上方可视区（双锚，pinFixedOverlay 范式）；
    // bottom 通道仍是唯一位移扣减，横屏 IME 时菜单顶端不溢出视口。
    expect(themeCss).toMatch(
      /html\[data-keyboard\]:is\(\[data-android\], \[data-touch-primary\]\) \.lightink-context-menu\s*\{[^}]*max-height:\s*calc\(100dvh - var\(--lightink-keyboard-inset, 0px\) - 24px\)/,
    );
  });

  it('washes membership overlay buttons on touch (portaled above .lightink-library)', () => {
    // FB2：membership overlay 挂 document.body，`.lightink-library button` 通用
    // 洗色不命中；overlay 自身的门控组选择器须覆盖其表单按钮。
    expect(libraryCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\s*\.lightink-library-membership-overlay\s*button:not\(:disabled\):active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--lightink-accent\) 14%, transparent\)/,
    );
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
