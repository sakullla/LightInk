/**
 * `source-view` — 整窗 WYSIWYG ↔ Markdown 源码模式切换（R10）。
 *
 * 设计（02-technical-solution.md R10）：单窗格切换。源码态把编辑区替换为带语法高亮的
 * 纯文本视图，内容以 `getMarkdown()`/`setMarkdown()` 字符串往返；因数学为 decoration-only
 * 模型，往返的是原始 Markdown 源（含原始 LaTeX），故行内/块级数学、表格两模式往返无丢失。
 * 任意时刻单窗格、无并排（R18 约束）。
 *
 * 分层：
 *   - `SourceModeController`（纯逻辑、headless 可测）：管理模式态 + 以
 *     `getMarkdown/setMarkdown` 字符串往返；`enterSource` 取快照、`exitSource` 写回。
 *   - `SourceView`（DOM 层、挂载态）：在标签宿主上挂「透明 textarea + 背后高亮
 *     pre/code」叠加层——textarea 负责可编辑输入（透明文字、可见光标），pre/code 经
 *     highlight.js（Markdown grammar 首次进入时按需加载）
 *     提供语法高亮；二者按相同字体度量对齐。表面按内容撑高宿主，滚动交给
 *     #lightink-editor-area（与正常模式同一条编辑区进度条）。
 */

import { ensureHighlightLanguage, highlightCode } from './plugins/code-highlight.js';
import { convertHtmlToMarkdown } from './html-to-markdown.js';
import {
  LIGHTINK_MARKDOWN_MIME,
  readClipboardMime,
  resolveClipboardPaste,
} from './paste.js';

/** 编辑模式。 */
export type EditorMode = 'wysiwyg' | 'source';

/** 纯逻辑：切换模式。 */
export function toggleMode(mode: EditorMode): EditorMode {
  return mode === 'wysiwyg' ? 'source' : 'wysiwyg';
}

/** 编辑器的 Markdown 往返能力（EditorInstance 子集，便于测试注入）。 */
export interface SourceRoundtrip {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
}

/**
 * 纯逻辑：源码模式控制器。enterSource 取当前 Markdown 快照并切到 source；
 * exitSource 把（可能已编辑的）源码文本写回编辑器并切回 wysiwyg。
 * 因往返的是原始 Markdown 字符串，数学/表格的原始源（LaTeX/GFM）被完整保留。
 */
export class SourceModeController {
  private mode: EditorMode = 'wysiwyg';
  private snapshot = '';

  constructor(private readonly roundtrip: SourceRoundtrip) {}

  get currentMode(): EditorMode {
    return this.mode;
  }

  isSourceMode(): boolean {
    return this.mode === 'source';
  }

  /** 进入源码模式：返回待显示的源码文本（= 编辑器当前 Markdown）。 */
  enterSource(): string {
    this.snapshot = this.roundtrip.getMarkdown();
    this.mode = 'source';
    return this.snapshot;
  }

  /** 退出源码模式：把源码文本写回编辑器（应用编辑）。 */
  exitSource(text: string): void {
    this.roundtrip.setMarkdown(text);
    this.mode = 'wysiwyg';
  }

  /** 不退出模式下把当前源码文本同步回编辑器（供源码态保存/大纲读取）。 */
  syncSource(text: string): void {
    if (this.mode !== 'source') return;
    this.roundtrip.setMarkdown(text);
    this.snapshot = text;
  }
}

/** textarea 与 pre 共享的字体度量（必须一致以保证高亮层与输入层逐行对齐）。 */
export function applySourceMetrics(el: HTMLElement): void {
  el.style.boxSizing = 'border-box';
  el.style.margin = '0';
  el.style.border = 'none';
  el.style.padding = '8px';
  // 与 theme.css 编辑器代码字体同一字体栈：高亮层 <code> 受
  // `.lightink-tab-host code` 规则影响，若两层字体不同，字形宽度逐字漂移，
  // 选区洗色与可见文字错位（用户感知为「源码模式选中有问题」）。
  el.style.fontFamily = 'var(--lightink-font-mono, "Cascadia Code", "JetBrains Mono", Consolas, monospace)';
  // Follow reading zoom: tier code size × user font scale (same as code blocks).
  el.style.fontSize = 'calc(var(--lightink-font-size-code, 13.5px) * var(--lightink-font-scale, 1))';
  el.style.lineHeight = 'var(--lightink-line-height-code, 1.55)';
  el.style.whiteSpace = 'pre-wrap';
  el.style.wordBreak = 'break-word';
  el.style.overflowWrap = 'break-word';
  el.style.fontVariantLigatures = 'none';
  el.style.tabSize = '2';
  // 字距/字偶距必须两层一致（2026-08-09 实测错位根因）：
  //   - textarea 的 UA 默认 letter-spacing: normal，而高亮层继承
  //     `.lightink-tab-host` 的 0.01em（按宿主字号折算的绝对值随继承链下传）；
  //   - 根节点的 text-rendering: optimizeLegibility 会继承到高亮层并启用
  //     kerning，textarea 则是 auto——每个字偶对推进宽度不同，逐字累积漂移。
  el.style.letterSpacing = 'normal';
  el.style.textRendering = 'auto';
  // 关掉字偶距/连字相关 OpenType 特性，避免高亮层与 textarea 几何再分叉。
  el.style.fontKerning = 'none';
  el.style.fontFeatureSettings = '"liga" 0, "calt" 0';
}

