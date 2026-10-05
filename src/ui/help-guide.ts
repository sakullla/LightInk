/**
 * `help-guide` — 应用内使用指南对话框（R2 / ADR-3）。
 *
 * 六类核心任务（导入 / 书源 / AI / WebDAV 同步 / 摸鱼 / 导出）全部走
 * messages.ts 键（`help.guide.*`），离线可完整浏览，无外部文档跳转。
 *
 * 打开通道沿用帮助菜单先例：document CustomEvent
 * `'lightink:open-help-guide'`（同 `'lightink:open-onboarding'`），由
 * main.ts 监听后以 i18n labels 挂载；语言切换经 `retranslate()` 覆盖。
 *
 * 载体沿用 modal-focus 一次性对话框语言（同 showCheatsheet / 引导对话
 * 框）：背景 inert、焦点圈定、Esc / 遮罩 / × / 底部关闭按钮。
 */

import { adoptDialogSurfaceTheme, inferDialogThemeHost } from './confirm-dialog.js';
import { labelModal, mountModalFocus } from './modal-focus.js';
import type { MessageKey } from '../i18n/messages.js';

/** 帮助菜单「使用指南」打开指南的 document CustomEvent 名（单一来源）。 */
export const OPEN_HELP_GUIDE_EVENT = 'lightink:open-help-guide';

/** 六类任务章节顺序（R2 验收范围；渲染与测试共用同一权威）。 */
export const HELP_GUIDE_SECTION_IDS = [
  'import',
  'sources',
  'ai',
  'sync',
  'stealth',
  'export',
] as const;

export type HelpGuideSectionId = (typeof HELP_GUIDE_SECTION_IDS)[number];

export interface HelpGuideSection {
  readonly id: HelpGuideSectionId;
  readonly title: string;
  readonly body: string;
}

/** 指南文案：持有 getter 即获得 retranslate 覆盖（同 onboarding-guide）。 */
export interface HelpGuideLabels {
  readonly title: string;
  readonly intro: string;
  readonly close: string;
  readonly sections: readonly HelpGuideSection[];
}

/** 宿主翻译函数形状（main 的 `i18n.t`；测试直接传 `translate(locale, …)`）。 */
export type TranslateFn = (
  key: MessageKey,
  vars?: Readonly<Record<string, string>>,
) => string;

/** 由 messages.ts 目录构造指南文案（标题/正文键按章节 id 派生）。 */
export function buildHelpGuideLabels(t: TranslateFn): HelpGuideLabels {
  return {
    title: t('help.guide.title'),
    intro: t('help.guide.intro'),
    close: t('dialog.close'),
    sections: HELP_GUIDE_SECTION_IDS.map((id) => ({
      id,
      title: t(`help.guide.${id}.title`),
      body: t(`help.guide.${id}.body`),
    })),
  };
}

export interface HelpGuideOptions {
  readonly labels: () => HelpGuideLabels;
  /** 复制主题令牌的宿主；缺省按当前 library/reader 表面推断。 */
  readonly themeHost?: HTMLElement | null;
}

export interface HelpGuideHandle {
  /** 挂到 body 的 overlay 根节点（测试断言用）。 */
  readonly element: HTMLElement;
  /** 关闭并拆除（Esc / 遮罩 / × / 底部按钮同路径）。 */
  close(): void;
  /** 宿主卸载用：只拆除（与 close 目前等价，保留对称语义）。 */
  destroy(): void;
  /** 语言切换后按当前 labels 重渲染。 */
  retranslate(): void;
}

/** 打开使用指南对话框（全局模态，挂 body）。 */
export function openHelpGuide(doc: Document, options: HelpGuideOptions): HelpGuideHandle {
  let closed = false;
  let releaseModal: (() => void) | null = null;

  // ── DOM ────────────────────────────────────────────────────────────
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-help-guide-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-help-guide';
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
  dismiss.dataset.helpGuideAction = 'dismiss';
  head.append(title, dismiss);

  const body = doc.createElement('div');
  body.className = 'lightink-help-guide-body';
  const intro = doc.createElement('p');
  intro.className = 'lightink-help-guide-intro';
  body.appendChild(intro);

  /** 章节 id → 标题/正文节点（章节集合固定，retranslate 只换文案）。 */
  const sectionNodes = new Map<HelpGuideSectionId, { title: HTMLElement; body: HTMLElement }>(
    HELP_GUIDE_SECTION_IDS.map((id) => {
      const section = doc.createElement('section');
      section.className = 'lightink-help-guide-section';
      section.dataset.helpSection = id;
      const sectionTitle = doc.createElement('h3');
      sectionTitle.className = 'lightink-help-guide-section-title';
      const sectionBody = doc.createElement('p');
      sectionBody.className = 'lightink-help-guide-section-body';
      section.append(sectionTitle, sectionBody);
      body.appendChild(section);
      return [id, { title: sectionTitle, body: sectionBody }];
    }),
  );

  const footer = doc.createElement('div');
  footer.className = 'lightink-modal-actions lightink-help-guide-footer';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-modal-btn lightink-help-guide-close';
  closeBtn.dataset.helpGuideAction = 'close';
  footer.appendChild(closeBtn);

  dialog.append(head, body, footer);
  overlay.appendChild(dialog);
  labelModal(dialog, title, intro);

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

  // ── 渲染（labels getter → retranslate 覆盖）───────────────────────
  function render(): void {
    const l = options.labels();
    title.textContent = l.title;
    dismiss.setAttribute('aria-label', l.close);
    dismiss.title = l.close;
    intro.textContent = l.intro;
    for (const section of l.sections) {
      const nodes = sectionNodes.get(section.id);
      if (nodes !== undefined) {
        nodes.title.textContent = section.title;
        nodes.body.textContent = section.body;
      }
    }
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
