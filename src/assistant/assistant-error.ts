/**
 * `assistant-error` — surface 无关的 AI 配置态与错误码映射。
 *
 * 面板只经本模块取 provider 配置（`ai_get_config` 投影、无密钥材料）与
 * `AI_*` 错误文案，并可监听配置变更事件；阅读器 lookup / 翻译与书库
 * 消费方经 `lookup-panel` 兼容导出继续使用同一份实现（一个事实一个 owner）。
 */

import { invoke } from '@tauri-apps/api/core';
import type { MessageKey } from '../i18n/messages.js';

/** 与 Manage 页 AI 分组广播的事件同源（`ai-config-ui`）；值保持兼容不改。 */
export const ASSISTANT_AI_CONFIGURED_EVENT = 'lightink:reader-ai-configured';

/** `ai_get_config` 的 surface 侧投影：显隐判定 + 目标语言覆盖项（无密钥材料）。 */
export interface AiTranslateConfig {
  readonly configured: boolean;
  readonly targetLang?: string;
  readonly missing: readonly string[];
}

/** 防御解析 `ai_get_config` 返回；形态不对时视为未配置（永不抛出）。 */
export function parseAiTranslateConfig(raw: unknown): AiTranslateConfig {
  if (raw === null || typeof raw !== 'object') {
    return { configured: false, missing: [] };
  }
  const obj = raw as { configured?: unknown; missing?: unknown; targetLang?: unknown };
  const missingRaw = obj.missing;
  const missing = Array.isArray(missingRaw)
    ? missingRaw.filter((gap): gap is string => typeof gap === 'string')
    : [];
  const targetLang =
    typeof obj.targetLang === 'string' && obj.targetLang.trim() !== ''
      ? obj.targetLang.trim()
      : undefined;
  return {
    configured: obj.configured === true || (Array.isArray(missingRaw) && missing.length === 0),
    targetLang,
    missing,
  };
}

export async function invokeAiTranslateConfig(): Promise<AiTranslateConfig> {
  return parseAiTranslateConfig(await invoke<unknown>('ai_get_config'));
}

const AI_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  AI_NETWORK_ERROR: 'reader.ai.error.network',
  AI_CLIENT_ERROR: 'reader.ai.error.network',
  AI_TIMEOUT: 'reader.ai.error.timeout',
  AI_RESPONSE_TOO_LARGE: 'reader.ai.error.tooLarge',
  AI_REQUEST_TOO_LARGE: 'reader.ai.error.tooLarge',
  AI_KEY_INVALID: 'reader.ai.error.keyInvalid',
  AI_MODEL_NOT_FOUND: 'reader.ai.error.modelNotFound',
  AI_QUOTA_EXCEEDED: 'reader.ai.error.quota',
  AI_NOT_CONFIGURED: 'reader.ai.error.unconfigured',
  AI_HTTP_NOT_ALLOWED: 'reader.ai.error.httpNotAllowed',
  AI_URL_INVALID: 'reader.ai.error.urlInvalid',
  AI_CONFIG_INVALID: 'reader.ai.error.configInvalid',
  AI_STORAGE_ERROR: 'reader.ai.error.storage',
  AI_TARGET_LANG_INVALID: 'reader.ai.error.configInvalid',
  AI_KEY_STORE_FAILED: 'reader.ai.error.keyStore',
  AI_TEXT_INVALID: 'reader.ai.error.textInvalid',
  AI_TEXT_EMPTY: 'reader.ai.error.textEmpty',
  AI_REQUEST_INVALID: 'reader.ai.error.requestInvalid',
  AI_RESPONSE_INVALID: 'reader.ai.error.responseInvalid',
};

/** AI 命令错误码族 → 本地化文案；未知码回退通用失败。missing 填充未配置缺口。 */
export function assistantAiErrorMessage(
  t: (key: MessageKey) => string,
  error: unknown,
  missing: readonly string[] = [],
): string {
  // aidErrorCode 是 Wiktionary 语义的子串匹配;AI 错误取原始 `AI_*` 码精确对表。
  const code = aiErrorRaw(error).match(/\bAI_[A-Z_]+\b/)?.[0] ?? '';
  const key = AI_ERROR_KEYS[code];
  if (key === undefined) {
    return t('reader.ai.error.failed');
  }
  if (key === 'reader.ai.error.unconfigured') {
    return missing.length > 0
      ? t(key).split('{missing}').join(missing.join(', '))
      : t('reader.ai.unconfigured');
  }
  return t(key);
}

/** 原始错误文本（字符串 / {code,error,message} / JSON 串），供错误码判定。 */
export function aiErrorRaw(error: unknown): string {
  if (typeof error === 'string') {
    return unwrapAiErrorText(error);
  }
  if (error === null || typeof error !== 'object') {
    return '';
  }
  const obj = error as { code?: unknown; error?: unknown; message?: unknown };
  const parts = [obj.code, obj.error, obj.message]
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => unwrapAiErrorText(value as string));
  return parts.join(' ');
}

function unwrapAiErrorText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown; message?: unknown };
      const code = typeof parsed.code === 'string' ? parsed.code : '';
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      return `${code} ${message}`.trim();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
