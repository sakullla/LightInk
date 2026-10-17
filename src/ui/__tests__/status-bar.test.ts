/**
 * status-bar tests: visibility preference, persistence state, debounced document
 * metrics, reopen refresh, and Unicode cursor positions.
 * node 环境无 DOM，用最小 fake（同 app-shell.test.ts 模式）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  STATUS_BAR_VISIBLE_STORAGE_KEY,
  createStatusBar,
  cursorPositionFromOffset,
  formatWordStats,
  loadStatusBarVisible,
  saveStatusBarVisible,
  type MarkdownStatusSnapshot,
  type StatusBarLabels,
} from '../status-bar.js';

class FakeEl {
  id = '';
  className = '';
  hidden = false;
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  style: Record<string, string> = {};
  private ownText = '';
  private readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  appendChild(child: FakeEl): FakeEl {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeEl[]): void {
    children.forEach((child) => this.appendChild(child));
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent !== null) {
      const index = parent.children.indexOf(this);
      if (index >= 0) {
        parent.children.splice(index, 1);
      }
      this.parentNode = null;
    }
  }
}

function fakeDoc(): Pick<Document, 'createElement'> {
  return {
    createElement: (tag: string) => new FakeEl(tag) as unknown as HTMLElement,
  };
}

function memoryStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  return {
    store: { ...initial },
    getItem(key: string) {
      return this.store[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.store[key] = value;
    },
  };
}

const zhLabels = (): StatusBarLabels => ({
  words: '字数',
  characters: '字符',
  line: '行',
  column: '列',
  encoding: 'UTF-8',
  save: {
    saved: '已保存',
    dirty: '已修改',
    saving: '正在保存',
    error: '保存失败',
    conflict: '外部冲突',
  },
  reader: {
    phase: {
      empty: '阅读器',
      loading: '正在加载',
      ready: '阅读中',
      cancelled: '加载已取消',
      error: '加载失败',
      destroyed: '阅读器已关闭',
    },
    page: '页',
    chapter: '章',
    progress: '进度',
    zoom: '缩放',
  },
});

function snapshot(
  markdown: string,
  saveStatus: MarkdownStatusSnapshot['saveStatus'] = 'saved',
): MarkdownStatusSnapshot {
  return { kind: 'markdown', markdown, saveStatus, cursor: { line: 2, column: 3 } };
}

function childByClass(root: FakeEl, className: string): FakeEl {
  const found = root.children
    .flatMap((child) => [child, ...child.children])
    .find((child) => child.className === className);
  if (found === undefined) throw new Error(`Missing child ${className}`);
  return found;
}

function makeBar(
  host: FakeEl,
  options: {
    storage?: ReturnType<typeof memoryStorage> | null;
    initiallyVisible?: boolean;
    debounceMs?: number;
  } = {},
) {
  return createStatusBar(fakeDoc(), host as unknown as HTMLElement, {
    storage: options.storage === undefined ? null : options.storage,
    labels: zhLabels,
    initiallyVisible: options.initiallyVisible,
    debounceMs: options.debounceMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('显隐偏好（localStorage，chrome-prefs 模式）', () => {
  it('无存储 / 缺键 / 损坏值均回落默认（开启，纸墨工作室 §3.14 真实默认缺口）', () => {
    expect(loadStatusBarVisible(null)).toBe(true);
    expect(loadStatusBarVisible(memoryStorage())).toBe(true);
    expect(loadStatusBarVisible(memoryStorage({ [STATUS_BAR_VISIBLE_STORAGE_KEY]: 'oops' }))).toBe(
      true,
    );
  });

  it('显式 true/false 按值恢复；save 持久化布尔', () => {
    const storage = memoryStorage();
    saveStatusBarVisible(storage, true);
    expect(loadStatusBarVisible(storage)).toBe(true);
    saveStatusBarVisible(storage, false);
    expect(loadStatusBarVisible(storage)).toBe(false);
    expect(storage.store[STATUS_BAR_VISIBLE_STORAGE_KEY]).toBe('false');
  });

  it('toggle 写入存储，跨「会话」（新建实例）保持', () => {
    const storage = memoryStorage();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage });
    expect(bar.isVisible()).toBe(true);

    bar.toggle();
    expect(storage.store[STATUS_BAR_VISIBLE_STORAGE_KEY]).toBe('false');

    // 模拟重启：同一 storage 新建实例恢复关闭。
    const host2 = new FakeEl('div');
    const bar2 = makeBar(host2, { storage });
    expect(bar2.isVisible()).toBe(false);
    expect(host2.children).toHaveLength(0);
  });

  it('默认开启：未显式保存偏好时挂载状态栏（字数/保存状态一等反馈）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null });
    expect(bar.isVisible()).toBe(true);
    expect(host.children).toHaveLength(1);
  });
});

describe('渲染与显隐', () => {
  it('显式关闭时不挂载也不渲染', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: false });
    expect(bar.isVisible()).toBe(false);
    expect(host.children).toHaveLength(0);
    // 隐藏时 refresh 不渲染。
    bar.refresh(() => snapshot('你好'));
    expect(host.children).toHaveLength(0);
  });

  it('开启时挂载并显示口径文案「字数 N · 字符 M」', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    expect(host.children).toHaveLength(1);

    bar.refresh(() => snapshot('你好 hello', 'dirty'));
    // 字数 = 2(你好) + 1(hello) = 3；字符 = 2 + 5 = 7。
    const root = bar.element as unknown as FakeEl;
    expect(childByClass(root, 'lightink-status-save').textContent).toBe('已修改');
    expect(childByClass(root, 'lightink-status-position').textContent).toBe('行 2, 列 3');
    expect(childByClass(root, 'lightink-status-counts').textContent).toBe('字数 3 · 字符 7');
  });

  it('无活动文档 / getter 抛错时隐藏内容（不抛出）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    bar.refresh(() => null);
    expect((bar.element as unknown as FakeEl).hidden).toBe(true);
    bar.refresh(() => {
      throw new Error('editor gone');
    });
    expect((bar.element as unknown as FakeEl).hidden).toBe(true);
  });

  it('渲染 Reader 章节进度和有效缩放，并在加载时隐藏位置详情', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    bar.refresh(() => ({
      kind: 'reader',
      state: {
        phase: 'ready',
        current: 2,
        total: 4,
        progress: 0.5,
        scale: 1,
        locationKind: 'chapter',
      },
      displayScale: 1.5,
    }));

    const root = bar.element as unknown as FakeEl;
    expect(root.dataset.statusKind).toBe('reader');
    expect(root.dataset.readerPhase).toBe('ready');
    expect(root.dataset.saveStatus).toBeUndefined();
    expect(childByClass(root, 'lightink-status-save').hidden).toBe(true);
    expect(childByClass(root, 'lightink-status-save').textContent).toBe('');
    expect(childByClass(root, 'lightink-status-position').textContent).toBe('章 2/4');
    expect(childByClass(root, 'lightink-status-encoding').textContent).toBe('进度 50%');
    expect(childByClass(root, 'lightink-status-counts').textContent).toBe('缩放 150%');

    bar.refresh(() => ({
      kind: 'reader',
      state: {
        phase: 'loading',
        current: 0,
        total: 0,
        progress: 0,
        scale: 1,
        locationKind: null,
      },
      displayScale: 1,
    }));
    expect(childByClass(root, 'lightink-status-save').textContent).toBe('正在加载');
    expect(childByClass(root, 'lightink-status-position').hidden).toBe(true);
  });

  it('关闭后从 DOM 移除；重新打开立即按当前文档重绘（不等编辑）', () => {
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true });
    let doc = '你好';
    bar.refresh(() => snapshot(doc));
    expect(childByClass(bar.element as unknown as FakeEl, 'lightink-status-counts').textContent).toBe(
      '字数 2 · 字符 2',
    );

    bar.setVisible(false);
    expect(host.children).toHaveLength(0);

    // 关闭期间文档变化；重开应立即反映当前文档。
    doc = '你好世界 hello';
    bar.setVisible(true);
    expect(host.children).toHaveLength(1);
    expect(childByClass(bar.element as unknown as FakeEl, 'lightink-status-counts').textContent).toBe(
      '字数 5 · 字符 9',
    );
  });
});

describe('防抖刷新（scheduleUpdate）', () => {
  it('窗口内多次调度只渲染最后一次', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true, debounceMs: 300 });
    let doc = 'a';
    bar.scheduleUpdate(() => snapshot(doc));
    doc = 'ab';
    bar.scheduleUpdate(() => snapshot(doc));
    vi.advanceTimersByTime(299);
    expect(childByClass(bar.element as unknown as FakeEl, 'lightink-status-counts').textContent).toBe('');
    doc = 'abc';
    bar.scheduleUpdate(() => snapshot(doc));
    vi.advanceTimersByTime(300);
    // 'abc' = 1 个拉丁词、3 个非空白字符（仅渲染最后一次调度）。
    expect(childByClass(bar.element as unknown as FakeEl, 'lightink-status-counts').textContent).toBe(
      '字数 1 · 字符 3',
    );
  });

  it('隐藏时调度不启动计时器（不渲染）', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: false, debounceMs: 300 });
    bar.scheduleUpdate(() => snapshot('你好'));
    vi.advanceTimersByTime(1000);
    expect(host.children).toHaveLength(0);
  });

  it('destroy 清计时器并移除元素', () => {
    vi.useFakeTimers();
    const host = new FakeEl('div');
    const bar = makeBar(host, { storage: null, initiallyVisible: true, debounceMs: 300 });
    bar.scheduleUpdate(() => snapshot('你好'));
    bar.destroy();
    vi.advanceTimersByTime(1000);
    expect(host.children).toHaveLength(0);
  });
});

describe('formatWordStats 文案', () => {
  it('千分位分隔 + 口径标签', () => {
    expect(formatWordStats({ words: 1234, characters: 5678 }, zhLabels())).toBe(
      '字数 1,234 · 字符 5,678',
    );
    expect(
      formatWordStats(
        { words: 1, characters: 2 },
        { ...zhLabels(), words: 'Words', characters: 'Characters' },
      ),
    ).toBe('Words 1 · Characters 2');
  });
});

describe('cursorPositionFromOffset', () => {
  it('counts CRLF lines and Unicode code points', () => {
    expect(cursorPositionFromOffset('first\r\n你😀好', 11)).toEqual({ line: 2, column: 4 });
  });
});
