/**
 * `library/book-translation` — 整本翻译域入口（ADR-5 / R4）。
 *
 * 模块面：编排控制器（controller）、默认 Tauri 依赖装配（tauri-deps）、
 * 纯函数（分块/术语表/断点状态/块化与译回/EPUB 重组/入口显隐）。
 */

export {
  createBookTranslationController,
  type BookPayload,
  type BookTranslationController,
  type BookTranslationDeps,
  type BookTranslationLaunchRequest,
  type BookTranslationLaunchResult,
} from './controller.js';
export {
  createTauriBookTranslationDeps,
  type AppBookTranslationHooks,
} from './tauri-deps.js';
export {
  bookTranslationPhaseIsRunning,
  bookTranslationSupported,
} from './support.js';
export {
  BOOK_CHUNK_CHAR_LIMIT,
  chunkIndexesByChapter,
  planTranslationChunks,
  plannedSourceChars,
} from './chunker.js';
export {
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_PROMPT_MAX_ENTRIES,
  glossaryForPrompt,
  mergeGlossary,
  parseGlossaryTail,
} from './glossary.js';
export {
  initialBookTranslationState,
  parseBookTranslationState,
  planResume,
  serializeBookTranslationState,
  withChunkDone,
} from './state.js';
export {
  extractTranslationBlocks,
  rebuildTranslatedBody,
  splitOversizedParagraph,
  splitTranslatedParagraphs,
  unitParagraphs,
} from './blocks.js';
export {
  buildTranslatedEpub,
  epubUnitsFromBodies,
  parseEpubSpine,
  prepareEpubTranslation,
  rebuildTranslatedEpub,
} from './epub-builder.js';
export type {
  BookTranslationEstimate,
  BookTranslationPhase,
  BookTranslationStatus,
  BookTranslationStateV1,
  GlossaryEntry,
  PlannedChunk,
  TranslationBlock,
  TranslationUnit,
} from './types.js';
