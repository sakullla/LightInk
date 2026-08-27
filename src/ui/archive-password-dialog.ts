import type { MessageKey } from '../i18n/messages.js';
import { labelModal, mountModalFocus } from './modal-focus.js';

function isTouchPrimary(doc: Document): boolean {
  const root = doc.documentElement;
  return root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary');
}

/** Consume --lightink-keyboard-inset (written by safe-area.ts). Inset 0 keeps the layer closable. */
function applyArchivePasswordKeyboardInset(
  overlay: HTMLElement,
  dialog: HTMLElement,
  input: HTMLInputElement,
  actions: HTMLElement,
): void {
  overlay.style.paddingBottom = 'var(--lightink-keyboard-inset, 0px)';
  dialog.style.maxHeight = 'calc(100dvh - 24px - var(--lightink-keyboard-inset, 0px))';
  if (!isTouchPrimary(overlay.ownerDocument)) return;
  dialog.style.boxSizing = 'border-box';
  dialog.style.width = 'calc(100vw - 24px)';
  dialog.style.maxWidth = 'calc(100vw - 24px)';
  dialog.style.overflowY = 'auto';
  dialog.style.padding = '14px 12px 10px';
  dialog.style.borderRadius = '16px';
  dialog.style.fontFamily = 'var(--lightink-font-ui)';
  dialog.style.fontSize = 'var(--lightink-type-ui)';
  input.style.minHeight = '44px';
  input.style.fontSize = 'var(--lightink-type-body)';
  actions.style.position = 'sticky';
  actions.style.bottom = '0';
  actions.style.zIndex = '1';
  actions.style.paddingTop = '8px';
  actions.style.background = 'var(--lightink-bg-elevated)';
  for (const button of actions.querySelectorAll('button')) {
    button.style.minHeight = '44px';
  }
}

export interface ArchivePasswordDialogSpec {
  readonly displayName: string;
  readonly retry: boolean;
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
}

/** Request an archive password without writing it to persistent browser state. */
export function showArchivePasswordDialog(
  doc: Document,
  spec: ArchivePasswordDialogSpec,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let releaseModal = (): void => overlay.remove();
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      releaseModal();
      resolve(value);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';

    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = spec.t('reader.archivePassword.title');

    const message = doc.createElement('div');
    message.className = 'lightink-modal-message';
    message.textContent = spec.t(
      spec.retry
        ? 'reader.archivePassword.incorrect'
        : 'reader.archivePassword.message',
      { name: spec.displayName },
    );
    labelModal(dialog, title, message);

    const form = doc.createElement('form');
    form.className = 'lightink-link-dialog-form';
    const label = doc.createElement('label');
    label.className = 'lightink-link-dialog-label';
    label.htmlFor = 'lightink-archive-password';
    label.textContent = spec.t('reader.archivePassword.label');
    const input = doc.createElement('input');
    input.id = 'lightink-archive-password';
    input.className = 'lightink-link-dialog-input';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    form.appendChild(label);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancel.textContent = spec.t('dialog.cancel');
    cancel.addEventListener('click', () => settle(null));
    const confirm = doc.createElement('button');
    confirm.type = 'submit';
    confirm.className = 'lightink-modal-btn lightink-modal-btn--primary';
    confirm.textContent = spec.t('dialog.open');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (input.value === '') {
        input.focus();
        return;
      }
      settle(input.value);
    });
    actions.append(cancel, confirm);
    dialog.append(title, message, form, actions);
    overlay.appendChild(dialog);
    applyArchivePasswordKeyboardInset(overlay, dialog, input, actions);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) settle(null);
    });

    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: input,
      onEscape: () => settle(null),
    });
  });
}
