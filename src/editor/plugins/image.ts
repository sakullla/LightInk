/**
 * Image handling plugin entry point.
 *
 * T4 wires the real flow: a ProseMirror plugin (via `$prose`) intercepts
 * paste/drop events carrying image data, persists the bytes through an
 * injected `AssetSaver` (Rust asset service is the sole owner of asset
 * persistence), and inserts a Milkdown `image` node whose `src` is the
 * returned relative path `assets/<name>.<ext>`. 落盘失败时报错且不插入
 * 引用（R3）。
 *
 * `describePastedImage` / `imageMarkdownSnippet`（T2 引入的契约描述）保留
 * 供测试与纯逻辑复用；真实粘贴/拖拽流程走 saver 路径。
 */

import { $prose, nanoid } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

import type { AssetSaver } from '../../asset/asset-service.js';
import { clipboardHasImage, extractClipboardImage } from '../../asset/clipboard.js';
import type { ExtractedImage } from '../../asset/clipboard.js';
import { dropHasImage, extractDroppedImages } from '../../asset/dragdrop.js';

/** 相对引用 → 可显示 URL（生产为 asset-service 的 createImageSrcResolver）。 */
export type ImageSrcResolver = (relPath: string) => Promise<string>;

/**
 * mountEditor 的图片资源扩展选项（定义在此而非 types.ts，因为 types.ts
 * 不在 T4 修改范围内；字段全部可选，存量调用不受影响）。
 */
export interface ImageAssetMountOptions {
  /** 图片字节落盘回调；缺省时粘贴/拖拽图片走编辑器默认行为。 */
  readonly assetSaver?: AssetSaver;
  /** 落盘失败上报（生产接到 TabManager 的 reportError）。 */
  readonly onAssetError?: (message: string, error: unknown) => void;
  /** 相对引用 `assets/…` / `*-assets/…` → 可显示 URL 的解析器；缺省时 <img> 按原样渲染。 */
  readonly imageSrcResolver?: ImageSrcResolver;
  /** Localized command shown while a remote image is blocked. */
  readonly remoteImageLoadLabel?: string;
  /** 当前文档路径；未保存为 null。Ctrl/Cmd+点击打开相对图时需要已保存路径。 */
  readonly getDocPath?: () => string | null;
}

/** 事件处理器依赖（与 mount 选项同形，便于内部传递）。 */
export interface ImageAssetDeps {
  readonly saver: AssetSaver;
  readonly onError?: (message: string, error: unknown) => void;
}

interface ImageInsertionRange {
  readonly from: number;
  readonly to: number;
}

interface ImageInsertionHandle extends ImageInsertionRange {
  readonly id: string | null;
}

interface ImageInsertionLifecycle {
  isAlive(): boolean;
}

type ImageInsertionAction =
  | { readonly type: 'add'; readonly id: string; readonly range: ImageInsertionRange }
  | { readonly type: 'remove'; readonly id: string };

type ImageInsertionState = ReadonlyMap<string, ImageInsertionRange>;

export const IMAGE_ASSET_PLUGIN_KEY = new PluginKey<ImageInsertionState>(
  'lightink-image-assets',
);

function reportImageError(
  deps: ImageAssetDeps,
  message: string,
  error: unknown,
): void {
  try {
    deps.onError?.(message, error);
  } catch {
    // Error reporting must not create an unhandled rejection in an event handler.
  }
}

function beginImageInsertion(
  view: EditorView,
  range: ImageInsertionRange,
): ImageInsertionHandle {
  if (IMAGE_ASSET_PLUGIN_KEY.getState(view.state) === undefined) {
    return { id: null, ...range };
  }
  const id = nanoid();
  view.dispatch(
    view.state.tr.setMeta(IMAGE_ASSET_PLUGIN_KEY, {
      type: 'add',
      id,
      range,
    } satisfies ImageInsertionAction),
  );
  return { id, ...range };
}

function resolveImageInsertion(
  view: EditorView,
  handle: ImageInsertionHandle,
): ImageInsertionRange | null {
  if (handle.id === null) {
    return handle;
  }
  return IMAGE_ASSET_PLUGIN_KEY.getState(view.state)?.get(handle.id) ?? null;
}

function cancelImageInsertion(
  view: EditorView,
  handle: ImageInsertionHandle,
  lifecycle?: ImageInsertionLifecycle,
): void {
  if (lifecycle !== undefined && !lifecycle.isAlive()) {
    return;
  }
  if (handle.id === null || IMAGE_ASSET_PLUGIN_KEY.getState(view.state) === undefined) {
    return;
  }
  try {
    view.dispatch(
      view.state.tr.setMeta(IMAGE_ASSET_PLUGIN_KEY, {
        type: 'remove',
        id: handle.id,
      } satisfies ImageInsertionAction),
    );
  } catch {
    // The editor may have been destroyed between the lifecycle check and dispatch.
  }
}

