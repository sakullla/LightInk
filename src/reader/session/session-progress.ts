/**
 * `session/session-progress` — 进度会话规则唯一实现（R1/R3）。
 *
 * 本模块独占的会话规则（视图与格式侧不得再各自复制）：
 * - 进度身份链：progressId → path → 书库 alias → readerIdentityKey →
 *   contentHash（按序首个命中即恢复源；写键 remote=itemId、本地优先内容哈希、
 *   缺省路径）。漫画在标注装载前经同一策略的短链提前绑定（不哈希归档）。
 *   身份判定修改一处即对全部格式（flow/paged 两族）生效；
 * - 保存时机：滚动/翻页事件 400ms 防抖合并写入；换书/返回书架/销毁时立即
 *   尽力保存（force 允许 pendingRestore 兜底快照）；
 * - 进度 v2 会话字段：readingMs 在阅读会话活跃时累计（心跳合并进 400ms
 *   防抖写入；2 分钟无输入暂停计时），到达末页/末章末尾置 status='finished'
 *   （读完为粘性语义，改回在读由书架侧手动完成）；
 * - 恢复重试阈值（数值自 reader-view 原样搬迁，行为冻结）：滚动模式等章节
 *   高度共 12 次重试（第 13 次由供数侧尽力落点）；翻页模式帧已就绪但分栏
 *   未量出（OPDS 慢章）8 次放弃；帧未挂载总预算 12×8=96 帧。超过阈值即
 *   放弃并停在当时可读位置，不再循环、不报错；
 * - page/flow 快照与恢复落点经两族 feed 供数（adapter 模式）：核心按
 *   saved.kind 派发并持有计数/阈值/续帧裁决，DOM/滚动机械留在视图层
 *   （原 reader-view 的 currentProgressSnapshot/applySavedProgress 格式分支删除）。
 */

