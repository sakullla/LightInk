/**
 * `paper-card` — 编辑版心纸卡模式（纸墨工作室 §3.10）。
 *
 * 版心（`.lightink-tab-host`）默认作为 bg-elevated 纸卡浮在 bg 纸面上：
 * 1px border + 静置阴影；沉浸（chrome 未钉住）与全屏（进入即取消钉住）时
 * 由 editor.css 的兄弟选择器自动融为纯纸面。视觉全部在 CSS；本模块只负责
 * 偏好读取（默认开）与宿主类开关，供 mountEditor 在挂载时应用。
 *
 * 偏好键 `lightink.editorPaperCard`（localStorage）：`false` 关闭纸卡。
 * 菜单开关入口属于外壳包（视图菜单）；本模块暴露纯函数让壳层无需依赖
 * 编辑器引擎即可读写同一偏好。
 */

/** localStorage key for the editor paper-card preference. */
export const PAPER_CARD_STORAGE_KEY = 'lightink.editorPaperCard';

/** 首启默认：纸卡开（§3.10「可选『纸卡模式』，默认开」）。 */
export const PAPER_CARD_DEFAULT = true;

/** 应用在版心宿主上的纸卡类名（editor.css 消费）。 */
export const PAPER_CARD_CLASS = 'is-paper-card';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/**
 * 读取纸卡偏好；键缺失/值损坏/存储不可用时回退默认（开）。
 * 仅显式 `false`（或字符串 'false'）关闭。
 */
export function resolvePaperCardEnabled(storage: StorageLike): boolean {
  if (storage === null || storage === undefined) {
    return PAPER_CARD_DEFAULT;
  }
  try {
    const raw = storage.getItem(PAPER_CARD_STORAGE_KEY);
    if (raw === null || raw === '') {
      return PAPER_CARD_DEFAULT;
    }
    if (raw === 'false' || raw === '0') {
      return false;
    }
    if (raw === 'true' || raw === '1') {
      return true;
    }
    return PAPER_CARD_DEFAULT;
  } catch {
    return PAPER_CARD_DEFAULT;
  }
}

/** 持久化纸卡偏好（best-effort；隐私模式/配额失败静默忽略）。 */
export function savePaperCardEnabled(storage: StorageLike, enabled: boolean): void {
  if (storage === null || storage === undefined) {
    return;
  }
  try {
    storage.setItem(PAPER_CARD_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* privacy mode / quota */
  }
}

/** 解析生产环境的存储句柄（localStorage 不可用时返回 null）。 */
function resolveStorage(): StorageLike {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    /* privacy mode */
  }
  return null;
}

/** 按偏好给编辑器宿主加/去纸卡类；返回最终是否启用（供测试断言）。 */
export function applyPaperCardClass(
  container: HTMLElement,
  enabled: boolean,
): boolean {
  container.classList.toggle(PAPER_CARD_CLASS, enabled);
  return enabled;
}

/** mountEditor 用的默认入口：读偏好并应用到宿主。缺省存储不可用 → 默认开。 */
export function applyPaperCardPreference(container: HTMLElement): boolean {
  return applyPaperCardClass(container, resolvePaperCardEnabled(resolveStorage()));
}
