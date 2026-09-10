/**
 * `lookup-panel` — in-page Wiktionary / DeepL results (ADR-5).
 *
 * Desktop: compact popover. Touch: bottom sheet via sheet-transition.
 * Copy is plain text; Escape / close hide the panel without leaving the book.
 */

import './lookup-panel.css';

import { invoke } from '@tauri-apps/api/core';
import type { LocaleId, MessageKey } from '../i18n/messages.js';
import {
  adoptReaderOverlayTheme,
  mountReaderOverlay,
  pinFixedOverlay,
  unpinFixedOverlay,
} from './reader-chrome-panels.js';
import { concealSheet, revealSheet } from '../ui/touch/sheet-transition.js';
import { readerChromeTouchMode } from './view/reader-dom.js';

export const LOOKUP_MAX_CODE_UNITS = 40;
export const LOOKUP_MAX_TOKENS = 4;
export const TRANSLATE_MAX_CODE_UNITS = 5000;

export const READER_DEEPL_CONFIGURED_EVENT = 'lightink:reader-deepl-configured';
/** 与 Manage 页 AI 分组广播的事件同源（`ai-config-ui`），reader 侧自持常量。 */
export const READER_AI_CONFIGURED_EVENT = 'lightink:reader-ai-configured';

export interface LookupEntry {
  readonly partOfSpeech?: string;
  readonly language?: string;
  readonly definitions: readonly string[];
}

/** 并列译文来源段（R3）：DeepL 与 AI 各自成段，独立状态、段内重试。 */
export type LookupTranslateSource = 'deepl' | 'ai';

export interface LookupTranslateSection {
  readonly source: LookupTranslateSource;
  /** idle = 已配置但尚未触发（段内按钮可发起）；其余与单段状态同义。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  readonly lines?: readonly string[];
  readonly message?: string;
  /** AI 段专用：后端截断至 5000 字时提示（R3 与 DeepL 的拒绝语义不同）。 */
  readonly truncated?: boolean;
}

export interface LookupTranslateShow {
  readonly quote: string;
  readonly sections: readonly LookupTranslateSection[];
}

export interface LookupPanelShow {
  readonly kind: 'lookup' | 'translate';
  readonly quote: string;
  readonly status: 'loading' | 'ready' | 'empty' | 'error';
  readonly lines?: readonly string[];
  readonly message?: string;
}

export interface LookupPanelDeps {
  t: (key: MessageKey) => string;
  onDismiss?: () => void;
  /** 并列段内「重试/翻译」按钮点击：携带来源与面板当前引文。 */
  onRetryTranslate?: (source: LookupTranslateSource, quote: string) => void;
}

export interface LookupPanel {
  readonly element: HTMLElement;
  show(input: LookupPanelShow, host: HTMLElement): void;
  /** 译文并列视图（R3）：按来源分段渲染，段状态独立。 */
  showTranslate(input: LookupTranslateShow, host: HTMLElement): void;
  /** 就地更新一个来源段；面板不在译文视图或段不存在时忽略（迟到结果守卫）。 */
  updateTranslateSection(section: LookupTranslateSection): void;
  hide(): void;
  isVisible(): boolean;
  destroy(): void;
}

export function lookupQuoteTooLong(quote: string): boolean {
  const trimmed = quote.trim();
  if (trimmed.length > LOOKUP_MAX_CODE_UNITS) {
    return true;
  }
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length > LOOKUP_MAX_TOKENS;
}

export function translateQuoteTooLong(quote: string): boolean {
  return quote.trim().length > TRANSLATE_MAX_CODE_UNITS;
}

export function readerAidLocale(t: (key: MessageKey) => string): LocaleId {
  return t('annotation.highlight') === '高亮' ? 'zh-CN' : 'en';
}

export function deeplTargetLang(locale: LocaleId): 'ZH' | 'EN' {
  return locale === 'zh-CN' ? 'ZH' : 'EN';
}

export function lookupTooLongCopy(t: (key: MessageKey) => string, translateEnabled: boolean): string {
  return t(translateEnabled ? 'reader.lookup.tooLongUseTranslate' : 'reader.lookup.tooLong');
}

// ── AI 翻译（R3）：目标语言解析、错误码映射与并列段规划 ───────────────

