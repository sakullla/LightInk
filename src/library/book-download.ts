/**
 * `book-download` — 通用书源下载管线（R8 / ADR-7）。
 *
 * 前端编排「搜索 → 聚合去重 → 选源 → 章节断点下载 → 合成」：
 * - 状态机是纯函数（phase/章节级状态转移），断点续传只补缺失章节、单章失败
 *   可重试且不影响已完成章节、合成失败回到 ready 可重试（不产生半成品）。
 * - 网络与落盘走 Rust 窄命令：创建作业、按章抓取（写章节状态）、读作业状态、
 *   合成入库（TXT 在 Rust 拼接；EPUB 在前端用 `epub-builder` 合成后把字节
 *   交 `book_download_finalize`，受管链按 SHA-256 去重）。
 */

import { invoke } from '@tauri-apps/api/core';

import { escapeXmlText } from './book-translation/blocks.js';
import { buildTranslatedEpub } from './book-translation/epub-builder.js';
import type { TranslationUnit } from './book-translation/types.js';

export type BookDownloadFormat = 'txt' | 'epub';

export type BookDownloadPhase =
  | 'idle'
  | 'starting'
  | 'downloading'
  | 'paused'
  | 'incomplete'
  | 'ready'
  | 'composing'
  | 'done';

export type BookDownloadChapterRuntimeStatus = 'pending' | 'active' | 'done' | 'failed';

export interface BookDownloadChapterRuntime {
  readonly indexNo: number;
  readonly title: string;
  status: BookDownloadChapterRuntimeStatus;
  error?: string;
  /** 已完成章节的正文（EPUB 合成与断点续传展示用）。 */
  content?: string;
}

export interface BookDownloadState {
  readonly phase: BookDownloadPhase;
  readonly jobId?: string;
  readonly title: string;
  readonly format: BookDownloadFormat;
  readonly chapters: readonly BookDownloadChapterRuntime[];
  readonly importedItemId?: string;
  readonly message?: string;
}

export const INITIAL_DOWNLOAD_STATE: BookDownloadState = {
  phase: 'idle',
  title: '',
  format: 'txt',
  chapters: [],
};

// ── Rust 窄命令载荷（与 `managed.rs` 结构同构） ────────────────────────

export interface BookDownloadChapterInput {
  readonly title: string;
  readonly url: string;
}

export interface BookDownloadStartInput {
  readonly sourceId: string;
  readonly title: string;
  readonly author?: string;
  readonly bookUrl: string;
  readonly format: BookDownloadFormat;
  readonly chapters: readonly BookDownloadChapterInput[];
  /** EPUB 合成语言（dc:language），缺省 zh。 */
  readonly language?: string;
}

export interface BookDownloadPersistedChapter {
  readonly indexNo: number;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  readonly bytes?: number;
  readonly error?: string;
  readonly content?: string;
}

export interface BookDownloadPersistedJob {
  readonly id: string;
  readonly sourceId?: string;
  readonly title: string;
  readonly author?: string;
  readonly bookUrl: string;
  readonly outputFormat: string;
  readonly status: string;
  readonly totalChapters: number;
  readonly chapters: readonly BookDownloadPersistedChapter[];
}

export interface BookDownloadFinalizeResult {
  readonly itemId: string;
  readonly duplicate: boolean;
}

export interface BookDownloadClient {
  createJob(input: BookDownloadStartInput): Promise<BookDownloadPersistedJob>;
  fetchChapter(jobId: string, indexNo: number): Promise<BookDownloadPersistedChapter>;
  getJob(jobId: string): Promise<BookDownloadPersistedJob>;
  finalize(jobId: string, epubBase64?: string): Promise<BookDownloadFinalizeResult>;
  removeJob(jobId: string): Promise<void>;
}

/** 目录读取（确认目录步骤）复用书源引擎的 `book_source_chapters`。 */
export interface BookDownloadCatalogClient {
  chapters(
    sourceId: string,
    bookUrl: string,
  ): Promise<readonly BookDownloadChapterInput[]>;
}

export type BookDownloadPanelClient = BookDownloadClient & BookDownloadCatalogClient;

