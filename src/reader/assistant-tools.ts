/**
 * `assistant-tools` — 阅读器助手两个内置工具（ADR-3 / R6）。
 *
 * 模型只声明 query_book 与 save_to_book。查询接 outline / 章文本 / 搜索
 * run+hitViews，不调用 activateKey、不改阅读位置。指定章正文计入每问 12
 * 次上限。保存经 confirm 后走 appendAnnotation；拒绝不写盘。
 */

import type { OutlineItem } from '../outline/outline-model.js';
import type { AnnotationKind, Locator } from './annotations.js';
import { READER_LIMITS } from './reader-limits.js';
import { SEARCH_HIT_CAP } from './search-panel.js';

export const QUERY_BOOK_TOOL_NAME = 'query_book';
export const SAVE_TO_BOOK_TOOL_NAME = 'save_to_book';

/** 同一条用户发送内，成功返回指定章正文的次数上限。 */
export const ASSISTANT_MAX_SPECIFIED_CHAPTERS = 12;

export type QueryBookAction =
  | 'toc'
  | 'current_chapter'
  | 'chapter'
  | 'selection'
  | 'book_info'
  | 'search';

export type AssistantToolName = typeof QUERY_BOOK_TOOL_NAME | typeof SAVE_TO_BOOK_TOOL_NAME;

