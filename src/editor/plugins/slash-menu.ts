/**
 * `slash-menu` — 行首斜杠快速插入菜单（R11），`$prose` 插件。
 *
 * 设计（02-technical-solution.md R11）：行首输入 `/` 后弹出可搜索浮动菜单，元素集合与
 * R2「插入」菜单同源（复用 `insert-commands.ts` 的 `INSERT_ELEMENTS`）；键入关键词过滤，
 * 回车在光标处插入标题/列表/表格/代码块/公式/流程图/图片/链接；Esc 退出且删除 `/query`
 * 不留残字符。
 *
 * 实现要点：
 *   - 菜单开闭与 query **派生自文档+选区**（apply 从 tr 重算）：当前行光标前文本形如
 *     `/query`（行首 `/` + 无空格 query）即开；否则关。
 *   - 菜单 portaled 到 `document.body`（position:fixed），避免被 #lightink-editor-area
 *     的 overflow-y:auto 裁切；靠近视口底部时向上展开。
 *   - 回车/点击把 `/query` 替换为解析后的元素；Esc 删除 `/query`（不留残字符）。
 *
 * 纯逻辑 `parseSlashQuery` / `nextIndex` / `placeSlashMenu` headless 可测。
 */

import { $prose } from '@milkdown/utils';
import type { Ctx } from '@milkdown/ctx';
import { parserCtx } from '@milkdown/core';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { MessageKey } from '../../i18n/messages.js';

import {
  filterInsertElements,
  formatLinkMarkdown,
  getInsertElement,
  type InsertElementId,
} from '../insert-commands.js';
import { replaceRangeWithMarkdown } from '../insert-markdown.js';
import { getFormatToolbarLinkEditor } from './format-toolbar.js';

const PLUGIN_KEY = new PluginKey<SlashState>('lightink-slash-menu');

/**
 * App-level handlers for interactive slash inserts (image file picker, etc.).
 * Wired from main.ts so slash menu shares the same UX as Insert menu.
 */
export type SlashInteractiveHandler = () => void | Promise<void>;

let slashImageHandler: SlashInteractiveHandler | null = null;

/** Insert → Image / slash `/image`: open the same local file picker flow. */
export function setSlashImageHandler(handler: SlashInteractiveHandler | null): void {
  slashImageHandler = handler;
}

export function getSlashImageHandler(): SlashInteractiveHandler | null {
  return slashImageHandler;
}

/** Optional host translator for slash chrome (empty state, etc.). */
let slashTranslate: ((key: MessageKey) => string) | null = null;

export function setSlashTranslate(t: ((key: MessageKey) => string) | null): void {
  slashTranslate = t;
}

function i18nSlashLabel(key: MessageKey, fallback: string): string {
  if (slashTranslate === null) return fallback;
  const value = slashTranslate(key);
  return value === key ? fallback : value;
}

export interface SlashQuery {
  readonly query: string;
}

/**
 * 纯逻辑：给定光标所在行「行首→光标」的文本，判定是否为斜杠触发。
 * 形如 `/query`（行首一个 `/` + 不含空格的 query）返回 {query}；否则 null。
 */
export function parseSlashQuery(linePrefix: string): SlashQuery | null {
  const match = /^\/(\S*)$/.exec(linePrefix);
  if (match === null) return null;
  return { query: match[1] };
}

/** 纯逻辑：菜单环形选择（上下），length<=0 时恒为 0。 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  return ((next % length) + length) % length;
}

export interface SlashMenuPlacement {
  readonly left: number;
  readonly top: number;
  /** Max height for the scrollable list (px). */
  readonly maxHeight: number;
  /** Whether the menu opens upward from the caret. */
  readonly flipUp: boolean;
}

/** Visible rows before the slash menu scrolls (small-screen default). */
export const SLASH_MENU_VISIBLE_ITEMS = 5;

/** Item row height used for max-height (matches theme.css --lightink-slash-item-h). */
export const SLASH_MENU_ITEM_HEIGHT = 36;

const SLASH_MENU_GAP = 2;
const SLASH_MENU_PAD_Y = 16; // 6 top + 10 bottom

/** Height of a scroll window showing up to `count` items (default 5). */
export function slashMenuHeightForItems(count = SLASH_MENU_VISIBLE_ITEMS): number {
  const n = Math.max(1, count);
  return n * SLASH_MENU_ITEM_HEIGHT + (n - 1) * SLASH_MENU_GAP + SLASH_MENU_PAD_Y;
}

