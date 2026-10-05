// @vitest-environment jsdom

/**
 * `about-dialog`（R2 / ADR-3）契约：
 *
 * - 版本号走可注入的 `fetchVersion`（生产为 Tauri app API）；非 Tauri 环境的
 *   默认 `resolveAppVersion` 回退 `(dev)`，先渲染回退值、解析成功后替换。
 * - 许可证行固定 GPL-3.0；项目主页显示仓库 URL。
 * - 点击 URL 经 `copyText` 复制（生产为 ui/clipboard 封装）：成功出「已复制」
 *   toast，失败静默（URL 文本仍在，可手动选中复制）。
 * - Esc / 遮罩 / × / 底部按钮关闭；retranslate 换语言不重置已解析版本。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { translate, type LocaleId, type MessageKey } from '../../i18n/messages.js';
import {
  ABOUT_VERSION_FALLBACK,
  APP_LICENSE,
  buildAboutDialogLabels,
  OPEN_ABOUT_EVENT,
  openAboutDialog,
  PROJECT_REPOSITORY_URL,
  resolveAppVersion,
  type AboutDialogHandle,
} from '../about-dialog.js';

const t =
  (locale: LocaleId) =>
  (key: MessageKey, vars?: Readonly<Record<string, string>>): string =>
    translate(locale, key, vars);

interface OpenOverrides {
  locale?: LocaleId;
  fetchVersion?: () => Promise<string>;
  copyText?: (text: string) => Promise<boolean>;
}

function openAbout(overrides: OpenOverrides = {}): AboutDialogHandle {
  return openAboutDialog(document, {
    labels: () => buildAboutDialogLabels(t(overrides.locale ?? 'zh-CN')),
    locale: overrides.locale ?? 'zh-CN',
    ...(overrides.fetchVersion !== undefined ? { fetchVersion: overrides.fetchVersion } : {}),
    ...(overrides.copyText !== undefined ? { copyText: overrides.copyText } : {}),
  });
}

function overlayOf(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lightink-about-overlay');
}

function actionButton(action: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-about-action="${action}"]`,
  );
  if (button === null) throw new Error(`about action button not found: ${action}`);
  return button;
}

function rowValue(kind: string): string {
  const row = document.querySelector<HTMLElement>(`[data-about-row="${kind}"]`);
  if (row === null) throw new Error(`about row not found: ${kind}`);
  return row.textContent ?? '';
}

/** 等待微任务队列排空（fetchVersion 的 then 落定；走一个宏任务兜底）。 */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('resolveAppVersion（版本来源）', () => {
  it('非 Tauri 环境回退 (dev)（jsdom 无 __TAURI_INTERNALS__）', async () => {
    await expect(resolveAppVersion()).resolves.toBe(ABOUT_VERSION_FALLBACK);
  });
});

describe('about 对话框', () => {
  it('挂载 modal 对话框：版本（先回退后解析）/ GPL-3.0 / 项目主页 URL', async () => {
    const handle = openAbout({ fetchVersion: () => Promise.resolve('0.2.31') });
    const overlay = overlayOf();
    expect(overlay).toBe(handle.element);
    const dialog = overlay?.querySelector<HTMLElement>('.lightink-about');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // 打开瞬间先显示回退值，不闪空。
    expect(rowValue('version')).toContain(ABOUT_VERSION_FALLBACK);
    expect(rowValue('license')).toContain(APP_LICENSE);
    expect(rowValue('repository')).toContain(PROJECT_REPOSITORY_URL);
    expect(rowValue('license')).toContain('GPL-3.0');
    await flushMicrotasks();
    expect(rowValue('version')).toContain('0.2.31');
    expect(rowValue('version')).not.toContain(ABOUT_VERSION_FALLBACK);
  });

  it('版本解析失败保持 (dev) 回退，不弹错', async () => {
    openAbout({ fetchVersion: () => Promise.reject(new Error('ipc down')) });
    await flushMicrotasks();
    expect(rowValue('version')).toContain(ABOUT_VERSION_FALLBACK);
  });

  it('点击项目主页 URL：复制仓库地址并出「已复制」toast', async () => {
    const copyText = vi.fn().mockResolvedValue(true);
    openAbout({ copyText, fetchVersion: () => Promise.resolve('0.2.31') });
    actionButton('copy-repository').click();
    expect(copyText).toHaveBeenCalledWith(PROJECT_REPOSITORY_URL);
    await flushMicrotasks();
    const toast = document.querySelector<HTMLElement>('.lightink-toast');
    expect(toast?.dataset.kind).toBe('success');
    expect(toast?.textContent).toContain(translate('zh-CN', 'code.copied'));
  });

  it('复制失败静默：无 toast，URL 文本保留可手动复制', async () => {
    const copyText = vi.fn().mockResolvedValue(false);
    openAbout({ copyText });
    actionButton('copy-repository').click();
    await flushMicrotasks();
    expect(document.querySelector('.lightink-toast')).toBeNull();
    expect(rowValue('repository')).toContain(PROJECT_REPOSITORY_URL);
  });

  it('Esc / 遮罩 / × / 底部按钮都拆除对话框并恢复背景交互', () => {
    const sibling = document.createElement('div');
    document.body.appendChild(sibling);

    const first = openAbout();
    expect(sibling.inert).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.contains(first.element)).toBe(false);
    expect(sibling.inert).toBeFalsy();

    const second = openAbout();
    actionButton('dismiss').click();
    expect(document.body.contains(second.element)).toBe(false);

    const third = openAbout();
    actionButton('close').click();
    expect(document.body.contains(third.element)).toBe(false);

    const fourth = openAbout();
    fourth.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.body.contains(fourth.element)).toBe(false);
  });

  it('retranslate 换语言不重置已解析的版本号', async () => {
    let locale: LocaleId = 'zh-CN';
    const handle = openAboutDialog(document, {
      labels: () => buildAboutDialogLabels(t(locale)),
      locale,
      fetchVersion: () => Promise.resolve('0.2.31'),
    });
    await flushMicrotasks();
    expect(handle.element.textContent).toContain('关于轻墨');
    locale = 'en';
    handle.retranslate();
    expect(handle.element.textContent).toContain('About LightInk');
    expect(handle.element.textContent).not.toContain('关于轻墨');
    expect(rowValue('version')).toContain('0.2.31');
  });

  it('打开事件名稳定（app-shell 菜单与 main 监听共用）', () => {
    expect(OPEN_ABOUT_EVENT).toBe('lightink:open-about');
  });
});
