import { labelModal, mountModalFocus } from '../ui/modal-focus.js';
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
  needsCredential: string;
  saved: string;
  failed: string;
  missingCapabilities: string;
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
    password: 'Application password',
    token: 'Token',
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
    needsCredential: 'Credentials required on this device',
    saved: 'Saved',
    failed: 'Operation failed',
    missingCapabilities: 'Server is missing required WebDAV capabilities',
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
    token: '令牌',
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
    needsCredential: '此设备需要重新输入凭据',
    saved: '已保存',
    failed: '操作失败',
    missingCapabilities: '服务器缺少同步所需的 WebDAV 能力',
  },
};

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function button(doc: Document, label: string, kind = 'plain'): HTMLButtonElement {
  const value = doc.createElement('button');
  value.type = 'button';
  value.className = `lightink-modal-btn lightink-modal-btn--${kind}`;
  value.textContent = label;
  return value;
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

/** Render the complete sync configuration/status surface. */
export function showSyncPanel(deps: SyncPanelDeps): void {
  const doc = deps.doc;
  const L = LABELS[deps.locale ?? 'zh-CN'];
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay';
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-sync-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const title = doc.createElement('div');
  title.className = 'lightink-modal-title';
  title.textContent = L.title;
  labelModal(dialog, title);

  const form = doc.createElement('form');
  form.className = 'lightink-sync-form';
  const name = field(doc, L.name, 'text');
  const url = field(doc, L.url, 'url');
  const authLabel = doc.createElement('label');
  authLabel.className = 'lightink-sync-field';
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
  const username = field(doc, L.username, 'text');
  const password = field(doc, L.password, 'password');
  const token = field(doc, L.token, 'password');
  const credentialFields = doc.createElement('div');
  credentialFields.className = 'lightink-sync-credentials';
  credentialFields.append(username.parentElement!, password.parentElement!, token.parentElement!);
  const httpLabel = doc.createElement('label');
  httpLabel.className = 'lightink-sync-checkbox';
  const allowHttp = doc.createElement('input');
  allowHttp.type = 'checkbox';
  httpLabel.append(allowHttp, doc.createTextNode(L.allowHttp));
  form.append(name.parentElement!, url.parentElement!, authLabel, credentialFields, httpLabel);

  const message = doc.createElement('div');
  message.className = 'lightink-sync-message';
  message.setAttribute('role', 'status');
  const status = doc.createElement('div');
  status.className = 'lightink-sync-status';
  const actions = doc.createElement('div');
  actions.className = 'lightink-modal-actions';
  const test = button(doc, L.test);
  const save = button(doc, L.save, 'primary');
  const sync = button(doc, L.sync, 'primary');
  const cancelSync = button(doc, L.cancelSync, 'danger');
  const forget = button(doc, L.forget, 'plain');
  const close = button(doc, L.close, 'plain');
  actions.append(test, save, sync, cancelSync, forget, close);

  const conflictsHeading = doc.createElement('h3');
  conflictsHeading.textContent = L.conflicts;
  const conflicts = doc.createElement('div');
  conflicts.className = 'lightink-sync-conflicts';
  const migrationHeading = doc.createElement('h3');
  migrationHeading.textContent = L.migration;
  const migrationActions = doc.createElement('div');
  migrationActions.className = 'lightink-sync-migration-actions';
  const previewButton = button(doc, L.preview);
  const applyButton = button(doc, L.apply, 'primary');
  applyButton.disabled = true;
  migrationActions.append(previewButton, applyButton);
  const migrationList = doc.createElement('div');
  migrationList.className = 'lightink-sync-migration-list';
  dialog.append(title, form, message, status, conflictsHeading, conflicts);
  if (deps.migration !== undefined) dialog.append(migrationHeading, migrationActions, migrationList);
  dialog.append(actions);
  overlay.appendChild(dialog);
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
    if (event.target === overlay) closePanel();
  });
  const updateCredentialVisibility = (): void => {
    username.parentElement!.hidden = auth.value !== 'basic';
    password.parentElement!.hidden = auth.value !== 'basic';
    token.parentElement!.hidden = auth.value !== 'bearer';
  };
  auth.addEventListener('change', updateCredentialVisibility);

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
  const renderStatus = (value: SyncStatus): void => {
    status.textContent = `${L.status}: ${value.state === 'running' ? L.running : L.ready} · ↑${value.uploaded} ↓${value.downloaded} ⚠${value.conflicts}`;
    cancelSync.disabled = value.state !== 'running';
  };
  const refreshStatus = async (): Promise<void> => {
    try {
      renderStatus(await deps.sync.status());
    } catch {
      status.textContent = L.failed;
    }
  };
  const renderConflicts = async (): Promise<void> => {
    conflicts.replaceChildren();
    const values = await deps.sync.listConflicts().catch(() => []);
    if (values.length === 0) {
      conflicts.textContent = L.noConflicts;
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
      message.textContent = profile.needsCredential ? L.needsCredential : L.saved;
      await refreshStatus();
    } catch (error) {
      message.textContent = `${L.failed}: ${textOf(error)}`;
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
      message.textContent =
        missing.length === 0
          ? `${L.saved}: ${capability.finalUrl}`
          : `${L.failed}: ${L.missingCapabilities} (${missing.join(', ')})`;
      profile = await deps.webdav.getProfile();
    } catch (error) {
      message.textContent = `${L.failed}: ${textOf(error)}`;
    } finally {
      test.disabled = false;
    }
  });
  sync.addEventListener('click', async () => {
    sync.disabled = true;
    try {
      const result = deps.syncNow !== undefined ? await deps.syncNow() : await deps.sync.run();
      if (result !== null) renderStatus(result);
      await renderConflicts();
    } catch (error) {
      message.textContent = `${L.failed}: ${textOf(error)}`;
      await refreshStatus();
    } finally {
      sync.disabled = false;
    }
  });
  cancelSync.addEventListener('click', () => {
    void deps.sync.cancel().catch(() => undefined);
  });
  forget.addEventListener('click', async () => {
    forget.disabled = true;
    try {
      await deps.webdav.forgetProfile();
      profile = null;
      name.value = '';
      url.value = '';
      message.textContent = L.saved;
    } catch (error) {
      message.textContent = `${L.failed}: ${textOf(error)}`;
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
      message.textContent = `${L.failed}: ${textOf(error)}`;
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
      message.textContent = `${L.saved}: ${result.migrated}`;
      await deps.migration.preview().then(renderMigration).catch(() => undefined);
    } catch (error) {
      message.textContent = `${L.failed}: ${textOf(error)}`;
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
        message.textContent = value.needsCredential ? L.needsCredential : '';
      }
      updateCredentialVisibility();
      return Promise.all([refreshStatus(), renderConflicts()]);
    })
    .catch(() => updateCredentialVisibility());
  timer = setInterval(() => {
    void refreshStatus();
  }, 1000);
  releaseModal = mountModalFocus(doc, overlay, dialog, {
    initialFocus: name,
    onEscape: closePanel,
  });
}
