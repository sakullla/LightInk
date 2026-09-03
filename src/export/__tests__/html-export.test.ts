/**
 * html-export 纯逻辑测试：HTML 文档装配、图片 src 内嵌改写、MIME 推导。
 * 全部依赖以参数注入，node 环境直测（不触达 DOM / Tauri IPC）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildHtmlDocument,
  embedImages,
  escapeHtmlAttr,
  escapeHtmlText,
  isEmbeddableImageSrc,
  mimeFromPath,
  outlineFromHeadingHtml,
  UnsafeCssBoundaryError,
} from '../html-export.js';

describe('buildHtmlDocument', () => {
  it('包含 doctype / charset utf-8 / data-theme / 内嵌样式 / 内容', () => {
    const html = buildHtmlDocument({
      title: '笔记',
      theme: 'dark',
      bodyHtml: '<h1>标题</h1><p>正文</p>',
      cssText: ':root{--x:1}',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<html lang="zh-CN" data-theme="dark">');
    expect(html).toContain('<style>:root{--x:1}</style>');
    expect(html).toContain('<title>笔记</title>');
    expect(html).toContain('<body>\n<h1>标题</h1><p>正文</p>\n</body>');
  });

  it('标题与主题做 HTML 转义；空主题回退 warm-light', () => {
    const html = buildHtmlDocument({
      title: 'a<b>"c"',
      theme: ' ',
      bodyHtml: '',
      cssText: '',
    });
    expect(html).toContain('<title>a&lt;b&gt;"c"</title>');
    expect(html).toContain('data-theme="warm-light"');
    expect(escapeHtmlAttr('x"')).toBe('x&quot;');
    expect(escapeHtmlText('<>&')).toBe('&lt;&gt;&amp;');
  });

  it('代码高亮 / KaTeX 公式 / mermaid SVG 等内容原样携带', () => {
    // 模拟编辑器 DOM 序列化产物中的三类渲染内容。
    const bodyHtml = [
      '<pre><code class="hljs"><span class="hljs-keyword">let</span> x = 1;</code></pre>',
      '<span class="lightink-math-inline"><span class="katex">E=mc²</span></span>',
      '<div class="lightink-mermaid"><svg class="lightink-mermaid-svg"><text>图</text></svg></div>',
    ].join('');
    const html = buildHtmlDocument({
      title: 't',
      theme: 'warm-light',
      bodyHtml,
      cssText: '',
    });
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('<span class="katex">E=mc²</span>');
    expect(html).toContain('<svg class="lightink-mermaid-svg">');
  });

  it('拒绝大小写不敏感的 style 结束边界', () => {
    expect(() =>
      buildHtmlDocument({
        title: 't',
        theme: 'warm-light',
        bodyHtml: '<p>正文</p>',
        cssText: 'body { color: black } /* </StYlE boundary */',
      }),
    ).toThrow(UnsafeCssBoundaryError);
  });
});

describe('outlineFromHeadingHtml', () => {
  it('给标题补稳定 id 并生成目录项', () => {
    const { bodyHtml, outline } = outlineFromHeadingHtml(
      '<h1>设计</h1><p>正文</p><h2>文本层</h2>',
    );
    expect(outline).toEqual([
      { level: 1, text: '设计', id: 'section' },
      { level: 2, text: '文本层', id: 'section-2' },
    ]);
    expect(bodyHtml).toContain('<h1 id="section">设计</h1>');
    expect(bodyHtml).toContain('<h2 id="section-2">文本层</h2>');
  });

  it('保留已有 id，重复标题加后缀', () => {
    const { outline, bodyHtml } = outlineFromHeadingHtml(
      '<h1 id="keep">A</h1><h2>Same</h2><h2>Same</h2>',
    );
    expect(outline.map((item) => item.id)).toEqual(['keep', 'same', 'same-2']);
    expect(bodyHtml).toContain('<h1 id="keep">A</h1>');
  });

  it('includes hidden export bookmarks so cover/illustration chapters stay in the PDF outline', () => {
    const { outline } = outlineFromHeadingHtml(
      '<section><h1 class="lightink-export-bookmark">封面</h1><img src="cover.jpg"></section>' +
        '<section><h1>第一章</h1><p>正文</p></section>',
    );
    expect(outline.map((item) => item.text)).toEqual(['封面', '第一章']);
  });
});

describe('buildHtmlDocument outline', () => {
  it('有目录时写入导航，无目录时不插空 nav', () => {
    const withToc = buildHtmlDocument({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<h1 id="a">A</h1>',
      cssText: '',
      outline: [{ level: 1, text: 'A', id: 'a' }],
    });
    expect(withToc).toContain('lightink-export-toc');
    expect(withToc).toContain('href="#a"');
    const bare = buildHtmlDocument({
      title: 't',
      theme: 'warm-light',
      bodyHtml: '<p>x</p>',
      cssText: '',
    });
    expect(bare).not.toContain('lightink-export-toc');
  });
});

describe('mimeFromPath', () => {
  it('按扩展名推导 MIME，未知回退 octet-stream', () => {
    expect(mimeFromPath('assets/a.png')).toBe('image/png');
    expect(mimeFromPath('assets/b.JPG')).toBe('image/jpeg');
    expect(mimeFromPath('assets/c.jpeg')).toBe('image/jpeg');
    expect(mimeFromPath('assets/d.gif')).toBe('image/gif');
    expect(mimeFromPath('assets/e.webp')).toBe('image/webp');
    expect(mimeFromPath('assets/f.svg')).toBe('image/svg+xml');
    expect(mimeFromPath('assets/no-ext')).toBe('application/octet-stream');
  });
});

