// @vitest-environment jsdom

/**
 * Contract for `src/reader/assistant-panel.ts` (R1–R6):
 *
 * - 未配置显示前往配置引导而非空聊天框；配置后提问/快捷动作以对话消息呈现，
 *   回答渐进显示并按 Markdown 渲染（用户消息保持纯文本）。
 * - 请求分层：同章追问 ①②③ 不变、只增轮次；换章只变 ③；超长章截断提示在
 *   回答前。
 * - 工具循环：模型要求调用工具时在面板内执行、显示工具块、回传后继续；达到
 *   24 轮上限停止并说明；回答里的定位链接点击后由宿主跳转。
 * - 输入区：引用当前选区、生成中可停止（已生成文字保留）、流式中草稿保留。
 * - 历史：按书多段会话（新建/切换/删除/重开恢复活动段/v1 迁移/超限拒写提示）；
 *   身份不可用时仅内存；换书不残留旧书对话。
 * - 跟随：上滑后不被拉回底部，回到底部后再次跟随。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_PANEL_ACTIONS,
  assistantActionContent,
  assistantSelectionQuote,
  createAssistantPanel,
  type AssistantPanelDeps,
} from '../assistant-panel.js';
import {
  parseAssistantHistory,
  serializeAssistantHistory,
  type AssistantHistoryFile,
  type AssistantToolCall,
} from '../assistant-history.js';
import {
  ASSISTANT_MAX_TOOL_CALLS_PER_TURN,
  ASSISTANT_MAX_TOOL_ROUNDS,
  type AssistantBookAccess,
} from '../assistant-tools.js';
import type { AssistantInvoke } from '../assistant-request.js';
import { READER_LIMITS } from '../reader-limits.js';
import { ASSISTANT_CONTEXT_TRUNCATED_NOTE } from '../assistant-request.js';
import { translate, type MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

const flush = async (rounds = 3): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
  document.documentElement.removeAttribute('data-android');
});

const host = document.createElement('div');
host.className = 'lightink-reader';
document.body.append(host);

// ── 纯函数 ───────────────────────────────────────────────────────────

describe('assistantActionContent / assistantSelectionQuote', () => {
  it('embeds the selection quote for explain/summarize and clips long quotes', () => {
    const explain = assistantActionContent('explain', '请解释：', '难句');
    expect(explain).toContain('请解释：');
    expect(explain).toContain('<selection>\n难句\n</selection>');
    const longQuote = '字'.repeat(READER_LIMITS.maxAssistantContextChars + 20);
    const summarize = assistantActionContent('summarize', '请总结：', longQuote);
    const body = /<selection>\n([\s\S]*)\n<\/selection>/.exec(summarize)?.[1] ?? '';
    expect(body).toBe('字'.repeat(READER_LIMITS.maxAssistantContextChars));
    expect(assistantActionContent('quiz', '出题指令')).toBe('出题指令');
    expect(assistantSelectionQuote(' 引文 ')).toBe('<selection>\n引文\n</selection>\n');
  });
});

// ── 注入面 ───────────────────────────────────────────────────────────

interface StreamRequest {
  readonly requestId: string;
  readonly system: string;
  readonly context: string | null;
  readonly tools: Array<{ name: string }>;
  readonly turns: Array<{
    role: string;
    content: string;
    toolCalls?: AssistantToolCall[];
    toolResults?: Array<{ callId: string; name: string; content: string; isError: boolean }>;
  }>;
}

interface StreamScript {
  readonly emit: (text: string) => void;
  readonly request: StreamRequest;
  readonly round: number;
}

type Script = (script: StreamScript) => Promise<unknown> | unknown;

type InvokeMock = AssistantInvoke & {
  readonly mock: { readonly calls: ReadonlyArray<[string, Record<string, unknown>?]> };
};

/** 注入面：invoke 捕获请求，channel 把 delta 回灌面板。 */
function fakeStream(script: Script): {
  invoke: InvokeMock;
  createChannel: () => { onmessage: (message: unknown) => void };
  requests: () => StreamRequest[];
  aborts: () => string[];
} {
  const requests: StreamRequest[] = [];
  const aborts: string[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'ai_chat_abort') {
      aborts.push(String(args?.requestId));
      return undefined;
    }
    const channel = args?.onEvent as { onmessage: (event: unknown) => void };
    const request = args?.request as StreamRequest;
    requests.push(request);
    return await script({
      emit: (text: string) => {
        channel.onmessage({ type: 'delta', text });
      },
      request,
      round: requests.length - 1,
    });
  });
  return {
    invoke: invoke as unknown as InvokeMock,
    createChannel: () => ({ onmessage: () => undefined }),
    requests: () => requests,
    aborts: () => aborts,
  };
}

function fakeAccess(overrides: Partial<AssistantBookAccess> = {}): AssistantBookAccess {
  return {
    bookInfo: () => ({ title: '书', format: 'epub', chapterCount: 3, pageCount: null, hasText: true }),
    outline: () => [
      { title: '第一章', chapter: 0 },
      { title: '第二章', chapter: 1 },
      { title: '第三章', chapter: 2 },
    ],
    currentChapter: () => ({ title: '第一章', text: '章节正文', chapter: 0 }),
    chapterAt: async (index) => ({ title: `第${index + 1}章`, text: `第${index + 1}章正文`, chapter: index }),
    selection: () => '',
    search: async () => ({ hits: [], hasMore: false, partial: false }),
    save: async (request) => ({ ok: true, kind: request.kind }),
    ...overrides,
  };
}

interface MountOptions {
  readonly configured?: boolean;
  readonly chapter?: { title: string; text: string } | null;
  readonly historyKey?: string | null;
  readonly historyJson?: string;
  readonly script?: Script;
  readonly access?: Partial<AssistantBookAccess>;
  readonly writeHistory?: (contentHash: string, json: string) => Promise<void>;
}

const chatCalls = (command: string) => (call: readonly [string, Record<string, unknown>?]) =>
  call[0] === command;

function mountPanel(options: MountOptions = {}): {
  panel: ReturnType<typeof createAssistantPanel>;
  invoke: InvokeMock;
  requests: () => StreamRequest[];
  aborts: () => string[];
  chatCount: () => number;
  deps: {
    openSettings: ReturnType<typeof vi.fn>;
    saveAnnotation: ReturnType<typeof vi.fn>;
    locate: ReturnType<typeof vi.fn>;
    openLink: ReturnType<typeof vi.fn>;
    readHistory: ReturnType<typeof vi.fn>;
    writeHistory: ReturnType<typeof vi.fn>;
    clearHistory: ReturnType<typeof vi.fn>;
  };
  written: () => AssistantHistoryFile;
} {
  const script: Script =
    options.script ??
    (async ({ emit }) => {
      emit('回答内容');
      return { finish: 'stop', totalChars: 4, toolCalls: [] };
    });
  const stream = fakeStream(script);
  let lastJson = '';
  const calls = {
    openSettings: vi.fn(),
    saveAnnotation: vi.fn(),
    locate: vi.fn(),
    openLink: vi.fn(),
    readHistory: vi.fn(async () => options.historyJson ?? ''),
    writeHistory: vi.fn(async (contentHash: string, json: string) => {
      lastJson = json;
      if (options.writeHistory !== undefined) {
        await options.writeHistory(contentHash, json);
      }
    }),
    clearHistory: vi.fn(async () => undefined),
  };
  const chapter = options.chapter === undefined ? { title: '第一章', text: '章节正文' } : options.chapter;
  const deps: AssistantPanelDeps = {
    t,
    host: () => host,
    chapterContext: () => chapter,
    openSettings: calls.openSettings,
    saveAnnotation: calls.saveAnnotation,
    access: fakeAccess({
      currentChapter: () => (chapter === null ? null : { ...chapter, chapter: 0 }),
      ...options.access,
    }),
    locate: calls.locate,
    openLink: calls.openLink,
    fetchConfig: async () => ({ configured: options.configured ?? true, missing: [] }),
    streamRenderIntervalMs: 0,
    readHistory: options.historyKey === null ? undefined : calls.readHistory,
    writeHistory: options.historyKey === null ? undefined : calls.writeHistory,
    clearHistory: calls.clearHistory,
    historyKey: () => options.historyKey ?? null,
    stream,
  };
  const panel = createAssistantPanel(deps);
  return {
    panel,
    invoke: stream.invoke,
    requests: stream.requests,
    aborts: stream.aborts,
    chatCount: () => stream.invoke.mock.calls.filter(chatCalls('ai_chat_stream')).length,
    deps: calls,
    written: () => parseAssistantHistory(lastJson),
  };
}

