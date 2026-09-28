import '../theme/tokens.css';
import './library.css';
import { createLibraryView, type LibraryView, type LibraryViewDependencies } from './library-view.js';
import type {
  LibraryGroup,
  LibraryGroupMembership,
  LibraryItem,
  LibraryTag,
  LibraryTagMembership,
} from './library-client.js';
import type { LibraryProgress } from './library-progress.js';
import { LIBRARY_THEME_IDS, type LibraryThemeId } from './library-theme.js';

type Scenario =
  | 'empty'
  | 'single'
  | 'reading'
  | 'groups-tags'
  | 'long-missing'
  | 'filter-empty';
type Layout = 'desktop' | 'narrow' | 'phone' | 'phone-safe' | 'phone-keyboard';

const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: 'empty', label: '空书库' },
  { id: 'single', label: '单本续读' },
  { id: 'reading', label: '多本阅读' },
  { id: 'groups-tags', label: '分组与标签' },
  { id: 'long-missing', label: '长标题 / 缺封面' },
  { id: 'filter-empty', label: '筛选无结果' },
];

const LAYOUTS: readonly { id: Layout; label: string }[] = [
  { id: 'desktop', label: '桌面' },
  { id: 'narrow', label: '窄窗口（侧栏）' },
  { id: 'phone', label: '手机壳' },
  { id: 'phone-safe', label: '手机壳 + Safe area' },
  { id: 'phone-keyboard', label: '手机壳 + 键盘' },
];

const COVER_ART =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 600'%3E%3Crect width='400' height='600' fill='%23425345'/%3E%3Cpath d='M45 80h310v440H45z' fill='none' stroke='%23e8dec9' stroke-width='3'/%3E%3Cpath d='M80 390c70-130 150-130 240 0' fill='none' stroke='%23d99a62' stroke-width='18'/%3E%3Ctext x='200' y='190' text-anchor='middle' fill='%23f4ead8' font-size='42' font-family='serif'%3E山南信札%3C/text%3E%3C/svg%3E";

function book(partial: Pick<LibraryItem, 'id' | 'title'> & Partial<LibraryItem>): LibraryItem {
  return {
    sourceKind: 'local',
    authors: [],
    extension: 'epub',
    localPath: partial.id,
    updatedAt: 1,
    ...partial,
  };
}

const CONTINUE_ID = 'local:/books/continue.epub';
const RECENT_ID = 'local:/books/long.epub';

function fullShelf(): LibraryItem[] {
  return [
    book({
      id: CONTINUE_ID,
      title: '山南信札',
      authors: ['周晚宁'],
      coverUrl: COVER_ART,
      updatedAt: 50,
    }),
    book({
      id: RECENT_ID,
      title: '这是一本长到需要换行、也不该盖住旁边封面的小说',
      authors: ['陈纸'],
      series: '纸上城',
      updatedAt: 40,
    }),
    book({
      id: 'local:/books/finished.epub',
      title: '潮声',
      authors: ['林可'],
      updatedAt: 30,
    }),
    book({
      id: 'local:/books/unread.epub',
      title: '未读的冬天',
      authors: ['苏眠'],
      updatedAt: 20,
    }),
    book({
      id: 'local:/books/comic.cbz',
      title: '城南夜话',
      authors: ['画组'],
      extension: 'cbz',
      updatedAt: 10,
    }),
    book({
      id: 'local:/books/moss.epub',
      title: '苔痕',
      authors: ['何青'],
      updatedAt: 9,
    }),
  ];
}

function booksFor(scenario: Scenario): LibraryItem[] {
  if (scenario === 'empty') return [];
  if (scenario === 'single') return fullShelf().slice(0, 1);
  if (scenario === 'long-missing') return fullShelf().slice(1, 3);
  return fullShelf();
}

function progressFor(scenario: Scenario, id: string): LibraryProgress {
  if (scenario !== 'empty' && scenario !== 'long-missing' && id === CONTINUE_ID) {
    return {
      status: 'in-progress',
      unit: 'chapter',
      index: 3,
      ratio: 0.42,
      percent: 42,
      updatedAt: 180,
      title: '第四章',
    };
  }
  if ((scenario === 'reading' || scenario === 'groups-tags' || scenario === 'filter-empty') && id === RECENT_ID) {
    return {
      status: 'in-progress',
      unit: 'chapter',
      index: 7,
      ratio: 0.68,
      percent: 68,
      updatedAt: 120,
      title: '第八章',
    };
  }
  if (scenario !== 'empty' && id === 'local:/books/finished.epub') {
    return {
      status: 'finished',
      unit: 'chapter',
      index: 12,
      ratio: 1,
      percent: 100,
      updatedAt: 20,
    };
  }
  return { status: 'not-started' };
}

