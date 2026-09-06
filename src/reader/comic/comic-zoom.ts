/**
 * 漫画缩放/平移：view transform、平移钳制、zoom raster 钉住/提交
 * （布局级重栅格）与 zoomAt/toggleZoomAt/resetViewTransform。
 * 行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import { comicDisplayCeilingCssPx } from '../comic-model.js';
import {
  clampComicViewOffset,
  type ComicFit,
  type ComicReadingMode,
} from '../comic-preferences.js';
import type { ComicSession } from './comic-session.js';

const COMIC_ZOOM_MIN = 1;
const COMIC_ZOOM_MAX = 5;
const COMIC_ZOOM_TOGGLE = 2;
/**
 * R3（ADR-4 修订版）：缩放提交点的布局级重栅格停顿窗口。捏合进行中维持既有
 * 合成器 transform 缩放（逐帧便宜、不重栅格）；双击/捏合 settle、ctrl+wheel
 * 与 adjustZoom 停顿后把可见 spread 的布局尺寸钉到放大后的视觉尺寸，pagesRoot
 * transform 退化为纯平移——布局尺寸即位图栅格分辨率，放大倍数由此进入栅格，
 * 不依赖引擎对 transform 的重栅格行为（01 §4 unknown 的确定性替代）。
 */
const COMIC_ZOOM_RASTER_SETTLE_MS = 160;

/**
 * R3：布局级缩放的钉住槽（空 = 既有合成器 transform 缩放模式）。钉住时
 * slot 的布局盒 = fit 盒 × viewScale，img 的栅格分辨率随之按放大倍数提高；
 * 退出放大（resetViewTransform/zoomAt ≤1/setPreferences）对称摘除。
 */
export interface ComicZoomRasterPin {
  readonly index: number;
  readonly slot: HTMLElement;
  width: number;
  height: number;
  /** natural 变量的未缩放基线；repin 重钉时按 applySlotWidth 的新值同步。 */
  naturalWidthVar: string;
  naturalHeightVar: string;
}

function clampComicZoom(value: number): number {
  return Math.min(COMIC_ZOOM_MAX, Math.max(COMIC_ZOOM_MIN, value));
}

function comicSurfaceTouchAction(
  mode: ComicReadingMode,
  fit: ComicFit,
  zoomed: boolean,
): string {
  if (zoomed) return 'none';
  if (mode === 'strip') return 'pan-y';
  if (fit === 'width') return 'pan-y';
  if (fit === 'height') return 'pan-x';
  if (fit === 'original') return 'pan-x pan-y';
  return 'none';
}

function clampViewOffset(session: ComicSession): void {
  if (session.viewScale <= 1) {
    session.viewX = 0;
    session.viewY = 0;
    return;
  }
  const viewport = session.container.getBoundingClientRect();
  // 钉住期不读 pagesRoot 的 scroll 尺寸（居中 flex 尾侧溢出会低估范围），
  // 用 pin 时记录的未钉住态测量值，与未钉住路径同一份 clamp 语义。
  const pinned = session.zoomRasterPins.length > 0;
  const measured =
    pinned && session.zoomRasterContentRange !== null
      ? session.zoomRasterContentRange
      : {
          width:
            session.pagesRoot.scrollWidth || session.pagesRoot.clientWidth || viewport.width,
          height:
            session.pagesRoot.scrollHeight || session.pagesRoot.clientHeight || viewport.height,
        };
  const clamped = clampComicViewOffset(
    { x: session.viewX, y: session.viewY },
    session.viewScale,
    { width: viewport.width, height: viewport.height },
    measured,
  );
  session.viewX = clamped.x;
  session.viewY = clamped.y;
}

export function applyViewTransform(session: ComicSession): void {
  const { container, pagesRoot, preferences } = session;
  clampViewOffset(session);
  const zoomed = session.viewScale > 1;
  const scaleText = String(session.viewScale);
  container.dataset.comicZoomed = String(zoomed);
  container.dataset.comicScale = scaleText;
  pagesRoot.dataset.comicScale = scaleText;
  container.style.setProperty('--lightink-comic-scale', scaleText);
  container.style.setProperty('--lightink-comic-translate-x', `${session.viewX}px`);
  container.style.setProperty('--lightink-comic-translate-y', `${session.viewY}px`);
  pagesRoot.style.setProperty('--lightink-comic-scale', scaleText);
  pagesRoot.style.setProperty('--lightink-comic-translate-x', `${session.viewX}px`);
  pagesRoot.style.setProperty('--lightink-comic-translate-y', `${session.viewY}px`);
  if (zoomed) {
    pagesRoot.style.transformOrigin = '0 0';
    pagesRoot.style.transform =
      session.zoomRasterPins.length > 0
        ? `translate(${session.viewX}px, ${session.viewY}px)`
        : `translate(${session.viewX}px, ${session.viewY}px) scale(${session.viewScale})`;
  } else {
    pagesRoot.style.removeProperty('transform');
    pagesRoot.style.removeProperty('transform-origin');
  }
  const touchAction = comicSurfaceTouchAction(preferences.mode, preferences.fit, zoomed);
  container.style.touchAction = touchAction;
  pagesRoot.style.touchAction = touchAction;
  if (preferences.mode === 'strip') {
    pagesRoot.style.overflow = zoomed ? 'hidden' : 'auto';
  } else {
    pagesRoot.style.overflow = zoomed || preferences.fit === 'screen' ? 'hidden' : 'auto';
  }
}

