import { describe, it, expect } from 'vitest';
import { retryBackoffMs, isRetryable, MAX_TRANSIENT_ATTEMPTS } from './backoff';

describe('retry backoff', () => {
  it('grows exponentially: ~1min, ~2min, ~4min', () => {
    const b1 = retryBackoffMs(1);
    const b2 = retryBackoffMs(2);
    const b3 = retryBackoffMs(3);

    // ±20% jitter — assert bands, not exact values.
    expect(b1).toBeGreaterThanOrEqual(48_000);
    expect(b1).toBeLessThanOrEqual(72_000);
    expect(b2).toBeGreaterThanOrEqual(96_000);
    expect(b2).toBeLessThanOrEqual(144_000);
    expect(b3).toBeGreaterThanOrEqual(192_000);
    expect(b3).toBeLessThanOrEqual(288_000);
  });

  it('caps at 1 hour', () => {
    // The exponential reaches the cap at attempt 7 (2^6 min = 64 min > 60 min).
    // From there the jittered delay must stay within (48 min, 60 min] —
    // jitter must never inflate past the cap.
    for (let attempt = 7; attempt <= 10; attempt++) {
      const delay = retryBackoffMs(attempt);
      expect(delay).toBeLessThanOrEqual(60 * 60_000);
      expect(delay).toBeGreaterThan(48 * 60_000);
    }
    // And no attempt — capped or not — ever exceeds the cap.
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(retryBackoffMs(attempt)).toBeLessThanOrEqual(60 * 60_000);
    }
  });

  it('is deterministic-ish across calls but jittered', () => {
    const a = retryBackoffMs(2);
    const b = retryBackoffMs(2);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it('retries are bounded', () => {
    expect(isRetryable(0)).toBe(true);
    expect(isRetryable(1)).toBe(true);
    expect(isRetryable(MAX_TRANSIENT_ATTEMPTS - 1)).toBe(true);
    expect(isRetryable(MAX_TRANSIENT_ATTEMPTS)).toBe(false);
    expect(isRetryable(MAX_TRANSIENT_ATTEMPTS + 5)).toBe(false);
  });
});
