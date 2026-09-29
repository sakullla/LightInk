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
import type { ConcealBossKeysStatus } from '../conceal/conceal-client.js';
import {
  applyConcealScene,
  CONCEAL_GRADIENT_PRESETS,
  CONCEAL_SCENE_CHOICES,
  concealSceneOf,
  isSameHotkeyCombo,
  isValidConcealColor,
  isValidHotkeyCombo,
  type ConcealGradientPreset,
  type ConcealPrefs,
  type ConcealScene,
  type ConcealSceneChoice,
} from '../conceal/conceal-prefs.js';
import {
  AI_TARGET_LANG_VALUES,
  type AiTargetLangValue,
} from '../reader/ai-target-lang.js';
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

export { AI_TARGET_LANG_VALUES };
export type { AiTargetLangValue };
export type { ConcealBossKeysStatus } from '../conceal/conceal-client.js';

export type ManageSubpage = 'home' | 'cache-limit';

/** 摸鱼段（R2/R5–R10/R13）的显示文案（main.ts 以 i18n 装配）。 */
export interface ConcealManageLabels {
  readonly group: string;
  readonly groupHint: string;
  readonly bossKeyHint: string;
  readonly macBossKeyHint: string;
  readonly bossKey1: string;
  readonly bossKey2: string;
  readonly bossKeyActive: string;
  readonly bossKeyEmpty: string;
  readonly bossKeyInvalid: string;
  readonly bossKeySame: string;
  readonly bossKeyUnregistered: string;
  readonly background: string;
  readonly backgroundTheme: string;
  readonly backgroundPresets: Readonly<Record<ConcealGradientPreset, string>>;
  readonly backgroundCustom: string;
  readonly customFrom: string;
  readonly customTo: string;
  readonly transparentMode: string;
  readonly contentOpacity: string;
  readonly hideTop: string;
  readonly hideBody: string;
  readonly hideBottom: string;
  readonly alwaysOnTop: string;
  readonly miniWindow: string;
  readonly clickThrough: string;
  readonly clickThroughHint: string;
  readonly sceneNormal: string;
  readonly sceneHideOnLeave: string;
  readonly sceneFloating: string;
  readonly sceneCustom: string;
  readonly groupDodge: string;
  readonly groupDisguise: string;
  readonly groupFloat: string;
  readonly groupExit: string;
  readonly exitHint: string;
  readonly needsTransparent: string;
  readonly gradientHidden: string;
  readonly opacityScale: string;
  readonly recordCombo: string;
}

/** 置顶、迷你窗口、透明、穿透被拒绝时，原因留在会话里并贴在该开关旁。 */
export type ConcealSwitchRefusalKey =
  | 'transparentMode'
  | 'alwaysOnTop'
  | 'miniWindow'
  | 'clickThrough';

/** 摸鱼段与 conceal-controller 的接线（注入式，Vitest 可 fake）。 */
export interface ConcealManageDeps {
  readonly labels: () => ConcealManageLabels;
  /** macOS 平台（决定是否展示 Ctrl 默认值说明）。 */
  readonly isMac: boolean;
  /** 当前生效偏好（命令失败的开关已内存回退，回显以它为准）。 */
  readonly getPrefs: () => ConcealPrefs;
  /** 非键位改动：合并→校验→持久化→即时生效（R10）。 */
  readonly update: (update: Partial<ConcealPrefs>) => void;
  /** R2 改键注册（返回注册结果与失败原因）。 */
  readonly updateBossKeys: (primary: string, secondary: string) => Promise<ConcealBossKeysStatus>;
  /**
   * 订阅当前会话的窗口开关拒绝。返回解除订阅。
   * 订阅时可以立刻重放尚未清除的原因（设置页晚于失败创建）。
   */
  readonly subscribeSwitchRefusal?: (
    listener: (key: ConcealSwitchRefusalKey, reason: string) => void,
  ) => () => void;
  /** 用户再次拨动该开关或改场景时清掉会话原因，避免成功后仍贴着旧拒绝。 */
  readonly clearSwitchRefusal?: (key: ConcealSwitchRefusalKey) => void;
}

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
  readonly aiGroup: string;
  readonly aiHint: string;
  readonly aiEndpointKind: string;
  readonly aiEndpointOpenaiResponses: string;
  readonly aiEndpointOpenaiChat: string;
  readonly aiEndpointClaudeMessages: string;
  readonly aiBaseUrl: string;
  readonly aiModel: string;
  readonly aiKey: string;
  readonly aiKeyClear: string;
  readonly aiKeySavedPlaceholder: string;
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
  /** 摸鱼段（R12：仅桌面注入；缺省整段不渲染）。 */
  readonly conceal?: ConcealManageDeps;
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

