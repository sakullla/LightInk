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
export const BOOK_SOURCE_GET_TOOL_NAME = 'book_source_get';
export const BOOK_SOURCE_SEARCH_TOOL_NAME = 'book_source_search';
export const BOOK_SOURCE_FETCH_TOOL_NAME = 'book_source_fetch';
export const BOOK_SOURCE_SAVE_TOOL_NAME = 'book_source_save';
export const BOOK_SOURCE_IMPORT_TOOL_NAME = 'book_source_import';
export const BOOK_SOURCE_REMOVE_TOOL_NAME = 'book_source_remove';
export const BOOK_SOURCE_DOWNLOAD_TOOL_NAME = 'book_source_download';

/**
 * 与 `book_source.rs` 的结构、自检和提取行为一致。
 * nextPage 只被校验，搜索目前不会按它翻页。
 */
const RULE_GUIDE = [
  '规则是 camelCase JSON，未知字段会被拒绝，version 只能是 1。',
  'baseUrl 必须是绝对地址，默认只允许 https；站点是 http 时才把 allowHttp 设为 true。地址不能带用户名或密码。',
  'search.url 相对 baseUrl 解析，必须包含 {{key}}（搜索词会做 URL 编码）。可以写 {{page}}，但当前搜索固定把它换成 1，只请求这一页。若关键词正好是条目标题，有的站点会直接跳进该条目，结果页上就没有搜索结果节点。MediaWiki 必须用规范名 Special:Search，并带 fulltext=1，不要用翻译后的特殊页名。',
  'search.item、search.title、search.link、search.author、search.cover，以及 toc 和 content.text，都可以写节点选择器：.类名、标签.类名、#id、空格后代，以及 [href^="/path/"]、[href$="结尾"]、[href*="包含"]、[href="全等"]。最外层一对括号会去掉。class 按单独 token 匹配，后面还有别的 class 也能命中。link 取 href，cover 取 src，title 取文字。子选择器先在元素内部找；内部没有、但该元素自己符合选择器时，用它自己的文字或 href。这些字段也可以继续用带捕获组的正则。',
  '不写 search.link 或 toc.link 时，优先用当前匹配元素自己的 href，没有再在内部用 href="([^"]+)"。链接和封面按结果页地址做相对解析。',
  '只搜索可以不写 toc 和 content。要下载章节必须有 toc.item 和 toc.title，用法与 search 相同。',
  '不要写 toc.url。尤其不要写 "url":"{{url}}"。省略 toc.url 时，下载目录会直接打开 book_source_search 返回的那本书的 url，不再相对 baseUrl 拼一次。只有目录确实在另一条路径上才填写 toc.url，而且必须是相对 baseUrl 的路径模板，例如 "/catalog/{{url}}"；这时 {{url}} 才会被换成搜索结果里的书籍地址。',
  '要抽取正文必须有 content.text，第 1 个捕获组是正文 HTML，之后会去掉标签。content.cleanup 是把匹配替换成空字符串的正则，不需要捕获组。',
  '可选 charset（如 gbk，缺省 utf-8）、rateLimitMs（缺省 500，最大 60000）、headers（最多 8 个 {name,value}）。禁止 authorization、cookie、set-cookie、proxy-authorization、host。',
  '禁止出现 login、password、username、captcha、cookie、token、authorization、javascript 这类字段名。',
  'nextPage 可以写选择器或正则，但当前不会按它翻页，不要依赖。',
  '同名书源可以重复保存。修改必须带 book_source_list 返回的 id；删除用 book_source_remove。内置书源用 book_source_list 或保存时的 builtin 字段，不要在说明里假设具体站名。',
].join('');

