// @vitest-environment jsdom
/**
 * file-dialog 统一选择接口测试（02 D6 / R3）：
 * - 平台分流：桌面走 plugin-dialog，Android 走 SAF 桥（互不越界）；
 * - SAF 回落形状：ok/cancelled/error 三种结果与真实路径回传；
 * - 错误呈现：桥缺失、同步抛错、error 状态一律 reject 明确错误（绝不静默）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import {
  OPEN_FILTERS,
  SAF_OPEN_MIME_TYPES,
  openDocumentViaSaf,
  showOpenDialog,
  type SafBridgeHost,
} from '../file-dialog.js';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('../../ui/mobile-platform.js', () => ({
  get isAndroidApp() {
    return platform.android;
  },
}));

const openMock = vi.mocked(open);

function installSafBridge(
  host: SafBridgeHost,
  handler: (requestId: string, mimeTypesJson: string) => void,
): ReturnType<typeof vi.fn> {
  const bridge = vi.fn(handler);
  host.LightInkSafBridge = { openDocument: bridge };
  return bridge;
}

beforeEach(() => {
  openMock.mockReset();
  platform.android = false;
});

afterEach(() => {
  const host = window as unknown as Record<string, unknown>;
  delete host.LightInkSafBridge;
  delete host.__lightinkSafResolve;
});

describe('showOpenDialog 平台分流', () => {
  it('桌面路径走 plugin-dialog open 并透传选中路径', async () => {
    openMock.mockResolvedValue('/books/三体.epub');
    await expect(showOpenDialog()).resolves.toBe('/books/三体.epub');
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: OPEN_FILTERS,
    });
  });

  it('桌面用户取消返回 null', async () => {
    openMock.mockResolvedValue(null);
    await expect(showOpenDialog()).resolves.toBeNull();
  });

  it('Android 路径走 SAF 桥且不调用 plugin-dialog', async () => {
    platform.android = true;
    const host = window as unknown as SafBridgeHost;
    const bridge = installSafBridge(host, (requestId, mimeTypesJson) => {
      expect(JSON.parse(mimeTypesJson)).toEqual([...SAF_OPEN_MIME_TYPES]);
      host.__lightinkSafResolve?.(requestId, {
        status: 'ok',
        path: '/data/cache/import-cache/saf-open-1/book.epub',
      });
    });
    await expect(showOpenDialog()).resolves.toBe(
      '/data/cache/import-cache/saf-open-1/book.epub',
    );
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(openMock).not.toHaveBeenCalled();
  });

  it('Android 桥缺失时 reject 明确错误（不静默、不回落 plugin-dialog）', async () => {
    platform.android = true;
    await expect(showOpenDialog()).rejects.toThrow(/SAF bridge not initialized/);
    expect(openMock).not.toHaveBeenCalled();
  });
});

describe('openDocumentViaSaf SAF 回落形状', () => {
  it('ok 状态回传真实缓存路径', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, { status: 'ok', path: '/cache/x.cbz' });
    });
    await expect(openDocumentViaSaf(host)).resolves.toBe('/cache/x.cbz');
  });

  it('cancelled 状态解析为 null（用户取消）', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, { status: 'cancelled' });
    });
    await expect(openDocumentViaSaf(host)).resolves.toBeNull();
  });

  it('error 状态以 message reject（复制失败等明确错误）', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, {
        status: 'error',
        message: 'Failed to open selected document stream',
      });
    });
    await expect(openDocumentViaSaf(host)).rejects.toThrow(
      'Failed to open selected document stream',
    );
  });

  it('error 状态缺 message 时 reject 默认错误信息', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, { status: 'error' });
    });
    await expect(openDocumentViaSaf(host)).rejects.toThrow('Android file picker failed');
  });

  it('ok 状态缺 path 时按失败 reject', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, { status: 'ok' });
    });
    await expect(openDocumentViaSaf(host)).rejects.toThrow('Android file picker failed');
  });

  it('桥缺失时 reject 明确错误', async () => {
    await expect(openDocumentViaSaf({})).rejects.toThrow(/SAF bridge not initialized/);
    await expect(openDocumentViaSaf(null)).rejects.toThrow(/SAF bridge not initialized/);
  });

  it('openDocument 同步抛错时 reject 该错误', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, () => {
      throw new Error('Activity destroyed');
    });
    await expect(openDocumentViaSaf(host)).rejects.toThrow('Activity destroyed');
  });

  it('忽略不匹配的 requestId 回传', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(`${requestId}-stale`, { status: 'cancelled' });
      host.__lightinkSafResolve?.(requestId, { status: 'ok', path: '/cache/a.pdf' });
    });
    await expect(openDocumentViaSaf(host)).resolves.toBe('/cache/a.pdf');
  });
});

describe('openDocumentViaSaf 并发结算（requestId→resolver 映射）', () => {
  it('并发请求按 requestId 各自 settle，逆序回传不互相覆盖', async () => {
    const host: SafBridgeHost = {};
    const requestIds: string[] = [];
    installSafBridge(host, (requestId) => {
      requestIds.push(requestId);
    });
    const first = openDocumentViaSaf(host);
    const second = openDocumentViaSaf(host);
    expect(requestIds).toHaveLength(2);
    // 后发起的先完成：验证按 requestId 分发而非单一全局槽被覆盖。
    host.__lightinkSafResolve?.(requestIds[1], { status: 'ok', path: '/cache/b.pdf' });
    host.__lightinkSafResolve?.(requestIds[0], { status: 'ok', path: '/cache/a.pdf' });
    await expect(first).resolves.toBe('/cache/a.pdf');
    await expect(second).resolves.toBe('/cache/b.pdf');
  });

  it('Kotlin 单飞拒绝只结算被回绝的请求，先发起的请求不受影响', async () => {
    const host: SafBridgeHost = {};
    const requestIds: string[] = [];
    installSafBridge(host, (requestId) => {
      requestIds.push(requestId);
    });
    const first = openDocumentViaSaf(host);
    const second = openDocumentViaSaf(host);
    host.__lightinkSafResolve?.(requestIds[1], {
      status: 'error',
      message: 'Another file pick is already in progress',
    });
    host.__lightinkSafResolve?.(requestIds[0], { status: 'ok', path: '/cache/a.pdf' });
    await expect(second).rejects.toThrow('Another file pick is already in progress');
    await expect(first).resolves.toBe('/cache/a.pdf');
  });

  it('已 settle 的请求再次回传被忽略（resolver 已从映射删除）', async () => {
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, { status: 'ok', path: '/cache/a.pdf' });
      host.__lightinkSafResolve?.(requestId, {
        status: 'error',
        message: 'late duplicate must be ignored',
      });
    });
    await expect(openDocumentViaSaf(host)).resolves.toBe('/cache/a.pdf');
  });

  it('openDocument 同步抛错时清理映射条目', async () => {
    const host: SafBridgeHost = {};
    const requestIds: string[] = [];
    installSafBridge(host, (requestId) => {
      requestIds.push(requestId);
      throw new Error('Activity destroyed');
    });
    await expect(openDocumentViaSaf(host)).rejects.toThrow('Activity destroyed');
    // 抛错后的 requestId 回传不得触发任何 resolver（条目已清理，不悬挂不泄漏）。
    expect(() =>
      host.__lightinkSafResolve?.(requestIds[0], { status: 'ok', path: '/cache/a.pdf' }),
    ).not.toThrow();
  });
});

describe('SAF 缓存路径契约（Kotlin 侧 copyToImportCache 的 JS 可观测面）', () => {
  it('Unicode 文件名（CJK + 空格）的每请求子目录路径原样透传', async () => {
    // Kotlin 修复后路径形状为 import-cache/<requestId>/<干净显示名>，
    // 显示名保留 Unicode 字母（书架标题直接取自它）；JS 侧必须不改动地透传。
    const host: SafBridgeHost = {};
    installSafBridge(host, (requestId) => {
      host.__lightinkSafResolve?.(requestId, {
        status: 'ok',
        path: `/data/cache/import-cache/${requestId}/三体 全集.mobi`,
      });
    });
    const path = await openDocumentViaSaf(host);
    expect(path).toMatch(/^\/data\/cache\/import-cache\/saf-open-[^/]+\/三体 全集\.mobi$/);
  });
});
