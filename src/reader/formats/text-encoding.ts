/**
 * Shared text decoding for reader archives and shelf metadata.
 *
 * UTF-8 without replacement characters wins. Otherwise a clean GBK decode is
 * used so Chinese EPUB OPF / XHTML packaged as GBK does not become mojibake.
 */

function includesReplacement(value: string): boolean {
  return value.includes('�');
}

function decodeSniff(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes, { stream: true });
}

/** Encoding sniff: UTF-8 if clean; else GBK if clean; else UTF-8 best effort. */
export function detectTextLabel(sniff: Uint8Array): string {
  if (!includesReplacement(decodeSniff(sniff, 'utf-8'))) {
    return 'utf-8';
  }
  try {
    if (!includesReplacement(decodeSniff(sniff, 'gbk'))) {
      return 'gbk';
    }
  } catch {
    /* Runtime has no GBK label; keep UTF-8. */
  }
  return 'utf-8';
}

export function decodeReaderText(bytes: Uint8Array, label = detectTextLabel(bytes)): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes);
}
