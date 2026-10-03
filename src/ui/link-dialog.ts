/**
 * `link-dialog` — themed modal for insert/edit hyperlink (title + URL).
 *
 * Replaces window.prompt for link editing so users can set both display text
 * and href, and cancel cleanly. Styles share the existing modal tokens.
 */

import { labelModal, mountModalFocus } from './modal-focus.js';

export interface LinkDialogValues {
  readonly text: string;
  readonly href: string;
}

export interface LinkDialogLabels {
  readonly text?: string;
  readonly textPlaceholder?: string;
  readonly href?: string;
  readonly hrefPlaceholder?: string;
  readonly cancel?: string;
}

export interface LinkDialogSpec {
  readonly title?: string;
  readonly initialText?: string;
  readonly initialHref?: string;
  /** Confirm button label (default OK / 确定). */
  readonly confirmLabel?: string;
  /** Optional localized field / button labels. */
  readonly labels?: LinkDialogLabels;
}

export type LinkDialogResult = LinkDialogValues | null;

function isNonEmpty(value: string): boolean {
  return value.trim() !== '';
}

/**
 * Show a themed link editor. Resolves to `{ text, href }` on confirm, or null
 * on cancel (Esc / overlay / 取消).
 */
export function showLinkDialog(
  doc: Document,
  spec: LinkDialogSpec = {},
): Promise<LinkDialogResult> {
  return new Promise<LinkDialogResult>((resolve) => {
    let settled = false;
    let releaseModal = (): void => overlay.remove();
    const settle = (value: LinkDialogResult): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      releaseModal();
      resolve(value);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';

    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const L = spec.labels ?? {};

    const head = doc.createElement('div');
    head.className = 'lightink-modal-head';
    const heading = doc.createElement('div');
    heading.className = 'lightink-modal-title';
    heading.textContent = spec.title ?? 'Edit link';
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lightink-modal-dismiss';
    dismiss.setAttribute('aria-label', spec.labels?.cancel ?? 'Cancel');
    dismiss.title = spec.labels?.cancel ?? 'Cancel';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => settle(null));
    head.append(heading, dismiss);
    labelModal(dialog, heading);

    const form = doc.createElement('div');
    form.className = 'lightink-link-dialog-form';

    const textField = buildField(doc, {
      id: 'lightink-link-text',
      label: L.text ?? 'Display text',
      placeholder: L.textPlaceholder ?? 'Link title',
      value: spec.initialText ?? '',
    });
    const hrefField = buildField(doc, {
      id: 'lightink-link-href',
      label: L.href ?? 'URL',
      placeholder: L.hrefPlaceholder ?? 'https://… or relative/path.md',
      value: spec.initialHref ?? '',
    });
    form.append(textField.wrap, hrefField.wrap);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancelBtn.textContent = L.cancel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => settle(null));

    const okBtn = doc.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'lightink-modal-btn lightink-modal-btn--primary';
    okBtn.textContent = spec.confirmLabel ?? 'OK';
    okBtn.addEventListener('click', () => {
      const href = hrefField.input.value.trim();
      if (!isNonEmpty(href)) {
        hrefField.input.focus();
        hrefField.wrap.classList.add('is-invalid');
        return;
      }
      const text = textField.input.value.trim() || href;
      settle({ text, href });
    });

    actions.append(cancelBtn, okBtn);
    dialog.append(head, form, actions);
    overlay.appendChild(dialog);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        // Confirm from either field.
        if (
          event.target === textField.input ||
          event.target === hrefField.input ||
          event.target === okBtn
        ) {
          event.preventDefault();
          okBtn.click();
        }
      }
    };

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        settle(null);
      }
    });
    hrefField.input.addEventListener('input', () => {
      hrefField.wrap.classList.remove('is-invalid');
    });

    doc.addEventListener('keydown', onKey, true);
    const initialText = (spec.initialText ?? '').trim();
    const initialFocus = initialText === '' ? textField.input : hrefField.input;
    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus,
      onEscape: () => settle(null),
    });
    initialFocus.select();
  });
}

export interface OpenLinkConfirmLabels {
  readonly title?: string;
  readonly message?: string;
  readonly openLabel?: string;
  readonly cancelLabel?: string;
}

/**
 * Confirm opening a link (Ctrl+click path). Returns true when user confirms.
 */
export function showOpenLinkConfirm(
  doc: Document,
  href: string,
  labels: OpenLinkConfirmLabels = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let releaseModal = (): void => overlay.remove();
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      releaseModal();
      resolve(ok);
    };

    const overlay = doc.createElement('div');
    overlay.className = 'lightink-modal-overlay';
    const dialog = doc.createElement('div');
    dialog.className = 'lightink-modal-dialog lightink-link-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const head = doc.createElement('div');
    head.className = 'lightink-modal-head';
    const title = doc.createElement('div');
    title.className = 'lightink-modal-title';
    title.textContent = labels.title ?? 'Open Link';
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lightink-modal-dismiss';
    dismiss.setAttribute('aria-label', labels.cancelLabel ?? 'Cancel');
    dismiss.title = labels.cancelLabel ?? 'Cancel';
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => settle(false));
    head.append(title, dismiss);

    const message = doc.createElement('div');
    message.className = 'lightink-modal-message';
    message.textContent = labels.message ?? 'Open the following link?';
    labelModal(dialog, title, message);

    const target = doc.createElement('div');
    target.className = 'lightink-link-dialog-target';
    target.textContent = href;
    target.setAttribute('title', href);

    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';

    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancelBtn.textContent = labels.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => settle(false));

    const okBtn = doc.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'lightink-modal-btn lightink-modal-btn--primary';
    okBtn.textContent = labels.openLabel ?? 'Open';
    okBtn.addEventListener('click', () => settle(true));

    actions.append(cancelBtn, okBtn);
    dialog.append(head, message, target, actions);
    overlay.appendChild(dialog);

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        settle(true);
      }
    };
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) settle(false);
    });
    doc.addEventListener('keydown', onKey, true);
    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: okBtn,
      onEscape: () => settle(false),
    });
  });
}

interface FieldParts {
  wrap: HTMLDivElement;
  input: HTMLInputElement;
}

function buildField(
  doc: Document,
  opts: { id: string; label: string; placeholder: string; value: string },
): FieldParts {
  const wrap = doc.createElement('div');
  wrap.className = 'lightink-link-dialog-field';

  const label = doc.createElement('label');
  label.className = 'lightink-link-dialog-label';
  label.htmlFor = opts.id;
  label.textContent = opts.label;

  const input = doc.createElement('input');
  input.type = 'text';
  input.id = opts.id;
  input.className = 'lightink-link-dialog-input';
  input.placeholder = opts.placeholder;
  input.value = opts.value;
  input.autocomplete = 'off';
  input.spellcheck = false;

  wrap.append(label, input);
  return { wrap, input };
}
