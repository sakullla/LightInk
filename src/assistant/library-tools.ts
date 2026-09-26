/**
 * `library-tools` — surface 无关的书架管理工具会话（ADR-4 / ADR-8 / R4）。
 *
 * 五类工具覆盖 R4 的书架管理面：
 * - `library_search`：按书名/作者/分组/标签/格式/阅读状态查询书库，或列出
 *   分组与标签（只读）。
 * - `library_organize`：把书归入/移出分组；目标分组不存在时按指令新建（受
 *   后端名称 1..80、8 层、无循环约束，拒绝时原样报因）。
 * - `library_tag`：打标/取消标签/清空标签；清空是破坏性操作。
 * - `library_create_group`：单独新建分组（可带父分组）。
 * - `library_remove`：删除书籍或删除分组（破坏性）。
 *
 * 写入确认语义（ADR-4 / ADR-5）：
 * - `review`（缺省）：一律 `pending_confirmation`，包括当前句点名的可逆写入。
 * - `auto`：保持原先的门。祈使写指令、分组名或每个标签名出现在这句话里、且
 *   不是删书、删组、清空标签，才 `executePlan`。主动建议（`suggestionTurn`）
 *   即使句子像显式指令也进待确认。
 * - `yolo`：`gate` 直接 `executePlan`，删除、清空和主动建议也不进卡片。
 * - 三种模式都不放宽同名候选、分组层级/循环和 50 本上限。
 * - 归类和打标（不含清空、删除）在进门前去掉会话开始时已在自定义分组或已有
 *   标签的书。这份快照只取一次：本轮内刚直接落盘的书仍视为未处理，不匹配
 *   当前句的后续计划继续进待确认，而不是被当成没有新书丢掉。智能组不算已
 *   整理。用户说重新整理/重新打标，或点名这些书并要求写入时，这些书才留下。
 *   没有可处理的新书时只返回说明，不改书库。
 * - 面板确认后走同一 session 的 `confirmPending(id)`；建议阶段不产生任何写
 *   调用。模型可调用的 `execute` 拒绝任何携带 `pending_ref` 的调用。
 * - 批量写中途失败：可逆步骤（归类/打标，含新建分组/标签）逐项补偿回滚；
 *   成员关系快照先于任何新建读取，读取失败时不落状态；不可逆的删除在失败结果
 *   列出已应用项并触发刷新通知，不静默留半状态。
 *
 * 读写在 `LibraryToolDeps` 背后（生产默认走 `LibraryClient`，定位复用
 * `library-content` 的同名语义），测试注入替身，不起 Tauri。
 */

import type { LibraryProgressStatus } from '../library/library-progress.js';
import { libraryClient } from '../library/library-client.js';
import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from '../library/library-client.js';
import { fnv1a64Hex } from '../reader/document-hash.js';
import type { AssistantPermissionMode } from './assistant-permission.js';
import type {
  AssistantPendingConfirmation,
  AssistantToolDefinition,
  AssistantToolSession,
} from './assistant-tools.js';
import {
  createLibraryContentService,
  defaultLibraryContentDeps,
  formatOf,
  type LibraryBookCandidate,
  type LibraryBookLookup,
  type LibraryBookLookupResult,
  type LibraryContentFailure,
} from './library-content.js';

export const LIBRARY_SEARCH_TOOL_NAME = 'library_search';
export const LIBRARY_ORGANIZE_TOOL_NAME = 'library_organize';
export const LIBRARY_TAG_TOOL_NAME = 'library_tag';
export const LIBRARY_CREATE_GROUP_TOOL_NAME = 'library_create_group';
export const LIBRARY_REMOVE_TOOL_NAME = 'library_remove';

/** 单次写入的目标书数量上限（批量归类/打标）。 */
export const LIBRARY_TOOL_MAX_BATCH = 50;
/** 查询返回条数上限。 */
export const LIBRARY_SEARCH_MAX_LIMIT = 50;
export const LIBRARY_SEARCH_DEFAULT_LIMIT = 20;

/** 阅读状态与书架进度同源（`library-progress`），只在 surface 提供读取时可用。 */
export type LibraryReadingStatus = LibraryProgressStatus;

/** 目标书：书名简写，或按 id/书名/作者组合定位；同名多本不猜测。 */
export type LibraryBookRef =
  | string
  | {
      readonly itemId?: string;
      readonly title?: string;
      readonly author?: string;
    };

/** 工具定义与 `assistant-tools` 同源（同一份 JSON 既发模型又驱动执行）。 */
export type LibraryToolDefinition = AssistantToolDefinition;

export interface LibraryToolBook {
  readonly itemId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly format: string;
  readonly groups: readonly string[];
  readonly tags: readonly string[];
  readonly status?: LibraryReadingStatus;
}

export interface LibraryToolGroupView {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly kind: LibraryGroup['kind'];
}

export interface LibraryToolTagView {
  readonly id: string;
  readonly name: string;
}

export type LibraryToolChangeKind =
  | 'organize'
  | 'tag'
  | 'create-group'
  | 'remove-book'
  | 'remove-group';

/** 写操作成功后的变更通知（surface 用于刷新首页模块）。 */
export interface LibraryToolChange {
  readonly kind: LibraryToolChangeKind;
  readonly itemIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly tagIds: readonly string[];
}

/** 工具结果：与 `AssistantToolResult` 结构兼容，另加书架查询/写入字段。 */
export interface LibraryToolResult {
  readonly ok: boolean;
  readonly tool?: string;
  readonly action?: string;
  /** 主动建议已进入待确认列表（确认前无写入）。 */
  readonly pending?: boolean;
  readonly message?: string;
  readonly error?: string;
  readonly truncated?: boolean;
  readonly books?: readonly LibraryToolBook[];
  readonly groups?: readonly LibraryToolGroupView[];
  readonly tags?: readonly LibraryToolTagView[];
  /** 已影响的 itemId / groupId（按操作类型）。 */
  readonly updated?: readonly string[];
  /** 同名多本/同名分组的候选，供用户选择。 */
  readonly book_candidates?: readonly LibraryBookCandidate[];
  readonly pending_confirmation?: readonly AssistantPendingConfirmation[];
}

export interface LibraryToolDeps {
  readonly listItems: () => Promise<readonly LibraryItem[]>;
  readonly listGroups: () => Promise<readonly LibraryGroup[]>;
  readonly listGroupMemberships: () => Promise<readonly LibraryGroupMembership[]>;
  readonly listTags: () => Promise<readonly LibraryTag[]>;
  readonly listTagMemberships: () => Promise<readonly LibraryTagMembership[]>;
  readonly createGroup: (name: string, parentId?: string) => Promise<LibraryGroup>;
  readonly setGroupMember: (
    groupId: string,
    itemId: string,
    present: boolean,
  ) => Promise<void>;
  readonly createTag: (name: string) => Promise<LibraryTag>;
  readonly setItemTags: (itemId: string, tagIds: readonly string[]) => Promise<void>;
  /** 回滚本次新建的标签（批量写失败补偿；删除只移除关系，不动书）。 */
  readonly deleteTag: (tagId: string) => Promise<void>;
  readonly removeItem: (itemId: string) => Promise<void>;
  readonly deleteGroup: (groupId: string) => Promise<void>;
  /** 按书名/作者定位（生产默认 `library-content`，语义同名多本返回全部候选）。 */
  readonly locate: (
    query: LibraryBookLookup,
  ) => Promise<LibraryBookLookupResult | LibraryContentFailure>;
  /** 阅读状态读取；缺省时 `library_search.status` 返回不可用。 */
  readonly readingStatusOf?: (itemId: string) => LibraryReadingStatus | null;
  /** 当前用户轮消息原文（面板经 `createToolSession` 注入），用于显式指令判定。 */
  readonly userMessage?: string;
  /**
   * 权限模式。缺省 `review`：新的写入都进待确认。`auto` 只直写当前句点名的
   * 可逆整理。`yolo` 连删除和主动建议也直写。
   */
  readonly permissionMode?: AssistantPermissionMode;
  /**
   * 这一轮是书架整理/打标建议，不是用户显式写指令。审阅和自动都进待确认；
   * YOLO 仍直接落盘。已整理书籍的过滤仍然生效。
   */
  readonly suggestionTurn?: boolean;
  /** 覆盖默认显式指令判定；缺省 `isExplicitLibraryWriteInstruction`。 */
  readonly isExplicitInstruction?: (message: string) => boolean;
  /** 写操作成功后的变更通知（surface 刷新首页模块；回调异常不影响工具结果）。 */
  readonly onLibraryChanged?: (change: LibraryToolChange) => void;
}

