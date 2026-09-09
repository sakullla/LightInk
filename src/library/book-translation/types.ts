/**
 * `library/book-translation` — 整本翻译前端编排的类型面（ADR-5 / R4）。
 *
 * 章节解析、分块、术语表与断点状态、进度 UI 全在前端；网络调用逐块经
 * `book_translation_translate_chunk`（ai.rs 同一三端点网络栈）。断点缓存
 * 由 Rust `book_translation.rs` 落盘 `app_data_dir/book-translation/`。
 */

/** 翻译单元内的一个正文块：文本块（翻译）或原样保留块（图片等）。 */
export type TranslationBlock =
  | { readonly kind: 'text'; readonly tag: string; readonly text: string }
  | { readonly kind: 'raw'; readonly markup: string };

/** 一个翻译单元 = 原书一章（TXT/FB2/MOBI）或 EPUB 的一个 spine 项。 */
export interface TranslationUnit {
  /** 章节序号（0 起，进度显示用）。 */
  readonly index: number;
  readonly title: string;
  readonly blocks: readonly TranslationBlock[];
}

/** 已规划的翻译块：一章内连续文本段，不跨章（按章自然边界）。 */
export interface PlannedChunk {
  /** 全书块序号（0 起；与断点状态的 done 数组同索引）。 */
  readonly index: number;
  readonly chapterIndex: number;
  readonly text: string;
}

/** 按书术语表条目（人名/关键术语 → 已定译法）。 */
export interface GlossaryEntry {
  readonly source: string;
  readonly target: string;
}

/** 断点状态文件（`book-translation/<hash>.json`）的 v1 schema。 */
export interface BookTranslationStateV1 {
  readonly version: 1;
  readonly targetLang: string;
  readonly totalChunks: number;
  /** 与计划块同索引的完成位；每块译文落盘后置 true 并整文件覆写。 */
  readonly done: readonly boolean[];
  readonly glossary: readonly GlossaryEntry[];
  readonly sourceChars: number;
  readonly updatedAt: number;
}

export type BookTranslationPhase =
  | 'preparing'
  | 'translating'
  | 'building'
  | 'importing'
  | 'done'
  | 'paused'
  | 'error';

/** 单本书的运行时进度（库详情进度区/入口续译态渲染源）。 */
export interface BookTranslationStatus {
  readonly path: string;
  readonly title: string;
  readonly contentHash: string;
  readonly targetLang: string;
  readonly phase: BookTranslationPhase;
  readonly doneChunks: number;
  readonly totalChunks: number;
  readonly doneChapters: number;
  readonly totalChapters: number;
  readonly currentChapterTitle: string;
  /** 本次发起时从断点续起的块数（0 = 全新开始）。 */
  readonly resumedChunks: number;
  readonly error?: string;
  readonly resultTitle?: string;
}

/** 发起前的确认载荷（字数与预估成本，R4 验收）。 */
export interface BookTranslationEstimate {
  readonly title: string;
  readonly targetLang: string;
  readonly sourceChars: number;
  readonly totalChunks: number;
  readonly pendingChunks: number;
  readonly estInputChars: number;
  readonly estOutputChars: number;
  /** 是否从已有断点续译（确认文案区分「续译 N 块」与全新翻译）。 */
  readonly resumed: boolean;
}
