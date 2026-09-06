/**
 * Code block syntax highlighting plugin (T5 / R4 + language switcher).
 *
 * Design:
 *   - `highlight.js/lib/core` stays in the startup bundle; common grammars are
 *     registered on demand when their code fences first appear.
 *   - Pure logic remains headless-testable:
 *       resolveLanguage / tokenizeCode / highlightCode / listSupportedLanguages
 *   - ProseMirror decorations attach `hljs-*` classes; nodeView overlays a
 *     language <select> + copy button without fighting contentDOM text.
 *   - Unlabeled fences / plain-text markers stay unhighlighted.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { EditorView } from '@milkdown/prose/view';
import { Decoration, DecorationSet, type NodeView } from '@milkdown/prose/view';
import {
  ensureHighlightLanguage,
  highlightEngine as hljs,
  isHighlightLanguageLoaded,
  languageMatchesQuery,
  resolveHighlightLanguage,
  SUPPORTED_HIGHLIGHT_LANGUAGES,
  type HighlightLanguage,
} from './code-languages.js';

export { ensureHighlightLanguage, isHighlightLanguageLoaded } from './code-languages.js';

/** Explicit plain-text fence markers (no highlight). */
const PLAIN_TEXT_MARKERS: ReadonlySet<string> = new Set([
  'text',
  'plain',
  'plaintext',
  'txt',
  'none',
]);

/**
 * Non-hljs languages that still need a picker label / stable fence tag
 * (e.g. mermaid diagrams rendered by a dedicated plugin).
 */
/** Non-hljs fences rendered by dedicated plugins (mermaid / math). */
export const SPECIAL_LANGUAGES = ['mermaid', 'math', 'latex', 'katex'] as const;
type SpecialLanguage = (typeof SPECIAL_LANGUAGES)[number];

function isSpecialLanguage(language: string): language is SpecialLanguage {
  return SPECIAL_LANGUAGES.some((candidate) => candidate === language);
}

/**
// ---------------------------------------------------------------------------
// Pure helpers (headless-testable)
// ---------------------------------------------------------------------------

/**
 * Fence info-string → supported language name; empty / plain / unknown → null.
 * Grammar registration happens asynchronously after resolution.
 */
export function resolveLanguage(
  infoString: string | null | undefined,
): HighlightLanguage | SpecialLanguage | null {
  if (infoString === null || infoString === undefined) return null;
  const tag = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (tag === '' || PLAIN_TEXT_MARKERS.has(tag)) return null;
  if (isSpecialLanguage(tag)) return tag;
  return resolveHighlightLanguage(tag);
}

/**
 * Stable picker options: explicitly supported on-demand grammars plus special
 * fences handled by dedicated plugins. Sorted, plain-text excluded.
 */
