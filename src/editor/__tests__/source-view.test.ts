import { describe, expect, it } from 'vitest';

import {
  indentSourceSelection,
  SourceModeController,
  toggleMode,
  toggleSourceWrap,
  type SourceRangePatch,
} from '../source-view.js';

function applyPatch(text: string, patch: SourceRangePatch): string {
  return (
    text.slice(0, patch.replaceFrom) +
    patch.replacement +
    text.slice(patch.replaceTo)
  );
}

describe('SourceModeController', () => {
  it('round-trips snapshot between wysiwyg and source mode', () => {
    let doc = '# Title\n\nBody';
    const ctrl = new SourceModeController({
      getMarkdown: () => doc,
      setMarkdown: (next) => {
        doc = next;
      },
    });
    expect(ctrl.currentMode).toBe('wysiwyg');
    expect(toggleMode(ctrl.currentMode)).toBe('source');
    expect(ctrl.enterSource()).toBe('# Title\n\nBody');
    expect(ctrl.isSourceMode()).toBe(true);
    ctrl.syncSource('# Title\n\nEdited');
    expect(doc).toBe('# Title\n\nEdited');
    ctrl.exitSource('# Title\n\nFinal');
    expect(ctrl.isSourceMode()).toBe(false);
    expect(doc).toBe('# Title\n\nFinal');
  });
});

describe('indentSourceSelection (Tab / Shift+Tab in source mode)', () => {
  it('inserts 2 spaces at a collapsed caret on Tab', () => {
    const patch = indentSourceSelection('- item', 2, 2, false);
    expect(patch).not.toBeNull();
    expect(applyPatch('- item', patch!)).toBe('-   item');
    expect(patch!.selectionStart).toBe(4);
    expect(patch!.selectionEnd).toBe(4);
  });

  it('indents all selected lines and ignores a trailing newline boundary', () => {
    const src = '- one\n- two\n- three';
    // Select `- one\n- two\n` (ending at index 12, start of `- three`)
    const patch = indentSourceSelection(src, 0, 12, false);
    expect(patch).not.toBeNull();
    expect(applyPatch(src, patch!)).toBe('  - one\n  - two\n- three');
  });

  it('outdents up to 2 leading spaces per line on Shift+Tab', () => {
    const src = '  - one\n - two\n\t- three';
    const patch = indentSourceSelection(src, 0, src.length, true);
    expect(patch).not.toBeNull();
    expect(applyPatch(src, patch!)).toBe('- one\n- two\n- three');
  });

  it('returns null when outdenting unindented lines', () => {
    expect(indentSourceSelection('plain line', 3, 3, true)).toBeNull();
  });
});

describe('toggleSourceWrap (Ctrl+B / Ctrl+I / Ctrl+` in source mode)', () => {
  it('wraps selected text and keeps inner text selected', () => {
    const src = 'hello world';
    const patch = toggleSourceWrap(src, 6, 11, '**');
    const next = applyPatch(src, patch);
    expect(next).toBe('hello **world**');
    expect(next.slice(patch.selectionStart, patch.selectionEnd)).toBe('world');
  });

  it('unwraps when markers immediately surround the selection', () => {
    const src = 'hello **world**';
    const patch = toggleSourceWrap(src, 8, 13, '**');
    const next = applyPatch(src, patch);
    expect(next).toBe('hello world');
    expect(next.slice(patch.selectionStart, patch.selectionEnd)).toBe('world');
  });

  it('unwraps when the selection includes surrounding markers', () => {
    const src = 'hello `code`';
    const patch = toggleSourceWrap(src, 6, 12, '`');
    const next = applyPatch(src, patch);
    expect(next).toBe('hello code');
    expect(next.slice(patch.selectionStart, patch.selectionEnd)).toBe('code');
  });

  it('adds italic inside bold without stripping outer bold markers', () => {
    const src = '**bold**';
    const patch = toggleSourceWrap(src, 2, 6, '*');
    const next = applyPatch(src, patch);
    expect(next).toBe('***bold***');
  });

  it('inserts paired markers with centered caret when selection is empty', () => {
    const patch = toggleSourceWrap('abc', 3, 3, '**');
    expect(applyPatch('abc', patch)).toBe('abc****');
    expect(patch.selectionStart).toBe(5);
    expect(patch.selectionEnd).toBe(5);
  });
});
