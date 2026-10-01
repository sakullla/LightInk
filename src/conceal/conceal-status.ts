/**
 * 书架与阅读器共用的摸鱼说法。场景结果句由调用方传入；自定义效果按当前偏好拼出。
 */

import type { ConcealPrefs, ConcealSceneChoice } from './conceal-prefs.js';

export interface ConcealSceneResultLabels {
  readonly sceneNormalResult: string;
  readonly sceneHideOnLeaveResult: string;
  readonly sceneFloatingResult: string;
}

export interface ConcealEffectLabels {
  readonly effectWindowTransparent: string;
  readonly effectWindowOpaque: string;
  readonly effectOpacity: string;
  readonly effectHideNone: string;
  readonly effectHidePrefix: string;
  readonly regionSeparator: string;
  readonly regionTop: string;
  readonly regionBody: string;
  readonly regionBottom: string;
  readonly effectPinned: string;
  readonly effectNotPinned: string;
  readonly effectMini: string;
  readonly effectNotMini: string;
  readonly effectClickThrough: string;
  readonly effectNoClickThrough: string;
  readonly effectSeparator: string;
}

export function concealSceneResult(
  scene: ConcealSceneChoice,
  labels: ConcealSceneResultLabels,
): string {
  if (scene === 'normal') {
    return labels.sceneNormalResult;
  }
  if (scene === 'hideOnLeave') {
    return labels.sceneHideOnLeaveResult;
  }
  return labels.sceneFloatingResult;
}

/**
 * 偏离三个场景时的当前效果。顺序固定，便于两处对照。
 * 顶栏、正文和点击穿透只在透明模式开启时生效，说明跟实际窗口，不跟仍留着的开关。
 * 底栏不依赖透明模式。
 */
export function concealCustomEffect(prefs: ConcealPrefs, labels: ConcealEffectLabels): string {
  const regions: string[] = [];
  if (prefs.transparentMode && prefs.hideTop) {
    regions.push(labels.regionTop);
  }
  if (prefs.transparentMode && prefs.hideBody) {
    regions.push(labels.regionBody);
  }
  if (prefs.hideBottom) {
    regions.push(labels.regionBottom);
  }
  const hide =
    regions.length === 0
      ? labels.effectHideNone
      : `${labels.effectHidePrefix}${regions.join(labels.regionSeparator)}`;
  return [
    prefs.transparentMode ? labels.effectWindowTransparent : labels.effectWindowOpaque,
    labels.effectOpacity.replace('{value}', String(prefs.contentOpacity)),
    hide,
    prefs.alwaysOnTop ? labels.effectPinned : labels.effectNotPinned,
    prefs.miniWindow ? labels.effectMini : labels.effectNotMini,
    prefs.transparentMode && prefs.clickThrough
      ? labels.effectClickThrough
      : labels.effectNoClickThrough,
  ].join(labels.effectSeparator);
}
