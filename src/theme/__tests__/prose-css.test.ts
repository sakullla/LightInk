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
