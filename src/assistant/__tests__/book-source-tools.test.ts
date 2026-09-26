/**
 * 全部走注入的假客户端，不访问任何真实站点。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
  BOOK_SOURCE_IMPORT_TOOL_NAME,
  BOOK_SOURCE_GET_TOOL_NAME,
  BOOK_SOURCE_LIST_TOOL_NAME,
  BOOK_SOURCE_REMOVE_TOOL_NAME,
  BOOK_SOURCE_SAVE_TOOL_NAME,
  BOOK_SOURCE_SEARCH_TOOL_NAME,
  createBookSourceToolSession,
  type BookSourceToolDeps,
} from '../book-source-tools.js';

function deps(overrides: Partial<BookSourceToolDeps> = {}): BookSourceToolDeps {
  return {
    listSources: async () => [
      { id: 'src-1', title: '示例源', enabled: true, baseUrl: 'https://example.test' },
    ],
    fetchPage: vi.fn(async () => ({
      finalUrl: 'https://example.test/search?q=empty',
      status: 200,
      length: 20,
      snippet: '<li class="result extra">空</li>',
    })),
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
    saveSource: vi.fn(async (input) => ({ id: 'saved-1', title: input.title })),
    importSources: vi.fn(async () => [{ id: 'imported-1', title: '导入源' }]),
    removeSource: vi.fn(async () => undefined),
    setSourceEnabled: vi.fn(async () => undefined),
    listBuiltins: async () => [
      {
        id: 'gutenberg',
        title: 'Project Gutenberg',
        url: 'https://example.test',
        rule: { version: 1, baseUrl: 'https://example.test', search: { url: '/search?q={{key}}', item: 'li', title: 'span' } },
      },
    ],
    permissionMode: 'review',
    userMessage: '下载三体',
    ...overrides,
  };
}

describe('book source tools', () => {
  it('searches a named source and waits for confirmation before downloading', async () => {
    const client = deps();
    const session = createBookSourceToolSession(client);
    const found = await session.execute(
      BOOK_SOURCE_SEARCH_TOOL_NAME,
      JSON.stringify({ source: '示例源', query: '三体' }),
    );
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

  it('lists sources from an empty JSON string and downloads from search-result field names', async () => {
    const client = deps();
    const session = createBookSourceToolSession(client);
    const listed = await session.execute(BOOK_SOURCE_LIST_TOOL_NAME, '{}');
    expect(listed.ok).toBe(true);
    expect(listed.sources).toEqual([
      expect.objectContaining({ id: 'src-1', title: '示例源' }),
    ]);

    const queued = await session.execute(
      BOOK_SOURCE_DOWNLOAD_TOOL_NAME,
      JSON.stringify({
        source: '示例源',
        title: '三体',
        url: 'https://example.test/book/1',
        format: 'EPUB',
      }),
    );
    expect(queued.pending_confirmation).toHaveLength(1);
    const confirmed = await session.confirmPending!(queued.pending_confirmation![0]!.id);
    expect(confirmed.ok).toBe(true);
    expect(client.download).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'src-1',
        bookUrl: 'https://example.test/book/1',
        format: 'epub',
      }),
    );
  });

  it('saves a builtin source after confirmation and a rule JSON string in yolo', async () => {
    const client = deps();
    const session = createBookSourceToolSession(client);
    const queued = await session.execute(
      BOOK_SOURCE_SAVE_TOOL_NAME,
      JSON.stringify({ builtin: 'Project Gutenberg' }),
    );
    expect(queued.pending_confirmation?.[0]?.summary).toContain('Project Gutenberg');
    expect(client.saveSource).not.toHaveBeenCalled();
    const confirmed = await session.confirmPending!(queued.pending_confirmation![0]!.id);
    expect(confirmed.ok).toBe(true);
    expect(client.saveSource).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Project Gutenberg', allowHttp: false }),
    );

    const yolo = createBookSourceToolSession(deps({ permissionMode: 'yolo' }));
    const saved = await yolo.execute(
      BOOK_SOURCE_SAVE_TOOL_NAME,
      JSON.stringify({
        title: '示例站',
        rule: JSON.stringify({
          version: 1,
          baseUrl: 'https://example.test',
          search: { url: '/search?q={{key}}', item: 'li', title: 'a' },
        }),
      }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.message).toContain('示例站');
  });

  it('imports a rule pack only after confirmation', async () => {
    const client = deps();
    const session = createBookSourceToolSession(client);
    const pack = JSON.stringify({
      format: 'lightink.book-sources',
      version: 1,
      sources: [
        {
          title: '导入源',
          allowHttp: false,
          rule: { version: 1, baseUrl: 'https://example.test', search: { url: '/s?q={{key}}', item: 'li', title: 'a' } },
        },
      ],
    });
    const queued = await session.execute(BOOK_SOURCE_IMPORT_TOOL_NAME, JSON.stringify({ json: pack }));
    expect(queued.pending).toBe(true);
    expect(client.importSources).not.toHaveBeenCalled();
    const confirmed = await session.confirmPending!(queued.pending_confirmation![0]!.id);
    expect(confirmed.ok).toBe(true);
    expect(client.importSources).toHaveBeenCalledWith(pack);
  });

  it('removes a source by id after confirmation and refuses an ambiguous title', async () => {
    const client = deps({
      listSources: async () => [
        { id: 'src-1', title: '示例源', enabled: true, baseUrl: 'https://example.test' },
        { id: 'src-2', title: '示例源', enabled: true, baseUrl: 'https://other.test' },
      ],
    });
    const session = createBookSourceToolSession(client);
    const ambiguous = await session.execute(BOOK_SOURCE_REMOVE_TOOL_NAME, { source: '示例源' });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toContain('id');
    const queued = await session.execute(BOOK_SOURCE_REMOVE_TOOL_NAME, { source: 'src-1' });
    expect(queued.pending_confirmation).toHaveLength(1);
    expect(client.removeSource).not.toHaveBeenCalled();
    const confirmed = await session.confirmPending!(queued.pending_confirmation![0]!.id);
    expect(confirmed.ok).toBe(true);
    expect(client.removeSource).toHaveBeenCalledWith('src-1');
  });

  it('shows the rule checker message when saving is rejected', async () => {
    const client = deps({
      permissionMode: 'yolo',
      saveSource: vi.fn(async () => {
        throw { message: '规则字段 search.url 无效: 搜索地址必须包含 {{key}} 占位符' };
      }),
    });
    const session = createBookSourceToolSession(client);
    const result = await session.execute(BOOK_SOURCE_SAVE_TOOL_NAME, {
      title: 'Chinese Text Project',
      rule: {
        version: 1,
        baseUrl: 'https://example.test',
        search: { url: '/searchbook.pl?keyword=test', item: '(<a.*?>)', title: '(<a.*?>)' },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('{{key}}');
  });

  it('attaches the fetched HTML when a search matches nothing', async () => {
    const client = deps({ search: async () => [] });
    const session = createBookSourceToolSession(client);
    const found = await session.execute(
      BOOK_SOURCE_SEARCH_TOOL_NAME,
      JSON.stringify({ source: '示例源', query: '无' }),
    );
    expect(found.ok).toBe(true);
    expect(found.results).toEqual([]);
    expect(found.page?.finalUrl).toBe('https://example.test/search?q=empty');
    expect(found.page?.snippet).toContain('result extra');
    expect(client.fetchPage).toHaveBeenCalledWith('src-1', { query: '无' });
  });

  it('returns one source configuration and rejects an ambiguous title', async () => {
    const rule = { version: 1, baseUrl: 'https://example.test', search: { url: '/s?q={{key}}', item: 'li.result', title: '.heading' } };
    const client = deps({
      listSources: async () => [
        { id: 'src-1', title: '示例源', enabled: true, baseUrl: 'https://example.test', allowHttp: false, rule },
        { id: 'src-2', title: '示例源', enabled: false, baseUrl: 'https://other.test', allowHttp: true, rule },
      ],
    });
    const session = createBookSourceToolSession(client);
    const ambiguous = await session.execute(BOOK_SOURCE_GET_TOOL_NAME, JSON.stringify({ source: '示例源' }));
    expect(ambiguous.ok).toBe(false);
    const found = await session.execute(BOOK_SOURCE_GET_TOOL_NAME, JSON.stringify({ source: 'src-1' }));
    expect(found.ok).toBe(true);
    expect(found.sources).toEqual([
      expect.objectContaining({ id: 'src-1', allowHttp: false, rule }),
    ]);
  });

  it('does not write a second copy when auto mode already queued that save', async () => {
    const client = deps({ permissionMode: 'auto', userMessage: '添加维基文库然后搜索' });
    const session = createBookSourceToolSession(client);
    const first = await session.execute(BOOK_SOURCE_SAVE_TOOL_NAME, {
      title: '维基文库',
      rule: { version: 1, baseUrl: 'https://example.test', search: { url: '/s?q={{key}}', item: '(a)', title: '(b)' } },
    });
    const second = await session.execute(BOOK_SOURCE_SAVE_TOOL_NAME, {
      title: '维基文库',
      rule: { version: 1, baseUrl: 'https://example.test', search: { url: '/s?q={{key}}', item: '(a)', title: '(b)' } },
    });
    expect(first.pending).toBe(true);
    expect(second.pending).toBeUndefined();
    expect(second.message).toContain('不要再次调用');
    expect(client.saveSource).not.toHaveBeenCalled();
  });

  it('drops empty optional selectors and accepts a single cleanup string', async () => {
    const client = deps({ permissionMode: 'yolo' });
    const session = createBookSourceToolSession(client);
    const saved = await session.execute(BOOK_SOURCE_SAVE_TOOL_NAME, {
      title: '示例源',
      rule: {
        version: 1,
        baseUrl: 'https://example.test',
        search: {
          url: '/s?q={{key}}',
          item: 'li.result',
          title: '.heading',
          link: '',
          cover: null,
        },
        content: { text: '.body', cleanup: '<sup[^>]*>.*?</sup>' },
      },
    });
    expect(saved.ok).toBe(true);
    expect(client.saveSource).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: expect.objectContaining({
          search: expect.not.objectContaining({ link: '', cover: null }),
          content: expect.objectContaining({ cleanup: ['<sup[^>]*>.*?</sup>'] }),
        }),
      }),
    );
  });

  it('updates an existing source when only id and rule are provided', async () => {
    const client = deps({
      permissionMode: 'yolo',
      listSources: async () => [
        {
          id: 'src-1',
          title: '维基文库-搜索',
          enabled: true,
          baseUrl: 'https://example.test',
          allowHttp: false,
          rule: { version: 1, baseUrl: 'https://example.test', search: { url: '/old?q={{key}}', item: '(a)', title: '(b)' } },
        },
      ],
    });
    const session = createBookSourceToolSession(client);
    const saved = await session.execute(BOOK_SOURCE_SAVE_TOOL_NAME, {
      id: 'src-1',
      rule: {
        version: 1,
        baseUrl: 'https://example.test',
        search: { url: '/w/index.php?search={{key}}', item: '(<li>.*?</li>)', title: '(<a>.*?</a>)' },
      },
    });
    expect(saved.ok).toBe(true);
    expect(client.saveSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src-1', title: '维基文库-搜索', allowHttp: false }),
    );
  });
});
