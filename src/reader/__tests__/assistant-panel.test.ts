// @vitest-environment jsdom

/**
 * Contract for `src/reader/assistant-panel.ts` (ADR-6 / R5):
 *
 * - 纯函数：章节上下文截断（保留前部、代理对边界安全）、历史文件防御解析/
 *   序列化、流式请求构造（系统提示 + 近期轮次，失败占位不进请求）。
 * - 流式通道：`ai_chat_stream` 经注入的 invoke + Channel 增量回调，终态解析。
 * - 面板：未配置显示前往配置引导而非空聊天框；配置后提问/快捷动作以对话
 *   消息呈现，回答渐进显示；章节上下文超限在回答前提示；失败显示错误且
 *   可原地重试；本章摘要可保存为标注；按书哈希历史重开续显、身份不可用
 *   时退化为仅内存。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_PANEL_ACTIONS,
  assistantActionContent,
  assistantSystemPrompt,
  buildAssistantChatRequest,
  clipAssistantContext,
  createAssistantPanel,
  parseAssistantHistory,
  serializeAssistantHistory,
  streamAssistantChat,
  type AssistantHistoryMessage,
  type AssistantInvoke,
  type AssistantPanelDeps,
} from '../assistant-panel.js';
import { READER_LIMITS } from '../reader-limits.js';
import { translate, type MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-android');
});

// ── 纯函数 ───────────────────────────────────────────────────────────

describe('clipAssistantContext', () => {
  it('keeps short chapters whole and marks long ones truncated at the head', () => {
    expect(clipAssistantContext('  短章  ')).toEqual({ text: '短章', truncated: false });
    const long = 'a'.repeat(READER_LIMITS.maxAssistantContextChars + 5);
    const clipped = clipAssistantContext(long);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe('a'.repeat(READER_LIMITS.maxAssistantContextChars));
    // 保留的是前部（R5 措辞），不是尾部。
    expect(clipped.text.endsWith('aaaaa')).toBe(true);
  });

  it('never splits a surrogate pair at the cut boundary', () => {
    const emoji = '😀'.repeat(READER_LIMITS.maxAssistantContextChars + 1);
    const clipped = clipAssistantContext(emoji);
    expect(clipped.truncated).toBe(true);
    // 每个 😀 是 2 个 code unit：回退一字后必为偶数长度，无半个字符。
    expect(clipped.text.length % 2).toBe(0);
    expect(clipped.text).not.toContain('\u{FFFD}');
  });

  it('honours an explicit smaller limit', () => {
    expect(clipAssistantContext('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
});

describe('parseAssistantHistory / serializeAssistantHistory', () => {
  const sample: AssistantHistoryMessage[] = [
    { role: 'user', content: '这章讲什么?', createdAt: 1, action: 'chapterSummary' },
    { role: 'assistant', content: '要点……', createdAt: 2, contextTruncated: true },
    { role: 'assistant', content: '失败了一半', createdAt: 3, error: '请求超时。' },
  ];

  it('round-trips through the v1 envelope', () => {
    const json = serializeAssistantHistory(sample);
    const parsed = JSON.parse(json) as { version: number; messages: unknown[]; updatedAt: number };
    expect(parsed.version).toBe(1);
    expect(parsed.messages).toHaveLength(3);
    expect(parseAssistantHistory(json)).toEqual(sample);
  });

  it('treats corrupt or malformed files as empty history, never throws', () => {
    for (const raw of ['', '   ', '{not-json', 'null', '[]', '{"messages":"no"}']) {
      expect(parseAssistantHistory(raw)).toEqual([]);
    }
  });

  it('drops invalid entries and caps hostile files', () => {
    const entries: Array<{ role: string; content: string; createdAt: number }> = Array.from(
      { length: 500 },
      (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `m${index}`,
        createdAt: index,
      }),
    );
    entries[4] = { role: 'tool', content: 'bad role', createdAt: 0 };
    const parsed = parseAssistantHistory(
      JSON.stringify({ messages: [...entries, { role: 'user', content: 42 }] }),
    );
    // 499 条合法（1 条坏 role 被丢）+ 追加的 content 非字符串被丢 → 截到 400 上限。
    expect(parsed).toHaveLength(400);
    expect(parsed.every((message) => typeof message.content === 'string')).toBe(true);
  });
});

describe('assistantSystemPrompt / assistantActionContent', () => {
  it('appends the chapter block only when chapter text exists', () => {
    const base = '你是助手。';
    expect(assistantSystemPrompt(base, null)).toBe(base);
    expect(assistantSystemPrompt(base, { title: '', text: '' })).toBe(base);
    const withChapter = assistantSystemPrompt(base, { title: '第一章', text: '正文' });
    expect(withChapter.startsWith(base)).toBe(true);
    expect(withChapter).toContain('【当前章节：第一章】');
    expect(withChapter).toContain('<chapter>\n正文\n</chapter>');
    expect(assistantSystemPrompt(base, { title: '', text: '正文' })).toContain('【当前章节】');
  });

  it('embeds the selection quote for explain/summarize and clips long quotes', () => {
    const explain = assistantActionContent('explain', '请解释：', '难句');
    expect(explain).toContain('请解释：');
    expect(explain).toContain('<selection>\n难句\n</selection>');
    const longQuote = '字'.repeat(READER_LIMITS.maxAssistantContextChars + 20);
    const summarize = assistantActionContent('summarize', '请总结：', longQuote);
    const body = /<selection>\n([\s\S]*)\n<\/selection>/.exec(summarize)?.[1] ?? '';
    expect(body).not.toBe(longQuote); // 超长引文被截断（保留前部）
    expect(body).toBe('字'.repeat(READER_LIMITS.maxAssistantContextChars));

    const chapterAction = assistantActionContent('quiz', '出题指令');
    expect(chapterAction).toBe('出题指令');
  });
});

describe('buildAssistantChatRequest', () => {
  it('puts the system prompt first and carries recent turns in order', () => {
    const history: AssistantHistoryMessage[] = [
      { role: 'user', content: 'q1', createdAt: 1 },
      { role: 'assistant', content: 'a1', createdAt: 2 },
      { role: 'user', content: 'q2', createdAt: 3 },
    ];
    const request = buildAssistantChatRequest('SYS', history);
    expect(request.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(request[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(request[2]?.content).toBe('a1');
  });

  it('excludes failed placeholders and empty assistant turns', () => {
    const history: AssistantHistoryMessage[] = [
      { role: 'user', content: 'q1', createdAt: 1 },
      { role: 'assistant', content: '', createdAt: 2, error: '超时' },
      { role: 'assistant', content: '   ', createdAt: 3 },
    ];
    const request = buildAssistantChatRequest('SYS', history);
    expect(request.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('caps the turn count and the character budget from the newest side', () => {
    const many: AssistantHistoryMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg-${index}`,
      createdAt: index,
    }));
    const capped = buildAssistantChatRequest('SYS', many, 5);
    expect(capped).toHaveLength(6);
    expect(capped[capped.length - 1]?.content).toBe('msg-39');

    const wide: AssistantHistoryMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: 'user' as const,
      content: 'x'.repeat(50_000),
      createdAt: index,
    }));
    const budgeted = buildAssistantChatRequest('SYS', wide, 40, 120_000);
    expect(budgeted.length).toBeLessThan(wide.length + 1);
    expect(budgeted[budgeted.length - 1]?.content.startsWith('x')).toBe(true);
  });
});

/** 注入 mock 的调用记录形态（invoke 兼容 + mock.calls 可读）。 */
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
      [{ role: 'user', content: 'hi' }],
      (delta) => deltas.push(delta),
      {
        invoke,
        createChannel: <T>() =>
          ({ onmessage: () => undefined }) as { onmessage: (message: T) => void },
      },
    );
    expect(deltas).toEqual(['你', '好']);
    expect(done).toEqual({ finish: 'stop', totalChars: 2 });
    const payload = invoke.mock.calls[0]?.[1] as { messages: unknown[]; onEvent: unknown };
    expect(payload.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(payload.onEvent).toBeDefined();
  });

  it('normalizes a missing terminal payload', async () => {
    const done = await streamAssistantChat([], () => undefined, {
      invoke: vi.fn(async () => undefined),
      createChannel: () => ({ onmessage: () => undefined }),
    });
    expect(done).toEqual({ finish: 'closed', totalChars: 0 });
  });
});

