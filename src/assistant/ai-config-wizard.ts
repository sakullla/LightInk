/**
 * `ai-config-wizard` — AI 提供商引导式配置向导（R3 / ADR-4）。
 *
 * 四步：预设（endpoint 格式 + 联动 Base URL + 模型 + allowHttp）→ 密钥 →
 * 测试 → 保存。零后端改动：全部经 `library/ai-config-shared` 的既有 Tauri
 * 命令封装执行；测试失败文案直接消费共享的 `AI_ERROR_LABEL_KEYS` 映射
 * （分场景：密钥无效 / 模型不存在 / 限流 / 网络等）。
 *
 * 失败边界（对齐 ADR-4）：保存之前取消不落任何配置。`ai_test_connection`
 * 只能测「已保存」配置，因此测试步骤先用草稿值 store key + save config 再
 * 试连；测试失败立即回滚到打开向导时的快照（保存过的配置写回原值，仅测试
 * 期间写入且快照无密钥时清掉密钥）。已勾选 allowHttp 之外的 HTTP 地址仍由
 * 后端按既有安全规则拒绝（AI_HTTP_NOT_ALLOWED → 本地化原因）。
 *
 * 挂载沿用 confirm-dialog 的 modal-focus 语言：背景 inert、焦点圈定、
 * Esc/遮罩/× 均按取消处理；主题令牌从当前 library/reader 表面推断复制。
 */

import type { MessageKey } from '../i18n/messages.js';
import {
  AI_ENDPOINT_DEFAULT_BASE_URLS,
  AI_ENDPOINT_KINDS,
  aiErrorMessage,
  dispatchAiConfigured,
  fallbackAiConfigStatus,
  invokeAiForgetKey,
  invokeAiGetConfig,
  invokeAiSaveConfig,
  invokeAiStoreKey,
  invokeAiTestConnection,
  isAiEndpointKind,
  type AiConfigLabels,
  type AiConfigInputView,
  type AiConfigStatusView,
  type AiEndpointKindId,
  type AiTestResultView,
} from '../library/ai-config-shared.js';
import { adoptDialogSurfaceTheme, inferDialogThemeHost } from '../ui/confirm-dialog.js';
import { labelModal, mountModalFocus } from '../ui/modal-focus.js';

/** 向导文案：共享字段/错误标签（AiConfigLabels）+ 向导专属步骤与按钮。 */
export interface AiWizardLabels extends AiConfigLabels {
  readonly title: string;
  readonly stepPreset: string;
  readonly stepKey: string;
  readonly stepTest: string;
  readonly stepSave: string;
  readonly endpointOpenaiResponses: string;
  readonly endpointOpenaiChat: string;
  readonly endpointClaudeMessages: string;
  readonly allowHttp: string;
  readonly presetHint: string;
  readonly modelPlaceholder: string;
  readonly fieldRequired: string;
  readonly keyHint: string;
  readonly keyPlaceholder: string;
  readonly keySavedHint: string;
  readonly keyShow: string;
  readonly keyHide: string;
  readonly allowHttpHint: string;
  readonly testHint: string;
  readonly summaryKeyNew: string;
  readonly summaryKeySaved: string;
  readonly testOk: string;
  readonly testing: string;
  readonly test: string;
  readonly saveHint: string;
  readonly back: string;
  readonly next: string;
  readonly cancel: string;
  readonly save: string;
}

/** t(key) 装配向导文案（en/zh 键对齐由 messages.ts 编译期保证）。 */
export function aiWizardLabels(
  t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string,
): AiWizardLabels {
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
    title: t('reader.ai.wizard.title'),
    stepPreset: t('reader.ai.wizard.step.preset'),
    stepKey: t('reader.ai.wizard.step.key'),
    stepTest: t('reader.ai.wizard.step.test'),
    stepSave: t('reader.ai.wizard.step.save'),
    endpointOpenaiResponses: t('reader.ai.endpoint.openai-responses'),
    endpointOpenaiChat: t('reader.ai.endpoint.openai-chat'),
    endpointClaudeMessages: t('reader.ai.endpoint.claude-messages'),
    allowHttp: t('reader.ai.allowHttp'),
    presetHint: t('reader.ai.wizard.presetHint'),
    modelPlaceholder: t('reader.ai.wizard.modelPlaceholder'),
    fieldRequired: t('reader.ai.wizard.fieldRequired'),
    keyHint: t('reader.ai.wizard.keyHint'),
    keyPlaceholder: t('reader.ai.wizard.keyPlaceholder'),
    keySavedHint: t('reader.ai.wizard.keySavedHint'),
    keyShow: t('reader.ai.keyShow'),
    keyHide: t('reader.ai.keyHide'),
    allowHttpHint: t('reader.ai.wizard.allowHttpHint'),
    testHint: t('reader.ai.wizard.testHint'),
    summaryKeyNew: t('reader.ai.wizard.summaryKeyNew'),
    summaryKeySaved: t('reader.ai.wizard.summaryKeySaved'),
    testOk: t('reader.ai.testOk'),
    testing: t('reader.ai.wizard.testing'),
    test: t('reader.ai.wizard.test'),
    saveHint: t('reader.ai.wizard.saveHint'),
    back: t('reader.ai.wizard.back'),
    next: t('reader.ai.wizard.next'),
    cancel: t('reader.ai.wizard.cancel'),
    save: t('reader.ai.wizard.save'),
  };
}

