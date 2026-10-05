/**
 * `about-dialog` — 关于对话框（R2 / ADR-3）。
 *
 * 版本号走 Tauri app API（`plugin:app|version`，`core:default` 已授权），
 * 运行时取 `tauri.conf.json` 的 version（发布流程与 `package.json` 一致）；
 * 非 Tauri 环境（单测 / capture fixture / IPC 不可用或返回空值）一律回退
 * `(dev)` 字面量，不弹错。
 *
 * 项目主页不引入 plugin-opener：点击复制 URL（`ui/clipboard` 既有封装，
 * 含 execCommand 兜底）并以 toast 反馈「已复制」；复制失败静默降级
 * （URL 文本仍可选中）。
 *
 * 打开通道：document CustomEvent `'lightink:open-about'`（同引导/指南先
 * 例），由 main.ts 监听后以 i18n labels 挂载；语言切换经 `retranslate()`
 * 覆盖，已解析的版本号不被重置。
 */

import { adoptDialogSurfaceTheme, inferDialogThemeHost } from './confirm-dialog.js';
import { labelModal, mountModalFocus } from './modal-focus.js';
import { writeClipboardText } from './clipboard.js';
import { showToast } from './toast.js';
import type { LocaleId } from '../i18n/messages.js';
import type { TranslateFn } from './help-guide.js';

/** 帮助菜单「关于」打开对话框的 document CustomEvent 名（单一来源）。 */
export const OPEN_ABOUT_EVENT = 'lightink:open-about';

/** 非 Tauri 环境的版本回退字面量（不进 i18n：它是版本值而非文案）。 */
export const ABOUT_VERSION_FALLBACK = '(dev)';

/** 开源许可（单一权威；About 展示与未来它处复用）。 */
export const APP_LICENSE = 'GPL-3.0';

/** 项目主页（README/落地页同一仓库地址；点击复制，不在线跳转）。 */
export const PROJECT_REPOSITORY_URL = 'https://github.com/sakullla/LightInk';

/**
 * 解析应用版本：Tauri `getVersion()` 失败 / 空值 / 非 Tauri 环境回退
 * `(dev)`（capture fixture 的 IPC 对未知命令返回 null，同样命中回退）。
 */
export async function resolveAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const version = await getVersion();
    return typeof version === 'string' && version.trim() !== ''
      ? version
      : ABOUT_VERSION_FALLBACK;
  } catch {
    return ABOUT_VERSION_FALLBACK;
  }
}

export interface AboutDialogLabels {
  readonly title: string;
  readonly close: string;
  readonly versionLabel: string;
  readonly licenseLabel: string;
  readonly repositoryLabel: string;
  readonly copyHint: string;
  /** 复制成功 toast 的标题（main 走 `code.copied`）。 */
  readonly copied: string;
}

/** 由 messages.ts 目录构造关于文案。 */
export function buildAboutDialogLabels(t: TranslateFn): AboutDialogLabels {
  return {
    title: t('about.title'),
    close: t('dialog.close'),
    versionLabel: t('about.version'),
    licenseLabel: t('about.license'),
    repositoryLabel: t('about.repository'),
    copyHint: t('about.copyHint'),
    copied: t('code.copied'),
  };
}

export interface AboutDialogOptions {
  readonly labels: () => AboutDialogLabels;
  /** 复制主题令牌的宿主；缺省按当前 library/reader 表面推断。 */
  readonly themeHost?: HTMLElement | null;
  /** 版本来源（测试注入；缺省 Tauri API + `(dev)` 回退）。 */
  readonly fetchVersion?: () => Promise<string>;
  /** 复制动作（测试注入；缺省 `ui/clipboard` 封装）。 */
  readonly copyText?: (text: string) => Promise<boolean>;
  /** toast 语言（关闭按钮 aria-label 等）。 */
  readonly locale?: LocaleId;
}

export interface AboutDialogHandle {
  /** 挂到 body 的 overlay 根节点（测试断言用）。 */
  readonly element: HTMLElement;
  /** 关闭并拆除（Esc / 遮罩 / × / 底部按钮同路径）。 */
  close(): void;
  /** 宿主卸载用：只拆除。 */
  destroy(): void;
  /** 语言切换后按当前 labels 重渲染（已解析版本保留）。 */
  retranslate(): void;
}

