/**
 * `assistant-editor` — 编辑器（当前文档只读）助手 surface 适配（ADR-3 / R3）。
 *
 * - 会话身份：当前文档身份键（16-hex，与 Markdown 标注同源：已保存文件用
 *   `path:`，未命名用 `untitled:` 合成 id）。不同文档各自独立历史，重启后
 *   按同一文档键恢复。
 * - 上下文：注入当前活动 Markdown 全文（宿主读取；面板按上限截断并标注），
 *   标题进入上下文标签。文档变更只经宿主更新，本适配器不写文档。
 * - 只读：工具会话显式不含任何工具（`tools: []`）；执行器对任何调用只返回
 *   `read_only` 错误，不落任何内容。面板把 `session.tools`（空清单）放进每轮
 *   请求，模型看不到任何可调用工具，也不产生内容变更。
 * - 系统提示：注入编辑器专用提示（当前文档只读、无工具），不沿用阅读器文案。
 * - 文档身份变化时销毁面板：流式生成中的输出（若还有）随销毁中止，不会写进
 *   新文档的历史。下次打开按新键重建会话。
 *
 * 本模块不依赖 TabManager / 编辑器实例：文档、宿主、历史 IO 与 surface 几何
 * 全部经 `EditorAssistantDeps` 注入，可在 jsdom 下用替身测试。
 */

import type { AiTranslateConfig } from '../assistant/assistant-error.js';
import {
  createAssistantPanel,
  type AssistantPanel,
  type AssistantSurfaceDeps,
  type AssistantStreamDeps,
} from '../assistant/assistant-panel.js';
import type { AssistantToolSession } from '../assistant/assistant-tools.js';
import type { MessageKey } from '../i18n/messages.js';

/** 当前活动文档的只读投影；key 是 16-hex 文档身份（与标注身份同源）。 */
export interface EditorAssistantDocument {
  readonly key: string;
  readonly title: string;
  /** 文档全文（Markdown 源码）；面板按 `maxAssistantContextChars` 截断。 */
  readonly text: string;
}

export interface EditorAssistantDeps {
  readonly t: (key: MessageKey, vars?: Readonly<Record<string, string>>) => string;
  /** 宿主根（主题采纳与 portal 宿主；编辑器宿主 / 编辑区）。 */
  readonly host: () => HTMLElement;
  /** 未配置引导「前往配置」（宿主：打开 Manage 的 AI 分组）。 */
  readonly openSettings: () => void;
  /** 当前活动文档；无活动 Markdown 标签（reader 标签/无标签）返回 null。 */
  readonly getDocument: () => EditorAssistantDocument | null;
  /** 只读错误文案的 locale（缺省 zh-CN）。 */
  readonly getLocale?: () => 'en' | 'zh-CN';
  /** 只读提示通道（摘要保存请求不会落盘，仅提示；缺省静默）。 */
  readonly notify?: (message: string) => void;
  /** 配置读取（缺省走 `ai_get_config` 投影）。 */
  readonly fetchConfig?: () => Promise<AiTranslateConfig>;
  /** 按文档键读取历史（缺省不持久化，仅内存）。 */
  readonly readHistory?: (key: string) => Promise<string>;
  readonly writeHistory?: (key: string, json: string) => Promise<void>;
  readonly clearHistory?: (key: string) => Promise<void>;
  /** surface 挂载/钉位/触屏注入（缺省 body portal + 不钉位）。 */
  readonly surface?: AssistantSurfaceDeps;
  /** 流式通道注入（测试）。 */
  readonly stream?: AssistantStreamDeps;
  /** 助手 Markdown 外链（沿用应用外部打开策略）。 */
  readonly openExternalLink?: (href: string) => void;
}

export interface EditorAssistant {
  /** 无活动文档时空操作。 */
  open(): void;
  close(): void;
  toggle(): void;
  isVisible(): boolean;
  destroy(): void;
  /**
   * 文档身份变化钩子（标签切换 / 另存为后由宿主调用）：键变化即销毁面板，
   * 含流式生成中止，避免上一文档的输出写入新文档历史。
   */
  syncDocument(): void;
}

export function createEditorAssistant(deps: EditorAssistantDeps): EditorAssistant {
  let panel: AssistantPanel | null = null;
  /** 面板当前绑定（打开时）的文档键；null = 未打开或已随文档变化销毁。 */
  let openedKey: string | null = null;

  const documentOrNull = (): EditorAssistantDocument | null => {
    try {
      return deps.getDocument();
    } catch {
      return null;
    }
  };

  const readOnlyNotice = (): string =>
    (deps.getLocale?.() ?? 'zh-CN') === 'en'
      ? 'The editor assistant is read-only; the summary was not saved.'
      : '编辑器内助手只读，摘要未保存。';

  const readOnlySession = (): AssistantToolSession => ({
    // 不广告任何工具：编辑器内助手只读当前文档，没有可调用的写能力。
    tools: [],
    specifiedChapterCount: () => 0,
    async execute(name) {
      return {
        ok: false,
        tool: name,
        error: 'read_only',
        message:
          (deps.getLocale?.() ?? 'zh-CN') === 'en'
            ? 'The editor assistant is read-only and cannot change the document.'
            : '编辑器内助手只读，不会修改文档内容。',
      };
    },
  });

  const disposePanel = (): void => {
    panel?.destroy();
    panel = null;
  };

  const ensurePanel = (): AssistantPanel => {
    if (panel !== null) {
      return panel;
    }
    panel = createAssistantPanel({
      t: deps.t,
      host: deps.host,
      chapterContext: () => {
        const doc = documentOrNull();
        if (doc === null) {
          return null;
        }
        return { kind: 'flow', title: doc.title, text: doc.text };
      },
      openSettings: deps.openSettings,
      systemPrompt: () => deps.t('editor.assistant.systemPrompt'),
      // 只读：摘要不落标注、不写文档；有提示通道时告知用户未保存。
      saveAnnotation: (text) => {
        if (text.trim() === '') {
          return;
        }
        deps.notify?.(readOnlyNotice());
      },
      ...(deps.fetchConfig !== undefined ? { fetchConfig: deps.fetchConfig } : {}),
      ...(deps.readHistory !== undefined ? { readHistory: deps.readHistory } : {}),
      ...(deps.writeHistory !== undefined ? { writeHistory: deps.writeHistory } : {}),
      ...(deps.clearHistory !== undefined ? { clearHistory: deps.clearHistory } : {}),
      historyKey: () => documentOrNull()?.key ?? null,
      createToolSession: () => readOnlySession(),
      ...(deps.surface !== undefined ? { surface: deps.surface } : {}),
      ...(deps.stream !== undefined ? { stream: deps.stream } : {}),
      ...(deps.openExternalLink !== undefined
        ? { openExternalLink: deps.openExternalLink }
        : {}),
    });
    return panel;
  };

  const open = (): void => {
    const doc = documentOrNull();
    if (doc === null) {
      return;
    }
    openedKey = doc.key;
    ensurePanel().open();
  };

  return {
    open,
    close: () => {
      panel?.close();
    },
    toggle: () => {
      if (panel?.isVisible() === true) {
        panel.close();
        return;
      }
      open();
    },
    isVisible: () => panel?.isVisible() === true,
    destroy: () => {
      openedKey = null;
      disposePanel();
    },
    syncDocument: () => {
      const key = documentOrNull()?.key ?? null;
      if (key === openedKey) {
        return;
      }
      openedKey = null;
      disposePanel();
    },
  };
}
