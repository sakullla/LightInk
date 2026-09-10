// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aiTranslateTargetLang,
  createLookupPanel,
  initialTranslateSections,
  normalizeLookupTargetLang,
  parseAiTranslateConfig,
  parseAiTranslateResult,
  readerAidErrorMessage,
  readerAiErrorMessage,
} from '../lookup-panel.js';
import { createSelectionToolbar } from '../selection-toolbar.js';
import { translate, type MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey): string => key;
const englishT = (key: MessageKey): string => translate('en', key);

afterEach(() => {
  document.body.replaceChildren();
});

describe('readerAidErrorMessage', () => {
  it('maps Wiktionary not-found payloads to the empty-entry copy', () => {
    expect(readerAidErrorMessage(t, { code: 'READER_NOT_FOUND', message: '未找到该词条' })).toBe(
      'reader.lookup.error.notFound',
    );
    expect(
      readerAidErrorMessage(t, {
        message: JSON.stringify({ code: 'READER_NOT_FOUND', message: '未找到该词条' }),
      }),
    ).toBe('reader.lookup.error.notFound');
  });

  it('maps lookup vs translate length errors separately', () => {
    expect(readerAidErrorMessage(t, { code: 'READER_TERM_TOO_LONG' })).toBe('reader.lookup.tooLong');
    expect(readerAidErrorMessage(t, { code: 'READER_TEXT_TOO_LONG' })).toBe(
      'reader.lookup.translateTooLong',
    );
  });
});

describe('readerAiErrorMessage', () => {
  it('maps AI error code families to localized keys', () => {
    expect(readerAiErrorMessage(t, { code: 'AI_NETWORK_ERROR' })).toBe('reader.ai.error.network');
    expect(readerAiErrorMessage(t, { code: 'AI_TIMEOUT' })).toBe('reader.ai.error.timeout');
    expect(readerAiErrorMessage(t, { code: 'AI_KEY_INVALID' })).toBe('reader.ai.error.keyInvalid');
    expect(readerAiErrorMessage(t, { code: 'AI_QUOTA_EXCEEDED' })).toBe('reader.ai.error.quota');
    expect(readerAiErrorMessage(t, { code: 'AI_MODEL_NOT_FOUND' })).toBe(
      'reader.ai.error.modelNotFound',
    );
  });

  it('maps storage and text-family codes to their dedicated keys', () => {
    expect(readerAiErrorMessage(t, { code: 'AI_STORAGE_ERROR' })).toBe('reader.ai.error.storage');
    expect(readerAiErrorMessage(t, { code: 'AI_TEXT_INVALID' })).toBe('reader.ai.error.textInvalid');
    expect(readerAiErrorMessage(t, { code: 'AI_TEXT_EMPTY' })).toBe('reader.ai.error.textEmpty');
    expect(readerAiErrorMessage(t, { code: 'AI_REQUEST_INVALID' })).toBe(
      'reader.ai.error.requestInvalid',
    );
    expect(readerAiErrorMessage(t, { code: 'AI_RESPONSE_INVALID' })).toBe(
      'reader.ai.error.responseInvalid',
    );
  });

  it('matches the exact AI code even when the message mentions other causes', () => {
    expect(readerAiErrorMessage(t, { code: 'AI_HTTP_ERROR', message: 'network unavailable' })).toBe(
      'reader.ai.error.failed',
    );
  });

  it('unwraps JSON-string AI errors and falls back for unknown codes', () => {
    expect(
      readerAiErrorMessage(t, JSON.stringify({ code: 'AI_MODEL_NOT_FOUND', message: 'no model' })),
    ).toBe('reader.ai.error.modelNotFound');
    expect(readerAiErrorMessage(t, { code: 'AI_WHATEVER' })).toBe('reader.ai.error.failed');
  });

  it('fills the unconfigured copy with the missing-factors list', () => {
    // t 返回 key 本身,占位符替换用真实文案断言:
    expect(readerAiErrorMessage(englishT, { code: 'AI_NOT_CONFIGURED' }, ['model', 'api_key'])).toBe(
      translate('en', 'reader.ai.error.unconfigured').replace('{missing}', 'model, api_key'),
    );
    expect(readerAiErrorMessage(t, { code: 'AI_NOT_CONFIGURED' })).toBe('reader.ai.unconfigured');
  });
});

