/**
 * `asset-service` — 图片资源持久化的 typed 薄封装 + saver 工厂（T4）。
 *
 * 图片资源的唯一 owner 是 Rust 资源服务（src-tauri/src/asset.rs）；这里只
 * 负责把图片与事务式另存为命令的参数/返回值
 * 整理成 TypeScript 类型，并提供纯函数工具（base64 编码、MIME→扩展名）。
 *
 * 引用约定：无论图片落在文档旁 `assets/` 还是未保存文档的会话暂存目录，
 * Rust 侧都返回相对路径 `assets/<name>.<ext>`；保存（另存为）时迁移按
 * 原名搬动文件，文档内的相对引用不需要改写。
 */

import { invoke } from '@tauri-apps/api/core';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function assertImageByteLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (${length} bytes; limit ${MAX_IMAGE_BYTES} bytes)`);
  }
}

/**
 * 图片保存回调：接收图片字节与扩展名，resolve 为文档内引用的相对路径
 * （`assets/<name>.<ext>`）；落盘失败时 reject —— 调用方必须不插入引用。
 */
export type AssetSaver = (bytes: ArrayBuffer, ext: string) => Promise<string>;

/** MIME 类型 → 文件扩展名。不支持的类型返回 null。 */
export function extFromMime(mime: string): string | null {
  const lower = mime.trim().toLowerCase();
  switch (lower) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return null;
  }
}

/** 扩展名 → MIME 类型（data URL 显示用）；未知返回 application/octet-stream。 */
export function mimeFromExt(ext: string): string {
  switch (ext.trim().toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/** 文件名 → 图片扩展名（拖拽本地文件时 MIME 可能缺失，作兜底）。 */
export function extFromFileName(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return null;
  }
  const ext = name.slice(dot + 1).toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext) ? ext : null;
}

/** 去掉扩展名的文件名主干（拖入本地图片时作为 alt 默认值）。 */
export function fileNameStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** ArrayBuffer → base64 字符串（分块避免大图的参数栈溢出）。 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertImageByteLength(view.byteLength);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 保存图片并返回相对引用路径。`docPath` 为 null（文档未保存）时由
 * Rust 侧落入该会话的暂存目录，保存时迁移。
 */
export async function saveAsset(
  docPath: string | null,
  sessionId: string,
  bytesBase64: string,
  ext: string,
): Promise<string> {
  return invoke<string>('save_asset', {
    docPath,
    sessionId,
    bytesBase64,
    ext,
  });
}

/**
 * 事务式另存为：Rust 先无覆盖地提交该会话的暂存资源，再原子写入 Markdown。
 * 任一步失败时 reject，调用方必须保留原标签路径、dirty 状态和暂存资源。
 */
export async function saveDocumentAs(
  sessionId: string,
  docPath: string,
  content: string,
): Promise<void> {
  await invoke<string[]>('save_document_as', { sessionId, docPath, content });
}

/**
 * 「插入图片」从本地文件导入：Rust 侧读取源文件并按与粘贴/拖拽相同的规则
 * 落盘（文档旁 assets/ 或会话暂存目录），resolve 为相对引用
 * `assets/<name>.<ext>`；读取失败/格式不支持时 reject —— 调用方必须不插入引用。
 */
export async function importImageAsset(
  docPath: string | null,
  sessionId: string,
  sourcePath: string,
): Promise<string> {
  return invoke<string>('import_image_asset', { docPath, sessionId, sourcePath });
}

/**
 * 读取文档引用的相对路径图片（base64）：文档已保存按 `<文档目录>/assets/…`
 * 解析，未保存按会话暂存目录解析（与导出共用同一 Rust 命令）。
 */
export async function readImageBase64(
  docPath: string | null,
  sessionId: string,
  relPath: string,
): Promise<string> {
  return invoke<string>('read_image_base64', { docPath, sessionId, relPath });
}

// ---------------------------------------------------------------------------
// 编辑器图片显示：相对引用 → data URL 解析器
// ---------------------------------------------------------------------------

/** `createImageSrcResolver` 的可注入依赖。 */
export interface ImageSrcResolverDeps {
  readonly readImageBase64: (
    docPath: string | null,
    sessionId: string,
    relPath: string,
  ) => Promise<string>;
  /** 读取该标签当前的文档路径（未保存为 null → 走暂存解析）。 */
  readonly getDocPath: () => string | null;
  readonly sessionId: string;
}

/**
 * 为某个标签构建图片显示解析器：把文档内的相对引用 `assets/<name>.<ext>`
 * 解析为可在 webview 直接显示的 data URL（相对路径在 webview 里没有静态
 * 服务，直接塞进 <img src> 会裂图）。按 (文档路径, 相对引用) 缓存——另存为
 * 后文档路径变化自动用新键重新解析；同一文件重复渲染不重复走 IPC。
 */
export function createImageSrcResolver(
  deps: ImageSrcResolverDeps,
): (relPath: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (relPath) => {
    const key = `${deps.getDocPath() ?? ''}|${relPath}`;
    let pending = cache.get(key);
    if (pending === undefined) {
      const ext = relPath.split('.').pop() ?? '';
      pending = deps
        .readImageBase64(deps.getDocPath(), deps.sessionId, relPath)
        .then((base64) => `data:${mimeFromExt(ext)};base64,${base64}`)
        .catch((error: unknown) => {
          cache.delete(key);
          throw error;
        });
      cache.set(key, pending);
    }
    return pending;
  };
}

/** `createAssetSaver` 的可注入依赖（测试可整体替换 invoke 层）。 */
export interface AssetSaverDeps {
  readonly saveAsset: (
    docPath: string | null,
    sessionId: string,
    bytesBase64: string,
    ext: string,
  ) => Promise<string>;
  /** 读取该标签当前的文档路径（未保存为 null → 走暂存）。 */
  readonly getDocPath: () => string | null;
  /** 会话 id（未命名标签的 syntheticId），用于暂存目录隔离与迁移。 */
  readonly sessionId: string;
}

/**
 * 为某个标签构建 `AssetSaver`：每次调用时现读文档路径（另存为后新
 * 图片直接落新文档旁的 assets/，旧暂存图由保存流程迁移）。
 */
export function createAssetSaver(deps: AssetSaverDeps): AssetSaver {
  return async (bytes, ext) => {
    const base64 = bytesToBase64(bytes);
    return deps.saveAsset(deps.getDocPath(), deps.sessionId, base64, ext);
  };
}
