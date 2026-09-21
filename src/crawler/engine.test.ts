// IndexedDB is not part of jsdom — fake-indexeddb provides a real
// implementation so the engine's queue admission runs against real code.
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CrawlerEngine } from './engine';
import { getQueueSize, initDB, clearQueue } from './queue';
import { setRelayPublisher } from './publisher';
import { recordFetch, resetMeter } from './meter';
import { DEFAULT_SETTINGS } from './types';
import { warmRobots } from './robots';

/**
 * Robots module mock: the robots.txt fetch itself is network I/O — the
 * dispatch tests only need its CONTRACT (cached or not / warm / peek), not
 * real traffic. shouldCrawlUrl and everything else stays real. The warmed
 * flag flips when the engine runs the warm-up, so hasCachedRules mirrors
 * what a real cache would report.
 */
const robotsWarmState = vi.hoisted(() => ({ warmed: false }));
vi.mock('./robots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./robots')>();
  return {
    ...actual,
    hasCachedRules: vi.fn(() => robotsWarmState.warmed),
    warmRobots: vi.fn(async () => {
      robotsWarmState.warmed = true;
    }),
    peekCrawlDelay: vi.fn(() => 0),
  };
});

/**
 * Engine-level guards: the queue-admission SSRF gate (audit finding #1) and
 * the settings surface honesty (audit finding #4 — dead maxConcurrent knob
 * removed; the loop is serial by design).
 */

describe('engine queue admission (audit finding #1)', () => {
  beforeEach(async () => {
    await initDB();
    await clearQueue();
  });

  it('refuses non-public seed URLs — they never enter the queue', async () => {
    const engine = new CrawlerEngine();
    await engine.init();

    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://127.0.0.1/admin',
      'http://192.168.1.1/',
      'http://localhost:3000/x',
    ]) {
      await engine.seedUrl(url);
    }

    expect(await getQueueSize()).toBe(0);
    expect(engine.getCurrentSeed()).toBeNull();
    expect(engine.getStats().queueSize).toBe(0);
  });

  it('accepts a normal public seed URL', async () => {
    const engine = new CrawlerEngine();
    await engine.init();

    await engine.seedUrl('https://engine-test-example.com/');
    expect(await getQueueSize()).toBe(1);
    expect(engine.getCurrentSeed()).toBe('https://engine-test-example.com/');
  });

  it('drops a non-public job already in the queue instead of fetching it', async () => {
    // Simulates a queue entry written before the admission gate existed.
    const db = await initDB();
    await db.put('queue', {
      url: 'http://10.0.0.9/internal',
      priority: 1,
      depth: 0,
      attempts: 0,
    });
    expect(await getQueueSize()).toBe(1);

    const engine = new CrawlerEngine({ respectRobots: false });
    await engine.init();

    // Drive crawlUrl directly (private method; structural cast) — the
    // belt-and-braces guard must remove the job without any fetch.
    const crawlUrl = (engine as unknown as {
      crawlUrl(job: { url: string; priority: number; depth: number; attempts: number }): Promise<void>;
    }).crawlUrl.bind(engine);
    await crawlUrl({ url: 'http://10.0.0.9/internal', priority: 1, depth: 0, attempts: 0 });

    expect(await getQueueSize()).toBe(0);
    expect(engine.getStats().skipped).toBe(1);
  });
});

describe('settings honesty (audit finding #4)', () => {
  it('exposes no maxConcurrent knob — the crawl loop is serial by design', () => {
    expect('maxConcurrent' in DEFAULT_SETTINGS).toBe(false);

    const engine = new CrawlerEngine();
    const settings = engine.getSettings();
    expect('maxConcurrent' in settings).toBe(false);
  });

  it('updateSettings round-trips real knobs', () => {
    const engine = new CrawlerEngine();
    engine.updateSettings({ maxDepth: 5, ecoMode: false });
    const settings = engine.getSettings();
    expect(settings.maxDepth).toBe(5);
    expect(settings.ecoMode).toBe(false);
  });
});

/**
 * Regression: the v2.0.0 waitForWake TDZ bug. `const timer = setTimeout(cleanup,
 * …)` evaluated the cleanup binding before its declaration, throwing
 * "Cannot access 'cleanup' before initialization" on EVERY empty-queue
 * iteration — the slot loop crashed in a 10s crash/sleep cycle instead of
 * idling, and the crawl never progressed.
 */
