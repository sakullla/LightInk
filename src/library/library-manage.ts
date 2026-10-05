/**
 * Manage page (管理): a grouped settings page — appearance / reading
 * preferences / storage & cache / sync / other — with a cache-limit
 * dialog instead of a second page.
 *
 * Owns the manage DOM and the dialog state machine (`home | cache-limit`).
 * The dialog follows overlay Escape semantics: while it is open, a
 * (synthetic) Escape — including the Android back key dispatched through
 * ui/back-navigation.ts — is consumed to close it; on the manage home
 * nothing is consumed and the press falls through.
 */

import { showConfirmDialog } from '../ui/confirm-dialog.js';
import type { LibraryClient } from './library-client.js';
import type { ConcealBossKeysStatus } from '../conceal/conceal-client.js';
import {
  applyConcealScene,
  CONCEAL_GRADIENT_PRESETS,
  CONCEAL_SCENE_CHOICES,
  concealSceneOf,
  isSameHotkeyCombo,
  isValidConcealColor,
  isValidHotkeyCombo,
  type ConcealGradientPreset,
  type ConcealPrefs,
  type ConcealScene,
  type ConcealSceneChoice,
} from '../conceal/conceal-prefs.js';
import {
  concealCustomEffect,
  concealSceneResult,
  type ConcealEffectLabels,
  type ConcealSceneResultLabels,
} from '../conceal/conceal-status.js';
import {
  AI_TARGET_LANG_VALUES,
  type AiTargetLangValue,
} from '../reader/ai-target-lang.js';
import {
  applyLibraryTheme,
  LIBRARY_THEMES,
  loadLibraryTheme,
  mountLibraryOverlay,
  saveLibraryTheme,
  type LibraryThemeId,
  type LibraryThemeStorage,
} from './library-theme.js';
import {
  aiErrorMessage,
  aiMissingSummary,
  canonicalAiGap,
  dispatchAiConfigured,
  fallbackAiConfigStatus,
  invokeAiForgetKey,
  invokeAiGetConfig,
  invokeAiSaveConfig,
  invokeAiStoreKey,
  invokeAiTestConnection,
  isAiEndpointKind,
  AI_ENDPOINT_KINDS,
  type AiConfigLabels,
  type AiConfigStatusView,
  type AiEndpointKindId,
} from './ai-config-shared.js';
import {
  READER_PAGE_TURN_STYLES,
  READER_PREFS_STORAGE_KEY,
  applyReaderPrefs,
  loadReaderPrefs,
  saveReaderPrefs,
  type ReaderPrefsStorage,
  type ReaderPageTurnStyle,
} from '../reader/reader-prefs.js';

export { AI_TARGET_LANG_VALUES };
export type { AiTargetLangValue };
export type { ConcealBossKeysStatus } from '../conceal/conceal-client.js';

// AI 配置单一权威已抽至 `./ai-config-shared.js`（R3）：此处按原签名再导出，
// 既有消费方（library-view 等）不感知搬迁；新代码应直接 import shared。
export {
  AI_ENDPOINT_DEFAULT_BASE_URLS,
  AI_ENDPOINT_KINDS,
  AI_ERROR_LABEL_KEYS,
  READER_AI_CONFIGURED_EVENT,
  aiErrorMessage,
  aiMissingSummary,
  canonicalAiGap,
  dispatchAiConfigured,
  fallbackAiConfigStatus,
  invokeAiForgetKey,
  invokeAiGetConfig,
  invokeAiSaveConfig,
  invokeAiStoreKey,
  invokeAiTestConnection,
  isAiEndpointKind,
  parseAiConfigStatus,
} from './ai-config-shared.js';
export type {
  AiConfigLabels,
  AiConfigInputView,
  AiConfigStatusView,
  AiConfiguredDetail,
  AiEndpointDefaultView,
  AiEndpointKindId,
  AiTestResultView,
} from './ai-config-shared.js';

export type ManageSubpage = 'home' | 'cache-limit';

/** 摸鱼段（R2/R5–R10/R13）的显示文案（main.ts 以 i18n 装配）。 */
export interface ConcealManageLabels extends ConcealSceneResultLabels, ConcealEffectLabels {
  readonly group: string;
  readonly groupHint: string;
  /** R15 摸鱼总开关与提示（关闭后整段其余控件隐藏、全部效果撤销）。 */
  readonly enabled: string;
  readonly enabledHint: string;
  readonly bossKeyHint: string;
  readonly macBossKeyHint: string;
  readonly bossKey1: string;
  readonly bossKey2: string;
  readonly bossKeyActive: string;
  readonly bossKeyEmpty: string;
  readonly bossKeyInvalid: string;
  readonly bossKeySame: string;
  readonly bossKeyUnregistered: string;
  readonly background: string;
  readonly backgroundTheme: string;
  readonly backgroundPresets: Readonly<Record<ConcealGradientPreset, string>>;
  readonly backgroundCustom: string;
  readonly customFrom: string;
  readonly customTo: string;
  readonly transparentMode: string;
  readonly contentOpacity: string;
  readonly hideTop: string;
  readonly hideBody: string;
  readonly hideBottom: string;
  readonly alwaysOnTop: string;
  readonly miniWindow: string;
  readonly clickThrough: string;
  readonly clickThroughHint: string;
  /** 后台运行开关与开启后的行为提示。 */
  readonly runInBackground: string;
  readonly runInBackgroundHint: string;
  readonly sceneNormal: string;
  readonly sceneHideOnLeave: string;
  readonly sceneFloating: string;
  readonly sceneCustom: string;
  readonly groupDodge: string;
  readonly groupDisguise: string;
  readonly groupFloat: string;
  readonly groupExit: string;
  readonly exitHint: string;
  readonly needsTransparent: string;
  readonly gradientHidden: string;
  readonly opacityScale: string;
  readonly recordCombo: string;
}

/** 置顶、迷你窗口、透明、穿透被拒绝时，原因留在会话里并贴在该开关旁。 */
export type ConcealSwitchRefusalKey =
  | 'transparentMode'
  | 'alwaysOnTop'
  | 'miniWindow'
  | 'clickThrough';

/** 摸鱼段与 conceal-controller 的接线（注入式，Vitest 可 fake）。 */
export interface ConcealManageDeps {
  readonly labels: () => ConcealManageLabels;
  /** macOS 平台（决定是否展示 Ctrl 默认值说明）。 */
  readonly isMac: boolean;
  /** 当前生效偏好（命令失败的开关已内存回退，回显以它为准）。 */
  readonly getPrefs: () => ConcealPrefs;
  /** 非键位改动：合并→校验→持久化→即时生效（R10）。 */
  readonly update: (update: Partial<ConcealPrefs>) => void;
  /** R2 改键注册（返回注册结果与失败原因）。 */
  readonly updateBossKeys: (primary: string, secondary: string) => Promise<ConcealBossKeysStatus>;
  /**
   * 订阅当前会话的窗口开关拒绝。返回解除订阅。
   * 订阅时可以立刻重放尚未清除的原因（设置页晚于失败创建）。
   */
  readonly subscribeSwitchRefusal?: (
    listener: (key: ConcealSwitchRefusalKey, reason: string) => void,
  ) => () => void;
  /** 用户再次拨动该开关或改场景时清掉会话原因，避免成功后仍贴着旧拒绝。 */
  readonly clearSwitchRefusal?: (key: ConcealSwitchRefusalKey) => void;
}

/**
 * AI 分组的字段/错误标签现由 `AiConfigLabels`（ai-config-shared）持有：
 * 配置向导复用同一份 `AI_ERROR_LABEL_KEYS` 映射，两个 surface 的标签形状
 * 由编译期对齐。此处仅保留管理页专属的分组与操作文案。
 */
export interface LibraryManageLabels extends AiConfigLabels {
  readonly appearance: string;
  readonly libraryTheme: string;
  readonly libraryThemeHint: string;
  readonly readingGroup: string;
  readonly readerPrefsHint: string;
  readonly showProgressBar: string;
  readonly pageTurnStyle: string;
  readonly pageTurnStyleAuto: string;
  readonly pageTurnStyleSlide: string;
  readonly pageTurnStyleFade: string;
  readonly pageTurnStyleCurl: string;
  readonly pageTurnStyleNone: string;
  readonly aiGroup: string;
  readonly aiHint: string;
  readonly aiEndpointOpenaiResponses: string;
  readonly aiEndpointOpenaiChat: string;
  readonly aiEndpointClaudeMessages: string;
  readonly aiKeyClear: string;
  readonly aiKeyShow: string;
  readonly aiKeyHide: string;
  readonly aiKeySavedPlaceholder: string;
  readonly aiAllowHttp: string;
  readonly aiTargetLang: string;
  readonly aiTargetLangAuto: string;
  readonly aiLangZhCN: string;
  readonly aiLangEn: string;
  readonly aiLangJa: string;
  readonly aiLangKo: string;
  readonly aiLangFr: string;
  readonly aiLangDe: string;
  readonly aiLangEs: string;
  readonly aiLangRu: string;
  readonly aiSave: string;
  readonly aiTest: string;
  readonly aiTesting: string;
  readonly aiTestOk: string;
  readonly aiConfigured: string;
  readonly aiSaved: string;
  readonly aiKeyCleared: string;
  readonly storageGroup: string;
  readonly clearCache: string;
  readonly cacheUsage: string;
  readonly cacheLimit: string;
  readonly changeCacheLimit: string;
  readonly apply: string;
  readonly cancel: string;
  readonly syncGroup: string;
  readonly webdavSync: string;
  readonly otherGroup: string;
  readonly importLocal: string;
  readonly markdownEditor: string;
}

export interface LibraryManageOptions {
  readonly labels: () => LibraryManageLabels;
  readonly themeLabel: (id: LibraryThemeId) => string;
  /** Library root element: shelf theme tokens are applied here. */
  readonly themeRoot: HTMLElement;
  readonly themeStorage?: LibraryThemeStorage | null;
  readonly readerPrefsStorage?: ReaderPrefsStorage | null;
  readonly library: Pick<LibraryClient, 'clearCache' | 'setCacheLimit' | 'cacheStats'>;
  readonly notify: (message: string, kind?: 'error' | 'warning') => void;
  readonly formatError: (error: unknown) => string;
  /** Import a local book; the host view owns post-import navigation. */
  readonly onImport: () => Promise<void>;
  readonly onOpenSyncPanel?: () => void;
  /** Desktop-only entry; the row is suppressed when absent. */
  readonly onEnterEditor?: () => void;
  /** 摸鱼段（R12：仅桌面注入；缺省整段不渲染）。 */
  readonly conceal?: ConcealManageDeps;
}