/** AI 分组目标语言覆盖项的常用代码 → 本地化语言名（提示词内嵌用；键小写归一）。 */
const AI_LANG_KEYS: Readonly<Record<string, MessageKey>> = {
  'zh-cn': 'reader.ai.lang.zh-CN',
  en: 'reader.ai.lang.en',
  ja: 'reader.ai.lang.ja',
  ko: 'reader.ai.lang.ko',
  fr: 'reader.ai.lang.fr',
  de: 'reader.ai.lang.de',
  es: 'reader.ai.lang.es',
  ru: 'reader.ai.lang.ru',
};

/**
 * 目标语言解析（R3）：AI 分组覆盖项优先（auto/未设视为跟随界面语言），
 * 界面语言兜底。返回值内嵌进后端翻译提示词，故映射为本地化语言名；
 * 未知覆盖值原样透传（用户自定义语言名）。代码按大小写不敏感匹配
 * （Manage 下拉产生精确代码，手填 'zh-CN'/'ZH-CN' 同样命中）。
 */
export function aiTranslateTargetLang(
  t: (key: MessageKey) => string,
  locale: LocaleId,
  override?: string,
): string {
  const raw = override?.trim();
  if (raw !== undefined && raw !== '' && raw.toLowerCase() !== 'auto') {
    const key = AI_LANG_KEYS[raw.toLowerCase()];
    return key === undefined ? raw : t(key);
  }
  return t(AI_LANG_KEYS[locale.toLowerCase()] ?? 'reader.ai.lang.en');
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
export function readerAiErrorMessage(
  t: (key: MessageKey) => string,
  error: unknown,
  missing: readonly string[] = [],
): string {
  // aidErrorCode 是 DeepL 语义的子串匹配;AI 错误取原始 `AI_*` 码精确对表。
  const code = aidErrorRaw(error).match(/\bAI_[A-Z_]+\b/)?.[0] ?? '';
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

/**
 * 并列段初始规划：每个已配置来源一段，点名的来源直接 loading、其余 idle
 * （段内可独立触发）；未配置的来源不出现，唯点名来源未配置（配置态竞态）
 * 时以单段未配置错误呈现，保证点击动作始终有可见反馈。
 */
export function initialTranslateSections(
  t: (key: MessageKey) => string,
  deeplConfigured: boolean,
  aiConfigured: boolean,
  requested: LookupTranslateSource,
): LookupTranslateSection[] {
  const sections: LookupTranslateSection[] = [];
  if (deeplConfigured) {
    sections.push({ source: 'deepl', status: requested === 'deepl' ? 'loading' : 'idle' });
  } else if (requested === 'deepl') {
    sections.push({
      source: 'deepl',
      status: 'error',
      message: t('reader.lookup.error.unconfigured'),
    });
  }
  if (aiConfigured) {
    sections.push({ source: 'ai', status: requested === 'ai' ? 'loading' : 'idle' });
  } else if (requested === 'ai') {
    sections.push({
      source: 'ai',
      status: 'error',
      message: readerAiErrorMessage(t, { code: 'AI_NOT_CONFIGURED' }),
    });
  }
  return sections;
}

const AID_ERROR_KEYS = {
  network: 'reader.lookup.error.network',
  timeout: 'reader.lookup.error.timeout',
  too_large: 'reader.lookup.error.tooLarge',
  not_found: 'reader.lookup.error.notFound',
  invalid_key: 'reader.lookup.error.invalidKey',
  quota: 'reader.lookup.error.quota',
  unconfigured: 'reader.lookup.error.unconfigured',
  too_long: 'reader.lookup.tooLong',
  translate_too_long: 'reader.lookup.translateTooLong',
  empty: 'reader.lookup.empty',
  failed: 'reader.lookup.error.failed',
} as const satisfies Record<string, MessageKey>;

export function readerAidErrorMessage(t: (key: MessageKey) => string, error: unknown): string {
  const code = aidErrorCode(error);
  const key = AID_ERROR_KEYS[code] ?? AID_ERROR_KEYS.failed;
  return t(key);
}

export function formatLookupEntries(entries: readonly LookupEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const head = [entry.language, entry.partOfSpeech].filter((part) => part !== undefined && part !== '').join(' · ');
    if (head !== '') {
      lines.push(head);
    }
    for (const definition of entry.definitions) {
      const text = definition.trim();
      if (text !== '') {
        lines.push(text);
      }
    }
  }
  return lines;
}

export function parseLookupEntries(raw: unknown): LookupEntry[] {
  if (raw == null) {
    return [];
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text === '' ? [] : [{ definitions: [text] }];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => parseLookupEntries(item));
  }
  if (typeof raw !== 'object') {
    return [];
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.error === 'string' && obj.error !== '') {
    throw Object.assign(new Error(obj.error), { code: obj.error });
  }
  if (Array.isArray(obj.entries)) {
    return parseLookupEntries(obj.entries);
  }
  if (Array.isArray(obj.definitions)) {
    const definitions = obj.definitions
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item !== null && typeof item === 'object') {
          const definition = (item as { definition?: unknown }).definition;
          return typeof definition === 'string' ? definition : '';
        }
        return '';
      })
      .map((item) => item.trim())
      .filter((item) => item !== '');
    return [
      {
        partOfSpeech: typeof obj.partOfSpeech === 'string' ? obj.partOfSpeech : undefined,
        language: typeof obj.language === 'string' ? obj.language : undefined,
        definitions,
      },
    ];
  }
  const collected: LookupEntry[] = [];
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      collected.push(...parseLookupEntries(value));
    }
  }
  return collected;
}

