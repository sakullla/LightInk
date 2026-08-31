/**
 * `session/session-search` — 搜索会话规则唯一实现（R1/R3）。
 *
 * 本模块独占的会话规则（视图与格式侧不得再各自复制；数值自 reader-view
 * 原样搬迁，行为冻结）：
 * - 世代失效：每次执行/清空递增 searchGeneration，扫描续行点（章文本加载、
 *   UI 让步、matcher 回投）核对世代与销毁位，过期结果静默丢弃——新查询使
 *   旧结果世代失效不误跳；
 * - 防抖：程序性重查（schedule）在 SEARCH_QUERY_DEBOUNCE_MS 窗口内合并，
 *   后续查询取代先前；立即执行与清空作废待执行查询（destroy 路径经
 *   cancelScheduled 收口，原 reader-view searchDebounce 脚手架删除）。
 *   输入侧 IME 防抖仍在面板（bindImeSafeQuery），本规则只管会话内的
 *   重查合并；
 * - 命中上限：SEARCH_HIT_CAP 首页 + loadMore 逐页展开（hitViews 按档位
 *   封顶 + current 标记）；
 * - busy reveal：短于 SEARCH_BUSY_REVEAL_MS 的扫描不闪 busy chrome；
 * - 首命中滚动：pdf 激活跳转记录 pendingScrollKey，目标页文本层异步就绪
 *   （renderPdfHits 内 consumePendingScroll 报告 mark 已渲染）时滚动一次即
 *   消费，observer 驱动的重渲染不回吸视口；
 * - 活动命中步进：环形 next/prev（nextMatchIndex）、按 key 激活（flow 未
 *   挂载章 ensureFlowChapter 后重收集对齐，至多 12 次让步重试）、重扫保序
 *   （preserveMatchIndex + 当前阅读位置回落 nearestMatchIndex）。
 *
 * 匹配器留格式侧（host 供数，adapter 模式同 session-progress 先例）：
 * - pdf 族匹配（pdf 句柄 search）与 flow 章文本匹配（拼接文本 → 命中
 *   spec，含 key 戳记）由视图按族供数，本模块不 import 任何格式实现；
 * - 命中 overlay 一律经共享幂等引擎（search-overlay renderSearchMarks/
 *   clearSearchMarks）渲染：render*Hits/clearMarks 是视图对引擎的按族
 *   适配（按页定位文本层 / 按章定位 body），本模块不触 DOM；
 * - 侧栏/搜索层的命中列表与状态表面（snippet/location 标签）由视图在
 *   describe*Hits 内生成（i18n 与章文本读取留在视图层）。
 *
 * reader-view 接线对照（原函数 → 本模块入口）：
 * runReaderSearch/runPdfSearch/runFlowSearch → run；jumpReaderMatch → step；
 * jumpToSearchKey（含 activatePdfMatchAt/activateFlowMatchAt/
 * revealFlowSearchKey） → activateKey；loadMoreSearchHits → loadMore；
 * collectSearchHitViews/searchHitsState → hitViews/hitsState；
 * renderPdfSearchMarks/renderFlowSearchMarks（observer 重放） → rerender；
 * clearSearchSession → clear；searchDebounce 三处清理 → schedule/cancelScheduled。
 */

import {
  capSearchHits,
  createSearchBusyReveal,
  nearestMatchIndex,
  nextMatchIndex,
  preserveMatchIndex,
  yieldToUi,
  SEARCH_HIT_CAP,
  SEARCH_QUERY_DEBOUNCE_MS,
  type PdfSearchMatch,
} from '../search-panel.js';
import type { SearchMarkSpec } from '../search-overlay.js';

/** 搜索会话两族：PDF 文本层 / flow 章文本（页式漫画无文本，不可搜）。 */
export type SessionSearchKind = 'pdf' | 'flow';