export function createBookDownloadClient(invoker: {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}): BookDownloadPanelClient {
  return {
    // Rust `BookDownloadJobInput` 以 camelCase 反序列化（`outputFormat`），
    // 前端在 client 单侧收口映射；`format`/`language` 是前端编排字段，不下发。
    createJob: (input) =>
      invoker.invoke<BookDownloadPersistedJob>('book_download_job_create', {
        input: {
          sourceId: input.sourceId,
          title: input.title,
          author: input.author,
          bookUrl: input.bookUrl,
          outputFormat: input.format,
          chapters: input.chapters,
        },
      }),
    fetchChapter: (jobId, indexNo) =>
      invoker.invoke<BookDownloadPersistedChapter>('book_download_chapter_fetch', {
        jobId,
        indexNo,
      }),
    getJob: (jobId) =>
      invoker.invoke<BookDownloadPersistedJob>('book_download_job_get', {
        jobId,
        includeContent: true,
      }),
    finalize: (jobId, epubBase64) =>
      invoker.invoke<BookDownloadFinalizeResult>('book_download_finalize', {
        jobId,
        epubBase64,
      }),
    removeJob: (jobId) => invoker.invoke<void>('book_download_job_remove', { jobId }),
    chapters: (sourceId, bookUrl) =>
      invoker.invoke<BookDownloadChapterInput[]>('book_source_chapters', { sourceId, bookUrl }),
  };
}

/** 默认 Tauri 客户端；测试/降级环境注入 mock 替代。 */
export const bookDownloadClient: BookDownloadPanelClient = createBookDownloadClient({ invoke });

// ── 纯状态转移 ────────────────────────────────────────────────────────

function updateChapter(
  state: BookDownloadState,
  indexNo: number,
  update: (chapter: BookDownloadChapterRuntime) => BookDownloadChapterRuntime,
): BookDownloadState {
  return {
    ...state,
    chapters: state.chapters.map((chapter) =>
      chapter.indexNo === indexNo ? update(chapter) : chapter,
    ),
  };
}

/** 缺失章节 = 未完成（pending/failed）；断点续传/重试的规划口径。 */
export function missingChapterIndices(state: BookDownloadState): number[] {
  return state.chapters.filter((chapter) => chapter.status !== 'done').map((chapter) => chapter.indexNo);
}

/**
 * 待抓取章节 = pending。下载循环只取 pending：失败章节保留 failed 状态等
 * 用户重试（retryChapter/retryFailed 把它置回 pending），不会在同一轮里
 * 无限重抓；已完成章节永不再抓。
 */
export function pendingChapterIndices(state: BookDownloadState): number[] {
  return state.chapters.filter((chapter) => chapter.status === 'pending').map((chapter) => chapter.indexNo);
}

export function chapterProgress(state: BookDownloadState): {
  readonly done: number;
  readonly failed: number;
  readonly total: number;
} {
  return {
    done: state.chapters.filter((chapter) => chapter.status === 'done').length,
    failed: state.chapters.filter((chapter) => chapter.status === 'failed').length,
    total: state.chapters.length,
  };
}

/** 进度文案：`12/120 · 失败1 · 章节名`。面板和助手芯片共用。 */
export function formatDownloadProgress(state: BookDownloadState): string {
  const { done, failed, total } = chapterProgress(state);
  if (total === 0) return '';
  const active = state.chapters.find((chapter) => chapter.status === 'active');
  const parts = [`${done}/${total}`];
  if (failed > 0) parts.push(`失败${failed}`);
  if (active !== undefined && state.phase === 'downloading') parts.push(active.title);
  return parts.join(' · ');
}

export function runtimeFromPersisted(job: BookDownloadPersistedJob): BookDownloadState {
  const format: BookDownloadFormat = job.outputFormat === 'epub' ? 'epub' : 'txt';
  return {
    phase: 'downloading',
    jobId: job.id,
    title: job.title,
    format,
    chapters: job.chapters.map((chapter) => ({
      indexNo: chapter.indexNo,
      title: chapter.title,
      status: chapter.status === 'done' ? 'done' : 'pending',
      content: chapter.content,
    })),
  };
}

export function chapterStarted(state: BookDownloadState, indexNo: number): BookDownloadState {
  return updateChapter(state, indexNo, (chapter) => ({
    ...chapter,
    status: 'active',
    error: undefined,
  }));
}

