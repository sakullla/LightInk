// @vitest-environment jsdom

/**
 * Contract for `src/reader/assistant-markdown.ts` (R3 / ADR-5):
 *
 * Assistant replies render as sanitized GFM HTML. User messages stay plain
 * (this helper only covers assistant markdown). Unclosed fences must not
 * swallow later text; sanitize failure falls back to escaped plain text.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ensureHighlightLanguage } from '../../editor/plugins/code-languages.js';
import {
  createAssistantMarkdownStream,
  renderAssistantMarkdown,
  splitUnclosedFence,
} from '../assistant-markdown.js';

function fragment(html: string): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('renderAssistantMarkdown formatting', () => {
  it('renders headings, lists, code, tables, and links as HTML rather than raw markers', () => {
    const html = renderAssistantMarkdown(
      [
        '# Title',
        '',
        '- alpha',
        '- beta',
        '',
        '```',
        'const x = 1;',
        '```',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '[ex](https://example.com/path)',
        '',
        '> quoted',
        '',
        '**bold** and *em*',
      ].join('\n'),
    );

    const root = fragment(html);
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect([...root.querySelectorAll('ul li')].map((item) => item.textContent)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
    expect(root.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(root.querySelector('table th')?.textContent).toBe('a');
    expect(root.querySelector('table td')?.textContent).toBe('1');
    const link = root.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path');
    expect(link?.textContent).toBe('ex');
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('em');
    expect(html).not.toContain('# Title');
    expect(html).not.toContain('[ex](https://example.com/path)');
  });

  it('highlights fenced code when the language grammar is already loaded', async () => {
    await ensureHighlightLanguage('javascript');
    const html = renderAssistantMarkdown('```javascript\nconst x = 1;\n```');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('language-javascript');
  });

  it('does not execute mermaid or math fences as diagrams or formulas', () => {
    const html = renderAssistantMarkdown(
      '```mermaid\ngraph TD; A-->B;\n```\n\n```katex\n\\frac{1}{2}\n```',
    );
    const root = fragment(html);
    expect(root.querySelector('svg')).toBeNull();
    expect(root.querySelector('.katex')).toBeNull();
    expect(root.textContent).toContain('graph TD; A-->B;');
    expect(root.textContent).toContain('\\frac{1}{2}');
  });
});

describe('renderAssistantMarkdown sanitization', () => {
  it('does not execute script tags or javascript: URLs', () => {
    const html = renderAssistantMarkdown(
      'hello <script>document.body.dataset.pwned = "1"</script>\n\n[x](javascript:alert(1))\n\n[ok](https://example.com)',
    );
    document.body.innerHTML = html;
    expect(document.body.dataset.pwned).toBeUndefined();
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('javascript:');
    const hrefs = [...document.body.querySelectorAll('a')].map((anchor) =>
      (anchor.getAttribute('href') ?? '').toLowerCase(),
    );
    expect(hrefs.some((href) => href.includes('javascript'))).toBe(false);
    expect(document.body.textContent).toContain('x');
    expect(document.body.querySelector('a[href="https://example.com"]')?.textContent).toBe(
      'ok',
    );
  });

  it('does not render markdown or raw HTML images', () => {
    const html = renderAssistantMarkdown(
      '![logo](https://evil.example/x.png)\n\n<img src="https://evil.example/y.png" alt="raw">',
    );
    const root = fragment(html);
    document.body.innerHTML = html;
    expect(root.querySelector('img')).toBeNull();
    expect(document.body.querySelector('img')).toBeNull();
    expect(html.toLowerCase()).not.toContain('<img');
    expect(root.textContent).toContain('logo');
  });

  it('does not render iframe and keeps surrounding prose', () => {
    const html = renderAssistantMarkdown(
      'before <iframe src="https://evil.example"></iframe> after',
    );
    const root = fragment(html);
    document.body.innerHTML = html;
    expect(root.querySelector('iframe')).toBeNull();
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(html.toLowerCase()).not.toContain('<iframe');
    expect(root.textContent).toMatch(/before/);
    expect(root.textContent).toMatch(/after/);
  });
});

describe('unclosed fences and fallback', () => {
  it('does not swallow following text into an unclosed fence', () => {
    const source = '# Title\n\n```js\nconst x = 1;\n\nAfter the fence';
    expect(splitUnclosedFence(source)).toEqual({
      complete: '# Title\n',
      tail: '```js\nconst x = 1;\n\nAfter the fence',
    });

    const html = renderAssistantMarkdown(source);
    const root = fragment(html);
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('pre')).toBeNull();
    expect(root.querySelector('code')).toBeNull();
    expect(root.textContent).toContain('After the fence');
    expect(root.textContent).toContain('const x = 1;');
  });

  it('renders a closed fence as a code block without pulling later prose inside', () => {
    const html = renderAssistantMarkdown(
      '# Title\n\n```js\nconst x = 1;\n```\n\nAfter the fence',
    );
    const root = fragment(html);
    expect(root.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(root.querySelector('pre')?.textContent).not.toContain('After the fence');
    expect(root.textContent).toContain('After the fence');
  });

  it('does not execute a script that appears after an unclosed fence', () => {
    const html = renderAssistantMarkdown(
      'intro\n\n```html\n<script>document.body.dataset.pwned = "1"</script>\nstill open',
    );
    document.body.innerHTML = html;
    expect(document.body.dataset.pwned).toBeUndefined();
    expect(html.toLowerCase()).not.toContain('<script');
    expect(document.body.textContent).toContain('still open');
  });

  it('falls back to plain text when sanitization fails', () => {
    const proto = Document.prototype;
    const original = proto.createElement;
    proto.createElement = function createElement() {
      throw new Error('sanitize boom');
    } as typeof original;
    try {
      const html = renderAssistantMarkdown('# Hello <em>x</em>');
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('<em>');
      expect(html).toContain('# Hello');
      expect(html).toContain('&lt;em&gt;x&lt;/em&gt;');
    } finally {
      proto.createElement = original;
    }
  });
});

describe('createAssistantMarkdownStream', () => {
  it('re-renders accumulated text on each delta and keeps unclosed fences as plain text', () => {
    const stream = createAssistantMarkdownStream();
    const heading = stream.append('# Title');
    expect(fragment(heading).querySelector('h1')?.textContent).toBe('Title');

    const mid = stream.append('\n\n```js\nconst x = 1;');
    expect(fragment(mid).querySelector('pre')).toBeNull();
    expect(fragment(mid).textContent).toContain('const x = 1;');

    const done = stream.append('\n```\n\nAfter');
    const root = fragment(done);
    expect(root.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(root.querySelector('pre')?.textContent).not.toContain('After');
    expect(root.textContent).toContain('After');
    expect(stream.source).toContain('After');
    expect(stream.html).toBe(done);
  });
});
