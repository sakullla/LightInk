/**
 * 漫画换屏：showPagedSpread（decode-gated swap + View Transition push 翻页，
 * Android/拖拽回退 slot 滑入）。行为保留自拆分前 cbz.ts 的对应闭包；
 * R1 起翻页动效改读统一样式偏好（slide/curl→VT push + slot 滑入回退、
 * fade→slot 淡入、none→直切；auto 按 prefers-reduced-motion 解析）。
 */

import {
  comicSpreadStart,
  comicVisiblePages,
  isTouchPrimaryDocument,
} from '../comic-preferences.js';
import {
  effectiveReaderPageTurnEffect,
  type ReaderPageTurnEffect,
} from '../reader-prefs.js';
import { comicLayoutSpreadPrefs, type ComicSession } from './comic-session.js';
import { loadPage, syncComicPageLoading } from './comic-pages.js';
import { refreshCacheWindow } from './comic-cache.js';
import { applySlotFit } from './comic-layout.js';
import { commitZoomRaster, unpinZoomRaster } from './comic-zoom.js';
import { clearDragTurnDom, resetDragTurn } from './comic-drag-turn.js';
import { androidReaderRoot, updateToolbar } from './comic-chrome.js';

/** T2：触屏 paged 翻页进入 slot 的滑入时长（与文字书 slide 同曲线族）。 */
const COMIC_SLOT_SLIDE_MS = 200;

/** R1 fade 映射：进入 slot 的淡入时长（与文字书 fade keyframes 同档）。 */
const COMIC_SLOT_FADE_MS = 240;
/**
 * 翻页防闪屏（decode-gated swap）：相邻翻页时新页图片未解码就绪就先不换屏，
 * 旧页保持显示，待 loadPage（读档 + img.decode 预热位图）完成后一次性交换。
 * 超过此上限若仍未物化则不 applySwap，留在旧页（不对近黑占位换屏/滑入）。
 */
const COMIC_TURN_HOLD_MS = 300;

/**
 * View Transition push 翻页：浏览器先截住旧帧快照、提交 DOM、在合成器层对
 * 旧/新快照做滑动转场——旧页滑出与新页滑入同帧进行，全程不露底色。
 * 快照对象是 pagesRoot（CSS view-transition-name: lightink-comic-pages），
 * 方向由 html[data-comic-turn] 驱动。不支持的环境回退 slot 滑入。
 */
export interface ComicViewTransition {
  readonly finished: Promise<void>;
  skipTransition(): void;
}

type ComicViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ComicViewTransition;
};

/** T2：触屏 paged 翻页时进入 slot 的滑入 token（rtl 反转视觉来向）。 */
function comicSlotSlideToken(session: ComicSession, forward: boolean): 'next' | 'prev' {
  const fromRight = session.preferences.direction === 'rtl' ? !forward : forward;
  return fromRight ? 'next' : 'prev';
}

/** T2-A2（FB3）：per-slot 滑入清理 timer；同 slot 快速二次进入先清旧 timer。 */
const comicSlotSlideTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** 统一样式映射下 slot 动画类全集（换样式时先摘干净再重启）。 */
const COMIC_SLOT_MOTION_CLASSES = [
  'lightink-comic-slot-slide-next',
  'lightink-comic-slot-slide-prev',
  'lightink-comic-slot-fade',
] as const;

function slideEnteringComicSlots(
  session: ComicSession,
  entering: readonly number[],
  direction: 1 | -1,
): void {
  const token = comicSlotSlideToken(session, direction > 0);
  const className = `lightink-comic-slot-slide-${token}`;
  for (const index of entering) {
    const slot = session.slots[index];
    if (slot === undefined) continue;
    // 旧 timer 只捕获类名字符串、不跟踪 per-slot：同 slot 260ms 内二次进入
    // 会被旧 timer 中途移除新动画的类。先清旧 timer 再重启。
    const staleTimer = comicSlotSlideTimers.get(slot);
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    slot.classList.remove(...COMIC_SLOT_MOTION_CLASSES);
    void slot.offsetWidth; // 同向连翻时重启动画
    slot.classList.add(className);
    comicSlotSlideTimers.set(
      slot,
      setTimeout(() => {
        comicSlotSlideTimers.delete(slot);
        slot.classList.remove(className);
      }, COMIC_SLOT_SLIDE_MS + 60),
    );
  }
}