describe('waitForWake (regression: TDZ crash on empty queue)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function waitForWake(engine: CrawlerEngine, ms: number): Promise<void> {
    return (
      engine as unknown as { waitForWake(timeoutMs: number): Promise<void> }
    ).waitForWake(ms);
  }

  it('resolves cleanly when the timeout fires (no ReferenceError)', async () => {
    const engine = new CrawlerEngine();
    const pending = waitForWake(engine, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves early when wake() is called', async () => {
    const engine = new CrawlerEngine();
    const pending = waitForWake(engine, 60_000);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    (engine as unknown as { wake(): void }).wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('resolves immediately when the abort controller has fired', async () => {
    const engine = new CrawlerEngine();
    const ac = new AbortController();
    (engine as unknown as { abortController: AbortController | null }).abortController = ac;
    ac.abort();
    const pending = (
      engine as unknown as { waitForWake(ms: number, ac: AbortController): Promise<void> }
    ).waitForWake(60_000, ac);
    await expect(pending).resolves.toBeUndefined();
  });
});

/**
 * Regression: the v3.0.0 zero-throughput bug. The slot loop called
 * scheduler.noteRequest(job.url) BEFORE scheduler.tryAcquire(job.url) —
 * stamping the domain as "just requested" made every acquire fail, the job
 * was re-queued with a fresh nextAttempt, and the next attempt re-stamped
 * the domain again. Infinite self-deferral: the queue stayed full forever
 * while zero pages were ever fetched (40 min uptime, 0 indexed, 0 bytes).
 *
 * The fix: robots.txt warm-up is a SCHEDULED request on the domain lane
 * (acquire → warm → release, which notes completion), and the page
 * dispatch is a pure tryAcquire — nothing notes a request before one
 * actually happens.
 */
describe('dispatch regression: zero-throughput self-deferral (v3.0.0)', () => {
  beforeEach(async () => {
    await initDB();
    await clearQueue();
    robotsWarmState.warmed = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyOnCrawlUrl() {
    return vi
      .spyOn(
        CrawlerEngine.prototype as unknown as {
          crawlUrl(job: unknown): Promise<void>;
        },
        'crawlUrl',
      )
      .mockResolvedValue(undefined);
  }

  /** Poll the real event loop until `cond` holds (or `ms` elapses). */
  async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('a queued job reaches crawlUrl (robots off)', async () => {
    setRelayPublisher(async () => {});
    const crawlSpy = spyOnCrawlUrl();

    const engine = new CrawlerEngine({ respectRobots: false });
    await engine.init();
    await engine.seedUrl('https://dispatch-regression.example.com/');
    expect(await getQueueSize()).toBe(1);

    await engine.start();
    await waitFor(() => crawlSpy.mock.calls.length > 0);

    // Broken code: never called — the job deferred itself forever.
    expect(crawlSpy).toHaveBeenCalled();
    await engine.stop();
  });

  it('robots warm-up runs on the lane, then the page proceeds (robots on)', async () => {
    setRelayPublisher(async () => {});
    const crawlSpy = spyOnCrawlUrl();

    // ecoMode off → 5s politeness interval: the robots release stamps the
    // lane, so the page job must wait exactly one interval before its
    // acquire succeeds. That's the invariant this test pays 5s to prove.
    const engine = new CrawlerEngine({ respectRobots: true, ecoMode: false });
    await engine.init();
    await engine.seedUrl('https://dispatch-regression-robots.example.com/');

    await engine.start();
    // The warm-up is a scheduled lane request and runs FIRST.
    await waitFor(() => vi.mocked(warmRobots).mock.calls.length > 0);
    expect(warmRobots).toHaveBeenCalled();
    // …then the page job proceeds after the politeness interval.
    await waitFor(() => crawlSpy.mock.calls.length > 0, 25_000);
    expect(crawlSpy).toHaveBeenCalled();
    await engine.stop();
  }, 30_000);
});

/**
 * Bandwidth cap — unlimited mode (maxBandwidthMB 0 = cap fully off).
 * NOTE: this block runs LAST in the file on purpose — it records 500 MB
 * into the module-level meter, and the meter's sliding window would poison
 * canCrawl() for any later bandwidth-sensitive test in this file.
 */
describe('bandwidth cap: unlimited mode (0 = off)', () => {
  beforeEach(async () => {
    await initDB();
    await clearQueue();
    resetMeter();
  });

  function canCrawl(engine: CrawlerEngine): Promise<boolean> {
    return (engine as unknown as { canCrawl(): Promise<boolean> }).canCrawl();
  }

  it('canCrawl blocks when the hourly budget is blown', async () => {
    const engine = new CrawlerEngine({ maxBandwidthMB: 1 });
    await engine.init();
    recordFetch(500 * 1024 * 1024); // 500 MB this hour — far over a 1 MB cap
    await expect(canCrawl(engine)).resolves.toBe(false);
  });

  it('canCrawl ignores the budget entirely when the cap is 0 (off)', async () => {
    const engine = new CrawlerEngine({ maxBandwidthMB: 0 });
    await engine.init();
    recordFetch(500 * 1024 * 1024);
    await expect(canCrawl(engine)).resolves.toBe(true);
  });
});
