/**
 * Session-level editor/reader workspace (R1).
 *
 * Owns `editor | reader` for the current process only. Never writes
 * localStorage, so cold start and module init are always the reader
 * shelf. `main.ts` and `app-shell` consume snapshots and apply
 * visibility; this module does not touch tab-manager or LibraryView.
 *
 * Surfaces:
 *   - editor: Markdown editor and existing markdown tabs
 *   - shelf:  library as the reader-mode home (a workspace panel, not an overlay)
 *   - reader: an opened book; return-to-shelf stays in reader mode
 *
 * Round-trip is only `enterEditor()` (labeled 编辑) and
 * `enterReaderHome()` (labeled 阅读/书架). `toggleLibraryEntry` must
 * not send the shelf to the editor.
 */

export type WorkspaceMode = 'editor' | 'reader';
export type WorkspaceSurface = 'editor' | 'shelf' | 'reader';
/** Two exclusive chrome sets: editor menus/tabs vs reader shell. */
export type WorkspaceChrome = 'editor' | 'reader';

export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'reader';

export interface WorkspaceModeOptions {
  /**
   * Android 阅读侧裁剪（R6）：false 时编辑器不可达——`enterEditor`、
   * `setMode('editor')`、`toggleMode` 全部为空操作，工作区始终停留在
   * reader（无打开书时默认 surface 即书架）。缺省 true，桌面行为不变。
   */
  editorEnabled?: boolean;
}

export interface WorkspaceSnapshot {
  readonly mode: WorkspaceMode;
  readonly hasOpenBook: boolean;
  readonly surface: WorkspaceSurface;
}

export interface WorkspaceVisibility {
  readonly editorVisible: boolean;
  readonly shelfVisible: boolean;
  readonly readerVisible: boolean;
  /** Markdown outline is hidden while the reader workspace is showing. */
  readonly outlineHidden: boolean;
  /** File/Edit/Insert/View menus and the Markdown tab bar. */
  readonly editorChromeVisible: boolean;
  /** Reader shell (shelf cover wall or open book). Exclusive with editor chrome. */
  readonly readerChromeVisible: boolean;
}

export interface WorkspaceSurfaceRoots {
  editor?: { hidden: boolean };
  shelf?: { hidden: boolean };
  reader?: { hidden: boolean };
}

export interface WorkspaceModeController {
  snapshot(): WorkspaceSnapshot;
  readonly mode: WorkspaceMode;
  readonly hasOpenBook: boolean;
  readonly surface: WorkspaceSurface;
  /** Switch workspace. Does not change whether a book is open. */
  setMode(mode: WorkspaceMode): WorkspaceSnapshot;
  /** Labeled 编辑: show the editor shell. Does not change the open-book flag. */
  enterEditor(): WorkspaceSnapshot;
  enterReader(): WorkspaceSnapshot;
  /** View-menu editor ↔ reader. Preserves the open-book flag. */
  toggleMode(): WorkspaceSnapshot;
  /**
   * Mark a book open. Does not change mode — File→Open of a PDF in the
   * editor workspace still leaves the editor as the main surface.
   */
  openBook(): WorkspaceSnapshot;
  /**
   * Clear the open-book flag. When already in reader mode this returns
   * to the shelf without leaving the reader workspace.
   */
  returnToShelf(): WorkspaceSnapshot;
  /** Labeled 阅读/书架: reader mode with the shelf as the main surface. */
  enterReaderHome(): WorkspaceSnapshot;
  /**
   * Retired File→书库 mapping. Never leaves the reader workspace for
   * the editor: any call lands on the shelf.
   */
  toggleLibraryEntry(): WorkspaceSnapshot;
  /**
   * Reader-mode close-tab. With an open book, same as closing the book
   * (return to shelf). On the shelf, stay there — do not enter the
   * editor and do not imply a window close.
   */
  closeReaderTab(): WorkspaceSnapshot;
  subscribe(listener: (state: WorkspaceSnapshot) => void): () => void;
}

export function parseWorkspaceMode(raw: unknown): WorkspaceMode {
  return raw === 'reader' ? 'reader' : 'editor';
}

