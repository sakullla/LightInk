/**
 * `onboarding-guide` — 首次运行引导对话框（R1 / ADR-2）。
 *
 * 设备本地完成标记：`window.localStorage` 键 `lightink.onboarding.done`，
 * 直接读写、刻意不进 SyncableStorage allow-list（conceal 先例：跨设备同步
 * 「已引导」与推广目标相反，新设备应重新引导）。读写异常按未引导处理，
 * 由宿主用会话内标记兜底「最多弹一次」。
 *
 * 帮助菜单重开通道：document CustomEvent `'lightink:open-onboarding'`
 * （照抄 `'lightink:open-manage'` 先例，由 main.ts 监听后回书架重开）。
 *
 * 载体沿用 modal-focus 一次性对话框语言（同 showCheatsheet / 配置向导）：
 * 背景 inert、焦点圈定、Esc / 遮罩 / × / 跳过 / 开始使用 / 两个动作按钮，
 * 任何关闭路径都写完成标记——「跳过、完成或执行任一动作」都算已引导。
 * 文案由 library-view 的 LABELS 字典提供（`OnboardingGuideLabels` 子集形状），
 * 持有 getter 即获得 retranslate 覆盖。
 */

import { adoptDialogSurfaceTheme, inferDialogThemeHost } from '../ui/confirm-dialog.js';
import { labelModal, mountModalFocus } from '../ui/modal-focus.js';

/** 完成标记（设备本地；存在即视为已引导，值不参与判断）。 */
export const ONBOARDING_DONE_KEY = 'lightink.onboarding.done';

/** 帮助菜单重开引导的 document CustomEvent 名（单一来源）。 */
export const OPEN_ONBOARDING_EVENT = 'lightink:open-onboarding';

/** 引导文案：library LABELS 字典的子集形状（retranslate 经 labels getter）。 */
export interface OnboardingGuideLabels {
  readonly title: string;
  readonly intro: string;
  readonly capabilitiesTitle: string;
  readonly capabilityImport: string;
  readonly capabilitySources: string;
  readonly capabilityEdit: string;
  readonly capabilityRead: string;
  readonly capabilityExport: string;
  readonly capabilityStealth: string;
  readonly importAction: string;
  readonly addSourceAction: string;
  readonly skip: string;
  readonly start: string;
}

const CAPABILITY_LABEL_KEYS: readonly (keyof OnboardingGuideLabels)[] = [
  'capabilityImport',
  'capabilitySources',
  'capabilityEdit',
  'capabilityRead',
  'capabilityExport',
  'capabilityStealth',
];

/** 读完成标记；存储不可用（隐私模式等）按未引导处理。 */
export function readOnboardingDone(win: Window | null): boolean {
  try {
    if (win === null) return false;
    return win.localStorage.getItem(ONBOARDING_DONE_KEY) !== null;
  } catch {
    return false;
  }
}

/** 写完成标记；失败静默（会话内不重复弹出由宿主兜底）。 */
export function writeOnboardingDone(win: Window | null): void {
  try {
    win?.localStorage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    /* 隐私模式/配额异常：引导本就是一次性提示，不值得打断用户。 */
  }
}

export interface OnboardingGuideOptions {
  readonly labels: () => OnboardingGuideLabels;
  /** 复制主题令牌的宿主；缺省按当前 library/reader 表面推断。 */
  readonly themeHost?: HTMLElement | null;
  /** 「导入本地书籍」动作（接线既有 importLocalBook 流程）。 */
  readonly onImport: () => void;
  /** 「添加书源」动作（接线既有 source form 流程）。 */
  readonly onAddSource: () => void;
}

export interface OnboardingGuideHandle {
  /** 挂到 body 的 overlay 根节点（测试断言用）。 */
  readonly element: HTMLElement;
  /** 关闭并写完成标记（Esc / 遮罩 / × / 跳过 / 开始使用 / 动作同路径）。 */
  close(): void;
  /** 宿主卸载用：只拆除，不写标记。 */
  destroy(): void;
  /** 语言切换后按当前 labels 重渲染（LABELS retranslate 覆盖）。 */
  retranslate(): void;
}

/**
 * 打开引导对话框（全局模态，挂 body）。任何关闭路径先写完成标记再拆除；
 * 动作按钮关闭后回调宿主接线（导入 / 添加书源）。
 */
