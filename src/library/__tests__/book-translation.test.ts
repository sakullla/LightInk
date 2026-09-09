// @vitest-environment jsdom

/**
 * 整本翻译（R4 / ADR-5）域测试：
 * - 入口显隐：flow 族支持，PDF/CBZ/漫画归档不出现（R7 排除验证）；
 * - 分块：按章边界、不跨章、块上限、超长段二切；
 * - 块化/译回：文本段映射、图片原样保留、多余段落追加、XML 转义；
 * - 术语表：尾部回报剥离与合并（跨章一致）、上限与 prompt 切片；
 * - 断点状态：编解码、续译规划（跳过 done 块、错配作废）；
 * - EPUB 重组：fresh 新组包可被解析器读回；原包重组替换 spine body、
 *   图片原样保留、mimetype 首位；
 * - 控制器：确认（字数/预估成本）→ 每块落盘 → 完成/续译不重译/取消留缓存/
 *   未配置引导/能力错误（DRM）/术语表贯穿。
 */

import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js';

import { translate } from '../../i18n/messages.js';
import { ReaderCapabilityError } from '../../reader/formats/types.js';
import {
  bookTranslationPhaseIsRunning,
  bookTranslationSupported,
  createBookTranslationController,
  type BookTranslationDeps,
  type BookTranslationLaunchRequest,
  type BookPayload,
} from '../book-translation/index.js';
import {
  BOOK_CHUNK_CHAR_LIMIT,
  chunkIndexesByChapter,
  planTranslationChunks,
  plannedSourceChars,
} from '../book-translation/chunker.js';
import {
  extractTranslationBlocks,
  rebuildTranslatedBody,
  splitOversizedParagraph,
  unitParagraphs,
} from '../book-translation/blocks.js';
import {
  glossaryForPrompt,
  mergeGlossary,
  parseGlossaryTail,
} from '../book-translation/glossary.js';
import {
  parseBookTranslationState,
  planResume,
  serializeBookTranslationState,
  withChunkDone,
} from '../book-translation/state.js';
import {
  buildTranslatedEpub,
  prepareEpubTranslation,
  rebuildTranslatedEpub,
} from '../book-translation/epub-builder.js';
import type {
  BookTranslationEstimate,
  GlossaryEntry,
  TranslationUnit,
} from '../book-translation/types.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// ── 入口显隐（R7 排除验证） ─────────────────────────────────────────

describe('bookTranslationSupported', () => {
  it('支持 TXT/FB2/EPUB/MOBI，排除 PDF/CBZ 与漫画归档', () => {
    for (const ext of ['txt', 'fb2', 'epub', 'mobi', 'EPUB', 'Txt']) {
      expect(bookTranslationSupported(ext), ext).toBe(true);
    }
    for (const ext of ['pdf', 'cbz', 'cbr', 'cb7', 'rar', '7z', 'md', '', undefined]) {
      expect(bookTranslationSupported(ext), String(ext)).toBe(false);
    }
  });

  it('运行态判定覆盖四个活动阶段', () => {
    const base = {
      path: 'p',
      title: 't',
      contentHash: 'h',
      targetLang: 'zh-CN',
      doneChunks: 0,
      totalChunks: 0,
      doneChapters: 0,
      totalChapters: 0,
      currentChapterTitle: '',
      resumedChunks: 0,
    };
    for (const phase of ['preparing', 'translating', 'building', 'importing'] as const) {
      expect(bookTranslationPhaseIsRunning({ ...base, phase }), phase).toBe(true);
    }
    for (const phase of ['done', 'paused', 'error'] as const) {
      expect(bookTranslationPhaseIsRunning({ ...base, phase }), phase).toBe(false);
    }
    expect(bookTranslationPhaseIsRunning(null)).toBe(false);
  });
});

// ── 分块 ────────────────────────────────────────────────────────────

