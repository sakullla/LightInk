/**
 * 漫画阅读器会话状态袋与跨模块共享的纯助手。
 *
 * cbz.ts 装配入口为每次 renderCbzInto 创建一个 ComicSession；comic/ 各职责
 * 模块（pages/cache/layout/zoom/turn/drag-turn/gestures/chrome）的函数均以
 * session 为第一参数操作同一份状态，语义与拆分前 cbz.ts 的闭包共享变量一致。
 */

import {
  isReaderLoadCancelled,
  ReaderLoadCancelledError,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import {
  resolveComicSpread,
  type ComicPreferenceStorage,
  type ComicPreferences,
  type ComicSpreadPreferences,
} from '../comic-preferences.js';
import type { ComicCropInsets, ComicMetadata } from '../comic-model.js';
import type { rafFrameScheduler } from '../../ui/reading-layout.js';
import type { ArchiveEntryMetadata, ArchiveProvider } from '../sources/types.js';
import type { CbzRenderOptions, ComicToolbarLabels } from '../formats/cbz.js';
import type { ComicZoomRasterPin } from './comic-zoom.js';
import type { ComicViewTransition } from './comic-turn.js';
import type { DragTurnEase, DragTurnState } from './comic-drag-turn.js';

const COMIC_INTERACTIVE_SELECTOR =
  '.lightink-reader-comic-error, input, button, a';

export type ComicArchiveEntry = ArchiveEntryMetadata & {
  readonly id: string;
  readonly filename: string;
};

export interface ComicPageEntryBase {
  readonly provider: ArchiveProvider;
  readonly entry: ComicArchiveEntry;
  readonly virtualPath: string;
}

export interface ComicImagePageEntry extends ComicPageEntryBase {
  readonly kind: 'image';
}

export interface ComicNestedArchiveEntry extends ComicPageEntryBase {
  readonly kind: 'archive';
}

export type ComicPageEntry = ComicImagePageEntry | ComicNestedArchiveEntry;

export interface CollectedComicPages {
  readonly pages: ComicPageEntry[];
  readonly metadata: ComicMetadata | null;
  readonly coverEntryId?: string;
}

export interface ComicMaterializedPage {
  readonly image: HTMLElement;
  readonly url: string;
  readonly decodedBytes: number;
}

export interface ComicPendingPage {
  readonly promise: Promise<void>;
  readonly controller: AbortController;
}

export interface ComicAbortableLimiter {
  acquire: (signal: AbortSignal) => Promise<void>;
  release: () => void;
}

/**
 * 一次 renderCbzInto 的全部可变状态（拆分前 cbz.ts 闭包变量的逐项落位）。
 * 基本类型字段会被各模块原地读写；数组/Map/Set 字段以同一引用跨模块共享。
 */
export interface ComicSession {
  readonly signal: AbortSignal | undefined;
  readonly options: CbzRenderOptions;
  readonly labels: ComicToolbarLabels;
  readonly storage: ComicPreferenceStorage | null;
  readonly cacheBudget: number;
  readonly archive: ArchiveProvider;
  readonly openedProviders: Set<ArchiveProvider>;
  readonly unsubscribeProgress: Array<() => void>;
  readonly collected: CollectedComicPages;
  readonly collectPages: (
    provider: ArchiveProvider,
    signal?: AbortSignal,
    prefix?: string,
  ) => Promise<CollectedComicPages>;
  /** 装配注入的整页前进/后退（scrollToIndex 入口），供手势与 chrome 使用。 */
  readonly advancePage: (direction: 1 | -1) => boolean;

  readonly container: HTMLElement;
  readonly chrome: HTMLElement;
  readonly topbar: HTMLElement;
  readonly pageButton: HTMLButtonElement;
  /** T4（ADR-5）：顶栏书签开关（状态同步在 comic-chrome）。 */
  readonly bookmarkButton: HTMLButtonElement;
  readonly pagesRoot: HTMLElement;
  readonly scroller: HTMLElement;
  readonly previousButton: HTMLButtonElement;
  readonly nextButton: HTMLButtonElement;
  readonly pageSlider: HTMLInputElement;
  readonly verticalButton: HTMLButtonElement;
  readonly pagedButton: HTMLButtonElement;
  readonly ltrButton: HTMLButtonElement;
  readonly rtlButton: HTMLButtonElement;
  readonly singleButton: HTMLButtonElement;
  readonly doubleButton: HTMLButtonElement;
  readonly autoButton: HTMLButtonElement;
  readonly offsetButton: HTMLButtonElement;
  readonly fitButton: HTMLButtonElement;
  readonly cropButton: HTMLButtonElement;
  readonly spreadGroup: HTMLElement;

  readonly images: ComicPageEntry[];
  metadata: ComicMetadata;
  preferences: ComicPreferences;
  readonly slots: HTMLDivElement[];
  currentPage: number;

  readonly materialized: Map<number, ComicMaterializedPage>;
  readonly pending: Map<number, ComicPendingPage>;
  readonly failed: Set<number>;
  readonly sequentialQueues: Map<ArchiveProvider, Promise<void>>;
  readonly randomReads: ComicAbortableLimiter;
  readonly prefetchDecodes: ComicAbortableLimiter;
  readonly visible: Set<number>;
  readonly estimatedBytes: number[];
  readonly naturalWidths: Map<number, number>;
  readonly naturalHeights: Map<number, number>;
  readonly landscapePages: Set<number>;
  readonly cropInsets: Map<number, ComicCropInsets>;
  wantedPages: Set<number>;
  prefetchNeighbors: boolean;

  /** decode-gated swap 的世代号：新翻页/重排版让挂起的旧换屏作废。 */
  spreadSwapGeneration: number;
  /** 进行中的翻页 View Transition；新翻页先跳过旧转场避免叠帧。 */
  activeTurnTransition: ComicViewTransition | null;
  viewScale: number;
  viewX: number;
  viewY: number;
  zoomRasterPins: ComicZoomRasterPin[];
  zoomRasterContentRange: { width: number; height: number } | null;
  zoomRasterTimer: ReturnType<typeof setTimeout> | null;

  destroyed: boolean;
  destruction: Promise<void> | null;
  observer: IntersectionObserver | null;

  readonly cropQueue: number[];
  cropPumping: boolean;
  cropGeneration: number;

  dragTurn: DragTurnState | null;
  readonly dragTurnFrames: ReturnType<typeof rafFrameScheduler>;
  dragTurnFramePending: boolean;
  dragTurnFrameHandle: number | null;
  dragTurnPendingDx: number;
  dragTurnEase: DragTurnEase | null;

  chromeVisible: boolean;
  chromeTimer: ReturnType<typeof setTimeout> | null;

  readonly activePointers: Map<number, { x: number; y: number }>;
  pinchDistance: number;
  pinchScale: number;
  panOrigin: { x: number; y: number; viewX: number; viewY: number } | null;
  swipeOrigin: { x: number; y: number } | null;
  gestureMoved: boolean;
  lastGestureUp: { x: number; y: number } | null;
  lastPointerType: string;
  pendingTap: ReturnType<typeof setTimeout> | null;
  lastTap: { x: number; y: number; at: number } | null;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true || isReaderLoadCancelled(error, signal)) return true;
  return (
    (error instanceof DOMException || error instanceof Error) &&
    (error.name === 'AbortError' || error.name === 'ReaderLoadCancelledError')
  );
}

