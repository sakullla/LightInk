/**
 * slash-menu 纯逻辑测试（R11）：行首 `/query` 识别与菜单环形选择。
 *
 * 不覆盖（需挂载编辑器/DOM）：Decoration.widget 浮层、键位（Esc/Enter/方向键）、
 * replaceRange 插入、菜单项点击 —— 属编辑器集成面，同既有插件仅断言工厂形态。
 */
import { describe, expect, it } from 'vitest';

import {
  nextIndex,
  parseSlashQuery,
  placeSlashMenu,
  scrollSlashItemIntoView,
  slashMenuHeightForItems,
  slashMenuPlugin,
  SLASH_MENU_VISIBLE_ITEMS,
} from '../slash-menu.js';
import { filterInsertElements } from '../../insert-commands.js';

describe('parseSlashQuery (R11)', () => {
  it('detects a line-start slash with a query', () => {
    expect(parseSlashQuery('/')).toEqual({ query: '' });
    expect(parseSlashQuery('/heading')).toEqual({ query: 'heading' });
    expect(parseSlashQuery('/表')).toEqual({ query: '表' });
  });

  it('returns null when the slash is not at line start', () => {
    expect(parseSlashQuery('text/heading')).toBeNull();
    expect(parseSlashQuery(' /x')).toBeNull();
    expect(parseSlashQuery('foo /x')).toBeNull();
  });

  it('returns null when the query contains whitespace (command ended)', () => {
    expect(parseSlashQuery('/he ading')).toBeNull();
    expect(parseSlashQuery('/x ')).toBeNull();
    expect(parseSlashQuery('/\n')).toBeNull();
  });

  it('returns null for empty or non-slash input', () => {
    expect(parseSlashQuery('')).toBeNull();
    expect(parseSlashQuery('heading')).toBeNull();
    expect(parseSlashQuery('# heading')).toBeNull();
  });
});

describe('nextIndex (R11 menu navigation)', () => {
  it('moves forward and wraps around', () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(4, 1, 5)).toBe(0); // 末尾→首项
  });

  it('moves backward and wraps around', () => {
    expect(nextIndex(1, -1, 5)).toBe(0);
    expect(nextIndex(0, -1, 5)).toBe(4); // 首项→末项
  });

  it('clamps to 0 for empty lists', () => {
    expect(nextIndex(3, 1, 0)).toBe(0);
    expect(nextIndex(0, -1, 0)).toBe(0);
  });
});

describe('placeSlashMenu (viewport placement)', () => {
  it('opens below the caret when there is room', () => {
    const p = placeSlashMenu(
      { left: 40, top: 100, bottom: 120 },
      { width: 220, height: 280 },
      { width: 1280, height: 800 },
    );
    expect(p.flipUp).toBe(false);
    expect(p.top).toBeGreaterThanOrEqual(120);
    expect(p.maxHeight).toBeGreaterThan(100);
  });

  it('caps height to ~5 visible items (scroll for the rest)', () => {
    const five = slashMenuHeightForItems(SLASH_MENU_VISIBLE_ITEMS);
    expect(five).toBe(184); // 5*32 + 4*2 + 16
    const p = placeSlashMenu(
      { left: 40, top: 100, bottom: 120 },
      { width: 220, height: 400 }, // natural height of a long list
      { width: 1280, height: 800 },
    );
    expect(p.maxHeight).toBeLessThanOrEqual(five);
    expect(p.maxHeight).toBe(five);
  });

  it('flips upward near the bottom of the viewport', () => {
    const p = placeSlashMenu(
      { left: 40, top: 700, bottom: 720 },
      { width: 220, height: 280 },
      { width: 1280, height: 760 },
    );
    expect(p.flipUp).toBe(true);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(720);
  });

  it('keeps the menu inside horizontal bounds', () => {
    const p = placeSlashMenu(
      { left: 1200, top: 100, bottom: 120 },
      { width: 220, height: 200 },
      { width: 1280, height: 800 },
    );
    expect(p.left + 220).toBeLessThanOrEqual(1280);
  });
});

describe('slash-menu filtering uses shared INSERT_ELEMENTS', () => {
  it('narrows the shared catalog by keyword at the slash-menu entry', () => {
    expect(filterInsertElements('表格').map((e) => e.id)).toContain('table');
  });
});

describe('scrollSlashItemIntoView', () => {
  it('adjusts menu.scrollTop without using scrollIntoView', () => {
    const menu = {
      scrollTop: 0,
      clientHeight: 100,
    } as HTMLElement;
    const item = {
      offsetTop: 160,
      offsetHeight: 32,
    } as HTMLElement;
    scrollSlashItemIntoView(menu, item);
    expect(menu.scrollTop).toBe(160 + 32 - 100);
    const upper = {
      offsetTop: 10,
      offsetHeight: 32,
    } as HTMLElement;
    menu.scrollTop = 50;
    scrollSlashItemIntoView(menu, upper);
    expect(menu.scrollTop).toBe(10);
  });
});

describe('slashMenuPlugin (Milkdown wiring)', () => {
  it('exposes the Milkdown $prose plugin factory shape', () => {
    expect(slashMenuPlugin).toBeDefined();
    expect(typeof slashMenuPlugin).toBe('function');
    const shaped = slashMenuPlugin as unknown as {
      plugin: () => unknown;
      key: () => unknown;
    };
    expect(typeof shaped.plugin).toBe('function');
    expect(typeof shaped.key).toBe('function');
    // 未经 Milkdown ctx 运行前，内部 plugin 尚未实例化。
    expect(shaped.plugin()).toBeUndefined();
  });
});