/** 一条命中的族内定位载荷：视图按载荷执行渲染分组与激活滚动。 */
export type SessionSearchHitPayload =
  | {
    readonly kind: 'pdf';
    /** 1-based 页码（与 pdf 句柄 scrollToPage 同一坐标系）。 */
    readonly page: number;
    /** 命中在该页拼接文本中的 [start, end) 偏移（与文本层 anchor 同源）。 */
    readonly start: number;
    readonly end: number;
  }
  | {
    readonly kind: 'flow';
    /** 章索引（未挂载章激活时 ensure 的目标）。 */
    readonly chapter: number;
    /** 命中在该章拼接文本中的 [start, end) 偏移。 */
    readonly start: number;
    readonly end: number;
  };

/** 会话命中的规范描述：key 供步进/激活/overlay 戳记，snippet/location 供列表。 */
export interface SessionSearchHit {
  readonly key: string;
  readonly snippet: string;
  readonly location: string;
  readonly payload: SessionSearchHitPayload;
}

/** 侧栏/搜索层渲染的命中视图（current = 会话活动命中）。 */
export interface SessionSearchHitView extends SessionSearchHit {
  readonly current: boolean;
}

/** 命中列表的 busy/上限表面（原 searchHitsState）。 */
export interface SessionSearchHitsState {
  /** 扫描未完成且 busy chrome 未到揭示阈值（不渲染 searching 行）。 */
  readonly pending: boolean;
  /** 扫描未完成且已过揭示阈值（渲染 spinner/“12+” 行）。 */
  readonly searching: boolean;
  /** 还有未展开命中或扫描仍在进行（load-more 哨兵）。 */
  readonly hasMore: boolean;
}

/** flow 一批章命中：章索引 → 该章命中 spec（共享幂等引擎按章渲染）。 */
export type FlowSearchMarkGroups = ReadonlyMap<number, readonly SearchMarkSpec[]>;

/** pdf 匹配器回投口：部分与最终结果都经 onResult 回投（模块负责世代失效）。 */
export interface PdfSearchSink {
  onResult(matches: readonly PdfSearchMatch[], done: boolean): void;
}

/** 未挂载章命中激活的让步重试上限（原 revealFlowSearchKey 的 12 次原样搬迁）。 */
export const FLOW_HIT_REVEAL_MAX_ATTEMPTS = 12;

/** 视图侧钩子：核心持有会话规则与状态机，匹配器/overlay/DOM 留在视图层。 */
export interface SessionSearchHost {
  /** 当前会话族（原 runReaderSearch 分发：pdfHandle 存在 → 'pdf'）。 */
  activeKind(): SessionSearchKind;
  /** 视图已销毁（扫描与激活续行的守卫）。 */
  isDestroyed(): boolean;
  /** 命中/状态变化通知（发布、步进、展开、busy 揭示；渲染 sheet 与侧栏）。 */
  syncHits(): void;
  /** 清空全部命中 overlay（PDF 文本层与 flow 正文；幂等解包保留文本）。 */
  clearMarks(): void;

  /** pdf 匹配器（格式侧）：执行句柄搜索并经 sink 回投部分/最终结果；句柄被取代后不得回投。 */
  searchPdf(query: string, sink: PdfSearchSink): void;
  /** pdf 命中描述（key/片段/页码标签 + 页偏移载荷；与 matches 一一对应）。 */
  describePdfHits(matches: readonly PdfSearchMatch[]): SessionSearchHit[];
  /** pdf 当前页（活动命中回落基准 firstAtOrAfter）。 */
  pdfCurrentPage(): number;
  /** pdf 命中 overlay 渲染：按载荷页分组交共享幂等引擎；含首命中滚动的就绪消费（consumePendingScroll）。 */
  renderPdfHits(hits: readonly SessionSearchHit[], activeKey: string | null): void;
  /** pdf 激活滚动（scrollToPage + 页状态同步；overlay 由模块随后渲染）。 */
  activatePdfHit(hit: SessionSearchHit): void;

