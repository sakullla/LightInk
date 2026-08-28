// @vitest-environment jsdom
/**
 * 标注动作按 scope 解析（回归：多 Markdown 标签时模块级全局 handler 被最后创建
 * 的标签覆盖，工具条会把标注写进隐藏标签的选区）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendPreviewEditButton } from '../preview-edit-button.js';
import {
  resolveFormatToolbarAnnotationAction,
  setFormatToolbarAnnotationAction,
} from '../format-toolbar.js';

describe('annotation action scoping', () => {
  afterEach(() => {
    for (const el of [...document.body.querySelectorAll('[data-scope-test]')]) {
      setFormatToolbarAnnotationAction(el, null);
    }
  });

  it('resolves per-scope handlers instead of a last-writer-wins global', () => {
    const main = document.createElement('div');
    const tabA = document.createElement('div');
    const editorA = document.createElement('div');
    tabA.appendChild(editorA);
    const tabB = document.createElement('div');
    const editorB = document.createElement('div');
    tabB.appendChild(editorB);
    tabA.dataset.scopeTest = '1';
    tabB.dataset.scopeTest = '1';
    main.append(tabA, tabB);
    document.body.appendChild(main);

    const calls: string[] = [];
    setFormatToolbarAnnotationAction(tabA, (id) => calls.push(`a:${id}`));
    setFormatToolbarAnnotationAction(tabB, (id) => calls.push(`b:${id}`));

    resolveFormatToolbarAnnotationAction(editorA)?.('highlight');
    resolveFormatToolbarAnnotationAction(editorB)?.('note');
    expect(calls).toEqual(['a:highlight', 'b:note']);

    // 未注册区域不命中。
    expect(resolveFormatToolbarAnnotationAction(main)).toBeNull();

    // 销毁一个 scope 只清理自己，其余标签不受影响。
    setFormatToolbarAnnotationAction(tabA, null);
    expect(resolveFormatToolbarAnnotationAction(editorA)).toBeNull();
    resolveFormatToolbarAnnotationAction(editorB)?.('copy');
    expect(calls).toEqual(['a:highlight', 'b:note', 'b:copy']);
  });
});

describe('preview edit button', () => {
  it('provides a labelled keyboard button and dispatches edit once', () => {
    const preview = document.createElement('div');
    const onEdit = vi.fn();
    const button = appendPreviewEditButton(preview, 'Edit source', onEdit);

    expect(button.getAttribute('aria-label')).toBe('Edit source');
    expect(button.getAttribute('title')).toBe('Edit source');
    expect(button.tabIndex).toBe(0);
    button.click();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
