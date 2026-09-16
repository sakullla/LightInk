/**
 * LaTeX math rendering plugin (T8 / R8).
 *
 * Design (per docs/sakullla-workflow/.../02-technical-solution.md「公式：
 * KaTeX，按需加载」):
 *
 *   - Rendering engine is KaTeX (faster and smaller than MathJax). It is
 *     loaded **lazily**: `createKatexLoader` wraps dynamic imports for both
 *     `katex` and its stylesheet in one memoized promise. The ProseMirror
 *     plugin only invokes it when the document actually contains math, so
 *     ordinary Markdown documents pay neither the JS nor font/CSS cost.
 *
 *   - The pure logic layer is headless-testable:
 *       scanTextMath(text, baseOffset)   — `$…$` / `$$…$$` → segments
 *       extractMathSegments(markdown)    — same, but walks the MDAST from
 *                                          parser.ts so code blocks / inline
 *                                          code / raw HTML are excluded
 *       renderMathHtml(latex, mode, kx)  — KaTeX HTML, or the raw source in
 *                                          a `<code class="lightink-math-error">`
 *                                          wrapper on syntax error (R8: 语法
 *                                          错误时原样显示源码)
 *       hasMath(markdown)                — cheap gate for the lazy loader
 *
 *   - Delimiter rules are conservative (pandoc-ish) so currency text like
 *     "价格是 $5 和 $10" is NOT math: an inline `$` opener must be followed
 *     immediately by a non-space character, the closer must be preceded by a
 *     non-space character and must not be followed immediately by a digit,
 *     and the content must be non-empty. `$$…$$` requires non-blank content.
 *     `\$` escapes are honored. Trade-off: `$5$` (digit content) still parses
 *     as math — see test notes.
 *
 *   - The ProseMirror wiring follows the same `$prose` decoration pattern as
 *     code-highlight.ts: decorations never mutate the document, so the raw
 *     markdown source stays intact and editable. For each segment we add an
 *     inline decoration over the source range (`lightink-math-inline-source`
 *     / `lightink-math-block-source`, or `lightink-math-error` on failure —
 *     the error case gets NO rendered widget, so the source displays as-is,
 *     isolated to that node) plus, on success, a widget decoration right
 *     after the source carrying the rendered KaTeX HTML. Visibility is
 *     CSS-driven (prose.css hides the source, ui/theme.css restores it for
 *     the textblock holding the selection), so decorations always carry both
 *     source and preview and the exported HTML (prose.css only) keeps the
 *     rendered form. Error isolation is per-segment: a bad formula never
 *     affects siblings or surrounding text.
 */

import { $prose } from '@milkdown/utils';
import { appendPreviewEditButton } from './preview-edit-button.js';
import { Plugin, PluginKey, TextSelection, type Selection } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/prose/view';

import { parseMarkdownToMdast } from '../parser.js';

// ---------------------------------------------------------------------------
// 纯逻辑层：分段扫描（headless 可测）
// ---------------------------------------------------------------------------

/** 一段公式：`inline`（$…$）或 `block`（$$…$$），from/to 为源码偏移（含定界符）。 */
export interface MathSegment {
  readonly type: 'inline' | 'block';
  /** 定界符之间的 LaTeX 源码（已 trim 首尾空白）。 */
  readonly latex: string;
  /** 起始定界符 `$` 的偏移。 */
  readonly from: number;
  /** 结束定界符之后的偏移（半开区间）。 */
  readonly to: number;
}

/** HTML 转义（错误分支显示源码用，保证 `<script>` 不被注入）。 */
export function escapeMathHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}

/** `text[i]` 是否为未被 `\` 转义的 `$`。 */
function isDollar(text: string, i: number): boolean {
  return text[i] === '$' && text[i - 1] !== '\\';
}

