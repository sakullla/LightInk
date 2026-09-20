/**
 * YAML front matter plugin (T1 / R5).
 *
 * Problem being fixed: without a front-matter remark extension, a leading
 * `---\ntitle: …\n---` block is parsed by micromark as a thematic break plus
 * a setext heading. The WYSIWYG stack then re-serialized those nodes and
 * silently rewrote the document's front matter (data loss on save).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md §3 + ADR-1):
 *
 *   - Dual parser stacks stay in sync: `remark-frontmatter` is registered
 *     BOTH here (Milkdown's internal remark via `$remark`) and in the pure
 *     parser (`parser.ts`). Both produce an mdast `yaml` node whose `value`
 *     is the raw YAML text between the fences.
 *
 *   - The ProseMirror side is a single atom block node `frontmatter` that
 *     stores the raw YAML text in its `value` attr. Atom + attr storage
 *     (rather than editable text content) guarantees the YAML is never
 *     reflowed/normalized by ProseMirror — round-trip is verbatim. YAML is
 *     not parsed or validated: preserving it as-is satisfies "不静默删除".
 *
 *   - WYSIWYG chrome is a NodeView: a default-closed
 *     `<details class="lightink-frontmatter">` bar. Folded/open is DOM-only
 *     (`open` is never an attr). schema `toDOM` is isomorphic for clipboard.
 *
 *   - Serialization emits an mdast `yaml` node; `remark-frontmatter`'s
 *     to-markdown extension writes it back as `---\n<value>\n---`, so block
 *     position and content survive an edit/save cycle unchanged.
 *
 * The pure helpers (`extractFrontMatter`, `hasFrontMatter`,
 * `frontmatterNodeSchema`) are headless-testable; only the exported
 * Milkdown plugin values require a live editor.
 */

import type { MilkdownPlugin } from '@milkdown/ctx';
import { $nodeSchema, $prose, $remark } from '@milkdown/utils';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { NodeView } from '@milkdown/prose/view';
import type { NodeSchema } from '@milkdown/transformer';
import remarkFrontmatter from 'remark-frontmatter';

import {
  DEFAULT_LOCALE,
  isLocaleId,
  translate,
  type LocaleId,
} from '../../i18n/messages.js';
import { parseMarkdownToMdast } from '../parser.js';

// ---------------------------------------------------------------------------
// 纯逻辑层：front matter 提取（headless 可测）
// ---------------------------------------------------------------------------

/** Extracted front matter: the raw YAML text between the `---` fences. */
export interface FrontMatterBlock {
  readonly value: string;
}

/**
 * Return the document's leading YAML front matter block, or null when the
 * document does not start with a `---` fence. Only a leading `yaml` node
 * counts — thematic breaks later in the document are not front matter.
 */
export function extractFrontMatter(source: string): FrontMatterBlock | null {
  if (typeof source !== 'string' || !source.startsWith('---')) return null;
  const root = parseMarkdownToMdast(source);
  const first = root.children[0] as { type?: string; value?: unknown } | undefined;
  if (first === undefined || first.type !== 'yaml') return null;
  return { value: typeof first.value === 'string' ? first.value : '' };
}

/** Whether the markdown source begins with a YAML front matter block. */
export function hasFrontMatter(source: string): boolean {
  return extractFrontMatter(source) !== null;
}

// ---------------------------------------------------------------------------
// 节点规范（纯数据，headless 可测 runner 行为）
// ---------------------------------------------------------------------------

/** ProseMirror node id for the front matter block. */
export const FRONTMATTER_NODE_NAME = 'frontmatter';

/** Root class on the collapsible metadata chrome (`details`). */
export const FRONTMATTER_CLASS = 'lightink-frontmatter';

const FRONTMATTER_VIEW_KEY = new PluginKey('lightink-frontmatter-view');

function currentFrontMatterLocale(): LocaleId {
  if (typeof document === 'undefined') {
    return DEFAULT_LOCALE;
  }
  const lang = document.documentElement.lang;
  return isLocaleId(lang) ? lang : DEFAULT_LOCALE;
}

/** Line count from raw YAML (`value` split on newline); not a parsed key count. */
export function frontMatterLineCount(value: string): number {
  return value.split('\n').length;
}

/** Neutral summary label plus line-count volume (ADR-3). */
export function frontMatterSummaryLabel(
  value: string,
  locale: LocaleId = currentFrontMatterLocale(),
): string {
  const n = String(frontMatterLineCount(value));
  return `${translate(locale, 'frontmatter.label')} · ${translate(locale, 'frontmatter.lines', { n })}`;
}

function frontMatterRawValue(node: PMNode): string {
  const raw = node.attrs['value'];
  return typeof raw === 'string' ? raw : '';
}

function frontMatterValueFromDOM(dom: HTMLElement): string {
  if (dom.tagName === 'PRE') {
    return dom.textContent ?? '';
  }
  const pre = dom.querySelector('pre');
  return pre?.textContent ?? '';
}

/**
 * Strip `open` from `.lightink-frontmatter` in a cloned export root.
 * Does not touch the ProseMirror document or source Markdown.
 */
