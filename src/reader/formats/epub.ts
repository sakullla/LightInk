/**
 * `epub` — EPUB 解析（ebook-reader T4）。
 *
 * EPUB 是 zip 容器：读 META-INF/container.xml 定位 OPF，解析 OPF 的 manifest/spine
 * 得到按顺序的 XHTML 章节文件，抽取各 <body> 内容并消毒为章节化 HTML。
 * ZIP central-directory metadata is checked before decompression. Pure string parsing keeps
 * OPF/XHTML handling testable in Node.
 *
 * T8：包内图片不再 parse 期物化——章节 HTML 中的 img 保留包内规范路径作占位
 * src，由章节 resolveResources/releaseResources 钩子按渲染窗口懒解压并配对
 * revokeObjectURL；archive 随 ReaderContent.dispose 关闭。
 */

import { bytesToBase64 } from '../../asset/asset-service.js';
import { sanitizeParsedHtml } from '../sanitize.js';
import { sanitizeReaderCss } from '../sanitize-css.js';
import { throwIfReaderLoadCancelled } from '../load-lifecycle.js';
import { openSafeArchive, type ArchiveInput } from './safe-archive.js';
import { isRandomAccessSource } from '../sources/types.js';
import { decodeReaderText } from './text-encoding.js';
import { isUsableEpubChapterTitle } from '../chapter-title.js';
import { READER_LIMITS } from '../reader-limits.js';
import {
  ParseError,
  ReaderLimitError,
  type ReaderContent,
} from './types.js';

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
}

const EPUB_EAGER_CHAPTER_LIMIT = 64;
const EPUB_INITIAL_CHAPTERS = 2;

function isRemoteArchiveInput(source: ArchiveInput): boolean {
  return isRandomAccessSource(source) && source.access === 'remote';
}

function eagerChapterCount(source: ArchiveInput, chapterCount: number): number {
  if (isRemoteArchiveInput(source)) {
    return Math.min(EPUB_INITIAL_CHAPTERS, chapterCount);
  }
  return chapterCount <= EPUB_EAGER_CHAPTER_LIMIT
    ? chapterCount
    : Math.min(EPUB_INITIAL_CHAPTERS, chapterCount);
}

function firstBodyHeadingText(body: HTMLElement): string {
  return body.querySelector('h1, h2, h3')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function stripLeadingJunkTitle(body: HTMLElement, junk: string): void {
  const label = junk.trim();
  if (label === '' || isUsableEpubChapterTitle(label)) {
    return;
  }
  const firstNode = body.firstChild;
  if (firstNode !== null && firstNode.nodeType === 3 && firstNode.textContent?.trim() === label) {
    firstNode.remove();
  }
  const first = body.firstElementChild;
  if (
    first !== null &&
    first.textContent?.trim() === label &&
    first.matches('p, div, span, h1, h2, h3, h4, h5, h6')
  ) {
    first.remove();
  }
}

/** 从标签字符串中取属性值。 */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3] ?? '') : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

interface ArchiveReference {
  path: string;
  fragment: string;
}