export interface LibraryToolSession extends AssistantToolSession {
  readonly tools: readonly LibraryToolDefinition[];
  execute(name: string, args?: unknown): Promise<LibraryToolResult>;
  /**
   * 用户确认入口（面板专用；模型路径不可达）。执行成功后条目失效，失败保留
   * 条目以支持重试。
   */
  confirmPending(id: string): Promise<LibraryToolResult>;
}

const BOOK_REF_SCHEMA = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        title: { type: 'string' },
        author: { type: 'string' },
      },
      additionalProperties: false,
    },
  ],
} as const;

const LIBRARY_SEARCH_DEFINITION: LibraryToolDefinition = {
  type: 'function',
  name: LIBRARY_SEARCH_TOOL_NAME,
  description:
    '查询书库（只读）。action=books 按条件查书并返回 id、书名、作者、格式、所属分组、标签与阅读状态；action=groups 列分组（query 过滤名称）；action=tags 列标签（query 过滤名称）。同名多本会全部返回，写入前需先用 id 确认目标。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['books', 'groups', 'tags'],
        description: 'books=按条件查书；groups=列分组；tags=列标签',
      },
      title: { type: 'string', description: '书名（精确优先，其次包含）' },
      author: { type: 'string', description: '作者' },
      query: {
        type: 'string',
        description: 'books 关键词（匹配书名或作者）；groups/tags 名称过滤',
      },
      group: { type: 'string', description: '分组名，只返回该组内的书' },
      tag: { type: 'string', description: '标签名，只返回带该标签的书' },
      format: { type: 'string', description: '格式，如 epub、pdf、txt、cbz' },
      status: {
        type: 'string',
        enum: ['not-started', 'in-progress', 'finished'],
        description: '阅读状态',
      },
      limit: {
        type: 'integer',
        description: `返回上限，默认 ${LIBRARY_SEARCH_DEFAULT_LIMIT}，最大 ${LIBRARY_SEARCH_MAX_LIMIT}`,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

const LIBRARY_ORGANIZE_DEFINITION: LibraryToolDefinition = {
  type: 'function',
  name: LIBRARY_ORGANIZE_TOOL_NAME,
  description:
    '把书归入或移出自定义分组（批量）。books 用书名或 {itemId,title,author} 指定，同名多本会返回候选不落盘。目标分组不存在时 assign 会新建（名称 1..80 字、最多 8 层，后端拒绝时给出原因）。AI 主动建议需用户确认后才写入；删除分组请用 library_remove。',
  parameters: {
    type: 'object',
    properties: {
      books: {
        type: 'array',
        description: '目标书列表',
        items: BOOK_REF_SCHEMA,
      },
      group: { type: 'string', description: '目标分组名' },
      mode: {
        type: 'string',
        enum: ['assign', 'remove'],
        description: 'assign=归入分组（默认）；remove=移出分组',
      },
    },
    required: ['books', 'group'],
    additionalProperties: false,
  },
};

const LIBRARY_TAG_DEFINITION: LibraryToolDefinition = {
  type: 'function',
  name: LIBRARY_TAG_TOOL_NAME,
  description:
    '给书打标签、取消标签或清空标签（批量）。mode=add 时标签不存在会自动创建（同名归一）；mode=remove 只移除指定标签；mode=clear 清空这些书的全部标签。AI 主动建议需用户确认后才写入；clear 与删除同级，一律先确认。',
  parameters: {
    type: 'object',
    properties: {
      books: {
        type: 'array',
        description: '目标书列表',
        items: BOOK_REF_SCHEMA,
      },
      mode: {
        type: 'string',
        enum: ['add', 'remove', 'clear'],
        description: 'add=打标签（默认）；remove=取消标签；clear=清空全部标签',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签名；add/remove 必填，clear 忽略',
      },
    },
    required: ['books', 'mode'],
    additionalProperties: false,
  },
};

const LIBRARY_CREATE_GROUP_DEFINITION: LibraryToolDefinition = {
  type: 'function',
  name: LIBRARY_CREATE_GROUP_TOOL_NAME,
  description:
    '新建自定义分组，可用 parent 指定父分组名以建子分组（最多 8 层、无循环，后端拒绝时给出原因）。同名同父分组已存在时直接复用，不重复创建。AI 主动建议需用户确认后才写入。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '分组名（1..80 字）' },
      parent: { type: 'string', description: '可选父分组名' },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

const LIBRARY_REMOVE_DEFINITION: LibraryToolDefinition = {
  type: 'function',
  name: LIBRARY_REMOVE_TOOL_NAME,
  description:
    '删除书籍或删除分组（破坏性，必须经用户逐次确认后才执行）。kind=book 时用 books 指定书籍；kind=group 时用 groups 指定分组名或分组 id。智能组只读，不能删除。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['book', 'group'],
        description: 'book=删除书籍；group=删除分组',
      },
      books: {
        type: 'array',
        description: 'kind=book 时的目标书列表',
        items: BOOK_REF_SCHEMA,
      },
      groups: {
        type: 'array',
        items: { type: 'string' },
        description: 'kind=group 时的目标分组（名称或 id）',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

/** 模型可见工具清单：顺序固定为查询、归类、打标、新建分组、删除。 */
export const LIBRARY_TOOL_DEFINITIONS: readonly LibraryToolDefinition[] = Object.freeze([
  LIBRARY_SEARCH_DEFINITION,
  LIBRARY_ORGANIZE_DEFINITION,
  LIBRARY_TAG_DEFINITION,
  LIBRARY_CREATE_GROUP_DEFINITION,
  LIBRARY_REMOVE_DEFINITION,
]);

// ── 显式指令判定 ─────────────────────────────────────────────────────

/** 提问/假设语气开头：即使含写入动词也不当作显式指令。 */
const QUESTION_PREFIX =
  /^(怎么|如何|为什么|为啥|是否|能否|能不能|可否|可不可以|可以|要不要|如果|假如|假设|若|我想|我想要|我需要|请问|问一下|想知道)/;
/** 祈使/请求开头：把/将/给/帮我/请… 或直接以写动词开头。 */
const IMPERATIVE_PREFIX =
  /^(请|帮我|帮忙|麻烦|把|将|给|删除|删掉|移除|移出|清空|归类|归到|归入|取消|去掉|打标|打标签|加标签|添加标签|新建|创建|建立)/;
const WRITE_VERB =
  /(归类|归入|归到|归为|分到|放到|放入|加入|移至|移到|移动到|移出|打标|打[上]?[^，。！？!?]{0,16}标签|加[个上]?[^，。！？!?]{0,16}标签|添加[^，。！？!?]{0,16}标签|新建[^，。！？!?]{0,16}分组|创建[^，。！？!?]{0,16}分组|建立[^，。！？!?]{0,16}分组|清空[^，。！？!?]{0,16}标签|删除|删掉|移除|取消[^，。！？!?]{0,16}标签|去掉)/;

/**
 * 保守判定：只有「祈使开头 + 明确写动词」才算显式写指令；疑问/假设/描述
 * 一律 false，写操作降级为待确认建议。
 */
export function isExplicitLibraryWriteInstruction(message: string): boolean {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text === '') {
    return false;
  }
  if (QUESTION_PREFIX.test(text)) {
    return false;
  }
  if (!IMPERATIVE_PREFIX.test(text)) {
    return false;
  }
  return WRITE_VERB.test(text);
}

// ── 解析与只读辅助 ───────────────────────────────────────────────────

function parseArgs(
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return { ok: true, value: {} };
    }
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { ok: false };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
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

/** 非空字符串数组；空串剔除，非字符串成员返回 null（无效参数）。 */
function readNameList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    const name = entry.trim();
    if (name !== '') {
      names.push(name);
    }
  }
  return names;
}