export function listSupportedLanguages(): readonly string[] {
  const set = new Set<string>(SUPPORTED_HIGHLIGHT_LANGUAGES);
  for (const name of SPECIAL_LANGUAGES) {
    set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** True when fence is a mermaid diagram block (rendered by mermaid plugin). */
export function isDiagramLanguage(infoString: string | null | undefined): boolean {
  return resolveLanguage(infoString) === 'mermaid';
}

/** True when fence is a LaTeX math block (rendered by math plugin). */
export function isMathLanguage(infoString: string | null | undefined): boolean {
  const tag = resolveLanguage(infoString);
  return tag === 'math' || tag === 'latex' || tag === 'katex';
}

/** Flattened highlight token: hljs scope + source text. */
export interface HighlightToken {
  readonly scope: string | null;
  readonly text: string;
}

interface HljsTokenNode {
  children?: Array<string | HljsTokenNode>;
  scope?: string;
}

interface HljsHighlightResultWithEmitter {
  value: string;
  _emitter?: { root?: HljsTokenNode; rootNode?: HljsTokenNode };
}

/**
 * Tokenize `code` with hljs. `language` null/unknown → null (plain path).
 * Uses hljs token-tree (`_emitter.root`) for lossless PM offsets.
 */
export function tokenizeCode(
  language: string | null,
  code: string,
): readonly HighlightToken[] | null {
  if (language === null || hljs.getLanguage(language) === undefined) {
    return null;
  }
  let result: HljsHighlightResultWithEmitter;
  try {
    result = hljs.highlight(code, { language }) as HljsHighlightResultWithEmitter;
  } catch {
    return null;
  }
  const root = result._emitter?.root ?? result._emitter?.rootNode;
  if (root === undefined) {
    return [{ scope: null, text: code }];
  }
  const tokens: HighlightToken[] = [];
  const walk = (node: string | HljsTokenNode, scopeChain: readonly string[]): void => {
    if (typeof node === 'string') {
      if (node.length > 0) {
        tokens.push({ scope: scopeChain.length > 0 ? scopeChain.join('.') : null, text: node });
      }
      return;
    }
    const nextChain = typeof node.scope === 'string' ? [...scopeChain, node.scope] : scopeChain;
    for (const child of node.children ?? []) {
      walk(child, nextChain);
    }
  };
  walk(root, []);
  return tokens;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function scopeToClasses(scope: string): string {
  return scope
    .split('.')
    .filter((part) => part.length > 0)
    .map((part) => `hljs-${part}`)
    .join(' ');
}

export function highlightCode(language: string | null, code: string): string {
  const tokens = tokenizeCode(language, code);
  if (tokens === null) {
    return escapeHtml(code);
  }
  return tokens
    .map((token) =>
      token.scope === null
        ? escapeHtml(token.text)
        : `<span class="${escapeHtml(scopeToClasses(token.scope))}">${escapeHtml(token.text)}</span>`,
    )
    .join('');
}

// ---------------------------------------------------------------------------
// ProseMirror decorations
// ---------------------------------------------------------------------------

export const codeHighlightPluginKey = new PluginKey<DecorationSet>(
  'lightink-code-highlight',
);

export function buildCodeDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return true;
    const info = typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
    const language = resolveLanguage(info);
    if (language === null) return false;
    const code = node.textContent;
    const tokens = tokenizeCode(language, code);
    if (tokens === null) return false;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `hljs language-${language}`,
        'data-language': language,
      }),
    );
    let offset = pos + 1;
    for (const token of tokens) {
      const end = offset + token.text.length;
      if (token.scope !== null) {
        decorations.push(
          Decoration.inline(offset, end, { class: scopeToClasses(token.scope) }),
        );
      }
      offset = end;
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

function documentHighlightLanguages(doc: PMNode): readonly HighlightLanguage[] {
  const languages = new Set<HighlightLanguage>();
  doc.descendants((node) => {
    if (node.type.name !== 'code_block') return true;
    const info =
      typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
    const language = resolveLanguage(info);
    if (
      language !== null &&
      !isSpecialLanguage(language) &&
      !isHighlightLanguageLoaded(language)
    ) {
      languages.add(language);
    }
    return false;
  });
  return [...languages];
}

// ---------------------------------------------------------------------------
// R8 copy button + filterable language picker chrome
// ---------------------------------------------------------------------------

export const CODE_HEADER_CLASS = 'lightink-code-header';
export const COPY_BUTTON_CLASS = 'lightink-code-copy-btn';
export const COPIED_FLAG_CLASS = 'lightink-code-copy-btn--copied';
export const LANG_PICKER_CLASS = 'lightink-code-lang';
export const LANG_PICKER_OPEN_CLASS = 'lightink-code-lang--open';
export const LANG_TRIGGER_CLASS = 'lightink-code-lang-trigger';
export const LANG_PANEL_CLASS = 'lightink-code-lang-panel';
export const LANG_FILTER_CLASS = 'lightink-code-lang-filter';
export const LANG_LIST_CLASS = 'lightink-code-lang-list';
export const LANG_OPTION_CLASS = 'lightink-code-lang-option';
export const LANG_OPTION_ACTIVE_CLASS = 'lightink-code-lang-option--active';
export const LANG_OPTION_EMPTY_CLASS = 'lightink-code-lang-option--empty';
/** Mutable UI labels (host retranslates after language switch). */
export let COPY_LABEL = 'Copy';
export let COPIED_LABEL = 'Copied';
export let PLAIN_LANGUAGE_LABEL = 'Plain text';
export let LANG_FILTER_PLACEHOLDER = 'Filter languages…';
export let LANG_EMPTY_FILTER_LABEL = 'No matching language';
export let MERMAID_LANGUAGE_LABEL = 'Flowchart';
export let MATH_LANGUAGE_LABEL = 'Formula';
const COPY_FEEDBACK_MS = 1500;

export interface CodeChromeLabels {
  copy?: string;
  copied?: string;
  plain?: string;
  filterPlaceholder?: string;
  emptyFilter?: string;
  mermaid?: string;
  math?: string;
}

/** Apply localized chrome labels for code blocks (copy / language picker). */
export function setCodeChromeLabels(labels: CodeChromeLabels): void {
  if (labels.copy !== undefined) COPY_LABEL = labels.copy;
  if (labels.copied !== undefined) COPIED_LABEL = labels.copied;
  if (labels.plain !== undefined) PLAIN_LANGUAGE_LABEL = labels.plain;
  if (labels.filterPlaceholder !== undefined) LANG_FILTER_PLACEHOLDER = labels.filterPlaceholder;
  if (labels.emptyFilter !== undefined) LANG_EMPTY_FILTER_LABEL = labels.emptyFilter;
  if (labels.mermaid !== undefined) MERMAID_LANGUAGE_LABEL = labels.mermaid;
  if (labels.math !== undefined) MATH_LANGUAGE_LABEL = labels.math;
}

export function copyButtonLabel(copied: boolean): string {
  return copied ? COPIED_LABEL : COPY_LABEL;
}

export function copyButtonClassName(copied: boolean): string {
  return copied ? `${COPY_BUTTON_CLASS} ${COPIED_FLAG_CLASS}` : COPY_BUTTON_CLASS;
}

export function readCodeSource(contentDOM: { textContent: string | null }): string {
  return contentDOM.textContent ?? '';
}

export function createCopyButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = COPY_BUTTON_CLASS;
  btn.textContent = COPY_LABEL;
  btn.setAttribute('aria-label', COPY_LABEL);
  btn.setAttribute('title', COPY_LABEL);
  return btn;
}

