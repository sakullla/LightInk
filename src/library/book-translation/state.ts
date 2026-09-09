/**
 * `state` — 断点状态编解码与续译规划（ADR-5）。
 *
 * 状态文件 `<app_data_dir>/book-translation/<contentHash>.json` 的小状态部分：
 * 完成位数组 + 术语表 + 目标语言。schema 由本模块拥有，Rust 侧按不透明
 * JSON 落盘。单块译文存于 `<hash>.d/<idx>.txt`（每块恰写一次）。
 *
 * 续译判定：目标语言与规划块数一致才复用完成位；否则（换目标语言、源文件
 * 已变化致哈希不同、解析规划变化）视为全新开始——已完成章节绝不重复请求
 * 由 done 位跳过保证，缓存错配绝不拼出半新半旧的译本。
 */

import type { BookTranslationStateV1, GlossaryEntry } from './types.js';

function asGlossary(raw: unknown): GlossaryEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: GlossaryEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const candidate = item as { source?: unknown; target?: unknown };
    if (
      typeof candidate.source === 'string' &&
      candidate.source.trim() !== '' &&
      typeof candidate.target === 'string' &&
      candidate.target.trim() !== ''
    ) {
      entries.push({ source: candidate.source, target: candidate.target });
    }
  }
  return entries;
}

/** 解析状态文件内容；缺失/损坏/版本不合返回 null（视为无进度，重新开始）。 */
export function parseBookTranslationState(raw: string): BookTranslationStateV1 | null {
  if (raw.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as {
    version?: unknown;
    targetLang?: unknown;
    totalChunks?: unknown;
    done?: unknown;
    glossary?: unknown;
    sourceChars?: unknown;
    updatedAt?: unknown;
  };
  if (candidate.version !== 1) {
    return null;
  }
  if (typeof candidate.targetLang !== 'string' || candidate.targetLang.trim() === '') {
    return null;
  }
  if (
    typeof candidate.totalChunks !== 'number' ||
    !Number.isInteger(candidate.totalChunks) ||
    candidate.totalChunks < 0
  ) {
    return null;
  }
  if (!Array.isArray(candidate.done) || candidate.done.length !== candidate.totalChunks) {
    return null;
  }
  const done = candidate.done.map((flag) => flag === true);
  return {
    version: 1,
    targetLang: candidate.targetLang,
    totalChunks: candidate.totalChunks,
    done,
    glossary: asGlossary(candidate.glossary),
    sourceChars:
      typeof candidate.sourceChars === 'number' && Number.isFinite(candidate.sourceChars)
        ? candidate.sourceChars
        : 0,
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : 0,
  };
}

export function serializeBookTranslationState(
  state: BookTranslationStateV1,
): string {
  return JSON.stringify(state);
}

/** 初始状态（发起确认后首写：锁规划并落术语表基线）。 */
export function initialBookTranslationState(
  totalChunks: number,
  targetLang: string,
  sourceChars: number,
): BookTranslationStateV1 {
  return {
    version: 1,
    targetLang,
    totalChunks,
    done: Array.from({ length: totalChunks }, () => false),
    glossary: [],
    sourceChars,
    updatedAt: Date.now(),
  };
}

export interface ResumePlan {
  /** 待译块序号（升序；跳过全部 done 块——不重复请求已完成章节）。 */
  readonly pending: readonly number[];
  readonly glossary: readonly GlossaryEntry[];
  /** 续起的已完成块数。 */
  readonly resumedChunks: number;
}

/**
 * 续译规划：状态与当前计划（目标语言 + 块数）匹配时复用完成位与术语表，
 * 否则返回 null（全新开始；旧状态由首次写盘覆盖）。
 */
export function planResume(
  state: BookTranslationStateV1 | null,
  totalChunks: number,
  targetLang: string,
): ResumePlan | null {
  if (state === null || state.totalChunks !== totalChunks || state.targetLang !== targetLang) {
    return null;
  }
  const pending: number[] = [];
  for (let index = 0; index < state.done.length; index += 1) {
    if (state.done[index] !== true) {
      pending.push(index);
    }
  }
  if (pending.length === totalChunks) {
    // 没有任何完成位：与全新开始等价，不视为续译。
    return null;
  }
  return {
    pending,
    glossary: state.glossary,
    resumedChunks: totalChunks - pending.length,
  };
}

/** 标记块完成（不可变更新；返回新状态对象）。 */
export function withChunkDone(
  state: BookTranslationStateV1,
  chunkIndex: number,
  glossary: readonly GlossaryEntry[],
): BookTranslationStateV1 {
  const done = [...state.done];
  if (chunkIndex >= 0 && chunkIndex < done.length) {
    done[chunkIndex] = true;
  }
  return {
    ...state,
    done,
    glossary: [...glossary],
    updatedAt: Date.now(),
  };
}
