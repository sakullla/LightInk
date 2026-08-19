import type { AcquisitionLink, LibraryClient, LibraryItem } from './library-client.js';
import { classifyLibraryKind } from './library-kind.js';
import { isShelfCoverUrl } from './local-book-meta.js';
import type {
  LibraryProgress,
  LibraryProgressQuery,
  ProjectLibraryProgressOptions,
} from './library-progress.js';
import type {
  OpdsClient,
  OpdsEntry,
  OpdsFeed,
  OpdsLink,
  OpdsSource,
  OpdsSourceInput,
} from './opds-client.js';

type Locale = 'en' | 'zh-CN';
type LibraryPage = 'my-books' | 'manage' | 'catalog';
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
  importLocal: string;
  search: string;
  searchPlaceholder: string;
  clear: string;
  empty: string;
  emptySources: string;
  loading: string;
  retry: string;
  open: string;
  cacheBook: string;
  caching: string;
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
  readPercent: string;
  pageProgress: string;
  chapterProgress: string;
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
    addSource: 'Add OPDS source',
    editSource: 'Edit OPDS source',
    importLocal: 'Import local book',
    search: 'Search',
    searchPlaceholder: 'Search this library',
    clear: 'Clear',
    empty: 'No books found',
    emptySources: 'No library sources yet. Use + to add one.',
    loading: 'Loading…',
    retry: 'Retry',
    open: 'Open',
    cacheBook: 'Cache book',
    caching: 'Caching…',
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
    readPercent: '{percent}% read',
    pageProgress: 'Page {current}',
    chapterProgress: 'Chapter {current}',
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
    addSource: '添加 OPDS 源',
    editSource: '编辑 OPDS 源',
    importLocal: '导入本地书籍',
    search: '搜索',
    searchPlaceholder: '搜索当前书库',
    clear: '清除',
    empty: '暂无作品',
    emptySources: '还没有书库源，点 + 添加。',
    loading: '正在加载…',
    retry: '重试',
    open: '打开阅读',
    cacheBook: '缓存整本',
    caching: '正在缓存…',
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
    readPercent: '已读 {percent}%',
    pageProgress: '第 {current} 页',
    chapterProgress: '第 {current} 章',
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
  >;
  readonly getLocale: () => Locale;
  readonly onOpen: (request: LibraryOpenRequest, signal?: AbortSignal) => Promise<void>;
  readonly onCache: (request: LibraryOpenRequest, signal?: AbortSignal) => Promise<void>;
  readonly onImportLocal: () => Promise<LibraryItem | null>;
  readonly notify: (message: string, kind?: 'error' | 'warning') => void;
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
}

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
  root.dataset.libraryPage = 'my-books';
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
  searchForm.append(searchInput, searchButton);
  const toolbar = doc.createElement('div');
  toolbar.className = 'lightink-library-toolbar';
  const manageButton = button(doc, '', 'lightink-library-manage-entry');
  const importButton = button(doc, '');
  const clearCacheButton = button(doc, '');
  const backButton = button(doc, '', 'lightink-library-home');
  header.append(heading, searchForm, toolbar);

  const body = doc.createElement('div');
  body.className = 'lightink-library-body';
  const groupPane = doc.createElement('aside');
  groupPane.className = 'lightink-library-groups';
  const groupHeader = doc.createElement('div');
  groupHeader.className = 'lightink-library-pane-heading';
  const groupTitle = doc.createElement('h2');
  groupHeader.append(groupTitle);
  const groupList = doc.createElement('nav');
  groupList.className = 'lightink-library-group-list';
  groupPane.append(groupHeader, groupList);
  const sourcePane = doc.createElement('aside');
  sourcePane.className = 'lightink-library-sources';
  const sourceHeader = doc.createElement('div');
  sourceHeader.className = 'lightink-library-pane-heading';
  const sourceTitle = doc.createElement('h2');
  const addSourceButton = button(doc, '+', 'lightink-library-icon-button');
  sourceHeader.append(sourceTitle, addSourceButton);
  const sourceList = doc.createElement('nav');
  sourceList.className = 'lightink-library-source-list';
  const sourceForm = doc.createElement('form');
  sourceForm.className = 'lightink-library-source-form';
  sourceForm.hidden = true;
  sourcePane.append(sourceHeader, sourceList, sourceForm);

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
  root.append(header, body);
  host.appendChild(root);

  let libraryPage: LibraryPage = 'my-books';
  let selectedGroup: ShelfGroup = 'all';
  let sources: OpdsSource[] = [];
  let selectedSourceId: string | null = null;
  let editingSourceId: string | null = null;
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

  function matchesGroup(display: DisplayItem): boolean {
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
    return libraryPage === 'my-books' ? items.filter(matchesGroup) : items;
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
  }

  async function updateCacheSummary(): Promise<void> {
    if (libraryPage !== 'manage') {
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

  function workspaceTravelSlot(): HTMLElement[] {
    const travel = deps.workspaceTravel;
    if (travel === undefined) return [];
    travel.classList.add('lightink-library-edit');
    travel.hidden = false;
    return [travel];
  }

  function syncPageChrome(): void {
    root.dataset.libraryPage = libraryPage;
    root.classList.toggle('lightink-library--my-books', libraryPage === 'my-books');
    root.classList.toggle('lightink-library--manage', libraryPage === 'manage');
    root.classList.toggle('lightink-library--catalog', libraryPage === 'catalog');
    searchForm.hidden = libraryPage === 'manage';
    if (libraryPage === 'my-books') {
      heading.textContent = labels().myBooks;
      toolbar.replaceChildren(manageButton, ...workspaceTravelSlot());
      itemList.classList.add('lightink-library-cover-wall');
      content.replaceChildren(continueHost, status, itemList);
      body.replaceChildren(groupPane, content);
      detail.hidden = true;
      selected = null;
    } else if (libraryPage === 'manage') {
      heading.textContent = labels().manage;
      parkWorkspaceTravel();
      toolbar.replaceChildren(importButton, clearCacheButton, cacheSummary, backButton);
      itemList.classList.remove('lightink-library-cover-wall');
      content.replaceChildren(status);
      body.replaceChildren(sourcePane, content);
    } else {
      heading.textContent = selectedSource()?.title ?? labels().library;
      parkWorkspaceTravel();
      toolbar.replaceChildren(backButton);
      itemList.classList.remove('lightink-library-cover-wall');
      workArea.replaceChildren(itemList, detail);
      content.replaceChildren(navigation, status, workArea);
      body.replaceChildren(content);
    }
  }

  function renderGroups(): void {
    groupList.replaceChildren();
    groupTitle.textContent = labels().groups;
    groupPane.setAttribute('aria-label', labels().groups);
    for (const group of SHELF_GROUPS) {
      const row = button(doc, groupLabel(labels(), group), 'lightink-library-group');
      row.dataset.shelfGroup = group;
      row.classList.toggle('is-active', selectedGroup === group);
      if (selectedGroup === group) {
        row.setAttribute('aria-current', 'true');
      } else {
        row.removeAttribute('aria-current');
      }
      row.addEventListener('click', () => {
        selectedGroup = group;
        renderGroups();
        renderContinueBar();
        renderItems();
      });
      groupList.appendChild(row);
    }
  }

  function renderSources(): void {
    sourceList.replaceChildren();
    if (sources.length === 0) {
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
  }

  function renderBreadcrumbs(): void {
    breadcrumbs.replaceChildren();
    const source = selectedSource();
    if (trail.length > 0) {
      const rootCrumb = button(doc, source?.title ?? labels().allBooks);
      rootCrumb.addEventListener('click', () => {
        if (source !== undefined) void openCatalog(source.id);
      });
      breadcrumbs.appendChild(rootCrumb);
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
    previousButton.disabled = feed?.previousUrl === undefined;
    nextButton.disabled = feed?.nextUrl === undefined;
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

  function renderCoverCard(display: DisplayItem): HTMLButtonElement {
    const row = button(doc, '', 'lightink-library-item lightink-library-item--cover');
    row.dataset.itemId = display.item.id;
    row.dataset.bookKind = classifyLibraryKind(display.item);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
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
    row.addEventListener('click', () => void selectItem(display));
    row.addEventListener('dblclick', () => void openSelected(display));
    return row;
  }

  function renderContinueBar(): void {
    continueHost.replaceChildren();
    if (libraryPage !== 'my-books' || selectedGroup !== 'all' || searchInput.value.trim() !== '') {
      continueHost.hidden = true;
      return;
    }
    const latest = latestInProgress();
    if (latest === null) {
      continueHost.hidden = true;
      return;
    }
    const progress = progressFor(latest);
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
    const action = button(doc, labels().continueReading, 'lightink-library-primary');
    action.addEventListener('click', () => void openSelected(latest));
    continueHost.append(cover, text, action);
    continueHost.hidden = false;
  }

  function renderItems(): void {
    itemList.replaceChildren();
    if (!status.hidden) {
      return;
    }
    const shown = visibleItems();
    if (shown.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'lightink-library-empty';
      empty.textContent = labels().empty;
      itemList.appendChild(empty);
      detail.hidden = true;
      return;
    }
    for (const display of shown) {
      itemList.appendChild(
        libraryPage === 'my-books' ? renderCoverCard(display) : renderCatalogRow(display),
      );
    }
  }

  async function ensureLinks(display: DisplayItem): Promise<DisplayItem> {
    if (display.links.length > 0 || display.item.sourceKind === 'local') return display;
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
    const request = requestFor(display);
    if (display.item.sourceKind !== 'local' && request.acquisition === undefined) {
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
    open.disabled = selected.item.sourceKind !== 'local' && selected.links.length === 0;
    open.addEventListener('click', () => void openSelected());
    actions.appendChild(open);
    if (selected.item.sourceKind !== 'local') {
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
      item.sourceKind === 'local' &&
      item.localPath !== undefined &&
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
    setStatus(labels().loading);
    lastAction = loadPersistedItems;
    try {
      const loaded = await deps.library.listItems();
      if (generation !== requestGeneration) return;
      items = loaded.map((item) => ({ item, links: [] }));
      selected = null;
      feed = null;
      currentUrl = undefined;
      trail.splice(0);
      setStatus('');
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
      items = loaded.entries.map((entry) => itemFromEntry(source.id, entry));
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
    libraryPage = 'my-books';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    syncPageChrome();
    renderGroups();
    await loadPersistedItems();
  }

  async function showManage(): Promise<void> {
    libraryPage = 'manage';
    selectedSourceId = null;
    selected = null;
    feed = null;
    currentUrl = undefined;
    trail.splice(0);
    searchInput.value = '';
    closeSourceForm();
    setStatus('');
    syncPageChrome();
    renderSources();
    await updateCacheSummary();
  }

  async function openCatalog(sourceId: string): Promise<void> {
    libraryPage = 'catalog';
    selectedSourceId = sourceId;
    searchInput.value = '';
    trail.splice(0);
    syncPageChrome();
    renderSources();
    renderBreadcrumbs();
    await loadFeed(undefined, false);
  }

  async function search(): Promise<void> {
    const query = searchInput.value.trim();
    if (query === '') {
      if (libraryPage === 'catalog' && selectedSourceId !== null) {
        await openCatalog(selectedSourceId);
        return;
      }
      await showMyBooks();
      return;
    }
    if (libraryPage !== 'catalog' || selectedSourceId === null) {
      const lowered = query.toLocaleLowerCase();
      const loaded = await deps.library.listItems();
      items = loaded
        .filter((item) =>
          `${itemTitle(item)}\n${itemAuthors(item).join('\n')}`.toLocaleLowerCase().includes(lowered),
        )
        .map((item) => ({ item, links: [] }));
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
      items = loaded.entries.map((entry) => itemFromEntry(selectedSourceId!, entry));
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

  function renderSourceForm(source?: OpdsSource): void {
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
    const title = makeInput('title');
    const url = makeInput('url', 'url');
    const auth = doc.createElement('select');
    auth.name = 'auth';
    auth.setAttribute('aria-label', labels().auth);
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
    const actions = doc.createElement('div');
    const save = button(doc, labels().save, 'lightink-library-primary');
    save.type = 'submit';
    const cancel = button(doc, labels().cancel);
    cancel.addEventListener('click', () => {
      closeSourceForm();
    });
    actions.append(save, cancel);
    sourceForm.setAttribute('role', 'dialog');
    sourceForm.setAttribute('aria-label', source === undefined ? labels().addSource : labels().editSource);
    sourceForm.append(
      labeled(title, labels().title),
      labeled(url, labels().url),
      labeled(auth, labels().auth),
      username,
      password,
      token,
      allowLabel,
      actions,
    );
    auth.addEventListener('change', () => {
      username.hidden = password.hidden = auth.value !== 'basic';
      token.hidden = auth.value !== 'bearer';
      username.required = password.required = auth.value === 'basic';
      token.required = auth.value === 'bearer';
    });
    title.value = source?.title ?? '';
    url.value = source?.url ?? '';
    allow.checked = source?.allowHttp ?? false;
    auth.value = source?.credentialRef === undefined ? 'none' : 'keep';
  }

  function closeSourceForm(): void {
    editingSourceId = null;
    sourceForm.reset();
    sourceForm.hidden = true;
    addSourceButton.classList.remove('is-open');
    addSourceButton.focus();
  }

  function openSourceForm(source?: OpdsSource): void {
    editingSourceId = source?.id ?? null;
    renderSourceForm(source);
    sourceForm.hidden = false;
    addSourceButton.classList.add('is-open');
    sourceForm.querySelector<HTMLInputElement>('input')?.focus();
  }

  async function saveSource(): Promise<void> {
    const data = new FormData(sourceForm);
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

  async function removeSource(source: OpdsSource): Promise<void> {
    try {
      await deps.opds.removeSource(source.id);
      sources = sources.filter((candidate) => candidate.id !== source.id);
      if (editingSourceId === source.id) closeSourceForm();
      if (selectedSourceId === source.id || libraryPage === 'catalog') await showManage();
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
    } catch (error) {
      deps.notify(errorText(error, labels().offline), 'error');
    }
  }

  async function initialLoad(): Promise<void> {
    const generation = ++requestGeneration;
    setStatus(labels().loading);
    try {
      sources = await deps.opds.listSources();
      if (generation !== requestGeneration) return;
      if (libraryPage === 'catalog' && selectedSourceId !== null) {
        syncPageChrome();
        renderSources();
        await loadFeed(currentUrl, false);
        return;
      }
      if (libraryPage === 'manage') {
        syncPageChrome();
        renderSources();
        await updateCacheSummary();
        return;
      }
      libraryPage = 'my-books';
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
    manageButton.textContent = l.manage;
    manageButton.title = l.manage;
    manageButton.setAttribute('aria-label', l.manage);
    backButton.textContent = l.backToShelf;
    sourceTitle.textContent = l.sources;
    searchInput.placeholder = l.searchPlaceholder;
    searchInput.setAttribute('aria-label', l.searchPlaceholder);
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
    if (libraryPage === 'catalog') renderDetail();
    renderSourceForm(sources.find((source) => source.id === editingSourceId));
    void updateCacheSummary();
  }

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void search();
  });
  manageButton.addEventListener('click', () => void showManage());
  backButton.addEventListener('click', () => void showMyBooks());
  addSourceButton.addEventListener('click', () => {
    if (sourceForm.hidden || editingSourceId !== null) openSourceForm();
    else closeSourceForm();
  });
  sourceForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveSource();
  });
  importButton.addEventListener('click', async () => {
    const item = await deps.onImportLocal();
    if (item !== null) await showMyBooks();
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
    if (feed?.previousUrl !== undefined) void loadFeed(feed.previousUrl, false);
  });
  nextButton.addEventListener('click', () => {
    if (feed?.nextUrl !== undefined) void loadFeed(feed.nextUrl, false);
  });
  itemList.addEventListener('keydown', (event) => {
    const rows = Array.from(itemList.querySelectorAll<HTMLButtonElement>('.lightink-library-item'));
    if (rows.length === 0) return;
    const shown = visibleItems();
    const current = doc.activeElement instanceof HTMLButtonElement ? rows.indexOf(doc.activeElement) : -1;
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
    if (vertical || (horizontal && libraryPage === 'my-books')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const next = Math.max(0, Math.min(rows.length - 1, current + delta));
      rows[next]?.focus();
      if (libraryPage === 'catalog') {
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
      libraryPage = 'my-books';
      selectedGroup = 'all';
      searchInput.value = '';
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
