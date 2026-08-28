/**
 * clipboard / dragdrop 提取逻辑单测（node 环境，合成事件形状）。
 *
 * 真实 OS 剪贴板截图粘贴与文件拖拽无法头less 复现，这里以结构化 fake
 * 覆盖：条目过滤（kind/type）、空字节跳过、MIME→扩展名、alt 默认值。
 */

import { describe, expect, it } from 'vitest';

import { clipboardHasImage, extractClipboardImage } from '../clipboard.js';
import { dropHasImage, extractDroppedImages } from '../dragdrop.js';

interface FileLike {
  type: string;
  name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface ItemLike {
  kind: string;
  type: string;
  getAsFile(): FileLike | null;
}

function fileOf(type: string, bytes: number[], name = ''): FileLike {
  return { type, name, arrayBuffer: async () => new Uint8Array(bytes).buffer };
}

function eventOf(opts: { items?: ItemLike[]; files?: FileLike[] }): ClipboardEvent {
  return { clipboardData: { items: opts.items ?? [], files: opts.files ?? [] } } as unknown as ClipboardEvent;
}

function fileItem(mime: string, file: FileLike | null): ItemLike {
  return { kind: 'file', type: mime, getAsFile: () => file };
}

function stringItem(type: string): ItemLike {
  return { kind: 'string', type, getAsFile: () => null };
}

interface FakeFile {
  name: string;
  type: string;
  bytes: number[];
}

function fakeDragEvent(files: FakeFile[]): DragEvent {
  return {
    dataTransfer: {
      files: files.map((f) => ({
        name: f.name,
        type: f.type,
        arrayBuffer: async () => new Uint8Array(f.bytes).buffer,
      })),
    },
    clientX: 10,
    clientY: 20,
  } as unknown as DragEvent;
}

describe('drag-drop extraction', () => {
  it('extracts image files, filters non-images, keeps order', async () => {
    const event = fakeDragEvent([
      { name: 'notes.txt', type: 'text/plain', bytes: [65] },
      { name: '猫 猫.png', type: 'image/png', bytes: [1, 2] },
      { name: 'photo.jpg', type: 'image/jpeg', bytes: [3] },
    ]);
    expect(dropHasImage(event)).toBe(true);
    const images = await extractDroppedImages(event);
    expect(images).toHaveLength(2);
    expect(images[0]!.alt).toBe('猫 猫');
    expect(images[0]!.ext).toBe('png');
    expect(images[1]!.alt).toBe('photo');
    expect(images[1]!.ext).toBe('jpg');
  });

  it('detects nothing for non-image drops', async () => {
    const event = fakeDragEvent([{ name: 'a.md', type: 'text/markdown', bytes: [35] }]);
    expect(dropHasImage(event)).toBe(false);
    expect(await extractDroppedImages(event)).toEqual([]);
  });

  it('skips zero-byte files and infers ext from name when MIME unknown', async () => {
    const event = fakeDragEvent([
      { name: 'empty.webp', type: 'image/webp', bytes: [] },
      { name: 'icon.gif', type: 'image/x-unknown-gif', bytes: [71] },
    ]);
    const images = await extractDroppedImages(event);
    expect(images).toHaveLength(1);
    expect(images[0]!.ext).toBe('gif');
  });

  it('handles missing dataTransfer gracefully', async () => {
    const event = {} as DragEvent;
    expect(dropHasImage(event)).toBe(false);
    expect(await extractDroppedImages(event)).toEqual([]);
  });
});

describe('clipboardHasImage', () => {
  it('items 含 image 条目', () => {
    expect(clipboardHasImage(eventOf({ items: [fileItem('image/png', fileOf('image/png', [1]))] }))).toBe(true);
  });

  it('items 含空 MIME 文件条目经 getAsFile 兜底判定', () => {
    expect(clipboardHasImage(eventOf({ items: [fileItem('', fileOf('image/png', [1]))] }))).toBe(true);
  });

  it('仅 files 填充（items 缺失）', () => {
    expect(clipboardHasImage(eventOf({ files: [fileOf('image/png', [1])] }))).toBe(true);
  });

  it('纯文本与空剪贴板无图', () => {
    expect(clipboardHasImage(eventOf({ items: [stringItem('text/plain')] }))).toBe(false);
    expect(clipboardHasImage(eventOf({}))).toBe(false);
  });

  it('文本 + 图片同存视为有图（图片优先）', () => {
    expect(
      clipboardHasImage(eventOf({ items: [stringItem('text/plain'), fileItem('image/png', fileOf('image/png', [1]))] })),
    ).toBe(true);
  });
});

describe('extractClipboardImage', () => {
  it('items image 条目提取字节/MIME/扩展名', async () => {
    const img = await extractClipboardImage(eventOf({ items: [fileItem('image/png', fileOf('image/png', [1, 2, 3]))] }));
    expect(img).not.toBeNull();
    expect(img!.ext).toBe('png');
    expect(img!.mime).toBe('image/png');
    expect(img!.bytes.byteLength).toBe(3);
  });

  it('空 MIME 条目经文件 type 提取', async () => {
    const img = await extractClipboardImage(eventOf({ items: [fileItem('', fileOf('image/jpeg', [9]))] }));
    expect(img).not.toBeNull();
    expect(img!.mime).toBe('image/jpeg');
    expect(img!.ext).toBe('jpg');
  });

  it('仅 files 填充时提取', async () => {
    const img = await extractClipboardImage(eventOf({ files: [fileOf('image/png', [4, 5])] }));
    expect(img).not.toBeNull();
    expect(img!.mime).toBe('image/png');
    expect(img!.bytes.byteLength).toBe(2);
  });

  it('跳过空字节条目，取下一张', async () => {
    const items = [fileItem('image/png', fileOf('image/png', [])), fileItem('image/png', fileOf('image/png', [1]))];
    const img = await extractClipboardImage(eventOf({ items }));
    expect(img).not.toBeNull();
    expect(img!.bytes.byteLength).toBe(1);
  });

  it('无图返回 null', async () => {
    expect(await extractClipboardImage(eventOf({ items: [stringItem('text/plain')] }))).toBeNull();
    expect(await extractClipboardImage(eventOf({}))).toBeNull();
  });
});
