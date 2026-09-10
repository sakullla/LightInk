/**
 * `epub-builder` — 译本 EPUB 重组（ADR-5）。
 *
 * 两条路径统一到 `BookPayload.build(unitHtmls, meta)`：
 * - epub：基于原书包重组——zip.js 逐条目复制（mimetype 首位且不压缩），
 *   仅替换各 spine 项 XHTML 的 body 与 OPF `<dc:title>`；图片/CSS/NCX 目录
 *   结构原样保留（包内相对路径继续有效，目录跳转与图片显示不变）。
 * - fresh（TXT/FB2/MOBI）：按已解析章节结构新组最小 EPUB 2 包
 *   （container.xml + content.opf + toc.ncx + 章节 XHTML；图片已在章节
 *   HTML 内联为 data URI）。
 *
 * 译本内容哈希与原书不同 → 受管导入自动成新条目；阅读进度按内容哈希身份
 * 链独立（01 已证）。
 */

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  type Entry,
} from '@zip.js/zip.js';

import { decodeReaderText } from '../../reader/formats/text-encoding.js';
import { openSafeArchive } from '../../reader/formats/safe-archive.js';
import {
  escapeXmlText,
  extractTranslationBlocks,
  translatedUnitXhtmlTitle,
} from './blocks.js';
import type { TranslationUnit } from './types.js';

/** 文本条目（UTF-8 字节；Uint8ArrayReader 路径在 WebView 与 jsdom 一致）。 */
function textEntry(text: string): Uint8ArrayReader {
  return new Uint8ArrayReader(new TextEncoder().encode(text));
}

/** ── OPF/spine 最小解析（epub.ts 同源逻辑的重组侧子集） ───────────────── */