export interface AssistantToolDefinition {
  readonly type: 'function';
  readonly name: AssistantToolName;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export interface AssistantChapterTarget {
  readonly chapter?: number;
  readonly page?: number;
  readonly title?: string;
}

export interface AssistantChapterBody {
  readonly text: string;
  readonly title?: string;
  readonly reason?: string;
  readonly chapter?: number;
  readonly page?: number;
}

export interface AssistantSearchHitInput {
  readonly snippet: string;
  readonly location: string;
  readonly key?: string;
  readonly payload?: {
    readonly kind: 'pdf' | 'flow';
    readonly page?: number;
    readonly chapter?: number;
    readonly start?: number;
    readonly end?: number;
  };
}

/** 搜索会话的只读入口：只用 run / hitViews / hitsState，禁止 activateKey。 */
export interface AssistantToolSearch {
  run(query: string): void | Promise<void>;
  hitViews(): readonly AssistantSearchHitInput[];
  hitsState(): { readonly hasMore: boolean };
}

export interface AssistantSearchHitView {
  readonly snippet: string;
  readonly location: string;
  readonly key?: string;
  readonly chapter?: number;
  readonly page?: number;
}

export interface AssistantToolSelection {
  readonly quote: string;
  readonly locator?: Locator;
}

export interface AssistantBookInfo {
  readonly title?: string;
  readonly author?: string;
}

export interface AssistantSaveConfirmRequest {
  readonly kind: AnnotationKind;
  readonly quote?: string;
  readonly note?: string;
}

export interface AssistantToolDeps {
  readonly outline: () => readonly OutlineItem[];
  readonly currentChapter: () => AssistantChapterBody | null;
  readonly chapterText: (
    target: AssistantChapterTarget,
  ) => AssistantChapterBody | Promise<AssistantChapterBody>;
  readonly search: AssistantToolSearch;
  readonly selection: () => AssistantToolSelection | null;
  readonly bookInfo: () => AssistantBookInfo;
  readonly currentLocator: () => Locator;
  readonly appendAnnotation: (
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
  ) => void;
  readonly confirm: (request: AssistantSaveConfirmRequest) => Promise<boolean>;
}

export interface AssistantTocItem {
  readonly level: number;
  readonly text: string;
  readonly chapter?: number;
  readonly page?: number;
}

export interface AssistantToolResult {
  readonly ok: boolean;
  readonly tool?: string;
  readonly action?: QueryBookAction | string;
  readonly kind?: AnnotationKind;
  readonly truncated?: boolean;
  readonly has_more?: boolean;
  readonly text?: string;
  readonly title?: string;
  readonly author?: string;
  readonly quote?: string;
  readonly note?: string;
  readonly items?: readonly AssistantTocItem[];
  readonly hits?: readonly AssistantSearchHitView[];
  readonly candidates?: readonly AssistantTocItem[];
  readonly chapter?: number;
  readonly page?: number;
  readonly saved?: boolean;
  readonly rejected?: boolean;
  readonly error?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly limit?: number;
}

export interface AssistantToolSession {
  readonly tools: readonly AssistantToolDefinition[];
  specifiedChapterCount(): number;
  execute(name: string, args?: unknown): Promise<AssistantToolResult>;
}

const QUERY_BOOK_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: QUERY_BOOK_TOOL_NAME,
  description:
    '查询当前打开的书。action 为 toc（目录，不含正文）、current_chapter（当前章）、chapter（指定章正文，序号或标题）、selection（当前选区）、book_info（书名作者）、search（书内关键词，只返回摘录与定位，不翻页）。截断、还有更多、找不到或标题歧义会写在结果里。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['toc', 'current_chapter', 'chapter', 'selection', 'book_info', 'search'],
        description: '查询动作',
      },
      query: {
        type: 'string',
        description: 'search 的关键词；chapter 时为 0-based 序号或标题',
      },
      chapter: {
        description: '指定章：0-based 序号或标题',
        oneOf: [{ type: 'integer' }, { type: 'string' }],
      },
      title: {
        type: 'string',
        description: '按标题取章（与 chapter 字符串等价）',
      },
      index: {
        type: 'integer',
        description: '指定章 0-based 序号',
      },
      page: {
        type: 'integer',
        description: 'PDF 页码（1-based）',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

const SAVE_TO_BOOK_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: SAVE_TO_BOOK_TOOL_NAME,
  description:
    '保存到当前书的标注。kind 为 highlight、bookmark 或 note（与阅读器标注种类相同）。高亮必须有选区或引文。写入前需用户确认；拒绝则不保存。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['highlight', 'bookmark', 'note'],
        description: '标注种类',
      },
      quote: {
        type: 'string',
        description: '引文；高亮在无选区时必须提供',
      },
      note: {
        type: 'string',
        description: '笔记正文',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/** 模型可见工具清单：仅此两项，顺序固定为查询当前书、保存到当前书。 */
export const ASSISTANT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = Object.freeze([
  QUERY_BOOK_DEFINITION,
  SAVE_TO_BOOK_DEFINITION,
]);

const QUERY_ACTIONS: ReadonlySet<QueryBookAction> = new Set([
  'toc',
  'current_chapter',
  'chapter',
  'selection',
  'book_info',
  'search',
]);

const SAVE_KINDS: ReadonlySet<AnnotationKind> = new Set(['highlight', 'bookmark', 'note']);

function clipToolText(text: string): { text: string; truncated: boolean } {
  const clean = text.trim();
  const limit = READER_LIMITS.maxAssistantContextChars;
  if (clean.length <= limit) {
    return { text: clean, truncated: false };
  }
  let cut = clean.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readIndex(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
}

function parseArgs(value: unknown): Record<string, unknown> | { error: 'invalid_args' } {
  if (value === undefined || value === null) {
    return {};
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return {};
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { error: 'invalid_args' };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'invalid_args' };
  }
  return parsed as Record<string, unknown>;
}

function tocItem(item: OutlineItem): AssistantTocItem {
  return {
    level: item.level,
    text: item.text,
    ...(item.chapter !== undefined ? { chapter: item.chapter } : {}),
    ...(item.page !== undefined ? { page: item.page } : {}),
  };
}

function matchOutlineTitle(outline: readonly OutlineItem[], title: string): OutlineItem[] {
  const needle = title.trim().toLowerCase();
  if (needle === '') {
    return [];
  }
  const exact = outline.filter((item) => item.text.trim().toLowerCase() === needle);
  if (exact.length > 0) {
    return exact;
  }
  return outline.filter((item) => item.text.trim().toLowerCase().includes(needle));
}

function outlineTarget(item: OutlineItem): AssistantChapterTarget {
  return {
    ...(item.chapter !== undefined ? { chapter: item.chapter } : {}),
    ...(item.page !== undefined ? { page: item.page } : {}),
    title: item.text,
  };
}

function fail(
  tool: string,
  error: string,
  extra: Omit<AssistantToolResult, 'ok' | 'tool' | 'error'> = {},
): AssistantToolResult {
  return { ok: false, tool, error, ...extra };
}

function mapSearchHit(hit: AssistantSearchHitInput): AssistantSearchHitView {
  const view: {
    snippet: string;
    location: string;
    key?: string;
    chapter?: number;
    page?: number;
  } = {
    snippet: hit.snippet,
    location: hit.location,
  };
  if (hit.key !== undefined) {
    view.key = hit.key;
  }
  const payload = hit.payload;
  if (payload?.kind === 'pdf' && payload.page !== undefined) {
    view.page = payload.page;
  } else if (payload?.kind === 'flow' && payload.chapter !== undefined) {
    view.chapter = payload.chapter;
  }
  return view;
}

/**
 * 执行书内搜索：只调用 run + hitViews（及 hitsState），首页按 SEARCH_HIT_CAP
 * 封顶。空查询不扫描。不得调用 activateKey。
 */
export async function collectAssistantSearchHits(
  search: AssistantToolSearch,
  query: string,
): Promise<{ hits: AssistantSearchHitView[]; has_more: boolean; reason?: string }> {
  const needle = query.trim();
  if (needle === '') {
    return { hits: [], has_more: false, reason: 'empty_query' };
  }
  await search.run(needle);
  const views = search.hitViews();
  const capped = views.slice(0, SEARCH_HIT_CAP).map(mapSearchHit);
  return {
    hits: capped,
    has_more: search.hitsState().hasMore || views.length > SEARCH_HIT_CAP,
  };
}

function resolveSpecifiedChapter(
  args: Record<string, unknown>,
  outline: readonly OutlineItem[],
):
  | { ok: true; target: AssistantChapterTarget }
  | { ok: false; error: 'missing_chapter' | 'not_found' | 'ambiguous_title'; candidates?: AssistantTocItem[] } {
  const titleArg = readString(args.title)?.trim();
  const chapterArg = args.chapter;
  const page = readIndex(args.page);
  const index = readIndex(args.index);

  let title = titleArg;
  let chapter = index ?? (typeof chapterArg === 'string' ? undefined : readIndex(chapterArg));
  if (typeof chapterArg === 'string') {
    const trimmed = chapterArg.trim();
    if (trimmed !== '') {
      const numeric = readIndex(trimmed);
      if (numeric !== undefined && /^-?\d+(\.0+)?$/.test(trimmed)) {
        chapter = numeric;
      } else {
        title = trimmed;
      }
    }
  }

  // Live schema sends { action: "chapter", query } with no chapter/title/index.
  if ((title === undefined || title === '') && chapter === undefined) {
    const query = readString(args.query)?.trim();
    if (query !== undefined && query !== '') {
      const numeric = readIndex(query);
      if (numeric !== undefined && /^-?\d+(\.0+)?$/.test(query)) {
        chapter = numeric;
      } else {
        title = query;
      }
    }
  }

  if (title !== undefined && title !== '') {
    const matches = matchOutlineTitle(outline, title);
    if (matches.length === 0) {
      return { ok: false, error: 'not_found' };
    }
    if (matches.length > 1) {
      return { ok: false, error: 'ambiguous_title', candidates: matches.map(tocItem) };
    }
    return { ok: true, target: outlineTarget(matches[0]!) };
  }

  if (chapter === undefined && page === undefined) {
    return { ok: false, error: 'missing_chapter' };
  }

  if (chapter !== undefined) {
    const byChapter = outline.filter((item) => item.chapter === chapter);
    if (byChapter.length === 1) {
      return { ok: true, target: outlineTarget(byChapter[0]!) };
    }
    if (byChapter.length > 1) {
      return { ok: false, error: 'ambiguous_title', candidates: byChapter.map(tocItem) };
    }
  }
  if (page !== undefined) {
    const byPage = outline.filter((item) => item.page === page);
    if (byPage.length === 1 && chapter === undefined) {
      return { ok: true, target: outlineTarget(byPage[0]!) };
    }
  }

  return {
    ok: true,
    target: {
      ...(chapter !== undefined ? { chapter } : {}),
      ...(page !== undefined ? { page } : {}),
    },
  };
}

function chapterResult(
  action: QueryBookAction,
  body: AssistantChapterBody,
): AssistantToolResult {
  const clipped = clipToolText(body.text);
  const empty = clipped.text === '';
  return {
    ok: true,
    tool: QUERY_BOOK_TOOL_NAME,
    action,
    text: clipped.text,
    truncated: clipped.truncated,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.chapter !== undefined ? { chapter: body.chapter } : {}),
    ...(body.page !== undefined ? { page: body.page } : {}),
    ...(empty && body.reason !== undefined ? { reason: body.reason } : {}),
    ...(empty && body.reason === undefined ? { reason: 'no_text' } : {}),
  };
}