  /** flow 是否可搜（页式漫画无章文本：run 清空而非扫描）。 */
  flowSearchable(): boolean;
  /** flow 章总数（含未挂载 spine 计数）。 */
  flowChapterCount(): number;
  /** flow 一章拼接文本：已挂载章同步返回 string；未挂载章返回源加载后的文本（无源可加载为 undefined，按空文本处理）。 */
  flowChapterText(chapter: number): string | Promise<string> | undefined;
  /** flow 章匹配器（格式侧）：拼接文本 → 该章命中 spec（key 用 flowSearchMarkKey 戳记）。 */
  flowMatchChapter(chapter: number, text: string, query: string): readonly SearchMarkSpec[];
  /** flow 命中描述（按章文本生成片段与章标签 + 章偏移载荷；含未挂载章）。 */
  describeFlowHits(groups: FlowSearchMarkGroups): SessionSearchHit[];
  /** flow 命中 overlay 渲染：各章 body 交共享幂等引擎（currentKey 只校正类名）。 */
  renderFlowHits(groups: FlowSearchMarkGroups, currentKey: string | null): void;
  /** flow 挂载 mark 收集：步进序列 keys（按章/序）+ 当前阅读位置起的回落基准。 */
  collectFlowMarks(groups: FlowSearchMarkGroups): {
    readonly keys: readonly string[];
    readonly firstAtOrAfter: number;
  };
  /** flow 确保章挂载并置为活动章（未挂载命中激活的第一步）。 */
  ensureFlowChapter(chapter: number): void;
  /** flow 激活滚动：按 key 解析 mark 后分栏对齐或滚入视口。 */
  revealFlowHit(key: string): void;
}

/** 搜索会话句柄：reader-view 以 host 供数并消费其规则裁决。 */
export interface ReaderSessionSearch {
  /** 当前查询（无会话 null；重排后重查的查询回退源）。 */
  query(): string | null;
  /** 活动命中下标（步进序列内；无活动 -1；重扫保序入参）。 */
  activeIndex(): number;
  /** 活动命中 key（无活动 null）。 */
  activeKey(): string | null;
  /** 命中列表（按 displayLimit 封顶 + current 标记；原 collectSearchHitViews）。 */
  hitViews(): SessionSearchHitView[];
  /** busy/上限表面（原 searchHitsState）。 */
  hitsState(): SessionSearchHitsState;
  /** 待滚动命中 key（首命中滚动一次性消费；pdf 族激活时设置）。 */
  pendingScrollKey(): string | null;
  /** 首命中滚动就绪消费：当前 key 命中 pending 且视图确认 mark 已就绪时清除并返回 true。 */
  consumePendingScroll(currentKey: string | null, markReady: boolean): boolean;
  /** 执行搜索（立即；空查询对 flow 族清空、对 pdf 族照跑句柄搜索，与原口径一致）。 */
  run(query: string, options?: { readonly preserveActive?: number }): void;
  /** 防抖执行（程序性重查合并；立即 run 与 clear 作废待执行查询）。 */
  schedule(query: string, delayMs?: number): void;
  /** 取消待执行的防抖重查（destroy 收尾）。 */
  cancelScheduled(): void;
  /** 活动命中环形步进（direction 1 下一个 / -1 上一个）。 */
  step(direction: 1 | -1): void;
  /** 按命中 key 激活（flow 未挂载章：ensure 后重收集对齐并 reveal）。 */
  activateKey(key: string): void;
  /** 展开下一页命中（SEARCH_HIT_CAP 递增；无可展开时 no-op）。 */
  loadMore(): void;
  /** 按当前会话重渲染命中 overlay（文本层重建/缩放重排后的 observer 重放）。 */
  rerender(): void;
  /**
   * 释放正文命中 overlay 但保留会话（整页搜索关闭后的滞后清除：跳转命中
   * 短暂高亮后正文不留残迹，面板查询与命中列表不丢）。释放后 rerender 与
   * 在飞扫描的发布都不再重涂，直到下一次 run / 激活命中。
   */
  dropMarks(): void;
  /** 清空会话：世代 +1（作废在飞扫描）、busy/防抖/pending 滚动复位、清命中 overlay。 */
  clear(): void;
}

