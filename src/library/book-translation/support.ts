/**
 * 整本翻译入口显隐判定（R7 排除验证）：仅 flow 族格式（TXT/FB2/EPUB/可解析
 * MOBI）提供入口；PDF/CBZ 及漫画归档不出现。判定复用会话成员声明，不另立
 * 格式清单（能力只按声明放行）。
 */

import { sessionMemberForExtension } from '../../reader/session/adapters.js';

export function bookTranslationSupported(extension: string | undefined): boolean {
  if (extension === undefined || extension === '') {
    return false;
  }
  return sessionMemberForExtension(extension.toLowerCase()) === 'flow';
}

/** 供库详情进度区判定入口态（暂停/进行中显示续译或进度）。 */
export function bookTranslationPhaseIsRunning(
  status: import('./types.js').BookTranslationStatus | null,
): boolean {
  return (
    status !== null &&
    (status.phase === 'preparing' ||
      status.phase === 'translating' ||
      status.phase === 'building' ||
      status.phase === 'importing')
  );
}