function groupsFor(scenario: Scenario): LibraryGroup[] {
  if (scenario !== 'groups-tags') return [];
  return [
    { id: 'group-essays', name: '随笔与信札', kind: 'custom', sortOrder: 0 },
    { id: 'group-night', name: '夜读', kind: 'custom', sortOrder: 1 },
  ];
}

function groupMembershipsFor(scenario: Scenario): LibraryGroupMembership[] {
  if (scenario !== 'groups-tags') return [];
  return [
    { groupId: 'group-essays', itemId: CONTINUE_ID },
    { groupId: 'group-essays', itemId: RECENT_ID },
    { groupId: 'group-night', itemId: 'local:/books/comic.cbz' },
  ];
}

function tagsFor(scenario: Scenario): LibraryTag[] {
  if (scenario !== 'groups-tags') return [];
  return [
    { id: 'tag-favorite', name: '重读', createdAt: 1, updatedAt: 2 },
    { id: 'tag-local', name: '本地精选', createdAt: 2, updatedAt: 3 },
  ];
}

function tagMembershipsFor(scenario: Scenario): LibraryTagMembership[] {
  if (scenario !== 'groups-tags') return [];
  return [
    { tagId: 'tag-favorite', itemId: CONTINUE_ID },
    { tagId: 'tag-local', itemId: RECENT_ID },
    { tagId: 'tag-local', itemId: 'local:/books/moss.epub' },
  ];
}

function dependencies(scenario: Scenario): LibraryViewDependencies {
  const items = booksFor(scenario);
  return {
    opds: {
      addSource: async () => {
        throw new Error('preview');
      },
      listSources: async () => [],
      removeSource: async () => undefined,
      browse: async () => ({ title: '', entries: [], links: [], sourceUrl: 'https://preview.invalid' }),
      search: async () => ({ title: '', entries: [], links: [], sourceUrl: 'https://preview.invalid' }),
    },
    library: {
      listItems: async () => items,
      listAcquisitionLinks: async () => [],
      removeItem: async () => undefined,
      clearCache: async () => undefined,
      setCacheLimit: async () => undefined,
      cacheStats: async () => ({ bytesCached: 0, limitBytes: 2 * 1024 ** 3 }),
      listGroups: async () => groupsFor(scenario),
      listGroupMemberships: async () => groupMembershipsFor(scenario),
      listTags: async () => tagsFor(scenario),
      listTagMemberships: async () => tagMembershipsFor(scenario),
    },
    webdavSource: {
      addSource: async () => {
        throw new Error('preview');
      },
      listSources: async () => [],
      removeSource: async () => undefined,
      browse: async () => ({ title: '', entries: [], links: [], sourceUrl: 'https://preview.invalid' }),
      test: async () => ({ ok: true, finalUrl: 'https://preview.invalid' }),
    },
    getLocale: () => 'zh-CN',
    onOpen: async () => undefined,
    onCache: async () => undefined,
    onImportLocal: async () => null,
    notify: () => undefined,
    onOpenAssistant: () => undefined,
    getProgress: (query) => progressFor(scenario, query.id),
    themeStorage: {
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => {
        sessionStorage.setItem(key, value);
      },
    },
  };
}

function requiredElement<T extends Element>(id: string, kind: new () => T): T {
  const node = document.querySelector(id);
  if (!(node instanceof kind)) throw new Error(`LightInk preview: missing ${id}`);
  return node;
}

function isScenario(value: string | null): value is Scenario {
  return SCENARIOS.some((scenario) => scenario.id === value);
}

function isLayout(value: string | null): value is Layout {
  return LAYOUTS.some((layout) => layout.id === value);
}

function isTheme(value: string | null): value is LibraryThemeId {
  return LIBRARY_THEME_IDS.some((theme) => theme === value);
}

