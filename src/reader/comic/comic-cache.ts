/**
 * 漫画缓存窗口：refreshCacheWindow、预取中心计算与回收。
 * 预算选择沿用 comic-model.ts 的 selectComicCacheWindow/orderComicCacheLoads
 * 纯函数；默认 96MB 预算由本模块声明，可经 CbzRenderOptions.cacheBudgetBytes
 * 覆盖。行为逐字保留自拆分前 cbz.ts 的对应闭包。
 */

import {
  orderComicCacheLoads,
  selectComicCacheWindow,
} from '../comic-model.js';
import {
  comicTurnPrefetchCenters,
  comicVisiblePages,
} from '../comic-preferences.js';
import {
  comicLayoutSpreadPrefs,
  isAbortError,
  type ComicSession,
} from './comic-session.js';
import { loadPage, releasePage, showPageError } from './comic-pages.js';

export const DEFAULT_COMIC_CACHE_BUDGET = 96 * 1024 * 1024;

export function stripCacheCenters(center: number, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  return [Math.min(Math.max(0, Math.floor(center)), totalPages - 1)];
}

function cacheCenters(session: ComicSession, center: number): number[] {
  const prefs = comicLayoutSpreadPrefs(session);
  if (session.preferences.mode === 'paged') {
    return session.prefetchNeighbors
      ? comicTurnPrefetchCenters(center, session.images.length, prefs, session.landscapePages)
      : comicVisiblePages(center, session.images.length, prefs, session.landscapePages);
  }
  return stripCacheCenters(center, session.images.length);
}

export function refreshCacheWindow(session: ComicSession, center: number): void {
  const centers = cacheCenters(session, center);
  const wanted = session.prefetchNeighbors
    ? selectComicCacheWindow(session.estimatedBytes, centers, session.cacheBudget)
    : new Set(centers);
  // R2（ADR-3）：拖动态（含松手缓动在飞）目标 spread 保持 wanted——
  // 拖动期内任何缓存刷新（预取定时器启用、decode-hold 交错后的换屏等）
  // 不得 abort 拖动已触发的 urgent 加载；手势结束（提交/回弹/作废）后
  // 由正常窗口逻辑接管，不再并集。
  if (session.dragTurn !== null) {
    for (const index of session.dragTurn.revealed) wanted.add(index);
  }
  for (const index of session.materialized.keys()) {
    // paged 换屏挂起期（decode-gated swap）旧页仍在屏：跳过释放，等下次
    // 刷新（slot 已隐藏）再回收，避免持有期旧 slot 被掏空闪底色。
    if (wanted.has(index)) continue;
    if (session.preferences.mode === 'paged' && session.slots[index]?.hidden === false) continue;
    releasePage(session, index);
  }
  for (const [index, operation] of session.pending) {
    if (!wanted.has(index)) operation.controller.abort();
  }
  session.wantedPages = wanted;
  const firstUnresolved = session.images.findIndex((page) => page.kind === 'archive');
  const furthestCenter = centers.length === 0 ? -1 : Math.max(...centers);
  if (firstUnresolved >= 0 && firstUnresolved <= furthestCenter) {
    session.wantedPages.add(firstUnresolved);
    void loadPage(session, firstUnresolved).catch((error: unknown) => {
      if (!isAbortError(error, session.signal) && !session.destroyed) {
        showPageError(session, firstUnresolved);
      }
    });
  }
  for (const index of orderComicCacheLoads(wanted, centers)) {
    if (firstUnresolved >= 0 && index > firstUnresolved) continue;
    if (session.images[index]?.kind === 'archive') continue;
    void loadPage(session, index).catch((error: unknown) => {
      if (!isAbortError(error, session.signal) && !session.destroyed) {
        showPageError(session, index);
      }
    });
  }
}
