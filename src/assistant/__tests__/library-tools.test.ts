// @vitest-environment jsdom

/**
 * Contract for `src/assistant/library-tools.ts` (ADR-4 / ADR-8 / R4):
 *
 * - 五类工具定义与执行同源；session 可被面板当 `AssistantToolSession` 消费。
 * - 查询：按书名/作者/分组/标签/格式/阅读状态过滤，只读不写。
 * - 显式指令（祈使 + 目标被点名）直写；主动建议进 `pending_confirmation`，
 *   确认前书库零变化，确认只走面板专用 `confirmPending(id)` 且只写一次；
 *   `execute` 携带 `pending_ref` 一律拒绝，模型无法自执行确认。
 * - 删除书籍、删除分组、清空标签一律确认。
 * - 同名多本/同名分组返回候选不猜测；智能组只读。
 * - 批量写失败：归类/打标逐项补偿回滚，删除不可逆时列出已应用项并通知刷新。
 */

import { describe, expect, it, vi } from 'vitest';

import type { AssistantToolSession } from '../assistant-tools.js';
import type {
  LibraryBookCandidate,
  LibraryBookLookup,
  LibraryBookLookupResult,
  LibraryContentFailure,
} from '../library-content.js';
import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from '../../library/library-client.js';
import {
  LIBRARY_CREATE_GROUP_TOOL_NAME,
  LIBRARY_ORGANIZE_TOOL_NAME,
  LIBRARY_REMOVE_TOOL_NAME,
  LIBRARY_SEARCH_TOOL_NAME,
  LIBRARY_TAG_TOOL_NAME,
  LIBRARY_TOOL_DEFINITIONS,
  createLibraryToolSession,
  defaultLibraryToolDeps,
  isExplicitLibraryWriteInstruction,
  type LibraryReadingStatus,
  type LibraryToolDeps,
} from '../library-tools.js';

function book(
  overrides: Partial<LibraryItem> & { id: string; title: string },
): LibraryItem {
  return {
    sourceKind: 'local',
    authors: [],
    updatedAt: 1,
    ...overrides,
  };
}

