/**
 * context-menu 纯逻辑测试（R3）：按上下文决定菜单项 enabled。
 *
 * 不覆盖（需 DOM/挂载）：createContextMenu 的浮层渲染/定位/关闭 —— 属挂载态（仅断言工厂形态）。
 */
import { describe, expect, it } from 'vitest';

import {
  allowEditorContextMenu,
  buildEditorContextMenuItems,
  buildTabContextMenuItems,
  createContextMenu,
  type EditorMenuActions,
  type TabMenuActions,
} from '../context-menu.js';

const noopActions = (): EditorMenuActions => ({
  cut: () => undefined,
  copy: () => undefined,
  paste: () => undefined,
  pastePlain: () => undefined,
  selectAll: () => undefined,
  bold: () => undefined,
  italic: () => undefined,
  link: () => undefined,
  openLink: () => undefined,
  copyLinkAddress: () => undefined,
});

const noopTabActions = (): TabMenuActions => ({
  close: () => undefined,
  closeOthers: () => undefined,
  copyPath: () => undefined,
  revealInFiles: () => undefined,
});

function enabledMap(items: ReturnType<typeof buildEditorContextMenuItems>): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const item of items) {
    if (item.separator === true) continue;
    map[item.id] = item.enabled ? item.enabled() : true;
  }
  return map;
}

describe('buildEditorContextMenuItems (R3)', () => {
  it('disables cut/copy and format actions when there is no selection', () => {
    const m = enabledMap(buildEditorContextMenuItems({ hasSelection: false, hasLink: false }, noopActions()));
    expect(m['cut']).toBe(false);
    expect(m['copy']).toBe(false);
    expect(m['bold']).toBe(false);
    expect(m['italic']).toBe(false);
    expect(m['link']).toBe(false);
    // paste 始终可用
    expect(m['paste']).toBe(true);
    expect(m['paste-plain']).toBe(true);
    // T6/R10：全选始终可用（即使无选区）。
    expect(m['select-all']).toBe(true);
  });

  it('enables cut/copy/format when there is a selection', () => {
    const m = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: false }, noopActions()));
    expect(m['cut']).toBe(true);
    expect(m['copy']).toBe(true);
    expect(m['bold']).toBe(true);
    expect(m['italic']).toBe(true);
    expect(m['link']).toBe(true);
  });

  it('disables link open/copy when not on a link, enables when on a link', () => {
    const off = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: false }, noopActions()));
    expect(off['open-link']).toBe(false);
    expect(off['copy-link']).toBe(false);
    const on = enabledMap(buildEditorContextMenuItems({ hasSelection: true, hasLink: true }, noopActions()));
    expect(on['open-link']).toBe(true);
    expect(on['copy-link']).toBe(true);
  });

  it('includes separators between the clipboard / format / link groups', () => {
    const items = buildEditorContextMenuItems({ hasSelection: true, hasLink: true }, noopActions());
    const seps = items.filter((i) => i.separator === true);
    expect(seps.length).toBe(2);
  });

  it('returns only clipboard items in source mode (format/link act on the hidden WYSIWYG editor)', () => {
    const items = buildEditorContextMenuItems(
      { hasSelection: true, hasLink: true, inSourceMode: true },
      noopActions(),
    );
    expect(items.map((i) => i.id)).toEqual(['cut', 'copy', 'paste', 'paste-plain', 'select-all']);
    // 选区判定仍然生效。
    const noSel = enabledMap(
      buildEditorContextMenuItems({ hasSelection: false, hasLink: false, inSourceMode: true }, noopActions()),
    );
    expect(noSel['cut']).toBe(false);
    expect(noSel['copy']).toBe(false);
    expect(noSel['paste']).toBe(true);
    // 源码模式下全选同样可用（双模式 R10）。
    expect(noSel['select-all']).toBe(true);
  });
});