export function cancelZoomRasterCommit(session: ComicSession): void {
  if (session.zoomRasterTimer === null) return;
  clearTimeout(session.zoomRasterTimer);
  session.zoomRasterTimer = null;
}

function restoreZoomRasterVar(slot: HTMLElement, name: string, value: string): void {
  if (value === '') slot.style.removeProperty(name);
  else slot.style.setProperty(name, value);
}

function scaleZoomRasterVar(session: ComicSession, slot: HTMLElement, name: string, current: string): void {
  if (current === '') return;
  const px = Number.parseFloat(current);
  if (!Number.isFinite(px) || px <= 0) return;
  slot.style.setProperty(name, `${px * session.viewScale}px`);
}

/**
 * 解除钉住：slot 布局回到 fit 尺寸、transform 恢复 translate+scale。钉住与
 * 解钉互为逆变换，flex 居中/padding 造成的常量偏移由前后测量差回补进
 * translate，同一任务内无中间帧，视觉逐像素不变。
 */
export function unpinZoomRaster(session: ComicSession): void {
  cancelZoomRasterCommit(session);
  if (session.zoomRasterPins.length === 0) return;
  const reference = session.zoomRasterPins[0]!.slot;
  const before = reference.getBoundingClientRect();
  for (const pin of session.zoomRasterPins) {
    pin.slot.style.removeProperty('width');
    pin.slot.style.removeProperty('height');
    pin.slot.style.removeProperty('flex');
    pin.slot.style.removeProperty('max-width');
    pin.slot.style.removeProperty('max-height');
    restoreZoomRasterVar(
      pin.slot,
      '--lightink-comic-natural-width',
      pin.naturalWidthVar,
    );
    restoreZoomRasterVar(
      pin.slot,
      '--lightink-comic-natural-height',
      pin.naturalHeightVar,
    );
  }
  session.zoomRasterPins = [];
  session.zoomRasterContentRange = null;
  session.pagesRoot.style.transform =
    `translate(${session.viewX}px, ${session.viewY}px) scale(${session.viewScale})`;
  const after = reference.getBoundingClientRect();
  session.viewX += before.left - after.left;
  session.viewY += before.top - after.top;
  applyViewTransform(session);
}

/**
 * 钉住：把可见 spread 的布局尺寸设为当前视觉尺寸（= fit 盒 × viewScale），
 * pagesRoot transform 退化为纯平移。全有或全无：8192 设备像素预算（按
 * 夹取 dpr 折算）超限、或任一可见槽不可测（fit-width/fit-original 双页
 * spread 的未物化半页 height:auto 塌缩为零盒）都整体放弃，维持 transform
 * 缩放路径——否则晚物化的半页会以 1× 渲染在放大槽旁（混合倍率）。
 * 仅 paged；strip 模式零变化。捏合进行中（双指在屏）不钉住。
 */
function pinZoomRaster(session: ComicSession): boolean {
  if (
    session.preferences.mode !== 'paged' ||
    session.viewScale <= 1 ||
    session.activePointers.size >= 2
  ) {
    return false;
  }
  const cap = comicDisplayCeilingCssPx();
  const pins: ComicZoomRasterPin[] = [];
  for (const index of session.visible) {
    const slot = session.slots[index];
    if (slot === undefined || slot.hidden) continue;
    const rect = slot.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false; // 全有或全无，见上
    if (rect.width > cap || rect.height > cap) return false;
    pins.push({
      index,
      slot,
      width: rect.width,
      height: rect.height,
      naturalWidthVar: slot.style.getPropertyValue('--lightink-comic-natural-width'),
      naturalHeightVar: slot.style.getPropertyValue('--lightink-comic-natural-height'),
    });
  }
  if (pins.length === 0) return false;
  const viewport = session.container.getBoundingClientRect();
  // 改写布局前记录未钉住态的内容范围：transform 缩放不影响 scroll 尺寸，
  // 此刻读数即未放大 fit 布局，与未钉住路径的 clamp 输入同源。
  session.zoomRasterContentRange = {
    width: session.pagesRoot.scrollWidth || session.pagesRoot.clientWidth || viewport.width,
    height: session.pagesRoot.scrollHeight || session.pagesRoot.clientHeight || viewport.height,
  };
  const before = pins[0]!.slot.getBoundingClientRect();
  for (const pin of pins) {
    pin.slot.style.width = `${pin.width}px`;
    pin.slot.style.height = `${pin.height}px`;
    pin.slot.style.flex = 'none';
    pin.slot.style.maxWidth = 'none';
    pin.slot.style.maxHeight = 'none';
    scaleZoomRasterVar(
      session,
      pin.slot,
      '--lightink-comic-natural-width',
      pin.naturalWidthVar,
    );
    scaleZoomRasterVar(
      session,
      pin.slot,
      '--lightink-comic-natural-height',
      pin.naturalHeightVar,
    );
  }
  session.zoomRasterPins = pins;
  session.pagesRoot.style.transform = `translate(${session.viewX}px, ${session.viewY}px)`;
  const after = pins[0]!.slot.getBoundingClientRect();
  session.viewX -= after.left - before.left;
  session.viewY -= after.top - before.top;
  applyViewTransform(session);
  return true;
}