async function executeQueryBook(
  deps: AssistantToolDeps,
  args: Record<string, unknown>,
  chapterReads: { count: number },
): Promise<AssistantToolResult> {
  const actionRaw = readString(args.action);
  const action: QueryBookAction | undefined =
    actionRaw !== undefined && QUERY_ACTIONS.has(actionRaw as QueryBookAction)
      ? (actionRaw as QueryBookAction)
      : undefined;
  if (action === undefined) {
    return fail(QUERY_BOOK_TOOL_NAME, 'invalid_action', {
      message: 'action 必须是 toc、current_chapter、chapter、selection、book_info 或 search。',
    });
  }

  if (action === 'toc') {
    return {
      ok: true,
      tool: QUERY_BOOK_TOOL_NAME,
      action,
      items: deps.outline().map(tocItem),
    };
  }

  if (action === 'book_info') {
    const info = deps.bookInfo();
    return {
      ok: true,
      tool: QUERY_BOOK_TOOL_NAME,
      action,
      title: info.title ?? '',
      author: info.author ?? '',
    };
  }

  if (action === 'selection') {
    const selected = deps.selection();
    const quote = selected?.quote.trim() ?? '';
    return {
      ok: true,
      tool: QUERY_BOOK_TOOL_NAME,
      action,
      quote,
      ...(quote === '' ? { reason: 'no_selection' } : {}),
    };
  }

  if (action === 'search') {
    const query = readString(args.query) ?? readString(args.keyword) ?? '';
    const collected = await collectAssistantSearchHits(deps.search, query);
    return {
      ok: true,
      tool: QUERY_BOOK_TOOL_NAME,
      action,
      hits: collected.hits,
      has_more: collected.has_more,
      ...(collected.reason !== undefined ? { reason: collected.reason } : {}),
    };
  }

  if (action === 'current_chapter') {
    const current = deps.currentChapter();
    if (current === null) {
      return {
        ok: true,
        tool: QUERY_BOOK_TOOL_NAME,
        action,
        text: '',
        truncated: false,
        reason: 'no_text',
      };
    }
    return chapterResult(action, current);
  }

  const resolved = resolveSpecifiedChapter(args, deps.outline());
  if (!resolved.ok) {
    const messages: Record<typeof resolved.error, string> = {
      missing_chapter: '指定章需要序号或标题。',
      not_found: '找不到该章节。',
      ambiguous_title: '标题对应多章，请改用序号或更精确的标题。',
    };
    return fail(QUERY_BOOK_TOOL_NAME, resolved.error, {
      action,
      message: messages[resolved.error],
      ...(resolved.candidates !== undefined ? { candidates: resolved.candidates } : {}),
    });
  }

  if (chapterReads.count >= ASSISTANT_MAX_SPECIFIED_CHAPTERS) {
    return fail(QUERY_BOOK_TOOL_NAME, 'chapter_limit', {
      action,
      limit: ASSISTANT_MAX_SPECIFIED_CHAPTERS,
      message: `同一问最多读取 ${ASSISTANT_MAX_SPECIFIED_CHAPTERS} 章正文。`,
    });
  }

  // 在 await 前占位，避免同轮并行 query_book.chapter 冲破 12 次上限。
  chapterReads.count += 1;
  const body = await deps.chapterText(resolved.target);
  const clipped = clipToolText(body.text);
  if (clipped.text === '') {
    chapterReads.count -= 1;
  }
  return chapterResult(action, {
    ...body,
    ...resolved.target,
    title: body.title ?? resolved.target.title,
    text: body.text,
  });
}