export interface LibraryManageView {
  readonly element: HTMLElement;
  /** Close the cache-limit dialog and stay on the manage home. */
  showHome(): void;
  /** Overlay Escape semantics: closes the open dialog; true when consumed. */
  handleEscape(): boolean;
  refreshCache(): Promise<void>;
  retranslate(): void;
  destroy(): void;
}

export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}

/**
 * Cache-limit dialog height budget. The overlay bottom offset (keyboard /
 * safe-area inset) is owned by the touch rules in library.css — no inline
 * paddingBottom here: inline style specificity would override the sheet rule
 * `padding-bottom: max(safe-bottom, keyboard-inset)` and zero out the
 * safe-bottom channel when the keyboard is closed (inconsistent with the
 * group/source sheets). Single deduction (reader-chrome-panels.ts
 * pinFixedOverlay paradigm): on touch the height budget — keyboard-open anchor
 * included — is owned by library.css; desktop keeps the legacy cap.
 */
function applyCacheLimitDialogHeightCap(overlay: HTMLElement, dialog: HTMLElement): void {
  const root = overlay.ownerDocument.documentElement;
  const touch = root.hasAttribute('data-android') || root.hasAttribute('data-touch-primary');
  // 桌面保留既有高度上限（键盘不占位，与改版前等价）。
  if (!touch) {
    dialog.style.maxHeight = 'calc(100dvh - 24px)';
  }
}

function button(doc: Document, text: string, className = ''): HTMLButtonElement {
  const el = doc.createElement('button');
  el.type = 'button';
  if (className !== '') el.className = className;
  el.textContent = text;
  return el;
}

/**
 * radiogroup 内 Arrow/Home/End 移动并激活目标项（WAI-ARIA radio group
 * 惯例）。激活可能触发整组重建（主题色板 renderThemeSwatches 即如此）：
 * click 后旧节点若已脱离文档，按下标重取新节点再聚焦。
 */
function bindRadioGroupKeys(container: HTMLElement, itemSelector: string): void {
  container.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLElement)) {
      return;
    }
    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    const index = items.indexOf(event.target);
    if (index < 0 || items.length === 0) {
      return;
    }
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = items[next]!;
    target.click();
    const fresh = target.isConnected
      ? target
      : container.querySelectorAll<HTMLElement>(itemSelector)[next];
    fresh?.focus();
  });
}

/** 导航行右端的 › 指示（feather chevron，与书库分区标题同 stroke 语言）。 */
function manageRowChevron(doc: Document): SVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'lightink-library-manage-row-chevron');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M9 18l6-6-6-6');
  svg.appendChild(path);
  return svg;
}

/** 设置行：左标签 + 可选右端 ›（仅导航/打开面板类行，动作行不加）。 */
function manageRow(
  doc: Document,
  className: string,
  navigates: boolean,
): { readonly button: HTMLButtonElement; readonly label: HTMLSpanElement } {
  const row = button(doc, '', `lightink-library-manage-row ${className}`.trim());
  const label = doc.createElement('span');
  label.className = 'lightink-library-manage-row-label';
  row.append(label);
  if (navigates) {
    row.append(manageRowChevron(doc));
  }
  return { button: row, label };
}

/**
 * 分组折叠时标题下的一行当前值摘要（同摸鱼标题「场景 · 键」的思路，
 * 独立元素以保住 h2 纯文本与折叠隐藏规则的边界）。无内容时保持 hidden。
 */
function groupSummary(doc: Document): HTMLParagraphElement {
  const el = doc.createElement('p');
  el.className = 'lightink-library-manage-group-summary';
  el.hidden = true;
  return el;
}

function setGroupSummary(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.hidden = text === '';
}

/** 翻页动画 select 各档的本地化标签（retranslate 与折叠摘要共用）。 */
function pageTurnStyleLabels(l: LibraryManageLabels): Record<ReaderPageTurnStyle, string> {
  return {
    auto: l.pageTurnStyleAuto,
    slide: l.pageTurnStyleSlide,
    fade: l.pageTurnStyleFade,
    curl: l.pageTurnStyleCurl,
    none: l.pageTurnStyleNone,
  };
}

// ── AI 提供商分组(R2)：命令封装、defaults 解析、错误映射与事件常量已抽至
// ai-config-shared.ts（R3 单一权威），上方按原签名再导出；下方只保留表单 UI。 ──

/** 目标语言覆盖项的下拉标签（retranslate 与分组摘要共用）。 */
function aiTargetLangLabel(value: AiTargetLangValue, l: LibraryManageLabels): string {
  switch (value) {
    case 'auto': return l.aiTargetLangAuto;
    case 'zh-CN': return l.aiLangZhCN;
    case 'en': return l.aiLangEn;
    case 'ja': return l.aiLangJa;
    case 'ko': return l.aiLangKo;
    case 'fr': return l.aiLangFr;
    case 'de': return l.aiLangDe;
    case 'es': return l.aiLangEs;
    case 'ru': return l.aiLangRu;
  }
}

function manageLabelsAreEnglish(l: LibraryManageLabels): boolean {
  return l.cancel === 'Cancel';
}

/** 清理缓存确认：点名已下载缓存，并说明书库条目还在。 */
function cacheClearPrompt(l: LibraryManageLabels): { title: string; message: string } {
  if (manageLabelsAreEnglish(l)) {
    return {
      title: 'Clear downloaded cache',
      message: 'This clears downloaded cache only. Library entries stay.',
    };
  }
  return {
    title: '清理已下载缓存',
    message: '清掉的是已下载缓存，书库条目还会留着。',
  };
}

/** 占位说明要解释怎么填，不能只把字段名再写一遍。 */
function aiFieldHints(l: LibraryManageLabels): { baseUrl: string; model: string; key: string } {
  if (manageLabelsAreEnglish(l)) {
    return {
      baseUrl: 'https://api.openai.com/v1 or a compatible service address',
      model: 'Provider id such as gpt-4o-mini',
      key: 'Paste the provider key. Leave blank to keep a saved key.',
    };
  }
  return {
    baseUrl: '例如 https://api.openai.com/v1，或兼容服务的地址',
    model: '服务商给出的模型标识，例如 gpt-4o-mini',
    key: '粘贴服务商密钥。留空则保留已经保存的密钥。',
  };
}

/**
 * 设置分组默认折叠（分组多、内容长，AI/摸鱼等大区块尤甚）：标题即开关
 * （role=button + aria-expanded，与分组树同口径的双状态标记）。不持久化
 * 展开态——每次打开设置一律从全折叠开始，会话内的展开由 DOM 自身保持。
 */
function setupManageGroupCollapsing(home: HTMLElement): void {
  const titles: HTMLElement[] = [];
  for (const group of home.querySelectorAll<HTMLElement>('.lightink-library-manage-group')) {
    const title = group.querySelector<HTMLElement>(':scope > h2');
    if (title === null) {
      continue;
    }
    const apply = (open: boolean): void => {
      if (open) {
        delete group.dataset.collapsed;
      } else {
        group.dataset.collapsed = 'true';
      }
      title.setAttribute('aria-expanded', String(open));
    };
    apply(false);
    const toggle = (): void => {
      apply(group.dataset.collapsed === 'true');
    };
    title.classList.add('lightink-library-manage-group-toggle');
    title.setAttribute('role', 'button');
    title.setAttribute('tabindex', '0');
    titles.push(title);
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const current = titles.indexOf(title);
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? titles.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + titles.length) % titles.length;
        titles[next]?.focus();
      }
    });
  }
}


const CONCEAL_REFUSAL_KEYS = [
  'transparentMode',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
] as const satisfies readonly ConcealSwitchRefusalKey[];

const CONCEAL_TOGGLE_KEYS = [
  'transparentMode',
  'hideTop',
  'hideBody',
  'hideBottom',
  'alwaysOnTop',
  'miniWindow',
  'clickThrough',
  'runInBackground',
] as const;

type ConcealToggleKey = (typeof CONCEAL_TOGGLE_KEYS)[number];

const CONCEAL_BACKGROUND_VALUES = [
  'theme',
  'lavender',
  'mint',
  'peach',
  'sky',
  'butter',
  'custom',
] as const;

type ConcealBackgroundValue = (typeof CONCEAL_BACKGROUND_VALUES)[number];

function isConcealRefusalKey(key: string): key is ConcealSwitchRefusalKey {
  return (CONCEAL_REFUSAL_KEYS as readonly string[]).includes(key);
}

/** 空组合、纯修饰键、或与另一键相同：不注册。返回字段旁的原因；可提交则 null。 */
function concealHotkeyRejectReason(
  combo: string,
  other: string,
  texts: { readonly empty: string; readonly invalid: string; readonly same: string },
): string | null {
  if (combo.trim() === '') {
    return texts.empty;
  }
  if (!isValidHotkeyCombo(combo)) {
    return texts.invalid;
  }
  if (isSameHotkeyCombo(combo, other)) {
    return texts.same;
  }
  return null;
}

interface ConcealKeyField {
  readonly prefKey: 'bossPrimary' | 'bossSecondary';
  readonly input: HTMLInputElement;
  readonly status: HTMLParagraphElement;
  attemptReason: string | null;
  statusBeforeRecord: string;
}

interface ConcealSectionController {
  readonly section: HTMLElement;
  retranslate(): void;
  destroy(): void;
}

/**
 * 书架摸鱼设置。外层仍是一个可折叠分组（折叠只留 h2），所以场景名和老板键
 * 写在标题上。三个分组只重新收纳现有控件；退出快捷键单独成组。
 */
