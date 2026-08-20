// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindLibraryProgress,
  saveLibraryProgressAlias,
  type LibraryProgressQuery,
} from '../library-progress.js';
import { classifyLibraryKind } from '../library-kind.js';
import { createLibraryView, type LibraryViewDependencies } from '../library-view.js';
import {
  type LibraryGroup,
  type LibraryGroupMembership,
  type LibraryItem,
} from '../library-client.js';
import type { OpdsEntry, OpdsFeed, OpdsSource } from '../opds-client.js';
import { saveReadingProgress, type ProgressStorage } from '../../reader/reading-progress.js';
import '../library.css';

type GroupLibrary = NonNullable<LibraryViewDependencies['library']>;

const source: OpdsSource = {
  id: 'source-1',
  title: '测试书库',
  url: 'https://books.example/opds',
  allowHttp: false,
  createdAt: 1,
  updatedAt: 1,
};

const entry: OpdsEntry = {
  id: 'entry-1',
  itemId: 'item-1',
  title: '远程漫画',
  authors: ['作者'],
  links: [
    {
      href: 'https://books.example/book.cbz',
      rel: 'http://opds-spec.org/acquisition',
      mediaType: 'application/vnd.comicbook+zip',
      extension: 'cbz',
      acquisition: true,
    },
  ],
};

function feed(overrides: Partial<OpdsFeed> = {}): OpdsFeed {
  return {
    title: '目录',
    entries: [entry],
    links: [],
    sourceUrl: 'https://books.example/opds',
    ...overrides,
  };
}

function localItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'local:/books/a.epub',
    sourceKind: 'local',
    title: '本地小说',
    authors: [],
    localPath: '/books/a.epub',
    extension: 'epub',
    updatedAt: 1,
    ...overrides,
  };
}

function comicItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return localItem({
    id: 'local:/books/b.cbz',
    title: '本地漫画',
    extension: 'cbz',
    localPath: '/books/b.cbz',
    coverUrl: 'https://covers.example/comic.jpg',
    ...overrides,
  });
}

function dependencies(overrides: Partial<LibraryViewDependencies> = {}): LibraryViewDependencies {
  return {
    opds: {
      addSource: vi.fn(async () => source),
      listSources: vi.fn(async () => [source]),
      removeSource: vi.fn(async () => undefined),
      browse: vi.fn(async () => feed({ nextUrl: 'https://books.example/opds?page=2' })),
      search: vi.fn(async () => feed({ title: '搜索结果' })),
    },
    library: {
      listItems: vi.fn(async () => [localItem()]),
      listAcquisitionLinks: vi.fn(async () => []),
      removeItem: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      setCacheLimit: vi.fn(async () => undefined),
      cacheStats: vi.fn(async () => ({ bytesCached: 0, limitBytes: 2 * 1024 ** 3 })),
    },
    getLocale: () => 'zh-CN',
    onOpen: vi.fn(async () => undefined),
    onCache: vi.fn(async () => undefined),
    onImportLocal: vi.fn(async () => null),
    notify: vi.fn(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitForShown(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(message);
}

function libraryRoot(host: ParentNode): HTMLElement {
  const root = host.querySelector<HTMLElement>('.lightink-library');
  if (!root) throw new Error('library root not found');
  return root;
}

function libraryPage(host: ParentNode): string | undefined {
  return libraryRoot(host).dataset.libraryPage;
}

function isShown(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden || el.closest('[hidden]')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function shownButtonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const candidate = Array.from(root.querySelectorAll('button')).find(
    (button) => button.textContent === text && isShown(button),
  );
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`visible button not found: ${text}`);
  return candidate;
}

function groupButton(host: ParentNode, label: string): HTMLButtonElement {
  const groups = host.querySelector('.lightink-library-groups') ?? host;
  const shelf = Array.from(groups.querySelectorAll<HTMLButtonElement>('[data-shelf-group]')).find(
    (button) => button.textContent === label && isShown(button),
  );
  if (shelf) return shelf;
  return shownButtonWithText(groups, label);
}

function collectionButton(host: ParentNode, name: string): HTMLButtonElement {
  const groups = host.querySelector('.lightink-library-groups') ?? host;
  const candidate = Array.from(
    groups.querySelectorAll<HTMLButtonElement>('[data-library-group-id], [data-group-id]'),
  ).find((button) => button.textContent?.trim() === name && isShown(button));
  if (!(candidate instanceof HTMLButtonElement)) {
    throw new Error(`collection button not found: ${name}`);
  }
  return candidate;
}

function collectionRow(host: ParentNode, name: string): HTMLElement {
  const choose = collectionButton(host, name);
  const row =
    choose.closest('.lightink-library-custom-group') ??
    choose.closest('.lightink-library-custom-group-row') ??
    choose.closest('.lightink-library-group-row');
  return row instanceof HTMLElement ? row : choose;
}

function shownControl(host: ParentNode, label: string): HTMLButtonElement {
  const labeled = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (labeled instanceof HTMLButtonElement && isShown(labeled)) return labeled;
  return shownButtonWithText(host, label);
}

function sourceFormOf(host: ParentNode = document): HTMLFormElement {
  const form =
    host.querySelector<HTMLFormElement>('.lightink-library-source-modal .lightink-library-source-form') ??
    document.querySelector<HTMLFormElement>(
      '.lightink-library-source-modal .lightink-library-source-form',
    ) ??
    host.querySelector<HTMLFormElement>('.lightink-library-source-form') ??
    document.querySelector<HTMLFormElement>('.lightink-library-source-form');
  if (!form) throw new Error('source form not found');
  return form;
}

function groupFormOf(host: ParentNode = document): HTMLFormElement {
  const form =
    host.querySelector<HTMLFormElement>('.lightink-library-group-editor') ??
    document.querySelector<HTMLFormElement>('.lightink-library-group-editor');
  if (!form) throw new Error('group form not found');
  return form;
}

async function startCreateGroup(host: HTMLElement): Promise<void> {
  const groups = host.querySelector('.lightink-library-groups') ?? host;
  shownControl(groups, '新建分组').click();
  await settle();
}

async function submitGroupForm(
  host: HTMLElement,
  values: { name?: string; parentId?: string; groupId?: string },
): Promise<void> {
  const form = groupFormOf(host);
  if (values.name !== undefined) {
    const name = form.elements.namedItem('groupName') ?? form.elements.namedItem('name');
    if (!(name instanceof HTMLInputElement)) throw new Error('group name field not found');
    name.value = values.name;
  }
  if (values.parentId !== undefined) {
    const parent = form.elements.namedItem('groupParent') ?? form.elements.namedItem('parentId');
    if (!(parent instanceof HTMLSelectElement) && !(parent instanceof HTMLInputElement)) {
      throw new Error('group parent field not found');
    }
    parent.value = values.parentId;
  }
  if (values.groupId !== undefined) {
    const group = form.elements.namedItem('groupId');
    if (!(group instanceof HTMLSelectElement) && !(group instanceof HTMLInputElement)) {
      throw new Error('group picker field not found');
    }
    group.value = values.groupId;
  }
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  await settle();
}

async function organizeShelf(_host: HTMLElement): Promise<void> {
  await settle();
}

function contextMenuItem(label: string): HTMLButtonElement {
  const menu = document.querySelector('.lightink-context-menu');
  if (!(menu instanceof HTMLElement)) throw new Error('context menu not found');
  const item = Array.from(menu.querySelectorAll('button')).find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!(item instanceof HTMLButtonElement)) throw new Error(`menu item not found: ${label}`);
  return item;
}

async function openItemMenu(host: HTMLElement, itemId: string): Promise<HTMLElement> {
  const card = itemCard(host, itemId);
  card.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
  );
  await settle();
  const menu = document.querySelector('.lightink-context-menu');
  if (!(menu instanceof HTMLElement)) throw new Error('context menu not found');
  return menu;
}

