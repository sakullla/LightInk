/**
 * Contract for the reader surface's assistant search wiring
 * (`src/reader/view/reader-chrome-wiring.ts`, R3/R6):
 *
 * 助手 tool loop 的 query_book.search 适配器只允许 run / hitViews / hitsState，
 * 必须等 pending/searching 结束；不得调用 activateKey 或改动阅读位置。
 * 面板 core 已迁至 `src/assistant/assistant-panel.ts`，本文件保留 reader 侧
 * 装配的回归覆盖。
 */

import { describe, expect, it, vi } from 'vitest';

import { runAssistantSessionSearch } from '../view/reader-chrome-wiring.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('runAssistantSessionSearch (tool search wiring)', () => {
  it('resolves only after pending/searching clear and never calls activateKey', async () => {
    let pending = true;
    let searching = false;
    let doneFlag = false;
    const activateKey = vi.fn();
    const session = {
      run: vi.fn((query: string) => {
        expect(query).toBe('needle');
        pending = true;
        searching = false;
        doneFlag = false;
        setTimeout(() => {
          pending = false;
          searching = true;
          setTimeout(() => {
            pending = false;
            searching = false;
            doneFlag = true;
          }, 8);
        }, 8);
      }),
      hitsState: () => ({ pending, searching, done: doneFlag, hasMore: false }),
      activateKey,
    };
    const done = runAssistantSessionSearch(session, 'needle');
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await done;
    expect(settled).toBe(true);
    expect(session.run).toHaveBeenCalledWith('needle');
    expect(activateKey).not.toHaveBeenCalled();
    expect(session.hitsState()).toEqual({
      pending: false,
      searching: false,
      done: true,
      hasMore: false,
    });
  });

  it('does not treat pre-start idle as done when run() stays idle until later', async () => {
    let pending = false;
    let searching = false;
    let doneFlag = false;
    const activateKey = vi.fn();
    const session = {
      run: vi.fn((query: string) => {
        expect(query).toBe('needle');
        // PDF-like: runPdfSearch returns before onResult, so hitsState stays idle.
        doneFlag = false;
        setTimeout(() => {
          pending = true;
          searching = false;
          setTimeout(() => {
            pending = false;
            searching = false;
            doneFlag = true;
          }, 8);
        }, 8);
      }),
      hitsState: () => ({ pending, searching, done: doneFlag, hasMore: false }),
      activateKey,
    };
    const done = runAssistantSessionSearch(session, 'needle');
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    await done;
    expect(settled).toBe(true);
    expect(session.run).toHaveBeenCalledWith('needle');
    expect(activateKey).not.toHaveBeenCalled();
    expect(session.hitsState()).toEqual({
      pending: false,
      searching: false,
      done: true,
      hasMore: false,
    });
  });

  it('returns hits immediately when run() already finished with done=true', async () => {
    const hits = [{ snippet: 'needle in hay', location: '第 1 页', key: 'p1:0:6' }];
    const activateKey = vi.fn();
    const session = {
      run: vi.fn(() => undefined),
      hitsState: () => ({ pending: false, searching: false, done: true, hasMore: false }),
      hitViews: () => hits,
      activateKey,
    };
    const result = await runAssistantSessionSearch(session, 'needle');
    expect(result).toEqual(hits);
    expect(session.run).toHaveBeenCalledWith('needle');
    expect(activateKey).not.toHaveBeenCalled();
  });

  it('does not hang when run() stays idle forever (comic/no-op)', async () => {
    const activateKey = vi.fn();
    const session = {
      run: vi.fn(() => undefined),
      hitsState: () => ({ pending: false, searching: false, done: true, hasMore: false }),
      hitViews: () => [],
      activateKey,
    };
    const result = await runAssistantSessionSearch(session, 'needle');
    expect(result).toEqual([]);
    expect(session.run).toHaveBeenCalledWith('needle');
    expect(activateKey).not.toHaveBeenCalled();
  });
});
