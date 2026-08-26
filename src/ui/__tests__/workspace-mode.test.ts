/**
 * Session-level editor/reader workspace: cold-start shelf, two chrome
 * sets, labeled 编辑 / 阅读/书架 round-trip.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  applyWorkspaceSurface,
  applyWorkspaceVisibility,
  createWorkspaceMode,
  DEFAULT_WORKSPACE_MODE,
  parseWorkspaceMode,
  resolveWorkspaceSurface,
  workspaceChrome,
  workspaceVisibility,
} from '../workspace-mode.js';

describe('parseWorkspaceMode', () => {
  it('defaults to editor and only accepts reader', () => {
    expect(parseWorkspaceMode(null)).toBe('editor');
    expect(parseWorkspaceMode(undefined)).toBe('editor');
    expect(parseWorkspaceMode('editor')).toBe('editor');
    expect(parseWorkspaceMode('reader')).toBe('reader');
    expect(parseWorkspaceMode('shelf')).toBe('editor');
    expect(parseWorkspaceMode('other')).toBe('editor');
  });
});

describe('resolveWorkspaceSurface', () => {
  it('keeps the editor as the main surface regardless of an open book', () => {
    expect(resolveWorkspaceSurface('editor', false)).toBe('editor');
    expect(resolveWorkspaceSurface('editor', true)).toBe('editor');
  });

  it('uses the shelf when reading with no book, and the reader when a book is open', () => {
    expect(resolveWorkspaceSurface('reader', false)).toBe('shelf');
    expect(resolveWorkspaceSurface('reader', true)).toBe('reader');
  });
});

describe('workspaceChrome', () => {
  it('gives the editor and the reader two exclusive chrome sets', () => {
    expect(workspaceChrome('editor')).toBe('editor');
    expect(workspaceChrome('shelf')).toBe('reader');
    expect(workspaceChrome('reader')).toBe('reader');
  });
});

describe('workspaceVisibility', () => {
  it('shows one peer surface and hides the markdown outline outside the editor', () => {
    expect(workspaceVisibility('editor')).toEqual({
      editorVisible: true,
      shelfVisible: false,
      readerVisible: false,
      outlineHidden: false,
      editorChromeVisible: true,
      readerChromeVisible: false,
    });
    expect(workspaceVisibility('shelf')).toEqual({
      editorVisible: false,
      shelfVisible: true,
      readerVisible: false,
      outlineHidden: true,
      editorChromeVisible: false,
      readerChromeVisible: true,
    });
    expect(workspaceVisibility('reader')).toEqual({
      editorVisible: false,
      shelfVisible: false,
      readerVisible: true,
      outlineHidden: true,
      editorChromeVisible: false,
      readerChromeVisible: true,
    });
  });
});

describe('createWorkspaceMode', () => {
  it('cold-starts as the reader shelf, never the editor', () => {
    expect(DEFAULT_WORKSPACE_MODE).toBe('reader');
    const workspace = createWorkspaceMode();
    expect(workspace.mode).toBe('reader');
    expect(workspace.hasOpenBook).toBe(false);
    expect(workspace.surface).toBe('shelf');
    expect(workspace.snapshot()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('round-trips only through labeled 编辑 and 阅读/书架', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.enterEditor().surface).toBe('editor');
    expect(workspace.mode).toBe('editor');
    expect(workspace.enterReaderHome().surface).toBe('shelf');
    expect(workspace.mode).toBe('reader');
    expect(workspace.hasOpenBook).toBe(false);
  });

  it('keeps the shelf as the reader home when no book is open', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.surface).not.toBe('reader');
    expect(workspace.surface).not.toBe('editor');
  });

  it('opens a book and returns to the shelf without leaving reader mode', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
    expect(workspace.returnToShelf()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('preserves the open-book flag when returning to the editor', () => {
    const workspace = createWorkspaceMode();
    workspace.openBook();
    expect(workspace.enterEditor()).toEqual({
      mode: 'editor',
      hasOpenBook: true,
      surface: 'editor',
    });
    expect(workspace.enterReader().surface).toBe('reader');
  });

  it('does not force the reader workspace when a book opens from the editor', () => {
    const workspace = createWorkspaceMode();
    workspace.enterEditor();
    expect(workspace.openBook()).toEqual({
      mode: 'editor',
      hasOpenBook: true,
      surface: 'editor',
    });
  });

  it('reveals the reader surface when a book opens while the shelf is showing', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
  });

  it('toggleMode preserves the open-book flag', () => {
    const workspace = createWorkspaceMode();
    workspace.openBook();
    expect(workspace.toggleMode().surface).toBe('editor');
    expect(workspace.hasOpenBook).toBe(true);
    expect(workspace.toggleMode().surface).toBe('reader');
  });

  it('enterReaderHome always lands on the shelf, even if a book was open', () => {
    const workspace = createWorkspaceMode();
    workspace.openBook();
    workspace.enterEditor();
    expect(workspace.enterReaderHome()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('toggleLibraryEntry never sends the shelf to the editor', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.surface).toBe('shelf');
    expect(workspace.toggleLibraryEntry()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    workspace.enterEditor();
    expect(workspace.toggleLibraryEntry().surface).toBe('shelf');
    expect(workspace.mode).toBe('reader');
    workspace.openBook();
    expect(workspace.toggleLibraryEntry()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
  });

  it('closeReaderTab returns to the shelf and never enters the editor', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.closeReaderTab()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    workspace.openBook();
    expect(workspace.closeReaderTab()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    workspace.enterEditor();
    workspace.openBook();
    expect(workspace.closeReaderTab()).toEqual({
      mode: 'editor',
      hasOpenBook: true,
      surface: 'editor',
    });
  });

  it('rejects unknown setMode values as editor', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.setMode('shelf' as 'editor').mode).toBe('editor');
  });

  it('notifies subscribers only when the snapshot changes', () => {
    const workspace = createWorkspaceMode();
    const listener = vi.fn();
    const unsubscribe = workspace.subscribe(listener);
    workspace.setMode('reader');
    expect(listener).not.toHaveBeenCalled();
    workspace.enterEditor();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual({
      mode: 'editor',
      hasOpenBook: false,
      surface: 'editor',
    });
    unsubscribe();
    workspace.enterReaderHome();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps independent session instances and never writes localStorage', () => {
    const first = createWorkspaceMode();
    const second = createWorkspaceMode();
    first.enterEditor();
    expect(second.mode).toBe('reader');
    expect(second.surface).toBe('shelf');

    const storage = {
      getItem: vi.fn(() => 'editor'),
      setItem: vi.fn(),
    };
    const original = (globalThis as unknown as { localStorage?: typeof storage }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
    try {
      const workspace = createWorkspaceMode();
      workspace.enterEditor();
      workspace.openBook();
      workspace.enterReaderHome();
      expect(workspace.mode).toBe('reader');
      expect(workspace.surface).toBe('shelf');
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete (globalThis as unknown as { localStorage?: typeof storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: original,
        });
      }
    }
  });
});

describe('createWorkspaceMode editorEnabled:false（Android 阅读侧裁剪 R6）', () => {
  it('cold-starts as the shelf and enterEditor is a no-op', () => {
    const workspace = createWorkspaceMode({ editorEnabled: false });
    expect(workspace.snapshot()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    expect(workspace.enterEditor()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    expect(workspace.mode).toBe('reader');
    expect(workspace.surface).toBe('shelf');
  });

  it('clamps setMode/toggleMode so the editor stays unreachable', () => {
    const workspace = createWorkspaceMode({ editorEnabled: false });
    expect(workspace.setMode('editor').mode).toBe('reader');
    expect(workspace.toggleMode().mode).toBe('reader');
    expect(workspace.toggleMode().surface).toBe('shelf');
  });

  it('keeps reader-side transitions working and never notifies on suppressed entries', () => {
    const workspace = createWorkspaceMode({ editorEnabled: false });
    const listener = vi.fn();
    workspace.subscribe(listener);
    workspace.enterEditor();
    workspace.setMode('editor');
    workspace.toggleMode();
    expect(listener).not.toHaveBeenCalled();

    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
    workspace.enterEditor();
    expect(workspace.surface).toBe('reader');
    expect(workspace.returnToShelf()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    expect(workspace.enterReaderHome().surface).toBe('shelf');
    expect(workspace.closeReaderTab().surface).toBe('shelf');
  });

  it('editorEnabled defaults to true (desktop behavior unchanged)', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.enterEditor().surface).toBe('editor');
    const explicit = createWorkspaceMode({ editorEnabled: true });
    expect(explicit.enterEditor().surface).toBe('editor');
  });
});

describe('applyWorkspaceSurface', () => {
  it('stamps mode and surface dataset plus exclusive surface classes', () => {
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
    applyWorkspaceSurface(root, { mode: 'reader', surface: 'shelf' });
    expect(root.dataset.workspaceMode).toBe('reader');
    expect(root.dataset.workspaceSurface).toBe('shelf');
    expect(classNames.has('is-workspace-shelf')).toBe(true);
    expect(classNames.has('is-workspace-editor')).toBe(false);
    expect(classNames.has('is-workspace-reader')).toBe(false);

    applyWorkspaceSurface(root, { mode: 'reader', surface: 'reader' });
    expect(root.dataset.workspaceSurface).toBe('reader');
    expect(classNames.has('is-workspace-reader')).toBe(true);
    expect(classNames.has('is-workspace-shelf')).toBe(false);

    classNames.add('is-reader-chrome-revealed');
    applyWorkspaceSurface(root, { mode: 'reader', surface: 'shelf' });
    expect(classNames.has('is-reader-chrome-revealed')).toBe(false);
  });
});

describe('applyWorkspaceVisibility', () => {
  it('hides the editor when the shelf is the workspace, instead of overlaying it', () => {
    const editor = { hidden: false };
    const shelf = { hidden: true };
    const reader = { hidden: true };
    applyWorkspaceVisibility({ editor, shelf, reader }, 'shelf');
    expect(editor.hidden).toBe(true);
    expect(shelf.hidden).toBe(false);
    expect(reader.hidden).toBe(true);

    applyWorkspaceVisibility({ editor, shelf, reader }, 'reader');
    expect(editor.hidden).toBe(true);
    expect(shelf.hidden).toBe(true);
    expect(reader.hidden).toBe(false);

    applyWorkspaceVisibility({ editor, shelf, reader }, 'editor');
    expect(editor.hidden).toBe(false);
    expect(shelf.hidden).toBe(true);
    expect(reader.hidden).toBe(true);
  });
});

describe('R5 markdown chrome: Android/touch opens Markdown as reader', () => {
  it('Android (editorEnabled:false) openBook lands on reader, not the editor', () => {
    const workspace = createWorkspaceMode({ editorEnabled: false });
    expect(workspace.enterEditor()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    expect(workspace.openBook()).toEqual({
      mode: 'reader',
      hasOpenBook: true,
      surface: 'reader',
    });
    expect(workspace.surface).not.toBe('editor');
    expect(workspaceChrome(workspace.surface)).toBe('reader');
    expect(workspaceVisibility(workspace.surface).readerChromeVisible).toBe(true);
    expect(workspaceVisibility(workspace.surface).editorChromeVisible).toBe(false);
  });

  it('tapping createReaderChrome backToShelf is returnToShelf → shelf', () => {
    const workspace = createWorkspaceMode({ editorEnabled: false });
    workspace.openBook();
    expect(workspace.returnToShelf()).toEqual({
      mode: 'reader',
      hasOpenBook: false,
      surface: 'shelf',
    });
    expect(workspace.enterEditor().surface).toBe('shelf');
  });

  it('desktop still enters the editor for Markdown and keeps the editor entry', () => {
    const workspace = createWorkspaceMode();
    expect(workspace.enterEditor()).toEqual({
      mode: 'editor',
      hasOpenBook: false,
      surface: 'editor',
    });
    expect(workspaceChrome(workspace.surface)).toBe('editor');
    expect(workspaceVisibility('editor').editorChromeVisible).toBe(true);
    expect(workspaceVisibility('editor').readerChromeVisible).toBe(false);
    expect(workspace.openBook().surface).toBe('editor');
    expect(createWorkspaceMode({ editorEnabled: true }).enterEditor().surface).toBe('editor');
  });

  it('stamps is-workspace-reader for an open Markdown book, not is-workspace-editor', () => {
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
    const workspace = createWorkspaceMode({ editorEnabled: false });
    applyWorkspaceSurface(root, workspace.openBook());
    expect(root.dataset.workspaceSurface).toBe('reader');
    expect(classNames.has('is-workspace-reader')).toBe(true);
    expect(classNames.has('is-workspace-editor')).toBe(false);
    expect(classNames.has('is-reader-chrome-revealed')).toBe(false);

    applyWorkspaceSurface(root, workspace.returnToShelf());
    expect(classNames.has('is-workspace-shelf')).toBe(true);
    expect(classNames.has('is-workspace-reader')).toBe(false);
    expect(classNames.has('is-reader-chrome-revealed')).toBe(false);
  });
});
