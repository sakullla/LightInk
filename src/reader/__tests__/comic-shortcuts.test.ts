// @vitest-environment jsdom
// T4（ADR-6）：阅读根 keydown 的漫画裸键扩展——+/-/_/0 经 cbzHandle.adjustZoom
// 生效、G/g 打开跳页对话框（openPageJump）；修饰键走 shortcuts.ts 既有链、
// 输入框/模态内不劫持、翻页键注册表无新增冲突、PDF 分支与文字书（flow）不回归。

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';
import { isReadingNavKey } from '../../ui/reading-layout.js';
import { DEFAULT_SHORTCUTS, matchEvent } from '../../ui/shortcuts.js';

const cbzMock = vi.hoisted(() => ({ renderCbzInto: vi.fn() }));
vi.mock('../formats/cbz.js', () => ({ renderCbzInto: cbzMock.renderCbzInto }));
const pdfMock = vi.hoisted(() => ({ renderPdfInto: vi.fn() }));
vi.mock('../formats/pdf.js', () => ({ renderPdfInto: pdfMock.renderPdfInto }));

/** 漫画 fake 句柄：满足 paged 装配消费面 + T4 新入口（openPageJump 等）。 */
const comicHandle = () => ({
  totalPages: 6,
  currentPage: 1,
  metadata: { pages: [] },
  preferences: {
    mode: 'paged',
    direction: 'ltr',
    spread: 'single',
    fit: 'width',
    cropMargins: false,
    spreadOffset: false,
  },
  scrollToPage: vi.fn(),
  scrollToProgress: vi.fn(),
  nextPage: vi.fn(() => true),
  previousPage: vi.fn(() => true),
  setPreferences: vi.fn(),
  hideChrome: vi.fn(() => false),
  adjustZoom: vi.fn(),
  openPageJump: vi.fn(),
  refreshBookmarkState: vi.fn(),
  destroy: vi.fn(async () => undefined),
});

const pdfHandle = () => ({
  controller: {
    totalPages: 10,
    page: 3,
    scale: 1,
    canPrev: true,
    canNext: true,
    next: vi.fn(() => false),
    prev: vi.fn(() => false),
    setPage: vi.fn(() => true),
    zoomIn: vi.fn(() => true),
    zoomOut: vi.fn(() => true),
    resetScale: vi.fn(() => true),
  },
  rerender: vi.fn(async () => undefined),
  scrollToPage: vi.fn(),
  search: vi.fn(async () => []),
  outline: vi.fn(async () => []),
  destroy: vi.fn(async () => undefined),
});

interface LoadedReader {
  host: HTMLElement;
  root: HTMLElement;
  view: ReturnType<typeof createReaderView>;
}

async function openComic(): Promise<LoadedReader & { handle: ReturnType<typeof comicHandle> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = comicHandle();
  cbzMock.renderCbzInto.mockResolvedValue(handle);
  const view = createReaderView(host, {
    readBytes: async () => new Uint8Array([0x89, 0x50]),
    readAnnotations: async () => '',
  });
  await view.load('/comics/vol.cbz');
  return { host, root: host.querySelector<HTMLElement>('.lightink-reader')!, view, handle };
}

async function openPdf(): Promise<LoadedReader & { handle: ReturnType<typeof pdfHandle> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = pdfHandle();
  pdfMock.renderPdfInto.mockResolvedValue(handle);
  const view = createReaderView(host, {
    readBytes: async () => new Uint8Array([0x25, 0x50]),
    readAnnotations: async () => '',
  });
  await view.load('/docs/manual.pdf');
  return { host, root: host.querySelector<HTMLElement>('.lightink-reader')!, view, handle };
}

async function openFlow(): Promise<LoadedReader> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = createReaderView(host, {
    readBytes: async () => new Uint8Array(),
    parseContent: async () => ({
      chapters: [{ title: 'Chapter 1', html: '<p>chapter 1 body</p>' }],
    }),
    getContentHash: async () => 'aaaaaaaaaaaaaaaa',
    readAnnotations: async () => '',
  });
  await view.load('book.epub');
  return { host, root: host.querySelector<HTMLElement>('.lightink-reader')!, view };
}

/** 在 target 上派发 keydown；返回值 = 是否未被 preventDefault（true = 放行）。 */
function keyDown(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  return target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );
}

afterEach(() => {
  cbzMock.renderCbzInto.mockReset();
  pdfMock.renderPdfInto.mockReset();
  document.body.replaceChildren();
  delete document.documentElement.dataset.readingLayout;
});

