/**
 * Structured FictionBook 2 parser with bounded embedded-image support.
 * Native <section> chapters win; a body with no sections is split via
 * splitPlainTextChapters. More than 8 native sections lazy-sanitize html.
 */

import { bytesToBase64 } from '../../asset/asset-service.js';
import { sanitizeHtml } from '../sanitize.js';
import { READER_LIMITS } from '../reader-limits.js';
import { decodeReaderText } from './text-encoding.js';
import { EAGER_CHAPTER_COUNT, splitPlainTextChapters } from './chapter-headings.js';
import {
  ParseError,
  ReaderLimitError,
  type ReaderChapter,
  type ReaderContent,
} from './types.js';

const HTML_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'p',
  's',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
]);

const FB2_TAG_MAP: Readonly<Record<string, string>> = {
  emphasis: 'em',
  strikethrough: 's',
  poem: 'div',
  stanza: 'div',
  epigraph: 'blockquote',
  cite: 'blockquote',
  'text-author': 'p',
  subtitle: 'p',
  v: 'p',
};

function attribute(element: Element, names: readonly string[]): string | null {
  for (const name of names) {
    const value = element.getAttribute(name);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function decodeEmbeddedImage(base64: string): Uint8Array | null {
  const compact = base64.replace(/\s+/g, '');
  if (compact === '' || !/^[a-z0-9+/]*={0,2}$/i.test(compact)) {
    return null;
  }
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  const expectedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (expectedBytes > READER_LIMITS.maxImageBytes) {
    throw new ReaderLimitError(
      'readerImageBytes',
      expectedBytes,
      READER_LIMITS.maxImageBytes,
    );
  }
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  if (binary.length > READER_LIMITS.maxImageBytes) {
    throw new ReaderLimitError(
      'readerImageBytes',
      binary.length,
      READER_LIMITS.maxImageBytes,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface Fb2Resources {
  imageUrl(id: string): string | null;
  dispose(): void;
  embedExportImages(html: string): Promise<{ html: string; missing: readonly string[] }>;
}

function createResources(xml: XMLDocument): Fb2Resources {
  const binaries = new Map<string, Element>();
  for (const binary of xml.querySelectorAll('binary[id]')) {
    const id = binary.getAttribute('id')?.trim() ?? '';
    if (id !== '') {
      binaries.set(id, binary);
    }
  }
  const urls = new Map<string, string>();
  const exportByUrl = new Map<string, { mime: string; base64: string }>();
  return {
    imageUrl(id) {
      const existing = urls.get(id);
      if (existing !== undefined) {
        return existing;
      }
      const binary = binaries.get(id);
      if (binary === undefined) {
        return null;
      }
      const mediaType = (binary.getAttribute('content-type') ?? '').trim().toLowerCase();
      if (!READER_LIMITS.safeImageMimeTypes.has(mediaType)) {
        return null;
      }
      const data = decodeEmbeddedImage(binary.textContent ?? '');
      if (data === null) {
        return null;
      }
      const imageBytes = Uint8Array.from(data);
      const url = URL.createObjectURL(new Blob([imageBytes.buffer], { type: mediaType }));
      urls.set(id, url);
      exportByUrl.set(url, { mime: mediaType, base64: bytesToBase64(imageBytes) });
      return url;
    },
    dispose() {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
      exportByUrl.clear();
    },
    async embedExportImages(html, mode = 'inline') {
      if (mode === 'blob') {
        return { html, missing: [] };
      }
      const srcs = [...html.matchAll(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi)].map((m) => m[2]!);
      const unique = [...new Set(srcs)].filter((src) => src.startsWith('blob:'));
      const missing = unique.filter((src) => !exportByUrl.has(src));
      const htmlOut = html.replace(
        /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi,
        (whole, pre: string, src: string, post: string) => {
          const entry = exportByUrl.get(src);
          if (entry === undefined) {
            return whole;
          }
          return `${pre}data:${entry.mime};base64,${entry.base64}${post}`;
        },
      );
      return { html: htmlOut, missing };
    },
  };
}

function appendChildren(
  source: Node,
  target: Node,
  html: Document,
  resources: Fb2Resources,
): void {
  for (const child of source.childNodes) {
    target.appendChild(convertNode(child, html, resources));
  }
}

function convertNode(source: Node, html: Document, resources: Fb2Resources): Node {
  if (source.nodeType === Node.TEXT_NODE) {
    return html.createTextNode(source.nodeValue ?? '');
  }
  if (!(source instanceof Element)) {
    return html.createDocumentFragment();
  }
  const name = source.localName.toLowerCase();
  if (name === 'empty-line') {
    return html.createElement('br');
  }
  if (name === 'image') {
    const fragment = html.createDocumentFragment();
    const reference = attribute(source, ['l:href', 'xlink:href', 'href'])?.trim() ?? '';
    const id = reference.startsWith('#') ? reference.slice(1) : reference;
    const url = id === '' ? null : resources.imageUrl(id);
    if (url !== null) {
      const image = html.createElement('img');
      image.src = url;
      image.alt = source.getAttribute('alt') ?? '';
      fragment.appendChild(image);
    }
    return fragment;
  }

  const mapped = FB2_TAG_MAP[name] ?? (HTML_TAGS.has(name) ? name : null);
  if (mapped === null) {
    const fragment = html.createDocumentFragment();
    appendChildren(source, fragment, html, resources);
    return fragment;
  }
  const element = html.createElement(mapped);
  if (mapped === 'a') {
    const href = attribute(source, ['l:href', 'xlink:href', 'href']);
    if (href !== null) {
      element.setAttribute('href', href);
    }
  }
  for (const name of ['colspan', 'rowspan'] as const) {
    const value = source.getAttribute(name);
    if (value !== null) {
      element.setAttribute(name, value);
    }
  }
  appendChildren(source, element, html, resources);
  return element;
}

function chapterHtml(section: Element, resources: Fb2Resources): string {
  const html = document.implementation.createHTMLDocument('');
  const container = html.createElement('div');
  for (const child of section.childNodes) {
    if (child instanceof Element && child.localName.toLowerCase() === 'title') {
      continue;
    }
    container.appendChild(convertNode(child, html, resources));
  }
  return sanitizeHtml(container.innerHTML);
}

const PLAIN_TEXT_BREAKS = new Set([
  'cite',
  'empty-line',
  'epigraph',
  'p',
  'poem',
  'section',
  'stanza',
  'subtitle',
  'text-author',
  'title',
  'v',
]);

/** Line-oriented plain text so chapter-headings can see 第0001章 on its own line. */
function elementPlainText(root: Element): string {
  const chunks: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.nodeValue ?? '');
      return;
    }
    if (!(node instanceof Element)) {
      return;
    }
    const name = node.localName.toLowerCase();
    if (name === 'empty-line') {
      chunks.push('\n');
      return;
    }
    for (const child of node.childNodes) {
      visit(child);
    }
    if (PLAIN_TEXT_BREAKS.has(name)) {
      chunks.push('\n');
    }
  };
  visit(root);
  return chunks.join('').replace(/\r\n?/g, '\n');
}

function sectionTitle(section: Element, index: number, bookTitle: string): string {
  return (
    Array.from(section.children)
      .find((child) => child.localName.toLowerCase() === 'title')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim() ||
    (index === 0 ? bookTitle : '') ||
    `Section ${index + 1}`
  );
}

function materializeNativeChapters(
  sections: readonly Element[],
  bookTitle: string,
  resources: Fb2Resources,
): ReaderChapter[] {
  const lazy = sections.length > 8;
  return sections.map((section, index) => {
    const title = sectionTitle(section, index, bookTitle);
    const eager = !lazy || index < EAGER_CHAPTER_COUNT;
    const chapter: ReaderChapter = {
      title,
      html: eager ? chapterHtml(section, resources) : '',
    };
    if (eager) {
      return chapter;
    }
    let loaded = false;
    let inflight: Promise<void> | null = null;
    chapter.load = (): Promise<void> => {
      if (loaded) {
        return Promise.resolve();
      }
      if (inflight !== null) {
        return inflight;
      }
      inflight = Promise.resolve().then(() => {
        chapter.html = chapterHtml(section, resources);
        loaded = true;
      });
      return inflight;
    };
    return chapter;
  });
}

/** Parse an FB2 document into chapters and lazily owned embedded-image URLs. */
export function parseFb2(bytes: Uint8Array): ReaderContent {
  // 无声明编码：走共享嗅探（UTF-8 优先、GBK 回退），GBK 打包的 FB2 不再乱码。
  const xml = new DOMParser().parseFromString(decodeReaderText(bytes), 'application/xml');
  if (xml.querySelector('parsererror') !== null) {
    throw new ParseError('FB2 XML 损坏或无法解析');
  }
  const resources = createResources(xml);
  let returnedContent = false;
  try {
    const bookTitle = xml.querySelector('book-title')?.textContent?.trim() ?? '';
    const bodies = Array.from(xml.getElementsByTagName('body'));
    const mainBody = bodies.find((body) => !body.hasAttribute('name')) ?? bodies[0];
    if (mainBody === undefined) {
      throw new ParseError('FB2 缺少正文 body');
    }
    const sections = Array.from(mainBody.children).filter(
      (child) => child.localName.toLowerCase() === 'section',
    );
    const chapters =
      sections.length === 0
        ? splitPlainTextChapters(elementPlainText(mainBody)).chapters
        : materializeNativeChapters(sections, bookTitle, resources);
    returnedContent = true;
    return {
      chapters,
      dispose: resources.dispose,
      embedExportImages: (html) => resources.embedExportImages(html),
    };
  } finally {
    if (!returnedContent) {
      resources.dispose();
    }
  }
}
