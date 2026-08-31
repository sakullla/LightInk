/**
 * `search-overlay` — 搜索命中 overlay 共享幂等引擎（PDF 文本层 / 流式 iframe 正文）。
 *
 * 宿主差异（PDF 按页定位文本层、流式按章定位 body）由调用方适配注入；引擎只面向
 * 单个 host 工作，语义与两套原实现一致：
 * - key 戳记幂等：已存在的命中只校正当前/非当前类名，绝不重包裹——重包裹会在被
 *   MutationObserver 观察的文本层内制造变更，与 observer 形成自激循环；
 * - host 拼接文本尚未填充到命中末尾（pdfjs 分批追加 span）时跳过，等后续批次重试；
 * - 本次命中集之外的陈旧 key 就地解包移除（查询变化时不再需要整层清空重建）；
 * - clearSearchMarks 整层清空（关闭搜索 / 切换文档）。
 */

import {
  canWrapSearchMark,
  findTextHits,
  offsetRangeFrom,
  SEARCH_HIT_CAP,
  unwrapSpans,
  wrapTextRangeWithSpan,
} from './search-panel.js';

export const SEARCH_MARK_CLASS = 'lightink-reader-search-mark';
export const SEARCH_MARK_CURRENT_CLASS = 'lightink-reader-search-mark--current';

/** 一次待渲染的命中：key 为幂等戳记，start/end 为 host 拼接文本偏移。 */
export interface SearchMarkSpec {
  key: string;
  start: number;
  end: number;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Cap in-host search overlays so a common query cannot wrap thousands of
 * inline spans. CSS columns + outline/box-shadow on that many marks make the
 * page jitter on hover and freeze overflow-x paging. Always keep the current
 * hit when it would otherwise fall past the cap.
 */
export function limitSearchMarkSpecs(
  specs: readonly SearchMarkSpec[],
  currentKey: string | null,
  cap = SEARCH_HIT_CAP,
): SearchMarkSpec[] {
  if (specs.length <= cap) {
    return [...specs];
  }
  const kept = specs.slice(0, cap);
  if (currentKey === null || kept.some((spec) => spec.key === currentKey)) {
    return kept;
  }
  const current = specs.find((spec) => spec.key === currentKey);
  if (current === undefined) {
    return kept;
  }
  return [...kept.slice(0, Math.max(0, cap - 1)), current];
}

/**
 * 命中偏移对齐宿主挂载文本（flow 族）。扫描时未挂载章按 fallback 文本
 * （htmlToSearchText，空白折叠成单空格）计算偏移；章挂载后 iframe 正文
 * textContent 保留原始空白与缩进，两种形态的偏移不同——照旧偏移包裹会
 * 逐段漂移高亮错字。逐条校验 [start, end) 切片仍是查询词：吻合的原样保留
 * （挂载章扫描本就同源，零成本通过）；失配的按 key 中的命中序号在挂载
 * 文本上重扫描定位；定位不到的丢弃（挂载文本尚未就绪时等后续重涂）。
 */
export function alignSearchSpecsToText(
  text: string,
  specs: readonly SearchMarkSpec[],
  query: string,
): SearchMarkSpec[] {
  const needle = query.trim();
  if (needle === '' || specs.length === 0) {
    return [...specs];
  }
  const loweredNeedle = needle.toLowerCase();
  const matchesAt = (spec: SearchMarkSpec): boolean => {
    const slice = text.slice(spec.start, spec.end);
    return slice === needle || slice.toLowerCase() === loweredNeedle;
  };
  let relocated: readonly { start: number; end: number }[] | null = null;
  const aligned: SearchMarkSpec[] = [];
  for (const spec of specs) {
    if (matchesAt(spec)) {
      aligned.push(spec);
      continue;
    }
    relocated ??= findTextHits(text, needle);
    const ordinal = Number(spec.key.split(':')[1]);
    const hit = Number.isInteger(ordinal) ? relocated[ordinal] : undefined;
    if (hit !== undefined) {
      aligned.push({ key: spec.key, start: hit.start, end: hit.end });
    }
  }
  return aligned;
}

/**
 * 流式命中幂等戳记（与 PDF 的 page:start:end 对齐，补入命中序）。end 必须参与
 * 戳记：查询精化（ab → abc）或缩短时，同章同序同起始命中的 end 会变化，戳记
 * 随之变化才能让引擎把旧 span 解包并按新长度重包裹。
 */
export function flowSearchMarkKey(
  chapter: number,
  ordinal: number,
  start: number,
  end: number,
): string {
  return `${chapter}:${ordinal}:${start}:${end}`;
}

/**
 * 在单个 host 上幂等渲染命中 overlay：陈旧 key 解包、缺失 key 包裹、
 * 已有 key 只校正类名。currentKey 为当前活动命中（无则为 null）。
 */
export function renderSearchMarks(
  host: HTMLElement,
  specs: readonly SearchMarkSpec[],
  currentKey: string | null,
): void {
  const wanted = new Set(specs.map((spec) => spec.key));
  for (const span of Array.from(host.querySelectorAll<HTMLElement>('[data-search-key]'))) {
    const key = span.dataset.searchKey ?? '';
    if (key === '' || wanted.has(key)) {
      continue;
    }
    if (
      !span.classList.contains(SEARCH_MARK_CLASS) &&
      !span.classList.contains(SEARCH_MARK_CURRENT_CLASS)
    ) {
      continue;
    }
    const parent = span.parentNode;
    span.replaceWith(...Array.from(span.childNodes));
    parent?.normalize();
  }
  for (const spec of specs) {
    const isCurrent = currentKey !== null && spec.key === currentKey;
    const existing = host.querySelectorAll<HTMLElement>(
      `[data-search-key="${cssEscape(spec.key)}"]`,
    );
    if (existing.length > 0) {
      for (const span of existing) {
        span.classList.toggle(SEARCH_MARK_CURRENT_CLASS, isCurrent);
        span.classList.toggle(SEARCH_MARK_CLASS, !isCurrent);
      }
      continue;
    }
    if (!canWrapSearchMark(host, spec.key, spec.end)) {
      continue; // host 文本尚未填充到命中末尾：等 observer 后续批次重试
    }
    const located = offsetRangeFrom(host, spec.start, spec.end);
    if (located !== null) {
      wrapTextRangeWithSpan(
        host,
        located,
        isCurrent ? SEARCH_MARK_CURRENT_CLASS : SEARCH_MARK_CLASS,
        spec.key,
      );
    }
  }
}

/** 清空 host 上全部搜索命中 overlay（span 解包保留文本）。 */
export function clearSearchMarks(host: ParentNode): void {
  unwrapSpans(host, SEARCH_MARK_CLASS);
  unwrapSpans(host, SEARCH_MARK_CURRENT_CLASS);
}
