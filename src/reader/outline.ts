/**
 * Reader outline helpers: flatten PDF bookmarks / flow chapters into OutlineItem[].
 */

import type { OutlineItem } from '../outline/outline-model.js';

export interface PdfOutlineNode {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: readonly PdfOutlineNode[];
}

export interface PdfOutlineResolver {
  getOutline(): Promise<readonly PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
}

/** PDF bookmark flatten cap. Chapter/page catalogs are uncapped. */
const MAX_PDF_OUTLINE_ITEMS = 20_000;
const MAX_OUTLINE_DEPTH = 8;

function destRef(dest: unknown): unknown {
  if (!Array.isArray(dest) || dest.length === 0) {
    return null;
  }
  return dest[0];
}

async function pageFromDest(
  dest: unknown,
  resolver: PdfOutlineResolver,
): Promise<number | undefined> {
  let explicit = dest;
  if (typeof dest === 'string') {
    explicit = await resolver.getDestination(dest);
  }
  const ref = destRef(explicit);
  if (ref === null || ref === undefined) {
    return undefined;
  }
  try {
    const index = await resolver.getPageIndex(ref);
    return Number.isSafeInteger(index) && index >= 0 ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}

function pushItem(
  items: OutlineItem[],
  title: string,
  level: number,
  target: { page?: number; chapter?: number },
): void {
  items.push({
    level,
    text: title,
    anchor: items.length,
    ...target,
  });
}

async function flattenPdfNodes(
  nodes: readonly PdfOutlineNode[],
  resolver: PdfOutlineResolver,
  level: number,
  out: OutlineItem[],
): Promise<void> {
  if (level > MAX_OUTLINE_DEPTH) {
    return;
  }
  for (const node of nodes) {
    if (out.length >= MAX_PDF_OUTLINE_ITEMS) {
      return;
    }
    const title = typeof node.title === 'string' ? node.title.trim() : '';
    const page = await pageFromDest(node.dest, resolver);
    if (title !== '') {
      pushItem(out, title, level, { page });
    }
    if (Array.isArray(node.items) && node.items.length > 0) {
      await flattenPdfNodes(node.items, resolver, title === '' ? level : level + 1, out);
    }
  }
}

/** Flatten pdf.js outline tree into OutlineItem[] (page is 1-based when resolvable). */
export async function outlineFromPdf(resolver: PdfOutlineResolver): Promise<OutlineItem[]> {
  let nodes: readonly PdfOutlineNode[] | null;
  try {
    nodes = await resolver.getOutline();
  } catch {
    return [];
  }
  if (nodes === null || nodes.length === 0) {
    return [];
  }
  const items: OutlineItem[] = [];
  await flattenPdfNodes(nodes, resolver, 1, items);
  return items;
}

/** Flow/TXT/CBZ fallback: one item per chapter or page. */
export function outlineFromEntries(
  entries: readonly { title: string }[],
  kind: 'chapter' | 'page',
): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const title = entries[index]!.title.trim();
    const text = title === '' ? (kind === 'page' ? String(index + 1) : '') : title;
    if (text === '') {
      continue;
    }
    pushItem(items, text, 1, kind === 'page' ? { page: index + 1 } : { chapter: index });
  }
  return items;
}
