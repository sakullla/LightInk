// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  concatenatedText,
  findQuoteOffsets,
  rangeFromOffsets,
  sentenceSpansFromRange,
  sentenceSpansFromRoot,
  splitSentenceSpans,
} from '../sentence-ranges.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('splitSentenceSpans', () => {
  it('splits on CJK and ASCII sentence punctuation like search snippets', () => {
    const spans = splitSentenceSpans('你好。世界！Next one. And more?');
    expect(spans.map((span) => span.text)).toEqual(['你好。', '世界！', 'Next one.', ' And more?']);
  });

  it('starts from a mid-document offset without emitting empty spans', () => {
    const text = 'First. Second. Third.';
    const spans = splitSentenceSpans(text, 'First. '.length);
    expect(spans.map((span) => span.text)).toEqual(['Second.', ' Third.']);
  });

  it('limits to a selected slice so toolbar speak stays inside the selection', () => {
    const text = 'Alpha. Bravo. Charlie.';
    const start = text.indexOf('Bravo');
    const end = start + 'Bravo.'.length;
    expect(splitSentenceSpans(text, start, end).map((span) => span.text)).toEqual(['Bravo.']);
  });
});

describe('sentenceRanges from DOM', () => {
  it('maps concatenated offsets onto live Ranges, not Annotation records', () => {
    const root = document.createElement('p');
    root.append('Hello. ', document.createElement('em'), 'World!');
    root.querySelector('em')!.textContent = 'there. ';
    document.body.append(root);

    expect(concatenatedText(root)).toBe('Hello. there. World!');
    const spans = sentenceSpansFromRoot(root);
    expect(spans.map((span) => span.text.trim())).toEqual(['Hello.', 'there.', 'World!']);
    expect(spans.every((span) => !('id' in span) && !('kind' in span))).toBe(true);

    const range = rangeFromOffsets(root, spans[1]!.start, spans[1]!.end);
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe(' there.');
    expect(root.querySelector('[data-annotation-id]')).toBeNull();
  });

  it('builds sentence spans from a selection Range', () => {
    const root = document.createElement('div');
    root.textContent = 'One. Two. Three.';
    document.body.append(root);
    const range = document.createRange();
    range.setStart(root.firstChild!, 5);
    range.setEnd(root.firstChild!, 9);
    expect(sentenceSpansFromRange(root, range).map((span) => span.text.trim())).toEqual(['Two.']);
  });

  it('finds a quote inside concatenated text', () => {
    const root = document.createElement('p');
    root.textContent = 'Prefix kept. Speak this sentence. Tail.';
    document.body.append(root);
    const hit = findQuoteOffsets(root, 'Speak this sentence.');
    expect(hit).toEqual({ start: 13, end: 33 });
    expect(sentenceSpansFromRoot(root, hit!.start, hit!.end).map((span) => span.text)).toEqual([
      'Speak this sentence.',
    ]);
  });
});
