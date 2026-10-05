// @vitest-environment jsdom

/**
 * `onboarding-guide`（R1 / ADR-2）契约：
 *
 * - 设备本地标记 `lightink.onboarding.done`：读写直接走 window.localStorage，
 *   缺窗口 / 存储异常按未引导（读）与静默（写）处理，不向上抛。
 * - 挂载即 modal-focus 一次性对话框：role=dialog、背景 inert、主按钮初始聚焦，
 *   关闭后恢复背景交互。
 * - 跳过 / 开始使用 / × / Esc / 遮罩点击 / 两个动作——任何关闭路径都先写完成
 *   标记再拆除；动作按钮关闭后回调宿主接线（导入本地书籍 / 添加书源）。
 * - labels 经 getter 读取，retranslate() 即语言切换覆盖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ONBOARDING_DONE_KEY,
  openOnboardingGuide,
  readOnboardingDone,
  writeOnboardingDone,
  type OnboardingGuideHandle,
  type OnboardingGuideLabels,
} from '../onboarding-guide.js';

const zhLabels: OnboardingGuideLabels = {
  title: '欢迎使用轻墨',
  intro: '书架与编辑器双表面说明',
  capabilitiesTitle: '核心能力',
  capabilityImport: '导入本地书籍',
  capabilitySources: '浏览书源',
  capabilityEdit: '写作批注',
  capabilityRead: '沉浸阅读',
  capabilityExport: '导出',
  capabilityStealth: '摸鱼模式',
  importAction: '导入本地书籍',
  addSourceAction: '添加书源',
  skip: '跳过',
  start: '开始使用',
};

function openGuide(
  overrides: {
    labels?: () => OnboardingGuideLabels;
    onImport?: () => void;
    onAddSource?: () => void;
  } = {},
): OnboardingGuideHandle {
  return openOnboardingGuide(document, {
    labels: overrides.labels ?? (() => zhLabels),
    onImport: overrides.onImport ?? (() => undefined),
    onAddSource: overrides.onAddSource ?? (() => undefined),
  });
}

function actionButton(action: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-onboarding-action="${action}"]`,
  );
  if (button === null) throw new Error(`onboarding action button not found: ${action}`);
  return button;
}

function guideOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-onboarding-overlay');
}

afterEach(() => {
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('onboarding 完成标记（设备本地）', () => {
  it('缺省未引导；写入后已引导', () => {
    expect(readOnboardingDone(window)).toBe(false);
    writeOnboardingDone(window);
    expect(readOnboardingDone(window)).toBe(true);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('window 缺失按未引导处理，写入静默不抛', () => {
    expect(readOnboardingDone(null)).toBe(false);
    expect(() => writeOnboardingDone(null)).not.toThrow();
  });

  it('localStorage 抛异常时读取按未引导、写入不抛（隐私模式边界）', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readOnboardingDone(window)).toBe(false);
    expect(() => writeOnboardingDone(window)).not.toThrow();
  });
});

describe('onboarding 引导对话框', () => {
  it('挂载 modal-focus 对话框：双表面说明 + 六项能力清单 + 主按钮初始聚焦', () => {
    const guide = openGuide();
    const overlay = guideOverlay();
    expect(overlay).toBe(guide.element);
    expect(document.body.contains(overlay)).toBe(true);
    const dialog = overlay?.querySelector<HTMLElement>('.lightink-onboarding');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe(
      dialog?.querySelector('.lightink-modal-title')?.id,
    );
    expect(overlay?.textContent).toContain('欢迎使用轻墨');
    expect(overlay?.textContent).toContain('书架与编辑器双表面说明');
    expect(overlay?.querySelectorAll('.lightink-onboarding-capabilities li')).toHaveLength(6);
    expect(document.activeElement).toBe(actionButton('import'));
  });

  it('背景 inert，关闭后恢复并写完成标记', () => {
    const sibling = document.createElement('div');
    document.body.appendChild(sibling);
    const guide = openGuide();
    expect(sibling.inert).toBe(true);
    guide.close();
    // 恢复到打开前的取值（jsdom 下反射属性初值可能是 undefined）。
    expect(sibling.inert).toBeFalsy();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('「跳过」与「开始使用」都写标记并关闭', () => {
    const guide = openGuide();
    actionButton('skip').click();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();

    window.localStorage.removeItem(ONBOARDING_DONE_KEY);
    const second = openGuide();
    actionButton('start').click();
    expect(document.body.contains(second.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('角标 × 与 Esc 同样写标记并关闭', () => {
    const guide = openGuide();
    actionButton('dismiss').click();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();

    window.localStorage.removeItem(ONBOARDING_DONE_KEY);
    const second = openGuide();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(second.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('「导入本地书籍」写标记、关闭并只回调导入接线', () => {
    const onImport = vi.fn();
    const onAddSource = vi.fn();
    const guide = openGuide({ onImport, onAddSource });
    actionButton('import').click();
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onAddSource).not.toHaveBeenCalled();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('「添加书源」写标记、关闭并只回调书源接线', () => {
    const onImport = vi.fn();
    const onAddSource = vi.fn();
    const guide = openGuide({ onImport, onAddSource });
    actionButton('add-source').click();
    expect(onAddSource).toHaveBeenCalledTimes(1);
    expect(onImport).not.toHaveBeenCalled();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).not.toBeNull();
  });

  it('retranslate 按 labels getter 重渲染（语言切换覆盖）', () => {
    let current: OnboardingGuideLabels = { ...zhLabels };
    const guide = openGuide({ labels: () => current });
    expect(guide.element.textContent).toContain('欢迎使用轻墨');
    current = { ...zhLabels, title: 'Welcome to LightInk', start: 'Get started' };
    guide.retranslate();
    expect(guide.element.textContent).toContain('Welcome to LightInk');
    expect(guide.element.textContent).toContain('Get started');
    expect(guide.element.textContent).not.toContain('欢迎使用轻墨');
  });

  it('destroy 只拆除不写标记（宿主卸载路径）', () => {
    const guide = openGuide();
    guide.destroy();
    expect(document.body.contains(guide.element)).toBe(false);
    expect(window.localStorage.getItem(ONBOARDING_DONE_KEY)).toBeNull();
  });
});
