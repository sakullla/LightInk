import type { ReaderTabState, TabState } from './types.js';

/**
 * Which reader tab to show when entering the reader surface.
 *
 * A leftover first-opened tab must not win over a book that was just
 * opened: warm-start on the phone kept showing book 1 after book 3
 * because `tabList.find` returned the oldest reader. Prefer the active
 * reader, otherwise the most recently opened one.
 */
export function readerTabToReveal(
  tabs: readonly TabState[],
  activeId: string | null,
): ReaderTabState | undefined {
  const active = tabs.find((tab) => tab.id === activeId);
  if (active?.kind === 'reader') {
    return active;
  }
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab?.kind === 'reader') {
      return tab;
    }
  }
  return undefined;
}

/** Same-book reuse can skip load; a replaced leftover tab must reload. */
export function readerTabShowsPath(tab: ReaderTabState, path: string): boolean {
  return tab.filePath === path;
}
