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
import { OPEN_PROGRESS_APPEAR_MS } from '../../ui/open-progress.js';
import { createLibraryView, type LibraryViewDependencies } from '../library-view.js';
import {
  type LibraryGroup,
  type LibraryGroupMembership,
  type LibraryItem,
} from '../library-client.js';
import type { OpdsEntry, OpdsFeed, OpdsSource } from '../opds-client.js';
import type { WebDavSource } from '../webdav-source-client.js';
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

function webDavSource(overrides: Partial<WebDavSource> = {}): WebDavSource {
  return {
    id: 'webdav-1',
    title: '漫画柜',
    url: 'https://dav.example/remote.php/dav',
    allowHttp: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const webdav: OpdsSource = {
  id: 'webdav-1',
  title: 'Nextcloud',
  url: 'https://dav.example/remote.php/dav',
  allowHttp: false,
  createdAt: 1,
  updatedAt: 1,
};

function webdavSourceClient(
  overrides: Partial<NonNullable<LibraryViewDependencies['webdavSource']>> = {},
): NonNullable<LibraryViewDependencies['webdavSource']> {
  return {
    addSource: vi.fn(async () => webdav),
    listSources: vi.fn(async () => [webdav]),
    removeSource: vi.fn(async () => undefined),
    browse: vi.fn(async () => feed({ title: webdav.title, sourceUrl: webdav.url })),
    test: vi.fn(async () => ({ ok: true, finalUrl: webdav.url })),
    ...overrides,
  };
}

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
    webdavSource: {
      addSource: vi.fn(async (input) =>
        webDavSource({
          title: input.title,
          url: input.url,
          allowHttp: input.allowHttp ?? false,
          credentialRef: input.credential !== undefined ? 'webdav-source-webdav-1' : undefined,
        }),
      ),
      listSources: vi.fn(async () => []),
      removeSource: vi.fn(async () => undefined),
      browse: vi.fn(async () => feed()),
      test: vi.fn(async () => ({ ok: true, finalUrl: 'https://dav.example/remote.php/dav' })),
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

function libraryNav(host: ParentNode): HTMLElement {
  const root = libraryRoot(host);
  const nav =
    root.querySelector<HTMLElement>('.lightink-library-nav') ??
    root.querySelector<HTMLElement>('.lightink-library-navpane') ??
    root.querySelector<HTMLElement>('.lightink-library-sidebar') ??
    root.querySelector<HTMLElement>('[data-library-nav]') ??
    root.querySelector<HTMLElement>('aside');
  if (!(nav instanceof HTMLElement)) throw new Error('library navigation not found');
  return nav;
}

function navButton(host: ParentNode, label: string): HTMLButtonElement {
  const nav = libraryNav(host);
  const candidate = Array.from(nav.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label && isShown(button),
  );
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`nav item not found: ${label}`);
  return candidate;
}

function navItemActive(button: HTMLButtonElement): boolean {
  return button.getAttribute('aria-current') !== null || button.classList.contains('is-active');
}

function catalogCoverWallShown(host: ParentNode): boolean {
  const wall = host.querySelector('.lightink-library-cover-wall');
  return wall instanceof HTMLElement && isShown(wall);
}

function catalogDefaultRowsShown(host: ParentNode): boolean {
  const wall = host.querySelector('.lightink-library-cover-wall');
  const scope = wall instanceof HTMLElement ? wall : host;
  const row = scope.querySelector('.lightink-library-item--row');
  return row instanceof HTMLElement && isShown(row);
}

function shelfFilterShown(host: ParentNode, label: string): boolean {
  const groups = host.querySelector('.lightink-library-groups');
  if (!(groups instanceof HTMLElement) || groups.hidden || groups.closest('[hidden]') !== null) {
    return false;
  }
  return Array.from(groups.querySelectorAll<HTMLButtonElement>('[data-shelf-group]')).some(
    (button) => {
      const text = button.textContent?.replace(/\s+/g, ' ').trim();
      return (text === label || text?.endsWith(label) === true) && isShown(button);
    },
  );
}

function backToShelfControl(host: ParentNode): HTMLButtonElement {
  const dedicated = Array.from(
    host.querySelectorAll<HTMLButtonElement>('.lightink-library-back-to-shelf'),
  ).find((button) => isShown(button));
  if (dedicated !== undefined) return dedicated;
  return shownControl(host, '返回书架');
}

function catalogTreeNode(host: ParentNode, title: string): HTMLElement {
  const nav = libraryNav(host);
  const clickable = Array.from(
    nav.querySelectorAll<HTMLElement>('button, [role="treeitem"], [data-catalog-node]'),
  ).find((element) => element.textContent?.trim() === title && isShown(element));
  if (clickable !== undefined) return clickable;
  return navButton(host, title);
}

function navigationEntry(
  overrides: Partial<OpdsEntry> & Pick<OpdsEntry, 'id' | 'itemId' | 'title' | 'navigationUrl'>,
): OpdsEntry {
  return {
    authors: [],
    links: [],
    kind: 'navigation',
    ...overrides,
  };
}

function smartGroupButton(host: ParentNode, name: string): HTMLButtonElement {
  const marked = Array.from(
    host.querySelectorAll<HTMLButtonElement>('.lightink-library-smart-group, [data-smart-group-id]'),
  ).find((button) => button.textContent?.trim() === name && isShown(button));
  if (marked !== undefined) return marked;
  const fallback = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) =>
      button.textContent?.trim() === name &&
      isShown(button) &&
      button.dataset.shelfGroup === undefined &&
      button.dataset.libraryGroupId === undefined &&
      button.dataset.groupId === undefined,
  );
  if (!(fallback instanceof HTMLButtonElement)) {
    throw new Error(`smart group nav item not found: ${name}`);
  }
  return fallback;
}

function navSectionToggle(host: ParentNode, section: string): HTMLButtonElement {
  const toggle = host.querySelector(`[data-nav-toggle="${section}"]`);
  if (!(toggle instanceof HTMLButtonElement)) {
    throw new Error(`nav section toggle not found: ${section}`);
  }
  return toggle;
}

function expandNavSection(host: ParentNode, section: string): void {
  const toggle = navSectionToggle(host, section);
  if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
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
  const within = Array.from(groups.querySelectorAll('button')).find(
    (button) => button.textContent === label && isShown(button),
  );
  if (within instanceof HTMLButtonElement) return within;
  return shownButtonWithText(host, label);
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
    host.querySelector<HTMLFormElement>('.lightink-library-group-modal .lightink-library-group-form') ??
    document.querySelector<HTMLFormElement>(
      '.lightink-library-group-modal .lightink-library-group-form',
    );
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

function touchAt(type: string, point: { clientX: number; clientY: number } | null): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = point === null ? [] : [point];
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
  Object.defineProperty(event, 'changedTouches', { value: points });
  return event;
}

async function waitLongPress(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 550));
}

async function tryOpenItemMenu(host: HTMLElement, itemId: string): Promise<HTMLElement | null> {
  const card = itemCard(host, itemId);
  card.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
  );
  await settle();
  const afterClick = document.querySelector('.lightink-context-menu');
  if (afterClick instanceof HTMLElement) return afterClick;
  card.dispatchEvent(touchAt('touchstart', { clientX: 20, clientY: 20 }));
  await waitLongPress();
  card.dispatchEvent(touchAt('touchend', null));
  await settle();
  const afterPress = document.querySelector('.lightink-context-menu');
  return afterPress instanceof HTMLElement ? afterPress : null;
}

function detailShowsRemove(host: ParentNode): boolean {
  const pane = host.querySelector('.lightink-library-detail');
  if (!(pane instanceof HTMLElement) || !isShown(pane)) return false;
  return Array.from(pane.querySelectorAll('button')).some(
    (button) => (button.textContent ?? '').includes('移出书库') && isShown(button),
  );
}

function navWidthToken(host: ParentNode): string {
  return libraryRoot(host).style.getPropertyValue('--lightink-library-nav-width').trim();
}

function persistedNavWidth(store: Record<string, string>): string {
  const preferred = store['lightink.library.navWidth'];
  if (preferred !== undefined && preferred !== '') return preferred;
  const fallback = Object.entries(store).find(
    ([key, value]) => /navWidth|nav-width|sidebarWidth|navSize/i.test(key) && value !== '',
  );
  if (fallback === undefined) {
    throw new Error('themeStorage did not record a nav width (expected lightink.library.navWidth)');
  }
  return fallback[1];
}

function resizeHandle(host: ParentNode): HTMLElement {
  const handle = host.querySelector<HTMLElement>('.lightink-library-nav-resize');
  if (!(handle instanceof HTMLElement)) throw new Error('nav resize handle not found');
  return handle;
}

function pointerAt(type: string, clientX: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX,
    clientY: 40,
    pointerId: 1,
    pointerType: 'mouse',
  });
}

function stubPointerCapture(handle: HTMLElement): void {
  if (typeof handle.setPointerCapture !== 'function') {
    Object.defineProperty(handle, 'setPointerCapture', { value: () => undefined, configurable: true });
  } else {
    handle.setPointerCapture = () => undefined;
  }
  if (typeof handle.releasePointerCapture !== 'function') {
    Object.defineProperty(handle, 'releasePointerCapture', {
      value: () => undefined,
      configurable: true,
    });
  } else {
    handle.releasePointerCapture = () => undefined;
  }
}

function dragNavResize(handle: HTMLElement, fromX: number, toX: number): void {
  stubPointerCapture(handle);
  handle.dispatchEvent(pointerAt('pointerdown', fromX));
  handle.dispatchEvent(pointerAt('pointermove', toX));
  handle.dispatchEvent(pointerAt('pointerup', toX));
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
    host.querySelector<HTMLButtonElement>('.lightink-library-cache-entry') ??
    host.querySelector<HTMLButtonElement>('[data-library-nav-item="cache"]') ??
    Array.from(host.querySelectorAll('button')).find(
      (button) =>
        (button.textContent?.trim() === '管理' || button.textContent?.trim() === '缓存') &&
        isShown(button),
    );
  if (!(entry instanceof HTMLButtonElement) || !isShown(entry)) {
    throw new Error('manage entry is not reachable from the navigation');
  }
  entry.click();
  await settle();
}

async function openMyBooks(host: HTMLElement): Promise<void> {
  // 「全部」快捷过滤即书库主页（原独立「我的书」导航项已与其合并）
  const navEntry = Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === '全部' && isShown(button),
  );
  const target = navEntry instanceof HTMLButtonElement ? navEntry : undefined;
  if (target === undefined) {
    // 已停留在封面墙时无需再导航
    if (host.querySelector('.lightink-library-item--cover') !== null) return;
    throw new Error('my-books entry not found');
  }
  target.click();
  await settle();
}

async function openSources(host: HTMLElement): Promise<void> {
  // 源列表可能常驻导航（无需点击），也可能需要先选中「书源」导航项
  const entry = Array.from(host.querySelectorAll('button')).find(
    (button) =>
      (button.textContent?.trim() === '书源' || button.textContent?.trim() === '书库源') &&
      isShown(button),
  );
  if (entry instanceof HTMLButtonElement) {
    entry.click();
    await settle();
  }
}