// ── 面板组件 ─────────────────────────────────────────────────────────

interface StreamScript {
  readonly emit: (text: string) => void;
  readonly messages: readonly { role: string; content: string }[];
}

type Script = (script: StreamScript) => Promise<unknown> | unknown;

/** 注入面：invoke 捕获请求，channel 把 delta 回灌面板。 */
function fakeStream(script: Script): {
  invoke: InvokeMock;
  createChannel: () => { onmessage: (message: unknown) => void };
} {
  const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
    const channel = args?.onEvent as { onmessage: (event: unknown) => void };
    const messages = (args?.messages as { role: string; content: string }[]) ?? [];
    return await script({
      emit: (text: string) => {
        channel.onmessage({ type: 'delta', text });
      },
      messages,
    });
  });
  return {
    invoke: invoke as unknown as InvokeMock,
    createChannel: () => ({ onmessage: () => undefined }),
  };
}

interface MountOptions {
  readonly configured?: boolean;
  readonly chapter?: { title: string; text: string } | null;
  readonly historyKey?: string | null;
  readonly historyJson?: string;
  readonly script?: Script;
}

function mountPanel(options: MountOptions = {}): {
  panel: ReturnType<typeof createAssistantPanel>;
  invoke: InvokeMock;
  deps: {
    openSettings: ReturnType<typeof vi.fn>;
    saveAnnotation: ReturnType<typeof vi.fn>;
    readHistory: ReturnType<typeof vi.fn>;
    writeHistory: ReturnType<typeof vi.fn>;
  };
} {
  const script: Script =
    options.script ?? (async ({ emit }) => {
      emit('回答内容');
      return { finish: 'stop', totalChars: 4 };
    });
  const stream = fakeStream(script);
  const calls = {
    openSettings: vi.fn(),
    saveAnnotation: vi.fn(),
    readHistory: vi.fn(async () => options.historyJson ?? ''),
    writeHistory: vi.fn(async () => undefined),
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
  };
  const panel = createAssistantPanel(deps);
  return { panel, invoke: stream.invoke, deps: calls };
}

