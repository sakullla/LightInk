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
import { bindTextLayerSelection } from '../text-layer-selection.js';

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * 官方文本层夹具（T4）：`.pdfViewer > .page[data-page-number] > .textLayer`，
 * 官方 TextLayerBuilder.render() 已在层末追加 `.endOfContent`（组件层自带，
 * 本护栏不再注入）。
 */
function officialTextLayer(
  pageNumber: number,
  ...texts: string[]
): { layer: HTMLElement; end: HTMLElement } {
  const viewer = document.createElement('div');
  viewer.className = 'pdfViewer';
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = String(pageNumber);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  for (const text of texts) {
    const span = document.createElement('span');
    span.textContent = text;
    layer.appendChild(span);
  }
  const end = document.createElement('div');
  end.className = 'endOfContent';
  layer.appendChild(end);
  page.appendChild(layer);
  viewer.appendChild(page);
  document.body.appendChild(viewer);
  return { layer, end };
}

describe('bindTextLayerSelection（官方 .textLayer 结构）', () => {
  it('复用官方 endOfContent：不注入新元素，mousedown 置 selecting，卸载复位且不移除官方元素', () => {
    const { layer, end } = officialTextLayer(1, 'abc');

    const unbind = bindTextLayerSelection(layer);
    // 官方 render() 已追加的 endOfContent 是唯一一个：护栏不再自建。
    expect(layer.querySelectorAll('.endOfContent')).toHaveLength(1);
    expect(layer.querySelector('.endOfContent')).toBe(end);

    layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(layer.classList.contains('selecting')).toBe(true);

    unbind();
    expect(layer.classList.contains('selecting')).toBe(false);
    // 卸载只摘应用侧护栏；官方元素归组件层生命周期所有，不被移除。
    expect(layer.querySelector('.endOfContent')).toBe(end);
  });

  it('同一层重复绑定幂等：缩放重渲染再发 textlayerrendered 复用同一卸载函数', () => {
    const { layer } = officialTextLayer(2, 'abc');
    const first = bindTextLayerSelection(layer);
    const second = bindTextLayerSelection(layer);
    expect(second).toBe(first);
    first();
    expect(layer.classList.contains('selecting')).toBe(false);
    // 已卸载后重复调用旧句柄无害。
    expect(() => second()).not.toThrow();
  });

  it('detached 层修剪（T3 接手点）：层脱离文档后经 selectionchange 解绑，重挂不再响应', () => {
    const { layer } = officialTextLayer(1, 'abc');
    bindTextLayerSelection(layer);
    expect(layer.classList.contains('selecting')).toBe(false);

    // 官方 PDFPageViewBuffer 回收页：层根随宿主脱离文档。
    const viewer = layer.closest('.pdfViewer')!;
    viewer.remove();

    // 任意 selectionchange（包括空选区）先修剪注册表，再遍历剩余层。
    document.dispatchEvent(new Event('selectionchange'));

    // 层被重新挂回也不会复活旧绑定（页面重渲染时经 textlayerrendered 重绑）。
    document.body.appendChild(viewer);
    layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(layer.classList.contains('selecting')).toBe(false);
  });

  it('selectionchange 对相交层置 selecting、其余层复位', () => {
    const inSelection = officialTextLayer(1, '选中文字');
    const outside = officialTextLayer(2, '别的页');
    bindTextLayerSelection(inSelection.layer);
    bindTextLayerSelection(outside.layer);

    const range = document.createRange();
    range.selectNodeContents(inSelection.layer.querySelector('span')!.firstChild!);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    outside.layer.classList.add('selecting'); // 模拟上一次拖选遗留
    document.dispatchEvent(new Event('selectionchange'));
    expect(inSelection.layer.classList.contains('selecting')).toBe(true);
    expect(outside.layer.classList.contains('selecting')).toBe(false);

    selection?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(inSelection.layer.classList.contains('selecting')).toBe(false);
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
