/**
 * tokens.css 结构性测试（node 环境，经 fs 读取文件文本断言）：
 *   - warm-light / dark 两个内置主题块均存在；
 *   - warm-light 背景为暖色护眼、非纯白；
 *   - 四个主题都定义了主要语法令牌（keyword/comment/string/number/
 *     function/title/variable/attr/builtin/literal/punctuation）；
 *   - function 与 title、number 与 literal 在每套主题里必须是不同 hex；
 *   - comment/keyword/string/function/variable/number 两两 hex 不同；
 *   - attr ≠ string、attr ≠ punctuation、number ≠ punctuation；
 *   - keyword/comment/string/number/attr/punctuation/code-fg 相对该主题
 *     --lightink-code-bg 的 WCAG 对比度 ≥ 4.5:1；
 *   - :root / warm-light 定义嵌套 chrome 半径令牌，且 control < panel < dialog；
 *   - hljs-* 类选择器已映射到主题令牌（T5 高亮输出的类有颜色来源），
 *     含 .hljs-punctuation、.hljs-meta、.hljs-variable、
 *     .hljs-addition → string、.hljs-deletion → danger；
 *     .hljs-attr / .hljs-attribute 留在 attr，不与 variable 共用。
 *
 * 说明：不锁死具体艺术 hex，只锁不变量。视觉气质无法 headless 验证。
 * 注：项目未装 @types/node 且 vitest 会把 CSS 的 `?raw` 导入存根为空，
 * 故用最小 ambient 声明 + fs 读取原始文件文本。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf-8');

const BUILTIN_THEMES = ['warm-light', 'cool-light', 'dark', 'midnight'] as const;

const SYNTAX_ROLES = [
  'comment',
  'keyword',
  'string',
  'function',
  'variable',
  'number',
] as const;

/** R3 要求相对 code-bg ≥4.5:1 的语法角色（不含已由 code-fg 覆盖的默认字色）。 */
const CONTRAST_ROLES = [
  'keyword',
  'comment',
  'string',
  'number',
  'attr',
  'punctuation',
] as const;

