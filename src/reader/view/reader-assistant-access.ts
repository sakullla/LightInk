/**
 * `reader-assistant-access` — AI 助手内置工具的宿主供数（R6）。
 *
 * 把阅读器视图的既有能力（目录、章节文本、书内搜索、当前选区、标注写入、
 * 大纲跳转）投影为 `AssistantBookAccess`：
 * - 查询类方法不改变阅读位置（搜索走章文本/PDF 句柄，不经会话搜索 overlay）；
 * - `save` 经应用内确认弹层，拒绝则不写入；写入走 `appendAnnotation`，与手动
 *   添加的同类条目一致；高亮必须有可定位的引文（当前选区或当前章/页内文本）；
 * - `locate` 是用户点击回答中定位链接后的跳转（不是工具自动翻页，R10）。
 */

import type { Locator } from '../annotations.js';
import {
  ASSISTANT_SEARCH_PER_CHAPTER,
  ASSISTANT_SELECTION_LIMIT,
  type AssistantBookAccess,
  type AssistantBookInfo,
  type AssistantChapterText,
  type AssistantLocateTarget,
  type AssistantOutlineEntry,
  type AssistantSaveOutcome,
  type AssistantSaveRequest,
  type AssistantSearchHit,
  type AssistantSearchResult,
} from '../assistant-tools.js';
import type { AssistantChapterContext } from '../assistant-request.js';
import type { PdfRenderHandle } from '../formats/pdf.js';
import type { MessageKey } from '../../i18n/messages.js';
import { outlineFromEntries } from '../outline.js';
import { resolveReaderChapterTitle } from '../reader-progress-ui.js';
import {
  findTextHits,
  htmlToSearchText,
  snippetWithMark,
  trimSnippetLead,
  yieldToUi,
} from '../search-panel.js';
import { showConfirmDialog } from '../../ui/confirm-dialog.js';
import { pdfTextLayerSelector } from './reader-dom.js';
import { PAGE_EXTS, type ReaderViewContext } from './reader-context.js';

/** 书内搜索的墙钟预算：超时返回部分结果并标记 partial。 */
export const ASSISTANT_SEARCH_TIME_BUDGET_MS = 8000;
/** 单章最多收集的命中数（避免一章几百个命中挤掉其它章）。 */
/** 锚点前后文长度（与 currentPositionLocator 同口径）。 */
const ANCHOR_CONTEXT = 32;

const BLOCK_END =
  /<\/(?:p|div|h[1-6]|li|blockquote|pre|tr|section|article|header|footer|dd|dt|figcaption|table)\s*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;