describe('planTranslationChunks', () => {
  const unit = (index: number, paragraphs: string[]): TranslationUnit => ({
    index,
    title: `第${index + 1}章`,
    blocks: paragraphs.map((text) => ({ kind: 'text' as const, tag: 'p', text })),
  });

  it('按章边界分块：块不跨章，每章至少一块', () => {
    const units = [
      unit(0, ['甲'.repeat(300), '乙'.repeat(300)]),
      unit(1, ['丙'.repeat(100)]),
    ];
    const chunks = planTranslationChunks(units, 400);
    // 第一章 300+300 超上限切成两块；第二章即使很短也是独立块（不跨章合并）。
    expect(chunks.map((chunk) => chunk.chapterIndex)).toEqual([0, 0, 1]);
    expect(chunks[2]!.text).toBe('丙'.repeat(100));
  });

  it('同章多块装箱且每块不超上限', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `段落${i}` + '字'.repeat(100));
    const chunks = planTranslationChunks([unit(0, paragraphs)], 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(400);
      expect(chunk.chapterIndex).toBe(0);
    }
    // 块文本按序拼接还原全章段落流。
    const joined = chunks.map((chunk) => chunk.text).join('\n');
    for (const paragraph of paragraphs) {
      expect(joined).toContain(paragraph);
    }
  });

  it('默认块上限低于 Rust 5000 字符硬上限（prompt 开销余量）', () => {
    expect(BOOK_CHUNK_CHAR_LIMIT).toBeLessThan(5000);
    const long = '句。'.repeat(BOOK_CHUNK_CHAR_LIMIT);
    for (const chunk of planTranslationChunks([unit(0, [long])])) {
      expect(chunk.text.length).toBeLessThanOrEqual(BOOK_CHUNK_CHAR_LIMIT);
    }
  });

  it('超长无标点段按上限硬切，有标点段按句界切', () => {
    const pieces = splitOversizedParagraph('甲'.repeat(950), 400);
    expect(pieces.length).toBe(3);
    expect(pieces.reduce((sum, piece) => sum + piece.length, 0)).toBe(950);
    const sentences = splitOversizedParagraph(
      '一句话。'.repeat(200) /* 4 chars each = 800 */,
      400,
    );
    expect(sentences.every((piece) => piece.length <= 400)).toBe(true);
    expect(sentences.join('')).toBe('一句话。'.repeat(200));
  });

  it('章节块分组与源字符量', () => {
    const units = [unit(0, ['a', 'b', 'c'.repeat(300)]), unit(1, ['d'])];
    const chunks = planTranslationChunks(units, 400);
    const groups = chunkIndexesByChapter(chunks, units.length);
    expect(groups.length).toBe(2);
    expect(plannedSourceChars(chunks)).toBe(
      chunks.reduce((sum, chunk) => sum + chunk.text.length, 0),
    );
  });
});

// ── 块化与译回 ──────────────────────────────────────────────────────

describe('extractTranslationBlocks / rebuildTranslatedBody', () => {
  it('文本块按文档序提取，图片/脚本分别保留与丢弃', () => {
    const html =
      '<h1>标题</h1><p>第一段</p><img src="images/pic.png" alt="图"/>' +
      '<script>evil()</script><style>.x{}</style><p>第二段</p>';
    const blocks = extractTranslationBlocks(html);
    expect(blocks).toEqual([
      { kind: 'text', tag: 'h1', text: '标题' },
      { kind: 'text', tag: 'p', text: '第一段' },
      { kind: 'raw', markup: '<img src="images/pic.png" alt="图">' },
      { kind: 'text', tag: 'p', text: '第二段' },
    ]);
  });

  it('包裹容器下钻：div 内多段落不合并', () => {
    const blocks = extractTranslationBlocks('<div><p>甲</p><p>乙</p></div>');
    expect(blocks.filter((block) => block.kind === 'text').map((block) => (block as { text: string }).text)).toEqual(['甲', '乙']);
  });

  it('译回按段对位：图片原位保留，多余段落追加，XML 转义', () => {
    const blocks = extractTranslationBlocks('<p>a</p><img src="i.png"/><p>b</p>');
    const body = rebuildTranslatedBody(blocks, ['第一段<script>', '第二段', '模型多出的段落']);
    expect(body).toContain('<p>第一段&lt;script&gt;</p>');
    expect(body).toContain('<img src="i.png">');
    expect(body).toContain('<p>第二段</p>');
    expect(body).toContain('<p>模型多出的段落</p>');
    // 原始顺序：文本在图片前，追加段在最后。
    expect(body.indexOf('第一段')).toBeLessThan(body.indexOf('img'));
    expect(body.indexOf('模型多出的段落')).toBeGreaterThan(body.indexOf('第二段'));
  });

  it('unitParagraphs 与块提取同基准（超大段预切）', () => {
    const unit: TranslationUnit = {
      index: 0,
      title: 't',
      blocks: [
        { kind: 'text', tag: 'p', text: '甲'.repeat(900) },
        { kind: 'raw', markup: '<img src="i"/>' },
        { kind: 'text', tag: 'p', text: '乙' },
      ],
    };
    const paragraphs = unitParagraphs(unit, 400);
    expect(paragraphs.length).toBe(4); // 900 → 3 段 + 乙
    expect(paragraphs.every((p) => p.text.length <= 400)).toBe(true);
    expect(paragraphs[3]!.text).toBe('乙');
  });
});

