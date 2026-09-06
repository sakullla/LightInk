/**
 * 漫画 drag-to-turn：触屏 paged viewScale=1 单指拖动过 slop 后的跟手状态、
 * rAF 合并跟踪、松手位移+速度判定与接续/回弹缓动。
 * 行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import {
  advanceComicPage,
  comicSpreadStart,
  comicVisiblePages,
} from '../comic-preferences.js';
import {
  cancelPendingTap,
  comicLayoutSpreadPrefs,
  comicSwipePageDirection,
  isAbortError,
  type ComicSession,
} from './comic-session.js';
import { loadPage, showPageError, syncComicPageLoading } from './comic-pages.js';
import { applySlotFit } from './comic-layout.js';
import { applyViewTransform } from './comic-zoom.js';
import { showPagedSpread } from './comic-turn.js';

/**
 * T1 drag-to-turn 松手判定（settlePagedRelease 同族数学）：位移过
 * min(48px, 视口宽×0.22) 或速度过阈（px/ms，短促轻扫）即翻页，否则回弹。
 */
const COMIC_DRAG_COMMIT_PX = 48;
const COMIC_DRAG_COMMIT_RATIO = 0.22;
const COMIC_DRAG_FLICK_VELOCITY = 0.5;
/** 松手接续/回弹缓动时长（与 slot 滑入 / writePagedScrollLeft 同曲线族）。 */
const COMIC_DRAG_SETTLE_MS = 200;
/** 速度采样窗口内保留的最近 pointermove 样本数。 */
const COMIC_DRAG_SAMPLE_LIMIT = 8;

/**
 * T1 drag-to-turn：触屏 paged viewScale=1 单指拖动过 slop 后的跟手状态。
 * 拖动开始即取消目标方向相邻 spread 的 [hidden]，按绝对定位布局为当前
 * spread 的横向邻居（pagesRoot 水平 transform 跟手）；松手按位移+速度
 * 判定翻页（rAF 缓动从当前偏移接续后走 showPagedSpread 提交）或回弹。
 * 第二指让位 pinch、pointercancel、destroy、重排版均对称清理。
 */
export interface DragTurnSample {
  readonly dx: number;
  readonly t: number;
}
export interface DragTurnState {
  readonly pointerId: number;
  readonly direction: 1 | -1;
  readonly targetIndex: number;
  /** 相邻 spread 在视觉上的落侧：+1 右 / -1 左（ltr 前翻在右，rtl 反之）。 */
  readonly sideSign: 1 | -1;
  readonly revealed: number[];
  lastDx: number;
  samples: DragTurnSample[];
  /** 松手后为 true：状态只剩在飞缓动，新手势过 slop 即重进入取代。 */
  released: boolean;
}

const dragTurnNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function writeDragTurnTransform(session: ComicSession, dx: number): void {
  session.pagesRoot.style.transform = `translate3d(${dx}px, 0, 0)`;
}

// —— rAF 合并跟踪（pdf-drag-pan pinch 模式）：帧内多次 move 只写最新值。
function cancelDragTurnFrame(session: ComicSession): void {
  session.dragTurnFramePending = false;
  if (session.dragTurnFrameHandle !== null && session.dragTurnFrames !== null) {
    session.dragTurnFrames.cancel(session.dragTurnFrameHandle);
  }
  session.dragTurnFrameHandle = null;
}
function flushDragTurnFrame(session: ComicSession): void {
  session.dragTurnFramePending = false;
  session.dragTurnFrameHandle = null;
  if (session.dragTurn === null) return;
  writeDragTurnTransform(session, session.dragTurnPendingDx);
}
export function scheduleDragTurnFrame(session: ComicSession, dx: number): void {
  session.dragTurnPendingDx = dx;
  if (session.dragTurnFramePending) return;
  if (session.dragTurnFrames === null) {
    writeDragTurnTransform(session, dx); // 无 rAF 环境退化为逐次写
    return;
  }
  session.dragTurnFramePending = true;
  session.dragTurnFrameHandle = session.dragTurnFrames.request(() =>
    flushDragTurnFrame(session),
  );
}

// —— 松手接续/回弹缓动（writePagedScrollLeft 同族 easeOutQuart）。
export interface DragTurnEase {
  cancelled: boolean;
  handle: number | null;
}

