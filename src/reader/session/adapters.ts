/**
 * `session/adapters` — 会话核心的格式 adapter 契约与格式×能力声明（R1/R2）。
 *
 * 会话规则（世代取代、取消检查、stage→commit 时序、对称作废）唯一实现于
 * session-load 管线；两族 adapter 只负责本族的字节源获取、离屏 stage 与
 * commit/作废的具体执行（R2：flow 与 paged 是两个内容模型，不合并）：
 * - flow：TXT/FB2/EPUB/MOBI 经 parseReaderContent 得到章节化内容；
 * - paged：PDF 与漫画归档（cbz/cbr/cb7/rar/7z）渲染页宿主控制器。
 *
 * 格式×能力矩阵（搜索/标注/大纲/进度）在本文件固化为 adapter 声明数据
 * （SESSION_FORMAT_CAPABILITIES）：搜索 flowSearchable（漫画无文本）、标注
 * 身份（flow/pdf 经 content_hash 关联正文；漫画归档不哈希正文，本地标注
 * 与进度同源按目标身份关联页级书签/笔记）、paged afterCommit 的 PDF
 * outline/漫画页条目与漫画进度提前绑定——全部收敛为按会话成员的声明行；
 * 核心与会话模块只按声明分派，不再按格式名分支（能力修订只改本表声明，
 * 不出现隐式格式分支）。
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

/** 漫画归档扩展（paged 族漫画成员：cbz 与原生 cbr/cb7/rar/7z）。 */
export const COMIC_SESSION_EXTENSIONS: ReadonlySet<string> = new Set([
  'cbz',
  ...NATIVE_ARCHIVE_EXTENSIONS,
]);

/**
 * 会话成员：格式×能力矩阵的行键（flow 族整族一行；paged 族 PDF 与漫画
 * 归档分两行）。能力差异只在成员级声明，核心与视图不得再按格式名分支。
 */
export type SessionAdapterMember = 'flow' | 'pdf' | 'comic';

/** 按（小写）扩展名解析会话成员（能力矩阵行键）；未知扩展返回 null。 */
export function sessionMemberForExtension(ext: string): SessionAdapterMember | null {
  if (FLOW_SESSION_EXTENSIONS.has(ext)) {
    return 'flow';
  }
  if (ext === 'pdf') {
    return 'pdf';
  }
  if (COMIC_SESSION_EXTENSIONS.has(ext)) {
    return 'comic';
  }
  return null;
}

/**
 * 标注能力声明（R5：从 reader-view 现存分支与测试反推冻结）。
 */
export interface SessionAnnotationCapability {
  /**
   * 本地文档的标注身份：`'content-hash'`（经 content_hash 关联正文）、
   * `'progress-id'`（与进度同源的稳定目标身份：comicProgressIdForTarget——
   * 漫画归档不哈希正文，页级书签/笔记按路径/远程 itemId 关联）或 `null`
   * （本地不启用）。远程目标不受此字段约束：一律按阅读身份键哈希关联
   * （现行口径原样）。
   */
  readonly localIdentity: 'content-hash' | 'progress-id' | null;
  /** 标注表面：flow 章正文 mark / pdf 文本层 mark / 页角标（漫画页级书签，无文本层）/ 无。 */
  readonly marks: 'flow-body' | 'pdf-text-layer' | 'page-corner' | 'none';
}

/** 格式×能力矩阵单行：搜索/标注/大纲/进度四种能力，无此之外的声明（R5）。 */
export interface SessionFormatCapabilities {
  /** 文本搜索匹配器族；null = 无正文文本可搜（漫画归档，面板保持空态）。 */
  readonly textSearch: 'flow-chapters' | 'pdf-text-layer' | null;
  /** 标注能力（启用判定唯一实现在 ./session-annotation）。 */
  readonly annotations: SessionAnnotationCapability;
  /** 大纲条目落点：章节（flow）/ 页（pdf 与漫画归档）。 */
  readonly outline: 'chapters' | 'pages';
  /** 进度：快照族与身份绑定方式（漫画按目标提前绑定，不哈希归档）。 */
  readonly progress: {
    readonly snapshot: 'flow-window' | 'page';
    readonly identity: 'document-chain' | 'target-bound';
  };
}

/**
 * 格式×能力矩阵（adapter 声明数据；行 = 会话成员）。修订能力 = 改本表，
 * 核心与会话模块只按声明分派（不得回到按格式名分支）；新增成员 = 加一行。
 */
export const SESSION_FORMAT_CAPABILITIES: Readonly<
  Record<SessionAdapterMember, SessionFormatCapabilities>
> = {
  /** TXT/FB2/EPUB/MOBI：章文本可搜、content_hash 标注（章正文 mark）。 */
  flow: {
    textSearch: 'flow-chapters',
    annotations: { localIdentity: 'content-hash', marks: 'flow-body' },
    outline: 'chapters',
    progress: { snapshot: 'flow-window', identity: 'document-chain' },
  },
  /** PDF：文本层可搜、content_hash 标注（文本层 mark）、大纲按页。 */
  pdf: {
    textSearch: 'pdf-text-layer',
    annotations: { localIdentity: 'content-hash', marks: 'pdf-text-layer' },
    outline: 'pages',
    progress: { snapshot: 'page', identity: 'document-chain' },
  },
  /** 漫画归档（cbz/cbr/cb7/rar/7z）：无文本搜索；本地标注身份与进度同源
   *（不哈希归档），页级书签/笔记以页角标呈现（无文本层 mark）。 */
  comic: {
    textSearch: null,
    annotations: { localIdentity: 'progress-id', marks: 'page-corner' },
    outline: 'pages',
    progress: { snapshot: 'page', identity: 'target-bound' },
  },
};

/** 按扩展名取能力声明行；未知扩展返回 null（能力只按声明放行）。 */
export function sessionCapabilitiesForExtension(
  ext: string,
): SessionFormatCapabilities | null {
  const member = sessionMemberForExtension(ext);
  return member === null ? null : SESSION_FORMAT_CAPABILITIES[member];
}

/** 按（小写）扩展名选择 adapter 族；未知扩展返回 null（加载前置校验报不支持）。 */
export function sessionAdapterKindForExtension(ext: string): SessionAdapterKind | null {
  const member = sessionMemberForExtension(ext);
  return member === 'flow' ? 'flow' : member === null ? null : 'paged';
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
