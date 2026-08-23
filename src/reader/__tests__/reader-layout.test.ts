// @vitest-environment jsdom
/**
 * Reader flow layout is keyed separately from the editor Markdown layout.
 *
 * Contract for `src/reader/reader-layout.ts`:
 * - `READER_FLOW_LAYOUT_STORAGE_KEY` is `lightink.reader.flow.layout`
 * - default / missing / corrupt storage is `paginated`
 * - load/save never read or write `lightink.reading.layout`
 * - column math reuses `readingColumnLayout` with the stored measure
 * - paginated flow keeps book-like side gutters and caps column measure
 * - PDF and comics do not use text dual-column
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import { createAppShell, type AppShellActions } from '../../ui/app-shell.js';
import { ShortcutRegistry } from '../../ui/shortcuts.js';
import type { BuiltinThemeId } from '../../theme/theme-service.js';
import { createFlowRenderer, type FlowRendererHooks } from '../flow-renderer.js';
import { sessionRemoteImagePolicy } from '../../media/remote-image-policy.js';

import {
  applyReadingLayout,
  READING_LAYOUT_STORAGE_KEY,
  saveReadingLayout,
} from '../../ui/reading-layout.js';
import {
  READER_FLOW_LAYOUT_STORAGE_KEY,
  READER_FLOW_PAGED_PADDING_X_REM,
  applyReaderDocumentLayout,
  applyReaderLayout,
  clampReaderPageExtent,
  readerPageInnerPadPx,
  readerSurfaceIsCompact,
  loadReaderLayout,
  parseReaderLayout,
  readerFlowColumnLayout,
  readerFlowSpreadFromTypography,
  readerFlowUsesTextColumns,
  readerPageSpread,
  saveReaderLayout,
} from '../reader-layout.js';
import { DEFAULT_READER_TYPOGRAPHY } from '../reader-typography.js';

function memoryStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
} {
  const store = { ...initial };
  return {
    store,
    storage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
    },
  };
}

describe('parseReaderLayout', () => {
  it('defaults a long flowing book to paginated, not continuous scroll', () => {
    expect(parseReaderLayout(null)).toBe('paginated');
    expect(parseReaderLayout(undefined)).toBe('paginated');
    expect(parseReaderLayout('')).toBe('paginated');
    expect(parseReaderLayout('paginated')).toBe('paginated');
    expect(parseReaderLayout('scroll')).toBe('scroll');
    expect(parseReaderLayout('other')).toBe('paginated');
  });
});

describe('load/saveReaderLayout', () => {
  it('persists the reader flow key and does not rewrite the editor layout key', () => {
    const { store, storage } = memoryStorage();
    saveReadingLayout(storage, 'scroll');
    expect(loadReaderLayout(storage)).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');

    saveReaderLayout(storage, 'paginated');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');
    expect(loadReaderLayout(storage)).toBe('paginated');

    saveReaderLayout(storage, 'scroll');
    expect(loadReaderLayout(storage)).toBe('scroll');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');
  });

  it('returns paginated when storage is missing, throws, or holds corrupt JSON', () => {
    expect(loadReaderLayout(null)).toBe('paginated');
    expect(loadReaderLayout(undefined)).toBe('paginated');
    expect(
      loadReaderLayout({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => undefined,
      }),
    ).toBe('paginated');
    expect(
      loadReaderLayout({
        getItem: () => '{',
        setItem: () => undefined,
      }),
    ).toBe('paginated');
  });

  it('ignores save failures and never writes the editor key', () => {
    const written: string[] = [];
    saveReaderLayout(
      {
        getItem: () => null,
        setItem: (key: string) => {
          written.push(key);
          throw new Error('quota');
        },
      },
      'scroll',
    );
    expect(written).toEqual([READER_FLOW_LAYOUT_STORAGE_KEY]);
  });
});

describe('applyReaderDocumentLayout', () => {
  afterEach(() => {
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
    document.documentElement.classList.remove('is-paginated');
  });

  function fakeRoot(): {
    dataset: DOMStringMap;
    classList: DOMTokenList;
    classNames: Set<string>;
  } {
    const classNames = new Set<string>();
    return {
      dataset: {} as DOMStringMap,
      classNames,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
  }

  it('mirrors the reader flow key onto the document host in reader workspace', () => {
    const root = fakeRoot();
    expect(applyReaderDocumentLayout(root, 'reader', 'paginated', 'scroll')).toBe('paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(root.dataset.workspaceMode).toBe('reader');
    expect(root.classNames.has('is-paginated')).toBe(true);

    applyReaderDocumentLayout(root, 'reader', 'scroll', 'paginated');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(root.classNames.has('is-paginated')).toBe(false);
  });

  it('restores the editor layout when leaving reader workspace and does not write keys', () => {
    const root = fakeRoot();
    const { store, storage } = memoryStorage({
      [READING_LAYOUT_STORAGE_KEY]: 'paginated',
      [READER_FLOW_LAYOUT_STORAGE_KEY]: 'paginated',
    });
    applyReaderDocumentLayout(root, 'editor', 'paginated', 'scroll');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(root.dataset.workspaceMode).toBe('editor');
    expect(root.classNames.has('is-paginated')).toBe(false);
    applyReaderDocumentLayout(root, 'editor', 'scroll', 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('paginated');
    expect(loadReaderLayout(storage)).toBe('paginated');
  });

  it('keeps the reader key on the document host when the editor applier runs', () => {
    applyReaderDocumentLayout(document.documentElement, 'reader', 'paginated', 'scroll');
    expect(document.documentElement.dataset.readingLayout).toBe('paginated');
    applyReadingLayout(document.documentElement, 'scroll');
    expect(document.documentElement.dataset.readingLayout).toBe('paginated');
    expect(document.documentElement.classList.contains('is-paginated')).toBe(true);
  });
});

describe('applyReaderLayout', () => {
  it('stamps the flow root so the first screen can paginate independently of the editor', () => {
    const classNames = new Set<string>();
    const root = {
      dataset: {} as DOMStringMap,
      classList: {
        toggle(name: string, force?: boolean) {
          if (force === true) classNames.add(name);
          else classNames.delete(name);
          return force === true;
        },
      } as unknown as DOMTokenList,
    };
    applyReaderLayout(root, 'paginated');
    expect(root.dataset.readingLayout).toBe('paginated');
    expect(classNames.has('is-paginated')).toBe(true);
    applyReaderLayout(root, 'scroll');
    expect(root.dataset.readingLayout).toBe('scroll');
    expect(classNames.has('is-paginated')).toBe(false);
  });
});

describe('readerFlowColumnLayout', () => {
  it('opens two columns in a 1200–1400 CSS-pixel pane at the default 22rem measure', () => {
    expect(readerFlowColumnLayout(1200, 16, 22).columns).toBe(2);
    expect(readerFlowColumnLayout(1300, 16, 22).columns).toBe(2);
    expect(readerFlowColumnLayout(1400, 16, 22).columns).toBe(2);
  });

  it('falls back to one column when the pane cannot hold a comfortable measure', () => {
    expect(readerFlowColumnLayout(700, 16, 22).columns).toBe(1);
    expect(readerFlowColumnLayout(1300, 16, 40).columns).toBe(1);
  });
});

describe('readerFlowUsesTextColumns', () => {
  it('keeps text dual-column on flow only; PDF and comics stay on their own engines', () => {
    expect(readerFlowUsesTextColumns('flow')).toBe(true);
    expect(readerFlowUsesTextColumns('pdf')).toBe(false);
    expect(readerFlowUsesTextColumns('comic')).toBe(false);
  });
});

describe('READER_FLOW_PAGED_PADDING_X_REM', () => {
  it('keeps a thin window inset so page gutters can own the line length', () => {
    expect(READER_FLOW_PAGED_PADDING_X_REM).toBeGreaterThanOrEqual(0.5);
    expect(READER_FLOW_PAGED_PADDING_X_REM).toBeLessThanOrEqual(1.25);
  });

  it('keeps reader.css free of bookshelf and editor measure tokens', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).not.toMatch(/lightink-library/);
    expect(css).not.toMatch(/--lightink-measure/);
    expect(css).not.toMatch(/--lightink-page-pad/);
  });

  it('keeps scroll-mode chrome sticky at the start of the reader column', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader\[data-reading-layout='scroll'\]\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(css).toMatch(/\.lightink-reader-chrome\s*\{[^}]*position:\s*sticky/);
  });

  it('keeps paginated chrome a full-width row so CJK labels do not stack', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader:not\(\[data-reading-layout='scroll'\]\)\s*\{[^}]*flex-direction:\s*column/,
    );
    expect(css).toMatch(/\.lightink-reader-chrome\s*\{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.lightink-reader-chrome-action\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(
      /\.lightink-reader-chrome-bar\s*\{[^}]*padding:[^;]*--lightink-titlebar-caption/,
    );
    expect(css).toMatch(/\.lightink-reader-chrome-drag\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-bar\s*\{[^}]*--lightink-safe-top/,
    );
    expect(css).toMatch(/\.lightink-reader-chrome-action\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.lightink-reader-chrome-track--whisper\s*\{[^}]*height:\s*1px/);
    expect(css).toMatch(
      /\.lightink-reader-chrome-footer\s*\{[^}]*flex-direction:\s*row/,
    );
    expect(css).toMatch(
      /\.lightink-reader-chrome-whisper\s*\{[^}]*flex-direction:\s*row/,
    );
    expect(css).toMatch(
      /html\[data-reader-progress-bar='off'\][\s\S]*?\.lightink-reader-chrome-whisper \.lightink-reader-chrome-scrubber,\s*html\[data-reader-progress-bar='off'\][\s\S]*?\.lightink-reader-chrome-scrubber\s*\{[^}]*display:\s*none/,
    );
    expect(css).not.toMatch(
      /html\[data-reader-progress-bar='off'\]\s*\.lightink-reader-chrome-whisper\s*\{[^}]*display:\s*none/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader\s*\{[^}]*--lightink-reader-pad-x:\s*0\.9rem/,
    );
    expect(css).toMatch(/\.lightink-reader-chrome-tools\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action\s*\{[^}]*min-width:\s*44px/,
    );
  });

describe('readerPageInnerPadPx', () => {
  it('uses a Kindle-narrow gutter on compact surfaces and the desktop pad otherwise', () => {
    expect(readerPageInnerPadPx(16, false)).toBe(40);
    expect(readerPageInnerPadPx(16, true)).toBe(17);
    document.documentElement.setAttribute('data-android', '');
    expect(readerSurfaceIsCompact()).toBe(true);
    document.documentElement.removeAttribute('data-android');
  });
});

  it('keeps the annotation notebook below the titlebar so caption chips do not cover it', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/annotation-sidebar.css'), 'utf-8');
    expect(css).toMatch(
      /\.lightink-reader-sidebar\s*\{[^}]*inset:\s*var\(--lightink-titlebar-height/,
    );
  });

  it('uses a short slide page-turn instead of a 3D curl', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
    expect(css).toMatch(/@keyframes lightink-reader-page-next/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('overrides the editor measure after .lightink-tab-host so an open book can fill the pane', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    const measure = css.indexOf('max-width: var(--lightink-measure, 48rem);');
    const readerHost = css.indexOf('.lightink-tab-host.lightink-tab-host--reader');
    expect(measure).toBeGreaterThan(-1);
    expect(readerHost).toBeGreaterThan(measure);
  });

  it('scrolls the reader pane like Markdown instead of clipping the book', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ui/theme.css'), 'utf-8');
    expect(css).toMatch(
      /html\[data-reading-layout='scroll'\] #lightink-editor-area\[data-surface='reader'\]\s*\{[^}]*overflow-y:\s*auto/,
    );
  });

  it('pins a backward chapter turn to the last page instead of rounding it away', () => {
    const flow = readFileSync(resolve(process.cwd(), 'src/reader/flow-renderer.ts'), 'utf-8');
    const view = readFileSync(resolve(process.cwd(), 'src/reader/reader-view.ts'), 'utf-8');
    expect(flow).toMatch(/dataset\.pagedRestore = direction < 0 \? 'end' : 'start'/);
    expect(flow).not.toMatch(/scrollLeft = Math\.round\(scroller\.scrollLeft/);
    expect(view).not.toMatch(/scrollLeft = Math\.round\(scroller\.scrollLeft/);
    expect(view).toMatch(/flowRenderer\.advancePage\(direction\)/);
  });
});

/** Bodies of `@media ${query}` blocks, brace-balanced so rules after the block do not match. */
function cssAtMediaBodies(css: string, query: string): string[] {
  const marker = `@media ${query}`;
  const bodies: string[] = [];
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const at = css.indexOf(marker, searchFrom);
    if (at < 0) {
      break;
    }
    const open = css.indexOf('{', at + marker.length);
    if (open < 0) {
      break;
    }
    let depth = 0;
    let closed = -1;
    for (let i = open; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          closed = i;
          break;
        }
      }
    }
    if (closed < 0) {
      break;
    }
    bodies.push(css.slice(open + 1, closed));
    searchFrom = closed + 1;
  }
  return bodies;
}

