/**
 * Manage page (管理): a grouped settings page — appearance / reading
 * preferences / storage & cache / sync / other — with a cache-limit
 * dialog instead of a second page.
 *
 * Owns the manage DOM and the dialog state machine (`home | cache-limit`).
 * The dialog follows overlay Escape semantics: while it is open, a
 * (synthetic) Escape — including the Android back key dispatched through
 * ui/back-navigation.ts — is consumed to close it; on the manage home
 * nothing is consumed and the press falls through.
 */

import { invoke } from '@tauri-apps/api/core';
import type { LibraryClient } from './library-client.js';
import {
  dispatchDeeplConfigured,
  invokeDeepLConfigured,
  invokeDeepLForgetKey,
  invokeDeepLStoreKey,
} from '../reader/lookup-panel.js';
import {
  applyLibraryTheme,
  LIBRARY_THEMES,
  loadLibraryTheme,
  mountLibraryOverlay,
  saveLibraryTheme,
  type LibraryThemeId,
  type LibraryThemeStorage,
} from './library-theme.js';
import {
  READER_PAGE_TURN_STYLES,
  READER_PREFS_STORAGE_KEY,
  applyReaderPrefs,
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderPrefsStorage,
  type ReaderPageTurnStyle,
} from '../reader/reader-prefs.js';

export type ManageSubpage = 'home' | 'cache-limit';

export interface LibraryManageLabels {
  readonly appearance: string;
  readonly libraryTheme: string;
  readonly libraryThemeHint: string;
  readonly readingGroup: string;
  readonly readerPrefsHint: string;
  readonly showProgressBar: string;
  readonly pageTurnStyle: string;
  readonly pageTurnStyleAuto: string;
  readonly pageTurnStyleSlide: string;
  readonly pageTurnStyleFade: string;
  readonly pageTurnStyleCurl: string;
  readonly pageTurnStyleNone: string;
  readonly translateGroup: string;
  readonly deeplKey: string;
  readonly deeplHint: string;
  readonly deeplSave: string;
  readonly deeplClear: string;
  readonly deeplConfigured: string;
  readonly deeplUnconfigured: string;
  readonly aiGroup: string;
  readonly aiHint: string;
  readonly aiEndpointKind: string;
  readonly aiEndpointOpenaiResponses: string;
  readonly aiEndpointOpenaiChat: string;
  readonly aiEndpointClaudeMessages: string;
  readonly aiBaseUrl: string;
  readonly aiModel: string;
  readonly aiKey: string;
  readonly aiKeySave: string;
  readonly aiKeyClear: string;
  readonly aiAllowHttp: string;
  readonly aiTargetLang: string;
  readonly aiTargetLangAuto: string;
  readonly aiLangZhCN: string;
  readonly aiLangEn: string;
  readonly aiLangJa: string;
  readonly aiLangKo: string;
  readonly aiLangFr: string;
  readonly aiLangDe: string;
  readonly aiLangEs: string;
  readonly aiLangRu: string;
  readonly aiSave: string;
  readonly aiTest: string;
  readonly aiTesting: string;
  readonly aiTestOk: string;
  readonly aiConfigured: string;
  readonly aiUnconfigured: string;
  readonly aiUnconfiguredGaps: string;
  readonly aiSaved: string;
  readonly aiKeySaved: string;
  readonly aiKeyCleared: string;
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
  readonly storageGroup: string;
  readonly clearCache: string;
  readonly cacheUsage: string;
  readonly cacheLimit: string;
  readonly changeCacheLimit: string;
  readonly apply: string;
  readonly cancel: string;
  readonly syncGroup: string;
  readonly webdavSync: string;
  readonly otherGroup: string;
  readonly importLocal: string;
  readonly markdownEditor: string;
}

export interface LibraryManageOptions {
  readonly labels: () => LibraryManageLabels;
  readonly themeLabel: (id: LibraryThemeId) => string;
  /** Library root element: shelf theme tokens are applied here. */
  readonly themeRoot: HTMLElement;
  readonly themeStorage?: LibraryThemeStorage | null;
  readonly readerPrefsStorage?: ReaderPrefsStorage | null;
  readonly library: Pick<LibraryClient, 'clearCache' | 'setCacheLimit' | 'cacheStats'>;
  readonly notify: (message: string, kind?: 'error' | 'warning') => void;
  readonly formatError: (error: unknown) => string;
  /** Import a local book; the host view owns post-import navigation. */
  readonly onImport: () => Promise<void>;
  readonly onOpenSyncPanel?: () => void;
  /** Desktop-only entry; the row is suppressed when absent. */
  readonly onEnterEditor?: () => void;
}