async function executeSaveToBook(
  deps: AssistantToolDeps,
  args: Record<string, unknown>,
): Promise<AssistantToolResult> {
  const kindRaw = readString(args.kind);
  if (kindRaw === undefined || !SAVE_KINDS.has(kindRaw as AnnotationKind)) {
    return fail(SAVE_TO_BOOK_TOOL_NAME, 'invalid_kind', {
      message: 'kind 必须是 highlight、bookmark 或 note。',
    });
  }
  const kind = kindRaw as AnnotationKind;
  const selected = deps.selection();
  const quoteArg = readString(args.quote)?.trim() ?? '';
  const selectedQuote = selected?.quote.trim() ?? '';
  const quote = quoteArg !== '' ? quoteArg : selectedQuote;
  const note = readString(args.note)?.trim() || undefined;

  if (kind === 'highlight' && quote === '') {
    return fail(SAVE_TO_BOOK_TOOL_NAME, 'highlight_requires_selection', {
      kind,
      message: '保存高亮需要选区或引文。',
    });
  }

  const confirmed = await deps.confirm({
    kind,
    ...(quote !== '' ? { quote } : {}),
    ...(note !== undefined ? { note } : {}),
  });
  if (!confirmed) {
    return fail(SAVE_TO_BOOK_TOOL_NAME, 'rejected', {
      kind,
      rejected: true,
      message: '用户拒绝保存。',
    });
  }

  const locator =
    kind === 'bookmark'
      ? deps.currentLocator()
      : selected?.locator !== undefined && (kind !== 'highlight' || selectedQuote !== '')
        ? selected.locator
        : deps.currentLocator();
  deps.appendAnnotation(
    kind,
    locator,
    quote === '' ? undefined : quote,
    note,
  );
  return {
    ok: true,
    tool: SAVE_TO_BOOK_TOOL_NAME,
    kind,
    saved: true,
    ...(quote !== '' ? { quote } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

export function createAssistantToolSession(deps: AssistantToolDeps): AssistantToolSession {
  const chapterReads = { count: 0 };
  return {
    tools: ASSISTANT_TOOL_DEFINITIONS,
    specifiedChapterCount: () => chapterReads.count,
    async execute(name, args) {
      const parsed = parseArgs(args);
      if ('error' in parsed && parsed.error === 'invalid_args') {
        return fail(name, 'invalid_args', { message: '工具参数不是对象。' });
      }
      if (name === QUERY_BOOK_TOOL_NAME) {
        return executeQueryBook(deps, parsed, chapterReads);
      }
      if (name === SAVE_TO_BOOK_TOOL_NAME) {
        return executeSaveToBook(deps, parsed);
      }
      return fail(name, 'unknown_tool', { message: '未知工具。' });
    },
  };
}
