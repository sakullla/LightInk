import { describe, expect, it } from 'vitest';
import { defaultConcealPrefs } from '../conceal-prefs.js';
import {
  concealCustomEffect,
  concealSceneResult,
  type ConcealEffectLabels,
  type ConcealSceneResultLabels,
} from '../conceal-status.js';

const scenes: ConcealSceneResultLabels = {
  sceneNormalResult: '普通阅读结果',
  sceneHideOnLeaveResult: '离开即隐结果',
  sceneFloatingResult: '悬浮看文结果',
};

const effects: ConcealEffectLabels = {
  effectWindowTransparent: '窗口透明',
  effectWindowOpaque: '窗口不透明',
  effectOpacity: '正文不透明度为 {value}',
  effectHideNone: '鼠标离开时不隐藏顶栏、正文或底栏',
  effectHidePrefix: '鼠标离开时隐藏',
  regionSeparator: '、',
  regionTop: '顶栏',
  regionBody: '正文',
  regionBottom: '底栏',
  effectPinned: '置顶',
  effectNotPinned: '不置顶',
  effectMini: '迷你窗口',
  effectNotMini: '不是迷你窗口',
  effectClickThrough: '点击穿透，看得见的轻墨控件仍可操作',
  effectNoClickThrough: '点击不穿透',
  effectSeparator: '；',
};

describe('concealSceneResult', () => {
  it('returns the shared sentence for each selectable scene', () => {
    expect(concealSceneResult('normal', scenes)).toBe('普通阅读结果');
    expect(concealSceneResult('hideOnLeave', scenes)).toBe('离开即隐结果');
    expect(concealSceneResult('floating', scenes)).toBe('悬浮看文结果');
  });
});

describe('concealCustomEffect', () => {
  it('lists the current window facts in a stable order', () => {
    const prefs = {
      ...defaultConcealPrefs(false),
      transparentMode: true,
      contentOpacity: 80,
      hideTop: true,
      hideBottom: true,
      alwaysOnTop: true,
      miniWindow: false,
      clickThrough: true,
    };
    expect(concealCustomEffect(prefs, effects)).toBe(
      '窗口透明；正文不透明度为 80；鼠标离开时隐藏顶栏、底栏；置顶；不是迷你窗口；点击穿透，看得见的轻墨控件仍可操作',
    );
  });

  it('uses the off wording when nothing is concealed', () => {
    expect(concealCustomEffect(defaultConcealPrefs(false), effects)).toBe(
      '窗口不透明；正文不透明度为 100；鼠标离开时不隐藏顶栏、正文或底栏；不置顶；不是迷你窗口；点击不穿透',
    );
  });
});