/**
 * 设置分组默认折叠（分组多、内容长，AI/摸鱼等大区块尤甚）：标题即开关
 * （role=button + aria-expanded，与分组树同口径的双状态标记）。不持久化
 * 展开态——每次打开设置一律从全折叠开始，会话内的展开由 DOM 自身保持。
 */
function setupManageGroupCollapsing(home: HTMLElement): void {
  for (const group of home.querySelectorAll<HTMLElement>('.lightink-library-manage-group')) {
    const title = group.querySelector<HTMLElement>(':scope > h2');
    if (title === null) {
      continue;
    }
    const apply = (open: boolean): void => {
      if (open) {
        delete group.dataset.collapsed;
      } else {
        group.dataset.collapsed = 'true';
      }
      title.setAttribute('aria-expanded', String(open));
    };
    apply(false);
    const toggle = (): void => {
      apply(group.dataset.collapsed === 'true');
    };
    title.classList.add('lightink-library-manage-group-toggle');
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }
}


const CONCEAL_REFUSAL_KEYS = [
  'transparentMode',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const satisfies readonly ConcealSwitchRefusalKey[];

const CONCEAL_TOGGLE_KEYS = [
  'transparentMode',
  'hideTop',
  'hideBody',
  'hideBottom',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const;

type ConcealToggleKey = (typeof CONCEAL_TOGGLE_KEYS)[number];

const CONCEAL_BACKGROUND_VALUES = [
  'theme',
  'lavender',
  'mint',
  'peach',
  'sky',
  'butter',
  'custom',
] as const;

type ConcealBackgroundValue = (typeof CONCEAL_BACKGROUND_VALUES)[number];

function isConcealRefusalKey(key: string): key is ConcealSwitchRefusalKey {
  return (CONCEAL_REFUSAL_KEYS as readonly string[]).includes(key);
}

/** 空组合、纯修饰键、或与另一键相同：不注册。返回字段旁的原因；可提交则 null。 */
function concealHotkeyRejectReason(
  combo: string,
  other: string,
  texts: { readonly empty: string; readonly invalid: string; readonly same: string },
): string | null {
  if (combo.trim() === '') {
    return texts.empty;
  }
  if (!isValidHotkeyCombo(combo)) {
    return texts.invalid;
  }
  if (isSameHotkeyCombo(combo, other)) {
    return texts.same;
  }
  return null;
}

interface ConcealKeyField {
  readonly prefKey: 'bossPrimary' | 'bossSecondary';
  readonly input: HTMLInputElement;
  readonly status: HTMLParagraphElement;
  attemptReason: string | null;
  statusBeforeRecord: string;
}

interface ConcealSectionController {
  readonly section: HTMLElement;
  retranslate(): void;
  destroy(): void;
}

/**
 * 书架摸鱼设置。外层仍是一个可折叠分组（折叠只留 h2），所以场景名和老板键
 * 写在标题上。三个分组只重新收纳现有控件；退出快捷键单独成组。
 */
function mountConcealSection(doc: Document, deps: ConcealManageDeps): ConcealSectionController {
  const section = doc.createElement('section');
  section.className = 'lightink-library-manage-group lightink-library-conceal';
  section.dataset.manageGroup = 'conceal';

  const texts = {
    group: '',
    groupHint: '',
    bossKeyHint: '',
    macBossKeyHint: '',
    bossKey1: '',
    bossKey2: '',
    bossKeyActive: '',
    bossKeyEmpty: '',
    bossKeyInvalid: '',
    bossKeySame: '',
    bossKeyUnregistered: '',
    recordCombo: '',
    background: '',
    backgroundLabels: {
      theme: '',
      lavender: '',
      mint: '',
      peach: '',
      sky: '',
      butter: '',
      custom: '',
    } as Record<ConcealBackgroundValue, string>,
    customFrom: '',
    customTo: '',
    contentOpacity: '',
    opacityScale: '',
    needsTransparent: '',
    gradientHidden: '',
    clickThroughHint: '',
    exitHint: '',
    scenes: {
      normal: '',
      hideOnLeave: '',
      floating: '',
      custom: '',
    } as Record<ConcealScene, string>,
    groups: {
      dodge: '',
      disguise: '',
      float: '',
      exit: '',
    },
    toggles: {
      transparentMode: '',
      hideTop: '',
      hideBody: '',
      hideBottom: '',
      alwaysOnTop: '',
      miniWindow: '',
      clickThrough: '',
    } as Record<ConcealToggleKey, string>,
  };

  const title = doc.createElement('h2');
  title.className = 'lightink-library-manage-group-title';
  const hint = doc.createElement('p');
  hint.className = 'lightink-library-appearance-hint';

  const scenes = doc.createElement('div');
  scenes.className = 'lightink-library-conceal-scenes';
  scenes.setAttribute('role', 'radiogroup');
  const sceneButtons = new Map<ConcealSceneChoice, HTMLButtonElement>();
  for (const choice of CONCEAL_SCENE_CHOICES) {
    const sceneButton = button(doc, '', 'lightink-library-conceal-scene');
    sceneButton.dataset.concealScene = choice;
    sceneButton.setAttribute('role', 'radio');
    sceneButton.addEventListener('click', () => {
      for (const key of CONCEAL_REFUSAL_KEYS) {
        refusals.delete(key);
        deps.clearSwitchRefusal?.(key);
      }
      deps.update(applyConcealScene(deps.getPrefs(), choice));
      render();
    });
    sceneButtons.set(choice, sceneButton);
    scenes.append(sceneButton);
  }
  const customScene = doc.createElement('span');
  customScene.className = 'lightink-library-conceal-scene is-readonly';
  customScene.dataset.concealScene = 'custom';
  scenes.append(customScene);

  const subgroup = (id: 'dodge' | 'disguise' | 'float' | 'exit'): HTMLElement => {
    const group = doc.createElement('section');
    group.className = 'lightink-library-conceal-subgroup';
    group.dataset.concealGroup = id;
    const heading = doc.createElement('h3');
    heading.className = 'lightink-library-conceal-subgroup-title';
    group.append(heading);
    return group;
  };
  const dodge = subgroup('dodge');
  const disguise = subgroup('disguise');
  const floatGroup = subgroup('float');
  const exit = subgroup('exit');

  const bossHint = doc.createElement('p');
  bossHint.className = 'lightink-library-appearance-hint';
  const macHint = deps.isMac ? doc.createElement('p') : null;
  if (macHint !== null) {
    macHint.className = 'lightink-library-appearance-hint';
  }
  const exitHint = doc.createElement('p');
  exitHint.className = 'lightink-library-appearance-hint';
  exitHint.dataset.concealExitHint = 'true';

  /** keydown → accelerator 串（修饰键在前，顺序 Control/Shift/Alt/Meta）。 */
  const comboFromEvent = (event: KeyboardEvent): { combo: string; complete: boolean } => {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.altKey) modifiers.push('Alt');
    if (event.metaKey) modifiers.push('Meta');
    const key = event.key;
    const isMain =
      /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
      /^[a-zA-Z0-9]$/.test(key) ||
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'Tab', 'Enter', 'Space', 'Plus', 'Minus'].includes(
        key,
      );
    if (!isMain) {
      return { combo: modifiers.join('+'), complete: false };
    }
    const main = key === 'Space' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
    return { combo: [...modifiers, main].join('+'), complete: true };
  };

  const showKeyReason = (field: ConcealKeyField, reason: string): void => {
    field.attemptReason = reason;
    field.status.textContent = reason;
    field.status.classList.add('is-error');
    field.input.dataset.recording = 'false';
    field.input.value = deps.getPrefs()[field.prefKey];
  };

  const makeBossKeyField = (prefKey: 'bossPrimary' | 'bossSecondary'): ConcealKeyField => {
    const field = doc.createElement('label');
    field.className = 'lightink-library-conceal-key-field';
    const input = doc.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.dataset.concealKeyField = prefKey;
    input.dataset.recording = 'false';
    const status = doc.createElement('p');
    status.className = 'lightink-library-conceal-key-status';
    status.dataset.concealKeyStatus = prefKey;
    status.setAttribute('role', 'status');
    const state: ConcealKeyField = {
      prefKey,
      input,
      status,
      attemptReason: null,
      statusBeforeRecord: '',
    };
    input.addEventListener('focus', () => {
      if (input.dataset.recording !== 'true') {
        state.statusBeforeRecord = status.textContent ?? '';
      }
      input.dataset.recording = 'true';
      if (state.attemptReason === null) {
        status.textContent = texts.recordCombo;
        status.classList.remove('is-error');
      }
    });
    input.addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        input.dataset.recording = 'false';
        input.value = deps.getPrefs()[prefKey];
        if (state.attemptReason !== null) {
          status.textContent = state.attemptReason;
          status.classList.add('is-error');
        } else {
          status.textContent = state.statusBeforeRecord;
          status.classList.remove('is-error');
        }
        return;
      }
      const { combo, complete } = comboFromEvent(event);
      const other = deps.getPrefs()[prefKey === 'bossPrimary' ? 'bossSecondary' : 'bossPrimary'];
      if (!complete) {
        if (combo === '') {
          showKeyReason(state, texts.bossKeyEmpty);
          return;
        }
        // 只按修饰键：预览组合，并在字段旁说明原因，不注册。
        input.dataset.recording = 'true';
        input.value = combo;
        state.attemptReason = texts.bossKeyInvalid;
        status.textContent = state.attemptReason;
        status.classList.add('is-error');
        return;
      }
      const reason = concealHotkeyRejectReason(combo, other, {
        empty: texts.bossKeyEmpty,
        invalid: texts.bossKeyInvalid,
        same: texts.bossKeySame,
      });
      if (reason !== null) {
        showKeyReason(state, reason);
        return;
      }
      state.attemptReason = null;
      input.dataset.recording = 'false';
      void deps
        .updateBossKeys(
          prefKey === 'bossPrimary' ? combo : deps.getPrefs().bossPrimary,
          prefKey === 'bossSecondary' ? combo : deps.getPrefs().bossSecondary,
        )
        .then((result) => {
          state.attemptReason = null;
          render(result);
          state.statusBeforeRecord = status.textContent ?? '';
        });
    });
    input.addEventListener('blur', () => {
      const preview = input.value;
      const recording = input.dataset.recording === 'true';
      input.dataset.recording = 'false';
      const saved = deps.getPrefs()[prefKey];
      input.value = saved;
      if (recording && preview !== saved && !isValidHotkeyCombo(preview)) {
        state.attemptReason = preview.trim() === '' ? texts.bossKeyEmpty : texts.bossKeyInvalid;
      }
      if (state.attemptReason !== null) {
        status.textContent = state.attemptReason;
        status.classList.add('is-error');
        return;
      }
      status.textContent = state.statusBeforeRecord;
      status.classList.remove('is-error');
    });
    field.append(input, status);
    return state;
  };

  const primaryField = makeBossKeyField('bossPrimary');
  const secondaryField = makeBossKeyField('bossSecondary');

  const swatchRow = doc.createElement('div');
  swatchRow.className = 'lightink-library-conceal-swatches';
  const backgroundText = doc.createElement('span');
  backgroundText.className = 'lightink-library-conceal-field-label';
  const swatches = new Map<
    ConcealBackgroundValue,
    { readonly button: HTMLButtonElement; readonly chip: HTMLElement; readonly name: HTMLElement }
  >();
  for (const value of CONCEAL_BACKGROUND_VALUES) {
    const swatch = button(doc, '', 'lightink-library-conceal-swatch');
    swatch.dataset.concealBackground = value;
    const chip = doc.createElement('span');
    chip.className = 'lightink-library-conceal-swatch-chip';
    if (value === 'theme') {
      chip.classList.add('is-theme');
    }
    const name = doc.createElement('span');
    name.className = 'lightink-library-conceal-swatch-name';
    swatch.append(chip, name);
    swatch.addEventListener('click', () => {
      const prefs = deps.getPrefs();
      if (value === 'theme') {
        deps.update({ background: { kind: 'theme' } });
      } else if (value === 'custom') {
        deps.update({
          background: {
            kind: 'custom',
            from: prefs.background.kind === 'custom' ? prefs.background.from : '#c9b6e4',
            to: prefs.background.kind === 'custom' ? prefs.background.to : '#f1e9fb',
          },
        });
      } else {
        deps.update({ background: { kind: 'preset', preset: value } });
      }
      render();
    });
    swatches.set(value, { button: swatch, chip, name });
    swatchRow.append(swatch);
  }
  const gradientNote = doc.createElement('p');
  gradientNote.className = 'lightink-library-appearance-hint';
  gradientNote.dataset.concealGradientNote = 'true';

  const customRow = doc.createElement('div');
  customRow.className = 'lightink-library-conceal-custom-row';
  const customFromText = doc.createElement('span');
  const customFrom = doc.createElement('input');
  customFrom.type = 'color';
  customFrom.dataset.concealCustom = 'from';
  const customToText = doc.createElement('span');
  const customTo = doc.createElement('input');
  customTo.type = 'color';
  customTo.dataset.concealCustom = 'to';
  const customFromField = doc.createElement('label');
  customFromField.className = 'lightink-library-field';
  const customToField = doc.createElement('label');
  customToField.className = 'lightink-library-field';
  customFromField.append(customFromText, customFrom);
  customToField.append(customToText, customTo);
  customRow.append(customFromField, customToField);
  const commitCustomColors = (): void => {
    const from = customFrom.value;
    const to = customTo.value;
    if (!isValidConcealColor(from) || !isValidConcealColor(to)) {
      render();
      return;
    }
    deps.update({ background: { kind: 'custom', from, to } });
    render();
  };
  customFrom.addEventListener('change', commitCustomColors);
  customTo.addEventListener('change', commitCustomColors);

  const opacityField = doc.createElement('label');
  opacityField.className = 'lightink-library-conceal-opacity-field';
  const opacityText = doc.createElement('span');
  const opacityInput = doc.createElement('input');
  opacityInput.type = 'number';
  opacityInput.name = 'contentOpacity';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.dataset.concealOpacity = 'true';
  const opacityScale = doc.createElement('span');
  opacityScale.className = 'lightink-library-conceal-opacity-scale';
  opacityScale.dataset.concealOpacityScale = 'true';
  opacityField.append(opacityText, opacityInput, opacityScale);
  opacityInput.addEventListener('change', () => {
    const raw = opacityInput.value.trim();
    const saved = String(deps.getPrefs().contentOpacity);
    // 101、负数、空白、非整数都不保存，回到当前生效值。
    if (!/^\d+$/.test(raw)) {
      opacityInput.value = saved;
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      opacityInput.value = saved;
      return;
    }
    deps.update({ contentOpacity: value });
    render();
  });

  const refusals = new Map<ConcealSwitchRefusalKey, string>();
  const toggles = new Map<
    ConcealToggleKey,
    { readonly input: HTMLInputElement; readonly text: HTMLSpanElement; readonly reason: HTMLParagraphElement }
  >();
  for (const prefKey of CONCEAL_TOGGLE_KEYS) {
    const wrap = doc.createElement('div');
    wrap.className = 'lightink-library-conceal-switch';
    wrap.dataset.concealSwitch = prefKey;
    const label = doc.createElement('label');
    label.className = 'lightink-library-reader-pref';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.dataset.concealToggle = prefKey;
    const text = doc.createElement('span');
    const reason = doc.createElement('p');
    reason.className = 'lightink-library-conceal-switch-reason';
    reason.dataset.concealSwitchReason = prefKey;
    reason.hidden = true;
    label.append(input, text);
    wrap.append(label, reason);
    input.addEventListener('change', () => {
      if (input.disabled) {
        render();
        return;
      }
      const requested = input.checked;
      if (isConcealRefusalKey(prefKey)) {
        refusals.delete(prefKey);
        deps.clearSwitchRefusal?.(prefKey);
      }
      deps.update({ [prefKey]: requested } as Partial<ConcealPrefs>);
      if (
        requested &&
        isConcealRefusalKey(prefKey) &&
        deps.getPrefs()[prefKey] !== true &&
        !refusals.has(prefKey)
      ) {
        refusals.set(
          prefKey,
          texts.needsTransparent.includes('透明')
            ? '没有生效，开关保持关闭。'
            : 'This did not take effect. The switch stays off.',
        );
      }
      render();
    });
    toggles.set(prefKey, { input, text, reason });
  }
  const toggleWrap = (key: ConcealToggleKey): HTMLElement =>
    toggles.get(key)?.input.closest('.lightink-library-conceal-switch') ?? doc.createElement('div');

  dodge.append(
    bossHint,
    ...(macHint === null ? [] : [macHint]),
    primaryField.input.closest('.lightink-library-conceal-key-field') ?? primaryField.input,
  );
  disguise.append(
    backgroundText,
    swatchRow,
    gradientNote,
    customRow,
    toggleWrap('transparentMode'),
    opacityField,
    toggleWrap('hideTop'),
    toggleWrap('hideBody'),
    toggleWrap('hideBottom'),
  );
  floatGroup.append(
    toggleWrap('alwaysOnTop'),
    toggleWrap('miniWindow'),
    toggleWrap('clickThrough'),
  );
  exit.append(
    exitHint,
    secondaryField.input.closest('.lightink-library-conceal-key-field') ?? secondaryField.input,
  );
  section.append(title, hint, scenes, dodge, disguise, floatGroup, exit);

  const paintSwatch = (value: ConcealBackgroundValue, chip: HTMLElement, prefs: ConcealPrefs): void => {
    if (value === 'theme') {
      chip.style.background = '';
      return;
    }
    const colors =
      value === 'custom'
        ? prefs.background.kind === 'custom'
          ? { from: prefs.background.from, to: prefs.background.to }
          : { from: '#b9b9b9', to: '#f7f7f7' }
        : CONCEAL_GRADIENT_PRESETS[value];
    chip.style.background = `linear-gradient(180deg, ${colors.from} 0%, ${colors.to} 100%)`;
  };

  const keyFields = [primaryField, secondaryField];

  function render(registerResult?: ConcealBossKeysStatus): void {
    const prefs = deps.getPrefs();
    const scene = concealSceneOf(prefs);
    title.textContent = `${texts.group} · ${texts.scenes[scene]} · ${prefs.bossPrimary}`;
    for (const [choice, sceneButton] of sceneButtons) {
      const selected = scene === choice;
      sceneButton.setAttribute('aria-checked', String(selected));
      sceneButton.classList.toggle('is-active', selected);
    }
    customScene.classList.toggle('is-active', scene === 'custom');
    customScene.setAttribute('aria-current', scene === 'custom' ? 'true' : 'false');

    for (const field of keyFields) {
      if (registerResult !== undefined) {
        const error = field.prefKey === 'bossPrimary' ? registerResult.primaryError : registerResult.secondaryError;
        const combo = field.prefKey === 'bossPrimary' ? registerResult.primary : registerResult.secondary;
        field.attemptReason = null;
        field.status.classList.toggle('is-error', error !== null);
        field.status.textContent =
          error !== null
            ? error
            : combo !== null
              ? texts.bossKeyActive.replace('{combo}', combo)
              : texts.bossKeyUnregistered;
        field.statusBeforeRecord = field.status.textContent ?? '';
      }
      if (field.input.dataset.recording !== 'true') {
        field.input.value = prefs[field.prefKey];
      }
    }

    const selectedBackground: ConcealBackgroundValue =
      prefs.background.kind === 'theme'
        ? 'theme'
        : prefs.background.kind === 'preset'
          ? prefs.background.preset
          : 'custom';
    for (const [value, swatch] of swatches) {
      const selected = value === selectedBackground;
      swatch.button.classList.toggle('is-active', selected);
      swatch.button.setAttribute('aria-pressed', String(selected));
      paintSwatch(value, swatch.chip, prefs);
    }
    customRow.hidden = prefs.background.kind !== 'custom';
    if (prefs.background.kind === 'custom') {
      customFrom.value = prefs.background.from;
      customTo.value = prefs.background.to;
    }
    gradientNote.hidden = !prefs.transparentMode;

    for (const [prefKey, toggle] of toggles) {
      const locked =
        !prefs.transparentMode &&
        (prefKey === 'hideTop' || prefKey === 'hideBody' || prefKey === 'clickThrough');
      toggle.input.disabled = locked;
      toggle.input.checked = prefs[prefKey] === true;
      const refused = isConcealRefusalKey(prefKey) ? refusals.get(prefKey) : undefined;
      let reason = '';
      let error = false;
      if (locked) {
        reason = texts.needsTransparent;
        error = true;
      } else if (refused !== undefined && prefs[prefKey] !== true) {
        reason = refused;
        error = true;
      } else if (prefKey === 'clickThrough' && prefs.transparentMode) {
        reason = texts.clickThroughHint;
      }
      toggle.reason.hidden = reason === '';
      toggle.reason.textContent = reason;
      toggle.reason.classList.toggle('is-error', error);
    }
    if (opacityInput.dataset.recording !== 'true') {
      opacityInput.value = String(prefs.contentOpacity);
    }
  }

  const unsubscribe =
    deps.subscribeSwitchRefusal?.((key, reason) => {
      refusals.set(key, reason);
      render();
    }) ?? null;

  return {
    section,
    retranslate(): void {
      const labels = deps.labels();
      texts.group = labels.group;
      texts.groupHint = labels.groupHint;
      texts.bossKeyHint = labels.bossKeyHint;
      texts.macBossKeyHint = labels.macBossKeyHint;
      texts.bossKey1 = labels.bossKey1;
      texts.bossKey2 = labels.bossKey2;
      texts.bossKeyActive = labels.bossKeyActive;
      texts.bossKeyEmpty = labels.bossKeyEmpty;
      texts.bossKeyInvalid = labels.bossKeyInvalid;
      texts.bossKeySame = labels.bossKeySame;
      texts.bossKeyUnregistered = labels.bossKeyUnregistered;
      texts.recordCombo = labels.recordCombo;
      texts.background = labels.background;
      texts.backgroundLabels = {
        theme: labels.backgroundTheme,
        lavender: labels.backgroundPresets.lavender,
        mint: labels.backgroundPresets.mint,
        peach: labels.backgroundPresets.peach,
        sky: labels.backgroundPresets.sky,
        butter: labels.backgroundPresets.butter,
        custom: labels.backgroundCustom,
      };
      texts.customFrom = labels.customFrom;
      texts.customTo = labels.customTo;
      texts.contentOpacity = labels.contentOpacity;
      texts.opacityScale = labels.opacityScale;
      texts.needsTransparent = labels.needsTransparent;
      texts.gradientHidden = labels.gradientHidden;
      texts.clickThroughHint = labels.clickThroughHint;
      texts.exitHint = labels.exitHint;
      texts.scenes = {
        normal: labels.sceneNormal,
        hideOnLeave: labels.sceneHideOnLeave,
        floating: labels.sceneFloating,
        custom: labels.sceneCustom,
      };
      texts.groups = {
        dodge: labels.groupDodge,
        disguise: labels.groupDisguise,
        float: labels.groupFloat,
        exit: labels.groupExit,
      };
      texts.toggles = {
        transparentMode: labels.transparentMode,
        hideTop: labels.hideTop,
        hideBody: labels.hideBody,
        hideBottom: labels.hideBottom,
        alwaysOnTop: labels.alwaysOnTop,
        miniWindow: labels.miniWindow,
        clickThrough: labels.clickThrough,
      };
      hint.textContent = labels.groupHint;
      scenes.setAttribute('aria-label', labels.group);
      for (const [choice, sceneButton] of sceneButtons) {
        sceneButton.textContent = texts.scenes[choice];
      }
      customScene.textContent = texts.scenes.custom;
      const headings: Record<'dodge' | 'disguise' | 'float' | 'exit', HTMLElement> = {
        dodge,
        disguise,
        float: floatGroup,
        exit,
      };
      for (const id of ['dodge', 'disguise', 'float', 'exit'] as const) {
        const heading = headings[id].querySelector('h3');
        if (heading !== null) {
          heading.textContent = texts.groups[id];
        }
      }
      bossHint.textContent = labels.bossKeyHint;
      if (macHint !== null) {
        macHint.textContent = labels.macBossKeyHint;
      }
      exitHint.textContent = labels.exitHint;
      primaryField.input.setAttribute('aria-label', labels.bossKey1);
      primaryField.input.title = labels.bossKey1;
      secondaryField.input.setAttribute('aria-label', labels.bossKey2);
      secondaryField.input.title = labels.bossKey2;
      backgroundText.textContent = labels.background;
      swatchRow.setAttribute('aria-label', labels.background);
      for (const [value, swatch] of swatches) {
        swatch.name.textContent = texts.backgroundLabels[value];
        swatch.button.setAttribute('aria-label', texts.backgroundLabels[value]);
        swatch.button.title = texts.backgroundLabels[value];
      }
      gradientNote.textContent = labels.gradientHidden;
      customFromText.textContent = labels.customFrom;
      customToText.textContent = labels.customTo;
      opacityText.textContent = labels.contentOpacity;
      opacityScale.textContent = labels.opacityScale;
      opacityInput.setAttribute('aria-label', labels.contentOpacity);
      for (const [prefKey, toggle] of toggles) {
        toggle.text.textContent = texts.toggles[prefKey];
      }
      render();
    },
    destroy(): void {
      unsubscribe?.();
    },
  };
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
  readerPrefs.append(readerPrefsTitle, readerPrefsHint, progressBarLabel, pageTurnField);

  // AI 分组(R2):唯一活动提供商——端点格式三选一(联动预填官方 base URL,
  // 可改)、base URL/模型/Key、allowHttp、测试连接(role=status 结果)、目标
  // 语言覆盖;保存/清除密钥后广播 lightink:reader-ai-configured。
  const aiGroup = doc.createElement('section');
  aiGroup.className = 'lightink-library-manage-group lightink-library-ai';
  aiGroup.dataset.manageGroup = 'ai';
  const aiTitle = doc.createElement('h2');
  aiTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const aiHint = doc.createElement('p');
  aiHint.className = 'lightink-library-appearance-hint lightink-library-ai-hint';

  const aiEndpointField = doc.createElement('label');
  aiEndpointField.className = 'lightink-library-field lightink-library-ai-endpoint-field';
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
  aiEndpointField.append(aiEndpointText, aiEndpointSelect);

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
  const aiKeyClear = button(doc, '', 'lightink-library-ai-key-clear');
  const aiKeyRow = doc.createElement('div');
  aiKeyRow.className = 'lightink-library-ai-key-row';
  aiKeyRow.append(aiKeyField, aiKeyClear);

  const aiAllowHttpLabel = doc.createElement('label');
  aiAllowHttpLabel.className = 'lightink-library-reader-pref lightink-library-ai-allow-http';
  const aiAllowHttpInput = doc.createElement('input');
  aiAllowHttpInput.type = 'checkbox';
  aiAllowHttpInput.name = 'aiAllowHttp';
  const aiAllowHttpText = doc.createElement('span');
  aiAllowHttpLabel.append(aiAllowHttpInput, aiAllowHttpText);

  const aiTargetLangField = doc.createElement('label');
  aiTargetLangField.className = 'lightink-library-field lightink-library-ai-target-lang-field';
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
  aiTargetLangField.append(aiTargetLangText, aiTargetLangSelect);

  const aiActions = doc.createElement('div');
  aiActions.className = 'lightink-library-ai-actions';
  // 单一「保存配置」:密钥框有内容时一并写入钥匙串(清除密钥在密钥框旁)。
  const aiSave = button(doc, '', 'lightink-library-primary lightink-library-ai-save');
  const aiTest = button(doc, '', 'lightink-library-ai-test');
  aiActions.append(aiSave, aiTest);

  const aiFeedback = doc.createElement('p');
  aiFeedback.className = 'lightink-library-ai-feedback';
  aiFeedback.setAttribute('role', 'status');
  aiFeedback.hidden = true;
  const aiStatus = doc.createElement('p');
  aiStatus.className = 'lightink-library-ai-status';
  aiStatus.setAttribute('aria-live', 'polite');
  aiGroup.append(
    aiTitle,
    aiHint,
    aiEndpointField,
    aiBaseField,
    aiModelField,
    aiKeyRow,
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
    aiKeyInput.placeholder = aiStatusState.hasKey ? l.aiKeySavedPlaceholder : l.aiKey;
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
      // 密钥框有内容时先写入钥匙串(失败即止,输入保留待重试);
      // 留空不动既有密钥——清除密钥仍走独立按钮。
      const key = aiKeyInput.value.trim();
      if (key !== '') {
        await invokeAiStoreKey(key);
        aiKeyInput.value = '';
      }
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

  const concealUi =
    options.conceal === undefined ? null : mountConcealSection(doc, options.conceal);


  home.append(
    appearance,
    readerPrefs,
    aiGroup,
    storage,
    ...(sync === null ? [] : [sync]),
    ...(concealUi === null ? [] : [concealUi.section]),
    other,
  );
  setupManageGroupCollapsing(home);
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
      // Not data-library-theme: that attribute republishes a preset, and the
      // name is drawn on the shelf page rather than a filled swatch.
      swatch.dataset.libraryThemeId = theme.id;
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
    concealUi?.retranslate();
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
      concealUi?.destroy();
      cacheLimitOverlay.remove();
      element.remove();
    },
  };

  retranslate();
  return view;
}
