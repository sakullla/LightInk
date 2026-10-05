/**
 * 非阻塞 toast 通知（R4 / ADR-5）。
 *
 * 首次调用懒挂载单例容器：`role=status` + `aria-live=polite`，屏幕角落
 * 堆叠，不 inert、不抢焦点、z-index 低于模态。自动消失（error 8s / 其它
 * 5s）+ 手动关闭；同屏最多 {@link TOAST_MAX_VISIBLE} 条，超出丢弃最旧。
 * 可选 detail 渲染为 `<details>`「技术详情」，原始错误信息永不作主文案。
 */

import { adoptDialogSurfaceTheme, inferDialogThemeHost } from './confirm-dialog.js';
import { translate, type LocaleId } from '../i18n/messages.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

/** 同屏最多可见条数；超出时丢弃最旧的一条。 */
export const TOAST_MAX_VISIBLE = 3;
/** error 类自动消失时长。 */
export const TOAST_ERROR_DISMISS_MS = 8000;
/** 其它 kind 自动消失时长。 */
export const TOAST_DISMISS_MS = 5000;

export interface ToastOptions {
  /** 缺省使用全局 document（应用与 jsdom 测试共用）。 */
  readonly doc?: Document;
  readonly locale?: LocaleId;
  /** 覆盖自动消失时长（测试传 0 立即）。 */
  readonly durationMs?: number;
}

let region: HTMLElement | null = null;
/** toast 元素 → 定时清理句柄；丢弃最旧条目时同步清掉它的计时器。 */
const dismissers = new WeakMap<HTMLElement, () => void>();

function connectedRegion(): HTMLElement | null {
  return region !== null && region.isConnected ? region : null;
}

function ensureRegion(doc: Document): HTMLElement {
  const existing = connectedRegion();
  if (existing !== null) return existing;
  region = null;
  const node = doc.createElement('div');
  node.className = 'lightink-toast-region';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  // 与 open-progress / sync-panel 同一表面主题惯例：跟随书架或阅读器主题。
  const themeHost = inferDialogThemeHost(doc);
  if (themeHost !== null) adoptDialogSurfaceTheme(node, themeHost);
  doc.body.appendChild(node);
  region = node;
  return node;
}

/** Show a non-blocking toast. Raw detail text only appears inside an expandable section. */
export function showToast(
  kind: ToastKind,
  title: string,
  detail?: string,
  options: ToastOptions = {},
): void {
  const doc = options.doc ?? (typeof document === 'undefined' ? null : document);
  if (doc === null || doc.body === null) return;
  const locale = options.locale ?? 'zh-CN';
  const container = ensureRegion(doc);

  const toast = doc.createElement('div');
  toast.className = `lightink-toast lightink-toast--${kind}`;
  toast.dataset.kind = kind;
  const titleNode = doc.createElement('p');
  titleNode.className = 'lightink-toast-title';
  titleNode.textContent = title;
  toast.append(titleNode);
  if (detail !== undefined && detail !== '') {
    const details = doc.createElement('details');
    details.className = 'lightink-toast-detail';
    const summary = doc.createElement('summary');
    summary.textContent = translate(locale, 'toast.details');
    const body = doc.createElement('pre');
    body.textContent = detail;
    details.append(summary, body);
    toast.append(details);
  }
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'lightink-toast-close';
  close.setAttribute('aria-label', translate(locale, 'toast.close'));
  close.textContent = '×';
  toast.append(close);
  container.appendChild(toast);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    toast.remove();
    dismissers.delete(toast);
  };
  timer = setTimeout(
    dismiss,
    options.durationMs ?? (kind === 'error' ? TOAST_ERROR_DISMISS_MS : TOAST_DISMISS_MS),
  );
  dismissers.set(toast, dismiss);
  close.addEventListener('click', dismiss);

  while (container.childElementCount > TOAST_MAX_VISIBLE) {
    const oldest = container.firstElementChild;
    if (oldest === null) break;
    const dismissOldest = dismissers.get(oldest as HTMLElement);
    if (dismissOldest !== undefined) dismissOldest();
    else oldest.remove();
  }
}
