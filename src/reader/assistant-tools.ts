/**
 * `assistant-tools` — 助手内置工具（R6 / R7 / R10）：定义、执行与上限。
 *
 * 模型只能看到两个工具，用参数区分动作，不按功能拆分：
 * - `query_book` 查询当前书：目录 / 当前章 / 指定章（序号或标题）/ 当前选区 /
 *   书籍信息 / 书内关键词搜索。目录不含正文；搜索只返回定位 + 短摘录；指定章
 *   才返回正文（超长按既有上限截断）。截断、「还有更多」、找不到、标题歧义都
 *   写在结果里。查询不改变阅读位置，不弹确认。
 * - `save_to_book` 保存到当前书：`kind` = highlight | bookmark | note（与阅读器
 *   标注种类相同）。必须确认；拒绝则不写入并回传已拒绝。
 *
 * 结果统一为 JSON 文本（语言中立、机器可读）；定位用 `lightink://chapter/<index>`
 * 或 `lightink://page/<n>` 链接，模型在回答里引用后由用户点击跳转（工具本身
 * 不翻页，R10）。上限：同一问指定章最多 12 次（按不同章计）、工具往返最多
 * 24 轮（面板循环执行）。没有第三个工具，也不外接 MCP（R7）。
 */

import { READER_LIMITS } from './reader-limits.js';
import type { AssistantToolCall, AssistantToolResult } from './assistant-history.js';
import type { AiToolDefView } from './assistant-request.js';
import { clipAssistantContext, clipToBytes } from './assistant-request.js';

export const ASSISTANT_TOOL_QUERY = 'query_book';
export const ASSISTANT_TOOL_SAVE = 'save_to_book';

/** 同一条用户发送内允许读取的不同章数上限。 */
export const ASSISTANT_MAX_CHAPTER_READS = 12;
/** 同一条用户发送内工具往返上限。 */
export const ASSISTANT_MAX_TOOL_ROUNDS = 24;
/** 单次模型回复内最多执行的工具调用数；超出的调用直接回错误结果。 */
export const ASSISTANT_MAX_TOOL_CALLS_PER_TURN = 4;
/** 搜索默认 / 最大返回命中数。 */
export const ASSISTANT_SEARCH_DEFAULT_LIMIT = 20;
export const ASSISTANT_SEARCH_MAX_LIMIT = 50;
/** 目录条目上限（超出截断并标记）。 */
export const ASSISTANT_OUTLINE_LIMIT = 300;
/** 选区 / 引文回传字符上限。 */
export const ASSISTANT_SELECTION_LIMIT = 5000;
/** 书内搜索每章最多返回的命中数（与 max_results 无关）。 */
export const ASSISTANT_SEARCH_PER_CHAPTER = 5;
/** 书内搜索 query 的字符上限；超出只搜前部并在结果里说明。 */
export const ASSISTANT_SEARCH_QUERY_LIMIT = 200;
/** 单次 chapter 工具回传正文的字节上限（12 章合计仍在 Rust 512 KiB 请求上限之下）。 */
export const ASSISTANT_TOOL_CHAPTER_BYTES = 36 * 1024;

export type AssistantQueryAction =
  | 'outline'
  | 'current_chapter'
  | 'chapter'
  | 'selection'
  | 'book_info'
  | 'search';

export type AssistantSaveKind = 'highlight' | 'bookmark' | 'note';

