/**
 * `blocks` — 章节正文块化与译回（ADR-5「排版尽力保留」）。
 *
 * 提取：把已消毒的章节 HTML（或 EPUB spine 项 body）按文档序展开为块序列
 * —— 文本块（一个叶子块元素 = 一段，保留 h1-6/li/pre 语义标签）与原样块
 * （图片/svg 等，重组时按原位置保留）。脚本/样式丢弃。
 *
 * 译回：把译出的段落流按块序回填（一个源段对应一个输出段；模型多出的段落
 * 追加到章末，不足则跳过空段），原样块逐字保留——图片与包内相对路径经
 * EPUB 原包重组天然有效（fresh 路径已内联为 data URI）。
 */

import type { TranslationBlock, TranslationUnit } from './types.js';

const MEDIA_SELECTOR = 'img,svg,image,video,audio,canvas,iframe';
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'p',
  'pre',
  'section',
  'td',
  'th',
]);

/** 归一化语义标签：标题/列表/预排版保留，其余容器一律折成 p。 */
function normalizedTag(tag: string): string {
  if (/^h[1-6]$/.test(tag) || tag === 'li' || tag === 'pre') {
    return tag;
  }
  return 'p';
}

function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\r\n\f]+/g, ' ').trim();
}

function hasBlockDescendant(element: Element): boolean {
  return [...element.querySelectorAll('*')].some(
    (child) => BLOCK_TAGS.has(child.localName) || child.matches(MEDIA_SELECTOR),
  );
}

/**
 * 提取 body HTML 的翻译块序列。纯 DOM 文档序遍历：叶子块 → 文本块；含
 * 媒体的子树下钻（图片成为原样块、其余文本照常成段）；游离文本按 p 成段。
 */
export function extractTranslationBlocks(html: string): TranslationBlock[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const blocks: TranslationBlock[] = [];
  let pending = '';

  const flush = (): void => {
    const text = collapseWhitespace(pending);
    pending = '';
    if (text !== '') {
      blocks.push({ kind: 'text', tag: 'p', text });
    }
  };

  const visit = (parent: Element): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        pending += node.textContent ?? '';
        continue;
      }
      if (!(node instanceof Element)) {
        continue;
      }
      const tag = node.localName;
      if (SKIP_TAGS.has(tag)) {
        continue;
      }
      if (node.matches(MEDIA_SELECTOR)) {
        flush();
        blocks.push({ kind: 'raw', markup: node.outerHTML });
        continue;
      }
      if (!BLOCK_TAGS.has(tag)) {
        pending += node.textContent ?? '';
        continue;
      }
      if (hasBlockDescendant(node)) {
        flush();
        visit(node);
        continue;
      }
      flush();
      const text = tag === 'pre' ? (node.textContent ?? '').trim() : collapseWhitespace(node.textContent ?? '');
      if (text !== '') {
        blocks.push({ kind: 'text', tag: normalizedTag(tag), text });
      }
    }
  };

  visit(document.body);
  flush();
  return blocks;
}

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderTextBlock(tag: string, escaped: string): string {
  if (tag === 'pre') {
    return `<pre>${escaped}</pre>`;
  }
  if (tag === 'blockquote') {
    return `<blockquote><p>${escaped}</p></blockquote>`;
  }
  return `<${tag}>${escaped}</${tag}>`;
}

/**
 * 把章节的翻译块序列 + 译出段落流重译为 XHTML body 片段。段落流与提取时
 * 的文本块一一对应；多余段落追加章末（模型拆分了段落时不丢内容），不足时
 * 空段跳过；原样块（图片等）按原位置原样回填。
 */
export function rebuildTranslatedBody(
  blocks: readonly TranslationBlock[],
  paragraphs: readonly string[],
): string {
  const out: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.kind === 'raw') {
      out.push(block.markup);
      continue;
    }
    const paragraph = paragraphs[cursor]?.trim() ?? '';
    cursor += 1;
    if (paragraph !== '') {
      out.push(renderTextBlock(block.tag, escapeXmlText(paragraph)));
    }
  }
  for (const leftover of paragraphs.slice(cursor)) {
    const text = leftover.trim();
    if (text !== '') {
      out.push(`<p>${escapeXmlText(text)}</p>`);
    }
  }
  return out.join('\n');
}

/** 归一化段落：一个源文本块一段；超长段落按句界预切（仍超长再硬切）。 */
export interface UnitParagraph {
  readonly tag: string;
  readonly text: string;
}

const SENTENCE_SPLIT = /(?<=[。！？!?…；;])/;

export function splitOversizedParagraph(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const pieces: string[] = [];
  let current = '';
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (current !== '' && current.length + sentence.length > limit) {
      pieces.push(current);
      current = '';
    }
    if (sentence.length <= limit) {
      current += sentence;
      continue;
    }
    // 无句界的超长串（如无标点长段）：按上限硬切。
    if (current !== '') {
      pieces.push(current);
      current = '';
    }
    for (let offset = 0; offset < sentence.length; offset += limit) {
      pieces.push(sentence.slice(offset, offset + limit));
    }
  }
  if (current !== '') {
    pieces.push(current);
  }
  return pieces;
}

/** 章节的归一化段落序列（分块与译回的共同基准，纯函数可复算）。 */
export function unitParagraphs(unit: TranslationUnit, limit: number): readonly UnitParagraph[] {
  const paragraphs: UnitParagraph[] = [];
  for (const block of unit.blocks) {
    if (block.kind !== 'text') {
      continue;
    }
    for (const piece of splitOversizedParagraph(block.text, limit)) {
      paragraphs.push({ tag: block.tag, text: piece });
    }
  }
  return paragraphs;
}

/** 译出块文本 → 段落流（模型按段换行；空段丢弃）。 */
export function splitTranslatedParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 章节标题的 XHTML head/title 文本（与正文同源转义）。 */
export function translatedUnitXhtmlTitle(title: string): string {
  return escapeXmlText(collapseWhitespace(title));
}
