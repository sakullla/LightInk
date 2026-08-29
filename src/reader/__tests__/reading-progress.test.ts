import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chapterScrollRatio,
  chapterScrollTop,
  loadReadingProgress,
  loadReadingProgressFromIds,
  parseReadingProgress,
  readingProgressKey,
  saveReadingProgress,
  type ProgressStorage,
  type ReadingProgress,
} from '../reading-progress.js';
import { saveLibraryProgressAlias } from '../../library/library-progress.js';
import { normalizeReaderTarget, readerIdentityKey, type ReaderTarget } from '../sources/types.js';
import {
  comicProgressIdForTarget,
  comicProgressRestoreIds,
  createReaderSessionProgress,
  documentProgressId,
  documentProgressRestoreIds,
  FLOW_RESTORE_MAX_ATTEMPTS,
  PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS,
  PAGED_FRAME_RESTORE_MAX_ATTEMPTS,
  PROGRESS_SAVE_DEBOUNCE_MS,
  READING_IDLE_PAUSE_MS,
  type SessionProgressApplyResult,
  type SessionProgressFeed,
} from '../session/session-progress.js';

describe('parseReadingProgress', () => {
  it('accepts a v2 flow or page snapshot', () => {
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 2, ratio: 0.4, updatedAt: 10 }),
      ),
    ).toEqual({ version: 2, kind: 'flow', index: 2, ratio: 0.4, updatedAt: 10 });
    expect(
      parseReadingProgress(JSON.stringify({ version: 2, kind: 'page', index: 7, ratio: 0 })),
    ).toMatchObject({ kind: 'page', index: 7, ratio: 0 });
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 3, ratio: 0.2, total: 12, updatedAt: 1 }),
      ),
    ).toMatchObject({ index: 3, total: 12 });
  });

  it('round-trips a v2 record with status and readingMs', () => {
    const record: ReadingProgress = {
      version: 2,
      kind: 'page',
      index: 40,
      ratio: 0,
      total: 40,
      updatedAt: 123,
      status: 'finished',
      readingMs: 3_600_000,
    };
    expect(parseReadingProgress(JSON.stringify(record))).toEqual(record);
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0.5, updatedAt: 1, readingMs: 0 }),
      ),
    ).toMatchObject({ readingMs: 0 });
  });

  it('returns null for v1, unknown versions and corrupt records', () => {
    expect(parseReadingProgress('')).toBeNull();
    expect(parseReadingProgress('{')).toBeNull();
    // R6：v1 记录安静置空，无迁移。
    expect(
      parseReadingProgress(JSON.stringify({ version: 1, kind: 'flow', index: 1, ratio: 0 })),
    ).toBeNull();
    expect(
      parseReadingProgress(JSON.stringify({ version: 3, kind: 'flow', index: 1, ratio: 0 })),
    ).toBeNull();
    expect(parseReadingProgress(JSON.stringify({ version: 2, kind: 'flow', index: -1, ratio: 0 }))).toBeNull();
  });

  it('rejects illegal status and readingMs values', () => {
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0, status: 'reading' }),
      ),
    ).toBeNull();
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0, readingMs: -5 }),
      ),
    ).toBeNull();
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0, readingMs: '5m' }),
      ),
    ).toBeNull();
  });

  it('keeps a usable heading and drops converter junk or empty titles', () => {
    expect(
      parseReadingProgress(
        JSON.stringify({
          version: 2,
          kind: 'flow',
          index: 1996,
          ratio: 0.2,
          title: '第1997章 浓浓的火药味',
          updatedAt: 1,
        }),
      ),
    ).toMatchObject({ title: '第1997章 浓浓的火药味' });
    expect(
      parseReadingProgress(
        JSON.stringify({
          version: 2,
          kind: 'flow',
          index: 1,
          ratio: 0,
          title: 'ccdqxkhp',
          updatedAt: 1,
        }),
      ),
    ).not.toHaveProperty('title');
    expect(
      parseReadingProgress(
        JSON.stringify({ version: 2, kind: 'flow', index: 1, ratio: 0, title: '  ', updatedAt: 1 }),
      ),
    ).not.toHaveProperty('title');
  });
});

