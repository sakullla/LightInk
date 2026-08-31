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
  type PdfSearchMatch,
} from '../search-panel.js';
import {
  alignSearchSpecsToText,
  clearSearchMarks,
  flowSearchMarkKey,
  limitSearchMarkSpecs,
  renderSearchMarks,
  SEARCH_MARK_CLASS,
  SEARCH_MARK_CURRENT_CLASS,
} from '../search-overlay.js';
import {
  createReaderSessionSearch,
  FLOW_HIT_REVEAL_MAX_ATTEMPTS,
  type PdfSearchSink,
  type ReaderSessionSearch,
  type SessionSearchHost,
  type SessionSearchHit,
} from '../session/session-search.js';

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

  it('keeps the current hit when capping a dense chapter overlay', () => {
    const specs = Array.from({ length: SEARCH_HIT_CAP + 40 }, (_, index) => ({
      key: `k${index}`,
      start: index,
      end: index + 1,
    }));
    const capped = limitSearchMarkSpecs(specs, `k${SEARCH_HIT_CAP + 10}`);
    expect(capped).toHaveLength(SEARCH_HIT_CAP);
    expect(capped[0]?.key).toBe('k0');
    expect(capped[capped.length - 1]?.key).toBe(`k${SEARCH_HIT_CAP + 10}`);
    expect(limitSearchMarkSpecs(specs, null)).toHaveLength(SEARCH_HIT_CAP);
    expect(limitSearchMarkSpecs(specs, null)[SEARCH_HIT_CAP - 1]?.key).toBe(
      `k${SEARCH_HIT_CAP - 1}`,
    );
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

describe('session-search 搜索会话核心（世代失效/命中上限/busy reveal/活动命中步进）', () => {
  interface FlowHostOptions {
    chapterTexts: readonly string[];
    /** 阅读位置（firstAtOrAfter 回落基准；缺省第 0 章）。 */
    currentChapter?: number;
    /** 自定义章文本供给（世代失效用例按次回放 pending promise）。 */
    chapterText?: (chapter: number) => string | Promise<string> | undefined;
  }

  const createFlowHost = (options: FlowHostOptions) => {
    const calls = {
      syncHits: 0,
      cleared: false,
      revealed: [] as string[],
      ensured: [] as number[],
    };
    const host: SessionSearchHost = {
      activeKind: () => 'flow',
      isDestroyed: () => false,
      syncHits: () => {
        calls.syncHits += 1;
      },
      clearMarks: () => {
        calls.cleared = true;
      },
      searchPdf: () => {
        throw new Error('flow host must not search pdf');
      },
      describePdfHits: () => [],
      pdfCurrentPage: () => 1,
      renderPdfHits: () => {},
      activatePdfHit: () => {},
      flowSearchable: () => true,
      flowChapterCount: () => options.chapterTexts.length,
      flowChapterText: options.chapterText ?? ((chapter) => options.chapterTexts[chapter] ?? ''),
      flowMatchChapter: (chapter, text, query) =>
        findTextHits(text, query).map((hit, ordinal) => ({
          key: flowSearchMarkKey(chapter, ordinal, hit.start, hit.end),
          start: hit.start,
          end: hit.end,
        })),
      describeFlowHits: (groups) => {
        const hits: SessionSearchHit[] = [];
        for (const [chapter, specs] of groups) {
          for (const spec of specs) {
            hits.push({
              key: spec.key,
              snippet: '',
              location: `第 ${chapter + 1} 章`,
              payload: { kind: 'flow', chapter, start: spec.start, end: spec.end },
            });
          }
        }
        return hits;
      },
      renderFlowHits: () => {},
      collectFlowMarks: (groups) => {
        const keys: string[] = [];
        let firstAtOrAfter = -1;
        const currentChapter = options.currentChapter ?? 0;
        for (const [chapter, specs] of groups) {
          for (const spec of specs) {
            if (firstAtOrAfter < 0 && chapter >= currentChapter) {
              firstAtOrAfter = keys.length;
            }
            keys.push(spec.key);
          }
        }
        return { keys, firstAtOrAfter };
      },
      ensureFlowChapter: (chapter) => {
        calls.ensured.push(chapter);
      },
      revealFlowHit: (key) => {
        calls.revealed.push(key);
      },
    };
    return { host, calls };
  };

  const doneState = { pending: false, searching: false, hasMore: false };

  it('无命中保持空态：完成即空列表、不报错、loadMore/步进/点选均为 no-op', async () => {
    const { host } = createFlowHost({ chapterTexts: ['第一章正文', '第二章正文'] });
    const session = createReaderSessionSearch(host);
    expect(() => session.run('目标词')).not.toThrow();
    await vi.waitFor(() => expect(session.hitsState()).toEqual(doneState));
    expect(session.query()).toBe('目标词');
    expect(session.hitViews()).toEqual([]);
    expect(session.activeIndex()).toBe(-1);
    expect(() => {
      session.loadMore();
      session.step(1);
      session.activateKey('0:0:0:2');
    }).not.toThrow();
    expect(session.hitViews()).toEqual([]);
  });

  it('新查询使旧结果世代失效：迟到的旧章文本批次整批丢弃，会话只反映新查询', async () => {
    const pending: Array<(text: string) => void> = [];
    const { host } = createFlowHost({
      chapterTexts: ['占位章'], // 章计数 ≥ 1，文本经自定义供给按次回放
      chapterText: () => new Promise<string>((resolve) => pending.push(resolve)),
    });
    const session = createReaderSessionSearch(host);
    session.run('keyword');
    session.run('新词');
    expect(pending).toHaveLength(2); // 两个世代各自请求第 0 章文本

    pending[0]!('包含 keyword 的旧文本'); // 旧世代迟到：世代失配，续行静默丢弃
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(session.query()).toBe('新词');
    expect(session.hitViews()).toEqual([]);

    pending[1]!('包含 新词 的新文本'); // 新世代继续扫描并完成
    await vi.waitFor(() => expect(session.hitsState()).toEqual(doneState));
    expect(session.query()).toBe('新词');
    const views = session.hitViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.payload).toMatchObject({ kind: 'flow', chapter: 0 });
    expect(views[0]!.current).toBe(true);
  });

  it('pdf 新查询后代入的迟到批次（onProgress/最终）整批丢弃，不误跳', () => {
    const sinks: PdfSearchSink[] = [];
    const pdfMatch = (page: number): PdfSearchMatch => ({ page, start: 0, end: 2, snippet: 'xx' });
    const host: SessionSearchHost = {
      activeKind: () => 'pdf',
      isDestroyed: () => false,
      syncHits: () => {},
      clearMarks: () => {},
      searchPdf: (_query, sink) => {
        sinks.push(sink);
      },
      describePdfHits: (matches) =>
        matches.map((match) => ({
          key: `${match.page}:${match.start}:${match.end}`,
          snippet: match.snippet,
          location: `page ${match.page}`,
          payload: { kind: 'pdf' as const, page: match.page, start: match.start, end: match.end },
        })),
      pdfCurrentPage: () => 1,
      renderPdfHits: () => {},
      activatePdfHit: () => {},
      flowSearchable: () => false,
      flowChapterCount: () => 0,
      flowChapterText: () => undefined,
      flowMatchChapter: () => [],
      describeFlowHits: () => [],
      renderFlowHits: () => {},
      collectFlowMarks: () => ({ keys: [], firstAtOrAfter: -1 }),
      ensureFlowChapter: () => {},
      revealFlowHit: () => {},
    };
    const session = createReaderSessionSearch(host);
    session.run('a');
    session.run('b');
    sinks[0]!.onResult([pdfMatch(3)], true); // 旧查询的迟到最终批：丢弃
    expect(session.query()).toBeNull();
    expect(session.hitViews()).toEqual([]);
    sinks[1]!.onResult([pdfMatch(5)], true); // 新查询落地
    expect(session.query()).toBe('b');
    expect(session.hitViews().map((hit) => hit.key)).toEqual(['5:0:2']);
    expect(session.hitViews()[0]!.current).toBe(true);
  });

  it('命中上限：首屏 SEARCH_HIT_CAP、loadMore 逐档展开，到总数封口', async () => {
    const text = Array.from({ length: 200 }, () => 'hit').join(' ');
    const { host } = createFlowHost({ chapterTexts: [text] });
    const session = createReaderSessionSearch(host);
    session.run('hit');
    await vi.waitFor(() =>
      expect(session.hitsState().pending || session.hitsState().searching).toBe(false),
    );
    expect(session.hitViews()).toHaveLength(SEARCH_HIT_CAP);
    expect(session.hitsState().hasMore).toBe(true);
    session.loadMore();
    expect(session.hitViews()).toHaveLength(SEARCH_HIT_CAP * 2);
    session.loadMore();
    session.loadMore();
    expect(session.hitViews()).toHaveLength(200);
    expect(session.hitsState().hasMore).toBe(false);
  });

  it('活动命中环形步进；同查询重扫 preserveActive 保序', async () => {
    const { host, calls } = createFlowHost({ chapterTexts: ['hit one hit two hit three'] });
    const session = createReaderSessionSearch(host);
    session.run('hit');
    await vi.waitFor(() => expect(session.hitsState()).toEqual(doneState));
    expect(session.activeIndex()).toBe(0);
    session.step(1);
    expect(session.activeIndex()).toBe(1);
    session.step(1);
    session.step(1);
    expect(session.activeIndex()).toBe(0); // 末尾回绕
    session.step(-1);
    expect(session.activeIndex()).toBe(2);
    expect(calls.revealed).toHaveLength(4); // 每次步进按活动命中 reveal 一次

    session.run('hit', { preserveActive: 2 });
    await vi.waitFor(() => expect(session.hitsState()).toEqual(doneState));
    expect(session.activeIndex()).toBe(2); // 重扫保留活动命中
  });

  it('schedule 防抖合并：窗口内后查取代前查；立即 run 与 clear 作废待执行', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = createFlowHost({ chapterTexts: ['alpha keyword'] });
      const session = createReaderSessionSearch(host);
      session.schedule('key');
      session.schedule('keyword');
      await vi.advanceTimersByTimeAsync(SEARCH_QUERY_DEBOUNCE_MS - 1);
      expect(session.query()).toBeNull(); // 防抖窗口内不执行
      await vi.advanceTimersByTimeAsync(1);
      expect(session.query()).toBe('keyword'); // 只执行合并后的查询
      await vi.advanceTimersByTimeAsync(0);

      session.schedule('key');
      session.run('alpha');
      await vi.advanceTimersByTimeAsync(SEARCH_QUERY_DEBOUNCE_MS + 10);
      expect(session.query()).toBe('alpha'); // 立即执行作废待执行的防抖查询
      await vi.advanceTimersByTimeAsync(0);

      session.schedule('keyword');
      session.clear();
      await vi.advanceTimersByTimeAsync(SEARCH_QUERY_DEBOUNCE_MS + 10);
      expect(session.query()).toBeNull(); // clear 作废待执行查询并清 overlay
      expect(calls.cleared).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('session-search 会话规则补全（busy reveal/首命中滚动/未挂载章激活/重放）', () => {
  /**
   * pdf 族 harness：真实文本层 div + 共享幂等引擎渲染，匹配器经可控 sink
   * 回投（部分/终批按测试驱动）；renderPdfHits 内按 reader-view 同款在当前
   * mark 就绪时经 consumePendingScroll 消费首命中滚动。
   */
  const createPendingPdfHost = (layerTexts: readonly (string | null)[]) => {
    const layers = layerTexts.map((text) => {
      const layer = document.createElement('div');
      layer.className = 'lightink-reader-text-layer';
      if (text !== null) {
        layer.textContent = text;
      }
      document.body.appendChild(layer);
      return layer;
    });
    const sinks: PdfSearchSink[] = [];
    const goToPages: number[] = [];
    const consumedScrolls: string[] = [];
    let syncHits = 0;
    let session: ReaderSessionSearch | null = null;
    const host: SessionSearchHost = {
      activeKind: () => 'pdf',
      isDestroyed: () => false,
      syncHits: () => {
        syncHits += 1;
      },
      clearMarks: () => {
        for (const layer of layers) {
          clearSearchMarks(layer);
        }
      },
      searchPdf: (_query, sink) => {
        sinks.push(sink);
      },
      describePdfHits: (matches) =>
        matches.map((match) => ({
          key: `${match.page}:${match.start}:${match.end}`,
          snippet: match.snippet,
          location: `page ${match.page}`,
          payload: { kind: 'pdf' as const, page: match.page, start: match.start, end: match.end },
        })),
      pdfCurrentPage: () => 1,
      renderPdfHits: (hits, activeKey) => {
        const byPage = new Map<number, { key: string; start: number; end: number }[]>();
        for (const hit of hits) {
          if (hit.payload.kind !== 'pdf') {
            continue;
          }
          const spec = { key: hit.key, start: hit.payload.start, end: hit.payload.end };
          const list = byPage.get(hit.payload.page);
          if (list === undefined) {
            byPage.set(hit.payload.page, [spec]);
          } else {
            list.push(spec);
          }
        }
        for (const [page, specs] of byPage) {
          const layer = layers[page - 1];
          if (layer === undefined) {
            continue; // 未懒渲染的页跳过；观察器驱动重试
          }
          renderSearchMarks(layer, specs, activeKey);
        }
        const active = hits.find((hit) => hit.key === activeKey);
        if (active !== undefined && active.payload.kind === 'pdf') {
          const mark =
            layers[active.payload.page - 1]?.querySelector(`.${SEARCH_MARK_CURRENT_CLASS}`) ??
            null;
          if (mark !== null && session !== null && session.consumePendingScroll(activeKey, true)) {
            consumedScrolls.push(active.key);
          }
        }
      },
      activatePdfHit: (hit) => {
        if (hit.payload.kind === 'pdf') {
          goToPages.push(hit.payload.page);
        }
      },
      flowSearchable: () => false,
      flowChapterCount: () => 0,
      flowChapterText: () => undefined,
      flowMatchChapter: () => [],
      describeFlowHits: () => [],
      renderFlowHits: () => {},
      collectFlowMarks: () => ({ keys: [], firstAtOrAfter: -1 }),
      ensureFlowChapter: () => {},
      revealFlowHit: () => {},
    };
    session = createReaderSessionSearch(host);
    return {
      session,
      sinks,
      goToPages,
      consumedScrolls,
      syncHits: () => syncHits,
      fillLayer: (page: number, text: string) => {
        layers[page - 1]!.textContent = text;
      },
    };
  };

  /** flow 族 harness：挂载集决定哪些章的命中进入步进序列；ensure 即挂载。 */
  const createMountedFlowHost = (
    chapterTexts: readonly string[],
    mountedChapters: readonly number[],
  ) => {
    const mounted = new Set(mountedChapters);
    const revealed: string[] = [];
    const ensured: number[] = [];
    const renderedKeys: (string | null)[] = [];
    const host: SessionSearchHost = {
      activeKind: () => 'flow',
      isDestroyed: () => false,
      syncHits: () => {},
      clearMarks: () => {},
      searchPdf: () => {
        throw new Error('flow host must not search pdf');
      },
      describePdfHits: () => [],
      pdfCurrentPage: () => 1,
      renderPdfHits: () => {},
      activatePdfHit: () => {},
      flowSearchable: () => true,
      flowChapterCount: () => chapterTexts.length,
      flowChapterText: (chapter) => chapterTexts[chapter] ?? '',
      flowMatchChapter: (chapter, text, query) =>
        findTextHits(text, query).map((hit, ordinal) => ({
          key: flowSearchMarkKey(chapter, ordinal, hit.start, hit.end),
          start: hit.start,
          end: hit.end,
        })),
      describeFlowHits: (groups) => {
        const hits: SessionSearchHit[] = [];
        for (const [chapter, specs] of groups) {
          for (const spec of specs) {
            hits.push({
              key: spec.key,
              snippet: '',
              location: `第 ${chapter + 1} 章`,
              payload: { kind: 'flow', chapter, start: spec.start, end: spec.end },
            });
          }
        }
        return hits;
      },
      renderFlowHits: (_groups, currentKey) => {
        renderedKeys.push(currentKey);
      },
      collectFlowMarks: (groups) => {
        const keys: string[] = [];
        let firstAtOrAfter = -1;
        for (const [chapter, specs] of groups) {
          if (!mounted.has(chapter)) {
            continue; // 未挂载章的 mark 尚不存在：不进入步进序列
          }
          for (const spec of specs) {
            if (firstAtOrAfter < 0 && chapter >= 0) {
              firstAtOrAfter = keys.length;
            }
            keys.push(spec.key);
          }
        }
        return { keys, firstAtOrAfter };
      },
      ensureFlowChapter: (chapter) => {
        ensured.push(chapter);
        mounted.add(chapter); // 模拟 flowRenderer.ensureChapter 挂载该章
      },
      revealFlowHit: (key) => {
        revealed.push(key);
      },
    };
    return { host, revealed, ensured, renderedKeys };
  };

  const scanSettled = (session: ReaderSessionSearch): boolean =>
    session.hitsState().pending || session.hitsState().searching ? false : true;

  it('busy reveal：部分批进行中一秒内保持 pending，过阈值转 searching，终批即熄灭', () => {
    vi.useFakeTimers();
    try {
      const h = createPendingPdfHost(['abc']);
      const match: PdfSearchMatch = { page: 1, start: 0, end: 3, snippet: 'abc' };
      h.session.run('abc');
      // 首批回投前无会话状态（pdf 族与原口径一致：空态不显 busy）。
      expect(h.session.hitsState()).toEqual({ pending: false, searching: false, hasMore: false });
      h.sinks[0]!.onResult([match], false); // 首批部分结果：扫描进行中
      expect(h.session.hitsState()).toEqual({ pending: true, searching: false, hasMore: false });
      const before = h.syncHits();
      vi.advanceTimersByTime(SEARCH_BUSY_REVEAL_MS);
      expect(h.syncHits()).toBe(before + 1); // 揭示经 onReveal 重渲染命中表面一次
      expect(h.session.hitsState()).toEqual({ pending: false, searching: true, hasMore: true });
      h.sinks[0]!.onResult([match], true); // 终批：busy 熄灭
      expect(h.session.hitsState()).toEqual({ pending: false, searching: false, hasMore: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pdf 首命中滚动：pendingScrollKey 待 mark 就绪一次性消费，observer 重放不回吸', () => {
    const h = createPendingPdfHost([null]); // 页 1 文本层尚未填充（pdfjs 异步）
    const matches: PdfSearchMatch[] = [
      { page: 1, start: 0, end: 3, snippet: 'abc' },
      { page: 1, start: 4, end: 7, snippet: 'abc' },
      { page: 1, start: 8, end: 11, snippet: 'abc' },
    ];
    h.session.run('abc');
    h.sinks[0]!.onResult(matches, true);
    expect(h.session.activeIndex()).toBe(0);
    expect(h.consumedScrolls).toEqual([]); // 发布不设置待滚动目标
    h.session.step(1);
    expect(h.goToPages).toEqual([1]); // 激活先翻页（scrollToPage + 页状态同步）
    const target = '1:4:7';
    expect(h.session.pendingScrollKey()).toBe(target); // mark 未就绪：目标保持
    h.session.rerender(); // observer 重放：层仍未填充，不消费
    expect(h.session.pendingScrollKey()).toBe(target);
    h.fillLayer(1, 'abc abc abc'); // 文本层异步填充完成
    h.session.rerender();
    expect(h.consumedScrolls).toEqual([target]); // 就绪后恰好消费一次
    expect(h.session.pendingScrollKey()).toBeNull();
    h.session.rerender(); // 后续重放不再回吸视口
    expect(h.consumedScrolls).toEqual([target]);
  });

  it('activateKey 未挂载章：ensure 挂载后重收集对齐并 reveal（12 次让步上限原样搬迁）', async () => {
    expect(FLOW_HIT_REVEAL_MAX_ATTEMPTS).toBe(12);
    const h = createMountedFlowHost(['第一章', '第二章', '目标 词'], [0, 1]); // 章 2 未挂载
    const session = createReaderSessionSearch(h.host);
    session.run('目标');
    await vi.waitFor(() => expect(scanSettled(session)).toBe(true));
    const views = session.hitViews();
    expect(views).toHaveLength(1); // 未挂载章的命中仍在列表（源文本可扫描）
    expect(session.activeKey()).toBeNull(); // 但不在步进序列（mark 不存在）
    const key = views[0]!.key;
    session.activateKey(key);
    expect(h.ensured).toEqual([2]); // 第一步：ensure 挂载目标章
    await vi.waitFor(() => expect(h.revealed).toEqual([key]));
    expect(session.activeKey()).toBe(key); // 重收集对齐后成为活动命中
  });

  it('rerender：按当前会话重放 overlay，currentKey 跟随活动命中', async () => {
    const h = createMountedFlowHost(['hit one hit two'], [0]);
    const session = createReaderSessionSearch(h.host);
    session.run('hit');
    await vi.waitFor(() => expect(scanSettled(session)).toBe(true));
    session.step(1);
    expect(session.activeIndex()).toBe(1);
    h.renderedKeys.length = 0;
    session.rerender();
    expect(h.renderedKeys).toEqual([session.activeKey()]);
  });

  it('dropMarks：释放正文 mark 但保留会话，rerender 静默直到重新激活', async () => {
    const h = createMountedFlowHost(['hit one hit two'], [0]);
    let cleared = 0;
    h.host.clearMarks = () => {
      cleared += 1;
    };
    const session = createReaderSessionSearch(h.host);
    session.run('hit');
    await vi.waitFor(() => expect(scanSettled(session)).toBe(true));

    h.renderedKeys.length = 0;
    session.dropMarks();
    expect(cleared).toBe(1);
    session.dropMarks(); // 幂等：重复释放不再清
    expect(cleared).toBe(1);
    session.rerender();
    expect(h.renderedKeys).toEqual([]); // 释放期 observer 重放不重涂
    expect(session.query()).toBe('hit'); // 会话与命中列表保留
    expect(session.hitViews()).toHaveLength(2);

    // 重新激活命中：恢复重涂并 reveal（整页搜索里再点结果仍能看到高亮）。
    const key = session.hitViews()[0]!.key;
    session.activateKey(key);
    expect(h.renderedKeys).toEqual([key]);
    expect(h.revealed).toEqual([key]);
    h.renderedKeys.length = 0;
    session.rerender();
    expect(h.renderedKeys).toEqual([key]); // 释放态解除后重放恢复
  });
});

describe('alignSearchSpecsToText 命中偏移对齐挂载文本', () => {
  it('fallback 折叠文本算出的漂移偏移按 key 序号重定位到挂载文本', () => {
    const mountedText = '　　前言。\n　　正文出现 词 一次，\n　　再出现 词 一次。';
    const collapsed = mountedText.replace(/\s+/g, ' ').trim();
    const specs = findTextHits(collapsed, '词').map((hit, ordinal) => ({
      key: flowSearchMarkKey(4, ordinal, hit.start, hit.end),
      start: hit.start,
      end: hit.end,
    }));
    expect(specs).toHaveLength(2);
    // 折叠文本偏移在挂载文本上已不指向查询词（空白形态漂移）。
    expect(mountedText.slice(specs[1]!.start, specs[1]!.end)).not.toBe('词');
    const aligned = alignSearchSpecsToText(mountedText, specs, '词');
    expect(aligned).toHaveLength(2);
    aligned.forEach((spec, index) => {
      expect(spec.key).toBe(specs[index]!.key);
      expect(mountedText.slice(spec.start, spec.end)).toBe('词');
    });
  });

  it('已对齐偏移零成本原样保留；挂载文本尚无查询词时丢弃等待重涂', () => {
    const text = 'alpha keyword beta';
    const ok = [{ key: '0:0:6:13', start: 6, end: 13 }];
    expect(alignSearchSpecsToText(text, ok, 'keyword')).toEqual(ok);
    expect(alignSearchSpecsToText('', ok, 'keyword')).toEqual([]);
    expect(alignSearchSpecsToText(text, ok, '')).toEqual(ok); // 空查询不动
  });
});
