/**
 * 标注数据模型 v3 与序列化往返测试。
 * 覆盖 v3 封套往返、v1/v2/损坏输入安静置空、tombstone 合并与本地优先、
 * 摘录/备注查询与颜色、写队列串行语义。
 */
import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_COLORS,
  AnnotationWriteQueue,
  DEFAULT_ANNOTATION_COLOR,
  annotationUpdatedAt,
  filterAnnotations,
  mergeAnnotations,
  mergeAnnotationsByHash,
  parseAnnotations,
  removeAnnotation,
  resolveAnnotationColor,
  serializeAnnotations,
  updateAnnotationNote,
  type Annotation,
} from '../annotations.js';

const sample: Annotation[] = [
  {
    id: 'h1',
    kind: 'highlight',
    locator: {
      format: 'flow',
      chapter: 0,
      start: 10,
      end: 20,
      quote: '原文片段',
      prefix: '前文',
      suffix: '后文',
    },
    quote: '原文片段',
    createdAt: 1700000000000,
  },
  {
    id: 'b1',
    kind: 'bookmark',
    locator: { format: 'pdf', page: 5, quote: '页脚' },
    createdAt: 1700000000001,
  },
  {
    id: 'n1',
    kind: 'note',
    locator: {
      format: 'text',
      start: 100,
      end: 150,
      quote: '',
      prefix: '',
      suffix: '',
    },
    note: '一段笔记',
    createdAt: 1700000000002,
  },
  {
    id: 'c1',
    kind: 'bookmark',
    locator: { format: 'cbz', page: 12 },
    createdAt: 1700000000003,
  },
];

describe('serialize/parse v3 往返', () => {
  it('序列化后解析等价（各格式定位器保留），封套为 version 3', () => {
    const json = serializeAnnotations(sample);
    expect(JSON.parse(json)).toMatchObject({ version: 3 });
    const back = parseAnnotations(json);
    expect(back).toHaveLength(sample.length);
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1', 'n1', 'c1']);
    expect(back[0]!.locator).toEqual({
      format: 'flow',
      chapter: 0,
      start: 10,
      end: 20,
      quote: '原文片段',
      prefix: '前文',
      suffix: '后文',
    });
    expect(back[1]!.locator).toEqual({ format: 'pdf', page: 5, quote: '页脚' });
    expect(back[2]!.locator).toEqual({
      format: 'text',
      start: 100,
      end: 150,
      quote: '',
      prefix: '',
      suffix: '',
    });
    expect(back[3]!.locator).toEqual({ format: 'cbz', page: 12 });
    expect(back[0]!.quote).toBe('原文片段');
    expect(back[2]!.note).toBe('一段笔记');
  });

  it('keeps an optional chapter on text locators and still loads records without one', () => {
    const withChapter: Annotation = {
      id: 't-ch',
      kind: 'highlight',
      locator: {
        format: 'text',
        chapter: 10,
        start: 0,
        end: 4,
        quote: '过来干什么',
        prefix: '',
        suffix: '',
      },
      quote: '过来干什么',
      createdAt: 1,
    };
    expect(parseAnnotations(serializeAnnotations([withChapter]))).toEqual([withChapter]);
    expect(parseAnnotations(serializeAnnotations([sample[2]!]))[0]!.locator).toEqual({
      format: 'text',
      start: 100,
      end: 150,
      quote: '',
      prefix: '',
      suffix: '',
    });
  });

  it('标注 id/kind/createdAt 保留', () => {
    const back = parseAnnotations(serializeAnnotations(sample));
    expect(back[0]).toMatchObject({ id: 'h1', kind: 'highlight', createdAt: 1700000000000 });
  });

  it('tombstone 记录（deletedAt）随 v3 封套往返保留', () => {
    const tombstoned: Annotation = {
      ...sample[0]!,
      updatedAt: 1700000000100,
      deletedAt: 1700000000100,
    };
    const back = parseAnnotations(serializeAnnotations([tombstoned]));
    expect(back).toEqual([tombstoned]);
    expect(back[0]!.deletedAt).toBe(1700000000100);
  });

  it('非法 updatedAt/deletedAt 被规整为缺失而不是污染记录', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 3,
      annotations: [{ ...sample[0], updatedAt: 'soon', deletedAt: Number.NaN }],
    }));
    expect(back).toHaveLength(1);
    expect(back[0]!.updatedAt).toBeUndefined();
    expect(back[0]!.deletedAt).toBeUndefined();
  });
});

