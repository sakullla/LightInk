// @vitest-environment jsdom
/**
 * 链接分类纯逻辑测试（R14）+ R5 打开合同 / 悬停提示 / 修饰键手型。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LINK_HOVER_TOOLTIP_DELAY_MS,
  LINK_HOVER_TOOLTIP_HIDE_GRACE_MS,
  LINK_HREF_TOOLTIP_CLASS,
  LINK_MOD_HELD_CLASS,
  LinkAffordanceController,
  shouldSkipLinkHrefTooltip,
} from '../link-affordance.js';
import {
  classifyLink,
  createLinkNavigationProsePlugin,
  isModifiedClick,
  normalizeExternalHttpUrl,
  resolveLocalPath,
} from '../link-navigation.js';
import type { EditorView } from '@milkdown/prose/view';
import type { Mark } from '@milkdown/prose/model';

describe('classifyLink external', () => {
  it('仅将 http(s) 与协议相对链接归为 external', () => {
    expect(classifyLink('https://example.com/a/b', '/docs').kind).toBe('external');
    expect(classifyLink('http://x.org', '/docs').kind).toBe('external');
    expect(classifyLink('//cdn.example.com/x', '/docs').kind).toBe('external');
  });

  it('external target 规范化且协议相对链接升级为 HTTPS', () => {
    expect(classifyLink('HTTPS://Example.COM', '/docs').target).toBe('https://example.com/');
    expect(classifyLink('//cdn.example.com/x', '/docs').target).toBe(
      'https://cdn.example.com/x',
    );
  });
});

describe('classifyLink localMd', () => {
  it('相对 .md 按当前文档目录解析', () => {
    const r = classifyLink('note.md', '/docs/sub');
    expect(r.kind).toBe('localMd');
    expect(r.target).toBe('/docs/sub/note.md');
  });

  it('绝对 .md 原样返回', () => {
    expect(classifyLink('/abs/note.md', '/docs').target).toBe('/abs/note.md');
    expect(classifyLink('C:\\abs\\note.md', '/docs').target).toBe('C:\\abs\\note.md');
  });

  it('剥锚点/查询后判定扩展名', () => {
    const r = classifyLink('note.md#section', '/docs');
    expect(r.kind).toBe('localMd');
    expect(r.target).toBe('/docs/note.md');
  });

  it('.markdown 扩展名亦归 localMd', () => {
    expect(classifyLink('a.markdown', '/docs').kind).toBe('localMd');
  });
});

describe('classifyLink localFile', () => {
  it('非 .md 本地文件归 localFile', () => {
    const r = classifyLink('image.png', '/docs');
    expect(r.kind).toBe('localFile');
    expect(r.target).toBe('/docs/image.png');
  });
});

describe('classifyLink invalid', () => {
  it('空与纯锚点归 invalid', () => {
    expect(classifyLink('', '/docs').kind).toBe('invalid');
    expect(classifyLink('   ', '/docs').kind).toBe('invalid');
    expect(classifyLink('#anchor', '/docs').kind).toBe('invalid');
  });

  it('拒绝自定义协议、控制字符和编码协议绕过', () => {
    for (const href of [
      'mailto:a@example.com',
      'javascript:alert(1)',
      'file:///tmp/a.md',
      'data:text/html,test',
      'x:custom-target',
      'https://example.com/path\n',
      'https://example.com/%0aheader',
      'javascript%3Aalert(1)',
      '%68%74%74%70%73%3A%2F%2Fevil.example',
      'https://',
    ]) {
      expect(classifyLink(href, '/docs')).toEqual({ kind: 'invalid', target: '' });
    }
  });
});

describe('normalizeExternalHttpUrl', () => {
  it('returns null for direct custom-scheme and encoded-control input', () => {
    expect(normalizeExternalHttpUrl('custom://host')).toBeNull();
    expect(normalizeExternalHttpUrl('https://example.com/%7f')).toBeNull();
  });
});

describe('resolveLocalPath', () => {
  it('无文档目录时相对原样返回', () => {
    expect(resolveLocalPath('note.md', '')).toBe('note.md');
  });

  it('Windows 盘符绝对路径原样返回', () => {
    expect(resolveLocalPath('D:\\files\\x.md', 'C:\\docs')).toBe('D:\\files\\x.md');
  });
});

function mockLinkView(href: string): EditorView {
  const mark = {
    type: { name: 'link' },
    attrs: { href },
  } as unknown as Mark;
  return {
    state: {
      doc: {
        resolve: () => ({
          marks: () => [mark],
        }),
      },
    },
  } as unknown as EditorView;
}

function clickEvent(mods: { ctrlKey?: boolean; metaKey?: boolean }): MouseEvent {
  return {
    ctrlKey: mods.ctrlKey === true,
    metaKey: mods.metaKey === true,
    preventDefault() {
      /* no-op */
    },
  } as MouseEvent;
}