function coarsePointerCss(css: string): string {
  return cssAtMediaBodies(css, '(pointer: coarse)').join('\n');
}

describe('touch reader chrome safe areas and 44px hit targets (R2/R7/R9)', () => {
  const readerCss = (): string =>
    readFileSync(resolve(process.cwd(), 'src/reader/reader.css'), 'utf-8');
  const panelsCss = (): string =>
    readFileSync(resolve(process.cwd(), 'src/reader/reader-chrome-panels.css'), 'utf-8');

  it('keeps the touch top chrome below the status bar with --lightink-safe-top', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-bar\s*\{[^}]*padding:[^;]*--lightink-safe-top/,
    );
    expect(coarsePointerCss(css)).toMatch(
      /\.lightink-reader-chrome-bar\s*\{[^}]*padding:[^;]*--lightink-safe-top/,
    );
  });

  it('pads the touch bottom chrome rows with --lightink-safe-bottom', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer\s*\{[^}]*padding:[^;]*--lightink-safe-bottom/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-whisper\s*\{[^}]*padding:[^;]*--lightink-safe-bottom/,
    );
    const coarse = coarsePointerCss(css);
    expect(coarse).toMatch(
      /\.lightink-reader-chrome-footer\s*\{[^}]*padding:[^;]*--lightink-safe-bottom/,
    );
    expect(coarse).toMatch(
      /\.lightink-reader-chrome-whisper\s*\{[^}]*padding:[^;]*--lightink-safe-bottom/,
    );
  });

  it('keeps top chrome entries and the progress slider at 44px hit targets on touch', () => {
    const css = readerCss();
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-action\s*\{[^}]*min-height:\s*44px/,
    );
    expect(coarsePointerCss(css)).toMatch(
      /\.lightink-reader-chrome-action\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
    );
    expect(css).toMatch(
      /:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-scrubber,\s*:is\(html\[data-android\], html\[data-touch-primary\]\) \.lightink-reader-chrome-footer \.lightink-reader-chrome-progress\s*\{[^}]*min-height:\s*44px/,
    );
  });

  it('keeps touch bottom sheets clear of the gesture bar with --lightink-safe-bottom', () => {
    const css = panelsCss();
    expect(css).toMatch(
      /\.lightink-reader-chrome-panel\.is-touch-sheet\s*\{[^}]*padding-bottom:\s*var\(--lightink-safe-bottom/,
    );
    expect(css).toMatch(
      /\.lightink-reader-search-sheet\s*\{[^}]*padding-bottom:\s*var\(--lightink-safe-bottom/,
    );
  });

  it('keeps the search sheet query box, hit rows, and close button at 44px on coarse pointers', () => {
    const coarse = coarsePointerCss(panelsCss());
    expect(coarse).toMatch(
      /\.lightink-reader-search-sheet-input,\s*\.lightink-reader-search-sheet-hit\s*\{[^}]*min-height:\s*44px/,
    );
    expect(coarse).toMatch(
      /\.lightink-reader-search-sheet-close\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
    );
  });
});

