/**
 * android-view-open — Android 文件关联打开桥（前端侧）。
 *
 * 覆盖：takePendingPath 的取出语义（路径 / 空槽 / 空串 / 桥缺失 / 抛错）、
 * installExternalOpenBridge 的通知处理器安装与冷启动 drain 返回值、
 * 运行期通知只消费一次。Kotlin 侧以注入的普通对象模拟（契约见
 * src-tauri/gen/android/.../MainActivity.kt「外部打开桥」）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  installExternalOpenBridge,
  takePendingExternalOpenPath,
  type ExternalOpenBridgeHost,
} from '../android-view-open.js';

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
});
