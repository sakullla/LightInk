// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  BookSourceClient,
  type BookSource,
  type BookSourceBuiltin,
  type BookSourceClientInvoker,
  type BookSourceRule,
  type BookSourceSearchResult,
} from '../book-source-client.js';
import { createBookSourcePanel, type BookSourcePanelClient } from '../book-source-panel.js';

function rule(overrides: Partial<BookSourceRule> = {}): BookSourceRule {
  return {
    version: 1,
    baseUrl: 'https://books.example',
    search: {
      url: '/search?q={{key}}',
      item: '<li class="entry">(?s)(.*?)</li>',
      title: '<span class="title">(?s)(.*?)</span>',
      link: 'href="([^"]+)"',
    },
    ...overrides,
  };
}

function source(overrides: Partial<BookSource> = {}): BookSource {
  return {
    id: 'source-1',
    title: '示例源',
    rule: rule(),
    enabled: true,
    allowHttp: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function builtin(overrides: Partial<BookSourceBuiltin> = {}): BookSourceBuiltin {
  return {
    id: 'builtin-gutenberg',
    title: 'Project Gutenberg',
    url: 'https://www.gutenberg.org',
    license: 'public-domain',
    rule: rule({ baseUrl: 'https://www.gutenberg.org' }),
    ...overrides,
  };
}

function panelClient(
  overrides: Partial<BookSourcePanelClient> = {},
): BookSourcePanelClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    listSources: vi.fn(async () => [source()]),
    upsertSource: vi.fn(async () => source()),
    removeSource: vi.fn(async () => undefined),
    setSourceEnabled: vi.fn(async (_sourceId: string, enabled: boolean) =>
      source({ enabled }),
    ),
    importSources: vi.fn(async () => [source()]),
    exportSources: vi.fn(async () => '{"sources":[]}'),
    selfCheck: vi.fn(async () => ({ ok: true, issues: [] })),
    builtins: vi.fn(async () => [builtin()]),
    search: vi.fn(async () => [] as BookSourceSearchResult[]),
    ...overrides,
  } as BookSourcePanelClient & Record<string, ReturnType<typeof vi.fn>>;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function mountPanel(client: BookSourcePanelClient) {
  const panel = createBookSourcePanel({ client, getLocale: () => 'zh-CN' });
  document.body.appendChild(panel.element);
  return { panel };
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const candidate = Array.from(root.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
  if (!(candidate instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${text}`);
  }
  return candidate;
}

describe('BookSourceClient', () => {
  it('maps every book source command with camelCase arguments', async () => {
    const invoke = vi.fn(async () => undefined);
    const client = new BookSourceClient({ invoke } as BookSourceClientInvoker);
    const ruleInput = rule();

    await client.listSources();
    await client.upsertSource({ id: 'source-1', title: '示例源', allowHttp: true, rule: ruleInput });
    await client.removeSource('source-1');
    await client.setSourceEnabled('source-1', false);
    await client.importSources('{"sources":[]}');
    await client.exportSources(['source-1']);
    await client.selfCheck(ruleInput, true);
    await client.builtins();
    await client.search('source-1', '关键词');
    await client.chapters('source-1', 'https://books.example/book/1');
    await client.chapterText('source-1', 'https://books.example/ch/1');

    expect(invoke).toHaveBeenCalledWith('book_source_list');
    expect(invoke).toHaveBeenCalledWith('book_source_upsert', {
      input: { id: 'source-1', title: '示例源', allowHttp: true, rule: ruleInput },
    });
    expect(invoke).toHaveBeenCalledWith('book_source_remove', { sourceId: 'source-1' });
    expect(invoke).toHaveBeenCalledWith('book_source_set_enabled', {
      sourceId: 'source-1',
      enabled: false,
    });
    expect(invoke).toHaveBeenCalledWith('book_source_import', { json: '{"sources":[]}' });
    expect(invoke).toHaveBeenCalledWith('book_source_export', { sourceIds: ['source-1'] });
    expect(invoke).toHaveBeenCalledWith('book_source_self_check', {
      rule: ruleInput,
      allowHttp: true,
    });
    expect(invoke).toHaveBeenCalledWith('book_source_builtins');
    expect(invoke).toHaveBeenCalledWith('book_source_search', {
      sourceId: 'source-1',
      query: '关键词',
    });
    expect(invoke).toHaveBeenCalledWith('book_source_chapters', {
      sourceId: 'source-1',
      bookUrl: 'https://books.example/book/1',
    });
    expect(invoke).toHaveBeenCalledWith('book_source_chapter_text', {
      sourceId: 'source-1',
      chapterUrl: 'https://books.example/ch/1',
    });
  });

  it('exports all sources when no ids are given', async () => {
    const invoke = vi.fn(async () => '{}');
    const client = new BookSourceClient({ invoke } as BookSourceClientInvoker);
    await client.exportSources();
    expect(invoke).toHaveBeenCalledWith('book_source_export', undefined);
  });
});

describe('book source panel', () => {
  it('lists sources and built-ins and toggles enable through the client', async () => {
    const client = panelClient();
    const { panel } = mountPanel(client);
    await panel.show();

    expect(panel.visible).toBe(true);
    expect(document.body.contains(panel.element)).toBe(true);
    const row = panel.element.querySelector<HTMLElement>('[data-source-id="source-1"]');
    expect(row?.textContent).toContain('示例源');
    expect(row?.textContent).toContain('books.example');
    expect(panel.element.querySelector('[data-builtin-id="builtin-gutenberg"]')).not.toBeNull();

    const toggle = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(client.setSourceEnabled).toHaveBeenCalledWith('source-1', false);
    expect(
      panel.element.querySelector<HTMLInputElement>(
        '[data-source-id="source-1"] input[type="checkbox"]',
      )?.checked,
    ).toBe(false);
    panel.destroy();
  });

  it('shows field-level self-check issues and blocks saving until the rule passes', async () => {
    const failure = { ok: false, issues: [{ field: 'search.item', message: '正则无效' }] };
    const success = { ok: true, issues: [] };
    const selfCheck = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValue(success);
    const client = panelClient({ selfCheck });
    const { panel } = mountPanel(client);
    await panel.show();

    buttonByText(panel.element, '新建书源').click();
    const editor = panel.element.querySelector<HTMLElement>('.lightink-library-book-source-editor');
    expect(editor?.hidden).toBe(false);
    const ruleField = editor?.querySelector<HTMLTextAreaElement>('textarea[name="rule"]');
    expect(ruleField?.value).toContain('{{key}}');
    editor!.querySelector<HTMLInputElement>('input[name="sourceName"]')!.value = '示例源';

    buttonByText(editor!, '自检').click();
    await settle();
    const issues = editor?.querySelectorAll<HTMLElement>(
      '.lightink-library-book-source-issues li',
    );
    expect(issues?.length).toBe(1);
    expect(issues?.[0]?.dataset.field).toBe('search.item');
    expect(issues?.[0]?.textContent).toContain('正则无效');

    buttonByText(editor!, '保存').click();
    await settle();
    expect(client.upsertSource).not.toHaveBeenCalled();

    buttonByText(editor!, '自检').click();
    await settle();
    expect(
      editor?.querySelector<HTMLElement>('.lightink-library-book-source-issues')?.hidden,
    ).toBe(true);

    buttonByText(editor!, '保存').click();
    await settle();
    expect(client.upsertSource).toHaveBeenCalledWith(
      expect.objectContaining({ title: '示例源', allowHttp: false }),
    );
    panel.destroy();
  });

  it('reports invalid JSON locally without calling the backend', async () => {
    const client = panelClient();
    const { panel } = mountPanel(client);
    await panel.show();

    buttonByText(panel.element, '新建书源').click();
    const editor = panel.element.querySelector<HTMLElement>('.lightink-library-book-source-editor')!;
    editor.querySelector<HTMLInputElement>('input[name="sourceName"]')!.value = '示例源';
    const ruleField = editor.querySelector<HTMLTextAreaElement>('textarea[name="rule"]')!;
    ruleField.value = '{ broken';
    buttonByText(editor, '保存').click();
    await settle();

    expect(client.selfCheck).not.toHaveBeenCalled();
    expect(client.upsertSource).not.toHaveBeenCalled();
    const issue = editor.querySelector<HTMLElement>('.lightink-library-book-source-issues li');
    expect(issue?.dataset.field).toBe('rule');
    expect(issue?.textContent).toContain('JSON');
    panel.destroy();
  });

  it('keeps an empty name from reaching the backend', async () => {
    const client = panelClient();
    const { panel } = mountPanel(client);
    await panel.show();

    buttonByText(panel.element, '新建书源').click();
    const editor = panel.element.querySelector<HTMLElement>('.lightink-library-book-source-editor')!;
    buttonByText(editor, '保存').click();
    await settle();

    expect(client.selfCheck).not.toHaveBeenCalled();
    expect(client.upsertSource).not.toHaveBeenCalled();
    const issue = editor.querySelector<HTMLElement>('.lightink-library-book-source-issues li');
    expect(issue?.dataset.field).toBe('title');
    panel.destroy();
  });

  it('adds built-in examples once and imports or exports JSON', async () => {
    const stored: BookSource[] = [source()];
    const client = panelClient({
      listSources: vi.fn(async () => [...stored]),
      upsertSource: vi.fn(async (input) => {
        const saved = source({
          id: `source-${stored.length + 1}`,
          title: input.title,
          rule: input.rule as BookSourceRule,
          allowHttp: input.allowHttp ?? false,
        });
        stored.push(saved);
        return saved;
      }),
    });
    const { panel } = mountPanel(client);
    await panel.show();

    buttonByText(panel.element, '添加').click();
    await settle();
    expect(client.upsertSource).toHaveBeenCalledWith({
      title: 'Project Gutenberg',
      allowHttp: false,
      rule: builtin().rule,
    });
    const upsert = client.upsertSource as ReturnType<typeof vi.fn>;
    upsert.mockClear();

    buttonByText(panel.element, '添加').click();
    await settle();
    expect(client.upsertSource).not.toHaveBeenCalled();

    buttonByText(panel.element, '导入').click();
    const importSection = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-import',
    )!;
    const importArea = importSection.querySelector<HTMLTextAreaElement>('textarea')!;
    importArea.value = '{"sources":[]}';
    buttonByText(importSection, '导入').click();
    await settle();
    expect(client.importSources).toHaveBeenCalledWith('{"sources":[]}');

    buttonByText(panel.element, '导出').click();
    await settle();
    const exportArea = panel.element.querySelector<HTMLTextAreaElement>(
      '.lightink-library-book-source-export textarea',
    )!;
    expect(exportArea.value).toBe('{"sources":[]}');
    panel.destroy();
  });

  it('renders search results for the selected source', async () => {
    const results: BookSourceSearchResult[] = [
      {
        sourceId: 'source-1',
        sourceTitle: '示例源',
        title: '第一部',
        author: '作者甲',
        url: 'https://books.example/book/1',
      },
    ];
    const client = panelClient({ search: vi.fn(async () => results) });
    const { panel } = mountPanel(client);
    await panel.show();

    const row = panel.element.querySelector<HTMLElement>('[data-source-id="source-1"]')!;
    buttonByText(row, '搜索').click();
    const searchSection = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-search',
    )!;
    const query = searchSection.querySelector<HTMLInputElement>('input')!;
    query.value = '关键词';
    searchSection.querySelector<HTMLButtonElement>('.lightink-library-primary')!.click();
    await settle();

    expect(client.search).toHaveBeenCalledWith('source-1', '关键词');
    const rendered = panel.element.querySelector('.lightink-library-book-source-results');
    expect(rendered?.textContent).toContain('第一部');
    expect(rendered?.textContent).toContain('作者甲');
    expect(rendered?.textContent).toContain('https://books.example/book/1');
    panel.destroy();
  });

  it('keeps the overlay hidden until shown and removes it on destroy', async () => {
    const client = panelClient();
    const { panel } = mountPanel(client);
    expect(panel.visible).toBe(false);
    await panel.show();
    expect(panel.visible).toBe(true);
    panel.hide();
    expect(panel.visible).toBe(false);
    panel.destroy();
    expect(panel.element.isConnected).toBe(false);
  });
});