describe('readerFlowSpreadFromTypography', () => {
  it('keeps two facing columns on a wide page even when the stored measure is long', () => {
    const comfortable = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 22 };
    const longer = { ...DEFAULT_READER_TYPOGRAPHY, measureRem: 32 };
    expect(readerFlowSpreadFromTypography(1000, 16, comfortable).columns).toBe(2);
    expect(readerFlowSpreadFromTypography(1000, 16, longer).columns).toBe(2);
  });

  it('keeps a single column that fills the page', () => {
    const page = readerPageSpread(520, 16, 22);
    expect(page.columns).toBe(1);
    expect(page.width).toBe(520);
    expect(page.columnWidth).toBe(520);
    expect(page.gap).toBe(0);
  });

  it('splits a wide page into two filling columns without leftover sliver width', () => {
    const page = readerPageSpread(1000, 16, 22);
    expect(page.columns).toBe(2);
    expect(page.width).toBe(1000);
    expect(page.columnWidth * 2 + page.gap).toBe(page.width);
    expect(page.step).toBe(page.width + page.gap);
  });
});

describe('clampReaderPageExtent', () => {
  it('caps a chapter-tall pane to the window so pagination still has pages', () => {
    expect(
      clampReaderPageExtent({ width: 1100, height: 5000 }, { innerWidth: 1280, innerHeight: 720 }),
    ).toEqual({ width: 1100, height: 720 });
    expect(
      clampReaderPageExtent({ width: 1100, height: 800 }, { innerWidth: 1280, innerHeight: 768 }),
    ).toEqual({ width: 1100, height: 800 });
  });
});