/**
 * 扫描一段纯文本中的公式（不感知 markdown 结构；code 排除由
 * `extractMathSegments` 的 MDAST 层负责）。`baseOffset` 会加到所有偏移上，
 * PM 层用它把 textblock 内偏移映射到文档位置。
 */
export function scanTextMath(text: string, baseOffset = 0): MathSegment[] {
  const out: MathSegment[] = [];
  scanTextMathInto(text, (i) => baseOffset + i, out);
  return out;
}

/**
 * 扫描内核。`locate` 把 text 内下标映射到输出偏移（MDAST 重建文本时
 * 下标 ≠ 源码偏移，靠 map 表还原；纯文本时是 baseOffset + i）。
 */
function scanTextMathInto(
  text: string,
  locate: (index: number) => number,
  out: MathSegment[],
): void {
  const n = text.length;
  const consumed = new Array<boolean>(n).fill(false);

  // 第一遍：$$…$$ 块级（优先于行内，避免 `$$` 被拆成两个空行内）。
  let i = 0;
  while (i + 1 < n) {
    if (isDollar(text, i) && text[i + 1] === '$') {
      let j = i + 2;
      while (j + 1 < n && !(isDollar(text, j) && text[j + 1] === '$')) {
        j++;
      }
      if (j + 1 < n) {
        const latex = text.slice(i + 2, j).trim();
        if (latex.length > 0) {
          out.push({ type: 'block', latex, from: locate(i), to: locate(j + 1) + 1 });
          for (let k = i; k <= j + 1; k++) consumed[k] = true;
          i = j + 2;
          continue;
        }
      }
      // 未闭合或内容空白：不是块公式，前进一位让行内遍/后续再判断。
      i++;
      continue;
    }
    i++;
  }

  // 第二遍：$…$ 行内（保守规则，见文件头注释）。
  i = 0;
  while (i < n) {
    if (consumed[i] || !isDollar(text, i)) {
      i++;
      continue;
    }
    const open = i;
    // 起始 `$` 之后必须紧跟非空白、非 `$` 且未被块级消费。
    if (open + 1 >= n || consumed[open + 1] || isSpace(text[open + 1]) || text[open + 1] === '$') {
      i++;
      continue;
    }
    let close = -1;
    for (let j = open + 1; j < n; j++) {
      if (consumed[j] || !isDollar(text, j)) continue;
      // 结束 `$` 前必须是非空白，且其后不能紧跟数字（货币保护）。
      if (isSpace(text[j - 1]) || isDigit(text[j + 1])) continue;
      close = j;
      break;
    }
    if (close === -1 || close === open + 1) {
      i++;
      continue;
    }
    const latex = text.slice(open + 1, close);
    out.push({ type: 'inline', latex, from: locate(open), to: locate(close) + 1 });
    i = close + 1;
  }

  // 按源码顺序排序（块级遍先行会打乱顺序）。
  out.sort((a, b) => a.from - b.from);
}

// ---------------------------------------------------------------------------
// 纯逻辑层：markdown → 公式段（经 MDAST，排除 code / inlineCode / html）
// ---------------------------------------------------------------------------