/**
 * 中和 `.lightink-tab-host code { font-size: 0.92em }` 等通用行内代码规则。
 * 高亮 code 必须完整继承 pre 的度量，否则长行与透明 textarea 的折行点不同，
 * 原生选区背景便会覆盖到另一段可见源码上。
 */
export function applySourceHighlightMetrics(el: HTMLElement): void {
  el.style.fontFamily = 'inherit';
  el.style.fontSize = 'inherit';
  el.style.lineHeight = 'inherit';
  el.style.whiteSpace = 'inherit';
  el.style.wordBreak = 'inherit';
  el.style.overflowWrap = 'inherit';
  el.style.fontVariantLigatures = 'inherit';
  el.style.tabSize = 'inherit';
  el.style.letterSpacing = 'inherit';
  el.style.textRendering = 'inherit';
  el.style.fontKerning = 'inherit';
  el.style.fontFeatureSettings = 'inherit';
  el.style.fontWeight = 'inherit';
  el.style.fontStyle = 'inherit';
}

/** 把 Markdown 源高亮为 HTML（末尾加换行使最后一行行高与 textarea 对齐）。 */
function renderHighlightedSource(source: string): string {
  return `${highlightCode('markdown', source)}\n`;
}

/**
 * DOM 层：在宿主上挂「透明 textarea + 背后高亮 pre/code」叠加层实现可编辑的带高亮
 * 源码视图。表面按内容撑高宿主，滚动交给 #lightink-editor-area（与 WYSIWYG 同一条
 * 编辑区进度条）；隐藏底层 ProseMirror 以免 min-height 叠高。退出时把 textarea 文本
 * 写回编辑器并移除叠加层。属挂载态行为（同既有插件，仅断言工厂形态）；纯逻辑往返由
 * SourceModeController 覆盖。
 */
export class SourceView {
  private readonly controller: SourceModeController;
  private wrapper: HTMLDivElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  /** 高亮层 <code> 元素（enter 时创建，随 overlay 移除）。 */
  private codeEl: HTMLElement | null = null;
  /** 进入源码前被隐藏的 WYSIWYG 根（避免其 min-height 撑高宿主）。 */
  private proseMirror: HTMLElement | null = null;
  private savedPmDisplay = '';
  /** 源码态视口尺寸跟随（enter 注册，exit 移除）。 */
  private onWindowResize: (() => void) | null = null;
  /** 最近一次同步到编辑器的文本（用于跳过无变化的冗余 setMarkdown/解析）。 */
  private lastSynced = '';

  constructor(private readonly host: HTMLElement, roundtrip: SourceRoundtrip) {
    this.controller = new SourceModeController(roundtrip);
  }

  get isSourceMode(): boolean {
    return this.controller.isSourceMode();
  }

  private currentText(): string {
    return this.textarea?.value ?? '';
  }

  /**
   * 源码表面最小高度：填满 #lightink-editor-area 可视区（扣除宿主上下 padding），
   * 与 WYSIWYG 短文仍占满一屏的手感一致。
   */
  private computeMinHeight(): number {
    const area = this.host.parentElement;
    if (area === null) return 0;
    const styles = this.host.ownerDocument.defaultView?.getComputedStyle(this.host);
    const padY =
      (Number.parseFloat(styles?.paddingTop ?? '0') || 0) +
      (Number.parseFloat(styles?.paddingBottom ?? '0') || 0);
    return Math.max(0, area.clientHeight - padY);
  }

