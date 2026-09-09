/**
 * `chunker` — 分块规划（ADR-5：按章自然边界分块）。
 *
 * 块不跨章：每章的归一化段落按顺序装箱到块上限内（超限即起下一块）。块上限
 * 必须低于 Rust `ai.rs` 的 5000 字符硬上限（prompt 另有指令开销），超限块会
 * 被 `AI_TEXT_TOO_LONG` 拒绝而不是静默截断。
 */

import { unitParagraphs } from './blocks.js';
import type { PlannedChunk, TranslationUnit } from './types.js';

/** Rust MAX_TRANSLATE_CHARS(5000) 减去指令/术语表开销与安全余量。 */
export const BOOK_CHUNK_CHAR_LIMIT = 4000;

/**
 * 规划全书翻译块。返回数组索引即断点状态的 done 数组索引（重发起时
 * 重新解析重规划，确定性一致；规划数变化则断点作废重来）。
 */
export function planTranslationChunks(
  units: readonly TranslationUnit[],
  limit: number = BOOK_CHUNK_CHAR_LIMIT,
): PlannedChunk[] {
  if (limit < 200) {
    throw new Error(`整本翻译块上限过小: ${limit}`);
  }
  const chunks: PlannedChunk[] = [];
  let index = 0;
  for (const unit of units) {
    let current: string[] = [];
    let chars = 0;
    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      chunks.push({
        index,
        chapterIndex: unit.index,
        text: current.join('\n'),
      });
      index += 1;
      current = [];
      chars = 0;
    };
    for (const paragraph of unitParagraphs(unit, limit)) {
      const length = paragraph.text.length + 1;
      if (chars > 0 && chars + length > limit) {
        flush();
      }
      current.push(paragraph.text);
      chars += length;
    }
    flush();
  }
  return chunks;
}

/** 每章的块序号分组（进度按章聚合用）。 */
export function chunkIndexesByChapter(
  chunks: readonly PlannedChunk[],
  chapterCount: number,
): number[][] {
  const grouped: number[][] = Array.from({ length: chapterCount }, () => []);
  for (const chunk of chunks) {
    if (chunk.chapterIndex >= 0 && chunk.chapterIndex < chapterCount) {
      grouped[chunk.chapterIndex]!.push(chunk.index);
    }
  }
  return grouped;
}

/** 全书源字符量（成本预估口径：块文本字符和）。 */
export function plannedSourceChars(chunks: readonly PlannedChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.text.length, 0);
}
