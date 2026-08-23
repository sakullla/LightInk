/**
 * Reader-flow layout (R3).
 *
 * Owns `lightink.reader.flow.layout` (default paginated). Consumes
 * `reading-layout.ts` column/spread math and never reads or writes the
 * editor key `lightink.reading.layout`. PDF/comic hosts must not call
 * these helpers for text-column spreads.
 */

import {
  applyReadingLayout,
  DEFAULT_READING_LAYOUT,
  parseReadingLayout,
  pagedColumnStep,
  pagedSpreadMetrics,
  readingColumnLayout,
  toggleReadingLayout,
  type LayoutStorage,
  type ReadingColumnLayoutOptions,
  type ReadingLayout,
} from '../ui/reading-layout.js';
import { DEFAULT_READER_MEASURE_REM, type ReaderTypography } from './reader-typography.js';

export const READER_FLOW_LAYOUT_STORAGE_KEY = 'lightink.reader.flow.layout';

export const DEFAULT_READER_FLOW_LAYOUT: ReadingLayout = 'paginated';

/** Thin window inset; line-length gutters live on the page itself. */
export const READER_FLOW_PAGED_PADDING_X_REM = 0.75;

export type ReaderFlowLayout = ReadingLayout;

export type ReaderFlowLayoutStorage = LayoutStorage;

export function parseReaderLayout(raw: string | null | undefined): ReaderFlowLayout {
  return raw === 'scroll' ? 'scroll' : DEFAULT_READER_FLOW_LAYOUT;
}

export const parseReaderFlowLayout = parseReaderLayout;

export function loadReaderLayout(
  storage: ReaderFlowLayoutStorage | null | undefined,
): ReaderFlowLayout {
  if (storage == null) {
    return DEFAULT_READER_FLOW_LAYOUT;
  }
  try {
    return parseReaderLayout(storage.getItem(READER_FLOW_LAYOUT_STORAGE_KEY));
  } catch {
    return DEFAULT_READER_FLOW_LAYOUT;
  }
}

export const loadReaderFlowLayout = loadReaderLayout;

export function saveReaderLayout(
  storage: ReaderFlowLayoutStorage | null | undefined,
  layout: ReaderFlowLayout,
): void {
  if (storage == null) {
    return;
  }
  try {
    storage.setItem(READER_FLOW_LAYOUT_STORAGE_KEY, parseReaderLayout(layout));
  } catch {
    // Privacy mode / quota — ignore.
  }
}

export const saveReaderFlowLayout = saveReaderLayout;

export function applyReaderLayout(
  root: { dataset: DOMStringMap; classList: DOMTokenList },
  layout: ReaderFlowLayout,
): void {
  applyReadingLayout(root, parseReaderLayout(layout));
}

export const applyReaderFlowLayout = applyReaderLayout;

/**
 * Host consumers in reader-view / PDF still read html[data-reading-layout].
 * While the reader workspace is showing, that attribute must follow the
 * reader flow key (default paginated) instead of the editor key (default
 * scroll). Leaving reader mode restores the editor layout and never writes
 * either storage key.
 */
export function applyReaderDocumentLayout(
  documentRoot: { dataset: DOMStringMap; classList: DOMTokenList },
  workspaceMode: string | null | undefined,
  readerLayout: ReaderFlowLayout,
  editorLayout: ReadingLayout = DEFAULT_READING_LAYOUT,
): ReadingLayout {
  documentRoot.dataset.workspaceMode = workspaceMode === 'reader' ? 'reader' : 'editor';
  const next =
    workspaceMode === 'reader'
      ? parseReaderLayout(readerLayout)
      : parseReadingLayout(editorLayout);
  applyReadingLayout(documentRoot, next, { force: true });
  return next;
}

export function toggleReaderFlowLayout(layout: ReaderFlowLayout): ReaderFlowLayout {
  return toggleReadingLayout(parseReaderLayout(layout));
}

export function readerFlowUsesTextColumns(kind: string): boolean {
  return kind === 'flow';
}

export function readerFlowColumnOptions(
  minRem: number = DEFAULT_READER_MEASURE_REM,
): ReadingColumnLayoutOptions {
  return { minRem, optRem: minRem, maxColumns: 2 };
}

