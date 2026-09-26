// @vitest-environment jsdom

/**
 * Contract for `src/library/assistant-shelf.ts` (ADR-3 / R3 / R4):
 *
 * - 首页助手用固定命名空间键（16-hex）持久化：与按书/按文档会话隔离，重启恢复。
 * - 面板工具循环消费库作用域 session：模型调用 `library_search` 读出书库；
 *   显式指令直接落盘并通知 surface 刷新；AI 主动建议进待确认列表，确认才写。
 * - 未配置 provider 时显示配置引导且不发起请求。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createShelfAssistant,
  SHELF_ASSISTANT_HISTORY_KEY,
  type ShelfAssistantDeps,
} from '../assistant-shelf.js';
import {
  LIBRARY_ORGANIZE_TOOL_NAME,
  LIBRARY_SEARCH_TOOL_NAME,
  LIBRARY_TOOL_DEFINITIONS,
  type LibraryToolChange,
  type LibraryToolDeps,
} from '../../assistant/library-tools.js';
import type {
  LibraryBookLookup,
  LibraryBookLookupResult,
  LibraryContentFailure,
} from '../../assistant/library-content.js';
import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from '../library-client.js';
import { translate, type MessageKey } from '../../i18n/messages.js';
import {
  ASSISTANT_PERMISSION_MODE_KEY,
  type AssistantPermissionStorage,
} from '../../assistant/assistant-permission.js';
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
  document.documentElement.removeAttribute('data-android');
  localStorage.clear();
});

function book(overrides: Partial<LibraryItem> & { id: string; title: string }): LibraryItem {
  return {
    sourceKind: 'local',
    authors: [],
    updatedAt: 1,
    ...overrides,
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function fakeLocate(
  items: readonly LibraryItem[],
  query: LibraryBookLookup,
): LibraryBookLookupResult | LibraryContentFailure {
  const title = normalize(query.title ?? '');
  const author = normalize(query.author ?? '');
  if (title === '' && author === '') {
    return { ok: false, error: 'invalid_query', message: '需要书名或作者才能查找书籍。' };
  }
  let matches = [...items];
  if (title !== '') {
    const exact = matches.filter((item) => normalize(item.title) === title);
    matches =
      exact.length > 0
        ? exact
        : matches.filter((item) => normalize(item.title).includes(title));
  }
  if (author !== '') {
    matches = matches.filter((item) =>
      item.authors.some((name) => normalize(name).includes(author)),
    );
  }
  return {
    ok: true,
    candidates: matches.map((item) => ({
      itemId: item.id,
      title: item.title,
      authors: [...item.authors],
      format: item.extension ?? '',
    })),
  };
}

interface LibraryFixture {
  readonly state: {
    items: LibraryItem[];
    groups: LibraryGroup[];
    groupMembers: LibraryGroupMembership[];
    tags: LibraryTag[];
    tagMembers: LibraryTagMembership[];
  };
  readonly deps: Partial<LibraryToolDeps>;
  readonly createGroup: ReturnType<typeof vi.fn>;
  readonly setGroupMember: ReturnType<typeof vi.fn>;
}

function libraryFixture(items: readonly LibraryItem[]): LibraryFixture {
  const state = {
    items: [...items],
    groups: [] as LibraryGroup[],
    groupMembers: [] as LibraryGroupMembership[],
    tags: [] as LibraryTag[],
    tagMembers: [] as LibraryTagMembership[],
  };
  let seq = 0;
  const createGroup = vi.fn(async (name: string): Promise<LibraryGroup> => {
    seq += 1;
    const group: LibraryGroup = { id: `g${seq}`, name, kind: 'custom', sortOrder: seq };
    state.groups.push(group);
    return group;
  });
  const setGroupMember = vi.fn(
    async (groupId: string, itemId: string, present: boolean): Promise<void> => {
      state.groupMembers = state.groupMembers.filter(
        (membership) => !(membership.groupId === groupId && membership.itemId === itemId),
      );
      if (present) {
        state.groupMembers.push({ groupId, itemId });
      }
    },
  );
  const deps: Partial<LibraryToolDeps> = {
    listItems: async () => state.items,
    listGroups: async () => state.groups,
    listGroupMemberships: async () => state.groupMembers,
    listTags: async () => state.tags,
    listTagMemberships: async () => state.tagMembers,
    createGroup,
    setGroupMember,
    createTag: async (name) => {
      seq += 1;
      const tag: LibraryTag = { id: `t${seq}`, name, createdAt: 1, updatedAt: 1 };
      state.tags.push(tag);
      return tag;
    },
    setItemTags: async () => undefined,
    removeItem: async () => undefined,
    deleteGroup: async () => undefined,
    locate: async (query) => fakeLocate(state.items, query),
  };
  return { state, deps, createGroup, setGroupMember };
}

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

interface MountOptions {
  readonly configured?: boolean;
  readonly library?: Partial<LibraryToolDeps>;
  readonly script?: (context: StreamScript) => AiStreamDoneView | Promise<AiStreamDoneView>;
  readonly readingStatusOf?: ShelfAssistantDeps['readingStatusOf'];
  readonly onLibraryChanged?: (change: LibraryToolChange) => void;
  readonly permissionStorage?: AssistantPermissionStorage | null;
}

function mountShelf(options: MountOptions = {}) {
  const host = document.createElement('section');
  host.className = 'lightink-library';
  document.body.appendChild(host);
  const stream = scriptedStream(
    options.script ??
      (({ emit }) => {
        emit('回答');
        return { finish: 'stop', totalChars: 3, toolCalls: [] };
      }),
  );
  const readKeys: string[] = [];
  const assistant = createShelfAssistant({
    t,
    host: () => host,
    openSettings: vi.fn(),
    fetchConfig: async () => ({ configured: options.configured ?? true, missing: [] }),
    readHistory: async (key) => {
      readKeys.push(key);
      return '';
    },
    writeHistory: vi.fn(async () => undefined),
    clearHistory: vi.fn(async () => undefined),
    library: options.library,
    readingStatusOf: options.readingStatusOf,
    onLibraryChanged: options.onLibraryChanged,
    permissionStorage: options.permissionStorage,
    stream: stream.deps,
  });
  return { assistant, stream, readKeys };
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

describe('createShelfAssistant session identity', () => {
  it('uses a fixed 16-hex namespace key and reuses it across opens', async () => {
    expect(SHELF_ASSISTANT_HISTORY_KEY).toMatch(/^[0-9a-f]{16}$/);
    const { assistant, readKeys } = mountShelf();
    assistant.open();
    await flush();
    expect(assistant.isVisible()).toBe(true);
    expect(readKeys).toContain(SHELF_ASSISTANT_HISTORY_KEY);
    assistant.close();
    assistant.open();
    await flush();
    expect(new Set(readKeys)).toEqual(new Set([SHELF_ASSISTANT_HISTORY_KEY]));
    assistant.destroy();
    expect(panelElement()?.isConnected ?? false).toBe(false);
  });

  it('shows the provider guide and sends nothing when unconfigured', async () => {
    const { assistant, stream } = mountShelf({ configured: false });
    assistant.open();
    await flush();
    const panel = panelElement();
    expect(panel).not.toBeNull();
    expect(panel!.querySelector<HTMLElement>('.lightink-reader-assistant-guide')?.hidden).toBe(
      false,
    );
    expect(panel!.querySelector<HTMLElement>('.lightink-reader-assistant-main')?.hidden).toBe(
      true,
    );
    submitQuestion(panel!, '有哪些书?');
    await flush();
    expect(stream.calls).toHaveLength(0);
    assistant.destroy();
  });
});

describe('createShelfAssistant library tools', () => {
  it('executes library_search through the shelf session and feeds the result back', async () => {
    const fixture = libraryFixture([book({ id: 'local:/a.epub', title: '三体' })]);
    const { assistant, stream } = mountShelf({
      library: fixture.deps,
      script: ({ round, emit }) => {
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: LIBRARY_SEARCH_TOOL_NAME,
                arguments: JSON.stringify({ action: 'books', title: '三体' }),
              },
            ],
          };
        }
        emit('书库里有《三体》。');
        return { finish: 'stop', totalChars: 9, toolCalls: [] };
      },
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '书库里有三体吗?');
    await flushUntil(() => stream.calls.length >= 2);
    expect(stream.calls).toHaveLength(2);
    // 模型侧可达：首轮请求携带全部 library_* schema 与书库系统提示（R4 首页链路）。
    const firstTools = (stream.calls[0]?.tools ?? []) as { name: string }[];
    expect(firstTools.map((tool) => tool.name)).toEqual(
      LIBRARY_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    const firstSystem = ((stream.calls[0]?.messages ?? []) as {
      role: string;
      content: string;
    }[])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(firstSystem).toContain(LIBRARY_SEARCH_TOOL_NAME);
    expect(firstSystem).not.toContain('save_to_book');
    // 第二轮请求必须携带第一轮工具结果。
    const second = JSON.stringify(stream.calls[1]?.messages ?? []);
    expect(second).toContain(LIBRARY_SEARCH_TOOL_NAME);
    expect(second).toContain('三体');
    expect(
      panelElement()!.querySelectorAll(
        '.lightink-reader-assistant-message[data-role="assistant"]',
      ).length,
    ).toBe(1);
    assistant.destroy();
  });

  it('writes directly on an explicit instruction and notifies the surface', async () => {
    const fixture = libraryFixture([book({ id: 'local:/a.epub', title: '三体' })]);
    const changed = vi.fn();
    const storage = memoryStorage();
    storage.setItem(ASSISTANT_PERMISSION_MODE_KEY, 'auto');
    const { assistant } = mountShelf({
      library: fixture.deps,
      onLibraryChanged: changed,
      permissionStorage: storage,
      script: ({ round, emit }) => {
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: LIBRARY_ORGANIZE_TOOL_NAME,
                arguments: JSON.stringify({ books: ['三体'], group: '科幻', mode: 'assign' }),
              },
            ],
          };
        }
        emit('已归类。');
        return { finish: 'stop', totalChars: 4, toolCalls: [] };
      },
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '把《三体》归到科幻');
    await flushUntil(() => fixture.createGroup.mock.calls.length > 0);
    expect(fixture.state.groups.map((group) => group.name)).toEqual(['科幻']);
    expect(fixture.setGroupMember).toHaveBeenCalledWith('g1', 'local:/a.epub', true);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'organize', itemIds: ['local:/a.epub'] }),
    );
    assistant.destroy();
  });

  it('keeps an AI suggestion pending until the user confirms it once', async () => {
    const fixture = libraryFixture([book({ id: 'local:/a.epub', title: '三体' })]);
    const changed = vi.fn();
    const { assistant } = mountShelf({
      library: fixture.deps,
      onLibraryChanged: changed,
      script: ({ round, emit }) => {
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: LIBRARY_ORGANIZE_TOOL_NAME,
                arguments: JSON.stringify({ books: ['三体'], group: '科幻', mode: 'assign' }),
              },
            ],
          };
        }
        emit('要我把《三体》归到科幻吗？');
        return { finish: 'stop', totalChars: 12, toolCalls: [] };
      },
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '帮我整理一下书库');
    await flushUntil(
      () => panelElement()?.querySelector('[data-assistant-pending-check]') != null,
    );
    // 建议阶段零落盘。
    expect(fixture.createGroup).not.toHaveBeenCalled();
    expect(fixture.setGroupMember).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    const confirm = panelElement()!.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-pending-confirm',
    );
    expect(confirm).not.toBeNull();
    confirm!.click();
    await flushUntil(() => fixture.setGroupMember.mock.calls.length > 0);
    expect(fixture.setGroupMember).toHaveBeenCalledTimes(1);
    // 重复点击不二次落盘。
    confirm!.click();
    await flush();
    expect(fixture.setGroupMember).toHaveBeenCalledTimes(1);
    assistant.destroy();
  });

  it('injects the shelf placeholder instead of the reader chapter wording', async () => {
    const { assistant } = mountShelf();
    assistant.open();
    await flush();
    const input = panelElement()!.querySelector<HTMLTextAreaElement>(
      '.lightink-reader-assistant-input',
    );
    expect(input?.placeholder).toBe(t('library.assistant.placeholder'));
    expect(input?.placeholder).not.toBe(t('reader.assistant.placeholder'));
    assistant.destroy();
  });

  it('shows shelf actions and a review/auto/yolo switch, not reader chapter actions', async () => {
    const { assistant } = mountShelf();
    assistant.open();
    await flush();
    const labels = [
      ...panelElement()!.querySelectorAll<HTMLButtonElement>('[data-assistant-action]'),
    ].map((button) => button.textContent);
    expect(labels).toEqual(['整理建议', '打标建议', '查找']);
    expect(panelElement()!.textContent).not.toContain('本章摘要');
    expect(panelElement()!.textContent).not.toContain('生词卡');
    expect(panelElement()!.textContent).not.toContain('章节测验');
    expect(
      panelElement()!.querySelector<HTMLButtonElement>('[data-assistant-quote]')?.hidden,
    ).toBe(true);
    const modes = [
      ...panelElement()!.querySelectorAll<HTMLButtonElement>('[data-assistant-mode]'),
    ].map((button) => button.dataset.assistantMode);
    expect(modes).toEqual(['review', 'auto', 'yolo']);
    expect(panelElement()!.textContent?.toLowerCase()).not.toContain('bypass');
    expect(
      panelElement()!.querySelector<HTMLButtonElement>('[data-assistant-mode="review"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
    // 权限选择已迁入 composer 工具栏触发器：头部只剩历史/标题/关闭。
    const head = panelElement()!.querySelector('.lightink-reader-assistant-head');
    expect(head?.querySelector('[data-assistant-mode]')).toBeNull();
    expect(head?.querySelector('.lightink-reader-assistant-modes')).toBeNull();
    const trigger = panelElement()!.querySelector<HTMLButtonElement>(
      '.lightink-reader-assistant-mode-trigger',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('审阅');
    expect(
      panelElement()!.querySelector('.lightink-reader-assistant-composer-bar')?.contains(trigger!),
    ).toBe(true);
    assistant.destroy();
  });

  it('keeps an organize suggestion on the card in review and writes it in yolo', async () => {
    const fixture = libraryFixture([book({ id: 'local:/a.epub', title: '三体' })]);
    const organizeCall = {
      id: 'c1',
      name: LIBRARY_ORGANIZE_TOOL_NAME,
      arguments: JSON.stringify({ books: ['三体'], group: '科幻', mode: 'assign' }),
    };
    const script = ({ round, emit }: StreamScript): AiStreamDoneView => {
      if (round === 1) {
        return { finish: 'tool_calls', totalChars: 0, toolCalls: [organizeCall] };
      }
      emit('好的。');
      return { finish: 'stop', totalChars: 3, toolCalls: [] };
    };
    const review = mountShelf({ library: fixture.deps, script });
    review.assistant.open();
    await flush();
    panelElement()!
      .querySelector<HTMLButtonElement>('[data-assistant-action="organizeSuggestion"]')!
      .click();
    await flushUntil(
      () => panelElement()?.querySelector('[data-assistant-pending-check]') != null,
    );
    expect(fixture.createGroup).not.toHaveBeenCalled();
    review.assistant.destroy();

    fixture.createGroup.mockClear();
    const storage = memoryStorage();
    storage.setItem(ASSISTANT_PERMISSION_MODE_KEY, 'yolo');
    const yolo = mountShelf({
      library: fixture.deps,
      permissionStorage: storage,
      script,
    });
    yolo.assistant.open();
    await flush();
    panelElement()!
      .querySelector<HTMLButtonElement>('[data-assistant-action="organizeSuggestion"]')!
      .click();
    await flushUntil(() => fixture.createGroup.mock.calls.length > 0);
    expect(panelElement()?.querySelector('.lightink-reader-assistant-pending-list')?.childElementCount ?? 0).toBe(
      0,
    );
    yolo.assistant.destroy();
  });

  it('renders the pending card inline inside the message flow', async () => {
    const fixture = libraryFixture([book({ id: 'local:/a.epub', title: '三体' })]);
    const { assistant } = mountShelf({
      library: fixture.deps,
      script: ({ round, emit }) => {
        if (round === 1) {
          return {
            finish: 'tool_calls',
            totalChars: 0,
            toolCalls: [
              {
                id: 'c1',
                name: LIBRARY_ORGANIZE_TOOL_NAME,
                arguments: JSON.stringify({ books: ['三体'], group: '科幻', mode: 'assign' }),
              },
            ],
          };
        }
        emit('建议在卡片里确认。');
        return { finish: 'stop', totalChars: 8, toolCalls: [] };
      },
    });
    assistant.open();
    await flush();
    submitQuestion(panelElement()!, '帮我整理一下书库');
    await flushUntil(
      () => panelElement()?.querySelector('[data-assistant-pending-check]') != null,
    );
    const messagesHost = panelElement()!.querySelector('.lightink-reader-assistant-messages');
    const card = panelElement()!.querySelector('.lightink-reader-assistant-pending');
    expect(card?.parentElement).toBe(messagesHost);
    expect(messagesHost?.lastElementChild).toBe(card);
    assistant.destroy();
  });

  it('forbids prose confirmation in the shelf system prompt', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const prompt = translate(locale, 'library.assistant.systemPrompt');
      expect(prompt).toContain(locale === 'zh-CN' ? '确认卡片' : 'confirmation card');
      expect(prompt).toContain('✅');
      expect(prompt).toContain('❌');
      expect(prompt).toContain(locale === 'zh-CN' ? '最终确认' : 'final confirmation');
      expect(prompt).toContain(locale === 'zh-CN' ? '只通过工具提交' : 'only through tools');
    }
  });
});

function memoryStorage(): AssistantPermissionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
