// IndexedDB is not part of jsdom — fake-indexeddb provides a real
// implementation so the engine's queue admission runs against real code.
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach } from 'vitest';
import { CrawlerEngine } from './engine';
import { getQueueSize, initDB, clearQueue } from './queue';
import { DEFAULT_SETTINGS } from './types';

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
