/**
 * `versions` — 本地版本快照 UI（R13）：版本历史弹层（列表/预览/恢复/手动存档）。
 *
 * 后端 `snapshot::list_versions/read_version/restore_version/create_version`
 * 负责存储（每文件版本集、上限淘汰、恢复前自动存档）；本模块仅渲染弹层并
 * 经注入的 [`VersionActions`] 与后端 + 编辑器交互。纯逻辑 [`newestFirst`] 可单测。
 */

import { labelModal, mountModalFocus } from './modal-focus.js';

export interface VersionMeta {
  id: string;
  created_at_ms: number;
}

export interface VersionActions {
  /** 列出全部版本（后端已最新在前；此处不再排序以保证与后端一致）。 */
  list(): Promise<VersionMeta[]>;
  /** 读取某版本完整内容（预览）。 */
  read(id: string): Promise<string>;
  /** 恢复某版本：后端先存当前内容再返回目标，前端写回编辑器并置脏。 */
  restore(id: string): Promise<void>;
  /** 手动把当前内容存为一个新版本。 */
  saveCurrent(): Promise<void>;
}

export interface BoundVersionActionsDeps<
  T extends { readonly id: string; readonly filePath: string | null },
> {
  readonly targetId: string;
  readonly filePath: string;
  getTarget(id: string): T | null;
  getContent(target: T): string;
  setContent(target: T, content: string): void;
  listVersions(filePath: string): Promise<VersionMeta[]>;
  readVersion(filePath: string, id: string): Promise<string>;
  restoreVersion(filePath: string, id: string, currentContent: string): Promise<string>;
  createVersion(filePath: string, content: string): Promise<void>;
}

/** Bind async version operations to the document that opened the modal. */
export function createBoundVersionActions<
  T extends { readonly id: string; readonly filePath: string | null },
>(deps: BoundVersionActionsDeps<T>): VersionActions {
  const resolveTarget = (): T | null => {
    const target = deps.getTarget(deps.targetId);
    return target?.filePath === deps.filePath ? target : null;
  };

  return {
    list: () => deps.listVersions(deps.filePath),
    read: (id) => deps.readVersion(deps.filePath, id),
    restore: async (id) => {
      const target = resolveTarget();
      if (target === null) return;
      const content = await deps.restoreVersion(
        deps.filePath,
        id,
        deps.getContent(target),
      );
      const liveTarget = resolveTarget();
      if (liveTarget !== null) {
        deps.setContent(liveTarget, content);
      }
    },
    saveCurrent: async () => {
      const target = resolveTarget();
      if (target === null) return;
      await deps.createVersion(deps.filePath, deps.getContent(target));
    },
  };
}

export interface VersionModalLabels {
  readonly title?: string;
  readonly loading?: string;
  readonly pick?: string;
  readonly empty?: string;
  readonly restore?: string;
  readonly saveNew?: string;
  readonly close?: string;
  readonly loadFailed?: string;
  readonly justNow?: string;
  readonly minutesAgo?: (n: number) => string;
  readonly hoursAgo?: (n: number) => string;
  readonly daysAgo?: (n: number) => string;
}

/** 纯逻辑：按 created_at_ms 降序（最新在前）。后端已降序返回，本函数作契约保证。 */
export function newestFirst(metas: readonly VersionMeta[]): VersionMeta[] {
  return [...metas].sort((a, b) => b.created_at_ms - a.created_at_ms);
}

/**
 * 纯逻辑：相对时间（VS Code 时间线风格）——
 * <1 分钟「刚刚」；<1 小时「N 分钟前」；<24 小时「N 小时前」；<7 天「N 天前」；
 * 更早返回空串（调用方回落到绝对时间）。
 */
export interface RelativeTimeLabels {
  readonly justNow?: string;
  readonly minutesAgo?: (n: number) => string;
  readonly hoursAgo?: (n: number) => string;
  readonly daysAgo?: (n: number) => string;
}

/** Default Chinese-style relative labels (tests + zh-CN). */
const DEFAULT_RELATIVE: Required<RelativeTimeLabels> = {
  justNow: '刚刚',
  minutesAgo: (n) => `${n} 分钟前`,
  hoursAgo: (n) => `${n} 小时前`,
  daysAgo: (n) => `${n} 天前`,
};

export function formatRelativeTime(
  ms: number,
  nowMs: number,
  labels: RelativeTimeLabels = {},
): string {
  const L = { ...DEFAULT_RELATIVE, ...labels };
  const diff = nowMs - ms;
  if (diff < 0) return '';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return L.justNow;
  if (minutes < 60) return L.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return L.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return L.daysAgo(days);
  return '';
}