function applyLayout(layout: Layout): void {
  const root = document.documentElement;
  root.removeAttribute('data-android');
  root.removeAttribute('data-touch-primary');
  root.removeAttribute('data-keyboard');
  root.style.removeProperty('--lightink-safe-top');
  root.style.removeProperty('--lightink-safe-right');
  root.style.removeProperty('--lightink-safe-bottom');
  root.style.removeProperty('--lightink-safe-left');
  root.style.removeProperty('--lightink-keyboard-inset');
  if (layout === 'phone' || layout === 'phone-safe' || layout === 'phone-keyboard') {
    root.setAttribute('data-touch-primary', '');
  }
  if (layout === 'phone-safe' || layout === 'phone-keyboard') {
    root.style.setProperty('--lightink-safe-top', '28px');
    root.style.setProperty('--lightink-safe-right', '8px');
    root.style.setProperty('--lightink-safe-bottom', '24px');
    root.style.setProperty('--lightink-safe-left', '8px');
  }
  if (layout === 'phone-keyboard') {
    root.setAttribute('data-keyboard', '');
    root.style.setProperty('--lightink-keyboard-inset', '280px');
  }
}

function noteFor(layout: Layout): string {
  const width = window.innerWidth;
  const narrow = width <= 760;
  if (layout === 'desktop' && narrow) return `当前 ${width}px。桌面请把窗口拉到 760px 以上。`;
  if (layout !== 'desktop' && !narrow) return `当前 ${width}px。此样本请把窗口缩到 760px 以内。`;
  if (layout === 'phone-keyboard') return `当前 ${width}px，手机壳 + 280px 键盘 inset。`;
  if (layout === 'phone-safe') return `当前 ${width}px，手机壳 + 顶底 safe-area。`;
  if (layout === 'phone') return `当前 ${width}px，手机壳。底部是书架 / 书源 / 管理。`;
  if (layout === 'narrow') return `当前 ${width}px，无手机壳标记，仍用左侧导航。`;
  return `当前 ${width}px，桌面左侧导航。`;
}

const scenarioSelect = requiredElement('#preview-scenario', HTMLSelectElement);
const themeSelect = requiredElement('#preview-theme', HTMLSelectElement);
const layoutSelect = requiredElement('#preview-layout', HTMLSelectElement);
const note = requiredElement('#preview-note', HTMLElement);
const stage = requiredElement('#preview-stage', HTMLElement);

for (const scenario of SCENARIOS) {
  const option = document.createElement('option');
  option.value = scenario.id;
  option.textContent = scenario.label;
  scenarioSelect.appendChild(option);
}
for (const theme of LIBRARY_THEME_IDS) {
  const option = document.createElement('option');
  option.value = theme;
  option.textContent = theme;
  themeSelect.appendChild(option);
}
for (const layout of LAYOUTS) {
  const option = document.createElement('option');
  option.value = layout.id;
  option.textContent = layout.label;
  layoutSelect.appendChild(option);
}

const initial = new URL(window.location.href).searchParams;
const initialScenario = initial.get('scenario');
const initialTheme = initial.get('theme');
const initialLayout = initial.get('layout');
scenarioSelect.value = isScenario(initialScenario) ? initialScenario : 'reading';
themeSelect.value = isTheme(initialTheme) ? initialTheme : 'gallery';
layoutSelect.value = isLayout(initialLayout) ? initialLayout : 'desktop';

let view: LibraryView | null = null;

function persistPreviewUrl(scenario: Scenario, theme: LibraryThemeId, layout: Layout): void {
  const url = new URL(window.location.href);
  url.searchParams.set('scenario', scenario);
  url.searchParams.set('theme', theme);
  url.searchParams.set('layout', layout);
  history.replaceState(null, '', url);
}

async function mount(): Promise<void> {
  const scenario = scenarioSelect.value as Scenario;
  const theme = themeSelect.value as LibraryThemeId;
  const layout = layoutSelect.value as Layout;
  sessionStorage.setItem('lightink.library.theme', theme);
  applyLayout(layout);
  persistPreviewUrl(scenario, theme, layout);
  view?.destroy();
  view = createLibraryView(stage, dependencies(scenario));
  note.textContent = noteFor(layout);
  await view.show();
  if (scenario === 'filter-empty') {
    const search = stage.querySelector<HTMLInputElement>('.lightink-library-search input');
    if (search !== null) {
      search.value = '绝对不存在的标题';
      search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    }
  }
}

scenarioSelect.addEventListener('change', () => void mount());
themeSelect.addEventListener('change', () => void mount());
layoutSelect.addEventListener('change', () => void mount());
window.addEventListener('resize', () => {
  note.textContent = noteFor(layoutSelect.value as Layout);
});

void mount();