async function addItemToCollection(
  host: HTMLElement,
  itemId: string,
  groupName: string,
): Promise<void> {
  await openItemMenu(host, itemId);
  contextMenuItem(groupName).click();
  await settle();
}

interface MutableGroup {
  id: string;
  parentId?: string;
  name: string;
  kind: LibraryGroup['kind'];
  sortOrder: number;
  itemIds: string[];
}

function toLibraryGroup(group: MutableGroup): LibraryGroup {
  return {
    id: group.id,
    parentId: group.parentId,
    name: group.name,
    kind: group.kind,
    sortOrder: group.sortOrder,
  };
}

function createGroupStore() {
  const state: MutableGroup[] = [];
  const memberships: LibraryGroupMembership[] = [];
  let seq = 0;

  const findIndex = (groupId: string): number => {
    const index = state.findIndex((group) => group.id === groupId);
    if (index < 0) throw new Error(`group not found: ${groupId}`);
    return index;
  };

  return {
    async listGroups(): Promise<LibraryGroup[]> {
      return state.map(toLibraryGroup);
    },
    async listGroupMemberships(): Promise<LibraryGroupMembership[]> {
      return [...memberships];
    },
    async createGroup(name: string, parentId?: string): Promise<LibraryGroup> {
      seq += 1;
      const group: MutableGroup = {
        id: `group-${seq}`,
        parentId,
        name,
        kind: 'custom',
        sortOrder: state.length,
        itemIds: [],
      };
      state.push(group);
      return toLibraryGroup(group);
    },
    async updateGroup(groupId: string, name: string): Promise<LibraryGroup> {
      const group = state[findIndex(groupId)]!;
      group.name = name;
      return toLibraryGroup(group);
    },
    async moveGroup(
      groupId: string,
      parentId: string | undefined,
      sortOrder: number,
    ): Promise<LibraryGroup> {
      const group = state[findIndex(groupId)]!;
      group.parentId = parentId;
      group.sortOrder = sortOrder;
      return toLibraryGroup(group);
    },
    async deleteGroup(groupId: string): Promise<void> {
      state.splice(findIndex(groupId), 1);
      for (let index = memberships.length - 1; index >= 0; index -= 1) {
        if (memberships[index]?.groupId === groupId) memberships.splice(index, 1);
      }
    },
    async setGroupMember(groupId: string, itemId: string, present: boolean): Promise<void> {
      const existing = memberships.findIndex(
        (entry) => entry.groupId === groupId && entry.itemId === itemId,
      );
      if (present && existing < 0) memberships.push({ groupId, itemId });
      if (!present && existing >= 0) memberships.splice(existing, 1);
    },
  };
}

function collectionDependencies(options: {
  items: LibraryItem[];
  seriesStemByItemId?: Readonly<Record<string, string>>;
  getProgress?: LibraryViewDependencies['getProgress'];
}): { deps: LibraryViewDependencies; library: GroupLibrary } {
  const items = [...options.items];
  const store = createGroupStore();
  const groups = {
    listGroups: vi.fn(() => store.listGroups()),
    listGroupMemberships: vi.fn(() => store.listGroupMemberships()),
    createGroup: vi.fn((name: string, parentId?: string) => store.createGroup(name, parentId)),
    updateGroup: vi.fn((groupId: string, name: string) => store.updateGroup(groupId, name)),
    moveGroup: vi.fn((groupId: string, parentId: string | undefined, sortOrder: number) =>
      store.moveGroup(groupId, parentId, sortOrder),
    ),
    deleteGroup: vi.fn((groupId: string) => store.deleteGroup(groupId)),
    setGroupMember: vi.fn((groupId: string, itemId: string, present: boolean) =>
      store.setGroupMember(groupId, itemId, present),
    ),
  };
  const base = dependencies({
    getProgress: options.getProgress,
    library: {
      ...dependencies().library,
      listItems: vi.fn(async () => items),
      ...groups,
    },
  });
  return { library: base.library, deps: base };
}

