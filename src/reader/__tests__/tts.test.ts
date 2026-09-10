// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sentenceSpansFromRoot } from '../sentence-ranges.js';
import {
  applyFollowAlong,
  clearFollowAlong,
  createTtsController,
  followAlongMark,
  freezeFollowAlong,
  nextSpeakableFlowChapter,
  probeSpeech,
  TTS_MARK_CLASS,
} from '../tts.js';
import { createTtsDock, nextTtsRate } from '../tts-dock.js';

class FakeUtterance {
  text: string;
  rate = 1;
  lang = '';
  onend: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function fakeSpeech(voices: unknown[] = [{ lang: 'en-US', name: 'Test' }]) {
  const queue: FakeUtterance[] = [];
  const speech = {
    paused: false,
    speaking: false,
    getVoices: () => voices as SpeechSynthesisVoice[],
    speak(utterance: FakeUtterance) {
      queue.push(utterance);
      this.speaking = true;
    },
    cancel() {
      queue.length = 0;
      this.speaking = false;
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
  };
  return { speech, queue };
}

afterEach(() => {
  clearFollowAlong();
  document.body.replaceChildren();
  document.head.querySelectorAll('#lightink-reader-tts-mark-style, #lightink-reader-tts-dock-style').forEach(
    (node) => node.remove(),
  );
});

describe('probeSpeech', () => {
  it('treats a missing speechSynthesis as failure, not success', () => {
    expect(probeSpeech(undefined)).toBe('unavailable');
    expect(probeSpeech(null)).toBe('unavailable');
  });

  it('does not treat an empty getVoices list as missing speechSynthesis', () => {
    const { speech } = fakeSpeech([]);
    expect(probeSpeech(speech as unknown as SpeechSynthesis)).toBe('ok');
  });
});

describe('createTtsController', () => {
  it('does not start when speechSynthesis is missing', () => {
    const tts = createTtsController({ speech: null });
    const result = tts.start({
      sentences: [{ start: 0, end: 5, text: 'Hello' }],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    expect(tts.isPlaying()).toBe(false);
  });

  it('still speaks when getVoices is empty so Chromium can populate voices', () => {
    const { speech, queue } = fakeSpeech([]);
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    const result = tts.start({
      sentences: [{ start: 0, end: 5, text: 'Hello' }],
    });
    expect(result.ok).toBe(true);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe('Hello');
  });

  it('does not treat an utterance error plus empty getVoices as missing voices', () => {
    const { speech, queue } = fakeSpeech([]);
    const onFailure = vi.fn();
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    const result = tts.start({
      sentences: [{ start: 0, end: 5, text: 'Hello' }],
      onFailure,
    });
    expect(result.ok).toBe(true);
    queue[0]!.onerror?.(new Event('error'));
    expect(onFailure).toHaveBeenCalledWith('failed');
    expect(onFailure).not.toHaveBeenCalledWith('noVoices');
  });

  it('ignores canceled utterance errors from cancel()', () => {
    const { speech, queue } = fakeSpeech();
    const onFailure = vi.fn();
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    tts.start({
      sentences: [{ start: 0, end: 5, text: 'Hello' }],
      onFailure,
    });
    const canceled = new Event('error') as SpeechSynthesisErrorEvent;
    Object.defineProperty(canceled, 'error', { value: 'canceled' });
    queue[0]!.onerror?.(canceled);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('speaks sentence by sentence, pauses, resumes, and clears the follow-along mark on stop', () => {
    const { speech, queue } = fakeSpeech();
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    const root = document.createElement('p');
    root.textContent = 'One. Two. Three.';
    document.body.append(root);
    const sentences = sentenceSpansFromRoot(root);
    const onSentence = vi.fn();
    const result = tts.start({ sentences, root, onSentence });
    expect(result.ok).toBe(true);
    expect(queue[0]?.text).toBe('One.');
    expect(onSentence).toHaveBeenCalledWith(0);
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)?.textContent).toContain('One.');

    tts.pause();
    expect(tts.isPaused()).toBe(true);
    expect(speech.paused).toBe(true);
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)?.textContent).toContain('One.');

    tts.resume();
    expect(tts.isPaused()).toBe(false);

    queue[0]!.onend?.(new Event('end'));
    expect(tts.currentIndex()).toBe(1);
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)?.textContent).toContain('Two.');

    tts.stop();
    expect(tts.isPlaying()).toBe(false);
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)).toBeNull();
    expect(root.querySelector('[data-annotation-id]')).toBeNull();
    expect(root.querySelector('.lightink-reader-highlight')).toBeNull();
    expect(root.querySelector('.lightink-reader-search-mark')).toBeNull();
  });

  it('keeps the current rate when the next start omits rate', () => {
    const { speech } = fakeSpeech();
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    tts.start({
      sentences: [{ start: 0, end: 5, text: 'Hello' }],
      rate: 1.5,
    });
    expect(tts.currentRate()).toBe(1.5);
    tts.start({ sentences: [{ start: 0, end: 4, text: 'Next' }] });
    expect(tts.currentRate()).toBe(1.5);
  });

  it('notifies onEnd after the last sentence so the session can continue', () => {
    const { speech, queue } = fakeSpeech();
    const onEnd = vi.fn();
    const tts = createTtsController({
      speech: speech as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    });
    tts.start({
      sentences: [
        { start: 0, end: 4, text: 'One.' },
        { start: 5, end: 10, text: 'Two.' },
      ],
      onEnd,
    });
    queue[0]!.onend?.(new Event('end'));
    expect(onEnd).not.toHaveBeenCalled();
    queue[1]!.onend?.(new Event('end'));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('nextSpeakableFlowChapter', () => {
  it('skips empty later chapters and stops at the end of the book', () => {
    const empty = document.createElement('p');
    empty.textContent = '   ';
    const ready = document.createElement('p');
    ready.textContent = '下一章。';
    const bodies = [null, empty, ready];
    expect(nextSpeakableFlowChapter(0, 3, (index) => bodies[index] ?? null)).toBe(2);
    expect(nextSpeakableFlowChapter(2, 3, (index) => bodies[index] ?? null)).toBeNull();
  });
});

describe('follow-along marks', () => {
  it('wraps the current sentence without writing an Annotation', () => {
    const root = document.createElement('p');
    root.textContent = 'Hello. World!';
    document.body.append(root);
    const spans = sentenceSpansFromRoot(root);
    applyFollowAlong(root, spans[0]!.start, spans[0]!.end);
    const mark = root.querySelector(`.${TTS_MARK_CLASS}`);
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toContain('Hello.');
    expect(mark!.hasAttribute('data-annotation-id')).toBe(false);
    expect(root.querySelector('[data-annotation-id]')).toBeNull();
    expect(root.querySelector('.lightink-reader-highlight')).toBeNull();

    applyFollowAlong(root, spans[1]!.start, spans[1]!.end);
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)?.textContent).toContain('World!');
    expect(followAlongMark(root)?.textContent).toContain('World!');
    freezeFollowAlong();
    expect(root.querySelector(`.${TTS_MARK_CLASS}`)?.textContent).toContain('World!');
  });
});