function insertTrackedImage(
  view: EditorView,
  handle: ImageInsertionHandle,
  url: string,
  alt: string,
  lifecycle?: ImageInsertionLifecycle,
): boolean {
  if (lifecycle !== undefined && !lifecycle.isAlive()) {
    return false;
  }
  const range = resolveImageInsertion(view, handle);
  if (range === null) {
    return false;
  }
  const imageType = view.state.schema.nodes['image'];
  if (imageType === undefined) {
    cancelImageInsertion(view, handle);
    return false;
  }
  const node = imageType.create({ src: url, alt });
  const tr =
    range.from === range.to
      ? view.state.tr.insert(range.from, node)
      : view.state.tr.replaceRangeWith(range.from, range.to, node);
  if (handle.id !== null) {
    tr.setMeta(IMAGE_ASSET_PLUGIN_KEY, {
      type: 'remove',
      id: handle.id,
    } satisfies ImageInsertionAction);
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

export interface ImageAsset {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
  readonly title?: string;
}

export interface ImageInsertOptions {
  readonly assetsDir?: string;
  readonly alt?: string;
  readonly title?: string;
}

/**
 * Build an image descriptor for an in-memory paste/drop payload.
 *
 * The implementation deliberately avoids touching the filesystem: T4 owns
 * that concern. We expose a stable `assets/<id>` relative path so the
 * resulting doc round-trips through standard markdown tooling.
 */
export function describePastedImage(
  opts: ImageInsertOptions = {},
): ImageAsset {
  const id = nanoid();
  const assetsDir = opts.assetsDir ?? 'assets';
  const normalized = assetsDir.endsWith('/')
    ? assetsDir.slice(0, -1)
    : assetsDir;
  const url = `${normalized}/${id}.png`;
  return {
    id,
    url,
    alt: opts.alt ?? '',
    title: opts.title,
  };
}

/**
 * Markdown fragment for an image asset. Currently unwired — T4 will route
 * pasted image content through this once paste/asset persistence lands.
 * Re-renders with the canonical URL so the editor's stored source matches
 * the `ImageAsset.url`.
 */
export function imageMarkdownSnippet(asset: ImageAsset): string {
  const titlePart =
    typeof asset.title === 'string' && asset.title.length > 0
      ? ` "${asset.title.replace(/"/g, '\\"')}"`
      : '';
  return `![${asset.alt}](${asset.url}${titlePart})`;
}

// ---------------------------------------------------------------------------
// T4：粘贴/拖拽 → 落盘 → 插入 image 节点
// ---------------------------------------------------------------------------

/**
 * 在指定位置插入 image 节点（`pos` 为 null 时替换当前选区，用于粘贴；
 * 拖拽时传 `posAtCoords` 得到的落点）。schema 无 image 节点时返回 false。
 */
export function insertImageAt(
  view: EditorView,
  pos: number | null,
  url: string,
  alt: string,
): boolean {
  const imageType = view.state.schema.nodes['image'];
  if (imageType === undefined) {
    return false;
  }
  const node = imageType.create({ src: url, alt });
  const tr = view.state.tr;
  view.dispatch(
    (pos === null ? tr.replaceSelectionWith(node) : tr.insert(pos, node)).scrollIntoView(),
  );
  return true;
}

/**
 * 粘贴图片的异步主流程：提取 → 落盘 → 插入。落盘失败调用 onError 且
 * 不插入任何引用（outcome 3）。返回是否最终插入了图片。
 */
export async function processImagePaste(
  view: EditorView,
  event: ClipboardEvent,
  deps: ImageAssetDeps,
  lifecycle?: ImageInsertionLifecycle,
): Promise<boolean> {
  // R16：检测到图片却读取失败（WebView 形状异常/空字节）时明确反馈，不静默无反应。
  const detected = clipboardHasImage(event);
  const selection = view.state.selection;
  const insertion = beginImageInsertion(view, {
    from: selection.from,
    to: selection.to,
  });
  let image: ExtractedImage | null;
  try {
    image = await extractClipboardImage(event);
  } catch (error) {
    cancelImageInsertion(view, insertion, lifecycle);
    reportImageError(deps, '剪贴板图片读取失败，未插入', error);
    return false;
  }
  if (image === null) {
    cancelImageInsertion(view, insertion, lifecycle);
    if (detected) {
      reportImageError(deps, '剪贴板图片读取失败，未插入', undefined);
    }
    return false;
  }
  let url: string;
  try {
    url = await deps.saver(image.bytes, image.ext);
  } catch (error) {
    cancelImageInsertion(view, insertion, lifecycle);
    reportImageError(deps, '图片保存失败，未插入引用', error);
    return false;
  }
  try {
    return insertTrackedImage(view, insertion, url, image.alt, lifecycle);
  } catch (error) {
    cancelImageInsertion(view, insertion, lifecycle);
    reportImageError(deps, '图片插入失败', error);
    return false;
  }
}

/** 拖拽图片的异步主流程：逐张落盘并按落点顺序插入；单张失败不阻断其余。 */
export async function processImageDrop(
  view: EditorView,
  event: DragEvent,
  deps: ImageAssetDeps,
  lifecycle?: ImageInsertionLifecycle,
): Promise<number> {
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  const initialPos = coords?.pos ?? view.state.selection.from;
  const anchor = beginImageInsertion(view, { from: initialPos, to: initialPos });
  let images: ExtractedImage[];
  try {
    images = await extractDroppedImages(event);
  } catch (error) {
    cancelImageInsertion(view, anchor, lifecycle);
    reportImageError(deps, '拖拽图片读取失败，未插入', error);
    return 0;
  }
  if (images.length === 0) {
    cancelImageInsertion(view, anchor, lifecycle);
    return 0;
  }
  if (lifecycle !== undefined && !lifecycle.isAlive()) {
    return 0;
  }
  const mappedAnchor = resolveImageInsertion(view, anchor);
  cancelImageInsertion(view, anchor, lifecycle);
  if (mappedAnchor === null) {
    return 0;
  }
  const insertions = images.map(() => beginImageInsertion(view, mappedAnchor));
  let inserted = 0;
  for (const [index, image] of images.entries()) {
    if (lifecycle !== undefined && !lifecycle.isAlive()) {
      break;
    }
    const insertion = insertions[index];
    if (insertion === undefined) continue;
    let url: string;
    try {
      url = await deps.saver(image.bytes, image.ext);
    } catch (error) {
      cancelImageInsertion(view, insertion, lifecycle);
      reportImageError(deps, '图片保存失败，未插入引用', error);
      continue;
    }
    try {
      if (insertTrackedImage(view, insertion, url, image.alt, lifecycle)) {
        inserted += 1;
      }
    } catch (error) {
      cancelImageInsertion(view, insertion, lifecycle);
      reportImageError(deps, '图片插入失败', error);
    }
  }
  return inserted;
}

/**
 * 生成拦截粘贴/拖拽图片的 ProseMirror 插件（经 `$prose` 包装成 Milkdown
 * 插件）。同步探测到图片即拦截（preventDefault + 返回 true），异步完成
 * 落盘与插入；无图片时返回 false 让默认行为（如文本粘贴）继续。
 */
export function createImageAssetProsePlugin(deps: ImageAssetDeps): Plugin<ImageInsertionState> {
  let destroyed = false;
  const lifecycle: ImageInsertionLifecycle = { isAlive: () => !destroyed };
  return new Plugin<ImageInsertionState>({
        key: IMAGE_ASSET_PLUGIN_KEY,
        state: {
          init: () => new Map(),
          apply: (tr, previous) => {
            const next = new Map<string, ImageInsertionRange>();
            for (const [id, range] of previous) {
              const collapsed = range.from === range.to;
              next.set(id, {
                from: tr.mapping.map(range.from, collapsed ? 1 : -1),
                to: tr.mapping.map(range.to, 1),
              });
            }
            const action = tr.getMeta(IMAGE_ASSET_PLUGIN_KEY) as
              | ImageInsertionAction
              | undefined;
            if (action?.type === 'add') {
              next.set(action.id, action.range);
            } else if (action?.type === 'remove') {
              next.delete(action.id);
            }
            return next;
          },
        },
        props: {
          handlePaste: (view, event) => {
            if (!clipboardHasImage(event)) {
              return false;
            }
            event.preventDefault();
            void processImagePaste(view, event, deps, lifecycle).catch((error: unknown) => {
              reportImageError(deps, '图片插入失败', error);
            });
            return true;
          },
          handleDrop: (view, event) => {
            if (!dropHasImage(event)) {
              return false;
            }
            event.preventDefault();
            void processImageDrop(view, event, deps, lifecycle).catch((error: unknown) => {
              reportImageError(deps, '图片插入失败', error);
            });
            return true;
          },
        },
        view: () => ({
          destroy: () => {
            destroyed = true;
          },
        }),
      });
}

export function imageAssetPlugin(deps: ImageAssetDeps) {
  return $prose(() => createImageAssetProsePlugin(deps));
}

// ---------------------------------------------------------------------------
// 图片显示：相对引用 → data URL（nodeView）
// ---------------------------------------------------------------------------

/**
 * src 是否需要解析的相对资源引用：无 scheme、非 //、非 / 或盘符绝对路径、
 * 非 data:/blob: —— 文档内 `assets/…`、同级 `*-assets/…` 等相对引用
 * （webview 对其无静态服务，原样渲染会裂图）。`../` 在前端仍为相对引用，
 * 由后端文档目录沙箱拒绝读取。
 */
export function isRelativeAssetSrc(src: string): boolean {
  if (src === '') return false;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src)) return false; // http(s):// 或协议相对
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false; // data: / blob: / file: 等
  if (src.startsWith('/')) return false;
  if (/^[a-z]:[\\/]/i.test(src)) return false; // Windows 盘符绝对路径
  return true;
}
