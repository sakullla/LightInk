// @vitest-environment jsdom

/**
 * PDF 搜索（T6 / R2）测试：命中索引纯函数（多页/大小写/多命中/空查询）、
 * 环形导航、overlay wrap/unwrap 与 offset→Range 定位。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindImeSafeQuery,
  canWrapSearchMark,
  capSearchHits,
  createSearchBusyReveal,
  findPdfMatches,
  findTextHits,
  htmlToSearchText,
  liveSearchMinChars,
  SEARCH_BUSY_REVEAL_MS,
  nearestMatchIndex,
  nextMatchIndex,
  preserveMatchIndex,
  sanitizeSearchQuery,
  SEARCH_HIT_CAP,
  SEARCH_QUERY_DEBOUNCE_MS,
  snippetAround,
  offsetRangeFrom,
  textLengthOf,
  unwrapSpans,
  wrapTextRangeWithSpan,
} from '../search-panel.js';
import {
  clearSearchMarks,
  flowSearchMarkKey,
  renderSearchMarks,
  SEARCH_MARK_CLASS,
  SEARCH_MARK_CURRENT_CLASS,
} from '../search-overlay.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('findPdfMatches', () => {
  const pages = ['第一章 开端', '正文包含 Keyword 一处', 'keyword 又一处 keyword'];

  it('跨页大小写不敏感查找全部命中，按页序返回', () => {
    const matches = findPdfMatches(pages, 'Keyword');
    expect(matches).toEqual([
      { page: 2, start: 5, end: 12, snippet: snippetAround(pages[1]!, 5, 12) },
      { page: 3, start: 0, end: 7, snippet: snippetAround(pages[2]!, 0, 7) },
      { page: 3, start: 12, end: 19, snippet: snippetAround(pages[2]!, 12, 19) },
    ]);
  });

  it('空查询或全空白返回空数组', () => {
    expect(findPdfMatches(pages, '')).toEqual([]);
    expect(findPdfMatches(pages, '   ')).toEqual([]);
  });

  it('无命中返回空数组', () => {
    expect(findPdfMatches(pages, '不存在')).toEqual([]);
  });
});

describe('capSearchHits', () => {
  it('keeps short lists and slices long ones', () => {
    expect(capSearchHits([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(capSearchHits([1, 2, 3, 4], 2)).toEqual([1, 2]);
    expect(SEARCH_HIT_CAP).toBe(80);
  });
});

describe('liveSearchMinChars', () => {
  it('accepts one CJK character and still waits for two Latin letters', () => {
    expect(liveSearchMinChars('漫')).toBe(1);
    expect(liveSearchMinChars('X')).toBe(2);
    expect(liveSearchMinChars('ab')).toBe(2);
  });
});

describe('htmlToSearchText', () => {
  it('strips tags so unloaded chapters can be scanned without a frame', () => {
    expect(htmlToSearchText('<p>Hello <em>world</em></p>')).toBe('Hello world');
    expect(htmlToSearchText('   ')).toBe('');
  });
});

describe('createSearchBusyReveal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not reveal busy chrome before one second', () => {
    vi.useFakeTimers();
    const onReveal = vi.fn();
    const busy = createSearchBusyReveal(onReveal);
    busy.start();
    vi.advanceTimersByTime(SEARCH_BUSY_REVEAL_MS - 1);
    expect(busy.revealed()).toBe(false);
    expect(onReveal).not.toHaveBeenCalled();
    busy.clear();
    vi.advanceTimersByTime(SEARCH_BUSY_REVEAL_MS);
    expect(busy.revealed()).toBe(false);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('reveals once the search has actually taken a second', () => {
    vi.useFakeTimers();
    const onReveal = vi.fn();
    const busy = createSearchBusyReveal(onReveal);
    busy.start();
    vi.advanceTimersByTime(SEARCH_BUSY_REVEAL_MS);
    expect(busy.revealed()).toBe(true);
    expect(onReveal).toHaveBeenCalledTimes(1);
    busy.clear();
  });
});

describe('bindImeSafeQuery', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('debounces committed keystrokes and emits an empty query immediately', () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    const onQuery = vi.fn();
    const unbind = bindImeSafeQuery(input, onQuery);
    document.body.appendChild(input);

    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = 'ab';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onQuery).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SEARCH_QUERY_DEBOUNCE_MS);
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenLastCalledWith('ab');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onQuery).toHaveBeenLastCalledWith('');
    unbind();
  });

  it('waits for IME composition to finish before searching', () => {
    const input = document.createElement('input');
    const onQuery = vi.fn();
    const unbind = bindImeSafeQuery(input, onQuery);
    document.body.appendChild(input);

    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'jian';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(onQuery).not.toHaveBeenCalled();
    input.value = '鉴';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenLastCalledWith('鉴');
    unbind();
  });
});

describe('sanitizeSearchQuery', () => {
  it('takes the first trimmed line and caps long selections', () => {
    expect(sanitizeSearchQuery('  汉字选区\n第二行  ')).toBe('汉字选区');
    expect(sanitizeSearchQuery('   ')).toBe('');
    expect(sanitizeSearchQuery('x'.repeat(240))).toHaveLength(200);
  });
});

describe('nearestMatchIndex', () => {
  it('keeps the first match at or after the current place', () => {
    expect(nearestMatchIndex(4, 2)).toBe(2);
    expect(nearestMatchIndex(4, 0)).toBe(0);
    expect(nearestMatchIndex(4, 4)).toBe(0);
    expect(nearestMatchIndex(0, 0)).toBe(-1);
  });
});

describe('preserveMatchIndex', () => {
  it('keeps the previous hit after a layout rebuild', () => {
    expect(preserveMatchIndex(4, 2, 0)).toBe(2);
    expect(preserveMatchIndex(4, 8, 1)).toBe(1);
    expect(preserveMatchIndex(0, 2, 0)).toBe(-1);
  });
});

describe('nextMatchIndex', () => {
  it('环形步进：末尾回开头、开头向上走末尾', () => {
    expect(nextMatchIndex(3, 0, 1)).toBe(1);
    expect(nextMatchIndex(3, 2, 1)).toBe(0);
    expect(nextMatchIndex(3, 0, -1)).toBe(2);
    expect(nextMatchIndex(3, 1, -1)).toBe(0);
  });

  it('空集返回 -1，负 active 归零', () => {
    expect(nextMatchIndex(0, 0, 1)).toBe(-1);
    expect(nextMatchIndex(2, -1, 1)).toBe(0);
  });
});

describe('搜索命中 overlay', () => {
  function layer(...texts: string[]): HTMLElement {
    const root = document.createElement('div');
    root.className = 'lightink-reader-text-layer';
    for (const text of texts) {
      const span = document.createElement('span');
      span.textContent = text;
      root.appendChild(span);
    }
    document.body.appendChild(root);
    return root;
  }

  it('offsetRangeFrom + wrapTextRangeWithSpan 定位命中并高亮，unwrap 还原文本', () => {
    const root = layer('前缀文字', '命中目标', '后缀');
    const range = offsetRangeFrom(root, 4, 8);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('命中目标');

    expect(wrapTextRangeWithSpan(root, range!, 'lightink-reader-search-mark')).toBeGreaterThan(0);
    const marked = root.querySelector('.lightink-reader-search-mark');
    expect(marked?.textContent).toBe('命中目标');

    unwrapSpans(root, 'lightink-reader-search-mark');
    expect(root.querySelector('.lightink-reader-search-mark')).toBeNull();
    expect(root.textContent).toBe('前缀文字命中目标后缀');
  });

  it('越界偏移夹到层文本末尾（与 anchor clamp 语义一致）', () => {
    const root = layer('abc');
    expect(offsetRangeFrom(root, 10, 12)!.toString()).toBe('');
    expect(offsetRangeFrom(root, 0, 3)!.toString()).toBe('abc');
  });

  it('key 戳记幂等：已包裹的命中不重复嵌套，textLengthOf 判定层填充度', () => {
    const root = layer('前缀文字', '命中目标', '后缀');
    expect(textLengthOf(root)).toBe(10);
    const range = offsetRangeFrom(root, 4, 8)!;
    wrapTextRangeWithSpan(root, range, 'lightink-reader-search-mark', '1:4:8');
    const marked = root.querySelector<HTMLElement>('[data-search-key="1:4:8"]')!;
    expect(marked.className).toBe('lightink-reader-search-mark');
    // 重复包裹同一 key：调用方经 existing 检查跳过（此处直接验证不再嵌套 span）。
    expect(root.querySelector('[data-search-key="1:4:8"] span')).toBeNull();
  });

  it('canWrapSearchMark：部分填充层跳过、填充完成后可包裹、已包裹后幂等拒绝', () => {
    // pdfjs 异步分批追加：层当前只有 6 个字符，命中 [4,8) 未填充完。
    const root = layer('前缀文字', '命中');
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(false);

    // 后续批次到达，层填充完成。
    const span = document.createElement('span');
    span.textContent = '目标';
    root.appendChild(span);
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(true);

    // 包裹后同 key 幂等拒绝（observer 重触发不再包裹）。
    const range = offsetRangeFrom(root, 4, 8)!;
    wrapTextRangeWithSpan(root, range, 'lightink-reader-search-mark', '1:4:8');
    expect(canWrapSearchMark(root, '1:4:8', 8)).toBe(false);
  });
});

describe('findTextHits', () => {
  it('单段文本内大小写不敏感多命中，返回拼接文本偏移', () => {
    expect(findTextHits('正文包含 Keyword 一处', 'keyword')).toEqual([
      { start: 5, end: 12 },
    ]);
    expect(findTextHits('keyword 又一处 keyword', 'Keyword')).toEqual([
      { start: 0, end: 7 },
      { start: 12, end: 19 },
    ]);
    expect(findTextHits('任意文本', '  ')).toEqual([]);
  });

  it('小写化改变 UTF-16 长度时退化大小写敏感，偏移保持与 DOM 文本对齐', () => {
    expect(findTextHits('İabc', 'İ')).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('搜索 overlay 共享幂等引擎（PDF 文本层 / 流式正文同引擎）', () => {
  function layer(...texts: string[]): HTMLElement {
    const root = document.createElement('div');
    root.className = 'lightink-reader-text-layer';
    for (const text of texts) {
      const span = document.createElement('span');
      span.textContent = text;
      root.appendChild(span);
    }
    document.body.appendChild(root);
    return root;
  }

  it('幂等渲染：已有 key 只校正当前类名不重包裹，切换当前命中不增删 overlay', () => {
    const root = layer('前缀文字命中目标后缀');
    const specs = [
      { key: 'a', start: 0, end: 4 },
      { key: 'b', start: 4, end: 8 },
    ];
    renderSearchMarks(root, specs, 'a');
    expect(root.querySelector('[data-search-key="a"]')!.className).toBe(
      SEARCH_MARK_CURRENT_CLASS,
    );
    expect(root.querySelector('[data-search-key="b"]')!.className).toBe(
      SEARCH_MARK_CLASS,
    );

    // 切换当前命中：只改类名，绝不重包裹（防 observer 自激循环）。
    renderSearchMarks(root, specs, 'b');
    const keyed = root.querySelectorAll('[data-search-key]');
    expect(keyed.length).toBe(2);
    expect(root.querySelector('[data-search-key="a"]')!.className).toBe(SEARCH_MARK_CLASS);
    expect(root.querySelector('[data-search-key="b"]')!.className).toBe(
      SEARCH_MARK_CURRENT_CLASS,
    );
    expect(root.textContent).toBe('前缀文字命中目标后缀');
    expect(root.querySelector('[data-search-key] span')).toBeNull();
  });

  it('陈旧 key 就地解包移除（查询变化），部分填充层跳过等待重试', () => {
    const root = layer('前缀文字', '命中'); // 层当前只有 6 字，命中 [4,8) 未就绪
    renderSearchMarks(root, [{ key: 'a', start: 4, end: 8 }], null);
    expect(root.querySelector('[data-search-key]')).toBeNull();

    const span = document.createElement('span');
    span.textContent = '目标';
    root.appendChild(span);
    renderSearchMarks(root, [{ key: 'a', start: 4, end: 8 }], 'a');
    // [4,8) 跨两个 span：引擎为每个文本片段独立包裹，共享同一 key 戳记。
    const wrapped = root.querySelectorAll<HTMLElement>('[data-search-key="a"]');
    expect(wrapped.length).toBe(2);
    expect(wrapped[0]!.textContent).toBe('命中');
    expect(wrapped[1]!.textContent).toBe('目标');
    expect(wrapped[0]!.className).toBe(SEARCH_MARK_CURRENT_CLASS);

    // 新查询：旧 key 陈旧即解包，无需整层清空重建。
    renderSearchMarks(root, [{ key: 'b', start: 0, end: 4 }], null);
    expect(root.querySelector('[data-search-key="a"]')).toBeNull();
    expect(root.querySelector('[data-search-key="b"]')?.textContent).toBe('前缀文字');

    clearSearchMarks(root);
    expect(root.querySelector('[data-search-key]')).toBeNull();
    expect(root.textContent).toBe('前缀文字命中目标');
  });

  it('流式 key 含 end：同起始不同 end 的查询精化触发重包裹，高亮跟随新长度', () => {
    // 同章同序同起始、end 不同 → 戳记必须不同（回归：key 曾缺 end，导致精化
    // 查询命中 existing 分支只校正类名，高亮停留旧长度）。
    expect(flowSearchMarkKey(0, 0, 4, 6)).not.toBe(flowSearchMarkKey(0, 0, 4, 7));
    expect(flowSearchMarkKey(0, 0, 4, 7)).toBe('0:0:4:7');

    const root = layer('正文 abc 后续');
    const shortKey = flowSearchMarkKey(0, 0, 3, 5); // "ab"
    renderSearchMarks(root, [{ key: shortKey, start: 3, end: 5 }], shortKey);
    expect(root.querySelector<HTMLElement>(`[data-search-key="${shortKey}"]`)!.textContent)
      .toBe('ab');

    // 查询精化 ab → abc：同一起始、更长的 end。
    const longKey = flowSearchMarkKey(0, 0, 3, 6); // "abc"
    renderSearchMarks(root, [{ key: longKey, start: 3, end: 6 }], longKey);
    expect(root.querySelector(`[data-search-key="${shortKey}"]`)).toBeNull();
    const marked = root.querySelector<HTMLElement>(`[data-search-key="${longKey}"]`);
    expect(marked?.textContent).toBe('abc');
    expect(marked?.className).toBe(SEARCH_MARK_CURRENT_CLASS);

    // 查询缩短 abc → ab：同一起始、更短的 end，同样重包裹。
    renderSearchMarks(root, [{ key: shortKey, start: 3, end: 5 }], shortKey);
    expect(root.querySelector(`[data-search-key="${longKey}"]`)).toBeNull();
    expect(root.querySelector(`[data-search-key="${shortKey}"]`)?.textContent).toBe('ab');
  });
});

describe('snippetAround', () => {
  it('keeps bounded context and marks clipped edges', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    expect(snippetAround(text, 10, 12, 3)).toBe('…hijklmno…');
    expect(snippetAround('short hit', 6, 9, 40)).toBe('short hit');
    expect(snippetAround('', 0, 0)).toBe('');
  });
});
