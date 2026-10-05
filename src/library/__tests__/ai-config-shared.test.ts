// @vitest-environment jsdom

/**
 * `ai-config-shared`（R3 单一权威）契约：
 *
 * - `ai_*` invoke 封装按命令名传参并防御解析返回（形态不对退回默认形态）。
 * - `READER_AI_CONFIGURED_EVENT` 与助手侧 `ASSISTANT_AI_CONFIGURED_EVENT`
 *   同一常量（原先两处重复定义，现均出自本模块）。
 * - `AI_ERROR_LABEL_KEYS`：AI_* 码 → 标签字段；未知码回退原始消息前缀；
 *   AI_NOT_CONFIGURED 以 {missing} 插入本地化缺口摘要；HTTP 状态附尾。
 * - defaults 解析：后端未返回时退回官方 Base URL 兜底表。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import {
  AI_ENDPOINT_DEFAULT_BASE_URLS,
  AI_ENDPOINT_KINDS,
  AI_ERROR_LABEL_KEYS,
  READER_AI_CONFIGURED_EVENT,
  aiErrorMessage,
  aiMissingSummary,
  canonicalAiGap,
  dispatchAiConfigured,
  fallbackAiConfigStatus,
  invokeAiForgetKey,
  invokeAiGetConfig,
  invokeAiSaveConfig,
  invokeAiStoreKey,
  invokeAiTestConnection,
  isAiEndpointKind,
  parseAiConfigStatus,
  type AiConfigLabels,
} from '../ai-config-shared.js';
import { ASSISTANT_AI_CONFIGURED_EVENT } from '../../assistant/assistant-error.js';
import { READER_AI_CONFIGURED_EVENT as MANAGE_EVENT } from '../library-manage.js';
import { translate } from '../../i18n/messages.js';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function labels(): AiConfigLabels {
  const t = (key: Parameters<typeof translate>[1]): string => translate('zh-CN', key);
  return {
    aiEndpointKind: t('reader.ai.endpointKind'),
    aiBaseUrl: t('reader.ai.baseUrl'),
    aiModel: t('reader.ai.model'),
    aiKey: t('reader.ai.key'),
    aiUnconfigured: t('reader.ai.unconfigured'),
    aiUnconfiguredGaps: t('reader.ai.unconfiguredGaps'),
    aiErrorHttpNotAllowed: t('reader.ai.error.httpNotAllowed'),
    aiErrorUrlInvalid: t('reader.ai.error.urlInvalid'),
    aiErrorConfigInvalid: t('reader.ai.error.configInvalid'),
    aiErrorStorage: t('reader.ai.error.storage'),
    aiErrorKeyInvalid: t('reader.ai.error.keyInvalid'),
    aiErrorModelNotFound: t('reader.ai.error.modelNotFound'),
    aiErrorQuota: t('reader.ai.error.quota'),
    aiErrorUnconfigured: t('reader.ai.error.unconfigured'),
    aiErrorTimeout: t('reader.ai.error.timeout'),
    aiErrorNetwork: t('reader.ai.error.network'),
    aiErrorKeyStore: t('reader.ai.error.keyStore'),
    aiErrorTooLarge: t('reader.ai.error.tooLarge'),
    aiErrorFailed: t('reader.ai.error.failed'),
  };
}

afterEach(() => {
  invokeMock.mockReset();
});

describe('event constant single authority', () => {
  it('exposes one configured event value shared by assistant and manage re-exports', () => {
    expect(READER_AI_CONFIGURED_EVENT).toBe('lightink:reader-ai-configured');
    expect(ASSISTANT_AI_CONFIGURED_EVENT).toBe(READER_AI_CONFIGURED_EVENT);
    expect(MANAGE_EVENT).toBe(READER_AI_CONFIGURED_EVENT);
  });

  it('dispatchAiConfigured broadcasts the shared event with status detail', () => {
    const seen: unknown[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail);
    };
    document.addEventListener(READER_AI_CONFIGURED_EVENT, listener);
    dispatchAiConfigured({ configured: true, missing: [] }, document);
    document.removeEventListener(READER_AI_CONFIGURED_EVENT, listener);
    expect(seen).toEqual([{ configured: true, missing: [] }]);
  });
});

describe('invoke wrappers', () => {
  it('calls each ai_* command with the expected payload and parses the status', async () => {
    const status = {
      endpointKind: 'claude-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3',
      allowHttp: false,
      hasKey: true,
      configured: true,
      missing: [],
      defaults: [],
    };
    invokeMock.mockResolvedValue(status);
    await expect(invokeAiGetConfig()).resolves.toMatchObject({
      endpointKind: 'claude-messages',
      model: 'claude-3',
      hasKey: true,
      configured: true,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('ai_get_config');

    await invokeAiSaveConfig({
      endpointKind: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      allowHttp: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith('ai_save_config', {
      input: {
        endpointKind: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        allowHttp: false,
      },
    });

    await invokeAiStoreKey('sk-test');
    expect(invokeMock).toHaveBeenLastCalledWith('ai_store_key', { key: 'sk-test' });

    await invokeAiForgetKey();
    expect(invokeMock).toHaveBeenLastCalledWith('ai_forget_key');

    invokeMock.mockResolvedValue({ latencyMs: 42, reply: 'pong' });
    await expect(invokeAiTestConnection()).resolves.toEqual({ latencyMs: 42, reply: 'pong' });
    expect(invokeMock).toHaveBeenLastCalledWith('ai_test_connection');
  });

  it('degrades malformed status payloads to the fallback shape without throwing', async () => {
    invokeMock.mockResolvedValue({ endpointKind: 42 });
    const status = await invokeAiGetConfig();
    expect(status).toEqual(fallbackAiConfigStatus());
    expect(status.endpointKind).toBe('openai-chat');
    expect(status.configured).toBe(false);

    invokeMock.mockResolvedValue('nope');
    expect(parseAiConfigStatus('nope')).toEqual(fallbackAiConfigStatus());
  });

  it('fills defaults with the official base URLs when the backend returns none', async () => {
    invokeMock.mockResolvedValue({
      endpointKind: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      allowHttp: false,
      hasKey: true,
      configured: true,
      missing: [],
    });
    const status = await invokeAiGetConfig();
    expect(status.defaults.map((entry) => [entry.endpointKind, entry.baseUrl])).toEqual([
      ['openai-responses', AI_ENDPOINT_DEFAULT_BASE_URLS['openai-responses']],
      ['openai-chat', AI_ENDPOINT_DEFAULT_BASE_URLS['openai-chat']],
      ['claude-messages', AI_ENDPOINT_DEFAULT_BASE_URLS['claude-messages']],
    ]);
  });
});

describe('endpoint kinds', () => {
  it('accepts the three wire kinds and rejects anything else', () => {
    for (const kind of AI_ENDPOINT_KINDS) {
      expect(isAiEndpointKind(kind)).toBe(true);
    }
    expect(isAiEndpointKind('openai')).toBe(false);
    expect(isAiEndpointKind(null)).toBe(false);
  });
});

describe('gap canonicalization and summary', () => {
  it('canonicalizes snake_case and camelCase gap tokens', () => {
    expect(canonicalAiGap('base_url')).toBe('base_url');
    expect(canonicalAiGap('baseUrl')).toBe('base_url');
    expect(canonicalAiGap('apiKey')).toBe('api_key');
    expect(canonicalAiGap('key')).toBe('api_key');
    expect(canonicalAiGap('endpointKind')).toBe('endpoint_kind');
  });

  it('summarizes gaps with localized field names and no duplicates', () => {
    const l = labels();
    expect(aiMissingSummary(l, ['model', 'api_key', 'key'])).toBe(
      `${l.aiModel}, ${l.aiKey}`,
    );
    expect(aiMissingSummary(l, [])).toBe('');
  });
});

describe('AI_ERROR_LABEL_KEYS message mapping', () => {
  it('maps each documented code family to a distinct localized label', () => {
    const l = labels();
    const cases: [string, string][] = [
      ['AI_KEY_INVALID', l.aiErrorKeyInvalid],
      ['AI_MODEL_NOT_FOUND', l.aiErrorModelNotFound],
      ['AI_QUOTA_EXCEEDED', l.aiErrorQuota],
      ['AI_NETWORK_ERROR', l.aiErrorNetwork],
      ['AI_TIMEOUT', l.aiErrorTimeout],
      ['AI_HTTP_NOT_ALLOWED', l.aiErrorHttpNotAllowed],
    ];
    for (const [code, expected] of cases) {
      expect(AI_ERROR_LABEL_KEYS[code]).toBeDefined();
      expect(aiErrorMessage(l, { code, message: 'raw' })).toBe(expected);
    }
  });

  it('keeps the raw message only as a fallback for unknown codes', () => {
    const l = labels();
    expect(aiErrorMessage(l, { code: 'AI_SOMETHING_NEW', message: 'boom' })).toBe(
      `${l.aiErrorFailed}: boom`,
    );
    expect(aiErrorMessage(l, { code: 'AI_SOMETHING_NEW', message: '' })).toBe(l.aiErrorFailed);
  });

  it('parses JSON-string errors and appends the HTTP status', () => {
    const l = labels();
    expect(
      aiErrorMessage(l, JSON.stringify({ code: 'AI_MODEL_NOT_FOUND', message: 'nope' })),
    ).toBe(l.aiErrorModelNotFound);
    expect(aiErrorMessage(l, { code: 'AI_CLIENT_ERROR', message: 'bad', status: 401 })).toBe(
      `${l.aiErrorNetwork} (HTTP 401)`,
    );
  });

  it('interpolates localized missing fields into AI_NOT_CONFIGURED', () => {
    const l = labels();
    const text = aiErrorMessage(l, { code: 'AI_NOT_CONFIGURED', message: '' }, ['model']);
    expect(text).toBe(l.aiErrorUnconfigured.replace('{missing}', l.aiModel));
  });
});
