/**
 * Markdown 标注高亮（ProseMirror decoration，不改文档）。
 *
 * 定位器与阅读器共用 TextLocator（原文偏移 + quote/prefix/suffix）。
 * 插件态只缓存 annotations 与派生 decoration；保存走阅读器同一套 JSON。
 */

import { $prose } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

import { resolveTextQuoteOffsets } from '../../reader/annotation-locator.js';
import type { Annotation, TextLocator, TextQuoteAnchor } from '../../reader/annotations.js';

export const MARKDOWN_ANNOTATION_KEY = new PluginKey<MarkdownAnnotationState>(
  'lightink-md-annotations',
);

export interface MarkdownAnnotationState {
  readonly annotations: readonly Annotation[];
  readonly decorations: DecorationSet;
}

interface SetAnnotationsMeta {
  readonly type: 'set';
  readonly annotations: readonly Annotation[];
}

interface TextSpan {
  start: number;
  end: number;
  from: number;
}

export function collectPmText(doc: PMNode): { text: string; spans: TextSpan[] } {
  const spans: TextSpan[] = [];
  let text = '';
  doc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }
    const value = node.text ?? '';
    spans.push({ start: text.length, end: text.length + value.length, from: pos });
    text += value;
  });
  return { text, spans };
}

export function pmOffsetAtPos(spans: readonly TextSpan[], pos: number): number {
  for (const span of spans) {
    if (pos <= span.from + (span.end - span.start)) {
      return span.start + Math.max(0, pos - span.from);
    }
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 0 : last.end;
}

export function pmPosAtOffset(spans: readonly TextSpan[], offset: number, preferNext: boolean): number {
  for (const span of spans) {
    if (offset < span.end || (!preferNext && offset === span.end)) {
      return span.from + Math.max(0, offset - span.start);
    }
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 1 : last.from + (last.end - last.start);
}

export function locatorFromPmSelection(
  doc: PMNode,
  from: number,
  to: number,
): TextLocator | null {
  const { text, spans } = collectPmText(doc);
  const start = pmOffsetAtPos(spans, from);
  const end = pmOffsetAtPos(spans, to);
  if (end < start) {
    return null;
  }
  return {
    format: 'text',
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(end, end + 32),
  };
}

export function decorationsForAnnotations(
  doc: PMNode,
  annotations: readonly Annotation[],
): DecorationSet {
  const { text, spans } = collectPmText(doc);
  const decorations: Decoration[] = [];
  for (const annotation of annotations) {
    // Tombstone（deletedAt）只参与同步合并，不再渲染。
    if (annotation.deletedAt !== undefined) {
      continue;
    }
    if (annotation.kind !== 'highlight' && annotation.kind !== 'note') {
      continue;
    }
    const locator = annotation.locator;
    if (locator.format !== 'text') {
      continue;
    }
    const offsets = resolveTextQuoteOffsets(text, locator);
    if (offsets === null || offsets.end < offsets.start) {
      continue;
    }
    const from = pmPosAtOffset(spans, offsets.start, true);
    const to = pmPosAtOffset(spans, offsets.end, false);
    if (to <= from) {
      continue;
    }
    decorations.push(
      Decoration.inline(from, to, {
        class:
          annotation.kind === 'note'
            ? 'lightink-reader-highlight lightink-reader-highlight--note'
            : 'lightink-reader-highlight',
        'data-annotation-id': annotation.id,
        'data-annotation-kind': annotation.kind,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

const EMPTY_STATE: MarkdownAnnotationState = {
  annotations: [],
  decorations: DecorationSet.empty,
};

export function createMarkdownAnnotationPlugin(): Plugin {
  return new Plugin({
    key: MARKDOWN_ANNOTATION_KEY,
    state: {
      init: (): MarkdownAnnotationState => EMPTY_STATE,
      apply(
        tr: Transaction,
        old: MarkdownAnnotationState,
        _oldState: EditorState,
        newState: EditorState,
      ): MarkdownAnnotationState {
        const meta = tr.getMeta(MARKDOWN_ANNOTATION_KEY) as SetAnnotationsMeta | undefined;
        if (meta?.type === 'set') {
          return {
            annotations: meta.annotations,
            decorations: decorationsForAnnotations(newState.doc, meta.annotations),
          };
        }
        if (!tr.docChanged || old.annotations.length === 0) {
          return old;
        }
        return {
          annotations: old.annotations,
          decorations: decorationsForAnnotations(newState.doc, old.annotations),
        };
      },
    },
    props: {
      decorations(state) {
        return MARKDOWN_ANNOTATION_KEY.getState(state)?.decorations ?? null;
      },
    },
  });
}

export const markdownAnnotationPlugin = $prose(() => createMarkdownAnnotationPlugin());

export function setMarkdownAnnotations(
  dispatch: (tr: Transaction) => void,
  state: EditorState,
  annotations: readonly Annotation[],
): void {
  dispatch(
    state.tr.setMeta(MARKDOWN_ANNOTATION_KEY, {
      type: 'set',
      annotations,
    } satisfies SetAnnotationsMeta),
  );
}

export function textAnchorAtOffset(text: string, offset: number): TextQuoteAnchor {
  const start = Math.max(0, Math.min(offset, text.length));
  return {
    start,
    end: start,
    quote: '',
    prefix: text.slice(Math.max(0, start - 32), start),
    suffix: text.slice(start, start + 32),
  };
}
