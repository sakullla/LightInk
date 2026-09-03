/**
 * `mountEditor` — the public entry point used by `src/main.ts`.
 *
 * Implementation notes (T2):
 *   - The underlying WYSIWYG engine is Milkdown v7 wired with the
 *     `commonmark` + `gfm` presets. Together they cover every R1 node kind
 *     (headings, lists, task lists, blockquote, code, tables, links, images,
 *     emphasis, strong, strikethrough, hr) without bespoke schemas.
 *   - `mountEditor` binds the caller-supplied `container` via `rootCtx` and
 *     seeds the document via `defaultValueCtx` so the editor DOM lives inside
 *     the host element and starts with `initialMarkdown` rendered.
 *   - Reading/writing markdown content goes through the live ProseMirror
 *     document via `@milkdown/utils` `getMarkdown` / `replaceAll`. A cached
 *     fallback is kept for the pre-`Created` window (e.g. headless callers
 *     that `setMarkdown` before `ready` resolves).
 *   - The returned `EditorInstance` exposes a Promise-friendly interface so
 *     the rest of the app (file IO, tabs, autosave) can plug in during
 *     later tasks.
 */

import {
  defaultValueCtx,
  editorViewCtx,
  Editor as MilkdownEditor,
  EditorStatus,
  parserCtx,
  rootCtx,
} from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import {
  getMarkdown as milkdownGetMarkdown,
  replaceAll,
} from '@milkdown/utils';
import { toggleMark } from '@milkdown/prose/commands';
import { redo, undo } from '@milkdown/prose/history';
import { TextSelection } from '@milkdown/prose/state';
import { isInTable } from '@milkdown/prose/tables';

import { attachCursorListeners, type CursorEventBinding } from './dom-events.js';
import { insertMarkdownAtSelection } from './insert-markdown.js';
import { codeHighlightPlugin } from './plugins/code-highlight.js';
import { clipboardMdPlugin } from './plugins/clipboard-md.js';
import { contentChangePlugin } from './plugins/content-change.js';
import { emojiCompletePlugin } from './plugins/emoji-complete.js';
import { findReplacePlugin } from './plugins/find-replace.js';
import { formatToolbarPlugin } from './plugins/format-toolbar.js';
import { frontmatterPlugin } from './plugins/front-matter.js';
import { linkAffordancePlugin } from './link-affordance.js';
import { linkExclusiveEndsPlugin, linkNavigationPlugin } from './link-navigation.js';
import { inputAssistPlugin } from './plugins/input-assist.js';
import { imageAssetPlugin, insertImageAt, type ImageAssetMountOptions } from './plugins/image.js';
import { htmlWithImageParse, imageSizeNodeViewPlugin, imageWithSize } from './plugins/image-size.js';
import { mathPlugin } from './plugins/math.js';
import { mermaidPlugin } from './plugins/mermaid.js';
import {
  isFullDocumentSelection,
  progressiveSelectAll,
  progressiveSelectPlugin,
} from './plugins/progressive-select.js';
import { slashMenuPlugin } from './plugins/slash-menu.js';
import { taskCheckboxPlugin } from './plugins/task-checkbox.js';
import { runTableOp, type TableOpId } from './plugins/table-ops.js';
import { tableOpsPlugin } from './plugins/table-ops.js';
import { tocPlugin } from './plugins/toc.js';
import {
  collectHeadings,
  FOLD_PLUGIN_KEY,
  headingFoldPlugin,
} from './plugins/heading-fold.js';
import { markdownAnnotationPlugin } from './plugins/markdown-annotations.js';
import type { EditorView } from '@milkdown/prose/view';
import type { Mark } from '@milkdown/prose/model';
import type {
  CursorLink,
  CursorPosition,
  EditorInstance,
  MountOptions,
  SelectionSummary,
} from './types.js';

interface MountState {
  editor: MilkdownEditor | null;
  cursorBinding: CursorEventBinding | null;
  mounted: boolean;
  /** Last markdown supplied via `setMarkdown`, used as the fallback
   *  serializer source when the editor hasn't reached `Created` yet. */
  cachedMarkdown: string;
}

