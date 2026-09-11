// @vitest-environment jsdom

/**
 * Keyboard format bar live commands: visibility + wrap/cycle/marks.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { mountEditor } from '../index.js';

beforeAll(() => {
  const rect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      top: 0,
      right: 1,
      bottom: 1,
      left: 0,
      toJSON() {
        return this;
      },
    }) as DOMRect;
  const rects = (): DOMRectList =>
    Object.assign([rect()], {
      item(index: number) {
        return index === 0 ? rect() : null;
      },
    }) as unknown as DOMRectList;
  for (const proto of [Element.prototype, Range.prototype, Text.prototype]) {
    const target = proto as {
      getClientRects?: () => DOMRectList;
      getBoundingClientRect?: () => DOMRect;
    };
    if (typeof target.getClientRects !== 'function') {
      target.getClientRects = rects;
    }
    if (typeof target.getBoundingClientRect !== 'function') {
      target.getBoundingClientRect = rect;
    }
  }
});

async function mountLive(initialMarkdown: string, editable = true) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = await mountEditor(host, { initialMarkdown, editable });
  await editor.ready;
  return { host, editor };
}

function setImmersiveTouch(on: boolean): void {
  const root = document.documentElement;
  if (on) {
    root.setAttribute('data-workspace-mode', 'reader');
    root.setAttribute('data-android', '');
  } else {
    root.removeAttribute('data-workspace-mode');
    root.removeAttribute('data-android');
    root.removeAttribute('data-touch-primary');
  }
}

function barOf(host: HTMLElement): HTMLElement {
  const bar = host.querySelector('.lightink-keyboard-format-bar');
  if (!(bar instanceof HTMLElement)) {
    throw new Error('keyboard format bar missing');
  }
  return bar;
}

function clickTool(host: HTMLElement, id: string): void {
  const btn = barOf(host).querySelector(`button[data-tool="${id}"]`);
  if (!(btn instanceof HTMLButtonElement)) {
    throw new Error(`missing tool ${id}`);
  }
  btn.click();
}

afterEach(() => {
  setImmersiveTouch(false);
});

describe('keyboard format bar visibility', () => {
  it('shows in immersive edit and hides while read-only', async () => {
    setImmersiveTouch(true);
    const { host, editor } = await mountLive('hello\n', false);
    try {
      expect(barOf(host).classList.contains('is-visible')).toBe(false);
      editor.setEditable(true);
      expect(barOf(host).classList.contains('is-visible')).toBe(true);
      const ids = [...barOf(host).querySelectorAll('button[data-tool]')].map(
        (btn) => (btn as HTMLButtonElement).dataset['tool'],
      );
      expect(ids).not.toContain('table');
      expect(ids).not.toContain('formula');
      expect(ids).not.toContain('flowchart');
      editor.setEditable(false);
      expect(barOf(host).classList.contains('is-visible')).toBe(false);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('stays hidden on desktop editor workspace', async () => {
    document.documentElement.setAttribute('data-workspace-mode', 'editor');
    const { host, editor } = await mountLive('hello\n', true);
    try {
      expect(barOf(host).classList.contains('is-visible')).toBe(false);
    } finally {
      await editor.destroy();
      host.remove();
      document.documentElement.removeAttribute('data-workspace-mode');
    }
  });
});

describe('keyboard format bar commands', () => {
  it('toggles bold on the current selection', async () => {
    setImmersiveTouch(true);
    const { host, editor } = await mountLive('hello\n');
    try {
      editor.selectAll();
      clickTool(host, 'bold');
      expect(editor.getMarkdown()).toMatch(/\*\*hello\*\*/);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('cycles the current block paragraph ↔ H1–H3 without leftover hashes', async () => {
    setImmersiveTouch(true);
    const { host, editor } = await mountLive('# Title\n');
    try {
      clickTool(host, 'heading');
      expect(editor.getMarkdown()).toMatch(/^## Title/m);
      clickTool(host, 'heading');
      expect(editor.getMarkdown()).toMatch(/^### Title/m);
      clickTool(host, 'heading');
      expect(editor.getMarkdown()).not.toMatch(/^#{1,6}\s/m);
      expect(editor.getMarkdown()).toContain('Title');
      clickTool(host, 'heading');
      expect(editor.getMarkdown()).toMatch(/^# Title/m);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('wraps the current block as list, task, quote, or code', async () => {
    setImmersiveTouch(true);
    const { host, editor } = await mountLive('hello\n');
    try {
      clickTool(host, 'list');
      expect(editor.getMarkdown()).toMatch(/^[-*]\s+hello/m);
      clickTool(host, 'undo');
      expect(editor.getMarkdown()).toMatch(/^hello/m);

      clickTool(host, 'task-list');
      expect(editor.getMarkdown()).toMatch(/\[ \]/);
      clickTool(host, 'undo');

      clickTool(host, 'blockquote');
      expect(editor.getMarkdown()).toMatch(/^>\s*hello/m);
      clickTool(host, 'undo');

      clickTool(host, 'code-block');
      expect(editor.getMarkdown()).toMatch(/```[\s\S]*hello[\s\S]*```/);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });
});