export interface BookSourceToolSource {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly allowHttp?: boolean;
  /** 已保存的完整规则。维护时基于它修改，不要凭空重写。 */
  readonly rule?: unknown;
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

export interface BookSourceSaveInput {
  readonly id?: string;
  readonly title: string;
  readonly allowHttp: boolean;
  readonly rule: unknown;
}

export interface BookSourceBuiltinOption {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly rule: unknown;
}

export interface BookSourceToolDeps {
  listSources(): Promise<readonly BookSourceToolSource[]>;
  search(sourceId: string, query: string): Promise<readonly BookSourceToolHit[]>;
  /** 搜索或目录没有命中时，把最终网址和 HTML 片段交给模型。 */
  fetchPage?(
    sourceId: string,
    input: { readonly query?: string; readonly url?: string },
  ): Promise<{ finalUrl: string; status: number; length: number; snippet: string }>;
  download(
    input: BookSourceDownloadRequest,
    report?: (message: string) => void,
    bindCancel?: (cancel: () => void) => void,
  ): Promise<BookSourceDownloadOutcome>;
  /** 新增或按 id 更新一条书源配置。规则由后端校验。 */
  saveSource(input: BookSourceSaveInput): Promise<{ id: string; title: string }>;
  removeSource(sourceId: string): Promise<void>;
  /** 导入面板同款 JSON：源数组，或 `{ format, version, sources }`。 */
  importSources(json: string): Promise<readonly { id: string; title: string }[]>;
  setSourceEnabled?(sourceId: string, enabled: boolean): Promise<void>;
  listBuiltins(): Promise<readonly BookSourceBuiltinOption[]>;
  readonly permissionMode?: AssistantPermissionMode;
  readonly userMessage?: string;
}

const LIST_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_LIST_TOOL_NAME,
  description:
    '列出已配置的通用书源（只读）。只返回 id、title、enabled、baseUrl，不含完整 rule。要改某一条之前，先用 book_source_get 读取它的配置。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const GET_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_GET_TOOL_NAME,
  description:
    '读取一条通用书源的完整配置（只读）。source 填 id；仅有唯一同名时也可填名称。返回 id、title、enabled、allowHttp、baseUrl 和完整 rule。修改时基于这份 rule，只改要动的字段，并用同一个 id 调用 book_source_save。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '书源 id，或唯一的书源名称' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

const FETCH_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_FETCH_TOOL_NAME,
  description:
    '读取书源已经抓到的原始页面（只读）。搜索没有命中、或目录没有章节时调用一次。query 看搜索页，url 看书籍页。返回最终网址、状态码、页面长度和 HTML 片段。拿到片段后立刻根据真实标签改选择器，不要在同一轮里再次抓取。不要猜测页面结构。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '书源 id 或唯一名称' },
      query: { type: 'string', description: '搜索词。与 url 二选一' },
      url: { type: 'string', description: '书籍页或章节页地址。与 query 二选一' },
    },
    required: ['source'],
    additionalProperties: false,
  },
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

const SAVE_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_SAVE_TOOL_NAME,
  description:
    `新增或修改一条通用书源。不带 id 时总是新建一条，标题相同也再存一条。修改只需要 id，title、rule、allowHttp 只填要改的，省略的保持原样。enabled=false 只停用。删除用 book_source_remove。${RULE_GUIDE}这是写入，确认前不要说已经保存。`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '书源名称。使用 builtin 时可省略' },
      builtin: { type: 'string', description: '内置书源的 id 或名称' },
      rule: { description: '书源规则 JSON 对象或 JSON 字符串' },
      allowHttp: { type: 'boolean', description: '是否允许 http/局域网地址' },
      id: { type: 'string', description: '更新或停用已有书源时填写它的 id' },
      enabled: { type: 'boolean', description: 'false 为停用；省略则保持或新建为启用' },
    },
    additionalProperties: false,
  },
};

const IMPORT_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_IMPORT_TOOL_NAME,
  description:
    `导入一份书源规则包。json 用用户给出的原文，不要改字段名。可以是数组 [{title, allowHttp, rule}]，或 {format:"lightink.book-sources", version:1, sources:[...]}。${RULE_GUIDE}这是写入，确认前不要说已经导入。`,
  parameters: {
    type: 'object',
    properties: {
      json: { type: 'string', description: '导入 JSON 原文' },
      sources: { description: '规则数组；与 json 二选一' },
    },
    additionalProperties: false,
  },
};

