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
    expect(printRootRule).toMatch(/--lightink-page-pad-x:\s*0/);
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

  it('含 .lightink-frontmatter 规则且内部 pre 压过通用代码块', () => {
    expect(EXPORT_BASE_CSS).toMatch(/\.lightink-frontmatter\s*\{/);
    expect(EXPORT_BASE_CSS).toMatch(/\.lightink-frontmatter\s*>\s*summary\s*\{/);
    expect(EXPORT_BASE_CSS).toMatch(/\.lightink-frontmatter\s*>\s*pre\s*\{/);
    const fmPre =
      EXPORT_BASE_CSS.match(/\.lightink-frontmatter\s*>\s*pre\s*\{[^}]+\}/)?.[0] ?? '';
    expect(fmPre).toMatch(/border:\s*none/);
    expect(fmPre).toContain(
      'color-mix(in srgb, var(--lightink-code-bg) 42%, var(--lightink-bg))',
    );
    expect(fmPre).not.toContain('padding: 12px 16px');
    const genericPreIdx = EXPORT_BASE_CSS.search(/^pre\s*\{/m);
    const fmPreIdx = EXPORT_BASE_CSS.search(/\.lightink-frontmatter\s*>\s*pre\s*\{/);
    expect(genericPreIdx).toBeGreaterThanOrEqual(0);
    expect(fmPreIdx).toBeGreaterThan(genericPreIdx);
    expect(EXPORT_BASE_CSS).not.toContain('.lightink-tab-host');
  });

  it('ul/ol 与编辑器共用 prose.css 的 2em，body 左右 padding 走 --lightink-page-pad-x', () => {
    const prose = readFileSync(new URL('../../theme/prose.css', import.meta.url), 'utf-8');
    expect(prose).toMatch(
      /\.lightink-prose ul,\s*\.lightink-prose ol\s*\{[^}]*padding-inline-start:\s*2em/,
    );
    const bodyRule = EXPORT_BASE_CSS.match(/body\.lightink-prose\s*\{[^}]+\}/)?.[0] ?? '';
    expect(bodyRule).toContain('--lightink-page-pad-x');
    expect(bodyRule).toMatch(
      /padding:\s*24px\s+var\(--lightink-page-pad-x,\s*28px\)\s+48px/,
    );
    expect(EXPORT_BASE_CSS).not.toMatch(/^(ul|ol)\s*,/m);
    expect(EXPORT_BASE_CSS).not.toMatch(/padding-inline-start:\s*2em/);
  });

  it('表格采用内容列宽、表头 nowrap 与包装横滚，且无 table-layout:fixed', () => {
    expect(EXPORT_BASE_CSS).toMatch(/\.tableWrapper\s*\{[^}]*overflow-x:\s*auto/);
    expect(EXPORT_BASE_CSS).toMatch(/table\s*\{[^}]*table-layout:\s*auto/);
    expect(EXPORT_BASE_CSS).toMatch(/table\s*\{[^}]*width:\s*max-content/);
    expect(EXPORT_BASE_CSS).toMatch(/table\s*\{[^}]*min-width:\s*100%/);
    expect(EXPORT_BASE_CSS).toMatch(/th\s*\{[^}]*white-space:\s*nowrap/);
    expect(EXPORT_BASE_CSS).toMatch(/td\s*\{[^}]*overflow-wrap:\s*break-word/);
    expect(EXPORT_BASE_CSS).not.toMatch(/table-layout:\s*fixed/);
    expect(EXPORT_BASE_CSS).not.toContain('.lightink-tab-host');
    expect(EXPORT_BASE_CSS).not.toMatch(/word-break:\s*break-all/);
  });

  it('打印根 page-pad 为 0，顶层表 inset 由 prose.css 提供', () => {
    const printRootRule =
      EXPORT_BASE_CSS.match(/#lightink-export-print-root\.lightink-prose\s*\{[^}]+\}/)?.[0] ?? '';
    expect(printRootRule).toMatch(/--lightink-page-pad-x:\s*0/);
    const prose = readFileSync(new URL('../../theme/prose.css', import.meta.url), 'utf-8');
    expect(prose).toMatch(
      /\.lightink-prose\s*>\s*\.tableWrapper\s*>\s*table\s*\{[^}]*min-width:\s*calc\(100% - 2 \* var\(--lightink-page-pad-x,\s*28px\)\)/,
    );
    expect(prose).toMatch(
      /\.lightink-prose\s*>\s*\.tableWrapper\s*>\s*table\s*\{[^}]*margin-inline:\s*var\(--lightink-page-pad-x,\s*28px\)/,
    );
  });
});
