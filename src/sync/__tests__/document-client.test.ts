import { describe, expect, it, vi } from 'vitest';
import { DocumentClient, type DocumentClientInvoker } from '../document-client.js';

describe('DocumentClient', () => {
  it('joins a Markdown document without moving the source path', async () => {
    const invoke = vi.fn(async () => ({
      document: { id: 'doc-1' },
      managedPath: '/app/managed/doc-1/document.md',
      content: '# note',
      copiedAssets: [],
      warnings: [],
    }));
    const client = new DocumentClient({ invoke } as DocumentClientInvoker);
    await client.join('/notes/note.md');
    expect(invoke).toHaveBeenCalledWith('managed_document_join', { path: '/notes/note.md' });
  });

  it('keeps version and draft commands explicit', async () => {
    const invoke = vi.fn(async () => ({}));
    const client = new DocumentClient({ invoke } as DocumentClientInvoker);
    await client.createVersion('doc-1', '# changed', 'device-1');
    await client.saveDraft(undefined, 'Untitled', 'device-1', '# draft', 'draft-1');
    expect(invoke).toHaveBeenNthCalledWith(1, 'managed_document_create_version', {
      documentId: 'doc-1',
      content: '# changed',
      deviceId: 'device-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'managed_document_save_draft', {
      draftId: 'draft-1',
      documentId: undefined,
      title: 'Untitled',
      deviceId: 'device-1',
      content: '# draft',
    });
  });

  it('lists, reads and deletes managed drafts', async () => {
    const invoke = vi.fn(async () => []);
    const client = new DocumentClient({ invoke } as DocumentClientInvoker);
    await client.listDrafts();
    await client.readDraft('draft-1');
    await client.deleteDraft('draft-1');
    expect(invoke).toHaveBeenNthCalledWith(1, 'managed_document_list_drafts');
    expect(invoke).toHaveBeenNthCalledWith(2, 'managed_document_read_draft', { draftId: 'draft-1' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'managed_document_delete_draft', { draftId: 'draft-1' });
  });
});
