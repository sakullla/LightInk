// @vitest-environment jsdom

/**
 * friendly-error（R4/ADR-5）测试：对象/JSON 字符串/普通字符串三类输入的
 * 码表命中、未识别兜底与原始 message 保留。
 */

import { describe, expect, it, vi } from 'vitest';

import { friendlyError } from '../friendly-error.js';
import { translate } from '../../i18n/messages.js';

const CODE_TITLES = {
  SYNC_URL_INVALID: 'sync.error.urlInvalid',
  SYNC_NETWORK_ERROR: 'sync.error.network',
  BOOK_SOURCE_HTTP_ERROR: 'bookDownload.error.sourceHttpError',
} as const;

function format(error: unknown, locale: 'en' | 'zh-CN' = 'zh-CN') {
  return friendlyError(error, {
    codeTitles: CODE_TITLES,
    fallbackTitle: 'sync.error.fallback',
    t: (key, vars) => translate(locale, key, vars),
  });
}

describe('friendlyError', () => {
  it('maps a structured object code to the localized title and keeps the raw message as detail', () => {
    const labels = format({ code: 'SYNC_URL_INVALID', message: 'WebDAV 地址格式无效' });
    expect(labels.title).toBe('WebDAV 地址无效。');
    expect(labels.detail).toBe('WebDAV 地址格式无效');
  });

  it('parses a JSON string error the same way as an object', () => {
    const labels = format(
      JSON.stringify({ code: 'SYNC_NETWORK_ERROR', message: 'error sending request' }),
    );
    expect(labels.title).toBe('无法连接 WebDAV 服务器，请检查地址与网络。');
    expect(labels.detail).toBe('error sending request');
  });

  it('degrades unrecognized codes to the fallback title plus the raw detail', () => {
    const labels = format({ code: 'SOMETHING_ELSE', message: 'boom' });
    expect(labels.title).toBe('同步失败');
    expect(labels.detail).toBe('boom');
  });

  it('uses the fallback title for plain strings and Error instances', () => {
    expect(format('raw backend failure')).toEqual({
      title: '同步失败',
      detail: 'raw backend failure',
    });
    expect(format(new Error('disk is read-only'))).toEqual({
      title: '同步失败',
      detail: 'disk is read-only',
    });
  });

  it('translates titles per the injected locale', () => {
    const labels = format({ code: 'SYNC_URL_INVALID', message: 'bad' }, 'en');
    expect(labels.title).toBe('The WebDAV address is invalid.');
  });

  it('passes a numeric status through as the {status} interpolation variable', () => {
    const labels = format({
      code: 'BOOK_SOURCE_HTTP_ERROR',
      message: 'HTTP 503',
      status: 503,
    });
    expect(labels.title).toBe('书源返回 HTTP 503。');
    expect(labels.detail).toBe('HTTP 503');
  });

  it('returns an empty detail (or the injected fallback) for message-less errors', () => {
    expect(format(undefined)).toEqual({ title: '同步失败', detail: '' });
    expect(format(null, 'en')).toEqual({ title: 'Sync failed', detail: '' });
    expect(
      friendlyError('', {
        fallbackTitle: 'sync.error.fallback',
        t: (key) => translate('zh-CN', key),
        emptyDetail: 'no message',
      }),
    ).toEqual({ title: '同步失败', detail: 'no message' });
  });

  it('never calls the translator with a key outside the injected table', () => {
    const t = vi.fn((key: Parameters<typeof translate>[1]) => translate('zh-CN', key));
    friendlyError({ code: 'UNKNOWN_CODE', message: 'x' }, {
      codeTitles: CODE_TITLES,
      fallbackTitle: 'sync.error.fallback',
      t,
    });
    expect(t).toHaveBeenCalledWith('sync.error.fallback', undefined);
  });
});
