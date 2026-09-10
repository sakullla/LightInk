import type { LocaleId, MessageKey } from '../i18n/messages.js';

/** 翻译目标语言：auto = 跟随界面语言，其余为常用阅读语言。Manage 与译文面板共用。 */
export const AI_TARGET_LANG_VALUES = [
  'auto',
  'zh-CN',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
] as const;

export type AiTargetLangValue = (typeof AI_TARGET_LANG_VALUES)[number];

/** 目标语言代码 → 本地化语言名（提示词内嵌与下拉文案；键小写归一）。 */
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

export function lookupTargetLangLabel(
  t: (key: MessageKey) => string,
  value: string,
): string {
  if (value === 'auto') {
    return t('reader.ai.targetLang.auto');
  }
  const key = AI_LANG_KEYS[value.toLowerCase()];
  return key === undefined ? value : t(key);
}

export function normalizeLookupTargetLang(raw: string | undefined): AiTargetLangValue {
  const value = raw?.trim() ?? '';
  if (value === '') {
    return 'auto';
  }
  const match = AI_TARGET_LANG_VALUES.find((item) => item.toLowerCase() === value.toLowerCase());
  return match ?? 'auto';
}

/**
 * 目标语言解析（R3）：覆盖项优先（auto/未设视为跟随界面语言），界面语言兜底。
 * 返回值内嵌进后端翻译提示词，故映射为本地化语言名；未知覆盖值原样透传。
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
