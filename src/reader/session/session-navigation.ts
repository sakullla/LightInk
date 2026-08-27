/**
 * `session/session-navigation` — 导航会话策略表唯一实现（R1/R3）。
 *
 * `advanceReading` 的三支（pdf 页 / 漫画归档 / 流式）与大纲跳转收敛为按
 * adapter kind（flow/paged，见 ./adapters）的单一策略表：本模块持有分派与
 * 会话规则，视图按族/成员供数（页句柄、章节窗与滚动机械），行为自
 * reader-view 原样搬迁（数值与效果冻结）：
 *
 * - 翻页步进：
 *   - paged 族返回恒 true——边界钳制在页宿主内（pdf scrollToPage 钳到
 *     [1,total]、漫画 next/previousPage 在首末页为原地步进），窗口级
 *     滚轮/按键仍吞掉事件；首页上翻/末页下翻不越界；
 *   - paged 族成员效果不对称（原三支口径原样）：pdf 步进后播放翻页动画，
 *     漫画不播放（条/双页滚动由归档宿主自带动效）；
 *   - 漫画 rtl 阅读方向只反转左右方向键（navKey ∈ {ArrowLeft, ArrowRight}），
 *     上下/空格/滚轮保持物理方向；
 *   - flow 族返回实际移动位：分栏模式按列步进、滚动模式按视口步进，仅在
 *     移动时写进度、藏划选工具栏并播放翻页动画——首屏上翻/末屏下翻不
 *     越界、不动画、不写进度；
 * - 大纲跳转按本族落点派发（paged 按页、flow 按章节）：条目缺本族落点
 *   （如 paged 会话收到章节条目、条目无 page/chapter）或页宿主未就绪时
 *   no-op，不跳转不报错；flow 章节跳转前作废待恢复进度——迟到的帧 load
 *   不得把旧进度落回、覆盖本次跳转。
 *
 * reader-view 接线对照（原函数 → 本模块入口）：
 * advanceReading/advanceReadingContent 三支 → advance（策略表 paged/flow
 * 两行）；jumpToOutlineItem 的 page/chapter 分支 → jumpToOutlineItem。
 */

import type { OutlineItem } from '../../outline/outline-model.js';
import type { SessionAdapterKind } from './adapters.js';

/** paged 族成员：PDF 页控制器 / 漫画归档句柄（步进机械不同，落页同表）。 */
export type SessionPagedMember = 'pdf' | 'comic';

/** 一族导航策略：翻页步进与大纲跳转（会话规则由本模块持有，机械由宿主供数）。 */
export interface SessionNavigationStrategy {
  /**
   * 翻页步进。paged 族恒 true（边界钳制在页宿主内）；flow 族返回实际
   * 移动位（边界 false，窗口级调用方据此放行原生滚动）。
   */
  advance(direction: 1 | -1, navKey?: string): boolean;
  /** 大纲跳转。条目无本族落点时 no-op（不跳转、不报错）。 */
  jump(item: OutlineItem): void;
}

/** 视图侧钩子：核心持有策略表与分派，DOM/句柄机械留在视图层。 */
export interface SessionNavigationHost {
  /** 当前会话族（策略表行选择；null/未知 → advance false、jump no-op）。 */
  activeKind(): SessionAdapterKind | null;
  /** paged 族成员（pdf 页控制器 / 漫画归档句柄）；页宿主未就绪 null。 */
  pagedMember(): SessionPagedMember | null;
  /** 漫画阅读方向为 rtl（左右方向键反转规则的格式侧事实）。 */
  pagedComicReadsRightToLeft(): boolean;
  /** pdf 成员当前页（1-based；advance 目标页 = 当前页 ± 1）。 */
  pagedCurrentPage(): number;
  /** paged 按页落位（pdf/漫画 scrollToPage；钳制在句柄内，边界不越界）。 */
  pagedScrollToPage(page: number): void;
  /** 漫画成员步进机械（next/previousPage；双页/条模式的实际步距在句柄内）。 */
  pagedComicStep(delta: 1 | -1): void;
  /** paged 族步进/跳转后的页状态同步（syncPageState）。 */
  syncPagedState(): void;

  /** flow 族版式：分栏（按列步进）或滚动（按视口步进）。 */
  flowIsPaginated(): boolean;
  /** flow 分栏步进机械（跨章/边界判定在 flow-renderer；移动返回 true）。 */
  flowAdvancePaged(direction: 1 | -1): boolean;
  /** flow 滚动步进机械（视口步距滚动；边界返回 false）。 */
  flowAdvanceScrolled(direction: 1 | -1): boolean;
  /** flow 章节跳转机械：置活动章并按版式落位（分栏回首列 / 滚动滚入章首）。 */
  flowJumpToChapter(chapter: number): void;
  /** flow 族跳转后的章节状态同步（syncFlowState）。 */
  syncFlowState(): void;

