/**
 * `label-bindings` — 把 `labels.ts` 中转的标签/处理器推送给真正的编辑器插件。
 *
 * 本模块带 Milkdown 依赖，仅在编辑器引擎加载时引入（side-effect import from
 * `editor/index.ts`）。此后语言切换等对 `labels.ts` 的写入会即时下发。
 */

import {
  getEditorLabels,
  getFormatToolbarLinkEditor,
  getSlashImageHandler,
  registerEditorLabelApplier,
} from './labels.js';
import {
  setFormatToolbarLinkEditor as applyFormatToolbarLinkEditor,
  setFormatToolbarTitles,
} from './plugins/format-toolbar.js';
import { setKeyboardFormatBarTitles } from './plugins/keyboard-format-bar.js';
import { setCodeChromeLabels } from './plugins/code-highlight.js';
import { setMathEditTitle } from './plugins/math.js';
import { setMermaidEditTitle } from './plugins/mermaid.js';
import { setTaskCheckboxLabels } from './plugins/task-checkbox.js';
import {
  setSlashImageHandler as applySlashImageHandler,
  setSlashTranslate,
} from './plugins/slash-menu.js';

function applyAll(): void {
  const l = getEditorLabels();
  if (l.formatToolbarTitles !== undefined) setFormatToolbarTitles(l.formatToolbarTitles);
  if (l.keyboardFormatBarTitles !== undefined) {
    setKeyboardFormatBarTitles(l.keyboardFormatBarTitles);
  }
  if (l.codeChromeLabels !== undefined) setCodeChromeLabels(l.codeChromeLabels);
  if (l.mathEditTitle !== undefined) setMathEditTitle(l.mathEditTitle);
  if (l.mermaidEditTitle !== undefined) setMermaidEditTitle(l.mermaidEditTitle);
  if (l.taskCheckboxLabels !== undefined) setTaskCheckboxLabels(l.taskCheckboxLabels);
  if (l.slashTranslate !== undefined) setSlashTranslate(l.slashTranslate);
  applyFormatToolbarLinkEditor(getFormatToolbarLinkEditor());
  applySlashImageHandler(getSlashImageHandler());
}

registerEditorLabelApplier(applyAll);
