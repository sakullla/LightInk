import { describe, expect, it, vi } from 'vitest';
import { DocumentClient, type DocumentClientInvoker } from '../document-client.js';
import { SyncRecordClient, type SyncRecordClientInvoker } from '../sync-client.js';
import { WebDavClient, type SyncClientInvoker } from '../webdav-client.js';

describe('SyncRecordClient', () => {
  it('writes field records and requests conflict recovery through IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const client = new SyncRecordClient({ invoke } as SyncRecordClientInvoker);
    await client.writeRecord('book:one', 'progress', { chapter: 3 });
    await client.writeRecord('membership:one', 'group:fiction', undefined, true);
    await client.listConflicts();
    await client.resolveConflict('conflict-1');

    expect(invoke).toHaveBeenCalledWith('sync_write_record', {
      objectId: 'book:one',
      field: 'progress',
      value: { chapter: 3 },
      tombstone: false,
    });
    expect(invoke).toHaveBeenCalledWith('sync_write_record', {
      objectId: 'membership:one',
      field: 'group:fiction',
      value: undefined,
      tombstone: true,
    });
    expect(invoke).toHaveBeenCalledWith('sync_list_conflicts', { includeResolved: false });
    expect(invoke).toHaveBeenCalledWith('sync_resolve_conflict', { conflictId: 'conflict-1' });
  });

  it('exposes one cancellable sync task and on-demand content downloads', async () => {
    const invoke = vi.fn().mockResolvedValue({ state: 'success', uploaded: 1, downloaded: 0, conflicts: 0 });
    const client = new SyncRecordClient({ invoke } as SyncRecordClientInvoker);
    await client.status();
    await client.run();
    await client.cancel();
    await client.downloadBook('managed:abc');
    await client.downloadDraft('draft-1');
    expect(invoke).toHaveBeenCalledWith('sync_status');
    expect(invoke).toHaveBeenCalledWith('sync_run');
    expect(invoke).toHaveBeenCalledWith('sync_cancel');
    expect(invoke).toHaveBeenCalledWith('sync_download_book', { itemId: 'managed:abc' });
    expect(invoke).toHaveBeenCalledWith('sync_download_draft', { draftId: 'draft-1' });
  });
});

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
    expect(invoke).toHaveBeenCalledWith('managed_document_create_version', {
      documentId: 'doc-1',
      content: '# changed',
      deviceId: 'device-1',
    });
    expect(invoke).toHaveBeenCalledWith('managed_document_save_draft', {
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
    expect(invoke).toHaveBeenCalledWith('managed_document_list_drafts');
    expect(invoke).toHaveBeenCalledWith('managed_document_read_draft', { draftId: 'draft-1' });
    expect(invoke).toHaveBeenCalledWith('managed_document_delete_draft', { draftId: 'draft-1' });
  });
});

describe('WebDavClient', () => {
  it('keeps command payloads explicit and delegates profile operations', async () => {
    const invoke = vi.fn();
    invoke.mockResolvedValueOnce(null);
    invoke.mockResolvedValueOnce({ id: 'p1', name: 'Nextcloud' });
    invoke.mockResolvedValueOnce({ reachable: true });
    const client = new WebDavClient({ invoke } as SyncClientInvoker);

    expect(await client.getProfile()).toBeNull();
    await client.saveProfile({ name: 'Nextcloud', url: 'https://dav.example', authType: 'basic' });
    await client.testProfile({ name: 'Nextcloud', url: 'https://dav.example', authType: 'basic' });

    expect(invoke).toHaveBeenCalledWith('sync_get_profile');
    expect(invoke).toHaveBeenCalledWith('sync_save_profile', {
      input: { name: 'Nextcloud', url: 'https://dav.example', authType: 'basic' },
    });
    expect(invoke).toHaveBeenCalledWith('sync_test_profile', {
      input: { name: 'Nextcloud', url: 'https://dav.example', authType: 'basic' },
    });
  });

  it('never invents a local credential cache in the frontend', async () => {
    const invoke = vi.fn().mockResolvedValue({
      credentialRef: 'sync-profile-p1',
      persisted: true,
      needsCredential: false,
    });
    const client = new WebDavClient({ invoke } as SyncClientInvoker);
    await client.storeCredential('p1', { kind: 'bearer', token: 'secret' });
    expect(invoke).toHaveBeenCalledWith('sync_store_credential', {
      profileId: 'p1',
      credential: { kind: 'bearer', token: 'secret' },
    });
  });
});
