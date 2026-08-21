import type {
  AcquisitionLink,
  LibraryClient,
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
} from './library-client.js';
import {
  canPlaceGroup,
  customGroupTree,
  itemIdsForGroup,
  keyboardGroupPlacement,
  type GroupKeyboardMove,
  type LibraryGroupNode,
} from './library-group-tree.js';
import {
  dynamicAuthorAndSeriesGroups,
  dynamicSourceAndFormatGroups,
  SMART_GROUP_DEFINITIONS,
  smartGroupMatches,
  smartGroupFromRecord,
  type SmartGroupDefinition,
} from './library-smart-groups.js';
import { classifyLibraryKind } from './library-kind.js';
import { isShelfCoverUrl } from './local-book-meta.js';
import {
  coverProgressFillPercent,
  type LibraryProgress,
  type LibraryProgressQuery,
  type ProjectLibraryProgressOptions,
} from './library-progress.js';
import type {
  OpdsClient,
  OpdsEntry,
  OpdsFeed,
  OpdsLink,
  OpdsSource,
  OpdsSourceInput,
} from './opds-client.js';
import type { ProgressStorage } from '../reader/reading-progress.js';
import { createContextMenu, type MenuItem } from '../ui/context-menu.js';
import type { SyncProfile, WebDavClient } from '../sync/webdav-client.js';

type Locale = 'en' | 'zh-CN';
type LibrarySection = 'shelf' | 'sources' | 'manage';
type ShelfGroup = 'all' | 'in-progress' | 'unread' | 'text' | 'comic';

interface Labels {
  library: string;
  myBooks: string;
  manage: string;
  backToShelf: string;
  groups: string;
  all: string;
  inReading: string;
  unread: string;
  textBooks: string;
  comics: string;
  allBooks: string;
  sources: string;
  addSource: string;
  editSource: string;
  sourceKind: string;
  opdsSource: string;
  webdavSource: string;
  webdavUrl: string;
  webdavSync: string;
  webdavSaved: string;
  editWebDav: string;
  importLocal: string;
  search: string;
  searchPlaceholder: string;
  clear: string;
  empty: string;
  emptySearch: string;
  emptyFilter: string;
  emptySources: string;
  loading: string;
  retry: string;
  open: string;
  cacheBook: string;
  caching: string;
  downloadBook: string;
  downloadingBook: string;
  keepOffline: string;
  removeOffline: string;
  keepGroupOffline: string;
  removeGroupOffline: string;
  remove: string;
  clearCache: string;
  cacheUsage: string;
  cacheLimit: string;
  changeCacheLimit: string;
  apply: string;
  title: string;
  url: string;
  allowHttp: string;
  auth: string;
  none: string;
  keepAuth: string;
  basic: string;
  bearer: string;
  username: string;
  password: string;
  token: string;
  save: string;
  cancel: string;
  deleteSource: string;
  prev: string;
  next: string;
  noAcquisition: string;
  offline: string;
  details: string;
  local: string;
  series: string;
  number: string;
  volume: string;
  pages: string;
  direction: string;
  directionLtr: string;
  directionRtl: string;
  coverPage: string;
  notStarted: string;
  continueReading: string;
  dismissContinue: string;
  addToGroup: string;
  markdownEditor: string;
  readPercent: string;
  pageProgress: string;
  chapterProgress: string;
  newGroup: string;
  addChildGroup: string;
  renameGroup: string;
  deleteGroup: string;
  deleteGroupConfirm: string;
  groupName: string;
  groupParent: string;
  rootGroup: string;
  moveUp: string;
  moveDown: string;
  outdent: string;
  indent: string;
  editGroup: string;
  organizeBook: string;
  saveGroups: string;
  noCustomGroups: string;
  invalidGroupMove: string;
  smartGroups: string;
  managedBooks: string;
  remoteBooks: string;
  epubBooks: string;
  pdfBooks: string;
  authorGroup: string;
  seriesGroup: string;
  sourceGroup: string;
  formatGroup: string;
}

const LABELS: Record<Locale, Labels> = {
  en: {
    library: 'Library',
    myBooks: 'My books',
    manage: 'Manage',
    backToShelf: 'Back to shelf',
    groups: 'Collections',
    all: 'All',
    inReading: 'Reading',
    unread: 'Unread',
    textBooks: 'Text',
    comics: 'Comics',
    allBooks: 'All books',
    sources: 'Sources',
    addSource: 'Add library source',
    editSource: 'Edit OPDS source',
    sourceKind: 'Source type',
    opdsSource: 'OPDS',
    webdavSource: 'WebDAV',
    webdavUrl: 'WebDAV URL',
    webdavSync: 'WebDAV sync',
    webdavSaved: 'WebDAV settings saved',
    editWebDav: 'Edit WebDAV',
    importLocal: 'Import local book',
    search: 'Search',
    searchPlaceholder: 'Search this library',
    clear: 'Clear',
    empty: 'No books found',
    emptySearch: 'No matching books',
    emptyFilter: 'Nothing in this view',
    emptySources: 'No library sources yet. Use + to add one.',
    loading: 'Loading…',
    retry: 'Retry',
    open: 'Open',
    cacheBook: 'Cache book',
    caching: 'Caching…',
    downloadBook: 'Download book',
    downloadingBook: 'Downloading…',
    keepOffline: 'Keep offline',
    removeOffline: 'Remove offline copy',
    keepGroupOffline: 'Keep group offline',
    removeGroupOffline: 'Stop keeping group offline',
    remove: 'Remove from library',
    clearCache: 'Clear cache',
    cacheUsage: '{used} of {limit}',
    cacheLimit: 'Cache limit (GiB)',
    changeCacheLimit: 'Change cache limit',
    apply: 'Apply',
    title: 'Name',
    url: 'Catalog URL',
    allowHttp: 'Allow HTTP/LAN source',
    auth: 'Authentication',
    none: 'None',
    keepAuth: 'Keep current authentication',
    basic: 'Basic',
    bearer: 'Bearer',
    username: 'Username',
    password: 'Password',
    token: 'Token',
    save: 'Save',
    cancel: 'Cancel',
    deleteSource: 'Remove source',
    prev: 'Previous',
    next: 'Next',
    noAcquisition: 'No supported acquisition link',
    offline: 'Could not reach this source.',
    details: 'Book details',
    local: 'Local',
    series: 'Series',
    number: 'Number',
    volume: 'Volume',
    pages: 'Pages',
    direction: 'Reading direction',
    directionLtr: 'Left to right',
    directionRtl: 'Right to left',
    coverPage: 'Cover page',
    notStarted: 'Not started',
    continueReading: 'Continue reading',
    dismissContinue: 'Dismiss',
    addToGroup: 'Add to group',
    markdownEditor: 'Markdown editor',
    readPercent: '{percent}% read',
    pageProgress: 'Page {current}',
    chapterProgress: 'Chapter {current}',
    newGroup: 'New group',
    addChildGroup: 'Add child group',
    renameGroup: 'Rename group',
    deleteGroup: 'Delete group',
    deleteGroupConfirm: 'Delete “{name}”? Its child groups will move up one level.',
    groupName: 'Group name',
    groupParent: 'Parent group',
    rootGroup: 'Top level',
    moveUp: 'Move up',
    moveDown: 'Move down',
    outdent: 'Move out one level',
    indent: 'Move into previous group',
    editGroup: 'Group actions',
    organizeBook: 'Organize into groups',
    saveGroups: 'Save groups',
    noCustomGroups: 'Create a custom group first.',
    invalidGroupMove: 'Groups cannot form a cycle or exceed 8 levels.',
    smartGroups: 'Smart groups',
    managedBooks: 'Managed books',
    remoteBooks: 'Remote books',
    epubBooks: 'EPUB books',
    pdfBooks: 'PDF books',
    authorGroup: 'Author: {name}',
    seriesGroup: 'Series: {name}',
    sourceGroup: 'Source: {name}',
    formatGroup: 'Format: {name}',
  },
  'zh-CN': {
    library: '书库',
    myBooks: '我的书',
    manage: '管理',
    backToShelf: '返回书架',
    groups: '分组',
    all: '全部',
    inReading: '在读',
    unread: '未读',
    textBooks: '文字书',
    comics: '漫画',
    allBooks: '全部作品',
    sources: '书库源',
    addSource: '添加书库源',
    editSource: '编辑 OPDS 源',
    sourceKind: '源类型',
    opdsSource: 'OPDS',
    webdavSource: 'WebDAV',
    webdavUrl: 'WebDAV 地址',
    webdavSync: 'WebDAV 同步',
    webdavSaved: 'WebDAV 设置已保存',
    editWebDav: '编辑 WebDAV',
    importLocal: '导入本地书籍',
    search: '搜索',
    searchPlaceholder: '搜索当前书库',
    clear: '清除',
    empty: '暂无作品',
    emptySearch: '没有匹配的作品',
    emptyFilter: '这一组还没有作品',
    emptySources: '还没有书库源，点 + 添加。',
    loading: '正在加载…',
    retry: '重试',
    open: '打开阅读',
    cacheBook: '缓存整本',
    caching: '正在缓存…',
    downloadBook: '下载正文',
    downloadingBook: '正在下载…',
    keepOffline: '保留离线',
    removeOffline: '取消离线保留',
    keepGroupOffline: '整组保留离线',
    removeGroupOffline: '取消整组离线保留',
    remove: '移出书库',
    clearCache: '清理缓存',
    cacheUsage: '已用 {used} / {limit}',
    cacheLimit: '缓存上限（GiB）',
    changeCacheLimit: '调整缓存上限',
    apply: '应用',
    title: '名称',
    url: '目录地址',
    allowHttp: '允许 HTTP/LAN 源',
    auth: '鉴权',
    none: '无',
    keepAuth: '保留现有鉴权',
    basic: 'Basic',
    bearer: 'Bearer',
    username: '用户名',
    password: '密码',
    token: '令牌',
    save: '保存',
    cancel: '取消',
    deleteSource: '删除源',
    prev: '上一页',
    next: '下一页',
    noAcquisition: '没有可用的获取链接',
    offline: '无法连接此书库源。',
    details: '作品详情',
    local: '本地',
    series: '系列',
    number: '序号',
    volume: '卷',
    pages: '页数',
    direction: '阅读方向',
    directionLtr: '从左到右',
    directionRtl: '从右到左',
    coverPage: '封面页',
    notStarted: '未开始',
    continueReading: '继续阅读',
    dismissContinue: '关闭',
    addToGroup: '加入分组',
    markdownEditor: 'Markdown 编辑',
    readPercent: '已读 {percent}%',
    pageProgress: '第 {current} 页',
    chapterProgress: '第 {current} 章',
    newGroup: '新建分组',
    addChildGroup: '新建子组',
    renameGroup: '重命名分组',
    deleteGroup: '删除分组',
    deleteGroupConfirm: '删除“{name}”？其子组将提升一级。',
    groupName: '分组名称',
    groupParent: '上级分组',
    rootGroup: '顶层',
    moveUp: '上移',
    moveDown: '下移',
    outdent: '提升一级',
    indent: '移入上一个分组',
    editGroup: '分组操作',
    organizeBook: '整理到分组',
    saveGroups: '保存分组',
    noCustomGroups: '请先创建自定义分组。',
    invalidGroupMove: '分组不能形成循环或超过 8 层。',
    smartGroups: '智能分组',
    managedBooks: '受管书籍',
    remoteBooks: '远程书籍',
    epubBooks: 'EPUB',
    pdfBooks: 'PDF',
    authorGroup: '作者：{name}',
    seriesGroup: '系列：{name}',
    sourceGroup: '来源：{name}',
    formatGroup: '格式：{name}',
  },
};

export interface LibraryOpenRequest {
  readonly item: LibraryItem;
  readonly acquisition?: AcquisitionLink;
  readonly source?: OpdsSource;
}

