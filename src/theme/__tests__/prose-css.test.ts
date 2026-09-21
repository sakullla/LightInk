/**
 * prose.css / tokens.css / theme.css 排版契约（node，readFileSync 文本断言）。
 * 锁定单一模数比例、节奏倍率单调、CJK 作用域与复位、theme.css 无第二份排版声明。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const tokensCss = readFileSync(new URL('../tokens.css', import.meta.url), 'utf-8');
const proseCss = stripCssComments(
  readFileSync(new URL('../prose.css', import.meta.url), 'utf-8'),
);
const themeCss = stripCssComments(
  readFileSync(new URL('../../ui/theme.css', import.meta.url), 'utf-8'),
);

const NEW_TOKENS = [
  '--lightink-heading-ratio',
  '--lightink-heading-line-height',
  '--lightink-heading-line-height-tight',
  '--lightink-letter-spacing-body',
  '--lightink-gap-list-item',
  '--lightink-gap-paragraph',
  '--lightink-gap-block',
  '--lightink-gap-rule',
  '--lightink-gap-heading-minor',
  '--lightink-gap-heading-major',
] as const;

function themeBlockText(id: string): string {
  const re = new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([\\s\\S]*?)\\}`);
  const match = re.exec(tokensCss);
  if (match === null) {
    throw new Error(`tokens.css 缺少 [data-theme="${id}"] 主题块`);
  }
  return match[1];
}

function tokenValue(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const match = re.exec(block);
  if (match === null) {
    throw new Error(`主题块缺少令牌 ${name}`);
  }
  return match[1].trim();
}

function headingRule(level: number): string {
  const re = new RegExp(`\\.lightink-prose\\s+h${level}\\s*\\{([^}]*)\\}`);
  const match = re.exec(proseCss);
  if (match === null) {
    throw new Error(`prose.css 缺少 .lightink-prose h${level} 规则`);
  }
  return match[1];
}

function countRatioMultiplies(body: string): number {
  return (body.match(/var\(--lightink-heading-ratio\)/g) ?? []).length;
}

function declarationBlocks(css: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const selector = match[1].replace(/\s+/g, ' ').trim();
    if (selector === '') continue;
    blocks.push({ selector, body: match[2] });
  }
  return blocks;
}

function hasTypographyDecl(body: string): boolean {
  return /(?:^|[;\s])(?:font-size|line-height|margin|margin-top|margin-bottom)\s*:/.test(
    body,
  );
}

describe('tokens.css 排版令牌', () => {
  it(':root / warm-light 顶层定义全部新排版令牌', () => {
    const block = themeBlockText('warm-light');
    for (const name of NEW_TOKENS) {
      expect(tokenValue(block, name).length).toBeGreaterThan(0);
    }
  });

  it('--lightink-heading-ratio 落在 [1.15, 1.3]', () => {
    const ratio = Number(tokenValue(themeBlockText('warm-light'), '--lightink-heading-ratio'));
    expect(ratio).toBeGreaterThanOrEqual(1.15);
    expect(ratio).toBeLessThanOrEqual(1.3);
  });

  it('间距倍率单调：list-item < paragraph ≤ block ≤ rule ≤ heading-minor < heading-major', () => {
    const block = themeBlockText('warm-light');
    const listItem = Number(tokenValue(block, '--lightink-gap-list-item'));
    const paragraph = Number(tokenValue(block, '--lightink-gap-paragraph'));
    const gapBlock = Number(tokenValue(block, '--lightink-gap-block'));
    const rule = Number(tokenValue(block, '--lightink-gap-rule'));
    const headingMinor = Number(tokenValue(block, '--lightink-gap-heading-minor'));
    const headingMajor = Number(tokenValue(block, '--lightink-gap-heading-major'));
    expect(listItem).toBeLessThan(paragraph);
    expect(paragraph).toBeLessThanOrEqual(gapBlock);
    expect(gapBlock).toBeLessThanOrEqual(rule);
    expect(rule).toBeLessThanOrEqual(headingMinor);
    expect(headingMinor).toBeLessThan(headingMajor);
  });

  it.each(['warm-light', 'cool-light', 'dark', 'midnight'] as const)(
    '%s 主题块保持单层扁平规则',
    (id) => {
      expect(themeBlockText(id), '主题块内不得出现嵌套花括号').not.toContain('{');
    },
  );
});

describe('prose.css 标题比例与节奏', () => {
  it('所有规则以 .lightink-prose 为作用域前缀', () => {
    for (const { selector } of declarationBlocks(proseCss)) {
      if (selector.startsWith('@')) continue;
      expect(selector.startsWith('.lightink-prose'), selector).toBe(true);
    }
  });

  it('h6…h1 字号为 1em 与 1–5 次 heading-ratio 乘法链', () => {
    expect(headingRule(6)).toMatch(/font-size:\s*1em/);
    expect(countRatioMultiplies(headingRule(6))).toBe(0);
    for (let level = 5; level >= 1; level -= 1) {
      const body = headingRule(level);
      expect(body).toContain('font-size:');
      expect(body).toContain('calc(');
      expect(countRatioMultiplies(body)).toBe(6 - level);
      expect(body).not.toMatch(/pow\s*\(/);
    }
  });

  it('h1–h2 用 tight 行高，h3–h6 用普通行高', () => {
    expect(headingRule(1)).toContain('var(--lightink-heading-line-height-tight)');
    expect(headingRule(2)).toContain('var(--lightink-heading-line-height-tight)');
    for (const level of [3, 4, 5, 6]) {
      expect(headingRule(level)).toMatch(/line-height:\s*var\(--lightink-heading-line-height\)/);
      expect(headingRule(level)).not.toContain('--lightink-heading-line-height-tight');
    }
  });

  it('标题 margin-top 引用 major/minor，margin-bottom 引用 paragraph', () => {
    expect(headingRule(1)).toContain('var(--lightink-gap-heading-major)');
    expect(headingRule(2)).toContain('var(--lightink-gap-heading-major)');
    for (const level of [3, 4, 5, 6]) {
      expect(headingRule(level)).toContain('var(--lightink-gap-heading-minor)');
    }
    for (let level = 1; level <= 6; level += 1) {
      expect(headingRule(level)).toContain('var(--lightink-gap-paragraph)');
    }
  });

  it('节奏单位是 font-size × font-scale × line-height-body 的 px/数值 calc', () => {
    expect(proseCss).toMatch(
      /--lightink-rhythm-unit:\s*calc\(\s*var\(--lightink-font-size,\s*16px\)\s*\*\s*var\(--lightink-font-scale,\s*1\)\s*\*\s*var\(--lightink-line-height-body,\s*1\.75\)/,
    );
    const unitDecl = proseCss.match(/--lightink-rhythm-unit:\s*calc\(([\s\S]*?)\);/);
    expect(unitDecl).not.toBeNull();
    const expr = unitDecl![1];
    expect(expr).not.toMatch(/\bem\b/);
    expect(expr).not.toMatch(/\brem\b/);
    expect(proseCss).not.toContain('@property');
  });

  it('块级 margin 只由 rhythm-unit × 对应倍率构成', () => {
    const cases: Array<{ selector: string; gap: string }> = [
      { selector: '.lightink-prose p', gap: '--lightink-gap-paragraph' },
      { selector: '.lightink-prose li', gap: '--lightink-gap-list-item' },
      { selector: '.lightink-prose hr', gap: '--lightink-gap-rule' },
    ];
    for (const { selector, gap } of cases) {
      const block = declarationBlocks(proseCss).find((rule) => rule.selector === selector);
      expect(block, selector).toBeDefined();
      expect(block!.body).toContain('var(--lightink-rhythm-unit)');
      expect(block!.body).toContain(`var(${gap})`);
    }
    const shared = declarationBlocks(proseCss).find((rule) =>
      rule.selector.includes('.lightink-code-block') &&
      rule.selector.includes('.tableWrapper') &&
      rule.selector.includes('.lightink-math-preview') &&
      rule.selector.includes('.lightink-mermaid'),
    );
    expect(shared, 'blockquote / code / table / img / math / mermaid 共享 block 倍率').toBeDefined();
    expect(shared!.body).toContain('var(--lightink-rhythm-unit)');
    expect(shared!.body).toContain('var(--lightink-gap-block)');
  });

  it('.lightink-prose > :first-child 的 margin-top 为 0', () => {
    expect(proseCss).toMatch(/\.lightink-prose\s*>\s*:first-child\s*\{[^}]*margin-top:\s*0/);
  });

  it('blockquote / 单元格折叠首尾子块外边距，避免引用盒被段落间隙撑空', () => {
    expect(proseCss).toMatch(
      /\.lightink-prose :is\(blockquote, th, td\)\s*>\s*:first-child\s*\{[^}]*margin-top:\s*0/,
    );
    expect(proseCss).toMatch(
      /\.lightink-prose :is\(blockquote, th, td\)\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0/,
    );
    const cellP = declarationBlocks(proseCss).find(
      (rule) => rule.selector === '.lightink-prose :is(th, td) > p',
    );
    expect(cellP).toBeDefined();
    expect(cellP!.body).toMatch(/margin-top:\s*0/);
    expect(cellP!.body).toMatch(/margin-bottom:\s*0/);
  });
});

describe('prose.css 引用 / 列表 / 顶层表几何', () => {
  it('blockquote 只复位 margin-inline，不写 margin: 0', () => {
    const quote = declarationBlocks(proseCss).find(
      (rule) => rule.selector === '.lightink-prose blockquote',
    );
    expect(quote).toBeDefined();
    expect(quote!.body).toMatch(/margin-inline:\s*0/);
    expect(quote!.body).not.toMatch(/(?:^|[;\s])margin\s*:/);
    const shared = declarationBlocks(proseCss).find(
      (rule) =>
        rule.selector.includes('blockquote') &&
        rule.selector.includes('.tableWrapper') &&
        /margin-top\s*:/.test(rule.body),
    );
    expect(shared).toBeDefined();
    expect(shared!.body).toContain('var(--lightink-gap-block)');
  });

  it('ul/ol 为 padding-inline-start: 2em；theme.css 不再写 1.6em', () => {
    const lists = declarationBlocks(proseCss).find(
      (rule) => rule.selector === '.lightink-prose ul, .lightink-prose ol',
    );
    expect(lists).toBeDefined();
    expect(lists!.body).toMatch(/padding-inline-start:\s*2em/);
    expect(themeCss).not.toMatch(/\.ProseMirror ul[\s\S]*?padding-left:\s*1\.6em/);
  });

  it('仅顶层 .lightink-prose > .tableWrapper 做 page-pad breakout', () => {
    const breakout = declarationBlocks(proseCss).find(
      (rule) => rule.selector === '.lightink-prose > .tableWrapper',
    );
    expect(breakout).toBeDefined();
    expect(breakout!.body).toMatch(
      /width:\s*calc\(100% \+ 2 \* var\(--lightink-page-pad-x,\s*28px\)\)/,
    );
    expect(breakout!.body).toMatch(/max-width:\s*none/);
    expect(breakout!.body).toMatch(
      /margin-inline:\s*calc\(-1 \* var\(--lightink-page-pad-x,\s*28px\)\)/,
    );
    expect(breakout!.body).toMatch(/overflow-x:\s*auto/);
    expect(
      declarationBlocks(proseCss).some(
        (rule) =>
          /blockquote|li\b/.test(rule.selector) &&
          rule.selector.includes('.tableWrapper') &&
          /margin-inline\s*:/.test(rule.body),
      ),
    ).toBe(false);
  });

  it('顶层 table 回退到正文栏宽，嵌套表仍 min-width 100%', () => {
    const inset = declarationBlocks(proseCss).find(
      (rule) => rule.selector === '.lightink-prose > .tableWrapper > table',
    );
    expect(inset).toBeDefined();
    expect(inset!.body).toMatch(
      /min-width:\s*calc\(100% - 2 \* var\(--lightink-page-pad-x,\s*28px\)\)/,
    );
    expect(inset!.body).toMatch(/width:\s*max-content/);
    expect(inset!.body).toMatch(
      /margin-inline:\s*var\(--lightink-page-pad-x,\s*28px\)/,
    );
    expect(
      declarationBlocks(proseCss).some(
        (rule) =>
          rule.selector.includes('.tableWrapper') &&
          !rule.selector.includes('>') &&
          /min-width\s*:/.test(rule.body),
      ),
    ).toBe(false);
  });
});

describe('prose.css CJK 作用域与复位', () => {
  it('.lightink-prose 声明 letter-spacing、text-autospace 与 text-spacing-trim', () => {
    const root = declarationBlocks(proseCss).find((rule) => rule.selector === '.lightink-prose');
    expect(root).toBeDefined();
    expect(root!.body).toContain('letter-spacing: var(--lightink-letter-spacing-body, 0)');
    expect(root!.body).toContain('text-autospace: normal');
    expect(root!.body).toContain('text-spacing-trim: trim-start');
  });

  it('pre / code / .katex 复位为 no-autospace / space-all', () => {
    expect(proseCss).toMatch(
      /\.lightink-prose pre[\s\S]*?\.lightink-prose \.katex\s*\{[^}]*text-autospace:\s*no-autospace[^}]*text-spacing-trim:\s*space-all/,
    );
  });

  it('存在 @supports not (text-spacing-trim: trim-start) 回退 halt', () => {
    expect(proseCss).toContain('@supports not (text-spacing-trim: trim-start)');
    expect(proseCss).toMatch(/font-feature-settings:\s*['"]halt['"]\s*1/);
  });
});

describe('theme.css 不再持有第二份排版声明', () => {
  it('.lightink-tab-host 不再声明 letter-spacing', () => {
    const host = declarationBlocks(themeCss).find((rule) => rule.selector === '.lightink-tab-host');
    expect(host).toBeDefined();
    expect(host!.body).not.toMatch(/letter-spacing\s*:/);
  });

  it('被接管选择器规则体不含 font-size / line-height / margin', () => {
    const owned = [
      '.lightink-tab-host .ProseMirror p',
      '.lightink-tab-host .ProseMirror ul',
      '.lightink-tab-host .ProseMirror ol',
      '.lightink-tab-host .ProseMirror li',
      '.lightink-tab-host .ProseMirror li > p',
      '.lightink-tab-host blockquote',
      '.lightink-code-block',
      '.lightink-tab-host .tableWrapper',
      '.lightink-tab-host img',
      '.lightink-tab-host hr',
      '.lightink-math-preview',
      '.lightink-mermaid',
    ];
    const headingSel =
      '.lightink-tab-host .ProseMirror h1, .lightink-tab-host .ProseMirror h2, .lightink-tab-host .ProseMirror h3, .lightink-tab-host .ProseMirror h4, .lightink-tab-host .ProseMirror h5, .lightink-tab-host .ProseMirror h6';
    for (const { selector, body } of declarationBlocks(themeCss)) {
      const isHeadingGroup = selector === headingSel;
      const isOwned = owned.includes(selector) || isHeadingGroup;
      if (!isOwned) continue;
      expect(hasTypographyDecl(body), selector).toBe(false);
    }
  });

  it('源码模式两层复位块含 CJK 复位', () => {
    const source = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-source-editor',
    );
    const highlight = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host pre.lightink-source-highlight',
    );
    expect(source).toBeDefined();
    expect(highlight).toBeDefined();
    for (const block of [source!, highlight!]) {
      expect(block.body).toContain('text-autospace: no-autospace');
      expect(block.body).toContain('text-spacing-trim: space-all');
    }
  });

  it('栏宽字面量仍存在且先于阅读器宿主覆盖', () => {
    const measure = themeCss.indexOf('max-width: var(--lightink-measure, 48rem);');
    const readerHost = themeCss.indexOf('.lightink-tab-host.lightink-tab-host--reader');
    expect(measure).toBeGreaterThan(-1);
    expect(readerHost).toBeGreaterThan(measure);
  });
});

function cssCustomProperty(body: string, name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
  if (match === null) {
    throw new Error(`规则体缺少 ${name}`);
  }
  return match[1].trim();
}

function measureOf(selector: string): string {
  const block = declarationBlocks(themeCss).find((rule) => rule.selector === selector);
  expect(block, selector).toBeDefined();
  return cssCustomProperty(block!.body, '--lightink-measure');
}

const READER_SHELL_HOST =
  ":is(html[data-android], html[data-touch-primary])[data-workspace-mode='reader'] #lightink-editor-area[data-surface='markdown'] .lightink-tab-host";

function readerShellMeasure(display: string): string {
  const attr = `[data-display='${display}']`;
  const block = declarationBlocks(themeCss).find(
    (rule) =>
      rule.selector.includes("[data-workspace-mode='reader']") &&
      rule.selector.includes("[data-surface='markdown']") &&
      rule.selector.includes('.lightink-tab-host') &&
      rule.selector.includes(attr) &&
      !rule.selector.includes(`:not(${attr})`) &&
      /--lightink-measure\s*:/.test(rule.body),
  );
  expect(block, `reader-shell ${display}`).toBeDefined();
  return cssCustomProperty(block!.body, '--lightink-measure');
}

describe('theme.css Markdown 栏宽分档', () => {
  it('compact / 窄窗为 min(44rem, 94%)', () => {
    expect(measureOf("html[data-display='compact']")).toBe('min(44rem, 94%)');
    expect(
      measureOf(
        "html:not([data-display='qhd']):not([data-display='uhd']):not([data-display='xuhd'])",
      ),
    ).toBe('min(44rem, 94%)');
  });

  it('hd 为 min(56rem, 94%)', () => {
    expect(measureOf("html[data-display='hd']")).toBe('min(56rem, 94%)');
  });

  it('qhd 及以上为 58/60/62rem', () => {
    expect(measureOf("html[data-display='qhd']")).toBe('min(58rem, 94%)');
    expect(measureOf("html[data-display='uhd']")).toBe('min(60rem, 94%)');
    expect(measureOf("html[data-display='xuhd']")).toBe('min(62rem, 94%)');
    expect(
      measureOf(
        "html:not([data-display='uhd']):not([data-display='xuhd']):not([data-display='compact'])",
      ),
    ).toBe('min(58rem, 94%)');
    expect(measureOf("html:not([data-display='xuhd']):not([data-display='compact'])")).toBe(
      'min(60rem, 94%)',
    );
    const wideHtml = declarationBlocks(themeCss).filter(
      (rule) => rule.selector === 'html' && /--lightink-measure\s*:/.test(rule.body),
    );
    expect(wideHtml).toHaveLength(1);
    expect(cssCustomProperty(wideHtml[0].body, '--lightink-measure')).toBe('min(62rem, 94%)');
  });

  it('html 分档 --lightink-measure 只使用 44/56/58/60/62rem 上限且均与 94% 取 min', () => {
    const htmlMeasures = declarationBlocks(themeCss)
      .filter(
        (rule) =>
          /^(html\b|:root\b)/.test(rule.selector) && /--lightink-measure\s*:/.test(rule.body),
      )
      .map((rule) => cssCustomProperty(rule.body, '--lightink-measure'));
    expect(htmlMeasures.length).toBeGreaterThan(0);
    for (const value of htmlMeasures) {
      expect(value).toMatch(/^min\((44|56|58|60|62)rem,\s*94%\)$/);
    }
    expect(tokensCss).toMatch(/--lightink-measure:\s*min\(56rem,\s*94%\)/);
  });

  it('触控阅读壳 markdown 宿主覆盖栏宽 32/36/40rem，编辑器仍走 html 档', () => {
    const host = declarationBlocks(themeCss).find((rule) => rule.selector === '.lightink-tab-host');
    expect(host).toBeDefined();
    expect(host!.body).toContain('max-width: var(--lightink-measure, 48rem)');
    expect(host!.body).toMatch(/width:\s*100%/);
    expect(host!.body).not.toMatch(/1\.125/);
    expect(host!.body).toMatch(
      /font-size:\s*calc\(\s*var\(--lightink-font-size,\s*16px\)\s*\*\s*var\(--lightink-font-scale,\s*1\)\s*\)/,
    );

    expect(measureOf(READER_SHELL_HOST)).toBe('min(36rem, 94%)');
    expect(readerShellMeasure('compact')).toBe('min(32rem, 94%)');
    expect(readerShellMeasure('hd')).toBe('min(36rem, 94%)');
    expect(readerShellMeasure('qhd')).toBe('min(36rem, 94%)');
    expect(readerShellMeasure('uhd')).toBe('min(40rem, 94%)');
    expect(readerShellMeasure('xuhd')).toBe('min(40rem, 94%)');
    expect(
      measureOf(
        ":is(html[data-android], html[data-touch-primary])[data-workspace-mode='reader']:not([data-display='qhd']):not([data-display='uhd']):not([data-display='xuhd']) #lightink-editor-area[data-surface='markdown'] .lightink-tab-host",
      ),
    ).toBe('min(32rem, 94%)');
    expect(
      measureOf(
        ":is(html[data-android], html[data-touch-primary])[data-workspace-mode='reader']:not([data-display='uhd']):not([data-display='xuhd']):not([data-display='compact']) #lightink-editor-area[data-surface='markdown'] .lightink-tab-host",
      ),
    ).toBe('min(36rem, 94%)');
    expect(
      measureOf(
        ":is(html[data-android], html[data-touch-primary])[data-workspace-mode='reader']:not([data-display='xuhd']):not([data-display='compact']) #lightink-editor-area[data-surface='markdown'] .lightink-tab-host",
      ),
    ).toBe('min(40rem, 94%)');

    const readerMeasures = declarationBlocks(themeCss)
      .filter(
        (rule) =>
          rule.selector.includes("[data-workspace-mode='reader']") &&
          rule.selector.includes("[data-surface='markdown']") &&
          /--lightink-measure\s*:/.test(rule.body),
      )
      .map((rule) => cssCustomProperty(rule.body, '--lightink-measure'));
    expect(readerMeasures.length).toBeGreaterThan(0);
    for (const value of readerMeasures) {
      expect(value).toMatch(/^min\((32|36|40)rem,\s*94%\)$/);
    }
  });

  it('阅读壳宿主页边 1.5×、正文字号 1.125× font-scale', () => {
    const shell = declarationBlocks(themeCss).find((rule) => rule.selector === READER_SHELL_HOST);
    expect(shell).toBeDefined();
    expect(shell!.body).toMatch(
      /padding:\s*calc\(\s*var\(--lightink-page-pad-y,\s*24px\)\s*\*\s*1\.5\)\s+calc\(\s*var\(--lightink-page-pad-x,\s*28px\)\s*\*\s*1\.5\)\s+calc\(\s*var\(--lightink-page-pad-y,\s*24px\)\s*\*\s*2\.2\s*\*\s*1\.5\)/,
    );
    expect(shell!.body).toMatch(
      /font-size:\s*calc\(\s*var\(--lightink-font-size,\s*16px\)\s*\*\s*1\.125\s*\*\s*var\(--lightink-font-scale,\s*1\)\s*\)/,
    );
  });

  it('阅读壳代码块字号同样 1.125× font-scale', () => {
    const code = declarationBlocks(themeCss).find(
      (rule) =>
        rule.selector.includes("[data-workspace-mode='reader']") &&
        rule.selector.includes("[data-surface='markdown']") &&
        rule.selector.includes('.lightink-tab-host') &&
        (rule.selector.includes('pre') || rule.selector.includes('code')) &&
        /--lightink-font-size-code/.test(rule.body),
    );
    expect(code).toBeDefined();
    expect(code!.body).toMatch(
      /font-size:\s*calc\(\s*var\(--lightink-font-size-code,\s*13\.5px\)\s*\*\s*1\.125\s*\*\s*var\(--lightink-font-scale,\s*1\)\s*\)/,
    );
  });

  it('电子书 data-surface=reader 仍 max-width none', () => {
    const ebook = declarationBlocks(themeCss).find((rule) =>
      rule.selector.includes('.lightink-tab-host.lightink-tab-host--reader'),
    );
    expect(ebook).toBeDefined();
    expect(ebook!.body).toMatch(/max-width:\s*none/);
  });

  it('正文无 justify、无首行缩进', () => {
    expect(proseCss).not.toMatch(/text-align\s*:\s*justify/);
    expect(proseCss).not.toMatch(/text-indent\s*:/);
    expect(themeCss).not.toMatch(/text-align\s*:\s*justify/);
    expect(themeCss).not.toMatch(/text-indent\s*:/);
  });

  it('代码块与宽表在栏内横向滚动，行内 code 可换行', () => {
    expect(themeCss).toMatch(
      /\.lightink-tab-host pre[\s\S]*?\.lightink-tab-host \.lightink-code-block > pre\s*\{[^}]*overflow-x:\s*auto/,
    );
    const wrapper = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host .tableWrapper',
    );
    expect(wrapper).toBeDefined();
    expect(wrapper!.body).toMatch(/overflow-x:\s*auto/);
    expect(wrapper!.body).toMatch(/width:\s*100%/);
    expect(wrapper!.body).toMatch(/max-width:\s*100%/);
    const table = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host table',
    );
    expect(table).toBeDefined();
    expect(table!.body).toMatch(/table-layout:\s*auto/);
    expect(table!.body).toMatch(/width:\s*max-content/);
    expect(table!.body).toMatch(/min-width:\s*100%/);
    expect(table!.body).not.toMatch(/table-layout:\s*fixed/);
    expect(table!.body).not.toMatch(/(?:^|[;\s])width:\s*100%/);
    expect(table!.body).not.toMatch(/overflow:\s*hidden/);
    const th = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host th',
    );
    expect(th).toBeDefined();
    expect(th!.body).toMatch(/white-space:\s*nowrap/);
    const td = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host td',
    );
    expect(td).toBeDefined();
    expect(td!.body).toMatch(/overflow-wrap:\s*break-word/);
    expect(td!.body).not.toMatch(/word-break:\s*break-all/);
    const inlineCode = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host :not(pre) > code',
    );
    expect(inlineCode).toBeDefined();
    expect(inlineCode!.body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(inlineCode!.body).not.toMatch(/border\s*:/);
    expect(inlineCode!.body).toMatch(/font-size:\s*0\.875em/);
    const cell = declarationBlocks(themeCss).find(
      (rule) => rule.selector === '.lightink-tab-host th, .lightink-tab-host td',
    );
    expect(cell).toBeDefined();
    expect(cell!.body).toMatch(/padding:\s*6px 12px/);
    expect(cell!.body).toMatch(/text-align:\s*left/);
    expect(cell!.body).not.toMatch(/text-align:\s*left\s*!important/);
    expect(cell!.body).toMatch(/min-width:\s*4\.5em/);
    expect(cell!.body).not.toMatch(/min-width:\s*48px/);
    expect(
      declarationBlocks(themeCss).some(
        (rule) => rule.selector === '.lightink-tab-host tbody tr:nth-child(even) td',
      ),
    ).toBe(true);
    expect(themeCss).toMatch(/\.lightink-tab-host \.ProseMirror \.selectedCell\s*\{/);
  });

});