describe('nextTtsRate', () => {
  it('cycles 1× → 1.25× → … → 2× → 0.75×', () => {
    expect(nextTtsRate(1)).toBe(1.25);
    expect(nextTtsRate(2)).toBe(0.75);
    expect(nextTtsRate(0.75)).toBe(1);
  });
});

describe('createTtsDock', () => {
  it('shows pause, resume, stop, and rate while playing', () => {
    const deps = {
      t: (key: string) => key,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onStop: vi.fn(),
      onRate: vi.fn(),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const dock = createTtsDock(deps);
    dock.show(host);
    expect(dock.isVisible()).toBe(true);
    expect(dock.element.querySelector('[data-tts-action="pause"]')?.textContent).toBe('reader.tts.pause');
    expect(dock.element.querySelector('[data-tts-action="resume"]')).toBeTruthy();
    expect(dock.element.querySelector('[data-tts-action="stop"]')?.textContent).toBe('reader.tts.stop');
    expect(dock.element.style.width).toBe('max-content');
    const rate = dock.element.querySelector<HTMLButtonElement>('[data-tts-action="rate"]')!;
    expect(rate.textContent).toBe('1×');
    expect(dock.element.querySelectorAll('[data-tts-action="rate"]')).toHaveLength(1);
    rate.click();
    expect(deps.onRate).toHaveBeenCalledWith(1.25);
    expect(rate.textContent).toBe('1.25×');
    dock.element.querySelector<HTMLButtonElement>('[data-tts-action="pause"]')!.click();
    expect(deps.onPause).toHaveBeenCalledTimes(1);
    dock.destroy();
  });

  it('shows a visible failure when speech is unavailable and does not treat it as success', () => {
    const deps = {
      t: (key: string) => key,
      onPause: vi.fn(),
      onResume: vi.fn(),
      onStop: vi.fn(),
      onRate: vi.fn(),
    };
    const host = document.createElement('div');
    document.body.append(host);
    const dock = createTtsDock(deps);
    const tts = createTtsController({ speech: null });
    const result = tts.start({ sentences: [{ start: 0, end: 4, text: 'Hi.' }] });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
    dock.showError(host, 'reader.tts.unavailable');
    expect(dock.isVisible()).toBe(true);
    expect(dock.element.textContent).toContain('reader.tts.unavailable');
    expect(dock.element.dataset.ttsStatus).toBe('error');
    expect(host.isConnected).toBe(true);
    dock.destroy();
  });
});