function parseBookRefs(value: unknown): LibraryBookRef[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = Array.isArray(value) ? value : [value];
  const refs: LibraryBookRef[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const title = entry.trim();
      if (title === '') {
        return null;
      }
      refs.push(title);
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const obj = entry as Record<string, unknown>;
    const itemId = readString(obj.itemId)?.trim() ?? '';
    const title = readString(obj.title)?.trim() ?? '';
    const author = readString(obj.author)?.trim() ?? '';
    if (itemId === '' && title === '' && author === '') {
      return null;
    }
    refs.push({
      ...(itemId !== '' ? { itemId } : {}),
      ...(title !== '' ? { title } : {}),
      ...(author !== '' ? { author } : {}),
    });
  }
  return refs.length === 0 ? null : refs;
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message;
  }
  if (typeof error === 'string' && error !== '') {
    return error;
  }
  return '书库操作失败。';
}

function fail(
  tool: string,
  error: string,
  extra: Omit<LibraryToolResult, 'ok' | 'tool' | 'error'> = {},
): LibraryToolResult {
  return { ok: false, tool, error, ...extra };
}

function bookCandidate(item: LibraryItem): LibraryBookCandidate {
  return {
    itemId: item.id,
    title: item.title,
    authors: [...item.authors],
    format: formatOf(item),
  };
}

function groupView(group: LibraryGroup): LibraryToolGroupView {
  return {
    id: group.id,
    name: group.name,
    ...(group.parentId !== undefined ? { parentId: group.parentId } : {}),
    kind: group.kind,
  };
}

function tagView(tag: LibraryTag): LibraryToolTagView {
  return { id: tag.id, name: tag.name };
}

function isReadingStatus(value: string): value is LibraryReadingStatus {
  return value === 'not-started' || value === 'in-progress' || value === 'finished';
}

/** 定位候选：locate 失败原样返回结果；成功映射回 `listItems` 条目。 */
async function locateCandidates(
  deps: LibraryToolDeps,
  tool: string,
  items: readonly LibraryItem[],
  lookup: LibraryBookLookup,
): Promise<LibraryItem[] | LibraryToolResult> {
  const located = await deps.locate(lookup);
  if (!located.ok) {
    return fail(tool, located.error, {
      message: located.message,
      ...(located.candidates !== undefined
        ? { book_candidates: located.candidates }
        : {}),
    });
  }
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return located.candidates
    .map((candidate) => byId.get(candidate.itemId))
    .filter((item): item is LibraryItem => item !== undefined);
}

/** 解析目标书：id 精确命中；书名/作者按 `locate` 语义，多本返回候选不猜测。 */
async function resolveBookRefs(
  deps: LibraryToolDeps,
  tool: string,
  refs: readonly LibraryBookRef[],
): Promise<LibraryItem[] | LibraryToolResult> {
  const items = await deps.listItems();
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const chosen = new Map<string, LibraryItem>();
  for (const ref of refs) {
    if (typeof ref !== 'string' && ref.itemId !== undefined) {
      const found = byId.get(ref.itemId);
      if (found === undefined) {
        return fail(tool, 'not_found', {
          message: `书库里找不到 id 为 ${ref.itemId} 的书。`,
        });
      }
      chosen.set(found.id, found);
      continue;
    }
    const lookup: LibraryBookLookup =
      typeof ref === 'string'
        ? { title: ref }
        : { title: ref.title ?? '', author: ref.author ?? '' };
    const candidates = await locateCandidates(deps, tool, items, lookup);
    if (!Array.isArray(candidates)) {
      return candidates;
    }
    if (candidates.length === 0) {
      const label =
        typeof ref === 'string'
          ? ref
          : [ref.title, ref.author].filter((part) => (part ?? '') !== '').join(' / ');
      return fail(tool, 'not_found', {
        message: `书库里没有匹配「${label}」的书。`,
      });
    }
    if (candidates.length > 1) {
      return fail(tool, 'ambiguous_book', {
        message: `「${typeof ref === 'string' ? ref : (ref.title ?? ref.author ?? '')}」匹配到 ${candidates.length} 本书，请改用书籍 id 或先让用户选择。`,
        book_candidates: candidates.map(bookCandidate),
      });
    }
    chosen.set(candidates[0]!.id, candidates[0]!);
  }
  return [...chosen.values()];
}

/** 组装书籍视图（所属分组/标签名 + 可选阅读状态）。 */
async function buildBookViews(
  deps: LibraryToolDeps,
  items: readonly LibraryItem[],
): Promise<LibraryToolBook[]> {
  const [groups, tags, groupMembers, tagMembers] = await Promise.all([
    deps.listGroups(),
    deps.listTags(),
    deps.listGroupMemberships(),
    deps.listTagMemberships(),
  ]);
  const groupNameById = new Map(groups.map((group) => [group.id, group.name] as const));
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name] as const));
  const groupNames = new Map<string, string[]>();
  for (const membership of groupMembers) {
    const name = groupNameById.get(membership.groupId);
    if (name === undefined) {
      continue;
    }
    const list = groupNames.get(membership.itemId);
    if (list === undefined) {
      groupNames.set(membership.itemId, [name]);
    } else if (!list.includes(name)) {
      list.push(name);
    }
  }
  const tagNames = new Map<string, string[]>();
  for (const membership of tagMembers) {
    const name = tagNameById.get(membership.tagId);
    if (name === undefined) {
      continue;
    }
    const list = tagNames.get(membership.itemId);
    if (list === undefined) {
      tagNames.set(membership.itemId, [name]);
    } else if (!list.includes(name)) {
      list.push(name);
    }
  }
  return items.map((item) => {
    const status = deps.readingStatusOf?.(item.id) ?? undefined;
    return {
      itemId: item.id,
      title: item.title,
      authors: [...item.authors],
      format: formatOf(item),
      groups: [...(groupNames.get(item.id) ?? [])].sort(),
      tags: [...(tagNames.get(item.id) ?? [])].sort(),
      ...(status !== undefined ? { status } : {}),
    };
  });
}

// ── 只读工具：库查询 ─────────────────────────────────────────────────