function attrValue(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3] ?? '') : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 解析包内相对引用（禁止越出包根；绝对路径按从根解析）。 */
function resolvePackagePath(basePath: string, href: string): string | null {
  const value = decodeXmlEntities(href).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return null;
  }
  const withoutFragment = value.split('#')[0]!.split('?')[0]!;
  if (withoutFragment === '') {
    return basePath;
  }
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  for (const segment of (withoutFragment.startsWith('/') ? withoutFragment.slice(1) : dir + withoutFragment).split('/')) {
    if (segment === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else if (segment !== '.' && segment !== '') {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

export interface EpubSpineItem {
  readonly zipPath: string;
  readonly title: string;
}

/** 解析 EPUB 包：container.xml → OPF → manifest/spine → 待译 spine 项路径。 */
export function parseEpubSpine(containerXml: string, opf: string, opfPath: string): EpubSpineItem[] {
  const rootMatch = containerXml.match(/<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i);
  // container.xml 缺失/无元数据时（调用方已兜底用首个 .opf），以传入 opfPath 为准。
  const rootPath = rootMatch?.[2] ?? rootMatch?.[3] ?? opfPath;
  const items = new Map<string, string>();
  const itemRe = /<item\b[^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(opf)) !== null) {
    const id = attrValue(match[0], 'id');
    const href = attrValue(match[0], 'href');
    const mediaType = attrValue(match[0], 'media-type') ?? '';
    if (id !== null && href !== null && /x?html/i.test(mediaType)) {
      items.set(id, href);
    }
  }
  const spineRe = /<itemref\b[^>]*?\/?>/gi;
  const spinePaths: string[] = [];
  while ((match = spineRe.exec(opf)) !== null) {
    const idref = attrValue(match[0], 'idref');
    const href = idref === null ? undefined : items.get(idref);
    if (href === undefined) {
      continue;
    }
    const resolved = resolvePackagePath(rootPath, href);
    if (resolved !== null) {
      spinePaths.push(resolved);
    }
  }
  const bookTitle = (opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '').trim();
  return spinePaths.map((path, index) => ({
    zipPath: path,
    title: index === 0 && bookTitle !== '' ? decodeXmlEntities(bookTitle) : '',
  }));
}

function bodyInnerHtml(xhtml: string): string | null {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml);
  return match === null ? null : match[1]!;
}

function replaceBodyInner(xhtml: string, replacement: string): string {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(xhtml);
  if (match === null) {
    return xhtml;
  }
  const openTag = match[0].match(/<body\b[^>]*>/i)?.[0] ?? '<body>';
  const start = match.index;
  return (
    xhtml.slice(0, start) +
    openTag +
    '\n' +
    replacement +
    '\n</body>' +
    xhtml.slice(start + match[0].length)
  );
}

/** ── 重组（原包保留路径） ───────────────────────────────────────────── */

export interface RebuiltEpubInput {
  readonly originalBytes: Uint8Array;
  readonly spinePaths: readonly string[];
  /** 与 spinePaths 同序的替换 body 片段。 */
  readonly unitBodies: readonly string[];
  /** 新书名（替换 OPF 既有 dc:title；原包无 dc:title 时不插入，书架标题经 upsertItem 兜底）。 */
  readonly title: string;
}

/**
 * 基于原 EPUB 逐条目重组译本：mimetype 首位（不压缩），其余条目按原样复制，
 * spine 项 body 替换为译文本，OPF 标题改写为译本书名。
 */
export async function rebuildTranslatedEpub(input: RebuiltEpubInput): Promise<Uint8Array> {
  // 整本字节已在内存（装载期持有），Uint8ArrayReader 直接读，环境无关。
  const reader = new ZipReader(new Uint8ArrayReader(input.originalBytes));
  let entries: Entry[];
  try {
    entries = await reader.getEntries();
  } finally {
    await reader.close().catch(() => undefined);
  }
  const replacements = new Map(
    input.spinePaths.map((path, index) => [path, input.unitBodies[index] ?? '']),
  );
  const writer = new ZipWriter(new Uint8ArrayWriter(), { extendedTimestamp: false });
  const ordered = [...entries].sort((left, right) =>
    left.filename === 'mimetype' ? -1 : right.filename === 'mimetype' ? 1 : 0,
  );
  for (const entry of ordered) {
    if (entry.directory === true || entry.getData === undefined) {
      continue;
    }
    if (entry.filename === 'mimetype') {
      const bytes = await entry.getData(new Uint8ArrayWriter());
      await writer.add('mimetype', new Uint8ArrayReader(bytes), { level: 0 });
      continue;
    }
    const replacementBody = replacements.get(entry.filename);
    if (replacementBody !== undefined) {
      const original = new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter()));
      await writer.add(
        entry.filename,
        textEntry(replaceBodyInner(original, replacementBody)),
      );
      continue;
    }
    if (/\.opf$/i.test(entry.filename)) {
      const original = new TextDecoder().decode(await entry.getData(new Uint8ArrayWriter()));
      const titled = original.replace(
        /<dc:title\b[^>]*>[\s\S]*?<\/dc:title>/i,
        `<dc:title>${escapeXmlText(input.title)}</dc:title>`,
      );
      await writer.add(entry.filename, textEntry(titled));
      continue;
    }
    const bytes = await entry.getData(new Uint8ArrayWriter());
    await writer.add(entry.filename, new Uint8ArrayReader(bytes));
  }
  return writer.close();
}

/** ── 新组 EPUB（TXT/FB2/MOBI） ──────────────────────────────────────── */

export interface FreshEpubInput {
  readonly units: readonly TranslationUnit[];
  readonly unitBodies: readonly string[];
  readonly title: string;
  readonly language: string;
}

function chapterXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${translatedUnitXhtmlTitle(title)}</title></head>
<body>
${body}
</body>
</html>`;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

function contentOpf(input: FreshEpubInput, identifier: string): string {
  const manifest = input.units
    .map(
      (_unit, index) =>
        `<item id="ch${index + 1}" href="chapter-${String(index + 1).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join('');
  const spine = input.units.map((_unit, index) => `<itemref idref="ch${index + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXmlText(input.title)}</dc:title>
    <dc:language>${escapeXmlText(input.language)}</dc:language>
    <dc:identifier id="bookid">${escapeXmlText(identifier)}</dc:identifier>
    <dc:creator>LightInk</dc:creator>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifest}
  </manifest>
  <spine toc="ncx">${spine}</spine>
</package>`;
}