export function openOnboardingGuide(
  doc: Document,
  options: OnboardingGuideOptions,
): OnboardingGuideHandle {
  let closed = false;
  let releaseModal: (() => void) | null = null;

  // ── DOM ────────────────────────────────────────────────────────────
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-onboarding-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-onboarding';
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
  dismiss.dataset.onboardingAction = 'dismiss';
  head.append(title, dismiss);

  const body = doc.createElement('div');
  body.className = 'lightink-onboarding-body';
  const intro = doc.createElement('p');
  intro.className = 'lightink-onboarding-intro';
  const capabilitiesTitle = doc.createElement('h3');
  capabilitiesTitle.className = 'lightink-onboarding-section-title';
  const capabilities = doc.createElement('ul');
  capabilities.className = 'lightink-onboarding-capabilities';
  const capabilityItems = new Map<string, HTMLLIElement>();
  for (const key of CAPABILITY_LABEL_KEYS) {
    const item = doc.createElement('li');
    item.dataset.capability = key.replace(/^capability/, '').toLowerCase();
    capabilities.appendChild(item);
    capabilityItems.set(key, item);
  }
  body.append(intro, capabilitiesTitle, capabilities);

  // 推荐动作：与空书架引导卡同一对动作，导入为主按钮。
  const actions = doc.createElement('div');
  actions.className = 'lightink-onboarding-actions';
  const addSourceBtn = doc.createElement('button');
  addSourceBtn.type = 'button';
  addSourceBtn.className = 'lightink-modal-btn lightink-onboarding-add-source';
  addSourceBtn.dataset.onboardingAction = 'add-source';
  const importBtn = doc.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'lightink-modal-btn lightink-modal-btn--primary lightink-onboarding-import';
  importBtn.dataset.onboardingAction = 'import';
  actions.append(addSourceBtn, importBtn);

  const footer = doc.createElement('div');
  footer.className = 'lightink-modal-actions lightink-onboarding-footer';
  const skipBtn = doc.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'lightink-modal-btn lightink-onboarding-skip';
  skipBtn.dataset.onboardingAction = 'skip';
  const startBtn = doc.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'lightink-modal-btn lightink-onboarding-start';
  startBtn.dataset.onboardingAction = 'start';
  footer.append(skipBtn, startBtn);

  dialog.append(head, body, actions, footer);
  overlay.appendChild(dialog);
  labelModal(dialog, title, intro);

  // ── 关闭路径（全部写标记）─────────────────────────────────────────
  const close = (): void => {
    if (closed) return;
    closed = true;
    writeOnboardingDone(doc.defaultView);
    releaseModal?.();
    overlay.remove();
  };

  const destroy = (): void => {
    if (closed) return;
    closed = true;
    releaseModal?.();
    overlay.remove();
  };

  const runAction = (action: 'import' | 'add-source'): void => {
    // 先关（写标记）再交给宿主流程：文件选择器 / 书源表单不再被遮罩挡住。
    close();
    if (action === 'import') options.onImport();
    else options.onAddSource();
  };

  dismiss.addEventListener('click', close);
  skipBtn.addEventListener('click', close);
  startBtn.addEventListener('click', close);
  importBtn.addEventListener('click', () => runAction('import'));
  addSourceBtn.addEventListener('click', () => runAction('add-source'));
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  // ── 渲染（labels getter → retranslate 覆盖）───────────────────────
  function render(): void {
    const l = options.labels();
    title.textContent = l.title;
    dismiss.setAttribute('aria-label', l.skip);
    dismiss.title = l.skip;
    intro.textContent = l.intro;
    capabilitiesTitle.textContent = l.capabilitiesTitle;
    for (const key of CAPABILITY_LABEL_KEYS) {
      const item = capabilityItems.get(key);
      if (item !== undefined) {
        item.textContent = l[key];
      }
    }
    addSourceBtn.textContent = l.addSourceAction;
    importBtn.textContent = l.importAction;
    skipBtn.textContent = l.skip;
    startBtn.textContent = l.start;
  }

  render();
  const themeHost = options.themeHost === undefined ? inferDialogThemeHost(doc) : options.themeHost;
  if (themeHost !== null) {
    adoptDialogSurfaceTheme(overlay, themeHost);
  }
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: importBtn,
    onEscape: close,
  });

  return {
    element: overlay,
    close,
    destroy,
    retranslate: render,
  };
}
