/**
 * `link-navigation` — document link open (R14) + exclusive link ends.
 *
 * Pure [`classifyLink`] splits targets into external / localMd / localFile /
 * invalid. [`linkNavigationPlugin`] opens only on **Ctrl/Cmd + click** after the
 * host confirms; plain click places the caret so links stay editable.
 *
 * [`linkExclusiveEndsPlugin`] clears the link mark from storedMarks when the
 * caret sits at the end of a link, so typing after a hyperlink does not keep
 * extending the link title (inclusive-mark pitfall).
 */

import { $prose } from '@milkdown/utils';
import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { Mark, Node as PMNode } from '@milkdown/prose/model';

export type LinkKind = 'external' | 'localMd' | 'localFile' | 'invalid';

export interface ClassifiedLink {
  kind: LinkKind;
  /** external: canonical HTTP(S) URL; local*: resolved path; invalid: empty. */
  target: string;
}

const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;
const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL = /^https?:\/\//i;
const PROTOCOL_RELATIVE = /^\/\//;
const WINDOWS_DRIVE_ABS = /^[a-z]:[\\/]/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_CONTROL_CHARACTER = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

/** Normalize a browser target while rejecting custom schemes and parser bypasses. */
export function normalizeExternalHttpUrl(href: string): string | null {
  if (CONTROL_CHARACTERS.test(href) || ENCODED_CONTROL_CHARACTER.test(href)) {
    return null;
  }
  const value = href.trim();
  const candidate = PROTOCOL_RELATIVE.test(value)
    ? `https:${value}`
    : HTTP_URL.test(value)
      ? value
      : null;
  if (candidate === null) return null;
  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function hidesExternalSyntaxWithEncoding(value: string): boolean {
  if (!value.includes('%')) return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      decoded !== value &&
      (EXTERNAL_SCHEME.test(decoded) || PROTOCOL_RELATIVE.test(decoded))
    );
  } catch {
    return false;
  }
}