function bubbleTexts(panel: ReturnType<typeof createAssistantPanel>, role: string): string[] {
  return [...panel.element.querySelectorAll(`.lightink-reader-assistant-message[data-role="${role}"]`)]
    .map((bubble) =>
      bubble.querySelector('.lightink-reader-assistant-message-text')?.textContent ?? '',
    );
}

function inputOf(panel: ReturnType<typeof createAssistantPanel>): HTMLTextAreaElement {
  const input = panel.element.querySelector<HTMLTextAreaElement>('.lightink-reader-assistant-input');
  expect(input).not.toBeNull();
  return input!;
}

function submitQuestion(panel: ReturnType<typeof createAssistantPanel>, question: string): void {
  inputOf(panel).value = question;
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

function click(panel: ReturnType<typeof createAssistantPanel>, selector: string): void {
  const button = panel.element.querySelector<HTMLButtonElement>(selector);
  expect(button, `missing ${selector}`).not.toBeNull();
  button!.click();
}

// ── 未配置引导 ───────────────────────────────────────────────────────

describe('createAssistantPanel unconfigured guide', () => {
  it('shows the guide with a settings entry instead of an empty chat box', async () => {
    const { panel, deps } = mountPanel({ configured: false });
    panel.open();
    await flush();
    const guide = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-guide');
    const main = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-main');
    expect(guide?.hidden).toBe(false);
    expect(main?.hidden).toBe(true);
    click(panel, '.lightink-reader-assistant-settings');
    expect(deps.openSettings).toHaveBeenCalledTimes(1);
  });

  it('switches to the chat view when the configured event arrives', async () => {
    let configured = false;
    const stream = fakeStream(async ({ emit }) => {
      emit('ok');
      return { finish: 'stop', totalChars: 2, toolCalls: [] };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => ({ title: '第一章', text: '正文' }),
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured, missing: [] }),
      streamRenderIntervalMs: 0,
      stream,
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

// ── 流式对话与分层请求 ───────────────────────────────────────────────

describe('createAssistantPanel streaming conversation', () => {
  it('keeps the Markdown wrapper class on the rendered message body', async () => {
    const { panel } = mountPanel({
      script: ({ emit }) => {
        emit('## 标题\n\n- 一项');
        return { finish: 'stop', totalChars: 8, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问');
    await flush();
    // CSS 里的 Markdown 规则都挂在这个类下：丢了类，标题/列表/代码块样式全部失效。
    const body = panel.element.querySelector<HTMLElement>(
      '.lightink-reader-assistant-message[data-role="assistant"] .lightink-reader-assistant-message-text',
    );
    expect(body?.classList.contains('lightink-reader-assistant-markdown')).toBe(true);
    expect(body?.querySelector('h2')?.textContent).toBe('标题');
    expect(body?.querySelector('li')?.textContent).toBe('一项');
    panel.destroy();
  });

  it('streams an answer, renders it as Markdown, and persists a v2 session per book', async () => {
    const { panel, requests, deps, written } = mountPanel({
      historyKey: '0123456789abcdef',
      script: async ({ emit }) => {
        emit('# 要点\n\n- 第一');
        emit('条\n- 第二条');
        return { finish: 'stop', totalChars: 10, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '这章讲什么?');
    await flush();

    expect(requests()).toHaveLength(1);
    const request = requests()[0]!;
    expect(request.system).toBe(t('reader.assistant.systemPrompt'));
    expect(request.context).toContain('章节正文');
    expect(request.context).toContain('第一章');
    expect(request.tools.map((tool) => tool.name)).toEqual(['query_book', 'save_to_book']);
    expect(request.turns[request.turns.length - 1]).toEqual({ role: 'user', content: '这章讲什么?' });
    expect(bubbleTexts(panel, 'user')).toEqual(['这章讲什么?']);
    const answer = panel.element.querySelector('.lightink-reader-assistant-message.is-assistant');
    expect(answer?.querySelector('h1')?.textContent).toBe('要点');
    expect(answer?.querySelectorAll('li')).toHaveLength(2);
    expect(answer?.textContent).not.toContain('#');
    // 用户气泡保持纯文本。
    expect(panel.element.querySelector('.is-user h1')).toBeNull();

    expect(deps.writeHistory).toHaveBeenCalledTimes(1);
    expect(deps.writeHistory.mock.calls[0]?.[0]).toBe('0123456789abcdef');
    const file = written();
    expect(file.sessions).toHaveLength(1);
    expect(file.activeSessionId).toBe(file.sessions[0]!.id);
    expect(file.sessions[0]!.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(file.sessions[0]!.messages[1]!.content).toBe('# 要点\n\n- 第一条\n- 第二条');
    panel.destroy();
  });

  it('keeps tools, system prompt and chapter context byte-identical across follow-ups (R4/R5)', async () => {
    const { panel, requests } = mountPanel();
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '追问');
    await flush();
    expect(requests()).toHaveLength(2);
    const [first, second] = requests() as [StreamRequest, StreamRequest];
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.system).toBe(first.system);
    expect(second.context).toBe(first.context);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.turns.map((turn) => `${turn.role}:${turn.content}`)).toEqual([
      'user:第一问',
      'assistant:回答内容',
      'user:追问',
    ]);
    panel.destroy();
  });

  it('changes only the chapter context when the chapter changes', async () => {
    let chapter = { title: '第一章', text: '第一章正文' };
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1, toolCalls: [] };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => chapter,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '一');
    await flush();
    chapter = { title: '第二章', text: '第二章正文' };
    submitQuestion(panel, '二');
    await flush();
    const [a, b] = stream.requests() as [StreamRequest, StreamRequest];
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.system).toBe(b.system);
    expect(a.context).toContain('第一章正文');
    expect(b.context).toContain('第二章正文');
    expect(b.context).not.toContain('第一章正文');
    // 上下文提示条随章更新。
    expect(panel.element.querySelector('.lightink-reader-assistant-context-title')?.textContent).toBe('第二章');
    panel.destroy();
  });

  it('warns before the answer when the chapter context was clipped', async () => {
    const longChapter = '章'.repeat(READER_LIMITS.maxAssistantContextChars + 100);
    const { panel, requests } = mountPanel({ chapter: { title: '长章', text: longChapter } });
    panel.open();
    await flush();
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-context-badge.is-truncated')?.hidden,
    ).toBe(false);
    submitQuestion(panel, '总结');
    await flush();
    const context = requests()[0]!.context ?? '';
    expect(context).toContain('章'.repeat(10));
    expect(context.length).toBeLessThan(longChapter.length);
    expect(context).toContain('章'.repeat(READER_LIMITS.maxAssistantContextChars) + '\n</chapter>');
    const answer = panel.element.querySelector('.lightink-reader-assistant-message.is-assistant')!;
    const notice = answer.querySelector('.lightink-reader-assistant-notice');
    expect(notice?.textContent).toContain(String(READER_LIMITS.maxAssistantContextChars));
    expect(answer.firstElementChild?.className).toBe('lightink-reader-assistant-notice');
    panel.destroy();
  });

  it('shows the error with an in-place retry that resends the same exchange', async () => {
    let fail = true;
    const { panel, chatCount } = mountPanel({
      script: async ({ emit }) => {
        if (fail) {
          emit('半截');
          throw { code: 'AI_NETWORK_ERROR', message: '无法连接 AI 服务' };
        }
        emit('恢复后的回答');
        return { finish: 'stop', totalChars: 7, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();
    let bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]!.querySelector('.lightink-reader-assistant-error')?.textContent).toContain(
      '无法连接 AI 服务',
    );
    expect(bubbleTexts(panel, 'assistant')).toEqual(['半截']);
    fail = false;
    bubbles[1]!.querySelector<HTMLButtonElement>('.lightink-reader-assistant-retry')?.click();
    await flush();
    expect(chatCount()).toBe(2);
    bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    expect(bubbles).toHaveLength(2);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['恢复后的回答']);
    expect(panel.element.querySelector('.lightink-reader-assistant-retry')).toBeNull();
    panel.destroy();
  });

  it('offers retry only on the last exchange so earlier retries cannot wipe later answers', async () => {
    const { panel } = mountPanel({
      script: async ({ emit, round }) => {
        if (round === 0) {
          throw new Error('AI_NETWORK_ERROR');
        }
        emit('好');
        return { finish: 'stop', totalChars: 1, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-retry')).toHaveLength(1);
    submitQuestion(panel, '第二问');
    await flush();
    // 第一问的错误还在，但重试按钮只会出现在最后一次交换上。
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-error')).toHaveLength(1);
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-retry')).toHaveLength(0);
    panel.destroy();
  });

  it('submits on Enter, inserts a newline on Shift+Enter, and stops the stream when the AI is unconfigured', async () => {
    let release: ((value: unknown) => void) | null = null;
    const { panel, requests, aborts } = mountPanel({
      script: ({ emit }) => {
        emit('开头');
        return new Promise((resolve) => {
          release = () => resolve({ finish: 'stop', totalChars: 2, toolCalls: [] });
        });
      },
    });
    panel.open();
    await flush();
    const input = inputOf(panel);
    input.value = '一行';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(requests()).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(requests()).toHaveLength(1);
    // 流式中配置被清空：停止按钮随主区一起藏了，面板替用户中止。
    document.dispatchEvent(new CustomEvent('lightink:reader-ai-configured', { detail: { configured: false } }));
    await flush();
    expect(aborts()).toHaveLength(1);
    release!(null);
    await flush();
    panel.destroy();
  });

  it('keeps the draft when submitting while a stream is in flight', async () => {
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      script: async ({ emit }) => {
        emit('慢回答');
        await new Promise((resolve) => {
          release = resolve;
        });
        return { finish: 'stop', totalChars: 3, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '第一问');
    await flush();
    submitQuestion(panel, '第二问');
    expect(inputOf(panel).value).toBe('第二问');
    expect(bubbleTexts(panel, 'user')).toEqual(['第一问']);
    (release as ((value: unknown) => void) | null)?.(null);
    await flush();
    panel.destroy();
  });

  it('never executes scripts or javascript: links from the model', async () => {
    const { panel, deps } = mountPanel({
      script: async ({ emit }) => {
        emit('<script>window.__assistantPwned = 1</script>\n\n[点](javascript:alert(1)) [外](https://ok.test)');
        return { finish: 'stop', totalChars: 1, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, 'q');
    await flush();
    const answer = panel.element.querySelector('.lightink-reader-assistant-message.is-assistant')!;
    expect(answer.querySelector('script')).toBeNull();
    expect(answer.querySelector('a[href^="javascript"]')).toBeNull();
    answer.querySelector<HTMLAnchorElement>('a[href="https://ok.test"]')!.click();
    expect(deps.openLink).toHaveBeenCalledWith('https://ok.test');
    panel.destroy();
  });
});

// ── 工具循环 ─────────────────────────────────────────────────────────

describe('createAssistantPanel built-in tools (R6)', () => {
  it('executes a requested tool, shows the tool block, and continues with the result', async () => {
    const outline = vi.fn(() => [{ title: '第一章', chapter: 0 }]);
    const { panel, requests } = mountPanel({
      access: { outline },
      script: async ({ emit, round, request }) => {
        if (round === 0) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [{ id: 'c1', name: 'query_book', arguments: { action: 'outline' } }],
          };
        }
        const last = request.turns[request.turns.length - 1]!;
        emit(`目录有 ${JSON.parse(last.toolResults![0]!.content).total} 章`);
        return { finish: 'stop', totalChars: 5, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '这本书有几章?');
    await flush(6);
    expect(outline).toHaveBeenCalled();
    expect(requests()).toHaveLength(2);
    const second = requests()[1]!;
    const assistantTurn = second.turns[second.turns.length - 2]!;
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.toolCalls?.[0]).toEqual({ id: 'c1', name: 'query_book', arguments: { action: 'outline' } });
    const resultTurn = second.turns[second.turns.length - 1]!;
    expect(resultTurn.role).toBe('user');
    expect(resultTurn.toolResults?.[0]?.callId).toBe('c1');
    // ①②③ 在工具往返间也不变。
    expect(second.system).toBe(requests()[0]!.system);
    expect(second.context).toBe(requests()[0]!.context);
    const block = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-tool');
    expect(block?.dataset.toolName).toBe('query_book');
    expect(block?.dataset.toolStatus).toBe('ok');
    expect(block?.textContent).toContain(t('reader.assistant.tool.query'));
    expect(bubbleTexts(panel, 'assistant').filter((text) => text !== '')).toEqual(['目录有 1 章']);
    panel.destroy();
  });

  it('does not run save_to_book once the panel is closed, but still finishes read-only tools', async () => {
    const save = vi.fn(async () => ({ ok: true as const, kind: 'bookmark' as const }));
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      access: { save },
      script: ({ emit, round }) => {
        if (round === 0) {
          return new Promise((resolve) => {
            release = () =>
              resolve({
                finish: 'tool_calls',
                totalChars: 0,
                toolCalls: [
                  { id: 's1', name: 'save_to_book', arguments: { kind: 'bookmark' } },
                  { id: 'q1', name: 'query_book', arguments: { action: 'book_info' } },
                ],
              });
          });
        }
        emit('好的');
        return { finish: 'stop', totalChars: 2, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '加个书签');
    await flush();
    panel.close(); // 请求还在飞时用户关掉了面板
    release!(null);
    await flush(8);
    // 保存确认不能在面板关着的时候弹出来；只读查询照常完成，对话继续。
    expect(save).not.toHaveBeenCalled();
    const blocks = [...panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-tool')];
    expect(blocks.map((block) => block.dataset.toolStatus)).toEqual(['error', 'ok']);
    expect(blocks[0]?.textContent).toContain(t('reader.assistant.tool.panelClosed'));
    expect(bubbleTexts(panel, 'assistant').filter((text) => text !== '')).toEqual(['好的']);
    panel.destroy();
  });

  it('reverts the save button and warns when the host could not persist the summary', async () => {
    const { panel } = mountPanel({ historyKey: '0123456789abcdef' });
    (panel as unknown as { element: HTMLElement }).element; // keep type
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    const save = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!;
    save.click();
    await flush();
    expect(save.disabled).toBe(true);
    panel.destroy();
    const failing = mountPanel({ historyKey: '0123456789abcdef' });
    failing.deps.saveAnnotation.mockImplementation(async () => false);
    failing.panel.open();
    await flush();
    actionButton(failing.panel, 'chapterSummary').click();
    await flush();
    const button = failing.panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!;
    button.click();
    await flush();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(t('reader.assistant.saveAnnotation'));
    expect(failing.panel.element.querySelector('.lightink-reader-assistant-bar')?.textContent).toBe(t('reader.assistant.saveFailed'));
    failing.panel.destroy();
  });

  it('marks rejected saves and failed queries on the tool block', async () => {
    const { panel } = mountPanel({
      access: { save: async () => ({ ok: false, reason: 'rejected' }) },
      script: async ({ emit, round }) => {
        if (round === 0) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              { id: 's1', name: 'save_to_book', arguments: { kind: 'bookmark' } },
              { id: 'q1', name: 'query_book', arguments: { action: 'nope' } },
            ],
          };
        }
        emit('好的');
        return { finish: 'stop', totalChars: 2, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '加个书签');
    await flush(6);
    const blocks = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-tool');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.dataset.toolStatus).toBe('rejected');
    expect(blocks[1]!.dataset.toolStatus).toBe('error');
    panel.destroy();
  });

  it('runs tool calls sequentially so the chapter budget cannot be bypassed in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const chapterAt = vi.fn(async (index: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return { title: `第${index + 1}章`, text: `第${index + 1}章正文`, chapter: index };
    });
    const { panel } = mountPanel({
      access: { chapterAt },
      // 每轮塞满单轮上限，跨 4 轮共 16 章：章节预算 12 只能靠顺序计数守住。
      script: async ({ emit, round }) => {
        if (round < 4) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: Array.from({ length: ASSISTANT_MAX_TOOL_CALLS_PER_TURN }, (_, index) => ({
              id: `c${round}-${index}`,
              name: 'query_book',
              arguments: { action: 'chapter', chapter_index: round * ASSISTANT_MAX_TOOL_CALLS_PER_TURN + index },
            })),
          };
        }
        emit('读完了');
        return { finish: 'stop', totalChars: 3, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '把每一章都读一遍');
    await flush(60);
    expect(maxInFlight).toBe(1);
    expect(chapterAt).toHaveBeenCalledTimes(12);
    const blocks = [...panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-tool')];
    expect(blocks).toHaveLength(16);
    expect(blocks.filter((block) => block.dataset.toolStatus === 'error')).toHaveLength(4);
    panel.destroy();
  });

  it('caps the tool calls executed within one model reply and errors the rest', async () => {
    const search = vi.fn(async (query: string) => ({
      hits: [{ chapter: 0, snippet: query }],
      hasMore: false,
      partial: false,
    }));
    const { panel } = mountPanel({
      access: { search },
      script: async ({ emit, round }) => {
        if (round === 0) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: Array.from({ length: ASSISTANT_MAX_TOOL_CALLS_PER_TURN + 3 }, (_, index) => ({
              id: `s${index}`,
              name: 'query_book',
              arguments: { action: 'search', query: `词${index}` },
            })),
          };
        }
        emit('搜完了');
        return { finish: 'stop', totalChars: 3, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '把这些词都搜一遍');
    await flush(40);
    // 只执行前 N 个，其余不执行、直接回错误结果，模型下一轮能看到原因。
    expect(search).toHaveBeenCalledTimes(ASSISTANT_MAX_TOOL_CALLS_PER_TURN);
    const blocks = [...panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-tool')];
    expect(blocks).toHaveLength(ASSISTANT_MAX_TOOL_CALLS_PER_TURN + 3);
    expect(blocks.filter((block) => block.dataset.toolStatus === 'error')).toHaveLength(3);
    expect(blocks[blocks.length - 1]?.textContent).toContain(String(ASSISTANT_MAX_TOOL_CALLS_PER_TURN));
    const answers = bubbleTexts(panel, 'assistant');
    expect(answers[answers.length - 1]).toBe('搜完了');
    panel.destroy();
  });

  it('aborts the in-flight request when the panel is destroyed mid-stream', async () => {
    const { panel, aborts } = mountPanel({
      script: ({ emit }) => {
        emit('开头');
        return new Promise(() => undefined); // 悬挂到销毁
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问');
    await flush();
    expect(aborts()).toHaveLength(0);
    panel.destroy();
    await flush();
    expect(aborts()).toHaveLength(1);
  });

  it('does not leave a “calling tool” block behind when stopped during tool execution', async () => {
    const { panel } = mountPanel({
      access: { chapterAt: () => new Promise(() => undefined) }, // 工具悬挂
      script: async () => ({
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: 'c1', name: 'query_book', arguments: { action: 'chapter', chapter_index: 1 } }],
      }),
    });
    panel.open();
    await flush();
    submitQuestion(panel, '读第二章');
    await flush();
    expect(panel.element.querySelector('.lightink-reader-assistant-tool[data-tool-status="running"]')).not.toBeNull();
    click(panel, '.lightink-reader-assistant-stop');
    await flush();
    expect(panel.element.querySelector('.lightink-reader-assistant-tool[data-tool-status="running"]')).toBeNull();
    expect(panel.element.querySelector('.lightink-reader-assistant-stopped')).not.toBeNull();
    panel.destroy();
  });

  it('stops after the tool round limit and says so', async () => {
    const { panel, chatCount } = mountPanel({
      script: async ({ round }) => ({
        finish: 'tool_calls',
        totalChars: 0,
        toolCalls: [{ id: `c${round}`, name: 'query_book', arguments: { action: 'book_info' } }],
      }),
    });
    panel.open();
    await flush();
    submitQuestion(panel, '一直查');
    await flush(ASSISTANT_MAX_TOOL_ROUNDS * 3);
    expect(chatCount()).toBe(ASSISTANT_MAX_TOOL_ROUNDS);
    const error = panel.element.querySelector('.lightink-reader-assistant-error');
    expect(error?.textContent).toContain(String(ASSISTANT_MAX_TOOL_ROUNDS));
    expect(panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-send')?.hidden).toBe(false);
    panel.destroy();
  });

  it('jumps only when the user clicks a locate link in the answer', async () => {
    const { panel, deps } = mountPanel({
      script: async ({ emit }) => {
        emit('见 [第三章](lightink://chapter/2) 与 [第 5 页](lightink://page/5)。');
        return { finish: 'stop', totalChars: 5, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '在哪?');
    await flush();
    expect(deps.locate).not.toHaveBeenCalled();
    const buttons = panel.element.querySelectorAll<HTMLButtonElement>('[data-locate]');
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    expect(deps.locate).toHaveBeenCalledWith({ kind: 'chapter', index: 2 });
    buttons[1]!.click();
    expect(deps.locate).toHaveBeenLastCalledWith({ kind: 'page', page: 5 });
    panel.destroy();
  });
});

// ── 输入区：引用选区 / 停止 ─────────────────────────────────────────

describe('createAssistantPanel composer', () => {
  it('quotes the current selection into the draft and sends it as the user message', async () => {
    let selection = '';
    const { panel, requests } = mountPanel({ access: { selection: () => selection } });
    panel.open();
    await flush();
    const quote = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-quote')!;
    expect(quote.disabled).toBe(true);
    expect(quote.title).toBe(t('reader.assistant.noSelection'));
    selection = '选中的一句';
    panel.element.dispatchEvent(new Event('pointerenter'));
    expect(quote.disabled).toBe(false);
    quote.click();
    const input = inputOf(panel);
    expect(input.value).toContain('<selection>\n选中的一句\n</selection>');
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-context-badge.is-selection')?.hidden,
    ).toBe(false);
    input.value = `${input.value}这句什么意思?`;
    panel.element
      .querySelector('.lightink-reader-assistant-composer')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(bubbleTexts(panel, 'user')[0]).toContain('选中的一句');
    expect(requests()[0]!.turns[0]!.content).toContain('<selection>\n选中的一句\n</selection>');
    // 章节前缀不变。
    expect(requests()[0]!.context).toContain('章节正文');
    expect(input.value).toBe('');
    expect(
      panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-context-badge.is-selection')?.hidden,
    ).toBe(true);
    panel.destroy();
  });

  it('stops generation, keeps the partial answer, and allows a new question', async () => {
    let emitLate: ((text: string) => void) | null = null;
    const { panel, aborts, chatCount } = mountPanel({
      script: ({ emit, round }) => {
        if (round === 0) {
          emit('已经生成的');
          return new Promise(() => {
            emitLate = emit; // 悬挂：只有停止能结束
          });
        }
        emit('第二问的回答');
        return { finish: 'stop', totalChars: 6, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    const stop = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-stop')!;
    const send = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-send')!;
    expect(stop.hidden).toBe(true);
    submitQuestion(panel, '第一问');
    await flush();
    expect(stop.hidden).toBe(false);
    expect(send.hidden).toBe(true);
    stop.click();
    await flush();
    expect(stop.hidden).toBe(true);
    expect(send.hidden).toBe(false);
    expect(aborts()).toHaveLength(1);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['已经生成的']);
    expect(panel.element.querySelector('.lightink-reader-assistant-stopped')?.textContent).toBe(
      t('reader.assistant.stopped'),
    );
    expect(panel.element.querySelector('.lightink-reader-assistant-retry')).toBeNull();
    // 停止后迟到的增量不再增长。
    expect(() => emitLate!('迟到')).not.toThrow();
    await flush();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['已经生成的']);
    submitQuestion(panel, '第二问');
    await flush();
    expect(chatCount()).toBe(2);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['已经生成的', '第二问的回答']);
    panel.destroy();
  });

  it('follows new output only while the user is at the bottom', async () => {
    let emitLater: ((text: string) => void) | null = null;
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      script: ({ emit }) => {
        emit('开头');
        emitLater = emit;
        return new Promise((resolve) => {
          release = () => resolve({ finish: 'stop', totalChars: 2, toolCalls: [] });
        });
      },
    });
    panel.open();
    await flush();
    const messages = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-messages')!;
    const back = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-bottom')!;
    let scrollTop = 0;
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(messages, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(messages, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    submitQuestion(panel, '问');
    await flush();
    expect(scrollTop).toBe(1000); // 未上滑：跟随到底
    scrollTop = 100; // 用户上滑
    messages.dispatchEvent(new Event('scroll'));
    expect(back.hidden).toBe(false);
    emitLater!('更多');
    await flush();
    expect(scrollTop).toBe(100); // 不被拉回
    back.click();
    expect(scrollTop).toBe(1000);
    expect(back.hidden).toBe(true);
    emitLater!('再多');
    await flush();
    expect(scrollTop).toBe(1000); // 回到底部后再次跟随
    release!(null);
    await flush();
    panel.destroy();
  });

  it('keeps the up-scrolled offset when the answer completes and the list is rebuilt', async () => {
    let release: ((value: unknown) => void) | null = null;
    const { panel } = mountPanel({
      script: ({ emit }) => {
        emit('开头');
        return new Promise((resolve) => {
          release = () => resolve({ finish: 'stop', totalChars: 2, toolCalls: [] });
        });
      },
    });
    panel.open();
    await flush();
    const messages = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-messages')!;
    let scrollTop = 0;
    const sets: number[] = [];
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(messages, 'clientHeight', { configurable: true, get: () => 300 });
    Object.defineProperty(messages, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        sets.push(value);
      },
    });
    submitQuestion(panel, '问');
    await flush();
    scrollTop = 100; // 用户上滑
    messages.dispatchEvent(new Event('scroll'));
    sets.length = 0;
    release!(null); // 回答结束：全量重绘
    await flush();
    // 重绘后把原偏移放回去，而不是留在顶部或拉到底部。
    expect(sets).toContain(100);
    expect(sets).not.toContain(1000);
    expect(scrollTop).toBe(100);
    panel.destroy();
  });
});

// ── 快捷动作 ─────────────────────────────────────────────────────────

describe('createAssistantPanel quick actions', () => {
  it('runs chapter actions with the chapter as context and offers save-as-annotation for summaries', async () => {
    const { panel, requests, deps } = mountPanel({ historyKey: '0123456789abcdef' });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.context).toContain('章节正文');
    expect(requests()[0]!.turns[requests()[0]!.turns.length - 1]?.content).toBe(
      t('reader.assistant.prompt.chapterSummary'),
    );
    const bubbles = panel.element.querySelectorAll('.lightink-reader-assistant-message');
    const answer = bubbles[bubbles.length - 1]!;
    const save = answer.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save');
    expect(save).not.toBeNull();
    save!.click();
    // 锚到发起摘要时的章，而不是点击时的位置。
    expect(deps.saveAnnotation).toHaveBeenCalledWith('回答内容', { chapter: 0 });
    expect(save!.disabled).toBe(true);
    expect(save!.textContent).toBe(t('reader.assistant.saved'));
    save!.click();
    expect(deps.saveAnnotation).toHaveBeenCalledTimes(1);

    actionButton(panel, 'vocabulary').click();
    await flush();
    actionButton(panel, 'quiz').click();
    await flush();
    expect(requests()).toHaveLength(3);
    expect(requests()[1]!.turns[requests()[1]!.turns.length - 1]?.content).toBe(t('reader.assistant.prompt.vocabulary'));
    expect(requests()[2]!.turns[requests()[2]!.turns.length - 1]?.content).toBe(t('reader.assistant.prompt.quiz'));
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
    expect(panel.element.querySelector('.lightink-reader-assistant-context-title')?.textContent).toBe(
      t('reader.assistant.context.none'),
    );
    panel.destroy();
  });

  it('opens and runs explain/summarize from a selection quote', async () => {
    const { panel, requests } = mountPanel();
    expect(panel.isVisible()).toBe(false);
    panel.askWithSelection('explain', '一个难句');
    await flush();
    expect(panel.isVisible()).toBe(true);
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.turns[requests()[0]!.turns.length - 1]?.content).toContain(
      '<selection>\n一个难句\n</selection>',
    );
    expect(bubbleTexts(panel, 'user')[0]).toContain('一个难句');
    panel.close();
    panel.askWithSelection('summarize', '一段要总结的话');
    await flush();
    expect(requests()).toHaveLength(2);
    expect(bubbleTexts(panel, 'user')[1]).toContain(t('reader.assistant.prompt.summarize'));
    panel.destroy();
  });
});

// ── 按书多会话历史 ───────────────────────────────────────────────────

describe('createAssistantPanel history sessions (R2)', () => {
  const storedFile = (): string =>
    serializeAssistantHistory({
      activeSessionId: 'b',
      sessions: [
        {
          id: 'a',
          createdAt: 10,
          updatedAt: 11,
          messages: [
            { role: 'user', content: '段A的问题', createdAt: 10 },
            { role: 'assistant', content: '段A的回答', createdAt: 11 },
          ],
        },
        {
          id: 'b',
          createdAt: 20,
          updatedAt: 21,
          messages: [
            { role: 'user', content: '段B的问题', createdAt: 20 },
            { role: 'assistant', content: '段B的回答', createdAt: 21 },
          ],
        },
      ],
    });

  it('restores the last active session on reopen and does not re-read the same book', async () => {
    const { panel, deps } = mountPanel({ historyKey: '0123456789abcdef', historyJson: storedFile() });
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['段B的问题']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['段B的回答']);
    expect(deps.readHistory).toHaveBeenCalledTimes(1);
    panel.close();
    panel.open();
    await flush();
    expect(deps.readHistory).toHaveBeenCalledTimes(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['段B的问题']);
    panel.destroy();
  });

  it('lists sessions by first user message, switches and deletes them independently', async () => {
    const { panel, written } = mountPanel({ historyKey: '0123456789abcdef', historyJson: storedFile() });
    panel.open();
    await flush();
    click(panel, '.lightink-reader-assistant-history');
    let rows = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-session');
    expect(rows).toHaveLength(2);
    expect([...rows].map((row) => row.querySelector('.lightink-reader-assistant-session-open')?.textContent)).toEqual([
      '段B的问题',
      '段A的问题',
    ]);
    expect(rows[0]!.classList.contains('is-active')).toBe(true);
    rows[1]!.querySelector<HTMLButtonElement>('.lightink-reader-assistant-session-open')!.click();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['段A的问题']);
    expect(written().activeSessionId).toBe('a');
    click(panel, '.lightink-reader-assistant-history');
    rows = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-session');
    // 只是切换查看不改 updatedAt：列表顺序不变，活动段仍在第二行。
    expect(rows[1]!.classList.contains('is-active')).toBe(true);
    rows[0]!.querySelector<HTMLButtonElement>('.lightink-reader-assistant-session-delete')!.click(); // 删段 B
    await flush();
    rows = panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-session');
    expect(rows).toHaveLength(1);
    expect(bubbleTexts(panel, 'user')).toEqual(['段A的问题']); // 另一段不受影响
    const file = written();
    expect(file.sessions.map((session) => session.id)).toEqual(['a']);
    expect(file.activeSessionId).toBe('a');
    panel.destroy();
  });

  it('starts a new session that lives alongside the old one', async () => {
    const { panel, written } = mountPanel({ historyKey: '0123456789abcdef' });
    panel.open();
    await flush();
    submitQuestion(panel, '第一段');
    await flush();
    click(panel, '.lightink-reader-assistant-new');
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    submitQuestion(panel, '第二段');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['第二段']);
    const file = written();
    expect(file.sessions).toHaveLength(2);
    const titles = file.sessions.map((session) => session.messages[0]!.content).sort();
    expect(titles).toEqual(['第一段', '第二段']);
    expect(file.sessions.find((session) => session.id === file.activeSessionId)?.messages[0]!.content).toBe('第二段');
    // 重复点新建不产生空段。
    click(panel, '.lightink-reader-assistant-new');
    click(panel, '.lightink-reader-assistant-new');
    click(panel, '.lightink-reader-assistant-history');
    expect(panel.element.querySelectorAll('.lightink-reader-assistant-session')).toHaveLength(3);
    panel.destroy();
  });

  it('migrates a v1 file into a single session', async () => {
    const v1 = JSON.stringify({
      version: 1,
      messages: [
        { role: 'user', content: '上次的问题', createdAt: 10 },
        { role: 'assistant', content: '上次的回答', createdAt: 11 },
      ],
      updatedAt: 12,
    });
    const { panel } = mountPanel({ historyKey: '0123456789abcdef', historyJson: v1 });
    panel.open();
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['上次的问题']);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['上次的回答']);
    panel.destroy();
  });

  it('refuses to persist an oversized session and says so without dropping messages', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 16);
    const { panel, deps } = mountPanel({
      historyKey: '0123456789abcdef',
      script: async ({ emit }) => {
        emit(huge);
        return { finish: 'stop', totalChars: huge.length, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '给我一本书那么长的回答');
    await flush();
    expect(deps.writeHistory).not.toHaveBeenCalled();
    const bar = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-bar')!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toBe(t('reader.assistant.historyWriteFailed'));
    expect(bubbleTexts(panel, 'assistant')[0]?.length).toBeGreaterThan(1000);
    panel.destroy();
  });

  it('blocks questions until a slow history read lands, then keeps every stored session', async () => {
    let releaseRead: ((value: string) => void) | null = null;
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1, toolCalls: [] };
    });
    const written: string[] = [];
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      readHistory: () =>
        new Promise<string>((resolve) => {
          releaseRead = resolve;
        }),
      writeHistory: async (_key, json) => {
        written.push(json);
      },
      historyKey: () => '0123456789abcdef',
      stream,
    });
    panel.open();
    await flush();
    const send = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-send');
    expect(send?.disabled).toBe(true);
    submitQuestion(panel, '读取还没完成时就提问'); // 装载窗口内交互：一律不发
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    expect(written).toEqual([]);
    releaseRead!(storedFile()); // 磁盘历史迟到
    await flush();
    expect(send?.disabled).toBe(false);
    expect(bubbleTexts(panel, 'user')).toEqual(['段B的问题']);
    submitQuestion(panel, '再问');
    await flush();
    expect(bubbleTexts(panel, 'assistant')).toEqual(['段B的回答', '答']);
    const file = parseAssistantHistory(written[written.length - 1]!);
    expect(file.sessions.map((session) => session.id).sort()).toEqual(['a', 'b']);
    expect(file.activeSessionId).toBe('b');
    expect(file.sessions.find((session) => session.id === 'b')?.messages.map((m) => m.content)).toEqual([
      '段B的问题',
      '段B的回答',
      '再问',
      '答',
    ]);
    panel.destroy();
  });

  it('merges an in-memory session into the stored file once the book identity arrives late', async () => {
    let key: string | null = null;
    const written: string[] = [];
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1, toolCalls: [] };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      readHistory: async () => storedFile(),
      writeHistory: async (_key, json) => {
        written.push(json);
      },
      historyKey: () => key,
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '哈希还没算出来时就提问'); // 此时没有书籍身份：纯内存会话
    await flush();
    expect(written).toEqual([]);
    key = '0123456789abcdef'; // 身份到位
    submitQuestion(panel, '再问');
    await flush(6);
    const file = parseAssistantHistory(written[written.length - 1]!);
    // 磁盘上的两段还在，内存里开始的那段成为活动段，而不是把整本书的历史覆盖掉。
    expect(file.sessions.map((session) => session.messages[0]!.content).sort()).toEqual([
      '哈希还没算出来时就提问',
      '段A的问题',
      '段B的问题',
    ]);
    expect(file.sessions.find((session) => session.id === file.activeSessionId)?.messages.map((m) => m.content)).toEqual([
      '哈希还没算出来时就提问',
      '答',
      '再问',
      '答',
    ]);
    panel.destroy();
  });

  it('writes a memory-only conversation once the host reports the book identity', async () => {
    let key: string | null = null;
    const written: string[] = [];
    const stream = fakeStream(async ({ emit }) => {
      emit('答');
      return { finish: 'stop', totalChars: 1, toolCalls: [] };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      readHistory: async () => storedFile(),
      writeHistory: async (_key, json) => {
        written.push(json);
      },
      historyKey: () => key,
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '身份还没算出来');
    await flush();
    expect(written).toEqual([]);
    key = '0123456789abcdef';
    panel.syncIdentity(); // 宿主：标注哈希就绪
    await flush(6);
    const file = parseAssistantHistory(written[written.length - 1]!);
    expect(file.sessions.map((session) => session.messages[0]!.content).sort()).toEqual(['段A的问题', '段B的问题', '身份还没算出来']);
    panel.destroy();
  });

  it('persists the in-flight exchange as stopped when the panel is destroyed mid-stream', async () => {
    const { panel, written, aborts } = mountPanel({
      historyKey: '0123456789abcdef',
      script: ({ emit }) => {
        emit('写到一半');
        return new Promise(() => undefined); // 永不结束
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问');
    await flush();
    panel.destroy();
    await flush();
    expect(aborts()).toHaveLength(1);
    const session = written().sessions[0]!;
    expect(session.messages.map((m) => m.content)).toEqual(['问', '写到一半']);
    expect(session.messages[1]?.stopped).toBe(true);
  });

  it('drops the oldest sessions when the whole history file would exceed the byte limit', async () => {
    const bigAnswer = 'y'.repeat(1_100_000);
    const stored = serializeAssistantHistory({
      activeSessionId: 'old-b',
      sessions: [
        {
          id: 'old-a',
          createdAt: 2,
          updatedAt: 2,
          messages: [
            { role: 'user', content: '旧段A', createdAt: 2 },
            { role: 'assistant', content: 'a'.repeat(200), createdAt: 2 },
          ],
        },
        {
          id: 'old-b',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { role: 'user', content: '旧段B', createdAt: 1 },
            { role: 'assistant', content: 'b'.repeat(1_100_000), createdAt: 1 },
          ],
        },
      ],
    });
    const { panel, deps, written } = mountPanel({
      historyKey: '0123456789abcdef',
      historyJson: stored,
      script: async ({ emit }) => {
        emit(bigAnswer);
        return { finish: 'stop', totalChars: bigAnswer.length, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    click(panel, '.lightink-reader-assistant-new');
    submitQuestion(panel, '新段');
    await flush();
    expect(deps.writeHistory).toHaveBeenCalled();
    const file = written();
    // 新段 + 旧段A 装得下；旧段B（最旧的超大段）被丢，活动段保留。
    expect(file.sessions.map((session) => session.messages[0]!.content).sort()).toEqual(['新段', '旧段A']);
    expect(file.sessions.find((session) => session.id === file.activeSessionId)?.messages[0]!.content).toBe('新段');
    expect(panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-bar')?.hidden).toBe(true);
    panel.destroy();
  });

  it('surfaces a rejected write from the host', async () => {
    const { panel } = mountPanel({
      historyKey: '0123456789abcdef',
      writeHistory: async () => {
        throw new Error('对话历史超过上限');
      },
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问');
    await flush();
    const bar = panel.element.querySelector<HTMLElement>('.lightink-reader-assistant-bar')!;
    expect(bar.hidden).toBe(false);
    expect(bubbleTexts(panel, 'assistant')).toEqual(['回答内容']);
    panel.destroy();
  });

  it('drops the previous book conversation when identity changes after interaction', async () => {
    let key = '0123456789abcdef';
    let reply = '书A的回答';
    const written: Array<{ key: string; json: string }> = [];
    const stream = fakeStream(async ({ emit }) => {
      emit(reply);
      return { finish: 'stop', totalChars: reply.length, toolCalls: [] };
    });
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => null,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
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
    reply = '书B的回答';
    submitQuestion(panel, '书B的问题');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual(['书B的问题']);
    const bookBWrites = written.filter((entry) => entry.key === 'fedcba9876543210');
    expect(bookBWrites.length).toBeGreaterThan(0);
    for (const entry of bookBWrites) {
      expect(entry.json).not.toContain('书A');
    }
    panel.destroy();
  });

  it('clears every session of this book via the history drawer', async () => {
    const { panel, deps } = mountPanel({ historyKey: '0123456789abcdef', historyJson: storedFile() });
    panel.open();
    await flush();
    click(panel, '.lightink-reader-assistant-history');
    click(panel, '.lightink-reader-assistant-clear');
    await flush();
    expect(bubbleTexts(panel, 'user')).toEqual([]);
    expect(deps.clearHistory).toHaveBeenCalledWith('0123456789abcdef');
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

// ── 生命周期 ─────────────────────────────────────────────────────────

describe('createAssistantPanel lifecycle hygiene', () => {
  it('treats a content-filtered finish as an error with retry, and cancels pending saves on stop', async () => {
    const cancelPendingSaves = vi.fn();
    const { panel, written } = mountPanel({
      historyKey: '0123456789abcdef',
      access: { cancelPendingSaves },
      script: async ({ emit }) => {
        emit('半截');
        return { finish: 'content_filter', totalChars: 2, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    const answer = [...panel.element.querySelectorAll('.lightink-reader-assistant-message[data-role="assistant"]')].pop()!;
    expect(answer.querySelector('.lightink-reader-assistant-error')?.textContent).toBe(t('reader.ai.error.filtered'));
    expect(answer.querySelector('.lightink-reader-assistant-retry')).not.toBeNull();
    expect(answer.querySelector('.lightink-reader-assistant-save')).toBeNull();
    const persisted = written().sessions[0]!.messages;
    expect(persisted[persisted.length - 1]).toMatchObject({ content: '半截', error: t('reader.ai.error.filtered') });
    panel.destroy();
    // 停止也要收掉还开着的保存确认。
    let release: ((value: unknown) => void) | null = null;
    const streaming = mountPanel({
      access: { cancelPendingSaves },
      script: () => new Promise((resolve) => { release = () => resolve({ finish: 'stop', totalChars: 0, toolCalls: [] }); }),
    });
    streaming.panel.open();
    await flush();
    submitQuestion(streaming.panel, '问');
    await flush();
    cancelPendingSaves.mockClear();
    click(streaming.panel, '.lightink-reader-assistant-stop');
    expect(cancelPendingSaves).toHaveBeenCalledTimes(1);
    release!(null);
    await flush();
    streaming.panel.destroy();
  });

  it('rolls back a failed summary save in the session that started it, even after switching', async () => {
    let settle: ((ok: boolean) => void) | null = null;
    const { panel, written, deps } = mountPanel({ historyKey: '0123456789abcdef' });
    deps.saveAnnotation.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!.click();
    await flush();
    const originId = written().activeSessionId;
    click(panel, '.lightink-reader-assistant-new'); // 落盘结果还没回来就切走了
    await flush();
    settle!(false);
    await flush();
    const origin = written().sessions.find((item) => item.id === originId)!;
    expect(origin.messages.some((m) => m.savedAnnotation === true)).toBe(false);
    panel.destroy();
  });

  it('warns and reloads the stored history when clearing fails on disk', async () => {
    const stored = serializeAssistantHistory({
      activeSessionId: 'b',
      sessions: [
        {
          id: 'b',
          createdAt: 20,
          updatedAt: 21,
          messages: [
            { role: 'user', content: '段B的问题', createdAt: 20 },
            { role: 'assistant', content: '段B的回答', createdAt: 21 },
          ],
        },
      ],
    });
    const { panel, deps } = mountPanel({ historyKey: '0123456789abcdef', historyJson: stored });
    deps.clearHistory.mockRejectedValue(new Error('EACCES'));
    panel.open();
    await flush();
    click(panel, '.lightink-reader-assistant-history');
    click(panel, '.lightink-reader-assistant-clear');
    await flush(6);
    expect(panel.element.querySelector('.lightink-reader-assistant-bar')?.textContent).toBe(t('reader.assistant.historyClearFailed'));
    expect(bubbleTexts(panel, 'user')).toEqual(['段B的问题']); // 磁盘上的读回来了
    panel.destroy();
  });

  it('treats a stream that ended without a terminal event as cut off, and tells the model when context is clipped', async () => {
    const { panel, requests } = mountPanel({
      historyKey: '0123456789abcdef',
      chapter: { title: '长章', text: '字'.repeat(READER_LIMITS.maxAssistantContextChars + 50) },
      script: async ({ emit }) => {
        emit('说了一半');
        return { finish: 'closed', totalChars: 4, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    // 上下文被截断：模型必须被告知，而不只是 UI 上一个角标。
    expect(requests()[0]!.context).toContain(ASSISTANT_CONTEXT_TRUNCATED_NOTE);
    const answer = [...panel.element.querySelectorAll('.lightink-reader-assistant-message[data-role="assistant"]')].pop()!;
    expect(answer.querySelector('.lightink-reader-assistant-stopped')?.textContent).toBe(t('reader.assistant.replyTruncated'));
    expect(answer.querySelector('.lightink-reader-assistant-save')).toBeNull();
    panel.destroy();
  });

  it('marks a length-limited reply as cut off instead of complete', async () => {
    const { panel, written } = mountPanel({
      historyKey: '0123456789abcdef',
      script: async ({ emit }) => {
        emit('写到一半就');
        return { finish: 'length', totalChars: 5, toolCalls: [] };
      },
    });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    const answer = [...panel.element.querySelectorAll('.lightink-reader-assistant-message[data-role="assistant"]')].pop()!;
    expect(answer.querySelector('.lightink-reader-assistant-stopped')?.textContent).toBe(t('reader.assistant.replyTruncated'));
    // 被截断的摘要不是完整回答：不给「保存为标注」。
    expect(answer.querySelector('.lightink-reader-assistant-save')).toBeNull();
    const persisted = written().sessions[0]!.messages;
    expect(persisted[persisted.length - 1]).toMatchObject({ content: '写到一半就', truncated: true });
    panel.destroy();
  });

  it('keeps the saved state of a summary across session switches', async () => {
    const { panel, written } = mountPanel({ historyKey: '0123456789abcdef' });
    panel.open();
    await flush();
    actionButton(panel, 'chapterSummary').click();
    await flush();
    panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!.click();
    await flush();
    expect(written().sessions[0]!.messages.some((m) => m.savedAnnotation === true)).toBe(true);
    // 新开一段再切回来：按钮仍是「已保存」，不会再追加一条重复标注。
    click(panel, '.lightink-reader-assistant-new');
    await flush();
    expect(panel.element.querySelector('.lightink-reader-assistant-save')).toBeNull();
    click(panel, '.lightink-reader-assistant-history');
    const rows = [...panel.element.querySelectorAll<HTMLElement>('.lightink-reader-assistant-session')];
    const old = rows.find((row) => row.textContent?.includes(t('reader.assistant.prompt.chapterSummary').slice(0, 6)));
    old!.querySelector<HTMLButtonElement>('.lightink-reader-assistant-session-open')!.click();
    await flush();
    const save = panel.element.querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe(t('reader.assistant.saved'));
    panel.destroy();
  });

  it('cancels pending save confirmations when closed or destroyed', async () => {
    const cancelPendingSaves = vi.fn();
    const { panel } = mountPanel({ access: { cancelPendingSaves } });
    panel.open();
    await flush();
    panel.close();
    expect(cancelPendingSaves).toHaveBeenCalledTimes(1);
    panel.destroy();
    expect(cancelPendingSaves).toHaveBeenCalledTimes(2);
  });

  it('reports hidden immediately on close and refreshes the context strip on demand', async () => {
    let chapter: { title: string; text: string } | null = null;
    const stream = fakeStream(async () => ({ finish: 'stop', totalChars: 0, toolCalls: [] }));
    const panel = createAssistantPanel({
      t,
      host: () => host,
      chapterContext: () => chapter,
      openSettings: () => undefined,
      saveAnnotation: () => undefined,
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      stream,
    });
    panel.open();
    await flush();
    expect(panel.isVisible()).toBe(true);
    const title = panel.element.querySelector('.lightink-reader-assistant-context-title')!;
    expect(title.textContent).toBe(t('reader.assistant.context.none'));
    expect(actionButton(panel, 'chapterSummary').disabled).toBe(true);
    // 宿主告知上下文迟到就绪：动作按钮与提示条一起刷新，而不是只刷按钮。
    chapter = { title: '迟到的章', text: '正文' };
    panel.refreshContext();
    expect(title.textContent).toBe('迟到的章');
    expect(actionButton(panel, 'chapterSummary').disabled).toBe(false);
    panel.close();
    expect(panel.isVisible()).toBe(false);
    panel.destroy();
  });

  it('starts hidden, mounts on open, and removes itself on destroy', async () => {
    const { panel } = mountPanel({ chapter: null });
    expect(panel.isVisible()).toBe(false);
    panel.open();
    await flush();
    expect(panel.isVisible()).toBe(true);
    expect(panel.element.parentNode).toBe(document.body);
    expect(inputOf(panel).rows).toBeGreaterThanOrEqual(3);
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
      access: fakeAccess(),
      fetchConfig: async () => ({ configured: true, missing: [] }),
      streamRenderIntervalMs: 0,
      stream,
    });
    panel.open();
    await flush();
    submitQuestion(panel, '问题');
    await flush();
    expect(lateEmit).not.toBeNull();
    panel.destroy();
    expect(() => lateEmit!('迟到的增量')).not.toThrow();
    await flush();
    expect(panel.element.textContent).not.toContain('迟到的增量');
    expect(() =>
      document.dispatchEvent(
        new CustomEvent('lightink:reader-ai-configured', { detail: { configured: false } }),
      ),
    ).not.toThrow();
  });

});