// ── 术语表 ──────────────────────────────────────────────────────────

describe('glossary', () => {
  it('剥离末尾回报行并解析条目', () => {
    const text = '哈利走过走廊。\n<glossary>Harry=哈利;Hogwarts=霍格沃茨</glossary>';
    const { clean, entries } = parseGlossaryTail(text);
    expect(clean).toBe('哈利走过走廊。');
    expect(entries).toEqual([
      { source: 'Harry', target: '哈利' },
      { source: 'Hogwarts', target: '霍格沃茨' },
    ]);
  });

  it('正文中途出现的标签不剥离不采集', () => {
    const text = '正文含 <glossary>x=y</glossary> 后续内容';
    const { clean, entries } = parseGlossaryTail(text);
    expect(clean).toBe(text);
    expect(entries).toEqual([]);
  });

  it('无效条目（空侧/同值/超长）被丢弃', () => {
    const text = `译文\n<glossary>=甲;A=;A=A;${'长'.repeat(90)}=乙;好=良</glossary>`;
    const { entries } = parseGlossaryTail(text);
    expect(entries).toEqual([{ source: '好', target: '良' }]);
  });

  it('合并去重（新增覆盖旧译）并受上限约束', () => {
    const merged = mergeGlossary(
      [{ source: 'Harry', target: '老译' }],
      [{ source: 'harry', target: '哈利' }, { source: 'New', target: '新' }],
    );
    expect(merged).toEqual([
      { source: 'harry', target: '哈利' },
      { source: 'New', target: '新' },
    ]);
    const many: GlossaryEntry[] = Array.from({ length: 20 }, (_, i) => ({
      source: `s${i}`,
      target: `t${i}`,
    }));
    expect(mergeGlossary(many.slice(0, 10), many.slice(10), 15)).toHaveLength(15);
  });

  it('prompt 切片取最近条目', () => {
    const glossary = Array.from({ length: 10 }, (_, i) => ({
      source: `s${i}`,
      target: `t${i}`,
    }));
    expect(glossaryForPrompt(glossary, 3)).toEqual([
      { source: 's7', target: 't7' },
      { source: 's8', target: 't8' },
      { source: 's9', target: 't9' },
    ]);
  });
});

// ── 断点状态 ────────────────────────────────────────────────────────

describe('state', () => {
  const sample = {
    version: 1 as const,
    targetLang: 'zh-CN',
    totalChunks: 3,
    done: [true, false, false],
    glossary: [{ source: 'Harry', target: '哈利' }],
    sourceChars: 900,
    updatedAt: 1,
  };

  it('编解码往返；损坏/缺版本/长度不一致返回 null', () => {
    expect(parseBookTranslationState(serializeBookTranslationState(sample))).toEqual(sample);
    expect(parseBookTranslationState('')).toBeNull();
    expect(parseBookTranslationState('not json')).toBeNull();
    expect(parseBookTranslationState('{"version":2}')).toBeNull();
    expect(
      parseBookTranslationState('{"version":1,"targetLang":"zh-CN","totalChunks":3,"done":[true]}'),
    ).toBeNull();
  });

  it('续译规划：跳过 done 块；错配（换语言/块数变化）作废重来', () => {
    const state = parseBookTranslationState(serializeBookTranslationState(sample))!;
    const resume = planResume(state, 3, 'zh-CN');
    expect(resume?.pending).toEqual([1, 2]);
    expect(resume?.resumedChunks).toBe(1);
    expect(resume?.glossary).toEqual([{ source: 'Harry', target: '哈利' }]);
    expect(planResume(state, 3, 'en')).toBeNull();
    expect(planResume(state, 4, 'zh-CN')).toBeNull();
    // 无任何完成位 = 全新开始。
    expect(
      planResume({ ...state, done: [false, false, false] }, 3, 'zh-CN'),
    ).toBeNull();
  });

  it('withChunkDone 不可变置位', () => {
    const next = withChunkDone(sample, 1, [{ source: 'a', target: '甲' }]);
    expect(next.done).toEqual([true, true, false]);
    expect(sample.done).toEqual([true, false, false]);
    expect(next.glossary).toEqual([{ source: 'a', target: '甲' }]);
  });
});