export interface LibraryViewDependencies {
  readonly opds: Pick<
    OpdsClient,
    'addSource' | 'listSources' | 'removeSource' | 'browse' | 'search'
  >;
  readonly library: Pick<
    LibraryClient,
    | 'listItems'
    | 'listAcquisitionLinks'
    | 'removeItem'
    | 'clearCache'
    | 'setCacheLimit'
    | 'cacheStats'
  > &
    Partial<
      Pick<
        LibraryClient,
        | 'listGroups'
        | 'createGroup'
        | 'updateGroup'
        | 'moveGroup'
        | 'deleteGroup'
        | 'listGroupMemberships'
        | 'setGroupMember'
        | 'setItemGroups'
        | 'setOfflinePinned'
      >
    >;
  readonly getLocale: () => Locale;
  readonly onOpen: (request: LibraryOpenRequest, signal?: AbortSignal) => Promise<void>;
  readonly onCache: (request: LibraryOpenRequest, signal?: AbortSignal) => Promise<void>;
  /** Download a synced managed book body and return its local materialized path. */
  readonly onDownload?: (item: LibraryItem, signal?: AbortSignal) => Promise<string | void>;
  readonly onImportLocal: () => Promise<LibraryItem | null>;
  readonly notify: (message: string, kind?: 'error' | 'warning') => void;
  /** Schedule the debounced snapshot sync after a library metadata mutation. */
  readonly onLocalChange?: () => void;
  readonly onVisibilityChange?: (visible: boolean) => void;
  /** Shelf projection. Catalog rows pass `{ catalogEntry: true }`. */
  readonly getProgress?: (
    item: LibraryProgressQuery,
    options?: ProjectLibraryProgressOptions,
  ) => LibraryProgress | null;
  /** Workspace travel control owned by the app shell (「编辑」). */
  readonly workspaceTravel?: HTMLElement;
  /** Fill missing local EPUB/CBZ title and cover after import or cold start. */
  readonly enrichLocalItem?: (item: LibraryItem) => Promise<LibraryItem>;
  readonly confirmGroupDelete?: (group: LibraryGroup, message: string) => Promise<boolean>;
  /** Persist dismissed continue-reading fingerprints. */
  readonly progressStorage?: ProgressStorage | null;
  /** Open the Markdown editor from Manage. */
  readonly onEnterEditor?: () => void;
  readonly webdav?: Pick<WebDavClient, 'getProfile' | 'saveProfile' | 'forgetProfile'>;
  readonly onOpenSyncPanel?: () => void;
}

export const CONTINUE_DISMISS_KEY = 'lightink.library.continueDismissed';

export interface LibraryHideOptions {
  /** When false, conceal the shelf without leaving the reader workspace. */
  readonly notifyVisibility?: boolean;
}

export interface LibraryView {
  readonly element: HTMLElement;
  readonly visible: boolean;
  show(): Promise<void>;
  hide(options?: LibraryHideOptions): void;
  toggle(): Promise<void>;
  refresh(): Promise<void>;
  retranslate(): void;
  destroy(): void;
}

interface DisplayItem {
  readonly item: LibraryItem;
  readonly entry?: OpdsEntry;
  readonly links: readonly AcquisitionLink[];
  readonly catalogGroupKey?: string;
  readonly catalogGroupTitle?: string;
}

function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

function acquisitionFromOpds(itemId: string, link: OpdsLink): AcquisitionLink {
  return {
    itemId,
    href: link.href,
    rel: link.rel,
    mediaType: link.mediaType,
    extension: link.extension,
    size: link.size,
  };
}

function itemFromEntry(sourceId: string, entry: OpdsEntry): DisplayItem {
  const itemId = entry.itemId ?? `opds:${sourceId}:${entry.id}`;
  const links = entry.links
    .filter((link) => link.acquisition)
    .map((link) => acquisitionFromOpds(itemId, link));
  const primary = links[0];
  return {
    item: {
      id: itemId,
      sourceId,
      sourceKind: 'opds',
      title: entry.title,
      authors: entry.authors,
      coverUrl: entry.coverUrl,
      subjects: entry.subjects,
      series: entry.series,
      acquisitionUrl: primary?.href,
      mediaType: primary?.mediaType,
      extension: primary?.extension,
      size: primary?.size,
      updatedAt: Date.now(),
    },
    entry,
    links,
  };
}

function itemsFromFeed(sourceId: string, feed: OpdsFeed): DisplayItem[] {
  const displays = feed.entries.map((entry) => itemFromEntry(sourceId, entry));
  for (const [index, group] of (feed.groups ?? []).entries()) {
    const entries = [...(group.publications ?? []), ...group.navigation];
    for (const entry of entries) {
      displays.push({
        ...itemFromEntry(sourceId, entry),
        catalogGroupKey: `opds-group-${index}`,
        catalogGroupTitle: group.title,
      });
    }
  }
  return displays;
}