const flowRendererHooks = (
  overrides: Partial<FlowRendererHooks> = {},
): FlowRendererHooks => ({
  t: (key) => key,
  remoteImagePolicy: sessionRemoteImagePolicy,
  syncState: () => undefined,
  applyPendingRestore: () => undefined,
  renderHighlights: () => undefined,
  handleNoteMarkClick: () => false,
  onSelectionMouseUp: () => undefined,
  openSearch: () => undefined,
  advanceReading: () => false,
  advancePagedWheel: () => false,
  dismissSelectionToolbar: () => false,
  isLayoutSwitching: () => false,
  scrollContainer: () => document.body,
  ...overrides,
});

describe('flow host wheel', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
  });

  function mountFlowRoot(): { root: HTMLElement; scrollHost: HTMLElement } {
    const shell = document.createElement('div');
    shell.dataset.workspaceMode = 'reader';
    shell.dataset.workspaceSurface = 'reader';
    const root = document.createElement('div');
    root.className = 'lightink-reader';
    root.dataset.readingLayout = 'paginated';
    const scrollHost = document.createElement('div');
    root.appendChild(scrollHost);
    shell.appendChild(root);
    document.body.appendChild(shell);
    return { root, scrollHost };
  }

  it('delegates to advancePagedWheel and preventDefault only when a page moved', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(dirs).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('consumes a paginated wheel even when the chapter cannot turn', () => {
    const { root, scrollHost } = mountFlowRoot();
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({ advancePagedWheel: () => false }),
    );
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('swallows a gated paginated burst so a second listener cannot turn again', () => {
    const { root, scrollHost } = mountFlowRoot();
    let turns = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          turns += 1;
          return true;
        },
      }),
    );
    const first = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
    const second = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
    document.dispatchEvent(first);
    document.dispatchEvent(second);
    expect(turns).toBe(1);
    expect(second.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('ignores a hidden inactive-tab flow host', () => {
    const { root, scrollHost } = mountFlowRoot();
    root.parentElement!.style.display = 'none';
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
    renderer.clear();
  });

  it('does not page a PDF or comic host', () => {
    const { root, scrollHost } = mountFlowRoot();
    const pages = document.createElement('div');
    pages.className = 'lightink-reader-pages';
    pages.dataset.readerActive = 'true';
    root.appendChild(pages);
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
    renderer.clear();
  });

  it('removes the document wheel listener on clear', () => {
    const { root, scrollHost } = mountFlowRoot();
    let called = 0;
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: () => {
          called += 1;
          return true;
        },
      }),
    );
    renderer.clear();
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    expect(called).toBe(0);
  });
});

