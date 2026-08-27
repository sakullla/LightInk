/**
 * `session/adapters` — 会话核心的格式 adapter 契约（R1/R2）。
 *
 * 会话规则（世代取代、取消检查、stage→commit 时序、对称作废）唯一实现于
 * session-load 管线；两族 adapter 只负责本族的字节源获取、离屏 stage 与
 * commit/作废的具体执行（R2：flow 与 paged 是两个内容模型，不合并）：
 * - flow：TXT/FB2/EPUB/MOBI 经 parseReaderContent 得到章节化内容；
 * - paged：PDF 与漫画归档（cbz/cbr/cb7/rar/7z）渲染页宿主控制器。
 *
 * 对称作废合同（管线结构性保证，adapter 不必在各调用点自觉）：
 * - `commit()` 把 staged 内容换入 live 宿主并返回本会话的作废句柄；旧会话
 *   表面的摘除（页滚动监听、pending 合并帧、缩放 settle 等）由实现经与
 *   destroy 同一组摘除助手先行执行（对称作废先于换入）；
 * - `invalidate()` 释放本会话独占资源（渲染句柄、解析期资源）；管线保证
 *   被取代/销毁时各恰调用一次；
 * - `discard()` 丢弃未 commit 的 stage，含已接管的远程源所有权；
 * - 远程 range 源经 `RemoteSourceLease` 单次接管：stage 成功取得所有权即
 *   `release()`，否则管线在 finally 关闭——dispose 只发生一次。
 */

import { NATIVE_ARCHIVE_EXTENSIONS } from '../sources/native-archive.js';
import type { RandomAccessSource, ReaderTarget } from '../sources/types.js';

/** 会话两族：流式（章节窗）与页式（PDF/漫画页宿主）。 */
export type SessionAdapterKind = 'flow' | 'paged';

/** flow 族扩展：TXT/FB2/EPUB/MOBI（parseReaderContent 章节模型）。 */
export const FLOW_SESSION_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'fb2',
  'epub',
  'mobi',
]);

/** paged 族扩展：PDF 与漫画归档（pdf.ts / cbz.ts 页宿主控制器）。 */
export const PAGED_SESSION_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'cbz',
  ...NATIVE_ARCHIVE_EXTENSIONS,
]);

/** 按（小写）扩展名选择 adapter 族；未知扩展返回 null（加载前置校验报不支持）。 */
export function sessionAdapterKindForExtension(ext: string): SessionAdapterKind | null {
  if (FLOW_SESSION_EXTENSIONS.has(ext)) {
    return 'flow';
  }
  if (PAGED_SESSION_EXTENSIONS.has(ext)) {
    return 'paged';
  }
  return null;
}

/** 一次打开请求的静态事实（视图解析 target 后交给管线）。 */
export interface SessionOpenRequest {
  readonly kind: SessionAdapterKind;
  readonly target: ReaderTarget;
  /** 解析用路径（displayName 缺扩展名时补齐）。 */
  readonly formatPath: string;
  /** 小写扩展名。 */
  readonly ext: string;
  /** 原生漫画归档（cbr/cb7/rar/7z）：不开远程 range 源，stage 内开 provider。 */
  readonly nativeArchive: boolean;
}

/** 一次打开的运行上下文：合成信号 + 世代归属判定。 */
export interface SessionRunContext {
  /** 调用方信号 ⊕ 管线内部取代控制器；每个 yield 点后检查。 */
  readonly signal: AbortSignal;
  /** 本次打开仍是当前世代且未被取消/销毁。 */
  isCurrent(): boolean;
}

/** 管线代开远程 range 源的处置账本（dispose 单次接管）。 */
export interface RemoteSourceLease {
  /** 已打开的远程源；本请求不使用远程源时为 null。 */
  readonly source: RandomAccessSource | null;
  /** stage 取得源所有权后调用；此后关闭责任在 stage（随句柄/内容 dispose）。 */
  release(): void;
}

/** stage 阶段上下文。 */
export interface SessionStageContext extends SessionRunContext {
  /** 远程 range 源（仅 remote 且非原生归档时由管线代开）。 */
  readonly remote: RemoteSourceLease;
}

/** 已 commit 会话的作废句柄：释放本会话独占资源（渲染句柄/解析期资源）。 */
export interface SessionInvalidation {
  /** 幂等实现；管线保证被取代/销毁时恰调用一次。 */
  invalidate(): void | Promise<void>;
}

/** 离屏 staged 会话：commit 前对 live 宿主零影响。 */
export interface StagedSession {
  readonly kind: SessionAdapterKind;
  /**
   * 把 staged 内容换入 live 宿主（旧会话表面的摘除在此经与 destroy 同一组
   * 对称作废助手先行执行）；失败时自行回滚并抛出。返回本会话的作废句柄。
   */
  commit(): SessionInvalidation;
  /** 丢弃未 commit 的 stage（被取代/取消/失败）；已接管的远程源在此释放。 */
  discard(): void | Promise<void>;
}

/** 一族会话 adapter：本族字节源获取 + 离屏 stage（commit/discard 挂在 staged 上）。 */
export interface ReaderSessionAdapter {
  readonly kind: SessionAdapterKind;
  /**
   * 获取本族字节源并解析/渲染到离屏宿主。不得改动 live 宿主；内部每个
   * await 点后检查 `context.signal`（管线在 stage 返回后统一复查世代）。
   */
  stage(
    request: SessionOpenRequest,
    context: SessionStageContext,
  ): Promise<StagedSession>;
  /**
   * commit 后的异步收尾（PDF outline 拉取、漫画进度提前绑定、解析 warning
   * 提示）；内部 await 后经 `context` 复查世代，失配静默返回。
   */
  afterCommit?(
    staged: StagedSession,
    request: SessionOpenRequest,
    context: SessionRunContext,
  ): Promise<void> | void;
}
