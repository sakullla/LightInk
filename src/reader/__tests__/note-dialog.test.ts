// @vitest-environment jsdom

/**
 * `src/reader/note-dialog.ts` (T6 / R21):
 *
 * Ctrl/Cmd+Enter 提交，Enter 留给换行。IME 合成期间 Ctrl/Cmd+Enter 不应
 * 提前提交（中文/日文 IME 在 candidate 阶段会把 Enter 派发为确认键）。
 * 既有「保存 / 取消」按钮文案沿用 annotation.noteDialog.save / .cancel。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { showNoteDialog } from '../note-dialog.js';
import type { MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey): string => key;

const textarea = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>('.lightink-note-textarea')!;

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.lightink-note-dialog');

const dispatchKey = (
  target: EventTarget,
  init: KeyboardEventInit & { isComposing?: boolean },
): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  // jsdom 不会自动从 KeyboardEventInit 派生 isComposing，需要手动赋值以模拟浏览器行为。
  Object.defineProperty(event, 'isComposing', { value: init.isComposing ?? false });
  target.dispatchEvent(event);
  return event;
};

describe('note-dialog IME-safe Ctrl+Enter submit (T6 / R21)', () => {
  afterEach(() => {
    document.querySelectorAll('.lightink-modal-overlay').forEach((el) => el.remove());
  });

  it('Ctrl+Enter 在 compositionstart 之后不提交，dialog 保持开启', async () => {
    const pending = showNoteDialog(document, '', { t });
    const ta = textarea();
    ta.value = '草稿';
    ta.dispatchEvent(new Event('compositionstart'));
    dispatchKey(ta, { key: 'Enter', ctrlKey: true });
    // Promise 不应立即 resolve：仍存在 dialog，文本完整。
    expect(dialog()).not.toBeNull();
    expect(textarea().value).toBe('草稿');
    // compositionend 之后再 Ctrl+Enter 才能提交。
    ta.dispatchEvent(new Event('compositionend'));
    dispatchKey(ta, { key: 'Enter', ctrlKey: true });
    await expect(pending).resolves.toBe('草稿');
    expect(dialog()).toBeNull();
  });

  it('isComposing=true 但 compositionstart 未触发时同样被守卫拦截', async () => {
    const pending = showNoteDialog(document, 'base', { t });
    const ta = textarea();
    dispatchKey(ta, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(dialog()).not.toBeNull();
    expect(textarea().value).toBe('base');
    // 合成结束后正常提交。
    dispatchKey(ta, { key: 'Enter', ctrlKey: true, isComposing: false });
    await expect(pending).resolves.toBe('base');
  });

  it('正常（无 IME）Ctrl+Enter 提交完整文本', async () => {
    const pending = showNoteDialog(document, '', { t });
    const ta = textarea();
    ta.value = '已经写完';
    dispatchKey(ta, { key: 'Enter', ctrlKey: true });
    await expect(pending).resolves.toBe('已经写完');
    expect(dialog()).toBeNull();
  });

  it('Cmd+Enter 在非合成期间同样可提交', async () => {
    const pending = showNoteDialog(document, '', { t });
    textarea().value = 'mac 用户';
    dispatchKey(textarea(), { key: 'Enter', metaKey: true });
    await expect(pending).resolves.toBe('mac 用户');
  });

  it('Enter（不带 Ctrl/Cmd）留给换行，不提交', async () => {
    const pending = showNoteDialog(document, '', { t });
    const ta = textarea();
    ta.value = '第一行';
    dispatchKey(ta, { key: 'Enter' });
    expect(dialog()).not.toBeNull();
    // 解除：手动走取消按钮，确认 Promise 仍可解析为 null。
    document.querySelector<HTMLButtonElement>('.lightink-modal-btn--plain')!.click();
    await expect(pending).resolves.toBeNull();
  });

  it('compositionstart 期间直接按 Enter（不带 Ctrl）也不被守卫阻止换行行为', async () => {
    const pending = showNoteDialog(document, '', { t });
    const ta = textarea();
    ta.dispatchEvent(new Event('compositionstart'));
    dispatchKey(ta, { key: 'Enter' });
    expect(dialog()).not.toBeNull();
    ta.dispatchEvent(new Event('compositionend'));
    document.querySelector<HTMLButtonElement>('.lightink-modal-btn--plain')!.click();
    await expect(pending).resolves.toBeNull();
  });
});
