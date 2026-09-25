import type {
  BookSource,
  BookSourceBuiltin,
  BookSourceCheck,
  BookSourceInput,
  BookSourceIssue,
  BookSourceSearchResult,
} from './book-source-client.js';

export type BookSourceLocale = 'en' | 'zh-CN';

export interface BookSourcePanelClient {
  listSources(): Promise<BookSource[]>;
  upsertSource(input: BookSourceInput): Promise<BookSource>;
  removeSource(sourceId: string): Promise<void>;
  setSourceEnabled(sourceId: string, enabled: boolean): Promise<BookSource>;
  importSources(json: string): Promise<BookSource[]>;
  exportSources(sourceIds?: readonly string[]): Promise<string>;
  selfCheck(rule: unknown, allowHttp: boolean): Promise<BookSourceCheck>;
  builtins(): Promise<BookSourceBuiltin[]>;
  search(sourceId: string, query: string): Promise<BookSourceSearchResult[]>;
}

export interface BookSourcePanelOptions {
  readonly client: BookSourcePanelClient;
  readonly getLocale: () => BookSourceLocale;
  readonly doc?: Document;
}

export interface BookSourcePanel {
  readonly element: HTMLElement;
  readonly visible: boolean;
  show(): Promise<void>;
  hide(): void;
  retranslate(): void;
  destroy(): void;
}

interface BookSourcePanelLabels {
  title: string;
  add: string;
  import: string;
  export: string;
  close: string;
  mySources: string;
  builtins: string;
  empty: string;
  enable: string;
  edit: string;
  remove: string;
  check: string;
  search: string;
  searchPlaceholder: string;
  searching: string;
  results: string;
  noResults: string;
  save: string;
  cancel: string;
  titleField: string;
  titleRequired: string;
  allowHttp: string;
  ruleField: string;
  checkOk: string;
  checkFailed: string;
  importTitle: string;
  importHint: string;
  exportTitle: string;
  exportHint: string;
  editorNew: string;
  editorEdit: string;
  addBuiltin: string;
  hint: string;
  loadFailed: string;
  invalidJson: string;
  ruleObject: string;
  removed: string;
  saved: string;
  imported: string;
  builtinAdded: string;
  duplicate: string;
}

const LABELS: Record<BookSourceLocale, BookSourcePanelLabels> = {
  en: {
    title: 'Book sources',
    add: 'New source',
    import: 'Import',
    export: 'Export',
    close: 'Close',
    mySources: 'Added sources',
    builtins: 'Built-in examples',
    empty: 'No book sources yet.',
    enable: 'Enabled',
    edit: 'Edit',
    remove: 'Delete',
    check: 'Check',
    search: 'Search',
    searchPlaceholder: 'Keyword',
    searching: 'Searching…',
    results: 'Search results',
    noResults: 'No results.',
    save: 'Save',
    cancel: 'Cancel',
    titleField: 'Name',
    titleRequired: 'Name is required',
    allowHttp: 'Allow HTTP',
    ruleField: 'Rule (JSON)',
    checkOk: 'Rule check passed.',
    checkFailed: 'Rule check failed.',
    importTitle: 'Import book sources',
    importHint: 'Paste exported JSON (object or array).',
    exportTitle: 'Exported book sources',
    exportHint: 'Copy the JSON to back up or share.',
    editorNew: 'New book source',
    editorEdit: 'Edit book source',
    addBuiltin: 'Add',
    hint: 'Select a source to edit, check or search.',
    loadFailed: 'Failed to load book sources',
    invalidJson: 'Invalid JSON',
    ruleObject: 'Rule must be a JSON object',
    removed: 'Book source deleted',
    saved: 'Book source saved',
    imported: 'Book sources imported',
    builtinAdded: 'Built-in example added',
    duplicate: 'This built-in example is already added',
  },
  'zh-CN': {
    title: '书源',
    add: '新建书源',
    import: '导入',
    export: '导出',
    close: '关闭',
    mySources: '已添加',
    builtins: '内置示例',
    empty: '还没有书源。',
    enable: '启用',
    edit: '编辑',
    remove: '删除',
    check: '自检',
    search: '搜索',
    searchPlaceholder: '关键词',
    searching: '搜索中…',
    results: '搜索结果',
    noResults: '没有结果。',
    save: '保存',
    cancel: '取消',
    titleField: '名称',
    titleRequired: '名称不能为空',
    allowHttp: '允许 HTTP',
    ruleField: '规则（JSON）',
    checkOk: '规则自检通过。',
    checkFailed: '规则自检未通过。',
    importTitle: '导入书源',
    importHint: '粘贴导出的 JSON（对象或数组）。',
    exportTitle: '已导出书源',
    exportHint: '复制 JSON 以备份或分享。',
    editorNew: '新建书源',
    editorEdit: '编辑书源',
    addBuiltin: '添加',
    hint: '选择一个书源进行编辑、自检或搜索。',
    loadFailed: '无法加载书源',
    invalidJson: 'JSON 无效',
    ruleObject: '规则必须是 JSON 对象',
    removed: '已删除书源',
    saved: '已保存书源',
    imported: '已导入书源',
    builtinAdded: '已添加内置书源',
    duplicate: '该内置书源已添加',
  },
};