/** 内置工具清单（集合固定、顺序稳定；每次请求作为可缓存前缀 ①）。 */
export const ASSISTANT_TOOLS: readonly AiToolDefView[] = Object.freeze([
  Object.freeze({
    name: ASSISTANT_TOOL_QUERY,
    description:
      '查询当前正在阅读的这本书。action=outline 取目录（不含正文）；current_chapter 取当前章全文；chapter 按 chapter_index（0 起）或 chapter_title 取指定章全文；selection 取用户当前选中的文本；book_info 取书名/格式/章数；search 按 query 在全书做关键词搜索，只返回定位与短摘录。指定章正文超长会被截断并标记 truncated；找不到或标题歧义会在结果里说明。查询不会改变阅读位置。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['outline', 'current_chapter', 'chapter', 'selection', 'book_info', 'search'],
          description: '要执行的查询动作',
        },
        chapter_index: {
          type: 'integer',
          minimum: 0,
          description: 'action=chapter 时的章序号（0 起；PDF 为 1 起的页码）',
        },
        chapter_title: {
          type: 'string',
          description: 'action=chapter 时按标题查找（与 chapter_index 二选一）',
        },
        query: {
          type: 'string',
          description: 'action=search 时的关键词（区分大小写不敏感）',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'action=search 时最多返回的命中数（默认 20）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: ASSISTANT_TOOL_SAVE,
    description:
      '把内容保存到当前书的标注体系，需要用户确认。kind=highlight 高亮（需要 text 引文或用户当前选区）；kind=bookmark 在当前阅读位置加书签（可附 note）；kind=note 在当前阅读位置或引文处写笔记（text 为引文可选，note 为笔记正文）。用户拒绝时返回 rejected，不会写入。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['highlight', 'bookmark', 'note'],
          description: '标注种类',
        },
        text: {
          type: 'string',
          description: '引文（高亮必填或使用当前选区；笔记可选，用于定位）',
        },
        note: {
          type: 'string',
          description: '笔记正文（kind=note 必填；bookmark 可选备注）',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    }),
  }),
]);

// ── 宿主供数接口 ─────────────────────────────────────────────────────

export interface AssistantOutlineEntry {
  readonly title: string;
  /** flow 族章索引（0 起）。 */
  readonly chapter?: number;
  /** 页式格式页码（1 起）。 */
  readonly page?: number;
}

export interface AssistantChapterText {
  readonly title: string;
  readonly text: string;
  readonly chapter?: number;
  readonly page?: number;
}

export interface AssistantSearchHit {
  readonly chapter?: number;
  readonly page?: number;
  readonly title?: string;
  readonly snippet: string;
}

export interface AssistantSearchResult {
  readonly hits: readonly AssistantSearchHit[];
  /** 命中超过返回上限。 */
  readonly hasMore: boolean;
  /** 有章节命中数超过每章返回上限（与 hasMore 分开：提高 max_results 解决不了它）。 */
  readonly chapterCapped?: boolean;
  /** 扫描因时间预算未完成。 */
  readonly partial: boolean;
}

export interface AssistantBookInfo {
  readonly title: string;
  readonly format: string;
  readonly chapterCount: number;
  readonly pageCount: number | null;
  /** 是否有可读文字；PDF 在抽取过页文本之前为 null（未知）。 */
  readonly hasText: boolean | null;
}

export interface AssistantSaveRequest {
  readonly kind: AssistantSaveKind;
  readonly text?: string;
  readonly note?: string;
}

export type AssistantSaveOutcome =
  | { readonly ok: true; readonly kind: AssistantSaveKind; readonly message?: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'rejected'
        | 'no-selection'
        | 'quote-not-found'
        | 'unsupported'
        | 'invalid'
        | 'failed';
      readonly message?: string;
    };

/** 宿主（阅读器视图）为工具供数；所有方法不得改变阅读位置（save 除外，且需确认）。 */
export interface AssistantBookAccess {
  bookInfo(): AssistantBookInfo;
  outline(): readonly AssistantOutlineEntry[];
  currentChapter(): AssistantChapterText | null;
  /** 指定章（flow 按章索引；PDF 按页码）；越界/不可用返回 null。 */
  chapterAt(index: number): Promise<AssistantChapterText | null>;
  selection(): string;
  search(query: string, limit: number): Promise<AssistantSearchResult>;
  save(request: AssistantSaveRequest): Promise<AssistantSaveOutcome>;
  /** 面板关闭 / 销毁时收掉正在等待的保存确认（可选：测试桩可不实现）。 */
  cancelPendingSaves?(): void;
}

// ── 定位链接 ─────────────────────────────────────────────────────────

export type AssistantLocateTarget =
  | { readonly kind: 'chapter'; readonly index: number }
  | { readonly kind: 'page'; readonly page: number };

export function assistantLocateHref(target: AssistantLocateTarget): string {
  return target.kind === 'chapter'
    ? `lightink://chapter/${target.index}`
    : `lightink://page/${target.page}`;
}

