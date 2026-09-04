import { describe, expect, it } from 'vitest';

import { createI18n, loadLocale } from '../i18n.js';
import { translate } from '../messages.js';

describe('translate', () => {
  it('returns zh / en strings and interpolates', () => {
    expect(translate('zh-CN', 'file.save')).toBe('保存');
    expect(translate('en', 'file.save')).toBe('Save');
    expect(translate('en', 'reader.chrome.backToShelf')).toBe('Back to Shelf');
    expect(translate('zh-CN', 'reader.chrome.backToShelf')).toBe('返回书架');
    expect(translate('en', 'reader.chrome.toc')).toBe('Contents');
    expect(translate('zh-CN', 'reader.chrome.toc')).toBe('目录');
    expect(translate('en', 'reader.chrome.typography')).toBe('Typography');
    expect(translate('zh-CN', 'reader.chrome.typography')).toBe('排版');
    expect(translate('en', 'reader.chrome.bookmark')).toBe('Bookmark');
    expect(translate('zh-CN', 'reader.chrome.bookmark')).toBe('书签');
    expect(translate('en', 'reader.chrome.search')).toBe('Search');
    expect(translate('zh-CN', 'reader.chrome.search')).toBe('搜索');
    expect(translate('en', 'dialog.closeTab.message', { title: 'a.md' })).toContain('a.md');
  });
});

describe('createI18n', () => {
  it('persists locale and notifies subscribers', () => {
    const store: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    const i18n = createI18n(storage, 'en');
    expect(i18n.t('menu.file')).toBe('File');
    let seen = '';
    const unsub = i18n.subscribe((loc) => {
      seen = loc;
    });
    i18n.setLocale('zh-CN');
    expect(seen).toBe('zh-CN');
    expect(i18n.t('menu.file')).toBe('文件');
    expect(loadLocale(storage)).toBe('zh-CN');
    unsub();
  });
});