interface MdastNodeLike {
  type: string;
  value?: string;
  children?: MdastNodeLike[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** 这些节点的文本内容绝不参与公式识别（代码、原始 HTML）。 */
const MDAST_SKIP_TYPES: ReadonlySet<string> = new Set(['code', 'inlineCode', 'html']);

/**
 * 这些节点截断公式缓冲区（其文本不可作为公式的一部分）：
 * 行内代码、原始 HTML、图片等原子节点。注意 `inlineCode`/`html` 同时也在
 * SKIP 集合里——这里需要的是「flush 并跳过」，而非「整体不进子树」。
 */
const INLINE_BARRIER_TYPES: ReadonlySet<string> = new Set([
  'inlineCode',
  'html',
  'image',
  'imageReference',
  'footnoteReference',
]);

/**
 * 从 markdown 源码提取全部公式段（含源码偏移）。经 parser.ts 的 MDAST
 * 遍历， fenced code / inline code / raw HTML 内的 `$` 不会被误识别。
 */
export function extractMathSegments(markdown: string): MathSegment[] {
  const root = parseMarkdownToMdast(markdown) as unknown as MdastNodeLike;
  const out: MathSegment[] = [];
  walkBlock(root, markdown, out);
  out.sort((a, b) => a.from - b.from);
  return out;
}

function walkBlock(node: MdastNodeLike, source: string, out: MathSegment[]): void {
  if (MDAST_SKIP_TYPES.has(node.type)) return;
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
    collectInlineMath(node.children ?? [], source, out);
    return;
  }
  for (const child of node.children ?? []) walkBlock(child, source, out);
}

/**
 * 把一个 textblock 的行内子树重建为连续文本后扫描公式。text 节点取
 * **原始源码切片**（而非 MDAST 解码后的 value），以保留 LaTeX 必需的
 * 反斜杠（`\,`、`\$` 等会被 CommonMark 转义解码吃掉）；`break` 重建为
 * `\n`（使多行 $$…$$ 可识别）；emphasis/strong/delete/link 等透明下钻；
 * 屏障节点 flush 缓冲，保证公式不会跨越 inlineCode 边界拼接。
 */
function collectInlineMath(
  children: readonly MdastNodeLike[],
  source: string,
  out: MathSegment[],
): void {
  let buf = '';
  let map: number[] = []; // buf 下标 → 源码偏移
  const flush = (): void => {
    if (buf.length > 0) {
      scanTextMathInto(buf, (idx) => map[idx] ?? 0, out);
    }
    buf = '';
    map = [];
  };
  const append = (value: string, offset: number): void => {
    for (let k = 0; k < value.length; k++) {
      buf += value[k];
      map.push(offset + k);
    }
  };
  const visit = (child: MdastNodeLike): void => {
    if (INLINE_BARRIER_TYPES.has(child.type)) {
      flush();
      return;
    }
    if (child.type === 'text') {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start !== undefined && end !== undefined && end >= start) {
        append(source.slice(start, end), start);
      } else {
        append(child.value ?? '', start ?? 0);
      }
      return;
    }
    if (child.type === 'break') {
      // CommonMark turns a trailing backslash+newline into a hard break.
      // Keep the original source slice so multi-line $$…$$ keeps LaTeX `\\`.
      const brStart = child.position?.start?.offset;
      const brEnd = child.position?.end?.offset;
      if (brStart !== undefined && brEnd !== undefined && brEnd > brStart) {
        append(source.slice(brStart, brEnd), brStart);
      } else {
        append('\n', brStart ?? 0);
      }
      return;
    }
    for (const grand of child.children ?? []) visit(grand);
  };
  for (const child of children) visit(child);
  flush();
}

/** markdown 中是否含公式（惰性加载的门槛判断）。 */
export function hasMath(markdown: string): boolean {
  return extractMathSegments(markdown).length > 0;
}

// ---------------------------------------------------------------------------
// 纯逻辑层：KaTeX 渲染与错误隔离
// ---------------------------------------------------------------------------

/** KaTeX 模块的最小契约（真实模块与测试替身共用这个形状）。 */
export interface KatexRenderer {
  renderToString(
    latex: string,
    options?: {
      throwOnError?: boolean;
      displayMode?: boolean;
      strict?: boolean | 'ignore' | 'error' | 'warn';
    },
  ): string;
}

interface RenderOutcome {
  readonly html: string;
  readonly error: boolean;
}

/**
 * 以 throwOnError:true 渲染；语法错误时返回 error 标记而不产出 KaTeX
 * HTML（调用方据此原样显示源码，而不是用 KaTeX 的红字错误样式）。
 */
