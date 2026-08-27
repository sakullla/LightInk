// @vitest-environment jsdom
/**
 * setTabActive 回归：侧栏挂在阅读根上，切走标签必须显式隐藏，切回按原偏好恢复。
 * 另覆盖 Recipe 失败面：标注未启用格式（本地漫画归档）的标注操作为空操作、不产生存储写入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';

const cbzMock = vi.hoisted(() => ({ renderCbzInto: vi.fn() }));
vi.mock('../formats/cbz.js', () => ({ renderCbzInto: cbzMock.renderCbzInto }));

describe('setTabActive 覆盖层同步', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('切走隐藏 portal 侧栏，切回恢复（用户偏好不丢）', async () => {
    document.body.innerHTML = '<div id="lightink-main"><div id="host"></div></div>';
    const host = document.getElementById('host')!;
    const view = createReaderView(host, { t: (key) => key });

    view.toggleSidebar();
    const sidebar = document.querySelector<HTMLElement>('.lightink-reader-sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar!.hidden).toBe(false);

    view.setTabActive(false);
    expect(sidebar!.hidden).toBe(true); // 不残留显示

    view.setTabActive(true);
    expect(sidebar!.hidden).toBe(false); // 偏好恢复，无需重新打开

    // 侧栏关闭状态下切走/切回，不会把侧栏带回来。
    view.toggleSidebar();
    view.setTabActive(false);
    view.setTabActive(true);
    expect(sidebar!.hidden).toBe(true);

    await view.destroy();
  });
});

describe('标注未启用格式（漫画）', () => {
  afterEach(() => {
    cbzMock.renderCbzInto.mockReset();
    document.body.replaceChildren();
  });

  it('本地漫画标注操作为空操作，不产生存储写入', async () => {
    const getContentHash = vi.fn(async () => {
      throw new Error('must not hash a comic archive');
    });
    const readAnnotations = vi.fn(async () => '');
    const writeAnnotations = vi.fn(async () => undefined);
    cbzMock.renderCbzInto.mockResolvedValue({
      totalPages: 3,
      currentPage: 1,
      metadata: { pages: [] },
      preferences: {
        mode: 'paged',
        direction: 'ltr',
        spread: 'single',
        fit: 'width',
        cropMargins: false,
      },
      scrollToPage: vi.fn(),
      scrollToProgress: vi.fn(),
      nextPage: vi.fn(() => true),
      previousPage: vi.fn(() => true),
      setPreferences: vi.fn(),
      hideChrome: vi.fn(() => false),
      adjustZoom: vi.fn(),
      destroy: vi.fn(async () => undefined),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([0x89, 0x50]),
      readAnnotations,
      writeAnnotations,
      getContentHash,
    });

    await view.load('/comics/vol.cbz');

    // 漫画本地不哈希归档：启用判定关闭，身份/读取均未发生。
    expect(view.isAnnotationEnabled()).toBe(false);
    expect(getContentHash).not.toHaveBeenCalled();
    expect(readAnnotations).not.toHaveBeenCalled();

    // 未启用成员的标注操作（书签/笔记）为空操作。
    view.addBookmark();
    view.addNote();

    expect(writeAnnotations).not.toHaveBeenCalled();

    await view.destroy();
    expect(writeAnnotations).not.toHaveBeenCalled();
  });
});
