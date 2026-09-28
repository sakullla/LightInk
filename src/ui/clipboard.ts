/**
 * Shared clipboard text write (R5).
 *
 * `navigator.clipboard.writeText` is the primary path, but it is missing in
 * some webviews / non-secure contexts and can reject at runtime (permission,
 * focus). Fall back to a hidden textarea + `document.execCommand('copy')` and
 * report a boolean so callers can surface success/failure feedback.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard !== undefined &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return legacyClipboardCopy(text);
}

function legacyClipboardCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
