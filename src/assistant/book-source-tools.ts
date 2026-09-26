/**
 * 通用书源工具：列出书源、按源搜索、把一本书的章节下载并合成入库。
 * 下载会改书库，审阅和自动模式先进入确认卡片；YOLO 由应用直接执行。
 */

import type { AssistantPermissionMode } from './assistant-permission.js';
import type {
  AssistantPendingConfirmation,
  AssistantToolDefinition,
  AssistantToolResult,
  AssistantToolSession,
} from './assistant-tools.js';

export const BOOK_SOURCE_LIST_TOOL_NAME = 'book_source_list';
export const BOOK_SOURCE_SEARCH_TOOL_NAME = 'book_source_search';
export const BOOK_SOURCE_DOWNLOAD_TOOL_NAME = 'book_source_download';

export interface BookSourceToolSource {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly baseUrl: string;
}

export interface BookSourceToolHit {
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly title: string;
  readonly author?: string;
  readonly url: string;
}

export interface BookSourceDownloadRequest {
  readonly sourceId: string;
  readonly title: string;
  readonly author?: string;
  readonly bookUrl: string;
  readonly format: 'txt' | 'epub';
}

export interface BookSourceDownloadOutcome {
  readonly itemId?: string;
  readonly phase: string;
  readonly message?: string;
}

export interface BookSourceToolDeps {
  listSources(): Promise<readonly BookSourceToolSource[]>;
  search(sourceId: string, query: string): Promise<readonly BookSourceToolHit[]>;
  download(input: BookSourceDownloadRequest): Promise<BookSourceDownloadOutcome>;
  readonly permissionMode?: AssistantPermissionMode;
  readonly userMessage?: string;
}

const LIST_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_LIST_TOOL_NAME,
  description: '列出已配置的通用书源（只读），返回 id、名称、是否启用和站点地址。搜索或下载前先用它确认源。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const SEARCH_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_SEARCH_TOOL_NAME,
  description:
    '在一个通用书源里搜索书（只读）。source 填书源 id 或名称。返回书名、作者、详情地址。下载前必须先搜索，并用返回的 url。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '书源 id 或名称' },
      query: { type: 'string', description: '搜索词' },
    },
    required: ['source', 'query'],
    additionalProperties: false,
  },
};

const DOWNLOAD_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
  description:
    '从通用书源按章节断点下载一本书，合成 TXT 或 EPUB 后入库。必须使用 book_source_search 返回的 sourceId 与 url。这是写入：应用会弹出确认卡片，确认前不要说已经下载完成。',
  parameters: {
    type: 'object',
    properties: {
      sourceId: { type: 'string' },
      title: { type: 'string' },
      author: { type: 'string' },
      bookUrl: { type: 'string', description: '搜索结果里的 url' },
      format: { type: 'string', enum: ['txt', 'epub'], description: '缺省 txt' },
    },
    required: ['sourceId', 'title', 'bookUrl'],
    additionalProperties: false,
  },
};

export const BOOK_SOURCE_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = Object.freeze([
  LIST_DEFINITION,
  SEARCH_DEFINITION,
  DOWNLOAD_DEFINITION,
]);

interface PendingDownload {
  readonly id: string;
  readonly request: BookSourceDownloadRequest;
  readonly summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createBookSourceToolSession(deps: BookSourceToolDeps): AssistantToolSession {
  const permissionMode = deps.permissionMode ?? 'review';
  const pending = new Map<string, PendingDownload>();
  let seq = 0;

  const fail = (message: string, error = 'invalid_arguments'): AssistantToolResult => ({
    ok: false,
    error,
    message,
  });

  async function resolveSource(source: string): Promise<BookSourceToolSource | AssistantToolResult> {
    const sources = await deps.listSources();
    const found = sources.find((item) => item.id === source || item.title === source);
    if (found === undefined) {
      return fail(`没有名为「${source}」的书源`, 'source_not_found');
    }
    if (!found.enabled) {
      return fail(`书源「${found.title}」已停用`, 'source_disabled');
    }
    return found;
  }

  async function runDownload(request: BookSourceDownloadRequest): Promise<AssistantToolResult> {
    const outcome = await deps.download(request);
    const done = outcome.phase === 'done';
    return {
      ok: done,
      tool: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
      action: 'download',
      message: done
        ? `已下载《${request.title}》并入库`
        : (outcome.message ?? `下载未完成（${outcome.phase}）`),
      ...(done ? {} : { error: 'download_incomplete' }),
      ...(outcome.itemId !== undefined ? { updated: [outcome.itemId] } : {}),
    };
  }

  function queueDownload(request: BookSourceDownloadRequest): AssistantToolResult {
    seq += 1;
    const id = `bs-${seq}`;
    const summary = `从书源下载《${request.title}》（${request.format}）`;
    pending.set(id, { id, request, summary });
    const card: AssistantPendingConfirmation = {
      id,
      summary,
      tool: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
      arguments: request,
    };
    return {
      ok: true,
      pending: true,
      tool: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
      message: '下载需要确认后才会开始',
      pending_confirmation: [card],
    };
  }

  async function execute(name: string, args?: unknown): Promise<AssistantToolResult> {
    const record = asRecord(args) ?? {};
    if (name === BOOK_SOURCE_LIST_TOOL_NAME) {
      const sources = await deps.listSources();
      return {
        ok: true,
        tool: name,
        message: sources.length === 0 ? '还没有书源' : `找到 ${sources.length} 个书源`,
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          enabled: source.enabled,
          baseUrl: source.baseUrl,
        })),
      };
    }
    if (name === BOOK_SOURCE_SEARCH_TOOL_NAME) {
      const sourceName = text(record.source);
      const query = text(record.query);
      if (sourceName === '' || query === '') return fail('需要 source 和 query');
      const source = await resolveSource(sourceName);
      if ('ok' in source) return source;
      const hits = await deps.search(source.id, query);
      return {
        ok: true,
        tool: name,
        message: hits.length === 0 ? '没有匹配的书' : `找到 ${hits.length} 本`,
        results: hits.map((hit) => ({
          sourceId: hit.sourceId,
          sourceTitle: hit.sourceTitle,
          title: hit.title,
          ...(hit.author !== undefined ? { author: hit.author } : {}),
          url: hit.url,
        })),
      };
    }
    if (name === BOOK_SOURCE_DOWNLOAD_TOOL_NAME) {
      const sourceId = text(record.sourceId);
      const title = text(record.title);
      const bookUrl = text(record.bookUrl);
      const author = text(record.author);
      const format = record.format === 'epub' ? 'epub' : 'txt';
      if (sourceId === '' || title === '' || bookUrl === '') {
        return fail('需要 sourceId、title 和 bookUrl');
      }
      const request: BookSourceDownloadRequest = {
        sourceId,
        title,
        bookUrl,
        format,
        ...(author === '' ? {} : { author }),
      };
      const named = (deps.userMessage ?? '').includes(title);
      if (permissionMode === 'yolo' || (permissionMode === 'auto' && named)) {
        return runDownload(request);
      }
      return queueDownload(request);
    }
    return fail(`未知工具 ${name}`, 'unknown_tool');
  }

  return {
    tools: BOOK_SOURCE_TOOL_DEFINITIONS,
    specifiedChapterCount: () => 0,
    execute,
    async confirmPending(id: string): Promise<AssistantToolResult> {
      const item = pending.get(id);
      if (item === undefined) {
        return fail('confirmation_expired', 'confirmation_expired');
      }
      const result = await runDownload(item.request);
      if (result.ok) pending.delete(id);
      return result;
    },
  };
}
