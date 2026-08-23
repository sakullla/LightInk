/**
 * TabManager 行为测试（node 环境，全依赖注入 fake）：
 *   - 新建/打开/保存/另存为/关闭/切换的状态变迁；
 *   - 多标签并行编辑互不影响、各自独立脏标记；
 *   - 未保存关闭的三选一确认；
 *   - 崩溃快照的防抖写入、过期检测与恢复提示；
 *   - 保存-重开内容往返无损（中文 + 特殊字符）。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { EditorInstance } from '../../editor/types.js';
import type { RoundtripDeps } from '../../file/roundtrip.js';
import type { FileStat } from '../../file/file-service.js';
import type {
  ExternalConflictChoice,
  ExternalReloadChoice,
} from '../../file/external-change.js';
import { fileNameOf, snapshotKeyOf, TabManager, type TabManagerDeps } from '../tab-manager.js';
import type { CloseChoice, TabState } from '../types.js';
import { fakeHost, makeFakeEditor } from './test-harness.js';

type ConfirmCloseMock = Mock<
  (tab: Pick<TabState, 'title' | 'filePath'>) => Promise<CloseChoice>
>;
type PromptRestoreMock = Mock<(path: string) => Promise<boolean>>;

/** 假编辑器：内存字符串模拟内容。 */
interface Harness {
  manager: TabManager;
  deps: TabManagerDeps;
  editors: Array<EditorInstance & { content: string }>;
  roundtrip: RoundtripDeps;
  snapshots: Map<string, string>;
  confirmClose: ConfirmCloseMock;
  promptRestore: PromptRestoreMock;
}

function makeHarness(overrides: Partial<TabManagerDeps> = {}): Harness {
  const editors: Harness['editors'] = [];
  const snapshots = new Map<string, string>();
  const writeFile = vi.fn(async (_path: string, _content: string) => undefined);
  const roundtrip: RoundtripDeps = {
    readFile: vi.fn(async () => '磁盘内容'),
    writeFile,
    saveDocumentAs: vi.fn(async (_sessionId: string, path: string, content: string) => {
      await writeFile(path, content);
    }),
    showOpenDialog: vi.fn(async () => null),
    showSaveDialog: vi.fn(async () => null),
    reportError: vi.fn(),
  };
  const confirmClose: ConfirmCloseMock = vi.fn(
    async (_tab: Pick<TabState, 'title' | 'filePath'>) => 'discard' as CloseChoice,
  );
  const promptRestore: PromptRestoreMock = vi.fn(async (_path: string) => false);
  const deps: TabManagerDeps = {
    mountEditor: vi.fn(async (_el, opts) => {
      const editor = makeFakeEditor(opts.initialMarkdown ?? '');
      editors.push(editor);
      return editor;
    }),
    createHostElement: () => fakeHost(),
    attachHost: vi.fn(),
    detachHost: vi.fn(),
    confirmClose,
    promptRestore,
    roundtrip,
    writeSnapshot: vi.fn(async (key: string, content: string) => {
      snapshots.set(key, content);
    }),
    clearSnapshot: vi.fn(async (key: string) => {
      snapshots.delete(key);
    }),
    readStaleSnapshot: vi.fn(async () => null),
    reportError: vi.fn(),
    // R13：默认 stat 返回稳定基线（mtime=1000），外部变更测试用 overrides 覆盖。
    statFile: vi.fn(async () => ({
      mtime_ms: 1000,
      size: 0,
      fingerprint: '0000000000000000',
    })),
    snapshotDebounceMs: 1000,
    ...overrides,
  };
  return { manager: new TabManager(deps), deps, editors, roundtrip, snapshots, confirmClose, promptRestore };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('新建与切换', () => {
  it('newTab 创建未命名标签并置为活动', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab();
    expect(manager.tabList).toHaveLength(1);
    expect(manager.activeTabId).toBe(tab.id);
    expect(tab.title).toBe('未命名-1');
    expect(tab.filePath).toBeNull();
    expect(tab.dirty).toBe(false);
    expect(snapshotKeyOf(tab)).toMatch(/^untitled-/);
  });

  it('binds content changes to the editor instance instead of the active tab', async () => {
    const mounted: Array<Parameters<TabManagerDeps['mountEditor']>[1]> = [];
    const harness = makeHarness({
      mountEditor: vi.fn(async (_host, options) => {
        mounted.push(options);
        const editor = makeFakeEditor(options.initialMarkdown ?? '');
        harness.editors.push(editor);
        return editor;
      }),
    });
    const first = await harness.manager.newTab();
    const second = await harness.manager.newTab();
    expect(harness.manager.activeTabId).toBe(second.id);

    first.editor.setMarkdown('background edit');
    mounted[0]?.onContentChanged?.();

    expect(first.dirty).toBe(true);
    expect(second.dirty).toBe(false);
  });

  it('cleans up the host and partial editor when readiness fails', async () => {
    const partial = {
      ...makeFakeEditor(''),
      ready: Promise.reject(new Error('editor failed')),
    };
    const harness = makeHarness({
      mountEditor: vi.fn(async () => partial),
    });

    await expect(harness.manager.newTab()).rejects.toThrow('editor failed');

    expect(partial.destroy).toHaveBeenCalledOnce();
    expect(harness.deps.detachHost).toHaveBeenCalledOnce();
    expect(harness.manager.tabList).toHaveLength(0);
  });

  it('newTab focuses the editor after ready so typing can start', async () => {
    const { manager, editors } = makeHarness();
    await manager.newTab('开始书写。');
    await Promise.resolve();
    expect(editors[0]?.focus).toHaveBeenCalled();
  });

  it('两个未命名标签的快照键互不相同（跨会话唯一 token）', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    expect(snapshotKeyOf(a)).not.toBe(snapshotKeyOf(b));
  });

  it('switchTab 只显示活动标签的宿主元素', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    manager.switchTab(a.id);
    expect((a.hostElement as { style: { display: string } }).style.display).toBe('');
    expect((b.hostElement as { style: { display: string } }).style.display).toBe('none');
    manager.switchTab(b.id);
    expect(manager.activeTabId).toBe(b.id);
  });
});

