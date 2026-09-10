/**
 * `controller` — 整本翻译前端编排（ADR-5 / R4）。
 *
 * 发起流程：配置检查（未配置 → 配置引导）→ 后台解析分块 → 字数与预估成本
 * 确认 → 逐块翻译（prompt 携带按书术语表，ai.rs 同一网络栈）→ 每块译文
 * 落盘断点（关闭应用/断网即天然断点；重发起跳过 done 块不重译）→ 重组
 * EPUB → 受管导入书库（独立译本条目，进度按内容哈希独立）→ 清缓存。
 *
 * 「暂停」与「取消」行为一致：停止编排并保留缓存（R4 验收），再次发起
 * 续译；不新造暂停协议。取消只停翻译循环——已完成的块全部保留。
 */

import type { LibraryItem } from '../library-client.js';
import type { LocaleId, MessageKey } from '../../i18n/messages.js';
import { aiTranslateTargetLang, readerAiErrorMessage } from '../../reader/lookup-panel.js';
import { readerLoadErrorDetail } from '../../reader/error-message.js';
import type { ReaderContent } from '../../reader/formats/types.js';
import {
  extractTranslationBlocks,
  rebuildTranslatedBody,
  splitTranslatedParagraphs,
} from './blocks.js';
import {
  BOOK_CHUNK_CHAR_LIMIT,
  chunkIndexesByChapter,
  planTranslationChunks,
  plannedSourceChars,
} from './chunker.js';
import {
  glossaryForPrompt,
  mergeGlossary,
  parseGlossaryTail,
} from './glossary.js';
import {
  buildTranslatedEpub,
  epubUnitsFromBodies,
  prepareEpubTranslation,
  rebuildTranslatedEpub,
} from './epub-builder.js';
import {
  initialBookTranslationState,
  parseBookTranslationState,
  planResume,
  serializeBookTranslationState,
  withChunkDone,
} from './state.js';
import type {
  BookTranslationEstimate,
  BookTranslationStatus,
  GlossaryEntry,
  TranslationUnit,
} from './types.js';

export interface BookTranslationLaunchRequest {
  readonly path: string;
  readonly title: string;
  readonly extension: string;
}

export type BookTranslationLaunchResult =
  | 'completed'
  | 'cancelled'
  | 'paused'
  | 'guided'
  | 'failed';

/** 单块翻译有界重试：首次 + 2 次重试（R4「有限次重试，仍失败则暂停可续译」）。 */
const CHUNK_ATTEMPTS = 3;
const CHUNK_RETRY_DELAY_MS = 800;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 一次装载结果：翻译单元 + 译本构建闭包（EPUB 原包字节闭包持有）。 */
export interface BookPayload {
  readonly kind: 'epub' | 'fresh';
  readonly sourceTitle: string;
  readonly units: readonly TranslationUnit[];
  readonly build: (
    unitBodies: readonly string[],
    meta: { title: string; language: string },
  ) => Promise<Uint8Array>;
}

export interface BookTranslationDeps {
  readonly getLocale: () => LocaleId;
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** AI 配置完备判定（R4：未配置显示配置引导）。 */
  readonly aiConfigured: () => Promise<{ configured: boolean; missing: readonly string[] }>;
  /** AI 分组目标语言覆盖项（缺省视为 auto 跟随界面语言）。 */
  readonly aiTargetLangOverride: () => Promise<string | undefined>;
  readonly translateChunk: (
    text: string,
    targetLang: string,
    glossary: readonly GlossaryEntry[],
    signal?: AbortSignal,
  ) => Promise<{ text: string }>;
  readonly readState: (contentHash: string) => Promise<string>;
  readonly writeState: (contentHash: string, json: string) => Promise<void>;
  readonly readChunk: (contentHash: string, chunkIndex: number) => Promise<string>;
  readonly writeChunk: (contentHash: string, chunkIndex: number, text: string) => Promise<void>;
  readonly clearTranslation: (contentHash: string) => Promise<void>;
  readonly getContentHash: (path: string) => Promise<string>;
  /** 读原书字节（默认 read_file_bytes raw IPC；测试注入）。 */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  /** 装载翻译单元（缺省 EPUB 原包 / parseReaderContent 两路；测试注入）。 */
  readonly loadPayload?: (
    request: BookTranslationLaunchRequest,
    bytes: Uint8Array,
  ) => Promise<BookPayload>;
  readonly importEpub: (bytes: Uint8Array) => Promise<LibraryItem>;
  readonly upsertItem: (item: LibraryItem) => Promise<void>;
  readonly confirmStart: (estimate: BookTranslationEstimate) => Promise<boolean>;
  readonly notify: (message: string, kind?: 'error' | 'warning' | 'info') => void;
  /** 未配置时的「前往配置」动作（默认广播 lightink:open-manage）。 */
  readonly openManageAi: () => void;
  /** 译本入库后回调（书架刷新）。 */
  readonly onImported?: (item: LibraryItem) => void;
}

