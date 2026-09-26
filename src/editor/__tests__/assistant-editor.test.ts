// @vitest-environment jsdom

/**
 * Contract for `src/editor/assistant-editor.ts` (ADR-3 / R3):
 *
 * - 编辑器助手只读当前文档：全文进入上下文，工具列表为空，任何工具调用只回
 *   `read_only` 错误，不产生内容变更。
 * - 会话按文档身份键（16-hex）持久化；文档身份变化即销毁面板（含中止流式），
 *   下次打开按新键加载，不把上一文档的输出写进新文档历史。
 * - 无活动文档时入口空操作；未配置 provider 时显示配置引导。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEditorAssistant,
  type EditorAssistantDocument,
  type EditorAssistantDeps,
} from '../assistant-editor.js';
import { translate, type MessageKey } from '../../i18n/messages.js';
import type { AiStreamDoneView, AssistantStreamDeps } from '../../assistant/assistant-panel.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const flushUntil = async (predicate: () => boolean, tries = 80): Promise<void> => {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return;
    await flush();
  }
};

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-touch-primary');
});

interface StreamScript {
  readonly messages: readonly { role: string; content: string }[];
  readonly tools: readonly { name: string }[];
  readonly round: number;
  readonly emit: (text: string) => void;
}

interface StreamHarness {
  readonly deps: AssistantStreamDeps;
  readonly calls: ReadonlyArray<Record<string, unknown>>;
}

function scriptedStream(
  script: (context: StreamScript) => AiStreamDoneView | Promise<AiStreamDoneView>,
): StreamHarness {
  const calls: Record<string, unknown>[] = [];
  let round = 0;
  const deps: AssistantStreamDeps = {
    invoke: async (_command, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      calls.push(payload);
      const channel = payload.onEvent as { onmessage: (event: unknown) => void };
      round += 1;
      return await script({
        messages: (payload.messages as { role: string; content: string }[]) ?? [],
        tools: (payload.tools as { name: string }[]) ?? [],
        round,
        emit: (text) => channel.onmessage({ type: 'delta', text }),
      });
    },
    createChannel: () => ({ onmessage: () => undefined }),
  };
  return { deps, calls };
}

function documentOf(key: string, title: string, text: string): EditorAssistantDocument {
  return { key, title, text };
}

const DOC_A = documentOf('0123456789abcdef', 'notes.md', '# 标题\n\n正文内容');
const DOC_B = documentOf('fedcba9876543210', 'other.md', '# 另一篇');

interface MountOptions {
  readonly configured?: boolean;
  readonly document?: EditorAssistantDocument | null;
  readonly script?: (context: StreamScript) => AiStreamDoneView | Promise<AiStreamDoneView>;
}

function mountEditor(options: MountOptions = {}) {
  const host = document.createElement('div');
  host.id = 'lightink-editor-area';
  document.body.appendChild(host);
  const stream = scriptedStream(
    options.script ??
      (({ emit }) => {
        emit('回答');
        return { finish: 'stop', totalChars: 3, toolCalls: [] };
      }),
  );
  let current: EditorAssistantDocument | null =
    options.document === undefined ? DOC_A : options.document;
  const readKeys: string[] = [];
  const writeHistory = vi.fn(async () => undefined);
  const notify = vi.fn();
  const deps: EditorAssistantDeps = {
    t,
    host: () => host,
    openSettings: vi.fn(),
    getDocument: () => current,
    getLocale: () => 'zh-CN',
    notify,
    fetchConfig: async () => ({ configured: options.configured ?? true, missing: [] }),
    readHistory: async (key) => {
      readKeys.push(key);
      return '';
    },
    writeHistory,
    clearHistory: vi.fn(async () => undefined),
    stream: stream.deps,
  };
  const assistant = createEditorAssistant(deps);
  return {
    assistant,
    stream,
    readKeys,
    writeHistory,
    notify,
    setDocument: (next: EditorAssistantDocument | null) => {
      current = next;
    },
  };
}

function panelElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-reader-assistant-panel');
}

function submitQuestion(panel: HTMLElement, question: string): void {
  const input = panel.querySelector<HTMLTextAreaElement>('.lightink-reader-assistant-input');
  expect(input).not.toBeNull();
  input!.value = question;
  panel
    .querySelector('.lightink-reader-assistant-composer')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('createEditorAssistant read-only document context', () => {
  it('injects the current document and advertises no tools', async () => {
    const { assistant, stream, readKeys, writeHistory } = mountEditor();
    assistant.open();
    await flush();
    expect(assistant.isVisible()).toBe(true);
    expect(readKeys).toEqual([DOC_A.key]);
    submitQuestion(panelElement()!, '这篇讲了什么?');
    await flushUntil(() => stream.calls.length >= 1);
    const payload = stream.calls[0]!;
    const messages = payload.messages as { role: string; content: string }[];
    const systemText = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(systemText).toContain('notes.md');
    expect(systemText).toContain('正文内容');
    // 只读：请求广告空工具清单，且使用编辑器专用系统提示；执行器对任何工具
    // 调用只回 read_only（下一个用例验证）。
    expect(payload.tools).toEqual([]);
    expect(systemText).toContain('编辑器中的 AI 助手');
    expect(panelElement()?.querySelector('.lightink-reader-assistant-modes')).toBeNull();
    expect(panelElement()?.textContent?.toLowerCase()).not.toContain('bypass');
    expect(writeHistory).toHaveBeenCalledTimes(1);
    expect(readKeys[0]).toBe(DOC_A.key);
    assistant.destroy();
  });

  it('answers a tool call with read_only and never mutates the document', async () => {
    const { assistant, stream } = mountEditor({
      script: ({ round, emit }) => {
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: 'save_to_book',
                arguments: JSON.stringify({ kind: 'note', note: 'x' }),
              },
            ],
          };
        }
        emit('这篇只读，我无法修改。');
        return { finish: 'stop', totalChars: 10, toolCalls: [] };
      },
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '帮我把标题改成别的');
    await flushUntil(() => stream.calls.length >= 2);
    const second = JSON.stringify(stream.calls[1]?.messages ?? []);
    expect(second).toContain('read_only');
    assistant.destroy();
  });

  it('does not save a chapter summary and tells the host it is read-only', async () => {
    const { assistant, notify } = mountEditor();
    assistant.open();
    await flush();
    const action = panelElement()!.querySelector<HTMLButtonElement>(
      '[data-assistant-action="chapterSummary"]',
    );
    expect(action).not.toBeNull();
    action!.click();
    await flushUntil(
      () => panelElement()!.querySelector('.lightink-reader-assistant-save') !== null,
    );
    panelElement()!
      .querySelector<HTMLButtonElement>('.lightink-reader-assistant-save')!
      .click();
    expect(notify).toHaveBeenCalledTimes(1);
    assistant.destroy();
  });

  it('keeps the provider guide when unconfigured and sends nothing', async () => {
    const { assistant, stream } = mountEditor({ configured: false });
    assistant.open();
    await flush();
    expect(panelElement()?.querySelector<HTMLElement>('.lightink-reader-assistant-guide')?.hidden).toBe(
      false,
    );
    submitQuestion(panelElement()!, '你好');
    await flush();
    expect(stream.calls).toHaveLength(0);
    assistant.destroy();
  });

  it('is a no-op without an active document', async () => {
    const { assistant, stream } = mountEditor({ document: null });
    assistant.open();
    await flush();
    expect(assistant.isVisible()).toBe(false);
    expect(panelElement()).toBeNull();
    expect(stream.calls).toHaveLength(0);
    assistant.destroy();
  });
});

describe('createEditorAssistant document switching', () => {
  it('destroys the session on identity change and reloads the new document key', async () => {
    const { assistant, readKeys, setDocument } = mountEditor();
    assistant.open();
    await flush();
    setDocument(DOC_B);
    assistant.syncDocument();
    await flush();
    expect(assistant.isVisible()).toBe(false);
    expect(panelElement()?.isConnected ?? false).toBe(false);
    assistant.open();
    await flush();
    expect(assistant.isVisible()).toBe(true);
    expect(readKeys).toEqual([DOC_A.key, DOC_B.key]);
    assistant.destroy();
  });

  it('aborts an in-flight stream on identity change instead of persisting to the new key', async () => {
    const pending: { release: ((value: AiStreamDoneView) => void) | null } = { release: null };
    const { assistant, writeHistory, setDocument } = mountEditor({
      script: () =>
        new Promise<AiStreamDoneView>((resolve) => {
          pending.release = resolve;
        }),
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '这篇讲了什么?');
    await flush();
    // 流式生成中切换文档。
    setDocument(DOC_B);
    assistant.syncDocument();
    expect(assistant.isVisible()).toBe(false);
    pending.release?.({ finish: 'stop', totalChars: 0, toolCalls: [] });
    await flush();
    expect(writeHistory).not.toHaveBeenCalled();
    assistant.destroy();
  });
});
