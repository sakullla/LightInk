/**
 * Shared text decoding for reader archives and shelf metadata.
 *
 * This is the reader's single decoding behavior definition. Formats without a
 * declared encoding (TXT, EPUB, FB2, ComicInfo) sniff via the shared order:
 * UTF-8 without replacement characters wins, otherwise a clean GBK decode is
 * used so Chinese content packaged as GBK does not become mojibake. Formats
 * with a declared label (MOBI codepage) call `decodeReaderText` with that
 * label and never sniff, so sniff-order changes cannot affect them.
 */

/** Production sniff order: the first label whose decode emits no U+FFFD wins. */
const READER_SNIFF_ORDER: readonly string[] = ['utf-8', 'gbk'];

let sniffOrder: readonly string[] = READER_SNIFF_ORDER;

/**
 * Test probe replacing the sniff order; returns a restore function that puts
 * the production order back. Production code never calls this.
 */
export function injectEncodingSniffOrder(order: readonly string[]): () => void {
  sniffOrder = order;
  return () => {
    sniffOrder = READER_SNIFF_ORDER;
  };
}

function includesReplacement(value: string): boolean {
  return value.includes('�');
}

function decodeSniff(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes, { stream: true });
}

/** A label is clean when the runtime supports it and its decode has no U+FFFD. */
function isCleanLabel(bytes: Uint8Array, label: string): boolean {
  try {
    return !includesReplacement(decodeSniff(bytes, label));
  } catch {
    return false; // Runtime lacks this label (e.g. no GBK without full ICU).
  }
}

/** Encoding sniff over the shared order; falls back to UTF-8 best effort. */
export function detectTextLabel(sniff: Uint8Array): string {
  for (const label of sniffOrder) {
    if (isCleanLabel(sniff, label)) {
      return label;
    }
  }
  return 'utf-8';
}

export function decodeReaderText(bytes: Uint8Array, label = detectTextLabel(bytes)): string {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    // Runtime lacks the declared label (e.g. windows-1252 without full ICU):
    // keep UTF-8 best effort instead of throwing.
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}
