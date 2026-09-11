/**
 * Paste handler tests — R10.
 *
 * Verifies that the markdown paste pipeline correctly recognizes AI-style
 * markdown (with code blocks, tables, multi-level headings) and dispatches
 * it through the parser. The "AI-generated markdown" fixture is a realistic
 * multi-section document with every R1 node kind; one full paste → render
 * roundtrip should yield a tree that contains every node type.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPastePayload,
  isLightInkClipboardHtml,
  looksLikeMarkdown,
  payloadHasStructuredBlocks,
  resolveClipboardPaste,
  routeClipboardPaste,
  wrapLightInkClipboardHtml,
} from '../paste.js';
import { collectMdastTypes } from '../parser.js';
import { markdownClipboardData } from '../plugins/clipboard-md.js';

const AI_MARKDOWN = [
  '# 项目总结',
  '',
  '## 概述',
  '',
  '本项目实现一个 **轻量级 Markdown 编辑器**。',
  '',
  '## 关键能力',
  '',
  '- 所见即所得编辑',
  '- 支持 *CommonMark + GFM*',
  '- [官方仓库](https://example.com/repo)',
  '![架构图](https://example.com/architecture.png "alt architecture")',
  '',
  '### 任务清单',
  '',
  '- [x] 完成解析器',
  '- [x] 完成粘贴管线',
  '- [ ] 性能压测',
  '',
  '## 技术栈',
  '',
  '| 模块 | 语言 | 状态 |',
  '| --- | --- | --- |',
  '| 前端 | TypeScript | 进行中 |',
  '| 后端 | Rust | 已完成 |',
  '| 编辑内核 | Milkdown | 已完成 |',
  '',
  '## 示例代码',
  '',
  '```ts',
  'import { mountEditor } from "./editor";',
  'const host = document.querySelector("#app")!;',
  'mountEditor(host, { initialMarkdown: "# hello" });',
  '```',
  '',
  '> 注意：所有路径均为相对路径。',
  '',
  '---',
  '',
  '~~旧版已弃用~~ → 新版见上。',
].join('\n');

describe('paste — markdown detection', () => {
  it('treats AI markdown as markdown', () => {
    expect(looksLikeMarkdown(AI_MARKDOWN)).toBe(true);
  });

  it('treats prose as plain text', () => {
    const prose =
      'Hello, world. This is just a normal sentence without any markdown syntax at all.';
    expect(looksLikeMarkdown(prose)).toBe(false);
  });

  it('detects every R1 marker class', () => {
    expect(looksLikeMarkdown('# heading\n')).toBe(true);
    expect(looksLikeMarkdown('- bullet\n')).toBe(true);
    expect(looksLikeMarkdown('1. ordered\n')).toBe(true);
    expect(looksLikeMarkdown('- [ ] task\n')).toBe(true);
    expect(looksLikeMarkdown('> quote\n')).toBe(true);
    expect(looksLikeMarkdown('```\nblock\n```\n')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n| - | - |\n')).toBe(true);
    expect(looksLikeMarkdown('[link](url)\n')).toBe(true);
    expect(looksLikeMarkdown('![image](url)\n')).toBe(true);
    expect(looksLikeMarkdown('~~strike~~\n')).toBe(true);
    expect(looksLikeMarkdown('---\n')).toBe(true);
    expect(looksLikeMarkdown('**strong**\n')).toBe(true); // via link heuristic if short
    expect(looksLikeMarkdown('*emph*\n')).toBe(true);
  });

  it('returns false for empty input', () => {
    expect(looksLikeMarkdown('')).toBe(false);
  });
});

describe('paste — payload construction', () => {
  it('builds a markdown payload for AI markdown with a pre-parsed tree', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payload.kind).toBe('markdown');
    expect(payload.text).toBe(AI_MARKDOWN);
    expect(payload.parsed).toBeDefined();
    if (payload.parsed) {
      expect(payload.parsed.root.type).toBe('root');
      expect(payload.parsed.charCount).toBe(AI_MARKDOWN.length);
    }
  });

  it('builds a plain payload for prose', () => {
    const prose =
      'Just talking. No markdown markers anywhere in here.';
    const payload = buildPastePayload(prose);
    expect(payload.kind).toBe('plain');
    expect(payload.parsed).toBeUndefined();
  });

  it('payloadHasStructuredBlocks is true for AI markdown', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payloadHasStructuredBlocks(payload)).toBe(true);
  });

  it('a single heading alone has structured blocks (heading counts)', () => {
    const md = '# only\n';
    const payload = buildPastePayload(md);
    expect(payload.kind).toBe('markdown');
    // A single heading does count as "structured": heading != paragraph/text.
    expect(payloadHasStructuredBlocks(payload)).toBe(true);
  });

  it('AI markdown produces a tree containing all R1 syntax categories', () => {
    const payload = buildPastePayload(AI_MARKDOWN);
    expect(payload.kind).toBe('markdown');
    expect(payload.parsed).toBeDefined();
    if (payload.parsed) {
      const types = collectMdastTypes(payload.parsed.root);
      const expectTypes = [
        'heading',
        'paragraph',
        'list',
        'listItem',
        'blockquote',
        'code',
        'table',
        'tableRow',
        'tableCell',
        'link',
        'image',
        'strong',
        'emphasis',
        'delete',
        'thematicBreak',
      ];
      for (const expected of expectTypes) {
        expect(types).toContain(expected);
      }
    }
  });

  it('paste does not mutate input text', () => {
    const original = AI_MARKDOWN;
    buildPastePayload(original);
    expect(AI_MARKDOWN).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// R9 剪贴板路由：routeClipboardPaste + markdownClipboardData
// ---------------------------------------------------------------------------

describe('R9 clipboard routing', () => {
  it('routeClipboardPaste returns markdown for markdown sources', () => {
    expect(routeClipboardPaste('# 标题\n\n正文')).toBe('markdown');
    expect(routeClipboardPaste('- 项一\n- 项二')).toBe('markdown');
    expect(routeClipboardPaste('```js\nconst x = 1;\n```')).toBe('markdown');
    expect(routeClipboardPaste(AI_MARKDOWN)).toBe('markdown');
  });

  it('routeClipboardPaste returns plain for non-markdown text', () => {
    expect(routeClipboardPaste('')).toBe('plain');
    expect(routeClipboardPaste('普通纯文本段落，无标记')).toBe('plain');
    expect(routeClipboardPaste('hello world')).toBe('plain');
  });

  it('markdownClipboardData puts the markdown source into text/plain', () => {
    const md = '# H\n\n**b**';
    const payload = markdownClipboardData(md);
    expect(payload['text/plain']).toBe(md);
    expect(payload['application/x-lightink-markdown']).toBe(md);
    expect(payload['text/html']).toBeUndefined();
  });

  it('markdownClipboardData adds marked HTML when a rendered fragment is provided', () => {
    const md = '# H\n\n**b**';
    const payload = markdownClipboardData(md, '<h1>H</h1><p><strong>b</strong></p>');
    expect(payload['text/plain']).toBe(md);
    expect(payload['text/html']).toBeDefined();
    expect(isLightInkClipboardHtml(payload['text/html'] ?? '')).toBe(true);
    expect(payload['text/html']).toContain('<h1>H</h1>');
    expect(payload['text/html']).toContain('<strong>b</strong>');
  });
});

describe('dual-format clipboard paste routing', () => {
  const md = '# 标题\n\n行内 $a^2$ 与\n\n```mermaid\ngraph TD\nA-->B\n```';
  const markedHtml = wrapLightInkClipboardHtml('<h1>标题</h1><p>行内 $a^2$</p><pre>graph TD</pre>');

  it('wrapLightInkClipboardHtml marks HTML as a LightInk copy', () => {
    const wrapped = wrapLightInkClipboardHtml('<p><strong>粗</strong></p>');
    expect(isLightInkClipboardHtml(wrapped)).toBe(true);
    expect(isLightInkClipboardHtml('<p><strong>粗</strong></p>')).toBe(false);
    expect(isLightInkClipboardHtml('')).toBe(false);
  });

  it('detects the marker inside a CF_HTML envelope', () => {
    const envelope = [
      '<html><body><!--StartFragment-->',
      markedHtml,
      '<!--EndFragment--></body></html>',
    ].join('');
    expect(isLightInkClipboardHtml(envelope)).toBe(true);
  });

  it('prefers Markdown source for LightInk HTML + text (math/mermaid round-trip)', () => {
    expect(
      resolveClipboardPaste({ html: markedHtml, text: md }),
    ).toEqual({ kind: 'markdown-source', text: md });
  });

  it('prefers custom MIME source even when HTML has no marker', () => {
    expect(
      resolveClipboardPaste({
        html: '<h1>标题</h1>',
        text: '标题',
        ownMarkdown: md,
      }),
    ).toEqual({ kind: 'markdown-source', text: md });
  });

  it('routes external Word/Feishu HTML to html conversion, not source', () => {
    const word = '<html><body><p><b>粗体</b> 来自 Word</p></body></html>';
    expect(resolveClipboardPaste({ html: word, text: '粗体 来自 Word' })).toEqual({
      kind: 'html',
      html: word,
    });
  });

  it('routes VS Code markdown-only text as markdown source', () => {
    expect(resolveClipboardPaste({ html: '', text: '- 项一\n- 项二' })).toEqual({
      kind: 'markdown-source',
      text: '- 项一\n- 项二',
    });
  });

  it('routes unmarked prose as plain', () => {
    expect(resolveClipboardPaste({ html: '', text: '普通纯文本段落，无标记' })).toEqual({
      kind: 'plain',
    });
  });

  it('falls back to html when a LightInk copy lost its markdown text', () => {
    expect(resolveClipboardPaste({ html: markedHtml, text: '' })).toEqual({
      kind: 'html',
      html: markedHtml,
    });
  });
});
