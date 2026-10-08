/**
 * `labels` — 编辑器标签/处理器中转（轻量，无编辑器引擎依赖）。
 *
 * 主壳（main.ts）在启动与语言切换时只写入本模块；真正的插件 setter 位于带
 * Milkdown 依赖的插件模块中（`label-bindings.ts`，随编辑器引擎按需加载）。引擎
 * 加载后调用 `registerEditorLabelApplier` 注册回调并立即下发一次当前值，此后每次
 * 写入都会即时下发。这样主壳初始化不必静态引入编辑器引擎，冷启动入口包因此变小。
 *
 * 本模块的类型一律 `import type`（编译期擦除），不会把 Milkdown 拉进入口包。
 */

import type { MessageKey } from '../i18n/messages.js';
import type { CodeChromeLabels } from './plugins/code-highlight.js';
import type { FormatToolId, LinkEditorFn } from './plugins/format-toolbar.js';
import type { KeyboardFormatToolId } from './plugins/keyboard-format-bar.js';
import type { SlashInteractiveHandler } from './plugins/slash-menu.js';

export interface EditorLabelPayloads {
  formatToolbarTitles?: Partial<Record<FormatToolId, string>>;
  keyboardFormatBarTitles?: Partial<Record<KeyboardFormatToolId, string>>;
  codeChromeLabels?: CodeChromeLabels;
  mathEditTitle?: string;
  mermaidEditTitle?: string;
  taskCheckboxLabels?: { check: string; uncheck: string };
  slashTranslate?: ((key: MessageKey) => string) | null;
}

const labels: EditorLabelPayloads = {};
let formatToolbarLinkEditor: LinkEditorFn | null = null;
let slashImageHandler: SlashInteractiveHandler | null = null;
let applier: (() => void) | null = null;

function notify(): void {
  applier?.();
}

/** 合并写入编辑器标签（未提供的键保留原值）；引擎已加载时即时下发。 */
export function setEditorLabels(next: EditorLabelPayloads): void {
  Object.assign(labels, next);
  notify();
}

/** 设置格式工具条的链接编辑对话框处理器（引擎已加载时即时下发）。 */
export function setFormatToolbarLinkEditor(editor: LinkEditorFn | null): void {
  formatToolbarLinkEditor = editor;
  notify();
}

/** 设置斜杠菜单 `/image` 处理器（引擎已加载时即时下发）。 */
export function setSlashImageHandler(handler: SlashInteractiveHandler | null): void {
  slashImageHandler = handler;
  notify();
}

export function getEditorLabels(): EditorLabelPayloads {
  return labels;
}

export function getFormatToolbarLinkEditor(): LinkEditorFn | null {
  return formatToolbarLinkEditor;
}

export function getSlashImageHandler(): SlashInteractiveHandler | null {
  return slashImageHandler;
}

/**
 * 由编辑器引擎在加载时调用：注册下发回调并立即下发一次当前值。
 * 引擎加载必然晚于主壳初始化（后者同步完成），故此刻标签已就绪。
 */
export function registerEditorLabelApplier(fn: () => void): void {
  applier = fn;
  fn();
}