  /**
   * 按内容撑高 textarea（进而撑高宿主），让 #lightink-editor-area 成为唯一滚动容器——
   * 滚动条落在编辑区右缘，与正常模式同一条「进度条」，而不是内容栏内侧那条。
   */
  private syncSurfaceHeight(): void {
    const ta = this.textarea;
    if (ta === null) return;
    const minH = this.computeMinHeight();
    // 先塌到 0 再读 scrollHeight，避免沿用旧 height 时量不到真实内容高。
    ta.style.height = '0px';
    const next = Math.max(ta.scrollHeight, minH);
    ta.style.height = `${next}px`;
  }

  /** 编辑区滚动容器：优先 #lightink-editor-area，否则宿主父元素。 */
  private scrollContainer(): HTMLElement | null {
    const byId = this.host.ownerDocument.getElementById('lightink-editor-area');
    if (byId instanceof HTMLElement) return byId;
    return this.host.parentElement;
  }

  /**
   * 把光标/选区末端滚进 #lightink-editor-area 可视区。
   * textarea 高度=内容且 overflow:hidden 时浏览器不会自滚外层容器。
   */
  private ensureCaretVisible(): void {
    const ta = this.textarea;
    const scroller = this.scrollContainer();
    if (ta === null || scroller === null) return;

    const style = this.host.ownerDocument.defaultView?.getComputedStyle(ta);
    const lineHeight = Number.parseFloat(style?.lineHeight ?? '') || 20;
    const mirror = this.host.ownerDocument.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    const ms = mirror.style;
    ms.position = 'absolute';
    ms.visibility = 'hidden';
    ms.pointerEvents = 'none';
    ms.whiteSpace = 'pre-wrap';
    ms.wordBreak = style?.wordBreak || 'break-word';
    ms.overflowWrap = style?.overflowWrap || 'break-word';
    ms.font = style?.font ?? '';
    ms.fontFamily = style?.fontFamily ?? '';
    ms.fontSize = style?.fontSize ?? '';
    ms.fontWeight = style?.fontWeight ?? '';
    ms.fontStyle = style?.fontStyle ?? '';
    ms.letterSpacing = style?.letterSpacing ?? '';
    ms.lineHeight = style?.lineHeight ?? '';
    ms.tabSize = style?.tabSize ?? '';
    ms.boxSizing = style?.boxSizing ?? 'border-box';
    ms.padding = style?.padding ?? '0';
    ms.border = style?.border ?? 'none';
    ms.width = `${ta.clientWidth}px`;
    const offset = Math.max(0, Math.min(ta.selectionEnd, ta.value.length));
    mirror.textContent = ta.value.slice(0, offset);
    const marker = this.host.ownerDocument.createElement('span');
    marker.textContent = '​';
    mirror.appendChild(marker);
    this.host.ownerDocument.body.appendChild(mirror);
    const topInTextarea = marker.offsetTop;
    mirror.remove();

    const taRect = ta.getBoundingClientRect();
    const scRect = scroller.getBoundingClientRect();
    const caretTop = scroller.scrollTop + (taRect.top - scRect.top) + topInTextarea;
    const caretBottom = caretTop + lineHeight;
    const margin = Math.min(72, lineHeight * 2);
    if (caretTop < scroller.scrollTop + margin) {
      scroller.scrollTop = Math.max(0, caretTop - margin);
    } else if (caretBottom > scroller.scrollTop + scroller.clientHeight - margin) {
      scroller.scrollTop = Math.max(
        0,
        caretBottom - scroller.clientHeight + margin,
      );
    }
  }

