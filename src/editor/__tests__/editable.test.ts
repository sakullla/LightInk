// @vitest-environment jsdom

/**
 * EditorInstance.setEditable: reading false / editing true.
 * Read-only does not change markdown via document commands.
 */

import { describe, expect, it } from 'vitest';

import { mountEditor } from '../index.js';

describe('EditorInstance.setEditable', () => {
  async function mount(initialMarkdown: string, editable?: boolean) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = await mountEditor(host, { initialMarkdown, editable });
    await editor.ready;
    return { host, editor };
  }

  it('defaults to contenteditable true and can switch to false', async () => {
    const { host, editor } = await mount('hello\n');
    try {
      const root = host.querySelector('.ProseMirror');
      expect(root).not.toBeNull();
      expect(root!.getAttribute('contenteditable')).toBe('true');
      expect(editor.isEditable()).toBe(true);

      editor.setEditable(false);
      expect(editor.isEditable()).toBe(false);
      expect(root!.getAttribute('contenteditable')).toBe('false');
      expect(editor.getSelection()).not.toBeNull();

      editor.setEditable(true);
      expect(editor.isEditable()).toBe(true);
      expect(root!.getAttribute('contenteditable')).toBe('true');
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('honors MountOptions.editable false on first paint', async () => {
    const { host, editor } = await mount('# title\n', false);
    try {
      const root = host.querySelector('.ProseMirror');
      expect(root!.getAttribute('contenteditable')).toBe('false');
      expect(editor.isEditable()).toBe(false);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });

  it('makes document commands a no-op while read-only', async () => {
    const { host, editor } = await mount('hello\n');
    try {
      const original = editor.getMarkdown();
      editor.setEditable(false);
      editor.toggleMark('strong');
      editor.setLink('https://example.com');
      editor.insertImage('assets/a.png', 'a');
      editor.undo();
      editor.redo();
      expect(editor.insertMarkdown('extra')).toBe(false);
      expect(editor.getMarkdown()).toBe(original);

      editor.setEditable(true);
      expect(editor.insertMarkdown('extra')).toBe(true);
      expect(editor.getMarkdown()).not.toBe(original);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });
});