async function openCatalog(host: HTMLElement, sourceTitle = '测试书库'): Promise<void> {
  const listed = Array.from(host.querySelectorAll('button')).some(
    (button) => button.textContent?.trim() === sourceTitle && isShown(button),
  );
  if (!listed) await openSources(host);
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
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-android');
  document.documentElement.removeAttribute('data-touch-primary');
  delete document.documentElement.dataset.readerProgressBar;
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

    expect(navItemActive(navButton(host, '全部'))).toBe(true);
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
    expect(comicRow.dataset.progressFill).toBe('37');
    expect(comicRow.style.getPropertyValue('--lightink-library-progress-fill')).toBe('37%');
    expect(unreadRow.dataset.progressFill).toBeUndefined();
    expect(comicRow.textContent).toContain('第 12 页');
    expect(comicRow.textContent).toContain('已读 37%');
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    view.destroy();
  });

  it('puts a quick-import tile at the end of the local cover wall', async () => {
    const book = localItem();
    const imported = localItem({
      id: 'local:/books/new.epub',
      title: '新导入的书',
      localPath: '/books/new.epub',
    });
    let items = [book];
    const onImportLocal = vi.fn(async () => imported);
    const base = dependencies();
    const deps = dependencies({
      onImportLocal,
      library: {
        ...base.library,
        listItems: vi.fn(async () => items),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const tiles = Array.from(host.querySelectorAll('.lightink-library-item'));
    const importTile = host.querySelector<HTMLButtonElement>('.lightink-library-item--import');
    expect(importTile).not.toBeNull();
    expect(importTile?.getAttribute('aria-label')).toBe('导入本地书籍');
    expect(importTile?.title).toBe('导入本地书籍');
    expect(importTile?.textContent?.trim()).toBe('');
    expect(tiles[tiles.length - 1]).toBe(importTile);
    expect((tiles[0] as HTMLElement | undefined)?.dataset.itemId).toBe(book.id);

    items = [book, imported];
    importTile!.click();
    await settle();
    expect(onImportLocal).toHaveBeenCalledTimes(1);
    expect(itemRow(host, imported.id).textContent).toContain('新导入的书');
    expect(host.querySelector('.lightink-library-item--import')).not.toBeNull();
    view.destroy();
  });

  it('keeps the import tile on an empty shelf and hides it while searching or browsing a catalog', async () => {
    const onImportLocal = vi.fn(async () => null);
    const base = dependencies();
    const deps = dependencies({
      onImportLocal,
      library: { ...base.library, listItems: vi.fn(async () => []) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(host.querySelector('.lightink-library-item--import')).not.toBeNull();
    expect(host.querySelector('.lightink-library-empty')).toBeNull();

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '河山';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(host.querySelector('.lightink-library-item--import')).toBeNull();

    shownControl(host, '清除').click();
    await settle();
    expect(host.querySelector('.lightink-library-item--import')).not.toBeNull();

    await openCatalog(host);
    expect(host.querySelector('.lightink-library-item--import')).toBeNull();
    expect(itemRow(host, 'item-1').textContent).toContain('远程漫画');
    view.destroy();
  });

  it('keeps the empty local shelf when listing sources or items fails', async () => {
    const base = dependencies();
    const deps = dependencies({
      opds: {
        ...base.opds,
        listSources: vi.fn(async () => {
          throw new Error('error sending request');
        }),
      },
      library: {
        ...base.library,
        listItems: vi.fn(async () => {
          throw new Error('IPC plugin not found');
        }),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(host.textContent).not.toContain('无法连接此书库源。');
    expect(host.querySelector('.lightink-library-item--import')).not.toBeNull();
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === '重试' && isShown(button),
      ),
    ).toBe(false);
    view.destroy();
  });

  it('keeps manage content, close, and detail off the first screen while nav entries stay reachable', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(navItemActive(navButton(host, '全部'))).toBe(true);
    expect(isShown(host.querySelector('.lightink-library-cache-summary'))).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    expect(isShown(host.querySelector('[aria-label="关闭书库"]'))).toBe(false);
    // 管理内容（导入等）在选中管理导航项前不呈现
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === '导入本地书籍' && isShown(button),
      ),
    ).toBe(false);
    // 管理导航项在首屏导航内可达
    const manageEntry =
      host.querySelector('.lightink-library-manage-entry') ??
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === '管理' && isShown(button),
      );
    expect(manageEntry instanceof HTMLElement && isShown(manageEntry)).toBe(true);
    // 书库区的分组树随首屏导航可见
    expect(isShown(host.querySelector('.lightink-library-groups'))).toBe(true);
    expect(host.querySelector('.lightink-library-search')).not.toBeNull();
    const shelfTitle = host.querySelector<HTMLHeadingElement>('.lightink-library-header h1');
    expect(shelfTitle?.hidden).toBe(true);
    expect(host.textContent).not.toContain('我的书');
    expect(host.querySelector('.lightink-library-brand')?.textContent).toBe('轻墨');
    view.destroy();
  });

  it('filters the cover wall as the user types and can clear the query', async () => {
    const novel = localItem({ title: '续读小说' });
    const other = localItem({
      id: 'local:/books/other.epub',
      title: '河山记',
      localPath: '/books/other.epub',
    });
    const deps = dependencies({
      library: { ...dependencies().library, listItems: vi.fn(async () => [novel, other]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '河山';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();
    expect(itemRow(host, other.id)).toBeTruthy();
    expect(host.querySelector<HTMLButtonElement>('.lightink-library-search-clear')?.hidden).toBe(
      false,
    );

    shownControl(host, '清除').click();
    await settle();
    expect(input.value).toBe('');
    expect(itemRow(host, novel.id)).toBeTruthy();
    expect(itemRow(host, other.id)).toBeTruthy();
    expect(host.querySelector<HTMLButtonElement>('.lightink-library-search-clear')?.hidden).toBe(
      true,
    );
    view.destroy();
  });

  it('explains an empty filter instead of pretending the library has no books', async () => {
    const unread = localItem();
    const deps = dependencies({
      getProgress: () => ({ status: 'not-started' as const }),
      library: { ...dependencies().library, listItems: vi.fn(async () => [unread]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    groupButton(host, '在读').click();
    await settle();
    expect(host.querySelector('.lightink-library-empty')?.textContent).toBe('这一组还没有作品');
    expect(host.querySelector(`[data-item-id="${unread.id}"]`)).toBeNull();
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
    const manageEntry =
      host.querySelector('.lightink-library-manage-entry') ??
      host.querySelector('.lightink-library-cache-entry') ??
      host.querySelector('[data-library-nav-item="cache"]');
    expect(manageEntry instanceof HTMLElement && isShown(manageEntry)).toBe(true);

    await openManage(host);
    // 管理区内容随导航一次点击呈现
    shownButtonWithText(host, '导入本地书籍');
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

  it('keeps the painted cover wall while the shelf reloads', async () => {
    const book = localItem();
    let resolveReload: ((items: LibraryItem[]) => void) | undefined;
    const listItems = vi
      .fn()
      .mockResolvedValueOnce([book])
      .mockImplementationOnce(
        () =>
          new Promise<LibraryItem[]>((resolve) => {
            resolveReload = resolve;
          }),
      );
    const base = dependencies();
    const deps = dependencies({
      library: { ...base.library, listItems },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    expect(itemRow(host, book.id)).toBeTruthy();
    expect(isShown(host.querySelector('.lightink-library-status'))).toBe(false);

    const reloading = view.show();
    await settle();
    expect(itemRow(host, book.id)).toBeTruthy();
    expect(isShown(host.querySelector('.lightink-library-status'))).toBe(false);
    expect(host.textContent).not.toContain('正在加载…');

    resolveReload?.([book]);
    await reloading;
    expect(isShown(host.querySelector('.lightink-library-status'))).toBe(false);
    expect(itemRow(host, book.id)).toBeTruthy();
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
    expect(host.querySelector('.lightink-library-content .lightink-library-shelf-chips')).toBeNull();

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

  it('shows an open-progress overlay while a book is opening and removes it after', async () => {
    let finishOpen!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const onOpen = vi.fn(async () => pending);
    const unread = localItem({ coverUrl: 'https://covers.example/novel.jpg' });
    const deps = dependencies({
      onOpen,
      library: { ...dependencies().library, listItems: vi.fn(async () => [unread]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    itemRow(host, unread.id).querySelector('.lightink-library-cover')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await settle();
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
    await vi.waitFor(
      () => {
        expect(document.querySelector('.lightink-open-progress')).not.toBeNull();
      },
      { timeout: OPEN_PROGRESS_APPEAR_MS + 500 },
    );
    const overlay = document.querySelector<HTMLElement>('.lightink-open-progress');
    expect(overlay?.textContent).toContain('正在打开');
    expect(overlay?.querySelector('[role="progressbar"]')).not.toBeNull();

    finishOpen();
    await settle();
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
    view.destroy();
  });

  it('uses the catalog acquisition size when download progress omits Content-Length', async () => {
    let reportProgress: ((progress: { phase: 'download' | 'open'; loaded?: number; total?: number }) => void) | undefined;
    let finishOpen!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const onOpen = vi.fn(async (request: { onProgress?: typeof reportProgress }) => {
      reportProgress = request.onProgress;
      await pending;
    });
    const sized = {
      ...entry,
      links: [{ ...entry.links[0]!, size: 1000 }],
    };
    const base = dependencies();
    const deps = dependencies({
      onOpen,
      opds: { ...base.opds, browse: vi.fn(async () => feed({ entries: [sized] })) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    itemRow(host, 'item-1').click();
    await settle();
    shownButtonWithText(host.querySelector('.lightink-library-detail')!, '打开阅读').click();
    await settle();
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
    await vi.waitFor(
      () => {
        expect(document.querySelector('.lightink-open-progress')).not.toBeNull();
      },
      { timeout: OPEN_PROGRESS_APPEAR_MS + 500 },
    );
    const overlay = document.querySelector<HTMLElement>('.lightink-open-progress');
    expect(overlay?.dataset.progressDeterminate).toBe('true');
    expect(overlay?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');

    reportProgress?.({ phase: 'download', loaded: 250 });
    expect(overlay?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    expect(overlay?.textContent).toContain('25%');

    finishOpen();
    await settle();
    view.destroy();
  });

  it('aborts the open when the delayed progress overlay is cancelled', async () => {
    let operationSignal: AbortSignal | undefined;
    const onOpen = vi.fn(
      async (_request: unknown, signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
          operationSignal = signal;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const unread = localItem({ coverUrl: 'https://covers.example/novel.jpg' });
    const deps = dependencies({
      onOpen,
      library: { ...dependencies().library, listItems: vi.fn(async () => [unread]) },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    itemRow(host, unread.id).querySelector('.lightink-library-cover')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await settle();
    await vi.waitFor(
      () => {
        expect(document.querySelector('.lightink-open-progress-cancel')).not.toBeNull();
      },
      { timeout: OPEN_PROGRESS_APPEAR_MS + 500 },
    );
    document.querySelector<HTMLButtonElement>('.lightink-open-progress-cancel')!.click();
    await settle();

    expect(operationSignal?.aborted).toBe(true);
    expect(document.querySelector('.lightink-open-progress')).toBeNull();
    expect(deps.notify).not.toHaveBeenCalled();
    view.destroy();
  });

  it('opens a persisted OPDS shelf book from its stored acquisition URL', async () => {
    const remote: LibraryItem = {
      id: 'opds:source-1:book-12',
      sourceId: 'source-1',
      sourceKind: 'opds',
      title: '远程小说',
      authors: [],
      acquisitionUrl: 'https://books.example/get/EPUB/12',
      mediaType: 'application/epub+zip',
      extension: 'epub',
      availability: 'remote',
      updatedAt: 1,
    };
    const deps = dependencies({
      library: {
        ...dependencies().library,
        listItems: vi.fn(async () => [remote]),
        listAcquisitionLinks: vi.fn(async () => []),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    itemRow(host, remote.id).click();
    await settle();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: remote.id }),
        acquisition: expect.objectContaining({ href: 'https://books.example/get/EPUB/12' }),
        source: { url: source.url, allowHttp: source.allowHttp },
      }),
      expect.anything(),
    );
    view.destroy();
  });

  it('opens a persisted WebDAV shelf book from its stored acquisition URL', async () => {
    const remote: LibraryItem = {
      id: 'webdav-item-1',
      sourceId: 'webdav-1',
      sourceKind: 'webdav',
      title: 'One Piece 01.cbz',
      authors: [],
      acquisitionUrl: 'https://dav.example/remote.php/dav/books/One%20Piece%2001.cbz',
      mediaType: 'application/vnd.comicbook+zip',
      extension: 'cbz',
      availability: 'remote',
      updatedAt: 1,
    };
    const authenticated = { ...webdav, credentialRef: 'webdav-source-webdav-1' };
    const deps = dependencies({
      webdavSource: webdavSourceClient({
        listSources: vi.fn(async () => [authenticated]),
      }),
      library: {
        ...dependencies().library,
        listItems: vi.fn(async () => [remote]),
        listAcquisitionLinks: vi.fn(async () => []),
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    itemRow(host, remote.id).click();
    await settle();
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: remote.id, sourceKind: 'webdav' }),
        acquisition: expect.objectContaining({ href: remote.acquisitionUrl }),
        source: {
          url: authenticated.url,
          allowHttp: false,
          credentialRef: 'webdav-source-webdav-1',
        },
      }),
      expect.anything(),
    );
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
    expect(host.querySelector('.lightink-library-continue-cue')?.textContent).toBe('继续阅读');
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

describe('LibraryView navigation', () => {
  it('presents a persistent left navigation with 书库 / 书源 / 管理 and defaults to 全部', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const nav = libraryNav(host);
    expect(isShown(nav)).toBe(true);
    expect(nav.textContent).toContain('全部');
    expect(nav.textContent).toMatch(/书源|书库源/);
    expect(nav.textContent).toContain('管理');
    // 分组树迁入书库区导航
    expect(nav.querySelector('.lightink-library-groups')).not.toBeNull();
    // 默认选中「全部」（书库主页），内容区呈现封面墙
    expect(navItemActive(navButton(host, '全部'))).toBe(true);
    expect(host.querySelector('.lightink-library-item--cover')).not.toBeNull();
    view.destroy();
  });

  it('reaches group management, source edit/remove, import, WebDAV, and cache controls from the navigation', async () => {
    const deps = dependencies({ onOpenSyncPanel: vi.fn() });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    // 分组管理入口常驻书库区导航
    const nav = libraryNav(host);
    shownControl(nav, '新建分组');

    // 书源区：一次点击后 OPDS 源编辑/删除可用
    await openSources(host);
    expect(host.querySelector('[aria-label^="编辑 OPDS 源"]')).not.toBeNull();
    expect(host.querySelector('[aria-label^="删除源"]')).not.toBeNull();

    // 管理区：一次点击后导入 / WebDAV 同步 / 缓存控件可用
    await openManage(host);
    shownButtonWithText(host, '导入本地书籍');
    shownButtonWithText(host, 'WebDAV 同步');
    shownControl(host, '调整缓存上限');
    shownButtonWithText(host, '清理缓存');
    view.destroy();
  });

  it('opens an OPDS catalog as a lazy nav tree with a cover wall and returns to the shelf', async () => {
    const fiction = navigationEntry({
      id: 'nav-1',
      itemId: 'nav-item-1',
      title: '小说分类',
      navigationUrl: 'https://books.example/opds/fiction',
    });
    const scifi = navigationEntry({
      id: 'nav-2',
      itemId: 'nav-item-2',
      title: '科幻',
      navigationUrl: 'https://books.example/opds/fiction/scifi',
    });
    const browse = vi.fn(async (_sourceId: string, url?: string) => {
      if (url === undefined) return feed({ entries: [entry, fiction] });
      if (url === fiction.navigationUrl) {
        return feed({
          title: '小说',
          entries: [
            { ...entry, id: 'entry-2', itemId: 'item-2', title: '分类小说' },
            scifi,
          ],
        });
      }
      return feed({
        title: '科幻',
        entries: [{ ...entry, id: 'entry-3', itemId: 'item-3', title: '科幻小说' }],
      });
    });
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    expect(browse.mock.calls).toEqual([['source-1', undefined]]);
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(catalogDefaultRowsShown(host)).toBe(false);
    expect(shelfFilterShown(host, '全部')).toBe(false);
    expect(shelfFilterShown(host, '在读')).toBe(false);
    expect(host.textContent).toContain('远程漫画');
    expect(itemRow(host, 'item-1').classList.contains('lightink-library-item--cover')).toBe(true);
    expect(
      host.querySelector('.lightink-library-cover-wall [data-item-id="nav-item-1"]'),
    ).toBeNull();

    catalogTreeNode(host, '小说分类').click();
    await settle();
    expect(browse.mock.calls).toEqual([
      ['source-1', undefined],
      ['source-1', 'https://books.example/opds/fiction'],
    ]);
    expect(host.textContent).toContain('分类小说');

    backToShelfControl(host).click();
    await waitForShown(
      () => libraryRoot(host).dataset.libraryNav === 'shelf',
      'catalog did not return to the shelf',
    );
    await waitForShown(() => {
      try {
        return isShown(navButton(host, '全部'));
      } catch {
        return shelfFilterShown(host, '全部');
      }
    }, 'shelf filters did not return');
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(host.textContent).toContain('本地小说');
    expect(isShown(navButton(host, '在读')) || shelfFilterShown(host, '在读')).toBe(true);
    view.destroy();
  });
});

describe('LibraryView sources, manage, and catalog', () => {
  it('hides the library search in the manage section and lists sources in the sources section', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openManage(host);
    const search = host.querySelector<HTMLFormElement>('.lightink-library-search');
    const submit = host.querySelector<HTMLButtonElement>('.lightink-library-search-submit');
    expect(search === null || !isShown(search)).toBe(true);
    expect(submit === null || submit.type === 'submit').toBe(true);

    await openSources(host);
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
    shownButtonWithText(host, '导入本地书籍').click();
    items = [localItem(), imported];
    await settle();
    await openMyBooks(host);

    expect(itemRow(host, imported.id).textContent).toContain('新导入的书');
    expect(host.querySelector('.lightink-library-item--cover')).not.toBeNull();
    view.destroy();
  });

  it('adds an OPDS source from the sources section and can open its catalog', async () => {
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

    await openSources(host);
    shownControl(host, '添加书库源').click();
    const form = sourceFormOf();
    expect(isShown(form)).toBe(true);
    expect(form.closest('.lightink-library-source-modal')?.parentElement).toBe(document.body);
    (form.elements.namedItem('title') as HTMLInputElement).value = added.title;
    (form.elements.namedItem('url') as HTMLInputElement).value = added.url;
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ title: added.title, url: added.url }));
    expect(browse).toHaveBeenCalledWith('source-2', undefined);
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(catalogDefaultRowsShown(host)).toBe(false);
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
    expect(isShown(host.querySelector('.lightink-library-cache-summary'))).toBe(true);
    const limitButton = host.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!;
    limitButton.click();
    const overlay = document.querySelector<HTMLElement>('.lightink-library-cache-limit-modal')!;
    expect(isShown(overlay)).toBe(true);
    expect(overlay.parentElement).toBe(document.body);
    expect(isShown(host.querySelector('.lightink-library-manage-home'))).toBe(true);
    const form = overlay.querySelector<HTMLFormElement>('.lightink-library-cache-limit-form')!;
    const input = form.elements.namedItem('cacheLimitGiB') as HTMLInputElement;
    const apply = form.querySelector<HTMLButtonElement>('.lightink-library-primary');
    expect(form.querySelector('label')?.classList.contains('lightink-library-field')).toBe(true);
    expect(apply?.textContent).toBe('应用');
    expect(apply?.type).toBe('submit');
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    // 缓存上限表单保持单列堆叠布局：grid 容器，列模板要么省略（默认单列），要么显式 minmax(0, 1fr)
    const cacheFormRule = css.match(/\.lightink-library-cache-limit-form\s*\{([^}]*)\}/);
    expect(cacheFormRule).not.toBeNull();
    expect(cacheFormRule![1]).toMatch(/display:\s*grid/);
    const cacheFormColumns = cacheFormRule![1].match(/grid-template-columns:\s*([^;]+);/);
    if (cacheFormColumns) {
      expect(cacheFormColumns[1].replace(/\s+/g, ' ')).toContain('minmax(0, 1fr)');
    }
    expect(css).not.toMatch(
      /\.lightink-library-cache-limit-form\s*\{[^}]*grid-template-columns:\s*minmax\(150px/,
    );
    expect(css).toMatch(
      /\.lightink-library-cache-limit-actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/,
    );
    expect(css).toMatch(
      /\.lightink-library-cache-limit-form \.lightink-library-primary,[\s\S]*?white-space:\s*nowrap/,
    );
    input.value = '3.5';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(deps.library.setCacheLimit).toHaveBeenCalledWith(3.5 * 1024 ** 3);
    // 提交成功后弹层关闭，管理首页仍在。
    expect(isShown(overlay)).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-manage-home'))).toBe(true);
    view.destroy();
  });

  it('offers a Markdown editor link from the manage navigation', async () => {
    const onEnterEditor = vi.fn();
    const deps = dependencies({ onEnterEditor });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    // Markdown 编辑入口在管理区，一次点击导航即达
    expect(isShown(host.querySelector('.lightink-library-editor-entry'))).toBe(false);
    await openManage(host);
    const editor = shownButtonWithText(host, 'Markdown 编辑');
    editor.click();
    expect(onEnterEditor).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('adds WebDAV from the source dialog and lists it beside OPDS sources', async () => {
    const onOpenSyncPanel = vi.fn();
    let davSources: OpdsSource[] = [];
    const addSource = vi.fn(async (input) => {
      const saved: OpdsSource = {
        ...webdav,
        title: input.title,
        url: input.url,
        allowHttp: input.allowHttp ?? false,
        credentialRef: input.credential === undefined ? undefined : 'webdav-source-webdav-1',
      };
      davSources = [saved];
      return saved;
    });
    const listSources = vi.fn(async () => davSources);
    const browse = vi.fn(async () =>
      feed({
        title: '漫画柜',
        sourceUrl: webdav.url,
        entries: [entry],
      }),
    );
    const client = webdavSourceClient({ addSource, listSources, browse });
    const deps = dependencies({ webdavSource: client, onOpenSyncPanel });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    shownControl(host, '添加书库源').click();
    const form = sourceFormOf(host);
    const kind = form.elements.namedItem('kind') as HTMLSelectElement;
    expect(kind).toBeInstanceOf(HTMLSelectElement);
    kind.value = 'webdav';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
    const webdavForm = sourceFormOf(host);
    expect(isShown(webdavForm)).toBe(true);
    expect(webdavForm.querySelector('button')?.parentElement?.textContent).toContain('测试连接');
    (webdavForm.elements.namedItem('title') as HTMLInputElement).value = webdav.title;
    (webdavForm.elements.namedItem('url') as HTMLInputElement).value = webdav.url;
    (webdavForm.elements.namedItem('username') as HTMLInputElement).value = 'user';
    (webdavForm.elements.namedItem('password') as HTMLInputElement).value = 'pass';
    webdavForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        title: webdav.title,
        url: webdav.url,
        credential: { kind: 'basic', username: 'user', password: 'pass' },
      }),
    );
    expect(browse).toHaveBeenCalledWith('webdav-1', undefined);
    expect(onOpenSyncPanel).not.toHaveBeenCalled();
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    expect(host.textContent).toContain('远程漫画');

    backToShelfControl(host).click();
    await settle();
    await openSources(host);
    const webdavRow = host.querySelector<HTMLElement>('[data-source-kind="webdav"]');
    expect(webdavRow).not.toBeNull();
    expect(isShown(webdavRow ?? null)).toBe(true);
    expect(webdavRow?.textContent).toContain('Nextcloud');
    view.destroy();
  });

  it('lists multiple WebDAV sources beside OPDS and opens each catalog independently', async () => {
    const second: OpdsSource = {
      ...webdav,
      id: 'webdav-2',
      title: '群晖',
      url: 'https://nas.example/dav',
    };
    const browse = vi.fn(async (sourceId: string) =>
      feed({
        title: sourceId,
        sourceUrl: sourceId === 'webdav-2' ? second.url : webdav.url,
        entries: [
          {
            ...entry,
            id: `${sourceId}-book`,
            itemId: `${sourceId}-item`,
            title: sourceId === 'webdav-2' ? '群晖漫画' : '云端漫画',
          },
        ],
      }),
    );
    const deps = dependencies({
      webdavSource: webdavSourceClient({
        listSources: vi.fn(async () => [webdav, second]),
        browse,
      }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    expect(host.querySelectorAll('.lightink-library-source-row[data-source-kind="webdav"]').length).toBe(
      2,
    );
    expect(host.querySelector('[data-source-kind="opds"]')?.textContent).toContain('测试书库');
    shownButtonWithText(host, 'Nextcloud').click();
    await settle();
    expect(browse).toHaveBeenCalledWith('webdav-1', undefined);
    expect(host.textContent).toContain('云端漫画');
    backToShelfControl(host).click();
    await settle();
    shownButtonWithText(host, '群晖').click();
    await settle();
    expect(browse).toHaveBeenCalledWith('webdav-2', undefined);
    expect(host.textContent).toContain('群晖漫画');
    backToShelfControl(host).click();
    await settle();
    shownButtonWithText(host, '测试书库').click();
    await settle();
    expect(deps.opds.browse).toHaveBeenCalledWith('source-1', undefined);
    view.destroy();
  });

  it('rejects a WebDAV HTTP URL unless Allow HTTP/LAN is checked', async () => {
    const addSource = vi.fn(async () => webdav);
    const deps = dependencies({
      webdavSource: webdavSourceClient({ addSource, listSources: vi.fn(async () => []) }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    shownControl(host, '添加书库源').click();
    const form = sourceFormOf(host);
    (form.elements.namedItem('kind') as HTMLSelectElement).value = 'webdav';
    (form.elements.namedItem('kind') as HTMLSelectElement).dispatchEvent(
      new Event('change', { bubbles: true }),
    );
    const webdavForm = sourceFormOf(host);
    (webdavForm.elements.namedItem('title') as HTMLInputElement).value = '局域网';
    (webdavForm.elements.namedItem('url') as HTMLInputElement).value = 'http://192.168.1.2/dav';
    (webdavForm.elements.namedItem('username') as HTMLInputElement).value = 'user';
    (webdavForm.elements.namedItem('password') as HTMLInputElement).value = 'pass';
    webdavForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(addSource).not.toHaveBeenCalled();
    expect(webdavForm.textContent).toContain('HTTP 地址需要勾选允许 HTTP/LAN');
    (webdavForm.elements.namedItem('allowHttp') as HTMLInputElement).checked = true;
    webdavForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(addSource).toHaveBeenCalledWith(expect.objectContaining({ allowHttp: true }));
    view.destroy();
  });

  it('shows a WebDAV test-connection failure in the source form', async () => {
    const test = vi.fn(async () => {
      throw new Error('WEBDAV_SOURCE_AUTH_REQUIRED: 鉴权失败');
    });
    const addSource = vi.fn(async () => webdav);
    const deps = dependencies({
      webdavSource: webdavSourceClient({
        test,
        addSource,
        listSources: vi.fn(async () => []),
      }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    shownControl(host, '添加书库源').click();
    const form = sourceFormOf(host);
    (form.elements.namedItem('kind') as HTMLSelectElement).value = 'webdav';
    (form.elements.namedItem('kind') as HTMLSelectElement).dispatchEvent(
      new Event('change', { bubbles: true }),
    );
    const webdavForm = sourceFormOf(host);
    (webdavForm.elements.namedItem('title') as HTMLInputElement).value = webdav.title;
    (webdavForm.elements.namedItem('url') as HTMLInputElement).value = webdav.url;
    shownButtonWithText(webdavForm, '测试连接').click();
    await settle();
    expect(test).toHaveBeenCalled();
    expect(webdavForm.textContent).toContain('鉴权失败');
    expect(addSource).not.toHaveBeenCalled();
    view.destroy();
  });

  it('browses WebDAV directories with OPDS-like breadcrumbs and omits unsupported files', async () => {
    const folder = navigationEntry({
      id: 'nav-books',
      itemId: 'nav-books-item',
      title: '漫画',
      navigationUrl: 'https://dav.example/remote.php/dav/books/',
    });
    const book: OpdsEntry = {
      ...entry,
      id: 'one-piece',
      itemId: 'webdav-item-1',
      title: 'One Piece 01.cbz',
    };
    const browse = vi.fn(async (_sourceId: string, url?: string) => {
      if (url === folder.navigationUrl) {
        return feed({
          title: '漫画',
          sourceUrl: folder.navigationUrl,
          entries: [book],
        });
      }
      return feed({
        title: webdav.title,
        sourceUrl: webdav.url,
        entries: [folder],
      });
    });
    const deps = dependencies({
      webdavSource: webdavSourceClient({ browse }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host, 'Nextcloud');
    expect(browse).toHaveBeenCalledWith('webdav-1', undefined);
    expect(host.textContent).toContain('漫画');
    expect(host.textContent).not.toContain('cover.jpg');
    catalogTreeNode(host, '漫画').click();
    await settle();
    expect(browse).toHaveBeenCalledWith('webdav-1', folder.navigationUrl);
    expect(host.textContent).toContain('One Piece 01.cbz');
    const crumbs = host.querySelector('.lightink-library-breadcrumbs');
    expect(crumbs?.textContent).toContain('Nextcloud');
    expect(crumbs?.textContent).toContain('漫画');
    view.destroy();
  });

  it('filters the current WebDAV catalog locally instead of calling OPDS search', async () => {
    const other: OpdsEntry = { ...entry, id: 'entry-2', itemId: 'item-2', title: '本地过滤小说' };
    const browse = vi.fn(async () =>
      feed({ title: webdav.title, sourceUrl: webdav.url, entries: [entry, other] }),
    );
    const deps = dependencies({
      webdavSource: webdavSourceClient({ browse }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host, 'Nextcloud');
    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '过滤';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(deps.opds.search).not.toHaveBeenCalled();
    expect(host.textContent).toContain('本地过滤小说');
    expect(host.textContent).not.toContain('远程漫画');
    input.value = '';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('本地过滤小说');
    view.destroy();
  });

  it('opens a WebDAV catalog book through onOpen with the shared remote source shape', async () => {
    const authenticated = { ...webdav, credentialRef: 'webdav-source-webdav-1' };
    const book: OpdsEntry = {
      id: 'one-piece',
      itemId: 'webdav-item-1',
      title: 'One Piece 01.cbz',
      authors: [],
      links: [
        {
          href: 'https://dav.example/remote.php/dav/One%20Piece%2001.cbz',
          rel: 'http://opds-spec.org/acquisition',
          mediaType: 'application/vnd.comicbook+zip',
          extension: 'cbz',
          acquisition: true,
        },
      ],
    };
    const browse = vi.fn(async () =>
      feed({ title: authenticated.title, sourceUrl: authenticated.url, entries: [book] }),
    );
    const deps = dependencies({
      webdavSource: webdavSourceClient({
        listSources: vi.fn(async () => [authenticated]),
        browse,
      }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host, 'Nextcloud');
    itemRow(host, 'webdav-item-1').click();
    await settle();
    const pane = host.querySelector('.lightink-library-detail');
    expect(pane instanceof HTMLElement && isShown(pane)).toBe(true);
    shownButtonWithText(pane!, '打开阅读').click();
    await settle();
    expect(deps.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'webdav-item-1',
          sourceId: 'webdav-1',
          sourceKind: 'webdav',
        }),
        acquisition: expect.objectContaining({
          href: 'https://dav.example/remote.php/dav/One%20Piece%2001.cbz',
        }),
        source: {
          url: authenticated.url,
          allowHttp: false,
          credentialRef: 'webdav-source-webdav-1',
        },
      }),
      expect.anything(),
    );
    expect(JSON.stringify(vi.mocked(deps.onOpen).mock.calls[0]?.[0])).not.toMatch(
      /password|token|secret/i,
    );
    view.destroy();
  });

  it('caches a WebDAV catalog book through onCache with the shared remote source shape', async () => {
    const authenticated = { ...webdav, credentialRef: 'webdav-source-webdav-1' };
    const book: OpdsEntry = {
      id: 'one-piece',
      itemId: 'webdav-item-1',
      title: 'One Piece 01.cbz',
      authors: [],
      links: [
        {
          href: 'https://dav.example/remote.php/dav/One%20Piece%2001.cbz',
          rel: 'http://opds-spec.org/acquisition',
          mediaType: 'application/vnd.comicbook+zip',
          extension: 'cbz',
          acquisition: true,
        },
      ],
    };
    const browse = vi.fn(async () =>
      feed({ title: authenticated.title, sourceUrl: authenticated.url, entries: [book] }),
    );
    const deps = dependencies({
      webdavSource: webdavSourceClient({
        listSources: vi.fn(async () => [authenticated]),
        browse,
      }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host, 'Nextcloud');
    itemRow(host, 'webdav-item-1').click();
    await settle();
    const pane = host.querySelector('.lightink-library-detail');
    shownButtonWithText(pane!, '缓存整本').click();
    await settle();
    expect(deps.onCache).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'webdav-item-1',
          sourceKind: 'webdav',
        }),
        acquisition: expect.objectContaining({
          href: 'https://dav.example/remote.php/dav/One%20Piece%2001.cbz',
        }),
        source: {
          url: authenticated.url,
          allowHttp: false,
          credentialRef: 'webdav-source-webdav-1',
        },
      }),
      expect.anything(),
    );
    view.destroy();
  });

  it('deletes a WebDAV source without touching OPDS sources or the sync panel', async () => {
    const onOpenSyncPanel = vi.fn();
    const removeSource = vi.fn(async () => undefined);
    const deps = dependencies({
      webdavSource: webdavSourceClient({ removeSource }),
      onOpenSyncPanel,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    host.querySelector<HTMLButtonElement>('[aria-label="删除源: Nextcloud"]')!.click();
    await settle();
    expect(removeSource).toHaveBeenCalledWith('webdav-1');
    expect(host.querySelector('[data-source-kind="webdav"]')).toBeNull();
    expect(host.querySelector('[data-source-kind="opds"]')?.textContent).toContain('测试书库');
    expect(onOpenSyncPanel).not.toHaveBeenCalled();
    view.destroy();
  });

  it('preserves or clears a WebDAV credential from the shared source form', async () => {
    const authenticated = { ...webdav, credentialRef: 'webdav-source-webdav-1' };
    const addSource = vi.fn(async (input) => ({
      ...authenticated,
      title: input.title,
      credentialRef: input.clearCredential === true ? undefined : authenticated.credentialRef,
    }));
    const listSources = vi.fn(async () => [authenticated]);
    const deps = dependencies({
      webdavSource: webdavSourceClient({ addSource, listSources }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openSources(host);
    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 WebDAV"]')!.click();
    const form = sourceFormOf(host);
    expect((form.elements.namedItem('auth') as HTMLSelectElement).value).toBe('keep');
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(addSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'webdav-1',
        credentialRef: 'webdav-source-webdav-1',
        clearCredential: undefined,
        credential: undefined,
      }),
    );

    host.querySelector<HTMLButtonElement>('[aria-label^="编辑 WebDAV"]')!.click();
    const again = sourceFormOf(host);
    (again.elements.namedItem('auth') as HTMLSelectElement).value = 'none';
    again.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(addSource).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'webdav-1',
        credentialRef: undefined,
        clearCredential: true,
      }),
    );
    view.destroy();
  });

  it('offers a WebDAV sync action from the manage navigation', async () => {
    const onOpenSyncPanel = vi.fn();
    const deps = dependencies({ onOpenSyncPanel });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    // WebDAV 同步入口在管理区，一次点击导航即达
    expect(isShown(host.querySelector('.lightink-library-sync-entry'))).toBe(false);
    await openManage(host);
    const sync = shownButtonWithText(host, 'WebDAV 同步');
    sync.click();
    expect(onOpenSyncPanel).toHaveBeenCalledTimes(1);
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

    await openSources(host);
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

    await openSources(host);
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
    expect(deps.opds.browse).toHaveBeenCalledWith('source-1', undefined);
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(catalogDefaultRowsShown(host)).toBe(false);
    expect(host.textContent).toContain('远程漫画');

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
    expect(deps.opds.search).toHaveBeenCalledWith(
      'source-1',
      '漫画',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

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
        source: { url: source.url, allowHttp: source.allowHttp },
      }),
      expect.anything(),
    );
    expect(view.visible).toBe(false);
  });

  it('debounces live OPDS catalog search and treats a CJK character as enough to search', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await openCatalog(host);

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(deps.opds.search).toHaveBeenCalledWith(
      'source-1',
      '漫',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    vi.mocked(deps.opds.search).mockClear();
    input.value = 'X';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(deps.opds.search).not.toHaveBeenCalled();

    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(deps.opds.search).toHaveBeenCalledWith(
      'source-1',
      'X',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    view.destroy();
  });

  it('appends the next catalog page from the load-more control without replacing the first page', async () => {
    const pageTwo: OpdsEntry = {
      ...entry,
      id: 'entry-2',
      itemId: 'item-2',
      title: '第二页漫画',
    };
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed({ nextUrl: 'https://books.example/opds?page=2' }))
      .mockResolvedValueOnce(feed({ entries: [pageTwo] }));
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await openCatalog(host);

    expect(host.textContent).toContain('远程漫画');
    const more = host.querySelector<HTMLButtonElement>('.lightink-library-catalog-more');
    expect(more).not.toBeNull();
    more!.click();
    await settle();
    expect(browse).toHaveBeenCalledWith('source-1', 'https://books.example/opds?page=2');
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('第二页漫画');

    host.querySelector<HTMLButtonElement>('.lightink-library-group[data-catalog-key=""]')!.click();
    await settle();
    expect(browse).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('第二页漫画');
    view.destroy();
  });

  it('keeps earlier catalog pages when the header next control loads more', async () => {
    const pageTwo: OpdsEntry = {
      ...entry,
      id: 'entry-2',
      itemId: 'item-2',
      title: '第二页漫画',
    };
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed({ nextUrl: 'https://books.example/opds?page=2' }))
      .mockResolvedValueOnce(
        feed({
          entries: [pageTwo],
          nextUrl: 'https://books.example/opds?page=3',
        }),
      );
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await openCatalog(host);

    shownButtonWithText(host, '下一页').click();
    await settle();
    expect(browse).toHaveBeenCalledWith('source-1', 'https://books.example/opds?page=2');
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('第二页漫画');
    view.destroy();
  });

  it('follows OPDS rel=next after search so later pages stream in without a click', async () => {
    const pageTwo: OpdsEntry = {
      ...entry,
      id: 'entry-2',
      itemId: 'item-2',
      title: '搜索第二页',
    };
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed({ nextUrl: 'https://books.example/opds?page=2' }))
      .mockResolvedValueOnce(feed({ entries: [pageTwo] }));
    const search = vi.fn(async () =>
      feed({
        title: '搜索结果',
        nextUrl: 'https://books.example/search?q=漫&page=2',
        entries: [entry],
      }),
    );
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse, search } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await openCatalog(host);

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(search).toHaveBeenCalled();
    expect(browse).toHaveBeenCalledWith(
      'source-1',
      'https://books.example/search?q=漫&page=2',
    );
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('搜索第二页');
    view.destroy();
  });

  it('does not append an in-flight browse page onto later search results', async () => {
    const browsePageTwo: OpdsEntry = {
      ...entry,
      id: 'browse-2',
      itemId: 'browse-2',
      title: '浏览第二页',
    };
    const searchPageTwo: OpdsEntry = {
      ...entry,
      id: 'search-2',
      itemId: 'search-2',
      title: '搜索第二页',
    };
    let resolveBrowsePage: ((value: OpdsFeed) => void) | undefined;
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed({ nextUrl: 'https://books.example/opds?page=2' }))
      .mockImplementationOnce(
        () =>
          new Promise<OpdsFeed>((resolve) => {
            resolveBrowsePage = resolve;
          }),
      )
      .mockResolvedValueOnce(feed({ entries: [searchPageTwo] }));
    const search = vi.fn(async () =>
      feed({
        title: '搜索结果',
        nextUrl: 'https://books.example/search?q=漫&page=2',
        entries: [{ ...entry, title: '搜索第一页' }],
      }),
    );
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse, search } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await openCatalog(host);

    host.querySelector<HTMLButtonElement>('.lightink-library-catalog-more')!.click();
    await settle();
    expect(browse).toHaveBeenCalledWith('source-1', 'https://books.example/opds?page=2');

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(host.textContent).toContain('搜索第一页');
    expect(browse).toHaveBeenCalledWith(
      'source-1',
      'https://books.example/search?q=漫&page=2',
    );

    resolveBrowsePage?.(feed({ entries: [browsePageTwo] }));
    await settle();
    expect(host.textContent).not.toContain('浏览第二页');
    expect(host.textContent).toContain('搜索第一页');
    expect(host.textContent).toContain('搜索第二页');
    view.destroy();
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
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(host.textContent).toContain('分组内图书');
    catalogTreeNode(host, '更多小说').click();
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

  it('does not flash 正在加载… on catalog paging, refresh, or search when covers are already painted', async () => {
    let resolvePage: ((value: OpdsFeed) => void) | undefined;
    let resolveRefresh: ((value: OpdsFeed) => void) | undefined;
    let resolveSearch: ((value: OpdsFeed) => void) | undefined;
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed({ nextUrl: 'https://books.example/opds?page=2' }))
      .mockImplementationOnce(
        () =>
          new Promise<OpdsFeed>((resolve) => {
            resolvePage = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<OpdsFeed>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const search = vi.fn(
      () =>
        new Promise<OpdsFeed>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const base = dependencies();
    const deps = dependencies({ opds: { ...base.opds, browse, search } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(itemRow(host, 'item-1')).toBeTruthy();

    shownButtonWithText(host, '下一页').click();
    await settle();
    expect(itemRow(host, 'item-1')).toBeTruthy();
    expect(host.textContent).not.toContain('正在加载…');
    resolvePage?.(
      feed({
        title: '第二页',
        entries: [{ ...entry, id: 'entry-2', itemId: 'item-2', title: '第二页漫画' }],
      }),
    );
    await settle();
    expect(host.textContent).toContain('第二页漫画');

    const refreshing = view.refresh();
    await settle();
    expect(host.querySelector('[data-item-id="item-1"]')).not.toBeNull();
    expect(host.textContent).not.toContain('正在加载…');
    resolveRefresh?.(feed());
    await refreshing;
    expect(host.textContent).toContain('远程漫画');

    const input = host.querySelector<HTMLInputElement>('.lightink-library-search input')!;
    input.value = '漫画';
    host.querySelector<HTMLFormElement>('.lightink-library-search')!.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(host.querySelector('[data-item-id="item-1"]')).not.toBeNull();
    expect(host.textContent).not.toContain('正在加载…');
    expect(host.textContent).not.toContain('正在搜索…');
    resolveSearch?.(feed({ title: '搜索结果', entries: [{ ...entry, title: '搜索漫画' }] }));
    await settle();
    expect(host.textContent).toContain('搜索漫画');
    view.destroy();
  });

  it('keeps painted catalog covers and offers retry when a later browse fails', async () => {
    const browse = vi
      .fn()
      .mockResolvedValueOnce(feed())
      .mockRejectedValueOnce(new Error('offline'));
    const deps = dependencies({ opds: { ...dependencies().opds, browse } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(itemRow(host, 'item-1')).toBeTruthy();

    await view.refresh();
    expect(itemRow(host, 'item-1')).toBeTruthy();
    expect(host.textContent).toContain('offline');
    expect(host.textContent).not.toContain('正在加载…');
    shownButtonWithText(host, '重试');
    view.destroy();
  });

  it('renders the catalog as a source tree, cover wall, and detail pane', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    expect(catalogCoverWallShown(host)).toBe(true);
    expect(catalogDefaultRowsShown(host)).toBe(false);
    expect(shelfFilterShown(host, '全部')).toBe(false);
    expect(shelfFilterShown(host, '在读')).toBe(false);
    const content = libraryRoot(host).querySelector('.lightink-library-content');
    expect(content?.querySelector('.lightink-library-cover-wall')).not.toBeNull();
    expect(content?.querySelector('.lightink-library-item--cover')).not.toBeNull();
    expect(content?.querySelector('.lightink-library-detail')).not.toBeNull();
    expect(isShown(host.querySelector('.lightink-library-source-url'))).toBe(false);
    expect(host.textContent).toContain('远程漫画');
    expect(host.textContent).toContain('返回书架');
    expect(host.querySelector('.lightink-library-back-to-shelf')?.closest('.lightink-library-catalog-tree')).toBeNull();
    expect(host.querySelector('.lightink-library-catalog-pane > .lightink-library-catalog-tree')).not.toBeNull();

    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    // 书架不消费 reader 内部令牌
    expect(css).not.toMatch(/--lightink-reader-/);
    expect(css).not.toMatch(/--lightink-measure/);
    expect(css).not.toMatch(/--lightink-page-pad/);
    // 新契约：data-library-page 页面契约已移除，由 data-library-nav 导航状态契约取代
    expect(css).not.toContain('data-library-page');
    expect(css).toMatch(/\[data-library-nav/);
    // 导航 + 内容区存在明确的两栏 grid 布局
    const bodyRule = css.match(/\.lightink-library-body\s*\{([^}]*)\}/);
    expect(bodyRule).not.toBeNull();
    expect(bodyRule![1]).toMatch(/display:\s*grid/);
    expect(bodyRule![1]).toMatch(/grid-template-columns/);
    expect(bodyRule![1]).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(bodyRule![1]).toMatch(/overflow:\s*hidden/);
    // catalog 内容区存在明确的 grid/flex 布局规则（等价于原 data-library-page='catalog' 断言）
    expect(css).toMatch(
      /\[data-library-nav=['"]?catalog['"]?\][^{]*\{[^}]*(display:\s*(grid|flex)|grid-template-columns|flex-direction)/,
    );
    // 内容区列表（catalog 行式）与封面墙（网格）均有明确布局规则
    const itemsRule = css.match(/\.lightink-library-items\s*\{([^}]*)\}/);
    expect(itemsRule).not.toBeNull();
    expect(itemsRule![1]).toMatch(/display:\s*flex/);
    expect(itemsRule![1]).toMatch(/flex-direction:\s*column/);
    const wallRule = css.match(/\.lightink-library-cover-wall\s*\{([^}]*)\}/);
    expect(wallRule).not.toBeNull();
    expect(wallRule![1]).toMatch(/display:\s*grid/);
    expect(wallRule![1]).toMatch(/grid-template-columns/);
    expect(wallRule![1]).toMatch(/overflow-y:\s*auto/);
    expect(wallRule![1]).toMatch(/grid-auto-rows:\s*max-content/);
    expect(css).toMatch(
      /\.lightink-library-cover-wall\s*>\s*\.lightink-library-item:not\(\.lightink-library-catalog-folder\)\s*\{[^}]*min-height:\s*max-content/,
    );
    const workareaRule = css.match(/\.lightink-library-workarea\s*\{([^}]*)\}/);
    expect(workareaRule).not.toBeNull();
    expect(workareaRule![1]).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(workareaRule![1]).toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(
      /\[data-library-nav=['"]?catalog['"]?\] \.lightink-library-cover-wall\s*\{[^}]*overflow-y:\s*auto/,
    );
    // 导航分区不收缩（防止内容溢出与后续分区重叠），由导航容器整体滚动
    const navSectionRule = css.match(/\.lightink-library-nav-section\s*\{([^}]*)\}/);
    expect(navSectionRule).not.toBeNull();
    expect(navSectionRule![1]).toMatch(/flex:\s*0 0 auto/);
    const navRule = css.match(/\.lightink-library-nav\s*\{([^}]*)\}/);
    expect(navRule).not.toBeNull();
    expect(navRule![1]).toMatch(/overflow-y:\s*auto/);
    view.destroy();
  });

  it('keeps the brand word on the window edge when the nav is collapsed', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).toMatch(
      /\[data-library-nav-collapsed='true'\] \.lightink-library-header\s*\{[^}]*display:\s*flex/,
    );
    expect(css).toMatch(
      /\[data-library-nav-collapsed='true'\] \.lightink-library-brand\s*\{[^}]*font-size:\s*15px/,
    );
    expect(css).not.toMatch(
      /\[data-library-nav-collapsed='true'\] \.lightink-library-brand\s*\{[^}]*font-size:\s*13px/,
    );
  });

  it('keeps the shelf search compact in the titlebar row', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-library-header\s*\{[^}]*align-items:\s*center/,
    );
    expect(css).toMatch(/\.lightink-library-search\s*\{[^}]*height:\s*32px/);
    expect(css).toMatch(/\.lightink-library-search\s*\{[^}]*width:\s*var\(--lightink-library-search-max/);
    expect(css).toMatch(
      /\.lightink-library-search input(?:,|\s|,)[\s\S]*?min-height:\s*0/,
    );
  });

  it('applies an independent shelf theme and can switch it without the editor key', async () => {
    const store: Record<string, string> = {};
    const themeStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies({ themeStorage }));
    await view.show();
    await openManage(host);

    const root = libraryRoot(host);
    expect(root.dataset.libraryTheme).toBe('gallery');
    expect(root.style.getPropertyValue('--lightink-bg')).toBe('#e8edf2');
    expect(host.querySelector('.lightink-library-header .lightink-library-theme-swatches')).toBeNull();
    expect(host.querySelector('.lightink-library-manage-panel .lightink-library-appearance')).toBeTruthy();
    expect(host.querySelector('.lightink-library-appearance-hint')?.textContent).toContain('书架');
    const swatches = host.querySelectorAll<HTMLButtonElement>(
      '.lightink-library-manage-panel .lightink-library-theme-swatch',
    );
    expect(swatches).toHaveLength(5);
    const ink = [...swatches].find((button) => button.dataset.libraryTheme === 'ink');
    expect(ink).toBeTruthy();
    ink!.click();
    expect(root.dataset.libraryTheme).toBe('ink');
    expect(root.style.getPropertyValue('--lightink-bg')).toBe('#14161a');
    expect(store['lightink.library.theme']).toBe('ink');
    expect(store['lightink.theme']).toBeUndefined();
    expect(store['lightink.reader.theme']).toBeUndefined();
    view.destroy();
  });

  it('offers a dedicated reader prefs block to hide the progress bar', async () => {
    const store: Record<string, string> = {};
    const readerPrefsStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies({ readerPrefsStorage }));
    await view.show();
    await openManage(host);

    const section = host.querySelector('.lightink-library-manage-panel .lightink-library-reader-prefs');
    expect(section).toBeTruthy();
    expect(section?.querySelector('h2')?.textContent).toBe('阅读偏好');
    expect(section?.querySelector('p')?.textContent).toContain('进度条');
    const input = host.querySelector<HTMLInputElement>(
      '.lightink-library-reader-prefs input[name="showProgressBar"]',
    );
    expect(input?.checked).toBe(true);
    expect(host.textContent).toContain('显示进度条');
    expect(document.documentElement.dataset.readerProgressBar).toBe('on');

    input!.checked = false;
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store['lightink.reader.prefs']).toContain('"showProgressBar":false');
    expect(document.documentElement.dataset.readerProgressBar).toBe('off');
    expect(store['lightink.reader.typography']).toBeUndefined();
    expect(store['lightink.reader.theme']).toBeUndefined();
    expect(store['lightink.library.theme']).toBeUndefined();

    store['lightink.reader.prefs'] = JSON.stringify({ showProgressBar: true });
    view.retranslate();
    expect(input!.checked).toBe(true);
    expect(document.documentElement.dataset.readerProgressBar).toBe('on');
    store['lightink.reader.prefs'] = JSON.stringify({ showProgressBar: false });
    window.dispatchEvent(
      new CustomEvent('lightink:syncable-storage-change', {
        detail: { key: 'lightink.reader.prefs' },
      }),
    );
    expect(input!.checked).toBe(false);
    expect(document.documentElement.dataset.readerProgressBar).toBe('off');
    view.destroy();
  });

  it('drops the hardcoded shelf palette and consumes main theme tokens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    // 不再定义 --lightink-shelf-* 私有自定义属性（色板与尺寸令牌全部移除）
    expect(css).not.toMatch(/--lightink-shelf-[a-z0-9-]*\s*:/i);
    // 不再有 rgba( 硬编码颜色
    expect(css).not.toMatch(/rgba\(/i);
    // 颜色经 var(--lightink-*) 主令牌消费：抽样根节点与封面墙关键规则
    const rootRule = css.match(/\.lightink-library\s*\{([^}]*)\}/);
    expect(rootRule).not.toBeNull();
    expect(rootRule![1]).toMatch(/background:\s*var\(--lightink-bg/);
    expect(rootRule![1]).toMatch(/color:\s*var\(--lightink-fg/);
    expect(css).toMatch(/var\(--lightink-(muted|border|accent)/);
    expect(css).toMatch(/\.lightink-library-cover\s*\{[^}]*var\(--lightink-/);
  });

  it('scales the shelf and manage panel across compact / hd / qhd / uhd / xuhd', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    for (const tier of ['compact', 'hd', 'qhd', 'uhd', 'xuhd']) {
      expect(css).toMatch(
        new RegExp(
          `html\\[data-display=['"]${tier}['"]\\]\\s*\\.lightink-library\\s*\\{[^}]*--lightink-library-manage-max`,
        ),
      );
      expect(css).toMatch(
        new RegExp(
          `html\\[data-display=['"]${tier}['"]\\]\\s*\\.lightink-library\\s*\\{[^}]*--lightink-library-cover-min`,
        ),
      );
      expect(css).toMatch(
        new RegExp(
          `html\\[data-display=['"]${tier}['"]\\]\\s*\\.lightink-library\\s*\\{[^}]*--lightink-library-nav-width`,
        ),
      );
    }
    expect(css).toMatch(/max-width:\s*var\(--lightink-library-manage-max\)/);
    expect(css).toMatch(
      /\.lightink-library-appearance,\s*\.lightink-library-reader-prefs\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    );
    expect(css).toMatch(/@container\s+library-content\s*\(min-width:\s*52rem\)/);
    expect(css).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(var\(--lightink-library-cover-min\),\s*var\(--lightink-library-cover-max\)\)\)/,
    );
    expect(css).not.toMatch(/--lightink-measure/);
    expect(css).not.toMatch(/--lightink-page-pad/);
  });

  it('resolves the 480px tier as the effective cascade winner at 360dp (data-display=compact)', () => {
    // display-scale.ts 在 <1280px 视口置 data-display='compact'，1279px 档的
    // :not(qhd/uhd/xuhd) 链恒匹配（特异性 0,4,1）。480px 档只有特异性不低于
    // 该档且源码序在其后，360dp 值才是有效值；本测试按 (特异性, 源码序)
    // 重放层叠取胜者，而非仅断言声明存在。
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );

    // 配平括号抽取从 marker 开始的完整规则（含媒体块内嵌套规则）。
    const blockAt = (marker: string): { text: string; index: number } => {
      const index = css.indexOf(marker);
      expect(index).toBeGreaterThan(-1);
      const open = css.indexOf('{', index + marker.length);
      let depth = 0;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) return { text: css.slice(index, i + 1), index };
        }
      }
      throw new Error(`unbalanced block: ${marker}`);
    };

    // 简易特异性 (id, class+attr, element)；:not() 本身不计，其参数中的
    // 属性选择器已由 attr 统计覆盖（本文件变量档无其他伪类）。
    const specificity = (selector: string): [number, number, number] => {
      const ids = (selector.match(/#[\w-]+/g) ?? []).length;
      const classes = (selector.match(/\.[\w-]+/g) ?? []).length;
      const attrs = (selector.match(/\[[^\]]*\]/g) ?? []).length;
      const rest = selector
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/:{1,2}[a-z-]+(\([^)]*\))?/gi, ' ')
        .replace(/[.#][\w-]+/g, ' ')
        .replace(/[>+~*]/g, ' ');
      const elements = rest.split(/\s+/).filter((part) => /^[a-z][\w-]*$/i.test(part)).length;
      return [ids, classes + attrs, elements];
    };
    const compareSpec = (a: [number, number, number], b: [number, number, number]): number =>
      a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

    // 360dp + data-display='compact' 下同时命中的变量档。
    const tiers = [
      { marker: '.lightink-library {', name: 'base' },
      { marker: "html[data-display='compact'] .lightink-library {", name: 'compact' },
      { marker: '@media (max-width: 1279px)', name: '1279px' },
      { marker: '@media (max-width: 760px)', name: '760px' },
      { marker: '@media (max-width: 480px)', name: '480px' },
    ].map(({ marker, name }) => {
      const { text, index } = blockAt(marker);
      const rule = text.match(/([^{}]*\.lightink-library)\s*\{([^}]*)\}/);
      expect(rule, `${name} tier declares variables on .lightink-library`).not.toBeNull();
      const declarations = new Map<string, string>();
      for (const decl of rule![2].split(';')) {
        const colon = decl.indexOf(':');
        if (colon === -1) continue;
        const key = decl.slice(0, colon).trim();
        if (key.startsWith('--lightink-library-')) {
          declarations.set(key, decl.slice(colon + 1).trim());
        }
      }
      const spec = rule![1]
        .split(',')
        .map((part) => specificity(part))
        .reduce((best, current) => (compareSpec(current, best) > 0 ? current : best));
      return { name, declarations, spec, order: index };
    });

    const expected360: Record<string, string> = {
      '--lightink-library-pad-x': '12px',
      '--lightink-library-pad-y': '10px',
      '--lightink-library-nav-width': '120px',
      '--lightink-library-nav-min': '120px',
      '--lightink-library-cover-min': '128px',
      '--lightink-library-search-max': '100%',
      '--lightink-library-manage-max': '100%',
    };
    for (const [token, value] of Object.entries(expected360)) {
      const contenders = tiers
        .filter((tier) => tier.declarations.has(token))
        .sort((a, b) => compareSpec(a.spec, b.spec) || a.order - b.order);
      const winner = contenders[contenders.length - 1];
      expect(winner?.name, `${token} effective winner at 360dp`).toBe('480px');
      expect(winner?.declarations.get(token)).toBe(value);
    }
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
    expect(catalogCoverWallShown(host)).toBe(true);

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

    expect(catalogCoverWallShown(host)).toBe(true);
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

  it('derives no author or series smart groups from a single book and opens a page-level new-group dialog', async () => {
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

    // 单本书不产生作者/系列智能分组（计数不足）：带前缀的完整智能组标签在导航与分组树中都不出现，
    // 裸名断言无法锁定该行为（真实标签为「作者：{name}」「系列：{name}」）
    for (const name of ['藻', 'ハム男']) {
      expect(() => collectionButton(host, name)).toThrow(/collection button not found/);
    }
    for (const label of ['作者：藻', '作者：ハム男', '系列：藻']) {
      expect(() => smartGroupButton(host, label)).toThrow(/smart group nav item not found/);
    }
    const navText = libraryNav(host).textContent ?? '';
    expect(navText).not.toContain('作者：藻');
    expect(navText).not.toContain('作者：ハム男');
    expect(navText).not.toContain('系列：藻');

    await startCreateGroup(host);
    const overlay = document.querySelector('.lightink-library-group-modal');
    expect(overlay).toBeInstanceOf(HTMLElement);
    expect(overlay?.parentElement).toBe(document.body);
    expect(libraryRoot(host).contains(overlay)).toBe(false);
    expect(overlay?.hasAttribute('hidden')).toBe(false);
    expect(isShown(overlay)).toBe(true);
    expect(groupFormOf().elements.namedItem('name')).toBeInstanceOf(HTMLInputElement);
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
      () =>
        document.querySelector('.lightink-library-group-modal:not([hidden]) [name="name"]') !== null,
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

  it('renders smart groups as read-only navigation items that filter the cover wall', async () => {
    const novel = seriesNovel();
    const comic = comicItem({
      id: 'local:/ebook/hell-comic.cbz',
      title: '地狱漫画',
      localPath: '/ebook/hell-comic.cbz',
    });
    const { deps } = collectionDependencies({
      items: [novel, comic],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    // 智能分组默认折叠，展开后作为只读导航项呈现，选中即过滤右侧内容区
    expandNavSection(host, 'smart-groups');
    smartGroupButton(host, 'EPUB').click();
    await settle();
    expect(itemRow(host, novel.id)).toBeTruthy();
    expect(host.querySelector(`[data-item-id="${comic.id}"]`)).toBeNull();

    const comicGroup = smartGroupButton(host, 'CBZ');
    comicGroup.click();
    await settle();
    expect(itemRow(host, comic.id)).toBeTruthy();
    expect(host.querySelector(`[data-item-id="${novel.id}"]`)).toBeNull();

    // 只读：不归属自定义分组树，右键不弹出操作菜单
    expect(comicGroup.closest('.lightink-library-custom-group')).toBeNull();
    comicGroup.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
    );
    await settle();
    expect(document.querySelector('.lightink-context-menu')).toBeNull();
    view.destroy();
  });

  it('hides empty smart groups, shelf-filter duplicates, and duplicate rules', async () => {
    const novel = seriesNovel();
    const comic = comicItem({
      id: 'local:/ebook/hell-comic.cbz',
      title: '地狱漫画',
      localPath: '/ebook/hell-comic.cbz',
    });
    const { deps } = collectionDependencies({
      items: [novel, comic],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    expandNavSection(host, 'smart-groups');

    const smartItems = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.lightink-library-smart-group'),
    ).filter((item) => isShown(item));
    const names = smartItems.map((item) => item.textContent?.trim());
    // 与书库快捷过滤重复的内置组不再出现在智能分组中
    expect(names).not.toContain('在读');
    expect(names).not.toContain('未读');
    expect(names).not.toContain('文字书');
    expect(names).not.toContain('漫画');
    // 零匹配的空组不显示（无 PDF、无受管/远程书籍）
    expect(names).not.toContain('PDF');
    expect(names).not.toContain('受管书籍');
    expect(names).not.toContain('远程书籍');
    // 静态 EPUB 与动态 format:epub 同规则只保留一个
    expect(names.filter((name) => name === 'EPUB')).toHaveLength(1);
    expect(names).toContain('CBZ');
    view.destroy();
  });

  it('renders collapsible nav sections as disclosures with type icons', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const groupHeading = host.querySelector('.lightink-library-groups .lightink-library-pane-heading');
    const smartHeading = host.querySelector(
      '.lightink-library-smart-group-body',
    )?.previousElementSibling;
    const sourceHeading = host.querySelector('.lightink-library-sources .lightink-library-pane-heading');
    expect(groupHeading?.querySelector('.lightink-library-section-icon')).toBeTruthy();
    expect(groupHeading?.querySelector('.lightink-library-collapse-chevron')).toBeTruthy();
    expect(smartHeading?.querySelector('.lightink-library-section-icon')).toBeTruthy();
    expect(sourceHeading?.querySelector('.lightink-library-section-icon')).toBeTruthy();
    expect(host.querySelector('[data-shelf-group="all"] .lightink-library-nav-icon')).toBeTruthy();
    expect(host.querySelector('.lightink-library-manage-entry .lightink-library-nav-icon')).toBeTruthy();
    expect(groupHeading?.classList.contains('is-collapsed')).toBe(false);
    expect(sourceHeading?.classList.contains('is-collapsed')).toBe(false);
    view.destroy();
  });

  it('collapses the sidebar to an icon rail and remembers the choice', async () => {
    const store: Record<string, string> = {};
    const themeStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies({ themeStorage }));
    await view.show();

    const root = libraryRoot(host);
    const toggle = host.querySelector<HTMLButtonElement>('.lightink-library-nav-collapse')!;
    expect(root.dataset.libraryNavCollapsed).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('lightink-library-nav');

    toggle.click();
    expect(root.dataset.libraryNavCollapsed).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(store['lightink.library.navCollapsed']).toBe('1');
    expect(host.querySelector('[data-shelf-group="all"]')).toBeTruthy();

    view.destroy();
    const nextHost = document.createElement('div');
    document.body.appendChild(nextHost);
    const next = createLibraryView(nextHost, dependencies({ themeStorage }));
    await next.show();
    expect(libraryRoot(nextHost).dataset.libraryNavCollapsed).toBe('true');
    next.destroy();
  });

  it('keeps 返回书架 on the collapsed catalog rail', async () => {
    const deps = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    const toggle = host.querySelector<HTMLButtonElement>('.lightink-library-nav-collapse')!;
    toggle.click();
    expect(libraryRoot(host).dataset.libraryNavCollapsed).toBe('true');
    const back = host.querySelector<HTMLElement>('.lightink-library-back-to-shelf');
    expect(back?.closest('.lightink-library-catalog-tree')).toBeNull();
    expect(isShown(back)).toBe(true);
    expect(backToShelfControl(host).textContent).toContain('返回书架');
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    expect(css).toMatch(
      /\[data-library-nav-collapsed='true'\]\[data-library-nav=['"]?catalog['"]?\] \.lightink-library-catalog-tree\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /\[data-library-nav-collapsed='true'\]\[data-library-nav=['"]?catalog['"]?\] \.lightink-library-back-to-shelf/,
    );
    view.destroy();
  });

  it('collapses and expands nav sections, with smart groups collapsed by default', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const smartBody = host.querySelector('.lightink-library-smart-group-body');
    const groupBodyEl = host.querySelector('.lightink-library-group-body');
    const sourceBodyEl = host.querySelector('.lightink-library-source-body');
    expect(smartBody instanceof HTMLElement && smartBody.hidden).toBe(true);
    expect(groupBodyEl instanceof HTMLElement && groupBodyEl.hidden).toBe(false);
    expect(sourceBodyEl instanceof HTMLElement && sourceBodyEl.hidden).toBe(false);
    expect(navSectionToggle(host, 'smart-groups').getAttribute('aria-expanded')).toBe('false');

    // 展开智能分组后内容可见；再次点击折叠
    navSectionToggle(host, 'smart-groups').click();
    expect(navSectionToggle(host, 'smart-groups').getAttribute('aria-expanded')).toBe('true');
    expect(smartBody instanceof HTMLElement && smartBody.hidden).toBe(false);
    expect(smartGroupButton(host, 'EPUB')).toBeTruthy();
    navSectionToggle(host, 'smart-groups').click();
    expect(smartBody instanceof HTMLElement && smartBody.hidden).toBe(true);

    // 分组与书库源分区同样可折叠
    navSectionToggle(host, 'groups').click();
    expect(groupBodyEl instanceof HTMLElement && groupBodyEl.hidden).toBe(true);
    navSectionToggle(host, 'sources').click();
    expect(sourceBodyEl instanceof HTMLElement && sourceBodyEl.hidden).toBe(true);
    view.destroy();
  });

  it('filters the collection tree by name from the section filter input', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await startCreateGroup(host);
    await submitGroupForm(host, { name: '科幻小说' });
    await startCreateGroup(host);
    await submitGroupForm(host, { name: '推理小说' });
    expect(collectionButton(host, '科幻小说')).toBeTruthy();
    expect(collectionButton(host, '推理小说')).toBeTruthy();

    const filterToggle = host.querySelector<HTMLButtonElement>(
      '.lightink-library-group-filter-toggle',
    )!;
    const filter = host.querySelector<HTMLInputElement>('.lightink-library-group-filter')!;
    const filterWrap = host.querySelector<HTMLElement>('.lightink-library-section-filter-wrap')!;
    // 筛选输入框默认收起，由分区标题行的搜索按钮展开
    expect(filterWrap.hidden).toBe(true);
    filterToggle.click();
    expect(filterWrap.hidden).toBe(false);
    expect(filter.placeholder).toBe('筛选分组…');
    filter.value = '科幻';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(collectionButton(host, '科幻小说')).toBeTruthy();
    expect(() => collectionButton(host, '推理小说')).toThrow(/collection button not found/);

    const clear = filterWrap.querySelector<HTMLButtonElement>(
      '.lightink-library-section-filter-clear',
    )!;
    expect(clear.hidden).toBe(false);
    clear.click();
    await settle();
    expect(filter.value).toBe('');
    expect(clear.hidden).toBe(true);
    expect(collectionButton(host, '科幻小说')).toBeTruthy();
    expect(collectionButton(host, '推理小说')).toBeTruthy();

    filter.value = '科幻';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(() => collectionButton(host, '推理小说')).toThrow(/collection button not found/);

    // 清空后完整分组树恢复
    filter.value = '';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(collectionButton(host, '科幻小说')).toBeTruthy();
    expect(collectionButton(host, '推理小说')).toBeTruthy();
    view.destroy();
  });

  it('expands a collapsed smart-group section when the filter button is clicked', async () => {
    const novel = seriesNovel();
    const { deps } = collectionDependencies({
      items: [novel],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const smartBody = host.querySelector<HTMLElement>('.lightink-library-smart-group-body')!;
    const filterWrap = host.querySelector<HTMLElement>(
      '.lightink-library-smart-group-body .lightink-library-section-filter-wrap',
    )!;
    expect(smartBody.hidden).toBe(true);
    expect(navSectionToggle(host, 'smart-groups').getAttribute('aria-expanded')).toBe('false');

    host.querySelector<HTMLButtonElement>('.lightink-library-smart-group-filter-toggle')!.click();
    expect(smartBody.hidden).toBe(false);
    expect(filterWrap.hidden).toBe(false);
    expect(navSectionToggle(host, 'smart-groups').getAttribute('aria-expanded')).toBe('true');
    view.destroy();
  });

  it('filters smart groups by name from the section filter input', async () => {
    const novel = seriesNovel();
    const comic = comicItem({
      id: 'local:/ebook/hell-comic.cbz',
      title: '地狱漫画',
      localPath: '/ebook/hell-comic.cbz',
    });
    const { deps } = collectionDependencies({
      items: [novel, comic],
      seriesStemByItemId: { [novel.id]: seriesStem },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    expandNavSection(host, 'smart-groups');
    expect(smartGroupButton(host, 'EPUB')).toBeTruthy();
    expect(smartGroupButton(host, 'CBZ')).toBeTruthy();

    const toggle = host.querySelector<HTMLButtonElement>(
      '.lightink-library-smart-group-filter-toggle',
    )!;
    toggle.click();
    const input = host.querySelector<HTMLInputElement>(
      '.lightink-library-smart-group-filter',
    )!;
    expect(input.placeholder).toBe('筛选智能分组…');
    input.value = 'EP';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(smartGroupButton(host, 'EPUB')).toBeTruthy();
    expect(() => smartGroupButton(host, 'CBZ')).toThrow(/smart group nav item not found/);

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(smartGroupButton(host, 'CBZ')).toBeTruthy();
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

describe('LibraryView remove from library', () => {
  it('removes a local cover via 移出书库 using the same library.removeItem as the detail pane', async () => {
    const keep = localItem();
    const gone = localItem({
      id: 'local:/books/remove.epub',
      title: '待移出',
      localPath: '/books/remove.epub',
    });
    let shelf = [keep, gone];
    const removeItem = vi.fn(async (id: string) => {
      shelf = shelf.filter((item) => item.id !== id);
    });
    const base = dependencies();
    const deps = dependencies({
      library: {
        ...base.library,
        listItems: vi.fn(async () => shelf),
        removeItem,
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const menu = await openItemMenu(host, gone.id);
    expect(menu.textContent).toContain('移出书库');
    contextMenuItem('移出书库').click();
    await settle();

    expect(removeItem).toHaveBeenCalledWith(gone.id);
    expect(host.querySelector(`[data-item-id="${gone.id}"]`)).toBeNull();
    expect(itemRow(host, keep.id)).toBeTruthy();
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(false);
    view.destroy();
  });

  it('does not flash a removed book when returning to the shelf before reload finishes', async () => {
    const keep = localItem();
    const gone = localItem({
      id: 'local:/books/remove-stale.epub',
      title: '待移出残留',
      localPath: '/books/remove-stale.epub',
    });
    let shelf = [keep, gone];
    let resolveReload: ((items: LibraryItem[]) => void) | undefined;
    const listItems = vi
      .fn()
      .mockResolvedValueOnce([keep, gone])
      .mockImplementation(
        () =>
          new Promise<LibraryItem[]>((resolve) => {
            resolveReload = resolve;
          }),
      );
    const removeItem = vi.fn(async (id: string) => {
      shelf = shelf.filter((item) => item.id !== id);
    });
    const base = dependencies();
    const deps = dependencies({
      library: {
        ...base.library,
        listItems,
        removeItem,
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openItemMenu(host, gone.id);
    contextMenuItem('移出书库').click();
    await settle();
    expect(host.querySelector(`[data-item-id="${gone.id}"]`)).toBeNull();

    await openCatalog(host);
    backToShelfControl(host).click();
    await waitForShown(
      () => libraryRoot(host).dataset.libraryNav === 'shelf',
      'catalog did not return to the shelf',
    );
    expect(host.querySelector(`[data-item-id="${gone.id}"]`)).toBeNull();
    expect(itemRow(host, keep.id)).toBeTruthy();

    resolveReload?.(shelf);
    await settle();
    expect(host.querySelector(`[data-item-id="${gone.id}"]`)).toBeNull();
    view.destroy();
  });

  it('offers 移出书库 on a managed cover and on the detail pane of an already-imported catalog book', async () => {
    const managed = localItem({
      id: 'managed:book-1',
      sourceKind: 'managed',
      blobHash: 'hash-1',
      title: '受管书',
    });
    const imported = localItem({ id: 'item-1', title: '已入库远程书' });
    let shelf = [managed, imported];
    const removeItem = vi.fn(async (id: string) => {
      shelf = shelf.filter((item) => item.id !== id);
    });
    const base = dependencies();
    const deps = dependencies({
      library: {
        ...base.library,
        listItems: vi.fn(async () => shelf),
        removeItem,
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const coverMenu = await openItemMenu(host, managed.id);
    expect(coverMenu.textContent).toContain('移出书库');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    await openCatalog(host);
    itemRow(host, 'item-1').click();
    await settle();
    const pane = host.querySelector('.lightink-library-detail');
    expect(pane instanceof HTMLElement && isShown(pane)).toBe(true);
    expect(detailShowsRemove(host)).toBe(true);
    shownButtonWithText(pane!, '移出书库').click();
    await settle();
    expect(removeItem).toHaveBeenCalledWith('item-1');
    expect(host.querySelector('[data-item-id="item-1"]')).toBeNull();
    view.destroy();
  });

  it('hides 移出书库 on remote and navigation catalog menus and details', async () => {
    const fiction = navigationEntry({
      id: 'nav-1',
      itemId: 'nav-item-1',
      title: '小说分类',
      navigationUrl: 'https://books.example/opds/fiction',
    });
    const browse = vi.fn(async (_sourceId: string, url?: string) =>
      url === undefined ? feed({ entries: [entry, fiction] }) : feed(),
    );
    const base = dependencies();
    const deps = dependencies({
      opds: { ...base.opds, browse },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    await openCatalog(host);
    itemRow(host, 'item-1').click();
    await settle();
    expect(isShown(host.querySelector('.lightink-library-detail'))).toBe(true);
    expect(detailShowsRemove(host)).toBe(false);
    expect(deps.library.removeItem).not.toHaveBeenCalled();

    const remoteMenu = await tryOpenItemMenu(host, 'item-1');
    expect(remoteMenu?.textContent ?? '').not.toContain('移出书库');

    const navNode = catalogTreeNode(host, '小说分类');
    navNode.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
    );
    await settle();
    const navMenu = document.querySelector('.lightink-context-menu');
    expect(navMenu?.textContent ?? '').not.toContain('移出书库');
    expect(deps.library.removeItem).not.toHaveBeenCalled();
    view.destroy();
  });
});

describe('LibraryView sidebar width', () => {
  it('drags the expanded sidebar, persists the width, and restores it after remount and collapse', async () => {
    const store: Record<string, string> = {};
    const themeStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies({ themeStorage }));
    await view.show();

    const root = libraryRoot(host);
    expect(root.dataset.libraryNavCollapsed).toBe('false');
    const handle = resizeHandle(host);
    const before = navWidthToken(host);
    dragNavResize(handle, 240, 360);
    await settle();

    const saved = navWidthToken(host);
    expect(saved).not.toBe('');
    expect(saved).not.toBe(before);
    expect(saved.endsWith('px')).toBe(true);
    const persisted = persistedNavWidth(store);
    expect(persisted).toMatch(/\d/);
    expect(store['lightink.library.navCollapsed']).toBeUndefined();

    view.destroy();
    const nextHost = document.createElement('div');
    document.body.appendChild(nextHost);
    const next = createLibraryView(nextHost, dependencies({ themeStorage }));
    await next.show();
    expect(navWidthToken(nextHost)).toBe(saved);
    expect(libraryRoot(nextHost).dataset.libraryNavCollapsed).toBe('false');

    const toggle = nextHost.querySelector<HTMLButtonElement>('.lightink-library-nav-collapse')!;
    toggle.click();
    expect(libraryRoot(nextHost).dataset.libraryNavCollapsed).toBe('true');
    toggle.click();
    expect(libraryRoot(nextHost).dataset.libraryNavCollapsed).toBe('false');
    expect(navWidthToken(nextHost)).toBe(saved);
    next.destroy();
  });
});

describe('LibraryView touch long-press', () => {
  function touchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const points = point === null ? [] : [point];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
    Object.defineProperty(event, 'changedTouches', { value: points });
    return event;
  }

  async function waitLongPress(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
  }

  it('long-press on a cover card opens the same management context menu as right-click', async () => {
    const novel = localItem();
    const { deps } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const card = itemRow(host, novel.id);
    card.dispatchEvent(touchEvent('touchstart', { clientX: 20, clientY: 20 }));
    await waitLongPress();
    card.dispatchEvent(touchEvent('touchend', null));
    await settle();

    expect(document.querySelector('.lightink-context-menu')).not.toBeNull();
    expect(document.querySelector('.lightink-context-menu')?.textContent).toContain('移出书库');
    // 管理动作纯触控可达：无自定义分组时菜单项直达新建分组编辑器。
    contextMenuItem('加入分组').click();
    await settle();
    expect(groupFormOf(host)).toBeTruthy();
    view.destroy();
  });

  it('suppresses the trailing tap after a long-press (book is not opened)', async () => {
    const novel = localItem();
    const { deps } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const card = itemRow(host, novel.id);
    card.dispatchEvent(touchEvent('touchstart', { clientX: 20, clientY: 20 }));
    await waitLongPress();
    card.dispatchEvent(touchEvent('touchend', null));
    await settle();
    expect(document.querySelector('.lightink-context-menu')).not.toBeNull();

    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    expect(deps.onOpen).not.toHaveBeenCalled();
    view.destroy();
  });

  it('keeps a plain tap opening the book (long-press not fired)', async () => {
    const novel = localItem();
    const { deps } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();

    const card = itemRow(host, novel.id);
    card.dispatchEvent(touchEvent('touchstart', { clientX: 20, clientY: 20 }));
    card.dispatchEvent(touchEvent('touchend', null));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settle();
    expect(deps.onOpen).toHaveBeenCalled();
    expect(document.querySelector('.lightink-context-menu')).toBeNull();
    view.destroy();
  });

  it('long-press on a custom group row opens the group management context menu', async () => {
    const novel = localItem();
    const { deps } = collectionDependencies({ items: [novel] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, deps);
    await view.show();
    await startCreateGroup(host);
    await submitGroupForm(host, { name: '测试组' });

    const row = collectionRow(host, '测试组');
    row.dispatchEvent(touchEvent('touchstart', { clientX: 20, clientY: 20 }));
    await waitLongPress();
    row.dispatchEvent(touchEvent('touchend', null));
    await settle();

    expect(document.querySelector('.lightink-context-menu')).not.toBeNull();
    // 分组管理动作（重命名）纯触控可达。
    contextMenuItem('重命名分组').click();
    await settle();
    expect(groupFormOf(host)).toBeTruthy();
    view.destroy();
  });
});

describe('LibraryView mobile shelf', () => {
  it('replaces the drawer with a bottom tab bar gated to the ≤760px breakpoint', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    // 抽屉整体移除：不再有 hamburger / backdrop / drawer 状态样式。
    expect(css).not.toContain('lightink-library-nav-menu');
    expect(css).not.toContain('lightink-library-nav-backdrop');
    expect(css).not.toContain('data-library-drawer');
    // Tab 栏只在移动 chrome + ≤760px 断点出现；宽视口触屏桌面保持桌面侧栏。
    expect(css).toMatch(/\.lightink-library-tabbar\s*\{\s*display:\s*none/);
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-tabbar\s*\{[^}]*display:\s*grid/,
    );
    // 移动 chrome 窄屏下 body 纵向排布，导航成为页内区块而非 fixed 抽屉。
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-cover-wall\s*\{[^}]*repeat\(\s*2,\s*minmax\(0,\s*1fr\)/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-cover-wall\s*\{[^}]*overflow-y:\s*auto/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-cover-wall\s*\{[^}]*-webkit-overflow-scrolling:\s*touch/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-workarea\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/,
    );
    expect(css).not.toMatch(/--lightink-library-cover-min:\s*0px/);
    expect(css).not.toMatch(/--lightink-library-cover-max:\s*1fr/);
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-header[\s\S]*?\{[^}]*--lightink-safe-top/,
    );
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-header-main[\s\S]*?\{[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto auto/,
    );
    expect(css).toMatch(
      /\[data-library-nav-collapsed=['"]?true['"]?\]\s+\.lightink-library-header-main\s*\{[^}]*display:\s*grid/,
    );
    // 书架 Tab：页内导航整栏隐藏，封面落在 header 与底栏之间，不得再用 42vh 压在封面上。
    expect(css).toMatch(
      /\[data-library-nav=['"]?shelf['"]?\]\s+\.lightink-library-nav\s*\{[^}]*display:\s*none/,
    );
    expect(css).not.toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-nav\s*\{[^}]*max-height:\s*42vh/,
    );
    expect(css).toMatch(/\.lightink-library-shelf-chips\s*\{\s*display:\s*none/);
    expect(css).toMatch(
      /\[data-library-nav=['"]?shelf['"]?\]\s+\.lightink-library-shelf-chips\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*overflow:\s*visible/,
    );
    expect(css).toMatch(
      /\[data-library-nav=['"]?shelf['"]?\]\s+\.lightink-library-shelf-chip\s*\{[^}]*min-height:\s*44px/,
    );
    expect(css).toMatch(
      /\[data-library-tab=['"]?shelf['"]?\]\s+\.lightink-library-header-import\s*\{[^}]*display:\s*inline-flex/,
    );
    // 书源/目录：nav 与封面墙各自 overflow-y:auto，外层 body overflow:hidden。
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/,
    );
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-nav\s*\{[^}]*overflow-y:\s*auto/,
    );
    const itemsRule = css.match(/\.lightink-library-items\s*\{([^}]*)\}/);
    expect(itemsRule).not.toBeNull();
    expect(itemsRule![1]).toMatch(/overflow-y:\s*auto/);
    expect(css).not.toMatch(
      /\[data-library-nav=['"]?sources['"]?\]\s+\.lightink-library-nav\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)[\s\S]*\[data-library-nav=['"]?catalog['"]?\]\s+\.lightink-library-nav\s*\{[^}]*display:\s*none/,
    );
    // 管理面板：flex:1;min-height:0;overflow-y:auto，第一屏露出设置行。
    const managePanelRule = css.match(/\.lightink-library-manage-panel\s*\{([^}]*)\}/);
    expect(managePanelRule).not.toBeNull();
    expect(managePanelRule![1]).toMatch(/flex:\s*1/);
    expect(managePanelRule![1]).toMatch(/min-height:\s*0/);
    expect(managePanelRule![1]).toMatch(/overflow-y:\s*auto/);
    // 桌面双栏 grid 与无旗标路径保持不变。
    const bodyRule = css.match(/\.lightink-library-body\s*\{([^}]*)\}/);
    expect(bodyRule).not.toBeNull();
    expect(bodyRule![1]).toMatch(/display:\s*grid/);
    expect(bodyRule![1]).toMatch(/grid-template-columns/);
  });

  it('gives the manage dialogs near-full viewport width and compact UI type on phone chrome', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/library/library.css'), 'utf-8');
    // 分组/书源 dialog：移动断点下放宽宽度并接近全屏边距。
    expect(css).toMatch(
      /\.lightink-modal-overlay\.lightink-library-source-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(css).toMatch(
      /\.lightink-modal-overlay\.lightink-library-group-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(css).toMatch(
      /\.lightink-library-membership-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(css).toMatch(
      /\.lightink-modal-overlay\.lightink-library-cache-limit-modal\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\s*\{[^}]*--lightink-type-title:\s*1\.375rem[^}]*--lightink-type-body:\s*1rem[^}]*--lightink-type-ui:\s*0\.875rem[^}]*--lightink-type-caption:\s*0\.75rem/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\s*\.lightink-library-group-modal\s*\.lightink-modal-dialog,[\s\S]*?\.lightink-library-membership-dialog\s*\{[^}]*width:\s*calc\(100vw - 24px\)[^}]*max-width:\s*calc\(100vw - 24px\)[^}]*font-size:\s*var\(--lightink-type-ui\)/,
    );
    // 输入用 Material body-large（16px），避免 iOS 聚焦放大。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-group-form input,[\s\S]*?\.lightink-library-cache-limit-form input\s*\{[^}]*min-height:\s*44px[^}]*font-size:\s*var\(--lightink-type-body\)/,
    );
    // dialog 按钮与 membership 选项行保持 ≥44px 触控目标。
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-group-form-actions button,[\s\S]*?\.lightink-library-membership-actions button\s*\{[^}]*min-height:\s*44px/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-library-membership-options label\s*\{[^}]*min-height:\s*44px/,
    );
  });

  function tabButton(host: ParentNode, tab: string): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>(`[data-library-tab-item="${tab}"]`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`tab not found: ${tab}`);
    return button;
  }

  it('renders the bottom tab bar instead of the hamburger drawer under mobile chrome', async () => {
    document.documentElement.setAttribute('data-android', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies());
    await view.show();

    const root = libraryRoot(host);
    expect(host.querySelector('.lightink-library-nav-menu')).toBeNull();
    expect(host.querySelector('.lightink-library-nav-backdrop')).toBeNull();
    expect(root.dataset.libraryDrawer).toBeUndefined();
    expect(root.dataset.libraryNav).toBe('shelf');
    expect(root.dataset.libraryTab).toBe('shelf');
    expect(host.querySelector('.lightink-library-header h1')?.textContent).toBe('书架');
    expect(host.querySelector<HTMLElement>('.lightink-library-header h1')?.hidden).toBe(false);
    expect(isShown(host.querySelector('.lightink-library-cover-wall'))).toBe(true);
    expect(host.querySelector('.lightink-library-item--cover')).not.toBeNull();

    const tabbar = host.querySelector<HTMLElement>('.lightink-library-tabbar');
    expect(tabbar).not.toBeNull();
    const tabs = Array.from(
      tabbar!.querySelectorAll<HTMLButtonElement>('[data-library-tab-item]'),
    );
    expect(tabs.map((tab) => tab.dataset.libraryTabItem)).toEqual([
      'shelf',
      'sources',
      'manage',
    ]);
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      '书架',
      '书源',
      '管理',
    ]);
    expect(tabButton(host, 'shelf').getAttribute('aria-current')).toBe('page');
    view.destroy();
  });

  it('filters the cover wall from a one-row chip strip when the in-page nav is hidden', async () => {
    document.documentElement.setAttribute('data-android', '');
    const unread = localItem();
    const novel = localItem({
      id: 'local:/books/c.epub',
      title: '续读小说',
      localPath: '/books/c.epub',
    });
    const getProgress = vi.fn((item: LibraryProgressQuery) => {
      if (item.id === unread.id) return { status: 'not-started' as const };
      return { status: 'in-progress' as const, unit: 'chapter' as const, index: 2, ratio: 0.4, percent: 21 };
    });
    const base = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(
      host,
      dependencies({
        getProgress,
        library: { ...base.library, listItems: vi.fn(async () => [unread, novel]) },
      }),
    );
    await view.show();

    const content = libraryRoot(host).querySelector('.lightink-library-content');
    const chips = content?.querySelector<HTMLElement>('.lightink-library-shelf-chips');
    expect(chips).not.toBeNull();
    expect(chips?.hidden).toBe(false);
    expect(content?.contains(chips!)).toBe(true);
    expect(
      Array.from(chips!.querySelectorAll<HTMLButtonElement>('[data-shelf-group]')).map(
        (chip) => chip.dataset.shelfGroup,
      ),
    ).toEqual(['all', 'in-progress', 'unread', 'text', 'comic']);

    const reading = chips!.querySelector<HTMLButtonElement>('[data-shelf-group="in-progress"]');
    expect(reading).not.toBeNull();
    reading!.click();
    await settle();
    expect(host.querySelector(`[data-item-id="${unread.id}"]`)).toBeNull();
    expect(itemRow(host, novel.id).textContent).toContain('续读小说');
    expect(
      content
        ?.querySelector('[data-shelf-group="in-progress"]')
        ?.classList.contains('is-active'),
    ).toBe(true);

    tabButton(host, 'manage').click();
    await waitForShown(
      () => libraryRoot(host).dataset.libraryNav === 'manage',
      'manage section did not activate',
    );
    expect(host.querySelector('.lightink-library-content .lightink-library-shelf-chips')).toBeNull();
    view.destroy();
  });

  it('opens a catalog from the sources tab and returns to the source list', async () => {
    document.documentElement.setAttribute('data-android', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies());
    await view.show();

    const root = libraryRoot(host);
    tabButton(host, 'manage').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'manage',
      'manage section did not activate',
    );
    expect(root.dataset.libraryTab).toBe('manage');
    expect(host.querySelector('h1')?.textContent).toBe('管理');
    expect(isShown(host.querySelector('.lightink-library-manage-panel'))).toBe(true);
    expect(isShown(host.querySelector('.lightink-library-manage-row'))).toBe(true);
    expect(isShown(host.querySelector('.lightink-library-header-import'))).toBe(false);

    tabButton(host, 'sources').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'sources',
      'sources tab did not land on the source list',
    );
    expect(root.dataset.libraryTab).toBe('sources');
    expect(host.querySelector('h1')?.textContent).toBe('书库源');
    expect(isShown(host.querySelector('.lightink-library-header-import'))).toBe(false);
    expect(host.querySelector('.lightink-library-catalog-hint')).toBeNull();
    expect(host.querySelector('.lightink-library-nav')).not.toBeNull();
    expect(host.querySelector('.lightink-library-sources')).not.toBeNull();

    shownButtonWithText(host, '测试书库').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'catalog',
      'source catalog did not open',
    );
    expect(root.dataset.libraryTab).toBe('sources');
    expect(host.querySelector('h1')?.textContent).toBe('测试书库');
    expect(host.querySelector('.lightink-library-nav')).not.toBeNull();
    expect(host.querySelector('.lightink-library-items')).not.toBeNull();
    expect(host.querySelector('.lightink-library-back-to-shelf')?.textContent).toContain(
      '返回书源',
    );
    host.querySelector<HTMLButtonElement>('.lightink-library-back-to-shelf')!.click();
    await waitForShown(
      () => root.dataset.libraryNav === 'sources',
      'catalog back did not return to the source list',
    );
    expect(host.querySelector('h1')?.textContent).toBe('书库源');

    shownButtonWithText(host, '测试书库').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'catalog',
      'source catalog did not reopen from the list',
    );

    tabButton(host, 'sources').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'sources',
      'sources tab did not return to the source list',
    );
    expect(root.dataset.libraryTab).toBe('sources');
    expect(host.querySelector('h1')?.textContent).toBe('书库源');

    shownButtonWithText(host, '测试书库').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'catalog',
      'source catalog did not reopen',
    );
    tabButton(host, 'shelf').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'shelf',
      'shelf tab did not activate',
    );
    expect(root.dataset.libraryTab).toBe('shelf');
    expect(isShown(host.querySelector('.lightink-library-header-import'))).toBe(true);
    tabButton(host, 'sources').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'sources',
      'sources tab did not reopen the source list after leaving a catalog',
    );
    expect(root.dataset.libraryTab).toBe('sources');
    expect(host.querySelector('h1')?.textContent).toBe('书库源');
    expect(host.querySelector('.lightink-library-sources')).not.toBeNull();
    view.destroy();
  });

  it('puts navigation folders in the mobile cover wall and names catalog search after the source', async () => {
    document.documentElement.setAttribute('data-android', '');
    const fiction = navigationEntry({
      id: 'nav-1',
      itemId: 'nav-item-1',
      title: '小说分类',
      navigationUrl: 'https://books.example/opds/fiction',
    });
    const browse = vi.fn(async (_sourceId: string, url?: string) => {
      if (url === fiction.navigationUrl) {
        return feed({
          title: '小说',
          entries: [{ ...entry, id: 'entry-2', itemId: 'item-2', title: '分类小说' }],
        });
      }
      return feed({ entries: [fiction] });
    });
    const base = dependencies();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies({ opds: { ...base.opds, browse } }));
    await view.show();

    tabButton(host, 'sources').click();
    await waitForShown(
      () => libraryRoot(host).dataset.libraryNav === 'sources',
      'sources tab did not open',
    );
    shownButtonWithText(host, '测试书库').click();
    await waitForShown(
      () => libraryRoot(host).dataset.libraryNav === 'catalog',
      'source catalog did not open',
    );

    const search = host.querySelector<HTMLInputElement>('.lightink-library-search input');
    expect(search?.placeholder).toBe('搜索 测试书库');
    await waitForShown(
      () => host.querySelector('.lightink-library-cover-wall .lightink-library-catalog-folder') !== null,
      'catalog folders did not appear in the cover wall',
    );
    expect(host.querySelector('.lightink-library-cover-wall .lightink-library-catalog-folder')?.textContent).toContain(
      '小说分类',
    );
    expect(host.textContent).not.toContain('暂无作品');
    expect(host.textContent).not.toContain('No books found');

    host.querySelector<HTMLButtonElement>('.lightink-library-catalog-folder')!.click();
    await settle();
    expect(browse).toHaveBeenCalledWith('source-1', fiction.navigationUrl);
    expect(host.textContent).toContain('分类小说');
    expect(host.querySelector('h1')?.textContent).toBe('小说分类');

    host.querySelector<HTMLButtonElement>('.lightink-library-back-to-shelf')!.click();
    await settle();
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    expect(host.querySelector('.lightink-library-catalog-folder')?.textContent).toContain('小说分类');
    expect(host.querySelector('.lightink-library-back-to-shelf')?.textContent).toContain('返回书源');
    view.destroy();
  });

  it('closes the mobile book-details sheet with the close control, backdrop, and Escape', async () => {
    document.documentElement.setAttribute('data-android', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies());
    await view.show();

    await openCatalog(host);
    itemRow(host, 'item-1').click();
    await settle();
    const pane = host.querySelector<HTMLElement>('.lightink-library-detail');
    const backdrop = host.querySelector<HTMLElement>('.lightink-library-detail-backdrop');
    expect(pane instanceof HTMLElement && isShown(pane)).toBe(true);
    expect(backdrop instanceof HTMLElement && backdrop.hidden).toBe(false);
    expect(pane?.querySelector('.lightink-library-detail-close')?.getAttribute('aria-label')).toBe(
      '关闭',
    );

    host.querySelector<HTMLButtonElement>('.lightink-library-detail-close')!.click();
    expect(isShown(pane)).toBe(false);
    expect(backdrop?.hidden).toBe(true);

    itemRow(host, 'item-1').click();
    await settle();
    expect(isShown(pane)).toBe(true);
    backdrop!.click();
    expect(isShown(pane)).toBe(false);

    itemRow(host, 'item-1').click();
    await settle();
    const consumed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    libraryRoot(host).dispatchEvent(consumed);
    expect(consumed.defaultPrevented).toBe(true);
    expect(isShown(pane)).toBe(false);
    expect(libraryRoot(host).dataset.libraryNav).toBe('catalog');
    view.destroy();
  });

  it('opens the cache limit as a dialog that Escape (Android back) consumes', async () => {
    document.documentElement.setAttribute('data-android', '');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies());
    await view.show();

    const root = libraryRoot(host);
    tabButton(host, 'manage').click();
    await waitForShown(
      () => root.dataset.libraryNav === 'manage',
      'manage section did not activate',
    );

    host.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    const panel = host.querySelector<HTMLElement>('.lightink-library-manage-panel')!;
    const overlay = document.querySelector<HTMLElement>('.lightink-library-cache-limit-modal')!;
    expect(panel.dataset.managePage).toBe('cache-limit');
    expect(isShown(overlay)).toBe(true);
    expect(overlay.parentElement).toBe(document.body);
    expect(isShown(panel.querySelector('.lightink-library-manage-home'))).toBe(true);

    // 弹层打开时合成 Escape（Android 返回）被消费，关掉弹层。
    const input = overlay.querySelector<HTMLInputElement>('input[name="cacheLimitGiB"]')!;
    const consumed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(consumed);
    expect(consumed.defaultPrevented).toBe(true);
    expect(panel.dataset.managePage).toBe('home');
    expect(isShown(overlay)).toBe(false);

    // 弹层未打开时不消费，交还分层链（书架顶层 → 系统默认）。
    const passthrough = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    panel.dispatchEvent(passthrough);
    expect(passthrough.defaultPrevented).toBe(false);

    // 取消按钮同样关掉弹层。
    host.querySelector<HTMLButtonElement>('[aria-label="调整缓存上限"]')!.click();
    expect(isShown(overlay)).toBe(true);
    overlay.querySelector<HTMLButtonElement>('.lightink-library-cache-limit-cancel')!.click();
    expect(isShown(overlay)).toBe(false);
    expect(isShown(panel.querySelector('.lightink-library-manage-home'))).toBe(true);
    view.destroy();
  });

  it('does not mount the tab bar without the mobile chrome flags', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createLibraryView(host, dependencies());
    await view.show();

    expect(host.querySelector('.lightink-library-tabbar')).toBeNull();
    expect(host.querySelector('.lightink-library-nav-menu')).toBeNull();
    expect(libraryRoot(host).dataset.libraryNav).toBe('shelf');
    view.destroy();
  });
});