// ── EPUB 重组 ───────────────────────────────────────────────────────

async function buildZip(
  entries: readonly { name: string; data: Uint8Array; level?: number }[],
): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(entry.data), {
      level: entry.level ?? 5,
    });
  }
  return writer.close();
}

async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  const out = new Map<string, Uint8Array>();
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory === true || entry.getData === undefined) continue;
      out.set(entry.filename, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close().catch(() => undefined);
  }
  return out;
}

const CONTAINER = enc(
  '<?xml version="1.0"?><container><rootfiles>' +
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
    '</rootfiles></container>',
);
const OPF = enc(
  '<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<metadata><dc:title>原书名</dc:title></metadata>' +
    '<manifest>' +
    '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="pic" href="images/pic.png" media-type="image/png"/>' +
    '</manifest>' +
    '<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>' +
    '</package>',
);
const CH1 = enc(
  '<html><head><title>第一章</title></head><body><h1>Chapter One</h1>' +
    '<p>Harry walked.</p><img src="images/pic.png"/></body></html>',
);
const CH2 = enc(
  '<html><head><title>第二章</title></head><body><p>Ron waved.</p></body></html>',
);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function sampleEpub(): Promise<Uint8Array> {
  return buildZip([
    { name: 'mimetype', data: enc('application/epub+zip'), level: 0 },
    { name: 'META-INF/container.xml', data: CONTAINER },
    { name: 'OEBPS/content.opf', data: OPF },
    { name: 'OEBPS/ch1.xhtml', data: CH1 },
    { name: 'OEBPS/ch2.xhtml', data: CH2 },
    { name: 'OEBPS/images/pic.png', data: PNG },
  ]);
}

describe('epub-builder', () => {
  it('prepareEpubTranslation 解析 spine 并提取 body', async () => {
    const prepared = await prepareEpubTranslation(await sampleEpub());
    expect(prepared.spine.map((item) => item.zipPath)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
    ]);
    expect(prepared.bodies[0]).toContain('Harry walked.');
    expect(prepared.bodies[0]).toContain('<img src="images/pic.png"/>');
  });

  it('原包重组：替换 spine body、图片字节原样、mimetype 首位、标题改写', async () => {
    const original = await sampleEpub();
    const rebuilt = await rebuildTranslatedEpub({
      originalBytes: original,
      spinePaths: ['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml'],
      unitBodies: ['<h1>第一章</h1>\n<p>哈利走过。</p>\n<img src="images/pic.png"/>', '<p>罗恩挥手。</p>'],
      title: '原书名（简体中文译本）',
    });
    const files = await readZip(rebuilt);
    const names = [...files.keys()];
    expect(names[0]).toBe('mimetype');
    const ch1 = dec(files.get('OEBPS/ch1.xhtml')!);
    expect(ch1).toContain('哈利走过。');
    expect(ch1).not.toContain('Harry walked.');
    expect(ch1).toContain('<img src="images/pic.png"/>');
    // head 与图片字节保留（图片显示正常，R4 验收）。
    expect(ch1).toContain('<title>第一章</title>');
    expect(files.get('OEBPS/images/pic.png')).toEqual(PNG);
    expect(dec(files.get('OEBPS/content.opf')!)).toContain('原书名（简体中文译本）');
    // 重组译本可被阅读器解析管线读回（可打开、目录跳转）。
    const reparsed = await prepareEpubTranslation(rebuilt);
    expect(reparsed.spine.map((item) => item.zipPath)).toEqual([
      'OEBPS/ch1.xhtml',
      'OEBPS/ch2.xhtml',
    ]);
  });

  it('fresh 新组 EPUB：结构完整且能被解析管线读回', async () => {
    const units: TranslationUnit[] = [
      {
        index: 0,
        title: '第一章',
        blocks: [
          { kind: 'text', tag: 'h1', text: '第一章' },
          { kind: 'text', tag: 'p', text: '甲段' },
        ],
      },
      { index: 1, title: '第二章', blocks: [{ kind: 'text', tag: 'p', text: '乙段' }] },
    ];
    const bytes = await buildTranslatedEpub({
      units,
      unitBodies: units.map((unit) =>
        rebuildTranslatedBody(unit.blocks, unit.blocks.map((_, i) => `译${unit.index}-${i}`)),
      ),
      title: '书名（简体中文译本）',
      language: '简体中文',
    });
    const prepared = await prepareEpubTranslation(bytes);
    expect(prepared.spine.length).toBe(2);
    expect(prepared.bodies[0]).toContain('译0-0');
    expect(prepared.bodies[1]).toContain('译1-0');
    const files = await readZip(bytes);
    expect([...files.keys()][0]).toBe('mimetype');
    expect(dec(files.get('OEBPS/content.opf')!)).toContain('书名（简体中文译本）');
    expect(dec(files.get('OEBPS/toc.ncx')!)).toContain('第一章');
  });
});

