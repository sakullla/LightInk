/**
 * Zero-tab empty workspace surface for the Markdown editor.
 *
 * Shown inside `#lightink-editor-area` only when no tabs are open in the editor
 * workspace, preventing a dead blank canvas after closing the last tab (`Ctrl+W`).
 */

import { abbreviatePath, pathBaseName, pathDirName } from './app-shell.js';

export interface EditorEmptyStateLabels {
  readonly title: string;
  readonly hint: string;
  readonly newDoc: string;
  readonly newShortcut: string;
  readonly openDoc: string;
  readonly openShortcut: string;
  readonly recentHeading: string;
}

export interface EditorEmptyStateDeps {
  readonly doc?: Document;
  labels(): EditorEmptyStateLabels;
  onNew(): void;
  onOpen(): void;
  listRecents(): Promise<string[]>;
  onOpenRecent(path: string): void;
}

export interface EditorEmptyStateHandle {
  readonly element: HTMLElement;
  sync(hasOpenTabs: boolean): void;
  retranslate(): void;
}

const MARKDOWN_EXT_RE = /\.(?:md|markdown|mdown|mkd)$/i;

export function filterRecentMarkdownPaths(
  paths: readonly string[],
  limit = 5,
): string[] {
  return paths.filter((p) => MARKDOWN_EXT_RE.test(p.trim())).slice(0, Math.max(0, limit));
}

export function createEditorEmptyState(
  host: HTMLElement,
  deps: EditorEmptyStateDeps,
): EditorEmptyStateHandle {
  const doc = deps.doc ?? document;
  const root = doc.createElement('div');
  root.className = 'lightink-editor-empty';
  root.hidden = true;

  const card = doc.createElement('div');
  card.className = 'lightink-editor-empty__card';

  const titleEl = doc.createElement('h2');
  titleEl.className = 'lightink-editor-empty__title';

  const hintEl = doc.createElement('p');
  hintEl.className = 'lightink-editor-empty__hint';

  const actionsRow = doc.createElement('div');
  actionsRow.className = 'lightink-editor-empty__actions';

  const newBtn = doc.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'lightink-editor-empty__btn lightink-editor-empty__btn--primary';
  const newLabel = doc.createElement('span');
  const newKbd = doc.createElement('kbd');
  newKbd.className = 'lightink-editor-empty__kbd';
  newBtn.append(newLabel, newKbd);
  newBtn.addEventListener('click', () => deps.onNew());

  const openBtn = doc.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'lightink-editor-empty__btn';
  const openLabel = doc.createElement('span');
  const openKbd = doc.createElement('kbd');
  openKbd.className = 'lightink-editor-empty__kbd';
  openBtn.append(openLabel, openKbd);
  openBtn.addEventListener('click', () => deps.onOpen());

  actionsRow.append(newBtn, openBtn);

  const recentsSection = doc.createElement('div');
  recentsSection.className = 'lightink-editor-empty__recents';
  recentsSection.hidden = true;

  const recentsTitle = doc.createElement('div');
  recentsTitle.className = 'lightink-editor-empty__recents-title';

  const recentsList = doc.createElement('div');
  recentsList.className = 'lightink-editor-empty__recents-list';

  recentsSection.append(recentsTitle, recentsList);
  card.append(titleEl, hintEl, actionsRow, recentsSection);
  root.appendChild(card);

  let recentsEpoch = 0;

  function applyLabels(): void {
    const L = deps.labels();
    titleEl.textContent = L.title;
    hintEl.textContent = L.hint;
    newLabel.textContent = L.newDoc;
    newKbd.textContent = L.newShortcut;
    openLabel.textContent = L.openDoc;
    openKbd.textContent = L.openShortcut;
    recentsTitle.textContent = L.recentHeading;
  }

  function loadRecents(): void {
    const epoch = ++recentsEpoch;
    void deps
      .listRecents()
      .catch(() => [] as string[])
      .then((paths) => {
        if (epoch !== recentsEpoch || root.hidden) return;
        const mdPaths = filterRecentMarkdownPaths(paths);
        if (mdPaths.length === 0) {
          recentsSection.hidden = true;
          recentsList.replaceChildren();
          return;
        }
        recentsList.replaceChildren(
          ...mdPaths.map((path) => {
            const item = doc.createElement('button');
            item.type = 'button';
            item.className = 'lightink-editor-empty__recent-item';
            item.title = path;
            const name = doc.createElement('span');
            name.className = 'lightink-editor-empty__recent-name';
            name.textContent = pathBaseName(path);
            item.appendChild(name);
            const dir = pathDirName(path);
            if (dir !== '') {
              const dirSpan = doc.createElement('span');
              dirSpan.className = 'lightink-editor-empty__recent-dir';
              dirSpan.textContent = abbreviatePath(dir, 38);
              item.appendChild(dirSpan);
            }
            item.addEventListener('click', () => deps.onOpenRecent(path));
            return item;
          }),
        );
        recentsSection.hidden = false;
      });
  }

  applyLabels();

  return {
    element: root,
    sync(hasOpenTabs: boolean): void {
      if (hasOpenTabs) {
        recentsEpoch += 1;
        root.hidden = true;
        if (root.parentElement === host) {
          root.remove();
        }
        return;
      }
      applyLabels();
      root.hidden = false;
      if (root.parentElement !== host) {
        host.appendChild(root);
      }
      loadRecents();
    },
    retranslate(): void {
      applyLabels();
    },
  };
}
