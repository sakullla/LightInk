/**
 * 漫画手势与滚动接线：指针/捏合/三区点按/双击缩放/滚轮、strip 滚动同步
 * （scroll 合并 + IntersectionObserver）与窗口尺寸变化重排。
 * 行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import {
  createCoalescedScrollHandler,
  createPagedWheelGate,
  nearestVisibleSlot,
  rafFrameScheduler,
  scrollerHasRoomInDelta,
} from '../../ui/reading-layout.js';
import {
  cancelPendingTap,
  comicPointerDistance,
  comicSwipePageDirection,
  isComicInteractiveTarget,
  isComicSwipeTurn,
  type ComicSession,
} from './comic-session.js';
import {
  revealChrome,
  scheduleChromeHide,
  setChromeVisible,
  updateToolbar,
} from './comic-chrome.js';
import { refreshCacheWindow } from './comic-cache.js';
import { applyLayout } from './comic-layout.js';
import {
  applyViewTransform,
  commitZoomRaster,
  scheduleZoomRasterCommit,
  toggleZoomAt,
  zoomAt,
} from './comic-zoom.js';
import {
  enterDragTurn,
  finishDragTurn,
  pushDragTurnSample,
  resetDragTurn,
  scheduleDragTurnFrame,
} from './comic-drag-turn.js';

const COMIC_DOUBLE_TAP_MS = 280;
const COMIC_PAN_SLOP = 8;
const COMIC_EDGE_ZONE = 0.28;
const COMIC_SYSTEM_EDGE_PX = 24;

/** createComicGestureHandlers 返回的全部监听器引用，供 destroy 对称摘除。 */
export interface ComicGestureHandlers {
  readonly onSurfaceClick: (event: MouseEvent) => void;
  readonly onDoubleClick: (event: MouseEvent) => void;
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onGesturePointerMove: (event: PointerEvent) => void;
  readonly onHoverPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly blockNativeSelect: (event: Event) => void;
  readonly stopChromeBubble: (event: Event) => void;
  readonly onWheel: (event: WheelEvent) => void;
  readonly onScrollEvent: () => void;
  readonly onViewportChange: () => void;
  readonly scrollCoordinator: ReturnType<typeof createCoalescedScrollHandler> | null;
}

function setPanning(session: ComicSession, panning: boolean): void {
  if (panning) session.container.dataset.comicPanning = 'true';
  else delete session.container.dataset.comicPanning;
}

function handleSurfaceTap(session: ComicSession, clientX: number): void {
  const { container } = session;
  container.focus({ preventScroll: true });
  const rect = container.getBoundingClientRect();
  if (rect.width < 8) {
    setChromeVisible(session, !session.chromeVisible);
    return;
  }
  if (session.viewScale > 1) {
    setChromeVisible(session, !session.chromeVisible);
    if (session.chromeVisible) scheduleChromeHide(session);
    return;
  }
  const x = clientX - rect.left;
  if (
    session.lastPointerType === 'touch' &&
    (x < COMIC_SYSTEM_EDGE_PX || rect.width - x < COMIC_SYSTEM_EDGE_PX)
  ) {
    setChromeVisible(session, !session.chromeVisible);
    if (session.chromeVisible) scheduleChromeHide(session);
    return;
  }
  const ratio = x / rect.width;
  const backward =
    session.preferences.direction === 'rtl'
      ? ratio > 1 - COMIC_EDGE_ZONE
      : ratio < COMIC_EDGE_ZONE;
  const forward =
    session.preferences.direction === 'rtl'
      ? ratio < COMIC_EDGE_ZONE
      : ratio > 1 - COMIC_EDGE_ZONE;
  if (backward) session.advancePage(-1);
  else if (forward) session.advancePage(1);
  else setChromeVisible(session, !session.chromeVisible);
  if (session.chromeVisible) scheduleChromeHide(session);
}

