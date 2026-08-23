import { describe, expect, it } from 'vitest';

import { decodeReaderText, detectTextLabel } from '../formats/text-encoding.js';

describe('decodeReaderText', () => {
  it('keeps UTF-8 Chinese text', () => {
    const bytes = new TextEncoder().encode('三体');
    expect(detectTextLabel(bytes)).toBe('utf-8');
    expect(decodeReaderText(bytes)).toBe('三体');
  });

  it('decodes GBK Chinese bytes instead of emitting replacement characters', () => {
    let gbkAvailable = false;
    try {
      new TextDecoder('gbk');
      gbkAvailable = true;
    } catch {
      gbkAvailable = false;
    }
    if (!gbkAvailable) {
      return;
    }
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(detectTextLabel(bytes)).toBe('gbk');
    expect(decodeReaderText(bytes)).toBe('中文');
  });
});