function tryRenderKatex(latex: string, displayMode: boolean, katex: KatexRenderer): RenderOutcome {
  const source = displayMode ? normalizeDisplayLatex(latex) : latex;
  if (source === '') {
    return { html: '', error: true };
  }
  try {
    return {
      html: katex.renderToString(source, {
        throwOnError: true,
        displayMode,
        // Multi-line environments (\begin{aligned} …) need full trust of \\ newlines.
        strict: 'ignore',
      }),
      error: false,
    };
  } catch {
    return { html: '', error: true };
  }
}

/**
 * 渲染结果缓存（按渲染器 + displayMode + latex）。selection 变化会重建
 * decorations，缓存避免同一公式被反复喂给 KaTeX。渲染器以 WeakMap 隔离，
 * 测试替身之间不串味；FIFO 上限防止超长文档无限增长。
 */
const renderOutcomeCache = new WeakMap<KatexRenderer, Map<string, RenderOutcome>>();
const RENDER_CACHE_LIMIT = 256;

function renderOutcomeFor(
  latex: string,
  displayMode: boolean,
  katex: KatexRenderer,
): RenderOutcome {
  let cache = renderOutcomeCache.get(katex);
  if (cache === undefined) {
    cache = new Map<string, RenderOutcome>();
    renderOutcomeCache.set(katex, cache);
  }
  const key = `${displayMode ? 'block' : 'inline'}\n${latex}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const outcome = tryRenderKatex(latex, displayMode, katex);
  if (cache.size >= RENDER_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, outcome);
  return outcome;
}

/**
 * 渲染单个公式为 HTML 字符串：成功 → KaTeX HTML；语法错误 →
 * `<code class="lightink-math-error">` 包裹的转义源码（错误被隔离在该
 * 片段内，不影响文档其他部分）。
 */
export function renderMathHtml(latex: string, displayMode: boolean, katex: KatexRenderer): string {
  const outcome = renderOutcomeFor(latex, displayMode, katex);
  if (outcome.error) {
    return `<code class="lightink-math-error">${escapeMathHtml(latex)}</code>`;
  }
  return outcome.html;
}

// ---------------------------------------------------------------------------
// 惰性加载：仅当文档确有公式时才 import('katex')，且只加载一次
// ---------------------------------------------------------------------------

/**
 * 构造一个 memoized 的 KaTeX 加载器。JS 和样式工厂均可注入，便于断言
 * 「无公式时从不触发 import」。样式加载完成前不会返回 renderer，避免首帧
 * 公式以无字体布局闪现。失败 Promise 同样缓存，避免每次编辑都重试。
 */
export function createKatexLoader(
  load: () => Promise<unknown> = () => import('katex'),
  loadStyles: () => Promise<unknown> = () => import('katex/dist/katex.min.css'),
): () => Promise<KatexRenderer> {
  let cached: Promise<KatexRenderer> | null = null;
  return () => {
    if (cached === null) {
      cached = Promise.all([
        Promise.resolve().then(load),
        Promise.resolve().then(loadStyles),
      ]).then(([mod]) => {
        const shaped = mod as Partial<KatexRenderer> & { default?: Partial<KatexRenderer> };
        const renderer = (shaped.default ?? shaped) as Partial<KatexRenderer>;
        if (typeof renderer.renderToString !== 'function') {
          throw new Error('katex module does not expose renderToString');
        }
        return renderer as KatexRenderer;
      });
    }
    return cached;
  };
}

// ---------------------------------------------------------------------------
// ProseMirror decoration 层
// ---------------------------------------------------------------------------

/** 公式插件状态：KaTeX + 块级公式编辑位 + decorations。 */
export interface MathPluginState {
  readonly katex: KatexRenderer | null;
  /**
   * Position of a ```math / latex / katex code_block open for source editing
   * (double-click preview). null = successful math fences show preview only.
   */
  readonly editingPos: number | null;
  /**
   * 选区所在 textblock 的文档位置（正文 $ 公式的源码编辑态）；该段由
   * `.lightink-math-active` 显示源码、隐藏预览。
   */
  readonly activeBlockPos: number | null;
  readonly decorations: DecorationSet;
}

