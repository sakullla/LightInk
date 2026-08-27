// @vitest-environment jsdom

/**
 * 流式格式解析测试（ebook-reader T4）。
 *
 * 纯函数单测：sanitize、TXT（UTF-8/GBK 回退）、FB2（XML→HTML）、EPUB（jszip 合成
 * 最小 epub）、MOBI（合成最小 PalmDOC，含 DRM 报错）。
 */
import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

import { sanitizeHtml, sanitizeParsedHtml } from '../sanitize.js';
import { parseEpub } from '../formats/epub.js';
import { parseFb2 } from '../formats/fb2.js';
import { parseMobi } from '../formats/mobi.js';
import { parseTxt, parseTxtFromSource } from '../formats/txt.js';
import { injectEncodingSniffOrder } from '../formats/text-encoding.js';
import type { ReaderByteSource } from '../formats/types.js';
import { isRandomAccessSource, type RandomAccessSource } from '../sources/types.js';
import { injectReaderLimit } from '../reader-limits.js';
import { ParseError, ReaderCapabilityError, ReaderLimitError } from '../formats/types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('sanitizeHtml', () => {
  it('移除 script/style 与注释', () => {
    expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
    expect(sanitizeHtml('<style>x{}</style><b>bold</b>')).toBe('<b>bold</b>');
    expect(sanitizeHtml('a<!-- secret -->b')).toBe('ab');
  });

  it('移除事件处理器属性并拒绝危险 URL 协议', () => {
    const out = sanitizeHtml('<a onclick="evil()" href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('javascript');
  });

  it('按 DOM 解码后的值拒绝协议绕过和危险属性', () => {
    const out = sanitizeHtml(
      '<a href="jav&#x61;script:alert(1)" style="position:fixed" ping="https://track">x</a>' +
        '<img src="data:text/html;base64,PHNjcmlwdD4=" srcset="https://remote/x 2x" onerror="x">',
    );
    expect(out).toBe('<a>x</a><img>');
  });

  it('removes active containers, forms, SVG, and unknown elements', () => {
    const out = sanitizeHtml(
      '<form><input value="secret"><p>kept</p></form>' +
        '<svg><script>alert(1)</script><circle></circle></svg>' +
        '<custom-element><strong>text</strong></custom-element>',
    );
    expect(out).not.toMatch(/form|input|svg|script|circle|custom-element/i);
    expect(out).toContain('<p>kept</p>');
    expect(out).toContain('<strong>text</strong>');
  });

  it('keeps safe relative, fragment, and HTTP links', () => {
    const out = sanitizeHtml(
      '<a href="chapter-2.xhtml#part">next</a>' +
        '<a href="#footnote">note</a>' +
        '<a href="https://example.com/read">web</a>',
    );
    expect(out).toContain('href="chapter-2.xhtml#part"');
    expect(out).toContain('href="#footnote"');
    expect(out).toContain('href="https://example.com/read"');
  });

  it('makes remote images inert while preserving local image sources', () => {
    const container = document.createElement('div');
    container.innerHTML = sanitizeHtml(
      '<img alt="remote" src="https://cdn.example/book.png" srcset="https://cdn.example/book@2x.png 2x">' +
        '<img alt="relative" src="images/cover.png">' +
        '<img alt="inline" src="data:image/png;base64,iVBORw0KGgo=">',
    );

    const images = container.querySelectorAll('img');
    expect(images[0]!.getAttribute('src')).toBeNull();
    expect(images[0]!.getAttribute('srcset')).toBeNull();
    expect(images[0]!.getAttribute('data-lightink-remote-src')).toBe(
      'https://cdn.example/book.png',
    );
    expect(images[1]!.getAttribute('src')).toBe('images/cover.png');
    expect(images[2]!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('保留阅读格式标签', () => {
    const out = sanitizeHtml('<h1>T</h1><p>a <strong>b</strong> <em>c</em></p><blockquote>q</blockquote>');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>c</em>');
    expect(out).toContain('<blockquote>q</blockquote>');
  });

  it('原位消毒已解析的 EPUB 章节且保持同一安全策略', () => {
    const parsed = document.createElement('main');
    parsed.innerHTML =
      '<p onclick="evil()">safe<script>evil()</script></p>' +
      '<img src="https://remote.example/cover.jpg">';
    const out = sanitizeParsedHtml(parsed);
    expect(out).toContain('<p>safe</p>');
    expect(out).not.toMatch(/onclick|script|<img[^>]*\ssrc="https:/i);
    expect(out).toContain('data-lightink-remote-src="https://remote.example/cover.jpg"');
  });
});

describe('parseTxt', () => {
  it('UTF-8 文本按空行分段为单章', () => {
    const content = parseTxt(enc('First line\nSecond line\n\nSecond para'));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.html).toContain('<p>First line<br>Second line</p>');
    expect(content.chapters[0]!.html).toContain('<p>Second para</p>');
  });

  it('转义 HTML 特殊字符', () => {
    const content = parseTxt(enc('a < b & c > d'));
    expect(content.chapters[0]!.html).toContain('a &lt; b &amp; c &gt; d');
  });

  it('非 UTF-8 文本回退 GBK（运行时支持 GBK 时）', () => {
    // “中文”的 GBK 编码（0xD6 0xD0 0xCE 0xC4），不是合法 UTF-8。
    const gbkBuf = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    let gbkDecoded = false;
    try {
      new TextDecoder('gbk'); // 探测运行时是否支持 GBK
      gbkDecoded = true;
    } catch {
      gbkDecoded = false;
    }
    if (!gbkDecoded) {
      return; // 运行时无 GBK，跳过本例（UTF-8 兜底路径在其它用例覆盖）。
    }
    const content = parseTxt(gbkBuf);
    expect(content.chapters[0]!.html).toContain('中文');
  });
});

describe('parseTxtFromSource（T8 分块解析）', () => {
  /** 把整读字节包装成 ReaderByteSource（短块 = EOF，模拟生产 read_file_bytes 分块）。 */
  const sourceFromBytes = (bytes: Uint8Array): ReaderByteSource => ({
    read: async (offset, length) =>
      bytes.subarray(offset, Math.min(offset + length, bytes.length)),
  });

  it('空文件产出空单章', async () => {
    const content = await parseTxtFromSource(sourceFromBytes(new Uint8Array()));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.html).toBe('');
  });

  it('跨块分段与整读结果一致（多种块大小）', async () => {
    const text = '第一段 中文\n第二行\r\n\r\nsecond para\n\n\nthird 段末';
    const expected = parseTxt(enc(text)).chapters[0]!.html;
    // 块大小 1..7 覆盖多字节字符/段落边界/\r\n 的各种跨块切法。
    for (let chunkBytes = 1; chunkBytes <= 7; chunkBytes += 1) {
      const content = await parseTxtFromSource(sourceFromBytes(enc(text)), undefined, {
        chunkBytes,
      });
      expect(content.chapters).toHaveLength(1);
      expect(content.chapters[0]!.html).toBe(expected);
    }
  });

  it('跨块 \\r\\n 不裂成空行', async () => {
    // "a\r" | "\nb"：\r\n 跨块仍是一次换行，不产生段落边界。
    const bytes = enc('a\r\nb');
    const content = await parseTxtFromSource(sourceFromBytes(bytes), undefined, {
      chunkBytes: 2,
    });
    expect(content.chapters[0]!.html).toBe('<p>a<br>b</p>');
  });

  it('GBK 字节经首块嗅探后流式解码（运行时支持 GBK 时）', async () => {
    let gbkDecoded = false;
    try {
      new TextDecoder('gbk');
      gbkDecoded = true;
    } catch {
      gbkDecoded = false;
    }
    if (!gbkDecoded) {
      return;
    }
    // “中文中文” GBK：首块 4 字节（完整两字）用于嗅探，后续跨块续解码。
    const gbkBuf = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xd6, 0xd0, 0xce, 0xc4]);
    const content = await parseTxtFromSource(sourceFromBytes(gbkBuf), undefined, {
      chunkBytes: 4,
    });
    expect(content.chapters[0]!.html).toContain('中文中文');
  });

  it('嗅探截断点落在多字节字符内部仍判定 UTF-8（>64 KiB 回归）', async () => {
    // 65534 个 ASCII 后接 '中'（E4 B8 AD）：64 KiB 嗅探窗口尾恰好留下 E4 B8，
    // 该残留是完整合法的 GBK 对——修复前 utf-8 分支因截断误判失败、label 误落
    // gbk，整书按 GBK 解码成乱码。stream 模式嗅探挂起尾部不完整序列后不误判。
    const text = `${'a'.repeat(65534)}中\n\n结尾段`;
    const bytes = enc(text);
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    const expected = parseTxt(bytes).chapters[0]!.html;
    const content = await parseTxtFromSource(sourceFromBytes(bytes));
    expect(content.chapters[0]!.html).toBe(expected);
    expect(content.chapters[0]!.html).toContain('中');
  });

  it('读取间响应取消信号', async () => {
    const controller = new AbortController();
    let reads = 0;
    const source: ReaderByteSource = {
      read: async (_offset, length) => {
        reads += 1;
        if (reads > 1) {
          controller.abort();
        }
        return enc('x'.repeat(Math.min(length, 4)));
      },
    };
    await expect(
      parseTxtFromSource(source, controller.signal, { chunkBytes: 4 }),
    ).rejects.toThrow();
  });

  it('分块路径与整读共用同一转义（escapeHtml 单点）', async () => {
    // shared-utils：txt 分段与整读成章引用同一 escapeHtml——含 & < > 的段落
    // 在两条路径下产出一致，无第二份转义实现。
    const text = 'a < b & c > d';
    const expected = parseTxt(enc(text)).chapters[0]!.html;
    const content = await parseTxtFromSource(sourceFromBytes(enc(text)), undefined, {
      chunkBytes: 3,
    });
    expect(content.chapters[0]!.html).toBe(expected);
    expect(content.chapters[0]!.html).toContain('a &lt; b &amp; c &gt; d');
  });
});

