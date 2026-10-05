// @vitest-environment jsdom

/**
 * `ai-config-wizard`（R3 / ADR-4）契约：
 *
 * - 四步：预设（联动预填官方 Base URL）→ 密钥 → 测试 → 保存。
 * - 测试 = 草稿 storeKey + saveConfig + ai_test_connection（后端只测已保存
 *   配置）；失败按 AI_* 码给分场景本地化文案，并立即回滚到打开时快照，
 *   可返回修改重试（不中断）。
 * - 保存前取消不落任何配置：未写入过则零命令；试连写入过则恢复快照配置，
 *   且快照本无密钥时清掉仅测试期间写入的密钥。
 * - 保存成功派发 lightink:reader-ai-configured（快照缺口/配置态以最新保存
 *   为准）；密钥只在保存（或试连）时经 storeKey 入系统钥匙串。
 */

import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  aiWizardLabels,
  openAiConfigWizard,
  type AiConfigWizardCommands,
  type AiConfigWizardHandle,
} from '../ai-config-wizard.js';
import { READER_AI_CONFIGURED_EVENT } from '../../library/ai-config-shared.js';
import { translate, type MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
  translate('zh-CN', key, vars);

const labels = (): ReturnType<typeof aiWizardLabels> => aiWizardLabels(t);

const AI_DEFAULTS = [
  { endpointKind: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { endpointKind: 'openai-chat', baseUrl: 'https://api.openai.com/v1' },
  { endpointKind: 'claude-messages', baseUrl: 'https://api.anthropic.com/v1' },
];

interface StatusOverrides {
  endpointKind?: string;
  baseUrl?: string;
  model?: string;
  allowHttp?: boolean;
  targetLang?: string;
  hasKey?: boolean;
  configured?: boolean;
  missing?: string[];
}

function status(overrides: StatusOverrides = {}): Record<string, unknown> {
  return {
    endpointKind: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    allowHttp: false,
    hasKey: false,
    configured: false,
    missing: ['endpoint_kind', 'base_url', 'model', 'api_key'],
    defaults: AI_DEFAULTS,
    ...overrides,
  };
}

interface CommandScript {
  getConfig?: StatusOverrides | Error;
  saveConfig?: Record<string, unknown> | Error;
  storeKey?: Record<string, unknown> | Error;
  forgetKey?: Record<string, unknown> | Error;
  testConnection?: { latencyMs: number; reply: string } | Error;
}

function fakeCommands(script: CommandScript = {}): AiConfigWizardCommands & {
  calls: Record<string, MockInstance>;
} {
  const calls = {
    getConfig: vi.fn(async (): Promise<Record<string, unknown>> => {
      const s = script.getConfig;
      if (s instanceof Error) throw s;
      return status(s);
    }),
    saveConfig: vi.fn(async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const s = script.saveConfig;
      if (s instanceof Error) throw s;
      return { ...status(typeof s === 'object' && s !== undefined ? s : {}), ...input };
    }),
    storeKey: vi.fn(async (): Promise<Record<string, unknown>> => {
      const s = script.storeKey;
      if (s instanceof Error) throw s;
      return status(typeof s === 'object' && s !== undefined ? s : { hasKey: true });
    }),
    forgetKey: vi.fn(async (): Promise<Record<string, unknown>> => {
      const s = script.forgetKey;
      if (s instanceof Error) throw s;
      return status(typeof s === 'object' && s !== undefined ? s : {});
    }),
    testConnection: vi.fn(async (): Promise<{ latencyMs: number; reply: string }> => {
      const s = script.testConnection;
      if (s instanceof Error) throw s;
      return s ?? { latencyMs: 87, reply: 'pong' };
    }),
  };
  const commands = {
    getConfig: calls.getConfig,
    saveConfig: calls.saveConfig,
    storeKey: calls.storeKey,
    forgetKey: calls.forgetKey,
    testConnection: calls.testConnection,
    calls,
  };
  // vi.fn 的宽返回（Record<string, unknown>）与 wire 视图（AiConfigStatusView）
  // 的差异只在测试装配处抹平：运行时字段由 status() 工厂保证。
  return commands as unknown as AiConfigWizardCommands & {
    calls: Record<string, MockInstance>;
  };
}

async function flush(steps = 6): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openWizard(
  commands: AiConfigWizardCommands,
  onSaved?: (status: unknown) => void,
): AiConfigWizardHandle {
  const handle = openAiConfigWizard(document, {
    labels,
    commands,
    onSaved,
  });
  activeWizard = handle;
  return handle;
}

function pane(step: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-wizard-pane="${step}"]`);
  expect(el, `missing wizard pane ${step}`).not.toBeNull();
  return el!;
}

function field(name: string): HTMLInputElement | HTMLSelectElement {
  const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  expect(el, `missing wizard field ${name}`).not.toBeNull();
  return el!;
}

function wizardButton(cls: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`.${cls}`);
  expect(el, `missing wizard button .${cls}`).not.toBeNull();
  return el!;
}

function wizardStatus(): HTMLElement {
  return document.querySelector<HTMLElement>('.lightink-ai-wizard-status')!;
}

/** 预设 → 密钥 → 测试，走到测试步（草稿已填好，密钥可传）。 */
async function walkToTest(key: string): Promise<void> {
  field('wizardModel').value = 'gpt-4o-mini';
  field('wizardModel').dispatchEvent(new Event('input', { bubbles: true }));
  wizardButton('lightink-ai-wizard-next').click();
  await flush();
  expect(pane('key').hidden).toBe(false);
  if (key !== '') {
    field('wizardApiKey').value = key;
    field('wizardApiKey').dispatchEvent(new Event('input', { bubbles: true }));
  }
  wizardButton('lightink-ai-wizard-next').click();
  await flush();
  expect(pane('test').hidden).toBe(false);
}

// modal-focus 会在 document 上挂捕获监听：卸载必须走 destroy/release，
// 否则泄漏的 Esc/Tab 拦截会串扰后续用例。
let activeWizard: AiConfigWizardHandle | null = null;

afterEach(() => {
  activeWizard?.destroy();
  activeWizard = null;
  document.body.replaceChildren();
});

describe('openAiConfigWizard preset step', () => {
  it('prefills from the saved snapshot and switches the default base URL with the kind', async () => {
    const commands = fakeCommands({
      getConfig: { model: 'gpt-4o-mini', missing: ['api_key'], hasKey: false },
    });
    openWizard(commands);
    await flush();
    expect(field('wizardEndpointKind').value).toBe('openai-chat');
    expect(field('wizardBaseUrl').value).toBe('https://api.openai.com/v1');
    expect(field('wizardModel').value).toBe('gpt-4o-mini');

    // 切到 claude-messages：仍是旧格式官方默认 → 联动预填新默认。
    field('wizardEndpointKind').value = 'claude-messages';
    field('wizardEndpointKind').dispatchEvent(new Event('change', { bubbles: true }));
    expect(field('wizardBaseUrl').value).toBe('https://api.anthropic.com/v1');

    // 用户改成自定义地址后，再切格式不覆盖。
    field('wizardBaseUrl').value = 'https://relay.example/v1';
    field('wizardBaseUrl').dispatchEvent(new Event('input', { bubbles: true }));
    field('wizardEndpointKind').value = 'openai-responses';
    field('wizardEndpointKind').dispatchEvent(new Event('change', { bubbles: true }));
    expect(field('wizardBaseUrl').value).toBe('https://relay.example/v1');
  });

  it('blocks Next with a localized notice until base URL and model are filled', async () => {
    const commands = fakeCommands();
    openWizard(commands);
    await flush();
    field('wizardBaseUrl').value = '';
    field('wizardBaseUrl').dispatchEvent(new Event('input', { bubbles: true }));
    wizardButton('lightink-ai-wizard-next').click();
    await flush();
    expect(pane('preset').hidden).toBe(false);
    expect(wizardStatus().textContent).toBe(t('reader.ai.wizard.fieldRequired'));

    field('wizardBaseUrl').value = 'https://api.openai.com/v1';
    field('wizardBaseUrl').dispatchEvent(new Event('input', { bubbles: true }));
    field('wizardModel').value = 'gpt-4o-mini';
    field('wizardModel').dispatchEvent(new Event('input', { bubbles: true }));
    wizardButton('lightink-ai-wizard-next').click();
    await flush();
    expect(pane('key').hidden).toBe(false);
  });
});

describe('openAiConfigWizard test step', () => {
  it('persists the draft, tests, reports latency, and unlocks Next', async () => {
    const commands = fakeCommands();
    openWizard(commands);
    await flush();
    await walkToTest('sk-new');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);

    expect(commands.calls.storeKey).toHaveBeenCalledWith('sk-new');
    expect(commands.calls.saveConfig).toHaveBeenCalledWith({
      endpointKind: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      allowHttp: false,
      targetLang: undefined,
    });
    expect(commands.calls.testConnection).toHaveBeenCalledTimes(1);
    expect(wizardStatus().dataset.kind).toBe('success');
    expect(wizardStatus().textContent).toBe(t('reader.ai.testOk', { ms: '87' }));
    expect(wizardButton('lightink-ai-wizard-next').disabled).toBe(false);
  });

  it('keeps the saved key when the key field is left blank', async () => {
    const commands = fakeCommands({ getConfig: { hasKey: true, missing: ['model'] } });
    openWizard(commands);
    await flush();
    expect(pane('key').textContent).toContain(t('reader.ai.wizard.keySavedHint'));
    await walkToTest('');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);
    expect(commands.calls.storeKey).not.toHaveBeenCalled();
    expect(commands.calls.testConnection).toHaveBeenCalledTimes(1);
  });

  it('shows scenario-specific localized failures and rolls the draft back', async () => {
    const cases: [string, MessageKey][] = [
      ['AI_KEY_INVALID', 'reader.ai.error.keyInvalid'],
      ['AI_MODEL_NOT_FOUND', 'reader.ai.error.modelNotFound'],
      ['AI_QUOTA_EXCEEDED', 'reader.ai.error.quota'],
      ['AI_NETWORK_ERROR', 'reader.ai.error.network'],
      ['AI_HTTP_NOT_ALLOWED', 'reader.ai.error.httpNotAllowed'],
    ];
    for (const [code, key] of cases) {
      activeWizard?.destroy();
      activeWizard = null;
      document.body.replaceChildren();
      const commands = fakeCommands({
        testConnection: Object.assign(new Error('raw backend text'), { code }),
      });
      openWizard(commands);
      await flush();
      await walkToTest('sk-bad');
      wizardButton('lightink-ai-wizard-test').click();
      await flush(10);

      expect(wizardStatus().dataset.kind).toBe('error');
      expect(wizardStatus().textContent).toBe(t(key));
      expect(wizardStatus().textContent).not.toContain('raw backend text');
      // 试连失败不留半套配置：恢复快照 + 清掉本次写入的密钥。
      expect(commands.calls.saveConfig).toHaveBeenLastCalledWith({
        endpointKind: 'openai-chat',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        allowHttp: false,
        targetLang: undefined,
      });
      expect(commands.calls.forgetKey).toHaveBeenCalledTimes(1);
      // 未过测试不得进入保存步。
      expect(wizardButton('lightink-ai-wizard-next').disabled).toBe(true);
    }
  });

  it('carries the saved target language override through draft saves', async () => {
    const commands = fakeCommands({ getConfig: { targetLang: 'en', hasKey: true, missing: ['model'] } });
    openWizard(commands);
    await flush();
    await walkToTest('');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);
    expect(commands.calls.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ targetLang: 'en' }),
    );
  });
});

describe('openAiConfigWizard save and cancel', () => {
  it('saves, dispatches the configured event, notifies the host, and closes', async () => {
    const events: unknown[] = [];
    const listener = (event: Event): void => {
      events.push((event as CustomEvent).detail);
    };
    document.addEventListener(READER_AI_CONFIGURED_EVENT, listener);
    const commands = fakeCommands({
      saveConfig: { configured: true, missing: [], hasKey: true },
    });
    const onSaved = vi.fn();
    openWizard(commands, onSaved);
    await flush();
    await walkToTest('sk-final');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);
    wizardButton('lightink-ai-wizard-next').click();
    await flush();
    expect(pane('save').hidden).toBe(false);
    wizardButton('lightink-ai-wizard-save').click();
    await flush(10);

    expect(events).toEqual([{ configured: true, missing: [] }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.lightink-ai-wizard-overlay')).toBeNull();
    document.removeEventListener(READER_AI_CONFIGURED_EVENT, listener);
  });

  it('cancel before any write issues no key and no config commands', async () => {
    const commands = fakeCommands();
    const events: unknown[] = [];
    const listener = (): void => {
      events.push('event');
    };
    document.addEventListener(READER_AI_CONFIGURED_EVENT, listener);
    const wizard = openWizard(commands);
    await flush();
    wizard.cancel();
    await flush(10);
    expect(commands.calls.storeKey).not.toHaveBeenCalled();
    expect(commands.calls.saveConfig).not.toHaveBeenCalled();
    expect(commands.calls.forgetKey).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(document.querySelector('.lightink-ai-wizard-overlay')).toBeNull();
    document.removeEventListener(READER_AI_CONFIGURED_EVENT, listener);
  });

  it('cancel after a successful test restores the snapshot and forgets the test-only key', async () => {
    const commands = fakeCommands();
    openWizard(commands);
    await flush();
    await walkToTest('sk-temp');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);
    expect(commands.calls.forgetKey).not.toHaveBeenCalled();
    wizardButton('lightink-ai-wizard-cancel').click();
    await flush(10);
    // 回滚：恢复打开时的（未配置）快照 + 清掉试连写入的密钥；不派发事件。
    expect(commands.calls.saveConfig).toHaveBeenLastCalledWith({
      endpointKind: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      model: '',
      allowHttp: false,
      targetLang: undefined,
    });
    expect(commands.calls.forgetKey).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.lightink-ai-wizard-overlay')).toBeNull();
  });

  it('Escape cancels the wizard (modal-focus escape path)', async () => {
    const commands = fakeCommands();
    openWizard(commands);
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush(10);
    expect(commands.calls.saveConfig).not.toHaveBeenCalled();
    expect(document.querySelector('.lightink-ai-wizard-overlay')).toBeNull();
  });

  it('keeps a failed save open with the localized error and without dispatching', async () => {
    const events: unknown[] = [];
    const listener = (): void => {
      events.push('event');
    };
    document.addEventListener(READER_AI_CONFIGURED_EVENT, listener);
    const commands = fakeCommands({
      saveConfig: Object.assign(new Error('save rejected'), { code: 'AI_STORAGE_ERROR' }),
    });
    openWizard(commands);
    await flush();
    await walkToTest('sk-1');
    wizardButton('lightink-ai-wizard-test').click();
    await flush(10);
    // 试连用的 saveConfig 也会失败 → 测试步给出分场景文案，Next 保持锁。
    expect(wizardStatus().dataset.kind).toBe('error');
    expect(wizardStatus().textContent).toBe(t('reader.ai.error.storage'));
    expect(events).toEqual([]);
    expect(document.querySelector('.lightink-ai-wizard-overlay')).not.toBeNull();
    document.removeEventListener(READER_AI_CONFIGURED_EVENT, listener);
  });
});