const REMOVE_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_REMOVE_TOOL_NAME,
  description:
    '删除一条通用书源。source 填 book_source_list 返回的 id；若只有名称且不止一条同名，不要猜，先列出 id 再删。这是写入，确认前不要说已经删除。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '书源 id；仅有唯一同名时也可填名称' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

const DOWNLOAD_DEFINITION: AssistantToolDefinition = {
  type: 'function',
  name: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
  description:
    '从通用书源按章节断点下载一本书，合成 TXT 或 EPUB 后入库。bookUrl 必须原样使用 book_source_search 返回的 url，不要用章节标题拼 /wiki/第X回。这是写入：应用会弹出确认卡片，确认前不要说已经下载完成。',
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
  GET_DEFINITION,
  FETCH_DEFINITION,
  SEARCH_DEFINITION,
  SAVE_DEFINITION,
  IMPORT_DEFINITION,
  REMOVE_DEFINITION,
  DOWNLOAD_DEFINITION,
]);

type PendingJob =
  | { readonly kind: 'download'; readonly id: string; readonly request: BookSourceDownloadRequest; readonly summary: string }
  | { readonly kind: 'save'; readonly id: string; readonly input: BookSourceSaveInput; readonly enabled?: boolean; readonly summary: string }
  | { readonly kind: 'import'; readonly id: string; readonly json: string; readonly summary: string }
  | { readonly kind: 'remove'; readonly id: string; readonly sourceId: string; readonly summary: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 面板传入的工具参数是 JSON 字符串，和 library_* 一样先解析再读字段。 */
function parseToolArgs(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed === '') return {};
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return {};
    }
  }
  return asRecord(parsed) ?? {};
}

function readableUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Tauri 拒绝规则时带 message；不要把它显示成「AI 请求失败」。 */
function sourceErrorText(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message.trim();
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message.trim();
  return '书源操作失败。';
}

function field(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(record[key]);
    if (value !== '') return value;
  }
  return '';
}

