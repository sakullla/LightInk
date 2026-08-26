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
import {
  createSearchBusyReveal,
  isAbortError,
  liveSearchMinChars,
  observeLoadMore,
} from '../reader/search-panel.js';
import {
  createLibraryTabbar,
  type LibraryTabbarLabels,
  type LibraryTabId,
} from './library-tabbar.js';
import { isShelfCoverUrl } from './local-book-meta.js';
import {
  bytesLabel,
  createLibraryManage,
  type LibraryManageLabels,
} from './library-manage.js';
import {
  coverProgressFillPercent,
  type LibraryProgress,
  type LibraryProgressQuery,
  type ProjectLibraryProgressOptions,
} from './library-progress.js';
import {
  libraryRemoteSourceOf,
  type LibraryRemoteSource,
  type OpdsClient,
  type OpdsEntry,
  type OpdsFeed,
  type OpdsLink,
  type OpdsSource,
  type OpdsSourceInput,
} from './opds-client.js';
import type { ProgressStorage } from '../reader/reading-progress.js';
import type { ReaderPrefsStorage } from '../reader/reader-prefs.js';
import { createContextMenu, type MenuItem } from '../ui/context-menu.js';
import { beginOpenProgress } from '../ui/open-progress.js';
import { bindLongPress } from '../ui/touch/long-press.js';
import type { WebDavSourceClient } from './webdav-source-client.js';
import {
  applyLibraryTheme,
  loadLibraryTheme,
  mountLibraryOverlay,
  type LibraryThemeId,
  type LibraryThemeStorage,
} from './library-theme.js';

type Locale = 'en' | 'zh-CN';
type LibrarySection = 'shelf' | 'sources' | 'manage';
type ShelfGroup = 'all' | 'in-progress' | 'unread' | 'text' | 'comic';

interface Labels {
  library: string;
  brand: string;
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
  editWebDav: string;
  testConnection: string;
  testConnectionOk: string;
  httpNotAllowed: string;
  importLocal: string;
  search: string;
  searchPlaceholder: string;
  searchCatalogPlaceholder: string;
  clear: string;
  empty: string;
  emptyCatalog: string;
  emptySearch: string;
  emptyFilter: string;
  emptySources: string;
  loading: string;
  searching: string;
  loadMore: string;
  opening: string;
  downloading: string;
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
  closeDetails: string;
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
  collapse: string;
  expand: string;
  filterGroups: string;
  filterSmartGroups: string;
  filterSources: string;
  noMatch: string;
  emptyGroups: string;
  managedBooks: string;
  remoteBooks: string;
  epubBooks: string;
  pdfBooks: string;
  authorGroup: string;
  seriesGroup: string;
  sourceGroup: string;
  formatGroup: string;
  libraryTheme: string;
  libraryThemeHint: string;
  appearance: string;
  readingGroup: string;
  readerPrefsHint: string;
  showProgressBar: string;
  storageGroup: string;
  syncGroup: string;
  otherGroup: string;
  backToManage: string;
  themePaper: string;
  themeGallery: string;
  themeMoss: string;
  themeWalnut: string;
  themeInk: string;
  collapseNav: string;
  expandNav: string;
  resizeNav: string;
  tabNavigation: string;
  tabShelf: string;
  tabSources: string;
  backToSources: string;
  importShort: string;
}

const LABELS: Record<Locale, Labels> = {
  en: {
    library: 'Library',
    brand: 'LightInk',
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
    editWebDav: 'Edit WebDAV',
    testConnection: 'Test connection',
    testConnectionOk: 'Connection succeeded',
    httpNotAllowed: 'HTTP addresses require Allow HTTP/LAN.',
    importLocal: 'Import local book',
    search: 'Search',
    searchPlaceholder: 'Search this library',
    searchCatalogPlaceholder: 'Search {name}',
    clear: 'Clear',
    empty: 'No books found',
    emptyCatalog: 'No books in this folder. Search, or open a folder.',
    emptySearch: 'No matching books',
    emptyFilter: 'Nothing in this view',
    emptySources: 'No library sources yet. Use + to add one.',
    loading: 'Loading…',
    searching: 'Searching…',
    loadMore: 'Load more',
    opening: 'Opening…',
    downloading: 'Downloading…',
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
    closeDetails: 'Close',
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
    collapse: 'Collapse',
    expand: 'Expand',
    filterGroups: 'Filter collections…',
    filterSmartGroups: 'Filter smart groups…',
    filterSources: 'Filter sources…',
    noMatch: 'No matches',
    emptyGroups: 'No collections yet. Use + to create one.',
    libraryTheme: 'Shelf theme',
    libraryThemeHint: 'Applies to the shelf only. Editor and reader keep their own themes.',
    appearance: 'Appearance',
    readingGroup: 'Reading preferences',
    readerPrefsHint: 'Applies while reading. Turn the bottom progress bar off for a cleaner page.',
    showProgressBar: 'Show progress bar',
    storageGroup: 'Storage & cache',
    syncGroup: 'Sync',
    otherGroup: 'Other',
    backToManage: 'Back',
    themePaper: 'Paper',
    themeGallery: 'Gallery',
    themeMoss: 'Moss',
    themeWalnut: 'Walnut',
    themeInk: 'Ink',
    collapseNav: 'Collapse sidebar',
    expandNav: 'Expand sidebar',
    resizeNav: 'Resize sidebar',
    tabNavigation: 'Library navigation',
    tabShelf: 'Shelf',
    tabSources: 'Sources',
    backToSources: 'Back to sources',
    importShort: 'Import',
  },
  'zh-CN': {
    library: '书库',
    brand: '轻墨',
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
    editWebDav: '编辑 WebDAV',
    testConnection: '测试连接',
    testConnectionOk: '连接成功',
    httpNotAllowed: 'HTTP 地址需要勾选允许 HTTP/LAN',
    importLocal: '导入本地书籍',
    search: '搜索',
    searchPlaceholder: '搜索当前书库',
    searchCatalogPlaceholder: '搜索 {name}',
    clear: '清除',
    empty: '暂无作品',
    emptyCatalog: '此目录没有书籍。可以搜索，或打开文件夹。',
    emptySearch: '没有匹配的作品',
    emptyFilter: '这一组还没有作品',
    emptySources: '还没有书库源，点 + 添加。',
    loading: '正在加载…',
    searching: '正在搜索…',
    loadMore: '加载更多',
    opening: '正在打开…',
    downloading: '正在下载…',
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
    closeDetails: '关闭',
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
    collapse: '折叠',
    expand: '展开',
    filterGroups: '筛选分组…',
    filterSmartGroups: '筛选智能分组…',
    filterSources: '筛选书库源…',
    noMatch: '无匹配项',
    emptyGroups: '还没有分组，点 + 新建。',
    libraryTheme: '书架主题',
    libraryThemeHint: '只改变书架外观，不影响编辑器和阅读器。',
    appearance: '外观',
    readingGroup: '阅读偏好',
    readerPrefsHint: '只影响阅读界面。关闭后阅读区底部不再显示进度条。',
    showProgressBar: '显示进度条',
    storageGroup: '存储与缓存',
    syncGroup: '同步',
    otherGroup: '其他',
    backToManage: '返回',
    themePaper: '纸书',
    themeGallery: '展厅',
    themeMoss: '苔绿',
    themeWalnut: '胡桃',
    themeInk: '墨黑',
    collapseNav: '收起导航',
    expandNav: '展开导航',
    resizeNav: '调整侧栏宽度',
    tabNavigation: '书库导航',
    tabShelf: '书架',
    tabSources: '书源',
    backToSources: '返回书源',
    importShort: '导入',
  },
};

export interface LibraryOpenProgress {
  readonly phase: 'download' | 'open';
  readonly loaded?: number;
  readonly total?: number;
}

