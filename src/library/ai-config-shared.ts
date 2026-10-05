/**
 * `ai-config-shared` — AI 提供商配置的单一权威（R3）。
 *
 * 收拢此前散在 `library-manage.ts` 的 `ai_*` Tauri 命令封装、端点格式默认
 * Base URL 表与 defaults 解析、`AI_*` 错误码 → 本地化文案映射，以及配置完成
 * 事件常量 `lightink:reader-ai-configured`（原先在 library-manage.ts 与
 * assistant-error.ts 重复定义，现两处改为消费/再导出本模块）。
 *
 * 管理页表单（library-manage）与配置向导（assistant/ai-config-wizard）共用
 * 同一份封装与错误映射；密钥材料仍只经 `ai_store_key` 进入系统钥匙串，本模块
 * 不持有任何密钥。
 */

import { invoke } from '@tauri-apps/api/core';

// ── 端点格式与默认地址 ────────────────────────────────────────────────

/** `src-tauri/src/ai.rs` 的端点格式三选一(wire 值 kebab-case,后端测试钉死)。 */
export type AiEndpointKindId = 'openai-responses' | 'openai-chat' | 'claude-messages';

export const AI_ENDPOINT_KINDS: readonly AiEndpointKindId[] = [
  'openai-responses',
  'openai-chat',
  'claude-messages',
];

/** 后端不可用(浏览器预览)或未返回 defaults 时的联动预填兜底。 */
export const AI_ENDPOINT_DEFAULT_BASE_URLS: Readonly<Record<AiEndpointKindId, string>> = {
  'openai-responses': 'https://api.openai.com/v1',
  'openai-chat': 'https://api.openai.com/v1',
  'claude-messages': 'https://api.anthropic.com/v1',
};

// ── 配置事件（单点常量；消费方一律 import 这里） ─────────────────────

export const READER_AI_CONFIGURED_EVENT = 'lightink:reader-ai-configured';

// ── 状态/输入视图与防御解析 ──────────────────────────────────────────

export interface AiEndpointDefaultView {
  readonly endpointKind: AiEndpointKindId;
  readonly baseUrl: string;
}

/** `ai_get_config` / `ai_save_config` / `ai_store_key` / `ai_forget_key` 的返回形态。 */
export interface AiConfigStatusView {
  readonly endpointKind: AiEndpointKindId;
  readonly baseUrl: string;
  readonly model: string;
  readonly allowHttp: boolean;
  readonly targetLang?: string;
  readonly hasKey: boolean;
  readonly configured: boolean;
  readonly missing: readonly string[];
  readonly defaults: readonly AiEndpointDefaultView[];
}

export interface AiConfigInputView {
  readonly endpointKind: AiEndpointKindId;
  readonly baseUrl: string;
  readonly model: string;
  readonly allowHttp: boolean;
  readonly targetLang?: string;
}

/** `lightink:reader-ai-configured` 事件负载(与 `ai_configured` 命令同型)。 */
export interface AiConfiguredDetail {
  readonly configured: boolean;
  readonly missing: readonly string[];
}

export function isAiEndpointKind(value: unknown): value is AiEndpointKindId {
  return AI_ENDPOINT_KINDS.includes(value as AiEndpointKindId);
}

function parseAiDefaults(raw: unknown): AiEndpointDefaultView[] {
  const parsed: AiEndpointDefaultView[] = [];
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { defaults?: unknown[] }).defaults)) {
    for (const item of (raw as { defaults: unknown[] }).defaults) {
      if (item === null || typeof item !== 'object') continue;
      const entry = item as { endpointKind?: unknown; baseUrl?: unknown };
      if (isAiEndpointKind(entry.endpointKind) && typeof entry.baseUrl === 'string') {
        parsed.push({ endpointKind: entry.endpointKind, baseUrl: entry.baseUrl });
      }
    }
  }
  if (parsed.length === 0) {
    return AI_ENDPOINT_KINDS.map((kind) => ({
      endpointKind: kind,
      baseUrl: AI_ENDPOINT_DEFAULT_BASE_URLS[kind],
    }));
  }
  return parsed;
}

/** 从未保存过时的默认形态(与后端 status_from(None) 一致,预填 openai-chat)。 */
export function fallbackAiConfigStatus(): AiConfigStatusView {
  return {
    endpointKind: 'openai-chat',
    baseUrl: AI_ENDPOINT_DEFAULT_BASE_URLS['openai-chat'],
    model: '',
    allowHttp: false,
    hasKey: false,
    configured: false,
    missing: ['endpoint_kind', 'base_url', 'model', 'api_key'],
    defaults: parseAiDefaults(null),
  };
}