describe('buildTabContextMenuItems (R3)', () => {
  function tabEnabledMap(ctx: { hasFile: boolean }): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const item of buildTabContextMenuItems(ctx, noopTabActions())) {
      if (item.separator === true) continue;
      map[item.id] = item.enabled ? item.enabled() : true;
    }
    return map;
  }

  it('always enables close/close-others', () => {
    expect(tabEnabledMap({ hasFile: false })['close']).toBe(true);
    expect(tabEnabledMap({ hasFile: false })['close-others']).toBe(true);
    expect(tabEnabledMap({ hasFile: true })['close']).toBe(true);
  });

  it('disables copy-path/reveal for unsaved tabs (no file path)', () => {
    const m = tabEnabledMap({ hasFile: false });
    expect(m['copy-path']).toBe(false);
    expect(m['reveal']).toBe(false);
  });

  it('enables copy-path/reveal when a file path exists', () => {
    const m = tabEnabledMap({ hasFile: true });
    expect(m['copy-path']).toBe(true);
    expect(m['reveal']).toBe(true);
  });
});

describe('createContextMenu (factory shape)', () => {
  it('exposes the createContextMenu function', () => {
    expect(typeof createContextMenu).toBe('function');
  });
});

describe('createContextMenu onClose lifecycle', () => {
  class FakeEl {
    className = '';
    style: Record<string, string> = {};
    children: FakeEl[] = [];
    parent: FakeEl | null = null;
    disabled = false;
    type = '';
    textContent = '';
    private readonly listeners = new Map<string, Array<(e: { target?: unknown }) => void>>();

    constructor(readonly tagName: string) {}

    setAttribute(): void {
      /* no-op */
    }

    appendChild(child: FakeEl): FakeEl {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    append(...kids: FakeEl[]): void {
      for (const kid of kids) this.appendChild(kid);
    }

    remove(): void {
      if (this.parent !== null) {
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      }
    }

    contains(node: unknown): boolean {
      if (node === this) return true;
      return this.children.some((c) => c.contains(node));
    }

    getBoundingClientRect(): { right: number; bottom: number; width: number; height: number } {
      return { right: 10, bottom: 10, width: 10, height: 10 };
    }

    addEventListener(type: string, fn: (e: { target?: unknown }) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    fire(type: string, target?: unknown): void {
      for (const fn of this.listeners.get(type) ?? []) {
        fn({ target });
      }
    }
  }

  class FakeDoc {
    body = new FakeEl('body');
    private readonly listeners = new Map<string, Array<(e: { key?: string; target?: unknown }) => void>>();

    createElement(tag: string): FakeEl {
      return new FakeEl(tag);
    }

    addEventListener(
      type: string,
      fn: (e: { key?: string; target?: unknown }) => void,
      _capture?: boolean,
    ): void {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }

    removeEventListener(
      type: string,
      fn: (e: { key?: string; target?: unknown }) => void,
      _capture?: boolean,
    ): void {
      const list = this.listeners.get(type);
      if (list === undefined) return;
      this.listeners.set(
        type,
        list.filter((x) => x !== fn),
      );
    }

    fire(type: string, event: { key?: string; target?: unknown }): void {
      for (const fn of this.listeners.get(type) ?? []) {
        fn(event);
      }
    }
  }

  const originalWindow = (globalThis as { window?: unknown }).window;

  it('invokes onClose once when close() is called', () => {
    const doc = new FakeDoc();
    (globalThis as { window: { innerWidth: number; innerHeight: number } }).window = {
      innerWidth: 800,
      innerHeight: 600,
    };
    let closes = 0;
    const handle = createContextMenu(
      [{ id: 'x', label: 'X', action: () => undefined }],
      { x: 1, y: 1 },
      doc as unknown as Document,
      { onClose: () => {
        closes += 1;
      } },
    );
    handle.close();
    handle.close();
    expect(closes).toBe(1);
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
  });
});

describe('allowEditorContextMenu', () => {
  function fakeRoot(attrs: string[] = []): HTMLElement {
    const set = new Set(attrs);
    return {
      hasAttribute: (name: string) => set.has(name),
    } as HTMLElement;
  }

  it('keeps the desktop editor menu and hides it on phone chrome', () => {
    expect(allowEditorContextMenu(null)).toBe(true);
    expect(allowEditorContextMenu(fakeRoot())).toBe(true);
    expect(allowEditorContextMenu(fakeRoot(['data-android']))).toBe(false);
    expect(allowEditorContextMenu(fakeRoot(['data-touch-primary']))).toBe(false);
  });
});
