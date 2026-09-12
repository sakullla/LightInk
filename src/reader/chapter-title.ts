/**
 * EPUB converters (Sigil, 网文打包) often stamp a random project id into
 * `<title>`. Those strings must not become chrome labels or body text.
 */

const JUNK_CHAPTER_TITLE = /^(?:untitled|unknown|chapter\s*\d+|[\d._-]+|[a-z0-9_-]{4,24})$/i;

export function isUsableEpubChapterTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false;
  }
  if (/[\u3400-\u9fff]/.test(trimmed)) {
    return true;
  }
  return !JUNK_CHAPTER_TITLE.test(trimmed);
}

export function displayChapterTitle(title: string, fallback: string): string {
  const trimmed = collapseRepeatedChapterTitle(title);
  return isUsableEpubChapterTitle(trimmed) ? trimmed : fallback;
}

const NUMBER_CLASS = '零〇一二三四五六七八九十百千万两0-9';
const HEADING_HINT = new RegExp(
  `第\\s*[${NUMBER_CLASS}]+\\s*[章回节卷]|Chapter\\s+\\d+|序章|序言|楔子|引子|前言|后记|尾声|番外`,
  'i',
);

/**
 * PDF/EPUB converters often stamp the same heading twice with no separator
 * (`第六章 事件第六章 事件`). Collapse one exact or whitespace-separated repeat.
 */
export function collapseRepeatedChapterTitle(title: string): string {
  const trimmed = title.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (trimmed.length < 6) {
    return trimmed;
  }
  let current = trimmed;
  for (let step = 0; step < 3; step += 1) {
    const next = peelRepeatedTitle(current);
    if (next === null) {
      return current;
    }
    current = next;
  }
  return current;
}

function peelRepeatedTitle(text: string): string | null {
  if (text.length >= 6 && text.length % 2 === 0) {
    const half = text.length / 2;
    const left = text.slice(0, half);
    if (left === text.slice(half) && isCollapsibleTitleUnit(left)) {
      return left.trim();
    }
  }
  const spaced = /^(.*\S)\s+\1$/.exec(text);
  const unit = spaced?.[1];
  if (unit !== undefined && isCollapsibleTitleUnit(unit)) {
    return unit.trim();
  }
  return null;
}

function isCollapsibleTitleUnit(unit: string): boolean {
  const trimmed = unit.trim();
  if (trimmed.length < 2) {
    return false;
  }
  if (HEADING_HINT.test(trimmed)) {
    return true;
  }
  if (trimmed.length >= 4 && /\s/.test(trimmed)) {
    return true;
  }
  return trimmed.length >= 5;
}

const SPLIT_HEADING_ATTR = 'data-reader-split-heading';
const SPLIT_HEADING_SCAN_LIMIT = 12;

function normalizeHeadingText(text: string): string {
  return text
    .replace(/^[【\[（(「『《]+/, '')
    .replace(/[】\]）)」』》]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingTextMatches(text: string, title: string): boolean {
  const left = normalizeHeadingText(text);
  const right = normalizeHeadingText(title);
  return left.length > 0 && left === right;
}

/**
 * Scroll mode paints `.lightink-reader-chapter-title` above the iframe.
 * TXT/EPUB bodies often start with the same heading, so mark the first
 * matching block; frame CSS hides it only while layout is scroll.
 */
export function markDuplicateChapterHeading(root: ParentNode | null, title: string): void {
  if (root === null || typeof root.querySelectorAll !== 'function') {
    return;
  }
  const previous = root.querySelectorAll(`[${SPLIT_HEADING_ATTR}]`);
  for (let index = 0; index < previous.length; index += 1) {
    const element = previous[index];
    if (element instanceof HTMLElement) {
      delete element.dataset.readerSplitHeading;
    } else {
      element?.removeAttribute(SPLIT_HEADING_ATTR);
    }
  }
  const target = normalizeHeadingText(title);
  if (target.length === 0) {
    return;
  }
  const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
  let seen = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const element = blocks[index];
    const text = normalizeHeadingText(element?.textContent ?? '');
    if (text.length === 0) {
      continue;
    }
    seen += 1;
    if (headingTextMatches(text, target)) {
      if (element instanceof HTMLElement) {
        element.dataset.readerSplitHeading = '';
      } else {
        element?.setAttribute(SPLIT_HEADING_ATTR, '');
      }
      return;
    }
    if (element instanceof HTMLElement && peelFusedChapterHeading(element, target)) {
      return;
    }
    if (seen >= SPLIT_HEADING_SCAN_LIMIT) {
      return;
    }
  }
}

/** `<p>第10章 标题<br>正文` — title is only the first text node, not the whole block. */
function peelFusedChapterHeading(element: HTMLElement, title: string): boolean {
  const first = element.firstChild;
  if (first === null || first.nodeType !== Node.TEXT_NODE) {
    return false;
  }
  const raw = first.textContent ?? '';
  const line = raw.split(/\r?\n/, 1)[0] ?? '';
  if (!headingTextMatches(line.trim(), title)) {
    return false;
  }
  const heading = element.ownerDocument.createElement(element.tagName.toLowerCase());
  heading.textContent = line.trim();
  heading.dataset.readerSplitHeading = '';
  element.parentNode?.insertBefore(heading, element);
  if (line.length >= raw.length) {
    first.remove();
    while (element.firstChild !== null && element.firstChild.nodeName === 'BR') {
      element.firstChild.remove();
    }
  } else {
    first.textContent = raw.slice(line.length).replace(/^\r?\n/, '');
  }
  if ((element.textContent ?? '').trim() === '') {
    element.remove();
  }
  return true;
}