  /** 进入源码模式。 */
  enter(): void {
    if (this.controller.isSourceMode() || this.wrapper !== null) return;
    const text = this.controller.enterSource();
    const doc = this.host.ownerDocument;

    const wrapper = doc.createElement('div');
    wrapper.className = 'lightink-source-overlay';
    // 文档流布局：高度由内部 textarea 内容决定，宿主随之增高，
    // 外层 #lightink-editor-area 承担滚动（与 WYSIWYG 同源）。
    wrapper.style.position = 'relative';
    wrapper.style.zIndex = '10';
    wrapper.style.background = 'var(--lightink-bg)';
    wrapper.style.width = '100%';

    const pre = doc.createElement('pre');
    // 专用类：theme.css 据此中和 `.lightink-tab-host pre` 的代码块样式
    //（背景/边框/圆角/滚动条样式会泄漏进源码叠加层）。
    pre.className = 'lightink-source-highlight';
    pre.style.position = 'absolute';
    pre.style.inset = '0';
    // 高亮层随 wrapper 同高，完整绘制源码；不自带滚动。
    pre.style.overflow = 'hidden';
    pre.style.pointerEvents = 'none';
    pre.style.margin = '0';
    pre.style.color = 'var(--lightink-fg)';
    pre.style.background = 'transparent';
    applySourceMetrics(pre);

    const code = doc.createElement('code');
    code.className = 'hljs language-markdown';
    applySourceHighlightMetrics(code);
    code.innerHTML = renderHighlightedSource(text);
    pre.appendChild(code);

    const textarea = doc.createElement('textarea');
    textarea.className = 'lightink-source-editor';
    // 相对定位占位：宽 100%、高度 = 内容高，overflow 隐藏自身滚动条。
    // 滚轮/键盘滚动交给祖先 #lightink-editor-area（与正常模式同一条进度条）。
    textarea.style.position = 'relative';
    textarea.style.display = 'block';
    textarea.style.width = '100%';
    textarea.style.overflow = 'hidden';
    textarea.style.background = 'transparent';
    textarea.style.color = 'transparent';
    textarea.style.caretColor = 'var(--lightink-fg)';
    textarea.style.outline = 'none';
    textarea.style.resize = 'none';
    applySourceMetrics(textarea);
    textarea.value = text;
    textarea.spellcheck = false;

    const onInput = (): void => {
      this.refreshFromTextarea();
      this.ensureCaretVisible();
    };
    // 方向键/点击改选区：textarea 自身不再滚动，需把光标保持在外层编辑区视口内。
    const onCaretMove = (): void => {
      this.ensureCaretVisible();
    };
    // overflow:hidden 的 textarea 在部分 WebView 下不会把滚轮冒泡给祖先；
    // 显式把 delta 转给 #lightink-editor-area，保持与正常模式同一滚动条。
    const onWheel = (event: WheelEvent): void => {
      // R5：Ctrl/Cmd+滚轮交给全局 wheel-zoom（字号缩放），不转发为页面滚动。
      if (event.ctrlKey || event.metaKey) return;
      const scroller = this.scrollContainer();
      if (scroller === null) return;
      // 仅处理纵向滚；横向/捏合缩放留给浏览器。
      if (event.deltaY === 0) return;
      scroller.scrollTop += event.deltaY;
      event.preventDefault();
    };
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('keyup', onCaretMove);
    textarea.addEventListener('click', onCaretMove);
    textarea.addEventListener('wheel', onWheel, { passive: false });
    // 源码模式粘贴：本应用复制优先插入 Markdown 源；外部 text/html 转 Markdown，
    // 不插入原始 HTML 标签；无可用载荷或转换失败则回落原生纯文本粘贴。
    const onPaste = (event: ClipboardEvent): void => {
      const cd = event.clipboardData;
      if (cd === null) return;
      const action = resolveClipboardPaste({
        html: readClipboardMime(cd, 'text/html'),
        text: readClipboardMime(cd, 'text/plain'),
        ownMarkdown: readClipboardMime(cd, LIGHTINK_MARKDOWN_MIME),
      });
      let md = '';
      if (action.kind === 'markdown-source') {
        // text/plain-only markdown can use native textarea paste; intercept when
        // HTML or LightInk MIME is present so we do not HTML-convert our own copy.
        if (
          readClipboardMime(cd, 'text/html') === '' &&
          readClipboardMime(cd, LIGHTINK_MARKDOWN_MIME) === ''
        ) {
          return;
        }
        md = action.text;
      } else if (action.kind === 'html') {
        md = convertHtmlToMarkdown(action.html);
      } else {
        return;
      }
      if (md === '') return; // 回落原生纯文本粘贴
      event.preventDefault();
      const ta2 = this.textarea;
      if (ta2 === null) return;
      // 用 execCommand('insertText') 走 textarea 原生 undo 栈，Ctrl+Z 可回退
      // （同 R2 源码替换取舍）；宿主不支持时回退 setRangeText，保证内容不丢。
      ta2.focus();
      let inserted = false;
      try {
        inserted = doc.execCommand('insertText', false, md);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        ta2.setRangeText(md, ta2.selectionStart, ta2.selectionEnd, 'end');
      }
      this.refreshFromTextarea();
      this.ensureCaretVisible();
    };
    textarea.addEventListener('paste', onPaste);

    wrapper.appendChild(pre);
    wrapper.appendChild(textarea);

    // 隐藏 WYSIWYG 根，避免 .ProseMirror { min-height: 60vh } 与源码表面叠高，
    // 也避免底层仍参与命中/选区。
    const pm = this.host.querySelector('.ProseMirror');
    if (pm instanceof HTMLElement) {
      this.proseMirror = pm;
      this.savedPmDisplay = pm.style.display;
      pm.style.display = 'none';
    } else {
      this.proseMirror = null;
      this.savedPmDisplay = '';
    }
    this.host.classList.add('is-source-mode');
    this.host.appendChild(wrapper);

    this.wrapper = wrapper;
    this.textarea = textarea;
    this.codeEl = code;
    this.lastSynced = text;

    void ensureHighlightLanguage('markdown').then((loaded) => {
      if (loaded && this.codeEl === code && this.textarea !== null) {
        code.innerHTML = renderHighlightedSource(this.textarea.value);
      }
    });

    const onResize = (): void => {
      this.syncSurfaceHeight();
    };
    window.addEventListener('resize', onResize);
    this.onWindowResize = onResize;

    this.syncSurfaceHeight();
    textarea.focus();
  }

