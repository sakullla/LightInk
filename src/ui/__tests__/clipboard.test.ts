// @vitest-environment jsdom

/**
 * Shared clipboard write (R5): navigator.clipboard first, hidden-textarea
 * execCommand fallback when the API is missing or rejects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeClipboardText } from '../clipboard.js';

const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand');

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

function setExecCommand(value: unknown): void {
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    writable: true,
    value,
  });
}

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard;
  if (originalExecCommand === undefined) {
    delete (document as { execCommand?: unknown }).execCommand;
  } else {
    Object.defineProperty(document, 'execCommand', originalExecCommand);
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('writeClipboardText', () => {
  it('writes via navigator.clipboard without touching the execCommand fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const execCommand = vi.fn().mockReturnValue(true);
    setExecCommand(execCommand);

    await expect(writeClipboardText('hello clipboard')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello clipboard');
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back to execCommand when writeText rejects, returning its result', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    let copied = '';
    const execCommand = vi.fn((command: string): boolean => {
      expect(command).toBe('copy');
      copied = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    setExecCommand(execCommand);

    await expect(writeClipboardText('fallback text')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('fallback text');
    expect(copied).toBe('fallback text');
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('returns false when the fallback execCommand reports failure', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    setClipboard({ writeText });
    setExecCommand(vi.fn().mockReturnValue(false));

    await expect(writeClipboardText('nope')).resolves.toBe(false);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('returns false without throwing when neither path is available', async () => {
    expect(navigator.clipboard).toBeUndefined();
    delete (document as { execCommand?: unknown }).execCommand;

    await expect(writeClipboardText('nowhere to write')).resolves.toBe(false);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });
});