/**
 * Place the slash menu in viewport coordinates.
 * Prefers below the caret; flips above when needed. Caps height to ~5 items
 * so small screens get a scrollbar instead of an oversized popup.
 */
export function placeSlashMenu(
  caret: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): SlashMenuPlacement {
  // Prefer a compact 5-row window even when the full list is taller.
  const preferredH = Math.min(menu.height, slashMenuHeightForItems(SLASH_MENU_VISIBLE_ITEMS));
  const spaceBelow = viewport.height - caret.bottom - margin;
  const spaceAbove = caret.top - margin;
  const flipUp = spaceBelow < preferredH && spaceAbove > spaceBelow;
  let left = caret.left;
  if (left + menu.width > viewport.width - margin) {
    left = Math.max(margin, viewport.width - menu.width - margin);
  }
  if (left < margin) left = margin;

  let top: number;
  let maxHeight: number;
  if (flipUp) {
    maxHeight = Math.min(preferredH, Math.max(80, Math.floor(spaceAbove)));
    top = Math.max(margin, caret.top - maxHeight);
    maxHeight = Math.max(80, Math.min(maxHeight, caret.top - top));
  } else {
    top = caret.bottom + 4;
    maxHeight = Math.min(preferredH, Math.max(80, Math.floor(viewport.height - top - margin)));
    if (top + maxHeight > viewport.height - margin) {
      top = Math.max(margin, viewport.height - maxHeight - margin);
      maxHeight = Math.max(80, Math.min(preferredH, Math.floor(viewport.height - top - margin)));
    }
  }
  return { left, top, maxHeight, flipUp };
}

interface SlashState {
  readonly open: boolean;
  readonly slashPos: number;
  readonly query: string;
  readonly selectedIndex: number;
}

const CLOSED: SlashState = { open: false, slashPos: -1, query: '', selectedIndex: 0 };

interface SelectMeta {
  readonly delta?: number;
}

/** apply 上下文：从 transaction（doc + selection + meta）派生斜杠菜单状态。 */
function computeState(tr: Transaction, prev: SlashState): SlashState {
  const { $from } = tr.selection;
  const lineStart = $from.start();
  const linePrefix = tr.doc.textBetween(lineStart, $from.pos, '\n');
  const parsed = parseSlashQuery(linePrefix);
  if (parsed === null) return CLOSED;
  let selectedIndex = parsed.query === prev.query ? prev.selectedIndex : 0;
  const meta = tr.getMeta(PLUGIN_KEY) as SelectMeta | undefined;
  if (meta !== undefined && typeof meta.delta === 'number') {
    selectedIndex = nextIndex(selectedIndex, meta.delta, filterInsertElements(parsed.query).length);
  }
  return { open: true, slashPos: lineStart, query: parsed.query, selectedIndex };
}

/** 把 `/query` 替换为结构化元素（回车 / 点击菜单项共用）。 */
function insertElement(view: EditorView, ctx: Ctx, id: InsertElementId): void {
  const state = PLUGIN_KEY.getState(view.state);
  if (state === undefined || !state.open) return;
  const element =
    filterInsertElements(state.query).find((e) => e.id === id) ?? getInsertElement(id);
  if (element === undefined) return;

  const from = state.slashPos;
  const to = view.state.selection.head;

  // Image: same local file picker as Insert → Image (main wires the handler).
  if (id === 'image') {
    try {
      const tr = view.state.tr.deleteRange(from, to);
      tr.setSelection(TextSelection.create(tr.doc, from));
      view.dispatch(tr);
    } catch {
      /* keep going */
    }
    const handler = getSlashImageHandler();
    if (handler !== null) {
      void Promise.resolve(handler()).finally(() => {
        view.focus();
      });
      return;
    }
    // Headless fallback: insert placeholder markdown snippet.
    try {
      const parse = ctx.get(parserCtx);
      replaceRangeWithMarkdown(view, from, from, element.snippet(), parse);
      view.focus();
    } catch {
      /* ignore */
    }
    return;
  }

  // Link: clear `/query` first, then open the shared text+URL dialog.
  if (id === 'link') {
    const editor = getFormatToolbarLinkEditor();
    try {
      const tr = view.state.tr.deleteRange(from, to);
      tr.setSelection(TextSelection.create(tr.doc, from));
      view.dispatch(tr);
    } catch {
      /* keep going */
    }
    if (editor === null) {
      try {
        const parse = ctx.get(parserCtx);
        replaceRangeWithMarkdown(view, from, from, element.snippet(), parse);
        view.focus();
      } catch {
        /* ignore */
      }
      return;
    }
    void Promise.resolve(editor({ text: '', href: '' })).then((result) => {
      if (result === null) {
        view.focus();
        return;
      }
      const md = formatLinkMarkdown(result.text, result.href);
      if (md === '') {
        view.focus();
        return;
      }
      try {
        const parse = ctx.get(parserCtx);
        const pos = view.state.selection.from;
        replaceRangeWithMarkdown(view, pos, pos, md, parse);
      } catch {
        /* ignore */
      }
      view.focus();
    });
    return;
  }

  try {
    const parse = ctx.get(parserCtx);
    const ok = replaceRangeWithMarkdown(
      view,
      state.slashPos,
      view.state.selection.head,
      element.snippet(),
      parse,
    );
    if (ok) {
      view.focus();
    }
  } catch {
    // 解析失败：静默（保留 /query）。
  }
}