describe('load/saveReadingProgress', () => {
  it('round-trips by content hash and ignores storage failures', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    };
    saveReadingProgress(storage, '0123456789abcdef', {
      version: 2,
      kind: 'flow',
      index: 3,
      ratio: 0.25,
      updatedAt: 1,
    });
    expect(store[readingProgressKey('0123456789abcdef')]).toContain('"index":3');
    expect(loadReadingProgress(storage, '0123456789abcdef')?.index).toBe(3);

    expect(chapterScrollRatio(250, 100, 400)).toBe(0.375);
    expect(chapterScrollTop(100, 400, 0.375)).toBe(250);
    expect(loadReadingProgressFromIds(storage, ['missing', '0123456789abcdef'])?.index).toBe(3);
    expect(loadReadingProgressFromIds(storage, ['', 'missing'])).toBeNull();
    expect(loadReadingProgress(storage, '')).toBeNull();
    expect(
      loadReadingProgress(
        {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => undefined,
        },
        '0123456789abcdef',
      ),
    ).toBeNull();
  });
});

// —— session-progress 核心（身份链/保存时机/恢复重试阈值单点）——
// 视图侧 feed/host 全部注入：规则断言不依赖 DOM。

interface FeedHarness {
  readonly feed: SessionProgressFeed;
  readonly calls: Array<{ saved: ReadingProgress; attempts: number }>;
  snapshotValue: ReadingProgress | null;
}

function createFeedHarness(
  applyImpl?: (saved: ReadingProgress, attempts: number) => SessionProgressApplyResult,
): FeedHarness {
  const calls: Array<{ saved: ReadingProgress; attempts: number }> = [];
  const state = { snapshotValue: null as ReadingProgress | null };
  const feed: SessionProgressFeed = {
    snapshot: () => state.snapshotValue,
    apply: (saved, context) => {
      calls.push({ saved, attempts: context.attempts });
      if (applyImpl === undefined) {
        return { applied: true };
      }
      return applyImpl(saved, context.attempts);
    },
  };
  return {
    feed,
    calls,
    get snapshotValue() {
      return state.snapshotValue;
    },
    set snapshotValue(value: ReadingProgress | null) {
      state.snapshotValue = value;
    },
  };
}

function trackedStorage(initial: Record<string, string> = {}): {
  storage: ProgressStorage;
  values: Record<string, string>;
  writes: Array<[string, string]>;
} {
  const values: Record<string, string> = { ...initial };
  const writes: Array<[string, string]> = [];
  return {
    values,
    writes,
    storage: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
        writes.push([key, value]);
      },
    },
  };
}

interface ProgressHarness {
  readonly store: ReturnType<typeof trackedStorage>;
  readonly flow: FeedHarness;
  readonly paged: FeedHarness;
  readonly flags: {
    activeKind: 'flow' | 'paged';
    canPersist: boolean;
    canRestore: boolean;
    destroyed: boolean;
  };
  readonly bound: ReturnType<typeof vi.fn>;
  readonly progress: ReturnType<typeof createReaderSessionProgress>;
}

function createProgressHarness(
  options?: {
    flowApply?: (saved: ReadingProgress, attempts: number) => SessionProgressApplyResult;
    onProgressBoundThrows?: boolean;
  },
): ProgressHarness {
  const store = trackedStorage();
  const flow = createFeedHarness(options?.flowApply);
  const paged = createFeedHarness();
  const flags = {
    activeKind: 'flow' as 'flow' | 'paged',
    canPersist: true,
    canRestore: true,
    destroyed: false,
  };
  const bound = vi.fn();
  const progress = createReaderSessionProgress({
    storage: store.storage,
    flow: flow.feed,
    paged: paged.feed,
    activeKind: () => flags.activeKind,
    canPersistNow: () => flags.canPersist,
    canRestoreNow: () => flags.canRestore,
    isDestroyed: () => flags.destroyed,
    onProgressBound: options?.onProgressBoundThrows === true
      ? () => {
          throw new Error('shelf alias write failed');
        }
      : bound,
  });
  return { store, flow, paged, flags, bound, progress };
}

const localBook = (path: string): ReaderTarget => normalizeReaderTarget(path);

const remoteBook = (): ReaderTarget => ({
  kind: 'remote',
  itemId: 'item-1',
  resourceId: 'remote-1',
  identity: { id: 'item-1', validator: 'etag-1' },
  displayName: 'Remote Book.epub',
  extension: 'epub',
  mimeType: 'application/epub+zip',
});