describe('多标签并行编辑互不影响', () => {
  it('各标签内容与脏标记独立', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab('甲');
    const b = await manager.newTab('乙');
    a.editor.setMarkdown('甲-改');
    manager.handleContentChanged(a.id);
    expect(a.dirty).toBe(true);
    expect(b.dirty).toBe(false);
    expect(a.editor.getMarkdown()).toBe('甲-改');
    expect(b.editor.getMarkdown()).toBe('乙');
  });

  it('undo 回到已保存内容时脏标记自动清除', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab('原文');
    tab.editor.setMarkdown('改过');
    manager.handleContentChanged(tab.id);
    expect(tab.dirty).toBe(true);
    tab.editor.setMarkdown('原文'); // 模拟 undo 回保存点
    manager.handleContentChanged(tab.id);
    expect(tab.dirty).toBe(false);
  });
});

describe('打开与内容往返', () => {
  it('openFile 读取内容创建标签，标题取文件名', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string) => undefined);
    const customRoundtrip: RoundtripDeps = {
      readFile: vi.fn(async () => '# 你好 🚀\n\n特殊字符 <>&"\'\\'),
      writeFile,
      saveDocumentAs: vi.fn(async (_sessionId: string, path: string, content: string) => {
        await writeFile(path, content);
      }),
      showOpenDialog: vi.fn(async () => null),
      showSaveDialog: vi.fn(async () => null),
      reportError: vi.fn(),
    };
    const { manager } = makeHarness({ roundtrip: customRoundtrip });
    const tab = await manager.openFile('C:\\docs\\笔记.md');
    expect(tab).not.toBeNull();
    expect(tab!.filePath).toBe('C:\\docs\\笔记.md');
    expect(tab!.title).toBe('笔记.md');
    expect(tab!.dirty).toBe(false);
    expect(tab!.editor.getMarkdown()).toBe('# 你好 🚀\n\n特殊字符 <>&"\'\\');
    expect(customRoundtrip.readFile).toHaveBeenCalledWith('C:\\docs\\笔记.md');
  });

  it('保存-重开往返无损（中文与特殊字符）', async () => {
    const harness = makeHarness();
    let disk = '';
    (harness.roundtrip.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: string, c: string) => {
        disk = c;
      },
    );
    (harness.roundtrip.readFile as ReturnType<typeof vi.fn>).mockImplementation(
      async () => disk,
    );
    const tab = await harness.manager.newTab();
    const content = '# 标题 🎉\n\n中文、emoji 🚀、<html>、"引号"、\\反斜杠\n';
    tab.editor.setMarkdown(content);
    await expect(harness.manager.saveTabAs(tab.id)).resolves.toBe(false); // 对话框取消
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\往返.md',
    );
    await expect(harness.manager.saveTabAs(tab.id)).resolves.toBe(true);
    expect(disk).toBe(content);

    // 重新打开同一文件 → 内容一致
    await harness.manager.closeTab(tab.id);
    const reopened = await harness.manager.openFile('D:\\往返.md');
    expect(reopened!.editor.getMarkdown()).toBe(content);
    expect(reopened!.dirty).toBe(false);
  });

  it('重复打开同一路径切换而非新建', async () => {
    const { manager } = makeHarness();
    const first = await manager.openFile('C:\\a.md');
    const again = await manager.openFile('C:\\a.md');
    expect(again!.id).toBe(first!.id);
    expect(manager.tabList).toHaveLength(1);
  });
});