export function setCopiedState(btn: HTMLButtonElement, copied: boolean): void {
  btn.textContent = copyButtonLabel(copied);
  btn.className = copyButtonClassName(copied);
  btn.setAttribute('aria-label', copyButtonLabel(copied));
}

/**
 * Normalize a fence language attr for the picker value:
 * known → resolved name (hljs or special); empty/plain/unknown → '' (纯文本).
 */
export function languageSelectValue(infoString: string | null | undefined): string {
  return resolveLanguage(infoString) ?? '';
}

/** Display label for a picker value (empty → plain text). */
export function languageDisplayLabel(value: string): string {
  if (value === '') return PLAIN_LANGUAGE_LABEL;
  if (value === 'mermaid') return MERMAID_LANGUAGE_LABEL;
  if (value === 'math' || value === 'latex' || value === 'katex') return MATH_LANGUAGE_LABEL;
  return value;
}

/**
 * Filter registered languages by query (case-insensitive substring).
 * Matches canonical names and aliases (e.g. `toml` → ini, `vue` → xml).
 * Empty query returns the full list. 纯文本 is always prepended by callers.
 */
export function filterLanguages(
  query: string,
  languages: readonly string[] = listSupportedLanguages(),
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return languages;
  }
  return languages.filter((name) => languageMatchesQuery(name, q));
}

