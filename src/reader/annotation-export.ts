/**
 * `annotation-export` — 当前书全部标注导出为 Markdown 文件（R5）。
 *
 * 纯生成层 `buildAnnotationsMarkdown`：标注必经 filterAnnotations（tombstone
 * 永不出列），排序与定位文案与 annotation-panel 同一实现（byDocumentPosition /
 * annotationLocationText 同源导入，导出顺序永远等于面板列表顺序）。每条含类型
 * （书签/高亮/笔记）、摘录 quote、备注 note（无备注省略该行）与定位（章节/页码）；
 * 高亮附解析后的颜色。
 *
 * 编排层 `exportAnnotationsMarkdown`：全部副作用（save 对话框、原子写、提示、
 * 错误上报）经 `AnnotationExportDeps` 注入（与 export-service 同模式，vitest 在
 * node 环境以 fake 直测分支）。空标注（过滤后 0 条）只给空态提示，不开对话框、
 * 不产生文件；用户取消对话框安静返回不落盘；写失败经 reportError 上报。
 */

import { filterAnnotations, resolveAnnotationColor, type Annotation } from './annotations.js';
import { annotationLocationText, byDocumentPosition } from './annotation-panel.js';
import type { MessageKey } from '../i18n/messages.js';

export type AnnotationExportTranslator = (
  key: MessageKey,
  vars?: Readonly<Record<string, string>>,
) => string;

export interface AnnotationsMarkdownInput {
  /** 书名（导出 H1 标题与默认文件名词干来源）。 */
  readonly title: string;
  /** 当前书全部标注（可含 tombstone；生成前必经 filterAnnotations）。 */
  readonly annotations: readonly Annotation[];
  readonly exportedAt: Date;
  readonly t: AnnotationExportTranslator;
}

export interface AnnotationExportDeps {
  readonly getTitle: () => string;
  readonly getAnnotations: () => readonly Annotation[];
  readonly t: AnnotationExportTranslator;
  /** 保存对话框（生产为 Tauri dialog save()）；用户取消返回 null。 */
  readonly showSaveDialog: (defaultPath?: string) => Promise<string | null>;
  /** 原子写文件（生产为 file-service 的 writeFile）。 */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** 非阻断提示（空态/成功）。 */
  readonly notify: (message: string) => void;
  readonly reportError: (message: string, error: unknown) => void;
  /** 测试注入固定时钟；缺省取当前时间。 */
  readonly now?: () => Date;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 文件名日期段：本地时区 YYYY-MM-DD。 */
function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 导出时间行：本地时区 YYYY-MM-DD HH:mm。 */
function formatTimestamp(date: Date): string {
  return `${formatDateOnly(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 默认导出文件名：<书名去扩展名>-annotations-<YYYY-MM-DD>.md。 */
export function defaultAnnotationExportFileName(title: string, date: Date): string {
  const stem = title.replace(/\.[^./\\]+$/, '').trim();
  return `${stem === '' ? 'annotations' : stem}-annotations-${formatDateOnly(date)}.md`;
}

/**
 * 生成标注 Markdown：书名 H1 + 导出时间 + 按文档位置排序的标注段落。
 * 输入可含 tombstone（内部过滤）；空集合返回只有头部的文档（编排层在空调用
 * 前拦截，不会走到这里）。
 */
export function buildAnnotationsMarkdown(input: AnnotationsMarkdownInput): string {
  const live = filterAnnotations(input.annotations).sort(byDocumentPosition);
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `${input.t('annotation.export.exportedAt')}: ${formatTimestamp(input.exportedAt)}`,
    '',
  ];
  for (const annotation of live) {
    const kind = input.t(`annotation.kind.${annotation.kind}`);
    const location = annotationLocationText(annotation, input.t);
    lines.push(`## ${kind}${location === null ? '' : ` · ${location}`}`, '');
    const quote = annotation.quote?.trim() ?? '';
    if (quote !== '') {
      for (const quoteLine of (annotation.quote ?? '').split(/\r?\n/)) {
        lines.push(`> ${quoteLine}`);
      }
      lines.push('');
    }
    const note = annotation.note ?? '';
    if (note.trim() !== '' && note.trim() !== quote) {
      lines.push(`${input.t('annotation.note')}: ${note}`, '');
    }
    if (annotation.kind === 'highlight') {
      lines.push(
        `${input.t('annotation.export.color')}: ${resolveAnnotationColor(annotation.color)}`,
        '',
      );
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 导出当前书标注：过滤空集合 → 空态提示（不开对话框不落盘）；生成 Markdown →
 * save 对话框（取消安静返回 false）→ 原子写（失败经 reportError 上报）。
 */
export async function exportAnnotationsMarkdown(deps: AnnotationExportDeps): Promise<boolean> {
  const live = filterAnnotations(deps.getAnnotations());
  if (live.length === 0) {
    deps.notify(deps.t('annotation.export.empty'));
    return false;
  }
  const exportedAt = deps.now?.() ?? new Date();
  const title = deps.getTitle();
  const markdown = buildAnnotationsMarkdown({
    title,
    annotations: live,
    exportedAt,
    t: deps.t,
  });
  const target = await deps.showSaveDialog(defaultAnnotationExportFileName(title, exportedAt));
  if (target === null) {
    return false; // 用户取消：安静退出，不落盘不提示。
  }
  try {
    await deps.writeFile(target, markdown);
    deps.notify(deps.t('annotation.export.success', { path: target }));
    return true;
  } catch (error) {
    deps.reportError(deps.t('annotation.export.failed'), error);
    return false;
  }
}
