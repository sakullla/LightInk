/**
 * `note-dialog` — 阅读器笔记写作弹层。
 *
 * 划选原文预览 + 多行备注 + 保存/取消。resolve 为文本（允许空串）或 null
 * （取消 / Esc / 遮罩 / 关闭）。Ctrl/Cmd+Enter 提交，Enter 留给换行。
 * 焦点陷阱复用 modal-focus；版式独立于确认弹层。
 */

import { labelModal, mountModalFocus } from '../ui/modal-focus.js';
import { adoptReaderOverlayTheme } from './reader-chrome-panels.js';
import type { MessageKey } from '../i18n/messages.js';

export interface NoteDialogDeps {
  t: (key: MessageKey) => string;
  /** 编辑已有备注时用「编辑笔记」标题。 */
  editing?: boolean;
}

/**
 * 弹出笔记输入层。resolve 为用户输入文本；取消时 resolve null。
 */
export function showNoteDialog(
  doc: Document,
  initialText: string,
  deps: NoteDialogDeps,
  quote?: string,
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
    dialog.className = 'lightink-modal-dialog lightink-note-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    const header = doc.createElement('div');
    header.className = 'lightink-note-header';
    const title = doc.createElement('div');
    title.className = 'lightink-modal-title lightink-note-title';
    title.textContent = deps.t(
      deps.editing === true ? 'annotation.noteDialog.editTitle' : 'annotation.noteDialog.title',
    );
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'lightink-note-close';
    close.textContent = '×';
    close.setAttribute('aria-label', deps.t('annotation.noteDialog.cancel'));
    close.addEventListener('click', () => settle(null));
    header.append(title, close);

    const body = doc.createElement('div');
    body.className = 'lightink-note-body';

    const quoteText = quote?.trim() ?? '';
    if (quoteText !== '') {
      const quoteField = doc.createElement('div');
      quoteField.className = 'lightink-note-field';
      const quoteLabel = doc.createElement('div');
      quoteLabel.className = 'lightink-note-label';
      quoteLabel.textContent = deps.t('annotation.noteDialog.quoteLabel');
      const preview = doc.createElement('blockquote');
      preview.className = 'lightink-note-quote';
      preview.textContent = quoteText;
      quoteField.append(quoteLabel, preview);
      body.appendChild(quoteField);
    }

    const noteField = doc.createElement('div');
    noteField.className = 'lightink-note-field';
    const noteLabel = doc.createElement('label');
    noteLabel.className = 'lightink-note-label';
    noteLabel.htmlFor = 'lightink-note-textarea';
    noteLabel.textContent = deps.t('annotation.noteDialog.noteLabel');
    const textarea = doc.createElement('textarea');
    textarea.id = 'lightink-note-textarea';
    textarea.className = 'lightink-note-textarea';
    textarea.value = initialText;
    textarea.rows = 6;
    textarea.placeholder = deps.t('annotation.noteDialog.placeholder');
    textarea.setAttribute('spellcheck', 'true');
    noteField.append(noteLabel, textarea);
    body.appendChild(noteField);
    labelModal(dialog, title, textarea);

    const footer = doc.createElement('div');
    footer.className = 'lightink-note-footer';
    const hint = doc.createElement('span');
    hint.className = 'lightink-note-hint';
    const mac =
      typeof navigator !== 'undefined' && /Mac/i.test(`${navigator.platform} ${navigator.userAgent}`);
    hint.textContent = deps.t(
      mac ? 'annotation.noteDialog.shortcutMac' : 'annotation.noteDialog.shortcut',
    );
    const actions = doc.createElement('div');
    actions.className = 'lightink-modal-actions';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'lightink-modal-btn lightink-modal-btn--plain';
    cancel.textContent = deps.t('annotation.noteDialog.cancel');
    cancel.addEventListener('click', () => settle(null));
    const save = doc.createElement('button');
    save.type = 'button';
    save.className = 'lightink-modal-btn lightink-modal-btn--primary';
    save.textContent = deps.t('annotation.noteDialog.save');
    save.addEventListener('click', () => settle(textarea.value));
    actions.append(cancel, save);
    footer.append(hint, actions);

    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    const readerHost = doc.querySelector<HTMLElement>('.lightink-reader');
    if (readerHost !== null) {
      adoptReaderOverlayTheme(overlay, readerHost);
    }

    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        settle(textarea.value);
      }
    });
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) {
        settle(null);
      }
    });
    releaseModal = mountModalFocus(doc, overlay, dialog, {
      initialFocus: textarea,
      onEscape: () => settle(null),
    });
  });
}