export function closeFrontMatterDetails(root: ParentNode): void {
  for (const node of root.querySelectorAll(`.${FRONTMATTER_CLASS}`)) {
    if (node instanceof HTMLDetailsElement) {
      node.open = false;
    }
    node.removeAttribute('open');
  }
}

/**
 * WYSIWYG NodeView: default-closed native `<details>` chrome.
 * `open` is DOM-only; summary clicks are stopped so the browser toggles
 * them without a document transaction.
 */
export function createFrontMatterNodeView(initialNode: PMNode): NodeView {
  let node = initialNode;

  const dom = document.createElement('details');
  dom.className = FRONTMATTER_CLASS;
  dom.setAttribute('data-type', FRONTMATTER_NODE_NAME);
  dom.contentEditable = 'false';
  dom.setAttribute('contenteditable', 'false');

  const summary = document.createElement('summary');
  summary.contentEditable = 'false';
  summary.setAttribute('contenteditable', 'false');

  const pre = document.createElement('pre');

  const sync = (): void => {
    const value = frontMatterRawValue(node);
    summary.textContent = frontMatterSummaryLabel(value);
    pre.textContent = value;
  };
  sync();

  dom.appendChild(summary);
  dom.appendChild(pre);

  return {
    dom,
    stopEvent(event: Event): boolean {
      const target = event.target;
      if (!(target instanceof Node)) {
        return false;
      }
      return summary.contains(target);
    },
    ignoreMutation(): boolean {
      return true;
    },
    update(incoming: PMNode): boolean {
      if (incoming.type !== node.type) {
        return false;
      }
      node = incoming;
      sync();
      return true;
    },
  };
}

/**
 * Plain node schema shared by the `$nodeSchema` wrapper below and by unit
 * tests (which drive the runners with fake parser/serializer states).
 */
export function frontmatterNodeSchema(): NodeSchema {
  return {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: {
      value: { default: '', validate: 'string' },
    },
    parseDOM: [
      {
        tag: `details[data-type="${FRONTMATTER_NODE_NAME}"]`,
        getAttrs: (dom) => ({ value: frontMatterValueFromDOM(dom as HTMLElement) }),
      },
      {
        tag: `pre[data-type="${FRONTMATTER_NODE_NAME}"]`,
        getAttrs: (dom) => ({ value: (dom as HTMLElement).textContent ?? '' }),
      },
    ],
    toDOM: (node) => {
      const value = frontMatterRawValue(node);
      return [
        'details',
        {
          'data-type': FRONTMATTER_NODE_NAME,
          class: FRONTMATTER_CLASS,
          contenteditable: 'false',
        },
        ['summary', { contenteditable: 'false' }, frontMatterSummaryLabel(value)],
        ['pre', {}, value],
      ];
    },
    parseMarkdown: {
      match: (node) => node.type === 'yaml',
      runner: (state, node, proseType) => {
        const value = typeof node['value'] === 'string' ? node['value'] : '';
        state.addNode(proseType, { value });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === FRONTMATTER_NODE_NAME,
      runner: (state, node) => {
        const raw = node.attrs['value'];
        state.addNode('yaml', undefined, typeof raw === 'string' ? raw : '');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Register `remark-frontmatter` on Milkdown's internal remark instance so
 * the WYSIWYG parser/serializer understands `yaml` mdast nodes — the same
 * plugin `parser.ts` registers on the pure stack.
 *
 * 必须显式传 `['yaml']` 作为 initialOptions：Milkdown `$remark` 把
 * `initialOptions ?? {}` 作为 unified `.use(plugin, options)` 的 options，
 * 缺省 `{}` 会被 remark-frontmatter 当作 matter  spec 对象而抛
 * `Missing 'type' in matter '{}'`（编辑器挂载即失败；纯栈 `.use(plugin)`
 * 不传 options 走插件默认 ['yaml']，所以 headless 测试暴露不了）。
 */
export const remarkFrontmatterPlugin = $remark(
  'remarkFrontmatter',
  () => remarkFrontmatter,
  ['yaml'],
);

/** ProseMirror node schema for the `frontmatter` atom block. */
export const frontmatterSchema = $nodeSchema(
  FRONTMATTER_NODE_NAME,
  frontmatterNodeSchema,
);

/** NodeView plugin: default-closed details chrome for the atom. */
export const frontmatterViewPlugin = $prose(
  () =>
    new Plugin({
      key: FRONTMATTER_VIEW_KEY,
      props: {
        nodeViews: {
          [FRONTMATTER_NODE_NAME]: (node: PMNode) => createFrontMatterNodeView(node),
        },
      },
    }),
);

/**
 * Composed Milkdown plugin: remark extension + node schema + NodeView.
 * Register with `editor.use(frontmatterPlugin)` after the `gfm` preset.
 */
export const frontmatterPlugin: MilkdownPlugin[] = [
  remarkFrontmatterPlugin,
  frontmatterSchema,
  frontmatterViewPlugin,
].flat();