const NEW_RULE_TEMPLATE = {
  version: 1,
  baseUrl: 'https://example.com',
  search: {
    url: '/search?q={{key}}',
    item: '<li class="result">(?s)(.*?)</li>',
    title: '<a[^>]*>(?s)(.*?)</a>',
    link: 'href="([^"]+)"',
  },
} as const;

type PanelMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'edit'; readonly sourceId?: string }
  | { readonly kind: 'import' }
  | { readonly kind: 'export'; readonly text: string }
  | { readonly kind: 'search'; readonly sourceId: string };

interface ParsedRule {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
}

function parseRule(text: string, l: BookSourcePanelLabels): ParsedRule {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `${l.invalidJson}: ${errorText(error, '')}`.trim() };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: l.ruleObject };
  }
  return { ok: true, value };
}

function errorText(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

function createButton(doc: Document, text: string, className = ''): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = text;
  return element;
}

function createLabeledField(
  doc: Document,
  caption: string,
  field: HTMLElement,
  className = 'lightink-library-field',
): { readonly wrap: HTMLLabelElement; readonly caption: HTMLSpanElement } {
  const wrap = doc.createElement('label');
  wrap.className = className;
  const captionEl = doc.createElement('span');
  captionEl.textContent = caption;
  wrap.append(captionEl, field);
  return { wrap, caption: captionEl };
}

function sourceHost(source: BookSource): string {
  try {
    return new URL(source.rule.baseUrl).host;
  } catch {
    return source.rule.baseUrl;
  }
}

/**
 * 书源管理面板（R7）：列表 + 编辑/导入/导出/自检/搜索。面板只做编排与展示，
 * 规则校验与网络访问由 Rust 命令负责；自检问题带字段名就地展示。
 */
