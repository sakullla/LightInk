/**
 * `file-service` — Tauri 文件/快照命令的 typed 薄封装（T3）。
 *
 * 文件持久化与崩溃快照的唯一 owner 是 Rust 侧；这里只负责把
 * `invoke('read_file' | 'write_file' | ...)` 的参数/返回值整理成
 * TypeScript 类型，不做任何 Markdown 解析或业务决策。
 *
 * `browser-file:` 虚拟路径（`npm run dev` 无 Tauri）改走内存 File 存储，
 * 与阅读器字节通道同一套登记，避免 Markdown 打开去调不存在的 IPC。
 */

import { invoke } from '@tauri-apps/api/core';
import {
  getBrowserFile,
  isBrowserFilePath,
  readBrowserFileText,
  writeBrowserFileText,
} from './browser-file-store.js';

/** 读取 UTF-8 文本文件内容。失败时 reject 可读的中文错误信息。 */
export async function readFile(path: string): Promise<string> {
  if (isBrowserFilePath(path)) {
    return readBrowserFileText(path);
  }
  return invoke<string>('read_file', { path });
}

/**
 * 原子写文件（临时文件 + rename）。失败时 reject 且目标路径不会留下
 * 半截文件 —— 调用方应保持文档脏标记。
 */
export async function writeFile(path: string, content: string): Promise<void> {
  if (isBrowserFilePath(path)) {
    writeBrowserFileText(path, content);
    return;
  }
  return invoke<void>('write_file', { path, content });
}

/**
 * 文件 stat（R13 外部变更检测）：修改时间、字节数与稳定内容指纹。
 * 字段名与 Rust `FileStat` 的 serde 序列化一致（snake_case 原样透传）。
 * stat 失败（文件被删/权限）reject 可读错误信息。
 */
export interface FileStat {
  readonly mtime_ms: number;
  readonly size: number;
  readonly fingerprint: string;
}

export async function statFile(path: string): Promise<FileStat> {
  if (isBrowserFilePath(path)) {
    const file = getBrowserFile(path);
    if (file === undefined) {
      throw new Error(`无法读取文件信息 ${path}: 文件不存在`);
    }
    return {
      mtime_ms: file.lastModified,
      size: file.size,
      fingerprint: `${file.size}:${file.lastModified}`,
    };
  }
  return invoke<FileStat>('stat_file', { path });
}

/** 写入崩溃恢复快照（应用数据目录，按文件路径哈希命名）。 */
export async function writeSnapshot(filePath: string, content: string): Promise<void> {
  if (isBrowserFilePath(filePath)) {
    return;
  }
  return invoke<void>('write_snapshot', { filePath, content });
}

/** 删除对应快照；快照不存在不算错误。 */
export async function clearSnapshot(filePath: string): Promise<void> {
  if (isBrowserFilePath(filePath)) {
    return;
  }
  return invoke<void>('clear_snapshot', { filePath });
}

/**
 * 「崩溃新于保存」检测：快照存在且比磁盘文件新时返回快照内容，
 * 否则返回 null。
 */
export async function readStaleSnapshot(filePath: string): Promise<string | null> {
  if (isBrowserFilePath(filePath)) {
    return null;
  }
  return invoke<string | null>('read_stale_snapshot', { filePath });
}

/** 启动时枚举崩溃遗留的未命名草稿（key + content）。 */
export interface UntitledDraft {
  key: string;
  content: string;
}

export async function listUntitledDrafts(): Promise<UntitledDraft[]> {
  return invoke<UntitledDraft[]>('list_untitled_drafts');
}
