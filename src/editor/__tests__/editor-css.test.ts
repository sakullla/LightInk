/**
 * 编辑工作台样式契约（纸墨工作室 §3.10/§3.12，node，readFileSync 文本断言）。
 *
 * editor.css 是编辑器包自有的视觉层（theme.css 属共享层禁改，覆盖靠特异性）。
 * 本测试锁定：
 *   - 纸卡版心（is-paper-card：elevated 面 + border + 静置阴影）与
 *     「沉浸/全屏融为纯纸面」的溶解钩子（chrome 未钉住）；
 *   - 代码块/Mermaid/front-matter 容器 12px 圆角 + sunken 底；
 *   - 查找面板打开时的版心头部让位（:has 钩子）不压首行；
 *   - 格式条 active 态与分组分隔线的消费令牌；
 *   - 覆盖规则的特异性不低于被覆盖的 theme.css 规则（前缀存在性）。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 提取全部「选择器组 { 声明 }」规则块（组合选择器按整组返回；@media 体不在范围）。 */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    out.push({ selector: match[1]!.trim(), body: match[2]! });
  }
  return out;
}

const editorCss = stripCssComments(
  readFileSync(new URL('../editor.css', import.meta.url), 'utf-8'),
);
const outlineCss = stripCssComments(
  readFileSync(new URL('../../outline/outline.css', import.meta.url), 'utf-8'),
);

describe('editor.css 纸卡版心（§3.10）', () => {
  it('is-paper-card：bg-elevated 卡面 + 1px border + 静置阴影 + 圆角', () => {
    const block = /\.lightink-tab-host\.is-paper-card\s*\{[^}]*\}/.exec(editorCss);
    expect(block).not.toBeNull();
    expect(block![0]).toContain('background: var(--lightink-bg-elevated)');
    expect(block![0]).toContain('border: 1px solid var(--lightink-border)');
    expect(block![0]).toContain('box-shadow: var(--lightink-shadow)');
    expect(block![0]).toContain('border-radius');
  });

  it('沉浸/全屏溶解：chrome 未钉住时复位纸卡属性（复用 is-chrome-pinned 钩子）', () => {
    const dissolve =
      /#lightink-chrome-host:not\(\.is-chrome-pinned\) ~ #lightink-main \.lightink-tab-host\.is-paper-card\s*\{[^}]*\}/.exec(
        editorCss,
      );
    expect(dissolve).not.toBeNull();
    expect(dissolve![0]).toContain('background: transparent');
    expect(dissolve![0]).toContain('box-shadow: none');
  });

  it('打印时纸卡不进版面', () => {
    const printBlock = /@media print\s*\{[\s\S]*?\.lightink-tab-host\.is-paper-card\s*\{[^}]*\}/.exec(
      editorCss,
    );
    expect(printBlock).not.toBeNull();
    expect(printBlock![0]).toContain('background: transparent');
  });
});

describe('editor.css 代码族容器（§3.10：12px 圆角 + sunken 底）', () => {
  it('代码块容器覆盖带 .lightink-tab-host 前缀（特异性压过 theme.css 的 .lightink-code-block）', () => {
    const block = cssRules(editorCss).find(
      (rule) =>
        rule.selector.includes('.lightink-tab-host') &&
        rule.selector.includes('.lightink-code-block') &&
        rule.body.includes('background: var(--lightink-bg-sunken)'),
    );
    expect(block).toBeDefined();
    expect(block!.selector.replace(/\s+/g, ' ')).toMatch(/^\.lightink-tab-host \.lightink-code-block/);
    expect(block!.body).toContain('border-radius: var(--lightink-radius-panel, 12px)');
  });

  it('已渲染 Mermaid/Math 的隐形占位被排除（不得画出空白凹面）', () => {
    const block = cssRules(editorCss).find(
      (rule) =>
        rule.selector.includes('.lightink-code-block') &&
        rule.body.includes('background: var(--lightink-bg-sunken)'),
    );
    expect(block).toBeDefined();
    // 选择器可读性换行：断言前压成规范单行（去括号内空白）。
    const selector = block!.selector
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(selector).toContain(":not([data-mermaid='rendered'])");
    expect(selector).toContain(":not([data-math-fence='rendered'])");
    expect(selector).toContain(':not(.lightink-mermaid-source)');
    expect(selector).toContain(':not(.lightink-math-source)');
  });

  it('Mermaid 渲染容器与 front-matter 折叠条同语言', () => {
    const mermaid = /\.lightink-tab-host \.lightink-mermaid\s*\{[^}]*\}/.exec(editorCss);
    expect(mermaid).not.toBeNull();
    expect(mermaid![0]).toContain('var(--lightink-bg-sunken)');

    const frontmatter =
      /\.lightink-tab-host\[role='tabpanel'\] \.lightink-frontmatter\s*\{[^}]*\}/.exec(editorCss);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![0]).toContain('var(--lightink-bg-sunken)');
    expect(frontmatter![0]).toContain('var(--lightink-radius-panel, 12px)');
  });
});

describe('editor.css 查找面板钉版心（§3.10：不压首行）', () => {
  it('面板打开时版心让出头部空间（:has(is-open) 钩子 + reader 宿主豁免）', () => {
    const headroom =
      /#lightink-main:has\(\.lightink-find-panel\.is-open\)\s*#lightink-editor-area\s*\.lightink-tab-host:not\(\.lightink-tab-host--reader\)\s*\{[^}]*\}/.exec(
        editorCss,
      );
    expect(headroom).not.toBeNull();
    expect(headroom![0]).toContain('padding-top: calc(var(--lightink-page-pad-y, 24px) + 58px)');
  });

  it('reduced-motion 豁免覆盖新增过渡', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/.exec(editorCss);
    expect(reduced).not.toBeNull();
    expect(reduced![0]).toContain('transition: none');
  });
});

describe('editor.css 格式条（§3.10 行为联动样式面）', () => {
  it('data-active 态消费 accent-soft；标注组与 marks 组有发丝分隔', () => {
    const active =
      /body \.lightink-format-toolbar \.lightink-format-tool\[data-active\]\s*\{[^}]*\}/.exec(
        editorCss,
      );
    expect(active).not.toBeNull();
    expect(active![0]).toContain('background: var(--lightink-accent-soft)');

    const divider =
      /body \.lightink-format-toolbar \.lightink-format-tool--highlight\s*\{[^}]*\}/.exec(editorCss);
    expect(divider).not.toBeNull();
    expect(divider![0]).toContain('border-left: 1px solid var(--lightink-border)');
  });
});

describe('outline.css 胶囊高亮（§3.12）', () => {
  it('当前项胶囊：全圆角 + 内缩（覆盖带 #lightink-outline-sidebar 前缀）', () => {
    const rules = cssRules(outlineCss);
    const capsule = rules.find(
      (rule) =>
        rule.selector.includes('.lightink-outline-item.is-current') &&
        rule.body.includes('border-radius: 999px'),
    );
    expect(capsule).toBeDefined();
    expect(capsule!.selector).toContain('#lightink-outline-sidebar');
    expect(capsule!.body).toContain('margin-inline: 6px');
    // 键盘活动项与 hover 同胶囊形态。
    expect(capsule!.selector).toContain('.lightink-outline-item.is-active');
    expect(capsule!.selector).toContain(':hover');
  });

  it('常驻搜索框在凹面面板上取抬起输入面', () => {
    const search =
      /#lightink-outline-sidebar \.lightink-outline-search\s*\{[^}]*\}/.exec(outlineCss);
    expect(search).not.toBeNull();
    expect(search![0]).toContain('background: var(--lightink-bg-elevated)');
  });
});
