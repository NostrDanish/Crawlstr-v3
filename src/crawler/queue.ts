// IndexedDB-backed crawl queue + observation outbox
//
// v3 adds an `outbox` store holding signed kind 39697 events that could not
// be published (zero relay accepts). Local-first rule: crawl progress is
// never lost because the network is down — events flush on reconnect and on
// a timer (pattern ported from indexstr's queue.ts).
//
// v4 (Crawlstr v2) extends `crawled` records:
//   - status gains 'failed' — a NEGATIVE cache entry for permanent failures
//     (4xx, non-HTML, oversize, SSRF refusal). Failed URLs are not retried
//     for NEGATIVE_CACHE_TTL_MS; the maintenance sweep deletes expired
//     entries so a future discovery can try again.
//   - freshness bookkeeping (freshness.ts): recrawlDue, changeCount,
//     unchangedStreak, lastChangedAt — the adaptive recrawl schedule.
// No new indexes: scout-scale stores (tens of thousands of records) scan
// fine, and avoiding index migrations keeps v1→v2 storage compatible.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NostrEvent } from '@nostrify/nostrify';
import type { CrawlJob } from './types';
import type { FreshnessUpdate } from './freshness';

/** Upper bound for held observations. On overflow the OLDEST entry is
 *  dropped (newest wins): fresh observations are more valuable to the
 *  index than stale ones, and a re-crawl can always reproduce the old. */
export const OUTBOX_MAX = 5000;

/** A permanent failure is not retried for 7 days. */
export const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 3_600_000;

/** Upper bound for the crawled store — oldest records evicted beyond this. */
export const CRAWLED_STORE_MAX = 50_000;

/** Crawl-job status. */
export type CrawledStatus = 'fetched' | 'observed' | 'failed';

export interface CrawledRecord {
  url: string;
  contentHash: string;
  title: string;
  crawledAt: number;
  /**
   * 'fetched' — we downloaded and parsed the page.
   * 'observed' — we only saw it referenced (RSS/Atom feed, sitemap) and
   *   published an observation, but never fetched the page itself.
   * 'failed'   — permanent failure (4xx, non-HTML, oversize, robots, SSRF).
   *   Negative-cache entry: blocks re-fetches until NEGATIVE_CACHE_TTL_MS
   *   expires, then the maintenance sweep deletes it.
   *
   * observed ≠ fetched: a feed can announce a page that 404s when actually
   * fetched, so feed-derived entries must not block a future real fetch.
   */
  status: CrawledStatus;
  /** When the content hash last CHANGED (unix ms). */
  lastChangedAt?: number;
  /** How often recrawls found changed content. */
  changeCount?: number;
  /** Consecutive recrawls with unchanged content. */
  unchangedStreak?: number;
  /** Unix ms — when this URL becomes eligible for recrawl. */
  recrawlDue?: number;
  /** Unix ms — when the permanent failure was recorded. */
  failedAt?: number;
}

interface CrawlerDB extends DBSchema {
  queue: {
    key: string;
    value: CrawlJob;
    indexes: { 'by-priority': number };
  };
  crawled: {
    key: string;
    value: CrawledRecord;
    indexes: { 'by-hash': string };
  };
  outbox: {
    key: number;
    value: {
      event: NostrEvent;
      queuedAt: number;
    };
  };
}

let db: IDBPDatabase<CrawlerDB> | null = null;

export async function initDB(): Promise<IDBPDatabase<CrawlerDB>> {
  if (db) return db;

  db = await openDB<CrawlerDB>('searchstr-crawler', 4, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const queueStore = database.createObjectStore('queue', { keyPath: 'url' });
        queueStore.createIndex('by-priority', 'priority');

        const crawledStore = database.createObjectStore('crawled', { keyPath: 'url' });
        crawledStore.createIndex('by-hash', 'contentHash');
      }
      // v2: crawled records gain a status field. Existing records predate the
      // field — treat them as 'fetched' (they were, by definition, at the time).
      if (oldVersion < 2) {
        // No schema change needed — 'status' is a plain property, and the
        // 'by-hash' index is unchanged. Backfill happens lazily in code.
      }
      // v3: the observation outbox — signed events that got zero relay
      // accepts wait here for connectivity instead of being lost.
      if (oldVersion < 3) {
        if (!database.objectStoreNames.contains('outbox')) {
          database.createObjectStore('outbox', { autoIncrement: true });
        }
      }
      // v4 (Crawlstr v2): 'failed' status + freshness fields on crawled
      // records. Both are plain properties — no index changes, so existing
      // databases upgrade without a data migration. Backfill is lazy:
      // records without `status` read as 'fetched' (see getCrawled).
      if (oldVersion < 4) {
        // Intentionally empty — documented above.
      }
    },
  });

  return db;
}

