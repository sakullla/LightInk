// @vitest-environment jsdom

/**
 * 标注生命周期 success toast 通道（R17/R22，T3）：
 * - host.notifyAnnotationChanged('added' | 'removed', annotation) → showToast('success', ...)
 * - i18n 键按 annotation.kind 选（highlight/note/bookmark）；
 * - 500ms 节流：单 kind 内多次派发合并为最后一次；隔 600ms 各自成行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation } from '../annotations.js';
import { setupReaderAnnotationSurface } from '../view/reader-annotation-surface.js';
import type { ReaderViewContext } from '../view/reader-context.js';
import type { SessionAnnotationHost } from '../session/session-annotation.js';

vi.mock('../../ui/toast.js', () => ({
  showToast: vi.fn(),
}));

import { showToast } from '../../ui/toast.js';

const showToastMock = vi.mocked(showToast);

afterEach(() => {
  vi.useRealTimers();
  showToastMock.mockReset();
});

function makeHighlight(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'highlight',
    locator: { format: 'pdf', page: 1, quote: '' },
    quote: '摘录',
    createdAt: 1,
    ...overrides,
  };
}

function makeNote(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'note',
    locator: { format: 'pdf', page: 1, quote: '' },
    quote: undefined,
    note: '备注',
    createdAt: 1,
    ...overrides,
  };
}

function makeBookmark(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    kind: 'bookmark',
    locator: { format: 'pdf', page: 1, quote: '' },
    createdAt: 1,
    ...overrides,
  };
}

function buildCtx(translator: (key: string) => string): ReaderViewContext {
  // 仅 host.notifyAnnotationChanged 闭包触达 ctx.destroyed / ctx.t；其它字段
  // 在本套测试中不被消费，留 undefined 即可（闭包不被调用就不报错）。
  // 但 host 构造本身要读 ctx.deps.readAnnotations 等 storage 注入；留空对象
  // 让它们都是 undefined，等价于「存储不可用」装配（不触发派生分支）。
  return {
    deps: {},
    destroyed: false,
    t: (key: string) => translator(key),
  } as unknown as ReaderViewContext;
}

function buildHost(
  translator: (key: string) => string,
): SessionAnnotationHost {
  const ctx = buildCtx(translator);
  return setupReaderAnnotationSurface(ctx).createSessionHost();
}

describe('annotation feedback channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('appendAnnotation success: highlight added → showToast success + highlighted key', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeHighlight('a'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      'success',
      'annotation.toast.highlighted',
      undefined,
      expect.objectContaining({ locale: expect.any(String) }),
    );
  });

  it('removeAnnotationById success: highlight removed → unhighlighted key', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('removed', makeHighlight('a'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      'success',
      'annotation.toast.unhighlighted',
      undefined,
      expect.objectContaining({ locale: expect.any(String) }),
    );
  });

  it('note added → noteAdded key; note removed → noteRemoved key', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeNote('n1'));
    vi.advanceTimersByTime(500);
    host.notifyAnnotationChanged?.('removed', makeNote('n1'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock.mock.calls[0]?.[1]).toBe('annotation.toast.noteAdded');
    expect(showToastMock.mock.calls[1]?.[1]).toBe('annotation.toast.noteRemoved');
  });

  it('bookmark added → bookmark.toast.added; bookmark removed → bookmark.toast.removed', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeBookmark('b1'));
    vi.advanceTimersByTime(500);
    host.notifyAnnotationChanged?.('removed', makeBookmark('b1'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock.mock.calls[0]?.[1]).toBe('bookmark.toast.added');
    expect(showToastMock.mock.calls[1]?.[1]).toBe('bookmark.toast.removed');
  });

  it('throttles: 3 calls within 500ms → showToast called once with the latest payload', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeHighlight('h1'));
    vi.advanceTimersByTime(100);
    host.notifyAnnotationChanged?.('added', makeHighlight('h2'));
    vi.advanceTimersByTime(100);
    host.notifyAnnotationChanged?.('added', makeHighlight('h3'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      'success',
      'annotation.toast.highlighted',
      undefined,
      expect.objectContaining({ locale: expect.any(String) }),
    );
  });

  it('throttles per kind independently: added and removed track separate timers', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeHighlight('h1'));
    vi.advanceTimersByTime(100);
    host.notifyAnnotationChanged?.('removed', makeHighlight('h2'));
    // added 计时器 t=500 触发；removed 计时器 t=600 触发；前进到 600 让两者都落下。
    vi.advanceTimersByTime(600);
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock.mock.calls[0]?.[1]).toBe('annotation.toast.highlighted');
    expect(showToastMock.mock.calls[1]?.[1]).toBe('annotation.toast.unhighlighted');
  });

  it('calls spaced by 600ms each fire their own toast', () => {
    const host = buildHost((key) => key);
    host.notifyAnnotationChanged?.('added', makeHighlight('h1'));
    vi.advanceTimersByTime(600);
    host.notifyAnnotationChanged?.('added', makeHighlight('h2'));
    vi.advanceTimersByTime(600);
    host.notifyAnnotationChanged?.('added', makeHighlight('h3'));
    vi.advanceTimersByTime(600);
    expect(showToastMock).toHaveBeenCalledTimes(3);
    for (const call of showToastMock.mock.calls) {
      expect(call[1]).toBe('annotation.toast.highlighted');
    }
  });

  it('locales via readerAidLocale: zh-CN text → zh-CN locale option', () => {
    // t('annotation.highlight') === '高亮' triggers readerAidLocale → 'zh-CN'.
    const host = buildHost((key) => (key === 'annotation.highlight' ? '高亮' : key));
    host.notifyAnnotationChanged?.('added', makeHighlight('h1'));
    vi.advanceTimersByTime(500);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      'success',
      'annotation.toast.highlighted',
      undefined,
      { locale: 'zh-CN' },
    );
  });
});
