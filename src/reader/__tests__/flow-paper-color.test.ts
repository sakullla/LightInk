// @vitest-environment jsdom

/**
 * readerFramePaperColor 回归（R5/R6 摸鱼页面背景改写）：
 * 章节 iframe 是独立文档，宿主 conceal.css 管不到内部；改写生效时帧纸色必须
 * 为 transparent，否则内联纸色把宿主层的渐变/透明全部挡住。
 */
import { describe, expect, it } from 'vitest';

import { readerFramePaperColor } from '../flow-renderer.js';

describe('readerFramePaperColor（摸鱼页面背景改写）', () => {
  it('无改写变量时保持阅读主题纸色（默认态与升级前一致）', () => {
    expect(readerFramePaperColor('', '#fbf0d9')).toBe('#fbf0d9');
    expect(readerFramePaperColor('   ', '#fbf0d9')).toBe('#fbf0d9');
    expect(readerFramePaperColor('', 'rgb(18, 18, 18)')).toBe('rgb(18, 18, 18)');
  });

  it('透明或渐变改写生效时返回 transparent（宿主层渐变/透明透出）', () => {
    expect(readerFramePaperColor('transparent', '#fbf0d9')).toBe('transparent');
    expect(
      readerFramePaperColor('linear-gradient(180deg, #f7dc8f 0%, #fdf7e3 100%)', '#fbf0d9'),
    ).toBe('transparent');
    // 带空白的变量值同样视为生效。
    expect(readerFramePaperColor(' transparent ', '#121212')).toBe('transparent');
  });
});
