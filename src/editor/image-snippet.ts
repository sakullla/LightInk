/**
 * `image-snippet` — 图片 Markdown 片段（纯函数，无编辑器引擎依赖）。
 *
 * 从 `plugins/image.ts` 拆出：壳层插入图片（含源码模式/拖拽落盘）需要生成片段，
 * 但不应因此把 Milkdown 拉进入口包。`plugins/image.ts` 重导出本函数，保持既有
 * 导入路径与测试不变。
 */

import type { ImageAsset } from './plugins/image.js';

/**
 * Markdown fragment for an image asset. Re-renders with the canonical URL so the
 * editor's stored source matches the `ImageAsset.url`.
 */
export function imageMarkdownSnippet(asset: ImageAsset): string {
  const titlePart =
    typeof asset.title === 'string' && asset.title.length > 0
      ? ` "${asset.title.replace(/"/g, '\\"')}"`
      : '';
  return `![${asset.alt}](${asset.url}${titlePart})`;
}