export function createBookSourceToolSession(deps: BookSourceToolDeps): AssistantToolSession {
  const permissionMode = deps.permissionMode ?? 'review';
  const pending = new Map<string, PendingJob>();
  let seq = 0;
  let saveSubmitted = false;

  const fail = (message: string, error = 'invalid_arguments'): AssistantToolResult => ({
    ok: false,
    error,
    message,
  });

  async function resolveSource(source: string): Promise<BookSourceToolSource | AssistantToolResult> {
    const sources = await deps.listSources();
    const byId = sources.find((item) => item.id === source);
    const matches = byId !== undefined ? [byId] : sources.filter((item) => item.title === source);
    if (matches.length === 0) {
      return fail(`没有名为「${source}」的书源`, 'source_not_found');
    }
    if (matches.length > 1) {
      return fail(`有 ${matches.length} 条名为「${source}」的书源，请改用 id`, 'source_ambiguous');
    }
    const found = matches[0]!;
    if (!found.enabled) {
      return fail(`书源「${found.title}」已停用`, 'source_disabled');
    }
    return found;
  }

  async function resolveForRemove(token: string): Promise<string | AssistantToolResult> {
    const sources = await deps.listSources();
    const byId = sources.find((item) => item.id === token);
    if (byId !== undefined) return byId.id;
    const byTitle = sources.filter((item) => item.title === token);
    if (byTitle.length === 1) return byTitle[0]!.id;
    if (byTitle.length > 1) {
      return fail(`有 ${byTitle.length} 条名为「${token}」的书源，请改用 id 删除`, 'source_ambiguous');
    }
    return fail(`没有名为「${token}」的书源`, 'source_not_found');
  }

  function queueRemove(sourceId: string, title: string): AssistantToolResult {
    seq += 1;
    const id = `bs-${seq}`;
    const summary = `删除书源「${title}」`;
    pending.set(id, { kind: 'remove', id, sourceId, summary });
    return {
      ok: true,
      pending: true,
      tool: BOOK_SOURCE_REMOVE_TOOL_NAME,
      message: '已提交到确认卡片，等待用户确认。这不是失败，不要再次调用 book_source_remove。',
      pending_confirmation: [{ id, summary, tool: BOOK_SOURCE_REMOVE_TOOL_NAME, arguments: { sourceId } }],
    };
  }

  async function runRemove(sourceId: string): Promise<AssistantToolResult> {
    try {
      await deps.removeSource(sourceId);
      return {
        ok: true,
        tool: BOOK_SOURCE_REMOVE_TOOL_NAME,
        action: 'remove',
        message: '已删除书源',
      };
    } catch (error) {
      return {
        ok: false,
        tool: BOOK_SOURCE_REMOVE_TOOL_NAME,
        error: 'remove_failed',
        message: sourceErrorText(error),
      };
    }
  }

  async function runDownload(
    request: BookSourceDownloadRequest,
    report?: (message: string) => void,
    bindCancel?: (cancel: () => void) => void,
  ): Promise<AssistantToolResult> {
    let outcome: BookSourceDownloadOutcome;
    try {
      outcome =
        report === undefined && bindCancel === undefined
          ? await deps.download(request)
          : await deps.download(request, report, bindCancel);
    } catch (error) {
      return {
        ok: false,
        tool: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
        error: 'download_failed',
        message: sourceErrorText(error),
      };
    }
    if (outcome.phase === 'paused') {
      return {
        ok: false,
        tool: BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
        error: 'download_cancelled',
        message: outcome.message ?? '已停止下载。不要再次调用 book_source_download，除非用户要求继续。',
      };
    }
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

  /** 空字符串和 null 的可选字段删掉；cleanup 写成一条字符串时改成数组。 */
function normalizeRule(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRule(item));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (child === null) continue;
    if (typeof child === 'string' && child.trim() === '') continue;
    if (key === 'cleanup' && typeof child === 'string') {
      const text = child.trim();
      if (text !== '') next[key] = [text];
      continue;
    }
    next[key] = normalizeRule(child);
  }
  if ((next.baseUrl !== undefined || next.search !== undefined) && next.version === undefined) {
    next.version = 1;
  }
  return next;
}

