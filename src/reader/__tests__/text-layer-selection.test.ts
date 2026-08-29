// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  annotationMarkFromEventTarget,
  captureSelectionAnchor,
  captureTextQuoteAnchor,
  markTextRange,
  removeTextRangeMarks,
  resolveTextQuoteOffsets,
  resolveTextQuoteRange,
} from '../annotation-locator.js';
import {
  bindTextLayerSelection,
  isEndOfContentNode,
  isModifyingSelectionStart,
  placeEndOfContent,
  usesLegacyEndOfContentPlacement,
} from '../text-layer-selection.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('bindTextLayerSelection', () => {
  it('inserts endOfContent and marks the layer selecting on mousedown', () => {
    const layer = document.createElement('div');
    layer.className = 'lightink-reader-text-layer';
    const span = document.createElement('span');
    span.textContent = 'abc';
    layer.appendChild(span);
    document.body.appendChild(layer);

    const unbind = bindTextLayerSelection(layer);
    const end = layer.querySelector('.endOfContent');
    expect(end).not.toBeNull();
    expect(isEndOfContentNode(end!)).toBe(true);

    layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(layer.classList.contains('selecting')).toBe(true);

    unbind();
    expect(layer.querySelector('.endOfContent')).toBeNull();
    expect(layer.classList.contains('selecting')).toBe(false);
  });

  it('places the filler after the end when extending right, before the start when extending left', () => {
    const layer = document.createElement('div');
    layer.className = 'lightink-reader-text-layer';
    const left = document.createElement('span');
    left.textContent = 'left';
    const right = document.createElement('span');
    right.textContent = 'right';
    layer.append(left, right);
    document.body.appendChild(layer);
    const end = document.createElement('div');
    end.className = 'endOfContent';
    layer.appendChild(end);

    const first = document.createRange();
    first.setStart(right.firstChild!, 2);
    first.setEnd(right.firstChild!, 5);
    placeEndOfContent(layer, end, first, null);
    expect(end.previousSibling).toBe(right);

    const rtl = document.createRange();
    rtl.setStart(left.firstChild!, 0);
    rtl.setEnd(right.firstChild!, 5);
    expect(isModifyingSelectionStart(first, rtl)).toBe(true);
    placeEndOfContent(layer, end, rtl, first);
    expect(end.nextSibling).toBe(left);
  });

  it('treats current WebView2 / unknown UA as modern (no live DOM move)', () => {
    expect(usesLegacyEndOfContentPlacement(null)).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'LightInk' })).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'Chrome/149.0.0.0' })).toBe(false);
    expect(usesLegacyEndOfContentPlacement({ userAgent: 'Chrome/120.0.0.0' })).toBe(true);
  });
});

describe('annotation text quote locators', () => {
  it('captures and resolves a range spanning multiple text nodes', () => {
    document.body.innerHTML = '<p>Alpha <strong>beta</strong> gamma</p>';
    const paragraph = document.querySelector('p')!;
    const first = paragraph.firstChild as Text;
    const last = paragraph.lastChild as Text;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 4);

    const anchor = captureTextQuoteAnchor(paragraph, range)!;
    expect(anchor.quote).toBe('pha beta gam');
    const resolved = resolveTextQuoteRange(paragraph, anchor)!;
    expect(resolved.toString()).toBe('pha beta gam');

    expect(markTextRange(paragraph, resolved, 'cross-node', 'note')).toBe(3);
    expect(paragraph.querySelectorAll('mark')).toHaveLength(3);
    expect(
      paragraph.querySelector('mark')?.getAttribute('data-annotation-kind'),
    ).toBe('note');
    expect(paragraph.querySelector('strong')).not.toBeNull();
    expect(paragraph.textContent).toBe('Alpha beta gamma');

    removeTextRangeMarks(paragraph, 'cross-node');
    expect(paragraph.querySelectorAll('mark')).toHaveLength(0);
    expect(resolveTextQuoteOffsets(paragraph.textContent ?? '', anchor)).toEqual({
      start: anchor.start,
      end: anchor.end,
    });
    expect(paragraph.textContent).toBe('Alpha beta gamma');
  });

  it('captures a cross-block quote from the text-node model so wrap still hits', () => {
    document.body.innerHTML = '<p>第一段文字</p><p>第二段文字</p>';
    const first = document.querySelector('p')!.firstChild as Text;
    const second = document.querySelectorAll('p')[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(second, 3);
    const anchor = captureTextQuoteAnchor(document.body, range)!;
    expect(anchor.quote.includes('\n')).toBe(false);
    expect(anchor.quote).toBe('段文字第二段');
    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(markTextRange(document.body, resolved, 'block-quote', 'highlight')).toBeGreaterThan(0);
    expect(
      [...document.body.querySelectorAll('mark.lightink-reader-highlight')]
        .map((mark) => mark.textContent)
        .join(''),
    ).toBe('段文字第二段');
  });

  it('uses the visible selection string when the Range only covers the first glyph', () => {
    document.body.innerHTML = '<p>按他们对症推测这个时候应该是少林寺屠狐大会</p>';
    const node = document.querySelector('p')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const selection = {
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => '按他们对症推测这个时候应该是少林寺屠狐大会',
    } as unknown as Selection;
    const anchor = captureSelectionAnchor(document.body, selection)!;
    expect(anchor.quote).toBe('按他们对症推测这个时候应该是少林寺屠狐大会');
    expect(anchor.end - anchor.start).toBe(anchor.quote.length);
    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(markTextRange(document.body, resolved, 'full-quote', 'highlight')).toBe(1);
    expect(document.querySelector('mark')?.textContent).toBe(
      '按他们对症推测这个时候应该是少林寺屠狐大会',
    );
  });

  it('uses prefix and suffix to choose between repeated quotes', () => {
    document.body.textContent = 'first target left; second target right';
    const anchor = {
      start: 0,
      end: 6,
      quote: 'target',
      prefix: 'second ',
      suffix: ' right',
    };

    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(resolved.toString()).toBe('target');
    expect(resolved.startOffset).toBe(26);
  });

  it('falls back to quote context after stored offsets shift', () => {
    document.body.textContent = 'before needle after';
    const text = document.body.firstChild as Text;
    const original = document.createRange();
    original.setStart(text, 7);
    original.setEnd(text, 13);
    const anchor = captureTextQuoteAnchor(document.body, original)!;

    text.nodeValue = `inserted ${text.nodeValue ?? ''}`;
    const resolved = resolveTextQuoteRange(document.body, anchor)!;
    expect(resolved.toString()).toBe('needle');
    expect(resolved.startOffset).toBe(16);
  });
});

describe('annotationMarkFromEventTarget', () => {
  it('resolves a mark from both the wrapper and its text node', () => {
    const mark = document.createElement('mark');
    mark.dataset.annotationId = 'n1';
    mark.dataset.annotationKind = 'note';
    mark.textContent = '找其他游戏来玩吧。';
    document.body.appendChild(mark);
    expect(annotationMarkFromEventTarget(mark)?.dataset.annotationId).toBe('n1');
    expect(annotationMarkFromEventTarget(mark.firstChild)?.dataset.annotationId).toBe('n1');
    expect(annotationMarkFromEventTarget(document.body)).toBeNull();
  });
});
