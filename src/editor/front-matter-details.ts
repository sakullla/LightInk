/**
 * `front-matter-details` — 导出前收起 front matter `<details>`（纯 DOM，无编辑器引擎）。
 *
 * 从 `plugins/front-matter.ts` 拆出：导出流程需要它，但不应把 Milkdown 拉进入口包。
 * `plugins/front-matter.ts` 重导出本模块，保持既有导入路径与测试不变。
 */

export const FRONTMATTER_CLASS = 'lightink-frontmatter';

/**
 * Strip `open` from `.lightink-frontmatter` in a cloned export root.
 * Does not touch the ProseMirror document or source Markdown.
 */
export function closeFrontMatterDetails(root: ParentNode): void {
  for (const node of root.querySelectorAll(`.${FRONTMATTER_CLASS}`)) {
    if (node instanceof HTMLDetailsElement) {
      node.open = false;
    }
    node.removeAttribute('open');
  }
}
