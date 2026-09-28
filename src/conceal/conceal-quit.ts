/**
 * `conceal-quit` — R4 退出编排（老板键 2 / 托盘菜单 / File→退出 共用）。
 *
 * 从 main.ts 抽出为可注入依赖的独立模块（main.ts 无测试是仓库现状，
 * 数据丢失风险最高的链路不能留在无测文件里）。流程（全程无保存/确认
 * 对话框）：
 *   1. commitSourceModes()：先落各编辑器源码模式等会话状态；
 *   2. 无脏标签 → shutdown() + conceal_exit_app；
 *   3. 有脏标签 → flushDirtySnapshotsStrict() 成功才 shutdown + 退出；
 *      失败 → 仅提示「退出没有发生 + 原因」，进程保留（保守取向：
 *      留不下副本就不退出）。
 *
 * 互斥：编排进行中忽略后续 requestQuit（老板键 2 连按安全）；失败路径
 * 解锁后可重试。exitApp 之后进程结束，Promise 可能永不 resolve。
 */

import type { ConcealQuitSource } from './conceal-client.js';

export interface ConcealQuitDeps {
  /** 把活动编辑器的源码/所见即所得模式等会话状态落盘（main.ts 既有函数）。 */
  commitSourceModes(): void;
  /** 当前是否存在脏 Markdown 标签。 */
  hasDirtyTabs(): boolean;
  /** R4 严格快照落盘：任一副本无法确认落盘 → false。 */
  flushStrict(): Promise<boolean>;
  /** 退出前释放 app 生命周期资源（定时器/监听器；main.ts 既有 shutdown）。 */
  shutdown(): void;
  /** conceal_exit_app 封装（摘托盘 + 进程结束）。 */
  exitApp(): Promise<void>;
  /** 非阻断提示（alert 对话框）。 */
  alert(message: string): void | Promise<void>;
  /** 「退出没有发生」文案（含原因插值）。 */
  exitAbortedMessage(reason?: string): string;
  /** 退出命令失败的提示文案。 */
  exitFailedMessage(reason?: string): string;
}

export interface ConcealQuitController {
  /** 发起退出编排；返回的 Promise 在「确定不退出（已提示）」时 resolve，
   * 退出成功时随进程结束（可能永不 resolve）。 */
  requestQuit(source: ConcealQuitSource | 'menu'): Promise<void>;
  /** 编排是否进行中（供测试与调试）。 */
  isQuitting(): boolean;
}

export function createConcealQuitController(deps: ConcealQuitDeps): ConcealQuitController {
  let inFlight: Promise<void> | null = null;

  const alertSafe = async (message: string): Promise<void> => {
    try {
      await deps.alert(message);
    } catch {
      // 提示本身失败不能让编排卡死。
    }
  };

  const runQuit = async (): Promise<void> => {
    deps.commitSourceModes();
    if (deps.hasDirtyTabs()) {
      let flushed = false;
      let flushError: unknown;
      try {
        flushed = await deps.flushStrict();
      } catch (error) {
        flushError = error;
      }
      if (!flushed) {
        const reason = flushError instanceof Error ? flushError.message : undefined;
        await alertSafe(deps.exitAbortedMessage(reason));
        return;
      }
    }
    deps.shutdown();
    try {
      await deps.exitApp();
    } catch (error) {
      // exitApp 失败：进程仍在，提示后可重试。
      const reason = error instanceof Error ? error.message : String(error ?? '');
      await alertSafe(deps.exitFailedMessage(reason));
    }
  };

  return {
    requestQuit(_source) {
      // 互斥：编排进行中（含退出命令在飞）直接忽略重复请求。
      if (inFlight !== null) {
        return inFlight;
      }
      const pending = runQuit().finally(() => {
        if (inFlight === pending) {
          inFlight = null;
        }
      });
      inFlight = pending;
      return pending;
    },
    isQuitting: () => inFlight !== null,
  };
}
