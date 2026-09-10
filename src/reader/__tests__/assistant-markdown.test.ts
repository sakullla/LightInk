// @vitest-environment jsdom

/**
 * Contract for `src/reader/assistant-markdown.ts` (R3 / R10):
 * 标题/列表/引用/代码/表格/链接/强调渲染为格式化内容；脚本与原始 HTML 不执行；
 * `javascript:` 链接不落地；定位链接成为按钮；流式未闭合围栏不吞后文；
 * mermaid/公式按代码显示、图片降级为文本。
 */

import { describe, expect, it } from 'vitest';

import {
  assistantMarkdownToHtml,
  closeOpenFences,
  renderAssistantMarkdown,
} from '../assistant-markdown.js';

describe('renderAssistantMarkdown', () => {
  it('renders headings, lists, quotes, code, tables, links and emphasis', () => {
    const root = renderAssistantMarkdown(
      [
        '# 标题',
        '',
        '- 第一项',
        '- [ ] 待办',
        '',
        '1. 有序',
        '',
        '> 引用 **加粗** *斜体* ~~删除~~ `行内`',
        '',
        '```json',
        '{"a":1}',
        '```',
        '',
        '| 列A | 列B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '[外链](https://example.com) 与 [邮件](mailto:a@b.c)',
        '',
        '---',
      ].join('\n'),
    );
    expect(root.querySelector('h1')?.textContent).toBe('标题');
    expect(root.querySelectorAll('ul > li')).toHaveLength(2);
    expect(root.querySelectorAll('ul > li')[1]?.textContent).toBe('☐ 待办');
    expect(root.querySelector('ol > li')?.textContent).toBe('有序');
    expect(root.querySelector('blockquote strong')?.textContent).toBe('加粗');
    expect(root.querySelector('blockquote em')?.textContent).toBe('斜体');
    expect(root.querySelector('blockquote del')?.textContent).toBe('删除');
    expect(root.querySelector('blockquote code')?.textContent).toBe('行内');
    expect(root.querySelector('pre code')?.textContent).toBe('{"a":1}');
    expect(root.querySelector('pre')?.getAttribute('data-lang')).toBe('json');
    expect(root.querySelector('table th')?.textContent).toBe('列A');
    expect(root.querySelector('table td')?.textContent).toBe('1');
    const links = root.querySelectorAll('a');
    // mailto 不是宿主打开器支持的协议：按纯文本显示，不产出链接。
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com');
    expect(links[0]?.getAttribute('rel')).toBe('noopener');
    expect(root.textContent).toContain('邮件');
    expect(root.querySelector('a[href^="mailto"]')).toBeNull();
    expect(root.querySelector('hr')).not.toBeNull();
    expect(root.textContent).not.toContain('#');
  });

  it('never executes scripts, raw HTML or javascript: links', () => {
    const root = renderAssistantMarkdown(
      [
        '<script>window.__pwned = 1</script>',
        '',
        '<iframe src="https://evil.test"></iframe>',
        '',
        '[点我](javascript:alert(1)) <img src=x onerror="alert(1)">',
        '',
        '<a href="https://ok.test" onclick="alert(1)">x</a>',
      ].join('\n'),
    );
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('[onclick], [onerror]')).toBeNull();
    for (const link of root.querySelectorAll('a')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
    expect(root.textContent).toContain('点我');
    // 原始 HTML 以文本形式显示，不作为标记落地。
    expect(root.textContent).toContain('<script>');
  });

  it('turns locate links into buttons and keeps other schemes as text', () => {
    const root = renderAssistantMarkdown(
      '见 [第三章](lightink://chapter/2) 和 [第 12 页](lightink://page/12)，以及 [ftp](ftp://x.y)。',
    );
    const buttons = root.querySelectorAll('button[data-locate]');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('data-locate')).toBe('chapter:2');
    expect(buttons[0]?.textContent).toBe('第三章');
    expect(buttons[1]?.getAttribute('data-locate')).toBe('page:12');
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect(root.textContent).toContain('ftp');
  });

  it('closes an open fence while streaming so later text is not swallowed after it closes', () => {
    expect(closeOpenFences('前言\n```js\nlet a = 1')).toBe('前言\n```js\nlet a = 1\n```');
    expect(closeOpenFences('```\ncode\n```\n后文')).toBe('```\ncode\n```\n后文');
    expect(closeOpenFences('~~~~\ncode\n~~~ 不算闭合')).toBe('~~~~\ncode\n~~~ 不算闭合\n~~~~');
    const streaming = renderAssistantMarkdown('前言\n```js\nlet a = 1', { streaming: true });
    expect(streaming.querySelector('pre code')?.textContent).toBe('let a = 1');
    expect(streaming.querySelector('p')?.textContent).toBe('前言');
    expect(streaming.textContent).not.toContain('```');
    const finished = renderAssistantMarkdown('前言\n```js\nlet a = 1\n```\n后文');
    expect(finished.querySelector('pre code')?.textContent).toBe('let a = 1');
    expect(finished.querySelectorAll('p')[1]?.textContent).toBe('后文');
  });

  it('shows mermaid and formulas as code, images as text (R10)', () => {
    const root = renderAssistantMarkdown(
      ['```mermaid', 'graph TD; A-->B', '```', '', '$$E=mc^2$$', '', '![封面](https://x.y/a.png)'].join('\n'),
    );
    expect(root.querySelector('svg')).toBeNull();
    expect(root.querySelector('pre code')?.textContent).toBe('graph TD; A-->B');
    expect(root.textContent).toContain('$$E=mc^2$$');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('[封面]');
    // 无 alt 的图片占位文案由调用方按 i18n 给。
    const bare = renderAssistantMarkdown('![](https://x.y/b.png)', { imageFallback: '[图片]' });
    expect(bare.textContent).toContain('[图片]');
  });

  it('resolves reference-style links and closes fences nested in quotes while streaming', () => {
    const root = renderAssistantMarkdown(
      ['看[这一章][ch]和[官网][site]。', '', '[ch]: lightink://chapter/2', '[site]: https://example.test/'].join('\n'),
    );
    expect(root.querySelector('button[data-locate="chapter:2"]')?.textContent).toBe('这一章');
    expect(root.querySelector('a[href="https://example.test/"]')?.textContent).toBe('官网');
    // 引用块里开了围栏又关了：不应再补一个空围栏。
    const quoted = renderAssistantMarkdown(['> ```js', '> const a = 1;', '> ```', '', '后文'].join('\n'), { streaming: true });
    expect(quoted.querySelectorAll('pre')).toHaveLength(1);
    expect(quoted.textContent).toContain('后文');
  });

  it('escapes text in the html serializer', () => {
    expect(assistantMarkdownToHtml('a < b & "c"')).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>');
    expect(assistantMarkdownToHtml('')).toBe('');
  });
});
