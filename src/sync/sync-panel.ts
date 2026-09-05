import { labelModal, mountModalFocus } from '../ui/modal-focus.js';
import { adoptDialogSurfaceTheme, inferDialogThemeHost } from '../ui/confirm-dialog.js';
import {
  applyLibraryTheme,
  loadLibraryTheme,
  type LibraryThemeStorage,
} from '../library/library-theme.js';
import type {
  SyncAuthType,
  SyncCredential,
  SyncProfile,
  SyncProfileInput,
  WebDavCapability,
  WebDavClient,
} from './webdav-client.js';
import type { SyncConflict, SyncStatus } from './sync-client.js';
import type { ManagedMigrationEntry, ManagedMigrationPreview, ManagedMigrationResult } from '../library/library-client.js';

export interface SyncPanelDeps {
  readonly doc: Document;
  readonly webdav: Pick<WebDavClient, 'getProfile' | 'saveProfile' | 'testProfile' | 'forgetProfile'>;
  readonly sync: {
    status(): Promise<SyncStatus>;
    run(): Promise<SyncStatus>;
    cancel(): Promise<void>;
    listConflicts(includeResolved?: boolean): Promise<SyncConflict[]>;
    resolveConflict(id: string): Promise<void>;
  };
  readonly syncNow?: () => Promise<SyncStatus | null>;
  readonly migration?: {
    preview(): Promise<ManagedMigrationPreview>;
    apply(itemIds: readonly string[]): Promise<ManagedMigrationResult>;
  };
  readonly locale?: 'en' | 'zh-CN';
  readonly onClose?: () => void;
  /** Visible shelf/reader host; inferred when omitted. */
  readonly themeHost?: HTMLElement;
  /** `lightink.library.theme` store; falls back to the document's localStorage. */
  readonly themeStorage?: LibraryThemeStorage | null;
}

type Labels = {
  title: string;
  name: string;
  url: string;
  auth: string;
  basic: string;
  bearer: string;
  username: string;
  password: string;
  token: string;
  allowHttp: string;
  save: string;
  test: string;
  sync: string;
  cancelSync: string;
  close: string;
  forget: string;
  conflicts: string;
  noConflicts: string;
  resolve: string;
  migration: string;
  preview: string;
  apply: string;
  status: string;
  ready: string;
  running: string;
  cancelled: string;
  success: string;
  needsCredential: string;
  saved: string;
  failed: string;
  missingCapabilities: string;
  connection: string;
  dangerZone: string;
  authHintBasic: string;
  authHintBearer: string;
  progressTitle: string;
};

const LABELS: Record<'en' | 'zh-CN', Labels> = {
  en: {
    title: 'WebDAV sync',
    name: 'Name',
    url: 'WebDAV URL',
    auth: 'Authentication',
    basic: 'Basic',
    bearer: 'Bearer',
    username: 'Username',
    password: 'App password',
    token: 'Access token',
    allowHttp: 'Allow HTTP/LAN',
    save: 'Save',
    test: 'Test connection',
    sync: 'Sync now',
    cancelSync: 'Cancel sync',
    close: 'Close',
    forget: 'Forget target',
    conflicts: 'Conflicts',
    noConflicts: 'No unresolved conflicts',
    resolve: 'Mark resolved',
    migration: 'Manage old books',
    preview: 'Preview migration',
    apply: 'Import selected',
    status: 'Status',
    ready: 'Ready',
    running: 'Syncing…',
    cancelled: 'Cancelled',
    success: 'Synced',
    needsCredential: 'Credentials required on this device',
    saved: 'Saved',
    failed: 'Operation failed',
    missingCapabilities: 'Server is missing required WebDAV capabilities',
    connection: 'Connection',
    dangerZone: 'Danger zone',
    authHintBasic: 'Use the username plus an app-specific password from your provider — not the web login password.',
    authHintBearer: 'Paste the access token only. Username and password are not used.',
    progressTitle: 'Syncing',
  },
  'zh-CN': {
    title: 'WebDAV 同步',
    name: '名称',
    url: 'WebDAV 地址',
    auth: '鉴权',
    basic: 'Basic',
    bearer: 'Bearer',
    username: '用户名',
    password: '应用密码',
    token: '访问令牌',
    allowHttp: '允许 HTTP/LAN',
    save: '保存配置',
    test: '测试连接',
    sync: '立即同步',
    cancelSync: '取消同步',
    close: '关闭',
    forget: '忘记目标',
    conflicts: '冲突',
    noConflicts: '没有未处理冲突',
    resolve: '标记已处理',
    migration: '管理旧书',
    preview: '预览迁移',
    apply: '导入选中',
    status: '状态',
    ready: '就绪',
    running: '同步中…',
    cancelled: '已取消',
    success: '已同步',
    needsCredential: '此设备需要重新输入凭据',
    saved: '已保存',
    failed: '操作失败',
    missingCapabilities: '服务器缺少同步所需的 WebDAV 能力',
    connection: '连接',
    dangerZone: '危险操作',
    authHintBasic: '填写网盘用户名，以及单独生成的应用密码，不是网页登录密码。',
    authHintBearer: '只需粘贴访问令牌，不用填写用户名和密码。',
    progressTitle: '正在同步',
  },
};