function parseRule(value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
    let parsed = value;
    if (typeof parsed === 'string') {
      const trimmed = parsed.trim();
      if (trimmed === '') return { ok: false, message: '规则不能为空' };
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        return { ok: false, message: '规则不是合法 JSON' };
      }
    }
    parsed = normalizeRule(parsed);
    if (!asRecord(parsed)) return { ok: false, message: '规则必须是 JSON 对象' };
    return { ok: true, value: parsed };
  }

  async function buildSaveInput(
    record: Record<string, unknown>,
  ): Promise<BookSourceSaveInput | AssistantToolResult> {
    const builtinName = field(record, 'builtin', 'builtinId', 'builtin_id');
    const explicitTitle = field(record, 'title', 'name');
    const id = field(record, 'id', 'sourceId', 'source_id');
    const allowHttp = record.allowHttp === true || record.allow_http === true;
    if (builtinName !== '') {
      const builtins = await deps.listBuiltins();
      const builtin = builtins.find((item) => item.id === builtinName || item.title === builtinName);
      if (builtin === undefined) return fail(`没有名为「${builtinName}」的内置书源`, 'builtin_not_found');
      return {
        title: explicitTitle === '' ? builtin.title : explicitTitle,
        allowHttp,
        rule: builtin.rule,
        ...(id === '' ? {} : { id }),
      };
    }
    if (id !== '') {
      const sources = await deps.listSources();
      const current = sources.find((item) => item.id === id);
      if (current === undefined) return fail(`没有 id 为「${id}」的书源`, 'source_not_found');
      let ruleValue = current.rule;
      if (record.rule !== undefined && record.rule !== null) {
        const parsed = parseRule(record.rule);
        if (!parsed.ok) return fail(parsed.message);
        ruleValue = parsed.value;
      }
      if (ruleValue === undefined) return fail('修改时没有可沿用的规则，需要提供 rule');
      const allowSpecified =
        typeof record.allowHttp === 'boolean' || typeof record.allow_http === 'boolean';
      return {
        id,
        title: explicitTitle === '' ? current.title : explicitTitle,
        allowHttp: allowSpecified ? allowHttp : current.allowHttp === true,
        rule: ruleValue,
      };
    }
    const rule = parseRule(record.rule);
    if (!rule.ok) return fail(rule.message);
    if (explicitTitle === '') return fail('新建书源需要 title，或指定 builtin');
    return {
      title: explicitTitle,
      allowHttp,
      rule: rule.value,
    };
  }

  function queueSave(input: BookSourceSaveInput, enabled?: boolean): AssistantToolResult {
    const existing = [...pending.values()].find(
      (job) => job.kind === 'save' && job.input.title === input.title,
    );
    if (existing !== undefined && existing.kind === 'save') {
      return {
        ok: true,
        pending: true,
        tool: BOOK_SOURCE_SAVE_TOOL_NAME,
        message: `书源「${input.title}」已在确认卡片中。这不是失败，不要再次调用 book_source_save。`,
        pending_confirmation: [
          {
            id: existing.id,
            summary: existing.summary,
            tool: BOOK_SOURCE_SAVE_TOOL_NAME,
            arguments: { title: input.title },
          },
        ],
      };
    }
    seq += 1;
    const id = `bs-${seq}`;
    const summary = `保存书源「${input.title}」`;
    pending.set(id, { kind: 'save', id, input, summary, ...(enabled === undefined ? {} : { enabled }) });
    return {
      ok: true,
      pending: true,
      tool: BOOK_SOURCE_SAVE_TOOL_NAME,
      message: '已提交到确认卡片，等待用户确认。这不是失败，不要再次调用 book_source_save。',
      pending_confirmation: [
        {
          id,
          summary,
          tool: BOOK_SOURCE_SAVE_TOOL_NAME,
          arguments: { title: input.title },
        },
      ],
    };
  }

  async function runSave(input: BookSourceSaveInput, enabled?: boolean): Promise<AssistantToolResult> {
    try {
      const saved = await deps.saveSource(input);
      if (enabled !== undefined && deps.setSourceEnabled !== undefined) {
        await deps.setSourceEnabled(saved.id, enabled);
      }
      return {
        ok: true,
        tool: BOOK_SOURCE_SAVE_TOOL_NAME,
        action: 'save',
        message: `已保存书源「${saved.title}」`,
        sources: [{ id: saved.id, title: saved.title, ...(enabled === undefined ? {} : { enabled }) }],
      };
    } catch (error) {
      return {
        ok: false,
        tool: BOOK_SOURCE_SAVE_TOOL_NAME,
        error: 'save_failed',
        message: sourceErrorText(error),
      };
    }
  }

  function importJson(record: Record<string, unknown>): string | AssistantToolResult {
    const raw = text(record.json);
    const payload = raw !== '' ? raw : record.sources !== undefined ? JSON.stringify(record.sources) : '';
    if (payload === '') return fail('需要导入 JSON：json 原文，或 sources 数组');
    try {
      return JSON.stringify(normalizeRule(JSON.parse(payload) as unknown));
    } catch {
      return payload;
    }
  }

  function queueImport(json: string): AssistantToolResult {
    seq += 1;
    const id = `bs-${seq}`;
    const summary = '导入书源规则';
    pending.set(id, { kind: 'import', id, json, summary });
    return {
      ok: true,
      pending: true,
      tool: BOOK_SOURCE_IMPORT_TOOL_NAME,
      message: '已提交到确认卡片，等待用户确认。这不是失败，不要再次调用 book_source_import。',
      pending_confirmation: [{ id, summary, tool: BOOK_SOURCE_IMPORT_TOOL_NAME, arguments: {} }],
    };
  }

  async function runImport(json: string): Promise<AssistantToolResult> {
    try {
      const saved = await deps.importSources(json);
      return {
        ok: true,
        tool: BOOK_SOURCE_IMPORT_TOOL_NAME,
        action: 'import',
        message: saved.length === 0 ? '没有导入书源' : `已导入 ${saved.length} 个书源`,
        sources: saved.map((source) => ({ id: source.id, title: source.title })),
      };
    } catch (error) {
      return {
        ok: false,
        tool: BOOK_SOURCE_IMPORT_TOOL_NAME,
        error: 'import_failed',
        message: sourceErrorText(error),
      };
    }
  }

  function queueDownload(request: BookSourceDownloadRequest): AssistantToolResult {
    seq += 1;
    const id = `bs-${seq}`;
    const summary = `从书源下载《${request.title}》（${request.format}）`;
    pending.set(id, { kind: 'download', id, request, summary });
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
      message: '已提交到确认卡片，等待用户确认。这不是失败，不要再次调用 book_source_download。',
      pending_confirmation: [card],
    };
  }

  async function execute(name: string, args?: unknown): Promise<AssistantToolResult> {
    const record = parseToolArgs(args);
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
    if (name === BOOK_SOURCE_GET_TOOL_NAME) {
      const token = field(record, 'source', 'sourceId', 'source_id', 'id', 'title', 'name');
      if (token === '') return fail('需要 source');
      const sources = await deps.listSources();
      const byId = sources.find((item) => item.id === token);
      const matches = byId !== undefined ? [byId] : sources.filter((item) => item.title === token);
      if (matches.length === 0) return fail(`没有名为「${token}」的书源`, 'source_not_found');
      if (matches.length > 1) {
        return fail(`有 ${matches.length} 条名为「${token}」的书源，请改用 id`, 'source_ambiguous');
      }
      const source = matches[0]!;
      return {
        ok: true,
        tool: name,
        message: `书源「${source.title}」的配置`,
        sources: [
          {
            id: source.id,
            title: source.title,
            enabled: source.enabled,
            allowHttp: source.allowHttp === true,
            baseUrl: source.baseUrl,
            ...(source.rule !== undefined ? { rule: source.rule } : {}),
          },
        ],
      };
    }
    if (name === BOOK_SOURCE_FETCH_TOOL_NAME) {
      if (deps.fetchPage === undefined) return fail('当前不能读取页面原文', 'fetch_unavailable');
      const token = field(record, 'source', 'sourceId', 'source_id', 'id', 'name');
      const query = field(record, 'query', 'q', 'keyword');
      const url = field(record, 'url', 'bookUrl', 'book_url');
      if (token === '') return fail('需要 source');
      if (query === '' && url === '') return fail('需要 query 或 url');
      const source = await resolveSource(token);
      if ('ok' in source) return source;
      try {
        const page = await deps.fetchPage(source.id, {
          ...(query === '' ? {} : { query }),
          ...(url === '' ? {} : { url }),
        });
        const failed = page.status >= 400;
        return {
          ok: true,
          tool: name,
          message: failed
            ? `页面返回 HTTP ${page.status}，最终地址 ${page.finalUrl}。下面是响应原文，请据此改地址或选择器，不要猜测。`
            : `已读取页面，最终地址 ${page.finalUrl}，长度 ${page.length}。片段是正文里链接最集中的一段，不是网页头部。请按这段里的真实标签改 toc.item，然后下载。不要再抓同一个地址。`,
          page,
        };
      } catch (error) {
        return { ok: false, tool: name, error: 'fetch_failed', message: sourceErrorText(error) };
      }
    }
    if (name === BOOK_SOURCE_SEARCH_TOOL_NAME) {
      const sourceName = field(record, 'source', 'sourceId', 'source_id', 'name');
      const query = field(record, 'query', 'q', 'keyword', 'title');
      if (sourceName === '' || query === '') return fail('需要 source 和 query');
      const source = await resolveSource(sourceName);
      if ('ok' in source) return source;
      const hits = await deps.search(source.id, query);
      const page =
        hits.length === 0 && deps.fetchPage !== undefined
          ? await deps.fetchPage(source.id, { query }).catch(() => undefined)
          : undefined;
      return {
        ok: true,
        tool: name,
        message:
          hits.length === 0
            ? '没有匹配的书。下面附有最终网址和 HTML 片段，请按片段里的真实标签改选择器，不要猜测。'
            : `找到 ${hits.length} 本`,
        ...(page !== undefined ? { page } : {}),
        results: hits.map((hit) => ({
          sourceId: hit.sourceId,
          sourceTitle: hit.sourceTitle,
          title: hit.title,
          ...(hit.author !== undefined ? { author: hit.author } : {}),
          url: hit.url,
          label: readableUrl(hit.url),
        })),
      };
    }
    if (name === BOOK_SOURCE_SAVE_TOOL_NAME) {
      if (saveSubmitted) {
        return {
          ok: true,
          tool: BOOK_SOURCE_SAVE_TOOL_NAME,
          message: '本轮已经提交过保存书源。这不是失败，不要再次调用 book_source_save。',
        };
      }
      const input = await buildSaveInput(record);
      if ('ok' in input) return input;
      const enabled = typeof record.enabled === 'boolean' ? record.enabled : undefined;
      const result = permissionMode === 'yolo' ? await runSave(input, enabled) : queueSave(input, enabled);
      if (result.ok === true) saveSubmitted = true;
      return result;
    }
    if (name === BOOK_SOURCE_IMPORT_TOOL_NAME) {
      const json = importJson(record);
      if (typeof json !== 'string') return json;
      if (permissionMode === 'yolo') return runImport(json);
      return queueImport(json);
    }
    if (name === BOOK_SOURCE_REMOVE_TOOL_NAME) {
      const token = field(record, 'source', 'sourceId', 'source_id', 'id');
      if (token === '') return fail('需要 source');
      const sourceId = await resolveForRemove(token);
      if (typeof sourceId !== 'string') return sourceId;
      const sources = await deps.listSources();
      const title = sources.find((item) => item.id === sourceId)?.title ?? token;
      if (permissionMode === 'yolo') return runRemove(sourceId);
      return queueRemove(sourceId, title);
    }
    if (name === BOOK_SOURCE_DOWNLOAD_TOOL_NAME) {
      const sourceToken = field(record, 'sourceId', 'source_id', 'source');
      const title = field(record, 'title', 'book', 'name');
      const bookUrl = field(record, 'bookUrl', 'book_url', 'url');
      const author = field(record, 'author');
      const format = field(record, 'format').toLowerCase() === 'epub' ? 'epub' : 'txt';
      if (sourceToken === '' || title === '' || bookUrl === '') {
        return fail('需要 sourceId、title 和 bookUrl');
      }
      const source = await resolveSource(sourceToken);
      if ('ok' in source) return source;
      const request: BookSourceDownloadRequest = {
        sourceId: source.id,
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
    async confirmPending(
      id: string,
      report?: (message: string) => void,
      bindCancel?: (cancel: () => void) => void,
    ): Promise<AssistantToolResult> {
      const item = pending.get(id);
      if (item === undefined) {
        return fail('confirmation_expired', 'confirmation_expired');
      }
      const result =
        item.kind === 'save'
          ? await runSave(item.input, item.enabled)
          : item.kind === 'import'
            ? await runImport(item.json)
            : item.kind === 'remove'
              ? await runRemove(item.sourceId)
              : await runDownload(item.request, report, bindCancel);
      if (result.ok) pending.delete(id);
      return result;
    },
  };
}