function viewportPageIndex(session: ComicSession, fallback: number): number {
  const { slots, scroller } = session;
  const candidates =
    session.visible.size > 0
      ? [...session.visible].filter((index) => index >= 0 && index < slots.length)
      : [fallback, fallback - 1, fallback + 1].filter(
          (index) => index >= 0 && index < slots.length,
        );
  if (candidates.length === 0) return fallback;
  if (candidates.length === 1) return candidates[0]!;
  const top = scroller.getBoundingClientRect().top;
  const slotTops = candidates.map((index) => slots[index]!.getBoundingClientRect().top);
  if (new Set(slotTops).size > 1) {
    const nearest = nearestVisibleSlot(slotTops, top);
    return nearest >= 0 ? candidates[nearest]! : fallback;
  }
  return Math.min(...candidates);
}

/** strip 滚动/可见性变化时的当前页同步（scroll 合并与 observer 共用）。 */
function syncCurrentPage(session: ComicSession): void {
  if (session.preferences.mode === 'paged') return;
  const closest = viewportPageIndex(session, session.currentPage - 1);
  const changed = session.currentPage !== closest + 1;
  session.currentPage = closest + 1;
  updateToolbar(session);
  refreshCacheWindow(session, closest);
  if (changed) session.options.onPageChange?.();
}