describe('flow host touch paging', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
  });

  function mountFlowRoot(layout: 'paginated' | 'scroll' = 'paginated'): {
    root: HTMLElement;
    scrollHost: HTMLElement;
  } {
    const shell = document.createElement('div');
    shell.dataset.workspaceMode = 'reader';
    shell.dataset.workspaceSurface = 'reader';
    const root = document.createElement('div');
    root.className = 'lightink-reader';
    root.dataset.readingLayout = layout;
    const scrollHost = document.createElement('div');
    // jsdom 无布局：点按热区判定需要视口宽度。
    Object.defineProperty(scrollHost, 'clientWidth', { configurable: true, value: 400 });
    root.appendChild(scrollHost);
    shell.appendChild(root);
    document.body.appendChild(shell);
    return { root, scrollHost };
  }

  function touchEvent(type: string, point: { clientX: number; clientY: number } | null): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const points = point === null ? [] : [point];
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : points });
    Object.defineProperty(event, 'changedTouches', { value: points });
    return event;
  }

  it('delegates a right-zone tap to advancePagedWheel (same entry as wheel)', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 350, clientY: 100 }));
    const end = touchEvent('touchend', { clientX: 350, clientY: 100 });
    scrollHost.dispatchEvent(end);
    expect(dirs).toEqual([1]);
    expect(end.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('delegates a left-zone tap and a horizontal swipe', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 40, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 40, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 320, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 140, clientY: 108 }));
    expect(dirs).toEqual([-1, 1]);
    renderer.clear();
  });

  it('uses asymmetric tap zones: prev only within 20%, next already at 30% from the right', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    // 400 * 0.2 = 80：x=100 已在左热区外（旧对称 25% 会误判为上一页）。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 100, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 100, clientY: 100 }));
    expect(dirs).toEqual([]);
    // 400 * (1 - 0.3) = 280：x=290 落在更宽的右热区（旧对称 25% 判为中间区）。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 290, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 290, clientY: 100 }));
    expect(dirs).toEqual([1]);
    renderer.clear();
  });

  it('ignores touch gestures starting inside the 24px system edge band', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    // 左外缘带内点按：即使落在上一页热区也不翻。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 10, clientY: 100 }));
    const leftEnd = touchEvent('touchend', { clientX: 10, clientY: 100 });
    scrollHost.dispatchEvent(leftEnd);
    // 右外缘带内点按（400 - 390 = 10 < 24）。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 100 }));
    const rightEnd = touchEvent('touchend', { clientX: 390, clientY: 100 });
    scrollHost.dispatchEvent(rightEnd);
    // 从左外缘带内起始的横向滑动（系统返回手势）不翻页。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 12, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 220, clientY: 104 }));
    expect(dirs).toEqual([]);
    expect(leftEnd.defaultPrevented).toBe(false);
    expect(rightEnd.defaultPrevented).toBe(false);
    renderer.clear();
  });

  it('delegates a right-edge mouse click to advancePagedWheel (no touch edge band)', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    // 24px 外缘排除带只针对触控手势；鼠标 click 在 x=390 仍应翻页。
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 100 });
    scrollHost.dispatchEvent(event);
    expect(dirs).toEqual([1]);
    expect(event.defaultPrevented).toBe(true);
    renderer.clear();
  });

  it('keeps desktop mouse click zones symmetric at 25%/25% (R10)', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    // x=100 = 400*0.25：对称左热区仍翻上一页（触屏非对称 20% 会判为中部）。
    scrollHost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    expect(dirs).toEqual([-1]);
    // x=290 < 400*0.75=300：对称右热区外不翻页（触屏非对称 30% 才会翻）。
    scrollHost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 290, clientY: 100 }));
    expect(dirs).toEqual([-1]);
    scrollHost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 300, clientY: 100 }));
    expect(dirs).toEqual([-1, 1]);
    renderer.clear();
  });

  it('swallows the synthetic click following a band-start tap so it cannot page', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    // 带内点按不翻页且不 preventDefault；随后的合成 click 落在 click 热区，
    // 必须被一次性吞掉，否则 bindClickPaging 兜底会翻页。
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 390, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 390, clientY: 100 }));
    const synthetic = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 100 });
    scrollHost.dispatchEvent(synthetic);
    expect(dirs).toEqual([]);
    expect(synthetic.defaultPrevented).toBe(true);
    // 一次性：后续独立鼠标 click 照常翻页。
    scrollHost.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 390, clientY: 100 }));
    expect(dirs).toEqual([1]);
    renderer.clear();
  });

  it('does not page on a center tap (chrome toggle click path preserved)', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 200, clientY: 100 }));
    const end = touchEvent('touchend', { clientX: 200, clientY: 100 });
    scrollHost.dispatchEvent(end);
    expect(dirs).toEqual([]);
    expect(end.defaultPrevented).toBe(false);
    renderer.clear();
  });

  it('does not page in scroll layout or on a hidden host', () => {
    const scrolled = mountFlowRoot('scroll');
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrolled.scrollHost,
      scrolled.root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    scrolled.scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 350, clientY: 100 }));
    scrolled.scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 350, clientY: 100 }));
    expect(dirs).toEqual([]);
    renderer.clear();

    const hidden = mountFlowRoot();
    hidden.root.parentElement!.style.display = 'none';
    const hiddenRenderer = createFlowRenderer(
      hidden.scrollHost,
      hidden.root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    hidden.scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 350, clientY: 100 }));
    hidden.scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 350, clientY: 100 }));
    expect(dirs).toEqual([]);
    hiddenRenderer.clear();
  });

  it('stops paging after clear', () => {
    const { root, scrollHost } = mountFlowRoot();
    const dirs: Array<1 | -1> = [];
    const renderer = createFlowRenderer(
      scrollHost,
      root,
      flowRendererHooks({
        advancePagedWheel: (direction) => {
          dirs.push(direction);
          return true;
        },
      }),
    );
    renderer.clear();
    scrollHost.dispatchEvent(touchEvent('touchstart', { clientX: 350, clientY: 100 }));
    scrollHost.dispatchEvent(touchEvent('touchend', { clientX: 350, clientY: 100 }));
    expect(dirs).toEqual([]);
  });
});

