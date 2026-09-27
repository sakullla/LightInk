import '../theme/tokens.css';
import './library.css';
import { createLibraryView, type LibraryView, type LibraryViewDependencies } from './library-view.js';
import type { LibraryItem } from './library-client.js';
import type { LibraryProgress } from './library-progress.js';
import { LIBRARY_THEME_IDS, type LibraryThemeId } from './library-theme.js';

type Scenario = 'empty' | 'continue' | 'many';
type Layout = 'desktop' | 'narrow' | 'phone';

const SCENARIOS: readonly { id: Scenario; label: string }[] = [
  { id: 'empty', label: '空书架' },
  { id: 'continue', label: '继续阅读' },
  { id: 'many', label: '多书' },
];

const LAYOUTS: readonly { id: Layout; label: string }[] = [
  { id: 'desktop', label: '桌面' },
  { id: 'narrow', label: '窄窗口' },
  { id: 'phone', label: '手机壳' },
];

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

function booksFor(scenario: Scenario): LibraryItem[] {
  if (scenario === 'empty') return [];
  const current = book({
    id: CONTINUE_ID,
    title: '山南信札',
    authors: ['周晚宁'],
    updatedAt: 50,
  });
  if (scenario === 'continue') return [current];
  return [
    current,
    book({
      id: 'local:/books/long.epub',
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

function progressFor(scenario: Scenario, id: string): LibraryProgress {
  if (scenario !== 'empty' && id === CONTINUE_ID) {
    return {
      status: 'in-progress',
      unit: 'chapter',
      index: 3,
      ratio: 0.42,
      percent: 42,
      updatedAt: 80,
      title: '第四章',
    };
  }
  if (scenario === 'many' && id === 'local:/books/finished.epub') {
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
      listGroups: async () => [],
      listGroupMemberships: async () => [],
      listTags: async () => [],
      listTagMemberships: async () => [],
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
  if (!(node instanceof kind)) {
    throw new Error(`LightInk preview: missing ${id}`);
  }
  return node;
}

function applyLayout(layout: Layout): void {
  const root = document.documentElement;
  root.removeAttribute('data-android');
  root.removeAttribute('data-touch-primary');
  if (layout === 'phone') root.setAttribute('data-touch-primary', '');
}

function noteFor(layout: Layout): string {
  const width = window.innerWidth;
  const narrow = width <= 760;
  if (layout === 'desktop' && narrow) return `当前 ${width}px。桌面请把窗口拉到 760px 以上。`;
  if (layout !== 'desktop' && !narrow) return `当前 ${width}px。窄窗口和手机壳请把窗口缩到 760px 以内。`;
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

let view: LibraryView | null = null;

async function mount(): Promise<void> {
  const scenario = scenarioSelect.value as Scenario;
  const theme = themeSelect.value as LibraryThemeId;
  const layout = layoutSelect.value as Layout;
  sessionStorage.setItem('lightink.library.theme', theme);
  applyLayout(layout);
  view?.destroy();
  view = createLibraryView(stage, dependencies(scenario));
  note.textContent = noteFor(layout);
  await view.show();
}

scenarioSelect.addEventListener('change', () => {
  void mount();
});
themeSelect.addEventListener('change', () => {
  void mount();
});
layoutSelect.addEventListener('change', () => {
  void mount();
});
window.addEventListener('resize', () => {
  note.textContent = noteFor(layoutSelect.value as Layout);
});

void mount();
