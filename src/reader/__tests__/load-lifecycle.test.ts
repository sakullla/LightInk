import { describe, expect, it } from 'vitest';

import { yieldReaderLoad } from '../load-lifecycle.js';

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

});
