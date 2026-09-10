/**
 * `assistant-request` — 助手一轮模型请求的分层组装（ADR-1 / R4 / R5）。
 *
 * 固定顺序：① 两个内置工具（查询当前书、保存到当前书）② 系统提示（不含章）
 * ③ 当前章/当前页正文 ④ 本会话近期 messages（含 tool 结果）⑤ 本轮用户消息。
 * 同章追问必须使 ①②③ 字节级相同；PDF 页码只写入 ⑤，不进 ③。
 */

import { READER_LIMITS } from './reader-limits.js';

/** 单次请求携带的历史条数上限（ai.rs MAX_MESSAGES=200 的安全余量）。 */
export const ASSISTANT_REQUEST_MAX_TURNS = 30;
/** 请求字符预算（②③④⑤；① 是 JSON Schema，不计入此字符预算）。 */
const ASSISTANT_REQUEST_CHAR_BUDGET = 180_000;

export type AssistantContextKind = 'flow' | 'pdf' | 'cbz';

export interface AssistantChapterSource {
  readonly kind: AssistantContextKind;
  /** flow 章标题；PDF 忽略（页码不得进入 ③）。 */
  readonly title?: string;
  readonly text: string;
}

export interface AssistantToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface AssistantToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** 发给 `ai_chat_stream` 的消息（camelCase 与 ai.rs AiChatMessage 对齐）。 */
export interface AssistantChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly toolCalls?: readonly AssistantToolCall[];
}

/** ④ 中的会话轮次（不含 ②③）。 */
export interface AssistantRequestTurn {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly toolCalls?: readonly AssistantToolCall[];
}

export interface AssistantChatRequestInput {
  readonly systemPrompt: string;
  readonly chapter: AssistantChapterSource | null;
  readonly history?: readonly AssistantRequestTurn[];
  readonly userMessage: string;
  /** PDF 当前页码，只写入 ⑤。 */
  readonly page?: number;
  readonly maxTurns?: number;
  readonly charBudget?: number;
}

export interface AssistantChatRequest {
  readonly tools: readonly AssistantToolDefinition[];
  readonly messages: readonly AssistantChatMessage[];
  readonly truncated: boolean;
}

export const ASSISTANT_QUERY_BOOK_TOOL: AssistantToolDefinition = {
  name: 'query_book',
  description:
    '查询当前打开的书。用 action 区分：toc 目录（无正文）、current_chapter 当前章、chapter 指定章（query 为序号或标题）、selection 当前选区、book_info 书籍信息、search 书内关键词搜索（query 为关键词；只返回定位与短摘录）。查询不改变阅读位置。截断、还有更多、找不到或标题歧义必须写在结果里。',
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
        description: 'search 的关键词，或 chapter 的标题/序号',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};

