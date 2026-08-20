/**
 * Synchronizes the portable application state stored by SyncableStorage.
 *
 * Absolute paths, credentials, caches and live tabs never enter this adapter.
 * Each storage key is one independent causal field, so unrelated preferences
 * can merge without clobbering one another.
 */

import {
  isSyncableStorageEntry,
  isSyncableStorageKey,
  type SyncableStorage,
} from '../storage/syncable-storage.js';
import {
  compareVersionPoints,
  type SyncRecord,
  type SyncRecordClient,
  type SyncStatus,
} from './sync-client.js';

export const APP_STATE_OBJECT_ID = 'app-state';

export interface SyncEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface ApplicationStateSyncOptions {
  readonly storage: SyncableStorage;
  readonly records: Pick<SyncRecordClient, 'listRecords' | 'writeRecord' | 'run'>;
  /** Return null when no WebDAV target has been configured. */
  readonly getProfile?: () => Promise<unknown | null>;
  readonly debounceMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly eventTarget?: SyncEventTarget;
  /** Synchronously re-apply UI preferences while storage notifications are suppressed. */
  readonly onStorageApplied?: (records: readonly SyncRecord[]) => void;
  readonly onRecordsApplied?: (records: readonly SyncRecord[]) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
}

type StoredValue = string | null;

function pointCompare(left: SyncRecord, right: SyncRecord): number {
  const order = compareVersionPoints(left.point, right.point);
  if (order === 'dominates') return 1;
  if (order === 'is-dominated') return -1;
  if (order === 'equal') return 0;
  const leftKey = [
    left.point.modifiedAt,
    left.point.deviceId,
    left.point.version,
    left.recordId,
  ];
  const rightKey = [
    right.point.modifiedAt,
    right.point.deviceId,
    right.point.version,
    right.recordId,
  ];
  for (let index = 0; index < leftKey.length; index += 1) {
    const l = leftKey[index]!;
    const r = rightKey[index]!;
    if (l === r) continue;
    return l > r ? 1 : -1;
  }
  return 0;
}

/** Select the deterministic current value for one object/field. */
export function currentSyncRecord(
  records: readonly SyncRecord[],
  objectId: string,
  field: string,
): SyncRecord | null {
  let winner: SyncRecord | null = null;
  for (const record of records) {
    if (record.objectId !== objectId || record.field !== field) continue;
    if (winner === null || pointCompare(record, winner) > 0) winner = record;
  }
  return winner;
}

export function currentSyncRecords(
  records: readonly SyncRecord[],
  objectId: string,
): readonly SyncRecord[] {
  const fields = new Set(
    records.filter((record) => record.objectId === objectId).map((record) => record.field),
  );
  return [...fields]
    .map((field) => currentSyncRecord(records, objectId, field))
    .filter((record): record is SyncRecord => record !== null);
}

function valueOf(record: SyncRecord | null): StoredValue | undefined {
  if (record === null || record.tombstone) return null;
  return typeof record.value === 'string' ? record.value : undefined;
}

export class ApplicationStateSync {
  private readonly options: ApplicationStateSyncOptions;
  private readonly debounceMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly baseline = new Map<string, StoredValue>();
  private readonly dirtyKeys = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<SyncStatus | null> | null = null;
  private started = false;
  private disposed = false;
  private applying = false;
  private retryIndex = 0;
  private readonly onOnline = (): void => {
    this.retryIndex = 0;
    this.schedule(0);
  };

  constructor(options: ApplicationStateSyncOptions) {
    this.options = options;
    this.debounceMs = Math.max(0, options.debounceMs ?? 5000);
    this.retryDelaysMs = (options.retryDelaysMs ?? [5_000, 15_000, 60_000]).map((delay) =>
      Math.max(0, delay),
    );
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.captureBaseline();
    this.options.eventTarget?.addEventListener('online', this.onOnline);
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.options.eventTarget?.removeEventListener?.('online', this.onOnline);
  }

  /** Called by SyncableStorage for every whitelisted local mutation. */
  notifyStorageChange(key: string, _value: string | null): void {
    if (!isSyncableStorageKey(key) || this.disposed || this.applying) return;
    this.dirtyKeys.add(key);
    this.retryIndex = 0;
    this.schedule();
  }

