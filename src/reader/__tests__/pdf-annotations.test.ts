// @vitest-environment jsdom

/**
 * PDF 文字级标注（T5 / R3+R5）测试：文本层 DOM 上 capture→locator→持久化往返→
 * resolve→mark→remove 闭环；旧页码级数据（无 anchor）兼容。
 */
import { describe, expect, it } from 'vitest';

import {
  pdfTextLocatorFromRange,
  markTextRange,
  removeTextRangeMarks,
  resolveTextQuoteRange,
} from '../annotation-locator.js';
import {
  annotationMarkSpec,
  paintAnnotationOverlays,
  renderAnnotationMarks,
  removeAnnotationMarks,
  visibleHighlightOverlayBoxes,
  type AnnotationMarkSpec,
} from '../annotation-render.js';
import {
  DEFAULT_ANNOTATION_COLOR,
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
} from '../annotations.js';
import { isTextLayerMutation, pdfTextLayerSelector } from '../reader-view.js';

/**
 * 模拟官方 pdfjs 文本层（T4 结构）：
 * `.pdfViewer > .page[data-page-number] > .textLayer`，绝对定位 span 承载
 * 每段文字（官方 TextLayerBuilder 输出），层末自带 `.endOfContent`。
 */
function textLayer(...texts: string[]): HTMLElement {
  const viewer = document.createElement('div');
  viewer.className = 'pdfViewer';
  const page = document.createElement('div');
  page.className = 'page';
  page.dataset.pageNumber = '1';
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
  return layer;
}