describe('isEmbeddableImageSrc', () => {
  it('仅相对路径可内嵌；绝对 URL / data URI / 协议相对保留', () => {
    expect(isEmbeddableImageSrc('assets/a.png')).toBe(true);
    expect(isEmbeddableImageSrc('./assets/a.png')).toBe(true);
    expect(isEmbeddableImageSrc('note-jira-summary-assets/image.png')).toBe(true);
    expect(isEmbeddableImageSrc('https://example.com/a.png')).toBe(false);
    expect(isEmbeddableImageSrc('http://asset.localhost/a.png')).toBe(false);
    expect(isEmbeddableImageSrc('data:image/png;base64,xx')).toBe(false);
    expect(isEmbeddableImageSrc('//cdn.example.com/a.png')).toBe(false);
  });
});

describe('embedImages', () => {
  it('相对 assets 路径改写为 data URI（base64 来自注入 resolver）', async () => {
    const resolve = vi.fn(async () => 'QUJD'); // "ABC"
    const result = await embedImages('<p><img src="assets/a.png" alt="图"></p>', resolve);
    expect(resolve).toHaveBeenCalledWith('assets/a.png');
    expect(result.html).toBe(
      '<p><img src="data:image/png;base64,QUJD" alt="图"></p>',
    );
    expect(result.embedded).toEqual(['assets/a.png']);
    expect(result.missing).toEqual([]);
  });

  it('同级 *-assets 相对路径在 resolver 返回数据时可内嵌', async () => {
    const resolve = vi.fn(async (rel: string) =>
      rel === 'note-jira-summary-assets/image.png' ? 'QUJD' : null,
    );
    const result = await embedImages(
      '<p><img src="note-jira-summary-assets/image.png" alt="图"></p>',
      resolve,
    );
    expect(resolve).toHaveBeenCalledWith('note-jira-summary-assets/image.png');
    expect(result.html).toBe(
      '<p><img src="data:image/png;base64,QUJD" alt="图"></p>',
    );
    expect(result.embedded).toEqual(['note-jira-summary-assets/image.png']);
    expect(result.missing).toEqual([]);
  });

  it('../ 越界路径交给 resolver；拒绝读取时保留原 src', async () => {
    const resolve = vi.fn(async () => null);
    const result = await embedImages('<img src="../secret.png">', resolve);
    expect(resolve).toHaveBeenCalledWith('../secret.png');
    expect(result.html).toBe('<img src="../secret.png">');
    expect(result.missing).toEqual(['../secret.png']);
  });

  it('读取失败（null 或抛错）保留原 src 并记入 missing', async () => {
    const resolve = vi.fn(async (rel: string) =>
      rel === 'assets/ok.png' ? 'QUJD' : null,
    );
    const html = '<img src="assets/ok.png"><img src="assets/gone.png">';
    const result = await embedImages(html, resolve);
    expect(result.html).toContain('src="data:image/png;base64,QUJD"');
    expect(result.html).toContain('src="assets/gone.png"');
    expect(result.missing).toEqual(['assets/gone.png']);

    const throwing = await embedImages('<img src="assets/x.png">', async () => {
      throw new Error('io');
    });
    expect(throwing.html).toBe('<img src="assets/x.png">');
    expect(throwing.missing).toEqual(['assets/x.png']);
  });

  it('绝对 URL 不触达 resolver、原样保留', async () => {
    const resolve = vi.fn(async () => 'QUJD');
    const html = '<img src="https://example.com/a.png"><img src="data:image/png;base64,zz">';
    const result = await embedImages(html, resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(result.html).toBe(html);
  });

  it('同一 src 多处出现只解析一次并全部改写', async () => {
    const resolve = vi.fn(async () => 'QUJD');
    const result = await embedImages(
      '<img src="assets/a.png"><div><img src="assets/a.png"></div>',
      resolve,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.html.match(/data:image\/png;base64,QUJD/g)).toHaveLength(2);
  });

  it('实体编码的 src（innerHTML 序列化产物）先解码再交给 resolver', async () => {
    const resolve = vi.fn(async () => 'QUJD');
    const result = await embedImages('<img src="assets/a&amp;b.png">', resolve);
    // resolver 收到解码后的真实路径，而非 &amp; 编码形式
    expect(resolve).toHaveBeenCalledWith('assets/a&b.png');
    expect(result.embedded).toEqual(['assets/a&b.png']);
    expect(result.html).toBe('<img src="data:image/png;base64,QUJD">');
  });

  it('链式实体不二次解码（&amp;lt; 只解一层）', async () => {
    const resolve = vi.fn(async () => null);
    const result = await embedImages('<img src="assets/a&amp;lt;b.png">', resolve);
    // 磁盘字面名 a&lt;b.png：只解 &amp; → &，不再把 &lt; 解成 <
    expect(resolve).toHaveBeenCalledWith('assets/a&lt;b.png');
    expect(result.missing).toEqual(['assets/a&lt;b.png']);
  });
});
