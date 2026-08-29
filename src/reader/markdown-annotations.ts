/**
 * Markdown 标注宿主：复用阅读器存储、侧栏、划选工具栏与笔记弹层。
 * 高亮经 ProseMirror decoration 画在编辑器上，不改 markdown 源文。
 */

import './reader.css';
import { findReplaceViewForHost } from '../editor/plugins/find-replace.js';
import {
  locatorFromPmSelection,
  MARKDOWN_ANNOTATION_KEY,
  setMarkdownAnnotations,
  textAnchorAtOffset,
  collectPmText,
} from '../editor/plugins/markdown-annotations.js';
import type { MessageKey } from '../i18n/messages.js';
import { createAnnotationPanel, type AnnotationPanel } from './annotation-panel.js';
import {
  AnnotationWriteQueue,
  parseAnnotations,
  removeAnnotation,
  serializeAnnotations,
  updateAnnotationNote,
  type Annotation,
  type AnnotationKind,
  type Locator,
} from './annotations.js';
import { annotationMarkFromEventTarget } from './annotation-locator.js';
import { markdownAnnotationKey } from './document-hash.js';
import { showNoteDialog } from './note-dialog.js';
import { setFormatToolbarAnnotationAction } from '../editor/plugins/format-toolbar.js';

export interface MarkdownAnnotationDeps {
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  getContentHash: (filePath: string) => Promise<string>;
  readAnnotations: (contentHash: string) => Promise<string>;
  writeAnnotations: (contentHash: string, json: string) => Promise<void>;
  notify?: (message: string) => void;
}

export interface MarkdownAnnotationHost {
  addBookmark(): void;
  addNote(): void;
  toggleSidebar(): void;
  isSidebarVisible(): boolean;
  isAnnotationEnabled(): boolean;
  syncIdentity(filePath: string | null, syntheticId: string): void;
  destroy(): void;
}

function newAnnotationId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID().slice(0, 8);
  }
  return `a-${Date.now().toString(36)}`;
}