import { loadLibraryProgressAlias } from '../../library/library-progress.js';
import {
  loadReadingProgress,
  loadReadingProgressFromIds,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from '../reading-progress.js';
import { readerIdentityKey, type ReaderTarget } from '../sources/types.js';
import type { SessionAdapterKind } from './adapters.js';

/** 滚动模式：等章节高度量出的恢复重试上限（第 13 次探测尽力落点）。 */
export const FLOW_RESTORE_MAX_ATTEMPTS = 12;

/** 翻页模式：帧已就绪但分栏未量出（OPDS 慢章）的放弃阈值。 */
export const PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS = 8;

/** 翻页模式：帧未挂载（OPDS 章迟加载）的恢复总预算（12 × 8 = 96 帧）。 */
export const PAGED_FRAME_RESTORE_MAX_ATTEMPTS =
  FLOW_RESTORE_MAX_ATTEMPTS * PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS;

/** 保存防抖窗口（ms）：滚动/翻页事件合并为一次进度写入。 */
export const PROGRESS_SAVE_DEBOUNCE_MS = 400;

/** 空闲阈值（ms）：无输入超过 2 分钟暂停阅读时长（readingMs）计时。 */
export const READING_IDLE_PAUSE_MS = 2 * 60 * 1000;

/** 末章"末尾"判定：章内比例 ≥0.99 视为读完（R4 status='finished'）。 */
const READING_FINISH_RATIO = 0.99;

/**
 * 到达末尾判定：paged 到达末页（1-based 页码 ≥ 总页数）；flow 到达末章
 * 且章内比例到末尾。total 未知时不判读完。
 */
function isFinishedSnapshot(progress: ReadingProgress): boolean {
  const total = progress.total;
  if (total === undefined || !Number.isSafeInteger(total) || total < 1) {
    return false;
  }
  if (progress.kind === 'page') {
    return progress.index >= total;
  }
  return progress.index >= total - 1 && progress.ratio >= READING_FINISH_RATIO;
}

/** Same identity page progress already uses: remote itemId, local path. */
export function comicProgressIdForTarget(target: ReaderTarget): string {
  return target.kind === 'remote' ? target.itemId : target.path;
}

/**
 * 写入键：remote 用 itemId（OPDS 稳定键），本地优先内容哈希（标注同源），
 * 缺省退回文件路径。
 */
export function documentProgressId(
  target: ReaderTarget,
  contentHash: string | null,
): string {
  if (target.kind === 'remote') {
    return target.itemId;
  }
  return contentHash ?? target.path;
}

/** 书库 alias 查询键：remote 用 itemId，本地用 reader 身份 id。 */
function libraryAliasLookupId(target: ReaderTarget): string {
  return target.kind === 'remote' ? target.itemId : target.identity.id;
}

/** 文档（flow/pdf）恢复源身份链：按序首个命中即恢复源。 */
export function documentProgressRestoreIds(
  storage: ProgressStorage | null,
  target: ReaderTarget,
  progressId: string,
  contentHash: string | null,
): string[] {
  const filePath = target.kind === 'local' ? target.path : target.displayName;
  return [
    progressId,
    target.kind === 'local' ? filePath : '',
    loadLibraryProgressAlias(storage, libraryAliasLookupId(target)) ?? '',
    target.kind === 'remote' ? readerIdentityKey(target.identity) : '',
    contentHash ?? '',
  ];
}

/** 漫画提前绑定链：不哈希归档；页进度按身份键/路径/书库 alias 直接命中。 */
export function comicProgressRestoreIds(
  storage: ProgressStorage | null,
  target: ReaderTarget,
  progressId: string,
): string[] {
  return [
    progressId,
    target.kind === 'local' ? target.path : '',
    loadLibraryProgressAlias(storage, libraryAliasLookupId(target)) ?? '',
  ];
}

/** 供数侧报告的未就绪原因（只陈述表面事实，不裁决重试策略）。 */
export type SessionProgressPendingReason =
  | 'page-host'
  | 'flow-content'
  | 'flow-frame'
  | 'flow-frame-scroller'
  | 'flow-measure'
  | 'flow-scroll-range';

/** 一次恢复尝试的结果：已落点（可要求记忆为最近快照）或未就绪原因。 */
export type SessionProgressApplyResult =
  | { readonly applied: true; readonly rememberAsSnapshot?: boolean }
  | { readonly applied: false; readonly pending: SessionProgressPendingReason };

/**
 * 一族进度供数（adapter 模式）：本族快照读取与恢复落点执行。DOM/滚动机械
 * 留在视图层实现；核心经 saved.kind 派发并持有计数与阈值裁决。
 */
export interface SessionProgressFeed {
  /** 当前阅读位置快照；无已渲染内容时 null。 */
  snapshot(): ReadingProgress | null;
  /**
   * 尝试落点。`attempts` 为本次尝试前已失败次数（滚动模式供数侧在
   * `attempts >= FLOW_RESTORE_MAX_ATTEMPTS` 时自行转为尽力落点，与原
   * reader-view 计数位置一致）。已落点返回 `rememberAsSnapshot` 时核心把
   * 该记录记为最近快照（滚动模式恢复语义；翻页/页式不记）。
   */
  apply(saved: ReadingProgress, state: { readonly attempts: number }): SessionProgressApplyResult;
}

/** 视图侧钩子：核心驱动时序/阈值/身份链，DOM 与状态读取留在视图层。 */
export interface SessionProgressHost {
  /** 进度存储（生产 localStorage；null 时读写全部为 no-op）。 */
  readonly storage: ProgressStorage | null;
  /** flow 族供数（TXT/FB2/EPUB/MOBI）。 */
  readonly flow: SessionProgressFeed;
  /** paged 族供数（PDF/漫画归档）。 */
  readonly paged: SessionProgressFeed;
  /** 当前会话族（快照派发用；无内容时 flow 供数自返 null）。 */
  activeKind(): SessionAdapterKind;
  /** 是否处于可保存阶段（原 phase ∈ {ready, loading} 判定）。 */
  canPersistNow(): boolean;
  /** 是否处于可恢复阶段（公开恢复入口的 phase 门控）。 */
  canRestoreNow(): boolean;
  /** 视图已销毁（重试帧与防抖写入的续行守卫）。 */
  isDestroyed(): boolean;
  /** 身份绑定完成通知（书库 `item.id → progressId` alias 写入）。 */
  onProgressBound?(progressId: string, target: ReaderTarget): void;
}

/** 进度会话句柄：reader-view 以两族 feed 供数并消费其裁决（T5 hooks 先例）。 */
export interface ReaderSessionProgress {
  /** 当前写入键（漫画偏好键、书库绑定等视图侧消费）。 */
  progressId(): string;
  /** 有待应用的恢复进度（恢复中/待重试）。 */
  hasPendingRestore(): boolean;
  /** 当前位置快照（经活动族 feed 供数；原 currentProgressSnapshot）。 */
  snapshot(): ReadingProgress | null;
  /** 记住当前快照（滚动事件后、写入前调用）。 */
  rememberSnapshot(): void;
  /** 防抖写入（滚动/翻页事件后 400ms 合并；事件本身即阅读活动信号）。 */
  schedulePersist(): void;
  /** 阅读输入活动信号：刷新空闲计时窗口（无输入 2 分钟后 readingMs 暂停）。 */
  noteActivity(): void;
  /** 立即尽力写入（允许 pendingRestore 兜底快照；返回书架路径）。 */
  persistNow(): void;
  /** 新会话起点：保存上一本 → 清身份/待恢复/计数/最近快照（beginOpen）。 */
  beginSession(): void;
  /** 文档身份链绑定（settle 尾巴）：算 progressId、读恢复源、迁移旧键记录。 */
  bindDocumentIdentity(target: ReaderTarget, contentHash: string | null): void;
  /** 漫画提前绑定（paged afterCommit：标注装载前按页恢复，不回填迁移）。 */
  bindComicIdentity(target: ReaderTarget): void;
  /** 按已绑定身份通知书库（onProgressBound；progressId 空时不发）。 */
  notifyProgressBound(target: ReaderTarget): void;
  /** 公开恢复入口（ReaderInstance.restoreReadingProgress）：内存/存储→落点。 */
  restore(): void;
  /** 应用一次待恢复进度（已消费/无待恢复返回 true；不自行调度重试）。 */
  applyPending(): boolean;
  /** 应用待恢复进度，未就绪时请求 rAF 重试（帧 load 钩子/seek/重排后）。 */
  applyPendingWithRetry(): void;
  /** 重置重试计数并重新落点（标签切回：恢复目标不变，预算重新开始）。 */
  retryPending(): void;
  /** 请求下一帧重试（幂等：已有在途帧则忽略）。 */
  scheduleRestoreRetry(): void;
  /** 取消在途重试帧（不清待恢复进度）。 */
  cancelRestoreRetry(): void;
  /** 待恢复进度清空并取消重试（大纲跳转防迟来恢复覆盖落点）。 */
  discardPending(): void;
  /** 暂存恢复目标并重置计数（apply 由调用方在重测后决定时机）。 */
  stage(saved: ReadingProgress): void;
  /** 重排期捕获：pending → 最近快照 → 当前快照。 */
  captureForRelayout(): ReadingProgress | null;
  /** 直接写入一份快照（布局切换前保存当前位置，不经防抖与阶段判定）。 */
  persistSnapshot(saved: ReadingProgress | null): void;
  /** 销毁收尾：尽力保存 + 清防抖定时器与重试帧。 */
  dispose(): void;
}

/**
 * 未就绪原因 → 放弃阈值（rAF 帧数）。滚动类原因（flow-measure/
 * flow-scroll-range）由供数侧在第 13 次探测自行尽力落点，此处 96 仅为
 * 兜底（保证任何原因都有限次重试，不再无限循环）。
 */
const RESTORE_PENDING_GIVE_UP_ATTEMPTS: Readonly<
  Record<SessionProgressPendingReason, number>
> = {
  'flow-frame': PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
  'flow-frame-scroller': PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS,
  'flow-measure': PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
  'flow-scroll-range': PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
  'flow-content': PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
  'page-host': PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
};

export function createReaderSessionProgress(host: SessionProgressHost): ReaderSessionProgress {
  let progressId = '';
  let pendingRestore: ReadingProgress | null = null;
  let lastProgress: ReadingProgress | null = null;
  let restoreAttempts = 0;
  let restoreRetryFrame: number | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // —— 进度 v2 会话字段：base* 为绑定时既有记录值；会话活跃累计随写入合并。 ——
  let baseReadingMs = 0;
  let sessionReadingMs = 0;
  let baseFinished = false;
  let sessionFinished = false;
  /** 计时截止点：最近活动 + 空闲阈值；超过即暂停 readingMs 累计。 */
  let activeUntil = 0;
  let lastTickAt: number | null = null;

  /**
   * 心跳：把上次 tick 到本次活动截止点之间的时长计入会话累计。空闲期
   * （超过 activeUntil）不计入；活动恢复时从恢复点重新起计。
   */
  const tickReading = (now: number): void => {
    if (lastTickAt === null) {
      return;
    }
    const countedUntil = Math.min(now, activeUntil);
    if (countedUntil > lastTickAt) {
      sessionReadingMs += countedUntil - lastTickAt;
      lastTickAt = countedUntil;
    }
  };

  const noteActivityAt = (now: number): void => {
    tickReading(now);
    if (lastTickAt === null || lastTickAt < now) {
      // 会话起点，或空闲后恢复：从当前时刻重新起计。
      lastTickAt = now;
    }
    activeUntil = now + READING_IDLE_PAUSE_MS;
  };

  /** 写入前合并 v2 会话字段：updatedAt/累计时长/读完状态（读完为粘性语义）。 */
  const withSessionFields = (stored: ReadingProgress, now: number): ReadingProgress => {
    tickReading(now);
    if (isFinishedSnapshot(stored)) {
      sessionFinished = true;
    }
    return {
      ...stored,
      updatedAt: now,
      readingMs: baseReadingMs + sessionReadingMs,
      ...(baseFinished || sessionFinished ? { status: 'finished' as const } : {}),
    };
  };

  const snapshot = (): ReadingProgress | null =>
    (host.activeKind() === 'paged' ? host.paged : host.flow).snapshot();

  const rememberSnapshot = (): void => {
    const next = snapshot();
    if (next !== null) {
      lastProgress = next;
    }
  };

  const persist = (force = false): void => {
    if (progressId === '') {
      return;
    }
    if (!force && pendingRestore !== null) {
      return;
    }
    if (!force && !host.canPersistNow()) {
      return;
    }
    rememberSnapshot();
    const stored =
      lastProgress ?? (force && pendingRestore !== null ? pendingRestore : null);
    if (stored !== null) {
      saveReadingProgress(host.storage, progressId, withSessionFields(stored, Date.now()));
    }
  };

  /** 新身份绑定：以命中记录为 base，重置会话累计并启动活跃计时。 */
  const beginBoundSession = (bound: ReadingProgress | null): void => {
    baseReadingMs = bound?.readingMs ?? 0;
    baseFinished = bound?.status === 'finished';
    sessionReadingMs = 0;
    sessionFinished = false;
    lastTickAt = null;
    activeUntil = 0;
    noteActivityAt(Date.now());
  };

  const cancelRestoreRetry = (): void => {
    if (restoreRetryFrame !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(restoreRetryFrame);
      }
      restoreRetryFrame = null;
    }
  };

  const scheduleRestoreRetry = (): void => {
    if (host.isDestroyed() || pendingRestore === null || restoreRetryFrame !== null) {
      return;
    }
    if (typeof requestAnimationFrame !== 'function') {
      return;
    }
    restoreRetryFrame = requestAnimationFrame(() => {
      restoreRetryFrame = null;
      if (host.isDestroyed() || pendingRestore === null) {
        return;
      }
      if (!applyPending()) {
        scheduleRestoreRetry();
      }
    });
  };

  /**
   * 应用一次待恢复进度：按 saved.kind 派发族 feed；未就绪时计数并按原因
   * 判定放弃（计数位置与原 reader-view 一致：先检查后递增的滚动模式由
   * 供数侧用传入 attempts 自转尽力落点，翻页模式在递增后达阈值即放弃）。
   */
  const applyPending = (): boolean => {
    const saved = pendingRestore;
    if (saved === null) {
      return true;
    }
    const feed = saved.kind === 'page' ? host.paged : host.flow;
    const result = feed.apply(saved, { attempts: restoreAttempts });
    if (result.applied) {
      if (result.rememberAsSnapshot === true) {
        lastProgress = saved;
      }
      pendingRestore = null;
      return true;
    }
    restoreAttempts += 1;
    if (restoreAttempts >= RESTORE_PENDING_GIVE_UP_ATTEMPTS[result.pending]) {
      // 恢复重试超过阈值：放弃并停在当时可读位置（不报错、不再循环）。
      pendingRestore = null;
      return true;
    }
    return false;
  };

  const applyPendingWithRetry = (): void => {
    if (!applyPending()) {
      scheduleRestoreRetry();
    }
  };

  return {
    progressId: () => progressId,
    hasPendingRestore: () => pendingRestore !== null,
    snapshot,
    rememberSnapshot,
    schedulePersist: () => {
      noteActivityAt(Date.now());
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        saveTimer = null;
        persist();
      }, PROGRESS_SAVE_DEBOUNCE_MS);
    },
    noteActivity: () => {
      noteActivityAt(Date.now());
    },
    persistNow: () => {
      persist(true);
    },
    beginSession: () => {
      persist();
      progressId = '';
      pendingRestore = null;
      restoreAttempts = 0;
      cancelRestoreRetry();
      // 最近快照随会话作废：跨书残留会把上一本的章节/比例恢复进新书。
      lastProgress = null;
      // 会话字段同步作废：时长/读完状态不得带入下一本。
      baseReadingMs = 0;
      sessionReadingMs = 0;
      baseFinished = false;
      sessionFinished = false;
      lastTickAt = null;
      activeUntil = 0;
    },
    bindDocumentIdentity: (target, contentHash) => {
      progressId = documentProgressId(target, contentHash);
      pendingRestore = loadReadingProgressFromIds(
        host.storage,
        documentProgressRestoreIds(host.storage, target, progressId, contentHash),
      );
      if (
        pendingRestore !== null &&
        progressId !== '' &&
        loadReadingProgress(host.storage, progressId) === null
      ) {
        // 旧键（path/书库 alias/identityKey）命中的记录迁移到写入键下。
        saveReadingProgress(host.storage, progressId, pendingRestore);
      }
      restoreAttempts = 0;
      cancelRestoreRetry();
      beginBoundSession(pendingRestore);
    },
    bindComicIdentity: (target) => {
      progressId = comicProgressIdForTarget(target);
      pendingRestore = loadReadingProgressFromIds(
        host.storage,
        comicProgressRestoreIds(host.storage, target, progressId),
      );
      restoreAttempts = 0;
      cancelRestoreRetry();
      beginBoundSession(pendingRestore);
    },
    notifyProgressBound: (target) => {
      if (progressId === '') {
        return;
      }
      try {
        host.onProgressBound?.(progressId, target);
      } catch {
        // Shelf alias must not interrupt reading.
      }
    },
    restore: () => {
      if (host.isDestroyed() || !host.canRestoreNow()) {
        return;
      }
      if (pendingRestore === null) {
        pendingRestore = lastProgress ?? loadReadingProgress(host.storage, progressId);
      }
      if (pendingRestore === null) {
        return;
      }
      restoreAttempts = 0;
      cancelRestoreRetry();
      applyPendingWithRetry();
    },
    applyPending,
    applyPendingWithRetry,
    retryPending: () => {
      if (pendingRestore === null) {
        return;
      }
      restoreAttempts = 0;
      cancelRestoreRetry();
      applyPendingWithRetry();
    },
    scheduleRestoreRetry,
    cancelRestoreRetry,
    discardPending: () => {
      pendingRestore = null;
      cancelRestoreRetry();
    },
    stage: (saved) => {
      pendingRestore = saved;
      restoreAttempts = 0;
    },
    captureForRelayout: () => pendingRestore ?? lastProgress ?? snapshot(),
    persistSnapshot: (saved) => {
      if (saved !== null && progressId !== '') {
        // 直写保留调用方 updatedAt，但会话字段（时长/读完）不能在此丢失。
        const merged = withSessionFields(saved, Date.now());
        saveReadingProgress(host.storage, progressId, { ...merged, updatedAt: saved.updatedAt });
      }
    },
    dispose: () => {
      persist();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      cancelRestoreRetry();
    },
  };
}
