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

export interface LookupEntry {
  readonly partOfSpeech?: string;
  readonly language?: string;
  readonly definitions: readonly string[];
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
}

export interface LookupPanel {
  readonly element: HTMLElement;
  show(input: LookupPanelShow, host: HTMLElement): void;
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

  const hide = (): void => {
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

  return {
    element: root,
    show(input, host) {
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
      root.hidden = false;
      mountReaderOverlay(root, host);
      adoptReaderOverlayTheme(root, host);
      positionLookupPanel(root, host);
      revealSheet(root);
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
