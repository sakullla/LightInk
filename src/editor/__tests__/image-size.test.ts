/**
 * image-size 纯逻辑测试（R12）：序列化/反解析往返、对齐 style 双向、宽度 clamp。
 * schema 装配与 nodeView 属集成面（tsc + 手测），不在此覆盖。
 */
import { describe, expect, it } from 'vitest';

import {
  alignStyle,
  buildImageStyle,
  imageClickIntent,
  isDocumentDirSandboxedSrc,
  parseImageHtml,
  resolveImageOpenHref,
  serializeImageHtml,
} from '../plugins/image-size.js';

describe('image-size 序列化往返（R12）', () => {
  it('无 width/align 序列化为空对齐样式', () => {
    expect(serializeImageHtml({ src: 'a.png', alt: 'x', title: '', width: null, align: null })).toBe(
      '<img src="a.png" alt="x">',
    );
  });

  it('有 width + center → HTML img（width 属性 + 对齐 style）', () => {
    const html = serializeImageHtml({ src: 'a.png', alt: 'x', title: 't', width: 320, align: 'center' });
    expect(html).toBe('<img src="a.png" alt="x" title="t" width="320" style="display:block;margin-left:auto;margin-right:auto">');
  });

  it('right 对齐 style 仅 margin-left auto', () => {
    expect(alignStyle('right')).toBe('display:block;margin-left:auto');
    expect(alignStyle('left')).toBe('display:block');
    expect(alignStyle(null)).toBe('');
  });

  it('parseImageHtml 还原 src/alt/title/width/align（往返闭环）', () => {
    const html = serializeImageHtml({ src: 'p/q.png', alt: '图', title: 'T', width: 200, align: 'center' });
    const parsed = parseImageHtml(html);
    expect(parsed).toEqual({ src: 'p/q.png', alt: '图', title: 'T', width: 200, align: 'center' });
  });

  it('parseImageHtml 还原 right；无对齐 → null', () => {
    expect(parseImageHtml(serializeImageHtml({ src: 'a', alt: '', title: '', width: 100, align: 'right' }))?.align).toBe('right');
    expect(parseImageHtml(serializeImageHtml({ src: 'a', alt: '', title: '', width: 100, align: null }))?.align).toBe(null);
  });

  it('parseImageHtml 兼容 style 内 width；width 来自 style 时也还原', () => {
    const parsed = parseImageHtml('<img src="a.png" alt="x" style="width:250px">');
    expect(parsed?.width).toBe(250);
  });

  it('parseImageHtml 非 img / 无 src 返回 null', () => {
    expect(parseImageHtml('<p>x</p>')).toBe(null);
    expect(parseImageHtml('<img alt="x">')).toBe(null);
    expect(parseImageHtml('')).toBe(null);
  });

  it('宽度 clamp 到 [40, 4000]', () => {
    expect(parseImageHtml('<img src="a" width="5">')?.width).toBe(40);
    expect(parseImageHtml('<img src="a" width="99999">')?.width).toBe(4000);
    expect(buildImageStyle(120, null)).toContain('width:120px');
  });

  it('buildImageStyle 合并 width + 对齐', () => {
    expect(buildImageStyle(300, 'center')).toBe('width:300px;display:block;margin-left:auto;margin-right:auto');
    expect(buildImageStyle(null, null)).toBe('');
  });

  it('属性值转义（引号/尖括号不破坏标签）', () => {
    const html = serializeImageHtml({ src: 'a"b.png', alt: 'x<y>', title: '', width: null, align: null });
    expect(html).toContain('src="a&quot;b.png"');
    expect(html).toContain('alt="x&lt;y&gt;"');
    expect(parseImageHtml(html)?.alt).toBe('x<y>');
  });
});

describe('image click intent（R4 / ADR-4）', () => {
  const docPath = 'C:/notes/note.md';

  it('普通点击始终 select，不打开', () => {
    expect(imageClickIntent({ ctrlKey: false, metaKey: false }, 'assets/a.png', docPath)).toBe(
      'select',
    );
    expect(
      imageClickIntent(
        { ctrlKey: false, metaKey: false },
        'note-jira-summary-assets/image.png',
        docPath,
      ),
    ).toBe('select');
  });

  it('Ctrl/Cmd+点击已保存文档内相对图 → open', () => {
    expect(imageClickIntent({ ctrlKey: true, metaKey: false }, 'assets/a.png', docPath)).toBe(
      'open',
    );
    expect(
      imageClickIntent(
        { ctrlKey: false, metaKey: true },
        'note-jira-summary-assets/image.png',
        docPath,
      ),
    ).toBe('open');
    expect(resolveImageOpenHref('note-jira-summary-assets/image.png', docPath)).toBe(
      'note-jira-summary-assets/image.png',
    );
  });

  it('远程图、未保存、../ 不打开', () => {
    expect(
      imageClickIntent({ ctrlKey: true, metaKey: false }, 'https://example.com/a.png', docPath),
    ).toBe('select');
    expect(imageClickIntent({ ctrlKey: true, metaKey: false }, 'assets/a.png', null)).toBe(
      'select',
    );
    expect(imageClickIntent({ ctrlKey: true, metaKey: false }, '../secret.png', docPath)).toBe(
      'select',
    );
    expect(resolveImageOpenHref('../secret.png', docPath)).toBe(null);
    expect(resolveImageOpenHref('assets/a.png', null)).toBe(null);
    expect(isDocumentDirSandboxedSrc('../secret.png')).toBe(false);
    expect(isDocumentDirSandboxedSrc('\\\\server\\share\\a.png')).toBe(false);
    expect(isDocumentDirSandboxedSrc('C:/pics/a.png')).toBe(false);
    expect(isDocumentDirSandboxedSrc('note-assets/image.png')).toBe(true);
  });
});
