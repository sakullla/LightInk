/**
 * `lookup-panel` — in-page Wiktionary / AI translate results (ADR-5 / R3).
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
import {
  AI_TARGET_LANG_VALUES,
  lookupTargetLangLabel,
  normalizeLookupTargetLang,
} from './ai-target-lang.js';
import { aiErrorRaw, assistantAiErrorMessage } from '../assistant/assistant-error.js';

export {
  AI_TARGET_LANG_VALUES,
  aiTranslateTargetLang,
  lookupTargetLangLabel,
  normalizeLookupTargetLang,
} from './ai-target-lang.js';
export type { AiTargetLangValue } from './ai-target-lang.js';

export const LOOKUP_MAX_CODE_UNITS = 40;
export const LOOKUP_MAX_TOKENS = 4;
export const TRANSLATE_MAX_CODE_UNITS = 5000;

/**
 * 兼容导出：配置事件、配置读取与 AI 错误映射现由 `assistant-error` 单点持有
 * （surface 无关），reader 侧消费方继续经本模块导入，不产生第二份实现。
 */
export { ASSISTANT_AI_CONFIGURED_EVENT as READER_AI_CONFIGURED_EVENT } from '../assistant/assistant-error.js';
export { parseAiTranslateConfig } from '../assistant/assistant-error.js';
export { invokeAiTranslateConfig } from '../assistant/assistant-error.js';
export { assistantAiErrorMessage as readerAiErrorMessage } from '../assistant/assistant-error.js';
export type { AiTranslateConfig } from '../assistant/assistant-error.js';

export interface LookupEntry {
  readonly partOfSpeech?: string;
  readonly language?: string;
  readonly definitions: readonly string[];
}

/** 译文来源段（R3）：仅 AI；段状态独立、段内可重试。 */
export type LookupTranslateSource = 'ai';

export interface LookupTranslateSection {
  readonly source: LookupTranslateSource;
  /** idle = 已配置但尚未触发（段内按钮可发起）；其余与单段状态同义。 */
  readonly status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  readonly lines?: readonly string[];
  readonly message?: string;
  /** AI 段专用：后端截断至 5000 字时提示。 */
  readonly truncated?: boolean;
}

export interface LookupAnchorRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface LookupTranslateShow {
  readonly quote: string;
  readonly sections: readonly LookupTranslateSection[];
  /** 当前目标语言代码（auto 或 zh-CN/en/…）；面板语种切换的选中值。 */
  readonly targetLang?: string;
  /** 划选包围盒（外层 client 坐标）；缺省沿用上次锚点或阅读区顶部居中。 */
  readonly anchor?: LookupAnchorRect;
}

export interface LookupPanelShow {
  readonly kind: 'lookup' | 'translate';
  readonly quote: string;
  readonly status: 'loading' | 'ready' | 'empty' | 'error';
  readonly lines?: readonly string[];
  readonly message?: string;
  readonly anchor?: LookupAnchorRect;
}

