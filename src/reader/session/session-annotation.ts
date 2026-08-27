/**
 * `session/session-annotation` — 标注宿主会话策略唯一实现（R1/R3/R5）。
 *
 * 本模块独占的宿主策略（视图不得再各自复制；行为自 reader-view 原样搬迁，
 * 用户可见面冻结）：
 * - 启用判定：标注存储可用（read/write 注入）× adapter 能力声明 × 身份可用。
 *   remote 目标恒可启用（fnv 身份键哈希关联，含远程漫画——现行口径）；本地
 *   目标需成员声明内容哈希标注身份且 content_hash 注入可用——漫画归档不
 *   哈希归档的现行规则固化为 paged-comic 能力行（见 ./adapters
 *   SESSION_FORMAT_CAPABILITIES），核心与视图均不按格式名分支。未启用成员
 *   的标注操作（书签/笔记/划选确认）为空操作，不产生存储写入；
 * - 身份解析与装载：本地 content_hash / remote 身份键 → 读标注 JSON → 解析。
 *   读失败（含无 Tauri IPC）视为空标注，不弹窗阻断阅读；每个 await 点后
 *   复查销毁/取消/世代，过期结果静默丢弃、不留半更新状态；
 * - 写队列：按内容哈希串行写入（annotations.AnnotationWriteQueue），保存
 *   失败且会话身份未变时经宿主提示一次；open 起点与销毁作废未起写的排队项；
 * - 侧栏策略：可见偏好 × 标签可见 → 实际展示；开启先收起触屏搜索层与
 *   chrome 面板（覆盖层互斥），关闭作废搜索会话并复位侧栏搜索框（查询不
 *   跨书残留）；窄窗开启把焦点给予关闭钮、关闭时侧栏持焦点则还给阅读根；
 *   侧栏搜索查询激活时标注列表刷新让位给命中列表。
 * DOM（侧栏节点/portal pin/正文高亮/划选工具栏）与 i18n 留在视图层经 host
 * 供数（T5 hooks 先例）。
 *
 * reader-view 接线对照（原函数/状态 → 本模块入口）：
 * annotationsEnabled/isAnnotationEnabled → enabled；saveAnnotations → save；
 * 划选确认的 writeAnnotations 缺省守卫 → canPersist；loadAnnotationsForSession
 * → load；contentHash 状态（beforeCommit 复位/settle 消费） → beginSession/
 * contentHash；annotationWriteQueue.invalidate（beginOpen/destroy） →
 * invalidateWrites/dispose；setSidebarVisible/syncSidebarOverlayDom（shown =
 * sidebarVisible && tabActive）/renderSidebarAnnotations（查询让位） →
 * setSidebarVisible/syncSidebarDom 经 host/syncSidebarList。
 */

import {
  AnnotationWriteQueue,
  parseAnnotations,
  serializeAnnotations,
  type Annotation,
} from '../annotations.js';
import { fnv1a64Hex } from '../document-hash.js';
import { readerIdentityKey, type ReaderTarget } from '../sources/types.js';
import {
  sessionCapabilitiesForExtension,
  type SessionRunContext,
} from './adapters.js';

/** 标注存储注入面（生产为 Rust IPC；缺省项即对应能力不可用）。 */
export interface SessionAnnotationStorage {
  /** 读标注 JSON（Rust read_annotations）；缺省则标注整体不启用。 */
  readAnnotations?(contentHash: string): Promise<string>;
  /** 写标注 JSON（Rust write_annotations）；缺省则划选确认不落盘。 */
  writeAnnotations?(contentHash: string, json: string): Promise<void>;
  /** 文件内容哈希（Rust content_hash）；本地文档的标注身份源。 */
  getContentHash?(filePath: string): Promise<string>;
}

/** 侧栏可见状态：用户偏好与实际展示（偏好 × 标签可见）分离。 */
export interface SessionSidebarVisibility {
  /** 用户可见偏好（切标签不丢，切回恢复）。 */
  readonly visible: boolean;
  /** 实际展示 = 可见偏好 && 标签可见（切走标签必须隐藏 portal 覆盖层）。 */
  readonly shown: boolean;
}

/** 视图侧钩子：核心持有策略与状态，DOM/存储执行留在视图层。 */
export interface SessionAnnotationHost {
  /** 标注存储注入面（原 reader-view deps 的标注三件套）。 */
  readonly storage: SessionAnnotationStorage;
  /** 标注保存失败提示（仅在视图未销毁且会话身份未变时被调用）。 */
  notifySaveFailed(): void;
  /** 视图已销毁（装载续行与失败提示的守卫）。 */
  isDestroyed(): boolean;