export interface LibraryManageView {
  readonly element: HTMLElement;
  /** Close the cache-limit dialog and stay on the manage home. */
  showHome(): void;
  /** Overlay Escape semantics: closes the open dialog; true when consumed. */
  handleEscape(): boolean;
  refreshCache(): Promise<void>;
  retranslate(): void;
  destroy(): void;
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

/**
 * Cache-limit dialog height budget. The overlay bottom offset (keyboard /
 * safe-area inset) is owned by the touch rules in library.css — no inline
 * paddingBottom here: inline style specificity would override the sheet rule
 * `padding-bottom: max(safe-bottom, keyboard-inset)` and zero out the
 * safe-bottom channel when the keyboard is closed (inconsistent with the
 * group/source sheets). Single deduction (reader-chrome-panels.ts
 * pinFixedOverlay paradigm): on touch the height budget — keyboard-open anchor
 * included — is owned by library.css; desktop keeps the legacy cap.
 */
function applyCacheLimitDialogHeightCap(overlay: HTMLElement, dialog: HTMLElement): void {
  const root = overlay.ownerDocument.documentElement;
  const touch = root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary');
  // 桌面保留既有高度上限（键盘不占位，与改版前等价）。
  if (!touch) {
    dialog.style.maxHeight = 'calc(100dvh - 24px)';
  }
}

function button(doc: Document, text: string, className = ''): HTMLButtonElement {
  const el = doc.createElement('button');
  el.type = 'button';
  if (className !== '') el.className = className;
  el.textContent = text;
  return el;
}

// ── AI 提供商分组(R2)──命令封装、解析与事件广播 ──────────────────────

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

/** 翻译目标语言覆盖项:auto = 跟随界面语言(ADR-4),其余为常用阅读语言。 */
export const AI_TARGET_LANG_VALUES = ['auto', 'zh-CN', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'] as const;

export type AiTargetLangValue = (typeof AI_TARGET_LANG_VALUES)[number];

export const READER_AI_CONFIGURED_EVENT = 'lightink:reader-ai-configured';

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

export function dispatchAiConfigured(
  detail: AiConfiguredDetail,
  target: Document | Window = document,
): void {
  target.dispatchEvent(new CustomEvent(READER_AI_CONFIGURED_EVENT, { detail }));
}

export function aiTargetLangLabel(value: AiTargetLangValue, l: LibraryManageLabels): string {
  switch (value) {
    case 'auto': return l.aiTargetLangAuto;
    case 'zh-CN': return l.aiLangZhCN;
    case 'en': return l.aiLangEn;
    case 'ja': return l.aiLangJa;
    case 'ko': return l.aiLangKo;
    case 'fr': return l.aiLangFr;
    case 'de': return l.aiLangDe;
    case 'es': return l.aiLangEs;
    case 'ru': return l.aiLangRu;
  }
}

/** 四要素缺口 token → 本地化字段名(后端 config_gaps 的字段名回报)。 */
export function aiMissingSummary(l: LibraryManageLabels, missing: readonly string[]): string {
  const names: string[] = [];
  for (const gap of missing) {
    if (gap === 'endpoint_kind') names.push(l.aiEndpointKind);
    else if (gap === 'base_url') names.push(l.aiBaseUrl);
    else if (gap === 'model') names.push(l.aiModel);
    else if (gap === 'api_key') names.push(l.aiKey);
    else if (gap !== '') names.push(gap);
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

const AI_ERROR_LABEL_KEYS: Record<string, keyof LibraryManageLabels> = {
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
  l: LibraryManageLabels,
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


export function createLibraryManage(
  doc: Document,
  options: LibraryManageOptions,
): LibraryManageView {
  const labels = options.labels;
  let currentLibraryTheme = loadLibraryTheme(options.themeStorage);
  let currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
  applyReaderPrefs(doc.documentElement, currentReaderPrefs);
  let subpage: ManageSubpage = 'home';

  const element = doc.createElement('div');
  element.className = 'lightink-library-manage-panel';
  element.dataset.managePage = subpage;

  const home = doc.createElement('div');
  home.className = 'lightink-library-manage-home';

  // 外观：书架主题色板，内联。
  const appearance = doc.createElement('section');
  appearance.className = 'lightink-library-manage-group lightink-library-appearance';
  appearance.dataset.manageGroup = 'appearance';
  const appearanceTitle = doc.createElement('h2');
  appearanceTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const appearanceHint = doc.createElement('p');
  appearanceHint.className = 'lightink-library-appearance-hint';
  const themeSwatches = doc.createElement('div');
  themeSwatches.className = 'lightink-library-theme-swatches';
  themeSwatches.setAttribute('role', 'radiogroup');
  appearance.append(appearanceTitle, appearanceHint, themeSwatches);

  // 阅读偏好：阅读器进度条开关，内联。
  const readerPrefs = doc.createElement('section');
  readerPrefs.className = 'lightink-library-manage-group lightink-library-reader-prefs';
  readerPrefs.dataset.manageGroup = 'reading';
  const readerPrefsTitle = doc.createElement('h2');
  readerPrefsTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const readerPrefsHint = doc.createElement('p');
  readerPrefsHint.className = 'lightink-library-appearance-hint';
  const progressBarLabel = doc.createElement('label');
  progressBarLabel.className = 'lightink-library-reader-pref';
  const progressBarInput = doc.createElement('input');
  progressBarInput.type = 'checkbox';
  progressBarInput.name = 'showProgressBar';
  const progressBarText = doc.createElement('span');
  progressBarLabel.append(progressBarInput, progressBarText);
  // 阅读偏好：翻页动画样式（R1）——auto/slide/fade/curl/none，select 行。
  const pageTurnField = doc.createElement('label');
  pageTurnField.className = 'lightink-library-reader-pref lightink-library-page-turn-field';
  const pageTurnSelect = doc.createElement('select');
  pageTurnSelect.name = 'pageTurnStyle';
  const pageTurnOptions = new Map<ReaderPageTurnStyle, HTMLOptionElement>();
  for (const style of READER_PAGE_TURN_STYLES) {
    const option = doc.createElement('option');
    option.value = style;
    pageTurnOptions.set(style, option);
    pageTurnSelect.append(option);
  }
  pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
  const pageTurnText = doc.createElement('span');
  pageTurnField.append(pageTurnSelect, pageTurnText);
  const deeplHint = doc.createElement('p');
  deeplHint.className = 'lightink-library-appearance-hint lightink-library-deepl-hint';
  const deeplField = doc.createElement('label');
  deeplField.className = 'lightink-library-field lightink-library-deepl-field';
  const deeplLabelText = doc.createElement('span');
  const deeplInput = doc.createElement('input');
  deeplInput.type = 'password';
  deeplInput.name = 'deeplApiKey';
  deeplInput.autocomplete = 'off';
  deeplInput.spellcheck = false;
  deeplField.append(deeplLabelText, deeplInput);
  const deeplStatus = doc.createElement('p');
  deeplStatus.className = 'lightink-library-deepl-status';
  deeplStatus.setAttribute('aria-live', 'polite');
  const deeplActions = doc.createElement('div');
  deeplActions.className = 'lightink-library-deepl-actions';
  const deeplSave = button(doc, '', 'lightink-library-primary lightink-library-deepl-save');
  const deeplClear = button(doc, '', 'lightink-library-deepl-clear');
  deeplActions.append(deeplSave, deeplClear);
  readerPrefs.append(readerPrefsTitle, readerPrefsHint, progressBarLabel, pageTurnField);

  const translatePrefs = doc.createElement('section');
  translatePrefs.className = 'lightink-library-manage-group lightink-library-translate';
  translatePrefs.dataset.manageGroup = 'translate';
  const translateTitle = doc.createElement('h2');
  translateTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  translatePrefs.append(translateTitle, deeplHint, deeplField, deeplActions, deeplStatus);

  let deeplConfigured = false;
  let deeplConfiguredEpoch = 0;
  const syncDeeplStatus = (): void => {
    const l = labels();
    deeplStatus.textContent = deeplConfigured ? l.deeplConfigured : l.deeplUnconfigured;
    deeplStatus.dataset.deeplConfigured = deeplConfigured ? 'true' : 'false';
    deeplClear.hidden = !deeplConfigured;
    deeplClear.disabled = !deeplConfigured;
  };
  const refreshDeeplConfigured = async (): Promise<void> => {
    const epoch = ++deeplConfiguredEpoch;
    const next = await invokeDeepLConfigured();
    if (epoch !== deeplConfiguredEpoch) {
      return;
    }
    deeplConfigured = next;
    syncDeeplStatus();
  };

  // AI 分组(R2):唯一活动提供商——端点格式三选一(联动预填官方 base URL,
  // 可改)、base URL/模型/Key、allowHttp、测试连接(role=status 结果)、目标
  // 语言覆盖;保存/清除密钥后广播 lightink:reader-ai-configured。复用
  // translate 分组的布局类与 deepl 字段行样式。
  const aiGroup = doc.createElement('section');
  aiGroup.className = 'lightink-library-manage-group lightink-library-translate lightink-library-ai';
  aiGroup.dataset.manageGroup = 'ai';
  const aiTitle = doc.createElement('h2');
  aiTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const aiHint = doc.createElement('p');
  aiHint.className = 'lightink-library-appearance-hint lightink-library-ai-hint';

  const aiEndpointField = doc.createElement('label');
  aiEndpointField.className = 'lightink-library-reader-pref lightink-library-ai-endpoint-field';
  const aiEndpointSelect = doc.createElement('select');
  aiEndpointSelect.name = 'aiEndpointKind';
  const aiEndpointOptions = new Map<AiEndpointKindId, HTMLOptionElement>();
  for (const kind of AI_ENDPOINT_KINDS) {
    const option = doc.createElement('option');
    option.value = kind;
    aiEndpointOptions.set(kind, option);
    aiEndpointSelect.append(option);
  }
  const aiEndpointText = doc.createElement('span');
  aiEndpointField.append(aiEndpointSelect, aiEndpointText);

  const aiBaseField = doc.createElement('label');
  aiBaseField.className = 'lightink-library-field lightink-library-ai-base-field';
  const aiBaseLabelText = doc.createElement('span');
  const aiBaseUrlInput = doc.createElement('input');
  aiBaseUrlInput.type = 'url';
  aiBaseUrlInput.name = 'aiBaseUrl';
  aiBaseUrlInput.autocomplete = 'off';
  aiBaseUrlInput.spellcheck = false;
  aiBaseField.append(aiBaseLabelText, aiBaseUrlInput);

  const aiModelField = doc.createElement('label');
  aiModelField.className = 'lightink-library-field lightink-library-ai-model-field';
  const aiModelLabelText = doc.createElement('span');
  const aiModelInput = doc.createElement('input');
  aiModelInput.type = 'text';
  aiModelInput.name = 'aiModel';
  aiModelInput.autocomplete = 'off';
  aiModelInput.spellcheck = false;
  aiModelField.append(aiModelLabelText, aiModelInput);

  const aiKeyField = doc.createElement('label');
  aiKeyField.className = 'lightink-library-field lightink-library-ai-key-field';
  const aiKeyLabelText = doc.createElement('span');
  const aiKeyInput = doc.createElement('input');
  aiKeyInput.type = 'password';
  aiKeyInput.name = 'aiApiKey';
  aiKeyInput.autocomplete = 'off';
  aiKeyInput.spellcheck = false;
  aiKeyField.append(aiKeyLabelText, aiKeyInput);

  const aiAllowHttpLabel = doc.createElement('label');
  aiAllowHttpLabel.className = 'lightink-library-reader-pref lightink-library-ai-allow-http';
  const aiAllowHttpInput = doc.createElement('input');
  aiAllowHttpInput.type = 'checkbox';
  aiAllowHttpInput.name = 'aiAllowHttp';
  const aiAllowHttpText = doc.createElement('span');
  aiAllowHttpLabel.append(aiAllowHttpInput, aiAllowHttpText);

  const aiTargetLangField = doc.createElement('label');
  aiTargetLangField.className = 'lightink-library-reader-pref lightink-library-ai-target-lang-field';
  const aiTargetLangSelect = doc.createElement('select');
  aiTargetLangSelect.name = 'aiTargetLang';
  const aiTargetLangOptions = new Map<AiTargetLangValue, HTMLOptionElement>();
  for (const value of AI_TARGET_LANG_VALUES) {
    const option = doc.createElement('option');
    option.value = value;
    aiTargetLangOptions.set(value, option);
    aiTargetLangSelect.append(option);
  }
  const aiTargetLangText = doc.createElement('span');
  aiTargetLangField.append(aiTargetLangSelect, aiTargetLangText);

  const aiActions = doc.createElement('div');
  aiActions.className = 'lightink-library-deepl-actions lightink-library-ai-actions';
  const aiSave = button(doc, '', 'lightink-library-primary lightink-library-ai-save');
  const aiTest = button(doc, '', 'lightink-library-ai-test');
  const aiKeySave = button(doc, '', 'lightink-library-ai-key-save');
  const aiKeyClear = button(doc, '', 'lightink-library-ai-key-clear');
  aiActions.append(aiSave, aiTest, aiKeySave, aiKeyClear);

  // 动作反馈(保存拒绝/密钥/测试连接):role=status,空时隐藏。
  const aiFeedback = doc.createElement('p');
  aiFeedback.className = 'lightink-library-deepl-status lightink-library-ai-feedback';
  aiFeedback.setAttribute('role', 'status');
  aiFeedback.hidden = true;
  // 配置状态行(已配置/缺口),与 deepl 状态行同型。
  const aiStatus = doc.createElement('p');
  aiStatus.className = 'lightink-library-deepl-status lightink-library-ai-status';
  aiStatus.setAttribute('aria-live', 'polite');
  aiGroup.append(
    aiTitle,
    aiHint,
    aiEndpointField,
    aiBaseField,
    aiModelField,
    aiKeyField,
    aiAllowHttpLabel,
    aiTargetLangField,
    aiActions,
    aiFeedback,
    aiStatus,
  );

  let aiStatusState = fallbackAiConfigStatus();
  let aiEndpointKind: AiEndpointKindId = aiStatusState.endpointKind;
  const aiDefaultsByKind = new Map<AiEndpointKindId, string>();
  let aiConfigEpoch = 0;
  let aiTestBusy = false;
  // 未保存的手工编辑标记:语言切换触发 retranslate → refreshAiConfig 回填时,
  // 不得用已保存值静默覆写用户正在编辑(且未聚焦)的 base URL/模型输入。
  let aiBaseDirty = false;
  let aiModelDirty = false;
  aiBaseUrlInput.addEventListener('input', () => {
    aiBaseDirty = true;
  });
  aiModelInput.addEventListener('input', () => {
    aiModelDirty = true;
  });

  const readAiEndpointKind = (): AiEndpointKindId =>
    isAiEndpointKind(aiEndpointSelect.value) ? aiEndpointSelect.value : 'openai-chat';

  const syncAiState = (): void => {
    const l = labels();
    const summary = aiMissingSummary(l, aiStatusState.missing);
    aiStatus.textContent = aiStatusState.configured
      ? l.aiConfigured
      : summary === ''
        ? l.aiUnconfigured
        : l.aiUnconfiguredGaps.replace('{missing}', summary);
    aiStatus.dataset.aiConfigured = aiStatusState.configured ? 'true' : 'false';
    aiKeyClear.hidden = !aiStatusState.hasKey;
    aiKeyClear.disabled = !aiStatusState.hasKey;
  };

  const setAiFeedback = (text: string, kind: 'info' | 'success' | 'error'): void => {
    aiFeedback.textContent = text;
    aiFeedback.hidden = text === '';
    aiFeedback.dataset.kind = kind;
  };

  const applyAiStatus = (status: AiConfigStatusView, fromSave = false): void => {
    aiStatusState = status;
    aiEndpointKind = isAiEndpointKind(status.endpointKind) ? status.endpointKind : 'openai-chat';
    for (const entry of status.defaults) {
      aiDefaultsByKind.set(entry.endpointKind, entry.baseUrl);
    }
    aiEndpointSelect.value = aiEndpointKind;
    if (fromSave) {
      aiBaseDirty = false;
      aiModelDirty = false;
    }
    if (fromSave || (!aiBaseDirty && doc.activeElement !== aiBaseUrlInput)) {
      aiBaseUrlInput.value = status.baseUrl;
    }
    if (fromSave || (!aiModelDirty && doc.activeElement !== aiModelInput)) {
      aiModelInput.value = status.model;
    }
    aiAllowHttpInput.checked = status.allowHttp;
    aiTargetLangSelect.value = AI_TARGET_LANG_VALUES.includes(
      status.targetLang as AiTargetLangValue,
    )
      ? (status.targetLang as AiTargetLangValue)
      : 'auto';
    syncAiState();
  };

  const refreshAiConfig = async (): Promise<void> => {
    const epoch = ++aiConfigEpoch;
    try {
      const status = await invokeAiGetConfig();
      if (epoch !== aiConfigEpoch) return;
      applyAiStatus(status);
    } catch {
      // 浏览器预览等无后端环境:保持本地默认形态。
      if (epoch !== aiConfigEpoch) return;
      applyAiStatus(fallbackAiConfigStatus());
    }
  };

  // 首帧即按默认形态预填(openai-chat + 官方 base URL),避免异步读取期间空表单。
  applyAiStatus(fallbackAiConfigStatus());

  // 端点格式切换:base URL 仍为旧格式官方默认(或空)时联动预填新格式默认;
  // 用户改过自定义地址则不动。
  aiEndpointSelect.addEventListener('change', () => {
    const next = readAiEndpointKind();
    const previousDefault = aiDefaultsByKind.get(aiEndpointKind);
    const current = aiBaseUrlInput.value.trim();
    if (current === '' || (previousDefault !== undefined && current === previousDefault)) {
      const nextDefault = aiDefaultsByKind.get(next);
      if (nextDefault !== undefined) {
        aiBaseUrlInput.value = nextDefault;
      }
    }
    aiEndpointKind = next;
  });

  const saveAiConfig = async (): Promise<void> => {
    aiSave.disabled = true;
    try {
      const status = await invokeAiSaveConfig({
        endpointKind: readAiEndpointKind(),
        baseUrl: aiBaseUrlInput.value.trim(),
        model: aiModelInput.value.trim(),
        allowHttp: aiAllowHttpInput.checked,
        targetLang: aiTargetLangSelect.value === 'auto' ? undefined : aiTargetLangSelect.value,
      });
      applyAiStatus(status, true);
      setAiFeedback(labels().aiSaved, 'success');
      dispatchAiConfigured({ configured: status.configured, missing: status.missing }, doc);
    } catch (error) {
      setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
    } finally {
      aiSave.disabled = false;
    }
  };
  aiSave.addEventListener('click', () => {
    void saveAiConfig();
  });

  aiKeySave.addEventListener('click', () => {
    const key = aiKeyInput.value.trim();
    if (key === '') {
      return;
    }
    void (async () => {
      aiKeySave.disabled = true;
      try {
        const status = await invokeAiStoreKey(key);
        aiKeyInput.value = '';
        applyAiStatus(status, true);
        setAiFeedback(labels().aiKeySaved, 'success');
        dispatchAiConfigured({ configured: status.configured, missing: status.missing }, doc);
      } catch (error) {
        setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
      } finally {
        aiKeySave.disabled = false;
      }
    })();
  });
  aiKeyClear.addEventListener('click', () => {
    void (async () => {
      aiKeyClear.disabled = true;
      try {
        const status = await invokeAiForgetKey();
        aiKeyInput.value = '';
        applyAiStatus(status, true);
        setAiFeedback(labels().aiKeyCleared, 'info');
        dispatchAiConfigured({ configured: status.configured, missing: status.missing }, doc);
      } catch (error) {
        setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
      } finally {
        aiKeyClear.disabled = false;
        syncAiState();
      }
    })();
  });

  aiTest.addEventListener('click', () => {
    void (async () => {
      aiTestBusy = true;
      aiTest.disabled = true;
      aiTest.textContent = labels().aiTesting;
      setAiFeedback(labels().aiTesting, 'info');
      try {
        const result = await invokeAiTestConnection();
        setAiFeedback(labels().aiTestOk.replace('{ms}', String(result.latencyMs)), 'success');
      } catch (error) {
        setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
      } finally {
        aiTestBusy = false;
        aiTest.disabled = false;
        aiTest.textContent = labels().aiTest;
      }
    })();
  });

  // 存储与缓存：用量摘要 + 清理缓存 + 缓存上限（弹层入口）。
  const storage = doc.createElement('section');
  storage.className = 'lightink-library-manage-group';
  storage.dataset.manageGroup = 'storage';
  const storageTitle = doc.createElement('h2');
  storageTitle.className = 'lightink-library-manage-group-title';
  const cacheSummary = doc.createElement('div');
  cacheSummary.className = 'lightink-library-cache-summary';
  cacheSummary.hidden = true;
  const cacheUsage = doc.createElement('span');
  cacheSummary.append(cacheUsage);
  const clearCacheButton = button(doc, '', 'lightink-library-manage-row');
  const cacheLimitButton = button(
    doc,
    '',
    'lightink-library-manage-row lightink-library-cache-limit-entry',
  );
  storage.append(storageTitle, cacheSummary, clearCacheButton, cacheLimitButton);

  // 同步：WebDAV 同步入口（deps 缺省时整组抑制）。
  let sync: HTMLElement | null = null;
  let syncButton: HTMLButtonElement | null = null;
  let syncTitle: HTMLHeadingElement | null = null;
  if (options.onOpenSyncPanel !== undefined) {
    sync = doc.createElement('section');
    sync.className = 'lightink-library-manage-group';
    sync.dataset.manageGroup = 'sync';
    syncTitle = doc.createElement('h2');
    syncTitle.className = 'lightink-library-manage-group-title';
    syncButton = button(doc, '', 'lightink-library-manage-row lightink-library-sync-entry');
    sync.append(syncTitle, syncButton);
  }

  // 其他：导入本地书籍 + 编辑器入口（仅桌面，deps 缺省抑制）。
  const other = doc.createElement('section');
  other.className = 'lightink-library-manage-group';
  other.dataset.manageGroup = 'other';
  const otherTitle = doc.createElement('h2');
  otherTitle.className = 'lightink-library-manage-group-title';
  const importButton = button(doc, '', 'lightink-library-manage-row lightink-library-import-entry');
  other.append(otherTitle, importButton);
  let editorButton: HTMLButtonElement | null = null;
  if (options.onEnterEditor !== undefined) {
    editorButton = button(doc, '', 'lightink-library-manage-row lightink-library-editor-entry');
    other.append(editorButton);
  }

  home.append(
    appearance,
    readerPrefs,
    translatePrefs,
    aiGroup,
    storage,
    ...(sync === null ? [] : [sync]),
    other,
  );
  element.append(home);

  const cacheLimitOverlay = doc.createElement('div');
  cacheLimitOverlay.className = 'lightink-modal-overlay lightink-library-cache-limit-modal';
  cacheLimitOverlay.hidden = true;
  const cacheLimitDialog = doc.createElement('div');
  cacheLimitDialog.className = 'lightink-modal-dialog';
  cacheLimitDialog.setAttribute('role', 'dialog');
  cacheLimitDialog.setAttribute('aria-modal', 'true');
  cacheLimitDialog.setAttribute('aria-labelledby', 'lightink-library-cache-limit-title');
  const cacheLimitTitle = doc.createElement('h2');
  cacheLimitTitle.id = 'lightink-library-cache-limit-title';
  cacheLimitTitle.className = 'lightink-library-cache-limit-title';
  const cacheLimitForm = doc.createElement('form');
  cacheLimitForm.className = 'lightink-library-cache-limit-form';
  const cacheLimitLabel = doc.createElement('label');
  cacheLimitLabel.className = 'lightink-library-field';
  const cacheLimitLabelText = doc.createElement('span');
  const cacheLimitInput = doc.createElement('input');
  cacheLimitInput.type = 'number';
  cacheLimitInput.name = 'cacheLimitGiB';
  cacheLimitInput.min = '0.25';
  cacheLimitInput.max = '1024';
  cacheLimitInput.step = '0.25';
  cacheLimitInput.required = true;
  cacheLimitLabel.append(cacheLimitLabelText, cacheLimitInput);
  const cacheLimitActions = doc.createElement('div');
  cacheLimitActions.className = 'lightink-library-cache-limit-actions';
  const cacheLimitSave = button(doc, '', 'lightink-library-primary');
  cacheLimitSave.type = 'submit';
  const cacheLimitCancel = button(doc, '', 'lightink-library-cache-limit-cancel');
  cacheLimitActions.append(cacheLimitSave, cacheLimitCancel);
  cacheLimitForm.append(cacheLimitLabel, cacheLimitActions);
  cacheLimitDialog.append(cacheLimitTitle, cacheLimitForm);
  cacheLimitOverlay.append(cacheLimitDialog);
  applyCacheLimitDialogHeightCap(cacheLimitOverlay, cacheLimitDialog);

  let ignoreCacheBackdrop = true;

  function setSubpage(next: ManageSubpage): void {
    subpage = next;
    element.dataset.managePage = next;
    cacheLimitOverlay.hidden = next === 'home';
    if (next === 'cache-limit') {
      ignoreCacheBackdrop = true;
      mountLibraryOverlay(cacheLimitOverlay, options.themeRoot);
      cacheLimitInput.focus();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ignoreCacheBackdrop = false;
        });
      });
    }
  }

  function renderThemeSwatches(): void {
    themeSwatches.replaceChildren();
    themeSwatches.setAttribute('aria-label', labels().libraryTheme);
    for (const theme of LIBRARY_THEMES) {
      const swatch = button(doc, '', 'lightink-library-theme-swatch');
      swatch.dataset.libraryTheme = theme.id;
      const preview = doc.createElement('span');
      preview.className = 'lightink-library-theme-preview';
      preview.style.backgroundColor = theme.page;
      preview.style.borderColor = theme.border;
      const accent = doc.createElement('i');
      accent.style.backgroundColor = theme.accent;
      preview.append(accent);
      const name = doc.createElement('span');
      name.className = 'lightink-library-theme-swatch-name';
      name.textContent = options.themeLabel(theme.id);
      swatch.append(preview, name);
      swatch.title = name.textContent ?? '';
      swatch.setAttribute('aria-label', name.textContent ?? '');
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(theme.id === currentLibraryTheme));
      swatch.classList.toggle('is-active', theme.id === currentLibraryTheme);
      swatch.addEventListener('click', () => {
        currentLibraryTheme = saveLibraryTheme(options.themeStorage, theme.id);
        applyLibraryTheme(options.themeRoot, currentLibraryTheme);
        renderThemeSwatches();
        doc.dispatchEvent(
          new CustomEvent('lightink:library-theme', { detail: currentLibraryTheme }),
        );
      });
      themeSwatches.append(swatch);
    }
  }