const flowRecord = (index: number, ratio = 0.5, total?: number): ReadingProgress => ({
  version: 2,
  kind: 'flow',
  index,
  ratio,
  ...(total === undefined ? {} : { total }),
  updatedAt: 1,
});

const pageRecord = (index: number): ReadingProgress => ({
  version: 2,
  kind: 'page',
  index,
  ratio: 0,
  updatedAt: 1,
});

/** rAF 桩：帧回调入队，测试手动排空（排空终止性即"不再循环"断言）。 */
function stubAnimationFrames(): { frames: Array<() => void>; drain(): void } {
  const frames: Array<() => void> = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    (callback: (time: number) => void): number => {
      frames.push(() => callback(0));
      return frames.length;
    },
  );
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined);
  return {
    frames,
    drain: () => {
      let guard = 0;
      while (frames.length > 0) {
        guard += 1;
        expect(guard).toBeLessThan(1000); // 循环即失败：超过阈值必须放弃
        frames.shift()!();
      }
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('session-progress identity chain', () => {
  it('derives the write key once for both format families', () => {
    const remote = remoteBook();
    expect(documentProgressId(remote, null)).toBe('item-1');
    expect(documentProgressId(remote, '0123456789abcdef')).toBe('item-1');
    const local = localBook('/books/a.epub');
    expect(documentProgressId(local, '0123456789abcdef')).toBe('0123456789abcdef');
    expect(documentProgressId(local, null)).toBe('/books/a.epub');
    // 漫画与文档身份同源：进度身份判定只改 session-progress 一处。
    expect(comicProgressIdForTarget(remote)).toBe(documentProgressId(remote, null));
    expect(comicProgressIdForTarget(local)).toBe(documentProgressId(local, null));
  });

  it('composes the restore chain in order for documents and comics', () => {
    const store = trackedStorage();
    saveLibraryProgressAlias(store.storage, 'item-1', 'legacy-key');
    const remote = remoteBook();
    expect(documentProgressRestoreIds(store.storage, remote, 'item-1', 'aaaabbbbccccdddd')).toEqual(
      ['item-1', '', 'legacy-key', readerIdentityKey(remote.identity), 'aaaabbbbccccdddd'],
    );
    // 漫画短链：不哈希归档，也不读 readerIdentityKey/contentHash 腿。
    expect(comicProgressRestoreIds(store.storage, remote, 'item-1')).toEqual([
      'item-1',
      '',
      'legacy-key',
    ]);
  });

  it('prefers the write key, then the path, then the shelf alias, migrating onto the write key', () => {
    const hash = '0123456789abcdef';
    const target = localBook('/books/legacy.epub');
    const record = flowRecord(1, 0.5, 12);

    // 写键命中：不发生迁移写。
    const first = createProgressHarness();
    saveReadingProgress(first.store.storage, hash, record);
    saveReadingProgress(first.store.storage, '/books/legacy.epub', flowRecord(2));
    saveLibraryProgressAlias(first.store.storage, target.identity.id, 'alias-key');
    saveReadingProgress(first.store.storage, 'alias-key', flowRecord(3));
    first.store.writes.length = 0; // 排除测试铺数据的写入，只观察会话写入
    first.progress.bindDocumentIdentity(target, hash);
    first.progress.applyPending();
    expect(first.flow.calls[0]?.saved.index).toBe(1);
    expect(first.store.writes).toHaveLength(0);

    // 路径腿命中：迁移到写键。
    const second = createProgressHarness();
    saveReadingProgress(second.store.storage, '/books/legacy.epub', record);
    second.progress.bindDocumentIdentity(target, hash);
    second.progress.applyPending();
    expect(second.flow.calls[0]?.saved.index).toBe(1);
    expect(loadReadingProgress(second.store.storage, hash)).toMatchObject({ index: 1 });

    // 书库 alias 腿命中：同样迁移到写键。
    const third = createProgressHarness();
    saveLibraryProgressAlias(third.store.storage, target.identity.id, 'alias-key');
    saveReadingProgress(third.store.storage, 'alias-key', record);
    third.progress.bindDocumentIdentity(target, hash);
    third.progress.applyPending();
    expect(third.flow.calls[0]?.saved.index).toBe(1);
    expect(loadReadingProgress(third.store.storage, hash)).toMatchObject({ index: 1 });
  });

  it('restores a remote document through the identity key leg', () => {
    const target = remoteBook();
    const harness = createProgressHarness();
    saveReadingProgress(harness.store.storage, readerIdentityKey(target.identity), flowRecord(5));
    harness.progress.bindDocumentIdentity(target, null);
    harness.progress.applyPending();
    expect(harness.flow.calls[0]?.saved.index).toBe(5);
    expect(loadReadingProgress(harness.store.storage, 'item-1')).toMatchObject({ index: 5 });
  });

  it('binds comics early on the short chain and skips the content hash leg', () => {
    const target = localBook('/comics/vol.cbz');
    const harness = createProgressHarness();
    saveReadingProgress(harness.store.storage, 'aaaabbbbccccdddd', pageRecord(9));
    harness.progress.bindComicIdentity(target);
    expect(harness.progress.hasPendingRestore()).toBe(false);
    expect(harness.paged.calls).toHaveLength(0);
    // 同一记录经文档身份链（contentHash 腿）可命中；漫画路径 contentHash 恒为
    // null（不哈希归档），此时两链同源（首个用例已断言同键）。
    harness.progress.bindDocumentIdentity(target, 'aaaabbbbccccdddd');
    harness.progress.applyPending();
    expect(harness.progress.progressId()).toBe('aaaabbbbccccdddd');
    expect(harness.paged.calls[0]?.saved.index).toBe(9);
  });

  it('notifies the shelf binding with the bound id and swallows callback failures', () => {
    const target = localBook('/books/a.epub');
    const harness = createProgressHarness();
    harness.progress.notifyProgressBound(target);
    expect(harness.bound).not.toHaveBeenCalled(); // 未绑身份（写键为空）不通知
    harness.progress.bindDocumentIdentity(target, null);
    harness.progress.notifyProgressBound(target);
    expect(harness.bound).toHaveBeenCalledTimes(1);
    expect(harness.bound).toHaveBeenCalledWith('/books/a.epub', target);

    const throwing = createProgressHarness({ onProgressBoundThrows: true });
    throwing.progress.bindDocumentIdentity(target, null);
    expect(() => throwing.progress.notifyProgressBound(target)).not.toThrow();
  });
});

describe('session-progress save timing', () => {
  it('debounces bursts into one write after the 400ms window', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2, 0.75, 9);
    harness.progress.schedulePersist();
    harness.progress.schedulePersist();
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS - 1);
    expect(harness.store.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.store.writes).toHaveLength(1);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 2,
      ratio: 0.75,
    });
  });

  it('gates non-forced saves on phase and on a pending restore', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(4);
    harness.progress.stage(flowRecord(6));
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(harness.store.writes).toHaveLength(0); // 恢复未落点：不把中途位置写盘

    harness.progress.applyPending(); // 落点（默认 applied）
    harness.flags.canPersist = false;
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(harness.store.writes).toHaveLength(0); // phase 门控（非 ready/loading）

    harness.flags.canPersist = true;
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(harness.store.writes).toHaveLength(1);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 4,
    });
  });

  it('falls back to the pending restore for forced saves', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    const pending = flowRecord(8, 0.25, 20);
    harness.progress.stage(pending);
    harness.progress.persistNow();
    expect(harness.store.writes).toHaveLength(1);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 8,
      ratio: 0.25,
    });
  });

  it('persists a layout-capture snapshot directly, bypassing debounce and phase', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flags.canPersist = false;
    harness.progress.stage(flowRecord(1));
    harness.progress.persistSnapshot(flowRecord(3, 0.5, 7));
    expect(harness.store.writes).toHaveLength(1);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 3,
      total: 7,
    });
    harness.progress.persistSnapshot(null);
    expect(harness.store.writes).toHaveLength(1);
  });

  it('clears the session on beginSession but saves the previous book first', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2);
    harness.progress.rememberSnapshot();
    harness.progress.beginSession();
    expect(harness.store.writes).toHaveLength(1); // 上一本位置已写入
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({ index: 2 });
    expect(harness.progress.progressId()).toBe('');
    expect(harness.progress.hasPendingRestore()).toBe(false);
    // 最近快照随会话作废：跨书残留不得进入新书的重排捕获。
    harness.flags.activeKind = 'paged';
    expect(harness.progress.captureForRelayout()).toBeNull();
    harness.progress.persistNow();
    expect(harness.store.writes).toHaveLength(1); // 无写键：不再写
  });
});