function rangeBetween(root: Node, start: number, end: number): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    textNodes.push(node as Text);
  }
  const locate = (target: number): { node: Text; offset: number } => {
    let offset = 0;
    for (const node of textNodes) {
      const length = node.nodeValue?.length ?? 0;
      if (target <= offset + length) {
        return { node, offset: target - offset };
      }
      offset += length;
    }
    const last = textNodes[textNodes.length - 1]!;
    return { node: last, offset: last.nodeValue?.length ?? 0 };
  };
  const from = locate(start);
  const to = locate(end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

describe('PDF 文字级标注闭环', () => {
  it('文本层选区生成含 anchor 的 PdfLocator 并往返持久化', () => {
    const layer = textLayer('第一章 开端', '正文内容甲', '正文内容乙');
    const range = rangeBetween(layer, 6, 11); // 跨 span 选“正文内容甲”
    const locator = pdfTextLocatorFromRange(layer, range, 3);
    expect(locator).not.toBeNull();
    expect(locator!).toMatchObject({ format: 'pdf', page: 3, quote: '正文内容甲' });
    expect(locator!.anchor).toMatchObject({
      start: 6,
      end: 11,
      quote: '正文内容甲',
      prefix: '第一章 开端',
      suffix: '正文内容乙'.slice(0, 32),
    });

    const annotation: Annotation = {
      id: 'p1',
      kind: 'highlight',
      locator: locator!,
      quote: '正文内容甲',
      createdAt: 1,
    };
    const back = parseAnnotations(serializeAnnotations([annotation]));
    expect(back).toEqual([annotation]);
  });

  it('重开文档后 anchor 在文本层模糊重定位并渲染 mark，移除后清理', () => {
    const layer = textLayer('第一章 开端', '正文内容甲', '正文内容乙');
    const range = rangeBetween(layer, 6, 11);
    const locator = pdfTextLocatorFromRange(layer, range, 1)!;
    // 模拟重开：mark 渲染前文本层 span 被重建（加空格扰动前缀长度）。
    layer.remove();
    const rebuilt = textLayer('第一章 开端 ', '正文内容甲', '正文内容乙');
    const resolved = resolveTextQuoteRange(rebuilt, locator.anchor!);
    expect(resolved).not.toBeNull();
    expect(resolved!.toString()).toBe('正文内容甲');
    const marks = markTextRange(rebuilt, resolved!, 'p1', 'note');
    expect(marks).toBeGreaterThan(0);
    const marked = rebuilt.querySelector(
      'mark.lightink-reader-highlight[data-annotation-id="p1"]',
    );
    expect(marked).not.toBeNull();
    expect(marked?.getAttribute('data-annotation-kind')).toBe('note');

    removeTextRangeMarks(rebuilt, 'p1');
    expect(
      rebuilt.querySelector('mark.lightink-reader-highlight[data-annotation-id="p1"]'),
    ).toBeNull();
    expect(rebuilt.textContent).toBe('第一章 开端 正文内容甲正文内容乙');
  });

  it('共享幂等引擎：重放不重复嵌套包裹，移除后文本还原（PDF 层 / 流式正文同引擎）', () => {
    const layer = textLayer('第一章 开端', '正文内容甲', '正文内容乙');
    const spec: AnnotationMarkSpec = {
      id: 'p1',
      kind: 'highlight',
      anchor: {
        start: 6,
        end: 11,
        quote: '正文内容甲',
        prefix: '第一章 开端',
        suffix: '正文内容乙',
      },
    };
    renderAnnotationMarks(layer, [spec]);
    const count = layer.querySelectorAll('mark[data-annotation-id="p1"]').length;
    expect(count).toBeGreaterThan(0);

    // 幂等重放：已存在的 mark 跳过，不嵌套、不重复。
    renderAnnotationMarks(layer, [spec]);
    expect(layer.querySelectorAll('mark[data-annotation-id="p1"]').length).toBe(count);
    expect(layer.querySelector('mark mark')).toBeNull();

    // anchor 无法定位（文本已变）时跳过，不产生 collapsed mark。
    renderAnnotationMarks(layer, [
      { id: 'p2', kind: 'note', anchor: { start: 0, end: 4, quote: '不存在', prefix: '', suffix: '' } },
    ]);
    expect(layer.querySelector('mark[data-annotation-id="p2"]')).toBeNull();

    removeAnnotationMarks(layer, 'p1');
    expect(layer.querySelector('mark[data-annotation-id="p1"]')).toBeNull();
    expect(layer.textContent).toBe('第一章 开端正文内容甲正文内容乙');
  });

  it('书内 mark 带上标注已存颜色，缺省仍落默认黄', () => {
    const layer = textLayer('第一章 开端', '正文内容甲', '正文内容乙');
    const anchor = {
      start: 6,
      end: 11,
      quote: '正文内容甲',
      prefix: '第一章 开端',
      suffix: '正文内容乙',
    };
    const colored = annotationMarkSpec(
      { id: 'green', kind: 'highlight', color: '#86c28b' },
      anchor,
    );
    expect(colored.color).toBe('#86c28b');
    renderAnnotationMarks(layer, [colored]);
    const mark = layer.querySelector<HTMLElement>('mark[data-annotation-id="green"]');
    expect(mark?.dataset.annotationColor).toBe('#86c28b');
    expect(mark?.style.getPropertyValue('--lightink-annotation-color')).toBe('#86c28b');

    const fallback = annotationMarkSpec({ id: 'plain', kind: 'highlight' }, {
      start: 0,
      end: 3,
      quote: '第一章',
      prefix: '',
      suffix: ' 开端正文内容甲正文内容乙',
    });
    expect(fallback.color).toBeUndefined();
    renderAnnotationMarks(layer, [fallback]);
    const plain = layer.querySelector<HTMLElement>('mark[data-annotation-id="plain"]');
    expect(plain?.dataset.annotationColor).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it('官方 .textLayer 宿主取半透明 color-mix；旧类名层不再被识别为 PDF 文本层宿主', () => {
    const anchor = {
      start: 0,
      end: 3,
      quote: '第一章',
      prefix: '',
      suffix: '',
    };
    // 官方结构内的层：半透明 color-mix 叠在 canvas 字形上。
    const official = textLayer('第一章 开端');
    renderAnnotationMarks(official, [{ id: 'mix', kind: 'highlight', color: '#86c28b', anchor }]);
    const mixMark = official.querySelector<HTMLElement>('mark[data-annotation-id="mix"]');
    expect(mixMark?.style.background).toContain('color-mix(in srgb, rgb(134, 194, 139) 32%, transparent)');

    // 反例（Recipe outcome 3）：旧类名层视为非 PDF 文本层宿主（同流式正文），用不透明色。
    const legacy = document.createElement('div');
    legacy.className = 'lightink-reader-text-layer';
    const span = document.createElement('span');
    span.textContent = '第一章 开端';
    legacy.appendChild(span);
    document.body.appendChild(legacy);
    renderAnnotationMarks(legacy, [{ id: 'opaque', kind: 'highlight', color: '#86c28b', anchor }]);
    const opaqueMark = legacy.querySelector<HTMLElement>('mark[data-annotation-id="opaque"]');
    expect(opaqueMark?.style.background).toBe('rgb(134, 194, 139)');

    // .textLayer 但不在 .pdfViewer 内（防误伤 flow 内容的限定）同样按非层宿主处理。
    const orphan = document.createElement('div');
    orphan.className = 'textLayer';
    orphan.appendChild(span.cloneNode(true));
    document.body.appendChild(orphan);
    renderAnnotationMarks(orphan, [{ id: 'orphan', kind: 'highlight', color: '#86c28b', anchor }]);
    const orphanMark = orphan.querySelector<HTMLElement>('mark[data-annotation-id="orphan"]');
    expect(orphanMark?.style.background).toBe('rgb(134, 194, 139)');
  });

  it('paints one overlay box per mark client rect for paginated columns', () => {
    const layer = textLayer('划选整段文字可见高亮');
    renderAnnotationMarks(layer, [
      {
        id: 'ov1',
        kind: 'highlight',
        anchor: {
          start: 0,
          end: 10,
          quote: '划选整段文字可见高亮',
          prefix: '',
          suffix: '',
        },
      },
    ]);
    const mark = layer.querySelector<HTMLElement>('mark[data-annotation-id="ov1"]')!;
    mark.getClientRects = () =>
      [
        { left: 20, top: 40, width: 120, height: 18, right: 140, bottom: 58 },
        { left: 20, top: 60, width: 90, height: 18, right: 110, bottom: 78 },
        { left: 900, top: 40, width: 80, height: 18, right: 980, bottom: 58 },
      ] as unknown as DOMRectList;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    const visible = visibleHighlightOverlayBoxes(document, [mark]);
    expect(visible).toHaveLength(2);
    expect(visible[0]?.width).toBe(120);
    expect(visible.some((box) => box.left >= 800)).toBe(false);
    paintAnnotationOverlays(document);
    document.querySelector('.lightink-reader-highlight-layer')?.remove();
  });

  it('页码级 PdfLocator（无 anchor）与文字级数据可共存解析', () => {
    const json = JSON.stringify({
      version: 3,
      annotations: [
        {
          id: 'old1',
          kind: 'bookmark',
          locator: { format: 'pdf', page: 5, quote: '页脚' },
          createdAt: 1,
        },
        {
          id: 'new1',
          kind: 'highlight',
          locator: {
            format: 'pdf',
            page: 5,
            quote: 'x',
            anchor: { start: 0, end: 1, quote: 'x', prefix: '', suffix: '' },
          },
          quote: 'x',
          createdAt: 2,
        },
      ],
    });
    const back = parseAnnotations(json);
    expect(back.map((a) => a.id)).toEqual(['old1', 'new1']);
    expect(back[0]!.locator.format === 'pdf' && back[0]!.locator.anchor).toBeUndefined();
    expect(back[1]!.locator.format === 'pdf' && back[1]!.locator.anchor).toBeDefined();
  });

  it('文本层容器插入与层内异步 span 填充都触发重渲染判定（官方时序回归）', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const delivered: MutationRecord[] = [];
    const observer = new MutationObserver((records) => delivered.push(...records));
    observer.observe(host, { childList: true, subtree: true });
    const settle = async (): Promise<readonly MutationRecord[]> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const records = delivered.splice(0, delivered.length);
      return records;
    };

    // 官方结构：宿主内先有 .pdfViewer > .page（页占位本身不是文本层变更）。
    const viewer = document.createElement('div');
    viewer.className = 'pdfViewer';
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = '1';
    viewer.appendChild(page);
    host.appendChild(viewer);
    expect(isTextLayerMutation(await settle())).toBe(false);

    // 第一步：官方 TextLayerBuilder 经 onAppend 插入层容器（此时 span 未填充）。
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    page.appendChild(layer);
    expect(isTextLayerMutation(await settle())).toBe(true);

    // 第二步：TextLayer.render() 微任务链异步追加 span。
    const span = document.createElement('span');
    span.textContent = '文字';
    layer.appendChild(span);
    expect(isTextLayerMutation(await settle())).toBe(true);

    // 无关变更（如 canvasWrapper 插入）不触发。
    const canvasWrapper = document.createElement('div');
    canvasWrapper.className = 'canvasWrapper';
    page.appendChild(canvasWrapper);
    expect(isTextLayerMutation(await settle())).toBe(false);

    // 拖选护栏追加 .endOfContent 不触发高亮重绘（官方 render 完成时追加同样被排除）。
    const end = document.createElement('div');
    end.className = 'endOfContent';
    layer.appendChild(end);
    expect(isTextLayerMutation(await settle())).toBe(false);

    // 反例（Recipe outcome 3）：旧类名层不再是官方文本层，插入不触发重渲染。
    const legacy = document.createElement('div');
    legacy.className = 'lightink-reader-text-layer';
    host.appendChild(legacy);
    expect(isTextLayerMutation(await settle())).toBe(false);
    observer.disconnect();
  });

  it('官方文本层选择器口径：命中与高亮渲染共用，页码即 data-page-number（1 基）', () => {
    expect(pdfTextLayerSelector(3)).toBe('.pdfViewer .page[data-page-number="3"] .textLayer');
  });
});
