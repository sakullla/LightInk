// @vitest-environment jsdom

/**
 * Dual-format copy: selection serializes to rendered HTML tags, not Markdown markers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { AllSelection, EditorState } from '@milkdown/prose/state';
import { EditorView } from '@milkdown/prose/view';

import { isLightInkClipboardHtml } from '../paste.js';
import {
  markdownClipboardData,
  selectionToClipboardHtml,
} from '../plugins/clipboard-md.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      toDOM: (node) => [`h${String(node.attrs['level'] as number)}`, 0],
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: { toDOM: () => ['strong', 0] },
  },
});

describe('selectionToClipboardHtml', () => {
  let view: EditorView | undefined;

  afterEach(() => {
    view?.destroy();
    view = undefined;
    document.body.replaceChildren();
  });

  it('emits heading/strong tags instead of markdown markers', () => {
    const heading = schema.nodes.heading!.create({ level: 1 }, schema.text('标题'));
    const para = schema.nodes.paragraph!.create(null, [
      schema.text('hello '),
      schema.text('粗', [schema.marks.strong!.create()]),
    ]);
    const doc = schema.nodes.doc!.create(null, [heading, para]);
    const state = EditorState.create({
      doc,
      schema,
      selection: new AllSelection(doc),
    });
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    view = new EditorView(mount, { state });

    const html = selectionToClipboardHtml(view);
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).not.toContain('# 标题');
    expect(html).not.toContain('**粗**');

    const payload = markdownClipboardData('# 标题\n\nhello **粗**', html);
    expect(payload['text/plain']).toBe('# 标题\n\nhello **粗**');
    expect(isLightInkClipboardHtml(payload['text/html'] ?? '')).toBe(true);
    expect(payload['text/html']).toContain('<h1>标题</h1>');
  });
});
