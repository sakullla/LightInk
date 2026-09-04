/**
 * Editor Markdown scroll vs paginated layout, plus shared column/spread math.
 *
 * This module owns only `lightink.reading.layout` (default scroll). Reader flow
 * layout and typography persist in their own keys and must not write this one.
 * Paginated mode follows Readium/Thorium: constrain height to the viewport and
 * fill CSS columns sequentially (column-fill: auto).
 */

export const READING_LAYOUT_STORAGE_KEY = 'lightink.reading.layout';

export type ReadingLayout = 'scroll' | 'paginated';

/** Comfortable measure used when a caller does not pass R4 row length. */
export const DEFAULT_READING_MEASURE_REM = 22;

export const DEFAULT_READING_LAYOUT: ReadingLayout = 'scroll';

export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReadingColumnLayoutOptions {
  minRem?: number;
  optRem?: number;
  maxColumns?: number;
  gapPx?: number;
}

export function parseReadingLayout(raw: string | null | undefined): ReadingLayout {
  return raw === 'paginated' ? 'paginated' : DEFAULT_READING_LAYOUT;
}

export function loadReadingLayout(storage: LayoutStorage | null | undefined): ReadingLayout {
  if (storage == null) {
    return DEFAULT_READING_LAYOUT;
  }
  try {
    return parseReadingLayout(storage.getItem(READING_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_READING_LAYOUT;
  }
}

export function saveReadingLayout(
  storage: LayoutStorage | null | undefined,
  layout: ReadingLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(READING_LAYOUT_STORAGE_KEY, layout);
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export interface ApplyReadingLayoutOptions {
  /** Apply even when the document host is owned by the reader workspace. */
  force?: boolean;
}

function isReaderOwnedDocumentRoot(root: { dataset: DOMStringMap }): boolean {
  if (root.dataset.workspaceMode !== 'reader') {
    return false;
  }
  return typeof document !== 'undefined' && root === document.documentElement;
}

export function applyReadingLayout(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  layout: ReadingLayout,
  options?: ApplyReadingLayoutOptions,
): void {
  if (options?.force !== true && isReaderOwnedDocumentRoot(root)) {
    return;
  }
  root.dataset.readingLayout = layout;
  root.classList.toggle('is-paginated', layout === 'paginated');
}

export function toggleReadingLayout(layout: ReadingLayout): ReadingLayout {
  return layout === 'paginated' ? 'scroll' : 'paginated';
}

/**
 * Paginated columns follow Readium/Thorium + WCAG 1.4.8:
 * open a second column only when each can hold a comfortable measure
 * (~32em CJK / ~55ch Latin). Never more than two facing pages.
 * `minRem` is the current reading measure so R4 row-length changes recompute columns.
 */
export function readingColumnLayout(
  containerWidth: number,
  fontSizePx: number,
  options?: ReadingColumnLayoutOptions,
): { columnWidth: number; columns: number; gap: number } {
  const minRem = options?.minRem ?? DEFAULT_READING_MEASURE_REM;
  const optRem = options?.optRem;
  const gap = options?.gapPx ?? 24;
  const maxColumns = options?.maxColumns ?? 2;
  const width = Math.max(1, containerWidth);
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 16;
  const minColumn = minRem * size;
  const maxColumn =
    optRem !== undefined && Number.isFinite(optRem) && optRem > 0 ? optRem * size : undefined;
  const columns = Math.max(
    1,
    Math.min(maxColumns, Math.floor((width + gap) / (minColumn + gap))),
  );
  if (columns === 1) {
    return {
      columnWidth: maxColumn === undefined ? width : Math.min(width, maxColumn),
      columns: 1,
      gap: 0,
    };
  }
  const filled = Math.max(1, (width - (columns - 1) * gap) / columns);
  return {
    columnWidth: maxColumn === undefined ? filled : Math.min(filled, maxColumn),
    columns,
    gap,
  };
}

export function pageStepSize(scroller: { clientWidth: number; clientHeight: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.max(1, scroller.clientWidth),
    y: Math.max(1, scroller.clientHeight),
  };
}

export function pagedScrollMax(scroller: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): number {
  return Math.max(0, scroller.scrollWidth - scroller.clientWidth);
}

export function pagedProgressRatio(scroller: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): number {
  const max = pagedScrollMax(scroller);
  return max === 0 ? 0 : Math.min(1, Math.max(0, scroller.scrollLeft / max));
}

/** One visual page: viewport plus the gap after the last visible column (Readium). */
export function pagedColumnStep(viewportWidth: number, gapPx = 0): number {
  return Math.max(1, viewportWidth + Math.max(0, gapPx));
}

/**
 * CSS columns fragment a mark into real glyph boxes plus hairline / extra-tall
 * phantoms. getBoundingClientRect unions those into a box that starts in
 * column 0, so search jump lands at the chapter start. Keep the first real
 * glyph box instead (same filter as annotation overlay painting).
 */
export function realPagedFragmentBox<T extends { width: number; height: number }>(
  boxes: readonly T[],
  lineHeight: number,
): T | null {
  const cap = (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 28) * 2.5;
  for (const box of boxes) {
    if (box.width >= 2 && box.height >= 1 && box.height <= cap) {
      return box;
    }
  }
  return null;
}

/** Page-aligned scrollLeft that puts `clientX` inside the visible spread. */
export function pagedScrollLeftForClientX(
  clientX: number,
  scrollerClientLeft: number,
  scrollLeft: number,
  step: number,
): number {
  if (!(step > 0)) {
    return scrollLeft;
  }
  const left = clientX - scrollerClientLeft + scrollLeft;
  return Math.max(0, Math.floor(left / step) * step);
}

/** True when a glyph's clientX sits in the current paged spread viewport. */
export function pagedGlyphInView(
  glyphLeft: number,
  viewLeft: number,
  viewWidth: number,
): boolean {
  if (!(viewWidth > 0)) {
    return false;
  }
  return glyphLeft >= viewLeft - 1 && glyphLeft < viewLeft + viewWidth;
}

/**
 * Long chapters must occupy more than one column page. A single page of long
 * text means CSS columns have not fragmented yet — every glyph looks like page 0.
 */
export function pagedContentLooksColumnized(
  scrollWidth: number,
  step: number,
  textLength: number,
): boolean {
  if (!(step > 1) || !(scrollWidth > 0)) {
    return false;
  }
  if (textLength < 320) {
    return true;
  }
  return scrollWidth >= step * 1.5;
}

/**
 * Reject a chapter-start landing when the hit is clearly later in the chapter.
 * Column-0 phantoms look in-view at scrollLeft=0; do not treat that as success.
 * Do not compare expected page by offset ratio — typesetting is not uniform.
 */
export function pagedHitPagePlausible(
  scrollLeft: number,
  scrollWidth: number,
  step: number,
  textStart: number,
  textLength: number,
): boolean {
  if (!(step > 0) || !(scrollWidth > 0)) {
    return false;
  }
  if (!(textLength > 0)) {
    return true;
  }
  const page = Math.floor(scrollLeft / step + 1e-6);
  if (page > 0) {
    return true;
  }
  return textLength < 320 || textStart < Math.max(80, textLength * 0.12);
}

/**
 * Touch page-turn slide duration. Same fast-settling family as the 280ms
 * desktop `data-page-anim` keyframes, one notch shorter for direct finger
 * feedback (T2: 触屏翻页统一水平 slide).
 */
export const PAGED_TOUCH_SLIDE_MS = 200;

/**
 * Motion options for paginated scrollLeft writes: `touchPrimary` gates the
 * slide, `reducedMotion` keeps the instant jump, and `scheduler`/`now` stay
 * headless-testable (same injection style as createCoalescedScrollHandler).
 */
export interface PagedScrollMotion {
  touchPrimary: boolean;
  reducedMotion: boolean;
  scheduler?: FrameScheduler | null;
  now?: () => number;
}

interface PagedTouchSlideFlight {
  readonly scheduler: FrameScheduler;
  readonly from: number;
  readonly to: number;
  readonly startAt: number;
  /** 最近一帧写入（初始 = from，首帧前的外部写入也能被弃飞检测捕获）。 */
  lastWritten: number;
  handle: number | null;
}

const pagedTouchSlideFlights = new WeakMap<object, PagedTouchSlideFlight>();

function pagedSlideNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * easeOutQuart approximates cubic-bezier(0.22, 1, 0.36, 1) — the same
 * fast-settling curve family as the desktop page-turn keyframes in
 * reader.css, so touch slide and desktop slide feel like one motion.
 */
function pagedSlideEaseOutQuart(t: number): number {
  return 1 - (1 - t) ** 4;
}

/** Drop an in-flight touch slide (idempotent; call before native drags). */
export function cancelPagedTouchSlide(scroller: object): void {
  const flight = pagedTouchSlideFlights.get(scroller);
  if (flight === undefined) {
    return;
  }
  pagedTouchSlideFlights.delete(scroller);
  if (flight.handle !== null) {
    flight.scheduler.cancel(flight.handle);
    flight.handle = null;
  }
}

/** Pending slide target while a touch animation is still in flight. */
function pendingPagedSlideTarget(scroller: object): number | null {
  return pagedTouchSlideFlights.get(scroller)?.to ?? null;
}

/**
 * Single write funnel for paginated scrollLeft. Without motion (desktop /
 * reduced motion / tests) this is the historical instant assignment; with
 * touch motion it animates ~200ms via rAF. A new write cancels the in-flight
 * frame and retargets from the current visual offset, so fast consecutive
 * turns neither stick nor pause on a half page. An external write that moves
 * the scroller away from our last frame aborts the flight (native drags win).
 */
function writePagedScrollLeft(
  scroller: { scrollLeft: number },
  target: number,
  motion?: PagedScrollMotion,
): void {
  if (motion === undefined || !motion.touchPrimary || motion.reducedMotion) {
    cancelPagedTouchSlide(scroller);
    scroller.scrollLeft = target;
    return;
  }
  const scheduler = motion.scheduler !== undefined ? motion.scheduler : rafFrameScheduler();
  if (scheduler === null) {
    cancelPagedTouchSlide(scroller);
    scroller.scrollLeft = target;
    return;
  }
  const existing = pagedTouchSlideFlights.get(scroller);
  if (existing !== undefined && existing.handle !== null && existing.to === target) {
    return; // Already sliding to this page: keep the current curve.
  }
  cancelPagedTouchSlide(scroller);
  const from = scroller.scrollLeft;
  if (Math.abs(target - from) < 1) {
    scroller.scrollLeft = target;
    return;
  }
  const now = motion.now ?? pagedSlideNow;
  const state: PagedTouchSlideFlight = {
    scheduler,
    from,
    to: target,
    startAt: now(),
    lastWritten: from,
    handle: null,
  };
  pagedTouchSlideFlights.set(scroller, state);
  const tick = (): void => {
    if (pagedTouchSlideFlights.get(scroller) !== state) {
      return; // cancelled or retargeted by a newer write
    }
    if (Math.abs(scroller.scrollLeft - state.lastWritten) > 1) {
      // An external write (native drag / direct assignment) owns the
      // scroller now — stop fighting it.
      pagedTouchSlideFlights.delete(scroller);
      state.handle = null;
      return;
    }
    const elapsed = now() - state.startAt;
    const ratio = Math.min(1, Math.max(0, elapsed / PAGED_TOUCH_SLIDE_MS));
    const value = state.from + (state.to - state.from) * pagedSlideEaseOutQuart(ratio);
    scroller.scrollLeft = value;
    state.lastWritten = value;
    if (ratio >= 1) {
      pagedTouchSlideFlights.delete(scroller);
      state.handle = null;
      return;
    }
    state.handle = scheduler.request(tick);
  };
  state.handle = scheduler.request(tick);
}

/**
 * Whole-page snap target for a given offset (pure). Shared by
 * snapPagedScroller and the settle branches so a touch-animated settle can
 * compute its final landing point before the (single) animated write.
 */
function pagedSnapTarget(current: number, step: number, max: number): number {
  const page = Math.round(current / step);
  const snapped = Math.min(max, Math.max(0, page * step));
  // A short last column is not a multiple of `step`. Rounding it would jump
  // back a whole page when returning to the previous chapter.
  if (Math.abs(max - current) <= Math.abs(snapped - current)) {
    return max;
  }
  return snapped;
}

const PAGE_STEP_VAR = '--lightink-reader-page-step';

export function applyPagedPageStep(
  target: { style: { setProperty(name: string, value: string): void } },
  step: number,
): void {
  target.style.setProperty(PAGE_STEP_VAR, `${Math.max(1, Math.round(step))}px`);
}

/**
 * Page-turn distance for a columnized iframe root.
 * Never parse `style.width` as a number: `parseFloat('100%') === 100` and
 * then every wheel tick either jitters 100px or falls through to the next chapter.
 */
export function pagedFrameStep(scroller: {
  style: { width: string; getPropertyValue(name: string): string };
  clientWidth: number;
}): number {
  const stored = Number.parseFloat(scroller.style.getPropertyValue(PAGE_STEP_VAR));
  if (Number.isFinite(stored) && stored > 1) {
    return stored;
  }
  const gap = Number.parseFloat(scroller.style.getPropertyValue('--lightink-reader-column-gap'));
  const gapPx = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const widthDecl = scroller.style.width.trim();
  if (widthDecl.endsWith('px')) {
    const px = Number.parseFloat(widthDecl);
    if (Number.isFinite(px) && px > 1) {
      return pagedColumnStep(px, gapPx);
    }
  }
  return pagedColumnStep(Math.max(1, scroller.clientWidth), gapPx);
}

function resolvePagedStep(
  scroller: {
    clientWidth: number;
    style?: { width?: string; getPropertyValue?(name: string): string };
  },
  stepSize?: number,
): number {
  if (stepSize !== undefined && Number.isFinite(stepSize) && stepSize > 0) {
    return Math.max(1, stepSize);
  }
  if (
    scroller.style !== undefined &&
    typeof scroller.style.getPropertyValue === 'function' &&
    typeof scroller.style.width === 'string'
  ) {
    return pagedFrameStep({
      style: {
        width: scroller.style.width,
        getPropertyValue: (name: string) => scroller.style!.getPropertyValue!(name),
      },
      clientWidth: scroller.clientWidth,
    });
  }
  return Math.max(1, scroller.clientWidth);
}

/**
 * Integer-aligned facing-page metrics. Shrinking the used width by a few
 * pixels keeps `columns * columnWidth + (columns - 1) * gap === width`,
 * so a page step cannot land inside the next column.
 */
export function pagedSpreadMetrics(
  containerWidth: number,
  fontSizePx: number,
  options?: ReadingColumnLayoutOptions,
): { width: number; columnWidth: number; columns: number; gap: number; step: number } {
  const layout = readingColumnLayout(containerWidth, fontSizePx, options);
  const columns = layout.columns;
  const gap = columns === 1 ? 0 : layout.gap;
  const columnWidth = Math.max(1, Math.floor(layout.columnWidth));
  const width = columnWidth * columns + (columns - 1) * gap;
  return { width, columnWidth, columns, gap, step: pagedColumnStep(width, gap) };
}

/** Minimal style surface shared by real elements and fake test elements. */
export interface PagedSpreadStyleTarget {
  style: {
    setProperty(name: string, value: string, priority?: string): void;
    removeProperty(name: string): string;
  };
}

const PAGED_SPREAD_VARS = [
  '--lightink-reader-column-width',
  '--lightink-reader-column-gap',
  '--lightink-reader-column-count',
] as const;

/**
 * Single host layout applier for paginated spreads: writes the shared
 * `--lightink-reader-column-*` custom properties derived from
 * `pagedSpreadMetrics`. The Markdown scroller (main.ts) and the flow iframe
 * roots (flow-renderer) consume the same variables, so both hosts step in
 * whole, integer-aligned pages.
 */
export function applyPagedSpreadVars(
  target: PagedSpreadStyleTarget,
  metrics: { columnWidth: number; columns: number; gap: number },
): void {
  target.style.setProperty('--lightink-reader-column-width', `${metrics.columnWidth}px`);
  target.style.setProperty('--lightink-reader-column-gap', `${metrics.gap}px`);
  target.style.setProperty('--lightink-reader-column-count', String(metrics.columns));
}

/** Drop the paginated spread variables (scroll mode / teardown). */
export function clearPagedSpreadVars(target: PagedSpreadStyleTarget): void {
  for (const name of PAGED_SPREAD_VARS) {
    target.style.removeProperty(name);
  }
}

export function applyPagedProgress(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  ratio: number,
  stepSize?: number,
): void {
  cancelPagedTouchSlide(scroller);
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const max = pagedScrollMax(scroller);
  if (max <= 0 || safe <= 0) {
    scroller.scrollLeft = 0;
    return;
  }
  if (safe >= 1) {
    scroller.scrollLeft = max;
    return;
  }
  const step = resolvePagedStep(scroller, stepSize);
  scroller.scrollLeft = Math.min(max, Math.max(0, Math.round((max * safe) / step) * step));
}

/** After a resize, land on a whole page instead of a leftover sliver. */
export function snapPagedScroller(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  stepSize?: number,
  motion?: PagedScrollMotion,
): void {
  const step = resolvePagedStep(scroller, stepSize);
  const max = pagedScrollMax(scroller);
  if (max <= 0) {
    writePagedScrollLeft(scroller, 0, motion);
    return;
  }
  // While a touch slide is in flight, snap from the pending target so the
  // snap that follows an advance cannot revert the turn mid-slide.
  const current = pendingPagedSlideTarget(scroller) ?? scroller.scrollLeft;
  writePagedScrollLeft(scroller, pagedSnapTarget(current, step, max), motion);
}

/** Matches `TOUCH_SWIPE_MIN_PX`: a short drag should snap back, not free-scroll. */
const PAGED_RELEASE_COMMIT_PX = 48;
const PAGED_RELEASE_COMMIT_RATIO = 0.22;
const PAGED_RELEASE_EDGE_PX = 2;

/**
 * After a finger-drag on a column scroller, finish or revert the page.
 * Native `overflow-x: auto` already moved `scrollLeft`; this must not add a
 * second step on top. Returns false only when the gesture asked for the next
 * chapter (already on the last/first page) so the caller can change chapters.
 */
export function settlePagedRelease(
  scroller: {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
    style?: { width?: string; getPropertyValue?(name: string): string };
  },
  startLeft: number,
  dragDx: number,
  stepSize?: number,
  motion?: PagedScrollMotion,
): boolean {
  // The finger just owned this scroller: any in-flight slide is stale, and
  // the native drag position below is the truth to settle from.
  cancelPagedTouchSlide(scroller);
  const step = resolvePagedStep(scroller, stepSize);
  const maxLeft = pagedScrollMax(scroller);
  if (maxLeft <= 0) {
    return false;
  }
  const start = Math.min(maxLeft, Math.max(0, startLeft));
  const nativeDelta = scroller.scrollLeft - start;
  const traveled = Math.max(Math.abs(dragDx), Math.abs(nativeDelta));
  const commitPx = Math.min(PAGED_RELEASE_COMMIT_PX, Math.max(1, step * PAGED_RELEASE_COMMIT_RATIO));
  const commit = traveled >= commitPx;
  const goingNext = Math.abs(dragDx) >= 1 ? dragDx < 0 : nativeDelta > 0;
  if (commit && goingNext) {
    if (start >= maxLeft - PAGED_RELEASE_EDGE_PX) {
      snapPagedScroller(scroller, step, motion);
      return false;
    }
    // One step from the page that contains `start`, not from nearest.
    // round(200/400)+1 would skip ahead to page 2. Compute the final landing
    // point analytically so the touch slide is one continuous write.
    const landed = Math.min(maxLeft, Math.max(0, (Math.floor(start / step) + 1) * step));
    writePagedScrollLeft(scroller, pagedSnapTarget(landed, step, maxLeft), motion);
    return true;
  }
  if (commit && !goingNext) {
    if (start <= PAGED_RELEASE_EDGE_PX) {
      snapPagedScroller(scroller, step, motion);
      return false;
    }
    const landed = Math.min(maxLeft, Math.max(0, (Math.ceil(start / step) - 1) * step));
    writePagedScrollLeft(scroller, pagedSnapTarget(landed, step, maxLeft), motion);
    return true;
  }
  snapPagedScroller(scroller, step, motion);
  return true;
}

/** First or last page of a columnized chapter (used when crossing chapters). */
export function scrollPagedScrollerToEdge(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  direction: 1 | -1,
  _stepSize?: number,
): void {
  // Chapter restore is a hard landing: never keep an old slide running.
  cancelPagedTouchSlide(scroller);
  const max = pagedScrollMax(scroller);
  if (direction < 0) {
    // Do not snap: a short last column is not a multiple of `step`, and
    // rounding would hide the chapter ending (the page the reader just left).
    scroller.scrollLeft = max;
    return;
  }
  scroller.scrollLeft = 0;
}

export function advancePagedScroller(
  scroller: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  direction: 1 | -1,
  stepSize?: number,
  motion?: PagedScrollMotion,
): boolean {
  const step = resolvePagedStep(scroller, stepSize);
  const max = pagedScrollMax(scroller);
  if (max <= 0) {
    return false;
  }
  // A quick second turn must advance from the page the first slide is still
  // flying to, not from the mid-slide visual offset.
  const current = pendingPagedSlideTarget(scroller) ?? scroller.scrollLeft;
  const remaining = direction > 0 ? max - current : current;
  // Leftover column slivers should not trap paging inside the chapter.
  if (remaining <= Math.max(8, step * 0.08)) {
    return false;
  }
  const next = Math.min(max, Math.max(0, current + direction * step));
  if (next === current) {
    return false;
  }
  writePagedScrollLeft(scroller, next, motion);
  return true;
}

export function advanceScrolledScroller(
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  direction: 1 | -1,
): boolean {
  const step = Math.max(1, scroller.clientHeight);
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const next = Math.min(max, Math.max(0, scroller.scrollTop + direction * step));
  if (next === scroller.scrollTop) {
    return false;
  }
  scroller.scrollTop = next;
  return true;
}

/**
 * Window-level paginated wheel must not steal these hosts.
 * Flow scroll (TXT/EPUB) owns the pane, including chapter titles/gaps
 * outside iframes. PDF and overflow comic fits keep the page host.
 */
export function readerPageHostOwnsWindowWheel(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const flow = target.closest('.lightink-reader');
  if (flow !== null && flow.getAttribute('data-reading-layout') === 'scroll') {
    return true;
  }
  const pane =
    target.id === 'lightink-editor-area' ? target : target.closest('#lightink-editor-area');
  if (
    pane !== null &&
    pane.querySelector('.lightink-reader[data-reading-layout="scroll"]') !== null
  ) {
    return true;
  }
  if (target.closest('.lightink-reader-pages') === null) {
    return false;
  }
  const pagedComic = target.closest('[data-comic-reader="true"][data-comic-mode="paged"]');
  if (pagedComic === null) {
    return true;
  }
  if (pagedComic.getAttribute('data-comic-zoomed') === 'true') {
    return true;
  }
  const fit = pagedComic.getAttribute('data-comic-fit');
  return fit === 'width' || fit === 'height' || fit === 'original';
}

/** True when native overflow can still absorb this wheel delta. */
export function scrollerHasRoomInDelta(
  scroller: {
    scrollTop: number;
    scrollLeft: number;
    scrollHeight: number;
    scrollWidth: number;
    clientHeight: number;
    clientWidth: number;
  },
  deltaX: number,
  deltaY: number,
  slop = 1,
): boolean {
  const useX = Math.abs(deltaX) > Math.abs(deltaY);
  if (useX) {
    if (deltaX === 0) return false;
    return deltaX > 0
      ? scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - slop
      : scroller.scrollLeft > slop;
  }
  if (deltaY === 0) return false;
  return deltaY > 0
    ? scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - slop
    : scroller.scrollTop > slop;
}

export function isReadingNavKey(key: string): boolean {
  return (
    key === ' ' ||
    key === 'Spacebar' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'PageDown' ||
    key === 'PageUp'
  );
}

export function readingNavDirection(key: string, shiftKey = false): 1 | -1 | null {
  if (key === ' ' || key === 'Spacebar') {
    return shiftKey ? -1 : 1;
  }
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') {
    return 1;
  }
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') {
    return -1;
  }
  return null;
}

/** Wait until window/pane resize bursts settle, then refresh the reading view. */
export function createResizeSettle(delayMs = 180): (run: () => void) => () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (run) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  };
}