export function chapterSucceeded(
  state: BookDownloadState,
  indexNo: number,
  content?: string,
): BookDownloadState {
  return updateChapter(state, indexNo, (chapter) => ({
    ...chapter,
    status: 'done',
    error: undefined,
    content: content ?? chapter.content,
  }));
}

export function chapterFailed(
  state: BookDownloadState,
  indexNo: number,
  error: string,
): BookDownloadState {
  return updateChapter(state, indexNo, (chapter) => ({
    ...chapter,
    status: 'failed',
    error,
    // 已完成章节的内容与状态不受失败章节影响。
    content: chapter.status === 'done' ? chapter.content : undefined,
  }));
}

export function downloadPaused(state: BookDownloadState): BookDownloadState {
  if (state.phase !== 'downloading') return state;
  return {
    ...state,
    phase: 'paused',
    chapters: state.chapters.map((chapter) =>
      chapter.status === 'active' ? { ...chapter, status: 'pending' } : chapter,
    ),
  };
}

export function chapterRetried(state: BookDownloadState, indexNo: number): BookDownloadState {
  return updateChapter(state, indexNo, (chapter) => ({
    ...chapter,
    status: 'pending',
    error: undefined,
  }));
}

export function downloadIncomplete(state: BookDownloadState, message: string): BookDownloadState {
  return { ...state, phase: 'incomplete', message };
}

export function composeStarted(state: BookDownloadState): BookDownloadState {
  return { ...state, phase: 'composing', message: undefined };
}

export function composeSucceeded(
  state: BookDownloadState,
  itemId: string,
): BookDownloadState {
  return { ...state, phase: 'done', importedItemId: itemId, message: undefined };
}

/** 合成失败：章节保持完成态、作业可重试（半成品由 Rust 侧回滚保证不落库）。 */
export function composeFailed(state: BookDownloadState, message: string): BookDownloadState {
  return { ...state, phase: 'ready', message };
}

// ── EPUB 合成（前端 epub-builder → base64 交窄命令） ──────────────────

function chapterBodyXhtml(content: string | undefined): string {
  const paragraphs = (content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => `<p>${escapeXmlText(line)}</p>`);
  return paragraphs.length > 0 ? paragraphs.join('\n') : '<p></p>';
}

export async function buildDownloadEpub(
  state: BookDownloadState,
  language: string,
): Promise<Uint8Array> {
  const units: TranslationUnit[] = state.chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    blocks: [],
  }));
  const unitBodies = state.chapters.map((chapter) => chapterBodyXhtml(chapter.content));
  return buildTranslatedEpub({ units, unitBodies, title: state.title, language });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// ── 控制器（编排循环；网络全部经注入的 client） ────────────────────────

export interface BookDownloadController {
  readonly state: BookDownloadState;
  start(input: BookDownloadStartInput): Promise<void>;
  resume(jobId: string): Promise<void>;
  cancel(): void;
  retryChapter(indexNo: number): void;
  retryFailed(): void;
  retryFinalize(): void;
  dismiss(): void;
}

/** 同一章在标记失败前的抓取次数。Rust 侧每次抓取还会再试瞬时网络错误。 */
const CHAPTER_FETCH_ATTEMPTS = 3;

let activeDownloadCancel: (() => void) | undefined;

/** 当前下载可被助手的停止键打断。后一次下载覆盖前一次。 */
export function bindActiveDownloadCancel(cancel: () => void): () => void {
  activeDownloadCancel = cancel;
  return () => {
    if (activeDownloadCancel === cancel) {
      activeDownloadCancel = undefined;
    }
  };
}

export function cancelActiveDownload(): void {
  activeDownloadCancel?.();
}