/** Build the portal menu DOM (not inserted into the ProseMirror document). */
function buildMenuElement(
  state: SlashState,
  view: EditorView,
  ctx: Ctx,
): HTMLElement {
  const list = filterInsertElements(state.query);
  const el = document.createElement('div');
  el.className = 'lightink-slash-menu';
  el.setAttribute('role', 'listbox');
  el.setAttribute('data-lightink-slash-menu', '');
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lightink-slash-menu__empty';
    empty.textContent = i18nSlashLabel('slash.noMatch', '无匹配项');
    el.appendChild(empty);
    return el;
  }
  list.forEach((element, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lightink-slash-menu__item';
    if (index === state.selectedIndex) {
      item.className += ' lightink-slash-menu__item--active';
      item.setAttribute('aria-selected', 'true');
    }
    item.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.className = 'lightink-slash-menu__label';
    // Prefer host i18n (`insert.*`); fall back to catalog Chinese label.
    label.textContent = i18nSlashLabel(`insert.${element.id}`, element.label);
    const hint = document.createElement('span');
    hint.className = 'lightink-slash-menu__hint';
    hint.textContent = element.id;
    item.append(label, hint);
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => insertElement(view, ctx, element.id));
    el.appendChild(item);
  });
  return el;
}

/**
 * Keep the active row visible inside the menu only.
 * Avoid Element.scrollIntoView — it can scroll the editor/page and flash.
 */
export function scrollSlashItemIntoView(menu: HTMLElement, item: HTMLElement): void {
  const menuTop = menu.scrollTop;
  const menuBottom = menuTop + menu.clientHeight;
  const itemTop = item.offsetTop;
  const itemBottom = itemTop + item.offsetHeight;
  if (itemTop < menuTop) {
    menu.scrollTop = itemTop;
  } else if (itemBottom > menuBottom) {
    menu.scrollTop = itemBottom - menu.clientHeight;
  }
}

function applySelectedIndex(menu: HTMLElement, selectedIndex: number): void {
  const items = menu.querySelectorAll<HTMLElement>('.lightink-slash-menu__item');
  items.forEach((item, index) => {
    const active = index === selectedIndex;
    item.classList.toggle('lightink-slash-menu__item--active', active);
    if (active) {
      item.setAttribute('aria-selected', 'true');
      scrollSlashItemIntoView(menu, item);
    } else {
      item.removeAttribute('aria-selected');
    }
  });
}

