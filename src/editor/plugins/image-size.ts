/**
 * `image-size` — R12 图片缩放与对齐。
 *
 * 技术决策（02-technical-solution.md §9）：裸加 width/align attrs 会被 Milkdown 默认
 * toMarkdown（恒出 `![alt](src)`）丢弃，故：
 *   - 经 `imageSchema.extendSchema` 给 image 节点加 `width`/`align` attrs，并改写
 *     `toMarkdown`：无设置时仍出标准 image（`![alt](src)`）；有设置时出 HTML `<img …>`
 *     行内块（CommonMark 合法、对其它渲染器可读）。
 *   - 经 `htmlSchema.extendSchema` 改写 `parseMarkdown`：白名单 `<img>` HTML 还原为带
 *     width/align 的 image 节点，其余 html 仍透传为 html 节点——往返闭环。
 *   - nodeView 以 image 节点为宿主：点击 NodeSelection 后显示拖拽调宽柄 + 浮动对齐条；
 *     写回经 `setNodeMarkup`（不碰 index/HEAD，事务由编辑器走）。
 *
 * 纯逻辑 `serializeImageHtml` / `parseImageHtml` / `buildImageStyle` headless 可测；
 * schema 装配与 nodeView 属编辑器集成面（仅断言工厂形态 + tsc）。
 */

import { imageSchema, htmlSchema } from '@milkdown/preset-commonmark';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import type { EditorView, NodeView } from '@milkdown/prose/view';

import {
  isSafeInlineImageUrl,
  normalizeRemoteImageUrl,
  sessionRemoteImagePolicy,
  type RemoteImagePolicy,
} from '../../media/remote-image-policy.js';
import { isModifiedClick } from '../link-navigation.js';
import { isRelativeAssetSrc } from './image.js';

export type ImageAlign = 'left' | 'center' | 'right';

/** 缩放/对齐属性（width 为 px 整数或 null；align 为左中右或 null）。 */
export interface ImageSizeAttrs {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
  readonly width: number | null;
  readonly align: ImageAlign | null;
}

const MIN_WIDTH = 40;
const MAX_WIDTH = 4000;

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return MIN_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(n)));
}

/** 对齐 → CSS（display/margin）。left 为默认不产出对齐样式。 */
export function alignStyle(align: ImageAlign | null): string {
  switch (align) {
    case 'center':
      return 'display:block;margin-left:auto;margin-right:auto';
    case 'right':
      return 'display:block;margin-left:auto';
    case 'left':
      return 'display:block';
    default:
      return '';
  }
}

/** 从 style 串反解对齐（margin-left/right auto 组合）。 */
function parseAlignFromStyle(style: string): ImageAlign | null {
  if (style === '') return null;
  const ml = /margin-left\s*:\s*auto/i.test(style);
  const mr = /margin-right\s*:\s*auto/i.test(style);
  if (ml && mr) return 'center';
  if (ml && !mr) return 'right';
  if (/display\s*:\s*block/i.test(style) && !ml && !mr) return 'left';
  return null;
}