function candidate(item: LibraryItem): LibraryBookCandidate {
  return {
    itemId: item.id,
    title: item.title,
    authors: [...item.authors],
    format: item.extension ?? '',
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 与 library-content 同语义的替身定位：精确优先，其次包含。 */
function fakeLocate(
  items: readonly LibraryItem[],
  query: LibraryBookLookup,
): LibraryBookLookupResult | LibraryContentFailure {
  const title = query.title?.trim() ?? '';
  const author = query.author?.trim() ?? '';
  if (title === '' && author === '') {
    return { ok: false, error: 'invalid_query', message: '需要书名或作者才能查找书籍。' };
  }
  let matches: readonly LibraryItem[] = items;
  if (title !== '') {
    const needle = normalize(title);
    const exact = matches.filter((item) => normalize(item.title) === needle);
    matches =
      exact.length > 0
        ? exact
        : matches.filter((item) => normalize(item.title).includes(needle));
  }
  if (author !== '') {
    const needle = normalize(author);
    const authorsOf = (item: LibraryItem): string[] =>
      item.authors.map((name) => normalize(name));
    const exact = matches.filter((item) => authorsOf(item).some((name) => name === needle));
    matches =
      exact.length > 0
        ? exact
        : matches.filter((item) =>
            authorsOf(item).some((name) => name !== '' && name.includes(needle)),
          );
  }
  return { ok: true, candidates: matches.map(candidate) };
}

interface HarnessOptions {
  readonly items?: readonly LibraryItem[];
  readonly groups?: readonly LibraryGroup[];
  readonly groupMembers?: readonly LibraryGroupMembership[];
  readonly tags?: readonly LibraryTag[];
  readonly tagMembers?: readonly LibraryTagMembership[];
  readonly userMessage?: string;
  readonly isExplicitInstruction?: (message: string) => boolean;
  readonly readingStatusOf?: (itemId: string) => LibraryReadingStatus | null;
  /** 指定成员关系读取在会话创建前注入 reject（验证「读取失败不落状态」）。 */
  readonly rejectReads?: readonly ('listGroupMemberships' | 'listTagMemberships')[];
}

interface Harness {
  readonly state: {
    items: LibraryItem[];
    groups: LibraryGroup[];
    groupMembers: LibraryGroupMembership[];
    tags: LibraryTag[];
    tagMembers: LibraryTagMembership[];
    seq: number;
  };
  readonly deps: LibraryToolDeps;
  readonly writes: {
    createGroup: ReturnType<typeof vi.fn>;
    setGroupMember: ReturnType<typeof vi.fn>;
    createTag: ReturnType<typeof vi.fn>;
    setItemTags: ReturnType<typeof vi.fn>;
    deleteTag: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
    deleteGroup: ReturnType<typeof vi.fn>;
  };
  readonly changed: ReturnType<typeof vi.fn>;
  readonly session: ReturnType<typeof createLibraryToolSession>;
}

function harness(options: HarnessOptions = {}): Harness {
  const state = {
    items: [...(options.items ?? [])],
    groups: [...(options.groups ?? [])],
    groupMembers: [...(options.groupMembers ?? [])],
    tags: [...(options.tags ?? [])],
    tagMembers: [...(options.tagMembers ?? [])],
    seq: 1000,
  };
  const writes = {
    createGroup: vi.fn(async (name: string, parentId?: string): Promise<LibraryGroup> => {
      state.seq += 1;
      const group: LibraryGroup = {
        id: `g${state.seq}`,
        name,
        ...(parentId !== undefined ? { parentId } : {}),
        kind: 'custom',
        sortOrder: state.seq,
      };
      state.groups.push(group);
      return group;
    }),
    setGroupMember: vi.fn(
      async (groupId: string, itemId: string, present: boolean): Promise<void> => {
        state.groupMembers = state.groupMembers.filter(
          (membership) => !(membership.groupId === groupId && membership.itemId === itemId),
        );
        if (present) {
          state.groupMembers.push({ groupId, itemId });
        }
      },
    ),
    createTag: vi.fn(async (name: string): Promise<LibraryTag> => {
      const trimmed = name.trim();
      const existing = state.tags.find((tag) => tag.name === trimmed);
      if (existing !== undefined) {
        return existing;
      }
      state.seq += 1;
      const tag: LibraryTag = {
        id: `t${state.seq}`,
        name: trimmed,
        createdAt: 1,
        updatedAt: 1,
      };
      state.tags.push(tag);
      return tag;
    }),
    setItemTags: vi.fn(async (itemId: string, tagIds: readonly string[]): Promise<void> => {
      state.tagMembers = state.tagMembers.filter(
        (membership) => membership.itemId !== itemId,
      );
      for (const tagId of tagIds) {
        state.tagMembers.push({ tagId, itemId });
      }
    }),
    deleteTag: vi.fn(async (tagId: string): Promise<void> => {
      state.tags = state.tags.filter((tag) => tag.id !== tagId);
      state.tagMembers = state.tagMembers.filter(
        (membership) => membership.tagId !== tagId,
      );
    }),
    removeItem: vi.fn(async (itemId: string): Promise<void> => {
      state.items = state.items.filter((item) => item.id !== itemId);
    }),
    deleteGroup: vi.fn(async (groupId: string): Promise<void> => {
      state.groups = state.groups.filter((group) => group.id !== groupId);
      state.groupMembers = state.groupMembers.filter(
        (membership) => membership.groupId !== groupId,
      );
    }),
  };
  const changed = vi.fn();
  const deps: LibraryToolDeps = {
    listItems: async () => [...state.items],
    listGroups: async () => [...state.groups],
    listGroupMemberships: async () => {
      if (options.rejectReads?.includes('listGroupMemberships') === true) {
        throw new Error('数据库读取失败');
      }
      return [...state.groupMembers];
    },
    listTags: async () => [...state.tags],
    listTagMemberships: async () => {
      if (options.rejectReads?.includes('listTagMemberships') === true) {
        throw new Error('数据库读取失败');
      }
      return [...state.tagMembers];
    },
    locate: async (query) => fakeLocate(state.items, query),
    userMessage: options.userMessage ?? '',
    ...(options.isExplicitInstruction !== undefined
      ? { isExplicitInstruction: options.isExplicitInstruction }
      : {}),
    ...(options.readingStatusOf !== undefined
      ? { readingStatusOf: options.readingStatusOf }
      : {}),
    onLibraryChanged: changed,
    ...writes,
  };
  return { state, deps, writes, changed, session: createLibraryToolSession(deps) };
}

describe('LIBRARY_TOOL_DEFINITIONS', () => {
  it('按固定顺序暴露五类工具，且 session 与定义同源', () => {
    expect(LIBRARY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      LIBRARY_SEARCH_TOOL_NAME,
      LIBRARY_ORGANIZE_TOOL_NAME,
      LIBRARY_TAG_TOOL_NAME,
      LIBRARY_CREATE_GROUP_TOOL_NAME,
      LIBRARY_REMOVE_TOOL_NAME,
    ]);
    expect(LIBRARY_TOOL_DEFINITIONS).toHaveLength(5);
    expect(LIBRARY_TOOL_DEFINITIONS[0]?.parameters.required).toEqual(['action']);
    expect(LIBRARY_TOOL_DEFINITIONS[4]?.parameters.required).toEqual(['kind']);
    const { session } = harness();
    expect(session.tools).toBe(LIBRARY_TOOL_DEFINITIONS);
  });

  it('session 可作为 AssistantToolSession 被面板消费', () => {
    const { session } = harness();
    const panelSession: AssistantToolSession = session;
    expect(panelSession.specifiedChapterCount()).toBe(0);
  });

  it('未知工具返回 unknown_tool', async () => {
    const { session } = harness();
    expect(await session.execute('library_nope', {})).toMatchObject({
      ok: false,
      error: 'unknown_tool',
    });
  });
});

describe('isExplicitLibraryWriteInstruction', () => {
  it.each([
    '把《三体》归到科幻',
    '给我把《三体》和《球状闪电》归入「科幻」分组',
    '帮我把这本书移出旧书分组',
    '把《三体》的科幻标签去掉',
    '取消《三体》的科幻标签',
    '给《三体》打上「硬科幻」标签',
    '把这三本打标签：科幻、太空',
    '请清空《三体》的标签',
    '删除分组「旧书」',
    '删除《三体》这本书',
    '新建分组「待读」',
    '创建分组：科幻',
  ])('识别为显式写指令：%s', (message) => {
    expect(isExplicitLibraryWriteInstruction(message)).toBe(true);
  });

  it.each([
    '',
    '书库里有哪些科幻小说？',
    '怎么把《三体》归到科幻？',
    '如何给书打标签',
    '如果我把这本书归到科幻会怎样',
    '我想把《三体》归到科幻但还没想好',
    '能不能帮我删除这本书',
    '《三体》的标签是什么',
    '什么是智能分组',
    '帮我看看书库里有哪些科幻',
    '把这本书的简介念一下',
  ])('不识别为显式写指令：%s', (message) => {
    expect(isExplicitLibraryWriteInstruction(message)).toBe(false);
  });
});

describe('library_search', () => {
  const items = [
    book({ id: 'a', title: '三体', authors: ['刘慈欣'], extension: 'epub' }),
    book({ id: 'b', title: '球状闪电', authors: ['刘慈欣'], extension: 'txt' }),
    book({ id: 'c', title: '活着', authors: ['余华'], extension: 'epub' }),
  ];

  it('列出分组与标签，不触发写调用', async () => {
    const h = harness({
      items,
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      tags: [{ id: 't1', name: '硬科幻', createdAt: 1, updatedAt: 1 }],
    });
    const groups = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, { action: 'groups' });
    expect(groups.groups).toEqual([{ id: 'g1', name: '科幻', kind: 'custom' }]);
    const tags = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, { action: 'tags' });
    expect(tags.tags).toEqual([{ id: 't1', name: '硬科幻' }]);
    const filteredGroups = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'groups',
      query: '科',
    });
    expect(filteredGroups.groups).toEqual([{ id: 'g1', name: '科幻', kind: 'custom' }]);
    const noTags = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'tags',
      query: '不存在',
    });
    expect(noTags.tags).toEqual([]);
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
  });

  it('按书名过滤并返回格式、分组、标签与阅读状态', async () => {
    const h = harness({
      items,
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      groupMembers: [{ groupId: 'g1', itemId: 'a' }],
      tags: [{ id: 't1', name: '硬科幻', createdAt: 1, updatedAt: 1 }],
      tagMembers: [{ tagId: 't1', itemId: 'a' }],
      readingStatusOf: (itemId) => (itemId === 'a' ? 'in-progress' : null),
    });
    const result = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      title: '三体',
    });
    expect(result.ok).toBe(true);
    expect(result.books).toEqual([
      {
        itemId: 'a',
        title: '三体',
        authors: ['刘慈欣'],
        format: 'epub',
        groups: ['科幻'],
        tags: ['硬科幻'],
        status: 'in-progress',
      },
    ]);
  });

  it('query 同时匹配书名与作者并去重', async () => {
    const h = harness({ items });
    const result = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      query: '刘慈欣',
    });
    expect(result.books?.map((entry) => entry.itemId)).toEqual(['a', 'b']);
    const byTitle = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      query: '闪电',
    });
    expect(byTitle.books?.map((entry) => entry.itemId)).toEqual(['b']);
  });

  it('按分组、标签与格式过滤', async () => {
    const h = harness({
      items,
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      groupMembers: [{ groupId: 'g1', itemId: 'a' }],
      tags: [{ id: 't1', name: '硬科幻', createdAt: 1, updatedAt: 1 }],
      tagMembers: [
        { tagId: 't1', itemId: 'a' },
        { tagId: 't1', itemId: 'b' },
      ],
    });
    const byGroup = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      group: '科幻',
    });
    expect(byGroup.books?.map((entry) => entry.itemId)).toEqual(['a']);
    const byTag = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      tag: '硬科幻',
    });
    expect(byTag.books?.map((entry) => entry.itemId)).toEqual(['a', 'b']);
    const byFormat = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      format: 'TXT',
    });
    expect(byFormat.books?.map((entry) => entry.itemId)).toEqual(['b']);
    const missingTag = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      tag: '不存在',
    });
    expect(missingTag).toMatchObject({ ok: false, error: 'tag_not_found' });
  });

  it('status 条件在无读取面时返回不可用；有读取面时过滤', async () => {
    const without = harness({ items });
    expect(
      await without.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
        action: 'books',
        status: 'finished',
      }),
    ).toMatchObject({ ok: false, error: 'status_unavailable' });

    const withStatus = harness({
      items,
      readingStatusOf: (itemId) => (itemId === 'c' ? 'finished' : null),
    });
    const result = await withStatus.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      status: 'finished',
    });
    expect(result.books?.map((entry) => entry.itemId)).toEqual(['c']);
    expect(
      await withStatus.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
        action: 'books',
        status: 'reading',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_status' });
  });

  it('limit 截断并标记 truncated', async () => {
    const h = harness({ items });
    const result = await h.session.execute(LIBRARY_SEARCH_TOOL_NAME, {
      action: 'books',
      limit: 2,
    });
    expect(result.books).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('显式指令直写', () => {
  const sciFi = { id: 'g1', name: '科幻', kind: 'custom' as const, sortOrder: 1 };

  it('归到已存在分组：直接写入并通知刷新，不进待确认', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体', authors: ['刘慈欣'] })],
      groups: [sciFi],
      userMessage: '把《三体》归到科幻',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: true, action: 'organize' });
    expect(result.pending_confirmation).toBeUndefined();
    expect(h.writes.setGroupMember).toHaveBeenCalledWith('g1', 'a', true);
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'organize',
      itemIds: ['a'],
      groupIds: ['g1'],
      tagIds: [],
    });
  });

  it('目标分组不存在时先新建再归入', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '把《三体》归到科幻',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result.ok).toBe(true);
    expect(h.writes.createGroup).toHaveBeenCalledWith('科幻');
    const createdGroupId = h.state.groups[0]!.id;
    expect(h.writes.setGroupMember).toHaveBeenCalledWith(createdGroupId, 'a', true);
    expect(h.state.items).toHaveLength(1);
  });

  it('移出分组用 present=false', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [sciFi],
      groupMembers: [{ groupId: 'g1', itemId: 'a' }],
      userMessage: '把《三体》移出科幻分组',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: [{ itemId: 'a' }],
      group: '科幻',
      mode: 'remove',
    });
    expect(result.ok).toBe(true);
    expect(h.writes.setGroupMember).toHaveBeenCalledWith('g1', 'a', false);
  });

  it('打标创建缺失标签并与已有标签合并', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      tags: [{ id: 't1', name: '刘慈欣', createdAt: 1, updatedAt: 1 }],
      tagMembers: [{ tagId: 't1', itemId: 'a' }],
      groupMembers: [],
      userMessage: '给《三体》打上「科幻」标签',
    });
    const result = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'add',
      tags: ['科幻'],
    });
    expect(result.ok).toBe(true);
    expect(h.writes.createTag).toHaveBeenCalledWith('科幻');
    const createdTagId = h.state.tags.find((tag) => tag.name === '科幻')!.id;
    expect(h.writes.setItemTags).toHaveBeenCalledTimes(1);
    const written = h.writes.setItemTags.mock.calls[0] as [string, string[]];
    expect(written[0]).toBe('a');
    expect([...written[1]].sort()).toEqual(['t1', createdTagId].sort());
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'tag',
      itemIds: ['a'],
      groupIds: [],
      tagIds: [createdTagId],
    });
  });

  it('取消标签只移除指定标签；标签不存在时不落任何修改', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      tags: [
        { id: 't1', name: '科幻', createdAt: 1, updatedAt: 1 },
        { id: 't2', name: '文学', createdAt: 1, updatedAt: 1 },
      ],
      tagMembers: [
        { tagId: 't1', itemId: 'a' },
        { tagId: 't2', itemId: 'a' },
      ],
      userMessage: '把《三体》的科幻标签去掉',
    });
    const removed = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'remove',
      tags: ['科幻'],
    });
    expect(removed.ok).toBe(true);
    expect(h.writes.setItemTags.mock.calls[0]?.[1]).toEqual(['t2']);
    expect(
      await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
        books: ['三体'],
        mode: 'remove',
        tags: ['不存在'],
      }),
    ).toMatchObject({ ok: false, error: 'tag_not_found' });
    expect(h.writes.setItemTags).toHaveBeenCalledTimes(1);
  });

  it('显式轮次里夹带未被点名的写入仍降级待确认', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '把《三体》归到科幻',
    });
    const result = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'add',
      tags: ['经典'],
    });
    expect(result.pending).toBe(true);
    expect(result.pending_confirmation).toHaveLength(1);
    expect(h.writes.createTag).not.toHaveBeenCalled();
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
  });

  it('新建分组：同名同父已存在时复用不重复创建', async () => {
    const h = harness({
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '帮我新建分组「科幻」',
    });
    const result = await h.session.execute(LIBRARY_CREATE_GROUP_TOOL_NAME, {
      name: '科幻',
    });
    expect(result.ok).toBe(true);
    expect(h.writes.createGroup).not.toHaveBeenCalled();
    expect(result.groups?.[0]?.id).toBe('g1');
  });
});