/** Whether the plain-text option matches the current filter query. */
export function plainLanguageMatches(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') {
    return true;
  }
  return (
    PLAIN_LANGUAGE_LABEL.toLowerCase().includes(q) ||
    'text'.includes(q) ||
    'plain'.includes(q) ||
    'plaintext'.includes(q)
  );
}

export interface LanguagePicker {
  readonly element: HTMLElement;
  /** Current selected language value ('' = plain text). */
  getValue(): string;
  /** Sync display when the code_block language attr changes externally. */
  setValue(value: string): void;
  destroy(): void;
}

export interface LanguagePickerOptions {
  current?: string;
  languages?: readonly string[];
  doc?: Document;
  onChange?: (language: string) => void;
}

/**
 * Filterable language combobox for code blocks.
 *
 * Panel is portaled to document.body with position:fixed so ProseMirror /
 * ancestor overflow cannot clip or intercept it. Trigger stays in the header.
 */
export function createLanguagePicker(options: LanguagePickerOptions = {}): LanguagePicker {
  const doc = options.doc ?? document;
  const languages = options.languages ?? listSupportedLanguages();
  let value = languageSelectValue(options.current);
  let open = false;
  let activeIndex = 0;
  let filtered: Array<{ value: string; label: string }> = [];
  let ignoreOutsideCloseUntil = 0;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  const root = doc.createElement('div');
  root.className = LANG_PICKER_CLASS;

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = LANG_TRIGGER_CLASS;
  trigger.setAttribute('aria-label', '代码语言');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('title', '代码语言');

  // Portaled panel: lives on document.body so nothing inside the editor clips it.
  const panel = doc.createElement('div');
  panel.className = LANG_PANEL_CLASS;
  panel.hidden = true;
  // Portaled panel: fixed positioning so editor overflow cannot clip it.
  // Guard style access for headless fakes used in unit tests.
  const panelStyle = (panel as HTMLElement).style;
  if (panelStyle !== undefined) {
    panelStyle.position = 'fixed';
    panelStyle.zIndex = '5000';
  }

  const filter = doc.createElement('input');
  filter.type = 'search';
  filter.className = LANG_FILTER_CLASS;
  filter.placeholder = LANG_FILTER_PLACEHOLDER;
  filter.setAttribute('aria-label', LANG_FILTER_PLACEHOLDER);
  filter.autocomplete = 'off';
  filter.spellcheck = false;

  const list = doc.createElement('div');
  list.className = LANG_LIST_CLASS;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '代码语言');

  panel.appendChild(filter);
  panel.appendChild(list);
  root.appendChild(trigger);

  const portalParent: HTMLElement | null =
    typeof doc.body !== 'undefined' && doc.body !== null
      ? (doc.body as HTMLElement)
      : null;

  const syncTrigger = (): void => {
    trigger.textContent = languageDisplayLabel(value);
  };

  const buildItems = (query: string): Array<{ value: string; label: string }> => {
    const items: Array<{ value: string; label: string }> = [];
    if (plainLanguageMatches(query)) {
      items.push({ value: '', label: PLAIN_LANGUAGE_LABEL });
    }
    for (const name of filterLanguages(query, languages)) {
      items.push({ value: name, label: name });
    }
    return items;
  };

  const positionPanel = (): void => {
    if (typeof trigger.getBoundingClientRect !== 'function') {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const style = (panel as HTMLElement).style;
    if (style === undefined) {
      return;
    }
    const viewportW =
      typeof window !== 'undefined' ? window.innerWidth : 800;
    const viewportH =
      typeof window !== 'undefined' ? window.innerHeight : 600;
    const width = Math.min(260, Math.max(200, viewportW - 16));
    let left = rect.left;
    if (left + width > viewportW - 8) {
      left = Math.max(8, viewportW - width - 8);
    }
    // Prefer below the trigger; flip above when near the bottom.
    const below = rect.bottom + 6;
    const estimatedHeight = 280;
    const top =
      below + estimatedHeight > viewportH - 8
        ? Math.max(8, rect.top - estimatedHeight - 6)
        : below;
    style.left = `${Math.round(left)}px`;
    style.top = `${Math.round(top)}px`;
    style.width = `${Math.round(width)}px`;
  };

  const renderList = (): void => {
    filtered = buildItems(filter.value);
    list.replaceChildren();
    if (filtered.length === 0) {
      const empty = doc.createElement('div');
      empty.className = `${LANG_OPTION_CLASS} ${LANG_OPTION_EMPTY_CLASS}`;
      empty.textContent = LANG_EMPTY_FILTER_LABEL;
      list.appendChild(empty);
      activeIndex = -1;
      return;
    }
    if (activeIndex < 0 || activeIndex >= filtered.length) {
      const selectedIdx = filtered.findIndex((item) => item.value === value);
      activeIndex = selectedIdx >= 0 ? selectedIdx : 0;
    }
    filtered.forEach((item, index) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = LANG_OPTION_CLASS;
      btn.setAttribute('role', 'option');
      btn.setAttribute('data-value', item.value);
      btn.textContent = item.label;
      btn.setAttribute('aria-selected', item.value === value ? 'true' : 'false');
      if (index === activeIndex) {
        btn.classList.add(LANG_OPTION_ACTIVE_CLASS);
      }
      // mousedown + preventDefault keeps focus on the filter and avoids
      // document outside-close racing the selection.
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(item.value);
      });
      list.appendChild(btn);
    });
    const activeEl = list.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: 'nearest' });
  };

  const detachPanel = (): void => {
    if (panel.parentNode !== null) {
      panel.parentNode.removeChild(panel);
    }
    panel.hidden = true;
  };

  const setOpen = (next: boolean): void => {
    if (open === next) {
      return;
    }
    open = next;
    root.classList.toggle(LANG_PICKER_OPEN_CLASS, open);
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (focusTimer !== null) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    if (open) {
      // Suppress outside-close for this opening gesture (~next tick + a bit).
      ignoreOutsideCloseUntil = Date.now() + 120;
      filter.value = '';
      activeIndex = 0;
      renderList();
      if (portalParent !== null && panel.parentNode !== portalParent) {
        portalParent.appendChild(panel);
      }
      panel.hidden = false;
      positionPanel();
      focusTimer = setTimeout(() => {
        focusTimer = null;
        if (!open) return;
        filter.focus();
        if (typeof filter.select === 'function') {
          filter.select();
        }
      }, 0);
    } else {
      detachPanel();
    }
  };

  const choose = (next: string): void => {
    const normalized = languageSelectValue(next) || (next === '' ? '' : next);
    const accepted =
      normalized === '' || languages.includes(normalized) ? normalized : value;
    const changed = accepted !== value;
    value = accepted;
    syncTrigger();
    setOpen(false);
    if (changed) {
      options.onChange?.(value);
    }
  };

  /** True when mousedown already handled the gesture (skip click fallback). */
  let handledByMouseDown = false;
  const onTriggerMouseDown = (event: Event): void => {
    // mousedown (not click): complete open before any later click handlers.
    // preventDefault keeps ProseMirror from taking the gesture.
    event.preventDefault();
    event.stopPropagation();
    handledByMouseDown = true;
    setOpen(!open);
  };
  const onTriggerClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    // Fallback only when mousedown was swallowed by the host/editor.
    if (handledByMouseDown) {
      handledByMouseDown = false;
      return;
    }
    setOpen(!open);
  };
  const onFilterInput = (): void => {
    activeIndex = 0;
    renderList();
  };
  const onFilterKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return;
      activeIndex = (activeIndex + 1) % filtered.length;
      renderList();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
      renderList();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = filtered[activeIndex];
      if (item !== undefined) {
        choose(item.value);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.focus();
    }
  };
  const onDocMouseDown = (event: Event): void => {
    if (!open) return;
    if (Date.now() < ignoreOutsideCloseUntil) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (root.contains(target) || panel.contains(target)) return;
    setOpen(false);
  };
  const onWindowReposition = (): void => {
    if (open) positionPanel();
  };

  trigger.addEventListener('mousedown', onTriggerMouseDown);
  trigger.addEventListener('click', onTriggerClick);
  filter.addEventListener('input', onFilterInput);
  filter.addEventListener('keydown', onFilterKeyDown);
  // Bubble (not capture): open handler on the trigger runs first on its target.
  doc.addEventListener('mousedown', onDocMouseDown);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowReposition);
    window.addEventListener('scroll', onWindowReposition, true);
  }

  syncTrigger();

  return {
    element: root,
    getValue(): string {
      return value;
    },
    setValue(next: string): void {
      value = languageSelectValue(next);
      syncTrigger();
      if (open) {
        renderList();
      }
    },
    destroy(): void {
      setOpen(false);
      if (focusTimer !== null) {
        clearTimeout(focusTimer);
        focusTimer = null;
      }
      trigger.removeEventListener('mousedown', onTriggerMouseDown);
      trigger.removeEventListener('click', onTriggerClick);
      filter.removeEventListener('input', onFilterInput);
      filter.removeEventListener('keydown', onFilterKeyDown);
      doc.removeEventListener('mousedown', onDocMouseDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onWindowReposition);
        window.removeEventListener('scroll', onWindowReposition, true);
      }
      detachPanel();
    },
  };
}