  schedule(delay = this.debounceMs): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow()
        .then((status) => {
          if (status !== null) this.retryIndex = 0;
        })
        .catch((error) => {
          this.options.onError?.(error);
          this.scheduleRetry();
        });
    }, Math.max(0, delay));
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryIndex >= this.retryDelaysMs.length) return;
    const delay = this.retryDelaysMs[this.retryIndex]!;
    this.retryIndex += 1;
    this.schedule(delay);
  }

  syncNow(): Promise<SyncStatus | null> {
    if (this.running !== null) return this.running;
    const task = this.performSync();
    this.running = task;
    const clear = (): void => {
      if (this.running === task) this.running = null;
    };
    void task.then(clear, clear);
    return task;
  }

  private captureBaseline(preserveDirty = false): void {
    const snapshot = this.options.storage.snapshot();
    const keys = new Set([...this.baseline.keys(), ...Object.keys(snapshot)]);
    for (const key of keys) {
      if (!preserveDirty || !this.dirtyKeys.has(key)) {
        this.baseline.set(key, snapshot[key] ?? null);
      }
    }
  }

  private async performSync(): Promise<SyncStatus | null> {
    if (this.options.getProfile !== undefined && (await this.options.getProfile()) === null) {
      return null;
    }
    let records = await this.options.records.listRecords();
    let status: SyncStatus | null = null;

    // A newly linked device has no local app-state history. Pull once before
    // creating records so its defaults cannot race and overwrite established
    // remote preferences. Local edits made during this preflight remain dirty
    // and are published below.
    if (!records.some((record) => record.objectId === APP_STATE_OBJECT_ID)) {
      status = await this.options.records.run();
      records = await this.options.records.listRecords();
    }

    // Apply remote values only when the user has not changed the key since the
    // last completed sync. A local edit wins this preflight and is published as
    // a new causal version below.
    this.applyStorageRecords(records, true);

    const current = this.options.storage.snapshot();
    const keys = new Set([...this.baseline.keys(), ...Object.keys(current)]);
    let wroteLocalRecord = false;
    for (const key of keys) {
      if (!isSyncableStorageKey(key)) continue;
      const value = current[key] ?? null;
      const known = this.baseline.get(key);
      const fieldRecords = records.filter(
        (record) => record.objectId === APP_STATE_OBJECT_ID && record.field === key,
      );
      if (this.dirtyKeys.has(key) || known !== value || fieldRecords.length === 0) {
        await this.options.records.writeRecord(
          APP_STATE_OBJECT_ID,
          key,
          value === null ? undefined : value,
          value === null,
        );
        wroteLocalRecord = true;
        this.baseline.set(key, value);
        // A second local edit may happen while writeRecord is awaiting IPC.
        // Keep it dirty unless the value we just published is still current.
        if (this.options.storage.getItem(key) === value) {
          this.dirtyKeys.delete(key);
        }
      }
    }

    if (status === null || wroteLocalRecord) {
      status = await this.options.records.run();
    }
    records = await this.options.records.listRecords();
    this.applyStorageRecords(records, true);
    this.applying = true;
    try {
      this.options.onStorageApplied?.(records);
    } finally {
      this.applying = false;
    }
    await this.options.onRecordsApplied?.(records);
    this.captureBaseline(true);
    if (this.dirtyKeys.size > 0) this.schedule();
    return status;
  }

  private applyStorageRecords(records: readonly SyncRecord[], onlyIfUnchanged: boolean): void {
    const current = this.options.storage.snapshot();
    for (const record of currentSyncRecords(records, APP_STATE_OBJECT_ID)) {
      if (!isSyncableStorageKey(record.field)) continue;
      const next = valueOf(record);
      if (next === undefined) continue;
      if (
        onlyIfUnchanged &&
        (this.dirtyKeys.has(record.field) ||
          (current[record.field] ?? null) !== (this.baseline.get(record.field) ?? null))
      ) {
        continue;
      }
      if (next !== null && !isSyncableStorageEntry(record.field, next)) continue;
      this.applying = true;
      try {
        if (next === null) this.options.storage.removeItem(record.field);
        else this.options.storage.setItem(record.field, next);
        this.baseline.set(record.field, next);
      } finally {
        this.applying = false;
      }
    }
  }
}