function stubShellActions(overrides: Partial<AppShellActions> = {}): AppShellActions {
  const noop = (): void => undefined;
  return {
    onNew: noop,
    onOpen: noop,
    listRecents: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(false),
    clearRecents: () => Promise.resolve(),
    onShowVersions: noop,
    hasActiveFile: () => false,
    onSave: noop,
    onSaveAs: noop,
    onExportHtml: noop,
    onExportPdf: noop,
    onUndo: noop,
    onRedo: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onInsertElement: (_id: InsertElementId) => undefined,
    onToggleTheme: noop,
    onApplyTheme: (_id: BuiltinThemeId) => undefined,
    getCurrentThemeId: () => 'warm-light',
    onReloadCustomTheme: noop,
    onSelectCustomTheme: noop,
    onResetCustomTheme: noop,
    canReloadCustomTheme: () => false,
    canResetCustomTheme: () => false,
    onToggleOutline: noop,
    onToggleSourceMode: noop,
    getReadingLayout: () => 'scroll',
    onToggleReadingLayout: noop,
    onToggleFullscreen: noop,
    isChromePinned: () => false,
    onToggleChromePinned: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    getFontScaleLabel: () => '100%',
    t: (key) => key,
    formatShortcut: (combo: string) => combo,
    getLocale: () => 'zh-CN',
    setLocale: () => undefined,
    ...overrides,
  };
}

