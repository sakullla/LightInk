/**
 * `reader` — 只读阅读标签的实例契约（ebook-reader T1）。
 *
 * reader 标签（PDF/EPUB/MOBI/FB2/CBZ/CBR/CB7/RAR/7z/TXT）在 TabManager 中以
 * `kind: 'reader'` 与 markdown 编辑标签区分：不挂 Milkdown 编辑器，
 * 永不进入 dirty / autosave / 崩溃快照 / 外部变更检测等可写路径
 * （见 tab-manager 各方法的 kind 守卫）。
 *
 * 实例还提供只读状态快照，供状态栏等应用 chrome 展示加载、阅读位置和缩放；
 * 订阅只观察状态，不参与格式渲染生命周期。
 */

import type { OutlineItem } from '../outline/outline-model.js';
import type { ComicMetadata } from './comic-model.js';
import type { ReaderTarget } from './sources/types.js';

export type ReaderPhase =
  | 'empty'
  | 'loading'
  | 'ready'
  | 'cancelled'
  | 'error'
  | 'destroyed';

export type ReaderLocationKind = 'page' | 'chapter' | null;

/** Immutable, format-neutral reading progress snapshot. */
export interface ReaderState {
  readonly phase: ReaderPhase;
  /** One-based page/chapter when content is available, otherwise 0. */
  readonly current: number;
  readonly total: number;
  /** Overall reading progress normalized to the inclusive 0..1 range. */
  readonly progress: number;
  /** Renderer-owned scale. Application-wide reading scale is applied separately. */
  readonly scale: number;
  readonly locationKind: ReaderLocationKind;
  /** Present while a comic archive is active. */
  readonly comicMetadata?: ComicMetadata;
}

export type ReaderStateListener = (state: ReaderState) => void;

/**
 * 只读阅读视图实例。生命周期由 TabManager 管理（mountReader 创建、
 * closeTab 销毁，对应 markdown 标签的 `editor.destroy`）。reader 标签
 * 活动时，所有编辑器动作（菜单 / 快捷键 / 右键菜单）系统性空转或禁用。
 */
export interface ReaderInstance {
  /** Latest immutable state snapshot. */
  readonly state: ReaderState;
  /** Subscribe to state changes; the current snapshot is delivered immediately. */
  subscribeState(listener: ReaderStateListener): () => void;
  /**
   * 读取并解析文件，把章节渲染进阅读视图（T4 接入流式格式）。
   * 解析失败（DRM、损坏、不支持）reject，由调用方负责 i18n 错误提示。
   */
  load(target: string | ReaderTarget, options?: ReaderLoadOptions): Promise<void>;
  /**
   * 销毁阅读视图：移除 DOM、清理监听与渲染资源。closeTab 关闭 reader
   * 标签时调用；失败由调用方上报，不阻断关闭流程。
   */
  destroy(): Promise<void>;
  /** 在当前阅读位置添加书签（标注未启用时空操作）。 */
  addBookmark(): void;
  /** 在当前阅读位置添加笔记（经 prompt 取文本；标注未启用时空操作）。 */
  addNote(): void;
  /** 切换标注侧栏显隐（默认隐藏）。 */
  toggleSidebar(): void;
  /**
   * 标签可见性变化（切换标签时调用）。侧栏/搜索面板 portal 到共享 chrome，
   * 不随标签宿主隐藏；切走时必须显式隐藏，切回时按原偏好恢复。
   */
  setTabActive(active: boolean): void;
  /** 标注侧栏当前是否可见。 */
  isSidebarVisible(): boolean;
  /** 打开阅读器搜索面板。传入或当前选区会预填并立即搜索，但不跳回首页。 */
  openSearch?(query?: string): void;
  /** 窗口拉伸结束后重算栏宽/高度并刷新可见页，避免文字糊掉。 */
  refreshViewport?(): void;
  /** Re-read synchronized reader preferences and apply them to this open view. */
  refreshPreferences?(): void;
  /**
   * 窗口级翻页（方向键/空格/滚轮）：翻页模式走分栏步进，滚动模式走视口高度。
   * 与 Markdown 的 R1 对齐——悬停大纲/chrome/空白区也应翻正文，不限中间章节容器。
   */
  advanceReading(direction: 1 | -1): boolean;
  /** 当前文档大纲（PDF 书签 / 流式章节 / CBZ 页）；未就绪为空。 */
  getOutline(): readonly OutlineItem[];
  /** 跳转到大纲条目（PDF 按页，流式按章节）。 */
  jumpToOutlineItem(item: OutlineItem): void;
  /** 当前文档是否启用了标注（取决于 content_hash / 标注存储是否可用）。 */
  isAnnotationEnabled(): boolean;
  /**
   * 流式阅读内容的导出 HTML（章节标题 + 正文）。
   * PDF 默认复用 blob URL，避免整本 data URI 撑爆打印；独立 HTML 传 `inline`。
   */
  getExportHtml?(mode?: 'inline' | 'blob'): Promise<string | null>;
}

export interface ReaderLoadOptions {
  /** Optional caller cancellation, combined with the Reader's own supersession signal. */
  signal?: AbortSignal;
}
