import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';

import {
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
} from '../../../reader/annotations.js';
import {
  collectPmText,
  decorationsForAnnotations,
  locatorFromPmSelection,
  pmOffsetAtPos,
  pmPosAtOffset,
} from '../markdown-annotations.js';
import { fnv1a64Hex, markdownAnnotationKey } from '../../../reader/document-hash.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
  },
});

function docFrom(text: string): EditorState {
  const paragraph = schema.node('paragraph', null, text === '' ? [] : [schema.text(text)]);
  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [paragraph]),
  });
}

describe('markdown annotation locators', () => {
  it('round-trips a selected quote through PM offsets', () => {
    const state = docFrom('Alpha beta gamma');
    const locator = locatorFromPmSelection(state.doc, 3, 8);
    expect(locator).toMatchObject({ format: 'text', quote: 'pha b' });
    const { text, spans } = collectPmText(state.doc);
    expect(text).toBe('Alpha beta gamma');
    expect(pmOffsetAtPos(spans, 1)).toBe(0);
    expect(pmPosAtOffset(spans, 0, true)).toBe(1);
  });

  it('builds highlight decorations for text locators', () => {
    const state = docFrom('Alpha beta gamma');
    const annotations: Annotation[] = [
      {
        id: 'h1',
        kind: 'highlight',
        locator: {
          format: 'text',
          start: 6,
          end: 10,
          quote: 'beta',
          prefix: 'Alpha ',
          suffix: ' gamm',
        },
        createdAt: 1,
      },
    ];
    const decorations = decorationsForAnnotations(state.doc, annotations);
    expect(decorations.find()).toHaveLength(1);
  });

  it('skips tombstoned records (deletedAt) when building decorations', () => {
    const state = docFrom('Alpha beta gamma');
    const live: Annotation = {
      id: 'live',
      kind: 'highlight',
      locator: {
        format: 'text',
        start: 0,
        end: 5,
        quote: 'Alpha',
        prefix: '',
        suffix: ' beta',
      },
      createdAt: 1,
    };
    const tombstoned: Annotation = {
      id: 'gone',
      kind: 'highlight',
      locator: {
        format: 'text',
        start: 6,
        end: 10,
        quote: 'beta',
        prefix: 'Alpha ',
        suffix: ' gamm',
      },
      createdAt: 1,
      updatedAt: 2,
      deletedAt: 2,
    };
    const decorations = decorationsForAnnotations(state.doc, [live, tombstoned]);
    const found = decorations.find();
    expect(found).toHaveLength(1);
    const attrs = (found[0]! as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    expect(attrs['data-annotation-id']).toBe('live');
  });

  it('consumes the shared v3 envelope (round-trip through parse/serialize)', () => {
    const state = docFrom('Alpha beta gamma');
    const annotation: Annotation = {
      id: 'h1',
      kind: 'highlight',
      locator: {
        format: 'text',
        start: 6,
        end: 10,
        quote: 'beta',
        prefix: 'Alpha ',
        suffix: ' gamm',
      },
      createdAt: 1,
    };
    const parsed = parseAnnotations(serializeAnnotations([annotation]));
    expect(parsed).toEqual([annotation]);
    expect(decorationsForAnnotations(state.doc, parsed).find()).toHaveLength(1);
  });
});

describe('markdownAnnotationKey', () => {
  it('hashes path keys with the Rust FNV-1a 64 algorithm', () => {
    expect(fnv1a64Hex('path:C:/notes/a.md')).toHaveLength(16);
    expect(markdownAnnotationKey('C:/notes/a.md', 'untitled-1')).not.toBe(
      markdownAnnotationKey(null, 'untitled-1'),
    );
  });
});