/** 渲染态 style：width(px)+对齐（nodeView toDOM 与导出 DOM 共用）。 */
export function buildImageStyle(width: number | null, align: ImageAlign | null): string {
  const parts: string[] = [];
  if (typeof width === 'number' && width > 0) parts.push(`width:${clampWidth(width)}px`);
  const a = alignStyle(align);
  if (a !== '') parts.push(a);
  return parts.join(';');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 解析出的属性值解码常见实体（往返闭环）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * 序列化带尺寸/对齐的 image 为可读 HTML（toMarkdown 用）。
 * width 走标准 width 属性；align 走 style。title 非空才输出。
 */
export function serializeImageHtml(attrs: ImageSizeAttrs): string {
  const parts: string[] = [`src="${escAttr(attrs.src)}"`, `alt="${escAttr(attrs.alt)}"`];
  if (attrs.title !== '') parts.push(`title="${escAttr(attrs.title)}"`);
  if (typeof attrs.width === 'number' && attrs.width > 0) {
    parts.push(`width="${clampWidth(attrs.width)}"`);
  }
  const a = alignStyle(attrs.align);
  if (a !== '') parts.push(`style="${escAttr(a)}"`);
  return `<img ${parts.join(' ')}>`;
}

/** 从 `<img …>` 标签串解析属性（白名单）；非 img 或无 src 返回 null。 */
export function parseImageHtml(html: string): ImageSizeAttrs | null {
  if (typeof html !== 'string' || html === '') return null;
  const m = html.match(/<img\b([^>]*)>/i);
  if (m === null) return null;
  const attrStr = m[1] ?? '';
  const get = (name: string): string | null => {
    const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const am = attrStr.match(re);
    if (am === null) return null;
    return am[1] ?? am[2] ?? am[3] ?? '';
  };
  const src = get('src');
  if (src === null || src === '') return null;
  const widthRaw = get('width');
  let width: number | null = null;
  if (widthRaw !== null) {
    const n = parseInt(widthRaw, 10);
    if (Number.isFinite(n) && n > 0) width = clampWidth(n);
  }
  const styleRaw = get('style') ?? '';
  // 兼容：style 内也可能带 width。
  if (width === null) {
    const wm = styleRaw.match(/width\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
    if (wm !== null) width = clampWidth(parseInt(wm[1], 10));
  }
  return {
    src: decodeEntities(src),
    alt: decodeEntities(get('alt') ?? ''),
    title: decodeEntities(get('title') ?? ''),
    width,
    align: parseAlignFromStyle(styleRaw),
  };
}

// ---------------------------------------------------------------------------
// Schema 扩展
// ---------------------------------------------------------------------------

/** image 节点扩展：加 width/align attrs；toDOM 带样式；toMarkdown 有设置时出 HTML img。 */
export const imageWithSize = imageSchema.extendSchema((original) => (ctx) => {
  const base = original(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      width: { default: null },
      align: { default: null },
    },
    toDOM: (node) => {
      const baseDom = base.toDOM?.(node) as [string, Record<string, unknown>] | undefined;
      const domAttrs: Record<string, unknown> = baseDom !== undefined ? { ...baseDom[1] } : {};
      // width/align 不作为裸 DOM 属性（align 已废弃），统一走 style + 类名。
      delete domAttrs.width;
      delete domAttrs.align;
      const width = typeof node.attrs.width === 'number' ? node.attrs.width : null;
      const align = (node.attrs.align as ImageAlign | null) ?? null;
      const style = buildImageStyle(width, align);
      const existing = typeof domAttrs.style === 'string' ? domAttrs.style : '';
      const merged = [existing, style].filter((s) => s !== '').join(';');
      if (merged !== '') domAttrs.style = merged;
      if (width !== null) domAttrs.class = 'lightink-image lightink-image-sized';
      return ['img', domAttrs];
    },
    toMarkdown: {
      match: (node) => node.type.name === 'image',
      runner: (state, node) => {
        const width = node.attrs.width;
        const align = node.attrs.align;
        if ((typeof width === 'number' && width > 0) || align !== null) {
          state.addNode(
            'html',
            undefined,
            serializeImageHtml({
              src: node.attrs.src,
              alt: node.attrs.alt,
              title: node.attrs.title,
              width,
              align,
            }),
          );
          return;
        }
        base.toMarkdown.runner(state, node);
      },
    },
  };
});

/** html 节点扩展：parseMarkdown 识别白名单 `<img>` 还原 image+attrs，其余透传 html。 */
export const htmlWithImageParse = htmlSchema.extendSchema((original) => (ctx) => {
  const base = original(ctx);
  return {
    ...base,
    parseMarkdown: {
      match: ({ type }) => type === 'html',
      runner: (state, node, type) => {
        const value = typeof node.value === 'string' ? node.value : '';
        const parsed = parseImageHtml(value);
        if (parsed !== null) {
          const imageType = state.schema.nodes.image;
          if (imageType !== undefined) {
            state.addNode(imageType, {
              src: parsed.src,
              alt: parsed.alt,
              title: parsed.title,
              width: parsed.width,
              align: parsed.align,
            });
            return;
          }
        }
        // 非白名单 img 或无 image 节点：回落为普通 html 节点透传，不丢内容。
        state.addNode(type, { value });
      },
    },
  };
});

// ---------------------------------------------------------------------------
// nodeView：缩放柄 + 浮动对齐条
// ---------------------------------------------------------------------------

/** 解析相对资源 src 为可显示 URL（与 imageDisplayPlugin 同契约）。 */
export type ImageSrcResolver = (relPath: string) => Promise<string>;

interface NodeViewArgs {
  readonly view: EditorView;
  readonly getPos: () => number | undefined;
}

export interface ImageNodeViewOptions {
  readonly remoteImagePolicy?: RemoteImagePolicy;
  readonly remoteImageLoadLabel?: string;
  /**
   * Ctrl/Cmd+click 打开：复用链接的 confirm + onLinkNavigate（localFile /
   * open_path_default）。缺省时修饰键点击不打开。
   */
  readonly onLinkNavigate?: (href: string) => void;
  readonly confirmOpen?: (href: string) => boolean | Promise<boolean>;
  /** 已保存文档路径；未保存或缺失时相对图不能打开原文件。 */
  readonly getDocPath?: () => string | null;
}

/** 普通点击选中缩放；修饰键且可打开时走确认 + 系统默认程序。 */
export type ImageClickIntent = 'select' | 'open';

/**
 * 与 Rust `sanitize_rel_path` 对齐：拒绝 `..`、盘符、UNC、空路径。
 * 前端打开通道在调用 onLinkNavigate 前用同一规则，避免 `../` 经 classifyLink 逃逸。
 */
export function isDocumentDirSandboxedSrc(src: string): boolean {
  if (src === '' || src.startsWith('/') || src.startsWith('\\')) {
    return false;
  }
  const parts: string[] = [];
  for (const seg of src.split(/[/\\]/)) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..' || seg.includes(':')) {
      return false;
    }
    parts.push(seg);
  }
  return parts.length > 0;
}

