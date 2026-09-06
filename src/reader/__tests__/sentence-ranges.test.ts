// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  concatenatedText,
  findQuoteOffsets,
  firstOffsetInViewport,
  offsetAtPagedProgress,
  rangeFromOffsets,
  sentenceSpansFromRange,
  sentenceSpansFromRoot,
  sentenceStartOffset,
  splitSentenceSpans,
  visibleStartOffset,
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

  it('snaps a mid-sentence offset back to that sentence start', () => {
    const text = '第一话开始。第二话继续。第三话结束。';
    const second = text.indexOf('第二话');
    expect(sentenceStartOffset(text, second + 2)).toBe(second);
    expect(sentenceStartOffset(text, 0)).toBe(0);
  });

  it('keeps a mid-sentence paged start instead of walking back into the previous column', () => {
    const text = '上一栏还没说完就翻页当前栏。下一栏。';
    const visible = text.indexOf('当前栏');
    expect(splitSentenceSpans(text, visible).map((span) => span.text)).toEqual([
      '当前栏。',
      '下一栏。',
    ]);
    expect(sentenceStartOffset(text, visible)).toBe(0);
  });

  it('maps paged scrollLeft onto text without treating the last page as EOF', () => {
    expect(offsetAtPagedProgress(1000, { scrollLeft: 0, scrollWidth: 4000 })).toBe(0);
    expect(offsetAtPagedProgress(1000, { scrollLeft: 800, scrollWidth: 4000 })).toBe(200);
    expect(offsetAtPagedProgress(1000, { scrollLeft: 3200, scrollWidth: 4000 })).toBe(800);
    expect(offsetAtPagedProgress(0, { scrollLeft: 800, scrollWidth: 4000 })).toBe(0);
  });

  it('picks the leftmost in-view glyph, not the previous column', () => {
    const root = document.createElement('p');
    const source = '上一栏。当前栏。下一栏。';
    root.textContent = source;
    document.body.append(root);
    const current = source.indexOf('当前栏');
    const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: function getClientRects(this: Range) {
        const text = this.startContainer.nodeValue ?? '';
        const at = this.startOffset;
        const left = at >= text.indexOf('下一栏') ? 500 : at >= text.indexOf('当前栏') ? 220 : -180;
        return [
          { left, top: 8, width: 16, height: 16, right: left + 16, bottom: 24 },
        ] as unknown as DOMRectList;
      },
    });
    try {
      expect(firstOffsetInViewport(root, { left: 200, width: 240 })).toBe(current);
    } finally {
      if (original === undefined) {
        delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
      } else {
        Object.defineProperty(Range.prototype, 'getClientRects', original);
      }
    }
  });

  it('maps a visible caret to a text offset instead of the chapter start', () => {
    const root = document.createElement('p');
    const source = '第一话开始。第二话继续。第三话结束。';
    root.textContent = source;
    document.body.append(root);
    const second = source.indexOf('第二话');
    const caret = document.createRange();
    caret.setStart(root.firstChild!, second);
    caret.collapse(true);
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'caretRangeFromPoint');
    Object.defineProperty(Document.prototype, 'caretRangeFromPoint', {
      configurable: true,
      value: () => caret,
    });
    try {
      expect(visibleStartOffset(root)).toBe(second);
    } finally {
      if (original === undefined) {
        delete (Document.prototype as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
      } else {
        Object.defineProperty(Document.prototype, 'caretRangeFromPoint', original);
      }
    }
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