/** 防御解析 `ai_*` 命令返回;形态不对时退回默认形态(永不抛出)。 */
export function parseAiConfigStatus(raw: unknown): AiConfigStatusView {
  const fallback = fallbackAiConfigStatus();
  if (raw === null || typeof raw !== 'object') {
    return fallback;
  }
  const obj = raw as {
    endpointKind?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    allowHttp?: unknown;
    targetLang?: unknown;
    hasKey?: unknown;
    configured?: unknown;
    missing?: unknown;
  };
  if (!isAiEndpointKind(obj.endpointKind)) {
    return fallback;
  }
  const missing = Array.isArray(obj.missing)
    ? obj.missing.filter((gap): gap is string => typeof gap === 'string')
    : [];
  const targetLang = typeof obj.targetLang === 'string' && obj.targetLang !== '' ? obj.targetLang : undefined;
  return {
    endpointKind: obj.endpointKind,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : '',
    model: typeof obj.model === 'string' ? obj.model : '',
    allowHttp: obj.allowHttp === true,
    targetLang,
    hasKey: obj.hasKey === true,
    configured: obj.configured === true || missing.length === 0,
    missing,
    defaults: parseAiDefaults(raw),
  };
}

export interface AiTestResultView {
  readonly latencyMs: number;
  readonly reply: string;
}

function parseAiTestResult(raw: unknown): AiTestResultView {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { latencyMs?: unknown; reply?: unknown };
    return {
      latencyMs: typeof obj.latencyMs === 'number' && Number.isFinite(obj.latencyMs) ? obj.latencyMs : 0,
      reply: typeof obj.reply === 'string' ? obj.reply : '',
    };
  }
  return { latencyMs: 0, reply: '' };
}

// ── Tauri 命令封装（管理页与向导共用；密钥只进钥匙串命令） ───────────

export async function invokeAiGetConfig(): Promise<AiConfigStatusView> {
  return parseAiConfigStatus(await invoke<unknown>('ai_get_config'));
}

export async function invokeAiSaveConfig(input: AiConfigInputView): Promise<AiConfigStatusView> {
  return parseAiConfigStatus(await invoke<unknown>('ai_save_config', { input }));
}

export async function invokeAiStoreKey(key: string): Promise<AiConfigStatusView> {
  return parseAiConfigStatus(await invoke<unknown>('ai_store_key', { key }));
}

export async function invokeAiForgetKey(): Promise<AiConfigStatusView> {
  return parseAiConfigStatus(await invoke<unknown>('ai_forget_key'));
}

export async function invokeAiTestConnection(): Promise<AiTestResultView> {
  return parseAiTestResult(await invoke<unknown>('ai_test_connection'));
}

/** 保存/清除密钥后广播配置完成事件;全部现有监听方(书架翻译入口、助手面板、
 * 阅读器 chrome、外壳菜单)凭同一事件名刷新,无需重载。 */
export function dispatchAiConfigured(
  detail: AiConfiguredDetail,
  target: Document | Window = document,
): void {
  target.dispatchEvent(new CustomEvent(READER_AI_CONFIGURED_EVENT, { detail }));
}

// ── 缺口与错误文案（字段名 + AI_* 码 → 本地化标签） ─────────────────

/**
 * 错误映射与缺口摘要所需的字段标签。管理页 `LibraryManageLabels` 与配置向导
 * `AiWizardLabels` 都扩展本接口——同一份 `AI_ERROR_LABEL_KEYS` / `aiErrorMessage`
 * 即可服务两个 surface。
 */
export interface AiConfigLabels {
  readonly aiEndpointKind: string;
  readonly aiBaseUrl: string;
  readonly aiModel: string;
  readonly aiKey: string;
  readonly aiUnconfigured: string;
  readonly aiUnconfiguredGaps: string;
  readonly aiErrorHttpNotAllowed: string;
  readonly aiErrorUrlInvalid: string;
  readonly aiErrorConfigInvalid: string;
  readonly aiErrorStorage: string;
  readonly aiErrorKeyInvalid: string;
  readonly aiErrorModelNotFound: string;
  readonly aiErrorQuota: string;
  readonly aiErrorUnconfigured: string;
  readonly aiErrorTimeout: string;
  readonly aiErrorNetwork: string;
  readonly aiErrorKeyStore: string;
  readonly aiErrorTooLarge: string;
  readonly aiErrorFailed: string;
}