/** 默认单元装载：EPUB 走原包重组路径；TXT/FB2/MOBI 走 parseReaderContent 新组。 */
export async function loadBookPayload(
  request: BookTranslationLaunchRequest,
  bytes: Uint8Array,
): Promise<BookPayload> {
  const ext = request.extension.toLowerCase();
  if (ext === 'epub') {
    const prepared = await prepareEpubTranslation(bytes);
    const units = epubUnitsFromBodies(prepared.spine, prepared.bodies);
    const spinePaths = prepared.spine.map((item) => item.zipPath);
    return {
      kind: 'epub',
      sourceTitle: units[0]?.title || request.title,
      units,
      build: (unitBodies, meta) =>
        rebuildTranslatedEpub({
          originalBytes: bytes,
          spinePaths,
          unitBodies,
          title: meta.title,
        }),
    };
  }
  const { parseReaderContent } = await import('../../reader/formats/index.js');
  const content: ReaderContent = await parseReaderContent(request.path, bytes);
  try {
    const units: TranslationUnit[] = [];
    for (const [index, chapter] of content.chapters.entries()) {
      await chapter.load?.();
      let html = chapter.html;
      if (content.embedExportImages !== undefined) {
        // FB2 内嵌图片 blob → data URI（新组 EPUB 自包含；TXT/MOBI 无图不受影响）。
        const embedded = await content.embedExportImages(html, 'inline');
        html = embedded.html;
      }
      units.push({
        index,
        title: chapter.title || `${index + 1}`,
        blocks: extractTranslationBlocks(html),
      });
    }
    return {
      kind: 'fresh',
      sourceTitle: request.title,
      units,
      build: (unitBodies, meta) =>
        buildTranslatedEpub({ units, unitBodies, title: meta.title, language: meta.language }),
    };
  } finally {
    content.dispose?.();
  }
}

function notifyUnconfigured(
  deps: Pick<BookTranslationDeps, 'notify' | 'openManageAi' | 't'>,
  missing: readonly string[],
): void {
  deps.notify(
    missing.length > 0
      ? deps.t('reader.ai.error.unconfigured').split('{missing}').join(missing.join(', '))
      : deps.t('library.translate.unconfigured'),
    'warning',
  );
  deps.openManageAi();
}

export interface BookTranslationController {
  /** 发起（或续译）一本书；resolve 于终态（完成/取消/暂停/引导/失败）。 */
  launch(
    request: BookTranslationLaunchRequest,
    options?: { onConfirmed?: () => void },
  ): Promise<BookTranslationLaunchResult>;
  /** 暂停/取消（与取消同义实现：停编排、留缓存）。 */
  cancel(path: string): void;
  statusFor(path: string): BookTranslationStatus | null;
  subscribe(listener: (path: string) => void): () => void;
  destroy(): void;
}

function chaptersDone(
  chunkGroups: readonly number[][],
  done: readonly boolean[],
): number {
  // done 数组只增不减；按已完成块序号统计每章是否全齐。
  let doneChapters = 0;
  for (const group of chunkGroups) {
    if (group.every((index) => done[index] === true)) {
      doneChapters += 1;
    }
  }
  return doneChapters;
}

