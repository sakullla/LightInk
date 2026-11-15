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
  /** 可选：读取当前编辑器文本，以支持在版本历史中查看「对比当前」行级差异。 */
  getCurrentContent?(): string;
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
    getCurrentContent: () => {
      const target = resolveTarget();
      return target === null ? '' : deps.getContent(target);
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
  readonly viewFull?: string;
  readonly viewDiff?: string;
  readonly identical?: string;
  readonly diffSummary?: (added: number, removed: number) => string;
  readonly justNow?: string;
  readonly minutesAgo?: (n: number) => string;
  readonly hoursAgo?: (n: number) => string;
  readonly daysAgo?: (n: number) => string;
}

export interface DiffLine {
  readonly kind: 'same' | 'add' | 'del';
  readonly text: string;
}

export interface LineDiffResult {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
  readonly identical: boolean;
}

function splitNormalizedLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  return normalized.split('\n');
}

/**
 * Pure line-level diff (`snapshot` → `current`, or vice-versa).
 * Uses common-prefix/suffix trimming + exact LCS DP for normal document sizes,
 * with a bounded linear fallback so huge snapshots never stall the UI.
 */
export function computeLineDiff(baseText: string, targetText: string): LineDiffResult {
  const a = splitNormalizedLines(baseText);
  const b = splitNormalizedLines(targetText);
  if (a.length === b.length && a.every((line, i) => line === b[i])) {
    return {
      lines: a.map((text) => ({ kind: 'same' as const, text })),
      added: 0,
      removed: 0,
      identical: true,
    };
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffixA = a.length;
  let suffixB = b.length;
  while (
    suffixA > prefix &&
    suffixB > prefix &&
    a[suffixA - 1] === b[suffixB - 1]
  ) {
    suffixA -= 1;
    suffixB -= 1;
  }

  const head: DiffLine[] = a.slice(0, prefix).map((text) => ({ kind: 'same', text }));
  const tail: DiffLine[] = a.slice(suffixA).map((text) => ({ kind: 'same', text }));
  const midA = a.slice(prefix, suffixA);
  const midB = b.slice(prefix, suffixB);
  const m = midA.length;
  const n = midB.length;

  let middle: DiffLine[] = [];
  if (m === 0) {
    middle = midB.map((text) => ({ kind: 'add', text }));
  } else if (n === 0) {
    middle = midA.map((text) => ({ kind: 'del', text }));
  } else if (m * n <= 250_000) {
    const dp = new Uint32Array((m + 1) * (n + 1));
    const stride = n + 1;
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i * stride + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * stride + (j + 1)]! + 1
            : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + (j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: 'same', text: midA[i]! });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + (j + 1)]!) {
        middle.push({ kind: 'del', text: midA[i]! });
        i += 1;
      } else {
        middle.push({ kind: 'add', text: midB[j]! });
        j += 1;
      }
    }
    while (i < m) {
      middle.push({ kind: 'del', text: midA[i]! });
      i += 1;
    }
    while (j < n) {
      middle.push({ kind: 'add', text: midB[j]! });
      j += 1;
    }
  } else {
    middle = [
      ...midA.map((text) => ({ kind: 'del' as const, text })),
      ...midB.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  const lines = [...head, ...middle, ...tail];
  let added = 0;
  let removed = 0;
  for (const entry of middle) {
    if (entry.kind === 'add') added += 1;
    else if (entry.kind === 'del') removed += 1;
  }
  return { lines, added, removed, identical: added === 0 && removed === 0 };
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
    viewFull: labels.viewFull ?? 'Full text',
    viewDiff: labels.viewDiff ?? 'Changes',
    identical: labels.identical ?? 'Identical to current document',
    diffSummary:
      labels.diffSummary ?? ((added, removed) => `+${added} / -${removed} lines`),
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

  // 双栏主体：左版本列表 / 右内容预览（含完整内容 ↔ 对比当前切换）。
  const body = doc.createElement('div');
  body.className = 'lightink-versions-body';
  const listEl = doc.createElement('div');
  listEl.className = 'lightink-versions-list';
  const loading = doc.createElement('div');
  loading.className = 'lightink-versions-empty';
  loading.textContent = L.loading;
  listEl.appendChild(loading);

  const previewPane = doc.createElement('div');
  previewPane.className = 'lightink-versions-preview-pane';
  const hasDiffSupport = typeof actions.getCurrentContent === 'function';
  const previewToolbar = doc.createElement('div');
  previewToolbar.className = 'lightink-versions-toolbar';
  previewToolbar.hidden = !hasDiffSupport;
  const diffMeta = doc.createElement('span');
  diffMeta.className = 'lightink-versions-diff-meta';
  const modeSwitch = doc.createElement('div');
  modeSwitch.className = 'lightink-versions-mode-switch';
  const fullModeBtn = doc.createElement('button');
  fullModeBtn.type = 'button';
  fullModeBtn.className = 'lightink-versions-mode-btn is-active';
  fullModeBtn.textContent = L.viewFull;
  fullModeBtn.setAttribute('aria-pressed', 'true');
  const diffModeBtn = doc.createElement('button');
  diffModeBtn.type = 'button';
  diffModeBtn.className = 'lightink-versions-mode-btn';
  diffModeBtn.textContent = L.viewDiff;
  diffModeBtn.setAttribute('aria-pressed', 'false');
  modeSwitch.append(fullModeBtn, diffModeBtn);
  previewToolbar.append(diffMeta, modeSwitch);

  const preview = doc.createElement('pre');
  preview.className = 'lightink-versions-preview';
  preview.textContent = L.pick;
  previewPane.append(previewToolbar, preview);
  body.append(listEl, previewPane);

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
  let loadedVersionContent: string | null = null;
  let previewMode: 'full' | 'diff' = 'full';
  let releaseModal = (): void => overlay.remove();

  function renderPreview(): void {
    if (loadedVersionContent === null) {
      diffMeta.textContent = '';
      return;
    }
    if (!hasDiffSupport) {
      preview.classList.remove('is-diff');
      preview.textContent = loadedVersionContent;
      return;
    }
    // Diff direction: currentContent (base) -> loadedVersionContent (what restoring this version changes relative to current, or version -> current).
    // Showing current -> selected version makes `+` = lines this snapshot restores, `-` = lines added since this snapshot; wait: in Git/VS Code Timeline, comparing Snapshot (before) -> Current (after), or Snapshot vs Current?
    // Comparing Snapshot (old) -> Current (now) can confuse "restore"; comparing Current -> Snapshot or clearly prefixing:
    // Actually VS Code Timeline compares Selected Snapshot (left/old) ↔ Current (right/new), OR Snapshot vs Current. Even clearer: compare Current (base) → Selected Version (target)? Wait: if you wrote 3 new lines today and inspect yesterday's snapshot, yesterday's snapshot has 3 fewer lines (`-3` relative to current, or `+3` in current). Comparing `loadedVersionContent` (snapshot) vs `current`: let's check what users expect when clicking "Changes":
    // If snapshot is older, compared against current (`computeLineDiff(current, loadedVersionContent)`): lines present in snapshot that were deleted in current show `+` (will come back if restored), lines added in current that aren't in snapshot show `-` (will be removed if restored)! That matches "what restoring this version will do" AND `computeLineDiff(current, loadedVersionContent)` is 100% unambiguous!
    const current = actions.getCurrentContent?.() ?? '';
    const diff = computeLineDiff(current, loadedVersionContent);
    diffMeta.textContent = diff.identical
      ? L.identical
      : L.diffSummary(diff.added, diff.removed);
    diffMeta.dataset.identical = diff.identical ? 'true' : 'false';

    if (previewMode === 'full') {
      preview.classList.remove('is-diff');
      preview.textContent = loadedVersionContent;
      return;
    }

    preview.classList.add('is-diff');
    preview.replaceChildren();
    if (diff.identical) {
      const sameNotice = doc.createElement('div');
      sameNotice.className = 'lightink-versions-diff-identical';
      sameNotice.textContent = L.identical;
      preview.appendChild(sameNotice);
      return;
    }
    for (const line of diff.lines) {
      const row = doc.createElement('div');
      row.className = `lightink-diff-line lightink-diff-line--${line.kind}`;
      const sign = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ';
      row.textContent = `${sign}${line.text}`;
      preview.appendChild(row);
    }
  }

  function setPreviewMode(next: 'full' | 'diff'): void {
    previewMode = next;
    const isFull = next === 'full';
    fullModeBtn.classList.toggle('is-active', isFull);
    fullModeBtn.setAttribute('aria-pressed', isFull ? 'true' : 'false');
    diffModeBtn.classList.toggle('is-active', !isFull);
    diffModeBtn.setAttribute('aria-pressed', !isFull ? 'true' : 'false');
    renderPreview();
  }

  fullModeBtn.addEventListener('click', () => setPreviewMode('full'));
  diffModeBtn.addEventListener('click', () => setPreviewMode('diff'));

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
    loadedVersionContent = null;
    for (const el of listEl.querySelectorAll('.lightink-versions-item')) {
      el.classList.remove('selected');
    }
    row.classList.add('selected');
    restoreBtn.disabled = false;
    preview.classList.remove('is-diff');
    preview.textContent = L.loading;
    diffMeta.textContent = '';
    void actions
      .read(id)
      .then((content) => {
        if (selectedId !== id) return;
        loadedVersionContent = content;
        renderPreview();
      })
      .catch(() => {
        if (selectedId !== id) return;
        loadedVersionContent = null;
        preview.classList.remove('is-diff');
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
    const sorted = newestFirst(metas);
    const rows: Array<{ meta: VersionMeta; row: HTMLButtonElement }> = [];
    for (const meta of sorted) {
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
      rows.push({ meta, row });
    }
    // 自动选中最新快照（或保留已选中项），打开即预览，无需额外点击。
    const target = rows.find((entry) => entry.meta.id === selectedId) ?? rows[0];
    if (target !== undefined) {
      selectRow(target.meta.id, target.row);
    }
  }

  listEl.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(listEl.querySelectorAll<HTMLButtonElement>('.lightink-versions-item'));
    if (items.length === 0) return;
    event.preventDefault();
    const currentIdx = items.findIndex((el) => el.classList.contains('selected'));
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIdx = currentIdx < 0 ? 0 : (currentIdx + delta + items.length) % items.length;
    const nextEl = items[nextIdx];
    if (nextEl !== undefined) {
      nextEl.focus();
      nextEl.click();
    }
  });

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
