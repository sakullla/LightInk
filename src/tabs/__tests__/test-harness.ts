/**
 * 共享测试 harness：autosave.test.ts 与 tab-manager.test.ts 复用的假编辑器/宿主
 * 工厂（R7 去重）。
 */

import { vi } from 'vitest';

import type { EditorInstance } from '../../editor/types.js';

export function makeFakeEditor(initial: string): EditorInstance & { content: string } {
  const state = { content: initial };
  return {
    ready: Promise.resolve(),
    get content() {
      return state.content;
    },
    setMarkdown(md: string) {
      state.content = md;
    },
    getMarkdown() {
      return state.content;
    },
    getSelection: () => null,
    getCursorPosition: () => null,
    getLinkAtCursor: () => null,
    getLinkAtPoint: () => null,
    toggleMark: () => undefined,
    setLink: () => undefined,
    insertImage: () => undefined,
    insertMarkdown: () => false,
    isInTable: () => false,
    runTableOp: () => false,
    focus: vi.fn(),
    setEditable: vi.fn(),
    isEditable: () => true,
    selectAll: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    toggleFoldAtOrdinal: vi.fn(),
    getFoldedOrdinals: vi.fn(() => []),
    destroy: vi.fn(async () => undefined),
  };
}

export function fakeHost(): HTMLElement {
  return { style: { display: '' } } as unknown as HTMLElement;
}