describe('PdfLocator 文字级锚点', () => {
  const anchored: Annotation = {
    id: 'ph1',
    kind: 'highlight',
    locator: {
      format: 'pdf',
      page: 3,
      quote: '页内文字',
      anchor: { start: 12, end: 16, quote: '页内文字', prefix: '前', suffix: '后' },
    },
    quote: '页内文字',
    createdAt: 1700000000010,
  };

  it('含 anchor 的 pdf 定位器序列化/解析往返保留 anchor', () => {
    const back = parseAnnotations(serializeAnnotations([anchored]));
    expect(back).toEqual([anchored]);
    expect(back[0]!.locator).toMatchObject({
      format: 'pdf',
      page: 3,
      anchor: { start: 12, end: 16, quote: '页内文字', prefix: '前', suffix: '后' },
    });
  });

  it('页码级 pdf 定位器（无 anchor）在 v3 下照旧解析', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 3,
      annotations: [sample[1]], // b1: { format: 'pdf', page: 5, quote: '页脚' }
    }));
    expect(back.map((a) => a.id)).toEqual(['b1']);
    expect(back[0]!.locator).toEqual({ format: 'pdf', page: 5, quote: '页脚' });
  });

  it('结构不合规的 anchor 使该条目被过滤', () => {
    const broken = {
      version: 3,
      annotations: [
        anchored,
        {
          ...anchored,
          id: 'bad-anchor',
          locator: {
            format: 'pdf',
            page: 3,
            quote: '页内文字',
            anchor: { start: 20, end: 10 }, // end < start 且缺 quote/prefix/suffix
          },
        },
      ],
    };
    const back = parseAnnotations(JSON.stringify(broken));
    expect(back.map((a) => a.id)).toEqual(['ph1']);
  });
});

describe('parseAnnotations 旧版本与损坏输入安静置空', () => {
  it('空串返回空数组', () => {
    expect(parseAnnotations('')).toEqual([]);
  });

  it('非法 JSON 返回空数组且不抛错', () => {
    expect(parseAnnotations('{not json')).toEqual([]);
    expect(parseAnnotations('null')).toEqual([]);
    expect(() => parseAnnotations('{not json')).not.toThrow();
  });

  it('annotations 非数组返回空数组', () => {
    expect(parseAnnotations(JSON.stringify({ version: 3, annotations: 'nope' }))).toEqual([]);
  });

  it('v1 封套整体置空（不再迁移）', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 1,
      annotations: [{
        id: 'legacy',
        kind: 'highlight',
        locator: { format: 'flow', chapter: 2, domPath: 'p:nth-child(1)', start: 4, end: 10 },
        quote: 'legacy',
        createdAt: 1,
      }],
    }));
    expect(back).toEqual([]);
  });

  it('v2 封套整体置空（含合规记录也不接受）', () => {
    const back = parseAnnotations(JSON.stringify({ version: 2, annotations: sample }));
    expect(back).toEqual([]);
  });

  it('缺失 version 或未知版本返回空数组', () => {
    expect(parseAnnotations(JSON.stringify({ annotations: sample }))).toEqual([]);
    expect(parseAnnotations(JSON.stringify({ version: 4, annotations: sample }))).toEqual([]);
    expect(parseAnnotations(JSON.stringify({ version: '3', annotations: sample }))).toEqual([]);
  });

  it('过滤掉结构不合规的条目，保留合规的', () => {
    const mixed = {
      version: 3,
      annotations: [
        sample[0],
        { id: 'bad', kind: 'highlight' }, // 缺 locator/createdAt
        { id: 'bad2', kind: 'unknown', locator: { format: 'flow', chapter: 0, start: 0, end: 0 }, createdAt: 1 },
        sample[1],
      ],
    };
    const back = parseAnnotations(JSON.stringify(mixed));
    expect(back.map((a) => a.id)).toEqual(['h1', 'b1']);
  });
});

