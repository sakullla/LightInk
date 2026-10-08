/**
 * `roundtrip` — 打开/保存/另存为的内容往返编排（T3）。
 *
 * 这里把 file-service（字节读写）与 file-dialog（系统对话框）组合成
 * TabManager 可直接消费的高阶流程。所有函数都是纯逻辑编排，UI 反馈
 * （对话框、错误提示）通过注入的依赖完成，便于在 vitest 中替换。
 */

import * as fileService from './file-service.js';
import * as fileDialog from './file-dialog.js';
import { saveDocumentAs } from '../asset/asset-service.js';

/** 供测试注入的依赖面。生产环境直接使用真实模块。 */
export interface RoundtripDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  saveDocumentAs: (sessionId: string, path: string, content: string) => Promise<void>;
  showOpenDialog: () => Promise<string | null>;
  showSaveDialog: (defaultPath?: string) => Promise<string | null>;
  /** 错误上报（缺省 console 兜底；生产由 main.ts 注入非阻断 toast）。 */
  reportError: (message: string, error: unknown) => void;
  /** 打开失败的主文案（缺省中文兜底；生产注入 i18n 文案，原始错误走 reportError 第二参）。 */
  formatOpenErrorMessage?: (path: string) => string;
  /** 保存失败的主文案（同上）。 */
  formatSaveErrorMessage?: (path: string) => string;
  /** 另存失败的主文案（同上）。 */
  formatSaveAsErrorMessage?: (path: string) => string;
}

export const defaultRoundtripDeps: RoundtripDeps = {
  readFile: fileService.readFile,
  writeFile: fileService.writeFile,
  saveDocumentAs,
  showOpenDialog: fileDialog.showOpenDialog,
  showSaveDialog: fileDialog.showSaveDialog,
  reportError: (message, error) => {
    // eslint-disable-next-line no-console
    console.error(`[lightink/file] ${message}`, error);
  },
};

/** 打开流程结果。 */
export interface OpenResult {
  path: string;
  content: string;
}

/**
 * 打开：弹对话框选文件 → 读取内容。用户取消返回 null；
 * 读取失败上报并返回 null。
 */
export async function openFileFlow(deps: RoundtripDeps): Promise<OpenResult | null> {
  const path = await deps.showOpenDialog();
  if (path === null) {
    return null;
  }
  return openPathFlow(deps, path);
}

/** 读取指定路径（打开流程的下半段，也供直接按路径打开时复用）。 */
export async function openPathFlow(
  deps: RoundtripDeps,
  path: string,
): Promise<OpenResult | null> {
  try {
    const content = await deps.readFile(path);
    return { path, content };
  } catch (error) {
    deps.reportError(deps.formatOpenErrorMessage?.(path) ?? `打开文件失败: ${path}`, error);
    return null;
  }
}

/**
 * 保存到已知路径：只负责原子写入。崩溃快照属于标签生命周期，调用方必须
 * 在确认当前编辑内容确已落盘后再清理，避免异步保存期间的新编辑失去恢复副本。
 * 成功返回 true；失败上报并返回 false（调用方保持脏标记）。
 */
export async function saveToPathFlow(
  deps: RoundtripDeps,
  path: string,
  content: string,
): Promise<boolean> {
  try {
    await deps.writeFile(path, content);
  } catch (error) {
    deps.reportError(deps.formatSaveErrorMessage?.(path) ?? `保存文件失败: ${path}`, error);
    return false;
  }
  return true;
}

/**
 * 另存为：弹保存对话框 → 事务式写入资源和新路径。返回新路径；取消或失败返回 null。
 */
export async function saveAsFlow(
  deps: RoundtripDeps,
  sessionId: string,
  content: string,
  defaultPath?: string,
): Promise<string | null> {
  const path = await deps.showSaveDialog(defaultPath);
  if (path === null) {
    return null;
  }
  try {
    await deps.saveDocumentAs(sessionId, path, content);
    return path;
  } catch (error) {
    deps.reportError(deps.formatSaveAsErrorMessage?.(path) ?? `另存文件失败: ${path}`, error);
    return null;
  }
}