  /** 高亮层重绘 + 高度跟随 + 变更同步（textarea 内容变化的统一入口）。 */
  private refreshFromTextarea(): void {
    if (this.codeEl !== null && this.textarea !== null) {
      this.codeEl.innerHTML = renderHighlightedSource(this.textarea.value);
    }
    this.syncSurfaceHeight();
    // 即时同步到所属编辑器；实例级 onContentChanged 随事务更新脏标记、
    // 崩溃快照和大纲，所有读取 editor 的站点都能看到最新源码。
    this.syncIfChanged();
  }

  /**
   * 在源码 textarea 光标处插入片段并同步回编辑器（源码态下「插入」菜单的
   * 统一路径；非源码态为空操作）。插入后光标落在片段末尾。
   */
  insertSnippetAtCursor(text: string): void {
    if (!this.controller.isSourceMode() || this.textarea === null) return;
    const ta = this.textarea;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    this.refreshFromTextarea();
    ta.focus();
    this.ensureCaretVisible();
  }

  /** 源码 textarea 是否有非空选区（源码态右键菜单的启用判定）。 */
  hasTextSelection(): boolean {
    if (!this.controller.isSourceMode() || this.textarea === null) return false;
    return this.textarea.selectionEnd > this.textarea.selectionStart;
  }

  /** 聚焦源码 textarea（右键菜单剪贴板动作执行前确保 execCommand 作用于它）。 */
  focusEditor(): void {
    this.textarea?.focus();
  }

  /** 源码态全选 textarea（R10 菜单「全选」）。非源码态为空操作。 */
  selectAll(): void {
    if (!this.controller.isSourceMode() || this.textarea === null) return;
    const ta = this.textarea;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  }

  /** 退出源码模式，把 textarea 文本写回编辑器。 */
  exit(): void {
    if (!this.controller.isSourceMode() || this.wrapper === null) return;
    this.controller.exitSource(this.currentText());
    if (this.onWindowResize !== null) {
      window.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = null;
    }
    this.wrapper.remove();
    this.wrapper = null;
    this.textarea = null;
    this.codeEl = null;
    if (this.proseMirror !== null) {
      this.proseMirror.style.display = this.savedPmDisplay;
      this.proseMirror = null;
      this.savedPmDisplay = '';
    }
    this.host.classList.remove('is-source-mode');
  }

  /** 切换模式。 */
  toggle(): void {
    if (this.controller.isSourceMode()) {
      this.exit();
    } else {
      this.enter();
    }
  }

  /** 源码态下把当前 textarea 文本同步回编辑器（不退出）。 */
  syncToEditor(): void {
    this.controller.syncSource(this.currentText());
    this.lastSynced = this.currentText();
  }

  /** 仅当 textarea 文本相对上次同步有变化时才 setMarkdown（跳过冗余解析）。 */
  private syncIfChanged(): void {
    const value = this.currentText();
    if (value !== this.lastSynced) {
      this.controller.syncSource(value);
      this.lastSynced = value;
    }
  }

  destroy(): void {
    this.exit();
  }

  /**
   * 释放监听器与叠加 DOM，不回写编辑器——供编辑器已销毁的标签关闭清理使用
   * （窗口 resize 监听器若残留会经闭包强引用已关闭文档的宿主/编辑器，构成泄漏）。
   */
  dispose(): void {
    if (this.onWindowResize !== null) {
      window.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = null;
    }
    if (this.wrapper !== null) {
      this.wrapper.remove();
      this.wrapper = null;
    }
    this.textarea = null;
    this.codeEl = null;
    if (this.proseMirror !== null) {
      this.proseMirror.style.display = this.savedPmDisplay;
      this.proseMirror = null;
      this.savedPmDisplay = '';
    }
    this.host.classList.remove('is-source-mode');
  }
}
