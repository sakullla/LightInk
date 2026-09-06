import { describe, expect, it } from 'vitest';

import { readerAidErrorMessage } from '../lookup-panel.js';
import type { MessageKey } from '../../i18n/messages.js';

const t = (key: MessageKey): string => key;

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