export function readerFlowColumnLayout(
  containerWidth: number,
  fontSizePx: number,
  minRem: number = DEFAULT_READER_MEASURE_REM,
): { columnWidth: number; columns: number; gap: number } {
  return readingColumnLayout(containerWidth, fontSizePx, readerFlowColumnOptions(minRem));
}

export function readerFlowSpreadMetrics(
  containerWidth: number,
  fontSizePx: number,
  minRem: number = DEFAULT_READER_MEASURE_REM,
): { width: number; columnWidth: number; columns: number; gap: number; step: number } {
  return pagedSpreadMetrics(containerWidth, fontSizePx, readerFlowColumnOptions(minRem));
}

export interface ReaderPageSpread {
  width: number;
  columnWidth: number;
  columns: number;
  gap: number;
  step: number;
  pad: number;
  measurePx: number;
}

/**
 * Readium/Thorium page metrics.
 * The paper and the text columns fill the window. A second column opens
 * once the pane can hold two readable columns (~16rem), not two copies of
 * the stored line-length — otherwise a desktop window stays one column
 * with an empty facing page. Two columns split the page evenly so
 * `column-count: 2` cannot leak a leftover sliver.
 */
export const READER_SPREAD_MIN_COLUMN_REM = 16;

export function readerPageSpread(
  containerWidth: number,
  fontSizePx: number,
  measureRem: number,
): ReaderPageSpread {
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0 ? fontSizePx : 16;
  const measurePx = Math.max(1, Math.round(measureRem * size));
  const minColumnPx = Math.round(READER_SPREAD_MIN_COLUMN_REM * size);
  const minPad = Math.max(40, Math.round(size * 2.5));
  const pairGap = Math.max(40, Math.round(size * 2.5));
  const pageWidth = Math.max(1, Math.round(containerWidth));
  if (pageWidth >= 2 * minColumnPx + pairGap) {
    const columnWidth = Math.max(1, Math.floor((pageWidth - pairGap) / 2));
    const width = columnWidth * 2 + pairGap;
    return {
      width,
      columnWidth,
      columns: 2,
      gap: pairGap,
      pad: minPad,
      measurePx,
      // Skip the gap after the right-hand column; stepping by `width` alone
      // leaves a sliver of that column on the next page (a fake third column).
      step: pagedColumnStep(width, pairGap),
    };
  }
  return {
    width: pageWidth,
    columnWidth: pageWidth,
    columns: 1,
    gap: 0,
    pad: minPad,
    measurePx,
    step: pagedColumnStep(pageWidth, 0),
  };
}

export function readerFlowSpreadFromTypography(
  containerWidth: number,
  fontSizePx: number,
  typography: ReaderTypography,
): ReaderPageSpread {
  return readerPageSpread(containerWidth, fontSizePx, typography.measureRem);
}

/** Phone/tablet reading: Kindle Narrow is ~16pt, not the desktop 40px gutter. */
export function readerPageInnerPadPx(fontPx: number, compact = false): number {
  const size = Number.isFinite(fontPx) && fontPx > 0 ? fontPx : 16;
  if (compact) {
    return Math.max(14, Math.round(size * 1.05));
  }
  return Math.max(40, Math.round(size * 2.5));
}

export function readerSurfaceIsCompact(root?: ParentNode | null): boolean {
  const fromRoot =
    root instanceof Element
      ? root.closest('html') ?? root.ownerDocument?.documentElement
      : null;
  const documentRoot =
    fromRoot ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (
    documentRoot instanceof Element &&
    (documentRoot.hasAttribute('data-android') || documentRoot.hasAttribute('data-touch-primary'))
  ) {
    return true;
  }
  return typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 600;
}

/**
 * A pane that grew with chapter HTML must not become the page. That makes
 * one mega-page (no columns, bar at 100%, next turn skips the chapter).
 */
export function clampReaderPageExtent(
  measured: { width: number; height: number },
  view: { innerWidth: number; innerHeight: number },
): { width: number; height: number } {
  const viewW = Number.isFinite(view.innerWidth) ? view.innerWidth : 0;
  const viewH = Number.isFinite(view.innerHeight) ? view.innerHeight : 0;
  const width = Math.max(1, Math.round(measured.width));
  const height = Math.max(1, Math.round(measured.height));
  return {
    width: viewW > 80 && width > viewW + 80 ? Math.round(viewW) : width,
    height: viewH > 80 && height > viewH + 80 ? Math.round(viewH) : height,
  };
}
