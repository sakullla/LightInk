/**
 * `conceal-controller` — 书架与阅读器摸鱼的纯前端状态机（headless 可测）。
 *
 * 输入：surface（工作区表面切换）+ prefs（设置改动）+ pointerZone 流
 * （DOM pointermove 或后端 conceal-pointer-zone 事件，同一入口）+ zones
 * 过期通知（resize / ScaleFactorChanged / conceal-zones-stale / mini 开关 /
 * 表面切换）。
 *
 * 输出（本模块是唯一写者）：
 *   - html 的 data-conceal-surface / data-conceal-transparent 与
 *     --lightink-conceal-page-background / --lightink-conceal-content-opacity；
 *   - #app 的 data-conceal-top/body/bottom（CSS 以 visibility 隐藏，几何不动）；
 *   - 阅读器 bar/footer/whisper 经 ReaderChrome.setConcealZones 接管
 *     （单写者仍在 reader-chrome 的 syncDom；本控制器不直接写那些元素）；
 *   - 窗口效果命令序列（置顶/透明/mini/穿透含 zones 与 visible）；
 *   - 失败回调（开关内存回退 + 原因；文案 i18n 在 main.ts 映射）。
 *
 * R1：surface→editor 调 conceal_restore_window_baseline（后端幂等撤销全部
 * 窗口效果，含恢复进迷你窗口前的位置大小）并清全部 data 属性；回
 * shelf/reader 按仍保存的开关逐项重放，不触碰 tabs/reader（书与位置天然
 * 保留）。
 *
 * R13 关键不变量：透明模式关闭（或穿透开关关闭）时绝不保持
 * conceal_set_click_through(enabled=true)——点击必须落回 LightInk。
 *
 * zones 坐标基准：getBoundingClientRect 的**视口（客户区）原点**逻辑像素；
 * 后端以 cursor−窗口客户区原点换算比对（decorations:false 下 Windows
 * 不可见 resize 边框造成的 outer/inner 偏移由后端统一用 inner 原点消除）。
 */

import type {
  ConcealBossKeysStatus,
  ConcealClient,
  ConcealPointerZoneName,
  ConcealUiZone,
  ConcealZone,
} from './conceal-client.js';
import {
  concealBackgroundToCss,
  isConcealPrefsValid,
  isSameHotkeyCombo,
  isValidHotkeyCombo,
  type ConcealPrefs,
} from './conceal-prefs.js';

export type ConcealSurface = 'editor' | 'shelf' | 'reader';
export type ReaderConcealZoneMode = 'auto' | 'held' | 'hidden';

/**
 * 页面背景改写事件（R5/R6）：--lightink-conceal-page-background 的生效值
 * 变化时派发到 doc，阅读器视图据此重涂章节 iframe（宿主 CSS 变了，iframe
 * 内联纸色必须跟着重算，否则内联纸色挡住渐变/透明）。
 */
export const CONCEAL_PAGE_BACKGROUND_EVENT = 'lightink:conceal-page-background';

/** 穿透激活期间的可见控件带复测间隔：overlay 开合/滚动/布局变化都会改变
 * 交互矩形，周期复测让白名单式测量漏掉的 portal 层在下一拍自动进入
 * 交互带；dedup key 未变则零 IPC。 */
const CONCEAL_ZONE_POLL_INTERVAL_MS = 500;

export type ConcealNoticeKind =
  | 'alwaysOnTopFailed'
  | 'miniWindowFailed'
  | 'transparentFailed'
  | 'clickThroughFailed'
  | 'baselineFailed';

/** R2 客户端预校验的失败原因（与后端 conceal_register_boss_keys 文案一致）。 */
export const BOSS_KEY_EMPTY_ERROR = '组合不能为空';
export const BOSS_KEY_INVALID_ERROR = '无效组合或仅修饰键';
export const BOSS_KEY_SAME_ERROR = '与老板键 1 相同';

export interface ConcealReaderChromeLike {
  setConcealZones(top: ReaderConcealZoneMode, bottom: ReaderConcealZoneMode): void;
}

