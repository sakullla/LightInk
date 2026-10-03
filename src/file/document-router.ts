import { isReaderLoadCancelled } from '../reader/load-lifecycle.js';
import type { TabManager } from '../tabs/tab-manager.js';
import { readerTabShowsPath } from '../tabs/reader-tab-reveal.js';
import type { ReaderTabState, TabState } from '../tabs/types.js';
import { isReaderPath } from './file-drop.js';

export interface DocumentRouterDeps {
  readonly manager: Pick<TabManager, 'tabList' | 'openFile' | 'openReader' | 'closeTab'>;
  readonly onReaderOpenError: (path: string, error: unknown) => void;
  readonly onReaderLoadError: (error: unknown) => void;
  readonly signal?: AbortSignal;
  /** Library title for the reader bar. Omitted for File → Open, which keeps the filename. */
  readonly bookTitle?: string;
}

/** Route a local path to the editor or Reader while owning failed-tab cleanup. */
export async function openDocumentPath(
  path: string,
  deps: DocumentRouterDeps,
): Promise<TabState | null> {
  if (!isReaderPath(path)) {
    return deps.manager.openFile(path);
  }

  const existing = deps.manager.tabList.find(
    (candidate): candidate is ReaderTabState =>
      candidate.kind === 'reader' && candidate.filePath === path,
  );
  let tab: ReaderTabState;
  try {
    tab = await deps.manager.openReader(path);
  } catch (error) {
    deps.onReaderOpenError(path, error);
    return null;
  }
  if (existing === tab && readerTabShowsPath(tab, path)) {
    return tab;
  }

  const bookTitle = deps.bookTitle?.trim() ?? '';
  const loadOptions = {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(bookTitle === '' ? {} : { bookTitle }),
  };
  try {
    if (deps.signal === undefined && bookTitle === '') {
      await tab.reader.load(path);
    } else {
      await tab.reader.load(path, loadOptions);
    }
  } catch (error) {
    await deps.manager.closeTab(tab.id).catch(() => false);
    if (!isReaderLoadCancelled(error, deps.signal)) {
      deps.onReaderLoadError(error);
    }
    return null;
  }
  if (tab.reader.state?.phase === 'cancelled') {
    await deps.manager.closeTab(tab.id).catch(() => false);
    return null;
  }
  return tab;
}