async function executeSearch(
  deps: LibraryToolDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<LibraryToolResult> {
  const action = readString(args.action) ?? 'books';
  const nameQuery = normalizeName(readString(args.query)?.trim() ?? '');
  if (action === 'groups') {
    const groups = await deps.listGroups();
    const listed =
      nameQuery === ''
        ? groups
        : groups.filter((group) => normalizeName(group.name).includes(nameQuery));
    return { ok: true, tool, action, groups: listed.map(groupView) };
  }
  if (action === 'tags') {
    const tags = await deps.listTags();
    const listed =
      nameQuery === ''
        ? tags
        : tags.filter((tag) => normalizeName(tag.name).includes(nameQuery));
    return { ok: true, tool, action, tags: listed.map(tagView) };
  }
  if (action !== 'books') {
    return fail(tool, 'invalid_action', {
      message: 'action 必须是 books、groups 或 tags。',
    });
  }

  const items = await deps.listItems();
  let matched: LibraryItem[] = [...items];
  const title = readString(args.title)?.trim() ?? '';
  const author = readString(args.author)?.trim() ?? '';
  const query = readString(args.query)?.trim() ?? '';
  if (title !== '' || author !== '') {
    const candidates = await locateCandidates(deps, tool, items, { title, author });
    if (!Array.isArray(candidates)) {
      return candidates;
    }
    matched = candidates;
  } else if (query !== '') {
    const byTitle = await locateCandidates(deps, tool, items, { title: query });
    if (!Array.isArray(byTitle)) {
      return byTitle;
    }
    const byAuthor = await locateCandidates(deps, tool, items, { author: query });
    if (!Array.isArray(byAuthor)) {
      return byAuthor;
    }
    const ids = new Set([...byTitle, ...byAuthor].map((item) => item.id));
    matched = matched.filter((item) => ids.has(item.id));
  }

  const groupName = readString(args.group)?.trim() ?? '';
  if (groupName !== '') {
    const groups = await deps.listGroups();
    const matches = groups.filter(
      (group) => normalizeName(group.name) === normalizeName(groupName),
    );
    const custom = matches.filter((group) => group.kind === 'custom');
    if (custom.length === 0) {
      if (matches.length > 0) {
        return fail(tool, 'smart_group_unsupported', {
          message: `「${groupName}」是智能组（按阅读数据动态计算），暂不支持作为筛选条件。`,
        });
      }
      return fail(tool, 'group_not_found', {
        message: `找不到分组「${groupName}」。`,
      });
    }
    if (custom.length > 1) {
      return fail(tool, 'ambiguous_group', {
        message: `有多个自定义分组叫「${groupName}」，请改用分组 id。`,
        groups: custom.map(groupView),
      });
    }
    const members = await deps.listGroupMemberships();
    const ids = new Set(
      members
        .filter((membership) => membership.groupId === custom[0]!.id)
        .map((membership) => membership.itemId),
    );
    matched = matched.filter((item) => ids.has(item.id));
  }

  const tagName = readString(args.tag)?.trim() ?? '';
  if (tagName !== '') {
    const tags = await deps.listTags();
    const matches = tags.filter(
      (tag) => normalizeName(tag.name) === normalizeName(tagName),
    );
    if (matches.length === 0) {
      return fail(tool, 'tag_not_found', {
        message: `找不到标签「${tagName}」。`,
      });
    }
    const tagIds = new Set(matches.map((tag) => tag.id));
    const members = await deps.listTagMemberships();
    const ids = new Set(
      members
        .filter((membership) => tagIds.has(membership.tagId))
        .map((membership) => membership.itemId),
    );
    matched = matched.filter((item) => ids.has(item.id));
  }

  const format = readString(args.format)?.trim().toLowerCase() ?? '';
  if (format !== '') {
    matched = matched.filter((item) => formatOf(item).toLowerCase() === format);
  }

  const status = readString(args.status)?.trim() ?? '';
  if (status !== '') {
    if (!isReadingStatus(status)) {
      return fail(tool, 'invalid_status', {
        message: 'status 必须是 not-started、in-progress 或 finished。',
      });
    }
    const readingStatusOf = deps.readingStatusOf;
    if (readingStatusOf === undefined) {
      return fail(tool, 'status_unavailable', {
        message: '当前界面无法读取阅读状态，请去掉 status 条件。',
      });
    }
    matched = matched.filter((item) => readingStatusOf(item.id) === status);
  }

  const requestedLimit = readIndex(args.limit) ?? LIBRARY_SEARCH_DEFAULT_LIMIT;
  const limit = clamp(requestedLimit, 1, LIBRARY_SEARCH_MAX_LIMIT);
  const truncated = matched.length > limit;
  const books = await buildBookViews(deps, matched.slice(0, limit));
  return { ok: true, tool, action, books, truncated };
}

// ── 写入计划与确认 ───────────────────────────────────────────────────

interface OrganizePlan {
  readonly kind: 'organize';
  readonly mode: 'assign' | 'remove';
  readonly groupName: string;
  readonly groupId?: string;
  readonly createGroup: boolean;
  readonly itemIds: readonly string[];
  readonly titles: readonly string[];
}

interface TagPlan {
  readonly kind: 'tag';
  readonly mode: 'add' | 'remove' | 'clear';
  readonly tagNames: readonly string[];
  readonly itemIds: readonly string[];
  readonly titles: readonly string[];
}

interface CreateGroupPlan {
  readonly kind: 'create-group';
  readonly name: string;
  readonly parentId?: string;
}

interface RemoveBooksPlan {
  readonly kind: 'remove-books';
  readonly itemIds: readonly string[];
  readonly titles: readonly string[];
}

interface RemoveGroupsPlan {
  readonly kind: 'remove-groups';
  readonly groupIds: readonly string[];
  readonly names: readonly string[];
}

type LibraryWritePlan =
  | OrganizePlan
  | TagPlan
  | CreateGroupPlan
  | RemoveBooksPlan
  | RemoveGroupsPlan;

interface PendingWrite {
  readonly tool: string;
  readonly plan: LibraryWritePlan;
}

function planDescriptor(plan: LibraryWritePlan): Record<string, unknown> {
  const items: string[] =
    plan.kind === 'organize' || plan.kind === 'tag' || plan.kind === 'remove-books'
      ? [...plan.itemIds].sort()
      : [];
  switch (plan.kind) {
    case 'organize':
      return {
        kind: plan.kind,
        mode: plan.mode,
        group: plan.groupId ?? `new:${normalizeName(plan.groupName)}`,
        create: plan.createGroup,
        items,
      };
    case 'tag':
      return {
        kind: plan.kind,
        mode: plan.mode,
        tags: plan.tagNames.map(normalizeName).sort(),
        items,
      };
    case 'create-group':
      return {
        kind: plan.kind,
        name: normalizeName(plan.name),
        parent: plan.parentId ?? null,
      };
    case 'remove-books':
      return { kind: plan.kind, items };
    case 'remove-groups':
      return { kind: plan.kind, groups: [...plan.groupIds].sort() };
  }
}

function writePlanId(tool: string, plan: LibraryWritePlan): string {
  return `${tool}:${fnv1a64Hex(JSON.stringify(planDescriptor(plan)))}`;
}

/** 破坏性操作：删除书籍、删除分组、清空标签一律确认。 */
function requiresConfirmation(plan: LibraryWritePlan): boolean {
  if (plan.kind === 'remove-books' || plan.kind === 'remove-groups') {
    return true;
  }
  return plan.kind === 'tag' && plan.mode === 'clear';
}

const REPROCESS_REQUEST = /重新整理|重新打标/;

/** 当前句在要求写入（疑问句除外），用于「点名已处理的书才纳入」。 */
function userRequestsLibraryWrite(message: string): boolean {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text === '' || QUESTION_PREFIX.test(text)) {
    return false;
  }
  return WRITE_VERB.test(text);
}

function bookNamedInMessage(item: LibraryItem, message: string): boolean {
  const haystack = message.toLowerCase();
  const title = normalizeName(item.title);
  if (title !== '' && haystack.includes(title)) {
    return true;
  }
  const id = item.id.trim().toLowerCase();
  return id !== '' && haystack.includes(id);
}

interface ProcessedSnapshot {
  readonly ok: true;
  readonly ids: ReadonlySet<string>;
}

interface ProcessedSnapshotFailure {
  readonly ok: false;
  readonly error: unknown;
}

/**
 * 会话开始时的已处理书：自定义分组成员或已有任一标签。智能组不算。
 * 读取失败时不抛，交给每次过滤返回 write_failed。
 */
function loadProcessedSnapshot(
  deps: LibraryToolDeps,
): Promise<ProcessedSnapshot | ProcessedSnapshotFailure> {
  return Promise.all([
    deps.listGroups(),
    deps.listGroupMemberships(),
    deps.listTagMemberships(),
  ])
    .then(([groups, memberships, tagMemberships]) => {
      const customIds = new Set(
        groups.filter((group) => group.kind === 'custom').map((group) => group.id),
      );
      const ids = new Set<string>();
      for (const membership of memberships) {
        if (customIds.has(membership.groupId)) {
          ids.add(membership.itemId);
        }
      }
      for (const membership of tagMemberships) {
        ids.add(membership.itemId);
      }
      return { ok: true as const, ids };
    })
    .catch((error: unknown) => ({ ok: false as const, error }));
}

/**
 * 主动归类/打标只留快照里未进自定义分组且无标签的书。快照读取失败时不写。
 * 重新整理/重新打标，或点名且要求写入的已处理书，保留。
 */
async function selectActionableBooks(
  snapshot: Promise<ProcessedSnapshot | ProcessedSnapshotFailure>,
  deps: LibraryToolDeps,
  tool: string,
  items: readonly LibraryItem[],
): Promise<LibraryItem[] | LibraryToolResult> {
  const message = deps.userMessage ?? '';
  if (REPROCESS_REQUEST.test(message)) {
    return [...items];
  }
  const loaded = await snapshot;
  if (!loaded.ok) {
    return fail(tool, 'write_failed', { message: errorMessage(loaded.error) });
  }
  const writeAsked = userRequestsLibraryWrite(message);
  const kept: LibraryItem[] = [];
  for (const item of items) {
    if (!loaded.ids.has(item.id) || (writeAsked && bookNamedInMessage(item, message))) {
      kept.push(item);
    }
  }
  return kept;
}