export interface ConcealControllerDeps {
  readonly client: ConcealClient;
  /** 已加载的初始偏好（loadConcealPrefs 产物）。 */
  readonly prefs: ConcealPrefs;
  /** 持久化（saveConcealPrefs 绑定；校验失败时返回旧值）。 */
  readonly persist: (next: ConcealPrefs, previous: ConcealPrefs) => ConcealPrefs;
  readonly doc: Document;
  /** 活动阅读标签的 chrome；reader 表面 R7 经它接管。 */
  readonly getActiveReaderChrome: () => ConcealReaderChromeLike | null;
  /** 顶带实测（可见时 getBoundingClientRect 视口坐标；display:none 时 null）。 */
  readonly measureTopZone: () => ConcealZone | null;
  /** 底带实测；书架无底栏恒 null。 */
  readonly measureBottomZone: () => ConcealZone | null;
  /**
   * R13 交互控件带实测（视口坐标矩形）：书架设置入口/设置页与阅读器打开的
   * chrome 面板等「可见按钮」不在顶/底带内，不测量则穿透态点击落到后面的
   * 窗口，用户无法用鼠标关掉穿透/透明开关（陷阱态）。
   */
  readonly measureUiZone?: () => ConcealUiZone | null;
  /** 视口高度（逻辑 px，底带兜底定位用）。 */
  readonly getViewportHeight: () => number;
  /** 从未实测过时的兜底带高度。 */
  readonly fallbackTopHeight: number;
  readonly fallbackBottomHeight: number;
  /** 命令失败提示（kind + 后端原因文本；i18n 在 main.ts）。 */
  readonly onNotice: (kind: ConcealNoticeKind, reason?: string) => void;
}

const errorText = (error: unknown): string | undefined =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;

export interface ConcealController {
  /** 应用初始表面（bootstrap 后调用一次）。 */
  init(): void;
  /** R1：表面切换。editor 全撤；shelf/reader 按保存的开关重放。 */
  setSurface(surface: ConcealSurface): void;
  /** 设置改动：合并 → 校验持久化 → 即时生效（R10）。返回生效后的偏好。 */
  applyPrefs(update: Partial<ConcealPrefs>): ConcealPrefs;
  /** 当前生效偏好（命令失败的开关已内存回退）。 */
  getEffectivePrefs(): ConcealPrefs;
  /** R2：改键注册。客户端预校验失败不发起 invoke；成功才持久化。 */
  updateBossKeys(primary: string, secondary: string): Promise<ConcealBossKeysStatus>;
  /** R7 DOM 指针输入（clientY 为视口 y；null = 指针离开窗口）。 */
  handlePointerMove(clientY: number | null): void;
  /** R7 后端 conceal-pointer-zone 输入（与 DOM 同一状态机入口）。 */
  handlePointerZone(zone: ConcealPointerZoneName): void;
  /** zones 过期通知：重测缓存并重推穿透 zones（resize/DPI/mini/后端几何变化）。 */
  notifyZonesStale(): void;
  /** 等待在飞命令完成（测试用）。 */
  settled(): Promise<void>;
  dispose(): void;
}

