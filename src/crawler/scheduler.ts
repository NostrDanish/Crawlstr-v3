/**
 * scheduler.ts — per-domain politeness + fetch-slot allocation (v2).
 *
 * v1 ran one serial loop with fixed sleeps and a best-effort canMakeRequest
 * check it re-implemented in three places. v2 centralizes pacing here and
 * runs N parallel slot runners over this allocator:
 *
 *   - tryAcquire(url) is one synchronous check+set step on the main event
 *     loop, so per-domain seriality holds even with N slots (no
 *     check-then-set race — the hazard both v1 limits.ts files warned about).
 *   - Politeness invariants (asserted in tests):
 *       (i)   ≤1 concurrent request per domain, always;
 *       (ii)  ≥ minInterval (or robots crawl-delay, capped) between
 *             requests to one domain — robots/feed/sitemap fetches count
 *             too (the engine notes them via noteRequest);
 *       (iii) global budgets are enforced by the meter, not here;
 *       (iv)  more slots only increase domain-diversity utilization,
 *             never per-site rate.
 *   - When all slots are politeness-blocked the engine sleeps until the
 *     earliest unblock time (timeUntilNextRequest), never busy-polls.
 *
 * Crawlstr is a scout, not a bulk indexer: the slot count is deliberately
 * small (2). Eco mode raises the per-domain interval.
 */

export interface SchedulerConfig {
  /** Default ms between requests to one domain (5000; 8000 eco). */
  minIntervalPerDomainMs: number;
  /** Cap on robots.txt crawl-delay (default 60_000). */
  maxCrawlDelayMs?: number;
  /** Fetch slots (max 8). Default 2 — scout-scale parallelism. */
  parallelism?: number;
  clock?: () => number;
}

/** Hard cap on in-memory per-domain state (sweep beyond this). */
const MAX_DOMAIN_ENTRIES = 5000;

export class Scheduler {
  private readonly minInterval: number;
  private readonly maxCrawlDelay: number;
  private readonly clock: () => number;
  private readonly slots: number;
  private readonly domainLastRequest = new Map<string, number>();
  private readonly inFlightDomains = new Set<string>();
  private inFlight = 0;

  constructor(config: SchedulerConfig) {
    this.minInterval = config.minIntervalPerDomainMs;
    this.maxCrawlDelay = config.maxCrawlDelayMs ?? 60_000;
    this.clock = config.clock ?? Date.now;
    this.slots = Math.max(1, Math.min(8, config.parallelism ?? 2));
  }

  /** Configured slot count. */
  get slotCount(): number {
    return this.slots;
  }

  /** Effective interval for a domain: max(configured, robots crawl-delay capped). */
  intervalFor(crawlDelayMs?: number): number {
    return Math.max(this.minInterval, Math.min(crawlDelayMs ?? 0, this.maxCrawlDelay));
  }

  /**
   * Try to acquire a fetch slot for `url` (synchronous check+set).
   * Returns true when the request may start NOW; the caller MUST pair every
   * successful acquire with exactly one release(url).
   */
  tryAcquire(url: string, crawlDelayMs?: number): boolean {
    if (this.inFlight >= this.slots) return false;
    const domain = this.domainOf(url);
    if (this.inFlightDomains.has(domain)) return false; // invariant (i)
    const last = this.domainLastRequest.get(domain) ?? 0;
    if (this.clock() - last < this.intervalFor(crawlDelayMs)) return false; // (ii)

    this.inFlight++;
    this.inFlightDomains.add(domain);
    return true;
  }

  /** Record an auxiliary request to `url`'s domain (robots/feed/sitemap).
   *  Discovery traffic is same-origin load and counts toward politeness. */
  noteRequest(url: string): void {
    const domain = this.domainOf(url);
    this.domainLastRequest.set(domain, this.clock());
    if (this.domainLastRequest.size > MAX_DOMAIN_ENTRIES) {
      const entries = [...this.domainLastRequest.entries()].sort((a, b) => a[1] - b[1]);
      for (const [d] of entries.slice(0, Math.floor(entries.length / 2))) {
        this.domainLastRequest.delete(d);
      }
    }
  }

  /** Release a slot acquired via tryAcquire. Notes request COMPLETION —
   *  the per-domain interval restarts from here. */
  release(url: string): void {
    const domain = this.domainOf(url);
    if (this.inFlightDomains.delete(domain)) this.inFlight--;
    this.noteRequest(url);
  }

  /** Release a slot WITHOUT noting a request — the dispatch was aborted
   *  before any request was made. */
  cancel(url: string): void {
    const domain = this.domainOf(url);
    if (this.inFlightDomains.delete(domain)) this.inFlight--;
  }

  /** Ms until a request to `url` would be allowed (0 = now). */
  timeUntilNextRequest(url: string, crawlDelayMs?: number): number {
    const domain = this.domainOf(url);
    const last = this.domainLastRequest.get(domain) ?? 0;
    const elapsed = this.clock() - last;
    return Math.max(0, this.intervalFor(crawlDelayMs) - elapsed);
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** Test hook: clear all state. */
  reset(): void {
    this.domainLastRequest.clear();
    this.inFlightDomains.clear();
    this.inFlight = 0;
  }
}