/** 打开关于对话框（全局模态，挂 body）。 */
export function openAboutDialog(doc: Document, options: AboutDialogOptions): AboutDialogHandle {
  let closed = false;
  let releaseModal: (() => void) | null = null;
  let resolvedVersion: string | null = null;

  // ── DOM ────────────────────────────────────────────────────────────
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-about-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-about';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = doc.createElement('div');
  head.className = 'lightink-modal-head';
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'lightink-modal-dismiss';
  dismiss.textContent = '×';
  dismiss.dataset.aboutAction = 'dismiss';
  head.append(title, dismiss);

  const body = doc.createElement('div');
  body.className = 'lightink-about-body';

  /** 标签 + 值 行工厂（版本 / 许可两行）。 */
  const row = (kind: 'version' | 'license'): { label: HTMLElement; value: HTMLElement } => {
    const item = doc.createElement('div');
    item.className = 'lightink-about-row';
    item.dataset.aboutRow = kind;
    const label = doc.createElement('span');
    label.className = 'lightink-about-row-label';
    const value = doc.createElement('span');
    value.className = 'lightink-about-row-value';
    item.append(label, value);
    body.appendChild(item);
    return { label, value };
  };
  const versionRow = row('version');
  const licenseRow = row('license');

  // 项目主页：链接外观的按钮，点击复制而非打开浏览器。
  const repository = doc.createElement('div');
  repository.className = 'lightink-about-row lightink-about-row--repository';
  repository.dataset.aboutRow = 'repository';
  const repositoryLabel = doc.createElement('span');
  repositoryLabel.className = 'lightink-about-row-label';
  const repositoryValue = doc.createElement('span');
  repositoryValue.className = 'lightink-about-row-value';
  const repositoryButton = doc.createElement('button');
  repositoryButton.type = 'button';
  repositoryButton.className = 'lightink-about-repository';
  repositoryButton.dataset.aboutAction = 'copy-repository';
  repositoryButton.textContent = PROJECT_REPOSITORY_URL;
  const copyHint = doc.createElement('span');
  copyHint.className = 'lightink-about-copy-hint';
  repositoryValue.append(repositoryButton, copyHint);
  repository.append(repositoryLabel, repositoryValue);
  body.appendChild(repository);

  const footer = doc.createElement('div');
  footer.className = 'lightink-modal-actions lightink-about-footer';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-modal-btn lightink-about-close';
  closeBtn.dataset.aboutAction = 'close';
  footer.appendChild(closeBtn);

  dialog.append(head, body, footer);
  overlay.appendChild(dialog);
  labelModal(dialog, title);

  // ── 复制反馈：成功 toast「已复制」；失败静默（URL 文本仍可选中）────
  const copyRepository = (): void => {
    const copyText = options.copyText ?? writeClipboardText;
    void copyText(PROJECT_REPOSITORY_URL).then((ok) => {
      if (ok && !closed) {
        showToast('success', options.labels().copied, undefined, {
          doc,
          locale: options.locale,
        });
      }
    });
  };
  repositoryButton.addEventListener('click', copyRepository);

  // ── 关闭路径 ──────────────────────────────────────────────────────
  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseModal?.();
    overlay.remove();
  };

  dismiss.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  // ── 渲染（labels getter → retranslate 覆盖；版本随解析结果更新）───
  function render(): void {
    const l = options.labels();
    title.textContent = l.title;
    dismiss.setAttribute('aria-label', l.close);
    dismiss.title = l.close;
    versionRow.label.textContent = l.versionLabel;
    versionRow.value.textContent = resolvedVersion ?? ABOUT_VERSION_FALLBACK;
    licenseRow.label.textContent = l.licenseLabel;
    licenseRow.value.textContent = APP_LICENSE;
    repositoryLabel.textContent = l.repositoryLabel;
    repositoryButton.setAttribute('aria-label', `${l.repositoryLabel}: ${PROJECT_REPOSITORY_URL}`);
    repositoryButton.title = l.copyHint;
    copyHint.textContent = l.copyHint;
    closeBtn.textContent = l.close;
  }

  render();
  const themeHost = options.themeHost === undefined ? inferDialogThemeHost(doc) : options.themeHost;
  if (themeHost !== null) {
    adoptDialogSurfaceTheme(overlay, themeHost);
  }
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: closeBtn,
    onEscape: close,
  });

  // 版本异步落定：先显示回退值，解析成功后替换（对话框已关或来源抛错
  // 均保持回退值，不弹错——ADR-3 失败边界）。
  void (options.fetchVersion ?? resolveAppVersion)()
    .then((version) => {
      if (closed) return;
      resolvedVersion = version;
      versionRow.value.textContent = version;
    })
    .catch(() => undefined);

  return {
    element: overlay,
    close,
    destroy: close,
    retranslate: () => {
      if (closed) return;
      render();
    },
  };
}