/** R1 fade 映射：进入 slot 播放淡入（跨端——VT push 是滑动语义，fade 不用它）。 */
function fadeEnteringComicSlots(session: ComicSession, entering: readonly number[]): void {
  const className = 'lightink-comic-slot-fade';
  for (const index of entering) {
    const slot = session.slots[index];
    if (slot === undefined) continue;
    const staleTimer = comicSlotSlideTimers.get(slot);
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    slot.classList.remove(...COMIC_SLOT_MOTION_CLASSES);
    void slot.offsetWidth; // 连翻时重启动画
    slot.classList.add(className);
    comicSlotSlideTimers.set(
      slot,
      setTimeout(() => {
        comicSlotSlideTimers.delete(slot);
        slot.classList.remove(className);
      }, COMIC_SLOT_FADE_MS + 60),
    );
  }
}

export function showPagedSpread(
  session: ComicSession,
  requestedIndex: number,
  direction: 1 | -1 | 0 = 0,
  source: 'turn' | 'drag' = 'turn',
): void {
  const { container, pagesRoot, slots } = session;
  const spreadPrefs = comicLayoutSpreadPrefs(session);
  const index = comicSpreadStart(
    requestedIndex,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  session.currentPage = index + 1;
  const shown = comicVisiblePages(
    index,
    session.images.length,
    spreadPrefs,
    session.landscapePages,
  );
  const shownSet = new Set(shown);
  const generation = ++session.spreadSwapGeneration;
  // 非拖动翻页先清拖动残留（在飞缓动/邻居槽/transform）；拖动提交路径
  // 保留被拖 frame，等 commit 内与 applySwap 同步原子清理。
  if (source !== 'drag') resetDragTurn(session);
  unpinZoomRaster(session); // 换屏在既有 transform 缩放语义下进行，落位后由 applySwap 重钉
  // 新页先进 visible 提升 loadPage 的解码优先级（urgent）；换屏在 commit。
  for (const next of shown) session.visible.add(next);
  updateToolbar(session);
  refreshCacheWindow(session, index);
  const applySwap = (): number[] => {
    if (session.destroyed || generation !== session.spreadSwapGeneration) return [];
    container.dataset.comicVisible = String(shown.length);
    for (const previous of [...session.visible]) {
      if (shownSet.has(previous)) continue;
      const slot = slots[previous];
      if (slot !== undefined) slot.hidden = true;
      session.visible.delete(previous);
    }
    const entering: number[] = [];
    for (const next of shown) {
      const slot = slots[next];
      if (slot === undefined) continue;
      if (slot.hidden) entering.push(next);
      slot.hidden = false;
      applySlotFit(session, next);
      syncComicPageLoading(session, next);
    }
    pagesRoot.scrollTop = 0;
    pagesRoot.scrollLeft = 0;
    commitZoomRaster(session); // 放大中的换屏落位后，新 spread 以布局尺寸承接放大
    return entering;
  };
  const commit = (): void => {
    if (session.destroyed || generation !== session.spreadSwapGeneration) return;
    if (source === 'drag') {
      // 拖动提交：清拖动 DOM 与 transform，与 applySwap 同一同步块落位，
      // 邻居槽从绝对定位回到常规流时无中间帧。
      clearDragTurnDom(session);
    }
    const media =
      typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined;
    // R1 统一样式映射：slide/curl → 既有 VT push 转场 + slot 滑入回退
    // （curl 不为漫画单独仿真，视觉按滑入呈现）；fade → slot 淡入变体
    // （跨端）；none → 直切（VT 不启动等价 skipTransition）。auto 未显式
    // 选择时 reduce-motion 解析为 none；显式选择覆盖系统设置。
    const effect: ReaderPageTurnEffect = effectiveReaderPageTurnEffect(media ?? undefined);
    const doc = container.ownerDocument as ComicViewTransitionDocument;
    // Android WebView 的 View Transition 快照常带黑底，旧页滑开就是闪屏。
    // data-android 或 data-touch-primary 都跳过 VT，改走 slot 滑入
    // （合成器 transform，不截 canvas），避免漏盖 data-android 时仍截黑快照。
    const skipViewTransition =
      androidReaderRoot(doc.documentElement) !== null ||
      isTouchPrimaryDocument(doc);
    // 首选 View Transition push 转场：旧帧快照滑出、新帧滑入同帧合成，
    // 中途不露底色。跳转（direction 0）、fade/none、触屏/Android 与拖动
    // 提交（跟手已有实时帧，快照重截旧帧反而跳变）直切。
    if (
      source !== 'drag' &&
      direction !== 0 &&
      (effect === 'slide' || effect === 'curl') &&
      !skipViewTransition &&
      typeof doc.startViewTransition === 'function'
    ) {
      try {
        session.activeTurnTransition?.skipTransition();
        doc.documentElement.dataset.comicTurn = comicSlotSlideToken(session, direction > 0);
        const transition = doc.startViewTransition(() => {
          applySwap();
        });
        session.activeTurnTransition = transition;
        void transition.finished
          .catch(() => undefined)
          .then(() => {
            if (session.activeTurnTransition !== transition) return;
            session.activeTurnTransition = null;
            delete doc.documentElement.dataset.comicTurn;
          });
        return;
      } catch {
        // 快照失败（文档隐藏等罕见态）：退回直切 + slot 滑入。
      }
    }
    const entering = applySwap();
    // T2 回退路径：进入 slot 播放动画。fade 为跨端淡入；slide/curl 仅触屏
    // 滑入（桌面由 VT push 承担）。strip、跳转（direction 0）、拖动提交
    // （跟手→缓动→落位已是一段连续运动）与生效样式 none 不播。
    // 只对已物化进入槽播动效，避免近黑 loading 占位滑入成闪屏。
    const motionEntering = entering.filter((index) => session.materialized.has(index));
    if (motionEntering.length > 0 && direction !== 0 && source !== 'drag' && effect !== 'none') {
      if (effect === 'fade') {
        fadeEnteringComicSlots(session, motionEntering);
      } else if (isTouchPrimaryDocument(container.ownerDocument)) {
        slideEnteringComicSlots(session, motionEntering, direction);
      }
    }
  };
  // decode-gated swap：相邻翻页（±1）且新页图片未就绪时旧页保持在屏，
  // 待解码完成后一次性换屏。跳转（direction 0）仍硬落位——远跳的旧页
  // 多已被缓存窗口释放，等待无意义。超时若仍未物化则不 applySwap。
  const awaited =
    direction === 0
      ? []
      : shown.filter(
          (next) =>
            session.images[next]?.kind === 'image' &&
            !session.materialized.has(next) &&
            !session.failed.has(next),
        );
  if (awaited.length === 0) {
    commit();
    return;
  }
  const holdDeadline = new Promise<void>((resolve) => {
    setTimeout(resolve, COMIC_TURN_HOLD_MS);
  });
  const loadAll = Promise.all(
    awaited.map((next) => loadPage(session, next).catch(() => undefined)),
  );
  let swapped = false;
  const finish = (): void => {
    if (swapped || session.destroyed || generation !== session.spreadSwapGeneration) return;
    const ready = awaited.every(
      (next) => session.materialized.has(next) || session.failed.has(next),
    );
    if (!ready) return;
    swapped = true;
    commit();
  };
  void loadAll.then(finish);
  void holdDeadline.then(finish);
}
