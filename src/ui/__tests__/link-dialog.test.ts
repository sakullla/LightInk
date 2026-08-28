/**
 * link-dialog pure-ish wiring tests (node fake DOM).
 * Covers field construction + confirm/cancel settle paths via fake elements.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderCheatsheet, type CheatBinding } from '../help-cheatsheet.js';
import { showLinkDialog, showOpenLinkConfirm } from '../link-dialog.js';

class FakeEl {
  tagName: string;
  className = '';
  textContent = '';
  value = '';
  type = '';
  id = '';
  htmlFor = '';
  placeholder = '';
  autocomplete = '';
  spellcheck = false;
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  append(...nodes: FakeEl[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  remove(): void {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  }

  addEventListener(type: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((x) => x !== fn),
    );
  }

  focus = vi.fn();
  select = vi.fn();

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }

  emit(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  query(selector: (el: FakeEl) => boolean): FakeEl | null {
    if (selector(this)) return this;
    for (const c of this.children) {
      const hit = c.query(selector);
      if (hit) return hit;
    }
    return null;
  }
}

function fakeDoc(): Document & { body: FakeEl; _keydown: Array<(e: unknown) => void> } {
  const body = new FakeEl('body');
  const keydown: Array<(e: unknown) => void> = [];
  return {
    body,
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'keydown') keydown.push(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'keydown') {
        const i = keydown.indexOf(fn);
        if (i >= 0) keydown.splice(i, 1);
      }
    },
    _keydown: keydown,
  } as unknown as Document & { body: FakeEl; _keydown: Array<(e: unknown) => void> };
}

describe('showLinkDialog', () => {
  it('resolves null on cancel', async () => {
    const doc = fakeDoc();
    const pending = showLinkDialog(doc, { initialText: 'a', initialHref: 'https://x' });
    const cancel = doc.body.query(
      (el) => el.tagName === 'BUTTON' && (el.textContent === '取消' || el.textContent === 'Cancel'),
    );
    expect(cancel).not.toBeNull();
    cancel!.click();
    await expect(pending).resolves.toBeNull();
  });

  it('resolves values on confirm', async () => {
    const doc = fakeDoc();
    const pending = showLinkDialog(doc, {
      initialText: 'docs',
      initialHref: 'https://example.com',
      confirmLabel: '应用',
    });
    // Fill inputs
    const inputs = [] as FakeEl[];
    const walk = (el: FakeEl): void => {
      if (el.tagName === 'INPUT') inputs.push(el);
      for (const c of el.children) walk(c);
    };
    walk(doc.body);
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    inputs[0]!.value = '新标题';
    inputs[1]!.value = 'https://new.example';
    const ok = doc.body.query((el) => el.tagName === 'BUTTON' && el.textContent === '应用');
    ok!.click();
    await expect(pending).resolves.toEqual({
      text: '新标题',
      href: 'https://new.example',
    });
  });
});

describe('showOpenLinkConfirm', () => {
  it('resolves false on cancel and true on open', async () => {
    const doc = fakeDoc();
    const pending = showOpenLinkConfirm(doc, 'https://example.com');
    const cancel = doc.body.query(
      (el) => el.tagName === 'BUTTON' && (el.textContent === '取消' || el.textContent === 'Cancel'),
    );
    cancel!.click();
    await expect(pending).resolves.toBe(false);

    const pending2 = showOpenLinkConfirm(doc, 'https://example.com');
    const open = doc.body.query(
      (el) => el.tagName === 'BUTTON' && (el.textContent === '打开' || el.textContent === 'Open'),
    );
    open!.click();
    await expect(pending2).resolves.toBe(true);
  });
});

class HelpFakeEl {
  readonly tagName: string;
  textContent = '';
  className = '';
  children: HelpFakeEl[] = [];
  readonly classList = {
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };
  append(...kids: HelpFakeEl[]): void {
    this.children.push(...kids);
  }
  appendChild<T extends HelpFakeEl>(child: T): T {
    this.children.push(child);
    return child;
  }
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
}

function helpFakeDoc(): Document {
  return { createElement: (tag: string) => new HelpFakeEl(tag) } as unknown as Document;
}

describe('renderCheatsheet', () => {
  it('渲染绑定列表，每项含标签与快捷键', () => {
    const bindings: CheatBinding[] = [
      { label: '新建', shortcut: 'Ctrl+N' },
      { label: '保存', shortcut: 'Ctrl+S' },
    ];
    const list = renderCheatsheet(bindings, helpFakeDoc()) as unknown as HelpFakeEl;
    expect(list.tagName).toBe('UL');
    expect(list.classList.contains('lightink-cheatsheet')).toBe(true);
    expect(list.children).toHaveLength(2);
    const first = list.children[0];
    expect(first.children[0].textContent).toBe('新建');
    expect(first.children[1].textContent).toBe('Ctrl+N');
  });

  it('空绑定返回空列表', () => {
    const list = renderCheatsheet([], helpFakeDoc()) as unknown as HelpFakeEl;
    expect(list.children).toHaveLength(0);
  });

  it('renders immersive tab chrome / cycle bindings used by main SHORTCUT_LABELS', () => {
    const bindings: CheatBinding[] = [
      { label: '标签栏显隐', shortcut: 'Alt+T' },
      { label: '下一个标签', shortcut: 'Ctrl+Tab' },
      { label: '上一个标签', shortcut: 'Ctrl+Shift+Tab' },
    ];
    const list = renderCheatsheet(bindings, helpFakeDoc()) as unknown as HelpFakeEl;
    expect(list.children).toHaveLength(3);
    expect(list.children.map((li) => [li.children[0].textContent, li.children[1].textContent])).toEqual([
      ['标签栏显隐', 'Alt+T'],
      ['下一个标签', 'Ctrl+Tab'],
      ['上一个标签', 'Ctrl+Shift+Tab'],
    ]);
  });
});
