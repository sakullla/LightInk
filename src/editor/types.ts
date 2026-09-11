/**
 * Shared types used by the editor modules and their tests.
 *
 * The editor is built around a Milkdown-style ProseMirror schema, but for the
 * testable layers we expose a stable, framework-agnostic vocabulary that the
 * pure parser, paste handler, and cursor-toggle state machine all speak.
 */

import type { Root as MdastRoot } from 'mdast';

/** All CommonMark + GFM + front matter syntax kinds the editor covers. */
export type SyntaxKind =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'paragraph'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list-item'
  | 'blockquote'
  | 'inline-code'
  | 'code-block'
  | 'table'
  | 'link'
  | 'image'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'thematic-break'
  | 'front-matter'
  | 'footnote'
  | 'text';

/**
 * MDAST node `type` literal. mdast's union is exhaustive but verbose; we
 * alias it here so callers don't have to thread `mdast` types everywhere.
 */
export type MdastType =
  | 'root'
  | 'paragraph'
  | 'heading'
  | 'text'
  | 'emphasis'
  | 'strong'
  | 'delete'
  | 'inlineCode'
  | 'code'
  | 'blockquote'
  | 'list'
  | 'listItem'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'link'
  | 'image'
  | 'thematicBreak'
  | 'break'
  | 'html'
  | 'definition'
  | 'footnoteDefinition'
  | 'footnoteReference'
  | 'yaml';

/** Lightweight wrapper around a parsed MDAST tree with metadata. */
export interface ParsedDocument {
  /** Raw markdown source. */
  readonly source: string;
  /** MDAST root. */
  readonly root: MdastRoot;
  /** Total word count in the source (whitespace-split tokens). */
  readonly wordCount: number;
  /** Total character length of the source. */
  readonly charCount: number;
}

/** Editor mount call options. All fields are optional. */
export interface MountOptions {
  /** Initial markdown to load into the editor. */
  readonly initialMarkdown?: string;
  /** Called once for each document-changing transaction in this editor instance. */
  readonly onContentChanged?: () => void;
  /** Whether the cursor-toggle behavior is on (default true). */
  readonly cursorToggle?: boolean;
  /**
   * Override the asset directory for pasted images.
   * T2 only stubs this — persistence is delivered by T4.
   */
  readonly assetsDir?: string;
  /**
   * Initial ProseMirror editable flag. Default true (desktop). Immersive
   * Markdown reading mounts false and later calls `setEditable`.
   */
  readonly editable?: boolean;
  /**
   * R14：Ctrl/Cmd+点击文档内链接 mark 时回调（由 main.ts 分类后跳转：外链→浏览器、
   * 本地 .md→新标签、其他本地文件→系统默认程序）。
   */
  readonly onLinkNavigate?: (href: string) => void;
  /**
   * Optional confirm gate before onLinkNavigate. Return false to cancel.
   * Production wires a themed modal (Ctrl+click only).
   */
  readonly confirmLinkOpen?: (href: string) => boolean | Promise<boolean>;
  /**
   * T4/R2：标题折叠态变化时回调（编辑器内点三角切换后通知宿主刷新大纲的折叠
   * 指示）。经 mountEditor 选项注入，由 heading-fold 插件在折叠集合变化时触发。
   */
  readonly onFoldChanged?: () => void;
}

/** 当前选区的位置摘要（R7/R3 选区访问器）。 */
export interface SelectionSummary {
  readonly from: number;
  readonly to: number;
  readonly empty: boolean;
}

/** One-based logical text position used by the document status bar. */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

/** 光标处链接的信息（R7/R3 链接查询）。 */
export interface CursorLink {
  readonly href: string;
  readonly text: string;
}