  /** 作废待恢复进度（flow 章节跳转防迟来恢复覆盖落点）。 */
  discardPendingRestore(): void;
  /** 防抖写入进度（步进/跳转成功后）。 */
  persistProgress(): void;
  /** 播放翻页动画（pdf 步进、flow 移动后；漫画不播放）。 */
  playPageTurn(direction: 1 | -1): void;
  /** 隐藏划选工具栏（flow 步进移动后）。 */
  hideSelectionToolbar(): void;
}

/** 导航会话句柄：reader-view 以 host 供数并消费策略表裁决。 */
export interface ReaderSessionNavigation {
  /** 翻页步进（窗口级按键/滚轮与帧内转发的共同入口）。 */
  advance(direction: 1 | -1, navKey?: string): boolean;
  /** 大纲跳转（TOC 面板与 ReaderInstance 门面入口）。 */
  jumpToOutlineItem(item: OutlineItem): void;
}

/** 漫画 rtl：仅左右方向键反转（上下/空格/滚轮保持物理方向，原口径搬迁）。 */
function pagedComicDelta(
  direction: 1 | -1,
  navKey: string | undefined,
  readsRightToLeft: boolean,
): 1 | -1 {
  return readsRightToLeft && (navKey === 'ArrowLeft' || navKey === 'ArrowRight')
    ? (direction === 1 ? -1 : 1)
    : direction;
}

/** paged 族策略：pdf 页步进（+动画）/ 漫画步进（rtl 方向键反转）；大纲按页跳转。 */
function pagedNavigationStrategy(host: SessionNavigationHost): SessionNavigationStrategy {
  return {
    advance(direction, navKey) {
      if (host.pagedMember() === 'comic') {
        host.pagedComicStep(
          pagedComicDelta(direction, navKey, host.pagedComicReadsRightToLeft()),
        );
        host.syncPagedState();
        host.persistProgress();
        return true; // 边界钳制在归档句柄内（首末页原地步进）
      }
      host.pagedScrollToPage(host.pagedCurrentPage() + direction);
      host.syncPagedState();
      host.persistProgress();
      host.playPageTurn(direction);
      return true; // 边界钳制在 pdf 句柄内（scrollToPage 钳到 [1,total]）
    },
    jump(item) {
      if (item.page === undefined || host.pagedMember() === null) {
        return; // 章节条目/页宿主未就绪：无页落点，不跳转不报错
      }
      host.pagedScrollToPage(item.page);
      host.syncPagedState();
      host.persistProgress();
    },
  };
}

/** flow 族策略：分栏/滚动按版式步进（移动才动画与写进度）；大纲按章节跳转。 */
function flowNavigationStrategy(host: SessionNavigationHost): SessionNavigationStrategy {
  return {
    advance(direction) {
      const moved = host.flowIsPaginated()
        ? host.flowAdvancePaged(direction)
        : host.flowAdvanceScrolled(direction);
      if (!moved) {
        return false; // 首屏上翻/末屏下翻：不越界、不动画、不写进度
      }
      host.persistProgress();
      host.hideSelectionToolbar();
      host.playPageTurn(direction);
      return true;
    },
    jump(item) {
      if (item.chapter === undefined) {
        return; // 页式条目/无落点：不跳转不报错
      }
      // 迟到的帧 load 不得应用遗留进度、覆盖本次跳转（原口径原样搬迁）。
      host.discardPendingRestore();
      host.flowJumpToChapter(item.chapter);
      host.syncFlowState();
      host.persistProgress();
    },
  };
}

/**
 * 按 adapter kind 的单一策略表：翻页步进与大纲跳转的全部会话规则在此
 * 分派，新增族 = 表加一行（视图侧不得再按格式名分支）。
 */
const NAVIGATION_STRATEGY_TABLE: Readonly<
  Record<SessionAdapterKind, (host: SessionNavigationHost) => SessionNavigationStrategy>
> = {
  paged: pagedNavigationStrategy,
  flow: flowNavigationStrategy,
};

export function createReaderSessionNavigation(
  host: SessionNavigationHost,
): ReaderSessionNavigation {
  // 策略自表实例化：表是唯一分派定义（新增族 = 表加一行 + 此处一行接线）。
  const strategies: Record<SessionAdapterKind, SessionNavigationStrategy> = {
    paged: NAVIGATION_STRATEGY_TABLE.paged(host),
    flow: NAVIGATION_STRATEGY_TABLE.flow(host),
  };
  const activeStrategy = (): SessionNavigationStrategy | null => {
    const kind = host.activeKind();
    return kind === null ? null : (strategies[kind] ?? null);
  };
  return {
    advance: (direction, navKey) => activeStrategy()?.advance(direction, navKey) ?? false,
    jumpToOutlineItem: (item) => {
      activeStrategy()?.jump(item);
    },
  };
}