  const syncReaderPrefsFromStorage = (): void => {
    currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    progressBarInput.checked = currentReaderPrefs.showProgressBar;
    pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
  };

  // 保存任一偏好都携带完整 ReaderPrefs（缺省字段会被规范化回默认值）。
  const commitReaderPrefs = (): void => {
    currentReaderPrefs = saveReaderPrefs(options.readerPrefsStorage, {
      showProgressBar: progressBarInput.checked,
      pageTurnStyle: (pageTurnSelect.value as ReaderPageTurnStyle) ?? 'auto',
    });
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
    doc.dispatchEvent(new CustomEvent('lightink:reader-prefs', { detail: currentReaderPrefs }));
  };

  const onReaderPrefsStorage = (event: Event): void => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== READER_PREFS_STORAGE_KEY) {
      return;
    }
    syncReaderPrefsFromStorage();
  };
  const prefsTarget: Document | Window = doc.defaultView ?? doc;
  prefsTarget.addEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);

  progressBarInput.addEventListener('change', () => {
    commitReaderPrefs();
  });

  // 即时生效：播放函数每次翻页读偏好内存缓存（applyReaderPrefs 刷新），
  // 切换样式后下一次翻页即按新样式播放，无需重开书。
  pageTurnSelect.addEventListener('change', () => {
    commitReaderPrefs();
  });

  deeplSave.addEventListener('click', () => {
    const key = deeplInput.value.trim();
    if (key === '') {
      return;
    }
    void (async () => {
      try {
        await invokeDeepLStoreKey(key);
        deeplInput.value = '';
        deeplConfiguredEpoch += 1;
        deeplConfigured = true;
        syncDeeplStatus();
        dispatchDeeplConfigured(true, doc);
      } catch (error) {
        options.notify(options.formatError(error), 'error');
      }
    })();
  });
  deeplClear.addEventListener('click', () => {
    void (async () => {
      try {
        await invokeDeepLForgetKey();
        deeplInput.value = '';
        deeplConfiguredEpoch += 1;
        deeplConfigured = false;
        syncDeeplStatus();
        dispatchDeeplConfigured(false, doc);
      } catch (error) {
        options.notify(options.formatError(error), 'error');
      }
    })();
  });

  importButton.addEventListener('click', () => {
    void options.onImport();
  });
  editorButton?.addEventListener('click', () => options.onEnterEditor?.());
  syncButton?.addEventListener('click', () => options.onOpenSyncPanel?.());

  clearCacheButton.addEventListener('click', async () => {
    try {
      await options.library.clearCache();
      await view.refreshCache();
    } catch (error) {
      options.notify(options.formatError(error), 'error');
    }
  });

  cacheLimitButton.addEventListener('click', () => {
    setSubpage('cache-limit');
  });
  cacheLimitCancel.addEventListener('click', () => {
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('click', (event) => {
    if (ignoreCacheBackdrop || event.target !== cacheLimitOverlay) return;
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const gibibytes = cacheLimitInput.valueAsNumber;
    if (!Number.isFinite(gibibytes) || gibibytes <= 0) return;
    try {
      await options.library.setCacheLimit(Math.round(gibibytes * 1024 ** 3));
      setSubpage('home');
      await view.refreshCache();
      cacheLimitButton.focus();
    } catch (error) {
      options.notify(options.formatError(error), 'error');
    }
  });

  function retranslate(): void {
    const l = labels();
    appearanceTitle.textContent = l.appearance;
    appearanceHint.textContent = l.libraryThemeHint;
    readerPrefsTitle.textContent = l.readingGroup;
    readerPrefsHint.textContent = l.readerPrefsHint;
    progressBarText.textContent = l.showProgressBar;
    progressBarLabel.title = l.showProgressBar;
    pageTurnText.textContent = l.pageTurnStyle;
    pageTurnField.title = l.pageTurnStyle;
    pageTurnSelect.setAttribute('aria-label', l.pageTurnStyle);
    const optionLabels: Record<ReaderPageTurnStyle, string> = {
      auto: l.pageTurnStyleAuto,
      slide: l.pageTurnStyleSlide,
      fade: l.pageTurnStyleFade,
      curl: l.pageTurnStyleCurl,
      none: l.pageTurnStyleNone,
    };
    for (const [style, option] of pageTurnOptions) {
      option.textContent = optionLabels[style];
    }
    translateTitle.textContent = l.translateGroup;
    deeplHint.textContent = l.deeplHint;
    deeplLabelText.textContent = l.deeplKey;
    deeplInput.placeholder = l.deeplKey;
    deeplSave.textContent = l.deeplSave;
    deeplClear.textContent = l.deeplClear;
    syncDeeplStatus();
    void refreshDeeplConfigured();
    aiTitle.textContent = l.aiGroup;
    aiHint.textContent = l.aiHint;
    aiEndpointText.textContent = l.aiEndpointKind;
    aiEndpointField.title = l.aiEndpointKind;
    aiEndpointSelect.setAttribute('aria-label', l.aiEndpointKind);
    const aiEndpointLabels: Record<AiEndpointKindId, string> = {
      'openai-responses': l.aiEndpointOpenaiResponses,
      'openai-chat': l.aiEndpointOpenaiChat,
      'claude-messages': l.aiEndpointClaudeMessages,
    };
    for (const [kind, option] of aiEndpointOptions) {
      option.textContent = aiEndpointLabels[kind];
    }
    aiBaseLabelText.textContent = l.aiBaseUrl;
    aiBaseUrlInput.placeholder = l.aiBaseUrl;
    aiModelLabelText.textContent = l.aiModel;
    aiModelInput.placeholder = l.aiModel;
    aiKeyLabelText.textContent = l.aiKey;
    aiKeyInput.placeholder = l.aiKey;
    aiAllowHttpText.textContent = l.aiAllowHttp;
    aiAllowHttpLabel.title = l.aiAllowHttp;
    aiTargetLangText.textContent = l.aiTargetLang;
    aiTargetLangField.title = l.aiTargetLang;
    aiTargetLangSelect.setAttribute('aria-label', l.aiTargetLang);
    for (const [value, option] of aiTargetLangOptions) {
      option.textContent = aiTargetLangLabel(value, l);
    }
    aiSave.textContent = l.aiSave;
    aiTest.textContent = aiTestBusy ? l.aiTesting : l.aiTest;
    aiKeySave.textContent = l.aiKeySave;
    aiKeyClear.textContent = l.aiKeyClear;
    syncAiState();
    void refreshAiConfig();
    storageTitle.textContent = l.storageGroup;
    clearCacheButton.textContent = l.clearCache;
    cacheLimitButton.textContent = l.changeCacheLimit;
    cacheLimitButton.title = l.changeCacheLimit;
    cacheLimitButton.setAttribute('aria-label', l.changeCacheLimit);
    if (syncTitle !== null) syncTitle.textContent = l.syncGroup;
    if (syncButton !== null) {
      syncButton.textContent = l.webdavSync;
      syncButton.title = l.webdavSync;
      syncButton.setAttribute('aria-label', l.webdavSync);
    }
    otherTitle.textContent = l.otherGroup;
    importButton.textContent = l.importLocal;
    if (editorButton !== null) {
      editorButton.textContent = l.markdownEditor;
      editorButton.title = l.markdownEditor;
      editorButton.setAttribute('aria-label', l.markdownEditor);
    }
    cacheLimitTitle.textContent = l.changeCacheLimit;
    cacheLimitLabelText.textContent = l.cacheLimit;
    cacheLimitSave.textContent = l.apply;
    cacheLimitCancel.textContent = l.cancel;
    renderThemeSwatches();
    syncReaderPrefsFromStorage();
  }

  const view: LibraryManageView = {
    element,
    showHome(): void {
      setSubpage('home');
    },
    handleEscape(): boolean {
      if (subpage === 'home') return false;
      setSubpage('home');
      cacheLimitButton.focus();
      return true;
    },
    async refreshCache(): Promise<void> {
      try {
        const cache = await options.library.cacheStats();
        cacheUsage.textContent = labels()
          .cacheUsage.replace('{used}', bytesLabel(cache.bytesCached))
          .replace('{limit}', bytesLabel(cache.limitBytes));
        if (doc.activeElement !== cacheLimitInput) {
          cacheLimitInput.value = String(cache.limitBytes / 1024 ** 3);
        }
      } catch {
        // 浏览器预览无 cacheStats：隐藏空用量盒，避免盖住「存储与缓存」。
        cacheUsage.textContent = '';
      }
      cacheSummary.hidden = cacheUsage.textContent.trim() === '';
    },
    retranslate,
    destroy(): void {
      prefsTarget.removeEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);
      cacheLimitOverlay.remove();
      element.remove();
    },
  };

  retranslate();
  return view;
}