export function createConcealController(deps: ConcealControllerDeps): ConcealController {
  const { client, doc } = deps;
  let effective: ConcealPrefs = { ...deps.prefs };
  let surface: ConcealSurface | null = null;
  let pointerZone: ConcealPointerZoneName | null = null;
  const zoneCache = new Map<'top' | 'bottom', ConcealZone>();
  let pushedClickThroughKey = '';

  // 已成功下发的窗口效果（避免表面往返重复发命令；editor 进入即重置）。
  let appliedAlwaysOnTop = false;
  let appliedTransparent = false;
  let appliedMiniWindow = false;
  let appliedClickThrough = false;
  let clickThroughRevoked = true;
  // 上次生效的页面背景改写值（null=未改写）：变化时派发重涂事件。
  let lastPageBackground: string | null = null;

  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    void promise.then(
      () => {
        inFlight.delete(promise);
      },
      () => {
        inFlight.delete(promise);
      },
    );
    return promise;
  };

  const html = (): HTMLElement => doc.documentElement;
  const app = (): HTMLElement | null => doc.getElementById('app');

  const setAttr = (target: HTMLElement, name: string, value: string | null): void => {
    if (value === null) {
      if (target.getAttribute(name) !== null) {
        target.removeAttribute(name);
      }
      return;
    }
    if (target.getAttribute(name) !== value) {
      target.setAttribute(name, value);
    }
  };

  // ── R7 显隐矩阵 ──────────────────────────────────────────────
  // 顶/主体依赖透明模式；底栏独立；开关关或透明关 → 立即显示（R7 原文）。
  const topHidden = (): boolean =>
    effective.hideTop && effective.transparentMode && pointerZone !== 'top';
  const bodyHidden = (): boolean =>
    effective.hideBody && effective.transparentMode && pointerZone !== 'body';
  // R7：当前界面没有底部工具区（书架）时底栏开关 no-op，不隐藏其他内容。
  const bottomHidden = (): boolean =>
    surface === 'reader' && effective.hideBottom && pointerZone !== 'bottom';

  // ── zones 几何（测量 + 缓存 + 兜底） ─────────────────────────
  const currentTopZone = (): ConcealZone => zoneCache.get('top') ?? { y: 0, height: deps.fallbackTopHeight };
  const currentBottomZone = (): ConcealZone => {
    const cached = zoneCache.get('bottom');
    if (cached !== undefined) {
      return cached;
    }
    const height = deps.fallbackBottomHeight;
    const viewport = Math.max(height, deps.getViewportHeight());
    return { y: viewport - height, height };
  };

  const refreshZoneCache = (): void => {
    const top = deps.measureTopZone();
    if (top !== null && top.height > 0) {
      zoneCache.set('top', top);
    }
    const bottom = deps.measureBottomZone();
    if (bottom !== null && bottom.height > 0) {
      zoneCache.set('bottom', bottom);
    }
  };

  const clickThroughActive = (): boolean =>
    surface !== null && surface !== 'editor' && effective.clickThrough && effective.transparentMode;

  // ── 穿透激活期间的低频 zones 复测 ────────────────────────────
  // zones-stale 事件只覆盖 resize/DPI/mini/表面切换；overlay 开合（助手
  // 面板、对话框、右键菜单）没有任何后端事件，ui_zone 不重推就保持过期，
  // 穿透态「可见按钮点不动」。周期复测 + payload dedup 兜住整类问题。
  let zonePollTimer: number | null = null;
  const stopZonePoll = (): void => {
    if (zonePollTimer !== null) {
      deps.doc.defaultView?.clearInterval(zonePollTimer);
      zonePollTimer = null;
    }
  };
  const startZonePoll = (): void => {
    if (zonePollTimer !== null) {
      return;
    }
    const win = deps.doc.defaultView;
    if (win === null) {
      return;
    }
    zonePollTimer = win.setInterval(() => {
      if (surface === null || surface === 'editor' || !clickThroughActive()) {
        stopZonePoll();
        return;
      }
      pushClickThrough();
    }, CONCEAL_ZONE_POLL_INTERVAL_MS);
  };

  const pushClickThrough = (): void => {
    if (surface === null || surface === 'editor') {
      stopZonePoll();
      return;
    }
    if (!clickThroughActive()) {
      stopZonePoll();
      // R13 不变量：透明关/穿透关 → 立即撤销（点击必须落回 LightInk）。
      if (appliedClickThrough || !clickThroughRevoked) {
        clickThroughRevoked = true;
        track(
          client.setClickThrough({
            enabled: false,
            topZone: null,
            bottomZone: null,
            topVisible: false,
            bottomVisible: false,
            uiZone: null,
          }),
        ).catch(() => undefined);
      }
      appliedClickThrough = false;
      pushedClickThroughKey = '';
      return;
    }
    const topMeasure = deps.measureTopZone();
    if (topMeasure !== null && topMeasure.height > 0) {
      zoneCache.set('top', topMeasure);
    }
    const bottomMeasure = deps.measureBottomZone();
    if (bottomMeasure !== null && bottomMeasure.height > 0) {
      zoneCache.set('bottom', bottomMeasure);
    }
    const topZone = currentTopZone();
    const bottomZone = surface === 'reader' ? currentBottomZone() : null;
    // R13：可见交互控件（设置入口/设置页/打开的面板）矩形；不可见时 null
    // （隐藏的控件不再是可见控件，点击按穿透处理）。
    const uiMeasure = deps.measureUiZone?.() ?? null;
    const payload = {
      enabled: true,
      topZone,
      bottomZone,
      topVisible: topMeasure !== null,
      bottomVisible: bottomMeasure !== null,
      uiZone: uiMeasure,
    };
    const key = JSON.stringify(payload);
    if (key === pushedClickThroughKey) {
      return;
    }
    pushedClickThroughKey = key;
    appliedClickThrough = true;
    clickThroughRevoked = false;
    startZonePoll();
    track(client.setClickThrough(payload)).catch((error: unknown) => {
      appliedClickThrough = false;
      pushedClickThroughKey = '';
      effective = { ...effective, clickThrough: false };
      deps.onNotice('clickThroughFailed', errorText(error));
      // 撤销尝试失败也把开关按失败处理（Wayland 不支持等场景）。
    });
  };

  // ── DOM 输出（html 变量 + #app data 属性 + reader chrome 接管） ──
  /** 页面背景改写值变化 → 派发事件让阅读器重涂章节 iframe（宿主 CSS 到不了 iframe 内）。 */
  const notifyPageBackground = (value: string | null): void => {
    if (value === lastPageBackground) {
      return;
    }
    lastPageBackground = value;
    if (typeof deps.doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      deps.doc.dispatchEvent(
        new CustomEvent(CONCEAL_PAGE_BACKGROUND_EVENT, { detail: { background: value } }),
      );
    }
  };

  const applyDomState = (): void => {
    const root = html();
    const appEl = app();
    if (surface === null) {
      return;
    }
    if (surface === 'editor') {
      setAttr(root, 'data-conceal-surface', 'editor');
      setAttr(root, 'data-conceal-transparent', null);
      setAttr(root, 'data-conceal-page-background', null);
      root.style.removeProperty('--lightink-conceal-page-background');
      root.style.removeProperty('--lightink-conceal-content-opacity');
      if (appEl !== null) {
        setAttr(appEl, 'data-conceal-transparent', null);
        setAttr(appEl, 'data-conceal-top', null);
        setAttr(appEl, 'data-conceal-body', null);
        setAttr(appEl, 'data-conceal-bottom', null);
      }
      deps.getActiveReaderChrome()?.setConcealZones('auto', 'auto');
      notifyPageBackground(null);
      return;
    }
    setAttr(root, 'data-conceal-surface', surface);
    const transparentOn = effective.transparentMode;
    setAttr(root, 'data-conceal-transparent', transparentOn ? 'on' : null);
    if (appEl !== null) {
      setAttr(appEl, 'data-conceal-transparent', transparentOn ? 'on' : null);
      setAttr(appEl, 'data-conceal-top', topHidden() ? 'hidden' : null);
      setAttr(appEl, 'data-conceal-body', bodyHidden() ? 'hidden' : null);
      setAttr(appEl, 'data-conceal-bottom', bottomHidden() ? 'hidden' : null);
    }
    // R6：透明关时渐变仍保存但不置 on；页面背景变量只在非透明时写渐变。
    // data-conceal-page-background 标记「改写变量已写入」，conceal.css 用它
    // 以 !important 压过 .lightink-reader / #lightink-editor-area 的内联纸色。
    const pageBackground = transparentOn
      ? 'transparent'
      : concealBackgroundToCss(effective.background);
    if (pageBackground === null) {
      root.style.removeProperty('--lightink-conceal-page-background');
      setAttr(root, 'data-conceal-page-background', null);
    } else {
      root.style.setProperty('--lightink-conceal-page-background', pageBackground);
      setAttr(root, 'data-conceal-page-background', 'on');
    }
    notifyPageBackground(pageBackground);
    if (effective.contentOpacity < 100) {
      root.style.setProperty('--lightink-conceal-content-opacity', String(effective.contentOpacity / 100));
    } else {
      root.style.removeProperty('--lightink-conceal-content-opacity');
    }
    // R7×reader-chrome：仅 reader 表面接管；R7 关（或透明关）回 'auto'。
    const chrome = deps.getActiveReaderChrome();
    if (surface === 'reader' && chrome !== null) {
      const chromeTop: ReaderConcealZoneMode =
        effective.hideTop && effective.transparentMode ? (topHidden() ? 'hidden' : 'held') : 'auto';
      const chromeBottom: ReaderConcealZoneMode = effective.hideBottom
        ? bottomHidden()
          ? 'hidden'
          : 'held'
        : 'auto';
      chrome.setConcealZones(chromeTop, chromeBottom);
    }
  };

  const sync = (): void => {
    refreshZoneCache();
    applyDomState();
    pushClickThrough();
  };

  // ── 窗口效果命令（R8/R6/R9） ────────────────────────────────
  const command = (
    run: () => Promise<null>,
    onFailure: (reason?: string) => void,
  ): void => {
    track(run()).catch((error: unknown) => {
      onFailure(errorText(error));
    });
  };

  const applyWindowEffects = (): void => {
    if (surface === null || surface === 'editor') {
      return;
    }
    if (effective.alwaysOnTop && !appliedAlwaysOnTop) {
      appliedAlwaysOnTop = true;
      command(() => client.setAlwaysOnTop(true), (reason) => {
        appliedAlwaysOnTop = false;
        effective = { ...effective, alwaysOnTop: false };
        deps.onNotice('alwaysOnTopFailed', reason);
      });
    }
    if (effective.transparentMode && !appliedTransparent) {
      appliedTransparent = true;
      command(() => client.setTransparent(true), (reason) => {
        appliedTransparent = false;
        effective = { ...effective, transparentMode: false };
        deps.onNotice('transparentFailed', reason);
        sync();
      });
    }
    if (effective.miniWindow && !appliedMiniWindow) {
      appliedMiniWindow = true;
      command(() => client.setMiniWindow(true), (reason) => {
        appliedMiniWindow = false;
        effective = { ...effective, miniWindow: false };
        deps.onNotice('miniWindowFailed', reason);
      });
    }
    // 关闭方向的命令（用户关开关 / 回退）也要下发。
    if (!effective.alwaysOnTop && appliedAlwaysOnTop) {
      appliedAlwaysOnTop = false;
      command(() => client.setAlwaysOnTop(false), (reason) => deps.onNotice('alwaysOnTopFailed', reason));
    }
    if (!effective.transparentMode && appliedTransparent) {
      appliedTransparent = false;
      command(() => client.setTransparent(false), (reason) => deps.onNotice('transparentFailed', reason));
    }
    if (!effective.miniWindow && appliedMiniWindow) {
      appliedMiniWindow = false;
      command(() => client.setMiniWindow(false), (reason) => deps.onNotice('miniWindowFailed', reason));
    }
  };

  // ── R1 表面切换 ─────────────────────────────────────────────
  const setSurface = (next: ConcealSurface): void => {
    const previous = surface;
    surface = next;
    pointerZone = null;
    if (next === 'editor') {
      if (previous !== 'editor') {
        stopZonePoll();
        // 一键撤销全部窗口效果（后端幂等：停穿透轮询+置顶+透明+mini 恢复）。
        track(client.restoreWindowBaseline()).catch((error: unknown) => {
          // R1 失败边界：编辑器表面仍按无效果呈现（属性已清）；
          // mini 开关内存回退，避免回书架重放与失败态打架（可重试：再次
          // 进入编辑器会再调 baseline，命令幂等）。
          appliedMiniWindow = false;
          effective = { ...effective, miniWindow: false };
          deps.onNotice('baselineFailed', errorText(error));
        });
        appliedAlwaysOnTop = false;
        appliedTransparent = false;
        appliedMiniWindow = false;
        appliedClickThrough = false;
        clickThroughRevoked = true;
        pushedClickThroughKey = '';
      }
      applyDomState();
      return;
    }
    // 回到 shelf/reader：按仍保存的开关重放窗口效果（从 editor 回来或
    // 首次进入才发命令；shelf↔reader 只重算 DOM/zones）。
    if (previous === null || previous === 'editor') {
      applyWindowEffects();
    }
    sync();
  };

  // ── R7 指针状态机（DOM 与后端事件同一入口） ─────────────────
  const setPointerZone = (zone: ConcealPointerZoneName): void => {
    if (pointerZone === zone) {
      return;
    }
    pointerZone = zone;
    if (surface === null || surface === 'editor') {
      return;
    }
    sync();
  };

  const handlePointerMove = (clientY: number | null): void => {
    if (clientY === null || !Number.isFinite(clientY)) {
      setPointerZone('outside');
      return;
    }
    const top = currentTopZone();
    if (clientY >= top.y && clientY < top.y + top.height) {
      setPointerZone('top');
      return;
    }
    if (surface === 'reader') {
      const bottom = currentBottomZone();
      if (clientY >= bottom.y && clientY < bottom.y + bottom.height) {
        setPointerZone('bottom');
        return;
      }
    }
    setPointerZone('body');
  };

  return {
    init() {
      setSurface(surface ?? 'shelf');
    },
    setSurface,
    applyPrefs(update) {
      const merged: ConcealPrefs = { ...effective, ...update };
      if (!isConcealPrefsValid(merged)) {
        return effective;
      }
      effective = deps.persist(merged, effective);
      applyWindowEffects();
      sync();
      return effective;
    },
    getEffectivePrefs: () => ({ ...effective }),
    async updateBossKeys(primary, secondary) {
      // 客户端预校验（与后端 conceal_register_boss_keys 同一错误分类）。
      const primaryValid = isValidHotkeyCombo(primary);
      const secondaryValid = isValidHotkeyCombo(secondary);
      let primaryError: string | null = null;
      let secondaryError: string | null = null;
      if (!primaryValid) {
        primaryError = primary.trim() === '' ? BOSS_KEY_EMPTY_ERROR : BOSS_KEY_INVALID_ERROR;
      }
      if (!secondaryValid) {
        secondaryError = secondary.trim() === '' ? BOSS_KEY_EMPTY_ERROR : BOSS_KEY_INVALID_ERROR;
      } else if (primaryValid && isSameHotkeyCombo(primary, secondary)) {
        secondaryError = BOSS_KEY_SAME_ERROR;
      }
      if (primaryError !== null || secondaryError !== null) {
        return { primary: null, secondary: null, primaryError, secondaryError };
      }
      const registered = await client.registerBossKeys({ primary, secondary });
      if (registered.primaryError === null && registered.secondaryError === null) {
        // R2/R10：注册成功才落存（失败修改不持久化，上一组合继续可用）。
        effective = deps.persist({ ...effective, bossPrimary: primary, bossSecondary: secondary }, effective);
      }
      return registered;
    },
    handlePointerMove,
    handlePointerZone: setPointerZone,
    notifyZonesStale() {
      if (surface === null || surface === 'editor') {
        return;
      }
      sync();
    },
    async settled() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    dispose() {
      stopZonePoll();
      surface = null;
      pointerZone = null;
      zoneCache.clear();
      deps.getActiveReaderChrome()?.setConcealZones('auto', 'auto');
      const root = html();
      setAttr(root, 'data-conceal-surface', null);
      setAttr(root, 'data-conceal-transparent', null);
      setAttr(root, 'data-conceal-page-background', null);
      root.style.removeProperty('--lightink-conceal-page-background');
      root.style.removeProperty('--lightink-conceal-content-opacity');
      lastPageBackground = null;
      const appEl = app();
      if (appEl !== null) {
        setAttr(appEl, 'data-conceal-transparent', null);
        setAttr(appEl, 'data-conceal-top', null);
        setAttr(appEl, 'data-conceal-body', null);
        setAttr(appEl, 'data-conceal-bottom', null);
      }
    },
  };
}
