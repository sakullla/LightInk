import { describe, expect, it } from 'vitest';

import {
  decodeReaderText,
  detectTextLabel,
  injectEncodingSniffOrder,
} from '../formats/text-encoding.js';

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

  it('shows UTF-8 best effort without throwing when no label decodes cleanly', () => {
    // 0xFF is invalid both as UTF-8 and as GBK: the sniff falls back to UTF-8.
    const bytes = new Uint8Array([0x41, 0xff, 0x42]);
    expect(detectTextLabel(bytes)).toBe('utf-8');
    expect(decodeReaderText(bytes)).toBe('A�B');
  });

  it('falls back to UTF-8 best effort when the declared label is unavailable', () => {
    const bytes = new TextEncoder().encode('三体');
    expect(decodeReaderText(bytes, 'x-lightink-unknown')).toBe('三体');
  });

  it('applies an injected sniff order and restores the production order', () => {
    const bytes = new TextEncoder().encode('三体');
    expect(detectTextLabel(bytes)).toBe('utf-8');
    const restore = injectEncodingSniffOrder(['windows-1252', 'utf-8', 'gbk']);
    try {
      // windows-1252 decodes any byte sequence without U+FFFD, so moving it to
      // the front reroutes the decode for every sniffing format.
      expect(detectTextLabel(bytes)).toBe('windows-1252');
      expect(decodeReaderText(bytes)).not.toBe('三体');
    } finally {
      restore();
    }
    expect(detectTextLabel(bytes)).toBe('utf-8');
    expect(decodeReaderText(bytes)).toBe('三体');
  });

  it('skips probe labels the runtime does not support', () => {
    const bytes = new TextEncoder().encode('三体');
    const restore = injectEncodingSniffOrder(['x-lightink-unknown', 'utf-8', 'gbk']);
    try {
      expect(detectTextLabel(bytes)).toBe('utf-8');
      expect(decodeReaderText(bytes)).toBe('三体');
    } finally {
      restore();
    }
  });
});