export interface BookDownloadControllerOptions {
  readonly client: BookDownloadClient;
  readonly onState?: (state: BookDownloadState) => void;
  /** 章内重试间隔。测试可传 0。 */
  readonly retryDelayMs?: number;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

export function createBookDownloadController(
  options: BookDownloadControllerOptions,
): BookDownloadController {
  const { client } = options;
  let state: BookDownloadState = INITIAL_DOWNLOAD_STATE;
  let cancelRequested = false;
  let running = false;
  let epubLanguage = 'zh';

  function emit(): void {
    options.onState?.(state);
  }

  function setState(next: BookDownloadState): void {
    state = next;
    emit();
  }

  async function finalize(): Promise<void> {
    const jobId = state.jobId;
    if (jobId === undefined) return;
    setState(composeStarted(state));
    try {
      let epubBase64: string | undefined;
      if (state.format === 'epub') {
        const bytes = await buildDownloadEpub(state, epubLanguage);
        epubBase64 = bytesToBase64(bytes);
      }
      const result = await client.finalize(jobId, epubBase64);
      setState(composeSucceeded(state, result.itemId));
    } catch (error) {
      setState(composeFailed(state, errorMessage(error, '合成入库失败')));
    }
  }

  async function fetchChapterWithRetry(jobId: string, indexNo: number): Promise<void> {
    let lastError = '章节下载失败';
    for (let attempt = 0; attempt < CHAPTER_FETCH_ATTEMPTS; attempt += 1) {
      if (cancelRequested) return;
      if (attempt > 0) {
        const delay = options.retryDelayMs ?? 400;
        await new Promise<void>((resolve) => setTimeout(resolve, delay * attempt));
        if (cancelRequested) return;
      }
      setState(chapterStarted(state, indexNo));
      try {
        const chapter = await client.fetchChapter(jobId, indexNo);
        setState(chapterSucceeded(state, indexNo, chapter.content));
        return;
      } catch (error) {
        lastError = errorMessage(error, '章节下载失败');
      }
    }
    if (!cancelRequested) {
      setState(chapterFailed(state, indexNo, lastError));
    }
  }

  async function runLoop(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (cancelRequested) {
          setState(downloadPaused(state));
          return;
        }
        const missing = pendingChapterIndices(state);
        const indexNo = missing[0];
        if (indexNo === undefined) break;
        const jobId = state.jobId;
        if (jobId === undefined) return;
        await fetchChapterWithRetry(jobId, indexNo);
        if (cancelRequested) {
          setState(downloadPaused(state));
          return;
        }
      }
      if (cancelRequested) {
        setState(downloadPaused(state));
        return;
      }
      const { done, failed, total } = chapterProgress(state);
      if (failed > 0) {
        setState(
          downloadIncomplete(state, `${done}/${total}，${failed} 章失败。已完成的不会重下，可重试失败章。`),
        );
        return;
      }
      await finalize();
    } finally {
      running = false;
    }
  }

  return {
    get state() {
      return state;
    },
    async start(input) {
      cancelRequested = false;
      epubLanguage = input.language ?? 'zh';
      setState({ ...INITIAL_DOWNLOAD_STATE, phase: 'starting', title: input.title, format: input.format });
      try {
        const job = await client.createJob(input);
        if (cancelRequested) {
          setState(downloadPaused(runtimeFromPersisted(job)));
          return;
        }
        setState(runtimeFromPersisted(job));
      } catch (error) {
        setState(
          downloadIncomplete(state, errorMessage(error, '无法创建下载作业')),
        );
        return;
      }
      await runLoop();
    },
    async resume(jobId) {
      cancelRequested = false;
      setState({ ...INITIAL_DOWNLOAD_STATE, phase: 'starting', title: '', format: 'txt' });
      try {
        const job = await client.getJob(jobId);
        setState(runtimeFromPersisted(job));
      } catch (error) {
        setState(
          downloadIncomplete(state, errorMessage(error, '无法读取下载作业')),
        );
        return;
      }
      await runLoop();
    },
    cancel() {
      cancelRequested = true;
    },
    retryChapter(indexNo) {
      if (state.phase !== 'incomplete' && state.phase !== 'paused') return;
      cancelRequested = false;
      setState(chapterRetried(state, indexNo));
      void runLoop();
    },
    retryFailed() {
      if (state.phase !== 'incomplete' && state.phase !== 'paused') return;
      cancelRequested = false;
      setState({
        ...state,
        phase: 'downloading',
        chapters: state.chapters.map((chapter) =>
          chapter.status === 'failed'
            ? { ...chapter, status: 'pending', error: undefined }
            : chapter,
        ),
      });
      void runLoop();
    },
    retryFinalize() {
      if (state.phase !== 'ready' && state.phase !== 'incomplete') return;
      if (state.phase === 'incomplete' && missingChapterIndices(state).length > 0) return;
      void finalize();
    },
    dismiss() {
      cancelRequested = true;
      setState(INITIAL_DOWNLOAD_STATE);
    },
  };
}
