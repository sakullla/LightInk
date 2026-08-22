/**
 * `file-dialog` — 统一文件选择接口（桌面 plugin-dialog + Android SAF 桥）。
 *
 * plugin-dialog Android 可用性结论（02 D6 / R3，已核实）：
 *   安装版本 @tauri-apps/plugin-dialog 2.7.2 的 Android Kotlin 模块
 *   （tauri-plugin-dialog-2.7.2/android/.../DialogPlugin.kt）确实实现了
 *   `showFilePicker`（ACTION_GET_CONTENT）与 `saveFileDialog`
 *   （ACTION_CREATE_DOCUMENT），但回调解析的是 `Uri.toString()`——即
 *   `content://` URI 而非文件系统路径。`library_import_managed_book`
 *   契约要求 Rust 侧 `std::fs` 可读的真实路径，因此 plugin-dialog 主路径
 *   在 Android 上不可用于本地导入，按 D6 落地 SAF 桥。
 *
 * SAF 桥通道契约（与 `src-tauri/gen/android/.../MainActivity.kt` 对应，
 * 两侧注释互相引用）：
 *   - JS → Kotlin：MainActivity 在 onWebViewCreate 时经
 *     `addJavascriptInterface` 暴露 `window.LightInkSafBridge.openDocument(
 *     requestId, mimeTypesJson)`，启动 ACTION_OPEN_DOCUMENT（单飞：
 *     一次只允许一个进行中的选择）。
 *   - Kotlin → JS：Kotlin 将选中的 content:// 流复制到应用私有缓存目录
 *     （cacheDir/import-cache/），随后经 `WebView.evaluateJavascript` 调用
 *     `window.__lightinkSafResolve(requestId, result)`。
 *   - result 形状：`{ status: 'ok', path }`（真实缓存文件路径，交给
 *     library_import_managed_book，契约不变）| `{ status: 'cancelled' }`
 *     （用户取消 → null）| `{ status: 'error', message }`（reject 明确错误，
 *     绝不静默）。
 *
 * 两条路径对调用方暴露同一接口 `showOpenDialog()`，调用方不按平台分支。
 * 在无窗口的测试环境里该模块的桌面段会被 `vi.mock('@tauri-apps/plugin-dialog')`
 * 替换，SAF 段经注入 host 测试。
 */

import { open, save } from '@tauri-apps/plugin-dialog';
import { isAndroidApp } from '../ui/mobile-platform.js';

/** Markdown 过滤器（另存为用）。 */
const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown'] },
];

/** 「打开」对话框的单一支持格式条目（Markdown + 全部电子书格式）。 */
const SUPPORTED_FORMATS_FILTER = {
  name: 'All Supported Formats',
  extensions: [
    'md',
    'markdown',
    'pdf',
    'epub',
    'mobi',
    'fb2',
    'cbz',
    'cbr',
    'cb7',
    'rar',
    '7z',
    'txt',
  ],
};

const ALL_FILES_FILTER = { name: 'All Files', extensions: ['*'] };

/** 「打开」对话框过滤器：所有支持格式 + 所有文件（T1：单一条目）。 */
export const OPEN_FILTERS = [SUPPORTED_FORMATS_FILTER, ALL_FILES_FILTER];

/** 「另存为」对话框过滤器：仅 Markdown + 全部（reader 标签只读不另存）。 */
export const SAVE_FILTERS = [...MARKDOWN_FILTERS, ALL_FILES_FILTER];

/** Kotlin 回传结果形状（与 MainActivity.resolveSaf 的 JSONObject 对应）。 */
export interface SafPickResult {
  status: 'ok' | 'cancelled' | 'error';
  path?: string;
  message?: string;
}

/** MainActivity 经 addJavascriptInterface 暴露的 SAF 桥。 */
export interface SafBridgeInterface {
  openDocument(requestId: string, mimeTypesJson: string): void;
}

/** SAF 桥挂载宿主（window；测试注入普通对象）。 */
export interface SafBridgeHost {
  LightInkSafBridge?: SafBridgeInterface;
  __lightinkSafResolve?: (requestId: string, result: SafPickResult) => void;
}

/**
 * SAF 选择器的 MIME 白名单（与 OPEN_FILTERS 扩展名对应，含同一格式的
 * 常见别名 MIME，未识别的格式由 intent.type = "*\/*" 兜底展示）。
 */
export const SAF_OPEN_MIME_TYPES: readonly string[] = [
  'application/epub+zip',
  'application/pdf',
  'application/x-mobipocket-ebook',
  'application/x-fictionbook+xml',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'application/x-cbz',
  'application/x-cbr',
  'application/x-cb7',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/x-7z-compressed',
  'text/plain',
  'text/markdown',
];

let safRequestCounter = 0;

function defaultSafHost(): SafBridgeHost | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as unknown as SafBridgeHost;
}

/**
 * Android SAF 路径：经 MainActivity 的 LightInkSafBridge 启动
 * ACTION_OPEN_DOCUMENT，Kotlin 把 content:// 复制为应用私有缓存文件后回传
 * 真实路径。用户取消返回 null；桥缺失 / 复制失败 / 并发占用一律 reject
 * 明确错误（调用方负责把错误呈现给用户，绝不静默）。单飞：同时进行多个
 * 选择时后注册的 resolve 会覆盖前一个，Kotlin 侧也以并发占用错误拒绝。
 */
export async function openDocumentViaSaf(
  host: SafBridgeHost | null = defaultSafHost(),
): Promise<string | null> {
  const bridge = host?.LightInkSafBridge;
  if (host === null || bridge === undefined || typeof bridge.openDocument !== 'function') {
    throw new Error('Android file picker bridge is unavailable (SAF bridge not initialized)');
  }
  const requestId = `saf-open-${Date.now()}-${++safRequestCounter}`;
  return new Promise<string | null>((resolve, reject) => {
    host.__lightinkSafResolve = (id: string, result: SafPickResult) => {
      if (id !== requestId) {
        return;
      }
      if (result.status === 'ok' && typeof result.path === 'string' && result.path !== '') {
        resolve(result.path);
        return;
      }
      if (result.status === 'cancelled') {
        resolve(null);
        return;
      }
      reject(
        new Error(
          typeof result.message === 'string' && result.message !== ''
            ? result.message
            : 'Android file picker failed',
        ),
      );
    };
    try {
      bridge.openDocument(requestId, JSON.stringify(SAF_OPEN_MIME_TYPES));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * 统一「打开」选择接口：桌面走 plugin-dialog；Android 走 SAF 桥（见模块头
 * 可用性结论，plugin-dialog 在 Android 只返回 content:// URI，不满足
 * library_import_managed_book 的真实路径契约）。用户取消返回 null。
 */
export async function showOpenDialog(): Promise<string | null> {
  if (isAndroidApp) {
    return openDocumentViaSaf();
  }
  const selected = await open({
    multiple: false,
    directory: false,
    filters: OPEN_FILTERS,
  });
  // open() 在多选关闭时返回 string | null
  return typeof selected === 'string' ? selected : null;
}

/** 弹出「另存为」对话框；用户取消时返回 null。 */
export async function showSaveDialog(defaultPath?: string): Promise<string | null> {
  const selected = await save({
    defaultPath,
    filters: SAVE_FILTERS,
  });
  return typeof selected === 'string' ? selected : null;
}