function cancelDragTurnEase(session: ComicSession): void {
  if (session.dragTurnEase === null) return;
  session.dragTurnEase.cancelled = true;
  if (session.dragTurnEase.handle !== null && session.dragTurnFrames !== null) {
    session.dragTurnFrames.cancel(session.dragTurnEase.handle);
  }
  session.dragTurnEase = null;
}

function startDragTurnEase(
  session: ComicSession,
  from: number,
  to: number,
  done: () => void,
): void {
  cancelDragTurnEase(session);
  cancelDragTurnFrame(session);
  if (session.dragTurnFrames === null) {
    writeDragTurnTransform(session, to);
    done();
    return;
  }
  const startAt = dragTurnNow();
  const ease: DragTurnEase = { cancelled: false, handle: null };
  session.dragTurnEase = ease;
  const tick = (): void => {
    if (ease.cancelled || session.dragTurnEase !== ease) return;
    const elapsed = dragTurnNow() - startAt;
    const ratio = Math.min(1, Math.max(0, elapsed / COMIC_DRAG_SETTLE_MS));
    const progress = 1 - Math.pow(1 - ratio, 4);
    writeDragTurnTransform(session, from + (to - from) * progress);
    if (ratio >= 1) {
      session.dragTurnEase = null;
      done();
      return;
    }
    ease.handle = session.dragTurnFrames!.request(tick);
  };
  ease.handle = session.dragTurnFrames.request(tick);
}

export function pushDragTurnSample(state: DragTurnState, dx: number): void {
  state.samples.push({ dx, t: dragTurnNow() });
  if (state.samples.length > COMIC_DRAG_SAMPLE_LIMIT) {
    state.samples.splice(0, state.samples.length - COMIC_DRAG_SAMPLE_LIMIT);
  }
}

function dragTurnVelocityPxPerMs(samples: readonly DragTurnSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.dx - first.dx) / dt;
}

/** 摘除拖动期邻居槽的内联几何与标记；rehide 时按 visible 语义恢复 [hidden]。 */
function stripDragTurnSlots(session: ComicSession, rehide: boolean): void {
  const state = session.dragTurn;
  if (state === null) return;
  for (const index of state.revealed) {
    const slot = session.slots[index];
    if (slot === undefined) continue;
    slot.classList.remove('lightink-comic-drag-neighbor');
    slot.style.removeProperty('position');
    slot.style.removeProperty('top');
    slot.style.removeProperty('left');
    slot.style.removeProperty('width');
    slot.style.removeProperty('height');
    if (rehide && !session.visible.has(index)) slot.hidden = true;
  }
}

/**
 * R2（ADR-3）：拖动 urgent 曾把目标 spread 并入 visible（loadPage 解码
 * 优先级 + fetchPriority high）。手势未提交结束（回弹/作废/让位/重排版）
 * 时退出，恢复 [hidden] 与缓存窗口回收语义；提交路径不经此处——目标
 * spread 已成为新当前页，由 applySwap 权威收敛 visible。
 * A2（P1）：提交后 dragTurn 存活到 decode-hold 竞速结束（commit 内才
 * clearDragTurnDom），此窗口内的 reset（快速重拖、第二指让位 pinch）不得
 * 把已提交的当前 spread 移出 visible——否则 stripDragTurnSlots 将其回
 * 隐藏（回看旧页），且 enterDragTurn 收敛与 applySwap 都只遍历 visible，
 * 残留槽从此无人再隐藏，直到重排版。当前 spread 之外的页照旧退出。
 * 目标 spread 与提交前当前 spread 不相交（advanceComicPage 按整 spread
 * 前进），正常路径删除不会误伤当前页的 visible 语义。
 */
function releaseDragTurnUrgentPages(session: ComicSession): void {
  const state = session.dragTurn;
  if (state === null) return;
  const keep = new Set(
    comicVisiblePages(
      comicSpreadStart(
        session.currentPage - 1,
        session.images.length,
        comicLayoutSpreadPrefs(session),
        session.landscapePages,
      ),
      session.images.length,
      comicLayoutSpreadPrefs(session),
      session.landscapePages,
    ),
  );
  for (const index of state.revealed) {
    if (keep.has(index)) continue;
    session.visible.delete(index);
  }
}

function restoreDragTurnSurface(session: ComicSession): void {
  delete session.container.dataset.comicDragTurn;
  session.pagesRoot.style.removeProperty('will-change');
  session.pagesRoot.style.removeProperty('position');
  applyViewTransform(session); // scale=1 分支移除拖动 transform 并恢复 overflow/touch-action
}

