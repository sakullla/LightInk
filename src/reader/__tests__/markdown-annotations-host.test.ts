// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createMarkdownAnnotationHost } from '../markdown-annotations.js';

describe('markdown annotation host load', () => {
  it('treats a failed annotation read as empty and does not notify', async () => {
    const notify = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createMarkdownAnnotationHost(host, {
      t: (key) => key,
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => {
        throw new Error('IPC unavailable');
      },
      writeAnnotations: async () => undefined,
      notify,
    });

    view.syncIdentity(null, 'untitled-1');
    await vi.waitFor(() => {
      expect(notify).not.toHaveBeenCalled();
    });
    expect(view.isAnnotationEnabled()).toBe(true);
    view.destroy();
  });
});
