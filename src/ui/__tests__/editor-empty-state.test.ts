import { describe, expect, it, vi } from 'vitest';

import {
  createEditorEmptyState,
  filterRecentMarkdownPaths,
} from '../editor-empty-state.js';

class FakeEl {
  className = '';
  hidden = false;
  type = '';
  title = '';
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  private ownText = '';
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  appendChild(child: FakeEl): FakeEl {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...kids: FakeEl[]): void {
    for (const kid of kids) this.appendChild(kid);
  }

  replaceChildren(...kids: FakeEl[]): void {
    for (const old of this.children) old.parentElement = null;
    this.children = [];
    for (const kid of kids) this.appendChild(kid);
  }

  remove(): void {
    if (this.parentElement === null) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }

  findByClass(cls: string): FakeEl | null {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const child of this.children) {
      const hit = child.findByClass(cls);
      if (hit !== null) return hit;
    }
    return null;
  }
}

describe('filterRecentMarkdownPaths', () => {
  it('keeps only Markdown extensions and caps count', () => {
    expect(
      filterRecentMarkdownPaths([
        'C:/Books/dune.epub',
        'C:/Notes/one.md',
        'C:/Notes/two.MARKDOWN',
        'C:/Books/comic.cbz',
        'C:/Notes/three.md',
      ], 2),
    ).toEqual(['C:/Notes/one.md', 'C:/Notes/two.MARKDOWN']);
  });
});

describe('createEditorEmptyState', () => {
  it('mounts when zero tabs are open, renders recent Markdown files, and detaches when tabs open', async () => {
    const doc = {
      createElement: (tag: string) => new FakeEl(tag),
    } as unknown as Document;
    const host = new FakeEl('div');
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const onOpenRecent = vi.fn();

    const empty = createEditorEmptyState(host as unknown as HTMLElement, {
      doc,
      labels: () => ({
        title: '暂无打开的文档',
        hint: '新建或打开文档',
        newDoc: '新建',
        newShortcut: 'Ctrl+N',
        openDoc: '打开',
        openShortcut: 'Ctrl+O',
        recentHeading: '最近文档',
      }),
      onNew,
      onOpen,
      listRecents: async () => ['C:/Books/dune.txt', 'C:/Notes/design.md'],
      onOpenRecent,
    });

    empty.sync(false);
    expect(host.children).toHaveLength(1);
    const root = empty.element as unknown as FakeEl;
    expect(root.hidden).toBe(false);

    root.findByClass('lightink-editor-empty__btn--primary')?.click();
    expect(onNew).toHaveBeenCalledOnce();

    await Promise.resolve();
    await Promise.resolve();
    const recentItem = root.findByClass('lightink-editor-empty__recent-item');
    expect(recentItem).not.toBeNull();
    expect(recentItem?.textContent).toContain('design.md');
    recentItem?.click();
    expect(onOpenRecent).toHaveBeenCalledWith('C:/Notes/design.md');

    empty.sync(true);
    expect(root.hidden).toBe(true);
    expect(host.children).toHaveLength(0);
  });
});