export async function addToQueue(job: CrawlJob): Promise<void> {
  const database = await initDB();
  await database.put('queue', job);
}

export async function getNextJob(): Promise<CrawlJob | null> {
  const database = await initDB();
  const tx = database.transaction('queue', 'readonly');
  const index = tx.store.index('by-priority');

  // Walk highest→lowest priority and return the first job that is READY.
  // The previous version looked at only the single top job and returned null
  // when it was delayed — starving ready jobs below it in the queue.
  const now = Date.now();
  let cursor = await index.openCursor(null, 'prev');
  while (cursor) {
    const job = cursor.value;
    if (!job.nextAttempt || job.nextAttempt <= now) {
      return job;
    }
    cursor = await cursor.continue();
  }

  return null;
}

/**
 * Atomically claim the next ready job: the readwrite transaction deletes it
 * from the queue in the same step that reads it, so two parallel slot
 * runners can never claim the same job (v2 multi-slot loop requirement).
 */
export async function claimNextJob(): Promise<CrawlJob | null> {
  const database = await initDB();
  const tx = database.transaction('queue', 'readwrite');
  const index = tx.store.index('by-priority');

  const now = Date.now();
  let cursor = await index.openCursor(null, 'prev');
  while (cursor) {
    const job = cursor.value;
    if (!job.nextAttempt || job.nextAttempt <= now) {
      await cursor.delete();
      await tx.done;
      return job;
    }
    cursor = await cursor.continue();
  }

  await tx.done;
  return null;
}

/** True when `url` currently has a queue entry. */
export async function isQueued(url: string): Promise<boolean> {
  const database = await initDB();
  return (await database.getKey('queue', url)) !== undefined;
}

export async function removeFromQueue(url: string): Promise<void> {
  const database = await initDB();
  await database.delete('queue', url);
}

export async function getQueueSize(): Promise<number> {
  const database = await initDB();
  return database.count('queue');
}

export async function getCrawled(url: string): Promise<CrawledRecord | undefined> {
  const database = await initDB();
  const record = await database.get('crawled', url);
  // Backfill the v2 status field for records written before it existed.
  if (record && !record.status) {
    return { ...record, status: 'fetched' as const };
  }
  return record;
}

/**
 * True only when we ACTUALLY fetched and parsed the page. Feed/sitemap
 * observations don't count — the observed-vs-fetched fix: a feed announcing
 * a page must not permanently block a future real fetch of it.
 */
export async function isFetched(url: string): Promise<boolean> {
  const record = await getCrawled(url);
  return record?.status === 'fetched';
}

/**
 * True when a permanent-failure entry is still inside its negative-cache
 * TTL — the URL must not be re-fetched (or re-queued) until it expires.
 */
export async function isFailureCached(url: string, now = Date.now()): Promise<boolean> {
  const record = await getCrawled(url);
  if (record?.status !== 'failed') return false;
  if (!record.failedAt) return false; // legacy failed record without a stamp — treat as cached
  return now - record.failedAt < NEGATIVE_CACHE_TTL_MS;
}

export async function markCrawled(
  url: string,
  contentHash: string,
  title: string,
  status: 'fetched' | 'observed' = 'fetched',
  freshness?: FreshnessUpdate,
): Promise<void> {
  const database = await initDB();
  await database.put('crawled', {
    url,
    contentHash,
    title,
    crawledAt: Date.now(),
    status,
    ...(freshness
      ? {
          lastChangedAt: freshness.lastChangedAt,
          changeCount: freshness.changeCount,
          unchangedStreak: freshness.unchangedStreak,
          recrawlDue: freshness.recrawlDue,
        }
      : {}),
  });
}

/** Record a permanent failure (negative cache). */
export async function markFailed(url: string, title = ''): Promise<void> {
  const database = await initDB();
  await database.put('crawled', {
    url,
    contentHash: '',
    title,
    crawledAt: Date.now(),
    status: 'failed',
    failedAt: Date.now(),
  });
}

/**
 * URLs whose adaptive recrawl has come due (freshness.ts). `exclude` holds
 * URLs already claimed by a running slot or re-queued for fetch, so a due
 * recrawl never doubles up with a pending queue job. Records written before
 * v2 have no `recrawlDue` — they fall back to `crawledAt + 24h` so the
 * post-upgrade recrawl wave is staggered by last-crawl time.
 */
