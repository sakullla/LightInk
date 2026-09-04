// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { revealPagedElement } from '../flow-renderer.js';

describe('revealPagedElement', () => {
  it('pages a mark that sits left of the current spread back onto the visible page', () => {
    const frame = document.createElement('iframe');
    const article = document.createElement('article');
    article.className = 'lightink-reader-chapter';
    article.append(frame);
    document.body.append(article);

    const scroller = document.createElement('div');
    scroller.className = 'lightink-reader-spread';
    scroller.style.setProperty('--lightink-reader-page-step', '400px');
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1600 });
    let scrollLeft = 800;
    const contentX = -451 + 800;
    Object.defineProperty(scroller, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 }),
    });

    const mark = document.createElement('mark');
    scroller.append(mark);
    const doc = {
      querySelector: (selector: string) =>
        selector.includes('lightink-reader-spread') ? scroller : null,
      documentElement: scroller,
    } as unknown as Document;

    Object.defineProperty(mark, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const markLeft = contentX - scrollLeft;
        return {
          left: markLeft,
          top: 200,
          right: markLeft + 150,
          bottom: 220,
          width: 150,
          height: 20,
        };
      },
    });

    const aligned = revealPagedElement(frame, doc, mark, () => {
      /* snap:false — keep the current column offset */
    });

    expect(scroller.scrollLeft).toBe(0);
    expect(aligned).toBe(true);
    article.remove();
  });
});