function safeCoverUrl(item: LibraryItem, sources: readonly OpdsSource[]): string | undefined {
  if (!isShelfCoverUrl(item.coverUrl)) return undefined;
  if (item.coverUrl!.startsWith('data:image/') || item.coverUrl!.startsWith('blob:')) {
    return item.coverUrl;
  }
  try {
    const url = new URL(item.coverUrl!);
    if (url.protocol === 'https:') return url.href;
    const source = sources.find((candidate) => candidate.id === item.sourceId);
    return url.protocol === 'http:' && source?.allowHttp === true ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isDisplayablePercent(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function displayLocation(progress: Extract<LibraryProgress, { status: 'in-progress' }>): {
  readonly kind: 'page' | 'chapter';
  readonly current: number;
} | null {
  if (!Number.isSafeInteger(progress.index) || progress.index < 0) {
    return null;
  }
  if (progress.unit === 'chapter') {
    return { kind: 'chapter', current: progress.index + 1 };
  }
  return { kind: 'page', current: progress.index < 1 ? 1 : progress.index };
}

function isTransportError(text: string): boolean {
  return /error sending request|failed to fetch|network error|connection refused|timed out|dns|reading 'invoke'|cannot read properties of undefined/i.test(
    text,
  );
}

function errorText(error: unknown, fallback: string): string {
  let message = '';
  if (error !== null && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    if (typeof value['message'] === 'string' && value['message'].trim() !== '') {
      message = value['message'];
    }
  }
  if (message === '' && error instanceof Error && error.message !== '') {
    message = error.message;
  }
  if (message === '' || isTransportError(message)) {
    return fallback;
  }
  return message;
}

function button(doc: Document, text: string, className = ''): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

function itemTitle(item: LibraryItem): string {
  return typeof item.title === 'string' ? item.title : '';
}

function itemAuthors(item: LibraryItem): readonly string[] {
  return Array.isArray(item.authors) ? item.authors : [];
}

function isLocalItem(item: LibraryItem): boolean {
  return item.sourceKind === 'local' || item.sourceKind === 'managed';
}

function isManagedItem(item: LibraryItem): boolean {
  return item.sourceKind === 'managed' && item.blobHash != null && item.blobHash !== '';
}

function isManagedBodyAvailable(item: LibraryItem): boolean {
  return (
    isManagedItem(item) &&
    item.localPath != null &&
    item.localPath !== '' &&
    item.availability === 'local'
  );
}

const SHELF_GROUPS: readonly ShelfGroup[] = ['all', 'in-progress', 'unread', 'text', 'comic'];

function groupLabel(labels: Labels, group: ShelfGroup): string {
  switch (group) {
    case 'all':
      return labels.all;
    case 'in-progress':
      return labels.inReading;
    case 'unread':
      return labels.unread;
    case 'text':
      return labels.textBooks;
    case 'comic':
      return labels.comics;
  }
}

export function createLibraryView(
  host: HTMLElement,
  deps: LibraryViewDependencies,
  doc: Document = document,
): LibraryView {
  const root = doc.createElement('section');
  root.className = 'lightink-library lightink-library--workspace';
  root.hidden = true;
  root.dataset.workspaceHome = 'true';
  root.dataset.libraryNav = 'shelf';
  root.setAttribute('aria-label', LABELS[deps.getLocale()].library);

  const header = doc.createElement('header');
  header.className = 'lightink-library-header';
  const heading = doc.createElement('h1');
  const searchForm = doc.createElement('form');
  searchForm.className = 'lightink-library-search';
  searchForm.setAttribute('role', 'search');
  const searchInput = doc.createElement('input');
  searchInput.type = 'text';
  searchInput.setAttribute('role', 'searchbox');
  const searchButton = button(doc, '', 'lightink-library-search-submit');
  searchButton.type = 'submit';
  searchButton.tabIndex = -1;
  searchButton.setAttribute('aria-hidden', 'true');
  const searchClear = button(doc, '×', 'lightink-library-icon-button lightink-library-search-clear');
  searchClear.type = 'button';
  searchClear.hidden = true;
  searchForm.append(searchInput, searchClear, searchButton);
  const toolbar = doc.createElement('div');
  toolbar.className = 'lightink-library-toolbar';
  const importButton = button(doc, '');
  const clearCacheButton = button(doc, '');
  const editorButton = button(doc, '', 'lightink-library-editor-entry');
  const syncButton = button(doc, '', 'lightink-library-sync-entry');
  const manageNavButton = button(doc, '', 'lightink-library-nav-item lightink-library-manage-entry');
  manageNavButton.dataset.libraryNavItem = 'manage';
  const myBooksButton = button(doc, '', 'lightink-library-nav-item lightink-library-home');
  myBooksButton.dataset.libraryNavItem = 'my-books';
  header.append(heading, searchForm, toolbar);

  const body = doc.createElement('div');
  body.className = 'lightink-library-body';
  const navPane = doc.createElement('aside');
  navPane.className = 'lightink-library-nav';
  const groupPane = doc.createElement('section');
  groupPane.className = 'lightink-library-groups lightink-library-nav-section';
  groupPane.dataset.navSection = 'shelf';
  const shelfHeading = doc.createElement('h2');
  shelfHeading.className = 'lightink-library-nav-heading';
  const filterList = doc.createElement('nav');
  filterList.className = 'lightink-library-filter-list';
  const groupHeader = doc.createElement('div');
  groupHeader.className = 'lightink-library-pane-heading';
  const groupTitle = doc.createElement('h2');
  const addGroupButton = button(doc, '+', 'lightink-library-icon-button lightink-library-group-add');
  groupHeader.append(groupTitle, addGroupButton);
  const groupList = doc.createElement('nav');
  groupList.className = 'lightink-library-group-list';
  const smartGroupHeader = doc.createElement('div');
  smartGroupHeader.className = 'lightink-library-pane-heading';
  const smartGroupTitle = doc.createElement('h3');
  smartGroupHeader.append(smartGroupTitle);
  const smartGroupList = doc.createElement('nav');
  smartGroupList.className = 'lightink-library-smart-group-list';
  groupPane.append(
    shelfHeading,
    myBooksButton,
    filterList,
    groupHeader,
    groupList,
    smartGroupHeader,
    smartGroupList,
  );
  const groupOverlay = doc.createElement('div');
  groupOverlay.className = 'lightink-modal-overlay lightink-library-group-modal';
  groupOverlay.hidden = true;
  const groupDialog = doc.createElement('div');
  groupDialog.className = 'lightink-modal-dialog';
  groupDialog.setAttribute('role', 'dialog');
  groupDialog.setAttribute('aria-modal', 'true');
  const groupEditor = doc.createElement('form');
  groupEditor.className = 'lightink-library-group-form';
  const groupNameLabel = doc.createElement('label');
  groupNameLabel.className = 'lightink-library-field';
  const groupNameLabelText = doc.createElement('span');
  const groupNameInput = doc.createElement('input');
  groupNameInput.name = 'name';
  groupNameInput.maxLength = 80;
  groupNameInput.required = true;
  groupNameLabel.append(groupNameLabelText, groupNameInput);
  const groupParentLabel = doc.createElement('label');
  groupParentLabel.className = 'lightink-library-field';
  const groupParentLabelText = doc.createElement('span');
  const groupParentSelect = doc.createElement('select');
  groupParentSelect.name = 'parentId';
  groupParentLabel.append(groupParentLabelText, groupParentSelect);
  const groupEditorActions = doc.createElement('div');
  groupEditorActions.className = 'lightink-library-group-form-actions';
  const groupEditorSave = button(doc, '', 'lightink-library-primary');
  groupEditorSave.type = 'submit';
  const groupEditorCancel = button(doc, '');
  groupEditorActions.append(groupEditorSave, groupEditorCancel);
  groupEditor.append(groupNameLabel, groupParentLabel, groupEditorActions);
  groupDialog.appendChild(groupEditor);
  groupOverlay.appendChild(groupDialog);
  const sourcePane = doc.createElement('section');
  sourcePane.className = 'lightink-library-sources lightink-library-nav-section';
  sourcePane.dataset.navSection = 'sources';
  const sourceHeader = doc.createElement('div');
  sourceHeader.className = 'lightink-library-pane-heading';
  const sourceTitle = doc.createElement('h2');
  const addSourceButton = button(doc, '+', 'lightink-library-icon-button');
  sourceHeader.append(sourceTitle, addSourceButton);
  const sourceList = doc.createElement('nav');
  sourceList.className = 'lightink-library-source-list';
  sourcePane.append(sourceHeader, sourceList);
  const managePane = doc.createElement('section');
  managePane.className = 'lightink-library-manage lightink-library-nav-section';
  managePane.dataset.navSection = 'manage';
  const manageNav = doc.createElement('nav');
  manageNav.className = 'lightink-library-manage-nav';
  manageNav.append(manageNavButton);
  managePane.append(manageNav);
  navPane.append(groupPane, sourcePane, managePane);
  const sourceOverlay = doc.createElement('div');
  sourceOverlay.className = 'lightink-modal-overlay lightink-library-source-modal';
  sourceOverlay.hidden = true;
  const sourceDialog = doc.createElement('div');
  sourceDialog.className = 'lightink-modal-dialog';
  sourceDialog.setAttribute('role', 'dialog');
  sourceDialog.setAttribute('aria-modal', 'true');
  const sourceForm = doc.createElement('form');
  sourceForm.className = 'lightink-library-source-form';
  sourceDialog.appendChild(sourceForm);
  sourceOverlay.appendChild(sourceDialog);

  const content = doc.createElement('main');
  content.className = 'lightink-library-content';
  const navigation = doc.createElement('div');
  navigation.className = 'lightink-library-navigation';
  const breadcrumbs = doc.createElement('nav');
  breadcrumbs.className = 'lightink-library-breadcrumbs';
  breadcrumbs.setAttribute('aria-label', 'Breadcrumb');
  const pager = doc.createElement('div');
  pager.className = 'lightink-library-pager';
  const previousButton = button(doc, '');
  const nextButton = button(doc, '');
  pager.append(previousButton, nextButton);
  navigation.append(breadcrumbs, pager);
  const cacheSummary = doc.createElement('div');
  cacheSummary.className = 'lightink-library-cache-summary';
  const cacheUsage = doc.createElement('span');
  const cacheLimitButton = button(doc, '⚙', 'lightink-library-icon-button');
  const cacheLimitForm = doc.createElement('form');
  cacheLimitForm.className = 'lightink-library-cache-limit-form';
  cacheLimitForm.hidden = true;
  const cacheLimitLabel = doc.createElement('label');
  const cacheLimitLabelText = doc.createElement('span');
  const cacheLimitInput = doc.createElement('input');
  cacheLimitInput.type = 'number';
  cacheLimitInput.name = 'cacheLimitGiB';
  cacheLimitInput.min = '0.25';
  cacheLimitInput.max = '1024';
  cacheLimitInput.step = '0.25';
  cacheLimitInput.required = true;
  cacheLimitLabel.className = 'lightink-library-field';
  cacheLimitLabel.append(cacheLimitLabelText, cacheLimitInput);
  const cacheLimitSave = button(doc, '', 'lightink-library-primary');
  cacheLimitSave.type = 'submit';
  cacheLimitForm.append(cacheLimitLabel, cacheLimitSave);
  cacheSummary.append(cacheUsage, cacheLimitButton, cacheLimitForm);
  const status = doc.createElement('div');
  status.className = 'lightink-library-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  const retryButton = button(doc, '');
  retryButton.hidden = true;
  status.append(retryButton);
  const continueHost = doc.createElement('div');
  continueHost.className = 'lightink-library-continue';
  continueHost.hidden = true;
  const workArea = doc.createElement('div');
  workArea.className = 'lightink-library-workarea';
  const itemList = doc.createElement('div');
  itemList.className = 'lightink-library-items';
  itemList.setAttribute('role', 'listbox');
  itemList.tabIndex = 0;
  const detail = doc.createElement('aside');
  detail.className = 'lightink-library-detail';
  detail.hidden = true;
  workArea.append(itemList, detail);
  const managePanel = doc.createElement('div');
  managePanel.className = 'lightink-library-manage-panel';
  managePanel.append(
    importButton,
    clearCacheButton,
    cacheSummary,
    ...(deps.onOpenSyncPanel === undefined ? [] : [syncButton]),
    ...(deps.onEnterEditor === undefined ? [] : [editorButton]),
  );
  body.append(navPane, content);
  const membershipOverlay = doc.createElement('div');
  membershipOverlay.className = 'lightink-library-membership-overlay';
  membershipOverlay.hidden = true;
  const membershipForm = doc.createElement('form');
  membershipForm.className = 'lightink-library-membership-dialog';
  membershipForm.setAttribute('role', 'dialog');
  membershipForm.setAttribute('aria-modal', 'true');
  const membershipTitle = doc.createElement('h2');
  const membershipOptions = doc.createElement('div');
  membershipOptions.className = 'lightink-library-membership-options';
  const membershipActions = doc.createElement('div');
  membershipActions.className = 'lightink-library-membership-actions';
  const membershipSave = button(doc, '', 'lightink-library-primary');
  membershipSave.type = 'submit';
  const membershipCancel = button(doc, '');
  membershipActions.append(membershipSave, membershipCancel);
  membershipForm.append(membershipTitle, membershipOptions, membershipActions);
  membershipOverlay.appendChild(membershipForm);
  root.append(header, body, membershipOverlay, groupOverlay, sourceOverlay);
  host.appendChild(root);

  let activeSection: LibrarySection = 'shelf';
  let selectedGroup: ShelfGroup = 'all';
  let selectedCustomGroupId: string | null = null;
  let groups: LibraryGroup[] = [];
  let memberships: LibraryGroupMembership[] = [];
  let smartGroups: SmartGroupDefinition[] = [...SMART_GROUP_DEFINITIONS];
  let selectedSmartGroupId: string | null = null;
  const expandedGroupIds = new Set<string>();
  let groupEditorMode:
    | { readonly kind: 'create'; readonly parentId?: string }
    | { readonly kind: 'rename'; readonly groupId: string }
    | null = null;
  let groupActionsId: string | null = null;
  let membershipItemId: string | null = null;
  let pendingAddItemId: string | null = null;
  let ignoreGroupBackdrop = false;
  let ignoreSourceBackdrop = false;
  let sources: OpdsSource[] = [];
  let selectedSourceId: string | null = null;
  let editingSourceId: string | null = null;
  let editingWebDav = false;
  let webDavProfile: SyncProfile | null = null;
  let selected: DisplayItem | null = null;
  let items: DisplayItem[] = [];
  let feed: OpdsFeed | null = null;
  let currentUrl: string | undefined;
  let lastAction: (() => Promise<void>) | null = null;
  let requestGeneration = 0;
  const activeOperations = new Set<AbortController>();
  const trail: Array<{ title: string; url?: string }> = [];

  const labels = (): Labels => LABELS[deps.getLocale()];
  const selectedSource = (): OpdsSource | undefined =>
    sources.find((source) => source.id === selectedSourceId);
  const catalogActive = (): boolean => activeSection === 'sources' && selectedSourceId !== null;

  function smartGroupName(group: SmartGroupDefinition): string {
    const l = labels();
    if (group.rule.type === 'author') return l.authorGroup.replace('{name}', group.rule.value);
    if (group.rule.type === 'series') return l.seriesGroup.replace('{name}', group.rule.value);
    const keyed = (l as unknown as Record<string, string>)[group.nameKey];
    return keyed ?? group.nameKey;
  }

  function refreshSmartGroups(): void {
    const persisted = groups
      .map(smartGroupFromRecord)
      .filter((group): group is SmartGroupDefinition => group !== null);
    const definitions = [
      ...SMART_GROUP_DEFINITIONS,
      ...dynamicAuthorAndSeriesGroups(items.map((display) => display.item)),
      ...dynamicSourceAndFormatGroups(items.map((display) => display.item), sources),
    ];
    const seen = new Set<string>();
    smartGroups = [...definitions, ...persisted].filter((group) => {
      if (seen.has(group.id)) return false;
      seen.add(group.id);
      return true;
    });
    smartGroups.sort(
      (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
    );
    if (
      selectedSmartGroupId !== null &&
      !smartGroups.some((group) => group.id === selectedSmartGroupId)
    ) {
      selectedSmartGroupId = null;
    }
  }

  function progressFor(display: DisplayItem): LibraryProgress | null {
    const catalogEntry = display.entry !== undefined;
    try {
      const projected = catalogEntry
        ? deps.getProgress?.(display.item, { catalogEntry: true })
        : deps.getProgress?.(display.item);
      if (projected == null || projected.status !== 'in-progress') {
        return catalogEntry ? null : { status: 'not-started' };
      }
      return projected;
    } catch {
      return catalogEntry ? null : { status: 'not-started' };
    }
  }

  function progressLabel(progress: LibraryProgress): string {
    if (progress.status !== 'in-progress') return labels().notStarted;
    const parts: string[] = [];
    const location = displayLocation(progress);
    if (location?.kind === 'page') {
      parts.push(labels().pageProgress.replace('{current}', String(location.current)));
    } else if (location?.kind === 'chapter') {
      parts.push(labels().chapterProgress.replace('{current}', String(location.current)));
    }
    if (isDisplayablePercent(progress.percent)) {
      parts.push(
        labels().readPercent.replace(
          '{percent}',
          String(Math.min(100, Math.round(progress.percent))),
        ),
      );
    }
    return parts.length > 0 ? parts.join(' · ') : labels().continueReading;
  }

  function continueStorage(): ProgressStorage | null {
    if (deps.progressStorage !== undefined) return deps.progressStorage;
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  function continueFingerprint(display: DisplayItem): string | null {
    const progress = progressFor(display);
    if (progress?.status !== 'in-progress') return null;
    const ratio = Number.isFinite(progress.ratio) ? progress.ratio : 0;
    return `${display.item.id}\t${progress.unit}\t${progress.index}\t${ratio}`;
  }

  function readDismissedContinue(): string | null {
    const storage = continueStorage();
    if (storage === null) return null;
    try {
      const raw = storage.getItem(CONTINUE_DISMISS_KEY);
      return raw === null || raw === '' ? null : raw;
    } catch {
      return null;
    }
  }

  function writeDismissedContinue(fingerprint: string | null): void {
    const storage = continueStorage();
    if (storage === null) return;
    try {
      if (fingerprint === null) storage.removeItem?.(CONTINUE_DISMISS_KEY);
      else storage.setItem(CONTINUE_DISMISS_KEY, fingerprint);
    } catch {
      /* ignore quota / private-mode failures */
    }
  }

  let dismissedContinue = readDismissedContinue();

  function matchesGroup(display: DisplayItem): boolean {
    if (selectedSmartGroupId !== null) {
      const smart = smartGroups.find((group) => group.id === selectedSmartGroupId);
      return smart !== undefined && smartGroupMatches(display.item, smart.rule, progressFor(display));
    }
    if (selectedCustomGroupId !== null) {
      return itemIdsForGroup(groups, memberships, selectedCustomGroupId).has(display.item.id);
    }
    const progress = progressFor(display);
    const kind = classifyLibraryKind(display.item);
    switch (selectedGroup) {
      case 'all':
        return true;
      case 'in-progress':
        return progress?.status === 'in-progress';
      case 'unread':
        return progress !== null && progress.status === 'not-started';
      case 'text':
        return kind === 'text';
      case 'comic':
        return kind === 'comic';
    }
  }

  function visibleItems(): DisplayItem[] {
    return activeSection === 'shelf' ? items.filter(matchesGroup) : items;
  }

  function latestInProgress(): DisplayItem | null {
    let latest: DisplayItem | null = null;
    for (const display of items) {
      if (progressFor(display)?.status !== 'in-progress') continue;
      if (latest === null || display.item.updatedAt > latest.item.updatedAt) {
        latest = display;
      }
    }
    return latest;
  }

  function setStatus(message: string, retry = false): void {
    status.replaceChildren();
    if (message !== '') {
      const text = doc.createElement('span');
      text.textContent = message;
      status.appendChild(text);
    }
    retryButton.textContent = labels().retry;
    retryButton.hidden = !retry;
    if (retry) status.appendChild(retryButton);
    status.hidden = message === '' && !retry;
    if (retry) status.dataset.status = 'error';
    else if (message !== '') status.dataset.status = 'loading';
    else delete status.dataset.status;
  }

  function beginBlockingLoad(): void {
    if (activeSection === 'shelf' && items.length > 0) return;
    setStatus(labels().loading);
  }

  async function updateCacheSummary(): Promise<void> {
    if (activeSection !== 'manage') {
      cacheUsage.textContent = '';
      return;
    }
    try {
      const cache = await deps.library.cacheStats();
      cacheUsage.textContent = labels()
        .cacheUsage.replace('{used}', bytesLabel(cache.bytesCached))
        .replace('{limit}', bytesLabel(cache.limitBytes));
      if (doc.activeElement !== cacheLimitInput) {
        cacheLimitInput.value = String(cache.limitBytes / 1024 ** 3);
      }
    } catch {
      cacheUsage.textContent = '';
    }
  }

  function parkWorkspaceTravel(): void {
    const travel = deps.workspaceTravel;
    if (travel === undefined) return;
    travel.classList.add('lightink-library-edit');
    travel.hidden = true;
    if (travel.parentElement !== root) {
      root.appendChild(travel);
    }
  }

  function syncPageChrome(): void {
    const inCatalog = catalogActive();
    root.dataset.libraryNav =
      activeSection === 'sources' ? (inCatalog ? 'catalog' : 'sources') : activeSection;
    searchForm.hidden = activeSection !== 'shelf' && !inCatalog;
    parkWorkspaceTravel();
    manageNavButton.classList.toggle('is-active', activeSection === 'manage');
    if (activeSection === 'shelf') {
      heading.textContent = labels().myBooks;
      toolbar.replaceChildren();
      itemList.classList.add('lightink-library-cover-wall');
      content.replaceChildren(continueHost, status, itemList);
      detail.hidden = true;
      selected = null;
    } else if (activeSection === 'manage') {
      heading.textContent = labels().manage;
      toolbar.replaceChildren();
      itemList.classList.remove('lightink-library-cover-wall');
      content.replaceChildren(status, managePanel);
    } else if (inCatalog) {
      heading.textContent = selectedSource()?.title ?? labels().library;
      toolbar.replaceChildren();
      itemList.classList.remove('lightink-library-cover-wall');
      workArea.replaceChildren(itemList, detail);
      content.replaceChildren(navigation, status, workArea);
    } else {
      heading.textContent = labels().sources;
      toolbar.replaceChildren();
      itemList.classList.remove('lightink-library-cover-wall');
      content.replaceChildren(status);
    }
    renderGroups();
    renderSources();
  }

  function showGroupOverlay(): void {
    ignoreGroupBackdrop = true;
    addGroupButton.classList.add('is-open');
    groupOverlay.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ignoreGroupBackdrop = false;
      });
    });
  }

  function closeGroupEditor(): void {
    groupEditorMode = null;
    pendingAddItemId = null;
    groupOverlay.hidden = true;
    groupNameInput.value = '';
    addGroupButton.classList.remove('is-open');
  }

  function flattenedCustomGroups(): Array<{ readonly group: LibraryGroup; readonly depth: number }> {
    const flattened: Array<{ readonly group: LibraryGroup; readonly depth: number }> = [];
    const visit = (nodes: readonly LibraryGroupNode[]): void => {
      for (const node of nodes) {
        flattened.push({ group: node.group, depth: node.depth });
        visit(node.children);
      }
    };
    visit(customGroupTree(groups));
    return flattened;
  }

  function renderGroupEditor(): void {
    if (groupEditorMode === null) {
      groupOverlay.hidden = true;
      addGroupButton.classList.remove('is-open');
      return;
    }
    const mode = groupEditorMode;
    const editing =
      mode.kind === 'rename'
        ? groups.find((group) => group.id === mode.groupId)
        : undefined;
    if (mode.kind === 'rename' && editing === undefined) {
      closeGroupEditor();
      return;
    }
    groupDialog.setAttribute(
      'aria-label',
      mode.kind === 'rename' ? labels().renameGroup : labels().newGroup,
    );
    showGroupOverlay();
    groupNameInput.value = editing?.name ?? '';
    groupParentSelect.replaceChildren();
    const rootOption = doc.createElement('option');
    rootOption.value = '';
    rootOption.textContent = labels().rootGroup;
    groupParentSelect.appendChild(rootOption);
    for (const entry of flattenedCustomGroups()) {
      if (!canPlaceGroup(groups, editing?.id, entry.group.id)) continue;
      const option = doc.createElement('option');
      option.value = entry.group.id;
      option.textContent = `${'  '.repeat(entry.depth)}${entry.group.name}`;
      groupParentSelect.appendChild(option);
    }
    groupParentSelect.value =
      mode.kind === 'create'
        ? (mode.parentId ?? '')
        : (editing?.parentId ?? '');
    groupParentSelect.disabled = groupEditorMode.kind === 'rename';
    groupEditorSave.textContent = labels().save;
    groupEditorCancel.textContent = labels().cancel;
    groupNameLabelText.textContent = labels().groupName;
    groupParentLabelText.textContent = labels().groupParent;
  }

  function openGroupEditor(
    mode:
      | { readonly kind: 'create'; readonly parentId?: string }
      | { readonly kind: 'rename'; readonly groupId: string },
  ): void {
    groupEditorMode = mode;
    groupActionsId = null;
    renderGroups();
    groupNameInput.focus();
    groupNameInput.select();
  }

  async function reloadGroups(): Promise<void> {
    groups = (await deps.library.listGroups?.()) ?? [];
    for (const group of groups) expandedGroupIds.add(group.id);
    renderGroups();
    renderContinueBar();
    renderItems();
  }

  async function moveCustomGroup(
    groupId: string,
    parentId: string | undefined,
    sortOrder: number,
  ): Promise<void> {
    if (!canPlaceGroup(groups, groupId, parentId)) {
      deps.notify(labels().invalidGroupMove, 'warning');
      return;
    }
    try {
      if (deps.library.moveGroup === undefined) return;
      await deps.library.moveGroup(groupId, parentId, sortOrder);
      if (parentId !== undefined) expandedGroupIds.add(parentId);
      await reloadGroups();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().invalidGroupMove), 'error');
    }
  }

  async function keyboardMoveGroup(groupId: string, move: GroupKeyboardMove): Promise<void> {
    const placement = keyboardGroupPlacement(groups, groupId, move);
    if (placement === null) return;
    await moveCustomGroup(groupId, placement.parentId, placement.sortOrder);
  }

  async function deleteCustomGroup(group: LibraryGroup): Promise<void> {
    const message = labels().deleteGroupConfirm.replace('{name}', group.name);
    const confirmed = (await deps.confirmGroupDelete?.(group, message)) ?? true;
    if (!confirmed) return;
    try {
      if (deps.library.deleteGroup === undefined) return;
      await deps.library.deleteGroup(group.id);
      memberships = memberships.filter((membership) => membership.groupId !== group.id);
      if (selectedCustomGroupId === group.id) {
        selectedCustomGroupId = null;
        selectedGroup = 'all';
      }
      groupActionsId = null;
      closeGroupEditor();
      await reloadGroups();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  function groupAction(
    label: string,
    run: () => void,
    disabled = false,
  ): HTMLButtonElement {
    const action = button(doc, label);
    action.disabled = disabled;
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    return action;
  }

  async function setGroupOffline(groupId: string, pinned: boolean): Promise<void> {
    if (deps.library.setOfflinePinned === undefined) return;
    const memberIds = itemIdsForGroup(groups, memberships, groupId);
    const managed = items
      .map((display) => display.item)
      .filter((item) => memberIds.has(item.id) && isManagedItem(item));
    if (managed.length === 0) return;
    try {
      for (const item of managed) {
        await deps.library.setOfflinePinned(item.id, pinned);
        updateItemInMemory({ ...item, offlinePinned: pinned });
      }
      groupActionsId = null;
      renderGroups();
      renderItems();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  function appendCustomGroupNode(node: LibraryGroupNode): void {
    const wrapper = doc.createElement('div');
    wrapper.className = 'lightink-library-custom-group';
    wrapper.dataset.groupId = node.group.id;
    wrapper.dataset.groupDepth = String(node.depth + 1);
    wrapper.style.setProperty('--lightink-group-depth', String(node.depth));
    wrapper.draggable = true;
    const row = doc.createElement('div');
    row.className = 'lightink-library-custom-group-row';
    const toggle = button(doc, node.children.length > 0 ? '>' : '', 'lightink-library-group-toggle');
    toggle.disabled = node.children.length === 0;
    const expanded = expandedGroupIds.has(node.group.id);
    toggle.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-label', node.group.name);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (expanded) expandedGroupIds.delete(node.group.id);
      else expandedGroupIds.add(node.group.id);
      renderGroups();
    });
    const choose = button(doc, node.group.name, 'lightink-library-group');
    choose.dataset.customGroupId = node.group.id;
    choose.dataset.libraryGroupId = node.group.id;
    const chosen = activeSection === 'shelf' && selectedCustomGroupId === node.group.id;
    choose.classList.toggle('is-active', chosen);
    if (chosen) choose.setAttribute('aria-current', 'true');
    choose.addEventListener('click', () => {
      selectedCustomGroupId = node.group.id;
      selectedSmartGroupId = null;
      void activateShelf();
    });
    choose.addEventListener('keydown', (event) => {
      if (event.key === 'F2') {
        event.preventDefault();
        openGroupEditor({ kind: 'rename', groupId: node.group.id });
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        void deleteCustomGroup(node.group);
        return;
      }
      if (!event.altKey) return;
      const move: GroupKeyboardMove | undefined =
        event.key === 'ArrowUp'
          ? 'up'
          : event.key === 'ArrowDown'
            ? 'down'
            : event.key === 'ArrowLeft'
              ? 'outdent'
              : event.key === 'ArrowRight'
                ? 'indent'
                : undefined;
      if (move !== undefined) {
        event.preventDefault();
        void keyboardMoveGroup(node.group.id, move);
      }
    });
    const actions = button(doc, '...', 'lightink-library-icon-button lightink-library-group-menu');
    actions.title = labels().editGroup;
    actions.setAttribute('aria-label', `${labels().editGroup}: ${node.group.name}`);
    actions.setAttribute('aria-expanded', String(groupActionsId === node.group.id));
    actions.addEventListener('click', (event) => {
      event.stopPropagation();
      groupActionsId = groupActionsId === node.group.id ? null : node.group.id;
      renderGroups();
    });
    row.append(toggle, choose, actions);
    wrapper.appendChild(row);

    if (groupActionsId === node.group.id) {
      const menu = doc.createElement('div');
      menu.className = 'lightink-library-group-actions';
      const up = keyboardGroupPlacement(groups, node.group.id, 'up');
      const down = keyboardGroupPlacement(groups, node.group.id, 'down');
      const outdent = keyboardGroupPlacement(groups, node.group.id, 'outdent');
      const indent = keyboardGroupPlacement(groups, node.group.id, 'indent');
      const memberIds = itemIdsForGroup(groups, memberships, node.group.id);
      const managedMembers = items
        .map((display) => display.item)
        .filter((item) => memberIds.has(item.id) && isManagedItem(item));
      const groupPinned =
        managedMembers.length > 0 && managedMembers.every((item) => item.offlinePinned === true);
      menu.append(
        groupAction(labels().addChildGroup, () =>
          openGroupEditor({ kind: 'create', parentId: node.group.id }),
        ),
        groupAction(labels().renameGroup, () =>
          openGroupEditor({ kind: 'rename', groupId: node.group.id }),
        ),
        groupAction(labels().moveUp, () => void keyboardMoveGroup(node.group.id, 'up'), up === null),
        groupAction(
          labels().moveDown,
          () => void keyboardMoveGroup(node.group.id, 'down'),
          down === null,
        ),
        groupAction(
          labels().outdent,
          () => void keyboardMoveGroup(node.group.id, 'outdent'),
          outdent === null,
        ),
        groupAction(
          labels().indent,
          () => void keyboardMoveGroup(node.group.id, 'indent'),
          indent === null,
        ),
        groupAction(
          groupPinned ? labels().removeGroupOffline : labels().keepGroupOffline,
          () => void setGroupOffline(node.group.id, !groupPinned),
          managedMembers.length === 0 || deps.library.setOfflinePinned === undefined,
        ),
        groupAction(labels().deleteGroup, () => void deleteCustomGroup(node.group)),
      );
      wrapper.appendChild(menu);
    }

    wrapper.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-lightink-library-group', node.group.id);
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
    });
    wrapper.addEventListener('dragover', (event) => {
      const data = event.dataTransfer?.types ?? [];
      if (
        Array.from(data).includes('application/x-lightink-library-group') ||
        Array.from(data).includes('application/x-lightink-library-item')
      ) {
        event.preventDefault();
        wrapper.classList.add('is-drop-target');
      }
    });
    wrapper.addEventListener('dragleave', () => wrapper.classList.remove('is-drop-target'));
    wrapper.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      wrapper.classList.remove('is-drop-target');
      const itemId = event.dataTransfer?.getData('application/x-lightink-library-item') ?? '';
      if (itemId !== '') {
        void addItemToGroup(node.group.id, itemId);
        return;
      }
      const draggedGroup =
        event.dataTransfer?.getData('application/x-lightink-library-group') ?? '';
      if (draggedGroup !== '' && draggedGroup !== node.group.id) {
        void moveCustomGroup(draggedGroup, node.group.id, node.children.length);
      }
    });
    groupList.appendChild(wrapper);
    if (expanded) {
      for (const child of node.children) appendCustomGroupNode(child);
    }
  }

  function renderGroups(): void {
    filterList.replaceChildren();
    groupList.replaceChildren();
    shelfHeading.textContent = labels().library;
    groupTitle.textContent = labels().groups;
    groupPane.setAttribute('aria-label', labels().groups);
    addGroupButton.title = labels().newGroup;
    addGroupButton.setAttribute('aria-label', labels().newGroup);
    myBooksButton.textContent = labels().myBooks;
    const shelfActive = activeSection === 'shelf';
    const myBooksActive =
      shelfActive &&
      selectedGroup === 'all' &&
      selectedCustomGroupId === null &&
      selectedSmartGroupId === null;
    myBooksButton.classList.toggle('is-active', myBooksActive);
    if (myBooksActive) myBooksButton.setAttribute('aria-current', 'true');
    else myBooksButton.removeAttribute('aria-current');
    for (const group of SHELF_GROUPS) {
      const row = button(doc, groupLabel(labels(), group), 'lightink-library-group');
      row.dataset.shelfGroup = group;
      const active =
        shelfActive &&
        selectedCustomGroupId === null &&
        selectedSmartGroupId === null &&
        selectedGroup === group;
      row.classList.toggle('is-active', active);
      if (active) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        selectedGroup = group;
        selectedCustomGroupId = null;
        selectedSmartGroupId = null;
        void activateShelf();
      });
      filterList.appendChild(row);
    }
    for (const node of customGroupTree(groups)) {
      appendCustomGroupNode(node);
    }
    renderSmartGroups();
    renderGroupEditor();
  }

  function renderSmartGroups(): void {
    smartGroupList.replaceChildren();
    smartGroupTitle.textContent = labels().smartGroups;
    for (const group of smartGroups) {
      const item = button(doc, smartGroupName(group), 'lightink-library-smart-group');
      item.dataset.smartGroupId = group.id;
      const active = activeSection === 'shelf' && selectedSmartGroupId === group.id;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      item.addEventListener('click', () => {
        selectedSmartGroupId = group.id;
        selectedCustomGroupId = null;
        void activateShelf();
      });
      smartGroupList.appendChild(item);
    }
  }

  function renderSources(): void {
    sourceList.replaceChildren();
    if (sources.length === 0 && webDavProfile === null) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-source-empty';
      empty.textContent = labels().emptySources;
      sourceList.appendChild(empty);
      return;
    }
    for (const source of sources) {
      const row = doc.createElement('div');
      row.className = 'lightink-library-source-row';
      const stack = doc.createElement('div');
      stack.className = 'lightink-library-source-stack';
      const choose = button(doc, source.title, 'lightink-library-source');
      choose.dataset.sourceId = source.id;
      choose.title = source.url;
      choose.classList.toggle('is-active', selectedSourceId === source.id);
      if (selectedSourceId === source.id) {
        choose.setAttribute('aria-current', 'page');
      }
      choose.addEventListener('click', () => void openCatalog(source.id));
      const url = doc.createElement('span');
      url.className = 'lightink-library-source-url';
      url.textContent = source.url;
      stack.append(choose, url);
      const edit = button(doc, '', 'lightink-library-icon-button lightink-library-source-edit');
      edit.title = labels().editSource;
      edit.setAttribute('aria-label', `${labels().editSource}: ${source.title}`);
      edit.addEventListener('click', () => openSourceForm(source));
      const remove = button(doc, '', 'lightink-library-icon-button lightink-library-source-remove');
      remove.title = labels().deleteSource;
      remove.setAttribute('aria-label', `${labels().deleteSource}: ${source.title}`);
      remove.addEventListener('click', () => void removeSource(source));
      row.append(stack, edit, remove);
      sourceList.appendChild(row);
    }
    if (webDavProfile !== null) {
      const profile = webDavProfile;
      const row = doc.createElement('div');
      row.className = 'lightink-library-source-row';
      row.dataset.sourceKind = 'webdav';
      const stack = doc.createElement('div');
      stack.className = 'lightink-library-source-stack';
      const choose = button(doc, profile.name, 'lightink-library-source');
      choose.dataset.sourceKind = 'webdav';
      choose.title = profile.url;
      choose.addEventListener('click', () => {
        if (deps.onOpenSyncPanel !== undefined) deps.onOpenSyncPanel();
        else openWebDavForm();
      });
      const url = doc.createElement('span');
      url.className = 'lightink-library-source-url';
      url.textContent = profile.url;
      stack.append(choose, url);
      const edit = button(doc, '', 'lightink-library-icon-button lightink-library-source-edit');
      edit.title = labels().editWebDav;
      edit.setAttribute('aria-label', `${labels().editWebDav}: ${profile.name}`);
      edit.addEventListener('click', () => openWebDavForm());
      const remove = button(doc, '', 'lightink-library-icon-button lightink-library-source-remove');
      remove.title = labels().deleteSource;
      remove.setAttribute('aria-label', `${labels().deleteSource}: ${profile.name}`);
      remove.addEventListener('click', () => void removeWebDav());
      row.append(stack, edit, remove);
      sourceList.appendChild(row);
    }
  }

  function renderBreadcrumbs(): void {
    breadcrumbs.replaceChildren();
    const source = selectedSource();
    if (source !== undefined) {
      const listCrumb = button(doc, labels().sources);
      listCrumb.addEventListener('click', () => closeCatalog());
      breadcrumbs.appendChild(listCrumb);
      if (trail.length > 0) {
        const rootSeparator = doc.createElement('span');
        rootSeparator.textContent = '/';
        const rootCrumb = button(doc, source.title);
        rootCrumb.addEventListener('click', () => void openCatalog(source.id));
        breadcrumbs.append(rootSeparator, rootCrumb);
        for (const [index, crumb] of trail.entries()) {
          const separator = doc.createElement('span');
          separator.textContent = '/';
          const crumbButton = button(doc, crumb.title);
          crumbButton.addEventListener('click', () => {
            trail.splice(index + 1);
            void loadFeed(crumb.url, false);
          });
          breadcrumbs.append(separator, crumbButton);
        }
      }
    }
    previousButton.disabled = feed?.previousUrl == null || feed.previousUrl === '';
    nextButton.disabled = feed?.nextUrl == null || feed.nextUrl === '';
    pager.hidden = previousButton.disabled && nextButton.disabled;
  }

  function appendCover(cover: HTMLElement, display: DisplayItem): void {
    const coverUrl = safeCoverUrl(display.item, sources);
    if (coverUrl !== undefined) {
      const image = doc.createElement('img');
      image.src = coverUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        image.remove();
        const initial = itemTitle(display.item).slice(0, 1);
        cover.textContent = initial === '' ? '?' : initial.toUpperCase();
      });
      cover.appendChild(image);
    } else {
      const initial = itemTitle(display.item).slice(0, 1);
      cover.textContent = initial === '' ? '?' : initial.toUpperCase();
    }
  }

  function appendImportedProgress(
    row: HTMLElement,
    text: HTMLElement,
    display: DisplayItem,
    options: { readonly continueCue: boolean },
  ): void {
    const shelfProgress = progressFor(display);
    if (shelfProgress === null) return;
    row.dataset.progressStatus = shelfProgress.status;
    const fill = coverProgressFillPercent(shelfProgress);
    if (fill !== null) {
      row.dataset.progressFill = String(fill);
      row.style.setProperty('--lightink-library-progress-fill', `${fill}%`);
    }
    const progress = doc.createElement('span');
    progress.className = 'lightink-library-item-progress';
    progress.textContent = progressLabel(shelfProgress);
    text.appendChild(progress);
    if (shelfProgress.status === 'in-progress' && options.continueCue) {
      const cue = doc.createElement('span');
      cue.className = 'lightink-library-item-continue';
      cue.textContent = labels().continueReading;
      text.appendChild(cue);
    }
  }

  async function addItemToGroup(groupId: string, itemId: string): Promise<void> {
    if (memberships.some((entry) => entry.groupId === groupId && entry.itemId === itemId)) return;
    try {
      if (deps.library.setGroupMember === undefined) return;
      await deps.library.setGroupMember(groupId, itemId, true);
      memberships.push({ groupId, itemId });
      renderItems();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function removeItemFromGroup(groupId: string, itemId: string): Promise<void> {
    try {
      if (deps.library.setGroupMember === undefined) return;
      await deps.library.setGroupMember(groupId, itemId, false);
      memberships = memberships.filter(
        (entry) => !(entry.groupId === groupId && entry.itemId === itemId),
      );
      renderItems();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  function openItemCollectionMenu(display: DisplayItem, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const custom = flattenedCustomGroups();
    const items: MenuItem[] = [];
    if (custom.length === 0) {
      items.push({
        id: 'add',
        label: labels().addToGroup,
        action: () => {
          pendingAddItemId = display.item.id;
          openGroupEditor({ kind: 'create' });
        },
      });
    } else {
      for (const entry of custom) {
        const present = memberships.some(
          (membership) =>
            membership.groupId === entry.group.id && membership.itemId === display.item.id,
        );
        items.push({
          id: entry.group.id,
          label: present ? `✓ ${entry.group.name}` : entry.group.name,
          action: () => {
            void (present
              ? removeItemFromGroup(entry.group.id, display.item.id)
              : addItemToGroup(entry.group.id, display.item.id));
          },
        });
      }
      items.push({
        id: 'sep-new',
        label: '',
        separator: true,
        action: () => undefined,
      });
      items.push({
        id: 'new',
        label: labels().newGroup,
        action: () => {
          pendingAddItemId = display.item.id;
          openGroupEditor({ kind: 'create' });
        },
      });
    }
    createContextMenu(items, { x: event.clientX, y: event.clientY }, doc);
  }

  function closeMembershipEditor(): void {
    membershipItemId = null;
    membershipOverlay.hidden = true;
    header.removeAttribute('inert');
    body.removeAttribute('inert');
  }

  function openMembershipEditor(itemId: string): void {
    const custom = flattenedCustomGroups();
    const display = items.find((candidate) => candidate.item.id === itemId);
    const canPin =
      display !== undefined &&
      isManagedItem(display.item) &&
      deps.library.setOfflinePinned !== undefined;
    if (custom.length === 0 && !canPin) {
      deps.notify(labels().noCustomGroups, 'warning');
      return;
    }
    membershipItemId = itemId;
    membershipTitle.textContent = `${labels().organizeBook}: ${display?.item.title ?? ''}`;
    membershipOptions.replaceChildren();
    if (canPin && display !== undefined) {
      const pinLabel = doc.createElement('label');
      pinLabel.className = 'lightink-library-membership-offline';
      const pin = doc.createElement('input');
      pin.type = 'checkbox';
      pin.name = 'offlinePinned';
      pin.checked = display.item.offlinePinned === true;
      const text = doc.createElement('span');
      text.textContent = labels().keepOffline;
      pinLabel.append(pin, text);
      membershipOptions.appendChild(pinLabel);
    }
    const assigned = new Set(
      memberships.filter((entry) => entry.itemId === itemId).map((entry) => entry.groupId),
    );
    for (const entry of custom) {
      const label = doc.createElement('label');
      label.style.setProperty('--lightink-group-depth', String(entry.depth));
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'membership';
      checkbox.value = entry.group.id;
      checkbox.checked = assigned.has(entry.group.id);
      const text = doc.createElement('span');
      text.textContent = entry.group.name;
      label.append(checkbox, text);
      membershipOptions.appendChild(label);
    }
    membershipSave.textContent = labels().saveGroups;
    membershipCancel.textContent = labels().cancel;
    membershipOverlay.hidden = false;
    header.setAttribute('inert', '');
    body.setAttribute('inert', '');
    membershipOptions.querySelector<HTMLInputElement>('input')?.focus();
  }

  function renderCoverCard(display: DisplayItem): HTMLButtonElement {
    const row = button(doc, '', 'lightink-library-item lightink-library-item--cover');
    row.dataset.itemId = display.item.id;
    row.dataset.bookKind = classifyLibraryKind(display.item);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-keyshortcuts', 'G');
    row.draggable = true;
    const cover = doc.createElement('div');
    cover.className = 'lightink-library-cover';
    appendCover(cover, display);
    const text = doc.createElement('span');
    text.className = 'lightink-library-item-text';
    const title = doc.createElement('strong');
    title.textContent = itemTitle(display.item);
    text.append(title);
    const metaParts = [itemAuthors(display.item).join(', '), display.item.series].filter(
      (part): part is string => typeof part === 'string' && part !== '',
    );
    if (metaParts.length > 0) {
      const meta = doc.createElement('span');
      meta.textContent = metaParts.join(' · ');
      text.appendChild(meta);
    }
    appendImportedProgress(row, text, display, { continueCue: false });
    row.append(cover, text);
    row.addEventListener('click', () => void openSelected(display));
    row.addEventListener('contextmenu', (event) => {
      openItemCollectionMenu(display, event);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key.toLocaleLowerCase() === 'g' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        openMembershipEditor(display.item.id);
      }
    });
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-lightink-library-item', display.item.id);
      event.dataTransfer?.setData('text/plain', display.item.title);
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'copy';
    });
    return row;
  }

  function renderCatalogRow(display: DisplayItem): HTMLButtonElement {
    const row = button(doc, '', 'lightink-library-item lightink-library-item--row');
    row.dataset.itemId = display.item.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected?.item.id === display.item.id ? 'true' : 'false');
    row.classList.toggle('is-selected', selected?.item.id === display.item.id);
    const cover = doc.createElement('div');
    cover.className = 'lightink-library-cover';
    appendCover(cover, display);
    const text = doc.createElement('span');
    text.className = 'lightink-library-item-text';
    const title = doc.createElement('strong');
    title.textContent = itemTitle(display.item);
    const meta = doc.createElement('span');
    meta.textContent = [
      itemAuthors(display.item).join(', '),
      display.item.series,
      display.item.extension?.toUpperCase(),
      display.item.size === undefined ? undefined : bytesLabel(display.item.size),
    ]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' · ');
    text.append(title, meta);
    appendImportedProgress(row, text, display, { continueCue: false });
    row.append(cover, text);
    row.addEventListener('click', () =>
      display.entry?.kind === 'navigation' ? void openSelected(display) : void selectItem(display),
    );
    row.addEventListener('dblclick', () => void openSelected(display));
    return row;
  }

  function renderContinueBar(): void {
    continueHost.replaceChildren();
    if (
      activeSection !== 'shelf' ||
      selectedGroup !== 'all' ||
      selectedCustomGroupId !== null ||
      selectedSmartGroupId !== null ||
      searchInput.value.trim() !== ''
    ) {
      continueHost.hidden = true;
      return;
    }
    const latest = latestInProgress();
    const fingerprint = latest === null ? null : continueFingerprint(latest);
    if (latest === null || fingerprint === null || fingerprint === dismissedContinue) {
      continueHost.hidden = true;
      return;
    }
    const progress = progressFor(latest);
    const open = button(doc, '', 'lightink-library-continue-open');
    open.setAttribute('aria-label', labels().continueReading);
    const cover = doc.createElement('div');
    cover.className = 'lightink-library-cover';
    appendCover(cover, latest);
    const text = doc.createElement('span');
    text.className = 'lightink-library-continue-text';
    const title = doc.createElement('strong');
    title.textContent = itemTitle(latest.item);
    text.append(title);
    if (progress !== null) {
      const meta = doc.createElement('span');
      meta.className = 'lightink-library-item-progress';
      meta.textContent = progressLabel(progress);
      text.appendChild(meta);
    }
    const cue = doc.createElement('span');
    cue.className = 'lightink-library-continue-cue';
    cue.textContent = labels().continueReading;
    open.append(cover, text, cue);
    open.addEventListener('click', () => void openSelected(latest));
    const dismiss = button(doc, '×', 'lightink-library-icon-button lightink-library-continue-dismiss');
    dismiss.setAttribute('aria-label', labels().dismissContinue);
    dismiss.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissedContinue = fingerprint;
      writeDismissedContinue(fingerprint);
      renderContinueBar();
    });
    continueHost.append(open, dismiss);
    continueHost.hidden = false;
  }

  function renderItems(): void {
    const shown = visibleItems();
    itemList.replaceChildren();
    if (!status.hidden && shown.length === 0) {
      return;
    }
    if (shown.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'lightink-library-empty';
      const query = searchInput.value.trim();
      const filtered =
        query !== '' ||
        selectedGroup !== 'all' ||
        selectedCustomGroupId !== null ||
        selectedSmartGroupId !== null;
      if (query !== '') empty.textContent = labels().emptySearch;
      else if (filtered) empty.textContent = labels().emptyFilter;
      else empty.textContent = labels().empty;
      if (filtered) empty.classList.add('lightink-library-empty--filtered');
      itemList.appendChild(empty);
      detail.hidden = true;
      return;
    }
    let renderedCatalogGroup: string | undefined;
    for (const display of shown) {
      if (
        catalogActive() &&
        display.catalogGroupKey !== undefined &&
        display.catalogGroupKey !== renderedCatalogGroup
      ) {
        renderedCatalogGroup = display.catalogGroupKey;
        if (display.catalogGroupTitle !== undefined) {
          const groupHeading = doc.createElement('h3');
          groupHeading.className = 'lightink-library-opds-group-title';
          groupHeading.textContent = display.catalogGroupTitle;
          itemList.appendChild(groupHeading);
        }
      }
      itemList.appendChild(
        activeSection === 'shelf' ? renderCoverCard(display) : renderCatalogRow(display),
      );
    }
  }

  async function ensureLinks(display: DisplayItem): Promise<DisplayItem> {
    if (display.links.length > 0 || isLocalItem(display.item)) return display;
    try {
      const links = await deps.library.listAcquisitionLinks(display.item.id);
      return { ...display, links };
    } catch {
      return display;
    }
  }

  async function selectItem(display: DisplayItem): Promise<void> {
    const restoreFocus =
      doc.activeElement instanceof HTMLButtonElement && itemList.contains(doc.activeElement);
    selected = await ensureLinks(display);
    const index = items.findIndex((candidate) => candidate.item.id === selected?.item.id);
    if (index >= 0) items[index] = selected;
    renderItems();
    renderDetail();
    if (restoreFocus) {
      Array.from(itemList.querySelectorAll<HTMLButtonElement>('.lightink-library-item'))
        .find((row) => row.dataset.itemId === display.item.id)
        ?.focus();
    }
  }

  function updateItemInMemory(item: LibraryItem): void {
    const index = items.findIndex((candidate) => candidate.item.id === item.id);
    if (index >= 0) {
      items[index] = { ...items[index]!, item };
    }
    if (selected?.item.id === item.id) {
      selected = { ...selected, item };
    }
  }

  function selectedAcquisition(display: DisplayItem | null = selected): AcquisitionLink | undefined {
    const select = detail.querySelector<HTMLSelectElement>('.lightink-library-acquisition');
    const href = select?.value;
    return display?.links.find((link) => link.href === href) ?? display?.links[0];
  }

  function requestFor(display: DisplayItem): LibraryOpenRequest {
    return {
      item: display.item,
      acquisition: selectedAcquisition(display),
      source: selectedSource() ?? sources.find((source) => source.id === display.item.sourceId),
    };
  }

  async function openSelected(display = selected): Promise<void> {
    if (display === null) return;
    if (
      display.entry?.kind === 'navigation' &&
      display.entry.navigationUrl != null &&
      display.entry.navigationUrl !== ''
    ) {
      trail.push({ title: display.item.title, url: display.entry.navigationUrl });
      await loadFeed(display.entry.navigationUrl, false);
      return;
    }
    const request = requestFor(display);
    if (!isLocalItem(display.item) && request.acquisition === undefined) {
      deps.notify(labels().noAcquisition, 'warning');
      return;
    }
    const controller = new AbortController();
    activeOperations.add(controller);
    try {
      await deps.onOpen(request, controller.signal);
      if (controller.signal.aborted) return;
      activeOperations.delete(controller);
      hide({ notifyVisibility: false });
    } catch (error) {
      if (!controller.signal.aborted) deps.notify(errorText(error, labels().offline), 'error');
    } finally {
      activeOperations.delete(controller);
    }
  }

  function renderDetail(): void {
    detail.replaceChildren();
    if (selected === null) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    const detailHeading = doc.createElement('h2');
    detailHeading.textContent = labels().details;
    const title = doc.createElement('h3');
    title.textContent = itemTitle(selected.item);
    const authors = doc.createElement('p');
    authors.className = 'lightink-library-detail-authors';
    authors.textContent = itemAuthors(selected.item).join(', ');
    detail.append(detailHeading, title, authors);
    const facts: Array<[string, string | undefined]> = [
      [labels().series, selected.item.series],
      [labels().number, selected.item.number],
      [labels().volume, selected.item.volume],
      [labels().pages, selected.item.pageCount?.toLocaleString()],
      [
        labels().direction,
        selected.item.readingDirection === 'rtl'
          ? labels().directionRtl
          : selected.item.readingDirection === 'ltr'
            ? labels().directionLtr
            : undefined,
      ],
      [
        labels().coverPage,
        selected.item.coverPage === undefined
          ? undefined
          : String(selected.item.coverPage + 1),
      ],
    ];
    const availableFacts = facts.filter(
      (fact): fact is [string, string] => fact[1] !== undefined && fact[1] !== '',
    );
    if (availableFacts.length > 0) {
      const metadata = doc.createElement('dl');
      metadata.className = 'lightink-library-comic-metadata';
      for (const [label, value] of availableFacts) {
        const term = doc.createElement('dt');
        term.textContent = label;
        const description = doc.createElement('dd');
        description.textContent = value;
        metadata.append(term, description);
      }
      detail.appendChild(metadata);
    }
    if (selected.entry?.summary !== undefined && selected.entry.summary !== '') {
      const summary = doc.createElement('p');
      summary.className = 'lightink-library-summary';
      summary.textContent = selected.entry.summary;
      detail.appendChild(summary);
    }
    if (selected.links.length > 1) {
      const acquisition = doc.createElement('select');
      acquisition.className = 'lightink-library-acquisition';
      acquisition.setAttribute('aria-label', labels().open);
      for (const link of selected.links) {
        const option = doc.createElement('option');
        option.value = link.href;
        option.textContent = [link.title ?? link.mediaType, link.extension?.toUpperCase(), link.size === undefined ? undefined : bytesLabel(link.size)]
          .filter((part): part is string => part !== undefined && part !== '')
          .join(' · ');
        acquisition.appendChild(option);
      }
      detail.appendChild(acquisition);
    }
    const actions = doc.createElement('div');
    actions.className = 'lightink-library-detail-actions';
    const selectedProgress = progressFor(selected);
    const open = button(
      doc,
      selectedProgress?.status === 'in-progress' ? labels().continueReading : labels().open,
      'lightink-library-primary',
    );
    const managedBodyMissing = isManagedItem(selected.item) && !isManagedBodyAvailable(selected.item);
    open.disabled =
      selected.entry?.kind === 'navigation'
        ? selected.entry.navigationUrl == null || selected.entry.navigationUrl === ''
        : (!isLocalItem(selected.item) && selected.links.length === 0) ||
          (managedBodyMissing && deps.onDownload === undefined);
    open.addEventListener('click', () => void openSelected());
    actions.appendChild(open);
    if (managedBodyMissing && deps.onDownload !== undefined) {
      const download = button(doc, labels().downloadBook);
      const itemId = selected.item.id;
      download.addEventListener('click', async () => {
        const current = items.find((candidate) => candidate.item.id === itemId)?.item;
        if (current === undefined || deps.onDownload === undefined) return;
        download.disabled = true;
        download.textContent = labels().downloadingBook;
        const controller = new AbortController();
        activeOperations.add(controller);
        try {
          const path = await deps.onDownload(current, controller.signal);
          if (controller.signal.aborted) return;
          const next: LibraryItem = {
            ...current,
            ...(path === undefined ? {} : { localPath: path }),
            availability: 'local',
          };
          updateItemInMemory(next);
          renderDetail();
          renderItems();
        } catch (error) {
          if (!controller.signal.aborted) deps.notify(errorText(error, labels().offline), 'error');
        } finally {
          activeOperations.delete(controller);
          if (download.isConnected) {
            download.disabled = false;
            download.textContent = labels().downloadBook;
          }
        }
      });
      actions.appendChild(download);
    }
    if (isManagedItem(selected.item) && deps.library.setOfflinePinned !== undefined) {
      const pinLabel = doc.createElement('label');
      pinLabel.className = 'lightink-library-offline-toggle';
      const pin = doc.createElement('input');
      pin.type = 'checkbox';
      pin.checked = selected.item.offlinePinned === true;
      pin.addEventListener('change', async () => {
        if (selected === null || deps.library.setOfflinePinned === undefined) return;
        const nextPinned = pin.checked;
        pin.disabled = true;
        try {
          await deps.library.setOfflinePinned(selected.item.id, nextPinned);
          updateItemInMemory({ ...selected.item, offlinePinned: nextPinned });
          pinText.textContent = nextPinned ? labels().removeOffline : labels().keepOffline;
          renderItems();
          deps.onLocalChange?.();
        } catch (error) {
          pin.checked = !nextPinned;
          pinText.textContent = pin.checked ? labels().removeOffline : labels().keepOffline;
          deps.notify(errorText(error, labels().offline), 'error');
        } finally {
          pin.disabled = false;
        }
      });
      const pinText = doc.createElement('span');
      pinText.textContent = pin.checked ? labels().removeOffline : labels().keepOffline;
      pinLabel.append(pin, pinText);
      actions.appendChild(pinLabel);
    }
    if (!isLocalItem(selected.item)) {
      const cache = button(doc, labels().cacheBook);
      cache.disabled = selected.links.length === 0;
      cache.addEventListener('click', async () => {
        if (selected === null) return;
        cache.disabled = true;
        cache.textContent = labels().caching;
        const controller = new AbortController();
        activeOperations.add(controller);
        try {
          await deps.onCache(requestFor(selected), controller.signal);
          await updateCacheSummary();
        } catch (error) {
          if (!controller.signal.aborted) deps.notify(errorText(error, labels().offline), 'error');
        } finally {
          activeOperations.delete(controller);
          cache.disabled = false;
          cache.textContent = labels().cacheBook;
        }
      });
      actions.appendChild(cache);
    }
    const remove = button(doc, labels().remove, 'lightink-library-danger');
    remove.addEventListener('click', () => void removeItem(selected!.item));
    actions.appendChild(remove);
    detail.appendChild(actions);
  }

  function needsLocalEnrich(item: LibraryItem): boolean {
    const extension = (item.extension ?? '').toLowerCase();
    return (
      isLocalItem(item) &&
      item.localPath != null &&
      item.localPath !== '' &&
      !isShelfCoverUrl(item.coverUrl) &&
      (extension === 'epub' || extension === 'cbz')
    );
  }

  async function hydrateLocalCovers(generation: number): Promise<void> {
    if (deps.enrichLocalItem === undefined) return;
    for (const display of [...items]) {
      if (generation !== requestGeneration) return;
      if (!needsLocalEnrich(display.item)) continue;
      try {
        const next = await deps.enrichLocalItem(display.item);
        if (generation !== requestGeneration) return;
        const index = items.findIndex((candidate) => candidate.item.id === next.id);
        if (index >= 0) {
          items[index] = { ...items[index]!, item: next };
        }
      } catch {
        /* keep the placeholder cover */
      }
    }
    if (generation !== requestGeneration) return;
    renderContinueBar();
    renderItems();
  }

  async function loadPersistedItems(): Promise<void> {
    const generation = ++requestGeneration;
    beginBlockingLoad();
    lastAction = loadPersistedItems;
    try {
      const [loaded, loadedGroups, loadedMemberships] = await Promise.all([
        deps.library.listItems(),
        deps.library.listGroups?.() ?? Promise.resolve([]),
        deps.library.listGroupMemberships?.() ?? Promise.resolve([]),
      ]);
      if (generation !== requestGeneration) return;
      items = loaded.map((item) => ({ item, links: [] }));
      groups = loadedGroups;
      memberships = loadedMemberships;
      refreshSmartGroups();
      for (const group of groups) expandedGroupIds.add(group.id);
      selected = null;
      feed = null;
      currentUrl = undefined;
      trail.splice(0);
      setStatus('');
      renderGroups();
      renderContinueBar();
      renderItems();
      void hydrateLocalCovers(generation);
    } catch (error) {
      if (generation !== requestGeneration) return;
      items = [];
      setStatus(errorText(error, labels().offline), true);
      renderContinueBar();
      renderItems();
    }
  }

  async function loadFeed(url?: string, pushTrail = false): Promise<void> {
    const source = selectedSource();
    if (source === undefined) return;
    const generation = ++requestGeneration;
    setStatus(labels().loading);
    currentUrl = url;
    lastAction = () => loadFeed(currentUrl, false);
    try {
      const loaded = await deps.opds.browse(source.id, url);
      if (generation !== requestGeneration) return;
      feed = loaded;
      items = itemsFromFeed(source.id, loaded);
      refreshSmartGroups();
      selected = null;
      if (pushTrail) trail.push({ title: loaded.title, url: loaded.sourceUrl });
      setStatus('');
      renderBreadcrumbs();
      renderItems();
    } catch (error) {
      if (generation !== requestGeneration) return;
      items = [];
      setStatus(errorText(error, labels().offline), true);
      renderBreadcrumbs();
      renderItems();
    }
  }

  async function showMyBooks(): Promise<void> {
    activeSection = 'shelf';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    syncPageChrome();
    renderGroups();
    await loadPersistedItems();
  }

  async function activateShelf(): Promise<void> {
    if (activeSection === 'shelf') {
      syncPageChrome();
      renderContinueBar();
      renderItems();
      return;
    }
    await showMyBooks();
  }

  async function showManage(): Promise<void> {
    activeSection = 'manage';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    searchInput.value = '';
    syncSearchClear();
    closeSourceForm();
    setStatus('');
    syncPageChrome();
    await refreshWebDavProfile();
    renderSources();
    await updateCacheSummary();
  }

  function closeCatalog(): void {
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    syncPageChrome();
    renderSources();
    renderBreadcrumbs();
  }

  async function openCatalog(sourceId: string): Promise<void> {
    activeSection = 'sources';
    selectedSourceId = sourceId;
    searchInput.value = '';
    syncSearchClear();
    trail.splice(0);
    syncPageChrome();
    renderSources();
    renderBreadcrumbs();
    await loadFeed(undefined, false);
  }

  async function search(): Promise<void> {
    const query = searchInput.value.trim();
    if (query === '') {
      if (catalogActive() && selectedSourceId !== null) {
        await openCatalog(selectedSourceId);
        return;
      }
      await showMyBooks();
      return;
    }
    if (!catalogActive() || selectedSourceId === null) {
      const lowered = query.toLocaleLowerCase();
      const loaded = await deps.library.listItems();
      items = loaded
        .filter((item) =>
          `${itemTitle(item)}\n${itemAuthors(item).join('\n')}`.toLocaleLowerCase().includes(lowered),
        )
        .map((item) => ({ item, links: [] }));
      refreshSmartGroups();
      selected = null;
      renderContinueBar();
      renderItems();
      return;
    }
    const generation = ++requestGeneration;
    setStatus(labels().loading);
    lastAction = search;
    try {
      const loaded = await deps.opds.search(selectedSourceId, query);
      if (generation !== requestGeneration) return;
      feed = loaded;
      items = itemsFromFeed(selectedSourceId, loaded);
      refreshSmartGroups();
      selected = null;
      trail.splice(0, trail.length, { title: `${labels().search}: ${query}`, url: loaded.sourceUrl });
      setStatus('');
      renderBreadcrumbs();
      renderItems();
    } catch (error) {
      if (generation !== requestGeneration) return;
      items = [];
      setStatus(errorText(error, labels().offline), true);
      renderItems();
    }
  }

  async function refreshWebDavProfile(): Promise<void> {
    if (deps.webdav === undefined) {
      webDavProfile = null;
      return;
    }
    try {
      webDavProfile = await deps.webdav.getProfile();
    } catch {
      webDavProfile = null;
    }
  }

  function renderSourceForm(source?: OpdsSource, kind: 'opds' | 'webdav' = 'opds'): void {
    sourceForm.replaceChildren();
    const makeInput = (name: string, type = 'text'): HTMLInputElement => {
      const input = doc.createElement('input');
      input.name = name;
      input.type = type;
      input.required = true;
      input.placeholder = labels()[name as keyof Labels] ?? name;
      return input;
    };
    const labeled = (field: HTMLElement, text: string): HTMLLabelElement => {
      const wrap = doc.createElement('label');
      wrap.className = 'lightink-library-field';
      const caption = doc.createElement('span');
      caption.textContent = text;
      wrap.append(caption, field);
      return wrap;
    };
    const actions = doc.createElement('div');
    const save = button(doc, labels().save, 'lightink-library-primary');
    save.type = 'submit';
    const cancel = button(doc, labels().cancel);
    cancel.addEventListener('click', () => {
      closeSourceForm();
    });
    actions.append(save, cancel);
    const fields: HTMLElement[] = [];
    if (source === undefined && deps.webdav !== undefined) {
      const kindSelect = doc.createElement('select');
      kindSelect.name = 'kind';
      kindSelect.setAttribute('aria-label', labels().sourceKind);
      for (const value of ['opds', 'webdav'] as const) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = value === 'opds' ? labels().opdsSource : labels().webdavSource;
        kindSelect.appendChild(option);
      }
      kindSelect.value = kind;
      kindSelect.addEventListener('change', () => {
        editingWebDav = kindSelect.value === 'webdav';
        renderSourceForm(undefined, kindSelect.value === 'webdav' ? 'webdav' : 'opds');
        sourceForm.querySelector<HTMLInputElement>('input')?.focus();
      });
      fields.push(labeled(kindSelect, labels().sourceKind));
    }
    const title = makeInput('title');
    const url = makeInput('url', 'url');
    const auth = doc.createElement('select');
    auth.name = 'auth';
    auth.setAttribute('aria-label', labels().auth);
    const username = makeInput('username');
    const password = makeInput('password', 'password');
    const token = makeInput('token', 'password');
    username.required = false;
    password.required = false;
    token.required = false;
    username.hidden = password.hidden = token.hidden = true;
    const allowLabel = doc.createElement('label');
    const allow = doc.createElement('input');
    allow.type = 'checkbox';
    allow.name = 'allowHttp';
    allowLabel.append(allow, doc.createTextNode(labels().allowHttp));
    auth.addEventListener('change', () => {
      username.hidden = password.hidden = auth.value !== 'basic';
      token.hidden = auth.value !== 'bearer';
      username.required = password.required = auth.value === 'basic';
      token.required = auth.value === 'bearer';
    });
    if (kind === 'webdav') {
      editingWebDav = true;
      if (webDavProfile !== null && !webDavProfile.needsCredential) {
        const option = doc.createElement('option');
        option.value = 'keep';
        option.textContent = labels().keepAuth;
        auth.appendChild(option);
      }
      for (const value of ['basic', 'bearer'] as const) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = labels()[value];
        auth.appendChild(option);
      }
      sourceForm.setAttribute('aria-label', webDavProfile === null ? labels().addSource : labels().editWebDav);
      sourceForm.append(
        ...fields,
        labeled(title, labels().title),
        labeled(url, labels().webdavUrl),
        labeled(auth, labels().auth),
        username,
        password,
        token,
        allowLabel,
        actions,
      );
      title.value = webDavProfile?.name ?? '';
      url.value = webDavProfile?.url ?? '';
      allow.checked = webDavProfile?.allowHttp ?? false;
      auth.value =
        webDavProfile !== null && !webDavProfile.needsCredential
          ? 'keep'
          : (webDavProfile?.authType ?? 'basic');
      auth.dispatchEvent(new Event('change'));
      return;
    }
    editingWebDav = false;
    if (source?.credentialRef !== undefined) {
      const option = doc.createElement('option');
      option.value = 'keep';
      option.textContent = labels().keepAuth;
      auth.appendChild(option);
    }
    for (const value of ['none', 'basic', 'bearer'] as const) {
      const option = doc.createElement('option');
      option.value = value;
      option.textContent = labels()[value];
      auth.appendChild(option);
    }
    sourceForm.setAttribute('aria-label', source === undefined ? labels().addSource : labels().editSource);
    sourceForm.append(
      ...fields,
      labeled(title, labels().title),
      labeled(url, labels().url),
      labeled(auth, labels().auth),
      username,
      password,
      token,
      allowLabel,
      actions,
    );
    title.value = source?.title ?? '';
    url.value = source?.url ?? '';
    allow.checked = source?.allowHttp ?? false;
    auth.value = source?.credentialRef === undefined ? 'none' : 'keep';
  }

  function showSourceOverlay(): void {
    ignoreSourceBackdrop = true;
    addSourceButton.classList.add('is-open');
    sourceOverlay.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ignoreSourceBackdrop = false;
      });
    });
  }

  function closeSourceForm(): void {
    editingSourceId = null;
    editingWebDav = false;
    sourceForm.reset();
    sourceOverlay.hidden = true;
    addSourceButton.classList.remove('is-open');
    if (!sourceOverlay.contains(doc.activeElement)) return;
    addSourceButton.focus();
  }

  function openSourceForm(source?: OpdsSource): void {
    editingSourceId = source?.id ?? null;
    editingWebDav = false;
    renderSourceForm(source);
    showSourceOverlay();
    sourceForm.querySelector<HTMLInputElement>('input')?.focus();
  }

  function openWebDavForm(): void {
    editingSourceId = null;
    editingWebDav = true;
    renderSourceForm(undefined, 'webdav');
    showSourceOverlay();
    sourceForm.querySelector<HTMLInputElement>('input')?.focus();
  }

  async function saveWebDav(): Promise<void> {
    if (deps.webdav === undefined) return;
    const data = new FormData(sourceForm);
    const auth = String(data.get('auth') ?? 'basic');
    const authType =
      auth === 'bearer' || auth === 'basic'
        ? auth
        : (webDavProfile?.authType ?? 'basic');
    try {
      webDavProfile = await deps.webdav.saveProfile({
        id: webDavProfile?.id,
        name: String(data.get('title') ?? ''),
        url: String(data.get('url') ?? ''),
        authType,
        allowHttp: data.get('allowHttp') === 'on',
        credential:
          auth === 'basic'
            ? {
                kind: 'basic',
                username: String(data.get('username') ?? ''),
                password: String(data.get('password') ?? ''),
              }
            : auth === 'bearer'
              ? { kind: 'bearer', token: String(data.get('token') ?? '') }
              : undefined,
      });
      closeSourceForm();
      renderSources();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function saveSource(): Promise<void> {
    const data = new FormData(sourceForm);
    if (editingWebDav || String(data.get('kind') ?? '') === 'webdav') {
      await saveWebDav();
      return;
    }
    const auth = String(data.get('auth') ?? 'none');
    const editing = sources.find((source) => source.id === editingSourceId);
    const input: OpdsSourceInput = {
      id: editing?.id,
      title: String(data.get('title') ?? ''),
      url: String(data.get('url') ?? ''),
      allowHttp: data.get('allowHttp') === 'on',
      credentialRef: auth === 'keep' ? editing?.credentialRef : undefined,
      clearCredential:
        editing?.credentialRef !== undefined && auth === 'none' ? true : undefined,
      credential:
        auth === 'basic'
          ? {
              kind: 'basic',
              username: String(data.get('username') ?? ''),
              password: String(data.get('password') ?? ''),
            }
          : auth === 'bearer'
            ? { kind: 'bearer', token: String(data.get('token') ?? '') }
            : undefined,
    };
    try {
      await deps.opds.addSource(input);
      sources = await deps.opds.listSources();
      closeSourceForm();
      await showMyBooks();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function removeWebDav(): Promise<void> {
    if (deps.webdav === undefined) return;
    try {
      await deps.webdav.forgetProfile();
      webDavProfile = null;
      if (editingWebDav) closeSourceForm();
      renderSources();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function removeSource(source: OpdsSource): Promise<void> {
    try {
      await deps.opds.removeSource(source.id);
      sources = sources.filter((candidate) => candidate.id !== source.id);
      if (editingSourceId === source.id) closeSourceForm();
      if (selectedSourceId === source.id) closeCatalog();
      else renderSources();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function removeItem(item: LibraryItem): Promise<void> {
    try {
      await deps.library.removeItem(item.id);
      items = items.filter((candidate) => candidate.item.id !== item.id);
      selected = null;
      renderItems();
      renderDetail();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function initialLoad(): Promise<void> {
    const generation = ++requestGeneration;
    beginBlockingLoad();
    try {
      sources = await deps.opds.listSources();
      if (generation !== requestGeneration) return;
      if (catalogActive()) {
        syncPageChrome();
        renderSources();
        await loadFeed(currentUrl, false);
        return;
      }
      if (activeSection === 'sources') {
        syncPageChrome();
        await refreshWebDavProfile();
        renderSources();
        return;
      }
      if (activeSection === 'manage') {
        syncPageChrome();
        await refreshWebDavProfile();
        renderSources();
        await updateCacheSummary();
        return;
      }
      activeSection = 'shelf';
      selectedSourceId = null;
      syncPageChrome();
      renderGroups();
      await loadPersistedItems();
    } catch (error) {
      if (generation !== requestGeneration) return;
      setStatus(errorText(error, labels().offline), true);
    }
  }

  function retranslate(): void {
    const l = labels();
    root.setAttribute('aria-label', l.library);
    manageNavButton.textContent = l.manage;
    editorButton.textContent = l.markdownEditor;
    editorButton.title = l.markdownEditor;
    editorButton.setAttribute('aria-label', l.markdownEditor);
    syncButton.textContent = l.webdavSync;
    syncButton.title = l.webdavSync;
    syncButton.setAttribute('aria-label', l.webdavSync);
    sourceTitle.textContent = l.sources;
    searchInput.placeholder = l.searchPlaceholder;
    searchInput.setAttribute('aria-label', l.searchPlaceholder);
    searchClear.title = l.clear;
    searchClear.setAttribute('aria-label', l.clear);
    searchButton.textContent = l.search;
    importButton.textContent = l.importLocal;
    clearCacheButton.textContent = l.clearCache;
    cacheLimitButton.title = l.changeCacheLimit;
    cacheLimitButton.setAttribute('aria-label', l.changeCacheLimit);
    cacheLimitLabelText.textContent = l.cacheLimit;
    cacheLimitSave.textContent = l.apply;
    addSourceButton.title = l.addSource;
    addSourceButton.setAttribute('aria-label', l.addSource);
    previousButton.textContent = l.prev;
    nextButton.textContent = l.next;
    syncPageChrome();
    renderGroups();
    renderSources();
    renderBreadcrumbs();
    renderContinueBar();
    renderItems();
    if (catalogActive()) renderDetail();
    if (editingWebDav) renderSourceForm(undefined, 'webdav');
    else renderSourceForm(sources.find((source) => source.id === editingSourceId));
    if (membershipItemId !== null) openMembershipEditor(membershipItemId);
    void updateCacheSummary();
  }

  function syncSearchClear(): void {
    searchClear.hidden = searchInput.value.trim() === '';
  }

  searchInput.addEventListener('input', () => {
    syncSearchClear();
    if (catalogActive()) return;
    void search();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    syncSearchClear();
    void search();
  });
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void search();
    syncSearchClear();
  });
  addGroupButton.addEventListener('click', () => {
    openGroupEditor({ kind: 'create' });
  });
  groupEditor.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (groupEditorMode === null) return;
    const name = groupNameInput.value.trim();
    if (name === '') return;
    try {
      if (groupEditorMode.kind === 'create') {
        if (deps.library.createGroup === undefined) return;
        const parentId = groupParentSelect.value === '' ? undefined : groupParentSelect.value;
        if (!canPlaceGroup(groups, undefined, parentId)) {
          deps.notify(labels().invalidGroupMove, 'warning');
          return;
        }
        const created = await deps.library.createGroup(name, parentId);
        if (created.parentId !== undefined) expandedGroupIds.add(created.parentId);
        if (pendingAddItemId !== null) {
          const itemId = pendingAddItemId;
          pendingAddItemId = null;
          await addItemToGroup(created.id, itemId);
        }
      } else {
        if (deps.library.updateGroup === undefined) return;
        await deps.library.updateGroup(groupEditorMode.groupId, name);
      }
      closeGroupEditor();
      await reloadGroups();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  });
  groupEditorCancel.addEventListener('click', () => closeGroupEditor());
  groupOverlay.addEventListener('click', (event) => {
    if (ignoreGroupBackdrop || event.target !== groupOverlay) return;
    closeGroupEditor();
  });
  groupList.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types !== undefined) event.preventDefault();
  });
  groupList.addEventListener('drop', (event) => {
    event.preventDefault();
    const draggedGroup = event.dataTransfer?.getData('application/x-lightink-library-group') ?? '';
    if (draggedGroup !== '') void moveCustomGroup(draggedGroup, undefined, groups.length);
  });
  membershipForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (membershipItemId === null) return;
    const itemId = membershipItemId;
    const groupIds = Array.from(
      membershipOptions.querySelectorAll<HTMLInputElement>('input[name="membership"]:checked'),
    ).map((input) => input.value);
    const offlinePin = membershipOptions.querySelector<HTMLInputElement>(
      'input[name="offlinePinned"]',
    );
    try {
      if (deps.library.setItemGroups !== undefined) {
        await deps.library.setItemGroups(itemId, groupIds);
        memberships = memberships.filter((entry) => entry.itemId !== itemId);
        memberships.push(...groupIds.map((groupId) => ({ groupId, itemId })));
      }
      if (offlinePin !== null && deps.library.setOfflinePinned !== undefined) {
        await deps.library.setOfflinePinned(itemId, offlinePin.checked);
        const current = items.find((candidate) => candidate.item.id === itemId)?.item;
        if (current !== undefined) {
          updateItemInMemory({ ...current, offlinePinned: offlinePin.checked });
        }
      }
      closeMembershipEditor();
      renderItems();
      deps.onLocalChange?.();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  });
  membershipCancel.addEventListener('click', () => closeMembershipEditor());
  membershipOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === membershipOverlay) closeMembershipEditor();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !groupOverlay.hidden) {
      event.preventDefault();
      closeGroupEditor();
      return;
    }
    if (event.key === 'Escape' && !membershipOverlay.hidden) {
      event.preventDefault();
      closeMembershipEditor();
      return;
    }
    if (event.key === 'Escape' && !sourceOverlay.hidden) {
      event.preventDefault();
      closeSourceForm();
    }
  });
  myBooksButton.addEventListener('click', () => {
    selectedGroup = 'all';
    selectedCustomGroupId = null;
    selectedSmartGroupId = null;
    void activateShelf();
  });
  manageNavButton.addEventListener('click', () => void showManage());
  editorButton.addEventListener('click', () => deps.onEnterEditor?.());
  syncButton.addEventListener('click', () => deps.onOpenSyncPanel?.());
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  addSourceButton.addEventListener('click', () => {
    if (sourceOverlay.hidden || editingSourceId !== null || editingWebDav) openSourceForm();
    else closeSourceForm();
  });
  sourceOverlay.addEventListener('click', (event) => {
    if (ignoreSourceBackdrop || event.target !== sourceOverlay) return;
    closeSourceForm();
  });
  sourceForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSource();
  });
  importButton.addEventListener('click', async () => {
    const item = await deps.onImportLocal();
    if (item !== null) {
      deps.onLocalChange?.();
      await showMyBooks();
    }
  });
  clearCacheButton.addEventListener('click', async () => {
    try {
      await deps.library.clearCache();
      await updateCacheSummary();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  });
  const setCacheLimitOpen = (open: boolean): void => {
    cacheLimitForm.hidden = !open;
    cacheLimitButton.classList.toggle('is-open', open);
    cacheLimitButton.setAttribute('aria-expanded', String(open));
  };
  cacheLimitButton.setAttribute('aria-expanded', 'false');
  cacheLimitButton.addEventListener('click', () => {
    const open = cacheLimitForm.hidden;
    setCacheLimitOpen(open);
    if (open) cacheLimitInput.focus();
  });
  cacheLimitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const gibibytes = cacheLimitInput.valueAsNumber;
    if (!Number.isFinite(gibibytes) || gibibytes <= 0) return;
    try {
      await deps.library.setCacheLimit(Math.round(gibibytes * 1024 ** 3));
      setCacheLimitOpen(false);
      await updateCacheSummary();
      cacheLimitButton.focus();
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  });
  retryButton.addEventListener('click', () => void lastAction?.());
  previousButton.addEventListener('click', () => {
    if (feed?.previousUrl != null && feed.previousUrl !== '') {
      void loadFeed(feed.previousUrl, false);
    }
  });
  nextButton.addEventListener('click', () => {
    if (feed?.nextUrl != null && feed.nextUrl !== '') {
      void loadFeed(feed.nextUrl, false);
    }
  });
  itemList.addEventListener('keydown', (event) => {
    const rows = Array.from(itemList.querySelectorAll<HTMLButtonElement>('.lightink-library-item'));
    if (rows.length === 0) return;
    const shown = visibleItems();
    const current = doc.activeElement instanceof HTMLButtonElement ? rows.indexOf(doc.activeElement) : -1;
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (vertical || (horizontal && activeSection === 'shelf')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const next = Math.max(0, Math.min(rows.length - 1, current + delta));
      rows[next]?.focus();
      if (catalogActive()) {
        const display = shown.find((candidate) => candidate.item.id === rows[next]?.dataset.itemId);
        if (display !== undefined) void selectItem(display);
      }
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault();
      const display = shown.find((candidate) => candidate.item.id === rows[current]?.dataset.itemId);
      void openSelected(display ?? null);
    }
  });

  renderSourceForm();
  retranslate();

  function hide(options?: LibraryHideOptions | Event): void {
    requestGeneration += 1;
    for (const controller of activeOperations) controller.abort();
    activeOperations.clear();
    root.hidden = true;
    if (!(options instanceof Event) && options?.notifyVisibility === false) {
      return;
    }
    deps.onVisibilityChange?.(false);
  }

  return {
    element: root,
    get visible() {
      return !root.hidden;
    },
    async show() {
      root.hidden = false;
      deps.onVisibilityChange?.(true);
      activeSection = 'shelf';
      selectedGroup = 'all';
      selectedSmartGroupId = null;
      selectedCustomGroupId = null;
      searchInput.value = '';
      syncSearchClear();
      await initialLoad();
      searchInput.focus();
    },
    hide,
    async toggle() {
      if (root.hidden) await this.show();
      else hide();
    },
    refresh: initialLoad,
    retranslate,
    destroy() {
      requestGeneration += 1;
      for (const controller of activeOperations) controller.abort();
      activeOperations.clear();
      deps.workspaceTravel?.remove();
      root.remove();
    },
  };
}

export const libraryViewInternals = { bytesLabel, itemFromEntry };
