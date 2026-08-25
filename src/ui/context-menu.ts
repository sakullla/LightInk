/**
 * `context-menu` — 右键上下文菜单组件（R3）。纯 DOM 渲染 + 结构化事件，可 headless 测试。
 *
 * 两类菜单（共享同一渲染器）：
 *   - 编辑区：剪切/复制/粘贴/粘贴为纯文本 + 加粗/斜体/链接 + 链接的打开/复制地址；
 *     项的启用由上下文（是否有选区、是否在链接上）决定。
 *   - 标签页：关闭/关闭其他/复制文件路径/在文件管理器中显示；
 *     复制路径/显示位置由是否有文件路径决定。
 *
 * 纯逻辑 `buildEditorContextMenuItems` / `buildTabContextMenuItems`（按上下文决定 enabled）
 * headless 可测；`createContextMenu`（在 (x,y) 浮层渲染、外部 pointerdown/Esc 关闭）属
 * 挂载态 DOM（同 menus.ts）。
 */

import type { MessageKey } from '../i18n/messages.js';

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  action(): void;
  /** 返回 false 时禁用。 */
  enabled?: () => boolean;
  /** 为 true 时渲染为分隔线，忽略其余字段。 */
  separator?: boolean;
}

export interface ContextMenuHandle {
  readonly element: HTMLDivElement;
  close(): void;
}

export interface ContextMenuOptions {
  /** Called once when the menu is closed (item click, outside pointer, Esc, or close()). */
  onClose?: () => void;
}

/**
 * Phone long-press already shows the format toolbar (bold/note/copy).
 * A second editor menu covers the page; keep the native event cancelled
 * but do not open this menu on Android / touch-primary.
 */
export function allowEditorContextMenu(
  root: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null,
): boolean {
  if (root === null) {
    return true;
  }
  return !root.hasAttribute('data-android') && !root.hasAttribute('data-touch-primary');
}

/** 在 (x,y) 处渲染一个浮动上下文菜单；外部 pointerdown / Esc / 滚动关闭。 */
export function createContextMenu(
  items: MenuItem[],
  position: { x: number; y: number },
  doc: Document = document,
  options: ContextMenuOptions = {},
): ContextMenuHandle {
  const element = doc.createElement('div');
  element.className = 'lightink-context-menu';
  element.setAttribute('role', 'menu');
  element.style.position = 'fixed';
  element.style.left = `${position.x}px`;
  element.style.top = `${position.y}px`;
  element.style.zIndex = '2000';
  let closed = false;

  for (const item of items) {
    if (item.separator === true) {
      const sep = doc.createElement('hr');
      sep.className = 'lightink-context-menu__separator';
      element.appendChild(sep);
      continue;
    }
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'lightink-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.shortcut !== undefined && item.shortcut !== '') {
      const hint = doc.createElement('span');
      hint.className = 'lightink-context-menu__shortcut';
      hint.textContent = item.shortcut;
      btn.appendChild(hint);
    }
    const isEnabled = item.enabled ? item.enabled() : true;
    btn.disabled = !isEnabled;
    if (isEnabled) {
      btn.addEventListener('click', () => {
        item.action();
        close();
      });
    }
    element.appendChild(btn);
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    element.remove();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    options.onClose?.();
  };

  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.body.appendChild(element);
  // 右键点在视口边缘时把菜单拉回视口内。
  const rect = element.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    element.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    element.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
  }

  return { element, close };
}

// ---------------------------------------------------------------------------
// 编辑区上下文菜单（纯逻辑：按上下文决定 enabled）
// ---------------------------------------------------------------------------

export interface EditorMenuContext {
  /** 是否有非空文本选区。 */
  hasSelection: boolean;
  /** 光标是否在链接上。 */
  hasLink: boolean;
  /** 是否处于源码模式（格式/链接项对源码 textarea 无意义，只保留剪贴板项）。 */
  inSourceMode?: boolean;
  /** 光标是否在表格内（展示行列操作）。 */
  inTable?: boolean;
  /** Translate UI string (en / zh-CN). Optional for tests. */
  t?: (key: MessageKey) => string;
  /** Format shortcut for current OS. Optional for tests. */
  formatShortcut?: (combo: string) => string;
}

export interface EditorMenuActions {
  cut(): void;
  copy(): void;
  paste(): void;
  pastePlain(): void;
  /** T6/R10：全选当前文档（双模式）。 */
  selectAll(): void;
  bold(): void;
  italic(): void;
  link(): void;
  openLink(): void;
  copyLinkAddress(): void;
  /** Optional table structure actions (only when inTable). */
  insertColLeft?(): void;
  insertColRight?(): void;
  insertRowAbove?(): void;
  insertRowBelow?(): void;
  deleteRow?(): void;
  deleteColumn?(): void;
  selectRow?(): void;
  selectColumn?(): void;
  deleteTable?(): void;
}