const PHASE_LABELS: Record<'en' | 'zh-CN', Record<string, string>> = {
  en: {
    connect: 'Connecting',
    compare: 'Comparing remote files',
    layout: 'Preparing remote folders',
    'upload-books': 'Uploading books',
    'upload-docs': 'Uploading documents',
    merge: 'Merging records',
    download: 'Downloading offline books',
    snapshot: 'Saving snapshot',
    cleanup: 'Cleaning remote files',
    done: 'Done',
  },
  'zh-CN': {
    connect: '连接服务器',
    compare: '对比远程文件',
    layout: '准备远程目录',
    'upload-books': '上传书籍',
    'upload-docs': '上传文档',
    merge: '合并记录',
    download: '下载离线书',
    snapshot: '保存快照',
    cleanup: '清理远程文件',
    done: '完成',
  },
};

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function phaseCaption(locale: 'en' | 'zh-CN', value: SyncStatus, fallback: string): string {
  const phase = value.phase ?? '';
  const name = PHASE_LABELS[locale][phase] ?? fallback;
  const current = value.current ?? 0;
  const total = value.total ?? 0;
  if (total > 0) return `${name} ${current} / ${total}`;
  return name;
}

function formatFinishedAt(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return ` · ${date.toLocaleString()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uploadCount(value: SyncStatus): number {
  return value.uploaded + (value.skipped ?? 0);
}

function button(doc: Document, label: string, kind = 'plain'): HTMLButtonElement {
  const value = doc.createElement('button');
  value.type = 'button';
  value.className = `lightink-modal-btn lightink-modal-btn--${kind}`;
  value.textContent = label;
  return value;
}

function section(doc: Document, titleText: string, extraClass = ''): HTMLElement {
  const root = doc.createElement('section');
  root.className = extraClass === '' ? 'lightink-sync-section' : `lightink-sync-section ${extraClass}`;
  const heading = doc.createElement('h3');
  heading.className = 'lightink-sync-section-title';
  heading.textContent = titleText;
  root.append(heading);
  return root;
}

function field(doc: Document, label: string, type: string, value = ''): HTMLInputElement {
  const wrapper = doc.createElement('label');
  wrapper.className = 'lightink-sync-field';
  const caption = doc.createElement('span');
  caption.textContent = label;
  const input = doc.createElement('input');
  input.type = type;
  input.value = value;
  input.autocomplete = type === 'password' ? 'new-password' : 'off';
  wrapper.append(caption, input);
  (input as HTMLInputElement & { fieldWrapper?: HTMLElement }).fieldWrapper = wrapper;
  return input;
}

function migrationLabel(entry: ManagedMigrationEntry): string {
  const suffix = entry.size === undefined ? '' : ` (${Math.round(entry.size / 1024)} KiB)`;
  return `${entry.title}${suffix}`;
}

function themeStorageOf(deps: SyncPanelDeps): LibraryThemeStorage | null {
  if (deps.themeStorage !== undefined) {
    return deps.themeStorage;
  }
  try {
    return deps.doc.defaultView?.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Paint the body-mounted dialog with the current shelf (or reader) tokens,
 * not the editor / markdown cream on document.documentElement.
 */
function applySyncPanelSurfaceTheme(overlay: HTMLElement, deps: SyncPanelDeps): void {
  const host = deps.themeHost ?? inferDialogThemeHost(deps.doc);
  if (host !== null) {
    adoptDialogSurfaceTheme(overlay, host);
    overlay.style.backgroundColor = '';
    return;
  }
  applyLibraryTheme(overlay, loadLibraryTheme(themeStorageOf(deps)));
  overlay.style.backgroundColor = '';
}

/** Render the complete sync configuration/status surface. */
export function showSyncPanel(deps: SyncPanelDeps): void {
  const doc = deps.doc;
  const locale = deps.locale ?? 'zh-CN';
  const L = LABELS[locale];
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-sync-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const header = doc.createElement('header');
  header.className = 'lightink-sync-header';
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  title.textContent = L.title;
  header.append(title);
  labelModal(dialog, title);

  const form = doc.createElement('form');
  form.className = 'lightink-sync-form';
  const name = field(doc, L.name, 'text');
  const url = field(doc, L.url, 'url');
  const authLabel = doc.createElement('label');
  authLabel.className = 'lightink-sync-field lightink-sync-field--span';
  const authCaption = doc.createElement('span');
  authCaption.textContent = L.auth;
  const auth = doc.createElement('select');
  const basic = doc.createElement('option');
  basic.value = 'basic';
  basic.textContent = L.basic;
  const bearer = doc.createElement('option');
  bearer.value = 'bearer';
  bearer.textContent = L.bearer;
  auth.append(basic, bearer);
  authLabel.append(authCaption, auth);
  const authHint = doc.createElement('p');
  authHint.className = 'lightink-sync-auth-hint';
  authHint.id = 'lightink-sync-auth-hint';
  auth.setAttribute('aria-describedby', authHint.id);
  const username = field(doc, L.username, 'text');
  const password = field(doc, L.password, 'password');
  const token = field(doc, L.token, 'password');
  token.parentElement!.classList.add('lightink-sync-field--span');
  const credentialFields = doc.createElement('div');
  credentialFields.className = 'lightink-sync-credentials';
  credentialFields.append(username.parentElement!, password.parentElement!, token.parentElement!);
  const httpLabel = doc.createElement('label');
  httpLabel.className = 'lightink-sync-checkbox';
  const allowHttp = doc.createElement('input');
  allowHttp.type = 'checkbox';
  httpLabel.append(allowHttp, doc.createTextNode(L.allowHttp));
  const formActions = doc.createElement('div');
  formActions.className = 'lightink-sync-form-actions';
  const test = button(doc, L.test);
  const save = button(doc, L.save, 'primary');
  formActions.append(test, save);
  form.append(
    name.parentElement!,
    url.parentElement!,
    authLabel,
    authHint,
    credentialFields,
    httpLabel,
    formActions,
  );

  const message = doc.createElement('div');
  message.className = 'lightink-sync-message';
  message.setAttribute('role', 'status');
  message.hidden = true;
  const status = doc.createElement('div');
  status.className = 'lightink-sync-status';
  const statusMain = doc.createElement('div');
  statusMain.className = 'lightink-sync-status-main';
  const statusDot = doc.createElement('span');
  statusDot.className = 'lightink-sync-status-dot';
  statusDot.setAttribute('aria-hidden', 'true');
  const statusState = doc.createElement('span');
  statusState.className = 'lightink-sync-status-state';
  statusMain.append(statusDot, statusState);
  const metrics = doc.createElement('div');
  metrics.className = 'lightink-sync-metrics';
  const statusUploaded = doc.createElement('span');
  statusUploaded.className = 'lightink-sync-metric';
  const statusDownloaded = doc.createElement('span');
  statusDownloaded.className = 'lightink-sync-metric';
  const statusConflicts = doc.createElement('span');
  statusConflicts.className = 'lightink-sync-metric';
  const statusSkipped = doc.createElement('span');
  statusSkipped.className = 'lightink-sync-metric';
  metrics.append(statusUploaded, statusDownloaded, statusConflicts, statusSkipped);
  const statusActions = doc.createElement('div');
  statusActions.className = 'lightink-sync-status-actions';
  const sync = button(doc, L.sync, 'primary');
  const cancelSync = button(doc, L.cancelSync, 'danger');
  cancelSync.hidden = true;
  statusActions.append(sync, cancelSync);
  status.append(statusMain, metrics, statusActions);

  const conflicts = doc.createElement('div');
  conflicts.className = 'lightink-sync-conflicts';
  const migrationActions = doc.createElement('div');
  migrationActions.className = 'lightink-sync-migration-actions';
  const previewButton = button(doc, L.preview);
  const applyButton = button(doc, L.apply, 'primary');
  applyButton.disabled = true;
  migrationActions.append(previewButton, applyButton);
  const migrationList = doc.createElement('div');
  migrationList.className = 'lightink-sync-migration-list';
  const forget = button(doc, L.forget, 'danger');
  const close = button(doc, L.close, 'plain');
  const footer = doc.createElement('footer');
  footer.className = 'lightink-sync-footer lightink-modal-actions';
  footer.append(close);

  const connectionSection = section(doc, L.connection);
  connectionSection.append(form);
  const statusSection = section(doc, L.status);
  statusSection.append(status);
  const conflictsSection = section(doc, L.conflicts);
  conflictsSection.append(conflicts);
  const dangerSection = section(doc, L.dangerZone, 'lightink-sync-section--danger');
  dangerSection.append(forget);

  const body = doc.createElement('div');
  body.className = 'lightink-sync-body';
  body.append(message, connectionSection, statusSection, conflictsSection);
  if (deps.migration !== undefined) {
    const migrationSection = section(doc, L.migration);
    const migrationHead = doc.createElement('div');
    migrationHead.className = 'lightink-sync-section-head';
    const migrationTitle = migrationSection.querySelector('.lightink-sync-section-title');
    if (migrationTitle !== null) migrationHead.append(migrationTitle, migrationActions);
    else migrationHead.append(migrationActions);
    migrationSection.append(migrationHead, migrationList);
    body.append(migrationSection);
  }
  body.append(dangerSection);
  dialog.append(header, body, footer);
  const progress = doc.createElement('div');
  progress.className = 'lightink-sync-progress lightink-open-progress';
  progress.hidden = true;
  progress.setAttribute('role', 'dialog');
  progress.setAttribute('aria-modal', 'true');
  progress.setAttribute('aria-busy', 'true');
  progress.setAttribute('aria-label', L.progressTitle);
  const progressDialog = doc.createElement('div');
  progressDialog.className = 'lightink-modal-dialog lightink-sync-progress-dialog lightink-open-progress-dialog';
  const progressTitle = doc.createElement('h2');
  progressTitle.className = 'lightink-modal-title';
  progressTitle.textContent = L.progressTitle;
  const progressLabel = doc.createElement('p');
  progressLabel.className = 'lightink-modal-message lightink-sync-progress-label';
  const progressTrack = doc.createElement('div');
  progressTrack.className = 'lightink-open-progress-track';
  progressTrack.setAttribute('role', 'progressbar');
  progressTrack.setAttribute('aria-valuemin', '0');
  progressTrack.setAttribute('aria-valuemax', '100');
  const progressFill = doc.createElement('div');
  progressFill.className = 'lightink-open-progress-fill';
  progressTrack.appendChild(progressFill);
  const progressPercent = doc.createElement('p');
  progressPercent.className = 'lightink-open-progress-percent';
  const progressCancel = button(doc, L.cancelSync, 'plain');
  progressCancel.classList.add('lightink-open-progress-cancel');
  progressDialog.append(progressTitle, progressLabel, progressTrack, progressPercent, progressCancel);
  progress.appendChild(progressDialog);
  overlay.append(dialog, progress);
  applySyncPanelSurfaceTheme(overlay, deps);
  doc.body.appendChild(overlay);

  let profile: SyncProfile | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let releaseModal = (): void => overlay.remove();
  let migrationEntries: ManagedMigrationEntry[] = [];

  const closePanel = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    releaseModal();
    deps.onClose?.();
  };
  close.addEventListener('click', closePanel);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay && progress.hidden) closePanel();
  });
  const updateCredentialVisibility = (): void => {
    const isBasic = auth.value === 'basic';
    username.parentElement!.hidden = !isBasic;
    password.parentElement!.hidden = !isBasic;
    token.parentElement!.hidden = isBasic;
    authHint.textContent = isBasic ? L.authHintBasic : L.authHintBearer;
  };
  auth.addEventListener('change', updateCredentialVisibility);
  updateCredentialVisibility();

  const readInput = (): SyncProfileInput => {
    const authType = auth.value as SyncAuthType;
    let credential: SyncCredential | undefined;
    if (authType === 'basic' && (username.value !== '' || password.value !== '')) {
      credential = { kind: 'basic', username: username.value, password: password.value };
    } else if (authType === 'bearer' && token.value !== '') {
      credential = { kind: 'bearer', token: token.value };
    }
    return {
      id: profile?.id,
      name: name.value.trim(),
      url: url.value.trim(),
      authType,
      allowHttp: allowHttp.checked,
      credential,
    };
  };
  const setMessage = (text: string, kind: 'info' | 'success' | 'error' = 'info'): void => {
    message.textContent = text;
    message.hidden = text === '';
    message.dataset.kind = kind;
  };
  const renderProgress = (value: SyncStatus): void => {
    const running = value.state === 'running';
    progress.hidden = !running;
    const current = value.current ?? 0;
    const total = value.total ?? 0;
    progress.dataset.progressDeterminate = running && total > 0 ? 'true' : 'false';
    if (!running) {
      progress.style.removeProperty('--lightink-open-progress');
      return;
    }
    progressLabel.textContent = phaseCaption(locale, value, L.running);
    const skipped = value.skipped ?? 0;
    progressPercent.textContent =
      skipped > 0
        ? `↑${uploadCount(value)}  ↓${value.downloaded}  ↷${skipped}`
        : `↑${uploadCount(value)}  ↓${value.downloaded}`;
    progressPercent.hidden = false;
    if (total > 0) {
      const ratio = Math.min(1, Math.max(0, current / total));
      progress.style.setProperty('--lightink-open-progress', String(ratio));
      progressTrack.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    } else {
      progress.style.removeProperty('--lightink-open-progress');
      progressTrack.removeAttribute('aria-valuenow');
    }
  };
  const armStatusTimer = (running: boolean): void => {
    if (timer !== null) clearInterval(timer);
    timer = setInterval(() => {
      void refreshStatus();
    }, running ? 250 : 1000);
  };
  const renderStatus = (value: SyncStatus): void => {
    const running = value.state === 'running';
    status.classList.toggle('is-running', running);
    status.classList.toggle('is-error', value.state === 'error');
    if (running) {
      statusState.textContent = phaseCaption(locale, value, L.running);
    } else if (value.state === 'error') {
      statusState.textContent = value.lastError ? `${L.failed}: ${value.lastError}` : L.failed;
    } else if (value.state === 'cancelled') {
      statusState.textContent = L.cancelled;
    } else if (value.state === 'success') {
      statusState.textContent = `${L.success}${formatFinishedAt(value.finishedAt)}`;
    } else {
      statusState.textContent = L.ready;
    }
    status.title = value.lastError ?? '';
    statusUploaded.textContent = `↑${uploadCount(value)}`;
    statusDownloaded.textContent = `↓${value.downloaded}`;
    statusConflicts.textContent = `⚠${value.conflicts}`;
    statusConflicts.classList.toggle('is-warn', value.conflicts > 0);
    const skipped = value.skipped ?? 0;
    statusSkipped.textContent = `↷${skipped}`;
    statusSkipped.hidden = skipped === 0;
    statusSkipped.title = locale === 'zh-CN' ? '远程已存在，已跳过' : 'Already on remote, skipped';
    sync.disabled = running;
    cancelSync.disabled = !running;
    cancelSync.hidden = !running;
    progressCancel.disabled = !running;
    renderProgress(value);
    armStatusTimer(running);
  };
  const refreshStatus = async (): Promise<void> => {
    try {
      renderStatus(await deps.sync.status());
    } catch {
      statusState.textContent = L.failed;
      status.classList.add('is-error');
      progress.hidden = true;
    }
  };
  const watchUntilSettled = async (): Promise<SyncStatus | null> => {
    let value = await deps.sync.status().catch(() => null);
    if (value !== null) renderStatus(value);
    while (value?.state === 'running') {
      await delay(250);
      value = await deps.sync.status().catch(() => null);
      if (value !== null) renderStatus(value);
    }
    return value;
  };
  const cancelRunning = (): void => {
    cancelSync.disabled = true;
    progressCancel.disabled = true;
    void deps.sync
      .cancel()
      .then(() => refreshStatus())
      .catch(() => refreshStatus());
  };
  const renderConflicts = async (): Promise<void> => {
    conflicts.replaceChildren();
    const values = await deps.sync.listConflicts().catch(() => []);
    if (values.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-sync-empty';
      empty.textContent = L.noConflicts;
      conflicts.append(empty);
      return;
    }
    for (const conflict of values) {
      const row = doc.createElement('div');
      row.className = 'lightink-sync-conflict';
      const label = doc.createElement('span');
      label.textContent = `${conflict.objectId} · ${conflict.field}`;
      const resolve = button(doc, L.resolve);
      resolve.addEventListener('click', async () => {
        resolve.disabled = true;
        await deps.sync.resolveConflict(conflict.id).catch(() => undefined);
        await renderConflicts();
      });
      row.append(label, resolve);
      conflicts.appendChild(row);
    }
  };
  const renderMigration = (preview: ManagedMigrationPreview): void => {
    migrationEntries = [...preview.entries];
    migrationList.replaceChildren();
    for (const entry of migrationEntries) {
      const row = doc.createElement('label');
      row.className = 'lightink-sync-migration-row';
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      // A duplicate still needs an alias migration so progress, annotations,
      // and group references continue to resolve to the existing blob.
      checkbox.disabled = entry.status !== 'ready' && entry.status !== 'duplicate';
      checkbox.dataset.itemId = entry.itemId;
      checkbox.addEventListener('change', () => {
        applyButton.disabled = migrationList.querySelectorAll('input:checked').length === 0;
      });
      const text = doc.createElement('span');
      text.textContent = `${migrationLabel(entry)} · ${entry.status}`;
      row.append(checkbox, text);
      migrationList.appendChild(row);
    }
  };

  form.addEventListener('submit', (event) => event.preventDefault());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      profile = await deps.webdav.saveProfile(readInput());
      setMessage(profile.needsCredential ? L.needsCredential : L.saved, profile.needsCredential ? 'info' : 'success');
      await refreshStatus();
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
    } finally {
      save.disabled = false;
    }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const capability: WebDavCapability = await deps.webdav.testProfile(readInput());
      const missing = [
        !capability.supportsPropfind && 'PROPFIND',
        !capability.supportsMkcol && 'MKCOL',
        !capability.supportsMove && 'MOVE',
        !capability.supportsConditionalPut && 'If-None-Match',
      ].filter((value): value is string => typeof value === 'string');
      setMessage(
        missing.length === 0
          ? `${L.saved}: ${capability.finalUrl}`
          : `${L.failed}: ${L.missingCapabilities} (${missing.join(', ')})`,
        missing.length === 0 ? 'success' : 'error',
      );
      profile = await deps.webdav.getProfile();
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
    } finally {
      test.disabled = false;
    }
  });
  sync.addEventListener('click', async () => {
    sync.disabled = true;
    try {
      const current = await deps.sync.status().catch(() => null);
      if (current?.state === 'running') {
        renderStatus(current);
        await watchUntilSettled();
      } else {
        renderStatus({
          state: 'running',
          uploaded: current?.uploaded ?? 0,
          downloaded: current?.downloaded ?? 0,
          conflicts: current?.conflicts ?? 0,
          skipped: current?.skipped ?? 0,
          phase: 'connect',
        });
        const result = await (deps.syncNow !== undefined ? deps.syncNow() : deps.sync.run());
        if (result != null) renderStatus(result);
        else await refreshStatus();
      }
      await renderConflicts();
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
      await refreshStatus();
    }
  });
  cancelSync.addEventListener('click', cancelRunning);
  progressCancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelRunning();
  });
  forget.addEventListener('click', async () => {
    forget.disabled = true;
    try {
      await deps.webdav.forgetProfile();
      profile = null;
      name.value = '';
      url.value = '';
      setMessage(L.saved, 'success');
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
    } finally {
      forget.disabled = false;
    }
  });
  previewButton.addEventListener('click', async () => {
    if (deps.migration === undefined) return;
    previewButton.disabled = true;
    try {
      renderMigration(await deps.migration.preview());
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
    } finally {
      previewButton.disabled = false;
    }
  });
  applyButton.addEventListener('click', async () => {
    if (deps.migration === undefined) return;
    const ids = [...migrationList.querySelectorAll<HTMLInputElement>('input:checked')]
      .map((input) => input.dataset.itemId)
      .filter((id): id is string => id !== undefined);
    applyButton.disabled = true;
    try {
      const result = await deps.migration.apply(ids);
      setMessage(`${L.saved}: ${result.migrated}`, 'success');
      await deps.migration.preview().then(renderMigration).catch(() => undefined);
    } catch (error) {
      setMessage(`${L.failed}: ${textOf(error)}`, 'error');
    } finally {
      applyButton.disabled =
        migrationList.querySelectorAll<HTMLInputElement>('input:checked').length === 0;
    }
  });

  void deps.webdav
    .getProfile()
    .then((value) => {
      profile = value;
      if (value !== null) {
        name.value = value.name;
        url.value = value.url;
        auth.value = value.authType;
        allowHttp.checked = value.allowHttp;
        setMessage(value.needsCredential ? L.needsCredential : '');
      }
      updateCredentialVisibility();
      return Promise.all([refreshStatus(), renderConflicts()]);
    })
    .catch(() => {
      updateCredentialVisibility();
      void refreshStatus();
    });
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: name,
    onEscape: () => {
      if (!progress.hidden) {
        cancelRunning();
        return;
      }
      closePanel();
    },
  });
}
