/**
 * EPUB converters (Sigil, 网文打包) often stamp a random project id into
 * `<title>`. Those strings must not become chrome labels or body text.
 */

const JUNK_CHAPTER_TITLE = /^(?:untitled|unknown|chapter\s*\d+|[\d._-]+|[a-z0-9_-]{4,24})$/i;

export function isUsableEpubChapterTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 80) {
    return false;
  }
  if (/[\u3400-\u9fff]/.test(trimmed)) {
    return true;
  }
  return !JUNK_CHAPTER_TITLE.test(trimmed);
}

export function displayChapterTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  return isUsableEpubChapterTitle(trimmed) ? trimmed : fallback;
}