describe('linkNavigationPlugin click contract (R5)', () => {
  it('unmodified click does not navigate', () => {
    const opened: string[] = [];
    const plugin = createLinkNavigationProsePlugin({
      onLinkNavigate: (href) => {
        opened.push(href);
      },
    });
    const handleClick = plugin.props.handleClick;
    expect(handleClick).toBeTypeOf('function');
    const result = handleClick!(
      mockLinkView('https://example.com/docs'),
      1,
      clickEvent({}),
    );
    expect(result).toBe(false);
    expect(opened).toEqual([]);
    expect(isModifiedClick(clickEvent({}))).toBe(false);
  });

  it('Ctrl/Cmd click opens after confirmOpen', async () => {
    const opened: string[] = [];
    const confirmed: string[] = [];
    const plugin = createLinkNavigationProsePlugin({
      onLinkNavigate: (href) => {
        opened.push(href);
      },
      confirmOpen: (href) => {
        confirmed.push(href);
        return true;
      },
    });
    const result = plugin.props.handleClick!(
      mockLinkView('https://example.com/docs'),
      1,
      clickEvent({ ctrlKey: true }),
    );
    expect(result).toBe(true);
    expect(confirmed).toEqual(['https://example.com/docs']);
    await Promise.resolve();
    expect(opened).toEqual(['https://example.com/docs']);
  });
});

describe('link affordance (R5)', () => {
  const hosts: LinkAffordanceController[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const controller of hosts.splice(0)) {
      controller.dispose();
    }
    for (const tip of [...document.body.querySelectorAll(`.${LINK_HREF_TOOLTIP_CLASS}`)]) {
      tip.remove();
    }
    for (const el of [...document.body.querySelectorAll('.ProseMirror')]) {
      el.remove();
    }
  });

  function mountAffordance(html: string): {
    host: HTMLElement;
    link: HTMLAnchorElement;
    controller: LinkAffordanceController;
  } {
    const host = document.createElement('div');
    host.className = 'ProseMirror';
    host.innerHTML = html;
    document.body.appendChild(host);
    const link = host.querySelector('a');
    if (!(link instanceof HTMLAnchorElement)) {
      throw new Error('expected a link');
    }
    const controller = new LinkAffordanceController({ dom: host });
    hosts.push(controller);
    return { host, link, controller };
  }

  it('adds modifier-held class on Ctrl/Cmd and clears it on keyup or blur', () => {
    const { host } = mountAffordance('<p><a href="https://example.com">docs</a></p>');
    expect(host.classList.contains(LINK_MOD_HELD_CLASS)).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true }));
    expect(host.classList.contains(LINK_MOD_HELD_CLASS)).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false, bubbles: true }));
    expect(host.classList.contains(LINK_MOD_HELD_CLASS)).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true }));
    expect(host.classList.contains(LINK_MOD_HELD_CLASS)).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(host.classList.contains(LINK_MOD_HELD_CLASS)).toBe(false);
  });

  it('shows href tooltip after delay, keeps it when pointer enters, and Esc hides without focusing it', () => {
    vi.useFakeTimers();
    const { host, link, controller } = mountAffordance(
      '<p><a href="https://example.com/path">docs</a></p>',
    );
    host.tabIndex = 0;
    host.focus();
    expect(document.activeElement).toBe(host);

    link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(controller.isTooltipVisible()).toBe(false);
    vi.advanceTimersByTime(LINK_HOVER_TOOLTIP_DELAY_MS - 1);
    expect(controller.isTooltipVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.isTooltipVisible()).toBe(true);
    const tooltip = controller.tooltipElement();
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toBe('https://example.com/path');
    expect(tooltip!.tabIndex).toBeLessThan(0);

    link.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: tooltip }),
    );
    tooltip!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    vi.advanceTimersByTime(LINK_HOVER_TOOLTIP_HIDE_GRACE_MS + 20);
    expect(controller.isTooltipVisible()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(controller.isTooltipVisible()).toBe(false);
    expect(document.activeElement).toBe(host);
    expect(document.querySelector('.lightink-link-dialog')).toBeNull();
  });

  it('skips tooltip for a bare URL whose visible text is the href', () => {
    vi.useFakeTimers();
    const { link, controller } = mountAffordance(
      '<p><a href="https://example.com/path">https://example.com/path</a></p>',
    );
    expect(shouldSkipLinkHrefTooltip('https://example.com/path', 'https://example.com/path')).toBe(
      true,
    );
    link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(LINK_HOVER_TOOLTIP_DELAY_MS + 10);
    expect(controller.isTooltipVisible()).toBe(false);
  });
});
