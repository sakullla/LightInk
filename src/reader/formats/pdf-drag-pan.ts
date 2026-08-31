/**
 * PDF 放大后的拖拽平移（触屏优先环境）。
 *
 * 适合页宽（userZoom ≤ 1）时页宿主只竖向滚动，原生滚动即可；放大出横向
 * 溢出后原生手势不可靠（模拟触屏/鼠标环境下横向完全拖不动），把宿主
 * touch-action 收成 none，改由指针拖拽直接写 scrollLeft/Top——与漫画缩放
 * 平移同一交互。桌面鼠标环境不启用，拖动划选文字维持原状。
 */

import { isTouchPrimaryDocument } from '../comic-preferences.js';

/** 拖拽平移的启动位移（px）：小于该值视为点按，交还 click（chrome 切换等）。 */
export const PDF_PAN_SLOP_PX = 6;

/** 放大后才有横向溢出；留 1px 余量吞掉亚像素舍入。 */
export function pdfPanOverflow(scroller: { scrollWidth: number; clientWidth: number }): boolean {
  return scroller.scrollWidth - scroller.clientWidth > 1;
}

export interface PdfDragPanHandle {
  /** 缩放/量页重排后重估横向溢出，同步 touch-action 与光标标记。 */
  sync(): void;
  release(): void;
}

interface PanStart {
  id: number;
  x: number;
  y: number;
  left: number;
  top: number;
  panned: boolean;
}

/** 绑定拖拽平移；非触屏环境返回空实现（桌面语义不变）。 */
export function bindPdfDragPan(
  scroller: HTMLElement,
  options?: { touchPrimary?: boolean },
): PdfDragPanHandle {
  const touchPrimary = options?.touchPrimary ?? isTouchPrimaryDocument(scroller.ownerDocument);
  if (!touchPrimary) {
    return { sync: () => undefined, release: () => undefined };
  }

  let start: PanStart | null = null;
  let swallowClick = false;

  const sync = (): void => {
    const enabled = pdfPanOverflow(scroller);
    // touch-action none：真触屏下浏览器不再抢手势（原生滚动一旦接管会派
    // pointercancel 打断拖拽），两轴平移都走下面的指针回写。
    scroller.style.touchAction = enabled ? 'none' : '';
    if (enabled) {
      scroller.setAttribute('data-pdf-pan', 'true');
    } else {
      scroller.removeAttribute('data-pdf-pan');
    }
  };

  const stopPanned = (pointerId: number): void => {
    scroller.removeAttribute('data-pdf-panning');
    scroller.style.userSelect = '';
    try {
      scroller.releasePointerCapture?.(pointerId);
    } catch {
      // jsdom / 已释放的指针没有 capture 可放。
    }
  };

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (typeof pointer.button === 'number' && pointer.button !== 0) {
      return;
    }
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') {
      return;
    }
    if (!pdfPanOverflow(scroller)) {
      return;
    }
    start = {
      id: pointer.pointerId ?? 0,
      x: pointer.clientX,
      y: pointer.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      panned: false,
    };
  };

  const onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    const dx = pointer.clientX - start.x;
    const dy = pointer.clientY - start.y;
    if (!start.panned) {
      if (Math.hypot(dx, dy) < PDF_PAN_SLOP_PX) {
        return;
      }
      start.panned = true;
      scroller.setAttribute('data-pdf-panning', 'true');
      // 拖拽期间禁掉划选：鼠标指针会把拖动当文字选择，和平移打架。
      scroller.style.userSelect = 'none';
      try {
        scroller.setPointerCapture?.(pointer.pointerId);
      } catch {
        // jsdom 无 pointer capture；真机拿不到 capture 也不影响回写。
      }
    }
    scroller.scrollLeft = start.left - dx;
    scroller.scrollTop = start.top - dy;
  };

  const onPointerUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    if (start.panned) {
      // 拖完吞掉紧随的合成 click，避免连带触发 chrome 显隐/笔记点击。
      swallowClick = true;
      stopPanned(start.id);
    }
    start = null;
  };

  const onPointerCancel = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (start === null || (pointer.pointerId ?? 0) !== start.id) {
      return;
    }
    // cancel 后没有合成 click，不布防吞点击，否则会误伤下一次真点按。
    if (start.panned) {
      stopPanned(start.id);
    }
    start = null;
  };

  const onClick = (event: Event): void => {
    if (!swallowClick) {
      return;
    }
    swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  scroller.addEventListener('pointerdown', onPointerDown);
  scroller.addEventListener('pointermove', onPointerMove);
  scroller.addEventListener('pointerup', onPointerUp);
  scroller.addEventListener('pointercancel', onPointerCancel);
  scroller.addEventListener('click', onClick, { capture: true });
  sync();

  return {
    sync,
    release: () => {
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('pointermove', onPointerMove);
      scroller.removeEventListener('pointerup', onPointerUp);
      scroller.removeEventListener('pointercancel', onPointerCancel);
      scroller.removeEventListener('click', onClick, { capture: true });
      scroller.removeAttribute('data-pdf-pan');
      scroller.removeAttribute('data-pdf-panning');
      scroller.style.touchAction = '';
      scroller.style.userSelect = '';
      start = null;
      swallowClick = false;
    },
  };
}
