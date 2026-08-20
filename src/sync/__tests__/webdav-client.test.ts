import { describe, expect, it, vi } from 'vitest';
import { WebDavClient, type SyncClientInvoker } from '../webdav-client.js';

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

    expect(invoke).toHaveBeenNthCalledWith(1, 'sync_get_profile');
    expect(invoke).toHaveBeenNthCalledWith(2, 'sync_save_profile', {
      input: { name: 'Nextcloud', url: 'https://dav.example', authType: 'basic' },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'sync_test_profile', {
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