describe('reader Ctrl+M vs editor layout key', () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.readingLayout;
    delete document.documentElement.dataset.workspaceMode;
  });

  it('keeps the editor layout key unchanged when Ctrl+M fires in reader workspace', () => {
    const { store, storage } = memoryStorage({
      [READING_LAYOUT_STORAGE_KEY]: 'scroll',
      [READER_FLOW_LAYOUT_STORAGE_KEY]: 'paginated',
    });
    let editorLayout: 'scroll' | 'paginated' = 'scroll';
    const onToggleReadingLayout = (): void => {
      editorLayout = editorLayout === 'paginated' ? 'scroll' : 'paginated';
      saveReadingLayout(storage, editorLayout);
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const shell = createAppShell(
      root,
      stubShellActions({
        getWorkspaceMode: () => 'reader',
        getReadingLayout: () => editorLayout,
        onToggleReadingLayout,
      }),
      { shortcutBindings: () => [], storage },
    );
    const registry = new ShortcutRegistry({
      'toggle-reading-layout': onToggleReadingLayout,
    });
    registry.attach(document);

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(store[READING_LAYOUT_STORAGE_KEY]).toBe('scroll');
    expect(editorLayout).toBe('scroll');
    expect(store[READER_FLOW_LAYOUT_STORAGE_KEY]).toBe('scroll');
    registry.detach(document);
    shell.destroy();
  });
});