/** 提取 `[data-theme="<id>"] { ... }` 块的内容（允许组合选择器如 `:root,`）。 */
function themeBlock(id: string): string {
  const re = new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([\\s\\S]*?)\\}`);
  const match = re.exec(css);
  if (match === null) {
    throw new Error(`tokens.css 缺少 [data-theme="${id}"] 主题块`);
  }
  return match[1];
}

/** 从块文本中取某个 CSS 自定义属性的值。 */
function tokenValue(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const match = re.exec(block);
  if (match === null) {
    throw new Error(`主题块缺少令牌 ${name}`);
  }
  return match[1].trim();
}

function parseHex(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex === null) {
    throw new Error(`期望 #rrggbb，实际 ${value}`);
  }
  const n = hex[1];
  return [1, 3, 5].map((i) => parseInt(n.slice(i - 1, i + 1), 16)) as [number, number, number];
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(value: string): number {
  const [r, g, b] = parseHex(value);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 2 相对亮度对比度；(L1 + 0.05) / (L2 + 0.05)。 */
function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe('tokens.css 内置主题', () => {
  it('包含 warm-light 与 dark 两个主题块', () => {
    expect(css).toContain('[data-theme="warm-light"]');
    expect(css).toContain('[data-theme="dark"]');
  });

  it('warm-light 背景为暖色护眼、非纯白', () => {
    const bg = tokenValue(themeBlock('warm-light'), '--lightink-bg').toLowerCase();
    expect(bg).not.toBe('#fff');
    expect(bg).not.toBe('#ffffff');
    expect(bg).not.toBe('white');
    // 暖纸色：R ≥ G ≥ B 且整体明亮（护眼浅色的结构特征）。
    const hex = /^#([0-9a-f]{6})$/.exec(bg);
    expect(hex, `warm-light 背景应为 #rrggbb，实际 ${bg}`).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt((hex as RegExpExecArray)[1].slice(i - 1, i + 1), 16));
    expect(r).toBeGreaterThanOrEqual(g);
    expect(g).toBeGreaterThanOrEqual(b);
    expect(r).toBeGreaterThan(0xd0); // 明亮浅色
  });

  it('dark 背景为深色', () => {
    const bg = tokenValue(themeBlock('dark'), '--lightink-bg').toLowerCase();
    const hex = /^#([0-9a-f]{6})$/.exec(bg);
    expect(hex, `dark 背景应为 #rrggbb，实际 ${bg}`).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt((hex as RegExpExecArray)[1].slice(i - 1, i + 1), 16));
    expect((r + g + b) / 3).toBeLessThan(0x60);
  });

  it.each(['warm-light', 'dark'])('%s 定义 chrome/overlay elevation 令牌 (R5)', (id) => {
    const block = themeBlock(id);
    for (const token of ['--lightink-overlay', '--lightink-shadow', '--lightink-shadow-strong']) {
      expect(tokenValue(block, token).length).toBeGreaterThan(0);
    }
  });

  it.each(['warm-light', 'dark'])('%s 定义可读性字体/排版令牌', (id) => {
    const block = themeBlock(id);
    for (const token of [
      '--lightink-font-ui',
      '--lightink-font-body',
      '--lightink-font-mono',
      '--lightink-font-size',
      '--lightink-font-size-code',
      '--lightink-line-height-body',
      '--lightink-line-height-code',
      '--lightink-measure',
      '--lightink-page-pad-x',
      '--lightink-page-pad-y',
      '--lightink-outline-width',
    ]) {
      expect(tokenValue(block, token).length).toBeGreaterThan(0);
    }
  });

  it('warm-light 注释色比旧版更易读（非过浅灰）', () => {
    const comment = tokenValue(themeBlock('warm-light'), '--lightink-syntax-comment').toLowerCase();
    const hex = /^#([0-9a-f]{6})$/.exec(comment);
    expect(hex).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt((hex as RegExpExecArray)[1].slice(i - 1, i + 1), 16),
    );
    // Readable muted text on cream: average channel should sit mid-dark, not washed out.
    expect((r + g + b) / 3).toBeLessThan(0xb0);
    expect((r + g + b) / 3).toBeGreaterThan(0x50);
  });

  it.each(BUILTIN_THEMES)('%s 定义全部主要语法令牌', (id) => {
    const block = themeBlock(id);
    for (const token of [
      '--lightink-syntax-keyword',
      '--lightink-syntax-comment',
      '--lightink-syntax-string',
      '--lightink-syntax-number',
      '--lightink-syntax-function',
      '--lightink-syntax-title',
      '--lightink-syntax-variable',
      '--lightink-syntax-attr',
      '--lightink-syntax-builtin',
      '--lightink-syntax-literal',
      '--lightink-syntax-punctuation',
    ]) {
      const value = tokenValue(block, token);
      expect(value, `${id} 的 ${token} 应有颜色值`).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
    // 基础界面令牌
    for (const token of [
      '--lightink-bg',
      '--lightink-fg',
      '--lightink-muted',
      '--lightink-accent',
      '--lightink-border',
      '--lightink-code-bg',
      '--lightink-code-fg',
    ]) {
      tokenValue(block, token);
    }
  });

  it.each(BUILTIN_THEMES)('%s number 与 literal 令牌颜色不同', (id) => {
    const block = themeBlock(id);
    const number = tokenValue(block, '--lightink-syntax-number').toLowerCase();
    const literal = tokenValue(block, '--lightink-syntax-literal').toLowerCase();
    expect(number, `${id} number 与 literal 不得同色`).not.toBe(literal);
    expect(number).toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(literal).toMatch(/^#[0-9a-f]{3,8}$/i);
  });

  it.each(BUILTIN_THEMES)('%s function 与 title 令牌颜色不同', (id) => {
    const block = themeBlock(id);
    const fn = tokenValue(block, '--lightink-syntax-function').toLowerCase();
    const title = tokenValue(block, '--lightink-syntax-title').toLowerCase();
    expect(fn, `${id} function 与 title 不得同色`).not.toBe(title);
    expect(fn).toMatch(/^#[0-9a-f]{6}$/i);
    expect(title).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(BUILTIN_THEMES)('%s 六类语法角色两两 hex 不同', (id) => {
    const block = themeBlock(id);
    const roles = SYNTAX_ROLES.map((role) => ({
      role,
      value: tokenValue(block, `--lightink-syntax-${role}`).toLowerCase(),
    }));
    for (const { role, value } of roles) {
      expect(value, `${id} ${role} 应为 #rrggbb`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        expect(
          roles[i].value,
          `${id} ${roles[i].role} 与 ${roles[j].role} 不得同色`,
        ).not.toBe(roles[j].value);
      }
    }
  });

  it.each(BUILTIN_THEMES)('%s attr 与 string、punctuation 不同色，number 与 punctuation 不同色', (id) => {
    const block = themeBlock(id);
    const attr = tokenValue(block, '--lightink-syntax-attr').toLowerCase();
    const string = tokenValue(block, '--lightink-syntax-string').toLowerCase();
    const punctuation = tokenValue(block, '--lightink-syntax-punctuation').toLowerCase();
    const number = tokenValue(block, '--lightink-syntax-number').toLowerCase();
    expect(attr).toMatch(/^#[0-9a-f]{6}$/i);
    expect(string).toMatch(/^#[0-9a-f]{6}$/i);
    expect(punctuation).toMatch(/^#[0-9a-f]{6}$/i);
    expect(number).toMatch(/^#[0-9a-f]{6}$/i);
    expect(attr, `${id} attr 与 string 不得同色`).not.toBe(string);
    expect(attr, `${id} attr 与 punctuation 不得同色`).not.toBe(punctuation);
    expect(number, `${id} number 与 punctuation 不得同色`).not.toBe(punctuation);
  });

  it.each(BUILTIN_THEMES)('%s R3 角色与 code-fg 相对 code-bg 对比度 ≥ 4.5:1', (id) => {
    const block = themeBlock(id);
    const codeBg = tokenValue(block, '--lightink-code-bg');
    expect(codeBg).toMatch(/^#[0-9a-f]{6}$/i);
    const roles: Array<readonly [string, string]> = [
      ...CONTRAST_ROLES.map((role) => [`--lightink-syntax-${role}`, tokenValue(block, `--lightink-syntax-${role}`)] as const),
      ['--lightink-code-fg', tokenValue(block, '--lightink-code-fg')] as const,
    ];
    for (const [name, value] of roles) {
      expect(value, `${id} ${name}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(
        contrastRatio(value, codeBg),
        `${id} ${name} ${value} vs code-bg ${codeBg}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('定义嵌套 chrome 半径令牌且 control < panel < dialog', () => {
    const block = themeBlock('warm-light');
    const control = tokenValue(block, '--lightink-radius-control');
    const panel = tokenValue(block, '--lightink-radius-panel');
    const dialog = tokenValue(block, '--lightink-radius-dialog');
    expect(control).toBe('6px');
    expect(panel).toBe('10px');
    expect(dialog).toBe('12px');
    expect(parseFloat(control)).toBeLessThan(parseFloat(panel));
    expect(parseFloat(panel)).toBeLessThan(parseFloat(dialog));
  });
});

describe('tokens.css hljs 类映射', () => {
  it('主要 hljs 类选择器均映射到语法令牌', () => {
    for (const cls of [
      '.hljs-keyword',
      '.hljs-comment',
      '.hljs-string',
      '.hljs-number',
      '.hljs-function',
      '.hljs-title',
      '.hljs-attr',
      '.hljs-attribute',
      '.hljs-variable',
      '.hljs-template-variable',
      '.hljs-built_in',
      '.hljs-literal',
      '.hljs-punctuation',
      '.hljs-meta',
      '.hljs-addition',
      '.hljs-deletion',
    ]) {
      expect(css).toContain(cls);
    }
    // 映射必须落到 var(--lightink-syntax-*)，保证随主题/自定义主题切换。
    expect(css).toMatch(/\.hljs-keyword[^{]*\{[^}]*var\(--lightink-syntax-keyword\)/);
    expect(css).toMatch(/\.hljs-comment[^{]*\{[^}]*var\(--lightink-syntax-comment\)/);
    expect(css).toMatch(/\.hljs-string[^{]*\{[^}]*var\(--lightink-syntax-string\)/);
    expect(css).toMatch(/\.hljs-number[^{]*\{[^}]*var\(--lightink-syntax-number\)/);
    expect(css).toMatch(/\.hljs-title\.function_[^{]*\{[^}]*var\(--lightink-syntax-function\)/);
    expect(css).toMatch(/\.hljs-title\.class_[^{]*\{[^}]*var\(--lightink-syntax-title\)/);
    expect(css).toMatch(/\.hljs-attr[^{]*\{[^}]*var\(--lightink-syntax-attr\)/);
    expect(css).toMatch(/\.hljs-attribute[^{]*\{[^}]*var\(--lightink-syntax-attr\)/);
    expect(css).toMatch(/\.hljs-variable[^{]*\{[^}]*var\(--lightink-syntax-variable\)/);
    expect(css).toMatch(/\.hljs-template-variable[^{]*\{[^}]*var\(--lightink-syntax-variable\)/);
    expect(css).toMatch(/\.hljs-built_in[^{]*\{[^}]*var\(--lightink-syntax-builtin\)/);
    expect(css).toMatch(/\.hljs-punctuation[^{]*\{[^}]*var\(--lightink-syntax-punctuation\)/);
    expect(css).toMatch(/\.hljs-meta\s*\{[^}]*var\(--lightink-syntax-comment\)/);
    expect(css).toMatch(/\.hljs-addition[^{]*\{[^}]*var\(--lightink-syntax-string\)/);
    expect(css).toMatch(/\.hljs-deletion[^{]*\{[^}]*var\(--lightink-danger\)/);
  });
});