export function parseTranslateText(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { error?: unknown; text?: unknown; translation?: unknown };
    if (typeof obj.error === 'string' && obj.error !== '') {
      throw Object.assign(new Error(obj.error), { code: obj.error });
    }
    if (typeof obj.text === 'string') {
      return obj.text.trim();
    }
    if (typeof obj.translation === 'string') {
      return obj.translation.trim();
    }
  }
  return '';
}

export function parseDeeplConfigured(raw: unknown): boolean {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw !== null && typeof raw === 'object') {
    const configured = (raw as { configured?: unknown }).configured;
    return configured === true;
  }
  return false;
}

export async function invokeWiktionaryLookup(term: string, locale: LocaleId): Promise<LookupEntry[]> {
  return parseLookupEntries(await invoke<unknown>('reader_wiktionary_lookup', { term, locale }));
}

export async function invokeDeepLTranslate(text: string, locale: LocaleId): Promise<string> {
  return parseTranslateText(
    await invoke<unknown>('reader_deepl_translate', {
      text,
      targetLang: deeplTargetLang(locale),
      target_lang: deeplTargetLang(locale),
    }),
  );
}

export async function invokeDeepLConfigured(): Promise<boolean> {
  try {
    return parseDeeplConfigured(await invoke<unknown>('reader_deepl_configured'));
  } catch {
    return false;
  }
}

export async function invokeDeepLStoreKey(key: string): Promise<void> {
  await invoke<void>('reader_deepl_store_key', { key });
}

export async function invokeDeepLForgetKey(): Promise<void> {
  await invoke<void>('reader_deepl_forget_key');
}

/** `ai_get_config` 的 reader 侧投影：显隐判定 + 目标语言覆盖项（无密钥材料）。 */
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

/** `ai_translate_selection` 的返回形态（截断标志 → 段内提示）。 */
export interface AiTranslateResultView {
  readonly text: string;
  readonly targetLang: string;
  readonly truncated: boolean;
}

export function parseAiTranslateResult(raw: unknown): AiTranslateResultView {
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { text?: unknown; targetLang?: unknown; truncated?: unknown };
    return {
      text: typeof obj.text === 'string' ? obj.text.trim() : '',
      targetLang: typeof obj.targetLang === 'string' ? obj.targetLang : '',
      truncated: obj.truncated === true,
    };
  }
  return { text: '', targetLang: '', truncated: false };
}

export async function invokeAiTranslateConfig(): Promise<AiTranslateConfig> {
  return parseAiTranslateConfig(await invoke<unknown>('ai_get_config'));
}

/** 选区 AI 翻译：超长输入由后端截断至 5000 并置 truncated（与 DeepL 拒绝不同）。 */
export async function invokeAiTranslateSelection(
  text: string,
  targetLang: string,
): Promise<AiTranslateResultView> {
  return parseAiTranslateResult(
    await invoke<unknown>('ai_translate_selection', {
      text,
      targetLang,
      target_lang: targetLang,
    }),
  );
}

export function dispatchDeeplConfigured(configured: boolean, target: Document | Window = document): void {
  target.dispatchEvent(
    new CustomEvent(READER_DEEPL_CONFIGURED_EVENT, { detail: { configured } }),
  );
}