interface SearchSessionState {
  readonly kind: SessionSearchKind;
  readonly query: string;
  readonly hits: readonly SessionSearchHit[];
  /** flow 族：当前批章命中（渲染/描述/重收集源；扫描期随批次增长）。 */
  readonly groups: FlowSearchMarkGroups | null;
  /**
   * 步进序列：pdf = 全部命中 key（按页序）；flow = 已挂载 mark key（按章/序，
   * 未挂载章的命中不在序列内——步进只在已挂载窗口内环形，与原口径一致）。
   */
  sequence: readonly string[];
  active: number;
  done: boolean;
}

const EMPTY_FLOW_GROUPS: FlowSearchMarkGroups = new Map<number, readonly SearchMarkSpec[]>();

export function createReaderSessionSearch(host: SessionSearchHost): ReaderSessionSearch {
  let state: SearchSessionState | null = null;
  let searchGeneration = 0;
  let displayLimit = SEARCH_HIT_CAP;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 激活跳转待滚动的命中 key：命中首次就绪（含远页文本层异步出现）时滚动一次后清除。 */
  let pendingScrollKey: string | null = null;
  /** 正文 mark 已释放（dropMarks）：rerender 与在飞发布不再重涂，run/激活复位。 */
  let marksReleased = false;
  const searchBusy = createSearchBusyReveal(() => {
    host.syncHits();
  });

  /** 扫描续行守卫：销毁或世代失配（新查询/清空/切换文档）即丢弃续行结果。 */
  const isLive = (generation: number): boolean =>
    !host.isDestroyed() && generation === searchGeneration;

  const cancelScheduled = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const activeKeyOf = (session: SearchSessionState): string | null =>
    session.active >= 0 ? session.sequence[session.active] ?? null : null;

  const flowGroupsOf = (session: SearchSessionState): FlowSearchMarkGroups =>
    session.groups ?? EMPTY_FLOW_GROUPS;

  /** pdf 批结果落位（原 applyPdfMatches）：活动命中保序 + 当前页回落。 */
  const applyPdfMatches = (
    query: string,
    matches: readonly PdfSearchMatch[],
    done: boolean,
  ): void => {
    const previous = state?.query === query ? state.active : -1;
    const firstAtOrAfter = matches.findIndex((match) => match.page >= host.pdfCurrentPage());
    const hits = host.describePdfHits(matches);
    const active = preserveMatchIndex(hits.length, previous, firstAtOrAfter);
    state = {
      kind: 'pdf',
      query,
      hits,
      groups: null,
      sequence: hits.map((hit) => hit.key),
      active,
      done,
    };
    if (done) {
      searchBusy.clear();
    }
    if (!marksReleased) {
      host.renderPdfHits(hits, activeKeyOf(state));
    }
    host.syncHits();
  };

  /** 执行 pdf 搜索：输入层已去抖；这里只换代取消过期 in-flight 结果（原 runPdfSearch）。 */
  const runPdfSearch = (query: string): void => {
    const generation = ++searchGeneration;
    displayLimit = SEARCH_HIT_CAP;
    marksReleased = false;
    searchBusy.start();
    cancelScheduled();
    host.searchPdf(query, {
      onResult: (matches, done) => {
        if (!isLive(generation)) {
          return; // 新查询/清空/销毁/句柄取代：过期结果丢弃
        }
        applyPdfMatches(query, matches, done);
      },
    });
  };

  /** flow 批结果落位（原 publishFlowSearch）：先无当前渲染再收集序列，命中当前类名经幂等重放校正。 */
  const publishFlowSearch = (
    query: string,
    groups: FlowSearchMarkGroups,
    done: boolean,
    preserveActive?: number,
  ): void => {
    if (!marksReleased) {
      host.renderFlowHits(groups, null);
    }
    const { keys, firstAtOrAfter } = host.collectFlowMarks(groups);
    const fallback = nearestMatchIndex(keys.length, firstAtOrAfter);
    const active = preserveMatchIndex(keys.length, preserveActive ?? state?.active ?? -1, fallback);
    state = {
      kind: 'flow',
      query,
      hits: host.describeFlowHits(groups),
      groups,
      sequence: keys,
      active,
      done,
    };
    const currentKey = activeKeyOf(state);
    if (currentKey !== null && !marksReleased) {
      host.renderFlowHits(groups, currentKey);
    }
    if (done) {
      searchBusy.clear();
    }
    host.syncHits();
  };

  /** 执行 flow 搜索（原 runFlowSearch）：空查询/页式漫画清空；逐章扫描按 cadence 发布并让步 UI。 */
  const runFlowSearch = (query: string, options?: { readonly preserveActive?: number }): void => {
    const trimmed = query.trim();
    if (trimmed === '' || !host.flowSearchable()) {
      state = null;
      host.clearMarks();
      host.syncHits();
      return;
    }
    const generation = ++searchGeneration;
    displayLimit = SEARCH_HIT_CAP;
    marksReleased = false;
    searchBusy.start();
    cancelScheduled();
    publishFlowSearch(trimmed, new Map(), false, options?.preserveActive);
    void (async () => {
      const byChapter = new Map<number, readonly SearchMarkSpec[]>();
      const total = host.flowChapterCount();
      for (let chapter = 0; chapter < total; chapter += 1) {
        if (!isLive(generation)) {
          return;
        }
        const textOrPromise = host.flowChapterText(chapter);
        const text =
          typeof textOrPromise === 'string' ? textOrPromise : (await textOrPromise) ?? '';
        if (!isLive(generation)) {
          return;
        }
        const specs = host.flowMatchChapter(chapter, text, trimmed);
        if (specs.length > 0) {
          byChapter.set(chapter, specs);
        }
        if (chapter === 0 || (chapter + 1) % 2 === 0 || chapter === total - 1) {
          publishFlowSearch(trimmed, byChapter, chapter === total - 1, options?.preserveActive);
          if (chapter < total - 1) {
            await yieldToUi();
          }
        }
      }
      if (isLive(generation)) {
        publishFlowSearch(trimmed, byChapter, true, options?.preserveActive);
      }
    })();
  };

  /** 激活序列内命中（原 jumpToPdfMatch/jumpToFlowMatch 共用骨架）：pdf 记 pending 滚动，flow 直接 reveal。 */
  const activateIndex = (index: number): void => {
    const session = state;
    if (session === null || index < 0 || index >= session.sequence.length) {
      return;
    }
    marksReleased = false; // 激活命中重涂 overlay（释放态下点结果也要能看到高亮）
    session.active = index;
    const key = session.sequence[index] ?? null;
    if (key === null) {
      return;
    }
    if (session.kind === 'pdf') {
      pendingScrollKey = key;
      const hit = session.hits.find((candidate) => candidate.key === key);
      if (hit !== undefined && hit.payload.kind === 'pdf') {
        host.activatePdfHit(hit);
      }
      host.renderPdfHits(session.hits, key);
    } else {
      host.renderFlowHits(flowGroupsOf(session), key);
      host.revealFlowHit(key);
    }
    host.syncHits();
  };

  /** 未挂载章命中激活（原 revealFlowSearchKey）：ensure 章后至多 12 次让步重收集对齐。 */
  const ensureFlowHit = async (key: string, chapter: number): Promise<void> => {
    marksReleased = false;
    host.ensureFlowChapter(chapter);
    for (let attempt = 0; attempt < FLOW_HIT_REVEAL_MAX_ATTEMPTS; attempt += 1) {
      await yieldToUi();
      const session = state;
      if (session === null || session.kind !== 'flow') {
        return; // 会话已清空/换代：迟到的激活静默丢弃
      }
      host.renderFlowHits(flowGroupsOf(session), key);
      const { keys, firstAtOrAfter } = host.collectFlowMarks(flowGroupsOf(session));
      session.sequence = keys;
      session.active = preserveMatchIndex(keys.length, keys.indexOf(key), firstAtOrAfter);
      if (keys.includes(key)) {
        host.revealFlowHit(key);
        host.syncHits();
        return;
      }
    }
  };

  return {
    query: () => state?.query ?? null,
    activeIndex: () => state?.active ?? -1,
    activeKey: () => (state === null ? null : activeKeyOf(state)),
    hitViews: () => {
      const session = state;
      if (session === null) {
        return [];
      }
      const views = session.hits.map((hit) => ({
        ...hit,
        current: session.sequence.indexOf(hit.key) === session.active,
      }));
      return capSearchHits(views, displayLimit);
    },
    hitsState: () => {
      const done = state?.done ?? true;
      const revealed = searchBusy.revealed();
      return {
        pending: !done && !revealed,
        searching: !done && revealed,
        hasMore: (state?.hits.length ?? 0) > displayLimit || (!done && revealed),
      };
    },
    pendingScrollKey: () => pendingScrollKey,
    consumePendingScroll: (currentKey, markReady) => {
      if (
        currentKey === null ||
        pendingScrollKey === null ||
        pendingScrollKey !== currentKey ||
        !markReady
      ) {
        return false;
      }
      pendingScrollKey = null;
      return true;
    },
    run: (query, options) => {
      if (host.activeKind() === 'pdf') {
        runPdfSearch(query);
        return;
      }
      runFlowSearch(query, options);
    },
    schedule: (query, delayMs = SEARCH_QUERY_DEBOUNCE_MS) => {
      cancelScheduled();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (host.activeKind() === 'pdf') {
          runPdfSearch(query);
          return;
        }
        runFlowSearch(query);
      }, delayMs);
    },
    cancelScheduled,
    step: (direction) => {
      const session = state;
      if (session === null) {
        return;
      }
      activateIndex(nextMatchIndex(session.sequence.length, session.active, direction));
    },
    activateKey: (key) => {
      const session = state;
      if (session === null) {
        return;
      }
      const index = session.sequence.indexOf(key);
      if (index >= 0) {
        activateIndex(index);
        return;
      }
      if (session.kind !== 'flow') {
        return;
      }
      const hit = session.hits.find((candidate) => candidate.key === key);
      if (hit === undefined || hit.payload.kind !== 'flow') {
        return;
      }
      void ensureFlowHit(key, hit.payload.chapter);
    },
    loadMore: () => {
      const total = state?.hits.length ?? 0;
      if (total <= displayLimit && (state?.done ?? true)) {
        return;
      }
      displayLimit += SEARCH_HIT_CAP;
      host.syncHits();
    },
    rerender: () => {
      const session = state;
      if (session === null || marksReleased) {
        return;
      }
      const key = activeKeyOf(session);
      if (session.kind === 'pdf') {
        host.renderPdfHits(session.hits, key);
        return;
      }
      host.renderFlowHits(flowGroupsOf(session), key);
    },
    dropMarks: () => {
      if (marksReleased) {
        return;
      }
      marksReleased = true;
      host.clearMarks();
    },
    clear: () => {
      searchGeneration += 1;
      displayLimit = SEARCH_HIT_CAP;
      searchBusy.clear();
      cancelScheduled();
      pendingScrollKey = null;
      marksReleased = false;
      state = null;
      host.clearMarks();
    },
  };
}