function tocNcx(input: FreshEpubInput, identifier: string): string {
  const points = input.units
    .map(
      (unit, index) =>
        `<navPoint id="nav${index + 1}" playOrder="${index + 1}"><navLabel><text>${translatedUnitXhtmlTitle(unit.title)}</text></navLabel><content src="chapter-${String(index + 1).padStart(4, '0')}.xhtml"/></navPoint>`,
    )
    .join('\n    ');
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXmlText(identifier)}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>${escapeXmlText(input.title)}</text></docTitle>
  <navMap>
    ${points}
  </navMap>
</ncx>`;
}

/** 按已解析章节结构新组最小 EPUB 2 包。 */
export async function buildTranslatedEpub(input: FreshEpubInput): Promise<Uint8Array> {
  const identifier = `urn:uuid:${crypto.randomUUID()}`;
  const writer = new ZipWriter(new Uint8ArrayWriter(), { extendedTimestamp: false });
  await writer.add('mimetype', textEntry('application/epub+zip'), { level: 0 });
  await writer.add('META-INF/container.xml', textEntry(containerXml()));
  await writer.add('OEBPS/content.opf', textEntry(contentOpf(input, identifier)));
  await writer.add('OEBPS/toc.ncx', textEntry(tocNcx(input, identifier)));
  for (const [index, unit] of input.units.entries()) {
    await writer.add(
      `OEBPS/chapter-${String(index + 1).padStart(4, '0')}.xhtml`,
      textEntry(chapterXhtml(unit.title, input.unitBodies[index] ?? '')),
    );
  }
  return writer.close();
}

/** ── 翻译单元装载（两条路径的入口差异） ─────────────────────────────── */

export interface PreparedEpub {
  readonly spine: readonly EpubSpineItem[];
  /** spine 项 body inner HTML 序列（供块提取）。 */
  readonly bodies: readonly string[];
}

/** 解析原 EPUB 的 spine 结构与各 spine 项 body（不做翻译侧消毒）。 */
export async function prepareEpubTranslation(
  bytes: Uint8Array,
): Promise<PreparedEpub> {
  const archive = await openSafeArchive(bytes, 'EPUB');
  try {
    const containerEntry = archive.file('META-INF/container.xml');
    let opfPath: string | null = null;
    if (containerEntry !== null) {
      const container = decodeReaderText(await containerEntry.readBytes());
      const match = container.match(/<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i);
      opfPath = match?.[2] ?? match?.[3] ?? null;
    }
    if (opfPath === null) {
      const first = archive.entries.find((entry) => /\.opf$/i.test(entry.filename));
      opfPath = first?.filename ?? null;
    }
    if (opfPath === null) {
      throw new Error('EPUB 缺少 OPF 包文件');
    }
    const opfEntry = archive.file(opfPath);
    if (opfEntry === null) {
      throw new Error('EPUB OPF 文件缺失');
    }
    const opf = decodeReaderText(await opfEntry.readBytes());
    const containerXml = containerEntry === null ? '' : await containerEntry.readText();
    const spine = parseEpubSpine(containerXml, opf, opfPath);
    const bodies: string[] = [];
    for (const item of spine) {
      const entry = archive.file(item.zipPath);
      const xhtml = entry === null ? '' : decodeReaderText(await entry.readBytes());
      bodies.push(bodyInnerHtml(xhtml) ?? '');
    }
    return { spine, bodies };
  } finally {
    await archive.close().catch(() => undefined);
  }
}

/** XHTML body 内容 → 翻译单元（标题来自 spine 元数据或章内 heading）。 */
export function epubUnitsFromBodies(
  spine: readonly EpubSpineItem[],
  bodies: readonly string[],
): TranslationUnit[] {
  return bodies.map((body, index) => {
    const heading = body.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ?? '';
    const headingText = heading.replace(/<[^>]*>/g, '').trim();
    return {
      index,
      title: spine[index]?.title || headingText || `Chapter ${index + 1}`,
      blocks: extractTranslationBlocks(body),
    };
  });
}