describe('isRandomAccessSource 字节源判定单点（shared-utils）', () => {
  it('暴露 readRange 的源判真，整读字节与分块 read 源判否', () => {
    const random: RandomAccessSource = {
      size: 4,
      identity: { id: 'probe' },
      readRange: async () => new Uint8Array(4),
      close: async () => undefined,
    };
    expect(isRandomAccessSource(random)).toBe(true);
    expect(isRandomAccessSource(new Uint8Array(4))).toBe(false);
    expect(isRandomAccessSource({ read: async () => new Uint8Array(4) })).toBe(false);
    expect(isRandomAccessSource({})).toBe(false);
  });
});

describe('parseFb2', () => {
  const fb2 = `<?xml version="1.0"?>
<FictionBook>
<description><title-info><book-title>FB2 书名</book-title></title-info></description>
<body>
<section><title><p>第一章</p></title><p>你好 <emphasis>世界</emphasis></p></section>
<section><title><p>第二章</p></title><p>第二 <strong>加粗</strong></p></section>
</body>
</FictionBook>`;

  it('每个 section 成一章，标题取自 <title>', () => {
    const content = parseFb2(enc(fb2));
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.title).toBe('第一章');
    expect(content.chapters[1]!.title).toBe('第二章');
  });

  it('FB2 语义标签转为 HTML', () => {
    const content = parseFb2(enc(fb2));
    expect(content.chapters[0]!.html).toContain('<em>世界</em>');
    expect(content.chapters[1]!.html).toContain('<strong>加粗</strong>');
  });

  it('恢复允许的 embedded image，并在 dispose 时释放 URL', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:fb2-cover',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = parseFb2(
        enc(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
  <body><section><title><p>图章</p></title><p>正文</p><image l:href="#cover"/></section></body>
  <binary id="cover" content-type="image/png">aGVsbG8=</binary>
</FictionBook>`),
      );
      const body = document.createElement('div');
      body.innerHTML = content.chapters[0]!.html;
      expect(body.querySelector('img')?.getAttribute('src')).toBe('blob:fb2-cover');
      const exported = await content.embedExportImages?.(
        `<img src="blob:fb2-cover">`,
      );
      expect(exported?.missing).toEqual([]);
      expect(exported?.html).toContain('data:image/png;base64,aGVsbG8=');
      content.dispose?.();
      content.dispose?.();
      expect(revoked).toEqual(['blob:fb2-cover']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('拒绝损坏 XML，且不物化不允许的图片 MIME', () => {
    expect(() => parseFb2(enc('<FictionBook><body>'))).toThrow(ParseError);
    const content = parseFb2(
      enc(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
  <body><section><image l:href="#vector"/></section></body>
  <binary id="vector" content-type="image/svg+xml">PHN2Zy8+</binary>
</FictionBook>`),
    );
    expect(content.chapters[0]!.html).not.toContain('<img');
  });

  it('GBK 编码的 FB2 经共享嗅探解码为可读文本（D1 行为差）', () => {
    let gbkDecoded = false;
    try {
      new TextDecoder('gbk');
      gbkDecoded = true;
    } catch {
      gbkDecoded = false;
    }
    if (!gbkDecoded) {
      return; // 运行时无 GBK，跳过本例（UTF-8 兜底路径在其它用例覆盖）。
    }
    // “第一章”(B5DA D2BB D5C2) 与 “正文”(D5FD CEC4) 的 GBK 字节 + ASCII 结构。
    const gbkBytes = new Uint8Array([
      ...enc('<?xml version="1.0"?>\n<FictionBook><body>'),
      ...enc('<section><title><p>'),
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2,
      ...enc('</p></title><p>'),
      0xd5, 0xfd, 0xce, 0xc4,
      ...enc('</p></section></body></FictionBook>'),
    ]);
    const content = parseFb2(gbkBytes);
    expect(content.chapters[0]!.title).toBe('第一章');
    expect(content.chapters[0]!.html).toContain('<p>正文</p>');
  });

  it('UTF-8 与 GBK 均无法解码的字节按 UTF-8 尽力显示，不抛新错误', () => {
    // 0xFF 在两种编码下都非法：嗅探落回 UTF-8，标题显示替换字符且照常成章。
    const bytes = new Uint8Array([
      ...enc('<?xml version="1.0"?>\n<FictionBook><body>'),
      ...enc('<section><title><p>'),
      0xff, 0xff,
      ...enc('</p></title><p>ok</p></section></body></FictionBook>'),
    ]);
    const content = parseFb2(bytes);
    expect(content.chapters[0]!.title).toContain('�');
    expect(content.chapters[0]!.html).toContain('<p>ok</p>');
  });
});