// ── 控制器（编排验收） ──────────────────────────────────────────────

function fakeUnits(paragraphSizes: number[][]): TranslationUnit[] {
  return paragraphSizes.map((sizes, index) => ({
    index,
    title: `第${index + 1}章`,
    blocks: sizes.map((size) => ({
      kind: 'text' as const,
      tag: 'p',
      text: `章${index}段` + '字'.repeat(Math.max(0, size - 4)),
    })),
  }));
}

interface Harness {
  deps: BookTranslationDeps;
  states: Map<string, string>;
  chunks: Map<string, string>;
  cleared: string[];
  translated: Array<{ text: string; glossary: GlossaryEntry[] }>;
  estimates: BookTranslationEstimate[];
  notifies: string[];
  upserts: unknown[];
  guided: { count: number };
  request: BookTranslationLaunchRequest;
}

function createHarness(options: {
  units: TranslationUnit[];
  configured?: boolean;
  confirm?: boolean;
  glossaryEcho?: boolean;
}): Harness {
  const states = new Map<string, string>();
  const chunks = new Map<string, string>();
  const cleared: string[] = [];
  const translated: Array<{ text: string; glossary: GlossaryEntry[] }> = [];
  const estimates: BookTranslationEstimate[] = [];
  const notifies: string[] = [];
  const upserts: unknown[] = [];
  const guided = { count: 0 };
  let chunkSeq = 0;
  const request: BookTranslationLaunchRequest = {
    path: 'C:/books/book.epub',
    title: '测试书',
    extension: 'epub',
  };
  const payload: BookPayload = {
    kind: 'epub',
    sourceTitle: '测试书',
    units: options.units,
    build: async (unitBodies) => {
      // 验证 rebuild 输入存在即可；返回最小合法 zip。
      expect(unitBodies.length).toBe(options.units.length);
      return buildZip([{ name: 'mimetype', data: enc('application/epub+zip'), level: 0 }]);
    },
  };
  const deps: BookTranslationDeps = {
    getLocale: () => 'zh-CN',
    t: (key, vars) => translate('zh-CN', key, vars),
    aiConfigured: async () =>
      options.configured === false
        ? { configured: false, missing: ['apiKey'] }
        : { configured: true, missing: [] },
    aiTargetLangOverride: async () => undefined,
    translateChunk: async (text, _targetLang, glossary) => {
      chunkSeq += 1;
      translated.push({ text, glossary: [...glossary] });
      const echo =
        options.glossaryEcho && chunkSeq === 1
          ? '\n<glossary>Harry=哈利</glossary>'
          : '';
      return { text: `译文${chunkSeq}（${text.slice(0, 6)}…）${echo}` };
    },
    readState: async (hash) => states.get(hash) ?? '',
    writeState: async (hash, json) => {
      states.set(hash, json);
    },
    readChunk: async (hash, index) => chunks.get(`${hash}:${index}`) ?? '',
    writeChunk: async (hash, index, text) => {
      chunks.set(`${hash}:${index}`, text);
    },
    clearTranslation: async (hash) => {
      cleared.push(hash);
    },
    getContentHash: async () => '0123456789abcdef',
    readBytes: async () => enc('book-bytes'),
    loadPayload: async () => payload,
    importEpub: async () =>
      ({
        id: 'managed:abc',
        sourceKind: 'managed',
        title: 'managed:abc',
        authors: [],
        localPath: 'C:/app/library-content/managed/ab/cabc.bin',
        extension: 'epub',
        availability: 'local',
        updatedAt: 1,
      }) as never,
    upsertItem: async (item) => {
      upserts.push(item);
    },
    confirmStart: async (estimate) => {
      estimates.push(estimate);
      return options.confirm !== false;
    },
    notify: (message) => {
      notifies.push(message);
    },
    openManageAi: () => {
      guided.count += 1;
    },
  };
  return { deps, states, chunks, cleared, translated, estimates, notifies, upserts, guided, request };
}

