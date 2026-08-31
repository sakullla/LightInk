import { describe, expect, it } from 'vitest';

import { displayNameOfPath, extOfPath } from '../path-ext.js';

describe('extOfPath', () => {
  it('returns the lowercase extension of the last segment', () => {
    expect(extOfPath('books\\Novel.EPUB')).toBe('epub');
    expect(extOfPath('.gitignore')).toBe('');
  });
});

describe('displayNameOfPath', () => {
  it('keeps a plain basename', () => {
    expect(displayNameOfPath('C:\\books\\星空职业者.epub')).toBe('星空职业者.epub');
    expect(displayNameOfPath('/library/Chapter 1.epub')).toBe('Chapter 1.epub');
  });

  it('strips the browser-file virtual prefix', () => {
    expect(
      displayNameOfPath('browser-file:google play 下载问题排查及解决 by Eurekasium .pdf'),
    ).toBe('google play 下载问题排查及解决 by Eurekasium .pdf');
  });

  it('decodes a single percent-encoded basename', () => {
    expect(displayNameOfPath('/cache/import/%E6%98%9F%E7%A9%BA%E8%81%8C%E4%B8%9A%E8%80%85.epub')).toBe(
      '星空职业者.epub',
    );
    expect(displayNameOfPath('file:///storage/emulated/0/Download/%E4%B8%89%E4%BD%93.epub')).toBe(
      '三体.epub',
    );
    expect(displayNameOfPath('content://docs/document/primary%3ADownload%2F%E4%B8%89%E4%BD%93.epub')).toBe(
      '三体.epub',
    );
  });

  it('does not expand a double-encoded percent', () => {
    expect(displayNameOfPath('/books/%2520.cbz')).toBe('%20.cbz');
  });

  it('recovers a UTF-8 name that was decoded as Latin-1', () => {
    const mojibake = new TextDecoder('latin1').decode(new TextEncoder().encode('星空职业者.epub'));
    expect(displayNameOfPath(`/cache/${mojibake}`)).toBe('星空职业者.epub');
  });
});
