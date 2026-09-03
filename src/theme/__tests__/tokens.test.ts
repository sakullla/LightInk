/**
 * tokens.css 结构性测试（node 环境，经 fs 读取文件文本断言）：
 *   - warm-light / dark 两个内置主题块均存在；
 *   - warm-light 背景为暖色护眼、非纯白；
 *   - 四个主题都定义了主要语法令牌（keyword/comment/string/number/
 *     function/title/attr/builtin/literal/punctuation）；
 *   - number 与 literal 在每套主题里必须是不同 hex；
 *   - hljs-* 类选择器已映射到主题令牌（T5 高亮输出的类有颜色来源），
 *     含 .hljs-punctuation 与 .hljs-meta。
 *
 * 说明：视觉效果无法 headless 验证，这里只断言结构约束。
 * 注：项目未装 @types/node 且 vitest 会把 CSS 的 `?raw` 导入存根为空，
 * 故用最小 ambient 声明 + fs 读取原始文件文本。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../tokens.css', import.meta.url), 'utf-8');

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

  it.each(['warm-light', 'cool-light', 'dark', 'midnight'])('%s 定义全部主要语法令牌', (id) => {
    const block = themeBlock(id);
    for (const token of [
      '--lightink-syntax-keyword',
      '--lightink-syntax-comment',
      '--lightink-syntax-string',
      '--lightink-syntax-number',
      '--lightink-syntax-function',
      '--lightink-syntax-title',
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
    ]) {
      tokenValue(block, token);
    }
  });

  it.each(['warm-light', 'cool-light', 'dark', 'midnight'])(
    '%s number 与 literal 令牌颜色不同',
    (id) => {
      const block = themeBlock(id);
      const number = tokenValue(block, '--lightink-syntax-number').toLowerCase();
      const literal = tokenValue(block, '--lightink-syntax-literal').toLowerCase();
      expect(number, `${id} number 与 literal 不得同色`).not.toBe(literal);
      expect(number).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(literal).toMatch(/^#[0-9a-f]{3,8}$/i);
    },
  );
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
      '.hljs-built_in',
      '.hljs-literal',
      '.hljs-punctuation',
      '.hljs-meta',
    ]) {
      expect(css).toContain(cls);
    }
    // 映射必须落到 var(--lightink-syntax-*)，保证随主题/自定义主题切换。
    expect(css).toMatch(/\.hljs-keyword[^{]*\{[^}]*var\(--lightink-syntax-keyword\)/);
    expect(css).toMatch(/\.hljs-comment[^{]*\{[^}]*var\(--lightink-syntax-comment\)/);
    expect(css).toMatch(/\.hljs-string[^{]*\{[^}]*var\(--lightink-syntax-string\)/);
    expect(css).toMatch(/\.hljs-number[^{]*\{[^}]*var\(--lightink-syntax-number\)/);
    expect(css).toMatch(/\.hljs-built_in[^{]*\{[^}]*var\(--lightink-syntax-builtin\)/);
    expect(css).toMatch(/\.hljs-punctuation[^{]*\{[^}]*var\(--lightink-syntax-punctuation\)/);
    expect(css).toMatch(/\.hljs-meta\s*\{[^}]*var\(--lightink-syntax-comment\)/);
  });
});
