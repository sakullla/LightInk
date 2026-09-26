/**
 * `assistant-shelf` — 首页（书库全局）助手 surface 适配（ADR-3 / R3 / R4）。
 *
 * 与阅读器适配（`reader-chrome-wiring`）并行的第三个 surface：
 * - 会话身份：固定命名空间键（16-hex，`fnv1a64Hex('assistant:shelf')`）。与按
 *   书（contentHash）、按文档（标注身份键）的会话互不串话，同一键使书库会话
 *   在重启后仍能恢复。
 * - 工具：注入库作用域 `library_*` 会话（执行器与工具定义同源；面板把
 *   `session.tools` 放进每轮请求 ①，模型据此看到 library_* schema；面板确认
 *   待确认建议后回调产生建议的同一 session）。工具读写全在
 *   `defaultLibraryToolDeps` 背后（生产走 `LibraryClient`），surface 只补阅读
 *   状态读取与写后刷新。
 * - 系统提示：注入书库专用提示（工具名与确认语义），不沿用阅读器文案。
 * - 上下文：首页没有「当前文档」，`chapterContext` 恒 null。书库数据只经工具
 *   读取，避免把易过期的整库快照塞进每轮 prompt。
 * - 「前往配置」由宿主注入：回合架并打开 Manage 的 AI 分组。
 *
 * 本模块不依赖书库视图实例：宿主、历史 IO、配置读取与 surface 几何全部经
 * `ShelfAssistantDeps` 注入，可在 jsdom 下用替身测试。
 */

import type { AiTranslateConfig } from '../assistant/assistant-error.js';
import {
  createAssistantPanel,
  type AssistantPanelAction,
  type AssistantSurfaceDeps,
  type AssistantStreamDeps,
} from '../assistant/assistant-panel.js';
import {
  loadAssistantPermissionMode,
  type AssistantPermissionStorage,
} from '../assistant/assistant-permission.js';
import {
  createLibraryToolSession,
  defaultLibraryToolDeps,
  type LibraryReadingStatus,
  type LibraryToolChange,
  type LibraryToolDeps,
} from '../assistant/library-tools.js';
import type { MessageKey } from '../i18n/messages.js';
import { fnv1a64Hex } from '../reader/document-hash.js';

/** 首页固定命名空间键：三处会话隔离；同一键使书库会话重启后恢复。 */
export const SHELF_ASSISTANT_HISTORY_KEY = fnv1a64Hex('assistant:shelf');

export interface ShelfAssistantDeps {
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 宿主根（主题采纳与 portal 宿主；书库根节点）。 */
  readonly host: () => HTMLElement;
  /** 未配置引导「前往配置」（宿主：回书架并打开 Manage 的 AI 分组）。 */
  readonly openSettings: () => void;
  /** 配置读取（缺省走 `ai_get_config` 投影）。 */
  readonly fetchConfig?: () => Promise<AiTranslateConfig>;
  /** 按固定书库键读取历史（缺省不持久化，仅内存）。 */
  readonly readHistory?: (key: string) => Promise<string>;
  readonly writeHistory?: (key: string, json: string) => Promise<void>;
  readonly clearHistory?: (key: string) => Promise<void>;
  /** 库作用域工具依赖覆盖（生产默认经 `LibraryClient`，测试注入替身）。 */
  readonly library?: Partial<LibraryToolDeps>;
  /** 阅读状态读取（首页有进度投影时注入）。 */
  readonly readingStatusOf?: (itemId: string) => LibraryReadingStatus | null;
  /** 写操作成功后的首页刷新（缺省不回调）。 */
  readonly onLibraryChanged?: (change: LibraryToolChange) => void;
  /** surface 挂载/钉位/触屏注入（缺省 body portal + 不钉位）。 */
  readonly surface?: AssistantSurfaceDeps;
  /** 流式通道注入（测试）。 */
  readonly stream?: AssistantStreamDeps;
  /** 助手 Markdown 外链（沿用应用外部打开策略）。 */
  readonly openExternalLink?: (href: string) => void;
  /** 权限模式存储。缺省 `localStorage`，键 `lightink.assistant.permissionMode`。 */
  readonly permissionStorage?: AssistantPermissionStorage | null;
}

export interface ShelfAssistant {
  open(): void;
  close(): void;
  toggle(): void;
  isVisible(): boolean;
  destroy(): void;
}

function shelfQuickActions(
  t: ShelfAssistantDeps['t'],
): readonly AssistantPanelAction[] {
  return [
    {
      id: 'organizeSuggestion',
      label: t('library.assistant.action.organize'),
      prompt: t('library.assistant.prompt.organize'),
      requiresContext: false,
      suggestion: true,
    },
    {
      id: 'tagSuggestion',
      label: t('library.assistant.action.tag'),
      prompt: t('library.assistant.prompt.tag'),
      requiresContext: false,
      suggestion: true,
    },
    {
      id: 'librarySearch',
      label: t('library.assistant.action.search'),
      prompt: t('library.assistant.prompt.search'),
      requiresContext: false,
    },
  ];
}

export function createShelfAssistant(deps: ShelfAssistantDeps): ShelfAssistant {
  const permissionStorage = (): AssistantPermissionStorage | null => {
    if (deps.permissionStorage !== undefined) {
      return deps.permissionStorage;
    }
    try {
      return globalThis.localStorage;
    } catch {
      return null;
    }
  };
  const panel = createAssistantPanel({
    t: deps.t,
    host: deps.host,
    // 首页没有当前文档：书库数据只经 library_* 工具读取。
    chapterContext: () => null,
    systemPrompt: () => deps.t('library.assistant.systemPrompt'),
    placeholder: deps.t('library.assistant.placeholder'),
    openSettings: deps.openSettings,
    // 首页没有当前书籍：摘要不落标注。书架不提供引用选区和章节动作。
    saveAnnotation: () => undefined,
    showQuote: false,
    showPermissionMode: true,
    permissionStorage: deps.permissionStorage,
    actions: shelfQuickActions(deps.t),
    actionsLabel: deps.t('library.assistant.actions'),
    ...(deps.fetchConfig !== undefined ? { fetchConfig: deps.fetchConfig } : {}),
    ...(deps.readHistory !== undefined ? { readHistory: deps.readHistory } : {}),
    ...(deps.writeHistory !== undefined ? { writeHistory: deps.writeHistory } : {}),
    ...(deps.clearHistory !== undefined ? { clearHistory: deps.clearHistory } : {}),
    historyKey: () => SHELF_ASSISTANT_HISTORY_KEY,
    createToolSession: (userMessage, turn) =>
      createLibraryToolSession(
        defaultLibraryToolDeps({
          ...deps.library,
          userMessage,
          permissionMode: loadAssistantPermissionMode(permissionStorage()),
          suggestionTurn: turn?.suggestion === true,
          ...(deps.readingStatusOf !== undefined
            ? { readingStatusOf: deps.readingStatusOf }
            : {}),
          ...(deps.onLibraryChanged !== undefined
            ? { onLibraryChanged: deps.onLibraryChanged }
            : {}),
        }),
      ),
    ...(deps.surface !== undefined ? { surface: deps.surface } : {}),
    ...(deps.stream !== undefined ? { stream: deps.stream } : {}),
    ...(deps.openExternalLink !== undefined
      ? { openExternalLink: deps.openExternalLink }
      : {}),
  });

  return {
    open: () => panel.open(),
    close: () => panel.close(),
    toggle: () => {
      if (panel.isVisible()) {
        panel.close();
        return;
      }
      panel.open();
    },
    isVisible: () => panel.isVisible(),
    destroy: () => panel.destroy(),
  };
}
