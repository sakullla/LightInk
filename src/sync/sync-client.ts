import { invoke } from '@tauri-apps/api/core';

export interface VersionPoint {
  readonly deviceId: string;
  readonly version: number;
  readonly context: Readonly<Record<string, number>>;
  readonly modifiedAt: number;
}

export interface SyncRecord {
  readonly recordId: string;
  readonly objectId: string;
  readonly field: string;
  readonly value?: unknown;
  readonly point: VersionPoint;
  readonly tombstone: boolean;
}

export type CausalOrder = 'equal' | 'dominates' | 'is-dominated' | 'concurrent';

function counterFor(point: VersionPoint, deviceId: string): number {
  return point.deviceId === deviceId ? point.version : point.context[deviceId] ?? 0;
}

/** Compare dotted version vectors using the same rules as the Rust merger. */
export function compareVersionPoints(left: VersionPoint, right: VersionPoint): CausalOrder {
  const devices = new Set([
    left.deviceId,
    right.deviceId,
    ...Object.keys(left.context),
    ...Object.keys(right.context),
  ]);
  let leftGreater = false;
  let rightGreater = false;
  for (const device of devices) {
    const l = counterFor(left, device);
    const r = counterFor(right, device);
    if (l > r) leftGreater = true;
    if (l < r) rightGreater = true;
  }
  if (!leftGreater && !rightGreater) return 'equal';
  if (leftGreater && !rightGreater) return 'dominates';
  if (!leftGreater && rightGreater) return 'is-dominated';
  return 'concurrent';
}

export interface SyncConflict {
  readonly id: string;
  readonly objectId: string;
  readonly field: string;
  readonly winner?: unknown;
  readonly loser?: unknown;
  readonly winnerDeviceId: string;
  readonly loserDeviceId: string;
  readonly createdAt: number;
  readonly resolvedAt?: number;
}

export type SyncRunState = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

export interface SyncStatus {
  readonly state: SyncRunState;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly lastError?: string;
  readonly uploaded: number;
  readonly downloaded: number;
  readonly conflicts: number;
}

export interface SyncRecordClientInvoker {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const nativeInvoker: SyncRecordClientInvoker = { invoke };

/** Typed boundary for record-level sync writes and conflict recovery. */
export class SyncRecordClient {
  private readonly invoker: SyncRecordClientInvoker;

  constructor(invoker: SyncRecordClientInvoker = nativeInvoker) {
    this.invoker = invoker;
  }

  deviceId(): Promise<string> {
    return this.invoker.invoke<string>('sync_device_id');
  }

  listRecords(): Promise<SyncRecord[]> {
    return this.invoker.invoke<SyncRecord[]>('sync_list_records');
  }

  writeRecord(
    objectId: string,
    field: string,
    value?: unknown,
    tombstone = false,
  ): Promise<SyncRecord> {
    return this.invoker.invoke<SyncRecord>('sync_write_record', {
      objectId,
      field,
      value,
      tombstone,
    });
  }

  listConflicts(includeResolved = false): Promise<SyncConflict[]> {
    return this.invoker.invoke<SyncConflict[]>('sync_list_conflicts', { includeResolved });
  }

  resolveConflict(conflictId: string): Promise<void> {
    return this.invoker.invoke<void>('sync_resolve_conflict', { conflictId });
  }

  status(): Promise<SyncStatus> {
    return this.invoker.invoke<SyncStatus>('sync_status');
  }

  run(): Promise<SyncStatus> {
    return this.invoker.invoke<SyncStatus>('sync_run');
  }

  cancel(): Promise<void> {
    return this.invoker.invoke<void>('sync_cancel');
  }

  downloadBook(itemId: string): Promise<string> {
    return this.invoker.invoke<string>('sync_download_book', { itemId });
  }

  downloadDocument(documentId: string): Promise<string> {
    return this.invoker.invoke<string>('sync_download_document', { documentId });
  }

  downloadDraft(draftId: string): Promise<string> {
    return this.invoker.invoke<string>('sync_download_draft', { draftId });
  }
}

export const syncRecordClient = new SyncRecordClient();