/** Bound in-flight work without leaving aborted waiters at the head of the queue. */
export function createAbortableLimiter(limit: number): ComicAbortableLimiter {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async acquire(signal: AbortSignal): Promise<void> {
      throwIfReaderLoadCancelled(signal);
      while (active >= limit) {
        await new Promise<void>((resolve, reject) => {
          const resume = (): void => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = (): void => {
            const at = waiters.indexOf(resume);
            if (at >= 0) waiters.splice(at, 1);
            reject(new ReaderLoadCancelledError());
          };
          waiters.push(resume);
          signal.addEventListener('abort', onAbort, { once: true });
        });
        throwIfReaderLoadCancelled(signal);
      }
      active += 1;
    },
    release(): void {
      active = Math.max(0, active - 1);
      waiters.shift()?.();
    },
  };
}

export function comicViewportSize(session: ComicSession): {
  width: number;
  height: number;
} {
  const rect = session.container.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

export function comicLayoutSpreadPrefs(session: ComicSession): ComicSpreadPreferences {
  return {
    mode: session.preferences.mode,
    spread: resolveComicSpread(session.preferences.spread, comicViewportSize(session)),
    // 偏移开启 = 封面不独占，双页配对从第一页起平移一页。
    coverAlone: session.preferences.spreadOffset !== true,
  };
}

export function comicPointerDistance(
  left: { readonly x: number; readonly y: number },
  right: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

const COMIC_SWIPE_SLOP = 40;

/** Qualified horizontal swipe: distance and axis, before reading-direction mapping. */
export function isComicSwipeTurn(dx: number, dy: number): boolean {
  return Math.abs(dx) >= COMIC_SWIPE_SLOP && Math.abs(dx) > Math.abs(dy);
}

export function comicSwipePageDirection(
  dx: number,
  dy: number,
  direction: ComicPreferences['direction'],
): 1 | -1 | null {
  if (!isComicSwipeTurn(dx, dy)) return null;
  const forward = direction === 'rtl' ? dx > 0 : dx < 0;
  return forward ? 1 : -1;
}

export function isComicInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMIC_INTERACTIVE_SELECTOR) !== null;
}

export function cancelPendingTap(session: ComicSession): void {
  if (session.pendingTap === null) return;
  clearTimeout(session.pendingTap);
  session.pendingTap = null;
}