describe('AI 主动建议待确认', () => {
  it('非显式消息下归类只返回待确认，确认前零写入', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '这本书讲的是什么？',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: true, pending: true });
    const pending = result.pending_confirmation?.[0];
    expect(pending?.tool).toBe(LIBRARY_ORGANIZE_TOOL_NAME);
    expect(pending?.summary).toContain('《三体》');
    expect(pending?.summary).toContain('科幻');
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('确认后用同一 session 的 confirmPending 才写入，且只执行一次', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '帮我整理一下书库',
    });
    const suggested = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    const pending = suggested.pending_confirmation?.[0];
    expect(pending).toBeDefined();
    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed).toMatchObject({ ok: true, action: 'organize' });
    expect(h.writes.setGroupMember).toHaveBeenCalledTimes(1);
    expect(h.changed).toHaveBeenCalledTimes(1);

    const replay = await h.session.confirmPending(pending!.id);
    expect(replay).toMatchObject({ ok: false, error: 'confirmation_expired' });
    expect(h.writes.setGroupMember).toHaveBeenCalledTimes(1);
  });

  it('模型路径携带 pending_ref 被拒绝，不能绕过用户确认', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '帮我整理一下书库',
    });
    const suggested = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    const pending = suggested.pending_confirmation?.[0];
    expect(pending).toBeDefined();
    const bypass = await h.session.execute(pending!.tool, pending!.arguments);
    expect(bypass).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();

    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed).toMatchObject({ ok: true, action: 'organize' });
    expect(h.writes.setGroupMember).toHaveBeenCalledTimes(1);
  });

  it('确认失败保留条目，重试可再次确认直到成功', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '',
    });
    const suggested = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    const pending = suggested.pending_confirmation?.[0];
    h.writes.setGroupMember.mockRejectedValueOnce(new Error('数据库写入失败'));
    const failed = await h.session.confirmPending(pending!.id);
    expect(failed).toMatchObject({ ok: false, error: 'write_failed' });
    const retried = await h.session.confirmPending(pending!.id);
    expect(retried).toMatchObject({ ok: true, action: 'organize' });
    expect(h.writes.setGroupMember).toHaveBeenCalledTimes(2);
  });

  it('同一建议重复出现时 id 稳定，便于面板去重', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '',
    });
    const first = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    const second = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(first.pending_confirmation?.[0]?.id).toBe(
      second.pending_confirmation?.[0]?.id,
    );
  });

  it('目标书顺序不同但语义相同的建议共享 id', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '',
    });
    const first = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体', '活着'],
      group: '科幻',
    });
    const second = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['活着', '三体'],
      group: '科幻',
    });
    expect(first.pending_confirmation?.[0]?.id).toBe(
      second.pending_confirmation?.[0]?.id,
    );
  });

  it('确认前分组已被别处创建时复用，不重复建组', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '帮我整理一下',
    });
    const suggested = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    h.state.groups.push({ id: 'g9', name: '科幻', kind: 'custom', sortOrder: 9 });
    const pending = suggested.pending_confirmation?.[0];
    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed.ok).toBe(true);
    expect(h.writes.createGroup).not.toHaveBeenCalled();
    expect(h.writes.setGroupMember).toHaveBeenCalledWith('g9', 'a', true);
  });

  it('新建分组建议确认前不建组；确认后才建', async () => {
    const h = harness({ userMessage: '最近科幻读得比较多' });
    const suggested = await h.session.execute(LIBRARY_CREATE_GROUP_TOOL_NAME, {
      name: '科幻',
    });
    expect(suggested.pending).toBe(true);
    expect(h.writes.createGroup).not.toHaveBeenCalled();
    const pending = suggested.pending_confirmation?.[0];
    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed.ok).toBe(true);
    expect(h.writes.createGroup).toHaveBeenCalledWith('科幻', undefined);
  });
});

