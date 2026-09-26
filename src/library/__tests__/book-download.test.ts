// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  buildDownloadEpub,
  chapterFailed,
  chapterProgress,
  chapterSucceeded,
  composeFailed,
  composeSucceeded,
  createBookDownloadClient,
  createBookDownloadController,
  downloadPaused,
  formatDownloadProgress,
  INITIAL_DOWNLOAD_STATE,
  missingChapterIndices,
  runtimeFromPersisted,
  type BookDownloadClient,
  type BookDownloadPersistedChapter,
  type BookDownloadPersistedJob,
  type BookDownloadStartInput,
} from '../book-download.js';

function persistedChapter(
  indexNo: number,
  status: string,
  overrides: Partial<BookDownloadPersistedChapter> = {},
): BookDownloadPersistedChapter {
  return {
    indexNo,
    title: `第${indexNo + 1}章`,
    url: `https://books.example/ch/${indexNo}`,
    status,
    ...overrides,
  };
}

function persistedJob(
  overrides: Partial<BookDownloadPersistedJob> = {},
): BookDownloadPersistedJob {
  return {
    id: 'job-1',
    sourceId: 'source-1',
    title: '第一部',
    author: '作者甲',
    bookUrl: 'https://books.example/book/1',
    outputFormat: 'txt',
    status: 'downloading',
    totalChapters: 3,
    chapters: [
      persistedChapter(0, 'done', { content: '甲' }),
      persistedChapter(1, 'pending'),
      persistedChapter(2, 'done', { content: '丙' }),
    ],
    ...overrides,
  };
}

function startInput(overrides: Partial<BookDownloadStartInput> = {}): BookDownloadStartInput {
  return {
    sourceId: 'source-1',
    title: '第一部',
    author: '作者甲',
    bookUrl: 'https://books.example/book/1',
    format: 'txt',
    chapters: [
      { title: '第1章', url: 'https://books.example/ch/0' },
      { title: '第2章', url: 'https://books.example/ch/1' },
      { title: '第3章', url: 'https://books.example/ch/2' },
    ],
    ...overrides,
  };
}

