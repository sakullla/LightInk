// @vitest-environment jsdom

/**
 * Keyboard format bar (R2): catalog, visibility, composing guard, CSS.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AllSelection, EditorState, TextSelection } from '@milkdown/prose/state';
import { Schema } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldShowFormatToolbar } from '../format-toolbar.js';
import {
  applyKeyboardFormatCommand,
  KEYBOARD_FORMAT_TOOLS,
  keyboardFormatBarPlugin,
  nextHeadingCycle,
  shouldShowKeyboardFormatBar,
} from '../keyboard-format-bar.js';

const themeCss = readFileSync(resolve('src/ui/theme.css'), 'utf-8');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: {
      content: 'text*',
      group: 'block',
      attrs: { level: { default: 1 } },
    },
    text: { inline: true },
  },
});

function viewOf(
  state: EditorState,
  options: { focused?: boolean; editable?: boolean; composing?: boolean } = {},
): EditorView {
  return {
    hasFocus: () => options.focused !== false,
    state,
    editable: options.editable !== false,
    composing: options.composing === true,
  } as EditorView;
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

afterEach(() => {
  setImmersiveTouch(false);
});

describe('KEYBOARD_FORMAT_TOOLS catalog (R2)', () => {
  it('covers inline, heading cycle, blocks, image, undo/redo and excludes table/formula/mermaid', () => {
    expect(KEYBOARD_FORMAT_TOOLS.map((tool) => tool.id)).toEqual([
      'bold',
      'italic',
      'strikethrough',
      'code',
      'link',
      'heading',
      'list',
      'task-list',
      'blockquote',
      'code-block',
      'image',
      'undo',
      'redo',
    ]);
    const ids = KEYBOARD_FORMAT_TOOLS.map((tool) => tool.id);
    expect(ids).not.toContain('table');
    expect(ids).not.toContain('formula');
    expect(ids).not.toContain('flowchart');
    expect(ids).not.toContain('mermaid');
  });
});

describe('nextHeadingCycle', () => {
  it('cycles paragraph → H1 → H2 → H3 → paragraph', () => {
    expect(nextHeadingCycle('paragraph', undefined)).toEqual({ type: 'heading', level: 1 });
    expect(nextHeadingCycle('heading', 1)).toEqual({ type: 'heading', level: 2 });
    expect(nextHeadingCycle('heading', 2)).toEqual({ type: 'heading', level: 3 });
    expect(nextHeadingCycle('heading', 3)).toEqual({ type: 'paragraph' });
    expect(nextHeadingCycle('heading', 6)).toEqual({ type: 'paragraph' });
  });
});

describe('shouldShowKeyboardFormatBar', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1, 1),
  });

  it('shows only for immersive touch Markdown while editable', () => {
    expect(shouldShowKeyboardFormatBar(viewOf(state, { editable: true }))).toBe(false);
    setImmersiveTouch(true);
    expect(shouldShowKeyboardFormatBar(viewOf(state, { editable: true }))).toBe(true);
    expect(shouldShowKeyboardFormatBar(viewOf(state, { editable: false }))).toBe(false);
  });
});

describe('shouldShowFormatToolbar during immersive edit', () => {
  it('does not use the desktop selection bar as the edit entry', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
    const selected = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 6),
    });
    const all = EditorState.create({
      schema,
      doc,
      selection: new AllSelection(doc),
    });
    expect(shouldShowFormatToolbar(viewOf(selected, { focused: true, editable: true }))).toBe(true);
    setImmersiveTouch(true);
    expect(shouldShowFormatToolbar(viewOf(selected, { focused: true, editable: true }))).toBe(false);
    expect(shouldShowFormatToolbar(viewOf(all, { focused: true, editable: true }))).toBe(false);
    expect(shouldShowFormatToolbar(viewOf(selected, { focused: true, editable: false }))).toBe(true);
  });
});

describe('applyKeyboardFormatCommand composing guard', () => {
  it('does not dispatch while composing', () => {
    const dispatch = vi.fn();
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello')])]);
    const view = {
      composing: true,
      editable: true,
      dispatch,
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, 1, 6),
      }),
    } as unknown as EditorView;
    expect(applyKeyboardFormatCommand(view, 'bold')).toBe(false);
    expect(applyKeyboardFormatCommand(view, 'heading')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('keyboard format bar CSS (R2)', () => {
  it('pins the bar above the keyboard with 44px touch targets', () => {
    expect(themeCss).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\)\[data-workspace-mode='reader'\]\s*\.lightink-keyboard-format-bar\.is-visible\s*\{[^}]*bottom:\s*var\(--lightink-keyboard-inset,\s*0px\)/,
    );
    expect(themeCss).toMatch(
      /\.lightink-keyboard-format-bar__btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
    );
  });
});

describe('keyboardFormatBarPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(keyboardFormatBarPlugin).toBeDefined();
    expect(typeof keyboardFormatBarPlugin).toBe('function');
    const shaped = keyboardFormatBarPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    expect(shaped.plugin()).toBeUndefined();
  });
});
