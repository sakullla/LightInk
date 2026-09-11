/**
 * `clipboard-md` — Markdown 源复制 / 粘贴解析（R9 + 双格式剪贴板），`$prose` 插件。
 *
 * 复制（copy/cut）：普通选区同时写入
 *   - `text/plain` = Markdown 源（VS Code 等）
 *   - `text/html` = 渲染选区 HTML（Word/浏览器/飞书）
 *   - `application/x-lightink-markdown` = Markdown 源（本应用往返识别）
 * 粘贴：本应用复制优先用 Markdown 源；外部 HTML 仍转 Markdown；纯文本启发式解析。
 *
 * 实现要点：
 *   - prosemirror-view@1.42 **没有** `handleCopy`/`handleCut` 插件 prop——其 copy/cut
 *     始终用 `serializeForClipboard` 写渲染态 `text/plain`。故复制改写在编辑区 DOM
 *     的 **捕获阶段** 监听 `copy`/`cut`：先于 PM 的冒泡处理器写入双格式
 *     并 `stopImmediatePropagation`，避免 PM 覆盖；cut 额外复刻 `deleteSelection`。
 *   - 粘贴走真正的 `handlePaste` prop（PM 在默认解析前先询问）。
 *   - 图片粘贴优先：剪贴板带文件（`files.length>0`）时直接返回 false，交
 *     `imageAssetPlugin` 拦截。
 *   - 序列化/解析复用 Milkdown ctx 的 serializer/parser（经 `@milkdown/utils` 的
 *     `getMarkdown` / `insert` 宏），与编辑器同源、无格式丢失。
 *
 * 纯逻辑 `resolveClipboardPaste`（见 `paste.ts`）headless 可测；本文件的 DOM/ctx
 * 装配属编辑器集成面（同既有插件，仅断言工厂形态）。
 */

import { $prose, getMarkdown, insert } from '@milkdown/utils';
import type { Ctx } from '@milkdown/ctx';
import { DOMSerializer } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { CellSelection } from '@milkdown/prose/tables';
import type { EditorView } from '@milkdown/prose/view';

import { clipboardHasImage } from '../../asset/clipboard.js';
import { convertHtmlToMarkdown } from '../html-to-markdown.js';
import {
  LIGHTINK_MARKDOWN_MIME,
  readClipboardMime,
  resolveClipboardPaste,
  wrapLightInkClipboardHtml,
} from '../paste.js';
import {
  encodeMatrixClipboardText,
  matrixToHtmlTable,
  selectionToMatrix,
  selectionToTsv,
  setSessionTableMatrix,
} from './table-ops.js';

const PLUGIN_KEY = new PluginKey('lightink-clipboard-md');

/**
 * 构造复制剪贴板数据：`text/plain` 与自定义 MIME 为 Markdown 源；
 * 有渲染 HTML 时写入带 LightInk 标记的 `text/html`。
 */
export function markdownClipboardData(
  markdown: string,
  html = '',
): {
  'text/plain': string;
  'text/html'?: string;
  'application/x-lightink-markdown': string;
} {
  const payload: {
    'text/plain': string;
    'text/html'?: string;
    'application/x-lightink-markdown': string;
  } = {
    'text/plain': markdown,
    [LIGHTINK_MARKDOWN_MIME]: markdown,
  };
  const wrapped = wrapLightInkClipboardHtml(html);
  if (wrapped !== '') {
    payload['text/html'] = wrapped;
  }
  return payload;
}

/** Schema-based HTML for the current selection (not nodeView chrome). */
export function selectionToClipboardHtml(view: EditorView): string {
  if (typeof document === 'undefined') return '';
  const slice = view.state.selection.content();
  if (slice.content.size === 0) return '';
  const serializer = DOMSerializer.fromSchema(view.state.schema);
  const wrap = document.createElement('div');
  wrap.appendChild(serializer.serializeFragment(slice.content));
  return wrap.innerHTML;
}