/**
 * One page per wheel/trackpad gesture. A min-interval gate retriggers during
 * macOS pixel-mode inertia (~300–800ms of decaying events) and skips pages.
 * Lock until the stream has been idle for `idleMs`, and extend the lock while
 * events keep arriving so one flick cannot chain into the next chapter.
 */
/**
 * One consumed touch gesture across iframe + host bindings.
 * Android WebView often delivers the same swipe to both documents in one
 * turn; without a lock, settle/page run twice and one flick skips columns.
 * The lock is turn-scoped (microtask) so the next tap/swipe can page.
 */
export function createPagedGestureLock(): {
  take(): boolean;
  consumed(): boolean;
} {
  let held = false;
  let generation = 0;
  return {
    take() {
      if (held) {
        return false;
      }
      held = true;
      const token = ++generation;
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          if (generation === token) {
            held = false;
          }
        });
      } else {
        held = false;
      }
      return true;
    },
    consumed() {
      return held;
    },
  };
}

export function createPagedWheelGate(idleMs = 240): (
  direction: 1 | -1,
  advance: (direction: 1 | -1) => boolean,
) => boolean {
  let locked = false;
  let lastEventAt = 0;
  return (direction, advance) => {
    const now = Date.now();
    if (locked && now - lastEventAt < idleMs) {
      lastEventAt = now;
      return false;
    }
    locked = false;
    const moved = advance(direction);
    if (moved) {
      locked = true;
      lastEventAt = now;
    }
    return moved;
  };
}

