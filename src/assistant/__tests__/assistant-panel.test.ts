// @vitest-environment jsdom

/**
 * Contract for `src/assistant/assistant-panel.ts` (ADR-3 / ADR-6 / R1/R3):
 *
 * - 输入默认多行并长高；可引用选区；生成中可停止且保留已生成文字。
 * - 助手消息以 data-status（waiting/streaming/stopped/error/done）表达状态：
 *   提交后首字未到是 waiting（脉冲点 + 流式文案），首字到达转 streaming，
 *   停止/失败保留文本且视觉可辨（stopped 中性、error 危险 + 重试），完成是 done。
 * - 助手消息操作行（R5）：有内容的可复制 Markdown 原文（短时已复制/失败提示），
 *   已完成可重新生成（截断其后），本次运行内停止的已有文本可继续生成，错误可重试；
 *   流式期间全部禁用，空文本不渲染操作。
 * - 面板管理多段历史；工具调用显示为块；查询定位可点跳转。
 * - 一次发送内工具往返满 24 轮后停止并提示。
 * - 用户消息纯文本；助手消息 Markdown。流式停止丢掉 Channel。
 * - 待确认列表渲染工具返回的 pending_confirmation，确认后优先回调会话专用
 *   confirmPending(id)，未确认前不执行落盘；回传模型的工具结果剥除待确认引用。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  ASSISTANT_COPY_FEEDBACK_MS,
  ASSISTANT_MAX_TOOL_ROUNDS,
  ASSISTANT_PANEL_ACTIONS,
  assistantActionContent,
  clipAssistantContext,
  createAssistantPanel,
  bookSourceFetchShouldStop,
  extractEmbeddedToolCalls,
  parseAssistantPendingConfirmations,
  streamAssistantChat,
  stripAssistantPendingConfirmations,
  type AssistantInvoke,
  type AssistantPanelDeps,
} from '../assistant-panel.js';
import {
  parseAssistantHistoryStore,
  serializeAssistantHistoryStore,
  type AssistantHistoryMessage,
} from '../assistant-history.js';
import { READER_LIMITS } from '../../reader/reader-limits.js';
import { translate, type MessageKey } from '../../i18n/messages.js';
import {
  ASSISTANT_PERMISSION_MODE_KEY,
  type AssistantPermissionStorage,
} from '../assistant-permission.js';
import type { AssistantToolSession } from '../assistant-tools.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flushUntil = async (predicate: () => boolean, tries = 80): Promise<void> => {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) {
      return;
    }
    await flush();
  }
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-android');
});

describe('bookSourceFetchShouldStop', () => {
  const fetchBlock = (result: string) => ({
    id: 'fetch-1',
    name: 'book_source_fetch',
    arguments: '{}',
    result,
  });

  it('lets the model continue after the first page and stops a repeated url', () => {
    const ok = fetchBlock(
      JSON.stringify({ ok: true, page: { finalUrl: 'https://example.test/a', status: 200, length: 10, snippet: '<p>a</p>' } }),
    );
    const missing = fetchBlock(
      JSON.stringify({ ok: true, page: { finalUrl: 'https://example.test/missing', status: 404, length: 20, snippet: 'missing' } }),
    );
    const encoded = fetchBlock(
      JSON.stringify({
        ok: true,
        page: { finalUrl: 'https://example.test/%E4%B9%A6', status: 200, length: 8, snippet: '<p>书</p>' },
      }),
    );
    expect(bookSourceFetchShouldStop([ok], new Set(), 0)).toBe(false);
    expect(bookSourceFetchShouldStop([ok], new Set(['https://example.test/a']), 1)).toBe(true);
    expect(bookSourceFetchShouldStop([missing], new Set(), 0)).toBe(false);
    expect(bookSourceFetchShouldStop([encoded], new Set(['https://example.test/书']), 1)).toBe(true);
    expect(bookSourceFetchShouldStop([missing], new Set(['https://example.test/a']), 2)).toBe(true);
    expect(
      bookSourceFetchShouldStop(
        [{ id: 's', name: 'book_source_search', arguments: '{}', result: '{"ok":true}' }],
        new Set(),
        0,
      ),
    ).toBe(false);
  });
});

describe('extractEmbeddedToolCalls', () => {
  it('turns a minimax invoke dump into a book_source_save call', () => {
    const raw =
      '<tool_call> ]<]minimax[>[<invoke name="book_source_save">]<]minimax[>[<rule>]<]minimax[>[<baseUrl>https://example.test]<]minimax[>[</baseUrl>]<]minimax[>[<search>]<]minimax[>[<item>.result]<]minimax[>[</item>]<]minimax[>[</search>]<]minimax[>[</rule>]<]minimax[>[<title>示例]<]minimax[>[</title>]<]minimax[>[</invoke> ]<]minimax[>[</tool_call>';
    const extracted = extractEmbeddedToolCalls(raw);
    expect(extracted.calls).toHaveLength(1);
    expect(extracted.calls[0]?.name).toBe('book_source_save');
    expect(JSON.parse(extracted.calls[0]?.arguments ?? '{}')).toEqual({
      rule: { baseUrl: 'https://example.test', search: { item: '.result' } },
      title: '示例',
    });
    expect(extracted.cleaned).not.toContain('invoke');
  });
});

describe('clipAssistantContext', () => {
  it('keeps short chapters whole and marks long ones truncated at the head', () => {
    expect(clipAssistantContext('  短章  ')).toEqual({ text: '短章', truncated: false });
    const long = 'a'.repeat(READER_LIMITS.maxAssistantContextChars + 5);
    const clipped = clipAssistantContext(long);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe('a'.repeat(READER_LIMITS.maxAssistantContextChars));
    expect(clipped.text.endsWith('aaaaa')).toBe(true);
  });

  it('never splits a surrogate pair at the cut boundary', () => {
    const emoji = '😀'.repeat(READER_LIMITS.maxAssistantContextChars + 1);
    const clipped = clipAssistantContext(emoji);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.length % 2).toBe(0);
    expect(clipped.text).not.toContain('\u{FFFD}');
  });

  it('honours an explicit smaller limit', () => {
    expect(clipAssistantContext('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
});

describe('assistantActionContent', () => {
  it('embeds the selection quote for explain/summarize and clips long quotes', () => {
    const explain = assistantActionContent('explain', '请解释：', '难句');
    expect(explain).toContain('请解释：');
    expect(explain).toContain('<selection>\n难句\n</selection>');
    const longQuote = '字'.repeat(READER_LIMITS.maxAssistantContextChars + 20);
    const summarize = assistantActionContent('summarize', '请总结：', longQuote);
    const body = /<selection>\n([\s\S]*)\n<\/selection>/.exec(summarize)?.[1] ?? '';
    expect(body).not.toBe(longQuote);
    expect(body).toBe('字'.repeat(READER_LIMITS.maxAssistantContextChars));
    expect(assistantActionContent('quiz', '出题指令')).toBe('出题指令');
  });
});

type InvokeMock = AssistantInvoke & {
  readonly mock: { readonly calls: ReadonlyArray<[string, Record<string, unknown>?]> };
};

describe('streamAssistantChat', () => {
  it('forwards channel deltas and parses the terminal state', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onEvent as { onmessage: (event: unknown) => void };
      channel.onmessage({ type: 'delta', text: '你' });
      channel.onmessage({ type: 'delta', text: '好' });
      channel.onmessage({ type: 'ignore' });
      return { finish: 'stop', totalChars: 2 };
    }) as unknown as InvokeMock;
    const deltas: string[] = [];
    const done = await streamAssistantChat(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      (delta) => deltas.push(delta),
      {
        invoke,
        createChannel: <T>() =>
          ({ onmessage: () => undefined }) as { onmessage: (message: T) => void },
      },
    );
    expect(deltas).toEqual(['你', '好']);
    expect(done).toEqual({ finish: 'stop', totalChars: 2, toolCalls: [] });
    const payload = invoke.mock.calls[0]?.[1] as {
      messages: unknown[];
      tools: unknown;
      onEvent: unknown;
    };
    expect(payload.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(payload.tools).toEqual([]);
    expect(payload.onEvent).toBeDefined();
  });

  it('collects tool_call events and terminal toolCalls', async () => {
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onEvent as { onmessage: (event: unknown) => void };
      channel.onmessage({
        type: 'tool_call',
        id: 'c1',
        name: 'query_book',
        arguments: '{"action":"toc"}',
      });
      return {
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: '{"action":"toc"}' }],
      };
    }) as unknown as InvokeMock;
    const done = await streamAssistantChat(
      { messages: [{ role: 'user', content: '目录' }], tools: [] },
      () => undefined,
      {
        invoke,
        createChannel: () => ({ onmessage: () => undefined }),
      },
    );
    expect(done.finish).toBe('tool_calls');
    expect(done.toolCalls).toEqual([
      { id: 'c1', name: 'query_book', arguments: '{"action":"toc"}' },
    ]);
  });

  it('normalizes a missing terminal payload', async () => {
    const done = await streamAssistantChat({ messages: [], tools: [] }, () => undefined, {
      invoke: vi.fn(async () => undefined),
      createChannel: () => ({ onmessage: () => undefined }),
    });
    expect(done).toEqual({ finish: 'closed', totalChars: 0, toolCalls: [] });
  });

  it('drops the Channel on abort so the invoke can surface AI_STREAM_ABORTED', async () => {
    let abortFn: (() => void) | null = null;
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const channel = args?.onEvent as { cleanupCallback?: () => void };
      return await new Promise((_resolve, reject) => {
        const previous = channel.cleanupCallback;
        channel.cleanupCallback = () => {
          previous?.();
          reject({ code: 'AI_STREAM_ABORTED', message: '流式通道已关闭' });
        };
      });
    });
    const pending = streamAssistantChat(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      () => undefined,
      {
        invoke,
        createChannel: () => ({
          onmessage: () => undefined,
          cleanupCallback() {
            return undefined;
          },
        }),
        onStart: (abort) => {
          abortFn = abort;
        },
      },
    );
    await flush();
    expect(abortFn).not.toBeNull();
    abortFn!();
    await expect(pending).rejects.toMatchObject({ code: 'AI_STREAM_ABORTED' });
  });
});

interface StreamScript {
  readonly emit: (text: string) => void;
  readonly messages: readonly { role: string; content: string }[];
  readonly tools: unknown;
}

type Script = (script: StreamScript) => Promise<unknown> | unknown;

function fakeStream(script: Script): {
  invoke: InvokeMock;
  createChannel: () => {
    onmessage: (message: unknown) => void;
    cleanupCallback: () => void;
  };
} {
  const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const channel = args?.onEvent as {
      onmessage: (event: unknown) => void;
      cleanupCallback?: () => void;
    };
    const messages = (args?.messages as { role: string; content: string }[]) ?? [];
    let rejectAbort: ((reason: unknown) => void) | null = null;
    const abortPromise = new Promise((_resolve, reject) => {
      rejectAbort = reject;
    });
    const previous = channel.cleanupCallback;
    channel.cleanupCallback = () => {
      previous?.();
      rejectAbort?.({ code: 'AI_STREAM_ABORTED', message: '流式通道已关闭' });
    };
    return await Promise.race([
      script({
        emit: (text: string) => {
          channel.onmessage({ type: 'delta', text });
        },
        messages,
        tools: args?.tools,
      }),
      abortPromise,
    ]);
  });
  return {
    invoke: invoke as unknown as InvokeMock,
    createChannel: () => ({
      onmessage: () => undefined,
      cleanupCallback() {
        return undefined;
      },
    }),
  };
}

interface MountOptions {
  readonly configured?: boolean;
  readonly chapter?: { title: string; text: string; kind?: 'flow' | 'pdf' | 'cbz' } | null;
  readonly historyKey?: string | null;
  readonly historyJson?: string;
  readonly script?: Script;
  readonly currentSelection?: string | (() => string);
  readonly currentPage?: number;
  readonly createToolSession?: () => AssistantToolSession;
  readonly systemPrompt?: () => string;
  readonly placeholder?: string;
  readonly showPermissionMode?: boolean;
  readonly showQuote?: boolean;
  readonly permissionStorage?: AssistantPermissionStorage | null;
  readonly jumpToLocator?: (target: { chapter?: number; page?: number }) => void;
}

function mountPanel(options: MountOptions = {}): {
  panel: ReturnType<typeof createAssistantPanel>;
  invoke: InvokeMock;
  deps: {
    openSettings: ReturnType<typeof vi.fn>;
    saveAnnotation: ReturnType<typeof vi.fn>;
    readHistory: ReturnType<typeof vi.fn>;
    writeHistory: ReturnType<typeof vi.fn>;
    jumpToLocator: ReturnType<typeof vi.fn>;
  };
} {
  const script: Script =
    options.script ??
    (async ({ emit }) => {
      emit('回答内容');
      return { finish: 'stop', totalChars: 4 };
    });
  const stream = fakeStream(script);
  const calls = {
    openSettings: vi.fn(),
    saveAnnotation: vi.fn(),
    readHistory: vi.fn(async () => options.historyJson ?? ''),
    writeHistory: vi.fn(async () => undefined),
    jumpToLocator: vi.fn(options.jumpToLocator),
  };
  const deps: AssistantPanelDeps = {
    t,
    host: () => host,
    chapterContext: () => options.chapter ?? null,
    openSettings: calls.openSettings,
    saveAnnotation: calls.saveAnnotation,
    fetchConfig: async () => ({
      configured: options.configured ?? true,
      missing: [],
    }),
    readHistory: options.historyKey === null ? undefined : calls.readHistory,
    writeHistory: options.historyKey === null ? undefined : calls.writeHistory,
    historyKey: () => options.historyKey ?? null,
    stream,
    currentSelection: () =>
      typeof options.currentSelection === 'function'
        ? options.currentSelection()
        : (options.currentSelection ?? ''),
    currentPage: () => options.currentPage,
    createToolSession: options.createToolSession,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
    ...(options.showPermissionMode !== undefined
      ? { showPermissionMode: options.showPermissionMode }
      : {}),
    ...(options.showQuote !== undefined ? { showQuote: options.showQuote } : {}),
    ...(options.permissionStorage !== undefined
      ? { permissionStorage: options.permissionStorage }
      : {}),
    jumpToLocator: calls.jumpToLocator,
  };
  const panel = createAssistantPanel(deps);
  return { panel, invoke: stream.invoke, deps: calls };
}

const host = document.createElement('div');
host.className = 'lightink-reader';
document.body.append(host);

function bubbleTexts(panel: ReturnType<typeof createAssistantPanel>, role: string): string[] {
  return [...panel.element.querySelectorAll(`.lightink-reader-assistant-message[data-role="${role}"]`)].map(
    (bubble) => bubble.querySelector('.lightink-reader-assistant-message-text')?.textContent ?? '',
  );
}

function submitQuestion(panel: ReturnType<typeof createAssistantPanel>, question: string): void {
  const input = panel.element.querySelector<HTMLTextAreaElement>('.lightink-reader-assistant-input');
  expect(input).not.toBeNull();
  input!.value = question;
  panel.element
    .querySelector('.lightink-reader-assistant-composer')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function actionButton(
  panel: ReturnType<typeof createAssistantPanel>,
  action: string,
): HTMLButtonElement {
  const button = panel.element.querySelector<HTMLButtonElement>(
    `[data-assistant-action="${action}"]`,
  );
  expect(button, `missing quick action ${action}`).not.toBeNull();
  return button!;
}

function v1History(messages: AssistantHistoryMessage[]): string {
  return JSON.stringify({ version: 1, messages, updatedAt: 1 });
}

describe('createAssistantPanel unconfigured guide (R5)', () => {
  it('shows the guide with a settings entry instead of an empty chat box', async () => {
    const { panel, deps } = mountPanel({ configured: false });
    panel.open();
    await flush();
    const guide = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-guide');
    const main = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main');
    expect(guide?.hidden).toBe(false);
    expect(main?.hidden).toBe(true);
    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-settings')?.click();
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  it('switches to the chat view when the configured event arrives', async () => {
    let configured = false;
    const script = fakeStream(async ({ emit }) => {
      emit('ok');
      return { finish: 'stop', totalChars: 2 };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => ({ title: '第一章', text: '正文' }),
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured, missing: [] }),
      stream: script,
    });
    panel.open();
    await flush();
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main')?.hidden).toBe(
      true,
    );
    configured = true;
    document.dispatchEvent(
      new CustomEvent('lightink:reader-ai-configured', { detail: { configured: true } }),
    );
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main')?.hidden).toBe(
      false,
    );
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-guide')?.hidden).toBe(
      true,
    );
    panel.destroy();
  });
});

describe('createAssistantPanel streaming conversation', () => {
  it('streams an answer progressively and persists the exchange per book hash', async () => {
    const { panel, invoke, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: '第一章', text: '章节正文' },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '这章讲什么?');
    await flush();

    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]?.[1] as {
      messages: { role: string; content: string }[];
      tools: { name: string }[];
    };
    expect(payload.tools.map((tool) => tool.name)).toEqual(['query_book', 'save_to_book']);
    expect(payload.messages[0]?.role).toBe('system');
    expect(payload.messages.some((message) => message.content.includes('章节正文'))).toBe(true);
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '这章讲什么?',
    });
    expect(bubbleTexts(panel, 'user')).toEqual(['这章讲什么?']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答内容']);

    expect(deps.writeHistory).toHaveBeenCalledTimes(1);
    const [key, json] = deps.writeHistory.mock.calls[0] as unknown as [string, string];
    expect(key).toBe('0123456789abcdef');
    const persisted = parseAssistantHistoryStore(json);
    expect(persisted.version).toBe(2);
    const active = persisted.conversations.find((conversation) => conversation.id === persisted.activeId);
    expect(active?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(active?.messages[1]?.content).toBe('回答内容');
    panel.destroy();
  });

  it('flips data-status waiting → streaming → done around the first delta', async () => {
    let emitDelta: ((text: string) => void) | null = null;
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: ({ emit }) =>
        new Promise((resolve) => {
          emitDelta = emit;
          release = resolve;
        }),
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();

    const waitingBubble = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-message[data-role="assistant"]',
    );
    expect(waitingBubble?.dataset.status).toBe('waiting');
    expect(
      waitingBubble?.querySelector('.lightink-reader-assistant-waiting-label')?.textContent,
    ).toBe(t('reader.assistant.streaming'));
    expect(
      waitingBubble?.querySelectorAll('.lightink-reader-assistant-waiting-dot').length,
    ).toBe(3);
    expect(bubbleTexts(panel, 'assistant')).toEqual([t('reader.assistant.streaming')]);

    emitDelta!('流式首字');
    await flush();
    const streamingBubble = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-message[data-role="assistant"]',
    );
    expect(streamingBubble?.dataset.status).toBe('streaming');
    expect(streamingBubble?.querySelector('.lightink-reader-assistant-waiting')).toBeNull();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['流式首字']);

    release!({ finish: 'stop', totalChars: 4 });
    await flush();
    const doneBubble = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-message[data-role="assistant"]',
    );
    expect(doneBubble?.dataset.status).toBe('done');
    expect(bubbleTexts(panel, 'assistant')).toEqual(['流式首字']);
    panel.destroy();
  });

  it('carries prior turns so follow-up questions keep context', async () => {
    const { panel, invoke } = mountPanel({ chapter: { title: 'C1', text: 'T1' } });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '追问');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    const first = invoke.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    const second = invoke.mock.calls[1]?.[1] as { messages: { role: string; content: string }[] };
    const prefix = (messages: { role: string; content: string }[]): string =>
      JSON.stringify(messages.filter((message) => message.role === 'system'));
    expect(prefix(first.messages)).toBe(prefix(second.messages));
    expect(second.messages.some((message) => message.content === '第一问')).toBe(true);
    expect(second.messages.some((message) => message.content === '回答内容')).toBe(true);
    expect(second.messages[second.messages.length - 1]).toEqual({ role: 'user', content: '追问' });
    panel.destroy();
  });

  it('warns before the answer when the chapter context was clipped', async () => {
    const longChapter = '章'.repeat(READER_LIMITS.maxAssistantContextChars + 100);
    const { panel, invoke } = mountPanel({
      chapter: { title: '长章', text: longChapter },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '总结');
    await flush();

    const chapterMessage = (
      invoke.mock.calls[0]?.[1] as { messages: { content: string }[] }
    ).messages.find((message) => message.content.includes('<chapter>'));
    expect(chapterMessage?.content).toContain('章'.repeat(10));
    expect(chapterMessage?.content.endsWith('章'.repeat(100))).toBe(false);

    const bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    const answer = bubbles[bubbles.length - 1]!;
    const notice = answer.querySelector('.lightink-reader-assistant-notice');
    expect(notice?.textContent).toContain(String(READER_LIMITS.maxAssistantContextChars));
    expect(answer.firstElementChild?.className).toBe('lightink-reader-assistant-notice');
    panel.destroy();
  });

  it('shows the error with an in-place retry that resends the same request', async () => {
    let fail = true;
    const { panel, invoke } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        if (fail) {
          emit('半截');
          throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
        }
        emit('恢复后的回答');
        return { finish: 'stop', totalChars: 7 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();

    let bubbles =
      panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
    const failed = bubbles[1]!;
    expect(failed.dataset.status).toBe('error');
    expect(failed.querySelector('.lightink-reader-assistant-error')?.textContent).toContain(
      '无法连接 AI 服务',
    );
    expect(failed.querySelector('.lightink-reader-assistant-retry')).not.toBeNull();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截']);

    fail = false;
    failed.querySelector<HTMLButtonElement>('.lightink-reader-assistant-retry')?.click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    bubbles = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]?.dataset.status).toBe('done');
    expect(bubbleTexts(panel, 'assistant')).toEqual(['恢复后的回答']);
    expect(panel.element.querySelector('.lightink-reader-assistant-retry')).toBeNull();
    panel.destroy();
  });

  it('keeps the draft when submitting while a stream is in flight', async () => {
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        emit('慢回答');
        await new Promise((resolve) => {
          release = resolve;
        });
        return { finish: 'stop', totalChars: 3 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    const input = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(input?.value).toBe('第二问');
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问']);
    (release as ((value: unknown) => void) | null)?.(null);
    await flush();
    panel.destroy();
  });

  it('renders assistant replies as markdown and keeps user bubbles as plain text', async () => {
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        emit('# 标题\n\n- 一项');
        return { finish: 'stop', totalChars: 10 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '**用户粗体**');
    await flush();
    const user = panel.element.querySelector('.lightink-reader-assistant-message.is-user');
    expect(user?.querySelector('strong')).toBeNull();
    expect(user?.textContent).toContain('**用户粗体**');
    const assistant = panel.element.querySelector('.lightink-reader-assistant-message.is-assistant');
    expect(assistant?.querySelector('h1')?.textContent).toBe('标题');
    expect(assistant?.querySelector('li')?.textContent).toBe('一项');
    panel.destroy();
  });
});

describe('createAssistantPanel composer (R1)', () => {
  it('defaults the input to multiple lines and grows with content', async () => {
    const { panel } = mountPanel();
    panel.open();
    await flush();
    const input = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(input?.rows).toBe(2);
    Object.defineProperty(input!, 'scrollHeight', { configurable: true, value: 120 });
    input!.value = '第一行\n第二行\n第三行\n第四行\n第五行';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input?.style.height).toBe('120px');
    panel.destroy();
  });

  it('quotes live selection at click even if the panel opened without one', async () => {
    let selection = '';
    const { panel, invoke } = mountPanel({ currentSelection: () => selection });
    panel.open();
    await flush();
    const quote = panel.element.querySelector<HTMLButtonElement>('[data-assistant-quote]');
    const chip = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-quote-chip');
    expect(quote?.disabled).toBe(true);
    expect(quote?.title).toBe(t('reader.assistant.quoteUnavailable'));
    quote!.click();
    const input = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(chip?.hidden).toBe(true);
    expect(input?.value).toBe('');

    selection = '后来选中的句子';
    document.dispatchEvent(new Event('selectionchange'));
    expect(quote?.disabled).toBe(false);
    expect(quote?.classList.contains('is-ready')).toBe(true);
    expect(quote?.title).toBe(t('reader.assistant.quoteReady'));
    quote!.click();
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('后来选中的句子');
    expect(input?.value).toBe('');
    submitQuestion(panel, '这句话什么意思');
    await flush();
    expect(
      panel.element.querySelector('.lightink-reader-assistant-quote-excerpt')?.textContent,
    ).toBe('后来选中的句子');
    expect(bubbleTexts(panel, 'user')[0]).toBe('这句话什么意思');
    const payload = invoke.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    const last = payload.messages[payload.messages.length - 1]?.content ?? '';
    expect(last).toContain('<selection>\n后来选中的句子\n</selection>');
    expect(last).toContain('这句话什么意思');
    panel.destroy();
  });

  it('stops generation, keeps partial text, and allows another question', async () => {
    const { panel, invoke } = mountPanel({
      script: async ({ emit }) => {
        emit('半截回答');
        await new Promise(() => undefined);
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    expect(bubbleTexts(panel, 'assistant')[0]).toContain('半截回答');
    expect(
      panel.element.querySelector<HTMLElement>(
        '.lightink-reader-assistant-message[data-role="assistant"]',
      )?.dataset.status,
    ).toBe('streaming');
    const stop = panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]');
    expect(stop?.hidden).toBe(false);
    expect(stop?.disabled).toBe(false);
    stop!.click();
    await flush();
    const stopped = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-message[data-role="assistant"]',
    );
    expect(stopped?.dataset.status).toBe('stopped');
    expect(bubbleTexts(panel, 'assistant')[0]).toContain('半截回答');
    expect(stopped?.querySelector('.lightink-reader-assistant-stopped')?.textContent).toBe(
      t('reader.assistant.stopped'),
    );
    // 停止是中性终态：不出现错误样式与重试入口。
    expect(stopped?.querySelector('.lightink-reader-assistant-error')).toBeNull();
    expect(stopped?.querySelector('.lightink-reader-assistant-retry')).toBeNull();
    expect(stop?.hidden).toBe(true);
    expect(stop?.disabled).toBe(true);
    submitQuestion(panel, '第二问');
    await flush();
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问', '第二问']);
    // 后续重渲染不把已停止消息退回进行中/失败态。
    const bubbles = panel.element.querySelectorAll<HTMLElement>(
      '.lightink-reader-assistant-message',
    );
    expect(bubbles[1]?.dataset.status).toBe('stopped');
    panel.destroy();
  });
});

describe('createAssistantPanel message actions (R5)', () => {
  function stubClipboard(writeText: (text: string) => Promise<void>): () => void {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    return () => {
      if (previous === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
        return;
      }
      Object.defineProperty(navigator, 'clipboard', previous);
    };
  }

  function actionIn(bubble: Element | null, kind: string): HTMLButtonElement | null {
    return (
      bubble?.querySelector<HTMLButtonElement>(`[data-assistant-action-kind="${kind}"]`) ?? null
    );
  }

  function assistantBubble(
    panel: ReturnType<typeof createAssistantPanel>,
    index = 0,
  ): HTMLElement | null {
    return (
      panel.element.querySelectorAll<HTMLElement>(
        '.lightink-reader-assistant-message[data-role="assistant"]',
      )[index] ?? null
    );
  }

  // 复制反馈状态由微任务链更新；fake timers 下无法用 flush 的宏任务等待。
  const drainMicrotasks = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  };

  it('copies the raw markdown, flashes a short-lived copied notice, and skips history', async () => {
    const writeText = vi.fn(async () => undefined);
    const restoreClipboard = stubClipboard(writeText);
    try {
      const { panel, deps } = mountPanel({
        historyKey: '0123456789abcdef',
        script: async ({ emit }) => {
          emit('**粗体**回答');
          return { finish: 'stop', totalChars: 8 };
        },
      });
      panel.open();
      await flush();
      submitQuestion(panel, '问题');
      await flush();
      const historyWrites = deps.writeHistory.mock.calls.length;

      const copy = actionIn(assistantBubble(panel), 'copy');
      expect(copy).not.toBeNull();
      expect(copy?.disabled).toBe(false);
      expect(copy?.getAttribute('aria-label')).toBe(t('reader.assistant.copy'));

      vi.useFakeTimers();
      try {
        copy!.click();
        await drainMicrotasks();
        expect(writeText).toHaveBeenCalledWith('**粗体**回答');
        const status = panel.element.querySelector<HTMLElement>('[data-assistant-copy-status]');
        expect(status?.textContent).toBe(t('reader.assistant.copied'));
        expect(status?.dataset.assistantCopyStatus).toBe('ok');
        expect(status?.getAttribute('aria-live')).toBe('polite');

        // 反馈短时停留：到点后自动消失。
        vi.advanceTimersByTime(ASSISTANT_COPY_FEEDBACK_MS + 20);
        expect(panel.element.querySelector('[data-assistant-copy-status]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
      // 复制不写入历史。
      expect(deps.writeHistory.mock.calls.length).toBe(historyWrites);
      panel.destroy();
    } finally {
      restoreClipboard();
    }
  });

  it('shows a readable inline hint when the clipboard write fails', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    const execCommand = vi.fn(() => false);
    const restoreClipboard = stubClipboard(writeText);
    const previousExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    try {
      const { panel } = mountPanel({
        script: async ({ emit }) => {
          emit('回答');
          return { finish: 'stop', totalChars: 2 };
        },
      });
      panel.open();
      await flush();
      submitQuestion(panel, '问题');
      await flush();

      actionIn(assistantBubble(panel), 'copy')!.click();
      await flush();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledWith('copy');
      const status = panel.element.querySelector<HTMLElement>('[data-assistant-copy-status]');
      expect(status?.textContent).toBe(t('reader.assistant.copyFailed'));
      expect(status?.dataset.assistantCopyStatus).toBe('error');
      panel.destroy();
    } finally {
      if (previousExec === undefined) {
        Reflect.deleteProperty(document, 'execCommand');
      } else {
        Object.defineProperty(document, 'execCommand', previousExec);
      }
      restoreClipboard();
    }
  });

  it('regenerates from the matching user turn and removes the messages after it', async () => {
    let round = 0;
    const { panel, invoke } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        round += 1;
        emit(`回答${round}`);
        return { finish: 'stop', totalChars: 3 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答1', '回答2']);

    const regenerate = actionIn(assistantBubble(panel, 0), 'regenerate');
    expect(regenerate).not.toBeNull();
    expect(regenerate?.disabled).toBe(false);
    regenerate!.click();
    await flush();

    expect(invoke).toHaveBeenCalledTimes(3);
    const payload = invoke.mock.calls[2]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '第一问',
    });
    // 重新生成沿用该条对应用户消息及之前的会话；其后的轮次被移除。
    expect(payload.messages.some((message) => message.content === '第二问')).toBe(false);
    expect(payload.messages.some((message) => message.content === '回答1')).toBe(false);
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答3']);
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-message')).toHaveLength(2);
    panel.destroy();
  });

  it('keeps the original reply when regeneration fails', async () => {
    let round = 0;
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('原回答');
          return { finish: 'stop', totalChars: 3 };
        }
        emit('新回答的开头');
        throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();
    actionIn(assistantBubble(panel), 'regenerate')!.click();
    await flushUntil(() => assistantBubble(panel)?.dataset.status === 'error');

    expect(bubbleTexts(panel, 'assistant')).toEqual(['原回答']);
    const bubble = assistantBubble(panel);
    expect(actionIn(bubble, 'retry')).not.toBeNull();
    expect(actionIn(bubble, 'regenerate')).toBeNull();
    expect(actionIn(bubble, 'copy')).not.toBeNull();
    panel.destroy();
  });

  it('continues a stopped reply with the fixed prompt and appends after the existing text', async () => {
    let round = 0;
    const { panel, invoke } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('半截回答');
          await new Promise(() => undefined);
        }
        emit('，续写的后半段');
        return { finish: 'stop', totalChars: 8 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]')!.click();
    await flush();

    const continueButton = actionIn(assistantBubble(panel), 'continue');
    expect(continueButton).not.toBeNull();
    expect(continueButton?.disabled).toBe(false);
    continueButton!.click();
    await flushUntil(() => (bubbleTexts(panel, 'assistant')[0] ?? '').includes('续写的后半段'));

    const payload = invoke.mock.calls[1]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: t('reader.assistant.continuePrompt'),
    });
    expect(payload.messages[payload.messages.length - 2]).toEqual({
      role: 'assistant',
      content: '半截回答',
    });
    expect(payload.messages.some((message) => message.content === '第一问')).toBe(true);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截回答，续写的后半段']);
    expect(assistantBubble(panel)?.dataset.status).toBe('done');
    expect(actionIn(assistantBubble(panel), 'continue')).toBeNull();
    expect(actionIn(assistantBubble(panel), 'regenerate')).not.toBeNull();
    panel.destroy();
  });

  it('keeps the stopped text and falls back to error + retry when continuing fails', async () => {
    let round = 0;
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('半截回答');
          await new Promise(() => undefined);
        }
        throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]')!.click();
    await flush();
    actionIn(assistantBubble(panel), 'continue')!.click();
    await flushUntil(() => assistantBubble(panel)?.dataset.status === 'error');

    const bubble = assistantBubble(panel);
    expect(bubble?.dataset.status).toBe('error');
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截回答']);
    expect(bubble?.querySelector('.lightink-reader-assistant-error')?.textContent).toContain(
      '无法连接 AI 服务',
    );
    expect(bubble?.querySelector('.lightink-reader-assistant-stopped')).toBeNull();
    expect(actionIn(bubble, 'retry')).not.toBeNull();
    expect(actionIn(bubble, 'continue')).toBeNull();
    panel.destroy();
  });

  it('disables message actions while a stream is in flight', async () => {
    let round = 0;
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('第一答');
          return { finish: 'stop', totalChars: 3 };
        }
        emit('第二答开头');
        await new Promise((resolve) => {
          release = resolve;
        });
        return { finish: 'stop', totalChars: 6 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['第一答', '第二答开头']);

    const buttons = [
      ...panel.element.querySelectorAll<HTMLButtonElement>('[data-assistant-action-kind]'),
    ];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
    expect(actionIn(assistantBubble(panel, 0), 'regenerate')).not.toBeNull();
    expect(actionIn(assistantBubble(panel, 1), 'copy')).not.toBeNull();

    (release as ((value: unknown) => void) | null)?.(null);
    await flush();
    const settled = [
      ...panel.element.querySelectorAll<HTMLButtonElement>('[data-assistant-action-kind]'),
    ];
    expect(settled.some((button) => !button.disabled)).toBe(true);
    panel.destroy();
  });

  it('renders no actions for an assistant message without text', async () => {
    const { panel } = mountPanel({
      script: async () => ({ finish: 'stop', totalChars: 0 }),
    });
    panel.open();
    await flush();
    submitQuestion(panel, '空回答');
    await flush();
    const bubble = assistantBubble(panel);
    expect(bubble?.dataset.status).toBe('done');
    expect(bubble?.querySelector('.lightink-reader-assistant-message-actions')).toBeNull();
    expect(bubble?.querySelectorAll('[data-assistant-action-kind]').length).toBe(0);
    panel.destroy();
  });

  it('still offers retry when a failed reply has no text', async () => {
    const { panel } = mountPanel({
      script: async () => {
        throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '失败');
    await flush();
    const bubble = assistantBubble(panel);
    expect(bubble?.dataset.status).toBe('error');
    expect(actionIn(bubble, 'retry')).not.toBeNull();
    expect(actionIn(bubble, 'copy')).toBeNull();
    panel.destroy();
  });
});

describe('createAssistantPanel user message edit (R6)', () => {
  function userBubble(
    panel: ReturnType<typeof createAssistantPanel>,
    index = 0,
  ): HTMLElement | null {
    return (
      panel.element.querySelectorAll<HTMLElement>(
        '.lightink-reader-assistant-message[data-role="user"]',
      )[index] ?? null
    );
  }

  function editButtonIn(bubble: Element | null): HTMLButtonElement | null {
    return (
      bubble?.querySelector<HTMLButtonElement>('[data-assistant-action-kind="edit"]') ?? null
    );
  }

  function editorIn(panel: ReturnType<typeof createAssistantPanel>): HTMLTextAreaElement | null {
    return panel.element.querySelector<HTMLTextAreaElement>('[data-assistant-edit-input]');
  }

  it('switches a user bubble into an inline textarea and restores the original on cancel', async () => {
    const { panel, invoke } = mountPanel({ chapter: { title: 'C1', text: 'T1' } });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    const requests = invoke.mock.calls.length;

    const edit = editButtonIn(userBubble(panel, 0));
    expect(edit).not.toBeNull();
    expect(edit?.disabled).toBe(false);
    expect(edit?.textContent).toBe(t('reader.assistant.edit'));

    edit!.click();
    const first = userBubble(panel, 0);
    expect(first?.dataset.editing).toBe('true');
    expect(first?.querySelector('.lightink-reader-assistant-message-text')).toBeNull();
    const editor = editorIn(panel);
    expect(editor).not.toBeNull();
    expect(editor?.value).toBe('第一问');
    expect(editor?.rows).toBe(2);
    expect(editor?.getAttribute('aria-label')).toBe(t('reader.assistant.edit'));
    // 编辑态进入即聚焦；同一时间只开一个编辑器。
    expect(document.activeElement).toBe(editor);
    expect(editButtonIn(userBubble(panel, 1))?.disabled).toBe(true);

    editor!.value = '丢弃的草稿';
    first?.querySelector<HTMLButtonElement>('[data-assistant-edit-cancel]')?.click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(requests);
    const restored = userBubble(panel, 0);
    expect(restored?.dataset.editing).toBeUndefined();
    expect(editorIn(panel)).toBeNull();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问', '第二问']);
    expect(bubbleTexts(panel, 'assistant')).toHaveLength(2);
    // 取消后焦点回到原消息，其它消息恢复可编辑。
    expect(document.activeElement).toBe(restored);
    expect(editButtonIn(userBubble(panel, 1))?.disabled).toBe(false);
    panel.destroy();
  });

  it('keeps Shift+Enter as a newline, ignores composing Enter, and cancels on Escape', async () => {
    const { panel, invoke } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        emit('回答内容');
        return { finish: 'stop', totalChars: 4 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    editor.value = '第一行\n第二行';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(editorIn(panel)?.value).toBe('第一行\n第二行');

    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await flush();
    expect(editorIn(panel)).toBeNull();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问']);
    expect(invoke).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('resubmits the edited body, keeps the quoted selection, and drops the later turns', async () => {
    let round = 0;
    const { panel, invoke } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      currentSelection: '引用句',
      script: async ({ emit }) => {
        round += 1;
        emit(`回答${round}`);
        return { finish: 'stop', totalChars: 3 };
      },
    });
    panel.open();
    await flush();
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-quote]')!.click();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问', '第二问']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答1', '回答2']);

    editButtonIn(userBubble(panel, 0))!.click();
    const editing = userBubble(panel, 0);
    // 引用选区卡片保留且不可编辑；编辑框只预填正文。
    expect(
      editing?.querySelector('.lightink-reader-assistant-quote-card')?.textContent,
    ).toContain('引用句');
    const editor = editorIn(panel);
    expect(editor?.value).toBe('第一问');

    editor!.value = '改写后的问题';
    editor!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushUntil(() => invoke.mock.calls.length === 3);

    const payload = invoke.mock.calls[2]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '<selection>\n引用句\n</selection>\n改写后的问题',
    });
    // 该条之后的会话被截断，重新请求不携带旧轮次。
    expect(payload.messages.some((message) => message.content === '第二问')).toBe(false);
    expect(payload.messages.some((message) => message.content === '回答2')).toBe(false);
    expect(bubbleTexts(panel, 'user')).toEqual(['改写后的问题']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答3']);
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-message')).toHaveLength(2);
    expect(editorIn(panel)).toBeNull();
    panel.destroy();
  });

  it('submits via the button and clears the quick-action tag on the rewritten message', async () => {
    const { panel, invoke, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: 'C1', text: 'T1' },
    });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flushUntil(() => bubbleTexts(panel, 'user').length === 1);
    expect(userBubble(panel, 0)?.dataset.action).toBe('chapterSummary');

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    expect(editor.value).toBe(t('reader.assistant.prompt.chapterSummary'));
    editor.value = '改写摘要';
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-edit-submit]')!
      .click();
    await flushUntil(() => invoke.mock.calls.length === 2);

    const payload = invoke.mock.calls[1]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '改写摘要',
    });
    // 内容已由用户改写：气泡与持久化都清掉 action 标记。
    expect(userBubble(panel, 0)?.dataset.action).toBeUndefined();
    expect(bubbleTexts(panel, 'user')).toEqual(['改写摘要']);
    const writes = deps.writeHistory.mock.calls as unknown as Array<[string, string]>;
    const store = parseAssistantHistoryStore(writes[writes.length - 1]?.[1] ?? '');
    const active = store.conversations.find(
      (conversation) => conversation.id === store.activeId,
    );
    expect(active?.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(active?.messages[0]?.content).toBe('改写摘要');
    expect(active?.messages[0]?.action).toBeUndefined();
    panel.destroy();
  });

  it('persists the truncated conversation so a reopened session keeps the edited state', async () => {
    let round = 0;
    const { panel, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        round += 1;
        emit(`回答${round}`);
        return { finish: 'stop', totalChars: 3 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    editor.value = '第一问改';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushUntil(
      () => bubbleTexts(panel, 'assistant').length === 1 && bubbleTexts(panel, 'assistant')[0] === '回答3',
    );
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问改']);

    // 关闭重开（同一实例）保持内存态；磁盘态也不含被截断的轮次。
    panel.close();
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问改']);
    const writes = deps.writeHistory.mock.calls as unknown as Array<[string, string]>;
    const persisted = writes[writes.length - 1]?.[1] ?? '';
    expect(persisted).not.toContain('第二问');
    expect(persisted).not.toContain('回答2');
    panel.destroy();

    // 新面板从持久化历史重载：仍是截断后的状态，schema 不变。
    const reopened = mountPanel({
      historyKey: '0123456789abcdef',
      historyJson: persisted,
    });
    reopened.panel.open();
    await flush();
    expect(bubbleTexts(reopened.panel, 'user')).toEqual(['第一问改']);
    expect(bubbleTexts(reopened.panel, 'assistant')).toEqual(['回答3']);
    expect(reopened.panel.element.querySelectorAll('.lightink-reader-assistant-message')).toHaveLength(
      2,
    );
    const reloaded = parseAssistantHistoryStore(persisted);
    expect(reloaded.version).toBe(2);
    reopened.panel.destroy();
  });

  it('disables the edit entry while a stream is in flight', async () => {
    let round = 0;
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('第一答');
          return { finish: 'stop', totalChars: 3 };
        }
        emit('第二答开头');
        await new Promise((resolve) => {
          release = resolve;
        });
        return { finish: 'stop', totalChars: 6 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();

    const edit = editButtonIn(userBubble(panel, 0));
    expect(edit).not.toBeNull();
    expect(edit?.disabled).toBe(true);
    edit!.click();
    expect(editorIn(panel)).toBeNull();

    (release as ((value: unknown) => void) | null)?.(null);
    await flush();
    expect(editButtonIn(userBubble(panel, 0))?.disabled).toBe(false);
    panel.destroy();
  });

  it('edits a pure quote message without feeding the marker back into the body', async () => {
    const { panel, invoke, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: 'C1', text: 'T1' },
      currentSelection: '引用句',
    });
    panel.open();
    await flush();
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-quote]')!.click();
    submitQuestion(panel, '');
    await flushUntil(() => bubbleTexts(panel, 'assistant').length === 1);

    const first = invoke.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    expect(first.messages[first.messages.length - 1]).toEqual({
      role: 'user',
      content: '<selection>\n引用句\n</selection>',
    });

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel);
    // 纯引用消息只编辑正文：编辑框留空，引用卡片保留，不回填含标记的原文。
    expect(editor?.value).toBe('');
    expect(
      userBubble(panel, 0)?.querySelector('.lightink-reader-assistant-quote-card')?.textContent,
    ).toContain('引用句');

    editor!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushUntil(() => invoke.mock.calls.length === 2);

    const sent = (
      invoke.mock.calls[1]?.[1] as { messages: { role: string; content: string }[] }
    ).messages;
    const last = sent[sent.length - 1]!;
    expect(last).toEqual({ role: 'user', content: '<selection>\n引用句\n</selection>' });
    expect(last.content.match(/<selection>/g)).toHaveLength(1);
    expect(last.content.match(/<\/selection>/g)).toHaveLength(1);

    const bubble = userBubble(panel, 0);
    expect(bubble?.querySelectorAll('.lightink-reader-assistant-quote-card')).toHaveLength(1);
    expect(bubble?.querySelector('.lightink-reader-assistant-message-text')).toBeNull();
    expect(bubble?.textContent).not.toContain('<selection>');

    const writes = deps.writeHistory.mock.calls as unknown as Array<[string, string]>;
    const persisted = parseAssistantHistoryStore(writes[writes.length - 1]?.[1] ?? '');
    const active = persisted.conversations.find(
      (conversation) => conversation.id === persisted.activeId,
    );
    expect(active?.messages[0]?.content).toBe('<selection>\n引用句\n</selection>');

    await flushUntil(() => invoke.mock.calls.length === 2 && editorIn(panel) === null);
    expect(userBubble(panel, 1)).toBeNull();
    expect(bubbleTexts(panel, 'assistant')).toHaveLength(1);
    panel.destroy();
  });

  it('keeps the edit draft and caret across a copy-feedback re-render', async () => {
    const writeText = vi.fn(async () => undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { panel } = mountPanel({ chapter: { title: 'C1', text: 'T1' } });
      panel.open();
      await flush();
      submitQuestion(panel, '第一问');
      await flush();

      editButtonIn(userBubble(panel, 0))!.click();
      const editor = editorIn(panel)!;
      editor.value = '未提交的草稿';
      editor.dispatchEvent(new Event('input', { bubbles: true }));

      // 复制在编辑期间保可用；反馈触发的整表重渲染不得丢草稿与焦点。
      const copy = panel.element.querySelector<HTMLButtonElement>(
        '[data-assistant-action-kind="copy"]',
      );
      expect(copy?.disabled).toBe(false);
      copy!.click();
      await flushUntil(
        () => panel.element.querySelector('[data-assistant-copy-status]') !== null,
      );

      const restored = editorIn(panel);
      expect(restored).not.toBeNull();
      expect(restored).not.toBe(editor);
      expect(restored?.value).toBe('未提交的草稿');
      expect(document.activeElement).toBe(restored);

      // 草稿仍可提交：提交的是草稿内容而不是丢失后的原文。
      restored!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushUntil(() => bubbleTexts(panel, 'user').includes('未提交的草稿'));
      panel.destroy();
    } finally {
      if (previousClipboard === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', previousClipboard);
      }
    }
  });

  it('locks composer, quick actions, and assistant actions while editing', async () => {
    let round = 0;
    const { panel, invoke } = mountPanel({
      chapter: { title: 'C1', text: 'T1' },
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('半截回答');
          await new Promise(() => undefined);
        }
        if (round === 3) {
          throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
        }
        emit('回答2');
        return { finish: 'stop', totalChars: 3 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]')!.click();
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    submitQuestion(panel, '第三问');
    await flushUntil(() => invoke.mock.calls.length === 3);
    await flush();
    const requests = invoke.mock.calls.length;
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截回答', '回答2', '']);
    const idleUserTexts = bubbleTexts(panel, 'user');
    const idleAssistantTexts = bubbleTexts(panel, 'assistant');

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    editor.value = '编辑中的草稿';

    const kindIn = (bubbleIndex: number, kind: string): HTMLButtonElement | null => {
      const bubbles = panel.element.querySelectorAll<HTMLElement>(
        '.lightink-reader-assistant-message[data-role="assistant"]',
      );
      return (
        bubbles[bubbleIndex]?.querySelector<HTMLButtonElement>(
          `[data-assistant-action-kind="${kind}"]`,
        ) ?? null
      );
    };
    // 编辑期间：复制保留；继续/重新生成/重试与 composer、快捷动作全部锁定。
    expect(kindIn(1, 'copy')?.disabled).toBe(false);
    expect(kindIn(0, 'continue')?.disabled).toBe(true);
    expect(kindIn(1, 'regenerate')?.disabled).toBe(true);
    expect(kindIn(2, 'retry')?.disabled).toBe(true);
    const send = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-send',
    );
    const quickAction = actionButton(panel, 'chapterSummary');
    expect(send?.disabled).toBe(true);
    expect(quickAction.disabled).toBe(true);

    kindIn(0, 'continue')!.click();
    kindIn(1, 'regenerate')!.click();
    kindIn(2, 'retry')!.click();
    quickAction.click();
    submitQuestion(panel, '编辑期间不应发送');
    await flush();
    expect(invoke.mock.calls.length).toBe(requests);
    // 编辑气泡本体切换为编辑框，其余消息不被任何发送路径改动。
    expect(bubbleTexts(panel, 'user').slice(1)).toEqual(idleUserTexts.slice(1));
    expect(bubbleTexts(panel, 'assistant')).toEqual(idleAssistantTexts);

    panel.element.querySelector<HTMLButtonElement>('[data-assistant-edit-cancel]')!.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(idleUserTexts);
    expect(bubbleTexts(panel, 'assistant')).toEqual(idleAssistantTexts);
    expect(kindIn(0, 'continue')?.disabled).toBe(false);
    expect(kindIn(1, 'regenerate')?.disabled).toBe(false);
    expect(kindIn(2, 'retry')?.disabled).toBe(false);
    expect(
      panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-send')?.disabled,
    ).toBe(false);
    expect(actionButton(panel, 'chapterSummary').disabled).toBe(false);

    // 取消后发送恢复：新的请求正常发出。
    submitQuestion(panel, '第四问');
    await flushUntil(() => invoke.mock.calls.length === requests + 1);
    panel.destroy();
  });

  it('locks pending confirm/reject while editing and restores them on cancel', async () => {
    const pendingReply = {
      ok: true,
      tool: 'classify_book',
      pending_confirmation: [
        {
          id: 'p1',
          summary: '将《示例书》归入「旧书」',
          tool: 'classify_book',
          arguments: { book: '示例书', group: '旧书' },
        },
      ],
    };
    const execute = vi.fn(async () => pendingReply);
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 1) {
        emit('回答1');
        return { finish: 'stop', totalChars: 3 };
      }
      return {
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
      };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    editButtonIn(userBubble(panel, 0))!.click();
    const confirmAll = (): HTMLButtonElement | null =>
      panel.element.querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]');
    const rejectAll = (): HTMLButtonElement | null =>
      panel.element.querySelector<HTMLButtonElement>('[data-assistant-pending-reject-all]');
    expect(confirmAll()?.disabled).toBe(true);
    expect(rejectAll()?.disabled).toBe(true);
    confirmAll()!.click();
    rejectAll()!.click();
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).not.toBeNull();

    panel.element.querySelector<HTMLButtonElement>('[data-assistant-edit-cancel]')!.click();
    await flush();
    expect(confirmAll()?.disabled).toBe(false);
    confirmAll()!.click();
    await flushUntil(() => execute.mock.calls.length >= 2);
    panel.destroy();
  });

  it('drops pending confirmations from turns truncated by an edit resubmit', async () => {
    const pendingReply = {
      ok: true,
      tool: 'classify_book',
      pending_confirmation: [
        {
          id: 'p1',
          summary: '将《示例书》归入「旧书」',
          tool: 'classify_book',
          arguments: { book: '示例书', group: '旧书' },
        },
      ],
    };
    const execute = vi.fn(async () => pendingReply);
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 2) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit(`回答${round}`);
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    expect(execute).toHaveBeenCalledTimes(1);

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    editor.value = '第一问改';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushUntil(() => bubbleTexts(panel, 'assistant').includes('回答3'));

    expect(bubbleTexts(panel, 'user')).toEqual(['第一问改']);
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden,
    ).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('drops pending confirmations from turns removed by regeneration', async () => {
    const pendingReply = {
      ok: true,
      tool: 'classify_book',
      pending_confirmation: [
        {
          id: 'p1',
          summary: '将《示例书》归入「旧书」',
          tool: 'classify_book',
          arguments: { book: '示例书', group: '旧书' },
        },
      ],
    };
    const execute = vi.fn(async () => pendingReply);
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 3) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c3', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit(`回答${round}`);
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flush();
    submitQuestion(panel, '第三问');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    expect(execute).toHaveBeenCalledTimes(1);

    const regenerate = panel.element
      .querySelectorAll<HTMLElement>('.lightink-reader-assistant-message[data-role="assistant"]')[1]
      ?.querySelector<HTMLButtonElement>('[data-assistant-action-kind="regenerate"]');
    expect(regenerate).not.toBeNull();
    regenerate!.click();
    await flushUntil(() => bubbleTexts(panel, 'assistant').includes('回答4'));

    expect(bubbleTexts(panel, 'user')).toEqual(['第一问', '第二问']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答1', '回答4']);
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('restores retained pending confirmations after editing a later text-only turn', async () => {
    const pendingReply = {
      ok: true,
      tool: 'classify_book',
      pending_confirmation: [
        {
          id: 'p1',
          summary: '将《示例书》归入「旧书」',
          tool: 'classify_book',
          arguments: { book: '示例书', group: '旧书' },
        },
      ],
    };
    const confirmPending = vi.fn(async () => ({ ok: true, tool: 'classify_book' }));
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 2) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit(`回答${round}`);
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute: vi.fn(async () => pendingReply),
      confirmPending,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    // 更早轮次产生的待确认仍在；第三轮是纯文本（无 toolBlocks）。
    submitQuestion(panel, '第三问');
    await flushUntil(() => bubbleTexts(panel, 'assistant').includes('回答3'));
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).not.toBeNull();

    // 编辑第三轮并提交：更早轮次的待确认条目保留，编辑结束后必须恢复可确认。
    editButtonIn(userBubble(panel, 2))!.click();
    const editor = editorIn(panel)!;
    editor.value = '第三问改';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flushUntil(() => bubbleTexts(panel, 'user').includes('第三问改'));

    const confirmAll = (): HTMLButtonElement | null =>
      panel.element.querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]');
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).not.toBeNull();
    expect(confirmAll()?.disabled).toBe(false);
    confirmAll()!.click();
    await flushUntil(() => confirmPending.mock.calls.length === 1);
    expect(confirmPending).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Function));
    panel.destroy();
  });

  it('returns focus to the composer after an edit submit', async () => {
    const { panel } = mountPanel({ chapter: { title: 'C1', text: 'T1' } });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();

    editButtonIn(userBubble(panel, 0))!.click();
    const editor = editorIn(panel)!;
    editor.value = '第一问改';
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    const input = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    await flushUntil(() => document.activeElement === input);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(input);
    panel.destroy();
  });
});

function memoryStorage(): AssistantPermissionStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('createAssistantPanel composer redesign (R4/R5)', () => {
  it('uses the reader placeholder by default and honours a surface-injected placeholder', async () => {
    const fallback = mountPanel();
    fallback.panel.open();
    await flush();
    let input = fallback.panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(input?.placeholder).toBe(t('reader.assistant.placeholder'));
    expect(input?.getAttribute('aria-label')).toBe(t('reader.assistant.placeholder'));
    fallback.panel.destroy();

    const injected = mountPanel({ placeholder: '查询或整理书库…' });
    injected.panel.open();
    await flush();
    input = injected.panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(input?.placeholder).toBe('查询或整理书库…');
    expect(input?.getAttribute('aria-label')).toBe('查询或整理书库…');
    injected.panel.destroy();
  });

  it('caps the input height with internal scrolling via CSS', () => {
    const css = readFileSync('src/assistant/assistant-panel.css', 'utf-8');
    const rule = /\.lightink-reader-assistant-input\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/max-height:/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('renders send/stop as icon buttons at the composer bar end and swaps them in place', async () => {
    const { panel } = mountPanel();
    panel.open();
    await flush();
    const bar = panel.element.querySelector('.lightink-reader-assistant-composer-bar');
    const send = bar?.querySelector<HTMLButtonElement>('.lightink-reader-assistant-send');
    const stop = bar?.querySelector<HTMLButtonElement>('.lightink-reader-assistant-stop');
    expect(send?.getAttribute('aria-label')).toBe(t('reader.assistant.send'));
    expect(send?.querySelector('svg')).not.toBeNull();
    expect(stop?.getAttribute('aria-label')).toBe(t('reader.assistant.stop'));
    expect(stop?.querySelector('svg')).not.toBeNull();
    // 同一位置互换：两枚图标按钮都是工具栏最末尾的邻居。
    expect(send?.nextElementSibling).toBe(stop);
    expect(stop?.nextElementSibling).toBeNull();
    expect(send?.hidden).toBe(false);
    expect(stop?.hidden).toBe(true);
    panel.destroy();
  });

  it('sends on Enter and keeps Shift+Enter as a newline', async () => {
    const { panel, invoke } = mountPanel();
    panel.open();
    await flush();
    const input = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    )!;
    input.value = '回车发送';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');

    input.value = '换行不发送';
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('换行不发送');
    panel.destroy();
  });

  it('moves the permission switch into a composer trigger with a popup radio menu', async () => {
    const storage = memoryStorage();
    const { panel } = mountPanel({ showPermissionMode: true, permissionStorage: storage });
    panel.open();
    await flush();
    const head = panel.element.querySelector('.lightink-reader-assistant-head');
    expect(head?.querySelector('.lightink-reader-assistant-modes')).toBeNull();
    expect(head?.querySelector('[data-assistant-mode]')).toBeNull();

    const bar = panel.element.querySelector('.lightink-reader-assistant-composer-bar');
    const trigger = bar?.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-mode-trigger',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain(t('reader.assistant.permissionMode.review'));
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    const menu = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-mode-menu',
    );
    expect(menu?.getAttribute('role')).toBe('radiogroup');
    expect(menu?.hidden).toBe(true);
    const options = [
      ...panel.element.querySelectorAll<HTMLButtonElement>('[data-assistant-mode]'),
    ];
    expect(options.map((option) => option.dataset.assistantMode)).toEqual([
      'review',
      'auto',
      'yolo',
    ]);
    expect(options.map((option) => option.getAttribute('role'))).toEqual([
      'radio',
      'radio',
      'radio',
    ]);
    expect(options[0]?.getAttribute('aria-checked')).toBe('true');

    trigger!.click();
    expect(menu?.hidden).toBe(false);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    options[1]!.click();
    expect(storage.getItem(ASSISTANT_PERMISSION_MODE_KEY)).toBe('auto');
    expect(trigger?.textContent).toContain(t('reader.assistant.permissionMode.auto'));
    expect(menu?.hidden).toBe(true);
    expect(options[0]?.getAttribute('aria-checked')).toBe('false');
    expect(options[1]?.getAttribute('aria-checked')).toBe('true');
    panel.destroy();
  });

  it('renders no permission control when the surface disables it', async () => {
    const { panel } = mountPanel();
    panel.open();
    await flush();
    expect(panel.element.querySelector('.lightink-reader-assistant-mode-trigger')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-assistant-mode-menu')).toBeNull();
    expect(panel.element.querySelectorAll('[data-assistant-mode]').length).toBe(0);
    panel.destroy();
  });

  it('navigates the permission menu with arrow keys, wrapping and selecting', async () => {
    const storage = memoryStorage();
    const { panel } = mountPanel({ showPermissionMode: true, permissionStorage: storage });
    panel.open();
    await flush();
    const trigger = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-mode-trigger',
    )!;
    const menu = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-mode-menu',
    )!;
    const options = [
      ...panel.element.querySelectorAll<HTMLButtonElement>('[data-assistant-mode]'),
    ];
    const press = (key: string): void => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };

    trigger.click();
    expect(document.activeElement).toBe(options[0]);
    press('ArrowDown');
    expect(document.activeElement).toBe(options[1]);
    expect(storage.getItem(ASSISTANT_PERMISSION_MODE_KEY)).toBe('auto');
    expect(options[1]?.getAttribute('aria-checked')).toBe('true');
    press('ArrowDown');
    press('ArrowDown');
    expect(document.activeElement).toBe(options[0]);
    expect(storage.getItem(ASSISTANT_PERMISSION_MODE_KEY)).toBe('review');
    press('ArrowUp');
    expect(document.activeElement).toBe(options[2]);
    expect(storage.getItem(ASSISTANT_PERMISSION_MODE_KEY)).toBe('yolo');
    press('Home');
    expect(document.activeElement).toBe(options[0]);
    press('End');
    expect(document.activeElement).toBe(options[2]);
    press('Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    panel.destroy();
  });
});

describe('createAssistantPanel minimal typographic flow (T4)', () => {
  const css = readFileSync('src/assistant/assistant-panel.css', 'utf-8');
  const ruleBody = (pattern: RegExp): string => pattern.exec(css)?.[1] ?? '';

  it('keeps assistant replies unadorned and user messages as light right bubbles', () => {
    const assistantRule = ruleBody(
      /\.lightink-reader-assistant-message\.is-assistant\s*\{([^}]*)\}/,
    );
    expect(assistantRule).not.toMatch(/background/);
    expect(assistantRule).not.toMatch(/border/);
    const userRule = ruleBody(/\.lightink-reader-assistant-message\.is-user\s*\{([^}]*)\}/);
    expect(userRule).toMatch(/align-self:\s*flex-end/);
    expect(userRule).toMatch(/background:/);
    // 消息流里唯一带边框的强调元素是内联确认卡片。
    const pendingRule = ruleBody(/\.lightink-reader-assistant-pending\s*\{([^}]*)\}/);
    expect(pendingRule).toMatch(/border:\s*1px solid/);
  });

  it('converges markdown headings, tables, and lists inside the message text', () => {
    const headingRule = ruleBody(
      /\.lightink-reader-assistant-message-text\s*:is\(h1, h2, h3, h4, h5, h6\)\s*\{([^}]*)\}/,
    );
    expect(headingRule).toMatch(/font-size:\s*1em/);
    const tableRule = ruleBody(
      /\.lightink-reader-assistant-message-text table\s*\{([^}]*)\}/,
    );
    expect(tableRule).toMatch(/overflow-x:\s*auto/);
    expect(tableRule).toMatch(/border-collapse:\s*collapse/);
    const cellRule = ruleBody(
      /\.lightink-reader-assistant-message-text\s*:is\(th, td\)\s*\{([^}]*)\}/,
    );
    expect(cellRule).toMatch(/border:\s*1px solid/);
    const listRule = ruleBody(
      /\.lightink-reader-assistant-message-text\s*:is\(ul, ol\)\s*\{([^}]*)\}/,
    );
    expect(listRule).toMatch(/padding-inline-start/);
    const preRule = ruleBody(
      /\.lightink-reader-assistant-message-text pre\s*\{([^}]*)\}/,
    );
    expect(preRule).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps streamed reflow from moving finished messages via overflow-anchor', () => {
    const anchorRule = ruleBody(
      /\.lightink-reader-assistant-messages\s*>\s*\*\s*\{([^}]*)\}/,
    );
    expect(anchorRule).toMatch(/overflow-anchor:\s*none/);
  });

  it('keeps quick actions on one horizontally scrollable row', () => {
    const actionsRule = ruleBody(/\.lightink-reader-assistant-actions\s*\{([^}]*)\}/);
    expect(actionsRule).toMatch(/flex-wrap:\s*nowrap/);
    expect(actionsRule).toMatch(/overflow-x:\s*auto/);
  });

  it('renders jump-to-bottom as a small round icon button and drops the dead pending-actions rule', async () => {
    const jumpRule = ruleBody(/\.lightink-reader-assistant-jump-bottom\s*\{([^}]*)\}/);
    expect(jumpRule).toMatch(/border-radius:\s*50%/);
    expect(css).not.toContain('lightink-reader-assistant-pending-actions');

    const { panel } = mountPanel();
    panel.open();
    await flush();
    const jump = panel.element.querySelector('[data-assistant-jump-bottom]');
    expect(jump?.getAttribute('aria-label')).toBe(t('reader.assistant.jumpBottom'));
    expect(jump?.querySelector('svg')).not.toBeNull();
    panel.destroy();
  });

  it('closes the permission menu on pointerdown outside and removes the listener on destroy', async () => {
    const { panel } = mountPanel({
      showPermissionMode: true,
      permissionStorage: memoryStorage(),
    });
    panel.open();
    await flush();
    const trigger = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-mode-trigger',
    )!;
    const menu = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-mode-menu',
    )!;
    trigger.click();
    expect(menu.hidden).toBe(false);

    // 面板外点击:document 捕获监听收到 root stopPropagation 之外的按下。
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);

    // 面板内、菜单外点击同样收起。
    trigger.click();
    expect(menu.hidden).toBe(false);
    panel.element
      .querySelector('.lightink-reader-assistant-messages')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(true);

    // destroy 移除 document 监听:外部按下不再触碰已拆除的菜单。
    trigger.click();
    expect(menu.hidden).toBe(false);
    panel.destroy();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(menu.hidden).toBe(false);
  });

  it('freezes a tool chip as stopped when generation stops mid-execution', async () => {
    let round = 0;
    let resolveExecute: (value: unknown) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        }),
    );
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'library_tag', arguments: '{}' }],
          };
        }
        emit('不该到达');
        return { finish: 'stop', totalChars: 3 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '给三体打标签');
    await flushUntil(() => execute.mock.calls.length > 0);
    const running = panel.element.querySelector<HTMLElement>('[data-tool="library_tag"]');
    expect(running?.dataset.toolState).toBe('running');

    // 工具仍在执行时停止:chip 定格为已停止,而不是永远停在「运行中」。
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]')!.click();
    resolveExecute({ ok: true, updated: ['a'] });
    await flush();
    const chip = panel.element.querySelector<HTMLElement>('[data-tool="library_tag"]');
    expect(chip).not.toBeNull();
    expect(chip!.dataset.toolState).toBe('stopped');
    expect(chip!.querySelector('.lightink-reader-assistant-tool-status.is-stopped')).not.toBeNull();
    expect(chip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      t('reader.assistant.toolStatusStopped'),
    );
    panel.destroy();
  });

  it('drives each status from data-status and drops the legacy is-streaming class', () => {
    expect(css).not.toContain('is-streaming');
    const waitingRule = ruleBody(
      /\[data-status='waiting'\]\s+\.lightink-reader-assistant-waiting\s*\{([^}]*)\}/,
    );
    expect(waitingRule).toMatch(/color:\s*var\(--lightink-muted\)/);
    const streamingRule = ruleBody(
      /\[data-status='streaming'\]\s+\.lightink-reader-assistant-message-text[^{]*\{([^}]*)\}/,
    );
    expect(streamingRule).toMatch(/color:\s*var\(--lightink-muted\)/);
    const stoppedNoteRule = ruleBody(
      /\[data-status='stopped'\]\s+\.lightink-reader-assistant-stopped\s*\{([^}]*)\}/,
    );
    expect(stoppedNoteRule).toMatch(/color:\s*var\(--lightink-muted\)/);
    expect(stoppedNoteRule).toMatch(/border-left:\s*2px solid/);
    const errorRule = ruleBody(
      /\[data-status='error'\]\s+\.lightink-reader-assistant-message-text\s*\{([^}]*)\}/,
    );
    expect(errorRule).toMatch(/color:\s*var\(--lightink-danger\)/);
    // 脉冲点动画（reduced-motion 由 theme.css 全局 kill-switch 退化为静态）。
    expect(css).toMatch(
      /\.lightink-reader-assistant-waiting-dot\s*\{[^}]*animation:\s*lightink-reader-assistant-dot-pulse/,
    );
    expect(css).toMatch(/@keyframes lightink-reader-assistant-dot-pulse/);
    // 面板容器仍消费 panel 圆角令牌。
    expect(ruleBody(/\.lightink-reader-assistant-panel\s*\{([^}]*)\}/)).toMatch(
      /border-radius:\s*var\(--lightink-radius-panel\)/,
    );
  });
});

describe('createAssistantPanel quick actions', () => {
  it('runs chapter actions with the chapter as context and offers save-as-annotation for summaries', async () => {
    const { panel, invoke, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: '第一章', text: '本章正文内容' },
    });
    panel.open();
    await flush();

    actionButton(panel, 'chapterSummary').click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    expect(payload.messages.some((message) => message.content.includes('本章正文内容'))).toBe(true);
    expect(payload.messages[payload.messages.length - 1]?.content).toBe(
      t('reader.assistant.prompt.chapterSummary'),
    );

    const bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    const answer = bubbles[bubbles.length - 1]!;
    const save = answer.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save');
    expect(save).not.toBeNull();
    save!.click();
    expect(deps.saveAnnotation).toHaveBeenCalledWith('回答内容');
    expect(save!.disabled).toBe(true);
    expect(save!.textContent).toBe(t('reader.assistant.saved'));
    save!.click();
    expect(deps.saveAnnotation).toHaveBeenCalledTimes(1);

    actionButton(panel, 'vocabulary').click();
    await flush();
    actionButton(panel, 'quiz').click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(3);
    const vocab = invoke.mock.calls[1]?.[1] as { messages: { content: string }[] };
    const quiz = invoke.mock.calls[2]?.[1] as { messages: { content: string }[] };
    expect(vocab.messages[vocab.messages.length - 1]?.content).toBe(
      t('reader.assistant.prompt.vocabulary'),
    );
    expect(quiz.messages[quiz.messages.length - 1]?.content).toBe(t('reader.assistant.prompt.quiz'));
    const lastBubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(
      lastBubbles[lastBubbles.length - 1]!.querySelector('.lightink-reader-assistant-save'),
    ).toBeNull();
    panel.destroy();
  });

  it('disables panel quick actions when no chapter text is available', async () => {
    const { panel } = mountPanel({ chapter: null });
    panel.open();
    await flush();
    for (const action of ASSISTANT_PANEL_ACTIONS) {
      expect(actionButton(panel, action).disabled).toBe(true);
      expect(actionButton(panel, action).title).toBe(t('reader.assistant.noChapterContext'));
    }
    panel.destroy();
  });

  it('opens and runs explain/summarize from a selection quote', async () => {
    const { panel, invoke } = mountPanel({ chapter: { title: 'C1', text: 'T1' } });
    expect(panel.isVisible()).toBe(false);
    panel.askWithSelection('explain', '一个难句');
    await flush();
    expect(panel.isVisible()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]?.[1] as { messages: { role: string; content: string }[] };
    expect(payload.messages[payload.messages.length - 1]?.content).toContain(
      '<selection>\n一个难句\n</selection>',
    );
    expect(panel.element.querySelector('.lightink-reader-assistant-quote-excerpt')?.textContent).toBe(
      '一个难句',
    );

    panel.close();
    panel.askWithSelection('summarize', '一段要总结的话');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    const excerpts = [
      ...panel.element.querySelectorAll('.lightink-reader-assistant-quote-excerpt'),
    ].map((node) => node.textContent);
    expect(excerpts).toContain('一段要总结的话');
    expect(bubbleTexts(panel, 'user')[1] ?? '').not.toContain(
      t('reader.assistant.prompt.summarize'),
    );

    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-history-toggle')?.click();
    const historyTitle = panel.element.querySelector(
      '.lightink-reader-assistant-history-title',
    )?.textContent;
    expect(historyTitle).toBe('一个难句');
    expect(historyTitle).not.toContain(t('reader.assistant.prompt.summarize'));
    panel.destroy();
  });
});

describe('createAssistantPanel context bar (R7)', () => {
  function contextBar(panel: ReturnType<typeof createAssistantPanel>): HTMLElement {
    const bar = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-context');
    expect(bar).not.toBeNull();
    return bar!;
  }

  function contextChip(
    panel: ReturnType<typeof createAssistantPanel>,
    kind: 'chapter' | 'selection' | 'page' | 'document',
  ): HTMLElement {
    const chip = panel.element.querySelector<HTMLElement>(
      `[data-assistant-context="${kind}"]`,
    );
    expect(chip).not.toBeNull();
    return chip!;
  }

  it('shows the reader chapter chip and drops chapter text from requests until restored', async () => {
    const { panel, invoke } = mountPanel({ chapter: { title: '第一章', text: '章节正文' } });
    panel.open();
    await flush();

    const bar = contextBar(panel);
    expect(bar.hidden).toBe(false);
    const chapterChip = contextChip(panel, 'chapter');
    expect(chapterChip.hidden).toBe(false);
    expect(chapterChip.textContent).toContain('第一章');
    expect(contextChip(panel, 'page').hidden).toBe(true);
    expect(contextChip(panel, 'document').hidden).toBe(true);

    // 移除本章：chip 进入「不发送」态，恢复入口与 aria-live 反馈同时出现。
    const toggle = chapterChip.querySelector<HTMLButtonElement>(
      '[data-assistant-context-toggle="chapter"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-label')).toBe(t('reader.assistant.contextChapterRemove'));
    toggle!.click();
    expect(chapterChip.dataset.contextIncluded).toBe('false');
    expect(toggle!.getAttribute('aria-label')).toBe(t('reader.assistant.contextChapterRestore'));
    const feedback = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-context-feedback',
    );
    expect(feedback?.hidden).toBe(false);
    expect(feedback?.textContent).toBe(t('reader.assistant.contextChapterExcluded'));
    expect(actionButton(panel, 'chapterSummary').disabled).toBe(true);

    submitQuestion(panel, '移除后的问题');
    await flush();
    const stripped = invoke.mock.calls[0]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(stripped.messages.some((message) => message.content.includes('章节正文'))).toBe(false);
    expect(stripped.messages.some((message) => message.content.includes('<chapter>'))).toBe(false);
    expect(stripped.messages[stripped.messages.length - 1]).toEqual({
      role: 'user',
      content: '移除后的问题',
    });

    // 恢复：请求重新包含章节正文。
    toggle!.click();
    expect(chapterChip.dataset.contextIncluded).toBe('true');
    expect(toggle!.getAttribute('aria-label')).toBe(t('reader.assistant.contextChapterRemove'));
    expect(feedback?.textContent).toBe(t('reader.assistant.contextChapterIncluded'));
    expect(actionButton(panel, 'chapterSummary').disabled).toBe(false);

    submitQuestion(panel, '恢复后的问题');
    await flush();
    const restored = invoke.mock.calls[1]?.[1] as { messages: { content: string }[] };
    expect(restored.messages.some((message) => message.content.includes('章节正文'))).toBe(true);
    panel.destroy();
  });

  it('keeps the context-limit hint for a clipped reader chapter', async () => {
    const longChapter = '章'.repeat(READER_LIMITS.maxAssistantContextChars + 30);
    const { panel } = mountPanel({ chapter: { title: '长章', text: longChapter } });
    panel.open();
    await flush();
    const hint = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-context-hint',
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain(String(READER_LIMITS.maxAssistantContextChars));
    expect(contextChip(panel, 'chapter').hidden).toBe(false);
    panel.destroy();
  });

  it('shares the selection chip with the composer quote bar and clears it after send', async () => {
    let selection = '';
    const { panel, invoke } = mountPanel({
      chapter: { title: '第一章', text: '章节正文' },
      currentSelection: () => selection,
    });
    panel.open();
    await flush();
    expect(contextChip(panel, 'selection').hidden).toBe(true);

    selection = '选中的句子';
    document.dispatchEvent(new Event('selectionchange'));
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-quote]')!.click();
    const selectionChip = contextChip(panel, 'selection');
    expect(selectionChip.hidden).toBe(false);
    expect(selectionChip.textContent).toContain('选中的句子');
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-quote-chip')?.hidden,
    ).toBe(false);

    // 上下文条清掉引用：composer 引用条与下一轮请求同步清空。
    selectionChip
      .querySelector<HTMLButtonElement>('[data-assistant-context-clear="selection"]')!
      .click();
    expect(selectionChip.hidden).toBe(true);
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-quote-chip')?.hidden,
    ).toBe(true);
    expect(selection).toBe('选中的句子');

    selection = '发送时仍选中的句子';
    document.dispatchEvent(new Event('selectionchange'));
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-quote]')!.click();
    expect(contextChip(panel, 'selection').hidden).toBe(false);
    submitQuestion(panel, '这句话什么意思');
    await flush();
    expect(contextChip(panel, 'selection').hidden).toBe(true);
    const payload = invoke.mock.calls[0]?.[1] as { messages: { content: string }[] };
    const last = payload.messages[payload.messages.length - 1]?.content ?? '';
    expect(last).toContain('<selection>\n发送时仍选中的句子\n</selection>');
    expect(last).toContain('这句话什么意思');
    panel.destroy();
  });

  it('renders the PDF page chip read-only and keeps the page on the user turn', async () => {
    const { panel, invoke } = mountPanel({
      chapter: { kind: 'pdf', title: '第 3 / 10 页', text: '当前页正文' },
      currentPage: 3,
    });
    panel.open();
    await flush();

    const pageChip = contextChip(panel, 'page');
    expect(pageChip.hidden).toBe(false);
    expect(pageChip.textContent).toContain('3');
    expect(pageChip.querySelector('button')).toBeNull();
    expect(contextChip(panel, 'chapter').hidden).toBe(true);

    submitQuestion(panel, '本页讲了什么');
    await flush();
    const payload = invoke.mock.calls[0]?.[1] as { messages: { content: string }[] };
    expect(payload.messages.some((message) => message.content.startsWith('【当前页】'))).toBe(true);
    expect(payload.messages[payload.messages.length - 1]?.content).toContain('【当前页码：3】');
    panel.destroy();
  });

  it('renders a read-only document chip with the truncation hint in the editor', async () => {
    const longDoc = '文'.repeat(READER_LIMITS.maxAssistantContextChars + 120);
    const { panel, invoke } = mountPanel({
      chapter: { title: '文档标题', text: longDoc },
      showPermissionMode: false,
    });
    panel.open();
    await flush();

    const documentChip = contextChip(panel, 'document');
    expect(documentChip.hidden).toBe(false);
    expect(documentChip.textContent).toContain('文档标题');
    expect(documentChip.querySelector('button')).toBeNull();
    expect(contextChip(panel, 'chapter').hidden).toBe(true);
    expect(contextChip(panel, 'page').hidden).toBe(true);
    const hint = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-context-hint',
    );
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain(String(READER_LIMITS.maxAssistantContextChars));

    submitQuestion(panel, '总结文档');
    await flush();
    const payload = invoke.mock.calls[0]?.[1] as { messages: { content: string }[] };
    expect(payload.messages.some((message) => message.content.includes('<chapter>'))).toBe(true);
    const answer = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(
      answer[answer.length - 1]?.querySelector('.lightink-reader-assistant-notice')?.textContent,
    ).toContain(String(READER_LIMITS.maxAssistantContextChars));
    panel.destroy();
  });

  it('renders no context bar on the library surface and still accepts questions', async () => {
    const { panel, invoke } = mountPanel({ chapter: null, showQuote: false });
    panel.open();
    await flush();
    expect(contextBar(panel).hidden).toBe(true);

    submitQuestion(panel, '帮我找一本书');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['帮我找一本书']);
    panel.destroy();
  });

  it('keeps asking enabled for formats without text context', async () => {
    const { panel, invoke } = mountPanel({ chapter: null });
    panel.open();
    await flush();
    expect(contextBar(panel).hidden).toBe(true);

    submitQuestion(panel, '这本漫画讲了什么');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    const payload = invoke.mock.calls[0]?.[1] as { messages: { content: string }[] };
    expect(payload.messages.some((message) => message.content.includes('<chapter>'))).toBe(false);
    expect(payload.messages[payload.messages.length - 1]).toEqual({
      role: 'user',
      content: '这本漫画讲了什么',
    });
    panel.destroy();
  });

  it('resets the chapter switch when the book identity changes', async () => {
    let key = 'book-a';
    let chapter: { title: string; text: string } | null = { title: '第一章', text: '甲书正文' };
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1 };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => chapter,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      readHistory: vi.fn(async () => ''),
      writeHistory: vi.fn(async () => undefined),
      historyKey: () => key,
      stream,
    });
    panel.open();
    await flush();
    const chapterChip = (): HTMLElement =>
      panel.element.querySelector<HTMLElement>('[data-assistant-context="chapter"]')!;
    const feedback = (): HTMLElement | null =>
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-context-feedback');
    chapterChip()
      .querySelector<HTMLButtonElement>('[data-assistant-context-toggle="chapter"]')!
      .click();
    expect(chapterChip().dataset.contextIncluded).toBe('false');
    expect(feedback()?.hidden).toBe(false);

    key = 'book-b';
    chapter = { title: '第二章', text: '乙书正文' };
    panel.open();
    await flush();
    expect(chapterChip().dataset.contextIncluded).toBe('true');
    expect(chapterChip().textContent).toContain('第二章');
    expect(feedback()?.hidden).toBe(true);

    submitQuestion(panel, '新书问题');
    await flush();
    const payload = stream.invoke.mock.calls[0]?.[1] as { messages: { content: string }[] };
    expect(payload.messages.some((message) => message.content.includes('乙书正文'))).toBe(true);
    expect(payload.messages.some((message) => message.content.includes('甲书正文'))).toBe(false);
    panel.destroy();
  });
});

describe('createAssistantPanel history lifecycle', () => {
  const storedHistory = v1History([
    { role: 'user', content: '上次的问题', createdAt: 10 },
    { role: 'assistant', content: '上次的回答', createdAt: 11 },
  ]);

  it('restores the same book conversation on reopen and does not re-read', async () => {
    const { panel, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      historyJson: storedHistory,
    });
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['上次的问题']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['上次的回答']);
    expect(deps.readHistory).toHaveBeenCalledTimes(1);

    panel.close();
    panel.open();
    await flush();
    expect(deps.readHistory).toHaveBeenCalledTimes(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['上次的问题']);
    panel.destroy();
  });

  it('reads again when the book identity changes', async () => {
    let key = '0123456789abcdef';
    let json = storedHistory;
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1 };
    });
    const readHistory = vi.fn(async () => json);
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      readHistory,
      writeHistory: vi.fn(async () => undefined),
      historyKey: () => key,
      stream,
    });
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['上次的问题']);

    key = 'fedcba9876543210';
    json = v1History([{ role: 'user', content: '另一本书的问题', createdAt: 20 }]);
    panel.open();
    await flush();
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(bubbleTexts(panel, 'user')).toEqual(['另一本书的问题']);
    panel.destroy();
  });

  it('drops the previous book conversation when identity changes after interaction', async () => {
    let key = '0123456789abcdef';
    let reply = '书A的回答';
    const written: Array<{ key: string; json: string }> = [];
    const stream = fakeStream(async ({ emit }) => {
      emit(reply);
      return { finish: 'stop', totalChars: reply.length };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      readHistory: vi.fn(async () => ''),
      writeHistory: vi.fn(async (writeKey: string, json: string) => {
        written.push({ key: writeKey, json });
      }),
      historyKey: () => key,
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '书A的问题');
    await flush();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['书A的回答']);

    key = 'fedcba9876543210';
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    expect(bubbleTexts(panel, 'assistant')).toEqual([]);

    reply = '书B的回答';
    submitQuestion(panel, '书B的问题');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['书B的问题']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['书B的回答']);
    const bookBWrites = written.filter((entry) => entry.key === 'fedcba9876543210');
    expect(bookBWrites.length).toBeGreaterThan(0);
    for (const entry of bookBWrites) {
      expect(entry.json).not.toContain('书A');
    }
    panel.destroy();
  });

  it('creates, switches, and deletes conversations from the history entry', async () => {
    const { panel, deps } = mountPanel({ historyKey: '0123456789abcdef' });
    panel.open();
    await flush();
    submitQuestion(panel, '第一段问题');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一段问题']);

    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-history-toggle')?.click();
    expect(panel.element.classList.contains('is-history')).toBe(true);
    panel.element.querySelector<HTMLButtonElement>('[data-assistant-history-new]')?.click();
    await flush();
    expect(panel.element.classList.contains('is-history')).toBe(false);
    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-history-toggle')?.click();
    expect(
      panel.element.querySelectorAll('[data-assistant-history-id]').length,
    ).toBe(1);
    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-history-toggle')?.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    submitQuestion(panel, '第二段问题');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第二段问题']);

    const items = [
      ...panel.element.querySelectorAll<HTMLElement>('[data-assistant-history-id]'),
    ];
    expect(items.length).toBe(2);
    const first = items.find((item) => !item.classList.contains('is-active'));
    first?.querySelector<HTMLButtonElement>('.lightink-reader-assistant-history-open')?.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第一段问题']);

    const activeId = panel.element
      .querySelector<HTMLElement>('.lightink-reader-assistant-history-item.is-active')
      ?.getAttribute('data-assistant-history-id');
    expect(activeId).not.toBeNull();
    panel.element
      .querySelector<HTMLButtonElement>(`[data-assistant-history-delete="${activeId}"]`)
      ?.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第二段问题']);
    const writes = deps.writeHistory.mock.calls;
    const lastWrite = writes[writes.length - 1]?.[1] as string;
    const store = parseAssistantHistoryStore(lastWrite);
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]?.title).toContain('第二段问题');
    panel.destroy();
  });

  it('does not persist a new ask over sibling conversations while history is still loading', async () => {
    let releaseRead: ((json: string) => void) | null = null;
    const readHistory = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
    );
    const writeHistory = vi.fn(async () => undefined);
    const stream = fakeStream(async ({ emit }) => {
      emit('新回答');
      return { finish: 'stop', totalChars: 3 };
    });
    const siblings = serializeAssistantHistoryStore({
      version: 2,
      activeId: 'b',
      conversations: [
        {
          id: 'a',
          title: '会话A问题',
          messages: [{ role: 'user', content: '会话A问题', createdAt: 1 }],
          updatedAt: 1,
        },
        {
          id: 'b',
          title: '会话B问题',
          messages: [{ role: 'user', content: '会话B问题', createdAt: 2 }],
          updatedAt: 2,
        },
      ],
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      readHistory,
      writeHistory,
      historyKey: () => '0123456789abcdef',
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '新问题');
    await flush();
    expect(stream.invoke).not.toHaveBeenCalled();
    expect(releaseRead).not.toBeNull();
    releaseRead!(siblings);
    await flushUntil(() => writeHistory.mock.calls.length > 0);
    expect(stream.invoke).toHaveBeenCalled();
    expect(bubbleTexts(panel, 'user')).toEqual(['会话B问题', '新问题']);
    const calls = writeHistory.mock.calls as unknown as Array<[string, string]>;
    const lastWrite = calls[calls.length - 1]?.[1];
    expect(typeof lastWrite).toBe('string');
    const store = parseAssistantHistoryStore(lastWrite ?? '');
    expect(store.conversations).toHaveLength(2);
    expect(
      store.conversations.some((conversation) =>
        conversation.messages.some((message) => message.content === '会话A问题'),
      ),
    ).toBe(true);
    expect(
      store.conversations.some((conversation) =>
        conversation.messages.some((message) => message.content === '新问题'),
      ),
    ).toBe(true);
    panel.destroy();
  });

  it('falls back to in-memory only when the identity or storage is unavailable', async () => {
    const { panel, deps } = mountPanel({ historyKey: null });
    panel.open();
    await flush();
    submitQuestion(panel, '临时问题');
    await flush();
    expect(deps.readHistory).not.toHaveBeenCalled();
    expect(deps.writeHistory).not.toHaveBeenCalled();
    expect(bubbleTexts(panel, 'user')).toEqual(['临时问题']);

    panel.close();
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['临时问题']);
    panel.destroy();
  });
});

describe('createAssistantPanel tools and locators', () => {
  it('renders tool calls as blocks and stops after 24 tool rounds with a notice', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({
      ok: true,
      tool: 'query_book',
      action: 'toc',
      items: [],
    }));
    const { panel, invoke } = mountPanel({
      script: async () => {
        round += 1;
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: `c${round}`, name: 'query_book', arguments: '{"action":"toc"}' }],
        };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '读很多章');
    await flushUntil(() => invoke.mock.calls.length >= ASSISTANT_MAX_TOOL_ROUNDS);
    expect(invoke).toHaveBeenCalledTimes(ASSISTANT_MAX_TOOL_ROUNDS);
    expect(execute).toHaveBeenCalledTimes(ASSISTANT_MAX_TOOL_ROUNDS);
    expect(panel.element.querySelectorAll('[data-tool="query_book"]').length).toBe(
      ASSISTANT_MAX_TOOL_ROUNDS,
    );
    expect(
      panel.element.querySelector('[data-assistant-tool-limit]')?.textContent,
    ).toBe(t('reader.assistant.maxToolRounds', { n: String(ASSISTANT_MAX_TOOL_ROUNDS) }));
    panel.destroy();
  });

  it('passes the current user message to createToolSession for write gating', async () => {
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as AssistantToolSession;
    const createToolSession = vi.fn(() => session);
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        emit('好');
        return { finish: 'stop', totalChars: 1 };
      },
      createToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '把《三体》归到科幻');
    await flush();
    expect(createToolSession).toHaveBeenCalledWith('把《三体》归到科幻', { suggestion: false });
    panel.destroy();
  });

  it('advertises session tools and lets the surface override the system prompt', async () => {
    const sessionTools = [
      {
        type: 'function' as const,
        name: 'library_search',
        description: '查询书库',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [] as readonly string[],
          additionalProperties: false as const,
        },
      },
      {
        type: 'function' as const,
        name: 'library_tag',
        description: '打标签',
        parameters: {
          type: 'object' as const,
          properties: {},
          required: [] as readonly string[],
          additionalProperties: false as const,
        },
      },
    ];
    const session = {
      tools: sessionTools,
      specifiedChapterCount: () => 0,
      execute: vi.fn(async () => ({ ok: true })),
    } as unknown as AssistantToolSession;
    const { panel, invoke } = mountPanel({
      script: async ({ emit }) => {
        emit('好');
        return { finish: 'stop', totalChars: 1 };
      },
      createToolSession: () => session,
      systemPrompt: () => '你是书架助手。',
    });
    panel.open();
    await flush();
    submitQuestion(panel, '有哪些书?');
    await flush();
    const payload = invoke.mock.calls[0]?.[1] as {
      messages: { role: string; content: string }[];
      tools: { name: string }[];
    };
    expect(payload.tools.map((tool) => tool.name)).toEqual(['library_search', 'library_tag']);
    expect(payload.messages[0]).toEqual({ role: 'system', content: '你是书架助手。' });
    panel.destroy();
  });

  it('jumps when a query-based answer locator is clicked', async () => {
    const { panel, deps } = mountPanel({
      script: async ({ emit }) => {
        emit('见 [第二章](chapter:2) 与 [第3页](page:3)');
        return { finish: 'stop', totalChars: 20 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '定位');
    await flush();
    const chapterLink = panel.element.querySelector<HTMLAnchorElement>('a[data-chapter="2"]');
    const pageLink = panel.element.querySelector<HTMLAnchorElement>('a[data-page="3"]');
    expect(chapterLink).not.toBeNull();
    expect(pageLink).not.toBeNull();
    chapterLink!.click();
    expect(deps.jumpToLocator).toHaveBeenCalledWith({ chapter: 2, title: '第二章' });
    pageLink!.click();
    expect(deps.jumpToLocator).toHaveBeenCalledWith({ page: 3, title: '第3页' });
    panel.destroy();
  });

  it('passes the citation title so a wrong 0-based index can still jump by TOC', async () => {
    const { panel, deps } = mountPanel({
      script: async ({ emit }) => {
        emit('参考：[第六話 軍事会議にて①](chapter:0) （当前章节）');
        return { finish: 'stop', totalChars: 20 };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '定位');
    await flush();
    const link = panel.element.querySelector<HTMLAnchorElement>('a[data-chapter="0"]');
    expect(link).not.toBeNull();
    link!.click();
    expect(deps.jumpToLocator).toHaveBeenCalledWith({
      chapter: 0,
      title: '第六話 軍事会議にて①',
    });
    panel.destroy();
  });

  it('calls the book source tool after a reply that only promises a confirmation card', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({
      ok: true,
      pending: true,
      tool: 'book_source_save',
      message: '添加书源需要确认后才会写入',
      pending_confirmation: [
        {
          id: 'bs-1',
          summary: '保存书源「Chinese Text Project」',
          tool: 'book_source_save',
          arguments: { title: 'Chinese Text Project' },
        },
      ],
    }));
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          emit('我直接再发一张新的确认卡。');
          return { finish: 'stop', totalChars: 12 };
        }
        if (round === 2) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: 'book_source_save',
                arguments: '{"title":"Chinese Text Project"}',
              },
            ],
          };
        }
        return { finish: 'stop', totalChars: 0 };
      },
      createToolSession: () =>
        ({
          tools: [
            {
              type: 'function',
              name: 'book_source_save',
              description: 'save',
              parameters: { type: 'object', properties: {} },
            },
          ],
          specifiedChapterCount: () => 0,
          execute,
          confirmPending: async () => ({ ok: true }),
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '你再重新添加下');
    await flushUntil(() => round >= 2 && execute.mock.calls.length >= 1);
    await flush();
    expect(execute).toHaveBeenCalledWith('book_source_save', '{"title":"Chinese Text Project"}');
    expect(panel.element.textContent).toContain('保存书源「Chinese Text Project」');
    panel.destroy();
  });

  it('keeps a thrown tool error on the chip instead of failing the whole reply', async () => {
    let round = 0;
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'book_source_search', arguments: '{"source":"示例","query":"红楼梦"}' }],
          };
        }
        emit('搜索没有完成');
        return { finish: 'stop', totalChars: 6 };
      },
      createToolSession: () =>
        ({
          tools: [
            {
              type: 'function',
              name: 'book_source_search',
              description: 'search',
              parameters: { type: 'object', properties: {} },
            },
          ],
          specifiedChapterCount: () => 0,
          execute: async () => {
            throw { message: '远程服务器返回 HTTP 404' };
          },
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '搜索红楼梦');
    await flushUntil(() => panel.element.textContent?.includes('远程服务器返回 HTTP 404') === true);
    expect(panel.element.textContent).toContain('远程服务器返回 HTTP 404');
    expect(panel.element.textContent).not.toContain('AI 请求失败');
    expect(panel.element.textContent).not.toContain('已停止');
    panel.destroy();
  });

  it('renders library tool calls as collapsed chips with localized name and summary', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({
      ok: true,
      tool: 'library_search',
      groups: Array.from({ length: 7 }, (_, index) => ({ id: `g${index}` })),
    }));
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'library_search', arguments: '{"query":"科幻"}' }],
          };
        }
        emit('找到这些分组');
        return { finish: 'stop', totalChars: 6 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '找科幻分组');
    await flushUntil(() => round >= 2);
    await flush();
    const chip = panel.element.querySelector<HTMLElement>('[data-tool="library_search"]');
    expect(chip).not.toBeNull();
    expect(chip!.dataset.toolState).toBe('done');
    expect(chip!.querySelector('.lightink-reader-assistant-tool-name')?.textContent).toBe(
      t('reader.assistant.toolLibrarySearch'),
    );
    expect(chip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      t('reader.assistant.toolSummary.groups', { n: '7' }),
    );
    const body = chip!.querySelector<HTMLElement>('.lightink-reader-assistant-tool-body');
    const head = chip!.querySelector<HTMLElement>('.lightink-reader-assistant-tool-head');
    expect(body).not.toBeNull();
    expect(head).not.toBeNull();
    // 默认折叠：原始 JSON 不可见，点击头部才展开。
    expect(body!.hidden).toBe(true);
    expect(head!.getAttribute('aria-expanded')).toBe('false');
    head!.click();
    expect(body!.hidden).toBe(false);
    expect(head!.getAttribute('aria-expanded')).toBe('true');
    expect(chip!.classList.contains('is-open')).toBe(true);
    expect(body!.textContent).toContain('"groups"');
    expect(body!.textContent).toContain('{"query":"科幻"}');
    head!.click();
    expect(body!.hidden).toBe(true);
    expect(head!.getAttribute('aria-expanded')).toBe('false');
    expect(chip!.classList.contains('is-open')).toBe(false);
    panel.destroy();
  });

  it('shows a running chip while the tool executes and updates it in place', async () => {
    let round = 0;
    let resolveExecute: (value: unknown) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveExecute = resolve;
        }),
    );
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'library_tag', arguments: '{}' }],
          };
        }
        emit('打好了');
        return { finish: 'stop', totalChars: 3 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '给三体打科幻标签');
    await flushUntil(() => execute.mock.calls.length > 0);
    const runningChip = panel.element.querySelector<HTMLElement>('[data-tool="library_tag"]');
    expect(runningChip).not.toBeNull();
    expect(runningChip!.dataset.toolState).toBe('running');
    expect(
      runningChip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent,
    ).toBe(t('reader.assistant.toolStatusRunning'));
    expect(runningChip!.querySelector('.lightink-reader-assistant-tool-status.is-running'))
      .not.toBeNull();
    resolveExecute({ ok: true, updated: ['a', 'b'] });
    await flushUntil(() => round >= 2);
    await flush();
    const doneChip = panel.element.querySelector<HTMLElement>('[data-tool="library_tag"]');
    expect(doneChip).not.toBeNull();
    expect(doneChip!.dataset.toolState).toBe('done');
    expect(doneChip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      t('reader.assistant.toolSummary.updated', { n: '2' }),
    );
    panel.destroy();
  });

  it('renders failed tool calls with a failure state and error in the details', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({
      ok: false,
      error: 'library_error',
      message: '书库不可用。',
    }));
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'library_remove', arguments: '{}' }],
          };
        }
        emit('没能删除');
        return { finish: 'stop', totalChars: 4 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '删掉三体');
    await flushUntil(() => round >= 2);
    await flush();
    const chip = panel.element.querySelector<HTMLElement>('[data-tool="library_remove"]');
    expect(chip).not.toBeNull();
    expect(chip!.dataset.toolState).toBe('failed');
    expect(chip!.querySelector('.lightink-reader-assistant-tool-status.is-failed'))
      .not.toBeNull();
    expect(chip!.querySelector('.lightink-reader-assistant-tool-name')?.textContent).toBe(
      t('reader.assistant.toolLibraryRemove'),
    );
    expect(chip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      '书库不可用。',
    );
    const body = chip!.querySelector<HTMLElement>('.lightink-reader-assistant-tool-body');
    expect(body!.hidden).toBe(true);
    chip!.querySelector<HTMLElement>('.lightink-reader-assistant-tool-head')!.click();
    expect(body!.hidden).toBe(false);
    expect(body!.textContent).toContain('library_error');
    panel.destroy();
  });

  it('falls back to a generic done summary when no result fields map', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({ ok: true }));
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'query_book', arguments: '{"action":"toc"}' }],
          };
        }
        emit('目录如上');
        return { finish: 'stop', totalChars: 4 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '目录');
    await flushUntil(() => round >= 2);
    await flush();
    const chip = panel.element.querySelector<HTMLElement>('[data-tool="query_book"]');
    expect(chip).not.toBeNull();
    expect(chip!.dataset.toolState).toBe('done');
    expect(chip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      t('reader.assistant.toolStatusDone'),
    );
    expect(chip!.querySelector('.lightink-reader-assistant-tool-name')?.textContent).toBe(
      t('reader.assistant.toolQuery'),
    );
    panel.destroy();
  });

  it('summarizes pending write results without falling back to toolUnknown', async () => {
    let round = 0;
    const execute = vi.fn(async () => ({
      ok: true,
      pending: true,
      pending_confirmation: [
        { id: 'p1', summary: '把《三体》归到科幻', tool: 'library_organize', arguments: {} },
      ],
    }));
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'library_organize', arguments: '{}' }],
          };
        }
        emit('已加入待确认');
        return { finish: 'stop', totalChars: 6 };
      },
      createToolSession: () =>
        ({
          tools: [],
          specifiedChapterCount: () => 0,
          execute,
          confirmPending: async () => ({ ok: true }),
        }) as unknown as AssistantToolSession,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '把《三体》归到科幻');
    await flushUntil(() => round >= 2);
    await flush();
    const chip = panel.element.querySelector<HTMLElement>('[data-tool="library_organize"]');
    expect(chip).not.toBeNull();
    expect(chip!.dataset.toolState).toBe('done');
    expect(chip!.querySelector('.lightink-reader-assistant-tool-name')?.textContent).toBe(
      t('reader.assistant.toolLibraryOrganize'),
    );
    expect(chip!.querySelector('.lightink-reader-assistant-tool-summary')?.textContent).toBe(
      t('reader.assistant.toolSummary.pending', { n: '1' }),
    );
    panel.destroy();
  });
});

describe('createAssistantPanel lifecycle hygiene', () => {
  it('starts hidden, mounts on open, and removes itself on destroy', async () => {
    const { panel } = mountPanel({ chapter: null });
    expect(panel.isVisible()).toBe(false);
    expect(panel.element.hidden).toBe(true);
    panel.open();
    await flush();
    expect(panel.isVisible()).toBe(true);
    expect(panel.element.parentNode).toBe(document.body);
    expect(
      document.body.contains(panel.element.querySelector('.lightink-reader-assistant-input')),
    ).toBe(true);
    panel.close();
    expect(panel.isVisible()).toBe(false);
    panel.open();
    panel.destroy();
    expect(document.body.contains(panel.element)).toBe(false);
  });

  it('stops reacting after destroy (config events, late deltas)', async () => {
    let lateEmit: ((text: string) => void) | null = null;
    const stream = fakeStream(
      ({ emit }) =>
        new Promise(() => {
          lateEmit = emit;
        }),
    );
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => ({ title: 'C', text: 'T' }),
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();
    expect(lateEmit).not.toBeNull();

    panel.destroy();
    expect(() => lateEmit!('迟到的增量')).not.toThrow();
    expect(bubbleTexts(panel, 'assistant')).toEqual([t('reader.assistant.streaming')]);
    expect(panel.element.textContent).not.toContain('迟到的增量');
    expect(() =>
      document.dispatchEvent(
        new CustomEvent('lightink:reader-ai-configured', { detail: { configured: false } }),
      ),
    ).not.toThrow();
  });
});

describe('parseAssistantPendingConfirmations', () => {
  it('strips pending confirmations and refs from the model-visible result', () => {
    expect(stripAssistantPendingConfirmations(undefined)).toBe('');
    expect(stripAssistantPendingConfirmations('not json')).toBe('not json');
    expect(stripAssistantPendingConfirmations('{"ok":true}')).toBe('{"ok":true}');
    const stripped = stripAssistantPendingConfirmations(
      JSON.stringify({
        ok: true,
        pending: true,
        pending_confirmation: [
          { id: 'p1', summary: '归入', tool: 'classify_book', arguments: { pending_ref: 'p1' } },
        ],
      }),
    );
    expect(stripped).not.toContain('pending_confirmation');
    expect(stripped).not.toContain('pending_ref');
    expect(JSON.parse(stripped)).toMatchObject({
      ok: true,
      status: 'awaiting_user_confirmation',
    });
    expect(stripped).not.toContain('"pending":true');
  });

  it('ignores malformed payloads and keeps well-formed items', () => {
    expect(parseAssistantPendingConfirmations(undefined)).toEqual([]);
    expect(parseAssistantPendingConfirmations('not json')).toEqual([]);
    expect(parseAssistantPendingConfirmations('{"ok":true}')).toEqual([]);
    expect(
      parseAssistantPendingConfirmations(
        JSON.stringify({ pending_confirmation: [{ id: '', summary: 'x', tool: 't' }] }),
      ),
    ).toEqual([]);
    expect(
      parseAssistantPendingConfirmations(
        JSON.stringify({
          pending_confirmation: [
            { id: 'p1', summary: ' 归入旧书 ', tool: 'classify_book', arguments: { a: 1 } },
          ],
        }),
      ),
    ).toEqual([{ id: 'p1', summary: '归入旧书', tool: 'classify_book', arguments: { a: 1 } }]);
  });
});

describe('createAssistantPanel pending confirmations', () => {
  function toolCallsRounds(execute: ReturnType<typeof vi.fn>): {
    script: Script;
    createToolSession: () => AssistantToolSession;
  } {
    let round = 0;
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    return {
      script: async ({ emit }) => {
        round += 1;
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: 'classify_book',
                arguments: '{"book":"示例书","group":"旧书"}',
              },
            ],
          };
        }
        emit('已处理');
        return { finish: 'stop', totalChars: 3 };
      },
      createToolSession: () => session,
    };
  }

  const pendingReply = {
    ok: true,
    tool: 'classify_book',
    pending_confirmation: [
      {
        id: 'p1',
        summary: '将《示例书》归入「旧书」',
        tool: 'classify_book',
        arguments: { book: '示例书', group: '旧书' },
      },
    ],
  };

  it('renders the list and executes the same session on confirm, but not before', async () => {
    const execute = vi.fn(async () => pendingReply);
    const { panel } = mountPanel(toolCallsRounds(execute));
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const pendingSection = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-pending',
    );
    expect(pendingSection?.hidden).toBe(false);
    const item = panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]');
    expect(item?.dataset.status).toBe('pending');
    expect(
      item?.querySelector('.lightink-reader-assistant-pending-summary')?.textContent,
    ).toBe('将《示例书》归入「旧书」');
    expect(panel.element.querySelector('[data-assistant-pending-status]')).toBeNull();

    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]')
      ?.click();
    await flushUntil(
      () =>
        panel.element.querySelector('.lightink-reader-assistant-pending')?.hasAttribute('hidden') ===
          true && execute.mock.calls.length >= 2,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith('classify_book', {
      book: '示例书',
      group: '旧书',
    });
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    panel.destroy();
  });

  it('marks rejected without calling the executor again', async () => {
    const execute = vi.fn(async () => pendingReply);
    const { panel } = mountPanel(toolCallsRounds(execute));
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-reject-all]')
      ?.click();
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden,
    ).toBe(true);
    panel.destroy();
  });

  it('keeps the item pending with the executor error when confirmation fails', async () => {
    const execute = vi.fn(async () =>
      execute.mock.calls.length === 1
        ? pendingReply
        : { ok: false, tool: 'classify_book', error: 'write_failed', message: '分组不存在' },
    );
    const { panel } = mountPanel(toolCallsRounds(execute));
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]')
      ?.click();
    await flushUntil(
      () =>
        panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden ===
          true && panel.element.textContent?.includes('分组不存在') === true,
    );
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(panel.element.textContent).toContain('但写入失败');
    expect(execute).toHaveBeenCalledTimes(2);
    panel.destroy();
  });

  it('prefers the dedicated confirmPending entry over re-executing the tool', async () => {
    const execute = vi.fn(async () => pendingReply);
    const confirmPending = vi.fn(async () => ({ ok: true, tool: 'classify_book' }));
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 1) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit('已处理');
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
      confirmPending,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]')
      ?.click();
    await flushUntil(
      () =>
        panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden ===
          true && confirmPending.mock.calls.length >= 1,
    );
    expect(confirmPending).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Function));
    expect(execute).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it('keeps the edit entry locked while a confirmation batch is in flight', async () => {
    let releaseConfirm: (() => void) | null = null;
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    const confirmPending = vi.fn(async () => {
      await confirmGate;
      return { ok: true, tool: 'classify_book', message: '已归入旧书' };
    });
    const execute = vi.fn(async () => pendingReply);
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 1) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit(`回答${round}`);
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
      confirmPending,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    const editButton = (): HTMLButtonElement | null =>
      panel.element
        .querySelectorAll<HTMLElement>('.lightink-reader-assistant-message[data-role="user"]')[0]
        ?.querySelector<HTMLButtonElement>('[data-assistant-action-kind="edit"]') ?? null;
    const editorIn = (): HTMLTextAreaElement | null =>
      panel.element.querySelector<HTMLTextAreaElement>('[data-assistant-edit-input]');
    expect(editButton()?.disabled).toBe(false);

    const confirmAll = panel.element.querySelector<HTMLButtonElement>(
      '[data-assistant-pending-confirm-all]',
    );
    expect(confirmAll?.disabled).toBe(false);
    confirmAll!.click();
    // await confirmPending 窗口内：编辑入口禁用，点击无法进入编辑（草稿不会被清）。
    await flushUntil(() => confirmPending.mock.calls.length === 1);
    expect(editButton()?.disabled).toBe(true);
    editButton()!.click();
    expect(editorIn()).toBeNull();

    releaseConfirm!();
    await flushUntil(() => editButton()?.disabled === false);
    expect(editorIn()).toBeNull();
    panel.destroy();
  });

  it('re-enqueues a rejected suggestion as pending when it appears again', async () => {
    const execute = vi.fn(async () => pendingReply);
    let round = 0;
    const script: Script = async () => {
      round += 1;
      return {
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: `c${round}`, name: 'classify_book', arguments: '{}' }],
      };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-reject-all]')
      ?.click();
    await flush();
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden,
    ).toBe(true);

    submitQuestion(panel, '再整理一次');
    await flushUntil(
      () =>
        panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]')
          ?.dataset.status === 'pending',
    );
    expect(panel.element.querySelector('[data-assistant-pending-check="p1"]')).not.toBeNull();
    panel.destroy();
  });

  it('keeps pending refs out of the tool results sent back to the model', async () => {
    const libraryReply = {
      ok: true,
      tool: 'library_organize',
      pending: true,
      pending_confirmation: [
        {
          id: 'p1',
          summary: '将《示例书》归入「旧书」',
          tool: 'library_organize',
          arguments: { pending_ref: 'p1' },
        },
      ],
    };
    const execute = vi.fn(async () => libraryReply);
    let round = 0;
    const script: Script = async () => {
      round += 1;
      return {
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: 'c1', name: 'library_organize', arguments: '{}' }],
      };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '整理一下');
    await flushUntil(() => round >= 1 && panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null);
    const sent = stripAssistantPendingConfirmations(
      JSON.stringify(libraryReply),
    );
    expect(sent).not.toContain('pending_ref');
    expect(sent).not.toContain('pending_confirmation');
    expect(sent).toContain('这不是失败');
    expect(
      panel.element.querySelector('[data-assistant-pending-id="p1"]'),
    ).not.toBeNull();
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-pending')).toHaveLength(1);
    panel.destroy();
  });

  it('confirms only checked rows and rejects the removed one without a second card', async () => {
    const confirmPending = vi.fn(async () => ({ ok: true, tool: 'classify_book' }));
    const pending = {
      ok: true,
      tool: 'classify_book',
      pending_confirmation: [
        { id: 'p1', summary: '归入甲', tool: 'classify_book', arguments: { a: 1 } },
        { id: 'p2', summary: '归入乙', tool: 'classify_book', arguments: { a: 2 } },
      ],
    };
    let round = 0;
    const script: Script = async ({ emit }) => {
      round += 1;
      if (round === 1) {
        return {
          finish: 'tool_calls',
          totalChars: 0,
          toolCalls: [{ id: 'c1', name: 'classify_book', arguments: '{}' }],
        };
      }
      emit('已处理');
      return { finish: 'stop', totalChars: 3 };
    };
    const session = {
      tools: [],
      specifiedChapterCount: () => 0,
      execute: vi.fn(async () => pending),
      confirmPending,
    } as unknown as AssistantToolSession;
    const { panel } = mountPanel({ script, createToolSession: () => session });
    panel.open();
    await flush();
    submitQuestion(panel, '整理两本');
    await flushUntil(
      () => panel.element.querySelectorAll('[data-assistant-pending-check]').length === 2,
    );
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-pending')).toHaveLength(1);
    const second = panel.element.querySelector<HTMLInputElement>(
      '[data-assistant-pending-check="p2"]',
    );
    second!.checked = false;
    second!.dispatchEvent(new Event('change', { bubbles: true }));
    panel.element
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm-all]')
      ?.click();
    await flushUntil(
      () =>
        panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending')?.hidden ===
        true,
    );
    expect(confirmPending).toHaveBeenCalledWith('p1', expect.any(Function), expect.any(Function));
    expect(confirmPending).not.toHaveBeenCalledWith('p2', expect.any(Function), expect.any(Function));
    expect(panel.element.querySelector('[data-assistant-pending-id="p1"]')).toBeNull();
    expect(panel.element.querySelector('[data-assistant-pending-id="p2"]')).toBeNull();
    panel.destroy();
  });

  it('pins the pending card above the quick actions', async () => {
    const execute = vi.fn(async () => pendingReply);
    const { panel } = mountPanel(toolCallsRounds(execute));
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    const main = panel.element.querySelector('.lightink-reader-assistant-main');
    const messagesHost = panel.element.querySelector('.lightink-reader-assistant-messages');
    const card = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending');
    const actions = panel.element.querySelector('.lightink-reader-assistant-actions');
    expect(card?.parentElement).toBe(main);
    expect(messagesHost?.contains(card ?? null)).toBe(false);
    expect(card?.nextElementSibling?.nextElementSibling).toBe(actions);
    panel.destroy();
  });

  it('keeps the pending card above the quick actions while new messages arrive', async () => {
    const execute = vi.fn(async () => pendingReply);
    const { panel } = mountPanel(toolCallsRounds(execute));
    panel.open();
    await flush();
    submitQuestion(panel, '把示例书归入旧书');
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-id="p1"]') !== null,
    );

    submitQuestion(panel, '再问一句');
    await flushUntil(() => bubbleTexts(panel, 'assistant').length >= 2);

    const main = panel.element.querySelector('.lightink-reader-assistant-main');
    const card = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-pending');
    expect(card?.parentElement).toBe(main);
    expect(
      panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]')?.dataset.status,
    ).toBe('pending');
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-pending')).toHaveLength(1);
    panel.destroy();
  });

  it('forbids prose confirmation in the reader and library system prompts', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const key of [
        'reader.assistant.systemPrompt',
        'library.assistant.systemPrompt',
      ] as const) {
        const prompt = translate(locale, key);
        expect(prompt).toContain(locale === 'zh-CN' ? '确认卡片' : 'confirmation card');
        expect(prompt).toContain('✅');
        expect(prompt).toContain('❌');
        expect(prompt).toContain(locale === 'zh-CN' ? '最终确认' : 'final confirmation');
        expect(prompt).toContain(locale === 'zh-CN' ? '只通过工具提交' : 'only through tools');
      }
    }
  });
});

describe('createAssistantPanel surface injection', () => {
  it('routes mount/pin/unpin/touch through the injected surface, not the reader', async () => {
    const calls: string[] = [];
    const touchProbes: boolean[] = [];
    let touch = false;
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      surface: {
        mount: (element, hostElement) => {
          calls.push(`mount:${hostElement === host}:${element.parentNode === null}`);
        },
        pin: (element, hostElement) => {
          calls.push(`pin:${hostElement === host}:${element.tagName}`);
        },
        unpin: () => calls.push('unpin'),
        touchMode: () => {
          touchProbes.push(touch);
          return touch;
        },
      },
    });
    panel.open();
    await flush();
    expect(panel.isVisible()).toBe(true);
    // 宿主注入的 mount 独占 portal：core 缺省不会另挂 body。
    expect(panel.element.parentNode).toBeNull();
    expect(calls).toEqual(['mount:true:true', 'pin:true:ASIDE']);
    expect(touchProbes.length).toBeGreaterThan(0);
    touch = true;
    panel.close();
    expect(panel.isVisible()).toBe(false);
    expect(calls).toEqual(['mount:true:true', 'pin:true:ASIDE', 'unpin']);
    panel.destroy();
    expect(calls).toEqual(['mount:true:true', 'pin:true:ASIDE', 'unpin', 'unpin']);
  });
});

describe('serializeAssistantHistoryStore still round-trips panel writes', () => {
  it('keeps v2 envelopes written by the panel', () => {
    const json = serializeAssistantHistoryStore({
      version: 2,
      activeId: 'a',
      conversations: [
        {
          id: 'a',
          title: '问',
          messages: [{ role: 'user', content: '问', createdAt: 1 }],
          updatedAt: 2,
        },
      ],
    });
    expect(parseAssistantHistoryStore(json).activeId).toBe('a');
  });
});
