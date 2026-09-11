/**
 * android-view-open — Android 文件关联打开桥（前端侧）。
 *
 * 覆盖：takePendingPath 的取出语义（路径 / 空槽 / 空串 / 桥缺失 / 抛错）、
 * installExternalOpenBridge 的通知处理器安装与冷启动 drain 返回值、
 * 运行期通知只消费一次、复制失败标记到达既有 reportOpenFailure。
 * Kotlin 侧以注入的普通对象模拟（契约见
 * src-tauri/gen/android/.../MainActivity.kt「外部打开桥」）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_OPEN_FAILURE_PREFIX,
  externalOpenFailureReportPath,
  installExternalOpenBridge,
  isExternalOpenFailureToken,
  takePendingExternalOpenPath,
  type ExternalOpenBridgeHost,
} from '../android-view-open.js';
import {
  handleExternalOpen,
  planColdStartSurface,
  type ExternalOpenDeps,
} from '../../ui/external-open.js';

function hostWithPending(paths: Array<string | null>): ExternalOpenBridgeHost {
  const queue = [...paths];
  return {
    LightInkExternalOpen: {
      takePendingPath: () => (queue.length > 0 ? (queue.shift() ?? null) : null),
    },
  };
}

describe('takePendingExternalOpenPath', () => {
  it('returns and consumes the pending path', () => {
    const host = hostWithPending(['/cache/view-cache/1/book.cbz']);
    expect(takePendingExternalOpenPath(host)).toBe('/cache/view-cache/1/book.cbz');
    expect(takePendingExternalOpenPath(host)).toBeNull();
  });

  it('normalizes empty string and missing bridge to null', () => {
    expect(takePendingExternalOpenPath(hostWithPending(['']))).toBeNull();
    expect(takePendingExternalOpenPath({})).toBeNull();
    expect(takePendingExternalOpenPath(null)).toBeNull();
  });

  it('swallows a throwing bridge', () => {
    const host: ExternalOpenBridgeHost = {
      LightInkExternalOpen: {
        takePendingPath: () => {
          throw new Error('binder gone');
        },
      },
    };
    expect(takePendingExternalOpenPath(host)).toBeNull();
  });
});

describe('installExternalOpenBridge', () => {
  it('returns the cold-start pending path and installs the runtime notify handler', () => {
    const host = hostWithPending(['/cache/view-cache/1/cold.cbz']);
    const onOpen = vi.fn();
    const pending = installExternalOpenBridge(onOpen, host);
    expect(pending).toBe('/cache/view-cache/1/cold.cbz');
    // 冷启动 drain 由调用方处理，install 本身不回调。
    expect(onOpen).not.toHaveBeenCalled();
    expect(typeof host.__lightinkExternalOpenNotify).toBe('function');
  });

  it('delivers runtime opens through the notify handler exactly once', () => {
    const host = hostWithPending([]);
    const onOpen = vi.fn();
    expect(installExternalOpenBridge(onOpen, host)).toBeNull();
    // Kotlin 落槽后 evaluateJavascript 通知 → 处理器拉取一次。
    (host.LightInkExternalOpen as { takePendingPath(): string | null }).takePendingPath = (() => {
      let taken = false;
      return () => {
        if (taken) {
          return null;
        }
        taken = true;
        return '/cache/view-cache/2/runtime.epub';
      };
    })();
    host.__lightinkExternalOpenNotify?.();
    host.__lightinkExternalOpenNotify?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('/cache/view-cache/2/runtime.epub');
  });

  it('is a no-op without a host (desktop / non-browser)', () => {
    const onOpen = vi.fn();
    expect(installExternalOpenBridge(onOpen, null)).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('tolerates a host without the Kotlin bridge (desktop window)', () => {
    const host: ExternalOpenBridgeHost = {};
    const onOpen = vi.fn();
    expect(installExternalOpenBridge(onOpen, host)).toBeNull();
    host.__lightinkExternalOpenNotify?.();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drains a Kotlin copy-failure token on cold start without treating it as a path', () => {
    const token = `${EXTERNAL_OPEN_FAILURE_PREFIX}Failed to copy external document`;
    const host = hostWithPending([token]);
    const onOpen = vi.fn();
    expect(installExternalOpenBridge(onOpen, host)).toBe(token);
    expect(onOpen).not.toHaveBeenCalled();
    expect(isExternalOpenFailureToken(token)).toBe(true);
  });

  it('delivers a runtime copy-failure token through notify exactly once', () => {
    const host = hostWithPending([]);
    const onOpen = vi.fn();
    expect(installExternalOpenBridge(onOpen, host)).toBeNull();
    const token = `${EXTERNAL_OPEN_FAILURE_PREFIX}Failed to open external document stream`;
    (host.LightInkExternalOpen as { takePendingPath(): string | null }).takePendingPath = (() => {
      let taken = false;
      return () => {
        if (taken) {
          return null;
        }
        taken = true;
        return token;
      };
    })();
    host.__lightinkExternalOpenNotify?.();
    host.__lightinkExternalOpenNotify?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(token);
  });
});

describe('external open failure tokens', () => {
  it('keeps the Kotlin prefix aligned and never looks like a reader or markdown path', () => {
    expect(EXTERNAL_OPEN_FAILURE_PREFIX).toBe('lightink-external-open-error:');
    expect(isExternalOpenFailureToken('/cache/view-cache/1/book.cbz')).toBe(false);
    expect(isExternalOpenFailureToken(`${EXTERNAL_OPEN_FAILURE_PREFIX}book.cbz`)).toBe(true);
    expect(externalOpenFailureReportPath(`${EXTERNAL_OPEN_FAILURE_PREFIX}book.cbz`)).toBe(
      'book_cbz',
    );
    expect(externalOpenFailureReportPath(EXTERNAL_OPEN_FAILURE_PREFIX)).toBe('external-open');
  });

  it('plans a copy-failure cold start as shelf so the token is not opened as Markdown', () => {
    const token = `${EXTERNAL_OPEN_FAILURE_PREFIX}Failed to copy`;
    const isReaderPath = (path: string): boolean => /\.(cbz|epub)$/i.test(path);
    expect(planColdStartSurface(token, { isReaderPath, immersive: true })).toBe('shelf');
    expect(planColdStartSurface(token, { isReaderPath, immersive: false })).toBe('shelf');
  });

  function failureDeps(): {
    deps: ExternalOpenDeps;
    openPath: ReturnType<typeof vi.fn>;
    reportOpen: ReturnType<typeof vi.fn>;
  } {
    const openPath = vi.fn(async () => null);
    const reportOpen = vi.fn();
    const deps: ExternalOpenDeps = {
      openPath,
      workspace: {
        openBook: vi.fn(),
        enterReader: vi.fn(),
        enterEditor: vi.fn(),
      },
      notify: vi.fn(),
      reportOpenFailure: reportOpen,
      restoreWindow: vi.fn(async () => true),
    };
    return { deps, openPath, reportOpen };
  }

  it('reports a cold-start copy failure through the existing error UI and does not open as Markdown', async () => {
    const { deps, openPath, reportOpen } = failureDeps();
    const token = `${EXTERNAL_OPEN_FAILURE_PREFIX}Failed to copy external document`;
    await expect(handleExternalOpen(token, 'cold-start', deps)).resolves.toBeNull();
    expect(openPath).not.toHaveBeenCalled();
    expect(deps.restoreWindow).not.toHaveBeenCalled();
    expect(reportOpen).toHaveBeenCalledWith('Failed to copy external document');
  });

  it('reports a running-instance copy failure after restore, without opening a tab', async () => {
    const { deps, openPath, reportOpen } = failureDeps();
    const token = `${EXTERNAL_OPEN_FAILURE_PREFIX}Unrecognized external file type`;
    await expect(handleExternalOpen(token, 'running', deps)).resolves.toBeNull();
    expect(deps.restoreWindow).toHaveBeenCalledOnce();
    expect(openPath).not.toHaveBeenCalled();
    expect(reportOpen).toHaveBeenCalledWith('Unrecognized external file type');
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