describe('保存与脏标记', () => {
  it('保存成功清脏标记并清除崩溃快照', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改动');
    harness.manager.handleContentChanged(tab!.id);
    expect(tab!.dirty).toBe(true);
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(true);
    expect(tab!.dirty).toBe(false);
    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('C:\\a.md', '改动');
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });

  it('保存失败保持脏标记且不清快照', async () => {
    const harness = makeHarness();
    (harness.roundtrip.writeFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      '磁盘错误',
    );
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改动');
    harness.manager.handleContentChanged(tab!.id);
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(false);
    expect(tab!.dirty).toBe(true);
    expect(harness.deps.clearSnapshot).not.toHaveBeenCalled();
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith('C:\\a.md', '改动');
  });

  it('未命名标签保存转另存为，成功后迁移路径与标题', async () => {
    const harness = makeHarness();
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\命名.md',
    );
    const tab = await harness.manager.newTab('草稿');
    tab!.editor.setMarkdown('草稿-改');
    await expect(harness.manager.saveTab(tab.id)).resolves.toBe(true);
    expect(tab.filePath).toBe('D:\\命名.md');
    expect(tab.title).toBe('命名.md');
    expect(tab.dirty).toBe(false);
    expect(snapshotKeyOf(tab)).toBe('D:\\命名.md');
  });

  it('另存为事务失败时保留原路径、标题和 dirty 状态', async () => {
    const harness = makeHarness();
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\new.md',
    );
    (harness.roundtrip.saveDocumentAs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('asset conflict'),
    );
    const tab = await harness.manager.openFile('C:\\original.md');
    tab!.editor.setMarkdown('unsaved');
    harness.manager.handleContentChanged(tab!.id);

    await expect(harness.manager.saveTabAs(tab!.id)).resolves.toBe(false);

    expect(tab!.filePath).toBe('C:\\original.md');
    expect(tab!.title).toBe('original.md');
    expect(tab!.lastSavedMarkdown).toBe('磁盘内容');
    expect(tab!.dirty).toBe(true);
    expect(harness.deps.clearSnapshot).not.toHaveBeenCalled();
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(
      'C:\\original.md',
      'unsaved',
    );
  });

  it('同一标签的后发保存等待前一次完成并读取最新内容', async () => {
    const harness = makeHarness();
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const writeFile = harness.roundtrip.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockImplementationOnce(() => firstWrite).mockResolvedValueOnce(undefined);
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('v1');
    harness.manager.handleContentChanged(tab!.id);

    const firstSave = harness.manager.saveTab(tab!.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    tab!.editor.setMarkdown('v2');
    harness.manager.handleContentChanged(tab!.id);
    const secondSave = harness.manager.saveTab(tab!.id);
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);

    releaseFirst!();
    await expect(firstSave).resolves.toBe(false);
    await expect(secondSave).resolves.toBe(true);
    expect(writeFile.mock.calls.map((call) => call[1])).toEqual(['v1', 'v2']);
  });

  it('保存失败不会阻塞同一标签队列中的下一次保存', async () => {
    const onSaveStatusChanged = vi.fn();
    const harness = makeHarness({ onSaveStatusChanged });
    const writeFile = harness.roundtrip.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改动');
    harness.manager.handleContentChanged(tab!.id);

    const failed = harness.manager.saveTab(tab!.id);
    const retried = harness.manager.saveTab(tab!.id);
    await expect(failed).resolves.toBe(false);
    await expect(retried).resolves.toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(tab!.dirty).toBe(false);
    expect(onSaveStatusChanged.mock.calls.map((call) => call[1])).toContain('error');
    expect(harness.manager.getSaveStatus(tab!.id)).toBe('saved');
  });

  it('保存期间出现的新编辑保持 dirty 且不清除快照', async () => {
    const harness = makeHarness();
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeFile = harness.roundtrip.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockImplementationOnce(() => pendingWrite);
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('persisted-v1');
    harness.manager.handleContentChanged(tab!.id);

    const saving = harness.manager.saveTab(tab!.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    expect(harness.manager.getSaveStatus(tab!.id)).toBe('saving');
    tab!.editor.setMarkdown('unsaved-v2');
    harness.manager.handleContentChanged(tab!.id);
    expect(harness.manager.getSaveStatus(tab!.id)).toBe('dirty');
    releaseWrite!();

    await expect(saving).resolves.toBe(false);
    expect(tab!.lastSavedMarkdown).toBe('persisted-v1');
    expect(tab!.dirty).toBe(true);
    expect(harness.deps.clearSnapshot).not.toHaveBeenCalled();
  });

  it('另存为期间出现新编辑时保留新路径和 dirty 状态', async () => {
    const harness = makeHarness();
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeFile = harness.roundtrip.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockImplementationOnce(() => pendingWrite);
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\draft.md',
    );
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('persisted-v1');
    harness.manager.handleContentChanged(tab.id);

    const saving = harness.manager.saveTabAs(tab.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    tab.editor.setMarkdown('unsaved-v2');
    harness.manager.handleContentChanged(tab.id);
    releaseWrite!();

    await expect(saving).resolves.toBe(false);
    expect(tab.filePath).toBe('D:\\draft.md');
    expect(tab.lastSavedMarkdown).toBe('persisted-v1');
    expect(tab.dirty).toBe(true);
    expect(harness.deps.clearSnapshot).not.toHaveBeenCalled();
  });
});

describe('关闭未保存标签', () => {
  it('confirmClose=cancel 不关闭', async () => {
    const harness = makeHarness();
    harness.confirmClose.mockResolvedValue('cancel');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(false);
    expect(harness.manager.tabList).toHaveLength(1);
  });

  it('confirmClose=discard 关闭并清除快照、销毁编辑器', async () => {
    const harness = makeHarness();
    harness.confirmClose.mockResolvedValue('discard');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(true);
    expect(harness.manager.tabList).toHaveLength(0);
    expect(harness.manager.activeTabId).toBeNull();
    expect(tab.editor.destroy).toHaveBeenCalled();
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith(tab.syntheticId);
  });

  it('confirmClose=save 先保存再关闭；保存失败则不关闭', async () => {
    const harness = makeHarness();
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      'D:\\s.md',
    );
    harness.confirmClose.mockResolvedValue('save');
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab.id);
    await expect(harness.manager.closeTab(tab.id)).resolves.toBe(true);
    expect(harness.roundtrip.writeFile).toHaveBeenCalledWith('D:\\s.md', '改');

    // 保存失败场景
    const harness2 = makeHarness();
    harness2.confirmClose.mockResolvedValue('save');
    (harness2.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    ); // 另存为取消
    const tab2 = await harness2.manager.newTab();
    tab2.editor.setMarkdown('改');
    harness2.manager.handleContentChanged(tab2.id);
    await expect(harness2.manager.closeTab(tab2.id)).resolves.toBe(false);
    expect(harness2.manager.tabList).toHaveLength(1);
  });

  it('关闭活动标签后切换到相邻标签', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    await manager.closeTab(b.id);
    expect(manager.activeTabId).toBe(a.id);
  });

  it('同一标签的并发关闭共享操作且不会删除其他标签', async () => {
    const harness = makeHarness();
    let resolveChoice: ((choice: CloseChoice) => void) | undefined;
    harness.confirmClose.mockImplementation(
      () =>
        new Promise<CloseChoice>((resolve) => {
          resolveChoice = resolve;
        }),
    );
    const a = await harness.manager.newTab();
    const b = await harness.manager.newTab();
    a.editor.setMarkdown('dirty');
    harness.manager.handleContentChanged(a.id);

    const first = harness.manager.closeTab(a.id);
    const second = harness.manager.closeTab(a.id);
    expect(second).toBe(first);
    expect(harness.confirmClose).toHaveBeenCalledTimes(1);
    resolveChoice!('discard');

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(harness.manager.tabList.map((tab) => tab.id)).toEqual([b.id]);
    expect(harness.deps.detachHost).toHaveBeenCalledTimes(1);
  });

  it('关闭已经移除的标签是幂等操作', async () => {
    const harness = makeHarness();
    const a = await harness.manager.newTab();
    const b = await harness.manager.newTab();
    await expect(harness.manager.closeTab(a.id)).resolves.toBe(true);
    await expect(harness.manager.closeTab(a.id)).resolves.toBe(true);
    expect(harness.manager.tabList.map((tab) => tab.id)).toEqual([b.id]);
    expect(harness.deps.detachHost).toHaveBeenCalledTimes(1);
  });

  it('关闭时保存若被更新内容追上则保留标签', async () => {
    const harness = makeHarness();
    harness.confirmClose.mockResolvedValue('save');
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeFile = harness.roundtrip.writeFile as ReturnType<typeof vi.fn>;
    writeFile.mockImplementationOnce(() => pendingWrite);
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('persisted-v1');
    harness.manager.handleContentChanged(tab!.id);

    const closing = harness.manager.closeTab(tab!.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    tab!.editor.setMarkdown('unsaved-v2');
    harness.manager.handleContentChanged(tab!.id);
    releaseWrite!();

    await expect(closing).resolves.toBe(false);
    expect(harness.manager.tabList).toContain(tab);
    expect(tab!.dirty).toBe(true);
    expect(tab!.editor.destroy).not.toHaveBeenCalled();
  });
});

