import { describe, expect, it, vi } from 'vitest';
import { createSyncableStorage } from '../../storage/syncable-storage.js';
import {
  APP_STATE_OBJECT_ID,
  ApplicationStateSync,
  currentSyncRecord,
} from '../app-state-sync.js';
import type { SyncRecord, SyncStatus } from '../sync-client.js';

function makeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const base = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  return { values, storage: createSyncableStorage(base) };
}

function record(
  value: string | undefined,
  version: number,
  deviceId = 'device-a',
  tombstone = false,
  field = 'lightink.theme',
): SyncRecord {
  return {
    recordId: `${deviceId}-${version}`,
    objectId: APP_STATE_OBJECT_ID,
    field,
    value,
    point: { deviceId, version, context: {}, modifiedAt: version },
    tombstone,
  };
}

function fakeRecords(initial: SyncRecord[] = []) {
  const records = [...initial];
  const status: SyncStatus = {
    state: 'success',
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
  };
  return {
    records,
    client: {
      listRecords: async () => records,
      writeRecord: async (_objectId: string, field: string, value?: unknown, tombstone = false) => {
        const next = record(
          typeof value === 'string' ? value : undefined,
          records.length + 1,
          'device-a',
          tombstone,
          field,
        );
        records.push(next);
        return next;
      },
      run: async () => status,
    },
  };
}

describe('ApplicationStateSync', () => {
  it('publishes whitelisted local values and applies the merged result', async () => {
    const { values, storage } = makeStorage({ 'lightink.theme': 'dark' });
    const fake = fakeRecords();
    const coordinator = new ApplicationStateSync({ storage, records: fake.client });
    coordinator.start();
    coordinator.dispose();
    await coordinator.syncNow();
    expect(values.get('lightink.theme')).toBe('dark');
    expect(fake.records.some((item) => item.field === 'lightink.theme')).toBe(true);
  });

  it('chooses a causal remote value without touching non-syncable keys', async () => {
    const { values, storage } = makeStorage({
      'lightink.theme': 'dark',
      'lightink.secret': 'keep-local',
    });
    const fake = fakeRecords([record('warm-light', 2, 'device-b')]);
    const coordinator = new ApplicationStateSync({ storage, records: fake.client });
    coordinator.start();
    coordinator.dispose();
    await coordinator.syncNow();
    expect(values.get('lightink.theme')).toBe('warm-light');
    expect(values.get('lightink.secret')).toBe('keep-local');
  });

  it('applies a remote value when the key never existed on this device', async () => {
    const { values, storage } = makeStorage();
    const fake = fakeRecords([record('zh-CN', 2, 'device-b', false, 'lightink.locale')]);
    const coordinator = new ApplicationStateSync({ storage, records: fake.client });
    coordinator.start();
    coordinator.dispose();
    await coordinator.syncNow();

    expect(values.get('lightink.locale')).toBe('zh-CN');
  });

  it('pulls established preferences before publishing a new device default', async () => {
    const { values, storage } = makeStorage({ 'lightink.theme': 'dark' });
    const records: SyncRecord[] = [];
    const writeRecord = vi.fn(async () => record('dark', 3));
    const run = vi.fn(async () => {
      records.push(record('warm-light', 2, 'device-b'));
      return { state: 'success' as const, uploaded: 0, downloaded: 1, conflicts: 0 };
    });
    const coordinator = new ApplicationStateSync({
      storage,
      records: {
        listRecords: async () => records,
        writeRecord,
        run,
      },
    });
    coordinator.start();
    coordinator.dispose();
    await coordinator.syncNow();

    expect(values.get('lightink.theme')).toBe('warm-light');
    expect(writeRecord).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('selects tombstones as the current field value', () => {
    expect(currentSyncRecord([record('dark', 1), record(undefined, 2, 'device-a', true)], APP_STATE_OBJECT_ID, 'lightink.theme')?.tombstone).toBe(true);
  });

  it('publishes a local edit made while a sync is running on the next pass', async () => {
    const { storage } = makeStorage({ 'lightink.theme': 'dark' });
    let releaseRun: (() => void) | undefined;
    let runs = 0;
    const writes: Array<string | undefined> = [];
    const fake = fakeRecords([record('dark', 1)]);
    const coordinator = new ApplicationStateSync({
      storage,
      records: {
        ...fake.client,
        writeRecord: async (objectId, field, value, tombstone) => {
          writes.push(typeof value === 'string' ? value : undefined);
          return fake.client.writeRecord(objectId, field, value, tombstone);
        },
        run: async () => {
          runs += 1;
          if (runs === 1) {
            await new Promise<void>((resolve) => {
              releaseRun = resolve;
            });
          }
          return { state: 'success', uploaded: 0, downloaded: 0, conflicts: 0 };
        },
      },
      debounceMs: 60_000,
    });
    coordinator.start();
    coordinator.notifyStorageChange('lightink.theme', 'dark');
    const first = coordinator.syncNow();
    await vi.waitFor(() => expect(releaseRun).toBeTypeOf('function'));
    storage.setItem('lightink.theme', 'warm-light');
    coordinator.notifyStorageChange('lightink.theme', 'warm-light');
    releaseRun!();
    await first;
    await coordinator.syncNow();
    coordinator.dispose();

    expect(writes).toEqual(['dark', 'warm-light']);
  });

  it('retries automatic failures with a finite backoff', async () => {
    vi.useFakeTimers();
    try {
      const { storage } = makeStorage({ 'lightink.theme': 'dark' });
      const run = vi.fn(async () => {
        throw new Error('offline');
      });
      const onError = vi.fn();
      const coordinator = new ApplicationStateSync({
        storage,
        records: {
          listRecords: async () => [],
          writeRecord: async () => record('dark', 1),
          run,
        },
        retryDelaysMs: [10, 20],
        onError,
      });
      coordinator.start();
      await vi.runAllTimersAsync();
      expect(run).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(3);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