export function createMarkdownAnnotationHost(
  host: HTMLElement,
  deps: MarkdownAnnotationDeps,
): MarkdownAnnotationHost {
  const writeQueue = new AnnotationWriteQueue();
  let annotations: Annotation[] = [];
  let contentHash: string | null = null;
  let identityKey = '';
  let sidebar: AnnotationPanel | null = null;
  let sidebarVisible = false;
  let destroyed = false;
  let loadGeneration = 0;

  const editorView = (): ReturnType<typeof findReplaceViewForHost> => findReplaceViewForHost(host);

  const applyDecorations = (): void => {
    const view = editorView();
    if (view === null) {
      return;
    }
    const current = MARKDOWN_ANNOTATION_KEY.getState(view.state);
    if (current !== undefined && current.annotations === annotations) {
      return;
    }
    setMarkdownAnnotations(view.dispatch.bind(view), view.state, annotations);
  };

  const persist = (): void => {
    if (contentHash === null) {
      return;
    }
    const hash = contentHash;
    void writeQueue.enqueue(hash, serializeAnnotations(annotations), deps.writeAnnotations, () => {
      if (!destroyed && contentHash === hash) {
        deps.notify?.(deps.t('annotation.saveFailed'));
      }
    });
  };

  const renderSidebar = (): void => {
    sidebar?.render(annotations);
  };

  const appendAnnotation = (
    kind: AnnotationKind,
    locator: Locator,
    quote: string | undefined,
    note: string | undefined,
  ): void => {
    annotations = [
      ...annotations,
      {
        id: newAnnotationId(),
        kind,
        locator,
        quote,
        note,
        createdAt: Date.now(),
      },
    ];
    applyDecorations();
    renderSidebar();
    persist();
  };

  const removeAnnotationById = (id: string): void => {
    // 删除写 tombstone（保留 id 与 deletedAt 时钟），同步合并时删除可跨端收敛。
    annotations = removeAnnotation(annotations, id);
    applyDecorations();
    renderSidebar();
    persist();
  };

  const currentLocator = (): Locator => {
    const view = editorView();
    if (view === null) {
      return { format: 'text', start: 0, end: 0, quote: '', prefix: '', suffix: '' };
    }
    const { from, to } = view.state.selection;
    return (
      locatorFromPmSelection(view.state.doc, from, to) ?? {
        format: 'text',
        ...textAnchorAtOffset(collectPmText(view.state.doc).text, 0),
      }
    );
  };

  const selectedLocator = (): { locator: Locator; quote: string } | null => {
    const view = editorView();
    if (view === null) {
      return null;
    }
    const { from, to } = view.state.selection;
    const locator = locatorFromPmSelection(view.state.doc, from, to);
    if (locator === null || locator.quote.trim() === '') {
      return null;
    }
    return { locator, quote: locator.quote };
  };

  const handleFormatAction = (action: 'highlight' | 'note' | 'copy'): void => {
    const selected = selectedLocator();
    if (selected === null) {
      return;
    }
    if (action === 'copy') {
      void navigator.clipboard?.writeText(selected.quote).catch(() => undefined);
      return;
    }
    if (action === 'note') {
      void (async () => {
        const generation = loadGeneration;
        const input = await showNoteDialog(document, '', { t: deps.t }, selected.quote);
        if (input === null || destroyed || generation !== loadGeneration) {
          return;
        }
        appendAnnotation('note', selected.locator, selected.quote, input);
      })();
      return;
    }
    appendAnnotation('highlight', selected.locator, selected.quote, undefined);
  };

  const jumpTo = (annotation: Annotation): void => {
    const view = editorView();
    if (view === null) {
      return;
    }
    const mark = view.dom.querySelector<HTMLElement>(
      `[data-annotation-id="${annotation.id.replace(/["\\]/g, '\\$&')}"]`,
    );
    mark?.scrollIntoView({ block: 'center' });
  };

  const openNote = (annotation: Annotation): void => {
    if (annotation.kind !== 'note') {
      return;
    }
    void (async () => {
      const generation = loadGeneration;
      const input = await showNoteDialog(
        document,
        annotation.note ?? '',
        { t: deps.t, editing: true },
        annotation.quote,
      );
      if (input === null || destroyed || generation !== loadGeneration) {
        return;
      }
      annotations = updateAnnotationNote(annotations, annotation.id, input);
      renderSidebar();
      persist();
    })();
  };

  const onHostClick = (event: MouseEvent): void => {
    const id = annotationMarkFromEventTarget(event.target)?.getAttribute('data-annotation-id') ?? '';
    if (id === '') {
      return;
    }
    const annotation = annotations.find((item) => item.id === id);
    if (annotation === undefined || annotation.kind !== 'note') {
      return;
    }
    openNote(annotation);
  };
  host.addEventListener('click', onHostClick);

  const ensureSidebar = (): void => {
    if (sidebar !== null) {
      return;
    }
    sidebar = createAnnotationPanel({
      t: deps.t,
      onClose: () => setSidebarVisible(false),
      onJump: jumpTo,
      onRemove: (annotation) => removeAnnotationById(annotation.id),
      onEditNote: openNote,
    });
    const chrome =
      typeof document !== 'undefined'
        ? (document.getElementById('lightink-main') ?? host.parentElement ?? host)
        : (host.parentElement ?? host);
    chrome.appendChild(sidebar.element);
    sidebar.render(annotations);
  };

  const setSidebarVisible = (visible: boolean): void => {
    sidebarVisible = visible;
    if (visible) {
      ensureSidebar();
    }
    host.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    host.parentElement?.classList.toggle('lightink-reader--sidebar', sidebarVisible);
    if (typeof document !== 'undefined') {
      document.getElementById('lightink-main')?.classList.toggle(
        'lightink-reader--sidebar',
        sidebarVisible,
      );
    }
    sidebar?.element.setAttribute('aria-hidden', sidebarVisible ? 'false' : 'true');
    document.dispatchEvent(new CustomEvent('lightink:font-scale'));
  };

  const loadForIdentity = async (filePath: string | null, syntheticId: string): Promise<void> => {
    const nextKey = markdownAnnotationKey(filePath, syntheticId);
    if (nextKey === identityKey && contentHash !== null) {
      applyDecorations();
      return;
    }
    const previousHash = contentHash;
    const previous = annotations;
    identityKey = nextKey;
    contentHash = nextKey;
    const generation = ++loadGeneration;
    try {
      const json = await deps.readAnnotations(nextKey);
      if (destroyed || generation !== loadGeneration) {
        return;
      }
      annotations = parseAnnotations(json);
      if (annotations.length === 0 && previous.length > 0 && previousHash !== null && previousHash !== nextKey) {
        annotations = previous;
        persist();
      }
    } catch {
      if (destroyed || generation !== loadGeneration) {
        return;
      }
      // 与 Rust R4 一致：读失败（含无 Tauri IPC）视为空标注，不弹窗阻断。
      annotations = [];
    }
    applyDecorations();
    renderSidebar();
  };

  // 按 scope（本标签的编辑器宿主元素）注册，多 Markdown 标签互不覆盖。
  setFormatToolbarAnnotationAction(host, handleFormatAction);

  return {
    addBookmark() {
      appendAnnotation('bookmark', currentLocator(), undefined, undefined);
    },
    addNote() {
      void (async () => {
        const generation = loadGeneration;
        const input = await showNoteDialog(document, '', { t: deps.t });
        if (input === null || destroyed || generation !== loadGeneration) {
          return;
        }
        appendAnnotation('note', currentLocator(), undefined, input);
      })();
    },
    toggleSidebar() {
      setSidebarVisible(!sidebarVisible);
    },
    isSidebarVisible() {
      return sidebarVisible;
    },
    isAnnotationEnabled() {
      return true;
    },
    syncIdentity(filePath, syntheticId) {
      void loadForIdentity(filePath, syntheticId);
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      loadGeneration += 1;
      writeQueue.invalidate();
      host.removeEventListener('click', onHostClick);
      setFormatToolbarAnnotationAction(host, null);
      sidebar?.destroy();
      sidebar = null;
      host.classList.remove('lightink-reader--sidebar');
      host.parentElement?.classList.remove('lightink-reader--sidebar');
      if (typeof document !== 'undefined') {
        document.getElementById('lightink-main')?.classList.remove('lightink-reader--sidebar');
      }
    },
  };
}
