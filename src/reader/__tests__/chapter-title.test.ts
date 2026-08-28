// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  displayChapterTitle,
  isUsableEpubChapterTitle,
  markDuplicateChapterHeading,
} from '../chapter-title.js';

describe('displayChapterTitle', () => {
  it('keeps real headings and drops converter junk', () => {
    expect(isUsableEpubChapterTitle('第4章 白月光（求收藏）')).toBe(true);
    expect(isUsableEpubChapterTitle('ccdqxkhp')).toBe(false);
    expect(isUsableEpubChapterTitle('Chapter 12')).toBe(false);
    expect(displayChapterTitle('ccdqxkhp', '第 1 章')).toBe('第 1 章');
    expect(displayChapterTitle('第4章 白月光（求收藏）', '第 1 章')).toBe(
      '第4章 白月光（求收藏）',
    );
  });
});

describe('markDuplicateChapterHeading', () => {
  it('marks the first body heading that repeats the chapter title', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>第一卷</p><p>卷首。</p><p>第10章 标题</p><p>正文甲。</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).toBe('第10章 标题');
    expect(root.querySelectorAll('[data-reader-split-heading]')).toHaveLength(1);
  });

  it('does not mark later body text that merely mentions the title', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>正文甲。</p><p>第10章 标题 只是一句闲话</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')).toBeNull();
  });

  it('peels a fused heading off the first paragraph so the body is not hidden', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>第10章 标题<br>正文甲。</p>';
    markDuplicateChapterHeading(root, '第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).toBe('第10章 标题');
    expect(root.querySelector('[data-reader-split-heading]')?.textContent).not.toContain('正文甲');
    expect(root.textContent).toContain('正文甲');
  });
});