function mountConcealSection(doc: Document, deps: ConcealManageDeps): ConcealSectionController {
  const section = doc.createElement('section');
  section.className = 'lightink-library-manage-group lightink-library-conceal';
  section.dataset.manageGroup = 'conceal';

  const texts = {
    group: '',
    groupHint: '',
    enabled: '',
    enabledHint: '',
    bossKeyHint: '',
    macBossKeyHint: '',
    bossKey1: '',
    bossKey2: '',
    bossKeyActive: '',
    bossKeyEmpty: '',
    bossKeyInvalid: '',
    bossKeySame: '',
    bossKeyUnregistered: '',
    recordCombo: '',
    background: '',
    backgroundLabels: {
      theme: '',
      lavender: '',
      mint: '',
      peach: '',
      sky: '',
      butter: '',
      custom: '',
    } as Record<ConcealBackgroundValue, string>,
    customFrom: '',
    customTo: '',
    contentOpacity: '',
    opacityScale: '',
    needsTransparent: '',
    gradientHidden: '',
    clickThroughHint: '',
    runInBackgroundHint: '',
    exitHint: '',
    scenes: {
      normal: '',
      hideOnLeave: '',
      floating: '',
      custom: '',
    } as Record<ConcealScene, string>,
    sceneResults: {
      sceneNormalResult: '',
      sceneHideOnLeaveResult: '',
      sceneFloatingResult: '',
    },
    effects: {
      effectWindowTransparent: '',
      effectWindowOpaque: '',
      effectOpacity: '',
      effectHideNone: '',
      effectHidePrefix: '',
      regionSeparator: '',
      regionTop: '',
      regionBody: '',
      regionBottom: '',
      effectPinned: '',
      effectNotPinned: '',
      effectMini: '',
      effectNotMini: '',
      effectClickThrough: '',
      effectNoClickThrough: '',
      effectSeparator: '',
    },
    groups: {
      dodge: '',
      disguise: '',
      float: '',
      exit: '',
    },
    toggles: {
      transparentMode: '',
      hideTop: '',
      hideBody: '',
      hideBottom: '',
      alwaysOnTop: '',
      miniWindow: '',
      clickThrough: '',
      runInBackground: '',
    } as Record<ConcealToggleKey, string>,
  };

  const title = doc.createElement('h2');
  title.className = 'lightink-library-manage-group-title';
  const hint = doc.createElement('p');
  hint.className = 'lightink-library-appearance-hint';

  // R15 总开关：折叠为组内第一行；关闭时其余控件整体隐藏。
  const enabledWrap = doc.createElement('div');
  enabledWrap.className = 'lightink-library-conceal-switch';
  enabledWrap.dataset.concealSwitch = 'enabled';
  const enabledLabel = doc.createElement('label');
  enabledLabel.className = 'lightink-library-reader-pref';
  const enabledInput = doc.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.dataset.concealEnabled = 'true';
  const enabledText = doc.createElement('span');
  enabledLabel.append(enabledInput, enabledText);
  const enabledHint = doc.createElement('p');
  enabledHint.className = 'lightink-library-appearance-hint';
  enabledHint.dataset.concealEnabledHint = 'true';
  enabledWrap.append(enabledLabel, enabledHint);
  enabledInput.addEventListener('change', () => {
    deps.update({ enabled: enabledInput.checked });
    render();
  });

  const body = doc.createElement('div');
  body.className = 'lightink-library-conceal-body';

  const scenes = doc.createElement('div');
  scenes.className = 'lightink-library-conceal-scenes';
  scenes.setAttribute('role', 'radiogroup');
  const sceneButtons = new Map<ConcealSceneChoice, HTMLButtonElement>();
  const sceneResults = new Map<ConcealSceneChoice, HTMLElement>();
  for (const choice of CONCEAL_SCENE_CHOICES) {
    const sceneItem = doc.createElement('div');
    sceneItem.className = 'lightink-library-conceal-scene-item';
    const sceneButton = button(doc, '', 'lightink-library-conceal-scene');
    sceneButton.dataset.concealScene = choice;
    sceneButton.setAttribute('role', 'radio');
    const sceneResult = doc.createElement('p');
    sceneResult.className = 'lightink-library-conceal-scene-result';
    sceneResult.dataset.concealSceneResult = choice;
    sceneButton.addEventListener('click', () => {
      for (const key of CONCEAL_REFUSAL_KEYS) {
        refusals.delete(key);
        deps.clearSwitchRefusal?.(key);
      }
      deps.update(applyConcealScene(deps.getPrefs(), choice));
      render();
    });
    sceneButtons.set(choice, sceneButton);
    sceneResults.set(choice, sceneResult);
    sceneItem.append(sceneButton, sceneResult);
    scenes.append(sceneItem);
  }
  const customItem = doc.createElement('div');
  customItem.className = 'lightink-library-conceal-scene-item';
  const customScene = doc.createElement('span');
  customScene.className = 'lightink-library-conceal-scene is-readonly';
  customScene.dataset.concealScene = 'custom';
  const customEffect = doc.createElement('p');
  customEffect.className = 'lightink-library-conceal-custom-effect';
  customEffect.dataset.concealCustomEffect = 'true';
  customEffect.hidden = true;
  customItem.append(customScene, customEffect);
  scenes.append(customItem);

  const subgroup = (id: 'dodge' | 'disguise' | 'float' | 'exit'): HTMLElement => {
    const group = doc.createElement('section');
    group.className = 'lightink-library-conceal-subgroup';
    group.dataset.concealGroup = id;
    const heading = doc.createElement('h3');
    heading.className = 'lightink-library-conceal-subgroup-title';
    group.append(heading);
    return group;
  };
  const dodge = subgroup('dodge');
  const disguise = subgroup('disguise');
  const floatGroup = subgroup('float');
  const exit = subgroup('exit');

  const bossHint = doc.createElement('p');
  bossHint.className = 'lightink-library-appearance-hint';
  const macHint = deps.isMac ? doc.createElement('p') : null;
  if (macHint !== null) {
    macHint.className = 'lightink-library-appearance-hint';
  }
  const exitHint = doc.createElement('p');
  exitHint.className = 'lightink-library-appearance-hint';
  exitHint.dataset.concealExitHint = 'true';

  /** keydown → accelerator 串（修饰键在前，顺序 Control/Shift/Alt/Meta）。 */
  const comboFromEvent = (event: KeyboardEvent): { combo: string; complete: boolean } => {
    const modifiers: string[] = [];
    if (event.ctrlKey) modifiers.push('Control');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.altKey) modifiers.push('Alt');
    if (event.metaKey) modifiers.push('Meta');
    const key = event.key;
    const isMain =
      /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
      /^[a-zA-Z0-9]$/.test(key) ||
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'Tab', 'Enter', 'Space', 'Plus', 'Minus'].includes(
        key,
      );
    if (!isMain) {
      return { combo: modifiers.join('+'), complete: false };
    }
    const main = key === 'Space' ? 'Space' : key.length === 1 ? key.toUpperCase() : key;
    return { combo: [...modifiers, main].join('+'), complete: true };
  };

  const showKeyReason = (field: ConcealKeyField, reason: string): void => {
    field.attemptReason = reason;
    field.status.textContent = reason;
    field.status.classList.add('is-error');
    field.input.dataset.recording = 'false';
    field.input.value = deps.getPrefs()[field.prefKey];
  };

  const makeBossKeyField = (prefKey: 'bossPrimary' | 'bossSecondary'): ConcealKeyField => {
    const field = doc.createElement('label');
    field.className = 'lightink-library-conceal-key-field';
    const name = doc.createElement('span');
    name.className = 'lightink-library-conceal-key-name';
    name.dataset.concealKeyName = prefKey;
    const input = doc.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.dataset.concealKeyField = prefKey;
    input.dataset.recording = 'false';
    const status = doc.createElement('p');
    status.className = 'lightink-library-conceal-key-status';
    status.dataset.concealKeyStatus = prefKey;
    status.setAttribute('role', 'status');
    const state: ConcealKeyField = {
      prefKey,
      input,
      status,
      attemptReason: null,
      statusBeforeRecord: '',
    };
    input.addEventListener('focus', () => {
      if (input.dataset.recording !== 'true') {
        state.statusBeforeRecord = status.textContent ?? '';
      }
      input.dataset.recording = 'true';
      if (state.attemptReason === null) {
        status.textContent = texts.recordCombo;
        status.classList.remove('is-error');
      }
    });
    input.addEventListener('keydown', (event) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        input.dataset.recording = 'false';
        input.value = deps.getPrefs()[prefKey];
        if (state.attemptReason !== null) {
          status.textContent = state.attemptReason;
          status.classList.add('is-error');
        } else {
          status.textContent = state.statusBeforeRecord;
          status.classList.remove('is-error');
        }
        return;
      }
      const { combo, complete } = comboFromEvent(event);
      const other = deps.getPrefs()[prefKey === 'bossPrimary' ? 'bossSecondary' : 'bossPrimary'];
      if (!complete) {
        if (combo === '') {
          showKeyReason(state, texts.bossKeyEmpty);
          return;
        }
        // 只按修饰键：预览组合，并在字段旁说明原因，不注册。
        input.dataset.recording = 'true';
        input.value = combo;
        state.attemptReason = texts.bossKeyInvalid;
        status.textContent = state.attemptReason;
        status.classList.add('is-error');
        return;
      }
      const reason = concealHotkeyRejectReason(combo, other, {
        empty: texts.bossKeyEmpty,
        invalid: texts.bossKeyInvalid,
        same: texts.bossKeySame,
      });
      if (reason !== null) {
        showKeyReason(state, reason);
        return;
      }
      state.attemptReason = null;
      input.dataset.recording = 'false';
      void deps
        .updateBossKeys(
          prefKey === 'bossPrimary' ? combo : deps.getPrefs().bossPrimary,
          prefKey === 'bossSecondary' ? combo : deps.getPrefs().bossSecondary,
        )
        .then((result) => {
          state.attemptReason = null;
          render(result);
          state.statusBeforeRecord = status.textContent ?? '';
        });
    });
    input.addEventListener('blur', () => {
      const preview = input.value;
      const recording = input.dataset.recording === 'true';
      input.dataset.recording = 'false';
      const saved = deps.getPrefs()[prefKey];
      input.value = saved;
      if (recording && preview !== saved && !isValidHotkeyCombo(preview)) {
        state.attemptReason = preview.trim() === '' ? texts.bossKeyEmpty : texts.bossKeyInvalid;
      }
      if (state.attemptReason !== null) {
        status.textContent = state.attemptReason;
        status.classList.add('is-error');
        return;
      }
      status.textContent = state.statusBeforeRecord;
      status.classList.remove('is-error');
    });
    field.append(name, input, status);
    return state;
  };

  const primaryField = makeBossKeyField('bossPrimary');
  const secondaryField = makeBossKeyField('bossSecondary');

  const swatchRow = doc.createElement('div');
  swatchRow.className = 'lightink-library-conceal-swatches';
  const backgroundText = doc.createElement('span');
  backgroundText.className = 'lightink-library-conceal-field-label';
  const swatches = new Map<
    ConcealBackgroundValue,
    { readonly button: HTMLButtonElement; readonly chip: HTMLElement; readonly name: HTMLElement }
  >();
  for (const value of CONCEAL_BACKGROUND_VALUES) {
    const swatch = button(doc, '', 'lightink-library-conceal-swatch');
    swatch.dataset.concealBackground = value;
    const chip = doc.createElement('span');
    chip.className = 'lightink-library-conceal-swatch-chip';
    if (value === 'theme') {
      chip.classList.add('is-theme');
    }
    const name = doc.createElement('span');
    name.className = 'lightink-library-conceal-swatch-name';
    swatch.append(chip, name);
    swatch.addEventListener('click', () => {
      const prefs = deps.getPrefs();
      if (value === 'theme') {
        deps.update({ background: { kind: 'theme' } });
      } else if (value === 'custom') {
        deps.update({
          background: {
            kind: 'custom',
            from: prefs.background.kind === 'custom' ? prefs.background.from : '#c9b6e4',
            to: prefs.background.kind === 'custom' ? prefs.background.to : '#f1e9fb',
          },
        });
      } else {
        deps.update({ background: { kind: 'preset', preset: value } });
      }
      render();
    });
    swatches.set(value, { button: swatch, chip, name });
    swatchRow.append(swatch);
  }
  const gradientNote = doc.createElement('p');
  gradientNote.className = 'lightink-library-appearance-hint';
  gradientNote.dataset.concealGradientNote = 'true';

  const customRow = doc.createElement('div');
  customRow.className = 'lightink-library-conceal-custom-row';
  const customFromText = doc.createElement('span');
  const customFrom = doc.createElement('input');
  customFrom.type = 'color';
  customFrom.dataset.concealCustom = 'from';
  const customToText = doc.createElement('span');
  const customTo = doc.createElement('input');
  customTo.type = 'color';
  customTo.dataset.concealCustom = 'to';
  const customFromField = doc.createElement('label');
  customFromField.className = 'lightink-library-field';
  const customToField = doc.createElement('label');
  customToField.className = 'lightink-library-field';
  customFromField.append(customFromText, customFrom);
  customToField.append(customToText, customTo);
  customRow.append(customFromField, customToField);
  const commitCustomColors = (): void => {
    const from = customFrom.value;
    const to = customTo.value;
    if (!isValidConcealColor(from) || !isValidConcealColor(to)) {
      render();
      return;
    }
    deps.update({ background: { kind: 'custom', from, to } });
    render();
  };
  customFrom.addEventListener('change', commitCustomColors);
  customTo.addEventListener('change', commitCustomColors);

  const opacityField = doc.createElement('label');
  opacityField.className = 'lightink-library-conceal-opacity-field';
  const opacityText = doc.createElement('span');
  const opacityInput = doc.createElement('input');
  opacityInput.type = 'number';
  opacityInput.name = 'contentOpacity';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.dataset.concealOpacity = 'true';
  const opacityScale = doc.createElement('span');
  opacityScale.className = 'lightink-library-conceal-opacity-scale';
  opacityScale.dataset.concealOpacityScale = 'true';
  opacityField.append(opacityText, opacityInput, opacityScale);
  opacityInput.addEventListener('change', () => {
    const raw = opacityInput.value.trim();
    const saved = String(deps.getPrefs().contentOpacity);
    // 101、负数、空白、非整数都不保存，回到当前生效值。
    if (!/^\d+$/.test(raw)) {
      opacityInput.value = saved;
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      opacityInput.value = saved;
      return;
    }
    deps.update({ contentOpacity: value });
    render();
  });

  const refusals = new Map<ConcealSwitchRefusalKey, string>();
  const toggles = new Map<
    ConcealToggleKey,
    { readonly input: HTMLInputElement; readonly text: HTMLSpanElement; readonly reason: HTMLParagraphElement }
  >();
  for (const prefKey of CONCEAL_TOGGLE_KEYS) {
    const wrap = doc.createElement('div');
    wrap.className = 'lightink-library-conceal-switch';
    wrap.dataset.concealSwitch = prefKey;
    const label = doc.createElement('label');
    label.className = 'lightink-library-reader-pref';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.dataset.concealToggle = prefKey;
    const text = doc.createElement('span');
    const reason = doc.createElement('p');
    reason.className = 'lightink-library-conceal-switch-reason';
    reason.dataset.concealSwitchReason = prefKey;
    reason.hidden = true;
    label.append(input, text);
    wrap.append(label, reason);
    input.addEventListener('change', () => {
      if (input.disabled) {
        render();
        return;
      }
      const requested = input.checked;
      if (isConcealRefusalKey(prefKey)) {
        refusals.delete(prefKey);
        deps.clearSwitchRefusal?.(prefKey);
      }
      deps.update({ [prefKey]: requested } as Partial<ConcealPrefs>);
      if (
        requested &&
        isConcealRefusalKey(prefKey) &&
        deps.getPrefs()[prefKey] !== true &&
        !refusals.has(prefKey)
      ) {
        refusals.set(
          prefKey,
          texts.needsTransparent.includes('透明')
            ? '没有生效，开关保持关闭。'
            : 'This did not take effect. The switch stays off.',
        );
      }
      render();
    });
    toggles.set(prefKey, { input, text, reason });
  }
  const toggleWrap = (key: ConcealToggleKey): HTMLElement =>
    toggles.get(key)?.input.closest('.lightink-library-conceal-switch') ?? doc.createElement('div');

  dodge.append(
    bossHint,
    ...(macHint === null ? [] : [macHint]),
    primaryField.input.closest('.lightink-library-conceal-key-field') ?? primaryField.input,
  );
  disguise.append(
    backgroundText,
    swatchRow,
    gradientNote,
    customRow,
    toggleWrap('transparentMode'),
    opacityField,
    toggleWrap('hideTop'),
    toggleWrap('hideBody'),
    toggleWrap('hideBottom'),
  );
  floatGroup.append(
    toggleWrap('alwaysOnTop'),
    toggleWrap('miniWindow'),
    toggleWrap('clickThrough'),
  );
  exit.append(
    toggleWrap('runInBackground'),
    exitHint,
    secondaryField.input.closest('.lightink-library-conceal-key-field') ?? secondaryField.input,
  );
  body.append(scenes, dodge, disguise, floatGroup, exit);
  section.append(title, hint, enabledWrap, body);
  bindRadioGroupKeys(scenes, '[role="radio"]');

  const paintSwatch = (value: ConcealBackgroundValue, chip: HTMLElement, prefs: ConcealPrefs): void => {
    if (value === 'theme') {
      chip.style.background = '';
      return;
    }
    const colors =
      value === 'custom'
        ? prefs.background.kind === 'custom'
          ? { from: prefs.background.from, to: prefs.background.to }
          : { from: '#b9b9b9', to: '#f7f7f7' }
        : CONCEAL_GRADIENT_PRESETS[value];
    chip.style.background = `linear-gradient(180deg, ${colors.from} 0%, ${colors.to} 100%)`;
  };

  const keyFields = [primaryField, secondaryField];

  function render(registerResult?: ConcealBossKeysStatus): void {
    const prefs = deps.getPrefs();
    enabledInput.checked = prefs.enabled;
    body.hidden = !prefs.enabled;
    const scene = concealSceneOf(prefs);
    title.textContent = `${texts.group} · ${texts.scenes[scene]} · ${prefs.bossPrimary}`;
    for (const [choice, sceneButton] of sceneButtons) {
      const selected = scene === choice;
      sceneButton.setAttribute('aria-checked', String(selected));
      sceneButton.classList.toggle('is-active', selected);
      // radiogroup 惯例：仅选中项进 Tab 序，其余走方向键。
      sceneButton.tabIndex = selected ? 0 : -1;
    }
    customScene.classList.toggle('is-active', scene === 'custom');
    customScene.setAttribute('aria-current', scene === 'custom' ? 'true' : 'false');
    for (const [choice, result] of sceneResults) {
      result.textContent = concealSceneResult(choice, texts.sceneResults);
    }
    const showCustomEffect = scene === 'custom';
    customEffect.hidden = !showCustomEffect;
    customEffect.textContent = showCustomEffect ? concealCustomEffect(prefs, texts.effects) : '';

    for (const field of keyFields) {
      if (registerResult !== undefined) {
        const error = field.prefKey === 'bossPrimary' ? registerResult.primaryError : registerResult.secondaryError;
        const combo = field.prefKey === 'bossPrimary' ? registerResult.primary : registerResult.secondary;
        field.attemptReason = null;
        field.status.classList.toggle('is-error', error !== null);
        field.status.textContent =
          error !== null
            ? error
            : combo !== null
              ? texts.bossKeyActive.replace('{combo}', combo)
              : texts.bossKeyUnregistered;
        field.statusBeforeRecord = field.status.textContent ?? '';
      }
      if (field.input.dataset.recording !== 'true') {
        field.input.value = prefs[field.prefKey];
      }
    }

    const selectedBackground: ConcealBackgroundValue =
      prefs.background.kind === 'theme'
        ? 'theme'
        : prefs.background.kind === 'preset'
          ? prefs.background.preset
          : 'custom';
    for (const [value, swatch] of swatches) {
      const selected = value === selectedBackground;
      swatch.button.classList.toggle('is-active', selected);
      swatch.button.setAttribute('aria-pressed', String(selected));
      paintSwatch(value, swatch.chip, prefs);
    }
    customRow.hidden = prefs.background.kind !== 'custom';
    if (prefs.background.kind === 'custom') {
      customFrom.value = prefs.background.from;
      customTo.value = prefs.background.to;
    }
    gradientNote.hidden = !prefs.transparentMode;

    for (const [prefKey, toggle] of toggles) {
      const locked =
        !prefs.transparentMode &&
        (prefKey === 'hideTop' || prefKey === 'hideBody' || prefKey === 'clickThrough');
      toggle.input.disabled = locked;
      toggle.input.checked = prefs[prefKey] === true;
      const refused = isConcealRefusalKey(prefKey) ? refusals.get(prefKey) : undefined;
      let reason = '';
      let error = false;
      if (locked) {
        reason = texts.needsTransparent;
        error = true;
      } else if (refused !== undefined && prefs[prefKey] !== true) {
        reason = refused;
        error = true;
      } else if (prefKey === 'clickThrough' && prefs.transparentMode) {
        reason = texts.clickThroughHint;
      } else if (prefKey === 'runInBackground' && prefs.runInBackground) {
        reason = texts.runInBackgroundHint;
      }
      toggle.reason.hidden = reason === '';
      toggle.reason.textContent = reason;
      toggle.reason.classList.toggle('is-error', error);
    }
    if (opacityInput.dataset.recording !== 'true') {
      opacityInput.value = String(prefs.contentOpacity);
    }
  }

  const unsubscribe =
    deps.subscribeSwitchRefusal?.((key, reason) => {
      refusals.set(key, reason);
      render();
    }) ?? null;

  return {
    section,
    retranslate(): void {
      const labels = deps.labels();
      texts.group = labels.group;
      texts.groupHint = labels.groupHint;
      texts.enabled = labels.enabled;
      texts.enabledHint = labels.enabledHint;
      enabledText.textContent = labels.enabled;
      enabledHint.textContent = labels.enabledHint;
      enabledInput.setAttribute('aria-label', labels.enabled);
      texts.bossKeyHint = labels.bossKeyHint;
      texts.macBossKeyHint = labels.macBossKeyHint;
      texts.bossKey1 = labels.bossKey1;
      texts.bossKey2 = labels.bossKey2;
      texts.bossKeyActive = labels.bossKeyActive;
      texts.bossKeyEmpty = labels.bossKeyEmpty;
      texts.bossKeyInvalid = labels.bossKeyInvalid;
      texts.bossKeySame = labels.bossKeySame;
      texts.bossKeyUnregistered = labels.bossKeyUnregistered;
      texts.recordCombo = labels.recordCombo;
      texts.background = labels.background;
      texts.backgroundLabels = {
        theme: labels.backgroundTheme,
        lavender: labels.backgroundPresets.lavender,
        mint: labels.backgroundPresets.mint,
        peach: labels.backgroundPresets.peach,
        sky: labels.backgroundPresets.sky,
        butter: labels.backgroundPresets.butter,
        custom: labels.backgroundCustom,
      };
      texts.customFrom = labels.customFrom;
      texts.customTo = labels.customTo;
      texts.contentOpacity = labels.contentOpacity;
      texts.opacityScale = labels.opacityScale;
      texts.needsTransparent = labels.needsTransparent;
      texts.gradientHidden = labels.gradientHidden;
      texts.clickThroughHint = labels.clickThroughHint;
      texts.runInBackgroundHint = labels.runInBackgroundHint;
      texts.exitHint = labels.exitHint;
      texts.scenes = {
        normal: labels.sceneNormal,
        hideOnLeave: labels.sceneHideOnLeave,
        floating: labels.sceneFloating,
        custom: labels.sceneCustom,
      };
      texts.sceneResults = {
        sceneNormalResult: labels.sceneNormalResult,
        sceneHideOnLeaveResult: labels.sceneHideOnLeaveResult,
        sceneFloatingResult: labels.sceneFloatingResult,
      };
      texts.effects = {
        effectWindowTransparent: labels.effectWindowTransparent,
        effectWindowOpaque: labels.effectWindowOpaque,
        effectOpacity: labels.effectOpacity,
        effectHideNone: labels.effectHideNone,
        effectHidePrefix: labels.effectHidePrefix,
        regionSeparator: labels.regionSeparator,
        regionTop: labels.regionTop,
        regionBody: labels.regionBody,
        regionBottom: labels.regionBottom,
        effectPinned: labels.effectPinned,
        effectNotPinned: labels.effectNotPinned,
        effectMini: labels.effectMini,
        effectNotMini: labels.effectNotMini,
        effectClickThrough: labels.effectClickThrough,
        effectNoClickThrough: labels.effectNoClickThrough,
        effectSeparator: labels.effectSeparator,
      };
      texts.groups = {
        dodge: labels.groupDodge,
        disguise: labels.groupDisguise,
        float: labels.groupFloat,
        exit: labels.groupExit,
      };
      texts.toggles = {
        transparentMode: labels.transparentMode,
        hideTop: labels.hideTop,
        hideBody: labels.hideBody,
        hideBottom: labels.hideBottom,
        alwaysOnTop: labels.alwaysOnTop,
        miniWindow: labels.miniWindow,
        clickThrough: labels.clickThrough,
        runInBackground: labels.runInBackground,
      };
      hint.textContent = labels.groupHint;
      scenes.setAttribute('aria-label', labels.group);
      for (const [choice, sceneButton] of sceneButtons) {
        sceneButton.textContent = texts.scenes[choice];
      }
      customScene.textContent = texts.scenes.custom;
      const headings: Record<'dodge' | 'disguise' | 'float' | 'exit', HTMLElement> = {
        dodge,
        disguise,
        float: floatGroup,
        exit,
      };
      for (const id of ['dodge', 'disguise', 'float', 'exit'] as const) {
        const heading = headings[id].querySelector('h3');
        if (heading !== null) {
          heading.textContent = texts.groups[id];
        }
      }
      bossHint.textContent = labels.bossKeyHint;
      if (macHint !== null) {
        macHint.textContent = labels.macBossKeyHint;
      }
      exitHint.textContent = labels.exitHint;
      primaryField.input.setAttribute('aria-label', labels.bossKey1);
      primaryField.input.title = labels.bossKey1;
      secondaryField.input.setAttribute('aria-label', labels.bossKey2);
      secondaryField.input.title = labels.bossKey2;
      const primaryName = section.querySelector<HTMLElement>('[data-conceal-key-name="bossPrimary"]');
      const secondaryName = section.querySelector<HTMLElement>('[data-conceal-key-name="bossSecondary"]');
      if (primaryName !== null) {
        primaryName.textContent = labels.bossKey1;
      }
      if (secondaryName !== null) {
        secondaryName.textContent = labels.bossKey2;
      }
      backgroundText.textContent = labels.background;
      swatchRow.setAttribute('aria-label', labels.background);
      for (const [value, swatch] of swatches) {
        swatch.name.textContent = texts.backgroundLabels[value];
        swatch.button.setAttribute('aria-label', texts.backgroundLabels[value]);
        swatch.button.title = texts.backgroundLabels[value];
      }
      gradientNote.textContent = labels.gradientHidden;
      customFromText.textContent = labels.customFrom;
      customToText.textContent = labels.customTo;
      opacityText.textContent = labels.contentOpacity;
      opacityScale.textContent = labels.opacityScale;
      opacityInput.setAttribute('aria-label', labels.contentOpacity);
      for (const [prefKey, toggle] of toggles) {
        toggle.text.textContent = texts.toggles[prefKey];
      }
      render();
    },
    destroy(): void {
      unsubscribe?.();
    },
  };
}

