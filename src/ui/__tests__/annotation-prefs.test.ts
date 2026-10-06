/**
 * Reader annotation i18n keys + first-time preference helpers.
 */

import { describe, expect, it } from 'vitest';

import { translate, type MessageKey } from '../../i18n/messages.js';
import {
  ANNOTATION_FIRST_TIME_KEY,
  loadAnnotationFirstTime,
  saveAnnotationFirstTime,
} from '../chrome-prefs.js';

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getItem(key) {
      return store[key] ?? null;
    },
    setItem(key, value) {
      store[key] = value;
    },
  };
}

function throwingStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  return {
    getItem() {
      throw new Error('storage unavailable');
    },
    setItem() {
      throw new Error('storage unavailable');
    },
  };
}

const NEW_KEYS: ReadonlyArray<{
  key: MessageKey;
  en: string;
  zh: string;
  vars?: Readonly<Record<string, string>>;
}> = [
  { key: 'annotation.toast.highlighted', en: 'Highlighted', zh: '已高亮' },
  { key: 'annotation.toast.unhighlighted', en: 'Removed highlight', zh: '已取消高亮' },
  { key: 'annotation.toast.noteAdded', en: 'Note saved', zh: '笔记已保存' },
  { key: 'annotation.toast.noteRemoved', en: 'Note removed', zh: '笔记已删除' },
  { key: 'bookmark.toast.added', en: 'Bookmark added', zh: '已添加书签' },
  { key: 'bookmark.toast.removed', en: 'Bookmark removed', zh: '已移除书签' },
  {
    key: 'annotation.empty.hint',
    en: 'Select text, then highlight or add a note',
    zh: '选中正文后即可高亮或写笔记',
  },
  { key: 'reader.search.scanning', en: 'Searching…', zh: '仍在搜索中…' },
  {
    key: 'reader.search.empty.hint',
    en: 'Try different keywords, or check the search scope',
    zh: '换个词试试，或检查正文范围',
  },
  {
    key: 'reader.sidebar.groupHeader',
    en: 'Chapter {chapter} · {count}',
    zh: '第 {chapter} 章 · {count} 条',
    vars: { chapter: '5', count: '3' },
  },
  {
    key: 'reader.footer.remaining',
    en: '{n} {suffix} left',
    zh: '还剩 {n} {suffix}',
    vars: { n: '8', suffix: '章' },
  },
];

describe('R16–R24 新增 i18n 键', () => {
  for (const entry of NEW_KEYS) {
    it(`${entry.key} 同时存在中英文且非空`, () => {
      const en = translate('en', entry.key, entry.vars);
      const zh = translate('zh-CN', entry.key, entry.vars);
      expect(en.length).toBeGreaterThan(0);
      expect(zh.length).toBeGreaterThan(0);
      expect(en).not.toBe(entry.key);
      expect(zh).not.toBe(entry.key);
    });
  }

  it('变量键按 vars 替换，不留占位符', () => {
    expect(translate('en', 'reader.sidebar.groupHeader', { chapter: '7', count: '12' })).toBe(
      'Chapter 7 · 12',
    );
    expect(
      translate('zh-CN', 'reader.sidebar.groupHeader', { chapter: '7', count: '12' }),
    ).toBe('第 7 章 · 12 条');
    expect(translate('en', 'reader.footer.remaining', { n: '10', suffix: 'chapter(s)' })).toBe(
      '10 chapter(s) left',
    );
    expect(translate('zh-CN', 'reader.footer.remaining', { n: '10', suffix: '页' })).toBe(
      '还剩 10 页',
    );
  });
});

describe('annotation first-time 偏好', () => {
  it('无存储 / 空存储默认首次（true）', () => {
    expect(loadAnnotationFirstTime(null)).toBe(true);
    expect(loadAnnotationFirstTime(memoryStorage())).toBe(true);
  });

  it('save(false) 后返回 false；save(true) 后恢复 true', () => {
    const storage = memoryStorage();
    saveAnnotationFirstTime(storage, false);
    expect(loadAnnotationFirstTime(storage)).toBe(false);
    expect(storage.store[ANNOTATION_FIRST_TIME_KEY]).toBe('false');

    saveAnnotationFirstTime(storage, true);
    expect(loadAnnotationFirstTime(storage)).toBe(true);
    expect(storage.store[ANNOTATION_FIRST_TIME_KEY]).toBe('true');
  });

  it('存储读取异常回落默认（true）', () => {
    expect(loadAnnotationFirstTime(throwingStorage())).toBe(true);
  });

  it('存储写入异常不抛出', () => {
    expect(() => saveAnnotationFirstTime(throwingStorage(), false)).not.toThrow();
  });

  it('损坏 JSON 回落默认（true）', () => {
    expect(
      loadAnnotationFirstTime(memoryStorage({ [ANNOTATION_FIRST_TIME_KEY]: 'not-json' })),
    ).toBe(true);
  });
});
