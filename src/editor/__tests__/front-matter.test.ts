// @vitest-environment jsdom

/**
 * Front matter tests (T1 / R5).
 *
 * Coverage:
 *   - `extractFrontMatter` / `hasFrontMatter` pure helpers.
 *   - Regression pin for the silent-rewrite defect: a leading `---…---`
 *     block must parse as an mdast `yaml` node, never as thematicBreak +
 *     setext heading.
 *   - Pure-stack round trip via `roundTripMarkdown`: front matter block
 *     position and content survive parse → serialize unchanged.
 *   - `frontmatterNodeSchema` runners (driven with fake parser/serializer
 *     states) — the exact logic the Milkdown WYSIWYG stack executes.
 *   - Default-closed details toDOM / parseDOM / NodeView chrome; export
 *     helper strips `open` without touching YAML text.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode, NodeType } from '@milkdown/prose/model';
import { Schema } from '@milkdown/prose/model';
import { DecorationSet } from '@milkdown/prose/view';
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from '@milkdown/transformer';

import {
  parseDocument,
  roundTripMarkdown,
  serializeMdastToMarkdown,
} from '../parser.js';
import {
  closeFrontMatterDetails,
  createFrontMatterNodeView,
  extractFrontMatter,
  FRONTMATTER_CLASS,
  FRONTMATTER_NODE_NAME,
  frontMatterLineCount,
  frontMatterSummaryLabel,
  frontmatterNodeSchema,
  frontmatterViewPlugin,
  hasFrontMatter,
} from '../plugins/front-matter.js';

const FM_DOC = [
  '---',
  'title: hello',
  'tags:',
  '  - a',
  '  - b',
  '---',
  '',
  '# Body',
  '',
  'Some text.',
  '',
].join('\n');

describe('extractFrontMatter', () => {
  it('extracts the leading YAML block verbatim', () => {
    const fm = extractFrontMatter(FM_DOC);
    expect(fm).not.toBeNull();
    expect(fm!.value).toBe('title: hello\ntags:\n  - a\n  - b');
  });

  it('returns null when there is no front matter', () => {
    expect(extractFrontMatter('# Just a heading\n')).toBeNull();
    expect(extractFrontMatter('before\n\n---\n\nafter\n')).toBeNull();
    expect(extractFrontMatter('')).toBeNull();
  });

  it('hasFrontMatter mirrors extraction', () => {
    expect(hasFrontMatter(FM_DOC)).toBe(true);
    expect(hasFrontMatter('# Body\n')).toBe(false);
  });
});

describe('front matter parse (regression pin)', () => {
  it('parses the leading block as a yaml node, not hr + setext heading', () => {
    const parsed = parseDocument(FM_DOC);
    const types = parsed.root.children.map((child) => child.type);
    expect(types[0]).toBe('yaml');
    expect(types).not.toContain('thematicBreak');
    // `title: hello` must not be reinterpreted as a setext heading.
    expect(parsed.root.children.filter((c) => c.type === 'heading')).toHaveLength(1);
  });
});

describe('front matter round trip (pure stack)', () => {
  it('keeps block position and content unchanged', () => {
    const out = roundTripMarkdown(FM_DOC);
    // Front matter stays at the top with verbatim content.
    expect(out.startsWith('---\ntitle: hello\ntags:\n  - a\n  - b\n---\n')).toBe(true);
    // Body survives intact.
    expect(out).toContain('# Body');
    expect(out).toContain('Some text.');
  });

  it('is idempotent — a second round trip changes nothing', () => {
    const once = roundTripMarkdown(FM_DOC);
    expect(roundTripMarkdown(once)).toBe(once);
  });

  it('reparses serialized output as a yaml node again', () => {
    const reparsed = parseDocument(roundTripMarkdown(FM_DOC));
    expect(reparsed.root.children[0]?.type).toBe('yaml');
  });

  it('leaves documents without front matter untouched in structure', () => {
    const md = '# Title\n\nbefore\n\n---\n\nafter\n';
    const out = serializeMdastToMarkdown(parseDocument(md).root);
    const reparsed = parseDocument(out);
    const types = reparsed.root.children.map((c) => c.type);
    // remark-stringify emits `***` for thematic breaks (avoids ambiguity with
    // front matter fences); either marker must reparse as thematicBreak.
    expect(types).toContain('thematicBreak');
    expect(types[0]).not.toBe('yaml');
  });
});

describe('frontmatterNodeSchema runners', () => {
  it('parseMarkdown runner adds a frontmatter node carrying the raw value', () => {
    const added: Array<{ type: unknown; attrs: unknown }> = [];
    const fakeState = {
      addNode: (type: unknown, attrs: unknown) => {
        added.push({ type, attrs });
      },
    } as unknown as ParserState;
    const proseType = { name: 'frontmatter' } as NodeType;
    const yamlNode = { type: 'yaml', value: 'title: x' } as MarkdownNode;

    const schema = frontmatterNodeSchema();
    expect(schema.parseMarkdown.match(yamlNode)).toBe(true);
    expect(schema.parseMarkdown.match({ type: 'paragraph' } as MarkdownNode)).toBe(false);
    schema.parseMarkdown.runner(fakeState, yamlNode, proseType);

    expect(added).toHaveLength(1);
    expect(added[0]!.type).toBe(proseType);
    expect(added[0]!.attrs).toEqual({ value: 'title: x' });
  });

  it('toMarkdown runner emits a yaml node with the stored value', () => {
    const added: Array<{ type: string; value: unknown }> = [];
    const fakeState = {
      addNode: (type: string, _children: unknown, value: unknown) => {
        added.push({ type, value });
      },
    } as unknown as SerializerState;
    const pmNode = {
      type: { name: 'frontmatter' },
      attrs: { value: 'title: x' },
    } as unknown as PMNode;

    const schema = frontmatterNodeSchema();
    expect(schema.toMarkdown.match(pmNode)).toBe(true);
    schema.toMarkdown.runner(fakeState, pmNode);

    expect(added).toEqual([{ type: 'yaml', value: 'title: x' }]);
  });

  it('toMarkdown match ignores other node types', () => {
    const schema = frontmatterNodeSchema();
    const paragraph = { type: { name: 'paragraph' }, attrs: {} } as unknown as PMNode;
    expect(schema.toMarkdown.match(paragraph)).toBe(false);
  });

  it('toDOM renders a closed details.lightink-frontmatter with summary and raw pre', () => {
    const schema = frontmatterNodeSchema();
    const pmNode = {
      type: { name: 'frontmatter' },
      attrs: { value: 'title: x' },
    } as unknown as PMNode;
    const spec = schema.toDOM!(pmNode) as unknown as [
      string,
      Record<string, string>,
      [string, Record<string, string>, string],
      [string, Record<string, string>, string],
    ];
    expect(spec[0]).toBe('details');
    expect(spec[1]['data-type']).toBe(FRONTMATTER_NODE_NAME);
    expect(spec[1]['class']).toBe(FRONTMATTER_CLASS);
    expect(spec[1]['open']).toBeUndefined();
    expect(spec[1]['contenteditable']).toBe('false');
    expect(spec[2][0]).toBe('summary');
    expect(spec[2][1]['contenteditable']).toBe('false');
    expect(spec[2][2]).toBe(frontMatterSummaryLabel('title: x'));
    expect(spec[3][0]).toBe('pre');
    expect(spec[3][2]).toBe('title: x');
  });

  it('parseDOM reads raw value from details>pre and from legacy pre', () => {
    const schema = frontmatterNodeSchema();
    const parseDOM = schema.parseDOM ?? [];
    const detailsRule = parseDOM.find((rule) =>
      (rule.tag ?? '').includes('details'),
    );
    const preRule = parseDOM.find((rule) => (rule.tag ?? '').includes('pre'));
    expect(detailsRule?.getAttrs).toBeTypeOf('function');
    expect(preRule?.getAttrs).toBeTypeOf('function');

    const details = document.createElement('details');
    details.setAttribute('data-type', FRONTMATTER_NODE_NAME);
    details.className = FRONTMATTER_CLASS;
    const summary = document.createElement('summary');
    summary.textContent = '文档属性 · 2 行';
    const inner = document.createElement('pre');
    inner.textContent = 'a: 1\n# keep';
    details.append(summary, inner);
    expect(detailsRule!.getAttrs!(details)).toEqual({ value: 'a: 1\n# keep' });

    const legacy = document.createElement('pre');
    legacy.setAttribute('data-type', FRONTMATTER_NODE_NAME);
    legacy.className = FRONTMATTER_CLASS;
    legacy.textContent = 'title: x';
    expect(preRule!.getAttrs!(legacy)).toEqual({ value: 'title: x' });
  });
});

describe('front matter summary volume', () => {
  it('counts newline segments without parsing YAML', () => {
    expect(frontMatterLineCount('')).toBe(1);
    expect(frontMatterLineCount('title: hello\ntags:\n  - a\n  - b')).toBe(4);
    expect(frontMatterLineCount('# comment\nnested:\n  - x')).toBe(3);
  });

  it('uses neutral i18n labels, not schema keys', () => {
    const yaml = 'format: execution_plan\nsummary: secret\ntasks:\n  - id: T1';
    expect(frontMatterSummaryLabel(yaml, 'en')).toBe('Properties · 4 lines');
    expect(frontMatterSummaryLabel(yaml, 'zh-CN')).toBe('文档属性 · 4 行');
    expect(frontMatterSummaryLabel(yaml, 'en')).not.toContain('execution_plan');
    expect(frontMatterSummaryLabel(yaml, 'en')).not.toContain('secret');
  });
});

describe('createFrontMatterNodeView', () => {
  const viewSchema = new Schema({
    nodes: {
      doc: { content: 'frontmatter' },
      frontmatter: {
        atom: true,
        attrs: { value: { default: '' } },
        toDOM: () => ['details', 0],
      },
      paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
      text: {},
    },
  });

  function makeNode(value: string): PMNode {
    return viewSchema.nodes['frontmatter']!.create({ value });
  }

  it('renders a default-closed details bar with original YAML in pre', () => {
    const value = '# keep comment\nnested:\n  - a';
    const nv = createFrontMatterNodeView(makeNode(value));
    const dom = nv.dom as HTMLDetailsElement;
    expect(dom.tagName).toBe('DETAILS');
    expect(dom.className).toBe(FRONTMATTER_CLASS);
    expect(dom.getAttribute('data-type')).toBe(FRONTMATTER_NODE_NAME);
    expect(dom.hasAttribute('open')).toBe(false);
    expect(dom.open).toBe(false);
    expect(dom.getAttribute('contenteditable')).toBe('false');

    const summary = dom.querySelector('summary');
    expect(summary).not.toBeNull();
    expect(summary!.getAttribute('contenteditable')).toBe('false');
    expect(summary!.textContent).toBe(frontMatterSummaryLabel(value));

    const pre = dom.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe(value);
    expect(dom.querySelector('input, textarea, select')).toBeNull();
  });

  it('stopEvent lets summary clicks through to the browser', () => {
    const nv = createFrontMatterNodeView(makeNode('title: x'));
    const dom = nv.dom as HTMLDetailsElement;
    const summary = dom.querySelector('summary')!;
    const pre = dom.querySelector('pre')!;
    const summaryClick = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(summaryClick, 'target', { value: summary });
    expect(nv.stopEvent?.(summaryClick)).toBe(true);
    const preClick = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(preClick, 'target', { value: pre });
    expect(nv.stopEvent?.(preClick)).toBe(false);
  });

  it('update syncs raw value and ignores open mutations', () => {
    const nv = createFrontMatterNodeView(makeNode('a: 1'));
    const dom = nv.dom as HTMLDetailsElement;
    expect(
      nv.ignoreMutation?.({
        type: 'attributes',
        attributeName: 'open',
        target: dom,
      } as unknown as MutationRecord),
    ).toBe(true);
    const next = makeNode('# c\nb: 2');
    expect(nv.update?.(next, [], DecorationSet.empty)).toBe(true);
    expect(dom.querySelector('pre')!.textContent).toBe('# c\nb: 2');
    expect(dom.querySelector('summary')!.textContent).toBe(frontMatterSummaryLabel('# c\nb: 2'));
    expect(dom.open).toBe(false);
    expect(nv.update?.(viewSchema.nodes['paragraph']!.create(), [], DecorationSet.empty)).toBe(
      false,
    );
  });
});

describe('closeFrontMatterDetails', () => {
  it('removes open on front matter details without rewriting YAML or other details', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<details class="lightink-frontmatter" data-type="frontmatter" open>',
      '<summary>文档属性 · 2 行</summary>',
      '<pre>title: x\n# keep</pre>',
      '</details>',
      '<details class="other" open><summary>note</summary><p>body</p></details>',
    ].join('');
    closeFrontMatterDetails(root);
    const fm = root.querySelector('details.lightink-frontmatter') as HTMLDetailsElement;
    const other = root.querySelector('details.other') as HTMLDetailsElement;
    expect(fm.open).toBe(false);
    expect(fm.hasAttribute('open')).toBe(false);
    expect(fm.querySelector('pre')!.textContent).toBe('title: x\n# keep');
    expect(other.open).toBe(true);
    expect(other.hasAttribute('open')).toBe(true);
  });
});

describe('frontmatterViewPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(frontmatterViewPlugin).toBeDefined();
    expect(typeof frontmatterViewPlugin).toBe('function');
    const shaped = frontmatterViewPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    expect(shaped.plugin()).toBeUndefined();
  });
});