export function createLibraryManage(
  doc: Document,
  options: LibraryManageOptions,
): LibraryManageView {
  const labels = options.labels;
  let currentLibraryTheme = loadLibraryTheme(options.themeStorage);
  let currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
  applyReaderPrefs(doc.documentElement, currentReaderPrefs);
  let subpage: ManageSubpage = 'home';

  const element = doc.createElement('div');
  element.className = 'lightink-library-manage-panel';
  element.dataset.managePage = subpage;

  const home = doc.createElement('div');
  home.className = 'lightink-library-manage-home';

  // 外观：书架主题色板，内联。
  const appearance = doc.createElement('section');
  appearance.className = 'lightink-library-manage-group lightink-library-appearance';
  appearance.dataset.manageGroup = 'appearance';
  const appearanceTitle = doc.createElement('h2');
  appearanceTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const appearanceSummary = groupSummary(doc);
  const appearanceHint = doc.createElement('p');
  appearanceHint.className = 'lightink-library-appearance-hint';
  const themeSwatches = doc.createElement('div');
  themeSwatches.className = 'lightink-library-theme-swatches';
  themeSwatches.setAttribute('role', 'radiogroup');
  appearance.append(appearanceTitle, appearanceHint, appearanceSummary, themeSwatches);
  bindRadioGroupKeys(themeSwatches, '.lightink-library-theme-swatch');

  // 阅读偏好：阅读器进度条开关，内联。
  const readerPrefs = doc.createElement('section');
  readerPrefs.className = 'lightink-library-manage-group lightink-library-reader-prefs';
  readerPrefs.dataset.manageGroup = 'reading';
  const readerPrefsTitle = doc.createElement('h2');
  readerPrefsTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const readerPrefsSummary = groupSummary(doc);
  const readerPrefsHint = doc.createElement('p');
  readerPrefsHint.className = 'lightink-library-appearance-hint';
  const progressBarLabel = doc.createElement('label');
  progressBarLabel.className = 'lightink-library-reader-pref';
  const progressBarInput = doc.createElement('input');
  progressBarInput.type = 'checkbox';
  progressBarInput.name = 'showProgressBar';
  const progressBarText = doc.createElement('span');
  progressBarLabel.append(progressBarInput, progressBarText);
  // 阅读偏好：翻页动画样式（R1）——auto/slide/fade/curl/none；标签居左、
  // select 居右的设置行（同 iOS/系统设置惯例，避免 select 满宽把标签挤折行）。
  const pageTurnField = doc.createElement('label');
  pageTurnField.className = 'lightink-library-page-turn-field';
  const pageTurnSelect = doc.createElement('select');
  pageTurnSelect.name = 'pageTurnStyle';
  const pageTurnOptions = new Map<ReaderPageTurnStyle, HTMLOptionElement>();
  for (const style of READER_PAGE_TURN_STYLES) {
    const option = doc.createElement('option');
    option.value = style;
    pageTurnOptions.set(style, option);
    pageTurnSelect.append(option);
  }
  pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
  const pageTurnText = doc.createElement('span');
  pageTurnText.className = 'lightink-library-page-turn-label';
  pageTurnField.append(pageTurnText, pageTurnSelect);
  readerPrefs.append(
    readerPrefsTitle,
    readerPrefsHint,
    readerPrefsSummary,
    progressBarLabel,
    pageTurnField,
  );

  // AI 分组(R2):唯一活动提供商——端点格式三选一(联动预填官方 base URL,
  // 可改)、base URL/模型/Key、allowHttp、测试连接(role=status 结果)、目标
  // 语言覆盖;保存/清除密钥后广播 lightink:reader-ai-configured。
  const aiGroup = doc.createElement('section');
  aiGroup.className = 'lightink-library-manage-group lightink-library-ai';
  aiGroup.dataset.manageGroup = 'ai';
  const aiTitle = doc.createElement('h2');
  aiTitle.className = 'lightink-library-manage-group-title lightink-library-appearance-title';
  const aiSummary = groupSummary(doc);
  const aiHint = doc.createElement('p');
  aiHint.className = 'lightink-library-appearance-hint lightink-library-ai-hint';

  const aiEndpointField = doc.createElement('label');
  aiEndpointField.className = 'lightink-library-field lightink-library-ai-endpoint-field';
  const aiEndpointSelect = doc.createElement('select');
  aiEndpointSelect.name = 'aiEndpointKind';
  const aiEndpointOptions = new Map<AiEndpointKindId, HTMLOptionElement>();
  for (const kind of AI_ENDPOINT_KINDS) {
    const option = doc.createElement('option');
    option.value = kind;
    aiEndpointOptions.set(kind, option);
    aiEndpointSelect.append(option);
  }
  const aiEndpointText = doc.createElement('span');
  aiEndpointField.append(aiEndpointText, aiEndpointSelect);

  const aiBaseField = doc.createElement('label');
  aiBaseField.className = 'lightink-library-field lightink-library-ai-base-field';
  const aiBaseLabelText = doc.createElement('span');
  const aiBaseUrlInput = doc.createElement('input');
  aiBaseUrlInput.type = 'url';
  aiBaseUrlInput.name = 'aiBaseUrl';
  aiBaseUrlInput.autocomplete = 'off';
  aiBaseUrlInput.spellcheck = false;
  aiBaseField.append(aiBaseLabelText, aiBaseUrlInput);

  const aiModelField = doc.createElement('label');
  aiModelField.className = 'lightink-library-field lightink-library-ai-model-field';
  const aiModelLabelText = doc.createElement('span');
  const aiModelInput = doc.createElement('input');
  aiModelInput.type = 'text';
  aiModelInput.name = 'aiModel';
  aiModelInput.autocomplete = 'off';
  aiModelInput.spellcheck = false;
  aiModelField.append(aiModelLabelText, aiModelInput);

  const aiKeyField = doc.createElement('label');
  aiKeyField.className = 'lightink-library-field lightink-library-ai-key-field';
  const aiKeyLabelText = doc.createElement('span');
  const aiKeyInput = doc.createElement('input');
  aiKeyInput.type = 'password';
  aiKeyInput.name = 'aiApiKey';
  aiKeyInput.autocomplete = 'off';
  aiKeyInput.spellcheck = false;
  aiKeyField.append(aiKeyLabelText, aiKeyInput);
  const aiKeyClear = button(doc, '', 'lightink-library-ai-key-clear');
  // 明文/掩码切换：粘贴密钥后方便核对（aria-pressed 记录展开态）。
  const aiKeyReveal = button(doc, '', 'lightink-library-ai-key-reveal');
  aiKeyReveal.setAttribute('aria-pressed', 'false');
  const aiKeyRow = doc.createElement('div');
  aiKeyRow.className = 'lightink-library-ai-key-row';
  aiKeyRow.append(aiKeyField, aiKeyReveal, aiKeyClear);

  const aiAllowHttpLabel = doc.createElement('label');
  aiAllowHttpLabel.className = 'lightink-library-reader-pref lightink-library-ai-allow-http';
  const aiAllowHttpInput = doc.createElement('input');
  aiAllowHttpInput.type = 'checkbox';
  aiAllowHttpInput.name = 'aiAllowHttp';
  const aiAllowHttpText = doc.createElement('span');
  aiAllowHttpLabel.append(aiAllowHttpInput, aiAllowHttpText);

  const aiTargetLangField = doc.createElement('label');
  aiTargetLangField.className = 'lightink-library-field lightink-library-ai-target-lang-field';
  const aiTargetLangSelect = doc.createElement('select');
  aiTargetLangSelect.name = 'aiTargetLang';
  const aiTargetLangOptions = new Map<AiTargetLangValue, HTMLOptionElement>();
  for (const value of AI_TARGET_LANG_VALUES) {
    const option = doc.createElement('option');
    option.value = value;
    aiTargetLangOptions.set(value, option);
    aiTargetLangSelect.append(option);
  }
  const aiTargetLangText = doc.createElement('span');
  aiTargetLangField.append(aiTargetLangText, aiTargetLangSelect);

  const aiActions = doc.createElement('div');
  aiActions.className = 'lightink-library-ai-actions';
  // 单一「保存配置」:密钥框有内容时一并写入钥匙串(清除密钥在密钥框旁)。
  const aiSave = button(doc, '', 'lightink-library-primary lightink-library-ai-save');
  const aiTest = button(doc, '', 'lightink-library-ai-test');
  aiActions.append(aiSave, aiTest);

  const aiFeedback = doc.createElement('p');
  aiFeedback.className = 'lightink-library-ai-feedback';
  aiFeedback.setAttribute('role', 'status');
  aiFeedback.hidden = true;
  const aiStatus = doc.createElement('p');
  aiStatus.className = 'lightink-library-ai-status';
  aiStatus.setAttribute('aria-live', 'polite');
  aiGroup.append(
    aiTitle,
    aiHint,
    aiSummary,
    aiEndpointField,
    aiBaseField,
    aiModelField,
    aiKeyRow,
    aiAllowHttpLabel,
    aiTargetLangField,
    aiActions,
    aiFeedback,
    aiStatus,
  );

  let aiStatusState = fallbackAiConfigStatus();
  let aiEndpointKind: AiEndpointKindId = aiStatusState.endpointKind;
  const aiDefaultsByKind = new Map<AiEndpointKindId, string>();
  let aiConfigEpoch = 0;
  let aiTestBusy = false;
  // 未保存的手工编辑标记:语言切换触发 retranslate → refreshAiConfig 回填时,
  // 不得用已保存值静默覆写用户正在编辑(且未聚焦)的 base URL/模型输入。
  let aiBaseDirty = false;
  let aiModelDirty = false;
  aiBaseUrlInput.addEventListener('input', () => {
    aiBaseDirty = true;
    syncAiState();
  });
  aiModelInput.addEventListener('input', () => {
    aiModelDirty = true;
    syncAiState();
  });
  aiKeyInput.addEventListener('input', () => {
    syncAiState();
  });

  const readAiEndpointKind = (): AiEndpointKindId =>
    isAiEndpointKind(aiEndpointSelect.value) ? aiEndpointSelect.value : 'openai-chat';

  // 表单里已经填上的项不再算缺口；空着的地址、模型和密钥用字段名点出来。
  const displayedAiGaps = (): string[] => {
    const filled = new Set<string>(['endpoint_kind']);
    if (aiBaseUrlInput.value.trim() !== '') filled.add('base_url');
    if (aiModelInput.value.trim() !== '') filled.add('model');
    if (aiKeyInput.value.trim() !== '' || aiStatusState.hasKey) filled.add('api_key');
    const merged: string[] = [];
    if (!filled.has('base_url')) merged.push('base_url');
    if (!filled.has('model')) merged.push('model');
    if (!filled.has('api_key')) merged.push('api_key');
    for (const gap of aiStatusState.missing) {
      const name = canonicalAiGap(gap);
      if (!filled.has(name) && !merged.includes(name)) merged.push(name);
    }
    return merged;
  };

  const syncAiState = (): void => {
    const l = labels();
    const gaps = displayedAiGaps();
    const summary = aiMissingSummary(l, gaps);
    const configured = aiStatusState.configured && gaps.length === 0;
    aiStatus.textContent = configured
      ? l.aiConfigured
      : summary === ''
        ? l.aiUnconfigured
        : l.aiUnconfiguredGaps.replace('{missing}', summary);
    aiStatus.dataset.aiConfigured = configured ? 'true' : 'false';
    setGroupSummary(aiSummary, aiStatus.textContent ?? '');
    const hints = aiFieldHints(l);
    aiBaseUrlInput.placeholder = hints.baseUrl;
    aiModelInput.placeholder = hints.model;
    aiKeyInput.placeholder = aiStatusState.hasKey ? l.aiKeySavedPlaceholder : hints.key;
    aiBaseUrlInput.setAttribute('aria-invalid', String(gaps.includes('base_url')));
    aiModelInput.setAttribute('aria-invalid', String(gaps.includes('model')));
    aiKeyInput.setAttribute('aria-invalid', String(gaps.includes('api_key')));
    aiKeyClear.hidden = !aiStatusState.hasKey;
    aiKeyClear.disabled = !aiStatusState.hasKey;
    // 密钥框为空时无可核对内容：收起明文并禁用切换。
    if (aiKeyInput.value === '') {
      aiKeyInput.type = 'password';
      aiKeyReveal.setAttribute('aria-pressed', 'false');
      aiKeyReveal.textContent = l.aiKeyShow;
    }
    aiKeyReveal.disabled = aiKeyInput.value === '';
  };

  aiKeyReveal.addEventListener('click', () => {
    const reveal = aiKeyInput.type === 'password';
    aiKeyInput.type = reveal ? 'text' : 'password';
    aiKeyReveal.setAttribute('aria-pressed', String(reveal));
    aiKeyReveal.textContent = reveal ? labels().aiKeyHide : labels().aiKeyShow;
    aiKeyInput.focus();
  });

  const setAiFeedback = (text: string, kind: 'info' | 'success' | 'error'): void => {
    aiFeedback.textContent = text;
    aiFeedback.hidden = text === '';
    aiFeedback.dataset.kind = kind;
  };

  const applyAiStatus = (status: AiConfigStatusView, fromSave = false): void => {
    aiStatusState = status;
    aiEndpointKind = isAiEndpointKind(status.endpointKind) ? status.endpointKind : 'openai-chat';
    for (const entry of status.defaults) {
      aiDefaultsByKind.set(entry.endpointKind, entry.baseUrl);
    }
    aiEndpointSelect.value = aiEndpointKind;
    if (fromSave) {
      aiBaseDirty = false;
      aiModelDirty = false;
    }
    if (fromSave || (!aiBaseDirty && doc.activeElement !== aiBaseUrlInput)) {
      aiBaseUrlInput.value = status.baseUrl;
    }
    if (fromSave || (!aiModelDirty && doc.activeElement !== aiModelInput)) {
      aiModelInput.value = status.model;
    }
    aiAllowHttpInput.checked = status.allowHttp;
    aiTargetLangSelect.value = AI_TARGET_LANG_VALUES.includes(
      status.targetLang as AiTargetLangValue,
    )
      ? (status.targetLang as AiTargetLangValue)
      : 'auto';
    syncAiState();
  };

  const refreshAiConfig = async (): Promise<void> => {
    const epoch = ++aiConfigEpoch;
    try {
      const status = await invokeAiGetConfig();
      if (epoch !== aiConfigEpoch) return;
      applyAiStatus(status);
    } catch {
      // 浏览器预览等无后端环境:保持本地默认形态。
      if (epoch !== aiConfigEpoch) return;
      applyAiStatus(fallbackAiConfigStatus());
    }
  };

  // 首帧即按默认形态预填(openai-chat + 官方 base URL),避免异步读取期间空表单。
  applyAiStatus(fallbackAiConfigStatus());

  // 端点格式切换:base URL 仍为旧格式官方默认(或空)时联动预填新格式默认;
  // 用户改过自定义地址则不动。
  aiEndpointSelect.addEventListener('change', () => {
    const next = readAiEndpointKind();
    const previousDefault = aiDefaultsByKind.get(aiEndpointKind);
    const current = aiBaseUrlInput.value.trim();
    if (current === '' || (previousDefault !== undefined && current === previousDefault)) {
      const nextDefault = aiDefaultsByKind.get(next);
      if (nextDefault !== undefined) {
        aiBaseUrlInput.value = nextDefault;
      }
    }
    aiEndpointKind = next;
    syncAiState();
  });

  const saveAiConfig = async (): Promise<void> => {
    aiSave.disabled = true;
    try {
      // 密钥框有内容时先写入钥匙串(失败即止);留空不动既有密钥。
      // 整次保存成功后才清空密钥框,失败时地址、模型和密钥都留在表单里。
      const key = aiKeyInput.value.trim();
      if (key !== '') {
        await invokeAiStoreKey(key);
      }
      const status = await invokeAiSaveConfig({
        endpointKind: readAiEndpointKind(),
        baseUrl: aiBaseUrlInput.value.trim(),
        model: aiModelInput.value.trim(),
        allowHttp: aiAllowHttpInput.checked,
        targetLang: aiTargetLangSelect.value === 'auto' ? undefined : aiTargetLangSelect.value,
      });
      if (key !== '') aiKeyInput.value = '';
      applyAiStatus(status, true);
      setAiFeedback(labels().aiSaved, 'success');
      dispatchAiConfigured({ configured: status.configured, missing: status.missing }, doc);
    } catch (error) {
      setAiFeedback(aiErrorMessage(labels(), error, displayedAiGaps()), 'error');
    } finally {
      aiSave.disabled = false;
    }
  };
  aiSave.addEventListener('click', () => {
    void saveAiConfig();
  });
  aiKeyClear.addEventListener('click', () => {
    void (async () => {
      aiKeyClear.disabled = true;
      try {
        const status = await invokeAiForgetKey();
        aiKeyInput.value = '';
        applyAiStatus(status, true);
        setAiFeedback(labels().aiKeyCleared, 'info');
        dispatchAiConfigured({ configured: status.configured, missing: status.missing }, doc);
      } catch (error) {
        setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
      } finally {
        aiKeyClear.disabled = false;
        syncAiState();
      }
    })();
  });

  aiTest.addEventListener('click', () => {
    void (async () => {
      aiTestBusy = true;
      aiTest.disabled = true;
      aiTest.textContent = labels().aiTesting;
      setAiFeedback(labels().aiTesting, 'info');
      try {
        const result = await invokeAiTestConnection();
        setAiFeedback(labels().aiTestOk.replace('{ms}', String(result.latencyMs)), 'success');
      } catch (error) {
        setAiFeedback(aiErrorMessage(labels(), error, aiStatusState.missing), 'error');
      } finally {
        aiTestBusy = false;
        aiTest.disabled = false;
        aiTest.textContent = labels().aiTest;
      }
    })();
  });

  // 存储与缓存：用量摘要 + 清理缓存 + 缓存上限（弹层入口）。
  const storage = doc.createElement('section');
  storage.className = 'lightink-library-manage-group';
  storage.dataset.manageGroup = 'storage';
  const storageTitle = doc.createElement('h2');
  storageTitle.className = 'lightink-library-manage-group-title';
  const storageSummary = groupSummary(doc);
  const cacheSummary = doc.createElement('div');
  cacheSummary.className = 'lightink-library-cache-summary';
  cacheSummary.hidden = true;
  const cacheUsage = doc.createElement('span');
  cacheSummary.append(cacheUsage);
  // 清理缓存是动作（弹确认后直接执行）：红色文字、无 ›；
  // 调整缓存上限打开弹层：给 › 指示去向。
  const clearCacheRow = manageRow(doc, 'is-danger', false);
  const clearCacheButton = clearCacheRow.button;
  const cacheLimitRow = manageRow(doc, 'lightink-library-cache-limit-entry', true);
  const cacheLimitButton = cacheLimitRow.button;
  storage.append(
    storageTitle,
    storageSummary,
    cacheSummary,
    clearCacheButton,
    cacheLimitButton,
  );

  // 同步：WebDAV 同步入口（deps 缺省时整组抑制）。
  let sync: HTMLElement | null = null;
  let syncButton: HTMLButtonElement | null = null;
  let syncLabel: HTMLSpanElement | null = null;
  let syncTitle: HTMLHeadingElement | null = null;
  if (options.onOpenSyncPanel !== undefined) {
    sync = doc.createElement('section');
    sync.className = 'lightink-library-manage-group';
    sync.dataset.manageGroup = 'sync';
    syncTitle = doc.createElement('h2');
    syncTitle.className = 'lightink-library-manage-group-title';
    const syncRow = manageRow(doc, 'lightink-library-sync-entry', true);
    syncButton = syncRow.button;
    syncLabel = syncRow.label;
    sync.append(syncTitle, syncButton);
  }

  // 其他：导入本地书籍 + 编辑器入口（仅桌面，deps 缺省抑制）。
  const other = doc.createElement('section');
  other.className = 'lightink-library-manage-group';
  other.dataset.manageGroup = 'other';
  const otherTitle = doc.createElement('h2');
  otherTitle.className = 'lightink-library-manage-group-title';
  const importRow = manageRow(doc, 'lightink-library-import-entry', true);
  const importButton = importRow.button;
  other.append(otherTitle, importButton);
  let editorButton: HTMLButtonElement | null = null;
  let editorLabel: HTMLSpanElement | null = null;
  if (options.onEnterEditor !== undefined) {
    const editorRow = manageRow(doc, 'lightink-library-editor-entry', true);
    editorButton = editorRow.button;
    editorLabel = editorRow.label;
    other.append(editorButton);
  }

  const concealUi =
    options.conceal === undefined ? null : mountConcealSection(doc, options.conceal);


  home.append(
    appearance,
    readerPrefs,
    aiGroup,
    storage,
    ...(sync === null ? [] : [sync]),
    ...(concealUi === null ? [] : [concealUi.section]),
    other,
  );
  setupManageGroupCollapsing(home);
  element.append(home);

  const cacheLimitOverlay = doc.createElement('div');
  cacheLimitOverlay.className = 'lightink-modal-overlay lightink-library-cache-limit-modal';
  cacheLimitOverlay.hidden = true;
  const cacheLimitDialog = doc.createElement('div');
  cacheLimitDialog.className = 'lightink-modal-dialog';
  cacheLimitDialog.setAttribute('role', 'dialog');
  cacheLimitDialog.setAttribute('aria-modal', 'true');
  cacheLimitDialog.setAttribute('aria-labelledby', 'lightink-library-cache-limit-title');
  const cacheLimitTitle = doc.createElement('h2');
  cacheLimitTitle.id = 'lightink-library-cache-limit-title';
  cacheLimitTitle.className = 'lightink-library-cache-limit-title';
  const cacheLimitForm = doc.createElement('form');
  cacheLimitForm.className = 'lightink-library-cache-limit-form';
  const cacheLimitLabel = doc.createElement('label');
  cacheLimitLabel.className = 'lightink-library-field';
  const cacheLimitLabelText = doc.createElement('span');
  const cacheLimitInput = doc.createElement('input');
  cacheLimitInput.type = 'number';
  cacheLimitInput.name = 'cacheLimitGiB';
  cacheLimitInput.min = '0.25';
  cacheLimitInput.max = '1024';
  cacheLimitInput.step = '0.25';
  cacheLimitInput.required = true;
  cacheLimitLabel.append(cacheLimitLabelText, cacheLimitInput);
  const cacheLimitActions = doc.createElement('div');
  cacheLimitActions.className = 'lightink-library-cache-limit-actions';
  const cacheLimitSave = button(doc, '', 'lightink-library-primary');
  cacheLimitSave.type = 'submit';
  const cacheLimitCancel = button(doc, '', 'lightink-library-cache-limit-cancel');
  cacheLimitActions.append(cacheLimitSave, cacheLimitCancel);
  cacheLimitForm.append(cacheLimitLabel, cacheLimitActions);
  cacheLimitDialog.append(cacheLimitTitle, cacheLimitForm);
  cacheLimitOverlay.append(cacheLimitDialog);
  applyCacheLimitDialogHeightCap(cacheLimitOverlay, cacheLimitDialog);

  let ignoreCacheBackdrop = true;

  function setSubpage(next: ManageSubpage): void {
    subpage = next;
    element.dataset.managePage = next;
    cacheLimitOverlay.hidden = next === 'home';
    if (next === 'cache-limit') {
      ignoreCacheBackdrop = true;
      mountLibraryOverlay(cacheLimitOverlay, options.themeRoot);
      cacheLimitInput.focus();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          ignoreCacheBackdrop = false;
        });
      });
    }
  }

  function renderThemeSwatches(): void {
    themeSwatches.replaceChildren();
    themeSwatches.setAttribute('aria-label', labels().libraryTheme);
    setGroupSummary(appearanceSummary, options.themeLabel(currentLibraryTheme));
    for (const theme of LIBRARY_THEMES) {
      const swatch = button(doc, '', 'lightink-library-theme-swatch');
      // Not data-library-theme: that attribute republishes a preset, and the
      // name is drawn on the shelf page rather than a filled swatch.
      swatch.dataset.libraryThemeId = theme.id;
      const preview = doc.createElement('span');
      preview.className = 'lightink-library-theme-preview';
      preview.style.backgroundColor = theme.page;
      preview.style.borderColor = theme.border;
      const accent = doc.createElement('i');
      accent.style.backgroundColor = theme.accent;
      preview.append(accent);
      const name = doc.createElement('span');
      name.className = 'lightink-library-theme-swatch-name';
      name.textContent = options.themeLabel(theme.id);
      swatch.append(preview, name);
      swatch.title = name.textContent ?? '';
      swatch.setAttribute('aria-label', name.textContent ?? '');
      swatch.setAttribute('role', 'radio');
      swatch.setAttribute('aria-checked', String(theme.id === currentLibraryTheme));
      swatch.classList.toggle('is-active', theme.id === currentLibraryTheme);
      // radiogroup 惯例：仅选中项进 Tab 序，其余走方向键（bindRadioGroupKeys）。
      swatch.tabIndex = theme.id === currentLibraryTheme ? 0 : -1;
      swatch.addEventListener('click', () => {
        currentLibraryTheme = saveLibraryTheme(options.themeStorage, theme.id);
        applyLibraryTheme(options.themeRoot, currentLibraryTheme);
        renderThemeSwatches();
        doc.dispatchEvent(
          new CustomEvent('lightink:library-theme', { detail: currentLibraryTheme }),
        );
      });
      themeSwatches.append(swatch);
    }
  }

  const syncReaderPrefsSummary = (): void => {
    const l = labels();
    const style = pageTurnStyleLabels(l)[currentReaderPrefs.pageTurnStyle];
    setGroupSummary(readerPrefsSummary, `${l.pageTurnStyle} · ${style}`);
  };

  const syncReaderPrefsFromStorage = (): void => {
    currentReaderPrefs = loadReaderPrefs(options.readerPrefsStorage);
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    progressBarInput.checked = currentReaderPrefs.showProgressBar;
    pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
    syncReaderPrefsSummary();
  };

  // 保存任一偏好都携带完整 ReaderPrefs（缺省字段会被规范化回默认值）。
  const commitReaderPrefs = (): void => {
    currentReaderPrefs = saveReaderPrefs(options.readerPrefsStorage, {
      showProgressBar: progressBarInput.checked,
      pageTurnStyle: (pageTurnSelect.value as ReaderPageTurnStyle) ?? 'auto',
    });
    applyReaderPrefs(doc.documentElement, currentReaderPrefs);
    pageTurnSelect.value = currentReaderPrefs.pageTurnStyle;
    syncReaderPrefsSummary();
    doc.dispatchEvent(new CustomEvent('lightink:reader-prefs', { detail: currentReaderPrefs }));
  };

  const onReaderPrefsStorage = (event: Event): void => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (key !== READER_PREFS_STORAGE_KEY) {
      return;
    }
    syncReaderPrefsFromStorage();
  };
  const prefsTarget: Document | Window = doc.defaultView ?? doc;
  prefsTarget.addEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);

  progressBarInput.addEventListener('change', () => {
    commitReaderPrefs();
  });

  // 即时生效：播放函数每次翻页读偏好内存缓存（applyReaderPrefs 刷新），
  // 切换样式后下一次翻页即按新样式播放，无需重开书。
  pageTurnSelect.addEventListener('change', () => {
    commitReaderPrefs();
  });

  importButton.addEventListener('click', () => {
    void options.onImport();
  });
  editorButton?.addEventListener('click', () => options.onEnterEditor?.());
  syncButton?.addEventListener('click', () => options.onOpenSyncPanel?.());

  let clearCachePending = false;
  clearCacheButton.addEventListener('click', () => {
    if (clearCachePending) return;
    clearCachePending = true;
    void (async () => {
      try {
        const l = labels();
        const prompt = cacheClearPrompt(l);
        const choice = await showConfirmDialog(doc, {
          title: prompt.title,
          message: prompt.message,
          buttons: [
            { id: 'cancel', label: l.cancel },
            { id: 'clear', label: l.clearCache, kind: 'danger' },
          ],
          cancelId: 'cancel',
          themeHost: options.themeRoot,
        });
        if (choice !== 'clear') return;
        await options.library.clearCache();
        await view.refreshCache();
      } catch (error) {
        options.notify(options.formatError(error), 'error');
      } finally {
        clearCachePending = false;
      }
    })();
  });

  cacheLimitButton.addEventListener('click', () => {
    setSubpage('cache-limit');
  });
  cacheLimitCancel.addEventListener('click', () => {
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('click', (event) => {
    if (ignoreCacheBackdrop || event.target !== cacheLimitOverlay) return;
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitOverlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    setSubpage('home');
    cacheLimitButton.focus();
  });
  cacheLimitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    // 空值/超界先走内建校验气泡（之前是静默 return，用户无从得知为何没反应）。
    if (!cacheLimitInput.checkValidity()) {
      cacheLimitInput.reportValidity();
      cacheLimitInput.focus();
      return;
    }
    const gibibytes = cacheLimitInput.valueAsNumber;
    if (!Number.isFinite(gibibytes) || gibibytes <= 0) return;
    try {
      await options.library.setCacheLimit(Math.round(gibibytes * 1024 ** 3));
      setSubpage('home');
      await view.refreshCache();
      cacheLimitButton.focus();
    } catch (error) {
      options.notify(options.formatError(error), 'error');
    }
  });

  function retranslate(): void {
    const l = labels();
    appearanceTitle.textContent = l.appearance;
    appearanceHint.textContent = l.libraryThemeHint;
    readerPrefsTitle.textContent = l.readingGroup;
    readerPrefsHint.textContent = l.readerPrefsHint;
    progressBarText.textContent = l.showProgressBar;
    progressBarLabel.title = l.showProgressBar;
    pageTurnText.textContent = l.pageTurnStyle;
    pageTurnField.title = l.pageTurnStyle;
    pageTurnSelect.setAttribute('aria-label', l.pageTurnStyle);
    const optionLabels = pageTurnStyleLabels(l);
    for (const [style, option] of pageTurnOptions) {
      option.textContent = optionLabels[style];
    }
    aiTitle.textContent = l.aiGroup;
    aiHint.textContent = l.aiHint;
    aiEndpointText.textContent = l.aiEndpointKind;
    aiEndpointField.title = l.aiEndpointKind;
    aiEndpointSelect.setAttribute('aria-label', l.aiEndpointKind);
    const aiEndpointLabels: Record<AiEndpointKindId, string> = {
      'openai-responses': l.aiEndpointOpenaiResponses,
      'openai-chat': l.aiEndpointOpenaiChat,
      'claude-messages': l.aiEndpointClaudeMessages,
    };
    for (const [kind, option] of aiEndpointOptions) {
      option.textContent = aiEndpointLabels[kind];
    }
    aiBaseLabelText.textContent = l.aiBaseUrl;
    aiModelLabelText.textContent = l.aiModel;
    aiKeyLabelText.textContent = l.aiKey;
    aiAllowHttpText.textContent = l.aiAllowHttp;
    aiAllowHttpLabel.title = l.aiAllowHttp;
    aiTargetLangText.textContent = l.aiTargetLang;
    aiTargetLangField.title = l.aiTargetLang;
    aiTargetLangSelect.setAttribute('aria-label', l.aiTargetLang);
    for (const [value, option] of aiTargetLangOptions) {
      option.textContent = aiTargetLangLabel(value, l);
    }
    aiSave.textContent = l.aiSave;
    aiTest.textContent = aiTestBusy ? l.aiTesting : l.aiTest;
    aiKeyClear.textContent = l.aiKeyClear;
    aiKeyReveal.textContent =
      aiKeyReveal.getAttribute('aria-pressed') === 'true' ? l.aiKeyHide : l.aiKeyShow;
    syncAiState();
    void refreshAiConfig();
    storageTitle.textContent = l.storageGroup;
    clearCacheRow.label.textContent = l.clearCache;
    cacheLimitRow.label.textContent = l.changeCacheLimit;
    cacheLimitButton.title = l.changeCacheLimit;
    cacheLimitButton.setAttribute('aria-label', l.changeCacheLimit);
    if (syncTitle !== null) syncTitle.textContent = l.syncGroup;
    if (syncButton !== null && syncLabel !== null) {
      syncLabel.textContent = l.webdavSync;
      syncButton.title = l.webdavSync;
      syncButton.setAttribute('aria-label', l.webdavSync);
    }
    otherTitle.textContent = l.otherGroup;
    importRow.label.textContent = l.importLocal;
    importButton.title = l.importLocal;
    importButton.setAttribute('aria-label', l.importLocal);
    if (editorButton !== null && editorLabel !== null) {
      editorLabel.textContent = l.markdownEditor;
      editorButton.title = l.markdownEditor;
      editorButton.setAttribute('aria-label', l.markdownEditor);
    }
    concealUi?.retranslate();
    cacheLimitTitle.textContent = l.changeCacheLimit;
    cacheLimitLabelText.textContent = l.cacheLimit;
    cacheLimitSave.textContent = l.apply;
    cacheLimitCancel.textContent = l.cancel;
    renderThemeSwatches();
    syncReaderPrefsFromStorage();
  }

  const view: LibraryManageView = {
    element,
    showHome(): void {
      setSubpage('home');
    },
    handleEscape(): boolean {
      if (subpage === 'home') return false;
      setSubpage('home');
      cacheLimitButton.focus();
      return true;
    },
    async refreshCache(): Promise<void> {
      try {
        const cache = await options.library.cacheStats();
        cacheUsage.textContent = labels()
          .cacheUsage.replace('{used}', bytesLabel(cache.bytesCached))
          .replace('{limit}', bytesLabel(cache.limitBytes));
        if (doc.activeElement !== cacheLimitInput) {
          cacheLimitInput.value = String(cache.limitBytes / 1024 ** 3);
        }
      } catch {
        // 浏览器预览无 cacheStats：隐藏空用量盒，避免盖住「存储与缓存」。
        cacheUsage.textContent = '';
      }
      cacheSummary.hidden = cacheUsage.textContent.trim() === '';
      // 折叠态标题下的同一行摘要（为空时保持 hidden）。
      setGroupSummary(storageSummary, cacheUsage.textContent ?? '');
    },
    retranslate,
    destroy(): void {
      prefsTarget.removeEventListener('lightink:syncable-storage-change', onReaderPrefsStorage);
      concealUi?.destroy();
      cacheLimitOverlay.remove();
      element.remove();
    },
  };

  retranslate();
  return view;
}
