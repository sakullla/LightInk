// @vitest-environment jsdom

/**
 * ADR-1（单一排版源）挂载契约：mountEditor 后 ProseMirror 根元素必须携带
 * .lightink-prose 作用域类（经 editorViewOptionsCtx.attributes 注入，
 * 不影响既有 .ProseMirror 查询）。
 */

import { describe, expect, it } from 'vitest';

import { mountEditor } from '../index.js';

describe('ProseMirror 根元素携带 lightink-prose 作用域类', () => {
  it('mountEditor 后 .ProseMirror 元素具有 lightink-prose class', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editor = await mountEditor(host, { initialMarkdown: '# hello\n' });
    try {
      await editor.ready;
      const root = host.querySelector('.ProseMirror');
      expect(root).not.toBeNull();
      expect(root!.classList.contains('lightink-prose')).toBe(true);
    } finally {
      await editor.destroy();
      host.remove();
    }
  });
});