describe('session-progress snapshot dispatch', () => {
  it('feeds snapshots through the active family only', () => {
    const harness = createProgressHarness();
    harness.flags.activeKind = 'paged';
    harness.paged.snapshotValue = pageRecord(4);
    expect(harness.progress.snapshot()).toMatchObject({ kind: 'page', index: 4 });
    harness.flags.activeKind = 'flow';
    harness.flow.snapshotValue = flowRecord(2);
    expect(harness.progress.snapshot()).toMatchObject({ kind: 'flow', index: 2 });
  });

  it('captures pending first, then the remembered snapshot, then a fresh one', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    expect(harness.progress.captureForRelayout()).toBeNull();
    harness.flow.snapshotValue = flowRecord(1);
    harness.progress.rememberSnapshot();
    expect(harness.progress.captureForRelayout()).toMatchObject({ index: 1 });
    harness.progress.stage(flowRecord(5));
    expect(harness.progress.captureForRelayout()).toMatchObject({ index: 5 });
  });

  it('dispatches restore attempts by the saved kind', () => {
    const harness = createProgressHarness();
    harness.progress.stage(pageRecord(3));
    harness.progress.applyPending();
    expect(harness.paged.calls).toHaveLength(1);
    expect(harness.flow.calls).toHaveLength(0);
    harness.progress.stage(flowRecord(2));
    harness.progress.applyPending();
    expect(harness.flow.calls).toHaveLength(1);
  });
});