function aidErrorCode(error: unknown): keyof typeof AID_ERROR_KEYS {
  const raw = aidErrorRaw(error);
  const lowered = raw.toLowerCase();
  if (lowered.includes('reader_network') || lowered.includes('network')) return 'network';
  if (lowered.includes('reader_timeout') || lowered.includes('timeout')) return 'timeout';
  if (
    lowered.includes('too_large') ||
    lowered.includes('too large') ||
    lowered.includes('payload')
  ) {
    return 'too_large';
  }
  if (lowered.includes('not_found') || lowered.includes('not found') || lowered.includes('未找到')) {
    return 'not_found';
  }
  if (
    lowered.includes('invalid_key') ||
    lowered.includes('invalid key') ||
    lowered.includes('forbidden') ||
    lowered.includes('reader_key_invalid')
  ) {
    return 'invalid_key';
  }
  if (lowered.includes('quota') || lowered.includes('reader_quota')) return 'quota';
  if (
    lowered.includes('unconfigured') ||
    lowered.includes('no key') ||
    lowered.includes('reader_key_missing')
  ) {
    return 'unconfigured';
  }
  if (lowered.includes('reader_text_too_long') || lowered.includes('5000')) {
    return 'translate_too_long';
  }
  if (lowered.includes('too_long') || lowered.includes('too long') || lowered.includes('过长')) {
    return 'too_long';
  }
  if (lowered.includes('empty') || lowered.includes('reader_term_empty')) return 'empty';
  const known = Object.keys(AID_ERROR_KEYS).find((code) => lowered === code);
  return (known as keyof typeof AID_ERROR_KEYS | undefined) ?? 'failed';
}

function aidErrorRaw(error: unknown): string {
  if (typeof error === 'string') {
    return unwrapAidErrorText(error);
  }
  if (error === null || typeof error !== 'object') {
    return '';
  }
  const obj = error as { code?: unknown; error?: unknown; message?: unknown };
  const parts = [obj.code, obj.error, obj.message]
    .filter((value) => typeof value === 'string' && value !== '')
    .map((value) => unwrapAidErrorText(value as string));
  return parts.join(' ');
}

