/**
 * export-css 装配测试。注意 vitest（node 环境）不处理 CSS 导入，
 * tokens.css?raw / prose.css?raw / katex.min.css?inline 在此得到空串 ——
 * 故只断言本模块自身可组合：导出壳层在位 + 附加 CSS（自定义主题）拼入；
 * 装配顺序以源码 join 数组锁定。令牌 / prose / KaTeX 的真实内容在
 * vite build 产物中验证。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildExportCss, EXPORT_BASE_CSS } from '../export-css.js';

describe('buildExportCss', () => {
  it('基础排版样式以令牌声明 14px/1.7 基准并挂 lightink-prose', () => {
    expect(EXPORT_BASE_CSS).toContain('body.lightink-prose');
    expect(EXPORT_BASE_CSS).toContain('#lightink-export-print-root.lightink-prose');
    expect(EXPORT_BASE_CSS).toContain('var(--lightink-font-body)');
    expect(EXPORT_BASE_CSS).toContain('--lightink-font-size: 14px');
    expect(EXPORT_BASE_CSS).toContain('--lightink-line-height-body: 1.7');
    const bodyRule = EXPORT_BASE_CSS.match(/body\.lightink-prose\s*\{[^}]+\}/)?.[0] ?? '';
    const printRootRule =
      EXPORT_BASE_CSS.match(/#lightink-export-print-root\.lightink-prose\s*\{[^}]+\}/)?.[0] ?? '';
    expect(bodyRule).toContain('--lightink-font-scale: 1');
    expect(printRootRule).toContain('--lightink-font-scale: 1');
    expect(EXPORT_BASE_CSS).not.toContain('Microsoft YaHei');
    expect(EXPORT_BASE_CSS).not.toContain('font-size: 13px');
    expect(EXPORT_BASE_CSS).toContain('table');
    expect(EXPORT_BASE_CSS).toContain('blockquote');
    expect(EXPORT_BASE_CSS).toContain('img {');
  });

  it('源码装配顺序为 tokens → prose → katex → EXPORT_BASE_CSS → extraCss', () => {
    const source = readFileSync(new URL('../export-css.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/import tokensCss from '\.\.\/theme\/tokens\.css\?raw'/);
    expect(source).toMatch(/import proseCss from '\.\.\/theme\/prose\.css\?raw'/);
    expect(source).toMatch(/import katexCss from 'katex\/dist\/katex\.min\.css\?inline'/);
    expect(source).toMatch(
      /return \[tokensCss, proseCss, katexCss, EXPORT_BASE_CSS, extraCss\]/,
    );
  });

  it('附加 CSS（自定义主题）拼接在末尾', () => {
    const css = buildExportCss('/* custom */ body { color: red; }');
    expect(css).toContain(EXPORT_BASE_CSS);
    expect(css).toContain('/* custom */ body { color: red; }');
    expect(css.indexOf(EXPORT_BASE_CSS)).toBeLessThan(css.indexOf('/* custom */'));
  });

  it('空附加 CSS 不产生多余分隔', () => {
    expect(buildExportCss()).toBe(buildExportCss(''));
  });
});
