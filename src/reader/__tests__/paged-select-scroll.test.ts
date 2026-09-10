// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindPagedSelectScrollLock,
  isPagedScrollerSelectLocked,
  lockPagedScrollerForSelect,
} from '../flow-renderer.js';

function scroller(scrollLeft = 240): HTMLElement {
  const element = document.createElement('div');
  element.className = 'lightink-reader-spread';
  element.style.overflowX = 'auto';
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: scrollLeft,
  });
  document.body.appendChild(element);
  return element;
}

function pointer(
  type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove',
  init: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: type === 'pointerdown' ? 0 : undefined,
    clientX: 40,
    clientY: 20,
    ...init,
  });
}

describe('lockPagedScrollerForSelect', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('freezes scrollLeft against selection autoscroll and restores it on release', () => {
    const pageBox = scroller(240);
    const unlock = lockPagedScrollerForSelect(pageBox);
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(true);

    pageBox.scrollLeft = 960;
    pageBox.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(pageBox.scrollLeft).toBe(240);

    pageBox.scrollLeft = 480;
    document.dispatchEvent(pointer('pointermove', { clientX: 800 }));
    expect(pageBox.scrollLeft).toBe(240);

    unlock();
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
    expect(pageBox.scrollLeft).toBe(240);

    pageBox.scrollLeft = 960;
    pageBox.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(pageBox.scrollLeft).toBe(960);
  });

  it('is idempotent while already locked', () => {
    const pageBox = scroller(80);
    const first = lockPagedScrollerForSelect(pageBox);
    const nested = lockPagedScrollerForSelect(pageBox);
    nested();
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(true);
    pageBox.scrollLeft = 400;
    pageBox.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(pageBox.scrollLeft).toBe(80);
    first();
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
  });
});

describe('bindPagedSelectScrollLock', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('locks on primary mouse press and unlocks on capture pointerup before paging', () => {
    const pageBox = scroller(120);
    const unbind = bindPagedSelectScrollLock(document, {
      enabled: () => true,
      scroller: () => pageBox,
      hostDocument: null,
    });

    pageBox.dispatchEvent(pointer('pointerdown'));
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(true);
    pageBox.scrollLeft = 800;
    pageBox.dispatchEvent(new Event('scroll', { bubbles: true }));
    expect(pageBox.scrollLeft).toBe(120);

    pageBox.dispatchEvent(pointer('pointerup'));
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
    pageBox.scrollLeft = 360;
    expect(pageBox.scrollLeft).toBe(360);
    unbind();
  });

  it('skips touch so swipe paging keeps native overflow-x', () => {
    const pageBox = scroller(120);
    bindPagedSelectScrollLock(document, {
      enabled: () => true,
      scroller: () => pageBox,
      hostDocument: null,
    });
    pageBox.dispatchEvent(pointer('pointerdown', { pointerType: 'touch' }));
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
  });

  it('skips when the layout is not paginated', () => {
    const pageBox = scroller(120);
    bindPagedSelectScrollLock(document, {
      enabled: () => false,
      scroller: () => pageBox,
      hostDocument: null,
    });
    pageBox.dispatchEvent(pointer('pointerdown'));
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
  });

  it('skips non-primary mouse buttons', () => {
    const pageBox = scroller(120);
    bindPagedSelectScrollLock(document, {
      enabled: () => true,
      scroller: () => pageBox,
      hostDocument: null,
    });
    pageBox.dispatchEvent(pointer('pointerdown', { button: 2 }));
    expect(isPagedScrollerSelectLocked(pageBox)).toBe(false);
  });

  it('unlocks when the mouse is released on the host document outside the iframe', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const frameDocument = iframe.contentDocument!;
    const inner = frameDocument.createElement('div');
    Object.defineProperty(inner, 'scrollLeft', {
      configurable: true,
      writable: true,
      value: 120,
    });
    frameDocument.body.appendChild(inner);
    bindPagedSelectScrollLock(frameDocument, {
      enabled: () => true,
      scroller: () => inner,
      hostDocument: document,
    });
    inner.dispatchEvent(pointer('pointerdown'));
    expect(isPagedScrollerSelectLocked(inner)).toBe(true);
    document.dispatchEvent(pointer('pointerup'));
    expect(isPagedScrollerSelectLocked(inner)).toBe(false);
  });
});
