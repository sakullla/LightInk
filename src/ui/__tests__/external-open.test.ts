/**
 * Running-instance / file-association open (T4): restore the window,
 * switch to the matching workspace surface, and show a visible
 * success or failure hint.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyExternalOpenSurface,
  displayNameForExternalOpen,
  EXTERNAL_OPEN_LABELS,
  handleExternalOpen,
  planColdStartSurface,
  revealExistingWindow,
  type ExternalOpenDeps,
  type ExternalOpenedTab,
  type RevealableWindow,
} from '../external-open.js';
import { createWorkspaceMode } from '../workspace-mode.js';

function ebookTab(overrides: Partial<ExternalOpenedTab> = {}): ExternalOpenedTab {
  return {
    kind: 'reader',
    title: 'Dune',
    filePath: '/books/dune.epub',
    ...overrides,
  };
}

function markdownTab(overrides: Partial<ExternalOpenedTab> = {}): ExternalOpenedTab {
  return {
    kind: 'markdown',
    title: 'notes.md',
    filePath: '/docs/notes.md',
    ...overrides,
  };
}

type RevealFailPoint = 'unminimize' | 'show' | 'setFocus';

function fakeWindow(
  order: string[],
  failAt?: RevealFailPoint | {
    fail?: RevealFailPoint | readonly RevealFailPoint[];
    minimized?: boolean;
    visible?: boolean;
  },
): RevealableWindow {
  const config = typeof failAt === 'string' || failAt === undefined ? { fail: failAt } : failAt;
  const failSet = new Set<RevealFailPoint>(
    config.fail === undefined
      ? []
      : typeof config.fail === 'string'
        ? [config.fail]
        : [...config.fail],
  );
  const win: RevealableWindow = {
    unminimize: async () => {
      order.push('unminimize');
      if (failSet.has('unminimize')) throw new Error('unminimize failed');
    },
    show: async () => {
      order.push('show');
      if (failSet.has('show')) throw new Error('show failed');
    },
    setFocus: async () => {
      order.push('setFocus');
      if (failSet.has('setFocus')) throw new Error('setFocus failed');
    },
  };
  if (config.minimized !== undefined) {
    win.isMinimized = async () => config.minimized === true;
  }
  if (config.visible !== undefined) {
    win.isVisible = async () => config.visible === true;
  }
  return win;
}

function harness(
  options: {
    tab?: ExternalOpenedTab | null;
    openError?: Error;
    restored?: boolean;
    restoreError?: Error;
    start?: 'shelf' | 'editor' | 'reader';
    locale?: ExternalOpenDeps['locale'];
  } = {},
): {
  workspace: ReturnType<typeof createWorkspaceMode>;
  deps: ExternalOpenDeps;
  order: string[];
  reportOpen: ReturnType<typeof vi.fn>;
} {
  const workspace = createWorkspaceMode();
  if (options.start === 'editor') {
    workspace.enterEditor();
  } else if (options.start === 'reader') {
    workspace.openBook();
  }

  const order: string[] = [];
  const reportOpen = vi.fn();
  const deps = {
    openPath: vi.fn(async (path: string) => {
      order.push(`open:${path}`);
      if (options.openError !== undefined) {
        throw options.openError;
      }
      return options.tab === undefined ? null : options.tab;
    }),
    workspace: {
      openBook: () => {
        order.push('openBook');
        workspace.openBook();
      },
      enterEditor: () => {
        order.push('enterEditor');
        workspace.enterEditor();
      },
      enterReader: () => {
        order.push('enterReader');
        workspace.enterReader();
      },
    },
    notify: vi.fn(),
    // Both names: sibling impl briefly flipped between these two fields.
    reportOpenFailure: reportOpen,
    reportOpenFailed: reportOpen,
    restoreWindow: vi.fn(async () => {
      order.push('restore');
      if (options.restoreError !== undefined) {
        throw options.restoreError;
      }
      return options.restored !== false;
    }),
    locale: options.locale,
  } as ExternalOpenDeps;

  return { workspace, deps, order, reportOpen };
}

function notifyOf(
  deps: ExternalOpenDeps,
  kind: 'success' | 'warning' | 'error' | 'info',
): unknown[][] {
  return vi.mocked(deps.notify).mock.calls.filter((call) => call[1] === kind);
}

describe('displayNameForExternalOpen', () => {
  it('prefers a non-empty tab title and falls back to the file name', () => {
    expect(displayNameForExternalOpen('/books/dune.epub', { title: 'Dune' })).toBe('Dune');
    expect(displayNameForExternalOpen('/library/Chapter 1.epub', { title: '  ' })).toBe(
      'Chapter 1.epub',
    );
    expect(displayNameForExternalOpen('/library/Chapter 1.epub', null)).toBe('Chapter 1.epub');
    expect(displayNameForExternalOpen('/cache/%E4%B8%89%E4%BD%93.epub', null)).toBe('三体.epub');
  });
});

describe('applyExternalOpenSurface', () => {
  it('lands an ebook on the reader page even when the editor was showing', () => {
    const workspace = createWorkspaceMode();
    workspace.enterEditor();
    expect(applyExternalOpenSurface(ebookTab(), workspace)).toBe('reader');
    expect(workspace.surface).toBe('reader');
    expect(workspace.hasOpenBook).toBe(true);
  });

  it('lands Markdown on the editor from the shelf', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.surface).toBe('shelf');
    expect(applyExternalOpenSurface(markdownTab(), workspace)).toBe('editor');
    expect(workspace.surface).toBe('editor');
  });
});

describe('revealExistingWindow', () => {
  it('unminimizes, shows, and focuses in that order', async () => {
    const order: string[] = [];
    await expect(revealExistingWindow(async () => fakeWindow(order))).resolves.toBe(true);
    expect(order).toEqual(['unminimize', 'show', 'setFocus']);
  });

  it('still treats the window as shown when focus cannot be stolen', async () => {
    const order: string[] = [];
    await expect(
      revealExistingWindow(async () => fakeWindow(order, 'setFocus')),
    ).resolves.toBe(true);
    expect(order).toEqual(['unminimize', 'show', 'setFocus']);
  });

  it('treats an already-visible window as restored when unminimize and show throw', async () => {
    const order: string[] = [];
    await expect(
      revealExistingWindow(async () =>
        fakeWindow(order, {
          fail: ['unminimize', 'show'],
          minimized: false,
          visible: true,
        }),
      ),
    ).resolves.toBe(true);
    expect(order).toEqual(['unminimize', 'show', 'setFocus']);
  });

  it('returns false when the window stays minimized and restore calls fail', async () => {
    const order: string[] = [];
    await expect(
      revealExistingWindow(async () =>
        fakeWindow(order, {
          fail: ['unminimize', 'show'],
          minimized: true,
          visible: false,
        }),
      ),
    ).resolves.toBe(false);
    expect(order).toEqual(['unminimize', 'show', 'setFocus']);
  });

  it('treats a missing native window as already visible', async () => {
    await expect(revealExistingWindow(async () => null)).resolves.toBe(true);
  });
});

describe('handleExternalOpen (running instance)', () => {
  it('restores the window before opening, even when the file is missing', async () => {
    const { deps, order, reportOpen } = harness();

    await expect(handleExternalOpen('/missing.md', 'running', deps)).resolves.toBeNull();

    expect(order[0]).toBe('restore');
    expect(order).toContain('open:/missing.md');
    expect(deps.restoreWindow).toHaveBeenCalledOnce();
    expect(deps.openPath).toHaveBeenCalledWith('/missing.md');
    expect(reportOpen).toHaveBeenCalledWith('/missing.md');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
  });

  it('opens an ebook onto the reader surface and shows a short success notify', async () => {
    const tab = ebookTab();
    const { workspace, deps, reportOpen } = harness({ tab, start: 'editor' });

    await expect(handleExternalOpen(tab.filePath!, 'running', deps)).resolves.toBe(tab);

    expect(workspace.surface).toBe('reader');
    expect(workspace.hasOpenBook).toBe(true);
    expect(reportOpen).not.toHaveBeenCalled();
    const success = notifyOf(deps, 'success');
    expect(success).toHaveLength(1);
    expect(success[0][0]).toBe(EXTERNAL_OPEN_LABELS.en.opened(tab.title));
  });

  it('opens Markdown onto the editor surface and shows a short success notify', async () => {
    const tab = markdownTab();
    const { workspace, deps, order, reportOpen } = harness({ tab, start: 'shelf' });

    await expect(handleExternalOpen(tab.filePath!, 'running', deps)).resolves.toBe(tab);

    expect(workspace.surface).toBe('editor');
    expect(order).toContain('enterEditor');
    expect(order).not.toContain('openBook');
    expect(reportOpen).not.toHaveBeenCalled();
    const success = notifyOf(deps, 'success');
    expect(success).toHaveLength(1);
    expect(success[0][0]).toBe(EXTERNAL_OPEN_LABELS.en.opened(tab.title));
  });

  it('uses the file name in the success notify when the tab has no title', async () => {
    const tab = ebookTab({ title: '', filePath: '/library/Chapter 1.epub' });
    const { deps } = harness({ tab });

    await handleExternalOpen(tab.filePath!, 'running', deps);

    expect(notifyOf(deps, 'success')[0][0]).toBe(
      EXTERNAL_OPEN_LABELS.en.opened('Chapter 1.epub'),
    );
  });

  it('on open failure still restores the window and uses the existing error dialog', async () => {
    const { workspace, deps, reportOpen } = harness({ tab: null, start: 'shelf' });

    await expect(handleExternalOpen('/gone.epub', 'running', deps)).resolves.toBeNull();

    expect(deps.restoreWindow).toHaveBeenCalledOnce();
    expect(reportOpen).toHaveBeenCalledWith('/gone.epub');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
    expect(workspace.surface).toBe('shelf');
    expect(workspace.hasOpenBook).toBe(false);
  });

  it('treats an openPath throw as a visible failure, not a silent no-op', async () => {
    const { workspace, deps, reportOpen } = harness({
      openError: new Error('unreadable'),
      start: 'editor',
    });

    await expect(handleExternalOpen('/docs/lost.md', 'running', deps)).resolves.toBeNull();

    expect(deps.restoreWindow).toHaveBeenCalledOnce();
    expect(reportOpen).toHaveBeenCalledWith('/docs/lost.md');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
    expect(workspace.surface).toBe('editor');
  });

  it('still switches surface and warns when restore fails after a successful open', async () => {
    const tab = ebookTab();
    const { workspace, deps, reportOpen } = harness({
      tab,
      restored: false,
      start: 'editor',
    });

    await expect(handleExternalOpen(tab.filePath!, 'running', deps)).resolves.toBe(tab);

    expect(workspace.surface).toBe('reader');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
    const warnings = notifyOf(deps, 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toBe(EXTERNAL_OPEN_LABELS.en.revealFailed(tab.title));
    expect(reportOpen).not.toHaveBeenCalled();
  });

  it('does not warn revealFailed when an already-visible restore succeeds', async () => {
    const tab = markdownTab();
    const order: string[] = [];
    const { deps, reportOpen } = harness({ tab, start: 'shelf' });
    Object.assign(deps, {
      restoreWindow: vi.fn(async () =>
        revealExistingWindow(async () =>
          fakeWindow(order, {
            fail: ['unminimize', 'show'],
            minimized: false,
            visible: true,
          }),
        ),
      ),
    });

    await expect(handleExternalOpen(tab.filePath!, 'running', deps)).resolves.toBe(tab);

    expect(notifyOf(deps, 'warning')).toHaveLength(0);
    const success = notifyOf(deps, 'success');
    expect(success).toHaveLength(1);
    expect(success[0][0]).toBe(EXTERNAL_OPEN_LABELS.en.opened(tab.title));
    expect(reportOpen).not.toHaveBeenCalled();
  });

  it('treats a throwing restore as a failed reveal and still opens the file', async () => {
    const tab = markdownTab();
    const { workspace, deps } = harness({
      tab,
      restoreError: new Error('wm denied focus'),
      start: 'shelf',
    });

    await expect(handleExternalOpen(tab.filePath!, 'running', deps)).resolves.toBe(tab);

    expect(workspace.surface).toBe('editor');
    expect(notifyOf(deps, 'warning')[0][0]).toBe(
      EXTERNAL_OPEN_LABELS.en.revealFailed(tab.title),
    );
  });
});

describe('planColdStartSurface', () => {
  const isReaderPath = (path: string): boolean => /\.(epub|pdf|cbz)$/i.test(path);

  it('keeps the shelf for a bare start and for ebooks (R3/R5)', () => {
    expect(planColdStartSurface(null, { isReaderPath, immersive: false })).toBe('shelf');
    expect(planColdStartSurface(null, { isReaderPath, immersive: true })).toBe('shelf');
    expect(planColdStartSurface('/books/dune.epub', { isReaderPath, immersive: false })).toBe(
      'shelf',
    );
    expect(planColdStartSurface('/books/dune.epub', { isReaderPath, immersive: true })).toBe(
      'shelf',
    );
  });

  it('enters the editor before opening desktop Markdown so the shelf is never built (R1)', () => {
    expect(planColdStartSurface('/docs/notes.md', { isReaderPath, immersive: false })).toBe(
      'editor',
    );
    expect(planColdStartSurface('C:\\docs\\README.MARKDOWN', { isReaderPath, immersive: false })).toBe(
      'editor',
    );
  });

  it('lets the open itself pick the reader surface on immersive platforms (R1)', () => {
    expect(planColdStartSurface('/docs/notes.md', { isReaderPath, immersive: true })).toBe(
      'open-first',
    );
  });
});

describe('handleExternalOpen (cold start)', () => {
  it('opens an ebook onto the reader surface without a success toast', async () => {
    const tab = ebookTab();
    const { workspace, deps, order, reportOpen } = harness({ tab });

    await expect(handleExternalOpen(tab.filePath!, 'cold-start', deps)).resolves.toBe(tab);

    expect(order).not.toContain('restore');
    expect(deps.restoreWindow).not.toHaveBeenCalled();
    expect(workspace.surface).toBe('reader');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
    expect(notifyOf(deps, 'warning')).toHaveLength(0);
    expect(reportOpen).not.toHaveBeenCalled();
  });

  it('opens Markdown onto the editor without a success toast', async () => {
    const tab = markdownTab();
    const { workspace, deps } = harness({ tab, start: 'shelf' });

    await handleExternalOpen(tab.filePath!, 'cold-start', deps);

    expect(deps.restoreWindow).not.toHaveBeenCalled();
    expect(workspace.surface).toBe('editor');
    expect(notifyOf(deps, 'success')).toHaveLength(0);
  });

  it('still reports a missing file through the existing error dialog', async () => {
    const { workspace, deps, reportOpen } = harness({ tab: null });

    await expect(handleExternalOpen('/boot-miss.md', 'cold-start', deps)).resolves.toBeNull();

    expect(deps.restoreWindow).not.toHaveBeenCalled();
    expect(reportOpen).toHaveBeenCalledWith('/boot-miss.md');
    expect(workspace.surface).toBe('shelf');
  });
});
