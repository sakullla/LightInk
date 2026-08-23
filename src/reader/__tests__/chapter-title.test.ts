import { describe, expect, it } from 'vitest';

import { displayChapterTitle, isUsableEpubChapterTitle } from '../chapter-title.js';

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
