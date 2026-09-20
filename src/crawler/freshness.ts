/**
 * Freshness scheduling — how often a URL deserves a recrawl.
 *
 * v1 never recrawled: once a page was fetched, `isFetched()` blocked it
 * forever and the device's corner of the index silently went stale. v2 keeps
 * an index, not a snapshot: every successfully crawled URL is re-enqueued
 * with a `recrawlDue` timestamp, and the interval adapts to observed change
 * behavior:
 *
 *   - first crawl            → recrawl in 24h
 *   - recrawl, content changed   → back to 24h (the page is alive)
 *   - recrawl, content unchanged → interval doubles (2d, 4d, 8d … max 30d)
 *
 * Breaking-news pages converge toward daily recrawls; static pages drift
 * toward monthly. The content hash (sha256 of extracted text) is the change
 * detector — cheap, deterministic, and the same signal the network uses.
 *
 * Republishing on recrawl is deliberate: with the same `d`/`x` and a fresh
 * `created_at`, the addressable kind 39697 event says "still alive, same
 * content" — the network's freshness signal. Relays keep one slot per
 * (pubkey, d), so this costs the network nothing but a replace.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_INTERVAL = 30 * DAY;

export interface FreshnessState {
  changeCount?: number;
  unchangedStreak?: number;
  lastChangedAt?: number;
}

export interface FreshnessUpdate {
  /** Unix ms — when this URL becomes eligible for recrawl. */
  recrawlDue: number;
  changeCount: number;
  unchangedStreak: number;
  lastChangedAt: number;
}

/**
 * Compute the next freshness state after a successful crawl.
 *
 * @param existing  previous freshness state (undefined = first crawl —
 *                  always treated as a change, so the first recrawl lands
 *                  at +24h)
 * @param changed   whether the content hash differs from last time
 * @param now       unix ms
 */
export function nextFreshness(
  existing: FreshnessState | undefined,
  changed: boolean,
  now: number,
): FreshnessUpdate {
  const prevStreak = existing?.unchangedStreak ?? 0;
  const prevChanges = existing?.changeCount ?? 0;

  if (changed) {
    return {
      recrawlDue: now + DAY,
      changeCount: prevChanges + 1,
      unchangedStreak: 0,
      lastChangedAt: now,
    };
  }

  const streak = prevStreak + 1;
  const interval = Math.min(MAX_INTERVAL, DAY * 2 ** streak);
  return {
    recrawlDue: now + interval,
    changeCount: prevChanges,
    unchangedStreak: streak,
    lastChangedAt: existing?.lastChangedAt ?? now,
  };
}

/** Upper bound on the recrawl interval (30 days). */
export const MAX_RECRAWL_INTERVAL_MS = MAX_INTERVAL;