export const ASSISTANT_SAVE_TO_BOOK_TOOL: AssistantToolDefinition = {
  name: 'save_to_book',
  description:
    '保存到当前书的标注。kind 为 highlight（高亮，必须有选区或引文）、bookmark（书签，不需选区）或 note（笔记）。缺省定位用当前阅读位置。必须经用户确认后才写入；拒绝则不写入。',
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
        description: '高亮或笔记所依据的引文',
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

/** ① 模型可见工具清单：顺序固定为查询当前书、保存到当前书。 */
export const ASSISTANT_BUILTIN_TOOLS: readonly AssistantToolDefinition[] = [
  ASSISTANT_QUERY_BOOK_TOOL,
  ASSISTANT_SAVE_TO_BOOK_TOOL,
];

function clipChapterText(text: string, limit: number): { text: string; truncated: boolean } {
  const clean = text.trim();
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

/**
 * ③ 当前章/当前页正文块。CBZ 与空文本返回空串；PDF 标题与注入正文均不含页码。
 */
export function formatAssistantChapterPrefix(chapter: AssistantChapterSource | null): {
  readonly text: string;
  readonly truncated: boolean;
} {
  if (chapter === null || chapter.kind === 'cbz') {
    return { text: '', truncated: false };
  }
  const clipped = clipChapterText(chapter.text, READER_LIMITS.maxAssistantContextChars);
  if (clipped.text === '') {
    return { text: '', truncated: clipped.truncated };
  }
  if (chapter.kind === 'pdf') {
    return {
      text: `【当前页】\n<chapter>\n${clipped.text}\n</chapter>`,
      truncated: clipped.truncated,
    };
  }
  const title = (chapter.title ?? '').trim();
  const head = title === '' ? '当前章节' : `当前章节：${title}`;
  return {
    text: `【${head}】\n<chapter>\n${clipped.text}\n</chapter>`,
    truncated: clipped.truncated,
  };
}

/** ⑤ 本轮用户消息：页码（若有）只出现在这里。 */
export function formatAssistantUserMessage(text: string, page?: number): string {
  const body = text.trim();
  if (page === undefined || !Number.isFinite(page) || page <= 0) {
    return body;
  }
  return `【当前页码：${Math.trunc(page)}】\n${body}`;
}

function turnHasPayload(turn: AssistantRequestTurn): boolean {
  if (turn.role === 'assistant' && turn.content.trim() === '') {
    return Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0;
  }
  return true;
}

function toChatMessage(turn: AssistantRequestTurn): AssistantChatMessage {
  return {
    role: turn.role,
    content: turn.content,
    ...(turn.toolCallId !== undefined ? { toolCallId: turn.toolCallId } : {}),
    ...(turn.name !== undefined ? { name: turn.name } : {}),
    ...(turn.toolCalls !== undefined && turn.toolCalls.length > 0
      ? { toolCalls: turn.toolCalls }
      : {}),
  };
}

/**
 * ①②③ 的稳定前缀（JSON 字节）。同章两问应完全相等，仅 ④⑤ 增长。
 */
export function assistantRequestPrefixBytes(request: AssistantChatRequest): string {
  const prefix: AssistantChatMessage[] = [];
  for (const message of request.messages) {
    if (message.role !== 'system') {
      break;
    }
    prefix.push(message);
  }
  return JSON.stringify({ tools: request.tools, messages: prefix });
}

/**
 * 组装一轮 `ai_chat_stream` 请求：① tools ② system ③ chapter ④ history ⑤ user。
 * 超预算时丢最旧的 ④（含 tool 结果），不得丢掉 ①②③ 与本轮用户消息。
 */
export function buildAssistantChatRequest(
  input: AssistantChatRequestInput,
): AssistantChatRequest {
  const systemPrompt = input.systemPrompt.trim();
  const chapter = formatAssistantChapterPrefix(input.chapter);
  const userContent = formatAssistantUserMessage(input.userMessage, input.page);
  const maxTurns = input.maxTurns ?? ASSISTANT_REQUEST_MAX_TURNS;
  const charBudget = input.charBudget ?? ASSISTANT_REQUEST_CHAR_BUDGET;

  const messages: AssistantChatMessage[] = [];
  if (systemPrompt !== '') {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (chapter.text !== '') {
    messages.push({ role: 'system', content: chapter.text });
  }

  const history = input.history ?? [];
  const kept: AssistantRequestTurn[] = [];
  let budget = charBudget - systemPrompt.length - chapter.text.length - userContent.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index]!;
    if (!turnHasPayload(turn)) {
      continue;
    }
    if (kept.length >= maxTurns || budget - turn.content.length <= 0) {
      break;
    }
    budget -= turn.content.length;
    kept.unshift(turn);
  }
  for (const turn of kept) {
    messages.push(toChatMessage(turn));
  }
  messages.push({ role: 'user', content: userContent });

  return {
    tools: ASSISTANT_BUILTIN_TOOLS,
    messages,
    truncated: chapter.truncated,
  };
}