function mockClient(overrides: Partial<BookDownloadClient> = {}): BookDownloadClient {
  return {
    createJob: vi.fn(async (input: BookDownloadStartInput) =>
      persistedJob({
        outputFormat: input.format,
        chapters: input.chapters.map((chapter, index) =>
          persistedChapter(index, 'pending', { title: chapter.title, url: chapter.url }),
        ),
      }),
    ),
    fetchChapter: vi.fn(async (_jobId: string, indexNo: number) =>
      persistedChapter(indexNo, 'done', { content: `内容${indexNo}` }),
    ),
    getJob: vi.fn(async () => persistedJob()),
    finalize: vi.fn(async () => ({ itemId: 'managed:abc123', duplicate: false })),
    removeJob: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('download state machine (pure transitions)', () => {
  it('lists only missing chapters so a resume fills the gaps', () => {
    const state = runtimeFromPersisted(persistedJob());
    expect(missingChapterIndices(state)).toEqual([1]);
    expect(chapterProgress(state)).toEqual({ done: 2, failed: 0, total: 3 });
    expect(formatDownloadProgress({ ...state, phase: 'downloading' })).toBe('2/3');
  });

  it('treats persisted failed chapters as missing on resume', () => {
    const state = runtimeFromPersisted(
      persistedJob({
        chapters: [
          persistedChapter(0, 'done', { content: '甲' }),
          persistedChapter(1, 'failed', { error: '网络中断' }),
        ],
      }),
    );
    expect(missingChapterIndices(state)).toEqual([1]);
  });

  it('keeps completed chapters intact when one chapter fails', () => {
    let state = runtimeFromPersisted(persistedJob());
    state = chapterSucceeded(state, 1, '乙');
    state = chapterFailed(state, 0, '超时');
    expect(state.chapters[0]).toMatchObject({ status: 'failed', error: '超时' });
    expect(state.chapters[1]).toMatchObject({ status: 'done', content: '乙' });
    expect(state.chapters[2]).toMatchObject({ status: 'done', content: '丙' });
    expect(missingChapterIndices(state)).toEqual([0]);
  });

  it('pauses by demoting the active chapter back to pending', () => {
    let state = runtimeFromPersisted(persistedJob());
    state = { ...state, phase: 'downloading' };
    state = { ...state, chapters: state.chapters.map((c) => ({ ...c, status: 'active' as const })) };
    const paused = downloadPaused(state);
    expect(paused.phase).toBe('paused');
    expect(paused.chapters.every((chapter) => chapter.status === 'pending')).toBe(true);
  });

  it('returns a failed compose to ready with all chapters still done', () => {
    let state = runtimeFromPersisted(
      persistedJob({
        chapters: [
          persistedChapter(0, 'done', { content: '甲' }),
          persistedChapter(1, 'done', { content: '乙' }),
        ],
      }),
    );
    state = composeFailed(state, '入库失败');
    expect(state.phase).toBe('ready');
    expect(state.chapters.every((chapter) => chapter.status === 'done')).toBe(true);
    expect(missingChapterIndices(state)).toEqual([]);
    const done = composeSucceeded(state, 'managed:abc');
    expect(done.phase).toBe('done');
    expect(done.importedItemId).toBe('managed:abc');
  });
});

describe('EPUB 合成确定性（跨作业 SHA-256 去重前提）', () => {
  const doneJob = (): BookDownloadPersistedJob =>
    persistedJob({
      outputFormat: 'epub',
      status: 'ready',
      chapters: [
        persistedChapter(0, 'done', { content: '甲' }),
        persistedChapter(1, 'done', { content: '乙' }),
        persistedChapter(2, 'done', { content: '丙' }),
      ],
    });

  it('同内容两次合成产出完全相同的字节', async () => {
    const state = runtimeFromPersisted(doneJob());
    const first = await buildDownloadEpub(state, 'zh');
    const second = await buildDownloadEpub(state, 'zh');
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('任一章节内容变化即产生不同字节（不同内容不同条目）', async () => {
    const base = runtimeFromPersisted(doneJob());
    const first = await buildDownloadEpub(base, 'zh');
    const altered = {
      ...base,
      chapters: base.chapters.map((chapter, index) =>
        index === 1 ? { ...chapter, content: '乙改' } : chapter,
      ),
    };
    const second = await buildDownloadEpub(altered, 'zh');
    expect(Array.from(first)).not.toEqual(Array.from(second));
  });
});

describe('download controller (orchestration)', () => {
  it('downloads every chapter in order and finalizes a txt job', async () => {
    const client = mockClient();
    const controller = createBookDownloadController({ client });
    await controller.start(startInput());

    expect(client.createJob).toHaveBeenCalledWith(startInput());
    expect(client.fetchChapter).toHaveBeenCalledTimes(3);
    expect(client.fetchChapter).toHaveBeenNthCalledWith(1, 'job-1', 0);
    expect(client.fetchChapter).toHaveBeenNthCalledWith(2, 'job-1', 1);
    expect(client.fetchChapter).toHaveBeenNthCalledWith(3, 'job-1', 2);
    expect(client.finalize).toHaveBeenCalledWith('job-1', undefined);
    expect(controller.state.phase).toBe('done');
    expect(controller.state.importedItemId).toBe('managed:abc123');
  });

  it('resumes a persisted job and only fetches the missing chapter', async () => {
    const client = mockClient();
    const controller = createBookDownloadController({ client });
    await controller.resume('job-1');

    expect(client.getJob).toHaveBeenCalledWith('job-1');
    expect(client.fetchChapter).toHaveBeenCalledTimes(1);
    expect(client.fetchChapter).toHaveBeenCalledWith('job-1', 1);
    expect(client.finalize).toHaveBeenCalledWith('job-1', undefined);
    expect(controller.state.phase).toBe('done');
  });

  it('keeps other chapters going when one fails, then retries just the failure', async () => {
    const fetchChapter = vi.fn(async (_jobId: string, indexNo: number) => {
      if (indexNo === 1) {
        throw new Error('章节抓取失败');
      }
      return persistedChapter(indexNo, 'done', { content: `内容${indexNo}` });
    });
    const client = mockClient({ fetchChapter });
    const controller = createBookDownloadController({ client, retryDelayMs: 0 });
    await controller.start(startInput());

    expect(controller.state.phase).toBe('incomplete');
    expect(fetchChapter).toHaveBeenCalledTimes(5);
    expect(controller.state.chapters[1]).toMatchObject({ status: 'failed', error: '章节抓取失败' });
    expect(controller.state.chapters[0]).toMatchObject({ status: 'done' });
    expect(controller.state.chapters[2]).toMatchObject({ status: 'done' });
    expect(client.finalize).not.toHaveBeenCalled();

    fetchChapter.mockResolvedValue(persistedChapter(1, 'done', { content: '乙' }));
    controller.retryFailed();
    await settle();

    expect(fetchChapter).toHaveBeenCalledTimes(6);
    expect(controller.state.phase).toBe('done');
    expect(client.finalize).toHaveBeenCalled();
  });

  it('retries a transient chapter failure and still imports the book', async () => {
    let attempts = 0;
    const fetchChapter = vi.fn(async (_jobId: string, indexNo: number) => {
      if (indexNo === 1 && attempts === 0) {
        attempts += 1;
        throw new Error('暂时无法连接');
      }
      return persistedChapter(indexNo, 'done', { content: `内容${indexNo}` });
    });
    const client = mockClient({ fetchChapter });
    const seen: string[] = [];
    const controller = createBookDownloadController({
      client,
      retryDelayMs: 0,
      onState: (state) => {
        const label = formatDownloadProgress(state);
        if (label !== '') seen.push(label);
      },
    });
    await controller.start(startInput());

    expect(controller.state.phase).toBe('done');
    expect(fetchChapter).toHaveBeenCalledTimes(4);
    expect(seen.some((label) => label.startsWith('0/3') || label.startsWith('1/3'))).toBe(true);
    expect(client.finalize).toHaveBeenCalled();
  });

  it('pauses on cancel and can resume to fill the remaining chapters', async () => {
    let releaseChapter: ((chapter: BookDownloadPersistedChapter) => void) | undefined;
    let calls = 0;
    const fetchChapter = vi.fn((_jobId: string, indexNo: number) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(persistedChapter(indexNo, 'done', { content: 'x' }));
      }
      return new Promise<BookDownloadPersistedChapter>((resolve) => {
        releaseChapter = () => resolve(persistedChapter(indexNo, 'done', { content: '甲' }));
      });
    });
    const client = mockClient({ fetchChapter });
    const controller = createBookDownloadController({ client });
    const running = controller.start(startInput());
    await settle();

    controller.cancel();
    releaseChapter?.(persistedChapter(0, 'done', { content: '甲' }));
    await running;

    expect(controller.state.phase).toBe('paused');
    expect(fetchChapter).toHaveBeenCalledTimes(1);
    expect(client.finalize).not.toHaveBeenCalled();

    await controller.resume('job-1');
    expect(client.finalize).toHaveBeenCalledWith('job-1', undefined);
    expect(controller.state.phase).toBe('done');
  });

  it('passes composed epub bytes to finalize for epub jobs', async () => {
    const client = mockClient();
    const controller = createBookDownloadController({ client });
    await controller.start(startInput({ format: 'epub' }));

    expect(client.finalize).toHaveBeenCalledTimes(1);
    const [, base64] = (client.finalize as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string | undefined,
    ];
    expect(typeof base64).toBe('string');
    expect((base64 ?? '').length).toBeGreaterThan(0);
    expect(controller.state.phase).toBe('done');
  });

  it('returns to ready when compose fails and can rebuild', async () => {
    const finalize = vi
      .fn<() => Promise<{ itemId: string; duplicate: boolean }>>()
      .mockRejectedValueOnce(new Error('入库失败'))
      .mockResolvedValue({ itemId: 'managed:abc', duplicate: false });
    const client = mockClient({ finalize });
    const controller = createBookDownloadController({ client });
    await controller.start(
      startInput({ chapters: [{ title: '第1章', url: 'https://books.example/ch/0' }] }),
    );

    expect(controller.state.phase).toBe('ready');
    expect(controller.state.message).toContain('入库失败');
    // 章节保持完成：重建不需要重新下载。
    expect(client.fetchChapter).toHaveBeenCalledTimes(1);

    controller.retryFinalize();
    await settle();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(controller.state.phase).toBe('done');
  });

  it('reports job creation failures without touching chapter state', async () => {
    const client = mockClient({
      createJob: vi.fn(async () => {
        throw new Error('无法创建作业');
      }),
    });
    const controller = createBookDownloadController({ client });
    await controller.start(startInput());

    expect(controller.state.phase).toBe('incomplete');
    expect(controller.state.message).toContain('无法创建作业');
    expect(client.fetchChapter).not.toHaveBeenCalled();
  });

  it('resets to idle on dismiss', async () => {
    const client = mockClient();
    const controller = createBookDownloadController({ client });
    await controller.start(
      startInput({ chapters: [{ title: '第1章', url: 'https://books.example/ch/0' }] }),
    );
    controller.dismiss();
    expect(controller.state).toEqual(INITIAL_DOWNLOAD_STATE);
  });
});

// ── 真实 client 的 invoke 载荷契约（与 managed.rs 反序列化结构对齐） ────

describe('createBookDownloadClient command payloads (Rust contract)', () => {
  it('sends camelCase keys matching the Rust command signatures', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoker = {
      async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        calls.push({ command, args });
        if (command === 'book_download_job_create') return persistedJob() as T;
        if (command === 'book_download_chapter_fetch') {
          return persistedChapter(0, 'done') as T;
        }
        if (command === 'book_source_chapters') return [] as unknown as T;
        return undefined as T;
      },
    };
    const client = createBookDownloadClient(invoker);

    await client.createJob(startInput({ format: 'epub', language: 'en' }));
    await client.fetchChapter('job-1', 2);
    await client.getJob('job-1');
    await client.finalize('job-1', 'QUJD');
    await client.removeJob('job-1');

    expect(calls.map((call) => call.command)).toEqual([
      'book_download_job_create',
      'book_download_chapter_fetch',
      'book_download_job_get',
      'book_download_finalize',
      'book_download_job_remove',
    ]);
    // `BookDownloadJobInput` 期望 camelCase 键，格式字段名为 `outputFormat`。
    const createInput = calls[0].args?.input as Record<string, unknown>;
    expect(Object.keys(createInput).sort()).toEqual([
      'author',
      'bookUrl',
      'chapters',
      'outputFormat',
      'sourceId',
      'title',
    ]);
    expect(createInput.outputFormat).toBe('epub');
    expect(calls[1].args).toEqual({ jobId: 'job-1', indexNo: 2 });
    expect(calls[2].args).toEqual({ jobId: 'job-1', includeContent: true });
    expect(calls[3].args).toEqual({ jobId: 'job-1', epubBase64: 'QUJD' });
    expect(calls[4].args).toEqual({ jobId: 'job-1' });
  });
});