/** 构建编辑区右键菜单项：剪贴板/格式/链接/表格，按上下文启用。 */
export function buildEditorContextMenuItems(
  ctx: EditorMenuContext,
  actions: EditorMenuActions,
): MenuItem[] {
  const t = ctx.t ?? ((key: MessageKey) => key);
  const sc = ctx.formatShortcut ?? ((combo: string) => combo);
  const clipboardItems: MenuItem[] = [
    { id: 'cut', label: t('ctx.cut'), action: actions.cut, enabled: () => ctx.hasSelection },
    { id: 'copy', label: t('ctx.copy'), action: actions.copy, enabled: () => ctx.hasSelection },
    { id: 'paste', label: t('ctx.paste'), action: actions.paste },
    { id: 'paste-plain', label: t('ctx.pastePlain'), action: actions.pastePlain },
    // T6/R10：全选（双模式可用——源码模式仅返回 clipboardItems，故放在此处）。
    {
      id: 'select-all',
      label: t('ctx.selectAll'),
      shortcut: sc('Ctrl+A'),
      action: actions.selectAll,
    },
  ];
  // 源码模式：格式/链接动作作用于背后的 WYSIWYG 编辑器而非源码 textarea，
  // 展示会误导——只保留剪贴板项（execCommand 对聚焦的 textarea 同样生效）。
  if (ctx.inSourceMode === true) {
    return clipboardItems;
  }
  const items: MenuItem[] = [
    ...clipboardItems,
    { separator: true, id: 'sep-format', label: '', action: () => undefined },
    {
      id: 'bold',
      label: t('ctx.bold'),
      shortcut: sc('Ctrl+B'),
      action: actions.bold,
      enabled: () => ctx.hasSelection,
    },
    {
      id: 'italic',
      label: t('ctx.italic'),
      shortcut: sc('Ctrl+I'),
      action: actions.italic,
      enabled: () => ctx.hasSelection,
    },
    {
      id: 'link',
      label: t('ctx.link'),
      shortcut: sc('Ctrl+K'),
      action: actions.link,
      enabled: () => ctx.hasSelection,
    },
    { separator: true, id: 'sep-link', label: '', action: () => undefined },
    { id: 'open-link', label: t('ctx.openLink'), action: actions.openLink, enabled: () => ctx.hasLink },
    {
      id: 'copy-link',
      label: t('ctx.copyLink'),
      action: actions.copyLinkAddress,
      enabled: () => ctx.hasLink,
    },
  ];
  if (ctx.inTable === true) {
    items.push(
      { separator: true, id: 'sep-table', label: '', action: () => undefined },
      {
        id: 'table-insert-col-left',
        label: t('ctx.table.insertColLeft'),
        shortcut: sc('Ctrl+Alt+←'),
        action: () => actions.insertColLeft?.(),
      },
      {
        id: 'table-insert-col-right',
        label: t('ctx.table.insertColRight'),
        shortcut: sc('Ctrl+Alt+→'),
        action: () => actions.insertColRight?.(),
      },
      {
        id: 'table-insert-row-above',
        label: t('ctx.table.insertRowAbove'),
        shortcut: sc('Ctrl+Shift+Enter'),
        action: () => actions.insertRowAbove?.(),
      },
      {
        id: 'table-insert-row-below',
        label: t('ctx.table.insertRowBelow'),
        shortcut: sc('Ctrl+Enter'),
        action: () => actions.insertRowBelow?.(),
      },
      {
        id: 'table-select-row',
        label: t('ctx.table.selectRow'),
        action: () => actions.selectRow?.(),
      },
      {
        id: 'table-select-column',
        label: t('ctx.table.selectColumn'),
        action: () => actions.selectColumn?.(),
      },
      {
        id: 'table-delete-row',
        label: t('ctx.table.deleteRow'),
        shortcut: sc('Ctrl+Shift+Backspace'),
        action: () => actions.deleteRow?.(),
      },
      {
        id: 'table-delete-column',
        label: t('ctx.table.deleteColumn'),
        shortcut: sc('Ctrl+Shift+Delete'),
        action: () => actions.deleteColumn?.(),
      },
      {
        id: 'table-delete',
        label: t('ctx.table.delete'),
        action: () => actions.deleteTable?.(),
      },
    );
  }
  return items;
}

// ---------------------------------------------------------------------------
// 标签页上下文菜单（纯逻辑：按上下文决定 enabled）
// ---------------------------------------------------------------------------

export interface TabMenuContext {
  /** 是否有磁盘文件路径（未保存的新标签无路径）。 */
  hasFile: boolean;
  /** Translate UI string (en / zh-CN). Optional for tests. */
  t?: (key: MessageKey) => string;
}

export interface TabMenuActions {
  close(): void;
  closeOthers(): void;
  copyPath(): void;
  revealInFiles(): void;
}

/** 构建标签页右键菜单项：关闭/关闭其他/复制路径/在文件管理器中显示。 */
export function buildTabContextMenuItems(ctx: TabMenuContext, actions: TabMenuActions): MenuItem[] {
  const t = ctx.t ?? ((key: MessageKey) => key);
  return [
    { id: 'close', label: t('ctx.tab.close'), action: actions.close },
    { id: 'close-others', label: t('ctx.tab.closeOthers'), action: actions.closeOthers },
    { separator: true, id: 'sep-path', label: '', action: () => undefined },
    {
      id: 'copy-path',
      label: t('ctx.tab.copyPath'),
      action: actions.copyPath,
      enabled: () => ctx.hasFile,
    },
    {
      id: 'reveal',
      label: t('ctx.tab.reveal'),
      action: actions.revealInFiles,
      enabled: () => ctx.hasFile,
    },
  ];
}
