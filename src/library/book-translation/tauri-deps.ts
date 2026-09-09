/**
 * `tauri-deps` — 控制器的生产依赖装配（纯 invoke 薄封装，无业务决策）。
 *
 * 全部状态/网络调用走 Rust：断点缓存 `book_translation_*` 命令、单块翻译
 * `book_translation_translate_chunk`（ai.rs 同一网络栈，密钥仅 Rust 持有）、
 * 译本入库 `book_translation_import_epub`（base64 字节）。对话框与提示由
 * 应用壳注入（AppBookTranslationHooks），本模块不直接依赖 DOM。
 */

import { invoke } from '@tauri-apps/api/core';

import { bytesToBase64 } from '../../asset/asset-service.js';
import { readerBytesFromIpc } from '../../reader/file-bytes.js';
import {
  invokeAiTranslateConfig,
  parseAiTranslateResult,
} from '../../reader/lookup-panel.js';
import type { LibraryItem } from '../library-client.js';
import type { BookTranslationDeps } from './controller.js';

/** 应用壳注入的对话框/提示/导航钩子（main.ts 持有）。 */
export interface AppBookTranslationHooks {
  readonly getLocale: BookTranslationDeps['getLocale'];
  readonly t: BookTranslationDeps['t'];
  readonly confirmStart: BookTranslationDeps['confirmStart'];
  readonly notify: BookTranslationDeps['notify'];
  readonly openManageAi: BookTranslationDeps['openManageAi'];
  readonly onImported?: BookTranslationDeps['onImported'];
}

function unwrapVoid(): void {
  return undefined;
}

export function createTauriBookTranslationDeps(
  hooks: AppBookTranslationHooks,
): BookTranslationDeps {
  return {
    getLocale: hooks.getLocale,
    t: hooks.t,
    aiConfigured: async () => {
      const raw = await invoke<unknown>('ai_configured');
      if (raw !== null && typeof raw === 'object') {
        const parsed = raw as { configured?: unknown; missing?: unknown };
        const missing = Array.isArray(parsed.missing)
          ? parsed.missing.filter((gap): gap is string => typeof gap === 'string')
          : [];
        return { configured: parsed.configured === true || missing.length === 0, missing };
      }
      return { configured: false, missing: [] };
    },
    aiTargetLangOverride: async () => {
      const config = await invokeAiTranslateConfig().catch(() => null);
      return config?.targetLang;
    },
    translateChunk: async (text, targetLang, glossary) => {
      const raw = await invoke<unknown>('book_translation_translate_chunk', {
        text,
        targetLang,
        glossary: glossary.map((entry) => ({ source: entry.source, target: entry.target })),
      });
      return parseAiTranslateResult(raw);
    },
    readState: (contentHash) =>
      invoke<string>('book_translation_read_state', { contentHash }).catch(() => ''),
    writeState: (contentHash, json) =>
      invoke<void>('book_translation_write_state', { contentHash, json }).then(
        unwrapVoid,
        unwrapVoid,
      ),
    readChunk: (contentHash, chunkIndex) =>
      invoke<string>('book_translation_read_chunk', { contentHash, chunkIndex }).catch(() => ''),
    writeChunk: (contentHash, chunkIndex, text) =>
      invoke<void>('book_translation_write_chunk', { contentHash, chunkIndex, text }),
    clearTranslation: (contentHash) =>
      invoke<void>('book_translation_clear', { contentHash }).then(unwrapVoid, unwrapVoid),
    getContentHash: (path) => invoke<string>('content_hash', { path }),
    readBytes: async (path) => {
      const raw = await invoke<ArrayBuffer | Uint8Array>('read_file_bytes', { path });
      return readerBytesFromIpc(path, raw);
    },
    importEpub: async (bytes) => {
      const item = await invoke<LibraryItem>('book_translation_import_epub', {
        epubBase64: bytesToBase64(bytes),
      });
      return item;
    },
    upsertItem: (item) => invoke<void>('library_upsert_item', { item }),
    confirmStart: hooks.confirmStart,
    notify: hooks.notify,
    openManageAi: hooks.openManageAi,
    onImported: hooks.onImported,
  };
}