function noNewBooks(tool: string): LibraryToolResult {
  return {
    ok: true,
    tool,
    message: '没有新书需要处理。',
  };
}

/** 操作目标名必须出现在显式消息里，防止显式轮次夹带未被要求的写入。 */
function planMatchesUserMessage(plan: LibraryWritePlan, message: string): boolean {
  const haystack = message.toLowerCase();
  const mentions = (name: string): boolean => {
    const needle = normalizeName(name);
    return needle !== '' && haystack.includes(needle);
  };
  switch (plan.kind) {
    case 'organize':
      return mentions(plan.groupName);
    case 'tag':
      return (
        plan.mode === 'clear' ||
        (plan.tagNames.length > 0 && plan.tagNames.every((name) => mentions(name)))
      );
    case 'create-group':
      return mentions(plan.name);
    case 'remove-books':
    case 'remove-groups':
      return true;
  }
}

function bookList(titles: readonly string[]): string {
  const shown = titles
    .slice(0, 3)
    .map((title) => `《${title}》`)
    .join('、');
  return titles.length > 3 ? `${shown} 等 ${titles.length} 本` : shown;
}

function nameList(names: readonly string[]): string {
  return names.map((name) => `「${name}」`).join('、');
}

function organizeSummary(plan: OrganizePlan): string {
  if (plan.mode === 'remove') {
    return `把${bookList(plan.titles)}移出分组「${plan.groupName}」`;
  }
  if (plan.createGroup) {
    return `新建分组「${plan.groupName}」并把${bookList(plan.titles)}归入`;
  }
  return `把${bookList(plan.titles)}归到分组「${plan.groupName}」`;
}

function tagSummary(plan: TagPlan): string {
  if (plan.mode === 'clear') {
    return `清空${bookList(plan.titles)}的全部标签`;
  }
  if (plan.mode === 'remove') {
    return `移除${bookList(plan.titles)}的标签${nameList(plan.tagNames)}`;
  }
  return `给${bookList(plan.titles)}打上标签${nameList(plan.tagNames)}`;
}

/**
 * 生产默认依赖：书库客户端 + `library-content` 定位服务。
 * `userMessage` / `onLibraryChanged` 等由 surface 覆盖注入。
 */
export function defaultLibraryToolDeps(
  overrides: Partial<LibraryToolDeps> = {},
): LibraryToolDeps {
  const locate = createLibraryContentService(defaultLibraryContentDeps());
  return {
    listItems: () => libraryClient.listItems(),
    listGroups: () => libraryClient.listGroups(),
    listGroupMemberships: () => libraryClient.listGroupMemberships(),
    listTags: () => libraryClient.listTags(),
    listTagMemberships: () => libraryClient.listTagMemberships(),
    createGroup: (name, parentId) => libraryClient.createGroup(name, parentId),
    setGroupMember: (groupId, itemId, present) =>
      libraryClient.setGroupMember(groupId, itemId, present),
    createTag: (name) => libraryClient.createTag(name),
    setItemTags: (itemId, tagIds) => libraryClient.setItemTags(itemId, tagIds),
    deleteTag: (tagId) => libraryClient.deleteTag(tagId),
    removeItem: (itemId) => libraryClient.removeItem(itemId),
    deleteGroup: (groupId) => libraryClient.deleteGroup(groupId),
    locate: (query) => locate.locate(query),
    ...overrides,
  };
}

// ── 批量写补偿 ───────────────────────────────────────────────────────

interface WriteStep {
  readonly run: () => Promise<void>;
  readonly undo: () => Promise<void>;
}

interface WriteOutcome {
  /** 已生效步骤数（步骤与计划顺序一致）。 */
  readonly applied: number;
  readonly failure: unknown;
  /** 失败后补偿是否全部成功；无失败时为 false。 */
  readonly rolledBack: boolean;
}

/** 顺序执行写步骤；任一步失败按逆序补偿已生效步骤，补偿失败标记未回滚。 */
async function runWriteSteps(steps: readonly WriteStep[]): Promise<WriteOutcome> {
  let applied = 0;
  let failure: unknown;
  for (const step of steps) {
    try {
      await step.run();
      applied += 1;
    } catch (error) {
      failure = error;
      break;
    }
  }
  if (failure === undefined) {
    return { applied, failure: undefined, rolledBack: false };
  }
  let rolledBack = true;
  for (let index = applied - 1; index >= 0; index -= 1) {
    try {
      await steps[index]!.undo();
    } catch {
      rolledBack = false;
    }
  }
  return { applied, failure, rolledBack };
}

/** 补偿本次新建的标签；返回是否全部删除成功（删除只移除关系，不动书）。 */
async function removeCreatedTags(
  deps: LibraryToolDeps,
  tagIds: readonly string[],
): Promise<boolean> {
  let cleaned = true;
  for (const tagId of tagIds) {
    try {
      await deps.deleteTag(tagId);
    } catch {
      cleaned = false;
    }
  }
  return cleaned;
}

/** 写失败结果：已回滚则说明保持原状；未回滚则列出已应用项供刷新与核验。 */
function writeFailure(
  tool: string,
  error: unknown,
  applied: { readonly ids: readonly string[]; readonly summary: string },
  rolledBack: boolean,
): LibraryToolResult {
  const reason = errorMessage(error);
  if (applied.ids.length === 0) {
    return fail(tool, 'write_failed', { message: reason });
  }
  if (rolledBack) {
    return fail(tool, 'write_failed', {
      message: `${reason}（本次批量写入已回滚，书库保持原状）`,
    });
  }
  return fail(tool, 'write_failed', {
    message: `${reason}（已生效 ${applied.ids.length} 项：${applied.summary}；未能全部回滚，请刷新后确认）`,
    updated: applied.ids,
  });
}