/** 创建版本历史弹层并挂载到 document.body。 */
export function showVersionsModal(
  doc: Document,
  actions: VersionActions,
  labels: VersionModalLabels = {},
): void {
  const L = {
    title: labels.title ?? 'Version History',
    loading: labels.loading ?? 'Loading…',
    pick: labels.pick ?? 'Select a version to preview',
    empty: labels.empty ?? 'No versions yet — snapshots are created when you save.',
    restore: labels.restore ?? 'Restore this version',
    saveNew: labels.saveNew ?? 'Save current as new version',
    close: labels.close ?? 'Close',
    loadFailed: labels.loadFailed ?? '(Could not read this version)',
    justNow: labels.justNow ?? 'Just now',
    minutesAgo: labels.minutesAgo,
    hoursAgo: labels.hoursAgo,
    daysAgo: labels.daysAgo,
  };
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-versions-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const head = doc.createElement('div');
  head.className = 'lightink-modal-head';
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  title.textContent = L.title;
  const cornerClose = doc.createElement('button');
  cornerClose.type = 'button';
  cornerClose.className = 'lightink-modal-dismiss';
  cornerClose.setAttribute('aria-label', L.close);
  cornerClose.title = L.close;
  cornerClose.textContent = '×';
  head.append(title, cornerClose);
  labelModal(dialog, title);

  // 双栏主体：左版本列表 / 右内容预览。
  const body = doc.createElement('div');
  body.className = 'lightink-versions-body';
  const listEl = doc.createElement('div');
  listEl.className = 'lightink-versions-list';
  const loading = doc.createElement('div');
  loading.className = 'lightink-versions-empty';
  loading.textContent = L.loading;
  listEl.appendChild(loading);
  const preview = doc.createElement('pre');
  preview.className = 'lightink-versions-preview';
  preview.textContent = L.pick;
  body.append(listEl, preview);

  const restoreBtn = doc.createElement('button');
  restoreBtn.type = 'button';
  restoreBtn.className = 'lightink-modal-btn lightink-modal-btn--primary';
  restoreBtn.textContent = L.restore;
  restoreBtn.disabled = true;
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
  saveBtn.textContent = L.saveNew;
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightink-modal-btn lightink-modal-btn--plain';
  closeBtn.textContent = L.close;
  const footer = doc.createElement('div');
  footer.className = 'lightink-modal-actions';
  footer.append(saveBtn, closeBtn, restoreBtn);
  dialog.append(head, body, footer);
  overlay.appendChild(dialog);

  let selectedId: string | null = null;
  let releaseModal = (): void => overlay.remove();

  function dismiss(): void {
    releaseModal();
  }
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) {
      dismiss();
    }
  });
  closeBtn.addEventListener('click', dismiss);
  cornerClose.addEventListener('click', dismiss);
  restoreBtn.addEventListener('click', () => {
    if (selectedId === null) {
      return;
    }
    const id = selectedId;
    dismiss();
    void actions.restore(id);
  });
  saveBtn.addEventListener('click', () => {
    saveBtn.disabled = true;
    void actions
      .saveCurrent()
      .then(refresh)
      .catch(() => undefined)
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  function selectRow(id: string, row: HTMLButtonElement): void {
    selectedId = id;
    for (const el of listEl.querySelectorAll('.lightink-versions-item')) {
      el.classList.remove('selected');
    }
    row.classList.add('selected');
    restoreBtn.disabled = false;
    preview.textContent = L.loading;
    void actions
      .read(id)
      .then((content) => {
        preview.textContent = content;
      })
      .catch(() => {
        preview.textContent = L.loadFailed;
      });
  }

  function renderRows(metas: readonly VersionMeta[]): void {
    listEl.replaceChildren();
    if (metas.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'lightink-versions-empty';
      empty.textContent = L.empty;
      listEl.appendChild(empty);
      return;
    }
    const now = Date.now();
    for (const meta of newestFirst(metas)) {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'lightink-versions-item';
      const rel = doc.createElement('span');
      rel.className = 'lightink-versions-item-rel';
      const relative = formatRelativeTime(meta.created_at_ms, now, {
        justNow: L.justNow,
        minutesAgo: L.minutesAgo,
        hoursAgo: L.hoursAgo,
        daysAgo: L.daysAgo,
      });
      // 超出相对时间范围（>7 天）：主行直接显示绝对时间，不再重复副行。
      rel.textContent = relative !== '' ? relative : formatVersionTime(meta.created_at_ms);
      row.appendChild(rel);
      if (relative !== '') {
        const abs = doc.createElement('span');
        abs.className = 'lightink-versions-item-abs';
        abs.textContent = formatVersionTime(meta.created_at_ms);
        row.appendChild(abs);
      }
      row.addEventListener('click', () => selectRow(meta.id, row));
      listEl.appendChild(row);
    }
  }

  function refresh(): void {
    void actions
      .list()
      .then(renderRows)
      .catch(() => renderRows([]));
  }

  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: closeBtn,
    onEscape: dismiss,
  });
  refresh();
}

/** 把毫秒时间戳格式化为本地可读串（运行时 UI，非单测对象）。 */
function formatVersionTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return `版本 ${ms}`;
  }
}