/** 向导执行的全部 Tauri 命令（注入式，测试可 fake；密钥只经 storeKey 入钥匙串）。 */
export interface AiConfigWizardCommands {
  getConfig(): Promise<AiConfigStatusView>;
  saveConfig(input: AiConfigInputView): Promise<AiConfigStatusView>;
  storeKey(key: string): Promise<AiConfigStatusView>;
  forgetKey(): Promise<AiConfigStatusView>;
  testConnection(): Promise<AiTestResultView>;
}

export const defaultAiConfigWizardCommands: AiConfigWizardCommands = {
  getConfig: () => invokeAiGetConfig(),
  saveConfig: (input) => invokeAiSaveConfig(input),
  storeKey: (key) => invokeAiStoreKey(key),
  forgetKey: () => invokeAiForgetKey(),
  testConnection: () => invokeAiTestConnection(),
};

export interface AiConfigWizardOptions {
  readonly labels: () => AiWizardLabels;
  /** 复制主题令牌的宿主；缺省按当前 library/reader 表面推断。 */
  readonly themeHost?: HTMLElement | null;
  /** 命令注入（测试）；缺省走 ai-config-shared 的 invoke 封装。 */
  readonly commands?: AiConfigWizardCommands;
  /** 保存成功后的回调（配置事件已派发，可做宿主侧刷新）。 */
  readonly onSaved?: (status: AiConfigStatusView) => void;
}

export interface AiConfigWizardHandle {
  /** 挂到 body 的 overlay 根节点（测试断言用）。 */
  readonly element: HTMLElement;
  /** 取消：保存前回滚到打开时的快照并关闭（Esc / 遮罩 / × 同路径）。 */
  cancel(): void;
  /** 直接拆除（宿主卸载用；不回滚、不再派发事件）。 */
  destroy(): void;
}

type WizardStep = 'preset' | 'key' | 'test' | 'save';

const WIZARD_STEPS: readonly { readonly id: WizardStep; readonly name: keyof AiWizardLabels }[] = [
  { id: 'preset', name: 'stepPreset' },
  { id: 'key', name: 'stepKey' },
  { id: 'test', name: 'stepTest' },
  { id: 'save', name: 'stepSave' },
];

function button(doc: Document, className: string): HTMLButtonElement {
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = className;
  return el;
}

/**
 * 打开配置向导（全局模态，挂 body）。取消（Esc/遮罩/×/取消按钮）在保存前
 * 不落任何配置；保存成功派发 `lightink:reader-ai-configured`，书架翻译入口
 * 与助手面板等既有监听方自动刷新。
 */