describe('mergeAnnotations 记录级 LWW（生产合并路径）', () => {
  const base: Annotation = {
    id: 'n1',
    kind: 'note',
    locator: { format: 'text', start: 0, end: 4, quote: '句子', prefix: '', suffix: '' },
    note: '旧',
    createdAt: 1,
    updatedAt: 10,
  };

  it('同 id 取 updatedAt 大者，唯一 id 求并集且本地次序在前', () => {
    const local: Annotation[] = [
      base,
      { ...base, id: 'n2', note: '只在本地', createdAt: 2, updatedAt: 5 },
    ];
    const remote: Annotation[] = [
      { ...base, note: '新', updatedAt: 20 },
      { ...base, id: 'n3', note: '只在远端', createdAt: 3, updatedAt: 8 },
    ];
    const merged = mergeAnnotations(local, remote);
    expect(merged.map((a) => a.id)).toEqual(['n1', 'n2', 'n3']);
    expect(merged[0]!.note).toBe('新');
    expect(merged[1]!.note).toBe('只在本地');
    expect(merged[2]!.note).toBe('只在远端');
  });

  it('缺失 updatedAt 回退 createdAt 比较', () => {
    const merged = mergeAnnotations(
      [{ ...base, note: '旧', updatedAt: undefined, createdAt: 10 }],
      [{ ...base, note: '新', updatedAt: undefined, createdAt: 20 }],
    );
    expect(merged[0]!.note).toBe('新');
  });

  it('等刻且双方都活跃：保留本地行', () => {
    const merged = mergeAnnotations(
      [{ ...base, note: '本地', updatedAt: 5 }],
      [{ ...base, note: '远端', updatedAt: 5 }],
    );
    expect(merged[0]!.note).toBe('本地');
  });

  it('tombstone 参与比较：同刻删除优先于活跃记录', () => {
    const tombstone: Annotation = { ...base, note: '远端', updatedAt: 5, deletedAt: 5 };
    const merged = mergeAnnotations([{ ...base, note: '本地', updatedAt: 5 }], [tombstone]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.deletedAt).toBe(5);
  });

  it('更新的活跃记录可覆盖较旧的 tombstone；较旧的活跃记录不复活已删除行', () => {
    const tombstone: Annotation = { ...base, updatedAt: 5, deletedAt: 5 };
    const resurrected = mergeAnnotations([tombstone], [{ ...base, note: '更新', updatedAt: 9 }]);
    expect(resurrected[0]!.deletedAt).toBeUndefined();
    expect(resurrected[0]!.note).toBe('更新');

    const staysDeleted = mergeAnnotations([tombstone], [{ ...base, note: '旧拷贝', updatedAt: 2 }]);
    expect(staysDeleted[0]!.deletedAt).toBe(5);
  });

  it('仅远端存在的 tombstone 进入合并结果（删除可传播）', () => {
    const tombstone: Annotation = { ...base, id: 'gone', updatedAt: 7, deletedAt: 7 };
    const merged = mergeAnnotations([base], [tombstone]);
    expect(merged.map((a) => a.id)).toEqual(['n1', 'gone']);
    expect(merged[1]!.deletedAt).toBe(7);
  });

  it('mergeAnnotationsByHash 按哈希逐表合并并跳过非法哈希键', () => {
    const local = {
      '0123456789abcdef': [base],
      'not-a-hash': [{ ...base, id: 'path-keyed' }],
    };
    const remote = {
      '0123456789abcdef': [{ ...base, note: '新', updatedAt: 20 }],
      fedcba9876543210: [{ ...base, id: 'other-book' }],
    };
    const merged = mergeAnnotationsByHash(local, remote);
    expect(Object.keys(merged).sort()).toEqual(['0123456789abcdef', 'fedcba9876543210']);
    expect(merged['0123456789abcdef']![0]!.note).toBe('新');
    expect(merged['fedcba9876543210']![0]!.id).toBe('other-book');
  });
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('annotation color', () => {
  it('missing and illegal colors resolve to the current flow highlight yellow', () => {
    expect(DEFAULT_ANNOTATION_COLOR).toBe('#f2d675');
    expect(ANNOTATION_COLORS[0]).toBe(DEFAULT_ANNOTATION_COLOR);
    expect(resolveAnnotationColor(undefined)).toBe(DEFAULT_ANNOTATION_COLOR);
    expect(resolveAnnotationColor('not-a-color')).toBe(DEFAULT_ANNOTATION_COLOR);
    expect(resolveAnnotationColor('#86C28B')).toBe('#86c28b');
  });

  it('parse keeps a valid palette color and does not invent color on records without one', () => {
    const colored: Annotation = {
      id: 'green',
      kind: 'highlight',
      locator: { format: 'text', start: 0, end: 4, quote: 'leaf', prefix: '', suffix: '' },
      quote: 'leaf',
      color: '#86c28b',
      createdAt: 4,
    };
    expect(parseAnnotations(serializeAnnotations([colored]))).toEqual([colored]);

    const plain = parseAnnotations(serializeAnnotations([sample[0]!]));
    expect(plain[0]!.color).toBeUndefined();
    expect(resolveAnnotationColor(plain[0]!.color)).toBe(DEFAULT_ANNOTATION_COLOR);
  });

  it('illegal color does not discard the record and resolves as default yellow', () => {
    const back = parseAnnotations(JSON.stringify({
      version: 3,
      annotations: [{
        ...sample[0],
        color: '#ff00ff',
      }],
    }));
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe('h1');
    expect(back[0]!.color).toBeUndefined();
    expect(resolveAnnotationColor(back[0]!.color)).toBe(DEFAULT_ANNOTATION_COLOR);
  });
});

describe('filterAnnotations notebook query', () => {
  const notebook: Annotation[] = [
    {
      id: 'h-yellow',
      kind: 'highlight',
      locator: {
        format: 'flow',
        chapter: 0,
        start: 0,
        end: 4,
        quote: '阳光穿过树叶',
        prefix: '',
        suffix: '',
      },
      quote: '阳光穿过树叶',
      createdAt: 1,
    },
    {
      id: 'h-green',
      kind: 'highlight',
      locator: {
        format: 'text',
        start: 0,
        end: 2,
        quote: 'green excerpt',
        prefix: '',
        suffix: '',
      },
      quote: 'green excerpt',
      color: '#86c28b',
      createdAt: 2,
    },
    {
      id: 'n1',
      kind: 'note',
      locator: {
        format: 'text',
        start: 8,
        end: 12,
        quote: '摘录句子',
        prefix: '',
        suffix: '',
      },
      quote: '摘录句子',
      note: '关于树叶的备注',
      createdAt: 3,
    },
    {
      id: 'b1',
      kind: 'bookmark',
      locator: { format: 'cbz', page: 2 },
      createdAt: 4,
    },
    {
      id: 'deleted',
      kind: 'highlight',
      locator: {
        format: 'text',
        start: 0,
        end: 2,
        quote: '树叶',
        prefix: '',
        suffix: '',
      },
      quote: '树叶',
      createdAt: 5,
      updatedAt: 6,
      deletedAt: 6,
    },
  ];

  it('search hits excerpt or note and misses unrelated words', () => {
    expect(filterAnnotations(notebook, { query: '树叶' }).map((a) => a.id)).toEqual([
      'h-yellow',
      'n1',
    ]);
    expect(filterAnnotations(notebook, { query: '备注' }).map((a) => a.id)).toEqual(['n1']);
    expect(filterAnnotations(notebook, { query: 'green' }).map((a) => a.id)).toEqual(['h-green']);
    expect(filterAnnotations(notebook, { query: '无关词' })).toEqual([]);
  });

  it('tombstone 记录永不进入查询结果（即使文本命中）', () => {
    expect(filterAnnotations(notebook).map((a) => a.id)).toEqual([
      'h-yellow',
      'h-green',
      'n1',
      'b1',
    ]);
    expect(filterAnnotations(notebook, { query: '  ' }).map((a) => a.id)).toEqual([
      'h-yellow',
      'h-green',
      'n1',
      'b1',
    ]);
    expect(filterAnnotations(notebook, { query: '树叶', kind: 'highlight' })).toEqual([
      notebook[0],
    ]);
  });

  it('filters to notes only or to one highlight color', () => {
    expect(filterAnnotations(notebook, { kind: 'note' }).map((a) => a.id)).toEqual(['n1']);
    expect(
      filterAnnotations(notebook, { kind: 'highlight', color: DEFAULT_ANNOTATION_COLOR }).map(
        (a) => a.id,
      ),
    ).toEqual(['h-yellow']);
    expect(filterAnnotations(notebook, { color: '#86C28B' }).map((a) => a.id)).toEqual([
      'h-green',
    ]);
    expect(
      filterAnnotations(notebook, { color: DEFAULT_ANNOTATION_COLOR }).map((a) => a.id),
    ).toEqual(['h-yellow']);
  });

  it('combines text query with kind and color', () => {
    expect(
      filterAnnotations(notebook, { query: '树叶', kind: 'note' }).map((a) => a.id),
    ).toEqual(['n1']);
    expect(
      filterAnnotations(notebook, {
        query: 'excerpt',
        kind: 'highlight',
        color: '#86c28b',
      }).map((a) => a.id),
    ).toEqual(['h-green']);
    expect(
      filterAnnotations(notebook, { query: '树叶', kind: 'highlight', color: '#86c28b' }),
    ).toEqual([]);
  });
});

describe('updateAnnotationNote / removeAnnotation', () => {
  it('edits a note in place with a fresh updatedAt clock', () => {
    const before = Date.now();
    const next = updateAnnotationNote(sample, 'n1', '改过的备注');
    const edited = next.find((a) => a.id === 'n1');
    expect(edited?.note).toBe('改过的备注');
    expect(edited?.updatedAt).toBeGreaterThanOrEqual(before);
    expect(annotationUpdatedAt(edited!)).toBe(edited!.updatedAt!);
    expect(next.find((a) => a.id === 'h1')).toEqual(sample[0]);
    expect(updateAnnotationNote(sample, 'missing', 'x')).toEqual(sample);
  });

  it('removeAnnotation 产出 tombstone（保留记录与 deletedAt/updatedAt 时钟）', () => {
    const before = Date.now();
    const removed = removeAnnotation(sample, 'n1');
    expect(removed).toHaveLength(sample.length);
    const tombstone = removed.find((a) => a.id === 'n1');
    expect(tombstone).toBeDefined();
    expect(tombstone!.deletedAt).toBeGreaterThanOrEqual(before);
    expect(tombstone!.updatedAt).toBe(tombstone!.deletedAt);
    expect(tombstone!.note).toBe('一段笔记'); // 记录内容保留，定位信息不丢
    expect(removed.filter((a) => a.id !== 'n1')).toEqual(sample.filter((a) => a.id !== 'n1'));
  });

  it('removeAnnotation 对未知 id 与已删除记录为空操作', () => {
    expect(removeAnnotation(sample, 'missing')).toEqual(sample);
    const once = removeAnnotation(sample, 'n1');
    expect(removeAnnotation(once, 'n1')).toEqual(once);
  });

  it('tombstone 经合并传播后仍被 filterAnnotations 隐藏', () => {
    const local = removeAnnotation(sample, 'n1');
    const merged = mergeAnnotations(sample, local);
    expect(merged.find((a) => a.id === 'n1')?.deletedAt).toBeDefined();
    expect(filterAnnotations(merged).map((a) => a.id)).toEqual(['h1', 'b1', 'c1']);
  });
});

describe('AnnotationWriteQueue', () => {
  it('serializes rapid writes for the same content hash', async () => {
    const queue = new AnnotationWriteQueue();
    const first = deferred();
    const firstStarted = deferred();
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'first') {
        firstStarted.resolve();
        await first.promise;
      }
    };

    const saveFirst = queue.enqueue('aaaaaaaaaaaaaaaa', 'first', write);
    const saveSecond = queue.enqueue('aaaaaaaaaaaaaaaa', 'second', write);
    await firstStarted.promise;
    expect(writes).toEqual(['first']);
    first.resolve();

    await expect(Promise.all([saveFirst, saveSecond])).resolves.toEqual([true, true]);
    expect(writes).toEqual(['first', 'second']);
  });

  it('skips queued writes invalidated before they start', async () => {
    const queue = new AnnotationWriteQueue();
    const first = deferred();
    const firstStarted = deferred();
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'first') {
        firstStarted.resolve();
        await first.promise;
      }
    };

    const saveFirst = queue.enqueue('aaaaaaaaaaaaaaaa', 'first', write);
    const saveSecond = queue.enqueue('aaaaaaaaaaaaaaaa', 'stale', write);
    await firstStarted.promise;
    queue.invalidate();
    first.resolve();

    await expect(saveFirst).resolves.toBe(false);
    await expect(saveSecond).resolves.toBe(false);
    expect(writes).toEqual(['first']);
  });

  it('continues after a failed write', async () => {
    const queue = new AnnotationWriteQueue();
    const errors: string[] = [];
    const writes: string[] = [];
    const write = async (_hash: string, json: string): Promise<void> => {
      writes.push(json);
      if (json === 'bad') throw new Error('disk full');
    };

    const failed = queue.enqueue('aaaaaaaaaaaaaaaa', 'bad', write, () => errors.push('bad'));
    const recovered = queue.enqueue('aaaaaaaaaaaaaaaa', 'good', write);

    await expect(failed).resolves.toBe(false);
    await expect(recovered).resolves.toBe(true);
    expect(writes).toEqual(['bad', 'good']);
    expect(errors).toEqual(['bad']);
  });
});