describe('parseEpub', () => {
  async function buildEpub(withResources = false, withPadding = false): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package>' +
            '<metadata><dc:title>EPUB 书名</dc:title></metadata>' +
            '<manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
            (withResources
              ? '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
                '<item id="css" href="styles/book.css" media-type="text/css"/>'
              : '') +
            '</manifest>' +
            '<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>' +
            '</package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第一章</title></head><body><h1>一</h1><p>甲</p>' +
            (withResources
              ? '<img src="images/pic.png" alt="cover">' +
                '<a href="ch2.xhtml#destination">下一章</a>'
              : '') +
            '</body></html>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch2.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第二章</title></head><body>' +
            '<h1 id="destination">二</h1><p>乙</p></body></html>',
        ),
      ),
    );
    if (withResources) {
      await zip.add(
        'OEBPS/images/pic.png',
        new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
        { level: 0 },
      );
      await zip.add(
        'OEBPS/styles/book.css',
        new Uint8ArrayReader(
          enc('@import url("https://evil.example/x.css"); body { color: red; background: url(cover.png); }'),
        ),
      );
    }
    if (withPadding) {
      await zip.add(
        'OEBPS/unreferenced.bin',
        new Uint8ArrayReader(new Uint8Array(256 * 1024)),
        { level: 0 },
      );
    }
    return zip.close();
  }

  /** 两章共享同一图片的最小 EPUB（OEBPS/images/pic.png 被 ch1/ch2 同时引用）。 */
  async function buildSharedImageEpub(): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package>' +
            '<manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
            '</manifest>' +
            '<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>' +
            '</package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc('<html><body><p>一</p><img src="images/pic.png"></body></html>'),
      ),
    );
    await zip.add(
      'OEBPS/ch2.xhtml',
      new Uint8ArrayReader(
        enc('<html><body><p>二</p><img src="images/pic.png"></body></html>'),
      ),
    );
    await zip.add(
      'OEBPS/images/pic.png',
      new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      { level: 0 },
    );
    return zip.close();
  }

  async function buildLargeEpub(chapterCount = 66): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
      ),
    );
    const manifest = Array.from(
      { length: chapterCount },
      (_, index) => `<item id="c${index}" href="c${index}.xhtml" media-type="application/xhtml+xml"/>`,
    ).join('');
    const spine = Array.from(
      { length: chapterCount },
      (_, index) => `<itemref idref="c${index}"/>`,
    ).join('');
    await zip.add(
      'OPS/book.opf',
      new Uint8ArrayReader(
        enc(
          `<package><manifest>${manifest}` +
            '<item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
            `</manifest><spine>${spine}</spine></package>`,
        ),
      ),
    );
    const navigation = Array.from(
      { length: chapterCount },
      (_, index) =>
        `<navPoint><navLabel><text>目录 ${index + 1}</text></navLabel>` +
        `<content src="c${index}.xhtml"/></navPoint>`,
    ).join('');
    await zip.add(
      'OPS/toc.ncx',
      new Uint8ArrayReader(enc(`<ncx><navMap>${navigation}</navMap></ncx>`)),
    );
    for (let index = 0; index < chapterCount; index += 1) {
      await zip.add(
        `OPS/c${index}.xhtml`,
        new Uint8ArrayReader(
          enc(`<html><head><title>正文 ${index + 1}</title></head><body><p>${index + 1}</p></body></html>`),
        ),
      );
    }
    return zip.close();
  }

  it('按 spine 顺序解析章节并消毒', async () => {
    const content = await parseEpub(await buildEpub());
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.title).toBe('第一章');
    expect(content.chapters[0]!.html).toContain('<h1>一</h1>');
    expect(content.chapters[1]!.title).toBe('第二章');
    expect(content.chapters[1]!.html).toContain('<p>乙</p>');
  });

  it('keeps NCX/heading titles and strips junk converter <title> text from the body', async () => {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package>' +
            '<manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
            '</manifest><spine><itemref idref="ch1"/></spine></package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/toc.ncx',
      new Uint8ArrayReader(
        enc(
          '<ncx><navMap><navPoint><navLabel><text>第4章 白月光</text></navLabel>' +
            '<content src="ch1.xhtml"/></navPoint></navMap></ncx>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>ccdqxkhp</title></head><body>' +
            '<p>ccdqxkhp</p><h1>第4章 白月光（求收藏）</h1><p>正文</p></body></html>',
        ),
      ),
    );
    const content = await parseEpub(await zip.close());
    expect(content.chapters[0]!.title).toBe('第4章 白月光（求收藏）');
    expect(content.chapters[0]!.html).toContain('第4章 白月光（求收藏）');
    expect(content.chapters[0]!.html).not.toContain('ccdqxkhp');
  });

  it('通过带有界预读的随机源解析 EPUB，并合并相邻 ZIP 读取', async () => {
    const bytes = await buildEpub(true, true);
    const reads: Array<{ offset: number; length: number }> = [];
    const source: RandomAccessSource = {
      size: bytes.length,
      identity: { id: 'epub-range' },
      readRange: async (offset, length) => {
        reads.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
      close: async () => undefined,
    };
    const content = await parseEpub(source);
    expect(content.chapters).toHaveLength(2);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(6);
    expect(reads.every((read) => read.length <= Math.min(bytes.length, 8 * 1024 * 1024))).toBe(true);
    expect(reads.every((read) => read.offset >= 0 && read.offset + read.length <= bytes.length)).toBe(
      true,
    );
    content.dispose?.();
  });

  it('大型 EPUB 首次只物化前两章，并保留 NCX 目录供按需章节使用', async () => {
    const content = await parseEpub(await buildLargeEpub());
    expect(content.chapters).toHaveLength(66);
    expect(content.chapters[0]!.html).toContain('<p>1</p>');
    expect(content.chapters[1]!.html).toContain('<p>2</p>');
    expect(content.chapters[2]!.html).toBe('');
    expect(content.chapters[65]!.title).toBe('目录 66');

    await content.chapters[65]!.load?.();

    expect(content.chapters[65]!.title).toBe('正文 66');
    expect(content.chapters[65]!.html).toContain('<p>66</p>');
    content.dispose?.();
  });

  it('远程随机源首次只物化前两章，且 ZIP 预读不超过半兆', async () => {
    const bytes = await buildLargeEpub(10);
    const reads: Array<{ offset: number; length: number }> = [];
    const source: RandomAccessSource = {
      size: bytes.length,
      identity: { id: 'epub-remote' },
      access: 'remote',
      readRange: async (offset, length) => {
        reads.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
      close: async () => undefined,
    };
    const content = await parseEpub(source);
    expect(content.chapters).toHaveLength(10);
    expect(content.chapters[0]!.html).toContain('<p>1</p>');
    expect(content.chapters[1]!.html).toContain('<p>2</p>');
    expect(content.chapters[2]!.html).toBe('');
    expect(content.chapters[9]!.html).toBe('');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.length <= 512 * 1024)).toBe(true);
    await content.chapters[9]!.load?.();
    expect(content.chapters[9]!.html).toContain('<p>10</p>');
    content.dispose?.();
  });

  it('损坏 zip 抛 ParseError', async () => {
    await expect(parseEpub(new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(ParseError);
  });

  it('把 svg/image 包装的包内位图改写成 img，并保留已有 blob 图', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    let created = 0;
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:epub-svg-${(created += 1)}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const zip = new ZipWriter(new Uint8ArrayWriter());
      await zip.add(
        'META-INF/container.xml',
        new Uint8ArrayReader(
          enc(
            '<?xml version="1.0"?><container><rootfiles>' +
              '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
              '</rootfiles></container>',
          ),
        ),
      );
      await zip.add(
        'OEBPS/content.opf',
        new Uint8ArrayReader(
          enc(
            '<?xml version="1.0"?><package>' +
              '<metadata><dc:title>插图书</dc:title></metadata>' +
              '<manifest>' +
              '<item id="ch1" href="Text/chapter0.xhtml" media-type="application/xhtml+xml" properties="svg"/>' +
              '<item id="pic" href="Images/205393.jpg" media-type="image/jpeg"/>' +
              '<item id="css" href="Styles/style.css" media-type="text/css"/>' +
              '</manifest>' +
              '<spine><itemref idref="ch1"/></spine>' +
              '</package>',
          ),
        ),
      );
      await zip.add(
        'OEBPS/Text/chapter0.xhtml',
        new Uint8ArrayReader(
          enc(
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>插图</title></head><body>' +
              '<figure class="illust">' +
              '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 796 1200">' +
              '<image width="796" height="1200" xlink:href="../Images/205393.jpg"/>' +
              '</svg></figure></body></html>',
          ),
        ),
      );
      await zip.add(
        'OEBPS/Images/205393.jpg',
        new Uint8ArrayReader(new Uint8Array([0xff, 0xd8, 0xff, 0xdb])),
        { level: 0 },
      );
      await zip.add('OEBPS/Styles/style.css', new Uint8ArrayReader(enc('body{margin:0}')));
      const content = await parseEpub(await zip.close());
      const body = document.createElement('div');
      body.innerHTML = content.chapters[0]!.html;
      expect(body.querySelector('svg')).toBeNull();
      const image = body.querySelector('img');
      // T8：parse 期不物化——占位 src 为包内规范路径，零 object URL。
      expect(created).toBe(0);
      expect(image?.getAttribute('src')).toBe('OEBPS/Images/205393.jpg');
      expect(image?.getAttribute('width')).toBe('796');
      expect(content.warnings).toBeUndefined();
      expect(content.stylesheet).toContain('body{margin:0}');
      // 懒物化：resolveResources 解压并换 blob URL；dispose 兜底 revoke。
      const frameDoc = document.implementation.createHTMLDocument('');
      frameDoc.body.innerHTML = content.chapters[0]!.html;
      await content.chapters[0]!.resolveResources?.(frameDoc);
      expect(frameDoc.querySelector('img')?.getAttribute('src')).toBe('blob:epub-svg-1');
      expect(created).toBe(1);
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-svg-1']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('解析包内图片占位与章节链接；懒物化与释放配对 revoke', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:epub-cover',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = await parseEpub(await buildEpub(true));
      const body = document.createElement('div');
      body.innerHTML = content.chapters[0]!.html;
      // T8：parse 期不物化——img 保留包内规范路径占位，章节链接改写不变。
      expect(body.querySelector('img')?.getAttribute('src')).toBe('OEBPS/images/pic.png');
      expect(body.querySelector('a')?.getAttribute('href')).toBe(
        '#lightink-chapter?chapter=1&target=destination',
      );
      expect(content.warnings).toBeUndefined();
      expect(content.stylesheet).toContain('body { color: red; background: none; }');
      expect(content.stylesheet).not.toMatch(/@import|url\(/i);

      const frameDoc = document.implementation.createHTMLDocument('');
      frameDoc.body.innerHTML = content.chapters[0]!.html;
      await content.chapters[0]!.resolveResources?.(frameDoc);
      expect(frameDoc.querySelector('img')?.getAttribute('src')).toBe('blob:epub-cover');
      // 离屏释放：src 还原占位路径并配对 revoke；幂等。
      content.chapters[0]!.releaseResources?.(frameDoc);
      expect(frameDoc.querySelector('img')?.getAttribute('src')).toBe('OEBPS/images/pic.png');
      expect(revoked).toEqual(['blob:epub-cover']);
      content.chapters[0]!.releaseResources?.(frameDoc);
      expect(revoked).toEqual(['blob:epub-cover']);
      // 再次进入视口可重新物化；dispose 兜底 revoke。
      await content.chapters[0]!.resolveResources?.(frameDoc);
      expect(frameDoc.querySelector('img')?.getAttribute('src')).toBe('blob:epub-cover');
      const inlined = await content.embedExportImages?.(
        `<img src="OEBPS/images/pic.png"><img src="blob:epub-cover">`,
        'inline',
      );
      expect(inlined?.missing).toEqual([]);
      expect(inlined?.html).toContain('data:image/png;base64,');
      expect(inlined?.html).not.toContain('OEBPS/images/pic.png');
      const asBlob = await content.embedExportImages?.('<img src="OEBPS/images/pic.png">', 'blob');
      expect(asBlob?.missing).toEqual([]);
      expect(asBlob?.html).toContain('blob:epub-cover');
      expect(asBlob?.html).not.toContain('OEBPS/images/pic.png');
      content.dispose?.();
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-cover', 'blob:epub-cover']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('跨章共享图片按引用计数持有，全部释放后才 revoke', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    let created = 0;
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:epub-shared-${(created += 1)}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = await parseEpub(await buildSharedImageEpub());
      expect(created).toBe(0); // parse 期不物化
      const doc1 = document.implementation.createHTMLDocument('');
      doc1.body.innerHTML = content.chapters[0]!.html;
      const doc2 = document.implementation.createHTMLDocument('');
      doc2.body.innerHTML = content.chapters[1]!.html;
      await content.chapters[0]!.resolveResources?.(doc1);
      await content.chapters[1]!.resolveResources?.(doc2);
      // 同一图片两章共享：只解压/物化一次。
      expect(created).toBe(1);
      expect(doc1.querySelector('img')?.getAttribute('src')).toBe('blob:epub-shared-1');
      expect(doc2.querySelector('img')?.getAttribute('src')).toBe('blob:epub-shared-1');
      // 释放第一章：仍有第二章引用，不 revoke。
      content.chapters[0]!.releaseResources?.(doc1);
      expect(revoked).toEqual([]);
      expect(doc2.querySelector('img')?.getAttribute('src')).toBe('blob:epub-shared-1');
      // 两章都释放后引用计数归零才 revoke。
      content.chapters[1]!.releaseResources?.(doc2);
      expect(revoked).toEqual(['blob:epub-shared-1']);
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-shared-1']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('跨章并发 resolve 共享图只物化一次（in-flight 去重，无 blob 泄漏）', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    let created = 0;
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:epub-conc-${(created += 1)}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = await parseEpub(await buildSharedImageEpub());
      const doc1 = document.implementation.createHTMLDocument('');
      doc1.body.innerHTML = content.chapters[0]!.html;
      const doc2 = document.implementation.createHTMLDocument('');
      doc2.body.innerHTML = content.chapters[1]!.html;
      // 两章并发 resolve 同一图片：未做 in-flight 去重时双方都在首个 await 前
      // 看不到 materialized 占位，会双重解压并产生一个无记账的泄漏 blob URL。
      await Promise.all([
        content.chapters[0]!.resolveResources?.(doc1),
        content.chapters[1]!.resolveResources?.(doc2),
      ]);
      expect(created).toBe(1);
      expect(doc1.querySelector('img')?.getAttribute('src')).toBe('blob:epub-conc-1');
      expect(doc2.querySelector('img')?.getAttribute('src')).toBe('blob:epub-conc-1');
      // 引用计数 = 2：逐章释放，归零才 revoke；dispose 幂等不重复 revoke。
      content.chapters[0]!.releaseResources?.(doc1);
      expect(revoked).toEqual([]);
      content.chapters[1]!.releaseResources?.(doc2);
      expect(revoked).toEqual(['blob:epub-conc-1']);
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-conc-1']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('快路径 await 窗口内并发 release 吊销共享条目后重新物化（不装破图）', async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    let created = 0;
    const revoked: string[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => `blob:epub-race-${(created += 1)}`,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => revoked.push(url),
    });
    try {
      const content = await parseEpub(await buildSharedImageEpub());
      const doc1 = document.implementation.createHTMLDocument('');
      doc1.body.innerHTML = content.chapters[0]!.html;
      const doc2 = document.implementation.createHTMLDocument('');
      doc2.body.innerHTML = content.chapters[1]!.html;
      await content.chapters[0]!.resolveResources?.(doc1);
      expect(created).toBe(1);
      // 快路径回归:materializeOne 命中已物化条目,await 让出微任务;在 map 查找与
      // refs++/setAttribute 之间插入另一章的 release——共享条目被 revoke 并孤儿化。
      const pending = content.chapters[1]!.resolveResources?.(doc2);
      content.chapters[0]!.releaseResources?.(doc1);
      expect(revoked).toEqual(['blob:epub-race-1']);
      await pending;
      // continuation 校验条目仍受记账,孤儿化则重新物化,不把已吊销 URL 装进 img。
      expect(doc2.querySelector('img')?.getAttribute('src')).toBe('blob:epub-race-2');
      expect(created).toBe(2);
      content.chapters[1]!.releaseResources?.(doc2);
      expect(revoked).toEqual(['blob:epub-race-1', 'blob:epub-race-2']);
      content.dispose?.();
      expect(revoked).toEqual(['blob:epub-race-1', 'blob:epub-race-2']);
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });
});

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
/** ASCII 字符串填充到固定长度（其余填零）。 */
function asciiPadded(s: string, len: number): number[] {
  const out = new Array(len).fill(0);
  for (let i = 0; i < s.length && i < len; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}
/** ASCII 字符串字节（无填充）。 */
function asciiCodes(s: string): number[] {
  return [...s].map((ch) => ch.charCodeAt(0) & 0xff);
}
function concat(parts: Array<number[] | Uint8Array>): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    for (const b of p) {
      flat.push(b);
    }
  }
  return new Uint8Array(flat);
}