async function openManage(host: HTMLElement): Promise<void> {
  const entry =
    host.querySelector<HTMLButtonElement>('.lightink-library-manage-entry') ??
    shownButtonWithText(host, '管理');
  if (!isShown(entry)) throw new Error('manage entry is not on the first screen');
  entry.click();
  await settle();
}

async function openMyBooks(host: HTMLElement): Promise<void> {
  const home =
    host.querySelector<HTMLButtonElement>('.lightink-library-home') ??
    Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === '我的书' && isShown(button),
    );
  if (!(home instanceof HTMLButtonElement)) throw new Error('my-books entry not found');
  home.click();
  await settle();
}

async function openCatalog(host: HTMLElement, sourceTitle = '测试书库'): Promise<void> {
  if (libraryPage(host) !== 'manage' && libraryPage(host) !== 'catalog') {
    await openManage(host);
  }
  shownButtonWithText(host, sourceTitle).click();
  await settle();
}

function itemRow(host: ParentNode, itemId: string): HTMLButtonElement {
  const row =
    host.querySelector<HTMLButtonElement>(`.lightink-library-item[data-item-id="${itemId}"]`) ??
    host.querySelector<HTMLButtonElement>(`[data-item-id="${itemId}"]`);
  if (!(row instanceof HTMLButtonElement)) throw new Error(`item not found: ${itemId}`);
  return row;
}