export function createBookTranslationController(
  deps: BookTranslationDeps,
): BookTranslationController {
  const statuses = new Map<string, BookTranslationStatus>();
  const aborters = new Map<string, AbortController>();
  const listeners = new Set<(path: string) => void>();

  const emit = (path: string): void => {
    for (const listener of listeners) {
      try {
        listener(path);
      } catch {
        // 订阅方渲染失败不阻断编排。
      }
    }
  };

  const setStatus = (status: BookTranslationStatus): void => {
    statuses.set(status.path, status);
    emit(status.path);
  };

  const localizeError = (error: unknown, missing: readonly string[] = []): string => {
    if (error instanceof Error && error.name === 'ReaderCapabilityError') {
      return readerLoadErrorDetail(error, deps.t);
    }
    const aiMessage = readerAiErrorMessage(deps.t, error, missing);
    if (aiMessage !== deps.t('reader.ai.error.failed')) {
      return aiMessage;
    }
    return readerLoadErrorDetail(error, deps.t);
  };

  const launch = async (
    request: BookTranslationLaunchRequest,
    options?: { onConfirmed?: () => void },
  ): Promise<BookTranslationLaunchResult> => {
    if (aborters.has(request.path)) {
      return 'paused';
    }
    const aborter = new AbortController();
    aborters.set(request.path, aborter);
    const aborted = (): boolean => aborter.signal.aborted;
    const t = deps.t;
    try {
      // ① 配置检查：未配置 → 引导（R4）。
      const config = await deps.aiConfigured();
      if (!config.configured) {
        notifyUnconfigured(deps, config.missing);
        return 'guided';
      }

      // ② 后台解析分块（不打开书；MOBI DRM/KF8 抛能力错误如实呈现）。
      const base = {
        path: request.path,
        title: request.title,
        contentHash: '',
        targetLang: '',
        phase: 'preparing' as const,
        doneChunks: 0,
        totalChunks: 0,
        doneChapters: 0,
        totalChapters: 0,
        currentChapterTitle: '',
        resumedChunks: 0,
      };
      setStatus({ ...base, phase: 'preparing' });
      let payload: BookPayload;
      let contentHash: string;
      let bytes: Uint8Array;
      try {
        bytes = await deps.readBytes(request.path);
        payload = await (deps.loadPayload ?? loadBookPayload)(request, bytes);
        contentHash = await deps.getContentHash(request.path);
      } catch (error) {
        const message = localizeError(error, config.missing);
        setStatus({ ...base, phase: 'error', error: message });
        deps.notify(t('library.translate.failed', { reason: message }), 'error');
        return 'failed';
      }

      const chunks = planTranslationChunks(payload.units, BOOK_CHUNK_CHAR_LIMIT);
      if (chunks.length === 0) {
        const message = t('library.translate.empty');
        setStatus({ ...base, phase: 'error', error: message });
        deps.notify(message, 'warning');
        return 'failed';
      }
      const targetLang = aiTranslateTargetLang(
        t,
        deps.getLocale(),
        await deps.aiTargetLangOverride(),
      );
      const chunkGroups = chunkIndexesByChapter(chunks, payload.units.length);
      const sourceChars = plannedSourceChars(chunks);
      const persisted = parseBookTranslationState(await deps.readState(contentHash));
      const resume = planResume(persisted, chunks.length, targetLang);
      const pending = resume?.pending ?? chunks.map((chunk) => chunk.index);
      const glossary: GlossaryEntry[] = [...(resume?.glossary ?? [])];

      // ③ 字数与预估成本确认（R4：发起前必须确认）。
      const estimate: BookTranslationEstimate = {
        title: payload.sourceTitle,
        targetLang,
        sourceChars,
        totalChunks: chunks.length,
        pendingChunks: pending.length,
        estInputChars: sourceChars + pending.length * 400,
        estOutputChars: sourceChars,
        resumed: resume !== null,
      };
      const confirmed = await deps.confirmStart(estimate);
      if (!confirmed) {
        statuses.delete(request.path);
        emit(request.path);
        return 'cancelled';
      }
      options?.onConfirmed?.();

      // ④ 断点状态首写（锁规划；续译沿用已有完成位）。
      let state =
        resume !== null && persisted !== null
          ? { ...persisted, glossary: [...glossary], updatedAt: Date.now() }
          : initialBookTranslationState(chunks.length, targetLang, sourceChars);
      await deps.writeState(contentHash, serializeBookTranslationState(state));

      setStatus({
        ...base,
        contentHash,
        targetLang,
        phase: 'translating',
        totalChunks: chunks.length,
        totalChapters: payload.units.length,
        doneChunks: chunks.length - pending.length,
        doneChapters: chaptersDone(chunkGroups, state.done),
        resumedChunks: resume?.resumedChunks ?? 0,
      });

      // ⑤ 翻译循环：每块完成即落盘断点。
      for (const chunkIndex of pending) {
        if (aborted()) {
          break;
        }
        const chunk = chunks[chunkIndex]!;
        const unit = payload.units[chunk.chapterIndex];
        setStatus({
          ...statuses.get(request.path)!,
          currentChapterTitle: unit?.title ?? '',
        });
        let result: { text: string } | null = null;
        let lastError: unknown = null;
        for (
          let attempt = 0;
          attempt < CHUNK_ATTEMPTS && result === null && !aborted();
          attempt += 1
        ) {
          try {
            result = await deps.translateChunk(
              chunk.text,
              targetLang,
              glossaryForPrompt(glossary),
              aborter.signal,
            );
          } catch (error) {
            lastError = error;
            if (aborted()) {
              break;
            }
            if (attempt + 1 < CHUNK_ATTEMPTS) {
              await sleep(CHUNK_RETRY_DELAY_MS); // 瞬时网络抖动不等整轮失败
            }
          }
        }
        if (result === null) {
          if (aborted()) {
            break;
          }
          const message = localizeError(lastError, config.missing);
          setStatus({ ...statuses.get(request.path)!, phase: 'error', error: message });
          deps.notify(t('library.translate.failed', { reason: message }), 'error');
          return 'failed';
        }
        if (aborted()) {
          break; // 迟到结果丢弃，缓存保留在最后一个完成块。
        }
        const { clean, entries } = parseGlossaryTail(result.text);
        const merged = mergeGlossary(glossary, entries);
        glossary.length = 0;
        glossary.push(...merged);
        await deps.writeChunk(contentHash, chunkIndex, clean);
        state = withChunkDone(state, chunkIndex, glossary);
        await deps.writeState(contentHash, serializeBookTranslationState(state));
        setStatus({
          ...statuses.get(request.path)!,
          doneChunks: state.done.filter((flag) => flag).length,
          doneChapters: chaptersDone(chunkGroups, state.done),
        });
      }

      if (aborted()) {
        // 「暂停」= 取消的同义实现：缓存保留，再次发起续译（R4）。
        setStatus({ ...statuses.get(request.path)!, phase: 'paused' });
        return 'paused';
      }

      // ⑥ 重组译本 EPUB（块译文从缓存文件读回，跨会话续译同样成立）。
      setStatus({ ...statuses.get(request.path)!, phase: 'building' });
      const unitParagraphStreams: string[][] = payload.units.map(() => []);
      for (const chunk of chunks) {
        const stored = await deps.readChunk(contentHash, chunk.index);
        if (stored.trim() === '') {
          const message = t('library.translate.missingChunk');
          setStatus({ ...statuses.get(request.path)!, phase: 'error', error: message });
          deps.notify(t('library.translate.failed', { reason: message }), 'error');
          return 'failed';
        }
        const stream = unitParagraphStreams[chunk.chapterIndex];
        if (stream === undefined) {
          continue;
        }
        stream.push(...splitTranslatedParagraphs(stored));
      }
      let epubBytes: Uint8Array;
      const resultTitle = t('library.translate.resultTitle', {
        title: payload.sourceTitle,
        lang: targetLang,
      });
      try {
        epubBytes = await payload.build(
          payload.units.map((unit) =>
            rebuildTranslatedBody(
              unit.blocks,
              unitParagraphStreams[unit.index] ?? [],
            ),
          ),
          { title: resultTitle, language: targetLang },
        );
      } catch (error) {
        const message = localizeError(error, config.missing);
        setStatus({ ...statuses.get(request.path)!, phase: 'error', error: message });
        deps.notify(t('library.translate.failed', { reason: message }), 'error');
        return 'failed';
      }

      // ⑦ 受管入库（内容哈希不同自动成新条目）+ 元数据补写 + 清缓存。
      setStatus({ ...statuses.get(request.path)!, phase: 'importing' });
      let item: LibraryItem;
      try {
        item = await deps.importEpub(epubBytes);
        await deps.upsertItem({ ...item, title: resultTitle, updatedAt: Date.now() });
      } catch (error) {
        const message = localizeError(error, config.missing);
        setStatus({ ...statuses.get(request.path)!, phase: 'error', error: message });
        deps.notify(t('library.translate.failed', { reason: message }), 'error');
        return 'failed';
      }
      await deps.clearTranslation(contentHash).catch(() => undefined);
      setStatus({
        ...statuses.get(request.path)!,
        phase: 'done',
        doneChunks: chunks.length,
        doneChapters: payload.units.length,
        resultTitle,
      });
      deps.notify(t('library.translate.completed', { title: resultTitle }), 'info');
      deps.onImported?.(item);
      return 'completed';
    } catch (error) {
      // 兜底：断点写盘/读缓存等未单独包裹的失败也落到 error 终态（缓存保留，
      // 可再次发起续译），不向调用方抛未处理拒绝。
      const message = localizeError(error);
      const current = statuses.get(request.path);
      setStatus({
        ...(current ?? {
          path: request.path,
          title: request.title,
          contentHash: '',
          targetLang: '',
          doneChunks: 0,
          totalChunks: 0,
          doneChapters: 0,
          totalChapters: 0,
          currentChapterTitle: '',
          resumedChunks: 0,
        }),
        phase: 'error',
        error: message,
      });
      deps.notify(t('library.translate.failed', { reason: message }), 'error');
      return 'failed';
    } finally {
      aborters.delete(request.path);
    }
  };

  return {
    launch,
    cancel(path) {
      aborters.get(path)?.abort();
    },
    statusFor(path) {
      return statuses.get(path) ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      for (const aborter of aborters.values()) {
        aborter.abort();
      }
      aborters.clear();
      statuses.clear();
      listeners.clear();
    },
  };
}