export interface LibraryOpenRequest {
  readonly item: LibraryItem;
  readonly acquisition?: AcquisitionLink;
  readonly source?: LibraryRemoteSource;
  readonly onProgress?: (progress: LibraryOpenProgress) => void;
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
  readonly webdavSource?: Pick<
    WebDavSourceClient,
    'addSource' | 'listSources' | 'removeSource' | 'browse' | 'test'
  >;
  readonly onOpenSyncPanel?: () => void;
  /** Persists the shelf chrome theme; never the editor or reader keys. */
  readonly themeStorage?: LibraryThemeStorage | null;
  /** Persists reader chrome prefs such as the bottom progress bar. */
  readonly readerPrefsStorage?: ReaderPrefsStorage | null;
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

type CatalogSourceKind = 'opds' | 'webdav';

interface CatalogSource extends OpdsSource {
  readonly kind: CatalogSourceKind;
}

function asCatalogSources(
  kind: CatalogSourceKind,
  list: readonly OpdsSource[],
): CatalogSource[] {
  return list.map((source) => ({ ...source, kind }));
}

function withoutCatalogKind(source: CatalogSource): LibraryRemoteSource {
  return libraryRemoteSourceOf(source);
}

function httpRequiresAllow(url: string): boolean {
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

interface DisplayItem {
  readonly item: LibraryItem;
  readonly entry?: OpdsEntry;
  readonly links: readonly AcquisitionLink[];
  readonly catalogGroupKey?: string;
  readonly catalogGroupTitle?: string;
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

/** Shelf rows persist the primary download on the item, not in `links`. */
function acquisitionFromItem(item: LibraryItem): AcquisitionLink | undefined {
  if (item.acquisitionUrl == null || item.acquisitionUrl === '') {
    return undefined;
  }
  return {
    itemId: item.id,
    href: item.acquisitionUrl,
    rel: 'http://opds-spec.org/acquisition',
    mediaType: item.mediaType,
    extension: item.extension,
    size: item.size,
  };
}

function displayFromPersistedItem(item: LibraryItem): DisplayItem {
  const fallback = acquisitionFromItem(item);
  return { item, links: fallback === undefined ? [] : [fallback] };
}

function itemFromEntry(
  sourceId: string,
  entry: OpdsEntry,
  sourceKind: LibraryItem['sourceKind'] = 'opds',
): DisplayItem {
  const itemId = entry.itemId ?? `${sourceKind}:${sourceId}:${entry.id}`;
  const links = entry.links
    .filter((link) => link.acquisition)
    .map((link) => acquisitionFromOpds(itemId, link));
  const primary = links[0];
  return {
    item: {
      id: itemId,
      sourceId,
      sourceKind,
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

function itemsFromFeed(
  sourceId: string,
  feed: OpdsFeed,
  sourceKind: LibraryItem['sourceKind'] = 'opds',
): DisplayItem[] {
  const displays = feed.entries.map((entry) => itemFromEntry(sourceId, entry, sourceKind));
  for (const [index, group] of (feed.groups ?? []).entries()) {
    const entries = [...(group.publications ?? []), ...group.navigation];
    for (const entry of entries) {
      displays.push({
        ...itemFromEntry(sourceId, entry, sourceKind),
        catalogGroupKey: `opds-group-${index}`,
        catalogGroupTitle: group.title,
      });
    }
  }
  return displays;
}

function isNavigationDisplay(display: DisplayItem): boolean {
  return display.entry?.kind === 'navigation';
}

function publicationsFromFeed(
  sourceId: string,
  feed: OpdsFeed,
  sourceKind: LibraryItem['sourceKind'] = 'opds',
): DisplayItem[] {
  return itemsFromFeed(sourceId, feed, sourceKind).filter(
    (display) => !isNavigationDisplay(display),
  );
}

function navigationFromFeed(
  sourceId: string,
  feed: OpdsFeed,
  sourceKind: LibraryItem['sourceKind'] = 'opds',
): DisplayItem[] {
  const seen = new Set<string>();
  const navigations: DisplayItem[] = [];
  for (const display of itemsFromFeed(sourceId, feed, sourceKind)) {
    if (!isNavigationDisplay(display)) continue;
    const url = display.entry?.navigationUrl;
    if (url == null || url === '' || seen.has(url)) continue;
    seen.add(url);
    navigations.push(display);
  }
  return navigations;
}

interface CatalogTreeNode {
  key: string;
  title: string;
  url: string | undefined;
  children: CatalogTreeNode[];
  publications: DisplayItem[];
  loaded: boolean;
  expanded: boolean;
}

function catalogNodeKey(url?: string): string {
  return url ?? '';
}

const CATALOG_SEARCH_DEBOUNCE_MS = 320;
/** Quiet follow of OPDS `rel=next` after the first search page. Not HTTP streaming. */
const CATALOG_STREAM_PAGE_CAP = 8;

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

/** Reading clock from projected progress. Missing or non-finite values count as 0. */
function progressClock(progress: Extract<LibraryProgress, { status: 'in-progress' }>): number {
  const raw = (progress as { readonly updatedAt?: unknown }).updatedAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
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

const LIBRARY_NAV_COLLAPSED_KEY = 'lightink.library.navCollapsed';
const LIBRARY_NAV_WIDTH_KEY = 'lightink.library.navWidth';
const LIBRARY_NAV_WIDTH_MAX = 420;
const LIBRARY_NAV_CONTENT_RESERVE = 240;

function loadNavCollapsed(storage: LibraryThemeStorage | null | undefined): boolean {
  try {
    return storage?.getItem(LIBRARY_NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveNavCollapsed(
  storage: LibraryThemeStorage | null | undefined,
  collapsed: boolean,
): void {
  try {
    storage?.setItem(LIBRARY_NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Privacy mode / quota — keep the session value.
  }
}

function loadNavWidth(storage: LibraryThemeStorage | null | undefined): number | null {
  try {
    const raw = storage?.getItem(LIBRARY_NAV_WIDTH_KEY);
    if (raw == null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value);
  } catch {
    return null;
  }
}

function saveNavWidth(storage: LibraryThemeStorage | null | undefined, width: number): void {
  try {
    storage?.setItem(LIBRARY_NAV_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Privacy mode / quota — keep the session value.
  }
}

const SHELF_GROUPS: readonly ShelfGroup[] = ['all', 'in-progress', 'unread', 'text', 'comic'];

// 内置智能组中与书库快捷过滤（SHELF_GROUPS）语义重复的项，不在智能分组导航中重复渲染。
const SHELF_FILTER_SMART_IDS: ReadonlySet<string> = new Set([
  'smart:in-progress',
  'smart:unread',
  'smart:text',
  'smart:comic',
]);

function libraryThemeLabel(labels: Labels, id: LibraryThemeId): string {
  switch (id) {
    case 'paper':
      return labels.themePaper;
    case 'gallery':
      return labels.themeGallery;
    case 'moss':
      return labels.themeMoss;
    case 'walnut':
      return labels.themeWalnut;
    case 'ink':
      return labels.themeInk;
  }
}

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

/** 导航图标：feather 风格，stroke=currentColor。分区标题用类型图标，筛选项用功能图标。 */
const NAV_ICON_PATHS = {
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
  chevron: ['M9 18l6-6-6-6'],
  chevronLeft: ['M15 18l-6-6 6-6'],
  folder: [
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  ],
  sparkles: [
    'M12 3l1.4 4.2L18 8.6l-4.6 1.4L12 14l-1.4-4L6 8.6l4.6-1.4L12 3z',
    'M18.5 13.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1z',
  ],
  source: ['M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  library: [
    'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
    'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  ],
  reading: ['M12 8v4l3 3', 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z'],
  unread: [
    'M22 12h-6l-2 3h-4l-2-3H2',
    'M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  ],
  text: [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
    'M14 2v6h6',
    'M16 13H8',
    'M16 17H8',
    'M10 9H8',
  ],
  comic: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  hash: ['M4 9h16', 'M4 15h16', 'M10 3L8 21', 'M16 3l-2 18'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  plus: ['M12 5v14', 'M5 12h14'],
} as const;

const SHELF_NAV_ICONS: Record<ShelfGroup, readonly string[]> = {
  all: NAV_ICON_PATHS.library,
  'in-progress': NAV_ICON_PATHS.reading,
  unread: NAV_ICON_PATHS.unread,
  text: NAV_ICON_PATHS.text,
  comic: NAV_ICON_PATHS.comic,
};

function createNavIcon(
  doc: Document,
  paths: readonly string[],
  className = 'lightink-library-nav-icon',
): SVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of paths) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
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
  applyLibraryTheme(root, loadLibraryTheme(deps.themeStorage));

  const header = doc.createElement('header');
  header.className = 'lightink-library-header';
  header.setAttribute('data-tauri-drag-region', '');
  const brand = doc.createElement('div');
  brand.className = 'lightink-library-brand';
  brand.setAttribute('data-tauri-drag-region', '');
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
  const headerMain = doc.createElement('div');
  headerMain.className = 'lightink-library-header-main';
  const toolbar = doc.createElement('div');
  toolbar.className = 'lightink-library-toolbar';
  const manageNavButton = button(doc, '', 'lightink-library-nav-item lightink-library-manage-entry');
  manageNavButton.dataset.libraryNavItem = 'manage';
  const headerImport = button(doc, '', 'lightink-library-header-import lightink-library-icon-button');
  headerImport.appendChild(createNavIcon(doc, NAV_ICON_PATHS.plus));
  headerMain.append(heading, searchForm, headerImport, toolbar);
  header.append(brand, headerMain);

  const body = doc.createElement('div');
  body.className = 'lightink-library-body';
  const navPane = doc.createElement('aside');
  navPane.className = 'lightink-library-nav';
  navPane.id = 'lightink-library-nav';
  const groupPane = doc.createElement('section');
  groupPane.className = 'lightink-library-groups lightink-library-nav-section';
  groupPane.dataset.navSection = 'shelf';
  const shelfHeading = doc.createElement('h2');
  shelfHeading.className = 'lightink-library-nav-heading';
  const filterList = doc.createElement('nav');
  filterList.className = 'lightink-library-filter-list';
  /** 分区筛选（搜索按钮 + 内嵌图标输入框）：分组 / 智能分组 / 书库源共用同一模式。 */
  interface SectionFilterRefs {
    toggle: HTMLButtonElement;
    wrap: HTMLDivElement;
    input: HTMLInputElement;
    clear: HTMLButtonElement;
  }
  const createSectionFilter = (modifier: string): SectionFilterRefs => {
    const toggle = button(
      doc,
      '',
      `lightink-library-icon-button lightink-library-pane-action lightink-library-section-filter-toggle lightink-library-${modifier}-filter-toggle`,
    );
    toggle.appendChild(createNavIcon(doc, NAV_ICON_PATHS.search));
    toggle.setAttribute('aria-expanded', 'false');
    const wrap = doc.createElement('div');
    wrap.className = 'lightink-library-section-filter-wrap';
    wrap.hidden = true;
    wrap.appendChild(createNavIcon(doc, NAV_ICON_PATHS.search));
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = `lightink-library-section-filter lightink-library-${modifier}-filter`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const clear = button(
      doc,
      '×',
      'lightink-library-icon-button lightink-library-section-filter-clear',
    );
    clear.type = 'button';
    clear.hidden = true;
    wrap.append(input, clear);
    return { toggle, wrap, input, clear };
  };
  const paneActions = (...items: HTMLElement[]): HTMLDivElement => {
    const cluster = doc.createElement('div');
    cluster.className = 'lightink-library-pane-actions';
    cluster.append(...items);
    return cluster;
  };
  const createSectionToggle = (section: string): HTMLButtonElement => {
    const toggle = button(
      doc,
      '',
      'lightink-library-icon-button lightink-library-collapse-toggle',
    );
    toggle.dataset.navToggle = section;
    toggle.appendChild(
      createNavIcon(doc, NAV_ICON_PATHS.chevron, 'lightink-library-collapse-chevron'),
    );
    return toggle;
  };

  const groupHeader = doc.createElement('div');
  groupHeader.className = 'lightink-library-pane-heading';
  const groupToggle = createSectionToggle('groups');
  const groupTitle = doc.createElement('h2');
  const groupFilter = createSectionFilter('group');
  const addGroupButton = button(
    doc,
    '+',
    'lightink-library-icon-button lightink-library-group-add lightink-library-pane-action',
  );
  groupHeader.append(
    groupToggle,
    createNavIcon(doc, NAV_ICON_PATHS.folder, 'lightink-library-section-icon'),
    groupTitle,
    paneActions(groupFilter.toggle, addGroupButton),
  );
  const groupList = doc.createElement('nav');
  groupList.className = 'lightink-library-group-list';
  const groupBody = doc.createElement('div');
  groupBody.className = 'lightink-library-group-body';
  groupBody.append(groupFilter.wrap, groupList);
  const smartGroupHeader = doc.createElement('div');
  smartGroupHeader.className = 'lightink-library-pane-heading';
  const smartGroupToggle = createSectionToggle('smart-groups');
  const smartGroupTitle = doc.createElement('h3');
  const smartGroupFilter = createSectionFilter('smart-group');
  smartGroupHeader.append(
    smartGroupToggle,
    createNavIcon(doc, NAV_ICON_PATHS.sparkles, 'lightink-library-section-icon'),
    smartGroupTitle,
    paneActions(smartGroupFilter.toggle),
  );
  const smartGroupList = doc.createElement('nav');
  smartGroupList.className = 'lightink-library-smart-group-list';
  const smartGroupBody = doc.createElement('div');
  smartGroupBody.className = 'lightink-library-smart-group-body';
  smartGroupBody.append(smartGroupFilter.wrap, smartGroupList);
  groupPane.append(
    shelfHeading,
    filterList,
    groupHeader,
    groupBody,
    smartGroupHeader,
    smartGroupBody,
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
  const sourceToggle = createSectionToggle('sources');
  const sourceTitle = doc.createElement('h2');
  const sourceFilter = createSectionFilter('source');
  const addSourceButton = button(
    doc,
    '+',
    'lightink-library-icon-button lightink-library-pane-action',
  );
  sourceHeader.append(
    sourceToggle,
    createNavIcon(doc, NAV_ICON_PATHS.source, 'lightink-library-section-icon'),
    sourceTitle,
    paneActions(sourceFilter.toggle, addSourceButton),
  );
  const sourceList = doc.createElement('nav');
  sourceList.className = 'lightink-library-source-list';
  const sourceBody = doc.createElement('div');
  sourceBody.className = 'lightink-library-source-body';
  sourceBody.append(sourceFilter.wrap, sourceList);
  sourcePane.append(sourceHeader, sourceBody);
  const catalogPane = doc.createElement('section');
  catalogPane.className = 'lightink-library-catalog-pane lightink-library-nav-section';
  catalogPane.dataset.navSection = 'catalog';
  catalogPane.hidden = true;
  const catalogBack = button(doc, '', 'lightink-library-nav-item lightink-library-back-to-shelf');
  const catalogHeading = doc.createElement('h2');
  catalogHeading.className = 'lightink-library-nav-heading';
  const catalogTree = doc.createElement('nav');
  catalogTree.className = 'lightink-library-catalog-tree';
  catalogTree.setAttribute('aria-label', 'Catalog');
  catalogPane.append(catalogBack, catalogHeading, catalogTree);
  const managePane = doc.createElement('section');
  managePane.className = 'lightink-library-manage lightink-library-nav-section';
  managePane.dataset.navSection = 'manage';
  const manageNav = doc.createElement('nav');
  manageNav.className = 'lightink-library-manage-nav';
  manageNav.append(manageNavButton);
  managePane.append(manageNav);
  const navCollapse = button(
    doc,
    '',
    'lightink-library-icon-button lightink-library-nav-collapse',
  );
  navCollapse.appendChild(createNavIcon(doc, NAV_ICON_PATHS.chevron));
  navCollapse.setAttribute('aria-controls', navPane.id);
  navPane.style.position = 'relative';
  const navResize = doc.createElement('div');
  navResize.className = 'lightink-library-nav-resize';
  navResize.setAttribute('role', 'separator');
  navResize.setAttribute('aria-orientation', 'vertical');
  navResize.style.position = 'absolute';
  navResize.style.top = '0';
  navResize.style.right = '0';
  navResize.style.bottom = '0';
  navResize.style.width = '6px';
  navResize.style.cursor = 'col-resize';
  navResize.style.touchAction = 'none';
  navResize.style.zIndex = '2';
  navPane.append(groupPane, sourcePane, catalogPane, managePane, navCollapse, navResize);
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
  const chipRow = doc.createElement('nav');
  chipRow.className = 'lightink-library-shelf-chips';
  chipRow.hidden = true;
  const workArea = doc.createElement('div');
  workArea.className = 'lightink-library-workarea';
  const itemList = doc.createElement('div');
  itemList.className = 'lightink-library-items';
  itemList.setAttribute('role', 'listbox');
  itemList.tabIndex = 0;
  const detail = doc.createElement('aside');
  detail.className = 'lightink-library-detail';
  detail.hidden = true;
  const detailBackdrop = doc.createElement('div');
  detailBackdrop.className = 'lightink-library-detail-backdrop';
  detailBackdrop.hidden = true;
  workArea.append(itemList, detail);
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
  root.append(header, body, detailBackdrop, membershipOverlay, groupOverlay, sourceOverlay);
  host.appendChild(root);

  let navRailCollapsed = loadNavCollapsed(deps.themeStorage);
  let navWidthPx = loadNavWidth(deps.themeStorage);
  const importedItemIds = new Set<string>();
  root.dataset.libraryNavCollapsed = navRailCollapsed ? 'true' : 'false';
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
  let sources: CatalogSource[] = [];
  let selectedSourceId: string | null = null;
  let catalogRoot: CatalogTreeNode | null = null;
  let selectedCatalogKey = '';
  let editingSourceId: string | null = null;
  let editingSourceKind: CatalogSourceKind = 'opds';
  let selected: DisplayItem | null = null;
  let items: DisplayItem[] = [];
  let shelfItems: DisplayItem[] = [];
  let feed: OpdsFeed | null = null;
  let currentUrl: string | undefined;
  let lastAction: (() => Promise<void>) | null = null;
  let requestGeneration = 0;
  let catalogSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let catalogComposing = false;
  let catalogSearchAbort: AbortController | null = null;
  let catalogLoadingMore = false;
  /** Invalidates in-flight `rel=next` fetches when search/browse replaces the feed. */
  let catalogFeedEpoch = 0;
  /** Epoch of the load-more request that currently owns `catalogLoadingMore`. */
  let catalogLoadEpoch = 0;
  /** Bumped on every load-more start so a stale `finally` cannot drop a newer lock. */
  let catalogLoadSeq = 0;
  let catalogAwaitingSearch = false;
  let catalogStreamPages = 0;
  let catalogMoreRelease: (() => void) | null = null;
  const catalogBusy = createSearchBusyReveal(() => {
    if (!catalogActive()) return;
    if (!catalogHasPaintedContent()) {
      setStatus(labels().searching);
      itemList.replaceChildren();
      return;
    }
    const more = itemList.querySelector<HTMLButtonElement>('.lightink-library-catalog-more');
    if (more !== null) {
      more.disabled = true;
      more.textContent = labels().searching;
    }
  });
  const activeOperations = new Set<AbortController>();
  const trail: Array<{ title: string; url?: string }> = [];
  let groupListCollapsed = false;
  let smartGroupListCollapsed = true;
  let sourceListCollapsed = false;
  let groupFilterQuery = '';
  let smartGroupFilterQuery = '';
  let sourceFilterQuery = '';

  function setNavSectionCollapsed(
    toggle: HTMLButtonElement,
    list: HTMLElement,
    collapsed: boolean,
    sectionLabel: string,
  ): void {
    list.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.closest('.lightink-library-pane-heading')?.classList.toggle('is-collapsed', collapsed);
    const action = collapsed ? labels().expand : labels().collapse;
    toggle.title = `${action}: ${sectionLabel}`;
    toggle.setAttribute('aria-label', `${action}: ${sectionLabel}`);
  }

  const labels = (): Labels => LABELS[deps.getLocale()];

  const isMobileLibraryChrome = (): boolean => {
    const rootEl = typeof document !== 'undefined' ? document.documentElement : null;
    return (
      rootEl?.hasAttribute('data-android') === true ||
      rootEl?.hasAttribute('data-touch-primary') === true
    );
  };

  const tabbarLabels = (): LibraryTabbarLabels => ({
    navigation: labels().tabNavigation,
    shelf: labels().tabShelf,
    sources: labels().tabSources,
    manage: labels().manage,
  });

  function rememberImportedItems(list: readonly LibraryItem[]): void {
    importedItemIds.clear();
    for (const item of list) importedItemIds.add(item.id);
  }

  function canRemoveFromLibrary(display: DisplayItem): boolean {
    if (display.entry?.kind === 'navigation') return false;
    return isLocalItem(display.item) || importedItemIds.has(display.item.id);
  }

  function navWidthBounds(): { min: number; max: number } {
    const styles = doc.defaultView?.getComputedStyle(root);
    const tokenMin = Number.parseFloat(styles?.getPropertyValue('--lightink-library-nav-min') ?? '');
    const min = Number.isFinite(tokenMin) && tokenMin > 0 ? tokenMin : 168;
    const available = body.getBoundingClientRect().width;
    const reserved =
      Number.isFinite(available) && available > 0
        ? Math.max(min, available - LIBRARY_NAV_CONTENT_RESERVE)
        : LIBRARY_NAV_WIDTH_MAX;
    return { min, max: Math.min(LIBRARY_NAV_WIDTH_MAX, reserved) };
  }

  function applyNavWidth(width: number | null): void {
    if (navRailCollapsed || width === null) {
      root.style.removeProperty('--lightink-library-nav-width');
      return;
    }
    const { min, max } = navWidthBounds();
    const next = Math.min(max, Math.max(min, Math.round(width)));
    navWidthPx = next;
    root.style.setProperty('--lightink-library-nav-width', `${next}px`);
  }

  const setNavRailCollapsed = (collapsed: boolean, persist = true): void => {
    navRailCollapsed = collapsed;
    root.dataset.libraryNavCollapsed = collapsed ? 'true' : 'false';
    navCollapse.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? labels().expandNav : labels().collapseNav;
    navCollapse.title = label;
    navCollapse.setAttribute('aria-label', label);
    navResize.hidden = collapsed;
    applyNavWidth(collapsed ? null : navWidthPx);
    if (persist) saveNavCollapsed(deps.themeStorage, collapsed);
  };
  setNavRailCollapsed(navRailCollapsed, false);
  // 底部 Tab 栏仅移动 chrome 挂载；≤760px 断点由 CSS 控制可见性，
  // 宽视口（含触屏桌面）只见桌面导航栏。
  const tabbar = isMobileLibraryChrome()
    ? createLibraryTabbar(doc, {
        labels: tabbarLabels(),
        onSelect: (tab) => void activateMobileTab(tab),
      })
    : null;
  if (tabbar !== null) root.appendChild(tabbar.element);
  // 管理页：分组设置页 DOM 与缓存上限弹层由 library-manage 拥有；view 只提供
  // deps 适配（导入后回书架）与挂载点（syncPageChrome 的 manage 分支）。
  const manageLabels = (): LibraryManageLabels => {
    const l = labels();
    return {
      appearance: l.appearance,
      libraryTheme: l.libraryTheme,
      libraryThemeHint: l.libraryThemeHint,
      readingGroup: l.readingGroup,
      readerPrefsHint: l.readerPrefsHint,
      showProgressBar: l.showProgressBar,
      storageGroup: l.storageGroup,
      clearCache: l.clearCache,
      cacheUsage: l.cacheUsage,
      cacheLimit: l.cacheLimit,
      changeCacheLimit: l.changeCacheLimit,
      apply: l.apply,
      cancel: l.cancel,
      syncGroup: l.syncGroup,
      webdavSync: l.webdavSync,
      otherGroup: l.otherGroup,
      importLocal: l.importLocal,
      markdownEditor: l.markdownEditor,
    };
  };

  async function importLocalBook(): Promise<void> {
    const item = await deps.onImportLocal();
    if (item !== null) {
      deps.onLocalChange?.();
      await showMyBooks();
    }
  }

  const manage = createLibraryManage(doc, {
    labels: manageLabels,
    themeLabel: (id) => libraryThemeLabel(labels(), id),
    themeRoot: root,
    themeStorage: deps.themeStorage,
    readerPrefsStorage: deps.readerPrefsStorage,
    library: deps.library,
    notify: deps.notify,
    formatError: (error) => errorText(error, labels().offline),
    onImport: importLocalBook,
    onOpenSyncPanel: deps.onOpenSyncPanel,
    onEnterEditor: deps.onEnterEditor,
  });
  const selectedSource = (): CatalogSource | undefined =>
    sources.find((source) => source.id === selectedSourceId);
  const catalogItemKind = (): LibraryItem['sourceKind'] =>
    selectedSource()?.kind === 'webdav' ? 'webdav' : 'opds';
  const catalogActive = (): boolean => activeSection === 'sources' && selectedSourceId !== null;

  function resetCatalogTree(): void {
    catalogRoot = null;
    selectedCatalogKey = '';
  }

  function ensureCatalogRoot(source: CatalogSource): CatalogTreeNode {
    if (catalogRoot !== null && catalogRoot.key === '') return catalogRoot;
    catalogRoot = {
      key: '',
      title: source.title,
      url: undefined,
      children: [],
      publications: [],
      loaded: false,
      expanded: true,
    };
    return catalogRoot;
  }

  function findCatalogNode(
    key: string,
    node: CatalogTreeNode | null = catalogRoot,
  ): CatalogTreeNode | null {
    if (node === null) return null;
    if (node.key === key) return node;
    for (const child of node.children) {
      const found = findCatalogNode(key, child);
      if (found !== null) return found;
    }
    return null;
  }

  function catalogPathToSelection(): CatalogTreeNode[] {
    const path: CatalogTreeNode[] = [];
    const walk = (node: CatalogTreeNode, acc: CatalogTreeNode[]): boolean => {
      acc.push(node);
      if (node.key === selectedCatalogKey) {
        path.push(...acc);
        return true;
      }
      for (const child of node.children) {
        if (walk(child, acc)) return true;
      }
      acc.pop();
      return false;
    };
    if (catalogRoot !== null) walk(catalogRoot, []);
    return path;
  }

  function syncCatalogTrail(): void {
    const path = catalogPathToSelection();
    trail.splice(
      0,
      trail.length,
      ...path.slice(1).map((node) => ({ title: node.title, url: node.url })),
    );
  }

  function mergeCatalogChildren(
    node: CatalogTreeNode,
    navigations: readonly DisplayItem[],
  ): CatalogTreeNode[] {
    const previous = new Map(node.children.map((child) => [child.key, child]));
    return navigations.map((display) => {
      const url = display.entry?.navigationUrl;
      const key = catalogNodeKey(url);
      const existing = previous.get(key);
      if (existing !== undefined) {
        existing.title = itemTitle(display.item);
        return existing;
      }
      return {
        key,
        title: itemTitle(display.item),
        url,
        children: [],
        publications: [],
        loaded: false,
        expanded: false,
      };
    });
  }

  function applyCatalogFeed(
    sourceId: string,
    loaded: OpdsFeed,
    url?: string,
    options?: { readonly append?: boolean },
  ): void {
    feed = loaded;
    const append = options?.append === true;
    const itemKind = catalogItemKind();
    const publications = publicationsFromFeed(sourceId, loaded, itemKind);
    const source = selectedSource();
    if (source !== undefined) ensureCatalogRoot(source);
    // Append uses the folder being viewed (`currentUrl`), not the next-page URL,
    // so later pages stay on the same tree node. Search feeds have their own
    // sourceUrl and miss the tree, which keeps browse publications intact.
    const node = findCatalogNode(catalogNodeKey(append ? currentUrl : url));
    if (node !== null) {
      node.publications = append
        ? mergeDisplayItems(node.publications, publications)
        : publications;
      node.loaded = true;
      node.expanded = true;
      node.children = mergeCatalogChildren(
        node,
        navigationFromFeed(sourceId, loaded, itemKind),
      );
      if (!append) {
        selectedCatalogKey = node.key;
        syncCatalogTrail();
      }
    }
    items = append ? mergeDisplayItems(items, publications) : publications;
    if (!append) {
      currentUrl = url ?? currentUrl;
      selected = null;
    }
  }

  function mergeDisplayItems(
    existing: readonly DisplayItem[],
    incoming: readonly DisplayItem[],
  ): DisplayItem[] {
    const seen = new Set(existing.map((display) => display.item.id));
    const merged = [...existing];
    for (const display of incoming) {
      if (seen.has(display.item.id)) continue;
      seen.add(display.item.id);
      merged.push(display);
    }
    return merged;
  }

  function catalogHasPaintedContent(): boolean {
    return catalogRoot?.loaded === true || (catalogActive() && items.length > 0);
  }

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
    // 与书库快捷过滤重复的内置组不在智能分组中重复出现；同规则（如静态 EPUB 与动态
    // format:epub）只保留先出现的一个。
    const seenRules = new Set<string>();
    smartGroups = smartGroups.filter((group) => {
      if (SHELF_FILTER_SMART_IDS.has(group.id)) return false;
      const ruleKey = `${group.rule.type}:${group.rule.value}`;
      if (seenRules.has(ruleKey)) return false;
      seenRules.add(ruleKey);
      return true;
    });
    // 没有匹配书籍的空组不显示；书目尚未加载时保持现状，避免选中态被误清。
    if (items.length > 0) {
      smartGroups = smartGroups.filter((group) =>
        items.some((display) => smartGroupMatches(display.item, group.rule, progressFor(display))),
      );
    }
    smartGroups.sort(
      (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
    );
    if (
      items.length > 0 &&
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
    let latestClock = Number.NEGATIVE_INFINITY;
    for (const display of items) {
      const progress = progressFor(display);
      if (progress?.status !== 'in-progress') continue;
      const clock = progressClock(progress);
      if (latest === null || clock > latestClock) {
        latest = display;
        latestClock = clock;
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
    if (catalogHasPaintedContent()) return;
    setStatus(labels().loading);
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
    brand.textContent = labels().brand;
    const inCatalog = catalogActive();
    root.dataset.libraryNav =
      activeSection === 'sources' ? (inCatalog ? 'catalog' : 'sources') : activeSection;
    // 书源列表与目录下钻都属于「书源」Tab。
    const currentTab: LibraryTabId =
      activeSection === 'shelf' ? 'shelf' : activeSection === 'manage' ? 'manage' : 'sources';
    root.dataset.libraryTab = currentTab;
    tabbar?.setActive(currentTab);
    searchForm.hidden = activeSection !== 'shelf' && !inCatalog;
    // 顶栏 + 只负责书架导入；书源有自己的分区 +，管理页走「导入本地书籍」。
    headerImport.hidden = currentTab !== 'shelf';
    parkWorkspaceTravel();
    manageNavButton.classList.toggle('is-active', activeSection === 'manage');
    groupPane.hidden = inCatalog;
    sourcePane.hidden = inCatalog;
    catalogPane.hidden = !inCatalog;
    navPane.hidden = isMobileLibraryChrome() && inCatalog;
    if (activeSection === 'shelf') {
      heading.textContent = isMobileLibraryChrome() ? labels().tabShelf : labels().library;
      heading.hidden = !isMobileLibraryChrome();
      toolbar.replaceChildren();
      itemList.classList.add('lightink-library-cover-wall');
      chipRow.hidden = !isMobileLibraryChrome();
      if (isMobileLibraryChrome()) {
        content.replaceChildren(chipRow, continueHost, status, itemList);
      } else {
        content.replaceChildren(continueHost, status, itemList);
      }
      detail.hidden = true;
      selected = null;
    } else if (activeSection === 'manage') {
      heading.hidden = false;
      heading.textContent = labels().manage;
      toolbar.replaceChildren();
      chipRow.hidden = true;
      itemList.classList.remove('lightink-library-cover-wall');
      content.replaceChildren(status, manage.element);
    } else if (inCatalog) {
      heading.hidden = false;
      heading.textContent = catalogTitle();
      toolbar.replaceChildren();
      chipRow.hidden = true;
      itemList.classList.add('lightink-library-cover-wall');
      workArea.replaceChildren(itemList, detail);
      content.replaceChildren(navigation, status, workArea);
    } else {
      heading.hidden = false;
      heading.textContent = labels().sources;
      toolbar.replaceChildren();
      chipRow.hidden = true;
      itemList.classList.remove('lightink-library-cover-wall');
      content.replaceChildren(status);
    }
    renderGroups();
    renderSources();
    if (inCatalog) renderCatalogTree();
    placeCatalogBack();
    syncSearchPlaceholder();
  }

  function showGroupOverlay(): void {
    ignoreGroupBackdrop = true;
    addGroupButton.classList.add('is-open');
    mountLibraryOverlay(groupOverlay, root);
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

  /** 分组筛选：保留名称命中的节点及其祖先链；查询为空时原样返回。 */
  function filterGroupNodes(
    nodes: readonly LibraryGroupNode[],
    query: string,
  ): LibraryGroupNode[] {
    if (query === '') return [...nodes];
    const lowered = query.toLowerCase();
    const walk = (list: readonly LibraryGroupNode[]): LibraryGroupNode[] => {
      const result: LibraryGroupNode[] = [];
      for (const node of list) {
        const children = walk(node.children);
        if (node.group.name.toLowerCase().includes(lowered) || children.length > 0) {
          result.push({ ...node, children });
        }
      }
      return result;
    };
    return walk(nodes);
  }

  /**
   * 分组管理动作（与「...」内联菜单同一动作集）构建为上下文菜单模型：
   * 长按分组行走既有 createContextMenu 渲染入口，纯触控可达全部管理动作。
   */
  function buildGroupMenuItems(node: LibraryGroupNode): MenuItem[] {
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
    return [
      {
        id: 'add-child',
        label: labels().addChildGroup,
        action: () => openGroupEditor({ kind: 'create', parentId: node.group.id }),
      },
      {
        id: 'rename',
        label: labels().renameGroup,
        action: () => openGroupEditor({ kind: 'rename', groupId: node.group.id }),
      },
      {
        id: 'move-up',
        label: labels().moveUp,
        action: () => void keyboardMoveGroup(node.group.id, 'up'),
        enabled: () => up !== null,
      },
      {
        id: 'move-down',
        label: labels().moveDown,
        action: () => void keyboardMoveGroup(node.group.id, 'down'),
        enabled: () => down !== null,
      },
      {
        id: 'outdent',
        label: labels().outdent,
        action: () => void keyboardMoveGroup(node.group.id, 'outdent'),
        enabled: () => outdent !== null,
      },
      {
        id: 'indent',
        label: labels().indent,
        action: () => void keyboardMoveGroup(node.group.id, 'indent'),
        enabled: () => indent !== null,
      },
      {
        id: 'offline',
        label: groupPinned ? labels().removeGroupOffline : labels().keepGroupOffline,
        action: () => void setGroupOffline(node.group.id, !groupPinned),
        enabled: () => managedMembers.length > 0 && deps.library.setOfflinePinned !== undefined,
      },
      { separator: true, id: 'sep-delete', label: '', action: () => undefined },
      {
        id: 'delete',
        label: labels().deleteGroup,
        action: () => void deleteCustomGroup(node.group),
      },
    ];
  }

  function appendCustomGroupNode(node: LibraryGroupNode): void {
    const wrapper = doc.createElement('div');
    wrapper.className = 'lightink-library-custom-group';
    wrapper.dataset.groupId = node.group.id;
    wrapper.dataset.groupDepth = String(node.depth + 1);
    wrapper.style.setProperty('--lightink-group-depth', String(node.depth));
    wrapper.draggable = true;
    // 长按分组行 → 既有 createContextMenu 渲染入口（管理动作纯触控可达）；
    // 先于子按钮 click 绑定，触发后吞掉紧随的合成 click（避免误选中分组）。
    bindLongPress(wrapper, {
      onLongPress: (position) => {
        createContextMenu(buildGroupMenuItems(node), position, doc);
      },
    });
    const row = doc.createElement('div');
    row.className = 'lightink-library-custom-group-row';
    const toggle = button(doc, '', 'lightink-library-group-toggle');
    toggle.appendChild(
      createNavIcon(doc, NAV_ICON_PATHS.chevron, 'lightink-library-collapse-chevron'),
    );
    toggle.disabled = node.children.length === 0;
    const expanded = expandedGroupIds.has(node.group.id) || groupFilterQuery.trim() !== '';
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
    choose.prepend(createNavIcon(doc, NAV_ICON_PATHS.folder));
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
      // 与长按上下文菜单同一动作集：buildGroupMenuItems 为唯一事实点，
      // 内联菜单仅将其映射为按钮（分隔线在内联形态下省略）。
      menu.append(
        ...buildGroupMenuItems(node)
          .filter((item) => item.separator !== true)
          .map((item) => groupAction(item.label, item.action, item.enabled?.() === false)),
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

  function syncSectionFilterLabels(refs: SectionFilterRefs, label: string): void {
    refs.toggle.title = label;
    refs.toggle.setAttribute('aria-label', label);
    refs.toggle.setAttribute('aria-expanded', String(!refs.wrap.hidden));
    refs.input.placeholder = label;
    refs.input.setAttribute('aria-label', label);
    refs.clear.title = labels().clear;
    refs.clear.setAttribute('aria-label', labels().clear);
    refs.clear.hidden = refs.input.value.trim() === '';
  }

  function selectShelfGroup(group: ShelfGroup): void {
    selectedGroup = group;
    selectedCustomGroupId = null;
    selectedSmartGroupId = null;
    void activateShelf();
  }

  function shelfGroupIsActive(group: ShelfGroup): boolean {
    return (
      activeSection === 'shelf' &&
      selectedCustomGroupId === null &&
      selectedSmartGroupId === null &&
      selectedGroup === group
    );
  }

  function renderGroups(): void {
    filterList.replaceChildren();
    chipRow.replaceChildren();
    groupList.replaceChildren();
    shelfHeading.textContent = labels().library;
    groupTitle.textContent = labels().groups;
    groupPane.setAttribute('aria-label', labels().groups);
    chipRow.setAttribute('aria-label', labels().library);
    addGroupButton.title = labels().newGroup;
    addGroupButton.setAttribute('aria-label', labels().newGroup);
    setNavSectionCollapsed(groupToggle, groupBody, groupListCollapsed, labels().groups);
    setNavSectionCollapsed(
      smartGroupToggle,
      smartGroupBody,
      smartGroupListCollapsed,
      labels().smartGroups,
    );
    syncSectionFilterLabels(groupFilter, labels().filterGroups);
    for (const group of SHELF_GROUPS) {
      const caption = groupLabel(labels(), group);
      const active = shelfGroupIsActive(group);
      const row = button(doc, caption, 'lightink-library-group');
      row.prepend(createNavIcon(doc, SHELF_NAV_ICONS[group]));
      row.title = caption;
      row.dataset.shelfGroup = group;
      row.classList.toggle('is-active', active);
      if (active) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        selectShelfGroup(group);
      });
      filterList.appendChild(row);
      const chip = button(doc, caption, 'lightink-library-shelf-chip');
      chip.dataset.shelfGroup = group;
      chip.classList.toggle('is-active', active);
      if (active) chip.setAttribute('aria-current', 'true');
      chip.addEventListener('click', () => {
        selectShelfGroup(group);
      });
      chipRow.appendChild(chip);
    }
    for (const node of filterGroupNodes(customGroupTree(groups), groupFilterQuery.trim())) {
      appendCustomGroupNode(node);
    }
    if (groupList.childElementCount === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-nav-empty';
      empty.textContent =
        groupFilterQuery.trim() === '' ? labels().emptyGroups : labels().noMatch;
      groupList.appendChild(empty);
    }
    renderSmartGroups();
    renderGroupEditor();
  }

  function renderSmartGroups(): void {
    smartGroupList.replaceChildren();
    smartGroupTitle.textContent = labels().smartGroups;
    syncSectionFilterLabels(smartGroupFilter, labels().filterSmartGroups);
    // 一个智能分组都没有（全部为空组被隐藏）时整个分区不占位
    const sectionEmpty = smartGroups.length === 0;
    smartGroupHeader.hidden = sectionEmpty;
    smartGroupBody.hidden = sectionEmpty || smartGroupListCollapsed;
    const query = smartGroupFilterQuery.trim().toLowerCase();
    for (const group of smartGroups) {
      if (query !== '' && !smartGroupName(group).toLowerCase().includes(query)) continue;
      const item = button(doc, smartGroupName(group), 'lightink-library-smart-group');
      item.prepend(createNavIcon(doc, NAV_ICON_PATHS.hash));
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
    if (!sectionEmpty && smartGroupList.childElementCount === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-nav-empty';
      empty.textContent = labels().noMatch;
      smartGroupList.appendChild(empty);
    }
  }

  function renderSources(): void {
    sourceList.replaceChildren();
    setNavSectionCollapsed(sourceToggle, sourceBody, sourceListCollapsed, labels().sources);
    syncSectionFilterLabels(sourceFilter, labels().filterSources);
    const query = sourceFilterQuery.trim().toLowerCase();
    const matches = (text: string): boolean => query === '' || text.toLowerCase().includes(query);
    const visibleSources = sources.filter(
      (source) => matches(source.title) || matches(source.url),
    );
    if (visibleSources.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-source-empty';
      empty.textContent = query === '' ? labels().emptySources : labels().noMatch;
      sourceList.appendChild(empty);
      return;
    }
    for (const source of visibleSources) {
      const row = doc.createElement('div');
      row.className = 'lightink-library-source-row';
      row.dataset.sourceKind = source.kind;
      const stack = doc.createElement('div');
      stack.className = 'lightink-library-source-stack';
      const choose = button(doc, source.title, 'lightink-library-source');
      choose.prepend(createNavIcon(doc, NAV_ICON_PATHS.source));
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
      const editLabel = source.kind === 'webdav' ? labels().editWebDav : labels().editSource;
      const edit = button(doc, '', 'lightink-library-icon-button lightink-library-source-edit');
      edit.title = editLabel;
      edit.setAttribute('aria-label', `${editLabel}: ${source.title}`);
      edit.addEventListener('click', () => openSourceForm(source));
      const remove = button(doc, '', 'lightink-library-icon-button lightink-library-source-remove');
      remove.title = labels().deleteSource;
      remove.setAttribute('aria-label', `${labels().deleteSource}: ${source.title}`);
      remove.addEventListener('click', () => void removeSource(source));
      row.append(stack, edit, remove);
      sourceList.appendChild(row);
    }
  }

  function catalogBackLabel(): string {
    if (isMobileLibraryChrome()) {
      const path = catalogPathToSelection();
      if (path.length > 1) return path[path.length - 2]?.title ?? labels().backToSources;
      return labels().backToSources;
    }
    return labels().backToShelf;
  }

  function catalogTitle(): string {
    const path = catalogPathToSelection();
    const current = path[path.length - 1];
    if (current !== undefined && current.key !== '') return current.title;
    return selectedSource()?.title ?? labels().library;
  }

  function leaveCatalog(): void {
    if (isMobileLibraryChrome()) void showSourcesList();
    else void showMyBooks();
  }

  function goCatalogBack(): void {
    if (isMobileLibraryChrome()) {
      const path = catalogPathToSelection();
      if (path.length > 1) {
        void selectCatalogNode(path[path.length - 2]!);
        return;
      }
    }
    leaveCatalog();
  }

  function placeCatalogBack(): void {
    if (isMobileLibraryChrome() && catalogActive()) {
      if (catalogBack.parentElement !== headerMain) {
        headerMain.insertBefore(catalogBack, heading);
      }
      return;
    }
    if (catalogBack.parentElement !== catalogPane) {
      catalogPane.insertBefore(catalogBack, catalogHeading);
    }
  }

  function syncSearchPlaceholder(): void {
    const l = labels();
    if (catalogActive()) {
      const name = selectedSource()?.title ?? l.sources;
      const text = l.searchCatalogPlaceholder.replace('{name}', name);
      searchInput.placeholder = text;
      searchInput.setAttribute('aria-label', text);
      return;
    }
    searchInput.placeholder = l.searchPlaceholder;
    searchInput.setAttribute('aria-label', l.searchPlaceholder);
  }

  function catalogFolderDisplays(): DisplayItem[] {
    if (!catalogActive() || !isMobileLibraryChrome()) return [];
    if (searchInput.value.trim() !== '') return [];
    const node = findCatalogNode(selectedCatalogKey);
    if (node === null) return [];
    const source = selectedSource();
    return node.children.flatMap((child) => {
      if (child.url === undefined) return [];
      return [
        {
          item: {
            id: `catalog-folder:${child.key}`,
            sourceId: source?.id ?? '',
            sourceKind: catalogItemKind(),
            title: child.title,
            authors: [],
            updatedAt: 0,
          },
          entry: {
            id: child.key,
            title: child.title,
            authors: [],
            links: [],
            kind: 'navigation',
            navigationUrl: child.url,
          },
          links: [],
        },
      ];
    });
  }

  function renderFolderRow(display: DisplayItem): HTMLButtonElement {
    const row = button(doc, '', 'lightink-library-item lightink-library-catalog-folder');
    row.dataset.itemId = display.item.id;
    row.setAttribute('role', 'option');
    const title = doc.createElement('span');
    title.textContent = itemTitle(display.item);
    row.append(
      createNavIcon(doc, NAV_ICON_PATHS.folder),
      title,
      createNavIcon(doc, NAV_ICON_PATHS.chevron, 'lightink-library-collapse-chevron'),
    );
    row.addEventListener('click', () => void openSelected(display));
    return row;
  }

  function renderCatalogTree(): void {
    catalogTree.replaceChildren();
    const backLabel = catalogBackLabel();
    const label = doc.createElement('span');
    label.className = 'lightink-library-back-to-shelf-label';
    label.textContent = backLabel;
    catalogBack.replaceChildren(
      createNavIcon(
        doc,
        isMobileLibraryChrome() ? NAV_ICON_PATHS.chevronLeft : NAV_ICON_PATHS.library,
      ),
      label,
    );
    catalogBack.title = backLabel;
    catalogBack.setAttribute('aria-label', backLabel);
    placeCatalogBack();
    catalogHeading.textContent = selectedSource()?.title ?? labels().library;
    catalogPane.setAttribute('aria-label', catalogHeading.textContent);
    if (catalogActive()) heading.textContent = catalogTitle();
    if (catalogRoot === null) return;
    const appendNode = (node: CatalogTreeNode, depth: number): void => {
      const wrapper = doc.createElement('div');
      wrapper.className = 'lightink-library-catalog-node lightink-library-custom-group';
      wrapper.dataset.catalogKey = node.key;
      wrapper.style.setProperty('--lightink-group-depth', String(depth));
      const row = doc.createElement('div');
      row.className = 'lightink-library-custom-group-row';
      const toggle = button(doc, '', 'lightink-library-group-toggle');
      toggle.appendChild(
        createNavIcon(doc, NAV_ICON_PATHS.chevron, 'lightink-library-collapse-chevron'),
      );
      const expandable = !node.loaded || node.children.length > 0;
      toggle.disabled = !expandable;
      toggle.classList.toggle('is-expanded', node.expanded);
      toggle.setAttribute('aria-label', node.title);
      toggle.setAttribute('aria-expanded', String(node.expanded));
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        void toggleCatalogNode(node);
      });
      const choose = button(doc, node.title, 'lightink-library-group');
      choose.prepend(createNavIcon(doc, depth === 0 ? NAV_ICON_PATHS.source : NAV_ICON_PATHS.folder));
      if (node.url !== undefined) choose.dataset.navigationUrl = node.url;
      choose.dataset.catalogKey = node.key;
      const active = selectedCatalogKey === node.key;
      choose.classList.toggle('is-active', active);
      if (active) choose.setAttribute('aria-current', 'true');
      choose.addEventListener('click', () => void selectCatalogNode(node));
      row.append(toggle, choose);
      wrapper.appendChild(row);
      catalogTree.appendChild(wrapper);
      if (node.expanded) {
        for (const child of node.children) appendNode(child, depth + 1);
      }
    };
    appendNode(catalogRoot, 0);
  }

  async function selectCatalogNode(node: CatalogTreeNode): Promise<void> {
    if (!node.loaded) {
      await loadFeed(node.url);
      return;
    }
    selectedCatalogKey = node.key;
    currentUrl = node.url;
    items = node.publications;
    selected = null;
    lastAction = () => loadFeed(node.url);
    syncCatalogTrail();
    renderCatalogTree();
    renderBreadcrumbs();
    renderItems();
    renderDetail();
    syncPageChrome();
  }

  async function toggleCatalogNode(node: CatalogTreeNode): Promise<void> {
    if (!node.loaded) {
      await selectCatalogNode(node);
      return;
    }
    if (node.children.length === 0) return;
    node.expanded = !node.expanded;
    renderCatalogTree();
  }

  function renderBreadcrumbs(): void {
    breadcrumbs.replaceChildren();
    const source = selectedSource();
    const hidePath = isMobileLibraryChrome() || trail.length === 0;
    if (source !== undefined && !hidePath) {
      const rootCrumb = button(doc, source.title);
      rootCrumb.addEventListener('click', () => {
        if (catalogRoot !== null) void selectCatalogNode(catalogRoot);
        else void openCatalog(source.id);
      });
      breadcrumbs.appendChild(rootCrumb);
      for (const [index, crumb] of trail.entries()) {
        const separator = doc.createElement('span');
        separator.textContent = '/';
        const crumbButton = button(doc, crumb.title);
        crumbButton.addEventListener('click', () => {
          const node = findCatalogNode(catalogNodeKey(crumb.url));
          if (node !== null) {
            void selectCatalogNode(node);
            return;
          }
          trail.splice(index + 1);
          void loadFeed(crumb.url);
        });
        breadcrumbs.append(separator, crumbButton);
      }
    }
    breadcrumbs.hidden = hidePath || breadcrumbs.childElementCount === 0;
    previousButton.disabled = feed?.previousUrl == null || feed.previousUrl === '';
    nextButton.disabled = feed?.nextUrl == null || feed.nextUrl === '';
    pager.hidden = previousButton.disabled && nextButton.disabled;
    navigation.hidden = breadcrumbs.hidden && pager.hidden;
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

  function openItemCollectionMenu(display: DisplayItem, position: { x: number; y: number }): void {
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
    if (canRemoveFromLibrary(display)) {
      items.push({
        id: 'sep-remove',
        label: '',
        separator: true,
        action: () => undefined,
      });
      items.push({
        id: 'remove',
        label: labels().remove,
        action: () => {
          void removeItem(display.item);
        },
      });
    }
    createContextMenu(items, position, doc);
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
    mountLibraryOverlay(membershipOverlay, root);
    membershipOverlay.hidden = false;
    header.setAttribute('inert', '');
    body.setAttribute('inert', '');
    membershipOptions.querySelector<HTMLInputElement>('input')?.focus();
  }

  function renderCoverCard(
    display: DisplayItem,
    options: { readonly selectOnClick?: boolean } = {},
  ): HTMLButtonElement {
    const row = button(doc, '', 'lightink-library-item lightink-library-item--cover');
    row.dataset.itemId = display.item.id;
    row.dataset.bookKind = classifyLibraryKind(display.item);
    row.setAttribute('role', 'option');
    const selectedHere = options.selectOnClick === true && selected?.item.id === display.item.id;
    row.setAttribute('aria-selected', selectedHere ? 'true' : 'false');
    row.classList.toggle('is-selected', selectedHere);
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
    // 长按先于 click/contextmenu 绑定：触发后吞掉紧随的合成 click/原生
    // contextmenu（at-target 阶段按注册顺序派发），避免误打开书或菜单双开。
    bindLongPress(row, {
      onLongPress: (position) => openItemCollectionMenu(display, position),
    });
    if (options.selectOnClick === true) {
      row.addEventListener('click', () => void selectItem(display));
      row.addEventListener('dblclick', () => void openSelected(display));
    } else {
      row.addEventListener('click', () => void openSelected(display));
    }
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openItemCollectionMenu(display, { x: event.clientX, y: event.clientY });
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

  function shouldShowImportTile(): boolean {
    return activeSection === 'shelf' && !catalogActive() && searchInput.value.trim() === '';
  }

  function renderImportTile(): HTMLButtonElement {
    const tile = button(doc, '', 'lightink-library-item lightink-library-item--import');
    tile.dataset.libraryAction = 'import';
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-label', labels().importLocal);
    tile.title = labels().importLocal;
    const cover = doc.createElement('div');
    cover.className = 'lightink-library-cover lightink-library-cover--import';
    cover.appendChild(createNavIcon(doc, NAV_ICON_PATHS.plus, 'lightink-library-import-plus'));
    tile.append(cover);
    tile.addEventListener('click', () => {
      void importLocalBook();
    });
    return tile;
  }

  function renderItems(): void {
    const shown = visibleItems();
    itemList.replaceChildren();
    if (!status.hidden && shown.length === 0) {
      return;
    }
    const folders = catalogFolderDisplays();
    if (shown.length === 0) {
      const query = searchInput.value.trim();
      const filtered =
        query !== '' ||
        selectedGroup !== 'all' ||
        selectedCustomGroupId !== null ||
        selectedSmartGroupId !== null;
      if (!filtered && shouldShowImportTile()) {
        itemList.appendChild(renderImportTile());
        detail.hidden = true;
        return;
      }
      if (folders.length > 0) {
        for (const folder of folders) itemList.appendChild(renderFolderRow(folder));
        detail.hidden = true;
        mountCatalogMoreSentinel();
        return;
      }
      const empty = doc.createElement('div');
      empty.className = 'lightink-library-empty';
      if (query !== '') empty.textContent = labels().emptySearch;
      else if (catalogActive()) empty.textContent = labels().emptyCatalog;
      else if (filtered) empty.textContent = labels().emptyFilter;
      else empty.textContent = labels().empty;
      if (filtered) empty.classList.add('lightink-library-empty--filtered');
      itemList.appendChild(empty);
      detail.hidden = true;
      return;
    }
    for (const folder of folders) itemList.appendChild(renderFolderRow(folder));
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
        catalogActive()
          ? renderCoverCard(display, { selectOnClick: true })
          : renderCoverCard(display),
      );
    }
    if (shouldShowImportTile()) {
      itemList.appendChild(renderImportTile());
    }
    if (selected === null) detail.hidden = true;
    mountCatalogMoreSentinel();
  }

  function catalogHasMore(): boolean {
    return catalogActive() && feed?.nextUrl != null && feed.nextUrl !== '';
  }

  function mountCatalogMoreSentinel(): void {
    catalogMoreRelease?.();
    catalogMoreRelease = null;
    if (!catalogHasMore()) return;
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'lightink-library-catalog-more';
    more.textContent = catalogLoadingMore ? labels().searching : labels().loadMore;
    more.disabled = catalogLoadingMore;
    more.addEventListener('click', () => {
      void loadMoreCatalog();
    });
    itemList.appendChild(more);
    catalogMoreRelease = observeLoadMore(itemList, more, () => {
      void loadMoreCatalog();
    });
  }

  function catalogListNeedsMore(): boolean {
    return itemList.scrollHeight <= itemList.clientHeight + 48;
  }

  function continueCatalogStream(): void {
    if (catalogAwaitingSearch || !catalogHasMore()) return;
    if (catalogLoadingMore && catalogLoadEpoch === catalogFeedEpoch) return;
    if (catalogStreamPages >= CATALOG_STREAM_PAGE_CAP && !catalogListNeedsMore()) return;
    void loadMoreCatalog({ quiet: true });
  }

  async function loadMoreCatalog(options?: { readonly quiet?: boolean }): Promise<void> {
    const nextUrl = feed?.nextUrl;
    const source = selectedSource();
    const epoch = catalogFeedEpoch;
    const generation = requestGeneration;
    if (catalogAwaitingSearch || source === undefined || nextUrl == null || nextUrl === '') {
      return;
    }
    if (catalogLoadingMore && catalogLoadEpoch === epoch) {
      return;
    }
    const quiet = options?.quiet === true;
    const seq = ++catalogLoadSeq;
    catalogLoadingMore = true;
    catalogLoadEpoch = epoch;
    if (quiet) catalogStreamPages += 1;
    const more = itemList.querySelector<HTMLButtonElement>('.lightink-library-catalog-more');
    if (!quiet && more !== null) {
      more.disabled = true;
      more.textContent = labels().searching;
    }
    try {
      const loaded =
        source.kind === 'webdav'
          ? await deps.webdavSource!.browse(source.id, nextUrl)
          : await deps.opds.browse(source.id, nextUrl);
      if (
        epoch !== catalogFeedEpoch ||
        generation !== requestGeneration ||
        catalogAwaitingSearch ||
        selectedSource()?.id !== source.id
      ) {
        return;
      }
      applyCatalogFeed(source.id, loaded, nextUrl, { append: true });
      renderBreadcrumbs();
      renderItems();
      if (quiet && catalogHasMore() && catalogListNeedsMore() && catalogStreamPages < CATALOG_STREAM_PAGE_CAP) {
        catalogLoadingMore = false;
        await loadMoreCatalog({ quiet: true });
        return;
      }
    } catch {
      if (!quiet && more !== null && epoch === catalogFeedEpoch) {
        more.disabled = false;
        more.textContent = labels().loadMore;
      }
    } finally {
      if (seq === catalogLoadSeq) {
        catalogLoadingMore = false;
      }
    }
  }

  function rememberDisplay(display: DisplayItem): DisplayItem {
    const index = items.findIndex((candidate) => candidate.item.id === display.item.id);
    if (index >= 0) {
      items[index] = display;
    }
    const shelfIndex = shelfItems.findIndex((candidate) => candidate.item.id === display.item.id);
    if (shelfIndex >= 0) {
      shelfItems[shelfIndex] = display;
    }
    if (selected?.item.id === display.item.id) {
      selected = display;
    }
    return display;
  }

  async function ensureLinks(display: DisplayItem): Promise<DisplayItem> {
    if (isLocalItem(display.item)) return display;
    const fallback = acquisitionFromItem(display.item);
    try {
      const stored = await deps.library.listAcquisitionLinks(display.item.id);
      const links = stored.length > 0 ? stored : display.links.length > 0 ? display.links : fallback === undefined ? [] : [fallback];
      return rememberDisplay({ ...display, links });
    } catch {
      if (display.links.length > 0) return display;
      return rememberDisplay({
        ...display,
        links: fallback === undefined ? [] : [fallback],
      });
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
    return (
      display?.links.find((link) => link.href === href) ??
      display?.links[0] ??
      (display === null ? undefined : acquisitionFromItem(display.item))
    );
  }

  function requestFor(display: DisplayItem): LibraryOpenRequest {
    const catalog =
      selectedSource() ?? sources.find((source) => source.id === display.item.sourceId);
    return {
      item: display.item,
      acquisition: selectedAcquisition(display),
      source: catalog === undefined ? undefined : withoutCatalogKind(catalog),
    };
  }

  async function openSelected(display = selected): Promise<void> {
    if (display === null) return;
    if (
      display.entry?.kind === 'navigation' &&
      display.entry.navigationUrl != null &&
      display.entry.navigationUrl !== ''
    ) {
      const node = findCatalogNode(catalogNodeKey(display.entry.navigationUrl));
      if (node !== null) {
        await selectCatalogNode(node);
        return;
      }
      trail.push({ title: display.item.title, url: display.entry.navigationUrl });
      await loadFeed(display.entry.navigationUrl);
      return;
    }
    const resolved = await ensureLinks(display);
    const request = requestFor(resolved);
    if (!isLocalItem(resolved.item) && request.acquisition === undefined) {
      deps.notify(labels().noAcquisition, 'warning');
      return;
    }
    const controller = new AbortController();
    activeOperations.add(controller);
    const remote = !isLocalItem(resolved.item);
    const knownSize = request.acquisition?.size ?? resolved.item.size;
    const progress = beginOpenProgress({
      title: itemTitle(resolved.item),
      label: remote ? labels().downloading : labels().opening,
      cancelLabel: labels().cancel,
      ratio: remote && knownSize !== undefined && knownSize > 0 ? 0 : undefined,
      onCancel: () => controller.abort(),
    });
    const requestWithProgress: LibraryOpenRequest = {
      ...request,
      onProgress: (event) => {
        if (event.phase === 'download') {
          const total = event.total ?? knownSize;
          const loaded = event.loaded;
          progress.update({
            label: labels().downloading,
            ratio:
              total !== undefined && loaded !== undefined && total > 0
                ? Math.min(1, loaded / total)
                : undefined,
          });
          return;
        }
        progress.update({ label: labels().opening, ratio: undefined });
      },
    };
    try {
      await deps.onOpen(requestWithProgress, controller.signal);
      if (controller.signal.aborted) return;
      activeOperations.delete(controller);
      hide({ notifyVisibility: false });
    } catch (error) {
      if (!controller.signal.aborted) deps.notify(errorText(error, labels().offline), 'error');
    } finally {
      progress.close();
      activeOperations.delete(controller);
    }
  }

  function closeDetail(): void {
    selected = null;
    renderDetail();
  }

  function renderDetail(): void {
    detail.replaceChildren();
    if (selected === null) {
      detail.hidden = true;
      detailBackdrop.hidden = true;
      return;
    }
    detail.hidden = false;
    detailBackdrop.hidden = false;
    if (isMobileLibraryChrome()) {
      const handle = button(doc, '', 'lightink-library-detail-handle');
      handle.setAttribute('aria-label', labels().closeDetails);
      handle.addEventListener('click', () => closeDetail());
      detail.appendChild(handle);
    }
    const headerRow = doc.createElement('div');
    headerRow.className = 'lightink-library-detail-header';
    const detailHeading = doc.createElement('h2');
    detailHeading.textContent = labels().details;
    const close = button(doc, '×', 'lightink-library-icon-button lightink-library-detail-close');
    close.setAttribute('aria-label', labels().closeDetails);
    close.addEventListener('click', () => closeDetail());
    headerRow.append(detailHeading, close);
    const title = doc.createElement('h3');
    title.textContent = itemTitle(selected.item);
    const authors = doc.createElement('p');
    authors.className = 'lightink-library-detail-authors';
    authors.textContent = itemAuthors(selected.item).join(', ');
    detail.append(headerRow, title, authors);
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
          await manage.refreshCache();
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
    if (canRemoveFromLibrary(selected)) {
      const remove = button(doc, labels().remove, 'lightink-library-danger');
      remove.addEventListener('click', () => void removeItem(selected!.item));
      actions.appendChild(remove);
    }
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
      rememberImportedItems(loaded);
      items = loaded.map(displayFromPersistedItem);
      shelfItems = items;
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
    } catch {
      if (generation !== requestGeneration) return;
      items = [];
      setStatus('');
      renderContinueBar();
      renderItems();
    }
  }

  async function loadFeed(url?: string): Promise<void> {
    const source = selectedSource();
    if (source === undefined) return;
    const generation = ++requestGeneration;
    catalogFeedEpoch += 1;
    catalogStreamPages = 0;
    catalogAwaitingSearch = false;
    const painted = catalogHasPaintedContent();
    if (!painted) {
      setStatus(labels().loading);
      itemList.replaceChildren();
    }
    currentUrl = url;
    lastAction = () => loadFeed(currentUrl);
    try {
      if (source.kind === 'webdav' && deps.webdavSource === undefined) {
        throw new Error(labels().offline);
      }
      const loaded =
        source.kind === 'webdav'
          ? await deps.webdavSource!.browse(source.id, url)
          : await deps.opds.browse(source.id, url);
      if (generation !== requestGeneration) return;
      applyCatalogFeed(source.id, loaded, url);
      refreshSmartGroups();
      setStatus('');
      renderCatalogTree();
      renderBreadcrumbs();
      renderItems();
      renderDetail();
    } catch (error) {
      if (generation !== requestGeneration) return;
      if (!painted) items = [];
      setStatus(errorText(error, labels().offline), true);
      renderCatalogTree();
      renderBreadcrumbs();
      renderItems();
      if (!painted) renderDetail();
    }
  }

  async function showMyBooks(): Promise<void> {
    requestGeneration += 1;
    activeSection = 'shelf';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    resetCatalogTree();
    items = shelfItems;
    syncPageChrome();
    renderGroups();
    renderContinueBar();
    renderItems();
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
    requestGeneration += 1;
    activeSection = 'manage';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    resetCatalogTree();
    searchInput.value = '';
    syncSearchClear();
    closeSourceForm();
    setStatus('');
    manage.showHome();
    syncPageChrome();
    await refreshSources().catch(() => undefined);
    renderSources();
    await manage.refreshCache();
  }

  function closeCatalog(): void {
    requestGeneration += 1;
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    resetCatalogTree();
    items = [];
    syncPageChrome();
    renderSources();
    renderBreadcrumbs();
  }

  async function openCatalog(sourceId: string): Promise<void> {
    const sameSource = catalogActive() && selectedSourceId === sourceId && catalogRoot !== null;
    activeSection = 'sources';
    selectedSourceId = sourceId;
    searchInput.value = '';
    syncSearchClear();
    clearCatalogSearchTimer();
    if (!sameSource) {
      trail.splice(0);
      items = [];
      selected = null;
      resetCatalogTree();
      const source = selectedSource();
      if (source !== undefined) ensureCatalogRoot(source);
      itemList.replaceChildren();
      detail.hidden = true;
    }
    syncPageChrome();
    renderCatalogTree();
    renderBreadcrumbs();
    try {
      rememberImportedItems(await deps.library.listItems());
    } catch {
      /* keep the last known imported set */
    }
    await loadFeed(undefined);
  }

  /** 书源 Tab：停留在书源列表，不进入任何 catalog。再点一次也回到列表。 */
  async function showSourcesList(): Promise<void> {
    requestGeneration += 1;
    activeSection = 'sources';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    resetCatalogTree();
    items = [];
    searchInput.value = '';
    syncSearchClear();
    clearCatalogSearchTimer();
    setStatus('');
    syncPageChrome();
    await refreshSources().catch(() => undefined);
    renderSources();
  }

  /** 移动底部 Tab 切换：书架/书源/管理直达。书源 Tab 始终落书源列表。 */
  async function activateMobileTab(tab: LibraryTabId): Promise<void> {
    if (tab === 'shelf') {
      await activateShelf();
      return;
    }
    if (tab === 'manage') {
      await showManage();
      return;
    }
    await showSourcesList();
  }

  async function search(): Promise<void> {
    const query = searchInput.value.trim();
    if (query === '') {
      if (catalogActive() && selectedSourceId !== null) {
        if (selectedSource()?.kind === 'webdav') {
          const node = findCatalogNode(selectedCatalogKey);
          items = node?.publications ?? items;
          selected = null;
          setStatus('');
          renderItems();
          renderDetail();
          return;
        }
        await openCatalog(selectedSourceId);
        return;
      }
      await showMyBooks();
      return;
    }
    if (!catalogActive() || selectedSourceId === null) {
      const lowered = query.toLocaleLowerCase();
      const loaded = await deps.library.listItems();
      rememberImportedItems(loaded);
      items = loaded
        .filter((item) =>
          `${itemTitle(item)}\n${itemAuthors(item).join('\n')}`.toLocaleLowerCase().includes(lowered),
        )
        .map(displayFromPersistedItem);
      refreshSmartGroups();
      selected = null;
      renderContinueBar();
      renderItems();
      return;
    }
    if (selectedSource()?.kind === 'webdav') {
      const lowered = query.toLocaleLowerCase();
      const pool = findCatalogNode(selectedCatalogKey)?.publications ?? items;
      items = pool.filter((display) => itemTitle(display.item).toLocaleLowerCase().includes(lowered));
      selected = null;
      setStatus('');
      renderItems();
      renderDetail();
      return;
    }
    const generation = ++requestGeneration;
    catalogFeedEpoch += 1;
    catalogAwaitingSearch = true;
    catalogSearchAbort?.abort();
    catalogSearchAbort = new AbortController();
    const signal = catalogSearchAbort.signal;
    catalogStreamPages = 0;
    const painted = catalogHasPaintedContent();
    catalogBusy.start();
    lastAction = search;
    try {
      const loaded = await deps.opds.search(selectedSourceId, query, { signal });
      catalogBusy.clear();
      if (generation !== requestGeneration || signal.aborted) {
        catalogAwaitingSearch = false;
        return;
      }
      feed = loaded;
      items = publicationsFromFeed(selectedSourceId, loaded, catalogItemKind());
      currentUrl = loaded.sourceUrl;
      refreshSmartGroups();
      selected = null;
      trail.splice(0, trail.length, { title: `${labels().search}: ${query}`, url: loaded.sourceUrl });
      setStatus('');
      renderCatalogTree();
      renderBreadcrumbs();
      renderItems();
      renderDetail();
      catalogAwaitingSearch = false;
      continueCatalogStream();
    } catch (error) {
      catalogBusy.clear();
      catalogAwaitingSearch = false;
      if (generation !== requestGeneration || signal.aborted || isAbortError(error)) return;
      if (!painted) items = [];
      setStatus(errorText(error, labels().offline), true);
      renderItems();
    }
  }

  async function refreshSources(): Promise<void> {
    const opdsList = await deps.opds.listSources();
    let webdavList: OpdsSource[] = [];
    if (deps.webdavSource !== undefined) {
      try {
        webdavList = await deps.webdavSource.listSources();
      } catch {
        webdavList = [];
      }
    }
    sources = [...asCatalogSources('opds', opdsList), ...asCatalogSources('webdav', webdavList)];
  }

  function sourceInputFromForm(editing?: CatalogSource): {
    input: OpdsSourceInput;
    kind: CatalogSourceKind;
    url: string;
    allowHttp: boolean;
  } {
    const data = new FormData(sourceForm);
    const kind: CatalogSourceKind = data.get('kind') === 'webdav' ? 'webdav' : 'opds';
    const auth = String(data.get('auth') ?? 'none');
    const url = String(data.get('url') ?? '');
    const allowHttp = data.get('allowHttp') === 'on';
    return {
      kind,
      url,
      allowHttp,
      input: {
        id: editing?.id,
        title: String(data.get('title') ?? ''),
        url,
        allowHttp,
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
      },
    };
  }

  function setFormStatus(message: string, kind: 'error' | 'success' | '' = ''): void {
    const statusEl = sourceForm.querySelector<HTMLElement>('.lightink-library-source-form-status');
    if (statusEl === null) return;
    statusEl.textContent = message;
    statusEl.hidden = message === '';
    if (kind === '') delete statusEl.dataset.status;
    else statusEl.dataset.status = kind;
  }

  function renderSourceForm(source?: CatalogSource, kind: CatalogSourceKind = 'opds'): void {
    sourceForm.replaceChildren();
    editingSourceKind = source?.kind ?? kind;
    const isWebDav = editingSourceKind === 'webdav';
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
    actions.append(save);
    if (isWebDav && deps.webdavSource !== undefined) {
      const test = button(doc, labels().testConnection);
      test.addEventListener('click', () => void testWebDavSource());
      actions.append(test);
    }
    actions.append(cancel);
    const fields: HTMLElement[] = [];
    if (source === undefined && deps.webdavSource !== undefined) {
      const kindSelect = doc.createElement('select');
      kindSelect.name = 'kind';
      kindSelect.setAttribute('aria-label', labels().sourceKind);
      for (const value of ['opds', 'webdav'] as const) {
        const option = doc.createElement('option');
        option.value = value;
        option.textContent = value === 'opds' ? labels().opdsSource : labels().webdavSource;
        kindSelect.appendChild(option);
      }
      kindSelect.value = editingSourceKind;
      kindSelect.addEventListener('change', () => {
        editingSourceKind = kindSelect.value === 'webdav' ? 'webdav' : 'opds';
        renderSourceForm(undefined, editingSourceKind);
        sourceForm.querySelector<HTMLInputElement>('input')?.focus();
      });
      fields.push(labeled(kindSelect, labels().sourceKind));
    } else {
      const hiddenKind = doc.createElement('input');
      hiddenKind.type = 'hidden';
      hiddenKind.name = 'kind';
      hiddenKind.value = editingSourceKind;
      fields.push(hiddenKind);
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
    const formStatus = doc.createElement('p');
    formStatus.className = 'lightink-library-source-form-status';
    formStatus.setAttribute('role', 'status');
    formStatus.hidden = true;
    const editLabel = isWebDav ? labels().editWebDav : labels().editSource;
    sourceForm.setAttribute('aria-label', source === undefined ? labels().addSource : editLabel);
    sourceForm.append(
      ...fields,
      labeled(title, labels().title),
      labeled(url, isWebDav ? labels().webdavUrl : labels().url),
      labeled(auth, labels().auth),
      username,
      password,
      token,
      allowLabel,
      formStatus,
      actions,
    );
    title.value = source?.title ?? '';
    url.value = source?.url ?? '';
    allow.checked = source?.allowHttp ?? false;
    auth.value =
      source?.credentialRef !== undefined ? 'keep' : isWebDav && source === undefined ? 'basic' : 'none';
    auth.dispatchEvent(new Event('change'));
  }

  function showSourceOverlay(): void {
    ignoreSourceBackdrop = true;
    addSourceButton.classList.add('is-open');
    mountLibraryOverlay(sourceOverlay, root);
    sourceOverlay.hidden = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ignoreSourceBackdrop = false;
      });
    });
  }

  function closeSourceForm(): void {
    editingSourceId = null;
    editingSourceKind = 'opds';
    sourceForm.reset();
    sourceOverlay.hidden = true;
    addSourceButton.classList.remove('is-open');
    if (!sourceOverlay.contains(doc.activeElement)) return;
    addSourceButton.focus();
  }

  function openSourceForm(source?: CatalogSource): void {
    editingSourceId = source?.id ?? null;
    editingSourceKind = source?.kind ?? 'opds';
    renderSourceForm(source, editingSourceKind);
    showSourceOverlay();
    sourceForm.querySelector<HTMLInputElement>('input')?.focus();
  }

  async function testWebDavSource(): Promise<void> {
    if (deps.webdavSource === undefined) return;
    const editing = sources.find(
      (candidate) => candidate.id === editingSourceId && candidate.kind === 'webdav',
    );
    const { input, url, allowHttp } = sourceInputFromForm(editing);
    if (httpRequiresAllow(url) && !allowHttp) {
      setFormStatus(labels().httpNotAllowed, 'error');
      deps.notify(labels().httpNotAllowed, 'error');
      return;
    }
    try {
      await deps.webdavSource.test(input);
      setFormStatus(labels().testConnectionOk, 'success');
    } catch (error) {
      const message = errorText(error, labels().offline);
      setFormStatus(message, 'error');
      deps.notify(message, 'error');
    }
  }

  async function saveSource(): Promise<void> {
    const editing = sources.find(
      (candidate) =>
        candidate.id === editingSourceId && candidate.kind === editingSourceKind,
    );
    const { input, kind, url, allowHttp } = sourceInputFromForm(editing);
    if (httpRequiresAllow(url) && !allowHttp) {
      setFormStatus(labels().httpNotAllowed, 'error');
      deps.notify(labels().httpNotAllowed, 'error');
      return;
    }
    try {
      const saved =
        kind === 'webdav'
          ? deps.webdavSource === undefined
            ? undefined
            : await deps.webdavSource.addSource(input)
          : await deps.opds.addSource(input);
      if (saved === undefined) return;
      await refreshSources();
      closeSourceForm();
      await openCatalog(saved.id);
    } catch (error) {
      const message = errorText(error, labels().offline);
      setFormStatus(message, 'error');
      deps.notify(message, 'error');
    }
  }

  async function removeSource(source: CatalogSource): Promise<void> {
    try {
      if (source.kind === 'webdav') {
        if (deps.webdavSource === undefined) return;
        await deps.webdavSource.removeSource(source.id);
      } else {
        await deps.opds.removeSource(source.id);
      }
      sources = sources.filter(
        (candidate) => !(candidate.id === source.id && candidate.kind === source.kind),
      );
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
      importedItemIds.delete(item.id);
      items = items.filter((candidate) => candidate.item.id !== item.id);
      shelfItems = shelfItems.filter((candidate) => candidate.item.id !== item.id);
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
      await refreshSources();
      if (generation !== requestGeneration) return;
      if (catalogActive()) {
        syncPageChrome();
        renderSources();
        await loadFeed(currentUrl);
        return;
      }
      if (activeSection === 'sources') {
        syncPageChrome();
        renderSources();
        return;
      }
      if (activeSection === 'manage') {
        syncPageChrome();
        renderSources();
        await manage.refreshCache();
        return;
      }
      activeSection = 'shelf';
      selectedSourceId = null;
      syncPageChrome();
      renderGroups();
      await loadPersistedItems();
    } catch (error) {
      if (generation !== requestGeneration) return;
      if (catalogActive()) {
        setStatus(errorText(error, labels().offline), true);
        return;
      }
      items = [];
      setStatus('');
      renderContinueBar();
      renderItems();
    }
  }

  function retranslate(): void {
    const l = labels();
    root.setAttribute('aria-label', l.library);
    manageNavButton.textContent = l.manage;
    manageNavButton.prepend(createNavIcon(doc, NAV_ICON_PATHS.settings));
    manageNavButton.title = l.manage;
    manageNavButton.setAttribute('aria-label', l.manage);
    sourceTitle.textContent = l.sources;
    tabbar?.setLabels(tabbarLabels());
    headerImport.title = l.importLocal;
    headerImport.setAttribute('aria-label', l.importLocal);
    searchClear.title = l.clear;
    searchClear.setAttribute('aria-label', l.clear);
    searchButton.textContent = l.search;
    navResize.title = l.resizeNav;
    navResize.setAttribute('aria-label', l.resizeNav);
    addSourceButton.title = l.addSource;
    addSourceButton.setAttribute('aria-label', l.addSource);
    previousButton.textContent = l.prev;
    nextButton.textContent = l.next;
    setNavRailCollapsed(navRailCollapsed, false);
    groupHeader.title = l.groups;
    smartGroupHeader.title = l.smartGroups;
    sourceHeader.title = l.sources;
    manage.retranslate();
    syncPageChrome();
    renderGroups();
    renderSources();
    renderBreadcrumbs();
    renderContinueBar();
    renderItems();
    if (catalogActive()) renderDetail();
    renderSourceForm(
      sources.find((source) => source.id === editingSourceId && source.kind === editingSourceKind),
      editingSourceKind,
    );
    if (membershipItemId !== null) openMembershipEditor(membershipItemId);
  }

  function syncSearchClear(): void {
    searchClear.hidden = searchInput.value.trim() === '';
  }

  function clearCatalogSearchTimer(): void {
    if (catalogSearchTimer !== null) {
      clearTimeout(catalogSearchTimer);
      catalogSearchTimer = null;
    }
  }

  function scheduleCatalogLiveSearch(immediate: boolean): void {
    clearCatalogSearchTimer();
    const query = searchInput.value.trim();
    if (selectedSource()?.kind === 'webdav' || query === '') {
      void search();
      return;
    }
    if (query.length < liveSearchMinChars(query)) return;
    if (immediate) {
      void search();
      return;
    }
    catalogSearchTimer = setTimeout(() => {
      catalogSearchTimer = null;
      void search();
    }, CATALOG_SEARCH_DEBOUNCE_MS);
  }

  searchInput.addEventListener('compositionstart', () => {
    catalogComposing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    catalogComposing = false;
    syncSearchClear();
    if (catalogActive()) scheduleCatalogLiveSearch(false);
  });
  searchInput.addEventListener('input', (event) => {
    syncSearchClear();
    if (catalogActive()) {
      if (catalogComposing || (event instanceof InputEvent && event.isComposing)) return;
      scheduleCatalogLiveSearch(false);
      return;
    }
    void search();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    syncSearchClear();
    clearCatalogSearchTimer();
    void search();
  });
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    clearCatalogSearchTimer();
    void search();
    syncSearchClear();
  });
  navCollapse.addEventListener('click', () => {
    setNavRailCollapsed(!navRailCollapsed);
  });
  headerImport.addEventListener('click', () => {
    void importLocalBook();
  });
  let navResizePointerId: number | null = null;
  let navResizeBodyTransition = '';
  const finishNavResize = (event: PointerEvent): void => {
    if (navResizePointerId !== event.pointerId) return;
    navResizePointerId = null;
    body.style.transition = navResizeBodyTransition;
    try {
      navResize.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (navWidthPx !== null) saveNavWidth(deps.themeStorage, navWidthPx);
  };
  navResize.addEventListener('pointerdown', (event) => {
    if (navRailCollapsed || event.button !== 0) return;
    event.preventDefault();
    navResizePointerId = event.pointerId;
    navResizeBodyTransition = body.style.transition;
    body.style.transition = 'none';
    navResize.setPointerCapture(event.pointerId);
    applyNavWidth(event.clientX - navPane.getBoundingClientRect().left);
    if (navWidthPx !== null) saveNavWidth(deps.themeStorage, navWidthPx);
  });
  navResize.addEventListener('pointermove', (event) => {
    if (navResizePointerId !== event.pointerId) return;
    applyNavWidth(event.clientX - navPane.getBoundingClientRect().left);
    if (navWidthPx !== null) saveNavWidth(deps.themeStorage, navWidthPx);
  });
  navResize.addEventListener('pointerup', finishNavResize);
  navResize.addEventListener('pointercancel', finishNavResize);
  addGroupButton.addEventListener('click', () => {
    openGroupEditor({ kind: 'create' });
  });
  groupToggle.addEventListener('click', () => {
    groupListCollapsed = !groupListCollapsed;
    setNavSectionCollapsed(groupToggle, groupBody, groupListCollapsed, labels().groups);
  });
  smartGroupToggle.addEventListener('click', () => {
    smartGroupListCollapsed = !smartGroupListCollapsed;
    setNavSectionCollapsed(
      smartGroupToggle,
      smartGroupBody,
      smartGroupListCollapsed,
      labels().smartGroups,
    );
  });
  sourceToggle.addEventListener('click', () => {
    sourceListCollapsed = !sourceListCollapsed;
    setNavSectionCollapsed(sourceToggle, sourceBody, sourceListCollapsed, labels().sources);
  });
  // 整行可点（最佳实践）：点击分区标题行任意位置折叠/展开，+ 添加按钮除外。
  for (const [heading, toggle] of [
    [groupHeader, groupToggle],
    [smartGroupHeader, smartGroupToggle],
    [sourceHeader, sourceToggle],
  ] as const) {
    heading.addEventListener('click', (event) => {
      if (navRailCollapsed) {
        setNavRailCollapsed(false);
        return;
      }
      if (event.target instanceof Element && event.target.closest('button') !== null) return;
      toggle.click();
    });
  }
  // 分区筛选：搜索按钮展开/收起输入框，输入即过滤，Esc 清空或收起。
  // 分区折叠时输入框在 body 内不可见，先展开再显示筛选。
  function attachSectionFilter(
    refs: SectionFilterRefs,
    apply: (query: string) => void,
    expandSection?: () => void,
  ): void {
    refs.toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const show = refs.wrap.hidden;
      if (show) expandSection?.();
      refs.wrap.hidden = !show;
      refs.toggle.setAttribute('aria-expanded', String(show));
      refs.clear.hidden = refs.input.value.trim() === '';
      if (show) {
        refs.input.focus();
        return;
      }
      if (refs.input.value !== '') {
        refs.input.value = '';
        refs.clear.hidden = true;
        apply('');
      }
    });
    refs.clear.addEventListener('click', (event) => {
      event.stopPropagation();
      if (refs.input.value === '') {
        refs.wrap.hidden = true;
        refs.toggle.setAttribute('aria-expanded', 'false');
        refs.input.blur();
        return;
      }
      refs.input.value = '';
      refs.clear.hidden = true;
      apply('');
      refs.input.focus();
    });
    refs.input.addEventListener('input', () => {
      refs.clear.hidden = refs.input.value.trim() === '';
      apply(refs.input.value);
    });
    refs.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (refs.input.value !== '') {
        refs.input.value = '';
        refs.clear.hidden = true;
        apply('');
        return;
      }
      refs.wrap.hidden = true;
      refs.toggle.setAttribute('aria-expanded', 'false');
    });
  }
  attachSectionFilter(
    groupFilter,
    (query) => {
      groupFilterQuery = query;
      renderGroups();
    },
    () => {
      if (!groupListCollapsed) return;
      groupListCollapsed = false;
      setNavSectionCollapsed(groupToggle, groupBody, false, labels().groups);
    },
  );
  attachSectionFilter(
    smartGroupFilter,
    (query) => {
      smartGroupFilterQuery = query;
      renderSmartGroups();
    },
    () => {
      if (!smartGroupListCollapsed) return;
      smartGroupListCollapsed = false;
      setNavSectionCollapsed(smartGroupToggle, smartGroupBody, false, labels().smartGroups);
    },
  );
  attachSectionFilter(
    sourceFilter,
    (query) => {
      sourceFilterQuery = query;
      renderSources();
    },
    () => {
      if (!sourceListCollapsed) return;
      sourceListCollapsed = false;
      setNavSectionCollapsed(sourceToggle, sourceBody, false, labels().sources);
    },
  );
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
      return;
    }
    if (event.key === 'Escape' && !detail.hidden) {
      event.preventDefault();
      closeDetail();
      return;
    }
    // 缓存上限弹层以 overlay 语义消费合成 Escape（Android 返回）；
    // 弹层未打开时不消费，交还既有分层链。
    if (event.key === 'Escape' && activeSection === 'manage' && manage.handleEscape()) {
      event.preventDefault();
    }
  });
  detailBackdrop.addEventListener('click', () => closeDetail());
  manageNavButton.addEventListener('click', () => void showManage());
  root.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  addSourceButton.addEventListener('click', () => {
    if (sourceOverlay.hidden || editingSourceId !== null) openSourceForm();
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
  catalogBack.addEventListener('click', () => goCatalogBack());
  retryButton.addEventListener('click', () => void lastAction?.());
  previousButton.addEventListener('click', () => {
    if (feed?.previousUrl != null && feed.previousUrl !== '') {
      void loadFeed(feed.previousUrl);
    }
  });
  nextButton.addEventListener('click', () => {
    void loadMoreCatalog();
  });
  itemList.addEventListener('keydown', (event) => {
    const rows = Array.from(itemList.querySelectorAll<HTMLButtonElement>('.lightink-library-item'));
    if (rows.length === 0) return;
    const shown = visibleItems();
    const current = doc.activeElement instanceof HTMLButtonElement ? rows.indexOf(doc.activeElement) : -1;
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (vertical || (horizontal && (activeSection === 'shelf' || catalogActive()))) {
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
      const row = rows[current];
      if (row?.dataset.libraryAction === 'import') {
        row.click();
        return;
      }
      const display = shown.find((candidate) => candidate.item.id === row?.dataset.itemId);
      void openSelected(display ?? null);
    }
  });

  renderSourceForm();
  retranslate();

  function hide(options?: LibraryHideOptions | Event): void {
    requestGeneration += 1;
    clearCatalogSearchTimer();
    catalogSearchAbort?.abort();
    catalogSearchAbort = null;
    catalogBusy.clear();
    catalogMoreRelease?.();
    catalogMoreRelease = null;
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
      clearCatalogSearchTimer();
      catalogSearchAbort?.abort();
      catalogSearchAbort = null;
      catalogBusy.clear();
      catalogMoreRelease?.();
      catalogMoreRelease = null;
      for (const controller of activeOperations) controller.abort();
      activeOperations.clear();
      manage.destroy();
      deps.workspaceTravel?.remove();
      membershipOverlay.remove();
      groupOverlay.remove();
      sourceOverlay.remove();
      root.remove();
    },
  };
}

export const libraryViewInternals = { bytesLabel, itemFromEntry };