/** 合成最小 PalmDOC MOBI。record 默认为 html 的 UTF-8（compression=1）；可传压缩记录（compression=2）。 */
function buildMobi(
  html: string,
  opts: {
    encryption?: number;
    compression?: number;
    record?: number[];
    textLength?: number;
    fileVersion?: number;
  } = {},
): Uint8Array {
  const encryption = opts.encryption ?? 0;
  const compression = opts.compression ?? 1;
  const record = opts.record ?? [...enc(html)];
  const textLength = opts.textLength ?? record.length;
  const header = asciiPadded('TESTBOOK', 78); // 78 字节 PalmDB 头（name 占 32，其余填零）
  header[76] = u16(2)[0]!; // numRecords = 2（大端）
  header[77] = u16(2)[1]!;
  const index = new Array(18).fill(0); // 2 条记录索引（各 8 字节）+ 2 填充
  const rec0Offset = 78 + 18; // 96
  // PalmDOC 头(16) + MOBI 头标识(MOBI)+headerLength+type+codepage(=65001 UTF-8)。
  const mobi = [
    ...asciiCodes('MOBI'),
    ...u32(232),
    ...u32(2),
    ...u32(65001),
    ...u32(0),
    ...u32(opts.fileVersion ?? 6),
  ];
  const rec0 = [
    ...u16(compression), ...u16(0), ...u32(textLength), ...u16(1), ...u16(4096), ...u16(encryption), ...u16(0),
    ...mobi,
  ];
  const rec1Offset = rec0Offset + rec0.length;
  index[0] = u32(rec0Offset)[0]!; index[1] = u32(rec0Offset)[1]!; index[2] = u32(rec0Offset)[2]!; index[3] = u32(rec0Offset)[3]!;
  index[8] = u32(rec1Offset)[0]!; index[9] = u32(rec1Offset)[1]!; index[10] = u32(rec1Offset)[2]!; index[11] = u32(rec1Offset)[3]!;
  return concat([header, index, rec0, record]);
}