/** settle/提交点：先解钉再按当前几何重钉（resize/换屏后的新 fit 盒）。 */
export function commitZoomRaster(session: ComicSession): void {
  cancelZoomRasterCommit(session);
  if (session.zoomRasterPins.length > 0) unpinZoomRaster(session);
  if (session.preferences.mode !== 'paged' || session.viewScale <= 1) return;
  pinZoomRaster(session);
}

/** ctrl+wheel / adjustZoom 连发缩放只在停顿后提交一次布局级重栅格。 */
export function scheduleZoomRasterCommit(session: ComicSession): void {
  cancelZoomRasterCommit(session);
  session.zoomRasterTimer = setTimeout(() => {
    session.zoomRasterTimer = null;
    if (!session.destroyed) commitZoomRaster(session);
  }, COMIC_ZOOM_RASTER_SETTLE_MS);
}

/**
 * applySlotFit 重写了 fit 内联样式（新物化页、裁边扫描、重排版落位）：
 * 钉住槽按新 fit 几何重钉（钉住盒 = 测量宽高 × viewScale；宽高不含平移，
 * 测量不受 translate 影响）。不可测（隐藏/jsdom 零盒）时按记录盒重写，
 * 保持钉住态一致。applySlotWidth 刚按 natural+裁边重写了 natural 变量：
 * 把未缩放新基线同步回记录（并把内容范围按几何差量平移），解钉才不会
 * 把钉住前的旧值恢复回去（丢裁边显示）。
 */
export function repinZoomRasterSlot(session: ComicSession, index: number): void {
  const pin = session.zoomRasterPins.find((entry) => entry.index === index);
  if (pin === undefined) return;
  const rect = pin.slot.getBoundingClientRect();
  const measurable = rect.width > 0 && rect.height > 0;
  if (measurable) {
    if (session.zoomRasterContentRange !== null) {
      session.zoomRasterContentRange = {
        width: Math.max(
          1,
          session.zoomRasterContentRange.width + rect.width - pin.width / session.viewScale,
        ),
        height: Math.max(
          1,
          session.zoomRasterContentRange.height + rect.height - pin.height / session.viewScale,
        ),
      };
    }
    pin.width = rect.width * session.viewScale;
    pin.height = rect.height * session.viewScale;
  }
  pin.slot.style.width = `${pin.width}px`;
  pin.slot.style.height = `${pin.height}px`;
  pin.slot.style.flex = 'none';
  pin.slot.style.maxWidth = 'none';
  pin.slot.style.maxHeight = 'none';
  pin.naturalWidthVar = pin.slot.style.getPropertyValue('--lightink-comic-natural-width');
  pin.naturalHeightVar = pin.slot.style.getPropertyValue('--lightink-comic-natural-height');
  scaleZoomRasterVar(session, pin.slot, '--lightink-comic-natural-width', pin.naturalWidthVar);
  scaleZoomRasterVar(session, pin.slot, '--lightink-comic-natural-height', pin.naturalHeightVar);
}

export function resetViewTransform(session: ComicSession): void {
  unpinZoomRaster(session); // 先回到 transform 缩放形态再归零，退出放大即恢复原尺寸
  session.viewScale = 1;
  session.viewX = 0;
  session.viewY = 0;
  applyViewTransform(session);
}

export function zoomAt(
  session: ComicSession,
  clientX: number,
  clientY: number,
  nextScale: number,
): void {
  if (session.zoomRasterPins.length > 0) unpinZoomRaster(session); // 焦点数学按未缩放内容坐标
  const rect = session.container.getBoundingClientRect();
  const pointX = clientX - rect.left;
  const pointY = clientY - rect.top;
  const contentX = (pointX - session.viewX) / session.viewScale;
  const contentY = (pointY - session.viewY) / session.viewScale;
  session.viewScale = clampComicZoom(nextScale);
  if (session.viewScale <= 1) {
    session.viewX = 0;
    session.viewY = 0;
  } else {
    session.viewX = pointX - contentX * session.viewScale;
    session.viewY = pointY - contentY * session.viewScale;
  }
  applyViewTransform(session);
}

export function toggleZoomAt(session: ComicSession, clientX: number, clientY: number): void {
  zoomAt(session, clientX, clientY, session.viewScale > 1 ? 1 : COMIC_ZOOM_TOGGLE);
  commitZoomRaster(session); // 双击是离散手势：settle 点同步提交布局级重栅格
}
