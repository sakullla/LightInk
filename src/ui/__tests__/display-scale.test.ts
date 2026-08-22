/**
 * Display tier resolution across compact → hd → qhd → uhd → xuhd.
 */
import { describe, expect, it } from 'vitest';

import { resolveDisplayTier } from '../display-scale.js';

describe('resolveDisplayTier', () => {
  it('classifies narrow / sub-1080p windows as compact', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 1280,
        screenWidth: 1280,
        devicePixelRatio: 1,
      }),
    ).toBe('compact');
    expect(
      resolveDisplayTier({
        innerWidth: 1366,
        screenWidth: 1366,
        devicePixelRatio: 1,
      }),
    ).toBe('compact');
    // Half-tiled on a large screen: viewport small → compact
    expect(
      resolveDisplayTier({
        innerWidth: 960,
        screenWidth: 2560,
        devicePixelRatio: 1,
      }),
    ).toBe('compact');
  });

  it('classifies classic 1080p as hd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 1920,
        screenWidth: 1920,
        devicePixelRatio: 1,
      }),
    ).toBe('hd');
  });

  it('classifies 1440p as qhd; 1680 laptop stays hd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 2560,
        screenWidth: 2560,
        devicePixelRatio: 1,
      }),
    ).toBe('qhd');
    // 1680×1050-class is still closer to HD reading density than 2K.
    expect(
      resolveDisplayTier({
        innerWidth: 1680,
        screenWidth: 1680,
        devicePixelRatio: 1,
      }),
    ).toBe('hd');
  });

  it('classifies 4K@100% as uhd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 3840,
        screenWidth: 3840,
        devicePixelRatio: 1,
      }),
    ).toBe('uhd');
  });

  it('classifies 4K@200% (CSS ~1920) via physical width as uhd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 1920,
        screenWidth: 1920,
        devicePixelRatio: 2,
      }),
    ).toBe('uhd');
  });

  it('classifies 4K@150% via physical width as uhd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 2560,
        screenWidth: 2560,
        devicePixelRatio: 1.5,
      }),
    ).toBe('uhd');
  });

  it('classifies 5K / 8K as xuhd', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 5120,
        screenWidth: 5120,
        devicePixelRatio: 1,
      }),
    ).toBe('xuhd');
    expect(
      resolveDisplayTier({
        innerWidth: 7680,
        screenWidth: 7680,
        devicePixelRatio: 1,
      }),
    ).toBe('xuhd');
    // 5K@200% → CSS ~2560, physical 5120
    expect(
      resolveDisplayTier({
        innerWidth: 2560,
        screenWidth: 2560,
        devicePixelRatio: 2,
      }),
    ).toBe('xuhd');
  });

  it('does not inherit 2K/4K gutters from a restored window on a large screen', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 1400,
        screenWidth: 2560,
        devicePixelRatio: 1,
      }),
    ).toBe('hd');
    expect(
      resolveDisplayTier({
        innerWidth: 2560,
        screenWidth: 2560,
        devicePixelRatio: 1,
      }),
    ).toBe('qhd');
  });

  it('treats invalid dpr as 1', () => {
    expect(
      resolveDisplayTier({
        innerWidth: 1920,
        screenWidth: 1920,
        devicePixelRatio: 0,
      }),
    ).toBe('hd');
  });
});