describe('破坏性操作逐次确认', () => {
  it('显式指令删除书籍仍需确认，确认后删除', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '删除《三体》',
    });
    const suggested = await h.session.execute(LIBRARY_REMOVE_TOOL_NAME, {
      kind: 'book',
      books: ['三体'],
    });
    expect(suggested.pending).toBe(true);
    expect(suggested.pending_confirmation?.[0]?.summary).toContain('《三体》');
    expect(h.writes.removeItem).not.toHaveBeenCalled();

    const pending = suggested.pending_confirmation?.[0];
    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed.ok).toBe(true);
    expect(h.writes.removeItem).toHaveBeenCalledWith('a');
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'remove-book',
      itemIds: ['a'],
      groupIds: [],
      tagIds: [],
    });
  });

  it('显式指令删除分组仍需确认，确认后删除', async () => {
    const h = harness({
      groups: [{ id: 'g1', name: '旧书', kind: 'custom', sortOrder: 1 }],
      userMessage: '删除分组「旧书」',
    });
    const suggested = await h.session.execute(LIBRARY_REMOVE_TOOL_NAME, {
      kind: 'group',
      groups: ['旧书'],
    });
    expect(suggested.pending).toBe(true);
    expect(h.writes.deleteGroup).not.toHaveBeenCalled();
    const pending = suggested.pending_confirmation?.[0];
    await h.session.confirmPending(pending!.id);
    expect(h.writes.deleteGroup).toHaveBeenCalledWith('g1');
  });

  it('显式指令清空标签仍需确认，确认后清空且不影响其它书', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      tags: [
        { id: 't1', name: '科幻', createdAt: 1, updatedAt: 1 },
        { id: 't2', name: '文学', createdAt: 1, updatedAt: 1 },
      ],
      tagMembers: [
        { tagId: 't1', itemId: 'a' },
        { tagId: 't2', itemId: 'a' },
        { tagId: 't2', itemId: 'b' },
      ],
      userMessage: '清空《三体》的标签',
    });
    const suggested = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'clear',
    });
    expect(suggested.pending).toBe(true);
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
    const pending = suggested.pending_confirmation?.[0];
    const confirmed = await h.session.confirmPending(pending!.id);
    expect(confirmed.ok).toBe(true);
    expect(h.writes.setItemTags.mock.calls[0]?.[1]).toEqual([]);
    expect(
      h.state.tagMembers.filter((membership) => membership.itemId === 'b'),
    ).toHaveLength(1);
  });
});

