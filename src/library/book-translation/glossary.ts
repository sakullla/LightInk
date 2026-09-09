/**
 * `glossary` — 按书术语表（ADR-5：人名与关键术语跨章一致）。
 *
 * 模型按 prompt 契约在块译文末尾以 `<glossary>原文=译文;…</glossary>` 行回报
 * 新增术语；这里剥离该行（不进入译文正文）并合并进按书术语表。后续块的
 * prompt 携带术语表（ai.rs `book_chunk_prompt`），约束同一译法贯穿全书。
 */

import type { GlossaryEntry } from './types.js';

/** 术语表持久上限（与 Rust MAX_GLOSSARY_ENTRIES 对齐；超出停止收集）。 */
export const GLOSSARY_MAX_ENTRIES = 300;
/** prompt 携带条数上限（提示词体积有界）。 */
export const GLOSSARY_PROMPT_MAX_ENTRIES = 120;
const MAX_SOURCE_CHARS = 60;
const MAX_TARGET_CHARS = 80;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const GLOSSARY_TAIL = /<glossary>([\s\S]*?)<\/glossary>/g;

function sanitizeEntry(source: string, target: string): GlossaryEntry | null {
  const src = source.trim();
  const dst = target.trim();
  if (
    src === '' ||
    dst === '' ||
    src === dst ||
    src.length > MAX_SOURCE_CHARS ||
    dst.length > MAX_TARGET_CHARS ||
    CONTROL_CHARS.test(src) ||
    CONTROL_CHARS.test(dst)
  ) {
    return null;
  }
  return { source: src, target: dst };
}

/**
 * 剥离块译文末尾的 `<glossary>` 回报行并解析条目。仅当最后一个匹配位于译文
 * 结尾（其后只剩空白）才剥离；中途出现（模型误用）时保留原文不动、不采集。
 */
export function parseGlossaryTail(
  text: string,
): { clean: string; entries: GlossaryEntry[] } {
  const matches = [...text.matchAll(GLOSSARY_TAIL)];
  if (matches.length === 0) {
    return { clean: text, entries: [] };
  }
  const last = matches[matches.length - 1]!;
  const after = text.slice((last.index ?? 0) + last[0].length);
  if (after.trim() !== '') {
    return { clean: text, entries: [] };
  }
  const entries: GlossaryEntry[] = [];
  for (const rawEntry of last[1]!.split(/[;；\n]/)) {
    const pair = rawEntry.split(/[=＝]|->|→|：:/);
    if (pair.length !== 2) {
      continue;
    }
    const entry = sanitizeEntry(pair[0]!, pair[1]!);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  const clean = text.slice(0, last.index ?? 0).replace(/[\r\n]+$/, '');
  return { clean, entries };
}

function entryKey(source: string): string {
  // 大小写不敏感去重（Harry/harry 同一术语）；保留首个译法，新增可覆盖旧译。
  return source.toLowerCase();
}

/** 合并新增条目（同原文以新增译法覆盖，保持插入序）；超出上限丢弃新增。 */
export function mergeGlossary(
  current: readonly GlossaryEntry[],
  additions: readonly GlossaryEntry[],
  cap: number = GLOSSARY_MAX_ENTRIES,
): GlossaryEntry[] {
  const merged = new Map<string, GlossaryEntry>();
  const push = (entry: GlossaryEntry): void => {
    if (merged.size >= cap && !merged.has(entryKey(entry.source))) {
      return;
    }
    merged.set(entryKey(entry.source), entry);
  };
  for (const entry of current) {
    push(entry);
  }
  for (const entry of additions) {
    push(entry);
  }
  return [...merged.values()];
}

/** prompt 携带的术语表切片（最近新增优先——人名通常在近期章节持续出现）。 */
export function glossaryForPrompt(
  glossary: readonly GlossaryEntry[],
  max: number = GLOSSARY_PROMPT_MAX_ENTRIES,
): GlossaryEntry[] {
  return glossary.slice(Math.max(0, glossary.length - max));
}
