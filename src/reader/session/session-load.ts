/**
 * `session/session-load` — 唯一打开管线（世代取代/取消/对称作废单点化）。
 *
 * 管线独占的会话规则（视图与 adapter 不得再各自复制）：
 * - 世代计数：每次 open/destroy 递增，过期打开的续体一律判非当前；
 * - 信号合成：调用方 AbortSignal ⊕ 内部取代控制器；open 起点先 abort 上一个
 *   in-flight 打开，destroy 时 abort 活动控制器；
 * - acquire→stage→commit：字节源获取与解析/渲染全部在离屏 stage 完成，commit
 *   前统一复查取消；取消/被取代的 stage 经 `discard()` 丢弃，不画入 live 宿主、
 *   不作为读者可见失败（load-lifecycle 原语仍是取消判定的唯一权威）；
 * - 对称作废：commit 成功后恰一次作废上一会话（`SessionInvalidation`），destroy
 *   恰一次作废活动会话；共享表面（页滚动监听、pending 合并帧、缩放 settle）
 *   的摘除由 adapter 的 commit 经与 destroy 同一组助手结构性执行；
 * - 远程源单次接管：管线代开的远程 range 源经 lease 移交 stage，未移交时由
 *   管线 finally 关闭一次；
 * - phase：loading/cancelled/error 由管线发布（ready 属 settle 尾巴，由宿主
 *   在进度恢复就绪点发布）。
 */

import {
  isReaderLoadCancelled,
  throwIfReaderLoadCancelled,
} from '../load-lifecycle.js';
import { attachRemoteSource } from '../sources/remote-source.js';
import type {
  RandomAccessSource,
  RemoteReaderTarget,
} from '../sources/types.js';
import type {
  ReaderSessionAdapter,
  SessionAdapterKind,
  SessionInvalidation,
  SessionOpenRequest,
  SessionRunContext,
  SessionStageContext,
} from './adapters.js';

/** 视图侧钩子：管线驱动时序，DOM/状态实现全部留在视图层（T5 hooks 先例）。 */
export interface ReaderSessionLoadHost {
  /** open 起点（abort 上一打开之后）复位视图会话状态（搜索/进度暂存/大纲等）。 */
  beginOpen(request: SessionOpenRequest): void;
  /** 发布管线 phase；视图映射到 ReaderPhase（loading 带指标复位）。 */
  setPhase(phase: 'loading' | 'cancelled' | 'error'): void;
  /** commit 前的视图复位（loadedExt/标注暂存清空），两族同点执行。 */
  beforeCommit(request: SessionOpenRequest): void;
  /**
   * commit 后的收尾尾巴：标注装载、进度身份链与恢复、ready 发布与
   * onProgressBound；内部 await 后经 `context` 复查世代，失配静默返回。
   */
  settle(
    request: SessionOpenRequest,
    context: SessionRunContext,
  ): Promise<void> | void;
  /** 远程源打开依赖（测试注入替代 attachRemoteSource）。 */
  openRemoteSource?(
    target: RemoteReaderTarget,
    signal?: AbortSignal,
  ): Promise<RandomAccessSource>;
}

/** 打开管线句柄。 */
export interface ReaderSessionLoad {
  /** 当前世代（视图侧异步续体守卫用，如弹层期间比对）。 */
  generation(): number;
  /** 管线已销毁（视图 destroy 后不再接受 open）。 */
  isDestroyed(): boolean;
  /** 打开一个请求：取消/被取代静默返回，真实错误原样抛出。 */
  open(
    request: SessionOpenRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  /**
   * destroy 管线：世代 +1、abort in-flight、恰一次作废活动会话；返回作废
   * 收尾 promise，调用方决定何时 await（视图在 DOM 清理尾部统一收尾）。
   */
  destroy(): Promise<void>;
}

interface ActiveSession {
  readonly kind: SessionAdapterKind;
  readonly invalidation: SessionInvalidation;
}

export function createReaderSessionLoad(adapters: {
  readonly flow: ReaderSessionAdapter;
  readonly paged: ReaderSessionAdapter;
  readonly host: ReaderSessionLoadHost;
}): ReaderSessionLoad {
  const { flow, paged, host } = adapters;
  let generations = 0;
  let destroyed = false;
  let controller: AbortController | null = null;
  let activeSession: ActiveSession | null = null;

  /** 恰一次作废被取代的会话（销毁路径由 destroy 自行 await）。 */
  const retire = (session: ActiveSession | null): void => {
    if (session === null) {
      return;
    }
    void Promise.resolve(session.invalidation.invalidate()).catch(() => undefined);
  };

  const open = async (
    request: SessionOpenRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> => {
    controller?.abort();
    host.beginOpen(request);
    const loadController = new AbortController();
    controller = loadController;
    const generation = ++generations;
    const cancelFromCaller = (): void => loadController.abort();
    if (options.signal?.aborted === true) {
      loadController.abort();
    } else {
      options.signal?.addEventListener('abort', cancelFromCaller, { once: true });
    }
    const isCurrent = (): boolean =>
      !destroyed && !loadController.signal.aborted && generation === generations;
    let completed = false;
    let remoteSource: RandomAccessSource | null = null;
    let remoteReleased = false;
    host.setPhase('loading');
    try {
      if (request.target.kind === 'remote' && !request.nativeArchive) {
        const target = request.target;
        remoteSource =
          host.openRemoteSource !== undefined
            ? await host.openRemoteSource(target, loadController.signal)
            : (await attachRemoteSource(target, { signal: loadController.signal }))
                .source;
        throwIfReaderLoadCancelled(loadController.signal);
      }
      const context: SessionStageContext = {
        signal: loadController.signal,
        isCurrent,
        remote: {
          source: remoteSource,
          release: () => {
            remoteReleased = true;
          },
        },
      };
      const adapter = request.kind === 'flow' ? flow : paged;
      const staged = await adapter.stage(request, context);
      if (!isCurrent()) {
        // 乱序取代/取消：已 stage 未 commit 的结果一律丢弃，不画、不报错。
        await staged.discard();
        throwIfReaderLoadCancelled(loadController.signal);
        return;
      }
      host.beforeCommit(request);
      const invalidation = staged.commit();
      const previous = activeSession;
      activeSession = { kind: staged.kind, invalidation };
      retire(previous);
      await adapter.afterCommit?.(staged, request, context);
      if (!isCurrent()) {
        return;
      }
      await host.settle(request, { signal: loadController.signal, isCurrent });
      completed = isCurrent();
    } catch (error) {
      if (isReaderLoadCancelled(error, loadController.signal)) {
        // 取消/取代不构成读者可见失败：仅世代仍归本次打开时发布 cancelled。
        if (!destroyed && generation === generations) {
          host.setPhase('cancelled');
        }
        return;
      }
      if (!isCurrent()) {
        return;
      }
      host.setPhase('error');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancelFromCaller);
      if (!remoteReleased) {
        await remoteSource?.close().catch(() => undefined);
      }
      if (controller === loadController && !completed) {
        controller = null;
      }
    }
  };

  const destroy = (): Promise<void> => {
    destroyed = true;
    generations += 1;
    controller?.abort();
    controller = null;
    const session = activeSession;
    activeSession = null;
    if (session === null) {
      return Promise.resolve();
    }
    return Promise.resolve(session.invalidation.invalidate()).catch(() => undefined);
  };

  return {
    generation: () => generations,
    isDestroyed: () => destroyed,
    open,
    destroy,
  };
}