const host = document.createElement('div');
host.className = 'lightink-reader';
document.body.append(host);

function bubbleTexts(panel: ReturnType<typeof createAssistantPanel>, role: string): string[] {
  return [...panel.element.querySelectorAll(`.lightink-reader-assistant-message[data-role="${role}"]`)]
    .map((bubble) =>
      bubble.querySelector('.lightink-reader-assistant-message-text')?.textContent ?? '',
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

describe('createAssistantPanel unconfigured guide (R5)', () => {
  it('shows the guide with a settings entry instead of an empty chat box', async () => {
    const { panel, deps } = mountPanel({ configured: false });
    panel.open();
    await flush();
    const guide = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-guide');
    const main = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main');
    expect(guide?.hidden).toBe(false);
    expect(main?.hidden).toBe(true);
    panel.element
      .querySelector<HTMLButtonElement>('.lightink-reader-assistant-settings')
      ?.click();
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
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main')?.hidden).toBe(true);
    configured = true;
    document.dispatchEvent(
      new CustomEvent('lightink:reader-ai-configured', { detail: { configured: true } }),
    );
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main')?.hidden).toBe(false);
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-guide')?.hidden).toBe(true);
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
    };
    expect(payload.messages[0]?.role).toBe('system');
    expect(payload.messages[0]?.content).toContain('章节正文');
    expect(payload.messages[payload.messages.length - 1]).toEqual({ role: 'user', content: '这章讲什么?' });
    expect(bubbleTexts(panel, 'user')).toEqual(['这章讲什么?']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答内容']);

    expect(deps.writeHistory).toHaveBeenCalledTimes(1);
    const [key, json] = deps.writeHistory.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(key).toBe('0123456789abcdef');
    const persisted = parseAssistantHistory(json);
    expect(persisted.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(persisted[1]?.content).toBe('回答内容');
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
    const second = invoke.mock.calls[1]?.[1] as {
      messages: { role: string; content: string }[];
    };
    expect(second.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      `system:${second.messages[0]!.content}`,
      'user:第一问',
      'assistant:回答内容',
      'user:追问',
    ]);
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

    const system = (invoke.mock.calls[0]?.[1] as { messages: { content: string }[] }).messages[0]!
      .content;
    expect(system).toContain('章'.repeat(10));
    expect(system.endsWith('章'.repeat(100))).toBe(false);

    const bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    const answer = bubbles[bubbles.length - 1]!;
    const notice = answer.querySelector('.lightink-reader-assistant-notice');
    expect(notice?.textContent).toContain(String(READER_LIMITS.maxAssistantContextChars));
    // 提示出现在回答文本之前（回答前提示）。
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
    // 半截内容仍在（历史不删除）。
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截']);

    fail = false;
    failed.querySelector<HTMLButtonElement>('.lightink-reader-assistant-retry')?.click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    // 重试是重发同一请求：两条消息（user + assistant 占位），不新增 user 轮。
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
    expect(input?.value).toBe('第二问'); // 流式中未发出：草稿保留
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问']);
    (release as ((value: unknown) => void) | null)?.(null);
    await flush();
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
    expect(payload.messages[0]?.content).toContain('本章正文内容');
    expect(payload.messages[payload.messages.length - 1]?.content).toBe(t('reader.assistant.prompt.chapterSummary'));

    const bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    const answer = bubbles[bubbles.length - 1]!;
    const save = answer.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save');
    expect(save).not.toBeNull();
    save!.click();
    expect(deps.saveAnnotation).toHaveBeenCalledWith('回答内容');
    expect(save!.disabled).toBe(true);
    expect(save!.textContent).toBe(t('reader.assistant.saved'));
    // 已保存后重复点击不再触发。
    save!.click();
    expect(deps.saveAnnotation).toHaveBeenCalledTimes(1);

    // 生词卡 / 章节测验同样以对话消息呈现（无保存按钮）。
    actionButton(panel, 'vocabulary').click();
    await flush();
    actionButton(panel, 'quiz').click();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(3);
    const vocab = invoke.mock.calls[1]?.[1] as { messages: { content: string }[] };
    const quiz = invoke.mock.calls[2]?.[1] as { messages: { content: string }[] };
    expect(vocab.messages[vocab.messages.length - 1]?.content).toBe(t('reader.assistant.prompt.vocabulary'));
    expect(quiz.messages[quiz.messages.length - 1]?.content).toBe(t('reader.assistant.prompt.quiz'));
    const lastBubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(lastBubbles[lastBubbles.length - 1]!.querySelector('.lightink-reader-assistant-save')).toBeNull();
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
    expect(bubbleTexts(panel, 'user')[0]).toContain('一个难句');

    panel.close();
    panel.askWithSelection('summarize', '一段要总结的话');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(bubbleTexts(panel, 'user')[1]).toContain(t('reader.assistant.prompt.summarize'));
    panel.destroy();
  });
});

describe('createAssistantPanel history lifecycle', () => {
  const storedHistory = serializeAssistantHistory([
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
    expect(deps.readHistory).toHaveBeenCalledTimes(1); // 同书重开不重读
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
    json = serializeAssistantHistory([
      { role: 'user', content: '另一本书的问题', createdAt: 20 },
    ]);
    panel.open();
    await flush();
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(bubbleTexts(panel, 'user')).toEqual(['另一本书的问题']);
    panel.destroy();
  });

  it('drops the previous book conversation when identity changes after interaction', async () => {
    // 回归:触屏 replace-existing-reader 复用同一面板实例——书 A 交互过(epoch>=1)
    // 后换书 B,旧对话不得残留展示,更不得被写进书 B 的历史文件。
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
    panel.open(); // 换书重开:会话复位并装载书 B 历史(为空)
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    expect(bubbleTexts(panel, 'assistant')).toEqual([]);

    // 书 B 新对话只包含书 B 内容;书 A 的消息从未写入书 B 的键。
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

  it('clears this book’s conversation from memory and disk via the header action', async () => {
    const clearedKeys: string[] = [];
    const stream = fakeStream(async ({ emit }) => {
      emit('回答');
      return { finish: 'stop', totalChars: 2 };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      fetchConfig: async () => ({ configured: true, missing: [] }),
      readHistory: async () => '',
      writeHistory: async () => undefined,
      clearHistory: async (key) => {
        clearedKeys.push(key);
      },
      historyKey: () => '0123456789abcdef',
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '要被清除的问题');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['要被清除的问题']);

    const clearButton = panel.element.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-clear',
    );
    expect(clearButton).not.toBeNull();
    clearButton!.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    expect(clearedKeys).toEqual(['0123456789abcdef']);
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
    expect(bubbleTexts(panel, 'user')).toEqual(['临时问题']); // 内存续显
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
    expect(panel.element.parentNode).toBe(document.body); // portal 到 body
    expect(document.body.contains(panel.element.querySelector('.lightink-reader-assistant-input'))).toBe(
      true,
    );
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
          lateEmit = emit; // 悬挂的流：destroy 后才推 delta / 永不 resolve
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
    submitQuestion(panel, '问题'); // 流式启动，invoke 已捕获 emit
    await flush();
    expect(lateEmit).not.toBeNull();

    panel.destroy();
    expect(() => lateEmit!('迟到的增量')).not.toThrow();
    // 销毁后迟到 delta 不落消息：气泡停留在销毁前的流式占位。
    expect(bubbleTexts(panel, 'assistant')).toEqual([t('reader.assistant.streaming')]);
    expect(panel.element.textContent).not.toContain('迟到的增量');
    expect(() =>
      document.dispatchEvent(
        new CustomEvent('lightink:reader-ai-configured', { detail: { configured: false } }),
      ),
    ).not.toThrow();
  });
});
