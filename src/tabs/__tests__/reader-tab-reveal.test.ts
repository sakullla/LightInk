import { describe, expect, it } from 'vitest';

import { readerTabShowsPath, readerTabToReveal } from '../reader-tab-reveal.js';
import type { ReaderTabState, TabState } from '../types.js';

function reader(id: string, path: string): ReaderTabState {
  return {
    kind: 'reader',
    id,
    filePath: path,
    title: path,
  } as ReaderTabState;
}

describe('readerTabToReveal', () => {
  const first = reader('tab-1', '/books/one.epub');
  const third = reader('tab-3', '/books/three.epub');
  const markdown = { kind: 'markdown', id: 'md-1' } as TabState;

  it('keeps the active reader when it is already a reader tab', () => {
    expect(readerTabToReveal([first, third], 'tab-3')).toBe(third);
  });

  it('does not revive the first leftover book when the active tab is not a reader', () => {
    expect(readerTabToReveal([first, markdown, third], 'md-1')).toBe(third);
  });

  it('returns undefined when no reader tab exists', () => {
    expect(readerTabToReveal([markdown], 'md-1')).toBeUndefined();
  });
});

describe('readerTabShowsPath', () => {
  it('is true only for the path the tab is already showing', () => {
    const tab = reader('tab-1', '/books/one.epub');
    expect(readerTabShowsPath(tab, '/books/one.epub')).toBe(true);
    expect(readerTabShowsPath(tab, '/books/three.epub')).toBe(false);
  });
});
