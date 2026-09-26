import { describe, expect, it, vi } from 'vitest';

import {
  BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
  BOOK_SOURCE_SEARCH_TOOL_NAME,
  createBookSourceToolSession,
  type BookSourceToolDeps,
} from '../book-source-tools.js';

function deps(overrides: Partial<BookSourceToolDeps> = {}): BookSourceToolDeps {
  return {
    listSources: async () => [
      { id: 'src-1', title: '示例源', enabled: true, baseUrl: 'https://example.test' },
    ],
    search: async () => [
      {
        sourceId: 'src-1',
        sourceTitle: '示例源',
        title: '三体',
        author: '刘慈欣',
        url: 'https://example.test/book/1',
      },
    ],
    download: vi.fn(async () => ({ phase: 'done', itemId: 'item-1' })),
    permissionMode: 'review',
    userMessage: '下载三体',
    ...overrides,
  };
}

describe('book source tools', () => {
  it('searches a named source and waits for confirmation before downloading', async () => {
    const client = deps();
    const session = createBookSourceToolSession(client);
    const found = await session.execute(BOOK_SOURCE_SEARCH_TOOL_NAME, {
      source: '示例源',
      query: '三体',
    });
    expect(found.ok).toBe(true);
    expect(found.results).toEqual([
      expect.objectContaining({ title: '三体', url: 'https://example.test/book/1' }),
    ]);

    const queued = await session.execute(BOOK_SOURCE_DOWNLOAD_TOOL_NAME, {
      sourceId: 'src-1',
      title: '三体',
      bookUrl: 'https://example.test/book/1',
    });
    expect(queued.pending_confirmation).toHaveLength(1);
    expect(client.download).not.toHaveBeenCalled();

    const confirmed = await session.confirmPending!(queued.pending_confirmation![0]!.id);
    expect(confirmed.ok).toBe(true);
    expect(client.download).toHaveBeenCalledWith(
      expect.objectContaining({ title: '三体', format: 'txt' }),
    );
  });

  it('downloads immediately in yolo mode', async () => {
    const client = deps({ permissionMode: 'yolo' });
    const session = createBookSourceToolSession(client);
    const result = await session.execute(BOOK_SOURCE_DOWNLOAD_TOOL_NAME, {
      sourceId: 'src-1',
      title: '三体',
      bookUrl: 'https://example.test/book/1',
      format: 'epub',
    });
    expect(result.ok).toBe(true);
    expect(client.download).toHaveBeenCalledWith(expect.objectContaining({ format: 'epub' }));
  });
});
