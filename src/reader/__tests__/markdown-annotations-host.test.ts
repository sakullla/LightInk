// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMarkdownAnnotationHost } from '../markdown-annotations.js';

describe('markdown annotation host load', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

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

  it('serializes a bookmark write through the per-identity queue', async () => {
    const writeAnnotations = vi.fn<(contentHash: string, json: string) => Promise<void>>(
      async () => undefined,
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createMarkdownAnnotationHost(host, {
      t: (key) => key,
      getContentHash: async () => 'aaaaaaaaaaaaaaaa',
      readAnnotations: async () => '',
      writeAnnotations,
    });

    view.syncIdentity('/notes/book.md', 'untitled-1');
    await vi.waitFor(() => {
      // 装载空标注不触发写入。
      expect(writeAnnotations).not.toHaveBeenCalled();
    });

    view.addBookmark();
    await vi.waitFor(() => {
      expect(writeAnnotations).toHaveBeenCalledTimes(1);
    });

    const [contentHash, json] = writeAnnotations.mock.calls[0];
    expect(contentHash).toMatch(/^[0-9a-f]{16}$/);
    const payload = JSON.parse(json) as { version: number; annotations: unknown[] };
    expect(payload.version).toBe(2);
    expect(payload.annotations).toHaveLength(1);
    expect((payload.annotations[0] as { kind: string }).kind).toBe('bookmark');

    view.destroy();
  });
});
