// @vitest-environment jsdom
/**
 * Pure helpers extracted for R5 link hover tooltip skip rules.
 */

import { describe, expect, it } from 'vitest';

import { shouldSkipLinkHrefTooltip } from '../link-affordance.js';

describe('shouldSkipLinkHrefTooltip', () => {
  it('skips when visible text already is the href', () => {
    expect(shouldSkipLinkHrefTooltip('https://example.com', 'https://example.com')).toBe(true);
    expect(shouldSkipLinkHrefTooltip('https://example.com/', 'https://example.com')).toBe(true);
  });

  it('does not skip labeled links or empty values', () => {
    expect(shouldSkipLinkHrefTooltip('https://example.com/docs', 'docs')).toBe(false);
    expect(shouldSkipLinkHrefTooltip('', 'https://example.com')).toBe(false);
    expect(shouldSkipLinkHrefTooltip('https://example.com', '')).toBe(false);
  });
});
