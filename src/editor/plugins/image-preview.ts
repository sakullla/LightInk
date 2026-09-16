/**
 * 图片双击预览（灯箱）。单击仍交给编辑器选中/缩放；双击用当前已显示的
 * src（data/blob/已授权远程 URL）全屏查看，不重新走相对路径解析。
 *
 * 关闭：Esc、点遮罩、点预览图（zoom-out）。
 */

import { labelModal, mountModalFocus } from '../../ui/modal-focus.js';
import { isModifiedClick } from '../link-navigation.js';
import {
  isSafeInlineImageUrl,
  normalizeRemoteImageUrl,
} from '../../media/remote-image-policy.js';

export const IMAGE_LIGHTBOX_OVERLAY_CLASS = 'lightink-image-lightbox';

export const IMAGE_LIGHTBOX_CLOSE_ICON =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>';

export interface ImageLightboxSpec {
  readonly src: string;
  readonly alt?: string;
  readonly title?: string;
  readonly closeLabel?: string;
}

/** 已显示在 <img> 上、可安全放大的 src；相对路径未解析时不能预览。 */
export function canPreviewImageDisplaySrc(src: string): boolean {
  if (src === '') {
    return false;
  }
  if (isSafeInlineImageUrl(src)) {
    return true;
  }
  return normalizeRemoteImageUrl(src) !== null;
}

export type ImageDblclickIntent = 'preview' | 'ignore';

export function imageDblclickIntent(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  displaySrc: string,
): ImageDblclickIntent {
  if (isModifiedClick(event as MouseEvent)) {
    return 'ignore';
  }
  return canPreviewImageDisplaySrc(displaySrc) ? 'preview' : 'ignore';
}

let activeClose: (() => void) | null = null;

export function closeImageLightbox(): void {
  activeClose?.();
}

/** 打开灯箱；已有预览时先关掉。返回关闭函数。 */
export function showImageLightbox(doc: Document, spec: ImageLightboxSpec): () => void {
  if (!canPreviewImageDisplaySrc(spec.src)) {
    return () => undefined;
  }
  activeClose?.();

  const overlay = doc.createElement('div');
  overlay.className = `lightink-modal-overlay ${IMAGE_LIGHTBOX_OVERLAY_CLASS}`;

  const dialog = doc.createElement('div');
  dialog.className = 'lightink-image-lightbox-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const heading = doc.createElement('h2');
  heading.className = 'lightink-image-lightbox-title';
  heading.textContent = spec.title ?? 'Image preview';
  labelModal(dialog, heading);

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-image-lightbox-close';
  closeBtn.setAttribute('aria-label', spec.closeLabel ?? 'Close');
  closeBtn.innerHTML = IMAGE_LIGHTBOX_CLOSE_ICON;

  const img = doc.createElement('img');
  img.className = 'lightink-image-lightbox-img';
  img.src = spec.src;
  img.alt = spec.alt ?? '';

  dialog.append(heading, closeBtn, img);
  overlay.appendChild(dialog);

  let releaseModal = (): void => overlay.remove();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (activeClose === close) {
      activeClose = null;
    }
    releaseModal();
  };

  closeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  img.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: closeBtn,
    onEscape: close,
  });
  activeClose = close;
  return close;
}