function unwrapAidErrorText(raw: string): string {
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

function positionLookupPanel(panel: HTMLElement, host: HTMLElement): void {
  if (readerChromeTouchMode()) {
    pinFixedOverlay(panel, host);
    return;
  }
  unpinFixedOverlay(panel);
  panel.classList.remove('is-touch-sheet');
  const box = host.getBoundingClientRect();
  const width = Math.min(352, Math.max(240, box.width - 24));
  const left = Math.max(8, box.left + (box.width - width) / 2);
  const top = Math.max(8, box.top + 48);
  panel.style.position = 'fixed';
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.width = `${width}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

export function createLookupPanel(deps: LookupPanelDeps): LookupPanel {
  const root = document.createElement('div');
  root.className = 'lightink-reader-lookup-panel lightink-reader-chrome-popover';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.hidden = true;

  const head = document.createElement('div');
  head.className = 'lightink-reader-lookup-head';
  const title = document.createElement('h2');
  title.className = 'lightink-reader-lookup-title';
  title.id = 'lightink-reader-lookup-title';
  root.setAttribute('aria-labelledby', title.id);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-lookup-close lightink-reader-sidebar-close';
  close.textContent = '×';
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'lightink-reader-lookup-body';
  body.setAttribute('aria-live', 'polite');
  root.append(head, body);
  root.addEventListener(
    'wheel',
    (event) => {
      event.stopPropagation();
    },
    { passive: true },
  );

  /** 译文并列视图当前引文（段内重试按钮携带）；null = 非译文视图。 */
  let translateQuote: string | null = null;

  const hide = (): void => {
    translateQuote = null;
    if (readerChromeTouchMode()) {
      concealSheet(root, () => {
        root.hidden = true;
        unpinFixedOverlay(root);
      });
      return;
    }
    delete root.dataset.open;
    root.hidden = true;
  };

  close.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    hide();
    deps.onDismiss?.();
  });
  close.setAttribute('aria-label', deps.t('reader.lookup.close'));

  /** 单个来源段：段名 + 状态文案/译文 + （错误段）重试、（idle 段）触发按钮。 */
  const renderTranslateSection = (section: LookupTranslateSection): HTMLElement => {
    const block = document.createElement('section');
    block.className = 'lightink-reader-lookup-source';
    block.dataset.source = section.source;
    block.dataset.status = section.status;
    const name = document.createElement('h3');
    name.className = 'lightink-reader-lookup-source-name';
    name.textContent = deps.t(
      section.source === 'deepl' ? 'reader.lookup.source.deepl' : 'reader.lookup.source.ai',
    );
    block.appendChild(name);
    if (section.message !== undefined && section.message !== '') {
      const message = document.createElement('p');
      message.className = 'lightink-reader-lookup-message';
      message.textContent = section.message;
      block.appendChild(message);
    }
    for (const line of section.lines ?? []) {
      const item = document.createElement('p');
      item.className = 'lightink-reader-lookup-line';
      item.textContent = line;
      block.appendChild(item);
    }
    if (section.truncated === true) {
      const hint = document.createElement('p');
      hint.className = 'lightink-reader-lookup-hint';
      hint.textContent = deps.t('reader.lookup.aiTruncated');
      block.appendChild(hint);
    }
    if (section.status === 'error' || section.status === 'idle') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'lightink-reader-lookup-source-action';
      action.textContent = deps.t(
        section.status === 'error' ? 'reader.lookup.retry' : 'reader.lookup.translate',
      );
      action.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const quote = translateQuote;
        if (quote === null) {
          return;
        }
        deps.onRetryTranslate?.(section.source, quote);
      });
      block.appendChild(action);
    }
    return block;
  };

  const openPanel = (host: HTMLElement): void => {
    root.hidden = false;
    mountReaderOverlay(root, host);
    adoptReaderOverlayTheme(root, host);
    positionLookupPanel(root, host);
    revealSheet(root);
  };

  return {
    element: root,
    show(input, host) {
      translateQuote = null;
      title.textContent =
        input.kind === 'translate' ? deps.t('reader.lookup.translateTitle') : deps.t('reader.lookup.title');
      close.setAttribute('aria-label', deps.t('reader.lookup.close'));
      root.dataset.lookupKind = input.kind;
      root.dataset.lookupStatus = input.status;
      body.replaceChildren();
      const quote = input.quote.trim();
      if (quote !== '') {
        const quoteEl = document.createElement('p');
        quoteEl.className = 'lightink-reader-lookup-quote';
        quoteEl.textContent = quote;
        body.appendChild(quoteEl);
      }
      if (input.message !== undefined && input.message !== '') {
        const message = document.createElement('p');
        message.className = 'lightink-reader-lookup-message';
        message.textContent = input.message;
        body.appendChild(message);
      }
      for (const line of input.lines ?? []) {
        const item = document.createElement('p');
        item.className = 'lightink-reader-lookup-line';
        item.textContent = line;
        body.appendChild(item);
      }
      openPanel(host);
    },
    showTranslate(input, host) {
      const quote = input.quote.trim();
      translateQuote = quote === '' ? null : quote;
      title.textContent = deps.t('reader.lookup.translateTitle');
      close.setAttribute('aria-label', deps.t('reader.lookup.close'));
      root.dataset.lookupKind = 'translate';
      // 段状态独立呈现（各段 data-status），面板级状态不再承载单段语义。
      root.dataset.lookupStatus = 'multi';
      body.replaceChildren();
      if (quote !== '') {
        const quoteEl = document.createElement('p');
        quoteEl.className = 'lightink-reader-lookup-quote';
        quoteEl.textContent = quote;
        body.appendChild(quoteEl);
      }
      const wrap = document.createElement('div');
      wrap.className = 'lightink-reader-lookup-sources';
      for (const section of input.sections) {
        wrap.appendChild(renderTranslateSection(section));
      }
      body.appendChild(wrap);
      openPanel(host);
    },
    updateTranslateSection(section) {
      if (root.hidden || root.dataset.lookupKind !== 'translate' || translateQuote === null) {
        return;
      }
      const block = body.querySelector<HTMLElement>(
        `.lightink-reader-lookup-source[data-source="${section.source}"]`,
      );
      if (block === null) {
        return;
      }
      block.replaceWith(renderTranslateSection(section));
    },
    hide,
    isVisible() {
      return !root.hidden;
    },
    destroy() {
      hide();
      unpinFixedOverlay(root);
      root.remove();
    },
  };
}