export const mathPluginKey = new PluginKey<MathPluginState>('lightink-math');

/** Tooltip on math preview widget (host may retranslate). */
let MATH_EDIT_TITLE = '双击编辑公式源码';

/** Update math preview tooltip after language switch. */
export function setMathEditTitle(title: string): void {
  if (title.trim() !== '') {
    MATH_EDIT_TITLE = title.trim();
  }
}

/** PM 事务元数据：KaTeX 加载 / 进入退出块级公式编辑。 */
interface MathPluginMeta {
  katex?: KatexRenderer;
  editingPos?: number | null;
}

/**
 * Fence info-string is a math block (```math / latex / katex).
 * Same token rule as mermaid: first whitespace-separated token, lowercased.
 */
export function isMathBlock(infoString: string | null | undefined): boolean {
  if (infoString === null || infoString === undefined) return false;
  const tag = infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return tag === 'math' || tag === 'latex' || tag === 'katex';
}

/**
 * LaTeX source inside a math fence.
 * Use textBetween(…, '\\n') so multi-line formulas keep real newlines (not
 * collapsed textContent joining). Normalize CRLF. Empty → null (pending).
 */
export function mathFenceDefinitionOf(node: PMNode): string | null {
  if (node.type.name !== 'code_block') return null;
  const language =
    typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
  if (!isMathBlock(language)) return null;
  const text = node
    .textBetween(0, node.content.size, '\n', '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  return text === '' ? null : text;
}

/**
 * Prepare fence LaTeX for KaTeX displayMode.
 * Multi-line bodies without an environment still render as one display block;
 * trailing \\ on intermediate lines is left to the author (aligned/gather).
 */
export function normalizeDisplayLatex(latex: string): string {
  return (
    latex
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // CommonMark hard-break eats the final backslash before newline in PM.
      // Restore LaTeX `\\` row breaks without doubling fence-sourced `\\`.
      .replace(/(?<!\\)\\\n/g, '\\\\\n')
      .trim()
  );
}

/** 文档是否含行内/块级 $ 公式或 math 代码块（惰性加载门槛）。 */
function docHasMath(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'code_block') {
      const lang =
        typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
      if (isMathBlock(lang)) {
        found = true;
        return false;
      }
      return false; // never scan ordinary code as $ math
    }
    if (!node.isTextblock) return true;
    if (scanMathInTextblock(node).length > 0) {
      found = true;
    }
    return false;
  });
  return found;
}

/**
 * 选区 head 所在 textblock 的文档位置；不在 textblock 时（如顶层节点
 * 选区、```math 代码块）返回 null。正文公式据「光标所在段落」决定源码
 * 编辑态：命中段落由 decorations 打上 .lightink-math-active。
 */
export function activeTextblockPos(selection: Selection): number | null {
  const { $head } = selection;
  if ($head.depth === 0 || !$head.parent.isTextblock) {
    return null;
  }
  return $head.start($head.depth) - 1;
}

/**
 * 在 textblock 内扫描公式段，排除 inline code（code mark）覆盖的区间。
 * 返回段的 from/to 为「textblock 内文本偏移」，由调用方加 pos+1 换算为
 * 文档位置。
 *
 * 已知取舍：remark 在解析期把 `\$` 解码为字面 `$`，PM 文本层看不到转义
 * 反斜杠，故源码 `\$x$` 在本层会被当作公式渲染；严格语义需源码级映射，
 * 当前按 PM 层近似接受（罕见的刻意转义场景）。
 */