/** 解析回答中的定位链接；不是定位链接返回 null。 */
export function parseAssistantLocate(href: string): AssistantLocateTarget | null {
  const match = /^lightink:\/\/(chapter|page)\/(\d{1,7})\/?$/i.exec(href.trim());
  if (match === null) {
    return null;
  }
  const value = Number(match[2]);
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  if (match[1]!.toLowerCase() === 'chapter') {
    return { kind: 'chapter', index: value };
  }
  return value >= 1 ? { kind: 'page', page: value } : null;
}

function locateOf(entry: { readonly chapter?: number; readonly page?: number }): string | null {
  if (entry.chapter !== undefined) {
    return assistantLocateHref({ kind: 'chapter', index: entry.chapter });
  }
  if (entry.page !== undefined) {
    return assistantLocateHref({ kind: 'page', page: entry.page });
  }
  return null;
}

// ── 执行 ─────────────────────────────────────────────────────────────

/** 单次用户发送内的工具预算（面板每问新建）。 */
export interface AssistantToolBudget {
  /** 已读取的不同章（chapter_index / 页码）。 */
  readonly chaptersRead: Set<number>;
  rounds: number;
}

export function createAssistantToolBudget(): AssistantToolBudget {
  return { chaptersRead: new Set<number>(), rounds: 0 };
}

function resultOf(call: AssistantToolCall, payload: unknown, isError = false): AssistantToolResult {
  return {
    callId: call.id,
    name: call.name,
    content: JSON.stringify(payload),
    isError,
  };
}