/**
 * Slot (chapter / page) whose top edge is nearest to the viewport top.
 * Single source for the flow chapter scan, the PDF page scan and the CBZ
 * page scan. Ties keep the earlier slot (strict `<`), and empty input
 * returns -1 so callers can apply their own default.
 */
export function nearestVisibleSlot(slotTops: readonly number[], viewportTop: number): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slotTops.length; i += 1) {
    const dist = Math.abs(slotTops[i]! - viewportTop);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Spine index of the mounted chapter nearest the viewport — never the NodeList offset. */
export function nearestVisibleChapterIndex(
  chapters: readonly { index: number; top: number }[],
  viewportTop: number,
): number {
  if (chapters.length === 0) {
    return 0;
  }
  const slot = nearestVisibleSlot(
    chapters.map((chapter) => chapter.top),
    viewportTop,
  );
  const index = chapters[Math.max(0, slot)]?.index;
  return Number.isSafeInteger(index) && index! >= 0 ? index! : 0;
}

/**
 * Chapter whose box covers the viewport top. Nearest-top alone prefers a
 * short spacer sitting just above a long chapter the reader is actually in.
 */
export function chapterIndexAtViewportTop(
  chapters: readonly { index: number; top: number; bottom: number }[],
  viewportTop: number,
): number {
  const covering = chapters.filter(
    (chapter) => chapter.top <= viewportTop + 1 && chapter.bottom > viewportTop + 1,
  );
  if (covering.length === 0) {
    return nearestVisibleChapterIndex(chapters, viewportTop);
  }
  let best = covering[0]!;
  for (const chapter of covering) {
    if (chapter.top >= best.top) {
      best = chapter;
    }
  }
  return Number.isSafeInteger(best.index) && best.index >= 0 ? best.index : 0;
}

/** Axis-aligned rect in viewport coordinates (e.g. getBoundingClientRect). */
export interface LayoutRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Slot under the viewport center, plus the point inside that slot. Ratios are
 * deliberately unclamped (by design): a point outside the nearest slot keeps
 * its extrapolated offset so restore math does not silently jump to a slot edge.
 */
export interface ViewportAnchor {
  index: number;
  xRatio: number;
  yRatio: number;
}

/**
 * Shared zoom anchor math (extracted from the PDF reader): find the slot under
 * the viewport center and the exact point inside it, so a zoom can keep that
 * document point under the viewport center. When the center is not inside any
 * slot, the nearest slot midpoint wins; `fallbackIndex` breaks empty input.
 */
export function viewportAnchor(
  viewport: LayoutRect,
  slots: readonly LayoutRect[],
  fallbackIndex = 0,
): ViewportAnchor {
  const cx = viewport.left + viewport.width / 2;
  const cy = viewport.top + viewport.height / 2;
  let index = Math.max(0, Math.min(slots.length - 1, fallbackIndex));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!;
    const inside =
      cx >= slot.left &&
      cx <= slot.left + slot.width &&
      cy >= slot.top &&
      cy <= slot.top + slot.height;
    if (inside) {
      index = i;
      break;
    }
    const midX = slot.left + slot.width / 2;
    const midY = slot.top + slot.height / 2;
    const dist = (midX - cx) ** 2 + (midY - cy) ** 2;
    if (dist < best) {
      best = dist;
      index = i;
    }
  }
  const slot = slots[index];
  if (slot === undefined || slot.width <= 0 || slot.height <= 0) {
    return { index, xRatio: 0.5, yRatio: 0.5 };
  }
  return {
    index,
    xRatio: (cx - slot.left) / slot.width,
    yRatio: (cy - slot.top) / slot.height,
  };
}