function scanMathInTextblock(
  node: PMNode,
): Array<{ type: 'inline' | 'block'; latex: string; from: number; to: number }> {
  const text = node.textBetween(0, node.content.size, '\n', '\n');
  // 按 code mark 把文本切为若干非 code 段，逐段扫描（与 MDAST 层的
  // barrier-flush 语义一致：inline code 充当屏障，其内的 `$` 不会被当作
  // 定界符参与跨段配对）。
  const segments: Array<{ type: 'inline' | 'block'; latex: string; from: number; to: number }> = [];
  let chunkStart: number | null = null;
  let offset = 0;
  const flush = (end: number): void => {
    if (chunkStart !== null && end > chunkStart) {
      segments.push(...scanTextMath(text.slice(chunkStart, end), chunkStart));
    }
    chunkStart = null;
  };
  node.forEach((child) => {
    if (child.isText && child.text !== undefined) {
      const size = child.text.length;
      const isCode = child.marks.some((m) => m.type.name === 'code');
      if (isCode) {
        flush(offset);
      } else if (chunkStart === null) {
        chunkStart = offset;
      }
      offset += size;
    } else {
      // 非文本叶子（hardBreak/image 等）在 textBetween 中占 1 字符；它不构成
      // 屏障（跨 hardBreak 的 $$ 块公式需保持可匹配），只随占位前进偏移。
      offset += 1;
    }
  });
  flush(offset);
  return segments;
}

/** `buildMathDecorations` 的可选行为注入。 */
export interface MathDecorationOptions {
  /** ```math / latex / katex 代码块的源码编辑位（双击预览进入）。 */
  readonly editingPos?: number | null;
  /** 选区所在 textblock 的文档位置（activeTextblockPos）；该段打上源码编辑态类。 */
  readonly activeBlockPos?: number | null;
  /** fence 预览的「编辑源码」请求（blockPos 为 code_block 起始位置）。 */
  readonly onEditRequest?: (blockPos: number) => void;
  /** 正文公式预览被点击：把选区放进源码（from 为起始 `$` 的文档位置）。 */
  readonly onActivateSegment?: (from: number) => void;
}

/**
 * 为整篇文档构建公式 decorations。
 *
 *   A) 行内/块级 `$…$` / `$$…$$`（正文 textblock）
 *        - 渲染成功 → 源码 inline decoration + KaTeX 预览 widget；显示切换
 *          交给 CSS：prose.css 隐藏源码，选区所在段落的 .lightink-math-active
 *          （theme.css）恢复源码并隐藏预览。decorations 本身始终含两者，
 *          导出件（只带 prose.css）因此恒为渲染结果。
 *        - 失败 → 仅 error class，源码原样可见
 *   B) 特殊代码块 ```math / latex / katex（对齐 mermaid 流程图 UX）：
 *        - 成功且未编辑 → 隐藏源码 + KaTeX 预览 widget（双击进入编辑）
 *        - 成功且 editingPos 命中 → 显示源码（lightink-math-editing）
 *        - 失败 / 空 / katex 未加载 → 源码可见 + pending/error 样式
 *
 * `katex` 为 null 时：行内 $ 不渲染；math fence 仍打 pending 样式。
 */
