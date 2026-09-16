/**
 * 图片双击预览：纯逻辑判定 + 灯箱挂载/关闭（fake Document）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canPreviewImageDisplaySrc,
  closeImageLightbox,
  IMAGE_LIGHTBOX_OVERLAY_CLASS,
  imageDblclickIntent,
  showImageLightbox,
} from '../plugins/image-preview.js';

class FakeEl {
  tagName: string;
  className = '';
  textContent = '';
  type = '';
  src = '';
  alt = '';
  tabIndex = 0;
  inert = false;
  parent: FakeEl | null = null;
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  append(...nodes: FakeEl[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((listener) => listener !== fn),
    );
  }

  emit(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  focus = vi.fn();

  query(match: (el: FakeEl) => boolean): FakeEl | null {
    if (match(this)) return this;
    for (const child of this.children) {
      const hit = child.query(match);
      if (hit !== null) return hit;
    }
    return null;
  }
}

function makeFakeDocument(): Document {
  const body = new FakeEl('body');
  const doc = {
    body,
    activeElement: null as FakeEl | null,
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      body.addEventListener(`doc:${type}`, fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      body.removeEventListener(`doc:${type}`, fn);
    },
  };
  return doc as unknown as Document;
}

describe('canPreviewImageDisplaySrc', () => {
  it('allows displayed data/blob/http(s) and rejects unresolved relative paths', () => {
    expect(canPreviewImageDisplaySrc('data:image/png;base64,QUJD')).toBe(true);
    expect(canPreviewImageDisplaySrc('blob:http://localhost/1')).toBe(true);
    expect(canPreviewImageDisplaySrc('https://example.com/a.png')).toBe(true);
    expect(canPreviewImageDisplaySrc('assets/a.png')).toBe(false);
    expect(canPreviewImageDisplaySrc('note-assets/image.png')).toBe(false);
    expect(canPreviewImageDisplaySrc('')).toBe(false);
  });
});

describe('imageDblclickIntent', () => {
  it('previews a displayed image, ignores modifier-click and empty src', () => {
    const src = 'data:image/png;base64,QUJD';
    expect(imageDblclickIntent({ ctrlKey: false, metaKey: false }, src)).toBe('preview');
    expect(imageDblclickIntent({ ctrlKey: true, metaKey: false }, src)).toBe('ignore');
    expect(imageDblclickIntent({ ctrlKey: false, metaKey: false }, 'assets/a.png')).toBe(
      'ignore',
    );
  });
});

describe('showImageLightbox', () => {
  afterEach(() => {
    closeImageLightbox();
  });

  it('mounts an overlay and closes on backdrop / image / close / escape', () => {
    const doc = makeFakeDocument();
    const body = (doc as unknown as { body: FakeEl }).body;
    const close = showImageLightbox(doc, {
      src: 'data:image/png;base64,QUJD',
      alt: '图',
      title: '图片预览',
      closeLabel: '关闭',
    });
    const overlay = body.children[0];
    expect(overlay?.className).toContain(IMAGE_LIGHTBOX_OVERLAY_CLASS);
    const dialog = overlay?.children[0];
    expect(dialog?.getAttribute('role')).toBe('dialog');
    const preview = dialog?.query((el) => el.className === 'lightink-image-lightbox-img');
    expect(preview?.src).toBe('data:image/png;base64,QUJD');
    expect(preview?.alt).toBe('图');
    const closeBtn = dialog?.query((el) => el.className === 'lightink-image-lightbox-close');
    expect(closeBtn?.getAttribute('aria-label')).toBe('关闭');
    expect(closeBtn?.textContent).toBe('');

    overlay?.emit('pointerdown', { target: overlay });
    expect(body.children).toHaveLength(0);

    showImageLightbox(doc, { src: 'data:image/png;base64,QUJD', closeLabel: '关闭' });
    const overlay2 = body.children[0];
    overlay2
      ?.query((el) => el.className === 'lightink-image-lightbox-img')
      ?.emit('click', { preventDefault() {}, stopPropagation() {} });
    expect(body.children).toHaveLength(0);

    showImageLightbox(doc, { src: 'data:image/png;base64,QUJD', closeLabel: '关闭' });
    body.emit('doc:keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    expect(body.children).toHaveLength(0);

    close();
  });

  it('replaces an existing lightbox instead of stacking', () => {
    const doc = makeFakeDocument();
    const body = (doc as unknown as { body: FakeEl }).body;
    showImageLightbox(doc, { src: 'data:image/png;base64,AAA' });
    showImageLightbox(doc, { src: 'data:image/png;base64,BBB' });
    expect(body.children).toHaveLength(1);
    const img = body.children[0]?.query(
      (el) => el.className === 'lightink-image-lightbox-img',
    );
    expect(img?.src).toBe('data:image/png;base64,BBB');
  });
});
