// @vitest-environment jsdom

/**
 * readerFramePaperColor 回归（R5/R6 摸鱼页面背景改写）：
 * 章节 iframe 是独立文档，宿主 conceal.css 管不到内部；改写生效时帧纸色必须
 * 为 transparent，否则内联纸色把宿主层的渐变/透明全部挡住。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyFlowTypography, readerFramePaperColor } from '../flow-renderer.js';

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

describe('applyFlowTypography 命中色变量透传（章内搜索命中随主题）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function computedStub(vars: Record<string, string>): CSSStyleDeclaration {
    return {
      color: 'rgb(224, 216, 200)',
      fontFamily: 'serif',
      fontSize: '16px',
      colorScheme: 'dark',
      getPropertyValue: (name: string) => vars[name] ?? '',
    } as unknown as CSSStyleDeclaration;
  }

  function freshFrameDocument(): Document {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument;
    expect(doc, 'iframe contentDocument').not.toBeNull();
    return doc!;
  }

  it('把宿主 --lightink-selection/--lightink-accent 写进帧 documentElement', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      computedStub({
        '--lightink-bg': '#2a2a2a',
        '--lightink-selection': 'rgba(212, 160, 102, 0.28)',
        '--lightink-accent': '#d4a066',
      }),
    );
    const root = document.createElement('div');
    document.body.append(root);
    const doc = freshFrameDocument();
    applyFlowTypography(root, doc);
    const html = doc.documentElement;
    expect(html.style.getPropertyValue('--lightink-selection')).toBe(
      'rgba(212, 160, 102, 0.28)',
    );
    expect(html.style.getPropertyValue('--lightink-accent')).toBe('#d4a066');
    // 纸墨色照旧写入（既有行为不回归）。
    expect(html.style.getPropertyValue('--lightink-bg')).toBe('#2a2a2a');
  });

  it('宿主未定义时透传为空，让 FLOW_FRAME_CSS 回退 warm-light 档', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      computedStub({ '--lightink-bg': '#fbf0d9' }),
    );
    const root = document.createElement('div');
    document.body.append(root);
    const doc = freshFrameDocument();
    applyFlowTypography(root, doc);
    expect(doc.documentElement.style.getPropertyValue('--lightink-selection')).toBe('');
    expect(doc.documentElement.style.getPropertyValue('--lightink-accent')).toBe('');
  });

  it('FLOW_FRAME_CSS 命中底色消费透传变量并保留 warm-light 回退', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/reader/flow-renderer.ts'), 'utf-8');
    expect(source).toMatch(
      /\.lightink-reader-search-mark\s*\{[^}]*background:\s*var\(--lightink-selection, rgba\(154, 88, 40, 0\.22\)\)/,
    );
    expect(source).toMatch(
      /\.lightink-reader-search-mark--current\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--lightink-accent, #9a5828\) 45%, transparent\)/,
    );
    // 不再有裸硬编码命中底色（rgba 档只允许作为 var() 回退存在）。
    expect(source).not.toMatch(/background:\s*rgba\(154, 88, 40, 0\.(?:22|45)\);/);
  });
});