export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard !== undefined &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return legacyClipboardCopy(text);
}

function legacyClipboardCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/**
 * Apply language attr on a code_block at `pos` (menu / select path).
 * Returns false when the node is missing or already has the same language.
 */
export function setCodeBlockLanguage(
  view: EditorView,
  pos: number,
  language: string,
): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (node === null || node.type.name !== 'code_block') {
    return false;
  }
  const next = language.trim();
  const prev = typeof node.attrs['language'] === 'string' ? node.attrs['language'] : '';
  if (prev === next) {
    return false;
  }
  const tr = view.state.tr.setNodeMarkup(pos, undefined, {
    ...node.attrs,
    language: next,
  });
  view.dispatch(tr);
  return true;
}

/**
 * code_block nodeView — dedicated header toolbar above the code surface
 * (industry pattern: language left, actions right; never overlay first lines).
 *
 * Interactive chrome MUST use contenteditable=false + stopEvent, otherwise
 * ProseMirror swallows mousedown/click inside the nodeView and the language
 * picker / copy button appear dead.
 */
export function createCodeBlockNodeView(
  initialNode: PMNode,
  view: EditorView,
  getPos: () => number | undefined,
): NodeView {
  let node = initialNode;

  const dom = document.createElement('div');
  dom.className = 'lightink-code-block';
  dom.setAttribute('data-lightink-code', '');

  // Header toolbar: reserved row above <pre>, so chrome never covers code.
  const header = document.createElement('div');
  header.className = CODE_HEADER_CLASS;
  // Keep PM out of the chrome row (selection / editing / event capture).
  header.contentEditable = 'false';
  header.setAttribute('contenteditable', 'false');

  const currentLang =
    typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
  const langPicker = createLanguagePicker({
    current: currentLang,
    onChange: (language) => {
      const pos = getPos();
      if (typeof pos !== 'number') {
        return;
      }
      setCodeBlockLanguage(view, pos, language);
    },
  });
  header.appendChild(langPicker.element);

  const btn = createCopyButton();
  header.appendChild(btn);

  const pre = document.createElement('pre');
  pre.className = 'lightink-code-pre';
  const contentDOM = document.createElement('code');
  pre.appendChild(contentDOM);

  dom.appendChild(header);
  dom.appendChild(pre);

  const syncDiagramClass = (): void => {
    const info =
      typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
    // Mermaid blocks: diagram-only chrome; source hidden once rendered (CSS).
    dom.classList.toggle('is-diagram', isDiagramLanguage(info));
    dom.dataset.language = languageSelectValue(info) || 'plain';
  };
  syncDiagramClass();

  const syncLanguagePicker = (): void => {
    const info =
      typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
    langPicker.setValue(info);
    syncDiagramClass();
  };

  const onCopy = async (): Promise<void> => {
    const ok = await writeClipboardText(readCodeSource(contentDOM));
    if (ok) {
      setCopiedState(btn, true);
      window.setTimeout(() => setCopiedState(btn, false), COPY_FEEDBACK_MS);
    }
  };
  const onBtnMouseDown = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  btn.addEventListener('mousedown', onBtnMouseDown);
  btn.addEventListener('click', onCopy);

  return {
    dom,
    contentDOM,
    /**
     * Tell ProseMirror to ignore events targeting the header chrome so our
     * language picker / copy handlers actually run.
     */
    stopEvent(event: Event): boolean {
      const target = event.target;
      if (!(target instanceof Node)) {
        return false;
      }
      if (header.contains(target) || langPicker.element.contains(target)) {
        return true;
      }
      // Portaled panel is on document.body; also stop if somehow retargeted here.
      return false;
    },
    ignoreMutation(mutation: MutationRecord | { type: string; target: Node }): boolean {
      // Ignore attribute/childList noise from the non-editable chrome row.
      const target = 'target' in mutation ? mutation.target : null;
      if (target instanceof Node && header.contains(target)) {
        return true;
      }
      return false;
    },
    update: (incoming: PMNode) => {
      if (incoming.type !== node.type) {
        return false;
      }
      node = incoming;
      syncLanguagePicker();
      return true;
    },
    destroy(): void {
      langPicker.destroy();
      btn.removeEventListener('mousedown', onBtnMouseDown);
      btn.removeEventListener('click', onCopy);
    },
  };
}

