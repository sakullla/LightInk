/**
 * 纸卡模式（纸墨工作室 §3.10）偏好逻辑测试（headless）。
 *
 * 覆盖：默认开、显式 false 关闭、损坏值回退默认、隐私模式存储异常吞错、
 * 宿主类开关往返、save 与 resolve 的往返。
 */
import { describe, expect, it } from 'vitest';

import {
  applyPaperCardClass,
  PAPER_CARD_CLASS,
  PAPER_CARD_DEFAULT,
  PAPER_CARD_STORAGE_KEY,
  resolvePaperCardEnabled,
  savePaperCardEnabled,
} from '../paper-card.js';

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    key() {
      return null;
    },
  } as Storage;
}

/** 最小 fake 元素（仅 classList 子集）。 */
function fakeElement(): HTMLElement {
  const classes = new Set<string>();
  return {
    classList: {
      add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(c) : force;
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
    },
  } as unknown as HTMLElement;
}

describe('resolvePaperCardEnabled', () => {
  it('缺省/键缺失时返回默认（开）', () => {
    expect(PAPER_CARD_DEFAULT).toBe(true);
    expect(resolvePaperCardEnabled(undefined)).toBe(true);
    expect(resolvePaperCardEnabled(null)).toBe(true);
    expect(resolvePaperCardEnabled(memoryStorage())).toBe(true);
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: '' }))).toBe(true);
  });

  it('显式 false / "false" / "0" 关闭，true / "true" / "1" 开启', () => {
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: 'false' }))).toBe(false);
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: '0' }))).toBe(false);
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: 'true' }))).toBe(true);
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: '1' }))).toBe(true);
  });

  it('损坏值回退默认；存储抛错吞错回退默认', () => {
    expect(resolvePaperCardEnabled(memoryStorage({ [PAPER_CARD_STORAGE_KEY]: 'banana' }))).toBe(true);
    const throwing = {
      getItem: () => {
        throw new Error('privacy mode');
      },
      setItem: () => undefined,
    };
    expect(resolvePaperCardEnabled(throwing)).toBe(true);
  });
});

describe('savePaperCardEnabled / applyPaperCardClass', () => {
  it('save→resolve 往返；写失败静默', () => {
    const storage = memoryStorage();
    savePaperCardEnabled(storage, false);
    expect(storage.getItem(PAPER_CARD_STORAGE_KEY)).toBe('false');
    expect(resolvePaperCardEnabled(storage)).toBe(false);
    savePaperCardEnabled(storage, true);
    expect(resolvePaperCardEnabled(storage)).toBe(true);

    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => savePaperCardEnabled(failing, false)).not.toThrow();
  });

  it('按开关加/去宿主纸卡类', () => {
    const el = fakeElement();
    expect(applyPaperCardClass(el, true)).toBe(true);
    expect(el.classList.contains(PAPER_CARD_CLASS)).toBe(true);
    expect(applyPaperCardClass(el, false)).toBe(false);
    expect(el.classList.contains(PAPER_CARD_CLASS)).toBe(false);
  });
});