export function createLibraryToolSession(deps: LibraryToolDeps): LibraryToolSession {
  const pendingWrites = new Map<string, PendingWrite>();
  // 本轮过滤只用会话开始时的已处理书。同一轮前面的直写不能让后续夹带计划
  // 看起来没有新书。
  const processedAtStart = loadProcessedSnapshot(deps);
  const userMessage = deps.userMessage ?? '';
  const classify = deps.isExplicitInstruction ?? isExplicitLibraryWriteInstruction;
  const explicitTurn = classify(userMessage);
  const permissionMode = deps.permissionMode ?? 'review';
  const suggestionTurn = deps.suggestionTurn === true;

  const notify = (change: LibraryToolChange): void => {
    const callback = deps.onLibraryChanged;
    if (callback === undefined) {
      return;
    }
    try {
      callback(change);
    } catch {
      // surface 刷新失败不影响工具结果。
    }
  };

  /** 执行已确认的计划：所有写调用只在此处发生；中途失败按能力补偿或报告。 */
  const executePlan = async (
    tool: string,
    plan: LibraryWritePlan,
  ): Promise<LibraryToolResult> => {
    try {
      switch (plan.kind) {
        case 'organize': {
          // 成员关系快照必须先于 createGroup 读取：读取失败时不落任何状态，
          // 也不留新建分组（补偿只覆盖写步骤失败，不覆盖「新建后读取失败」）。
          const memberships = await deps.listGroupMemberships();
          let groupId = plan.groupId;
          let createdGroupId: string | undefined;
          if (plan.createGroup) {
            // 建议发出后分组可能已被别处创建：计划按顶层创建，同名顶层唯一时
            // 复用，不重复落盘（嵌套同名组不参与复用）。
            const existing = (await deps.listGroups()).filter(
              (group) =>
                group.kind === 'custom' &&
                normalizeName(group.name) === normalizeName(plan.groupName) &&
                group.parentId === undefined,
            );
            if (existing.length > 1) {
              return fail(tool, 'ambiguous_group', {
                message: `有多个自定义分组叫「${plan.groupName}」，请改用分组 id。`,
                groups: existing.map(groupView),
              });
            }
            if (existing.length === 1) {
              groupId = existing[0]!.id;
            } else {
              const created = await deps.createGroup(plan.groupName);
              groupId = created.id;
              createdGroupId = created.id;
            }
          }
          if (groupId === undefined) {
            return fail(tool, 'write_failed', {
              message: '缺少目标分组，未写入。',
            });
          }
          const targetGroupId = groupId;
          const hadMember = (itemId: string): boolean =>
            memberships.some(
              (membership) =>
                membership.groupId === targetGroupId && membership.itemId === itemId,
            );
          const outcome = await runWriteSteps(
            plan.itemIds.map((itemId) => ({
              run: () =>
                deps.setGroupMember(targetGroupId, itemId, plan.mode === 'assign'),
              undo: () => deps.setGroupMember(targetGroupId, itemId, hadMember(itemId)),
            })),
          );
          if (outcome.failure !== undefined) {
            let rolledBack = outcome.rolledBack;
            let leftoverCreatedGroup = false;
            if (rolledBack && createdGroupId !== undefined) {
              try {
                await deps.deleteGroup(createdGroupId);
              } catch {
                leftoverCreatedGroup = true;
                rolledBack = false;
              }
            }
            const appliedIds = plan.itemIds.slice(0, outcome.applied);
            if (!rolledBack && (appliedIds.length > 0 || leftoverCreatedGroup)) {
              notify({
                kind: 'organize',
                itemIds: appliedIds,
                groupIds: leftoverCreatedGroup ? [createdGroupId!] : [targetGroupId],
                tagIds: [],
              });
            }
            if (appliedIds.length === 0) {
              return fail(tool, 'write_failed', {
                message: leftoverCreatedGroup
                  ? `${errorMessage(outcome.failure)}（新建的分组「${plan.groupName}」未能回滚，请刷新后确认）`
                  : errorMessage(outcome.failure),
                ...(leftoverCreatedGroup ? { updated: [createdGroupId!] } : {}),
              });
            }
            return writeFailure(
              tool,
              outcome.failure,
              {
                ids: appliedIds,
                summary: `${plan.mode === 'assign' ? '已归入' : '已移出'}分组「${plan.groupName}」：${bookList(plan.titles.slice(0, outcome.applied))}`,
              },
              rolledBack,
            );
          }
          notify({
            kind: 'organize',
            itemIds: plan.itemIds,
            groupIds: [targetGroupId],
            tagIds: [],
          });
          return {
            ok: true,
            tool,
            action: 'organize',
            message:
              plan.mode === 'assign'
                ? `已把${bookList(plan.titles)}归到分组「${plan.groupName}」。`
                : `已把${bookList(plan.titles)}移出分组「${plan.groupName}」。`,
            updated: plan.itemIds,
          };
        }
        case 'tag': {
          const tags = await deps.listTags();
          // 成员关系快照必须先于 createTag 读取：读取失败时不落任何状态，也不留
          // 新建标签（补偿只覆盖写步骤失败，不覆盖「新建后读取失败」）。
          const memberships = await deps.listTagMemberships();
          const byName = new Map(
            tags.map((tag) => [normalizeName(tag.name), tag] as const),
          );
          const tagIds = new Set<string>();
          const createdTagIds: string[] = [];
          try {
            for (const name of plan.tagNames) {
              const existing = byName.get(normalizeName(name));
              if (existing !== undefined) {
                tagIds.add(existing.id);
                continue;
              }
              if (plan.mode !== 'add') {
                return fail(tool, 'tag_not_found', {
                  message: `标签「${name}」不存在。`,
                });
              }
              const created = await deps.createTag(name);
              byName.set(normalizeName(created.name), created);
              tagIds.add(created.id);
              createdTagIds.push(created.id);
            }
          } catch (error) {
            // 标签创建是写入前的中途失败：补偿本次新建的标签，保持原状。
            const cleaned = await removeCreatedTags(deps, createdTagIds);
            if (!cleaned && createdTagIds.length > 0) {
              notify({ kind: 'tag', itemIds: [], groupIds: [], tagIds: [...createdTagIds] });
              return fail(tool, 'write_failed', {
                message: `${errorMessage(error)}（新建的 ${createdTagIds.length} 个标签未能回滚，请刷新后确认）`,
                updated: [...createdTagIds],
              });
            }
            return fail(tool, 'write_failed', {
              message:
                createdTagIds.length > 0
                  ? `${errorMessage(error)}（本次批量写入已回滚）`
                  : errorMessage(error),
            });
          }
          const originalOf = (itemId: string): string[] =>
            memberships
              .filter((membership) => membership.itemId === itemId)
              .map((membership) => membership.tagId);
          const nextOf = (before: readonly string[]): string[] => {
            const current = new Set(before);
            if (plan.mode === 'add') {
              for (const tagId of tagIds) {
                current.add(tagId);
              }
            } else if (plan.mode === 'remove') {
              for (const tagId of tagIds) {
                current.delete(tagId);
              }
            } else {
              current.clear();
            }
            return [...current];
          };
          const outcome = await runWriteSteps(
            plan.itemIds.map((itemId) => ({
              run: () => deps.setItemTags(itemId, nextOf(originalOf(itemId))),
              undo: () => deps.setItemTags(itemId, originalOf(itemId)),
            })),
          );
          if (outcome.failure !== undefined) {
            let rolledBack = outcome.rolledBack;
            if (createdTagIds.length > 0) {
              const cleaned = await removeCreatedTags(deps, createdTagIds);
              rolledBack = rolledBack && cleaned;
            }
            const appliedIds = plan.itemIds.slice(0, outcome.applied);
            if (!rolledBack && (appliedIds.length > 0 || createdTagIds.length > 0)) {
              notify({
                kind: 'tag',
                itemIds: appliedIds,
                groupIds: [],
                tagIds: [...tagIds],
              });
            }
            if (appliedIds.length === 0) {
              const leftover = createdTagIds.length > 0 && !rolledBack;
              return fail(tool, 'write_failed', {
                message: leftover
                  ? `${errorMessage(outcome.failure)}（新建标签未能完全回滚，请刷新后确认）`
                  : errorMessage(outcome.failure),
                ...(leftover ? { updated: [...createdTagIds] } : {}),
              });
            }
            return writeFailure(
              tool,
              outcome.failure,
              {
                ids: appliedIds,
                summary: `${plan.mode === 'clear' ? '已清空标签' : plan.mode === 'remove' ? '已移除标签' : '已打上标签'}：${bookList(plan.titles.slice(0, outcome.applied))}`,
              },
              rolledBack,
            );
          }
          notify({
            kind: 'tag',
            itemIds: plan.itemIds,
            groupIds: [],
            tagIds: [...tagIds],
          });
          const message =
            plan.mode === 'clear'
              ? `已清空${bookList(plan.titles)}的全部标签。`
              : plan.mode === 'remove'
                ? `已移除${bookList(plan.titles)}的标签${nameList(plan.tagNames)}。`
                : `已给${bookList(plan.titles)}打上标签${nameList(plan.tagNames)}。`;
          return { ok: true, tool, action: 'tag', message, updated: plan.itemIds };
        }
        case 'create-group': {
          const created = await deps.createGroup(plan.name, plan.parentId);
          notify({
            kind: 'create-group',
            itemIds: [],
            groupIds: [created.id],
            tagIds: [],
          });
          return {
            ok: true,
            tool,
            action: 'create-group',
            message: `已新建分组「${created.name}」。`,
            updated: [created.id],
            groups: [groupView(created)],
          };
        }
        case 'remove-books': {
          // 删除不可回滚：中途失败时报告已删除项并触发刷新；已被删除的目标视为
          // 已达成并跳过，使确认失败后的重试能收敛。
          const known = new Set((await deps.listItems()).map((item) => item.id));
          const applied: string[] = [];
          const appliedTitles: string[] = [];
          for (let index = 0; index < plan.itemIds.length; index += 1) {
            const itemId = plan.itemIds[index]!;
            if (!known.has(itemId)) {
              continue;
            }
            try {
              await deps.removeItem(itemId);
              applied.push(itemId);
              appliedTitles.push(plan.titles[index] ?? itemId);
            } catch (error) {
              if (applied.length > 0) {
                notify({
                  kind: 'remove-book',
                  itemIds: [...applied],
                  groupIds: [],
                  tagIds: [],
                });
                return fail(tool, 'write_failed', {
                  message: `${errorMessage(error)}（已删除 ${applied.length}/${plan.itemIds.length}：${bookList(appliedTitles)}；其余未删除，请刷新后确认）`,
                  updated: [...applied],
                });
              }
              return fail(tool, 'write_failed', { message: errorMessage(error) });
            }
          }
          notify({
            kind: 'remove-book',
            itemIds: plan.itemIds,
            groupIds: [],
            tagIds: [],
          });
          return {
            ok: true,
            tool,
            action: 'remove-book',
            message: `已删除书籍${bookList(plan.titles)}。`,
            updated: plan.itemIds,
          };
        }
        case 'remove-groups': {
          // 删除不可回滚：中途失败时报告已删除项并触发刷新；已被删除的目标视为
          // 已达成并跳过，使确认失败后的重试能收敛。
          const known = new Set((await deps.listGroups()).map((group) => group.id));
          const applied: string[] = [];
          const appliedNames: string[] = [];
          for (let index = 0; index < plan.groupIds.length; index += 1) {
            const groupId = plan.groupIds[index]!;
            if (!known.has(groupId)) {
              continue;
            }
            try {
              await deps.deleteGroup(groupId);
              applied.push(groupId);
              appliedNames.push(plan.names[index] ?? groupId);
            } catch (error) {
              if (applied.length > 0) {
                notify({
                  kind: 'remove-group',
                  itemIds: [],
                  groupIds: [...applied],
                  tagIds: [],
                });
                return fail(tool, 'write_failed', {
                  message: `${errorMessage(error)}（已删除 ${applied.length}/${plan.groupIds.length}：${nameList(appliedNames)}；其余未删除，请刷新后确认）`,
                  updated: [...applied],
                });
              }
              return fail(tool, 'write_failed', { message: errorMessage(error) });
            }
          }
          notify({
            kind: 'remove-group',
            itemIds: [],
            groupIds: plan.groupIds,
            tagIds: [],
          });
          return {
            ok: true,
            tool,
            action: 'remove-group',
            message: `已删除分组${nameList(plan.names)}。`,
            updated: plan.groupIds,
          };
        }
      }
    } catch (error) {
      return fail(tool, 'write_failed', { message: errorMessage(error) });
    }
  };

  /**
   * 建议入队：只登记计划并返回待确认结构，不写书库。`arguments` 里的 ref 仅
   * 供不支持 `confirmPending` 的旧面板回退；`execute` 不再接受该引用。
   */
  const issuePending = (
    tool: string,
    plan: LibraryWritePlan,
    summary: string,
  ): LibraryToolResult => {
    const id = writePlanId(tool, plan);
    pendingWrites.set(id, { tool, plan });
    const pending: AssistantPendingConfirmation = {
      id,
      summary,
      tool,
      arguments: { pending_ref: id },
    };
    return {
      ok: true,
      tool,
      pending: true,
      message: '已加入待确认列表，用户确认后才会写入书库。',
      pending_confirmation: [pending],
    };
  };

  /**
   * 写门：YOLO 直接落盘。审阅、主动建议、破坏性操作，以及自动模式下没被
   * 当前句点名的写入，都进待确认。切换模式不追溯已发出的计划。
   */
  const gate = (
    tool: string,
    plan: LibraryWritePlan,
    summary: string,
  ): Promise<LibraryToolResult> => {
    if (permissionMode === 'yolo') {
      return executePlan(tool, plan);
    }
    if (
      permissionMode === 'auto' &&
      !suggestionTurn &&
      !requiresConfirmation(plan) &&
      explicitTurn &&
      planMatchesUserMessage(plan, userMessage)
    ) {
      return executePlan(tool, plan);
    }
    return Promise.resolve(issuePending(tool, plan, summary));
  };

  const executeOrganize = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<LibraryToolResult> => {
    const refs = parseBookRefs(args.books);
    if (refs === null) {
      return fail(tool, 'invalid_books', {
        message: 'books 需要至少一本书（书名或 {itemId,title,author}）。',
      });
    }
    if (refs.length > LIBRARY_TOOL_MAX_BATCH) {
      return fail(tool, 'batch_too_large', {
        message: `一次最多处理 ${LIBRARY_TOOL_MAX_BATCH} 本书。`,
      });
    }
    const groupName = readString(args.group)?.trim() ?? '';
    if (groupName === '') {
      return fail(tool, 'invalid_group', { message: 'group 不能为空。' });
    }
    const modeRaw = readString(args.mode)?.trim() ?? 'assign';
    if (modeRaw !== 'assign' && modeRaw !== 'remove') {
      return fail(tool, 'invalid_mode', {
        message: 'mode 必须是 assign 或 remove。',
      });
    }
    const resolved = await resolveBookRefs(deps, tool, refs);
    if (!Array.isArray(resolved)) {
      return resolved;
    }
    const groups = await deps.listGroups();
    const matches = groups.filter(
      (group) => normalizeName(group.name) === normalizeName(groupName),
    );
    const custom = matches.filter((group) => group.kind === 'custom');
    // 同名自定义组按顶层语义优先解析（与 executeCreateGroup 的同层唯一判定
    // 一致）；顶层不存在时仅在唯一嵌套同名组时复用，多处并存不猜测。
    const preferred =
      custom.filter((group) => group.parentId === undefined).length > 0
        ? custom.filter((group) => group.parentId === undefined)
        : custom;
    if (preferred.length > 1) {
      return fail(tool, 'ambiguous_group', {
        message: `有多个自定义分组叫「${groupName}」，请改用分组 id。`,
        groups: preferred.map(groupView),
      });
    }
    if (preferred.length === 0) {
      if (matches.length > 0) {
        return fail(tool, 'smart_group_readonly', {
          message: `「${groupName}」是智能组，不能手动归入或移出。`,
        });
      }
      if (modeRaw === 'remove') {
        return fail(tool, 'group_not_found', {
          message: `找不到分组「${groupName}」。`,
        });
      }
    }
    const actionable = await selectActionableBooks(processedAtStart, deps, tool, resolved);
    if (!Array.isArray(actionable)) {
      return actionable;
    }
    if (actionable.length === 0) {
      return noNewBooks(tool);
    }
    if (preferred.length === 0) {
      const plan: OrganizePlan = {
        kind: 'organize',
        mode: 'assign',
        groupName,
        createGroup: true,
        itemIds: actionable.map((item) => item.id),
        titles: actionable.map((item) => item.title),
      };
      return gate(tool, plan, organizeSummary(plan));
    }
    const plan: OrganizePlan = {
      kind: 'organize',
      mode: modeRaw,
      groupName,
      groupId: preferred[0]!.id,
      createGroup: false,
      itemIds: actionable.map((item) => item.id),
      titles: actionable.map((item) => item.title),
    };
    return gate(tool, plan, organizeSummary(plan));
  };

  const executeTag = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<LibraryToolResult> => {
    const refs = parseBookRefs(args.books);
    if (refs === null) {
      return fail(tool, 'invalid_books', {
        message: 'books 需要至少一本书（书名或 {itemId,title,author}）。',
      });
    }
    if (refs.length > LIBRARY_TOOL_MAX_BATCH) {
      return fail(tool, 'batch_too_large', {
        message: `一次最多处理 ${LIBRARY_TOOL_MAX_BATCH} 本书。`,
      });
    }
    const modeRaw = readString(args.mode)?.trim() ?? 'add';
    if (modeRaw !== 'add' && modeRaw !== 'remove' && modeRaw !== 'clear') {
      return fail(tool, 'invalid_mode', {
        message: 'mode 必须是 add、remove 或 clear。',
      });
    }
    const names = readNameList(args.tags);
    if (modeRaw !== 'clear' && (names === null || names.length === 0)) {
      return fail(tool, 'invalid_tags', {
        message: 'tags 需要至少一个标签名。',
      });
    }
    const resolved = await resolveBookRefs(deps, tool, refs);
    if (!Array.isArray(resolved)) {
      return resolved;
    }
    if (modeRaw === 'clear') {
      const plan: TagPlan = {
        kind: 'tag',
        mode: 'clear',
        tagNames: [],
        itemIds: resolved.map((item) => item.id),
        titles: resolved.map((item) => item.title),
      };
      return gate(tool, plan, tagSummary(plan));
    }
    const tagNames = [...new Set(names ?? [])];
    if (modeRaw === 'remove') {
      const tags = await deps.listTags();
      const existing = new Set(tags.map((tag) => normalizeName(tag.name)));
      const missing = tagNames.filter((name) => !existing.has(normalizeName(name)));
      if (missing.length > 0) {
        return fail(tool, 'tag_not_found', {
          message: `标签${nameList(missing)}不存在，未做任何修改。`,
        });
      }
    }
    const actionable = await selectActionableBooks(processedAtStart, deps, tool, resolved);
    if (!Array.isArray(actionable)) {
      return actionable;
    }
    if (actionable.length === 0) {
      return noNewBooks(tool);
    }
    const plan: TagPlan = {
      kind: 'tag',
      mode: modeRaw,
      tagNames,
      itemIds: actionable.map((item) => item.id),
      titles: actionable.map((item) => item.title),
    };
    return gate(tool, plan, tagSummary(plan));
  };

  const executeCreateGroup = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<LibraryToolResult> => {
    const name = readString(args.name)?.trim() ?? '';
    if (name === '') {
      return fail(tool, 'invalid_name', { message: 'name 不能为空。' });
    }
    const parentName = readString(args.parent)?.trim() ?? '';
    const groups = await deps.listGroups();
    let parentId: string | undefined;
    if (parentName !== '') {
      const matches = groups.filter(
        (group) => normalizeName(group.name) === normalizeName(parentName),
      );
      const custom = matches.filter((group) => group.kind === 'custom');
      if (custom.length === 0) {
        if (matches.length > 0) {
          return fail(tool, 'smart_group_readonly', {
            message: `「${parentName}」是智能组，不能作为父分组。`,
          });
        }
        return fail(tool, 'group_not_found', {
          message: `找不到父分组「${parentName}」。`,
        });
      }
      if (custom.length > 1) {
        return fail(tool, 'ambiguous_group', {
          message: `有多个自定义分组叫「${parentName}」，请改用分组 id。`,
          groups: custom.map(groupView),
        });
      }
      parentId = custom[0]!.id;
    }
    const existing = groups.filter(
      (group) =>
        group.kind === 'custom' &&
        normalizeName(group.name) === normalizeName(name) &&
        group.parentId === parentId,
    );
    if (existing.length > 1) {
      return fail(tool, 'ambiguous_group', {
        message: `有多个同名分组「${name}」，请先清理重复分组。`,
        groups: existing.map(groupView),
      });
    }
    if (existing.length === 1) {
      return {
        ok: true,
        tool,
        action: 'create-group',
        message: `分组「${existing[0]!.name}」已存在，未重复创建。`,
        groups: [groupView(existing[0]!)],
      };
    }
    const plan: CreateGroupPlan = {
      kind: 'create-group',
      name,
      ...(parentId !== undefined ? { parentId } : {}),
    };
    return gate(tool, plan, `新建分组「${name}」`);
  };

  const executeRemove = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<LibraryToolResult> => {
    const kind = readString(args.kind)?.trim() ?? '';
    if (kind === 'book') {
      const refs = parseBookRefs(args.books);
      if (refs === null) {
        return fail(tool, 'invalid_books', {
          message: '删除书籍需要 books（书名或 {itemId,title,author}）。',
        });
      }
      if (refs.length > LIBRARY_TOOL_MAX_BATCH) {
        return fail(tool, 'batch_too_large', {
          message: `一次最多处理 ${LIBRARY_TOOL_MAX_BATCH} 本书。`,
        });
      }
      const items = await resolveBookRefs(deps, tool, refs);
      if (!Array.isArray(items)) {
        return items;
      }
      const plan: RemoveBooksPlan = {
        kind: 'remove-books',
        itemIds: items.map((item) => item.id),
        titles: items.map((item) => item.title),
      };
      return gate(tool, plan, `删除书籍${bookList(plan.titles)}`);
    }
    if (kind === 'group') {
      const raw = readNameList(args.groups);
      if (raw === null || raw.length === 0) {
        return fail(tool, 'invalid_groups', {
          message: '删除分组需要 groups（分组名或分组 id）。',
        });
      }
      const groups = await deps.listGroups();
      const chosen = new Map<string, LibraryGroup>();
      for (const entry of raw) {
        const byId = groups.find((group) => group.id === entry);
        const matches =
          byId !== undefined
            ? [byId]
            : groups.filter(
                (group) => normalizeName(group.name) === normalizeName(entry),
              );
        const custom = matches.filter((group) => group.kind === 'custom');
        if (custom.length === 0) {
          if (matches.length > 0) {
            return fail(tool, 'smart_group_readonly', {
              message: `「${entry}」是智能组，不能删除。`,
            });
          }
          return fail(tool, 'group_not_found', {
            message: `找不到分组「${entry}」。`,
          });
        }
        if (custom.length > 1) {
          return fail(tool, 'ambiguous_group', {
            message: `有多个自定义分组叫「${entry}」，请改用分组 id。`,
            groups: custom.map(groupView),
          });
        }
        chosen.set(custom[0]!.id, custom[0]!);
      }
      const resolved = [...chosen.values()];
      const plan: RemoveGroupsPlan = {
        kind: 'remove-groups',
        groupIds: resolved.map((group) => group.id),
        names: resolved.map((group) => group.name),
      };
      return gate(tool, plan, `删除分组${nameList(plan.names)}`);
    }
    return fail(tool, 'invalid_kind', {
      message: 'kind 必须是 book 或 group。',
    });
  };

  /** 用户确认入口：面板按 id 调用；成功后条目失效，失败保留以支持重试。 */
  const confirmPending = async (id: string): Promise<LibraryToolResult> => {
    const pending = pendingWrites.get(id);
    if (pending === undefined) {
      return {
        ok: false,
        error: 'confirmation_expired',
        message: '待确认建议已失效，请重新发起。',
      };
    }
    const result = await executePlan(pending.tool, pending.plan);
    if (result.ok) {
      pendingWrites.delete(id);
    }
    return result;
  };

  return {
    tools: LIBRARY_TOOL_DEFINITIONS,
    // 库作用域没有阅读器的「指定章读取」限额，固定 0。
    specifiedChapterCount: () => 0,
    confirmPending,
    async execute(name, args) {
      try {
        const parsed = parseArgs(args);
        if (!parsed.ok) {
          return fail(name, 'invalid_args', { message: '工具参数不是对象。' });
        }
        // 模型可调用路径：待确认引用一律拒绝，确认只能由面板走 confirmPending。
        if (parsed.value.pending_ref !== undefined) {
          return fail(name, 'invalid_args', {
            message: '待确认建议只能由用户在面板确认后执行。',
          });
        }
        if (name === LIBRARY_SEARCH_TOOL_NAME) {
          return await executeSearch(deps, name, parsed.value);
        }
        if (name === LIBRARY_ORGANIZE_TOOL_NAME) {
          return await executeOrganize(name, parsed.value);
        }
        if (name === LIBRARY_TAG_TOOL_NAME) {
          return await executeTag(name, parsed.value);
        }
        if (name === LIBRARY_CREATE_GROUP_TOOL_NAME) {
          return await executeCreateGroup(name, parsed.value);
        }
        if (name === LIBRARY_REMOVE_TOOL_NAME) {
          return await executeRemove(name, parsed.value);
        }
        return fail(name, 'unknown_tool', { message: '未知工具。' });
      } catch (error) {
        return fail(name, 'library_error', { message: errorMessage(error) });
      }
    },
  };
}