/** Pure: classify href with optional current document directory. */
export function classifyLink(href: string, currentDocDir: string): ClassifiedLink {
  if (typeof href !== 'string' || CONTROL_CHARACTERS.test(href)) {
    return { kind: 'invalid', target: '' };
  }
  const h = href.trim();
  if (h === '') {
    return { kind: 'invalid', target: '' };
  }
  if (HTTP_URL.test(h) || PROTOCOL_RELATIVE.test(h)) {
    const target = normalizeExternalHttpUrl(h);
    return target === null
      ? { kind: 'invalid', target: '' }
      : { kind: 'external', target };
  }
  if (
    (EXTERNAL_SCHEME.test(h) && !WINDOWS_DRIVE_ABS.test(h)) ||
    hidesExternalSyntaxWithEncoding(h)
  ) {
    return { kind: 'invalid', target: '' };
  }
  const pathPart = h.split(/[#?]/)[0] ?? '';
  if (pathPart === '') {
    return { kind: 'invalid', target: '' };
  }
  const resolved = resolveLocalPath(pathPart, currentDocDir);
  return MARKDOWN_EXT.test(pathPart)
    ? { kind: 'localMd', target: resolved }
    : { kind: 'localFile', target: resolved };
}

/** Resolve local path: absolute as-is, relative against current doc dir. */
export function resolveLocalPath(pathPart: string, currentDocDir: string): string {
  if (pathPart === '') {
    return '';
  }
  if (pathPart.startsWith('/') || WINDOWS_DRIVE_ABS.test(pathPart)) {
    return pathPart;
  }
  const base = currentDocDir.replace(/[\\/]+$/, '');
  if (base === '') {
    return pathPart;
  }
  return `${base}/${pathPart}`;
}

export interface LinkNavigationOptions {
  /**
   * Called only for Ctrl/Cmd+click on a link mark after the host may confirm.
   * Synchronous or fire-and-forget is fine; return value is ignored.
   */
  onLinkNavigate: (href: string) => void;
  /**
   * Optional gate: return false / Promise<false> to cancel navigation.
   * Default: always allow.
   */
  confirmOpen?: (href: string) => boolean | Promise<boolean>;
}

/** Ctrl on Windows/Linux, Meta (⌘) on macOS — never plain click. */
export function isModifiedClick(event: MouseEvent | undefined): boolean {
  if (event === undefined) return false;
  return event.ctrlKey === true || event.metaKey === true;
}

/** Resolve href of a link mark at a document position, or null. */
export function hrefAtPos(view: EditorView, pos: number): string | null {
  try {
    const marks = view.state.doc.resolve(pos).marks();
    const link = marks.find((m) => m.type.name === 'link');
    if (link === undefined) return null;
    const href = typeof link.attrs['href'] === 'string' ? (link.attrs['href'] as string) : '';
    return href === '' ? null : href;
  } catch {
    return null;
  }
}

/**
 * Find [from, to) of the continuous link mark covering `pos`.
 * Scans the parent textblock for contiguous text nodes sharing the same link.
 */
export function findMarkRange(
  doc: PMNode,
  pos: number,
  typeName: string,
): { from: number; to: number; mark: Mark } | null {
  let $pos;
  try {
    $pos = doc.resolve(pos);
  } catch {
    return null;
  }
  const mark = $pos.marks().find((m) => m.type.name === typeName);
  if (mark === undefined) {
    // Also try marks just before pos (exclusive end / after last char).
    if (pos > 0) {
      try {
        const before = doc.resolve(pos - 1).marks().find((m) => m.type.name === typeName);
        if (before !== undefined) {
          return findMarkRangeFromMark(doc, pos - 1, before);
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  return findMarkRangeFromMark(doc, pos, mark);
}

function findMarkRangeFromMark(
  doc: PMNode,
  pos: number,
  mark: Mark,
): { from: number; to: number; mark: Mark } {
  const same = (m: Mark): boolean =>
    m.type === mark.type && m.attrs['href'] === mark.attrs['href'];
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const parentStart = $pos.start();

  if (!parent.isTextblock) {
    return { from: pos, to: pos, mark };
  }

  let runStart: number | null = null;
  let runEnd: number | null = null;
  let foundFrom: number | null = null;
  let foundTo: number | null = null;

  parent.forEach((child, offset) => {
    const start = parentStart + offset;
    const end = start + child.nodeSize;
    const has = child.isText && child.marks.some(same);
    if (has) {
      if (runStart === null) runStart = start;
      runEnd = end;
    } else if (runStart !== null) {
      if (pos >= runStart && pos <= (runEnd as number)) {
        foundFrom = runStart;
        foundTo = runEnd;
      }
      runStart = null;
      runEnd = null;
    }
  });
  if (runStart !== null && runEnd !== null && pos >= runStart && pos <= runEnd) {
    foundFrom = runStart;
    foundTo = runEnd;
  }
  // Caret exactly at end after last linked char: pos === runEnd of a finished run
  // already covered by `pos <= runEnd`. If still null, expand by walking marks.
  if (foundFrom === null || foundTo === null) {
    let from = pos;
    while (from > 0 && doc.resolve(from - 1).marks().some(same)) {
      from -= 1;
    }
    let to = pos;
    while (to < doc.content.size && doc.resolve(to).marks().some(same)) {
      to += 1;
    }
    return { from, to, mark };
  }
  return { from: foundFrom, to: foundTo, mark };
}

/**
 * Native ProseMirror plugin: Ctrl/Cmd+click on a link mark → confirm → navigate.
 * Plain click returns false so the caret can move into the link for editing.
 */
export function createLinkNavigationProsePlugin(opts: LinkNavigationOptions): Plugin {
  return new Plugin({
    props: {
      handleClick(view, pos, event) {
        if (!isModifiedClick(event)) {
          // Plain click: let ProseMirror place the caret (editable links).
          return false;
        }
        const href = hrefAtPos(view, pos);
        if (href === null) {
          return false;
        }
        // Prevent default focus/selection jump while we confirm.
        event.preventDefault();
        const gate = opts.confirmOpen;
        if (gate === undefined) {
          opts.onLinkNavigate(href);
          return true;
        }
        void Promise.resolve(gate(href)).then((ok) => {
          if (ok) {
            opts.onLinkNavigate(href);
          }
        });
        return true;
      },
    },
  });
}

/**
 * ProseMirror plugin: Ctrl/Cmd+click on a link mark → confirm → navigate.
 * Plain click returns false so the caret can move into the link for editing.
 */
export function linkNavigationPlugin(opts: LinkNavigationOptions) {
  return $prose(() => createLinkNavigationProsePlugin(opts));
}

/**
 * Clear link from storedMarks when the caret is at the exclusive end of a link,
 * so further typing does not extend the hyperlink title.
 */
export function linkExclusiveEndsPlugin() {
  return $prose(
    () =>
      new Plugin({
        view(view) {
          let scheduled = false;
          const clearIfAtLinkEnd = (): void => {
            scheduled = false;
            if (view.isDestroyed) return;
            const { state } = view;
            if (!state.selection.empty) return;
            const linkType = state.schema.marks['link'];
            if (linkType === undefined) return;
            const pos = state.selection.from;
            const range = findMarkRange(state.doc, pos, 'link');
            if (range === null) {
              if (state.storedMarks && linkType.isInSet(state.storedMarks)) {
                view.dispatch(
                  state.tr.setStoredMarks(
                    state.storedMarks.filter((m) => m.type !== linkType),
                  ),
                );
              }
              return;
            }
            // At the end of the link range: drop link from active/stored marks.
            if (pos === range.to) {
              const stored = state.storedMarks ?? state.selection.$from.marks();
              if (linkType.isInSet(stored)) {
                view.dispatch(
                  state.tr.setStoredMarks(stored.filter((m) => m.type !== linkType)),
                );
              }
            }
          };
          return {
            update() {
              if (scheduled) return;
              scheduled = true;
              queueMicrotask(clearIfAtLinkEnd);
            },
          };
        },
      }),
  );
}