describe('reader root keydown: comic bare keys (T4/ADR-6)', () => {
  it('+/-/_/0 zoom the comic via cbzHandle.adjustZoom and swallow the default', async () => {
    const { view, root, handle } = await openComic();
    expect(keyDown(root, '=')).toBe(false); // preventDefault → dispatchEvent false
    expect(keyDown(root, '+')).toBe(false);
    expect(keyDown(root, '-')).toBe(false);
    expect(keyDown(root, '_')).toBe(false);
    expect(keyDown(root, '0')).toBe(false);
    expect(handle.adjustZoom.mock.calls.map((call) => call[0])).toEqual([
      'in',
      'in',
      'out',
      'out',
      'reset',
    ]);
    await view.destroy();
  });

  it('G/g opens the page jump dialog entry and ignores modified chords', async () => {
    const { view, root, handle } = await openComic();
    expect(keyDown(root, 'g')).toBe(false);
    expect(keyDown(root, 'G')).toBe(false);
    expect(handle.openPageJump).toHaveBeenCalledTimes(2);
    // 修饰组合不属于裸键分支（Ctrl+G 等留给系统/其它链）。
    expect(keyDown(root, 'g', { ctrlKey: true })).toBe(true);
    expect(keyDown(root, 'G', { metaKey: true })).toBe(true);
    expect(handle.openPageJump).toHaveBeenCalledTimes(2);
    await view.destroy();
  });

  it('ignores modified zoom chords (Ctrl+=/-/0 stay on the shortcuts.ts chain)', async () => {
    const { view, root, handle } = await openComic();
    expect(keyDown(root, '=', { ctrlKey: true })).toBe(true);
    expect(keyDown(root, '-', { ctrlKey: true })).toBe(true);
    expect(keyDown(root, '0', { ctrlKey: true })).toBe(true);
    expect(handle.adjustZoom).not.toHaveBeenCalled();
    await view.destroy();
  });

  it('does not hijack keys typed into inputs or open modals inside the reader', async () => {
    const { view, root, handle } = await openComic();
    // 页码跳转对话框输入框 / TOC 搜索框同源的守卫：可编辑目标。
    const input = document.createElement('input');
    root.appendChild(input);
    expect(keyDown(input, '0')).toBe(true);
    expect(keyDown(input, '4')).toBe(true);
    expect(keyDown(input, 'g')).toBe(true);
    expect(handle.adjustZoom).not.toHaveBeenCalled();
    expect(handle.openPageJump).not.toHaveBeenCalled();
    // 打开模态（aria-modal 覆盖层，如跳页对话框背板）内的非编辑目标同样放行。
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    const chip = document.createElement('button');
    overlay.appendChild(chip);
    root.appendChild(overlay);
    expect(keyDown(chip, 'g')).toBe(true);
    expect(handle.openPageJump).not.toHaveBeenCalled();
    await view.destroy();
  });

  it('leaves arrow/space paging keys out of the new branches', async () => {
    const { view, root, handle } = await openComic();
    // 根级监听不劫持翻页键（窗口级 main.ts 链所有），也不触发缩放/跳页。
    expect(keyDown(root, 'ArrowRight')).toBe(true);
    expect(keyDown(root, ' ')).toBe(true);
    expect(keyDown(root, 'PageDown')).toBe(true);
    expect(handle.adjustZoom).not.toHaveBeenCalled();
    expect(handle.openPageJump).not.toHaveBeenCalled();
    await view.destroy();
  });
});

describe('reader root keydown: no conflicts with existing registries', () => {
  it('new bare keys are not reading nav keys (window paging chain untouched)', () => {
    expect(isReadingNavKey('+')).toBe(false);
    expect(isReadingNavKey('-')).toBe(false);
    expect(isReadingNavKey('_')).toBe(false);
    expect(isReadingNavKey('0')).toBe(false);
    expect(isReadingNavKey('g')).toBe(false);
    expect(isReadingNavKey('G')).toBe(false);
    // 翻页键集本身未被改动。
    expect(isReadingNavKey('ArrowLeft')).toBe(true);
    expect(isReadingNavKey('PageUp')).toBe(true);
  });

  it('bare keys do not match the registered Ctrl zoom combos (no double dispatch)', () => {
    const bare = { key: '=', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, preventDefault: () => undefined };
    expect(matchEvent({ ...bare, key: '=' }, DEFAULT_SHORTCUTS['zoom-in'])).toBe(false);
    expect(matchEvent({ ...bare, key: '+' }, DEFAULT_SHORTCUTS['zoom-in'])).toBe(false);
    expect(matchEvent({ ...bare, key: '-' }, DEFAULT_SHORTCUTS['zoom-out'])).toBe(false);
    expect(matchEvent({ ...bare, key: '_' }, DEFAULT_SHORTCUTS['zoom-out'])).toBe(false);
    expect(matchEvent({ ...bare, key: '0' }, DEFAULT_SHORTCUTS['zoom-reset'])).toBe(false);
    // 对照：带 Ctrl 的组合仍命中既有注册。
    expect(
      matchEvent({ ...bare, key: '=', ctrlKey: true }, DEFAULT_SHORTCUTS['zoom-in']),
    ).toBe(true);
  });
});

describe('reader root keydown: PDF and flow do not regress', () => {
  it('PDF keeps its bare zoom keys and never reaches the comic branches', async () => {
    const { view, root, handle } = await openPdf();
    const cbzAdjust = vi.fn();
    cbzMock.renderCbzInto.mockResolvedValue({ ...comicHandle(), adjustZoom: cbzAdjust });
    expect(keyDown(root, '=')).toBe(false);
    expect(handle.controller.zoomIn).toHaveBeenCalledTimes(1);
    expect(keyDown(root, '_')).toBe(false);
    expect(handle.controller.zoomOut).toHaveBeenCalledTimes(1);
    expect(keyDown(root, '0')).toBe(false);
    expect(handle.controller.resetScale).toHaveBeenCalledTimes(1);
    // PDF 打开时 G 不打开任何漫画跳页对话框（comic 分支不可达）。
    expect(keyDown(root, 'g')).toBe(true);
    expect(cbzAdjust).not.toHaveBeenCalled();
    await view.destroy();
  });

  it('flow (text book) keys pass through untouched', async () => {
    const { view, root } = await openFlow();
    expect(keyDown(root, '=')).toBe(true);
    expect(keyDown(root, '+')).toBe(true);
    expect(keyDown(root, '-')).toBe(true);
    expect(keyDown(root, '0')).toBe(true);
    expect(keyDown(root, 'g')).toBe(true);
    expect(keyDown(root, 'G')).toBe(true);
    await view.destroy();
  });
});
