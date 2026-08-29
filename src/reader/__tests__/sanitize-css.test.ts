import { describe, expect, it } from 'vitest';

import { decodeCssEscapes, sanitizeReaderCss } from '../sanitize-css.js';

describe('sanitizeReaderCss', () => {
  it('keeps typography rules used by library EPUB stylesheets', () => {
    expect(sanitizeReaderCss('p { text-indent: 2em; line-height: 1.3; }')).toBe(
      'p { text-indent: 2em; line-height: 1.3; }',
    );
  });

  it('strips imports, urls, fixed overlays, and style-tag breakouts', () => {
    const out = sanitizeReaderCss(
      '@import url("https://evil.example/x.css");' +
        'body { background: url(https://evil.example/bg.png); position: fixed; }' +
        'div { -moz-binding: url(#x); behavior: url(#y); }' +
        '/* </style><script>alert(1)</script> */' +
        'span { color: red; }',
    );
    expect(out).not.toMatch(/@import|url\(|position:\s*fixed|<\/style|script/i);
    expect(out).toContain('position: static');
    expect(out).toContain('span { color: red; }');
  });

  it('drops html/body viewport height so scroll mode can size the frame', () => {
    const out = sanitizeReaderCss('html, body { height: 100%; overflow: hidden; color: red; }');
    expect(out).not.toMatch(/height\s*:/);
    expect(out).not.toMatch(/overflow\s*:/);
    expect(out).toContain('color: red');
  });

  it('strips publisher user-select and html/body pointer locks so EPUB taps and highlights still work', () => {
    const out = sanitizeReaderCss(
      'p { -webkit-user-select: none; user-select: none; color: navy; }' +
        'html, body { pointer-events: none; touch-action: none; color: red; }',
    );
    expect(out).not.toMatch(/user-select/);
    expect(out).not.toMatch(/pointer-events/);
    expect(out).not.toMatch(/touch-action/);
    expect(out).toContain('color: navy');
    expect(out).toContain('color: red');
  });

  it('decodes CSS escapes before stripping so escaped url()/import cannot dodge the pass', () => {
    // u\72 l( → url(：不先解码就会漏进 iframe 触发远程图片请求。
    const out = sanitizeReaderCss(
      'body { background: u\\72 l(https://attacker.example/x.png); }',
    );
    expect(out).not.toMatch(/url\s*\(/i);
    expect(out).not.toMatch(/attacker\.example/);

    const escapedImport = sanitizeReaderCss('@im\\70 ort url("https://evil.example/x.css");');
    expect(escapedImport).not.toMatch(/@import/i);

    const escapedBreakout = sanitizeReaderCss('p::after { content: "\\3c /style\\3e \\3c script\\3e "; }');
    expect(escapedBreakout).not.toMatch(/<\/style|<script/i);
  });

  it('preserves legitimate content escapes like an em dash', () => {
    expect(decodeCssEscapes('p::before { content: "\\2014"; }')).toBe(
      'p::before { content: "—"; }',
    );
  });
});