describe('parseMobi', () => {
  it('无压缩 MOBI 提取正文 HTML 为一章', () => {
    const content = parseMobi(buildMobi('<h1>标题</h1><p>正文内容</p>'));
    expect(content.chapters).toHaveLength(1);
    expect(content.chapters[0]!.title).toBe('标题');
    expect(content.chapters[0]!.html).toContain('<p>正文内容</p>');
  });

  it('PalmDOC LZ77 解压回引（compression=2）', () => {
    // "AAAA" 的 PalmDOC LZ77 压缩：0x41(字面 'A') + 0x80,0x00(回引 distance=1,length=3)。
    const content = parseMobi(buildMobi('', { compression: 2, record: [0x41, 0x80, 0x00], textLength: 4 }));
    expect(content.chapters[0]!.html).toContain('AAAA');
  });

  it('PalmDOC LZ77 字面转义（c=0 拷贝下一字节）', () => {
    // 0x00 → 拷贝下一字节 0x42('B')；0x41 → 字面 'A'。
    const content = parseMobi(buildMobi('', { compression: 2, record: [0x00, 0x42, 0x41], textLength: 2 }));
    expect(content.chapters[0]!.html).toContain('BA');
  });

  it('按 <mbp:pagebreak/> 切章', () => {
    const html = '<h1>A</h1><p>a</p><mbp:pagebreak/><h1>B</h1><p>b</p>';
    const content = parseMobi(buildMobi(html));
    expect(content.chapters).toHaveLength(2);
    expect(content.chapters[0]!.html).toContain('<p>a</p>');
    expect(content.chapters[1]!.html).toContain('<p>b</p>');
  });

  it('DRM 文件抛 ParseError', () => {
    expect(() => parseMobi(buildMobi('<p>x</p>', { encryption: 1 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiDrm' }),
    );
  });

  it('KF8/MOBI8 与 HUFF/CDIC 返回针对性的能力错误', () => {
    expect(() => parseMobi(buildMobi('<p>x</p>', { fileVersion: 8 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiKf8' }),
    );
    expect(() => parseMobi(buildMobi('<p>x</p>', { compression: 17480 }))).toThrow(
      expect.objectContaining<Partial<ReaderCapabilityError>>({ kind: 'mobiHuff' }),
    );
  });

  it('损坏记录索引（numRecords 越界）抛 ParseError', () => {
    // 构造一个 numRecords 虚高但文件不足的伪造头。
    const bad = asciiPadded('X', 78);
    bad[76] = 0xff; bad[77] = 0xff; // numRecords = 65535，远超文件长度
    expect(() => parseMobi(new Uint8Array(bad))).toThrow(ParseError);
  });
});

describe('共享解码嗅探顺序传播（shared-decode）', () => {
  /** 单章中文 EPUB（嗅探传播探针的最小输入）。 */
  async function buildProbeEpub(): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package><manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '</manifest><spine><itemref idref="ch1"/></spine></package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第一章</title></head><body><h1>一</h1><p>甲</p></body></html>',
        ),
      ),
    );
    return zip.close();
  }

  it('改变嗅探顺序后 txt/epub/fb2 输出同步变化，mobi 声明编码不受影响', async () => {
    const txtBytes = enc('第一段 中文\n\nsecond para');
    const fb2Bytes = enc(
      '<?xml version="1.0"?>\n<FictionBook><body>' +
        '<section><title><p>第一章</p></title><p>正文</p></section>' +
        '</body></FictionBook>',
    );
    const mobiBytes = buildMobi('<h1>标题</h1><p>正文内容</p>');
    const epubBytes = await buildProbeEpub();

    const txtBefore = parseTxt(txtBytes).chapters[0]!.html;
    const fb2Before = parseFb2(fb2Bytes);
    const epubBefore = await parseEpub(epubBytes);
    const mobiBefore = parseMobi(mobiBytes);
    expect(txtBefore).toContain('中文');
    expect(fb2Before.chapters[0]!.title).toBe('第一章');
    expect(epubBefore.chapters[0]!.html).toContain('<p>甲</p>');
    expect(mobiBefore.chapters[0]!.html).toContain('<p>正文内容</p>');

    // windows-1252 对任意字节流都不产生替换字符：前置后所有无声明编码的
    // 格式改由它解码（UTF-8 中文变成 mojibake）；mobi 以声明 label 解码，
    // 不走嗅探，输出保持不变。
    const restore = injectEncodingSniffOrder(['windows-1252', 'utf-8', 'gbk']);
    try {
      const txtAfter = parseTxt(txtBytes).chapters[0]!.html;
      expect(txtAfter).not.toBe(txtBefore);
      expect(txtAfter).not.toContain('中文');
      const fb2After = parseFb2(fb2Bytes);
      expect(fb2After.chapters[0]!.title).not.toBe('第一章');
      expect(fb2After.chapters[0]!.html).not.toBe(fb2Before.chapters[0]!.html);
      const epubAfter = await parseEpub(epubBytes);
      expect(epubAfter.chapters[0]!.html).not.toBe(epubBefore.chapters[0]!.html);
      expect(epubAfter.chapters[0]!.html).not.toContain('<p>甲</p>');
      const mobiAfter = parseMobi(mobiBytes);
      expect(mobiAfter.chapters[0]!.html).toBe(mobiBefore.chapters[0]!.html);
      expect(mobiAfter.chapters[0]!.html).toContain('<p>正文内容</p>');
    } finally {
      restore();
    }
    // 恢复默认顺序后输出回到基线。
    expect(parseTxt(txtBytes).chapters[0]!.html).toBe(txtBefore);
  });
});

describe('资源限额注册表传播（shared-utils）', () => {
  /** 单章 + 一张 4 字节包内 PNG 的最小 EPUB（图字节探针输入）。 */
  async function buildImageEpub(): Promise<Uint8Array> {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package><manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
            '</manifest><spine><itemref idref="ch1"/></spine></package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(
        enc(
          '<html><head><title>第一章</title></head><body><p>甲</p>' +
            '<img src="images/pic.png"></body></html>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/images/pic.png',
      new Uint8ArrayReader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      { level: 0 },
    );
    return zip.close();
  }

  it('收紧图字节限额后 EPUB 与 FB2 同步以 readerImageBytes 拒绝', async () => {
    const epubBytes = await buildImageEpub();
    // "aGVsbG8=" 解码 5 字节（"hello"）的 FB2 embedded 图。
    const fb2Bytes = enc(
      '<?xml version="1.0"?>\n<FictionBook xmlns:l="http://www.w3.org/1999/xlink">\n' +
        '<body><section><p>正文</p><image l:href="#cover"/></section></body>\n' +
        '<binary id="cover" content-type="image/png">aGVsbG8=</binary>\n' +
        '</FictionBook>',
    );

    // 基线：默认限额下 EPUB 保留包内路径占位、FB2 物化 embedded 图。
    const epubBaseline = await parseEpub(epubBytes);
    expect(epubBaseline.chapters[0]!.html).toContain('OEBPS/images/pic.png');
    epubBaseline.dispose?.();

    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:fb2-limit-probe',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => undefined,
    });
    try {
      const fb2Baseline = parseFb2(fb2Bytes);
      expect(fb2Baseline.chapters[0]!.html).toContain('blob:fb2-limit-probe');
      fb2Baseline.dispose?.();

      // 单点收紧：4 字节 EPUB 占位图与 5 字节 FB2 binary 同步超限，两种格式
      // 以同一错误种类 readerImageBytes 拒绝——改一处、全格式生效。
      const restore = injectReaderLimit('maxImageBytes', 3);
      try {
        await expect(parseEpub(epubBytes)).rejects.toThrow(
          expect.objectContaining<Partial<ReaderLimitError>>({
            kind: 'readerImageBytes',
            actual: 4,
            limit: 3,
          }),
        );
        expect(() => parseFb2(fb2Bytes)).toThrow(
          expect.objectContaining<Partial<ReaderLimitError>>({
            kind: 'readerImageBytes',
            actual: 5,
            limit: 3,
          }),
        );
      } finally {
        restore();
      }

      // 恢复后两格式回到基线行为。
      const epubAfter = await parseEpub(epubBytes);
      expect(epubAfter.chapters[0]!.html).toContain('OEBPS/images/pic.png');
      epubAfter.dispose?.();
      const fb2After = parseFb2(fb2Bytes);
      expect(fb2After.chapters[0]!.html).toContain('blob:fb2-limit-probe');
      fb2After.dispose?.();
    } finally {
      if (originalCreate === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
      else Object.defineProperty(URL, 'createObjectURL', originalCreate);
      if (originalRevoke === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
      else Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
    }
  });

  it('收紧远程样式份数后远程 EPUB 首载样式同步减少（传播探针）', async () => {
    const zip = new ZipWriter(new Uint8ArrayWriter());
    await zip.add(
      'META-INF/container.xml',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><container><rootfiles>' +
            '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
            '</rootfiles></container>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/content.opf',
      new Uint8ArrayReader(
        enc(
          '<?xml version="1.0"?><package><manifest>' +
            '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
            '<item id="css1" href="styles/one.css" media-type="text/css"/>' +
            '<item id="css2" href="styles/two.css" media-type="text/css"/>' +
            '</manifest><spine><itemref idref="ch1"/></spine></package>',
        ),
      ),
    );
    await zip.add(
      'OEBPS/ch1.xhtml',
      new Uint8ArrayReader(enc('<html><body><p>甲</p></body></html>')),
    );
    await zip.add('OEBPS/styles/one.css', new Uint8ArrayReader(enc('body{color:red}')));
    await zip.add('OEBPS/styles/two.css', new Uint8ArrayReader(enc('h1{color:blue}')));
    const bytes = await zip.close();
    const source: RandomAccessSource = {
      size: bytes.length,
      identity: { id: 'epub-remote-css' },
      access: 'remote',
      readRange: async (offset, length) => bytes.slice(offset, offset + length),
      close: async () => undefined,
    };

    // 基线：默认 2 份预算内两份样式都保留。
    const baseline = await parseEpub(source);
    expect(baseline.stylesheet).toContain('color:red');
    expect(baseline.stylesheet).toContain('color:blue');
    baseline.dispose?.();

    const restore = injectReaderLimit('epubRemoteMaxStylesheets', 1);
    try {
      const capped = await parseEpub(source);
      expect(capped.stylesheet).toContain('color:red');
      expect(capped.stylesheet).not.toContain('color:blue');
      capped.dispose?.();
    } finally {
      restore();
    }
    const after = await parseEpub(source);
    expect(after.stylesheet).toContain('color:blue');
    after.dispose?.();
  });
});