/**
 * 对称清理：取消在飞缓动/帧、恢复相邻 spread hidden、transform 归零。
 * cancelPendingSwipe=true 时同时作废挂起的 swipe 基线（重排版/destroy/
 * pinch 等外部作废），使残余 move/up 不再进入拖动或旧 swipe 路径；
 * 拖动重进入（enterDragTurn）传 false 保留当前手势基线。
 */
export function resetDragTurn(session: ComicSession, cancelPendingSwipe = true): void {
  cancelDragTurnEase(session);
  cancelDragTurnFrame(session);
  releaseDragTurnUrgentPages(session); // 先退出 urgent visible，邻居槽才能按语义回隐藏
  stripDragTurnSlots(session, true);
  session.dragTurn = null;
  if (cancelPendingSwipe) session.swipeOrigin = null;
  restoreDragTurnSurface(session);
}

/** 提交换屏前的清理：不回隐藏（applySwap 随后权威重写 hidden）。 */
export function clearDragTurnDom(session: ComicSession): void {
  cancelDragTurnEase(session);
  cancelDragTurnFrame(session);
  stripDragTurnSlots(session, false);
  session.dragTurn = null;
  restoreDragTurnSurface(session);
}

export function enterDragTurn(
  session: ComicSession,
  pointerId: number,
  dx: number,
  dy: number,
): void {
  resetDragTurn(session, false); // 作废在飞缓动与残留（快速连翻最新手势胜出）
  // A3（P3）：与 showPagedSpread 的新提交一致，接管时跳过仍在飞的非拖动
  // 翻页 View Transition——否则跟手 transform 写在旧快照之下，转场结束前
  // 不可见、结束后跳变。
  try {
    session.activeTurnTransition?.skipTransition();
  } catch {
    // 转场已结束时 skip 可能抛错，忽略。
  }
  if (session.viewScale > 1) return;
  const turnDirection = comicSwipePageDirection(dx, dy, session.preferences.direction);
  if (turnDirection === null) return;
  // 世代号作废必须与下面的视图收敛重写同生共死：任何作废挂起 decode-hold
  // 提交的路径都要执行收敛（对齐 applySwap 语义），否则 hold 已并入
  // visible 的 spread 残留未隐藏。防御性提前返回不触碰世代号，挂起提交
  // 仍可正常落位，故增量放在两个防御返回之后。
  session.spreadSwapGeneration += 1; // 新拖动手势取代上一翻页挂起的 decode-hold 提交
  const spreadPrefs = comicLayoutSpreadPrefs(session);
  const currentIndex = comicSpreadStart(
    session.currentPage - 1,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  // 上一翻页挂起的 decode-hold 提交已被本手势的世代号作废，其 applySwap
  // 不会再权威重写 hidden：这里先按当前 spread 收敛（对齐 applySwap 语义，
  // 含 tap 翻页 hold 期目标 spread 尚未 unhide 的情形），否则 hold 已并入
  // visible 的 spread 会残留未隐藏，与新邻居并排成多 spread 垃圾视图，
  // 在松手回弹或书籍边缘提前返回后持续存在。
  const keepPages = comicVisiblePages(
    currentIndex,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  const keepSet = new Set(keepPages);
  for (const index of [...session.visible]) {
    if (keepSet.has(index)) continue;
    const slot = session.slots[index];
    if (slot !== undefined) slot.hidden = true;
    session.visible.delete(index);
  }
  for (const index of keepPages) {
    const slot = session.slots[index];
    if (slot !== undefined) slot.hidden = false;
  }
  const targetIndex = advanceComicPage(
    currentIndex,
    session.images.length,
    turnDirection,
    spreadPrefs,
    session.landscapePages,
  );
  if (targetIndex === currentIndex) return; // 边缘无相邻 spread：不进入拖动态
  const neighborPages = comicVisiblePages(
    targetIndex,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  const sideSign: 1 | -1 =
    session.preferences.direction === 'rtl' ? (turnDirection > 0 ? -1 : 1) : turnDirection;
  const count = Math.max(1, neighborPages.length);
  const revealed: number[] = [];
  neighborPages.forEach((index, offset) => {
    const slot = session.slots[index];
    if (slot === undefined) return;
    applySlotFit(session, index); // 先落位 fit 样式，再写邻居几何覆盖
    slot.hidden = false;
    syncComicPageLoading(session, index); // 未物化邻居立即呈现加载指示
    slot.classList.add('lightink-comic-drag-neighbor');
    slot.style.position = 'absolute';
    slot.style.top = '0';
    slot.style.left = `${sideSign * 100 + (offset * 100) / count}%`;
    slot.style.width = `${100 / count}%`;
    slot.style.height = '100%';
    revealed.push(index);
  });
  if (revealed.length === 0) return;
  // web.dev / Readium 跟手转场：viewport（container）裁切，track（pagesRoot）
  // 做 transform。overflow:hidden 写在被平移的 track 上会在本地坐标裁掉
  // 邻居，只剩近黑画布跟着整页平移——手机左右滑就是半屏黑。
  session.container.dataset.comicDragTurn = 'true';
  session.pagesRoot.style.position = 'relative';
  session.pagesRoot.style.overflow = 'visible';
  session.pagesRoot.style.willChange = 'transform';
  cancelPendingTap(session); // 拖动期点按/双击不触发
  // R2（ADR-3）：方向确定即把目标 spread 并入 visible 并触发 urgent
  // 加载——urgent 在解码门按 visible 判定，绕过预取解码限流（并发 1）
  // 并给 fetchPriority high，读取+解码在跟手期被掩盖，不等松手。已在飞
  // （含预取先发起、尚未过解码门的页由此升级 urgent）/已物化/已失败的
  // 页由 loadPage 去重守卫跳过；嵌套归档未展开前其后页索引会重排，维持
  // 阻塞-after 语义不抢跑。手势反向（新手势取代）时 resetDragTurn 先让
  // 旧目标退出 visible，旧在飞加载交还正常缓存窗口裁决。
  const firstUnresolved = session.images.findIndex((page) => page.kind === 'archive');
  for (const index of revealed) {
    if (firstUnresolved >= 0 && index > firstUnresolved) continue;
    session.visible.add(index);
    // loadPage 读取完成后按 wantedPages 丢弃不在窗口的页：这里同步并入，
    // 拖动触发的加载立即有效，不依赖下一次缓存刷新。
    session.wantedPages.add(index);
    void loadPage(session, index).catch((error: unknown) => {
      if (!isAbortError(error, session.signal) && !session.destroyed) {
        showPageError(session, index);
      }
    });
  }
  const state: DragTurnState = {
    pointerId,
    direction: turnDirection,
    targetIndex,
    sideSign,
    revealed,
    lastDx: dx,
    samples: [],
    released: false,
  };
  pushDragTurnSample(state, dx);
  session.dragTurn = state;
  scheduleDragTurnFrame(session, dx);
}

/** 松手判定与接续：commit → 缓动滑到目标位后 showPagedSpread('drag') 提交。 */
export function finishDragTurn(session: ComicSession, cancelled: boolean): void {
  const state = session.dragTurn;
  if (state === null) return;
  state.released = true;
  if (cancelled) {
    resetDragTurn(session);
    return;
  }
  const width =
    session.pagesRoot.clientWidth || session.container.getBoundingClientRect().width;
  const commitPx = Math.min(
    COMIC_DRAG_COMMIT_PX,
    Math.max(1, width * COMIC_DRAG_COMMIT_RATIO),
  );
  const dx = state.lastDx;
  const velocity = dragTurnVelocityPxPerMs(state.samples);
  const revealSign = -state.sideSign; // 露出邻居的拖动方向（dx 符号）
  const dxSign = dx === 0 ? 0 : Math.sign(dx);
  const velocitySign = velocity === 0 ? 0 : Math.sign(velocity);
  const commit =
    (dxSign === revealSign && Math.abs(dx) >= commitPx) ||
    (velocitySign === revealSign && Math.abs(velocity) >= COMIC_DRAG_FLICK_VELOCITY);
  const settleTo = commit ? revealSign * Math.max(1, width) : 0;
  const targetIndex = state.targetIndex;
  const turnDirection = state.direction;
  startDragTurnEase(session, dx, settleTo, () => {
    if (commit && !session.destroyed) {
      // 拖动触发的提交不走 View Transition / slot 滑入：跟手已有实时帧。
      // A3（P1）：与 scrollToIndex 同契约——提交换页须在赋值前判定并回调
      // onPageChange，否则拖动翻页永不通知宿主（进度持久化与外层状态滞后）。
      const changed = session.currentPage !== targetIndex + 1;
      showPagedSpread(session, targetIndex, turnDirection, 'drag');
      if (changed) session.options.onPageChange?.();
      return;
    }
    resetDragTurn(session);
  });
}
