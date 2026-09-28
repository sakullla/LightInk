// @vitest-environment node

/**
 * conceal.css 级联契约回归（R1/R5/R6）：
 * applyReaderTheme 把阅读主题纸色写成 .lightink-reader 与
 * #lightink-editor-area 的**内联** background-color（reader-theme.ts），
 * 普通样式表声明在级联中必输给内联样式——透明/渐变必须有 !important 覆盖
 * 规则，且只挂在 data-conceal-page-background='on'（conceal-controller 在
 * 改写变量写入时置位）上，默认态不命中。jsdom 不加载样式表，这里静态断言
 * 规则存在，防止回归成「内联纸色盖住透明/渐变」。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../conceal.css', import.meta.url), 'utf-8');

/** 逐块扫描（selector 组含块前注释，body 组为声明体）。 */
const blocks: Array<{ selector: string; body: string }> = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(
  (match) => ({ selector: match[1] ?? '', body: match[2] ?? '' }),
);

describe('conceal.css 页面背景级联（R1/R5/R6）', () => {
  it('默认态：body 与两表面根取改写变量、缺省回退主题纸色', () => {
    const body = css.match(
      /html\[data-conceal-surface='shelf'\] body,\s*html\[data-conceal-surface='reader'\] body\s*\{([^}]*)\}/,
    )?.[1];
    expect(body).toMatch(
      /background:\s*var\(--lightink-conceal-page-background,\s*var\(--lightink-bg\)\)/,
    );

    const surfaceRoots = css.match(
      /html\[data-conceal-surface='shelf'\] \.lightink-library,\s*html\[data-conceal-surface='reader'\] \.lightink-reader\s*\{([^}]*)\}/,
    )?.[1];
    expect(surfaceRoots).toMatch(
      /background:\s*var\(--lightink-conceal-page-background,\s*var\(--lightink-bg\)\)/,
    );
  });

  it('改写生效时以 !important 覆盖内联纸色，四个目标（书架/阅读器 × 表面根/编辑区）齐全', () => {
    const targets = [
      "html[data-conceal-surface='shelf'][data-conceal-page-background='on'] .lightink-library",
      "html[data-conceal-surface='shelf'][data-conceal-page-background='on'] #lightink-editor-area",
      "html[data-conceal-surface='reader'][data-conceal-page-background='on'] .lightink-reader",
      "html[data-conceal-surface='reader'][data-conceal-page-background='on'] #lightink-editor-area",
    ];
    // 四个选择器须共用同一覆盖块：缺一即回归成「书架开过书/阅读器被内联纸色
    // 挡住，透明/渐变零可见效果」。
    const escaped = targets.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(',\\s*');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(block, 'override block for all four targets').toMatch(
      /background:\s*var\(--lightink-conceal-page-background\)\s*!important/,
    );
  });

  it('含 !important 的声明严格门控在 data-conceal-page-background 上（默认态主题外观不受影响）', () => {
    const important = blocks.filter((block) => block.body.includes('!important'));
    expect(important.length).toBeGreaterThan(0);
    for (const block of important) {
      expect(block.selector).toContain("[data-conceal-page-background='on']");
    }
  });

  it('编辑器表面保持不透明兜底（R1：编辑器外观与升级前一致）', () => {
    const editor = css.match(
      /html\[data-conceal-surface='editor'\],\s*html\[data-conceal-surface='editor'\] body\s*\{([^}]*)\}/,
    )?.[1];
    expect(editor).toMatch(/background:\s*var\(--lightink-bg\)/);
  });
});
