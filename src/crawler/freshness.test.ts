import { describe, it, expect } from 'vitest';
import { nextFreshness, MAX_RECRAWL_INTERVAL_MS } from './freshness';

const DAY = 24 * 3_600_000;
const NOW = 1_790_000_000_000;

describe('freshness scheduling', () => {
  it('first crawl (no existing state) schedules a recrawl in 24h', () => {
    const f = nextFreshness(undefined, true, NOW);
    expect(f.recrawlDue).toBe(NOW + DAY);
    expect(f.changeCount).toBe(1);
    expect(f.unchangedStreak).toBe(0);
    expect(f.lastChangedAt).toBe(NOW);
  });

  it('a changed page returns to the 24h cadence', () => {
    const prev = nextFreshness(undefined, true, NOW - 10 * DAY);
    const f = nextFreshness(prev, true, NOW);
    expect(f.recrawlDue).toBe(NOW + DAY);
    expect(f.changeCount).toBe(2);
    expect(f.unchangedStreak).toBe(0);
    expect(f.lastChangedAt).toBe(NOW);
  });

  it('an unchanged page doubles its interval (2d, 4d, 8d …)', () => {
    const state = nextFreshness(undefined, true, NOW - 100 * DAY); // long ago
    const before = NOW - DAY; // recrawl happening now-ish

    const r1 = nextFreshness(state, false, before);
    expect(r1.recrawlDue - before).toBe(2 * DAY);
    expect(r1.unchangedStreak).toBe(1);
    expect(r1.changeCount).toBe(state.changeCount);

    const r2 = nextFreshness(r1, false, before);
    expect(r2.recrawlDue - before).toBe(4 * DAY);

    const r3 = nextFreshness(r2, false, before);
    expect(r3.recrawlDue - before).toBe(8 * DAY);
  });

  it('interval caps at 30 days', () => {
    let state = nextFreshness(undefined, true, NOW);
    for (let i = 0; i < 20; i++) state = nextFreshness(state, false, NOW);
    expect(state.recrawlDue - NOW).toBe(MAX_RECRAWL_INTERVAL_MS);
    expect(state.unchangedStreak).toBe(20);
  });

  it('a change after a long static streak resets the streak and keeps changeCount', () => {
    let state = nextFreshness(undefined, true, NOW - 100 * DAY);
    state = { ...state, changeCount: 3 };
    for (let i = 0; i < 5; i++) state = nextFreshness(state, false, NOW);
    const changed = nextFreshness(state, true, NOW);
    expect(changed.unchangedStreak).toBe(0);
    expect(changed.changeCount).toBe(4);
    expect(changed.recrawlDue).toBe(NOW + DAY);
  });

  it('lastChangedAt is preserved across unchanged recrawls', () => {
    let state = nextFreshness(undefined, true, NOW - 40 * DAY);
    const before = NOW - DAY;
    state = nextFreshness(state, false, before);
    expect(state.lastChangedAt).toBe(NOW - 40 * DAY);
  });
});