describe('aiTranslateTargetLang', () => {
  it('prefers the AI group override and maps known codes to language names', () => {
    expect(aiTranslateTargetLang(englishT, 'en', 'ja')).toBe('日本語');
    expect(aiTranslateTargetLang(englishT, 'zh-CN', 'de')).toBe('Deutsch');
  });

  it('follows the interface language when the override is auto or unset', () => {
    expect(aiTranslateTargetLang(englishT, 'zh-CN', 'auto')).toBe('简体中文');
    expect(aiTranslateTargetLang(englishT, 'zh-CN', undefined)).toBe('简体中文');
    expect(aiTranslateTargetLang(englishT, 'en', '  ')).toBe('English');
  });

  it('passes unknown override values through for the prompt', () => {
    expect(aiTranslateTargetLang(englishT, 'en', 'Pirate English')).toBe('Pirate English');
  });

  it('matches known codes case-insensitively', () => {
    expect(aiTranslateTargetLang(englishT, 'en', 'ZH-CN')).toBe('简体中文');
    expect(aiTranslateTargetLang(englishT, 'en', 'Ja')).toBe('日本語');
  });
});

describe('initialTranslateSections', () => {
  it('renders a loading AI section when configured', () => {
    expect(initialTranslateSections(t, true)).toEqual([{ source: 'ai', status: 'loading' }]);
  });

  it('reports an unconfigured error section on a config race', () => {
    expect(initialTranslateSections(t, false)).toEqual([
      { source: 'ai', status: 'error', message: 'reader.ai.unconfigured' },
    ]);
  });
});

describe('parseAiTranslateConfig', () => {
  it('reads configured state, missing gaps and the target-language override', () => {
    expect(parseAiTranslateConfig({ configured: true, missing: [], targetLang: 'ja' })).toEqual({
      configured: true,
      targetLang: 'ja',
      missing: [],
    });
    expect(
      parseAiTranslateConfig({ configured: false, missing: ['model'], targetLang: '' }),
    ).toEqual({ configured: false, targetLang: undefined, missing: ['model'] });
  });

  it('treats an empty missing list as configured even without the flag', () => {
    expect(parseAiTranslateConfig({ missing: [] }).configured).toBe(true);
  });

  it('falls back to unconfigured for malformed payloads', () => {
    expect(parseAiTranslateConfig(undefined)).toEqual({ configured: false, missing: [] });
    expect(parseAiTranslateConfig('nope')).toEqual({ configured: false, missing: [] });
  });
});

describe('parseAiTranslateResult', () => {
  it('reads the translation text, target language and truncation flag', () => {
    expect(
      parseAiTranslateResult({ text: ' 译文 ', targetLang: '简体中文', truncated: true }),
    ).toEqual({ text: '译文', targetLang: '简体中文', truncated: true });
    expect(parseAiTranslateResult({ text: 'ok' })).toEqual({
      text: 'ok',
      targetLang: '',
      truncated: false,
    });
  });

  it('returns an empty view for malformed payloads', () => {
    expect(parseAiTranslateResult(null)).toEqual({ text: '', targetLang: '', truncated: false });
  });
});