  // —— 侧栏 DOM 钩子（显隐策略在核心，装配/portal/焦点机械在视图） ——

  /** 懒建侧栏 DOM（首次显示或标注装载采纳时）。 */
  ensureSidebarDom(): void;
  /** 把可见状态同步到 DOM/portal/背景层（状态经 sidebarVisibility() 读取）。 */
  syncSidebarDom(): void;
  /** 窄窗 drawer 判定（≤700px：开启时把焦点给予关闭钮）。 */
  isNarrowViewport(): boolean;
  /** 焦点给予侧栏关闭钮（窄窗开启）。 */
  focusSidebarClose(): void;
  /** 侧栏当前持有键盘焦点（关闭时判定是否还给阅读根）。 */
  sidebarHoldsFocus(): boolean;
  /** 焦点还给阅读根（侧栏持焦点关闭时）。 */
  focusReaderRoot(): void;
  /** 开启侧栏先收起触屏搜索层（覆盖层互斥）。 */
  closeSearchSheet(): void;
  /** 开启侧栏先收起 chrome 面板（覆盖层互斥）。 */
  closeChromePanel(): void;
  /** 关闭侧栏作废搜索会话并复位侧栏搜索框（查询不跨书残留）。 */
  resetSearch(): void;
  /** 显隐同步后的视图收尾（可见章节帧刷新）。 */
  afterSidebarSync(): void;
  /** 侧栏搜索查询（非空时标注列表刷新让位给命中列表）。 */
  sidebarSearchQuery(): string;
  /** 渲染标注列表（查询让位判定由核心持有）。 */
  renderSidebarList(): void;
}

/** 标注宿主会话句柄：reader-view 以 host 供数并消费其策略裁决。 */
export interface ReaderSessionAnnotation {
  /** 启用判定（菜单勾选与操作守卫）：标注存储 × 能力声明 × 身份可用。 */
  enabled(): boolean;
  /** 划选确认可写（writeAnnotations 注入可用；写队列策略的一部分）。 */
  canPersist(): boolean;
  /** 当前会话内容哈希（进度身份链消费；未解析/读失败为 null）。 */
  contentHash(): string | null;
  /** open 起点：作废未起写的排队项（管线 beginOpen；含上一会话遗留）。 */
  invalidateWrites(): void;
  /** 采纳新会话事实（管线 beforeCommit）：记录成员/目标并清身份。 */
  beginSession(ext: string, target: ReaderTarget): void;
  /**
   * 装载当前会话标注：启用判定 → 身份解析 → 读取 → 解析。返回采纳集合
   * （读失败视为空标注，不报错）；未启用或过期（销毁/取消/世代失配）返回
   * null 且不改任何状态（跳过时 beforeCommit 已复位视图集合）。
   */
  load(
    ext: string,
    target: ReaderTarget,
    context: SessionRunContext,
  ): Promise<Annotation[] | null>;
  /** 写队列策略：按当前身份串行写入（无身份/无写入注入为 no-op）。 */
  save(annotations: readonly Annotation[]): Promise<void>;
  /** 侧栏可见偏好切换（开启收起搜索层/chrome 面板；关闭作废搜索会话）。 */
  setSidebarVisible(visible: boolean): void;
  /** 标签可见性变化（只影响 shown，不改偏好）；返回状态是否变化。 */
  setTabActive(active: boolean): boolean;
  /** 当前标签可见性（侧栏 shown 的合成因子；视图守卫用，如 refreshOpenSearch）。 */
  tabActive(): boolean;
  /** 侧栏可见状态（偏好与实际展示）。 */
  sidebarVisibility(): SessionSidebarVisibility;
  /** 标注列表刷新（侧栏搜索查询激活时让位给命中列表）。 */
  syncSidebarList(): void;
  /** 销毁收尾：作废排队项并清会话事实（此后启用判定回到存储面）。 */
  dispose(): void;
}