describe('应用退出批量关闭', () => {
  it('Save All 全部保存成功后才统一销毁标签', async () => {
    const harness = makeHarness();
    const first = await harness.manager.openFile('C:\\first.md');
    const second = await harness.manager.openFile('C:\\second.md');
    first!.editor.setMarkdown('first edit');
    second!.editor.setMarkdown('second edit');
    harness.manager.handleContentChanged(first!.id);
    harness.manager.handleContentChanged(second!.id);

    await expect(harness.manager.closeAllTabs('save')).resolves.toBe(true);

    expect(harness.roundtrip.writeFile).toHaveBeenNthCalledWith(
      1,
      'C:\\first.md',
      'first edit',
    );
    expect(harness.roundtrip.writeFile).toHaveBeenNthCalledWith(
      2,
      'C:\\second.md',
      'second edit',
    );
    expect(harness.manager.tabList).toHaveLength(0);
    expect(first!.editor.destroy).toHaveBeenCalledOnce();
    expect(second!.editor.destroy).toHaveBeenCalledOnce();
    expect(harness.confirmClose).not.toHaveBeenCalled();
  });

  it('Save All 任一保存取消时保留全部标签', async () => {
    const harness = makeHarness();
    const saved = await harness.manager.openFile('C:\\saved.md');
    const untitled = await harness.manager.newTab();
    saved!.editor.setMarkdown('saved edit');
    untitled.editor.setMarkdown('untitled edit');
    harness.manager.handleContentChanged(saved!.id);
    harness.manager.handleContentChanged(untitled.id);
    (harness.roundtrip.showSaveDialog as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(harness.manager.closeAllTabs('save')).resolves.toBe(false);

    expect(harness.manager.tabList).toEqual([saved, untitled]);
    expect(saved!.editor.destroy).not.toHaveBeenCalled();
    expect(untitled.editor.destroy).not.toHaveBeenCalled();
    expect(harness.deps.detachHost).not.toHaveBeenCalled();
  });

  it('Save All 保存期间出现新编辑时中止退出', async () => {
    const harness = makeHarness();
    let releaseWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    (harness.roundtrip.writeFile as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => pendingWrite,
    );
    const tab = await harness.manager.openFile('C:\\draft.md');
    tab!.editor.setMarkdown('version one');
    harness.manager.handleContentChanged(tab!.id);

    const closing = harness.manager.closeAllTabs('save');
    await vi.waitFor(() => expect(harness.roundtrip.writeFile).toHaveBeenCalledOnce());
    tab!.editor.setMarkdown('version two');
    harness.manager.handleContentChanged(tab!.id);
    releaseWrite!();

    await expect(closing).resolves.toBe(false);
    expect(harness.manager.tabList).toEqual([tab]);
    expect(tab!.dirty).toBe(true);
    expect(tab!.editor.destroy).not.toHaveBeenCalled();
  });

  it('Discard All 不逐标签确认并清空工作区', async () => {
    const harness = makeHarness();
    const first = await harness.manager.newTab();
    const second = await harness.manager.newTab();
    first.editor.setMarkdown('first edit');
    second.editor.setMarkdown('second edit');
    harness.manager.handleContentChanged(first.id);
    harness.manager.handleContentChanged(second.id);

    await expect(harness.manager.closeAllTabs('discard')).resolves.toBe(true);

    expect(harness.manager.tabList).toHaveLength(0);
    expect(harness.confirmClose).not.toHaveBeenCalled();
  });
});

describe('崩溃快照', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('编辑防抖后写入快照（键为文件路径或 untitled 合成 id）', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('未保存的草稿');
    harness.manager.handleContentChanged(tab.id);
    expect(harness.deps.writeSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(
      tab.syntheticId,
      '未保存的草稿',
    );
  });

  it('serializes every snapshot write before clear so an old write cannot revive', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots = new Map<string, string>();
    const writeSnapshot = vi.fn(async (key: string, content: string) => {
      if (content === 'version one') {
        await firstBlocked;
      }
      snapshots.set(key, content);
    });
    const clearSnapshot = vi.fn(async (key: string) => {
      snapshots.delete(key);
    });
    const harness = makeHarness({ writeSnapshot, clearSnapshot });
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('version one');
    harness.manager.handleContentChanged(tab.id);
    const first = harness.manager.flushSnapshot(tab.id);
    await vi.waitFor(() => expect(writeSnapshot).toHaveBeenCalledTimes(1));

    tab.editor.setMarkdown('version two');
    harness.manager.handleContentChanged(tab.id);
    const second = harness.manager.flushSnapshot(tab.id);
    const closing = harness.manager.closeTab(tab.id);
    await Promise.resolve();
    expect(harness.deps.detachHost).not.toHaveBeenCalled();

    releaseFirst!();
    await Promise.all([first, second, closing]);

    expect(writeSnapshot).toHaveBeenCalledTimes(1);
    expect(clearSnapshot).toHaveBeenCalledWith(tab.syntheticId);
    expect(snapshots.has(tab.syntheticId)).toBe(false);
  });

  it('连续编辑只触发一次防抖快照', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.newTab();
    tab.editor.setMarkdown('v1');
    harness.manager.handleContentChanged(tab.id);
    vi.advanceTimersByTime(500);
    tab.editor.setMarkdown('v2');
    harness.manager.handleContentChanged(tab.id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(tab.syntheticId, 'v2');
  });

  it('已保存文件编辑后的快照键是文件路径', async () => {
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith('C:\\a.md', '改');
  });

  it('打开文件时检测到过期快照：选择恢复则载入且保持脏标记', async () => {
    const harness = makeHarness();
    (harness.deps.readStaleSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      '崩溃前的未保存内容',
    );
    (harness.roundtrip.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      '磁盘旧内容',
    );
    harness.promptRestore.mockResolvedValue(true);
    const tab = await harness.manager.openFile('C:\\a.md');
    expect(tab!.editor.getMarkdown()).toBe('崩溃前的未保存内容');
    expect(tab!.dirty).toBe(true);
  });

  it('放弃恢复则使用磁盘内容且清掉旧快照', async () => {
    const harness = makeHarness();
    (harness.deps.readStaleSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
      '崩溃前的内容',
    );
    harness.promptRestore.mockResolvedValue(false);
    const tab = await harness.manager.openFile('C:\\a.md');
    expect(tab!.editor.getMarkdown()).toBe('磁盘内容');
    expect(tab!.dirty).toBe(false);
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });
});