describe('lookup panel translate sections', () => {
  const host = (): HTMLElement => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
  };

  const sectionElement = (panel: HTMLElement, source: string): HTMLElement | null =>
    panel.querySelector<HTMLElement>(`.lightink-reader-lookup-source[data-source="${source}"]`);

  it('renders the AI section with independent statuses', () => {
    const panel = createLookupPanel({ t });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'loading', message: 'reader.lookup.translateLoading' }],
      },
      host(),
    );
    expect(panel.element.hidden).toBe(false);
    expect(panel.element.dataset.lookupStatus).toBe('multi');
    expect(sectionElement(panel.element, 'ai')?.dataset.status).toBe('loading');
    expect(sectionElement(panel.element, 'ai')?.textContent).toContain(
      'reader.lookup.translateLoading',
    );
  });

  it('retries a failed AI section in place', () => {
    const onRetryTranslate = vi.fn();
    const panel = createLookupPanel({ t, onRetryTranslate });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'error', message: 'reader.ai.error.network' }],
      },
      host(),
    );
    const retry = sectionElement(panel.element, 'ai')?.querySelector<HTMLButtonElement>(
      '.lightink-reader-lookup-source-action',
    );
    expect(retry?.textContent).toBe('reader.lookup.retry');
    retry!.click();
    expect(onRetryTranslate).toHaveBeenCalledWith('ai', 'selectable');
  });

  it('updates the AI section in place and shows the truncation hint', () => {
    const panel = createLookupPanel({ t });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'loading' }],
      },
      host(),
    );
    panel.updateTranslateSection({
      source: 'ai',
      status: 'ready',
      lines: ['AI 译文'],
      truncated: true,
    });
    const ai = sectionElement(panel.element, 'ai');
    expect(ai?.dataset.status).toBe('ready');
    expect(ai?.textContent).toContain('AI 译文');
    expect(ai?.querySelector('.lightink-reader-lookup-hint')?.textContent).toBe(
      'reader.lookup.aiTruncated',
    );
  });

  it('shows a target-language switch on translate and hides it for lookup', () => {
    const onChangeTargetLang = vi.fn();
    const panel = createLookupPanel({ t: englishT, onChangeTargetLang });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'ready', lines: ['译文'] }],
        targetLang: 'ja',
      },
      host(),
    );
    const lang = panel.element.querySelector<HTMLSelectElement>('.lightink-reader-lookup-lang');
    expect(lang?.hidden).toBe(false);
    expect(lang?.value).toBe('ja');
    lang!.value = 'en';
    lang!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChangeTargetLang).toHaveBeenCalledWith('en', 'selectable');

    panel.show(
      { kind: 'lookup', quote: 'word', status: 'ready', lines: ['gloss'] },
      host(),
    );
    expect(lang?.hidden).toBe(true);
  });

  it('normalizes unknown target-language codes to auto', () => {
    expect(normalizeLookupTargetLang(undefined)).toBe('auto');
    expect(normalizeLookupTargetLang('ZH-CN')).toBe('zh-CN');
    expect(normalizeLookupTargetLang('pirate')).toBe('auto');
  });

  it('ignores section updates while the panel is not in the translate view', () => {
    const panel = createLookupPanel({ t });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'loading' }],
      },
      host(),
    );
    panel.hide();
    panel.updateTranslateSection({ source: 'ai', status: 'ready', lines: ['AI 译文'] });
    panel.showTranslate(
      {
        quote: 'selectable',
        sections: [{ source: 'ai', status: 'idle' }],
      },
      host(),
    );
    expect(sectionElement(panel.element, 'ai')?.dataset.status).toBe('idle');
    expect(sectionElement(panel.element, 'ai')?.textContent).not.toContain('AI 译文');
  });
});

describe('selection toolbar AI translate action', () => {
  const buttonByAction = (
    toolbar: ReturnType<typeof createSelectionToolbar>,
    action: string,
  ): HTMLButtonElement | null =>
    toolbar.element.querySelector<HTMLButtonElement>(
      `.lightink-reader-selection-action--${action}`,
    );

  it('hides the AI translate action until the provider is configured', () => {
    const actions: string[] = [];
    const toolbar = createSelectionToolbar({ t, onAction: (action) => actions.push(action) });
    document.body.appendChild(toolbar.element);
    toolbar.showAt({ left: 100, top: 100, width: 80, height: 20 }, { canRemoveHighlight: false });
    const ai = buttonByAction(toolbar, 'aiTranslate')!;
    expect(ai.hidden).toBe(true);
    expect(ai.disabled).toBe(true);
    ai.click();
    expect(actions).toEqual([]);

    toolbar.setAiTranslateEnabled(true);
    expect(ai.hidden).toBe(false);
    expect(ai.disabled).toBe(false);
    ai.click();
    expect(actions).toEqual(['aiTranslate']);
    toolbar.destroy();
  });

  it('applies the AI visibility passed to showAt', () => {
    const toolbar = createSelectionToolbar({ t, onAction: () => undefined });
    document.body.appendChild(toolbar.element);
    toolbar.showAt(
      { left: 100, top: 100, width: 80, height: 20 },
      { canRemoveHighlight: false, aiTranslateEnabled: true },
    );
    expect(buttonByAction(toolbar, 'aiTranslate')!.hidden).toBe(false);
    toolbar.showAt(
      { left: 100, top: 100, width: 80, height: 20 },
      { canRemoveHighlight: false, aiTranslateEnabled: false },
    );
    expect(buttonByAction(toolbar, 'aiTranslate')!.hidden).toBe(true);
    toolbar.destroy();
  });
});