// ---------------------------------------------------------------------------
// Milkdown plugin
// ---------------------------------------------------------------------------

/**
 * Milkdown `$prose` plugin: code_block highlight decorations + language select
 * + copy button. Register after commonmark/gfm/history in mountEditor.
 */
export const codeHighlightPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: codeHighlightPluginKey,
      state: {
        init: (_config, state) => buildCodeDecorations(state.doc),
        apply: (tr, old, _oldState, newState) => {
          return tr.docChanged || tr.getMeta(codeHighlightPluginKey) === 'grammar-loaded'
            ? buildCodeDecorations(newState.doc)
            : old;
        },
      },
      view: (initialView) => {
        let alive = true;
        const requested = new Set<HighlightLanguage>();
        const requestLanguages = (view: EditorView): void => {
          for (const language of documentHighlightLanguages(view.state.doc)) {
            if (requested.has(language)) continue;
            requested.add(language);
            void ensureHighlightLanguage(language).then((loaded) => {
              requested.delete(language);
              if (!loaded || !alive) return;
              view.dispatch(view.state.tr.setMeta(codeHighlightPluginKey, 'grammar-loaded'));
            });
          }
        };
        requestLanguages(initialView);
        return {
          update: (view, previousState) => {
            if (view.state.doc !== previousState.doc) {
              requestLanguages(view);
            }
          },
          destroy: () => {
            alive = false;
            requested.clear();
          },
        };
      },
      props: {
        decorations(state) {
          return codeHighlightPluginKey.getState(state);
        },
        nodeViews: {
          code_block: (node: PMNode, view: EditorView, getPos: () => number | undefined) =>
            createCodeBlockNodeView(node, view, getPos),
        },
      },
    }),
);
