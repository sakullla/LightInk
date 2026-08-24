import type { RandomAccessSource, ReaderDocumentIdentity } from './types.js';

/**
 * Local file random-access source. Callers supply size + ranged reads so the
 * WebView never materializes EPUB/CBZ/PDF bodies.
 */
export function createLocalFileSource(options: {
  readonly size: number;
  readonly identity: ReaderDocumentIdentity;
  readonly readRange: RandomAccessSource['readRange'];
}): RandomAccessSource {
  return {
    size: options.size,
    identity: options.identity,
    access: 'local',
    readRange: options.readRange,
    close: async () => undefined,
  };
}
