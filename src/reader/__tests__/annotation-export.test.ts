/**
 * 标注导出（annotation-export，R5）测试：
 * Markdown 生成（三类标注/tombstone 剔除/文档位置排序/无备注省略/高亮附颜色/
 * 多行摘录引用块）、默认文件名（去扩展名 + 日期）、空集合空态提示（不开对话框
 * 不落盘）、取消对话框安静退出、写失败经 reportError 上报、成功落盘提示。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildAnnotationsMarkdown,
  defaultAnnotationExportFileName,
  exportAnnotationsMarkdown,
  type AnnotationExportDeps,
  type AnnotationExportTranslator,
} from '../annotation-export.js';
import type { Annotation } from '../annotations.js';

const t: AnnotationExportTranslator = (
  key: string,
  vars?: Readonly<Record<string, string>>,
): string => {
  let text = key;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(v);
    }
  }
  return text;
};

const EXPORTED_AT = new Date(2026, 7, 29, 14, 5); // 2026-08-29 14:05 本地时区

function pdfHighlight(page: number, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: `h${page}`,
    kind: 'highlight',
    locator: {
      format: 'pdf',
      page,
      quote: `第 ${page} 页摘录`,
      anchor: { start: 0, end: 5, quote: `第 ${page} 页摘录`, prefix: '', suffix: '' },
    },
    quote: `第 ${page} 页摘录`,
    createdAt: page,
    ...overrides,
  };
}

function flowBookmark(chapter: number, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: `b${chapter}`,
    kind: 'bookmark',
    locator: { format: 'flow', chapter, start: 0, end: 0, quote: '', prefix: '', suffix: '' },
    createdAt: chapter,
    ...overrides,
  };
}

describe('buildAnnotationsMarkdown', () => {
  it('生成书名标题、导出时间与三类标注（摘录/备注/定位），按文档位置排序', () => {
    const markdown = buildAnnotationsMarkdown({
      title: '三体.epub',
      exportedAt: EXPORTED_AT,
      t,
      annotations: [
        // 打乱输入顺序：页 5 高亮先入集合，输出仍按位置升序。
        pdfHighlight(5, { color: '#86c28b', note: '高亮备注' }),
        flowBookmark(1),
        {
          id: 'n1',
          kind: 'note',
          locator: { format: 'pdf', page: 2, quote: '页二片段' },
          quote: '页二片段',
          note: '页二备注',
          createdAt: 2,
        },
      ],
    });

    expect(markdown.startsWith('# 三体.epub\n\nannotation.export.exportedAt: 2026-08-29 14:05')).toBe(
      true,
    );
    // 位置排序：flow 第 2 章（chapter 1）< pdf 页 2 < pdf 页 5。
    const bookmarkAt = markdown.indexOf('annotation.kind.bookmark');
    const noteAt = markdown.indexOf('annotation.kind.note');
    const highlightAt = markdown.indexOf('annotation.kind.highlight');
    expect(bookmarkAt).toBeGreaterThan(-1);
    expect(noteAt).toBeGreaterThan(bookmarkAt);
    expect(highlightAt).toBeGreaterThan(noteAt);

    // 定位：flow 章节 / pdf 页码。
    expect(markdown).toContain('## annotation.kind.bookmark · reader.chapter');
    expect(markdown).toContain('## annotation.kind.note · annotation.location.page');
    // 摘录 quote 以引用块呈现；备注 note 附标签行；高亮附解析后颜色。
    expect(markdown).toContain('> 页二片段');
    expect(markdown).toContain('annotation.note: 页二备注');
    expect(markdown).toContain('annotation.note: 高亮备注');
    expect(markdown).toContain('annotation.export.color: #86c28b');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('剔除 tombstone；无备注省略备注行；书签无摘录不产引用块；缺省颜色解析为默认黄', () => {
    const markdown = buildAnnotationsMarkdown({
      title: 'book',
      exportedAt: EXPORTED_AT,
      t,
      annotations: [
        pdfHighlight(3), // 无 note：省略备注行；无 color：默认 #f2d675。
        pdfHighlight(2, { deletedAt: 99 }), // tombstone：不出列。
        flowBookmark(0), // 无 quote/note：只有标题行。
      ],
    });

    expect(markdown).not.toContain('第 2 页摘录');
    expect(markdown).toContain('> 第 3 页摘录');
    expect(markdown).not.toContain('annotation.note:');
    expect(markdown).toContain('annotation.export.color: #f2d675');
    const bookmarkStart = markdown.indexOf('## annotation.kind.bookmark');
    const bookmarkEnd = markdown.indexOf('## ', bookmarkStart + 1);
    const bookmarkSection = markdown.slice(bookmarkStart, bookmarkEnd === -1 ? undefined : bookmarkEnd);
    expect(bookmarkSection).not.toContain('>');
  });

  it('多行摘录逐行加引用前缀', () => {
    const markdown = buildAnnotationsMarkdown({
      title: 'book',
      exportedAt: EXPORTED_AT,
      t,
      annotations: [
        {
          id: 'n1',
          kind: 'note',
          locator: { format: 'cbz', page: 4 },
          quote: '第一行\n第二行',
          createdAt: 1,
        },
      ],
    });
    expect(markdown).toContain('> 第一行\n> 第二行');
    expect(markdown).toContain('## annotation.kind.note · annotation.location.page');
  });
});

describe('defaultAnnotationExportFileName', () => {
  it('书名去扩展名 + annotations + 日期', () => {
    expect(defaultAnnotationExportFileName('三体.epub', EXPORTED_AT)).toBe(
      '三体-annotations-2026-08-29.md',
    );
    expect(defaultAnnotationExportFileName('novel', EXPORTED_AT)).toBe(
      'novel-annotations-2026-08-29.md',
    );
  });
});

interface Harness {
  deps: AnnotationExportDeps;
  notify: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  showSaveDialog: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
}

function harness(annotations: readonly Annotation[], dialogResult: string | null = 'x.md'): Harness {
  const notify = vi.fn();
  const reportError = vi.fn();
  const showSaveDialog = vi.fn(async () => dialogResult);
  const writeFile = vi.fn(async () => {});
  return {
    notify,
    reportError,
    showSaveDialog,
    writeFile,
    deps: {
      getTitle: () => '三体.epub',
      getAnnotations: () => annotations,
      t,
      showSaveDialog,
      writeFile,
      notify,
      reportError,
      now: () => EXPORTED_AT,
    },
  };
}

describe('exportAnnotationsMarkdown', () => {
  it('空集合（过滤后 0 条）给空态提示，不开对话框不落盘', async () => {
    const { deps, notify, showSaveDialog, writeFile } = harness([
      pdfHighlight(1, { deletedAt: 5 }),
    ]);
    await expect(exportAnnotationsMarkdown(deps)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith('annotation.export.empty');
    expect(showSaveDialog).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('用户取消对话框安静退出：不落盘、不提示、不上报', async () => {
    const { deps, notify, reportError, writeFile } = harness([pdfHighlight(1)], null);
    await expect(exportAnnotationsMarkdown(deps)).resolves.toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('写失败经 reportError 上报并返回 false', async () => {
    const { deps, notify, reportError, writeFile } = harness([pdfHighlight(1)]);
    const failure = new Error('disk full');
    writeFile.mockRejectedValueOnce(failure);
    await expect(exportAnnotationsMarkdown(deps)).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith('annotation.export.failed', failure);
    expect(notify).not.toHaveBeenCalled();
  });

  it('成功落盘：默认文件名、Markdown 内容与成功提示', async () => {
    const { deps, notify, reportError, showSaveDialog, writeFile } = harness([pdfHighlight(1)]);
    await expect(exportAnnotationsMarkdown(deps)).resolves.toBe(true);
    expect(showSaveDialog).toHaveBeenCalledWith('三体-annotations-2026-08-29.md');
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('x.md');
    expect(content).toContain('# 三体.epub');
    expect(content).toContain('> 第 1 页摘录');
    expect(notify).toHaveBeenCalledWith('annotation.export.success');
    expect(reportError).not.toHaveBeenCalled();
  });
});