describe('createBookTranslationController', () => {
  it('完整流程：确认含字数与预估成本 → 每块落盘 → 入库新条目 → 清缓存', async () => {
    const units = fakeUnits([
      [120, 200],
      [90],
    ]);
    const harness = createHarness({ units, glossaryEcho: true });
    const controller = createBookTranslationController(harness.deps);
    const statuses: string[] = [];
    controller.subscribe(() => {
      const status = controller.statusFor(harness.request.path);
      if (status !== null) statuses.push(status.phase);
    });
    const result = await controller.launch(harness.request);
    expect(result).toBe('completed');
    // 确认载荷：字数与预估成本（R4 发起前确认）。
    const estimate = harness.estimates[0]!;
    expect(estimate.sourceChars).toBeGreaterThan(0);
    expect(estimate.pendingChunks).toBe(2);
    expect(estimate.estInputChars).toBeGreaterThan(estimate.sourceChars);
    // 两章各一块（不跨章）。
    expect(harness.translated.length).toBe(2);
    // 术语表：第一块回报进入第二块 prompt（跨章一致）。
    expect(harness.translated[1]!.glossary).toEqual([{ source: 'Harry', target: '哈利' }]);
    // 每块译文均落盘（断点缓存）。
    expect(harness.chunks.get('0123456789abcdef:0')).toContain('译文1');
    expect(harness.chunks.get('0123456789abcdef:1')).toContain('译文2');
    // 入库：新条目标题带译本后缀，随后清缓存。
    expect(harness.upserts.length).toBe(1);
    expect((harness.upserts[0] as { title: string }).title).toBe('测试书（简体中文译本）');
    expect(harness.cleared).toEqual(['0123456789abcdef']);
    // 终态与阶段推进完整可见。
    const final = controller.statusFor(harness.request.path);
    expect(final?.phase).toBe('done');
    expect(final?.doneChunks).toBe(2);
    expect(statuses).toContain('translating');
    expect(statuses).toContain('building');
  });

  it('续译不重译：已有断点只请求未完成块', async () => {
    const units = fakeUnits([
      [120],
      [130],
      [90],
    ]);
    const harness = createHarness({ units });
    // 预置断点：块 0/1 已完成（含术语表）。
    const state = {
      version: 1 as const,
      targetLang: '简体中文',
      totalChunks: 3,
      done: [true, true, false],
      glossary: [{ source: 'Harry', target: '哈利' }],
      sourceChars: 100,
      updatedAt: 1,
    };
    harness.states.set('0123456789abcdef', serializeBookTranslationState(state));
    harness.chunks.set('0123456789abcdef:0', '旧译文0');
    harness.chunks.set('0123456789abcdef:1', '旧译文1');
    const controller = createBookTranslationController(harness.deps);
    const result = await controller.launch(harness.request);
    expect(result).toBe('completed');
    // 只请求了块 2——已完成章节绝不重复请求（R4 验收）。
    expect(harness.translated.length).toBe(1);
    expect(harness.estimates[0]!.resumed).toBe(true);
    expect(harness.estimates[0]!.pendingChunks).toBe(1);
    expect(harness.estimates[0]!.totalChunks).toBe(3);
    // 断点术语表带进续译 prompt。
    expect(harness.translated[0]!.glossary).toEqual([{ source: 'Harry', target: '哈利' }]);
  });

  it('取消保留缓存：暂停后不清缓存、状态可续译', async () => {
    const units = fakeUnits([
      [120],
      [130],
      [90],
      [110],
    ]);
    const harness = createHarness({ units });
    let translates = 0;
    const original = harness.deps.translateChunk;
    let cancelledController: ReturnType<typeof createBookTranslationController> | null = null;
    const wrappedDeps: BookTranslationDeps = {
      ...harness.deps,
      translateChunk: async (text, lang, glossary, signal) => {
        translates += 1;
        if (translates === 2) {
          // 第二块在途时请求取消（返回后结果被丢弃，缓存保留）。
          cancelledController?.cancel(harness.request.path);
        }
        return original(text, lang, glossary, signal);
      },
    };
    cancelledController = createBookTranslationController(wrappedDeps);
    const result = await cancelledController.launch(harness.request);
    expect(result).toBe('paused');
    expect(harness.cleared).toEqual([]); // 取消保留缓存（R4）
    const status = cancelledController.statusFor(harness.request.path);
    expect(status?.phase).toBe('paused');
    expect(status?.doneChunks).toBe(1);
    // 断点状态确实落盘且含完成位。
    const persisted = parseBookTranslationState(
      harness.states.get('0123456789abcdef') ?? '',
    );
    expect(persisted?.done.filter(Boolean).length).toBe(1);
  });

  it('未配置 AI：不读书、显示配置引导', async () => {
    const units = fakeUnits([[100]]);
    const harness = createHarness({ units, configured: false });
    const controller = createBookTranslationController(harness.deps);
    const result = await controller.launch(harness.request, { onConfirmed: () => undefined });
    expect(result).toBe('guided');
    expect(harness.guided.count).toBe(1);
    expect(harness.estimates.length).toBe(0);
    expect(harness.translated.length).toBe(0);
  });

  it('用户取消确认：不写任何断点', async () => {
    const units = fakeUnits([[100]]);
    const harness = createHarness({ units, confirm: false });
    const controller = createBookTranslationController(harness.deps);
    const result = await controller.launch(harness.request);
    expect(result).toBe('cancelled');
    expect(harness.states.size).toBe(0);
    expect(harness.translated.length).toBe(0);
    expect(controller.statusFor(harness.request.path)).toBeNull();
  });

  it('不可解析 MOBI（DRM）报能力错误，不进入翻译', async () => {
    const units = fakeUnits([[100]]);
    const harness = createHarness({ units });
    const controller = createBookTranslationController({
      ...harness.deps,
      loadPayload: async () => {
        throw new ReaderCapabilityError('mobiDrm');
      },
    });
    const result = await controller.launch(harness.request);
    expect(result).toBe('failed');
    const status = controller.statusFor(harness.request.path);
    expect(status?.phase).toBe('error');
    expect(status?.error).toContain('DRM');
    expect(harness.translated.length).toBe(0);
  });

  it('断点写盘失败落入 error 终态（缓存保留语义），不抛未处理拒绝', async () => {
    const units = fakeUnits([
      [120],
      [130],
    ]);
    const harness = createHarness({ units });
    const failing = {
      ...harness.deps,
      writeChunk: async () => {
        throw new Error('磁盘写失败');
      },
    };
    const controller = createBookTranslationController(failing);
    await expect(controller.launch(harness.request)).resolves.toBe('failed');
    const status = controller.statusFor(harness.request.path);
    expect(status?.phase).toBe('error');
    expect(status?.error).toContain('磁盘写失败');
    // 状态文件未标记该块完成——缓存保持一致，可重发起续译。
    expect(harness.cleared).toEqual([]);
  });

  it('同书重复发起在运行中不重复启动', async () => {
    const units = fakeUnits([[120], [130]]);
    const harness = createHarness({ units });
    const controller = createBookTranslationController({
      ...harness.deps,
      confirmStart: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      },
    });
    const first = controller.launch(harness.request);
    const second = await controller.launch(harness.request);
    expect(second).toBe('paused'); // 已在运行：忽略重复发起
    expect(await first).toBe('completed');
    expect(harness.translated.length).toBe(2);
  });
});