export function resolveWorkspaceSurface(
  mode: WorkspaceMode,
  hasOpenBook: boolean,
): WorkspaceSurface {
  if (mode === 'editor') {
    return 'editor';
  }
  return hasOpenBook ? 'reader' : 'shelf';
}

export function workspaceChrome(surface: WorkspaceSurface): WorkspaceChrome {
  return surface === 'editor' ? 'editor' : 'reader';
}

export function workspaceVisibility(surface: WorkspaceSurface): WorkspaceVisibility {
  const editorChromeVisible = surface === 'editor';
  return {
    editorVisible: surface === 'editor',
    shelfVisible: surface === 'shelf',
    readerVisible: surface === 'reader',
    outlineHidden: surface !== 'editor',
    editorChromeVisible,
    readerChromeVisible: !editorChromeVisible,
  };
}

export function applyWorkspaceSurface(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  snapshot: Pick<WorkspaceSnapshot, 'mode' | 'surface'>,
): void {
  root.dataset.workspaceMode = snapshot.mode;
  root.dataset.workspaceSurface = snapshot.surface;
  root.classList.toggle('is-workspace-editor', snapshot.surface === 'editor');
  root.classList.toggle('is-workspace-shelf', snapshot.surface === 'shelf');
  root.classList.toggle('is-workspace-reader', snapshot.surface === 'reader');
  if (snapshot.surface !== 'reader') {
    root.classList.toggle('is-reader-chrome-revealed', false);
  }
}

/**
 * Show exactly one main surface. Shelf and reader are peers of the
 * editor, not overlays stacked on top of a Markdown tab.
 */
export function applyWorkspaceVisibility(
  roots: WorkspaceSurfaceRoots,
  surface: WorkspaceSurface,
): void {
  const vis = workspaceVisibility(surface);
  if (roots.editor !== undefined) {
    roots.editor.hidden = !vis.editorVisible;
  }
  if (roots.shelf !== undefined) {
    roots.shelf.hidden = !vis.shelfVisible;
  }
  if (roots.reader !== undefined) {
    roots.reader.hidden = !vis.readerVisible;
  }
}

export function createWorkspaceMode(options?: WorkspaceModeOptions): WorkspaceModeController {
  const editorEnabled = options?.editorEnabled ?? true;
  let mode: WorkspaceMode = DEFAULT_WORKSPACE_MODE;
  let hasOpenBook = false;
  const listeners = new Set<(state: WorkspaceSnapshot) => void>();

  function snapshot(): WorkspaceSnapshot {
    return {
      mode,
      hasOpenBook,
      surface: resolveWorkspaceSurface(mode, hasOpenBook),
    };
  }

  function commit(nextMode: WorkspaceMode, nextOpen: boolean): WorkspaceSnapshot {
    if (mode === nextMode && hasOpenBook === nextOpen) {
      return snapshot();
    }
    mode = nextMode;
    hasOpenBook = nextOpen;
    const state = snapshot();
    for (const listener of [...listeners]) {
      listener(state);
    }
    return state;
  }

  return {
    snapshot,
    get mode() {
      return mode;
    },
    get hasOpenBook() {
      return hasOpenBook;
    },
    get surface() {
      return resolveWorkspaceSurface(mode, hasOpenBook);
    },
    setMode(next) {
      const parsed = parseWorkspaceMode(next);
      return commit(editorEnabled ? parsed : 'reader', hasOpenBook);
    },
    enterEditor() {
      if (!editorEnabled) {
        return snapshot();
      }
      return commit('editor', hasOpenBook);
    },
    enterReader() {
      return commit('reader', hasOpenBook);
    },
    toggleMode() {
      if (!editorEnabled) {
        return snapshot();
      }
      return commit(mode === 'editor' ? 'reader' : 'editor', hasOpenBook);
    },
    openBook() {
      return commit(mode, true);
    },
    returnToShelf() {
      return commit(mode, false);
    },
    enterReaderHome() {
      return commit('reader', false);
    },
    toggleLibraryEntry() {
      return commit('reader', false);
    },
    closeReaderTab() {
      if (mode !== 'reader') {
        return snapshot();
      }
      return commit('reader', false);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