/** Public handle returned from `mountEditor`. */
export interface EditorInstance {
  /** Promise that resolves once the underlying ProseMirror editor is created. */
  readonly ready: Promise<void>;
  /** Replace editor contents with new markdown. */
  setMarkdown(markdown: string): void;
  /** Read current editor contents as markdown (best-effort serialization). */
  getMarkdown(): string;
  /**
   * 当前选区摘要（{from,to,empty}）。编辑器未就绪时返回 null。
   * 供 R3 上下文菜单启用/禁用与动作使用。
   */
  getSelection(): SelectionSummary | null;
  /** One-based cursor line/column in the rendered document text flow. */
  getCursorPosition(): CursorPosition | null;
  /**
   * 光标处的链接（href + 文本）。光标不在链接上或编辑器未就绪时返回 null。
   * 供 R3 链接的打开/复制地址使用。
   */
  getLinkAtCursor(): CursorLink | null;
  /**
   * 右键坐标 (clientX/clientY) 处的链接（href + 文本）。坐标处无链接或编辑器未就绪时
   * 返回 null。供 R3 右键上下文菜单的打开/复制地址使用——按右键位置而非文本光标判断。
   */
  getLinkAtPoint(x: number, y: number): CursorLink | null;
  /**
   * 在当前选区上切换某个 mark（如 'strong'/'emphasis'/'strike_through'/'inlineCode'）。
   * 无选区或未就绪时为空操作。供 R3 上下文菜单格式操作使用。
   */
  toggleMark(markName: string): void;
  /**
   * Apply / replace a link over the current selection.
   * - When selection is non-empty: wrap it (optionally replace text with `text`).
   * - When selection is empty: insert `text` (or href) as a linked run.
   * After applying, storedMarks drop the link so further typing is plain.
   */
  setLink(href: string, text?: string): void;
  /**
   * 在当前选区插入图片节点（url 为文档相对引用 `assets/<name>.<ext>`）。
   * schema 无 image 节点或未就绪时为空操作。供「插入图片」本地文件选择流程使用。
   */
  insertImage(url: string, alt: string): void;
  /**
   * Insert structured markdown at the caret (parses via Milkdown, replaces the
   * enclosing empty/line-start textblock). Returns false on parse/range failure.
   */
  insertMarkdown(markdown: string): boolean;
  /** Whether the caret is inside a GFM table. */
  isInTable(): boolean;
  /**
   * Table structure op (insert/delete row/col, select row/col, delete table).
   * Returns false when not in a table or the command cannot run.
   */
  runTableOp(
    op:
      | 'insert-col-left'
      | 'insert-col-right'
      | 'insert-row-above'
      | 'insert-row-below'
      | 'delete-row'
      | 'delete-column'
      | 'delete-table'
      | 'select-row'
      | 'select-column',
  ): boolean;
  /**
   * Focus the ProseMirror surface so typing can start without hunting the caret
   * (immersive shell R4 empty/new-tab path). No-op if the editor is not ready.
   */
  focus(): void;
  /**
   * Switch ProseMirror `editable`. Reading false (`contenteditable=false`,
   * no keyboard, document commands no-op); editing true. Desktop stays true.
   */
  setEditable(editable: boolean): void;
  /** Current `setEditable` flag. Unready editors report the last requested value. */
  isEditable(): boolean;
  /**
   * 全选当前文档（渐进式：表格内逐层 cell→table→doc，表外 文本块→整篇），与
   * Mod-a 行为一致。供「编辑/右键 全选」菜单（R10）使用；未就绪时为空操作。
   */
  selectAll(): void;
  /**
   * Undo the last document change via ProseMirror history.
   * Prefer this over synthetic Ctrl+Z key events (menus steal focus).
   */
  undo(): void;
  /** Redo the last undone change via ProseMirror history. */
  redo(): void;
  /**
   * T4/R2：切换第 `ordinal` 个标题（文档顺序，从 0 起，与大纲 anchor 同口径）的
   * 折叠态。序号越界或编辑器未就绪时空操作。供大纲折叠标记点击联动。
   */
  toggleFoldAtOrdinal(ordinal: number): void;
  /**
   * T4/R2：当前已折叠标题的序号列表（与大纲 anchor 同口径），供大纲渲染折叠态。
   * 折叠态不持久化（重开为空）。编辑器未就绪时返回空数组。
   */
  getFoldedOrdinals(): number[];
  /** Tear the editor down (removes DOM, nulls listeners). */
  destroy(): Promise<void>;
}