describe('同名多本与错误边界', () => {
  it('同名多本返回候选且不写盘', async () => {
    const h = harness({
      items: [
        book({ id: 'a', title: '三体', authors: ['刘慈欣'] }),
        book({ id: 'b', title: '三体', authors: ['刘慈欣'] }),
      ],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '把《三体》归到科幻',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'ambiguous_book' });
    expect(result.book_candidates?.map((entry) => entry.itemId)).toEqual(['a', 'b']);
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('同名多个分组返回候选', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [
        { id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 },
        { id: 'g2', name: '科幻', kind: 'custom', sortOrder: 2 },
      ],
      userMessage: '把《三体》归到科幻',
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'ambiguous_group' });
    expect(result.groups?.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
  });

  it('智能组只读：归类与删除都被拒绝', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 's1', name: '最近阅读', kind: 'smart', sortOrder: 1 }],
      userMessage: '把《三体》归到最近阅读',
    });
    expect(
      await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
        books: ['三体'],
        group: '最近阅读',
      }),
    ).toMatchObject({ ok: false, error: 'smart_group_readonly' });
    expect(
      await h.session.execute(LIBRARY_REMOVE_TOOL_NAME, {
        kind: 'group',
        groups: ['最近阅读'],
      }),
    ).toMatchObject({ ok: false, error: 'smart_group_readonly' });
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.writes.deleteGroup).not.toHaveBeenCalled();
  });

  it('写入失败报错且不通知刷新', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '把《三体》归到科幻',
    });
    h.writes.setGroupMember.mockRejectedValueOnce(new Error('数据库写入失败'));
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'write_failed',
      message: '数据库写入失败',
    });
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('无效参数不写盘', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '把《三体》归到科幻',
    });
    expect(
      await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, { group: '科幻' }),
    ).toMatchObject({ ok: false, error: 'invalid_books' });
    expect(
      await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
        books: ['三体'],
        group: '  ',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_group' });
    expect(
      await h.session.execute(LIBRARY_TAG_TOOL_NAME, { books: ['三体'], mode: 'clear' }),
    ).toMatchObject({ ok: true, pending: true });
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
  });
});