function errorResult(call: AssistantToolCall, error: string): AssistantToolResult {
  return resultOf(call, { error }, true);
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function intArg(args: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function chapterPayload(
  chapter: AssistantChapterText,
  limit: number,
): Record<string, unknown> {
  // 字符上限之外再按字节封顶：中文三字节/字，几章下来就会撞 Rust 的请求体上限。
  const byChars = clipAssistantContext(chapter.text, limit);
  const byBytes = clipToBytes(byChars.text, ASSISTANT_TOOL_CHAPTER_BYTES);
  const clip = { text: byBytes.text, truncated: byChars.truncated || byBytes.truncated };
  return {
    title: chapter.title,
    ...(chapter.chapter !== undefined ? { chapterIndex: chapter.chapter } : {}),
    ...(chapter.page !== undefined ? { page: chapter.page } : {}),
    locate: locateOf(chapter),
    text: clip.text,
    truncated: clip.truncated,
    ...(clip.truncated
      ? { note: `正文超过 ${limit} 字符上限，只返回前部；如需后文请说明无法读取全文。` }
      : {}),
  };
}

/** 标题匹配：精确（忽略大小写/空白）优先，其次包含匹配。 */
export function matchOutlineTitle(
  outline: readonly AssistantOutlineEntry[],
  title: string,
): AssistantOutlineEntry[] {
  const normalize = (value: string): string => value.replace(/\s+/g, '').toLowerCase();
  const needle = normalize(title);
  if (needle === '') {
    return [];
  }
  const exact = outline.filter((entry) => normalize(entry.title) === needle);
  if (exact.length > 0) {
    return exact;
  }
  return outline.filter((entry) => normalize(entry.title).includes(needle));
}

async function runQuery(
  call: AssistantToolCall,
  access: AssistantBookAccess,
  budget: AssistantToolBudget,
  limit: number,
): Promise<AssistantToolResult> {
  const args = call.arguments;
  const action = stringArg(args, 'action');
  switch (action) {
    case 'outline': {
      const outline = access.outline();
      const items = outline.slice(0, ASSISTANT_OUTLINE_LIMIT).map((entry) => ({
        title: entry.title,
        ...(entry.chapter !== undefined ? { chapterIndex: entry.chapter } : {}),
        ...(entry.page !== undefined ? { page: entry.page } : {}),
        locate: locateOf(entry),
      }));
      const truncated = outline.length > items.length;
      return resultOf(call, {
        action,
        total: outline.length,
        items,
        truncated,
        ...(truncated
          ? { note: `目录共 ${outline.length} 条，只返回前 ${items.length} 条。` }
          : {}),
        ...(outline.length === 0 ? { note: '这本书没有可用的目录。' } : {}),
      });
    }
    case 'current_chapter': {
      const chapter = access.currentChapter();
      if (chapter === null || chapter.text.trim() === '') {
        return resultOf(call, { action, empty: true, note: '当前格式没有可用的章节文本。' });
      }
      return resultOf(call, { action, ...chapterPayload(chapter, limit) });
    }
    case 'chapter': {
      const index = intArg(args, 'chapter_index');
      const title = stringArg(args, 'chapter_title');
      let target = index;
      if (target === null && title !== null) {
        const matches = matchOutlineTitle(access.outline(), title);
        if (matches.length === 0) {
          return resultOf(call, { action, notFound: true, title, note: '目录中没有这个标题。' });
        }
        if (matches.length > 1) {
          return resultOf(call, {
            action,
            ambiguous: true,
            title,
            candidates: matches.slice(0, 20).map((entry) => ({
              title: entry.title,
              ...(entry.chapter !== undefined ? { chapterIndex: entry.chapter } : {}),
              ...(entry.page !== undefined ? { page: entry.page } : {}),
            })),
            note: '标题匹配到多章，请用 chapter_index 或页码指定。',
          });
        }
        target = matches[0]!.chapter ?? matches[0]!.page ?? null;
      }
      if (target === null) {
        return errorResult(call, 'action=chapter 需要 chapter_index 或 chapter_title。');
      }
      if (
        !budget.chaptersRead.has(target) &&
        budget.chaptersRead.size >= ASSISTANT_MAX_CHAPTER_READS
      ) {
        return errorResult(
          call,
          `已达到单次提问的章节读取上限（${ASSISTANT_MAX_CHAPTER_READS} 章），请基于已取得的内容回答。`,
        );
      }
      const chapter = await access.chapterAt(target);
      if (chapter === null) {
        return resultOf(call, {
          action,
          notFound: true,
          chapterIndex: target,
          note: '没有这个章节或该格式没有章节文本。',
        });
      }
      budget.chaptersRead.add(target);
      return resultOf(call, { action, ...chapterPayload(chapter, limit) });
    }
    case 'selection': {
      const selection = access.selection().trim();
      if (selection === '') {
        return resultOf(call, { action, empty: true, note: '用户当前没有选中文本。' });
      }
      const clip = clipAssistantContext(selection, ASSISTANT_SELECTION_LIMIT);
      return resultOf(call, { action, text: clip.text, truncated: clip.truncated });
    }
    case 'book_info': {
      const info = access.bookInfo();
      return resultOf(call, {
        action,
        ...info,
        ...(info.hasText === null
          ? { note: '尚未抽取过任何页文本，暂不能判断这本书有没有可读文字；可先调用 current_chapter 或 search。' }
          : info.hasText === false && info.pageCount !== null
            ? { note: '这本文档没有可抽取的文字（扫描件 / 纯图片）；搜索与取文不会有结果，未命中不代表书中没有。' }
            : {}),
      });
    }
    case 'search': {
      const query = stringArg(args, 'query');
      if (query === null) {
        return errorResult(call, 'action=search 需要非空 query。');
      }
      const requested = intArg(args, 'max_results');
      const limitHits = Math.min(
        ASSISTANT_SEARCH_MAX_LIMIT,
        Math.max(1, requested ?? ASSISTANT_SEARCH_DEFAULT_LIMIT),
      );
      // 只搜前 200 字符：回传的也是这一份，并明确说明截断，模型不会以为整句都搜过了。
      const searched = query.slice(0, ASSISTANT_SEARCH_QUERY_LIMIT);
      const queryTruncated = searched.length < query.length;
      const result = await access.search(searched, limitHits);
      const hits = result.hits.slice(0, limitHits).map((hit) => ({
        ...(hit.chapter !== undefined ? { chapterIndex: hit.chapter } : {}),
        ...(hit.page !== undefined ? { page: hit.page } : {}),
        ...(hit.title !== undefined && hit.title !== '' ? { title: hit.title } : {}),
        snippet: hit.snippet,
        locate: locateOf(hit),
      }));
      const hasMore = result.hasMore || result.hits.length > hits.length;
      // 说明互斥：扫描未完成时不能断言「没找到」；每章上限与 max_results 无关，分开说。
      const scanNote = result.partial
        ? '扫描未完成（时间预算），结果可能不全；未命中不代表书中没有。'
        : hits.length === 0
          ? '没有找到匹配的文本。'
          : hasMore
            ? '还有更多命中未返回；可缩小关键词或提高 max_results。'
            : result.chapterCapped === true
              ? `部分章节命中较多，每章只返回前 ${ASSISTANT_SEARCH_PER_CHAPTER} 条；缩小关键词可看到更多。`
              : '';
      const note = [
        queryTruncated ? `query 超过 ${ASSISTANT_SEARCH_QUERY_LIMIT} 字符，只搜索了前 ${ASSISTANT_SEARCH_QUERY_LIMIT} 字符。` : '',
        scanNote,
      ]
        .filter((part) => part !== '')
        .join(' ');
      return resultOf(call, {
        action,
        query: searched,
        ...(queryTruncated ? { queryTruncated: true } : {}),
        count: hits.length,
        hits,
        hasMore,
        partial: result.partial,
        ...(note !== '' ? { note } : {}),
      });
    }
    default:
      return errorResult(
        call,
        'action 必须是 outline / current_chapter / chapter / selection / book_info / search 之一。',
      );
  }
}

async function runSave(
  call: AssistantToolCall,
  access: AssistantBookAccess,
): Promise<AssistantToolResult> {
  const args = call.arguments;
  const kind = stringArg(args, 'kind');
  if (kind !== 'highlight' && kind !== 'bookmark' && kind !== 'note') {
    return errorResult(call, 'kind 必须是 highlight / bookmark / note 之一。');
  }
  const text = stringArg(args, 'text') ?? undefined;
  const note = stringArg(args, 'note') ?? undefined;
  if (kind === 'note' && note === undefined) {
    return errorResult(call, 'kind=note 需要 note 正文。');
  }
  let outcome: AssistantSaveOutcome;
  try {
    outcome = await access.save({ kind, text, note });
  } catch {
    outcome = { ok: false, reason: 'failed' };
  }
  if (outcome.ok) {
    return resultOf(call, { kind, saved: true, note: outcome.message ?? '已写入当前书的标注列表。' });
  }
  const notes: Record<string, string> = {
    rejected: '用户拒绝了这次保存，没有写入。',
    'no-selection': '没有可用的选区或引文，高亮无法保存。',
    'quote-not-found': '引文不在当前可见的章节/页面文本中，无法定位。',
    unsupported: '当前格式不支持这种标注。',
    invalid: '保存参数无效。',
    failed: '保存失败。',
  };
  return resultOf(
    call,
    {
      kind,
      saved: false,
      reason: outcome.reason,
      note: outcome.message ?? notes[outcome.reason],
    },
    outcome.reason !== 'rejected',
  );
}

/**
 * 执行一次工具调用；无论成功、失败、拒绝、超限都回传结果（模型每轮调用都必须
 * 得到结果）。未知工具名回传错误，不外接任何服务器。
 */
export async function executeAssistantTool(
  call: AssistantToolCall,
  access: AssistantBookAccess,
  budget: AssistantToolBudget,
  limit: number = READER_LIMITS.maxAssistantContextChars,
): Promise<AssistantToolResult> {
  try {
    if (call.name === ASSISTANT_TOOL_QUERY) {
      return await runQuery(call, access, budget, limit);
    }
    if (call.name === ASSISTANT_TOOL_SAVE) {
      return await runSave(call, access);
    }
    return errorResult(call, `未知工具：${call.name}。只有 query_book 与 save_to_book 可用。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(call, `工具执行失败：${message}`);
  }
}

/** 工具块展示用的参数摘要（不含长文本）。 */
export function describeAssistantToolCall(call: AssistantToolCall): string {
  const args = call.arguments;
  if (call.name === ASSISTANT_TOOL_QUERY) {
    const action = stringArg(args, 'action') ?? '?';
    const detail =
      stringArg(args, 'query') ??
      stringArg(args, 'chapter_title') ??
      (intArg(args, 'chapter_index') !== null ? `#${intArg(args, 'chapter_index')}` : null);
    return detail === null ? action : `${action} · ${detail}`;
  }
  if (call.name === ASSISTANT_TOOL_SAVE) {
    return stringArg(args, 'kind') ?? '?';
  }
  return call.name;
}