export async function getDueRecrawlUrls(
  limit: number,
  exclude: ReadonlySet<string>,
  now = Date.now(),
): Promise<string[]> {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readonly');
  const all = await tx.store.getAll();

  const DAY_MS = 24 * 3_600_000;
  return all
    .filter((r) => {
      // Records written before v2 have no status field — they were fetched.
      const status = r.status ?? 'fetched';
      if (status !== 'fetched' || exclude.has(r.url)) return false;
      const dueAt = r.recrawlDue !== undefined ? r.recrawlDue : r.crawledAt + DAY_MS;
      return dueAt <= now;
    })
    .sort((a, b) => {
      const aDue = a.recrawlDue !== undefined ? a.recrawlDue : a.crawledAt + DAY_MS;
      const bDue = b.recrawlDue !== undefined ? b.recrawlDue : b.crawledAt + DAY_MS;
      return aDue - bDue;
    })
    .slice(0, limit)
    .map((r) => r.url);
}

export async function findByHash(hash: string): Promise<string | null> {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readonly');
  const index = tx.store.index('by-hash');
  const result = await index.get(hash);
  return result?.url ?? null;
}

export async function getCrawledCount(): Promise<number> {
  const database = await initDB();
  return database.count('crawled');
}

export async function getRecentCrawled(limit = 20): Promise<CrawledRecord[]> {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readonly');
  const all = await tx.store.getAll();
  return all
    .map((r) => (r.status ? r : { ...r, status: 'fetched' as const }))
    .sort((a, b) => b.crawledAt - a.crawledAt)
    .slice(0, limit);
}

export async function clearQueue(): Promise<void> {
  const database = await initDB();
  await database.clear('queue');
}

/**
 * Storage maintenance (runs at start and hourly while crawling):
 *   1. expired negative-cache entries ('failed' older than the TTL) are
 *      deleted — a future discovery may then try the URL again;
 *   2. the crawled store is capped at CRAWLED_STORE_MAX, evicting the oldest
 *      records first (evicting a 'fetched' record only means the URL becomes
 *      discoverable again — a future crawl reproduces it).
 */
export async function maintenanceSweep(
  now = Date.now(),
): Promise<{ failedExpired: number; evicted: number }> {
  const database = await initDB();
  const tx = database.transaction('crawled', 'readwrite');
  const all = await tx.store.getAll();

  let failedExpired = 0;
  const survivors: CrawledRecord[] = [];
  for (const record of all) {
    if (
      record.status === 'failed' &&
      record.failedAt &&
      now - record.failedAt >= NEGATIVE_CACHE_TTL_MS
    ) {
      await tx.store.delete(record.url);
      failedExpired++;
    } else {
      survivors.push(record);
    }
  }

  let evicted = 0;
  if (survivors.length > CRAWLED_STORE_MAX) {
    survivors.sort((a, b) => a.crawledAt - b.crawledAt); // oldest first
    for (const record of survivors.slice(0, survivors.length - CRAWLED_STORE_MAX)) {
      await tx.store.delete(record.url);
      evicted++;
    }
  }

  await tx.done;
  return { failedExpired, evicted };
}

/* ------------------------------------------------------------------------ */
/* Observation outbox (offline-first publishing)                             */
/* ------------------------------------------------------------------------ */

/** Hold a signed observation until relays are reachable again. */
export async function enqueueOutbox(event: NostrEvent): Promise<void> {
  const database = await initDB();
  const count = await database.count('outbox');
  if (count >= OUTBOX_MAX) {
    // Newest-wins: drop the oldest held observation (auto-increment keys
    // mean the first cursor entry is the oldest).
    const tx = database.transaction('outbox', 'readwrite');
    const oldest = await tx.store.openCursor();
    if (oldest) await oldest.delete();
    await tx.done;
  }
  await database.add('outbox', { event, queuedAt: Date.now() });
}

/** Number of observations waiting for relay connectivity. */
export async function getOutboxSize(): Promise<number> {
  const database = await initDB();
  return database.count('outbox');
}

/**
 * Drain the outbox through `publish`. Stops at the first failure so a dead
 * network doesn't burn retries; entries are removed only after success.
 * Returns how many were published.
 */
export async function flushOutbox(
  publish: (event: NostrEvent) => Promise<boolean>,
): Promise<number> {
  const database = await initDB();
  let published = 0;

  for (;;) {
    const tx = database.transaction('outbox', 'readonly');
    const cursor = await tx.store.openCursor();
    if (!cursor) break;
    const key = cursor.primaryKey;
    const { event } = cursor.value;

    const ok = await publish(event);
    if (!ok) break;

    await database.delete('outbox', key);
    published++;
  }

  return published;
}