/** Resolve a relative package reference without allowing it to walk above the archive root. */
function resolveArchiveReference(basePath: string, href: string): ArchiveReference | null {
  const value = decodeXmlEntities(href).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    return null;
  }
  const hashIndex = value.indexOf('#');
  const fragment = hashIndex >= 0 ? value.slice(hashIndex + 1) : '';
  const withoutFragment = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = withoutFragment.indexOf('?');
  const encodedPath = queryIndex >= 0 ? withoutFragment.slice(0, queryIndex) : withoutFragment;
  let referencePath: string;
  try {
    referencePath = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (referencePath === '') {
    return { path: basePath, fragment };
  }
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  const parts: string[] = [];
  const joined = referencePath.startsWith('/') ? referencePath.slice(1) : dir + referencePath;
  for (const seg of joined.split('/')) {
    if (seg === '..') {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else if (seg !== '.' && seg !== '') {
      parts.push(seg);
    }
  }
  return { path: parts.join('/'), fragment };
}

/**
 * Parse EPUB bytes into chapters. Missing/corrupt package data throws ParseError.
 */
export async function parseEpub(
  source: ArchiveInput,
  signal?: AbortSignal,
): Promise<ReaderContent> {
  const archive = await openSafeArchive(source, 'EPUB', signal);
  // T8：包内图片不再 parse 期物化。materialized/pathByUrl 记录按章节窗口懒物化
  // 的 blob URL（path → { url, refs } 引用计数）；archive 存活至内容 dispose，
  // dispose 兜底 revoke 全部并关闭 archive。
  const materialized = new Map<string, { url: string; refs: number; bytes: Uint8Array; mime: string }>();
  const pathByUrl = new Map<string, string>();
  const exportBytes = new Map<string, { mime: string; bytes: Uint8Array }>();
  // 首个 await 前的 in-flight 占位：跨章并发 resolve 同一图片共享同一次物化，
  // 避免双重解压、无主 blob URL 泄漏与 refs 记账错配。
  const materializing = new Map<string, Promise<{ url: string; refs: number; bytes: Uint8Array; mime: string } | null>>();
  let archiveClosed = false;
  const dispose = (): void => {
    for (const entry of materialized.values()) {
      URL.revokeObjectURL(entry.url);
    }
    materialized.clear();
    pathByUrl.clear();
    exportBytes.clear();
    if (!archiveClosed) {
      archiveClosed = true;
      void archive.close().catch(() => undefined);
    }
  };
  let returnedContent = false;
  try {
    // 1. container.xml → OPF 路径。
    let opfPath: string | null = null;
    const containerFile = archive.file('META-INF/container.xml');
    if (containerFile !== null) {
      const container = decodeReaderText(await containerFile.readBytes(signal));
      throwIfReaderLoadCancelled(signal);
      const m = container.match(/<rootfile\b[^>]*full-path\s*=\s*("([^"]*)"|'([^']*)')/i);
      if (m !== null) {
        opfPath = m[2] ?? m[3] ?? null;
      }
    }
    if (opfPath === null) {
      const opfNames = archive.entries
        .map((entry) => entry.filename)
        .filter((name) => /\.opf$/i.test(name));
      if (opfNames.length === 0) {
        throw new ParseError('EPUB 缺少 OPF 包文件');
      }
      opfPath = opfNames[0]!;
    }
    const opfFile = archive.file(opfPath);
    if (opfFile === null) {
      throw new ParseError('EPUB OPF 文件缺失');
    }
    const opf = decodeReaderText(await opfFile.readBytes(signal));
    throwIfReaderLoadCancelled(signal);

    const bookTitle = (
      opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? ''
    ).trim();

    // 2. manifest：id → item。
    const items = new Map<string, ManifestItem>();
    const itemRe = /<item\b[^>]*?\/?>/gi;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(opf)) !== null) {
      const tag = im[0];
      const id = attr(tag, 'id');
      const href = attr(tag, 'href');
      const mediaType = attr(tag, 'media-type') ?? '';
      if (id !== null && href !== null) {
        items.set(id, { id, href, mediaType });
      }
    }

    // 3. spine：阅读顺序。
    const spineIds: string[] = [];
    const spineRe = /<itemref\b[^>]*?\/?>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = spineRe.exec(opf)) !== null) {
      const idref = attr(sm[0], 'idref');
      if (idref !== null) {
        spineIds.push(idref);
      }
    }

    const spineItems = spineIds
      .map((idref) => items.get(idref))
      .filter(
        (item): item is ManifestItem =>
          item !== undefined && /x?html/i.test(item.mediaType),
      )
      .map((item) => ({
        item,
        reference: resolveArchiveReference(opfPath, item.href),
      }))
      .filter(
        (entry): entry is { item: ManifestItem; reference: ArchiveReference } =>
          entry.reference !== null,
      );
    const chapterIndexByPath = new Map(
      spineItems.map((entry, index) => [entry.reference.path, index]),
    );
    const manifestByPath = new Map<string, ManifestItem>();
    for (const item of items.values()) {
      const reference = resolveArchiveReference(opfPath, item.href);
      if (reference !== null) {
        manifestByPath.set(reference.path, item);
      }
    }

    const svgImageHref = (image: Element): string =>
      image.getAttribute('href') ??
      image.getAttribute('xlink:href') ??
      image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      '';

    /**
     * Parse 期引用解析与预算校验（T8）：返回包内规范路径作为占位 src，不解压、
     * 不建 object URL。超限检查用 central-directory 元数据，抛错时机/语义与
     * 原 parse 期物化一致；清单外/不安全 MIME/缺失条目返回 null（调用方去 src）。
     */
    const packagedImagePath = (basePath: string, source: string): string | null => {
      const imageReference = resolveArchiveReference(basePath, source);
      const manifestItem =
        imageReference === null ? undefined : manifestByPath.get(imageReference.path);
      if (imageReference === null || manifestItem === undefined) {
        return null;
      }
      if (!READER_LIMITS.safeImageMimeTypes.has(manifestItem.mediaType)) {
        return null;
      }
      const file = archive.file(imageReference.path);
      if (file === null) {
        return null;
      }
      if (file.uncompressedSize > READER_LIMITS.maxImageBytes) {
        throw new ReaderLimitError(
          'readerImageBytes',
          file.uncompressedSize,
          READER_LIMITS.maxImageBytes,
        );
      }
      return imageReference.path;
    };

    /**
     * T8 懒物化：章节帧进入视口时把占位 src（包内路径）换成 blob URL。同一图片
     * 跨章共享按引用计数持有；releaseImages 配对还原并按计数 revokeObjectURL。
     * in-flight 去重：首个 await 前把 Promise 写入 materializing，跨章并发 resolve
     * 共享同一物化结果，避免双重解压/blob URL 泄漏/refs 记账错配。
     */
    const materializeOne = (
      source: string,
      mediaType: string,
    ): Promise<{ url: string; refs: number; bytes: Uint8Array; mime: string } | null> => {
      const existing = materialized.get(source);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      const pending = materializing.get(source);
      if (pending !== undefined) {
        return pending;
      }
      const file = archive.file(source);
      if (file === null) {
        return Promise.resolve(null);
      }
      const created = (async () => {
        const data = await file.readBytes();
        const imageBytes = Uint8Array.from(data);
        const url = URL.createObjectURL(
          new Blob([imageBytes.buffer], { type: mediaType }),
        );
        if (archiveClosed) {
          // dispose 先于物化完成：立即 revoke，避免产生无记账的 blob URL。
          URL.revokeObjectURL(url);
          return null;
        }
        const entry = { url, refs: 0, bytes: imageBytes, mime: mediaType };
        materialized.set(source, entry);
        pathByUrl.set(url, source);
        return entry;
      })();
      materializing.set(source, created);
      const settle = (): void => {
        if (materializing.get(source) === created) {
          materializing.delete(source);
        }
      };
      void created.then(settle, settle);
      return created;
    };

    const materializeImages = async (doc: Document): Promise<void> => {
      for (const image of Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'))) {
        const source = image.getAttribute('src') ?? '';
        if (source === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(source)) {
          continue; // 已物化（blob:）、内联（data:）或远程图均不归本钩子处理
        }
        const manifestItem = manifestByPath.get(source);
        if (manifestItem === undefined) {
          continue;
        }
        let entry = await materializeOne(source, manifestItem.mediaType);
        // 快路径 await 会让出微任务：跨章并发下另一章的 releaseImages 可在此窗口
        // 把共享条目计数减到 0、revokeObjectURL 并从记账表删除。计数获取与 map
        // 查找须原子化——条目已不在记账表(孤儿化)时重新物化,绝不装已吊销 URL。
        while (entry !== null && materialized.get(source) !== entry) {
          entry = await materializeOne(source, manifestItem.mediaType);
        }
        if (entry === null) {
          continue;
        }
        entry.refs += 1;
        image.setAttribute('src', entry.url);
      }
    };

    /** 与 materializeImages 配对：src 还原为包内路径，引用计数归零即 revoke。幂等。 */
    const releaseImages = (doc: Document): void => {
      for (const image of Array.from(
        doc.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'),
      )) {
        const url = image.getAttribute('src') ?? '';
        const path = pathByUrl.get(url);
        if (path === undefined) {
          continue;
        }
        image.setAttribute('src', path);
        const entry = materialized.get(path);
        if (entry === undefined) {
          continue;
        }
        entry.refs -= 1;
        if (entry.refs <= 0) {
          URL.revokeObjectURL(url);
          materialized.delete(path);
          pathByUrl.delete(url);
        }
      }
    };

    // Read NCX labels up front so a large lazy EPUB still exposes a useful
    // outline without inflating every XHTML spine item during initial load.
    const navigationTitles = new Map<string, string>();
    for (const item of items.values()) {
      if (item.mediaType.toLowerCase() !== 'application/x-dtbncx+xml') {
        continue;
      }
      const ncxReference = resolveArchiveReference(opfPath, item.href);
      const ncxFile = ncxReference === null ? null : archive.file(ncxReference.path);
      if (ncxReference === null || ncxFile === null) {
        continue;
      }
      const ncx = decodeReaderText(await ncxFile.readBytes(signal));
      const pointRe = /<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
      let point: RegExpExecArray | null;
      while ((point = pointRe.exec(ncx)) !== null) {
        const reference = resolveArchiveReference(
          ncxReference.path,
          point[3] ?? point[4] ?? '',
        );
        const title = decodeXmlEntities((point[1] ?? '').replace(/<[^>]*>/g, '')).trim();
        if (reference !== null && title !== '') {
          navigationTitles.set(reference.path, title);
        }
      }
    }

    // 4. Materialize only the first chapters for large books. Remaining spine
    // entries retain their compressed archive entry until the renderer asks.
    const chapters: ReaderContent['chapters'] = spineItems
      .map(({ reference }, idx) => ({ reference, idx }))
      .filter(({ reference }) => archive.file(reference.path) !== null)
      .map(({ reference, idx }) => {
      const fullPath = reference.path;
      const chapter: ReaderContent['chapters'][number] = {
        title:
          navigationTitles.get(fullPath) ??
          (idx === 0 && bookTitle ? bookTitle : `Chapter ${idx + 1}`),
        html: '',
      };
      let loading: Promise<void> | null = null;
      chapter.load = (): Promise<void> => {
        if (loading !== null) {
          return loading;
        }
        loading = (async () => {
          const file = archive.file(fullPath);
          if (file === null) {
            throw new ParseError('EPUB 章节文件缺失');
          }
          const xhtml = decodeReaderText(await file.readBytes(signal));
          throwIfReaderLoadCancelled(signal);
          const document = new DOMParser().parseFromString(xhtml, 'text/html');
          const body = document.body;
          let hasPackagedImages = false;

          for (const image of body.querySelectorAll<HTMLImageElement>('img[src]')) {
            const path = packagedImagePath(fullPath, image.getAttribute('src') ?? '');
            if (path === null) {
              image.removeAttribute('src');
            } else {
              image.setAttribute('src', path);
              hasPackagedImages = true;
            }
          }
          // 文库版 EPUB 常用 <svg><image xlink:href> 包位图；消毒会丢掉整个 svg。
          for (const svg of [...body.querySelectorAll('svg')]) {
            const replacements: HTMLImageElement[] = [];
            for (const image of svg.querySelectorAll('image')) {
              const path = packagedImagePath(fullPath, svgImageHref(image));
              if (path === null) continue;
              const img = document.createElement('img');
              img.setAttribute('src', path);
              hasPackagedImages = true;
              const width = image.getAttribute('width');
              const height = image.getAttribute('height');
              if (width !== null && width !== '' && !width.includes('%')) img.setAttribute('width', width);
              if (height !== null && height !== '' && !height.includes('%')) img.setAttribute('height', height);
              const alt = image.getAttribute('alt') ?? '';
              if (alt !== '') img.alt = alt;
              replacements.push(img);
            }
            if (replacements.length === 0) svg.remove();
            else svg.replaceWith(...replacements);
          }
          for (const link of body.querySelectorAll<HTMLAnchorElement>('a[href]')) {
            const href = link.getAttribute('href') ?? '';
            if (href.startsWith('#')) continue;
            const linkReference = resolveArchiveReference(fullPath, href);
            if (linkReference === null) continue;
            const targetChapter = chapterIndexByPath.get(linkReference.path);
            if (targetChapter === undefined) {
              link.removeAttribute('href');
              continue;
            }
            const params = new URLSearchParams({ chapter: String(targetChapter) });
            if (linkReference.fragment !== '') params.set('target', linkReference.fragment);
            link.setAttribute('href', `#lightink-chapter?${params.toString()}`);
          }
          const sectionTitle = document.title.trim();
          const headingTitle = firstBodyHeadingText(body);
          if (isUsableEpubChapterTitle(sectionTitle)) {
            chapter.title = sectionTitle;
          } else if (isUsableEpubChapterTitle(headingTitle)) {
            chapter.title = headingTitle;
          }
          stripLeadingJunkTitle(body, sectionTitle);
          chapter.html = sanitizeParsedHtml(body);
          if (hasPackagedImages) {
            chapter.resolveResources = materializeImages;
            chapter.releaseResources = releaseImages;
          }
        })();
        return loading;
      };
      return chapter;
    });

    if (chapters.length === 0) {
      throw new ParseError('EPUB 未找到可读章节内容');
    }
    const remote = isRemoteArchiveInput(source);
    const eagerCount = eagerChapterCount(source, chapters.length);
    for (let index = 0; index < eagerCount; index += 1) {
      await chapters[index]!.load?.();
    }

    const stylesheetParts: string[] = [];
    let stylesheetBytes = 0;
    let stylesheetCount = 0;
    for (const item of items.values()) {
      const mediaType = item.mediaType.toLowerCase();
      if (mediaType !== 'text/css' && !mediaType.startsWith('text/css;')) {
        continue;
      }
      const reference = resolveArchiveReference(opfPath, item.href);
      if (reference === null) {
        continue;
      }
      const cssFile = archive.file(reference.path);
      if (cssFile === null || cssFile.uncompressedSize > READER_LIMITS.maxCssBytes) {
        continue;
      }
      if (stylesheetBytes + cssFile.uncompressedSize > READER_LIMITS.maxCssBytes) {
        break;
      }
      const cssText = await cssFile.readText(signal);
      throwIfReaderLoadCancelled(signal);
      stylesheetBytes += cssFile.uncompressedSize;
      stylesheetParts.push(cssText);
      stylesheetCount += 1;
      if (remote && stylesheetCount >= READER_LIMITS.epubRemoteMaxStylesheets) {
        break;
      }
    }
    const stylesheet = sanitizeReaderCss(stylesheetParts.join('\n'));
    const embedExportImages = async (
      html: string,
      mode: 'inline' | 'blob' = 'inline',
    ): Promise<{ html: string; missing: readonly string[] }> => {
      const srcs = [...html.matchAll(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi)].map((m) => m[2]!);
      const unique = [...new Set(srcs)].filter((src) => {
        if (src === '' || src.startsWith('data:')) {
          return false;
        }
        if (src.startsWith('blob:')) {
          return mode === 'inline' && pathByUrl.has(src);
        }
        return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src);
      });
      const cache = new Map<string, string | null>();
      for (const src of unique) {
        const path = src.startsWith('blob:') ? pathByUrl.get(src) : src;
        if (path === undefined) {
          cache.set(src, null);
          continue;
        }
        const ready = materialized.get(path);
        if (ready !== undefined) {
          cache.set(
            src,
            mode === 'blob' ? ready.url : `data:${ready.mime};base64,${bytesToBase64(ready.bytes)}`,
          );
          continue;
        }
        if (mode === 'blob') {
          const manifestItem = manifestByPath.get(path);
          if (manifestItem === undefined) {
            cache.set(src, null);
            continue;
          }
          const entry = await materializeOne(path, manifestItem.mediaType);
          cache.set(src, entry?.url ?? null);
          continue;
        }
        const cached = exportBytes.get(path);
        if (cached !== undefined) {
          cache.set(src, `data:${cached.mime};base64,${bytesToBase64(cached.bytes)}`);
          continue;
        }
        const pending = materializing.get(path);
        if (pending !== undefined) {
          const entry = await pending;
          if (entry !== null) {
            cache.set(src, `data:${entry.mime};base64,${bytesToBase64(entry.bytes)}`);
            continue;
          }
        }
        const manifestItem = manifestByPath.get(path);
        const file = archiveClosed ? null : archive.file(path);
        if (manifestItem === undefined || file === null) {
          cache.set(src, null);
          continue;
        }
        try {
          const data = Uint8Array.from(await file.readBytes());
          exportBytes.set(path, { mime: manifestItem.mediaType, bytes: data });
          cache.set(src, `data:${manifestItem.mediaType};base64,${bytesToBase64(data)}`);
        } catch {
          cache.set(src, null);
        }
      }
      const missing = unique.filter((src) => cache.get(src) === null);
      const htmlOut = html.replace(
        /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi,
        (whole, pre: string, src: string, post: string) => {
          const next = cache.get(src);
          if (next === undefined || next === null) {
            return whole;
          }
          return `${pre}${next}${post}`;
        },
      );
      return { html: htmlOut, missing };
    };
    returnedContent = true;
    return stylesheet === ''
      ? { chapters, dispose, embedExportImages }
      : { chapters, stylesheet, dispose, embedExportImages };
  } finally {
    if (!returnedContent) {
      dispose();
    }
  }
}