export function openAiConfigWizard(doc: Document, options: AiConfigWizardOptions): AiConfigWizardHandle {
  const commands = options.commands ?? defaultAiConfigWizardCommands;
  const labels = options.labels;

  let snapshot = fallbackAiConfigStatus();
  let step: WizardStep = 'preset';
  let endpointKind: AiEndpointKindId = snapshot.endpointKind;
  const defaultsByKind = new Map<AiEndpointKindId, string>();
  let tested = false;
  let testing = false;
  let saving = false;
  let statusText = '';
  let statusKind: 'info' | 'success' | 'error' = 'info';
  // 测试步骤为试连而写入的状态（保存前取消/测试失败据此回滚）。
  let persistedDraft = false;
  let storedDraftKey = false;
  let closed = false;
  let releaseModal: (() => void) | null = null;

  // ── DOM ────────────────────────────────────────────────────────────
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-ai-wizard-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-ai-wizard';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = doc.createElement('div');
  head.className = 'lightink-modal-head';
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  const dismiss = button(doc, 'lightink-modal-dismiss');
  dismiss.textContent = '×';
  head.append(title, dismiss);

  const steps = doc.createElement('ol');
  steps.className = 'lightink-ai-wizard-steps';
  const stepItems = new Map<WizardStep, HTMLLIElement>();
  for (const entry of WIZARD_STEPS) {
    const item = doc.createElement('li');
    item.dataset.wizardStep = entry.id;
    const name = doc.createElement('span');
    name.dataset.wizardStepName = entry.id;
    item.appendChild(name);
    steps.appendChild(item);
    stepItems.set(entry.id, item);
  }

  const body = doc.createElement('div');
  body.className = 'lightink-ai-wizard-body';

  // 步骤 1：预设。
  const preset = doc.createElement('section');
  preset.dataset.wizardPane = 'preset';
  const presetHint = doc.createElement('p');
  presetHint.className = 'lightink-ai-wizard-hint';
  const endpointField = doc.createElement('label');
  endpointField.className = 'lightink-library-field lightink-ai-wizard-endpoint';
  const endpointText = doc.createElement('span');
  const endpointSelect = doc.createElement('select');
  endpointSelect.name = 'wizardEndpointKind';
  const endpointOptions = new Map<AiEndpointKindId, HTMLOptionElement>();
  for (const kind of AI_ENDPOINT_KINDS) {
    const option = doc.createElement('option');
    option.value = kind;
    endpointSelect.appendChild(option);
    endpointOptions.set(kind, option);
  }
  endpointField.append(endpointText, endpointSelect);

  const baseField = doc.createElement('label');
  baseField.className = 'lightink-library-field lightink-ai-wizard-base';
  const baseText = doc.createElement('span');
  const baseInput = doc.createElement('input');
  baseInput.type = 'url';
  baseInput.name = 'wizardBaseUrl';
  baseInput.autocomplete = 'off';
  baseInput.spellcheck = false;
  baseField.append(baseText, baseInput);

  const modelField = doc.createElement('label');
  modelField.className = 'lightink-library-field lightink-ai-wizard-model';
  const modelText = doc.createElement('span');
  const modelInput = doc.createElement('input');
  modelInput.type = 'text';
  modelInput.name = 'wizardModel';
  modelInput.autocomplete = 'off';
  modelInput.spellcheck = false;
  modelField.append(modelText, modelInput);

  const allowHttpLabel = doc.createElement('label');
  allowHttpLabel.className = 'lightink-library-reader-pref lightink-ai-wizard-allow-http';
  const allowHttpInput = doc.createElement('input');
  allowHttpInput.type = 'checkbox';
  allowHttpInput.name = 'wizardAllowHttp';
  const allowHttpText = doc.createElement('span');
  allowHttpLabel.append(allowHttpInput, allowHttpText);
  const allowHttpHint = doc.createElement('p');
  allowHttpHint.className = 'lightink-ai-wizard-hint';
  preset.append(presetHint, endpointField, baseField, modelField, allowHttpLabel, allowHttpHint);

  // 步骤 2：密钥。
  const keyPane = doc.createElement('section');
  keyPane.dataset.wizardPane = 'key';
  const keyHint = doc.createElement('p');
  keyHint.className = 'lightink-ai-wizard-hint';
  keyHint.dataset.wizardKeyHint = 'true';
  const keyField = doc.createElement('label');
  keyField.className = 'lightink-library-field lightink-ai-wizard-key';
  const keyText = doc.createElement('span');
  const keyRow = doc.createElement('div');
  keyRow.className = 'lightink-ai-wizard-key-row';
  const keyInput = doc.createElement('input');
  keyInput.type = 'password';
  keyInput.name = 'wizardApiKey';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  const keyReveal = button(doc, 'lightink-ai-wizard-key-reveal');
  keyReveal.setAttribute('aria-pressed', 'false');
  keyField.append(keyText, keyInput);
  keyRow.append(keyField, keyReveal);
  keyPane.append(keyHint, keyRow);

  // 步骤 3：测试；步骤 4：保存（同一份草稿摘要，两个步骤各渲染一份）。
  const summaryList = (doc: Document): HTMLDListElement => {
    const el = doc.createElement('dl');
    el.className = 'lightink-ai-wizard-summary';
    return el;
  };
  const testPane = doc.createElement('section');
  testPane.dataset.wizardPane = 'test';
  const testHint = doc.createElement('p');
  testHint.className = 'lightink-ai-wizard-hint';
  const testSummary = summaryList(doc);
  testPane.append(testHint, testSummary);
  const savePane = doc.createElement('section');
  savePane.dataset.wizardPane = 'save';
  const saveHint = doc.createElement('p');
  saveHint.className = 'lightink-ai-wizard-hint';
  const saveSummary = summaryList(doc);
  savePane.append(saveHint, saveSummary);

  const status = doc.createElement('p');
  status.className = 'lightink-ai-wizard-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const footer = doc.createElement('div');
  footer.className = 'lightink-modal-actions lightink-ai-wizard-actions';
  const cancelBtn = button(doc, 'lightink-modal-btn lightink-ai-wizard-cancel');
  const backBtn = button(doc, 'lightink-modal-btn lightink-ai-wizard-back');
  const testBtn = button(doc, 'lightink-modal-btn lightink-ai-wizard-test');
  const nextBtn = button(doc, 'lightink-modal-btn lightink-modal-btn--primary lightink-ai-wizard-next');
  const saveBtn = button(doc, 'lightink-modal-btn lightink-modal-btn--primary lightink-ai-wizard-save');
  footer.append(cancelBtn, backBtn, testBtn, nextBtn, saveBtn);

  dialog.append(head, steps, body, status, footer);
  body.append(preset, keyPane, testPane, savePane);
  overlay.appendChild(dialog);
  labelModal(dialog, title);

  // ── 状态读写 ───────────────────────────────────────────────────────

  const setStatus = (text: string, kind: 'info' | 'success' | 'error'): void => {
    statusText = text;
    statusKind = kind;
  };

  const readEndpointKind = (): AiEndpointKindId =>
    isAiEndpointKind(endpointSelect.value) ? endpointSelect.value : 'openai-chat';

  const draftGaps = (): string[] => {
    const gaps: string[] = [];
    if (baseInput.value.trim() === '') gaps.push('base_url');
    if (modelInput.value.trim() === '') gaps.push('model');
    if (keyInput.value.trim() === '' && !snapshot.hasKey) gaps.push('api_key');
    return gaps;
  };

  const draftInput = (): AiConfigInputView => ({
    endpointKind: readEndpointKind(),
    baseUrl: baseInput.value.trim(),
    model: modelInput.value.trim(),
    allowHttp: allowHttpInput.checked,
    // 向导不编辑目标语言覆盖：沿用打开时的值（ai_save_config 是整份覆盖）。
    targetLang: snapshot.targetLang,
  });

  /** 任何草稿改动都使既有测试结论失效（下一步重新要求测试）。 */
  const invalidateTest = (): void => {
    tested = false;
  };

  const rollback = async (): Promise<void> => {
    if (!persistedDraft && !storedDraftKey) return;
    try {
      if (persistedDraft) {
        await commands.saveConfig({
          endpointKind: snapshot.endpointKind,
          baseUrl: snapshot.baseUrl,
          model: snapshot.model,
          allowHttp: snapshot.allowHttp,
          targetLang: snapshot.targetLang,
        });
      }
      if (storedDraftKey && !snapshot.hasKey) {
        await commands.forgetKey();
      }
    } catch {
      // 回滚失败不掩盖原错误：交由管理页显示真实落盘状态。
    }
    persistedDraft = false;
    storedDraftKey = false;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseModal?.();
    overlay.remove();
  };

  const cancel = (): void => {
    if (closed) return;
    void rollback().finally(() => close());
  };

  const runTest = async (): Promise<void> => {
    if (testing || saving) return;
    testing = true;
    tested = false;
    setStatus(labels().testing, 'info');
    render();
    try {
      const key = keyInput.value.trim();
      if (key !== '') {
        await commands.storeKey(key);
        storedDraftKey = true;
      }
      await commands.saveConfig(draftInput());
      persistedDraft = true;
      const result = await commands.testConnection();
      tested = true;
      setStatus(labels().testOk.replace('{ms}', String(result.latencyMs)), 'success');
    } catch (error) {
      tested = false;
      setStatus(aiErrorMessage(labels(), error, draftGaps()), 'error');
      // 试连失败：不留半套草稿配置，回到打开时的快照，可返回修改重试。
      await rollback();
    } finally {
      testing = false;
      render();
    }
  };

  const runSave = async (): Promise<void> => {
    if (testing || saving) return;
    saving = true;
    render();
    try {
      const key = keyInput.value.trim();
      if (key !== '') {
        await commands.storeKey(key);
        storedDraftKey = true;
      }
      const saved = await commands.saveConfig(draftInput());
      persistedDraft = true;
      dispatchAiConfigured({ configured: saved.configured, missing: saved.missing }, doc);
      options.onSaved?.(saved);
      close();
    } catch (error) {
      setStatus(aiErrorMessage(labels(), error, draftGaps()), 'error');
    } finally {
      saving = false;
      if (!closed) {
        render();
      }
    }
  };

  const goToStep = (next: WizardStep, focusFirst = true): void => {
    step = next;
    render();
    if (!focusFirst) return;
    const pane = body.querySelector<HTMLElement>(`[data-wizard-pane="${next}"]`);
    const first =
      pane?.querySelector<HTMLElement>('select, input, button') ??
      (next === 'save' ? saveBtn : null);
    first?.focus();
  };

  // ── 事件 ───────────────────────────────────────────────────────────

  endpointSelect.addEventListener('change', () => {
    // 与管理页同一联动规则：地址为空或仍是旧格式官方默认时预填新默认，
    // 用户改过自定义地址则不动。
    const next = readEndpointKind();
    const previousDefault = defaultsByKind.get(endpointKind);
    const current = baseInput.value.trim();
    if (current === '' || (previousDefault !== undefined && current === previousDefault)) {
      const nextDefault = defaultsByKind.get(next);
      if (nextDefault !== undefined) {
        baseInput.value = nextDefault;
      }
    }
    endpointKind = next;
    invalidateTest();
    render();
  });
  baseInput.addEventListener('input', invalidateTest);
  modelInput.addEventListener('input', invalidateTest);
  allowHttpInput.addEventListener('change', invalidateTest);
  keyInput.addEventListener('input', () => {
    invalidateTest();
    if (keyInput.value === '') {
      keyInput.type = 'password';
      keyReveal.setAttribute('aria-pressed', 'false');
    }
    render();
  });
  keyReveal.addEventListener('click', () => {
    const reveal = keyInput.type === 'password';
    keyInput.type = reveal ? 'text' : 'password';
    keyReveal.setAttribute('aria-pressed', String(reveal));
    keyReveal.textContent = reveal ? labels().keyHide : labels().keyShow;
    keyInput.focus();
  });

  cancelBtn.addEventListener('click', cancel);
  dismiss.addEventListener('click', cancel);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      cancel();
    }
  });
  backBtn.addEventListener('click', () => {
    const order = WIZARD_STEPS.map((entry) => entry.id);
    const index = order.indexOf(step);
    if (index > 0) {
      goToStep(order[index - 1]!);
    }
  });
  nextBtn.addEventListener('click', () => {
    if (step === 'preset') {
      if (baseInput.value.trim() === '' || modelInput.value.trim() === '') {
        setStatus(labels().fieldRequired, 'error');
        render();
        return;
      }
      goToStep('key');
      return;
    }
    if (step === 'key') {
      goToStep('test');
      return;
    }
    if (step === 'test' && tested) {
      goToStep('save');
    }
  });
  testBtn.addEventListener('click', () => {
    void runTest();
  });
  saveBtn.addEventListener('click', () => {
    void runSave();
  });

  // ── 渲染 ───────────────────────────────────────────────────────────

  const renderSummary = (target: HTMLDListElement): void => {
    const l = labels();
    const endpointNames: Record<AiEndpointKindId, string> = {
      'openai-responses': l.endpointOpenaiResponses,
      'openai-chat': l.endpointOpenaiChat,
      'claude-messages': l.endpointClaudeMessages,
    };
    const rows: [string, string][] = [
      ['endpoint', endpointNames[readEndpointKind()]],
      ['baseUrl', baseInput.value.trim()],
      ['model', modelInput.value.trim()],
      [
        'key',
        keyInput.value.trim() !== '' ? l.summaryKeyNew : l.summaryKeySaved,
      ],
    ];
    target.replaceChildren();
    for (const [id, value] of rows) {
      const dt = doc.createElement('dt');
      const dd = doc.createElement('dd');
      dt.dataset.wizardSummaryName = id;
      dd.dataset.wizardSummaryValue = id;
      dt.textContent =
        id === 'endpoint' ? l.aiEndpointKind
          : id === 'baseUrl' ? l.aiBaseUrl
            : id === 'model' ? l.aiModel
              : l.aiKey;
      dd.textContent = value;
      target.append(dt, dd);
    }
  };

  function render(): void {
    const l = labels();
    title.textContent = l.title;
    dismiss.setAttribute('aria-label', l.cancel);
    dismiss.title = l.cancel;
    for (const entry of WIZARD_STEPS) {
      const item = stepItems.get(entry.id);
      if (item === undefined) continue;
      const index = WIZARD_STEPS.findIndex((candidate) => candidate.id === entry.id);
      const active = entry.id === step;
      item.classList.toggle('is-active', active);
      item.classList.toggle('is-done', index < WIZARD_STEPS.findIndex((c) => c.id === step));
      if (active) {
        item.setAttribute('aria-current', 'step');
      } else {
        item.removeAttribute('aria-current');
      }
      const name = item.querySelector<HTMLElement>(`[data-wizard-step-name="${entry.id}"]`);
      if (name !== null) {
        name.textContent = `${index + 1}. ${l[entry.name]}`;
      }
    }

    presetHint.textContent = l.presetHint;
    endpointText.textContent = l.aiEndpointKind;
    endpointOptions.get('openai-responses')!.textContent = l.endpointOpenaiResponses;
    endpointOptions.get('openai-chat')!.textContent = l.endpointOpenaiChat;
    endpointOptions.get('claude-messages')!.textContent = l.endpointClaudeMessages;
    baseText.textContent = l.aiBaseUrl;
    modelText.textContent = l.aiModel;
    modelInput.placeholder = l.modelPlaceholder;
    allowHttpText.textContent = l.allowHttp;
    allowHttpHint.textContent = l.allowHttpHint;
    keyText.textContent = l.aiKey;
    keyInput.placeholder = snapshot.hasKey ? l.keySavedHint : l.keyPlaceholder;
    keyHint.textContent = snapshot.hasKey ? l.keySavedHint : l.keyHint;
    keyReveal.textContent =
      keyReveal.getAttribute('aria-pressed') === 'true' ? l.keyHide : l.keyShow;
    keyReveal.disabled = keyInput.value === '';
    testHint.textContent = l.testHint;
    saveHint.textContent = l.saveHint;
    renderSummary(testSummary);
    renderSummary(saveSummary);

    for (const pane of [preset, keyPane, testPane, savePane]) {
      pane.hidden = pane.dataset.wizardPane !== step;
    }

    cancelBtn.textContent = l.cancel;
    backBtn.textContent = l.back;
    testBtn.textContent = testing ? l.testing : l.test;
    nextBtn.textContent = l.next;
    saveBtn.textContent = l.save;
    backBtn.hidden = step === 'preset';
    testBtn.hidden = step !== 'test';
    nextBtn.hidden = step === 'save';
    saveBtn.hidden = step !== 'save';
    testBtn.disabled = testing || saving;
    saveBtn.disabled = testing || saving;
    // 测试步：测试通过前「下一步」保持禁用——保存必须先过一次真实试连。
    nextBtn.disabled = testing || saving || (step === 'test' && !tested);

    status.textContent = statusText;
    status.dataset.kind = statusKind;
    status.hidden = statusText === '';
  }

  // ── 初始化 ─────────────────────────────────────────────────────────

  const applySnapshot = (): void => {
    defaultsByKind.clear();
    for (const kind of AI_ENDPOINT_KINDS) {
      defaultsByKind.set(kind, AI_ENDPOINT_DEFAULT_BASE_URLS[kind]);
    }
    for (const entry of snapshot.defaults) {
      defaultsByKind.set(entry.endpointKind, entry.baseUrl);
    }
    endpointKind = snapshot.endpointKind;
    endpointSelect.value = endpointKind;
    baseInput.value = snapshot.baseUrl;
    modelInput.value = snapshot.model;
    allowHttpInput.checked = snapshot.allowHttp;
    render();
  };

  render();
  const themeHost = options.themeHost === undefined ? inferDialogThemeHost(doc) : options.themeHost;
  if (themeHost !== null) {
    adoptDialogSurfaceTheme(overlay, themeHost);
  }
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    onEscape: () => cancel(),
  });

  void (async () => {
    try {
      snapshot = await commands.getConfig();
    } catch {
      snapshot = fallbackAiConfigStatus();
    }
    applySnapshot();
  })();

  return {
    element: overlay,
    cancel,
    destroy(): void {
      close();
    },
  };
}
