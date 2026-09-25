// @vitest-environment jsdom

/**
 * Contract for `src/assistant/assistant-panel.ts` (ADR-3 / ADR-6 / R1/R3):
 *
 * - 输入默认多行并长高；可引用选区；生成中可停止且保留已生成文字。
 * - 面板管理多段历史；工具调用显示为块；查询定位可点跳转。
 * - 一次发送内工具往返满 24 轮后停止并提示。
 * - 用户消息纯文本；助手消息 Markdown。流式停止丢掉 Channel。
 * - 待确认列表渲染工具返回的 pending_confirmation，确认后回调同一执行器；
 *   未确认前不执行落盘。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_MAX_TOOL_ROUNDS,
  ASSISTANT_PANEL_ACTIONS,
  assistantActionContent,
  clipAssistantContext,
  createAssistantPanel,
  parseAssistantPendingConfirmations,
  streamAssistantChat,
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

    let bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
    const failed = bubbles[1]!;
    expect(failed.querySelector('.lightink-reader-assistant-error')?.textContent).toContain(
      '无法连接 AI 服务',
    );
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截']);

    fail = false;
    failed.querySelector<HTMLButtonElement>('.lightink-reader-assistant-retry')?.click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
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
    const stop = panel.element.querySelector<HTMLButtonElement>('[data-assistant-stop]');
    expect(stop?.hidden).toBe(false);
    expect(stop?.disabled).toBe(false);
    stop!.click();
    await flush();
    expect(bubbleTexts(panel, 'assistant')[0]).toContain('半截回答');
    expect(panel.element.querySelector('.lightink-reader-assistant-error')?.textContent).toBe(
      t('reader.assistant.stopped'),
    );
    expect(stop?.hidden).toBe(true);
    expect(stop?.disabled).toBe(true);
    submitQuestion(panel, '第二问');
    await flush();
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问', '第二问']);
    panel.destroy();
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
    expect(createToolSession).toHaveBeenCalledWith('把《三体》归到科幻');
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
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm="p1"]')
      ?.click();
    await flushUntil(
      () => panel.element.querySelector('[data-assistant-pending-status="confirmed"]') !== null,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith('classify_book', {
      book: '示例书',
      group: '旧书',
    });
    const confirmed = panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]');
    expect(confirmed?.dataset.status).toBe('confirmed');
    expect(confirmed?.querySelector('[data-assistant-pending-confirm]')).toBeNull();
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
      .querySelector<HTMLButtonElement>('[data-assistant-pending-reject="p1"]')
      ?.click();
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    const rejected = panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]');
    expect(rejected?.dataset.status).toBe('rejected');
    expect(panel.element.querySelector('[data-assistant-pending-status]')?.textContent).toBe(
      t('reader.assistant.pendingRejected'),
    );
    expect(panel.element.querySelector('[data-assistant-pending-confirm]')).toBeNull();
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
      .querySelector<HTMLButtonElement>('[data-assistant-pending-confirm="p1"]')
      ?.click();
    await flushUntil(
      () =>
        panel.element.querySelector('.lightink-reader-assistant-pending-error')?.textContent ===
        '分组不存在',
    );
    const failed = panel.element.querySelector<HTMLElement>('[data-assistant-pending-id="p1"]');
    expect(failed?.dataset.status).toBe('pending');
    expect(failed?.querySelector('[data-assistant-pending-confirm]')).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
    panel.destroy();
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
