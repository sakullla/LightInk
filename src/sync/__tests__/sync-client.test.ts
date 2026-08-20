import { describe, expect, it, vi } from 'vitest';
import { SyncRecordClient, type SyncRecordClientInvoker } from '../sync-client.js';

describe('SyncRecordClient', () => {
  it('writes field records and requests conflict recovery through IPC', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const client = new SyncRecordClient({ invoke } as SyncRecordClientInvoker);
    await client.writeRecord('book:one', 'progress', { chapter: 3 });
    await client.writeRecord('membership:one', 'group:fiction', undefined, true);
    await client.listConflicts();
    await client.resolveConflict('conflict-1');

    expect(invoke).toHaveBeenNthCalledWith(1, 'sync_write_record', {
      objectId: 'book:one',
      field: 'progress',
      value: { chapter: 3 },
      tombstone: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'sync_write_record', {
      objectId: 'membership:one',
      field: 'group:fiction',
      value: undefined,
      tombstone: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'sync_list_conflicts', { includeResolved: false });
    expect(invoke).toHaveBeenNthCalledWith(4, 'sync_resolve_conflict', { conflictId: 'conflict-1' });
  });

  it('exposes one cancellable sync task and on-demand content downloads', async () => {
    const invoke = vi.fn().mockResolvedValue({ state: 'success', uploaded: 1, downloaded: 0, conflicts: 0 });
    const client = new SyncRecordClient({ invoke } as SyncRecordClientInvoker);
    await client.status();
    await client.run();
    await client.cancel();
    await client.downloadBook('managed:abc');
    await client.downloadDraft('draft-1');
    expect(invoke).toHaveBeenNthCalledWith(1, 'sync_status');
    expect(invoke).toHaveBeenNthCalledWith(2, 'sync_run');
    expect(invoke).toHaveBeenNthCalledWith(3, 'sync_cancel');
    expect(invoke).toHaveBeenNthCalledWith(4, 'sync_download_book', { itemId: 'managed:abc' });
    expect(invoke).toHaveBeenNthCalledWith(5, 'sync_download_draft', { draftId: 'draft-1' });
  });
});