export const clipboardMdPlugin = $prose((ctx: Ctx) => {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      // 粘贴：Markdown 源 → 解析替换选区；纯文本/图片交默认 / 图片插件。
      // （view 经 ctx.editorViewCtx 由 insert 宏取得，故此参数不直接使用。）
      handlePaste(view: EditorView, event: ClipboardEvent): boolean {
        const dt = event.clipboardData;
        // 图片粘贴优先交 imageAssetPlugin 拦截。R16：部分 WebView 把截图放
        // 在 items（含空 MIME）而非 files，故用 clipboardHasImage 兜底判定，
        // 否则文本粘贴会拦截并静默丢图。
        if (dt !== null && dt !== undefined && (dt.files.length > 0 || clipboardHasImage(event))) {
          return false;
        }
        // Table cell paste is owned by tableOpsPlugin (TSV / HTML table).
        // Never run markdown insert() over a CellSelection — it destroys the table.
        if (view.state.selection instanceof CellSelection) {
          return false;
        }
        if (readClipboardMime(dt, 'application/x-lightink-table') !== '') {
          return false;
        }
        const action = resolveClipboardPaste({
          html: readClipboardMime(dt, 'text/html'),
          text: readClipboardMime(dt, 'text/plain'),
          ownMarkdown: readClipboardMime(dt, LIGHTINK_MARKDOWN_MIME),
        });
        if (action.kind === 'markdown-source') {
          try {
            insert(action.text)(ctx);
            return true;
          } catch {
            return false;
          }
        }
        if (action.kind === 'html') {
          const md = convertHtmlToMarkdown(action.html);
          if (md !== '') {
            try {
              insert(md)(ctx);
              return true;
            } catch {
              // 解析失败 → 继续回退默认粘贴。
            }
          }
        }
        return false;
      },
    },
    view(editorView: EditorView) {
      const dom = editorView.dom;

      const writeMarkdownSource = (event: ClipboardEvent): boolean => {
        const { empty, from, to } = editorView.state.selection;
        // 空选区或无 clipboardData：交默认（PM 不会为空选区复制，此处兜底）。
        // CellSelection reports empty=false when cells are selected.
        if (empty || event.clipboardData === null || event.clipboardData === undefined) {
          return false;
        }
        // Table cell / row / column selection: TSV + HTML table.
        // Prefer CellSelection even when empty text looks empty — never fall through
        // to getMarkdown({from,to}) which serializes a broken table fragment.
        if (editorView.state.selection instanceof CellSelection) {
          const matrix = selectionToMatrix(editorView.state);
          if (matrix !== null && matrix.length > 0) {
            // In-session memory survives WebView tab→space normalization.
            setSessionTableMatrix(matrix);
            // Tab-safe wire format (+ TSV trailer for spreadsheets).
            const plain = encodeMatrixClipboardText(matrix);
            event.clipboardData.setData('text/plain', plain);
            const html = matrixToHtmlTable(matrix);
            if (html !== '') {
              try {
                event.clipboardData.setData('text/html', html);
              } catch {
                // Some environments only allow text/plain.
              }
            }
            // Custom MIME when the host allows it (best structure for re-paste).
            try {
              event.clipboardData.setData(
                'application/x-lightink-table',
                JSON.stringify(matrix),
              );
            } catch {
              /* ignore */
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          }
          const tsv = selectionToTsv(editorView.state);
          if (tsv !== null) {
            event.clipboardData.setData('text/plain', tsv);
            event.preventDefault();
            event.stopImmediatePropagation();
            return true;
          }
          // CellSelection but matrix failed: still block markdown fallback.
          event.preventDefault();
          event.stopImmediatePropagation();
          return true;
        }
        const markdown = getMarkdown({ from, to })(ctx);
        if (markdown === '') {
          return false;
        }
        let html = '';
        try {
          html = selectionToClipboardHtml(editorView);
        } catch {
          html = '';
        }
        const payload = markdownClipboardData(markdown, html);
        event.clipboardData.setData('text/plain', payload['text/plain']);
        if (payload['text/html'] !== undefined && payload['text/html'] !== '') {
          try {
            event.clipboardData.setData('text/html', payload['text/html']);
          } catch {
            // Some environments only allow text/plain.
          }
        }
        try {
          event.clipboardData.setData(LIGHTINK_MARKDOWN_MIME, payload[LIGHTINK_MARKDOWN_MIME]);
        } catch {
          /* ignore */
        }
        // 阻止 PM 冒泡阶段的默认复制（会用渲染态文本覆盖 text/plain）。
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      };

      const onCopy = (event: Event): void => {
        writeMarkdownSource(event as ClipboardEvent);
      };
      const onCut = (event: Event): void => {
        if (writeMarkdownSource(event as ClipboardEvent)) {
          // 复刻 PM cut 的删除语义（因 stopImmediatePropagation 跳过了 PM 处理器）。
          editorView.dispatch(
            editorView.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'),
          );
        }
      };

      // 捕获阶段先于 PM 的冒泡 copy/cut 处理器。
      dom.addEventListener('copy', onCopy, true);
      dom.addEventListener('cut', onCut, true);

      return {
        update() {
          // 选区变化无需重新绑定（监听器读 editorView.state 的实时选区）。
        },
        destroy() {
          dom.removeEventListener('copy', onCopy, true);
          dom.removeEventListener('cut', onCut, true);
        },
      };
    },
  });
});