/** True when running under Vite's dev server (`import.meta.env.DEV`). */
function isDevEnvironment(): boolean {
  try {
    // `import.meta.env` is populated by Vite; in non-Vite runs it is
    // undefined and accessing it throws — which we swallow to mean "prod".
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/** True when the Milkdown editor has finished creating and has a live view. */
function isCreated(state: MountState): boolean {
  return state.editor !== null && state.editor.status === EditorStatus.Created;
}

/** Collapse a leftover whole-document selection to a caret (open/focus artifact). */
function collapseFullDocumentSelection(view: EditorView): void {
  if (!isFullDocumentSelection(view.state)) {
    return;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
}

function collapseNonEmptySelection(view: EditorView): void {
  if (view.state.selection.empty) {
    return;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)));
}

/** 取得底层 ProseMirror EditorView（编辑器未就绪或异常时返回 null）。 */
function getView(state: MountState): EditorView | null {
  if (!isCreated(state)) return null;
  try {
    return state.editor!.action((ctx) => ctx.get(editorViewCtx));
  } catch {
    return null;
  }
}

/**
 * 解析指定文档位置处的链接（R3/R7/R14）。取该位置的 link mark，并向前/向后
 * 展开到该 mark 覆盖的完整文本范围，返回 href 与链接文本；无链接返回 null。
 * 供「光标处链接」(resolveCursorLink) 与「右键坐标处链接」(getLinkAtPoint) 共用。
 */
function resolveLinkAt(view: EditorView, pos: number): CursorLink | null {
  const $pos = view.state.doc.resolve(pos);
  const link = $pos.marks().find((mark: Mark) => mark.type.name === 'link');
  if (link === undefined) return null;
  const href = typeof link.attrs['href'] === 'string' ? (link.attrs['href'] as string) : '';
  const doc = view.state.doc;
  const same = (mark: Mark): boolean =>
    mark.type === link.type && mark.attrs['href'] === link.attrs['href'];
  let from = pos;
  while (from > 0 && doc.resolve(from - 1).marks().some(same)) {
    from -= 1;
  }
  let to = pos;
  while (to < doc.content.size && doc.resolve(to).marks().some(same)) {
    to += 1;
  }
  const text = doc.textBetween(from, to, '');
  return { href, text };
}

/** 解析文本光标处的链接（R7/R3）。 */
function resolveCursorLink(view: EditorView): CursorLink | null {
  return resolveLinkAt(view, view.state.selection.from);
}

/**
 * Mount a Milkdown-backed WYSIWYG editor inside `container`.
 *
 * Returns an `EditorInstance` once the editor reaches the `Created` status.
 * If the environment cannot supply a real DOM (e.g. SSR or a Node-only
 * vitest run), `ready` rejects with a clear error so callers can fall back
 * gracefully — the pure-logic layers (`parser.ts`, `paste.ts`, `cursor.ts`)
 * do not need this entry point at all.
 */
export async function mountEditor(
  container: HTMLElement,
  options: MountOptions & ImageAssetMountOptions = {},
): Promise<EditorInstance> {
  if (
    typeof container === 'undefined' ||
    container === null ||
    typeof container.appendChild !== 'function'
  ) {
    throw new TypeError(
      'mountEditor: a DOM HTMLElement container is required',
    );
  }

  const state: MountState = {
    editor: null,
    cursorBinding: null,
    mounted: false,
    cachedMarkdown: options.initialMarkdown ?? '',
  };

  const ready = new Promise<void>((resolve, reject) => {
    try {
      const editor = MilkdownEditor.make()
        .config((ctx) => {
          // Bind the editor DOM into the caller's container (defaults to
          // document.body otherwise) and seed the document with the
          // initial markdown so the editor isn't empty on mount.
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, state.cachedMarkdown);
        })
        // R4：Typora 式配对输入 + 空列表项回车退出 + 表格 Tab。注册早于 preset，
        // 使 Enter(空列表项 lift 退出)/Tab(表格 goToNextCell) 优先于 preset keymap。
        .use(inputAssistPlugin)
        .use(commonmark)
        .use(gfm)
        // T8/R12：image 节点扩 width/align attrs，序列化约定（有设置出 HTML img），
        // html 节点 parseMarkdown 还原白名单 <img>；必须在 commonmark/gfm 之后覆盖。
        .use(imageWithSize)
        .use(htmlWithImageParse)
        .use(history)
        // T1：YAML front matter 原样往返（R5）：remark-frontmatter + frontmatter
        // atom 节点；必须在 commonmark/gfm 之后注册以扩展其 remark 实例。
        // 脚注（R4）由 preset-gfm 自带 footnote schemas + remark-gfm 覆盖。
        .use(frontmatterPlugin)
        // T5：代码块语法高亮（highlight.js decoration 插件，见 R4）。
        .use(codeHighlightPlugin)
        // T5：选中文字浮出格式工具条（R7）。
        .use(formatToolbarPlugin)
        // T6：行首斜杠快速插入菜单（R11），元素集合与 R2 插入菜单同源。
        .use(slashMenuPlugin)
        // T3：`:` 短码 emoji 自动补全（R7），交互模式复用 slash-menu；
        // 注册于 slashMenuPlugin 之后，两者触发符互斥（行首 `/` vs 行中 `:`）。
        .use(emojiCompletePlugin)
        // T4：Markdown 源复制 / 粘贴解析（R9）。注册于图片插件之前：clipboard-md 对
        // 非空 files（图片粘贴）直接返回 false，交 imageAssetPlugin 优先拦截。
        .use(clipboardMdPlugin)
        // T8：LaTeX 公式即时渲染（KaTeX 按需加载 + 错误隔离，见 R8）。
        .use(mathPlugin)
        // T9：mermaid 代码块即时渲染（按需加载 + 语法错误隔离，见 R9）。
        .use(mermaidPlugin)
        // T2：[TOC] 标记段落渲染为可点击目录（R6）。纯 decoration 插件，
        // 不改写文档；标记经序列化为转义形式 `\[TOC]`，重解析仍还原触发，
        // 功能往返安全。
        .use(tocPlugin)
        // T4：查找与替换（R2）WYSIWYG 侧：decoration 高亮全部/当前命中，
        // 替换经单事务（可撤销）；面板与模式分派在壳层 main.ts。
        .use(findReplacePlugin)
        // Markdown 标注高亮（decoration，不改文档）。
        .use(markdownAnnotationPlugin)
        // T4/R2：按标题折叠（PluginKey 态 + 区间 decoration；三角切换，大纲经
        // toggleFoldAtOrdinal/getFoldedOrdinals 双向联动；折叠态不持久化、不影响导出）。
        .use(headingFoldPlugin({ onFoldChanged: options.onFoldChanged }))
        // 文档变更广播：壳层字数栏 / 脏标记 / 查找计数的可靠事实源
        // （不依赖 contenteditable 的 input 冒泡）。
        .use(contentChangePlugin(options.onContentChanged));
      // T14：文档链接 Ctrl/Cmd+点击跳转（R14）；注入确认闸门避免误开。
      if (options.onLinkNavigate !== undefined) {
        editor.use(
          linkNavigationPlugin({
            onLinkNavigate: options.onLinkNavigate,
            confirmOpen: options.confirmLinkOpen,
          }),
        );
      }
      // Prevent typing after a link from extending the link title.
      editor.use(linkExclusiveEndsPlugin());
      // R5: href hover tooltip + Ctrl/Cmd-held pointer; does not open or edit links.
      editor.use(linkAffordancePlugin());
      // Progressive Ctrl/Cmd+A: current block first, then whole document.
      editor.use(progressiveSelectPlugin);
      // GFM task list: clickable checkboxes (toggle checked ↔ markdown - [ ] / - [x]).
      editor.use(taskCheckboxPlugin);
      // Table: insert/delete row-col, TSV paste, Typora-style shortcuts.
      editor.use(tableOpsPlugin);
      // T4：注入图片落盘回调时拦截粘贴/拖拽图片 → 落盘 → 插入相对引用。
      if (options.assetSaver !== undefined) {
        editor.use(
          imageAssetPlugin({
            saver: options.assetSaver,
            onError: options.onAssetError,
          }),
        );
      }
      // 注入相对引用解析器时，image 节点经 nodeView 把 assets/… 解析为可显示
      // 的 data URL；T8/R12 同 nodeView 提供选中后的缩放柄 + 浮动对齐条。
      if (options.imageSrcResolver !== undefined) {
        editor.use(
          imageSizeNodeViewPlugin(options.imageSrcResolver, {
            remoteImageLoadLabel: options.remoteImageLoadLabel,
          }),
        );
      }
      state.editor = editor;

      editor.onStatusChange((status) => {
        if (status === EditorStatus.Created) {
          state.mounted = true;
          try {
            state.cursorBinding = attachCursorListeners(container);
          } catch (e) {
            if (isDevEnvironment()) {
              // eslint-disable-next-line no-console
              console.warn('[lightink/editor] cursor binding skipped:', e);
            }
          }
          const view = getView(state);
          if (view !== null) {
            collapseNonEmptySelection(view);
          }
          resolve();
        }
        if (status === EditorStatus.Destroyed) {
          state.mounted = false;
        }
      });

      editor.create().catch((err: unknown) => reject(err));
    } catch (err) {
      reject(err);
    }
  });

  return {
    ready,
    setMarkdown(markdown: string): void {
      const value = typeof markdown === 'string' ? markdown : String(markdown ?? '');
      if (isCreated(state)) {
        // Replace the live ProseMirror document.
        state.editor!.action(replaceAll(value, false));
        state.cachedMarkdown = value;
        const view = getView(state);
        if (view !== null) {
          collapseNonEmptySelection(view);
        }
      } else {
        // Editor not created yet — keep the fallback so getMarkdown still
        // returns something sensible for headless callers.
        state.cachedMarkdown = value;
      }
    },
    getMarkdown(): string {
      if (isCreated(state)) {
        const live = state.editor!.action(milkdownGetMarkdown());
        state.cachedMarkdown = live;
        return live;
      }
      return state.cachedMarkdown;
    },
    getSelection(): SelectionSummary | null {
      const view = getView(state);
      if (view === null) return null;
      const { from, to, empty } = view.state.selection;
      return { from, to, empty };
    },
    getCursorPosition(): CursorPosition | null {
      const view = getView(state);
      if (view === null) return null;
      const before = view.state.doc.textBetween(
        0,
        view.state.selection.head,
        '\n',
        '\n',
      );
      const lines = before.split('\n');
      return {
        line: lines.length,
        column: Array.from(lines[lines.length - 1] ?? '').length + 1,
      };
    },
    getLinkAtCursor(): CursorLink | null {
      const view = getView(state);
      if (view === null) return null;
      return resolveCursorLink(view);
    },
    getLinkAtPoint(x: number, y: number): CursorLink | null {
      // R3 右键链接：按右键坐标（clientX/clientY）解析文档位置再查 link mark，
      // 而非文本光标位置（左键链接已触发 R14 跳转，光标几乎不在链接上）。
      // posAtCoords 用法与 src/editor/plugins/image.ts 落点定位一致。
      const view = getView(state);
      if (view === null) return null;
      const coords = view.posAtCoords({ left: x, top: y });
      if (coords === null) return null;
      return resolveLinkAt(view, coords.pos);
    },
    toggleMark(markName: string): void {
      const view = getView(state);
      if (view === null) return;
      const markType = view.state.schema.marks[markName];
      if (markType === undefined) return;
      toggleMark(markType)(view.state, (tr) => view.dispatch(tr));
    },
    setLink(href: string, text?: string): void {
      const view = getView(state);
      if (view === null) return;
      const linkType = view.state.schema.marks['link'];
      if (linkType === undefined) return;
      const cleanHref = typeof href === 'string' ? href.trim() : '';
      if (cleanHref === '') return;
      const { from, to, empty } = view.state.selection;
      const mark = linkType.create({ href: cleanHref, title: null });
      const withoutLink = (marks: readonly Mark[]): Mark[] =>
        marks.filter((m) => m.type !== linkType);

      let tr = view.state.tr;
      let end = to;
      if (empty) {
        const insert = (text ?? cleanHref).trim() || cleanHref;
        tr = tr.insertText(insert, from);
        end = from + insert.length;
        tr = tr.addMark(from, end, mark);
      } else if (
        typeof text === 'string' &&
        text !== '' &&
        text !== view.state.doc.textBetween(from, to)
      ) {
        tr = tr.insertText(text, from, to);
        end = from + text.length;
        tr = tr.addMark(from, end, mark);
      } else {
        tr = tr.addMark(from, to, mark);
        end = to;
      }
      // Caret after the linked run; strip link so further typing stays plain.
      tr = tr.setSelection(TextSelection.create(tr.doc, end));
      tr = tr.setStoredMarks(withoutLink(tr.selection.$from.marks()));
      view.dispatch(tr.scrollIntoView());
    },
    insertImage(url: string, alt: string): void {
      const view = getView(state);
      if (view === null) return;
      insertImageAt(view, null, url, alt);
    },
    insertMarkdown(markdown: string): boolean {
      const view = getView(state);
      if (view === null || state.editor === null) return false;
      try {
        // Prefer action(ctx) — Editor.ctx is not a stable public surface across builds.
        const parse = state.editor.action((ctx) => ctx.get(parserCtx));
        return insertMarkdownAtSelection(view, markdown, parse);
      } catch {
        return false;
      }
    },
    isInTable(): boolean {
      const view = getView(state);
      if (view === null) return false;
      return isInTable(view.state);
    },
    runTableOp(op: TableOpId): boolean {
      const view = getView(state);
      if (view === null) return false;
      return runTableOp(view, op);
    },
    focus(): void {
      const view = getView(state);
      if (view === null) return;
      view.focus();
      collapseFullDocumentSelection(view);
      // Windows / WebView often select-all when a freshly filled
      // contenteditable is focused; collapse after that paint.
      queueMicrotask(() => {
        const live = getView(state);
        if (live !== null) {
          collapseFullDocumentSelection(live);
        }
      });
    },
    selectAll(): void {
      const view = getView(state);
      if (view === null) return;
      view.focus();
      progressiveSelectAll(view.state, view.dispatch.bind(view));
    },
    undo(): void {
      const view = getView(state);
      if (view === null) return;
      undo(view.state, view.dispatch);
    },
    redo(): void {
      const view = getView(state);
      if (view === null) return;
      redo(view.state, view.dispatch);
    },
    toggleFoldAtOrdinal(ordinal: number): void {
      const view = getView(state);
      if (view === null) return;
      const heading = collectHeadings(view.state.doc)[ordinal];
      if (heading === undefined) return;
      view.dispatch(view.state.tr.setMeta(FOLD_PLUGIN_KEY, { toggle: heading.pos }));
    },
    getFoldedOrdinals(): number[] {
      const view = getView(state);
      if (view === null) return [];
      const value = FOLD_PLUGIN_KEY.getState(view.state);
      if (value === undefined) return [];
      const posToOrdinal = new Map<number, number>();
      collectHeadings(view.state.doc).forEach((h, i) => posToOrdinal.set(h.pos, i));
      const out: number[] = [];
      for (const pos of value.folded) {
        const ordinal = posToOrdinal.get(pos);
        if (ordinal !== undefined) {
          out.push(ordinal);
        }
      }
      return out;
    },
    async destroy(): Promise<void> {
      try {
        if (state.cursorBinding !== null) {
          state.cursorBinding.dispose();
          state.cursorBinding = null;
        }
        const editor = state.editor;
        if (editor !== null) {
          await editor.destroy(true);
        }
      } finally {
        state.editor = null;
        state.mounted = false;
      }
    },
  };
}
