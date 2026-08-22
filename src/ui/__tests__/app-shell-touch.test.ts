// @vitest-environment jsdom

/**
 * app-shell 触屏门控（touchPrimary）：hover reveal 不绑定、chrome 触发条改为
 * 点按切换；桌面（touchPrimary=false）hover/点击路径不变。
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { InsertElementId } from '../../editor/insert-commands.js';
import type { BuiltinThemeId } from '../../theme/theme-service.js';
import { createAppShell, type AppShell, type AppShellActions } from '../app-shell.js';

function stubActions(): AppShellActions {
  const noop = (): void => undefined;
  return {
    onNew: noop,
    onOpen: noop,
    listRecents: () => Promise.resolve([]),
    openRecent: () => Promise.resolve(false),
    clearRecents: () => Promise.resolve(),
    onShowVersions: noop,
    hasActiveFile: () => false,
    onSave: noop,
    onSaveAs: noop,
    onExportHtml: noop,
    onExportPdf: noop,
    onUndo: noop,
    onRedo: noop,
    onCut: noop,
    onCopy: noop,
    onPaste: noop,
    onInsertElement: (_id: InsertElementId) => undefined,
    onToggleTheme: noop,
    onApplyTheme: (_id: BuiltinThemeId) => undefined,
    getCurrentThemeId: () => 'warm-light',
    onReloadCustomTheme: noop,
    onSelectCustomTheme: noop,
    onResetCustomTheme: noop,
    canReloadCustomTheme: () => false,
    canResetCustomTheme: () => false,
    onToggleOutline: noop,
    onToggleSourceMode: noop,
    getReadingLayout: () => 'scroll' as const,
    onToggleReadingLayout: noop,
    onToggleFullscreen: noop,
    isChromePinned: () => false,
    onToggleChromePinned: noop,
    onZoomIn: noop,
    onZoomOut: noop,
    onZoomReset: noop,
    getFontScaleLabel: () => '100%',
    t: (key: string) => key,
    formatShortcut: (combo: string) => combo,
    getLocale: () => 'zh-CN' as const,
    setLocale: () => undefined,
  };
}

let shells: AppShell[] = [];

function mount(touchPrimary: boolean): { root: HTMLElement; shell: AppShell } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const shell = createAppShell(root, stubActions(), {
    shortcutBindings: () => [],
    storage: null,
    initialPinPrefs: { menu: false, tabs: false },
    touchPrimary,
  });
  shells.push(shell);
  return { root, shell };
}

function triggerOf(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`#${id}`);
  if (el === null) throw new Error(`trigger not found: ${id}`);
  return el;
}

describe('app-shell touch-primary chrome', () => {
  afterEach(() => {
    for (const shell of shells.splice(0)) {
      shell.destroy();
    }
    document.body.replaceChildren();
  });

  it('touch: hover does not reveal; trigger tap toggles menu chrome', () => {
    const { root, shell } = mount(true);
    const trigger = triggerOf(root, 'lightink-menu-trigger');
    expect(shell.chrome.isRevealed('menu')).toBe(false);

    trigger.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    expect(shell.chrome.isRevealed('menu')).toBe(false);

    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    expect(root.querySelector('#lightink-chrome-host')?.classList.contains('is-menu-revealed')).toBe(
      true,
    );

    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.chrome.isRevealed('menu')).toBe(false);
    expect(root.querySelector('#lightink-chrome-host')?.classList.contains('is-menu-revealed')).toBe(
      false,
    );
  });

  it('touch: trigger tap toggles tabs chrome', () => {
    const { root, shell } = mount(true);
    const trigger = triggerOf(root, 'lightink-tabs-trigger');
    expect(shell.chrome.isRevealed('tabs')).toBe(false);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.chrome.isRevealed('tabs')).toBe(true);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.chrome.isRevealed('tabs')).toBe(false);
  });

  it('desktop: hover reveals and trigger click only reveals (no toggle off)', () => {
    const { root, shell } = mount(false);
    const trigger = triggerOf(root, 'lightink-menu-trigger');
    expect(shell.chrome.isRevealed('menu')).toBe(false);

    trigger.dispatchEvent(new MouseEvent('pointerenter', { bubbles: false }));
    expect(shell.chrome.isRevealed('menu')).toBe(true);

    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(shell.chrome.isRevealed('menu')).toBe(true);
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // 桌面点击不切换关闭（收起由 pointerleave/快捷键负责）。
    expect(shell.chrome.isRevealed('menu')).toBe(true);
  });
});
