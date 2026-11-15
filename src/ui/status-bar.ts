/** Document persistence, position, encoding, and word statistics status bar. */

import { computeWordStats, type WordStats } from '../editor/word-stats.js';
import type { CursorPosition } from '../editor/types.js';
import type { ReaderPhase, ReaderState } from '../reader/types.js';
import type { DocumentSaveStatus } from '../tabs/types.js';
import type { StorageLike } from './chrome-prefs.js';

export const STATUS_BAR_VISIBLE_STORAGE_KEY = 'lightink.statusBar.visible';

// 纸墨工作室 §3.14：字数/保存状态是写作者的基本反馈，默认开启；
// 已显式保存过偏好的用户不受影响（loadStatusBarVisible 先读存储）。
const DEFAULT_VISIBLE = true;
const DEFAULT_DEBOUNCE_MS = 120;

export function loadStatusBarVisible(storage: StorageLike | null | undefined): boolean {
  if (storage == null) return DEFAULT_VISIBLE;
  try {
    const raw = storage.getItem(STATUS_BAR_VISIBLE_STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_VISIBLE;
    return JSON.parse(raw) === true;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

export function saveStatusBarVisible(
  storage: StorageLike | null | undefined,
  visible: boolean,
): void {
  if (storage == null) return;
  try {
    storage.setItem(STATUS_BAR_VISIBLE_STORAGE_KEY, JSON.stringify(visible === true));
  } catch {
    // Privacy mode or quota failures must not affect editing.
  }
}

export interface StatusBarLabels {
  words: string;
  characters: string;
  selected?: string;
  readingTime?: (minutes: number) => string;
  mode?: {
    readonly wysiwyg: string;
    readonly source: string;
    readonly toggleTitle: string;
  };
  saveClickHint?: string;
  line: string;
  column: string;
  encoding: string;
  save: Readonly<Record<DocumentSaveStatus, string>>;
  reader: {
    readonly phase: Readonly<Record<ReaderPhase, string>>;
    readonly page: string;
    readonly chapter: string;
    readonly progress: string;
    readonly zoom: string;
  };
}

export interface MarkdownStatusSnapshot {
  readonly kind: 'markdown';
  readonly markdown: string;
  readonly saveStatus: DocumentSaveStatus;
  readonly cursor: CursorPosition;
  /** Optional non-empty selected text so writers see selection counts vs total. */
  readonly selectionMarkdown?: string;
  /** Optional active editing mode (`wysiwyg` | `source`) for mode indicator/toggle. */
  readonly editorMode?: 'wysiwyg' | 'source';
}

export interface ReaderStatusSnapshot {
  readonly kind: 'reader';
  readonly state: ReaderState;
  /** Renderer scale combined with the application-wide reading scale. */
  readonly displayScale: number;
}

export type StatusBarSnapshot = MarkdownStatusSnapshot | ReaderStatusSnapshot | null;

export function formatWordStats(stats: WordStats, labels: StatusBarLabels): string {
  return `${labels.words} ${formatCount(stats.words)} · ${labels.characters} ${formatCount(stats.characters)}`;
}

/** Estimate reading duration in minutes (~300 CJK chars / Latin words per minute). */
export function estimateReadingMinutes(stats: WordStats): number {
  if (stats.words <= 0) return 0;
  return Math.max(1, Math.ceil(stats.words / 300));
}

export function formatSelectionWordStats(
  selection: WordStats,
  total: WordStats,
  labels: StatusBarLabels,
): string {
  const prefix = labels.selected ?? labels.words;
  return `${prefix} ${formatCount(selection.words)} / ${formatCount(total.words)} · ${labels.characters} ${formatCount(selection.characters)} / ${formatCount(total.characters)}`;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

function formatPercent(value: number): string {
  const normalized = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return `${Math.round(normalized * 100)}%`;
}

function formatScale(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 1;
  return `${Math.round(normalized * 100)}%`;
}

/** Convert a UTF-16 textarea offset to a one-based Unicode code-point position. */
export function cursorPositionFromOffset(text: string, offset: number): CursorPosition {
  const safeOffset = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const lines = text.slice(0, safeOffset).split(/\r\n?|\n/);
  return {
    line: lines.length,
    column: Array.from(lines[lines.length - 1] ?? '').length + 1,
  };
}

export interface StatusBarOptions {
  storage?: StorageLike | null;
  labels: () => StatusBarLabels;
  debounceMs?: number;
  initiallyVisible?: boolean;
  onToggleMode?: () => void;
  onSaveClick?: () => void;
}

export interface StatusBar {
  readonly element: HTMLDivElement;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  toggle(): boolean;
  refresh(getSnapshot: () => StatusBarSnapshot): void;
  scheduleUpdate(getSnapshot: () => StatusBarSnapshot): void;
  destroy(): void;
}

function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Privacy mode.
  }
  return null;
}

export function createStatusBar(
  doc: Pick<Document, 'createElement'>,
  host: HTMLElement,
  options: StatusBarOptions,
): StatusBar {
  const storage = resolveStorage(options.storage);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let visible = options.initiallyVisible ?? loadStatusBarVisible(storage);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastGetter: (() => StatusBarSnapshot) | null = null;

  const element = doc.createElement('div') as HTMLDivElement;
  element.id = 'lightink-status-bar';
  element.className = 'lightink-status-bar';

  const persistence = doc.createElement('span') as HTMLSpanElement;
  persistence.className = 'lightink-status-save';
  persistence.setAttribute('role', 'status');
  persistence.setAttribute('aria-live', 'polite');
  persistence.setAttribute('aria-atomic', 'true');
  if (options.onSaveClick !== undefined && typeof persistence.addEventListener === 'function') {
    persistence.addEventListener('click', () => {
      if (element.dataset.saveStatus === 'dirty') {
        options.onSaveClick?.();
      }
    });
    persistence.addEventListener('keydown', (event) => {
      if (
        element.dataset.saveStatus === 'dirty' &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault();
        options.onSaveClick?.();
      }
    });
  }
  const details = doc.createElement('span') as HTMLSpanElement;
  details.className = 'lightink-status-details';
  const modeChip = doc.createElement('button') as HTMLButtonElement;
  modeChip.type = 'button';
  modeChip.className = 'lightink-status-mode';
  modeChip.hidden = true;
  if (options.onToggleMode !== undefined && typeof modeChip.addEventListener === 'function') {
    modeChip.addEventListener('click', () => {
      options.onToggleMode?.();
    });
  }
  const position = doc.createElement('span') as HTMLSpanElement;
  position.className = 'lightink-status-position';
  const encoding = doc.createElement('span') as HTMLSpanElement;
  encoding.className = 'lightink-status-encoding';
  const counts = doc.createElement('span') as HTMLSpanElement;
  counts.className = 'lightink-status-counts';
  details.append(modeChip, position, encoding, counts);
  element.append(persistence, details);

  function applyVisibility(): void {
    if (visible) {
      if (element.parentNode !== host) host.appendChild(element);
    } else {
      element.remove();
    }
  }

  function render(getter: () => StatusBarSnapshot): void {
    lastGetter = getter;
    if (!visible) return;
    let snapshot: StatusBarSnapshot = null;
    try {
      snapshot = getter();
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      element.hidden = true;
      persistence.hidden = false;
      modeChip.hidden = true;
      modeChip.textContent = '';
      delete element.dataset.saveStatus;
      delete element.dataset.readerPhase;
      delete element.dataset.statusKind;
      return;
    }

    const labels = options.labels();
    element.hidden = false;
    element.dataset.statusKind = snapshot.kind;
    if (snapshot.kind === 'markdown') {
      delete element.dataset.readerPhase;
      element.dataset.saveStatus = snapshot.saveStatus;
      persistence.hidden = false;
      persistence.textContent = labels.save[snapshot.saveStatus];
      const canClickSave =
        snapshot.saveStatus === 'dirty' && options.onSaveClick !== undefined;
      if (canClickSave) {
        persistence.dataset.clickable = 'true';
        persistence.tabIndex = 0;
        if (labels.saveClickHint !== undefined) {
          persistence.title = labels.saveClickHint;
        }
      } else {
        delete persistence.dataset.clickable;
        persistence.tabIndex = -1;
        persistence.title = '';
      }

      if (snapshot.editorMode !== undefined && labels.mode !== undefined) {
        modeChip.hidden = false;
        modeChip.dataset.editorMode = snapshot.editorMode;
        modeChip.textContent =
          snapshot.editorMode === 'source' ? labels.mode.source : labels.mode.wysiwyg;
        modeChip.title = labels.mode.toggleTitle;
        modeChip.setAttribute('aria-label', labels.mode.toggleTitle);
        modeChip.setAttribute(
          'aria-pressed',
          snapshot.editorMode === 'source' ? 'true' : 'false',
        );
      } else {
        modeChip.hidden = true;
        modeChip.textContent = '';
      }

      position.hidden = false;
      position.textContent = `${labels.line} ${snapshot.cursor.line}, ${labels.column} ${snapshot.cursor.column}`;
      encoding.hidden = false;
      encoding.textContent = labels.encoding;
      counts.hidden = false;
      const totalStats = computeWordStats(snapshot.markdown);
      const rawSel = snapshot.selectionMarkdown?.trim() ?? '';
      if (rawSel !== '') {
        counts.dataset.hasSelection = 'true';
        counts.textContent = formatSelectionWordStats(
          computeWordStats(snapshot.selectionMarkdown!),
          totalStats,
          labels,
        );
      } else {
        delete counts.dataset.hasSelection;
        const baseStats = formatWordStats(totalStats, labels);
        const mins =
          labels.readingTime !== undefined ? estimateReadingMinutes(totalStats) : 0;
        counts.textContent =
          mins > 0 && labels.readingTime !== undefined
            ? `${baseStats} · ${labels.readingTime(mins)}`
            : baseStats;
      }
      return;
    }

    modeChip.hidden = true;
    modeChip.textContent = '';
    delete persistence.dataset.clickable;
    persistence.tabIndex = -1;
    persistence.title = '';
    delete element.dataset.saveStatus;
    element.dataset.readerPhase = snapshot.state.phase;
    const ready = snapshot.state.phase === 'ready';
    persistence.hidden = ready;
    persistence.textContent = ready ? '' : labels.reader.phase[snapshot.state.phase];
    const hasPosition = ready && snapshot.state.total > 0;
    position.hidden = !hasPosition;
    encoding.hidden = !hasPosition;
    counts.hidden = !hasPosition;
    if (!hasPosition) {
      position.textContent = '';
      encoding.textContent = '';
      counts.textContent = '';
      return;
    }
    const locationLabel =
      snapshot.state.locationKind === 'chapter' ? labels.reader.chapter : labels.reader.page;
    position.textContent = `${locationLabel} ${snapshot.state.current}/${snapshot.state.total}`;
    encoding.textContent = `${labels.reader.progress} ${formatPercent(snapshot.state.progress)}`;
    counts.textContent = `${labels.reader.zoom} ${formatScale(snapshot.displayScale)}`;
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  applyVisibility();

  function setVisible(next: boolean): void {
    visible = next;
    saveStatusBarVisible(storage, visible);
    applyVisibility();
    if (visible && lastGetter !== null) render(lastGetter);
  }

  return {
    element,
    isVisible: () => visible,
    setVisible,
    toggle() {
      setVisible(!visible);
      return visible;
    },
    refresh: render,
    scheduleUpdate(getter) {
      lastGetter = getter;
      if (!visible) return;
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        render(getter);
      }, debounceMs);
    },
    destroy() {
      cancelTimer();
      element.remove();
    },
  };
}