export function createBookSourcePanel(options: BookSourcePanelOptions): BookSourcePanel {
  const doc = options.doc ?? document;
  const overlay = doc.createElement('div');
  overlay.className = 'lightink-modal-overlay lightink-library-book-sources';
  overlay.hidden = true;
  const dialog = doc.createElement('div');
  dialog.className = 'lightink-modal-dialog lightink-library-book-sources-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const header = doc.createElement('div');
  header.className = 'lightink-library-book-sources-header';
  const titleEl = doc.createElement('h2');
  const closeButton = createButton(doc, '×', 'lightink-library-icon-button');
  header.append(titleEl, closeButton);

  const toolbar = doc.createElement('div');
  toolbar.className = 'lightink-library-book-sources-toolbar';
  const addButton = createButton(doc, '');
  const importButton = createButton(doc, '');
  const exportButton = createButton(doc, '');
  toolbar.append(addButton, importButton, exportButton);

  const statusEl = doc.createElement('p');
  statusEl.className = 'lightink-library-book-sources-status';
  statusEl.setAttribute('role', 'status');
  statusEl.hidden = true;

  const body = doc.createElement('div');
  body.className = 'lightink-library-book-sources-body';
  const listPane = doc.createElement('div');
  listPane.className = 'lightink-library-book-sources-list';
  const sourcesHeading = doc.createElement('h3');
  const sourceList = doc.createElement('div');
  sourceList.className = 'lightink-library-book-sources-rows';
  const builtinsHeading = doc.createElement('h3');
  const builtinList = doc.createElement('div');
  builtinList.className = 'lightink-library-book-sources-builtins';
  listPane.append(sourcesHeading, sourceList, builtinsHeading, builtinList);

  const detailPane = doc.createElement('div');
  detailPane.className = 'lightink-library-book-sources-detail';
  const hint = doc.createElement('p');
  hint.className = 'lightink-library-book-sources-hint';

  const editor = doc.createElement('section');
  editor.className = 'lightink-library-book-source-editor';
  editor.hidden = true;
  const editorTitle = doc.createElement('h3');
  const editorName = doc.createElement('input');
  editorName.name = 'sourceName';
  editorName.maxLength = 120;
  const editorNameField = createLabeledField(doc, '', editorName);
  const editorAllowHttp = doc.createElement('input');
  editorAllowHttp.type = 'checkbox';
  editorAllowHttp.name = 'allowHttp';
  const editorAllowLabel = doc.createElement('label');
  editorAllowLabel.className = 'lightink-library-book-source-allow';
  const editorAllowCaption = doc.createElement('span');
  editorAllowLabel.append(editorAllowHttp, editorAllowCaption);
  const editorRule = doc.createElement('textarea');
  editorRule.name = 'rule';
  editorRule.rows = 14;
  editorRule.spellcheck = false;
  const editorRuleField = createLabeledField(doc, '', editorRule);
  const editorStatus = doc.createElement('p');
  editorStatus.className = 'lightink-library-book-source-editor-status';
  editorStatus.setAttribute('role', 'status');
  editorStatus.hidden = true;
  const editorIssues = doc.createElement('ul');
  editorIssues.className = 'lightink-library-book-source-issues';
  editorIssues.hidden = true;
  const editorActions = doc.createElement('div');
  editorActions.className = 'lightink-library-book-source-actions';
  const editorCheck = createButton(doc, '');
  const editorSave = createButton(doc, '', 'lightink-library-primary');
  const editorCancel = createButton(doc, '');
  editorActions.append(editorCheck, editorSave, editorCancel);
  editor.append(
    editorTitle,
    editorNameField.wrap,
    editorAllowLabel,
    editorRuleField.wrap,
    editorStatus,
    editorIssues,
    editorActions,
  );

  const importSection = doc.createElement('section');
  importSection.className = 'lightink-library-book-source-import';
  importSection.hidden = true;
  const importTitle = doc.createElement('h3');
  const importHint = doc.createElement('p');
  const importText = doc.createElement('textarea');
  importText.rows = 12;
  importText.spellcheck = false;
  const importStatus = doc.createElement('p');
  importStatus.className = 'lightink-library-book-source-editor-status';
  importStatus.setAttribute('role', 'status');
  importStatus.hidden = true;
  const importActions = doc.createElement('div');
  importActions.className = 'lightink-library-book-source-actions';
  const importRun = createButton(doc, '', 'lightink-library-primary');
  const importCancel = createButton(doc, '');
  importActions.append(importRun, importCancel);
  importSection.append(importTitle, importHint, importText, importStatus, importActions);

  const exportSection = doc.createElement('section');
  exportSection.className = 'lightink-library-book-source-export';
  exportSection.hidden = true;
  const exportTitle = doc.createElement('h3');
  const exportHint = doc.createElement('p');
  const exportText = doc.createElement('textarea');
  exportText.rows = 12;
  exportText.readOnly = true;
  const exportActions = doc.createElement('div');
  exportActions.className = 'lightink-library-book-source-actions';
  const exportClose = createButton(doc, '');
  exportActions.append(exportClose);
  exportSection.append(exportTitle, exportHint, exportText, exportActions);

  const searchSection = doc.createElement('section');
  searchSection.className = 'lightink-library-book-source-search';
  searchSection.hidden = true;
  const searchTitle = doc.createElement('h3');
  const searchRow = doc.createElement('div');
  searchRow.className = 'lightink-library-book-source-search-row';
  const searchInput = doc.createElement('input');
  searchInput.name = 'query';
  searchInput.type = 'search';
  const searchRun = createButton(doc, '', 'lightink-library-primary');
  searchRow.append(searchInput, searchRun);
  const searchStatus = doc.createElement('p');
  searchStatus.className = 'lightink-library-book-source-editor-status';
  searchStatus.setAttribute('role', 'status');
  searchStatus.hidden = true;
  const searchResults = doc.createElement('div');
  searchResults.className = 'lightink-library-book-source-results';
  const searchActions = doc.createElement('div');
  searchActions.className = 'lightink-library-book-source-actions';
  const searchClose = createButton(doc, '');
  searchActions.append(searchClose);
  searchSection.append(searchTitle, searchRow, searchStatus, searchResults, searchActions);

  detailPane.append(hint, editor, importSection, exportSection, searchSection);
  body.append(listPane, detailPane);
  dialog.append(header, toolbar, statusEl, body);
  overlay.appendChild(dialog);

  let sources: BookSource[] = [];
  let builtins: BookSourceBuiltin[] = [];
  let mode: PanelMode = { kind: 'idle' };
  let editingSourceId: string | undefined;

  const labels = (): BookSourcePanelLabels => LABELS[options.getLocale()] ?? LABELS.en;

  function setStatus(message: string, kind: 'error' | 'success' | '' = ''): void {
    statusEl.textContent = message;
    statusEl.hidden = message === '';
    if (kind === '') delete statusEl.dataset.status;
    else statusEl.dataset.status = kind;
  }

  function renderIssues(issues: readonly BookSourceIssue[]): void {
    editorIssues.replaceChildren();
    if (issues.length === 0) {
      editorIssues.hidden = true;
      return;
    }
    for (const issue of issues) {
      const item = doc.createElement('li');
      item.dataset.field = issue.field;
      const field = doc.createElement('code');
      field.textContent = issue.field;
      const message = doc.createElement('span');
      message.textContent = issue.message;
      item.append(field, message);
      editorIssues.appendChild(item);
    }
    editorIssues.hidden = false;
  }

  function renderList(): void {
    const l = labels();
    sourceList.replaceChildren();
    if (sources.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'lightink-library-book-sources-empty';
      empty.textContent = l.empty;
      sourceList.appendChild(empty);
      return;
    }
    for (const source of sources) {
      const row = doc.createElement('div');
      row.className = 'lightink-library-book-source-row';
      row.dataset.sourceId = source.id;
      const toggleLabel = doc.createElement('label');
      toggleLabel.className = 'lightink-library-book-source-toggle';
      const toggle = doc.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = source.enabled;
      toggle.setAttribute('aria-label', `${l.enable}: ${source.title}`);
      toggle.addEventListener('change', () => void toggleEnabled(source, toggle.checked));
      const toggleCaption = doc.createElement('span');
      toggleCaption.textContent = l.enable;
      toggleLabel.append(toggle, toggleCaption);
      const name = doc.createElement('button');
      name.type = 'button';
      name.className = 'lightink-library-book-source-name';
      name.textContent = source.title;
      name.addEventListener('click', () => openEditor(source));
      const host = doc.createElement('span');
      host.className = 'lightink-library-book-source-host';
      host.textContent = sourceHost(source);
      const actions = doc.createElement('div');
      actions.className = 'lightink-library-book-source-row-actions';
      const edit = createButton(doc, l.edit);
      edit.addEventListener('click', () => openEditor(source));
      const check = createButton(doc, l.check);
      check.addEventListener('click', () => void quickCheck(source));
      const search = createButton(doc, l.search);
      search.addEventListener('click', () => openSearch(source));
      const remove = createButton(doc, l.remove, 'lightink-library-danger');
      remove.addEventListener('click', () => void removeSource(source));
      actions.append(edit, check, search, remove);
      row.append(toggleLabel, name, host, actions);
      sourceList.appendChild(row);
    }
  }

  function renderBuiltins(): void {
    const l = labels();
    builtinList.replaceChildren();
    for (const builtin of builtins) {
      const row = doc.createElement('div');
      row.className = 'lightink-library-book-source-builtin';
      row.dataset.builtinId = builtin.id;
      const info = doc.createElement('div');
      const name = doc.createElement('strong');
      name.textContent = builtin.title;
      const host = doc.createElement('span');
      host.textContent = `${builtin.url} · ${builtin.license}`;
      info.append(name, host);
      const add = createButton(doc, l.addBuiltin);
      add.addEventListener('click', () => void addBuiltin(builtin));
      row.append(info, add);
      builtinList.appendChild(row);
    }
  }

  function renderDetail(): void {
    const l = labels();
    hint.hidden = mode.kind !== 'idle';
    hint.textContent = l.hint;
    editor.hidden = mode.kind !== 'edit';
    importSection.hidden = mode.kind !== 'import';
    exportSection.hidden = mode.kind !== 'export';
    searchSection.hidden = mode.kind !== 'search';
    if (mode.kind === 'edit') {
      editorTitle.textContent = mode.sourceId === undefined ? l.editorNew : l.editorEdit;
    }
    if (mode.kind === 'search') {
      const searchSourceId = mode.sourceId;
      const source = sources.find((candidate) => candidate.id === searchSourceId);
      searchTitle.textContent = `${l.results}: ${source?.title ?? ''}`.trim();
    }
  }

  function applyLabels(): void {
    const l = labels();
    titleEl.textContent = l.title;
    closeButton.title = l.close;
    closeButton.setAttribute('aria-label', l.close);
    dialog.setAttribute('aria-label', l.title);
    addButton.textContent = l.add;
    importButton.textContent = l.import;
    exportButton.textContent = l.export;
    sourcesHeading.textContent = l.mySources;
    builtinsHeading.textContent = l.builtins;
    editorNameField.caption.textContent = l.titleField;
    editorName.name = 'sourceName';
    editorName.placeholder = l.titleField;
    editorAllowCaption.textContent = l.allowHttp;
    editorRuleField.caption.textContent = l.ruleField;
    editorCheck.textContent = l.check;
    editorSave.textContent = l.save;
    editorCancel.textContent = l.cancel;
    importTitle.textContent = l.importTitle;
    importHint.textContent = l.importHint;
    importRun.textContent = l.import;
    importCancel.textContent = l.cancel;
    exportTitle.textContent = l.exportTitle;
    exportHint.textContent = l.exportHint;
    exportClose.textContent = l.close;
    searchRun.textContent = l.search;
    searchInput.placeholder = l.searchPlaceholder;
    searchInput.setAttribute('aria-label', l.searchPlaceholder);
    searchClose.textContent = l.close;
    renderList();
    renderBuiltins();
    renderDetail();
  }

  async function refresh(): Promise<void> {
    try {
      const [loadedSources, loadedBuiltins] = await Promise.all([
        options.client.listSources(),
        options.client.builtins(),
      ]);
      sources = loadedSources;
      builtins = loadedBuiltins;
    } catch (error) {
      setStatus(errorText(error, labels().loadFailed), 'error');
    }
    renderList();
    renderBuiltins();
    renderDetail();
  }

  function openEditor(source?: BookSource): void {
    editingSourceId = source?.id;
    editorName.value = source?.title ?? '';
    editorAllowHttp.checked = source?.allowHttp ?? false;
    editorRule.value =
      source === undefined ? JSON.stringify(NEW_RULE_TEMPLATE, null, 2) : JSON.stringify(source.rule, null, 2);
    editorStatus.hidden = true;
    editorStatus.textContent = '';
    delete editorStatus.dataset.status;
    renderIssues([]);
    mode = { kind: 'edit', sourceId: source?.id };
    renderDetail();
    editorName.focus();
  }

  function openImport(): void {
    importText.value = '';
    importStatus.hidden = true;
    importStatus.textContent = '';
    mode = { kind: 'import' };
    renderDetail();
    importText.focus();
  }

  async function openExport(): Promise<void> {
    try {
      const text = await options.client.exportSources();
      mode = { kind: 'export', text };
      renderDetail();
      exportText.value = text;
      exportText.focus();
      exportText.select();
    } catch (error) {
      setStatus(errorText(error, labels().loadFailed), 'error');
    }
  }

  function openSearch(source: BookSource): void {
    mode = { kind: 'search', sourceId: source.id };
    searchInput.value = '';
    searchStatus.hidden = true;
    searchStatus.textContent = '';
    searchResults.replaceChildren();
    renderDetail();
    searchInput.focus();
  }

  async function toggleEnabled(source: BookSource, enabled: boolean): Promise<void> {
    try {
      const updated = await options.client.setSourceEnabled(source.id, enabled);
      sources = sources.map((candidate) => (candidate.id === updated.id ? updated : candidate));
    } catch (error) {
      setStatus(errorText(error, labels().loadFailed), 'error');
    }
    renderList();
  }

  async function removeSource(source: BookSource): Promise<void> {
    try {
      await options.client.removeSource(source.id);
      sources = sources.filter((candidate) => candidate.id !== source.id);
      if (mode.kind === 'search' && mode.sourceId === source.id) mode = { kind: 'idle' };
      if (mode.kind === 'edit' && mode.sourceId === source.id) mode = { kind: 'idle' };
      setStatus(labels().removed, 'success');
    } catch (error) {
      setStatus(errorText(error, labels().loadFailed), 'error');
    }
    renderList();
    renderDetail();
  }

  function editorRuleValue(): ParsedRule {
    return parseRule(editorRule.value, labels());
  }

  async function checkEditor(): Promise<void> {
    const l = labels();
    const parsed = editorRuleValue();
    if (!parsed.ok) {
      renderIssues([{ field: 'rule', message: parsed.message ?? l.invalidJson }]);
      editorStatus.textContent = l.checkFailed;
      editorStatus.dataset.status = 'error';
      editorStatus.hidden = false;
      return;
    }
    try {
      const check = await options.client.selfCheck(parsed.value, editorAllowHttp.checked);
      renderIssues(check.issues);
      editorStatus.textContent = check.ok ? l.checkOk : l.checkFailed;
      editorStatus.dataset.status = check.ok ? 'success' : 'error';
      editorStatus.hidden = false;
    } catch (error) {
      renderIssues([{ field: 'rule', message: errorText(error, l.loadFailed) }]);
      editorStatus.textContent = l.checkFailed;
      editorStatus.dataset.status = 'error';
      editorStatus.hidden = false;
    }
  }

  async function saveEditor(): Promise<void> {
    const l = labels();
    if (editorName.value.trim() === '') {
      renderIssues([{ field: 'title', message: l.titleRequired }]);
      return;
    }
    const parsed = editorRuleValue();
    if (!parsed.ok) {
      renderIssues([{ field: 'rule', message: parsed.message ?? l.invalidJson }]);
      return;
    }
    try {
      const check = await options.client.selfCheck(parsed.value, editorAllowHttp.checked);
      if (!check.ok) {
        renderIssues(check.issues);
        editorStatus.textContent = l.checkFailed;
        editorStatus.dataset.status = 'error';
        editorStatus.hidden = false;
        return;
      }
      await options.client.upsertSource({
        id: editingSourceId,
        title: editorName.value,
        allowHttp: editorAllowHttp.checked,
        rule: parsed.value,
      });
      await refresh();
      mode = { kind: 'idle' };
      renderDetail();
      setStatus(l.saved, 'success');
    } catch (error) {
      renderIssues([{ field: 'rule', message: errorText(error, l.loadFailed) }]);
      editorStatus.textContent = l.checkFailed;
      editorStatus.dataset.status = 'error';
      editorStatus.hidden = false;
    }
  }

  async function quickCheck(source: BookSource): Promise<void> {
    try {
      const check = await options.client.selfCheck(source.rule, source.allowHttp);
      if (check.ok) {
        setStatus(`${labels().checkOk} ${source.title}`, 'success');
        return;
      }
      const first = check.issues[0];
      setStatus(`${labels().checkFailed} ${first?.field ?? ''}: ${first?.message ?? ''}`, 'error');
    } catch (error) {
      setStatus(errorText(error, labels().loadFailed), 'error');
    }
  }

  async function runImport(): Promise<void> {
    const l = labels();
    try {
      await options.client.importSources(importText.value);
      await refresh();
      mode = { kind: 'idle' };
      renderDetail();
      setStatus(l.imported, 'success');
    } catch (error) {
      importStatus.textContent = errorText(error, l.loadFailed);
      importStatus.dataset.status = 'error';
      importStatus.hidden = false;
    }
  }

  async function addBuiltin(builtin: BookSourceBuiltin): Promise<void> {
    const l = labels();
    if (sources.some((source) => source.rule.baseUrl === builtin.url && source.title === builtin.title)) {
      setStatus(l.duplicate, '');
      return;
    }
    try {
      await options.client.upsertSource({ title: builtin.title, allowHttp: false, rule: builtin.rule });
      await refresh();
      setStatus(l.builtinAdded, 'success');
    } catch (error) {
      setStatus(errorText(error, l.loadFailed), 'error');
    }
  }

  async function runSearch(): Promise<void> {
    const l = labels();
    if (mode.kind !== 'search') return;
    const searchSourceId = mode.sourceId;
    const query = searchInput.value.trim();
    if (query === '') return;
    searchStatus.textContent = l.searching;
    searchStatus.dataset.status = '';
    searchStatus.hidden = false;
    searchResults.replaceChildren();
    try {
      const results = await options.client.search(searchSourceId, query);
      if (mode.kind !== 'search' || mode.sourceId !== searchSourceId) return;
      searchStatus.hidden = true;
      if (results.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'lightink-library-book-sources-empty';
        empty.textContent = l.noResults;
        searchResults.appendChild(empty);
        return;
      }
      for (const result of results) {
        const row = doc.createElement('div');
        row.className = 'lightink-library-book-source-result';
        row.dataset.sourceId = result.sourceId;
        const name = doc.createElement('strong');
        name.textContent = result.title;
        const author = doc.createElement('span');
        author.textContent = result.author ?? '';
        const source = doc.createElement('span');
        source.className = 'lightink-library-book-source-result-source';
        source.textContent = result.sourceTitle;
        const url = doc.createElement('code');
        url.textContent = result.url;
        row.append(name, author, source, url);
        searchResults.appendChild(row);
      }
    } catch (error) {
      if (mode.kind !== 'search' || mode.sourceId !== searchSourceId) return;
      searchStatus.textContent = errorText(error, l.loadFailed);
      searchStatus.dataset.status = 'error';
      searchStatus.hidden = false;
    }
  }

  addButton.addEventListener('click', () => openEditor());
  importButton.addEventListener('click', () => openImport());
  exportButton.addEventListener('click', () => void openExport());
  closeButton.addEventListener('click', () => hide());
  editorCheck.addEventListener('click', () => void checkEditor());
  editorSave.addEventListener('click', () => void saveEditor());
  editorCancel.addEventListener('click', () => {
    mode = { kind: 'idle' };
    renderDetail();
  });
  importRun.addEventListener('click', () => void runImport());
  importCancel.addEventListener('click', () => {
    mode = { kind: 'idle' };
    renderDetail();
  });
  exportClose.addEventListener('click', () => {
    mode = { kind: 'idle' };
    renderDetail();
  });
  searchRun.addEventListener('click', () => void runSearch());
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void runSearch();
  });
  searchClose.addEventListener('click', () => {
    mode = { kind: 'idle' };
    renderDetail();
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) hide();
  });

  applyLabels();

  function show(): Promise<void> {
    overlay.hidden = false;
    mode = { kind: 'idle' };
    setStatus('');
    renderDetail();
    return refresh();
  }

  function hide(): void {
    overlay.hidden = true;
  }

  return {
    element: overlay,
    get visible() {
      return !overlay.hidden;
    },
    show,
    hide,
    retranslate: applyLabels,
    destroy() {
      overlay.remove();
    },
  };
}