/** 章节 HTML → 保留段落换行的纯文本（搜索/工具回传用；行内空白折叠、不留空行）。 */
export function htmlToChapterText(html: string): string {
  const trimmed = html.trim();
  if (trimmed === '') {
    return '';
  }
  const broken = trimmed.replace(BLOCK_END, '$&\n').replace(LINE_BREAK, '\n');
  let text: string;
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(`<body>${broken}</body>`, 'text/html');
    text = doc.body.textContent ?? '';
  } else {
    text = broken.replace(/<[^>]+>/g, ' ');
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 在原始文本里找引文，忽略两边的空白差异：模型看到的章文本折叠过空白、并在
 * 段落边界插入过换行（htmlToChapterText），原始 textContent 则保留源码缩进、
 * 或在段落之间根本没有字符。先精确 indexOf；失败后把两边的空白全部剥掉再比对，
 * 偏移经索引表映回原始文本。线性时间，不构造正则。
 */
const QUOTE_SKIPPABLE = /[\s\u00ad\u200b-\u200d\u2060\ufeff]/g;
const QUOTE_SKIPPABLE_ONE = /[\s\u00ad\u200b-\u200d\u2060\ufeff]/;

export function findQuoteIgnoringWhitespace(
  text: string,
  quote: string,
): { start: number; end: number } | null {
  const exact = text.indexOf(quote);
  if (exact >= 0) {
    return { start: exact, end: exact + quote.length };
  }
  // 空白之外，软连字符 / 零宽字符也不参与比对：出版社排版会往长词里塞 U+00AD，
  // 模型引用时通常把它们丢掉。
  const needle = quote.replace(QUOTE_SKIPPABLE, '');
  if (needle === '') {
    return null;
  }
  const kept: string[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (!QUOTE_SKIPPABLE_ONE.test(char)) {
      kept.push(char);
      offsets.push(index);
    }
  }
  const at = kept.join('').indexOf(needle);
  if (at < 0) {
    return null;
  }
  const last = offsets[at + needle.length - 1];
  const first = offsets[at];
  if (first === undefined || last === undefined) {
    return null;
  }
  return { start: first, end: last + 1 };
}

export interface ReaderAssistantAccessDeps {
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 章/页定位回退文案（与 chrome 进度同源）。 */
  readonly locationFallback: (kind: 'chapter' | 'page', n: number) => string;
  /** 保存确认（缺省走应用内确认弹层；测试注入）。 */
  readonly confirm?: (spec: { title: string; message: string }) => Promise<boolean>;
  /** 当前上下文迟到就绪（如 PDF 页文本后台抽取完成）：宿主据此刷新面板可用性。 */
  readonly onContextReady?: () => void;
  /** 助手面板当前是否可见：确认通过时面板已关则不写入。 */
  readonly isPanelOpen?: () => boolean;
}

export interface ReaderAssistantAccess extends AssistantBookAccess {
  /** ③ 当前章上下文（与 `currentChapter` 同源；无文本层格式返回 null）。 */
  currentChapterContext(): AssistantChapterContext | null;
  /** 用户点击回答中的定位后跳转（章 / 页）。 */
  locate(target: AssistantLocateTarget): void;
  /** 面板关闭 / 销毁：把正在等待的保存确认全部按取消收掉。 */
  cancelPendingSaves(): void;
}

export function createReaderAssistantAccess(
  ctx: ReaderViewContext,
  deps: ReaderAssistantAccessDeps,
): ReaderAssistantAccess {
  const isPaged = (): boolean => ctx.pdfHandle !== null || ctx.cbzHandle !== null;
  const isComic = (): boolean =>
    ctx.cbzHandle !== null || (PAGE_EXTS.has(ctx.loadedExt) && ctx.loadedExt !== 'pdf');
  const flowChapterCount = (): number =>
    Math.max(ctx.exportChapters.length, ctx.flowChapterCount);

  const outlineEntries = (): AssistantOutlineEntry[] => {
    const items = ctx.readerOutline;
    if (items.length > 0) {
      return items.map((item) => ({
        title: item.text,
        ...(item.chapter !== undefined ? { chapter: item.chapter } : {}),
        ...(item.page !== undefined ? { page: item.page } : {}),
      }));
    }
    if (!isPaged() && ctx.exportChapters.length > 0) {
      return outlineFromEntries(ctx.exportChapters, 'chapter').map((item) => ({
        title: item.text,
        chapter: item.chapter!,
      }));
    }
    return [];
  };

  const chapterTitle = (chapter: number): string => {
    const own = ctx.exportChapters[chapter]?.title?.trim() ?? '';
    if (own !== '') {
      return own;
    }
    const fromOutline = ctx.readerOutline.find((item) => item.chapter === chapter)?.text?.trim();
    if (fromOutline !== undefined && fromOutline !== '') {
      return fromOutline;
    }
    return deps.locationFallback('chapter', chapter + 1);
  };

  const mountedChapterText = (chapter: number): string =>
    ctx.dom.chapterFrame(chapter)?.contentDocument?.body?.textContent ?? '';

  /** 已物化章 HTML 的原始 textContent（未折叠空白，与挂载帧的 body.textContent 同口径）。 */
  const exportedChapterRawText = (chapter: number): string => {
    const html = ctx.exportChapters[chapter]?.html ?? '';
    if (html === '' || typeof DOMParser === 'undefined') {
      return '';
    }
    try {
      return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body?.textContent ?? '';
    } catch {
      return '';
    }
  };

  // 章文本缓存：按章索引 + html 引用，换书（generation 变）即整体失效。搜索、当前章
  // 上下文与 chapterAt 共用，避免每次 hover / 搜索都把整章 HTML 重新 DOMParser 一遍。
  let chapterTextGeneration = -1;
  const chapterTextCache = new Map<number, { html: string; text: string }>();
  const chapterTextCached = (chapter: number, html: string): string => {
    const generation = ctx.sessionLoad.generation();
    if (generation !== chapterTextGeneration) {
      chapterTextCache.clear();
      chapterTextGeneration = generation;
    }
    const hit = chapterTextCache.get(chapter);
    if (hit !== undefined && hit.html === html) {
      return hit.text;
    }
    const text = htmlToChapterText(html);
    chapterTextCache.set(chapter, { html, text });
    return text;
  };

  /** 懒加载章尚未物化时后台物化一次，完成后让面板重新评估（每章只踢一次）。 */
  const chapterLoadsKicked = new Set<number>();
  const kickChapterLoad = (chapter: number, load: () => Promise<unknown>): void => {
    if (chapterLoadsKicked.has(chapter)) {
      return;
    }
    chapterLoadsKicked.add(chapter);
    const generation = ctx.sessionLoad.generation();
    void Promise.resolve()
      .then(load)
      .then(() => {
        if (!ctx.destroyed && generation === ctx.sessionLoad.generation()) {
          deps.onContextReady?.();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        chapterLoadsKicked.delete(chapter);
      });
  };

  /** 章文本：已物化 HTML 优先（保留段落换行），未物化先 load，最后回退挂载正文。 */
  /** 章文本；懒加载章物化失败且没有挂载正文可退回时返回 null（与「空章」区分）。 */
  const flowChapterText = async (chapter: number): Promise<string | null> => {
    const source = ctx.exportChapters[chapter];
    if (source === undefined) {
      const mounted = mountedChapterText(chapter);
      return mounted.trim();
    }
    let loadFailed = false;
    if (source.html === '' && source.load !== undefined) {
      try {
        await source.load();
      } catch {
        loadFailed = true; // 物化失败：退回挂载正文；退不回就是「没读到」，不是「没有」
      }
    }
    const fromHtml = chapterTextCached(chapter, source.html);
    if (fromHtml !== '') {
      return fromHtml;
    }
    const mounted = mountedChapterText(chapter).trim();
    return mounted === '' && loadFailed ? null : mounted;
  };

  /** 页文字层原始拼接文本（不裁剪：标注偏移相对它，与手动划选同口径）。 */
  const pdfPageLayerRaw = (page: number): string =>
    ctx.pageHost.querySelector<HTMLElement>(pdfTextLayerSelector(page))?.textContent ?? '';
  const pdfPageLayerText = (page: number): string => pdfPageLayerRaw(page).trim();
  /** 已在后台抽取中的页：抽完只通知一次，不因 syncControls 反复调用而重复踢。 */
  const pdfTextKicked = new Set<number>();

  /** ③ 当前章：flow 用已挂载/已物化章文本；PDF 用当前页文本层；漫画 null。 */
  /**
   * PDF 当前页文本（同步）：文字层已挂载用文字层；否则用句柄里已缓存的页文本；
   * 都没有时后台抽一次，抽到后通知面板刷新（不把渲染时序当成空页）。
   */
  const pdfCurrentPageText = (handle: PdfRenderHandle, page: number): string | null => {
    const layer = pdfPageLayerText(page);
    if (layer !== '') {
      return layer;
    }
    const cached = handle.pageTextCached?.(page);
    if (cached !== undefined) {
      return cached.trim() === '' ? null : cached.trim();
    }
    if (!pdfTextKicked.has(page)) {
      pdfTextKicked.add(page);
      void handle
        .pageText(page)
        .then((text) => {
          if (!ctx.destroyed && text.trim() !== '') {
            deps.onContextReady?.();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          pdfTextKicked.delete(page);
        });
    }
    return null;
  };

  const currentChapterContext = (): AssistantChapterContext | null => {
    if (isComic()) {
      return null;
    }
    if (ctx.pdfHandle !== null) {
      const page = ctx.pdfHandle.controller.page;
      const text = pdfCurrentPageText(ctx.pdfHandle, page);
      if (text === null) {
        return null;
      }
      return {
        title: ctx.t('reader.progress.pageOf', {
          current: String(page),
          total: String(ctx.pdfHandle.controller.totalPages),
        }),
        text,
      };
    }
    const chapter = ctx.dom.firstVisibleChapter();
    const source = ctx.exportChapters[chapter];
    const html = source?.html ?? '';
    const text = html !== '' ? chapterTextCached(chapter, html) : mountedChapterText(chapter).trim();
    const fallback = text === '' ? htmlToSearchText(html) : text;
    if (fallback.trim() === '') {
      // 懒加载章还没物化、正文帧也未挂好：后台物化一次，完成后让面板重新评估，
      // 不把加载时序当成「没有章节文本」。
      if (source !== undefined && source.html === '' && source.load !== undefined) {
        kickChapterLoad(chapter, source.load);
      }
      return null;
    }
    return {
      title: resolveReaderChapterTitle(ctx.readerState, ctx.readerOutline, deps.locationFallback),
      text: fallback,
    };
  };

  const currentChapter = (): AssistantChapterText | null => {
    const context = currentChapterContext();
    if (context === null) {
      return null;
    }
    if (ctx.pdfHandle !== null) {
      return { ...context, page: ctx.pdfHandle.controller.page };
    }
    return { ...context, chapter: ctx.dom.firstVisibleChapter() };
  };

  const chapterAt = async (index: number): Promise<AssistantChapterText | null> => {
    if (isComic()) {
      return null;
    }
    if (ctx.pdfHandle !== null) {
      const handle = ctx.pdfHandle;
      if (index < 1 || index > handle.controller.totalPages) {
        return null;
      }
      let text = pdfPageLayerText(index);
      if (text === '') {
        text = (await handle.pageText(index)).trim();
      }
      if (text === '') {
        return null;
      }
      return {
        title: ctx.t('reader.progress.pageOf', {
          current: String(index),
          total: String(handle.controller.totalPages),
        }),
        text,
        page: index,
      };
    }
    if (index < 0 || index >= flowChapterCount()) {
      return null;
    }
    const text = await flowChapterText(index);
    if (text === null || text === '') {
      return null;
    }
    return { title: chapterTitle(index), text, chapter: index };
  };

  const selection = (): string => {
    const pending = ctx.pendingSelection?.quote?.trim() ?? '';
    let quote = pending;
    if (quote === '') {
      for (const doc of ctx.dom.flowDocuments()) {
        const live = doc.defaultView?.getSelection()?.toString().trim() ?? '';
        if (live !== '') {
          quote = live;
          break;
        }
      }
    }
    if (quote === '' && typeof window !== 'undefined') {
      // 主文档的选区只认阅读区（PDF / 漫画文字层）里的：在助手面板或侧栏里选中的文本不是书的选区。
      const selection = window.getSelection();
      const anchor = selection?.anchorNode ?? null;
      if (selection !== null && anchor !== null && ctx.pageHost.contains(anchor)) {
        quote = selection.toString().trim();
      }
    }
    return quote.length > ASSISTANT_SELECTION_LIMIT ? quote.slice(0, ASSISTANT_SELECTION_LIMIT) : quote;
  };

  const bookInfo = (): AssistantBookInfo => {
    const pageCount =
      ctx.pdfHandle !== null
        ? ctx.pdfHandle.controller.totalPages
        : ctx.cbzHandle !== null
          ? ctx.cbzHandle.totalPages
          : null;
    return {
      title: ctx.loadedTitle,
      format: ctx.loadedExt,
      chapterCount: isPaged() ? 0 : flowChapterCount(),
      pageCount,
      // PDF 有没有可读文字取决于抽取结果：扫描件每页都是空串；一页都没抽过就是未知。
      hasText: isComic() ? false : ctx.pdfHandle !== null ? pdfTextState(ctx.pdfHandle) : flowChapterCount() > 0,
    };
  };

  const pdfTextState = (handle: PdfRenderHandle): boolean | null => {
    if (pdfPageLayerText(handle.controller.page) !== '') {
      return true;
    }
    let sawEmpty = false;
    for (let page = 1; page <= handle.controller.totalPages; page += 1) {
      const cached = handle.pageTextCached?.(page);
      if (cached === undefined) {
        continue;
      }
      if (cached.trim() !== '') {
        return true;
      }
      sawEmpty = true;
    }
    return sawEmpty ? false : null;
  };

  const search = async (query: string, limit: number): Promise<AssistantSearchResult> => {
    const needle = query.trim();
    if (needle === '' || isComic()) {
      return { hits: [], hasMore: false, partial: false };
    }
    // 两族共用同一预算：超时或视图销毁即停止并标记 partial；命中超过返回上限也停止。
    const deadline = Date.now() + ASSISTANT_SEARCH_TIME_BUDGET_MS;
    // 换书后 exportChapters 已是新书的：旧搜索必须停下，不能替新书把所有章都物化一遍。
    const generation = ctx.sessionLoad.generation();
    const overBudget = (): boolean =>
      ctx.destroyed || ctx.sessionLoad.generation() !== generation || Date.now() > deadline;
    if (ctx.pdfHandle !== null) {
      let stoppedEarly = false;
      let matches: Awaited<ReturnType<PdfRenderHandle['search']>> = [];
      try {
        matches = await ctx.pdfHandle.search(needle, {
          onProgress: (partialMatches, done) => {
            if (done) {
              return true;
            }
            if (overBudget()) {
              stoppedEarly = true;
              return false;
            }
            return partialMatches.length <= limit;
          },
        });
      } catch {
        // 文档在扫描中被关闭 / 抽取失败：按未完成上报，而不是把整个工具调用判为失败。
        stoppedEarly = true;
      }
      const hits: AssistantSearchHit[] = matches.slice(0, limit).map((match) => ({
        page: match.page,
        snippet: match.snippet,
      }));
      return { hits, hasMore: matches.length > limit, partial: stoppedEarly };
    }
    const total = flowChapterCount();
    const hits: AssistantSearchHit[] = [];
    let hasMore = false;
    let chapterCapped = false;
    let partial = false;
    for (let chapter = 0; chapter < total; chapter += 1) {
      if (overBudget()) {
        partial = true;
        break;
      }
      const text = await flowChapterText(chapter);
      if (overBudget()) {
        partial = true;
        break;
      }
      if (text === null) {
        partial = true; // 这一章没读到：结果不能声称「书里没有」
        continue;
      }
      const found = findTextHits(text, needle);
      if (found.length > ASSISTANT_SEARCH_PER_CHAPTER) {
        chapterCapped = true; // 每章上限与 max_results 无关，分开告诉模型
      }
      for (const hit of found.slice(0, ASSISTANT_SEARCH_PER_CHAPTER)) {
        if (hits.length >= limit) {
          hasMore = true;
          break;
        }
        const snippet = trimSnippetLead(snippetWithMark(text, hit.start, hit.end));
        hits.push({ chapter, title: chapterTitle(chapter), snippet: snippet.text });
      }
      if (hits.length >= limit && hasMore) {
        break;
      }
      if (chapter % 8 === 7) {
        await yieldToUi();
      }
    }
    return { hits, hasMore, partial, chapterCapped };
  };

  const anchorFor = (
    text: string,
    quote: string,
  ): { start: number; end: number; quote: string; prefix: string; suffix: string } | null => {
    const found = findQuoteIgnoringWhitespace(text, quote);
    if (found === null) {
      return null;
    }
    const { start, end } = found;
    return {
      start,
      end,
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: text.slice(end, end + ANCHOR_CONTEXT),
    };
  };

  /** 引文定位：当前选区同文优先；否则在当前章/页文本中找首个出现。 */
  const locatorForQuote = async (quote: string): Promise<Locator | null> => {
    const pending = ctx.pendingSelection;
    if (pending !== null && pending.quote.trim() === quote) {
      return pending.locator;
    }
    if (ctx.cbzHandle !== null) {
      return null;
    }
    if (ctx.pdfHandle !== null) {
      const handle = ctx.pdfHandle;
      const page = handle.controller.page;
      // 模型看到的当前页文本可能来自缓存（文字层未挂载）：定位也用同一份，否则
      // 刚回传给模型的引文会被判定找不到。层与抽取文本同为 item.str 顺序拼接，偏移一致。
      // 偏移相对未裁剪的页拼接文本（与手动划选 pdfTextLocatorFromRange 同口径），不能 trim。
      let text = pdfPageLayerRaw(page);
      if (text.trim() === '') {
        text = handle.pageTextCached?.(page) ?? (await handle.pageText(page));
      }
      const anchor = anchorFor(text, quote);
      return anchor === null ? null : { format: 'pdf', page, quote, anchor };
    }
    const chapter = ctx.dom.firstVisibleChapter();
    // 正文帧暂未挂载但已物化 HTML 时，模型看到的是物化文本：定位也用同一份原始
    // textContent（帧就是拿这段 HTML 渲染的，偏移口径一致）。
    let text = mountedChapterText(chapter);
    if (text === '') {
      text = exportedChapterRawText(chapter);
    }
    const anchor = anchorFor(text, quote);
    if (anchor === null) {
      return null;
    }
    if (ctx.loadedExt === 'txt') {
      return { format: 'text', chapter, ...anchor };
    }
    return { format: 'flow', chapter, ...anchor };
  };

  /** 正在等待用户回答的确认框：面板关闭时全部按取消收掉。 */
  const pendingConfirms = new Set<AbortController>();
  const cancelPendingSaves = (): void => {
    for (const controller of [...pendingConfirms]) {
      controller.abort();
    }
  };

  const confirm = async (title: string, message: string): Promise<boolean> => {
    const controller = new AbortController();
    pendingConfirms.add(controller);
    try {
      if (deps.confirm !== undefined) {
        const cancelled = new Promise<boolean>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(false), { once: true });
        });
        const accepted = await Promise.race([deps.confirm({ title, message }), cancelled]);
        return accepted && !controller.signal.aborted;
      }
      const choice = await showConfirmDialog(document, {
        title,
        message,
        buttons: [
          { id: 'save', label: deps.t('reader.assistant.save.confirm'), kind: 'primary' },
          { id: 'cancel', label: deps.t('dialog.cancel') },
        ],
        cancelId: 'cancel',
        themeHost: ctx.root,
        signal: controller.signal,
      });
      return choice === 'save' && !controller.signal.aborted;
    } finally {
      pendingConfirms.delete(controller);
    }
  };

  /**
   * 确认弹层里显示的内容不截断：确认框是授权边界，写进书里的每个字都要先被看见
   * （长度上限已在 save 入口钳制）。引文折叠空白便于阅读，备注保留换行。
   */
  const previewQuote = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const previewNote = (text: string): string => text.replace(/[ \t]+/g, ' ').trim();

  /**
   * 保存到当前书。确认弹层是用户的授权边界：要写入的每一项内容（引文、备注）
   * 都必须出现在预览里；模型给的字段没有长度上限，这里先钳制。
   */
  const save = async (request: AssistantSaveRequest): Promise<AssistantSaveOutcome> => {
    const kind = request.kind;
    const text = request.text?.trim() ?? '';
    const note = request.note?.trim() ?? '';
    const generation = ctx.sessionLoad.generation();
    if (text.length > ASSISTANT_SELECTION_LIMIT || note.length > ASSISTANT_SELECTION_LIMIT) {
      return { ok: false, reason: 'invalid', message: '引文或备注过长，未保存。' };
    }
    let locator: Locator;
    let quote: string | undefined;
    let message: string;
    if (kind === 'highlight') {
      if (ctx.cbzHandle !== null) {
        return { ok: false, reason: 'unsupported' };
      }
      if (note !== '') {
        // 高亮不带备注：既不会展示给用户确认，也不能静默丢掉后再报成功。
        return { ok: false, reason: 'invalid', message: '高亮不支持备注；要写备注请用 kind=note。' };
      }
      quote = text === '' ? selection().trim() : text;
      if (quote === '') {
        return { ok: false, reason: 'no-selection' };
      }
      const located = await locatorForQuote(quote);
      if (located === null) {
        return { ok: false, reason: 'quote-not-found' };
      }
      locator = located;
      message = deps.t('reader.assistant.save.highlight', { text: previewQuote(quote) });
    } else if (kind === 'note') {
      if (note === '') {
        return { ok: false, reason: 'invalid' };
      }
      if (text === '') {
        locator = ctx.annotation.currentPositionLocator();
        quote = undefined;
        message = deps.t('reader.assistant.save.note', { text: previewNote(note) });
      } else {
        // 模型明确给了引文就必须能定位；定位不到不得静默改挂到当前阅读位置。
        const located = await locatorForQuote(text);
        if (located === null) {
          return { ok: false, reason: 'quote-not-found' };
        }
        locator = located;
        quote = text;
        message = deps.t('reader.assistant.save.noteQuote', {
          quote: previewQuote(quote),
          text: previewNote(note),
        });
      }
    } else {
      locator = ctx.annotation.currentPositionLocator();
      // 当前位置已有活书签：与工具栏的书签开关同口径，不重复添加（模型会得到说明）。
      if (note === '' && ctx.bookmarks?.bookmarkAtStatePosition?.(ctx.readerState) != null) {
        return { ok: true, kind: 'bookmark', message: '该位置已有书签，未重复添加。' };
      }
      message =
        note === ''
          ? deps.t('reader.assistant.save.bookmark')
          : deps.t('reader.assistant.save.bookmarkNote', { text: previewNote(note) });
    }
    // 没有书籍身份或存储时标注只活在内存，会话结束即丢：不写入、不报成功。
    if (!ctx.sessionAnnotation.canPersist() || ctx.sessionAnnotation.contentHash() === null) {
      return { ok: false, reason: 'failed', message: '当前书没有可持久化的标注存储，未保存。' };
    }
    // 定位可能已经等过一次页文本抽取：弹确认前再核一遍书没换、面板还开着，否则确认框会
    // 弹到新页签 / 书架上面，而且 cancelPendingSaves 那时还没有可取消的对象。
    if (ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
      return { ok: false, reason: 'failed', message: '书籍已切换，未保存。' };
    }
    if (deps.isPanelOpen?.() === false) {
      return { ok: false, reason: 'rejected', message: '助手面板已关闭，未保存。' };
    }
    const accepted = await confirm(deps.t('reader.assistant.save.title'), message);
    if (!accepted) {
      return { ok: false, reason: 'rejected' };
    }
    if (deps.isPanelOpen?.() === false) {
      // 确认框还开着时面板已被关掉（换页签 / 回书架）：这次确认作废，不往后台书里写。
      return { ok: false, reason: 'rejected', message: '助手面板已关闭，未保存。' };
    }
    if (ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
      return { ok: false, reason: 'failed', message: '书籍已切换，未保存。' };
    }
    // appendAnnotation 自己排队一次写入并回传结果；这里等的就是那一次，不再另起
    // 第二次写（同一快照写两次会让成功/失败口径互相打架）。队列把写异常吞成
    // false（并经 notifySaveFailed 提示），这里不会抛。false 只可能是写失败或
    // 会话已换书：前者回滚内存里的这一条，不让用户看到一条「保存失败」却仍挂在
    // 侧栏上的标注。
    const persisted = await ctx.annotation.appendAnnotationPersisted(
      kind,
      locator,
      quote,
      note === '' ? undefined : note,
    );
    if (ctx.destroyed || generation !== ctx.sessionLoad.generation()) {
      // 写入可能已经落到上一本书的文件里，也可能被作废：不能断言「未保存」。
      return { ok: false, reason: 'failed', message: '书籍已切换，这条标注的落盘结果未知。' };
    }
    if (!persisted) {
      return { ok: false, reason: 'failed', message: '标注写入磁盘失败，已撤回。' };
    }
    return { ok: true, kind };
  };

  /** 定位跳转前校验：模型可能编造越界的章索引/页码，越界一律不跳（分栏模式下越界会清空活动章）。 */
  const locate = (target: AssistantLocateTarget): void => {
    if (target.kind === 'chapter') {
      if (isPaged() || target.index < 0 || target.index >= flowChapterCount()) {
        return;
      }
      ctx.jumpToOutlineItem({ level: 1, text: '', anchor: 0, chapter: target.index });
      return;
    }
    const pageCount =
      ctx.pdfHandle !== null
        ? ctx.pdfHandle.controller.totalPages
        : ctx.cbzHandle !== null
          ? ctx.cbzHandle.totalPages
          : 0;
    if (target.page < 1 || target.page > pageCount) {
      return;
    }
    ctx.jumpToOutlineItem({ level: 1, text: '', anchor: 0, page: target.page });
  };

  return {
    bookInfo,
    outline: outlineEntries,
    currentChapter,
    chapterAt,
    selection,
    search,
    save,
    currentChapterContext,
    locate,
    cancelPendingSaves,
  };
}