export const slashMenuPlugin = $prose((ctx: Ctx) => {
  let editorView: EditorView | null = null;
  let menuEl: HTMLElement | null = null;
  /** Identity of the open list (not selection) — rebuild only when this changes. */
  let listKey = '';
  /** Last applied highlight index. */
  let lastSelected = -1;
  /** Last placed geometry so arrow keys do not re-layout. */
  let lastPlacementKey = '';
  /** Suppress recursive scroll sync while we adjust menu.scrollTop. */
  let ignoreScroll = false;

  const removeMenu = (): void => {
    if (menuEl !== null) {
      menuEl.remove();
      menuEl = null;
    }
    listKey = '';
    lastSelected = -1;
    lastPlacementKey = '';
  };

  const positionMenu = (
    view: EditorView,
    slash: SlashState,
    el: HTMLElement,
    force = false,
  ): void => {
    let coords: { left: number; top: number; bottom: number };
    try {
      coords = view.coordsAtPos(slash.slashPos);
    } catch {
      coords = view.coordsAtPos(view.state.selection.from);
    }
    const placementKey = `${slash.slashPos}|${Math.round(coords.left)}|${Math.round(coords.bottom)}|${window.innerWidth}x${window.innerHeight}`;
    if (!force && placementKey === lastPlacementKey) {
      return;
    }
    // Natural content height from item count (no maxHeight:none thrash).
    const itemCount = el.querySelectorAll('.lightink-slash-menu__item').length;
    const naturalH =
      itemCount > 0
        ? slashMenuHeightForItems(itemCount)
        : slashMenuHeightForItems(1);
    const width = Math.max(el.offsetWidth || 0, 220);
    const placement = placeSlashMenu(
      { left: coords.left, top: coords.top, bottom: coords.bottom },
      { width, height: naturalH },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.position = 'fixed';
    el.style.left = `${Math.round(placement.left)}px`;
    el.style.top = `${Math.round(placement.top)}px`;
    el.style.zIndex = '10050';
    el.style.maxHeight = `${placement.maxHeight}px`;
    el.style.overflowY = 'auto';
    el.dataset.flip = placement.flipUp ? 'up' : 'down';
    lastPlacementKey = placementKey;
  };

  const syncMenu = (view: EditorView, opts: { forcePlace?: boolean } = {}): void => {
    const slash = PLUGIN_KEY.getState(view.state);
    if (slash === undefined || !slash.open) {
      removeMenu();
      return;
    }
    // Rebuild only when the filtered list changes — never on selectedIndex alone.
    const nextListKey = `${slash.slashPos}|${slash.query}`;
    if (menuEl === null || nextListKey !== listKey) {
      removeMenu();
      menuEl = buildMenuElement(slash, view, ctx);
      document.body.appendChild(menuEl);
      listKey = nextListKey;
      lastSelected = -1;
      lastPlacementKey = '';
      positionMenu(view, slash, menuEl, true);
      applySelectedIndex(menuEl, slash.selectedIndex);
      lastSelected = slash.selectedIndex;
      return;
    }
    if (opts.forcePlace) {
      positionMenu(view, slash, menuEl, true);
    }
    if (slash.selectedIndex !== lastSelected) {
      ignoreScroll = true;
      applySelectedIndex(menuEl, slash.selectedIndex);
      lastSelected = slash.selectedIndex;
      // Release on next frame so our own scrollTop write does not re-enter sync.
      requestAnimationFrame(() => {
        ignoreScroll = false;
      });
    }
  };

  return new Plugin<SlashState>({
    key: PLUGIN_KEY,
    state: {
      init: () => CLOSED,
      apply: (tr, prev) => computeState(tr, prev),
    },
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        const slash = PLUGIN_KEY.getState(view.state);
        if (slash === undefined || !slash.open) return false;
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.deleteRange(slash.slashPos, view.state.selection.head));
          event.preventDefault();
          return true;
        }
        if (event.key === 'Enter') {
          const element = filterInsertElements(slash.query)[slash.selectedIndex];
          if (element !== undefined) {
            insertElement(view, ctx, element.id);
          }
          event.preventDefault();
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          view.dispatch(
            view.state.tr.setMeta(PLUGIN_KEY, {
              delta: event.key === 'ArrowDown' ? 1 : -1,
            }),
          );
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    view(view: EditorView) {
      editorView = view;
      const onScroll = (event: Event): void => {
        if (ignoreScroll || editorView === null) return;
        // Ignore scrolls that originate inside the menu itself.
        if (menuEl !== null && event.target instanceof Node && menuEl.contains(event.target)) {
          return;
        }
        // Editor/window scroll: only re-place, do not rebuild.
        syncMenu(editorView, { forcePlace: true });
      };
      const onResize = (): void => {
        if (editorView !== null) syncMenu(editorView, { forcePlace: true });
      };
      // Capture scroll from nested editor scroller (#lightink-editor-area).
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onResize);
      // Initial sync in case the doc already has `/`.
      queueMicrotask(() => {
        if (editorView !== null) syncMenu(editorView);
      });
      return {
        update(v) {
          editorView = v;
          syncMenu(v);
        },
        destroy() {
          window.removeEventListener('scroll', onScroll, true);
          window.removeEventListener('resize', onResize);
          removeMenu();
          editorView = null;
        },
      };
    },
  });
});