function itemCard(host: ParentNode, itemId: string): HTMLElement {
  const shell = host.querySelector<HTMLElement>(
    `.lightink-library-item-shell[data-item-id="${itemId}"]`,
  );
  return shell ?? itemRow(host, itemId);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('LibraryView my-books home', () => {
  it('renders a recognizable cover wall that distinguishes unread and in-progress books', async () => {
    const unread = localItem({
      coverUrl: 'https://covers.example/novel.jpg',
    });
    const comic = comicItem();
    const getProgress = vi.fn((item: LibraryProgressQuery) =>
      item.id === comic.id
        ? { status: 'in-progress' as const, unit: 'page' as const, index: 12, ratio: 0, percent: 37 }
        : { status: 'not-started' as const },
    );
    const base = dependencies();
    const deps = dependencies({
      getProgress,
      library: { ...base.library, listItems: vi.fn(async () => [unread, comic]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(libraryPage(host)).toBe('my-books');
    const unreadRow = itemRow(host, unread.id);
    const comicRow = itemRow(host, comic.id);
    expect(unreadRow.textContent).toContain('本地小说');
    expect(comicRow.textContent).toContain('本地漫画');
    expect(unreadRow.querySelector<HTMLImageElement>('.lightink-library-cover img')?.src).toContain(
      'covers.example/novel.jpg',
    );
    expect(comicRow.querySelector<HTMLImageElement>('.lightink-library-cover img')?.src).toContain(
      'covers.example/comic.jpg',
    );
    expect(unreadRow.dataset.progressStatus).toBe('not-started');
    expect(unreadRow.textContent).toContain('未开始');
    expect(unreadRow.textContent).not.toContain('0%');
    expect(comicRow.dataset.progressStatus).toBe('in-progress');
    expect(comicRow.textContent).toContain('第 12 页');
    expect(comicRow.textContent).toContain('已读 37%');
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    view.destroy();
  });

  it('keeps sources, cache, import, close, and detail off the first screen', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(libraryPage(host)).toBe('my-books');
    expect(isShown(host.querySelector('.lightink-library-sources'))).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-cache-summary'))).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    expect(isShown(host.querySelector('[aria-label="关闭书库"]'))).toBe(false);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === '导入本地书籍' && isShown(button),
      ),
    ).toBe(false);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === '测试书库' && isShown(button),
      ),
    ).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-groups'))).toBe(true);
    expect(isShown(host.querySelector('.lightink-library-manage-entry'))).toBe(true);
    expect(host.querySelector('.lightink-library-search')).not.toBeNull();
    view.destroy();
  });

  it('renders a local data-URL cover on the wall', async () => {
    const cover = localItem({
      title: '河山记',
      coverUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
    const base = dependencies();
    const deps = dependencies({
      library: { ...base.library, listItems: vi.fn(async () => [cover]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    expect(itemRow(host, cover.id).querySelector('img')?.src).toContain('data:image/png');
    view.destroy();
  });

  it('keeps the workspace travel control hidden on the shelf', async () => {
    const travel = document.createElement('button');
    travel.type = 'button';
    travel.id = 'lightink-enter-editor';
    travel.className = 'lightink-workspace-travel';
    travel.textContent = '编辑';
    const deps = dependencies({ workspaceTravel: travel });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const toolbar = host.querySelector('.lightink-library-toolbar');
    expect(toolbar?.contains(travel)).toBe(false);
    expect(travel.classList.contains('lightink-library-edit')).toBe(true);
    expect(isShown(travel)).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-manage-entry'))).toBe(true);

    await openManage(host);
    expect(libraryPage(host)).toBe('manage');
    expect(isShown(travel)).toBe(false);
    expect(
      Array.from(host.querySelectorAll('.lightink-library-toolbar button')).some(
        (button) => button.textContent === '编辑' && isShown(button),
      ),
    ).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-editor-entry'))).toBe(false);
    view.destroy();
    expect(travel.isConnected).toBe(false);
  });

  it('renders imported items when title or comic metadata is null', async () => {
    const broken = {
      ...localItem({ id: 'local:/books/null.epub' }),
      title: null,
      authors: null,
      series: null,
    } as unknown as LibraryItem;
    const base = dependencies();
    const deps = dependencies({
      library: { ...base.library, listItems: vi.fn(async () => [broken]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(itemRow(host, broken.id)).toBeTruthy();
    expect(host.querySelector('.lightink-library-status')?.textContent).toBe('');
    view.destroy();
  });

  it('filters the cover wall with 全部 / 在读 / 未读 / 文字书 / 漫画', async () => {
    const unread = localItem();
    const novel = localItem({
      id: 'local:/books/c.epub',
      title: '续读小说',
      localPath: '/books/c.epub',
    });
    const comic = comicItem();
    const getProgress = vi.fn((item: LibraryProgressQuery) => {
      if (item.id === unread.id) return { status: 'not-started' as const };
      if (item.id === comic.id) {
        return { status: 'in-progress' as const, unit: 'page' as const, index: 4, ratio: 0, percent: 20 };
      }
      return { status: 'in-progress' as const, unit: 'chapter' as const, index: 2, ratio: 0.4, percent: 21 };
    });
    const base = dependencies();
    const deps = dependencies({
      getProgress,
      library: { ...base.library, listItems: vi.fn(async () => [unread, novel, comic]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(itemRow(host, unread.id).textContent).toContain('本地小说');
    expect(itemRow(host, novel.id).textContent).toContain('续读小说');
    expect(itemRow(host, comic.id).textContent).toContain('本地漫画');

    groupButton(host, '在读').click();
    await settle();
    expect(host.querySelector(`[data-item-id="${unread.id}"]`)).toBeNull();
    expect(itemRow(host, novel.id).textContent).toContain('续读小说');
    expect(itemRow(host, comic.id).textContent).toContain('本地漫画');

    groupButton(host, '未读').click();
    await settle();
    expect(itemRow(host, unread.id).textContent).toContain('本地小说');
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();
    expect(host.querySelector(`[data-item-id="${comic.id}"]`)).toBeNull();

    groupButton(host, '文字书').click();
    await settle();
    expect(itemRow(host, unread.id).textContent).toContain('本地小说');
    expect(itemRow(host, novel.id).textContent).toContain('续读小说');
    expect(host.querySelector(`[data-item-id="${comic.id}"]`)).toBeNull();

    groupButton(host, '漫画').click();
    await settle();
    expect(host.querySelector(`[data-item-id="${unread.id}"]`)).toBeNull();
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();
    expect(itemRow(host, comic.id).textContent).toContain('本地漫画');

    groupButton(host, '全部').click();
    await settle();
    expect(itemRow(host, unread.id)).toBeTruthy();
    expect(itemRow(host, novel.id)).toBeTruthy();
    expect(itemRow(host, comic.id)).toBeTruthy();
    view.destroy();
  });

  it('opens from a cover click without a persistent detail pane', async () => {
    const unread = localItem({ coverUrl: 'https://covers.example/novel.jpg' });
    const deps = dependencies({
      library: { ...dependencies().library, listItems: vi.fn(async () => [unread]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    itemRow(host, unread.id).querySelector('.lightink-library-cover')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ id: unread.id }) }),
      expect.anything(),
    );
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    view.destroy();
  });

  it('opens an in-progress book from 继续阅读 and hides a zero percent', async () => {
    const novel = localItem({
      id: 'local:/books/c.epub',
      title: '续读小说',
      localPath: '/books/c.epub',
      coverUrl: 'https://covers.example/reading.jpg',
    });
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'chapter' as const,
      index: 3,
      ratio: 0,
      percent: 0,
    }));
    const deps = dependencies({
      getProgress,
      library: { ...dependencies().library, listItems: vi.fn(async () => [novel]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(isShown(host.querySelector('.lightink-library-continue'))).toBe(true);
    expect(host.querySelector('.lightink-library-continue')?.textContent).toContain('续读小说');
    expect(host.textContent).toContain('第 4 章');
    expect(host.textContent).not.toContain('0%');
    shownControl(host.querySelector('.lightink-library-continue')!, '继续阅读').click();
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ id: novel.id }) }),
      expect.anything(),
    );
    view.destroy();
  });

  it('dismisses 继续阅读 until that book’s progress changes', async () => {
    const novel = localItem({
      id: 'local:/books/dismiss.epub',
      title: '可关闭续读',
      localPath: '/books/dismiss.epub',
    });
    const progress = {
      status: 'in-progress' as const,
      unit: 'chapter' as const,
      index: 2,
      ratio: 0.25,
      percent: 40,
    };
    const getProgress = vi.fn(() => progress);
    const store: Record<string, string> = {};
    const deps = dependencies({
      getProgress,
      progressStorage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
        removeItem: (key) => {
          delete store[key];
        },
      },
      library: { ...dependencies().library, listItems: vi.fn(async () => [novel]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const bar = host.querySelector<HTMLElement>('.lightink-library-continue');
    expect(isShown(bar)).toBe(true);
    shownControl(bar!, '关闭').click();
    await settle();
    expect(isShown(host.querySelector('.lightink-library-continue'))).toBe(false);

    groupButton(host, '在读').click();
    await settle();
    groupButton(host, '全部').click();
    await settle();
    expect(isShown(host.querySelector('.lightink-library-continue'))).toBe(false);

    getProgress.mockReturnValue({
      status: 'in-progress',
      unit: 'chapter',
      index: 3,
      ratio: 0.1,
      percent: 55,
    });
    await view.refresh();
    expect(isShown(host.querySelector('.lightink-library-continue'))).toBe(true);
    expect(host.querySelector('.lightink-library-continue')?.textContent).toContain('可关闭续读');
    view.destroy();
  });

  it('shows series on the cover card without opening a detail pane', async () => {
    const comic = comicItem({
      series: '墨色档案',
      number: '12',
      volume: '3',
      pageCount: 128,
      readingDirection: 'rtl',
      coverPage: 0,
    });
    const base = dependencies();
    const deps = dependencies({
      library: { ...base.library, listItems: vi.fn(async () => [comic]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const row = itemRow(host, comic.id);
    expect(row.textContent).toContain('本地漫画');
    expect(row.textContent).toContain('墨色档案');
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    view.destroy();
  });

  it('treats missing or unreadable progress as not started without 0%', async () => {
    const deps = dependencies({ getProgress: vi.fn(() => null) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const row = itemRow(host, localItem().id);
    expect(row.dataset.progressStatus).toBe('not-started');
    expect(row.textContent).toContain('未开始');
    expect(row.textContent).not.toContain('0%');
    expect(row.textContent).not.toContain('已读');
    view.destroy();
  });

  it('labels a first comic page without rendering 0%', async () => {
    const comic = comicItem({ title: '首页漫画', id: 'local:/comics/a.cbz', localPath: '/comics/a.cbz' });
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'page' as const,
      index: 0,
      ratio: 0,
    }));
    const base = dependencies();
    const deps = dependencies({
      getProgress,
      library: { ...base.library, listItems: vi.fn(async () => [comic]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const row = itemRow(host, comic.id);
    expect(row.dataset.progressStatus).toBe('in-progress');
    expect(row.textContent).toContain('第 1 页');
    expect(row.textContent).not.toContain('0%');
    view.destroy();
  });

  it('cancels an active open when the library is hidden', async () => {
    let operationSignal: AbortSignal | undefined;
    const onOpen = vi.fn(
      async (_request: unknown, signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
          operationSignal = signal;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const deps = dependencies({ onOpen });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    itemRow(host, localItem().id).click();
    await settle();
    view.hide();
    await settle();

    expect(operationSignal?.aborted).toBe(true);
    expect(deps.notify).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('LibraryView manage and catalog', () => {
  it('hides the library search on manage and keeps the submit control out of the chrome', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    const search = host.querySelector<HTMLFormElement>('.lightink-library-search');
    const submit = host.querySelector<HTMLButtonElement>('.lightink-library-search-submit');
    expect(search?.hidden).toBe(true);
    expect(isShown(search)).toBe(false);
    expect(submit?.type).toBe('submit');
    expect(host.querySelector('.lightink-library-source-row')?.textContent).toContain('测试书库');
    expect(host.querySelector('.lightink-library-source-url')?.textContent).toContain(
      'https://books.example/opds',
    );
    view.destroy();
  });

  it('imports a local book from manage and returns it to the cover wall', async () => {
    const imported = localItem({
      id: 'local:/books/new.epub',
      title: '新导入的书',
      localPath: '/books/new.epub',
      coverUrl: 'https://covers.example/new.jpg',
    });
    let items = [localItem()];
    const base = dependencies();
    const deps = dependencies({
      onImportLocal: vi.fn(async () => imported),
      library: {
        ...base.library,
        listItems: vi.fn(async () => items),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    expect(libraryPage(host)).toBe('manage');
    shownButtonWithText(host, '导入本地书籍').click();
    items = [localItem(), imported];
    await settle();
    if (libraryPage(host) !== 'my-books') await openMyBooks(host);

    expect(libraryPage(host)).toBe('my-books');
    expect(itemRow(host, imported.id).textContent).toContain('新导入的书');
    expect(isShown(host.querySelector('.lightink-library-sources'))).toBe(false);
    view.destroy();
  });

  it('adds an OPDS source from manage and can open its catalog', async () => {
    const added = { ...source, id: 'source-2', title: '新 OPDS 源', url: 'https://other.example/opds' };
    const addSource = vi.fn(async () => added);
    const listSources = vi.fn(async () => [source, added]);
    const browse = vi.fn(async () => feed());
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, addSource, listSources, browse },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    shownControl(host, '添加 OPDS 源').click();
    const form = sourceFormOf();
    expect(isShown(form)).toBe(true);
    (form.elements.namedItem('title') as HTMLInputElement).value = added.title;
    (form.elements.namedItem('url') as HTMLInputElement).value = added.url;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ title: added.title, url: added.url }));
    if (libraryPage(host) === 'catalog') await openMyBooks(host);
    else if (libraryPage(host) === 'manage') await openMyBooks(host);
    expect(libraryPage(host)).toBe('my-books');
    expect(isShown(host.querySelector('.lightink-library-sources'))).toBe(false);

    await openCatalog(host, added.title);
    expect(libraryPage(host)).toBe('catalog');
    expect(host.textContent).toContain('远程漫画');
    view.destroy();
  });

  it('lets the user change the bounded cache limit on manage', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(isShown(host.querySelector('.lightink-library-cache-summary'))).toBe(false);
    await openManage(host);
    expect(libraryPage(host)).toBe('manage');
    const limitButton = host.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!;
    limitButton.click();
    const form = host.querySelector<HTMLFormElement>('.lightink-library-cache-limit-form')!;
    const input = form.elements.namedItem('cacheLimitGiB') as HTMLInputElement;
    const apply = form.querySelector<HTMLButtonElement>('.lightink-library-primary');
    expect(limitButton.getAttribute('aria-expanded')).toBe('true');
    expect(limitButton.classList.contains('is-open')).toBe(true);
    expect(form.querySelector('label')?.classList.contains('lightink-library-field')).toBe(true);
    expect(apply?.textContent).toBe('应用');
    expect(apply?.type).toBe('submit');
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-library-cache-limit-form\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(
      /\.lightink-library-cache-limit-form[^{]*\.lightink-library-primary\s*\{[^}]*white-space:\s*nowrap/,
    );
    expect(css).not.toMatch(
      /\.lightink-library-cache-limit-form\s*\{[^}]*grid-template-columns:\s*minmax\(150px/,
    );
    input.value = '3.5';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(deps.library.setCacheLimit).toHaveBeenCalledWith(3.5 * 1024 ** 3);
    expect(form.hidden).toBe(true);
    expect(limitButton.getAttribute('aria-expanded')).toBe('false');
    view.destroy();
  });

  it('offers a Markdown editor link on the manage toolbar', async () => {
    const onEnterEditor = vi.fn();
    const deps = dependencies({ onEnterEditor });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(isShown(host.querySelector('.lightink-library-editor-entry'))).toBe(false);
    await openManage(host);
    const editor = shownButtonWithText(host, 'Markdown 编辑');
    expect(host.querySelector('.lightink-library-toolbar')?.contains(editor)).toBe(true);
    editor.click();
    expect(onEnterEditor).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('preserves an existing OPDS credential unless the user changes authentication', async () => {
    const authenticated = { ...source, credentialRef: 'credential-1' };
    const addSource = vi.fn(async () => authenticated);
    const listSources = vi.fn(async () => [authenticated]);
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, addSource, listSources },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 OPDS 源"]')!.click();
    const form = sourceFormOf();
    expect((form.elements.namedItem('auth') as HTMLSelectElement).value).toBe('keep');
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        credentialRef: 'credential-1',
        clearCredential: undefined,
        credential: undefined,
      }),
    );
    view.destroy();
  });

  it('edits an OPDS source and explicitly clears its stored credential', async () => {
    const authenticated = { ...source, credentialRef: 'credential-1' };
    const addSource = vi.fn(async (input) => ({
      ...authenticated,
      title: input.title,
      url: input.url,
      credentialRef: undefined,
    }));
    const listSources = vi
      .fn()
      .mockResolvedValueOnce([authenticated])
      .mockResolvedValueOnce([{ ...authenticated, title: '更新后的书库', credentialRef: undefined }]);
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, addSource, listSources },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 OPDS 源"]')!.click();
    const form = sourceFormOf();
    (form.elements.namedItem('title') as HTMLInputElement).value = '更新后的书库';
    (form.elements.namedItem('auth') as HTMLSelectElement).value = 'none';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'source-1',
        title: '更新后的书库',
        credentialRef: undefined,
        clearCredential: true,
      }),
    );
    view.destroy();
  });

  it('switches source, pages, searches, opens an item, and supports keyboard navigation', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(host.textContent).toContain('本地小说');
    await openCatalog(host);
    expect(libraryPage(host)).toBe('catalog');
    expect(deps.opds.browse).toHaveBeenCalledWith('source-1', undefined);
    expect(host.textContent).toContain('远程漫画');
    expect(host.querySelector('.lightink-library-item--row')).not.toBeNull();

    shownButtonWithText(host, '下一页').click();
    await settle();
    expect(deps.opds.browse).toHaveBeenCalledWith(
      'source-1',
      'https://books.example/opds?page=2',
    );

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫画';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(deps.opds.search).toHaveBeenCalledWith('source-1', '漫画');

    const list = host.querySelector<HTMLElement>('.lightink-library-items')!;
    list.focus();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: 'item-1' }),
        acquisition: expect.objectContaining({ href: 'https://books.example/book.cbz' }),
        source,
      }),
      expect.anything(),
    );
    expect(view.visible).toBe(false);
  });

  it('renders OPDS 2 groups and opens grouped navigation entries', async () => {
    const groupedBook: OpdsEntry = {
      ...entry,
      id: 'group-book',
      itemId: 'group-book-item',
      title: '分组内图书',
    };
    const groupedNavigation: OpdsEntry = {
      id: 'group-navigation',
      itemId: 'group-navigation-item',
      title: '更多小说',
      authors: [],
      links: [],
      kind: 'navigation',
      navigationUrl: 'https://books.example/opds/fiction',
    };
    const browse = vi
      .fn()
      .mockResolvedValueOnce(
        feed({
          format: 'opds2',
          groups: [
            {
              title: '小说',
              publications: [groupedBook],
              navigation: [groupedNavigation],
            },
          ],
        }),
      )
      .mockResolvedValue(feed());
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(host.querySelector('.lightink-library-opds-group-title')?.textContent).toBe('小说');
    expect(host.textContent).toContain('分组内图书');
    itemRow(host, 'group-navigation-item').click();
    await settle();
    expect(browse).toHaveBeenLastCalledWith(
      'source-1',
      'https://books.example/opds/fiction',
    );
    view.destroy();
  });

  it('exposes a retry action after an offline browse failure', async () => {
    const browse = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(feed());
    const deps = dependencies({ opds: { ...dependencies().opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(host.textContent).toContain('offline');
    shownButtonWithText(host, '重试').click();
    await settle();
    expect(browse).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('远程漫画');
  });

  it('gives catalog a full-width body instead of the source sidebar column', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    const root = libraryRoot(host);
    const body = root.querySelector('.lightink-library-body');
    expect(root.dataset.libraryPage).toBe('catalog');
    expect(root.classList.contains('lightink-library--catalog')).toBe(true);
    expect(body?.children).toHaveLength(1);
    expect(body?.firstElementChild?.classList.contains('lightink-library-content')).toBe(true);
    expect(body?.querySelector('.lightink-library-sources')).toBeNull();
    expect(body?.querySelector('.lightink-library-groups')).toBeNull();
    expect(host.textContent).toContain('远程漫画');

    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).not.toMatch(/--lightink-reader-/);
    expect(css).not.toMatch(/--lightink-measure/);
    expect(css).not.toMatch(/--lightink-page-pad/);
    const [baseCss, narrowCss = ''] = css.split('@media (max-width: 760px)');
    expect(baseCss).toMatch(
      /\[data-library-page='catalog'\] \.lightink-library-body[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(narrowCss).toMatch(
      /\[data-library-page='catalog'\] \.lightink-library-body[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    view.destroy();
  });

  it('does not project progress onto unopened OPDS catalog entries', async () => {
    const getProgress = vi.fn((_item, options) =>
      options?.catalogEntry === true
        ? null
        : { status: 'in-progress' as const, unit: 'page' as const, index: 9, ratio: 0, percent: 88 },
    );
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    getProgress.mockClear();
    await openCatalog(host);
    expect(libraryPage(host)).toBe('catalog');

    expect(getProgress).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-1' }),
      { catalogEntry: true },
    );
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).not.toContain('已读');
    expect(host.textContent).not.toContain('%');
    expect(host.querySelector('[data-progress-status]')).toBeNull();
    expect(host.querySelector('.lightink-library-item-progress')).toBeNull();
    view.destroy();
  });

  it('shows real catalog progress only when the projection returns in-progress', async () => {
    const getProgress = vi.fn(() => ({
      status: 'in-progress' as const,
      unit: 'page' as const,
      index: 12,
      ratio: 0,
      percent: 30,
    }));
    const deps = dependencies({ getProgress });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);

    const row = itemRow(host, 'item-1');
    expect(row.dataset.progressStatus).toBe('in-progress');
    expect(row.textContent).toContain('第 12 页');
    expect(row.textContent).toContain('已读 30%');
    view.destroy();
  });

  it('renders bindLibraryProgress records with unit/index, not a locationKind adapter', async () => {
    const store: Record<string, string> = {};
    const storage: ProgressStorage = {
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => {
        store[key] = value;
      },
    };
    const unread = localItem();
    const comicPath = '/comics/bound.cbz';
    const comic = comicItem({
      id: 'local:/comics/bound.cbz',
      title: '续读漫画',
      localPath: comicPath,
      pageCount: 40,
    });
    saveReadingProgress(storage, comicPath, {
      version: 1,
      kind: 'page',
      index: 12,
      ratio: 0,
      updatedAt: 1,
    });
    saveLibraryProgressAlias(storage, comic.id, comicPath);
    const base = dependencies();
    const deps = dependencies({
      getProgress: bindLibraryProgress(storage),
      library: {
        ...base.library,
        listItems: vi.fn(async () => [unread, comic]),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const unreadRow = itemRow(host, unread.id);
    const comicRow = itemRow(host, comic.id);
    expect(unreadRow.dataset.progressStatus).toBe('not-started');
    expect(unreadRow.textContent).toContain('未开始');
    expect(unreadRow.textContent).not.toContain('0%');
    expect(comicRow.dataset.progressStatus).toBe('in-progress');
    expect(comicRow.textContent).toContain('第 12 页');
    expect(comicRow.textContent).toContain('已读 30%');

    await openCatalog(host);
    expect(host.textContent).toContain('远程漫画');
    expect(host.querySelector('[data-item-id="item-1"]')?.textContent).not.toContain('已读');
    expect(
      host.querySelector<HTMLElement>('[data-item-id="item-1"]')?.dataset.progressStatus,
    ).toBeUndefined();
    view.destroy();
  });
});

describe('LibraryView shelf collections', () => {
  const seriesStem = '地狱模式';

  function seriesNovel(overrides: Partial<LibraryItem> = {}): LibraryItem {
    return localItem({
      id: 'local:/ebook/hell-01.epub',
      title: `${seriesStem} - 01`,
      authors: ['海猫'],
      localPath: '/ebook/文库版/地狱模式 - 01.epub',
      extension: 'epub',
      ...overrides,
    });
  }

  it('keeps the five shelf filters as non-editable filters when collections exist', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await organizeShelf(host);

    for (const [label, shelfGroup] of [
      ['全部', 'all'],
      ['在读', 'in-progress'],
      ['未读', 'unread'],
      ['文字书', 'text'],
      ['漫画', 'comic'],
    ] as const) {
      const filter = groupButton(host, label);
      expect(filter.dataset.shelfGroup).toBe(shelfGroup);
      expect(filter.dataset.libraryGroupId).toBeUndefined();
      expect(filter.closest('.lightink-library-filter-list')).not.toBeNull();
      expect(filter.closest('.lightink-library-group-list')).toBeNull();
      filter.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
      );
      await settle();
      expect(document.querySelector('.lightink-context-menu')).toBeNull();
    }

    expect(() => collectionButton(host, '海猫')).toThrow(/collection button not found/);
    expect(() => collectionButton(host, '系列')).toThrow(/collection button not found/);
    expect(() => collectionButton(host, '作者')).toThrow(/collection button not found/);

    groupButton(host, '文字书').click();
    await settle();
    expect(itemRow(host, novel.id).textContent).toContain(`${seriesStem} - 01`);
    groupButton(host, '漫画').click();
    await settle();
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();
    groupButton(host, '未读').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    view.destroy();
  });

  it('hides metadata smart groups and opens a page-level new-group dialog', async () => {
    const novel = seriesNovel({
      authors: ['ハム男', '藻'],
      localPath: '/ebook/藻 - 01.epub',
    });
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: '藻' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await organizeShelf(host);

    for (const name of ['藻', 'ハム男', '系列', '作者', '文字书']) {
      expect(() => collectionButton(host, name)).toThrow(/collection button not found/);
    }

    await startCreateGroup(host);
    const editor = groupFormOf();
    expect(libraryRoot(host).contains(editor)).toBe(true);
    expect(editor.hidden).toBe(false);
    expect(isShown(editor)).toBe(true);
    expect(editor.elements.namedItem('groupName')).toBeInstanceOf(HTMLInputElement);
    view.destroy();
  });

  it('creates a nested user collection and keeps a book in more than one collection', async () => {
    const novel = seriesNovel();
    const { deps, library } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await startCreateGroup(host);
    await submitGroupForm(host, { name: '作者' });
    expect(library.createGroup).toHaveBeenCalledWith('作者', undefined);
    const parentId =
      collectionButton(host, '作者').dataset.libraryGroupId ??
      collectionButton(host, '作者').dataset.groupId;

    await startCreateGroup(host);
    await submitGroupForm(host, { name: '海猫', parentId });
    expect(library.createGroup).toHaveBeenCalledWith('海猫', parentId);
    const listed = await library.listGroups!();
    expect(listed.find((group) => group.name === '海猫')?.parentId).toBe(parentId);
    const childWrap = collectionButton(host, '海猫').closest('.lightink-library-custom-group');
    const parentWrap = collectionButton(host, '作者').closest('.lightink-library-custom-group');
    expect(childWrap instanceof HTMLElement ? childWrap.dataset.groupDepth : undefined).not.toBe(
      parentWrap instanceof HTMLElement ? parentWrap.dataset.groupDepth : undefined,
    );

    await startCreateGroup(host);
    await submitGroupForm(host, { name: '某系列' });

    expect(itemCard(host, novel.id).textContent).not.toContain('加入分组');
    await addItemToCollection(host, novel.id, '海猫');
    await addItemToCollection(host, novel.id, '某系列');

    const authorGroupId =
      collectionButton(host, '海猫').dataset.libraryGroupId ??
      collectionButton(host, '海猫').dataset.groupId;
    const seriesGroupId =
      collectionButton(host, '某系列').dataset.libraryGroupId ??
      collectionButton(host, '某系列').dataset.groupId;
    expect(library.setGroupMember).toHaveBeenCalledWith(authorGroupId, novel.id, true);
    expect(library.setGroupMember).toHaveBeenCalledWith(seriesGroupId, novel.id, true);

    collectionButton(host, '海猫').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    collectionButton(host, '某系列').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();

    const menu = await openItemMenu(host, novel.id);
    expect(menu.textContent).toContain('✓ 海猫');
    expect(menu.textContent).toContain('✓ 某系列');
    expect(menu.textContent).toContain('新建分组');
    expect(itemCard(host, novel.id).textContent).not.toContain('加入分组');
    view.destroy();
  });

  it('creates a collection from the cover context menu when none exist', async () => {
    const novel = seriesNovel();
    const { deps, library } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(itemCard(host, novel.id).textContent).not.toContain('加入分组');
    const menu = await openItemMenu(host, novel.id);
    expect(menu.textContent).toContain('加入分组');
    contextMenuItem('加入分组').click();
    await waitForShown(
      () => {
        const editor = document.querySelector<HTMLFormElement>('.lightink-library-group-editor');
        return editor !== null && !editor.hidden;
      },
      'create-group form not found',
    );
    await submitGroupForm(host, { name: '稍后读' });
    expect(library.createGroup).toHaveBeenCalledWith('稍后读', undefined);
    expect(library.setGroupMember).toHaveBeenCalled();
    view.destroy();
  });

  it('keeps the book on the cover wall after a collection is deleted', async () => {
    const novel = seriesNovel();
    const { deps, library } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await startCreateGroup(host);
    await submitGroupForm(host, { name: '临时组' });
    await startCreateGroup(host);
    await submitGroupForm(host, { name: '保留组' });
    await addItemToCollection(host, novel.id, '临时组');
    await addItemToCollection(host, novel.id, '保留组');

    const removedId =
      collectionButton(host, '临时组').dataset.libraryGroupId ??
      collectionButton(host, '临时组').dataset.groupId;
    shownControl(collectionRow(host, '临时组'), '分组操作: 临时组').click();
    await settle();
    shownControl(collectionRow(host, '临时组'), '删除分组').click();
    await settle();

    expect(library.deleteGroup).toHaveBeenCalledWith(removedId);
    expect(library.removeItem).not.toHaveBeenCalled();
    expect(() => collectionButton(host, '临时组')).toThrow(/collection button not found/);
    groupButton(host, '全部').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    collectionButton(host, '保留组').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    view.destroy();
  });

  it('does not show metadata smart groups in the sidebar', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(() => collectionButton(host, '海猫')).toThrow(/collection button not found/);
    expect(() => collectionButton(host, seriesStem)).toThrow(/collection button not found/);
    expect(host.querySelector('.lightink-library-smart-group')).toBeNull();
    groupButton(host, '文字书').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    view.destroy();
  });

  it('can rename a user collection', async () => {
    const novel = seriesNovel();
    const { deps, library } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await startCreateGroup(host);
    await submitGroupForm(host, { name: seriesStem });
    const seriesId =
      collectionButton(host, seriesStem).dataset.libraryGroupId ??
      collectionButton(host, seriesStem).dataset.groupId;

    shownControl(collectionRow(host, seriesStem), `分组操作: ${seriesStem}`).click();
    await settle();
    shownControl(collectionRow(host, seriesStem), '重命名分组').click();
    await settle();
    await submitGroupForm(host, { name: '地狱系列' });
    expect(library.updateGroup).toHaveBeenCalledWith(seriesId, '地狱系列');
    const listed = await library.listGroups!();
    expect(listed.find((group) => group.id === seriesId)).toMatchObject({
      name: '地狱系列',
      kind: 'custom',
    });
    view.destroy();
  });

  it('does not treat a filename series as comic metadata on the cover wall', async () => {
    const novel = seriesNovel();
    expect(novel.series).toBeUndefined();
    expect(classifyLibraryKind(novel)).toBe('text');
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await organizeShelf(host);

    const row = itemRow(host, novel.id);
    expect(row.dataset.bookKind).toBe('text');
    expect(row.textContent).toContain(`${seriesStem} - 01`);
    groupButton(host, '文字书').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    groupButton(host, '漫画').click();
    await settle();
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();
    expect(() => collectionButton(host, seriesStem)).toThrow(/collection button not found/);
    view.destroy();
  });
});
