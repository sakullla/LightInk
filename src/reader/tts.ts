/**
 * Web Speech TTS (ADR-4). Follow-along marks are independent sentence Ranges,
 * never Annotation records and never search-hit spans.
 */

import { wrapTextRangeWithSpan, unwrapSpans } from './search-panel.js';
import { rangeFromOffsets, type SentenceSpan } from './sentence-ranges.js';

export const TTS_MARK_CLASS = 'lightink-reader-tts-mark';
export const TTS_MARK_STYLE_ID = 'lightink-reader-tts-mark-style';
export const TTS_MARK_CSS = `.${TTS_MARK_CLASS}{background:rgba(196,163,90,.38);border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}`;

export type TtsFailure = 'unavailable' | 'noVoices' | 'failed' | 'empty';

export interface TtsStartInput {
  readonly sentences: readonly SentenceSpan[];
  readonly root?: Node | null;
  readonly rate?: number;
  readonly lang?: string;
  readonly onSentence?: (index: number) => void;
  readonly onEnd?: () => void;
  readonly onFailure?: (reason: TtsFailure) => void;
}

export interface TtsStartResult {
  readonly ok: boolean;
  readonly reason?: TtsFailure;
}

export interface TtsController {
  start(input: TtsStartInput): TtsStartResult;
  pause(): void;
  resume(): void;
  stop(): void;
  setRate(rate: number): void;
  isPlaying(): boolean;
  isPaused(): boolean;
  currentIndex(): number;
}

export interface TtsEnvironment {
  readonly speech?: SpeechSynthesis | null;
  readonly Utterance?: { new (text: string): SpeechSynthesisUtterance };
}

let followRoot: ParentNode | null = null;

function documentOf(root: Node): Document {
  return root.nodeType === Node.DOCUMENT_NODE
    ? (root as Document)
    : root.ownerDocument ?? document;
}

export function ensureTtsMarkStyle(doc: Document): void {
  if (typeof doc.getElementById !== 'function') {
    return;
  }
  if (doc.getElementById(TTS_MARK_STYLE_ID) !== null) {
    return;
  }
  const style = doc.createElement('style');
  style.id = TTS_MARK_STYLE_ID;
  style.textContent = TTS_MARK_CSS;
  const parent = doc.head ?? doc.documentElement ?? doc.body;
  parent?.appendChild(style);
}

export function applyFollowAlong(root: Node, start: number, end: number): void {
  const parent = root as ParentNode;
  if (followRoot !== null && followRoot !== parent && typeof followRoot.querySelectorAll === 'function') {
    unwrapSpans(followRoot, TTS_MARK_CLASS);
  }
  if (typeof parent.querySelectorAll === 'function') {
    unwrapSpans(parent, TTS_MARK_CLASS);
  }
  ensureTtsMarkStyle(documentOf(root));
  const range = rangeFromOffsets(root, start, end);
  if (range === null) {
    return;
  }
  wrapTextRangeWithSpan(root, range, TTS_MARK_CLASS);
  followRoot = parent;
}

/** Leave the current-sentence mark in place; do not persist it. */
export function freezeFollowAlong(): void {
  /* Marks stay on the last spoken sentence and are not Annotation records. */
}

export function clearFollowAlong(): void {
  if (followRoot !== null && typeof followRoot.querySelectorAll === 'function') {
    unwrapSpans(followRoot, TTS_MARK_CLASS);
  }
  followRoot = null;
}

export function probeSpeech(speech: SpeechSynthesis | null | undefined): TtsFailure | 'ok' {
  if (speech == null || typeof speech.speak !== 'function') {
    return 'unavailable';
  }
  if (typeof speech.getVoices !== 'function') {
    return 'noVoices';
  }
  try {
    if (speech.getVoices().length === 0) {
      return 'noVoices';
    }
  } catch {
    return 'noVoices';
  }
  return 'ok';
}

function resolveSpeech(env?: TtsEnvironment): SpeechSynthesis | undefined {
  if (env !== undefined && 'speech' in env) {
    return env.speech ?? undefined;
  }
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.speechSynthesis;
}

