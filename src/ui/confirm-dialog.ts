/**
 * `confirm-dialog` — 应用内主题化确认弹层（未保存关闭三选一 / 崩溃恢复）。
 *
 * 取代 tauri-plugin-dialog 的原生 ask/confirm：原生弹窗无主题、且三选一需要
 * 两段串联询问（先「是否保存」再「确认不保存」），体验割裂。本组件一次给出
 * 全部选择，样式走主题令牌（与右键菜单/格式工具条同一浮层语言）。
 *
 * 交互约定（对齐 VS Code）：
 *   - Enter / 默认聚焦 = 第一个 primary 按钮（无 primary 取首个按钮）；
 *   - Esc / 点击遮罩 = cancelId（未指定时取最后一个按钮）；
 *   - 点击任一按钮解析为其 id，Promise 只解析一次。
 *
 * 纯逻辑 `resolveDefaultId` / `resolveCancelId` headless 可测；
 * `showConfirmDialog` 属挂载态 DOM（同 menus.ts，仅断言工厂形态）。
 */

import { labelModal, mountModalFocus } from './modal-focus.js';

const SURFACE_THEME_VARS = [
  '--lightink-bg',
  '--lightink-bg-elevated',
  '--lightink-fg',
  '--lightink-muted',
  '--lightink-border',
  '--lightink-accent',
  '--lightink-accent-soft',
  '--lightink-overlay',
  '--lightink-shadow',
  '--lightink-danger',
] as const;

export function inferDialogThemeHost(doc: Document): HTMLElement | null {
  return (
    doc.querySelector<HTMLElement>('.lightink-library:not([hidden])') ??
    doc.querySelector<HTMLElement>('.lightink-reader:not([hidden])') ??
    doc.querySelector<HTMLElement>('[data-library-theme], [data-reader-theme]')
  );
}

/** Stamp shelf/reader tokens onto a body-mounted overlay (not editor cream/brown). */
export function adoptDialogSurfaceTheme(overlay: HTMLElement, host: HTMLElement): void {
  if (typeof getComputedStyle !== 'function') return;
  const style = getComputedStyle(host);
  for (const name of SURFACE_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== '') overlay.style.setProperty(name, value);
  }
  const libraryTheme = host.dataset.libraryTheme;
  if (libraryTheme !== undefined && libraryTheme !== '') {
    overlay.dataset.libraryTheme = libraryTheme;
  }
  const readerTheme = host.dataset.readerTheme;
  if (readerTheme !== undefined && readerTheme !== '') {
    overlay.dataset.readerTheme = readerTheme;
  }
  if (style.color !== '') overlay.style.color = style.color;
}

export type ConfirmButtonKind = 'primary' | 'danger' | 'plain';

export interface ConfirmButtonSpec {
  /** 解析值（如 'save' / 'discard' / 'cancel'）。 */
  readonly id: string;
  readonly label: string;
  readonly kind?: ConfirmButtonKind;
}

export interface ConfirmDialogSpec {
  readonly title: string;
  /** 支持 \n 换行（white-space: pre-line 渲染）。 */
  readonly message: string;
  readonly buttons: readonly ConfirmButtonSpec[];
  /** Esc / 遮罩点击时解析的按钮 id；缺省取最后一个按钮。 */
  readonly cancelId?: string;
  /** Copy tokens from this host; otherwise infer library/reader surface. */
  readonly themeHost?: HTMLElement | null;
}

/** Enter / 默认聚焦的按钮 id：第一个 primary，否则第一个按钮；无按钮为 null。 */
export function resolveDefaultId(spec: Pick<ConfirmDialogSpec, 'buttons'>): string | null {
  const primary = spec.buttons.find((b) => b.kind === 'primary');
  return (primary ?? spec.buttons[0])?.id ?? null;
}

/** Esc / 遮罩点击时解析的按钮 id：显式 cancelId 优先，否则最后一个按钮。 */
export function resolveCancelId(spec: ConfirmDialogSpec): string | null {
  if (spec.cancelId !== undefined) return spec.cancelId;
  return spec.buttons[spec.buttons.length - 1]?.id ?? null;
}

export interface AlertDialogSpec {
  readonly title: string;
  readonly message: string;
  readonly okLabel: string;
  readonly themeHost?: HTMLElement | null;
}

/** 单按钮提示层，取代 tauri-plugin-dialog 的原生 message。 */
export function showAlertDialog(doc: Document, spec: AlertDialogSpec): Promise<void> {
  return showConfirmDialog(doc, {
    title: spec.title,
    message: spec.message,
    buttons: [{ id: 'ok', label: spec.okLabel, kind: 'primary' }],
    cancelId: 'ok',
    themeHost: spec.themeHost,
  }).then(() => undefined);
}

/** 弹出确认层，resolve 为用户选择的按钮 id（或取消 id）。 */
export function showConfirmDialog(doc: Document, spec: ConfirmDialogSpec): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    let releaseModal = (): void => overlay.remove();
    const settle = (id: string | null): void => {
      if (settled || id === null) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      releaseModal();
      resolve(id);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const themeHost = spec.themeHost ?? inferDialogThemeHost(doc);
    if (themeHost !== null) adoptDialogSurfaceTheme(overlay, themeHost);
    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = spec.title;
    const message = doc.createElement('div');
    message.className = 'lightink-modal-message';
    message.textContent = spec.message;
    labelModal(dialog, title, message);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';
    const defaultId = resolveDefaultId(spec);
    let defaultBtn: HTMLButtonElement | null = null;
    for (const btn of spec.buttons) {
      const el = doc.createElement('button');
      el.type = 'button';
      el.className = `lightink-modal-btn lightink-modal-btn--${btn.kind ?? 'plain'}`;
      el.textContent = btn.label;
      el.addEventListener('click', () => settle(btn.id));
      if (btn.id === defaultId) {
        defaultBtn = el;
      }
      actions.appendChild(el);
    }

    dialog.append(title, message, actions);
    overlay.appendChild(dialog);

    const onKey = (event: KeyboardEvent): void => {
      // Enter 触发默认按钮；焦点已在某按钮上时交还给原生 click。
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        settle(defaultId);
      }
    };
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        settle(resolveCancelId(spec));
      }
    });
    doc.addEventListener('keydown', onKey, true);
    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: defaultBtn,
      onEscape: () => settle(resolveCancelId(spec)),
    });
  });
}