describe('辅助函数', () => {
  it('fileNameOf 同时兼容两种分隔符', () => {
    expect(fileNameOf('C:\\docs\\笔记.md')).toBe('笔记.md');
    expect(fileNameOf('/home/user/a.md')).toBe('a.md');
  });
});

describe('未命名崩溃草稿恢复', () => {
  it('recoverUntitledDrafts：恢复则以其原键开标签且保持脏标记', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => [
        { key: 'untitled-aa11bb22', content: '崩溃前的草稿内容' },
      ]),
    });
    harness.promptRestore.mockResolvedValue(true);
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toHaveLength(1);
    expect(restored[0].syntheticId).toBe('untitled-aa11bb22');
    expect(restored[0].editor.getMarkdown()).toBe('崩溃前的草稿内容');
    expect(restored[0].dirty).toBe(true);
    // 后续防抖快照覆盖同一键（不清除也不另起新键）
    vi.useFakeTimers();
    restored[0].editor.setMarkdown('继续编辑');
    harness.manager.handleContentChanged(restored[0].id);
    vi.advanceTimersByTime(1000);
    expect(harness.deps.writeSnapshot).toHaveBeenCalledWith(
      'untitled-aa11bb22',
      '继续编辑',
    );
  });

  it('recoverUntitledDrafts：放弃则删除该快照', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => [
        { key: 'untitled-cc33dd44', content: '旧草稿' },
      ]),
    });
    harness.promptRestore.mockResolvedValue(false);
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toHaveLength(0);
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('untitled-cc33dd44');
  });

  it('listUntitledDrafts 失败时静默返回空（不阻塞启动）', async () => {
    const harness = makeHarness({
      listUntitledDrafts: vi.fn(async () => {
        throw new Error('ipc down');
      }),
    });
    const restored = await harness.manager.recoverUntitledDrafts();
    expect(restored).toEqual([]);
  });
});

describe('保存与快照写入竞态', () => {
  it('保存前取消待写快照并等待进行中的写入完成', async () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    // 防抖窗口内立即保存：不应再触发快照写入
    await harness.manager.saveTab(tab!.id);
    vi.advanceTimersByTime(2000);
    expect(harness.deps.writeSnapshot).not.toHaveBeenCalled();
    // 文件路径快照由 TabManager 在保存状态落定后清除。
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });

  it('进行中的快照写入完成后才清快照（无孤儿快照）', async () => {
    vi.useFakeTimers();
    let resolveWrite: (() => void) | null = null;
    const harness = makeHarness({
      writeSnapshot: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      ),
    });
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('改');
    harness.manager.handleContentChanged(tab!.id);
    vi.advanceTimersByTime(1000); // 触发 writeSnapshot（挂起中）
    expect(harness.deps.writeSnapshot).toHaveBeenCalledTimes(1);

    const savePromise = harness.manager.saveTab(tab!.id);
    // 快照写入未完成 → 保存流程挂起在 await 上
    await Promise.resolve();
    expect(harness.deps.clearSnapshot).not.toHaveBeenCalled();
    resolveWrite!();
    await savePromise;
    expect(harness.deps.clearSnapshot).toHaveBeenCalledWith('C:\\a.md');
  });
});