// ── 面板接入（搜索 → 确认目录 → 下载） ─────────────────────────────────

describe('book source panel download entry', () => {
  function panelDeps() {
    const searchResults = [
      {
        sourceId: 'source-1',
        sourceTitle: '示例源',
        title: '第一部',
        author: '作者甲',
        url: 'https://books.example/book/1',
      },
    ];
    const panelClient = {
      listSources: vi.fn(async () => [
        {
          id: 'source-1',
          title: '示例源',
          rule: {
            version: 1,
            baseUrl: 'https://books.example',
            search: {
              url: '/search?q={{key}}',
              item: '<li class="entry">(?s)(.*?)</li>',
              title: '<span class="title">(?s)(.*?)</span>',
              link: 'href="([^"]+)"',
            },
          },
          enabled: true,
          allowHttp: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      upsertSource: vi.fn(),
      removeSource: vi.fn(),
      setSourceEnabled: vi.fn(),
      importSources: vi.fn(),
      exportSources: vi.fn(),
      selfCheck: vi.fn(),
      builtins: vi.fn(async () => []),
      search: vi.fn(async () => searchResults),
    };
    const downloads = {
      ...mockClient(),
      chapters: vi.fn(async () => [
        { title: '第1章', url: 'https://books.example/ch/0' },
        { title: '第2章', url: 'https://books.example/ch/1' },
      ]),
    };
    return { panelClient, downloads };
  }

  async function mountPanel() {
    const { createBookSourcePanel } = await import('../book-source-panel.js');
    const { panelClient, downloads } = panelDeps();
    const panel = createBookSourcePanel({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: panelClient as any,
      getLocale: () => 'zh-CN',
      downloads,
    });
    document.body.appendChild(panel.element);
    await panel.show();
    return { panel, downloads };
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

  it('starts a download from a search result through catalog confirmation', async () => {
    const { panel, downloads } = await mountPanel();

    const row = panel.element.querySelector<HTMLElement>('[data-source-id="source-1"]')!;
    buttonByText(row, '搜索').click();
    const searchSection = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-search',
    )!;
    searchSection.querySelector<HTMLInputElement>('input')!.value = '关键词';
    searchSection.querySelector<HTMLButtonElement>('.lightink-library-primary')!.click();
    await settle();

    const result = panel.element.querySelector<HTMLElement>('.lightink-library-book-source-result')!;
    buttonByText(result, '下载').click();
    await settle();

    expect(downloads.chapters).toHaveBeenCalledWith('source-1', 'https://books.example/book/1');
    const section = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-download',
    )!;
    expect(section.hidden).toBe(false);
    expect(section.textContent).toContain('第一部');
    expect(section.textContent).toContain('2');
    expect(
      section.querySelectorAll('.lightink-library-book-source-download-chapter').length,
    ).toBe(2);

    buttonByText(section, '开始下载').click();
    await settle();
    await settle();
    await settle();
    await settle();

    expect(downloads.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        bookUrl: 'https://books.example/book/1',
        format: 'txt',
        chapters: [
          { title: '第1章', url: 'https://books.example/ch/0' },
          { title: '第2章', url: 'https://books.example/ch/1' },
        ],
      }),
    );
    expect(downloads.finalize).toHaveBeenCalledWith('job-1', undefined);
    expect(section.dataset.status ?? '').toBe('');
    expect(section.textContent).toContain('已入库');
    expect(
      section.querySelectorAll('.lightink-library-book-source-download-chapter[data-status="done"]')
        .length,
    ).toBe(2);
    panel.destroy();
  });

  it('shows the catalog failure message when the toc cannot be read', async () => {
    const { panel, downloads } = await mountPanel();
    (downloads.chapters as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('书源规则未配置目录提取'),
    );

    const row = panel.element.querySelector<HTMLElement>('[data-source-id="source-1"]')!;
    buttonByText(row, '搜索').click();
    const searchSection = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-search',
    )!;
    searchSection.querySelector<HTMLInputElement>('input')!.value = '关键词';
    searchSection.querySelector<HTMLButtonElement>('.lightink-library-primary')!.click();
    await settle();
    const result = panel.element.querySelector<HTMLElement>('.lightink-library-book-source-result')!;
    buttonByText(result, '下载').click();
    await settle();

    const section = panel.element.querySelector<HTMLElement>(
      '.lightink-library-book-source-download',
    )!;
    expect(section.textContent).toContain('无法读取目录');
    expect(downloads.createJob).not.toHaveBeenCalled();
    panel.destroy();
  });
});