describe('session-progress restore retry thresholds', () => {
  it('gives up measuring a ready frame after 8 attempts and stops looping', () => {
    const raf = stubAnimationFrames();
    const harness = createProgressHarness({
      flowApply: () => ({ applied: false, pending: 'flow-frame-scroller' }),
    });
    harness.progress.stage(flowRecord(2));
    harness.progress.applyPendingWithRetry();
    raf.drain();
    expect(harness.flow.calls).toHaveLength(PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS);
    expect(harness.flow.calls.map((call) => call.attempts)).toEqual(
      Array.from({ length: PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS }, (_, index) => index),
    );
    // 放弃即停在当时可读位置：不报错、不再循环、无任何存储写入。
    expect(harness.progress.hasPendingRestore()).toBe(false);
    expect(raf.frames).toHaveLength(0);
    expect(harness.progress.applyPending()).toBe(true);
    expect(harness.flow.calls).toHaveLength(PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS);
    expect(harness.store.writes).toHaveLength(0);
  });

  it('keeps retrying an unmounted frame up to the 96-frame budget', () => {
    const raf = stubAnimationFrames();
    const harness = createProgressHarness({
      flowApply: () => ({ applied: false, pending: 'flow-frame' }),
    });
    harness.progress.stage(flowRecord(2));
    harness.progress.applyPendingWithRetry();
    raf.drain();
    expect(harness.flow.calls).toHaveLength(PAGED_FRAME_RESTORE_MAX_ATTEMPTS);
    expect(harness.progress.hasPendingRestore()).toBe(false);
    expect(raf.frames).toHaveLength(0);
  });

  it('lets the flow feed land best-effort on the 13th probe after 12 retries', () => {
    const raf = stubAnimationFrames();
    const landings: number[] = [];
    const harness = createProgressHarness({
      flowApply: (saved, attempts) => {
        if (attempts < FLOW_RESTORE_MAX_ATTEMPTS) {
          return { applied: false, pending: 'flow-measure' };
        }
        landings.push(saved.index);
        return { applied: true, rememberAsSnapshot: true };
      },
    });
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.progress.stage(flowRecord(6, 0.5, 9));
    harness.progress.applyPendingWithRetry();
    raf.drain();
    expect(harness.flow.calls).toHaveLength(FLOW_RESTORE_MAX_ATTEMPTS + 1);
    expect(landings).toEqual([6]);
    expect(harness.progress.hasPendingRestore()).toBe(false);
    // 尽力落点被记为最近快照：无新快照时 force 保存写的是恢复记录。
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 6,
    });
  });

  it('restarts the retry budget when the tab becomes active again', () => {
    const harness = createProgressHarness({
      flowApply: () => ({ applied: false, pending: 'flow-frame-scroller' }),
    });
    harness.progress.stage(flowRecord(1));
    harness.progress.applyPending();
    harness.progress.applyPending();
    expect(harness.flow.calls.map((call) => call.attempts)).toEqual([0, 1]);
    harness.progress.retryPending();
    expect(harness.flow.calls[2]?.attempts).toBe(0);
    expect(harness.progress.hasPendingRestore()).toBe(true);
  });

  it('restores from storage only when the view can restore', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    saveReadingProgress(harness.store.storage, '/books/a.epub', flowRecord(4, 0.5, 8));
    harness.flags.canRestore = false;
    harness.progress.restore();
    expect(harness.flow.calls).toHaveLength(0);
    harness.flags.canRestore = true;
    harness.progress.restore();
    expect(harness.flow.calls).toHaveLength(1);
    expect(harness.flow.calls[0]?.saved.index).toBe(4);
    expect(harness.progress.hasPendingRestore()).toBe(false);
  });

  it('discards a pending restore and cancels the queued retry frame', () => {
    const raf = stubAnimationFrames();
    const harness = createProgressHarness({
      flowApply: () => ({ applied: false, pending: 'flow-frame' }),
    });
    harness.progress.stage(flowRecord(1));
    harness.progress.applyPendingWithRetry();
    expect(raf.frames).toHaveLength(1);
    harness.progress.discardPending();
    expect(harness.progress.hasPendingRestore()).toBe(false);
  });

  it('lets a later persist write after the user discards a pending restore', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(3, 0.4);
    harness.progress.stage(flowRecord(1));
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(harness.store.writes).toHaveLength(0);
    harness.progress.discardPending();
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      index: 3,
      ratio: 0.4,
    });
    vi.useRealTimers();
  });

  it('freezes the retry budgets and debounce window at the ported values', () => {
    // 数值原样搬迁（reader-view 原口径）：改常量必须是有意的显式决策。
    expect(FLOW_RESTORE_MAX_ATTEMPTS).toBe(12);
    expect(PAGED_FRAME_RESTORE_GIVE_UP_ATTEMPTS).toBe(8);
    expect(PAGED_FRAME_RESTORE_MAX_ATTEMPTS).toBe(96);
    expect(PROGRESS_SAVE_DEBOUNCE_MS).toBe(400);
    expect(READING_IDLE_PAUSE_MS).toBe(2 * 60 * 1000);
  });
});