export function buildMathDecorations(
  doc: PMNode,
  katex: KatexRenderer | null,
  options: MathDecorationOptions = {},
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    // --- Special math code fences (```math) ---------------------------------
    if (node.type.name === 'code_block') {
      const lang =
        typeof node.attrs['language'] === 'string' ? (node.attrs['language'] as string) : '';
      if (!isMathBlock(lang)) return false;
      const def = mathFenceDefinitionOf(node);
      const isEditing = options.editingPos === pos;
      if (def === null || katex === null) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: 'lightink-math-pending',
            'data-math-fence': 'pending',
          }),
        );
        return false;
      }
      const outcome = renderOutcomeFor(def, true, katex);
      if (outcome.error) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: 'lightink-math-fence-error',
            'data-math-fence': 'error',
            // Keep enough of multi-line source for the dashed error chrome.
            'data-math-error': def.slice(0, 240).replace(/\n/g, '↵'),
          }),
        );
        return false;
      }
      if (isEditing) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: 'lightink-math-editing',
            'data-math-fence': 'editing',
          }),
        );
        return false;
      }
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: 'lightink-math-source',
          'data-math-fence': 'rendered',
        }),
      );
      const html = outcome.html;
      const blockPos = pos;
      // Content-address key so multi-line edits re-render the widget reliably.
      const lineCount = def.split('\n').length;
      const keyHash = `${blockPos}-${def.length}-${lineCount}`;
      decorations.push(
        Decoration.widget(
          pos + node.nodeSize,
          () => {
            const el = document.createElement('div');
            el.className = 'lightink-math-preview';
            el.setAttribute('title', MATH_EDIT_TITLE);
            el.setAttribute('data-math-preview', '');
            el.setAttribute('data-math-lines', String(lineCount));
            el.innerHTML = html;
            appendPreviewEditButton(el, MATH_EDIT_TITLE, () => options.onEditRequest?.(blockPos));
            el.addEventListener('dblclick', (event) => {
              event.preventDefault();
              event.stopPropagation();
              options.onEditRequest?.(blockPos);
            });
            return el;
          },
          { side: 1, key: `lightink-math-fence-${keyHash}` },
        ),
      );
      return false;
    }

    // --- Inline / body $…$  /  $$…$$  (requires katex) ----------------------
    if (katex === null) return true;
    if (!node.isTextblock) return true;
    const segments = scanMathInTextblock(node).map((seg) => ({
      ...seg,
      from: seg.from + pos + 1,
      to: seg.to + pos + 1,
    }));
    if (segments.length === 0) return false;
    if (options.activeBlockPos === pos) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: 'lightink-math-active' }),
      );
    }
    for (const seg of segments) {
      const displayMode = seg.type === 'block';
      const outcome = renderOutcomeFor(seg.latex, displayMode, katex);
      if (outcome.error) {
        decorations.push(
          Decoration.inline(seg.from, seg.to, {
            class: 'lightink-math-error',
            'data-math-error': 'true',
          }),
        );
        continue;
      }
      decorations.push(
        Decoration.inline(seg.from, seg.to, {
          class: displayMode ? 'lightink-math-block-source' : 'lightink-math-inline-source',
          'data-math-rendered': 'true',
        }),
      );
      const html = outcome.html;
      decorations.push(
        Decoration.widget(
          seg.to,
          () => {
            // span（display:block 由 prose.css 提供）保证导出 HTML 里
            // `<p><span class="lightink-math-block">…</span></p>` 仍合法。
            const el = document.createElement('span');
            el.className = displayMode ? 'lightink-math-block' : 'lightink-math-inline';
            el.innerHTML = html;
            el.addEventListener('mousedown', (event) => {
              if (options.onActivateSegment === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              options.onActivateSegment(seg.from);
            });
            return el;
          },
          { side: 1, key: `lightink-math-${seg.from}` },
        ),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Milkdown 插件
// ---------------------------------------------------------------------------

/**
 * Milkdown 插件（`$prose`）：行内 `$…$` / 块级 `$$…$$` + 特殊代码块 ```math。
 * 代码块路径对齐 mermaid：预览 / 双击编辑源码 / 错误隔离。
 */
export const mathPlugin = $prose(() => {
  const loadKatex = createKatexLoader();
  let loadRequested = false;
  let editorView: EditorView | null = null;

  const requestEdit = (blockPos: number): void => {
    if (editorView === null) return;
    const node = editorView.state.doc.nodeAt(blockPos);
    let tr = editorView.state.tr.setMeta(mathPluginKey, {
      editingPos: blockPos,
    } satisfies MathPluginMeta);
    if (node !== null) {
      const inner = Math.min(blockPos + 1, editorView.state.doc.content.size);
      try {
        tr = tr.setSelection(TextSelection.create(tr.doc, inner));
      } catch {
        /* ignore */
      }
    }
    editorView.dispatch(tr.scrollIntoView());
    editorView.focus();
  };

  /** 点击正文公式预览：选区落入源码起点，段落随即进入源码编辑态。 */
  const activateSegment = (from: number): void => {
    if (editorView === null) return;
    try {
      const tr = editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, from),
      );
      editorView.dispatch(tr.scrollIntoView());
    } catch {
      /* ignore */
    }
    editorView.focus();
  };

  const rebuild = (
    doc: PMNode,
    katex: KatexRenderer | null,
    editingPos: number | null,
    activeBlockPos: number | null,
  ): MathPluginState => ({
    katex,
    editingPos,
    activeBlockPos,
    decorations: buildMathDecorations(doc, katex, {
      editingPos,
      activeBlockPos,
      onEditRequest: requestEdit,
      onActivateSegment: activateSegment,
    }),
  });

  return new Plugin<MathPluginState>({
    key: mathPluginKey,
    state: {
      init: (_config, state) =>
        rebuild(state.doc, null, null, activeTextblockPos(state.selection)),
      apply: (tr, old, _oldState, newState) => {
        const meta = tr.getMeta(mathPluginKey) as MathPluginMeta | undefined;
        const katex = meta?.katex ?? old.katex;

        let editingPos = old.editingPos;
        if (meta !== undefined && 'editingPos' in meta) {
          editingPos = meta.editingPos ?? null;
        } else if (editingPos !== null && tr.docChanged) {
          const mapped = tr.mapping.mapResult(editingPos, 1);
          if (mapped.deleted) {
            editingPos = null;
          } else {
            editingPos = mapped.pos;
            const node = newState.doc.nodeAt(editingPos);
            const lang =
              node !== null && typeof node.attrs['language'] === 'string'
                ? (node.attrs['language'] as string)
                : '';
            if (node === null || node.type.name !== 'code_block' || !isMathBlock(lang)) {
              editingPos = null;
            }
          }
        }

        // Leave edit mode when selection leaves the math fence.
        if (editingPos !== null && tr.selectionSet && !tr.docChanged) {
          const node = newState.doc.nodeAt(editingPos);
          if (node !== null) {
            const from = editingPos;
            const to = editingPos + node.nodeSize;
            const { from: selFrom, to: selTo } = newState.selection;
            if (!(selFrom >= from && selTo <= to)) {
              editingPos = null;
            }
          } else {
            editingPos = null;
          }
        }

        const activeBlockPos = activeTextblockPos(newState.selection);

        if (
          meta !== undefined ||
          tr.docChanged ||
          editingPos !== old.editingPos ||
          activeBlockPos !== old.activeBlockPos
        ) {
          return rebuild(newState.doc, katex, editingPos, activeBlockPos);
        }
        return {
          katex,
          editingPos,
          activeBlockPos,
          decorations: old.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    view: (view) => {
      let destroyed = false;
      editorView = view as EditorView;
      const ensureKatex = (): void => {
        const pluginState = mathPluginKey.getState(view.state);
        if (pluginState === undefined || pluginState.katex !== null || loadRequested) return;
        if (!docHasMath(view.state.doc)) return;
        loadRequested = true;
        loadKatex()
          .then((katex) => {
            if (destroyed) return;
            view.dispatch(
              view.state.tr.setMeta(mathPluginKey, { katex } satisfies MathPluginMeta),
            );
          })
          .catch((error: unknown) => {
            // The loader memoizes failures; keep the request latched so every
            // subsequent edit does not reattach to the same rejected promise.
            // eslint-disable-next-line no-console
            console.error('[lightink/math] KaTeX assets failed to load', error);
          });
      };
      ensureKatex();
      return {
        update: () => {
          editorView = view as EditorView;
          ensureKatex();
        },
        destroy: () => {
          destroyed = true;
          editorView = null;
        },
      };
    },
    props: {
      decorations(state) {
        return mathPluginKey.getState(state)?.decorations;
      },
    },
  });
});
