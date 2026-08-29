import { webcrypto } from 'node:crypto';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';

if (typeof globalThis.TransformStream === 'undefined') {
  Object.assign(globalThis, { ReadableStream, TransformStream, WritableStream });
}

if (globalThis.crypto?.subtle == null) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
}