export function createComicGestureHandlers(session: ComicSession): ComicGestureHandlers {
  const { container, chrome, pagesRoot } = session;

  const onSurfaceClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    if (isComicInteractiveTarget(event.target)) return;
    if (session.lastGestureUp !== null) {
      const nearGesture =
        comicPointerDistance(session.lastGestureUp, {
          x: event.clientX,
          y: event.clientY,
        }) <= 40;
      session.lastGestureUp = null;
      if (nearGesture) return;
    }
    if (event.detail >= 2) return;
    if (event.isTrusted && session.lastPointerType === 'touch') {
      cancelPendingTap(session);
      const { clientX } = event;
      session.pendingTap = setTimeout(() => {
        session.pendingTap = null;
        if (!session.destroyed) handleSurfaceTap(session, clientX);
      }, COMIC_DOUBLE_TAP_MS);
      return;
    }
    handleSurfaceTap(session, event.clientX);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (isComicInteractiveTarget(event.target)) return;
    event.preventDefault();
    cancelPendingTap(session);
    session.lastGestureUp = null;
    toggleZoomAt(session, event.clientX, event.clientY);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (isComicInteractiveTarget(event.target)) return;
    session.lastPointerType = event.pointerType || session.lastPointerType;
    session.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    session.gestureMoved = false;
    if (session.activePointers.size === 2) {
      cancelPendingTap(session);
      resetDragTurn(session); // 第二指落下：拖动让位 pinch，残留/在飞缓动立即清理
      session.lastGestureUp = { x: event.clientX, y: event.clientY };
      const points = [...session.activePointers.values()];
      session.pinchDistance = comicPointerDistance(points[0]!, points[1]!);
      session.pinchScale = session.viewScale;
      session.panOrigin = null;
      session.swipeOrigin = null;
      return;
    }
    if (session.viewScale > 1) {
      session.panOrigin = {
        x: event.clientX,
        y: event.clientY,
        viewX: session.viewX,
        viewY: session.viewY,
      };
      container.setPointerCapture?.(event.pointerId);
    } else if (session.preferences.mode === 'paged' && event.pointerType !== 'mouse') {
      // Mouse/trackpad clicks stay on the click-zone path. Capturing a Mac
      // trackpad as a swipe swallows the click that would page or show chrome.
      session.swipeOrigin = { x: event.clientX, y: event.clientY };
      container.setPointerCapture?.(event.pointerId);
    }
  };

  const onGesturePointerMove = (event: PointerEvent): void => {
    const tracked = session.activePointers.get(event.pointerId);
    if (tracked === undefined) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;
    if (session.activePointers.size >= 2) {
      const points = [...session.activePointers.values()];
      const distance = comicPointerDistance(points[0]!, points[1]!);
      if (session.pinchDistance > 0 && distance > 0) {
        const midX = (points[0]!.x + points[1]!.x) / 2;
        const midY = (points[0]!.y + points[1]!.y) / 2;
        zoomAt(session, midX, midY, session.pinchScale * (distance / session.pinchDistance));
        session.gestureMoved = true;
        session.lastGestureUp = { x: event.clientX, y: event.clientY };
        event.preventDefault();
      }
      return;
    }
    if (session.panOrigin !== null && session.viewScale > 1) {
      const dx = event.clientX - session.panOrigin.x;
      const dy = event.clientY - session.panOrigin.y;
      if (Math.hypot(dx, dy) >= COMIC_PAN_SLOP) {
        session.gestureMoved = true;
        setPanning(session, true);
      }
      session.viewX = session.panOrigin.viewX + dx;
      session.viewY = session.panOrigin.viewY + dy;
      applyViewTransform(session);
      event.preventDefault();
      return;
    }
    if (
      session.swipeOrigin !== null &&
      session.viewScale <= 1 &&
      session.preferences.mode === 'paged'
    ) {
      const dx = event.clientX - session.swipeOrigin.x;
      const dy = event.clientY - session.swipeOrigin.y;
      if (session.dragTurn !== null) {
        if (!session.dragTurn.released && event.pointerId === session.dragTurn.pointerId) {
          // 拖动态：跟手 transform 经 rAF 合并写入（帧内最新值胜出）。
          session.gestureMoved = true;
          session.lastGestureUp = { x: event.clientX, y: event.clientY };
          session.dragTurn.lastDx = dx;
          pushDragTurnSample(session.dragTurn, dx);
          scheduleDragTurnFrame(session, dx);
          event.preventDefault();
        } else if (session.dragTurn.released && isComicSwipeTurn(dx, dy)) {
          // 上一松手的缓动仍在飞：新手势过 slop 即重进入，最新手势胜出。
          session.gestureMoved = true;
          session.lastGestureUp = { x: event.clientX, y: event.clientY };
          event.preventDefault();
          enterDragTurn(session, event.pointerId, dx, dy);
        }
        return;
      }
      if (isComicSwipeTurn(dx, dy)) {
        session.gestureMoved = true;
        session.lastGestureUp = { x: event.clientX, y: event.clientY };
        event.preventDefault();
        enterDragTurn(session, event.pointerId, dx, dy);
      }
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!session.activePointers.has(event.pointerId)) return;
    const wasPinchPair = session.activePointers.size >= 2;
    session.activePointers.delete(event.pointerId);
    if (wasPinchPair && session.activePointers.size < 2) {
      commitZoomRaster(session); // 捏合 settle：逐帧 transform 路径到此为止，提交重栅格
    }
    if (session.activePointers.size < 2) {
      session.pinchDistance = 0;
      session.pinchScale = session.viewScale;
    }
    if (session.activePointers.size === 0) {
      const swipeStart = session.swipeOrigin;
      session.panOrigin = null;
      session.swipeOrigin = null;
      setPanning(session, false);
      if (
        session.gestureMoved &&
        swipeStart !== null &&
        session.viewScale <= 1 &&
        session.preferences.mode === 'paged'
      ) {
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        session.lastGestureUp = { x: event.clientX, y: event.clientY };
        session.lastTap = null;
        if (session.dragTurn !== null) {
          // 拖动跟手后的松手：位移+速度双阈值判定（pointercancel 只清理）。
          session.dragTurn.lastDx = dx;
          pushDragTurnSample(session.dragTurn, dx);
          finishDragTurn(session, event.type === 'pointercancel');
        } else {
          const swipeDirection = comicSwipePageDirection(
            dx,
            dy,
            session.preferences.direction,
          );
          if (swipeDirection !== null) {
            session.advancePage(swipeDirection);
          }
        }
      } else if (event.type === 'pointercancel' && session.dragTurn !== null) {
        // 孤儿 pointercancel（如拖动指被系统打断且基线已被清）：只清理不翻页；
        // 松手后的提交缓动在飞（released）时，无关新指（如手掌误触）的
        // pointercancel 不得作废已提交的翻页。
        if (!session.dragTurn.released) resetDragTurn(session);
      } else if (session.gestureMoved) {
        session.lastGestureUp = { x: event.clientX, y: event.clientY };
        session.lastTap = null;
      } else if (event.pointerType === 'touch') {
        const now = performance.now();
        const previous = session.lastTap;
        session.lastTap = { x: event.clientX, y: event.clientY, at: now };
        if (
          previous !== null &&
          now - previous.at <= COMIC_DOUBLE_TAP_MS &&
          comicPointerDistance(previous, session.lastTap) <= 36
        ) {
          cancelPendingTap(session);
          session.lastGestureUp = { x: event.clientX, y: event.clientY };
          session.lastTap = null;
          toggleZoomAt(session, event.clientX, event.clientY);
        }
      }
    }
    if (container.hasPointerCapture?.(event.pointerId) === true) {
      container.releasePointerCapture(event.pointerId);
    }
  };

  const onHoverPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const target = event.target;
    if (target instanceof Element && chrome.contains(target)) {
      revealChrome(session);
      return;
    }
    const rect = container.getBoundingClientRect();
    if (rect.height < 8) return;
    const y = event.clientY - rect.top;
    if (y <= 72 || y >= rect.height - 96) revealChrome(session);
  };

  const stopChromeBubble = (event: Event): void => event.stopPropagation();
  const blockNativeSelect = (event: Event): void => {
    event.preventDefault();
  };

  const gatePagedWheel = createPagedWheelGate();
  const onWheel = (event: WheelEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select') !== null
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      resetDragTurn(session); // 轨道板捏合让位缩放，同触屏第二指互斥
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(session, event.clientX, event.clientY, session.viewScale * factor);
      scheduleZoomRasterCommit(session); // 连发轮缩放停顿后一次布局级重栅格
      return;
    }
    if (session.viewScale > 1) {
      event.preventDefault();
      event.stopPropagation();
      session.viewX -= event.deltaX;
      session.viewY -= event.deltaY;
      applyViewTransform(session);
      return;
    }
    if (session.preferences.mode !== 'paged') {
      return;
    }
    const delta =
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) {
      return;
    }
    if (
      session.preferences.fit !== 'screen' &&
      scrollerHasRoomInDelta(pagesRoot, event.deltaX, event.deltaY)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (gatePagedWheel(delta > 0 ? 1 : -1, (direction) => session.advancePage(direction))) {
      scheduleChromeHide(session);
    }
  };

  const scrollFrames = rafFrameScheduler();
  const scrollCoordinator =
    scrollFrames === null
      ? null
      : createCoalescedScrollHandler(() => syncCurrentPage(session), scrollFrames);
  const onScrollEvent = (): void => {
    if (scrollCoordinator === null) syncCurrentPage(session);
    else scrollCoordinator.schedule();
  };

  const onViewportChange = (): void => {
    if (session.destroyed) return;
    applyLayout(session, false);
  };

  return {
    onSurfaceClick,
    onDoubleClick,
    onPointerDown,
    onGesturePointerMove,
    onHoverPointerMove,
    onPointerUp,
    blockNativeSelect,
    stopChromeBubble,
    onWheel,
    onScrollEvent,
    onViewportChange,
    scrollCoordinator,
  };
}

/** strip 模式的可见性跟踪：IntersectionObserver 驱动 visible 与当前页同步。 */
export function observeComicStripSlots(session: ComicSession): void {
  if (typeof IntersectionObserver === 'undefined') return;
  session.observer = new IntersectionObserver(
    (entries) => {
      if (session.preferences.mode === 'paged') return;
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.pageIndex);
        if (entry.isIntersecting) session.visible.add(index);
        else session.visible.delete(index);
      }
      syncCurrentPage(session);
    },
    { root: session.scroller, rootMargin: '0px 0px 40% 0px' },
  );
  session.slots.forEach((slot) => session.observer?.observe(slot));
}