function resolveUtterance(
  env: TtsEnvironment | undefined,
): { new (text: string): SpeechSynthesisUtterance } | undefined {
  if (env?.Utterance !== undefined) {
    return env.Utterance;
  }
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.SpeechSynthesisUtterance;
}

function clampRate(rate: number | undefined): number {
  if (!Number.isFinite(rate) || rate === undefined) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, rate));
}

export function createTtsController(env?: TtsEnvironment): TtsController {
  let generation = 0;
  let sentences: readonly SentenceSpan[] = [];
  let root: Node | null = null;
  let index = 0;
  let rate = 1;
  let lang = '';
  let playing = false;
  let paused = false;
  let onSentence: TtsStartInput['onSentence'];
  let onEnd: TtsStartInput['onEnd'];
  let onFailure: TtsStartInput['onFailure'];

  const fail = (reason: TtsFailure): TtsStartResult => {
    playing = false;
    paused = false;
    onFailure?.(reason);
    return { ok: false, reason };
  };

  const highlight = (at: number): void => {
    if (root === null) {
      return;
    }
    const span = sentences[at];
    if (span === undefined) {
      return;
    }
    applyFollowAlong(root, span.start, span.end);
  };

  const speakAt = (at: number): boolean => {
    const speech = resolveSpeech(env);
    const Utterance = resolveUtterance(env);
    const token = generation;
    if (speech === undefined || Utterance === undefined) {
      playing = false;
      paused = false;
      return false;
    }
    const span = sentences[at];
    if (span === undefined) {
      playing = false;
      paused = false;
      freezeFollowAlong();
      onEnd?.();
      return true;
    }
    const text = span.text.trim();
    if (text === '') {
      index = at + 1;
      return speakAt(index);
    }
    index = at;
    playing = true;
    paused = false;
    highlight(at);
    onSentence?.(at);
    const utterance = new Utterance(text);
    utterance.rate = rate;
    if (lang !== '') {
      utterance.lang = lang;
    }
    utterance.onend = () => {
      if (token !== generation || paused) {
        return;
      }
      speakAt(at + 1);
    };
    utterance.onerror = () => {
      if (token !== generation) {
        return;
      }
      fail('failed');
    };
    try {
      speech.speak(utterance);
      return true;
    } catch {
      playing = false;
      paused = false;
      return false;
    }
  };

  return {
    start(input) {
      generation += 1;
      playing = false;
      paused = false;
      const speech = resolveSpeech(env);
      const probed = probeSpeech(speech);
      if (probed !== 'ok') {
        return { ok: false, reason: probed };
      }
      if (resolveUtterance(env) === undefined) {
        return { ok: false, reason: 'unavailable' };
      }
      const next = input.sentences.filter((span) => span.text.trim() !== '');
      if (next.length === 0) {
        return { ok: false, reason: 'empty' };
      }
      try {
        speech?.cancel();
      } catch {
        /* ignore */
      }
      sentences = next;
      root = input.root ?? null;
      rate = clampRate(input.rate);
      lang = input.lang ?? '';
      onSentence = input.onSentence;
      onEnd = input.onEnd;
      onFailure = input.onFailure;
      index = 0;
      if (!speakAt(0)) {
        return { ok: false, reason: 'failed' };
      }
      return { ok: true };
    },
    pause() {
      if (!playing || paused) {
        return;
      }
      paused = true;
      try {
        resolveSpeech(env)?.pause();
      } catch {
        /* ignore */
      }
    },
    resume() {
      if (!paused) {
        return;
      }
      paused = false;
      playing = true;
      const speech = resolveSpeech(env);
      try {
        if (speech !== undefined && speech.paused) {
          speech.resume();
          return;
        }
      } catch {
        /* fall through and re-speak */
      }
      speakAt(index);
    },
    stop() {
      generation += 1;
      playing = false;
      paused = false;
      try {
        resolveSpeech(env)?.cancel();
      } catch {
        /* ignore */
      }
      freezeFollowAlong();
    },
    setRate(next) {
      rate = clampRate(next);
      if (playing && !paused) {
        generation += 1;
        try {
          resolveSpeech(env)?.cancel();
        } catch {
          /* ignore */
        }
        speakAt(index);
      }
    },
    isPlaying: () => playing && !paused,
    isPaused: () => paused,
    currentIndex: () => index,
  };
}