export function createReaderSessionAnnotation(
  host: SessionAnnotationHost,
): ReaderSessionAnnotation {
  const storage = host.storage;
  const writeQueue = new AnnotationWriteQueue();
  /** 已采纳会话事实（beforeCommit 记录；销毁清空）。 */
  let sessionExt: string | null = null;
  let sessionTarget: ReaderTarget | null = null;
  /** 当前会话标注身份（装载成功为哈希；读失败/未装载为 null）。 */
  let contentHash: string | null = null;
  /** 侧栏可见偏好与标签可见（实际展示 = 偏好 × 标签）。 */
  let sidebarVisible = false;
  let tabActive = true;

  const isStale = (context: SessionRunContext): boolean =>
    host.isDestroyed() || context.signal.aborted || !context.isCurrent();

  /**
   * 启用判定的会话面：remote 恒可（身份键哈希，现行口径，含远程漫画）；
   * 本地 = 成员声明内容哈希标注身份（漫画行声明 null）且 content_hash
   * 注入可用。
   */
  const hostable = (ext: string, target: ReaderTarget): boolean => {
    if (target.kind === 'remote') {
      return true;
    }
    const capabilities = sessionCapabilitiesForExtension(ext);
    return (
      capabilities !== null &&
      capabilities.annotations.localIdentity === 'content-hash' &&
      storage.getContentHash !== undefined
    );
  };

  const visibility = (): SessionSidebarVisibility => ({
    visible: sidebarVisible,
    shown: sidebarVisible && tabActive,
  });

  const load = async (
    ext: string,
    target: ReaderTarget,
    context: SessionRunContext,
  ): Promise<Annotation[] | null> => {
    if (storage.readAnnotations === undefined || !hostable(ext, target)) {
      return null; // 未启用（存储/能力/身份缺失）：不装载、不留半更新状态
    }
    try {
      let nextHash: string;
      if (target.kind === 'local') {
        const getContentHash = storage.getContentHash;
        if (getContentHash === undefined) {
          return null; // 启用判定的 content_hash 因子（hostable 已判，防御）
        }
        nextHash = await getContentHash(target.path);
      } else {
        nextHash = fnv1a64Hex(`remote:${readerIdentityKey(target.identity)}`);
      }
      if (isStale(context)) {
        return null;
      }
      const nextAnnotations = parseAnnotations(await storage.readAnnotations(nextHash));
      if (isStale(context)) {
        return null;
      }
      contentHash = nextHash;
      return nextAnnotations;
    } catch {
      if (isStale(context)) {
        return null;
      }
      // 与 Rust R4 一致：读失败（含无 Tauri IPC）视为空标注，不弹窗阻断阅读。
      contentHash = null;
      return [];
    }
  };

  return {
    enabled: () => {
      if (storage.readAnnotations === undefined) {
        return false;
      }
      if (sessionExt === null || sessionTarget === null) {
        return true; // 无已采纳会话（空态/销毁后）：存储可用即启用（原口径）
      }
      return hostable(sessionExt, sessionTarget);
    },
    canPersist: () => storage.writeAnnotations !== undefined,
    contentHash: () => contentHash,
    invalidateWrites: () => {
      writeQueue.invalidate();
    },
    beginSession: (ext, target) => {
      sessionExt = ext;
      sessionTarget = target;
      contentHash = null;
    },
    load,
    save: async (annotations) => {
      const hash = contentHash;
      if (hash === null || storage.writeAnnotations === undefined) {
        return;
      }
      const json = serializeAnnotations(annotations);
      await writeQueue.enqueue(hash, json, storage.writeAnnotations, () => {
        if (!host.isDestroyed() && contentHash === hash) {
          host.notifySaveFailed();
        }
      });
    },
    setSidebarVisible: (visible) => {
      if (visible) {
        host.closeSearchSheet();
        host.closeChromePanel();
      }
      if (!visible && sidebarVisible) {
        host.resetSearch();
      }
      sidebarVisible = visible;
      if (visible) {
        host.ensureSidebarDom();
      }
      host.syncSidebarDom();
      if (sidebarVisible && host.isNarrowViewport()) {
        host.focusSidebarClose();
      }
      if (!sidebarVisible && host.sidebarHoldsFocus()) {
        host.focusReaderRoot();
      }
      host.afterSidebarSync();
    },
    setTabActive: (active) => {
      if (tabActive === active) {
        return false;
      }
      tabActive = active;
      host.syncSidebarDom();
      return true;
    },
    tabActive: () => tabActive,
    sidebarVisibility: visibility,
    syncSidebarList: () => {
      if (host.sidebarSearchQuery().trim() !== '') {
        return; // 搜索查询激活：命中列表让位（原 renderSidebarAnnotations 守卫）
      }
      host.renderSidebarList();
    },
    dispose: () => {
      writeQueue.invalidate();
      sessionExt = null;
      sessionTarget = null;
      contentHash = null;
    },
  };
}
