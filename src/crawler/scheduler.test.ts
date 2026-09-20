import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler } from './scheduler';

describe('scheduler politeness invariants', () => {
  let now: number;
  let scheduler: Scheduler;

  beforeEach(() => {
    now = 1_000_000;
    scheduler = new Scheduler({
      minIntervalPerDomainMs: 5000,
      maxCrawlDelayMs: 60_000,
      parallelism: 2,
      clock: () => now,
    });
  });

  it('allows the first request to a domain', () => {
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
  });

  it('invariant (i): at most one in-flight request per domain', () => {
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
    expect(scheduler.tryAcquire('https://a.example/other')).toBe(false);
    // A different domain is fine (slot count permitting).
    expect(scheduler.tryAcquire('https://b.example/')).toBe(true);
    // Slots exhausted (2).
    expect(scheduler.tryAcquire('https://c.example/')).toBe(false);
  });

  it('invariant (ii): interval enforced from request completion', () => {
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
    scheduler.release('https://a.example/');

    now += 4999;
    expect(scheduler.tryAcquire('https://a.example/')).toBe(false);

    now += 2; // 5001 total
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
  });

  it('cancel releases the slot without noting a request', () => {
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
    scheduler.cancel('https://a.example/');
    // Slot freed, domain not penalized.
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
  });

  it('release frees the slot for another domain', () => {
    expect(scheduler.tryAcquire('https://a.example/')).toBe(true);
    expect(scheduler.tryAcquire('https://b.example/')).toBe(true);
    scheduler.release('https://a.example/');
    expect(scheduler.tryAcquire('https://c.example/')).toBe(true);
  });

  it('auxiliary requests (robots/feeds) count toward the interval via noteRequest', () => {
    scheduler.noteRequest('https://a.example/robots.txt');
    expect(scheduler.timeUntilNextRequest('https://a.example/')).toBe(5000);
    expect(scheduler.tryAcquire('https://a.example/')).toBe(false);
  });

  it('robots crawl-delay is honored up to the cap', () => {
    scheduler.noteRequest('https://a.example/');
    // 30s crawl-delay (>5s default) applies.
    expect(scheduler.timeUntilNextRequest('https://a.example/', 30_000)).toBe(30_000);
    // 10-minute crawl-delay is capped at 60s.
    expect(scheduler.timeUntilNextRequest('https://a.example/', 600_000)).toBe(60_000);
  });

  it('timeUntilNextRequest reports 0 when ready', () => {
    expect(scheduler.timeUntilNextRequest('https://fresh.example/')).toBe(0);
  });

  it('clamps parallelism to 1..8', () => {
    expect(new Scheduler({ minIntervalPerDomainMs: 1000, parallelism: 0 }).slotCount).toBe(1);
    expect(new Scheduler({ minIntervalPerDomainMs: 1000, parallelism: 99 }).slotCount).toBe(8);
  });
});