describe('批量写失败补偿与报告', () => {
  it('归类批量中途失败时逐项回滚并保持原状', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '把《三体》和《活着》归到科幻',
    });
    let calls = 0;
    h.writes.setGroupMember.mockImplementation(
      async (groupId: string, itemId: string, present: boolean): Promise<void> => {
        calls += 1;
        if (calls === 2) {
          throw new Error('数据库写入失败');
        }
        h.state.groupMembers = h.state.groupMembers.filter(
          (membership) =>
            !(membership.groupId === groupId && membership.itemId === itemId),
        );
        if (present) {
          h.state.groupMembers.push({ groupId, itemId });
        }
      },
    );
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体', '活着'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(result.message).toContain('已回滚');
    expect(h.state.groupMembers).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('归类回滚失败时列出已生效项并通知刷新', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      groups: [{ id: 'g1', name: '科幻', kind: 'custom', sortOrder: 1 }],
      userMessage: '把《三体》和《活着》归到科幻',
    });
    let calls = 0;
    h.writes.setGroupMember.mockImplementation(
      async (groupId: string, itemId: string, present: boolean): Promise<void> => {
        calls += 1;
        if (calls === 2) {
          throw new Error('数据库写入失败');
        }
        if (calls === 3) {
          throw new Error('回滚失败');
        }
        h.state.groupMembers = h.state.groupMembers.filter(
          (membership) =>
            !(membership.groupId === groupId && membership.itemId === itemId),
        );
        if (present) {
          h.state.groupMembers.push({ groupId, itemId });
        }
      },
    );
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体', '活着'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed', updated: ['a'] });
    expect(result.message).toContain('未能全部回滚');
    expect(h.state.groupMembers).toEqual([{ groupId: 'g1', itemId: 'a' }]);
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'organize',
      itemIds: ['a'],
      groupIds: ['g1'],
      tagIds: [],
    });
  });

  it('归类新建分组后中途失败时删除新建分组', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      userMessage: '把《三体》和《活着》归到分组「科幻」',
    });
    let calls = 0;
    h.writes.setGroupMember.mockImplementation(
      async (groupId: string, itemId: string, present: boolean): Promise<void> => {
        calls += 1;
        if (calls === 2) {
          throw new Error('数据库写入失败');
        }
        h.state.groupMembers = h.state.groupMembers.filter(
          (membership) =>
            !(membership.groupId === groupId && membership.itemId === itemId),
        );
        if (present) {
          h.state.groupMembers.push({ groupId, itemId });
        }
      },
    );
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体', '活着'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(result.message).toContain('已回滚');
    expect(h.writes.createGroup).toHaveBeenCalledTimes(1);
    expect(h.writes.deleteGroup).toHaveBeenCalledTimes(1);
    expect(h.state.groups).toEqual([]);
    expect(h.state.groupMembers).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('新建分组未能回滚时报告分组并通知刷新', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '把《三体》归到分组「科幻」',
    });
    h.writes.setGroupMember.mockRejectedValueOnce(new Error('数据库写入失败'));
    h.writes.deleteGroup.mockRejectedValueOnce(new Error('回滚失败'));
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    const createdGroupId = h.state.groups[0]!.id;
    expect(result).toMatchObject({
      ok: false,
      error: 'write_failed',
      updated: [createdGroupId],
    });
    expect(result.message).toContain('未能回滚');
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'organize',
      itemIds: [],
      groupIds: [createdGroupId],
      tagIds: [],
    });
    expect(h.state.groups.map((group) => group.id)).toEqual([createdGroupId]);
  });

  it('打标中途新建标签失败时删除已建标签', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '给我把《三体》打上「科幻」和「太空」标签',
    });
    let calls = 0;
    h.writes.createTag.mockImplementation(async (name: string): Promise<LibraryTag> => {
      calls += 1;
      if (calls === 2) {
        throw new Error('数据库写入失败');
      }
      const trimmed = name.trim();
      const existing = h.state.tags.find((tag) => tag.name === trimmed);
      if (existing !== undefined) {
        return existing;
      }
      h.state.seq += 1;
      const tag: LibraryTag = {
        id: `t${h.state.seq}`,
        name: trimmed,
        createdAt: 1,
        updatedAt: 1,
      };
      h.state.tags.push(tag);
      return tag;
    });
    const result = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'add',
      tags: ['科幻', '太空'],
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(h.writes.deleteTag).toHaveBeenCalledTimes(1);
    expect(h.state.tags).toEqual([]);
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('打标批量中途失败回滚已写项并删除新建标签', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      tags: [{ id: 't1', name: '刘慈欣', createdAt: 1, updatedAt: 1 }],
      tagMembers: [{ tagId: 't1', itemId: 'a' }],
      userMessage: '把《三体》和《活着》打上「科幻」标签',
    });
    let calls = 0;
    h.writes.setItemTags.mockImplementation(
      async (itemId: string, tagIds: readonly string[]): Promise<void> => {
        calls += 1;
        if (calls === 2) {
          throw new Error('数据库写入失败');
        }
        h.state.tagMembers = h.state.tagMembers.filter(
          (membership) => membership.itemId !== itemId,
        );
        for (const tagId of tagIds) {
          h.state.tagMembers.push({ tagId, itemId });
        }
      },
    );
    const result = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体', '活着'],
      mode: 'add',
      tags: ['科幻'],
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(result.message).toContain('已回滚');
    expect(h.writes.deleteTag).toHaveBeenCalledTimes(1);
    expect(h.state.tags.map((tag) => tag.name)).toEqual(['刘慈欣']);
    expect(
      h.state.tagMembers.filter((membership) => membership.itemId === 'a').map((m) => m.tagId),
    ).toEqual(['t1']);
    expect(h.state.tagMembers.some((membership) => membership.itemId === 'b')).toBe(false);
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('删除书籍中途失败报告已删除项并通知刷新', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' }), book({ id: 'b', title: '活着' })],
      userMessage: '删除《三体》和《活着》',
    });
    const suggested = await h.session.execute(LIBRARY_REMOVE_TOOL_NAME, {
      kind: 'book',
      books: ['三体', '活着'],
    });
    const pending = suggested.pending_confirmation?.[0];
    expect(pending).toBeDefined();
    let calls = 0;
    h.writes.removeItem.mockImplementation(async (itemId: string): Promise<void> => {
      calls += 1;
      if (calls === 2) {
        throw new Error('数据库写入失败');
      }
      h.state.items = h.state.items.filter((item) => item.id !== itemId);
    });
    const result = await h.session.confirmPending(pending!.id);
    expect(result).toMatchObject({ ok: false, error: 'write_failed', updated: ['a'] });
    expect(result.message).toContain('已删除 1/2');
    expect(h.state.items.map((item) => item.id)).toEqual(['b']);
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'remove-book',
      itemIds: ['a'],
      groupIds: [],
      tagIds: [],
    });

    // 保留的条目可重试：已删除的目标被跳过，剩余目标继续删除并收敛。
    const retried = await h.session.confirmPending(pending!.id);
    expect(retried).toMatchObject({ ok: true, action: 'remove-book' });
    expect(h.state.items).toEqual([]);
  });

  it('删除分组中途失败报告已删除项并通知刷新', async () => {
    const h = harness({
      groups: [
        { id: 'g1', name: '旧书', kind: 'custom', sortOrder: 1 },
        { id: 'g2', name: '待读', kind: 'custom', sortOrder: 2 },
      ],
      userMessage: '删除分组「旧书」和「待读」',
    });
    const suggested = await h.session.execute(LIBRARY_REMOVE_TOOL_NAME, {
      kind: 'group',
      groups: ['旧书', '待读'],
    });
    const pending = suggested.pending_confirmation?.[0];
    expect(pending).toBeDefined();
    let calls = 0;
    h.writes.deleteGroup.mockImplementation(async (groupId: string): Promise<void> => {
      calls += 1;
      if (calls === 2) {
        throw new Error('数据库写入失败');
      }
      h.state.groups = h.state.groups.filter((group) => group.id !== groupId);
    });
    const result = await h.session.confirmPending(pending!.id);
    expect(result).toMatchObject({ ok: false, error: 'write_failed', updated: ['g1'] });
    expect(result.message).toContain('已删除 1/2');
    expect(h.state.groups.map((group) => group.id)).toEqual(['g2']);
    expect(h.changed).toHaveBeenCalledWith({
      kind: 'remove-group',
      itemIds: [],
      groupIds: ['g1'],
      tagIds: [],
    });

    // 保留的条目可重试：已删除的目标被跳过，剩余目标继续删除并收敛。
    const retried = await h.session.confirmPending(pending!.id);
    expect(retried).toMatchObject({ ok: true, action: 'remove-group' });
    expect(h.state.groups).toEqual([]);
  });

  it('归类读取成员快照失败时不建组，书库保持原状', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '把《三体》归到分组「科幻」',
      rejectReads: ['listGroupMemberships'],
    });
    const result = await h.session.execute(LIBRARY_ORGANIZE_TOOL_NAME, {
      books: ['三体'],
      group: '科幻',
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(result.updated).toBeUndefined();
    expect(result.message).toContain('数据库读取失败');
    expect(h.writes.createGroup).not.toHaveBeenCalled();
    expect(h.writes.deleteGroup).not.toHaveBeenCalled();
    expect(h.writes.setGroupMember).not.toHaveBeenCalled();
    expect(h.state.groups).toEqual([]);
    expect(h.state.groupMembers).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
  });

  it('打标读取标签关系失败时不建标签，书库保持原状', async () => {
    const h = harness({
      items: [book({ id: 'a', title: '三体' })],
      userMessage: '给《三体》打上「科幻」标签',
      rejectReads: ['listTagMemberships'],
    });
    const result = await h.session.execute(LIBRARY_TAG_TOOL_NAME, {
      books: ['三体'],
      mode: 'add',
      tags: ['科幻'],
    });
    expect(result).toMatchObject({ ok: false, error: 'write_failed' });
    expect(result.updated).toBeUndefined();
    expect(result.message).toContain('数据库读取失败');
    expect(h.writes.createTag).not.toHaveBeenCalled();
    expect(h.writes.deleteTag).not.toHaveBeenCalled();
    expect(h.writes.setItemTags).not.toHaveBeenCalled();
    expect(h.state.tags).toEqual([]);
    expect(h.state.tagMembers).toEqual([]);
    expect(h.changed).not.toHaveBeenCalled();
  });
});

describe('defaultLibraryToolDeps', () => {
  it('默认映射到 LibraryClient / library-content，且可被 surface 覆盖', () => {
    const locate = vi.fn();
    const deps = defaultLibraryToolDeps({ locate, userMessage: '把《三体》归到科幻' });
    expect(deps.userMessage).toBe('把《三体》归到科幻');
    expect(deps.locate).toBe(locate);
    expect(typeof deps.listItems).toBe('function');
    expect(typeof deps.setItemTags).toBe('function');
  });
});
