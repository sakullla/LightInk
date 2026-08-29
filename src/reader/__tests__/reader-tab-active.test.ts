// @vitest-environment jsdom
/**
 * setTabActive 回归：侧栏挂在阅读根上，切走标签必须显式隐藏，切回按原偏好恢复。
 * 另覆盖漫画能力面：本地漫画归档启用页级标注（progress-id 同源身份，不哈希
 * 归档），书签开关产生 v3 存储写入（添加/取消=tombstone）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReaderView } from '../reader-view.js';

const cbzMock = vi.hoisted(() => ({ renderCbzInto: vi.fn() }));
vi.mock('../formats/cbz.js', () => ({ renderCbzInto: cbzMock.renderCbzInto }));

const stubComicHandle = (): Record<string, unknown> => ({
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

describe('漫画页级标注（progress-id 同源身份）', () => {
  afterEach(() => {
    cbzMock.renderCbzInto.mockReset();
    document.body.replaceChildren();
  });

  it('本地漫画启用标注：页级书签开关写存储（不哈希归档），角标随页出现', async () => {
    const getContentHash = vi.fn(async () => {
      throw new Error('must not hash a comic archive');
    });
    const readAnnotations = vi.fn(async (_contentHash: string) => '');
    const writeAnnotations = vi.fn(async (_contentHash: string, _json: string) => undefined);
    cbzMock.renderCbzInto.mockImplementation(
      async (_source: unknown, stagedHost: HTMLElement) => {
        // 与生产 cbz.ts 一致：页 slot 占位带 data-page-index。
        for (let index = 0; index < 3; index += 1) {
          const slot = document.createElement('div');
          slot.className = 'lightink-reader-page-slot lightink-reader-cbz-slot';
          slot.dataset.pageIndex = String(index);
          stagedHost.appendChild(slot);
        }
        return stubComicHandle();
      },
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(host, {
      readBytes: async () => new Uint8Array([0x89, 0x50]),
      readAnnotations,
      writeAnnotations,
      getContentHash,
    });

    await view.load('/comics/vol.cbz');

    // 漫画本地标注启用：不哈希归档，身份与页进度同源（路径键）。
    expect(view.isAnnotationEnabled()).toBe(true);
    expect(getContentHash).not.toHaveBeenCalled();
    expect(readAnnotations).toHaveBeenCalledWith('/comics/vol.cbz');
    expect(view.isBookmarked?.()).toBe(false);

    // 书签开关：添加 → 页角丝带角标出现。
    view.addBookmark();
    expect(view.isBookmarked?.()).toBe(true);
    await vi.waitFor(() => expect(writeAnnotations).toHaveBeenCalledTimes(1));
    const [firstKey, firstJson] = writeAnnotations.mock.calls[0] as [string, string];
    expect(firstKey).toBe('/comics/vol.cbz');
    const first = JSON.parse(firstJson) as {
      version: number;
      annotations: Array<Record<string, unknown>>;
    };
    expect(first.version).toBe(3);
    expect(first.annotations).toHaveLength(1);
    expect(first.annotations[0]).toMatchObject({
      kind: 'bookmark',
      locator: { format: 'cbz', page: 1 },
    });
    const firstSlot = host.querySelector<HTMLElement>(
      '.lightink-reader-page-slot[data-page-index="0"]',
    );
    expect(firstSlot?.querySelector('.lightink-reader-bookmark-ribbon')).not.toBeNull();

    // 再点一次 = 取消：产出 tombstone，角标消失。
    view.addBookmark();
    expect(view.isBookmarked?.()).toBe(false);
    await vi.waitFor(() => expect(writeAnnotations).toHaveBeenCalledTimes(2));
    const second = JSON.parse(
      (writeAnnotations.mock.calls[1] as [string, string])[1],
    ) as { annotations: Array<Record<string, unknown>> };
    expect(second.annotations).toHaveLength(1);
    expect(second.annotations[0]?.deletedAt).toEqual(expect.any(Number));
    expect(firstSlot?.querySelector('.lightink-reader-bookmark-ribbon')).toBeNull();

    await view.destroy();
  });
});
