// @vitest-environment jsdom

/**
 * `help-guide`（R2 / ADR-3）契约：
 *
 * - 六类任务章节（import / sources / ai / sync / stealth / export）按固定
 *   顺序渲染，文案全部来自 messages.ts 目录——用生产 `translate` 对两个
 *   locale 逐一断言「键存在且非空」（缺键会回显键名本身）。
 * - 挂载即 modal-focus 一次性对话框：role=dialog、背景 inert、底部关闭
 *   按钮初始聚焦；Esc / 遮罩 / × / 底部按钮都能拆除并恢复背景。
 * - labels 经 getter 读取，retranslate() 即语言切换覆盖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { translate, type LocaleId, type MessageKey } from '../../i18n/messages.js';
import {
  buildHelpGuideLabels,
  HELP_GUIDE_SECTION_IDS,
  OPEN_HELP_GUIDE_EVENT,
  openHelpGuide,
  type HelpGuideHandle,
} from '../help-guide.js';

const t =
  (locale: LocaleId) =>
  (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
    translate(locale, key, vars);

function openGuide(locale: LocaleId = 'zh-CN'): HelpGuideHandle {
  return openHelpGuide(document, {
    labels: () => buildHelpGuideLabels(t(locale)),
  });
}

function overlayOf(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-help-guide-overlay');
}

function actionButton(action: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-help-guide-action="${action}"]`,
  );
  if (button === null) throw new Error(`help-guide action button not found: ${action}`);
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('help-guide labels（messages.ts 双语完整）', () => {
  it('六个章节 id 顺序固定（R2 验收范围）', () => {
    expect([...HELP_GUIDE_SECTION_IDS]).toEqual([
      'import',
      'sources',
      'ai',
      'sync',
      'stealth',
      'export',
    ]);
  });

  it('两个 locale 的标题/正文键齐全且非空（缺键回显键名即失败）', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const labels = buildHelpGuideLabels(t(locale));
      expect(labels.title).not.toBe('help.guide.title');
      expect(labels.intro).not.toBe('help.guide.intro');
      expect(labels.close).not.toBe('');
      expect(labels.sections).toHaveLength(HELP_GUIDE_SECTION_IDS.length);
      for (const section of labels.sections) {
        expect(section.title).not.toBe(`help.guide.${section.id}.title`);
        expect(section.title.trim()).not.toBe('');
        expect(section.body).not.toBe(`help.guide.${section.id}.body`);
        expect(section.body.trim()).not.toBe('');
      }
    }
  });
});

describe('help-guide 对话框', () => {
  it('挂载 modal-focus 对话框：六个章节按序渲染 + 底部关闭按钮初始聚焦', () => {
    const guide = openGuide('zh-CN');
    const overlay = overlayOf();
    expect(overlay).toBe(guide.element);
    expect(document.body.contains(overlay)).toBe(true);
    const dialog = overlay?.querySelector<HTMLElement>('.lightink-help-guide');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(
      dialog?.querySelector('.lightink-modal-title')?.id,
    );
    const sections = Array.from(
      overlay?.querySelectorAll<HTMLElement>('[data-help-section]') ?? [],
    );
    expect(sections.map((s) => s.dataset.helpSection)).toEqual([...HELP_GUIDE_SECTION_IDS]);
    expect(overlay?.textContent).toContain('轻墨使用指南');
    expect(overlay?.textContent).toContain('导入本地书籍');
    expect(overlay?.textContent).toContain('摸鱼（隐身）模式');
    expect(document.activeElement).toBe(actionButton('close'));
  });

  it('背景 inert，Esc / 遮罩 / × / 底部按钮都拆除并恢复背景交互', () => {
    const sibling = document.createElement('div');
    document.body.appendChild(sibling);

    const first = openGuide();
    expect(sibling.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(first.element)).toBe(false);
    expect(sibling.inert).toBeFalsy();

    const second = openGuide();
    actionButton('dismiss').click();
    expect(document.body.contains(second.element)).toBe(false);

    const third = openGuide();
    actionButton('close').click();
    expect(document.body.contains(third.element)).toBe(false);

    const fourth = openGuide();
    fourth.element.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(document.body.contains(fourth.element)).toBe(false);
  });

  it('retranslate 按 labels getter 重渲染（语言切换覆盖）', () => {
    let locale: LocaleId = 'zh-CN';
    const guide = openHelpGuide(document, { labels: () => buildHelpGuideLabels(t(locale)) });
    expect(guide.element.textContent).toContain('轻墨使用指南');
    locale = 'en';
    guide.retranslate();
    expect(guide.element.textContent).toContain('LightInk Usage Guide');
    expect(guide.element.textContent).not.toContain('轻墨使用指南');
  });

  it('关闭后 retranslate 空操作（不再触碰 DOM）', () => {
    const guide = openGuide();
    guide.close();
    expect(() => guide.retranslate()).not.toThrow();
  });

  it('打开事件名稳定（app-shell 菜单与 main 监听共用）', () => {
    expect(OPEN_HELP_GUIDE_EVENT).toBe('lightink:open-help-guide');
  });
});