export interface LookupPanelDeps {
  t: (key: MessageKey) => string;
  onDismiss?: () => void;
  /** 并列段内「重试/翻译」按钮点击：携带来源与面板当前引文。 */
  onRetryTranslate?: (source: LookupTranslateSource, quote: string) => void;
  /** 译文面板切换目标语言：用当前引文按新语种重译。 */
  onChangeTargetLang?: (lang: string, quote: string) => void;
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

export function lookupTooLongCopy(t: (key: MessageKey) => string, translateEnabled: boolean): string {
  return t(translateEnabled ? 'reader.lookup.tooLongUseTranslate' : 'reader.lookup.tooLong');
}

// ── AI 翻译（R3）：错误码映射与段规划（实现单点见 assistant-error） ──────

/**
 * 译文段初始规划：已配置则 loading，未配置（配置态竞态）以单段错误呈现，
 * 保证点击动作始终有可见反馈。
 */
export function initialTranslateSections(
  t: (key: MessageKey) => string,
  aiConfigured: boolean,
): LookupTranslateSection[] {
  if (aiConfigured) {
    return [{ source: 'ai', status: 'loading' }];
  }
  return [
    {
      source: 'ai',
      status: 'error',
      message: assistantAiErrorMessage(t, { code: 'AI_NOT_CONFIGURED' }),
    },
  ];
}

const AID_ERROR_KEYS = {
  network: 'reader.lookup.error.network',
  timeout: 'reader.lookup.error.timeout',
  too_large: 'reader.lookup.error.tooLarge',
  not_found: 'reader.lookup.error.notFound',
  invalid_key: 'reader.lookup.error.failed',
  quota: 'reader.lookup.error.failed',
  unconfigured: 'reader.lookup.error.failed',
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

export async function invokeWiktionaryLookup(term: string, locale: LocaleId): Promise<LookupEntry[]> {
  return parseLookupEntries(await invoke<unknown>('reader_wiktionary_lookup', { term, locale }));
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

/** 选区 AI 翻译：超长输入由后端截断至 5000 并置 truncated。 */
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

function aidErrorCode(error: unknown): keyof typeof AID_ERROR_KEYS {
  const raw = aiErrorRaw(error);
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

const LOOKUP_MARGIN_PX = 8;
const LOOKUP_DESKTOP_WIDTH_PX = 352;

export function lookupPanelPosition(
  anchor: LookupAnchorRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number; top?: number; bottom?: number },
): { left: number; top: number; maxHeight: number } {
  const clamp = (value: number, low: number, high: number): number =>
    Math.min(Math.max(value, low), Math.max(low, high));
  const insetTop = viewport.top ?? LOOKUP_MARGIN_PX;
  const insetBottom = viewport.bottom ?? viewport.height - LOOKUP_MARGIN_PX;
  const spaceBelow = insetBottom - (anchor.top + anchor.height) - LOOKUP_MARGIN_PX;
  const spaceAbove = anchor.top - insetTop - LOOKUP_MARGIN_PX;
  // 优先选区上方；上方不够（贴顶/被 chrome 挡住）再落到下方。
  const preferAbove = spaceAbove >= Math.min(panel.height, 180) || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(120, preferAbove ? spaceAbove : spaceBelow);
  const usedHeight = Math.min(panel.height, maxHeight);
  const top = clamp(
    preferAbove
      ? anchor.top - usedHeight - LOOKUP_MARGIN_PX
      : anchor.top + anchor.height + LOOKUP_MARGIN_PX,
    insetTop,
    Math.max(insetTop, insetBottom - usedHeight),
  );
  const left = clamp(
    anchor.left + anchor.width / 2 - panel.width / 2,
    LOOKUP_MARGIN_PX,
    Math.max(LOOKUP_MARGIN_PX, viewport.width - panel.width - LOOKUP_MARGIN_PX),
  );
  return { left, top, maxHeight: Math.min(maxHeight, Math.max(120, insetBottom - top)) };
}

function positionLookupPanel(
  panel: HTMLElement,
  host: HTMLElement,
  anchor: LookupAnchorRect | null,
): void {
  if (readerChromeTouchMode()) {
    pinFixedOverlay(panel, host);
    return;
  }
  unpinFixedOverlay(panel);
  panel.classList.remove('is-touch-sheet');
  const hostBox = host.getBoundingClientRect();
  const viewport = {
    width: typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024,
    height:
      typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 768,
    top: Math.max(LOOKUP_MARGIN_PX, hostBox.top + 48),
    bottom: Math.min(
      (typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 768) -
        LOOKUP_MARGIN_PX,
      hostBox.bottom - LOOKUP_MARGIN_PX,
    ),
  };
  const width = Math.min(LOOKUP_DESKTOP_WIDTH_PX, Math.max(240, viewport.width - LOOKUP_MARGIN_PX * 2));
  panel.style.position = 'fixed';
  panel.style.width = `${width}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  if (anchor !== null) {
    const box = panel.getBoundingClientRect();
    const height = box.height > 1 ? box.height : 220;
    const pos = lookupPanelPosition(anchor, { width, height }, viewport);
    panel.style.left = `${pos.left}px`;
    panel.style.top = `${pos.top}px`;
    panel.style.maxHeight = `${pos.maxHeight}px`;
    return;
  }
  const left = Math.max(LOOKUP_MARGIN_PX, hostBox.left + (hostBox.width - width) / 2);
  const top = Math.max(LOOKUP_MARGIN_PX, hostBox.top + 48);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.maxHeight = '';
}

export function createLookupPanel(deps: LookupPanelDeps): LookupPanel {
  const root = document.createElement('div');
  root.className = 'lightink-reader-lookup-panel lightink-reader-chrome-popover';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.hidden = true;

  const head = document.createElement('div');
  head.className = 'lightink-reader-lookup-head';
  const headMain = document.createElement('div');
  headMain.className = 'lightink-reader-lookup-head-main';
  const title = document.createElement('h2');
  title.className = 'lightink-reader-lookup-title';
  title.id = 'lightink-reader-lookup-title';
  root.setAttribute('aria-labelledby', title.id);
  const langSelect = document.createElement('select');
  langSelect.className = 'lightink-reader-lookup-lang';
  langSelect.hidden = true;
  for (const value of AI_TARGET_LANG_VALUES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = lookupTargetLangLabel(deps.t, value);
    langSelect.append(option);
  }
  langSelect.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
  });
  langSelect.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
  langSelect.addEventListener('change', (event) => {
    event.stopPropagation();
    const quote = translateQuote;
    if (quote === null) {
      return;
    }
    deps.onChangeTargetLang?.(langSelect.value, quote);
  });
  headMain.append(title, langSelect);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lightink-reader-lookup-close lightink-reader-sidebar-close';
  close.textContent = '×';
  head.append(headMain, close);

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
  let lastAnchor: LookupAnchorRect | null = null;
  let lastHost: HTMLElement | null = null;

  const hide = (): void => {
    translateQuote = null;
    lastAnchor = null;
    lastHost = null;
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
    name.textContent = deps.t('reader.lookup.source.ai');
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
    lastHost = host;
    root.hidden = false;
    mountReaderOverlay(root, host);
    adoptReaderOverlayTheme(root, host);
    positionLookupPanel(root, host, lastAnchor);
    revealSheet(root);
  };

  return {
    element: root,
    show(input, host) {
      translateQuote = null;
      if (input.anchor !== undefined) {
        lastAnchor = input.anchor;
      }
      langSelect.hidden = true;
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
      if (input.anchor !== undefined) {
        lastAnchor = input.anchor;
      }
      title.textContent = deps.t('reader.lookup.translateTitle');
      close.setAttribute('aria-label', deps.t('reader.lookup.close'));
      langSelect.hidden = false;
      langSelect.setAttribute('aria-label', deps.t('reader.ai.targetLang'));
      langSelect.value = normalizeLookupTargetLang(input.targetLang);
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
      if (lastHost !== null) {
        positionLookupPanel(root, lastHost, lastAnchor);
      }
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
