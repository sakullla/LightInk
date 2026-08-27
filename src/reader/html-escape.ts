/**
 * 阅读器 HTML 转义唯一实现（R4 共用工具单点化）。
 *
 * txt 分段渲染与导出书签标题共用这一份三字符替换链；`&` 必须先行，否则
 * 后续替换会把已转义实体的 `&` 再次转义。阅读器内不得内联第二份实现。
 */

/** Escape the three characters that can introduce HTML markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