describe('session-progress v2 fields (readingMs / status)', () => {
  it('accumulates readingMs across debounced writes while the session is active', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2, 0.75, 9);
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS); // 首次写入：+400ms
    await vi.advanceTimersByTimeAsync(30_000); // 持续阅读 30s
    harness.progress.noteActivity();
    harness.progress.schedulePersist();
    await vi.advanceTimersByTimeAsync(PROGRESS_SAVE_DEBOUNCE_MS);
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      readingMs: 30_800,
    });
  });

  it('pauses readingMs after the 2-minute idle threshold', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2);
    await vi.advanceTimersByTimeAsync(30_000);
    harness.progress.noteActivity(); // 30s 活跃阅读
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 之后 10 分钟无输入
    harness.progress.persistNow();
    // 计入 30s 活跃 + 2 分钟空闲阈值；阈值之后暂停。
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      readingMs: 30_000 + READING_IDLE_PAUSE_MS,
    });
  });

  it('resumes timing from the activity point after an idle gap', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2);
    await vi.advanceTimersByTimeAsync(READING_IDLE_PAUSE_MS + 60_000); // 空闲超过阈值
    harness.progress.noteActivity(); // 恢复活动：从恢复点重新起计
    await vi.advanceTimersByTimeAsync(5_000);
    harness.progress.persistNow();
    // 空闲间隙不计入：绑定起 2 分钟阈值 + 恢复后 5s。
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      readingMs: READING_IDLE_PAUSE_MS + 5_000,
    });
  });

  it('accumulates onto the restored record readingMs across sessions', async () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    saveReadingProgress(harness.store.storage, '/books/a.epub', {
      ...flowRecord(4, 0.5, 8),
      readingMs: 60_000,
    });
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.progress.applyPending(); // 落点，解除写入门控
    harness.flow.snapshotValue = flowRecord(4, 0.5, 8);
    await vi.advanceTimersByTimeAsync(5_000);
    harness.progress.noteActivity();
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      readingMs: 65_000,
    });
  });

  it('marks flow progress finished at the last chapter end and keeps it sticky', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(9, 1, 10); // 末章末尾
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      status: 'finished',
    });
    // 读完为粘性语义：回读中途章节不清除（改回在读由书架侧手动完成）。
    harness.flow.snapshotValue = flowRecord(2, 0.5, 10);
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      status: 'finished',
      index: 2,
    });
  });

  it('marks paged progress finished on the last page only', () => {
    const harness = createProgressHarness();
    harness.flags.activeKind = 'paged';
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.paged.snapshotValue = { ...pageRecord(11), total: 12 };
    harness.progress.persistNow();
    expect(
      loadReadingProgress(harness.store.storage, '/books/a.epub'),
    ).not.toHaveProperty('status');
    harness.paged.snapshotValue = { ...pageRecord(12), total: 12 };
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      status: 'finished',
    });
  });

  it('keeps a restored finished status on later writes', () => {
    const harness = createProgressHarness();
    saveReadingProgress(harness.store.storage, '/books/a.epub', {
      ...flowRecord(9, 1, 10),
      status: 'finished',
    });
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.progress.applyPending();
    harness.flow.snapshotValue = flowRecord(1, 0.2, 10);
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      status: 'finished',
      index: 1,
    });
  });

  it('does not carry readingMs or finished state across beginSession', () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(9, 1, 10);
    harness.progress.persistNow();
    harness.progress.beginSession();
    harness.progress.bindDocumentIdentity(localBook('/books/b.epub'), null);
    harness.flow.snapshotValue = flowRecord(0, 0.1, 10);
    harness.progress.persistNow();
    const next = loadReadingProgress(harness.store.storage, '/books/b.epub');
    expect(next).not.toHaveProperty('status');
    expect(next?.readingMs).toBe(0);
  });

  it('keeps an externally marked finished status on later persists of a live session', () => {
    const harness = createProgressHarness();
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.flow.snapshotValue = flowRecord(2, 0.5, 10);
    harness.progress.persistNow();
    // 会话存活期间书架手动「标为读完」（returnToShelf 只 persistNow 不 dispose）。
    const stored = loadReadingProgress(harness.store.storage, '/books/a.epub');
    saveReadingProgress(harness.store.storage, '/books/a.epub', {
      ...stored!,
      status: 'finished',
    });
    // 会话后续任意 persist 不得覆盖外部写入的 finished。
    harness.flow.snapshotValue = flowRecord(3, 0.4, 10);
    harness.progress.persistNow();
    expect(loadReadingProgress(harness.store.storage, '/books/a.epub')).toMatchObject({
      status: 'finished',
      index: 3,
    });
  });

  it('does not resurrect finished after the shelf marks the book in-progress mid-session', () => {
    vi.useFakeTimers();
    const harness = createProgressHarness();
    saveReadingProgress(harness.store.storage, '/books/a.epub', {
      ...flowRecord(9, 1, 10),
      status: 'finished',
      readingMs: 60_000,
    });
    harness.progress.bindDocumentIdentity(localBook('/books/a.epub'), null);
    harness.progress.applyPending(); // 落点，解除写入门控；绑定时 baseFinished=true
    // 书架手动「标为在读」：删除 status，其余字段（含 readingMs）保留。
    const stored = loadReadingProgress(harness.store.storage, '/books/a.epub');
    const { status: _removed, ...rest } = stored!;
    saveReadingProgress(harness.store.storage, '/books/a.epub', rest);
    // 会话后续 persist 不得凭绑定时的 baseFinished 重新加回 status；
    // readingMs 以存储值为准，不回退、不重复累计。
    harness.flow.snapshotValue = flowRecord(2, 0.5, 10);
    harness.progress.persistNow();
    const next = loadReadingProgress(harness.store.storage, '/books/a.epub');
    expect(next).not.toHaveProperty('status');
    expect(next?.readingMs).toBe(60_000);
  });
});
