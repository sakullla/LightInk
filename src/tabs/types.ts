/**
 * 标签页状态类型（T3）。
 *
 * 多标签状态的唯一 owner 是前端 TabManager：标签列表、活动标签、
 * 每个标签各自的会话。标签按 `kind` 区分两类：
 *   - `markdown`：可写的 Milkdown 编辑标签（既有行为），独占一个
 *     EditorInstance，dirty = 当前内容与 lastSavedMarkdown 不一致；
 *   - `reader`：只读阅读标签（PDF/EPUB/...），不挂编辑器，dirty 恒为
 *     false，永不进入保存/快照/外部变更检测等可写路径。
 */

import type { EditorInstance } from '../editor/types.js';
import type { FileStat } from '../file/file-service.js';
import type { ReaderInstance } from '../reader/types.js';
import type { ReaderTarget } from '../reader/sources/types.js';

/** markdown 与 reader 标签共享的基础会话状态。 */
interface TabBase {
  /** 稳定 id（`tab-<n>`），用于切换/关闭与快照调度。 */
  readonly id: string;
  /** 已保存到磁盘的文件路径；未命名标签为 null。 */
  filePath: string | null;
  /**
   * 未命名标签的合成 id（`untitled-<n>`）。有效快照键 =
   * `filePath ?? syntheticId`（见 tab-manager 的 snapshotKeyOf）。
   */
  readonly syntheticId: string;
  /** 标签标题（文件名或「未命名-n」）。 */
  title: string;
  /** 脏标记：当前内容与 lastSavedMarkdown 不一致即为 true（reader 恒 false）。 */
  dirty: boolean;
  /** 该标签的宿主 DOM 元素（切换时 show/hide）。 */
  readonly hostElement: HTMLElement;
  /** 最近一次已保存（或初始加载）的内容，用于比较得出脏标记。 */
  lastSavedMarkdown: string;
  /**
   * R13：最近一次加载/保存成功时记录的磁盘 `FileStat`（元数据+内容指纹），作为
   * 外部变更检测基线。未命名标签、stat 失败或 reader 标签为 null（不参与检测）。
   */
  lastSavedMtime: FileStat | null;
  /**
   * T3/R3：该标签最近一次保存的滚动位置。markdown 标签由共享滚动容器
   * `#lightink-editor-area` 的 scrollTop 实时回写，切换/打开时据此恢复（新建
   * 标签为 0 = 顶部）；reader 标签自有分页/滚动，此字段恒 0，TabManager 不读写
   * （见 tab-manager 的 onTabSwitched 对 reader 跳过恢复）。
   */
  scrollTop: number;
}

/** 可写 Markdown 编辑标签（既有行为）。独占一个编辑器实例。 */
export interface MarkdownTabState extends TabBase {
  readonly kind: 'markdown';
  /** 该标签独占的编辑器实例。 */
  readonly editor: EditorInstance;
  /** Optional local identity for a document joined into the sync space. */
  managedDocumentId?: string;
}

/**
 * 只读阅读标签（PDF/EPUB/MOBI/FB2/CBZ/CBR/CB7/RAR/7z/TXT）。不挂编辑器，
 * dirty 恒为 false，永不进入保存/快照/外部变更检测等可写路径
 * （见 tab-manager 各方法的 kind 守卫）。持有一个 ReaderInstance，
 * 生命周期由 TabManager 管理。
 */
export interface ReaderTabState extends TabBase {
  readonly kind: 'reader';
  /** Local or remote source descriptor used to load and deduplicate the tab. */
  readonly target: ReaderTarget;
  /** 该标签独占的阅读视图实例。 */
  readonly reader: ReaderInstance;
}

/** 单个标签页的完整会话状态（markdown 编辑标签或只读 reader 标签）。 */
export type TabState = MarkdownTabState | ReaderTabState;

/** User-visible persistence state for an editable document. */
export type DocumentSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** 关闭未保存标签时用户的三选一。 */
export type CloseChoice = 'save' | 'discard' | 'cancel';

/** Application-exit action after the confirmation UI has resolved cancellation. */
export type CloseAllAction = Exclude<CloseChoice, 'cancel'>;
