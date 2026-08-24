import { describe, expect, it, vi } from 'vitest';

import {
  ReaderLoadCancelledError,
  yieldReaderLoad,
} from '../load-lifecycle.js';

describe('yieldReaderLoad', () => {
  it('returns to the event loop before continuing', async () => {
    let continued = false;
    const pending = yieldReaderLoad().then(() => {
      continued = true;
    });
    expect(continued).toBe(false);
    await pending;
    expect(continued).toBe(true);
  });

  it('throws when cancelled during the yield', async () => {
    const controller = new AbortController();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      controller.abort();
      (callback as () => void)();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    await expect(yieldReaderLoad(controller.signal)).rejects.toBeInstanceOf(
      ReaderLoadCancelledError,
    );
    vi.restoreAllMocks();
  });
});
