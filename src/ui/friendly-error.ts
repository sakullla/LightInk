/**
 * 结构化错误 → 友好文案格式器（R4 / ADR-5）。
 *
 * 输出 `{ title, detail }`：title 取调用方注入的域码表命中的 i18n key
 * （或 fallback key），detail 保留原始 message。接受对象（Tauri 序列化的
 * `WebDavError`/`RemoteError` 形如 `{code, message, status}`）、JSON 字符串
 * 与普通字符串/Error——解析思路同 `reader/error-message.ts` 的
 * `asStructuredError`，但不复制 reader 域码表：各域码表归属自己的模块。
 */

import type { MessageKey } from '../i18n/messages.js';

export interface FriendlyErrorLabels {
  /** 已本地化的主文案；绝不直接使用原始 error message。 */
  readonly title: string;
  /** 原始错误信息，仅供「技术详情」展开显示；可能为空串。 */
  readonly detail: string;
}

export interface FriendlyErrorOptions {
  /** 域码表（code → i18n key），由拥有该错误域的模块注入。 */
  readonly codeTitles?: Readonly<Record<string, MessageKey>>;
  /** 未命中码表时的兜底 i18n key。 */
  readonly fallbackTitle: MessageKey;
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 错误不带任何 message 文本时的 detail 兜底（缺省为空串）。 */
  readonly emptyDetail?: string;
}

interface StructuredErrorShape {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
}

function asStructuredError(error: unknown): StructuredErrorShape | null {
  if (error !== null && typeof error === 'object') return error as StructuredErrorShape;
  if (typeof error !== 'string') return null;
  try {
    const parsed = JSON.parse(error) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as StructuredErrorShape)
      : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown, structured: StructuredErrorShape | null): string {
  if (
    structured !== null &&
    typeof structured.message === 'string' &&
    structured.message.trim() !== ''
  ) {
    return structured.message;
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error.trim();
  return '';
}

/** Map an unknown failure to a localized title plus the original message as detail. */
export function friendlyError(error: unknown, options: FriendlyErrorOptions): FriendlyErrorLabels {
  const structured = asStructuredError(error);
  const detail = messageOf(error, structured);
  const code =
    structured !== null && typeof structured.code === 'string' ? structured.code : '';
  const key =
    code !== '' &&
    options.codeTitles !== undefined &&
    Object.prototype.hasOwnProperty.call(options.codeTitles, code)
      ? options.codeTitles[code]!
      : options.fallbackTitle;
  const vars =
    typeof structured?.status === 'number' || typeof structured?.status === 'string'
      ? { status: String(structured.status) }
      : undefined;
  return {
    title: options.t(key, vars),
    detail: detail === '' ? (options.emptyDetail ?? '') : detail,
  };
}