/**
 * 相对图打开 href：远程/绝对不自动打开；未保存无文档路径不能打开；
 * `../` / 盘符 / UNC 与 ADR-3 同一沙箱拒绝。返回值交给 confirm + onLinkNavigate。
 */
export function resolveImageOpenHref(src: string, docPath: string | null): string | null {
  if (docPath === null || docPath === '') {
    return null;
  }
  if (!isRelativeAssetSrc(src) || !isDocumentDirSandboxedSrc(src)) {
    return null;
  }
  return src;
}

export function imageClickIntent(
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  src: string,
  docPath: string | null,
): ImageClickIntent {
  if (!isModifiedClick(event as MouseEvent)) {
    return 'select';
  }
  return resolveImageOpenHref(src, docPath) === null ? 'select' : 'open';
}

function srcOfImageNode(node: PMNode): string | null {
  if (node.type.name !== 'image') {
    return null;
  }
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : '';
  return src === '' ? null : src;
}

/** 点击位置处的 image src（inline atom 可能落在 node 本身或相邻）。 */
export function imageSrcAtClickPos(doc: PMNode, pos: number): string | null {
  const at = doc.nodeAt(pos);
  if (at !== null) {
    const src = srcOfImageNode(at);
    if (src !== null) {
      return src;
    }
  }
  try {
    const $pos = doc.resolve(pos);
    const after = $pos.nodeAfter;
    if (after !== null) {
      const src = srcOfImageNode(after);
      if (src !== null) {
        return src;
      }
    }
    const before = $pos.nodeBefore;
    if (before !== null) {
      return srcOfImageNode(before);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * image nodeView：相对引用经 resolver 异步解析为 data URL；选中（NodeSelection）后
 * 显示右下拖拽柄（调宽）与浮动对齐条（左/中/右），写回经 setNodeMarkup。
 */
function createResizableImageNodeView(
  node: PMNode,
  resolver: ImageSrcResolver,
  args: NodeViewArgs,
  options: ImageNodeViewOptions,
): NodeView {
  const remoteImagePolicy = options.remoteImagePolicy ?? sessionRemoteImagePolicy;
  const wrap = document.createElement('span');
  wrap.className = 'lightink-image-wrap';
  wrap.setAttribute('data-type', 'image');
  wrap.style.display = 'inline-block';
  wrap.style.position = 'relative';
  wrap.style.lineHeight = '0';

  const img = document.createElement('img');
  img.className = 'lightink-image';
  img.style.display = 'block';
  img.style.maxWidth = '100%';
  wrap.appendChild(img);

  const remoteLoad = document.createElement('button');
  remoteLoad.type = 'button';
  remoteLoad.className = 'lightink-remote-image-load';
  remoteLoad.textContent = options.remoteImageLoadLabel ?? 'Load remote image';
  remoteLoad.hidden = true;
  wrap.appendChild(remoteLoad);

  // 浮动对齐条（选中时显示）。
  const bar = document.createElement('span');
  bar.className = 'lightink-image-alignbar';
  bar.style.position = 'absolute';
  bar.style.top = '4px';
  bar.style.left = '50%';
  bar.style.transform = 'translateX(-50%)';
  bar.style.display = 'none';
  bar.style.zIndex = '5';
  bar.style.lineHeight = '1';
  const aligns: ImageAlign[] = ['left', 'center', 'right'];
  for (const a of aligns) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.align = a;
    btn.textContent = a === 'left' ? '⬅' : a === 'center' ? '⬌' : '➡';
    btn.title = a;
    btn.style.margin = '0 2px';
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commit({ align: a });
    });
    bar.appendChild(btn);
  }
  wrap.appendChild(bar);

  // 右下拖拽柄（选中时显示）。
  const handle = document.createElement('span');
  handle.className = 'lightink-image-handle';
  handle.textContent = '◢';
  handle.style.position = 'absolute';
  handle.style.right = '0';
  handle.style.bottom = '0';
  handle.style.cursor = 'nwse-resize';
  handle.style.display = 'none';
  handle.style.zIndex = '5';
  handle.style.userSelect = 'none';
  handle.style.fontSize = '14px';
  handle.style.lineHeight = '1';
  wrap.appendChild(handle);

  let seq = 0;
  let current = node;
  let currentRemoteUrl: string | null = null;

  const applyAttrs = (n: PMNode): void => {
    const width = typeof n.attrs.width === 'number' ? n.attrs.width : null;
    const align = (n.attrs.align as ImageAlign | null) ?? null;
    // 尺寸/对齐相关 inline 样式逐项写入。
    img.style.width = width !== null ? `${clampWidth(width)}px` : '';
    // 显式宽度时不钳制 max-width（编辑器内显式宽图不被压到 100%，且导出 css 的
    // 免钳制规则成为真正 backstop）；无显式宽度保持响应式 100%。
    img.style.maxWidth = width !== null ? 'none' : '100%';
    img.style.marginLeft = align === 'center' || align === 'right' ? 'auto' : '';
    img.style.marginRight = align === 'center' ? 'auto' : '';
    img.style.display = align === null ? 'inline' : 'block';
    img.classList.toggle('lightink-image-sized', width !== null);
    wrap.dataset.align = align ?? '';
  };

  const syncSrc = (n: PMNode): void => {
    seq += 1;
    const mySeq = seq;
    const src = typeof n.attrs.src === 'string' ? n.attrs.src : '';
    const alt = typeof n.attrs.alt === 'string' ? n.attrs.alt : '';
    const title = typeof n.attrs.title === 'string' ? n.attrs.title : '';
    const remoteUrl = normalizeRemoteImageUrl(src);
    currentRemoteUrl = remoteUrl;
    img.alt = alt;
    if (title !== '') img.title = title;
    else img.removeAttribute('title');
    if (src === '') {
      img.removeAttribute('src');
      img.hidden = false;
      remoteLoad.hidden = true;
      return;
    }
    if (remoteUrl !== null) {
      img.removeAttribute('src');
      if (remoteImagePolicy.isAllowed(remoteUrl)) {
        img.referrerPolicy = 'no-referrer';
        img.loading = 'lazy';
        img.hidden = false;
        remoteLoad.hidden = true;
        img.src = remoteUrl;
      } else {
        img.hidden = true;
        remoteLoad.hidden = false;
      }
      return;
    }
    if (!isRelativeAssetSrc(src)) {
      remoteLoad.hidden = true;
      img.hidden = false;
      if (isSafeInlineImageUrl(src)) img.src = src;
      else img.removeAttribute('src');
      return;
    }
    remoteLoad.hidden = true;
    img.hidden = false;
    resolver(src)
      .then((url) => {
        if (mySeq === seq) img.src = url;
      })
      .catch(() => {
        if (mySeq === seq) img.src = src;
      });
  };

  const unsubscribeRemoteImages = remoteImagePolicy.subscribe((allowedUrl) => {
    if (currentRemoteUrl === allowedUrl) syncSrc(current);
  });
  const keepEditorSelection = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const loadRemoteImage = (event: MouseEvent): void => {
    event.stopPropagation();
    if (currentRemoteUrl !== null) remoteImagePolicy.allowOnce(currentRemoteUrl);
  };
  remoteLoad.addEventListener('mousedown', keepEditorSelection);
  remoteLoad.addEventListener('click', loadRemoteImage);

  const commit = (changes: { width?: number; align?: ImageAlign | null }): void => {
    const pos = args.getPos();
    if (pos === undefined) return;
    const newAttrs = { ...current.attrs };
    if (changes.width !== undefined) newAttrs.width = clampWidth(changes.width);
    if (changes.align !== undefined) newAttrs.align = changes.align ?? null;
    args.view.dispatch(
      args.view.state.tr.setNodeMarkup(pos, undefined, newAttrs).setMeta('uiEvent', 'resize'),
    );
  };

  // 拖拽调宽。
  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    startX = event.clientX;
    startWidth = img.width || parseInt(img.style.width, 10) || MIN_WIDTH;
    const onMove = (e: MouseEvent): void => {
      if (!dragging) return;
      const next = clampWidth(startWidth + (e.clientX - startX));
      img.style.width = `${next}px`;
    };
    const onUp = (e: MouseEvent): void => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const next = clampWidth(startWidth + (e.clientX - startX));
      commit({ width: next });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // 让 ProseMirror 在点击 image 时自行建立 NodeSelection——此处不得 stopPropagation，
  // 否则 mousedown 不冒泡到 PM 根处理器，selectNode 永不触发，缩放柄/对齐条不可达。
  syncSrc(node);
  applyAttrs(node);

  return {
    dom: wrap,
    contentDOM: undefined,
    update: (incoming: PMNode) => {
      if (incoming.type !== node.type) return false;
      current = incoming;
      syncSrc(incoming);
      applyAttrs(incoming);
      return true;
    },
    selectNode: () => {
      wrap.classList.add('lightink-image-selected');
      bar.style.display = 'inline';
      handle.style.display = 'inline';
    },
    deselectNode: () => {
      wrap.classList.remove('lightink-image-selected');
      bar.style.display = 'none';
      handle.style.display = 'none';
    },
    stopEvent: (event: Event) => {
      // 拖拽与对齐按钮的事件由 nodeView 自处理，不交给编辑器。
      return (
        event.target === handle ||
        event.target === remoteLoad ||
        bar.contains(event.target as Node)
      );
    },
    ignoreMutation: () => true,
    destroy: () => {
      seq += 1;
      unsubscribeRemoteImages();
      remoteLoad.removeEventListener('mousedown', keepEditorSelection);
      remoteLoad.removeEventListener('click', loadRemoteImage);
    },
  };
}

/** nodeView 注册插件：与 imageDisplayPlugin 同样需要 resolver；选中后提供缩放/对齐 UI。 */
export function imageSizeNodeViewPlugin(
  resolver: ImageSrcResolver,
  options: ImageNodeViewOptions = {},
) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('lightink-image-size'),
        props: {
          nodeViews: {
            image: (node: PMNode, view: EditorView, getPos: () => number | undefined) =>
              createResizableImageNodeView(node, resolver, { view, getPos }, options),
          },
          handleClick(view, pos, event) {
            const src = imageSrcAtClickPos(view.state.doc, pos);
            if (src === null) {
              return false;
            }
            const docPath = options.getDocPath?.() ?? null;
            if (imageClickIntent(event, src, docPath) !== 'open') {
              return false;
            }
            const href = resolveImageOpenHref(src, docPath);
            if (href === null || options.onLinkNavigate === undefined) {
              return false;
            }
            event.preventDefault();
            const navigate = options.onLinkNavigate;
            const gate = options.confirmOpen;
            if (gate === undefined) {
              navigate(href);
              return true;
            }
            void Promise.resolve(gate(href)).then((ok) => {
              if (ok) {
                navigate(href);
              }
            });
            return true;
          },
        },
      }),
  );
}