/**
 * Keep the captured document point under the viewport center after a zoom.
 * `slotInViewport` is the anchored slot's rect in the *new* viewport
 * coordinates; the result is the scroller offset to apply.
 */
export function scrollToKeepViewportAnchor(
  scroller: { scrollLeft: number; scrollTop: number; clientWidth: number; clientHeight: number },
  slotInViewport: LayoutRect,
  anchor: ViewportAnchor,
): { scrollLeft: number; scrollTop: number } {
  const targetX = scroller.scrollLeft + slotInViewport.left + slotInViewport.width * anchor.xRatio;
  const targetY = scroller.scrollTop + slotInViewport.top + slotInViewport.height * anchor.yRatio;
  return {
    scrollLeft: Math.max(0, targetX - scroller.clientWidth / 2),
    scrollTop: Math.max(0, targetY - scroller.clientHeight / 2),
  };
}

/** Injectable animation-frame source so the coalescing logic stays headless-testable. */
export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** FrameScheduler over the ambient requestAnimationFrame, or null when absent. */
export function rafFrameScheduler(): FrameScheduler | null {
  const g = globalThis as {
    requestAnimationFrame?: (callback: () => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  if (typeof g.requestAnimationFrame !== 'function' || typeof g.cancelAnimationFrame !== 'function') {
    return null;
  }
  return {
    request: (callback) => g.requestAnimationFrame!(callback),
    cancel: (handle) => g.cancelAnimationFrame!(handle),
  };
}

/**
 * Coalesce bursty scroll events into one callback per animation frame:
 * the first event requests a frame, later events within the same frame are
 * merged away, and `cancel()` drops a pending frame (e.g. on teardown).
 * Chapter/page indicators and progress snapshots run in the same frame.
 */
export function createCoalescedScrollHandler(
  onFrame: () => void,
  scheduler: FrameScheduler,
): { schedule(): void; cancel(): void } {
  let handle: number | null = null;
  let pending = false;
  const run = (): void => {
    if (!pending) {
      return; // stale frame fired after cancel()
    }
    pending = false;
    handle = null;
    onFrame();
  };
  return {
    schedule() {
      if (pending) {
        return;
      }
      pending = true;
      handle = scheduler.request(run);
    },
    cancel() {
      if (!pending) {
        return;
      }
      pending = false;
      if (handle !== null) {
        scheduler.cancel(handle);
      }
      handle = null;
    },
  };
}