describe('R13 外部文件变更检测', () => {
  /** 可变 stat：返回值可随测试推进调整（模拟磁盘在外部被改写）。 */
  type MutableTestStat = { mtime_ms: number; size: number; fingerprint?: string };

  function mutableStat(initial: MutableTestStat) {
    let cur = initial;
    const fn = vi.fn(async () => ({
      mtime_ms: cur.mtime_ms,
      size: cur.size,
      fingerprint: cur.fingerprint ?? `${cur.mtime_ms}:${cur.size}`,
    }));
    return { fn, set: (v: MutableTestStat) => { cur = v; } };
  }

  const readFileFn = (h: Harness) => h.roundtrip.readFile as ReturnType<typeof vi.fn>;
  const writeFileFn = (h: Harness) => h.roundtrip.writeFile as ReturnType<typeof vi.fn>;

  it('保存前检测到外部冲突，选 keep 中止写入并保留脏态', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'keep');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({ mtime_ms: 2000, size: 9 }); // 磁盘被外部改写
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(false);
    expect(confirmConflict).toHaveBeenCalledTimes(1);
    expect(writeFileFn(harness)).not.toHaveBeenCalled();
    expect(tab!.dirty).toBe(true);
    expect(tab!.editor.getMarkdown()).toBe('mine');
  });

  it('相同 mtime 和大小但内容指纹变化仍触发冲突', async () => {
    const stat = mutableStat({
      mtime_ms: 1000,
      size: 5,
      fingerprint: 'aaaaaaaaaaaaaaaa',
    });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'keep');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('first');
    const tab = await harness.manager.openFile('C:\\same-size.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({
      mtime_ms: 1000,
      size: 5,
      fingerprint: 'bbbbbbbbbbbbbbbb',
    });

    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(false);

    expect(confirmConflict).toHaveBeenCalledOnce();
    expect(writeFileFn(harness)).not.toHaveBeenCalled();
  });

  it('保存前外部冲突，选 overwrite 仍写入（非静默覆盖）', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'overwrite');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({ mtime_ms: 2000, size: 9 });
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(true);
    expect(writeFileFn(harness)).toHaveBeenCalledWith('C:\\a.md', 'mine');
    expect(tab!.dirty).toBe(false);
  });

  it('保存前外部冲突，选 reload 从磁盘重载并放弃内存编辑', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'reload');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({ mtime_ms: 2000, size: 9 });
    readFileFn(harness).mockResolvedValue('disk-new');
    await expect(harness.manager.saveTab(tab!.id)).resolves.toBe(false);
    expect(writeFileFn(harness)).not.toHaveBeenCalled();
    expect(tab!.editor.getMarkdown()).toBe('disk-new');
    expect(tab!.dirty).toBe(false);
  });

  it('轮询：未脏文件磁盘更新，选 reload 重载为新内容', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmReload = vi.fn(async (): Promise<ExternalReloadChoice> => 'reload');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalReload: confirmReload });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    expect(tab!.dirty).toBe(false);
    stat.set({ mtime_ms: 2000, size: 9 });
    readFileFn(harness).mockResolvedValue('disk-new');
    await harness.manager.checkActiveExternalChange();
    expect(confirmReload).toHaveBeenCalledTimes(1);
    expect(tab!.editor.getMarkdown()).toBe('disk-new');
    expect(tab!.dirty).toBe(false);
  });

  it('轮询：未脏文件磁盘更新，选 ignore 不重载且更新基线（不重复弹窗）', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmReload = vi.fn(async (): Promise<ExternalReloadChoice> => 'ignore');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalReload: confirmReload });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    stat.set({ mtime_ms: 2000, size: 9 });
    await harness.manager.checkActiveExternalChange();
    expect(tab!.editor.getMarkdown()).toBe('original'); // 未重载
    // 基线已对齐到 {2000,9}：磁盘态不变 → 第二次轮询不再弹窗。
    await harness.manager.checkActiveExternalChange();
    expect(confirmReload).toHaveBeenCalledTimes(1);
  });

  it('轮询：已脏文件磁盘更新，选 keep 保留内存脏态且不写盘', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'keep');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({ mtime_ms: 2000, size: 9 });
    await harness.manager.checkActiveExternalChange();
    expect(tab!.editor.getMarkdown()).toBe('mine');
    expect(tab!.dirty).toBe(true);
    expect(writeFileFn(harness)).not.toHaveBeenCalled();
  });

  it('轮询：已脏文件磁盘更新，选 overwrite 立即把内存内容写盘', async () => {
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'overwrite');
    const harness = makeHarness({ statFile: stat.fn, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    stat.set({ mtime_ms: 2000, size: 9 });
    await harness.manager.checkActiveExternalChange();
    expect(writeFileFn(harness)).toHaveBeenCalledWith('C:\\a.md', 'mine');
    expect(tab!.dirty).toBe(false);
  });

  it('stat 失败时轮询只上报错误、不弹窗、不自动动作（R13 失败行为）', async () => {
    let fail = false;
    let cur = { mtime_ms: 1000, size: 5 };
    const statFile = vi.fn(async () => {
      if (fail) throw new Error('gone');
      return {
        mtime_ms: cur.mtime_ms,
        size: cur.size,
        fingerprint: `${cur.mtime_ms}:${cur.size}`,
      };
    });
    const reportError = vi.fn();
    const confirmReload = vi.fn(async (): Promise<ExternalReloadChoice> => 'reload');
    const harness = makeHarness({ statFile, reportError, confirmExternalReload: confirmReload });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md'); // 基线 {1000,5}
    cur = { mtime_ms: 2000, size: 9 };
    fail = true; // 磁盘文件被删/不可读
    await harness.manager.checkActiveExternalChange();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(confirmReload).not.toHaveBeenCalled();
    expect(tab!.editor.getMarkdown()).toBe('original'); // 不自动改动内容
  });

  it('聚焦双通道并发触发只弹一次冲突对话框（守卫在首个 await 前同步置位）', async () => {
    let baselineDone = false;
    let pendingResolve: ((v: FileStat) => void) | null = null;
    const statFile = vi.fn((_path: string) => {
      if (!baselineDone) {
        return Promise.resolve({
          mtime_ms: 1000,
          size: 5,
          fingerprint: '1000:5',
        });
      }
      // 检测期 stat 挂起：模拟两个并发调用都在等待磁盘结果。
      return new Promise<FileStat>((resolve) => {
        pendingResolve = resolve;
      });
    });
    const confirmConflict = vi.fn(async (): Promise<ExternalConflictChoice> => 'keep');
    const harness = makeHarness({ statFile, confirmExternalConflict: confirmConflict });
    readFileFn(harness).mockResolvedValue('original');
    const tab = await harness.manager.openFile('C:\\a.md');
    baselineDone = true;
    tab!.editor.setMarkdown('mine');
    harness.manager.handleContentChanged(tab!.id);
    const first = harness.manager.checkActiveExternalChange();
    const second = harness.manager.checkActiveExternalChange(); // DOM focus + Tauri 焦点双通道
    pendingResolve!({ mtime_ms: 2000, size: 9, fingerprint: '2000:9' });
    await Promise.all([first, second]);
    expect(confirmConflict).toHaveBeenCalledTimes(1);
    expect(tab!.dirty).toBe(true); // keep：保留内存脏态
    expect(harness.manager.getSaveStatus(tab!.id)).toBe('conflict');
  });

  it('stat 失败的一次性可见提示：每段不可读期只提示一次，恢复可读后重置', async () => {
    let fail = false;
    const stat = mutableStat({ mtime_ms: 1000, size: 5 });
    const statFile = vi.fn(async () => {
      if (fail) throw new Error('gone');
      return stat.fn();
    });
    const notify = vi.fn();
    const harness = makeHarness({ statFile, notifyExternalUnreadable: notify });
    readFileFn(harness).mockResolvedValue('original');
    await harness.manager.openFile('C:\\a.md');
    fail = true;
    await harness.manager.checkActiveExternalChange();
    await harness.manager.checkActiveExternalChange(); // 同一段不可读期：不重复提示
    expect(notify).toHaveBeenCalledTimes(1);
    fail = false; // 恢复可读 → 重置一次性标志
    await harness.manager.checkActiveExternalChange();
    expect(notify).toHaveBeenCalledTimes(1);
    fail = true; // 新的不可读期 → 再提示一次
    await harness.manager.checkActiveExternalChange();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('reader 标签（只读，豁免可写路径）', () => {
  /** 假阅读视图：记录 load/destroy 调用以便断言生命周期。 */
  function makeReaderDeps(destroy?: () => Promise<void>) {
    const readerDestroy = vi.fn(destroy ?? (async () => undefined));
    const readerLoad = vi.fn(async () => undefined);
    return {
      readerDestroy,
      readerLoad,
      mountReader: vi.fn(async () => ({
        state: {
          phase: 'empty' as const,
          current: 0,
          total: 0,
          progress: 0,
          scale: 1,
          locationKind: null,
        },
        subscribeState: vi.fn(() => () => undefined),
        load: readerLoad,
        destroy: readerDestroy,
        // ReaderInstance 扩展的标注/侧栏方法（reader-view 实现；此处仅需满足类型）。
        addBookmark: vi.fn(() => undefined),
        addNote: vi.fn(() => undefined),
        toggleSidebar: vi.fn(() => undefined),
        setTabActive: vi.fn(() => undefined),
        isSidebarVisible: vi.fn(() => false),
        getOutline: vi.fn(() => []),
        jumpToOutlineItem: vi.fn(() => undefined),
        isAnnotationEnabled: vi.fn(() => false),
        getExportHtml: vi.fn(async () => null),
        advanceReading: vi.fn(() => false),
      })),
    };
  }

  it('openReader 创建只读标签且不挂编辑器', async () => {
    const rd = makeReaderDeps();
    const { manager, deps, editors } = makeHarness(rd);
    const tab = await manager.openReader('C:\\docs\\book.pdf');
    expect(tab.kind).toBe('reader');
    expect(tab.filePath).toBe('C:\\docs\\book.pdf');
    expect(tab.title).toBe('book.pdf');
    expect(tab.dirty).toBe(false);
    expect(tab.lastSavedMtime).toBeNull();
    expect(editors).toHaveLength(0); // 未挂 Milkdown 编辑器
    expect(deps.mountReader).toHaveBeenCalledTimes(1);
    expect(manager.activeTabId).toBe(tab.id);
  });

  it('removes the host when reader mounting fails', async () => {
    const { manager, deps } = makeHarness({
      mountReader: vi.fn(async () => {
        throw new Error('reader failed');
      }),
    });

    await expect(manager.openReader('C:\\docs\\broken.epub')).rejects.toThrow(
      'reader failed',
    );

    expect(deps.detachHost).toHaveBeenCalledOnce();
    expect(manager.tabList).toHaveLength(0);
  });

  it('重复打开同一路径 reader 标签切换而非新建', async () => {
    const rd = makeReaderDeps();
    const { manager, deps } = makeHarness(rd);
    const a = await manager.openReader('C:\\docs\\book.pdf');
    const b = await manager.openReader('C:\\docs\\book.pdf');
    expect(b.id).toBe(a.id);
    expect(manager.tabList).toHaveLength(1);
    expect(deps.mountReader).toHaveBeenCalledTimes(1);
  });

  it('远程阅读目标使用稳定 identity 去重且不写入本地最近记录', async () => {
    const rd = makeReaderDeps();
    const onFileOpened = vi.fn();
    const { manager } = makeHarness({ ...rd, onFileOpened });
    const target = {
      kind: 'remote' as const,
      itemId: 'item-1',
      resourceId: 'https://books.example/a.cbz',
      identity: { id: 'item-1', validator: '"v1"' },
      displayName: '远程漫画.cbz',
      extension: 'cbz',
      mimeType: 'application/vnd.comicbook+zip',
    };

    const first = await manager.openReader(target);
    const second = await manager.openReader({
      ...target,
      resourceId: 'https://books.example/a.cbz?v=2',
      identity: { id: 'item-1', validator: '"v2"' },
    });

    expect(second).toBe(first);
    expect(first.filePath).toBeNull();
    expect(first.syntheticId).toBe('reader:item-1');
    expect(first.target).toEqual(target);
    expect(manager.tabList).toHaveLength(1);
    expect(onFileOpened).not.toHaveBeenCalled();
  });

  it('reader 标签与 markdown 标签可互相切换（宿主 show/hide）', async () => {
    const rd = makeReaderDeps();
    const { manager } = makeHarness(rd);
    const md = await manager.newTab('正文');
    const reader = await manager.openReader('C:\\docs\\book.epub');
    expect(manager.activeTabId).toBe(reader.id);
    manager.switchTab(md.id);
    expect(manager.activeTabId).toBe(md.id);
    expect((md.hostElement as { style: { display: string } }).style.display).toBe('');
    expect((reader.hostElement as { style: { display: string } }).style.display).toBe('none');
    manager.switchTab(reader.id);
    expect(manager.activeTabId).toBe(reader.id);
  });

  it('closeTab 关闭 reader 标签：销毁阅读视图、不弹未保存确认、不写快照', async () => {
    const rd = makeReaderDeps();
    const { manager, deps, snapshots, confirmClose } = makeHarness(rd);
    const tab = await manager.openReader('C:\\docs\\book.pdf');
    await manager.closeTab(tab.id);
    expect(rd.readerDestroy).toHaveBeenCalledTimes(1);
    expect(deps.detachHost).toHaveBeenCalledWith(tab.hostElement);
    expect(confirmClose).not.toHaveBeenCalled(); // dirty=false，不弹三选一
    expect([...snapshots.keys()]).toHaveLength(0);
    expect(manager.tabList).toHaveLength(0);
  });

  it('handleContentChanged 对 reader 标签是 no-op（不抛异常、不置脏、不写快照）', async () => {
    const rd = makeReaderDeps();
    const { manager, deps } = makeHarness(rd);
    const tab = await manager.openReader('C:\\docs\\book.pdf');
    expect(() => manager.handleContentChanged(tab.id)).not.toThrow();
    expect(tab.dirty).toBe(false);
    expect(deps.writeSnapshot).not.toHaveBeenCalled();
  });

  it('saveTab / saveTabAs 对 reader 标签返回 false（永不保存）', async () => {
    const rd = makeReaderDeps();
    const { manager, roundtrip } = makeHarness(rd);
    const tab = await manager.openReader('C:\\docs\\book.pdf');
    await expect(manager.saveTab(tab.id)).resolves.toBe(false);
    await expect(manager.saveTabAs(tab.id)).resolves.toBe(false);
    expect(roundtrip.writeFile).not.toHaveBeenCalled();
  });

  it('autosaveDirtyTabs 跳过 reader 标签（不触发保存）', async () => {
    const rd = makeReaderDeps();
    const { manager, roundtrip } = makeHarness(rd);
    await manager.openReader('C:\\docs\\book.pdf');
    await manager.autosaveDirtyTabs();
    expect(roundtrip.writeFile).not.toHaveBeenCalled();
  });

  it('checkActiveExternalChange 跳过 reader 标签（无基线，不弹外部变更对话框）', async () => {
    const rd = makeReaderDeps();
    const confirmReload = vi.fn(async () => 'reload' as ExternalReloadChoice);
    const { manager } = makeHarness({
      ...rd,
      confirmExternalReload: confirmReload,
      statFile: vi.fn(async () => ({
        mtime_ms: 9999,
        size: 100,
        fingerprint: '9999:100',
      })),
    });
    await manager.openReader('C:\\docs\\book.pdf');
    await manager.checkActiveExternalChange();
    expect(confirmReload).not.toHaveBeenCalled();
  });

  it('openReader 缺少 mountReader 依赖时抛出明确错误', async () => {
    const { manager } = makeHarness(); // 不注入 mountReader
    await expect(manager.openReader('C:\\docs\\book.pdf')).rejects.toThrow(/mountReader/);
  });
});

describe('T3 每标签独立滚动位置', () => {
  /** 最小 reader 装配（reader 标签默认滚动位置测试用）。 */
  function mountReaderStub() {
    return vi.fn(async () => ({
      state: {
        phase: 'empty' as const,
        current: 0,
        total: 0,
        progress: 0,
        scale: 1,
        locationKind: null,
      },
      subscribeState: vi.fn(() => () => undefined),
      load: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      addBookmark: vi.fn(() => undefined),
      addNote: vi.fn(() => undefined),
      toggleSidebar: vi.fn(() => undefined),
      setTabActive: vi.fn(() => undefined),
      isSidebarVisible: vi.fn(() => false),
      getOutline: vi.fn(() => []),
      jumpToOutlineItem: vi.fn(() => undefined),
      isAnnotationEnabled: vi.fn(() => false),
      getExportHtml: vi.fn(async () => null),
      advanceReading: vi.fn(() => false),
    }));
  }

  it('新建标签滚动位置为 0（顶部）', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab();
    expect(manager.getScrollPosition(tab.id)).toBe(0);
  });

  it('recordScrollPosition 存储、getScrollPosition 取回', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab();
    manager.recordScrollPosition(tab.id, 123);
    expect(manager.getScrollPosition(tab.id)).toBe(123);
  });

  it('recordScrollPosition 负值夹到 0', async () => {
    const { manager } = makeHarness();
    const tab = await manager.newTab();
    manager.recordScrollPosition(tab.id, -50);
    expect(manager.getScrollPosition(tab.id)).toBe(0);
  });

  it('各标签滚动位置互不影响（A 滚动后切 B→B 在自身原位）', async () => {
    const { manager } = makeHarness();
    const a = await manager.newTab();
    const b = await manager.newTab();
    manager.recordScrollPosition(a.id, 100);
    manager.recordScrollPosition(b.id, 250);
    // 切到 B 再切回 A：各自存储值不变。
    manager.switchTab(b.id);
    manager.switchTab(a.id);
    expect(manager.getScrollPosition(a.id)).toBe(100);
    expect(manager.getScrollPosition(b.id)).toBe(250);
  });

  it('reader 标签默认滚动位置为 0（自有分页不参与）', async () => {
    const { manager } = makeHarness({ mountReader: mountReaderStub() });
    const tab = await manager.openReader('C:\\docs\\book.pdf');
    expect(manager.getScrollPosition(tab.id)).toBe(0);
  });

  it('switchTab 触发 onTabSwitched（恢复滚动的唯一接线点，内容变化不触发）', async () => {
    const onTabSwitched = vi.fn();
    const { manager } = makeHarness({ onTabSwitched });
    const a = await manager.newTab(); // createTab 内 switchTab 已触发一次
    await manager.newTab(); // 再触发一次
    onTabSwitched.mockClear();
    manager.switchTab(a.id);
    expect(onTabSwitched).toHaveBeenCalledTimes(1);
    // 内容变化不应触发 onTabSwitched（否则编辑会重置滚动）。
    a.editor.setMarkdown('改');
    manager.handleContentChanged(a.id);
    expect(onTabSwitched).toHaveBeenCalledTimes(1);
  });

  it('未知 id：getScrollPosition 返回 0、recordScrollPosition 安全无操作', () => {
    const { manager } = makeHarness();
    expect(manager.getScrollPosition('no-such-tab')).toBe(0);
    expect(() => manager.recordScrollPosition('no-such-tab', 50)).not.toThrow();
  });
});