/**
 * 后端有的用 snake_case（base_url），捕获/旧客户端有的用 camelCase（baseUrl）。
 * 先收成同一种，避免摘要里「Base URL」和「baseUrl」各出现一次。
 */
export function canonicalAiGap(gap: string): string {
  switch (gap) {
    case 'baseUrl':
    case 'base_url':
      return 'base_url';
    case 'apiKey':
    case 'api_key':
    case 'key':
      return 'api_key';
    case 'endpointKind':
    case 'endpoint_kind':
      return 'endpoint_kind';
    case 'model':
      return 'model';
    default:
      return gap;
  }
}

/** 四要素缺口 token → 本地化字段名(后端 config_gaps 的字段名回报)。 */
export function aiMissingSummary(l: AiConfigLabels, missing: readonly string[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const gap of missing) {
    const name = canonicalAiGap(gap);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    if (name === 'endpoint_kind') names.push(l.aiEndpointKind);
    else if (name === 'base_url') names.push(l.aiBaseUrl);
    else if (name === 'model') names.push(l.aiModel);
    else if (name === 'api_key') names.push(l.aiKey);
    else names.push(name);
  }
  return names.join(', ');
}

interface AiErrorParts {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}

function aiErrorParts(error: unknown): AiErrorParts {
  let source: unknown = error;
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        source = JSON.parse(trimmed) as unknown;
      } catch {
        // 保留原始字符串。
      }
    }
  }
  if (source === null || typeof source !== 'object') {
    return { code: '', message: typeof error === 'string' ? error : '' };
  }
  const obj = source as { code?: unknown; message?: unknown; error?: unknown; status?: unknown };
  const code = typeof obj.code === 'string' ? obj.code : '';
  const messageParts = [obj.error, obj.message]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
  const status = typeof obj.status === 'number' ? obj.status : undefined;
  return { code, message: messageParts, status };
}

/** `AI_*` 错误码族 → 标签字段（管理页与配置向导共用的错误映射单点）。 */
export const AI_ERROR_LABEL_KEYS: Readonly<Record<string, keyof AiConfigLabels>> = {
  AI_HTTP_NOT_ALLOWED: 'aiErrorHttpNotAllowed',
  AI_URL_INVALID: 'aiErrorUrlInvalid',
  AI_CONFIG_INVALID: 'aiErrorConfigInvalid',
  AI_STORAGE_ERROR: 'aiErrorStorage',
  AI_TARGET_LANG_INVALID: 'aiErrorConfigInvalid',
  AI_REQUEST_INVALID: 'aiErrorConfigInvalid',
  AI_MESSAGE_INVALID: 'aiErrorConfigInvalid',
  AI_KEY_INVALID: 'aiErrorKeyInvalid',
  AI_MODEL_NOT_FOUND: 'aiErrorModelNotFound',
  AI_QUOTA_EXCEEDED: 'aiErrorQuota',
  AI_NOT_CONFIGURED: 'aiErrorUnconfigured',
  AI_TIMEOUT: 'aiErrorTimeout',
  AI_NETWORK_ERROR: 'aiErrorNetwork',
  AI_CLIENT_ERROR: 'aiErrorNetwork',
  AI_KEY_STORE_FAILED: 'aiErrorKeyStore',
  AI_RESPONSE_TOO_LARGE: 'aiErrorTooLarge',
  AI_REQUEST_TOO_LARGE: 'aiErrorTooLarge',
};

/** 可区分失败:按错误码族取本地化文案,附 HTTP 状态;未知码回退原始消息。 */
export function aiErrorMessage(
  l: AiConfigLabels,
  error: unknown,
  missing: readonly string[] = [],
): string {
  const parts = aiErrorParts(error);
  const labelKey = AI_ERROR_LABEL_KEYS[parts.code];
  let text: string;
  if (labelKey === undefined) {
    text = parts.message !== '' ? `${l.aiErrorFailed}: ${parts.message}` : l.aiErrorFailed;
  } else {
    text = l[labelKey];
    if (labelKey === 'aiErrorUnconfigured') {
      const summary = aiMissingSummary(l, missing);
      text = summary === '' ? l.aiUnconfigured : text.replace('{missing}', summary);
    }
  }
  if (parts.status !== undefined) {
    text += ` (HTTP ${parts.status})`;
  }
  return text;
}
